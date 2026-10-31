/**
 * 能力插件注册表与审批状态机。
 *
 * 注册表只负责能力插件（`kind === 'capability'`）的发现、审批与路由。
 * `loadFrom` 只扫描并记录：加载后一律 pending，绝不自动 spawn worker。
 * 激活是显式动作：只有 `activate` 才会创建 worker、跑保留工具 `__selfTest`，
 * 通过后进入 active 并把 worker 实际注册的工具暴露给 loop。入口
 * （capability-wiring）在启动时只为 pending 插件生成 `capability.activate`
 * 审批，绝不自动 spawn；`activate`/`ban`/`unban` 按插件名串行，并用代际
 * 计数防止 in-flight 激活覆盖并发的封禁。
 * banned 的插件保留记录与磁盘文件，但拒绝再次激活。
 *
 * 封禁名单默认在 `<loadFrom 的目录>/bans.json`，M2b 装配传入
 * `DATA_DIR/bans.json` 并配置旧路径做一次性迁移；文件存在但非法时
 * fail closed（拒绝激活任何能力插件）。
 *
 * 所有外部故障（目录缺失、manifest 非法、worker 启动/selfTest 失败）都
 * 只记日志并落到 failed，绝不让单个插件拖垮宿主。
 */

import { createHash } from 'node:crypto';
import { access, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CapabilityWorker, type WorkerHostDeps } from './worker-host.js';
import { readManifest, type PluginManifest, type PluginToolDef } from './manifest.js';

export type CapabilityState = 'pending' | 'active' | 'banned' | 'failed' | 'crashed' | 'stopped';

/** bootstrap 注册 selfTest 时使用的保留工具名。 */
export const SELF_TEST_TOOL = '__selfTest';

/** 注册表对外可见的插件记录。 */
export interface CapabilityEntry {
  name: string;
  state: CapabilityState;
  /** 对 loop 暴露的工具定义；pending 时为 manifest 声明，active 时为 worker 实际注册的子集。 */
  tools: PluginToolDef[];
  worker?: CapabilityWorker;
  error?: string;
}

/** status() 的行形状。 */
export interface CapabilityStatus {
  name: string;
  state: CapabilityState;
  error?: string;
}

export interface CapabilityRegistryOptions {
  /** 默认 `new CapabilityWorker(deps, manifest, dir)`；测试注入假 worker。 */
  workerFactory?: (manifest: PluginManifest, dir: string) => CapabilityWorker;
  /** 封禁名单文件；默认 `<loadFrom 的目录>/bans.json`（M2b 装配传入 `DATA_DIR/bans.json`）。 */
  banFile?: string;
  /**
   * 旧版封禁文件（`plugins/capabilities/bans.json`）。只有新路径不存在时读一次，
   * 读成功立即写新路径；此后只读新路径（spec R7）。
   */
  legacyBanFile?: string;
}

/** 能力插件的审批/激活所需描述；指纹覆盖 manifest.json 与 entry 的字节。 */
export interface CapabilityDescriptor {
  name: string;
  version: string;
  fingerprint: string;
  declaredPermissions: string[];
  toolNames: string[];
}

/** 内部记录：对外字段之外还要记住 manifest 与目录，激活时才 spawn。 */
interface StoredEntry extends CapabilityEntry {
  manifest: PluginManifest;
  dir: string;
  /** 激活在途标记：并发 activate 只允许一次 spawn。 */
  activating?: boolean;
  /**
   * 状态代际：每次 ban/unban/activate 变更状态前自增。in-flight 激活在
   * spawn/selfTest 结束后若发现代际已变，绝不把记录写回 active。
   */
  generation: number;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 读取文件字节；缺失/不可读按空字节处理（指纹随之变化，审批即 stale）。 */
async function readBytes(file: string): Promise<Buffer> {
  try {
    return await readFile(file);
  } catch {
    return Buffer.alloc(0);
  }
}

export class CapabilityRegistry {
  private readonly log: (line: string, prefix?: string) => void;
  private readonly workerFactory: (manifest: PluginManifest, dir: string) => CapabilityWorker;
  private readonly banFileOption: string | undefined;
  private readonly legacyBanFileOption: string | undefined;
  private readonly entries = new Map<string, StoredEntry>();
  /** 封禁名单（内存态，与 bans.json 同步）；显式封禁优先于重扫。 */
  private readonly bannedNames = new Set<string>();
  /** 解析后的封禁文件路径；首次 loadFrom 或显式配置时确定。 */
  private banFile: string | undefined;
  /** 封禁文件存在但不可读/非法：fail closed，拒绝激活任何能力插件。 */
  private bansInvalid = false;
  /** 按插件名的串行锁：activate/ban/unban 不交错。 */
  private readonly locks = new Map<string, Promise<void>>();

