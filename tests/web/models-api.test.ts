import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Brain } from '../../src/brain/brain.js';
import { EndpointPool } from '../../src/brain/endpoints.js';
import { ConfigStore, type ConfigChange } from '../../src/config/store.js';
import { createModelsApi, type FetchLike } from '../../src/web/models-api.js';
import { createWebServer, type WebServer } from '../../src/web/server.js';

const STRONG_TOKEN = '0123456789abcdef0123456789abcdef';
const SECRET = 'sk-live-secret-0123456789abcdef';
const EMBED_SECRET = 'sk-embed-secret-0123456789abcdef';

function endpoint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'nim-1',
    provider: 'nvidia_nim',
    baseUrl: 'https://chat.example/v1',
    apiKey: SECRET,
    enabled: true,
    tier: 'both',
    flashModel: 'flash-model',
    proModel: 'pro-model',
    ...overrides,
  };
}

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    importedFromEnv: false,
    endpoints: [endpoint()],
    embedding: {
      baseUrl: 'https://embed.example/v1',
      path: '/embeddings',
      model: 'embed-model',
      apiKey: EMBED_SECRET,
      enabled: true,
      maxDims: null,
    },
    ...overrides,
  };
}

const dirs: string[] = [];
const stores: ConfigStore[] = [];
const servers: WebServer[] = [];

interface Runtime {
  base: string;
  dir: string;
  store: ConfigStore;
  /** Pool built for the initially loaded config (the "live" pool). */
  pool: EndpointPool;
  changes: ConfigChange[];
  outbound: ReturnType<typeof vi.fn<FetchLike>>;
}

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'uuharness-models-api-'));
  dirs.push(dir);
  return dir;
}

function originOf(base: string): string {
  return new URL(base).origin;
}

function jsonHeaders(base: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-uuharness-console': '1',
    origin: originOf(base),
  };
}

async function loginCookie(base: string): Promise<string> {
  const response = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: jsonHeaders(base),
    body: JSON.stringify({ token: STRONG_TOKEN }),
  });
  expect(response.status).toBe(200);
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const raw = headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie') ?? '';
  return raw.split(';')[0] ?? '';
}

