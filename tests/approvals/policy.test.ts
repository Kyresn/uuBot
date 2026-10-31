import { describe, expect, it } from 'vitest';
import { canonicalJson, classify, fingerprintPayload } from '../../src/approvals/policy.js';
import type { ApprovalPayload } from '../../src/approvals/types.js';

function capability(declaredPermissions: string[]): ApprovalPayload {
  return {
    kind: 'capability.activate',
    plugin: 'demo',
    version: '1.0.0',
    fingerprint: 'abc',
    declaredPermissions,
    toolNames: [],
  };
}

describe('classify', () => {
  it('rates capability.activate as human', () => {
    expect(classify(capability([]))).toEqual({ tier: 'human' });
  });

  it('rates control.command as human', () => {
    const payload: ApprovalPayload = {
      kind: 'control.command',
      intent: 'group.silence',
      args: { minutes: 30 },
    };
    expect(classify(payload)).toEqual({ tier: 'human' });
  });

  it('refuses memory + net at propose time', () => {
    expect(classify(capability(['memory', 'net']))).toEqual({
      tier: 'human',
      refuse: 'lethal_trifecta',
    });
  });

  it('refuses net + fs:write at propose time', () => {
    expect(classify(capability(['net', 'fs:write']))).toEqual({
      tier: 'human',
      refuse: 'lethal_trifecta',
    });
  });

  it('does not refuse benign permission combinations', () => {
    expect(classify(capability(['memory', 'fs:read']))).toEqual({ tier: 'human' });
    expect(classify(capability(['net', 'fs:read']))).toEqual({ tier: 'human' });
  });

  it('throws on an unknown kind', () => {
    const payload = { kind: 'persona.change', delta: 1 } as unknown as ApprovalPayload;
    expect(() => classify(payload)).toThrow();
  });
});

describe('canonicalJson', () => {
  it('sorts object keys recursively so fingerprints are order-independent', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
    );
  });

  it('keeps array order significant', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe('fingerprintPayload', () => {
  it('is stable across key order and differs when a value changes', () => {
    const a = fingerprintPayload({ kind: 'control.command', intent: 'help.read', args: {} });
    const b = fingerprintPayload({ args: {}, intent: 'help.read', kind: 'control.command' });
    const c = fingerprintPayload({ kind: 'control.command', intent: 'status.read', args: {} });

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
