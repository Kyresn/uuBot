import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginHost } from '../../src/plugins/host.js';
import type { ChannelPluginApiV1, PluginApiV1 } from '../../src/plugins/api.js';
import { PerceptionQueue } from '../../src/core/events.js';
import type { TranscriptRecord } from '../../src/web/transcript.js';
import { sanitizeForTty } from '../../src/util/tty.js';

type TestState = {
  calls: Array<{ plugin: string; channel: string; text: string }>;
  apis: Record<string, ChannelPluginApiV1>;
  deactivations: string[];
  activations?: number;
  failActivate?: boolean;
  inActivate?: boolean;
  overlap?: boolean;
  enabled?: boolean;
  pending?: Promise<void>;
  deactivated?: boolean;
};

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'uuharness-plugins-'));
  dirs.push(dir);
  return dir;
}

function installState(): TestState {
  const state: TestState = { calls: [], apis: {}, deactivations: [] };
  (globalThis as unknown as { __uuharnessTest: TestState }).__uuharnessTest = state;
  return state;
}

function makeBrain(): PluginApiV1['brain'] {
  return {
    chat: async () => ({
      content: 'ok',
      toolCalls: [],
      reasoning: null,
      usage: { promptTokens: 0, completionTokens: 0 },
      endpoint: 'stub',
      model: 'stub',
    }),
  };
}

function channelManifest(name: string, prefix: string): Record<string, unknown> {
  return { name, kind: 'channel', channelPrefix: prefix, apiVersion: 1, version: '0.1.0', entry: 'index.mjs' };
}

function channelSource(name: string): string {
  return `
export function createPlugin() {
  return {
    activate(api) {
      globalThis.__uuharnessTest.apis[${JSON.stringify(name)}] = api;
    },
    deactivate() {
      globalThis.__uuharnessTest.deactivations.push(${JSON.stringify(name)});
    },
    send(channel, text) {
      globalThis.__uuharnessTest.calls.push({ plugin: ${JSON.stringify(name)}, channel, text });
    },
  };
}
`;
}

