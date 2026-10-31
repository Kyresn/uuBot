import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EndpointPool } from '../src/brain/endpoints.js';
import { Brain } from '../src/brain/brain.js';
import {
  ConfigStore,
  type ConfigChange,
  type ConfigStoreOptions,
} from '../src/config/store.js';
import {
  maskKey,
  parseModelsConfig,
  type ModelsConfig,
  type ModelsEndpoint,
} from '../src/config/models-schema.js';

const CONFIG_FILE = 'models.json';
const BAK_FILE = 'models.json.bak';

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

type BuildOutcome = { ok: true; pool: EndpointPool; brain: Brain } | { ok: false; code: string };

function makeBuild(): {
  build: (cfg: ModelsConfig) => BuildOutcome;
  calls: ModelsConfig[];
  failWith: (code: string | null) => void;
  failOnceWith: (code: string) => void;
  failForModel: (model: string) => void;
} {
  const calls: ModelsConfig[] = [];
  let failure: string | null = null;
  let failureOnce: string | null = null;
  let failureModel: string | null = null;
  return {
    calls,
    failWith: (code: string | null) => {
      failure = code;
    },
    failOnceWith: (code: string) => {
      failureOnce = code;
    },
    failForModel: (model: string) => {
      failureModel = model;
    },
    build: (cfg: ModelsConfig): BuildOutcome => {
      calls.push(cfg);
      if (failure !== null) return { ok: false, code: failure };
      if (failureOnce !== null) {
        const code = failureOnce;
        failureOnce = null;
        return { ok: false, code };
      }
      if (failureModel !== null && cfg.endpoints[0]?.flashModel === failureModel) {
        return { ok: false, code: 'build_failed' };
      }
      const pool = new EndpointPool(cfg.endpoints);
      return { ok: true, pool, brain: new Brain(pool, { timeoutMs: 1_000 }) };
    },
  };
}

const dirs: string[] = [];
const stores: ConfigStore[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'uuharness-models-'));
  dirs.push(dir);
  return dir;
}

