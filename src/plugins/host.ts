/**
 * 进程内插件宿主。
 *
 * 宿主扫描插件目录、校验 manifest、动态 import 入口模块，并把受控的
 * api 注入插件。所有外部输入（目录缺失、manifest 非法、模块加载失败、
 * activate 抛错、路由不到）都只记日志，绝不让单个插件拖垮宿主。
 */

import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PerceptionEvent, PerceptionQueue } from '../core/events.js';
import { checkAction } from '../persona/redlines.js';
import { stripUnsafeControls } from '../util/tty.js';
import type { ControlPort } from '../control/types.js';
import type {
  ChannelPluginApiV1,
  PluginApiV1,
  PushEvent,
} from './api.js';
import { readManifest, type PluginKind, type PluginManifest } from './manifest.js';
import type {
  TranscriptRecord,
  TranscriptSink,
  TranscriptStatus,
} from '../web/transcript.js';

export type PluginState = 'loaded' | 'active' | 'failed' | 'stopped';

/** 重载前等待在途出站发送的上限：与关闭流程的 flush 上限一致。 */
const RELOAD_SEND_TIMEOUT_MS = 5_000;

export interface PluginStatus {
  name: string;
  kind: PluginKind;
  channelPrefix?: string;
  state: PluginState;
  error?: string;
}

export interface PluginHostDeps {
  queue: PerceptionQueue;
  brain: PluginApiV1['brain'];
  /**
   * 唯一 TTY 出口。第二个参数是渲染模式（行前缀）：可信日志省略即默认
   * '| '，模型输出显式传 '|> '；两种模式共用同一出口，不另开 sink。
   */
  log: (line: string, prefix?: string) => void;
  memory?: PluginApiV1['memory'];
  /** 对话记录出口：出站派发与被红线拦截的发送各记一行；缺省不记录。 */
  transcript?: TranscriptSink;
  /**
   * 控制面端口的逐插件授予点。核心接线只对 `name === 'qq'` 返回实例；
   * manifest 无权自称拥有控制权限。
   */
  control?: { forPlugin(name: string): ControlPort | undefined };
  /**
   * 插件工厂的额外实参。T5 用它把**同一个** `GroupGuard` 交给 qq 插件，
   * 让 `#安静`、`#状态` 与出站闸共用一份权威状态；缺省时 `createPlugin()`
   * 以无参调用，行为与 M2a 完全一致。
   */
  pluginFactoryArgs?: (name: string, kind: PluginKind) => unknown[] | undefined;
}

/**
 * 插件模块导出对象的宽松形状。渠道插件提供 send，能力插件通常只有
 * activate/deactivate；两者都可缺省，缺省项在调用点单独处理。
 */
interface PluginInstance {
  enabled?: () => boolean;
  activate?: (api: PluginApiV1 | ChannelPluginApiV1) => void | Promise<void>;
  deactivate?: () => void | Promise<void>;
  send?: (conversationKey: string, text: string) => void | Promise<void>;
}

