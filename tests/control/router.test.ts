import { describe, expect, it, vi } from 'vitest';
import type {
  ApprovalPayload,
  ApprovalRecord,
  DecisionChannel,
} from '../../src/approvals/types.js';
import type { DecideResult, ListFilter, ProposeResult } from '../../src/approvals/service.js';
import type { ControlAuditRow } from '../../src/control/audit-log.js';
import type { ControlState } from '../../src/control/state-store.js';
import type { ControlStatusSnapshot } from '../../src/control/status.js';
import {
  createControlPort,
  createControlRouter,
  type CapabilityControl,
  type ControlRouter,
  type ControlRouterDeps,
  type GuardControl,
} from '../../src/control/router.js';
import type { ControlInput, ControlReply } from '../../src/control/types.js';

const ID = 'ap_0123456789abcdef0123456789abcdef';
const ID2 = 'ap_fedcba9876543210fedcba9876543210';
const NOW = 1_700_000_000_000;

function approvalRecord(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: ID,
    kind: 'capability.activate',
    status: 'pending',
    tier: 'human',
    title: '激活能力插件 demo',
    summary: '版本 0.1.0',
    payload: {
      kind: 'capability.activate',
      plugin: 'demo',
      version: '0.1.0',
      fingerprint: 'f'.repeat(64),
      declaredPermissions: [],
      toolNames: [],
    },
    fingerprint: 'f'.repeat(64),
    createdAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
    createdVia: 'qq',
    createdBy: 'private:1',
    ...overrides,
  };
}

interface FakeApprovals {
  propose: ReturnType<typeof vi.fn<(payload: ApprovalPayload, meta: unknown) => Promise<ProposeResult>>>;
  decide: ReturnType<typeof vi.fn<(id: string, decision: unknown) => Promise<DecideResult>>>;
  list: ReturnType<typeof vi.fn<(filter?: ListFilter) => ApprovalRecord[]>>;
  get: ReturnType<typeof vi.fn<(id: string) => ApprovalRecord | undefined>>;
  records: ApprovalRecord[];
}

function fakeApprovals(): FakeApprovals {
  const records: ApprovalRecord[] = [];
  const fake: FakeApprovals = {
    records,
    propose: vi.fn<(payload: ApprovalPayload, meta: unknown) => Promise<ProposeResult>>(
      async (payload: ApprovalPayload): Promise<ProposeResult> => {
        const record = approvalRecord({
          id: ID2,
          kind: payload.kind,
          payload,
        });
        records.push(record);
        return { ok: true, record };
      },
    ),
    decide: vi.fn<(id: string, decision: unknown) => Promise<DecideResult>>(
      async (id: string): Promise<DecideResult> => ({
        ok: true,
        record: approvalRecord({ id, status: 'approved' }),
      }),
    ),
    list: vi.fn((filter?: ListFilter) => {
      const includeControl = filter?.includeControl === true;
      return records.filter((record) => includeControl || record.kind !== 'control.command');
    }),
    get: vi.fn((id: string) => records.find((record) => record.id === id)),
  };
  return fake;
}

function fakeGuard(): GuardControl & {
  silence: ReturnType<typeof vi.fn<(groupId: string, untilMs: number) => void>>;
  resume: ReturnType<typeof vi.fn<(groupId?: string) => void>>;
} {
  return {
    silence: vi.fn<(groupId: string, untilMs: number) => void>(),
    resume: vi.fn<(groupId?: string) => void>(),
  };
}

function fakeCapabilities(): CapabilityControl & {
  status: ReturnType<typeof vi.fn<() => Array<{ name: string; state: string }>>>;
  ban: ReturnType<typeof vi.fn<(name: string) => Promise<void>>>;
  unban: ReturnType<typeof vi.fn<(name: string) => Promise<void>>>;
  requestActivation: ReturnType<
    typeof vi.fn<
      (
        name: string,
        meta?: { createdVia: 'qq' | 'web' | 'system'; createdBy: string },
      ) => Promise<{ ok: true; id: string } | { ok: false; code: string }>
    >
  >;
} {
  return {
    status: vi.fn(() => [{ name: 'demo', state: 'pending' }]),
    ban: vi.fn<(name: string) => Promise<void>>(async (_name: string) => undefined),
    unban: vi.fn<(name: string) => Promise<void>>(async (_name: string) => undefined),
    requestActivation: vi.fn<
      (
        name: string,
        meta?: { createdVia: 'qq' | 'web' | 'system'; createdBy: string },
      ) => Promise<{ ok: true; id: string } | { ok: false; code: string }>
    >(async (_name: string) => ({ ok: true as const, id: ID })),
  };
}

