import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PerceptionQueue, type PerceptionEvent } from '../src/core/events.js';

function makeEvent(overrides: Partial<PerceptionEvent> = {}): PerceptionEvent {
  return {
    id: 'evt-1',
    ts: 0,
    kind: 'system',
    channel: 'cli',
    actor: 'test',
    content: 'hello',
    importance: 5,
    ...overrides,
  };
}

describe('PerceptionQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onWake exactly once after the debounce window', () => {
    const queue = new PerceptionQueue();
    const wake = vi.fn();
    queue.onWake(wake);

    queue.requestWake();
    expect(wake).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2999);
    expect(wake).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(wake).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_000);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('does not extend the window when requestWake is called again inside it', () => {
    const queue = new PerceptionQueue();
    const wake = vi.fn();
    queue.onWake(wake);

    queue.requestWake();
    vi.advanceTimersByTime(2000);
    queue.requestWake();

    vi.advanceTimersByTime(999);
    expect(wake).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(wake).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_000);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('does not postpone the flush under sustained arrivals', () => {
    const queue = new PerceptionQueue();
    const wakeTimes: number[] = [];
    queue.onWake(() => wakeTimes.push(Date.now()));

    const startedAt = Date.now();
    queue.requestWake();

    // 20 calls, one every 500ms, starting at t=0.
    for (let i = 1; i < 20; i += 1) {
      vi.advanceTimersByTime(500);
      if (i * 500 < 3000) expect(wakeTimes).toHaveLength(0);
      queue.requestWake();
    }

    // First flush landed at first request + 3000ms, not last request + 3000ms.
    expect(wakeTimes.length).toBeGreaterThanOrEqual(1);
    expect(wakeTimes[0]! - startedAt).toBe(3000);
  });

  it('starts a fresh window for a wake requested after a flush', () => {
    const queue = new PerceptionQueue();
    const wake = vi.fn();
    queue.onWake(wake);

    queue.requestWake();
    vi.advanceTimersByTime(3000);
    expect(wake).toHaveBeenCalledTimes(1);

    queue.requestWake();
    vi.advanceTimersByTime(2999);
    expect(wake).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(wake).toHaveBeenCalledTimes(2);
  });

  it('honours an injected debounce window and injected timers', () => {
    const setTimeout = vi.fn((_callback: () => void, _ms: number) => 42);
    const clearTimeout = vi.fn();
    const queue = new PerceptionQueue({
      debounceMs: 750,
      timers: { setTimeout, clearTimeout },
    });
    const wake = vi.fn();
    queue.onWake(wake);

    queue.requestWake();
    queue.requestWake();

    expect(setTimeout).toHaveBeenCalledTimes(1);
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 750);

    const scheduled = setTimeout.mock.calls[0]?.[0];
    expect(scheduled).toBeTypeOf('function');
    scheduled?.();
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('notifies every registered wake callback', () => {
    const queue = new PerceptionQueue();
    const first = vi.fn();
    const second = vi.fn();
    queue.onWake(first);
    queue.onWake(second);

    queue.requestWake();
    vi.advanceTimersByTime(3000);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('drains pushed events in order and clears the queue', () => {
    const queue = new PerceptionQueue();
    const first = makeEvent({ id: 'a' });
    const second = makeEvent({ id: 'b' });

    queue.push(first);
    queue.push(second);

    expect(queue.drain()).toEqual([first, second]);
    expect(queue.drain()).toEqual([]);
  });

  it('prepends events in order ahead of anything already queued', () => {
    const queue = new PerceptionQueue();
    const late = makeEvent({ id: 'late' });
    queue.push(late);

    const first = makeEvent({ id: 'a' });
    const second = makeEvent({ id: 'b' });
    queue.prepend([first, second]);

    expect(queue.drain()).toEqual([first, second, late]);
  });

  it('evicts the lowest-importance oldest event when the queue exceeds maxSize', () => {
    const log = vi.fn<(line: string) => void>();
    const queue = new PerceptionQueue({ maxSize: 500, log });
    for (let i = 0; i < 500; i += 1) {
      queue.push(makeEvent({ id: `e${i}`, importance: 3 }));
    }

    // 第 501 条重要度更高：淘汰的是最旧的低重要度事件，不是新事件。
    queue.push(makeEvent({ id: 'high', kind: 'qq_private_message', importance: 9 }));

    const drained = queue.drain();
    expect(drained).toHaveLength(500);
    expect(drained[0]?.id).toBe('e1');
    expect(drained.some((event) => event.id === 'high')).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/evicted system.*importance=3.*size=500/));
  });

  it('keeps a high-importance event while evicting an older low-importance one', () => {
    const queue = new PerceptionQueue({ maxSize: 2 });
    queue.push(makeEvent({ id: 'low-old', importance: 1 }));
    queue.push(makeEvent({ id: 'low-new', importance: 2 }));
    queue.push(makeEvent({ id: 'high', importance: 9 }));

    expect(queue.drain().map((event) => event.id)).toEqual(['low-new', 'high']);
  });

  it('enforces maxSize on prepend and keeps the requeued events', () => {
    const log = vi.fn<(line: string) => void>();
    const queue = new PerceptionQueue({ maxSize: 3, log });
    queue.push(makeEvent({ id: 'old-low', importance: 1 }));
    queue.push(makeEvent({ id: 'old-mid', importance: 5 }));
    queue.push(makeEvent({ id: 'old-high', importance: 8 }));

    queue.prepend([
      makeEvent({ id: 'new-a', importance: 9 }),
      makeEvent({ id: 'new-b', importance: 7 }),
    ]);

    // 5 条 → 淘汰两条最低重要度，重排的高优先级事件保留。
    expect(queue.drain().map((event) => event.id)).toEqual(['new-a', 'new-b', 'old-high']);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/evicted.*importance=1/));
  });

  it('generates event ids through an injected generator', () => {
    const queue = new PerceptionQueue();
    const ids = ['id-1', 'id-2'];
    let index = 0;
    queue.setSizeGen(() => ids[index++] ?? 'fallback');

    expect(queue.nextEventId()).toBe('id-1');
    expect(queue.nextEventId()).toBe('id-2');
  });

  it('reports every pushed event through the optional onPush hook at enqueue time', () => {
    const pushed: PerceptionEvent[] = [];
    const queue = new PerceptionQueue({ onPush: (event) => pushed.push(event) });
    const first = makeEvent({ id: 'a' });
    const second = makeEvent({ id: 'b' });

    queue.push(first);
    queue.push(second);

    expect(pushed).toEqual([first, second]);
    // The hook observes the event; it must not consume it from the queue.
    expect(queue.size()).toBe(2);
  });

  it('survives a throwing onPush hook', () => {
    const log = vi.fn<(line: string) => void>();
    const queue = new PerceptionQueue({
      log,
      onPush: () => {
        throw new Error('recorder exploded');
      },
    });

    expect(() => queue.push(makeEvent())).not.toThrow();
    expect(queue.size()).toBe(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('onPush failed'));
  });
});
