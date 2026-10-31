/**
 * 网页控制面 API：`GET /api/approvals`、`POST /api/approvals/decide`、
 * `GET /api/control`、`POST /api/control/command`（spec §8）。
 *
 * 安全不变量（14、21）：
 * - 决策只有 POST；路由表里没有 GET 决策，写闸只覆盖非 GET。
 * - `ApprovalView` 是投影：不含指纹、不含 manifest 原文；`summary` 从
 *   payload 服务端重渲染，不可信字段过 `stripUnsafeControls` 并截断。
 * - `control.command` 只能由发起它的 QQ 私聊决策；这里永远以 `via:'web'`
 *   调用服务，服务返回 `wrong_channel`，本模块不改状态。
 * - 未知 id 回 200 `not_found`，不把 id 空间变成探测 oracle。
 * - 控制面异常只降级本页（503 + 稳定错误码），绝不冒泡到心跳。
 */
import type { DecideResult, ListFilter } from '../approvals/service.js';
import type {
  ApprovalKind,
  ApprovalPayload,
  ApprovalRecord,
  ApprovalStatus,
  DecisionChannel,
  RiskTier,
} from '../approvals/types.js';
import { parseCommand, type CommandName } from '../control/grammar.js';
import type { ControlRouter } from '../control/router.js';
import type { ControlStatusSnapshot } from '../control/status.js';
import type { IntentName } from '../control/types.js';
import { stripUnsafeControls } from '../util/tty.js';
import type { RouteHandler } from './server.js';

/** 列表默认条数与上限；`?limit=1..100`。 */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
/** 不可信展示字段的截断上限（spec §8）。 */
const MAX_FIELD_LENGTH = 200;
/** 请求体里 id 的最大长度：完整 id 是 `ap_` + 32 hex。 */
const MAX_ID_LENGTH = 64;

const APPROVAL_KINDS: ReadonlySet<string> = new Set<ApprovalKind>([
  'capability.activate',
  'control.command',
  'persona.change',
  'skill.change',
  'mcp.change',
  'cli.exec',
]);

const APPROVAL_STATUSES: ReadonlySet<string> = new Set<ApprovalStatus>([
  'pending',
  'approved',
  'denied',
  'expired',
  'cancelled',
  'stale',
]);

/** 有副作用、可能改变运行状态的意图；只用于响应里的 `changed` 提示。 */
const CHANGING_INTENTS: ReadonlySet<IntentName> = new Set<IntentName>([
  'approval.decide',
  'capability.ban',
  'capability.unban',
  'group.silence',
  'group.resume',
]);

/** router 的用法/语法错误回执都以这些词开头或包含这些标记。 */
const USAGE_MARKERS = ['用法', '未知指令', '指令过长', '参数过多'];
/** 副作用意图被拒绝时的固定回执前缀；命中即 `ok:false`。 */
const REFUSAL_PREFIXES = [
  '未知插件',
  '能力注册表未接线',
  '运行闸门未接线',
  '该意图不能作为控制指令执行',
  '指令执行失败',
  '未找到审批',
  // `#同意/#拒绝` 的所有失败回执都以「审批 <id> ...」开头，成功则是
  // 「已批准/已拒绝」。
  '审批 ',
];
/** `#解封` 的部分失败：解封成功但激活审批没有生成，仍算命令失败。 */
const PARTIAL_FAILURE_MARKERS = ['未生成激活审批', '激活审批生成失败'];

type CommandOutcome =
  | { ok: true; changed: boolean }
  | { ok: false; code: 'invalid_command' | 'refused' };

/** `parseCommand` 的命令名 → 意图名。只用于给网页回执贴标签，不执行。 */
const COMMAND_INTENTS: Readonly<Record<CommandName, IntentName>> = {
  help: 'help.read',
  status: 'status.read',
  approvals: 'approval.list',
  approve: 'approval.decide',
  deny: 'approval.decide',
  ban: 'capability.ban',
  unban: 'capability.unban',
  quiet: 'group.silence',
  resume: 'group.resume',
  confirm: 'approval.decide',
};

