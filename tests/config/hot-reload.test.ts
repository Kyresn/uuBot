/**
 * T2 热生效接线：保存后 handle 切换、消费者按次读取、env 迁移只发生一次。
 *
 * 这些测试只装配 T1 的 `HarnessStore` / `RuntimeConfigHandle` 与各消费者，
 * 不启动 `src/index.ts` 的完整进程——装配顺序由类型检查与 T5 的端到端测试兜底。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessStore } from '../../src/config/harness-store.js';
import { RuntimeConfigHandle } from '../../src/config/runtime-handle.js';
import {
  importFromEnv,
  parseHarnessConfig,
  type HarnessConfig,
} from '../../src/config/harness-schema.js';
import { HeartbeatLoop } from '../../src/core/loop.js';
import { PerceptionQueue, type PerceptionEvent } from '../../src/core/events.js';
import { ProactiveScheduler } from '../../src/core/proactive.js';
import { Brain } from '../../src/brain/brain.js';
import { EndpointPool } from '../../src/brain/endpoints.js';
import { createPersonaState } from '../../src/persona/persona.js';
import type { Config } from '../../src/config.js';
import type { RefusalComposer } from '../../src/persona/refusal.js';
import { GroupGuard } from '../../plugins/channels/qq/guard.js';
import { createApprovalNotifier } from '../../src/startup.js';
import { createControlApi } from '../../src/web/control-api.js';
import type { RouteContext } from '../../src/web/server.js';
import type { ApprovalEvent, ApprovalRecord } from '../../src/approvals/types.js';
import {
  QQ_ENV_IGNORED_NOTICE,
  controlSurfaceEnabled,
  createQqReloader,
  harnessConfigSourceExists,
  qqEnvIgnoredNotice,
} from '../../src/startup.js';

const dirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'uuharness-hot-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function baseConfig(): HarnessConfig {
  const parsed = parseHarnessConfig({ version: 1 });
  if (!parsed.ok) throw new Error(`default harness config must parse: ${parsed.code}`);
  return parsed.value;
}

function withTick(config: HarnessConfig, tick: Partial<HarnessConfig['tick']>): HarnessConfig {
  return { ...config, tick: { ...config.tick, ...tick } };
}

function withRedline(config: HarnessConfig, fallbackText: string): HarnessConfig {
  return { ...config, redline: { fallbackText } };
}

function withHttpTimeout(config: HarnessConfig, timeoutMs: number): HarnessConfig {
  return { ...config, http: { timeoutMs } };
}

function withQq(
  config: HarnessConfig,
  qq: Partial<HarnessConfig['qq']>,
): HarnessConfig {
  return { ...config, qq: { ...config.qq, ...qq } };
}

function makeLoopConfig(): Config {
  return {
    endpoints: [],
    tickFastMs: 300_000,
    tickSlowMs: 3_600_000,
    wakeDebounceMs: 3000,
    httpTimeoutMs: 120_000,
    maxConversationsPerTick: 3,
    maxEventsPerConversation: 20,
    maxQueueSize: 500,
  };
}

function makeEvent(overrides: Partial<PerceptionEvent> = {}): PerceptionEvent {
  return {
    id: 'evt-1',
    ts: 0,
    kind: 'cli_message',
    channel: 'cli',
    actor: 'user',
    content: '你好',
    importance: 8,
    ...overrides,
  };
}

function makeLoop(
  handle: RuntimeConfigHandle,
  overrides: {
    refusal?: RefusalComposer;
    send?: (channel: string, text: string) => void;
    log?: (line: string) => void;
  } = {},
): { loop: HeartbeatLoop; queue: PerceptionQueue; chat: ReturnType<typeof vi.fn> } {
  const queue = new PerceptionQueue();
  const chat = vi.fn(async () => ({
    content: '你好呀。',
    toolCalls: [],
    reasoning: null,
    usage: { promptTokens: 0, completionTokens: 0 },
    endpoint: 'stub',
    model: 'stub',
  }));
  const loop = new HeartbeatLoop({
    config: makeLoopConfig(),
    runtimeConfig: handle,
    queue,
    brain: { chat },
    persona: createPersonaState(() => 0.5),
    channels: { send: overrides.send ?? (() => undefined) },
    ...(overrides.refusal === undefined ? {} : { refusal: overrides.refusal }),
    log: overrides.log ?? (() => undefined),
  });
  return { loop, queue, chat };
}

describe('harness store → runtime handle', () => {
  it('swaps the handle after a successful save and notifies subscribers', async () => {
    const dir = await makeDir();
    const ref: { handle: RuntimeConfigHandle | null } = { handle: null };
    const store = new HarnessStore({
      configDir: dir,
      env: { QQ_WS_TOKEN: 'secret' },
      log: () => undefined,
      build: () => ({ ok: true }),
      onChange: (next) => ref.handle?.swap(next),
    });

    const loaded = await store.load();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const handle = new RuntimeConfigHandle(loaded.config);
    ref.handle = handle;

    const seen: HarnessConfig[] = [];
    handle.subscribe((next) => seen.push(next));

    const candidate = withTick(loaded.config, { fastMs: 60_000 });
    await expect(store.save(candidate)).resolves.toEqual({ ok: true });

    expect(handle.get().tick.fastMs).toBe(60_000);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.tick.fastMs).toBe(60_000);

    await store.close();
  });

  it('keeps the old handle value when a save is rejected', async () => {
    const dir = await makeDir();
    const ref: { handle: RuntimeConfigHandle | null } = { handle: null };
    const store = new HarnessStore({
      configDir: dir,
      env: {},
      log: () => undefined,
      build: () => ({ ok: true }),
      onChange: (next) => ref.handle?.swap(next),
    });
    const loaded = await store.load();
    if (!loaded.ok) throw new Error(loaded.code);
    const handle = new RuntimeConfigHandle(loaded.config);
    ref.handle = handle;

    const invalid = { ...loaded.config, tick: { ...loaded.config.tick, fastMs: 10 } };
    await expect(store.save(invalid)).resolves.toMatchObject({ ok: false });

    expect(handle.get()).toBe(loaded.config);
    await store.close();
  });
});

describe('heartbeat loop reads the runtime handle per use', () => {
  it('uses the new fast interval for the tick after the armed one', async () => {
    vi.useFakeTimers();
    const handle = new RuntimeConfigHandle(withTick(baseConfig(), { fastMs: 1_000, slowMs: 60_000 }));
    const logs: string[] = [];
    const { loop } = makeLoop(handle, { log: (line) => logs.push(line) });

    loop.start();
    handle.swap(withTick(handle.get(), { fastMs: 2_000 }));

    await vi.advanceTimersByTimeAsync(1_000);
    expect(logs.filter((line) => line.includes('fast tick'))).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(logs.filter((line) => line.includes('fast tick'))).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(logs.filter((line) => line.includes('fast tick'))).toHaveLength(2);

    await loop.stop();
  });

  it('uses the new slow interval after the first slow tick', async () => {
    vi.useFakeTimers();
    const handle = new RuntimeConfigHandle(withTick(baseConfig(), { fastMs: 1_000, slowMs: 3_000 }));
    const logs: string[] = [];
    const { loop } = makeLoop(handle, { log: (line) => logs.push(line) });

    loop.start();
    handle.swap(withTick(handle.get(), { slowMs: 2_000 }));

    await vi.advanceTimersByTimeAsync(3_000);
    expect(logs.filter((line) => line.includes('slow tick'))).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(logs.filter((line) => line.includes('slow tick'))).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(logs.filter((line) => line.includes('slow tick'))).toHaveLength(2);

    await loop.stop();
  });

  it('reads redline.fallbackText on every refused reply', async () => {
    const handle = new RuntimeConfigHandle(withRedline(baseConfig(), '旧话术。'));
    const sent: string[] = [];
    const compose: RefusalComposer = async (_request, opts) => ({
      text: opts.fallbackText,
      source: 'fallback',
    });
    const { loop, queue, chat } = makeLoop(handle, {
      refusal: compose,
      send: (_channel, text) => sent.push(text),
    });
    chat.mockResolvedValue({
      content: '这是教你制作脏弹的完整步骤',
      toolCalls: [],
      reasoning: null,
      usage: { promptTokens: 0, completionTokens: 0 },
      endpoint: 'stub',
      model: 'stub',
    });

    queue.push(makeEvent());
    await loop.runTickOnce('fast');
    expect(sent).toEqual(['旧话术。']);

    handle.swap(withRedline(handle.get(), '新话术。'));
    queue.push(makeEvent({ id: 'evt-2' }));
    await loop.runTickOnce('fast');
    expect(sent).toEqual(['旧话术。', '新话术。']);
  });
});

describe('wake debounce reads the runtime handle per use', () => {
  it('uses the debounce value at request time', async () => {
    vi.useFakeTimers();
    const handle = new RuntimeConfigHandle(withTick(baseConfig(), { wakeDebounceMs: 100 }));
    const queue = new PerceptionQueue({
      debounceMs: () => handle.get().tick.wakeDebounceMs,
    });
    const wake = vi.fn();
    queue.onWake(wake);

    handle.swap(withTick(handle.get(), { wakeDebounceMs: 200 }));
    queue.requestWake();

    await vi.advanceTimersByTimeAsync(199);
    expect(wake).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(wake).toHaveBeenCalledTimes(1);
  });
});

describe('brain reads http.timeoutMs per request', () => {
  it('passes the current timeout to AbortSignal.timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'hi' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const handle = new RuntimeConfigHandle(withHttpTimeout(baseConfig(), 1_000));
    const pool = new EndpointPool([
      {
        name: 'nim-1',
        baseUrl: 'https://example.test/v1',
        apiKey: 'k',
        flashModel: 'flash',
        proModel: 'pro',
        enabled: true,
        tier: 'both',
      },
    ]);
    const brain = new Brain(pool, { timeoutMs: () => handle.get().http.timeoutMs });

    await brain.chat([{ role: 'user', content: 'hi' }]);
    expect(timeout).toHaveBeenLastCalledWith(1_000);

    handle.swap(withHttpTimeout(handle.get(), 5_000));
    await brain.chat([{ role: 'user', content: 'hi' }]);
    expect(timeout).toHaveBeenLastCalledWith(5_000);
  });
});

describe('qq reload subscription', () => {
  function reloadHost(): { reload: ReturnType<typeof vi.fn<(name: string) => Promise<void>>> } {
    return { reload: vi.fn(async () => undefined) };
  }

  it('reloads qq once when the qq section changes', async () => {
    const handle = new RuntimeConfigHandle(baseConfig());
    const host = reloadHost();
    const stop = createQqReloader(handle, host, () => undefined);

    handle.swap({
      ...handle.get(),
      qq: { ...handle.get().qq, wsPort: 3_002 },
    });
    await Promise.resolve();

    expect(host.reload).toHaveBeenCalledTimes(1);
    expect(host.reload).toHaveBeenCalledWith('qq');
    stop();
  });

  it('does not reload qq when only tick/http/redline change', async () => {
    const handle = new RuntimeConfigHandle(baseConfig());
    const host = reloadHost();
    const stop = createQqReloader(handle, host, () => undefined);

    handle.swap(withTick(withRedline(withHttpTimeout(handle.get(), 5_000), '别的。'), { fastMs: 5_000 }));
    await Promise.resolve();

    expect(host.reload).not.toHaveBeenCalled();
    stop();
  });
});

describe('shared guard reads qq.minReplyGapMs per allow()', () => {
  it('uses the new gap on the next allow without a reload', () => {
    let now = 1_000_000;
    const handle = new RuntimeConfigHandle(withQq(baseConfig(), { minReplyGapMs: 10_000 }));
    const guard = new GroupGuard({
      minGapMs: () => handle.get().qq.minReplyGapMs,
      now: () => now,
    });

    guard.recordSpoken('1');
    now += 5_000;
    expect(guard.allow('1')).toEqual({ ok: false, reason: 'min-gap' });

    handle.swap(withQq(handle.get(), { minReplyGapMs: 1_000 }));
    expect(guard.allow('1')).toEqual({ ok: true });
  });
});

describe('proactive scheduler reads qq.proactive per use', () => {
  function makeScheduler(handle: RuntimeConfigHandle): {
    scheduler: ProactiveScheduler;
    pushes: PerceptionEvent[];
  } {
    const pushes: PerceptionEvent[] = [];
    const scheduler = new ProactiveScheduler({
      enabled: false,
      config: () => handle.get().qq.proactive,
      owner: () => {
        const owner = handle.get().qq.ownerId;
        return owner === '' ? undefined : owner;
      },
      isConnected: () => true,
      queueSize: () => 0,
      inFlight: () => false,
      silentRounds: () => 0,
      state: {
        proactive: () => ({}),
        setProactive: async () => undefined,
      },
      queue: {
        push: (event) => pushes.push(event),
        requestWake: () => undefined,
        nextEventId: () => 'evt-1',
      },
      now: () => new Date(2026, 9, 30, 12, 0, 0, 0).getTime(),
      log: () => undefined,
    });
    return { scheduler, pushes };
  }

  it('honours an enabled flip on the next run', async () => {
    const handle = new RuntimeConfigHandle(baseConfig());
    const { scheduler, pushes } = makeScheduler(handle);

    await expect(scheduler.runOnce()).resolves.toBe(false);
    expect(pushes).toHaveLength(0);

    handle.swap(
      withQq(handle.get(), {
        ownerId: '42',
        proactive: { ...handle.get().qq.proactive, enabled: true },
      }),
    );
    await expect(scheduler.runOnce()).resolves.toBe(true);
    expect(pushes).toHaveLength(1);
  });

  it('follows an owner change on the next run', async () => {
    const handle = new RuntimeConfigHandle(
      withQq(baseConfig(), {
        proactive: { ...baseConfig().qq.proactive, enabled: true },
      }),
    );
    const { scheduler, pushes } = makeScheduler(handle);

    await expect(scheduler.runOnce()).resolves.toBe(false);
    expect(pushes).toHaveLength(0);

    handle.swap(withQq(handle.get(), { ownerId: '42' }));
    await expect(scheduler.runOnce()).resolves.toBe(true);
    expect(pushes[0]?.channel).toBe('qq:private:42');
  });

  it('keeps exactly one timer when enabled flips and start() is re-run', () => {
    vi.useFakeTimers();
    const handle = new RuntimeConfigHandle(baseConfig());
    const { scheduler } = makeScheduler(handle);

    scheduler.start();
    expect(vi.getTimerCount()).toBe(0);

    handle.swap(
      withQq(handle.get(), {
        proactive: { ...handle.get().qq.proactive, enabled: true, intervalMs: 5_000 },
      }),
    );
    scheduler.start();
    scheduler.start();
    expect(vi.getTimerCount()).toBe(1);

    handle.swap(
      withQq(handle.get(), {
        proactive: { ...handle.get().qq.proactive, enabled: false },
      }),
    );
    scheduler.start();
    expect(vi.getTimerCount()).toBe(0);

    scheduler.stop();
  });
});

describe('approval notifier reads the control flag per decision', () => {
  it('starts silent and delivers once the config enables control', () => {
    const listeners = new Set<(event: ApprovalEvent) => void>();
    const approvals = {
      on(listener: (event: ApprovalEvent) => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const handle = new RuntimeConfigHandle(
      withQq(baseConfig(), { ownerId: '42', controlEnabled: false }),
    );
    const sent: string[] = [];
    const notifier = createApprovalNotifier({
      approvals,
      owner: '42',
      send: (_channel, text) => {
        sent.push(text);
      },
      log: () => undefined,
      enabled: () => handle.get().qq.controlEnabled,
    });
    notifier.setConnected(true);

    const record = {
      id: 'ap_x',
      status: 'approved',
      decidedVia: 'web',
    } as ApprovalRecord;
    const emit = (): void => {
      for (const listener of [...listeners]) listener({ type: 'decided', record });
    };

    emit();
    expect(sent).toHaveLength(0);

    handle.swap(withQq(handle.get(), { controlEnabled: true }));
    emit();
    expect(sent).toHaveLength(1);

    notifier.stop();
  });

  it('follows an owner change without re-creating the notifier', () => {
    const listeners = new Set<(event: ApprovalEvent) => void>();
    const approvals = {
      on(listener: (event: ApprovalEvent) => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const handle = new RuntimeConfigHandle(
      withQq(baseConfig(), { ownerId: '', controlEnabled: true }),
    );
    const sent: Array<{ channel: string }> = [];
    const notifier = createApprovalNotifier({
      approvals,
      owner: () => {
        const owner = handle.get().qq.ownerId;
        return owner === '' ? undefined : owner;
      },
      send: (channel) => {
        sent.push({ channel });
      },
      log: () => undefined,
      enabled: () => handle.get().qq.controlEnabled,
    });
    notifier.setConnected(true);

    const record = {
      id: 'ap_x',
      status: 'approved',
      decidedVia: 'web',
    } as ApprovalRecord;
    const emit = (): void => {
      for (const listener of [...listeners]) listener({ type: 'decided', record });
    };

    emit();
    expect(sent).toHaveLength(0);

    handle.swap(withQq(handle.get(), { ownerId: '42' }));
    emit();
    expect(sent.map((entry) => entry.channel)).toEqual(['qq:private:42']);

    notifier.stop();
  });
});

describe('control API reads the control flag per request', () => {
  function makeApi(handle: RuntimeConfigHandle): ReturnType<typeof createControlApi> {
    return createControlApi({
      approvals: {
        decide: async () => ({ ok: false, code: 'not_found' }),
        list: () => [],
        get: () => undefined,
      } as never,
      status: () => ({ approvals: {} }) as never,
      router: () => null,
      enabled: () => controlSurfaceEnabled(handle.get().qq),
      log: () => undefined,
    });
  }

  it('refuses while disabled and serves once enabled, without rebuilding handlers', async () => {
    const handle = new RuntimeConfigHandle(
      withQq(baseConfig(), { ownerId: '42', controlEnabled: false }),
    );
    const api = makeApi(handle);

    const send = vi.fn();
    const ctx = { send } as unknown as RouteContext;

    await api.handlers.control(ctx);
    expect(send).toHaveBeenLastCalledWith(503, { ok: false, code: 'control_disabled' });

    handle.swap(withQq(handle.get(), { controlEnabled: true }));
    send.mockClear();
    await api.handlers.control(ctx);
    expect(send).toHaveBeenLastCalledWith(200, expect.objectContaining({ ok: true }));
  });

  it('honours an explicit off even when no owner is configured', async () => {
    const handle = new RuntimeConfigHandle(
      withQq(baseConfig(), { ownerId: '', controlEnabled: false }),
    );
    const api = makeApi(handle);
    const send = vi.fn();

    await api.handlers.control({ send } as unknown as RouteContext);
    expect(send).toHaveBeenLastCalledWith(503, { ok: false, code: 'control_disabled' });
  });

  it('keeps the web console usable when only the owner is missing', async () => {
    const handle = new RuntimeConfigHandle(
      withQq(baseConfig(), { ownerId: '', controlEnabled: true }),
    );
    const api = makeApi(handle);
    const send = vi.fn();

    await api.handlers.control({ send } as unknown as RouteContext);
    expect(send).toHaveBeenLastCalledWith(200, expect.objectContaining({ ok: true }));
  });
});

describe('harness.json migration and the double-source rule', () => {
  it('imports env once, writes the file, then ignores QQ_* on later loads', async () => {
    const dir = await makeDir();

    const first = new HarnessStore({
      configDir: dir,
      env: { QQ_WS_TOKEN: 'from-env', QQ_OWNER_ID: '42' },
      log: () => undefined,
      build: () => ({ ok: true }),
    });
    const loaded = await first.load();
    if (!loaded.ok) throw new Error(loaded.code);
    expect(loaded.config.importedFromEnv).toBe(true);
    expect(loaded.config.qq.wsToken).toBe('from-env');
    expect(loaded.config.qq.ownerId).toBe('42');
    await first.close();

    const written = JSON.parse(await readFile(path.join(dir, 'harness.json'), 'utf8')) as {
      qq: { wsToken: string };
    };
    expect(written.qq.wsToken).toBe('from-env');

    const second = new HarnessStore({
      configDir: dir,
      env: { QQ_WS_TOKEN: 'changed-env', QQ_OWNER_ID: '99' },
      log: () => undefined,
      build: () => ({ ok: true }),
    });
    const reloaded = await second.load();
    if (!reloaded.ok) throw new Error(reloaded.code);
    expect(reloaded.config.qq.wsToken).toBe('from-env');
    expect(reloaded.config.qq.ownerId).toBe('42');
    await second.close();
  });

  it('logs the ignored-env line only when the file exists and QQ_* keys are present', async () => {
    const dir = await makeDir();
    expect(await harnessConfigSourceExists(dir)).toBe(false);
    expect(qqEnvIgnoredNotice({ QQ_WS_TOKEN: 'x' }, false)).toBeNull();
    expect(qqEnvIgnoredNotice({}, true)).toBeNull();
    expect(qqEnvIgnoredNotice({ NIM_API_KEYS: 'k' }, true)).toBeNull();
    expect(qqEnvIgnoredNotice({ QQ_WS_TOKEN: 'x' }, true)).toBe(QQ_ENV_IGNORED_NOTICE);

    await writeFile(path.join(dir, 'harness.json'), JSON.stringify(baseConfig()));
    expect(await harnessConfigSourceExists(dir)).toBe(true);
  });

  it('treats a valid harness.json.bak as a config source for the ignored-env notice', async () => {
    const dir = await makeDir();
    await writeFile(path.join(dir, 'harness.json.bak'), JSON.stringify(baseConfig()));

    expect(await harnessConfigSourceExists(dir)).toBe(true);
    expect(qqEnvIgnoredNotice({ QQ_WS_TOKEN: 'x' }, await harnessConfigSourceExists(dir))).toBe(
      QQ_ENV_IGNORED_NOTICE,
    );
  });

  it('falls back to harness.json.bak when the primary file is invalid', async () => {
    const dir = await makeDir();
    const valid = withTick(baseConfig(), { fastMs: 12_000 });
    await writeFile(path.join(dir, 'harness.json'), '{ not json');
    await writeFile(path.join(dir, 'harness.json.bak'), JSON.stringify(valid));

    const store = new HarnessStore({
      configDir: dir,
      env: {},
      log: () => undefined,
      build: () => ({ ok: true }),
    });
    const loaded = await store.load();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.config.tick.fastMs).toBe(12_000);
    await store.close();
  });
});

describe('importFromEnv stays the only env reader', () => {
  it('reads the documented whitelist and keeps defaults for bad values', () => {
    const config = importFromEnv({
      QQ_WS_TOKEN: 'token',
      QQ_WS_PORT: '0',
      TICK_FAST_MS: '2000',
      TICK_SLOW_MS: '4000',
      WAKE_DEBOUNCE_MS: '250',
      HTTP_TIMEOUT_MS: '30000',
      REDLINE_FALLBACK_TEXT: '换个话题。',
    });

    expect(config.tick).toEqual({ fastMs: 2_000, slowMs: 4_000, wakeDebounceMs: 250 });
    expect(config.http.timeoutMs).toBe(30_000);
    expect(config.redline.fallbackText).toBe('换个话题。');
    expect(config.qq.wsToken).toBe('token');
    expect(config.qq.wsPort).toBe(0);
  });

  it('keeps the current 3000 ms wake debounce default for bare installs', () => {
    expect(importFromEnv({}).tick.wakeDebounceMs).toBe(3_000);
  });
});
