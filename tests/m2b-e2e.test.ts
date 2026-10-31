/**
 * T5a 装配集成测试：真宿主 + 真对话记录 + 真审批服务。
 *
 * 这些测试不构造 `src/index.ts`（它一导入就启动进程），而是按装配点的
 * 接线方式组合同一批真实组件，验证交接项：改写回复只有一行 dispatched、
 * 审批 Applier 真的执行、能力激活前的指纹复核。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { PluginHost } from '../src/plugins/host.js';
import { PerceptionQueue, type PerceptionEvent } from '../src/core/events.js';
import { HeartbeatLoop } from '../src/core/loop.js';
import { createPersonaState } from '../src/persona/persona.js';
import { ApprovalService } from '../src/approvals/service.js';
import type { ApprovalEvent, ApprovalRecord } from '../src/approvals/types.js';
import { createControlPort, createControlRouter, type ControlRouter } from '../src/control/router.js';
import { ControlStateStore } from '../src/control/state-store.js';
import { buildStatusSnapshot } from '../src/control/status.js';
import { createApprovalNotifier, harnessConfigSourceExists } from '../src/startup.js';
import { HarnessStore } from '../src/config/harness-store.js';
import { RuntimeConfigHandle } from '../src/config/runtime-handle.js';
import { importFromEnv } from '../src/config/harness-schema.js';
import { createControlApi } from '../src/web/control-api.js';
import { createWebServer } from '../src/web/server.js';
import { GroupGuard } from '../plugins/channels/qq/guard.js';
import { QqServer } from '../plugins/channels/qq/server.js';
import type { OneBotMessageEvent } from '../plugins/channels/qq/protocol.js';
import type { ApplierHooks } from '../src/approvals/appliers.js';
import {
  activateCapabilityApproved,
  describeCapability,
} from '../src/plugins/capability-wiring.js';
import { CapabilityRegistry } from '../src/plugins/capability-registry.js';
import type { CapabilityWorker, WorkerHostDeps, WorkerState } from '../src/plugins/worker-host.js';
import type { PluginManifest, PluginToolDef } from '../src/plugins/manifest.js';
import type { BrainResponse } from '../src/brain/brain.js';
import type { Config } from '../src/config.js';
import { TranscriptWriter } from '../src/web/transcript.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'uuharness-m2b-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    endpoints: [],
    tickFastMs: 300_000,
    tickSlowMs: 3_600_000,
    wakeDebounceMs: 3000,
    httpTimeoutMs: 120_000,
    maxConversationsPerTick: 3,
    maxEventsPerConversation: 20,
    maxQueueSize: 500,
    ...overrides,
  };
}

function event(overrides: Partial<PerceptionEvent> = {}): PerceptionEvent {
  return {
    id: 'evt-1',
    ts: 0,
    kind: 'qq_private_message',
    channel: 'qq:private:1',
    actor: 'private:1',
    content: '你好',
    importance: 9,
    ...overrides,
  };
}

const brainResponse = (content: string): BrainResponse => ({
  content,
  toolCalls: [],
  reasoning: null,
  usage: { promptTokens: 1, completionTokens: 1 },
  endpoint: 'stub',
  model: 'stub',
});

interface HostState {
  sent: Array<{ channel: string; text: string }>;
}

/** 临时渠道插件：只记录宿主路由到的消息，不碰网络。 */
async function writeChannelPlugin(root: string): Promise<void> {
  const dir = join(root, 'qq');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      name: 'qq',
      kind: 'channel',
      channelPrefix: 'qq',
      apiVersion: 1,
      version: '0.1.0',
      entry: 'index.mjs',
    }),
  );
  await writeFile(
    join(dir, 'index.mjs'),
    `
export function createPlugin() {
  return {
    activate(api) { globalThis.__m2bHostState.api = api; },
    deactivate() {},
    send(channel, text) { globalThis.__m2bHostState.sent.push({ channel, text }); },
  };
}
`,
  );
}

