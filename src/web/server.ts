/**
 * 进程内网页管理台服务。
 *
 * 与心跳循环同进程运行，因此任何请求级故障都必须被限制在本请求内：
 * 每请求独立 try/catch、硬性 body 上限、连接与超时上限、listen 失败只禁用网页。
 *
 * 路由表按 `method + path` 固定匹配，后续任务（模型/对话/计划/架构）只需往
 * `ROUTE_TABLE` 加一行并通过 `routeHandlers` 注入处理函数，不需要改调度逻辑。
 *
 * 安全不变量见 docs/superpowers/specs/2026-10-29-web-console-design.md：
 * Host 白名单（421）、写请求 CSRF 头 + Origin（403）、会话鉴权（401）、
 * 静态资源只认白名单（无通用路径解析）、所有响应带安全头。
 */
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkTokenStrength,
  createAuth,
  SESSION_COOKIE_NAME,
  TOKEN_GENERATE_COMMAND,
  type Auth,
  type LoginContext,
} from './auth.js';
import {
  isJsonContentType,
  isLoopbackHost,
  readJsonBody,
  sendJson,
  sendTooLarge,
  securityHeaders,
} from './http-util.js';
import { stripUnsafeControls } from '../util/tty.js';

const DEFAULT_STATIC_ROOT = fileURLToPath(new URL('./static', import.meta.url));

const LOGIN_BODY_LIMIT = 8 * 1024;
const JSON_BODY_LIMIT = 64 * 1024;

const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
const MAX_REQUESTS_PER_SOCKET = 50;

/** 非 loopback 绑定的固定拒绝原因；调用方据此只禁用网页。 */
export const REMOTE_BIND_REFUSED =
  'refusing to bind non-loopback host without WEB_ALLOW_REMOTE=1';

const STATIC_FILES: ReadonlyArray<{ path: string; file: string; type: string }> = [
  { path: '/', file: 'index.html', type: 'text/html; charset=utf-8' },
  { path: '/app.js', file: 'app.js', type: 'text/javascript; charset=utf-8' },
  { path: '/style.css', file: 'style.css', type: 'text/css; charset=utf-8' },
];

export type RouteKind =
  | 'login'
  | 'logout'
  | 'health'
  | 'state'
  | 'models'
  | 'modelsTest'
  | 'conversations'
  | 'plan'
  | 'architecture'
  | 'approvals'
  | 'approvalsDecide'
  | 'control'
  | 'controlCommand'
  | 'chatMessages'
  | 'chatHistory'
  | 'settings'
  | 'settingsSave';

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** 已解析的 JSON body；无 body 的路由为 `undefined`。 */
  body: unknown;
  /** 直接写响应；返回后调度器不会再补写。 */
  send(status: number, value: unknown): void;
}

export type RouteHandler = (ctx: RouteContext) => Promise<unknown> | unknown;

interface RouteDef {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  kind: RouteKind;
  auth: boolean;
  /** `'none'`：不读请求体，也不要求 Content-Type（如 logout）。 */
  body?: 'none';
  bodyLimit?: number;
}

/**
 * 路由表：后续任务的挂载点。
 * 新增路由时只加一行，处理函数通过 `WebServerOptions.routeHandlers` 注入。
 */