  constructor(deps: WorkerHostDeps, opts: CapabilityRegistryOptions = {}) {
    this.log = deps.log;
    this.workerFactory =
      opts.workerFactory ?? ((manifest, dir) => new CapabilityWorker(deps, manifest, dir));
    this.banFileOption = opts.banFile;
    this.legacyBanFileOption = opts.legacyBanFile;
  }

  /**
   * 扫描目录下每个含 manifest.json 的子目录。只收能力插件；渠道插件、
   * 非法 manifest 都记日志跳过，目录不存在只记日志不抛。
   *
   * 同时解析封禁名单（默认 `<dir>/bans.json`，可用构造参数覆盖）：
   * 文件里的名字一律置 banned，已加载的 active 记录也会被停掉。
   */
  async loadFrom(dir: string): Promise<void> {
    this.banFile = this.banFileOption ?? join(dir, 'bans.json');
    await this.loadBans();

    // 文件里新增的封禁对已加载记录同样生效；显式 ban 过的记录保持原样。
    for (const entry of this.entries.values()) {
      if (entry.state === 'banned') continue;
      if (this.bannedNames.has(entry.name)) await this.applyBan(entry);
    }

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      this.log(`capability registry: cannot read capability directory ${dir}: ${describeError(error)}`);
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      await this.loadOne(join(dir, entry.name));
    }
  }

  private async loadOne(pluginDir: string): Promise<void> {
    try {
      await access(join(pluginDir, 'manifest.json'));
    } catch {
      return; // 没有 manifest 的子目录不是插件，静默跳过。
    }

    let manifest: PluginManifest;
    try {
      manifest = await readManifest(pluginDir);
    } catch (error) {
      this.log(`capability registry: invalid manifest in ${pluginDir}: ${describeError(error)}`);
      return;
    }

    if (manifest.kind !== 'capability') {
      this.log(`capability registry: skipping ${manifest.name} (kind ${manifest.kind})`);
      return;
    }

    const existing = this.entries.get(manifest.name);
    // 封禁是显式决定：重扫不得把 banned 悄悄抬回 pending。
    if (existing !== undefined && existing.state === 'banned') {
      this.log(`capability registry: ${manifest.name} is banned, skipping reload`);
      return;
    }
    if (existing !== undefined) {
      this.log(
        `capability registry: duplicate plugin name ${manifest.name}, replacing previous record`,
      );
      await this.stopWorker(existing);
    }

    const banned = this.bannedNames.has(manifest.name);
    this.entries.set(manifest.name, {
      name: manifest.name,
      state: banned ? 'banned' : 'pending',
      tools: [...(manifest.tools ?? [])],
      manifest,
      dir: pluginDir,
      generation: 0,
    });
    if (banned) {
      this.log(`capability registry: ${manifest.name} banned (loaded from ban file)`);
    }
  }

  /**
   * 审批并启动插件：spawn → start → 调 `__selfTest`。任一环节失败都停掉
   * worker 并置 failed；banned 插件拒绝激活，active 重复激活无副作用。
   * 同一插件的 activate/ban/unban 按名串行；激活在途时并发的 ban 会先
   * 自增代际，激活收尾时发现代际变化就丢弃结果，绝不把记录写回 active。
   */
  async activate(name: string): Promise<void> {
    return this.withLock(name, () => this.activateLocked(name));
  }

