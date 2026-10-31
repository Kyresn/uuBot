import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Applier, ApplierOutcome } from '../../src/approvals/appliers.js';
import { newApprovalId } from '../../src/approvals/ids.js';
import { fingerprintPayload } from '../../src/approvals/policy.js';
import {
  ApprovalService,
  type ApprovalServiceOptions,
} from '../../src/approvals/service.js';
import { APPROVALS_FILE, saveApprovals } from '../../src/approvals/store.js';
import type {
  ApprovalEvent,
  ApprovalPayload,
  ApprovalRecord,
} from '../../src/approvals/types.js';

let dir: string;
let logs: string[];
let wall: number;
let mono: number;
let services: ApprovalService[];

const START = Date.parse('2026-10-30T00:00:00.000Z');

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'uuharness-approvals-service-'));
  logs = [];
  wall = START;
  mono = 1_000;
  services = [];
});

afterEach(async () => {
  for (const service of services) {
    await service.stop().catch(() => undefined);
  }
  await rm(dir, { recursive: true, force: true });
});

function makeService(overrides: Partial<ApprovalServiceOptions> = {}): ApprovalService {
  const service = new ApprovalService({
    dataDir: dir,
    log: (line) => logs.push(line),
    now: () => wall,
    monoNow: () => mono,
    scanIntervalMs: 0,
    ...overrides,
  });
  services.push(service);
  return service;
}

function commandPayload(args: Record<string, string | number> = { minutes: 30 }): ApprovalPayload {
  return { kind: 'control.command', intent: 'group.silence', args };
}

function capabilityPayload(overrides: Partial<{
  plugin: string;
  version: string;
  fingerprint: string;
  declaredPermissions: string[];
  toolNames: string[];
}> = {}): ApprovalPayload {
  return {
    kind: 'capability.activate',
    plugin: 'demo',
    version: '1.0.0',
    fingerprint: 'manifest-sha',
    declaredPermissions: [],
    toolNames: [],
    ...overrides,
  };
}

function makeRecord(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  const payload = overrides.payload ?? commandPayload();
  return {
    id: newApprovalId(),
    kind: payload.kind,
    status: 'pending',
    tier: 'human',
    title: '控制指令',
    summary: '意图 group.silence',
    payload,
    fingerprint: fingerprintPayload(payload),
    createdAt: '2026-10-30T00:00:00.000Z',
    expiresAt: '2026-10-30T00:01:00.000Z',
    expiresAtMono: 1_000,
    createdVia: 'qq',
    createdBy: 'owner',
    ...overrides,
  };
}

type FakeApplier = { applier: Applier; calls: ApprovalRecord[] };

function fakeApplier(
  outcome: ApplierOutcome | (() => Promise<ApplierOutcome>) = { ok: true },
): FakeApplier {
  const calls: ApprovalRecord[] = [];
  const applier: Applier = async (record) => {
    calls.push(record);
    return typeof outcome === 'function' ? outcome() : outcome;
  };
  return { applier, calls };
}

async function propose(
  service: ApprovalService,
  payload: ApprovalPayload = commandPayload(),
): Promise<ApprovalRecord> {
  const result = await service.propose(payload, { createdVia: 'qq', createdBy: 'owner' });
  if (!result.ok) throw new Error(`propose failed: ${result.code}`);
  return result.record;
}

async function storedRecords(): Promise<ApprovalRecord[]> {
  const text = await readFile(path.join(dir, APPROVALS_FILE), 'utf8');
  return (JSON.parse(text) as { records: ApprovalRecord[] }).records;
}

