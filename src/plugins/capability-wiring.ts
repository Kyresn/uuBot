/**
 * 入口装配辅助：构造能力注册表、加载目录、为每个 pending 插件**生成激活
 * 审批**（绝不自动 spawn），并输出一行汇总。
 *
 * 启动不再自动激活：审批是唯一的激活路径（不变量 17）。重启时同一插件 +
 * 同一指纹已有 pending 审批的，不再重复提案——否则每次重启都会多一条。
 * 单个插件提案失败只记日志，绝不让它阻止启动。
 */

import { join } from 'node:path';
import type { ApplierOutcome } from '../approvals/appliers.js';
import type { DecideResult, ProposeResult } from '../approvals/service.js';
import type { ApprovalPayload, ApprovalRecord, DecisionChannel } from '../approvals/types.js';
import { CapabilityRegistry, type CapabilityDescriptor } from './capability-registry.js';
import type { PluginManifest } from './manifest.js';
import type { CapabilityWorker, WorkerHostDeps } from './worker-host.js';

/** 审批服务的结构子集；装配只消费 list/propose/decide。 */
export interface CapabilityApprovals {
  list(filter?: {
    status?: 'pending' | 'all';
    kind?: 'capability.activate' | 'control.command';
    includeControl?: boolean;
  }): ApprovalRecord[];
  propose(
    payload: ApprovalPayload,
    meta: { createdVia: DecisionChannel; createdBy: string },
  ): Promise<ProposeResult>;
  /** `capability.autoActivate` 用：与人工批准同一条路径（审计照常记录）。 */
  decide?(
    id: string,
    decision: { decision: 'approve' | 'deny'; via: DecisionChannel; by: string },
  ): Promise<DecideResult>;
}

export interface CapabilityWiringDeps {
  brain: WorkerHostDeps['brain'];
  log: WorkerHostDeps['log'];
  /** 能力插件目录。 */
  dir: string;
  /** 运行期状态目录；`bans.json` 的新家（spec R7）。 */
  dataDir: string;
  /** 缺省时只加载、不提案（测试与无控制面的旧装配）。 */
  approvals?: CapabilityApprovals;
  /** 测试注入假 worker。 */
  workerFactory?: (manifest: PluginManifest, dir: string) => CapabilityWorker;
  /** 显式覆盖封禁文件路径；缺省 `DATA_DIR/bans.json`。 */
  banFile?: string;
  /** 旧版封禁文件；缺省 `<dir>/bans.json`。 */
  legacyBanFile?: string;
}

function describeError(error: unknown): string {  return error instanceof Error ? error.message : String(error);
}

export async function startCapabilities(deps: CapabilityWiringDeps): Promise<CapabilityRegistry> {
  const { brain, log, dir } = deps;

  // M3 之前没有真实 memory：与插件宿主同样兜底（空结果 + 日志）。
  const memory = {
    search: async (): Promise<unknown[]> => {
      log('capability registry: memory is not configured');
      return [];
    },
    write: async (): Promise<void> => {
      log('capability registry: memory is not configured');
    },
  };

  const registry = new CapabilityRegistry({ brain, memory, log }, {
    banFile: deps.banFile ?? join(deps.dataDir, 'bans.json'),
    legacyBanFile: deps.legacyBanFile ?? join(dir, 'bans.json'),
    ...(deps.workerFactory === undefined ? {} : { workerFactory: deps.workerFactory }),
  });
  await registry.loadFrom(dir);

  let proposed = 0;
  const approvals = deps.approvals;
  if (approvals !== undefined) {
    for (const { name, state } of registry.status()) {
      if (state !== 'pending') continue;
      try {
        const result = await proposeCapabilityActivation(registry, approvals, name, {
          createdVia: 'system',
          createdBy: 'startup',
        });
        if (result.ok && result.created) proposed += 1;
        else if (!result.ok) log(`capability ${name}: activation proposal failed: ${result.code}`);
      } catch (error) {
        log(`capability ${name}: activation proposal failed: ${describeError(error)}`);
      }
    }
  }

  const active = registry.status().filter((entry) => entry.state === 'active').length;
  const pending = registry.status().filter((entry) => entry.state === 'pending').length;
  log(
    `${active} capability plugin(s) active, ${pending} pending` +
      `${proposed > 0 ? `, ${proposed} activation approval(s) proposed` : ''}, ` +
      `${registry.getToolDefs().length} tool(s) available`,
  );
  return registry;
}

