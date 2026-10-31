import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAllowed, parseList, type AllowLists } from '../../plugins/channels/qq/allowlist.js';
import { GroupGuard } from '../../plugins/channels/qq/guard.js';
import {
  createPlugin,
  readConfig,
  type QqPluginDeps,
  type QqServerLike,
} from '../../plugins/channels/qq/index.js';
import type { OneBotMessageEvent } from '../../plugins/channels/qq/protocol.js';
import type { ControlPort } from '../../src/control/types.js';
import type { ChannelPluginApiV1, PushEvent } from '../../src/plugins/api.js';
import { readManifest } from '../../src/plugins/manifest.js';
import { RuntimeConfigHandle } from '../../src/config/runtime-handle.js';
import {
  importFromEnv,
  type HarnessQqConfig,
} from '../../src/config/harness-schema.js';

interface FakeApi {
  api: ChannelPluginApiV1;
  push: ReturnType<typeof vi.fn<(event: PushEvent) => void>>;
  requestWake: ReturnType<typeof vi.fn<() => void>>;
  log: ReturnType<typeof vi.fn<(line: string) => void>>;
}

function createFakeApi(control?: ControlPort): FakeApi {
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
    ...(control === undefined ? {} : { control }),
  };
  return { api, push, requestWake, log };
}

/** In-memory stand-in for QqServer: records calls, exposes an emit() hook. */
class FakeServer implements QqServerLike {
  handler: ((event: OneBotMessageEvent) => void) | null = null;
  noticeHandler: ((event: unknown) => void) | null = null;
  connectionHandler: ((connected: boolean) => void) | null = null;
  readonly calls: Array<{ action: string; params: Record<string, unknown> }> = [];
  response: unknown = { message_id: 9001 };
  rejectWith: Error | null = null;
  starts = 0;
  stops = 0;
  connected = false;
  selfId: number | undefined;
  port = 3001;

  async start(): Promise<void> {
    this.starts += 1;
    this.connected = true;
  }

  async stop(): Promise<void> {
    this.stops += 1;
    this.connected = false;
  }

  setOnEvent(handler: (event: OneBotMessageEvent) => void): void {
    this.handler = handler;
  }

  setOnNotice(handler: (event: unknown) => void): void {
    this.noticeHandler = handler;
  }

  setOnConnectionChange(handler: (connected: boolean) => void): void {
    this.connectionHandler = handler;
  }

  call(action: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ action, params });
    if (this.rejectWith !== null) return Promise.reject(this.rejectWith);
    return Promise.resolve(this.response);
  }

  emit(event: OneBotMessageEvent): void {
    this.handler?.(event);
  }

  async emitAsync(event: OneBotMessageEvent): Promise<void> {
    await (this.handler?.(event) as Promise<void> | undefined);
  }

  emitNotice(event: unknown): void {
    this.noticeHandler?.(event);
  }

  emitConnection(connected: boolean): void {
    this.connectionHandler?.(connected);
  }
}

const SELF_ID = 100;
const GROUP_ID = 123;
const USER_ID = 200;
const OWNER_ID = 300;

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

function privateEvent(overrides: Partial<OneBotMessageEvent> = {}): OneBotMessageEvent {
  const messageId = nextMessageId++;
  return {
    post_type: 'message',
    message_type: 'private',
    self_id: SELF_ID,
    user_id: USER_ID,
    message_id: messageId,
    raw_message: 'hello',
    sender: { user_id: USER_ID, nickname: 'alice' },
    ...overrides,
  };
}

interface Activated {
  plugin: ReturnType<typeof createPlugin>;
  api: ChannelPluginApiV1;
  fake: FakeServer;
  push: FakeApi['push'];
  requestWake: FakeApi['requestWake'];
  log: FakeApi['log'];
  config: RuntimeConfigHandle;
}

async function activate(
  env: Record<string, string> = {},
  fake: FakeServer = new FakeServer(),
  deps: Omit<QqPluginDeps, 'server' | 'config'> & { config?: RuntimeConfigHandle } = {},
  control?: ControlPort,
): Promise<Activated> {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const { api, push, requestWake, log } = createFakeApi(control);
  const config = deps.config ?? new RuntimeConfigHandle(importFromEnv(process.env));
  const plugin = createPlugin({ server: fake, ...deps, config });
  await plugin.activate(api);
  return { plugin, api, fake, push, requestWake, log, config };
}

