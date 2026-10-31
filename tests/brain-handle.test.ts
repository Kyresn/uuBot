import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrainHandle } from '../src/brain/handle.js';
import { Brain, type BrainResponse } from '../src/brain/brain.js';
import { EndpointPool, type EndpointSnapshot } from '../src/brain/endpoints.js';
import { ConfigStore, type ConfigChange } from '../src/config/store.js';
import { createBrainBuilder } from '../src/startup.js';
import type { ChatMessage } from '../src/brain/types.js';
import type { ModelsConfig, ModelsEndpoint } from '../src/config/models-schema.js';

const CONFIG_FILE = 'models.json';

function endpoint(overrides: Partial<ModelsEndpoint> = {}): ModelsEndpoint {
  return {
    name: 'nim-1',
    provider: 'nvidia_nim',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKey: 'key-0123456789abcdef',
    enabled: true,
    tier: 'both',
    flashModel: 'flash-model',
    proModel: 'pro-model',
    ...overrides,
  };
}

function configWith(endpoints: unknown[]): unknown {
  return { version: 1, importedFromEnv: false, endpoints };
}

function response(label: string): BrainResponse {
  return {
    content: 'ok',
    toolCalls: [],
    reasoning: null,
    usage: { promptTokens: 0, completionTokens: 0 },
    endpoint: label,
    model: label,
  };
}

/** Structural stand-in: BrainHandle only ever calls chat() and snapshot(). */
function fakeBrain(label: string): Brain & { chat: ReturnType<typeof vi.fn>; snapshot: ReturnType<typeof vi.fn> } {
  return {
    chat: vi.fn(async () => response(label)),
    snapshot: vi.fn(() => [{ name: label }]),
  } as unknown as Brain & { chat: ReturnType<typeof vi.fn>; snapshot: ReturnType<typeof vi.fn> };
}

const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];

function snapshotEntry(overrides: Partial<EndpointSnapshot> = {}): EndpointSnapshot {
  return {
    name: 'nim-1',
    provider: 'nvidia_nim',
    enabled: true,
    tier: 'both',
    remainingBackoffMs: 0,
    degraded: false,
    failures: 0,
    ...overrides,
  };
}

/** Handle over a brain whose only meaningful behaviour is snapshot(). */
function handleWithSnapshot(entries: EndpointSnapshot[]): BrainHandle {
  const brain = { chat: vi.fn(), snapshot: () => entries } as unknown as Brain;
  return new BrainHandle(brain);
}

const dirs: string[] = [];
const stores: ConfigStore[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'uuharness-handle-'));
  dirs.push(dir);
  return dir;
}

async function makeLoadedStore(
  dir: string,
  opts: {
    env?: NodeJS.ProcessEnv;
    build: (config: ModelsConfig) => { ok: true; pool: EndpointPool; brain: Brain } | { ok: false; code: string };
    onChange?: (change: ConfigChange) => void;
    onCommit?: (change: ConfigChange) => void;
    atomicWrite?: (targetPath: string, contents: string) => Promise<void>;
  },
): Promise<ConfigStore> {
  const store = new ConfigStore({
    configDir: dir,
    env: opts.env ?? {},
    log: () => {},
    build: opts.build,
    ...(opts.onChange === undefined ? {} : { onChange: opts.onChange }),
    ...(opts.onCommit === undefined ? {} : { onCommit: opts.onCommit }),
    ...(opts.atomicWrite === undefined ? {} : { atomicWrite: opts.atomicWrite }),
  });
  stores.push(store);
  return store;
}

