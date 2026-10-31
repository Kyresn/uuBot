import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseHarnessConfig,
  type HarnessConfig,
} from '../../src/config/harness-schema.js';
import {
  HarnessStore,
  type HarnessBuildResult,
  type HarnessStoreOptions,
} from '../../src/config/harness-store.js';

const CONFIG_FILE = 'harness.json';
const BAK_FILE = 'harness.json.bak';

function defaultConfig(): HarnessConfig {
  const parsed = parseHarnessConfig({ version: 1 });
  if (!parsed.ok) throw new Error(`default harness config must parse: ${parsed.code}`);
  return parsed.value;
}

function configWithFastMs(fastMs: number): HarnessConfig {
  const config = defaultConfig();
  return { ...config, tick: { ...config.tick, fastMs } };
}

function withToken(config: HarnessConfig, wsToken: string): HarnessConfig {
  return { ...config, qq: { ...config.qq, wsToken } };
}

function makeBuild(): {
  build: (cfg: HarnessConfig) => HarnessBuildResult;
  calls: HarnessConfig[];
  failWith: (code: string | null) => void;
} {
  const calls: HarnessConfig[] = [];
  let failure: string | null = null;
  return {
    calls,
    failWith: (code: string | null) => {
      failure = code;
    },
    build: (cfg: HarnessConfig): HarnessBuildResult => {
      calls.push(cfg);
      if (failure !== null) return { ok: false, code: failure };
      return { ok: true };
    },
  };
}

const dirs: string[] = [];
const stores: HarnessStore[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'uuharness-harness-'));
  dirs.push(dir);
  return dir;
}

function makeStore(
  dir: string,
  overrides: Partial<HarnessStoreOptions> = {},
): {
  store: HarnessStore;
  logs: string[];
  changes: HarnessConfig[];
  builder: ReturnType<typeof makeBuild>;
} {
  const logs: string[] = [];
  const changes: HarnessConfig[] = [];
  const builder = makeBuild();
  const store = new HarnessStore({
    configDir: dir,
    env: {},
    log: (line: string) => logs.push(line),
    build: builder.build,
    onChange: (config: HarnessConfig) => changes.push(config),
    ...overrides,
  });
  stores.push(store);
  return { store, logs, changes, builder };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await sleep(25);
  }
}

