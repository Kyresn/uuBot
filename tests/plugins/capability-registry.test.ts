import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityRegistry } from '../../src/plugins/capability-registry.js';
import {
  activateCapabilityApproved,
  autoActivatePendingCapabilities,
  startCapabilities,
} from '../../src/plugins/capability-wiring.js';
import { ApprovalService } from '../../src/approvals/service.js';
import type { CapabilityWorker, WorkerHostDeps, WorkerState } from '../../src/plugins/worker-host.js';
import type { PluginManifest, PluginToolDef } from '../../src/plugins/manifest.js';
import type { BrainResponse } from '../../src/brain/brain.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'uuharness-capabilities-'));
  dirs.push(dir);
  return dir;
}

async function writePlugin(root: string, dirName: string, manifest: unknown): Promise<string> {
  const pluginDir = join(root, dirName);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(join(pluginDir, 'manifest.json'), JSON.stringify(manifest));
  return pluginDir;
}

function tool(name: string): PluginToolDef {
  return { name, description: `${name} tool`, parameters: { type: 'object', properties: {} } };
}

function capabilityManifest(name: string, tools: PluginToolDef[] = []): Record<string, unknown> {
  return {
    name,
    kind: 'capability',
    apiVersion: 1,
    version: '0.1.0',
    entry: 'index.mjs',
    tools,
  };
}

interface FakeConfig {
  selfTestValue: unknown;
  selfTestThrows: boolean;
  startError: Error | undefined;
  reported: string[];
  /** 激活在途闸：测试用它把 start() 卡住，制造并发 ban。 */
  startGate?: Promise<void>;
}

/** 假 worker：记录 start/stop/invoke，selfTest 结果可配置。 */
class FakeWorker {
  readonly manifest: PluginManifest;
  readonly dir: string;
  readonly config: FakeConfig;
  state: WorkerState = 'ready';
  startCalls = 0;
  stopCalls = 0;
  readonly invoked: Array<{ name: string; args: unknown }> = [];

  constructor(manifest: PluginManifest, dir: string, config: FakeConfig) {
    this.manifest = manifest;
    this.dir = dir;
    this.config = config;
  }

  async start(): Promise<string[]> {
    this.startCalls += 1;
    if (this.config.startGate !== undefined) await this.config.startGate;
    if (this.config.startError !== undefined) throw this.config.startError;
    return this.config.reported;
  }

  async invokeTool(name: string, args: unknown): Promise<unknown> {
    this.invoked.push({ name, args });
    if (name === '__selfTest') {
      if (this.config.selfTestThrows) throw new Error('selfTest exploded');
      return this.config.selfTestValue;
    }
    return { tool: name, args };
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }
}

interface Harness {
  registry: CapabilityRegistry;
  workers: FakeWorker[];
  log: ReturnType<typeof vi.fn>;
}

function harness(
  overrides: Partial<FakeConfig> = {},
  opts: { banFile?: string; legacyBanFile?: string } = {},
): Harness {
  const config: FakeConfig = {
    selfTestValue: true,
    selfTestThrows: false,
    startError: undefined,
    reported: ['echo', '__selfTest'],
    ...overrides,
  };
  const workers: FakeWorker[] = [];
  const log = vi.fn();
  const brainResponse: BrainResponse = {
    content: 'ok',
    toolCalls: [],
    reasoning: null,
    usage: { promptTokens: 0, completionTokens: 0 },
    endpoint: 'stub',
    model: 'stub',
  };
  const deps: WorkerHostDeps = {
    brain: { chat: async () => brainResponse },
    memory: { search: async () => [], write: async () => {} },
    log,
  };
  const registry = new CapabilityRegistry(deps, {
    workerFactory: (manifest, dir) => {
      const worker = new FakeWorker(manifest, dir, config);
      workers.push(worker);
      return worker as unknown as CapabilityWorker;
    },
    ...opts,
  });
  return { registry, workers, log };
}

