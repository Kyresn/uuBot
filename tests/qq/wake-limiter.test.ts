import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPlugin,
  WakeLimiter,
  type QqServerLike,
} from '../../plugins/channels/qq/index.js';
import type { OneBotMessageEvent } from '../../plugins/channels/qq/protocol.js';
import type { ChannelPluginApiV1, PushEvent } from '../../src/plugins/api.js';
import { RuntimeConfigHandle } from '../../src/config/runtime-handle.js';
import { importFromEnv } from '../../src/config/harness-schema.js';

const SELF_ID = 100;
const GROUP_ID = 123;
const SENDER_WINDOW_MS = 30_000;
const GROUP_WINDOW_MS = 60_000;
const GROUP_MAX = 10;

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

describe('WakeLimiter', () => {
  it('allows the first wake for a sender', () => {
    const clock = makeClock();
    const limiter = new WakeLimiter({ now: clock.now });

    expect(limiter.allow('qq:group:1', '7')).toBe(true);
  });

  it('blocks the same sender for 30 seconds per channel', () => {
    const clock = makeClock();
    const limiter = new WakeLimiter({ now: clock.now });
    expect(limiter.allow('qq:group:1', '7')).toBe(true);

    clock.advance(SENDER_WINDOW_MS - 1);
    expect(limiter.allow('qq:group:1', '7')).toBe(false);

    clock.advance(1);
    expect(limiter.allow('qq:group:1', '7')).toBe(true);
  });

  it('tracks senders and channels independently', () => {
    const clock = makeClock();
    const limiter = new WakeLimiter({ now: clock.now });
    expect(limiter.allow('qq:group:1', '7')).toBe(true);

    expect(limiter.allow('qq:group:1', '8')).toBe(true);
    expect(limiter.allow('qq:group:2', '7')).toBe(true);
    expect(limiter.allow('qq:private:7', '7')).toBe(true);
  });

  it('allows 10 wakes per group per minute and blocks the 11th', () => {
    const clock = makeClock();
    const limiter = new WakeLimiter({ now: clock.now });

    for (let sender = 1; sender <= GROUP_MAX; sender += 1) {
      expect(limiter.allow('qq:group:1', String(sender), 'qq:group:1')).toBe(true);
    }
    expect(limiter.allow('qq:group:1', '11', 'qq:group:1')).toBe(false);
  });

  it('slides the group window after a minute', () => {
    const clock = makeClock();
    const limiter = new WakeLimiter({ now: clock.now });
    for (let sender = 1; sender <= GROUP_MAX; sender += 1) {
      expect(limiter.allow('qq:group:1', String(sender), 'qq:group:1')).toBe(true);
    }
    expect(limiter.allow('qq:group:1', '11', 'qq:group:1')).toBe(false);

    clock.advance(GROUP_WINDOW_MS);
    expect(limiter.allow('qq:group:1', '11', 'qq:group:1')).toBe(true);
  });

  it('does not spend the group budget on a sender-window rejection', () => {
    const clock = makeClock();
    const limiter = new WakeLimiter({ now: clock.now });
    expect(limiter.allow('qq:group:1', '1', 'qq:group:1')).toBe(true);
    expect(limiter.allow('qq:group:1', '1', 'qq:group:1')).toBe(false);

    for (let sender = 2; sender <= GROUP_MAX; sender += 1) {
      expect(limiter.allow('qq:group:1', String(sender), 'qq:group:1')).toBe(true);
    }
    expect(limiter.allow('qq:group:1', '99', 'qq:group:1')).toBe(false);
  });

  it('does not apply the group cap to private conversations', () => {
    const limiter = new WakeLimiter({ now: makeClock().now });

    for (let sender = 1; sender <= GROUP_MAX + 1; sender += 1) {
      expect(limiter.allow(`qq:private:${sender}`, String(sender))).toBe(true);
    }
  });
});

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
    send: async () => undefined,
    perception: { push, requestWake },
  };
  return { api, push, requestWake, log };
}

