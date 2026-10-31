import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { ConfigStore } from '../src/config/store.js';
import type { ApprovalEvent, ApprovalRecord } from '../src/approvals/types.js';
import { PerceptionQueue } from '../src/core/events.js';
import type { TranscriptRecord } from '../src/web/transcript.js';
import {
  activeChannelLabels,
  channelPrefixOf,
  controlPlaneNotice,
  controlSurfaceEnabled,
  controlTimingsFromEnv,
  createApprovalNotifier,
  createOutboundGate,
  createShutdown,
  noEndpointsMessage,
  qqRuntimeFromConfig,
  settingsEnv,
  transcriptOnPush,
  type ShutdownDeps,
} from '../src/startup.js';
import { importFromEnv } from '../src/config/harness-schema.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeShutdownDeps(order: string[], loopGate: Promise<void>): ShutdownDeps {
  return {
    log: () => {},
    webServer: {
      start: async () => {},
      stop: async () => {
        order.push('web-stop');
      },
      port: () => 0,
      stopAcceptingWrites: () => {
        order.push('stop-writes');
      },
    },
    store: {
      close: async () => {
        order.push('store-close');
      },
    } as unknown as ConfigStore,
    harnessStore: {
      close: async () => {
        order.push('harness-close');
      },
    },
    harnessReload: {
      stop: () => {
        order.push('harness-reload-stop');
      },
    },
    loop: {
      stop: async () => {
        order.push('loop-start');
        await loopGate;
        order.push('loop-end');
      },
    },
    control: {
      stop: async () => {
        order.push('control-stop');
      },
    },
    approvals: {
      stop: async () => {
        order.push('approvals-stop');
      },
    },
    audit: {
      flush: async () => {
        order.push('audit-flush');
      },
    },
    proactive: {
      stop: async () => {
        order.push('proactive-stop');
      },
    },
    host: {
      stopAll: async () => {
        order.push('host-stop');
      },
    },
    registry: {
      stopAll: async () => {
        order.push('registry-stop');
      },
    },
    chatBridge: {
      close: () => {
        order.push('chat-close');
      },
    },
    transcript: {
      flush: async () => {
        order.push('transcript-flush');
      },
    },
  };
}

describe('createShutdown', () => {
  it('reports a re-entrant signal as busy and still runs the full sequence once', async () => {
    const order: string[] = [];
    const gate = deferred();
    const shutdown = createShutdown(makeShutdownDeps(order, gate.promise));

    const first = shutdown('SIGINT');
    const second = shutdown('SIGTERM');
    await expect(second).resolves.toBe('busy');

    // The first shutdown is parked inside loop.stop(); nothing after it may run yet.
    expect(order).toContain('loop-start');
    expect(order).not.toContain('host-stop');
    expect(order).not.toContain('web-stop');

    gate.resolve();
    await expect(first).resolves.toBe('done');
    expect(order).toEqual([
      'stop-writes',
      'control-stop',
      'harness-close',
      'harness-reload-stop',
      'store-close',
      'loop-start',
      'loop-end',
      'proactive-stop',
      'transcript-flush',
      'approvals-stop',
      'audit-flush',
      'host-stop',
      'registry-stop',
      'chat-close',
      'web-stop',
    ]);
  });

  it('never runs the sequence again after it completed', async () => {
    const order: string[] = [];
    const shutdown = createShutdown(makeShutdownDeps(order, Promise.resolve()));

    await expect(shutdown('SIGINT')).resolves.toBe('done');
    const before = [...order];
    await expect(shutdown('SIGTERM')).resolves.toBe('busy');
    expect(order).toEqual(before);
  });
});

