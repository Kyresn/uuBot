/**
 * OneBot 11 协议类型与消息文本化。
 *
 * 只声明当前渠道用到的子集：消息事件、消息段、动作请求、动作响应。
 * `toPlainText` 把 CQ 码替换成人类可读占位符，供大脑阅读原始消息。
 *
 * **消息段是 @ / 回复的唯一权威**：对端在 `message` 数组里放什么就是什么；
 * `raw_message` 只是文本。群成员可以在正文里手写字面量 `[CQ:at,qq=<bot>]`，
 * 若拿它判唤醒，任何人都能用一条文本换一次 importance 9 + 模型调用。
 * 只有对端完全不提供 `message` 数组时才回退到旧的正则解析（可观测降级）。
 *
 * CQ 码转义（`&#91;` = `[`、`&#93;` = `]`、`&#44;` = `,`）暂不还原：
 * 转义后的内容不是 CQ 码，按普通文本原样保留，避免误判。
 */

/** OneBot 11 消息段；`data` 由对端提供，按不可信处理。 */
export interface OneBotSegment {
  type: string;
  data?: Record<string, unknown>;
}

/** OneBot 11 消息事件（群聊与私聊共用）。 */
export interface OneBotMessageEvent {
  post_type: 'message';
  message_type: 'group' | 'private';
  self_id: number;
  user_id: number;
  group_id?: number;
  message_id: number;
  raw_message: string;
  /** 结构化消息段；存在时 `raw_message` 只当文本，不再参与 @ / 回复判定。 */
  message?: OneBotSegment[];
  sender: { user_id: number; nickname?: string };
}

/** OneBot 11 动作请求。 */
export interface OneBotAction {
  action: string;
  params: Record<string, unknown>;
  echo?: string;
}

/** OneBot 11 动作响应。 */
export interface OneBotActionResponse {
  status: 'ok' | 'failed';
  retcode: number;
  data?: unknown;
  echo?: string;
}

/** 匹配一个 CQ 码：`[CQ:type]` 或 `[CQ:type,key=value,...]`。 */
const CQ_CODE = /\[CQ:([A-Za-z0-9_.-]+)(?:,([^\]]*))?\]/g;

/**
 * 把 OneBot 原始消息转成纯文本：
 * - `[CQ:image,...]` → `[图片]`
 * - `[CQ:at,qq=X]` → `[@X]`
 * - `[CQ:face,...]` → `[表情]`
 * - 其他 `[CQ:type,...]` → `[type]`
 * - 普通文本原样保留
 *
 * 未知参数不影响识别；CQ 转义实体（`&#91;` 等）按原样保留。
 */
export function toPlainText(raw: string): string {
  return raw.replace(CQ_CODE, (_match, type: string, params: string | undefined) => {
    switch (type) {
      case 'image':
        return '[图片]';
      case 'face':
        return '[表情]';
      case 'at': {
        // `[CQ:at,qq=123]` / `[CQ:at,qq=all,name=...]`；只取 qq。
        const first = params?.split(',')[0] ?? '';
        const qq = first.startsWith('qq=') ? first.slice(3) : first;
        return `[@${qq}]`;
      }
      default:
        return `[${type}]`;
    }
  });
}

/** 对端是否提供了结构化消息段；决定走段解析还是 `raw_message` 回退。 */
export function hasMessageSegments(event: OneBotMessageEvent): boolean {
  return Array.isArray(event.message);
}

function isSegment(value: unknown): value is OneBotSegment {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['type'] === 'string';
}

/** `[CQ:at,qq=<selfId>]`，允许额外参数。仅在无消息段时使用。 */
function mentionsSelfInRaw(raw: string, selfId: number): boolean {
  return new RegExp(`\\[CQ:at,qq=${selfId}(?:,[^\\]]*)?\\]`).test(raw);
}

/** 取出 `[CQ:reply,id=N]` 的目标 id；没有则返回 null。仅在无消息段时使用。 */
function replyTargetIdInRaw(raw: string): number | null {
  const match = /\[CQ:reply,id=(\d+)(?:,[^\]]*)?\]/.exec(raw);
  const id = match?.[1];
  return id === undefined ? null : Number(id);
}

/**
 * 这条消息是否 @ 了自己。
 *
 * 有 `message` 数组时只认 `type === 'at' && data.qq === String(selfId)`；
 * 数组里没有命中就是没有——`raw_message` 里的字面量 CQ 码不参与判定。
 * 数组缺失时回退到旧正则（调用方负责记一次降级日志）。
 */
export function mentionsSelf(event: OneBotMessageEvent, selfId: number): boolean {
  if (!Array.isArray(event.message)) return mentionsSelfInRaw(event.raw_message, selfId);

  const expected = String(selfId);
  return event.message.some(
    (segment) => isSegment(segment) && segment.type === 'at' && segment.data?.['qq'] === expected,
  );
}

/** 段里的回复目标 id：数字或纯数字字符串，安全正整数才算数。 */
function parseSegmentId(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

/**
 * 这条消息回复的目标 message_id；没有回复段时返回 null。
 *
 * 有 `message` 数组时只认 `type === 'reply'`；`raw_message` 里的字面量
 * `[CQ:reply,id=...]` 不参与判定。数组缺失时回退到旧正则。
 */
export function replyTargetId(event: OneBotMessageEvent): number | null {
  if (!Array.isArray(event.message)) return replyTargetIdInRaw(event.raw_message);

  for (const segment of event.message) {
    if (!isSegment(segment) || segment.type !== 'reply') continue;
    return parseSegmentId(segment.data?.['id']);
  }
  return null;
}
