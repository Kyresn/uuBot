/**
 * QQ 控制面适配：只判「是不是 owner 私聊」和「把消息交给哪个端口」。
 *
 * 这里没有状态机、没有审批、没有意图解析——那些都在 `src/control/`。
 * 控制权限由宿主逐插件授予（`api.control`）；本模块只在被授予时才存在。
 */
import { checkAction } from '../../../src/persona/redlines.js';
import { sanitizeForTty, stripUnsafeControls } from '../../../src/util/tty.js';
import { parseCommand } from '../../../src/control/grammar.js';
import {
  COMMAND_ERROR_TEXT,
  type ControlInput,
  type ControlOutcome,
  type ControlPort,
} from '../../../src/control/types.js';
import type { OneBotMessageEvent } from './protocol.js';

/** 回执被红线闸拦下时的固定兜底；绝不把原文换成另一种说法重试。 */
export const CONTROL_REPLY_FALLBACK = '已处理。';

/** QQ 号是纯十进制正整数；前导零归一化后比较。 */
const OWNER_PATTERN = /^\d{1,20}$/;

export interface QqControlDeps {
  /** `QQ_OWNER_ID` 的原始值；缺失/非法时控制面禁用。 */
  ownerId?: string;
  /** `QQ_PRIVATE_DENYLIST`；owner 命中黑名单时控制面禁用。 */
  denylist?: ReadonlySet<string>;
  port: ControlPort;
  /** 把回执发到 owner 私聊；通常是 `api.send`。 */
  send: (channel: string, text: string) => Promise<void>;
  log: (line: string) => void;
  /** 渠道前缀，默认 `qq`。 */
  channelPrefix?: string;
  /** `QQ_CONTROL_NL`；只有显式开启才做自然语言分类。 */
  nlEnabled?: boolean;
  /** `QQ_NL_MIN_CONFIDENCE`；未提供时由 router 用 0.75。 */
  nlMinConfidence?: number;
}

export interface QqControl {
  /** 主体判定：owner 私聊、非机器人自己、未命中私聊黑名单。 */
  isOwner(event: OneBotMessageEvent): boolean;
  /**
   * 把 owner 消息转成 `ControlInput` 并交给端口。`deliver` 是通道自己的
   * 入队闭包；控制面判定为聊天时会回调它。
   */
  handle(event: OneBotMessageEvent, deliver?: () => void): Promise<ControlOutcome>;
}

function parseOwnerId(raw: string | undefined): number | undefined {
  const text = raw?.trim() ?? '';
  if (!OWNER_PATTERN.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** 供插件在 activate 时判断 `QQ_OWNER_ID` 是否可用；非法即禁用控制面。 */
export function normalizeOwnerId(raw: string | undefined): number | undefined {
  return parseOwnerId(raw);
}

/**
 * 把 id 名单（如私聊黑名单）归一化成与 sender id 相同的十进制形式。
 * `0200` 与 `200` 是同一个 QQ 号；非法条目保留原样（永远不会匹配数字 id）。
 */
export function normalizeIdList(values: ReadonlySet<string>): Set<string> {
  const normalized = new Set<string>();
  for (const value of values) {
    const id = parseOwnerId(value);
    normalized.add(id === undefined ? value.trim() : String(id));
  }
  return normalized;
}

function isPositiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** 日志细节：净化 + 单行化 + 限长；错误文本同样是不可信内容。 */
function safeLogDetail(value: string): string {
  return sanitizeForTty(value, '').replace(/[\r\n]+/g, ' ').slice(0, 200);
}

export function createQqControl(deps: QqControlDeps): QqControl {
  const ownerId = parseOwnerId(deps.ownerId);
  const prefix = deps.channelPrefix ?? 'qq';
  const denylist = normalizeIdList(deps.denylist ?? new Set<string>());

  function isOwner(event: OneBotMessageEvent): boolean {
    if (ownerId === undefined) return false;
    if (event.message_type !== 'private') return false;
    const senderId = event.sender?.user_id;
    if (!isPositiveId(senderId)) return false;
    // 机器人自己的消息永远不是控制指令。
    if (senderId === event.self_id) return false;
    if (senderId !== ownerId) return false;
    if (denylist.has(String(senderId))) return false;
    return true;
  }

  return {
    isOwner,

    async handle(event: OneBotMessageEvent, deliver?: () => void): Promise<ControlOutcome> {
      if (!isOwner(event)) return { action: 'chat' };

      const userId = String(event.sender.user_id);
      const channel = `${prefix}:private:${userId}`;

      const input: ControlInput = {
        via: 'qq',
        channel,
        userId,
        messageId: String(event.message_id),
        text: event.raw_message,
        deliver: deliver ?? (() => undefined),
        reply: async (text: string): Promise<void> => {
          // 出站与宿主共用同一道红线闸；被拦时用固定兜底，不调模型。
          const normalized = stripUnsafeControls(text);
          const verdict = checkAction({ kind: 'message_send', detail: normalized });
          const outbound = verdict.allowed ? normalized : CONTROL_REPLY_FALLBACK;
          try {
            await deps.send(channel, outbound);
          } catch (error) {
            deps.log(
              `qq: control reply failed: ${safeLogDetail(
                error instanceof Error ? error.message : String(error),
              )}`,
            );
          }
        },
        nlEnabled: deps.nlEnabled === true,
        ...(deps.nlMinConfidence === undefined
          ? {}
          : { nlMinConfidence: deps.nlMinConfidence }),
      };

      try {
        return await deps.port.handle(input);
      } catch (error) {
        deps.log(
          `qq: control handler failed: ${safeLogDetail(
            error instanceof Error ? error.message : String(error),
          )}`,
        );
        // 已识别为指令：失败也必须回执并保持 handled，绝不能落进感知队列。
        if (parseCommand(event.raw_message) !== null) {
          await input.reply(COMMAND_ERROR_TEXT);
          return { action: 'handled' };
        }
        // 从未被识别为指令：退回聊天路径。
        return { action: 'chat' };
      }
    },
  };
}
