/**
 * 意图语义层：每个意图的合法参数、分级与可读描述，以及自然语言分类器。
 *
 * 分级表由代码拥有（manifest 与模型自评不参与）。前缀指令一律直接执行；
 * 自然语言只能命中 auto 级、有副作用的四个意图，且**只能**生成一条
 * `control.command` 审批等待 owner 用显式 `ap_` id 确认——批准永远不能由
 * 自然语言推断（不变量 4、10）。
 */
import type { ChatMessage } from '../brain/types.js';
import type { RiskTier } from '../approvals/types.js';
import { stripUnsafeControls } from '../util/tty.js';
import type { IntentName } from './types.js';

export type { IntentName } from './types.js';

/** 参数正则（spec §4）：不匹配回「用法」，不猜。 */
const ID_PATTERN = /^ap_[0-9a-f]{32}$/;
const PLUGIN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const GROUP_PATTERN = /^\d{1,20}$/;
const MINUTES_PATTERN = /^\d{1,5}$/;
/** `#安静` 的上限：24 小时。 */
export const MAX_SILENCE_MINUTES = 1440;
/** 拒绝理由的展示上限；更长的部分截断，不进入回执模板。 */
const MAX_REASON_LENGTH = 200;

/** 分类器只需要 `chat` 的这一个子集；真实 `Brain` 结构上兼容。 */
export interface BrainLike {
  chat(
    messages: ChatMessage[],
    opts?: { tier?: 'flash' | 'pro' },
  ): Promise<{ content: string | null }>;
}

export interface ClassifyOptions {
  /** 默认 0.75（渠道插件从自己的配置传入）。 */
  minConfidence?: number;
  /** 默认 3000ms。 */
  timeoutMs?: number;
  /** 诊断出口；分类失败从不抛给调用方。 */
  log?: (line: string) => void;
  /** 目标校验：能力插件名是否存在于当前注册表。缺省不校验。 */
  isKnownPlugin?: (name: string) => boolean;
  /** 目标校验：群号是否是当前已知的群。缺省不校验（语法正则仍然生效）。 */
  isKnownGroup?: (groupId: string) => boolean;
}

export type IntentParseResult =
  | { ok: true; args: Record<string, string | number> }
  | { ok: false; reason: string };

export interface IntentSpec {
  tier: RiskTier;
  describe(args: Record<string, string | number>): string;
  parse(raw: unknown): IntentParseResult;
}

export type IntentClassification =
  | { intent: IntentName; args: Record<string, string | number> }
  | { intent: 'none' };

const DEFAULT_MIN_CONFIDENCE = 0.75;
const DEFAULT_TIMEOUT_MS = 3000;
/** 分类器输入上限（spec §4）。 */
const MAX_CLASSIFIER_INPUT = 512;
const MAX_LOG_DETAIL = 200;

/** 引用/转发/卡片消息不分类：它们的内容不是 owner 自己打的字。 */
const QUOTED_CONTENT = /\[CQ:(?:reply|forward|json)(?:,|\])/i;

function failure(reason: string): IntentParseResult {
  return { ok: false, reason };
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

/** 只允许声明的键；多余键一律拒绝，防止控制指令参数夹带。 */
function unknownKey(raw: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) return key;
  }
  return null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readId(value: unknown): string | undefined {
  const text = readString(value);
  return text !== undefined && ID_PATTERN.test(text) ? text : undefined;
}

function readPlugin(value: unknown): string | undefined {
  const text = readString(value);
  return text !== undefined && PLUGIN_PATTERN.test(text) ? text : undefined;
}

function readGroup(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
  }
  const text = readString(value);
  return text !== undefined && GROUP_PATTERN.test(text) ? text : undefined;
}

function readMinutes(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 && value <= MAX_SILENCE_MINUTES
      ? value
      : undefined;
  }
  const text = readString(value);
  if (text === undefined || !MINUTES_PATTERN.test(text)) return undefined;
  const minutes = Number(text);
  return minutes <= MAX_SILENCE_MINUTES ? minutes : undefined;
}