/** 同一插件 + 同一指纹已有 pending 审批时不再重复提案。 */
function hasPendingActivation(
  approvals: CapabilityApprovals,
  descriptor: CapabilityDescriptor,
): boolean {
  return approvals
    .list({ status: 'pending', kind: 'capability.activate' })
    .some(
      (record) =>
        record.payload.kind === 'capability.activate' &&
        record.payload.plugin === descriptor.name &&
        record.payload.fingerprint === descriptor.fingerprint,
    );
}

/**
 * 生成（或复用）一条 `capability.activate` 审批。启动扫描与 `#解封` 共用：
 * 同一插件 + 同一指纹已有 pending 时返回已有 id，不重复提案。
 */
export async function proposeCapabilityActivation(
  registry: CapabilityRegistry,
  approvals: CapabilityApprovals,
  name: string,
  meta: { createdVia: DecisionChannel; createdBy: string },
): Promise<{ ok: true; id: string; created: boolean } | { ok: false; code: string }> {
  const descriptor = await registry.describe(name);
  if (descriptor === null) return { ok: false, code: 'not_found' };
  if (hasPendingActivation(approvals, descriptor)) {
    const existing = approvals
      .list({ status: 'pending', kind: 'capability.activate' })
      .find(
        (record) =>
          record.payload.kind === 'capability.activate' &&
          record.payload.plugin === descriptor.name &&
          record.payload.fingerprint === descriptor.fingerprint,
      );
    if (existing !== undefined) return { ok: true, id: existing.id, created: false };
  }

  const proposed = await approvals.propose(
    {
      kind: 'capability.activate',
      plugin: descriptor.name,
      version: descriptor.version,
      fingerprint: descriptor.fingerprint,
      declaredPermissions: descriptor.declaredPermissions,
      toolNames: descriptor.toolNames,
    },
    meta,
  );
  return proposed.ok
    ? { ok: true, id: proposed.record.id, created: true }
    : { ok: false, code: proposed.code };
}

/**
 * `capability.autoActivate` 的启动路径：批准当前所有 pending 的能力激活审批。
 *
 * 走同一个 `ApprovalService.decide`（`via:'system'`），因此 `decided` /
 * `executed` 审计与人工批准完全一致；插件仍要过 applier 的指纹复核。
 * 调用点必须在 `registryRef.current` 指向已加载的注册表之后——applier 需要它。
 * 返回成功批准的条数；单条失败只记日志，绝不让启动失败。
 */
export async function autoActivatePendingCapabilities(
  approvals: CapabilityApprovals,
  log: (line: string) => void,
): Promise<number> {
  const decide = approvals.decide;
  if (decide === undefined) return 0;

  let approved = 0;
  for (const record of approvals.list({ status: 'pending', kind: 'capability.activate' })) {
    const label = record.payload.kind === 'capability.activate' ? record.payload.plugin : record.id;
    try {
      const result = await decide.call(approvals, record.id, {
        decision: 'approve',
        via: 'system',
        by: 'startup',
      });
      if (result.ok) approved += 1;
      else log(`capability ${label}: auto-activation failed: ${result.code}`);
    } catch (error) {
      log(`capability ${label}: auto-activation failed: ${describeError(error)}`);
    }
  }
  return approved;
}

/** `capability.activate` 审批的 Applier：先复核指纹，再激活并确认状态。 */
export async function activateCapabilityApproved(
  registry: CapabilityRegistry,
  record: ApprovalRecord,
): Promise<ApplierOutcome> {
  const payload = record.payload;
  if (payload.kind !== 'capability.activate') {
    return { ok: false, code: 'invalid_body', error: 'not a capability activation' };
  }

  const descriptor = await registry.describe(payload.plugin);
  if (descriptor === null) {
    return { ok: false, code: 'not_found', error: 'plugin is not loaded' };
  }
  if (descriptor.fingerprint !== payload.fingerprint) {
    // manifest 或 entry 字节已变：审批失效，绝不激活（不变量 9）。
    return { ok: false, code: 'stale', error: 'fingerprint mismatch' };
  }

  await registry.activate(payload.plugin);
  const status = registry.status().find((entry) => entry.name === payload.plugin);
  if (status?.state !== 'active') {
    return {
      ok: false,
      code: 'conflict',
      error: `activation ended in ${status?.state ?? 'unknown'}`,
    };
  }
  return { ok: true };
}

/** 提案侧读取描述；导出给装配与测试共用，避免两处指纹口径分叉。 */
export async function describeCapability(
  registry: CapabilityRegistry,
  name: string,
): Promise<CapabilityDescriptor | null> {
  return registry.describe(name);
}