async function loadCapability(root: string, name: string, tools: PluginToolDef[] = [tool('echo')]) {
  await writePlugin(root, name, capabilityManifest(name, tools));
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('CapabilityRegistry', () => {
  it('loads capability plugins as pending and does not spawn workers', async () => {
    const root = await tempDir();
    await loadCapability(root, 'echo');
    const { registry, workers } = harness();

    await registry.loadFrom(root);

    expect(registry.status()).toEqual([{ name: 'echo', state: 'pending' }]);
    expect(workers).toHaveLength(0);
  });

  it('skips channel plugins with a log line', async () => {
    const root = await tempDir();
    await loadCapability(root, 'echo');
    await writePlugin(root, 'qq', {
      name: 'qq',
      kind: 'channel',
      channelPrefix: 'qq',
      apiVersion: 1,
      version: '0.1.0',
      entry: 'index.mjs',
    });
    const { registry, log } = harness();

    await registry.loadFrom(root);

    expect(registry.status().map((s) => s.name)).toEqual(['echo']);
    expect(log).toHaveBeenCalledWith('capability registry: skipping qq (kind channel)');
  });

  it('tolerates a missing plugin directory', async () => {
    const { registry, log } = harness();
    const missing = join(await tempDir(), 'nope');

    await expect(registry.loadFrom(missing)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('cannot read capability directory'));
    expect(registry.status()).toEqual([]);
  });

  it('logs and skips invalid manifests', async () => {
    const root = await tempDir();
    const brokenDir = join(root, 'broken');
    await mkdir(brokenDir, { recursive: true });
    await writeFile(join(brokenDir, 'manifest.json'), '{not json');
    const { registry, log } = harness();

    await registry.loadFrom(root);

    expect(registry.status()).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('invalid manifest'));
  });

  it('replaces a duplicate plugin name and logs it', async () => {
    const root = await tempDir();
    await loadCapability(root, 'first');
    await writePlugin(root, 'second', capabilityManifest('first', [tool('echo')]));
    const { registry, log } = harness();

    await registry.loadFrom(root);

    expect(registry.status()).toEqual([{ name: 'first', state: 'pending' }]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('duplicate plugin name first'));
  });

  it('activates a plugin after a passing selfTest', async () => {
    const root = await tempDir();
    await loadCapability(root, 'echo');
    const { registry, workers } = harness();

    await registry.loadFrom(root);
    await registry.activate('echo');

    expect(registry.status()).toEqual([{ name: 'echo', state: 'active' }]);
    expect(workers[0]?.startCalls).toBe(1);
    expect(workers[0]?.invoked).toContainEqual({ name: '__selfTest', args: {} });
    expect(registry.getToolDefs()).toEqual([tool('echo')]);
  });

  it('only exposes tools the worker reported, minus the reserved selfTest name', async () => {
    const root = await tempDir();
    await loadCapability(root, 'echo', [tool('echo'), tool('ping')]);
    const { registry } = harness({ reported: ['echo', '__selfTest'] });

    await registry.loadFrom(root);
    await registry.activate('echo');

    expect(registry.getToolDefs()).toEqual([tool('echo')]);
  });

  it('does not route a manifest-declared tool the worker never registered', async () => {
    const root = await tempDir();
    await loadCapability(root, 'echo', [tool('echo'), tool('ping')]);
    const { registry } = harness({ reported: ['echo', '__selfTest'] });

    await registry.loadFrom(root);
    await registry.activate('echo');

    await expect(registry.invokeTool('ping', {})).rejects.toThrow('unknown tool: ping');
  });

  it('marks the plugin failed and stops the worker when selfTest returns false', async () => {
    const root = await tempDir();
    await loadCapability(root, 'echo');
    const { registry, workers, log } = harness({ selfTestValue: false });

    await registry.loadFrom(root);
    await registry.activate('echo');

    expect(registry.status()[0]?.state).toBe('failed');
    expect(registry.status()[0]?.error).toContain('selfTest');
    expect(workers[0]?.stopCalls).toBe(1);
    expect(registry.getToolDefs()).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('failed'));
  });

  it('marks the plugin failed when selfTest throws', async () => {
    const root = await tempDir();
    await loadCapability(root, 'echo');
    const { registry, workers } = harness({ selfTestThrows: true });

    await registry.loadFrom(root);
    await registry.activate('echo');

    expect(registry.status()[0]?.state).toBe('failed');
    expect(registry.status()[0]?.error).toContain('selfTest exploded');
    expect(workers[0]?.stopCalls).toBe(1);
  });

  it('marks the plugin failed when the worker fails to start', async () => {
    const root = await tempDir();
    await loadCapability(root, 'echo');
    const { registry, workers } = harness({ startError: new Error('init timed out') });

    await registry.loadFrom(root);
    await registry.activate('echo');

    expect(registry.status()[0]?.state).toBe('failed');
    expect(registry.status()[0]?.error).toContain('init timed out');
    expect(workers[0]?.stopCalls).toBe(1);
  });

  it('bans a plugin and stops its worker', async () => {
    const root = await tempDir();
    await loadCapability(root, 'echo');
    const { registry, workers } = harness();

    await registry.loadFrom(root);
    await registry.activate('echo');
    await registry.ban('echo');

    expect(registry.status()).toEqual([{ name: 'echo', state: 'banned' }]);
    expect(workers[0]?.stopCalls).toBe(1);
    expect(registry.getToolDefs()).toEqual([]);
  });

  it('refuses to activate a banned plugin', async () => {
    const root = await tempDir();
    await loadCapability(root, 'echo');
    const { registry, workers, log } = harness();

    await registry.loadFrom(root);
    await registry.ban('echo');
    await registry.activate('echo');

    expect(registry.status()).toEqual([{ name: 'echo', state: 'banned' }]);
    expect(workers).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('banned'));
  });

  it('returns tool defs from active plugins only', async () => {
    const root = await tempDir();
    await loadCapability(root, 'active', [tool('echo')]);
    await loadCapability(root, 'idle', [tool('idle-tool')]);
    const { registry } = harness();

    await registry.loadFrom(root);
    await registry.activate('active');

    expect(registry.getToolDefs()).toEqual([tool('echo')]);
  });

  it('routes tool calls to the active plugin that declares them', async () => {
    const root = await tempDir();
    await loadCapability(root, 'alpha', [tool('echo')]);
    await loadCapability(root, 'beta', [tool('ping')]);
    const { registry, workers } = harness({ reported: ['echo', 'ping', '__selfTest'] });

    await registry.loadFrom(root);
    await registry.activate('alpha');
    await registry.activate('beta');

    await expect(registry.invokeTool('ping', { n: 1 })).resolves.toEqual({
      tool: 'ping',
      args: { n: 1 },
    });
    expect(workers[0]?.invoked).not.toContainEqual({ name: 'ping', args: { n: 1 } });
    expect(workers[1]?.invoked).toContainEqual({ name: 'ping', args: { n: 1 } });
  });

  it('throws on an unknown tool', async () => {
    const root = await tempDir();
    await loadCapability(root, 'echo');
    const { registry } = harness();

    await registry.loadFrom(root);
    await registry.activate('echo');

    await expect(registry.invokeTool('nope', {})).rejects.toThrow('unknown tool: nope');
  });

  it('throws on a tool declared only by a pending plugin', async () => {
    const root = await tempDir();
    await loadCapability(root, 'echo');
    const { registry } = harness();

    await registry.loadFrom(root);

    await expect(registry.invokeTool('echo', {})).rejects.toThrow('unknown tool: echo');
  });

  it('stopAll stops every worker, hides tools, and is idempotent', async () => {
    const root = await tempDir();
    await loadCapability(root, 'alpha');
    await loadCapability(root, 'beta');
    const { registry, workers } = harness();

    await registry.loadFrom(root);
    await registry.activate('alpha');
    await registry.activate('beta');
    await registry.stopAll();

    expect(workers.map((worker) => worker.stopCalls)).toEqual([1, 1]);
    expect(registry.status().map((entry) => entry.state)).toEqual(['stopped', 'stopped']);
    expect(registry.getToolDefs()).toEqual([]);

    await registry.stopAll();
    expect(workers.map((worker) => worker.stopCalls)).toEqual([1, 1]);
  });

  it('sorts status by name', async () => {
    const root = await tempDir();
    await loadCapability(root, 'zeta');
    await loadCapability(root, 'alpha');
    const { registry } = harness();

    await registry.loadFrom(root);

    expect(registry.status().map((s) => s.name)).toEqual(['alpha', 'zeta']);
  });

  it('drops a crashed worker from the active set on read', async () => {
    const root = await tempDir();
    await loadCapability(root, 'echo');
    const { registry, workers, log } = harness();

    await registry.loadFrom(root);
    await registry.activate('echo');
    workers[0]!.state = 'crashed';

    expect(registry.getToolDefs()).toEqual([]);
    expect(registry.status()).toEqual([{ name: 'echo', state: 'crashed' }]);
    expect(log).toHaveBeenCalledWith(
      'capability registry: echo crashed, dropping from active set',
    );

    // Lazy marking logs once, not on every read.
    registry.getToolDefs();
    const crashLogs = log.mock.calls.filter((call) =>
      String(call[0]).includes('crashed, dropping from active set'),
    );
    expect(crashLogs).toHaveLength(1);
  });

  it('refuses tool calls to a crashed worker', async () => {
    const root = await tempDir();
    await loadCapability(root, 'echo');
    const { registry, workers } = harness();

    await registry.loadFrom(root);
    await registry.activate('echo');
    workers[0]!.state = 'crashed';

    await expect(registry.invokeTool('echo', {})).rejects.toThrow('tool unavailable: echo');
  });

  it('keeps a banned plugin banned across a rescan', async () => {
    const root = await tempDir();
    await loadCapability(root, 'echo');
    const { registry, log } = harness();

    await registry.loadFrom(root);
    await registry.ban('echo');
    await registry.loadFrom(root);

    expect(registry.status()).toEqual([{ name: 'echo', state: 'banned' }]);
    expect(log).toHaveBeenCalledWith('capability registry: echo is banned, skipping reload');
  });

  it('persists bans to bans.json (sorted) and reloads them as banned', async () => {
    const root = await tempDir();
    await loadCapability(root, 'echo');
    await loadCapability(root, 'alpha');
    const first = harness();

    await first.registry.loadFrom(root);
    await first.registry.ban('echo');
    await first.registry.ban('alpha');

    const banFile = join(root, 'bans.json');
    expect(JSON.parse(await readFile(banFile, 'utf8'))).toEqual(['alpha', 'echo']);

    // 新实例（模拟重启）读同一目录：封禁必须仍然生效且不会被激活。
    const second = harness();
    await second.registry.loadFrom(root);
    expect(second.registry.status()).toEqual([
      { name: 'alpha', state: 'banned' },
      { name: 'echo', state: 'banned' },
    ]);

    await second.registry.activate('echo');
    expect(second.workers).toHaveLength(0);
  });

  it('writes bans.json atomically, leaving no temp files behind', async () => {
    const root = await tempDir();
    await loadCapability(root, 'echo');
    const { registry } = harness();

    await registry.loadFrom(root);
    await registry.activate('echo');
    await registry.ban('echo');

    const entries = await readdir(root);
    expect(entries.filter((name) => name.includes('.tmp'))).toEqual([]);
    expect(JSON.parse(await readFile(join(root, 'bans.json'), 'utf8'))).toEqual(['echo']);
  });

  it('honors an explicit banFile path', async () => {
    const root = await tempDir();
    const banFile = join(await tempDir(), 'bans.json');
    await loadCapability(root, 'echo');
    const first = harness({}, { banFile });

    await first.registry.loadFrom(root);
    await first.registry.ban('echo');

    expect(JSON.parse(await readFile(banFile, 'utf8'))).toEqual(['echo']);

    const second = harness({}, { banFile });
    await second.registry.loadFrom(root);
    expect(second.registry.status()).toEqual([{ name: 'echo', state: 'banned' }]);
  });

  it('unbans a plugin, clears it from bans.json, and allows activation again', async () => {
    const root = await tempDir();
    await loadCapability(root, 'echo');
    const { registry, workers, log } = harness();

    await registry.loadFrom(root);
    await registry.ban('echo');
    await registry.unban('echo');

    expect(JSON.parse(await readFile(join(root, 'bans.json'), 'utf8'))).toEqual([]);
    expect(registry.status()).toEqual([{ name: 'echo', state: 'pending' }]);
    expect(log).toHaveBeenCalledWith('capability registry: echo unbanned');

    await registry.activate('echo');
    expect(registry.status()).toEqual([{ name: 'echo', state: 'active' }]);
    expect(workers).toHaveLength(1);
  });

  it('fails closed: a present but invalid ban file refuses every activation', async () => {
    const root = await tempDir();
    await loadCapability(root, 'echo');
    await writeFile(join(root, 'bans.json'), '{not json');
    const { registry, workers, log } = harness();

    await registry.loadFrom(root);

    // 文件损坏不能解释成「没有封禁」：插件保持 pending，激活被拒绝。
    expect(registry.status()).toEqual([{ name: 'echo', state: 'pending' }]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ban file'));

    await registry.activate('echo');
    expect(workers).toHaveLength(0);
    expect(registry.status()).toEqual([{ name: 'echo', state: 'pending' }]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('refusing to activate'));
  });

  it('migrates a legacy ban file into DATA_DIR once and reads only the new path afterwards', async () => {
    const root = await tempDir();
    const dataDir = await tempDir();
    await loadCapability(root, 'echo');
    await writeFile(join(root, 'bans.json'), JSON.stringify(['echo']));
    const banFile = join(dataDir, 'bans.json');
    const first = harness({}, { banFile, legacyBanFile: join(root, 'bans.json') });

    await first.registry.loadFrom(root);

    expect(first.registry.status()).toEqual([{ name: 'echo', state: 'banned' }]);
    expect(JSON.parse(await readFile(banFile, 'utf8'))).toEqual(['echo']);

    // 旧文件之后被改动也不再影响：新路径已存在，迁移只发生一次。
    await writeFile(join(root, 'bans.json'), JSON.stringify([]));
    const second = harness({}, { banFile, legacyBanFile: join(root, 'bans.json') });
    await second.registry.loadFrom(root);
    expect(second.registry.status()).toEqual([{ name: 'echo', state: 'banned' }]);
  });

  it('does not let an in-flight activation override a concurrent ban', async () => {
    const root = await tempDir();
    await loadCapability(root, 'echo');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { registry, workers, log } = harness({ startGate: gate });

    await registry.loadFrom(root);
    const activating = registry.activate('echo');
    await vi.waitFor(() => expect(workers).toHaveLength(1));

    const banning = registry.ban('echo');
    release();
    await Promise.all([activating, banning]);

    expect(registry.status()).toEqual([{ name: 'echo', state: 'banned' }]);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('echo active'));
  });

  it('describes a capability with a fingerprint that tracks the manifest and entry bytes', async () => {
    const root = await tempDir();
    await loadCapability(root, 'echo');
    await writeFile(join(root, 'echo', 'index.mjs'), 'export const v = 1;\n');
    const { registry } = harness();

    await registry.loadFrom(root);
    const first = await registry.describe('echo');
    expect(first).toMatchObject({
      name: 'echo',
      version: '0.1.0',
      declaredPermissions: [],
      toolNames: ['echo'],
    });
    expect(first?.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    await writeFile(join(root, 'echo', 'index.mjs'), 'export const v = 2;\n');
    const second = await registry.describe('echo');
    expect(second?.fingerprint).not.toBe(first?.fingerprint);

    await expect(registry.describe('missing')).resolves.toBeNull();
  });

  it('spawns only one worker for concurrent activate calls', async () => {
    const root = await tempDir();
    await loadCapability(root, 'echo');
    const { registry, workers, log } = harness();

    await registry.loadFrom(root);
    await Promise.all([registry.activate('echo'), registry.activate('echo')]);

    expect(workers).toHaveLength(1);
    expect(workers[0]?.startCalls).toBe(1);
    expect(registry.status()).toEqual([{ name: 'echo', state: 'active' }]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('already active'));
  });
});

