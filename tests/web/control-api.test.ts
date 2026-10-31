/**
 * T5b 网页控制面：四条路由的鉴权/CSRF/方法/请求体闸门，以及投影与通道绑定。
 *
 * 全部用真实 HTTP 服务器 + 真实 `ApprovalService`；只有状态快照与 router 是
 * 替身（它们各自有独立测试）。决策永远 POST：GET 路径必须 405。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalService } from '../../src/approvals/service.js';
import type { ApprovalRecord } from '../../src/approvals/types.js';
import type { ControlRouter } from '../../src/control/router.js';
import type { ControlStatusSnapshot } from '../../src/control/status.js';
import type { ControlReply } from '../../src/control/types.js';
import { createControlApi, toApprovalView, type ApprovalView } from '../../src/web/control-api.js';
import { createWebServer, type WebServer } from '../../src/web/server.js';

const STRONG_TOKEN = '0123456789abcdef0123456789abcdef';

const dirs: string[] = [];
const servers: WebServer[] = [];
const services: ApprovalService[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const service of services.splice(0)) await service.stop();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'uuharness-control-api-'));
  dirs.push(dir);
  return dir;
}

function statusStub(overrides: Partial<ControlStatusSnapshot> = {}): ControlStatusSnapshot {
  return {
    quiet: { until: null, active: false },
    groups: [],
    observing: [],
    approvals: { pending: 0, oldestPendingAt: null },
    channels: [],
    plugins: [],
    capabilities: [],
    heartbeat: { silentRounds: 0, inFlight: false, nextFastMs: 1000 },
    queueSize: 0,
    endpoints: [],
    ...overrides,
  };
}

interface RouterStub {
  router: ControlRouter;
  handleOwnerText: ReturnType<typeof vi.fn<(text: string, origin: unknown) => Promise<ControlReply>>>;
}

function routerStub(reply: ControlReply = { text: '已全局静默 30 分钟。', handled: true }): RouterStub {
  const handleOwnerText = vi.fn(async () => reply);
  return {
    handleOwnerText,
    router: {
      handleOwnerText,
      executeApproved: async () => ({ ok: true }),
    } as unknown as ControlRouter,
  };
}

interface Started {
  base: string;
  cookie: string;
  service: ApprovalService;
  router: ControlRouter;
  server: WebServer;
  handleOwnerText: RouterStub['handleOwnerText'];
}

interface StartOptions {
  status?: () => ControlStatusSnapshot;
  router?: ControlRouter;
  /** 让 router 为空，模拟控制面未接线。 */
  noRouter?: boolean;
  /** `QQ_CONTROL_ENABLED=0`：整个控制面关闭，四条路由都必须拒绝。 */
  disabled?: boolean;
}

async function start(options: StartOptions = {}): Promise<Started> {
  const dir = await tempDir();
  const service = new ApprovalService({
    dataDir: dir,
    log: () => {},
    scanIntervalMs: 0,
    executionTimeoutMs: 1000,
    hooks: { activateCapability: async () => ({ ok: true }) },
  });
  services.push(service);
  await service.load();

  const stub = routerStub();
  const router = options.router ?? stub.router;
  const status = options.status ?? (() => statusStub());
  const api = createControlApi({
    approvals: service,
    status,
    router: options.noRouter === true ? () => null : () => router,
    enabled: options.disabled !== true,
    log: () => {},
  });

  const server = createWebServer({
    host: '127.0.0.1',
    port: 0,
    token: STRONG_TOKEN,
    log: () => {},
    routeHandlers: api.handlers,
  });
  servers.push(server);
  await server.start();
  const base = `http://127.0.0.1:${server.port()}`;
  const cookie = await loginCookie(base);
  return { base, cookie, service, router, server, handleOwnerText: stub.handleOwnerText };
}