afterEach(async () => {
  while (stores.length > 0) {
    const store = stores.pop();
    if (store !== undefined) await store.close();
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

describe('BrainHandle', () => {
  it('delegates chat() to the current brain with the same arguments', async () => {
    const first = fakeBrain('first');
    const handle = new BrainHandle(first);
    const opts = { tier: 'pro' as const };

    const result = await handle.chat(messages, opts);

    expect(result.endpoint).toBe('first');
    expect(first.chat).toHaveBeenCalledTimes(1);
    expect(first.chat).toHaveBeenCalledWith(messages, opts);
  });

  it('routes new calls to the swapped brain while the old reference still works', async () => {
    const first = fakeBrain('first');
    const second = fakeBrain('second');
    const handle = new BrainHandle(first);

    expect((await handle.chat(messages)).endpoint).toBe('first');
    handle.swap(second);

    expect((await handle.chat(messages)).endpoint).toBe('second');
    expect(first.chat).toHaveBeenCalledTimes(1);
    // Consumers that captured the previous brain directly keep working.
    expect((await first.chat(messages)).endpoint).toBe('first');
  });

  it('delegates snapshot() to the current pool and follows swaps', () => {
    const first = fakeBrain('first');
    const second = fakeBrain('second');
    const handle = new BrainHandle(first);

    expect(handle.snapshot()).toEqual([{ name: 'first' }]);
    handle.swap(second);
    expect(handle.snapshot()).toEqual([{ name: 'second' }]);
    expect(second.snapshot).toHaveBeenCalledTimes(1);
  });
});

describe('BrainHandle.readiness', () => {
  it('reports all degraded when every flash-capable endpoint is in backoff', () => {
    const handle = handleWithSnapshot([
      snapshotEntry({ name: 'flash-a', tier: 'flash', degraded: true, remainingBackoffMs: 5_000 }),
      snapshotEntry({ name: 'both-b', tier: 'both', degraded: true, remainingBackoffMs: 1_000 }),
      snapshotEntry({ name: 'pro-c', tier: 'pro' }),
    ]);

    expect(handle.readiness()).toEqual({ allDegraded: true });
  });

  it('stays ready while one flash-capable endpoint is usable', () => {
    const handle = handleWithSnapshot([
      snapshotEntry({ name: 'flash-a', tier: 'flash', degraded: true, remainingBackoffMs: 5_000 }),
      snapshotEntry({ name: 'both-b', tier: 'both' }),
      snapshotEntry({ name: 'pro-c', tier: 'pro', degraded: true, remainingBackoffMs: 9_000 }),
    ]);

    expect(handle.readiness()).toEqual({ allDegraded: false });
  });

  it('is all degraded when only pro endpoints are healthy while flash ones are down', () => {
    const handle = handleWithSnapshot([
      snapshotEntry({ name: 'flash-a', tier: 'flash', degraded: true, remainingBackoffMs: 5_000 }),
      snapshotEntry({ name: 'pro-c', tier: 'pro' }),
    ]);

    expect(handle.readiness()).toEqual({ allDegraded: true });
  });

  it('falls back to every enabled endpoint when no endpoint serves flash', () => {
    const handle = handleWithSnapshot([
      snapshotEntry({ name: 'pro-a', tier: 'pro' }),
      snapshotEntry({ name: 'pro-b', tier: 'pro', degraded: true, remainingBackoffMs: 1_000 }),
    ]);

    expect(handle.readiness()).toEqual({ allDegraded: false });
  });

  it('ignores disabled endpoints and treats an empty enabled set as ready', () => {
    const disabled = handleWithSnapshot([
      snapshotEntry({ name: 'flash-a', tier: 'flash', enabled: false, degraded: true, remainingBackoffMs: 5_000 }),
    ]);
    expect(disabled.readiness()).toEqual({ allDegraded: false });
  });
});

describe('ConfigStore hot reload wiring', () => {
  it('swaps exactly once per successful save', async () => {
    const dir = await makeDir();
    await writeFile(
      path.join(dir, CONFIG_FILE),
      `${JSON.stringify(configWith([endpoint()]), null, 2)}\n`,
      'utf8',
    );

    const brains: Brain[] = [];
    let handle: BrainHandle | null = null;
    let swaps = 0;
    const store = await makeLoadedStore(dir, {
      build: (config) => {
        const brain = fakeBrain(`brain-${brains.length}`);
        brains.push(brain);
        return { ok: true, pool: new EndpointPool(config.endpoints), brain };
      },
      onChange: (change) => {
        swaps += 1;
        handle?.swap(change.brain);
      },
    });

    expect((await store.load()).ok).toBe(true);
    handle = new BrainHandle(brains[0]!);

    const saved = await store.save(configWith([endpoint({ flashModel: 'flash-b' })]));
    expect(saved).toEqual({ ok: true });

    // A save runs the builder for the staged backup and then for the candidate;
    // the last build is the one committed, and exactly one onChange fires.
    expect(swaps).toBe(1);
    expect((await handle.chat(messages)).endpoint).toBe(`brain-${brains.length - 1}`);
  });

  it('does not swap when the candidate config is invalid', async () => {
    const dir = await makeDir();
    await writeFile(
      path.join(dir, CONFIG_FILE),
      `${JSON.stringify(configWith([endpoint()]), null, 2)}\n`,
      'utf8',
    );

    const brains: Brain[] = [];
    let handle: BrainHandle | null = null;
    let swaps = 0;
    const store = await makeLoadedStore(dir, {
      build: (config) => {
        const brain = fakeBrain(`brain-${brains.length}`);
        brains.push(brain);
        return { ok: true, pool: new EndpointPool(config.endpoints), brain };
      },
      onChange: (change) => {
        swaps += 1;
        handle?.swap(change.brain);
      },
    });

    expect((await store.load()).ok).toBe(true);
    handle = new BrainHandle(brains[0]!);

    const saved = await store.save({ version: 1, importedFromEnv: false, endpoints: [] });
    expect(saved.ok).toBe(false);
    expect(swaps).toBe(0);
    expect((await handle.chat(messages)).endpoint).toBe('brain-0');
  });
});

describe('build closure health migration', () => {
  it('keeps a degraded endpoint degraded across a save', async () => {
    const dir = await makeDir();
    await writeFile(
      path.join(dir, CONFIG_FILE),
      `${JSON.stringify(configWith([endpoint()]), null, 2)}\n`,
      'utf8',
    );

    const builder = createBrainBuilder({ timeoutMs: 1_000 });
    const store = await makeLoadedStore(dir, {
      build: builder.build,
      onCommit: (change) => builder.commit(change.pool),
    });
    expect((await store.load()).ok).toBe(true);

    const first = builder.latest();
    expect(first).not.toBeNull();
    first!.pool.reportFailure('nim-1', { kind: 'rate_limit', status: 429 });
    const before = first!.pool.snapshot()[0];
    expect(before?.degraded).toBe(true);

    expect(await store.save(configWith([endpoint({ flashModel: 'flash-b' })]))).toEqual({
      ok: true,
    });

    const next = builder.latest();
    expect(next?.pool).not.toBe(first!.pool);
    const after = next!.pool.snapshot()[0];
    expect(after?.failures).toBe(1);
    expect(after?.remainingBackoffMs).toBeGreaterThan(0);
    expect(after?.lastError).toMatchObject({ kind: 'rate_limit', status: 429 });
  });

  it('resets health when an endpoint key or origin changes', async () => {
    const dir = await makeDir();
    await writeFile(
      path.join(dir, CONFIG_FILE),
      `${JSON.stringify(configWith([endpoint()]), null, 2)}\n`,
      'utf8',
    );

    const builder = createBrainBuilder({ timeoutMs: 1_000 });
    const store = await makeLoadedStore(dir, {
      build: builder.build,
      onCommit: (change) => builder.commit(change.pool),
    });
    await store.load();
    builder.latest()!.pool.reportFailure('nim-1', { kind: 'rate_limit', status: 429 });

    expect(
      await store.save(configWith([endpoint({ apiKey: 'rotated-key-0123456789' })])),
    ).toEqual({ ok: true });

    const after = builder.latest()!.pool.snapshot()[0];
    expect(after?.failures).toBe(0);
    expect(after?.degraded).toBe(false);
  });

  it('starts from a valid models.json with no endpoint keys in the environment', async () => {
    const dir = await makeDir();
    await writeFile(
      path.join(dir, CONFIG_FILE),
      `${JSON.stringify(configWith([endpoint()]), null, 2)}\n`,
      'utf8',
    );

    const builder = createBrainBuilder({ timeoutMs: 1_000 });
    const store = await makeLoadedStore(dir, {
      build: builder.build,
      onCommit: (change) => builder.commit(change.pool),
    });

    expect(await store.load()).toEqual({ ok: true, config: expect.objectContaining({}) });
    const built = builder.latest();
    expect(built).not.toBeNull();

    const handle = new BrainHandle(built!.brain);
    expect(handle.snapshot()).toEqual([
      expect.objectContaining({ name: 'nim-1', provider: 'nvidia_nim', degraded: false }),
    ]);
  });

  it('does not advance the migration source for a save whose write fails', async () => {
    const dir = await makeDir();
    await writeFile(
      path.join(dir, CONFIG_FILE),
      `${JSON.stringify(configWith([endpoint()]), null, 2)}\n`,
      'utf8',
    );

    const builder = createBrainBuilder({ timeoutMs: 1_000 });
    let failWrites = false;
    const store = await makeLoadedStore(dir, {
      build: builder.build,
      onCommit: (change) => builder.commit(change.pool),
      atomicWrite: async () => {
        if (failWrites) throw new Error('simulated disk failure');
      },
    });
    expect((await store.load()).ok).toBe(true);

    // The pool that is actually serving requests (committed by the load).
    const serving = builder.latest()!.pool;
    serving.reportFailure('nim-1', { kind: 'rate_limit', status: 429 });

    failWrites = true;
    expect(await store.save(configWith([endpoint({ flashModel: 'flash-failed' })]))).toEqual({
      ok: false,
      code: 'write_failed',
    });

    // The serving pool keeps serving and reports another failure after the failed
    // save. A later successful save must migrate from THIS pool, not from the
    // candidate that was built for the failed write.
    serving.reportFailure('nim-1', { kind: 'rate_limit', status: 429 });
    failWrites = false;
    expect(await store.save(configWith([endpoint({ flashModel: 'flash-next' })]))).toEqual({
      ok: true,
    });

    const after = builder.latest()!.pool.snapshot()[0];
    expect(after?.failures).toBe(2);
    expect(after?.lastError).toMatchObject({ kind: 'rate_limit', status: 429 });
  });

  it('does not advance the migration source for a build-only dry run', async () => {
    const dir = await makeDir();
    await writeFile(
      path.join(dir, CONFIG_FILE),
      `${JSON.stringify(configWith([endpoint()]), null, 2)}\n`,
      'utf8',
    );

    const builder = createBrainBuilder({ timeoutMs: 1_000 });
    const store = await makeLoadedStore(dir, {
      build: builder.build,
      onCommit: (change) => builder.commit(change.pool),
    });
    expect((await store.load()).ok).toBe(true);

    const serving = builder.latest()!.pool;
    // A dry run (like stageBuildableFile) must not become the next migration source.
    expect(
      builder.build(configWith([endpoint({ flashModel: 'dry-run' })]) as ModelsConfig).ok,
    ).toBe(true);
    serving.reportFailure('nim-1', { kind: 'rate_limit', status: 429 });

    expect(await store.save(configWith([endpoint({ flashModel: 'flash-next' })]))).toEqual({
      ok: true,
    });

    const after = builder.latest()!.pool.snapshot()[0];
    expect(after?.failures).toBe(1);
    expect(after?.lastError).toMatchObject({ kind: 'rate_limit', status: 429 });
  });
});
