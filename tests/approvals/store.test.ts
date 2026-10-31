import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { newApprovalId } from '../../src/approvals/ids.js';
import { fingerprintPayload } from '../../src/approvals/policy.js';
import { APPROVALS_FILE, loadApprovals, saveApprovals } from '../../src/approvals/store.js';
import type { ApprovalPayload, ApprovalRecord } from '../../src/approvals/types.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'uuharness-approvals-store-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function commandPayload(): ApprovalPayload {
  return { kind: 'control.command', intent: 'group.silence', args: { minutes: 30 } };
}

function record(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
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

async function readStore(): Promise<{
  version: number;
  bootId: string;
  updatedAt: string;
  records: ApprovalRecord[];
}> {
  return JSON.parse(await readFile(path.join(dir, APPROVALS_FILE), 'utf8')) as {
    version: number;
    bootId: string;
    updatedAt: string;
    records: ApprovalRecord[];
  };
}

describe('saveApprovals', () => {
  it('writes only pending records in the documented envelope', async () => {
    const pending = record();
    const approved = record({ status: 'approved' });

    await saveApprovals(dir, [pending, approved]);

    const stored = await readStore();
    expect(stored.version).toBe(1);
    expect(typeof stored.bootId).toBe('string');
    expect(stored.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(stored.records.map((entry) => entry.id)).toEqual([pending.id]);
  });

  it('writes an empty record list when nothing is pending', async () => {
    await saveApprovals(dir, [record({ status: 'denied' })]);

    expect((await readStore()).records).toEqual([]);
  });

  it('caps storage at 200 pending records and evicts the oldest', async () => {
    const records: ApprovalRecord[] = [];
    for (let index = 0; index < 201; index += 1) {
      records.push(
        record({
          createdAt: new Date(Date.UTC(2026, 9, 30, 0, 0, index)).toISOString(),
        }),
      );
    }
    const logs: string[] = [];

    await saveApprovals(dir, records, { log: (line) => logs.push(line) });

    const stored = await readStore();
    expect(stored.records).toHaveLength(200);
    expect(stored.records.some((entry) => entry.id === records[0]?.id)).toBe(false);
    expect(logs.some((line) => line.includes('200'))).toBe(true);
  });

  it('writes atomically: no temp files are left behind', async () => {
    await saveApprovals(dir, [record()]);

    const { readdir } = await import('node:fs/promises');
    expect(await readdir(dir)).toEqual([APPROVALS_FILE]);
  });

  it('uses the provided bootId', async () => {
    await saveApprovals(dir, [record()], { bootId: 'boot-abc' });

    expect((await readStore()).bootId).toBe('boot-abc');
  });
});

describe('loadApprovals', () => {
  it('returns an empty list when the file is absent', async () => {
    await expect(loadApprovals(dir)).resolves.toEqual([]);
  });

  it('round-trips pending records', async () => {
    const pending = record();
    await saveApprovals(dir, [pending]);

    const loaded = await loadApprovals(dir);

    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe(pending.id);
    expect(loaded[0]?.payload).toEqual(pending.payload);
  });

  it('drops records whose fingerprint does not match the payload', async () => {
    const tampered = record({ fingerprint: 'f'.repeat(64) });
    await saveApprovals(dir, [tampered]);
    const logs: string[] = [];

    const loaded = await loadApprovals(dir, { log: (line) => logs.push(line) });

    expect(loaded).toEqual([]);
    expect(logs.some((line) => line.includes(tampered.id))).toBe(true);
  });

  it('drops records whose stored kind disagrees with the payload kind', async () => {
    const mismatched = record({ kind: 'capability.activate' });
    await saveApprovals(dir, [mismatched]);

    await expect(loadApprovals(dir)).resolves.toEqual([]);
  });

  it('fails closed on corrupt JSON and logs loudly', async () => {
    await writeFile(path.join(dir, APPROVALS_FILE), '{ not json', 'utf8');
    const logs: string[] = [];

    const loaded = await loadApprovals(dir, { log: (line) => logs.push(line) });

    expect(loaded).toEqual([]);
    expect(logs.length).toBeGreaterThan(0);
  });

  it('quarantines a corrupt file instead of destroying the evidence', async () => {
    const file = path.join(dir, APPROVALS_FILE);
    await writeFile(file, '{ not json', 'utf8');

    await loadApprovals(dir);

    expect(await readFile(`${file}.corrupt`, 'utf8')).toBe('{ not json');
  });

  it('reports when a corrupt file cannot be quarantined', async () => {
    const file = path.join(dir, APPROVALS_FILE);
    await writeFile(file, '{ not json', 'utf8');
    // 目标位置是目录时 rename 必然失败。
    await mkdir(`${file}.corrupt`);
    const logs: string[] = [];

    await loadApprovals(dir, { log: (line) => logs.push(line) });

    expect(logs.some((line) => line.includes('留在原处'))).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('{ not json');
  });

  it('drops records with an off-enum control intent', async () => {
    const base = record();
    const payload = { kind: 'control.command', intent: 'capability.selfdestruct', args: {} };
    const forged = {
      ...base,
      payload,
      fingerprint: fingerprintPayload(payload as unknown as ApprovalPayload),
    };
    await writeFile(
      path.join(dir, APPROVALS_FILE),
      JSON.stringify({
        version: 1,
        bootId: 'b',
        updatedAt: new Date().toISOString(),
        records: [forged],
      }),
      'utf8',
    );

    await expect(loadApprovals(dir)).resolves.toEqual([]);
  });

  it('drops records with a malformed payload', async () => {
    const base = record();
    const payload = { kind: 'control.command', intent: 'help.read', args: { minutes: true } };
    const malformed = {
      ...base,
      payload,
      fingerprint: fingerprintPayload(payload as unknown as ApprovalPayload),
    };
    await writeFile(
      path.join(dir, APPROVALS_FILE),
      JSON.stringify({
        version: 1,
        bootId: 'b',
        updatedAt: new Date().toISOString(),
        records: [malformed],
      }),
      'utf8',
    );

    await expect(loadApprovals(dir)).resolves.toEqual([]);
  });

  it('fails closed on an unexpected envelope', async () => {
    await writeFile(path.join(dir, APPROVALS_FILE), JSON.stringify({ version: 2, records: [] }), 'utf8');

    await expect(loadApprovals(dir)).resolves.toEqual([]);
  });

  it('ignores non-pending records even if they reach disk', async () => {
    const approved = record({ status: 'approved' });
    await writeFile(
      path.join(dir, APPROVALS_FILE),
      JSON.stringify({ version: 1, bootId: 'b', updatedAt: new Date().toISOString(), records: [approved] }),
      'utf8',
    );

    await expect(loadApprovals(dir)).resolves.toEqual([]);
  });
});
