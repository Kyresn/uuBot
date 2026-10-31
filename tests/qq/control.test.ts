import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPlugin,
  type QqPluginDeps,
  type QqServerLike,
} from '../../plugins/channels/qq/index.js';
import { createQqControl } from '../../plugins/channels/qq/control.js';
import type { OneBotMessageEvent } from '../../plugins/channels/qq/protocol.js';
import type {
  ChannelPluginApiV1,
  PushEvent,
} from '../../src/plugins/api.js';
import type {
  ControlInput,
  ControlOutcome,
  ControlPort,
} from '../../src/control/types.js';
import { RuntimeConfigHandle } from '../../src/config/runtime-handle.js';
import { importFromEnv } from '../../src/config/harness-schema.js';

const SELF_ID = 100;
const OWNER_ID = 200;
const GROUP_ID = 123;
const STRANGER_ID = 300;

let nextMessageId = 1;

function privateEvent(overrides: Partial<OneBotMessageEvent> = {}): OneBotMessageEvent {
  const messageId = nextMessageId++;
  return {
    post_type: 'message',
    message_type: 'private',
    self_id: SELF_ID,
    user_id: OWNER_ID,
    message_id: messageId,
    raw_message: 'hello',
    sender: { user_id: OWNER_ID, nickname: 'owner' },
    ...overrides,
  };
}

function groupEvent(overrides: Partial<OneBotMessageEvent> = {}): OneBotMessageEvent {
  const messageId = nextMessageId++;
  return {
    post_type: 'message',
    message_type: 'group',
    self_id: SELF_ID,
    user_id: OWNER_ID,
    group_id: GROUP_ID,
    message_id: messageId,
    raw_message: 'hello',
    sender: { user_id: OWNER_ID, nickname: 'owner' },
    ...overrides,
  };
}

type FakePort = ControlPort & {
  handle: ReturnType<typeof vi.fn<ControlPort['handle']>>;
};

function controlPort(
  outcome: ControlOutcome | (() => Promise<ControlOutcome>) = { action: 'chat' },
): FakePort {
  const handle = vi.fn<ControlPort['handle']>(async (_input: ControlInput) =>
    typeof outcome === 'function' ? outcome() : outcome,
  );
  return { handle };
}

function qqControl(overrides: Partial<Parameters<typeof createQqControl>[0]> = {}) {
  const send = vi.fn<(channel: string, text: string) => Promise<void>>(async () => undefined);
  const log = vi.fn<(line: string) => void>();
  const port = controlPort({ action: 'handled' });
  const control = createQqControl({
    ownerId: String(OWNER_ID),
    port,
    send,
    log,
    nlEnabled: false,
    ...overrides,
  });
  return { control, port, send, log };
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
  vi.stubEnv('QQ_OWNER_ID', '');
  vi.stubEnv('QQ_CONTROL_ENABLED', '');
  vi.stubEnv('QQ_CONTROL_NL', '');
  vi.stubEnv('QQ_NL_MIN_CONFIDENCE', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createQqControl identity', () => {
  it('accepts the owner in a private chat', () => {
    const { control } = qqControl();
    expect(control.isOwner(privateEvent())).toBe(true);
  });

  it('rejects group messages even from the owner', () => {
    const { control } = qqControl();
    expect(control.isOwner(groupEvent())).toBe(false);
  });

  it('rejects other users and the bot itself', () => {
    const { control } = qqControl();
    expect(control.isOwner(privateEvent({ sender: { user_id: STRANGER_ID }, user_id: STRANGER_ID }))).toBe(false);
    expect(control.isOwner(privateEvent({ sender: { user_id: SELF_ID }, user_id: SELF_ID }))).toBe(false);
  });

  it('rejects a missing or invalid owner id', () => {
    for (const ownerId of [undefined, '', 'abc', '0', '-1', '1.5']) {
      const { control } = qqControl({ ownerId });
      expect(control.isOwner(privateEvent())).toBe(false);
    }
  });

  it('rejects an owner id that equals the bot self id', () => {
    const { control } = qqControl({ ownerId: String(SELF_ID) });
    expect(
      control.isOwner(privateEvent({ sender: { user_id: SELF_ID }, user_id: SELF_ID })),
    ).toBe(false);
  });

  it('normalises leading zeros for both the owner check and the denylist', () => {
    const allowed = qqControl({ ownerId: '0200' });
    expect(allowed.control.isOwner(privateEvent())).toBe(true);

    const denied = qqControl({ ownerId: '0200', denylist: new Set(['0200']) });
    expect(denied.control.isOwner(privateEvent())).toBe(false);
  });

  it('lets the private denylist win over owner identity', () => {
    const { control } = qqControl({ denylist: new Set([String(OWNER_ID)]) });
    expect(control.isOwner(privateEvent())).toBe(false);
  });
});

