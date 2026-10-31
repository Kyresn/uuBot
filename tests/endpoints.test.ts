import { describe, it, expect } from 'vitest';
import type { EndpointConfig } from '../src/config.js';
import {
  EndpointPool,
  classifyHttpError,
  endpointOrder,
  migrateEndpointStates,
  AllEndpointsDownError,
  type EndpointError,
} from '../src/brain/endpoints.js';
import type { ChatMessage, ToolCall, ToolDef, Usage } from '../src/brain/types.js';

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

function makeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

const RATE_LIMIT: EndpointError = { kind: 'rate_limit' };
const NETWORK: EndpointError = { kind: 'network' };
const QUOTA: EndpointError = { kind: 'quota' };
const TIMEOUT: EndpointError = { kind: 'timeout' };

describe('classifyHttpError', () => {
  it('maps 429 to rate_limit', () => {
    expect(classifyHttpError(429, '')).toEqual({ kind: 'rate_limit', status: 429 });
  });

  it('maps 402 to quota', () => {
    expect(classifyHttpError(402, '')).toEqual({ kind: 'quota', status: 402 });
  });

  it('maps 403 to quota', () => {
    expect(classifyHttpError(403, '')).toEqual({ kind: 'quota', status: 403 });
  });

  it('maps any status whose body mentions insufficient_user_quota to quota', () => {
    expect(classifyHttpError(400, '{"error":{"code":"insufficient_user_quota"}}')).toEqual({
      kind: 'quota',
      status: 400,
    });
  });

  it('maps other 4xx and 5xx to http', () => {
    expect(classifyHttpError(400, 'bad request')).toEqual({ kind: 'http', status: 400 });
    expect(classifyHttpError(500, 'boom')).toEqual({ kind: 'http', status: 500 });
    expect(classifyHttpError(503, '')).toEqual({ kind: 'http', status: 503 });
  });
});

