import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupGuard } from '../../plugins/channels/qq/guard.js';
import { createPlugin, type QqServerLike } from '../../plugins/channels/qq/index.js';
import type { OneBotMessageEvent } from '../../plugins/channels/qq/protocol.js';
import type { ControlPort } from '../../src/control/types.js';
import type { ChannelPluginApiV1, PushEvent } from '../../src/plugins/api.js';
import { RuntimeConfigHandle } from '../../src/config/runtime-handle.js';
import { importFromEnv } from '../../src/config/harness-schema.js';

const SELF_ID = 100;
const GROUP_ID = 123;
const USER_ID = 200;

interface Clock {
  now: () => number;
  advance: (ms: number) => void;
}

function makeClock(start = 1_000_000): Clock {
  let time = start;
  return {
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
  };
}

interface FakeApi {
  api: ChannelPluginApiV1;
  push: ReturnType<typeof vi.fn<(event: PushEvent) => void>>;
  requestWake: ReturnType<typeof vi.fn<() => void>>;
  log: ReturnType<typeof vi.fn<(line: string) => void>>;
  send: ReturnType<typeof vi.fn<(channel: string, text: string) => Promise<void>>>;
}

function createFakeApi(control?: ControlPort): FakeApi {
  const push = vi.fn<(event: PushEvent) => void>();
  const requestWake = vi.fn<() => void>();
  const log = vi.fn<(line: string) => void>();
  const send = vi.fn<(channel: string, text: string) => Promise<void>>(async () => undefined);
  const api: ChannelPluginApiV1 = {
    name: 'qq',
    kind: 'channel',
    channelPrefix: 'qq',
    config: {},
    log,
    reply: vi.fn<(text: string) => void>(),
    brain: {
      chat: async () => {
        throw new Error('not used by the qq plugin');
      },
    },
    memory: {
      search: async () => [],
      write: async () => undefined,
    },
    send,
    perception: { push, requestWake },
    ...(control === undefined ? {} : { control }),
  };
  return { api, push, requestWake, log, send };
}

class FakeServer implements QqServerLike {
  handler: ((event: OneBotMessageEvent) => void) | null = null;
  connectionHandler: ((connected: boolean) => void) | null = null;
  readonly calls: Array<{ action: string; params: Record<string, unknown> }> = [];
  connected = false;
  selfId: number | undefined;
  port = 3001;

  async start(): Promise<void> {
    this.connected = true;
  }

  async stop(): Promise<void> {
    this.connected = false;
  }

  setOnEvent(handler: (event: OneBotMessageEvent) => void): void {
    this.handler = handler;
  }

  setOnConnectionChange(handler: (connected: boolean) => void): void {
    this.connectionHandler = handler;
  }

  call(action: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ action, params });
    return Promise.resolve({ message_id: 9001 });
  }

  emit(event: OneBotMessageEvent): void {
    this.handler?.(event);
  }

  async emitAsync(event: OneBotMessageEvent): Promise<void> {
    await (this.handler?.(event) as Promise<void> | undefined);
  }
}

let nextMessageId = 1;

function groupEvent(overrides: Partial<OneBotMessageEvent> = {}): OneBotMessageEvent {
  const messageId = nextMessageId++;
  return {
    post_type: 'message',
    message_type: 'group',
    self_id: SELF_ID,
    user_id: USER_ID,
    group_id: GROUP_ID,
    message_id: messageId,
    raw_message: 'hello',
    sender: { user_id: USER_ID, nickname: 'alice' },
    ...overrides,
  };
}

interface Activated {
  plugin: ReturnType<typeof createPlugin>;
  fake: FakeServer;
  push: FakeApi['push'];
  requestWake: FakeApi['requestWake'];
  log: FakeApi['log'];
  send: FakeApi['send'];
}

async function activate(
  guard: GroupGuard,
  env: Record<string, string> = {},
  control?: ControlPort,
): Promise<Activated> {
  vi.stubEnv('QQ_WS_TOKEN', 'secret');
  vi.stubEnv('QQ_GROUP_ALLOWLIST', String(GROUP_ID));
  vi.stubEnv('QQ_PRIVATE_ALLOWLIST', String(USER_ID));
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const fake = new FakeServer();
  const { api, push, requestWake, log, send } = createFakeApi(control);
  const plugin = createPlugin({
    server: fake,
    guard,
    config: new RuntimeConfigHandle(importFromEnv(process.env)),
  });
  await plugin.activate(api);
  return { plugin, fake, push, requestWake, log, send };
}

