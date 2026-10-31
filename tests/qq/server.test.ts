import { connect as netConnect, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { type ClientOptions } from 'ws';
import {
  toPlainText,
  type OneBotMessageEvent,
} from '../../plugins/channels/qq/protocol.js';
import { QqServer, type QqServerOptions } from '../../plugins/channels/qq/server.js';

interface Harness {
  server: QqServer;
  port: number;
  events: OneBotMessageEvent[];
  logs: string[];
  url: string;
}

const servers: QqServer[] = [];
const clients: WebSocket[] = [];
const rawSockets: Socket[] = [];

async function startServer(
  overrides: Partial<
    Pick<
      QqServerOptions,
      'token' | 'heartbeatMs' | 'pongTimeoutMs' | 'onConnectionChange' | 'onEvent' | 'onNotice'
    >
  > = {},
): Promise<Harness> {
  const events: OneBotMessageEvent[] = [];
  const logs: string[] = [];
  const server = new QqServer({
    port: 0,
    token: 'secret',
    onEvent: (event) => events.push(event),
    log: (line) => logs.push(line),
    ...overrides,
  });
  servers.push(server);
  await server.start();
  return {
    server,
    port: server.port,
    events,
    logs,
    url: `ws://127.0.0.1:${server.port}/onebot/v11/ws`,
  };
}

function connect(url: string, options?: ClientOptions): WebSocket {
  const ws = new WebSocket(url, options);
  clients.push(ws);
  return ws;
}

function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

function waitForClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.once('close', (code) => resolve(code));
  });
}

function nextJson(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => {
      try {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met within timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function openRawSocket(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: '127.0.0.1', port }, () => resolve(socket));
    rawSockets.push(socket);
    socket.once('error', reject);
  });
}

/** 手工完成 WebSocket 握手，返回可直接写原始字节的 TCP socket。 */
async function rawWebSocketHandshake(port: number, token: string): Promise<Socket> {
  const socket = await openRawSocket(port);
  const key = Buffer.from('0123456789abcdef').toString('base64');
  socket.write(
    `GET /onebot/v11/ws?access_token=${encodeURIComponent(token)} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${key}\r\n` +
      'Sec-WebSocket-Version: 13\r\n\r\n',
  );

  await new Promise<void>((resolve, reject) => {
    let received = '';
    const onData = (chunk: Buffer): void => {
      received += chunk.toString('latin1');
      if (!received.includes('\r\n\r\n')) return;
      socket.off('data', onData);
      resolve();
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });

  return socket;
}

function waitForSocketClose(socket: Socket): Promise<void> {
  // 无 data 监听时 socket 处于 paused 模式，缓冲未读数据会推迟 'close'；
  // 主动 resume 让服务端的 400 响应被读掉。
  socket.resume();
  return new Promise((resolve) => socket.once('close', () => resolve()));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs = 2000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error('timed out waiting for socket close')), timeoutMs).unref();
    }),
  ]);
}

afterEach(async () => {
  for (const socket of rawSockets.splice(0)) {
    socket.destroy();
  }
  for (const ws of clients.splice(0)) {
    ws.terminate();
  }
  for (const server of servers.splice(0)) {
    await server.stop();
  }
});