describe('EndpointPool', () => {
  it('picks the first enabled endpoint in configuration order', () => {
    const pool = new EndpointPool([makeEndpoint('a'), makeEndpoint('b')], { now: makeClock().now });
    expect(pool.pick('flash').name).toBe('a');
    expect(pool.pick('pro').name).toBe('a');
  });

  it('skips disabled endpoints', () => {
    const pool = new EndpointPool([makeEndpoint('a', { enabled: false }), makeEndpoint('b')], {
      now: makeClock().now,
    });
    expect(pool.pick('flash').name).toBe('b');
  });

  it('fails over to the next endpoint after a 429', () => {
    const clock = makeClock();
    const pool = new EndpointPool([makeEndpoint('a'), makeEndpoint('b')], { now: clock.now });
    pool.reportFailure('a', classifyHttpError(429, ''));
    expect(pool.pick('flash').name).toBe('b');
  });

  it('skips an endpoint while its backoff window is active and restores it when expired', () => {
    const clock = makeClock(1_000);
    const pool = new EndpointPool([makeEndpoint('a'), makeEndpoint('b')], { now: clock.now });
    pool.reportFailure('a', RATE_LIMIT);

    clock.advance(29_999);
    expect(pool.pick('flash').name).toBe('b');

    clock.advance(1);
    expect(pool.pick('flash').name).toBe('a');
  });

  it('grows rate-limit backoff exponentially: 30s, 60s, 120s', () => {
    const clock = makeClock(0);
    const pool = new EndpointPool([makeEndpoint('a'), makeEndpoint('b')], { now: clock.now });

    pool.reportFailure('a', RATE_LIMIT);
    expect(pool.pick('flash').name).toBe('b');

    clock.advance(30_000);
    expect(pool.pick('flash').name).toBe('a');

    pool.reportFailure('a', RATE_LIMIT);
    clock.advance(59_999);
    expect(pool.pick('flash').name).toBe('b');
    clock.advance(1);
    expect(pool.pick('flash').name).toBe('a');

    pool.reportFailure('a', RATE_LIMIT);
    clock.advance(119_999);
    expect(pool.pick('flash').name).toBe('b');
    clock.advance(1);
    expect(pool.pick('flash').name).toBe('a');
  });

  it('caps backoff at 30 minutes', () => {
    const clock = makeClock(0);
    const pool = new EndpointPool([makeEndpoint('a'), makeEndpoint('b')], { now: clock.now });

    // Failures 1..7 would be 30s, 60s, 120s, 240s, 480s, 960s, 1920s (capped to 1800s).
    for (let i = 0; i < 7; i += 1) {
      pool.reportFailure('a', RATE_LIMIT);
    }

    clock.advance(1_799_999);
    expect(pool.pick('flash').name).toBe('b');
    clock.advance(1);
    expect(pool.pick('flash').name).toBe('a');
  });

  it('uses a 5s base for quota, timeout and network errors', () => {
    for (const kind of ['quota', 'timeout', 'network'] as const) {
      const clock = makeClock(0);
      const pool = new EndpointPool([makeEndpoint('a'), makeEndpoint('b')], { now: clock.now });
      pool.reportFailure('a', { kind });
      clock.advance(4_999);
      expect(pool.pick('flash').name).toBe('b');
      clock.advance(1);
      expect(pool.pick('flash').name).toBe('a');
    }
  });

  it('resets failure count on success', () => {
    const clock = makeClock(0);
    const pool = new EndpointPool([makeEndpoint('a'), makeEndpoint('b')], { now: clock.now });

    pool.reportFailure('a', RATE_LIMIT);
    clock.advance(30_000);
    pool.reportSuccess('a');

    pool.reportFailure('a', RATE_LIMIT);
    clock.advance(29_999);
    expect(pool.pick('flash').name).toBe('b');
    clock.advance(1);
    expect(pool.pick('flash').name).toBe('a');
  });

  it('reports all degraded and throws AllEndpointsDownError when every endpoint is in backoff', () => {
    const clock = makeClock(0);
    const pool = new EndpointPool([makeEndpoint('a'), makeEndpoint('b')], { now: clock.now });

    expect(pool.isAllDegraded()).toBe(false);

    pool.reportFailure('a', RATE_LIMIT);
    pool.reportFailure('b', RATE_LIMIT);

    expect(pool.isAllDegraded()).toBe(true);
    expect(() => pool.pick('flash')).toThrow(AllEndpointsDownError);

    clock.advance(30_000);
    expect(pool.isAllDegraded()).toBe(false);
    expect(pool.pick('flash').name).toBe('a');
  });

  it('treats a pool with no enabled endpoints as all degraded', () => {
    const pool = new EndpointPool([makeEndpoint('a', { enabled: false })], { now: makeClock().now });
    expect(pool.isAllDegraded()).toBe(true);
    expect(() => pool.pick('flash')).toThrow(AllEndpointsDownError);
  });

  it('ignores reports for unknown endpoint names', () => {
    const pool = new EndpointPool([makeEndpoint('a')], { now: makeClock().now });
    expect(() => pool.reportFailure('missing', NETWORK)).not.toThrow();
    expect(() => pool.reportSuccess('missing')).not.toThrow();
    expect(pool.pick('flash').name).toBe('a');
  });

  it('picks a healthy endpoint while another is degraded, then restores it after its backoff expires', () => {
    const clock = makeClock(0);
    const pool = new EndpointPool([makeEndpoint('a'), makeEndpoint('b')], { now: clock.now });
    pool.reportFailure('a', NETWORK);

    // a is in its backoff window, so the never-failed b is preferred.
    expect(pool.pick('flash').name).toBe('b');

    // Once a's backoff expires its remaining backoff is 0, same as b's, so the
    // stable sort keeps configuration order and a is selectable again.
    clock.advance(5_000);
    expect(pool.pick('flash').name).toBe('a');
  });

  it('orders candidates by remaining backoff', () => {
    // Configuration order is b, a, c, d, e; e is disabled and must be filtered out.
    const endpoints = [
      makeEndpoint('b'),
      makeEndpoint('a'),
      makeEndpoint('c'),
      makeEndpoint('d'),
      makeEndpoint('e', { enabled: false }),
    ];
    // At now = 4000: a has 1000ms remaining, b has 3000ms remaining.
    const state = new Map([
      ['a', { failures: 1, degradedUntil: 5_000 }],
      ['b', { failures: 2, degradedUntil: 7_000 }],
    ]);

    expect(endpointOrder(endpoints, state, 4_000).map(endpoint => endpoint.name)).toEqual([
      'c',
      'd',
      'a',
      'b',
    ]);
  });

  it('escalates the timeout backoff after 3 consecutive timeouts', () => {
    const clock = makeClock(0);
    const pool = new EndpointPool([makeEndpoint('a')], { now: clock.now });

    pool.reportFailure('a', TIMEOUT);
    pool.reportFailure('a', TIMEOUT);
    pool.reportFailure('a', TIMEOUT);

    // Third consecutive timeout escalates to the rate-limit base: 30s
    // (the old implementation produced 5s * 2^2 = 20s here).
    clock.advance(29_999);
    expect(() => pool.pick('flash')).toThrow(AllEndpointsDownError);
    clock.advance(1);
    expect(pool.pick('flash').name).toBe('a');
  });
});

