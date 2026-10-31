/**
 * T3 网页对话 API：`POST /api/chat/messages` 与 `GET /api/chat/messages`。
 *
 * 两条路由复用既有闸：会话、Host、Origin、`X-Uuharness-Console`、JSON、
 * 体积上限。端到端用例用真实插件宿主 + 真实心跳循环，验证「网页发一句 →
 * 回复经红线闸后出现在桥接里」，以及被拦截的回复不出现但留下 blocked 行。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { HeartbeatLoop } from '../../src/core/loop.js';
import { PerceptionQueue } from '../../src/core/events.js';
import { createPersonaState } from '../../src/persona/persona.js';
import { PluginHost } from '../../src/plugins/host.js';
import type { BrainResponse } from '../../src/brain/brain.js';
import type { Config } from '../../src/config.js';
import type { TranscriptRecord } from '../../src/web/transcript.js';
import { MAX_CHAT_INBOUND_BYTES, WebChatBridge } from '../../src/web/chat-bridge.js';
import { createChatApi } from '../../src/web/chat-api.js';
import { createWebServer, type WebServer } from '../../src/web/server.js';

const STRONG_TOKEN = '0123456789abcdef0123456789abcdef';
const CHANNELS_DIR = fileURLToPath(new URL('../../plugins/channels', import.meta.url));

const servers: WebServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

interface Started {
  base: string;
  cookie: string;
  bridge: WebChatBridge;
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

async function start(): Promise<Started> {
  const bridge = new WebChatBridge();
  const api = createChatApi({ bridge, log: () => {} });
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
  return { base, cookie, bridge };
}

function get(base: string, path: string, cookie?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    headers: cookie === undefined ? {} : { cookie },
  });
}

function post(
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
  return fetch(`${base}/api/chat/messages`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function bodyOf<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

interface MessagesBody {
  ok: boolean;
  code?: string;
  seq?: number;
  messages?: Array<{ seq: number; ts: string; role: string; text: string }>;
  lastSeq?: number;
}

describe('chat route gates', () => {
  it('requires a session on both routes', async () => {
    const { base } = await start();
    expect((await get(base, '/api/chat/messages')).status).toBe(401);
    expect((await post(base, undefined, { text: 'hi' })).status).toBe(401);
  });

  it('requires the console CSRF header and a same-origin Origin on POST', async () => {
    const { base, cookie } = await start();

    const noCsrf = await post(base, cookie, { text: 'hi' }, { csrf: false });
    expect(noCsrf.status).toBe(403);
    expect(await bodyOf(noCsrf)).toMatchObject({ ok: false, code: 'bad_csrf' });

    const noOrigin = await post(base, cookie, { text: 'hi' }, { origin: false });
    expect(noOrigin.status).toBe(403);
    expect(await bodyOf(noOrigin)).toMatchObject({ ok: false, code: 'bad_origin' });
  });

  it('requires JSON content type on POST', async () => {
    const { base, cookie } = await start();
    const response = await post(base, cookie, { text: 'hi' }, { contentType: 'text/plain' });
    expect(response.status).toBe(415);
    expect(await bodyOf(response)).toMatchObject({ ok: false, code: 'unsupported_media_type' });
  });

  it('rejects invalid JSON and bodies over the route limit', async () => {
    const { base, cookie } = await start();

    const invalid = await post(base, cookie, '{not json');
    expect(invalid.status).toBe(400);
    expect(await bodyOf(invalid)).toMatchObject({ ok: false, code: 'invalid_json' });

    const tooLarge = await post(base, cookie, { text: 'a'.repeat(70_000) });
    expect(tooLarge.status).toBe(413);
    expect(await bodyOf(tooLarge)).toMatchObject({ ok: false, code: 'payload_too_large' });
  });

  it('rejects a missing or non-string text field', async () => {
    const { base, cookie } = await start();

    for (const body of [{}, { text: 42 }, { text: null }, ['hi'], null]) {
      const response = await post(base, cookie, body);
      expect(response.status).toBe(400);
      expect(await bodyOf(response)).toMatchObject({ ok: false, code: 'invalid_body' });
    }
  });

  it('maps bridge boundary errors to 400', async () => {
    const { base, cookie } = await start();

    const empty = await post(base, cookie, { text: '   \n ' });
    expect(empty.status).toBe(400);
    expect(await bodyOf(empty)).toMatchObject({ ok: false, code: 'empty' });

    const tooLong = await post(base, cookie, {
      text: 'a'.repeat(MAX_CHAT_INBOUND_BYTES + 1),
    });
    expect(tooLong.status).toBe(400);
    expect(await bodyOf(tooLong)).toMatchObject({ ok: false, code: 'too_long' });
  });

  it('only allows GET and POST on the chat path', async () => {
    const { base, cookie } = await start();
    const response = await fetch(`${base}/api/chat/messages`, {
      method: 'PUT',
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
});

describe('POST /api/chat/messages', () => {
  it('accepts text and returns the assigned seq', async () => {
    const { base, cookie, bridge } = await start();

    const first = await post(base, cookie, { text: '你好' });
    expect(first.status).toBe(200);
    expect(await bodyOf(first)).toEqual({ ok: true, seq: 1 });

    const second = await post(base, cookie, { text: '在吗' });
    expect(await bodyOf(second)).toEqual({ ok: true, seq: 2 });
    expect(bridge.snapshot().map((message) => message.text)).toEqual(['你好', '在吗']);
  });

  it('returns 503 with closed once the bridge is closed', async () => {
    const { base, cookie, bridge } = await start();
    bridge.close();

    const response = await post(base, cookie, { text: 'hi' });
    expect(response.status).toBe(503);
    expect(await bodyOf(response)).toMatchObject({ ok: false, code: 'closed' });
  });
});

describe('GET /api/chat/messages', () => {
  it('returns the most recent 200 messages when after is absent', async () => {
    const { base, cookie, bridge } = await start();
    for (let index = 0; index < 250; index += 1) bridge.submit(`m${index}`);

    const response = await get(base, '/api/chat/messages', cookie);
    expect(response.status).toBe(200);
    const body = await bodyOf<MessagesBody>(response);
    expect(body.ok).toBe(true);
    expect(body.lastSeq).toBe(250);
    expect(body.messages).toHaveLength(200);
    expect(body.messages?.[0]?.seq).toBe(51);
    expect(body.messages?.[199]?.seq).toBe(250);
  });

  it('treats an empty after as absent', async () => {
    const { base, cookie, bridge } = await start();
    bridge.submit('hi');

    const response = await get(base, '/api/chat/messages?after=', cookie);
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toMatchObject({ ok: true, lastSeq: 1 });
  });

  it('returns only messages newer than after', async () => {
    const { base, cookie, bridge } = await start();
    for (let index = 0; index < 5; index += 1) bridge.submit(`m${index}`);

    const response = await get(base, '/api/chat/messages?after=3', cookie);
    const body = await bodyOf<MessagesBody>(response);
    expect(body.lastSeq).toBe(5);
    expect(body.messages?.map((message) => message.seq)).toEqual([4, 5]);
  });

  it('returns an empty page and the newest seq when after is ahead', async () => {
    const { base, cookie, bridge } = await start();
    bridge.submit('hi');

    const response = await get(base, '/api/chat/messages?after=99', cookie);
    expect(await bodyOf(response)).toEqual({ ok: true, messages: [], lastSeq: 1 });
  });

  it('rejects a malformed after value', async () => {
    const { base, cookie } = await start();
    for (const value of ['abc', '-1', '1.5', '1e3', ' 2', '2 ']) {
      const response = await get(
        base,
        `/api/chat/messages?after=${encodeURIComponent(value)}`,
        cookie,
      );
      expect(response.status).toBe(400);
      expect(await bodyOf(response)).toMatchObject({ ok: false, code: 'invalid_query' });
    }
  });

  it('keeps serving buffered messages after close', async () => {
    const { base, cookie, bridge } = await start();
    bridge.submit('最后一句');
    bridge.close();

    const response = await get(base, '/api/chat/messages', cookie);
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toMatchObject({ ok: true, lastSeq: 1 });
  });
});

/* ---------------- 端到端：网页发一句 → 心跳回复出现在 GET ---------------- */