function fakeState(): {
  setGroupSilencedUntil: ReturnType<typeof vi.fn<(groupId: string, until: number | undefined) => Promise<void>>>;
  clearGroup: ReturnType<typeof vi.fn<(groupId: string) => Promise<void>>>;
  snapshot: ReturnType<typeof vi.fn<() => ControlState>>;
} {
  return {
    setGroupSilencedUntil: vi.fn<
      (groupId: string, until: number | undefined) => Promise<void>
    >(async (_groupId: string, _until: number | undefined) => undefined),
    clearGroup: vi.fn<(groupId: string) => Promise<void>>(
      async (_groupId: string) => undefined,
    ),
    snapshot: vi.fn(() => ({ version: 1 as const, bootId: 'b', groups: {}, proactive: {} })),
  };
}

function snapshot(overrides: Partial<ControlStatusSnapshot> = {}): ControlStatusSnapshot {
  return {
    quiet: { until: null, active: false },
    groups: [],
    observing: [],
    approvals: { pending: 0, oldestPendingAt: null },
    channels: [],
    plugins: [],
    capabilities: [],
    heartbeat: { silentRounds: 0, inFlight: false, nextFastMs: 1000 },
    queueSize: 0,
    endpoints: [],
    ...overrides,
  };
}

interface Harness {
  router: ReturnType<typeof createControlRouter>;
  approvals: FakeApprovals;
  guard: ReturnType<typeof fakeGuard>;
  capabilities: ReturnType<typeof fakeCapabilities>;
  state: ReturnType<typeof fakeState>;
  status: ReturnType<typeof vi.fn<() => ControlStatusSnapshot>>;
  brain: { chat: ReturnType<typeof vi.fn> };
}

function harness(overrides: Partial<ControlRouterDeps> = {}): Harness {
  const approvals = fakeApprovals();
  const guard = fakeGuard();
  const capabilities = fakeCapabilities();
  const state = fakeState();
  const status = vi.fn(() => snapshot());
  const brain = {
    chat: vi.fn(async () => ({
      content: JSON.stringify({ intent: 'none', target: '', minutes: 0, confidence: 0 }),
      toolCalls: [],
      reasoning: null,
      usage: { promptTokens: 0, completionTokens: 0 },
      endpoint: 'stub',
      model: 'stub',
    })),
  };
  const router = createControlRouter({
    approvals,
    guard,
    capabilities,
    state,
    status,
    brain,
    now: () => NOW,
    nl: { timeoutMs: 50 },
    ...overrides,
  });
  return { router, approvals, guard, capabilities, state, status, brain };
}

const QQ_ORIGIN: { channel: DecisionChannel; actor: string } = {
  channel: 'qq',
  actor: 'private:1',
};

