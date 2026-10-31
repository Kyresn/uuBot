import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlAuditLog } from '../../src/control/audit-log.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'uuharness-audit-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function lines(file: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(file, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('ControlAuditLog', () => {
  it('appends one JSONL row per event and flushes them', async () => {
    const dir = await tempDir();
    const file = join(dir, 'control-audit.jsonl');
    const audit = new ControlAuditLog({ file, log: () => undefined, now: () => 1_700_000_000_000 });

    audit.record({ event: 'command', via: 'qq', actor: 'private:1', command: '#状态', intent: 'status.read', result: 'handled' });
    audit.record({ event: 'decision', id: 'ap_1', kind: 'capability.activate', decision: 'approved', via: 'web', by: 'web:session' });
    await audit.flush(2_000);

    const rows = await lines(file);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      ts: new Date(1_700_000_000_000).toISOString(),
      event: 'command',
      via: 'qq',
      actor: 'private:1',
      command: '#状态',
      intent: 'status.read',
      result: 'handled',
    });
    expect(rows[1]).toMatchObject({
      event: 'decision',
      id: 'ap_1',
      kind: 'capability.activate',
      decision: 'approved',
      via: 'web',
      by: 'web:session',
    });
  });

  it('rotates the file to .1 at the size cap', async () => {
    const dir = await tempDir();
    const file = join(dir, 'control-audit.jsonl');
    const audit = new ControlAuditLog({ file, log: () => undefined, maxBytes: 1 });

    audit.record({ event: 'command', intent: 'help.read', result: 'handled' });
    await audit.flush(2_000);
    audit.record({ event: 'command', intent: 'status.read', result: 'handled' });
    await audit.flush(2_000);

    expect((await readdir(dir)).sort()).toEqual(['control-audit.jsonl', 'control-audit.jsonl.1']);
    expect((await lines(`${file}.1`))[0]).toMatchObject({ intent: 'help.read' });
    expect((await lines(file))[0]).toMatchObject({ intent: 'status.read' });
  });

  it('never throws or rejects when the file cannot be written', async () => {
    const dir = await tempDir();
    // 目录路径当文件用：append/rename 都会失败。
    const file = join(dir, 'audit-dir');
    await mkdir(file);
    const log = vi.fn<(line: string) => void>();
    const audit = new ControlAuditLog({ file, log, maxBytes: Number.MAX_SAFE_INTEGER });

    expect(() => audit.record({ event: 'command', intent: 'status.read', result: 'handled' })).not.toThrow();
    await expect(audit.flush(500)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('control-audit'));
  });

  it('drops the oldest rows when the in-memory queue is full', async () => {
    const dir = await tempDir();
    const file = join(dir, 'control-audit.jsonl');
    const log = vi.fn<(line: string) => void>();
    // 队列上限 1：第一条被在途 drain 取走后，后两条只能留一条。
    const audit = new ControlAuditLog({ file, log, maxQueue: 1, maxBytes: Number.MAX_SAFE_INTEGER });

    audit.record({ event: 'command', intent: 'a', result: 'handled' });
    audit.record({ event: 'command', intent: 'b', result: 'handled' });
    audit.record({ event: 'command', intent: 'c', result: 'handled' });
    await audit.flush(2_000);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('dropped'));
    const intents = (await lines(file)).map((row) => row['intent']);
    expect(intents).toEqual(['a', 'c']);
  });
});
