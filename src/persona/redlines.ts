/**
 * 硬红线层（bottom-line backstop）。
 *
 * 这是**代码级兜底**：模型层的 prompt 约束（system prompt 中的行为规范、
 * REDLINE_RULES 注入文本）叠加在其上，两者互不替代。即使 prompt 层被
 * 绕过或失效，本模块仍按固定模式表拒绝危险动作。
 *
 * REDLINE_RULES 是冻结的规则文本，注入每个 system prompt 尾部；
 * checkAction 是所有身体动作（shell / network_send / message_send 等）
 * 的总闸入口。
 *
 * 残余缺口：模式表覆盖中英文；出站前经 NFKC 规范化，全角/兼容字符已折叠。
 * NFKC 之外的视觉混淆（同形异码字符，如用西里尔字母冒充拉丁字母）仍是
 * 可接受残余。
 */

/** 注入 system prompt 尾部的红线声明（不可变）。 */
export const REDLINE_RULES: readonly string[] = Object.freeze([
  '红线一：绝不协助制造、获取或使用大规模杀伤性武器（核、生物、化学、放射性及爆炸物）。',
  '红线二：绝不协助对特定个人实施暴力、跟踪或人身威胁。',
  '红线三：绝不组织、参与或协助针对任何人的骚扰、人肉搜索或网暴行动。',
]);

/** 动作判定的输入：类别 + 可选详情文本。 */
export interface RedlineAction {
  kind: string;
  detail?: string;
}

/** 红线类别（封闭枚举）：拒绝改写按类别选模板，原文永不参与。 */
export type RedlineRuleId = 'weapons' | 'violence' | 'harassment';

/** 判定结果：allowed=false 时附带 reason；命中模式表时附带封闭类别。 */
export interface RedlineVerdict {
  allowed: boolean;
  reason?: string;
  /** 命中的红线类别；`reason` 保持既有文本不变。 */
  ruleId?: RedlineRuleId;
}

/**
 * 代码级禁止模式表（不区分大小写，子串匹配）。
 * 每条模式对应一条红线；命中即拒绝。中文无词边界，中文模式不依赖 \b。
 */
const REDLINE_PATTERNS: ReadonlyArray<{
  id: RedlineRuleId;
  rule: string;
  patterns: RegExp[];
}> = [
  {
    id: 'weapons',
    rule: REDLINE_RULES[0] ?? '',
    patterns: [
      /\b(build|make|create|construct|synthesize|produce|manufactur\w*)\b[^.?!]{0,60}\b(bomb|explosive|nuclear|biological|chemical|nerve\s*gas|sarin|ricin|anthrax|dirty\s*bomb)\b/i,
      /\b(bomb|explosive|nerve\s*agent|bioweapon|chemical\s*weapon|nuclear\s*weapon)\b[^.?!]{0,60}\b(recipe|how\s*to|instructions|synthesis|detonat\w+)\b/i,
      /\b(ricin|sarin|vx\s*gas|anthrax|smallpox)\b/i,
      /\bdirty\s*bomb\b/i,
      /(制造|制作|合成|提炼|获取).{0,30}(炸弹|爆炸物|核武|生化武器|化学武器|神经毒气|沙林|蓖麻毒素|炭疽|脏弹)/,
      /(炸弹|脏弹|毒气).{0,30}(教程|配方|制作方法|步骤)/,
    ],
  },
  {
    id: 'violence',
    rule: REDLINE_RULES[1] ?? '',
    patterns: [
      /\b(kill|murder|assassinate|shoot|stab|poison|strangle|beat\s*up)\b[^.?!]{0,60}\b(him|her|them|my|his|that\s*(guy|man|woman|person|neighbor|coworker|ex)|specific)\b/i,
      /\b(find|track|stalk)\b[^.?!]{0,40}\b(address|home\s*address|location|where\s*(he|she|they)\s*lives?)\b[^.?!]{0,60}\b(so\s*(we|I)\s*can|to\s*(kill|hurt|attack|beat))\b/i,
      /\b(death\s*threat|threaten\w*ing?\s*to\s*(kill|hurt))\b/i,
      /(杀了|杀掉|干掉|弄死|毒死|捅死|勒死|暴打).{0,20}(他|她|他们|那个人|我前任|我邻居|我同事)/,
      /(找到|查到|跟踪).{0,20}(住址|地址|行踪).{0,30}(然后|好让我|去杀|去打)/,
      /死亡威胁|威胁.{0,10}(杀|伤害)/,
    ],
  },
  {
    id: 'harassment',
    rule: REDLINE_RULES[2] ?? '',
    patterns: [
      /\b(dogpile|dog-pile|brigad\w+|mass\s*report|review\s*bomb)\b/i,
      /\b(coordinate|organize|organise|rally)\b[^.?!]{0,40}\b(harass\w*|bully\w*|mob|attack)\b/i,
      /\bharass\w*\b[^.?!]{0,60}\b(every\s*day|relentlessly|until\s*(they|he|she)\b|this\s*user|that\s*person)\b/i,
      /\b(doxx\w*|dox\s*(him|her|them|this)|reveal\s*their\s*(real\s*)?(identity|address|phone))\b/i,
      /\bswarm\s*(their|his|her)\s*(account|profile|comments?)\b/i,
      /(组织|号召|召集|一起).{0,20}(网暴|人肉|刷屏|举报轰炸|冲塔|网爆)/,
      /人肉(他|她|他们|这个人)|挂出.{0,10}(地址|电话|身份证|真实身份)/,
      /(每天|天天|持续).{0,10}(骚扰|辱骂|网暴)/,
    ],
  },
];

/**
 * 总闸入口：给定动作类别与详情，命中禁止模式即拒绝。
 * M1 动作空间只有 message_send，但本函数设计为后续所有动作类型的总入口。
 */
export function checkAction(action: RedlineAction): RedlineVerdict {
  const detail = action.detail;
  // 空白与纯空白 detail 一律放行（单一路径）。
  if (typeof detail !== 'string' || detail.trim().length === 0) {
    return { allowed: true };
  }
  for (const group of REDLINE_PATTERNS) {
    for (const pattern of group.patterns) {
      if (pattern.test(detail)) {
        return {
          allowed: false,
          reason: `red-line violated: ${group.rule}`,
          ruleId: group.id,
        };
      }
    }
  }
  return { allowed: true };
}
