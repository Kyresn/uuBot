import { describe, it, expect } from 'vitest';
import {
  createPersonaState,
  patchPersonaState,
  summarizePersona,
  type PersonaState,
} from '../src/persona/persona.js';

const ZERO_RNG = () => 0;
const HALF_RNG = () => 0.5;
const ONE_RNG = () => 0.999999;

describe('createPersonaState', () => {
  it('blank seed: name=null, quirks=[], empty interests, obsession=null', () => {
    const p = createPersonaState(HALF_RNG);
    expect(p.name).toBeNull();
    expect(p.quirks).toEqual([]);
    expect(p.interests).toEqual({});
    expect(p.currentObsession).toBeNull();
  });

  it('rng [0.5,...] gives deterministic 50 for every numeric field', () => {
    const p = createPersonaState(HALF_RNG);
    expect(p.mood).toBe(50);
    expect(p.energy).toBe(50);
    expect(p.intimacy).toBe(50);
    expect(p.temperament.extraversion).toBe(50);
    expect(p.temperament.curiosity).toBe(50);
    expect(p.temperament.laziness).toBe(50);
    expect(p.temperament.warmth).toBe(50);
  });

  it('numeric initial values stay within [30,70] across rng extremes', () => {
    for (const rng of [ZERO_RNG, ONE_RNG]) {
      const p = createPersonaState(rng);
      const nums = [
        p.mood,
        p.energy,
        p.intimacy,
        p.temperament.extraversion,
        p.temperament.curiosity,
        p.temperament.laziness,
        p.temperament.warmth,
      ];
      for (const n of nums) {
        expect(n).toBeGreaterThanOrEqual(30);
        expect(n).toBeLessThanOrEqual(70);
        expect(Number.isInteger(n)).toBe(true);
      }
    }
  });

  it('different rng values give different seeds', () => {
    const a = createPersonaState(ZERO_RNG);
    const b = createPersonaState(HALF_RNG);
    expect(a.mood).not.toBe(b.mood);
  });
});

describe('patchPersonaState', () => {
  const base = createPersonaState(HALF_RNG); // all numeric = 50

  it('clamps patch target to [0,100] (near-ceiling field reaches 100)', () => {
    const nearTop: PersonaState = { ...base, mood: 95 };
    const patched = patchPersonaState(nearTop, { mood: 200 });
    expect(patched.mood).toBe(100); // target clamped to 100, drift +5 allowed
    const nearBottom: PersonaState = { ...base, mood: 5 };
    const floor = patchPersonaState(nearBottom, { mood: -50 });
    expect(floor.mood).toBe(0); // target clamped to 0, drift -5 allowed
  });

  it('caps per-patch delta at |10| (50 + 100-patch => 60)', () => {
    const patched = patchPersonaState(base, { mood: 100 });
    expect(patched.mood).toBe(60);
  });

  it('caps per-patch delta downward (50 patch to 0 => 40)', () => {
    const patched = patchPersonaState(base, { mood: 0 });
    expect(patched.mood).toBe(40);
  });

  it('applies same delta rule per interest key and creates new keys clamped', () => {
    const withInterest: PersonaState = { ...base, interests: { chess: 50 } };
    const patched = patchPersonaState(withInterest, { interests: { chess: 999, piano: 25 } });
    expect(patched.interests.chess).toBe(60); // capped +10
    expect(patched.interests.piano).toBe(10); // new key starts at 0, delta cap => 10
  });

  it('returns a new object and does not mutate the old one', () => {
    const snapshot = structuredClone(base);
    const patched = patchPersonaState(base, { mood: 80, quirks: ['taps table'] });
    expect(patched).not.toBe(base);
    expect(patched.quirks).toEqual(['taps table']);
    expect(base).toEqual(snapshot);
    expect(base.mood).toBe(50);
    expect(base.quirks).toEqual([]);
  });

  it('temperament fields obey the same delta cap and clamp', () => {
    const patched = patchPersonaState(base, { temperament: { extraversion: 50, curiosity: 50, warmth: 100, laziness: -20 } });
    expect(patched.temperament.warmth).toBe(60); // capped +10
    expect(patched.temperament.laziness).toBe(40); // capped -10
    expect(patched.temperament.extraversion).toBe(50); // untouched
  });

  it('empty patch returns equivalent new object', () => {
    const patched = patchPersonaState(base, {});
    expect(patched).not.toBe(base);
    expect(patched).toEqual(base);
  });
});

describe('summarizePersona', () => {
  it('outputs a Chinese sentence containing the numeric fields', () => {
    const p = createPersonaState(HALF_RNG);
    const text = summarizePersona(p);
    expect(text).toContain('50');
    expect(text).toContain('心情');
    expect(text).toContain('精力');
    expect(text).toContain('亲密度');
    expect(text).toContain('外向');
    expect(text).toContain('好奇');
    expect(text).toContain('懒惰');
    expect(text).toContain('温暖');
  });

  it('handles null name and empty quirks gracefully', () => {
    const p = createPersonaState(HALF_RNG);
    const text = summarizePersona(p);
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });

  it('mentions name, quirks, interests and obsession when present', () => {
    const p: PersonaState = {
      ...createPersonaState(HALF_RNG),
      name: '小雾',
      quirks: ['喜欢数楼梯', '说话带省略号'],
      interests: { 天文: 62, 烘焙: 45 },
      currentObsession: '收集云的形状',
    };
    const text = summarizePersona(p);
    expect(text).toContain('小雾');
    expect(text).toContain('数楼梯');
    expect(text).toContain('天文');
    expect(text).toContain('收集云的形状');
  });
});
