/**
 * `DATA_DIR/control-state.json`：只持久化**操作员意图**。
 *
 * 形状（spec §9）：
 * `{ version:1, bootId, groups:{ [gid]: { silencedUntil?, observingUntil? } }, proactive:{ lastSentAt?, dayKey?, sentToday? } }`
 *
 * 文件损坏或信封不符 → 空状态（不安静、主动私聊计数清零）并记日志：
 * 宁可忘记一次静默，也不能把一个损坏文件解释成「继续安静」。
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from '../util/atomic-json.js';
import { stripUnsafeControls } from '../util/tty.js';

export const CONTROL_STATE_FILE = 'control-state.json';
const STORE_VERSION = 1;
/** 日志细节上限；文件名/错误文本不可信。 */
const MAX_LOG_DETAIL = 200;

export interface ControlGroupState {
  /** 绝对 epoch 毫秒；缺省表示该群未静默。 */
  silencedUntil?: number;
  /**
   * 平台派生的观察期截止（被禁言/踢出后 24h）。与 operator 静默分开持久化：
   * `#状态` 必须能区分「平台让我们闭嘴」和「owner 让我们闭嘴」。
   */
  observingUntil?: number;
}

/** 护栏操作员状态的可持久化投影；与 QQ 插件 `GuardOperatorState` 结构兼容。 */
export interface OperatorGroupState {
  groupId: string;
  silencedUntil?: number;
  observingUntil?: number;
}

export interface ControlProactiveState {
  lastSentAt?: number;
  dayKey?: string;
  sentToday?: number;
}

export interface ControlState {
  version: 1;
  bootId: string;
  groups: Record<string, ControlGroupState>;
  proactive: ControlProactiveState;
}

export interface ControlStateStoreOptions {
  dataDir: string;
  log?: (line: string) => void;
  now?: () => number;
  /** 每个实例一个；测试可注入固定值。 */
  bootId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function safeLogDetail(value: string): string {
  return stripUnsafeControls(value).replace(/[\r\n]+/g, ' ').slice(0, MAX_LOG_DETAIL);
}

export class ControlStateStore {
  private readonly file: string;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private state: ControlState;

  /** 写入串行化：同一文件的多条变更不能交错。 */
  private queue: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(opts: ControlStateStoreOptions) {
    this.file = path.join(opts.dataDir, CONTROL_STATE_FILE);
    this.log = opts.log ?? (() => undefined);
    this.now = opts.now ?? Date.now;
    this.state = {
      version: STORE_VERSION,
      bootId: opts.bootId ?? randomBytes(8).toString('hex'),
      groups: {},
      proactive: {},
    };
  }

  /** 读取磁盘状态。缺失 → 空；损坏/信封不符 → 空 + 日志。重入 no-op。 */
  load(): Promise<void> {
    return this.enqueue(async () => {
      if (this.loaded) return;
      this.loaded = true;

      const read = await readJsonFile(this.file);
      if (!read.ok) {
        if (read.code === 'corrupt') {
          this.log('control-state.json 损坏，已按空状态启动（不安静、主动私聊计数清零）');
        }
        return;
      }

      const envelope = read.value;
      if (!isRecord(envelope) || envelope['version'] !== STORE_VERSION) {
        this.log('control-state.json 信封无效，已按空状态启动');
        return;
      }

      const groups: Record<string, ControlGroupState> = {};
      const rawGroups = envelope['groups'];
      if (isRecord(rawGroups)) {
        for (const [groupId, raw] of Object.entries(rawGroups)) {
          if (groupId === '' || groupId.length > 64) continue;
          if (!isRecord(raw)) continue;
          const entry: ControlGroupState = {};
          const silenced = raw['silencedUntil'];
          if (silenced !== undefined) {
            if (isPositiveNumber(silenced)) entry.silencedUntil = silenced;
            else this.log(`control-state.json 丢弃无效的静默截止（群 ${safeLogDetail(groupId)}）`);
          }
          const observing = raw['observingUntil'];
          if (observing !== undefined) {
            if (isPositiveNumber(observing)) entry.observingUntil = observing;
            else this.log(`control-state.json 丢弃无效的观察截止（群 ${safeLogDetail(groupId)}）`);
          }
          groups[groupId] = entry;
        }
      }

      const proactive: ControlProactiveState = {};
      const rawProactive = envelope['proactive'];
      if (isRecord(rawProactive)) {
        if (isPositiveNumber(rawProactive['lastSentAt'])) {
          proactive.lastSentAt = rawProactive['lastSentAt'];
        }
        if (typeof rawProactive['dayKey'] === 'string' && rawProactive['dayKey'] !== '') {
          proactive.dayKey = rawProactive['dayKey'];
        }
        const sentToday = rawProactive['sentToday'];
        if (typeof sentToday === 'number' && Number.isSafeInteger(sentToday) && sentToday >= 0) {
          proactive.sentToday = sentToday;
        }
      }

      this.state = { ...this.state, groups, proactive };
    });
  }

  /** 只读快照；调用方修改返回值不会影响存储。 */
  snapshot(): ControlState {
    return structuredClone(this.state);
  }

  getGroupSilencedUntil(groupId: string): number | undefined {
    return this.state.groups[groupId]?.silencedUntil;
  }

  getGroupObservingUntil(groupId: string): number | undefined {
    return this.state.groups[groupId]?.observingUntil;
  }

  /** 该群（`'*'` 为全局）当前是否仍在静默期。 */
  isSilenced(groupId: string, now: number = this.now()): boolean {
    const until = this.getGroupSilencedUntil(groupId);
    return until !== undefined && until > now;
  }