interface PluginRecord {
  manifest: PluginManifest;
  state: PluginState;
  error?: string;
  instance?: PluginInstance;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 出站红线闸：先规范化，判定与投递用同一份字符串；被拦时不投递。
 *
 * 只有通道插件（进程内 api.send）走这条路径。能力插件不得发送——worker
 * 宿主直接拒绝 `send` rpc，它们只返回数据，说什么由 agent 决定。
 */
export async function gatedSend(
  text: string,
  deliver: (text: string) => void,
  log: (line: string) => void,
  pluginName: string,
  onBlocked?: (reason: string) => void,
): Promise<void> {
  const normalized = stripUnsafeControls(text);
  const verdict = checkAction({ kind: 'message_send', detail: normalized });
  if (!verdict.allowed) {
    const reason = verdict.reason ?? 'red-line violated';
    log(`plugin ${pluginName} outbound blocked: ${reason}`);
    onBlocked?.(reason);
    return;
  }
  deliver(normalized);
}

function isPluginInstance(value: unknown): value is PluginInstance {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 优先 `createPlugin()`，其次默认导出对象；都不满足返回 undefined。 */
async function resolvePluginInstance(
  module: Record<string, unknown>,
  args: readonly unknown[],
): Promise<PluginInstance | undefined> {
  const factory = module['createPlugin'];
  if (typeof factory === 'function') {
    const created: unknown = await (factory as (...factoryArgs: unknown[]) => unknown)(...args);
    return isPluginInstance(created) ? created : undefined;
  }
  const fallback = module['default'];
  return isPluginInstance(fallback) ? fallback : undefined;
}

export class PluginHost {
  private readonly queue: PerceptionQueue;
  private readonly brain: PluginApiV1['brain'];
  private readonly log: (line: string, prefix?: string) => void;
  private readonly memory: PluginApiV1['memory'];
  private readonly transcript: TranscriptSink | undefined;
  private readonly control: { forPlugin(name: string): ControlPort | undefined } | undefined;
  private readonly pluginFactoryArgs:
    | ((name: string, kind: PluginKind) => unknown[] | undefined)
    | undefined;
  private readonly plugins = new Map<string, PluginRecord>();
  /** 每个插件的重载串行链：两次保存不得交错执行停/启。 */
  private readonly reloadQueues = new Map<string, Promise<void>>();
  /** `stopAll()` 已开始：之后的 reload 一律忽略，绝不把关闭中的插件重新拉活。 */
  private stopping = false;
  /** 每个插件在途的 send promise；重载前有界等待，避免切断已派发的发送。 */
  private readonly inFlightSends = new Map<string, Set<Promise<void>>>();

  constructor(deps: PluginHostDeps) {
    this.queue = deps.queue;
    this.brain = deps.brain;
    this.log = deps.log;
    this.transcript = deps.transcript;
    this.control = deps.control;
    this.pluginFactoryArgs = deps.pluginFactoryArgs;
    this.memory =
      deps.memory ?? {
        search: async () => {
          this.log('plugin host: memory is not configured');
          return [];
        },
        write: async () => {
          this.log('plugin host: memory is not configured');
        },
      };
  }

  /** 扫描插件目录下每个子目录的 manifest.json；单个插件失败只记日志。 */
  async loadFrom(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      this.log(`plugin host: cannot read plugin directory ${dir}: ${describeError(error)}`);
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      await this.loadOne(join(dir, entry.name));
    }
  }

  private store(record: PluginRecord): void {
    if (this.plugins.has(record.manifest.name)) {
      this.log(
        `plugin host: duplicate plugin name ${record.manifest.name}, replacing previous record`,
      );
    }
    this.plugins.set(record.manifest.name, record);
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
      this.log(`plugin host: invalid manifest in ${pluginDir}: ${describeError(error)}`);
      return;
    }

    let instance: PluginInstance | undefined;
    try {
      const url = pathToFileURL(join(pluginDir, manifest.entry)).href;
      const module = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
      const args = this.pluginFactoryArgs?.(manifest.name, manifest.kind) ?? [];
      instance = await resolvePluginInstance(module, args);
    } catch (error) {
      const message = `failed to load plugin module: ${describeError(error)}`;
      this.store({ manifest, state: 'failed', error: message });
      this.log(`plugin host: ${manifest.name}: ${message}`);
      return;
    }

    if (instance === undefined) {
      const message = 'plugin module must export createPlugin() or a default plugin object';
      this.store({ manifest, state: 'failed', error: message });
      this.log(`plugin host: ${manifest.name}: ${message}`);
      return;
    }

    this.store({ manifest, state: 'loaded', instance });
  }

  /** 激活所有已加载插件；单个 activate 抛错只把该插件标记 failed。 */
  async startAll(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      // P1 没有重启路径：只有 loaded 会被激活，stopped/failed 保持原状。
      if (plugin.state !== 'loaded') continue;

      // 配置明确关闭：状态是 stopped（操作员的选择），不是 failed（激活出错）。
      if (plugin.instance?.enabled?.() === false) {
        plugin.state = 'stopped';
        delete plugin.error;
        this.log(`plugin host: ${plugin.manifest.name}: disabled by configuration`);
        continue;
      }

      const activate = plugin.instance?.activate;
      if (typeof activate !== 'function') {
        plugin.state = 'failed';
        plugin.error = 'plugin has no activate()';
        this.log(`plugin host: ${plugin.manifest.name}: plugin has no activate()`);
        continue;
      }

      try {
        await activate.call(plugin.instance, this.buildApi(plugin.manifest));
        plugin.state = 'active';
        delete plugin.error;
      } catch (error) {
        plugin.error = describeError(error);
        plugin.state = 'failed';
        this.log(`plugin host: ${plugin.manifest.name} failed to activate: ${plugin.error}`);
      }
    }