async function startRuntime(
  options: {
    config?: unknown;
    fetch?: FetchLike;
    atomicWrite?: (targetPath: string, contents: string) => Promise<void>;
    timeoutMs?: number;
  } = {},
): Promise<Runtime> {
  const dir = await makeDir();
  await writeFile(
    path.join(dir, 'models.json'),
    `${JSON.stringify(options.config ?? baseConfig(), null, 2)}\n`,
    'utf8',
  );

  const changes: ConfigChange[] = [];
  let livePool: EndpointPool | null = null;
  const store = new ConfigStore({
    configDir: dir,
    env: {},
    log: () => {},
    build: (config) => {
      const pool = new EndpointPool(config.endpoints);
      // Only the first build (the initial load) is the live pool; later builds
      // belong to dry runs and must not be inspected by health assertions.
      livePool ??= pool;
      return { ok: true, pool, brain: new Brain(pool, { timeoutMs: 1_000 }) };
    },
    onChange: (change) => changes.push(change),
    ...(options.atomicWrite === undefined ? {} : { atomicWrite: options.atomicWrite }),
  });
  stores.push(store);
  const loaded = await store.load();
  expect(loaded.ok).toBe(true);
  if (livePool === null) throw new Error('store did not build a pool');
  const pool: EndpointPool = livePool;

  const outbound = vi.fn<FetchLike>(
    options.fetch ?? (async () => new Response('{}', { status: 200 })),
  );
  const api = createModelsApi({
    store,
    endpoints: () => pool.snapshot(),
    silentRounds: () => 3,
    nextFastMs: () => 8_000,
    inFlight: () => false,
    queueSize: () => 7,
    plugins: () => [{ name: 'qq', kind: 'channel', state: 'active' }],
    capabilities: () => [{ name: 'memory', state: 'active' }],
    channels: () => ['qq'],
    fetch: outbound,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

  const server = createWebServer({
    host: '127.0.0.1',
    port: 0,
    token: STRONG_TOKEN,
    log: () => {},
    state: api.state,
    routeHandlers: api.handlers,
  });
  servers.push(server);
  await server.start();
  const base = `http://127.0.0.1:${server.port()}`;
  const cookie = await loginCookie(base);

  return { base, dir, store, pool, changes, outbound };
}

async function getState(base: string, cookie: string): Promise<Response> {
  return fetch(`${base}/api/state`, { headers: { cookie } });
}

async function putModels(base: string, cookie: string, body: unknown): Promise<Response> {
  return fetch(`${base}/api/models`, {
    method: 'PUT',
    headers: { ...jsonHeaders(base), cookie },
    body: JSON.stringify(body),
  });
}

async function testModel(base: string, cookie: string, body: unknown): Promise<Response> {
  return fetch(`${base}/api/models/test`, {
    method: 'POST',
    headers: { ...jsonHeaders(base), cookie },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('GET /api/state', () => {
  it('returns the runtime snapshot and masked models without any key material', async () => {
    const { base } = await startRuntime();
    const cookie = await loginCookie(base);
    const response = await getState(base, cookie);
    expect(response.status).toBe(200);

    const raw = await response.text();
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body['endpoints']).toEqual([
      expect.objectContaining({ name: 'nim-1', enabled: true, degraded: false }),
    ]);
    expect(body['silentRounds']).toBe(3);
    expect(body['nextFastMs']).toBe(8_000);
    expect(body['inFlight']).toBe(false);
    expect(body['queueSize']).toBe(7);
    expect(body['plugins']).toEqual([{ name: 'qq', kind: 'channel', state: 'active' }]);
    expect(body['capabilities']).toEqual([{ name: 'memory', state: 'active' }]);
    expect(body['channels']).toEqual(['qq']);

    const models = body['models'] as {
      endpoints: Array<Record<string, unknown>>;
      embedding: Record<string, unknown>;
    };
    expect(models.endpoints[0]).toMatchObject({ name: 'nim-1', hasApiKey: true, keyLast4: 'cdef' });
    expect(models.endpoints[0]).not.toHaveProperty('apiKey');
    expect(models.embedding).toMatchObject({ hasApiKey: true, keyLast4: 'cdef' });
    expect(models.embedding).not.toHaveProperty('apiKey');

    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain(EMBED_SECRET);
    expect(raw).not.toContain('apiKey');
  });
});

describe('PUT /api/models', () => {
  it('saves a valid candidate, keeps an omitted key, and answers only {ok:true}', async () => {
    const { base, store, changes } = await startRuntime();
    const cookie = await loginCookie(base);

    const candidate = baseConfig({ endpoints: [endpoint({ flashModel: 'flash-v2' })] });
    const response = await putModels(base, cookie, candidate);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const saved = store.get();
    expect(saved?.endpoints[0]?.flashModel).toBe('flash-v2');
    expect(saved?.endpoints[0]?.apiKey).toBe(SECRET);
    expect(changes).toHaveLength(1);
  });

  it('persists the accepted candidate to models.json', async () => {
    const { base, store, dir } = await startRuntime();
    const cookie = await loginCookie(base);

    const response = await putModels(
      base,
      cookie,
      baseConfig({ endpoints: [endpoint({ flashModel: 'flash-v3' })] }),
    );
    expect(response.status).toBe(200);

    const onDisk = JSON.parse(await readFile(path.join(dir, 'models.json'), 'utf8')) as {
      endpoints: Array<{ flashModel: string }>;
    };
    expect(onDisk.endpoints[0]?.flashModel).toBe('flash-v3');
    expect(store.get()?.endpoints[0]?.flashModel).toBe('flash-v3');
  });

  it('rejects a masked key with 400 and leaves the file byte-identical', async () => {
    const { base, dir, changes } = await startRuntime();
    const cookie = await loginCookie(base);
    const before = await readFile(path.join(dir, 'models.json'), 'utf8');

    const response = await putModels(
      base,
      cookie,
      baseConfig({ endpoints: [endpoint({ apiKey: 'sk-…cdef' })] }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      code: 'masked_key',
      field: 'endpoints[0].apiKey',
    });
    expect(await readFile(path.join(dir, 'models.json'), 'utf8')).toBe(before);
    expect(changes).toHaveLength(0);
  });

  it('rejects an origin change without a new key and keeps the disk unchanged', async () => {
    const { base, dir, changes } = await startRuntime();
    const cookie = await loginCookie(base);
    const before = await readFile(path.join(dir, 'models.json'), 'utf8');

    const candidate = baseConfig({ endpoints: [endpoint({ baseUrl: 'https://other.example/v1' })] });
    delete (candidate.endpoints as Array<Record<string, unknown>>)[0]!['apiKey'];

    const response = await putModels(base, cookie, candidate);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      code: 'key_required_for_new_origin',
      field: 'endpoints[0].apiKey',
    });
    expect(await readFile(path.join(dir, 'models.json'), 'utf8')).toBe(before);
    expect(changes).toHaveLength(0);
  });

  it('accepts an origin change when a new key is supplied', async () => {
    const { base, store } = await startRuntime();
    const cookie = await loginCookie(base);

    const response = await putModels(
      base,
      cookie,
      baseConfig({
        endpoints: [
          endpoint({ baseUrl: 'https://other.example/v1', apiKey: 'sk-new-secret-0123456789' }),
        ],
      }),
    );
    expect(response.status).toBe(200);
    expect(store.get()?.endpoints[0]?.baseUrl).toBe('https://other.example/v1');
    expect(store.get()?.endpoints[0]?.apiKey).toBe('sk-new-secret-0123456789');
  });

  it('maps schema failures to 400 with the field path', async () => {
    const { base, dir } = await startRuntime();
    const cookie = await loginCookie(base);
    const before = await readFile(path.join(dir, 'models.json'), 'utf8');

    const response = await putModels(
      base,
      cookie,
      baseConfig({ endpoints: [endpoint({ tier: 'nope' })] }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['ok']).toBe(false);
    expect(body['code']).toBe('invalid_field');
    expect(body['field']).toBe('endpoints[0].tier');
    expect(await readFile(path.join(dir, 'models.json'), 'utf8')).toBe(before);
  });

  it('clears a stored key when the candidate sends null for a loopback endpoint', async () => {
    const { base, store } = await startRuntime({
      config: baseConfig({
        endpoints: [endpoint({ baseUrl: 'http://127.0.0.1:8000/v1' })],
      }),
    });
    const cookie = await loginCookie(base);

    const response = await putModels(
      base,
      cookie,
      baseConfig({ endpoints: [endpoint({ baseUrl: 'http://127.0.0.1:8000/v1', apiKey: null })] }),
    );
    expect(response.status).toBe(200);
    expect(store.get()?.endpoints[0]?.apiKey).toBe('');
  });

  it('maps write_failed to 400 and leaves the stored configuration intact', async () => {
    const { base, store, changes } = await startRuntime({
      atomicWrite: async () => {
        throw new Error('disk is read-only');
      },
    });
    const cookie = await loginCookie(base);

    const response = await putModels(
      base,
      cookie,
      baseConfig({ endpoints: [endpoint({ flashModel: 'never-saved' })] }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, code: 'write_failed' });
    expect(store.get()?.endpoints[0]?.flashModel).toBe('flash-model');
    expect(changes).toHaveLength(0);
  });
});

describe('POST /api/models/test', () => {
  it('probes the flash tier with a minimal, non-redirecting request', async () => {
    const { base, outbound } = await startRuntime({
      fetch: async () => new Response('{"choices":[]}', { status: 200 }),
    });
    const cookie = await loginCookie(base);

    const response = await testModel(base, cookie, { tier: 'flash' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(typeof body['latencyMs']).toBe('number');
    expect(body['endpoint']).toBe('nim-1');
    expect(body['model']).toBe('flash-model');

    expect(outbound).toHaveBeenCalledTimes(1);
    const [url, init] = outbound.mock.calls[0] ?? [];
    expect(url).toBe('https://chat.example/v1/chat/completions');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect((init?.headers as Record<string, string>)['authorization']).toBe(`Bearer ${SECRET}`);
    const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(sent['model']).toBe('flash-model');
    expect(sent['max_tokens']).toBe(1);
  });

  it('probes the pro tier with the pro model', async () => {
    const { base, outbound } = await startRuntime({
      fetch: async () => new Response('{}', { status: 200 }),
    });
    const cookie = await loginCookie(base);

    const response = await testModel(base, cookie, { tier: 'pro' });
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(body['model']).toBe('pro-model');
    const sent = JSON.parse(String(outbound.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(sent['model']).toBe('pro-model');
  });

  it('classifies HTTP failures without leaking the upstream body', async () => {
    const { base } = await startRuntime({
      fetch: async () => new Response('secret-upstream-body', { status: 429 }),
    });
    const cookie = await loginCookie(base);

    const response = await testModel(base, cookie, { tier: 'flash' });
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain('secret-upstream-body');
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: false,
      endpoint: 'nim-1',
      model: 'flash-model',
      errorKind: 'rate_limit',
      status: 429,
    });
    expect(typeof body['latencyMs']).toBe('number');
  });

  it('classifies network and timeout failures', async () => {
    const network = await startRuntime({
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    let cookie = await loginCookie(network.base);
    let body = (await (await testModel(network.base, cookie, { tier: 'flash' })).json()) as Record<
      string,
      unknown
    >;
    expect(body['ok']).toBe(false);
    expect(body['errorKind']).toBe('network');

    const timeout = await startRuntime({
      fetch: async () => {
        throw new DOMException('timed out', 'TimeoutError');
      },
    });
    cookie = await loginCookie(timeout.base);
    body = (await (await testModel(timeout.base, cookie, { tier: 'flash' })).json()) as Record<
      string,
      unknown
    >;
    expect(body['ok']).toBe(false);
    expect(body['errorKind']).toBe('timeout');
  });

  it('never mutates live endpoint health', async () => {
    const { base, pool } = await startRuntime({
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const cookie = await loginCookie(base);

    const before = pool.snapshot()[0];
    expect(before?.failures).toBe(0);
    expect(before?.degraded).toBe(false);

    await testModel(base, cookie, { tier: 'flash' });

    const after = pool.snapshot()[0];
    expect(after?.failures).toBe(0);
    expect(after?.degraded).toBe(false);
    expect(after?.lastError).toBeUndefined();
  });

  it('returns not_configured for a service that has no config section', async () => {
    const { base } = await startRuntime();
    const cookie = await loginCookie(base);

    const response = await testModel(base, cookie, { tier: 'rerank' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, code: 'not_configured' });
  });

  it('probes embedding through its configured path with a minimal payload', async () => {
    const { base, outbound } = await startRuntime({
      fetch: async () => new Response('{"data":[]}', { status: 200 }),
    });
    const cookie = await loginCookie(base);

    const response = await testModel(base, cookie, { tier: 'embedding' });
    expect(await response.json()).toMatchObject({
      ok: true,
      endpoint: 'embedding',
      model: 'embed-model',
    });
    const [url, init] = outbound.mock.calls[0] ?? [];
    expect(url).toBe('https://embed.example/v1/embeddings');
    const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(sent['model']).toBe('embed-model');
    expect(sent['input']).toBe('ping');
    expect((init?.headers as Record<string, string>)['authorization']).toBe(
      `Bearer ${EMBED_SECRET}`,
    );
  });

  it('probes rerank and tts with their own minimal payloads', async () => {
    const { base, outbound } = await startRuntime({
      config: baseConfig({
        rerank: {
          baseUrl: 'https://rerank.example/v1',
          path: '/reranking',
          model: 'rerank-model',
          apiKey: 'sk-rerank-secret-0123456789',
          enabled: true,
        },
        tts: {
          baseUrl: 'https://tts.example/v1',
          path: '/audio/speech',
          model: 'tts-model',
          apiKey: 'sk-tts-secret-0123456789',
          enabled: true,
          voice: 'alloy',
          format: 'mp3',
        },
      }),
      fetch: async () => new Response('{}', { status: 200 }),
    });
    const cookie = await loginCookie(base);

    const rerank = (await (await testModel(base, cookie, { tier: 'rerank' })).json()) as Record<
      string,
      unknown
    >;
    expect(rerank).toMatchObject({ ok: true, endpoint: 'rerank', model: 'rerank-model' });
    expect(outbound.mock.calls[0]?.[0]).toBe('https://rerank.example/v1/reranking');
    const rerankBody = JSON.parse(String(outbound.mock.calls[0]?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(rerankBody['model']).toBe('rerank-model');
    expect(rerankBody['query']).toBe('ping');

    const tts = (await (await testModel(base, cookie, { tier: 'tts' })).json()) as Record<
      string,
      unknown
    >;
    expect(tts).toMatchObject({ ok: true, endpoint: 'tts', model: 'tts-model' });
    expect(outbound.mock.calls[1]?.[0]).toBe('https://tts.example/v1/audio/speech');
    const ttsBody = JSON.parse(String(outbound.mock.calls[1]?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(ttsBody['model']).toBe('tts-model');
    expect(ttsBody['voice']).toBe('alloy');
  });

  it('probes stt with a multipart form', async () => {
    const { base, outbound } = await startRuntime({
      config: baseConfig({
        stt: {
          baseUrl: 'https://stt.example/v1',
          path: '/audio/transcriptions',
          model: 'stt-model',
          apiKey: 'sk-stt-secret-0123456789',
          enabled: true,
          language: 'zh',
        },
      }),
      fetch: async () => new Response('{"text":""}', { status: 200 }),
    });
    const cookie = await loginCookie(base);

    const response = await testModel(base, cookie, { tier: 'stt' });
    expect(await response.json()).toMatchObject({
      ok: true,
      endpoint: 'stt',
      model: 'stt-model',
    });
    const [url, init] = outbound.mock.calls[0] ?? [];
    expect(url).toBe('https://stt.example/v1/audio/transcriptions');
    expect(init?.body).toBeInstanceOf(FormData);
    const form = init?.body as FormData;
    expect(form.get('model')).toBe('stt-model');
    expect(form.get('language')).toBe('zh');
    expect(form.get('file')).toBeInstanceOf(Blob);
  });

  it('applies a draft override and keeps the stored key for the same endpoint', async () => {
    const { base, outbound } = await startRuntime({
      fetch: async () => new Response('{}', { status: 200 }),
    });
    const cookie = await loginCookie(base);

    const draft = baseConfig({ endpoints: [endpoint({ flashModel: 'draft-model' })] });
    delete (draft.endpoints as Array<Record<string, unknown>>)[0]!['apiKey'];

    const response = await testModel(base, cookie, { tier: 'flash', draft });
    expect(await response.json()).toMatchObject({ ok: true, model: 'draft-model' });

    const [, init] = outbound.mock.calls[0] ?? [];
    expect((init?.headers as Record<string, string>)['authorization']).toBe(`Bearer ${SECRET}`);
    const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(sent['model']).toBe('draft-model');
  });

  it('rejects a draft that changes the origin without a key', async () => {
    const { base, outbound } = await startRuntime();
    const cookie = await loginCookie(base);

    const draft = baseConfig({ endpoints: [endpoint({ baseUrl: 'https://other.example/v1' })] });
    delete (draft.endpoints as Array<Record<string, unknown>>)[0]!['apiKey'];

    const response = await testModel(base, cookie, { tier: 'flash', draft });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      code: 'key_required_for_new_origin',
      field: 'endpoints[0].apiKey',
    });
    expect(outbound).not.toHaveBeenCalled();
  });

  it('rejects an unknown tier with 400', async () => {
    const { base, outbound } = await startRuntime();
    const cookie = await loginCookie(base);

    const response = await testModel(base, cookie, { tier: 'vision' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      code: 'invalid_tier',
      field: 'tier',
    });
    expect(outbound).not.toHaveBeenCalled();
  });

  it('probes without writing models.json or emitting a change', async () => {
    const { base, dir, changes, outbound } = await startRuntime({
      fetch: async () => new Response('{}', { status: 200 }),
    });
    const cookie = await loginCookie(base);
    const before = await readFile(path.join(dir, 'models.json'), 'utf8');

    const response = await testModel(base, cookie, { tier: 'flash' });
    expect(response.status).toBe(200);

    expect(outbound).toHaveBeenCalledTimes(1);
    expect(changes).toHaveLength(0);
    expect(await readFile(path.join(dir, 'models.json'), 'utf8')).toBe(before);
  });

  it('applies the configured probe timeout to the outbound request', async () => {
    let signal: AbortSignal | undefined;
    const { base } = await startRuntime({
      timeoutMs: 20,
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init.signal ?? undefined;
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('timed out', 'TimeoutError'));
          });
        }),
    });
    const cookie = await loginCookie(base);

    const body = (await (await testModel(base, cookie, { tier: 'flash' })).json()) as Record<
      string,
      unknown
    >;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(true);
    expect(body['ok']).toBe(false);
    expect(body['errorKind']).toBe('timeout');
  });

  it('maps 401 and 403 probe failures to an auth errorKind', async () => {
    for (const status of [401, 403]) {
      const { base } = await startRuntime({
        fetch: async () => new Response('forbidden', { status }),
      });
      const cookie = await loginCookie(base);

      const body = (await (await testModel(base, cookie, { tier: 'flash' })).json()) as Record<
        string,
        unknown
      >;
      expect(body).toMatchObject({ ok: false, errorKind: 'auth', status });
    }
  });

  it('accepts a service-only draft so an empty endpoint row cannot block the probe', async () => {
    const { base, outbound } = await startRuntime({
      fetch: async () => new Response('{"data":[]}', { status: 200 }),
    });
    const cookie = await loginCookie(base);

    const draft = {
      version: 1,
      embedding: {
        baseUrl: 'https://embed.example/v1',
        path: '/embeddings',
        model: 'draft-embed-model',
        enabled: true,
      },
    };
    const response = await testModel(base, cookie, { tier: 'embedding', draft });
    expect(await response.json()).toMatchObject({
      ok: true,
      endpoint: 'embedding',
      model: 'draft-embed-model',
    });
    const [url, init] = outbound.mock.calls[0] ?? [];
    expect(url).toBe('https://embed.example/v1/embeddings');
    // The draft omits apiKey, so the stored key must be reused.
    expect((init?.headers as Record<string, string>)['authorization']).toBe(
      `Bearer ${EMBED_SECRET}`,
    );
  });
});
