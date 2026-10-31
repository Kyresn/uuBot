import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from '../../src/util/atomic-json.js';

/**
 * `rename` 的失败注入只影响本文件：原子写在 Windows 上会遇到 EPERM/EBUSY
 * （杀毒、索引器短暂持有句柄），必须重试而不是让一次写盘失败。
 */
const renameState = vi.hoisted(() => ({ failures: 0, calls: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (from: string, to: string): Promise<void> => {
      renameState.calls += 1;
      if (renameState.failures > 0) {
        renameState.failures -= 1;
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      await actual.rename(from, to);
    },
  };
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'uuharness-atomic-json-'));
  renameState.failures = 0;
  renameState.calls = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('writeJsonAtomic', () => {
  it('writes pretty JSON with a trailing newline and no leftover temp file', async () => {
    const target = path.join(dir, 'state.json');

    await writeJsonAtomic(target, { version: 1, records: [] });

    const text = await readFile(target, 'utf8');
    expect(text).toBe(`${JSON.stringify({ version: 1, records: [] }, null, 2)}\n`);
    expect(await readdir(dir)).toEqual(['state.json']);
  });

  it('creates the parent directory when it does not exist', async () => {
    const target = path.join(dir, 'nested', 'deeper', 'state.json');

    await writeJsonAtomic(target, { ok: true });

    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ ok: true });
  });

  it('retries rename on EPERM and succeeds', async () => {
    const target = path.join(dir, 'state.json');
    renameState.failures = 2;

    await writeJsonAtomic(target, { ok: true });

    expect(renameState.calls).toBe(3);
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ ok: true });
    expect(await readdir(dir)).toEqual(['state.json']);
  });

  it('gives up after three retries and removes the temp file', async () => {
    const target = path.join(dir, 'state.json');
    renameState.failures = 10;

    await expect(writeJsonAtomic(target, { ok: true })).rejects.toMatchObject({ code: 'EPERM' });

    expect(renameState.calls).toBe(4);
    expect(await readdir(dir)).toEqual([]);
  });

  it('restricts the written file to owner-only permissions on POSIX', async () => {
    const target = path.join(dir, 'state.json');

    await writeJsonAtomic(target, { ok: true });

    if (process.platform !== 'win32') {
      const info = await stat(target);
      expect(info.mode & 0o777).toBe(0o600);
    }
  });

  it('rejects values JSON cannot represent', async () => {
    await expect(writeJsonAtomic(path.join(dir, 'x.json'), undefined)).rejects.toThrow(TypeError);
  });
});

describe('readJsonFile', () => {
  it('returns missing for an absent file', async () => {
    await expect(readJsonFile(path.join(dir, 'absent.json'))).resolves.toEqual({
      ok: false,
      code: 'missing',
    });
  });

  it('returns corrupt for invalid JSON', async () => {
    const target = path.join(dir, 'bad.json');
    await writeFile(target, '{ not json', 'utf8');

    await expect(readJsonFile(target)).resolves.toEqual({ ok: false, code: 'corrupt' });
  });

  it('returns corrupt for an empty file', async () => {
    const target = path.join(dir, 'empty.json');
    await writeFile(target, '', 'utf8');

    await expect(readJsonFile(target)).resolves.toEqual({ ok: false, code: 'corrupt' });
  });

  it('round-trips a written value', async () => {
    const target = path.join(dir, 'state.json');
    await writeJsonAtomic(target, { version: 1, records: [{ id: 'ap_1' }] });

    await expect(readJsonFile(target)).resolves.toEqual({
      ok: true,
      value: { version: 1, records: [{ id: 'ap_1' }] },
    });
  });
});
