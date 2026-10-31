/**
 * 感知队列：外部事件的唯一入口。
 *
 * 事件到达只入队（push），由心跳循环在下一次 tick drain 出来处理。
 * requestWake 是高重要度事件的即时唤醒请求，带防抖：窗口从本窗口第一次
 * 调用起算，窗口内的后续调用只合并、不顺延——持续到来的事件不会无限
 * 推迟唤醒。
 *
 * 队列有上限（默认 500，D8）：超限时淘汰重要度最低且最旧的事件并记一行
 * 日志，繁忙群的消息不得让队列无界增长。
 */

import { randomUUID } from 'node:crypto';

/**
 * 事件来源类型。P1 起放宽为任意字符串：插件在各自的 manifest/实现里
 * 定义自己的 kind 取值，宿主不再枚举。
 */
export type PerceptionKind = string;

/**
 * 事件来源渠道。P1 起放宽为任意字符串：插件用 channelPrefix 与自定义
 * 渠道名，宿主不再枚举。
 */
export type PerceptionChannel = string;

/** 一条感知事件。 */
export interface PerceptionEvent {
  id: string;
  ts: number;
  kind: PerceptionKind;
  channel: PerceptionChannel;
  actor: string;
  content: string;
  importance: number;
  /**
   * 合成事件（主动私聊 tick 等）：不是外部用户发来的内容。
   * 入站对话记录跳过它，绝不把合成提示写成「用户消息」。
   */
  synthetic?: boolean;
}

/** 可注入的定时器接口，测试可用 vitest fake timers 或手写桩。 */
export interface Timers {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

/** 默认 3000ms，与 Config.wakeDebounceMs 的默认值一致。 */
const DEFAULT_DEBOUNCE_MS = 3000;

/** 默认队列上限，与 Config.maxQueueSize 的默认值一致（D8）。 */
const DEFAULT_MAX_SIZE = 500;

/** 默认走全局定时器；延迟解析 globalThis，fake timers 替换后仍然生效。 */
const defaultTimers: Timers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface PerceptionQueueOptions {
  /** 防抖窗口，默认 3000ms；传函数时按次读取（热生效的 `tick.wakeDebounceMs`）。 */
  debounceMs?: number | (() => number);
  /** 定时器注入，默认全局 setTimeout / clearTimeout。 */
  timers?: Timers;
  /** 事件 id 生成器，默认 crypto.randomUUID。 */
  sizeGen?: () => string;
  /** 队列上限，默认 500；超限淘汰重要度最低且最旧的事件。 */
  maxSize?: number;
  /** 淘汰日志出口，默认静默。 */
  log?: (line: string) => void;
  /**
   * 入队观察者：在 `push` 把事件放进队列时同步调用（对话记录用）。
   * 记录的是「入队时」的事件，可能包含之后被淘汰或静默重排的条目。
   * 观察者抛错不得影响入队。
   */
  onPush?: (event: PerceptionEvent) => void;
}

export class PerceptionQueue {
  private events: PerceptionEvent[] = [];
  private wakeCallbacks: Array<() => void> = [];
  private wakeTimer: unknown = null;
  private readonly debounceMs: number | (() => number);
  private readonly timers: Timers;
  private sizeGen: () => string;
  private readonly maxSize: number;
  private readonly log: (line: string) => void;
  private readonly onPush: ((event: PerceptionEvent) => void) | undefined;

  constructor(options: PerceptionQueueOptions = {}) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.timers = options.timers ?? defaultTimers;
    this.sizeGen = options.sizeGen ?? randomUUID;
    this.maxSize = Math.max(1, options.maxSize ?? DEFAULT_MAX_SIZE);
    this.log = options.log ?? (() => {});
    this.onPush = options.onPush;
  }

  /**
   * 入队一条事件。超过上限时淘汰重要度最低的事件（同重要度淘汰最旧的一条）
   * 并记一行日志：繁忙群的消息不得让队列无界增长（D8）。
   */
  push(event: PerceptionEvent): void {
    this.events.push(event);
    this.notifyPush(event);
    this.enforceCap();
  }

  /** 观察者抛错只记日志：记录失败绝不能阻塞事件入队。 */
  private notifyPush(event: PerceptionEvent): void {
    if (this.onPush === undefined) return;
    try {
      this.onPush(event);
    } catch (error) {
      this.log(
        `queue: onPush failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 取出并清空全部事件。 */
  drain(): PerceptionEvent[] {
    const drained = this.events;
    this.events = [];
    return drained;
  }

  /** 队列当前长度（网页管理台只读快照）。 */
  size(): number {
    return this.events.length;
  }

  /**
   * 把一批事件按原顺序放回队列头部（静默模式重排用）。同样受上限约束：
   * 重排路径若不设上限，连续静默重试会让队列无界增长（D8）。
   */
  prepend(events: PerceptionEvent[]): void {
    if (events.length === 0) return;
    this.events = [...events, ...this.events];
    this.enforceCap();
  }

  /**
   * 淘汰重要度最低的事件（同重要度淘汰最旧的一条），直到回到上限以内。
   * 重排路径可能一次超限多条，因此循环而非只淘汰一条。
   */
  private enforceCap(): void {
    while (this.events.length > this.maxSize) {
      let victim = 0;
      for (let index = 1; index < this.events.length; index += 1) {
        if (this.events[index]!.importance < this.events[victim]!.importance) victim = index;
      }
      const [evicted] = this.events.splice(victim, 1);
      if (evicted === undefined) return;
      this.log(
        `queue: evicted ${evicted.kind} (importance=${evicted.importance}); size=${this.events.length}`,
      );
    }
  }

  /**
   * 请求唤醒。防抖窗口从本窗口第一次调用起算：已有待触发的窗口时直接
   * 返回，绝不重置定时器。
   */
  requestWake(): void {
    if (this.wakeTimer !== null) return;

    // 按次读取：配置热改后，下一次唤醒立即使用新的防抖窗口。
    const debounceMs =
      typeof this.debounceMs === 'function' ? this.debounceMs() : this.debounceMs;
    this.wakeTimer = this.timers.setTimeout(() => {
      this.wakeTimer = null;
      for (const callback of this.wakeCallbacks) callback();
    }, debounceMs);
  }

  /** 注册唤醒回调；可注册多个，触发时全部调用。 */
  onWake(callback: () => void): void {
    this.wakeCallbacks.push(callback);
  }

  /** 测试注入 id 生成器。 */
  setSizeGen(nextId: () => string): void {
    this.sizeGen = nextId;
  }

  /** 用当前 id 生成器产出一个新事件 id（渠道层构造事件时使用）。 */
  nextEventId(): string {
    return this.sizeGen();
  }
}
