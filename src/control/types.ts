/**
 * 控制面的唯一形状定义。
 *
 * 控制面（owner → agent）与审批队列（agent → owner）是两条不同的链路：
 * 这里只描述「owner 说了一句话，控制面怎么处理」；审批的生命周期全部在
 * `src/approvals/`。`IntentName` 与 T1 的 `ControlIntentName` 结构等价，
 * 因此控制意图可以直接装进 `control.command` 审批载荷。
 */
import type { DecisionChannel } from '../approvals/types.js';

/** §4 的 8 个意图。 */
export type IntentName =
  | 'help.read'
  | 'status.read'
  | 'approval.list'
  | 'approval.decide'
  | 'capability.ban'
  | 'capability.unban'
  | 'group.silence'
  | 'group.resume';

/** 已通过 `INTENT_SPECS[intent].parse` 归一化的意图请求。 */
export interface IntentRequest {
  intent: IntentName;
  args: Record<string, string | number>;
}

/** router 的同步回执；`handled=false` 表示「不是指令，按聊天处理」。 */
export interface ControlReply {
  text: string;
  handled: boolean;
}

/**
 * 通道层交给控制面的输入。`deliver` 是通道自己的入队闭包：控制面判定
 * 「这不是指令」时回调它，普通聊天因此不会丢。`reply` 由通道提供，
 * 负责把控制回执发回 owner（宿主红线闸仍会再过一次）。
 */
export interface ControlInput {
  via: 'qq';
  /** 会话键，例如 `qq:private:<uid>`。 */
  channel: string;
  userId: string;
  messageId: string;
  /** 原始消息文本；形状校验已由通道完成。 */
  text: string;
  /** 非指令时交还通道：入队、记日志、按需唤醒。 */
  deliver: () => void;
  /** 控制回执出口；通道负责发到 `channel`。 */
  reply: (text: string) => Promise<void>;
  /** 是否允许自然语言分类；由渠道插件从自己的 env 决定。 */
  nlEnabled?: boolean;
  /** 分类器最低置信度；由渠道插件从自己的 env 解析后传入。缺省 0.75。 */
  nlMinConfidence?: number;
}

/**
 * 通道处理结果：
 * - `handled`：控制面已处理（含用法错误），消息不得入队、不得唤醒；
 * - `deferred`：控制面稍后决定，`deliver()` 只在判定为聊天时被调用；
 * - `chat`：不是指令，通道走原路径。
 */
export type ControlOutcome =
  | { action: 'handled' }
  | { action: 'deferred'; deliver: () => void }
  | { action: 'chat' };

/** 宿主按插件授予的控制端口；manifest 无权自称拥有它。 */
export interface ControlPort {
  handle(input: ControlInput): Promise<ControlOutcome>;
}

/**
 * 已识别为控制指令但处理失败时的固定回执。控制面一旦确认「这是一条指令」，
 * 失败也只能回执并保持 handled，绝不能落回聊天进入感知队列（不变量 2）。
 */
export const COMMAND_ERROR_TEXT = '控制指令处理失败，请稍后再试。';

/** 控制指令来源；`channel` 同时是审批审计里的 `via`。 */
export interface ControlOrigin {
  channel: DecisionChannel;
  actor: string;
}