async function buildHost(
  root: string,
  transcriptFile: string,
): Promise<{ host: PluginHost; queue: PerceptionQueue; state: HostState; writer: TranscriptWriter }> {
  const state: HostState = { sent: [] };
  (globalThis as unknown as { __m2bHostState: HostState }).__m2bHostState = state;
  const queue = new PerceptionQueue({ debounceMs: 0 });
  const writer = new TranscriptWriter({ file: transcriptFile, log: () => undefined });
  const host = new PluginHost({
    queue,
    brain: {
      chat: async () => brainResponse('ok'),
    },
    log: () => undefined,
    transcript: writer,
  });
  await host.loadFrom(root);
  await host.startAll();
  return { host, queue, state, writer };
}

async function transcriptLines(file: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(file, 'utf8');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('harness config assembly', () => {
  /**
   * 装配顺序（`src/index.ts`）：先判断有没有配置文件，再构造并加载
   * `HarnessStore`，最后才构造 `ConfigStore`。裸装（没有 harness.json）时
   * env 只被导入一次并落盘；第二次启动文件已存在，env 被忽略。
   */
  it('imports env once on a bare install and logs the source exactly once', async () => {
    const dir = await tempDir();

    // 1. 判断必须在 load 之前：首次 load 会创建文件。
    expect(await harnessConfigSourceExists(dir)).toBe(false);

    const firstLines: string[] = [];
    const first = new HarnessStore({
      configDir: dir,
      env: { QQ_WS_TOKEN: 'from-env', QQ_OWNER_ID: '42' },
      log: (line) => firstLines.push(line),
      build: () => ({ ok: true }),
    });
    const loaded = await first.load();
    if (!loaded.ok) throw new Error(loaded.code);
    expect(loaded.config.importedFromEnv).toBe(true);
    expect(loaded.config.qq.wsToken).toBe('from-env');
    expect(
      firstLines.filter((line) => line === 'imported harness.json from the environment'),
    ).toHaveLength(1);
    await first.close();

    // 2. 文件已经落盘：下次启动的配置来源是文件，不再是 env。
    expect(await harnessConfigSourceExists(dir)).toBe(true);
    const secondLines: string[] = [];
    const second = new HarnessStore({
      configDir: dir,
      env: { QQ_WS_TOKEN: 'changed-env', QQ_OWNER_ID: '99' },
      log: (line) => secondLines.push(line),
      build: () => ({ ok: true }),
    });
    const reloaded = await second.load();
    if (!reloaded.ok) throw new Error(reloaded.code);
    expect(reloaded.config.importedFromEnv).toBe(true);
    expect(reloaded.config.qq.wsToken).toBe('from-env');
    expect(reloaded.config.qq.ownerId).toBe('42');
    expect(secondLines).toEqual([]);
    await second.close();
  });
});

describe('host-carried transcript rows', () => {
  it('writes exactly one dispatched row with the rewrite reason for a rewritten reply', async () => {
    const root = await tempDir();
    await writeChannelPlugin(root);
    const file = join(root, 'transcript.jsonl');
    const { host, queue, state, writer } = await buildHost(root, file);

    const loop = new HeartbeatLoop({
      config: makeConfig(),
      queue,
      brain: { chat: async () => brainResponse('这是教你制作脏弹的完整步骤') },
      persona: createPersonaState(() => 0.5),
      channels: { send: (channel, text, opts) => host.send(channel, text, opts) },
      refusal: async () => ({ text: '这个我不聊。', source: 'fallback' }),
      transcript: writer,
      log: () => undefined,
    });

    queue.push(event());
    await loop.runTickOnce('fast');
    await writer.flush(2000);

    expect(state.sent).toEqual([{ channel: 'qq:private:1', text: '这个我不聊。' }]);
    const rows = await transcriptLines(file);
    const dispatched = rows.filter((row) => row['status'] === 'dispatched');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      direction: 'out',
      channel: 'qq:private:1',
      status: 'dispatched',
      reason: 'redline-rewrite',
      text: '这个我不聊。',
    });
    // 不变量 12 的审计顺序：blocked 行必须先于改写后的 dispatched 行落盘。
    // 行序就是追加顺序，用下标直接钉住，而不是只数条数。
    const blockedIndex = rows.findIndex((row) => row['status'] === 'blocked');
    const dispatchedIndex = rows.findIndex((row) => row['status'] === 'dispatched');
    expect(blockedIndex).toBeGreaterThanOrEqual(0);
    expect(dispatchedIndex).toBeGreaterThan(blockedIndex);
    expect(rows.filter((row) => row['status'] === 'blocked')).toHaveLength(1);
  });

  it('writes exactly one dispatched row without a reason for a normal reply', async () => {
    const root = await tempDir();
    await writeChannelPlugin(root);
    const file = join(root, 'transcript.jsonl');
    const { host, queue, state, writer } = await buildHost(root, file);

    const loop = new HeartbeatLoop({
      config: makeConfig(),
      queue,
      brain: { chat: async () => brainResponse('你好呀。') },
      persona: createPersonaState(() => 0.5),
      channels: { send: (channel, text, opts) => host.send(channel, text, opts) },
      transcript: writer,
      log: () => undefined,
    });

    queue.push(event());
    await loop.runTickOnce('fast');
    await writer.flush(2000);

    expect(state.sent).toEqual([{ channel: 'qq:private:1', text: '你好呀。' }]);
    const rows = await transcriptLines(file);
    const dispatched = rows.filter((row) => row['status'] === 'dispatched');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ channel: 'qq:private:1', text: '你好呀。' });
    expect(dispatched[0]).not.toHaveProperty('reason');
  });
});

