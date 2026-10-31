/**
 * 网页管理台的认证与会话。
 *
 * - token 强度在启动时校验：长度 ≥ 32 且不是 `.env.example` 占位值。
 * - 比较用 `timingSafeEqual`，两端 `trim()`，长度不同直接失败（长度不是秘密）。
 * - 会话只存在进程内存：harness 重启即全部失效（前端对此有明确提示）。
 * - 登录失败按来源地址指数锁定；锁定期间统一返回 locked，不泄露 token 是否正确。
 *
 * 限速键默认只认 TCP 对端地址；只有显式信任反代（`WEB_TRUSTED_PROXY`）时才取
 * `X-Forwarded-For` 的最后一跳——否则任何客户端都能伪造该头绕过锁定。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { normalizeRemoteAddress, parseCookie } from './http-util.js';

export const SESSION_COOKIE_NAME = 'uuh_session';

export const TOKEN_MIN_LENGTH = 32;

export const TOKEN_GENERATE_COMMAND =
  'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"';

/** 绝对过期：登录后 7 天，无论是否活跃。 */
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
/** 空闲过期：12 小时无请求。 */
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
/** 同时存活的会话上限；登录时先清扫过期项，仍满则淘汰最久未用。 */
export const MAX_SESSIONS = 32;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** 5 次/1 分钟。 */
const LOCK_FAST_FAILURES = 5;
/** 10 次/1 小时。 */
const LOCK_SLOW_FAILURES = 10;
/** 20 次后锁定到进程重启。 */
const LOCK_PERMANENT_FAILURES = 20;

/** `.env.example` 占位值的判定：精确匹配或包含常见占位片段。 */
const PLACEHOLDER_TOKENS: ReadonlySet<string> = new Set([
  'change-me',
  'changeme',
  'change-me-please',
  'replace-me',
  'your-token-here',
  'your_token_here',
  'web_console_token',
  'dev-token',
  'secret',
  'replace-with-a-32-byte-random-token',
  'replace-with-32-byte-random-token',
  'replace-with-32-random-bytes-base64url',
]);

const PLACEHOLDER_MARKERS: readonly string[] = [
  'change-me',
  'changeme',
  'replace-me',
  'replace-with',
  'replace_with',
  'your-token-here',
  'your_token_here',
  'placeholder',
];

export type TokenStrength =
  | { ok: true }
  | { ok: false; reason: 'too_short' | 'placeholder' };

export function checkTokenStrength(token: string): TokenStrength {
  const trimmed = token.trim();
  if (trimmed.length < TOKEN_MIN_LENGTH) return { ok: false, reason: 'too_short' };

  const lowered = trimmed.toLowerCase();
  if (PLACEHOLDER_TOKENS.has(lowered)) return { ok: false, reason: 'placeholder' };
  if (PLACEHOLDER_MARKERS.some((marker) => lowered.includes(marker))) {
    return { ok: false, reason: 'placeholder' };
  }
  return { ok: true };
}

export interface LoginContext {
  /** TCP 对端地址（`req.socket.remoteAddress`）。 */
  remoteAddress?: string | undefined;
  /** 原始 `X-Forwarded-For` 头；仅在 trustedProxy 时使用。 */
  forwardedFor?: string | undefined;
}

export type LoginResult =
  | { ok: true; cookie: string }
  | { ok: false; code: 'invalid_token' | 'invalid_body' | 'locked' };

export interface AuthOptions {
  secureCookie?: boolean;
  now?: () => number;
  trustedProxy?: boolean;
}

export interface Auth {
  login(body: unknown, ctx?: LoginContext): LoginResult;
  check(req: IncomingMessage): boolean;
  logout(req: IncomingMessage): void;
  locked(ctx?: LoginContext): boolean;
  reset(): void;
}

