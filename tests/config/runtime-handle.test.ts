import { describe, it, expect } from 'vitest';
import {
  parseHarnessConfig,
  type HarnessConfig,
} from '../../src/config/harness-schema.js';
import { RuntimeConfigHandle } from '../../src/config/runtime-handle.js';

function configWithFastMs(fastMs: number): HarnessConfig {
  const parsed = parseHarnessConfig({
    version: 1,
    tick: { fastMs, slowMs: 3_600_000, wakeDebounceMs: 2_000 },
  });
  if (!parsed.ok) throw new Error(`config must parse: ${parsed.code}`);
  return parsed.value;
}

describe('RuntimeConfigHandle', () => {
  it('returns the initial config from get()', () => {
    const initial = configWithFastMs(3_000);
    const handle = new RuntimeConfigHandle(initial);
    expect(handle.get()).toBe(initial);
  });

  it('swaps to the next config and notifies subscribers with it', () => {
    const handle = new RuntimeConfigHandle(configWithFastMs(3_000));
    const seen: HarnessConfig[] = [];
    handle.subscribe((config) => seen.push(config));

    const next = configWithFastMs(4_000);
    handle.swap(next);

    expect(handle.get()).toBe(next);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(next);
  });

  it('does not notify after unsubscribe', () => {
    const handle = new RuntimeConfigHandle(configWithFastMs(3_000));
    const seen: HarnessConfig[] = [];
    const unsubscribe = handle.subscribe((config) => seen.push(config));

    handle.swap(configWithFastMs(4_000));
    unsubscribe();
    handle.swap(configWithFastMs(5_000));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.tick.fastMs).toBe(4_000);
  });

  it('notifies every subscriber, including duplicates registered separately', () => {
    const handle = new RuntimeConfigHandle(configWithFastMs(3_000));
    const first: number[] = [];
    const second: number[] = [];
    const listener = (config: HarnessConfig): void => {
      first.push(config.tick.fastMs);
    };
    handle.subscribe(listener);
    handle.subscribe((config) => second.push(config.tick.fastMs));

    handle.swap(configWithFastMs(4_000));

    expect(first).toEqual([4_000]);
    expect(second).toEqual([4_000]);
  });

  it('isolates a throwing subscriber so the others still run', () => {
    const handle = new RuntimeConfigHandle(configWithFastMs(3_000));
    const seen: number[] = [];
    handle.subscribe(() => {
      throw new Error('listener failed');
    });
    handle.subscribe((config) => seen.push(config.tick.fastMs));

    expect(() => handle.swap(configWithFastMs(4_000))).not.toThrow();
    expect(seen).toEqual([4_000]);
  });

  it('unsubscribe is idempotent and a re-subscribed listener works again', () => {
    const handle = new RuntimeConfigHandle(configWithFastMs(3_000));
    const seen: number[] = [];
    const listener = (config: HarnessConfig): void => {
      seen.push(config.tick.fastMs);
    };

    const unsubscribe = handle.subscribe(listener);
    unsubscribe();
    unsubscribe();
    handle.subscribe(listener);
    handle.swap(configWithFastMs(4_000));

    expect(seen).toEqual([4_000]);
  });
});