describe('control router prefix commands', () => {
  it('renders help for #帮助 and for usage errors', async () => {
    const { router } = harness();
    const help = await router.handleOwnerText('#帮助', QQ_ORIGIN);
    expect(help.handled).toBe(true);
    expect(help.text).toContain('#状态');
    expect(help.text).toContain('#封禁');
    expect(help.text).toContain('#安静');

    const usage = await router.handleOwnerText('#同意', QQ_ORIGIN);
    expect(usage.handled).toBe(true);
    expect(usage.text).toContain('用法');
  });

  it('renders the shared status snapshot', async () => {
    const { router, status } = harness();
    status.mockReturnValue(
      snapshot({
        queueSize: 3,
        approvals: { pending: 2, oldestPendingAt: new Date(NOW).toISOString() },
        plugins: [{ name: 'qq', state: 'active' }],
        endpoints: [{ name: 'nim', degraded: true, remainingBackoffMs: 5000 }],
        heartbeat: { silentRounds: 4, inFlight: true, nextFastMs: 900 },
      }),
    );

    const reply = await router.handleOwnerText('#状态', QQ_ORIGIN);

    expect(status).toHaveBeenCalled();
    expect(reply.handled).toBe(true);
    expect(reply.text).toContain('3');
    expect(reply.text).toContain('4');
    expect(reply.text).toContain('qq=active');
    expect(reply.text).toContain('nim');
    expect(reply.text).toContain('降级');
  });

  it('sanitizes and caps untrusted status fields', async () => {
    const { router } = harness({
      status: () =>
        snapshot({
          plugins: [{ name: 'evil\n\u001b[31mfake', state: 'active' }],
        }),
    });

    const reply = await router.handleOwnerText('#状态', QQ_ORIGIN);

    expect(reply.text).not.toContain('\u001b');
    expect(reply.text.split('\n').some((line) => line.includes('fake'))).toBe(true);
    expect(reply.text).not.toContain('evil\n');
  });

  it('truncates by code points and never splits a surrogate pair', async () => {
    const name = `a${'😀'.repeat(40)}`;
    const { router } = harness({
      status: () => snapshot({ plugins: [{ name, state: 'active' }] }),
    });

    const reply = await router.handleOwnerText('#状态', QQ_ORIGIN);

    expect(reply.text).toContain(name);
  });

  it('lists pending approvals without control.command by default', async () => {
    const { router, approvals } = harness();
    approvals.list.mockReturnValue([approvalRecord()]);

    const reply = await router.handleOwnerText('#审批', QQ_ORIGIN);

    expect(approvals.list).toHaveBeenCalledWith({ status: 'pending' });
    expect(reply.text).toContain(ID);
    expect(reply.text).toContain('激活能力插件 demo');
  });

  it('actually excludes a pending control.command record from the list', async () => {
    const { router, approvals } = harness();
    approvals.records.push(approvalRecord({ id: ID }));
    approvals.records.push(
      approvalRecord({
        id: ID2,
        kind: 'control.command',
        payload: { kind: 'control.command', intent: 'capability.ban', args: { plugin: 'demo' } },
      }),
    );

    const reply = await router.handleOwnerText('#审批', QQ_ORIGIN);

    expect(reply.text).toContain(ID);
    expect(reply.text).not.toContain(ID2);
    expect(reply.text).toContain('待审批 1 条');
  });

  it('reports an empty pending list', async () => {
    const { router } = harness();
    const reply = await router.handleOwnerText('#审批', QQ_ORIGIN);
    expect(reply.text).toContain('没有待审批');
  });

  it('looks up any single approval id, including control.command', async () => {
    const { router, approvals } = harness();
    const controlRecord = approvalRecord({
      id: ID2,
      kind: 'control.command',
      payload: { kind: 'control.command', intent: 'capability.ban', args: { plugin: 'demo' } },
    });
    approvals.get.mockReturnValue(controlRecord);

    const reply = await router.handleOwnerText(`#审批 ${ID2}`, QQ_ORIGIN);

    expect(approvals.get).toHaveBeenCalledWith(ID2);
    expect(reply.text).toContain(ID2);
    expect(reply.text).toContain('pending');
  });

  it('reports an unknown approval id without guessing', async () => {
    const { router } = harness();
    const reply = await router.handleOwnerText(`#审批 ${ID}`, QQ_ORIGIN);
    expect(reply.text).toContain('未找到');
  });

  it('approves an explicit id through the approval service', async () => {
    const { router, approvals } = harness();

    const reply = await router.handleOwnerText(`#同意 ${ID}`, QQ_ORIGIN);

    expect(approvals.decide).toHaveBeenCalledWith(ID, {
      decision: 'approve',
      via: 'qq',
      by: 'private:1',
    });
    expect(reply.text).toContain('已批准');
    expect(reply.text).toContain(ID);
  });

  it('passes a denial reason through', async () => {
    const { router, approvals } = harness();

    await router.handleOwnerText(`#拒绝 ${ID} 不需要 这个`, QQ_ORIGIN);

    expect(approvals.decide).toHaveBeenCalledWith(ID, {
      decision: 'deny',
      via: 'qq',
      by: 'private:1',
      reason: '不需要 这个',
    });
  });

  it('treats a bare 确认 as chat and decides nothing', async () => {
    const { router, approvals } = harness();
    const reply = await router.handleOwnerText('确认', QQ_ORIGIN);

    expect(approvals.decide).not.toHaveBeenCalled();
    expect(reply).toEqual({ text: '', handled: false });
  });

  it('treats 确认 followed by non-id text as chat', async () => {
    const { router, approvals } = harness();
    const reply = await router.handleOwnerText('确认 明天下午三点', QQ_ORIGIN);

    expect(approvals.decide).not.toHaveBeenCalled();
    expect(reply).toEqual({ text: '', handled: false });
  });

  it('treats 确认 <id> as an approval', async () => {
    const { router, approvals } = harness();
    await router.handleOwnerText(`确认 ${ID}`, QQ_ORIGIN);

    expect(approvals.decide).toHaveBeenCalledWith(ID, {
      decision: 'approve',
      via: 'qq',
      by: 'private:1',
    });
  });

  it('surfaces channel-binding rejections instead of pretending success', async () => {
    const { router, approvals } = harness();
    approvals.decide.mockResolvedValue({ ok: false, code: 'wrong_channel' });

    const reply = await router.handleOwnerText(`#同意 ${ID}`, {
      channel: 'web',
      actor: 'web:session',
    });

    expect(reply.handled).toBe(true);
    expect(reply.text).toContain('QQ');
  });

  it('reports non-pending and expired decisions distinctly', async () => {
    const { router, approvals } = harness();
    approvals.decide.mockResolvedValue({
      ok: false,
      code: 'not_pending',
      record: approvalRecord({ status: 'denied' }),
    });
    expect((await router.handleOwnerText(`#同意 ${ID}`, QQ_ORIGIN)).text).toContain('已处理');

    approvals.decide.mockResolvedValue({ ok: false, code: 'expired' });
    expect((await router.handleOwnerText(`#同意 ${ID}`, QQ_ORIGIN)).text).toContain('过期');
  });

  it('does not treat a timeout as proof the action did not happen', async () => {
    const { router, approvals } = harness();
    approvals.decide.mockResolvedValue({
      ok: true,
      record: approvalRecord({
        status: 'approved',
        execution: { state: 'failed', error: 'timeout' },
      }),
    });

    const reply = await router.handleOwnerText(`#同意 ${ID}`, QQ_ORIGIN);

    expect(reply.text).toContain('已批准');
    expect(reply.text).toContain('执行结果未确认');
    expect(reply.text).toContain('可能已发生');
  });

  it('mentions a failed execution without claiming it did not happen', async () => {
    const { router, approvals } = harness();
    approvals.decide.mockResolvedValue({
      ok: true,
      record: approvalRecord({
        status: 'approved',
        execution: { state: 'failed', error: 'spawn failed' },
      }),
    });

    const reply = await router.handleOwnerText(`#同意 ${ID}`, QQ_ORIGIN);

    expect(reply.text).toContain('已批准');
    expect(reply.text).toContain('执行失败');
    expect(reply.text).toContain('spawn failed');
  });

  it('bans a known capability plugin', async () => {
    const { router, capabilities } = harness();
    const reply = await router.handleOwnerText('#封禁 demo', QQ_ORIGIN);

    expect(capabilities.ban).toHaveBeenCalledWith('demo');
    expect(reply.text).toContain('已封禁');
    expect(reply.text).toContain('demo');
  });

  it('refuses to ban a channel plugin or an unknown name', async () => {
    const { router, capabilities } = harness();
    const reply = await router.handleOwnerText('#封禁 qq', QQ_ORIGIN);

    expect(capabilities.ban).not.toHaveBeenCalled();
    expect(reply.text).toContain('未知插件 qq');
    expect(reply.text).toContain('渠道插件不在封禁范围');
  });

  it('unbans and immediately proposes an activation approval', async () => {
    const { router, capabilities, approvals } = harness();

    const reply = await router.handleOwnerText('#解封 demo', QQ_ORIGIN);

    expect(capabilities.unban).toHaveBeenCalledWith('demo');
    expect(capabilities.requestActivation).toHaveBeenCalledWith('demo', {
      createdVia: 'qq',
      createdBy: 'private:1',
    });
    expect(reply.text).toContain('已解封');
    expect(reply.text).toContain(ID);
    expect(approvals.propose).not.toHaveBeenCalled();
  });

  it('states the truth when no activation approval was created', async () => {
    const capabilities: CapabilityControl = {
      status: () => [{ name: 'demo', state: 'pending' }],
      ban: async () => undefined,
      unban: async () => undefined,
    };
    const { router } = harness({ capabilities });

    const reply = await router.handleOwnerText('#解封 demo', QQ_ORIGIN);

    expect(reply.text).toContain('已解封');
    expect(reply.text).toContain('未生成激活审批');
  });

  it('states the truth when the activation approval proposal fails', async () => {
    const capabilities: CapabilityControl = {
      status: () => [{ name: 'demo', state: 'pending' }],
      ban: async () => undefined,
      unban: async () => undefined,
      requestActivation: async () => ({ ok: false, code: 'not_implemented' }),
    };
    const { router } = harness({ capabilities });

    const reply = await router.handleOwnerText('#解封 demo', QQ_ORIGIN);

    expect(reply.text).toContain('已解封');
    expect(reply.text).toContain('激活审批生成失败');
    expect(reply.text).toContain('not_implemented');
  });

  it('silences the global outbound gate when no group is given', async () => {
    const { router, guard, state } = harness();

    const reply = await router.handleOwnerText('#安静 30', QQ_ORIGIN);

    expect(guard.silence).toHaveBeenCalledWith('*', NOW + 30 * 60_000);
    expect(state.setGroupSilencedUntil).toHaveBeenCalledWith('*', NOW + 30 * 60_000);
    expect(reply.text).toContain('全局');
  });

  it('silences a specific group', async () => {
    const { router, guard } = harness();
    await router.handleOwnerText('#安静 123 30', QQ_ORIGIN);
    expect(guard.silence).toHaveBeenCalledWith('123', NOW + 30 * 60_000);
  });

  it('accepts 1440 minutes and rejects 1441', async () => {
    const { router, guard } = harness();
    await router.handleOwnerText('#安静 1440', QQ_ORIGIN);
    expect(guard.silence).toHaveBeenCalledWith('*', NOW + 1440 * 60_000);

    guard.silence.mockClear();
    const reply = await router.handleOwnerText('#安静 1441', QQ_ORIGIN);
    expect(guard.silence).not.toHaveBeenCalled();
    expect(reply.text).toContain('用法');
  });

  it('treats #安静 0 as a resume', async () => {
    const { router, guard } = harness();
    const reply = await router.handleOwnerText('#安静 0', QQ_ORIGIN);
    expect(guard.resume).toHaveBeenCalled();
    expect(reply.text).toContain('恢复');
  });

  it('resumes the global gate or one group', async () => {
    const { router, guard, state } = harness();

    await router.handleOwnerText('#恢复', QQ_ORIGIN);
    expect(guard.resume).toHaveBeenCalledWith(undefined);
    expect(state.clearGroup).toHaveBeenCalledWith('*');

    guard.resume.mockClear();
    await router.handleOwnerText('#恢复 123', QQ_ORIGIN);
    expect(guard.resume).toHaveBeenCalledWith('123');
    expect(state.clearGroup).toHaveBeenCalledWith('123');
  });

  it('never proposes an approval for a prefix command', async () => {
    const { router, approvals } = harness();
    for (const text of ['#封禁 demo', '#解封 demo', '#安静 30', '#恢复', '#状态', '#审批']) {
      await router.handleOwnerText(text, QQ_ORIGIN);
    }
    expect(approvals.propose).not.toHaveBeenCalled();
  });
});