async function writePlugin(
  root: string,
  dirName: string,
  manifest: unknown,
  source: string,
): Promise<void> {
  const pluginDir = join(root, dirName);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(join(pluginDir, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(pluginDir, 'index.mjs'), source);
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('PluginHost', () => {
  it('loads and activates a channel plugin', async () => {
    installState();
    const root = await tempDir();
    await writePlugin(root, 'qq', channelManifest('qq', 'qq'), channelSource('qq'));

    const host = new PluginHost({ queue: new PerceptionQueue(), brain: makeBrain(), log: vi.fn() });
    await host.loadFrom(root);
    await host.startAll();

    expect(host.status().find((p) => p.name === 'qq')?.state).toBe('active');
  });

  it('routes by longest channel prefix', async () => {
    const state = installState();
    const root = await tempDir();
    await writePlugin(root, 'qq', channelManifest('qq', 'qq'), channelSource('qq'));
    await writePlugin(root, 'qq2', channelManifest('qq2', 'qq2'), channelSource('qq2'));

    const host = new PluginHost({ queue: new PerceptionQueue(), brain: makeBrain(), log: vi.fn() });
    await host.loadFrom(root);
    await host.startAll();
    host.send('qq2:group:1', 'hi');

    expect(state.calls).toEqual([{ plugin: 'qq2', channel: 'qq2:group:1', text: 'hi' }]);
  });

  it('prefers the most specific prefix when prefixes overlap', async () => {
    const state = installState();
    const root = await tempDir();
    await writePlugin(root, 'qq', channelManifest('qq', 'qq'), channelSource('qq'));
    await writePlugin(root, 'qqgroup', channelManifest('qqgroup', 'qq:group'), channelSource('qqgroup'));

    const host = new PluginHost({ queue: new PerceptionQueue(), brain: makeBrain(), log: vi.fn() });
    await host.loadFrom(root);
    await host.startAll();
    host.send('qq:group:1', 'hi');

    expect(state.calls).toEqual([{ plugin: 'qqgroup', channel: 'qq:group:1', text: 'hi' }]);
    expect(state.calls.some((call) => call.plugin === 'qq')).toBe(false);
  });

  it('drops unroutable sends without throwing', async () => {
    installState();
    const root = await tempDir();
    await writePlugin(root, 'qq', channelManifest('qq', 'qq'), channelSource('qq'));

    const log = vi.fn();
    const host = new PluginHost({ queue: new PerceptionQueue(), brain: makeBrain(), log });
    await host.loadFrom(root);
    await host.startAll();

    expect(() => host.send('nope', 'x')).not.toThrow();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no channel for nope'));
  });

  it('survives a plugin whose activate throws', async () => {
    installState();
    const root = await tempDir();
    await writePlugin(root, 'qq', channelManifest('qq', 'qq'), channelSource('qq'));
    await writePlugin(
      root,
      'bad',
      channelManifest('bad', 'bad'),
      `export function createPlugin() {
  return {
    activate() { throw new Error('boom'); },
    deactivate() {},
    send() {},
  };
}`,
    );

    const host = new PluginHost({ queue: new PerceptionQueue(), brain: makeBrain(), log: vi.fn() });
    await host.loadFrom(root);
    await expect(host.startAll()).resolves.toBeUndefined();

    const status = host.status();
    expect(status.find((p) => p.name === 'bad')?.state).toBe('failed');
    expect(status.find((p) => p.name === 'bad')?.error).toContain('boom');
    expect(status.find((p) => p.name === 'qq')?.state).toBe('active');
  });

  it('survives a directory with a bad manifest', async () => {
    installState();
    const root = await tempDir();
    await writePlugin(root, 'broken', { name: 'Bad Name', kind: 'channel' }, channelSource('broken'));

    const host = new PluginHost({ queue: new PerceptionQueue(), brain: makeBrain(), log: vi.fn() });
    await expect(host.loadFrom(root)).resolves.toBeUndefined();

    expect(host.status()).toHaveLength(0);
  });

  it('injects perception handle into channel plugins', async () => {
    const state = installState();
    const root = await tempDir();
    await writePlugin(root, 'qq', channelManifest('qq', 'qq'), channelSource('qq'));

    const queue = new PerceptionQueue();
    queue.setSizeGen(() => 'evt-fixed');
    const host = new PluginHost({ queue, brain: makeBrain(), log: vi.fn() });
    await host.loadFrom(root);
    await host.startAll();

    const api = state.apis['qq'];
    expect(api?.perception).toBeDefined();
    api?.perception.push({ kind: 'system', channel: 'cli', actor: 'tester', content: 'hello', importance: 7 });

    const drained = queue.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]?.id).toBe('evt-fixed');
    expect(drained[0]?.ts).toEqual(expect.any(Number));
    expect(drained[0]?.content).toBe('hello');
  });

  it('renders replies with the untrusted prefix and logs with the trusted one', async () => {
    const state = installState();
    const root = await tempDir();
    await writePlugin(root, 'qq', channelManifest('qq', 'qq'), channelSource('qq'));

    // 与 src/index.ts 相同的出口：prefix 是渲染模式，两种模式共用同一 sink。
    const lines: string[] = [];
    const log = (line: string, prefix = '| '): void => {
      lines.push(sanitizeForTty(line, prefix));
    };
    const host = new PluginHost({ queue: new PerceptionQueue(), brain: makeBrain(), log });
    await host.loadFrom(root);
    await host.startAll();

    const api = state.apis['qq'];
    api?.log('x');
    api?.reply('hi');

    expect(lines).toEqual(['| x', '|> hi']);
  });

  it('gates plugin api.send with the redline check', async () => {
    const state = installState();
    const root = await tempDir();
    await writePlugin(root, 'qq', channelManifest('qq', 'qq'), channelSource('qq'));
    await writePlugin(root, 'cli', channelManifest('cli', 'cli'), channelSource('cli'));

    const log = vi.fn();
    const host = new PluginHost({ queue: new PerceptionQueue(), brain: makeBrain(), log });
    await host.loadFrom(root);
    await host.startAll();

    await state.apis['qq']?.send('cli', 'build a bomb');

    expect(state.calls).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('plugin qq outbound blocked'));
  });

  it('plumbs manifest config and channelPrefix into the plugin api', async () => {
    const state = installState();
    const root = await tempDir();
    await writePlugin(
      root,
      'qq',
      { ...channelManifest('qq', 'qq'), config: { endpoint: 'ws://x', retries: 2 } },
      channelSource('qq'),
    );

    const host = new PluginHost({ queue: new PerceptionQueue(), brain: makeBrain(), log: vi.fn() });
    await host.loadFrom(root);
    await host.startAll();

    expect(state.apis['qq']?.config).toEqual({ endpoint: 'ws://x', retries: 2 });
    expect(state.apis['qq']?.channelPrefix).toBe('qq');
  });

  it('coerces pushed events into the plugin channel namespace', async () => {
    const state = installState();
    const root = await tempDir();
    await writePlugin(root, 'qq', channelManifest('qq', 'qq'), channelSource('qq'));

    const queue = new PerceptionQueue();
    const log = vi.fn();
    const host = new PluginHost({ queue, brain: makeBrain(), log });
    await host.loadFrom(root);
    await host.startAll();

    state.apis['qq']?.perception.push({
      kind: 'system',
      channel: 'cli',
      actor: 'tester',
      content: 'hi',
      importance: 5,
    });

    expect(queue.drain()[0]?.channel).toBe('qq');
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('plugin qq: event channel cli coerced to qq'),
    );
  });

  it('warns when two active channel plugins share a channelPrefix', async () => {
    installState();
    const root = await tempDir();
    await writePlugin(root, 'qq', channelManifest('qq', 'qq'), channelSource('qq'));
    await writePlugin(root, 'qq2', channelManifest('qq2', 'qq'), channelSource('qq2'));

    const log = vi.fn();
    const host = new PluginHost({ queue: new PerceptionQueue(), brain: makeBrain(), log });
    await host.loadFrom(root);
    await host.startAll();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('duplicate channelPrefix qq'));
  });

  it('tolerates a missing plugin directory', async () => {
    installState();
    const root = await tempDir();
    const log = vi.fn();
    const host = new PluginHost({ queue: new PerceptionQueue(), brain: makeBrain(), log });

    await expect(host.loadFrom(join(root, 'does-not-exist'))).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('cannot read plugin directory'));
  });

  it('marks a plugin failed when its module cannot be loaded', async () => {
    installState();
    const root = await tempDir();
    await writePlugin(root, 'broken', channelManifest('broken', 'broken'), 'export function createPlugin( {');

    const host = new PluginHost({ queue: new PerceptionQueue(), brain: makeBrain(), log: vi.fn() });
    await expect(host.loadFrom(root)).resolves.toBeUndefined();

    const status = host.status().find((p) => p.name === 'broken');
    expect(status?.state).toBe('failed');
    expect(status?.error).toBeTruthy();
  });

  it('stops active plugins and is idempotent', async () => {
    const state = installState();
    const root = await tempDir();
    await writePlugin(root, 'qq', channelManifest('qq', 'qq'), channelSource('qq'));

    const host = new PluginHost({ queue: new PerceptionQueue(), brain: makeBrain(), log: vi.fn() });
    await host.loadFrom(root);
    await host.startAll();
    await host.stopAll();

    expect(host.status().find((p) => p.name === 'qq')?.state).toBe('stopped');
    expect(state.deactivations).toEqual(['qq']);

    await host.stopAll();
    expect(state.deactivations).toEqual(['qq']);
  });

  it('records a dispatched outbound event after routing and active checks', async () => {
    installState();
    const root = await tempDir();
    await writePlugin(root, 'qq', channelManifest('qq', 'qq'), channelSource('qq'));

    const records: TranscriptRecord[] = [];
    const host = new PluginHost({
      queue: new PerceptionQueue(),
      brain: makeBrain(),
      log: vi.fn(),
      transcript: { record: (event) => records.push(event) },
    });
    await host.loadFrom(root);
    await host.startAll();

    host.send('qq', 'hello');

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      direction: 'out',
      status: 'dispatched',
      channel: 'qq',
      text: 'hello',
    });
    expect(typeof records[0]?.ts).toBe('string');
  });

  it('does not record sends that cannot be routed', async () => {
    installState();
    const root = await tempDir();
    await writePlugin(root, 'qq', channelManifest('qq', 'qq'), channelSource('qq'));

    const records: TranscriptRecord[] = [];
    const host = new PluginHost({
      queue: new PerceptionQueue(),
      brain: makeBrain(),
      log: vi.fn(),
      transcript: { record: (event) => records.push(event) },
    });
    await host.loadFrom(root);
    await host.startAll();

    host.send('nope', 'hello');
    expect(records).toEqual([]);
  });

  it('records a red-line blocked plugin send with the reason', async () => {
    const state = installState();
    const root = await tempDir();
    await writePlugin(root, 'qq', channelManifest('qq', 'qq'), channelSource('qq'));

    const records: TranscriptRecord[] = [];
    const host = new PluginHost({
      queue: new PerceptionQueue(),
      brain: makeBrain(),
      log: vi.fn(),
      transcript: { record: (event) => records.push(event) },
    });
    await host.loadFrom(root);
    await host.startAll();

    await state.apis['qq']?.send('cli', 'build a bomb');

    expect(state.calls).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      direction: 'out',
      status: 'blocked',
      channel: 'cli',
      reason: expect.any(String),
    });
  });
});