interface Session {
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

interface RateEntry {
  /** 最近一小时内失败的时间戳；用于滑动窗口判定。 */
  recent: number[];
  /** 累计失败次数；用于「锁定到进程重启」这一档。 */
  total: number;
}

export function createAuth(token: string, options: AuthOptions = {}): Auth {
  const strength = checkTokenStrength(token);
  if (!strength.ok) {
    throw new Error(
      strength.reason === 'too_short'
        ? `WEB_CONSOLE_TOKEN must be at least ${TOKEN_MIN_LENGTH} characters; generate one with: ${TOKEN_GENERATE_COMMAND}`
        : `WEB_CONSOLE_TOKEN is a placeholder value; generate one with: ${TOKEN_GENERATE_COMMAND}`,
    );
  }

  const expected = Buffer.from(token.trim());
  const secureCookie = options.secureCookie ?? false;
  const trustedProxy = options.trustedProxy ?? false;
  const now = options.now ?? Date.now;

  const sessions = new Map<string, Session>();
  const failures = new Map<string, RateEntry>();

  function keyFor(ctx: LoginContext | undefined): string {
    if (trustedProxy && ctx?.forwardedFor !== undefined) {
      const hop = ctx.forwardedFor.split(',').at(-1)?.trim() ?? '';
      if (hop !== '') return `xff:${hop}`;
    }
    const address = normalizeRemoteAddress(ctx?.remoteAddress);
    return address === '' ? 'unknown' : `addr:${address}`;
  }

  function lockUntil(key: string, at: number): number {
    const entry = failures.get(key);
    if (entry === undefined) return 0;
    if (entry.total >= LOCK_PERMANENT_FAILURES) return Number.POSITIVE_INFINITY;

    entry.recent = entry.recent.filter((stamp) => at - stamp < HOUR_MS);

    if (entry.recent.length >= LOCK_SLOW_FAILURES) {
      return (entry.recent.at(-1) ?? at) + HOUR_MS;
    }
    const lastMinute = entry.recent.filter((stamp) => at - stamp < MINUTE_MS);
    if (lastMinute.length >= LOCK_FAST_FAILURES) {
      return (lastMinute.at(-1) ?? at) + MINUTE_MS;
    }
    return 0;
  }

  function isLocked(key: string, at: number): boolean {
    return lockUntil(key, at) > at;
  }

  function recordFailure(key: string, at: number): void {
    const entry = failures.get(key) ?? { recent: [], total: 0 };
    entry.recent.push(at);
    entry.total += 1;
    // 只保留一小时窗口，避免无限增长；total 单独计数以支撑永久锁定档。
    entry.recent = entry.recent.filter((stamp) => at - stamp < HOUR_MS);
    failures.set(key, entry);
  }

  function sessionCookie(sessionId: string): string {
    const attributes = [`${SESSION_COOKIE_NAME}=${sessionId}`, 'HttpOnly', 'SameSite=Strict', 'Path=/'];
    if (secureCookie) attributes.push('Secure');
    return attributes.join('; ');
  }

  function sweep(at: number): void {
    for (const [id, session] of sessions) {
      if (at >= session.expiresAt || at - session.lastSeenAt >= SESSION_IDLE_MS) {
        sessions.delete(id);
      }
    }
  }

  function evictOldest(): void {
    let oldestId: string | undefined;
    let oldestSeen = Number.POSITIVE_INFINITY;
    for (const [id, session] of sessions) {
      if (session.lastSeenAt < oldestSeen) {
        oldestSeen = session.lastSeenAt;
        oldestId = id;
      }
    }
    if (oldestId !== undefined) sessions.delete(oldestId);
  }

  function tokenMatches(candidate: string): boolean {
    const actual = Buffer.from(candidate.trim());
    // timingSafeEqual 要求等长；长度本身不是秘密。
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  }

  return {
    login(body, ctx) {
      const at = now();
      const key = keyFor(ctx);

      if (isLocked(key, at)) return { ok: false, code: 'locked' };

      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        recordFailure(key, at);
        return { ok: false, code: 'invalid_body' };
      }
      const candidate = (body as Record<string, unknown>)['token'];
      if (typeof candidate !== 'string') {
        recordFailure(key, at);
        return { ok: false, code: 'invalid_body' };
      }

      if (!tokenMatches(candidate)) {
        recordFailure(key, at);
        return { ok: false, code: 'invalid_token' };
      }

      // 成功登录清除该地址的失败计数，避免用户被自己的历史拼写错误锁死。
      failures.delete(key);

      sweep(at);
      if (sessions.size >= MAX_SESSIONS) evictOldest();

      const id = randomBytes(32).toString('base64url');
      sessions.set(id, {
        createdAt: at,
        lastSeenAt: at,
        expiresAt: at + SESSION_ABSOLUTE_MS,
      });
      return { ok: true, cookie: sessionCookie(id) };
    },

    check(req) {
      const id = parseCookie(req.headers.cookie).get(SESSION_COOKIE_NAME);
      if (id === undefined) return false;

      const session = sessions.get(id);
      if (session === undefined) return false;

      const at = now();
      if (at >= session.expiresAt || at - session.lastSeenAt >= SESSION_IDLE_MS) {
        sessions.delete(id);
        return false;
      }
      session.lastSeenAt = at;
      return true;
    },

    logout(req) {
      const id = parseCookie(req.headers.cookie).get(SESSION_COOKIE_NAME);
      if (id !== undefined) sessions.delete(id);
    },

    locked(ctx) {
      return isLocked(keyFor(ctx), now());
    },

    reset() {
      sessions.clear();
      failures.clear();
    },
  };
}