describe('EndpointPool tier selection', () => {
  it('serves flash and pro requests from endpoints tagged for their tier', () => {
    const pool = new EndpointPool(
      [makeEndpoint('flash-only', { tier: 'flash' }), makeEndpoint('pro-only', { tier: 'pro' })],
      { now: makeClock().now },
    );
    expect(pool.pick('flash').name).toBe('flash-only');
    expect(pool.pick('pro').name).toBe('pro-only');
  });

  it('treats endpoints without a tier as both', () => {
    const pool = new EndpointPool([makeEndpoint('legacy')], { now: makeClock().now });
    expect(pool.pick('flash').name).toBe('legacy');
    expect(pool.pick('pro').name).toBe('legacy');
  });

  it('serves both tiers from a both endpoint', () => {
    const pool = new EndpointPool([makeEndpoint('a', { tier: 'both' })], { now: makeClock().now });
    expect(pool.pick('flash').name).toBe('a');
    expect(pool.pick('pro').name).toBe('a');
  });

  it('never falls back to a flash-only endpoint for a pro request', () => {
    const pool = new EndpointPool([makeEndpoint('a', { tier: 'flash' })], {
      now: makeClock().now,
    });
    expect(() => pool.pick('pro')).toThrow(AllEndpointsDownError);
  });

  it('combines tier filtering with exclusion', () => {
    const pool = new EndpointPool(
      [
        makeEndpoint('a', { tier: 'flash' }),
        makeEndpoint('b', { tier: 'pro' }),
        makeEndpoint('c', { tier: 'both' }),
      ],
      { now: makeClock().now },
    );
    expect(pool.pick('pro', new Set(['c'])).name).toBe('b');
    expect(() => pool.pick('pro', new Set(['b', 'c']))).toThrow(AllEndpointsDownError);
    expect(pool.pick('flash', new Set(['a'])).name).toBe('c');
  });
});

describe('EndpointPool.snapshot', () => {
  it('reports healthy endpoints with zero remaining backoff', () => {
    const pool = new EndpointPool(
      [makeEndpoint('a', { provider: 'nvidia_nim' }), makeEndpoint('b', { enabled: false })],
      { now: makeClock(1_000).now },
    );
    expect(pool.snapshot()).toEqual([
      {
        name: 'a',
        provider: 'nvidia_nim',
        enabled: true,
        tier: 'both',
        remainingBackoffMs: 0,
        degraded: false,
        failures: 0,
      },
      {
        name: 'b',
        provider: 'unknown',
        enabled: false,
        tier: 'both',
        remainingBackoffMs: 0,
        degraded: false,
        failures: 0,
      },
    ]);
  });

  it('records the last error kind, status and clock time', () => {
    const clock = makeClock(5_000);
    const pool = new EndpointPool([makeEndpoint('a')], { now: clock.now });

    pool.reportFailure('a', classifyHttpError(429, ''));

    expect(pool.snapshot()).toEqual([
      {
        name: 'a',
        provider: 'unknown',
        enabled: true,
        tier: 'both',
        remainingBackoffMs: 30_000,
        degraded: true,
        failures: 1,
        lastError: { kind: 'rate_limit', status: 429, at: 5_000 },
      },
    ]);

    clock.advance(30_000);
    expect(pool.snapshot()[0]).toMatchObject({
      remainingBackoffMs: 0,
      degraded: false,
      failures: 1,
      lastError: { kind: 'rate_limit', status: 429, at: 5_000 },
    });
  });

  it('omits status when the error carries none', () => {
    const pool = new EndpointPool([makeEndpoint('a')], { now: makeClock(0).now });
    pool.reportFailure('a', NETWORK);
    expect(pool.snapshot()[0]?.lastError).toEqual({ kind: 'network', at: 0 });
  });

  it('resets failures and backoff but retains the last error after a success', () => {
    const pool = new EndpointPool([makeEndpoint('a')], { now: makeClock(0).now });
    pool.reportFailure('a', RATE_LIMIT);
    pool.reportSuccess('a');
    expect(pool.snapshot()[0]).toMatchObject({
      failures: 0,
      degraded: false,
      remainingBackoffMs: 0,
      lastError: { kind: 'rate_limit', at: 0 },
    });
  });
});