describe('control router natural language', () => {
  it('proposes a control.command approval for a side-effect intent', async () => {
    const { router, approvals, guard, brain } = harness();
    brain.chat.mockResolvedValue({
      content: JSON.stringify({
        intent: 'capability.ban',
        target: 'demo',
        minutes: 0,
        confidence: 0.9,
      }),
      toolCalls: [],
      reasoning: null,
      usage: { promptTokens: 0, completionTokens: 0 },
      endpoint: 'stub',
      model: 'stub',
    });

    const reply = await router.handleOwnerText('把 demo 封了吧', QQ_ORIGIN);

    expect(guard.silence).not.toHaveBeenCalled();
    expect(approvals.propose).toHaveBeenCalledTimes(1);
    const [payload, meta] = approvals.propose.mock.calls[0] ?? [];
    expect(payload).toEqual({
      kind: 'control.command',
      intent: 'capability.ban',
      args: { plugin: 'demo' },
    });
    expect(meta).toEqual({ createdVia: 'qq', createdBy: 'private:1' });
    expect(reply.handled).toBe(true);
    expect(reply.text).toContain('确认');
    expect(reply.text).toContain(ID2);
  });

  it('does not execute the side effect until the approval is confirmed', async () => {
    const { router, capabilities, brain } = harness();
    brain.chat.mockResolvedValue({
      content: JSON.stringify({
        intent: 'capability.ban',
        target: 'demo',
        minutes: 0,
        confidence: 0.9,
      }),
      toolCalls: [],
      reasoning: null,
      usage: { promptTokens: 0, completionTokens: 0 },
      endpoint: 'stub',
      model: 'stub',
    });

    await router.handleOwnerText('把 demo 封了吧', QQ_ORIGIN);
    expect(capabilities.ban).not.toHaveBeenCalled();
  });

  it('executes read-only natural language intents directly', async () => {
    const { router, approvals, status, brain } = harness();
    brain.chat.mockResolvedValue({
      content: JSON.stringify({ intent: 'status.read', target: '', minutes: 0, confidence: 0.9 }),
      toolCalls: [],
      reasoning: null,
      usage: { promptTokens: 0, completionTokens: 0 },
      endpoint: 'stub',
      model: 'stub',
    });

    const reply = await router.handleOwnerText('现在怎么样', QQ_ORIGIN);

    expect(status).toHaveBeenCalled();
    expect(approvals.propose).not.toHaveBeenCalled();
    expect(reply.handled).toBe(true);
  });

  it('falls back to chat when the classifier says none', async () => {
    const { router, approvals } = harness();
    const reply = await router.handleOwnerText('今天天气不错', QQ_ORIGIN);

    expect(approvals.propose).not.toHaveBeenCalled();
    expect(reply).toEqual({ text: '', handled: false });
  });

  it('honours a per-message confidence threshold from the channel', async () => {
    const { router, approvals, brain } = harness();
    brain.chat.mockResolvedValue({
      content: JSON.stringify({
        intent: 'capability.ban',
        target: 'demo',
        minutes: 0,
        confidence: 0.6,
      }),
      toolCalls: [],
      reasoning: null,
      usage: { promptTokens: 0, completionTokens: 0 },
      endpoint: 'stub',
      model: 'stub',
    });

    expect(await router.handleOwnerText('封禁 demo', QQ_ORIGIN)).toEqual({
      text: '',
      handled: false,
    });
    expect(approvals.propose).not.toHaveBeenCalled();

    const reply = await router.handleOwnerText('封禁 demo', QQ_ORIGIN, { minConfidence: 0.5 });
    expect(reply.handled).toBe(true);
    expect(approvals.propose).toHaveBeenCalledTimes(1);
  });

  it('falls back to chat when no brain is wired', async () => {
    const { router, approvals } = harness({ brain: undefined });
    const reply = await router.handleOwnerText('封禁 demo', QQ_ORIGIN);

    expect(approvals.propose).not.toHaveBeenCalled();
    expect(reply).toEqual({ text: '', handled: false });
  });

  it('does not run natural language from the web channel', async () => {
    const { router, approvals, brain } = harness();
    brain.chat.mockResolvedValue({
      content: JSON.stringify({
        intent: 'capability.ban',
        target: 'demo',
        minutes: 0,
        confidence: 0.99,
      }),
      toolCalls: [],
      reasoning: null,
      usage: { promptTokens: 0, completionTokens: 0 },
      endpoint: 'stub',
      model: 'stub',
    });

    const reply = await router.handleOwnerText('把 demo 封了吧', {
      channel: 'web',
      actor: 'web:session',
    });

    expect(reply).toEqual({ text: '', handled: false });
    expect(approvals.propose).not.toHaveBeenCalled();
    expect(brain.chat).not.toHaveBeenCalled();
  });
});