function writeConfig(dir: string, value: unknown): Promise<void> {
  return writeFile(path.join(dir, CONFIG_FILE), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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

describe('HarnessStore load', () => {
  it('starts empty before load', async () => {
    const dir = await makeDir();
    const { store } = makeStore(dir);
    expect(store.get()).toBeNull();
    expect(store.getMasked()).toBeNull();
  });

  it('imports the environment once when harness.json is missing', async () => {
    const dir = await makeDir();
    const { store, logs, builder } = makeStore(dir, {
      env: {
        TICK_FAST_MS: '60000',
        QQ_WS_TOKEN: 'imported-token-0123456789',
        QQ_OWNER_ID: '42',
      },
    });

    const result = await store.load();
    expect(result.ok).toBe(true);
    const config = store.get();
    expect(config?.importedFromEnv).toBe(true);
    expect(config?.tick.fastMs).toBe(60_000);
    expect(config?.qq.wsToken).toBe('imported-token-0123456789');
    expect(config?.qq.ownerId).toBe('42');
    expect(builder.calls).toHaveLength(1);
    expect(logs.some((line) => line.includes('imported'))).toBe(true);

    const written = JSON.parse(await readFile(path.join(dir, CONFIG_FILE), 'utf8')) as HarnessConfig;
    expect(written.importedFromEnv).toBe(true);
    expect(written.tick.fastMs).toBe(60_000);
  });

  it('loads an existing valid harness.json without importing env', async () => {
    const dir = await makeDir();
    const stored = { ...defaultConfig(), importedFromEnv: false };
    await writeConfig(dir, { ...stored, tick: { ...stored.tick, fastMs: 2_000 } });
    const { store, logs } = makeStore(dir, { env: { TICK_FAST_MS: '60000' } });

    expect((await store.load()).ok).toBe(true);
    expect(store.get()?.tick.fastMs).toBe(2_000);
    expect(store.get()?.importedFromEnv).toBe(false);
    expect(logs.some((line) => line.includes('imported'))).toBe(false);
  });

  it('falls back to harness.json.bak and leaves both files untouched', async () => {
    const dir = await makeDir();
    const invalidText = '{ not valid json';
    const backup = { ...defaultConfig(), tick: { ...defaultConfig().tick, fastMs: 2_500 } };
    const bakText = `${JSON.stringify(backup, null, 2)}\n`;
    await writeFile(path.join(dir, CONFIG_FILE), invalidText, 'utf8');
    await writeFile(path.join(dir, BAK_FILE), bakText, 'utf8');
    const { store, logs } = makeStore(dir);

    expect((await store.load()).ok).toBe(true);
    expect(store.get()?.tick.fastMs).toBe(2_500);
    expect(await readFile(path.join(dir, CONFIG_FILE), 'utf8')).toBe(invalidText);
    expect(await readFile(path.join(dir, BAK_FILE), 'utf8')).toBe(bakText);
    expect(logs.some((line) => line.includes('harness.json.bak'))).toBe(true);
  });

  it('imports from env when both files are invalid', async () => {
    const dir = await makeDir();
    await writeFile(path.join(dir, CONFIG_FILE), '{"version":2}', 'utf8');
    await writeFile(path.join(dir, BAK_FILE), 'still not json', 'utf8');
    const { store } = makeStore(dir, { env: { HTTP_TIMEOUT_MS: '45000' } });

    expect((await store.load()).ok).toBe(true);
    expect(store.get()?.importedFromEnv).toBe(true);
    expect(store.get()?.http.timeoutMs).toBe(45_000);
    expect(await readFile(path.join(dir, BAK_FILE), 'utf8')).toBe('still not json');
  });

  it('fails with the build code when the dry run rejects the imported config', async () => {
    const dir = await makeDir();
    const { store, builder } = makeStore(dir);
    builder.failWith('build_failed');

    expect(await store.load()).toEqual({ ok: false, code: 'build_failed' });
    expect(store.get()).toBeNull();
    expect(await exists(path.join(dir, CONFIG_FILE))).toBe(false);
  });
});

describe('HarnessStore save pipeline', () => {
  it('writes atomically, copies the previous version to .bak and notifies onChange', async () => {
    const dir = await makeDir();
    const initial = configWithFastMs(3_000);
    await writeConfig(dir, initial);
    const initialBytes = await readFile(path.join(dir, CONFIG_FILE), 'utf8');
    const { store, changes } = makeStore(dir);
    await store.load();

    const result = await store.save(configWithFastMs(4_000));
    expect(result).toEqual({ ok: true });

    const written = JSON.parse(await readFile(path.join(dir, CONFIG_FILE), 'utf8')) as HarnessConfig;
    expect(written.tick.fastMs).toBe(4_000);
    expect(await readFile(path.join(dir, BAK_FILE), 'utf8')).toBe(initialBytes);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.tick.fastMs).toBe(4_000);
  });

  it('leaves the disk byte-for-byte unchanged when the dry-run build fails', async () => {
    const dir = await makeDir();
    await writeConfig(dir, configWithFastMs(3_000));
    const before = await readFile(path.join(dir, CONFIG_FILE));
    const { store, builder, changes } = makeStore(dir);
    await store.load();
    builder.failWith('dry_run_failed');

    const result = await store.save(configWithFastMs(4_000));
    expect(result).toEqual({ ok: false, code: 'dry_run_failed' });
    expect(await readFile(path.join(dir, CONFIG_FILE))).toEqual(before);
    expect(await exists(path.join(dir, BAK_FILE))).toBe(false);
    expect(changes).toHaveLength(0);
  });

  it.each(['tok…abcd', 'tok••••abcd', 'tok***abcd'])(
    'rejects a masked wsToken (%s) without writing',
    async (masked) => {
      const dir = await makeDir();
      const initial = withToken(configWithFastMs(3_000), 'real-token-0123456789');
      await writeConfig(dir, initial);
      const before = await readFile(path.join(dir, CONFIG_FILE));
      const { store, changes } = makeStore(dir);
      await store.load();

      const candidate = { ...initial, qq: { ...initial.qq, wsToken: masked } };
      expect(await store.save(candidate)).toEqual({
        ok: false,
        code: 'invalid_field',
        field: 'qq.wsToken',
      });
      expect(await readFile(path.join(dir, CONFIG_FILE))).toEqual(before);
      expect(changes).toHaveLength(0);
    },
  );

  it('keeps the stored token on a GET -> PUT round trip', async () => {
    const dir = await makeDir();
    const secret = 'super-secret-token-0123456789';
    await writeConfig(dir, withToken(defaultConfig(), secret));
    const { store } = makeStore(dir);
    await store.load();

    const masked = store.getMasked() as {
      qq: Record<string, unknown> & { hasWsToken: boolean; wsTokenLast4?: string };
    };
    expect(masked.qq.hasWsToken).toBe(true);
    expect(masked.qq.wsTokenLast4).toBe('6789');
    expect(masked.qq).not.toHaveProperty('wsToken');

    expect(await store.save(masked)).toEqual({ ok: true });
    const written = JSON.parse(await readFile(path.join(dir, CONFIG_FILE), 'utf8')) as HarnessConfig;
    expect(written.qq.wsToken).toBe(secret);
  });

  it('clears the token when wsToken is null', async () => {
    const dir = await makeDir();
    await writeConfig(dir, withToken(defaultConfig(), 'super-secret-token-0123456789'));
    const { store } = makeStore(dir);
    await store.load();

    const candidate = { ...defaultConfig(), qq: { ...defaultConfig().qq, wsToken: null } };
    expect(await store.save(candidate)).toEqual({ ok: true });
    const written = JSON.parse(await readFile(path.join(dir, CONFIG_FILE), 'utf8')) as HarnessConfig;
    expect(written.qq.wsToken).toBe('');
  });

  it('replaces the token when a fresh string is supplied', async () => {
    const dir = await makeDir();
    await writeConfig(dir, withToken(defaultConfig(), 'old-token-0123456789'));
    const { store } = makeStore(dir);
    await store.load();

    expect(
      await store.save(withToken(defaultConfig(), 'new-token-0123456789')),
    ).toEqual({ ok: true });
    const written = JSON.parse(await readFile(path.join(dir, CONFIG_FILE), 'utf8')) as HarnessConfig;
    expect(written.qq.wsToken).toBe('new-token-0123456789');
  });

  it('rejects unknown top-level keys and unsupported versions without writing', async () => {
    const dir = await makeDir();
    await writeConfig(dir, defaultConfig());
    const before = await readFile(path.join(dir, CONFIG_FILE));
    const { store } = makeStore(dir);
    await store.load();

    expect(await store.save({ ...defaultConfig(), extra: true })).toEqual({
      ok: false,
      code: 'invalid_field',
      field: 'extra',
    });
    expect(await store.save({ ...defaultConfig(), version: 2 })).toEqual({
      ok: false,
      code: 'unsupported_version',
      field: 'version',
    });
    expect(await readFile(path.join(dir, CONFIG_FILE))).toEqual(before);
  });

  it('rejects out-of-range values without writing', async () => {
    const dir = await makeDir();
    await writeConfig(dir, defaultConfig());
    const before = await readFile(path.join(dir, CONFIG_FILE));
    const { store } = makeStore(dir);
    await store.load();

    expect(
      await store.save({
        ...defaultConfig(),
        tick: { fastMs: 999, slowMs: 3_600_000, wakeDebounceMs: 2_000 },
      }),
    ).toEqual({ ok: false, code: 'invalid_field', field: 'tick.fastMs' });
    expect(await readFile(path.join(dir, CONFIG_FILE))).toEqual(before);
  });

  it('rejects __proto__ payloads without polluting prototypes', async () => {
    const dir = await makeDir();
    await writeConfig(dir, defaultConfig());
    const { store } = makeStore(dir);
    await store.load();

    const payload = JSON.parse('{"version":1,"__proto__":{"polluted":true}}') as unknown;
    expect(await store.save(payload)).toMatchObject({ ok: false, code: 'invalid_field' });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('does not overwrite a valid backup with an invalid primary file', async () => {
    const dir = await makeDir();
    const bakText = `${JSON.stringify(configWithFastMs(2_000), null, 2)}\n`;
    await writeFile(path.join(dir, CONFIG_FILE), '{ broken', 'utf8');
    await writeFile(path.join(dir, BAK_FILE), bakText, 'utf8');
    const { store } = makeStore(dir);
    await store.load();

    expect(await store.save(configWithFastMs(5_000))).toEqual({ ok: true });
    expect(await readFile(path.join(dir, BAK_FILE), 'utf8')).toBe(bakText);
  });

  it('leaves the backup untouched when the primary write fails', async () => {
    const dir = await makeDir();
    const bakText = `${JSON.stringify(configWithFastMs(2_000), null, 2)}\n`;
    await writeConfig(dir, configWithFastMs(3_000));
    await writeFile(path.join(dir, BAK_FILE), bakText, 'utf8');
    const { store, changes } = makeStore(dir);
    await store.load();

    // A directory at the config path makes the primary rename fail after staging.
    await rm(path.join(dir, CONFIG_FILE), { force: true });
    await mkdir(path.join(dir, CONFIG_FILE));

    expect(await store.save(configWithFastMs(5_000))).toEqual({
      ok: false,
      code: 'write_failed',
    });
    expect(await readFile(path.join(dir, BAK_FILE), 'utf8')).toBe(bakText);
    expect(changes).toHaveLength(0);
  });

  it('serializes concurrent saves so each backup is the previous committed version', async () => {
    const dir = await makeDir();
    await writeConfig(dir, configWithFastMs(3_000));
    const { store, changes } = makeStore(dir);
    await store.load();

    const [first, second] = await Promise.all([
      store.save(configWithFastMs(4_000)),
      store.save(configWithFastMs(5_000)),
    ]);
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });

    const primary = JSON.parse(await readFile(path.join(dir, CONFIG_FILE), 'utf8')) as HarnessConfig;
    const backup = JSON.parse(await readFile(path.join(dir, BAK_FILE), 'utf8')) as HarnessConfig;
    expect(primary.tick.fastMs).toBe(5_000);
    expect(backup.tick.fastMs).toBe(4_000);
    expect(changes.map((config) => config.tick.fastMs)).toEqual([4_000, 5_000]);
  });

  it.skipIf(process.platform === 'win32')(
    'writes harness.json and harness.json.bak with 0600 permissions',
    async () => {
      const dir = await makeDir();
      await writeConfig(dir, configWithFastMs(3_000));
      const { store } = makeStore(dir);
      await store.load();

      expect(await store.save(configWithFastMs(4_000))).toEqual({ ok: true });
      expect((await stat(path.join(dir, CONFIG_FILE))).mode & 0o777).toBe(0o600);
      expect((await stat(path.join(dir, BAK_FILE))).mode & 0o777).toBe(0o600);
    },
  );
});

describe('HarnessStore watcher', () => {
  it('reloads external changes once and notifies onChange', async () => {
    const dir = await makeDir();
    await writeConfig(dir, configWithFastMs(3_000));
    const { store, changes } = makeStore(dir);
    await store.load();
    store.watch();

    await writeConfig(dir, configWithFastMs(4_000));
    await waitFor(() => changes.length >= 1);

    expect(store.get()?.tick.fastMs).toBe(4_000);
    await sleep(400);
    expect(changes).toHaveLength(1);
  });

  it('keeps the previous config when an external file is invalid', async () => {
    const dir = await makeDir();
    await writeConfig(dir, configWithFastMs(3_000));
    const { store, changes, logs } = makeStore(dir);
    await store.load();
    store.watch();

    await writeFile(path.join(dir, CONFIG_FILE), '{ definitely not json', 'utf8');
    await waitFor(() => logs.some((line) => line.includes('rejected')));
    await sleep(300);

    expect(store.get()?.tick.fastMs).toBe(3_000);
    expect(changes).toHaveLength(0);
  });

  it('suppresses the watcher event caused by its own save', async () => {
    const dir = await makeDir();
    await writeConfig(dir, configWithFastMs(3_000));
    const { store, changes } = makeStore(dir);
    await store.load();
    store.watch();

    expect(await store.save(configWithFastMs(4_000))).toEqual({ ok: true });
    await sleep(600);
    expect(changes).toHaveLength(1);
    expect(store.get()?.tick.fastMs).toBe(4_000);
  });

  it('does not absorb an external edit that lands during the save write', async () => {
    const dir = await makeDir();
    await writeConfig(dir, configWithFastMs(3_000));
    const external = configWithFastMs(12_000);
    // 模拟外部编辑器在 rename 之后、旧实现 refreshSignature 之前写入：
    // 旧实现会把外部内容读成 lastSignature，poll 从此认为文件没变。
    const { store, changes } = makeStore(dir, {
      atomicWrite: async (target, contents) => {
        await writeFile(target, contents, 'utf8');
        await writeFile(target, `${JSON.stringify(external, null, 2)}\n`, 'utf8');
      },
    });
    await store.load();
    store.watch();

    expect(await store.save(configWithFastMs(4_000))).toEqual({ ok: true });
    await waitFor(() => changes.some((config) => config.tick.fastMs === 12_000));

    // 内存最终与磁盘一致：外部编辑没有被写入签名吞掉。
    expect(store.get()?.tick.fastMs).toBe(12_000);
  });

  it('is idempotent when watch() is called twice', async () => {
    const dir = await makeDir();
    const { store } = makeStore(dir);
    // A missing directory makes fs.watch throw, which used to leave `watcher` null
    // and let a second watch() install a second polling interval.
    await rm(dir, { recursive: true, force: true });

    const spy = vi.spyOn(globalThis, 'setInterval');
    try {
      store.watch();
      store.watch();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('stops watching after close', async () => {
    const dir = await makeDir();
    await writeConfig(dir, configWithFastMs(3_000));
    const { store, changes } = makeStore(dir);
    await store.load();
    store.watch();
    await store.close();

    await writeConfig(dir, configWithFastMs(4_000));
    await sleep(1_400);
    expect(changes).toHaveLength(0);
  });
});