beforeEach(() => {
  nextMessageId = 1;
  vi.stubEnv('QQ_WS_TOKEN', 'secret');
  vi.stubEnv('QQ_WS_PORT', '3001');
  vi.stubEnv('QQ_GROUP_ALLOWLIST', '');
  vi.stubEnv('QQ_GROUP_DENYLIST', '');
  vi.stubEnv('QQ_PRIVATE_ALLOWLIST', '');
  vi.stubEnv('QQ_PRIVATE_DENYLIST', '');
  vi.stubEnv('QQ_PRIVATE_OPEN', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('qq allowlist', () => {
  const empty: AllowLists = {
    groupAllowlist: new Set(),
    groupDenylist: new Set(),
    privateAllowlist: new Set(),
    privateDenylist: new Set(),
    privateOpen: false,
  };

  it('parses comma-separated lists, trimming blanks and empty entries', () => {
    expect(parseList(' 1, 2 ,,3 ')).toEqual(new Set(['1', '2', '3']));
    expect(parseList(undefined)).toEqual(new Set());
    expect(parseList('')).toEqual(new Set());
  });

  it('requires group ids to be on the group allowlist', () => {
    expect(isAllowed({ group: '1', userId: '2' }, empty)).toBe(false);
    expect(
      isAllowed({ group: '1' }, { ...empty, groupAllowlist: new Set(['1']) }),
    ).toBe(true);
  });

  it('lets the group denylist win over the allowlist', () => {
    const lists: AllowLists = {
      ...empty,
      groupAllowlist: new Set(['1']),
      groupDenylist: new Set(['1']),
    };

    expect(isAllowed({ group: '1', userId: '2' }, lists)).toBe(false);
  });

  it('accepts no private sender when the channel is closed and the allowlist is empty', () => {
    // 默认失败关闭：名单关闭 ≠ 对所有人开放。
    expect(isAllowed({ userId: '2' }, empty)).toBe(false);
  });

  it('accepts an allowlisted private sender in closed mode', () => {
    expect(
      isAllowed({ userId: '2' }, { ...empty, privateAllowlist: new Set(['2']) }),
    ).toBe(true);
    expect(
      isAllowed({ userId: '3' }, { ...empty, privateAllowlist: new Set(['2']) }),
    ).toBe(false);
  });

  it('accepts any non-denylisted private sender when the private lists are disabled', () => {
    expect(isAllowed({ userId: '2' }, { ...empty, privateOpen: true })).toBe(true);
    expect(
      isAllowed(
        { userId: '2' },
        { ...empty, privateOpen: true, privateAllowlist: new Set(['9']) },
      ),
    ).toBe(true);
  });

  it('lets the private denylist win in open mode', () => {
    expect(
      isAllowed({ userId: '2' }, { ...empty, privateOpen: true, privateDenylist: new Set(['2']) }),
    ).toBe(false);
    expect(
      isAllowed(
        { userId: '2' },
        {
          ...empty,
          privateOpen: true,
          privateAllowlist: new Set(['2']),
          privateDenylist: new Set(['2']),
        },
      ),
    ).toBe(false);
  });

  it('lets the private denylist win over the allowlist', () => {
    const lists: AllowLists = {
      ...empty,
      privateAllowlist: new Set(['2']),
      privateDenylist: new Set(['2']),
    };

    expect(isAllowed({ userId: '2' }, lists)).toBe(false);
  });
});

describe('qq config', () => {
  function qqConfig(overrides: Partial<HarnessQqConfig> = {}): HarnessQqConfig {
    return { ...importFromEnv({ QQ_WS_TOKEN: 'x' }).qq, ...overrides };
  }

  it('trims wsToken so surrounding whitespace still authenticates', () => {
    expect(readConfig(qqConfig({ wsToken: ' secret \n' })).token).toBe('secret');
  });

  it('requires a token', () => {
    expect(() => readConfig(qqConfig({ wsToken: '   ' }))).toThrow(/wsToken/);
  });

  it('passes the validated port through, including the ephemeral port 0', () => {
    expect(readConfig(qqConfig({ wsPort: 3001 })).port).toBe(3001);
    expect(readConfig(qqConfig({ wsPort: 0 })).port).toBe(0);
  });

  it('maps host, privateOpen, selfId and the reply gap', () => {
    const config = readConfig(
      qqConfig({
        wsHost: '0.0.0.0',
        privateOpen: true,
        selfId: '0100',
        minReplyGapMs: 5_000,
      }),
    );

    expect(config.host).toBe('0.0.0.0');
    expect(config.privateOpen).toBe(true);
    expect(config.selfId).toBe(100);
    expect(config.minGapMs).toBe(5_000);
    expect(readConfig(qqConfig({ selfId: '' })).selfId).toBeUndefined();
    // The schema allows 0; the plugin must not re-impose a positive-only rule.
    expect(readConfig(qqConfig({ minReplyGapMs: 0 })).minGapMs).toBe(0);
  });

  it('maps the allowlists and normalises the private denylist', () => {
    const config = readConfig(
      qqConfig({
        groupAllowlist: ['123'],
        groupDenylist: ['456'],
        privateAllowlist: ['200'],
        privateDenylist: ['0200'],
      }),
    );

    expect(config.lists.groupAllowlist).toEqual(new Set(['123']));
    expect(config.lists.groupDenylist).toEqual(new Set(['456']));
    expect(config.lists.privateAllowlist).toEqual(new Set(['200']));
    expect(config.lists.privateDenylist).toEqual(new Set(['200']));
  });
});

describe('qq channel plugin', () => {
  it('fails activation with a clear error when the configured token is missing', async () => {
    vi.stubEnv('QQ_WS_TOKEN', '');
    const fake = new FakeServer();
    const { api } = createFakeApi();
    const plugin = createPlugin({
      server: fake,
      config: new RuntimeConfigHandle(importFromEnv(process.env)),
    });

    await expect(plugin.activate(api)).rejects.toThrow(/wsToken/);
    expect(fake.starts).toBe(0);
  });

  it('reads qq config from the injected handle, not process.env', async () => {
    vi.stubEnv('QQ_GROUP_ALLOWLIST', '999');
    vi.stubEnv('QQ_WS_TOKEN', 'env-token');
    const handle = new RuntimeConfigHandle(
      importFromEnv({ QQ_WS_TOKEN: 'handle-token', QQ_GROUP_ALLOWLIST: String(GROUP_ID) }),
    );
    const { fake, push } = await activate({}, new FakeServer(), { config: handle });

    fake.emit(groupEvent());

    expect(push).toHaveBeenCalledTimes(1);
  });

  it('re-activates with the new handle config and keeps the shared guard state', async () => {
    const guard = new GroupGuard();
    const handle = new RuntimeConfigHandle(
      importFromEnv({ QQ_WS_TOKEN: 'secret', QQ_GROUP_ALLOWLIST: String(GROUP_ID) }),
    );
    const fake = new FakeServer();
    const first = await activate({}, fake, { guard, config: handle });

    guard.silence(String(GROUP_ID), Date.now() + 60_000);
    handle.swap({
      ...handle.get(),
      qq: { ...handle.get().qq, groupAllowlist: [] },
    });

    await first.plugin.deactivate();
    const second = createFakeApi();
    await first.plugin.activate(second.api);

    // 装配点持有的护栏实例与状态不因重载而重置。
    expect(guard.isSilenced(String(GROUP_ID))).toBe(true);

    // 新配置立即生效：白名单已清空，事件被丢弃。
    fake.emit(groupEvent());
    expect(second.push).not.toHaveBeenCalled();
  });

  it('starts the server on activate and stops it on deactivate', async () => {
    const { plugin, fake } = await activate();

    expect(fake.starts).toBe(1);

    await plugin.deactivate();

    expect(fake.stops).toBe(1);
  });

  it('ignores events after deactivate', async () => {
    const { plugin, fake, push } = await activate({ QQ_GROUP_ALLOWLIST: String(GROUP_ID) });

    await plugin.deactivate();
    // 停用路径会先发布一条断开状态；之后不得再有任何入站事件。
    push.mockClear();
    fake.emit(groupEvent());

    expect(push).not.toHaveBeenCalled();
  });

  it('drops malformed events, logs, and never throws', async () => {
    const { fake, push, requestWake, log } = await activate({
      QQ_GROUP_ALLOWLIST: String(GROUP_ID),
      QQ_PRIVATE_ALLOWLIST: String(USER_ID),
    });

    const malformed: unknown[] = [
      null,
      'not an object',
      { post_type: 'message' },
      { post_type: 'message', message_type: 'private' },
      {
        post_type: 'message',
        message_type: 'private',
        self_id: String(SELF_ID),
        sender: { user_id: USER_ID },
        message_id: 1,
        raw_message: 'hi',
      },
      {
        post_type: 'message',
        message_type: 'private',
        self_id: SELF_ID,
        sender: 'not an object',
        message_id: 1,
        raw_message: 'hi',
      },
      {
        post_type: 'message',
        message_type: 'private',
        self_id: SELF_ID,
        sender: { user_id: String(USER_ID) },
        message_id: 1,
        raw_message: 'hi',
      },
      {
        post_type: 'message',
        message_type: 'private',
        self_id: SELF_ID,
        sender: { user_id: USER_ID },
        message_id: '1',
        raw_message: 'hi',
      },
      {
        post_type: 'message',
        message_type: 'private',
        self_id: SELF_ID,
        sender: { user_id: USER_ID },
        message_id: 1,
        raw_message: 42,
      },
      {
        post_type: 'message',
        message_type: 'group',
        self_id: SELF_ID,
        sender: { user_id: USER_ID },
        message_id: 1,
        raw_message: 'hi',
      },
    ];

    for (const event of malformed) {
      expect(() => fake.emit(event as unknown as OneBotMessageEvent)).not.toThrow();
    }

    expect(push).not.toHaveBeenCalled();
    expect(requestWake).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(malformed.length);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('malformed'));
  });

  it('drops message types other than group and private instead of treating them as private', async () => {
    const { fake, push, requestWake, log } = await activate({
      QQ_GROUP_ALLOWLIST: String(GROUP_ID),
      QQ_PRIVATE_ALLOWLIST: String(USER_ID),
    });

    for (const messageType of ['discuss', 'guild', 'channel']) {
      expect(() =>
        fake.emit(
          privateEvent({ message_type: messageType as OneBotMessageEvent['message_type'] }),
        ),
      ).not.toThrow();
    }

    expect(push).not.toHaveBeenCalled();
    expect(requestWake).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('message_type'));
  });

  it('drops messages sent by the bot itself', async () => {
    const { fake, push, requestWake } = await activate({
      QQ_GROUP_ALLOWLIST: String(GROUP_ID),
    });

    fake.emit(groupEvent({ sender: { user_id: SELF_ID }, user_id: SELF_ID }));

    expect(push).not.toHaveBeenCalled();
    expect(requestWake).not.toHaveBeenCalled();
  });

  it('drops group messages from groups outside the allowlist', async () => {
    const { fake, push } = await activate({ QQ_GROUP_ALLOWLIST: '999' });

    fake.emit(groupEvent());

    expect(push).not.toHaveBeenCalled();
  });

  it('treats an empty group allowlist as no active groups', async () => {
    const { fake, push } = await activate();

    fake.emit(groupEvent());

    expect(push).not.toHaveBeenCalled();
  });

  it('lets the group denylist win over the group allowlist', async () => {
    const { fake, push } = await activate({
      QQ_GROUP_ALLOWLIST: String(GROUP_ID),
      QQ_GROUP_DENYLIST: String(GROUP_ID),
    });

    fake.emit(groupEvent());

    expect(push).not.toHaveBeenCalled();
  });

  it('pushes an ordinary group message at importance 3 without waking', async () => {
    const { fake, push, requestWake } = await activate({
      QQ_GROUP_ALLOWLIST: String(GROUP_ID),
    });

    fake.emit(groupEvent({ raw_message: 'hi[CQ:face,id=1]' }));

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({
      kind: 'qq_group_message',
      channel: `qq:group:${GROUP_ID}`,
      actor: `group:${GROUP_ID}/${USER_ID}`,
      content: 'hi[表情]',
      importance: 3,
    });
    expect(requestWake).not.toHaveBeenCalled();
  });

  it('wakes on a group message that mentions the bot', async () => {
    const { fake, push, requestWake } = await activate({
      QQ_GROUP_ALLOWLIST: String(GROUP_ID),
    });

    fake.emit(groupEvent({ raw_message: `[CQ:at,qq=${SELF_ID}] 在吗` }));

    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({ importance: 9, content: `[@${SELF_ID}] 在吗` }),
    );
    expect(requestWake).toHaveBeenCalledTimes(1);
  });

  it('wakes on a group message that replies to one of the bot messages', async () => {
    const { fake, push, requestWake } = await activate({
      QQ_GROUP_ALLOWLIST: String(GROUP_ID),
    });

    // A self message is dropped but still marks the id as bot-authored.
    fake.emit(groupEvent({ sender: { user_id: SELF_ID }, user_id: SELF_ID, message_id: 55 }));
    fake.emit(groupEvent({ raw_message: '[CQ:reply,id=55] 继续' }));

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ importance: 9 }));
    expect(requestWake).toHaveBeenCalledTimes(1);
  });

  it('does not wake on a reply to someone else', async () => {
    const { fake, push, requestWake } = await activate({
      QQ_GROUP_ALLOWLIST: String(GROUP_ID),
    });

    fake.emit(groupEvent({ raw_message: '[CQ:reply,id=999] 继续' }));

    expect(push).toHaveBeenCalledWith(expect.objectContaining({ importance: 3 }));
    expect(requestWake).not.toHaveBeenCalled();
  });

  it('pushes allowed private messages at importance 9 and wakes', async () => {
    const { fake, push, requestWake } = await activate({
      QQ_PRIVATE_ALLOWLIST: String(USER_ID),
    });

    fake.emit(privateEvent({ raw_message: 'dm[CQ:image,file=a.jpg]' }));

    expect(push).toHaveBeenCalledWith({
      kind: 'qq_private_message',
      channel: `qq:private:${USER_ID}`,
      actor: `private:${USER_ID}`,
      content: 'dm[图片]',
      importance: 9,
    });
    expect(requestWake).toHaveBeenCalledTimes(1);
  });

  it('drops private messages when the allowlist is empty and the channel is closed', async () => {
    const { fake, push } = await activate();

    fake.emit(privateEvent());

    expect(push).not.toHaveBeenCalled();
  });

  it('drops a private message from a sender outside a closed allowlist', async () => {
    const { fake, push } = await activate({ QQ_PRIVATE_ALLOWLIST: '999' });

    fake.emit(privateEvent());

    expect(push).not.toHaveBeenCalled();
  });

  it('accepts any non-denylisted private sender when QQ_PRIVATE_OPEN=true', async () => {
    const { fake, push, requestWake } = await activate({ QQ_PRIVATE_OPEN: 'true' });

    fake.emit(privateEvent());

    expect(push).toHaveBeenCalledWith({
      kind: 'qq_private_message',
      channel: `qq:private:${USER_ID}`,
      actor: `private:${USER_ID}`,
      content: 'hello',
      importance: 9,
    });
    expect(requestWake).toHaveBeenCalledTimes(1);
  });

  it('drops a denylisted private sender even when QQ_PRIVATE_OPEN=true', async () => {
    const { fake, push } = await activate({
      QQ_PRIVATE_OPEN: '1',
      QQ_PRIVATE_DENYLIST: String(USER_ID),
    });

    fake.emit(privateEvent());

    expect(push).not.toHaveBeenCalled();
  });

  it('lets the private denylist win over the private allowlist', async () => {
    const { fake, push } = await activate({
      QQ_PRIVATE_ALLOWLIST: String(USER_ID),
      QQ_PRIVATE_DENYLIST: String(USER_ID),
    });

    fake.emit(privateEvent());

    expect(push).not.toHaveBeenCalled();
  });

  it('dedupes repeated message ids', async () => {
    const { fake, push } = await activate({ QQ_GROUP_ALLOWLIST: String(GROUP_ID) });
    const event = groupEvent({ message_id: 777 });

    fake.emit(event);
    fake.emit(event);

    expect(push).toHaveBeenCalledTimes(1);
  });

  it('does not record a response for a duplicate message id', async () => {
    const guard = new GroupGuard();
    const recordResponse = vi.spyOn(guard, 'recordResponse');
    const { fake } = await activate(
      { QQ_GROUP_ALLOWLIST: String(GROUP_ID) },
      new FakeServer(),
      { guard },
    );
    const event = groupEvent({ message_id: 777 });

    fake.emit(event);
    fake.emit(event);

    expect(recordResponse).toHaveBeenCalledTimes(1);
  });

  it('does not record a response for a group outside the allowlist', async () => {
    const guard = new GroupGuard();
    const recordResponse = vi.spyOn(guard, 'recordResponse');
    const { fake } = await activate({ QQ_GROUP_ALLOWLIST: '999' }, new FakeServer(), { guard });

    fake.emit(groupEvent());

    expect(recordResponse).not.toHaveBeenCalled();
  });

  it('keeps only the most recent 500 message ids', async () => {
    const { fake, push } = await activate({ QQ_GROUP_ALLOWLIST: String(GROUP_ID) });

    for (let id = 1; id <= 501; id += 1) {
      fake.emit(groupEvent({ message_id: id }));
    }
    fake.emit(groupEvent({ message_id: 1 }));

    expect(push).toHaveBeenCalledTimes(502);
  });

  it('sends group replies with a reply segment for the last triggering message', async () => {
    const { plugin, fake } = await activate({ QQ_GROUP_ALLOWLIST: String(GROUP_ID) });
    fake.emit(groupEvent({ message_id: 77, raw_message: `[CQ:at,qq=${SELF_ID}] hi` }));

    await plugin.send(`qq:group:${GROUP_ID}`, 'reply text');

    expect(fake.calls).toEqual([
      {
        action: 'send_group_msg',
        params: {
          group_id: GROUP_ID,
          message: [
            { type: 'reply', data: { id: '77' } },
            { type: 'text', data: { text: 'reply text' } },
          ],
        },
      },
    ]);
  });

  it('sends plain group text when no triggering message is known', async () => {
    const { plugin, fake } = await activate({ QQ_GROUP_ALLOWLIST: String(GROUP_ID) });

    await plugin.send(`qq:group:${GROUP_ID}`, 'hello');

    expect(fake.calls).toEqual([
      { action: 'send_group_msg', params: { group_id: GROUP_ID, message: 'hello' } },
    ]);
  });

  it('quotes the latest accepted group message, not a stale wake trigger', async () => {
    const { plugin, fake } = await activate(
      { QQ_GROUP_ALLOWLIST: String(GROUP_ID) },
      new FakeServer(),
      { guard: new GroupGuard({ minGapMs: 0 }) },
    );

    // @ 机器人 → 回复它 → 普通消息 → 回复它：第二条回复必须引用普通消息。
    fake.emit(groupEvent({ message_id: 11, raw_message: `[CQ:at,qq=${SELF_ID}] 在吗` }));
    await plugin.send(`qq:group:${GROUP_ID}`, 'first reply');

    fake.emit(groupEvent({ message_id: 12, raw_message: '[CQ:reply,id=9001] 继续' }));
    await plugin.send(`qq:group:${GROUP_ID}`, 'second reply');

    fake.emit(groupEvent({ message_id: 13, raw_message: '普通发言' }));
    await plugin.send(`qq:group:${GROUP_ID}`, 'third reply');

    const lastCall = fake.calls[fake.calls.length - 1];
    expect(lastCall?.params['message']).toEqual([
      { type: 'reply', data: { id: '13' } },
      { type: 'text', data: { text: 'third reply' } },
    ]);
  });

  it('falls back to plain text once the trigger was answered', async () => {
    const { plugin, fake } = await activate(
      { QQ_GROUP_ALLOWLIST: String(GROUP_ID) },
      new FakeServer(),
      { guard: new GroupGuard({ minGapMs: 0 }) },
    );
    fake.emit(groupEvent({ message_id: 21, raw_message: `[CQ:at,qq=${SELF_ID}] hi` }));

    await plugin.send(`qq:group:${GROUP_ID}`, 'answered');
    await plugin.send(`qq:group:${GROUP_ID}`, 'follow-up');

    expect(fake.calls[1]?.params['message']).toBe('follow-up');
  });

  it('sends private messages as a text segment so CQ codes stay literal', async () => {
    const { plugin, fake } = await activate();

    await plugin.send(`qq:private:${USER_ID}`, 'hello [CQ:face,id=1]');

    expect(fake.calls).toEqual([
      {
        action: 'send_private_msg',
        params: {
          user_id: USER_ID,
          message: [{ type: 'text', data: { text: 'hello [CQ:face,id=1]' } }],
        },
      },
    ]);
  });

  it('remembers message ids returned by send so replies to them wake', async () => {
    const { plugin, fake, push, requestWake } = await activate({
      QQ_GROUP_ALLOWLIST: String(GROUP_ID),
    });
    fake.response = { message_id: 9001 };
    await plugin.send(`qq:group:${GROUP_ID}`, 'hello');

    fake.emit(groupEvent({ raw_message: '[CQ:reply,id=9001] ping' }));

    expect(push).toHaveBeenCalledWith(expect.objectContaining({ importance: 9 }));
    expect(requestWake).toHaveBeenCalledTimes(1);
  });

  it('ignores a non-numeric message id returned by send (event validation is strictly numeric)', async () => {
    const { plugin, fake, push, requestWake } = await activate({
      QQ_GROUP_ALLOWLIST: String(GROUP_ID),
    });
    fake.response = { message_id: '9001' };
    await plugin.send(`qq:group:${GROUP_ID}`, 'hello');

    fake.emit(groupEvent({ raw_message: '[CQ:reply,id=9001] ping' }));

    // 群普通消息（未被识别为回复机器人）→ importance 3、不唤醒。
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ importance: 3 }));
    expect(requestWake).not.toHaveBeenCalled();
  });

  it('drops a group send inside the guard gap and logs why', async () => {
    const { plugin, fake, log } = await activate({
      QQ_GROUP_ALLOWLIST: String(GROUP_ID),
    });

    await plugin.send(`qq:group:${GROUP_ID}`, 'first');
    await plugin.send(`qq:group:${GROUP_ID}`, 'second');

    expect(fake.calls).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(`qq: guard blocked group ${GROUP_ID}: min-gap`);
  });

  it('lets a group send through once another user speaks', async () => {
    const { plugin, fake } = await activate({
      QQ_GROUP_ALLOWLIST: String(GROUP_ID),
    });

    await plugin.send(`qq:group:${GROUP_ID}`, 'first');
    fake.emit(groupEvent({ raw_message: 'someone else talks' }));
    await plugin.send(`qq:group:${GROUP_ID}`, 'second');

    expect(fake.calls).toHaveLength(2);
  });

  it('uses an injected guard, so observation mode blocks sends', async () => {
    const clock = { now: (): number => 1_000_000 };
    const guard = new GroupGuard({ now: clock.now });
    guard.recordWarning(String(GROUP_ID));
    const { plugin, fake, log } = await activate(
      { QQ_GROUP_ALLOWLIST: String(GROUP_ID) },
      new FakeServer(),
      { guard },
    );

    await plugin.send(`qq:group:${GROUP_ID}`, 'hi');

    expect(fake.calls).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('observation'));
  });

  it('keeps the injected guard across deactivate and reactivate', async () => {
    const guard = new GroupGuard({ now: () => 1_000_000 });
    guard.recordWarning(String(GROUP_ID));
    const { plugin, api, fake } = await activate(
      { QQ_GROUP_ALLOWLIST: String(GROUP_ID) },
      new FakeServer(),
      { guard },
    );

    await plugin.send(`qq:group:${GROUP_ID}`, 'first');
    await plugin.deactivate();
    await plugin.activate(api);
    await plugin.send(`qq:group:${GROUP_ID}`, 'second');

    expect(fake.calls).toHaveLength(0);
  });

  it('does not apply the guard to private sends', async () => {
    const { plugin, fake } = await activate({
      QQ_PRIVATE_ALLOWLIST: String(USER_ID),
    });

    await plugin.send(`qq:private:${USER_ID}`, 'one');
    await plugin.send(`qq:private:${USER_ID}`, 'two');

    expect(fake.calls).toHaveLength(2);
  });

  it('honours QQ_MIN_REPLY_GAP_MS in the default guard', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const { plugin, fake } = await activate({
        QQ_GROUP_ALLOWLIST: String(GROUP_ID),
        QQ_MIN_REPLY_GAP_MS: '5000',
      });

      await plugin.send(`qq:group:${GROUP_ID}`, 'first');
      vi.setSystemTime(1_004_999);
      await plugin.send(`qq:group:${GROUP_ID}`, 'second');
      vi.setSystemTime(1_005_000);
      await plugin.send(`qq:group:${GROUP_ID}`, 'third');

      expect(fake.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs a failed group send without throwing and counts it into the guard', async () => {
    const guard = new GroupGuard({ now: () => 1_000_000 });
    const recordSpoken = vi.spyOn(guard, 'recordSpoken');
    const { plugin, fake, log } = await activate(
      { QQ_GROUP_ALLOWLIST: String(GROUP_ID) },
      new FakeServer(),
      { guard },
    );
    fake.rejectWith = new Error('qq action failed: retcode=1404');

    await expect(plugin.send(`qq:group:${GROUP_ID}`, 'hi')).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('qq: send failed'));
    expect(recordSpoken).toHaveBeenCalledWith(String(GROUP_ID));
  });

  it('logs a failed private send without throwing', async () => {
    const { plugin, fake, log } = await activate();
    fake.rejectWith = new Error('qq action failed: retcode=1200');

    await expect(plugin.send(`qq:private:${USER_ID}`, 'hi')).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('qq: send failed'));
  });

  it('pushes connection state as system events without waking', async () => {
    const { fake, push, requestWake } = await activate();

    fake.emitConnection(true);
    fake.emitConnection(false);

    expect(push).toHaveBeenNthCalledWith(1, {
      kind: 'qq_connection',
      channel: 'qq:system',
      actor: 'system',
      content: 'qq 已连接',
      importance: 5,
    });
    expect(push).toHaveBeenNthCalledWith(2, {
      kind: 'qq_connection',
      channel: 'qq:system',
      actor: 'system',
      content: 'qq 已断开',
      importance: 5,
    });
    expect(requestWake).not.toHaveBeenCalled();
  });

  it('publishes a disconnected state on deactivate so the host latch cannot stay true', async () => {
    const { plugin, fake, push } = await activate();
    fake.emitConnection(true);
    push.mockClear();

    await plugin.deactivate();

    // QqServer.stop() 在 close 前把 socket 置空，不会再触发 onConnectionChange(false)；
    // 插件必须在停用路径上补一条，否则重载后装配点一直以为 QQ 在线。
    expect(push).toHaveBeenCalledWith({
      kind: 'qq_connection',
      channel: 'qq:system',
      actor: 'system',
      content: 'qq 已断开',
      importance: 5,
    });
  });

  it('does not throw when sending to the system channel', async () => {
    const { plugin, fake, log } = await activate();

    await expect(plugin.send('qq:system', 'hi')).resolves.toBeUndefined();

    expect(fake.calls).toHaveLength(0);
    expect(log).toHaveBeenCalledWith('qq: system channel is not routable');
  });

  it('drops malformed events with static reasons that never echo raw values', async () => {
    const { fake, push, log } = await activate();

    fake.emit({ post_type: 'message<script>alert(1)</script>' } as unknown as OneBotMessageEvent);
    fake.emit({
      post_type: 'message',
      message_type: 'private<script>',
    } as unknown as OneBotMessageEvent);

    expect(push).not.toHaveBeenCalled();
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toContain('dropped malformed event');
      expect(line).not.toContain('<script>');
      expect(line).not.toContain('alert');
    }
  });

  it('logs accepted inbound events as metadata only', async () => {
    const { fake, log } = await activate({ QQ_GROUP_ALLOWLIST: String(GROUP_ID) });

    fake.emit(groupEvent({ raw_message: '机密内容' }));

    expect(log).toHaveBeenCalledWith(
      `qq: event qq_group_message qq:group:${GROUP_ID} importance=3`,
    );
    expect(log.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain('机密内容');
  });

  it('logs one concise line for a duplicate message id', async () => {
    const { fake, push, log } = await activate({ QQ_GROUP_ALLOWLIST: String(GROUP_ID) });
    const event = groupEvent({ message_id: 321, raw_message: '重复内容' });

    fake.emit(event);
    fake.emit(event);

    expect(push).toHaveBeenCalledTimes(1);
    const duplicateLines = log.mock.calls.filter((call) =>
      String(call[0]).includes('duplicate'),
    );
    expect(duplicateLines).toHaveLength(1);
    expect(String(duplicateLines[0]?.[0])).not.toContain('重复内容');
  });

  it('logs successful sends by conversation key', async () => {
    const { plugin, log } = await activate({ QQ_GROUP_ALLOWLIST: String(GROUP_ID) });

    await plugin.send(`qq:group:${GROUP_ID}`, 'hi');
    await plugin.send(`qq:private:${USER_ID}`, 'hi');

    expect(log).toHaveBeenCalledWith(`qq: sent qq:group:${GROUP_ID}`);
    expect(log).toHaveBeenCalledWith(`qq: sent qq:private:${USER_ID}`);
  });

  it('rejects send before activate', async () => {
    const plugin = createPlugin({ server: new FakeServer() });

    await expect(plugin.send(`qq:group:${GROUP_ID}`, 'hi')).rejects.toThrow(/before activate/);
  });

  it('rejects an unknown conversation key', async () => {
    const { plugin } = await activate();

    await expect(plugin.send('matrix:room:1', 'hi')).rejects.toThrow(/invalid conversation key/);
  });
});