describe('control router approved command execution', () => {
  function controlRecord(intent: string, args: Record<string, string | number>): ApprovalRecord {
    const payload = { kind: 'control.command', intent, args } as unknown as ApprovalPayload;
    return approvalRecord({ kind: 'control.command', payload });
  }

  it('executes the four auto-tier side-effect intents', async () => {
    const { router, capabilities, guard } = harness();

    expect(await router.executeApproved(controlRecord('capability.ban', { plugin: 'demo' }))).toEqual(
      { ok: true },
    );
    expect(capabilities.ban).toHaveBeenCalledWith('demo');

    expect(
      await router.executeApproved(controlRecord('capability.unban', { plugin: 'demo' })),
    ).toEqual({ ok: true });
    expect(capabilities.unban).toHaveBeenCalledWith('demo');

    expect(
      await router.executeApproved(controlRecord('group.silence', { group: '123', minutes: 30 })),
    ).toEqual({ ok: true });
    expect(guard.silence).toHaveBeenCalledWith('123', NOW + 30 * 60_000);

    expect(await router.executeApproved(controlRecord('group.resume', { group: '123' }))).toEqual({
      ok: true,
    });
    expect(guard.resume).toHaveBeenCalledWith('123');
  });

  it('records an unban without an activation approval as a failed execution', async () => {
    const capabilities: CapabilityControl = {
      status: () => [{ name: 'demo', state: 'banned' }],
      ban: async () => undefined,
      unban: async () => undefined,
    };
    const { router } = harness({ capabilities });

    const result = await router.executeApproved(
      controlRecord('capability.unban', { plugin: 'demo' }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_implemented');
      expect(result.error).toContain('未生成激活审批');
    }
  });

  it('records a failed activation proposal as a failed execution', async () => {
    const capabilities: CapabilityControl = {
      status: () => [{ name: 'demo', state: 'banned' }],
      ban: async () => undefined,
      unban: async () => undefined,
      requestActivation: async () => ({ ok: false, code: 'invalid_body' }),
    };
    const { router } = harness({ capabilities });

    const result = await router.executeApproved(
      controlRecord('capability.unban', { plugin: 'demo' }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('conflict');
      expect(result.error).toContain('激活审批生成失败');
    }
  });

  it('whitelists intents itself and refuses approval-grade payloads', async () => {
    const { router, approvals } = harness();

    expect(
      await router.executeApproved(controlRecord('approval.decide', { id: ID })),
    ).toMatchObject({ ok: false, code: 'invalid_body' });
    expect(await router.executeApproved(controlRecord('status.read', {}))).toMatchObject({
      ok: false,
      code: 'invalid_body',
    });
    expect(await router.executeApproved(controlRecord('shell.exec', {}))).toMatchObject({
      ok: false,
      code: 'invalid_body',
    });
    expect(approvals.decide).not.toHaveBeenCalled();
  });

  it('rejects a non-control.command record', async () => {
    const { router } = harness();
    expect(await router.executeApproved(approvalRecord())).toMatchObject({
      ok: false,
      code: 'invalid_body',
    });
  });

  it('validates payload arguments before executing', async () => {
    const { router, guard } = harness();
    expect(
      await router.executeApproved(controlRecord('group.silence', { minutes: 1441 })),
    ).toEqual({ ok: false, code: 'invalid_body', error: expect.any(String) });
    expect(guard.silence).not.toHaveBeenCalled();
  });

  it('never re-enters the router or proposes a new approval', async () => {
    const { router, approvals } = harness();
    await router.executeApproved(controlRecord('capability.ban', { plugin: 'demo' }));
    expect(approvals.propose).not.toHaveBeenCalled();
    expect(approvals.decide).not.toHaveBeenCalled();
  });
});

describe('control port', () => {
  function fakeRouter(
    reply: ControlReply | (() => Promise<ControlReply>),
  ): ControlRouter & { handleOwnerText: ReturnType<typeof vi.fn<ControlRouter['handleOwnerText']>> } {
    return {
      handleOwnerText: vi.fn<ControlRouter['handleOwnerText']>(async () =>
        typeof reply === 'function' ? reply() : reply,
      ),
      executeApproved: vi.fn(async () => ({ ok: true as const })),
    };
  }

  function controlInput(overrides: Partial<ControlInput> = {}): ControlInput & {
    deliver: ReturnType<typeof vi.fn<() => void>>;
    reply: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
  } {
    const deliver = vi.fn<() => void>();
    const reply = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    return {
      via: 'qq',
      channel: 'qq:private:1',
      userId: '1',
      messageId: '1',
      text: '#状态',
      nlEnabled: false,
      ...overrides,
      // mock 放在最后：断言始终拿到同一个函数。
      deliver,
      reply,
    };
  }

  it('executes a prefix command and sends the reply', async () => {
    const router = fakeRouter({ text: '状态：正常', handled: true });
    const port = createControlPort({ getRouter: () => router });
    const input = controlInput({ text: '#状态' });

    const outcome = await port.handle(input);

    expect(outcome).toEqual({ action: 'handled' });
    expect(router.handleOwnerText).toHaveBeenCalledWith('#状态', {
      channel: 'qq',
      actor: 'private:1',
    });
    expect(input.reply).toHaveBeenCalledWith('状态：正常');
    expect(input.deliver).not.toHaveBeenCalled();
  });

  it('keeps control messages out of the queue when no router is wired', async () => {
    const port = createControlPort({ getRouter: () => null });
    const input = controlInput({ text: '#状态' });

    const outcome = await port.handle(input);

    expect(outcome).toEqual({ action: 'handled' });
    expect(input.reply).toHaveBeenCalledWith('控制面尚未启用。');
    expect(input.deliver).not.toHaveBeenCalled();
  });

  it('returns chat immediately for ordinary text when NL is disabled', async () => {
    const router = fakeRouter({ text: '', handled: false });
    const port = createControlPort({ getRouter: () => router });
    const input = controlInput({ text: '今天天气不错', nlEnabled: false });

    expect(await port.handle(input)).toEqual({ action: 'chat' });
    expect(router.handleOwnerText).not.toHaveBeenCalled();
    expect(input.reply).not.toHaveBeenCalled();
    expect(input.deliver).not.toHaveBeenCalled();
  });

  it('defers classification and delivers when the text is not a command', async () => {
    const router = fakeRouter({ text: '', handled: false });
    const port = createControlPort({ getRouter: () => router });
    const input = controlInput({ text: '今天天气不错', nlEnabled: true });

    const outcome = await port.handle(input);
    expect(outcome.action).toBe('deferred');

    await vi.waitFor(() => expect(input.deliver).toHaveBeenCalledTimes(1));
    expect(input.reply).not.toHaveBeenCalled();
  });

  it('sends the reply instead of delivering when NL classifies a command', async () => {
    const router = fakeRouter({ text: '已静默全局 30 分钟。', handled: true });
    const port = createControlPort({ getRouter: () => router });
    const input = controlInput({ text: '安静半小时', nlEnabled: true });

    await port.handle(input);

    await vi.waitFor(() =>
      expect(input.reply).toHaveBeenCalledWith('已静默全局 30 分钟。'),
    );
    expect(input.deliver).not.toHaveBeenCalled();
  });

  it('makes the deferred deliver callback idempotent', async () => {
    const router = fakeRouter({ text: '', handled: false });
    const port = createControlPort({ getRouter: () => router });
    const input = controlInput({ text: '闲聊', nlEnabled: true });

    const outcome = await port.handle(input);
    await vi.waitFor(() => expect(input.deliver).toHaveBeenCalledTimes(1));

    if (outcome.action === 'deferred') {
      outcome.deliver();
      outcome.deliver();
    }
    expect(input.deliver).toHaveBeenCalledTimes(1);
  });

  it('never turns a failing prefix command into chat', async () => {
    const router = fakeRouter(async () => {
      throw new Error('boom');
    });
    const log = vi.fn<(line: string) => void>();
    const port = createControlPort({ getRouter: () => router, log });
    const input = controlInput({ text: '#状态' });

    expect(await port.handle(input)).toEqual({ action: 'handled' });
    expect(input.reply).toHaveBeenCalledWith(expect.stringContaining('控制指令处理失败'));
    expect(input.deliver).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('control'));
  });

  it('delivers a failed NL candidate to the chat path', async () => {
    const router = fakeRouter(async () => {
      throw new Error('boom');
    });
    const port = createControlPort({ getRouter: () => router });
    const input = controlInput({ text: '今天天气不错', nlEnabled: true });

    expect(await port.handle(input)).toEqual({
      action: 'deferred',
      deliver: expect.any(Function),
    });
    await vi.waitFor(() => expect(input.deliver).toHaveBeenCalledTimes(1));
    expect(input.reply).not.toHaveBeenCalled();
  });

  it('forwards the per-message confidence threshold to the router', async () => {
    const router = fakeRouter({ text: '', handled: false });
    const port = createControlPort({ getRouter: () => router });
    const input = controlInput({ text: '封禁 demo', nlEnabled: true, nlMinConfidence: 0.5 });

    await port.handle(input);

    await vi.waitFor(() =>
      expect(router.handleOwnerText).toHaveBeenCalledWith(
        '封禁 demo',
        { channel: 'qq', actor: 'private:1' },
        { minConfidence: 0.5 },
      ),
    );
  });

  it('logs a failing reply without turning a handled command into chat', async () => {
    const router = fakeRouter({ text: '已处理。', handled: true });
    const log = vi.fn<(line: string) => void>();
    const port = createControlPort({ getRouter: () => router, log });
    const input = controlInput({ text: '#状态' });
    input.reply.mockRejectedValue(new Error('send failed'));

    expect(await port.handle(input)).toEqual({ action: 'handled' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('reply failed'));
  });
});

describe('control audit trail', () => {
  it('records every handled command with via, actor, intent and result', async () => {
    const rows: ControlAuditRow[] = [];
    const { router } = harness({ audit: { record: (row) => rows.push(row) } });

    const reply = await router.handleOwnerText('#状态', {
      channel: 'qq',
      actor: 'private:1',
    });

    expect(reply.handled).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: 'command',
      via: 'qq',
      actor: 'private:1',
      command: '#状态',
      intent: 'status.read',
      result: 'handled',
    });
    expect(typeof rows[0]?.ts).toBe('string');
  });

  it('records the minted approval id and the real origin for #解封', async () => {
    const rows: ControlAuditRow[] = [];
    const { router, capabilities } = harness({ audit: { record: (row) => rows.push(row) } });

    await router.handleOwnerText('#解封 demo', { channel: 'qq', actor: 'private:1' });

    // 激活审批必须带上真正发起它的通道与 actor，而不是 'system'。
    expect(capabilities.requestActivation).toHaveBeenCalledWith('demo', {
      createdVia: 'qq',
      createdBy: 'private:1',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: 'command',
      intent: 'capability.unban',
      result: 'handled',
      approvalId: ID,
    });
  });

  it('records usage failures as commands, never as chat', async () => {
    const rows: ControlAuditRow[] = [];
    const { router } = harness({ audit: { record: (row) => rows.push(row) } });

    const reply = await router.handleOwnerText('#同意', { channel: 'qq', actor: 'private:1' });

    expect(reply.handled).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: 'command', command: '#同意', result: 'usage' });
  });
});
