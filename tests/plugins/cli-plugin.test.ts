import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { createPlugin } from '../../plugins/channels/cli/index.js';
import type { ChannelPluginApiV1, PushEvent } from '../../src/plugins/api.js';

/** Minimal readable-stream stand-in: readline only needs data/on/setEncoding/resume. */
class FakeInput extends EventEmitter {
  setEncoding(_encoding: string): this {
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
  asStream(): NodeJS.ReadableStream {
    return this as unknown as NodeJS.ReadableStream;
  }
}

interface FakeApi {
  api: ChannelPluginApiV1;
  push: ReturnType<typeof vi.fn<(event: PushEvent) => void>>;
  requestWake: ReturnType<typeof vi.fn<() => void>>;
  log: ReturnType<typeof vi.fn<(line: string) => void>>;
  reply: ReturnType<typeof vi.fn<(text: string) => void>>;
}

function createFakeApi(overrides: Partial<ChannelPluginApiV1> = {}): FakeApi {
  const push = vi.fn<(event: PushEvent) => void>();
  const requestWake = vi.fn<() => void>();
  const log = vi.fn<(line: string) => void>();
  const reply = vi.fn<(text: string) => void>();
  const api: ChannelPluginApiV1 = {
    name: 'cli',
    kind: 'channel',
    config: {},
    log,
    reply,
    brain: {
      chat: async () => {
        throw new Error('not used by the cli plugin');
      },
    },
    memory: {
      search: async () => [],
      write: async () => undefined,
    },
    send: async () => undefined,
    perception: { push, requestWake },
    ...overrides,
  };
  return { api, push, requestWake, log, reply };
}

describe('cli channel plugin', () => {
  it('pushes one importance-8 cli_message and requests a wake per input line', async () => {
    const input = new FakeInput();
    const { api, push, requestWake } = createFakeApi();
    const plugin = createPlugin({ input: input.asStream() });

    await plugin.activate(api);
    input.emit('data', 'hello\n');

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({
      kind: 'cli_message',
      channel: 'cli',
      actor: 'user',
      content: 'hello',
      importance: 8,
    });
    expect(requestWake).toHaveBeenCalledTimes(1);
  });

  it('uses the injected channelPrefix for pushed events', async () => {
    const input = new FakeInput();
    const { api, push } = createFakeApi({ channelPrefix: 'local' });
    const plugin = createPlugin({ input: input.asStream() });

    await plugin.activate(api);
    input.emit('data', 'hello\n');

    expect(push).toHaveBeenCalledWith(expect.objectContaining({ channel: 'local' }));
  });

  it('ignores blank and whitespace-only input lines', async () => {
    const input = new FakeInput();
    const { api, push, requestWake } = createFakeApi();
    const plugin = createPlugin({ input: input.asStream() });

    await plugin.activate(api);
    input.emit('data', '\n');
    input.emit('data', '   \n');
    input.emit('data', '\t\n');

    expect(push).not.toHaveBeenCalled();
    expect(requestWake).not.toHaveBeenCalled();
  });

  it('send writes to api.reply, not api.log', async () => {
    const input = new FakeInput();
    const { api, log, reply } = createFakeApi();
    const plugin = createPlugin({ input: input.asStream() });

    await plugin.activate(api);
    await plugin.send('cli', 'hi');

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith('它: hi');
    expect(log).not.toHaveBeenCalled();
  });

  it('produces no events after deactivate', async () => {
    const input = new FakeInput();
    const { api, push, requestWake } = createFakeApi();
    const plugin = createPlugin({ input: input.asStream() });

    await plugin.activate(api);
    await plugin.deactivate();
    input.emit('data', 'late\n');

    expect(push).not.toHaveBeenCalled();
    expect(requestWake).not.toHaveBeenCalled();
  });
});
