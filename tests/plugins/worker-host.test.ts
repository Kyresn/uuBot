import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CapabilityWorker,
  type WorkerHostDeps,
  type WorkerLike,
} from '../../src/plugins/worker-host.js';
import type { PluginManifest } from '../../src/plugins/manifest.js';
import type { BrainResponse } from '../../src/brain/brain.js';
import type { ChatMessage } from '../../src/brain/types.js';
import type { PluginApiV1 } from '../../src/plugins/api.js';

/** 手动驱动的 Worker 桩：测试自己触发 message/error/exit。 */
class FakeWorker implements WorkerLike {
  readonly posted: unknown[] = [];
  private readonly messageHandlers: Array<(message: unknown) => void> = [];
  private readonly errorHandlers: Array<(error: unknown) => void> = [];
  private readonly exitHandlers: Array<(code: unknown) => void> = [];
  terminated = false;
  terminateCalls = 0;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  on(event: 'message' | 'error' | 'exit', cb: (...args: any[]) => void): void {
    if (event === 'message') this.messageHandlers.push(cb);
    else if (event === 'error') this.errorHandlers.push(cb);
    else this.exitHandlers.push(cb);
  }

  terminate(): Promise<number> {
    this.terminated = true;
    this.terminateCalls += 1;
    return Promise.resolve(0);
  }

  emitMessage(message: unknown): void {
    for (const handler of this.messageHandlers) handler(message);
  }

  emitError(error: unknown): void {
    for (const handler of this.errorHandlers) handler(error);
  }

  emitExit(code = 1): void {
    for (const handler of this.exitHandlers) handler(code);
  }

  lastPosted(): unknown {
    return this.posted[this.posted.length - 1];
  }
}

function capabilityManifest(permissions?: string[]): PluginManifest {
  return {
    name: 'cap',
    kind: 'capability',
    apiVersion: 1,
    version: '0.1.0',
    entry: 'index.mjs',
    ...(permissions === undefined ? {} : { permissions }),
  };
}

const brainResponse: BrainResponse = {
  content: 'ok',
  toolCalls: [],
  reasoning: null,
  usage: { promptTokens: 0, completionTokens: 0 },
  endpoint: 'stub',
  model: 'stub',
};

function makeBrain() {
  const chat = vi.fn(
    async (_messages: ChatMessage[], _opts?: { tier?: 'flash' | 'pro' }) => brainResponse,
  );
  return { brain: { chat } as PluginApiV1['brain'], chat };
}

function makeMemory(): PluginApiV1['memory'] {
  return {
    search: async () => [],
    write: async () => {},
  };
}

interface Harness {
  worker: CapabilityWorker;
  fake: FakeWorker;
  log: ReturnType<typeof vi.fn>;
  chat: ReturnType<typeof makeBrain>['chat'];
}

function harness(
  manifest: PluginManifest = capabilityManifest(),
  overrides: Partial<WorkerHostDeps> = {},
): Harness {
  const fake = new FakeWorker();
  const { brain, chat } = makeBrain();
  const log = vi.fn();
  const deps: WorkerHostDeps = {
    brain,
    memory: makeMemory(),
    log,
    createWorker: () => fake,
    ...overrides,
  };
  const worker = new CapabilityWorker(deps, manifest, join('/plugins', manifest.name));
  return { worker, fake, log, chat };
}