describe('pluginFactoryArgs', () => {
  it('passes the host args only to the matching plugin, preserving object identity', async () => {
    installState();
    const root = await tempDir();
    const factoryCalls: Record<string, unknown[]> = {};
    (globalThis as unknown as { __uuharnessFactoryCalls: Record<string, unknown[]> })
      .__uuharnessFactoryCalls = factoryCalls;

    const source = (name: string): string => `
export function createPlugin(...args) {
  globalThis.__uuharnessFactoryCalls[${JSON.stringify(name)}] = args;
  return { activate() {}, deactivate() {}, send() {} };
}
`;
    await writePlugin(root, 'qq', channelManifest('qq', 'qq'), source('qq'));
    await writePlugin(root, 'other', channelManifest('other', 'other'), source('other'));

    // 与装配点相同：只有 qq 拿到共享护栏，且必须是同一个对象。
    const guard = { silence() {}, resume() {} };
    const host = new PluginHost({
      queue: new PerceptionQueue(),
      brain: makeBrain(),
      log: vi.fn(),
      pluginFactoryArgs: (name) => (name === 'qq' ? [{ guard }] : undefined),
    });
    await host.loadFrom(root);

    const qqArgs = factoryCalls['qq'];
    expect(qqArgs).toHaveLength(1);
    expect((qqArgs?.[0] as { guard: unknown }).guard).toBe(guard);
    expect(factoryCalls['other']).toEqual([]);
  });
});

