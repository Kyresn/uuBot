/**
 * QQ 渠道插件：OneBot 11 事件 → 感知事件，agent 回复 → OneBot 动作。
 *
 * 配置全部来自注入的 `RuntimeConfigHandle`（`config/harness.json` 的 `qq`
 * 段），**不再读取 `process.env` 的 `QQ_*`**——首次启动的 env 导入由
 * `HarnessStore` 完成一次，之后 env 被忽略。激活时按次读取：
 * - `qq.wsPort`：反向 WebSocket 监听端口，`0` 表示让内核挑临时端口。
 * - `qq.wsHost`：反向 WebSocket 监听地址。只有 harness 与 NapCat 分处受
 *   信任的内部网络（如 docker compose bridge）时才设置非 loopback 值；
 *   绝不要把端口暴露到公网。
 * - `qq.wsToken`：鉴权 token，必填；缺失时 activate 抛错，宿主只把本插件
 *   标记 failed，不影响其余 harness。
 * - `qq.groupAllowlist` / `qq.groupDenylist` / `qq.privateAllowlist` /
 *   `qq.privateDenylist`：黑名单优先。群白名单为空表示无群激活。
 * - `qq.privateOpen`：私聊名单整体关闭的显式开关（默认 false）。默认
 *   **失败关闭**：只有私聊白名单里的用户能私聊它。打开后任何不在黑名单里
 *   的私聊都被接收，但只回复不主动（白名单仍作为 M2b 的主动私聊目标）。
 *   打开等于把唤醒与模型预算交给任何知道它 QQ 号的人——只建议在专用小号上
 *   使用。
 * - `qq.minReplyGapMs`：群聊最小发言间隔，护栏只约束它自己主动开口的节奏，
 *   有回应时计时清零（D5）。
 *
 * 热重载：`PluginHost.reload('qq')` 停用后重新 `activate`，同一个 handle
 * 上的新配置立即生效；护栏由装配点持有，重载不重置其状态。
 *
 * 唤醒策略：群内普通消息只记录（importance 3）不唤醒；被 @、回复机器人或
 * 私聊才 importance 9 + requestWake。自己的消息丢弃，但记下 message_id，
 * 供“回复机器人”判定。`message_id` 用 500 条插入顺序窗口去重。
 *
 * 回复引用：每个被接受的群消息都更新该会话的“最近触发 id”，发送成功后
 * 清掉；回复只引用最近一条消息，不会因为 @ 之后来了普通消息而引用过期
 * 的触发消息。
 *
 * 事件校验：鉴权只证明对端持有 token，不代表事件形状可信。`handleEvent`
 * 入口先校验所有会解引用的字段，畸形事件丢弃并记日志——ws 的 'message'
 * 监听器没有未捕获异常兜底，异常冒泡会直接杀掉 harness 进程。
 *
 * 群聊护栏（`GroupGuard`）：发送前检查 `allow`，间隔不足或处于观察模式时
 * 记日志并丢弃该条回复（拟人选择，非数据丢失）；私聊不受护栏限制。
 * 群内他人发言会调用 `recordResponse` 清零冷却（仅限发言后 5 分钟内）。
 * 发送失败同样计入冷却。
 *
 * 连接状态：服务端连接/断开以 `qq_connection` 系统事件入队（importance 5，
 * 不唤醒），`qq:system` 不是可路由会话，向它发送只记日志。
 */

import type { ChannelPlugin, ChannelPluginApiV1, PushEvent } from '../../../src/plugins/api.js';
import type { HarnessQqConfig } from '../../../src/config/harness-schema.js';
import type { RuntimeConfigHandle } from '../../../src/config/runtime-handle.js';
import { isAllowed, type AllowLists } from './allowlist.js';
import { createQqControl, normalizeIdList, type QqControl } from './control.js';
import { GroupGuard } from './guard.js';
import { mapNotice, type NoticeAction } from './notice.js';
import {
  hasMessageSegments,
  mentionsSelf,
  replyTargetId,
  toPlainText,
  type OneBotMessageEvent,
} from './protocol.js';
import { QqServer } from './server.js';

/** 群内普通消息的重要度：进入上下文但不唤醒。 */
const GROUP_IMPORTANCE = 3;
/** 需要唤醒的重要度：@、回复机器人、私聊。 */
const WAKE_IMPORTANCE = 9;
/** 连接状态等系统事件的重要度：中，不唤醒。 */
const SYSTEM_IMPORTANCE = 5;

/** 静默群的入站降级幅度：importance 减 3（下限 0），且永不唤醒。 */
const SILENCE_IMPORTANCE_DROP = 3;

/** 系统事件用的会话键：没有对应通道，不可路由。 */
const SYSTEM_CHANNEL = 'qq:system';

/** message_id 去重窗口。 */
const DEDUPE_CAPACITY = 500;
/** owner 私聊的保留去重窗口：不被普通消息挤占（见 handleEvent 注释）。 */
const OWNER_DEDUPE_CAPACITY = 500;
/** 机器人自己消息 id 的记忆窗口（用于识别“回复机器人”）。 */
const BOT_MESSAGE_CAPACITY = 500;