describe('startup assembly order', () => {
  /**
   * `src/index.ts` 一导入就启动进程，装配顺序只能按源码断言（同
   * tests/control/intents.test.ts 的源码守卫）。顺序是契约：
   * `harness.json` 先于 `models.json` 加载，关闭时两者都被关闭。
   */
  it('loads harness.json before models.json and closes both on shutdown', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');

    const harnessConstruct = source.indexOf('new HarnessStore(');
    const harnessLoad = source.search(/const loadedHarness = await harnessStore\.load\(\)/);
    const modelsConstruct = source.indexOf('const store = new ConfigStore(');
    const modelsLoad = source.search(/const loaded = await store\.load\(\)/);

    for (const [name, index] of [
      ['HarnessStore construction', harnessConstruct],
      ['HarnessStore load', harnessLoad],
      ['ConfigStore construction', modelsConstruct],
      ['ConfigStore load', modelsLoad],
    ] as const) {
      expect(index, `${name} must stay in src/index.ts`).toBeGreaterThan(-1);
    }

    expect(harnessConstruct).toBeLessThan(modelsConstruct);
    expect(harnessLoad).toBeLessThan(modelsLoad);

    // 迁移那一次（文件刚被创建）也必须打「QQ_* env is ignored」：只看
    // harnessFileExisted 会漏掉正在迁移的那次启动。
    expect(source).toContain('harnessFileExisted || loadedHarness.config.importedFromEnv');

    // 关闭序列拿到的必须是两个真实句柄，而不是可选的空实现。
    const shutdownStart = source.indexOf('const shutdown = createShutdown({');
    const shutdownEnd = source.indexOf('const onSignal', shutdownStart);
    expect(shutdownStart).toBeGreaterThan(-1);
    expect(shutdownEnd).toBeGreaterThan(shutdownStart);
    const shutdownBlock = source.slice(shutdownStart, shutdownEnd);
    expect(shutdownBlock).toContain('harnessStore,');
    expect(shutdownBlock).toContain('chatBridge,');
  });
});

describe('noEndpointsMessage', () => {
  it('starts without endpoints and points at the web console model page', () => {
    const message = noEndpointsMessage('/tmp/console-config', 'no_config');
    expect(message).toContain('models.json');
    expect(message).toContain('web console');
    expect(message).toContain('模型');
    expect(message).toContain('models.json.bak');
    // 端点只来自 models.json：不能再让用户去改 .env 的端点键。
    expect(message).not.toContain('NIM_API_KEYS');
    expect(message).not.toContain('then restart');
  });

  it('names the actual load error code instead of reusing the no-config hint', () => {
    for (const code of ['unsupported_version', 'build_failed', 'unreadable', 'invalid_json']) {
      const message = noEndpointsMessage('/tmp/console-config', code);
      expect(message).toContain(code);
      expect(message).not.toContain('NIM_API_KEYS');
      expect(message).not.toContain('web console');
    }
  });

  it('defaults to the no-config wording when no code is supplied', () => {
    expect(noEndpointsMessage('/tmp/console-config')).toContain('web console');
  });
});

describe('activeChannelLabels', () => {
  it('derives labels from the live plugin status, excluding stopped and non-channel plugins', () => {
    expect(
      activeChannelLabels([
        { name: 'qq', kind: 'channel', channelPrefix: 'qq', state: 'active' },
        { name: 'cli', kind: 'channel', channelPrefix: 'cli', state: 'stopped' },
        { name: 'memory', kind: 'capability', state: 'active' },
        { name: 'fallback', kind: 'channel', state: 'active' },
      ]),
    ).toEqual(['qq', 'fallback']);
  });

  it('reflects a later status snapshot instead of a startup-captured list', () => {
    const first = activeChannelLabels([
      { name: 'qq', kind: 'channel', channelPrefix: 'qq', state: 'active' },
    ]);
    const second = activeChannelLabels([
      { name: 'qq', kind: 'channel', channelPrefix: 'qq', state: 'failed' },
    ]);
    expect(first).toEqual(['qq']);
    expect(second).toEqual([]);
  });
});