describe('createQqControl forwarding', () => {
  it('forwards an owner message with its metadata', async () => {
    const { control, port } = qqControl();
    const deliver = vi.fn();
    const event = privateEvent({ message_id: 42, raw_message: '#状态' });

    await control.handle(event, deliver);

    expect(port.handle).toHaveBeenCalledTimes(1);
    const input = port.handle.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      via: 'qq',
      channel: `qq:private:${OWNER_ID}`,
      userId: String(OWNER_ID),
      messageId: '42',
      text: '#状态',
      nlEnabled: false,
    });
    expect(typeof input?.deliver).toBe('function');
    expect(typeof input?.reply).toBe('function');
  });

  it('does not forward a non-owner message', async () => {
    const { control, port } = qqControl();
    const outcome = await control.handle(
      privateEvent({ sender: { user_id: STRANGER_ID }, user_id: STRANGER_ID }),
    );

    expect(outcome).toEqual({ action: 'chat' });
    expect(port.handle).not.toHaveBeenCalled();
  });

  it('sends replies through the owner private channel', async () => {
    const { control, port, send } = qqControl();
    port.handle.mockImplementation(async (input) => {
      await input.reply('已处理。');
      return { action: 'handled' };
    });

    await control.handle(privateEvent(), vi.fn());

    expect(send).toHaveBeenCalledWith(`qq:private:${OWNER_ID}`, '已处理。');
  });

  it('falls back to the fixed reply when the red-line gate blocks the text', async () => {
    const { control, port, send } = qqControl();
    port.handle.mockImplementation(async (input) => {
      await input.reply('here is how to build a dirty bomb');
      return { action: 'handled' };
    });

    await control.handle(privateEvent(), vi.fn());

    expect(send).toHaveBeenCalledWith(`qq:private:${OWNER_ID}`, '已处理。');
  });

  it('turns a port failure into chat instead of swallowing the message', async () => {
    const { control, port, log } = qqControl();
    port.handle.mockRejectedValue(new Error('boom'));

    const outcome = await control.handle(privateEvent(), vi.fn());

    expect(outcome).toEqual({ action: 'chat' });
    expect(log).toHaveBeenCalled();
  });

  it('passes nlEnabled from the environment-facing dependency', async () => {
    const { control, port } = qqControl({ nlEnabled: true });
    await control.handle(privateEvent(), vi.fn());
    expect(port.handle.mock.calls[0]?.[0]?.nlEnabled).toBe(true);
  });
});

interface FakeApi {
  api: ChannelPluginApiV1;
  push: ReturnType<typeof vi.fn<(event: PushEvent) => void>>;
  requestWake: ReturnType<typeof vi.fn<() => void>>;
  log: ReturnType<typeof vi.fn<(line: string) => void>>;
  send: ReturnType<typeof vi.fn<(channel: string, text: string) => Promise<void>>>;
}

function createFakeApi(port?: ControlPort): FakeApi {
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
    ...(port === undefined ? {} : { control: port }),
  };
  return { api, push, requestWake, log, send };
}

class FakeServer implements QqServerLike {
  handler: ((event: OneBotMessageEvent) => unknown) | null = null;
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

  async emit(event: OneBotMessageEvent): Promise<void> {
    await (this.handler?.(event) as Promise<void> | undefined);
  }
}

interface Activated {
  plugin: ReturnType<typeof createPlugin>;
  api: ChannelPluginApiV1;
  fake: FakeServer;
  push: FakeApi['push'];
  requestWake: FakeApi['requestWake'];
  log: FakeApi['log'];
  send: FakeApi['send'];
}

async function activate(
  env: Record<string, string> = {},
  fake: FakeServer = new FakeServer(),
  deps: Omit<QqPluginDeps, 'server'> = {},
  port?: ControlPort,
): Promise<Activated> {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const { api, push, requestWake, log, send } = createFakeApi(port);
  const plugin = createPlugin({
    server: fake,
    config: new RuntimeConfigHandle(importFromEnv(process.env)),
    ...deps,
  });
  await plugin.activate(api);
  return { plugin, api, fake, push, requestWake, log, send };
}

