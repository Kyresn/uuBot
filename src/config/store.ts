/**
 * Runtime owner of `config/models.json`: validated load with backup/env fallback,
 * dry-run-first saves with atomic writes, and hot reload from disk.
 *
 * The store never interprets endpoints itself; it delegates pool/brain construction
 * to the injected `build` callback so the same validation path is used for a save
 * dry run and for a watcher-triggered reload.
 */
import { randomBytes } from 'node:crypto';
import { watch as fsWatch, realpathSync, type FSWatcher } from 'node:fs';
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import type { Brain } from '../brain/brain.js';
import type { EndpointPool } from '../brain/endpoints.js';
import {
  MODELS_SERVICE_NAMES,
  isMaskedKey,
  maskKey,
  parseModelsConfig,
  type ModelsConfig,
  type ModelsEndpoint,
  type ModelsService,
  type ModelsServiceName,
} from './models-schema.js';

const CONFIG_FILE = 'models.json';
const BACKUP_FILE = 'models.json.bak';

const WATCH_DEBOUNCE_MS = 200;
const WATCH_POLL_MS = 1_000;
const RENAME_RETRY_DELAY_MS = 50;
const RENAME_RETRY_LIMIT = 3;

const NIM_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const AGNES_COM_BASE_URL = 'https://apihub.agnes-ai.com/v1';
const AGNES_CN_BASE_URL = 'https://api.agnes-ai.cn/v1';

const NIM_FLASH_MODEL_FALLBACK = 'deepseek-ai/deepseek-v4.1-flash';
const AGNES_FLASH_MODEL_FALLBACK = 'agnes-3.0-flash';
const AGNES_PRO_MODEL_FALLBACK = 'agnes-2.5-pro';

export type ConfigBuildResult =
  | { ok: true; pool: EndpointPool; brain: Brain }
  | { ok: false; code: string };

export type ConfigChange = {
  config: ModelsConfig;
  pool: EndpointPool;
  brain: Brain;
};

export type ConfigStoreOptions = {
  configDir: string;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /** Dry-run factory: called for validation before any write, and on reload. */
  build: (config: ModelsConfig) => ConfigBuildResult;
  /** Notified after a save or a successful external reload commits. */
  onChange?: (change: ConfigChange) => void;
  /**
   * Notified synchronously for every in-memory commit (initial load, save,
   * external reload). The brain builder uses this to advance its health-migration
   * source only for pools that actually start serving.
   */
  onCommit?: (change: ConfigChange) => void;
  /**
   * Test seam: replaces the atomic writer used for `models.json` and its backup.
   * Production keeps the temp-file + rename implementation below.
   */
  atomicWrite?: (targetPath: string, contents: string) => Promise<void>;
};

export type ConfigLoadResult =
  | { ok: true; config: ModelsConfig }
  | { ok: false; code: string };

export type ConfigSaveResult =
  | { ok: true }
  | { ok: false; code: string; field?: string };

export type ConfigPreviewResult =
  | { ok: true; config: ModelsConfig }
  | { ok: false; code: string; field?: string };

type BuiltConfig = { ok: true; pool: EndpointPool; brain: Brain };
type FileResult =
  | { ok: true; config: ModelsConfig; built: BuiltConfig }
  | { ok: false; code: string };
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

function urlOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** True only when both URLs parse and their scheme+host+port differ. */
function originChanged(previous: string, next: string): boolean {
  const a = urlOrigin(previous);
  const b = urlOrigin(next);
  if (a === null || b === null) return false;
  return a !== b;
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

function maskService(service: ModelsService): Record<string, unknown> {
  const { apiKey, ...rest } = service;
  return { ...rest, ...maskKey(apiKey) };
}

function maskEndpoint(endpoint: ModelsEndpoint): Record<string, unknown> {
  const { apiKey, ...rest } = endpoint;
  return { ...rest, ...maskKey(apiKey) };
}

function envString(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = env[key]?.trim() ?? '';
  return raw === '' ? fallback : raw;
}

export class ConfigStore {
  private readonly configDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: (line: string) => void;
  private readonly build: (config: ModelsConfig) => ConfigBuildResult;
  private readonly onChange: ((change: ConfigChange) => void) | undefined;
  private readonly onCommit: ((change: ConfigChange) => void) | undefined;
  private readonly atomicWrite: (targetPath: string, contents: string) => Promise<void>;
  private readonly configPath: string;
  private readonly backupPath: string;

  private config: ModelsConfig | null = null;
  private pool: EndpointPool | null = null;
  private brain: Brain | null = null;

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

  constructor(opts: ConfigStoreOptions) {
    this.configDir = opts.configDir;
    this.env = opts.env;
    this.log = opts.log;
    this.build = opts.build;
    this.onChange = opts.onChange;
    this.onCommit = opts.onCommit;
    this.atomicWrite =
      opts.atomicWrite ?? ((targetPath, contents) => this.writeFileAtomic(targetPath, contents));
    this.configPath = path.join(opts.configDir, CONFIG_FILE);
    this.backupPath = path.join(opts.configDir, BACKUP_FILE);
  }

  get(): ModelsConfig | null {
    return this.config;
  }

  /** GET shape: keys are replaced by `hasApiKey` / `keyLast4`. */
  getMasked(): unknown {
    const config = this.config;
    if (config === null) return null;

    const masked: Record<string, unknown> = {
      version: config.version,
      importedFromEnv: config.importedFromEnv,
      endpoints: config.endpoints.map(maskEndpoint),
    };
    for (const service of MODELS_SERVICE_NAMES) {
      const section = config[service];
      if (section !== undefined) masked[service] = maskService(section);
    }
    return masked;
  }

  /**
   * Load order: `models.json` → `models.json.bak` → environment import. A failure
   * leaves `config` null and returns a code the caller can turn into an exit message.
   */
  load(): Promise<ConfigLoadResult> {
    return this.enqueue(() => this.loadLocked());
  }

  private async loadLocked(): Promise<ConfigLoadResult> {
    try {
      await mkdir(this.configDir, { recursive: true });
    } catch {
      // Reading/writing below will surface the real error.
    }

    const primary = await this.tryFile(this.configPath);
    if (primary.ok) {
      this.commit(primary.config, primary.built);
      await this.refreshSignature();
      return { ok: true, config: primary.config };
    }
    if (primary.code !== 'missing') {
      this.log(`models.json rejected: ${primary.code}`);
    }

    const backup = await this.tryFile(this.backupPath);
    if (backup.ok) {
      this.log('models.json.bak is valid; using it');
      this.commit(backup.config, backup.built);
      await this.refreshSignature();
      return { ok: true, config: backup.config };
    }
    if (backup.code !== 'missing') {
      this.log(`models.json.bak rejected: ${backup.code}`);
    }

    const imported = this.applyEnvImport(this.env);
    if (imported.endpoints.length === 0) return { ok: false, code: 'no_config' };

    const parsed = parseModelsConfig(imported);
    if (!parsed.ok) return { ok: false, code: parsed.code };

    const built = this.runBuild(parsed.value);
    if (!built.ok) return { ok: false, code: built.code };

    this.commit(parsed.value, built);
    try {
      await this.writeAtomic(`${JSON.stringify(parsed.value, null, 2)}\n`);
      this.log(`imported ${parsed.value.endpoints.length} endpoint(s) from the environment`);
    } catch (error) {
      this.log(`could not persist imported models.json: ${errorMessage(error)}`);
      await this.refreshSignature();
    }
    return { ok: true, config: parsed.value };
  }

  /**
   * Resolves the three-state apiKey contract and validates a candidate without
   * building a pool, writing to disk or touching the live configuration. The model
   * test endpoint uses this so a probe can never mutate live endpoint health.
   *
   * The returned config contains the *resolved* API keys. Never serialize it into
   * a response, log or error message; callers must project only the fields they
   * need (endpoint/model names, status codes).
   */
  preview(candidate: unknown): ConfigPreviewResult {
    const resolved = this.resolveCandidate(candidate);
    if (!resolved.ok) return resolved;
    const parsed = parseModelsConfig(resolved.value);
    if (!parsed.ok) return parsed;
    return { ok: true, config: parsed.value };
  }

  /**
   * Validates and dry-runs a candidate, then writes it atomically. Nothing touches
   * disk unless parse, validation and the build dry run all succeed.
   */
  save(candidate: unknown): Promise<ConfigSaveResult> {
    return this.enqueue(() => this.saveLocked(candidate));
  }

  private async saveLocked(candidate: unknown): Promise<ConfigSaveResult> {
    const resolved = this.resolveCandidate(candidate);
    if (!resolved.ok) return resolved;

    const parsed = parseModelsConfig(resolved.value);
    if (!parsed.ok) return parsed;

    try {
      await mkdir(this.configDir, { recursive: true });
    } catch {
      return { ok: false, code: 'write_failed' };
    }

    // Stage the previous file's bytes first, but do not touch `.bak` yet: if the
    // primary rename fails, both files must stay exactly as they were. Staging runs
    // BEFORE the candidate build because the build callback may be stateful (it
    // records `latest` for hot-swap); the last build call must describe the config
    // that is about to be committed, not the previous one.
    const previous = await this.stageBuildableFile(this.configPath);

    const built = this.runBuild(parsed.value);
    if (!built.ok) return { ok: false, code: built.code };

    try {
      await this.writeAtomic(`${JSON.stringify(parsed.value, null, 2)}\n`);
    } catch {
      return { ok: false, code: 'write_failed' };
    }

    // The primary is committed; only now may it become the backup. A backup failure
    // does not roll back a valid primary, so the save still succeeds.
    if (previous !== null) {
      try {
        await this.atomicWrite(this.backupPath, previous);
      } catch (error) {
        this.log(`could not write models.json.bak: ${errorMessage(error)}`);
      }
    }

    this.commit(parsed.value, built);
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
      // `native` expands short names; plain realpath is the fallback.
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
        this.log(`models.json watcher error: ${errorMessage(error)}`);
      });
    } catch (error) {
      this.log(`models.json watcher unavailable: ${errorMessage(error)}`);
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
   * Builds an initial config from the process environment only. Never reads `.env`
   * and never dumps `process.env`.
   */
  applyEnvImport(env: NodeJS.ProcessEnv): ModelsConfig {
    const endpoints: ModelsEndpoint[] = [];

    const nimFlash = envString(env, 'NIM_FLASH_MODEL', NIM_FLASH_MODEL_FALLBACK);
    const nimPro = envString(env, 'NIM_PRO_MODEL', nimFlash);
    const nimKeys = (env.NIM_API_KEYS ?? '')
      .split(',')
      .map((key) => key.trim())
      .filter((key) => key !== '');
    nimKeys.forEach((apiKey, index) => {
      endpoints.push({
        name: `nim-${index + 1}`,
        provider: 'nvidia_nim',
        baseUrl: NIM_BASE_URL,
        apiKey,
        enabled: true,
        tier: 'both',
        flashModel: nimFlash,
        proModel: nimPro,
      });
    });

    const agnesFlash = envString(env, 'AGNES_FLASH_MODEL', AGNES_FLASH_MODEL_FALLBACK);
    const agnesPro = envString(env, 'AGNES_PRO_MODEL', AGNES_PRO_MODEL_FALLBACK);

    const agnesCom = env.AGNES_COM_API_KEY?.trim() ?? '';
    if (agnesCom !== '') {
      endpoints.push({
        name: 'agnes_com',
        provider: 'agnes',
        baseUrl: AGNES_COM_BASE_URL,
        apiKey: agnesCom,
        enabled: true,
        tier: 'both',
        flashModel: agnesFlash,
        proModel: agnesPro,
      });
    }

    const agnesCn = env.AGNES_CN_API_KEY?.trim() ?? '';
    if (agnesCn !== '') {
      endpoints.push({
        name: 'agnes_cn',
        provider: 'agnes',
        baseUrl: AGNES_CN_BASE_URL,
        apiKey: agnesCn,
        enabled: true,
        tier: 'both',
        flashModel: agnesFlash,
        proModel: agnesPro,
      });
    }

    return { version: 1, importedFromEnv: true, endpoints };
  }

  /**
   * Resolves the three-state apiKey contract before schema validation:
   * absent keeps the stored key, `null` clears it, a string replaces it. Masked
   * strings are rejected, and an endpoint whose origin changed must supply a key.
   */
  private resolveCandidate(candidate: unknown): ResolveResult {
    if (!isPlainObject(candidate)) return { ok: true, value: candidate };

    const rawEndpoints = candidate.endpoints;
    let resolvedEndpoints: unknown = rawEndpoints;
    const candidateNames = new Set<string>();

    if (Array.isArray(rawEndpoints)) {
      for (const entry of rawEndpoints) {
        if (isPlainObject(entry) && typeof entry.name === 'string') {
          candidateNames.add(entry.name);
        }
      }

      const list: unknown[] = [];
      for (let index = 0; index < rawEndpoints.length; index += 1) {
        const resolved = this.resolveEntry(rawEndpoints[index], 'endpoint', index, candidateNames);
        if (!resolved.ok) return resolved;
        list.push(resolved.value);
      }
      resolvedEndpoints = list;
    }

    const resolved: Record<string, unknown> = { ...candidate, endpoints: resolvedEndpoints };

    for (const service of MODELS_SERVICE_NAMES) {
      if (!Object.prototype.hasOwnProperty.call(candidate, service)) continue;
      const entry = candidate[service];
      const serviceResolved = this.resolveEntry(entry, service, 0, candidateNames);
      if (!serviceResolved.ok) return serviceResolved;
      resolved[service] = serviceResolved.value;
    }

    return { ok: true, value: resolved };
  }

  private resolveEntry(
    raw: unknown,
    kind: 'endpoint' | ModelsServiceName,
    index: number,
    candidateNames: ReadonlySet<string>,
  ): ResolveResult {
    if (!isPlainObject(raw)) return { ok: true, value: raw };

    const fieldBase = kind === 'endpoint' ? `endpoints[${index}]` : kind;
    const stored =
      kind === 'endpoint'
        ? this.findStoredEndpoint(raw, index, candidateNames)
        : this.config?.[kind];

    const hasKey = Object.prototype.hasOwnProperty.call(raw, 'apiKey');
    if (!hasKey) {
      const nextBaseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl : '';
      if (stored !== undefined && stored.apiKey !== '' && originChanged(stored.baseUrl, nextBaseUrl)) {
        return {
          ok: false,
          code: 'key_required_for_new_origin',
          field: `${fieldBase}.apiKey`,
        };
      }
      return { ok: true, value: { ...raw, apiKey: stored?.apiKey ?? '' } };
    }

    const apiKey = raw.apiKey;
    if (apiKey === null) return { ok: true, value: { ...raw, apiKey: '' } };
    if (typeof apiKey === 'string' && isMaskedKey(apiKey)) {
      return { ok: false, code: 'masked_key', field: `${fieldBase}.apiKey` };
    }
    return { ok: true, value: raw };
  }

  /**
   * Matches by name so reordering the UI list keeps keys attached to their
   * endpoint; falls back to the same index only for a genuine rename.
   */
  private findStoredEndpoint(
    raw: Record<string, unknown>,
    index: number,
    candidateNames: ReadonlySet<string>,
  ): ModelsEndpoint | undefined {
    const config = this.config;
    if (config === null) return undefined;

    const name = typeof raw.name === 'string' ? raw.name : '';
    const byName = config.endpoints.find((entry) => entry.name === name);
    if (byName !== undefined) return byName;

    const atIndex = config.endpoints[index];
    if (atIndex !== undefined && !candidateNames.has(atIndex.name)) return atIndex;
    return undefined;
  }

  private runBuild(config: ModelsConfig): ConfigBuildResult {
    try {
      return this.build(config);
    } catch {
      return { ok: false, code: 'build_failed' };
    }
  }

  private commit(config: ModelsConfig, built: BuiltConfig): void {
    this.config = config;
    this.pool = built.pool;
    this.brain = built.brain;
    try {
      this.onCommit?.({ config, pool: built.pool, brain: built.brain });
    } catch (error) {
      this.log(`models commit handler failed: ${errorMessage(error)}`);
    }
  }

  private emitChange(): void {
    const config = this.config;
    const pool = this.pool;
    const brain = this.brain;
    if (config === null || pool === null || brain === null) return;
    try {
      this.onChange?.({ config, pool, brain });
    } catch (error) {
      this.log(`models change handler failed: ${errorMessage(error)}`);
    }
  }

  private async tryFile(filePath: string): Promise<FileResult> {
    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch (error) {
      return { ok: false, code: hasErrno(error, 'ENOENT') ? 'missing' : 'unreadable' };
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, code: 'invalid_json' };
    }

    const parsed = parseModelsConfig(json);
    if (!parsed.ok) return { ok: false, code: parsed.code };

    const built = this.runBuild(parsed.value);
    if (!built.ok) return { ok: false, code: built.code };

    return { ok: true, config: parsed.value, built };
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
      const parsed = parseModelsConfig(JSON.parse(text));
      if (!parsed.ok) return null;
      if (!this.runBuild(parsed.value).ok) return null;
      return text;
    } catch {
      return null;
    }
  }

  private async signature(): Promise<string | null> {
    try {
      const info = await stat(this.configPath);
      return `${info.mtimeMs}:${info.size}`;
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

  private async writeAtomic(contents: string): Promise<void> {
    await this.atomicWrite(this.configPath, contents);
    this.writeGeneration += 1;
    await this.refreshSignature();
  }

  /**
   * Temp file (0600) + rename. Used for both `models.json` and its backup so the
   * backup is never created through a partially written or world-readable file.
   */
  private async writeFileAtomic(targetPath: string, contents: string): Promise<void> {
    const suffix = randomBytes(6).toString('hex');
    const base = path.basename(targetPath);
    const tmp = path.join(this.configDir, `.${base}.${process.pid}.${suffix}.tmp`);

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
      this.log(`models.json reload rejected: ${loaded.code}; keeping the previous configuration`);
      return;
    }

    if (this.closed) return;

    this.lastSignature = signature;
    this.commit(loaded.config, loaded.built);
    this.log('models.json reloaded');
    this.emitChange();
  }

  private async poll(): Promise<void> {
    if (this.closed) return;
    const signature = await this.signature();
    if (signature === null || signature === this.lastSignature) return;
    this.scheduleReload();
  }
}
