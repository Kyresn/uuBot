/**
 * QQ 渠道的 OneBot 11 反向 WebSocket 服务端。
 *
 * NapCat（或任意 OneBot 11 实现）作为客户端连入 `/onebot/v11/ws`：
 * - 鉴权：`Authorization: Bearer <token>` 或 `?access_token=<token>`；
 *   不匹配时握手后 `close(4001)`（随后强制 terminate）并记日志。
 * - 单连接：新连接通过鉴权后，旧连接以 `4002` 关闭。
 * - 心跳：每 `heartbeatMs` 发 ping，`pongTimeoutMs` 内无 pong 则终止连接。
 * - 动作：`call()` 用随机 `echo` 匹配响应，超时或断线即 reject。
 * - `selfId` 从 `meta_event` 或消息事件的 `self_id` 学习。
 *
 * 安全：默认只监听 `127.0.0.1`。把端口暴露到 loopback 或受信任的 compose
 * 网络之外，等于把 agent 的消息通道交给任何能连上的人；确需跨容器访问时
 * 只绑定到受信任网络，并配置足够长的随机 token。
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { OneBotMessageEvent } from './protocol.js';

/** WebSocket 路径；其他路径的 upgrade 请求直接 404。 */
const WS_PATH = '/onebot/v11/ws';

const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_PONG_TIMEOUT_MS = 60_000;
const DEFAULT_HOST = '127.0.0.1';

/** 关闭码：鉴权失败。 */
export const CLOSE_INVALID_TOKEN = 4001;
/** 关闭码：被新连接替换。 */
export const CLOSE_REPLACED = 4002;

/** 拒绝连接后等待 close 帧发送的宽限；对端不回应时强制终止。 */
const REJECT_TERMINATE_MS = 1_000;

/** 单帧上限：1 MiB。OneBot 事件与动作响应都远小于此，超限即视为攻击面。 */
const MAX_PAYLOAD_BYTES = 1024 * 1024;

export interface QqServerOptions {
  port: number;
  token: string;
  onEvent: (e: OneBotMessageEvent) => void;
  log: (l: string) => void;
  heartbeatMs?: number;
  pongTimeoutMs?: number;
  /** 监听地址，默认 `127.0.0.1`；暴露到不可信网络前请阅读文件头安全说明。 */
  host?: string;
  /** 活跃连接建立/断开时回调：渠道层据此把连接状态写入感知队列。 */
  onConnectionChange?: (connected: boolean) => void;
  /**
   * notice 事件转发。缺省时保持 M2a 的静态忽略日志；提供后由渠道层做
   * 形状校验与固定枚举映射（`plugins/channels/qq/notice.ts`）。
   */
  onNotice?: (e: unknown) => void;
}

interface PendingCall {
  socket: WebSocket;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

/** 鉴权来源：header 与 query 都接受，但来源必须可观测（spec R6）。 */
export interface ExtractedToken {
  token: string;
  via: 'header' | 'query';
}

function extractToken(req: IncomingMessage): ExtractedToken | null {
  const header = req.headers.authorization;
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (match?.[1] !== undefined) return { token: match[1].trim(), via: 'header' };
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const query = url.searchParams.get('access_token');
  return query === null ? null : { token: query, via: 'query' };
}

export class QqServer {
  private readonly token: string;
  private readonly onEvent: (e: OneBotMessageEvent) => void;
  private readonly log: (l: string) => void;
  private readonly listenPort: number;
  private readonly host: string;
  private readonly heartbeatMs: number;
  private readonly pongTimeoutMs: number;
  private readonly onConnectionChange: ((connected: boolean) => void) | undefined;
  private readonly onNotice: ((event: unknown) => void) | undefined;

  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private heartbeatCleanup: (() => void) | null = null;
  private readonly pending = new Map<string, PendingCall>();
  private boundPort: number | null = null;
  private learnedSelfId: number | undefined;

  constructor(options: QqServerOptions) {
    if (options.token.trim() === '') {
      throw new Error('QQ_WS_TOKEN must be non-empty');
    }

    this.token = options.token;
    this.onEvent = options.onEvent;
    this.log = options.log;
    this.listenPort = options.port;
    this.host = options.host ?? DEFAULT_HOST;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.pongTimeoutMs = options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
    this.onConnectionChange = options.onConnectionChange;
    this.onNotice = options.onNotice;
  }

  /** 实际监听端口；未启动时返回配置端口（`port: 0` 时启动后才有意义）。 */
  get port(): number {
    return this.boundPort ?? this.listenPort;
  }

  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  get selfId(): number | undefined {
    return this.learnedSelfId;
  }