describe('startCapabilities', () => {
  it('proposes activation instead of spawning and dedupes by plugin + fingerprint', async () => {
    const root = await tempDir();
    const dataDir = await tempDir();
    await loadCapability(root, 'echo');
    await writeFile(join(root, 'echo', 'index.mjs'), 'export const v = 1;\n');

    const pending: Array<{
      kind: string;
      status: string;
      payload: { kind: string; plugin?: string; fingerprint?: string };
    }> = [];
    const approvals = {
      list: () => pending.filter((record) => record.status === 'pending') as never,
      propose: async (payload: { kind: string; plugin?: string; fingerprint?: string }) => {
        const record = {
          kind: payload.kind,
          status: 'pending',
          payload,
        };
        pending.push(record);
        return { ok: true as const, record: record as never };
      },
    };

    const workers: FakeWorker[] = [];
    const log = vi.fn();
    const brain = {
      chat: async () => ({
        content: 'ok',
        toolCalls: [],
        reasoning: null,
        usage: { promptTokens: 0, completionTokens: 0 },
        endpoint: 'stub',
        model: 'stub',
      }),
    };

    const first = await startCapabilities({
      brain,
      log,
      dir: root,
      dataDir,
      approvals: approvals as never,
      workerFactory: (manifest, dir) => {
        const worker = new FakeWorker(manifest, dir, {
          selfTestValue: true,
          selfTestThrows: false,
          startError: undefined,
          reported: ['echo', '__selfTest'],
        });
        workers.push(worker);
        return worker as unknown as CapabilityWorker;
      },
    });

    expect(workers).toHaveLength(0);
    expect(first.status()).toEqual([{ name: 'echo', state: 'pending' }]);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.payload.plugin).toBe('echo');
    expect(pending[0]?.payload.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    // 重启（同一份 pending 列表）不得重复提案。
    await startCapabilities({
      brain,
      log,
      dir: root,
      dataDir,
      approvals: approvals as never,
      workerFactory: (manifest, dir) =>
        new FakeWorker(manifest, dir, {
          selfTestValue: true,
          selfTestThrows: false,
          startError: undefined,
          reported: ['echo', '__selfTest'],
        }) as unknown as CapabilityWorker,
    });
    expect(pending).toHaveLength(1);
  });
});

