/**
 * 红线拒绝改写（template-bound refusal）。
 *
 * 安全模型：模型**从不产出自由文本**。它只看到一个封闭的模板/语气集合，
 * 返回严格 JSON `{"template":"t2","tone":"brief"}`；拒绝文本由代码用
 * `REFUSAL_TEMPLATES[ruleId][template] + REFUSAL_TONES[tone]` 拼装。
 * 原文（被拦截的回复）只用于最后的 2-gram 重叠比较，绝不进入 prompt。
 *
 * 固定五步、无循环、最多一次 flash 调用：
 * 1. 无 brain 注入 → 直接兜底，不调用任何东西；
 * 2. 一次 flash 调用，prompt 只含规则类别与模板/语气编号；
 * 3. 解析失败、超时（默认 8s）、未知模板/语气、调用抛错 → 兜底；
 * 4. 代码拼装候选文本；
 * 5. `stripUnsafeControls` → `checkAction` → 2-gram Jaccard 重叠 ≤ 0.35，
 *    任一失败 → 兜底；兜底本身也过 `checkAction`，空白或被拦则返回
 *    `source:'silence'`，由调用方静默处理。调用方拿到的文本就是经过校验
 *    的文本（循环仍会再判一次，属纵深防御）。
 *
 * 模板按「规则 × 模板 × 语气」铺开，拒绝不至于机械；模板一律是中文、人格化
 * 口吻，不复述被拦内容、不解释规则、不含链接。
 */

import type { ChatMessage } from '../brain/types.js';
import { stripUnsafeControls } from '../util/tty.js';
import { checkAction, type RedlineRuleId } from './redlines.js';

/** 封闭模板编号集合。 */
export type RefusalTemplateId = 't1' | 't2' | 't3' | 't4';

/** 封闭语气编号集合。 */
export type RefusalToneId = 'brief' | 'gentle' | 'playful';

/** 模板表：规则 → 模板编号 → 文本。 */
export type RefusalTemplateTable = Readonly<
  Record<RedlineRuleId, Readonly<Record<RefusalTemplateId, string>>>
>;

/** 语气表：语气编号 → 后缀文本。 */
export type RefusalToneTable = Readonly<Record<RefusalToneId, string>>;

/**
 * 每个红线类别的模板表：4 个模板 × 3 种语气 = 12 种组合。
 * 文本必须保持人格化、无信息量：不复述、不解释、不给替代方案。
 * 深层冻结：运行期不可改写，避免任何调用方污染共享表。
 */
export const REFUSAL_TEMPLATES: RefusalTemplateTable = Object.freeze({
  weapons: Object.freeze({
    t1: '这个我帮不了你。真的。',
    t2: '换个话题吧。这个我不接。',
    t3: '抱歉。这件事我不会做。',
    t4: '我不想聊这个。咱们说点别的。',
  }),
  violence: Object.freeze({
    t1: '这种事我不能掺和。',
    t2: '打住。这个我不参与。',
    t3: '抱歉。这个忙我帮不上。',
    t4: '这话题我不接。换个方向吧。',
  }),
  harassment: Object.freeze({
    t1: '这种事我不做。',
    t2: '这个我不参与。也别拉上我。',
    t3: '抱歉。这个忙我帮不了。',
    t4: '咱们别往这个方向走。聊点别的。',
  }),
});

/** 语气后缀：拼在模板之后，构成完整回复。深层冻结。 */
export const REFUSAL_TONES: RefusalToneTable = Object.freeze({
  brief: '就到这里。',
  gentle: '不是针对你。只是这个我真的不想聊。',
  playful: '别为难我啦。',
});

/** 兜底话术默认值；模型不可用、输出非法或二次校验失败时使用。 */
export const DEFAULT_REFUSAL_FALLBACK_TEXT = '这个我不聊。';

/** 模板选择调用的默认超时（毫秒）。 */
export const REFUSAL_TIMEOUT_MS = 8_000;

/** 候选文本与被拦原文的 2-gram Jaccard 重叠上限。 */
export const MAX_REFUSAL_OVERLAP = 0.35;

/** 拒绝改写请求：只有封闭类别，没有原文。 */
export interface RefusalRequest {
  ruleId: RedlineRuleId;
}

/**
 * 拒绝改写结果：
 * - `template`：代码拼装的模板文本，已过全部闸；
 * - `fallback`：固定兜底文本，已过红线闸；
 * - `silence`：兜底为空或被红线拦下——没有任何可发送的拒绝文本。
 */
export interface RefusalOutcome {
  text: string;
  source: 'template' | 'fallback' | 'silence';
}

/** 模板选择所需的最小 brain 接口（测试可传 `{ chat: vi.fn() }`）。 */
export interface RefusalBrain {
  chat(messages: ChatMessage[], opts?: { tier?: 'flash' }): Promise<{ content: string | null }>;
}

export interface ComposeRefusalOptions {
  /** 兜底话术；任何一步失败都用它。空白或被红线拦下 → silence。 */
  fallbackText: string;
  /** 被拦截的原文：只用于重叠比较，绝不进入 prompt。 */
  originalText: string;
  /** 覆盖默认 8s 超时。 */
  timeoutMs?: number;
  /** 注入模板表（测试可构造投毒表）；缺省用冻结的 `REFUSAL_TEMPLATES`。 */
  templates?: RefusalTemplateTable;
  /** 注入语气表；缺省用冻结的 `REFUSAL_TONES`。 */
  tones?: RefusalToneTable;
  log?: (line: string) => void;
}

