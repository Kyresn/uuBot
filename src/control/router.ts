/**
 * 控制面的唯一入口：`handleOwnerText(text, origin)`。
 *
 * - 前缀指令同步执行（或生成审批）；自然语言只用于**没有 `#` 开头**的
 *   owner 私聊，且只能推断 auto 级意图。
 * - 有副作用的自然语言意图生成一条 `control.command` 审批（TTL 60s），
 *   owner 必须用显式 `ap_` id 确认；前缀同义动作直接执行。
 * - `executeApproved(record)` 是 `control.command` 审批的 Applier 入口：
 *   它自己白名单意图（不变量 10），绝不重新进入 router，因此不会产生新审批。
 */
import type { ApplierOutcome } from '../approvals/appliers.js';
import type { DecideResult, ListFilter, ProposeResult } from '../approvals/service.js';
import type {
  ApprovalPayload,
  ApprovalRecord,
  DecisionChannel,
} from '../approvals/types.js';
import type { ControlAuditSink } from './audit-log.js';
import { sanitizeForTty, stripUnsafeControls } from '../util/tty.js';
import type { CommandName, ParsedCommand } from './grammar.js';
import { parseCommand } from './grammar.js';
import {
  INTENT_SPECS,
  SIDE_EFFECT_INTENTS,
  classifyIntent,
  type BrainLike,
} from './intents.js';
import type { ControlState } from './state-store.js';
import type { ControlStatusSnapshot } from './status.js';
import {
  COMMAND_ERROR_TEXT,
  type ControlInput,
  type ControlOrigin,
  type ControlOutcome,
  type ControlPort,
  type ControlReply,
  type IntentName,
} from './types.js';

/** 审批服务的结构子集；T2 不构造实例，只消费 T1 的接口。 */
export interface ApprovalServiceLike {
  propose(
    payload: ApprovalPayload,
    meta: { createdVia: DecisionChannel; createdBy: string },
  ): Promise<ProposeResult>;
  decide(
    id: string,
    decision: {
      decision: 'approve' | 'deny';
      via: DecisionChannel;
      by: string;
      reason?: string;
    },
  ): Promise<DecideResult>;
  list(filter?: ListFilter): ApprovalRecord[];
  get(id: string): ApprovalRecord | undefined;
}

/** T3 的 `GroupGuard` 结构子集。 */
export interface GuardControl {
  silence(groupId: string, untilMs: number): void;
  resume(groupId?: string): void;
}

/** 能力注册表的结构子集；`requestActivation` 由 T5 的适配器提供。 */
export interface CapabilityControl {
  status(): ReadonlyArray<{ name: string; state: string }>;
  ban(name: string): Promise<void>;
  unban(name: string): Promise<void>;
  /** 生成一条 `capability.activate` 审批；未接线时省略。 */
  requestActivation?(
    name: string,
    meta?: { createdVia: DecisionChannel; createdBy: string },
  ): Promise<{ ok: true; id: string } | { ok: false; code: string }>;
}

/** `ControlStateStore` 的结构子集，便于测试注入。 */
export interface ControlStateLike {
  setGroupSilencedUntil(groupId: string, until: number | undefined): Promise<void>;
  clearGroup(groupId: string): Promise<void>;
  snapshot(): ControlState;
}

export interface ControlRouterDeps {
  approvals: ApprovalServiceLike;
  state?: ControlStateLike;
  guard?: GuardControl;
  capabilities?: CapabilityControl;
  /** 与 `GET /api/control` 共用同一份快照构造器；缺省时 `#状态` 回固定文本。 */
  status?: () => ControlStatusSnapshot;
  brain?: BrainLike;
  now?: () => number;
  log?: (line: string) => void;
  /** 分类器阈值与超时；默认 0.75 / 3000ms。 */
  nl?: { minConfidence?: number; timeoutMs?: number };
  /** NL 的群目标校验；T5 从 QQ 群白名单/护栏接线。缺省不校验。 */
  isKnownGroup?: (groupId: string) => boolean;
  /** 审计流水：每条已处理的指令一行；缺省不记录。 */
  audit?: ControlAuditSink;
}