describe('approval appliers', () => {
  const tool = (name: string): PluginToolDef => ({
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
  });

  interface FakeWorkerState {
    startCalls: number;
    stopCalls: number;
  }

  class FakeWorker {
    readonly manifest: PluginManifest;
    readonly dir: string;
    readonly stats: FakeWorkerState;
    state: WorkerState = 'ready';

    constructor(manifest: PluginManifest, dir: string, stats: FakeWorkerState) {
      this.manifest = manifest;
      this.dir = dir;
      this.stats = stats;
    }

    async start(): Promise<string[]> {
      this.stats.startCalls += 1;
      return ['__selfTest', 'echo'];
    }

    async invokeTool(): Promise<unknown> {
      return true;
    }

    async stop(): Promise<void> {
      this.stats.stopCalls += 1;
    }
  }

  async function capabilityRoot(name: string): Promise<string> {
    const root = await tempDir();
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({
        name,
        kind: 'capability',
        apiVersion: 1,
        version: '0.1.0',
        entry: 'index.mjs',
        permissions: [],
        tools: [tool('echo')],
      }),
    );
    await writeFile(join(dir, 'index.mjs'), 'export function createPlugin() { return { tools: {} }; }\n');
    return root;
  }

  function registryFor(root: string): { registry: CapabilityRegistry; stats: FakeWorkerState } {
    const stats: FakeWorkerState = { startCalls: 0, stopCalls: 0 };
    const deps: WorkerHostDeps = {
      brain: { chat: async () => brainResponse('ok') },
      memory: { search: async () => [], write: async () => undefined },
      log: () => undefined,
    };
    const registry = new CapabilityRegistry(deps, {
      banFile: join(root, 'bans.json'),
      workerFactory: (manifest, dir) =>
        new FakeWorker(manifest, dir, stats) as unknown as CapabilityWorker,
    });
    return { registry, stats };
  }

  it('activates a capability after re-checking the fingerprint', async () => {
    const root = await capabilityRoot('echo');
    const { registry, stats } = registryFor(root);
    await registry.loadFrom(root);

    const descriptor = await describeCapability(registry, 'echo');
    expect(descriptor).not.toBeNull();
    expect(descriptor?.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const service = new ApprovalService({
      dataDir: root,
      log: () => undefined,
      scanIntervalMs: 0,
      executionTimeoutMs: 2000,
      hooks: {
        activateCapability: (record) => activateCapabilityApproved(registry, record),
      },
    });
    await service.load();
    const proposed = await service.propose(
      {
        kind: 'capability.activate',
        plugin: 'echo',
        version: descriptor!.version,
        fingerprint: descriptor!.fingerprint,
        declaredPermissions: descriptor!.declaredPermissions,
        toolNames: descriptor!.toolNames,
      },
      { createdVia: 'system', createdBy: 'startup' },
    );
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;

    const decided = await service.decide(proposed.record.id, {
      decision: 'approve',
      via: 'qq',
      by: 'private:1',
    });
    expect(decided.ok).toBe(true);
    expect(decided.ok && decided.record.execution?.state).toBe('done');
    expect(stats.startCalls).toBe(1);
    expect(registry.status()).toEqual([{ name: 'echo', state: 'active' }]);
    await service.stop();
  });

  it('marks the approval stale when the plugin bytes changed after the proposal', async () => {
    const root = await capabilityRoot('echo');
    const { registry, stats } = registryFor(root);
    await registry.loadFrom(root);

    const descriptor = await describeCapability(registry, 'echo');
    const service = new ApprovalService({
      dataDir: root,
      log: () => undefined,
      scanIntervalMs: 0,
      executionTimeoutMs: 2000,
      hooks: {
        activateCapability: (record) => activateCapabilityApproved(registry, record),
      },
    });
    await service.load();
    const proposed = await service.propose(
      {
        kind: 'capability.activate',
        plugin: 'echo',
        version: '0.1.0',
        fingerprint: descriptor!.fingerprint,
        declaredPermissions: [],
        toolNames: ['echo'],
      },
      { createdVia: 'system', createdBy: 'startup' },
    );
    if (!proposed.ok) throw new Error('proposal failed');

    await writeFile(
      join(root, 'echo', 'index.mjs'),
      'export function createPlugin() { return { tools: { evil() {} } }; }\n',
    );

    const decided = await service.decide(proposed.record.id, {
      decision: 'approve',
      via: 'qq',
      by: 'private:1',
    });
    expect(decided.ok).toBe(true);
    expect(service.get(proposed.record.id)?.status).toBe('stale');
    expect(stats.startCalls).toBe(0);
    await service.stop();
  });

  it('executes an approved control.command through the router', async () => {
    const root = await tempDir();
    const silenced: Array<{ groupId: string; until: number }> = [];
    const hooks: ApplierHooks = {};
    const service = new ApprovalService({
      dataDir: root,
      log: () => undefined,
      scanIntervalMs: 0,
      executionTimeoutMs: 2000,
      hooks,
    });
    await service.load();
    const router = createControlRouter({
      approvals: service,
      guard: {
        silence: (groupId, until) => silenced.push({ groupId, until }),
        resume: () => undefined,
      },
      now: () => 1_000_000,
      log: () => undefined,
    });
    hooks.executeControlCommand = (record) => router.executeApproved(record);

    const proposed = await service.propose(
      { kind: 'control.command', intent: 'group.silence', args: { group: '123', minutes: 30 } },
      { createdVia: 'qq', createdBy: 'private:1' },
    );
    if (!proposed.ok) throw new Error('proposal failed');

    const decided = await service.decide(proposed.record.id, {
      decision: 'approve',
      via: 'qq',
      by: 'private:1',
    });
    expect(decided.ok).toBe(true);
    expect(decided.ok && decided.record.execution?.state).toBe('done');
    expect(silenced).toEqual([{ groupId: '123', until: 1_000_000 + 30 * 60_000 }]);
    await service.stop();
  });

  it('rejects a control.command approved from the web channel without executing it', async () => {
    const root = await tempDir();
    const silenced: Array<{ groupId: string; until: number }> = [];
    const service = new ApprovalService({ dataDir: root, log: () => undefined, scanIntervalMs: 0 });
    await service.load();
    const proposed = await service.propose(
      { kind: 'control.command', intent: 'group.silence', args: { group: '123', minutes: 30 } },
      { createdVia: 'qq', createdBy: 'private:1' },
    );
    if (!proposed.ok) throw new Error('proposal failed');

    const decided = await service.decide(proposed.record.id, {
      decision: 'approve',
      via: 'web',
      by: 'web:session',
    });
    expect(decided).toEqual({ ok: false, code: 'wrong_channel', record: expect.anything() });
    expect(service.get(proposed.record.id)?.status).toBe('pending');
    expect(silenced).toHaveLength(0);
    await service.stop();
  });
});