  private async activateLocked(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (entry === undefined) {
      this.log(`capability registry: unknown plugin ${name}`);
      return;
    }
    // 封禁文件损坏时 fail closed：宁可全部不激活，也不把损坏解释成「无封禁」。
    if (this.bansInvalid) {
      this.log(
        `capability registry: ban file is invalid, refusing to activate ${name} (fail closed)`,
      );
      return;
    }
    if (entry.state === 'banned') {
      this.log(`capability registry: plugin ${name} is banned, refusing to activate`);
      return;
    }
    if (entry.state === 'active') {
      this.log(`capability registry: plugin ${name} is already active`);
      return;
    }
    if (entry.activating === true) {
      this.log(`capability registry: plugin ${name} activation already in progress`);
      return;
    }

    entry.activating = true;
    const generation = entry.generation;
    try {
      await this.doActivate(entry, generation);
    } finally {
      entry.activating = false;
    }
  }

  private async doActivate(entry: StoredEntry, generation: number): Promise<void> {
    const name = entry.name;

    let worker: CapabilityWorker;
    try {
      worker = this.workerFactory(entry.manifest, entry.dir);
    } catch (error) {
      await this.fail(entry, `failed to create worker: ${describeError(error)}`);
      return;
    }
    entry.worker = worker;

    let reported: string[];
    try {
      reported = await worker.start();
    } catch (error) {
      await this.fail(entry, `failed to start worker: ${describeError(error)}`);
      return;
    }

    try {
      const result = await worker.invokeTool(SELF_TEST_TOOL, {});
      if (!result) {
        await this.fail(entry, 'selfTest returned a falsy value');
        return;
      }
    } catch (error) {
      await this.fail(entry, `selfTest failed: ${describeError(error)}`);
      return;
    }

    // 竞态闸：激活期间发生了 ban/unban/重新加载，结果作废。
    if (entry.generation !== generation || entry.state === 'banned') {
      await this.stopWorker(entry);
      this.log(`capability registry: ${name} changed during activation, discarding the result`);
      return;
    }

    const reportedNames = new Set(reported.filter((tool) => tool !== SELF_TEST_TOOL));
    entry.tools = (entry.manifest.tools ?? []).filter((tool) => reportedNames.has(tool.name));
    entry.state = 'active';
    delete entry.error;
    this.log(`capability registry: ${name} active (${entry.tools.length} tools)`);
  }

  /**
   * 封禁：停 worker、置 banned、写封禁文件；记录与磁盘文件保留。
   * 代际在**入队前**自增：在途激活立刻看到变化，不必等锁。
   */
  async ban(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (entry !== undefined) entry.generation += 1;
    return this.withLock(name, async () => {
      const locked = this.entries.get(name);
      if (locked === undefined) {
        this.log(`capability registry: unknown plugin ${name}`);
        return;
      }

      await this.stopWorker(locked);
      locked.state = 'banned';
      delete locked.error;
      this.bannedNames.add(name);
      // 收窄已生效，但持久化失败必须让调用方知道（否则重启后封禁消失）。
      if (!(await this.writeBans())) throw new Error('bans.json write failed');
      this.log(`capability registry: ${name} banned`);
    });
  }

  /** 解封：从封禁文件移除、置回 pending，允许再次激活。 */
  async unban(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (entry !== undefined) entry.generation += 1;
    return this.withLock(name, async () => {
      this.bannedNames.delete(name);
      // 写不成功就不放宽：内存与磁盘必须一致。
      if (!(await this.writeBans())) {
        this.bannedNames.add(name);
        throw new Error('bans.json write failed');
      }

      const locked = this.entries.get(name);
      if (locked === undefined) {
        this.log(`capability registry: unknown plugin ${name}`);
        return;
      }

      if (locked.state === 'banned') locked.state = 'pending';
      delete locked.error;
      this.log(`capability registry: ${name} unbanned`);
    });
  }

