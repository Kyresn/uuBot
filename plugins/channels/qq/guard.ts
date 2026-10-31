/**
 * QQ 群聊护栏：限制**自言自语**的频率，并在被警告后进入观察模式。
 *
 * 护栏管的是它主动开口，不是回复：有回应（D5）时 `recordResponse` 立即
 * 清零计时与升级，所以最小间隔约束的只是没有回应时它自己继续说下去的
 * 节奏。回应判定只看发言后 5 分钟内的他人消息——更晚的消息是新的对话，
 * 不是对上一句的回应，不得清零升级。
 *
 * - 每个群独立计时：距上次发言不足 `minGapMs`（默认 90 秒，可用
 *   `QQ_MIN_REPLY_GAP_MS` 覆盖）时拒绝发送。
 * - 连续两轮发言都没有得到回应时，冷却间隔翻倍（90s → 180s → 360s …），
 *   封顶 30 分钟；`recordResponse` 把间隔重置回默认值。
 * - 被警告后进入 24 小时观察模式，期间 `allow` 恒为 false；观察期结束后
 *   从默认冷却重新开始。
 * - 操作员可用 `silence` 把某个群（或保留键 `'*'`，即全局）静默到指定
 *   时刻；静默优先于观察与最小间隔。静默与观察是**操作员设置**，可
 *   `exportOperatorState` / `restoreOperatorState` 持久化；`gapMs`、
 *   `silentRounds`、`lastSpokenAt` 只活在内存里。
 *
 * 读操作（`allow` / `isObserving` / `snapshot`）不写回过期状态：过期只影响
 * 判定结果。这样 `snapshot` 可以安全地暴露给状态页，也避免「看一眼就把
 * 观察期清掉」的隐式副作用。
 *
 * 时间通过 `now` 注入，测试无需真实等待。
 */

/** 默认最小发言间隔：90 秒。 */
const DEFAULT_MIN_GAP_MS = 90_000;
/** 发言后多久内的他人消息算作回应：5 分钟。 */
const RESPONSE_WINDOW_MS = 5 * 60_000;
/** 无回应时冷却翻倍的上限：30 分钟。 */
const MAX_GAP_MS = 30 * 60_000;
/** 被警告后的观察时长：24 小时。 */
const OBSERVATION_MS = 24 * 60 * 60_000;

export interface GroupGuardOptions {
  /**
   * 默认 90000ms。传函数时每次判定按次读取，配置热改后下一次 `allow()`
   * 即生效（升级后的冷却始终以当前基准值重新计算）。
   */
  minGapMs?: number | (() => number);
  /** 注入时钟，默认 `Date.now`。 */
  now?: () => number;
}

export type GuardReason = 'min-gap' | 'observation' | 'silenced';

export type GuardDecision = { ok: true } | { ok: false; reason: GuardReason };

interface GroupState {
  /** 上次发言时间；null 表示计时已清零。 */
  lastSpokenAt: number | null;
  /** 连续无回应的发言轮次；冷却间隔由它与当前基准值算出。 */
  silentRounds: number;
  /** 观察模式截止时间；null 表示不在观察模式。 */
  observingUntil: number | null;
  /** 操作员静默截止时间；null 表示没有静默。 */
  silencedUntil: number | null;
}

/** 护栏的只读快照；`snapshot()` 返回副本，调用方改不动内部状态。 */
export interface GroupGuardSnapshot {
  groupId: string;
  gapMs: number;
  silentRounds: number;
  lastSpokenAt: number | null;
  observingUntil: number | null;
  silencedUntil: number | null;
}

/**
 * 需要持久化的操作员设置。只含操作员能改的两个闸；冷却与升级是运行时
 * 重建的廉价状态，不落盘。
 */
export interface GuardOperatorState {
  groupId: string;
  silencedUntil?: number;
  observingUntil?: number;
}

export class GroupGuard {
  private readonly minGapOf: () => number;
  private readonly now: () => number;
  private readonly groups = new Map<string, GroupState>();

