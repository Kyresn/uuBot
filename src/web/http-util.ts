/**
 * 网页服务的 HTTP 基础件：安全头、JSON 响应、受限请求体读取、cookie 解析与地址归一化。
 *
 * 所有响应都必须经过本模块生成头部，保证安全头不会在某条错误分支上漏掉。
 * 安全不变量：CSP 禁止一切外部资源与内联脚本；API 响应禁止缓存。
 */
import { isIP } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** 所有响应共用的安全头；`/api/*` 额外禁止缓存。 */
export function securityHeaders(pathname: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-security-policy': CONTENT_SECURITY_POLICY,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    headers['cache-control'] = 'no-store';
  }
  return headers;
}

/** 发送 JSON 响应；序列化失败时降级为 500，绝不把内部对象打到线上。 */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  pathname: string,
  extraHeaders: Record<string, string> = {},
): void {
  if (res.writableEnded) return;

  let payload: string;
  let effectiveStatus = status;
  try {
    payload = JSON.stringify(body) ?? 'null';
  } catch {
    effectiveStatus = 500;
    payload = '{"ok":false,"code":"internal"}';
  }

  res.writeHead(effectiveStatus, {
    ...securityHeaders(pathname),
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

/**
 * 超限响应：先让客户端读到 413，再销毁请求。
 * 直接 `req.destroy()` 会在响应刷出前断开连接，客户端只能看到网络错误。
 */
export function sendTooLarge(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): void {
  const payload = '{"ok":false,"code":"payload_too_large"}';
  if (res.headersSent || res.writableEnded) {
    req.destroy();
    return;
  }

  res.writeHead(413, {
    ...securityHeaders(pathname),
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    connection: 'close',
  });
  res.end(payload, () => {
    // 响应刷出后留一个极短的宽限期再销毁：客户端可能仍在写超限 body，
    // 立刻 RST 会让它看不到 413。宽限期不读数据，超限上传依旧被切断。
    const timer = setTimeout(() => req.destroy(), 50);
    timer.unref();
  });
}

export type ReadBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; code: 'too_large' | 'invalid_json' | 'empty' | 'aborted' };

/**
 * 读取 JSON 请求体，硬上限 `limit` 字节。
 * 先看 Content-Length（可提前拒绝），再在流式读取时累计，二者都不可绕过。
 */
export function readJsonBody(req: IncomingMessage, limit: number): Promise<ReadBodyResult> {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      resolve({ ok: false, code: 'too_large' });
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const settle = (result: ReadBodyResult): void => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      resolve(result);
    };

    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        req.pause();
        settle({ ok: false, code: 'too_large' });
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = (): void => {
      if (size === 0) {
        settle({ ok: false, code: 'empty' });
        return;
      }
      try {
        settle({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch {
        settle({ ok: false, code: 'invalid_json' });
      }
    };

    const onError = (): void => settle({ ok: false, code: 'aborted' });

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/** 只接受 `application/json`（允许 charset 参数）。 */
export function isJsonContentType(req: IncomingMessage): boolean {
  const raw = req.headers['content-type'];
  if (typeof raw !== 'string') return false;
  return /^application\/json\s*(?:;|$)/i.test(raw.trim());
}

/** 解析 Cookie 头；只做最小必要解析，不引入依赖。 */
export function parseCookie(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (header === undefined) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name === '') continue;
    cookies.set(name, value);
  }
  return cookies;
}

/** `::ffff:127.0.0.1` 与 `127.0.0.1` 必须落到同一个限速键。 */
export function normalizeRemoteAddress(address: string | undefined): string {
  if (address === undefined) return '';
  let value = address.trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  if (value.startsWith('::ffff:') && value.includes('.')) {
    value = value.slice('::ffff:'.length);
  }
  return value;
}

/** 只有 loopback 才能免 `WEB_ALLOW_REMOTE` 启动。 */
export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (value === 'localhost' || value === '::1') return true;
  return isIP(value) === 4 && value.startsWith('127.');
}
