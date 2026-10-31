import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { connect, createServer as createNetServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createWebServer,
  type WebServer,
  type WebServerOptions,
} from '../../src/web/server.js';
import { startWebConsole } from '../../src/startup.js';

const STRONG_TOKEN = '0123456789abcdef0123456789abcdef';

interface Started {
  server: WebServer;
  base: string;
  port: number;
  logs: string[];
}

const servers: WebServer[] = [];

async function startServer(overrides: Partial<WebServerOptions> = {}): Promise<Started> {
  const logs: string[] = [];
  const server = createWebServer({
    host: '127.0.0.1',
    port: 0,
    token: STRONG_TOKEN,
    log: (line) => logs.push(line),
    ...overrides,
  });
  servers.push(server);
  await server.start();
  const port = server.port();
  return { server, base: `http://127.0.0.1:${port}`, port, logs };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.stop();
  }
});

/** 写请求必须带同源 Origin；测试客户端按真实浏览器行为发送。 */
function originOf(base: string): string {
  return new URL(base).origin;
}

function jsonHeaders(base: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-uuharness-console': '1',
    origin: originOf(base),
  };
}

async function login(base: string, token = STRONG_TOKEN): Promise<Response> {
  return fetch(`${base}/api/login`, {
    method: 'POST',
    headers: jsonHeaders(base),
    body: JSON.stringify({ token }),
  });
}

function setCookieOf(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const list = headers.getSetCookie?.() ?? [];
  const raw = list[0] ?? response.headers.get('set-cookie') ?? '';
  return raw.split(';')[0] ?? '';
}

async function loginCookie(base: string): Promise<string> {
  const response = await login(base);
  expect(response.status).toBe(200);
  return setCookieOf(response);
}