function makeConfig(): Config {
  return {
    endpoints: [],
    tickFastMs: 300_000,
    tickSlowMs: 3_600_000,
    wakeDebounceMs: 0,
    httpTimeoutMs: 120_000,
    maxConversationsPerTick: 3,
    maxEventsPerConversation: 20,
    maxQueueSize: 500,
  };
}

function brainResponse(content: string): BrainResponse {
  return {
    content,
    toolCalls: [],
    reasoning: null,
    usage: { promptTokens: 1, completionTokens: 1 },
    endpoint: 'stub',
    model: 'stub',
  };
}

interface E2eHarness {
  base: string;
  cookie: string;
  bridge: WebChatBridge;
  records: TranscriptRecord[];
  runTick(): Promise<void>;
  stop(): Promise<void>;
}

async function startE2e(reply: string): Promise<E2eHarness> {
  const records: TranscriptRecord[] = [];
  const transcript = { record: (record: TranscriptRecord) => records.push(record) };
  const bridge = new WebChatBridge();
  const queue = new PerceptionQueue({ debounceMs: 0, log: () => {} });
  const host = new PluginHost({
    queue,
    brain: { chat: async () => brainResponse('unused') },
    log: () => {},
    transcript,
    // 与装配点一致：web 插件经 pluginFactoryArgs 拿到同一个桥接实例。
    pluginFactoryArgs: (name) => (name === 'web' ? [{ bridge }] : undefined),
  });
  await host.loadFrom(CHANNELS_DIR);
  await host.startAll();
  if (host.status().find((plugin) => plugin.name === 'web')?.state !== 'active') {
    throw new Error('web plugin did not activate');
  }

  const loop = new HeartbeatLoop({
    config: makeConfig(),
    queue,
    brain: { chat: async () => brainResponse(reply) },
    persona: createPersonaState(() => 0.5),
    channels: { send: (channel, text) => host.send(channel, text) },
    transcript,
    log: () => {},
  });

  const api = createChatApi({ bridge, log: () => {} });
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
    cookie,
    bridge,
    records,
    runTick: () => loop.runTickOnce('fast'),
    stop: async () => {
      await loop.stop();
      await host.stopAll();
    },
  };
}

