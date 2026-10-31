/**
 * 主动私聊调度：唯一一条**非事件驱动**的出站路径。
 *
 * `runOnce()` 依次过六道闸（开关 / owner 已知 / QQ 已连接 / 队列空且无在途
 * 且不在静默 / 距上次 ≥ 最小间隔 / 今日 < 日上限 / 不在静默时段），过闸后
 * 合成一条 `proactive_tick` 感知事件入队并 `requestWake()`。它不直接调用
 * 模型、不直接发送：空队列不变量与「所有出站都过红线闸」仍然成立。
 *
 * 合成事件带 `synthetic: true`，入站对话记录据此跳过它——否则提示词会被
 * 记成一条「用户消息」。模型不想发言时只回 `NO_REPLY_TOKEN`，由心跳循环
 * 当作静默消费。
 *
 * 默认关闭（spec R4）：没有记忆时它只能拿人格摘要硬凑，质量有限。
 */
import type { PerceptionEvent, PerceptionQueue } from './events.js';
import { NO_REPLY_TOKEN } from './loop.js';
import type { ControlProactiveState } from '../control/state-store.js';

export { NO_REPLY_TOKEN };

/** 主动私聊提示词：只描述处境，不伪造用户发言。 */
export const PROACTIVE_PROMPT =
  `（此刻没有新的消息。你可以主动找对方说点什么；不想说就只回复「${NO_REPLY_TOKEN}」。）`;

const DEFAULT_MIN_GAP_MS = 6 * 60 * 60_000;
const DEFAULT_DAILY_MAX = 2;
const DEFAULT_QUIET_START = '23:00';
const DEFAULT_QUIET_END = '08:00';
const DEFAULT_INTERVAL_MS = 30 * 60_000;

/** 主动私聊的可热改参数（`qq.proactive`）；缺省字段回退到构造期值。 */
export interface ProactiveRuntimeConfig {
  enabled: boolean;
  minGapMs: number;
  dailyMax: number;
  quietStart: string;
  quietEnd: string;
  intervalMs: number;
}

export interface ProactiveSchedulerOptions {
  enabled: boolean;
  /**
   * 热生效配置：每次判定与每次 `start()` 都按次读取，保存后无需重启。
   * 提供时其字段优先于下方的构造期值。
   */
  config?: () => ProactiveRuntimeConfig;
  /** 已归一化的 owner QQ 号；未知时调度器永不触发。传函数时按次读取。 */
  owner: string | undefined | (() => string | undefined);
  isConnected: () => boolean;
  queueSize: () => number;
  inFlight: () => boolean;
  silentRounds: () => number;
  /**
   * 全局静默（保留群键 `'*'`）。关闭时**不合成 tick**：调度器自己先过闸，
   * 免得白烧一次模型调用并递增 `sentToday`，回复再被循环的出站闸丢掉。
   */
  isGloballySilenced?: () => boolean;
  state: {
    proactive(): ControlProactiveState;
    setProactive(patch: Partial<ControlProactiveState>): Promise<void>;
  };
  queue: Pick<PerceptionQueue, 'push' | 'requestWake' | 'nextEventId'>;
  now?: () => number;
  minGapMs?: number;
  dailyMax?: number;
  /** 本地时间 `HH:MM`；跨午夜窗口（如 23:00–08:00）同样成立。 */
  quietStart?: string;
  quietEnd?: string;
  /** 周期扫描间隔；`start()` 使用。 */
  intervalMs?: number;
  log?: (line: string) => void;
}