beforeEach(() => {
  nextMessageId = 1;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('qq silence double gate', () => {
  it('blocks group sends while the group is silenced and logs the reason', async () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });
    guard.silence(String(GROUP_ID), clock.now() + 60_000);
    const { plugin, fake, log } = await activate(guard);

    await plugin.send(`qq:group:${GROUP_ID}`, 'hi');

    expect(fake.calls).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(`qq: guard blocked group ${GROUP_ID}: silenced`);
  });

  it('blocks group sends under the global silence key', async () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });
    guard.silence('*', clock.now() + 60_000);
    const { plugin, fake } = await activate(guard);

    await plugin.send(`qq:group:${GROUP_ID}`, 'hi');

    expect(fake.calls).toHaveLength(0);
  });

  it('does not apply silence to private sends', async () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });
    guard.silence('*', clock.now() + 60_000);
    const { plugin, fake } = await activate(guard);

    await plugin.send(`qq:private:${USER_ID}`, 'hi');

    expect(fake.calls).toHaveLength(1);
  });

  it('downgrades a silenced group @ by 3 and never wakes', async () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });
    guard.silence(String(GROUP_ID), clock.now() + 60_000);
    const { fake, push, requestWake } = await activate(guard);

    fake.emit(groupEvent({ raw_message: `[CQ:at,qq=${SELF_ID}] 在吗` }));

    expect(push).toHaveBeenCalledWith(expect.objectContaining({ importance: 6 }));
    expect(requestWake).not.toHaveBeenCalled();
  });

  it('downgrades an ordinary silenced group message to importance 0', async () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });
    guard.silence(String(GROUP_ID), clock.now() + 60_000);
    const { fake, push, requestWake } = await activate(guard);

    fake.emit(groupEvent({ raw_message: '普通发言' }));

    expect(push).toHaveBeenCalledWith(expect.objectContaining({ importance: 0 }));
    expect(requestWake).not.toHaveBeenCalled();
  });

  it('leaves a group that is not silenced untouched', async () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });
    const { fake, push, requestWake } = await activate(guard);

    fake.emit(groupEvent({ raw_message: `[CQ:at,qq=${SELF_ID}] 在吗` }));

    expect(push).toHaveBeenCalledWith(expect.objectContaining({ importance: 9 }));
    expect(requestWake).toHaveBeenCalledTimes(1);
  });

  it('wakes again after the silence expires', async () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });
    guard.silence(String(GROUP_ID), clock.now() + 60_000);
    const { fake, requestWake } = await activate(guard);

    clock.advance(60_000);
    fake.emit(groupEvent({ raw_message: `[CQ:at,qq=${SELF_ID}] 在吗` }));

    expect(requestWake).toHaveBeenCalledTimes(1);
  });

  it('restores operator silence into a fresh guard', async () => {
    const clock = makeClock();
    const source = new GroupGuard({ now: clock.now });
    source.silence(String(GROUP_ID), clock.now() + 60_000);

    const restored = new GroupGuard({ now: clock.now });
    restored.restoreOperatorState(source.exportOperatorState());
    const { plugin, fake } = await activate(restored);

    await plugin.send(`qq:group:${GROUP_ID}`, 'hi');

    expect(fake.calls).toHaveLength(0);
  });

  it('delivers a control receipt while its group is silenced', async () => {
    const clock = makeClock();
    const guard = new GroupGuard({ now: clock.now });
    guard.silence(String(GROUP_ID), clock.now() + 60_000);
    const port: ControlPort = {
      handle: vi.fn(async (input) => {
        await input.reply('已静默。');
        return { action: 'handled' as const };
      }),
    };
    const { fake, push, send } = await activate(
      guard,
      { QQ_OWNER_ID: '300', QQ_CONTROL_ENABLED: '1' },
      port,
    );

    await fake.emitAsync({
      post_type: 'message',
      message_type: 'private',
      self_id: SELF_ID,
      user_id: 300,
      message_id: 1,
      raw_message: `#安静 ${GROUP_ID} 30`,
      sender: { user_id: 300 },
    });

    // 控制回执不受静默影响：静默吞掉回执，owner 就永远看不到待办。
    expect(send).toHaveBeenCalledWith('qq:private:300', '已静默。');
    expect(push).not.toHaveBeenCalled();
  });
});