/** 结构化消息段缺失时的降级日志：每个插件生命周期只记一次。 */
const SEGMENTS_FALLBACK_LOG = 'qq: message segments missing, falling back to raw_message';
/** qq.selfId 未配置、首次从事件钉死时的警告。 */
const SELF_ID_PIN_LOG = 'qq: qq.selfId is not set; pinned self_id from the first event';
/** 事件 self_id 与钉死身份不一致时的丢弃日志。 */
const SELF_ID_MISMATCH_LOG = 'qq: dropped event with unexpected self_id';

/** notice 正文模板：只有固定文本 + 已校验的数字群号，绝不插值对端字符串。 */
const NOTICE_CONTENT: Record<NoticeAction['kind'], (groupId: string) => string> = {
  muted: (groupId) => `QQ 在群 ${groupId} 被禁言`,
  unmuted: (groupId) => `QQ 在群 ${groupId} 被解除禁言`,
  kicked: (groupId) => `QQ 被移出群 ${groupId}`,
  'admin-unset': (groupId) => `QQ 在群 ${groupId} 被取消管理员`,
};

/** notice 唤醒限速窗口：同一个群每分钟最多唤醒一次。 */
const NOTICE_WAKE_WINDOW_MS = 60_000;
/** notice 唤醒的全局预算：无论轮换多少群号，每分钟最多 10 次。 */
const NOTICE_WAKE_GLOBAL_MAX = 10;
/** per-group 唤醒时间表的容量上限；超出按最早插入淘汰。 */
const NOTICE_WAKE_CAPACITY = 500;
/** notice 去重的时间桶宽度：同一桶内的等价 notice 只处理一次。 */
const NOTICE_DEDUPE_BUCKET_MS = 60_000;

/**
 * notice 去重键。标准 OneBot 的 `group_ban` / `group_decrease` / `group_admin`
 * 不带 `message_id`，所以键由真正存在的字段组成：类型 + 子类型 + 群 + 用户 +
 * 粗时间桶。同一桶内的重复投递被合并；跨桶则视为新的平台事件。
 */
function noticeDedupeKey(record: Record<string, unknown>, now: number): string | null {
  const noticeType = record['notice_type'];
  const subType = record['sub_type'];
  const groupId = record['group_id'];
  const userId = record['user_id'];
  if (typeof noticeType !== 'string' || typeof subType !== 'string') return null;
  if (!isPositiveId(groupId)) return null;
  // 0 是 OneBot 的「全员」哨兵；其他非负整数是用户 id。
  if (!isPositiveId(userId) && userId !== 0) return null;
  const bucket = Math.floor(now / NOTICE_DEDUPE_BUCKET_MS);
  return `${noticeType}\u0000${subType}\u0000${groupId}\u0000${userId}\u0000${bucket}`;
}

/** 与 QqServer 的结构兼容子集；测试注入假实现，避免真实 socket。 */
export interface QqServerLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  call(action: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  readonly connected: boolean;
  readonly selfId: number | undefined;
  readonly port: number;
}

/**
 * 仅测试注入的服务器需要挂事件回调；真实 QqServer 在构造时接收 `onEvent`，
 * 没有这个方法。故意不放进导出的 `QqServerLike`，避免把测试钩子当成
 * 生产服务器契约的一部分。
 */
type InjectableQqServer = QqServerLike & {
  setOnEvent?(handler: (event: OneBotMessageEvent) => void): void;
  setOnNotice?(handler: (event: unknown) => void): void;
  setOnConnectionChange?(handler: (connected: boolean) => void): void;
};

export interface QqPluginDeps {
  /** 测试注入的服务器；缺省时按配置构造真实 QqServer。 */
  server?: QqServerLike;
  /** 测试注入的群聊护栏；缺省时插件自建实例。deactivate 后也恢复为该实例。 */
  guard?: GroupGuard;
  /**
   * 热生效配置门面（由 `PluginHost.pluginFactoryArgs` 注入）。激活时按次
   * 读取 `qq` 段；`host.reload('qq')` 重新激活即拿到新值。缺省时激活失败：
   * 插件绝不回退去读 `process.env`。
   */
  config?: RuntimeConfigHandle;
}

/**
 * 固定容量的插入顺序集合：超出容量时淘汰最早插入的条目（FIFO）。
 * `has()` 不刷新顺序；去重路径命中 `has()` 后直接 return，不会 `add`，
 * 因此实际语义是“最近 N 个唯一键”，对去重而言足够。
 */
class LruSet<T> {
  private readonly entries = new Map<T, true>();

  constructor(private readonly capacity: number) {}

  add(value: T): void {
    // 删除后重插：重复 add 会把该键移到最新；has() 不改变顺序。
    this.entries.delete(value);
    this.entries.set(value, true);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) return;
      this.entries.delete(oldest.value);
    }
  }

  has(value: T): boolean {
    return this.entries.has(value);
  }

  clear(): void {
    this.entries.clear();
  }
}

