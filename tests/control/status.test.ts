import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApprovalRecord } from '../../src/approvals/types.js';
import {
  buildStatusSnapshot,
  type StatusDeps,
} from '../../src/control/status.js';
import {
  CONTROL_STATE_FILE,
  ControlStateStore,
} from '../../src/control/state-store.js';

const NOW = 1_700_000_000_000;
const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'uuharness-control-state-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function approvalRecord(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: 'ap_0123456789abcdef0123456789abcdef',
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
    createdAt: new Date(NOW - 60_000).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
    createdVia: 'qq',
    createdBy: 'private:1',
    ...overrides,
  };
}

function statusDeps(overrides: Partial<StatusDeps> = {}): StatusDeps & {
  list: ReturnType<typeof vi.fn>;
} {
  const list = vi.fn(() => [approvalRecord()]);
  return {
    list,
    now: () => NOW,
    state: { snapshot: () => ({ version: 1 as const, bootId: 'b', groups: {}, proactive: {} }) },
    approvals: { list },
    plugins: () => [{ name: 'qq', state: 'active' }],
    capabilities: () => [{ name: 'demo', state: 'pending' }],
    channels: () => [{ name: 'qq', state: 'active', connected: true }],
    heartbeat: () => ({ silentRounds: 2, inFlight: false, nextFastMs: 500 }),
    queueSize: () => 7,
    endpoints: () => [{ name: 'nim', degraded: false, remainingBackoffMs: 0 }],
    ...overrides,
  };
}

describe('buildStatusSnapshot', () => {
  it('reports pending approvals without control.command by default', () => {
    const deps = statusDeps();

    const snapshot = buildStatusSnapshot(deps);

    expect(deps.list).toHaveBeenCalledWith({ status: 'pending' });
    expect(snapshot.approvals).toEqual({
      pending: 1,
      oldestPendingAt: new Date(NOW - 60_000).toISOString(),
    });
  });

  it('reports zero pending with no oldest timestamp', () => {
    const snapshot = buildStatusSnapshot(statusDeps({ approvals: { list: () => [] } }));
    expect(snapshot.approvals).toEqual({ pending: 0, oldestPendingAt: null });
  });

  it('excludes control.command records even if the service returns them', () => {
    const controlRecord = approvalRecord({
      id: 'ap_fedcba9876543210fedcba9876543210',
      kind: 'control.command',
      payload: { kind: 'control.command', intent: 'capability.ban', args: { plugin: 'demo' } },
    });
    const snapshot = buildStatusSnapshot(
      statusDeps({ approvals: { list: () => [approvalRecord(), controlRecord] } }),
    );

    expect(snapshot.approvals.pending).toBe(1);
  });

  it('surfaces the global quiet gate from the reserved * key', () => {
    const until = NOW + 30 * 60_000;
    const snapshot = buildStatusSnapshot(
      statusDeps({
        state: {
          snapshot: () => ({
            version: 1 as const,
            bootId: 'b',
            groups: { '*': { silencedUntil: until } },
            proactive: {},
          }),
        },
      }),
    );

    expect(snapshot.quiet).toEqual({
      until: new Date(until).toISOString(),
      active: true,
    });
  });

  it('does not report an expired quiet gate as active', () => {
    const snapshot = buildStatusSnapshot(
      statusDeps({
        state: {
          snapshot: () => ({
            version: 1 as const,
            bootId: 'b',
            groups: { '*': { silencedUntil: NOW - 1 } },
            proactive: {},
          }),
        },
      }),
    );

    expect(snapshot.quiet.active).toBe(false);
    expect(snapshot.quiet.until).toBeNull();
  });

  it('lists silenced groups from the guard snapshot and the persisted state', () => {
    const snapshot = buildStatusSnapshot(
      statusDeps({
        state: {
          snapshot: () => ({
            version: 1 as const,
            bootId: 'b',
            groups: { '111': { silencedUntil: NOW + 1000 } },
            proactive: {},
          }),
        },
        guard: () => [
          { groupId: '111', silencedUntil: NOW + 1000 },
          { groupId: '222', silencedUntil: null },
          { groupId: '333', silencedUntil: NOW - 1 },
        ],
      }),
    );

    expect(snapshot.groups).toEqual([
      { groupId: '111', silencedUntil: new Date(NOW + 1000).toISOString(), active: true },
    ]);
  });

  it('separates platform-derived observation from operator silence', () => {
    const snapshot = buildStatusSnapshot(
      statusDeps({
        state: {
          snapshot: () => ({
            version: 1 as const,
            bootId: 'b',
            groups: {
              '111': { silencedUntil: NOW + 1000 },
              '222': { observingUntil: NOW + 2000 },
            },
            proactive: {},
          }),
        },
        guard: () => [
          { groupId: '111', silencedUntil: NOW + 1000, observingUntil: null },
          { groupId: '222', silencedUntil: null, observingUntil: NOW + 2000 },
          { groupId: '333', silencedUntil: null, observingUntil: NOW - 1 },
        ],
      }),
    );

    expect(snapshot.groups).toEqual([
      { groupId: '111', silencedUntil: new Date(NOW + 1000).toISOString(), active: true },
    ]);
    expect(snapshot.observing).toEqual([
      { groupId: '222', observingUntil: new Date(NOW + 2000).toISOString(), active: true },
    ]);
  });

  it('reports a global gate from the guard as quiet, never as a group', () => {
    const snapshot = buildStatusSnapshot(
      statusDeps({
        guard: () => [
          { groupId: '*', silencedUntil: NOW + 1000 },
          { groupId: '111', silencedUntil: NOW + 2000 },
        ],
      }),
    );

    expect(snapshot.quiet).toEqual({
      until: new Date(NOW + 1000).toISOString(),
      active: true,
    });
    expect(snapshot.groups.map((group) => group.groupId)).toEqual(['111']);
  });

  it('copies the structural runtime facts', () => {
    const snapshot = buildStatusSnapshot(statusDeps());

    expect(snapshot.queueSize).toBe(7);
    expect(snapshot.heartbeat).toEqual({ silentRounds: 2, inFlight: false, nextFastMs: 500 });
    expect(snapshot.plugins).toEqual([{ name: 'qq', state: 'active' }]);
    expect(snapshot.capabilities).toEqual([{ name: 'demo', state: 'pending' }]);
    expect(snapshot.channels).toEqual([{ name: 'qq', state: 'active', connected: true }]);
    expect(snapshot.endpoints).toEqual([{ name: 'nim', degraded: false, remainingBackoffMs: 0 }]);
  });

  it('returns fresh arrays rather than aliasing the dependency state', () => {
    const plugins = [{ name: 'qq', state: 'active' }];
    const snapshot = buildStatusSnapshot(statusDeps({ plugins: () => plugins }));

    plugins.push({ name: 'other', state: 'failed' });

    expect(snapshot.plugins).toHaveLength(1);
  });
});

