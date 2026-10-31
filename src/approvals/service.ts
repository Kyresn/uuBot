/**
 * 审批生命周期的一等实现：pending / TTL / 决策 / 执行全部语义都在这里。
 * QQ 私聊与网页只是薄适配器，共用同一个实例与同一份存储。
 *
 * 并发模型照抄 `ConfigStore.enqueue`：一条 promise 链串行化
 * `load` / `propose` / `decide` / `cancel` / `expireDue` / `persist`。
 * `decide` 的临界区完成「读 → 校验 pending → 校验通道绑定 → 校验 TTL →
 * 写终态 → 落盘 → 标记 executing」；Applier 在队列外执行（可能 spawn worker
 * 数秒），完成后再进一次队列写结果。
 */
import { randomBytes } from 'node:crypto';
import { sanitizeForTty, stripUnsafeControls } from '../util/tty.js';
import { APPLIERS, type Applier, type ApplierHooks, type ApplierOutcome } from './appliers.js';
import { newApprovalId } from './ids.js';
import { classify, fingerprintPayload } from './policy.js';
import {
  MAX_APPROVAL_RECORDS,
  isApprovalPayload,
  loadApprovals,
  saveApprovals,
} from './store.js';
import type {
  ApprovalErrorCode,
  ApprovalEvent,
  ApprovalKind,
  ApprovalPayload,
  ApprovalRecord,
  ApprovalStatus,
  DecisionChannel,
} from './types.js';

const CONTROL_COMMAND_TTL_MS = 60_000;
const CAPABILITY_ACTIVATE_TTL_MS = 30 * 60_000;
const DEFAULT_APPROVAL_TTL_MS = 10 * 60_000;
const DEFAULT_RESTORE_GRACE_MS = 10 * 60_000;
const DEFAULT_SCAN_INTERVAL_MS = 15_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 30_000;

const PERSIST_ATTEMPTS = 3;
const PERSIST_BACKOFF_MS = 25;

const MAX_SUMMARY_LENGTH = 200;
const MAX_TITLE_LENGTH = 120;
const MAX_REASON_LENGTH = 500;
const MAX_LOG_DETAIL_LENGTH = 200;

export interface ApprovalTtl {
  controlCommandMs?: number;
  capabilityActivateMs?: number;
  defaultMs?: number;
}

export interface ApprovalServiceOptions {
  dataDir: string;
  log: (line: string) => void;
  now?: () => number;
  monoNow?: () => number;
  restoreGraceMs?: number;
  /** 生产由 `CONTROL_*` env 传入；未提供时使用 spec 默认值。 */
  ttl?: ApprovalTtl;
  /** 测试 / T2 / T5 注入的 Applier 覆盖，默认使用 `APPLIERS`。 */
  appliers?: Partial<Record<ApprovalKind, Applier>>;
  /** 执行器需要的宿主依赖；T1 为空。 */
  hooks?: ApplierHooks;
  /** 过期扫描间隔；0 关闭扫描（测试用）。 */
  scanIntervalMs?: number;
  /** Applier 执行上限；超时记为 failed/timeout，`decide` 照常返回。0 关闭。 */
  executionTimeoutMs?: number;
  /** 测试缝：替换整文件写入；默认走 `saveApprovals`。 */
  writeApprovals?: (dir: string, records: readonly ApprovalRecord[]) => Promise<void>;
}

export type ProposeResult =
  | { ok: true; record: ApprovalRecord }
  | { ok: false; code: ApprovalErrorCode };

export type DecideResult =
  | { ok: true; record: ApprovalRecord }
  | { ok: false; code: ApprovalErrorCode; record?: ApprovalRecord };