async function loginCookie(base: string): Promise<string> {
  const response = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-uuharness-console': '1',
      origin: new URL(base).origin,
    },
    body: JSON.stringify({ token: STRONG_TOKEN }),
  });
  expect(response.status).toBe(200);
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const raw = headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie') ?? '';
  return raw.split(';')[0] ?? '';
}

function get(base: string, path: string, cookie?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    headers: cookie === undefined ? {} : { cookie },
  });
}

function post(
  base: string,
  path: string,
  cookie: string | undefined,
  body: unknown,
  options: { csrf?: boolean; origin?: boolean; contentType?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': options.contentType ?? 'application/json',
  };
  if (options.csrf !== false) headers['x-uuharness-console'] = '1';
  if (options.origin !== false) headers.origin = new URL(base).origin;
  if (cookie !== undefined) headers.cookie = cookie;
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function bodyOf<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function proposeCapability(
  service: ApprovalService,
  overrides: { plugin?: string; version?: string; permissions?: string[]; tools?: string[] } = {},
): Promise<ApprovalRecord> {
  const result = await service.propose(
    {
      kind: 'capability.activate',
      plugin: overrides.plugin ?? 'echo',
      version: overrides.version ?? '0.1.0',
      fingerprint: 'a'.repeat(64),
      declaredPermissions: overrides.permissions ?? ['fs:read'],
      toolNames: overrides.tools ?? ['echo'],
    },
    { createdVia: 'system', createdBy: 'startup' },
  );
  if (!result.ok) throw new Error(`proposal failed: ${result.code}`);
  return result.record;
}

async function proposeControl(service: ApprovalService): Promise<ApprovalRecord> {
  const result = await service.propose(
    {
      kind: 'control.command',
      intent: 'group.silence',
      args: { group: '123', minutes: 30 },
    },
    { createdVia: 'qq', createdBy: 'private:300' },
  );
  if (!result.ok) throw new Error(`proposal failed: ${result.code}`);
  return result.record;
}

interface ApprovalsBody {
  ok: boolean;
  code?: string;
  records?: ApprovalView[];
  pending?: number;
  record?: ApprovalView;
}

describe('route gates', () => {
  it('requires a session on every route', async () => {
    const { base } = await start();
    expect((await get(base, '/api/approvals')).status).toBe(401);
    expect((await get(base, '/api/control')).status).toBe(401);
    expect((await post(base, '/api/approvals/decide', undefined, {})).status).toBe(401);
    expect((await post(base, '/api/control/command', undefined, { text: '#状态' })).status).toBe(401);
  });

  it('requires the console CSRF header and same-origin Origin on writes', async () => {
    const { base, cookie } = await start();
    const noCsrf = await post(
      base,
      '/api/approvals/decide',
      cookie,
      { id: 'ap_x', decision: 'approve' },
      { csrf: false },
    );
    expect(noCsrf.status).toBe(403);
    expect(await bodyOf(noCsrf)).toMatchObject({ ok: false, code: 'bad_csrf' });

    const noOrigin = await post(
      base,
      '/api/control/command',
      cookie,
      { text: '#状态' },
      { origin: false },
    );
    expect(noOrigin.status).toBe(403);
    expect(await bodyOf(noOrigin)).toMatchObject({ ok: false, code: 'bad_origin' });
  });

  it('rejects a non-JSON body on writes', async () => {
    const { base, cookie } = await start();
    const response = await post(
      base,
      '/api/approvals/decide',
      cookie,
      'id=ap_x',
      { contentType: 'application/x-www-form-urlencoded' },
    );
    expect(response.status).toBe(415);
  });

  it('never accepts a decision over GET', async () => {
    const { base, cookie } = await start();
    // 路径存在但方法不对 → 405；写闸只覆盖非 GET，所以决策必须是 POST。
    const getDecide = await get(base, '/api/approvals/decide', cookie);
    expect(getDecide.status).toBe(405);

    const postList = await post(base, '/api/approvals', cookie, {});
    expect(postList.status).toBe(405);

    const postControl = await post(base, '/api/control', cookie, {});
    expect(postControl.status).toBe(405);
  });

  it('inherits the shutdown write gate', async () => {
    const { base, cookie, server } = await start();
    server.stopAcceptingWrites();

    const decide = await post(base, '/api/approvals/decide', cookie, {
      id: `ap_${'0'.repeat(32)}`,
      decision: 'approve',
    });
    expect(decide.status).toBe(503);
    expect(await bodyOf(decide)).toEqual({ ok: false, code: 'shutting_down' });

    const command = await post(base, '/api/control/command', cookie, { text: '#状态' });
    expect(command.status).toBe(503);
  });

  it('inherits the request body size limit', async () => {
    const { base, cookie } = await start();
    const response = await post(base, '/api/control/command', cookie, {
      text: 'x'.repeat(70 * 1024),
    });
    expect(response.status).toBe(413);
  });

  it('treats empty query values as absent', async () => {
    const { base, cookie, service } = await start();
    await proposeCapability(service);

    const response = await get(base, '/api/approvals?status=&kind=&limit=', cookie);
    expect(response.status).toBe(200);
    const body = await bodyOf<ApprovalsBody>(response);
    expect(body.ok).toBe(true);
    expect(body.records).toHaveLength(1);
  });

  it('rejects invalid query parameters with 400', async () => {
    const { base, cookie } = await start();
    for (const query of [
      '?status=bogus',
      '?kind=bogus',
      '?limit=0',
      '?limit=101',
      '?limit=abc',
      '?limit=-1',
    ]) {
      const response = await get(base, `/api/approvals${query}`, cookie);
      expect(response.status, query).toBe(400);
      expect(await bodyOf(response)).toMatchObject({ ok: false, code: 'invalid_query' });
    }
  });

  it('rejects malformed decision and command bodies with 400', async () => {
    const { base, cookie } = await start();
    const badBodies: unknown[] = [
      {},
      { id: 42, decision: 'approve' },
      { id: 'ap_x', decision: 'maybe' },
      { id: 'ap_x', decision: 'approve', reason: 42 },
    ];
    for (const body of badBodies) {
      const response = await post(base, '/api/approvals/decide', cookie, body);
      expect(response.status).toBe(400);
      expect(await bodyOf(response)).toMatchObject({ ok: false, code: 'invalid_body' });
    }

    for (const body of [{}, { text: 42 }, { text: '   ' }]) {
      const response = await post(base, '/api/control/command', cookie, body);
      expect(response.status).toBe(400);
      expect(await bodyOf(response)).toMatchObject({ ok: false, code: 'invalid_body' });
    }
  });
});

describe('GET /api/approvals', () => {
  it('lists pending approvals and hides control.command by default', async () => {
    const { base, cookie, service } = await start();
    await proposeCapability(service);
    const control = await proposeControl(service);

    const response = await get(base, '/api/approvals', cookie);
    expect(response.status).toBe(200);
    const body = await bodyOf<ApprovalsBody>(response);
    expect(body.ok).toBe(true);
    expect(body.pending).toBe(1);
    expect(body.records).toHaveLength(1);
    expect(body.records?.[0]?.kind).toBe('capability.activate');
    expect(body.records?.some((record) => record.id === control.id)).toBe(false);
  });

  it('includes control.command for an explicit kind filter', async () => {
    const { base, cookie, service } = await start();
    const control = await proposeControl(service);

    const response = await get(base, '/api/approvals?kind=control.command', cookie);
    const body = await bodyOf<ApprovalsBody>(response);
    expect(body.ok).toBe(true);
    expect(body.records?.map((record) => record.id)).toEqual([control.id]);
  });

  it('returns a single record by id, including control.command', async () => {
    const { base, cookie, service } = await start();
    const control = await proposeControl(service);

    const response = await get(base, `/api/approvals?id=${control.id}`, cookie);
    expect(response.status).toBe(200);
    const body = await bodyOf<ApprovalsBody>(response);
    expect(body.ok).toBe(true);
    expect(body.records).toHaveLength(1);
    expect(body.records?.[0]?.id).toBe(control.id);
  });

  it('answers an unknown id with 200 not_found instead of 404', async () => {
    const { base, cookie } = await start();
    const response = await get(base, `/api/approvals?id=ap_${'0'.repeat(32)}`, cookie);
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ ok: false, code: 'not_found' });
  });

  it('supports status=all and a bounded limit', async () => {
    const { base, cookie, service } = await start();
    const first = await proposeCapability(service, { plugin: 'one' });
    const second = await proposeCapability(service, { plugin: 'two' });
    await service.decide(first.id, { decision: 'deny', via: 'web', by: 'web:session' });

    const all = await bodyOf<ApprovalsBody>(await get(base, '/api/approvals?status=all', cookie));
    expect(all.records).toHaveLength(2);

    const limited = await bodyOf<ApprovalsBody>(
      await get(base, '/api/approvals?status=all&limit=1', cookie),
    );
    expect(limited.records).toHaveLength(1);
    // 列表按创建时间倒序：最新的两条里只取一条。
    expect([first.id, second.id]).toContain(limited.records?.[0]?.id);
  });

  it('projects records without fingerprint or raw payload', async () => {
    const { base, cookie, service } = await start();
    const hostile = `${'\u001b[31m'}evil\nname${'x'.repeat(300)}`;
    const record = await proposeCapability(service, {
      plugin: hostile,
      permissions: ['fs:read\u001b[0m'],
    });

    const view = toApprovalView(record);
    expect(view).not.toHaveProperty('fingerprint');
    expect(view).not.toHaveProperty('payload');
    expect(view.title).not.toContain('\u001b');
    expect(view.title).not.toContain('\n');
    expect(view.summary).not.toContain('\u001b');
    expect([...view.summary].length).toBeLessThanOrEqual(200);
    expect([...view.title].length).toBeLessThanOrEqual(200);
    expect(view.summary).toContain('版本 0.1.0');
    expect(view.summary).toContain('声明权限');

    const body = await bodyOf<ApprovalsBody>(await get(base, '/api/approvals', cookie));
    expect(body.records?.[0]).not.toHaveProperty('fingerprint');
    expect(body.records?.[0]).not.toHaveProperty('payload');
  });
});