  constructor(options: GroupGuardOptions = {}) {
    const minGap = options.minGapMs;
    this.minGapOf =
      typeof minGap === 'function' ? minGap : () => minGap ?? DEFAULT_MIN_GAP_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * 当前冷却间隔：基准值按次读取，无回应升级按轮次重新计算。
   * 改配置后连升级后的间隔也随新基准缩放，且始终封顶 MAX_GAP_MS。
   */
  private effectiveGap(state: GroupState): number {
    const factor = state.silentRounds >= 2 ? 2 ** (state.silentRounds - 1) : 1;
    return Math.min(this.minGapOf() * factor, MAX_GAP_MS);
  }

  /** 当前是否允许向该群发言：静默 → 观察 → 最小间隔。 */
  allow(groupId: string): GuardDecision {
    const state = this.stateFor(groupId);
    const now = this.now();

    if (this.activeSilenceUntil(groupId, now) !== null) {
      return { ok: false, reason: 'silenced' };
    }

    // 过期只影响判定，不写回：读操作无副作用。
    if (state.observingUntil !== null && now < state.observingUntil) {
      return { ok: false, reason: 'observation' };
    }

    if (state.lastSpokenAt !== null && now - state.lastSpokenAt < this.effectiveGap(state)) {
      return { ok: false, reason: 'min-gap' };
    }

    return { ok: true };
  }

  /** 该群（或全局键 `'*'`）当前是否处于静默期。 */
  isSilenced(groupId: string): boolean {
    return this.activeSilenceUntil(groupId, this.now()) !== null;
  }

  /** 操作员静默：把该群（或 `'*'`）的出站闸关到 `untilMs`。 */
  silence(groupId: string, untilMs: number): void {
    this.stateFor(groupId).silencedUntil = untilMs;
  }

  /**
   * 平台解除（如 `lift_ban` notice）：只清平台自己造成的观察期，
   * **绝不**清操作员静默——平台解禁不等于 owner 撤销 `#安静`。
   */
  resumePlatform(groupId: string): void {
    const state = this.groups.get(groupId);
    if (state === undefined) return;
    state.observingUntil = null;
  }

  /**
   * 操作员恢复（`#恢复`）：无参数时清全局键 `'*'`，带群号时只清该群。
   * 静默与观察一并清除（owner 撤销自己下的限制）。
   */
  resumeOperator(groupId?: string): void {
    const target = groupId ?? '*';
    const state = this.groups.get(target);
    if (state === undefined) return;
    state.silencedUntil = null;
    state.observingUntil = null;
  }

  /**
   * T2 `GuardControl` 的结构兼容入口，等同 `resumeOperator`。
   * 平台路径必须用 `resumePlatform`，两者语义不同。
   */
  resume(groupId?: string): void {
    this.resumeOperator(groupId);
  }

  /** 只读快照；不触发惰性过期清理，也不创建未知群的条目。 */
  snapshot(): GroupGuardSnapshot[] {
    const entries: GroupGuardSnapshot[] = [];
    for (const [groupId, state] of this.groups) {
      entries.push({
        groupId,
        gapMs: this.effectiveGap(state),
        silentRounds: state.silentRounds,
        lastSpokenAt: state.lastSpokenAt,
        observingUntil: state.observingUntil,
        silencedUntil: state.silencedUntil,
      });
    }
    return entries;
  }

  /** 导出**仍生效的**操作员设置；已过期或从未设置的群不导出。 */
  exportOperatorState(): GuardOperatorState[] {
    const now = this.now();
    const entries: GuardOperatorState[] = [];
    for (const [groupId, state] of this.groups) {
      const silencedUntil =
        state.silencedUntil !== null && now < state.silencedUntil ? state.silencedUntil : null;
      const observingUntil =
        state.observingUntil !== null && now < state.observingUntil ? state.observingUntil : null;
      if (silencedUntil === null && observingUntil === null) continue;
      const entry: GuardOperatorState = { groupId };
      if (silencedUntil !== null) entry.silencedUntil = silencedUntil;
      if (observingUntil !== null) entry.observingUntil = observingUntil;
      entries.push(entry);
    }
    return entries;
  }

  /**
   * 恢复操作员设置。对列出的群是权威的（缺失字段视为清除），对未列出的
   * 已有群清除闸门；内存字段（冷却/升级/上次发言）一律不动。
   * 输入来自磁盘，按不可信数据校验：坏条目只跳过/清除，绝不抛错。
   */
  restoreOperatorState(state: GuardOperatorState[]): void {
    if (!Array.isArray(state)) return;

    const listed = new Set<string>();
    for (const entry of state) {
      if (typeof entry !== 'object' || entry === null) continue;
      const groupId = (entry as { groupId?: unknown }).groupId;
      if (typeof groupId !== 'string' || groupId === '') continue;
      listed.add(groupId);
    }

    for (const [groupId, groupState] of this.groups) {
      if (listed.has(groupId)) continue;
      groupState.silencedUntil = null;
      groupState.observingUntil = null;
    }

    for (const entry of state) {
      if (typeof entry !== 'object' || entry === null) continue;
      const groupId = (entry as { groupId?: unknown }).groupId;
      if (typeof groupId !== 'string' || groupId === '') continue;
      const groupState = this.stateFor(groupId);
      groupState.silencedUntil = readOperatorTime(
        (entry as { silencedUntil?: unknown }).silencedUntil,
      );
      groupState.observingUntil = readOperatorTime(
        (entry as { observingUntil?: unknown }).observingUntil,
      );
    }
  }

  /** 记录一次成功发言。连续两轮无回应后冷却翻倍，封顶 MAX_GAP_MS。 */
  recordSpoken(groupId: string): void {
    const state = this.stateFor(groupId);
    state.lastSpokenAt = this.now();
    state.silentRounds += 1;
  }

  /**
   * 他人发言：只有发言后 5 分钟内的消息才算"有回应"（D5），此时计时清零、
   * 冷却回到默认间隔。更晚的消息属于新对话，不得清掉无回应升级。
   * 该群从未发言时调用无副作用。
   */
  recordResponse(groupId: string, now?: number): void {
    const state = this.stateFor(groupId);
    const at = now ?? this.now();
    if (state.lastSpokenAt !== null && at - state.lastSpokenAt > RESPONSE_WINDOW_MS) return;

    state.lastSpokenAt = null;
    state.silentRounds = 0;
  }

  /** 被警告：进入 24 小时观察模式，结束后从默认冷却重新开始。 */
  recordWarning(groupId: string): void {
    const state = this.stateFor(groupId);
    state.observingUntil = this.now() + OBSERVATION_MS;
    state.lastSpokenAt = null;
    state.silentRounds = 0;
  }

  /** 是否仍在观察模式内（只读，不清理过期值）。 */
  isObserving(groupId: string): boolean {
    const state = this.stateFor(groupId);
    return state.observingUntil !== null && this.now() < state.observingUntil;
  }

  /** 该群自己的静默或全局键 `'*'` 的静默中，取仍在生效的那个。 */
  private activeSilenceUntil(groupId: string, now: number): number | null {
    const own = this.groups.get(groupId)?.silencedUntil ?? null;
    if (own !== null && now < own) return own;
    if (groupId === '*') return null;

    const global = this.groups.get('*')?.silencedUntil ?? null;
    if (global !== null && now < global) return global;
    return null;
  }

  private stateFor(groupId: string): GroupState {
    const existing = this.groups.get(groupId);
    if (existing !== undefined) return existing;

    const fresh: GroupState = {
      lastSpokenAt: null,
      silentRounds: 0,
      observingUntil: null,
      silencedUntil: null,
    };
    this.groups.set(groupId, fresh);
    return fresh;
  }
}

/** 只接受有限正数时间戳；其余（含 null/字符串/NaN）一律视为清除。 */
function readOperatorTime(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