describe('capability.autoActivate', () => {
  function brainStub(): WorkerHostDeps['brain'] {
    return {
      chat: async () => ({
        content: 'ok',
        toolCalls: [],
        reasoning: null,
        usage: { promptTokens: 0, completionTokens: 0 },
        endpoint: 'stub',
        model: 'stub',
      }),
    };
  }

  it('auto-approves startup proposals through the approval service and activates', async () => {
    const root = await tempDir();
    const dataDir = await tempDir();
    await loadCapability(root, 'echo');
    const log = vi.fn();
    const workers: FakeWorker[] = [];
    const registryRef: { current: CapabilityRegistry | null } = { current: null };
    const approvals = new ApprovalService({
      dataDir,
      log,
      hooks: {
        // 装配点真实接线：applier 通过 registryRef 拿到注册表。
        activateCapability: async (record) =>
          registryRef.current === null
            ? { ok: false, code: 'not_implemented' }
            : activateCapabilityApproved(registryRef.current, record),
      },
    });

    try {
      const registry = await startCapabilities({
        brain: brainStub(),
        log,
        dir: root,
        dataDir,
        approvals,
        workerFactory: (manifest, dir) => {
          const worker = new FakeWorker(manifest, dir, {
            selfTestValue: true,
            selfTestThrows: false,
            startError: undefined,
            reported: ['echo', '__selfTest'],
          });
          workers.push(worker);
          return worker as unknown as CapabilityWorker;
        },
      });
      registryRef.current = registry;
      expect(registry.status()).toEqual([{ name: 'echo', state: 'pending' }]);

      const approved = await autoActivatePendingCapabilities(approvals, log);

      expect(approved).toBe(1);
      expect(registry.status()).toEqual([{ name: 'echo', state: 'active' }]);
      expect(workers).toHaveLength(1);

      // 审计照常存在：decision 由 system/startup 做出，而不是凭空激活。
      const record = approvals.list({ status: 'all', kind: 'capability.activate' })[0];
      expect(record?.status).toBe('approved');
      expect(record?.decidedVia).toBe('system');
      expect(record?.decidedBy).toBe('startup');
    } finally {
      await approvals.stop();
    }
  });

  it('is a no-op when the approval service cannot decide', async () => {
    const log = vi.fn();
    const approved = await autoActivatePendingCapabilities(
      {
        list: () => [],
        propose: async () => ({ ok: false, code: 'conflict' }),
      },
      log,
    );
    expect(approved).toBe(0);
  });
});