describe('POST /api/approvals/decide', () => {
  it('approves a capability and reports the execution result', async () => {
    const { base, cookie, service } = await start();
    const record = await proposeCapability(service);

    const response = await post(base, '/api/approvals/decide', cookie, {
      id: record.id,
      decision: 'approve',
    });
    expect(response.status).toBe(200);
    const body = await bodyOf<ApprovalsBody>(response);
    expect(body.ok).toBe(true);
    expect(body.record?.status).toBe('approved');
    expect(body.record?.execution?.state).toBe('done');
    expect(body.record).not.toHaveProperty('fingerprint');
    expect(body.record).not.toHaveProperty('payload');
  });

  it('denies with a reason', async () => {
    const { base, cookie, service } = await start();
    const record = await proposeCapability(service);

    const response = await post(base, '/api/approvals/decide', cookie, {
      id: record.id,
      decision: 'deny',
      reason: 'not needed',
    });
    const body = await bodyOf<ApprovalsBody>(response);
    expect(body.ok).toBe(true);
    expect(body.record?.status).toBe('denied');
    expect(body.record?.decisionReason).toBe('not needed');
  });

  it('refuses to decide a control.command from the web channel (R3)', async () => {
    const { base, cookie, service } = await start();
    const control = await proposeControl(service);

    const response = await post(base, '/api/approvals/decide', cookie, {
      id: control.id,
      decision: 'approve',
    });
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ ok: false, code: 'wrong_channel' });
    expect(service.get(control.id)?.status).toBe('pending');
  });

  it('answers an unknown id with 200 not_found', async () => {
    const { base, cookie } = await start();
    const response = await post(base, '/api/approvals/decide', cookie, {
      id: `ap_${'0'.repeat(32)}`,
      decision: 'approve',
    });
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ ok: false, code: 'not_found' });
  });

  it('is idempotent: a second decision returns not_pending', async () => {
    const { base, cookie, service } = await start();
    const record = await proposeCapability(service);

    const first = await post(base, '/api/approvals/decide', cookie, {
      id: record.id,
      decision: 'deny',
    });
    expect((await bodyOf<ApprovalsBody>(first)).ok).toBe(true);

    const second = await post(base, '/api/approvals/decide', cookie, {
      id: record.id,
      decision: 'approve',
    });
    expect(await bodyOf(second)).toEqual({ ok: false, code: 'not_pending' });
  });
});

