import { describe, it, expect } from 'vitest';
import {
  importFromEnv,
  maskHarnessConfig,
  parseHarnessConfig,
  type HarnessConfig,
} from '../../src/config/harness-schema.js';

function qqSection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: false,
    wsToken: '',
    wsHost: '127.0.0.1',
    wsPort: 3001,
    ownerId: '',
    selfId: '',
    controlEnabled: true,
    controlNl: true,
    nlMinConfidence: 0.75,
    minReplyGapMs: 90_000,
    groupAllowlist: [],
    groupDenylist: [],
    privateAllowlist: [],
    privateDenylist: [],
    privateOpen: false,
    proactive: {
      enabled: false,
      minGapMs: 21_600_000,
      dailyMax: 2,
      quietStart: '23:00',
      quietEnd: '08:00',
      intervalMs: 1_800_000,
    },
    ...overrides,
  };
}

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    importedFromEnv: false,
    tick: { fastMs: 300_000, slowMs: 3_600_000, wakeDebounceMs: 2_000 },
    http: { timeoutMs: 120_000 },
    redline: { fallbackText: '这个我不聊。' },
    qq: qqSection(),
    capability: { autoActivate: false },
    ...overrides,
  };
}

function withQq(overrides: Record<string, unknown>): Record<string, unknown> {
  return baseConfig({ qq: qqSection(overrides) });
}

function withProactive(overrides: Record<string, unknown>): Record<string, unknown> {
  return withQq({
    proactive: {
      enabled: false,
      minGapMs: 21_600_000,
      dailyMax: 2,
      quietStart: '23:00',
      quietEnd: '08:00',
      intervalMs: 1_800_000,
      ...overrides,
    },
  });
}

function expectInvalid(value: unknown, field: string): void {
  expect(parseHarnessConfig(value)).toEqual({ ok: false, code: 'invalid_field', field });
}