export interface ControlRouter {
  handleOwnerText(
    text: string,
    origin: ControlOrigin,
    opts?: { minConfidence?: number },
  ): Promise<ControlReply>;
  /** `control.command` 的 Applier：只执行 4 个 auto 级副作用意图。 */
  executeApproved(record: ApprovalRecord): Promise<ApplierOutcome>;
}

export interface ControlPortOptions {
  /** 由 T5 注入；未接线时端口仍会把控制消息挡在队列之外。 */
  getRouter: () => ControlRouter | null;
  log?: (line: string) => void;
  unavailableText?: string;
}

const HELP_TEXT = [
  '控制指令：',
  '#帮助 / #help — 本帮助',
  '#状态 / #status — 运行状态',
  '#审批 [id] / #approvals — 待审批列表',
  '#同意 <id> / #approve — 批准',
  '#拒绝 <id> [理由] / #deny — 拒绝',
  '#封禁 <插件> / #ban — 封禁能力插件',
  '#解封 <插件> / #unban — 解封并生成激活审批',
  '#安静 [群号] <分钟> / #quiet — 静默（无群号=全局，0=解除）',
  '#恢复 [群号] / #resume — 恢复',
  '确认 <id> — 批准一条控制指令审批',
].join('\n');

const DEFAULT_UNAVAILABLE = '控制面尚未启用。';
const MAX_FIELD_LENGTH = 64;
const MAX_DETAIL_LENGTH = 200;
const MAX_LOG_DETAIL = 200;
/** 单条回执最多列出的待审批条数；其余只给计数，避免一次 DM 过长。 */
const MAX_LIST_ENTRIES = 20;

/** §4 的 8 个意图名；Applier 的意图白名单必须与 `IntentName` 同步。 */
const INTENT_NAMES: ReadonlySet<string> = new Set<IntentName>([
  'help.read',
  'status.read',
  'approval.list',
  'approval.decide',
  'capability.ban',
  'capability.unban',
  'group.silence',
  'group.resume',
]);

function isIntentName(value: string): value is IntentName {
  return INTENT_NAMES.has(value);
}

/** 单行化 + 净化 + 限长；按码点截断，绝不劈开代理对。 */
function safeField(value: string, limit = MAX_FIELD_LENGTH): string {
  const cleaned = stripUnsafeControls(value).replace(/[\r\n]+/g, ' ').trim();
  const points = [...cleaned];
  return points.length > limit ? `${points.slice(0, limit).join('')}...` : cleaned;
}

function safeLogDetail(value: string): string {
  return sanitizeForTty(value, '').replace(/[\r\n]+/g, ' ').slice(0, MAX_LOG_DETAIL);
}

function renderPairs(entries: ReadonlyArray<{ name: string; state: string }>): string {
  if (entries.length === 0) return '无';
  return entries
    .map((entry) => `${safeField(entry.name)}=${safeField(entry.state, 24)}`)
    .join('、');
}

function renderStatus(snapshot: ControlStatusSnapshot | null): string {
  if (snapshot === null) return '状态不可用。';

  const quiet = snapshot.quiet.active
    ? `全局静默至 ${safeField(snapshot.quiet.until ?? '', 40)}`
    : '无';
  const groups =
    snapshot.groups.length === 0
      ? '无'
      : snapshot.groups
          .map(
            (group) =>
              `${safeField(group.groupId, 20)} 至 ${safeField(group.silencedUntil, 40)}`,
          )
          .join('、');
  // 平台派生的观察期与 owner 的静默分开显示（N-6）：前者来自禁言/踢出，
  // 后者来自 `#安静`，两者的撤销路径不同。
  const observing =
    snapshot.observing.length === 0
      ? '无'
      : snapshot.observing
          .map(
            (group) =>
              `${safeField(group.groupId, 20)} 至 ${safeField(group.observingUntil, 40)}`,
          )
          .join('、');
  const endpoints =
    snapshot.endpoints.length === 0
      ? '无'
      : snapshot.endpoints
          .map(
            (endpoint) =>
              `${safeField(endpoint.name)}=${endpoint.degraded ? '降级' : '正常'}`,
          )
          .join('、');

  return [
    '状态：',
    `- 心跳：静默 ${snapshot.heartbeat.silentRounds} 轮，进行中=${
      snapshot.heartbeat.inFlight ? '是' : '否'
    }，下次快心跳 ${snapshot.heartbeat.nextFastMs}ms`,
    `- 队列：${snapshot.queueSize} 条`,
    `- 待审批：${snapshot.approvals.pending} 条`,
    `- 插件：${renderPairs(snapshot.plugins)}`,
    `- 能力插件：${renderPairs(snapshot.capabilities)}`,
    `- 端点：${endpoints}`,
    `- 静默：${quiet}；群：${groups}`,
    `- 观察（平台）：${observing}`,
  ].join('\n');
}

