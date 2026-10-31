import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PerceptionQueue, type PerceptionEvent } from '../../src/core/events.js';
import { TranscriptWriter, type TranscriptIo, type TranscriptRecord } from '../../src/web/transcript.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const dirs: string[] = [];
const writers: TranscriptWriter[] = [];

async function makeFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'uuharness-transcript-'));
  dirs.push(dir);
  return path.join(dir, 'transcript.jsonl');
}

interface WriterOptions {
  maxQueue?: number;
  maxBytes?: number;
  io?: Partial<TranscriptIo>;
}

function makeWriter(
  file: string,
  opts: WriterOptions = {},
): { writer: TranscriptWriter; logs: string[] } {
  const logs: string[] = [];
  const writer = new TranscriptWriter({ file, log: (line) => logs.push(line), ...opts });
  writers.push(writer);
  return { writer, logs };
}

function inbound(overrides: Partial<TranscriptRecord> = {}): TranscriptRecord {
  return {
    ts: '2026-01-01T00:00:00.000Z',
    direction: 'in',
    channel: 'qq',
    actor: 'tester',
    kind: 'qq_private_message',
    importance: 5,
    content: 'hello',
    ...overrides,
  };
}

function outbound(overrides: Partial<TranscriptRecord> = {}): TranscriptRecord {
  return {
    ts: '2026-01-01T00:00:01.000Z',
    direction: 'out',
    status: 'dispatched',
    channel: 'qq',
    text: 'world',
    ...overrides,
  };
}

async function readRecords(file: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(file, 'utf8');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(async () => {
  for (const writer of writers.splice(0)) await writer.flush(2_000);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('TranscriptWriter', () => {
  it('appends records in arrival order with their fields intact', async () => {
    const file = await makeFile();
    const { writer } = makeWriter(file);

    writer.record(inbound());
    writer.record(outbound({ status: 'blocked', reason: 'red-line violated' }));
    await writer.flush(2_000);

    const records = await readRecords(file);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      direction: 'in',
      channel: 'qq',
      actor: 'tester',
      kind: 'qq_private_message',
      importance: 5,
      content: 'hello',
    });
    expect(records[1]).toMatchObject({
      direction: 'out',
      status: 'blocked',
      channel: 'qq',
      reason: 'red-line violated',
    });
  });

  it('never blocks the caller on I/O', async () => {
    const file = await makeFile();
    const gate = deferred();
    let appended = false;
    const { writer } = makeWriter(file, {
      io: {
        appendFile: async () => {
          await gate.promise;
          appended = true;
        },
      },
    });

    const started = Date.now();
    expect(() => writer.record(inbound())).not.toThrow();
    expect(Date.now() - started).toBeLessThan(50);
    expect(appended).toBe(false);

    gate.resolve();
    await writer.flush(2_000);
    expect(appended).toBe(true);
  });

  it('drops the oldest queued records when the bounded queue overflows', async () => {
    const file = await makeFile();
    const gate = deferred();
    const batches: string[] = [];
    const { writer, logs } = makeWriter(file, {
      maxQueue: 2,
      io: {
        appendFile: async (_file, data) => {
          await gate.promise;
          batches.push(data);
        },
      },
    });

    // The first record is taken by the in-flight batch synchronously, so the next
    // four queue up one at a time; each overflow drops the oldest queued record.
    writer.record(inbound({ content: 'first' }));
    writer.record(inbound({ content: 'second' }));
    writer.record(inbound({ content: 'third' }));
    writer.record(inbound({ content: 'fourth' }));
    writer.record(inbound({ content: 'fifth' }));

    expect(logs.filter((line) => line.includes('dropped 1 oldest'))).toHaveLength(2);

    gate.resolve();
    await writer.flush(2_000);
    const contents = batches
      .join('')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => (JSON.parse(line) as { content: string }).content);
    expect(contents).toEqual(['first', 'fourth', 'fifth']);
  });

  it('rotates to .1 before an append once the file reaches the size limit', async () => {
    const file = await makeFile();
    const { writer, logs } = makeWriter(file, { maxBytes: 64 });

    writer.record(inbound({ content: 'a'.repeat(40) }));
    await writer.flush(2_000);
    writer.record(inbound({ ts: '2026-01-01T00:00:02.000Z', content: 'b'.repeat(40) }));
    await writer.flush(2_000);

    expect(existsSync(`${file}.1`)).toBe(true);
    expect(await readFile(`${file}.1`, 'utf8')).toContain('a'.repeat(40));
    expect(await readFile(file, 'utf8')).toContain('b'.repeat(40));
    expect(logs.some((line) => line.includes('rotated'))).toBe(true);
  });

  it('rotates an oversized existing file during startup prepare', async () => {
    const file = await makeFile();
    const oldLine = `${JSON.stringify(inbound({ content: 'old-record' }))}\n`;
    await writeFile(file, oldLine, 'utf8');

    // The writer's constructor kicks off prepare() asynchronously; drain awaits it
    // before the first append, so the pre-existing file must be rotated first.
    const { writer, logs } = makeWriter(file, { maxBytes: 32 });
    writer.record(inbound({ ts: '2026-01-01T00:00:09.000Z', content: 'new-record' }));
    await writer.flush(2_000);

    expect(existsSync(`${file}.1`)).toBe(true);
    expect(await readFile(`${file}.1`, 'utf8')).toBe(oldLine);
    expect(await readFile(file, 'utf8')).toContain('new-record');
    expect(logs.some((line) => line.includes('rotated'))).toBe(true);
  });

  it('keeps an inbound record even after the queue evicts it (D8)', async () => {
    const file = await makeFile();
    const { writer } = makeWriter(file);
    const queue = new PerceptionQueue({
      maxSize: 2,
      onPush: (event: PerceptionEvent) => {
        writer.record({
          ts: new Date(event.ts).toISOString(),
          direction: 'in',
          channel: event.channel,
          actor: event.actor,
          kind: event.kind,
          importance: event.importance,
          content: event.content,
        });
      },
    });

    const event = (id: string, content: string, importance: number): PerceptionEvent => ({
      id,
      ts: 0,
      kind: 'qq_private_message',
      channel: 'qq',
      actor: 'tester',
      content,
      importance,
    });

    queue.push(event('e0', 'evicted', 1));
    queue.push(event('e1', 'kept-low', 5));
    queue.push(event('e2', 'kept-high', 9));

    // e0 was evicted from the queue by D8, but it was recorded at push time.
    expect(queue.size()).toBe(2);
    await writer.flush(2_000);
    const records = await readRecords(file);
    expect(records.map((record) => record['content'])).toEqual([
      'evicted',
      'kept-low',
      'kept-high',
    ]);
  });

  it('logs write failures instead of throwing at the caller', async () => {
    const file = await makeFile();
    const { writer, logs } = makeWriter(file, {
      io: {
        appendFile: async () => {
          throw new Error('disk full');
        },
      },
    });

    expect(() => writer.record(inbound())).not.toThrow();
    await writer.flush(2_000);
    expect(logs.some((line) => line.includes('write failed'))).toBe(true);
  });

  it('resolves flush on timeout instead of hanging shutdown', async () => {
    const file = await makeFile();
    const { writer, logs } = makeWriter(file, {
      io: {
        appendFile: () => new Promise<void>(() => {}),
      },
    });

    writer.record(inbound());
    const started = Date.now();
    await writer.flush(50);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(logs.some((line) => line.includes('flush timed out'))).toBe(true);
  });
});