describe('controlTimingsFromEnv', () => {
  it('defaults the approval and confirmation TTLs', () => {
    expect(controlTimingsFromEnv({})).toEqual({
      confirmTtlMs: 60_000,
      approvalTtlMs: 600_000,
    });
  });

  it('reads positive integers and ignores invalid values', () => {
    expect(
      controlTimingsFromEnv({
        CONTROL_CONFIRM_TTL_MS: '15000',
        CONTROL_APPROVAL_TTL_MS: '900000',
      }),
    ).toEqual({ confirmTtlMs: 15_000, approvalTtlMs: 900_000 });
    expect(
      controlTimingsFromEnv({ CONTROL_CONFIRM_TTL_MS: 'nope', CONTROL_APPROVAL_TTL_MS: '-1' }),
    ).toEqual({ confirmTtlMs: 60_000, approvalTtlMs: 600_000 });
  });
});

describe('settingsEnv', () => {
  it('removes the env keys that harness.json now owns and keeps the rest', () => {
    const env = settingsEnv({
      TICK_FAST_MS: '1.5',
      TICK_SLOW_MS: '2',
      WAKE_DEBOUNCE_MS: '3',
      HTTP_TIMEOUT_MS: '4',
      REDLINE_FALLBACK_TEXT: '旧话术',
      MAX_QUEUE_SIZE: '50',
      NIM_API_KEYS: 'k',
    });

    expect(env).toEqual({ MAX_QUEUE_SIZE: '50', NIM_API_KEYS: 'k' });
  });
});

describe('.env.example', () => {
  /** spec §2 目标 3：`.env` 只剩引导项，其余全部搬到 config/harness.json。 */
  const BOOTSTRAP_KEYS = [
    'WEB_CONSOLE_TOKEN',
    'WEB_PORT',
    'WEB_HOST',
    'WEB_ALLOW_REMOTE',
    'WEB_COOKIE_SECURE',
    'WEB_ALLOWED_HOSTS',
    'WEB_TRUSTED_PROXY',
    'CONFIG_DIR',
    'DATA_DIR',
    // 例外：compose 插值给 NapCat 的登录号 + 两个仍只从 env 读取的 TTL。
    'QQ_ACCOUNT',
    'CONTROL_CONFIRM_TTL_MS',
    'CONTROL_APPROVAL_TTL_MS',
  ];

  async function envExampleLines(): Promise<string[]> {
    const text = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
    return text.split(/\r?\n/);
  }

  function assignmentKeys(lines: readonly string[]): string[] {
    return lines
      .filter((line) => /^[A-Z0-9_]+=/.test(line))
      .map((line) => line.slice(0, line.indexOf('=')));
  }

  it('lists exactly the bootstrap keys and nothing else', async () => {
    const lines = await envExampleLines();
    expect(assignmentKeys(lines)).toEqual(BOOTSTRAP_KEYS);

    // 迁移到 harness.json 的键不能再出现在示例里，否则用户会以为改 env 有效。
    for (const retired of ['QQ_WS_TOKEN', 'QQ_OWNER_ID', 'TICK_FAST_MS', 'HTTP_TIMEOUT_MS']) {
      expect(lines.some((line) => line.startsWith(`${retired}=`))).toBe(false);
    }
  });

  it('documents every bootstrap key on the line directly above it', async () => {
    const lines = await envExampleLines();
    for (const key of assignmentKeys(lines)) {
      const index = lines.findIndex((line) => line.startsWith(`${key}=`));
      expect(index, `${key} must be present`).toBeGreaterThan(0);
      expect(
        lines[index - 1]?.trim().startsWith('#'),
        `${key} must have a comment directly above it`,
      ).toBe(true);
    }
  });

  it('spells out the migration rule: harness.json wins and QQ_* env is ignored', async () => {
    const text = (await envExampleLines()).join('\n');
    expect(text).toContain('config/harness.json');
    expect(text).toContain('QQ_*');
    expect(text).toMatch(/ignored|被忽略|不再读取/);
    expect(text).toContain('config/models.json');
  });
});