export type ListFilter = {
  status?: ApprovalStatus | 'all';
  kind?: ApprovalKind;
  /** 默认排除 `control.command`（不变量 21c）；`#审批 <id>` 与网页显式查询可打开。 */
  includeControl?: boolean;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 单行化 + 净化 + 限长。摘要与错误文本会进入回执/网页，
 * 绝不能带 ANSI 转义或伪造换行。
 */
function safeText(value: string, limit: number): string {
  const cleaned = stripUnsafeControls(value).replace(/[\r\n]+/g, ' ');
  return cleaned.length > limit ? `${cleaned.slice(0, limit)}...` : cleaned;
}

/** 日志细节：净化后压成一行并限长；调用方仍应把它当作不可信内容。 */
function safeLogDetail(value: string): string {
  return sanitizeForTty(value, '').replace(/[\r\n]+/g, ' ').slice(0, MAX_LOG_DETAIL_LENGTH);
}

function renderTitle(payload: ApprovalPayload): string {
  if (payload.kind === 'capability.activate') {
    return safeText(`激活能力插件 ${payload.plugin}`, MAX_TITLE_LENGTH);
  }
  return safeText(`控制指令 ${payload.intent}`, MAX_TITLE_LENGTH);
}

function renderSummary(payload: ApprovalPayload): string {
  if (payload.kind === 'capability.activate') {
    const permissions =
      payload.declaredPermissions.length === 0 ? '无' : payload.declaredPermissions.join('、');
    const tools = payload.toolNames.length === 0 ? '无' : payload.toolNames.join('、');
    return safeText(
      `版本 ${payload.version}；声明权限：${permissions}；工具：${tools}`,
      MAX_SUMMARY_LENGTH,
    );
  }
  return safeText(`意图 ${payload.intent}；参数 ${JSON.stringify(payload.args)}`, MAX_SUMMARY_LENGTH);
}

export class ApprovalService {
  private readonly dataDir: string;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly monoNow: () => number;
  private readonly restoreGraceMs: number;
  private readonly ttl: ApprovalTtl;
  private readonly appliers: Partial<Record<ApprovalKind, Applier>>;
  private readonly hooks: ApplierHooks;
  private readonly scanIntervalMs: number;
  private readonly executionTimeoutMs: number;
  private readonly writeApprovals:
    | ((dir: string, records: readonly ApprovalRecord[]) => Promise<void>)
    | undefined;
  /** 每个实例一个 bootId；写盘时带上，便于区分是哪个实例写的。 */
  private readonly bootId = randomBytes(8).toString('hex');

  private readonly records = new Map<string, ApprovalRecord>();
  private readonly listeners = new Set<(event: ApprovalEvent) => void>();
  private readonly inFlight = new Set<Promise<unknown>>();
  /** 正在执行中的记录 id：即使 decide 被重入，也不会二次执行。 */
  private readonly executing = new Set<string>();

  /** 串行化所有状态变更；失败不会打断链。 */
  private queue: Promise<void> = Promise.resolve();
  private scanTimer: NodeJS.Timeout | null = null;
  private loaded = false;

  constructor(opts: ApprovalServiceOptions) {
    this.dataDir = opts.dataDir;
    this.log = opts.log;
    this.now = opts.now ?? Date.now;
    this.monoNow = opts.monoNow ?? (() => performance.now());
    this.restoreGraceMs = opts.restoreGraceMs ?? DEFAULT_RESTORE_GRACE_MS;
    this.ttl = opts.ttl ?? {};
    this.appliers = { ...APPLIERS, ...opts.appliers };
    this.hooks = opts.hooks ?? {};
    this.scanIntervalMs = opts.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    this.executionTimeoutMs = opts.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
    this.writeApprovals = opts.writeApprovals;
  }

  /**
   * 从磁盘恢复 pending。跨重启保留记录，但生效截止压缩到
   * `min(存储值, now + restoreGraceMs)`；已过期的记录加载即终止。
   * 磁盘上的摘要一律丢弃并按 payload 重渲染。
   *
   * 只允许在首次变更前运行一次：重入是 no-op，且绝不清空内存中的记录
   * （否则在途 `decide` 会丢记录，内存终态也会被抹掉）。
   */
  load(): Promise<void> {
    return this.enqueue(async () => {
      if (this.loaded) return;
      const loaded = await loadApprovals(this.dataDir, { log: this.log });
      const wallNow = this.now();
      const expired: ApprovalRecord[] = [];

      for (const record of loaded) {
        // 分级与致命三要素都由代码拥有：磁盘上的 tier 不可信，命中拒绝条件的记录直接丢弃。
        let policy;
        try {
          policy = classify(record.payload);
        } catch {
          this.log(`approval ${record.id} 无法分级，已丢弃`);
          continue;
        }
        if (policy.refuse !== undefined) {
          this.log(`approval ${record.id} 命中致命三要素，已丢弃`);
          continue;
        }
        record.tier = policy.tier;
        record.title = renderTitle(record.payload);
        record.summary = renderSummary(record.payload);
        const stored = Date.parse(record.expiresAt);
        const remaining = Number.isFinite(stored)
          ? Math.max(0, Math.min(stored - wallNow, this.restoreGraceMs))
          : 0;
        if (remaining <= 0) {
          this.markExpired(record, wallNow);
          expired.push(record);
        } else {
          record.expiresAt = new Date(wallNow + remaining).toISOString();
          record.expiresAtMono = this.monoNow() + remaining;
        }
        this.records.set(record.id, record);
      }

      this.loaded = true;
      await this.persist();
      for (const record of expired) this.emit({ type: 'expired', record: this.clone(record) });
      this.startScanner();
    });
  }

  propose(
    payload: ApprovalPayload,
    meta: { createdVia: DecisionChannel; createdBy: string },
  ): Promise<ProposeResult> {
    return this.enqueue(() => this.proposeLocked(payload, meta));
  }

  private async proposeLocked(
    payload: ApprovalPayload,
    meta: { createdVia: DecisionChannel; createdBy: string },
  ): Promise<ProposeResult> {
    // 形状校验先于一切：畸形载荷既不能进内存，也不能执行后再被加载路径静默丢弃。
    if (!isApprovalPayload(payload)) return { ok: false, code: 'invalid_body' };

    // 深拷贝：调用方在 propose 之后修改原对象不得改变待审批记录（否则指纹会漂移）。
    let stored: ApprovalPayload;
    try {
      stored = structuredClone(payload);
    } catch {
      // 含函数/循环引用等不可克隆值。
      return { ok: false, code: 'invalid_body' };
    }

    // isApprovalPayload 已把 kind 限制在 M2b 的两个生产者上，两者都有分级规则；
    // 未知 kind 在这里不可能出现，因此不做防御性 catch（那会掩盖策略表漂移）。
    const policy = classify(stored);
    if (policy.refuse !== undefined) return { ok: false, code: 'lethal_trifecta' };
    if (this.appliers[stored.kind] === undefined) return { ok: false, code: 'not_implemented' };

    const wallNow = this.now();
    const ttl = this.ttlFor(stored.kind);
    const record: ApprovalRecord = {
      id: newApprovalId(),
      kind: stored.kind,
      status: 'pending',
      tier: policy.tier,
      title: renderTitle(stored),
      summary: renderSummary(stored),
      payload: stored,
      fingerprint: fingerprintPayload(stored),
      createdAt: new Date(wallNow).toISOString(),
      expiresAt: new Date(wallNow + ttl).toISOString(),
      expiresAtMono: this.monoNow() + ttl,
      createdVia: meta.createdVia,
      createdBy: safeText(meta.createdBy, MAX_TITLE_LENGTH),
    };

    this.evictOverflow();
    this.records.set(record.id, record);
    await this.persist();
    this.emit({ type: 'proposed', record: this.clone(record) });
    return { ok: true, record: this.clone(record) };
  }

  /**
   * 唯一决策入口。`via` 只用于审计，但对 `control.command` 是硬绑定：
   * 该 kind 只能由发起它的那条 QQ 私聊决策，网页/系统一律 `wrong_channel`。
   */
  async decide(
    id: string,
    decision: { decision: 'approve' | 'deny'; via: DecisionChannel; by: string; reason?: string },
  ): Promise<DecideResult> {
    const decided = await this.enqueue(() => this.decideLocked(id, decision));
    if (!decided.ok || decided.record.status !== 'approved') return decided;

    // 执行在队列外进行；完成后重新进队列写结果。
    const run = this.execute(decided.record.id);
    this.inFlight.add(run);
    try {
      return await run;
    } finally {
      this.inFlight.delete(run);
    }
  }

  private async decideLocked(
    id: string,
    decision: { decision: 'approve' | 'deny'; via: DecisionChannel; by: string; reason?: string },
  ): Promise<DecideResult> {
    // 只接受两个字面量；未知决策串不得回落到「批准」。
    const rawDecision: string = decision.decision;
    if (rawDecision !== 'approve' && rawDecision !== 'deny') {
      return { ok: false, code: 'invalid_body' };
    }

    const record = this.records.get(id);
    if (record === undefined) return { ok: false, code: 'not_found' };
    if (record.status !== 'pending') {
      return { ok: false, code: 'not_pending', record: this.clone(record) };
    }
    if (record.kind === 'control.command' && decision.via !== 'qq') {
      return { ok: false, code: 'wrong_channel', record: this.clone(record) };
    }

    const wallNow = this.now();
    if (this.isDue(record)) {
      this.markExpired(record, wallNow);
      await this.persistTerminal();
      this.emit({ type: 'expired', record: this.clone(record) });
      return { ok: false, code: 'expired', record: this.clone(record) };
    }

    // 内存中的载荷被篡改（或加载路径漏网）时 fail closed。
    if (record.fingerprint !== fingerprintPayload(record.payload)) {
      record.status = 'stale';
      record.decidedAt = new Date(wallNow).toISOString();
      record.decidedVia = 'system';
      record.decidedBy = 'system';
      record.decisionReason = 'fingerprint mismatch';
      await this.persistTerminal();
      this.emit({ type: 'decided', record: this.clone(record) });
      return { ok: false, code: 'stale', record: this.clone(record) };
    }

    record.decidedAt = new Date(wallNow).toISOString();
    record.decidedVia = decision.via;
    record.decidedBy = safeText(decision.by, MAX_TITLE_LENGTH);
    if (decision.reason !== undefined) {
      record.decisionReason = safeText(decision.reason, MAX_REASON_LENGTH);
    }

    if (decision.decision === 'deny') {
      record.status = 'denied';
      if (!(await this.persistTerminal())) {
        return { ok: false, code: 'conflict', record: this.clone(record) };
      }
      this.emit({ type: 'decided', record: this.clone(record) });
      return { ok: true, record: this.clone(record) };
    }

    record.status = 'approved';
    // executing 标记与终态写入同临界区：第二个 decide 必然看到非 pending。
    record.execution = { state: 'pending' };
    if (!(await this.persistTerminal())) {
      // 批准不可持久化时不执行 Applier，但内存状态必须描述现实：
      // 否则 T5 会渲染一条永远「执行中」的假记录。
      record.execution = {
        state: 'failed',
        at: new Date(this.now()).toISOString(),
        error: 'persist failed',
      };
      this.emit({ type: 'executed', record: this.clone(record) });
      return { ok: false, code: 'conflict', record: this.clone(record) };
    }
    this.emit({ type: 'decided', record: this.clone(record) });
    return { ok: true, record: this.clone(record) };
  }

  /**
   * 取消只收窄权限，因此不施加通道绑定；`control.command` 的网页会话
   * 取消一条待确认记录不会替 owner 批准任何动作。
   */
  cancel(
    id: string,
    meta: { via: DecisionChannel; by: string; reason?: string },
  ): Promise<DecideResult> {
    return this.enqueue(async () => {
      const record = this.records.get(id);
      if (record === undefined) return { ok: false, code: 'not_found' };
      if (record.status !== 'pending') {
        return { ok: false, code: 'not_pending', record: this.clone(record) };
      }
      const wallNow = this.now();
      if (this.isDue(record)) {
        this.markExpired(record, wallNow);
        await this.persistTerminal();
        this.emit({ type: 'expired', record: this.clone(record) });
        return { ok: false, code: 'expired', record: this.clone(record) };
      }
      record.status = 'cancelled';
      record.decidedAt = new Date(wallNow).toISOString();
      record.decidedVia = meta.via;
      record.decidedBy = safeText(meta.by, MAX_TITLE_LENGTH);
      if (meta.reason !== undefined) {
        record.decisionReason = safeText(meta.reason, MAX_REASON_LENGTH);
      }
      if (!(await this.persistTerminal())) {
        return { ok: false, code: 'conflict', record: this.clone(record) };
      }
      this.emit({ type: 'decided', record: this.clone(record) });
      return { ok: true, record: this.clone(record) };
    });
  }

  list(filter: ListFilter = {}): ApprovalRecord[] {
    const status = filter.status ?? 'pending';
    const includeControl = filter.includeControl === true;
    const out: ApprovalRecord[] = [];
    for (const record of this.records.values()) {
      if (status !== 'all' && record.status !== status) continue;
      // 已过 TTL 的 pending 记录在扫描器跑到之前也不得显示为「可操作」；
      // 状态本身不动（过期落盘只发生在扫描/决策的临界区）。
      if (status === 'pending' && this.isDue(record)) continue;
      // 不变量 21(c)：`control.command` 只存在于发起它的那条私聊，
      // 默认列表（#审批 / GET /api/approvals）不展示它。
      if (!includeControl && record.kind === 'control.command') continue;
      if (filter.kind !== undefined && record.kind !== filter.kind) continue;
      out.push(this.clone(record));
    }
    out.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    return out;
  }

  get(id: string): ApprovalRecord | undefined {
    const record = this.records.get(id);
    return record === undefined ? undefined : this.clone(record);
  }

  /** TTL 即拒绝：过期判定与状态转换同临界区。 */
  expireDue(): Promise<void> {
    return this.enqueue(() => this.expireDueLocked());
  }

  private async expireDueLocked(): Promise<void> {
    const wallNow = this.now();
    const expired: ApprovalRecord[] = [];
    for (const record of this.records.values()) {
      if (record.status !== 'pending' || !this.isDue(record)) continue;
      this.markExpired(record, wallNow);
      expired.push(record);
    }
    if (expired.length === 0) return;
    await this.persistTerminal();
    for (const record of expired) this.emit({ type: 'expired', record: this.clone(record) });
  }

  on(listener: (event: ApprovalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 停止扫描器并 flush：等在途 Applier 与队列尾部都落盘。 */
  async stop(): Promise<void> {
    if (this.scanTimer !== null) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    try {
      await this.queue;
    } catch {
      // 队列尾部从不 reject；防御性兜底。
    }
    if (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
    try {
      await this.queue;
    } catch {
      // 同上。
    }
  }

  private async execute(id: string): Promise<DecideResult> {
    const snapshot = this.records.get(id);
    if (snapshot === undefined) return { ok: false, code: 'not_found' };
    // 只有 approved + execution.pending 才能执行；重入时直接返回当前记录。
    if (snapshot.status !== 'approved' || snapshot.execution?.state !== 'pending') {
      return { ok: true, record: this.clone(snapshot) };
    }
    if (this.executing.has(id)) return { ok: true, record: this.clone(snapshot) };
    this.executing.add(id);

    try {
      const applier = this.appliers[snapshot.kind];
      let outcome: ApplierOutcome;
      try {
        outcome =
          applier === undefined
            ? { ok: false, code: 'not_implemented' }
            : await this.runApplier(applier, this.clone(snapshot));
      } catch (error) {
        outcome = { ok: false, code: 'conflict', error: errorMessage(error) };
      }

      return await this.enqueue(() => this.finishExecution(id, outcome));
    } finally {
      this.executing.delete(id);
    }
  }

  /**
   * Applier 必须有界：挂死的执行器不得让 `decide()` 或 `stop()` 永远等待。
   * 超时按失败处理（记录仍 approved），迟到的结果被忽略。
   */
  private async runApplier(applier: Applier, record: ApprovalRecord): Promise<ApplierOutcome> {
    const invocation = applier(record, { log: this.log, now: this.now, hooks: this.hooks });
    if (this.executionTimeoutMs <= 0) return invocation;

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<ApplierOutcome>((resolve) => {
      timer = setTimeout(() => {
        resolve({ ok: false, code: 'conflict', error: 'timeout' });
      }, this.executionTimeoutMs);
      timer.unref();
    });

    try {
      return await Promise.race([invocation, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async finishExecution(id: string, outcome: ApplierOutcome): Promise<DecideResult> {
    const record = this.records.get(id);
    if (record === undefined) return { ok: false, code: 'not_found' };
    // 执行结果只能写入一次：状态或 executing 标记已变时不再覆盖。
    if (record.status !== 'approved' || record.execution?.state !== 'pending') {
      return { ok: true, record: this.clone(record) };
    }

    const at = new Date(this.now()).toISOString();
    if (outcome.ok) {
      record.execution = { state: 'done', at };
    } else {
      const detail = safeText(outcome.error ?? outcome.code, MAX_REASON_LENGTH);
      record.execution = { state: 'failed', at, error: detail };
      if (outcome.code === 'stale') {
        record.status = 'stale';
        record.decisionReason = record.decisionReason ?? 'fingerprint mismatch';
      }
      this.log(`approval ${record.id} 执行失败：${safeLogDetail(detail)}`);
    }

    await this.persist();
    this.emit({ type: 'executed', record: this.clone(record) });
    return { ok: true, record: this.clone(record) };
  }

  private isDue(record: ApprovalRecord): boolean {
    if (record.expiresAtMono !== undefined) return this.monoNow() >= record.expiresAtMono;
    const deadline = Date.parse(record.expiresAt);
    return !Number.isFinite(deadline) || this.now() >= deadline;
  }

  private markExpired(record: ApprovalRecord, wallNow: number): void {
    record.status = 'expired';
    record.decidedAt = new Date(wallNow).toISOString();
    record.decidedVia = 'system';
    record.decidedBy = 'system';
  }

  private ttlFor(kind: ApprovalKind): number {
    if (kind === 'control.command') return this.ttl.controlCommandMs ?? CONTROL_COMMAND_TTL_MS;
    if (kind === 'capability.activate') {
      return this.ttl.capabilityActivateMs ?? CAPABILITY_ACTIVATE_TTL_MS;
    }
    return this.ttl.defaultMs ?? DEFAULT_APPROVAL_TTL_MS;
  }

  /** 内存 pending 也必须有界：超限时把最旧 pending 置为 cancelled 并记日志。 */
  private evictOverflow(): void {
    const pending = [...this.records.values()].filter((record) => record.status === 'pending');
    if (pending.length < MAX_APPROVAL_RECORDS) return;

    pending.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    const overflow = pending.length - MAX_APPROVAL_RECORDS + 1;
    for (const record of pending.slice(0, overflow)) {
      record.status = 'cancelled';
      record.decidedAt = new Date(this.now()).toISOString();
      record.decidedVia = 'system';
      record.decidedBy = 'system';
      record.decisionReason = 'capacity';
      this.log(`approval ${record.id} 因 pending 上限被淘汰`);
    }
  }

  private async writeOnce(): Promise<void> {
    const snapshot = [...this.records.values()];
    if (this.writeApprovals !== undefined) {
      await this.writeApprovals(this.dataDir, snapshot);
      return;
    }
    await saveApprovals(this.dataDir, snapshot, {
      log: this.log,
      now: this.now,
      bootId: this.bootId,
    });
  }

  /** 尽力写入：提案/执行结果/加载修复丢一次可以重来，不值得让调用方失败。 */
  private async persist(): Promise<void> {
    try {
      await this.writeOnce();
    } catch (error) {
      // 控制面故障不得冒泡进心跳：只记日志，内存状态继续服务。
      this.log(`approvals.json 写入失败：${safeLogDetail(errorMessage(error))}`);
    }
  }

  /** 终态写入：3 次尝试 + 线性退避。 */
  private async persistWithRetry(): Promise<boolean> {
    for (let attempt = 0; attempt < PERSIST_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await sleep(PERSIST_BACKOFF_MS * attempt);
      try {
        await this.writeOnce();
        return true;
      } catch {
        // 继续重试。
      }
    }
    return false;
  }

  /** 终态不可持久化时保留内存状态并大声记一行；调用方据此返回 conflict。 */
  private async persistTerminal(): Promise<boolean> {
    const durable = await this.persistWithRetry();
    if (!durable) this.log('approvals: persist failed after terminal decision');
    return durable;
  }

  private startScanner(): void {
    if (this.scanIntervalMs <= 0 || this.scanTimer !== null) return;
    this.scanTimer = setInterval(() => {
      void this.expireDue().catch((error: unknown) => {
        this.log(`approval 过期扫描失败：${safeLogDetail(errorMessage(error))}`);
      });
    }, this.scanIntervalMs);
    this.scanTimer.unref();
  }

  private emit(event: ApprovalEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.log(`approval listener failed: ${safeLogDetail(errorMessage(error))}`);
      }
    }
  }

  private clone(record: ApprovalRecord): ApprovalRecord {
    return structuredClone(record);
  }

  /** 串行队列：按调用顺序执行，失败不会让后续操作卡死。 */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