  proactive(): ControlProactiveState {
    return { ...this.state.proactive };
  }

  /** `undefined` 表示清除该群的静默（观察期保持不变）。 */
  setGroupSilencedUntil(groupId: string, until: number | undefined): Promise<void> {
    if (until === undefined) {
      return this.clearGroupField(groupId, 'silencedUntil');
    }
    if (!isPositiveNumber(until)) {
      this.log(`control-state: 拒绝无效的静默截止（群 ${safeLogDetail(groupId)}）`);
      return Promise.resolve();
    }
    this.state.groups[groupId] = { ...this.state.groups[groupId], silencedUntil: until };
    return this.persist();
  }

  /** `undefined` 表示清除该群的观察期（静默保持不变）。 */
  setGroupObservingUntil(groupId: string, until: number | undefined): Promise<void> {
    if (until === undefined) {
      return this.clearGroupField(groupId, 'observingUntil');
    }
    if (!isPositiveNumber(until)) {
      this.log(`control-state: 拒绝无效的观察截止（群 ${safeLogDetail(groupId)}）`);
      return Promise.resolve();
    }
    this.state.groups[groupId] = { ...this.state.groups[groupId], observingUntil: until };
    return this.persist();
  }

  clearGroup(groupId: string): Promise<void> {
    if (this.state.groups[groupId] === undefined) return Promise.resolve();
    delete this.state.groups[groupId];
    return this.persist();
  }

  /**
   * 导出护栏的操作员状态（仍生效的静默与观察），供
   * `exportOperatorState() → control-state.json → restoreOperatorState()` 往返。
   */
  operatorState(): OperatorGroupState[] {
    const now = this.now();
    const entries: OperatorGroupState[] = [];
    for (const [groupId, group] of Object.entries(this.state.groups)) {
      const entry: OperatorGroupState = { groupId };
      if (group.silencedUntil !== undefined && group.silencedUntil > now) {
        entry.silencedUntil = group.silencedUntil;
      }
      if (group.observingUntil !== undefined && group.observingUntil > now) {
        entry.observingUntil = group.observingUntil;
      }
      if (entry.silencedUntil === undefined && entry.observingUntil === undefined) continue;
      entries.push(entry);
    }
    return entries.sort((left, right) => left.groupId.localeCompare(right.groupId));
  }

  /**
   * 用护栏导出的操作员状态整体替换群状态。输入来自磁盘/护栏，按不可信
   * 数据校验：坏条目跳过，已过期条目丢弃。
   */
  replaceOperatorState(entries: readonly OperatorGroupState[]): Promise<void> {
    const now = this.now();
    const groups: Record<string, ControlGroupState> = {};
    for (const raw of entries) {
      if (typeof raw !== 'object' || raw === null) continue;
      const groupId = raw.groupId;
      if (typeof groupId !== 'string' || groupId === '' || groupId.length > 64) continue;
      const entry: ControlGroupState = {};
      if (isPositiveNumber(raw.silencedUntil) && raw.silencedUntil > now) {
        entry.silencedUntil = raw.silencedUntil;
      }
      if (isPositiveNumber(raw.observingUntil) && raw.observingUntil > now) {
        entry.observingUntil = raw.observingUntil;
      }
      if (entry.silencedUntil === undefined && entry.observingUntil === undefined) continue;
      groups[groupId] = entry;
    }
    this.state.groups = groups;
    return this.persist();
  }

  private clearGroupField(
    groupId: string,
    field: 'silencedUntil' | 'observingUntil',
  ): Promise<void> {
    const current = this.state.groups[groupId];
    if (current === undefined || current[field] === undefined) return Promise.resolve();
    const next: ControlGroupState = { ...current };
    delete next[field];
    if (next.silencedUntil === undefined && next.observingUntil === undefined) {
      delete this.state.groups[groupId];
    } else {
      this.state.groups[groupId] = next;
    }
    return this.persist();
  }

  setProactive(patch: Partial<ControlProactiveState>): Promise<void> {
    const next: ControlProactiveState = { ...this.state.proactive };
    if (patch.lastSentAt !== undefined) {
      if (!isPositiveNumber(patch.lastSentAt)) {
        this.log('control-state: 拒绝无效的 lastSentAt');
        return Promise.resolve();
      }
      next.lastSentAt = patch.lastSentAt;
    }
    if (patch.dayKey !== undefined) {
      if (typeof patch.dayKey !== 'string' || patch.dayKey === '') {
        this.log('control-state: 拒绝无效的 dayKey');
        return Promise.resolve();
      }
      next.dayKey = patch.dayKey;
    }
    if (patch.sentToday !== undefined) {
      if (!Number.isSafeInteger(patch.sentToday) || patch.sentToday < 0) {
        this.log('control-state: 拒绝无效的 sentToday');
        return Promise.resolve();
      }
      next.sentToday = patch.sentToday;
    }
    this.state.proactive = next;
    return this.persist();
  }

  /** 等待所有在途写入完成。 */
  async stop(): Promise<void> {
    await this.queue;
  }

  private persist(): Promise<void> {
    return this.enqueue(async () => {
      try {
        await writeJsonAtomic(this.file, this.state);
      } catch (error) {
        // 控制面故障不得冒泡：内存状态继续服务，重启后最多丢失一次操作员意图。
        const detail = error instanceof Error ? error.message : String(error);
        this.log(`control-state.json 写入失败：${safeLogDetail(detail)}`);
      }
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