/** 同一发送者的唤醒窗口：30 秒。 */
const WAKE_SENDER_WINDOW_MS = 30_000;
/** 群级唤醒窗口：1 分钟。 */
const WAKE_GROUP_WINDOW_MS = 60_000;
/** 群级唤醒上限：10 次/分钟。 */
const WAKE_GROUP_MAX = 10;
/** 发送者窗口的清理阈值：超过后顺便淘汰过期条目，避免长期运行无限增长。 */
const WAKE_SENDER_PRUNE_AT = 1_024;

export interface WakeLimiterOptions {
  senderWindowMs?: number;
  groupWindowMs?: number;
  groupMax?: number;
  now?: () => number;
}

/**
 * 唤醒限速：@ 洪泛不能无限烧模型预算。
 *
 * - 键 `${channel}\u0000${senderId}`，同一发送者在 30 秒内最多唤醒一次；
 * - 群聊另加 10 次/分钟（按群计，跨发送者），私聊没有这一层。
 *
 * 被限速的消息仍然 importance 9 入队，只是不 `requestWake()`——事件不丢，
 * 只是不立刻叫醒模型。被拒的唤醒不占用任何预算。
 */
export class WakeLimiter {
  private readonly senderWindowMs: number;
  private readonly groupWindowMs: number;
  private readonly groupMax: number;
  private readonly now: () => number;
  private readonly lastBySender = new Map<string, number>();
  private readonly groupWakes = new Map<string, number[]>();

  constructor(options: WakeLimiterOptions = {}) {
    this.senderWindowMs = options.senderWindowMs ?? WAKE_SENDER_WINDOW_MS;
    this.groupWindowMs = options.groupWindowMs ?? WAKE_GROUP_WINDOW_MS;
    this.groupMax = options.groupMax ?? WAKE_GROUP_MAX;
    this.now = options.now ?? Date.now;
  }

  /** 是否允许这次唤醒；允许时记入预算。`groupKey` 缺省表示私聊。 */
  allow(channel: string, senderId: string, groupKey?: string): boolean {
    const now = this.now();
    this.prune(now);

    const senderKey = `${channel}\u0000${senderId}`;
    const last = this.lastBySender.get(senderKey);
    if (last !== undefined && now - last < this.senderWindowMs) return false;

    if (groupKey !== undefined) {
      const recent = this.recentGroupWakes(groupKey, now);
      if (recent.length >= this.groupMax) return false;
      recent.push(now);
      this.groupWakes.set(groupKey, recent);
    }

    this.lastBySender.set(senderKey, now);
    return true;
  }

  /** 只保留群窗口内的时间戳。 */
  private recentGroupWakes(groupKey: string, now: number): number[] {
    const existing = this.groupWakes.get(groupKey) ?? [];
    return existing.filter((at) => now - at < this.groupWindowMs);
  }

  /** 发送者表过大时清理过期项；正常规模下是空操作。 */
  private prune(now: number): void {
    if (this.lastBySender.size <= WAKE_SENDER_PRUNE_AT) return;
    for (const [key, at] of this.lastBySender) {
      if (now - at >= this.senderWindowMs) this.lastBySender.delete(key);
    }
  }
}

function emptyLists(): AllowLists {
  return {
    groupAllowlist: new Set(),
    groupDenylist: new Set(),
    privateAllowlist: new Set(),
    privateDenylist: new Set(),
    privateOpen: false,
  };
}

