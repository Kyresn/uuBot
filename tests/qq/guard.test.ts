import { describe, expect, it } from 'vitest';
import {
  GroupGuard,
  type GuardOperatorState,
} from '../../plugins/channels/qq/guard.js';

const MIN_GAP = 90_000;
const MAX_GAP = 30 * 60_000;
const OBSERVATION = 24 * 60 * 60_000;

interface Clock {
  now: () => number;
  advance: (ms: number) => void;
}

/** 可手动推进的时钟，避免测试依赖真实时间。 */
function makeClock(start = 1_000_000): Clock {
  let time = start;
  return {
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
  };
}

describe('qq group guard', () => {
  it('allows the first message in a group', () => {
    const guard = new GroupGuard({ now: makeClock().now });

    expect(guard.allow('1')).toEqual({ ok: true });
  });

  it('blocks a second message inside the default 90s gap', () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });
    guard.recordSpoken('1');

    clock.advance(MIN_GAP - 1);
    expect(guard.allow('1')).toEqual({ ok: false, reason: 'min-gap' });

    clock.advance(1);
    expect(guard.allow('1')).toEqual({ ok: true });
  });

  it('honours a custom minGapMs', () => {
    const clock = makeClock();
    const guard = new GroupGuard({ minGapMs: 5_000, now: clock.now });
    guard.recordSpoken('1');

    clock.advance(4_999);
    expect(guard.allow('1')).toEqual({ ok: false, reason: 'min-gap' });

    clock.advance(1);
    expect(guard.allow('1')).toEqual({ ok: true });
  });

  it('tracks groups independently', () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });
    guard.recordSpoken('1');

    expect(guard.allow('2')).toEqual({ ok: true });
  });

  it('lets a response clear the cooldown immediately', () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });
    guard.recordSpoken('1');
    clock.advance(1_000);

    guard.recordResponse('1');

    expect(guard.allow('1')).toEqual({ ok: true });
  });

  it('doubles the gap after two silent rounds', () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });
    guard.recordSpoken('1');
    clock.advance(MIN_GAP);
    expect(guard.allow('1')).toEqual({ ok: true });

    guard.recordSpoken('1');
    clock.advance(MIN_GAP + 1);
    expect(guard.allow('1')).toEqual({ ok: false, reason: 'min-gap' });

    clock.advance(MIN_GAP - 1);
    expect(guard.allow('1')).toEqual({ ok: true });
  });

  it('keeps doubling up to a 30 minute cap', () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });
    for (let round = 0; round < 12; round += 1) {
      guard.recordSpoken('1');
      clock.advance(MAX_GAP);
    }

    guard.recordSpoken('1');
    clock.advance(MAX_GAP - 1);
    expect(guard.allow('1')).toEqual({ ok: false, reason: 'min-gap' });

    clock.advance(1);
    expect(guard.allow('1')).toEqual({ ok: true });
  });

  it('resets the escalated gap after a response', () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });
    guard.recordSpoken('1');
    clock.advance(MIN_GAP);
    guard.recordSpoken('1');
    clock.advance(MIN_GAP);

    guard.recordResponse('1');
    guard.recordSpoken('1');
    clock.advance(MIN_GAP - 1);
    expect(guard.allow('1')).toEqual({ ok: false, reason: 'min-gap' });

    clock.advance(1);
    expect(guard.allow('1')).toEqual({ ok: true });
  });

  it('treats a message 4:59 after speaking as a response', () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });
    guard.recordSpoken('1');
    clock.advance(MIN_GAP);
    // 连续两轮无回应 → 间隔翻倍到 180s。
    guard.recordSpoken('1');
    clock.advance(4 * 60_000 + 59_000);

    guard.recordResponse('1');
    guard.recordSpoken('1');

    // 已重置回默认间隔：89.999s 后仍被拦，90s 放行。
    clock.advance(MIN_GAP - 1);
    expect(guard.allow('1')).toEqual({ ok: false, reason: 'min-gap' });
    clock.advance(1);
    expect(guard.allow('1')).toEqual({ ok: true });
  });

  it('does not treat a message 5:01 after speaking as a response', () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });
    guard.recordSpoken('1');
    clock.advance(MIN_GAP);
    // 间隔已翻倍到 180s。
    guard.recordSpoken('1');
    clock.advance(5 * 60_000 + 1_000);

    // 新对话不是回应：升级不清零。
    guard.recordResponse('1');
    guard.recordSpoken('1');

    // 再翻倍到 360s：90s 后仍被拦。
    clock.advance(MIN_GAP);
    expect(guard.allow('1')).toEqual({ ok: false, reason: 'min-gap' });
    clock.advance(3 * MIN_GAP);
    expect(guard.allow('1')).toEqual({ ok: true });
  });

  it('enters observation mode for 24h after a warning', () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });

    guard.recordWarning('1');
    expect(guard.isObserving('1')).toBe(true);
    expect(guard.allow('1')).toEqual({ ok: false, reason: 'observation' });

    clock.advance(OBSERVATION - 1);
    expect(guard.isObserving('1')).toBe(true);
    expect(guard.allow('1')).toEqual({ ok: false, reason: 'observation' });

    clock.advance(1);
    expect(guard.isObserving('1')).toBe(false);
    expect(guard.allow('1')).toEqual({ ok: true });
  });

  it('lets observation override an otherwise expired gap', () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });
    guard.recordSpoken('1');
    clock.advance(MIN_GAP);

    guard.recordWarning('1');

    expect(guard.allow('1')).toEqual({ ok: false, reason: 'observation' });
  });
});