function makeStore(
  dir: string,
  overrides: Partial<ConfigStoreOptions> = {},
): {
  store: ConfigStore;
  logs: string[];
  changes: ConfigChange[];
  builder: ReturnType<typeof makeBuild>;
} {
  const logs: string[] = [];
  const changes: ConfigChange[] = [];
  const builder = makeBuild();
  const store = new ConfigStore({
    configDir: dir,
    env: {},
    log: (line: string) => logs.push(line),
    build: builder.build,
    onChange: (change: ConfigChange) => changes.push(change),
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

function endpointWithoutKey(overrides: Partial<ModelsEndpoint> = {}): Record<string, unknown> {
  const full = endpoint(overrides);
  const { apiKey: _apiKey, ...rest } = full;
  return rest;
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

describe('maskKey', () => {
  it('reports a long key with its last four characters', () => {
    expect(maskKey('abcdefghijklmnop')).toEqual({ hasApiKey: true, keyLast4: 'mnop' });
  });

  it('gives last4 at exactly 12 characters', () => {
    expect(maskKey('abcdefghijkl')).toEqual({ hasApiKey: true, keyLast4: 'ijkl' });
  });

  it('never exposes last4 for short keys', () => {
    const masked = maskKey('short-key');
    expect(masked).toEqual({ hasApiKey: true });
    expect(masked.keyLast4).toBeUndefined();
  });

  it('reports an empty key as absent', () => {
    expect(maskKey('')).toEqual({ hasApiKey: false });
  });
});

describe('parseModelsConfig', () => {
  it('accepts a complete config and returns brand-new objects', () => {
    const input = configWith([endpoint()]);
    const parsed = parseModelsConfig(input);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.version).toBe(1);
    expect(parsed.value.importedFromEnv).toBe(false);
    expect(parsed.value.endpoints[0]).toMatchObject({
      name: 'nim-1',
      provider: 'nvidia_nim',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      tier: 'both',
    });
    expect(parsed.value).not.toBe(input);
    expect(parsed.value.endpoints).not.toBe((input as { endpoints: unknown }).endpoints);
  });

  it('defaults optional endpoint fields', () => {
    const parsed = parseModelsConfig({
      version: 1,
      endpoints: [{ name: 'a', baseUrl: 'http://127.0.0.1:8080/v1', flashModel: 'f' }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.importedFromEnv).toBe(false);
    expect(parsed.value.endpoints[0]).toMatchObject({
      provider: 'unknown',
      apiKey: '',
      enabled: true,
      tier: 'both',
      proModel: 'f',
    });
  });

  it('rejects versions other than 1', () => {
    expect(parseModelsConfig({ version: 2, endpoints: [endpoint()] })).toMatchObject({
      ok: false,
      code: 'unsupported_version',
    });
  });

  it('rejects unknown top-level keys', () => {
    expect(parseModelsConfig({ ...(configWith([endpoint()]) as object), extra: true })).toEqual({
      ok: false,
      code: 'invalid_field',
      field: 'extra',
    });
  });

  it('rejects unknown endpoint keys', () => {
    const parsed = parseModelsConfig(configWith([{ ...endpoint(), surprise: 1 }]));
    expect(parsed).toEqual({
      ok: false,
      code: 'invalid_field',
      field: 'endpoints[0].surprise',
    });
  });

  it('rejects duplicate endpoint names', () => {
    const parsed = parseModelsConfig(configWith([endpoint(), endpoint()]));
    expect(parsed).toEqual({
      ok: false,
      code: 'invalid_field',
      field: 'endpoints[1].name',
    });
  });

  it('requires at least one endpoint', () => {
    expect(parseModelsConfig(configWith([]))).toEqual({
      ok: false,
      code: 'invalid_field',
      field: 'endpoints',
    });
  });

  it('requires a non-empty flash model', () => {
    expect(parseModelsConfig(configWith([{ ...endpoint(), flashModel: '' }]))).toMatchObject({
      ok: false,
      code: 'invalid_field',
      field: 'endpoints[0].flashModel',
    });
  });

  it('rejects invalid endpoint tiers', () => {
    expect(parseModelsConfig(configWith([{ ...endpoint(), tier: 'fast' }]))).toMatchObject({
      ok: false,
      code: 'invalid_field',
      field: 'endpoints[0].tier',
    });
  });

  it('accepts https base urls', () => {
    expect(
      parseModelsConfig(configWith([endpoint({ baseUrl: 'https://api.example.test/v1' })])).ok,
    ).toBe(true);
  });

  it('accepts http only for loopback hosts', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      const parsed = parseModelsConfig(
        configWith([endpoint({ baseUrl: `http://${host}:8080/v1` })]),
      );
      expect(parsed.ok).toBe(true);
    }
  });

  it('rejects plain http for remote hosts', () => {
    expect(parseModelsConfig(configWith([endpoint({ baseUrl: 'http://api.example.test/v1' })]))).toMatchObject({
      ok: false,
      code: 'invalid_field',
      field: 'endpoints[0].baseUrl',
    });
  });

  it('rejects urls with userinfo', () => {
    expect(
      parseModelsConfig(configWith([endpoint({ baseUrl: 'https://user:pass@api.example.test/v1' })])),
    ).toMatchObject({ ok: false, code: 'invalid_field', field: 'endpoints[0].baseUrl' });
  });

  it('rejects malformed urls', () => {
    expect(parseModelsConfig(configWith([endpoint({ baseUrl: 'not a url' })]))).toMatchObject({
      ok: false,
      code: 'invalid_field',
      field: 'endpoints[0].baseUrl',
    });
  });

  it('stores a normalized base url without surrounding whitespace', () => {
    const parsed = parseModelsConfig(
      configWith([endpoint({ baseUrl: '  https://API.example.test/v1  ' })]),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.endpoints[0]?.baseUrl).toBe('https://api.example.test/v1');
    expect(parsed.value.endpoints[0]?.baseUrl).not.toMatch(/\s/);
  });

  it('rejects base urls with a query or fragment', () => {
    for (const baseUrl of [
      'https://api.example.test/v1?token=leak',
      'https://api.example.test/v1#fragment',
    ]) {
      expect(parseModelsConfig(configWith([endpoint({ baseUrl })]))).toEqual({
        ok: false,
        code: 'invalid_field',
        field: 'endpoints[0].baseUrl',
      });
    }
  });

  it('requires a non-empty api key for non-loopback endpoints', () => {
    const expected = {
      ok: false,
      code: 'invalid_field',
      field: 'endpoints[0].apiKey',
    };
    expect(parseModelsConfig(configWith([endpoint({ apiKey: '' })]))).toEqual(expected);
    expect(parseModelsConfig(configWith([endpointWithoutKey()]))).toEqual(expected);
  });

  it('allows loopback endpoints to omit the api key', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      const parsed = parseModelsConfig(
        configWith([endpoint({ baseUrl: `http://${host}:8080/v1`, apiKey: '' })]),
      );
      expect(parsed.ok).toBe(true);
    }
  });

  it('rejects a config where every endpoint is disabled', () => {
    expect(parseModelsConfig(configWith([endpoint({ enabled: false })]))).toEqual({
      ok: false,
      code: 'invalid_field',
      field: 'endpoints',
    });
    expect(
      parseModelsConfig(
        configWith([endpoint({ enabled: false }), endpoint({ name: 'nim-2', enabled: true })]),
      ).ok,
    ).toBe(true);
  });

  it('ignores the read-only masked fields returned by GET', () => {
    const parsed = parseModelsConfig(
      configWith([{ ...endpoint(), hasApiKey: true, keyLast4: 'cdef' }]),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.endpoints[0]).not.toHaveProperty('hasApiKey');
    expect(parsed.value.endpoints[0]).not.toHaveProperty('keyLast4');
  });

  it('does not pollute prototypes through __proto__ or constructor keys', () => {
    const payload = JSON.parse(
      '{"version":1,"importedFromEnv":false,"endpoints":[{"name":"a","baseUrl":"https://example.test/v1","flashModel":"f","__proto__":{"polluted":true}}]}',
    );
    expect(parseModelsConfig(payload)).toMatchObject({ ok: false, code: 'invalid_field' });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();

    const topLevel = JSON.parse(
      '{"version":1,"importedFromEnv":false,"endpoints":[{"name":"a","baseUrl":"https://example.test/v1","flashModel":"f"}],"__proto__":{"polluted":true}}',
    );
    expect(parseModelsConfig(topLevel)).toMatchObject({ ok: false, code: 'invalid_field' });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();

    const ctor = JSON.parse(
      '{"version":1,"importedFromEnv":false,"endpoints":[{"name":"a","baseUrl":"https://example.test/v1","flashModel":"f","constructor":{"prototype":{"polluted":true}}}]}',
    );
    expect(parseModelsConfig(ctor)).toMatchObject({ ok: false, code: 'invalid_field' });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('validates optional service sections', () => {
    const parsed = parseModelsConfig({
      ...(configWith([endpoint()]) as object),
      embedding: {
        baseUrl: 'https://embed.example.test/v1',
        path: '/embeddings',
        model: 'embed-1',
        apiKey: 'embed-key-0123456789',
        enabled: true,
        maxDims: null,
      },
      tts: {
        baseUrl: 'http://127.0.0.1:9000/v1',
        path: '/audio/speech',
        model: 'tts-1',
        voice: 'alloy',
        format: 'mp3',
        apiKey: '',
        enabled: false,
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.embedding?.maxDims).toBeNull();
    expect(parsed.value.tts?.voice).toBe('alloy');
  });

  it('rejects unknown service keys', () => {
    expect(
      parseModelsConfig({
        ...(configWith([endpoint()]) as object),
        rerank: {
          baseUrl: 'https://rerank.example.test/v1',
          path: '/reranking',
          model: 'r',
          apiKey: '',
          enabled: true,
          surprise: 1,
        },
      }),
    ).toEqual({ ok: false, code: 'invalid_field', field: 'rerank.surprise' });
  });
});

describe('ConfigStore env import', () => {
  it('expands NIM keys and agnes endpoints from the environment', async () => {
    const dir = await makeDir();
    const { store } = makeStore(dir, {
      env: {
        NIM_API_KEYS: 'k1, k2 ,k3',
        AGNES_COM_API_KEY: 'ac',
        AGNES_CN_API_KEY: 'an',
        NIM_FLASH_MODEL: 'nf',
        NIM_PRO_MODEL: 'np',
        AGNES_FLASH_MODEL: 'af',
        AGNES_PRO_MODEL: 'ap',
      },
    });

    const result = await store.load();
    expect(result.ok).toBe(true);

    const cfg = store.get();
    expect(cfg?.importedFromEnv).toBe(true);
    expect(cfg?.endpoints.map((entry) => entry.name)).toEqual([
      'nim-1',
      'nim-2',
      'nim-3',
      'agnes_com',
      'agnes_cn',
    ]);
    expect(cfg?.endpoints.every((entry) => entry.tier === 'both')).toBe(true);
    expect(cfg?.endpoints[0]).toMatchObject({
      provider: 'nvidia_nim',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      apiKey: 'k1',
      flashModel: 'nf',
      proModel: 'np',
    });
    expect(cfg?.endpoints[3]).toMatchObject({
      provider: 'agnes',
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      apiKey: 'ac',
      flashModel: 'af',
      proModel: 'ap',
    });
    expect(cfg?.endpoints[4]).toMatchObject({ baseUrl: 'https://api.agnes-ai.cn/v1', apiKey: 'an' });

    const written = JSON.parse(await readFile(path.join(dir, CONFIG_FILE), 'utf8')) as ModelsConfig;
    expect(written.importedFromEnv).toBe(true);
    expect(written.endpoints).toHaveLength(5);
  });

  it('uses fallback model names when *_MODEL is unset', async () => {
    const dir = await makeDir();
    const { store } = makeStore(dir, { env: { NIM_API_KEYS: 'k1' } });
    const imported = store.applyEnvImport({ NIM_API_KEYS: 'k1' });
    expect(imported.endpoints[0]).toMatchObject({
      flashModel: 'deepseek-ai/deepseek-v4.1-flash',
      proModel: 'deepseek-ai/deepseek-v4.1-flash',
    });
  });

  it('fails with an actionable code when no config and no env keys exist', async () => {
    const dir = await makeDir();
    const { store } = makeStore(dir);
    expect(await store.load()).toEqual({ ok: false, code: 'no_config' });
    expect(await exists(path.join(dir, CONFIG_FILE))).toBe(false);
  });

  it('can save a first configuration after load returned no_config', async () => {
    // 网页主界面要求：裸装也能起网页，用户在「模型」页添加第一个端点。
    const dir = await makeDir();
    const { store, changes } = makeStore(dir);
    expect(await store.load()).toEqual({ ok: false, code: 'no_config' });

    expect(await store.save(configWith([endpoint()]))).toEqual({ ok: true });

    expect(store.get()?.endpoints).toHaveLength(1);
    expect(changes).toHaveLength(1);
    expect(await exists(path.join(dir, CONFIG_FILE))).toBe(true);
  });
});

describe('ConfigStore load order', () => {
  it('loads a valid models.json without touching the backup', async () => {
    const dir = await makeDir();
    await writeConfig(dir, configWith([endpoint({ flashModel: 'primary' })]));
    const { store } = makeStore(dir);

    expect((await store.load()).ok).toBe(true);
    expect(store.get()?.endpoints[0]?.flashModel).toBe('primary');
    expect(await exists(path.join(dir, BAK_FILE))).toBe(false);
  });

  it('falls back to models.json.bak and leaves both files untouched', async () => {
    const dir = await makeDir();
    const invalidText = '{ not valid json';
    const bakText = `${JSON.stringify(configWith([endpoint({ flashModel: 'backup' })]), null, 2)}\n`;
    await writeFile(path.join(dir, CONFIG_FILE), invalidText, 'utf8');
    await writeFile(path.join(dir, BAK_FILE), bakText, 'utf8');
    const { store, logs } = makeStore(dir);

    expect((await store.load()).ok).toBe(true);
    expect(store.get()?.endpoints[0]?.flashModel).toBe('backup');
    expect(await readFile(path.join(dir, CONFIG_FILE), 'utf8')).toBe(invalidText);
    expect(await readFile(path.join(dir, BAK_FILE), 'utf8')).toBe(bakText);
    expect(logs.some((line) => line.includes('models.json.bak'))).toBe(true);
  });

  it('imports from env when both the config and the backup are invalid', async () => {
    const dir = await makeDir();
    const bakText = 'still not json';
    await writeFile(path.join(dir, CONFIG_FILE), '{"version":2,"endpoints":[]}', 'utf8');
    await writeFile(path.join(dir, BAK_FILE), bakText, 'utf8');
    const { store } = makeStore(dir, { env: { NIM_API_KEYS: 'k1' } });

    expect((await store.load()).ok).toBe(true);
    expect(store.get()?.importedFromEnv).toBe(true);
    expect(await readFile(path.join(dir, BAK_FILE), 'utf8')).toBe(bakText);
    const written = JSON.parse(await readFile(path.join(dir, CONFIG_FILE), 'utf8')) as ModelsConfig;
    expect(written.importedFromEnv).toBe(true);
  });

  it('falls back to the backup when the primary file cannot be built', async () => {
    const dir = await makeDir();
    await writeConfig(dir, configWith([endpoint({ flashModel: 'primary' })]));
    await writeFile(
      path.join(dir, BAK_FILE),
      `${JSON.stringify(configWith([endpoint({ flashModel: 'backup' })]), null, 2)}\n`,
      'utf8',
    );
    const { store, builder, logs } = makeStore(dir);
    builder.failOnceWith('build_failed');

    expect((await store.load()).ok).toBe(true);
    expect(store.get()?.endpoints[0]?.flashModel).toBe('backup');
    expect(logs.some((line) => line.includes('models.json.bak'))).toBe(true);
  });
});

describe('ConfigStore save pipeline', () => {
  it('writes atomically, copies the previous version to .bak and notifies onChange', async () => {
    const dir = await makeDir();
    const first = configWith([endpoint({ flashModel: 'flash-a' })]);
    await writeConfig(dir, first);
    const firstBytes = await readFile(path.join(dir, CONFIG_FILE), 'utf8');
    const { store, changes } = makeStore(dir);
    await store.load();

    const result = await store.save(configWith([endpoint({ flashModel: 'flash-b' })]));
    expect(result).toEqual({ ok: true });

    const written = JSON.parse(await readFile(path.join(dir, CONFIG_FILE), 'utf8')) as ModelsConfig;
    expect(written.endpoints[0]?.flashModel).toBe('flash-b');
    expect(await readFile(path.join(dir, BAK_FILE), 'utf8')).toBe(firstBytes);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.config.endpoints[0]?.flashModel).toBe('flash-b');
    expect(changes[0]?.pool).toBeInstanceOf(EndpointPool);
    expect(changes[0]?.brain).toBeInstanceOf(Brain);
  });

  it('leaves the disk byte-for-byte unchanged when the dry-run build fails', async () => {
    const dir = await makeDir();
    await writeConfig(dir, configWith([endpoint({ flashModel: 'flash-a' })]));
    const before = await readFile(path.join(dir, CONFIG_FILE));
    const { store, builder, changes } = makeStore(dir);
    await store.load();
    builder.failWith('dry_run_failed');

    const result = await store.save(configWith([endpoint({ flashModel: 'flash-b' })]));
    expect(result).toEqual({ ok: false, code: 'dry_run_failed' });
    expect(await readFile(path.join(dir, CONFIG_FILE))).toEqual(before);
    expect(await exists(path.join(dir, BAK_FILE))).toBe(false);
    expect(changes).toHaveLength(0);
  });

  it.each(['sk-live-…abcd', 'sk-live-••••abcd', 'sk-live-***abcd'])(
    'rejects masked keys (%s) without writing',
    async (masked) => {
      const dir = await makeDir();
      await writeConfig(dir, configWith([endpoint()]));
      const before = await readFile(path.join(dir, CONFIG_FILE));
      const { store } = makeStore(dir);
      await store.load();

      expect(await store.save(configWith([endpoint({ apiKey: masked })]))).toEqual({
        ok: false,
        code: 'masked_key',
        field: 'endpoints[0].apiKey',
      });
      expect(await readFile(path.join(dir, CONFIG_FILE))).toEqual(before);
    },
  );

  it('keeps the stored key byte-for-byte on a GET → PUT round trip', async () => {
    const dir = await makeDir();
    await writeConfig(dir, configWith([endpoint({ apiKey: 'super-secret-key-0123456789' })]));
    const { store } = makeStore(dir);
    await store.load();

    const masked = store.getMasked() as {
      endpoints: Array<Record<string, unknown> & { hasApiKey: boolean; keyLast4?: string }>;
    };
    expect(masked.endpoints[0]?.hasApiKey).toBe(true);
    expect(masked.endpoints[0]?.keyLast4).toBe('6789');
    expect(masked.endpoints[0]).not.toHaveProperty('apiKey');

    const put = {
      version: 1,
      importedFromEnv: false,
      endpoints: masked.endpoints.map(({ hasApiKey: _h, keyLast4: _k, ...rest }) => rest),
    };
    expect(await store.save(put)).toEqual({ ok: true });

    const written = JSON.parse(await readFile(path.join(dir, CONFIG_FILE), 'utf8')) as ModelsConfig;
    expect(written.endpoints[0]?.apiKey).toBe('super-secret-key-0123456789');
  });

  it('requires a new key when the endpoint origin changes', async () => {
    const dir = await makeDir();
    await writeConfig(dir, configWith([endpoint()]));
    const before = await readFile(path.join(dir, CONFIG_FILE));
    const { store } = makeStore(dir);
    await store.load();

    const moved = configWith([
      endpointWithoutKey({ baseUrl: 'https://elsewhere.example.test/v1' }),
    ]);
    expect(await store.save(moved)).toEqual({
      ok: false,
      code: 'key_required_for_new_origin',
      field: 'endpoints[0].apiKey',
    });
    expect(await readFile(path.join(dir, CONFIG_FILE))).toEqual(before);
  });

  it('accepts an origin change with a fresh key', async () => {
    const dir = await makeDir();
    await writeConfig(dir, configWith([endpoint()]));
    const { store } = makeStore(dir);
    await store.load();

    expect(
      await store.save(
        configWith([
          endpoint({ baseUrl: 'https://elsewhere.example.test/v1', apiKey: 'new-key-0123456789' }),
        ]),
      ),
    ).toEqual({ ok: true });
    const written = JSON.parse(await readFile(path.join(dir, CONFIG_FILE), 'utf8')) as ModelsConfig;
    expect(written.endpoints[0]?.apiKey).toBe('new-key-0123456789');
  });

  it('keeps the stored key when only the path changes on the same origin', async () => {
    const dir = await makeDir();
    await writeConfig(dir, configWith([endpoint({ baseUrl: 'https://api.example.test/v1' })]));
    const { store } = makeStore(dir);
    await store.load();

    expect(
      await store.save(configWith([endpointWithoutKey({ baseUrl: 'https://api.example.test/v2' })])),
    ).toEqual({ ok: true });
    const written = JSON.parse(await readFile(path.join(dir, CONFIG_FILE), 'utf8')) as ModelsConfig;
    expect(written.endpoints[0]?.apiKey).toBe('key-0123456789abcdef');
    expect(written.endpoints[0]?.baseUrl).toBe('https://api.example.test/v2');
  });

  it('allows an origin change when the stored key is empty', async () => {
    const dir = await makeDir();
    await writeConfig(dir, configWith([endpoint({ baseUrl: 'http://127.0.0.1:8000/v1', apiKey: '' })]));
    const { store } = makeStore(dir);
    await store.load();

    expect(
      await store.save(
        configWith([endpointWithoutKey({ baseUrl: 'http://127.0.0.1:9000/v1' })]),
      ),
    ).toEqual({ ok: true });
  });

  it('clears the key when apiKey is null', async () => {
    const dir = await makeDir();
    await writeConfig(
      dir,
      configWith([
        endpoint({ baseUrl: 'http://127.0.0.1:8080/v1', apiKey: 'secret-0123456789' }),
      ]),
    );
    const { store } = makeStore(dir);
    await store.load();

    expect(await store.save(configWith([endpoint({ baseUrl: 'http://127.0.0.1:8080/v1', apiKey: null as unknown as string })]))).toEqual({
      ok: true,
    });
    const written = JSON.parse(await readFile(path.join(dir, CONFIG_FILE), 'utf8')) as ModelsConfig;
    expect(written.endpoints[0]?.apiKey).toBe('');
  });

  it('rejects clearing the key of a non-loopback endpoint', async () => {
    const dir = await makeDir();
    await writeConfig(dir, configWith([endpoint()]));
    const before = await readFile(path.join(dir, CONFIG_FILE));
    const { store } = makeStore(dir);
    await store.load();

    expect(await store.save(configWith([endpoint({ apiKey: null as unknown as string })]))).toEqual({
      ok: false,
      code: 'invalid_field',
      field: 'endpoints[0].apiKey',
    });
    expect(await readFile(path.join(dir, CONFIG_FILE))).toEqual(before);
  });

  it('stores a normalized base url so stray whitespace cannot break requests', async () => {
    const dir = await makeDir();
    await writeConfig(dir, configWith([endpoint({ baseUrl: 'https://api.example.test/v1' })]));
    const { store } = makeStore(dir);
    await store.load();

    expect(
      await store.save(configWith([endpoint({ baseUrl: '  https://API.example.test/v1  ' })])),
    ).toEqual({ ok: true });
    const written = JSON.parse(await readFile(path.join(dir, CONFIG_FILE), 'utf8')) as ModelsConfig;
    expect(written.endpoints[0]?.baseUrl).toBe('https://api.example.test/v1');
    expect(written.endpoints[0]?.baseUrl).not.toMatch(/\s/);
  });

  it('does not back up a primary file that fails the build dry run', async () => {
    const dir = await makeDir();
    const bakText = `${JSON.stringify(configWith([endpoint({ flashModel: 'older' })]), null, 2)}\n`;
    await writeConfig(dir, configWith([endpoint({ flashModel: 'primary' })]));
    await writeFile(path.join(dir, BAK_FILE), bakText, 'utf8');
    const { store, builder } = makeStore(dir);
    await store.load();
    // The file on disk parses but no longer builds; it must never replace the backup.
    builder.failForModel('primary');

    expect(await store.save(configWith([endpoint({ flashModel: 'next' })]))).toEqual({ ok: true });
    expect(await readFile(path.join(dir, BAK_FILE), 'utf8')).toBe(bakText);
  });

  it('leaves the backup untouched when the primary write fails', async () => {
    const dir = await makeDir();
    const bakText = `${JSON.stringify(configWith([endpoint({ flashModel: 'older' })]), null, 2)}\n`;
    await writeConfig(dir, configWith([endpoint({ flashModel: 'primary' })]));
    await writeFile(path.join(dir, BAK_FILE), bakText, 'utf8');
    const { store, changes } = makeStore(dir);
    await store.load();

    // A directory at the config path makes the primary rename fail after staging.
    await rm(path.join(dir, CONFIG_FILE), { force: true });
    await mkdir(path.join(dir, CONFIG_FILE));

    expect(await store.save(configWith([endpoint({ flashModel: 'next' })]))).toEqual({
      ok: false,
      code: 'write_failed',
    });
    expect(await readFile(path.join(dir, BAK_FILE), 'utf8')).toBe(bakText);
    expect(changes).toHaveLength(0);
  });

  it('serializes concurrent saves so each backup is the previous committed version', async () => {
    const dir = await makeDir();
    await writeConfig(dir, configWith([endpoint({ flashModel: 'flash-a' })]));
    const { store, changes } = makeStore(dir);
    await store.load();

    const [first, second] = await Promise.all([
      store.save(configWith([endpoint({ flashModel: 'flash-b' })])),
      store.save(configWith([endpoint({ flashModel: 'flash-c' })])),
    ]);
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });

    const primary = JSON.parse(await readFile(path.join(dir, CONFIG_FILE), 'utf8')) as ModelsConfig;
    const backup = JSON.parse(await readFile(path.join(dir, BAK_FILE), 'utf8')) as ModelsConfig;
    expect(primary.endpoints[0]?.flashModel).toBe('flash-c');
    expect(backup.endpoints[0]?.flashModel).toBe('flash-b');
    expect(changes.map((change) => change.config.endpoints[0]?.flashModel)).toEqual([
      'flash-b',
      'flash-c',
    ]);
  });

  it.skipIf(process.platform === 'win32')(
    'writes models.json and models.json.bak with 0600 permissions',
    async () => {
      const dir = await makeDir();
      await writeConfig(dir, configWith([endpoint({ flashModel: 'flash-a' })]));
      const { store } = makeStore(dir);
      await store.load();

      expect(await store.save(configWith([endpoint({ flashModel: 'flash-b' })]))).toEqual({
        ok: true,
      });
      expect((await stat(path.join(dir, CONFIG_FILE))).mode & 0o777).toBe(0o600);
      expect((await stat(path.join(dir, BAK_FILE))).mode & 0o777).toBe(0o600);
    },
  );

  it('rejects unknown top-level keys and unsupported versions', async () => {
    const dir = await makeDir();
    await writeConfig(dir, configWith([endpoint()]));
    const before = await readFile(path.join(dir, CONFIG_FILE));
    const { store } = makeStore(dir);
    await store.load();

    expect(
      await store.save({ ...(configWith([endpoint()]) as object), extra: true }),
    ).toEqual({ ok: false, code: 'invalid_field', field: 'extra' });
    expect(await store.save({ version: 2, endpoints: [endpoint()] })).toEqual({
      ok: false,
      code: 'unsupported_version',
      field: 'version',
    });
    expect(await readFile(path.join(dir, CONFIG_FILE))).toEqual(before);
  });

  it('rejects __proto__ payloads without polluting prototypes', async () => {
    const dir = await makeDir();
    await writeConfig(dir, configWith([endpoint()]));
    const { store } = makeStore(dir);
    await store.load();

    const payload = JSON.parse(
      '{"version":1,"importedFromEnv":false,"endpoints":[{"name":"nim-1","baseUrl":"https://integrate.api.nvidia.com/v1","flashModel":"f","__proto__":{"polluted":true}}]}',
    );
    expect(await store.save(payload)).toMatchObject({ ok: false, code: 'invalid_field' });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('does not overwrite a valid backup with an invalid primary file', async () => {
    const dir = await makeDir();
    const bakText = `${JSON.stringify(configWith([endpoint({ flashModel: 'backup' })]), null, 2)}\n`;
    await writeFile(path.join(dir, CONFIG_FILE), '{ broken', 'utf8');
    await writeFile(path.join(dir, BAK_FILE), bakText, 'utf8');
    const { store } = makeStore(dir);
    await store.load();

    expect(await store.save(configWith([endpoint({ flashModel: 'new' })]))).toEqual({ ok: true });
    expect(await readFile(path.join(dir, BAK_FILE), 'utf8')).toBe(bakText);
  });

  it('reports save failures without writing anything', async () => {
    const dir = await makeDir();
    await writeConfig(dir, configWith([endpoint()]));
    const { store } = makeStore(dir);
    await store.load();

    // An endpoint with no flash model is structurally invalid, so the parse stage fails.
    const result = await store.save(configWith([{ ...endpoint(), flashModel: '' }]));
    expect(result.ok).toBe(false);
    const written = JSON.parse(await readFile(path.join(dir, CONFIG_FILE), 'utf8')) as ModelsConfig;
    expect(written.endpoints[0]?.flashModel).toBe('flash-model');
  });
});

describe('ConfigStore watcher', () => {
  it('reloads external changes once and notifies onChange', async () => {
    const dir = await makeDir();
    await writeConfig(dir, configWith([endpoint({ flashModel: 'flash-a' })]));
    const { store, changes } = makeStore(dir);
    await store.load();
    store.watch();

    await writeConfig(dir, configWith([endpoint({ flashModel: 'flash-b-longer' })]));
    await waitFor(() => changes.length >= 1);

    expect(store.get()?.endpoints[0]?.flashModel).toBe('flash-b-longer');
    expect(changes[0]?.pool).toBeInstanceOf(EndpointPool);
    await sleep(400);
    expect(changes).toHaveLength(1);
  });

  it('keeps the previous config when an external file is invalid', async () => {
    const dir = await makeDir();
    await writeConfig(dir, configWith([endpoint({ flashModel: 'flash-a' })]));
    const { store, changes, logs } = makeStore(dir);
    await store.load();
    store.watch();

    await writeFile(path.join(dir, CONFIG_FILE), '{ definitely not json', 'utf8');
    await waitFor(() => logs.some((line) => line.includes('rejected')));
    await sleep(300);

    expect(store.get()?.endpoints[0]?.flashModel).toBe('flash-a');
    expect(changes).toHaveLength(0);
  });

  it('suppresses the watcher event caused by its own save', async () => {
    const dir = await makeDir();
    await writeConfig(dir, configWith([endpoint({ flashModel: 'flash-a' })]));
    const { store, changes } = makeStore(dir);
    await store.load();
    store.watch();

    expect(await store.save(configWith([endpoint({ flashModel: 'flash-b' })]))).toEqual({
      ok: true,
    });
    await sleep(600);
    expect(changes).toHaveLength(1);
    expect(store.get()?.endpoints[0]?.flashModel).toBe('flash-b');
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
    await writeConfig(dir, configWith([endpoint({ flashModel: 'flash-a' })]));
    const { store, changes } = makeStore(dir);
    await store.load();
    store.watch();
    await store.close();

    await writeConfig(dir, configWith([endpoint({ flashModel: 'flash-b-longer' })]));
    await sleep(1_400);
    expect(changes).toHaveLength(0);
  });
});

describe('store/schema follow-ups from the fix review', () => {
  it('stores a pathless baseUrl without a trailing slash', () => {
    const parsed = parseModelsConfig(
      configWith([endpoint({ baseUrl: 'http://127.0.0.1:8080' })]),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.endpoints[0]?.baseUrl).toBe('http://127.0.0.1:8080');
    }
  });

  it('keeps a real baseUrl path intact', () => {
    const parsed = parseModelsConfig(
      configWith([endpoint({ baseUrl: 'https://api.example.com/v1' })]),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.endpoints[0]?.baseUrl).toBe('https://api.example.com/v1');
    }
  });

  it('strips a trailing slash from a baseUrl that has a path', () => {
    const parsed = parseModelsConfig(
      configWith([endpoint({ baseUrl: 'https://api.example.com/v1/' })]),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.endpoints[0]?.baseUrl).toBe('https://api.example.com/v1');
    }
  });

  it('leaves the builder describing the committed config after a save', async () => {
    const dir = await makeDir();
    await writeConfig(dir, configWith([endpoint({ flashModel: 'flash-a' })]));
    const { store, builder } = makeStore(dir);
    await store.load();
    builder.calls.length = 0;

    const saved = configWith([endpoint({ flashModel: 'flash-b-longer' })]);
    const result = await store.save(saved);
    expect(result.ok).toBe(true);
    // The last build call must be the config that was just committed, not the
    // previous one (the production builder records `latest` for hot-swap).
    expect(builder.calls.at(-1)?.endpoints[0]?.flashModel).toBe('flash-b-longer');
  });
});