function safeReason(value: string): string {
  const cleaned = stripUnsafeControls(value).replace(/[\r\n]+/g, ' ').trim();
  return cleaned.length > MAX_REASON_LENGTH ? cleaned.slice(0, MAX_REASON_LENGTH) : cleaned;
}

function parseHelp(raw: unknown): IntentParseResult {
  const record = asRecord(raw);
  if (record === null) return failure('用法：#帮助');
  const extra = unknownKey(record, []);
  if (extra !== null) return failure('用法：#帮助');
  return { ok: true, args: {} };
}

function parseStatus(raw: unknown): IntentParseResult {
  const record = asRecord(raw);
  if (record === null) return failure('用法：#状态');
  const extra = unknownKey(record, []);
  if (extra !== null) return failure('用法：#状态');
  return { ok: true, args: {} };
}

function parseApprovalList(raw: unknown): IntentParseResult {
  const record = asRecord(raw);
  if (record === null) return failure('用法：#审批 [id]');
  const extra = unknownKey(record, ['id']);
  if (extra !== null) return failure('用法：#审批 [id]');

  const id = record['id'];
  if (id === undefined) return { ok: true, args: {} };
  const parsed = readId(id);
  if (parsed === undefined) return failure('用法：#审批 [id]，id 形如 ap_ 加 32 位十六进制');
  return { ok: true, args: { id: parsed } };
}

function parseApprovalDecide(raw: unknown): IntentParseResult {
  const record = asRecord(raw);
  if (record === null) return failure('用法：#同意 <id> / #拒绝 <id> [理由]');
  const extra = unknownKey(record, ['id', 'decision', 'reason']);
  if (extra !== null) return failure('用法：#同意 <id> / #拒绝 <id> [理由]');

  const id = readId(record['id']);
  if (id === undefined) return failure('用法：#同意 <id> / #拒绝 <id>，id 形如 ap_ 加 32 位十六进制');

  const decision = record['decision'];
  if (decision !== 'approve' && decision !== 'deny') {
    return failure('用法：#同意 <id> / #拒绝 <id> [理由]');
  }

  const args: Record<string, string | number> = { id, decision };
  const reason = record['reason'];
  if (reason !== undefined) {
    if (typeof reason !== 'string') return failure('理由必须是文本。');
    const cleaned = safeReason(reason);
    if (cleaned !== '') args['reason'] = cleaned;
  }
  return { ok: true, args };
}

function parsePluginIntent(raw: unknown, usage: string): IntentParseResult {
  const record = asRecord(raw);
  if (record === null) return failure(usage);
  const extra = unknownKey(record, ['plugin']);
  if (extra !== null) return failure(usage);

  const plugin = readPlugin(record['plugin']);
  if (plugin === undefined) return failure(usage);
  return { ok: true, args: { plugin } };
}

function parseSilence(raw: unknown): IntentParseResult {
  const record = asRecord(raw);
  if (record === null) return failure('用法：#安静 [群号] <分钟>（0-1440，0 解除）');
  const extra = unknownKey(record, ['group', 'minutes']);
  if (extra !== null) return failure('用法：#安静 [群号] <分钟>（0-1440，0 解除）');

  const minutes = readMinutes(record['minutes']);
  if (minutes === undefined) return failure('用法：#安静 [群号] <分钟>（0-1440，0 解除）');

  const args: Record<string, string | number> = { minutes };
  const group = record['group'];
  if (group !== undefined) {
    const parsed = readGroup(group);
    if (parsed === undefined) return failure('用法：#安静 [群号] <分钟>，群号是纯数字');
    args['group'] = parsed;
  }
  return { ok: true, args };
}