describe('PluginHost.reload', () => {
  function reloadableSource(name: string): string {
    return `
export function createPlugin() {
  return {
    activate(api) {
      if (globalThis.__uuharnessTest.failActivate) throw new Error('activate boom');
      globalThis.__uuharnessTest.activations =
        (globalThis.__uuharnessTest.activations ?? 0) + 1;
      globalThis.__uuharnessTest.apis[${JSON.stringify(name)}] = api;
    },
    deactivate() {
      globalThis.__uuharnessTest.deactivations.push(${JSON.stringify(name)});
    },
    send() {},
  };
}
`;
  }

  it('deactivates and reactivates the plugin, keeping the host running', async () => {
    const state = installState();
    const root = await tempDir();
    await writePlugin(root, 'qq', channelManifest('qq', 'qq'), reloadableSource('qq'));
    const host = new PluginHost({ queue: new PerceptionQueue(), brain: makeBrain(), log: vi.fn() });
    await host.loadFrom(root);
    await host.startAll();
    const firstApi = state.apis['qq'];

    await host.reload('qq');

    expect(state.deactivations).toEqual(['qq']);
    expect(state.activations).toBe(2);
    expect(state.apis['qq']).not.toBe(firstApi);
    expect(host.status()[0]).toMatchObject({ name: 'qq', state: 'active' });
  });

  it('logs a failed reload and leaves the plugin failed, not throwing', async () => {
    const state = installState();
    const root = await tempDir();
    await writePlugin(root, 'qq', channelManifest('qq', 'qq'), reloadableSource('qq'));
    const log = vi.fn();
    const host = new PluginHost({ queue: new PerceptionQueue(), brain: makeBrain(), log });
    await host.loadFrom(root);
    await host.startAll();

    state.failActivate = true;
    await expect(host.reload('qq')).resolves.toBeUndefined();

    expect(host.status()[0]).toMatchObject({ name: 'qq', state: 'failed' });
    expect(log.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      'failed to reactivate',
    );

    // A later save can retry the same plugin.
    state.failActivate = false;
    await host.reload('qq');
    expect(host.status()[0]).toMatchObject({ name: 'qq', state: 'active' });
  });

  it('does not touch the perception queue', async () => {
    installState();
    const root = await tempDir();
    await writePlugin(root, 'qq', channelManifest('qq', 'qq'), reloadableSource('qq'));
    const queue = new PerceptionQueue();
    const host = new PluginHost({ queue, brain: makeBrain(), log: vi.fn() });
    await host.loadFrom(root);
    await host.startAll();

    queue.push({
      id: 'queued-1',
      ts: 1,
      kind: 'qq_group_message',
      channel: 'qq:group:1',
      actor: 'group:1/2',
      content: 'hello',
      importance: 9,
    });
    await host.reload('qq');

    expect(queue.size()).toBe(1);
    expect(queue.drain().map((event) => event.id)).toEqual(['queued-1']);
  });

  it('logs and resolves for an unknown plugin name', async () => {
    const log = vi.fn();
    const host = new PluginHost({ queue: new PerceptionQueue(), brain: makeBrain(), log });

    await expect(host.reload('missing')).resolves.toBeUndefined();
    expect(log.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      'cannot reload unknown plugin missing',
    );
  });

  it('serialises concurrent reloads: one activation at a time, no nulled api', async () => {
    const state = installState();
    const root = await tempDir();
    const source = `
export function createPlugin() {
  return {
    async activate(api) {
      const s = globalThis.__uuharnessTest;
      if (s.inActivate) s.overlap = true;
      s.inActivate = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      s.apis.qq = api;
      s.activations = (s.activations ?? 0) + 1;
      s.inActivate = false;
    },
    async deactivate() {
      const s = globalThis.__uuharnessTest;
      s.deactivations.push('qq');
      s.apis.qq = undefined;
    },
    send() {},
  };
}
`;
    await writePlugin(root, 'qq', channelManifest('qq', 'qq'), source);
    const host = new PluginHost({ queue: new PerceptionQueue(), brain: makeBrain(), log: vi.fn() });
    await host.loadFrom(root);
    await host.startAll();

    await Promise.all([host.reload('qq'), host.reload('qq')]);

    expect(state.overlap).toBeFalsy();
    expect(state.activations).toBe(3);
    expect(state.apis['qq']).toBeDefined();
    expect(host.status()[0]).toMatchObject({ name: 'qq', state: 'active' });
  });

  it('ignores a reload that lands after stopAll has begun', async () => {
    const state = installState();
    const root = await tempDir();
    await writePlugin(root, 'qq', channelManifest('qq', 'qq'), reloadableSource('qq'));
    const host = new PluginHost({ queue: new PerceptionQueue(), brain: makeBrain(), log: vi.fn() });
    await host.loadFrom(root);
    await host.startAll();
    await host.stopAll();

    const activationsAfterStop = state.activations;
    await host.reload('qq');

    // 关闭期间落地的保存不得把已停的插件重新拉活。
    expect(state.activations).toBe(activationsAfterStop);
    expect(host.status()[0]).toMatchObject({ name: 'qq', state: 'stopped' });
  });

  it('waits for an in-flight send before deactivating on reload', async () => {
    const state = installState();
    const root = await tempDir();
    const source = `
export function createPlugin() {
  return {
    activate() {
      globalThis.__uuharnessTest.activations =
        (globalThis.__uuharnessTest.activations ?? 0) + 1;
    },
    deactivate() {
      globalThis.__uuharnessTest.deactivated = true;
      globalThis.__uuharnessTest.deactivations.push('qq');
    },
    send() {
      return globalThis.__uuharnessTest.pending;
    },
  };
}
`;
    await writePlugin(root, 'qq', channelManifest('qq', 'qq'), source);
    const host = new PluginHost({ queue: new PerceptionQueue(), brain: makeBrain(), log: vi.fn() });
    await host.loadFrom(root);
    await host.startAll();

    let resolveSend!: () => void;
    state.pending = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });
    host.send('qq:group:1', 'hi');
    const reloading = host.reload('qq');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 发送未完成前不得 deactivate：否则已派发的消息被重载截断。
    expect(state.deactivated).toBeFalsy();

    resolveSend();
    await reloading;
    expect(state.deactivated).toBe(true);
    expect(state.activations).toBe(2);
  });

  it('marks the plugin stopped, not failed, when the config disables it', async () => {
    const state = installState();
    const root = await tempDir();
    const source = `
export function createPlugin() {
  return {
    enabled() {
      return globalThis.__uuharnessTest.enabled !== false;
    },
    activate() {
      globalThis.__uuharnessTest.activations =
        (globalThis.__uuharnessTest.activations ?? 0) + 1;
    },
    deactivate() {
      globalThis.__uuharnessTest.deactivations.push('qq');
    },
    send() {},
  };
}
`;
    await writePlugin(root, 'qq', channelManifest('qq', 'qq'), source);
    const host = new PluginHost({ queue: new PerceptionQueue(), brain: makeBrain(), log: vi.fn() });
    await host.loadFrom(root);
    await host.startAll();
    expect(host.status()[0]).toMatchObject({ state: 'active' });

    state.enabled = false;
    await host.reload('qq');

    // 操作员关掉渠道是 stopped，不是 failed（failed 留给激活出错）。
    expect(host.status()[0]).toMatchObject({ name: 'qq', state: 'stopped' });
  });
});