const ROUTE_TABLE: readonly RouteDef[] = [
  { method: 'POST', path: '/api/login', kind: 'login', auth: false, bodyLimit: LOGIN_BODY_LIMIT },
  { method: 'POST', path: '/api/logout', kind: 'logout', auth: true, body: 'none' },
  { method: 'GET', path: '/api/health', kind: 'health', auth: false },
  { method: 'GET', path: '/api/state', kind: 'state', auth: true },
  { method: 'PUT', path: '/api/models', kind: 'models', auth: true, bodyLimit: JSON_BODY_LIMIT },
  {
    method: 'POST',
    path: '/api/models/test',
    kind: 'modelsTest',
    auth: true,
    bodyLimit: JSON_BODY_LIMIT,
  },
  { method: 'GET', path: '/api/conversations', kind: 'conversations', auth: true },
  { method: 'GET', path: '/api/plan', kind: 'plan', auth: true },
  { method: 'GET', path: '/api/architecture', kind: 'architecture', auth: true },
  // 控制面（spec §8）：决策只有 POST；GET 决策会被写闸漏掉，因此不存在。
  { method: 'GET', path: '/api/approvals', kind: 'approvals', auth: true },
  {
    method: 'POST',
    path: '/api/approvals/decide',
    kind: 'approvalsDecide',
    auth: true,
    bodyLimit: JSON_BODY_LIMIT,
  },
  { method: 'GET', path: '/api/control', kind: 'control', auth: true },
  {
    method: 'POST',
    path: '/api/control/command',
    kind: 'controlCommand',
    auth: true,
    bodyLimit: JSON_BODY_LIMIT,
  },
  // 网页对话（spec §3.5）：同一路径的读与写，写走全部 CSRF/JSON/体积闸。
  {
    method: 'POST',
    path: '/api/chat/messages',
    kind: 'chatMessages',
    auth: true,
    bodyLimit: JSON_BODY_LIMIT,
  },
  { method: 'GET', path: '/api/chat/messages', kind: 'chatHistory', auth: true },
  // 设置（spec §3.5）：GET 返回掩码配置，PUT 干跑 → 原子写 → 热生效。
  // 同一路径的读与写，写自动走全部 CSRF/JSON/体积/关闭期闸。
  { method: 'GET', path: '/api/settings', kind: 'settings', auth: true },
  {
    method: 'PUT',
    path: '/api/settings',
    kind: 'settingsSave',
    auth: true,
    bodyLimit: JSON_BODY_LIMIT,
  },
];

export interface ReadinessSnapshot {
  allDegraded: boolean;
  silentRounds: number;
}

export interface WebServerOptions {
  host: string;
  port: number;
  token: string;
  /** 非 loopback 绑定必须显式为 true，否则拒绝启动。 */
  allowRemote?: boolean;
  /** `/api/state` 的数据来源；后续任务通常改用 `routeHandlers.state`。 */
  state?: () => Promise<unknown> | unknown;
  /** 后续任务的挂载点；函数值会被当作 RouteHandler 使用。 */
  models?: unknown;
  conversations?: unknown;
  plan?: unknown;
  architecture?: unknown;
  /** 新的挂载方式；优先级高于上面的单字段。 */
  routeHandlers?: Partial<Record<RouteKind, RouteHandler>>;
  /** `/api/health?deep=1` 的探针；缺省视为全部健康、静默 0 轮。 */
  readiness?: () => Promise<ReadinessSnapshot> | ReadinessSnapshot;
  log?: (line: string) => void;
  now?: () => number;
  secureCookie?: boolean;
  trustedProxy?: boolean;
  /** 测试用：覆盖静态资源目录。 */
  staticRoot?: string;
  /**
   * 额外的 Host/Origin 白名单条目（`host` 或 `host:port`），用于 TLS 反向代理。
   * 例如 `WEB_ALLOWED_HOSTS=console.example.com`；反代必须透传浏览器原始 Host。
   */
  allowedHosts?: readonly string[];
}

export interface WebServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  port(): number;
  /**
   * 关闭序列第一步：拒绝新的写请求（503），读请求继续服务到 `stop()` 为止。
   * 实现方必须提供（关闭序列依赖它先于 store.close 生效）。
   */
  stopAcceptingWrites(): void;
}

interface StaticAsset {
  body: Buffer;
  type: string;
}

interface RouteMatch {
  def: RouteDef;
  handler: RouteHandler | undefined;
}

function authorityHost(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith('[')) return value;
  return isIP(value) === 6 ? `[${value}]` : value;
}

function asHandler(value: unknown): RouteHandler | undefined {
  return typeof value === 'function' ? (value as RouteHandler) : undefined;
}

class WebConsoleServer implements WebServer {
  private readonly opts: WebServerOptions;
  private readonly log: (line: string) => void;
  private server: Server | null = null;
  private auth: Auth | null = null;
  private boundPort: number | null = null;
  private writesClosed = false;
  private readonly staticAssets = new Map<string, StaticAsset>();

  constructor(opts: WebServerOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
  }

  port(): number {
    return this.boundPort ?? this.opts.port;
  }

  stopAcceptingWrites(): void {
    this.writesClosed = true;
  }