/* ------------------------------------------------------------------ *
 * T5b：网页控制面端到端（假 NapCat WS + 真 web 服务器 + 真插件/审批）
 * ------------------------------------------------------------------ */

const STRONG_TOKEN = '0123456789abcdef0123456789abcdef';
const SELF_ID = 100;
const OWNER_ID = 300;
const GROUP_ID = 123;
const E2E_WS_TOKEN = 'secret';
const CHANNELS_DIR = fileURLToPath(new URL('../plugins/channels', import.meta.url));

interface ActionFrame {
  action: string;
  params: Record<string, unknown>;
}

interface FakeNapcat {
  ws: WebSocket;
  actions: ActionFrame[];
  sendEvent(event: OneBotMessageEvent): void;
  sendNotice(event: Record<string, unknown>): void;
}

let e2eMessageId = 1;

function nextMessageId(): number {
  return e2eMessageId++;
}

function privateEvent(text: string): OneBotMessageEvent {
  return {
    post_type: 'message',
    message_type: 'private',
    self_id: SELF_ID,
    user_id: OWNER_ID,
    message_id: nextMessageId(),
    raw_message: text,
    message: [{ type: 'text', data: { text } }],
    sender: { user_id: OWNER_ID, nickname: 'owner' },
  };
}

function groupAtEvent(senderId: number): OneBotMessageEvent {
  return {
    post_type: 'message',
    message_type: 'group',
    self_id: SELF_ID,
    user_id: senderId,
    group_id: GROUP_ID,
    message_id: nextMessageId(),
    raw_message: `[CQ:at,qq=${SELF_ID}] hi`,
    message: [
      { type: 'at', data: { qq: String(SELF_ID) } },
      { type: 'text', data: { text: 'hi' } },
    ],
    sender: { user_id: senderId, nickname: 'member' },
  };
}