describe('GET /api/control', () => {
  it('returns the status snapshot plus the approval counters', async () => {
    const status = statusStub({
      quiet: { until: '2026-01-01T00:10:00.000Z', active: true },
      approvals: { pending: 2, oldestPendingAt: '2026-01-01T00:00:00.000Z' },
    });
    const { base, cookie } = await start({ status: () => status });

    const response = await get(base, '/api/control', cookie);
    expect(response.status).toBe(200);
    const body = await bodyOf<{
      ok: boolean;
      status: ControlStatusSnapshot;
      approvals: { pending: number; oldestPendingAt: string | null };
    }>(response);
    expect(body.ok).toBe(true);
    expect(body.status.quiet.active).toBe(true);
    expect(body.approvals).toEqual({ pending: 2, oldestPendingAt: '2026-01-01T00:00:00.000Z' });
  });

  it('degrades the page instead of crashing when the snapshot throws', async () => {
    const { base, cookie } = await start({
      status: () => {
        throw new Error('boom');
      },
    });

    const response = await get(base, '/api/control', cookie);
    expect(response.status).toBe(503);
    expect(await bodyOf(response)).toEqual({ ok: false, code: 'control_unavailable' });

    // 服务器仍然活着：下一条请求照常服务。
    const health = await get(base, '/api/health');
    expect(health.status).toBe(200);
  });
});