  async start(): Promise<void> {
    if (this.server !== null) return;
    this.writesClosed = false;

    const strength = checkTokenStrength(this.opts.token);
    if (!strength.ok) {
      throw new Error(
        strength.reason === 'too_short'
          ? `WEB_CONSOLE_TOKEN must be at least 32 characters; generate one with: ${TOKEN_GENERATE_COMMAND}`
          : `WEB_CONSOLE_TOKEN is a placeholder value; generate one with: ${TOKEN_GENERATE_COMMAND}`,
      );
    }

    if (this.opts.allowRemote !== true && !isLoopbackHost(this.opts.host)) {
      throw new Error(REMOTE_BIND_REFUSED);
    }

    await this.loadStatic();

    const auth = createAuth(this.opts.token, {
      secureCookie: this.opts.secureCookie,
      now: this.opts.now,
      trustedProxy: this.opts.trustedProxy,
    });

    const server = createServer((req, res) => {
      // handle 自身的 catch 也可能抛（sendJson/res.end/日志）：没有兜底时
      // Node 22 会把未处理的 rejection 当成致命错误杀掉整个 harness。
      this.handle(req, res).catch((error: unknown) => {
        try {
          const message = error instanceof Error ? error.message : String(error);
          this.log(`web: request handler failed: ${stripUnsafeControls(message)}`);
          if (!res.headersSent) {
            sendJson(res, 500, { ok: false, code: 'internal' }, '/');
          } else if (!res.writableEnded) {
            res.end();
          }
        } catch {
          // 连接已不可写；兜底失败也只能放弃本请求。
          try {
            res.destroy();
          } catch {
            /* 已销毁。 */
          }
        }
      });
    });
    server.headersTimeout = HEADERS_TIMEOUT_MS;
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
    server.maxRequestsPerSocket = MAX_REQUESTS_PER_SOCKET;

    server.on('clientError', (error, socket) => {
      this.log(`web: client error: ${stripUnsafeControls(error.message)}`);
      try {
        if (socket.writable) {
          socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        }
      } catch {
        /* socket 已不可写，直接 destroy。 */
      }
      socket.destroy();
    });

    server.on('upgrade', (_req, socket) => {
      // 网页服务不提供 WebSocket；保留 upgrade 等于多一个未审计的入口。
      socket.on('error', () => {
        /* 对端断开由 destroy 收尾。 */
      });
      socket.destroy();
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(this.opts.port, this.opts.host);
      });
    } catch (error) {
      server.close();
      throw error;
    }

    const address = server.address();
    this.boundPort =
      typeof address === 'object' && address !== null ? address.port : this.opts.port;
    this.server = server;
    this.auth = auth;

    // 持久错误监听：listen 的一次性监听已摘除，之后任何 'error' 无人接管
    // 都会升级成未捕获异常并杀掉整个 harness。
    server.on('error', (error: Error) => {
      this.log(`web: server error: ${stripUnsafeControls(error.message)}`);
    });

