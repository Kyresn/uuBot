import type { EndpointConfig, EndpointTier, RequestTier } from '../config.js';

export type EndpointError = {
  kind: 'rate_limit' | 'quota' | 'timeout' | 'network' | 'http';
  status?: number;
};

/** Last observed failure for an endpoint, used by the web console. */
export type EndpointLastError = {
  kind: EndpointError['kind'];
  status?: number;
  at: number;
};

/** Health snapshot of one endpoint, as exposed by the web console. */
export type EndpointSnapshot = {
  name: string;
  provider: string;
  enabled: boolean;
  /** Normalized tier (`both` when the config omits it); readiness uses it. */
  tier: EndpointTier;
  remainingBackoffMs: number;
  degraded: boolean;
  failures: number;
  lastError?: EndpointLastError;
};

export class AllEndpointsDownError extends Error {
  constructor(message = 'all endpoints are degraded') {
    super(message);
    this.name = 'AllEndpointsDownError';
  }
}

const RATE_LIMIT_BASE_MS = 30_000;
const DEFAULT_BASE_MS = 5_000;
const MAX_BACKOFF_MS = 1_800_000;

export function classifyHttpError(status: number, bodyText: string): EndpointError {
  if (status === 429) return { kind: 'rate_limit', status };
  if (status === 402 || status === 403 || bodyText.includes('insufficient_user_quota')) {
    return { kind: 'quota', status };
  }
  return { kind: 'http', status };
}

export type EndpointState = {
  failures: number;
  degradedUntil: number;
  lastError?: EndpointLastError;
};

function cloneState(state: EndpointState): EndpointState {
  const clone: EndpointState = {
    failures: state.failures,
    degradedUntil: state.degradedUntil,
  };
  if (state.lastError !== undefined) clone.lastError = { ...state.lastError };
  return clone;
}

/**
 * Orders the enabled endpoints by remaining backoff ascending: never-failed or
 * recovered endpoints (0ms remaining) come first, then endpoints whose backoff
 * still has the least time left. Ties keep configuration order (stable sort).
 */
export function endpointOrder(
  endpoints: EndpointConfig[],
  state: ReadonlyMap<string, EndpointState>,
  now: number,
): EndpointConfig[] {
  return endpoints
    .filter(endpoint => endpoint.enabled)
    .map((endpoint, index) => {
      const degradedUntil = state.get(endpoint.name)?.degradedUntil;
      const remaining = degradedUntil === undefined ? 0 : Math.max(0, degradedUntil - now);
      return { endpoint, index, remaining };
    })
    .sort((a, b) => a.remaining - b.remaining || a.index - b.index)
    .map(entry => entry.endpoint);
}

type PoolOptions = {
  now?: () => number;
  /**
   * Health state to start from, keyed by endpoint name (hot-reload migration).
   * Entries for names that are not in `endpoints` are ignored; endpoints
   * without an entry start fresh.
   */
  initialStates?: ReadonlyMap<string, EndpointState>;
};

function servesTier(endpoint: EndpointConfig, tier: RequestTier): boolean {
  const endpointTier: EndpointTier = endpoint.tier ?? 'both';
  return endpointTier === 'both' || endpointTier === tier;
}

export class EndpointPool {
  private readonly endpoints: EndpointConfig[];
  private readonly now: () => number;
  private readonly state = new Map<string, EndpointState>();

  constructor(endpoints: EndpointConfig[], opts: PoolOptions = {}) {
    this.endpoints = endpoints;
    this.now = opts.now ?? Date.now;

    if (opts.initialStates !== undefined) {
      const names = new Set(endpoints.map(endpoint => endpoint.name));
      for (const [name, state] of opts.initialStates) {
        if (names.has(name)) this.state.set(name, cloneState(state));
      }
    }
  }