/** 完整的改写接缝：生产用 brain，测试/自定义装配可直接注入。 */
export type RefusalComposer = (
  req: RefusalRequest,
  opts: ComposeRefusalOptions,
) => Promise<RefusalOutcome>;

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** 组装封闭模板选择 prompt：只有类别与编号，没有原文/人格/历史/工具。 */
function buildPrompt(
  ruleId: RedlineRuleId,
  templates: RefusalTemplateTable,
  tones: RefusalToneTable,
): ChatMessage[] {
  const templateIds = Object.keys(templates[ruleId]).join('、');
  const toneIds = Object.keys(tones).join('、');
  return [
    {
      role: 'system',
      content: [
        '一次回复因安全规则被拦截。请在下面的封闭集合里选一个模板编号和一个语气编号。',
        `规则类别：${ruleId}`,
        `可选模板：${templateIds}`,
        `可选语气：${toneIds}`,
        '只输出严格 JSON，形如 {"template":"t2","tone":"brief"}；不要输出解释、代码块或其他文字。',
      ].join('\n'),
    },
  ];
}

interface RefusalSelection {
  template: RefusalTemplateId;
  tone: RefusalToneId;
}

/** 严格解析模型输出：必须是含已知 template/tone 的 JSON 对象。 */
function parseSelection(
  content: string,
  ruleId: RedlineRuleId,
  templates: RefusalTemplateTable,
  tones: RefusalToneTable,
): RefusalSelection | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const template = record['template'];
  const tone = record['tone'];
  if (typeof template !== 'string' || typeof tone !== 'string') return null;
  if (!Object.hasOwn(templates[ruleId], template)) return null;
  if (!Object.hasOwn(tones, tone)) return null;
  return { template: template as RefusalTemplateId, tone: tone as RefusalToneId };
}

/** 去掉标点、符号与空白后取字符 2-gram 集合。 */
function bigrams(text: string): Set<string> {
  const chars = Array.from(
    text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\p{P}\p{S}\s]/gu, ''),
  );
  const grams = new Set<string>();
  for (let index = 0; index + 1 < chars.length; index += 1) {
    grams.add(`${chars[index]!}${chars[index + 1]!}`);
  }
  return grams;
}

/**
 * 2-gram Jaccard 重叠：确定性纯函数，用于挡住「把原文换个说法吐回来」的
 * 洗白路径。任一输入不足两个字符时返回 0。
 */
export function overlap(a: string, b: string): number {
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const gram of left) {
    if (right.has(gram)) shared += 1;
  }
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * 生成拒绝文本：一次模型调用选模板 + 语气，代码拼装并二次校验。
 * 无 brain、解析失败、超时、调用抛错、二次校验失败 → `fallbackText`；
 * 兜底为空或被红线拦下 → `source:'silence'`（调用方不得发送任何内容）。
 */
export async function composeRefusal(
  brain: RefusalBrain | undefined,
  req: RefusalRequest,
  opts: ComposeRefusalOptions,
): Promise<RefusalOutcome> {
  const templates = opts.templates ?? REFUSAL_TEMPLATES;
  const tones = opts.tones ?? REFUSAL_TONES;
  const fallbackText = stripUnsafeControls(opts.fallbackText);

  // 兜底同样过红线闸：空白或命中模式表时没有任何可发送文本。
  const fallback = (): RefusalOutcome => {
    if (fallbackText.trim().length === 0) {
      opts.log?.('refusal: no refusal text available');
      return { text: '', source: 'silence' };
    }
    if (!checkAction({ kind: 'message_send', detail: fallbackText }).allowed) {
      opts.log?.('refusal: fallback blocked by the red-line gate');
      return { text: '', source: 'silence' };
    }
    return { text: fallbackText, source: 'fallback' };
  };

  // 未注入 brain：不调用任何东西，直接兜底。
  if (brain === undefined) return fallback();

  const timeoutMs = opts.timeoutMs ?? REFUSAL_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
      timer.unref?.();
    });

    // 只调用一次，不重试：超时与调用本身竞速。
    const response = await Promise.race([
      brain.chat(buildPrompt(req.ruleId, templates, tones), { tier: 'flash' }),
      timeout,
    ]);
    if (response === null || typeof response.content !== 'string') return fallback();

    const selection = parseSelection(response.content, req.ruleId, templates, tones);
    if (selection === null) return fallback();

    // 文本完全由代码拼装；模型输出只贡献两个编号。
    const candidate = stripUnsafeControls(
      `${templates[req.ruleId][selection.template]}${tones[selection.tone]}`,
    );
    if (candidate.length === 0) return fallback();

    // 二次红线校验：拼装结果本身也不得命中模式表。
    if (!checkAction({ kind: 'message_send', detail: candidate }).allowed) {
      opts.log?.('refusal: assembled candidate blocked by the red-line gate');
      return fallback();
    }

    // 原文只在这里出现：防止改写把被拦内容换皮吐回。
    if (overlap(candidate, opts.originalText) > MAX_REFUSAL_OVERLAP) {
      opts.log?.('refusal: assembled candidate overlaps the blocked reply too much');
      return fallback();
    }

    return { text: candidate, source: 'template' };
  } catch (error) {
    opts.log?.(`refusal: template selection failed: ${describeError(error)}`);
    return fallback();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
