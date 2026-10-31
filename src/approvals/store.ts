/**
 * `DATA_DIR/approvals.json`：只序列化 pending 记录，≤200 条，损坏整体作废。
 *
 * 存储不是授权：加载时逐条重算指纹，不符即丢；非 pending 记录永不回放。
 */
import { randomBytes } from 'node:crypto';
import { rename } from 'node:fs/promises';
import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from '../util/atomic-json.js';
import { fingerprintPayload } from './policy.js';
import type { ApprovalPayload, ApprovalRecord } from './types.js';

export const APPROVALS_FILE = 'approvals.json';
export const MAX_APPROVAL_RECORDS = 200;

const STORE_VERSION = 1;

/** §4 的 8 个控制意图；载荷形状校验必须与 `ControlIntentName` 保持同步。 */
const CONTROL_INTENTS: ReadonlySet<string> = new Set([
  'help.read',
  'status.read',
  'approval.list',
  'approval.decide',
  'capability.ban',
  'capability.unban',
  'group.silence',
  'group.resume',
]);

export interface ApprovalStoreOptions {
  log?: (line: string) => void;
  now?: () => number;
  /** 每个 `ApprovalService` 实例一个；缺省时每次写入生成一个。 */
  bootId?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isArgs(value: unknown): value is Record<string, string | number> {
  if (!isPlainObject(value)) return false;
  return Object.values(value).every(
    (entry) => typeof entry === 'string' || (typeof entry === 'number' && Number.isFinite(entry)),
  );
}

/** 载荷形状校验；propose 与 load 共用，避免畸形载荷进内存或在重载时被静默丢弃。 */
export function isApprovalPayload(value: unknown): value is ApprovalPayload {
  if (!isPlainObject(value)) return false;
  if (value.kind === 'capability.activate') {
    return (
      isString(value.plugin) &&
      isString(value.version) &&
      isString(value.fingerprint) &&
      Array.isArray(value.declaredPermissions) &&
      value.declaredPermissions.every(isString) &&
      Array.isArray(value.toolNames) &&
      value.toolNames.every(isString)
    );
  }
  if (value.kind === 'control.command') {
    return isString(value.intent) && CONTROL_INTENTS.has(value.intent) && isArgs(value.args);
  }
  return false;
}

/** 结构校验；任何缺字段或类型不符的记录都不进内存。 */
function normalizeRecord(raw: unknown): ApprovalRecord | undefined {
  if (!isPlainObject(raw)) return undefined;
  if (!isString(raw.id) || !/^ap_[0-9a-f]{32}$/.test(raw.id)) return undefined;
  if (!isApprovalPayload(raw.payload)) return undefined;
  if (raw.kind !== raw.payload.kind) return undefined;
  if (!isString(raw.fingerprint) || !isString(raw.createdAt) || !isString(raw.expiresAt)) {
    return undefined;
  }
  if (!isString(raw.createdBy)) return undefined;
  if (raw.status !== 'pending') return undefined;
  if (!Number.isFinite(Date.parse(raw.createdAt)) || !Number.isFinite(Date.parse(raw.expiresAt))) {
    return undefined;
  }
  return raw as unknown as ApprovalRecord;
}

/**
 * 读取 pending 记录。文件缺失 → 空；损坏或信封不符 → 空并记日志（fail closed）；
 * 单条记录非法或指纹不符 → 只丢该条。
 */
export async function loadApprovals(
  dir: string,
  opts: ApprovalStoreOptions = {},
): Promise<ApprovalRecord[]> {
  const log = opts.log ?? (() => undefined);
  const file = path.join(dir, APPROVALS_FILE);
  const read = await readJsonFile(file);
  if (!read.ok) {
    if (read.code === 'corrupt') {
      // 保留证据：损坏文件先改名，随后 service 写入的空状态不会把它覆盖掉。
      // 只有改名真的成功才宣称「已隔离」，否则明确说文件仍在原处。
      try {
        await rename(file, `${file}.corrupt`);
        log('approvals.json 损坏，已隔离为 approvals.json.corrupt 并丢弃全部 pending 审批');
      } catch {
        log('approvals.json 损坏，且无法隔离（文件留在原处），丢弃全部 pending 审批');
      }
    }
    return [];
  }

  const envelope = read.value;
  if (
    !isPlainObject(envelope) ||
    envelope.version !== STORE_VERSION ||
    !Array.isArray(envelope.records)
  ) {
    log('approvals.json 信封无效，丢弃全部 pending 审批');
    return [];
  }

  const records: ApprovalRecord[] = [];
  for (const raw of envelope.records) {
    const record = normalizeRecord(raw);
    if (record === undefined) {
      log('approvals.json 含无效记录，已丢弃');
      continue;
    }
    if (record.fingerprint !== fingerprintPayload(record.payload)) {
      log(`approval ${record.id} 指纹不符，已丢弃`);
      continue;
    }
    records.push(record);
  }

  // 防御性上限：即使磁盘被塞进更多记录，内存也只保留最新的 200 条。
  if (records.length > MAX_APPROVAL_RECORDS) {
    log(`approvals.json 超过 ${MAX_APPROVAL_RECORDS} 条，只保留最新部分`);
    return records.slice(records.length - MAX_APPROVAL_RECORDS);
  }
  return records;
}

/**
 * 整写 pending 记录。超过上限时淘汰最旧的 pending 并记日志；
 * 终态记录从不落盘（它们只作内存审计，重启后不存在）。
 */
export async function saveApprovals(
  dir: string,
  records: readonly ApprovalRecord[],
  opts: ApprovalStoreOptions = {},
): Promise<void> {
  const log = opts.log ?? (() => undefined);
  const now = opts.now ?? Date.now;

  const pending = records.filter((record) => record.status === 'pending');
  let kept = pending;
  if (pending.length > MAX_APPROVAL_RECORDS) {
    const oldest = [...pending]
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
      .slice(0, pending.length - MAX_APPROVAL_RECORDS);
    const dropped = new Set(oldest.map((record) => record.id));
    kept = pending.filter((record) => !dropped.has(record.id));
    log(
      `approvals.json 超过 ${MAX_APPROVAL_RECORDS} 条，淘汰最旧 pending ${oldest.length} 条`,
    );
  }

  await writeJsonAtomic(path.join(dir, APPROVALS_FILE), {
    version: STORE_VERSION,
    bootId: opts.bootId ?? randomBytes(8).toString('hex'),
    updatedAt: new Date(now()).toISOString(),
    records: kept,
  });
}
