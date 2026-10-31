/**
 * 审批分级与指纹。分级表由代码拥有，manifest 与模型自评不参与。
 *
 * M2b 只有 `capability.activate` 与 `control.command` 两个生产者，二者都有规则。
 * `classify` 对未知 kind 抛错，作为「策略表与载荷校验漂移」的程序员错误哨兵；
 * `propose` 先做载荷形状校验，未知 kind 在到达这里之前就返回 `invalid_body`。
 */
import { createHash } from 'node:crypto';
import type { ApprovalPayload, RiskTier } from './types.js';

export type RefusalCode = 'lethal_trifecta';

export interface ApprovalPolicy {
  tier: RiskTier;
  refuse?: RefusalCode;
}

/** 致命三要素：记忆 + 网络、网络 + 写盘。命中即要求拆分，不允许合并审批。 */
const LETHAL_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['memory', 'net'],
  ['net', 'fs:write'],
];

function hasLethalPair(permissions: readonly string[]): boolean {
  const set = new Set(permissions.map((permission) => permission.trim().toLowerCase()));
  return LETHAL_PAIRS.some(([left, right]) => set.has(left) && set.has(right));
}

type PolicyRule = (payload: ApprovalPayload) => ApprovalPolicy;

const RULES: Readonly<Record<ApprovalPayload['kind'], PolicyRule>> = {
  'capability.activate': (payload) =>
    payload.kind === 'capability.activate' && hasLethalPair(payload.declaredPermissions)
      ? { tier: 'human', refuse: 'lethal_trifecta' }
      : { tier: 'human' },
  'control.command': () => ({ tier: 'human' }),
};

/**
 * 表驱动分级。未知 kind（例如 M6 预留但尚未接入的 `persona.change`）
 * 抛错而不是猜一个宽松级别。
 */
export function classify(payload: ApprovalPayload): ApprovalPolicy {
  const rule = (RULES as Readonly<Record<string, PolicyRule | undefined>>)[payload.kind];
  if (rule === undefined) throw new Error('unknown approval kind');
  return rule(payload);
}

/**
 * 键排序后的规范 JSON。审批指纹必须与键序无关，
 * 否则同一载荷换个写入顺序就会被误判为「被篡改」。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

/** 审批绑定指纹：sha256(canonicalJson(payload))。 */
export function fingerprintPayload(payload: ApprovalPayload): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}
