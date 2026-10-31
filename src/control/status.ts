/**
 * `#状态` 与 `GET /api/control` 共用的只读快照。
 *
 * 这里只做投影：不读模型、不写文件、不改变任何运行状态。所有字符串字段
 * 都是代码构造的结构化值；渲染模板在 router 里，渲染前仍会逐项净化
 * （不变量 16）。
 */
import type { ApprovalRecord } from '../approvals/types.js';
import type { ControlState } from './state-store.js';

/** 护栏快照里与控制面相关的最小字段；T3 的 `GroupGuardSnapshot` 结构兼容。 */
export interface GuardStatusEntry {
  groupId: string;
  silencedUntil: number | null;
  /** 平台派生的观察期（禁言/踢出后 24h）；与 operator 静默分开显示。 */
  observingUntil?: number | null;
}

export interface ControlStatusSnapshot {
  /** 全局出站闸（保留群键 `'*'`）。 */
  quiet: { until: string | null; active: boolean };
  /** 仍在静默期的群（不含 `'*'`）。 */
  groups: Array<{ groupId: string; silencedUntil: string; active: boolean }>;
  /** 平台派生的观察期（不含 `'*'`），与 operator 静默分开列出。 */
  observing: Array<{ groupId: string; observingUntil: string; active: boolean }>;
  approvals: { pending: number; oldestPendingAt: string | null };
  channels: Array<{ name: string; state: string; connected?: boolean }>;
  plugins: Array<{ name: string; state: string }>;
  capabilities: Array<{ name: string; state: string }>;
  heartbeat: { silentRounds: number; inFlight: boolean; nextFastMs: number };
  queueSize: number;
  endpoints: Array<{ name: string; degraded: boolean; remainingBackoffMs: number }>;
}

export interface StatusDeps {
  state: { snapshot(): ControlState };
  /** 默认只取 pending，且 `control.command` 不在其中（不变量 21）。 */
  approvals: { list(filter?: { status?: 'pending' | 'all'; includeControl?: boolean }): ApprovalRecord[] };
  plugins: () => ReadonlyArray<{ name: string; state: string }>;
  capabilities: () => ReadonlyArray<{ name: string; state: string }>;
  channels?: () => ReadonlyArray<{ name: string; state: string; connected?: boolean }>;
  heartbeat: () => { silentRounds: number; inFlight: boolean; nextFastMs: number };
  queueSize: () => number;
  endpoints: () => ReadonlyArray<{ name: string; degraded: boolean; remainingBackoffMs: number }>;
  /** T3 的 `GroupGuard.snapshot()`；缺省时只按持久化状态推导静默群。 */
  guard?: () => ReadonlyArray<GuardStatusEntry>;
  now?: () => number;
}

function oldestCreatedAt(records: readonly ApprovalRecord[]): string | null {
  let oldest: number | null = null;
  for (const record of records) {
    const at = Date.parse(record.createdAt);
    if (!Number.isFinite(at)) continue;
    if (oldest === null || at < oldest) oldest = at;
  }
  return oldest === null ? null : new Date(oldest).toISOString();
}

/**
 * 静默群 = 持久化状态 ∪ 护栏快照，按群号排序，只保留未到期的条目。
 * 全局键 `'*'` 单独放进 `quiet`，不混进群列表。
 */
function silencedGroups(
  state: ControlState,
  guard: ReadonlyArray<GuardStatusEntry> | undefined,
  now: number,
): Array<{ groupId: string; silencedUntil: string; active: boolean }> {
  const silenced = new Map<string, number>();
  for (const [groupId, group] of Object.entries(state.groups)) {
    if (groupId === '*') continue;
    if (group.silencedUntil !== undefined) silenced.set(groupId, group.silencedUntil);
  }
  if (guard !== undefined) {
    for (const entry of guard) {
      // 全局键 `'*'` 只属于 quiet 字段，绝不能混进群列表。
      if (entry.groupId === '*') continue;
      if (entry.silencedUntil === null) silenced.delete(entry.groupId);
      else silenced.set(entry.groupId, entry.silencedUntil);
    }
  }

  return [...silenced.entries()]
    .filter(([, until]) => until > now)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([groupId, until]) => ({
      groupId,
      silencedUntil: new Date(until).toISOString(),
      active: true,
    }));
}

/**
 * 观察期群 = 持久化状态 ∪ 护栏快照，按群号排序，只保留未到期的条目。
 * 这是平台派生的状态（禁言/踢出），与 operator 的 `#安静` 分开呈现。
 */
function observingGroups(
  state: ControlState,
  guard: ReadonlyArray<GuardStatusEntry> | undefined,
  now: number,
): Array<{ groupId: string; observingUntil: string; active: boolean }> {
  const observing = new Map<string, number>();
  for (const [groupId, group] of Object.entries(state.groups)) {
    if (groupId === '*') continue;
    if (group.observingUntil !== undefined) observing.set(groupId, group.observingUntil);
  }
  if (guard !== undefined) {
    for (const entry of guard) {
      if (entry.groupId === '*') continue;
      const until = entry.observingUntil ?? null;
      if (until === null) observing.delete(entry.groupId);
      else observing.set(entry.groupId, until);
    }
  }

  return [...observing.entries()]
    .filter(([, until]) => until > now)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([groupId, until]) => ({
      groupId,
      observingUntil: new Date(until).toISOString(),
      active: true,
    }));
}

export function buildStatusSnapshot(deps: StatusDeps): ControlStatusSnapshot {
  const now = deps.now?.() ?? Date.now();
  const state = deps.state.snapshot();
  const guard = deps.guard?.();

  // 全局出站闸：持久化状态优先，护栏快照里的 `'*'` 覆盖它（T3 接线后
  // 两者应当一致；护栏是运行时权威）。
  let globalUntil = state.groups['*']?.silencedUntil;
  const guardGlobal = guard?.find((entry) => entry.groupId === '*');
  if (guardGlobal !== undefined) {
    globalUntil = guardGlobal.silencedUntil ?? undefined;
  }
  const quietActive = globalUntil !== undefined && globalUntil > now;
  const quietUntil = quietActive ? globalUntil : undefined;

  // 服务层默认已排除 control.command；这里再过滤一次，避免依赖调用方口径。
  const pending = deps
    .approvals
    .list({ status: 'pending' })
    .filter((record) => record.kind !== 'control.command');

  return {
    quiet: {
      until: quietUntil === undefined ? null : new Date(quietUntil).toISOString(),
      active: quietActive,
    },
    groups: silencedGroups(state, guard, now),
    observing: observingGroups(state, guard, now),
    approvals: { pending: pending.length, oldestPendingAt: oldestCreatedAt(pending) },
    channels: (deps.channels?.() ?? []).map((channel) => ({ ...channel })),
    plugins: deps.plugins().map((plugin) => ({ ...plugin })),
    capabilities: deps.capabilities().map((capability) => ({ ...capability })),
    heartbeat: { ...deps.heartbeat() },
    queueSize: deps.queueSize(),
    endpoints: deps.endpoints().map((endpoint) => ({ ...endpoint })),
  };
}
