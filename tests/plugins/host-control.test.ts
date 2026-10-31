import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginHost } from '../../src/plugins/host.js';
import { PerceptionQueue } from '../../src/core/events.js';
import type { ChannelPluginApiV1, PluginApiV1 } from '../../src/plugins/api.js';
import type { ControlInput, ControlPort } from '../../src/control/types.js';

interface TestState {
  apis: Record<string, ChannelPluginApiV1>;
}

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'uuharness-host-control-'));
  dirs.push(dir);
  return dir;
}

function installState(): TestState {
  const state: TestState = { apis: {} };
  (globalThis as unknown as { __uuharnessHostControl: TestState }).__uuharnessHostControl = state;
  return state;
}

function makeBrain(): PluginApiV1['brain'] {
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

function pluginSource(name: string): string {
  return `
export function createPlugin() {
  return {
    activate(api) {
      globalThis.__uuharnessHostControl.apis[${JSON.stringify(name)}] = api;
    },
    deactivate() {},
    send() {},
  };
}
`;
}

async function writePlugin(
  root: string,
  dirName: string,
  manifest: Record<string, unknown>,
  source: string,
): Promise<void> {
  const pluginDir = join(root, dirName);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(join(pluginDir, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(pluginDir, 'index.mjs'), source);
}

function channelManifest(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    kind: 'channel',
    channelPrefix: name,
    apiVersion: 1,
    version: '0.1.0',
    entry: 'index.mjs',
    ...extra,
  };
}

function capabilityManifest(name: string): Record<string, unknown> {
  return { name, kind: 'capability', apiVersion: 1, version: '0.1.0', entry: 'index.mjs' };
}

function fakePort(): ControlPort & {
  handle: ReturnType<typeof vi.fn<ControlPort['handle']>>;
} {
  return {
    handle: vi.fn<ControlPort['handle']>(async (_input: ControlInput) => ({
      action: 'chat' as const,
    })),
  };
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('PluginHost control injection', () => {
  it('injects the port only into the plugin the wiring grants it to', async () => {
    const state = installState();
    const root = await tempDir();
    await writePlugin(root, 'qq', channelManifest('qq'), pluginSource('qq'));
    await writePlugin(root, 'other', channelManifest('other'), pluginSource('other'));

    const port = fakePort();
    const forPlugin = vi.fn((name: string) => (name === 'qq' ? port : undefined));
    const host = new PluginHost({
      queue: new PerceptionQueue(),
      brain: makeBrain(),
      log: vi.fn(),
      control: { forPlugin },
    });
    await host.loadFrom(root);
    await host.startAll();

    expect(state.apis['qq']?.control).toBe(port);
    expect(state.apis['other']?.control).toBeUndefined();
    expect(forPlugin).toHaveBeenCalledWith('qq');
    expect(forPlugin).toHaveBeenCalledWith('other');
  });

  it('leaves control undefined when no wiring is provided', async () => {
    const state = installState();
    const root = await tempDir();
    await writePlugin(root, 'qq', channelManifest('qq'), pluginSource('qq'));

    const host = new PluginHost({
      queue: new PerceptionQueue(),
      brain: makeBrain(),
      log: vi.fn(),
    });
    await host.loadFrom(root);
    await host.startAll();

    expect(state.apis['qq']?.control).toBeUndefined();
  });

  it('never grants control to a capability plugin', async () => {
    const state = installState();
    const root = await tempDir();
    await writePlugin(root, 'cap', capabilityManifest('cap'), pluginSource('cap'));

    const port = fakePort();
    const host = new PluginHost({
      queue: new PerceptionQueue(),
      brain: makeBrain(),
      log: vi.fn(),
      control: { forPlugin: () => port },
    });
    await host.loadFrom(root);
    await host.startAll();

    expect(state.apis['cap']?.control).toBeUndefined();
  });

  it('ignores a manifest that claims control authority itself', async () => {
    const state = installState();
    const root = await tempDir();
    await writePlugin(
      root,
      'qq',
      channelManifest('qq', { control: true, controlPort: true }),
      pluginSource('qq'),
    );

    const host = new PluginHost({
      queue: new PerceptionQueue(),
      brain: makeBrain(),
      log: vi.fn(),
      control: { forPlugin: () => undefined },
    });
    await host.loadFrom(root);
    await host.startAll();

    expect(state.apis['qq']?.control).toBeUndefined();
  });

  it('treats a throwing control provider as "no port" and logs it', async () => {
    const state = installState();
    const root = await tempDir();
    await writePlugin(root, 'qq', channelManifest('qq'), pluginSource('qq'));

    const log = vi.fn<(line: string) => void>();
    const host = new PluginHost({
      queue: new PerceptionQueue(),
      brain: makeBrain(),
      log,
      control: {
        forPlugin: () => {
          throw new Error('boom');
        },
      },
    });
    await host.loadFrom(root);
    await host.startAll();

    expect(state.apis['qq']?.control).toBeUndefined();
    expect(host.status().find((plugin) => plugin.name === 'qq')?.state).toBe('active');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('control provider failed'));
  });

  it('does not build an api or consult the provider for a plugin that fails to activate', async () => {
    const root = await tempDir();
    await writePlugin(
      root,
      'qq',
      channelManifest('qq'),
      'export function createPlugin() { return {}; }',
    );

    const forPlugin = vi.fn(() => fakePort());
    const host = new PluginHost({
      queue: new PerceptionQueue(),
      brain: makeBrain(),
      log: vi.fn(),
      control: { forPlugin },
    });
    await host.loadFrom(root);
    await host.startAll();

    expect(host.status().find((plugin) => plugin.name === 'qq')?.state).toBe('failed');
    expect(forPlugin).not.toHaveBeenCalled();
  });
});