describe('qqRuntimeFromConfig', () => {
  it('keeps proactive messaging off by default and supplies the spec defaults', () => {
    expect(qqRuntimeFromConfig(importFromEnv({}).qq)).toEqual({
      minReplyGapMs: 90_000,
      ownerId: undefined,
      controlEnabled: true,
      controlExplicitOff: false,
      proactive: {
        enabled: false,
        minGapMs: 21_600_000,
        dailyMax: 2,
        quietStart: '23:00',
        quietEnd: '08:00',
        intervalMs: 1_800_000,
      },
    });
  });

  it('reads the owner and proactive overrides imported from the environment', () => {
    const runtime = qqRuntimeFromConfig(
      importFromEnv({
        QQ_OWNER_ID: ' 42 ',
        QQ_MIN_REPLY_GAP_MS: '5000',
        QQ_PROACTIVE_ENABLED: '1',
        QQ_PROACTIVE_MIN_GAP_MS: '1000',
        QQ_PROACTIVE_DAILY_MAX: '3',
        QQ_PROACTIVE_QUIET_START: '22:30',
        QQ_PROACTIVE_QUIET_END: '07:00',
        QQ_PROACTIVE_INTERVAL_MS: '60000',
      }).qq,
    );
    expect(runtime).toEqual({
      minReplyGapMs: 5_000,
      ownerId: '42',
      controlEnabled: true,
      controlExplicitOff: false,
      proactive: {
        enabled: true,
        minGapMs: 1_000,
        dailyMax: 3,
        quietStart: '22:30',
        quietEnd: '07:00',
        intervalMs: 60_000,
      },
    });
  });

  it('falls back to defaults on malformed values instead of throwing', () => {
    const runtime = qqRuntimeFromConfig(
      importFromEnv({
        QQ_OWNER_ID: 'abc',
        QQ_MIN_REPLY_GAP_MS: 'x',
        QQ_PROACTIVE_DAILY_MAX: 'x',
        QQ_PROACTIVE_QUIET_START: '25:00',
      }).qq,
    );
    expect(runtime.ownerId).toBeUndefined();
    expect(runtime.minReplyGapMs).toBe(90_000);
    expect(runtime.proactive.dailyMax).toBe(2);
    expect(runtime.proactive.quietStart).toBe('23:00');
  });

  it('rejects owner ids that the qq plugin would also reject', () => {
    // 17–20 位数字超出 Number.MAX_SAFE_INTEGER：插件侧禁用控制面，
    // 调度器不能拿一个四舍五入后的假号当目标。
    expect(
      qqRuntimeFromConfig(importFromEnv({ QQ_OWNER_ID: '99999999999999999999' }).qq).ownerId,
    ).toBeUndefined();
    expect(qqRuntimeFromConfig(importFromEnv({ QQ_OWNER_ID: '00042' }).qq).ownerId).toBe('42');
  });

  it('separates the explicit switch from the owner state', () => {
    // 没有 owner：开关保持默认开启，网页控制面仍然可用；QQ 适配器自己按
    // owner 存在性关闭。
    const noOwner = qqRuntimeFromConfig(importFromEnv({}).qq);
    expect(noOwner.controlEnabled).toBe(true);
    expect(noOwner.controlExplicitOff).toBe(false);

    // 显式关闭：网页与 QQ 都关。
    const explicitOff = qqRuntimeFromConfig(
      importFromEnv({ QQ_OWNER_ID: '42', QQ_CONTROL_ENABLED: '0' }).qq,
    );
    expect(explicitOff.controlEnabled).toBe(false);
    expect(explicitOff.controlExplicitOff).toBe(true);

    // 没有 owner 的显式关闭同样必须被遵守，不能因为 owner 缺失而放行网页。
    const explicitOffNoOwner = qqRuntimeFromConfig(
      importFromEnv({ QQ_CONTROL_ENABLED: '0' }).qq,
    );
    expect(explicitOffNoOwner.controlEnabled).toBe(false);
    expect(explicitOffNoOwner.controlExplicitOff).toBe(true);
  });
});