interface RawResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function rawRequest(
  port: number,
  options: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path,
        headers: options.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met within timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 让内核分配一个空闲端口再释放，供 startWebConsole（只接受显式端口）使用。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

describe('startup validation', () => {
  it('refuses to start with a short token', async () => {
    const server = createWebServer({
      host: '127.0.0.1',
      port: 0,
      token: 'too-short',
      log: () => {},
    });
    servers.push(server);
    await expect(server.start()).rejects.toThrow(/at least 32/);
  });

  it('refuses to start with the .env.example placeholder token', async () => {
    const server = createWebServer({
      host: '127.0.0.1',
      port: 0,
      token: 'change-me'.repeat(5),
      log: () => {},
    });
    servers.push(server);
    await expect(server.start()).rejects.toThrow(/placeholder/);
  });

  it('refuses to bind a non-loopback host without allowRemote', async () => {
    const server = createWebServer({
      host: '0.0.0.0',
      port: 0,
      token: STRONG_TOKEN,
      log: () => {},
    });
    servers.push(server);
    await expect(server.start()).rejects.toThrow(/WEB_ALLOW_REMOTE/);
  });

  it('binds the requested loopback port and reports it', async () => {
    const { server, port } = await startServer();
    expect(port).toBeGreaterThan(0);
    expect(server.port()).toBe(port);
    await server.stop();
    await server.stop();
  });
});

describe('health', () => {
  it('answers 200 without a session and is never cached', async () => {
    const { base } = await startServer();
    const response = await fetch(`${base}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('returns readiness for ?deep=1', async () => {
    const { base } = await startServer({
      readiness: () => ({ allDegraded: true, silentRounds: 4 }),
    });
    const response = await fetch(`${base}/api/health?deep=1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      allDegraded: true,
      silentRounds: 4,
    });
  });

  it('keeps answering when the readiness probe throws', async () => {
    const { base } = await startServer({
      readiness: () => {
        throw new Error('probe exploded');
      },
    });
    const response = await fetch(`${base}/api/health?deep=1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, allDegraded: true, silentRounds: 0 });
  });

  it('wires startWebConsole readiness into the deep probe', async () => {
    const port = await freePort();
    const server = await startWebConsole({
      env: {
        WEB_HOST: '127.0.0.1',
        WEB_PORT: String(port),
        WEB_CONSOLE_TOKEN: STRONG_TOKEN,
      },
      log: () => {},
      readiness: () => ({ allDegraded: true, silentRounds: 7 }),
    });
    servers.push(server);
    const response = await fetch(`http://127.0.0.1:${server.port()}/api/health?deep=1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, allDegraded: true, silentRounds: 7 });
  });
});

describe('security headers', () => {
  it('applies CSP, nosniff and referrer policy to every response', async () => {
    const { base } = await startServer();
    const response = await fetch(`${base}/api/health`);
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('applies them to static assets and 404s as well', async () => {
    const { base } = await startServer();
    for (const path of ['/', '/app.js', '/style.css', '/missing']) {
      const response = await fetch(`${base}${path}`);
      expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });
});

describe('static assets', () => {
  it('serves the whitelisted shell files', async () => {
    const { base } = await startServer();
    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toContain('text/html');

    const app = await fetch(`${base}/app.js`);
    expect(app.status).toBe(200);
    expect(app.headers.get('content-type')).toContain('javascript');

    const css = await fetch(`${base}/style.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
  });

  it('404s anything outside the whitelist', async () => {
    const { base } = await startServer();
    for (const path of ['/index.html', '/../.env', '/static/index.html', '/favicon.ico']) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(404);
    }
  });

  it('rejects traversal attempts without reading files outside the static root', async () => {
    const { port, base } = await startServer();
    const attempts = ['/../.env', '/..%2f.env', '/..%5c.env', '/%2e%2e/.env', '//etc/passwd'];
    for (const path of attempts) {
      const result = await rawRequest(port, { path });
      expect(result.status).toBe(404);
      expect(result.body).not.toContain('NIM_API_KEYS');
    }
    const alive = await fetch(`${base}/api/health`);
    expect(alive.status).toBe(200);
  });
});

describe('authentication', () => {
  it('401s protected APIs without a session cookie', async () => {
    const { base } = await startServer();
    const response = await fetch(`${base}/api/state`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, code: 'unauthorized' });
  });

  it('401s a wrong token', async () => {
    const { base } = await startServer();
    const response = await login(base, 'f'.repeat(32));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, code: 'invalid_token' });
  });

  it('sets a hardened session cookie on success', async () => {
    const { base } = await startServer();
    const response = await login(base);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const raw = headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie') ?? '';
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Strict');
    expect(raw).toContain('Path=/');
    expect(raw).not.toContain('Secure');
  });

  it('serves the injected state handler once authenticated', async () => {
    const { base } = await startServer({
      state: async () => ({ endpoints: [], silentRounds: 2 }),
    });
    const cookie = await loginCookie(base);
    const response = await fetch(`${base}/api/state`, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ endpoints: [], silentRounds: 2 });
  });

  it('returns 501 when no state handler is mounted yet', async () => {
    const { base } = await startServer();
    const cookie = await loginCookie(base);
    const response = await fetch(`${base}/api/state`, { headers: { cookie } });
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ ok: false, code: 'not_implemented' });
  });

  it('invalidates the cookie server-side on logout', async () => {
    const { base } = await startServer({
      state: async () => ({ endpoints: [] }),
    });
    const cookie = await loginCookie(base);
    // logout 允许无 body、无 Content-Type，只保留 CSRF 头 + Origin。
    const logout = await fetch(`${base}/api/logout`, {
      method: 'POST',
      headers: { 'x-uuharness-console': '1', origin: originOf(base), cookie },
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');

    const after = await fetch(`${base}/api/state`, { headers: { cookie } });
    expect(after.status).toBe(401);
  });

  it('marks the cookie Secure when configured', async () => {
    const { base } = await startServer({ secureCookie: true });
    const response = await login(base);
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const raw = headers.getSetCookie?.()[0] ?? '';
    expect(raw).toContain('; Secure');
  });
});

describe('login rate limiting', () => {
  it('returns 429 on the sixth attempt even with the right token', async () => {
    const { base } = await startServer();
    for (let i = 0; i < 5; i += 1) {
      const response = await login(base, 'f'.repeat(32));
      expect(response.status).toBe(401);
    }
    const locked = await login(base);
    expect(locked.status).toBe(429);
    expect(await locked.json()).toEqual({ ok: false, code: 'locked' });
  });

  it('ignores spoofed X-Forwarded-For without a trusted proxy', async () => {
    const { base } = await startServer();
    for (let i = 0; i < 5; i += 1) {
      const response = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { ...jsonHeaders(base), 'x-forwarded-for': `10.0.0.${i}` },
        body: JSON.stringify({ token: 'f'.repeat(32) }),
      });
      expect(response.status).toBe(401);
    }
    const response = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { ...jsonHeaders(base), 'x-forwarded-for': '10.0.0.99' },
      body: JSON.stringify({ token: STRONG_TOKEN }),
    });
    expect(response.status).toBe(429);
  });
});

describe('host and CSRF checks', () => {
  it('421s a Host header outside the allowlist', async () => {
    const { port } = await startServer();
    const result = await rawRequest(port, {
      path: '/api/health',
      headers: { host: 'evil.example' },
    });
    expect(result.status).toBe(421);
    expect(JSON.parse(result.body)).toEqual({ ok: false, code: 'bad_host' });
  });

  it('accepts the localhost and IPv6 loopback host forms', async () => {
    const { port } = await startServer();
    for (const host of [`localhost:${port}`, `[::1]:${port}`]) {
      const result = await rawRequest(port, { path: '/api/health', headers: { host } });
      expect(result.status).toBe(200);
    }
  });

  it('403s a write request without the console header', async () => {
    const { base } = await startServer();
    const cookie = await loginCookie(base);
    const response = await fetch(`${base}/api/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '{}',
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, code: 'bad_csrf' });
  });

  it('403s a write request with a foreign Origin', async () => {
    const { port } = await startServer();
    const result = await rawRequest(port, {
      method: 'POST',
      path: '/api/login',
      headers: {
        ...jsonHeaders(`http://127.0.0.1:${port}`),
        origin: 'http://evil.example',
        'content-length': String(JSON.stringify({ token: STRONG_TOKEN }).length),
      },
      body: JSON.stringify({ token: STRONG_TOKEN }),
    });
    expect(result.status).toBe(403);
    expect(JSON.parse(result.body)).toEqual({ ok: false, code: 'bad_origin' });
  });

  it('allows a same-origin Origin from the configured host', async () => {
    const { port } = await startServer();
    const body = JSON.stringify({ token: STRONG_TOKEN });
    const result = await rawRequest(port, {
      method: 'POST',
      path: '/api/login',
      headers: {
        ...jsonHeaders(`http://127.0.0.1:${port}`),
        'content-length': String(body.length),
      },
      body,
    });
    expect(result.status).toBe(200);
  });

  it('403s a write request with no Origin and keeps the session valid', async () => {
    const { port, base } = await startServer({
      state: async () => ({ ok: true }),
    });
    const cookie = await loginCookie(base);
    const result = await rawRequest(port, {
      method: 'POST',
      path: '/api/logout',
      headers: { 'x-uuharness-console': '1', cookie },
    });
    expect(result.status).toBe(403);
    expect(JSON.parse(result.body)).toEqual({ ok: false, code: 'bad_origin' });

    // Origin 校验失败不能顺带注销会话。
    const after = await fetch(`${base}/api/state`, { headers: { cookie } });
    expect(after.status).toBe(200);
  });

  it('accepts extra Host and Origin authorities from allowedHosts', async () => {
    const { port } = await startServer({ allowedHosts: ['console.example.test'] });
    const health = await rawRequest(port, {
      path: '/api/health',
      headers: { host: 'console.example.test' },
    });
    expect(health.status).toBe(200);

    const body = JSON.stringify({ token: STRONG_TOKEN });
    const login = await rawRequest(port, {
      method: 'POST',
      path: '/api/login',
      headers: {
        host: 'console.example.test',
        'content-type': 'application/json',
        'x-uuharness-console': '1',
        origin: 'http://console.example.test',
        'content-length': String(body.length),
      },
      body,
    });
    expect(login.status).toBe(200);
  });
});

describe('body limits and content type', () => {
  it('413s an oversized login body and keeps serving', async () => {
    const { base } = await startServer();
    const response = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: jsonHeaders(base),
      body: JSON.stringify({ token: 'x'.repeat(9000) }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ ok: false, code: 'payload_too_large' });

    const alive = await fetch(`${base}/api/health`);
    expect(alive.status).toBe(200);
  });

  it('413s an oversized body on other write routes', async () => {
    const { base } = await startServer({ models: async () => ({ ok: true }) });
    const cookie = await loginCookie(base);
    const response = await fetch(`${base}/api/models`, {
      method: 'PUT',
      headers: { ...jsonHeaders(base), cookie },
      body: JSON.stringify({ pad: 'x'.repeat(70_000) }),
    });
    expect(response.status).toBe(413);
  });

  it('415s a write request without a JSON content type', async () => {
    const { base } = await startServer();
    const response = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-uuharness-console': '1', origin: originOf(base) },
      body: JSON.stringify({ token: STRONG_TOKEN }),
    });
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ ok: false, code: 'unsupported_media_type' });
  });

  it('400s malformed JSON', async () => {
    const { base } = await startServer();
    const response = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: jsonHeaders(base),
      body: '{not json',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, code: 'invalid_json' });
  });
});