function parseResume(raw: unknown): IntentParseResult {
  const record = asRecord(raw);
  if (record === null) return failure('用法：#恢复 [群号]');
  const extra = unknownKey(record, ['group']);
  if (extra !== null) return failure('用法：#恢复 [群号]');

  const group = record['group'];
  if (group === undefined) return { ok: true, args: {} };
  const parsed = readGroup(group);
  if (parsed === undefined) return failure('用法：#恢复 [群号]，群号是纯数字');
  return { ok: true, args: { group: parsed } };
}

function scopeLabel(args: Record<string, string | number>): string {
  const group = args['group'];
  return group === undefined ? '全局' : `群 ${String(group)}`;
}

/**
 * 意图表。`tier` 只用于说明分级：`approval.decide` 是 human 级，永远不会
 * 由自然语言推断；其余 auto 级意图里，有副作用的四个在 NL 路径上必须先
 * 生成 `control.command` 审批。
 */
export const INTENT_SPECS: Record<IntentName, IntentSpec> = {
  'help.read': {
    tier: 'auto',
    describe: () => '显示控制指令帮助',
    parse: parseHelp,
  },
  'status.read': {
    tier: 'auto',
    describe: () => '查看运行状态',
    parse: parseStatus,
  },
  'approval.list': {
    tier: 'auto',
    describe: (args) =>
      args['id'] === undefined ? '列出待审批' : `查询审批 ${String(args['id'])}`,
    parse: parseApprovalList,
  },
  'approval.decide': {
    // 「本身即审批」：执行即决策，不需要再生成一条审批；但绝不可由 NL 推断。
    tier: 'human',
    describe: (args) => {
      const verb = args['decision'] === 'deny' ? '拒绝' : '批准';
      const reason = args['reason'];
      return reason === undefined
        ? `${verb} ${String(args['id'] ?? '')}`
        : `${verb} ${String(args['id'] ?? '')}（${String(reason)}）`;
    },
    parse: parseApprovalDecide,
  },
  'capability.ban': {
    tier: 'auto',
    describe: (args) => `封禁能力插件 ${String(args['plugin'] ?? '')}`,
    parse: (raw) => parsePluginIntent(raw, '用法：#封禁 <能力插件>'),
  },
  'capability.unban': {
    tier: 'auto',
    describe: (args) => `解封能力插件 ${String(args['plugin'] ?? '')}`,
    parse: (raw) => parsePluginIntent(raw, '用法：#解封 <能力插件>'),
  },
  'group.silence': {
    tier: 'auto',
    describe: (args) => `静默${scopeLabel(args)} ${String(args['minutes'] ?? 0)} 分钟`,
    parse: parseSilence,
  },
  'group.resume': {
    tier: 'auto',
    describe: (args) => `恢复${scopeLabel(args)}`,
    parse: parseResume,
  },
};

/** 自然语言可推断的意图：批准与单条查询永远不在其中。 */
const NL_INTENTS: ReadonlySet<string> = new Set<IntentName>([
  'help.read',
  'status.read',
  'approval.list',
  'capability.ban',
  'capability.unban',
  'group.silence',
  'group.resume',
]);

/** NL 路径只能生成这四类审批；其余 auto 意图（只读）直接执行。 */
export const SIDE_EFFECT_INTENTS: ReadonlySet<IntentName> = new Set<IntentName>([
  'capability.ban',
  'capability.unban',
  'group.silence',
  'group.resume',
]);

const SYSTEM_PROMPT = [
  '你是控制指令意图分类器。只输出一行 JSON，不要输出解释、Markdown 或代码块。',
  '可选 intent：help.read, status.read, approval.list, capability.ban, capability.unban, group.silence, group.resume。',
  '无法判断时 intent 为 none。',
  '输出格式：{"intent":"...","target":"","minutes":0,"confidence":0.0}',
  'target：能力插件名或 QQ 群号；minutes：静默分钟数 0-1440。',
].join('\n');

function safeLogDetail(value: string): string {
  return stripUnsafeControls(value).replace(/[\r\n]+/g, ' ').slice(0, MAX_LOG_DETAIL);
}