    this.log(`web: listening on ${authorityHost(this.opts.host)}:${this.boundPort}`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.boundPort = null;
    this.auth?.reset();
    this.auth = null;

    if (server === null) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async loadStatic(): Promise<void> {
    const root = this.opts.staticRoot ?? DEFAULT_STATIC_ROOT;
    for (const entry of STATIC_FILES) {
      try {
        const body = await readFile(join(root, entry.file));
        this.staticAssets.set(entry.path, { body, type: entry.type });
      } catch {
        throw new Error(`web console static asset missing: ${entry.file}`);
      }
    }
  }

  private requireAuth(): Auth {
    if (this.auth === null) throw new Error('web console is not started');
    return this.auth;
  }

  private allowedAuthorities(): Set<string> {
    const port = this.boundPort ?? this.opts.port;
    const names = new Set<string>(['127.0.0.1', 'localhost', '[::1]', authorityHost(this.opts.host)]);
    const authorities = new Set<string>();
    for (const name of names) {
      authorities.add(`${name}:${port}`);
      if (port === 80 || port === 443) authorities.add(name);
    }
    // 反代部署时浏览器看到的 Host/Origin 与绑定地址不同，由显式白名单补齐。
    for (const entry of this.opts.allowedHosts ?? []) {
      const value = entry.trim().toLowerCase();
      if (value !== '') authorities.add(value);
    }
    return authorities;
  }

  private hostAllowed(host: string | undefined): boolean {
    if (host === undefined) return false;
    return this.allowedAuthorities().has(host.trim().toLowerCase());
  }

  private originAllowed(origin: string | undefined): boolean {
    // 缺失或空 Origin 一律拒绝：写请求必须由浏览器同源发起。
    if (origin === undefined || origin.trim() === '') return false;
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return this.allowedAuthorities().has(parsed.host.toLowerCase());
  }

  private loginContext(req: IncomingMessage): LoginContext {
    const forwarded = req.headers['x-forwarded-for'];
    return {
      remoteAddress: req.socket.remoteAddress,
      forwardedFor: typeof forwarded === 'string' ? forwarded : undefined,
    };
  }

  private resolveRoute(method: string, pathname: string): RouteMatch | undefined {
    const def = ROUTE_TABLE.find((route) => route.method === method && route.path === pathname);
    if (def === undefined) return undefined;
    return { def, handler: this.handlerFor(def.kind) };
  }

  private pathKnown(pathname: string): boolean {
    return ROUTE_TABLE.some((route) => route.path === pathname);
  }

  private handlerFor(kind: RouteKind): RouteHandler | undefined {
    const injected = this.opts.routeHandlers?.[kind];
    if (injected !== undefined) return injected;

    switch (kind) {
      case 'state': {
        const state = this.opts.state;
        return state === undefined ? undefined : async () => state();
      }
      case 'models':
        return asHandler(this.opts.models);
      case 'conversations':
        return asHandler(this.opts.conversations);
      case 'plan':
        return asHandler(this.opts.plan);
      case 'architecture':
        return asHandler(this.opts.architecture);
      default:
        return undefined;
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const method = (req.method ?? 'GET').toUpperCase();

    let url: URL;
    try {
      // 不能把 req.url 直接交给 new URL(url, base)：以 `//` 开头的目标会被
      // 当成协议相对 URL，主机名被改写，路径穿越检查随之失效。
      url = new URL(`http://console.invalid${req.url ?? '/'}`);
    } catch {
      sendJson(res, 400, { ok: false, code: 'bad_request' }, '/');
      return;
    }
    const pathname = url.pathname;

    res.once('finish', () => {
      this.log(
        `web: ${method} ${stripUnsafeControls(pathname)} ${res.statusCode} ${Date.now() - started}ms`,
      );
    });

    try {
      await this.dispatch(req, res, method, url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`web: request failed: ${stripUnsafeControls(message)}`);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, code: 'internal' }, pathname);
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  }

  private async dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    url: URL,
  ): Promise<void> {
    const pathname = url.pathname;

    if (!this.hostAllowed(req.headers.host)) {
      sendJson(res, 421, { ok: false, code: 'bad_host' }, pathname);
      return;
    }

    if (method === 'GET' || method === 'HEAD') {
      const asset = this.staticAssets.get(pathname);
      if (asset !== undefined) {
        res.writeHead(200, {
          ...securityHeaders(pathname),
          'content-type': asset.type,
          'content-length': asset.body.length,
          'cache-control': 'no-cache',
        });
        if (method === 'HEAD') res.end();
        else res.end(asset.body);
        return;
      }
    }

    const match = this.resolveRoute(method, pathname);
    if (match === undefined) {
      if (this.pathKnown(pathname)) {
        sendJson(res, 405, { ok: false, code: 'method_not_allowed' }, pathname);
      } else {
        sendJson(res, 404, { ok: false, code: 'not_found' }, pathname);
      }
      return;
    }

    const isWrite = method !== 'GET' && method !== 'HEAD';
    if (isWrite) {
      if (this.writesClosed) {
        sendJson(res, 503, { ok: false, code: 'shutting_down' }, pathname);
        return;
      }
      if (req.headers['x-uuharness-console'] !== '1') {
        sendJson(res, 403, { ok: false, code: 'bad_csrf' }, pathname);
        return;
      }
      if (!this.originAllowed(req.headers.origin)) {
        sendJson(res, 403, { ok: false, code: 'bad_origin' }, pathname);
        return;
      }
    }

    switch (match.def.kind) {
      case 'health':
        await this.handleHealth(req, res, url);
        return;
      case 'login':
        await this.handleLogin(req, res, pathname);
        return;
      default:
        break;
    }

    if (match.def.auth && !this.requireAuth().check(req)) {
      sendJson(res, 401, { ok: false, code: 'unauthorized' }, pathname);
      return;
    }

    let body: unknown;
    if (match.def.body !== 'none' && match.def.bodyLimit !== undefined) {
      if (!isJsonContentType(req)) {
        sendJson(res, 415, { ok: false, code: 'unsupported_media_type' }, pathname);
        return;
      }
      const read = await readJsonBody(req, match.def.bodyLimit);
      if (!read.ok) {
        if (read.code === 'too_large') {
          sendTooLarge(req, res, pathname);
        } else {
          sendJson(res, 400, { ok: false, code: 'invalid_json' }, pathname);
        }
        return;
      }
      body = read.value;
    }

    if (match.def.kind === 'logout') {
      this.requireAuth().logout(req);
      sendJson(
        res,
        200,
        { ok: true },
        pathname,
        { 'set-cookie': this.clearedCookie() },
      );
      return;
    }

    const handler = match.handler;
    if (handler === undefined) {
      sendJson(res, 501, { ok: false, code: 'not_implemented' }, pathname);
      return;
    }

    const result = await handler({
      req,
      res,
      url,
      body,
      send: (status, value) => sendJson(res, status, value, pathname),
    });
    if (res.writableEnded) return;

    if (result === undefined) sendJson(res, 200, { ok: true }, pathname);
    else sendJson(res, 200, result, pathname);
  }