function renderApprovalList(
  service: ApprovalServiceLike,
  id: string | undefined,
): string {
  if (id !== undefined) {
    const safeId = safeField(id, 64);
    const record = service.get(id);
    if (record === undefined) return `未找到审批 ${safeId}。`;
    return `${safeId} [${safeField(record.status, 24)}] ${safeField(record.title, 120)}`;
  }

  const pending = service.list({ status: 'pending' });
  if (pending.length === 0) return '没有待审批。';

  const shown = pending.slice(0, MAX_LIST_ENTRIES);
  const lines = [
    `待审批 ${pending.length} 条：`,
    ...shown.map(
      (record) => `- ${safeField(record.id, 64)} ${safeField(record.title, 120)}`,
    ),
  ];
  if (pending.length > shown.length) {
    lines.push(`…还有 ${pending.length - shown.length} 条未列出。`);
  }
  return lines.join('\n');
}

function mapCommand(
  name: CommandName,
  args: readonly string[],
):
  | { intent: IntentName; candidate: Record<string, unknown> }
  | { usage: string } {
  const arg = (index: number): string | undefined => args[index];

  switch (name) {
    case 'help':
      if (args.length !== 0) return { usage: '用法：#帮助' };
      return { intent: 'help.read', candidate: {} };
    case 'status':
      if (args.length !== 0) return { usage: '用法：#状态' };
      return { intent: 'status.read', candidate: {} };
    case 'approvals': {
      if (args.length > 1) return { usage: '用法：#审批 [id]' };
      const id = arg(0);
      return {
        intent: 'approval.list',
        candidate: id === undefined ? {} : { id },
      };
    }
    case 'approve':
    case 'confirm': {
      if (args.length !== 1) return { usage: '用法：#同意 <id>' };
      return {
        intent: 'approval.decide',
        candidate: { id: arg(0), decision: 'approve' },
      };
    }
    case 'deny': {
      if (args.length < 1) return { usage: '用法：#拒绝 <id> [理由]' };
      const reason = args.slice(1).join(' ');
      return {
        intent: 'approval.decide',
        candidate: {
          id: arg(0),
          decision: 'deny',
          ...(reason === '' ? {} : { reason }),
        },
      };
    }
    case 'ban':
    case 'unban': {
      if (args.length !== 1) return { usage: `用法：#${name} <能力插件>` };
      return {
        intent: name === 'ban' ? 'capability.ban' : 'capability.unban',
        candidate: { plugin: arg(0) },
      };
    }
    case 'quiet': {
      if (args.length === 0 || args.length > 2) {
        return { usage: '用法：#安静 [群号] <分钟>' };
      }
      if (args.length === 1) {
        return { intent: 'group.silence', candidate: { minutes: arg(0) } };
      }
      return {
        intent: 'group.silence',
        candidate: { group: arg(0), minutes: arg(1) },
      };
    }
    case 'resume': {
      if (args.length > 1) return { usage: '用法：#恢复 [群号]' };
      const group = arg(0);
      return {
        intent: 'group.resume',
        candidate: group === undefined ? {} : { group },
      };
    }
  }
}

