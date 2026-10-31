import { describe, expect, it } from 'vitest';
import type { RouteContext, RouteHandler } from '../../src/web/server.js';
import { createArchitectureApi, type ArchitectureSnapshot } from '../../src/web/architecture.js';

interface HandlerResponse {
  status: number;
  body: ArchitectureSnapshot;
}

function callArchitecture(handler: RouteHandler): Promise<HandlerResponse> {
  return new Promise((resolve) => {
    const ctx = {
      send: (status: number, value: unknown) =>
        resolve({ status, body: value as ArchitectureSnapshot }),
    } as unknown as RouteContext;
    void Promise.resolve(handler(ctx));
  });
}

function deps(overrides: Partial<Parameters<typeof createArchitectureApi>[0]> = {}) {
  return {
    endpoints: () => [
      { name: 'nim-1', enabled: true, degraded: false },
      { name: 'agnes', enabled: true, degraded: true },
    ],
    queueSize: () => 12,
    silentRounds: () => 4,
    inFlight: () => true,
    plugins: () => [
      { name: 'qq', kind: 'channel', state: 'active' },
      { name: 'probe', kind: 'capability', state: 'stopped' },
    ],
    capabilities: () => [{ name: 'memory', state: 'active' }],
    ...overrides,
  };
}

describe('GET /api/architecture', () => {
  it('returns the static graph with every expected node and no dangling edge', async () => {
    const api = createArchitectureApi(deps());
    const response = await callArchitecture(api.handlers.architecture);

    expect(response.status).toBe(200);
    const ids = response.body.nodes.map((node) => node.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'brain',
        'endpoints',
        'queue',
        'loop',
        'plugins',
        'capabilities',
        'memory',
        'web',
      ]),
    );

    const known = new Set(ids);
    for (const edge of response.body.edges) {
      expect(known.has(edge.from)).toBe(true);
      expect(known.has(edge.to)).toBe(true);
    }

    const memory = response.body.nodes.find((node) => node.id === 'memory');
    expect(memory?.planned).toBe(true);
    expect(response.body.status['memory']?.state).toBe('planned');
  });

  it('reports live status from the injected callbacks', async () => {
    const api = createArchitectureApi(deps());
    const { body } = await callArchitecture(api.handlers.architecture);

    expect(body.status['endpoints']?.state).toBe('degraded');
    expect(body.status['endpoints']?.detail).toContain('1');
    expect(body.status['queue']?.detail).toContain('12');
    expect(body.status['loop']?.detail).toContain('4');
    expect(body.status['loop']?.detail).toContain('在途');
    expect(body.status['plugins']?.detail).toContain('1/2');
    expect(body.status['capabilities']?.detail).toContain('1');
    expect(body.status['web']?.state).toBe('ok');
  });

  it('marks capabilities degraded and counts failed/crashed/banned states', async () => {
    const api = createArchitectureApi(
      deps({
        capabilities: () => [
          { name: 'a', state: 'active' },
          { name: 'b', state: 'failed' },
          { name: 'c', state: 'crashed' },
          { name: 'd', state: 'banned' },
        ],
      }),
    );
    const { body } = await callArchitecture(api.handlers.architecture);

    expect(body.status['capabilities']?.state).toBe('degraded');
    const detail = body.status['capabilities']?.detail ?? '';
    expect(detail).toContain('1/4');
    expect(detail).toContain('1 failed');
    expect(detail).toContain('1 crashed');
    expect(detail).toContain('1 banned');
  });

  it('keeps capabilities ok when every capability is active', async () => {
    const api = createArchitectureApi(
      deps({
        capabilities: () => [
          { name: 'a', state: 'active' },
          { name: 'b', state: 'active' },
        ],
      }),
    );
    const { body } = await callArchitecture(api.handlers.architecture);

    expect(body.status['capabilities']?.state).toBe('ok');
    expect(body.status['capabilities']?.detail).toContain('2/2');
  });

  it('degrades capabilities when none are active', async () => {
    const api = createArchitectureApi(
      deps({
        capabilities: () => [
          { name: 'a', state: 'pending' },
          { name: 'b', state: 'stopped' },
        ],
      }),
    );
    const { body } = await callArchitecture(api.handlers.architecture);

    expect(body.status['capabilities']?.state).toBe('degraded');
    expect(body.status['capabilities']?.detail).toContain('0/2');
  });

  it('reports an empty capability set as ok', async () => {
    const api = createArchitectureApi(deps({ capabilities: () => [] }));
    const { body } = await callArchitecture(api.handlers.architecture);

    expect(body.status['capabilities']?.state).toBe('ok');
  });

  it('marks endpoints and plugins as degraded when nothing is usable', async () => {
    const api = createArchitectureApi(
      deps({
        endpoints: () => [{ name: 'nim-1', enabled: false, degraded: false }],
        plugins: () => [{ name: 'qq', kind: 'channel', state: 'stopped' }],
        inFlight: () => false,
      }),
    );
    const { body } = await callArchitecture(api.handlers.architecture);

    expect(body.status['endpoints']?.state).toBe('degraded');
    expect(body.status['brain']?.state).toBe('degraded');
    expect(body.status['plugins']?.state).toBe('degraded');
    expect(body.status['loop']?.detail).not.toContain('在途');
  });
});