describe('qq structured message segments', () => {
  it('wakes on an at segment even when raw_message has no CQ code', async () => {
    const { fake, push, requestWake } = await activate({
      QQ_GROUP_ALLOWLIST: String(GROUP_ID),
    });

    fake.emit(
      groupEvent({
        raw_message: '在吗',
        message: [
          { type: 'at', data: { qq: String(SELF_ID) } },
          { type: 'text', data: { text: '在吗' } },
        ],
      }),
    );

    expect(push).toHaveBeenCalledWith(expect.objectContaining({ importance: 9 }));
    expect(requestWake).toHaveBeenCalledTimes(1);
  });

  it('ignores an at literal in raw_message when a message array is present', async () => {
    const { fake, push, requestWake } = await activate({
      QQ_GROUP_ALLOWLIST: String(GROUP_ID),
    });

    fake.emit(
      groupEvent({
        raw_message: `[CQ:at,qq=${SELF_ID}] 在吗`,
        message: [{ type: 'text', data: { text: `[CQ:at,qq=${SELF_ID}] 在吗` } }],
      }),
    );

    expect(push).toHaveBeenCalledWith(expect.objectContaining({ importance: 3 }));
    expect(requestWake).not.toHaveBeenCalled();
  });

  it('wakes on a reply segment to a bot message', async () => {
    const { fake, push, requestWake } = await activate({
      QQ_GROUP_ALLOWLIST: String(GROUP_ID),
    });
    fake.emit(
      groupEvent({ sender: { user_id: SELF_ID }, user_id: SELF_ID, message_id: 55 }),
    );

    fake.emit(
      groupEvent({
        raw_message: '继续',
        message: [
          { type: 'reply', data: { id: '55' } },
          { type: 'text', data: { text: '继续' } },
        ],
      }),
    );

    expect(push).toHaveBeenCalledWith(expect.objectContaining({ importance: 9 }));
    expect(requestWake).toHaveBeenCalledTimes(1);
  });

  it('ignores a reply literal in raw_message when a message array is present', async () => {
    const { fake, push, requestWake } = await activate({
      QQ_GROUP_ALLOWLIST: String(GROUP_ID),
    });
    fake.emit(
      groupEvent({ sender: { user_id: SELF_ID }, user_id: SELF_ID, message_id: 55 }),
    );

    fake.emit(
      groupEvent({
        raw_message: '[CQ:reply,id=55] 继续',
        message: [{ type: 'text', data: { text: '[CQ:reply,id=55] 继续' } }],
      }),
    );

    expect(push).toHaveBeenCalledWith(expect.objectContaining({ importance: 3 }));
    expect(requestWake).not.toHaveBeenCalled();
  });

  it('does not treat an at segment for another user as a mention', async () => {
    const { fake, push, requestWake } = await activate({
      QQ_GROUP_ALLOWLIST: String(GROUP_ID),
    });

    fake.emit(
      groupEvent({
        message: [{ type: 'at', data: { qq: String(SELF_ID + 1) } }],
      }),
    );

    expect(push).toHaveBeenCalledWith(expect.objectContaining({ importance: 3 }));
    expect(requestWake).not.toHaveBeenCalled();
  });

  it('requires data.qq to be the exact string form of the pinned self id', async () => {
    const { fake, requestWake } = await activate({
      QQ_GROUP_ALLOWLIST: String(GROUP_ID),
    });

    fake.emit(groupEvent({ message: [{ type: 'at', data: { qq: SELF_ID } }] }));

    expect(requestWake).not.toHaveBeenCalled();
  });

  it('tolerates malformed segment entries', async () => {
    const { fake, push, requestWake } = await activate({
      QQ_GROUP_ALLOWLIST: String(GROUP_ID),
    });
    const malformed = [
      null,
      42,
      'x',
      { type: 'at' },
      { type: 'at', data: { qq: {} } },
    ] as unknown as OneBotMessageEvent['message'];

    expect(() => fake.emit(groupEvent({ message: malformed }))).not.toThrow();

    expect(push).toHaveBeenCalledWith(expect.objectContaining({ importance: 3 }));
    expect(requestWake).not.toHaveBeenCalled();
  });

  it('logs the raw_message fallback exactly once', async () => {
    const { fake, log } = await activate({ QQ_GROUP_ALLOWLIST: String(GROUP_ID) });

    fake.emit(groupEvent({ raw_message: 'one' }));
    fake.emit(groupEvent({ raw_message: 'two' }));

    const fallbackLines = log.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line === 'qq: message segments missing, falling back to raw_message');
    expect(fallbackLines).toHaveLength(1);
  });
});

