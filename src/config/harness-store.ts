/**
 * `config/harness.json` 的运行期持有者：带校验的加载（含 `.bak` 与 env 导入回退）、
 * 干跑优先的原子保存、以及从磁盘热重载。
 *
 * 语义与 `ConfigStore`（`models.json`）逐条对齐：
 * - 保存顺序：解析 → 暂存旧文件 → 干跑 `build` → 原子写 → `.bak` → 提交 → onChange；
 * - 任一步失败都不落盘，磁盘上永远是上一份合法配置；
 * - 写代际令牌抑制自己触发的 watcher 事件；
 * - `fs.watch` + 1s mtime 轮询（Windows/容器里 watcher 可能不可用）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { watch as fsWatch, realpathSync, type FSWatcher } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { readJsonFile } from '../util/atomic-json.js';
import {
  importFromEnv,
  maskHarnessConfig,
  parseHarnessConfig,
  type HarnessConfig,
} from './harness-schema.js';
import { isMaskedKey } from './models-schema.js';

const CONFIG_FILE = 'harness.json';
const BACKUP_FILE = 'harness.json.bak';

const WATCH_DEBOUNCE_MS = 200;
const WATCH_POLL_MS = 1_000;
const RENAME_RETRY_DELAY_MS = 50;
const RENAME_RETRY_LIMIT = 3;

export type HarnessBuildResult = { ok: true } | { ok: false; code: string };

export type HarnessStoreOptions = {
  configDir: string;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /** 干跑工厂：写盘前与重载时都会调用；失败即拒绝。 */
  build: (config: HarnessConfig) => HarnessBuildResult;
  /** 提交成功后通知（保存或外部重载）。 */
  onChange?: (config: HarnessConfig) => void;
  /**
   * 测试缝：替换主配置的原子写入。生产使用 `writeTextAtomic`（tmp + rename）。
   * 测试用它模拟「写入窗口内出现外部编辑」的竞态。
   */
  atomicWrite?: (targetPath: string, contents: string) => Promise<void>;
};

export type HarnessLoadResult =
  | { ok: true; config: HarnessConfig }
  | { ok: false; code: string };

export type HarnessSaveResult =
  | { ok: true }
  | { ok: false; code: string; field?: string };

