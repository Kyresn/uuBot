/**
 * T3 web 渠道插件：入站推事件并唤醒、出站追加到桥接、deactivate 关闭入站。
 *
 * 插件只依赖注入的 `WebChatBridge`，不接触宿主内部对象；测试用假 api
 * 记录感知队列调用，桥接用真实实现。
 */
import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createPlugin } from '../../plugins/channels/web/index.js';
import { readManifest } from '../../src/plugins/manifest.js';
import type { ChannelPluginApiV1, PushEvent } from '../../src/plugins/api.js';
import { WebChatBridge } from '../../src/web/chat-bridge.js';

interface FakeApi {
  api: ChannelPluginApiV1;
  push: ReturnType<typeof vi.fn<(event: PushEvent) => void>>;
  requestWake: ReturnType<typeof vi.fn<() => void>>;
  log: ReturnType<typeof vi.fn<(line: string) => void>>;
}

function createFakeApi(): FakeApi {
  const push = vi.fn<(event: PushEvent) => void>();
  const requestWake = vi.fn<() => void>();
  const log = vi.fn<(line: string) => void>();
  const api: ChannelPluginApiV1 = {
    name: 'web',
    kind: 'channel',
    channelPrefix: 'web',
    config: {},
    log,
    reply: vi.fn<(text: string) => void>(),
    brain: {
      chat: async () => {
        throw new Error('not used by the web plugin');
      },
    },
    memory: {
      search: async () => [],
      write: async () => undefined,
    },
    send: async () => undefined,
    perception: { push, requestWake },
  };
  return { api, push, requestWake, log };
}

describe('web channel manifest', () => {
  it('declares the web prefix and the index.ts entry', async () => {
    const manifest = await readManifest(
      fileURLToPath(new URL('../../plugins/channels/web', import.meta.url)),
    );
    expect(manifest.name).toBe('web');
    expect(manifest.kind).toBe('channel');
    expect(manifest.channelPrefix).toBe('web');
    expect(manifest.entry).toBe('index.ts');
  });
});

describe('web channel plugin', () => {
  it('refuses to activate without an injected bridge', () => {
    const plugin = createPlugin();
    const { api } = createFakeApi();
    expect(() => plugin.activate(api)).toThrow(/[Bb]ridge/);
  });

  it('pushes a web_message event and requests a wake for inbound text', () => {
    const bridge = new WebChatBridge();
    const plugin = createPlugin({ bridge });
    const { api, push, requestWake } = createFakeApi();
    plugin.activate(api);

    expect(bridge.submit('你好')).toEqual({ ok: true });

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({
      kind: 'web_message',
      channel: 'web:main',
      actor: 'owner',
      content: '你好',
      importance: 9,
    });
    expect(requestWake).toHaveBeenCalledTimes(1);
  });

  it('produces no event for whitespace-only input', () => {
    const bridge = new WebChatBridge();
    const plugin = createPlugin({ bridge });
    const { api, push, requestWake } = createFakeApi();
    plugin.activate(api);

    expect(bridge.submit('   ')).toEqual({ ok: false, code: 'empty' });
    expect(push).not.toHaveBeenCalled();
    expect(requestWake).not.toHaveBeenCalled();
  });

  it('appends outbound agent text to the bridge', () => {
    const bridge = new WebChatBridge();
    const plugin = createPlugin({ bridge });
    plugin.activate(createFakeApi().api);

    plugin.send('web:main', '这是回复');

    expect(bridge.snapshot()).toContainEqual(
      expect.objectContaining({ role: 'agent', text: '这是回复' }),
    );
  });

  it('throws when send() runs before activate()', () => {
    const bridge = new WebChatBridge();
    const plugin = createPlugin({ bridge });
    expect(() => plugin.send('web:main', 'x')).toThrow(/activate/);
  });

  it('closes the inbound path on deactivate', () => {
    const bridge = new WebChatBridge();
    const plugin = createPlugin({ bridge });
    const { api, push } = createFakeApi();
    plugin.activate(api);

    plugin.deactivate();

    expect(bridge.submit('再试一次')).toEqual({ ok: false, code: 'closed' });
    expect(push).not.toHaveBeenCalled();
  });

  it('does not double-subscribe when activate() is called twice', () => {
    const bridge = new WebChatBridge();
    const plugin = createPlugin({ bridge });
    const { api, push, requestWake } = createFakeApi();
    plugin.activate(api);
    plugin.activate(api);

    bridge.submit('一次');

    expect(push).toHaveBeenCalledTimes(1);
    expect(requestWake).toHaveBeenCalledTimes(1);
  });
});