class FakeServer implements QqServerLike {
  handler: ((event: OneBotMessageEvent) => void) | null = null;
  connectionHandler: ((connected: boolean) => void) | null = null;
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

  call(): Promise<unknown> {
    return Promise.resolve({ message_id: 9001 });
  }

  emit(event: OneBotMessageEvent): void {
    this.handler?.(event);
  }
}

let nextMessageId = 1;

function groupEvent(overrides: Partial<OneBotMessageEvent> = {}): OneBotMessageEvent {
  const messageId = nextMessageId++;
  return {
    post_type: 'message',
    message_type: 'group',
    self_id: SELF_ID,
    user_id: 200,
    group_id: GROUP_ID,
    message_id: messageId,
    raw_message: `[CQ:at,qq=${SELF_ID}] 在吗`,
    sender: { user_id: 200, nickname: 'alice' },
    ...overrides,
  };
}

async function activate(): Promise<{
  fake: FakeServer;
  push: FakeApi['push'];
  requestWake: FakeApi['requestWake'];
}> {
  vi.stubEnv('QQ_WS_TOKEN', 'secret');
  vi.stubEnv('QQ_GROUP_ALLOWLIST', String(GROUP_ID));
  const fake = new FakeServer();
  const { api, push, requestWake } = createFakeApi();
  const plugin = createPlugin({
    server: fake,
    config: new RuntimeConfigHandle(importFromEnv(process.env)),
  });
  await plugin.activate(api);
  return { fake, push, requestWake };
}

beforeEach(() => {
  nextMessageId = 1;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('qq wake limiting', () => {
  it('keeps importance 9 but wakes at most once per sender per 30s', async () => {
    const { fake, push, requestWake } = await activate();

    fake.emit(groupEvent({ sender: { user_id: 200 }, user_id: 200 }));
    fake.emit(groupEvent({ sender: { user_id: 200 }, user_id: 200 }));

    expect(push).toHaveBeenCalledTimes(2);
    expect(push).toHaveBeenNthCalledWith(1, expect.objectContaining({ importance: 9 }));
    expect(push).toHaveBeenNthCalledWith(2, expect.objectContaining({ importance: 9 }));
    expect(requestWake).toHaveBeenCalledTimes(1);
  });

  it('wakes again once the sender window has passed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { fake, requestWake } = await activate();

    fake.emit(groupEvent());
    vi.setSystemTime(1_030_000);
    fake.emit(groupEvent());

    expect(requestWake).toHaveBeenCalledTimes(2);
  });

  it('caps group wakes at 10 per minute across senders', async () => {
    const { fake, push, requestWake } = await activate();

    for (let sender = 1; sender <= 11; sender += 1) {
      fake.emit(groupEvent({ sender: { user_id: sender }, user_id: sender }));
    }

    expect(push).toHaveBeenCalledTimes(11);
    expect(requestWake).toHaveBeenCalledTimes(10);
  });

  it('does not limit private wakes', async () => {
    vi.stubEnv('QQ_WS_TOKEN', 'secret');
    vi.stubEnv('QQ_PRIVATE_ALLOWLIST', '200');
    const fake = new FakeServer();
    const { api, requestWake } = createFakeApi();
    const plugin = createPlugin({
    server: fake,
    config: new RuntimeConfigHandle(importFromEnv(process.env)),
  });
    await plugin.activate(api);

    for (let index = 0; index < 2; index += 1) {
      fake.emit({
        post_type: 'message',
        message_type: 'private',
        self_id: SELF_ID,
        user_id: 200,
        message_id: 500 + index,
        raw_message: 'hi',
        sender: { user_id: 200 },
      });
    }

    // 私聊不受群 @ 洪泛的限速影响：追一句必须立刻唤醒。
    expect(requestWake).toHaveBeenCalledTimes(2);
  });
});
