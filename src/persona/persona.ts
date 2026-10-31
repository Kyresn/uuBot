/**
 * 人格空白种子与漂移钳制。
 *
 * PersonaState 是 agent 的人格数值状态；createPersonaState 产出空白种子
 * （name=null、quirks=[]，数值由注入的 rng 在 [30,70] 内随机初值）。
 * patchPersonaState 是纯函数：单字段单次 |Δ|≤10，clamp [0,100]，永远
 * 返回新对象不改旧对象——人格只能缓慢漂移，不能跳变。
 */

/** 人格状态。 */
export interface PersonaState {
  name: string | null;
  mood: number;
  energy: number;
  interests: Record<string, number>;
  intimacy: number;
  currentObsession: string | null;
  quirks: string[];
  temperament: {
    extraversion: number;
    curiosity: number;
    laziness: number;
    warmth: number;
  };
}

/** 空白种子数值初值区间。 */
const SEED_MIN = 30;
const SEED_MAX = 70;

/** 单次 patch 每字段最大变化量。 */
const MAX_DELTA = 10;

/** 任意数值字段的合法区间。 */
const CLAMP_MIN = 0;
const CLAMP_MAX = 100;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** rng 注入：把 [0,1) 均匀值映射到 [SEED_MIN, SEED_MAX] 整数。 */
function seedValue(rng: () => number): number {
  const t = clamp(rng(), 0, 1);
  return Math.min(SEED_MAX, Math.floor(SEED_MIN + t * (SEED_MAX - SEED_MIN + 1)));
}

/**
 * 空白种子：name=null, quirks=[], 数值字段由 rng 给 30–70 随机初值。
 * rng 注入保证可复现（测试可传 () => 0.5）。
 */
export function createPersonaState(rng: () => number): PersonaState {
  return {
    name: null,
    mood: seedValue(rng),
    energy: seedValue(rng),
    interests: {},
    intimacy: seedValue(rng),
    currentObsession: null,
    quirks: [],
    temperament: {
      extraversion: seedValue(rng),
      curiosity: seedValue(rng),
      laziness: seedValue(rng),
      warmth: seedValue(rng),
    },
  };
}

/** 单字段按 |Δ|≤10 朝 target 漂移一步，再 clamp 到 [0,100]。 */
function drift(current: number, target: number): number {
  const targetClamped = clamp(target, CLAMP_MIN, CLAMP_MAX);
  const diff = targetClamped - current;
  const step = Math.sign(diff) * Math.min(Math.abs(diff), MAX_DELTA);
  return clamp(current + step, CLAMP_MIN, CLAMP_MAX);
}

/**
 * 纯函数 patch：返回新对象，不改旧对象。
 * 单字段单次 |Δ|≤10，clamp [0,100]；interests 每键同规则；
 * temperament 每子字段同规则。
 */
export function patchPersonaState(state: PersonaState, patch: Partial<PersonaState>): PersonaState {
  const next: PersonaState = {
    ...state,
    temperament: { ...state.temperament },
    interests: { ...state.interests },
    quirks: patch.quirks !== undefined ? [...patch.quirks] : [...state.quirks],
  };

  if (patch.name !== undefined) next.name = patch.name;
  if (patch.currentObsession !== undefined) next.currentObsession = patch.currentObsession;

  if (patch.mood !== undefined) next.mood = drift(state.mood, patch.mood);
  if (patch.energy !== undefined) next.energy = drift(state.energy, patch.energy);
  if (patch.intimacy !== undefined) next.intimacy = drift(state.intimacy, patch.intimacy);

  if (patch.temperament !== undefined) {
    for (const key of ['extraversion', 'curiosity', 'laziness', 'warmth'] as const) {
      const patchVal = patch.temperament[key];
      if (patchVal !== undefined) {
        next.temperament[key] = drift(state.temperament[key], patchVal);
      }
    }
  }

  if (patch.interests !== undefined) {
    for (const [key, patchVal] of Object.entries(patch.interests)) {
      // 新兴趣键以 0 为基线（有意为之：从零开始培养），再走同样的 drift 钳制。
      next.interests[key] = drift(state.interests[key] ?? 0, patchVal);
    }
  }

  return next;
}

/**
 * 一段中文自然语言描述，直接喂 system prompt 用。
 * 覆盖 name、全部数值字段、interests、obsession、quirks。
 */
export function summarizePersona(state: PersonaState): string {
  const t = state.temperament;
  const parts: string[] = [];

  parts.push(
    state.name
      ? `${state.name}目前心情${state.mood}/100，精力${state.energy}/100，亲密度${state.intimacy}/100。`
      : `一个尚未命名的人格：心情${state.mood}/100，精力${state.energy}/100，亲密度${state.intimacy}/100。`,
  );

  parts.push(
    `性格倾向：外向${t.extraversion}/100，好奇${t.curiosity}/100，懒惰${t.laziness}/100，温暖${t.warmth}/100。`,
  );

  const interestKeys = Object.keys(state.interests);
  if (interestKeys.length > 0) {
    const listing = interestKeys
      .map((key) => `${key}（${state.interests[key]}/100）`)
      .join('、');
    parts.push(`当前兴趣：${listing}。`);
  } else {
    parts.push('尚未形成明显兴趣。');
  }

  if (state.currentObsession) {
    parts.push(`最近的执念是「${state.currentObsession}」。`);
  }

  if (state.quirks.length > 0) {
    parts.push(`小癖好：${state.quirks.join('；')}。`);
  }

  return parts.join('');
}
