import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  checkTokenStrength,
  createAuth,
  MAX_SESSIONS,
  SESSION_ABSOLUTE_MS,
  SESSION_COOKIE_NAME,
  SESSION_IDLE_MS,
  TOKEN_MIN_LENGTH,
  type LoginContext,
} from '../../src/web/auth.js';

const STRONG_TOKEN = '0123456789abcdef0123456789abcdef';

const LOCAL: LoginContext = { remoteAddress: '127.0.0.1' };

function fakeReq(cookie?: string): IncomingMessage {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers['cookie'] = cookie;
  return { headers } as unknown as IncomingMessage;
}

function sessionId(cookie: string): string {
  const first = cookie.split(';')[0] ?? '';
  return first.slice(SESSION_COOKIE_NAME.length + 1);
}

function cookieHeader(cookie: string): string {
  return cookie.split(';')[0] ?? '';
}

describe('checkTokenStrength', () => {
  it('rejects tokens shorter than the minimum length', () => {
    expect(checkTokenStrength('a'.repeat(TOKEN_MIN_LENGTH - 1))).toEqual({
      ok: false,
      reason: 'too_short',
    });
    expect(checkTokenStrength('')).toEqual({ ok: false, reason: 'too_short' });
  });

  it('accepts a random token of exactly the minimum length', () => {
    expect(checkTokenStrength('a'.repeat(TOKEN_MIN_LENGTH))).toEqual({ ok: true });
    expect(checkTokenStrength(STRONG_TOKEN)).toEqual({ ok: true });
  });

  it('rejects .env.example style placeholders even when long enough', () => {
    expect(checkTokenStrength('change-me'.repeat(5))).toEqual({
      ok: false,
      reason: 'placeholder',
    });
    expect(checkTokenStrength('replace-with-a-32-byte-random-token')).toEqual({
      ok: false,
      reason: 'placeholder',
    });
    expect(checkTokenStrength('YOUR_TOKEN_HERE_PLEASE_REPLACE_ME')).toEqual({
      ok: false,
      reason: 'placeholder',
    });
  });
});