/** 让已排队的微任务跑完（不含定时器）。 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CapabilityWorker', () => {
  it('resolves with tool names after ready', async () => {
    const { worker, fake } = harness(capabilityManifest(['brain']));
    const started = worker.start();

    expect(fake.posted[0]).toMatchObject({
      type: 'init',
      pluginPath: join('/plugins/cap', 'index.mjs'),
      permissions: ['brain'],
      config: {},
      name: 'cap',
    });

    fake.emitMessage({ type: 'ready', tools: ['echo', 'ping'] });

    await expect(started).resolves.toEqual(['echo', 'ping']);
    expect(worker.state).toBe('ready');
  });

  it('logs once and ignores a declared net permission', async () => {
    const { worker, fake, log } = harness(capabilityManifest(['net']));
    const started = worker.start();

    expect(log).toHaveBeenCalledWith(
      'plugin cap: net permission is not implemented; ignoring',
    );

    fake.emitMessage({ type: 'ready', tools: [] });
    await expect(started).resolves.toEqual([]);
  });

  it('rejects after the init timeout', async () => {
    vi.useFakeTimers();
    let clock = 0;
    const { worker } = harness(capabilityManifest(), { now: () => clock });

    const started = worker.start();
    const assertion = expect(started).rejects.toThrow(/timed out/);

    clock = 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;

    expect(worker.state).toBe('failed');
  });

  it('rejects start when the worker exits before ready', async () => {
    const { worker, fake } = harness();
    const started = worker.start();
    const assertion = expect(started).rejects.toThrow(/exited before ready/);

    fake.emitExit(1);
    await assertion;

    expect(worker.state).toBe('crashed');
  });

  it('rejects start on a fatal init message', async () => {
    const { worker, fake, log } = harness();
    const started = worker.start();
    const assertion = expect(started).rejects.toThrow(/cannot load plugin/);

    fake.emitMessage({ type: 'fatal', error: 'cannot load plugin' });
    await assertion;

    expect(worker.state).toBe('failed');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('cannot load plugin'));
  });

  it('denies rpc methods the manifest did not declare', async () => {
    const { worker, fake, log, chat } = harness(capabilityManifest(['log']));
    const started = worker.start();
    fake.emitMessage({ type: 'ready', tools: [] });
    await started;

    fake.emitMessage({ type: 'rpc', id: 'r1', method: 'brain.chat', args: [[]] });
    await flushMicrotasks();

    expect(chat).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('plugin cap permission denied: brain.chat'));
    expect(fake.lastPosted()).toEqual({
      type: 'rpc-result',
      id: 'r1',
      ok: false,
      error: 'permission denied: brain.chat',
    });
  });

  it('forwards allowed rpc calls to the brain', async () => {
    const { worker, fake, chat } = harness(capabilityManifest(['brain']));
    const started = worker.start();
    fake.emitMessage({ type: 'ready', tools: [] });
    await started;

    fake.emitMessage({
      type: 'rpc',
      id: 'r2',
      method: 'brain.chat',
      args: [[{ role: 'user', content: 'hi' }], { tier: 'flash' }],
    });
    await flushMicrotasks();

    expect(chat).toHaveBeenCalledWith([{ role: 'user', content: 'hi' }], { tier: 'flash' });
    expect(fake.lastPosted()).toMatchObject({ type: 'rpc-result', id: 'r2', ok: true });
  });

  it('always allows log and reply rpc calls under the capability prefix', async () => {
    const { worker, fake, log } = harness(capabilityManifest());
    const started = worker.start();
    fake.emitMessage({ type: 'ready', tools: [] });
    await started;

    fake.emitMessage({ type: 'rpc', id: 'l1', method: 'log', args: ['trusted line'] });
    fake.emitMessage({ type: 'rpc', id: 'l2', method: 'reply', args: ['model line'] });
    await flushMicrotasks();

    expect(log).toHaveBeenCalledWith('trusted line', '| [cap:cap] ');
    expect(log).toHaveBeenCalledWith('model line', '| [cap:cap] ');
    // 能力插件不再借用模型输出前缀 '|> '。
    expect(log).not.toHaveBeenCalledWith('model line', '|> ');
    expect(fake.lastPosted()).toMatchObject({ type: 'rpc-result', id: 'l2', ok: true });
  });

  it('rejects send rpc even when the manifest declares the send permission', async () => {
    const { worker, fake, log } = harness(capabilityManifest(['send']));
    const started = worker.start();
    fake.emitMessage({ type: 'ready', tools: [] });
    await started;

    fake.emitMessage({ type: 'rpc', id: 's1', method: 'send', args: ['cli', 'hello'] });
    await flushMicrotasks();

    expect(log).toHaveBeenCalledWith(
      'plugin cap permission denied: send (capabilities return data, the agent decides what to say)',
    );
    expect(fake.lastPosted()).toEqual({
      type: 'rpc-result',
      id: 's1',
      ok: false,
      error: 'permission denied: send (capability plugins may not send)',
    });
  });

  it('marks the worker crashed on unexpected exit without throwing', async () => {
    const { worker, fake, log } = harness();
    const started = worker.start();
    fake.emitMessage({ type: 'ready', tools: [] });
    await started;

    expect(() => fake.emitExit(1)).not.toThrow();
    expect(worker.state).toBe('crashed');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('crashed'));
  });

  it('rejects invokeTool after the 30s timeout', async () => {
    vi.useFakeTimers();
    let clock = 0;
    const { worker, fake } = harness(capabilityManifest(), { now: () => clock });
    const started = worker.start();
    fake.emitMessage({ type: 'ready', tools: ['echo'] });
    await started;

    const call = worker.invokeTool('echo', { text: 'hi' });
    const assertion = expect(call).rejects.toThrow(/timed out/);

    expect(fake.lastPosted()).toMatchObject({ type: 'tool', name: 'echo', args: { text: 'hi' } });

    clock = 30_000;
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it('resolves invokeTool with the tool result', async () => {
    const { worker, fake } = harness();
    const started = worker.start();
    fake.emitMessage({ type: 'ready', tools: ['echo'] });
    await started;

    const call = worker.invokeTool('echo', { text: 'hi' });
    const sent = fake.lastPosted() as { id: string };
    fake.emitMessage({ type: 'tool-result', id: sent.id, ok: true, value: { echoed: 'hi' } });

    await expect(call).resolves.toEqual({ echoed: 'hi' });
  });

  it('rejects pending tools when the worker crashes', async () => {
    const { worker, fake } = harness();
    const started = worker.start();
    fake.emitMessage({ type: 'ready', tools: ['echo'] });
    await started;

    const call = worker.invokeTool('echo', {});
    const assertion = expect(call).rejects.toThrow(/worker exited/);
    fake.emitExit(1);
    await assertion;

    expect(worker.state).toBe('crashed');
  });

  it('sends shutdown then terminates after the grace period', async () => {
    vi.useFakeTimers();
    let clock = 0;
    const { worker, fake } = harness(capabilityManifest(), { now: () => clock });
    const started = worker.start();
    fake.emitMessage({ type: 'ready', tools: [] });
    await started;

    const stopping = worker.stop();
    expect(fake.lastPosted()).toEqual({ type: 'shutdown' });

    clock = 2_000;
    await vi.advanceTimersByTimeAsync(2_000);
    await stopping;

    expect(fake.terminated).toBe(true);
    expect(worker.state).toBe('stopped');
  });

  it('stops without terminating when the worker exits during the grace period', async () => {
    vi.useFakeTimers();
    const { worker, fake } = harness();
    const started = worker.start();
    fake.emitMessage({ type: 'ready', tools: [] });
    await started;

    const stopping = worker.stop();
    fake.emitExit(0);
    await stopping;

    expect(fake.terminated).toBe(false);
    expect(worker.state).toBe('stopped');
  });

  it('fails fast when start is retried after a spawn failure', async () => {
    const createWorker = vi.fn((): WorkerLike => {
      throw new Error('spawn boom');
    });
    const { worker } = harness(capabilityManifest(), { createWorker });

    await expect(worker.start()).rejects.toThrow(/spawn boom/);
    expect(worker.state).toBe('failed');

    // 修复前：第二次 start 会重新 spawn 并永久挂起（state 仍是 failed）。
    await expect(worker.start()).rejects.toThrow(/cannot start in state failed/);
  });

  it('terminates at most once when stop is called concurrently', async () => {
    vi.useFakeTimers();
    let clock = 0;
    const { worker, fake } = harness(capabilityManifest(), { now: () => clock });
    const started = worker.start();
    fake.emitMessage({ type: 'ready', tools: [] });
    await started;

    const first = worker.stop();
    const second = worker.stop();

    clock = 2_000;
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.all([first, second]);

    expect(fake.terminateCalls).toBe(1);
    expect(worker.state).toBe('stopped');
  });

  it('does not leave an unhandled rejection when stopped before ready', async () => {
    const { worker, fake } = harness();

    // 故意不 await：stop 先到，start 的 rejection 必须被内部消化。
    void worker.start();
    const stopping = worker.stop();
    fake.emitExit(0);
    await stopping;

    expect(worker.state).toBe('stopped');
  });
});

describe('worker environment isolation', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('spawns capability workers with an empty environment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uuharness-worker-env-'));
    dirs.push(dir);
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(capabilityManifest()));
    await writeFile(
      join(dir, 'index.mjs'),
      `
export function createPlugin() {
  return {
    selfTest: async () => true,
    tools: { env: async () => ({ ...process.env }) },
  };
}
`,
    );

    const savedToken = process.env.QQ_WS_TOKEN;
    const savedConsole = process.env.WEB_CONSOLE_TOKEN;
    process.env.QQ_WS_TOKEN = 'leaked-secret';
    process.env.WEB_CONSOLE_TOKEN = 'leaked-console';
    try {
      const { brain } = makeBrain();
      const deps: WorkerHostDeps = {
        brain,
        memory: { search: async () => [], write: async () => undefined },
        log: () => undefined,
      };
      const worker = new CapabilityWorker(deps, capabilityManifest(), dir);
      await worker.start();
      const env = (await worker.invokeTool('env', {})) as Record<string, string>;
      expect(env['QQ_WS_TOKEN']).toBeUndefined();
      expect(env['WEB_CONSOLE_TOKEN']).toBeUndefined();
      await worker.stop();
    } finally {
      if (savedToken === undefined) delete process.env.QQ_WS_TOKEN;
      else process.env.QQ_WS_TOKEN = savedToken;
      if (savedConsole === undefined) delete process.env.WEB_CONSOLE_TOKEN;
      else process.env.WEB_CONSOLE_TOKEN = savedConsole;
    }
  }, 20_000);
});