describe('ApprovalService state machine', () => {
  it('approves, executes exactly once, and persists only pending records', async () => {
    const { applier, calls } = fakeApplier();
    const service = makeService({ appliers: { 'capability.activate': applier } });
    await service.load();

    const proposed = await propose(service, capabilityPayload());
    expect(proposed.status).toBe('pending');
    expect(proposed.tier).toBe('human');
    expect(proposed.expiresAtMono).toBe(mono + 30 * 60_000);
    expect(await storedRecords()).toHaveLength(1);

    const decided = await service.decide(proposed.id, {
      decision: 'approve',
      via: 'qq',
      by: 'owner',
    });

    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    expect(decided.record.status).toBe('approved');
    expect(decided.record.decidedVia).toBe('qq');
    expect(decided.record.decidedBy).toBe('owner');
    expect(decided.record.execution?.state).toBe('done');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe(proposed.id);
    expect(service.get(proposed.id)?.status).toBe('approved');
    expect(await storedRecords()).toEqual([]);
  });

  it('denies without executing', async () => {
    const { applier, calls } = fakeApplier();
    const service = makeService({ appliers: { 'control.command': applier } });
    await service.load();

    const proposed = await propose(service);
    const decided = await service.decide(proposed.id, {
      decision: 'deny',
      via: 'qq',
      by: 'owner',
      reason: 'not now',
    });

    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    expect(decided.record.status).toBe('denied');
    expect(decided.record.decisionReason).toBe('not now');
    expect(decided.record.execution).toBeUndefined();
    expect(calls).toEqual([]);
    expect(service.list({ status: 'pending' })).toEqual([]);
  });

  it('expires a pending record once its monotonic deadline passes', async () => {
    const { applier, calls } = fakeApplier();
    const service = makeService({
      appliers: { 'control.command': applier },
      ttl: { controlCommandMs: 60_000 },
    });
    await service.load();

    const proposed = await propose(service);
    mono += 60_001;

    const decided = await service.decide(proposed.id, {
      decision: 'approve',
      via: 'qq',
      by: 'owner',
    });

    expect(decided).toMatchObject({ ok: false, code: 'expired' });
    expect(service.get(proposed.id)?.status).toBe('expired');
    expect(calls).toEqual([]);
  });

  it('cancels a pending record and refuses a second cancellation', async () => {
    const { applier, calls } = fakeApplier();
    const service = makeService({ appliers: { 'control.command': applier } });
    await service.load();

    const proposed = await propose(service);
    const cancelled = await service.cancel(proposed.id, {
      via: 'web',
      by: 'web:session',
      reason: 'superseded',
    });

    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    expect(cancelled.record.status).toBe('cancelled');
    expect(cancelled.record.decisionReason).toBe('superseded');
    expect(calls).toEqual([]);

    const again = await service.cancel(proposed.id, { via: 'web', by: 'web:session' });
    expect(again).toMatchObject({ ok: false, code: 'not_pending' });
    expect(service.get(proposed.id)?.status).toBe('cancelled');
  });

  it('marks a record stale when the applier reports a fingerprint mismatch', async () => {
    const { applier } = fakeApplier({ ok: false, code: 'stale', error: 'manifest changed' });
    const service = makeService({ appliers: { 'capability.activate': applier } });
    await service.load();

    const proposed = await propose(service, capabilityPayload());
    const decided = await service.decide(proposed.id, {
      decision: 'approve',
      via: 'web',
      by: 'web:session',
    });

    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    expect(decided.record.status).toBe('stale');
    expect(decided.record.execution?.state).toBe('failed');
    expect(decided.record.execution?.error).toContain('manifest changed');
  });

  it('keeps the record approved when the applier throws and records the failure', async () => {
    const applier: Applier = async () => {
      throw new Error('worker \u001b[31mboom\u001b[0m failed');
    };
    const service = makeService({ appliers: { 'capability.activate': applier } });
    await service.load();

    const proposed = await propose(service, capabilityPayload());
    const decided = await service.decide(proposed.id, {
      decision: 'approve',
      via: 'web',
      by: 'web:session',
    });

    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    expect(decided.record.status).toBe('approved');
    expect(decided.record.execution?.state).toBe('failed');
    expect(decided.record.execution?.error).not.toContain('\u001b');
    expect(decided.record.execution?.error).toContain('boom');
    expect(service.get(proposed.id)?.status).toBe('approved');
    expect(logs.some((line) => line.includes(proposed.id))).toBe(true);
  });

  it('returns not_found for an unknown id', async () => {
    const service = makeService();
    await service.load();

    await expect(
      service.decide('ap_00000000000000000000000000000000', {
        decision: 'approve',
        via: 'qq',
        by: 'owner',
      }),
    ).resolves.toEqual({ ok: false, code: 'not_found' });
  });

  it('returns not_pending for an already decided record', async () => {
    const { applier } = fakeApplier();
    const service = makeService({ appliers: { 'control.command': applier } });
    await service.load();

    const proposed = await propose(service);
    await service.decide(proposed.id, { decision: 'deny', via: 'qq', by: 'owner' });

    const second = await service.decide(proposed.id, {
      decision: 'approve',
      via: 'qq',
      by: 'owner',
    });

    expect(second).toMatchObject({ ok: false, code: 'not_pending' });
    expect(service.get(proposed.id)?.status).toBe('denied');
  });

  it('times out a hung applier instead of hanging the decision', async () => {
    const applier: Applier = () => new Promise<ApplierOutcome>(() => undefined);
    const service = makeService({
      appliers: { 'capability.activate': applier },
      executionTimeoutMs: 20,
    });
    await service.load();

    const proposed = await propose(service, capabilityPayload());
    const decided = await service.decide(proposed.id, {
      decision: 'approve',
      via: 'web',
      by: 'web:session',
    });

    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    expect(decided.record.status).toBe('approved');
    expect(decided.record.execution).toEqual({
      state: 'failed',
      at: expect.any(String),
      error: 'timeout',
    });
    expect(logs.some((line) => line.includes('timeout'))).toBe(true);
  });

  it('ignores a late applier result after the timeout', async () => {
    const applier: Applier = async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { ok: true };
    };
    const service = makeService({
      appliers: { 'capability.activate': applier },
      executionTimeoutMs: 20,
    });
    await service.load();
    const events: ApprovalEvent[] = [];
    service.on((event) => events.push(event));

    const proposed = await propose(service, capabilityPayload());
    const decided = await service.decide(proposed.id, {
      decision: 'approve',
      via: 'web',
      by: 'web:session',
    });
    expect(decided.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(service.get(proposed.id)?.execution).toMatchObject({
      state: 'failed',
      error: 'timeout',
    });
    expect(events.filter((event) => event.type === 'executed')).toHaveLength(1);
  });

  it.each(['', 'APPROVE', 'yes', undefined])(
    'rejects the unknown decision %p with invalid_body and no state change',
    async (value) => {
      const { applier, calls } = fakeApplier();
      const service = makeService({ appliers: { 'control.command': applier } });
      await service.load();

      const proposed = await propose(service);
      const decided = await service.decide(proposed.id, {
        decision: value as 'approve',
        via: 'qq',
        by: 'owner',
      });

      expect(decided).toEqual({ ok: false, code: 'invalid_body' });
      expect(service.get(proposed.id)?.status).toBe('pending');
      expect(calls).toEqual([]);
    },
  );

  it('returns invalid_body for a non-cloneable payload', async () => {
    const service = makeService();
    await service.load();

    const payload = {
      kind: 'control.command',
      intent: 'help.read',
      args: {},
      fn: () => 1,
    } as unknown as ApprovalPayload;

    await expect(
      service.propose(payload, { createdVia: 'qq', createdBy: 'owner' }),
    ).resolves.toEqual({ ok: false, code: 'invalid_body' });
  });

  it.each([
    { kind: 'control.command', intent: 42, args: {} },
    { kind: 'control.command', intent: 'help.read', args: { minutes: true } },
    { kind: 'capability.activate', plugin: 'demo' },
  ])('returns invalid_body for a malformed payload %#', async (payload) => {
    const service = makeService();
    await service.load();

    const result = await service.propose(payload as unknown as ApprovalPayload, {
      createdVia: 'qq',
      createdBy: 'owner',
    });

    expect(result).toEqual({ ok: false, code: 'invalid_body' });
    expect(service.list({ status: 'all', includeControl: true })).toEqual([]);
  });

  it('rejects an off-enum control intent at propose', async () => {
    const service = makeService();
    await service.load();

    const payload = {
      kind: 'control.command',
      intent: 'capability.selfdestruct',
      args: {},
    } as unknown as ApprovalPayload;

    await expect(
      service.propose(payload, { createdVia: 'qq', createdBy: 'owner' }),
    ).resolves.toEqual({ ok: false, code: 'invalid_body' });
  });

  it('gives the applier a clone so its mutations do not reach the record', async () => {
    const applier: Applier = async (record) => {
      record.summary = 'mutated';
      record.status = 'denied';
      if (record.payload.kind === 'control.command') record.payload.args.minutes = 999;
      return { ok: true };
    };
    const service = makeService({ appliers: { 'control.command': applier } });
    await service.load();

    const proposed = await propose(service);
    await service.decide(proposed.id, { decision: 'approve', via: 'qq', by: 'owner' });

    const stored = service.get(proposed.id);
    expect(stored?.status).toBe('approved');
    expect(stored?.summary).not.toBe('mutated');
    expect(stored?.payload).toEqual(commandPayload());
  });

  it('does not resolve id prefixes', async () => {
    const service = makeService();
    await service.load();

    const proposed = await propose(service);
    const prefix = proposed.id.slice(0, 10);

    expect(service.get(prefix)).toBeUndefined();
    await expect(
      service.decide(prefix, { decision: 'approve', via: 'qq', by: 'owner' }),
    ).resolves.toEqual({ ok: false, code: 'not_found' });
  });
});