  /** 按插件名串行化状态变更；失败不会卡住后续操作。 */
  private withLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(name) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(name, settled);
    void settled.then(() => {
      if (this.locks.get(name) === settled) this.locks.delete(name);
    });
    return run;
  }

  /**
   * 审批载荷所需的描述：版本、声明权限、工具名，以及覆盖 manifest.json 与
   * entry 字节的指纹。文件读不到时按空字节计算（结果必然与提案时不同）。
   */
  async describe(name: string): Promise<CapabilityDescriptor | null> {
    const entry = this.entries.get(name);
    if (entry === undefined) return null;

    const hash = createHash('sha256');
    hash.update(await readBytes(join(entry.dir, 'manifest.json')));
    hash.update('\u0000');
    hash.update(await readBytes(join(entry.dir, entry.manifest.entry)));
    return {
      name,
      version: entry.manifest.version,
      fingerprint: hash.digest('hex'),
      declaredPermissions: [...(entry.manifest.permissions ?? [])],
      toolNames: (entry.manifest.tools ?? []).map((tool) => tool.name),
    };
  }

  /**
   * 关停所有 worker：active 插件转入 stopped（工具随之不可见），
   * pending/banned/failed 保持原状态。重复调用无副作用。
   */
  async stopAll(): Promise<void> {
    // 先等在途的 activate/ban/unban 收尾：否则一个迟到的激活会在 stopAll
    // 之后把 worker 重新挂回来。
    await Promise.allSettled([...this.locks.values()]);
    for (const entry of this.entries.values()) {
      await this.stopWorker(entry);
      if (entry.state === 'active') entry.state = 'stopped';
    }
  }

  /**
   * 仅 active 且 worker 仍存活的插件工具定义，供 loop 传给 brain。
   * worker 崩溃后惰性标记 crashed：死插件的工具不再对外宣传。
   */
  getToolDefs(): PluginToolDef[] {
    const defs: PluginToolDef[] = [];
    for (const entry of this.entries.values()) {
      if (entry.state !== 'active') continue;
      if (this.workerUnavailable(entry)) {
        this.markCrashed(entry);
        continue;
      }
      defs.push(...entry.tools);
    }
    return defs;
  }

  /**
   * 只按 worker 实际上报的工具路由（与 getToolDefs 对外宣传的集合一致）；
   * manifest 声明不是授权：声明了但 worker 没注册的工具一律未知工具，
   * 非 active 插件同样不可调用。
   */
  async invokeTool(name: string, args: unknown): Promise<unknown> {
    for (const entry of this.entries.values()) {
      const registered = entry.tools.some((tool) => tool.name === name);
      if (!registered) continue;

      // 已崩溃（惰性标记过或 worker 刚死）的插件拒绝执行，而不是路由到别处。
      if (entry.state === 'crashed') {
        throw new Error(`tool unavailable: ${name}`);
      }
      if (entry.state !== 'active') continue;
      if (this.workerUnavailable(entry)) {
        this.markCrashed(entry);
        throw new Error(`tool unavailable: ${name}`);
      }

      const worker = entry.worker;
      if (worker === undefined) {
        throw new Error(`capability ${entry.name} has no worker`);
      }
      return await worker.invokeTool(name, args);
    }

    throw new Error(`unknown tool: ${name}`);
  }

  status(): CapabilityStatus[] {
    return [...this.entries.values()]
      .map((entry) => ({
        name: entry.name,
        state: entry.state,
        ...(entry.error === undefined ? {} : { error: entry.error }),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 从封禁文件把已加载记录转为 banned（会停掉在跑的 worker）。 */
  private async applyBan(entry: StoredEntry): Promise<void> {
    entry.generation += 1;
    await this.stopWorker(entry);
    entry.state = 'banned';
    delete entry.error;
    this.log(`capability registry: ${entry.name} banned (loaded from ban file)`);
  }

  /**
   * 读封禁文件并并入内存名单。
   *
   * - 新路径存在且合法 → 采用；
   * - 新路径存在但非法/不可读 → **fail closed**：`bansInvalid=true`，拒绝
   *   激活任何能力插件（旧实现静默返回空集，是 fail-open）；
   * - 新路径缺失且配置了旧路径 → 读旧路径一次，成功后立即写新路径（R7）；
   * - 都缺失 → 无封禁。
   */
  private async loadBans(): Promise<void> {
    // 每次加载都从「未判定」开始：上一次读到损坏文件不应让修复后的文件
    // 继续 fail closed（写路径成功后也会清这个标记）。
    this.bansInvalid = false;
    const file = this.banFile;
    if (file === undefined) return;

    const current = await this.readBanFile(file);
    if (current.status === 'ok') {
      for (const name of current.names) this.bannedNames.add(name);
      return;
    }
    if (current.status === 'invalid') {
      this.bansInvalid = true;
      this.log(
        `capability registry: invalid ban file ${file}: ${current.reason}; refusing to activate capability plugins (fail closed)`,
      );
      return;
    }

    const legacy = this.legacyBanFileOption;
    if (legacy === undefined || legacy === file) return;

    const previous = await this.readBanFile(legacy);
    if (previous.status === 'missing') return;
    if (previous.status === 'invalid') {
      this.bansInvalid = true;
      this.log(
        `capability registry: invalid legacy ban file ${legacy}: ${previous.reason}; refusing to activate capability plugins (fail closed)`,
      );
      return;
    }

    for (const name of previous.names) this.bannedNames.add(name);
    this.log(`capability registry: migrated ban file ${legacy} -> ${file}`);
    await this.writeBans();
  }

  /** 读取并校验封禁文件；区分「缺失」与「存在但不可用」。 */
  private async readBanFile(
    file: string,
  ): Promise<{ status: 'ok'; names: string[] } | { status: 'missing' } | { status: 'invalid'; reason: string }> {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
      return { status: 'invalid', reason: describeError(error) };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return { status: 'invalid', reason: describeError(error) };
    }
    if (!Array.isArray(parsed)) {
      return { status: 'invalid', reason: 'expected a JSON string array' };
    }
    // 数组里混入非字符串 = 文件已损坏。只取字符串会把 `["echo", 42]`
    // 读成「合法且只有 echo」，那是 fail open。
    if (parsed.some((name) => typeof name !== 'string')) {
      return { status: 'invalid', reason: 'expected a JSON string array' };
    }
    return { status: 'ok', names: parsed as string[] };
  }

  /**
   * 把内存名单排序后写回封禁文件；写失败只记日志。
   *
   * 原子写：同目录临时文件 + rename。直接覆盖会让并发读到的读者（重启时
   * 的 loadBans）看到半截 JSON 并丢掉整份封禁名单。
   */
  private async writeBans(): Promise<boolean> {
    const file = this.banFile;
    if (file === undefined) {
      this.log('capability registry: ban file is not configured; ban list not persisted');
      return false;
    }

    const names = [...this.bannedNames].sort();
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(temp, `${JSON.stringify(names, null, 2)}\n`, 'utf8');
      await rename(temp, file);
      // 显式写入成功 = 用一份已知名单修复了损坏文件，fail-closed 解除。
      this.bansInvalid = false;
      return true;
    } catch (error) {
      // 失败时尽力清掉临时文件，避免残留。
      try {
        await unlink(temp);
      } catch {
        // 临时文件可能根本没创建成功。
      }
      this.log(`capability registry: cannot write ban file ${file}: ${describeError(error)}`);
      return false;
    }
  }

  /** 置 failed 前先尽力停掉 worker；stop 失败只记日志。 */
  private async fail(entry: StoredEntry, error: string): Promise<void> {
    await this.stopWorker(entry);
    entry.state = 'failed';
    entry.error = error;
    this.log(`capability registry: ${entry.name} failed: ${error}`);
  }

  /** worker 侧已不可用：崩溃、启动失败或已停止。 */
  private workerUnavailable(entry: StoredEntry): boolean {
    const worker = entry.worker;
    if (worker === undefined) return false;
    const state = worker.state;
    return state === 'crashed' || state === 'failed' || state === 'stopped';
  }

  /** 惰性降级：只在首次发现时改状态并记一行日志，避免每次读都刷屏。 */
  private markCrashed(entry: StoredEntry): void {
    if (entry.state !== 'active') return;
    entry.state = 'crashed';
    this.log(`capability registry: ${entry.name} crashed, dropping from active set`);
  }

  private async stopWorker(entry: StoredEntry): Promise<void> {
    const worker = entry.worker;
    entry.worker = undefined;
    if (worker === undefined) return;

    try {
      await worker.stop();
    } catch (error) {
      this.log(`capability registry: ${entry.name} worker stop failed: ${describeError(error)}`);
    }
  }
}
