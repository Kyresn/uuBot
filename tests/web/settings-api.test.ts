/**
 * T4 设置 API：`GET /api/settings` 与 `PUT /api/settings`。
 *
 * 两条路由复用既有闸：会话、Host、Origin、`X-Uuharness-Console`、JSON、
 * 体积上限、关闭期写闸。PUT 的边界用真实 `HarnessStore` 验证：非法值/打码值
 * 400 且磁盘逐字节不变；合法保存只提交一次（一次热生效）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseHarnessConfig, type HarnessConfig } from '../../src/config/harness-schema.js';
import { HarnessStore } from '../../src/config/harness-store.js';
import { requiresRestartFields } from '../../src/startup.js';
import { createSettingsApi } from '../../src/web/settings-api.js';
import { createWebServer, type WebServer } from '../../src/web/server.js';

const STRONG_TOKEN = '0123456789abcdef0123456789abcdef';
const CONFIG_FILE = 'harness.json';

const servers: WebServer[] = [];
const stores: HarnessStore[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Started {
  base: string;
  port: number;
  cookie: string;
  server: WebServer;
  store: HarnessStore;
  dir: string;
  changes: HarnessConfig[];
  /** 让下一次干跑失败；传 null 恢复。 */
  setBuildFailure(code: string | null): void;
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

async function start(
  options: { load?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<Started> {
  const dir = await mkdtemp(path.join(tmpdir(), 'uuharness-settings-'));
  dirs.push(dir);
  const changes: HarnessConfig[] = [];
  let failure: string | null = null;

  const store = new HarnessStore({
    configDir: dir,
    env: options.env ?? {},
    log: () => {},
    build: () => (failure === null ? { ok: true } : { ok: false, code: failure }),
    onChange: (config) => changes.push(config),
  });
  stores.push(store);

  if (options.load !== false) {
    const loaded = await store.load();
    if (!loaded.ok) throw new Error(`harness config could not be loaded: ${loaded.code}`);
  }

  const api = createSettingsApi({
    store,
    requiresRestart: requiresRestartFields,
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

  return {
    base,
    port: server.port(),
    cookie,
    server,
    store,
    dir,
    changes,
    setBuildFailure: (code: string | null) => {
      failure = code;
    },
  };
}

function get(base: string, path: string, cookie?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    headers: cookie === undefined ? {} : { cookie },
  });
}

function put(
  base: string,
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
  return fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

interface RawResult {
  status: number;
  body: string;
}

/** 需要控制 Host 头（fetch 不允许改）时走原始 HTTP 请求。 */
function rawGet(port: number, pathName: string, headers: Record<string, string>): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, method: 'GET', path: pathName, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function configBytes(dir: string): Promise<Buffer> {
  return readFile(path.join(dir, CONFIG_FILE));
}

/** PUT 是整份文档：用 schema 默认值构造一份完整配置，再按测试覆盖。 */
function fullConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const parsed = parseHarnessConfig({ version: 1 });
  if (!parsed.ok) throw new Error(`default harness config must parse: ${parsed.code}`);
  return {
    ...(JSON.parse(JSON.stringify(parsed.value)) as Record<string, unknown>),
    ...overrides,
  };
}

function withQq(
  base: Record<string, unknown>,
  qq: Record<string, unknown>,
): Record<string, unknown> {
  const current = base['qq'] as Record<string, unknown>;
  return { ...base, qq: { ...current, ...qq } };
}

describe('settings route gates', () => {
  it('requires a session on both routes', async () => {
    const { base } = await start();
    expect((await get(base, '/api/settings')).status).toBe(401);

    const write = await put(base, undefined, { version: 1 });
    expect(write.status).toBe(401);
  });

  it('requires the console CSRF header and a same-origin Origin on PUT', async () => {
    const { base, cookie } = await start();

    const noCsrf = await put(base, cookie, { version: 1 }, { csrf: false });
    expect(noCsrf.status).toBe(403);
    expect(await noCsrf.json()).toMatchObject({ ok: false, code: 'bad_csrf' });

    const noOrigin = await put(base, cookie, { version: 1 }, { origin: false });
    expect(noOrigin.status).toBe(403);
    expect(await noOrigin.json()).toMatchObject({ ok: false, code: 'bad_origin' });
  });

  it('421s a Host header outside the allowlist', async () => {
    const { port } = await start();
    const result = await rawGet(port, '/api/settings', { host: 'evil.example' });
    expect(result.status).toBe(421);
    expect(JSON.parse(result.body)).toEqual({ ok: false, code: 'bad_host' });
  });

  it('requires JSON content type on PUT', async () => {
    const { base, cookie } = await start();
    const response = await put(base, cookie, { version: 1 }, { contentType: 'text/plain' });
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ ok: false, code: 'unsupported_media_type' });
  });

  it('rejects invalid JSON and bodies over the route limit', async () => {
    const { base, cookie } = await start();

    const invalid = await put(base, cookie, '{not json');
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ ok: false, code: 'invalid_json' });

    const tooLarge = await put(base, cookie, {
      version: 1,
      redline: { fallbackText: 'a'.repeat(70_000) },
    });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ ok: false, code: 'payload_too_large' });
  });

  it('only allows GET and PUT on the settings path', async () => {
    const { base, cookie } = await start();
    const response = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-uuharness-console': '1',
        origin: new URL(base).origin,
      },
      body: '{}',
    });
    expect(response.status).toBe(405);
  });

  it('rejects PUT with 503 after stopAcceptingWrites while GET keeps working', async () => {
    const { server, base, cookie } = await start();
    server.stopAcceptingWrites();

    const write = await put(base, cookie, { version: 1 });
    expect(write.status).toBe(503);
    expect(await write.json()).toEqual({ ok: false, code: 'shutting_down' });

    const read = await get(base, '/api/settings', cookie);
    expect(read.status).toBe(200);
  });
});

