import { describe, expect, it, vi } from 'vitest';
import type { PerceptionEvent } from '../src/core/events.js';
import type { ControlProactiveState } from '../src/control/state-store.js';
import {
  NO_REPLY_TOKEN,
  PROACTIVE_PROMPT,
  ProactiveScheduler,
  type ProactiveSchedulerOptions,
} from '../src/core/proactive.js';

const OWNER = '10001';

/** 本地时间构造，避免测试依赖时区。 */
function localTime(hour: number, minute = 0): number {
  return new Date(2026, 9, 30, hour, minute, 0, 0).getTime();
}

interface Harness {
  scheduler: ProactiveScheduler;
  pushes: PerceptionEvent[];
  wake: ReturnType<typeof vi.fn<() => void>>;
  state: {
    value: ControlProactiveState;
    setProactive: ReturnType<typeof vi.fn>;
  };
}

function harness(overrides: Partial<ProactiveSchedulerOptions> = {}): Harness {
  const pushes: PerceptionEvent[] = [];
  const wake = vi.fn<() => void>();
  const state: Harness['state'] = {
    value: {},
    setProactive: vi.fn(async (patch: Partial<ControlProactiveState>) => {
      state.value = { ...state.value, ...patch };
    }),
  };
  let seq = 0;
  const deps: ProactiveSchedulerOptions = {
    enabled: true,
    owner: OWNER,
    isConnected: () => true,
    queueSize: () => 0,
    inFlight: () => false,
    silentRounds: () => 0,
    state: {
      proactive: () => ({ ...state.value }),
      setProactive: state.setProactive,
    },
    queue: {
      push: (event) => pushes.push(event),
      requestWake: wake,
      nextEventId: () => `evt-${++seq}`,
    },
    now: () => localTime(12),
    minGapMs: 6 * 60 * 60_000,
    dailyMax: 2,
    quietStart: '23:00',
    quietEnd: '08:00',
    log: () => undefined,
    ...overrides,
  };
  return {
    scheduler: new ProactiveScheduler(deps),
    pushes,
    wake,
    state,
  };
}

describe('ProactiveScheduler gates', () => {
  it('is off by default and pushes nothing', async () => {
    const h = harness({ enabled: false });
    await expect(h.scheduler.runOnce()).resolves.toBe(false);
    expect(h.pushes).toHaveLength(0);
    expect(h.wake).not.toHaveBeenCalled();
  });

  it('requires a known owner', async () => {
    const h = harness({ owner: undefined });
    await expect(h.scheduler.runOnce()).resolves.toBe(false);
    expect(h.pushes).toHaveLength(0);
  });

  it('requires a connected qq channel', async () => {
    const h = harness({ isConnected: () => false });
    await expect(h.scheduler.runOnce()).resolves.toBe(false);
    expect(h.pushes).toHaveLength(0);
  });

  it('refuses to run when the queue is not empty, a tick is in flight, or the loop is silent', async () => {
    await expect(harness({ queueSize: () => 1 }).scheduler.runOnce()).resolves.toBe(false);
    await expect(harness({ inFlight: () => true }).scheduler.runOnce()).resolves.toBe(false);
    await expect(harness({ silentRounds: () => 1 }).scheduler.runOnce()).resolves.toBe(false);
  });

  it('does not spend a tick while the global quiet gate is closed', async () => {
    const h = harness({ isGloballySilenced: () => true });

    await expect(h.scheduler.runOnce()).resolves.toBe(false);
    expect(h.pushes).toHaveLength(0);
    expect(h.wake).not.toHaveBeenCalled();
    expect(h.state.setProactive).not.toHaveBeenCalled();
  });

  it('enforces the minimum gap since the last proactive message', async () => {
    const now = localTime(12);
    const h = harness({ now: () => now });
    h.state.value = { lastSentAt: now - 60_000, dayKey: '2026-10-30', sentToday: 1 };

    await expect(h.scheduler.runOnce()).resolves.toBe(false);
    expect(h.pushes).toHaveLength(0);
  });

  it('enforces the daily maximum', async () => {
    const h = harness();
    h.state.value = { lastSentAt: localTime(0), dayKey: '2026-10-30', sentToday: 2 };

    await expect(h.scheduler.runOnce()).resolves.toBe(false);
    expect(h.pushes).toHaveLength(0);
  });

  it('resets the daily counter on a new local day', async () => {
    const h = harness();
    h.state.value = { lastSentAt: localTime(0) - 24 * 60 * 60_000, dayKey: '2026-10-29', sentToday: 2 };

    await expect(h.scheduler.runOnce()).resolves.toBe(true);
  });

  it('stays quiet during the quiet window, including across midnight', async () => {
    await expect(harness({ now: () => localTime(23, 30) }).scheduler.runOnce()).resolves.toBe(false);
    await expect(harness({ now: () => localTime(2, 0) }).scheduler.runOnce()).resolves.toBe(false);
    await expect(harness({ now: () => localTime(8, 0) }).scheduler.runOnce()).resolves.toBe(true);
  });
});

describe('ProactiveScheduler tick', () => {
  it('pushes one synthetic proactive_tick event and requests a wake', async () => {
    const h = harness();
    await expect(h.scheduler.runOnce()).resolves.toBe(true);

    expect(h.pushes).toHaveLength(1);
    const event = h.pushes[0]!;
    expect(event).toMatchObject({
      id: 'evt-1',
      kind: 'proactive_tick',
      channel: `qq:private:${OWNER}`,
      actor: 'system',
      importance: 4,
      synthetic: true,
      content: PROACTIVE_PROMPT,
    });
    expect(event.ts).toBe(localTime(12));
    expect(h.wake).toHaveBeenCalledTimes(1);
    expect(h.state.setProactive).toHaveBeenCalledWith({
      lastSentAt: localTime(12),
      dayKey: '2026-10-30',
      sentToday: 1,
    });
  });

  it('increments the counter within the same day', async () => {
    const h = harness();
    h.state.value = { lastSentAt: localTime(6), dayKey: '2026-10-30', sentToday: 1 };

    await expect(h.scheduler.runOnce()).resolves.toBe(true);
    expect(h.state.setProactive).toHaveBeenCalledWith({
      lastSentAt: localTime(12),
      dayKey: '2026-10-30',
      sentToday: 2,
    });
  });

  it('swallows a failing state write and still pushes', async () => {
    const setProactive = vi.fn(async () => {
      throw new Error('disk full');
    });
    const h = harness({
      state: { proactive: () => ({}), setProactive },
    });

    await expect(h.scheduler.runOnce()).resolves.toBe(true);
    expect(h.pushes).toHaveLength(1);
  });
});

describe('NO_REPLY_TOKEN', () => {
  it('is the fixed sentinel consumed by the heartbeat loop', () => {
    expect(NO_REPLY_TOKEN).toBe('（不发言）');
    expect(PROACTIVE_PROMPT).toContain(NO_REPLY_TOKEN);
  });
});