describe('qq self identity pinning', () => {
  it('drops an event whose self_id differs from QQ_SELF_ID', async () => {
    const { fake, push, log } = await activate({
      QQ_SELF_ID: String(SELF_ID),
      QQ_GROUP_ALLOWLIST: String(GROUP_ID),
    });

    fake.emit(groupEvent({ self_id: SELF_ID + 1 }));

    expect(push).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('qq: dropped event with unexpected self_id');
  });

  it('does not consume a dedupe slot for a dropped self_id mismatch', async () => {
    const { fake, push } = await activate({
      QQ_SELF_ID: String(SELF_ID),
      QQ_GROUP_ALLOWLIST: String(GROUP_ID),
    });

    fake.emit(groupEvent({ self_id: SELF_ID + 1, message_id: 5 }));
    fake.emit(groupEvent({ message_id: 5 }));

    expect(push).toHaveBeenCalledTimes(1);
  });

  it('pins self_id from the first valid event when QQ_SELF_ID is unset', async () => {
    const { fake, push, log } = await activate({
      QQ_GROUP_ALLOWLIST: String(GROUP_ID),
    });

    fake.emit(groupEvent({ self_id: SELF_ID }));
    fake.emit(groupEvent({ self_id: SELF_ID + 1 }));

    expect(push).toHaveBeenCalledTimes(1);
    const warnings = log.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line === 'qq: qq.selfId is not set; pinned self_id from the first event');
    expect(warnings).toHaveLength(1);
  });

  it('normalises and validates qq.selfId in the harness config', () => {
    const base = importFromEnv({ QQ_WS_TOKEN: 'x' }).qq;
    expect(readConfig({ ...base, selfId: '100' }).selfId).toBe(100);
    expect(readConfig({ ...base, selfId: '' }).selfId).toBeUndefined();
    // 导入时归一化；非法值回退为空串，绝不进入运行期。
    expect(importFromEnv({ QQ_SELF_ID: '0100' }).qq.selfId).toBe('100');
    expect(importFromEnv({ QQ_SELF_ID: 'abc' }).qq.selfId).toBe('');
    expect(importFromEnv({ QQ_SELF_ID: '0' }).qq.selfId).toBe('');
  });
});