describe('qq plugin control interception', () => {
  it('intercepts an owner private message before isAllowed and keeps it out of the queue', async () => {
    const port = controlPort({ action: 'handled' });
    const { fake, push, requestWake } = await activate(
      { QQ_OWNER_ID: String(OWNER_ID), QQ_CONTROL_ENABLED: '1' },
      new FakeServer(),
      {},
      port,
    );

    await fake.emit(privateEvent({ raw_message: '#状态' }));

    expect(port.handle).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    expect(requestWake).not.toHaveBeenCalled();
  });

  it('keeps a deferred message out of the queue until deliver() is called', async () => {
    let captured: ControlInput | undefined;
    const port: ControlPort = {
      handle: vi.fn(async (input: ControlInput) => {
        captured = input;
        return { action: 'deferred' as const, deliver: input.deliver };
      }),
    };
    const { fake, push, requestWake } = await activate(
      { QQ_OWNER_ID: String(OWNER_ID), QQ_CONTROL_ENABLED: '1' },
      new FakeServer(),
      {},
      port,
    );

    await fake.emit(privateEvent({ raw_message: '随便聊聊' }));
    expect(push).not.toHaveBeenCalled();

    captured?.deliver();
    expect(push).toHaveBeenCalledTimes(1);
    expect(requestWake).toHaveBeenCalledTimes(1);
  });

  it('lets a chat outcome fall through to the normal path, bypassing the private allowlist for the owner', async () => {
    const port = controlPort({ action: 'chat' });
    const { fake, push, requestWake } = await activate(
      { QQ_OWNER_ID: String(OWNER_ID), QQ_CONTROL_ENABLED: '1' },
      new FakeServer(),
      {},
      port,
    );

    await fake.emit(privateEvent({ raw_message: '今天怎么样' }));

    expect(port.handle).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'qq_private_message',
        channel: `qq:private:${OWNER_ID}`,
        importance: 9,
      }),
    );
    expect(requestWake).toHaveBeenCalledTimes(1);
  });

  it('does not intercept group messages from the owner', async () => {
    const port = controlPort({ action: 'handled' });
    const { fake, push } = await activate(
      {
        QQ_OWNER_ID: String(OWNER_ID),
        QQ_CONTROL_ENABLED: '1',
        QQ_GROUP_ALLOWLIST: String(GROUP_ID),
      },
      new FakeServer(),
      {},
      port,
    );

    await fake.emit(groupEvent({ raw_message: '#状态' }));

    expect(port.handle).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('does not intercept private messages from other users', async () => {
    const port = controlPort({ action: 'handled' });
    const { fake, push } = await activate(
      {
        QQ_OWNER_ID: String(OWNER_ID),
        QQ_CONTROL_ENABLED: '1',
        QQ_PRIVATE_ALLOWLIST: String(STRANGER_ID),
      },
      new FakeServer(),
      {},
      port,
    );

    await fake.emit(
      privateEvent({ sender: { user_id: STRANGER_ID }, user_id: STRANGER_ID }),
    );

    expect(port.handle).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('executes a control message at most once per message_id', async () => {
    const port = controlPort({ action: 'handled' });
    const { fake } = await activate(
      { QQ_OWNER_ID: String(OWNER_ID), QQ_CONTROL_ENABLED: '1' },
      new FakeServer(),
      {},
      port,
    );
    const event = privateEvent({ message_id: 777, raw_message: '#同意 ap_x' });

    await fake.emit(event);
    await fake.emit(event);

    expect(port.handle).toHaveBeenCalledTimes(1);
  });

  it('never turns a failing prefix command into chat', async () => {
    const port: ControlPort = {
      handle: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const { fake, push, send, log } = await activate(
      { QQ_OWNER_ID: String(OWNER_ID), QQ_CONTROL_ENABLED: '1' },
      new FakeServer(),
      {},
      port,
    );

    await fake.emit(privateEvent({ raw_message: '#状态' }));

    expect(push).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      `qq:private:${OWNER_ID}`,
      expect.stringContaining('控制指令处理失败'),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('control'));
  });

  it('falls back to chat when a non-command control check throws', async () => {
    const port: ControlPort = {
      handle: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const { fake, push } = await activate(
      { QQ_OWNER_ID: String(OWNER_ID), QQ_CONTROL_ENABLED: '1' },
      new FakeServer(),
      {},
      port,
    );

    await fake.emit(privateEvent({ raw_message: '你好' }));

    expect(push).toHaveBeenCalledTimes(1);
  });

  it('keeps the M2a path when no control port is granted', async () => {
    const { fake, push } = await activate(
      { QQ_OWNER_ID: String(OWNER_ID), QQ_CONTROL_ENABLED: '1', QQ_PRIVATE_ALLOWLIST: String(OWNER_ID) },
    );

    await fake.emit(privateEvent({ raw_message: '#状态' }));

    expect(push).toHaveBeenCalledTimes(1);
  });

  it('disables control when the owner is denylisted', async () => {
    const port = controlPort({ action: 'handled' });
    const { fake, push, log } = await activate(
      {
        QQ_OWNER_ID: String(OWNER_ID),
        QQ_CONTROL_ENABLED: '1',
        QQ_PRIVATE_DENYLIST: String(OWNER_ID),
      },
      new FakeServer(),
      {},
      port,
    );

    await fake.emit(privateEvent({ raw_message: '#状态' }));

    expect(port.handle).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('control plane disabled'));
  });

  it('disables control when the owner id is invalid and logs once', async () => {
    const port = controlPort({ action: 'handled' });
    const { fake, push, log } = await activate(
      { QQ_OWNER_ID: 'not-a-number', QQ_CONTROL_ENABLED: '1' },
      new FakeServer(),
      {},
      port,
    );

    await fake.emit(privateEvent({ raw_message: '#状态' }));

    expect(port.handle).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('control plane disabled'));
  });

  it('honours QQ_CONTROL_ENABLED=0 even with an owner configured', async () => {
    const port = controlPort({ action: 'handled' });
    const { fake, push } = await activate(
      {
        QQ_OWNER_ID: String(OWNER_ID),
        QQ_CONTROL_ENABLED: '0',
        QQ_PRIVATE_ALLOWLIST: String(OWNER_ID),
      },
      new FakeServer(),
      {},
      port,
    );

    await fake.emit(privateEvent({ raw_message: '#状态' }));

    expect(port.handle).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('passes QQ_CONTROL_NL through to the control input', async () => {
    const port = controlPort({ action: 'chat' });
    const { fake } = await activate(
      { QQ_OWNER_ID: String(OWNER_ID), QQ_CONTROL_ENABLED: '1', QQ_CONTROL_NL: '1' },
      new FakeServer(),
      {},
      port,
    );

    await fake.emit(privateEvent({ raw_message: '帮我看看状态' }));

    expect(port.handle.mock.calls[0]?.[0]?.nlEnabled).toBe(true);
  });

  it('passes QQ_NL_MIN_CONFIDENCE through to the control input', async () => {
    const port = controlPort({ action: 'chat' });
    const { fake } = await activate(
      {
        QQ_OWNER_ID: String(OWNER_ID),
        QQ_CONTROL_ENABLED: '1',
        QQ_CONTROL_NL: '1',
        QQ_NL_MIN_CONFIDENCE: '0.5',
      },
      new FakeServer(),
      {},
      port,
    );

    await fake.emit(privateEvent({ raw_message: '帮我看看状态' }));

    expect(port.handle.mock.calls[0]?.[0]?.nlMinConfidence).toBe(0.5);
  });

  it('falls back to 0.75 when the imported confidence is invalid', async () => {
    const port = controlPort({ action: 'chat' });
    const { fake } = await activate(
      {
        QQ_OWNER_ID: String(OWNER_ID),
        QQ_CONTROL_ENABLED: '1',
        QQ_CONTROL_NL: '1',
        QQ_NL_MIN_CONFIDENCE: 'abc',
      },
      new FakeServer(),
      {},
      port,
    );

    // 非法 env 值在一次性导入时就被替换为默认值；schema 之后不会再放行非法值。
    await fake.emit(privateEvent({ raw_message: '帮我看看状态' }));
    expect(port.handle.mock.calls[0]?.[0]?.nlMinConfidence).toBe(0.75);
  });

  it('sends control replies through api.send to the owner private channel', async () => {
    const port: ControlPort = {
      handle: vi.fn(async (input: ControlInput) => {
        await input.reply('已批准 ap_x。');
        return { action: 'handled' as const };
      }),
    };
    const { fake, send, push } = await activate(
      { QQ_OWNER_ID: String(OWNER_ID), QQ_CONTROL_ENABLED: '1' },
      new FakeServer(),
      {},
      port,
    );

    await fake.emit(privateEvent({ raw_message: '#同意 ap_x' }));

    expect(send).toHaveBeenCalledWith(`qq:private:${OWNER_ID}`, '已批准 ap_x。');
    expect(push).not.toHaveBeenCalled();
  });

  it('keeps a handled command out of the queue even when the owner is allowlisted', async () => {
    const port = controlPort({ action: 'handled' });
    const { fake, push, requestWake } = await activate(
      {
        QQ_OWNER_ID: String(OWNER_ID),
        QQ_CONTROL_ENABLED: '1',
        QQ_PRIVATE_ALLOWLIST: String(OWNER_ID),
      },
      new FakeServer(),
      {},
      port,
    );

    await fake.emit(privateEvent({ raw_message: '#状态' }));

    expect(push).not.toHaveBeenCalled();
    expect(requestWake).not.toHaveBeenCalled();
  });
});