function kickNotice(): Record<string, unknown> {
  return {
    post_type: 'notice',
    notice_type: 'group_decrease',
    sub_type: 'kick_me',
    self_id: SELF_ID,
    group_id: GROUP_ID,
    user_id: SELF_ID,
  };
}

function privateTexts(actions: readonly ActionFrame[]): string[] {
  return actions
    .filter((entry) => entry.action === 'send_private_msg')
    .map((entry) => {
      const message = entry.params['message'];
      if (!Array.isArray(message)) return '';
      const parts: string[] = [];
      for (const segment of message) {
        if (typeof segment !== 'object' || segment === null) continue;
        const typed = segment as { type?: unknown; data?: Record<string, unknown> };
        if (typed.type !== 'text') continue;
        const text = typed.data?.['text'];
        if (typeof text === 'string') parts.push(text);
      }
      return parts.join('');
    });
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met within timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function connectFakeNapcat(port: number, token: string): Promise<FakeNapcat> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/onebot/v11/ws?access_token=${encodeURIComponent(token)}`,
  );
  const actions: ActionFrame[] = [];
  let replyId = 900_000;
  ws.on('message', (data) => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    const action = frame['action'];
    if (typeof action !== 'string') return;
    const params =
      typeof frame['params'] === 'object' && frame['params'] !== null
        ? (frame['params'] as Record<string, unknown>)
        : {};
    actions.push({ action, params });
    ws.send(
      JSON.stringify({
        status: 'ok',
        retcode: 0,
        data: { message_id: replyId++ },
        echo: frame['echo'],
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return {
    ws,
    actions,
    sendEvent: (event) => ws.send(JSON.stringify(event)),
    sendNotice: (event) => ws.send(JSON.stringify(event)),
  };
}

async function capabilityRegistryFor(root: string): Promise<CapabilityRegistry> {
  const dir = join(root, 'echo');
  await mkdir(dir, { recursive: true });
  const tool: PluginToolDef = {
    name: 'echo',
    description: 'echo',
    parameters: { type: 'object', properties: {} },
  };
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      name: 'echo',
      kind: 'capability',
      apiVersion: 1,
      version: '0.1.0',
      entry: 'index.mjs',
      permissions: [],
      tools: [tool],
    }),
  );
  await writeFile(
    join(dir, 'index.mjs'),
    'export function createPlugin() { return { tools: {} }; }\n',
  );

  const deps: WorkerHostDeps = {
    brain: { chat: async () => brainResponse('ok') },
    memory: { search: async () => [], write: async () => undefined },
    log: () => undefined,
  };
  const registry = new CapabilityRegistry(deps, {
    banFile: join(root, 'bans.json'),
    workerFactory: () =>
      ({
        manifest: {
          name: 'echo',
          kind: 'capability',
          apiVersion: 1,
          version: '0.1.0',
          entry: 'index.mjs',
        } as PluginManifest,
        dir,
        state: 'ready' as WorkerState,
        start: async () => ['echo'],
        invokeTool: async () => true,
        stop: async () => undefined,
      }) as unknown as CapabilityWorker,
  });
  await registry.loadFrom(root);
  return registry;
}

interface E2eHarness {
  dir: string;
  base: string;
  cookie: string;
  approvals: ApprovalService;
  registry: CapabilityRegistry;
  guard: GroupGuard;
  host: PluginHost;
  actions: ActionFrame[];
  pushes: PerceptionEvent[];
  wakes(): number;
  sendPrivate(text: string): void;
  sendGroupAt(senderId: number): void;
  sendKickNotice(): void;
  stop(): Promise<void>;
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

async function startE2e(): Promise<E2eHarness> {
  const root = await tempDir();

  vi.stubEnv('QQ_WS_TOKEN', E2E_WS_TOKEN);
  vi.stubEnv('QQ_WS_PORT', '0');
  vi.stubEnv('QQ_WS_HOST', '127.0.0.1');
  vi.stubEnv('QQ_SELF_ID', String(SELF_ID));
  vi.stubEnv('QQ_OWNER_ID', String(OWNER_ID));
  vi.stubEnv('QQ_CONTROL_ENABLED', '1');
  vi.stubEnv('QQ_CONTROL_NL', '0');
  vi.stubEnv('QQ_GROUP_ALLOWLIST', String(GROUP_ID));
  vi.stubEnv('QQ_GROUP_DENYLIST', '');
  vi.stubEnv('QQ_PRIVATE_ALLOWLIST', '');
  vi.stubEnv('QQ_PRIVATE_DENYLIST', '');
  vi.stubEnv('QQ_PRIVATE_OPEN', '');
  vi.stubEnv('QQ_MIN_REPLY_GAP_MS', '1');

  const guard = new GroupGuard({ minGapMs: 1 });
  const state = new ControlStateStore({ dataDir: root, log: () => undefined });
  await state.load();
  const registry = await capabilityRegistryFor(root);

  let router: ControlRouter | null = null;
  const hooks: ApplierHooks = {
    executeControlCommand: async (record) =>
      router === null
        ? { ok: false, code: 'not_implemented' }
        : router.executeApproved(record),
    activateCapability: async () => ({ ok: true }),
  };
  const approvals = new ApprovalService({
    dataDir: root,
    log: () => undefined,
    scanIntervalMs: 0,
    executionTimeoutMs: 2000,
    hooks,
  });
  await approvals.load();

  const statusSnapshot = () =>
    buildStatusSnapshot({
      state,
      approvals,
      plugins: () => [],
      capabilities: () => registry.status(),
      channels: () => [],
      heartbeat: () => ({ silentRounds: 0, inFlight: false, nextFastMs: 1000 }),
      queueSize: () => 0,
      endpoints: () => [],
      guard: () => guard.snapshot(),
    });

  router = createControlRouter({
    approvals,
    state,
    guard,
    capabilities: {
      status: () => registry.status(),
      ban: (name) => registry.ban(name),
      unban: (name) => registry.unban(name),
    },
    status: statusSnapshot,
    log: () => undefined,
    isKnownGroup: (groupId) => groupId === String(GROUP_ID) || groupId === '*',
  });

  const controlPort = createControlPort({ getRouter: () => router });

  // 真实 QqServer + 可变分发器：QqServer 没有 setOnEvent，测试用它把插件
  // 内部的 handleEvent/handleNotice 接到真实 WS 连接上。
  const dispatch: {
    event?: (event: OneBotMessageEvent) => void;
    notice?: (event: unknown) => void;
    connection?: (connected: boolean) => void;
  } = {};
  const server = new QqServer({
    port: 0,
    token: E2E_WS_TOKEN,
    onEvent: (event) => dispatch.event?.(event),
    onNotice: (event) => dispatch.notice?.(event),
    onConnectionChange: (connected) => dispatch.connection?.(connected),
    log: () => undefined,
  }) as QqServer & {
    setOnEvent(handler: (event: OneBotMessageEvent) => void): void;
    setOnNotice(handler: (event: unknown) => void): void;
    setOnConnectionChange(handler: (connected: boolean) => void): void;
  };
  server.setOnEvent = (handler) => {
    dispatch.event = handler;
  };
  server.setOnNotice = (handler) => {
    dispatch.notice = handler;
  };
  server.setOnConnectionChange = (handler) => {
    dispatch.connection = handler;
  };

  const pushes: PerceptionEvent[] = [];
  let wakeCount = 0;
  const queue = new PerceptionQueue({
    debounceMs: 0,
    log: () => undefined,
    onPush: (event) => {
      pushes.push(event);
    },
  });
  // 记录唤醒次数：插件通过 api.perception.requestWake 调用队列的方法。
  const originalRequestWake = queue.requestWake.bind(queue);
  queue.requestWake = (): void => {
    wakeCount += 1;
    originalRequestWake();
  };

  // 真实宿主 + 真实 qq 插件：控制回执走 `api.send` → `gatedSend` →
  // `host.send` → 插件 → 真实 WS；测试不再手写这条链路。
  const hostLogs: string[] = [];
  // 与装配点一致：qq 插件从稳定门面读配置，而不是 process.env。
  const harness = new RuntimeConfigHandle(importFromEnv(process.env));
  const host = new PluginHost({
    queue,
    brain: { chat: async () => brainResponse('ok') },
    log: (line) => hostLogs.push(line),
    control: { forPlugin: (name) => (name === 'qq' ? controlPort : undefined) },
    pluginFactoryArgs: (name) =>
      name === 'qq' ? [{ guard, server, config: harness }] : undefined,
  });
  await host.loadFrom(CHANNELS_DIR);
  await host.startAll();
  if (!host.status().some((plugin) => plugin.state === 'active')) {
    throw new Error(`qq plugin did not activate:\n${hostLogs.join('\n')}`);
  }

  const napcat = await connectFakeNapcat(server.port, E2E_WS_TOKEN);

  const notifier = createApprovalNotifier({
    approvals,
    owner: String(OWNER_ID),
    send: (channel, text) => host.send(channel, text),
    log: () => undefined,
  });
  notifier.setConnected(true);

  const controlApi = createControlApi({
    approvals,
    status: statusSnapshot,
    router: () => router,
    log: () => undefined,
  });
  const web = createWebServer({
    host: '127.0.0.1',
    port: 0,
    token: STRONG_TOKEN,
    log: () => undefined,
    routeHandlers: controlApi.handlers,
  });
  await web.start();
  const base = `http://127.0.0.1:${web.port()}`;
  const cookie = await loginCookie(base);

  return {
    dir: root,
    base,
    cookie,
    approvals,
    registry,
    guard,
    host,
    actions: napcat.actions,
    pushes,
    wakes: () => wakeCount,
    sendPrivate: (text) => napcat.sendEvent(privateEvent(text)),
    sendGroupAt: (senderId) => napcat.sendEvent(groupAtEvent(senderId)),
    sendKickNotice: () => napcat.sendNotice(kickNotice()),
    stop: async () => {
      await web.stop();
      notifier.stop();
      try {
        napcat.ws.close();
      } catch {
        /* 已关闭。 */
      }
      await host.stopAll();
      await approvals.stop();
      await state.stop();
    },
  };
}