/** 本地日期键：`YYYY-MM-DD`。 */
function dayKeyOf(now: number): string {
  const date = new Date(now);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 解析 `HH:MM`；非法返回 null（由调用方回退默认值）。 */
function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function inQuietWindow(now: number, start: number, end: number): boolean {
  const date = new Date(now);
  const minute = date.getHours() * 60 + date.getMinutes();
  // 起止相同视为没有静默窗口，而不是全天静默。
  if (start === end) return false;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export class ProactiveScheduler {
  private readonly opts: ProactiveSchedulerOptions;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private timer: NodeJS.Timeout | null = null;
  /** 当前定时器的周期；用于在配置改变时重建而不是叠加定时器。 */
  private timerMs: number | null = null;

  constructor(opts: ProactiveSchedulerOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => undefined);
  }

  /** 当前生效参数：热配置优先，构造期值兜底。 */
  private settings(): ProactiveRuntimeConfig {
    const live = this.opts.config?.();
    return {
      enabled: live?.enabled ?? this.opts.enabled,
      minGapMs: live?.minGapMs ?? this.opts.minGapMs ?? DEFAULT_MIN_GAP_MS,
      dailyMax: live?.dailyMax ?? this.opts.dailyMax ?? DEFAULT_DAILY_MAX,
      quietStart: live?.quietStart ?? this.opts.quietStart ?? DEFAULT_QUIET_START,
      quietEnd: live?.quietEnd ?? this.opts.quietEnd ?? DEFAULT_QUIET_END,
      intervalMs: live?.intervalMs ?? this.opts.intervalMs ?? DEFAULT_INTERVAL_MS,
    };
  }

  /**
   * 过闸后合成一条事件；返回是否真的触发。任何异常都不冒泡：调度失败
   * 只记日志，绝不影响心跳。
   */
  async runOnce(): Promise<boolean> {
    try {
      return await this.runOnceUnsafe();
    } catch (error) {
      this.log(`proactive: tick failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * 周期扫描；可重复调用。每次调用都对齐当前配置：关闭时清掉定时器，
   * 开启时只保留一个定时器；周期变化时重建，绝不叠加。
   */
  start(): void {
    const settings = this.settings();
    if (settings.enabled !== true) {
      this.stop();
      return;
    }

    const interval = Math.max(1_000, settings.intervalMs);
    if (this.timer !== null && this.timerMs === interval) return;
    if (this.timer !== null) this.stop();

    this.timerMs = interval;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, interval);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
    this.timerMs = null;
  }

  private async runOnceUnsafe(): Promise<boolean> {
    const settings = this.settings();
    if (settings.enabled !== true) return false;
    // owner 也按次读取：保存 qq.ownerId 后下一次判定即使用新目标。
    const ownerRaw = typeof this.opts.owner === 'function' ? this.opts.owner() : this.opts.owner;
    const owner = ownerRaw?.trim() ?? '';
    if (owner === '') return false;
    if (!this.opts.isConnected()) return false;
    if (this.opts.isGloballySilenced?.() === true) return false;
    if (this.opts.queueSize() !== 0 || this.opts.inFlight() || this.opts.silentRounds() !== 0) {
      return false;
    }

    const now = this.now();
    const state = this.opts.state.proactive();
    if (state.lastSentAt !== undefined && now - state.lastSentAt < settings.minGapMs) {
      return false;
    }

    const dayKey = dayKeyOf(now);
    const sentToday = state.dayKey === dayKey ? (state.sentToday ?? 0) : 0;
    if (sentToday >= settings.dailyMax) return false;

    const quietStart =
      parseClock(settings.quietStart) ?? parseClock(DEFAULT_QUIET_START)!;
    const quietEnd = parseClock(settings.quietEnd) ?? parseClock(DEFAULT_QUIET_END)!;
    if (inQuietWindow(now, quietStart, quietEnd)) return false;

    const event: PerceptionEvent = {
      id: this.opts.queue.nextEventId(),
      ts: now,
      kind: 'proactive_tick',
      channel: `qq:private:${owner}`,
      actor: 'system',
      content: PROACTIVE_PROMPT,
      importance: 4,
      synthetic: true,
    };
    this.opts.queue.push(event);
    this.opts.queue.requestWake();

    // 计数先于模型决定：一次 tick 只算一次，模型回不回「不发言」都不重复。
    try {
      await this.opts.state.setProactive({ lastSentAt: now, dayKey, sentToday: sentToday + 1 });
    } catch (error) {
      this.log(
        `proactive: state write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.log(`proactive: queued a tick for ${event.channel}`);
    return true;
  }
}
