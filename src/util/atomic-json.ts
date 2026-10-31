/**
 * 原子 JSON 文件读写：tmp `wx 0600` + rename，Windows 上的 `EPERM`/`EBUSY`
 * 重试 3×50ms，rename 后尽力 `chmod 0600`（Windows 忽略权限位，失败不算错误）。
 *
 * 读取区分「缺失」与「损坏」：调用方据此决定是静默初始化还是大声 fail closed。
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const RENAME_RETRY_DELAY_MS = 50;
const RENAME_RETRY_LIMIT = 3;

export type ReadJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; code: 'missing' | 'corrupt' };

function hasErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const retryable = hasErrno(error, 'EPERM') || hasErrno(error, 'EBUSY');
      if (!retryable || attempt >= RENAME_RETRY_LIMIT) throw error;
      await sleep(RENAME_RETRY_DELAY_MS);
    }
  }
}

/**
 * 整文件替换。父目录不存在时先创建；写失败会清理临时文件，
 * 绝不留下半个 JSON。
 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value, null, 2);
  if (text === undefined) throw new TypeError('writeJsonAtomic: value is not JSON-serializable');

  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true }).catch(() => undefined);

  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );

  const handle = await open(tmp, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(`${text}\n`, 'utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }

  try {
    await renameWithRetry(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }

  // Best effort: Windows ignores POSIX permission bits.
  await chmod(file, 0o600).catch(() => undefined);
}

export async function readJsonFile(file: string): Promise<ReadJsonResult> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    return { ok: false, code: hasErrno(error, 'ENOENT') ? 'missing' : 'corrupt' };
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, code: 'corrupt' };
  }
}