describe('web control surface end to end', () => {
  const stops: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) {
      try {
        await stop();
      } catch {
        /* 清理失败不应掩盖测试结果。 */
      }
    }
    vi.unstubAllEnvs();
  });

  async function start(): Promise<E2eHarness> {
    const harness = await startE2e();
    stops.push(() => harness.stop());
    return harness;
  }

  it('replies to #状态 over the owner private channel', async () => {
    const e = await start();
    e.sendPrivate('#状态');

    await waitFor(() => privateTexts(e.actions).some((text) => text.includes('状态:')));
    const reply = privateTexts(e.actions).find((text) => text.includes('状态:')) ?? '';
    expect(reply).toContain('待审批:0 条');
  });

  it('executes #封禁 against the capability registry and bans file', async () => {
    const e = await start();
    e.sendPrivate('#封禁 echo');

    await waitFor(() => privateTexts(e.actions).some((text) => text.includes('已封禁 echo')));
    expect(e.registry.status()).toContainEqual({ name: 'echo', state: 'banned' });
    const bans = JSON.parse(await readFile(join(e.dir, 'bans.json'), 'utf8')) as unknown;
    expect(Array.isArray(bans)).toBe(true);
    expect(bans).toContain('echo');
  });

  it('puts a group into observation after a kick notice', async () => {
    const e = await start();
    e.sendKickNotice();

    await waitFor(() =>
      e.guard
        .snapshot()
        .some((entry) => entry.groupId === String(GROUP_ID) && entry.observingUntil !== null),
    );
  });

  it('stops @-driven wakes after #安静', async () => {
    const e = await start();

    e.sendGroupAt(400);
    await waitFor(() => e.wakes() === 1);

    e.sendPrivate('#安静 30');
    await waitFor(() =>
      privateTexts(e.actions).some((text) => text.includes('已全局静默 30 分钟')),
    );

    const before = e.pushes.filter((event) => event.kind === 'qq_group_message').length;
    e.sendGroupAt(500);
    await waitFor(
      () => e.pushes.filter((event) => event.kind === 'qq_group_message').length > before,
    );

    // 静默群仍入队（事件不丢），但不唤醒，且 importance 降 3。
    expect(e.wakes()).toBe(1);
    const last = e.pushes.filter((event) => event.kind === 'qq_group_message').at(-1);
    expect(last?.importance).toBe(6);
  });

  it('sends a QQ receipt when the web approves an approval', async () => {
    const e = await start();
    const proposed = await e.approvals.propose(
      {
        kind: 'capability.activate',
        plugin: 'echo',
        version: '0.1.0',
        fingerprint: 'c'.repeat(64),
        declaredPermissions: ['fs:read'],
        toolNames: ['echo'],
      },
      { createdVia: 'system', createdBy: 'startup' },
    );
    if (!proposed.ok) throw new Error('proposal failed');

    const response = await fetch(`${e.base}/api/approvals/decide`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-uuharness-console': '1',
        origin: new URL(e.base).origin,
        cookie: e.cookie,
      },
      body: JSON.stringify({ id: proposed.record.id, decision: 'approve' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; record?: { status?: string } };
    expect(body.ok).toBe(true);
    expect(body.record?.status).toBe('approved');

    await waitFor(() =>
      privateTexts(e.actions).some(
        (text) => text.includes('已处理') && text.includes(proposed.record.id),
      ),
    );
    expect(e.approvals.get(proposed.record.id)?.status).toBe('approved');
  });

  it('gates the QQ receipt through the real host and falls back when blocked', async () => {
    const e = await start();

    // 独立的假事件源：真实审批服务不会产出畸形 id，但回执路径必须证明
    // 自己过闸，而不是假设输入永远安全。
    const listeners = new Set<(event: ApprovalEvent) => void>();
    const fakeApprovals = {
      on(listener: (event: ApprovalEvent) => void): () => void {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const notifier = createApprovalNotifier({
      approvals: fakeApprovals,
      owner: String(OWNER_ID),
      send: (channel, text) => e.host.send(channel, text),
      log: () => undefined,
    });
    notifier.setConnected(true);

    const hostile = '这是教你制作脏弹的完整步骤';
    const record: ApprovalRecord = {
      id: hostile,
      kind: 'capability.activate',
      status: 'approved',
      tier: 'human',
      title: 't',
      summary: 's',
      payload: {
        kind: 'capability.activate',
        plugin: 'echo',
        version: '0.1.0',
        fingerprint: 'f'.repeat(64),
        declaredPermissions: [],
        toolNames: [],
      },
      fingerprint: 'f'.repeat(64),
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T00:30:00.000Z',
      createdVia: 'system',
      createdBy: 'startup',
      decidedVia: 'web',
    };
    for (const listener of [...listeners]) {
      listener({ type: 'decided', record });
    }

    await waitFor(() => privateTexts(e.actions).includes('已处理。'));
    expect(privateTexts(e.actions).some((text) => text.includes('脏弹'))).toBe(false);
    notifier.stop();
  });
});