  pick(tier: RequestTier, exclude?: ReadonlySet<string>): EndpointConfig {
    const now = this.now();
    for (const endpoint of endpointOrder(this.endpoints, this.state, now)) {
      if (!servesTier(endpoint, tier)) continue;
      if (exclude?.has(endpoint.name) === true) continue;
      const state = this.state.get(endpoint.name);
      if (state !== undefined && state.degradedUntil > now) continue;
      return endpoint;
    }
    throw new AllEndpointsDownError(`no ${tier} endpoint available: all endpoints are degraded`);
  }

  /** Health of every configured endpoint, in configuration order. */
  snapshot(): EndpointSnapshot[] {
    const now = this.now();
    return this.endpoints.map(endpoint => {
      const state = this.state.get(endpoint.name);
      const remainingBackoffMs =
        state === undefined ? 0 : Math.max(0, state.degradedUntil - now);
      const entry: EndpointSnapshot = {
        name: endpoint.name,
        provider: endpoint.provider ?? 'unknown',
        enabled: endpoint.enabled,
        tier: endpoint.tier ?? 'both',
        remainingBackoffMs,
        degraded: remainingBackoffMs > 0,
        failures: state?.failures ?? 0,
      };
      if (state?.lastError !== undefined) entry.lastError = { ...state.lastError };
      return entry;
    });
  }

  /**
   * Health state that may be carried over to a rebuilt pool: only endpoints
   * whose name, baseUrl and apiKey are unchanged keep their state.
   */
  migrateStatesTo(nextEndpoints: EndpointConfig[]): Map<string, EndpointState> {
    const nextByName = new Map(nextEndpoints.map(endpoint => [endpoint.name, endpoint] as const));
    const migrated = new Map<string, EndpointState>();
    for (const previous of this.endpoints) {
      const next = nextByName.get(previous.name);
      if (next === undefined) continue;
      if (next.baseUrl !== previous.baseUrl || next.apiKey !== previous.apiKey) continue;
      const state = this.state.get(previous.name);
      if (state === undefined) continue;
      migrated.set(previous.name, cloneState(state));
    }
    return migrated;
  }

  reportFailure(name: string, error: EndpointError): void {
    const endpoint = this.endpoints.find(e => e.name === name);
    if (endpoint === undefined) return;

    const now = this.now();
    const failures = (this.state.get(name)?.failures ?? 0) + 1;
    // Three consecutive timeouts are treated like a rate-limit-level fault:
    // the backoff escalates to the 30s base and grows exponentially from there.
    const timeoutBreaker = error.kind === 'timeout' && failures >= 3;
    const base = error.kind === 'rate_limit' || timeoutBreaker ? RATE_LIMIT_BASE_MS : DEFAULT_BASE_MS;
    const exponent = timeoutBreaker ? failures - 3 : failures - 1;
    const backoff = Math.min(base * 2 ** exponent, MAX_BACKOFF_MS);
    const lastError: EndpointLastError = { kind: error.kind, at: now };
    if (error.status !== undefined) lastError.status = error.status;
    this.state.set(name, { failures, degradedUntil: now + backoff, lastError });
  }

  reportSuccess(name: string): void {
    const endpoint = this.endpoints.find(e => e.name === name);
    if (endpoint === undefined) return;

    // Reset failures and backoff, but keep the last failure classification: the
    // web console shows it until the endpoint fails again.
    const previous = this.state.get(name);
    const next: EndpointState = { failures: 0, degradedUntil: 0 };
    if (previous?.lastError !== undefined) next.lastError = { ...previous.lastError };
    this.state.set(name, next);
  }

  isAllDegraded(): boolean {
    const now = this.now();
    return this.endpoints
      .filter(endpoint => endpoint.enabled)
      .every(endpoint => {
        const state = this.state.get(endpoint.name);
        return state !== undefined && state.degradedUntil > now;
      });
  }
}

/**
 * Builds the initial state map for a pool rebuilt after a config reload.
 * State survives only for endpoints whose name, baseUrl and apiKey are
 * unchanged; removed or edited endpoints start fresh.
 */
export function migrateEndpointStates(
  previous: EndpointPool,
  nextEndpoints: EndpointConfig[],
): Map<string, EndpointState> {
  return previous.migrateStatesTo(nextEndpoints);
}
