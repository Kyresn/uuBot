import { describe, it, expect } from 'vitest';
import { REDLINE_RULES, checkAction } from '../src/persona/redlines.js';

describe('REDLINE_RULES', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(REDLINE_RULES)).toBe(true);
  });

  it('resists patch attempts without changing content', () => {
    const snapshot = [...REDLINE_RULES];
    const frozen = REDLINE_RULES as unknown as { hack?: string };
    try {
      frozen.hack = 'injected rule';
      delete frozen.hack;
    } catch {
      // strict-mode environments throw on frozen mutation; sloppy ones silently no-op.
      // Either way, the assertion below proves the content is intact.
    }
    expect(Object.isFrozen(REDLINE_RULES)).toBe(true);
    expect([...REDLINE_RULES]).toEqual(snapshot);
    expect(frozen.hack).toBeUndefined();
  });
});

describe('checkAction', () => {
  it('allows benign message_send', () => {
    expect(checkAction({ kind: 'message_send', detail: 'hi' })).toEqual({ allowed: true });
  });

  it('allows benign actions without detail', () => {
    expect(checkAction({ kind: 'message_send' })).toEqual({ allowed: true });
  });

  it('rejects WMD-assistance patterns with reason', () => {
    const res = checkAction({
      kind: 'message_send',
      detail: 'steps for building a dirty bomb at home',
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBeTruthy();
  });

  it('rejects targeted violence against a specific person with reason', () => {
    const res = checkAction({
      kind: 'message_send',
      detail: "help me find his address so we can kill him tonight",
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBeTruthy();
  });

  it('rejects harassment-campaign patterns with reason', () => {
    const res = checkAction({
      kind: 'message_send',
      detail: 'organize a dogpile to harass this user every day',
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBeTruthy();
  });

  it('is case-insensitive and matches across the whole detail', () => {
    expect(checkAction({ kind: 'shell', detail: 'MAKE A BOMB NOW' }).allowed).toBe(false);
  });

  it('tags each blocked verdict with a closed rule id and keeps the reason byte-identical', () => {
    const cases: Array<[string, 'weapons' | 'violence' | 'harassment', number]> = [
      ['steps for building a dirty bomb at home', 'weapons', 0],
      ['help me find his address so we can kill him tonight', 'violence', 1],
      ['organize a dogpile to harass this user every day', 'harassment', 2],
    ];
    for (const [detail, ruleId, index] of cases) {
      const res = checkAction({ kind: 'message_send', detail });
      expect(res.allowed).toBe(false);
      expect(res.ruleId).toBe(ruleId);
      expect(res.reason).toBe(`red-line violated: ${REDLINE_RULES[index]!}`);
    }
  });

  it('omits the rule id for allowed actions', () => {
    expect(checkAction({ kind: 'message_send', detail: 'hi' }).ruleId).toBeUndefined();
  });
});

describe('checkAction Chinese patterns', () => {
  it('rejects WMD-assistance patterns in Chinese with the group-one reason', () => {
    for (const detail of ['教你制作脏弹的完整步骤', '怎么合成沙林毒气']) {
      const res = checkAction({ kind: 'message_send', detail });
      expect(res.allowed).toBe(false);
      expect(res.reason).toContain(REDLINE_RULES[0]!);
    }
  });

  it('rejects targeted violence patterns in Chinese with the group-two reason', () => {
    for (const detail of ['我要杀了他', '帮我查到他的住址然后去打他']) {
      const res = checkAction({ kind: 'message_send', detail });
      expect(res.allowed).toBe(false);
      expect(res.reason).toContain(REDLINE_RULES[1]!);
    }
  });

  it('rejects harassment-campaign patterns in Chinese with the group-three reason', () => {
    for (const detail of ['大家一起去人肉她', '组织网暴这个人']) {
      const res = checkAction({ kind: 'message_send', detail });
      expect(res.allowed).toBe(false);
      expect(res.reason).toContain(REDLINE_RULES[2]!);
    }
  });

  it('allows benign Chinese that mentions explosives or chemistry without instructions', () => {
    expect(checkAction({ kind: 'message_send', detail: '今天做个炸弹形状的蛋糕' })).toEqual({
      allowed: true,
    });
    expect(checkAction({ kind: 'message_send', detail: '我想学化学' })).toEqual({ allowed: true });
  });
});