describe('routing', () => {
  it('404s unknown API paths and 405s wrong methods', async () => {
    const { base } = await startServer();
    const missing = await fetch(`${base}/api/nope`);
    expect(missing.status).toBe(404);

    const wrongMethod = await fetch(`${base}/api/state`, { method: 'DELETE' });
    expect(wrongMethod.status).toBe(405);
  });

  it('mounts injected route handlers without restructuring', async () => {
    const { base } = await startServer({
      routeHandlers: {
        plan: () => ({ ok: true, plan: null }),
      },
    });
    const cookie = await loginCookie(base);
    const response = await fetch(`${base}/api/plan`, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, plan: null });
  });

  it('answers 501 for unmounted future routes', async () => {
    const { base } = await startServer();
    const cookie = await loginCookie(base);
    const response = await fetch(`${base}/api/conversations`, { headers: { cookie } });
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ ok: false, code: 'not_implemented' });
  });
});

describe('connection hardening', () => {
  it('destroys sockets that attempt an HTTP upgrade', async () => {
    const { port } = await startServer();
    const received = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port }, () => {
        socket.write(
          `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
        );
      });
      let data = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        data += chunk;
      });
      socket.on('error', reject);
      socket.on('close', () => resolve(data));
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('upgrade socket was not closed'));
      }, 2000);
      timer.unref();
      socket.on('close', () => clearTimeout(timer));
    });
    expect(received).not.toContain('101');
  });

  it('logs method, path, status and duration without query strings', async () => {
    const { base, logs } = await startServer();
    await fetch(`${base}/api/health?token=secret-value`);
    await waitUntil(() => logs.some((line) => line.includes('/api/health')));
    const line = logs.find((entry) => entry.includes('/api/health')) ?? '';
    expect(line).toMatch(/GET \/api\/health 200 \d+ms/);
    expect(line).not.toContain('secret-value');
  });
});

describe('shutdown gating', () => {
  it('rejects writes with 503 after stopAcceptingWrites while reads keep working', async () => {
    const { server, base } = await startServer();
    const cookie = await loginCookie(base);

    server.stopAcceptingWrites();

    const write = await fetch(`${base}/api/models`, {
      method: 'PUT',
      headers: { ...jsonHeaders(base), cookie },
      body: JSON.stringify({ version: 1, endpoints: [] }),
    });
    expect(write.status).toBe(503);
    expect(await write.json()).toEqual({ ok: false, code: 'shutting_down' });

    const read = await fetch(`${base}/api/health`);
    expect(read.status).toBe(200);
  });
});