describe('POST /api/control/command', () => {
  it('reuses the router with the web origin and projects the reply', async () => {
    const { base, cookie, handleOwnerText } = await start();

    const response = await post(base, '/api/control/command', cookie, { text: '#安静 30' });
    expect(response.status).toBe(200);
    expect(handleOwnerText).toHaveBeenCalledTimes(1);
    expect(handleOwnerText.mock.calls[0]?.[0]).toBe('#安静 30');
    expect(handleOwnerText.mock.calls[0]?.[1]).toEqual({
      channel: 'web',
      actor: 'web:session',
    });
    expect(await bodyOf(response)).toEqual({
      ok: true,
      reply: '已全局静默 30 分钟。',
      intent: 'group.silence',
      changed: true,
    });
  });

  it('marks read-only commands as unchanged', async () => {
    const stub = routerStub({ text: '状态：', handled: true });
    const { base, cookie } = await start({ router: stub.router });

    const body = await bodyOf<{
      ok: boolean;
      reply: string;
      intent: string | null;
      changed: boolean;
    }>(await post(base, '/api/control/command', cookie, { text: '#状态' }));
    expect(body).toEqual({ ok: true, reply: '状态：', intent: 'status.read', changed: false });
  });

  it('rejects text that is not a control command', async () => {
    const stub = routerStub({ text: '', handled: false });
    const { base, cookie } = await start({ router: stub.router });

    const response = await post(base, '/api/control/command', cookie, { text: '你好' });
    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({ ok: false, code: 'invalid_command' });
  });

  it('reports a usage reply as invalid instead of changed', async () => {
    const stub = routerStub({ text: '用法：#封禁 <能力插件>\n#帮助', handled: true });
    const { base, cookie } = await start({ router: stub.router });

    const response = await post(base, '/api/control/command', cookie, { text: '#封禁' });
    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toMatchObject({
      ok: false,
      code: 'invalid_command',
      intent: 'capability.ban',
      changed: false,
    });
  });

  it('reports a refused side effect as ok:false with code refused', async () => {
    const stub = routerStub({
      text: '未知插件 nope（渠道插件不在封禁范围）。',
      handled: true,
    });
    const { base, cookie } = await start({ router: stub.router });

    const response = await post(base, '/api/control/command', cookie, { text: '#封禁 nope' });
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toMatchObject({
      ok: false,
      code: 'refused',
      intent: 'capability.ban',
      changed: false,
    });
  });

  it('treats a not_pending decision as refused', async () => {
    const stub = routerStub({ text: '审批 ap_x 已处理（approved）。', handled: true });
    const { base, cookie } = await start({ router: stub.router });

    const response = await post(base, '/api/control/command', cookie, {
      text: `#同意 ap_${'a'.repeat(32)}`,
    });
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toMatchObject({
      ok: false,
      code: 'refused',
      intent: 'approval.decide',
      changed: false,
    });
  });

  it('treats a partial unban as refused', async () => {
    const stub = routerStub({ text: '已解封 echo，但未生成激活审批。', handled: true });
    const { base, cookie } = await start({ router: stub.router });

    const response = await post(base, '/api/control/command', cookie, { text: '#解封 echo' });
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toMatchObject({
      ok: false,
      code: 'refused',
      intent: 'capability.unban',
      changed: false,
    });
  });

  it('returns 503 when the control plane is not wired', async () => {
    const { base, cookie } = await start({ noRouter: true });
    const response = await post(base, '/api/control/command', cookie, { text: '#状态' });
    expect(response.status).toBe(503);
    expect(await bodyOf(response)).toEqual({ ok: false, code: 'control_unavailable' });
  });

  it('degrades instead of crashing when the router throws', async () => {
    const stub = routerStub();
    stub.handleOwnerText.mockRejectedValueOnce(new Error('boom'));
    const { base, cookie } = await start({ router: stub.router });

    const response = await post(base, '/api/control/command', cookie, { text: '#状态' });
    expect(response.status).toBe(503);
    expect(await bodyOf(response)).toEqual({ ok: false, code: 'control_unavailable' });

    const health = await get(base, '/api/health');
    expect(health.status).toBe(200);
  });
});

describe('control plane disabled', () => {
  it('refuses all four routes with a stable control_disabled code', async () => {
    const started = await start({ disabled: true });

    const list = await get(started.base, '/api/approvals', started.cookie);
    expect(list.status).toBe(503);
    expect(await bodyOf(list)).toEqual({ ok: false, code: 'control_disabled' });

    const decide = await post(
      started.base,
      '/api/approvals/decide',
      started.cookie,
      { id: 'ap_0123456789abcdef0123456789abcdef', decision: 'approve' },
    );
    expect(decide.status).toBe(503);
    expect(await bodyOf(decide)).toEqual({ ok: false, code: 'control_disabled' });

    const status = await get(started.base, '/api/control', started.cookie);
    expect(status.status).toBe(503);
    expect(await bodyOf(status)).toEqual({ ok: false, code: 'control_disabled' });

    const command = await post(started.base, '/api/control/command', started.cookie, {
      text: '#状态',
    });
    expect(command.status).toBe(503);
    expect(await bodyOf(command)).toEqual({ ok: false, code: 'control_disabled' });

    // 关闭时连读都不发生：router 与状态快照都不该被调用。
    expect(started.handleOwnerText).not.toHaveBeenCalled();
  });
});
