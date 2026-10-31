import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EndpointConfig } from '../src/config.js';
import { EndpointPool, AllEndpointsDownError } from '../src/brain/endpoints.js';
import { Brain } from '../src/brain/brain.js';
import type { ChatMessage, ToolCall, ToolDef } from '../src/brain/types.js';

function makeEndpoint(name: string, overrides: Partial<EndpointConfig> = {}): EndpointConfig {
  return {
    name,
    baseUrl: `https://${name}.example.test/v1`,
    apiKey: `test-key-${name}`,
    flashModel: `${name}-flash`,
    proModel: `${name}-pro`,
    enabled: true,
    ...overrides,
  };
}

function makePool(...endpoints: EndpointConfig[]): EndpointPool {
  return new EndpointPool(endpoints, { now: () => 1_000 });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function streamedResponse(status: number, chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status });
}

function completion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'hello' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    ...overrides,
  };
}

type FetchCall = [url: string, init: RequestInit];

function requestBody(call: FetchCall | undefined): Record<string, unknown> {
  const raw = call?.[1]?.body;
  if (typeof raw !== 'string') throw new Error('expected a string request body');
  return JSON.parse(raw) as Record<string, unknown>;
}

const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hi' }];

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Brain.chat', () => {
  it('returns content, strips reasoning_content into reasoning, reports usage and marks the endpoint healthy', async () => {
    const onUsage = vi.fn();
    const pool = makePool(makeEndpoint('nim-1'));
    const reportSuccess = vi.spyOn(pool, 'reportSuccess');
    const brain = new Brain(pool, { timeoutMs: 1_000, onUsage });

    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        200,
        completion({
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'hello',
                reasoning_content: 'chain of thought',
              },
              finish_reason: 'stop',
            },
          ],
        }),
      ),
    );

    const result = await brain.chat(messages);

    expect(result).toEqual({
      content: 'hello',
      toolCalls: [],
      reasoning: 'chain of thought',
      usage: { promptTokens: 10, completionTokens: 5 },
      endpoint: 'nim-1',
      model: 'nim-1-flash',
    });
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith({
      endpoint: 'nim-1',
      model: 'nim-1-flash',
      usage: { promptTokens: 10, completionTokens: 5 },
    });
    expect(reportSuccess).toHaveBeenCalledWith('nim-1');

    // reasoning must never leak back into conversation history
    expect(messages).toEqual([{ role: 'user', content: 'hi' }]);

    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe('https://nim-1.example.test/v1/chat/completions');
    expect(call?.[1].method).toBe('POST');
    expect(call?.[1].signal).toBeInstanceOf(AbortSignal);

    const headers = call?.[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key-nim-1');
    expect(headers['Content-Type']).toBe('application/json');

    const body = requestBody(call);
    expect(body.model).toBe('nim-1-flash');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect('tools' in body).toBe(false);
  });

  it('returns native tool calls when finish_reason is tool_calls', async () => {
    const pool = makePool(makeEndpoint('nim-1'));
    const brain = new Brain(pool, { timeoutMs: 1_000 });

    const toolCall: ToolCall = {
      id: 'call-1',
      type: 'function',
      function: { name: 'remember', arguments: '{"text":"x"}' },
    };
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        200,
        completion({
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: null, tool_calls: [toolCall] },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      ),
    );

    const result = await brain.chat(MESSAGES);

    expect(result.content).toBeNull();
    expect(result.toolCalls).toEqual([toolCall]);
  });

  it('fails over to the next endpoint on 429, retrying the same request', async () => {
    const pool = makePool(makeEndpoint('a'), makeEndpoint('b'));
    const reportFailure = vi.spyOn(pool, 'reportFailure');
    const brain = new Brain(pool, { timeoutMs: 1_000 });

    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, { error: 'slow down' }))
      .mockResolvedValueOnce(
        jsonResponse(
          200,
          completion({
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'ok' },
                finish_reason: 'stop',
              },
            ],
          }),
        ),
      );

    const result = await brain.chat(MESSAGES, { tier: 'pro' });

    expect(result.endpoint).toBe('b');
    expect(result.model).toBe('b-pro');
    expect(result.content).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reportFailure).toHaveBeenCalledWith('a', { kind: 'rate_limit', status: 429 });

    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://b.example.test/v1/chat/completions');
    // The retried request carries the same conversation (model follows the endpoint tier).
    expect(requestBody(fetchMock.mock.calls[0]).messages).toEqual(
      requestBody(fetchMock.mock.calls[1]).messages,
    );
  });

  it('throws AllEndpointsDownError after one pass when every endpoint is rate limited', async () => {
    const pool = makePool(makeEndpoint('a'), makeEndpoint('b'));
    const brain = new Brain(pool, { timeoutMs: 1_000 });

    fetchMock.mockImplementation(async () => jsonResponse(429, { error: 'slow down' }));

    const error = await brain.chat(MESSAGES).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(AllEndpointsDownError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const message = (error as Error).message;
    expect(message).toContain('a');
    expect(message).toContain('b');
    expect(message).toContain('429');
  });

  it('surfaces a reasoning-only truncated response as content null with reasoning', async () => {
    const pool = makePool(makeEndpoint('nim-1'));
    const brain = new Brain(pool, { timeoutMs: 1_000 });

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        200,
        completion({
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: null, reasoning_content: 'still thinking' },
              finish_reason: 'length',
            },
          ],
        }),
      ),
    );

    const result = await brain.chat(MESSAGES);

    expect(result.content).toBeNull();
    expect(result.reasoning).toBe('still thinking');
    expect(result.toolCalls).toEqual([]);
  });

  it('never leaks the api key in error messages', async () => {
    const pool = makePool(makeEndpoint('nim-1'));
    const brain = new Brain(pool, { timeoutMs: 1_000 });

    fetchMock.mockResolvedValueOnce(
      jsonResponse(500, { error: 'upstream rejected Authorization: Bearer test-key-nim-1' }),
    );

    const error = await brain.chat(MESSAGES).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(AllEndpointsDownError);
    const message = (error as Error).message;
    expect(message).not.toContain('test-key');
    expect(message).not.toContain('Bearer');
    expect(message).toContain('nim-1');
    expect(message).toContain('500');
  });

  it('sends the tools array when tools are provided', async () => {
    const pool = makePool(makeEndpoint('nim-1'));
    const brain = new Brain(pool, { timeoutMs: 1_000 });

    const tools: ToolDef[] = [
      {
        type: 'function',
        function: { name: 'remember', description: 'remember something', parameters: {} },
      },
    ];
    fetchMock.mockResolvedValueOnce(jsonResponse(200, completion()));

    await brain.chat(MESSAGES, { tools });

    expect(requestBody(fetchMock.mock.calls[0]).tools).toEqual(tools);
  });

  it('fails over on network errors and timeouts', async () => {
    const pool = makePool(makeEndpoint('a'), makeEndpoint('b'), makeEndpoint('c'));
    const reportFailure = vi.spyOn(pool, 'reportFailure');
    const brain = new Brain(pool, { timeoutMs: 1_000 });

    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';

    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce(jsonResponse(200, completion()));

    const result = await brain.chat(MESSAGES);

    expect(result.endpoint).toBe('c');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(reportFailure).toHaveBeenCalledWith('a', { kind: 'network' });
    expect(reportFailure).toHaveBeenCalledWith('b', { kind: 'timeout' });
  });

  it('classifies a DOMException TimeoutError as timeout, fails over and passes timeoutMs through', async () => {
    const pool = makePool(makeEndpoint('a'), makeEndpoint('b'));
    const reportFailure = vi.spyOn(pool, 'reportFailure');
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const brain = new Brain(pool, { timeoutMs: 1_234 });

    fetchMock
      .mockRejectedValueOnce(
        new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      )
      .mockResolvedValueOnce(jsonResponse(200, completion()));

    const result = await brain.chat(MESSAGES);

    expect(result.endpoint).toBe('b');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reportFailure).toHaveBeenCalledWith('a', { kind: 'timeout' });
    expect(reportFailure).not.toHaveBeenCalledWith('a', { kind: 'network' });
    // The caller-supplied timeout flows through unchanged to AbortSignal.timeout.
    expect(timeoutSpy).toHaveBeenCalledWith(1_234);
  });

  it('treats AbortError as timeout and throws AllEndpointsDownError when every endpoint times out', async () => {
    const pool = makePool(makeEndpoint('a'), makeEndpoint('b'));
    const reportFailure = vi.spyOn(pool, 'reportFailure');
    const brain = new Brain(pool, { timeoutMs: 1_000 });

    fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'));

    const error = await brain.chat(MESSAGES).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(AllEndpointsDownError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reportFailure).toHaveBeenCalledWith('a', { kind: 'timeout' });
    expect(reportFailure).toHaveBeenCalledWith('b', { kind: 'timeout' });
    expect((error as Error).message).toContain('timeout');
  });

  it('bounds failover to one pass when slow timeouts outlive the backoff window', async () => {
    let now = 0;
    const timeoutMs = 120_000;
    const pool = new EndpointPool([makeEndpoint('a'), makeEndpoint('b'), makeEndpoint('c')], {
      now: () => now,
    });
    const brain = new Brain(pool, { timeoutMs });

    // Real-clock simulation: each attempt consumes the full timeout, so a failed
    // endpoint's 5s backoff has long expired by the time the next pick happens.
    fetchMock.mockImplementation(async () => {
      now += timeoutMs;
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });

    const error = await brain.chat(MESSAGES).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(AllEndpointsDownError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((error as Error).message).toContain('timeout');
  });

  it('streams and truncates huge error bodies while still detecting the quota marker', async () => {
    const pool = makePool(makeEndpoint('a'));
    const reportFailure = vi.spyOn(pool, 'reportFailure');
    const brain = new Brain(pool, { timeoutMs: 1_000 });

    const junk = 'x'.repeat(512_000);
    fetchMock.mockResolvedValueOnce(
      streamedResponse(400, ['{"error":"insufficient_user_quota"}', junk]),
    );

    const error = await brain.chat(MESSAGES).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(AllEndpointsDownError);
    expect(reportFailure).toHaveBeenCalledWith('a', { kind: 'quota', status: 400 });
    const message = (error as Error).message;
    expect(message).not.toContain('insufficient_user_quota');
    expect(message).not.toContain('xxxxx');
  });

  it('handles error responses with a null body', async () => {
    const pool = makePool(makeEndpoint('a'));
    const reportFailure = vi.spyOn(pool, 'reportFailure');
    const brain = new Brain(pool, { timeoutMs: 1_000 });

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 400 }));

    await expect(brain.chat(MESSAGES)).rejects.toBeInstanceOf(AllEndpointsDownError);
    expect(reportFailure).toHaveBeenCalledWith('a', { kind: 'http', status: 400 });
  });

  it('keeps the successful response when the usage ledger throws', async () => {
    const pool = makePool(makeEndpoint('nim-1'));
    const reportSuccess = vi.spyOn(pool, 'reportSuccess');
    const onUsage = vi.fn(() => {
      throw new Error('ledger down');
    });
    const brain = new Brain(pool, { timeoutMs: 1_000, onUsage });

    fetchMock.mockResolvedValueOnce(jsonResponse(200, completion()));

    const result = await brain.chat(MESSAGES);

    expect(result.content).toBe('hello');
    expect(result.endpoint).toBe('nim-1');
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(reportSuccess).toHaveBeenCalledWith('nim-1');
  });

  it('classifies an aborted response body read as timeout and fails over', async () => {
    const pool = makePool(makeEndpoint('a'), makeEndpoint('b'));
    const reportFailure = vi.spyOn(pool, 'reportFailure');
    const brain = new Brain(pool, { timeoutMs: 1_000 });

    const aborted = {
      ok: true,
      status: 200,
      body: null,
      json: async () => {
        throw new DOMException('aborted', 'AbortError');
      },
    } as unknown as Response;

    fetchMock
      .mockResolvedValueOnce(aborted)
      .mockResolvedValueOnce(jsonResponse(200, completion()));

    const result = await brain.chat(MESSAGES);

    expect(result.endpoint).toBe('b');
    expect(reportFailure).toHaveBeenCalledWith('a', { kind: 'timeout' });
  });

  it('treats an empty assistant message as malformed and fails over', async () => {
    const pool = makePool(makeEndpoint('a'), makeEndpoint('b'));
    const brain = new Brain(pool, { timeoutMs: 1_000 });

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          200,
          completion({
            choices: [{ index: 0, message: { role: 'assistant' }, finish_reason: 'stop' }],
          }),
        ),
      )
      .mockResolvedValueOnce(jsonResponse(200, completion()));

    const result = await brain.chat(MESSAGES);

    expect(result.endpoint).toBe('b');
    expect(result.content).toBe('hello');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws without calling fetch when the pool has no usable endpoint', async () => {
    const pool = makePool(makeEndpoint('a', { enabled: false }));
    const brain = new Brain(pool, { timeoutMs: 1_000 });

    await expect(brain.chat(MESSAGES)).rejects.toBeInstanceOf(AllEndpointsDownError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