describe('web chat end to end', () => {
  const stops: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) {
      try {
        await stop();
      } catch {
        /* 清理失败不应掩盖测试结果。 */
      }
    }
  });

  async function startHarness(reply: string): Promise<E2eHarness> {
    const harness = await startE2e(reply);
    stops.push(() => harness.stop());
    return harness;
  }

  it('turns a posted message into an agent reply visible via GET', async () => {
    const harness = await startHarness('你好呀。');

    const posted = await post(harness.base, harness.cookie, { text: '你好' });
    expect(posted.status).toBe(200);

    await harness.runTick();

    const response = await get(harness.base, '/api/chat/messages', harness.cookie);
    const body = await bodyOf<MessagesBody>(response);
    expect(body.messages?.map((message) => [message.role, message.text])).toEqual([
      ['owner', '你好'],
      ['agent', '你好呀。'],
    ]);
    expect(body.lastSeq).toBe(2);

    // 出站记录照常落一行 dispatched：桥接追加发生在宿主派发之后。
    expect(harness.records).toContainEqual(
      expect.objectContaining({ direction: 'out', channel: 'web:main', status: 'dispatched' }),
    );
  });

  it('keeps a red-line-blocked reply out of the bridge and records blocked', async () => {
    const harness = await startHarness(
      'Sure, here are the steps for building a dirty bomb at home.',
    );

    await post(harness.base, harness.cookie, { text: '给我配方' });
    await harness.runTick();

    const body = await bodyOf<MessagesBody>(
      await get(harness.base, '/api/chat/messages', harness.cookie),
    );
    expect(body.messages?.map((message) => message.role)).toEqual(['owner']);
    expect(harness.bridge.snapshot().some((message) => message.role === 'agent')).toBe(false);
    expect(harness.records).toContainEqual(
      expect.objectContaining({ direction: 'out', channel: 'web:main', status: 'blocked' }),
    );
  });
});