  private async handleLogin(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    const auth = this.requireAuth();
    const ctx = this.loginContext(req);

    // 限速检查必须先于 body 解析与 token 比较：锁定时连请求体都不读。
    if (auth.locked(ctx)) {
      sendJson(res, 429, { ok: false, code: 'locked' }, pathname);
      return;
    }

    if (!isJsonContentType(req)) {
      sendJson(res, 415, { ok: false, code: 'unsupported_media_type' }, pathname);
      return;
    }

    const read = await readJsonBody(req, LOGIN_BODY_LIMIT);
    if (!read.ok) {
      if (read.code === 'too_large') {
        sendTooLarge(req, res, pathname);
      } else {
        sendJson(res, 400, { ok: false, code: 'invalid_json' }, pathname);
      }
      return;
    }

    const result = auth.login(read.value, ctx);
    if (result.ok) {
      sendJson(res, 200, { ok: true }, pathname, { 'set-cookie': result.cookie });
      return;
    }
    if (result.code === 'locked') {
      sendJson(res, 429, { ok: false, code: 'locked' }, pathname);
      return;
    }
    if (result.code === 'invalid_body') {
      sendJson(res, 400, { ok: false, code: 'invalid_body' }, pathname);
      return;
    }
    sendJson(res, 401, { ok: false, code: 'invalid_token' }, pathname);
  }

  private async handleHealth(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const pathname = url.pathname;
    if (url.searchParams.get('deep') !== '1') {
      sendJson(res, 200, { ok: true }, pathname);
      return;
    }

    let readiness: ReadinessSnapshot = { allDegraded: false, silentRounds: 0 };
    if (this.opts.readiness !== undefined) {
      try {
        readiness = await this.opts.readiness();
      } catch {
        // 探针故障不能把存活探针本身变成 5xx；deep 结果如实报告降级。
        readiness = { allDegraded: true, silentRounds: 0 };
      }
    }
    sendJson(
      res,
      200,
      {
        ok: !readiness.allDegraded,
        allDegraded: readiness.allDegraded,
        silentRounds: readiness.silentRounds,
      },
      pathname,
    );
  }

  private clearedCookie(): string {
    const attributes = [`${SESSION_COOKIE_NAME}=`, 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0'];
    if (this.opts.secureCookie === true) attributes.push('Secure');
    return attributes.join('; ');
  }
}

export function createWebServer(opts: WebServerOptions): WebServer {
  return new WebConsoleServer(opts);
}