describe('qq denylist normalisation', () => {
  it('applies the same normalised QQ_PRIVATE_DENYLIST to ordinary inbound messages', async () => {
    const { fake, push } = await activate({
      QQ_PRIVATE_OPEN: '1',
      QQ_PRIVATE_DENYLIST: '0200',
    });

    fake.emit(privateEvent({ sender: { user_id: USER_ID }, user_id: USER_ID }));

    expect(push).not.toHaveBeenCalled();
  });
});

describe('qq dedupe windows', () => {
  it('keeps owner control message ids out of the general dedupe window', async () => {
    const handle = vi.fn(async () => ({ action: 'handled' as const }));
    const { fake } = await activate(
      {
        QQ_OWNER_ID: String(OWNER_ID),
        QQ_CONTROL_ENABLED: '1',
        QQ_GROUP_ALLOWLIST: String(GROUP_ID),
      },
      new FakeServer(),
      {},
      { handle },
    );
    const ownerMessage = privateEvent({
      message_id: 1,
      user_id: OWNER_ID,
      sender: { user_id: OWNER_ID },
      raw_message: '#状态',
    });

    await fake.emitAsync(ownerMessage);
    // 群聊洪泛耗尽普通去重窗口，不得把 owner 的 message_id 挤出去。
    for (let id = 1_000; id <= 1_500; id += 1) {
      fake.emit(groupEvent({ message_id: id }));
    }
    await fake.emitAsync(ownerMessage);

    expect(handle).toHaveBeenCalledTimes(1);
  });
});

