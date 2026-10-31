/**
 * 审批执行器。T1 只注册 `capability.activate` 与 `control.command`；
 * 真正的执行依赖（能力注册表 / 控制 router）由 T2/T5 通过 `ApplierHooks`
 * 注入，T1 自身不 import 控制面、QQ 通道或网页层。
 */
import type { ApprovalErrorCode, ApprovalKind, ApprovalRecord } from './types.js';

export type ApplierOutcome =
  | { ok: true }
  | { ok: false; code: ApprovalErrorCode; error?: string };

/** 宿主接线点。未注入的钩子让对应 kind 在执行期返回 `not_implemented`。 */
export interface ApplierHooks {
  executeControlCommand?: (record: ApprovalRecord) => Promise<ApplierOutcome>;
  activateCapability?: (record: ApprovalRecord) => Promise<ApplierOutcome>;
}

export interface ApplierContext {
  /** 可信日志出口；调用方负责净化不可信字段并限长。 */
  log: (line: string) => void;
  now: () => number;
  hooks: ApplierHooks;
}

/** Applier 必须幂等：服务端的状态机保证「恰好一次」，执行器是第二道防线。 */
export type Applier = (record: ApprovalRecord, ctx: ApplierContext) => Promise<ApplierOutcome>;

const NOT_IMPLEMENTED: ApplierOutcome = { ok: false, code: 'not_implemented' };

async function runControlCommand(
  record: ApprovalRecord,
  ctx: ApplierContext,
): Promise<ApplierOutcome> {
  const hook = ctx.hooks.executeControlCommand;
  if (hook === undefined) return NOT_IMPLEMENTED;
  return hook(record);
}

async function activateCapability(
  record: ApprovalRecord,
  ctx: ApplierContext,
): Promise<ApplierOutcome> {
  const hook = ctx.hooks.activateCapability;
  if (hook === undefined) return NOT_IMPLEMENTED;
  return hook(record);
}

/** 只注册 M2b 的两个生产者；其余 kind 没有条目，`propose` 据此返回 `not_implemented`。 */
export const APPLIERS: Readonly<Partial<Record<ApprovalKind, Applier>>> = {
  'capability.activate': activateCapability,
  'control.command': runControlCommand,
};