function truncateInput(text: string): string {
  const cleaned = stripUnsafeControls(text);
  const points = [...cleaned];
  return points.length > MAX_CLASSIFIER_INPUT ? points.slice(0, MAX_CLASSIFIER_INPUT).join('') : cleaned;
}

function parseClassifierJson(content: string | null): unknown {
  if (content === null) return null;
  const trimmed = content.trim();
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function isQuotedContent(text: string): boolean {
  return QUOTED_CONTENT.test(text);
}

/**
 * 一次 flash 调用，严格 JSON，3s 超时。任何异常、超时、低置信、未知意图、
 * 参数不合法都回 `{ intent:'none' }`，由调用方按普通聊天处理。
 */
export async function classifyIntent(
  text: string,
  brain: BrainLike | undefined,
  opts: ClassifyOptions = {},
): Promise<IntentClassification> {
  const none: IntentClassification = { intent: 'none' };
  if (brain === undefined) return none;
  if (isQuotedContent(text)) return none;

  const input = truncateInput(text).trim();
  if (input === '') return none;

  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: input },
  ];

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref();
  });

  let response: { content: string | null } | null;
  try {
    const invocation = brain.chat(messages, { tier: 'flash' }).catch((error: unknown) => {
      opts.log?.(`control classifier failed: ${safeLogDetail(String(error))}`);
      return null;
    });
    response = await Promise.race([invocation, timeout]);
  } catch (error) {
    opts.log?.(`control classifier failed: ${safeLogDetail(String(error))}`);
    response = null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  if (response === null) {
    opts.log?.('control classifier timed out or failed; treating message as chat');
    return none;
  }

  const parsed = parseClassifierJson(response.content);
  const record = asRecord(parsed);
  if (record === null) {
    opts.log?.('control classifier returned malformed JSON; treating message as chat');
    return none;
  }

  const intent = readString(record['intent']);
  if (intent === undefined || !NL_INTENTS.has(intent)) return none;

  const confidence = record['confidence'];
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return none;
  if (confidence < minConfidence) return none;

  const rawTarget = record['target'];
  const target =
    typeof rawTarget === 'number' && Number.isFinite(rawTarget)
      ? String(rawTarget)
      : (readString(rawTarget) ?? '');
  // `0` 与缺省都表示全局出站闸（保留群键 `'*'`），与前缀形式一致。
  const groupTarget = target === '0' ? '' : target;
  const rawMinutes = record['minutes'];

  // 单条 approval.list 不可由自然语言推断：任何 target 都拒绝。
  if (intent === 'approval.list' && target !== '') return none;

  // 目标必须是当前已知对象；解析不到就按聊天处理，绝不猜。
  if (intent === 'capability.ban' || intent === 'capability.unban') {
    if (opts.isKnownPlugin !== undefined && !opts.isKnownPlugin(target)) return none;
  }
  if (
    (intent === 'group.silence' || intent === 'group.resume') &&
    groupTarget !== '' &&
    opts.isKnownGroup !== undefined &&
    !opts.isKnownGroup(groupTarget)
  ) {
    return none;
  }

  const candidate: Record<string, unknown> = {};
  switch (intent) {
    case 'capability.ban':
    case 'capability.unban':
      candidate['plugin'] = target;
      break;
    case 'group.silence':
      if (rawMinutes === undefined) return none;
      candidate['minutes'] = rawMinutes;
      if (groupTarget !== '') candidate['group'] = groupTarget;
      break;
    case 'group.resume':
      if (groupTarget !== '') candidate['group'] = groupTarget;
      break;
    default:
      // help.read / status.read / approval.list：只读，忽略 target。
      break;
  }

  const spec = INTENT_SPECS[intent as IntentName];
  const result = spec.parse(candidate);
  if (!result.ok) return none;
  return { intent: intent as IntentName, args: result.args };
}
