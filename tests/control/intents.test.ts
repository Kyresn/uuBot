import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../src/brain/types.js';
import {
  INTENT_SPECS,
  classifyIntent,
  type BrainLike,
  type IntentName,
} from '../../src/control/intents.js';

const ID = 'ap_0123456789abcdef0123456789abcdef';

function fakeBrain(content: string | null): {
  brain: BrainLike;
  calls: Array<{ messages: ChatMessage[]; opts: { tier?: 'flash' | 'pro' } | undefined }>;
} {
  const calls: Array<{ messages: ChatMessage[]; opts: { tier?: 'flash' | 'pro' } | undefined }> = [];
  return {
    calls,
    brain: {
      chat: async (messages, opts) => {
        calls.push({ messages, opts });
        return {
          content,
          toolCalls: [],
          reasoning: null,
          usage: { promptTokens: 0, completionTokens: 0 },
          endpoint: 'stub',
          model: 'stub',
        };
      },
    },
  };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

describe('INTENT_SPECS', () => {
  it('covers exactly the eight intents', () => {
    expect(Object.keys(INTENT_SPECS).sort()).toEqual(
      [
        'approval.decide',
        'approval.list',
        'capability.ban',
        'capability.unban',
        'group.resume',
        'group.silence',
        'help.read',
        'status.read',
      ].sort(),
    );
  });

  it('describes every intent from its arguments', () => {
    expect(INTENT_SPECS['help.read'].describe({})).toContain('帮助');
    expect(INTENT_SPECS['status.read'].describe({})).toContain('状态');
    expect(INTENT_SPECS['approval.list'].describe({})).toContain('待审批');
    expect(INTENT_SPECS['approval.list'].describe({ id: ID })).toContain(ID);
    expect(INTENT_SPECS['approval.decide'].describe({ id: ID, decision: 'approve' })).toContain(
      '批准',
    );
    expect(INTENT_SPECS['approval.decide'].describe({ id: ID, decision: 'deny' })).toContain(
      '拒绝',
    );
    expect(INTENT_SPECS['capability.ban'].describe({ plugin: 'demo' })).toContain('demo');
    expect(INTENT_SPECS['capability.unban'].describe({ plugin: 'demo' })).toContain('demo');
    expect(INTENT_SPECS['group.silence'].describe({ minutes: 30 })).toContain('全局');
    expect(INTENT_SPECS['group.silence'].describe({ group: '123', minutes: 30 })).toContain('123');
    expect(INTENT_SPECS['group.resume'].describe({})).toContain('全局');
    expect(INTENT_SPECS['group.resume'].describe({ group: '123' })).toContain('123');
  });

  it('validates help/status arguments', () => {
    expect(INTENT_SPECS['help.read'].parse({}).ok).toBe(true);
    expect(INTENT_SPECS['status.read'].parse({}).ok).toBe(true);
    expect(INTENT_SPECS['help.read'].parse({ extra: 'x' }).ok).toBe(false);
    expect(INTENT_SPECS['status.read'].parse({ extra: 'x' }).ok).toBe(false);
  });

  it('validates approval.list arguments', () => {
    expect(INTENT_SPECS['approval.list'].parse({}).ok).toBe(true);
    expect(INTENT_SPECS['approval.list'].parse({ id: ID }).ok).toBe(true);
    expect(INTENT_SPECS['approval.list'].parse({ id: 'latest' }).ok).toBe(false);
    expect(INTENT_SPECS['approval.list'].parse({ id: 'ap_XYZ' }).ok).toBe(false);
  });

  it('validates approval.decide arguments and requires a full id', () => {
    expect(
      INTENT_SPECS['approval.decide'].parse({ id: ID, decision: 'approve' }).ok,
    ).toBe(true);
    expect(
      INTENT_SPECS['approval.decide'].parse({ id: ID, decision: 'deny', reason: '不需要' }).ok,
    ).toBe(true);
    expect(INTENT_SPECS['approval.decide'].parse({ id: ID }).ok).toBe(false);
    expect(INTENT_SPECS['approval.decide'].parse({ id: ID, decision: 'yes' }).ok).toBe(false);
    expect(INTENT_SPECS['approval.decide'].parse({ id: 'ap_1', decision: 'approve' }).ok).toBe(
      false,
    );
  });

  it('validates plugin names against the spec regex', () => {
    for (const plugin of ['demo', 'a', 'a.b-c_d', 'a'.repeat(64)]) {
      expect(INTENT_SPECS['capability.ban'].parse({ plugin }).ok).toBe(true);
      expect(INTENT_SPECS['capability.unban'].parse({ plugin }).ok).toBe(true);
    }
    for (const plugin of ['', 'Demo', '-demo', '.demo', 'a'.repeat(65), 'a b', 'a/b']) {
      expect(INTENT_SPECS['capability.ban'].parse({ plugin }).ok).toBe(false);
      expect(INTENT_SPECS['capability.unban'].parse({ plugin }).ok).toBe(false);
    }
  });

  it('validates silence minutes and group ids, including the 1440 boundary', () => {
    expect(INTENT_SPECS['group.silence'].parse({ minutes: 0 }).ok).toBe(true);
    expect(INTENT_SPECS['group.silence'].parse({ minutes: 1440 }).ok).toBe(true);
    expect(INTENT_SPECS['group.silence'].parse({ minutes: 1441 }).ok).toBe(false);
    expect(INTENT_SPECS['group.silence'].parse({ minutes: -1 }).ok).toBe(false);
    expect(INTENT_SPECS['group.silence'].parse({ minutes: 1.5 }).ok).toBe(false);
    expect(INTENT_SPECS['group.silence'].parse({ minutes: '30' }).ok).toBe(true);
    expect(INTENT_SPECS['group.silence'].parse({ group: '123', minutes: 30 }).ok).toBe(true);
    expect(INTENT_SPECS['group.silence'].parse({ group: 'x', minutes: 30 }).ok).toBe(false);
    expect(INTENT_SPECS['group.silence'].parse({ group: '1'.repeat(21), minutes: 30 }).ok).toBe(
      false,
    );
    expect(INTENT_SPECS['group.silence'].parse({}).ok).toBe(false);
  });

  it('validates resume arguments', () => {
    expect(INTENT_SPECS['group.resume'].parse({}).ok).toBe(true);
    expect(INTENT_SPECS['group.resume'].parse({ group: '123' }).ok).toBe(true);
    expect(INTENT_SPECS['group.resume'].parse({ group: 'abc' }).ok).toBe(false);
  });

  it('rejects non-object and unknown-key arguments', () => {
    expect(INTENT_SPECS['capability.ban'].parse(null).ok).toBe(false);
    expect(INTENT_SPECS['capability.ban'].parse([]).ok).toBe(false);
    expect(INTENT_SPECS['capability.ban'].parse({ plugin: 'demo', extra: 1 }).ok).toBe(false);
    expect(INTENT_SPECS['capability.ban'].parse({ plugin: 42 }).ok).toBe(false);
  });

  it('omits absent optional arguments rather than emitting undefined', () => {
    const silence = INTENT_SPECS['group.silence'].parse({ minutes: 30 });
    expect(silence.ok).toBe(true);
    if (silence.ok) expect(Object.keys(silence.args)).toEqual(['minutes']);

    const resume = INTENT_SPECS['group.resume'].parse({});
    expect(resume.ok).toBe(true);
    if (resume.ok) expect(resume.args).toEqual({});
  });
});

describe('classifyIntent', () => {
  it('classifies each natural-language-inferrable intent', async () => {
    const cases: Array<{ payload: unknown; intent: IntentName; args: Record<string, unknown> }> = [
      {
        payload: { intent: 'help.read', target: '', minutes: 0, confidence: 0.9 },
        intent: 'help.read',
        args: {},
      },
      {
        payload: { intent: 'status.read', target: '', minutes: 0, confidence: 0.9 },
        intent: 'status.read',
        args: {},
      },
      {
        payload: { intent: 'approval.list', target: '', minutes: 0, confidence: 0.9 },
        intent: 'approval.list',
        args: {},
      },
      {
        payload: { intent: 'capability.ban', target: 'demo', minutes: 0, confidence: 0.9 },
        intent: 'capability.ban',
        args: { plugin: 'demo' },
      },
      {
        payload: { intent: 'capability.unban', target: 'demo', minutes: 0, confidence: 0.9 },
        intent: 'capability.unban',
        args: { plugin: 'demo' },
      },
      {
        payload: { intent: 'group.silence', target: '123', minutes: 30, confidence: 0.9 },
        intent: 'group.silence',
        args: { group: '123', minutes: 30 },
      },
      {
        payload: { intent: 'group.silence', target: '', minutes: 1440, confidence: 0.9 },
        intent: 'group.silence',
        args: { minutes: 1440 },
      },
      {
        payload: { intent: 'group.resume', target: '123', minutes: 0, confidence: 0.9 },
        intent: 'group.resume',
        args: { group: '123' },
      },
    ];

    for (const entry of cases) {
      const { brain } = fakeBrain(json(entry.payload));
      const result = await classifyIntent('随便一句话', brain, { timeoutMs: 50 });
      expect(result).toEqual({ intent: entry.intent, args: entry.args });
    }
  });

  it('uses a minimal prompt with no persona, tools, or history', async () => {
    const { brain, calls } = fakeBrain(
      json({ intent: 'status.read', target: '', minutes: 0, confidence: 0.9 }),
    );
    await classifyIntent('看看状态', brain, { timeoutMs: 50 });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.opts).toEqual({ tier: 'flash' });
    expect(call?.messages).toHaveLength(2);
    expect(call?.messages[0]?.role).toBe('system');
    expect(call?.messages[1]?.role).toBe('user');
    expect(String(call?.messages[0]?.content)).not.toContain('人格');
    expect(String(call?.messages[0]?.content)).not.toContain('tool');
  });

  it('truncates the classifier input to 512 characters', async () => {
    const { brain, calls } = fakeBrain(json({ intent: 'none', confidence: 0 }));
    await classifyIntent('啊'.repeat(900), brain, { timeoutMs: 50 });

    const user = String(calls[0]?.messages[1]?.content ?? '');
    expect([...user].length).toBeLessThanOrEqual(512);
  });

  it('never infers approval.decide', async () => {
    const { brain } = fakeBrain(
      json({ intent: 'approval.decide', target: ID, minutes: 0, confidence: 0.99 }),
    );
    expect(await classifyIntent('批准它', brain, { timeoutMs: 50 })).toEqual({ intent: 'none' });
  });

  it('never infers a single-record approval.list', async () => {
    const { brain } = fakeBrain(
      json({ intent: 'approval.list', target: ID, minutes: 0, confidence: 0.99 }),
    );
    expect(await classifyIntent('看看这条审批', brain, { timeoutMs: 50 })).toEqual({
      intent: 'none',
    });
  });

  it('returns none for malformed JSON and for prose around JSON', async () => {
    for (const content of ['not json', '```json\n{"intent":"status.read"}\n```', '{"intent":']) {
      const { brain } = fakeBrain(content);
      expect(await classifyIntent('状态', brain, { timeoutMs: 50 })).toEqual({ intent: 'none' });
    }
  });

  it('returns none for an unknown intent or a missing confidence', async () => {
    const unknown = fakeBrain(
      json({ intent: 'shell.exec', target: '', minutes: 0, confidence: 0.99 }),
    );
    expect(await classifyIntent('执行命令', unknown.brain, { timeoutMs: 50 })).toEqual({
      intent: 'none',
    });

    const missing = fakeBrain(json({ intent: 'status.read', target: '', minutes: 0 }));
    expect(await classifyIntent('状态', missing.brain, { timeoutMs: 50 })).toEqual({
      intent: 'none',
    });
  });

  it('enforces the confidence threshold, inclusive at 0.75', async () => {
    const low = fakeBrain(
      json({ intent: 'capability.ban', target: 'demo', minutes: 0, confidence: 0.74 }),
    );
    expect(await classifyIntent('封禁 demo', low.brain, { timeoutMs: 50 })).toEqual({
      intent: 'none',
    });

    const boundary = fakeBrain(
      json({ intent: 'capability.ban', target: 'demo', minutes: 0, confidence: 0.75 }),
    );
    expect(await classifyIntent('封禁 demo', boundary.brain, { timeoutMs: 50 })).toEqual({
      intent: 'capability.ban',
      args: { plugin: 'demo' },
    });
  });

  it('honours a custom minimum confidence', async () => {
    const { brain } = fakeBrain(
      json({ intent: 'capability.ban', target: 'demo', minutes: 0, confidence: 0.6 }),
    );
    expect(
      await classifyIntent('封禁 demo', brain, { timeoutMs: 50, minConfidence: 0.5 }),
    ).toEqual({ intent: 'capability.ban', args: { plugin: 'demo' } });
  });

  it('returns none when the target does not validate', async () => {
    const { brain } = fakeBrain(
      json({ intent: 'capability.ban', target: 'Demo!', minutes: 0, confidence: 0.99 }),
    );
    expect(await classifyIntent('封禁它', brain, { timeoutMs: 50 })).toEqual({ intent: 'none' });
  });

  it('returns none for out-of-range silence minutes', async () => {
    const { brain } = fakeBrain(
      json({ intent: 'group.silence', target: '', minutes: 1441, confidence: 0.99 }),
    );
    expect(await classifyIntent('安静很久', brain, { timeoutMs: 50 })).toEqual({ intent: 'none' });
  });

  it('maps a zero target to the global gate for group intents', async () => {
    const silence = fakeBrain(
      json({ intent: 'group.silence', target: 0, minutes: 30, confidence: 0.9 }),
    );
    expect(await classifyIntent('安静半小时', silence.brain, { timeoutMs: 50 })).toEqual({
      intent: 'group.silence',
      args: { minutes: 30 },
    });

    const resume = fakeBrain(
      json({ intent: 'group.resume', target: 0, minutes: 0, confidence: 0.9 }),
    );
    expect(await classifyIntent('恢复吧', resume.brain, { timeoutMs: 50 })).toEqual({
      intent: 'group.resume',
      args: {},
    });
  });

  it('rejects targets that are not known objects', async () => {
    const ban = fakeBrain(
      json({ intent: 'capability.ban', target: 'nope', minutes: 0, confidence: 0.9 }),
    );
    expect(
      await classifyIntent('封禁它', ban.brain, { timeoutMs: 50, isKnownPlugin: () => false }),
    ).toEqual({ intent: 'none' });
    expect(
      await classifyIntent('封禁它', ban.brain, {
        timeoutMs: 50,
        isKnownPlugin: (name) => name === 'nope',
      }),
    ).toEqual({ intent: 'capability.ban', args: { plugin: 'nope' } });

    const silence = fakeBrain(
      json({ intent: 'group.silence', target: '999', minutes: 30, confidence: 0.9 }),
    );
    expect(
      await classifyIntent('安静那个群', silence.brain, {
        timeoutMs: 50,
        isKnownGroup: () => false,
      }),
    ).toEqual({ intent: 'none' });
    expect(
      await classifyIntent('安静那个群', silence.brain, {
        timeoutMs: 50,
        isKnownGroup: (groupId) => groupId === '999',
      }),
    ).toEqual({ intent: 'group.silence', args: { group: '999', minutes: 30 } });
  });

  it('keeps QQ_* environment names out of core and control sources', () => {
    const files = [
      ...readdirSync('src/control')
        .filter((name) => name.endsWith('.ts'))
        .map((name) => `src/control/${name}`),
      ...readdirSync('src/core')
        .filter((name) => name.endsWith('.ts'))
        .map((name) => `src/core/${name}`),
    ];
    files.push('src/index.ts');

    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toContain('QQ_');
    }
  });

  it('returns none on a timeout without waiting for the brain', async () => {
    const brain: BrainLike = {
      chat: () => new Promise(() => undefined),
    };
    const started = Date.now();
    const result = await classifyIntent('状态', brain, { timeoutMs: 20 });
    expect(result).toEqual({ intent: 'none' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('returns none when the brain throws', async () => {
    const brain: BrainLike = {
      chat: async () => {
        throw new Error('boom');
      },
    };
    expect(await classifyIntent('状态', brain, { timeoutMs: 50 })).toEqual({ intent: 'none' });
  });

  it('does not classify quoted, forwarded, or JSON-card messages', async () => {
    for (const marker of ['[CQ:reply,id=1]', '[CQ:forward,id=1]', '[CQ:json,data=x]']) {
      const { brain, calls } = fakeBrain(
        json({ intent: 'capability.ban', target: 'demo', minutes: 0, confidence: 0.99 }),
      );
      expect(await classifyIntent(`${marker} 封禁 demo`, brain, { timeoutMs: 50 })).toEqual({
        intent: 'none',
      });
      expect(calls).toHaveLength(0);
    }
  });

  it('returns none for empty text', async () => {
    const { brain, calls } = fakeBrain(
      json({ intent: 'status.read', target: '', minutes: 0, confidence: 0.99 }),
    );
    expect(await classifyIntent('   ', brain, { timeoutMs: 50 })).toEqual({ intent: 'none' });
    expect(calls).toHaveLength(0);
  });

  it('reports classifier failures only through the optional log', async () => {
    const log = vi.fn<(line: string) => void>();
    const brain: BrainLike = {
      chat: async () => {
        throw new Error('boom');
      },
    };
    await classifyIntent('状态', brain, { timeoutMs: 50, log });
    expect(log).toHaveBeenCalled();
  });
});