    this.warnDuplicatePrefixes();
  }

  /** 同一 channelPrefix 只可能路由到一个插件；重复时提示首条记录胜出。 */
  private warnDuplicatePrefixes(): void {
    const firstByPrefix = new Map<string, string>();
    for (const plugin of this.plugins.values()) {
      if (plugin.state !== 'active' || plugin.manifest.kind !== 'channel') continue;
      const prefix = plugin.manifest.channelPrefix;
      if (prefix === undefined) continue;

      const first = firstByPrefix.get(prefix);
      if (first === undefined) {
        firstByPrefix.set(prefix, plugin.manifest.name);
        continue;
      }
      this.log(
        `plugin host: duplicate channelPrefix ${prefix} (plugins ${first}, ${plugin.manifest.name}); ` +
          'routing uses the first',
      );
    }
  }

  /** 停用所有 active 插件；deactivate 抛错被吞掉，重复调用无副作用。 */
  async stopAll(): Promise<void> {
    // 从这一刻起 reload 一律无效：关闭期间落地的保存不得重新激活已停的插件。
    this.stopping = true;
    for (const plugin of this.plugins.values()) {
      if (plugin.state !== 'active') continue;

      const deactivate = plugin.instance?.deactivate;
      if (typeof deactivate === 'function') {
        try {
          await deactivate.call(plugin.instance);
        } catch (error) {
          this.log(
            `plugin host: ${plugin.manifest.name} failed to deactivate: ${describeError(error)}`,
          );
        }
      }
      plugin.state = 'stopped';
    }
  }

  /**
   * 热重载单个插件：先停用，再用同一实例重新激活。
   *
   * 实例不重建——插件从宿主注入的稳定门面（如 `RuntimeConfigHandle`）按次
   * 读取配置，重新 `activate` 就能拿到新值。装配点持有的护栏、控制状态与
   * 审批因此不随重载重置。失败只记日志并把状态标为 failed，绝不抛出：
   * 一次配置保存不能拖垮整个 harness。感知队列不受影响，已入队事件照常处理。
   *
   * 同一插件的重载串行执行：快速连续两次保存不会让一次重载的 `deactivate`
   * 拆掉另一次正在激活的实例。后一次重载重新读取最新配置，最终状态由最后
   * 一次成功/失败决定。
   */
  reload(name: string): Promise<void> {
    const previous = this.reloadQueues.get(name) ?? Promise.resolve();
    const run = previous.then(
      () => this.reloadNow(name),
      () => this.reloadNow(name),
    );
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.reloadQueues.set(name, tail);
    void tail.finally(() => {
      if (this.reloadQueues.get(name) === tail) this.reloadQueues.delete(name);
    });
    return run;
  }

  private async reloadNow(name: string): Promise<void> {
    if (this.stopping) {
      this.log(`plugin host: reload of ${name} ignored: host is stopping`);
      return;
    }

    const plugin = this.plugins.get(name);
    if (plugin === undefined) {
      this.log(`plugin host: cannot reload unknown plugin ${name}`);
      return;
    }

    // 先让在途出站发送收尾（有界）：deactivate 会拆掉发送路径，正在发送的
    // 消息不能被一次配置保存截断。等待期间可能开始关闭，需要再检查一次。
    await this.settleSends(name, RELOAD_SEND_TIMEOUT_MS);
    if (this.stopping) {
      this.log(`plugin host: reload of ${name} ignored: host is stopping`);
      return;
    }

    if (plugin.state === 'active') {
      const deactivate = plugin.instance?.deactivate;
      if (typeof deactivate === 'function') {
        try {
          await deactivate.call(plugin.instance);
        } catch (error) {
          this.log(
            `plugin host: ${name} failed to deactivate during reload: ${describeError(error)}`,
          );
        }
      }
      plugin.state = 'stopped';
    }

    const instance = plugin.instance;
    const activate = instance?.activate;
    if (instance === undefined || typeof activate !== 'function') {
      plugin.state = 'failed';
      plugin.error = 'plugin has no activate()';
      this.log(`plugin host: ${name}: plugin has no activate()`);
      return;
    }

    // 新配置明确关闭：stopped 是操作员的选择，不该显示成激活失败。
    if (instance.enabled?.() === false) {
      plugin.state = 'stopped';
      delete plugin.error;
      this.log(`plugin host: ${name}: disabled by configuration`);
      return;
    }

    try {
      await activate.call(instance, this.buildApi(plugin.manifest));
      plugin.state = 'active';
      delete plugin.error;
    } catch (error) {
      plugin.error = describeError(error);
      plugin.state = 'failed';
      this.log(`plugin host: ${name} failed to reactivate: ${plugin.error}`);
    }
  }

  /** 按最长匹配的 channelPrefix 路由；路由不到或插件未激活时记日志丢弃。
   *
   * `reason` 由调用方给出时写进派发行：红线改写路径用它标记
   * `reason:'redline-rewrite'`，因此一条改写回复只有**这一行** dispatched，
   * 循环不再另记（不变量 12 的审计顺序由循环先写 blocked 保证）。
   */
  send(channel: string, text: string, opts: { reason?: string } = {}): void {
    const target = this.route(channel);
    if (target === undefined) {
      this.log(`plugin host: no channel for ${channel}`);
      return;
    }

    const { manifest, instance, state } = target;
    if (state !== 'active') {
      this.log(`plugin host: plugin ${manifest.name} is ${state}, dropping message for ${channel}`);
      return;
    }

    const send = instance?.send;
    if (typeof send !== 'function') {
      this.log(`plugin host: plugin ${manifest.name} has no send()`);
      return;
    }

    // 通过路由与 active 检查后才记「已派发」；发送是 fire-and-forget，
    // 因此不承诺 delivered。记录只入队，不阻塞发送路径。
    this.recordOutbound({
      status: 'dispatched',
      channel,
      text,
      ...(opts.reason === undefined ? {} : { reason: opts.reason }),
    });

    try {
      const result = send.call(instance, channel, text);
      // Promise.resolve 同时覆盖原生 Promise 与 thenable。跟踪到完成，重载
      // 前有界等待：已派发的消息不能因为一次配置保存被 deactivate 截断。
      const settled = Promise.resolve(result).then(
        () => undefined,
        (error: unknown) => {
          this.log(`plugin host: plugin ${manifest.name} send failed: ${describeError(error)}`);
        },
      );
      this.trackSend(manifest.name, settled);
    } catch (error) {
      this.log(`plugin host: plugin ${manifest.name} send failed: ${describeError(error)}`);
    }
  }

  /** 记录一个在途发送；完成（成功或失败）后自动移除。 */
  private trackSend(name: string, settled: Promise<void>): void {
    let set = this.inFlightSends.get(name);
    if (set === undefined) {
      set = new Set();
      this.inFlightSends.set(name, set);
    }
    set.add(settled);
    void settled.then(() => {
      set.delete(settled);
      if (set.size === 0) this.inFlightSends.delete(name);
    });
  }

  /** 有界等待某插件的在途发送；超时后放弃等待，绝不拖住重载。 */
  private async settleSends(name: string, timeoutMs: number): Promise<void> {
    const set = this.inFlightSends.get(name);
    if (set === undefined || set.size === 0) return;

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref();
    });
    try {
      await Promise.race([
        Promise.allSettled([...set]).then(() => undefined),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** 出站记录：派发与红线拦截共用；记录失败只记日志，绝不影响发送。 */
  private recordOutbound(event: {
    status: TranscriptStatus;
    channel: string;
    text?: string;
    reason?: string;
  }): void {
    const transcript = this.transcript;
    if (transcript === undefined) return;
    const record: TranscriptRecord = {
      ts: new Date().toISOString(),
      direction: 'out',
      channel: event.channel,
      status: event.status,
      ...(event.text === undefined ? {} : { text: event.text }),
      ...(event.reason === undefined ? {} : { reason: event.reason }),
    };
    try {
      transcript.record(record);
    } catch (error) {
      this.log(`plugin host: transcript record failed: ${describeError(error)}`);
    }
  }

  private route(channel: string): PluginRecord | undefined {
    // 有意包含非 active 记录：stopped/failed 的渠道会被记日志，而不是静默落到更短的 prefix。
    let best: PluginRecord | undefined;
    let bestLength = -1;

    for (const plugin of this.plugins.values()) {
      const prefix = plugin.manifest.channelPrefix;
      if (prefix === undefined) continue;
      const matches = channel === prefix || channel.startsWith(`${prefix}:`);
      if (!matches) continue;
      if (prefix.length > bestLength) {
        best = plugin;
        bestLength = prefix.length;
      }
    }

    return best;
  }

  private buildApi(manifest: PluginManifest): PluginApiV1 | ChannelPluginApiV1 {
    const api: PluginApiV1 = {
      name: manifest.name,
      kind: manifest.kind,
      ...(manifest.channelPrefix === undefined ? {} : { channelPrefix: manifest.channelPrefix }),
      config: manifest.config === undefined ? {} : { ...manifest.config },
      log: (line) => this.log(line),
      // 模型输出走同一出口的不同渲染模式：不可信前缀 '|> '。
      reply: (text) => this.log(text, '|> '),
      brain: this.brain,
      memory: this.memory,
      send: async (channel, text) => {
        // 与核心循环同一道红线闸：先规范化，判定与出站用同一份字符串。
        // 闸放在 api 边界而非 host.send，因为循环路径已经自己判过。
        await gatedSend(
          text,
          (normalized) => this.send(channel, normalized),
          (line) => this.log(line),
          manifest.name,
          (reason) => this.recordOutbound({ status: 'blocked', channel, reason }),
        );
      },
    };

    if (manifest.kind !== 'channel') return api;

    // 渠道插件的 push 只能落在自己的命名空间：channel 必须是 prefix 本身
    // 或以 `${prefix}:` 开头，否则改写到 prefix，避免插件伪造其他渠道的事件。
    const channelPrefix = manifest.channelPrefix ?? manifest.name;

    // 控制权限逐插件授予；provider 抛错只记日志，插件照常激活（无控制面）。
    let control: ControlPort | undefined;
    if (this.control !== undefined) {
      try {
        control = this.control.forPlugin(manifest.name);
      } catch (error) {
        this.log(
          `plugin host: control provider failed for ${manifest.name}: ${describeError(error)}`,
        );
      }
    }

    return {
      ...api,
      ...(control === undefined ? {} : { control }),
      perception: {
        push: (event: PushEvent) => {
          const inNamespace =
            event.channel === channelPrefix || event.channel.startsWith(`${channelPrefix}:`);
          if (!inNamespace) {
            this.log(
              `plugin ${manifest.name}: event channel ${event.channel} coerced to ${channelPrefix}`,
            );
          }
          // PushEvent 的 kind/channel 是插件侧字符串；P1 信任已加载插件，
          // 直接补齐 id/ts 后入队。
          this.queue.push({
            id: this.queue.nextEventId(),
            ts: Date.now(),
            kind: event.kind,
            channel: inNamespace ? event.channel : channelPrefix,
            actor: event.actor,
            content: event.content,
            importance: event.importance,
            // kind/channel/importance 由插件提供且 P1 不做运行时校验（推迟到 P2）。
          } as PerceptionEvent);
        },
        requestWake: () => {
          this.queue.requestWake();
        },
      },
    };
  }

  status(): PluginStatus[] {
    return [...this.plugins.values()]
      .map((plugin) => ({
        name: plugin.manifest.name,
        kind: plugin.manifest.kind,
        ...(plugin.manifest.channelPrefix === undefined
          ? {}
          : { channelPrefix: plugin.manifest.channelPrefix }),
        state: plugin.state,
        ...(plugin.error === undefined ? {} : { error: plugin.error }),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
