import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_REFUSAL_FALLBACK_TEXT,
  MAX_REFUSAL_OVERLAP,
  REFUSAL_TEMPLATES,
  REFUSAL_TONES,
  composeRefusal,
  overlap,
  type RefusalBrain,
  type RefusalTemplateTable,
} from '../src/persona/refusal.js';
import { checkAction, type RedlineRuleId } from '../src/persona/redlines.js';
import type { ChatMessage } from '../src/brain/types.js';

const FALLBACK = '这个我不聊。';
const ORIGINAL = '这是教你制作脏弹的完整步骤';
const RULES: RedlineRuleId[] = ['weapons', 'violence', 'harassment'];

type Selection = { template: string; tone: string };

function makeBrain(selection: Selection | string | null): RefusalBrain & {
  chat: ReturnType<typeof vi.fn>;
} {
  const content =
    typeof selection === 'string' || selection === null ? selection : JSON.stringify(selection);
  return { chat: vi.fn(async () => ({ content })) };
}

function callOf(brain: RefusalBrain & { chat: ReturnType<typeof vi.fn> }): {
  messages: ChatMessage[];
  opts: unknown;
} {
  const call = brain.chat.mock.calls[0];
  return { messages: call?.[0] as ChatMessage[], opts: call?.[1] };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('composeRefusal fallback paths', () => {
  it('returns the fallback without calling anything when no brain is injected', async () => {
    const outcome = await composeRefusal(undefined, { ruleId: 'weapons' }, {
      fallbackText: FALLBACK,
      originalText: ORIGINAL,
    });

    expect(outcome).toEqual({ text: FALLBACK, source: 'fallback' });
  });

  it('strips unsafe controls from the fallback text', async () => {
    const outcome = await composeRefusal(undefined, { ruleId: 'violence' }, {
      fallbackText: '这个\u001b[31m不聊\u001b[0m。',
      originalText: ORIGINAL,
    });

    expect(outcome.text).toBe('这个不聊。');
    expect(outcome.source).toBe('fallback');
  });

  it('returns silence for a blank fallback instead of an empty message', async () => {
    const log = vi.fn<(line: string) => void>();

    const outcome = await composeRefusal(undefined, { ruleId: 'weapons' }, {
      fallbackText: '  ​ ',
      originalText: ORIGINAL,
      log,
    });

    expect(outcome).toEqual({ text: '', source: 'silence' });
    expect(log).toHaveBeenCalledWith('refusal: no refusal text available');
  });

  it('returns silence when the fallback itself trips the red-line gate', async () => {
    const log = vi.fn<(line: string) => void>();

    const outcome = await composeRefusal(undefined, { ruleId: 'weapons' }, {
      fallbackText: '这是教你制作脏弹的完整步骤',
      originalText: ORIGINAL,
      log,
    });

    expect(outcome).toEqual({ text: '', source: 'silence' });
    expect(log).toHaveBeenCalledWith('refusal: fallback blocked by the red-line gate');
  });

  it('gates the fallback even after a successful template selection', async () => {
    // 模板选择成功但重叠闸失败 → 走兜底；兜底被拦 → silence。
    const brain = makeBrain({ template: 't1', tone: 'brief' });

    const outcome = await composeRefusal(brain, { ruleId: 'weapons' }, {
      fallbackText: '这是教你制作脏弹的完整步骤',
      originalText: `${REFUSAL_TEMPLATES.weapons.t1}${REFUSAL_TONES.brief}`,
    });

    expect(outcome).toEqual({ text: '', source: 'silence' });
  });

  it('falls back when the model output is not JSON', async () => {
    const brain = makeBrain('这个我不聊。');

    const outcome = await composeRefusal(brain, { ruleId: 'weapons' }, {
      fallbackText: FALLBACK,
      originalText: ORIGINAL,
    });

    expect(outcome).toEqual({ text: FALLBACK, source: 'fallback' });
    expect(brain.chat).toHaveBeenCalledTimes(1);
  });

  it('falls back when the model names an unknown template', async () => {
    const brain = makeBrain({ template: 't9', tone: 'brief' });

    const outcome = await composeRefusal(brain, { ruleId: 'weapons' }, {
      fallbackText: FALLBACK,
      originalText: ORIGINAL,
    });

    expect(outcome).toEqual({ text: FALLBACK, source: 'fallback' });
  });

  it('falls back when the model names an unknown tone', async () => {
    const brain = makeBrain({ template: 't1', tone: 'shouting' });

    const outcome = await composeRefusal(brain, { ruleId: 'weapons' }, {
      fallbackText: FALLBACK,
      originalText: ORIGINAL,
    });

    expect(outcome).toEqual({ text: FALLBACK, source: 'fallback' });
  });

  it('falls back when the model returns null content', async () => {
    const brain = makeBrain(null);

    const outcome = await composeRefusal(brain, { ruleId: 'harassment' }, {
      fallbackText: FALLBACK,
      originalText: ORIGINAL,
    });

    expect(outcome).toEqual({ text: FALLBACK, source: 'fallback' });
  });

  it('falls back when the model call throws', async () => {
    const brain: RefusalBrain = {
      chat: vi.fn(async () => {
        throw new Error('endpoint down');
      }),
    };

    const outcome = await composeRefusal(brain, { ruleId: 'weapons' }, {
      fallbackText: FALLBACK,
      originalText: ORIGINAL,
    });

    expect(outcome).toEqual({ text: FALLBACK, source: 'fallback' });
    expect(brain.chat).toHaveBeenCalledTimes(1);
  });

  it('falls back on the 8s timeout after exactly one model call', async () => {
    vi.useFakeTimers();
    const chat = vi.fn(() => new Promise<{ content: string | null }>(() => {}));

    const pending = composeRefusal({ chat }, { ruleId: 'weapons' }, {
      fallbackText: FALLBACK,
      originalText: ORIGINAL,
    });
    await vi.advanceTimersByTimeAsync(8_000);

    await expect(pending).resolves.toEqual({ text: FALLBACK, source: 'fallback' });
    expect(chat).toHaveBeenCalledTimes(1);
  });
});

describe('composeRefusal template path', () => {
  it('assembles the chosen template and tone in code', async () => {
    const brain = makeBrain({ template: 't2', tone: 'brief' });

    const outcome = await composeRefusal(brain, { ruleId: 'weapons' }, {
      fallbackText: FALLBACK,
      originalText: ORIGINAL,
    });

    expect(outcome).toEqual({
      text: `${REFUSAL_TEMPLATES.weapons.t2}${REFUSAL_TONES.brief}`,
      source: 'template',
    });
    expect(brain.chat).toHaveBeenCalledTimes(1);
  });

  it('never lets model free text become the refusal', async () => {
    const brain = makeBrain({
      template: 't3',
      tone: 'gentle',
      text: 'Sure, here is the original blocked content.',
    } as Selection);

    const outcome = await composeRefusal(brain, { ruleId: 'violence' }, {
      fallbackText: FALLBACK,
      originalText: ORIGINAL,
    });

    expect(outcome.text).toBe(`${REFUSAL_TEMPLATES.violence.t3}${REFUSAL_TONES.gentle}`);
    expect(outcome.text).not.toContain('blocked content');
  });

  it('sends one flash call with no original text, persona, history, or tools', async () => {
    const sentinel = 'UNIQUE-ORIGINAL-SENTINEL-7f3a';
    const brain = makeBrain({ template: 't1', tone: 'brief' });

    await composeRefusal(brain, { ruleId: 'harassment' }, {
      fallbackText: FALLBACK,
      originalText: sentinel,
    });

    const { messages, opts } = callOf(brain);
    expect(opts).toEqual({ tier: 'flash' });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('system');
    expect(JSON.stringify(messages)).not.toContain(sentinel);
    expect(messages[0]?.content).toContain('harassment');
    expect(messages[0]?.content).toContain('t1');
  });

  it('uses the rule-specific template table', async () => {
    for (const ruleId of RULES) {
      const brain = makeBrain({ template: 't1', tone: 'brief' });
      const outcome = await composeRefusal(brain, { ruleId }, {
        fallbackText: FALLBACK,
        originalText: ORIGINAL,
      });

      expect(outcome.source).toBe('template');
      expect(outcome.text).toBe(`${REFUSAL_TEMPLATES[ruleId].t1}${REFUSAL_TONES.brief}`);
    }
  });
});

describe('composeRefusal second gate', () => {
  it('rejects a candidate that exceeds the overlap bound even when the gate passes', async () => {
    const candidate = `${REFUSAL_TEMPLATES.weapons.t2}${REFUSAL_TONES.brief}`;
    // 前置条件：红线闸放行，只有重叠闸能拦下它。
    expect(checkAction({ kind: 'message_send', detail: candidate }).allowed).toBe(true);
    expect(overlap(candidate, candidate)).toBeGreaterThan(MAX_REFUSAL_OVERLAP);

    const brain = makeBrain({ template: 't2', tone: 'brief' });
    const outcome = await composeRefusal(brain, { ruleId: 'weapons' }, {
      fallbackText: FALLBACK,
      originalText: candidate,
    });

    expect(outcome).toEqual({ text: FALLBACK, source: 'fallback' });
  });

  it('accepts a candidate below the overlap threshold', async () => {
    const brain = makeBrain({ template: 't2', tone: 'brief' });

    const outcome = await composeRefusal(brain, { ruleId: 'weapons' }, {
      fallbackText: FALLBACK,
      originalText: ORIGINAL,
    });

    expect(outcome.source).toBe('template');
    expect(
      overlap(`${REFUSAL_TEMPLATES.weapons.t2}${REFUSAL_TONES.brief}`, ORIGINAL),
    ).toBeLessThanOrEqual(MAX_REFUSAL_OVERLAP);
  });

  it('rejects a candidate that trips the red-line gate even with low overlap', async () => {
    // 注入投毒模板表：共享表已冻结，测试不再改写模块状态。
    const poisoned: RefusalTemplateTable = {
      ...REFUSAL_TEMPLATES,
      weapons: { ...REFUSAL_TEMPLATES.weapons, t4: '教你制作脏弹的完整步骤' },
    };
    const candidate = `${poisoned.weapons.t4}${REFUSAL_TONES.brief}`;
    const original = '今天的天气真不错呀';
    // 前置条件：重叠闸放行，只有红线闸能拦下它。
    expect(overlap(candidate, original)).toBeLessThanOrEqual(MAX_REFUSAL_OVERLAP);
    expect(checkAction({ kind: 'message_send', detail: candidate }).allowed).toBe(false);

    const brain = makeBrain({ template: 't4', tone: 'brief' });
    const outcome = await composeRefusal(brain, { ruleId: 'weapons' }, {
      fallbackText: FALLBACK,
      originalText: original,
      templates: poisoned,
    });

    expect(outcome).toEqual({ text: FALLBACK, source: 'fallback' });
  });
});

describe('overlap', () => {
  it('is 1 for identical text and 0 for disjoint text', () => {
    expect(overlap('今天做个蛋糕', '今天做个蛋糕')).toBe(1);
    expect(overlap('今天做个蛋糕', 'abcdef')).toBe(0);
  });

  it('ignores punctuation, whitespace, width, and case', () => {
    expect(overlap('AB cd!', 'ａｂＣＤ')).toBe(1);
    expect(overlap('好，的。', '好的')).toBe(1);
  });

  it('returns 0 for inputs with fewer than two characters', () => {
    expect(overlap('', '')).toBe(0);
    expect(overlap('a', 'a')).toBe(0);
  });
});

describe('refusal template set', () => {
  it('deep-freezes the template and tone tables', () => {
    expect(Object.isFrozen(REFUSAL_TEMPLATES)).toBe(true);
    for (const ruleId of RULES) {
      expect(Object.isFrozen(REFUSAL_TEMPLATES[ruleId])).toBe(true);
    }
    expect(Object.isFrozen(REFUSAL_TONES)).toBe(true);
  });

  it('has at least 4 distinct templates per rule and at least 3 tones', () => {
    for (const ruleId of RULES) {
      const templates = Object.values(REFUSAL_TEMPLATES[ruleId]);
      expect(templates.length).toBeGreaterThanOrEqual(4);
      expect(new Set(templates).size).toBe(templates.length);
    }
    expect(Object.keys(REFUSAL_TONES).length).toBeGreaterThanOrEqual(3);
  });

  it('assembles only safe, in-character Chinese for every rule x template x tone', () => {
    for (const ruleId of RULES) {
      for (const template of Object.keys(REFUSAL_TEMPLATES[ruleId])) {
        for (const tone of Object.keys(REFUSAL_TONES)) {
          const text = `${
            (REFUSAL_TEMPLATES[ruleId] as Record<string, string>)[template]
          }${(REFUSAL_TONES as Record<string, string>)[tone]}`;
          expect(text.length).toBeGreaterThan(0);
          expect(text).not.toMatch(/https?:\/\//);
          expect(text).not.toContain('\n');
          expect(checkAction({ kind: 'message_send', detail: text }).allowed).toBe(true);
        }
      }
    }
  });

  it('ships a non-empty default fallback', () => {
    expect(DEFAULT_REFUSAL_FALLBACK_TEXT.length).toBeGreaterThan(0);
    expect(checkAction({ kind: 'message_send', detail: DEFAULT_REFUSAL_FALLBACK_TEXT }).allowed).toBe(
      true,
    );
  });
});