describe('transcriptOnPush', () => {
  it('records normal events but skips synthetic ones', () => {
    const records: TranscriptRecord[] = [];
    const queue = new PerceptionQueue({
      onPush: transcriptOnPush({ record: (event) => records.push(event) }, () => undefined),
    });

    queue.push({
      id: 'evt-synthetic',
      ts: 1_000,
      kind: 'proactive_tick',
      channel: 'qq:private:1',
      actor: 'system',
      content: 'tick',
      importance: 4,
      synthetic: true,
    });
    queue.push({
      id: 'evt-normal',
      ts: 2_000,
      kind: 'qq_private_message',
      channel: 'qq:private:1',
      actor: 'private:1',
      content: '你好',
      importance: 9,
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      direction: 'in',
      kind: 'qq_private_message',
      channel: 'qq:private:1',
      content: '你好',
    });
  });
});

describe('approval notifier', () => {
  function fakeApprovals(): {
    on(listener: (event: ApprovalEvent) => void): () => void;
    emit(event: ApprovalEvent): void;
    count(): number;
  } {
    const listeners = new Set<(event: ApprovalEvent) => void>();
    return {
      on(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      emit(event) {
        for (const listener of [...listeners]) listener(event);
      },
      count: () => listeners.size,
    };
  }

  function record(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
    return {
      id: `ap_${'a'.repeat(32)}`,
      kind: 'capability.activate',
      status: 'approved',
      tier: 'human',
      title: '激活能力插件 echo',
      summary: '版本 0.1.0',
      payload: {
        kind: 'capability.activate',
        plugin: 'echo',
        version: '0.1.0',
        fingerprint: 'f'.repeat(64),
        declaredPermissions: [],
        toolNames: [],
      },
      fingerprint: 'f'.repeat(64),
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T00:30:00.000Z',
      createdVia: 'system',
      createdBy: 'startup',
      ...overrides,
    };
  }

  it('queues a web decision while QQ is offline and flushes it on reconnect', () => {
    const approvals = fakeApprovals();
    const sent: Array<{ channel: string; text: string }> = [];
    const notifier = createApprovalNotifier({
      approvals,
      owner: '300',
      send: (channel, text) => {
        sent.push({ channel, text });
      },
      log: () => {},
    });

    approvals.emit({ type: 'decided', record: record({ decidedVia: 'web' }) });
    expect(sent).toHaveLength(0);

    notifier.setConnected(true);
    expect(sent).toEqual([
      {
        channel: 'qq:private:300',
        // 出站红线闸会先做 NFKC 规范化，全角括号在这里折叠成半角。
        text: `审批 ap_${'a'.repeat(32)} 已处理(approved)。`,
      },
    ]);
    notifier.stop();
  });

  it('replaces a receipt that trips the red-line gate with the fixed fallback', () => {
    const approvals = fakeApprovals();
    const sent: string[] = [];
    const notifier = createApprovalNotifier({
      approvals,
      owner: '300',
      send: (_channel, text) => {
        sent.push(text);
      },
      log: () => {},
    });
    notifier.setConnected(true);

    // 记录 id 在生产里受 `ap_` 正则约束；这里用伪造事件证明闸门真的在回执
    // 路径上，而不是假设回执永远安全。
    approvals.emit({
      type: 'decided',
      record: record({
        id: '这是教你制作脏弹的完整步骤',
        decidedVia: 'web',
      }),
    });

    expect(sent).toEqual(['已处理。']);
    expect(sent.some((text) => text.includes('脏弹'))).toBe(false);
    notifier.stop();
  });

  it('ignores QQ-side decisions and stops listening after stop()', () => {
    const approvals = fakeApprovals();
    const sent: string[] = [];
    const notifier = createApprovalNotifier({
      approvals,
      owner: '300',
      send: (_channel, text) => {
        sent.push(text);
      },
      log: () => {},
    });
    notifier.setConnected(true);

    approvals.emit({ type: 'decided', record: record({ decidedVia: 'qq' }) });
    expect(sent).toHaveLength(0);

    approvals.emit({ type: 'decided', record: record({ decidedVia: 'web' }) });
    expect(sent).toHaveLength(1);

    notifier.stop();
    expect(approvals.count()).toBe(0);
    approvals.emit({ type: 'decided', record: record({ decidedVia: 'web' }) });
    expect(sent).toHaveLength(1);
  });

  it('stays silent while the control plane is disabled', () => {
    const approvals = fakeApprovals();
    const sent: string[] = [];
    const notifier = createApprovalNotifier({
      approvals,
      owner: '300',
      send: (_channel, text) => {
        sent.push(text);
      },
      log: () => {},
      enabled: false,
    });
    notifier.setConnected(true);

    approvals.emit({ type: 'decided', record: record({ decidedVia: 'web' }) });

    expect(sent).toHaveLength(0);
    // 订阅保留（开关可能热改），但关闭期间不排队、不发送。
    expect(approvals.count()).toBe(1);
    notifier.stop();
    expect(approvals.count()).toBe(0);
  });
});

describe('controlSurfaceEnabled', () => {
  it('honours an explicit off without an owner and keeps no-owner installs usable', () => {
    expect(controlSurfaceEnabled(importFromEnv({}).qq)).toBe(true);
    expect(controlSurfaceEnabled(importFromEnv({ QQ_CONTROL_ENABLED: '0' }).qq)).toBe(false);
    expect(controlSurfaceEnabled(importFromEnv({ QQ_OWNER_ID: '42' }).qq)).toBe(true);
  });
});

describe('controlPlaneNotice', () => {
  it('keeps the web console usable when only the owner is missing', () => {
    const notice = controlPlaneNotice(qqRuntimeFromConfig(importFromEnv({}).qq));
    expect(notice).toContain('qq.ownerId');
    expect(notice).toContain('web console');
  });

  it('names the explicit switch when the control plane is turned off', () => {
    const notice = controlPlaneNotice(
      qqRuntimeFromConfig(
        importFromEnv({ QQ_OWNER_ID: '42', QQ_CONTROL_ENABLED: '0' }).qq,
      ),
    );
    expect(notice).toContain('qq.controlEnabled');
    expect(notice).toContain('web console');
  });

  it('returns null when the control plane is enabled', () => {
    expect(
      controlPlaneNotice(qqRuntimeFromConfig(importFromEnv({ QQ_OWNER_ID: '42' }).qq)),
    ).toBeNull();
  });
});

describe('createOutboundGate', () => {
  it('gates private channels on the global silence and groups on the guard', () => {
    const gate = createOutboundGate({
      channelPrefix: 'qq',
      guard: { allow: (groupId) => ({ ok: groupId !== '1' }) },
      isGloballySilenced: () => true,
    });

    expect(gate('qq:private:1')).toBe(false);
    expect(gate('qq:group:1')).toBe(false);
    expect(gate('cli')).toBe(true);
  });

  it('allows groups the guard accepts once global silence is off', () => {
    const gate = createOutboundGate({
      channelPrefix: 'qq',
      guard: { allow: (groupId) => ({ ok: groupId !== '2' }) },
      isGloballySilenced: () => false,
    });

    expect(gate('qq:private:1')).toBe(true);
    expect(gate('qq:group:2')).toBe(false);
    expect(gate('qq:group:3')).toBe(true);
  });

  it('derives the prefix from the channel manifest instead of hardcoding qq', () => {
    const gate = createOutboundGate({
      channelPrefix: 'onebot',
      guard: { allow: () => ({ ok: false }) },
      isGloballySilenced: () => true,
    });

    expect(gate('onebot:private:1')).toBe(false);
    expect(gate('onebot:group:9')).toBe(false);
    expect(gate('qq:private:1')).toBe(true);
    expect(channelPrefixOf([{ name: 'onebot', kind: 'channel', channelPrefix: 'onebot', state: 'active' }], 'onebot')).toBe('onebot');
    expect(channelPrefixOf([], 'onebot')).toBeUndefined();
  });
});