describe('toPlainText', () => {
  it('replaces image CQ codes with [图片]', () => {
    expect(toPlainText('看这个[CQ:image,file=a.jpg,url=https://example.com/a.jpg]')).toBe(
      '看这个[图片]',
    );
    expect(toPlainText('[CQ:image]')).toBe('[图片]');
  });

  it('replaces at CQ codes with [@qq]', () => {
    expect(toPlainText('[CQ:at,qq=12345] 你好')).toBe('[@12345] 你好');
    expect(toPlainText('[CQ:at,qq=all]')).toBe('[@all]');
  });

  it('replaces face CQ codes with [表情]', () => {
    expect(toPlainText('hi[CQ:face,id=14]')).toBe('hi[表情]');
  });

  it('replaces any other CQ code with [type]', () => {
    expect(toPlainText('[CQ:record,file=a.amr]')).toBe('[record]');
    expect(toPlainText('[CQ:share,url=https://example.com]')).toBe('[share]');
  });

  it('leaves plain text untouched', () => {
    expect(toPlainText('纯文本，无 CQ 码')).toBe('纯文本，无 CQ 码');
    expect(toPlainText('')).toBe('');
  });

  it('handles several CQ codes in one message', () => {
    expect(toPlainText('[CQ:image,file=a][CQ:at,qq=1]x[CQ:face,id=2]')).toBe(
      '[图片][@1]x[表情]',
    );
  });

  it('leaves escaped CQ entities as-is for now', () => {
    expect(toPlainText('&#91;CQ:image&#93;')).toBe('&#91;CQ:image&#93;');
    expect(toPlainText('a&#44;b')).toBe('a&#44;b');
  });
});