describe('parseHarnessConfig', () => {
  it('accepts a complete config and returns brand-new nested objects', () => {
    const input = baseConfig();
    const parsed = parseHarnessConfig(input);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value.version).toBe(1);
    expect(parsed.value.importedFromEnv).toBe(false);
    expect(parsed.value.tick).toEqual({ fastMs: 300_000, slowMs: 3_600_000, wakeDebounceMs: 2_000 });
    expect(parsed.value.qq.proactive.quietStart).toBe('23:00');

    expect(parsed.value).not.toBe(input);
    expect(parsed.value.tick).not.toBe((input as { tick: unknown }).tick);
    expect(parsed.value.qq).not.toBe((input as { qq: unknown }).qq);
    expect(parsed.value.qq.proactive).not.toBe(
      ((input as { qq: { proactive: unknown } }).qq).proactive,
    );
    expect(parsed.value.qq.groupAllowlist).not.toBe(
      ((input as { qq: { groupAllowlist: unknown } }).qq).groupAllowlist,
    );
  });

  it('fills every section with defaults when only the version is present', () => {
    const parsed = parseHarnessConfig({ version: 1 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value).toEqual({
      version: 1,
      importedFromEnv: false,
      tick: { fastMs: 300_000, slowMs: 3_600_000, wakeDebounceMs: 3_000 },
      http: { timeoutMs: 120_000 },
      redline: { fallbackText: '这个我不聊。' },
      qq: {
        enabled: false,
        wsToken: '',
        wsHost: '127.0.0.1',
        wsPort: 3001,
        ownerId: '',
        selfId: '',
        controlEnabled: true,
        controlNl: true,
        nlMinConfidence: 0.75,
        minReplyGapMs: 90_000,
        groupAllowlist: [],
        groupDenylist: [],
        privateAllowlist: [],
        privateDenylist: [],
        privateOpen: false,
        proactive: {
          enabled: false,
          minGapMs: 21_600_000,
          dailyMax: 2,
          quietStart: '23:00',
          quietEnd: '08:00',
          intervalMs: 1_800_000,
        },
      },
      capability: { autoActivate: false },
    });
  });

  it('rejects a non-object candidate', () => {
    expect(parseHarnessConfig(null)).toEqual({ ok: false, code: 'invalid_config' });
    expect(parseHarnessConfig([])).toEqual({ ok: false, code: 'invalid_config' });
  });

  it('rejects versions other than 1', () => {
    expect(parseHarnessConfig(baseConfig({ version: 2 }))).toEqual({
      ok: false,
      code: 'unsupported_version',
      field: 'version',
    });
    expect(parseHarnessConfig({ version: '1' })).toMatchObject({ ok: false });
  });

  it('rejects unknown top-level keys', () => {
    expectInvalid(baseConfig({ extra: true }), 'extra');
  });

  it('rejects unknown keys in every nested section', () => {
    expectInvalid(baseConfig({ tick: { fastMs: 300_000, slowMs: 3_600_000, surprise: 1 } }), 'tick.surprise');
    expectInvalid(baseConfig({ http: { timeoutMs: 1_000, surprise: 1 } }), 'http.surprise');
    expectInvalid(baseConfig({ redline: { fallbackText: 'x', surprise: 1 } }), 'redline.surprise');
    expectInvalid(withQq({ surprise: 1 }), 'qq.surprise');
    expectInvalid(withProactive({ surprise: 1 }), 'qq.proactive.surprise');
    expectInvalid(baseConfig({ capability: { autoActivate: false, surprise: 1 } }), 'capability.surprise');
  });

  it('rejects non-object sections', () => {
    expectInvalid(baseConfig({ tick: [] }), 'tick');
    expectInvalid(baseConfig({ http: 'fast' }), 'http');
    expectInvalid(baseConfig({ redline: null }), 'redline');
    expectInvalid(baseConfig({ qq: 1 }), 'qq');
    expectInvalid(withQq({ proactive: [] }), 'qq.proactive');
    expectInvalid(baseConfig({ capability: true }), 'capability');
  });

  it('enforces the tick ranges and the fast < slow relation', () => {
    expectInvalid(
      baseConfig({ tick: { fastMs: 999, slowMs: 3_600_000, wakeDebounceMs: 2_000 } }),
      'tick.fastMs',
    );
    expectInvalid(
      baseConfig({ tick: { fastMs: 3_600_001, slowMs: 3_600_000, wakeDebounceMs: 2_000 } }),
      'tick.fastMs',
    );
    expectInvalid(
      baseConfig({ tick: { fastMs: 3_600_000, slowMs: 3_600_000, wakeDebounceMs: 2_000 } }),
      'tick.fastMs',
    );
    expectInvalid(
      baseConfig({ tick: { fastMs: 3_600_000, slowMs: 3_000_000, wakeDebounceMs: 2_000 } }),
      'tick.fastMs',
    );
    expectInvalid(
      baseConfig({ tick: { fastMs: 1_000.5, slowMs: 3_600_000, wakeDebounceMs: 2_000 } }),
      'tick.fastMs',
    );
    expectInvalid(
      baseConfig({ tick: { fastMs: 1_000, slowMs: 86_400_001, wakeDebounceMs: 2_000 } }),
      'tick.slowMs',
    );
    expectInvalid(
      baseConfig({ tick: { fastMs: 1_000, slowMs: 3_600_000, wakeDebounceMs: -1 } }),
      'tick.wakeDebounceMs',
    );
    expectInvalid(
      baseConfig({ tick: { fastMs: 1_000, slowMs: 3_600_000, wakeDebounceMs: 600_001 } }),
      'tick.wakeDebounceMs',
    );
  });

  it('accepts the tick boundaries', () => {
    expect(
      parseHarnessConfig(
        baseConfig({ tick: { fastMs: 1_000, slowMs: 1_001, wakeDebounceMs: 0 } }),
      ).ok,
    ).toBe(true);
    expect(
      parseHarnessConfig(
        baseConfig({ tick: { fastMs: 3_600_000, slowMs: 86_400_000, wakeDebounceMs: 600_000 } }),
      ).ok,
    ).toBe(true);
  });

  it('enforces the http timeout range', () => {
    expectInvalid(baseConfig({ http: { timeoutMs: 999 } }), 'http.timeoutMs');
    expectInvalid(baseConfig({ http: { timeoutMs: 600_001 } }), 'http.timeoutMs');
    expectInvalid(baseConfig({ http: { timeoutMs: 1_000.5 } }), 'http.timeoutMs');
    expect(parseHarnessConfig(baseConfig({ http: { timeoutMs: 1_000 } })).ok).toBe(true);
    expect(parseHarnessConfig(baseConfig({ http: { timeoutMs: 600_000 } })).ok).toBe(true);
  });

  it('requires a non-empty redline fallback text without control characters', () => {
    expectInvalid(baseConfig({ redline: { fallbackText: '' } }), 'redline.fallbackText');
    expectInvalid(baseConfig({ redline: { fallbackText: 'a\nb' } }), 'redline.fallbackText');
    expectInvalid(baseConfig({ redline: { fallbackText: 42 } }), 'redline.fallbackText');
    expect(parseHarnessConfig(baseConfig({ redline: { fallbackText: '换一句。' } })).ok).toBe(true);
  });

  it('enforces the QQ numeric ranges', () => {
    expectInvalid(withQq({ nlMinConfidence: -0.1 }), 'qq.nlMinConfidence');
    expectInvalid(withQq({ nlMinConfidence: 1.1 }), 'qq.nlMinConfidence');
    expectInvalid(withQq({ nlMinConfidence: '0.5' }), 'qq.nlMinConfidence');
    expectInvalid(withQq({ minReplyGapMs: -1 }), 'qq.minReplyGapMs');
    expectInvalid(withQq({ minReplyGapMs: 86_400_001 }), 'qq.minReplyGapMs');
    expectInvalid(withProactive({ dailyMax: -1 }), 'qq.proactive.dailyMax');
    expectInvalid(withProactive({ dailyMax: 101 }), 'qq.proactive.dailyMax');
    expectInvalid(withProactive({ dailyMax: 1.5 }), 'qq.proactive.dailyMax');
    // 0 是合法的：语义是「让内核挑一个临时端口」，测试与多实例场景要用。
    expect(parseHarnessConfig(withQq({ wsPort: 0 })).ok).toBe(true);
    expectInvalid(withQq({ wsPort: -1 }), 'qq.wsPort');
    expectInvalid(withQq({ wsPort: 65_536 }), 'qq.wsPort');
    expectInvalid(withQq({ wsPort: 3_001.5 }), 'qq.wsPort');
    expectInvalid(withProactive({ minGapMs: -1 }), 'qq.proactive.minGapMs');
    expectInvalid(withProactive({ intervalMs: 0 }), 'qq.proactive.intervalMs');

    expect(parseHarnessConfig(withQq({ nlMinConfidence: 0 })).ok).toBe(true);
    expect(parseHarnessConfig(withQq({ nlMinConfidence: 1 })).ok).toBe(true);
    expect(parseHarnessConfig(withQq({ minReplyGapMs: 0 })).ok).toBe(true);
    expect(parseHarnessConfig(withQq({ minReplyGapMs: 86_400_000 })).ok).toBe(true);
    expect(parseHarnessConfig(withProactive({ dailyMax: 0 })).ok).toBe(true);
    expect(parseHarnessConfig(withProactive({ dailyMax: 100 })).ok).toBe(true);
    expect(parseHarnessConfig(withQq({ wsPort: 1 })).ok).toBe(true);
    expect(parseHarnessConfig(withQq({ wsPort: 65_535 })).ok).toBe(true);
  });

  it('validates HH:MM clock fields strictly', () => {
    for (const quietStart of ['24:00', '23:60', '7:00', '07:5', 'abc', '', '07:00:00']) {
      expectInvalid(withProactive({ quietStart }), 'qq.proactive.quietStart');
    }
    for (const quietEnd of ['24:00', '23:60', '-1:00']) {
      expectInvalid(withProactive({ quietEnd }), 'qq.proactive.quietEnd');
    }
    expect(parseHarnessConfig(withProactive({ quietStart: '00:00' })).ok).toBe(true);
    expect(parseHarnessConfig(withProactive({ quietStart: '23:59' })).ok).toBe(true);
  });

  it('validates QQ identities and hosts', () => {
    expect(parseHarnessConfig(withQq({ ownerId: '42' })).ok).toBe(true);
    expect(parseHarnessConfig(withQq({ ownerId: '00042' })).ok).toBe(true);
    expect(parseHarnessConfig(withQq({ ownerId: '' })).ok).toBe(true);
    expectInvalid(withQq({ ownerId: 'abc' }), 'qq.ownerId');
    expectInvalid(withQq({ ownerId: '99999999999999999999' }), 'qq.ownerId');
    expectInvalid(withQq({ selfId: '12x' }), 'qq.selfId');
    expect(parseHarnessConfig(withQq({ selfId: '10001' })).ok).toBe(true);
    expectInvalid(withQq({ wsHost: '' }), 'qq.wsHost');
    expectInvalid(withQq({ wsHost: '127.0.0.1\n' }), 'qq.wsHost');
    expect(parseHarnessConfig(withQq({ wsHost: '0.0.0.0' })).ok).toBe(true);
  });

  it('validates allow and deny lists', () => {
    expect(parseHarnessConfig(withQq({ groupAllowlist: ['1', '2'] })).ok).toBe(true);
    expectInvalid(withQq({ groupAllowlist: '1,2' }), 'qq.groupAllowlist');
    expectInvalid(withQq({ groupDenylist: [''] }), 'qq.groupDenylist[0]');
    expectInvalid(withQq({ privateAllowlist: [1] }), 'qq.privateAllowlist[0]');
    expectInvalid(withQq({ privateDenylist: ['a\nb'] }), 'qq.privateDenylist[0]');
  });

  it('rejects masked wsToken placeholders', () => {
    for (const wsToken of ['tok…abcd', 'tok••••abcd', 'tok***abcd', '…', '••', '***']) {
      expectInvalid(withQq({ wsToken }), 'qq.wsToken');
    }
  });

  it('accepts a real wsToken and drops the read-only masked echo fields', () => {
    const parsed = parseHarnessConfig(
      withQq({
        wsToken: 'real-token-0123456789',
        hasWsToken: true,
        wsTokenLast4: '6789',
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.qq.wsToken).toBe('real-token-0123456789');
    expect(parsed.value.qq).not.toHaveProperty('hasWsToken');
    expect(parsed.value.qq).not.toHaveProperty('wsTokenLast4');
  });

  it('does not pollute prototypes through __proto__ or constructor keys', () => {
    const topLevel = JSON.parse(
      '{"version":1,"__proto__":{"polluted":true}}',
    ) as unknown;
    expect(parseHarnessConfig(topLevel)).toMatchObject({ ok: false, code: 'invalid_field' });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();

    const nested = JSON.parse(
      '{"version":1,"qq":{"__proto__":{"polluted":true}}}',
    ) as unknown;
    expect(parseHarnessConfig(nested)).toMatchObject({ ok: false, code: 'invalid_field' });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();

    const ctor = JSON.parse(
      '{"version":1,"tick":{"constructor":{"prototype":{"polluted":true}}}}',
    ) as unknown;
    expect(parseHarnessConfig(ctor)).toMatchObject({ ok: false, code: 'invalid_field' });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('maskHarnessConfig', () => {
  const secret = 'super-secret-token-0123456789';

  function parsedWith(token: string): HarnessConfig {
    const parsed = parseHarnessConfig(withQq({ wsToken: token }));
    if (!parsed.ok) throw new Error(`config should parse: ${parsed.code}`);
    return parsed.value;
  }

  it('never returns the token and exposes only hasWsToken / wsTokenLast4', () => {
    const masked = maskHarnessConfig(parsedWith(secret)) as {
      qq: Record<string, unknown>;
    };
    expect(masked.qq['hasWsToken']).toBe(true);
    expect(masked.qq['wsTokenLast4']).toBe('6789');
    expect(masked.qq).not.toHaveProperty('wsToken');
    expect(JSON.stringify(masked)).not.toContain(secret);
  });

  it('gives last4 at exactly 12 characters and hides it below that', () => {
    const atTwelve = maskHarnessConfig(parsedWith('abcdefghijkl')) as {
      qq: Record<string, unknown>;
    };
    expect(atTwelve.qq['wsTokenLast4']).toBe('ijkl');

    const short = maskHarnessConfig(parsedWith('short')) as {
      qq: Record<string, unknown>;
    };
    expect(short.qq['hasWsToken']).toBe(true);
    expect(short.qq).not.toHaveProperty('wsTokenLast4');
  });

  it('reports an empty token as absent', () => {
    const masked = maskHarnessConfig(parsedWith('')) as {
      qq: Record<string, unknown>;
    };
    expect(masked.qq['hasWsToken']).toBe(false);
    expect(masked.qq).not.toHaveProperty('wsTokenLast4');
  });

  it('returns fresh nested objects and leaves the source untouched', () => {
    const config = parsedWith(secret);
    const masked = maskHarnessConfig(config) as {
      tick: Record<string, unknown>;
      qq: Record<string, unknown>;
      qqProactive?: unknown;
    };
    expect(masked.tick).not.toBe(config.tick);
    expect(masked.qq).not.toBe(config.qq);
    expect(config.qq.wsToken).toBe(secret);
  });
});

describe('importFromEnv', () => {
  it('imports the whitelisted keys once and marks importedFromEnv', () => {
    const imported = importFromEnv({
      TICK_FAST_MS: '60000',
      TICK_SLOW_MS: '7200000',
      WAKE_DEBOUNCE_MS: '1500',
      HTTP_TIMEOUT_MS: '30000',
      REDLINE_FALLBACK_TEXT: ' 换个话题。 ',
      QQ_WS_TOKEN: ' token-0123456789 ',
      QQ_WS_HOST: '0.0.0.0',
      QQ_WS_PORT: '4001',
      QQ_OWNER_ID: '00042',
      QQ_SELF_ID: '10001',
      QQ_CONTROL_ENABLED: '0',
      QQ_CONTROL_NL: '1',
      QQ_NL_MIN_CONFIDENCE: '0.5',
      QQ_MIN_REPLY_GAP_MS: '0',
      QQ_GROUP_ALLOWLIST: '1, 2',
      QQ_GROUP_DENYLIST: '3',
      QQ_PRIVATE_ALLOWLIST: '4',
      QQ_PRIVATE_DENYLIST: '0200',
      QQ_PRIVATE_OPEN: 'yes',
      QQ_PROACTIVE_ENABLED: 'true',
      QQ_PROACTIVE_MIN_GAP_MS: '3600000',
      QQ_PROACTIVE_DAILY_MAX: '5',
      QQ_PROACTIVE_QUIET_START: '7:05',
      QQ_PROACTIVE_QUIET_END: '22:30',
      QQ_PROACTIVE_INTERVAL_MS: '60000',
    });

    expect(imported.importedFromEnv).toBe(true);
    expect(imported.tick).toEqual({ fastMs: 60_000, slowMs: 7_200_000, wakeDebounceMs: 1_500 });
    expect(imported.http.timeoutMs).toBe(30_000);
    expect(imported.redline.fallbackText).toBe('换个话题。');
    expect(imported.qq).toMatchObject({
      enabled: true,
      wsToken: 'token-0123456789',
      wsHost: '0.0.0.0',
      wsPort: 4_001,
      ownerId: '42',
      selfId: '10001',
      controlEnabled: false,
      controlNl: true,
      nlMinConfidence: 0.5,
      minReplyGapMs: 0,
      groupAllowlist: ['1', '2'],
      groupDenylist: ['3'],
      privateAllowlist: ['4'],
      privateDenylist: ['200'],
      privateOpen: true,
      proactive: {
        enabled: true,
        minGapMs: 3_600_000,
        dailyMax: 5,
        quietStart: '07:05',
        quietEnd: '22:30',
        intervalMs: 60_000,
      },
    });
  });

  it('produces the documented defaults when the environment is empty', () => {
    const imported = importFromEnv({});
    expect(imported.importedFromEnv).toBe(true);
    expect(imported.tick).toEqual({ fastMs: 300_000, slowMs: 3_600_000, wakeDebounceMs: 3_000 });
    expect(imported.qq.enabled).toBe(false);
    expect(imported.qq.wsToken).toBe('');
    expect(imported.qq.controlEnabled).toBe(true);
    expect(imported.qq.controlNl).toBe(false);
    expect(imported.qq.proactive.quietStart).toBe('23:00');
    expect(parseHarnessConfig(imported).ok).toBe(true);
  });

  it('imports an ephemeral ws port of 0 instead of clamping it', () => {
    expect(importFromEnv({ QQ_WS_PORT: '0' }).qq.wsPort).toBe(0);
  });

  it('falls back per field when an environment value is out of range', () => {
    const imported = importFromEnv({
      TICK_FAST_MS: '1',
      TICK_SLOW_MS: '0',
      WAKE_DEBOUNCE_MS: '-5',
      HTTP_TIMEOUT_MS: '600001',
      QQ_WS_PORT: '99999',
      QQ_NL_MIN_CONFIDENCE: '2',
      QQ_MIN_REPLY_GAP_MS: 'abc',
      QQ_PROACTIVE_DAILY_MAX: 'x',
      QQ_PROACTIVE_QUIET_START: '25:00',
      QQ_OWNER_ID: 'not-a-number',
    });
    expect(imported.tick).toEqual({ fastMs: 300_000, slowMs: 3_600_000, wakeDebounceMs: 3_000 });
    expect(imported.http.timeoutMs).toBe(120_000);
    expect(imported.qq.wsPort).toBe(3_001);
    expect(imported.qq.nlMinConfidence).toBe(0.75);
    expect(imported.qq.minReplyGapMs).toBe(90_000);
    expect(imported.qq.proactive.dailyMax).toBe(2);
    expect(imported.qq.proactive.quietStart).toBe('23:00');
    expect(imported.qq.ownerId).toBe('');
    expect(parseHarnessConfig(imported).ok).toBe(true);
  });

  it('repairs an inverted tick relation instead of importing an invalid config', () => {
    const imported = importFromEnv({ TICK_FAST_MS: '3600000', TICK_SLOW_MS: '3600000' });
    expect(imported.tick.fastMs).toBeLessThan(imported.tick.slowMs);
    expect(parseHarnessConfig(imported).ok).toBe(true);
  });

  it('enables QQ only when a token is present', () => {
    expect(importFromEnv({ QQ_WS_TOKEN: 'tok' }).qq.enabled).toBe(true);
    expect(importFromEnv({ QQ_WS_TOKEN: '   ' }).qq.enabled).toBe(false);
  });

  it('treats the control switch as explicit-only, never owner-derived', () => {
    // 没有开关 = 没有显式关闭：网页控制面不能被没有 owner 的安装误关。
    expect(importFromEnv({ QQ_OWNER_ID: '42' }).qq.controlEnabled).toBe(true);
    expect(importFromEnv({}).qq.controlEnabled).toBe(true);
    expect(importFromEnv({ QQ_OWNER_ID: '42', QQ_CONTROL_ENABLED: '0' }).qq.controlEnabled).toBe(
      false,
    );
    // 没有 owner 的显式关闭同样必须被保留。
    expect(importFromEnv({ QQ_CONTROL_ENABLED: '0' }).qq.controlEnabled).toBe(false);
  });

  it('never imports a masked token placeholder from the environment', () => {
    expect(importFromEnv({ QQ_WS_TOKEN: 'tok…abcd' }).qq.wsToken).toBe('');
  });

  it('does not read keys outside the whitelist', () => {
    const imported = importFromEnv({ WEB_CONSOLE_TOKEN: 'web-secret', DATA_DIR: '/tmp' });
    expect(JSON.stringify(imported)).not.toContain('web-secret');
  });
});