describe('qq group guard silence', () => {
  it('blocks sends while a group is silenced', () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });

    guard.silence('1', clock.now() + 60_000);

    expect(guard.isSilenced('1')).toBe(true);
    expect(guard.allow('1')).toEqual({ ok: false, reason: 'silenced' });
  });

  it('treats an expired silence as inactive', () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });
    guard.silence('1', clock.now() + 60_000);

    clock.advance(60_000);

    expect(guard.isSilenced('1')).toBe(false);
    expect(guard.allow('1')).toEqual({ ok: true });
  });

  it('applies the reserved global key to every group', () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });
    guard.silence('*', clock.now() + 60_000);

    expect(guard.isSilenced('1')).toBe(true);
    expect(guard.isSilenced('2')).toBe(true);
    expect(guard.allow('2')).toEqual({ ok: false, reason: 'silenced' });
  });

  it('checks silence before observation and the min-gap', () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });
    guard.recordSpoken('1');
    guard.recordWarning('1');
    guard.silence('1', clock.now() + 60_000);

    expect(guard.allow('1')).toEqual({ ok: false, reason: 'silenced' });
  });

  it('resumes one group without clearing the global gate', () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });
    guard.silence('1', clock.now() + 60_000);
    guard.silence('2', clock.now() + 60_000);

    guard.resume('1');

    expect(guard.isSilenced('1')).toBe(false);
    expect(guard.isSilenced('2')).toBe(true);
  });

  it('resumes only the global gate when called without a group', () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });
    guard.silence('*', clock.now() + 60_000);
    guard.silence('1', clock.now() + 60_000);

    guard.resume();

    // 全局键清掉，但群自己的静默仍然有效：恢复全局不等于恢复每个群。
    expect(guard.isSilenced('2')).toBe(false);
    expect(guard.isSilenced('1')).toBe(true);
  });

  it('clears observation as well as silence on resume', () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });
    guard.recordWarning('1');
    guard.silence('1', clock.now() + 60_000);

    guard.resume('1');

    expect(guard.isObserving('1')).toBe(false);
    expect(guard.allow('1')).toEqual({ ok: true });
  });
});

describe('qq group guard snapshots', () => {
  it('returns defensive copies that cannot mutate guard state', () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });
    guard.silence('1', clock.now() + 60_000);

    const snapshot = guard.snapshot();
    const entry = snapshot.find((item) => item.groupId === '1');
    expect(entry).toEqual(
      expect.objectContaining({ groupId: '1', silencedUntil: clock.now() + 60_000 }),
    );
    if (entry !== undefined) entry.silencedUntil = null;

    expect(guard.snapshot().find((item) => item.groupId === '1')?.silencedUntil).toBe(
      clock.now() + 60_000,
    );
  });

  it('does not create entries for unknown groups', () => {
    const guard = new GroupGuard({ now: makeClock().now });

    expect(guard.snapshot()).toEqual([]);
  });

  it('does not clean up an expired observation on read', () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });
    guard.recordWarning('1');
    clock.advance(OBSERVATION);

    // 过期只影响判定结果，不得就地写回（读操作无副作用）。
    expect(guard.allow('1')).toEqual({ ok: true });
    expect(guard.snapshot().find((item) => item.groupId === '1')?.observingUntil).toBe(
      clock.now(),
    );
  });
});