/** 审批记录的安全投影：没有任何原始载荷或指纹。 */
export interface ApprovalView {
  id: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  tier: RiskTier;
  title: string;
  summary: string;
  createdAt: string;
  expiresAt: string;
  createdVia: DecisionChannel;
  createdBy: string;
  decidedAt?: string;
  decidedVia?: DecisionChannel;
  decidedBy?: string;
  decisionReason?: string;
  execution?: { state: 'pending' | 'done' | 'failed'; at?: string; error?: string };
}

export interface ControlApiDeps {
  approvals: {
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
  };
  /** 与 `#状态` 共用同一份只读快照。 */
  status: () => ControlStatusSnapshot;
  /** 控制面 router；未接线时返回 null（指令路由 503）。 */
  router: () => ControlRouter | null;
  /**
   * 控制面总开关。显式关闭时四条路由一律 503 `control_disabled`：不做静默
   * 200，也不读任何状态。传函数时每次请求按次读取，保存配置后无需重启。
   */
  enabled?: boolean | (() => boolean);
  log?: (line: string) => void;
}

export interface ControlApi {
  handlers: {
    approvals: RouteHandler;
    approvalsDecide: RouteHandler;
    control: RouteHandler;
    controlCommand: RouteHandler;
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 单行化 + 净化 + 按码点截断。不可信字段（插件名、权限、错误文本、理由）
 * 都会进入网页；换行/ANSI 可以伪造提示行，必须在这里清掉。
 */
function safeText(value: string, limit = MAX_FIELD_LENGTH): string {
  const cleaned = stripUnsafeControls(value).replace(/[\r\n]+/g, ' ').trim();
  const points = [...cleaned];
  if (points.length <= limit) return cleaned;
  return `${points.slice(0, Math.max(0, limit - 3)).join('')}...`;
}

function renderTitle(payload: ApprovalPayload): string {
  if (payload.kind === 'capability.activate') {
    return safeText(`激活能力插件 ${payload.plugin}`);
  }
  return safeText(`控制指令 ${payload.intent}`);
}

/**
 * 摘要从 payload 重新生成（磁盘/内存里的摘要一律不用）。能力插件的
 * 声明权限与工具名同样是不可信 manifest 内容，逐个净化后再拼装。
 */
function renderSummary(payload: ApprovalPayload): string {
  if (payload.kind === 'capability.activate') {
    const permissions =
      payload.declaredPermissions.length === 0
        ? '无'
        : payload.declaredPermissions.map((entry) => safeText(entry, 64)).join('、');
    const tools =
      payload.toolNames.length === 0
        ? '无'
        : payload.toolNames.map((entry) => safeText(entry, 64)).join('、');
    return safeText(
      `版本 ${payload.version}；声明权限：${permissions}；工具：${tools}`,
    );
  }
  let args: string;
  try {
    args = JSON.stringify(payload.args);
  } catch {
    args = '{}';
  }
  return safeText(`意图 ${payload.intent}；参数 ${args}`);
}

/** 记录 → 网页投影。所有字符串字段都过净化；可选字段保持缺省形状。 */
export function toApprovalView(record: ApprovalRecord): ApprovalView {
  const view: ApprovalView = {
    id: record.id,
    kind: record.kind,
    status: record.status,
    tier: record.tier,
    title: renderTitle(record.payload),
    summary: renderSummary(record.payload),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    createdVia: record.createdVia,
    createdBy: safeText(record.createdBy),
  };
  if (record.decidedAt !== undefined) view.decidedAt = record.decidedAt;
  if (record.decidedVia !== undefined) view.decidedVia = record.decidedVia;
  if (record.decidedBy !== undefined) view.decidedBy = safeText(record.decidedBy);
  if (record.decisionReason !== undefined) {
    view.decisionReason = safeText(record.decisionReason);
  }
  if (record.execution !== undefined) {
    const execution: NonNullable<ApprovalView['execution']> = {
      state: record.execution.state,
    };
    if (record.execution.at !== undefined) execution.at = record.execution.at;
    if (record.execution.error !== undefined) {
      execution.error = safeText(record.execution.error);
    }
    view.execution = execution;
  }
  return view;
}

function isApprovalKind(value: string): value is ApprovalKind {
  return APPROVAL_KINDS.has(value);
}

function isApprovalStatus(value: string): value is ApprovalStatus {
  return APPROVAL_STATUSES.has(value);
}

function parseLimit(raw: string | null): number | undefined {
  if (raw === null) return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) return undefined;
  return value;
}

/**
 * 指令标签：用与 router 相同的 `parseCommand` 只做投影，绝不执行。
 * 自然语言（非 `#` 开头）在网页上不是指令，返回 null。
 */
function intentOf(text: string): IntentName | null {
  const parsed = parseCommand(text);
  if (parsed === null || parsed.kind !== 'command') return null;
  return COMMAND_INTENTS[parsed.name];
}

/**
 * 从 router 的回执文本判定命令结果。router 的 `ControlReply` 只有
 * `{text, handled}`，没有结构化错误码；这里按固定回执前缀分类，避免把
 * 「用法错误」或「未知插件」当成 `changed:true`。
 *
 * - 用法/语法错误 → `invalid_command`（HTTP 400）。
 * - 副作用意图被拒绝 → `refused`（HTTP 200 + `ok:false`）。
 * - 只读意图或未识别文本 → `ok:true, changed:false`。
 * - 其余副作用回执 → `ok:true, changed:true`。
 */
function classifyCommandOutcome(intent: IntentName | null, replyText: string): CommandOutcome {
  if (USAGE_MARKERS.some((marker) => replyText.includes(marker))) {
    return { ok: false, code: 'invalid_command' };
  }
  if (intent === null || !CHANGING_INTENTS.has(intent)) {
    return { ok: true, changed: false };
  }
  if (REFUSAL_PREFIXES.some((prefix) => replyText.startsWith(prefix))) {
    return { ok: false, code: 'refused' };
  }
  if (PARTIAL_FAILURE_MARKERS.some((marker) => replyText.includes(marker))) {
    return { ok: false, code: 'refused' };
  }
  return { ok: true, changed: true };
}

export function createControlApi(deps: ControlApiDeps): ControlApi {
  const log = deps.log ?? (() => {});
  // 按次读取：主开关关闭时四条路由统一拒绝，且不读状态、不调 router、不碰审批。
  const enabledNow = (): boolean =>
    typeof deps.enabled === 'function' ? deps.enabled() : deps.enabled !== false;

  const fail = (message: string): void => {
    log(`control api: ${safeText(message)}`);
  };

  const approvals: RouteHandler = (ctx) => {
    const statusParam = ctx.url.searchParams.get('status');
    const statusRaw = statusParam === null || statusParam === '' ? 'pending' : statusParam;
    if (statusRaw !== 'pending' && statusRaw !== 'all') {
      ctx.send(400, { ok: false, code: 'invalid_query' });
      return;
    }
    // `?kind=`（空值）等同于不筛选；与 `?status=` / `?limit=` 的空值一致。
    const kindParam = ctx.url.searchParams.get('kind');
    const kindRaw = kindParam === null || kindParam === '' ? null : kindParam;
    if (kindRaw !== null && !isApprovalKind(kindRaw)) {
      ctx.send(400, { ok: false, code: 'invalid_query' });
      return;
    }
    const limitParam = ctx.url.searchParams.get('limit');
    const limit = parseLimit(limitParam === null || limitParam === '' ? null : limitParam);
    if (limit === undefined) {
      ctx.send(400, { ok: false, code: 'invalid_query' });
      return;
    }

    try {
      // pending 始终是「可行动」的待办数：默认口径排除 control.command，
      // 与 `#状态` / `GET /api/control` 保持一致。
      const pending = deps.approvals.list({ status: 'pending' }).length;

      const id = ctx.url.searchParams.get('id');
      if (id !== null) {
        const record = deps.approvals.get(id);
        if (record === undefined) {
          // 200 + not_found：404 会把 id 空间变成探测 oracle。
          ctx.send(200, { ok: false, code: 'not_found' });
          return;
        }
        ctx.send(200, { ok: true, records: [toApprovalView(record)], pending });
        return;
      }

      // 显式 kind 或单 id 查询打开 includeControl（R3 的核对入口）；
      // 默认列表不展示 control.command。
      const filter: ListFilter = {
        status: statusRaw === 'all' ? 'all' : 'pending',
        ...(kindRaw === null ? {} : { kind: kindRaw }),
        ...(kindRaw === null ? {} : { includeControl: true }),
      };
      const records = deps.approvals.list(filter).slice(0, limit).map(toApprovalView);
      ctx.send(200, { ok: true, records, pending });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      ctx.send(503, { ok: false, code: 'control_unavailable' });
    }
  };

  const approvalsDecide: RouteHandler = async (ctx) => {
    const body = ctx.body;
    if (!isPlainObject(body)) {
      ctx.send(400, { ok: false, code: 'invalid_body' });
      return;
    }
    const id = body['id'];
    if (typeof id !== 'string' || id === '' || id.length > MAX_ID_LENGTH) {
      ctx.send(400, { ok: false, code: 'invalid_body' });
      return;
    }
    const decision = body['decision'];
    if (decision !== 'approve' && decision !== 'deny') {
      ctx.send(400, { ok: false, code: 'invalid_body' });
      return;
    }
    const reason = body['reason'];
    if (reason !== undefined && typeof reason !== 'string') {
      ctx.send(400, { ok: false, code: 'invalid_body' });
      return;
    }

    try {
      const result = await deps.approvals.decide(id, {
        decision,
        // 网页永远是 web 通道：`control.command` 会在这里得到 wrong_channel。
        via: 'web',
        by: 'web:session',
        ...(reason === undefined ? {} : { reason }),
      });
      if (!result.ok) {
        // 域错误（not_found/not_pending/wrong_channel/expired/...）一律 200：
        // 这不是请求格式问题，也不需要把 id 空间暴露成状态码差异。
        ctx.send(200, { ok: false, code: result.code });
        return;
      }
      ctx.send(200, { ok: true, record: toApprovalView(result.record) });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      ctx.send(503, { ok: false, code: 'control_unavailable' });
    }
  };

  const control: RouteHandler = (ctx) => {
    try {
      const status = deps.status();
      ctx.send(200, {
        ok: true,
        status,
        approvals: status.approvals,
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      ctx.send(503, { ok: false, code: 'control_unavailable' });
    }
  };

  const controlCommand: RouteHandler = async (ctx) => {
    const body = ctx.body;
    if (!isPlainObject(body)) {
      ctx.send(400, { ok: false, code: 'invalid_body' });
      return;
    }
    const text = body['text'];
    if (typeof text !== 'string' || text.trim() === '') {
      ctx.send(400, { ok: false, code: 'invalid_body' });
      return;
    }

    const router = deps.router();
    if (router === null) {
      ctx.send(503, { ok: false, code: 'control_unavailable' });
      return;
    }

    try {
      // 唯一入口：与 QQ 同一套解析、审批与回执；网页不另造命令语法。
      const reply = await router.handleOwnerText(text, {
        channel: 'web',
        actor: 'web:session',
      });
      if (!reply.handled) {
        // 自然语言只属于 owner 的 QQ 私聊；网页只接受显式 `#` 指令。
        ctx.send(400, { ok: false, code: 'invalid_command' });
        return;
      }
      const intent = intentOf(text);
      const outcome = classifyCommandOutcome(intent, reply.text);
      if (outcome.ok) {
        ctx.send(200, {
          ok: true,
          reply: reply.text,
          intent,
          changed: outcome.changed,
        });
        return;
      }
      // 语法错误是请求问题（400）；命令被拒绝是域结果（200 + ok:false）。
      ctx.send(outcome.code === 'invalid_command' ? 400 : 200, {
        ok: false,
        code: outcome.code,
        reply: reply.text,
        intent,
        changed: false,
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      ctx.send(503, { ok: false, code: 'control_unavailable' });
    }
  };

  /** 请求级开关闸：关闭时连状态都不读，四条路由回同一个稳定错误码。 */
  const gate =
    (handler: RouteHandler): RouteHandler =>
    (ctx) => {
      if (!enabledNow()) {
        ctx.send(503, { ok: false, code: 'control_disabled' });
        return;
      }
      return handler(ctx);
    };

  return {
    handlers: {
      approvals: gate(approvals),
      approvalsDecide: gate(approvalsDecide),
      control: gate(control),
      controlCommand: gate(controlCommand),
    },
  };
}