/**
 * OneBot notice → 固定枚举。这里不产生任何自由文本：通知正文由调用方用
 * 固定模板 + 数字群号拼装，对端提供的昵称/备注/操作者字段一律不进入输出
 * （不变量 16）。
 *
 * 映射表（spec §6）：
 * - `group_ban`/`ban`（user_id 是自己或 0=全员禁言）→ 重要度 9、唤醒、护栏警告
 * - `group_ban`/`lift_ban`（同上）→ 重要度 5、不唤醒、解除护栏
 * - `group_decrease`/`kick_me` → 重要度 9、唤醒、护栏警告（24h 观察）
 * - `group_admin`/`unset` 且 user_id 是自己 → 重要度 5、不唤醒、护栏警告
 * - 其他 → `null`（调用方记静态日志）
 */

export type NoticeAction =
  | { kind: 'muted'; groupId: string; importance: 9; wake: true; guard: 'warning' }
  | { kind: 'unmuted'; groupId: string; importance: 5; wake: false; guard: 'resume' }
  | { kind: 'kicked'; groupId: string; importance: 9; wake: true; guard: 'warning' }
  | { kind: 'admin-unset'; groupId: string; importance: 5; wake: false; guard: 'warning' };

/** notice 事件的形状子集；对端字段仍按不可信处理。 */
export interface OneBotNoticeEventLike {
  post_type?: unknown;
  notice_type?: unknown;
  sub_type?: unknown;
  self_id?: unknown;
  group_id?: unknown;
  user_id?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** 0 是 OneBot 的「全员」哨兵；其他非负整数是普通用户 id。 */
function isUserId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * 映射一条 notice。形状不符、self_id 与钉死的身份不一致、或不在表内时
 * 返回 `null`；绝不抛异常（ws 监听器没有未捕获异常兜底）。
 */
export function mapNotice(event: unknown, selfId: number): NoticeAction | null {
  if (!isRecord(event)) return null;
  if (event['post_type'] !== 'notice') return null;

  const noticeType = event['notice_type'];
  if (typeof noticeType !== 'string') return null;

  const eventSelfId = event['self_id'];
  // 钉死的 self_id 优先：对端伪造 self_id 不能改变「谁是我」。
  if (!isPositiveId(eventSelfId) || eventSelfId !== selfId) return null;

  const groupId = event['group_id'];
  if (!isPositiveId(groupId)) return null;
  const groupIdText = String(groupId);

  const subType = event['sub_type'];
  const userId = event['user_id'];

  if (noticeType === 'group_ban') {
    if (subType !== 'ban' && subType !== 'lift_ban') return null;
    if (!isUserId(userId)) return null;
    // 只关心自己被禁言/解禁，以及全员禁言（user_id === 0）。
    if (userId !== selfId && userId !== 0) return null;

    return subType === 'ban'
      ? { kind: 'muted', groupId: groupIdText, importance: 9, wake: true, guard: 'warning' }
      : { kind: 'unmuted', groupId: groupIdText, importance: 5, wake: false, guard: 'resume' };
  }

  if (noticeType === 'group_decrease') {
    if (subType !== 'kick_me') return null;
    return { kind: 'kicked', groupId: groupIdText, importance: 9, wake: true, guard: 'warning' };
  }

  if (noticeType === 'group_admin') {
    if (subType !== 'unset') return null;
    if (!isUserId(userId) || userId !== selfId) return null;
    return {
      kind: 'admin-unset',
      groupId: groupIdText,
      importance: 5,
      wake: false,
      guard: 'warning',
    };
  }

  return null;
}