describe('qq group guard operator state', () => {
  it('exports only operator settings', () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });
    guard.recordSpoken('1');
    guard.silence('1', clock.now() + 60_000);
    guard.recordWarning('2');
    guard.recordSpoken('3');

    const exported = guard.exportOperatorState();

    expect(exported).toEqual(
      expect.arrayContaining([
        { groupId: '1', silencedUntil: clock.now() + 60_000 },
        { groupId: '2', observingUntil: clock.now() + OBSERVATION },
      ]),
    );
    // 只有内存字段的群不导出：那些值廉价可重建，且变化频繁。
    expect(exported.some((entry) => entry.groupId === '3')).toBe(false);
    expect(JSON.stringify(exported)).not.toContain('gapMs');
    expect(JSON.stringify(exported)).not.toContain('lastSpokenAt');
    expect(JSON.stringify(exported)).not.toContain('silentRounds');
  });

  it('restores operator settings without touching memory-only state', () => {
    const clock = makeClock();
    const source = new GroupGuard({ now: clock.now });
    source.silence('1', clock.now() + 60_000);
    source.recordWarning('2');

    const target = new GroupGuard({ now: clock.now });
    target.recordSpoken('1');
    target.recordSpoken('1');
    target.restoreOperatorState(source.exportOperatorState());

    const snapshot = target.snapshot();
    expect(snapshot.find((item) => item.groupId === '1')).toEqual(
      expect.objectContaining({
        silencedUntil: clock.now() + 60_000,
        silentRounds: 2,
        gapMs: MIN_GAP * 2,
      }),
    );
    expect(snapshot.find((item) => item.groupId === '1')?.lastSpokenAt).toBe(clock.now());
    expect(snapshot.find((item) => item.groupId === '2')).toEqual(
      expect.objectContaining({ observingUntil: clock.now() + OBSERVATION }),
    );
  });

  it('treats restore as authoritative for groups it lists', () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });
    guard.silence('2', clock.now() + 60_000);

    guard.restoreOperatorState([{ groupId: '1', silencedUntil: clock.now() + 30_000 }]);

    const snapshot = guard.snapshot();
    expect(snapshot.find((item) => item.groupId === '1')?.silencedUntil).toBe(
      clock.now() + 30_000,
    );
    expect(snapshot.find((item) => item.groupId === '2')?.silencedUntil).toBeNull();
  });

  it('ignores malformed restore entries without throwing', () => {
    const guard = new GroupGuard({ now: makeClock().now });
    const malformed = [
      null,
      42,
      'nope',
      { groupId: 7 },
      { groupId: '1', silencedUntil: 'soon' },
      { groupId: '2', observingUntil: Number.NaN },
    ] as unknown as GuardOperatorState[];

    expect(() => guard.restoreOperatorState(malformed)).not.toThrow();
    expect(guard.snapshot().find((item) => item.groupId === '1')?.silencedUntil).toBeNull();
    expect(guard.snapshot().find((item) => item.groupId === '2')?.observingUntil).toBeNull();
  });

  it('does not export already-expired gates', () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });
    guard.silence('1', clock.now() + 1_000);
    guard.recordWarning('2');

    clock.advance(OBSERVATION);

    expect(guard.exportOperatorState()).toEqual([]);
  });
});

describe('qq group guard resume split', () => {
  it('lets a platform resume clear observation but not operator silence', () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });
    guard.silence('1', clock.now() + 60_000);
    guard.recordWarning('1');

    guard.resumePlatform('1');

    expect(guard.isObserving('1')).toBe(false);
    expect(guard.isSilenced('1')).toBe(true);
    // 落盘状态与运行时闸门必须一致：静默仍在，观察已清。
    expect(guard.exportOperatorState()).toEqual([
      { groupId: '1', silencedUntil: clock.now() + 60_000 },
    ]);
  });

  it('lets an operator resume clear silence and observation', () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });
    guard.silence('1', clock.now() + 60_000);
    guard.recordWarning('1');

    guard.resumeOperator('1');

    expect(guard.isSilenced('1')).toBe(false);
    expect(guard.isObserving('1')).toBe(false);
    expect(guard.exportOperatorState()).toEqual([]);
  });

  it('keeps the compatibility resume on the operator semantics', () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });
    guard.silence('1', clock.now() + 60_000);
    guard.recordWarning('1');

    guard.resume('1');

    expect(guard.isSilenced('1')).toBe(false);
    expect(guard.isObserving('1')).toBe(false);
  });
});
