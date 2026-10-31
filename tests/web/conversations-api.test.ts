import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createConversationsApi, type TranscriptRecord } from '../../src/web/transcript.js';
import { createWebServer, type WebServer } from '../../src/web/server.js';

const STRONG_TOKEN = '0123456789abcdef0123456789abcdef';

const IN_A: TranscriptRecord = {
  ts: '2026-01-01T00:00:00.000Z',
  direction: 'in',
  channel: 'qq',
  actor: 'alice',
  kind: 'qq_private_message',
  importance: 5,
  content: 'first message',
};
const OUT_B: TranscriptRecord = {
  ts: '2026-01-01T00:00:01.000Z',
  direction: 'out',
  status: 'dispatched',
  channel: 'qq:group:1',
  text: 'second message',
};
const IN_C: TranscriptRecord = {
  ts: '2026-01-01T00:00:02.000Z',
  direction: 'in',
  channel: 'qq',
  actor: 'carol',
  kind: 'qq_group_message',
  importance: 7,
  content: 'third message',
};

const dirs: string[] = [];
const servers: WebServer[] = [];

async function makeFile(lines: string[], trailingNewline = true): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'uuharness-conversations-'));
  dirs.push(dir);
  const file = path.join(dir, 'transcript.jsonl');
  await writeFile(file, lines.join('\n') + (trailingNewline ? '\n' : ''), 'utf8');
  return file;
}

function line(record: TranscriptRecord): string {
  return JSON.stringify(record);
}

async function startServer(options: {
  file: string;
  tailBytes?: number;
}): Promise<{ base: string; cookie: string }> {
  const handler = createConversationsApi({
    file: options.file,
    ...(options.tailBytes === undefined ? {} : { tailBytes: options.tailBytes }),
  });
  const server = createWebServer({
    host: '127.0.0.1',
    port: 0,
    token: STRONG_TOKEN,
    log: () => {},
    routeHandlers: { conversations: handler },
  });
  servers.push(server);
  await server.start();
  const base = `http://127.0.0.1:${server.port()}`;
  const cookie = await loginCookie(base);
  return { base, cookie };
}

async function loginCookie(base: string): Promise<string> {
  const response = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-uuharness-console': '1',
      origin: new URL(base).origin,
    },
    body: JSON.stringify({ token: STRONG_TOKEN }),
  });
  expect(response.status).toBe(200);
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const raw = headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie') ?? '';
  return raw.split(';')[0] ?? '';
}

interface ConversationsBody {
  ok: boolean;
  records?: TranscriptRecord[];
  nextCursor?: string;
  code?: string;
  field?: string;
}