describe('ControlStateStore', () => {
  it('starts empty when the file is missing', async () => {
    const dir = await tempDir();
    const store = new ControlStateStore({ dataDir: dir, now: () => NOW });
    await store.load();

    expect(store.snapshot()).toMatchObject({ version: 1, groups: {}, proactive: {} });
    expect(store.isSilenced('*')).toBe(false);
  });

  it('persists and reloads per-group silence', async () => {
    const dir = await tempDir();
    const until = NOW + 60_000;
    const store = new ControlStateStore({ dataDir: dir, now: () => NOW });
    await store.load();
    await store.setGroupSilencedUntil('123', until);

    const raw = JSON.parse(await readFile(join(dir, CONTROL_STATE_FILE), 'utf8')) as {
      version: number;
      groups: Record<string, { silencedUntil?: number }>;
    };
    expect(raw.version).toBe(1);
    expect(raw.groups['123']).toEqual({ silencedUntil: until });

    const reloaded = new ControlStateStore({ dataDir: dir, now: () => NOW });
    await reloaded.load();
    expect(reloaded.getGroupSilencedUntil('123')).toBe(until);
    expect(reloaded.isSilenced('123')).toBe(true);
    expect(reloaded.isSilenced('123', until)).toBe(false);
  });

  it('clears a group entry when the deadline is removed', async () => {
    const dir = await tempDir();
    const store = new ControlStateStore({ dataDir: dir, now: () => NOW });
    await store.load();
    await store.setGroupSilencedUntil('123', NOW + 1000);
    await store.clearGroup('123');

    expect(store.getGroupSilencedUntil('123')).toBeUndefined();
    expect(store.snapshot().groups).toEqual({});
  });

  it('persists proactive counters', async () => {
    const dir = await tempDir();
    const store = new ControlStateStore({ dataDir: dir, now: () => NOW });
    await store.load();
    await store.setProactive({ lastSentAt: NOW, dayKey: '2026-10-30', sentToday: 2 });

    expect(store.proactive()).toEqual({ lastSentAt: NOW, dayKey: '2026-10-30', sentToday: 2 });

    const reloaded = new ControlStateStore({ dataDir: dir, now: () => NOW });
    await reloaded.load();
    expect(reloaded.proactive()).toEqual({
      lastSentAt: NOW,
      dayKey: '2026-10-30',
      sentToday: 2,
    });
  });

  it('fails closed to an empty state on a corrupt file', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, CONTROL_STATE_FILE), '{not json');
    const log = vi.fn<(line: string) => void>();
    const store = new ControlStateStore({ dataDir: dir, now: () => NOW, log });
    await store.load();

    expect(store.snapshot().groups).toEqual({});
    expect(log).toHaveBeenCalled();
  });

  it('drops invalid groups instead of trusting them', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, CONTROL_STATE_FILE),
      JSON.stringify({
        version: 1,
        groups: {
          good: { silencedUntil: NOW + 1000 },
          bad: { silencedUntil: 'later' },
          negative: { silencedUntil: -5 },
        },
        proactive: {},
      }),
    );
    const store = new ControlStateStore({ dataDir: dir, now: () => NOW });
    await store.load();

    expect(store.getGroupSilencedUntil('good')).toBe(NOW + 1000);
    expect(store.getGroupSilencedUntil('bad')).toBeUndefined();
    expect(store.getGroupSilencedUntil('negative')).toBeUndefined();
  });

  it('rejects an unknown envelope version and starts empty', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, CONTROL_STATE_FILE),
      JSON.stringify({ version: 2, groups: { x: { silencedUntil: 1 } } }),
    );
    const store = new ControlStateStore({ dataDir: dir, now: () => NOW });
    await store.load();

    expect(store.snapshot().groups).toEqual({});
  });

  it('round-trips guard operator state through control-state.json', async () => {
    const dir = await tempDir();
    const store = new ControlStateStore({ dataDir: dir, now: () => NOW });
    await store.load();
    await store.setGroupSilencedUntil('111', NOW + 1000);
    await store.setGroupObservingUntil('222', NOW + 2000);

    const exported = store.operatorState();
    expect(exported).toEqual([
      { groupId: '111', silencedUntil: NOW + 1000 },
      { groupId: '222', observingUntil: NOW + 2000 },
    ]);

    const reloaded = new ControlStateStore({ dataDir: dir, now: () => NOW });
    await reloaded.load();
    expect(reloaded.operatorState()).toEqual(exported);
    expect(reloaded.getGroupObservingUntil('222')).toBe(NOW + 2000);

    const target = new ControlStateStore({ dataDir: await tempDir(), now: () => NOW });
    await target.load();
    await target.replaceOperatorState(exported);
    expect(target.operatorState()).toEqual(exported);
  });

  it('leaves no temporary files behind', async () => {
    const dir = await tempDir();
    const store = new ControlStateStore({ dataDir: dir, now: () => NOW });
    await store.load();
    await store.setGroupSilencedUntil('*', NOW + 1000);

    const entries = await readdir(dir);
    expect(entries).toEqual([CONTROL_STATE_FILE]);
  });

  it('serializes concurrent writes without losing entries', async () => {
    const dir = await tempDir();
    const store = new ControlStateStore({ dataDir: dir, now: () => NOW });
    await store.load();
    await Promise.all([
      store.setGroupSilencedUntil('a', NOW + 1000),
      store.setGroupSilencedUntil('b', NOW + 2000),
      store.setGroupSilencedUntil('c', NOW + 3000),
    ]);

    const reloaded = new ControlStateStore({ dataDir: dir, now: () => NOW });
    await reloaded.load();
    expect(reloaded.getGroupSilencedUntil('a')).toBe(NOW + 1000);
    expect(reloaded.getGroupSilencedUntil('b')).toBe(NOW + 2000);
    expect(reloaded.getGroupSilencedUntil('c')).toBe(NOW + 3000);
  });
});