type FileResult = { ok: true; config: HarnessConfig } | { ok: false; code: string };
type ResolveResult = { ok: true; value: unknown } | { ok: false; code: string; field?: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
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
 * 逐字节写入（`.bak` 必须与上一版文件完全一致，不能重新序列化）。
 * tmp `wx 0600` + rename，Windows 上重试 `EPERM`/`EBUSY`；权限位尽力而为。
 */
async function writeTextAtomic(targetPath: string, contents: string): Promise<void> {
  const dir = path.dirname(targetPath);
  await mkdir(dir, { recursive: true }).catch(() => undefined);

  const tmp = path.join(
    dir,
    `.${path.basename(targetPath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );

  const handle = await open(tmp, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(contents, 'utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }

  try {
    await renameWithRetry(tmp, targetPath);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }

  // Best effort: Windows ignores POSIX permission bits.
  await chmod(targetPath, 0o600).catch(() => undefined);
}

export class HarnessStore {
  private readonly configDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: (line: string) => void;
  private readonly build: (config: HarnessConfig) => HarnessBuildResult;
  private readonly onChange: ((config: HarnessConfig) => void) | undefined;
  private readonly atomicWrite: (targetPath: string, contents: string) => Promise<void>;
  private readonly configPath: string;
  private readonly backupPath: string;

  private config: HarnessConfig | null = null;

  private watcher: FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private started = false;
  private closed = false;

  /** Serializes load/save/reload so they never interleave. */
  private queue: Promise<void> = Promise.resolve();

  /** Incremented after every atomic write; used to suppress self-triggered reloads. */
  private writeGeneration = 0;
  /** mtime+size of the last file state we either wrote or deliberately observed. */
  private lastSignature: string | null = null;

  constructor(opts: HarnessStoreOptions) {
    this.configDir = opts.configDir;
    this.env = opts.env;
    this.log = opts.log;
    this.build = opts.build;
    this.onChange = opts.onChange;
    this.atomicWrite = opts.atomicWrite ?? writeTextAtomic;
    this.configPath = path.join(opts.configDir, CONFIG_FILE);
    this.backupPath = path.join(opts.configDir, BACKUP_FILE);
  }

  get(): HarnessConfig | null {
    return this.config;
  }

  /**
   * 当前已提交配置的版本令牌（配置文件内容摘要）。设置页用它做乐观并发
   * 控制：GET 下发、PUT 回传，磁盘在两次请求之间变过就返回 409。
   */
  revision(): string | null {
    return this.lastSignature;
  }

  /** GET 形状：`wsToken` 只以 `hasWsToken` / `wsTokenLast4` 出现。 */
  getMasked(): unknown {
    const config = this.config;
    if (config === null) return null;
    return maskHarnessConfig(config);
  }

  /**
   * 加载顺序：`harness.json` → `harness.json.bak` → env 导入。
   * 没有配置文件时总会导入一次（即使 env 为空），并尽力落盘。
   */
  load(): Promise<HarnessLoadResult> {
    return this.enqueue(() => this.loadLocked());
  }

  private async loadLocked(): Promise<HarnessLoadResult> {
    try {
      await mkdir(this.configDir, { recursive: true });
    } catch {
      // Reading/writing below will surface the real error.
    }

    const primary = await this.tryFile(this.configPath);
    if (primary.ok) {
      this.commit(primary.config);
      await this.refreshSignature();
      return { ok: true, config: primary.config };
    }
    if (primary.code !== 'missing') {
      this.log(`harness.json rejected: ${primary.code}`);
    }

    const backup = await this.tryFile(this.backupPath);
    if (backup.ok) {
      this.log('harness.json.bak is valid; using it');
      this.commit(backup.config);
      await this.refreshSignature();
      return { ok: true, config: backup.config };
    }
    if (backup.code !== 'missing') {
      this.log(`harness.json.bak rejected: ${backup.code}`);
    }

    const parsed = parseHarnessConfig(importFromEnv(this.env));
    if (!parsed.ok) return { ok: false, code: parsed.code };

    const built = this.runBuild(parsed.value);
    if (!built.ok) return { ok: false, code: built.code };

    this.commit(parsed.value);
    try {
      await this.writeAtomic(parsed.value);
      this.log('imported harness.json from the environment');
    } catch (error) {
      this.log(`could not persist imported harness.json: ${errorMessage(error)}`);
      await this.refreshSignature();
    }
    return { ok: true, config: parsed.value };
  }

  /**
   * 解析三态 `wsToken` 契约（缺省保持、`null` 清除、字符串替换），然后校验、
   * 干跑并原子写。任何一步失败都不碰磁盘。
   */
  save(candidate: unknown): Promise<HarnessSaveResult> {
    return this.enqueue(() => this.saveLocked(candidate));
  }

  private async saveLocked(candidate: unknown): Promise<HarnessSaveResult> {
    const resolved = this.resolveCandidate(candidate);
    if (!resolved.ok) return resolved;

    const parsed = parseHarnessConfig(resolved.value);
    if (!parsed.ok) return parsed;

    try {
      await mkdir(this.configDir, { recursive: true });
    } catch {
      return { ok: false, code: 'write_failed' };
    }

    // Stage the previous file's bytes first, but do not touch `.bak` yet: if the
    // primary write fails, both files must stay exactly as they were. Staging runs
    // BEFORE the candidate build so a stateful builder's last call describes the
    // config that is about to be committed.
    const previous = await this.stageBuildableFile(this.configPath);

    const built = this.runBuild(parsed.value);
    if (!built.ok) return { ok: false, code: built.code };

    try {
      await this.writeAtomic(parsed.value);
    } catch {
      return { ok: false, code: 'write_failed' };
    }

    // The primary is committed; only now may it become the backup. A backup failure
    // does not roll back a valid primary, so the save still succeeds.
    if (previous !== null) {
      try {
        await writeTextAtomic(this.backupPath, previous);
      } catch (error) {
        this.log(`could not write harness.json.bak: ${errorMessage(error)}`);
      }
    }

    this.commit(parsed.value);
    this.emitChange();
    return { ok: true };
  }

  /** Watch the config directory and poll mtime as a fallback (works on Windows/containers). */
  watch(): void {
    // `started` (not `watcher`) guards re-entry: fs.watch can fail and leave the
    // watcher null, and a second call must not install a second polling interval.
    if (this.closed || this.started) return;
    this.started = true;

    try {
      // Resolve the directory first: on Windows libuv compares event paths against
      // the watched path verbatim, so a directory opened through an 8.3 short name
      // (as os.tmpdir() may return) would abort the process on the first event.
      let watchDir = this.configDir;
      try {
        watchDir = realpathSync.native(this.configDir);
      } catch {
        try {
          watchDir = realpathSync(this.configDir);
        } catch {
          watchDir = this.configDir;
        }
      }

      this.watcher = fsWatch(watchDir, { persistent: false }, (_event, filename) => {
        const name = filename === null ? null : path.basename(String(filename));
        if (name !== null && name !== CONFIG_FILE) return;
        this.scheduleReload();
      });
      this.watcher.on('error', (error: unknown) => {
        this.log(`harness.json watcher error: ${errorMessage(error)}`);
      });
    } catch (error) {
      this.log(`harness.json watcher unavailable: ${errorMessage(error)}`);
    }

    this.pollTimer = setInterval(() => {
      void this.poll();
    }, WATCH_POLL_MS);
    this.pollTimer.unref();
  }

  async close(): Promise<void> {
    this.closed = true;

    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.watcher !== null) {
      try {
        this.watcher.close();
      } catch {
        // Already closed.
      }
      this.watcher = null;
    }

    // Queued operations observe `closed` and return without touching the store.
    try {
      await this.queue;
    } catch {
      // The queue tail never rejects; be defensive anyway.
    }
  }

  /**
   * Resolves the three-state `wsToken` contract before schema validation:
   * absent keeps the stored token, `null` clears it, a string replaces it.
   * Masked placeholders are rejected here so the error carries the exact field.
   */
  private resolveCandidate(candidate: unknown): ResolveResult {
    if (!isPlainObject(candidate)) return { ok: true, value: candidate };

    const rawQq = candidate.qq;
    if (!isPlainObject(rawQq)) return { ok: true, value: candidate };

    const stored = this.config?.qq.wsToken ?? '';
    const hasToken = Object.prototype.hasOwnProperty.call(rawQq, 'wsToken');
    if (!hasToken) {
      return { ok: true, value: { ...candidate, qq: { ...rawQq, wsToken: stored } } };
    }

    const token = rawQq.wsToken;
    if (token === null) {
      return { ok: true, value: { ...candidate, qq: { ...rawQq, wsToken: '' } } };
    }
    if (typeof token === 'string' && isMaskedKey(token)) {
      return { ok: false, code: 'invalid_field', field: 'qq.wsToken' };
    }
    return { ok: true, value: candidate };
  }

  private runBuild(config: HarnessConfig): HarnessBuildResult {
    try {
      return this.build(config);
    } catch {
      return { ok: false, code: 'build_failed' };
    }
  }

  private commit(config: HarnessConfig): void {
    this.config = config;
  }

  private emitChange(): void {
    const config = this.config;
    if (config === null) return;
    try {
      this.onChange?.(config);
    } catch (error) {
      this.log(`harness change handler failed: ${errorMessage(error)}`);
    }
  }

  private async tryFile(filePath: string): Promise<FileResult> {
    const read = await readJsonFile(filePath);
    if (!read.ok) return { ok: false, code: read.code };

    const parsed = parseHarnessConfig(read.value);
    if (!parsed.ok) return { ok: false, code: parsed.code };

    const built = this.runBuild(parsed.value);
    if (!built.ok) return { ok: false, code: built.code };

    return { ok: true, config: parsed.value };
  }

  /**
   * Returns the file's exact bytes only when it passes the same parse + build dry
   * run as a load. An unbuildable file must never become the backup.
   */
  private async stageBuildableFile(filePath: string): Promise<string | null> {
    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch {
      return null;
    }

    try {
      const parsed = parseHarnessConfig(JSON.parse(text));
      if (!parsed.ok) return null;
      if (!this.runBuild(parsed.value).ok) return null;
      return text;
    } catch {
      return null;
    }
  }

  private async signature(): Promise<string | null> {
    try {
      // 内容摘要而不是 `mtime:size`：同一 mtime 刻度内写入的等长配置会拿到相同
      // 签名，poll 与 watch 都会把它当成「没变」而漏检。文件很小（几百字节），
      // 每秒读一次比漏检便宜。
      const bytes = await readFile(this.configPath);
      return createHash('sha256').update(bytes).digest('hex');
    } catch {
      return null;
    }
  }

  private async refreshSignature(): Promise<void> {
    this.lastSignature = await this.signature();
  }

  /** Runs operations one at a time in call order; failures never break the chain. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async writeAtomic(config: HarnessConfig): Promise<void> {
    const contents = `${JSON.stringify(config, null, 2)}\n`;
    // 签名按「即将写入的字节」算，而不是写完后重读文件。写完再读会把恰好
    // 落在 rename 之后的外部编辑吸进 lastSignature：poll 认为文件没变，
    // 内存与磁盘永久分叉。这里用写入内容的摘要，下一次 poll 一定能看见
    // 外部编辑（它的摘要必然不同）。
    const written = createHash('sha256').update(contents).digest('hex');
    await this.atomicWrite(this.configPath, contents);
    this.writeGeneration += 1;
    this.lastSignature = written;
  }

  private scheduleReload(): void {
    if (this.closed) return;
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    const generation = this.writeGeneration;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.reloadFromDisk(generation);
    }, WATCH_DEBOUNCE_MS);
    this.debounceTimer.unref();
  }

  private reloadFromDisk(generation: number): void {
    if (this.closed) return;
    // Reloads share the save queue: a concurrent save can never interleave with a
    // reload, so one file state produces exactly one onChange.
    void this.enqueue(() => this.doReload(generation));
  }

  private async doReload(generation: number): Promise<void> {
    if (this.closed) return;

    const signature = await this.signature();
    if (signature === null) return;
    // Self-triggered event: we already committed this exact file state.
    if (signature === this.lastSignature) return;
    // A write landed while the debounce timer was pending; the save path already
    // committed and notified, so ignore the stale event.
    if (generation !== this.writeGeneration) return;

    const loaded = await this.tryFile(this.configPath);
    if (!loaded.ok) {
      // Remember the rejected state so the poll does not retry it every second;
      // a later edit changes the signature and is retried.
      this.lastSignature = signature;
      this.log(`harness.json reload rejected: ${loaded.code}; keeping the previous configuration`);
      return;
    }

    if (this.closed) return;

    this.lastSignature = signature;
    this.commit(loaded.config);
    this.log('harness.json reloaded');
    this.emitChange();
  }

  private async poll(): Promise<void> {
    if (this.closed) return;
    const signature = await this.signature();
    if (signature === null || signature === this.lastSignature) return;
    this.scheduleReload();
  }
}