describe('ban file integrity', () => {
  it('treats a ban file with non-string entries as invalid and fails closed', async () => {
    const root = await tempDir();
    await loadCapability(root, 'echo');
    await writeFile(join(root, 'bans.json'), JSON.stringify(['echo', 42]));
    const { registry, workers, log } = harness();

    await registry.loadFrom(root);

    // 不能把「数组里有非法元素」解释成「没有封禁」：整份文件作废。
    expect(registry.status()).toEqual([{ name: 'echo', state: 'pending' }]);
    await registry.activate('echo');
    expect(workers).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('fail closed'));
  });

  it('clears fail-closed on a later load once the file is valid again', async () => {
    const root = await tempDir();
    await loadCapability(root, 'echo');
    await writeFile(join(root, 'bans.json'), '{not json');
    const { registry, workers } = harness();

    await registry.loadFrom(root);
    await registry.activate('echo');
    expect(workers).toHaveLength(0);

    await writeFile(join(root, 'bans.json'), '[]');
    await registry.loadFrom(root);
    await registry.activate('echo');

    expect(registry.status()).toEqual([{ name: 'echo', state: 'active' }]);
    expect(workers).toHaveLength(1);
  });

  it('repairs an invalid ban file through an explicit ban', async () => {
    const root = await tempDir();
    await loadCapability(root, 'echo');
    await writeFile(join(root, 'bans.json'), '{not json');
    const { registry, workers } = harness();

    await registry.loadFrom(root);
    await registry.ban('echo');
    expect(JSON.parse(await readFile(join(root, 'bans.json'), 'utf8'))).toEqual(['echo']);

    await registry.unban('echo');
    expect(JSON.parse(await readFile(join(root, 'bans.json'), 'utf8'))).toEqual([]);
    await registry.activate('echo');

    expect(registry.status()).toEqual([{ name: 'echo', state: 'active' }]);
    expect(workers).toHaveLength(1);
  });
});

describe('ban file write failures', () => {
  it('reports a failed ban/unban write instead of pretending it persisted', async () => {
    const root = await tempDir();
    await loadCapability(root, 'echo');
    const banFile = join(await tempDir(), 'bans.json');
    const { registry } = harness({}, { banFile });
    await registry.loadFrom(root);

    // 加载后把目标路径变成目录：原子写（tmp + rename）必然失败。
    await mkdir(banFile);

    await expect(registry.ban('echo')).rejects.toThrow(/write failed/i);
    // 收窄动作仍然生效（内存里已封禁），但调用方必须看到持久化失败。
    expect(registry.status()).toEqual([{ name: 'echo', state: 'banned' }]);

    await expect(registry.unban('echo')).rejects.toThrow(/write failed/i);
    // 解封没写成功就不放宽：仍是 banned。
    expect(registry.status()).toEqual([{ name: 'echo', state: 'banned' }]);
  });
});