type SideEffectResult =
  | { ok: true; text: string; approvalId?: string }
  | {
      ok: false;
      code: 'not_found' | 'not_implemented' | 'invalid_body' | 'conflict';
      text: string;
    };

class Router implements ControlRouter {
  private readonly deps: ControlRouterDeps;
  private readonly now: () => number;

  constructor(deps: ControlRouterDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  async handleOwnerText(
    text: string,
    origin: ControlOrigin,
    opts: { minConfidence?: number } = {},
  ): Promise<ControlReply> {
    const parsed: ParsedCommand | null = parseCommand(text);
    if (parsed === null) return this.handleNaturalLanguage(text, origin, opts);

    if (parsed.kind === 'usage') {
      this.auditCommand(origin, text, 'none', 'usage');
      return { text: `${parsed.reason}\n${HELP_TEXT}`, handled: true };
    }

    const mapped = mapCommand(parsed.name, parsed.args);
    if ('usage' in mapped) {
      this.auditCommand(origin, text, 'none', 'usage');
      return { text: `${mapped.usage}\n${HELP_TEXT}`, handled: true };
    }

    const spec = INTENT_SPECS[mapped.intent];
    const validated = spec.parse(mapped.candidate);
    if (!validated.ok) {
      this.auditCommand(origin, text, mapped.intent, 'usage');
      return { text: `${validated.reason}\n${HELP_TEXT}`, handled: true };
    }

    try {
      return await this.executeIntent(mapped.intent, validated.args, origin, text);
    } catch (error) {
      // 控制面故障只回一条固定格式的错误，不冒泡成「聊天」。
      this.deps.log?.(`control: command failed: ${safeLogDetail(String(error))}`);
      this.auditCommand(origin, text, mapped.intent, 'error');
      const detail =
        error instanceof Error ? safeField(error.message, MAX_DETAIL_LENGTH) : 'unknown';
      return { text: `指令执行失败：${detail}`, handled: true };
    }
  }

  /**
   * 自然语言：分类器命中 auto 级副作用意图 → 生成 `control.command` 审批；
   * 只读意图直接执行；其余一律交回通道按聊天处理。
   */
  private async handleNaturalLanguage(
    text: string,
    origin: ControlOrigin,
    opts: { minConfidence?: number },
  ): Promise<ControlReply> {
    // 自然语言只属于 owner 的 QQ 私聊（spec §4）。网页走显式前缀指令：
    // 否则会生成一条网页永远无法决策的 control.command（R3）。
    if (origin.channel !== 'qq') return { text: '', handled: false };
    if (this.deps.brain === undefined) return { text: '', handled: false };

    const minConfidence = opts.minConfidence ?? this.deps.nl?.minConfidence;
    const classified = await classifyIntent(text, this.deps.brain, {
      ...(minConfidence === undefined ? {} : { minConfidence }),
      ...(this.deps.nl?.timeoutMs === undefined ? {} : { timeoutMs: this.deps.nl.timeoutMs }),
      log: (line) => this.deps.log?.(line),
      // 没有注册表就没有「已知插件」：NL 不得对未知目标提案。
      isKnownPlugin: (name: string) =>
        this.deps.capabilities?.status().some((entry) => entry.name === name) === true,
      ...(this.deps.isKnownGroup === undefined
        ? {}
        : { isKnownGroup: this.deps.isKnownGroup }),
    });

    if (classified.intent === 'none') return { text: '', handled: false };

    if (SIDE_EFFECT_INTENTS.has(classified.intent)) {
      const proposed = await this.deps.approvals.propose(
        { kind: 'control.command', intent: classified.intent, args: classified.args },
        { createdVia: origin.channel, createdBy: origin.actor },
      );
      if (!proposed.ok) {
        this.auditCommand(origin, text, classified.intent, 'error');
        return { text: `控制指令未能生成审批（${proposed.code}）。`, handled: true };
      }
      this.auditCommand(origin, text, classified.intent, 'handled', proposed.record.id);
      return {
        text: `回复「确认 ${safeField(proposed.record.id, 64)}」执行。`,
        handled: true,
      };
    }

    return this.executeIntent(classified.intent, classified.args, origin, text);
  }

  /** 记录一条指令；审计失败只记日志，绝不影响控制面。 */
  private auditCommand(
    origin: ControlOrigin,
    command: string,
    intent: IntentName | 'none',
    result: 'handled' | 'chat' | 'usage' | 'error',
    approvalId?: string,
  ): void {
    try {
      this.deps.audit?.record({
        ts: new Date(this.now()).toISOString(),
        event: 'command',
        via: origin.channel,
        actor: origin.actor,
        command: safeField(command, MAX_DETAIL_LENGTH),
        intent,
        result,
        ...(approvalId === undefined ? {} : { approvalId }),
      });
    } catch (error) {
      this.deps.log?.(`control: audit failed: ${safeLogDetail(String(error))}`);
    }
  }

  /** 执行意图并记录审计行；`command` 是 owner 的原始输入。 */
  private async executeIntent(
    intent: IntentName,
    args: Record<string, string | number>,
    origin: ControlOrigin,
    command: string,
  ): Promise<ControlReply> {
    const { reply, approvalId } = await this.dispatchIntent(intent, args, origin);
    this.auditCommand(origin, command, intent, reply.handled ? 'handled' : 'chat', approvalId);
    return reply;
  }

  private async dispatchIntent(
    intent: IntentName,
    args: Record<string, string | number>,
    origin: ControlOrigin,
  ): Promise<{ reply: ControlReply; approvalId?: string }> {
    switch (intent) {
      case 'help.read':
        return { reply: { text: HELP_TEXT, handled: true } };
      case 'status.read':
        return {
          reply: {
            text: renderStatus(this.deps.status === undefined ? null : this.deps.status()),
            handled: true,
          },
        };
      case 'approval.list':
        return {
          reply: {
            text: renderApprovalList(
              this.deps.approvals,
              typeof args['id'] === 'string' ? args['id'] : undefined,
            ),
            handled: true,
          },
        };
      case 'approval.decide':
        return { reply: await this.decide(args, origin) };
      case 'capability.ban':
      case 'capability.unban':
      case 'group.silence':
      case 'group.resume': {
        const result = await this.runSideEffect(intent, args, origin);
        return {
          reply: { text: result.text, handled: true },
          ...(result.ok && result.approvalId !== undefined
            ? { approvalId: result.approvalId }
            : {}),
        };
      }
    }
  }

  private async decide(
    args: Record<string, string | number>,
    origin: ControlOrigin,
  ): Promise<ControlReply> {
    const id = String(args['id'] ?? '');
    const safeId = safeField(id, 64);
    const decision = args['decision'] === 'deny' ? 'deny' : 'approve';
    const reason = typeof args['reason'] === 'string' ? args['reason'] : undefined;

    const result = await this.deps.approvals.decide(id, {
      decision,
      via: origin.channel,
      by: origin.actor,
      ...(reason === undefined ? {} : { reason }),
    });

    if (!result.ok) {
      switch (result.code) {
        case 'not_found':
          return { text: `未找到审批 ${safeId}。`, handled: true };
        case 'not_pending':
          return {
            text: `审批 ${safeId} 已处理（${safeField(result.record?.status ?? 'unknown', 24)}）。`,
            handled: true,
          };
        case 'expired':
          return { text: `审批 ${safeId} 已过期。`, handled: true };
        case 'wrong_channel':
          return { text: `审批 ${safeId} 只能由发起它的 QQ 私聊处理。`, handled: true };
        case 'stale':
          return { text: `审批 ${safeId} 已失效（内容已变化）。`, handled: true };
        case 'conflict':
          return { text: `审批 ${safeId} 处理冲突，请稍后查看状态。`, handled: true };
        case 'invalid_body':
          return { text: `审批 ${safeId} 的决策无效。`, handled: true };
        default:
          return { text: `审批 ${safeId} 未能处理（${result.code}）。`, handled: true };
      }
    }

    if (decision === 'deny') return { text: `已拒绝 ${safeId}。`, handled: true };

    const execution = result.record.execution;
    if (execution?.state === 'failed') {
      const detail = safeField(execution.error ?? 'unknown', MAX_DETAIL_LENGTH);
      // 超时只代表「我们停止等待」，不代表动作没有发生。
      if (execution.error === 'timeout') {
        return {
          text: `已批准 ${safeId}；执行结果未确认（等待超时，动作可能已发生）。`,
          handled: true,
        };
      }
      return { text: `已批准 ${safeId}，但执行失败：${detail}`, handled: true };
    }
    return { text: `已批准 ${safeId}。`, handled: true };
  }

  private async runSideEffect(
    intent: IntentName,
    args: Record<string, string | number>,
    origin?: ControlOrigin,
  ): Promise<SideEffectResult> {
    switch (intent) {
      case 'capability.ban': {
        const plugin = String(args['plugin'] ?? '');
        const capabilities = this.deps.capabilities;
        if (capabilities === undefined) {
          return { ok: false, code: 'not_implemented', text: '能力注册表未接线。' };
        }
        const known = capabilities.status().some((entry) => entry.name === plugin);
        if (!known) {
          return {
            ok: false,
            code: 'not_found',
            text: `未知插件 ${safeField(plugin)}（渠道插件不在封禁范围）。`,
          };
        }
        await capabilities.ban(plugin);
        return { ok: true, text: `已封禁 ${safeField(plugin)}。` };
      }
      case 'capability.unban': {
        const plugin = String(args['plugin'] ?? '');
        const capabilities = this.deps.capabilities;
        if (capabilities === undefined) {
          return { ok: false, code: 'not_implemented', text: '能力注册表未接线。' };
        }
        const known = capabilities.status().some((entry) => entry.name === plugin);
        if (!known) {
          return {
            ok: false,
            code: 'not_found',
            text: `未知插件 ${safeField(plugin)}（渠道插件不在封禁范围）。`,
          };
        }
        await capabilities.unban(plugin);
        const proposed =
          capabilities.requestActivation === undefined
            ? undefined
            : await capabilities.requestActivation(
                plugin,
                origin === undefined
                  ? undefined
                  : { createdVia: origin.channel, createdBy: origin.actor },
              );
        if (proposed === undefined) {
          // 解封本身成功了，但 spec 要求的激活审批没有生成：如实回报，
          // 并让 Applier 记为失败，不能把「未生成」当成执行完成。
          return {
            ok: false,
            code: 'not_implemented',
            text: `已解封 ${safeField(plugin)}，但未生成激活审批。`,
          };
        }
        if (!proposed.ok) {
          return {
            ok: false,
            code: 'conflict',
            text: `已解封 ${safeField(plugin)}；激活审批生成失败（${safeField(
              proposed.code,
              40,
            )}）。`,
          };
        }
        const approvalId = safeField(proposed.id, 64);
        return {
          ok: true,
          text: `已解封 ${safeField(plugin)}；激活审批 ${approvalId}（回复「#同意 ${approvalId}」批准）。`,
          approvalId: proposed.id,
        };
      }
      case 'group.silence': {
        const minutes = Number(args['minutes'] ?? 0);
        const group = typeof args['group'] === 'string' ? args['group'] : '*';
        if (minutes === 0) return this.resumeGroup(group);
        if (this.deps.guard === undefined) {
          return { ok: false, code: 'not_implemented', text: '运行闸门未接线。' };
        }
        const until = this.now() + minutes * 60_000;
        this.deps.guard.silence(group, until);
        await this.deps.state?.setGroupSilencedUntil(group, until);
        return {
          ok: true,
          text:
            group === '*'
              ? `已全局静默 ${minutes} 分钟。`
              : `已静默群 ${safeField(group, 20)} ${minutes} 分钟。`,
        };
      }
      case 'group.resume': {
        const group = typeof args['group'] === 'string' ? args['group'] : '*';
        return this.resumeGroup(group);
      }
      default:
        return { ok: false, code: 'invalid_body', text: '该意图不能作为控制指令执行。' };
    }
  }

  private async resumeGroup(group: string): Promise<SideEffectResult> {
    this.deps.guard?.resume(group === '*' ? undefined : group);
    await this.deps.state?.clearGroup(group);
    return {
      ok: true,
      text: group === '*' ? '已恢复全局。' : `已恢复群 ${safeField(group, 20)}。`,
    };
  }

  /**
   * `control.command` 的 Applier。意图白名单在**这里**再判一次：载荷校验
   * 只保证 intent 是 8 个之一，不保证它能在当前上下文执行。
   */
  async executeApproved(record: ApprovalRecord): Promise<ApplierOutcome> {
    const payload = record.payload;
    if (payload.kind !== 'control.command') {
      return { ok: false, code: 'invalid_body', error: 'not a control command' };
    }
    if (!isIntentName(payload.intent) || !SIDE_EFFECT_INTENTS.has(payload.intent)) {
      return { ok: false, code: 'invalid_body', error: 'intent not executable' };
    }

    const spec = INTENT_SPECS[payload.intent];
    const validated = spec.parse(payload.args);
    if (!validated.ok) {
      return { ok: false, code: 'invalid_body', error: validated.reason };
    }

    const result = await this.runSideEffect(payload.intent, validated.args, {
      channel: record.createdVia,
      actor: record.createdBy,
    });
    if (result.ok) return { ok: true };
    return { ok: false, code: result.code, error: result.text };
  }
}

export function createControlRouter(deps: ControlRouterDeps): ControlRouter {
  return new Router(deps);
}

/**
 * 通道侧的控制端口：只决定「这条消息是不是控制面的事」以及何时把消息
 * 交还通道。前缀指令同步执行；NL 候选立即返回 `deferred`，分类完成后再
 * 决定回执还是 `deliver()`，不阻塞 ws 事件处理。
 */
export function createControlPort(opts: ControlPortOptions): ControlPort {
  const log = opts.log ?? (() => undefined);
  const unavailable = opts.unavailableText ?? DEFAULT_UNAVAILABLE;

  const replySafely = async (input: ControlInput, text: string): Promise<void> => {
    if (text === '') return;
    try {
      await input.reply(text);
    } catch (error) {
      log(`control: reply failed: ${safeLogDetail(String(error))}`);
    }
  };

  return {
    async handle(input: ControlInput): Promise<ControlOutcome> {
      const router = opts.getRouter();
      const parsed = parseCommand(input.text);

      if (parsed !== null) {
        if (router === null) {
          await replySafely(input, unavailable);
          return { action: 'handled' };
        }
        try {
          const reply = await router.handleOwnerText(input.text, {
            channel: 'qq',
            actor: `private:${input.userId}`,
          });
          await replySafely(input, reply.text);
          return { action: 'handled' };
        } catch (error) {
          // 已识别为控制指令：失败也必须回执并保持 handled，
          // 绝不能落进感知队列或模型上下文（不变量 2）。
          log(`control: handler failed: ${safeLogDetail(String(error))}`);
          await replySafely(input, COMMAND_ERROR_TEXT);
          return { action: 'handled' };
        }
      }

      if (input.nlEnabled !== true || router === null) return { action: 'chat' };

      let delivered = false;
      const deliverOnce = (): void => {
        if (delivered) return;
        delivered = true;
        input.deliver();
      };

      void (async () => {
        try {
          const reply = await router.handleOwnerText(
            input.text,
            { channel: 'qq', actor: `private:${input.userId}` },
            input.nlMinConfidence === undefined
              ? {}
              : { minConfidence: input.nlMinConfidence },
          );
          if (reply.handled) await replySafely(input, reply.text);
          else deliverOnce();
        } catch (error) {
          // 从未被识别为指令的文本：分类失败就按聊天处理。
          log(`control: classifier failed: ${safeLogDetail(String(error))}`);
          deliverOnce();
        }
      })();

      return { action: 'deferred', deliver: deliverOnce };
    },
  };
}