describe('createAuth', () => {
  it('refuses weak tokens at construction time', () => {
    expect(() => createAuth('short')).toThrow(/at least 32/);
    expect(() => createAuth('change-me'.repeat(5))).toThrow(/placeholder/);
  });

  it('issues a session cookie with the hardening attributes', () => {
    const auth = createAuth(STRONG_TOKEN);
    const result = auth.login({ token: STRONG_TOKEN }, LOCAL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.cookie).toMatch(
      /^uuh_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/$/,
    );
    expect(result.cookie).not.toContain('Secure');
    expect(auth.check(fakeReq(cookieHeader(result.cookie)))).toBe(true);
  });

  it('adds Secure when the cookie is configured for TLS', () => {
    const auth = createAuth(STRONG_TOKEN, { secureCookie: true });
    const result = auth.login({ token: STRONG_TOKEN }, LOCAL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cookie).toContain('; Secure');
  });

  it('trims both sides before comparing', () => {
    const auth = createAuth(`  ${STRONG_TOKEN}  `);
    expect(auth.login({ token: `\n${STRONG_TOKEN}\t` }, LOCAL)).toEqual({
      ok: true,
      cookie: expect.stringContaining(SESSION_COOKIE_NAME),
    });
  });

  it('rejects a wrong token without creating a session', () => {
    const auth = createAuth(STRONG_TOKEN);
    const result = auth.login({ token: 'f'.repeat(32) }, LOCAL);
    expect(result).toEqual({ ok: false, code: 'invalid_token' });
  });

  it('rejects a malformed login body', () => {
    const auth = createAuth(STRONG_TOKEN);
    expect(auth.login(null, LOCAL)).toEqual({ ok: false, code: 'invalid_body' });
    expect(auth.login({ token: 42 }, LOCAL)).toEqual({ ok: false, code: 'invalid_body' });
  });

  it('invalidates the session on the server after logout', () => {
    const auth = createAuth(STRONG_TOKEN);
    const result = auth.login({ token: STRONG_TOKEN }, LOCAL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const req = fakeReq(cookieHeader(result.cookie));
    expect(auth.check(req)).toBe(true);
    auth.logout(req);
    expect(auth.check(req)).toBe(false);
  });

  it('rejects a cookie that was never issued', () => {
    const auth = createAuth(STRONG_TOKEN);
    expect(auth.check(fakeReq(`${SESSION_COOKIE_NAME}=not-a-real-session`))).toBe(false);
    expect(auth.check(fakeReq())).toBe(false);
  });

  it('expires sessions after the idle window', () => {
    let now = 1_000_000;
    const auth = createAuth(STRONG_TOKEN, { now: () => now });
    const result = auth.login({ token: STRONG_TOKEN }, LOCAL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const req = fakeReq(cookieHeader(result.cookie));

    now += SESSION_IDLE_MS - 1;
    expect(auth.check(req)).toBe(true);
    // check() 会刷新空闲计时，所以再等满一个空闲窗口才会过期。
    now += SESSION_IDLE_MS;
    expect(auth.check(req)).toBe(false);
  });

  it('expires sessions after the absolute window even when active', () => {
    let now = 1_000_000;
    const auth = createAuth(STRONG_TOKEN, { now: () => now });
    const result = auth.login({ token: STRONG_TOKEN }, LOCAL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const req = fakeReq(cookieHeader(result.cookie));

    const steps = Math.floor((SESSION_ABSOLUTE_MS - 1) / (SESSION_IDLE_MS - 1));
    for (let step = 0; step < steps; step += 1) {
      now += SESSION_IDLE_MS - 1;
      expect(auth.check(req)).toBe(true);
    }
    now = 1_000_000 + SESSION_ABSOLUTE_MS;
    expect(auth.check(req)).toBe(false);
  });

  it(`caps live sessions at ${MAX_SESSIONS} and evicts the oldest`, () => {
    let now = 5_000_000;
    const auth = createAuth(STRONG_TOKEN, { now: () => now });
    let firstCookie = '';
    let lastCookie = '';
    for (let i = 0; i < MAX_SESSIONS; i += 1) {
      now += 1;
      const result = auth.login({ token: STRONG_TOKEN }, LOCAL);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      if (i === 0) firstCookie = result.cookie;
      lastCookie = result.cookie;
    }

    now += 1;
    const extra = auth.login({ token: STRONG_TOKEN }, LOCAL);
    expect(extra.ok).toBe(true);
    expect(auth.check(fakeReq(cookieHeader(firstCookie)))).toBe(false);
    expect(auth.check(fakeReq(cookieHeader(lastCookie)))).toBe(true);
  });

  it('sweeps expired sessions on login so the cap is not consumed by them', () => {
    let now = 9_000_000;
    const auth = createAuth(STRONG_TOKEN, { now: () => now });
    for (let i = 0; i < MAX_SESSIONS; i += 1) {
      expect(auth.login({ token: STRONG_TOKEN }, LOCAL).ok).toBe(true);
    }
    now += SESSION_ABSOLUTE_MS + 1;
    const result = auth.login({ token: STRONG_TOKEN }, LOCAL);
    expect(result.ok).toBe(true);
  });

  it('locks an address after 5 failures in a minute and hides token correctness', () => {
    let now = 1_000_000;
    const auth = createAuth(STRONG_TOKEN, { now: () => now });
    for (let i = 0; i < 5; i += 1) {
      expect(auth.login({ token: 'bad'.repeat(11) }, LOCAL)).toEqual({
        ok: false,
        code: 'invalid_token',
      });
      now += 1;
    }

    expect(auth.locked(LOCAL)).toBe(true);
    expect(auth.login({ token: STRONG_TOKEN }, LOCAL)).toEqual({ ok: false, code: 'locked' });

    now += 60_001;
    expect(auth.locked(LOCAL)).toBe(false);
    expect(auth.login({ token: STRONG_TOKEN }, LOCAL).ok).toBe(true);
  });

  it('escalates to an hour lock at 10 failures in an hour', () => {
    let now = 2_000_000;
    const auth = createAuth(STRONG_TOKEN, { now: () => now });
    for (let i = 0; i < 5; i += 1) auth.login({ token: 'bad'.repeat(11) }, LOCAL);
    now += 60_001;
    for (let i = 0; i < 4; i += 1) {
      now += 1;
      expect(auth.login({ token: 'bad'.repeat(11) }, LOCAL)).toEqual({
        ok: false,
        code: 'invalid_token',
      });
    }
    now += 1;
    expect(auth.login({ token: 'bad'.repeat(11) }, LOCAL)).toEqual({
      ok: false,
      code: 'invalid_token',
    });
    expect(auth.locked(LOCAL)).toBe(true);

    now += 60_001;
    expect(auth.locked(LOCAL)).toBe(true);
    now += 60 * 60 * 1000;
    expect(auth.locked(LOCAL)).toBe(false);
  });

  it('locks until process restart at 20 failures', () => {
    let now = 3_000_000;
    const auth = createAuth(STRONG_TOKEN, { now: () => now });
    const fail = (): void => {
      now += 1;
      auth.login({ token: 'bad'.repeat(11) }, LOCAL);
    };

    for (let i = 0; i < 5; i += 1) fail();
    now += 60_001;
    for (let i = 0; i < 5; i += 1) fail();
    now += 60 * 60 * 1000 + 1;
    for (let i = 0; i < 5; i += 1) fail();
    now += 60_001;
    for (let i = 0; i < 5; i += 1) fail();

    expect(auth.locked(LOCAL)).toBe(true);
    now += SESSION_ABSOLUTE_MS * 52;
    expect(auth.locked(LOCAL)).toBe(true);
    expect(auth.login({ token: STRONG_TOKEN }, LOCAL)).toEqual({ ok: false, code: 'locked' });
  });

  it('ignores X-Forwarded-For unless a trusted proxy is configured', () => {
    const auth = createAuth(STRONG_TOKEN);
    for (let i = 0; i < 5; i += 1) {
      auth.login(
        { token: 'bad'.repeat(11) },
        { remoteAddress: '127.0.0.1', forwardedFor: `10.0.0.${i}` },
      );
    }
    expect(auth.locked({ remoteAddress: '127.0.0.1', forwardedFor: '10.0.0.99' })).toBe(true);
  });

  it('uses the last X-Forwarded-For hop when the proxy is trusted', () => {
    const auth = createAuth(STRONG_TOKEN, { trustedProxy: true });
    for (let i = 0; i < 5; i += 1) {
      auth.login(
        { token: 'bad'.repeat(11) },
        { remoteAddress: '127.0.0.1', forwardedFor: `10.0.0.${i}, 203.0.113.7` },
      );
    }
    expect(auth.locked({ remoteAddress: '127.0.0.1', forwardedFor: '198.51.100.2' })).toBe(false);
    expect(
      auth.locked({ remoteAddress: '127.0.0.1', forwardedFor: '198.51.100.2, 203.0.113.7' }),
    ).toBe(true);
  });

  it('normalizes IPv4-mapped IPv6 addresses', () => {
    const auth = createAuth(STRONG_TOKEN);
    for (let i = 0; i < 5; i += 1) {
      auth.login({ token: 'bad'.repeat(11) }, { remoteAddress: '::ffff:127.0.0.1' });
    }
    expect(auth.locked({ remoteAddress: '127.0.0.1' })).toBe(true);
  });

  it('reset() clears sessions', () => {
    const auth = createAuth(STRONG_TOKEN);
    const result = auth.login({ token: STRONG_TOKEN }, LOCAL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const req = fakeReq(cookieHeader(result.cookie));
    expect(auth.check(req)).toBe(true);
    auth.reset();
    expect(auth.check(req)).toBe(false);
  });
});

// 保证 session id 至少来自 32 字节随机源（43 字符 base64url）。
describe('session ids', () => {
  it('are 43 base64url characters', () => {
    const auth = createAuth(STRONG_TOKEN);
    const result = auth.login({ token: STRONG_TOKEN }, LOCAL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(sessionId(result.cookie)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