describe('GET /api/settings', () => {
  it('returns the masked config, the import flag, and computed restart fields', async () => {
    const { base, cookie } = await start({ env: { QQ_WS_TOKEN: '0123456789abcdef' } });

    const response = await get(base, '/api/settings', cookie);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      ok: boolean;
      config: { qq: Record<string, unknown> };
      importedFromEnv: boolean;
      requiresRestart: string[];
      revision: string;
    };
    expect(body.ok).toBe(true);
    expect(body.importedFromEnv).toBe(true);
    expect(body.requiresRestart).toEqual(['capability.autoActivate']);
    expect(body.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(body.config.qq['hasWsToken']).toBe(true);
    expect(body.config.qq['wsTokenLast4']).toBe('cdef');
    expect(body.config.qq['wsToken']).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('0123456789abcdef');
  });

  it('returns 503 when the store has not loaded', async () => {
    const { base, cookie } = await start({ load: false });

    const response = await get(base, '/api/settings', cookie);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, code: 'unavailable' });
  });
});

describe('PUT /api/settings', () => {
  it('rejects an out-of-range value with a field and leaves the file byte-identical', async () => {
    const harness = await start();
    const before = await configBytes(harness.dir);

    const response = await put(harness.base, harness.cookie, {
      ...fullConfig(),
      tick: { fastMs: 1, slowMs: 3_600_000, wakeDebounceMs: 3000 },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      code: 'invalid_field',
      field: 'tick.fastMs',
    });
    expect(await configBytes(harness.dir)).toEqual(before);
    expect(harness.changes).toHaveLength(0);
  });

  it('rejects a masked wsToken placeholder', async () => {
    const harness = await start();
    const before = await configBytes(harness.dir);

    const response = await put(
      harness.base,
      harness.cookie,
      withQq(fullConfig(), { wsToken: '••••cdef' }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      code: 'invalid_field',
      field: 'qq.wsToken',
    });
    expect(await configBytes(harness.dir)).toEqual(before);
    expect(harness.changes).toHaveLength(0);
  });

  it('applies a valid save exactly once and reflects it in get()', async () => {
    const harness = await start();

    const response = await put(harness.base, harness.cookie, {
      ...fullConfig(),
      tick: { fastMs: 60_000, slowMs: 3_600_000, wakeDebounceMs: 3000 },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(harness.store.get()?.tick.fastMs).toBe(60_000);
    expect(harness.changes).toHaveLength(1);
    expect(harness.changes[0]?.tick.fastMs).toBe(60_000);

    const written = JSON.parse(await readFile(path.join(harness.dir, CONFIG_FILE), 'utf8')) as {
      tick: { fastMs: number };
    };
    expect(written.tick.fastMs).toBe(60_000);
  });

  it('keeps an omitted secret, clears it with null, and replaces it with a string', async () => {
    const harness = await start();
    const base = fullConfig();
    const baseQq = base['qq'] as Record<string, unknown>;
    const withoutToken = { ...baseQq };
    delete withoutToken['wsToken'];

    const replaced = await put(
      harness.base,
      harness.cookie,
      withQq(base, { wsToken: 'token-0123456789' }),
    );
    expect(replaced.status).toBe(200);
    expect(harness.store.get()?.qq.wsToken).toBe('token-0123456789');

    const omitted = await put(harness.base, harness.cookie, { ...base, qq: withoutToken });
    expect(omitted.status).toBe(200);
    expect(harness.store.get()?.qq.wsToken).toBe('token-0123456789');

    const cleared = await put(
      harness.base,
      harness.cookie,
      withQq(base, { wsToken: null }),
    );
    expect(cleared.status).toBe(200);
    expect(harness.store.get()?.qq.wsToken).toBe('');
  });

  it('rejects a body that omits any whole top-level section', async () => {
    // 缺整段会让 schema 用默认值填上：`qq.controlEnabled` 回 true、
    // `qq.enabled` 回 false、名单清空、tick 回默认——静默的配置回滚。
    const harness = await start();
    const before = await configBytes(harness.dir);

    for (const section of ['tick', 'http', 'redline', 'qq', 'capability']) {
      const document = fullConfig();
      delete document[section];

      const response = await put(harness.base, harness.cookie, document);
      expect(response.status, section).toBe(400);
      expect(await response.json(), section).toEqual({
        ok: false,
        code: 'invalid_field',
        field: section,
      });
    }

    expect(await configBytes(harness.dir)).toEqual(before);
    expect(harness.changes).toHaveLength(0);
  });

  it('returns 400 and keeps the file when the dry run fails', async () => {
    const harness = await start();
    const before = await configBytes(harness.dir);
    harness.setBuildFailure('build_failed');

    const response = await put(harness.base, harness.cookie, {
      ...fullConfig(),
      tick: { fastMs: 60_000, slowMs: 3_600_000, wakeDebounceMs: 3000 },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, code: 'build_failed' });
    expect(await configBytes(harness.dir)).toEqual(before);
    expect(harness.changes).toHaveLength(0);
  });

  it('rejects non-object bodies and unsupported versions', async () => {
    const harness = await start();

    const array = await put(harness.base, harness.cookie, []);
    expect(array.status).toBe(400);
    expect(await array.json()).toMatchObject({ ok: false, code: 'invalid_config' });

    const version = await put(harness.base, harness.cookie, {
      ...fullConfig(),
      version: 2,
    });
    expect(version.status).toBe(400);
    expect(await version.json()).toEqual({
      ok: false,
      code: 'unsupported_version',
      field: 'version',
    });
  });

  it('round-trips a revision and rejects a stale one with 409', async () => {
    const harness = await start();

    const first = (await (await get(harness.base, '/api/settings', harness.cookie)).json()) as {
      revision: string;
    };
    expect(first.revision).toMatch(/^[0-9a-f]{64}$/);

    const saved = await put(harness.base, harness.cookie, {
      ...fullConfig(),
      revision: first.revision,
      tick: { fastMs: 60_000, slowMs: 3_600_000, wakeDebounceMs: 3000 },
    });
    expect(saved.status).toBe(200);
    expect(harness.store.get()?.tick.fastMs).toBe(60_000);

    const second = (await (await get(harness.base, '/api/settings', harness.cookie)).json()) as {
      revision: string;
    };
    expect(second.revision).not.toBe(first.revision);

    const before = await configBytes(harness.dir);
    const stale = await put(harness.base, harness.cookie, {
      ...fullConfig(),
      revision: first.revision,
      tick: { fastMs: 120_000, slowMs: 3_600_000, wakeDebounceMs: 3000 },
    });

    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ ok: false, code: 'conflict' });
    // 过期页面绝不能覆盖更晚的保存。
    expect(harness.store.get()?.tick.fastMs).toBe(60_000);
    expect(await configBytes(harness.dir)).toEqual(before);
    expect(harness.changes).toHaveLength(1);
  });
});

describe('requiresRestart derivation', () => {
  it('comes from the hot-apply boundaries rather than a hardcoded list', () => {
    const parsed = parseHarnessConfig({ version: 1 });
    if (!parsed.ok) throw new Error(`default config must parse: ${parsed.code}`);

    expect(requiresRestartFields(parsed.value)).toEqual(['capability.autoActivate']);

    // 新增一个尚未接线的配置叶子：保守规则必须把它报告为「需重启」。
    const future = {
      ...parsed.value,
      future: { knob: true },
    } as unknown as HarnessConfig;
    expect(requiresRestartFields(future)).toEqual([
      'capability.autoActivate',
      'future.knob',
    ]);
  });
});