describe('ApprovalService channel binding', () => {
  it('rejects web decisions for control.command and changes nothing', async () => {
    const { applier, calls } = fakeApplier();
    const service = makeService({ appliers: { 'control.command': applier } });
    await service.load();

    const proposed = await propose(service);
    const decided = await service.decide(proposed.id, {
      decision: 'approve',
      via: 'web',
      by: 'web:session',
    });

    expect(decided).toMatchObject({ ok: false, code: 'wrong_channel' });
    if (decided.ok) return;
    expect(decided.record?.status).toBe('pending');
    expect(decided.record?.decidedAt).toBeUndefined();
    expect(decided.record?.decidedVia).toBeUndefined();
    expect(service.get(proposed.id)?.status).toBe('pending');
    expect(calls).toEqual([]);
    expect(await storedRecords()).toHaveLength(1);
  });

  it('rejects system decisions for control.command', async () => {
    const { applier, calls } = fakeApplier();
    const service = makeService({ appliers: { 'control.command': applier } });
    await service.load();

    const proposed = await propose(service);
    const decided = await service.decide(proposed.id, {
      decision: 'approve',
      via: 'system',
      by: 'system',
    });

    expect(decided).toMatchObject({ ok: false, code: 'wrong_channel' });
    expect(calls).toEqual([]);
  });

  it('allows web decisions for capability.activate', async () => {
    const { applier, calls } = fakeApplier();
    const service = makeService({ appliers: { 'capability.activate': applier } });
    await service.load();

    const proposed = await propose(service, capabilityPayload());
    const decided = await service.decide(proposed.id, {
      decision: 'approve',
      via: 'web',
      by: 'web:session',
    });

    expect(decided.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('allows qq decisions for control.command', async () => {
    const { applier, calls } = fakeApplier();
    const service = makeService({ appliers: { 'control.command': applier } });
    await service.load();

    const proposed = await propose(service);
    const decided = await service.decide(proposed.id, {
      decision: 'approve',
      via: 'qq',
      by: 'owner',
    });

    expect(decided.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('excludes control.command from the default list but includes it on request', async () => {
    const service = makeService();
    await service.load();

    const command = await propose(service);
    const capability = await propose(service, capabilityPayload());

    expect(service.list().map((record) => record.id)).toEqual([capability.id]);
    expect(
      service
        .list({ includeControl: true })
        .map((record) => record.id)
        .sort(),
    ).toEqual([command.id, capability.id].sort());
    expect(service.get(command.id)?.status).toBe('pending');
  });
});

describe('ApprovalService concurrency', () => {
  it('executes exactly once when both channels decide concurrently', async () => {
    const { applier, calls } = fakeApplier(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { ok: true };
    });
    const service = makeService({ appliers: { 'capability.activate': applier } });
    await service.load();

    const proposed = await propose(service, capabilityPayload());
    const [first, second] = await Promise.all([
      service.decide(proposed.id, { decision: 'approve', via: 'qq', by: 'owner' }),
      service.decide(proposed.id, { decision: 'approve', via: 'web', by: 'web:session' }),
    ]);

    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    const loser = first.ok ? second : first;
    expect(loser).toMatchObject({ ok: false, code: 'not_pending' });
    expect(calls).toHaveLength(1);
    expect(service.get(proposed.id)?.execution?.state).toBe('done');
  });

  it('leaves an executing record alone when expireDue runs', async () => {
    const { applier } = fakeApplier(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { ok: true };
    });
    const service = makeService({ appliers: { 'capability.activate': applier } });
    await service.load();

    const proposed = await propose(service, capabilityPayload());
    const decision = service.decide(proposed.id, {
      decision: 'approve',
      via: 'web',
      by: 'web:session',
    });
    // 等临界区把记录写成 approved，此时 Applier 仍在执行。
    await new Promise((resolve) => setTimeout(resolve, 5));

    mono += 31 * 60_000;
    await service.expireDue();

    expect(service.get(proposed.id)?.status).toBe('approved');
    await decision;
    expect(service.get(proposed.id)?.execution?.state).toBe('done');
  });

  it('stop is bounded by the execution timeout when an applier hangs', async () => {
    const applier: Applier = () => new Promise<ApplierOutcome>(() => undefined);
    const service = makeService({
      appliers: { 'capability.activate': applier },
      executionTimeoutMs: 20,
    });
    await service.load();

    const proposed = await propose(service, capabilityPayload());
    const decision = service.decide(proposed.id, {
      decision: 'approve',
      via: 'web',
      by: 'web:session',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await service.stop();

    await expect(decision).resolves.toMatchObject({ ok: true });
    expect(service.get(proposed.id)?.execution?.state).toBe('failed');
  });

  it('serializes concurrent proposals without losing records', async () => {
    const service = makeService();
    await service.load();

    const results = await Promise.all([
      service.propose(commandPayload({ minutes: 1 }), { createdVia: 'qq', createdBy: 'owner' }),
      service.propose(commandPayload({ minutes: 2 }), { createdVia: 'qq', createdBy: 'owner' }),
      service.propose(commandPayload({ minutes: 3 }), { createdVia: 'qq', createdBy: 'owner' }),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(service.list({ status: 'pending', includeControl: true })).toHaveLength(3);
    expect(await storedRecords()).toHaveLength(3);
  });
});

describe('ApprovalService TTL', () => {
  it('uses the 60s default confirm TTL for control.command', async () => {
    const service = makeService();
    await service.load();

    const proposed = await propose(service);

    expect(proposed.expiresAtMono).toBe(mono + 60_000);
    expect(proposed.expiresAt).toBe(new Date(wall + 60_000).toISOString());
  });

  it('uses the monotonic clock so a wall-clock rollback cannot revive a record', async () => {
    const { applier, calls } = fakeApplier();
    const service = makeService({
      appliers: { 'control.command': applier },
      ttl: { controlCommandMs: 60_000 },
    });
    await service.load();

    const proposed = await propose(service);
    mono += 60_001;
    wall -= 3_600_000;

    const decided = await service.decide(proposed.id, {
      decision: 'approve',
      via: 'qq',
      by: 'owner',
    });

    expect(decided).toMatchObject({ ok: false, code: 'expired' });
    expect(calls).toEqual([]);
  });

  it('does not expire a record when only the wall clock jumps forward', async () => {
    const { applier } = fakeApplier();
    const service = makeService({ appliers: { 'control.command': applier } });
    await service.load();

    const proposed = await propose(service);
    wall += 3_600_000;

    const decided = await service.decide(proposed.id, {
      decision: 'approve',
      via: 'qq',
      by: 'owner',
    });

    expect(decided.ok).toBe(true);
  });

  it('clamps restored pending deadlines to now + restoreGraceMs', async () => {
    const first = makeService();
    await first.load();
    const proposed = await propose(first, capabilityPayload());
    await first.stop();

    const second = makeService({ restoreGraceMs: 10 * 60_000 });
    await second.load();

    const restored = second.get(proposed.id);
    expect(restored?.status).toBe('pending');
    expect(restored?.expiresAt).toBe(new Date(wall + 10 * 60_000).toISOString());
    expect(restored?.expiresAtMono).toBe(mono + 10 * 60_000);
  });

  it('uses the 10-minute default restore grace', async () => {
    const first = makeService();
    await first.load();
    const proposed = await propose(first, capabilityPayload());
    await first.stop();

    const second = makeService();
    await second.load();

    expect(second.get(proposed.id)?.expiresAt).toBe(
      new Date(wall + 10 * 60_000).toISOString(),
    );
  });

  it('keeps a stored deadline shorter than the restore grace', async () => {
    const payload = capabilityPayload();
    const dueSoon = makeRecord({
      payload,
      expiresAt: new Date(START + 2 * 60_000).toISOString(),
      expiresAtMono: 0,
    });
    await saveApprovals(dir, [dueSoon]);

    const service = makeService();
    await service.load();

    expect(service.get(dueSoon.id)?.expiresAt).toBe(
      new Date(START + 2 * 60_000).toISOString(),
    );
    expect(service.get(dueSoon.id)?.expiresAtMono).toBe(mono + 2 * 60_000);
  });

  it('expires records that were already due when the process restarted', async () => {
    const due = makeRecord({
      expiresAt: new Date(START - 1_000).toISOString(),
      expiresAtMono: 0,
    });
    await saveApprovals(dir, [due]);

    const service = makeService();
    await service.load();

    expect(service.get(due.id)?.status).toBe('expired');
    expect(service.list({ status: 'pending' })).toEqual([]);
  });

  it('expireDue marks every overdue pending record expired', async () => {
    const { applier } = fakeApplier();
    const service = makeService({
      appliers: { 'control.command': applier },
      ttl: { controlCommandMs: 60_000 },
    });
    await service.load();

    const first = await propose(service);
    const second = await propose(service);
    mono += 60_001;

    await service.expireDue();

    expect(service.get(first.id)?.status).toBe('expired');
    expect(service.get(second.id)?.status).toBe('expired');
    expect(await storedRecords()).toEqual([]);
  });

  it('scans for expiry on its interval', async () => {
    const { applier } = fakeApplier();
    const service = makeService({
      appliers: { 'control.command': applier },
      ttl: { controlCommandMs: 60_000 },
      scanIntervalMs: 5,
    });
    await service.load();

    const proposed = await propose(service);
    mono += 60_001;
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(service.get(proposed.id)?.status).toBe('expired');
    await service.stop();
  });
});

describe('ApprovalService persistence', () => {
  it('drops fingerprint mismatches on load', async () => {
    const tampered = makeRecord({ fingerprint: 'f'.repeat(64) });
    await saveApprovals(dir, [tampered]);

    const service = makeService();
    await service.load();

    expect(service.list({ status: 'all', includeControl: true })).toEqual([]);
    expect(logs.some((line) => line.includes(tampered.id))).toBe(true);
  });

  it('starts empty when approvals.json is corrupt', async () => {
    await writeFile(path.join(dir, APPROVALS_FILE), '{ not json', 'utf8');

    const service = makeService();
    await service.load();

    expect(service.list({ status: 'all' })).toEqual([]);
    expect(logs.some((line) => line.includes('损坏'))).toBe(true);
  });

  it('re-renders the summary from the payload on load', async () => {
    const record = makeRecord({ summary: 'forged \u001b[31msummary' });
    await saveApprovals(dir, [record]);

    const service = makeService();
    await service.load();

    const restored = service.get(record.id);
    expect(restored?.summary).not.toContain('forged');
    expect(restored?.summary).toContain('group.silence');
  });

  it('recomputes the tier from the policy on load instead of trusting disk', async () => {
    const record = makeRecord({ tier: 'auto' });
    await saveApprovals(dir, [record]);

    const service = makeService();
    await service.load();

    expect(service.get(record.id)?.tier).toBe('human');
  });

  it('does not follow mutations of the caller payload after propose', async () => {
    const { applier } = fakeApplier();
    const service = makeService({ appliers: { 'control.command': applier } });
    await service.load();

    const payload: ApprovalPayload = {
      kind: 'control.command',
      intent: 'group.silence',
      args: { minutes: 30 },
    };
    const proposed = await propose(service, payload);
    if (payload.kind === 'control.command') payload.args.minutes = 99;

    const decided = await service.decide(proposed.id, {
      decision: 'approve',
      via: 'qq',
      by: 'owner',
    });

    expect(decided.ok).toBe(true);
    expect(service.get(proposed.id)?.payload).toEqual({
      kind: 'control.command',
      intent: 'group.silence',
      args: { minutes: 30 },
    });
  });

  it('is idempotent and does not wipe in-memory records', async () => {
    const service = makeService();
    await service.load();
    const proposed = await propose(service);

    await service.load();

    expect(service.get(proposed.id)?.status).toBe('pending');
    expect(service.list({ status: 'all', includeControl: true })).toHaveLength(1);
  });

  it('does not lose a record when load runs during an in-flight decide', async () => {
    const { applier } = fakeApplier(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true };
    });
    const service = makeService({ appliers: { 'capability.activate': applier } });
    await service.load();

    const proposed = await propose(service, capabilityPayload());
    const decision = service.decide(proposed.id, {
      decision: 'approve',
      via: 'web',
      by: 'web:session',
    });
    await new Promise((resolve) => setTimeout(resolve, 1));

    await service.load();

    await expect(decision).resolves.toMatchObject({ ok: true });
    expect(service.get(proposed.id)?.status).toBe('approved');
    expect(service.get(proposed.id)?.execution?.state).toBe('done');
  });

  it('reports conflict when a terminal decision cannot be persisted', async () => {
    const writer = async (): Promise<void> => {
      throw new Error('disk full');
    };
    const { applier, calls } = fakeApplier();
    const service = makeService({
      appliers: { 'control.command': applier },
      writeApprovals: writer,
    });
    await service.load();

    const proposed = await propose(service);
    const decided = await service.decide(proposed.id, {
      decision: 'deny',
      via: 'qq',
      by: 'owner',
    });

    expect(decided).toMatchObject({ ok: false, code: 'conflict' });
    if (decided.ok) return;
    expect(decided.record?.status).toBe('denied');
    expect(service.get(proposed.id)?.status).toBe('denied');
    expect(logs).toContain('approvals: persist failed after terminal decision');
    expect(calls).toEqual([]);
  });

  it('marks an approve that cannot be persisted as failed without executing', async () => {
    const writer = async (): Promise<void> => {
      throw new Error('disk full');
    };
    const { applier, calls } = fakeApplier();
    const service = makeService({
      appliers: { 'capability.activate': applier },
      writeApprovals: writer,
    });
    await service.load();
    const events: ApprovalEvent[] = [];
    service.on((event) => events.push(event));

    const proposed = await propose(service, capabilityPayload());
    const decided = await service.decide(proposed.id, {
      decision: 'approve',
      via: 'web',
      by: 'web:session',
    });

    expect(decided).toMatchObject({ ok: false, code: 'conflict' });
    if (decided.ok || decided.record === undefined) return;
    expect(decided.record.status).toBe('approved');
    expect(decided.record.execution).toMatchObject({
      state: 'failed',
      error: 'persist failed',
    });
    expect(calls).toEqual([]);
    expect(service.get(proposed.id)?.execution?.state).toBe('failed');
    expect(events.map((event) => event.type)).toEqual(['proposed', 'executed']);
    expect(events[1]?.record.execution?.state).toBe('failed');

    const retry = await service.decide(proposed.id, {
      decision: 'approve',
      via: 'web',
      by: 'web:session',
    });
    expect(retry).toMatchObject({ ok: false, code: 'not_pending' });
  });

  it('drops a forged lethal payload on load', async () => {
    const payload: ApprovalPayload = {
      kind: 'capability.activate',
      plugin: 'evil',
      version: '1.0.0',
      fingerprint: 'manifest-sha',
      declaredPermissions: ['memory', 'net'],
      toolNames: [],
    };
    const forged = makeRecord({ payload, fingerprint: fingerprintPayload(payload) });
    await saveApprovals(dir, [forged]);

    const service = makeService();
    await service.load();

    expect(service.get(forged.id)).toBeUndefined();
    expect(logs.some((line) => line.includes('致命三要素'))).toBe(true);
  });
});

describe('ApprovalService policy gate', () => {
  it('refuses the lethal trifecta at propose time', async () => {
    const service = makeService();
    await service.load();

    const result = await service.propose(
      capabilityPayload({ declaredPermissions: ['memory', 'net'] }),
      { createdVia: 'qq', createdBy: 'owner' },
    );

    expect(result).toEqual({ ok: false, code: 'lethal_trifecta' });
    expect(service.list({ status: 'all' })).toEqual([]);
    expect(await storedRecords()).toEqual([]);
  });

  it('returns not_implemented for a kind without an applier', async () => {
    const service = makeService({ appliers: { 'control.command': undefined } });
    await service.load();

    const result = await service.propose(commandPayload(), {
      createdVia: 'qq',
      createdBy: 'owner',
    });

    expect(result).toEqual({ ok: false, code: 'not_implemented' });
    expect(service.list({ status: 'all', includeControl: true })).toEqual([]);
  });
});

describe('ApprovalService events', () => {
  it('emits proposed, decided, and executed in order', async () => {
    const { applier } = fakeApplier();
    const service = makeService({ appliers: { 'control.command': applier } });
    await service.load();
    const events: ApprovalEvent[] = [];
    service.on((event) => events.push(event));

    const proposed = await propose(service);
    await service.decide(proposed.id, { decision: 'approve', via: 'qq', by: 'owner' });

    expect(events.map((event) => event.type)).toEqual(['proposed', 'decided', 'executed']);
    expect(events.every((event) => event.record.id === proposed.id)).toBe(true);
  });

  it('emits expired when expireDue sweeps a record', async () => {
    const { applier } = fakeApplier();
    const service = makeService({
      appliers: { 'control.command': applier },
      ttl: { controlCommandMs: 60_000 },
    });
    await service.load();
    const events: ApprovalEvent[] = [];
    service.on((event) => events.push(event));

    const proposed = await propose(service);
    mono += 60_001;
    await service.expireDue();

    expect(events.map((event) => event.type)).toEqual(['proposed', 'expired']);
    expect(events[1]?.record.id).toBe(proposed.id);
  });

  it('stops delivering after unsubscribe', async () => {
    const service = makeService();
    await service.load();
    const events: ApprovalEvent[] = [];
    const off = service.on((event) => events.push(event));

    off();
    await propose(service);

    expect(events).toEqual([]);
  });

  it('keeps working when a listener throws', async () => {
    const service = makeService();
    await service.load();
    service.on(() => {
      throw new Error('listener boom');
    });

    const proposed = await propose(service);

    expect(service.get(proposed.id)?.status).toBe('pending');
    expect(logs.some((line) => line.includes('listener'))).toBe(true);
  });
});

describe('ApprovalService list TTL filter', () => {
  it('hides elapsed pending records from list() and the pending count until the scanner runs', async () => {
    const service = makeService();
    await service.load();
    const record = await propose(service, capabilityPayload());

    // capability.activate 的默认 TTL 是 30 分钟；推进单调时钟越过它，
    // 扫描器（这里关闭）尚未运行，但列表不能把过期卡片当成可操作项。
    mono += 30 * 60_000 + 1;

    expect(service.list({ status: 'pending' })).toEqual([]);
    expect(service.list({ status: 'all' })).toHaveLength(1);
    // 状态本身没变：过期判定只在扫描/决策的临界区里落盘。
    expect(service.get(record.id)?.status).toBe('pending');
  });
});