describe('EndpointPool initialStates', () => {
  it('restores migrated health state by endpoint name', () => {
    const clock = makeClock(1_000);
    const initialStates = new Map([['a', { failures: 2, degradedUntil: 31_000 }]]);
    const pool = new EndpointPool([makeEndpoint('a'), makeEndpoint('b')], {
      now: clock.now,
      initialStates,
    });

    expect(pool.pick('flash').name).toBe('b');
    expect(pool.snapshot()[0]).toMatchObject({
      failures: 2,
      degraded: true,
      remainingBackoffMs: 30_000,
    });
    expect(pool.snapshot()[1]).toMatchObject({ failures: 0, degraded: false });
  });

  it('ignores initial state for endpoints that no longer exist', () => {
    const clock = makeClock(0);
    const initialStates = new Map([['gone', { failures: 3, degradedUntil: 60_000 }]]);
    const pool = new EndpointPool([makeEndpoint('a')], { now: clock.now, initialStates });
    expect(pool.pick('flash').name).toBe('a');
    expect(pool.snapshot().map(entry => entry.name)).toEqual(['a']);
  });
});

describe('migrateEndpointStates', () => {
  it('keeps state only for endpoints whose name, baseUrl and apiKey are unchanged', () => {
    const clock = makeClock(0);
    const previous = new EndpointPool(
      [
        makeEndpoint('same'),
        makeEndpoint('key-changed'),
        makeEndpoint('url-changed'),
        makeEndpoint('removed'),
      ],
      { now: clock.now },
    );
    for (const name of ['same', 'key-changed', 'url-changed', 'removed']) {
      previous.reportFailure(name, RATE_LIMIT);
    }

    const nextEndpoints = [
      makeEndpoint('same'),
      makeEndpoint('key-changed', { apiKey: 'rotated' }),
      makeEndpoint('url-changed', { baseUrl: 'https://elsewhere.example.test/v1' }),
      makeEndpoint('brand-new'),
    ];
    const migrated = migrateEndpointStates(previous, nextEndpoints);

    expect([...migrated.keys()]).toEqual(['same']);
    expect(migrated.get('same')).toEqual({
      failures: 1,
      degradedUntil: 30_000,
      lastError: { kind: 'rate_limit', at: 0 },
    });
  });

  it('produces states that a rebuilt pool can start from', () => {
    const clock = makeClock(0);
    const previous = new EndpointPool([makeEndpoint('a')], { now: clock.now });
    previous.reportFailure('a', RATE_LIMIT);

    const migrated = migrateEndpointStates(previous, [makeEndpoint('a'), makeEndpoint('b')]);
    const rebuilt = new EndpointPool([makeEndpoint('a'), makeEndpoint('b')], {
      now: clock.now,
      initialStates: migrated,
    });

    expect(rebuilt.pick('flash').name).toBe('b');
    expect(rebuilt.snapshot().map(entry => entry.failures)).toEqual([1, 0]);
  });
});

describe('brain types', () => {
  it('exposes the chat wire types', () => {
    const toolCall: ToolCall = {
      id: 'call-1',
      type: 'function',
      function: { name: 'ping', arguments: '{}' },
    };
    const message: ChatMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [toolCall],
    };
    const tool: ToolDef = {
      type: 'function',
      function: { name: 'ping', description: 'ping', parameters: {} },
    };
    const usage: Usage = { promptTokens: 1, completionTokens: 2 };

    expect(message.tool_calls?.[0]?.id).toBe('call-1');
    expect(tool.type).toBe('function');
    expect(usage.promptTokens).toBe(1);
  });
});