async function getConversations(
  base: string,
  cookie: string,
  query = '',
): Promise<{ status: number; body: ConversationsBody }> {
  const response = await fetch(`${base}/api/conversations${query}`, { headers: { cookie } });
  const body = (await response.json()) as ConversationsBody;
  return { status: response.status, body };
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('GET /api/conversations', () => {
  it('requires a session', async () => {
    const file = await makeFile([line(IN_A)]);
    const { base } = await startServer({ file });
    const response = await fetch(`${base}/api/conversations`);
    expect(response.status).toBe(401);
  });

  it('returns records oldest-first and skips unparsable lines', async () => {
    const file = await makeFile([
      line(IN_A),
      'not json',
      '{"ts":1,"direction":"in"}',
      line(OUT_B),
      line(IN_C),
    ]);
    const { base, cookie } = await startServer({ file });

    const { status, body } = await getConversations(base, cookie);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.records?.map((record) => record.ts)).toEqual([IN_A.ts, OUT_B.ts, IN_C.ts]);
    expect(body.nextCursor).toBeUndefined();
  });

  it('filters by exact channel and by direction', async () => {
    const file = await makeFile([line(IN_A), line(OUT_B), line(IN_C)]);
    const { base, cookie } = await startServer({ file });

    const byChannel = await getConversations(base, cookie, '?channel=qq');
    expect(byChannel.body.records?.map((record) => record.ts)).toEqual([IN_A.ts, IN_C.ts]);

    const byDirection = await getConversations(base, cookie, '?direction=out');
    expect(byDirection.body.records?.map((record) => record.ts)).toEqual([OUT_B.ts]);
  });

  it('applies afterTs and beforeTs bounds', async () => {
    const file = await makeFile([line(IN_A), line(OUT_B), line(IN_C)]);
    const { base, cookie } = await startServer({ file });

    const after = await getConversations(base, cookie, `?afterTs=${encodeURIComponent(OUT_B.ts)}`);
    expect(after.body.records?.map((record) => record.ts)).toEqual([OUT_B.ts, IN_C.ts]);

    const before = await getConversations(base, cookie, `?beforeTs=${encodeURIComponent(IN_C.ts)}`);
    expect(before.body.records?.map((record) => record.ts)).toEqual([IN_A.ts, OUT_B.ts]);
  });

  it('rejects a non-integer limit and an unknown direction with 400', async () => {
    const file = await makeFile([line(IN_A)]);
    const { base, cookie } = await startServer({ file });

    const badLimit = await getConversations(base, cookie, '?limit=abc');
    expect(badLimit.status).toBe(400);
    expect(badLimit.body).toEqual({ ok: false, code: 'invalid_limit', field: 'limit' });

    const badDirection = await getConversations(base, cookie, '?direction=sideways');
    expect(badDirection.status).toBe(400);
    expect(badDirection.body).toEqual({ ok: false, code: 'invalid_direction', field: 'direction' });
  });

  it('clamps the limit into [1,500]', async () => {
    const file = await makeFile([line(IN_A), line(OUT_B), line(IN_C)]);
    const { base, cookie } = await startServer({ file });

    const zero = await getConversations(base, cookie, '?limit=0');
    expect(zero.body.records?.map((record) => record.ts)).toEqual([IN_C.ts]);

    const huge = await getConversations(base, cookie, '?limit=99999');
    expect(huge.status).toBe(200);
    expect(huge.body.records).toHaveLength(3);
  });

  it('returns the newest page plus a nextCursor when older records exist', async () => {
    const file = await makeFile([line(IN_A), line(OUT_B), line(IN_C)]);
    const { base, cookie } = await startServer({ file });

    const page = await getConversations(base, cookie, '?limit=2');
    expect(page.body.records?.map((record) => record.ts)).toEqual([OUT_B.ts, IN_C.ts]);
    expect(page.body.nextCursor).toBe(`${OUT_B.ts}~1`);

    const older = await getConversations(
      base,
      cookie,
      `?limit=2&cursor=${encodeURIComponent(page.body.nextCursor ?? '')}`,
    );
    expect(older.body.records?.map((record) => record.ts)).toEqual([IN_A.ts]);
    expect(older.body.nextCursor).toBeUndefined();
  });

  it('returns every record exactly once when timestamps collide', async () => {
    const shared = '2026-01-01T00:00:01.000Z';
    const records: TranscriptRecord[] = [
      { ts: shared, direction: 'in', channel: 'qq', content: 'a1' },
      { ts: shared, direction: 'in', channel: 'qq', content: 'a2' },
      { ts: '2026-01-01T00:00:02.000Z', direction: 'in', channel: 'qq', content: 'b' },
      { ts: '2026-01-01T00:00:03.000Z', direction: 'in', channel: 'qq', content: 'c' },
      { ts: '2026-01-01T00:00:04.000Z', direction: 'in', channel: 'qq', content: 'd' },
    ];
    const file = await makeFile(records.map(line));
    const { base, cookie } = await startServer({ file });

    const seen: string[] = [];
    let query = '?limit=2';
    for (let page = 0; page < 5; page += 1) {
      const result = await getConversations(base, cookie, query);
      expect(result.status).toBe(200);
      seen.push(...(result.body.records ?? []).map((record) => record.content ?? ''));
      const cursor = result.body.nextCursor;
      if (cursor === undefined) break;
      expect(cursor).toContain('~');
      query = `?limit=2&cursor=${encodeURIComponent(cursor)}`;
    }

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort()).toEqual(['a1', 'a2', 'b', 'c', 'd']);
  });

  it('pages a run of identical timestamps without looping (5 rows, limit=2)', async () => {
    const shared = '2026-01-01T00:00:01.000Z';
    const records: TranscriptRecord[] = ['a1', 'a2', 'a3', 'a4', 'a5'].map((content) => ({
      ts: shared,
      direction: 'in',
      channel: 'qq',
      content,
    }));
    const file = await makeFile(records.map(line));
    const { base, cookie } = await startServer({ file });

    const pages: string[][] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 6; page += 1) {
      const query =
        cursor === undefined
          ? '?limit=2'
          : `?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const result = await getConversations(base, cookie, query);
      expect(result.status).toBe(200);
      pages.push((result.body.records ?? []).map((record) => record.content ?? ''));
      cursor = result.body.nextCursor;
      if (cursor === undefined) break;
    }

    expect(pages).toEqual([['a4', 'a5'], ['a2', 'a3'], ['a1']]);
    expect(cursor).toBeUndefined();
  });

  it('pages a run of identical timestamps without looping (3 rows, limit=1)', async () => {
    const shared = '2026-01-01T00:00:01.000Z';
    const records: TranscriptRecord[] = ['a1', 'a2', 'a3'].map((content) => ({
      ts: shared,
      direction: 'in',
      channel: 'qq',
      content,
    }));
    const file = await makeFile(records.map(line));
    const { base, cookie } = await startServer({ file });

    const pages: string[][] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const query =
        cursor === undefined
          ? '?limit=1'
          : `?limit=1&cursor=${encodeURIComponent(cursor)}`;
      const result = await getConversations(base, cookie, query);
      expect(result.status).toBe(200);
      pages.push((result.body.records ?? []).map((record) => record.content ?? ''));
      cursor = result.body.nextCursor;
      if (cursor === undefined) break;
    }

    expect(pages).toEqual([['a3'], ['a2'], ['a1']]);
    expect(cursor).toBeUndefined();
  });

  it('rejects a malformed cursor with 400 instead of serving a full page', async () => {
    const file = await makeFile([line(IN_A), line(OUT_B), line(IN_C)]);
    const { base, cookie } = await startServer({ file });

    for (const cursor of [
      'not-a-cursor',
      IN_A.ts,
      '~1',
      `${IN_A.ts}~abc`,
      `${IN_A.ts}~0`,
      'abc~1',
      '2026-13-45T99:99:99Z~1',
    ]) {
      const result = await getConversations(
        base,
        cookie,
        `?cursor=${encodeURIComponent(cursor)}`,
      );
      expect(result.status).toBe(400);
      expect(result.body).toEqual({ ok: false, code: 'invalid_cursor' });
    }
  });

  it('reads only the tail window, dropping a leading partial line', async () => {
    const file = await makeFile([line(IN_A), line(OUT_B), line(IN_C)]);
    // Start ten bytes inside OUT_B so its line is partial; only IN_C survives.
    const tailBytes = Buffer.byteLength(`${line(OUT_B)}\n${line(IN_C)}\n`, 'utf8') - 10;
    const { base, cookie } = await startServer({ file, tailBytes });

    const { body } = await getConversations(base, cookie);
    expect(body.records?.map((record) => record.ts)).toEqual([IN_C.ts]);
    // Fewer matching records than the limit: the window itself is the bound,
    // so there is no cursor to follow (a cursor could lead to an empty page).
    expect(body.nextCursor).toBeUndefined();
  });

  it('emits a cursor only while the window holds more matches than the limit', async () => {
    const file = await makeFile([line(IN_A), line(OUT_B), line(IN_C)]);
    const { base, cookie } = await startServer({ file });

    const first = await getConversations(base, cookie, '?limit=1');
    expect(first.body.records?.map((record) => record.ts)).toEqual([IN_C.ts]);
    expect(first.body.nextCursor).toBe(`${IN_C.ts}~1`);

    const second = await getConversations(
      base,
      cookie,
      `?limit=1&cursor=${encodeURIComponent(first.body.nextCursor ?? '')}`,
    );
    expect(second.body.records?.map((record) => record.ts)).toEqual([OUT_B.ts]);
    expect(second.body.nextCursor).toBe(`${OUT_B.ts}~1`);

    const third = await getConversations(
      base,
      cookie,
      `?limit=1&cursor=${encodeURIComponent(second.body.nextCursor ?? '')}`,
    );
    expect(third.body.records?.map((record) => record.ts)).toEqual([IN_A.ts]);
    expect(third.body.nextCursor).toBeUndefined();
  });

  it('drops a trailing unterminated line', async () => {
    const file = await makeFile([line(IN_A), line(OUT_B)], false);
    const { base, cookie } = await startServer({ file });

    const { body } = await getConversations(base, cookie);
    expect(body.records?.map((record) => record.ts)).toEqual([IN_A.ts]);
  });

  it('returns an empty list when the transcript file does not exist', async () => {
    const file = await makeFile([]);
    await rm(file, { force: true });
    const { base, cookie } = await startServer({ file });

    const { status, body } = await getConversations(base, cookie);
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, records: [] });
  });
});