describe('QqServer', () => {
  it('accepts a connection with the access_token query parameter', async () => {
    const { server, url } = await startServer();
    const ws = connect(`${url}?access_token=secret`);
    await waitForOpen(ws);

    expect(server.connected).toBe(true);
  });

  it('logs "qq: connected" after an authenticated connection', async () => {
    const { logs, url } = await startServer();
    const ws = connect(`${url}?access_token=secret`);
    await waitForOpen(ws);

    await waitUntil(() => logs.includes('qq: connected'));

    expect(logs).toContain('qq: connected');
  });

  it('accepts a connection with an Authorization Bearer header', async () => {
    const { server, url } = await startServer();
    const ws = connect(url, { headers: { authorization: 'Bearer secret' } });
    await waitForOpen(ws);

    expect(server.connected).toBe(true);
  });

  it('closes a connection with the wrong token using code 4001', async () => {
    const { url, logs } = await startServer();
    const ws = connect(`${url}?access_token=wrong`);

    expect(await waitForClose(ws)).toBe(4001);
    expect(logs.length).toBeGreaterThan(0);
  });

  it('closes a connection with a missing token using code 4001', async () => {
    const { url } = await startServer();
    const ws = connect(url);

    expect(await waitForClose(ws)).toBe(4001);
  });

  it('keeps only one connection, closing the old one with code 4002', async () => {
    const { server, url } = await startServer();
    const first = connect(`${url}?access_token=secret`);
    await waitForOpen(first);

    const firstClosed = waitForClose(first);
    const second = connect(`${url}?access_token=secret`);
    await waitForOpen(second);

    expect(await firstClosed).toBe(4002);
    expect(second.readyState).toBe(WebSocket.OPEN);
    expect(server.connected).toBe(true);
  });

  it('resolves call() with the matching echo response data', async () => {
    const { server, url } = await startServer();
    const ws = connect(`${url}?access_token=secret`);
    await waitForOpen(ws);

    const incoming = nextJson(ws);
    const result = server.call('get_login_info', {});
    const action = await incoming;

    expect(action['action']).toBe('get_login_info');
    expect(action['params']).toEqual({});
    expect(typeof action['echo']).toBe('string');

    ws.send(
      JSON.stringify({
        status: 'ok',
        retcode: 0,
        data: { user_id: 10001 },
        echo: action['echo'],
      }),
    );

    await expect(result).resolves.toEqual({ user_id: 10001 });
  });

  it('rejects call() when the response has status failed', async () => {
    const { server, url } = await startServer();
    const ws = connect(`${url}?access_token=secret`);
    await waitForOpen(ws);

    const incoming = nextJson(ws);
    const result = server.call('send_group_msg', { group_id: 1 });
    const action = await incoming;

    ws.send(
      JSON.stringify({ status: 'failed', retcode: 1404, echo: action['echo'] }),
    );

    await expect(result).rejects.toThrow(/failed/);
  });

  it('rejects call() on a non-zero retcode even when status is ok', async () => {
    const { server, url } = await startServer();
    const ws = connect(`${url}?access_token=secret`);
    await waitForOpen(ws);

    const incoming = nextJson(ws);
    const result = server.call('send_group_msg', { group_id: 1 });
    const action = await incoming;

    ws.send(JSON.stringify({ status: 'ok', retcode: 1, echo: action['echo'] }));

    await expect(result).rejects.toThrow(/retcode=1/);
  });

  it('reports connection changes through onConnectionChange', async () => {
    const changes: boolean[] = [];
    const { url } = await startServer({ onConnectionChange: (connected) => changes.push(connected) });

    const ws = connect(`${url}?access_token=secret`);
    await waitForOpen(ws);
    await waitUntil(() => changes.length === 1);
    expect(changes).toEqual([true]);

    ws.close();
    await waitUntil(() => changes.length === 2);
    expect(changes).toEqual([true, false]);
  });

  it('rejects call() on timeout', async () => {
    const { server, url } = await startServer();
    const ws = connect(`${url}?access_token=secret`);
    await waitForOpen(ws);

    await expect(server.call('noop', {}, 40)).rejects.toThrow(/timed out/);
  });

  it('rejects all pending calls when the connection closes', async () => {
    const { server, url } = await startServer();
    const ws = connect(`${url}?access_token=secret`);
    await waitForOpen(ws);

    const pending = server.call('slow_action', {}, 5000);
    const expectation = expect(pending).rejects.toThrow(/closed/);

    ws.close();
    await expectation;
  });

  it('learns selfId from meta_event and message events', async () => {
    const { server, events, url } = await startServer();
    const ws = connect(`${url}?access_token=secret`);
    await waitForOpen(ws);

    ws.send(
      JSON.stringify({
        post_type: 'meta_event',
        meta_event_type: 'lifecycle',
        self_id: 123,
        time: 1,
      }),
    );
    await waitUntil(() => server.selfId === 123);

    ws.send(
      JSON.stringify({
        post_type: 'message',
        message_type: 'group',
        self_id: 456,
        user_id: 7,
        group_id: 8,
        message_id: 9,
        raw_message: 'hi[CQ:face,id=1]',
        sender: { user_id: 7, nickname: 'someone' },
      }),
    );
    await waitUntil(() => events.length === 1);

    expect(server.selfId).toBe(456);
    expect(events[0]).toMatchObject({
      post_type: 'message',
      message_type: 'group',
      self_id: 456,
      user_id: 7,
      group_id: 8,
      raw_message: 'hi[CQ:face,id=1]',
    });
  });

  it('ignores malformed JSON without crashing', async () => {
    const { server, events, url } = await startServer();
    const ws = connect(`${url}?access_token=secret`);
    await waitForOpen(ws);

    ws.send('not json');
    ws.send(
      JSON.stringify({
        post_type: 'message',
        message_type: 'private',
        self_id: 1,
        user_id: 2,
        message_id: 3,
        raw_message: 'still works',
        sender: { user_id: 2 },
      }),
    );
    await waitUntil(() => events.length === 1);

    expect(events[0]?.raw_message).toBe('still works');
  });

  it('closes a silent connection after the pong timeout', async () => {
    const { url } = await startServer({ heartbeatMs: 20, pongTimeoutMs: 100 });
    const ws = connect(`${url}?access_token=secret`, { autoPong: false });
    await waitForOpen(ws);

    expect(await waitForClose(ws)).toBe(1006);
  });

  it('keeps a connection that answers pings', async () => {
    const { server, url } = await startServer({ heartbeatMs: 20, pongTimeoutMs: 100 });
    const ws = connect(`${url}?access_token=secret`);
    await waitForOpen(ws);

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(server.connected).toBe(true);
  });

  it('logs ignored non-message events with their type', async () => {
    const { logs, url } = await startServer();
    const ws = connect(`${url}?access_token=secret`);
    await waitForOpen(ws);

    ws.send(JSON.stringify({ post_type: 'notice', notice_type: 'group_increase', self_id: 1 }));
    await waitUntil(() => logs.some((line) => line.includes('ignored notice event')));

    ws.send(JSON.stringify({ post_type: 'request', request_type: 'friend', self_id: 1 }));
    await waitUntil(() => logs.some((line) => line.includes('ignored request event')));

    expect(logs.some((line) => line.includes('notice'))).toBe(true);
  });

  it('forwards notice events to onNotice instead of ignoring them', async () => {
    const notices: Array<Record<string, unknown>> = [];
    const { logs, url } = await startServer({
      onNotice: (event) => notices.push(event as Record<string, unknown>),
    });
    const ws = connect(`${url}?access_token=secret`);
    await waitForOpen(ws);

    ws.send(
      JSON.stringify({
        post_type: 'notice',
        notice_type: 'group_ban',
        sub_type: 'ban',
        self_id: 1,
        group_id: 2,
        user_id: 1,
      }),
    );
    await waitUntil(() => notices.length === 1);

    expect(notices[0]).toMatchObject({ post_type: 'notice', notice_type: 'group_ban' });
    expect(logs.some((line) => line.includes('ignored notice event'))).toBe(false);
  });

  it('keeps request and message_sent as static ignore logs', async () => {
    const { logs, url } = await startServer();
    const ws = connect(`${url}?access_token=secret`);
    await waitForOpen(ws);

    ws.send(JSON.stringify({ post_type: 'request', request_type: 'friend', self_id: 1 }));
    ws.send(JSON.stringify({ post_type: 'message_sent', message_type: 'private', self_id: 1 }));
    await waitUntil(() => logs.includes('qq: ignored message_sent event'));

    expect(logs).toContain('qq: ignored request event');
    expect(logs).toContain('qq: ignored message_sent event');
  });

  it('logs a static line when the async event handler rejects', async () => {
    const rejecting = (() =>
      Promise.reject(new Error('secret handler detail'))) as unknown as (
      event: OneBotMessageEvent,
    ) => void;
    const { logs, url } = await startServer({ onEvent: rejecting });
    const ws = connect(`${url}?access_token=secret`);
    await waitForOpen(ws);

    ws.send(
      JSON.stringify({
        post_type: 'message',
        message_type: 'private',
        self_id: 1,
        user_id: 2,
        message_id: 3,
        raw_message: 'hi',
        sender: { user_id: 2 },
      }),
    );
    await waitUntil(() => logs.includes('qq: event handler failed'));

    expect(logs.join('\n')).not.toContain('secret handler detail');
  });

  it('keeps serving after an async event handler rejection', async () => {
    const seen: OneBotMessageEvent[] = [];
    const flaky = ((event: OneBotMessageEvent) => {
      seen.push(event);
      return seen.length === 1 ? Promise.reject(new Error('boom')) : undefined;
    }) as unknown as (event: OneBotMessageEvent) => void;
    const { logs, url } = await startServer({ onEvent: flaky });
    const ws = connect(`${url}?access_token=secret`);
    await waitForOpen(ws);

    const event = {
      post_type: 'message',
      message_type: 'private',
      self_id: 1,
      user_id: 2,
      message_id: 3,
      raw_message: 'hi',
      sender: { user_id: 2 },
    };
    ws.send(JSON.stringify(event));
    await waitUntil(() => logs.includes('qq: event handler failed'));
    ws.send(JSON.stringify({ ...event, message_id: 4 }));
    await waitUntil(() => seen.length === 2);

    expect(seen).toHaveLength(2);
  });

  it('closes a connection whose frame exceeds the 1 MiB payload cap', async () => {
    const { url } = await startServer();
    const ws = connect(`${url}?access_token=secret`);
    await waitForOpen(ws);

    const closed = waitForClose(ws);
    ws.send('x'.repeat(1_100_000));

    expect(await closed).toBe(1009);
  });

  it('rejects start() when the port is already in use', async () => {
    const first = await startServer();
    const second = new QqServer({
      port: first.port,
      token: 'secret',
      onEvent: () => {},
      log: () => {},
    });
    servers.push(second);

    await expect(second.start()).rejects.toThrow(/EADDRINUSE/);
  });

  it('stops idempotently and closes the client', async () => {
    const { server, url } = await startServer();
    const ws = connect(`${url}?access_token=secret`);
    await waitForOpen(ws);

    const closed = waitForClose(ws);
    await server.stop();
    await closed;
    await server.stop();

    expect(server.connected).toBe(false);
  });

  it('exposes the actual bound port when started with port 0', async () => {
    const { server, port } = await startServer();

    expect(port).toBeGreaterThan(0);
    expect(server.port).toBe(port);
  });

  it('rejects an empty configured token at construction', () => {
    const base = { port: 0, onEvent: () => {}, log: () => {} };

    expect(() => new QqServer({ ...base, token: '' })).toThrow(/QQ_WS_TOKEN/);
    expect(() => new QqServer({ ...base, token: '   ' })).toThrow(/QQ_WS_TOKEN/);
  });

  it('survives a malformed frame from an unauthenticated connection', async () => {
    const { server, logs, url } = await startServer();
    const raw = await rawWebSocketHandshake(server.port, 'wrong');

    // 0x81 0x01 0x41 = 未加掩码的文本帧；客户端到服务端的帧必须加掩码，
    // ws 解析时会抛 RangeError。没有 error 监听时这曾直接杀掉进程。
    raw.write(Buffer.from([0x81, 0x01, 0x41]));
    await waitUntil(() => logs.some((line) => line.includes('连接错误')), 1000);
    raw.destroy();

    const valid = connect(`${url}?access_token=secret`);
    await waitForOpen(valid);
    expect(server.connected).toBe(true);
  });

  it('destroys a connection with a malformed request target without crashing', async () => {
    const { server, url } = await startServer();
    const raw = await openRawSocket(server.port);
    const closed = waitForSocketClose(raw);

    raw.write(
      'GET http://[ HTTP/1.1\r\n' +
        'Host: 127.0.0.1\r\n' +
        'Connection: Upgrade\r\n' +
        'Upgrade: websocket\r\n' +
        'Sec-WebSocket-Version: 13\r\n' +
        'Sec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\n\r\n',
    );
    await withTimeout(closed);
    raw.destroy();

    const valid = connect(`${url}?access_token=secret`);
    await waitForOpen(valid);
    expect(server.connected).toBe(true);
  });

  it('keeps a valid connection alive when another connection is rejected', async () => {
    const { server, url } = await startServer();
    const valid = connect(`${url}?access_token=secret`);
    await waitForOpen(valid);

    const bad = connect(`${url}?access_token=wrong`);
    expect(await waitForClose(bad)).toBe(4001);

    expect(valid.readyState).toBe(WebSocket.OPEN);
    expect(server.connected).toBe(true);
  });
});

describe('QqServer auth method observability (R6)', () => {
  it('records whether the token arrived in the header or the query string', async () => {
    const { logs, url } = await startServer();

    const viaQuery = connect(`${url}?access_token=secret`);
    await waitForOpen(viaQuery);
    await waitUntil(() => logs.some((line) => line.includes('authenticated via query')));
    expect(logs.some((line) => line.includes('token in URL'))).toBe(true);

    const viaHeader = connect(url, { headers: { authorization: 'Bearer secret' } });
    await waitForOpen(viaHeader);
    await waitUntil(() => logs.some((line) => line.includes('authenticated via header')));
  });
});