interface QqConfig {
  /** 渠道总开关（`qq.enabled`）；关闭时激活失败，由宿主标记 failed。 */
  enabled: boolean;
  port: number;
  host: string;
  token: string;
  minGapMs: number;
  /** `qq.selfId`：显式钉死的机器人身份；未配置时从首个事件钉死。 */
  selfId?: number;
  /** `qq.ownerId`：控制面与 notice 的 owner；未配置时禁用控制面。 */
  ownerId?: number;
  /** `qq.controlEnabled`：控制面总开关。 */
  controlEnabled: boolean;
  /** `qq.controlNl`：是否允许自然语言控制指令。 */
  controlNl: boolean;
  /** `qq.nlMinConfidence`：自然语言分类的最低置信度。 */
  nlMinConfidence: number;
  /** 私聊名单整体关闭（`qq.privateOpen`）；默认 false。 */
  privateOpen: boolean;
  lists: AllowLists;
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function qqIdToNumber(value: string): number | undefined {
  if (value === '') return undefined;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : undefined;
}

/**
 * 把已校验的 `qq` 配置段映射成插件运行期形状。导出供测试直接验证映射。
 *
 * schema 已经保证端口、host、名单与数值区间合法；这里只做 token 必填检查
 * 与 id 的字符串→数字转换。插件不再解析任何 `QQ_*` 环境变量。
 */
export function readConfig(config: HarnessQqConfig): QqConfig {
  // 配置常带尾随换行/空格；构造 QqServer 前统一 trim，避免“校验时认为
  // 非空、实际比对时却带着空白”的 token 不匹配。
  const token = config.wsToken.trim();
  if (token === '') {
    throw new Error('qq channel: qq.wsToken is required (set it in config/harness.json)');
  }

  const selfId = qqIdToNumber(config.selfId);

  return {
    enabled: config.enabled,
    token,
    port: config.wsPort,
    host: config.wsHost,
    minGapMs: config.minReplyGapMs,
    ...(selfId === undefined ? {} : { selfId }),
    ownerId: qqIdToNumber(config.ownerId),
    controlEnabled: config.controlEnabled,
    controlNl: config.controlNl,
    nlMinConfidence: config.nlMinConfidence,
    privateOpen: config.privateOpen,
    lists: {
      groupAllowlist: new Set(config.groupAllowlist),
      groupDenylist: new Set(config.groupDenylist),
      privateAllowlist: new Set(config.privateAllowlist),
      // 归一化只做一次：控制面判定与普通入站必须用同一份值（N3）。
      // `0200` 与 `200` 是同一个 QQ 号；schema 导入已归一化，手写文件兜底。
      privateDenylist: normalizeIdList(new Set(config.privateDenylist)),
      privateOpen: config.privateOpen,
    },
  };
}

interface ConversationTarget {
  kind: 'group' | 'private';
  id: number;
}

function parseConversationKey(key: string): ConversationTarget | null {
  const match = /^qq:(group|private):(\d+)$/.exec(key);
  const kind = match?.[1];
  const rawId = match?.[2];
  if ((kind !== 'group' && kind !== 'private') || rawId === undefined) return null;
  return { kind, id: Number(rawId) };
}

function rememberMessageId(target: LruSet<number>, data: unknown): void {
  if (typeof data !== 'object' || data === null) return;
  const messageId = (data as Record<string, unknown>)['message_id'];
  // 只认数字：事件侧的 eventShapeError 同样严格要求数字 message_id，
  // 把 id 序列化成字符串的实现连事件都进不来，这里放宽没有实际收益。
  if (typeof messageId === 'number') target.add(messageId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** OneBot 的 id 字段：安全正整数（0 与负值不是合法 QQ 号/消息号）。 */
function isPositiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * 校验 OneBot 消息事件的形状；合法返回 null，否则返回丢弃原因。
 *
 * `server.ts` 把任何 `post_type === 'message'` 的 JSON 记录原样转给
 * `onEvent`。对端（NapCat 或任意实现）在鉴权后仍是不可信输入，字段类型
 * 错误会在 ws 的 'message' 监听器里抛异常；仓库没有 uncaughtException
 * 兜底，整个 harness 会退出。因此所有解引用前先在这里校验。
 *
 * 返回的原因是**静态文本**：日志是可信输出，绝不能把对端提供的值插进去
 * （换行/ANSI 可以借此伪造日志行）。
 */
function eventShapeError(value: unknown): string | null {
  if (!isRecord(value)) return 'event is not an object';
  if (value['post_type'] !== 'message') return 'post_type is not message';

  const messageType = value['message_type'];
  // 只认 group/private；discuss/guild 等变体不得落入私聊名单。
  if (messageType !== 'group' && messageType !== 'private') {
    return 'message_type is not group or private';
  }
  if (!isPositiveId(value['self_id'])) return 'self_id is not a positive integer';

  const sender = value['sender'];
  if (!isRecord(sender) || !isPositiveId(sender['user_id'])) {
    return 'sender.user_id is not a positive integer';
  }
  if (!isPositiveId(value['message_id'])) return 'message_id is not a positive integer';
  if (typeof value['raw_message'] !== 'string') return 'raw_message is not a string';
  if (messageType === 'group' && !isPositiveId(value['group_id'])) {
    return 'group_id is not a positive integer';
  }
  return null;
}

export function createPlugin(deps: QqPluginDeps = {}): ChannelPlugin {
  let api: ChannelPluginApiV1 | null = null;
  let server: QqServerLike | null = null;
  let lists: AllowLists = emptyLists();
  let active = false;

  /** `QQ_SELF_ID`：显式配置的机器人身份；undefined 表示尚未钉死。 */
  let configuredSelfId: number | undefined;
  /** 实际生效的机器人身份：配置值，或首个通过形状校验的事件里的 self_id。 */
  let effectiveSelfId: number | undefined;
  /** 归一化后的 `QQ_OWNER_ID`；notice 目标与控制面共用同一个值。 */
  let ownerId: number | undefined;
  /** notice 事件的可路由目标；owner 缺失或在黑名单时退回 `qq:system`。 */
  let noticeOwnerId: number | undefined;
  /** 结构化消息段降级日志只记一次。 */
  let segmentsFallbackLogged = false;
  /** 控制面被显式关闭（`QQ_CONTROL_ENABLED=0`）：notice 只记日志，不入队。 */
  let noticeLogOnly = false;
  /** 身份未钉死时丢弃的 notice 数；第一条记一次日志，钉死时汇总。 */
  let unpinnedNoticeCount = 0;
  let unpinnedNoticeLogged = false;

  const seen = new LruSet<number>(DEDUPE_CAPACITY);
  /** owner 私聊的保留去重窗口，不被普通消息挤占（见 handleEvent）。 */
  const ownerSeen = new LruSet<number>(OWNER_DEDUPE_CAPACITY);
  /**
   * notice 的去重窗口（键见 `noticeDedupeKey`）。与 message 的窗口分开：
   * 两套 id/键空间互不干扰，伪造 notice 不能提前占掉一个 message_id。
   */
  const noticeSeen = new LruSet<string>(DEDUPE_CAPACITY);
  /** 每个群最近一次 notice 唤醒时间；固定容量，超出淘汰最早条目。 */
  const lastNoticeWakeAt = new Map<string, number>();
  /** 全局 notice 唤醒时间表：防止轮换群号绕过每群每分钟的上限。 */
  const recentNoticeWakes: number[] = [];
  const botMessages = new LruSet<number>(BOT_MESSAGE_CAPACITY);
  /**
   * 每个会话最近一条被接受的群消息 id，用于群回复的 reply 段；发送成功后
   * 删除该键，后续没有更新消息时回退为纯文本。规模受会话数限制。
   */
  const lastTrigger = new Map<string, number>();
  /** 群聊护栏：限速、无回应升级、警告后观察模式、操作员静默。 */
  let guard = deps.guard ?? new GroupGuard();
  /** 控制面适配；只有宿主授予端口且 owner 合法时才存在。 */
  let control: QqControl | null = null;
  /** 唤醒限速：@ 洪泛不得无限烧模型预算。 */
  let wakeLimiter = new WakeLimiter();

  /**
   * 钉死 self 身份。显式配置或已钉死时，只接受完全一致的值；未配置时从
   * 首个通过形状校验的事件钉死并记一行警告。对端伪造 self_id 不能改变
   * 「谁是我」，@ 判定与自我过滤都用返回的 effectiveSelfId。
   */
  function resolveSelfId(rawSelfId: unknown, log: (line: string) => void): number | undefined {
    if (configuredSelfId !== undefined) {
      return rawSelfId === configuredSelfId ? configuredSelfId : undefined;
    }
    if (effectiveSelfId !== undefined) {
      return rawSelfId === effectiveSelfId ? effectiveSelfId : undefined;
    }
    if (!isPositiveId(rawSelfId)) return undefined;
    effectiveSelfId = rawSelfId;
    log(SELF_ID_PIN_LOG);
    // 未钉死窗口里丢弃的 notice 只在这里汇总一次，避免逐条刷日志。
    if (unpinnedNoticeCount > 0) {
      log(`qq: dropped ${unpinnedNoticeCount} notice event(s) before self id was pinned`);
      unpinnedNoticeCount = 0;
    }
    return rawSelfId;
  }

  /**
   * 连接状态变化：作为系统事件入队（重要度中），不唤醒。`qq:system` 没有
   * 对应通道，向它发送只会记日志。
   */
  function handleConnectionChange(connected: boolean): void {
    const currentApi = api;
    if (!active || currentApi === null) return;

    currentApi.perception.push({
      kind: 'qq_connection',
      channel: SYSTEM_CHANNEL,
      actor: 'system',
      content: connected ? 'qq 已连接' : 'qq 已断开',
      importance: SYSTEM_IMPORTANCE,
    });
  }

  /**
   * notice 唤醒预算：全局 10 次/分钟 + 每群 1 次/分钟。
   * 两张表都有界：per-group 表固定容量淘汰最早条目，全局表只保留窗口内的
   * 时间戳（长度天然 ≤ 全局上限），轮换群号不能绕过预算或撑爆内存。
   */
  function allowNoticeWake(groupId: string, now: number): boolean {
    while (
      recentNoticeWakes.length > 0 &&
      now - (recentNoticeWakes[0] ?? 0) >= NOTICE_WAKE_WINDOW_MS
    ) {
      recentNoticeWakes.shift();
    }
    if (recentNoticeWakes.length >= NOTICE_WAKE_GLOBAL_MAX) return false;

    const last = lastNoticeWakeAt.get(groupId);
    if (last !== undefined && now - last < NOTICE_WAKE_WINDOW_MS) return false;

    recentNoticeWakes.push(now);
    lastNoticeWakeAt.delete(groupId);
    lastNoticeWakeAt.set(groupId, now);
    while (lastNoticeWakeAt.size > NOTICE_WAKE_CAPACITY) {
      const oldest = lastNoticeWakeAt.keys().next();
      if (oldest.done === true) break;
      lastNoticeWakeAt.delete(oldest.value);
    }
    return true;
  }

  /**
   * notice → 固定枚举 → 护栏副作用 + 感知事件。
   *
   * 正文只由固定模板与已校验的数字群号拼成；对端昵称/备注/操作者字段一律
   * 不进入输出（不变量 16）。映射不到的一律静态日志。
   *
   * notice **不钉死身份**：未配置/尚未从 message 事件钉死 self_id 时只记录。
   * notice 形状未经 `eventShapeError` 校验，让它抢钉身份等于把「谁是我」
   * 交给第一条伪造 notice。丢弃只记一次日志并计数，避免日志洪泛。
   */
  function handleNotice(value: unknown): void {
    const currentApi = api;
    if (!active || currentApi === null) return;

    const selfId = configuredSelfId ?? effectiveSelfId;
    if (selfId === undefined) {
      unpinnedNoticeCount += 1;
      if (!unpinnedNoticeLogged) {
        unpinnedNoticeLogged = true;
        currentApi.log('qq: ignored notice event: self id is not pinned');
      }
      return;
    }

    const action = mapNotice(value, selfId);
    if (action === null) {
      currentApi.log('qq: ignored notice event');
      return;
    }

    // 标准 notice 不带 message_id；用真实字段 + 粗时间桶去重。
    const record = isRecord(value) ? value : null;
    const now = Date.now();
    const dedupeKey = record === null ? null : noticeDedupeKey(record, now);
    if (dedupeKey !== null) {
      if (noticeSeen.has(dedupeKey)) {
        currentApi.log('qq: duplicate notice ignored');
        return;
      }
      noticeSeen.add(dedupeKey);
    }

    if (action.guard === 'warning') guard.recordWarning(action.groupId);
    // 平台解除只清平台造成的观察期，绝不动 owner 的 `#安静`。
    else guard.resumePlatform(action.groupId);

    currentApi.log(`qq: notice ${action.kind} ${action.groupId}`);

    // 控制面显式关闭：notice 只进日志，不入队——`qq:system` 也会烧一次
    // brain 调用与一个会话名额。
    if (noticeLogOnly) return;

    const prefix = currentApi.channelPrefix ?? 'qq';
    const channel =
      noticeOwnerId === undefined ? SYSTEM_CHANNEL : `${prefix}:private:${noticeOwnerId}`;

    currentApi.perception.push({
      kind: 'qq_notice',
      channel,
      actor: 'system',
      content: NOTICE_CONTENT[action.kind](action.groupId),
      importance: action.importance,
    });
    // `qq:system` 不可路由：进队只会白烧一次 brain 调用，因此不唤醒。
    if (action.wake && noticeOwnerId !== undefined && allowNoticeWake(action.groupId, now)) {
      currentApi.perception.requestWake();
    }
  }

  async function handleEvent(value: unknown): Promise<void> {
    const currentApi = api;
    if (!active || currentApi === null) return;

    const shapeError = eventShapeError(value);
    if (shapeError !== null) {
      currentApi.log(`qq: dropped malformed event: ${shapeError}`);
      return;
    }
    // 形状已由 eventShapeError 完整校验。
    const event = value as OneBotMessageEvent;

    // self 身份钉死先于自我过滤与去重：不一致的事件直接丢弃，也不占用
    // 去重窗口（否则伪造事件可以先占掉一个 message_id）。
    const selfId = resolveSelfId(event.self_id, (line) => currentApi.log(line));
    if (selfId === undefined) {
      currentApi.log(SELF_ID_MISMATCH_LOG);
      return;
    }

    const senderId = event.sender.user_id;

    // 自己的消息不进感知；但记住 message_id，供“回复机器人”判定。
    if (senderId === selfId) {
      botMessages.add(event.message_id);
      return;
    }

    const isGroup = event.message_type === 'group';
    const groupId = event.group_id;
    // eventShapeError 已保证群事件带数字 group_id；保留判断用于类型收窄。
    if (isGroup && groupId === undefined) return;

    const groupIdText = groupId === undefined ? '' : String(groupId);
    const senderIdText = String(senderId);

    // owner 判定只是纯读的身份检查，不解析消息内容；真正的控制面拦截
    // 仍在去重之后（见下）。
    const controlAdapter = isGroup ? null : control;
    const isOwnerPrivate = controlAdapter !== null && controlAdapter.isOwner(event);

    // 去重先于解析：同一 message_id 最多执行一次指令（不变量 3）。
    // owner 私聊用保留窗口：500 条普通消息（任何未授权发送者都能制造）不得
    // 把 owner 的 message_id 挤出去，否则一次重投递就能重放控制指令。
    const dedupe = isOwnerPrivate ? ownerSeen : seen;
    if (dedupe.has(event.message_id)) {
      // 重复投递只记一行，不带任何内容。
      currentApi.log('qq: duplicate message_id ignored');
      return;
    }
    dedupe.add(event.message_id);

    // 结构化消息段缺失：回退到 raw_message 正则，只记一次降级日志。
    if (!hasMessageSegments(event) && !segmentsFallbackLogged) {
      segmentsFallbackLogged = true;
      currentApi.log(SEGMENTS_FALLBACK_LOG);
    }

    const canonicalKey = isGroup
      ? `qq:group:${groupIdText}`
      : `qq:private:${senderIdText}`;
    const prefix = currentApi.channelPrefix ?? 'qq';
    const channel = isGroup
      ? `${prefix}:group:${groupIdText}`
      : `${prefix}:private:${senderIdText}`;

    const repliedTo = replyTargetId(event);
    const isReplyToBot = repliedTo !== null && botMessages.has(repliedTo);
    const shouldWake = !isGroup || mentionsSelf(event, selfId) || isReplyToBot;

    const pushed: PushEvent = {
      kind: isGroup ? 'qq_group_message' : 'qq_private_message',
      channel,
      actor: isGroup ? `group:${groupIdText}/${senderIdText}` : `private:${senderIdText}`,
      content: toPlainText(event.raw_message),
      importance: shouldWake ? WAKE_IMPORTANCE : GROUP_IMPORTANCE,
    };

    /** 原路径：静默降级 + 入队 + 记元数据 + 刷新触发 id + 条件唤醒。 */
    const deliver = (): void => {
      let outgoing = pushed;
      let wake = shouldWake;
      // 静默双闸的入站一侧：事件照常入队（不丢），但降 3 且永不唤醒。
      if (isGroup && guard.isSilenced(groupIdText)) {
        outgoing = {
          ...pushed,
          importance: Math.max(0, pushed.importance - SILENCE_IMPORTANCE_DROP),
        };
        wake = false;
      }

      currentApi.perception.push(outgoing);
      // 入站只记元数据：消息正文是不可信数据，不得写进可信日志。
      currentApi.log(
        `qq: event ${outgoing.kind} ${outgoing.channel} importance=${outgoing.importance}`,
      );
      // 每条被接受的群消息都刷新触发 id：回复必须引用最近一条消息，而不是
      // 只有唤醒过的那条（否则 @ 之后来的普通消息会让回复引用过期的 @）。
      if (isGroup) lastTrigger.set(canonicalKey, event.message_id);
      // 限速命中时仍 importance 9 入队，只是不立刻叫醒模型。
      // 只约束群聊：`requestWake` 是边沿触发，私聊（owner 或白名单联系人）
      // 若被限速，追一句可能要等满一个快心跳周期才被看见。
      if (
        wake &&
        (!isGroup || wakeLimiter.allow(channel, senderIdText, channel))
      ) {
        currentApi.perception.requestWake();
      }
    };

    // 控制面拦截在 isAllowed 之前：owner 私聊绕过 QQ_PRIVATE_ALLOWLIST，
    // 但不绕过 QQ_PRIVATE_DENYLIST（后者已在 isOwner 里判定）。
    // handled/deferred 的消息不入队、不唤醒、不占会话名额。
    if (isOwnerPrivate && controlAdapter !== null) {
      const outcome = await controlAdapter.handle(event, deliver);
      if (outcome.action === 'handled') return;
      if (outcome.action === 'deferred') return;
      // chat：owner 私聊照常入队，且不受私聊白名单限制。
      deliver();
      return;
    }

    const actor = isGroup
      ? { group: groupIdText, userId: senderIdText }
      : { userId: senderIdText };
    if (!isAllowed(actor, lists)) return;

    // 他人发言即视为“有回应”（限发言后 5 分钟内，D5）：重置该群冷却（含
    // 翻倍后的间隔）。只对首次见到、且通过名单的群消息生效——重复投递不能
    // 清零冷却，未激活的群也不应产生护栏状态。
    if (isGroup) guard.recordResponse(groupIdText);

    deliver();
  }

  return {
    /** 宿主在 activate 前询问：配置关闭时状态应为 stopped，而不是 failed。 */
    enabled() {
      // 没有注入门面时保持「启用」，让 activate 抛出真正的配置错误（failed）。
      return deps.config === undefined ? true : deps.config.get().qq.enabled;
    },

    async activate(injected) {
      if (active) return;

      // 配置只来自注入的门面：每次激活按次读取，host.reload 后立即看到新值。
      // 插件绝不回退去读 process.env 的 QQ_*（迁移只由 HarnessStore 做一次）。
      const configHandle = deps.config;
      if (configHandle === undefined) {
        throw new Error('qq channel: runtime config handle is required');
      }
      const config = readConfig(configHandle.get().qq);
      if (!config.enabled) {
        throw new Error('qq channel: qq.enabled is false');
      }

      const nextServer: QqServerLike =
        deps.server ??
        new QqServer({
          port: config.port,
          host: config.host,
          token: config.token,
          onEvent: handleEvent,
          onNotice: handleNotice,
          onConnectionChange: handleConnectionChange,
          log: (line) => injected.log(line),
        });
      if (deps.server !== undefined) {
        (nextServer as InjectableQqServer).setOnEvent?.(handleEvent);
        (nextServer as InjectableQqServer).setOnNotice?.(handleNotice);
        (nextServer as InjectableQqServer).setOnConnectionChange?.(handleConnectionChange);
      }

      api = injected;
      lists = config.lists;
      // 默认护栏读配置的最小间隔；注入的护栏由装配点持有并跨重载复用。
      // 传 getter 而不是数值：热改 qq.minReplyGapMs 后下一次 allow() 即生效。
      if (deps.guard === undefined) {
        guard = new GroupGuard({ minGapMs: () => configHandle.get().qq.minReplyGapMs });
      }
      configuredSelfId = config.selfId;
      effectiveSelfId = config.selfId;
      wakeLimiter = new WakeLimiter();
      segmentsFallbackLogged = false;

      // owner 与私聊黑名单只归一化一次：控制面判定、普通入站与 notice
      // 目标都使用同一份值（N3）。
      ownerId = config.ownerId;
      const denylist = config.lists.privateDenylist;
      const ownerDenied = ownerId !== undefined && denylist.has(String(ownerId));
      // 总开关直接来自配置；未配置 owner 时即便开关为开也静默禁用。
      const controlRequested = config.controlEnabled;
      // 「配置为关闭」且确实有 owner 才让 notice 变成 log-only；没有 owner
      // 的安装仍按 spec 退回 qq:system 记录（不可路由），与旧行为一致。
      noticeLogOnly = ownerId !== undefined && !config.controlEnabled;
      // notice 与控制面共用同一个开关：控制面关闭时不私聊 owner、不唤醒，
      // notice 仍作为 `qq:system` 事件记录（不可路由，仅记录）。
      noticeOwnerId =
        ownerId !== undefined && !ownerDenied && controlRequested ? ownerId : undefined;

      // 控制面：端口必须由宿主显式授予。qq.ownerId 缺失/非法或命中私聊
      // 黑名单时只禁用控制面并记一行日志，渠道照常工作（不变量 19）。
      control = null;
      const controlPort = injected.control;
      if (controlPort !== undefined) {
        if (controlRequested) {
          if (ownerId === undefined) {
            injected.log('qq: control plane disabled: qq.ownerId is missing or invalid');
          } else if (ownerDenied) {
            injected.log('qq: control plane disabled: owner is in qq.privateDenylist');
          } else {
            control = createQqControl({
              ownerId: String(ownerId),
              denylist,
              port: controlPort,
              send: (channel, text) => injected.send(channel, text),
              log: (line) => injected.log(line),
              channelPrefix: injected.channelPrefix ?? 'qq',
              nlEnabled: config.controlNl,
              nlMinConfidence: config.nlMinConfidence,
            });
          }
        }
      }

      try {
        await nextServer.start();
      } catch (error) {
        api = null;
        control = null;
        ownerId = undefined;
        noticeOwnerId = undefined;
        noticeLogOnly = false;
        unpinnedNoticeCount = 0;
        unpinnedNoticeLogged = false;
        throw error;
      }
      server = nextServer;
      active = true;
    },

    async deactivate() {
      if (!active) return;
      // 先发布断开状态：`QqServer.stop()` 在 close 之前把 socket 置空，不会再
      // 触发 onConnectionChange(false)。不补这一条，装配点的
      // `connection.connected` 会在重载后一直停在 true——状态页谎报在线、
      // 主动私聊闸打开、离线审批回执被立即发送后失败。
      handleConnectionChange(false);
      active = false;
      const current = server;
      server = null;
      api = null;
      seen.clear();
      ownerSeen.clear();
      noticeSeen.clear();
      lastNoticeWakeAt.clear();
      recentNoticeWakes.length = 0;
      botMessages.clear();
      lastTrigger.clear();
      lists = emptyLists();
      control = null;
      guard = deps.guard ?? new GroupGuard();
      configuredSelfId = undefined;
      effectiveSelfId = undefined;
      ownerId = undefined;
      noticeOwnerId = undefined;
      noticeLogOnly = false;
      unpinnedNoticeCount = 0;
      unpinnedNoticeLogged = false;
      segmentsFallbackLogged = false;
      wakeLimiter = new WakeLimiter();
      if (current !== null) await current.stop();
    },

    async send(conversationKey, text) {
      const current = server;
      if (!active || current === null) {
        throw new Error('qq plugin: send() before activate()');
      }

      // 系统会话键只用于感知事件，没有可路由的通道。
      if (conversationKey === SYSTEM_CHANNEL) {
        api?.log('qq: system channel is not routable');
        return;
      }

      const target = parseConversationKey(conversationKey);
      if (target === null) {
        throw new Error(`qq plugin: invalid conversation key: ${conversationKey}`);
      }

      if (target.kind === 'group') {
        const groupId = String(target.id);
        const decision = guard.allow(groupId);
        if (!decision.ok) {
          // 拟人选择：这条回复直接丢弃（事件已在感知层消费），不是数据丢失。
          api?.log(`qq: guard blocked group ${groupId}: ${decision.reason}`);
          return;
        }

        const replyTo = lastTrigger.get(conversationKey);
        const message =
          replyTo === undefined
            ? text
            : [
                { type: 'reply', data: { id: String(replyTo) } },
                { type: 'text', data: { text } },
              ];
        try {
          const data = await current.call('send_group_msg', {
            group_id: target.id,
            message,
          });
          rememberMessageId(botMessages, data);
          guard.recordSpoken(groupId);
          // 已引用过这条消息：下一次发送若没有更新的消息，回退为纯文本。
          lastTrigger.delete(conversationKey);
          api?.log(`qq: sent ${conversationKey}`);
        } catch (error) {
          // 失败也算“说过话”：计入护栏冷却（spec 发送失败条款），但不向
          // 调用方抛错——单个会话发送失败不得中断整批出站。
          api?.log(`qq: send failed: ${describeError(error)}`);
          guard.recordSpoken(groupId);
        }
        return;
      }

      try {
        // 数组形式（而非 CQ 码字符串）：回复文本里的 [CQ:...] 保持字面量，
        // 与群消息路径一致。
        const data = await current.call('send_private_msg', {
          user_id: target.id,
          message: [{ type: 'text', data: { text } }],
        });
        rememberMessageId(botMessages, data);
        api?.log(`qq: sent ${conversationKey}`);
      } catch (error) {
        api?.log(`qq: send failed: ${describeError(error)}`);
      }
    },
  };
}