  async start(): Promise<void> {
    if (this.httpServer !== null) return;

    const httpServer = createServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
    wss.on('connection', (ws, req) => this.handleConnection(ws, req));

    httpServer.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(wss, req, socket, head);
    });

    this.httpServer = httpServer;
    this.wss = wss;

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          httpServer.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          httpServer.off('error', onError);
          resolve();
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(this.listenPort, this.host);
      });
    } catch (error) {
      this.httpServer = null;
      this.wss = null;
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      throw error;
    }

    const address = httpServer.address();
    this.boundPort =
      typeof address === 'object' && address !== null ? address.port : this.listenPort;

    // 持久错误监听：listen 的一次性监听已在成功后摘除，此后 http server 与
    // wss 上的 'error' 若无人监听会升级成未捕获异常并杀掉进程。
    httpServer.on('error', (error: Error) => {
      this.log(`qq: server error: ${error.message}`);
    });
    wss.on('error', (error: Error) => {
      this.log(`qq: websocket server error: ${error.message}`);
    });

    this.log(`qq: 监听 ${this.host}:${this.boundPort}，路径 ${WS_PATH}`);
  }

  async stop(): Promise<void> {
    this.clearHeartbeat();

    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      try {
        socket.close(1001, 'server stopping');
      } catch {
        socket.terminate();
      }
    }
    this.rejectAll(new Error('qq connection closed: server stopped'));

    const wss = this.wss;
    this.wss = null;
    if (wss !== null) {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }

    const httpServer = this.httpServer;
    this.httpServer = null;
    if (httpServer !== null) {
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }

    this.boundPort = null;
  }

  /** 发送动作并等待匹配 `echo` 的响应；返回响应的 `data`。 */
  call(
    action: string,
    params: Record<string, unknown>,
    timeoutMs = 10_000,
  ): Promise<unknown> {
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('qq server: not connected'));
    }

    const echo = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`qq action ${action} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();

      this.pending.set(echo, { socket, resolve, reject, timer });

      socket.send(JSON.stringify({ action, params, echo }), (error: Error | null | undefined) => {
        if (error === undefined || error === null) return;
        const pending = this.pending.get(echo);
        if (pending === undefined) return;
        this.pending.delete(echo);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  private handleUpgrade(
    wss: WebSocketServer,
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    // upgrade 的原始 socket 上任何未监听错误都可能杀掉进程。
    socket.on('error', () => {
      /* 对端断开/畸形请求由 destroy 收尾，这里只防止未捕获异常。 */
    });

    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      this.log('qq: 非法 upgrade 请求目标，关闭连接 (400)');
      try {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      } catch {
        /* socket 已不可写，直接 destroy。 */
      }
      socket.destroy();
      return;
    }

    if (url.pathname !== WS_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    // 必须先挂 error/close：未鉴权连接也可能收到畸形帧，ws 会 emit 'error'，
    // 没有监听器时 Node 会把它升级成未捕获异常并杀掉进程。
    ws.on('error', (error) => this.log(`qq: 连接错误: ${error.message}`));
    ws.on('close', () => this.handleClose(ws));

    const auth = extractToken(req);
    if (auth === null || auth.token === '' || !this.tokenMatches(auth.token)) {
      this.rejectConnection(ws);
      return;
    }
    // token 出现在 URL 里是可观测事件：query 鉴权明确记一行，便于发现
    // 代理/日志把凭据写进访问日志的部署问题。
    this.log(
      auth.via === 'query'
        ? 'qq: authenticated via query (token in URL)'
        : 'qq: authenticated via header',
    );

    const previous = this.socket;
    if (previous !== null && previous !== ws) {
      this.log('qq: 新连接替换旧连接 (4002)');
      this.rejectPendingFor(previous);
      this.clearHeartbeat();
      try {
        previous.close(CLOSE_REPLACED, 'replaced by a new connection');
      } catch {
        previous.terminate();
      }
    }

    this.socket = ws;
    this.startHeartbeat(ws);
    // 契约日志：deploy/napcat/README.md 与部署冒烟检查都依赖这一行原文。
    this.log('qq: connected');
    this.onConnectionChange?.(true);

    ws.on('message', (data) => {
      // 只处理当前连接的消息；被替换的旧连接即使还在收包也不得影响状态。
      if (this.socket !== ws) return;
      this.handleMessage(data);
    });
  }

  /**
   * 拒绝未鉴权连接：先发 4001 close 帧（客户端可观测），对端不回应时
   * 在宽限期后 terminate，避免半开连接长期占用。
   */
  private rejectConnection(ws: WebSocket): void {
    this.log('qq: 鉴权失败，关闭连接 (4001)');
    try {
      ws.close(CLOSE_INVALID_TOKEN, 'invalid token');
    } catch {
      ws.terminate();
      return;
    }

    const timer = setTimeout(() => ws.terminate(), REJECT_TERMINATE_MS);
    timer.unref();
    ws.once('close', () => clearTimeout(timer));
  }

  private tokenMatches(candidate: string): boolean {
    const expected = Buffer.from(this.token);
    const actual = Buffer.from(candidate);
    // timingSafeEqual 要求长度一致；长度本身不是秘密。
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  private handleClose(ws: WebSocket): void {
    this.rejectPendingFor(ws);
    if (this.socket !== ws) return;
    this.socket = null;
    this.clearHeartbeat();
    this.log('qq: 连接已关闭');
    this.onConnectionChange?.(false);
  }

  private handleMessage(data: RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      this.log('qq: 忽略无法解析的消息');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;

    const record = parsed as Record<string, unknown>;

    const echo = record['echo'];
    if (typeof echo === 'string') {
      const pending = this.pending.get(echo);
      if (pending !== undefined) {
        this.pending.delete(echo);
        clearTimeout(pending.timer);
        // status=failed 与 retcode!=0 都是失败：只认 status 会把部分实现的
        // 错误响应当成功，发送失败的冷却与日志就都丢了。
        if (record['status'] === 'failed' || record['retcode'] !== 0) {
          pending.reject(
            new Error(`qq action failed: retcode=${String(record['retcode'])}`),
          );
        } else {
          pending.resolve(record['data']);
        }
        return;
      }
    }

    const selfId = record['self_id'];
    if (typeof selfId === 'number') this.learnedSelfId = selfId;

    switch (record['post_type']) {
      case 'meta_event':
        this.log(`qq: meta_event ${String(record['meta_event_type'] ?? '')}`);
        return;
      case 'message':
        // 处理器是 async 的：rejection 必须在这里被观察到，否则 Node 22
        // 会把它升级成未捕获异常并终止进程。日志只写静态文本，不插值错误。
        this.invokeHandler(this.onEvent, record as unknown as OneBotMessageEvent, 'qq: event handler failed');
        return;
      case 'notice':
        if (this.onNotice === undefined) {
          this.log('qq: ignored notice event');
          return;
        }
        this.invokeHandler(this.onNotice, record, 'qq: notice handler failed');
        return;
      // 非消息事件里 request / message_sent 仍静态忽略，但要可观测：静默
      // 丢弃会让排障无从下手。只记固定类别，不插值对端提供的字段。
      case 'request':
      case 'message_sent':
        this.log(`qq: ignored ${record['post_type']} event`);
        return;
      default:
        this.log('qq: ignored unknown event');
        return;
    }
  }

  /**
   * 调用渠道回调并观察其返回值：回调可能声明为 void 但实际是 async。
   * 未观察的 rejection 会让 Node 终止进程；同步抛错也在这里收口。
   */
  private invokeHandler<T>(handler: (value: T) => void, value: T, failureLine: string): void {
    try {
      void Promise.resolve(handler(value)).catch(() => {
        this.log(failureLine);
      });
    } catch {
      this.log(failureLine);
    }
  }

  /**
   * 心跳状态按连接持有：被替换旧连接的迟到 pong 只作用于它自己的计时器，
   * 不会清掉新连接的超时。
   */
  private startHeartbeat(ws: WebSocket): void {
    this.clearHeartbeat();

    let pongTimer: NodeJS.Timeout | null = null;
    const clearPongTimer = (): void => {
      if (pongTimer === null) return;
      clearTimeout(pongTimer);
      pongTimer = null;
    };

    const heartbeatTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.ping();
      if (pongTimer !== null) return;

      pongTimer = setTimeout(() => {
        pongTimer = null;
        if (this.socket !== ws) return;
        this.log('qq: pong 超时，关闭连接');
        ws.terminate();
      }, this.pongTimeoutMs);
      pongTimer.unref();
    }, this.heartbeatMs);
    heartbeatTimer.unref();

    const onPong = (): void => {
      if (this.socket !== ws) return;
      clearPongTimer();
    };
    ws.on('pong', onPong);

    this.heartbeatCleanup = (): void => {
      clearInterval(heartbeatTimer);
      clearPongTimer();
      ws.off('pong', onPong);
    };
  }

  private clearHeartbeat(): void {
    if (this.heartbeatCleanup === null) return;
    this.heartbeatCleanup();
    this.heartbeatCleanup = null;
  }

  private rejectPendingFor(ws: WebSocket): void {
    for (const [echo, pending] of this.pending) {
      if (pending.socket !== ws) continue;
      this.pending.delete(echo);
      clearTimeout(pending.timer);
      pending.reject(new Error('qq connection closed'));
    }
  }

  private rejectAll(error: Error): void {
    for (const [echo, pending] of this.pending) {
      this.pending.delete(echo);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}