describe('qq notice handling', () => {
  function noticeEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      post_type: 'notice',
      notice_type: 'group_ban',
      sub_type: 'ban',
      self_id: SELF_ID,
      group_id: GROUP_ID,
      user_id: SELF_ID,
      operator_id: 999,
      ...overrides,
    };
  }

  /**
   * notice 自身不再钉死身份（M-3），所以 notice 测试必须显式配置
   * `QQ_SELF_ID`，否则事件会被当作「身份未知」忽略。
   */
  function noticeEnv(extra: Record<string, string> = {}): Record<string, string> {
    return { QQ_OWNER_ID: String(OWNER_ID), QQ_SELF_ID: String(SELF_ID), ...extra };
  }

  it('pushes a mute notice to the owner private channel and warns the guard', async () => {
    const guard = new GroupGuard();
    const recordWarning = vi.spyOn(guard, 'recordWarning');
    const { fake, push, requestWake } = await activate(
      noticeEnv(),
      new FakeServer(),
      { guard },
    );

    fake.emitNotice(noticeEvent());

    expect(push).toHaveBeenCalledWith({
      kind: 'qq_notice',
      channel: `qq:private:${OWNER_ID}`,
      actor: 'system',
      content: `QQ 在群 ${GROUP_ID} 被禁言`,
      importance: 9,
    });
    expect(requestWake).toHaveBeenCalledTimes(1);
    expect(recordWarning).toHaveBeenCalledWith(String(GROUP_ID));
  });

  it('pushes an unmute notice quietly and resumes the platform gate', async () => {
    const guard = new GroupGuard();
    const resumePlatform = vi.spyOn(guard, 'resumePlatform');
    const { fake, push, requestWake } = await activate(
      noticeEnv(),
      new FakeServer(),
      { guard },
    );

    fake.emitNotice(noticeEvent({ sub_type: 'lift_ban' }));

    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'qq_notice', importance: 5 }),
    );
    expect(requestWake).not.toHaveBeenCalled();
    expect(resumePlatform).toHaveBeenCalledWith(String(GROUP_ID));
  });

  it('does not clear an operator silence on a platform unmute', async () => {
    const guard = new GroupGuard();
    guard.silence(String(GROUP_ID), Date.now() + 60_000);
    const { fake, push } = await activate(
      noticeEnv(),
      new FakeServer(),
      { guard },
    );

    fake.emitNotice(noticeEvent({ sub_type: 'lift_ban' }));

    expect(push).toHaveBeenCalled();
    expect(guard.isSilenced(String(GROUP_ID))).toBe(true);
    expect(guard.exportOperatorState()).toEqual([
      expect.objectContaining({ groupId: String(GROUP_ID) }),
    ]);
  });

  it('does not DM the owner when the control plane is explicitly off', async () => {
    const { fake, push, requestWake, log } = await activate(
      noticeEnv({ QQ_CONTROL_ENABLED: '0' }),
    );

    fake.emitNotice(noticeEvent());

    // 控制面显式关闭：notice 只进日志，不入队（qq:system 也会烧一次 brain）。
    expect(push).not.toHaveBeenCalled();
    expect(requestWake).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(`qq: notice muted ${GROUP_ID}`);
  });

  it('dedupes notices by type, sub_type, group and user within a time bucket', async () => {
    const { fake, push, log } = await activate(noticeEnv());
    // 标准 notice 不带 message_id：去重键来自真实字段 + 粗时间桶。
    const notice = noticeEvent();

    fake.emitNotice(notice);
    fake.emitNotice(notice);

    expect(push).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('qq: duplicate notice ignored');
  });

  it('rate-limits notice wakes to one per group per minute', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const { fake, requestWake } = await activate(noticeEnv());

      fake.emitNotice(noticeEvent());
      fake.emitNotice(noticeEvent({ notice_type: 'group_decrease', sub_type: 'kick_me' }));
      expect(requestWake).toHaveBeenCalledTimes(1);

      vi.setSystemTime(1_060_000);
      fake.emitNotice(noticeEvent({ notice_type: 'group_decrease', sub_type: 'kick_me' }));
      expect(requestWake).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps notice wakes globally even when group ids rotate', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const { fake, requestWake } = await activate(noticeEnv());

      // 轮换群号不能绕过全局预算（10 次/分钟），也不能让状态表无限增长。
      for (let index = 0; index < 11; index += 1) {
        fake.emitNotice(noticeEvent({ group_id: GROUP_ID + index }));
      }

      expect(requestWake).toHaveBeenCalledTimes(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never pins the self identity from a notice and logs the drop once', async () => {
    const { fake, push, log } = await activate({ QQ_GROUP_ALLOWLIST: String(GROUP_ID) });

    fake.emitNotice(noticeEvent());
    fake.emitNotice(noticeEvent({ group_id: GROUP_ID + 1 }));
    fake.emitNotice(noticeEvent({ group_id: GROUP_ID + 2 }));

    expect(push).not.toHaveBeenCalled();
    const lines = log.mock.calls.map((call) => String(call[0]));
    // 未钉死窗口里的每条 notice 不各记一行：只记一次，避免日志洪泛。
    expect(
      lines.filter((line) => line === 'qq: ignored notice event: self id is not pinned'),
    ).toHaveLength(1);
    expect(lines.filter((line) => line === 'qq: ignored notice event')).toHaveLength(0);
    expect(
      lines.filter(
        (line) => line === 'qq: qq.selfId is not set; pinned self_id from the first event',
      ),
    ).toHaveLength(0);

    // 只有通过形状校验的 message 事件可以钉死身份；钉死时汇总丢弃数。
    fake.emit(groupEvent());
    expect(log).toHaveBeenCalledWith(
      'qq: dropped 3 notice event(s) before self id was pinned',
    );
    fake.emitNotice(noticeEvent());

    expect(push).toHaveBeenCalledTimes(2);
  });

  it('pushes a kick notice at importance 9 and warns the guard', async () => {
    const guard = new GroupGuard();
    const recordWarning = vi.spyOn(guard, 'recordWarning');
    const { fake, push, requestWake } = await activate(
      noticeEnv(),
      new FakeServer(),
      { guard },
    );

    fake.emitNotice(
      noticeEvent({ notice_type: 'group_decrease', sub_type: 'kick_me' }),
    );

    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'qq_notice', importance: 9 }),
    );
    expect(requestWake).toHaveBeenCalledTimes(1);
    expect(recordWarning).toHaveBeenCalledWith(String(GROUP_ID));
  });

  it('pushes losing admin quietly and warns the guard', async () => {
    const guard = new GroupGuard();
    const recordWarning = vi.spyOn(guard, 'recordWarning');
    const { fake, push, requestWake } = await activate(
      noticeEnv(),
      new FakeServer(),
      { guard },
    );

    fake.emitNotice(
      noticeEvent({ notice_type: 'group_admin', sub_type: 'unset', user_id: SELF_ID }),
    );

    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'qq_notice', importance: 5 }),
    );
    expect(requestWake).not.toHaveBeenCalled();
    expect(recordWarning).toHaveBeenCalledWith(String(GROUP_ID));
  });

  it('falls back to the unroutable system channel without an owner', async () => {
    const { fake, push, requestWake } = await activate({ QQ_SELF_ID: String(SELF_ID) });

    fake.emitNotice(noticeEvent());

    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'qq_notice', channel: 'qq:system', importance: 9 }),
    );
    expect(requestWake).not.toHaveBeenCalled();
  });

  it('ignores unmapped notices with a static log', async () => {
    const { fake, push, log } = await activate(noticeEnv());

    fake.emitNotice(noticeEvent({ notice_type: 'group_increase', sub_type: 'approve' }));

    expect(push).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('qq: ignored notice event');
  });

  it('never interpolates peer-provided strings into notice content', async () => {
    const { fake, push } = await activate(noticeEnv());

    fake.emitNotice(
      noticeEvent({ nickname: 'evil\n\u001b[31m', comment: '<script>alert(1)</script>' }),
    );

    const content = String(push.mock.calls[0]?.[0]?.content ?? '');
    expect(content).toBe(`QQ 在群 ${GROUP_ID} 被禁言`);
    expect(content).not.toContain('evil');
    expect(content).not.toContain('script');
  });

  it('drops a notice whose self_id mismatches the pinned identity', async () => {
    const { fake, push, log } = await activate({
      QQ_OWNER_ID: String(OWNER_ID),
      QQ_SELF_ID: String(SELF_ID),
    });

    fake.emitNotice(noticeEvent({ self_id: SELF_ID + 1 }));

    expect(push).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('qq: ignored notice event');
  });
});

describe('qq channel manifest', () => {
  it('is valid and declares the qq channel contract', async () => {
    const manifest = await readManifest('plugins/channels/qq');

    expect(manifest.name).toBe('qq');
    expect(manifest.kind).toBe('channel');
    expect(manifest.channelPrefix).toBe('qq');
    expect(manifest.apiVersion).toBe(1);
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.entry).toBe('index.ts');
  });
});
