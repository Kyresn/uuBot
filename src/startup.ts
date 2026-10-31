/**
 * 启动接线辅助：`src/index.ts` 只保留装配顺序，可测逻辑放在这里。
 *
 * - `createBrainBuilder`：ConfigStore 的 build 闭包。每次重建（加载、保存干跑、
 *   外部文件重载）都从上一次成功构建的池迁移端点健康状态，保存配置不会把
 *   退避/降级清零。
 * - 目录与网页选项：从环境读取，路径按 cwd 解析。
 */
import path from 'node:path';
import { stat } from 'node:fs/promises';
import type { Config, EndpointConfig } from './config.js';
import type { HarnessConfig, HarnessQqConfig } from './config/harness-schema.js';
import type { RuntimeConfigHandle } from './config/runtime-handle.js';
import { Brain, type BrainUsageEvent } from './brain/brain.js';
import {
  EndpointPool,
  migrateEndpointStates,
  type EndpointState,
} from './brain/endpoints.js';
import type { ConfigBuildResult, ConfigStore } from './config/store.js';
import type { ModelsConfig } from './config/models-schema.js';
import {
  createWebServer,
  type ReadinessSnapshot,
  type RouteHandler,
  type RouteKind,
  type WebServer,
  type WebServerOptions,
} from './web/server.js';
import type { PluginStatus } from './plugins/host.js';
import { gatedSend } from './plugins/host.js';
import type { PerceptionEvent } from './core/events.js';
import type { ApprovalEvent } from './approvals/types.js';
import { TranscriptWriter, type TranscriptSink } from './web/transcript.js';

export interface BrainBuilderOptions {
  /** 单次请求超时；传函数时每次请求读取（热生效的 `http.timeoutMs`）。 */
  timeoutMs: number | (() => number);
  onUsage?: (event: BrainUsageEvent) => void;
  /** 构建失败的诊断出口；缺省静默。 */
  log?: (line: string) => void;
}

export interface BuiltBrain {
  pool: EndpointPool;
  brain: Brain;
}

export interface BrainBuilder {
  build(models: ModelsConfig): ConfigBuildResult;
  /** 最近一次成功构建的池与 brain；尚未成功构建过时为 null。 */
  latest(): BuiltBrain | null;
  /**
   * 把健康迁移源推进到真正开始服务的池。只有 ConfigStore 的提交路径
   * （首次加载、保存落盘成功、外部重载）才应调用；干跑与写失败不得调用。
   */
  commit(pool: EndpointPool): void;
}

/**
 * 构建闭包：ConfigStore 在保存干跑、加载和外部重载时都调用它。
 * 健康状态只按 name+baseUrl+apiKey 迁移（见 `migrateEndpointStates`），
 * 因此改模型名或换端点不会带着旧退避，改密钥/域名会清零。
 *
 * `build` 可能只用于干跑（保存前的备份文件检查、写盘失败的候选），因此它
 * 绝不推进迁移源；迁移源只随 `commit` 前进，避免用未落盘的候选覆盖正在
 * 服务的池的健康状态。
 */
export function createBrainBuilder(opts: BrainBuilderOptions): BrainBuilder {
  let previous: EndpointPool | null = null;
  let latest: BuiltBrain | null = null;

  return {
    latest: () => latest,
    commit(pool) {
      previous = pool;
    },
    build(models) {
      try {
        const endpoints: EndpointConfig[] = models.endpoints;
        const states: Map<string, EndpointState> | undefined =
          previous === null ? undefined : migrateEndpointStates(previous, endpoints);
        const pool = new EndpointPool(
          endpoints,
          states === undefined ? {} : { initialStates: states },
        );
        const brain = new Brain(pool, {
          timeoutMs: opts.timeoutMs,
          ...(opts.onUsage === undefined ? {} : { onUsage: opts.onUsage }),
        });
        latest = { pool, brain };
        return { ok: true, pool, brain };
      } catch (error) {
        opts.log?.(
          `brain build failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { ok: false, code: 'build_failed' };
      }
    },
  };
}

/** 非端点设置来自 `.env`；chat 端点唯一来源是 `config/models.json`。 */
export function configWithEndpoints(settings: Config, models: ModelsConfig): Config {
  return { ...settings, endpoints: models.endpoints };
}

export function configDirFromEnv(env: NodeJS.ProcessEnv): string {
  const raw = env.CONFIG_DIR?.trim() ?? '';
  return path.resolve(raw === '' ? 'config' : raw);
}

/** 运行期状态目录（对话记录等）；默认 `./state`，启动时由写入器 mkdir。 */
export function dataDirFromEnv(env: NodeJS.ProcessEnv): string {
  const raw = env.DATA_DIR?.trim() ?? '';
  return path.resolve(raw === '' ? 'state' : raw);
}

/** `harness.json` 已接管的 env 键；迁移后不再参与运行期解析。 */
const HARNESS_OWNED_ENV_KEYS = [
  'TICK_FAST_MS',
  'TICK_SLOW_MS',
  'WAKE_DEBOUNCE_MS',
  'HTTP_TIMEOUT_MS',
  'REDLINE_FALLBACK_TEXT',
] as const;

/**
 * 交给 `loadConfig` 的 env 副本：去掉已迁移到 harness.json 的键。
 *
 * 这些值由 `HarnessStore` 首次导入一次；之后再从 env 解析会让一份被忽略的
 * 非法旧值（如 `TICK_FAST_MS=1.5`）继续阻断启动，与双源规则矛盾。
 */
export function settingsEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const key of HARNESS_OWNED_ENV_KEYS) delete copy[key];
  return copy;
}

/**
 * 是否已有可用的配置文件（`harness.json` 或它的 `.bak`）。
 *
 * 必须在 `HarnessStore.load()` 之前调用：首次加载会创建 `harness.json`。
 * `.bak` 也算数——加载会回退到它，此时 env 同样已被忽略。
 */
export async function harnessConfigSourceExists(configDir: string): Promise<boolean> {
  for (const file of ['harness.json', 'harness.json.bak']) {
    try {
      const info = await stat(path.join(configDir, file));
      if (info.isFile()) return true;
    } catch {
      // Try the next candidate.
    }
  }
  return false;
}

/**
 * 双源规则的一行静态日志（spec §3.3）：`harness.json` 存在时 `QQ_*` 环境
 * 变量不再被读取。只在 env 里确实还有 `QQ_*` 键时打印，避免每次启动都刷。
 */
export const QQ_ENV_IGNORED_NOTICE = 'QQ config comes from harness.json; QQ_* env is ignored';

/** env 里是否存在任何 `QQ_*` 键（不看值，空值也算「还配着」）。 */
export function hasQqEnvKeys(env: NodeJS.ProcessEnv): boolean {
  return Object.keys(env).some((key) => key.startsWith('QQ_'));
}

/** 需要打印双源提示时返回静态文本；否则 null。 */
export function qqEnvIgnoredNotice(
  env: NodeJS.ProcessEnv,
  harnessFileExists: boolean,
): string | null {
  return harnessFileExists && hasQqEnvKeys(env) ? QQ_ENV_IGNORED_NOTICE : null;
}

/**
 * 构造唯一的对话记录写入器。入站由 `PerceptionQueue.onPush` 记录，出站由
 * `PluginHost` 记录；关闭时由 `createShutdown` 有界 flush。
 */
export function createTranscript(
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
): TranscriptWriter {
  return new TranscriptWriter({
    file: path.join(dataDirFromEnv(env), 'transcript.jsonl'),
    log,
  });
}

/** 环境开关：1/true/yes 为真，其余为假。 */
export function envFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

/** IPv6 字面量必须加方括号才是合法 URL authority。 */
export function hostLabel(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/** 网页管理台的绑定参数；handler 由调用方注入，T5 在此之上替换。 */
export function webServerOptions(
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
): WebServerOptions {
  const hostRaw = env.WEB_HOST?.trim() ?? '';
  const host = hostRaw === '' ? '127.0.0.1' : hostRaw;

  const portRaw = env.WEB_PORT?.trim() ?? '';
  // 只接受纯十进制 1..65535；`0x10`/`3e3` 这类 Number() 宽松解析一律回退默认端口。
  const portValue = /^\d+$/.test(portRaw) ? Number(portRaw) : Number.NaN;
  const port =
    Number.isInteger(portValue) && portValue >= 1 && portValue <= 65535 ? portValue : 3080;

  // 反代部署的额外 Host/Origin 白名单：逗号分隔的 host[:port]。
  const allowedHosts = (env.WEB_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  return {
    host,
    port,
    token: env.WEB_CONSOLE_TOKEN ?? '',
    allowRemote: envFlag(env.WEB_ALLOW_REMOTE),
    secureCookie: envFlag(env.WEB_COOKIE_SECURE),
    trustedProxy: envFlag(env.WEB_TRUSTED_PROXY),
    allowedHosts,
    log,
  };
}

/**
 * 没有任何可用端点时的说明。
 *
 * `no_config` 不是致命错误：harness 照常启动（网页是主界面），用户在网页
 * 「模型」页添加端点即可，因此这条信息要指向网页而不是让进程退出。
 * 其它加载失败必须点名实际错误码（`unsupported_version`、`build_failed`、
 * `unreadable` 等），否则用户会按错误的方向排查。
 */
export function noEndpointsMessage(configDir: string, code = 'no_config'): string {
  const file = path.join(configDir, 'models.json');

  if (code === 'no_config' || code === 'missing') {
    return (
      `no usable chat endpoints: ${file} is missing or invalid. ` +
      'The harness still starts without endpoints: open the web console and add one in the ' +
      '模型 page (or restore models.json.bak). The next heartbeat picks it up without a restart.'
    );
  }

  const hint =
    code === 'unsupported_version'
      ? 'This harness only supports models.json version 1; fix the version field, then restart.'
      : code === 'build_failed'
        ? 'The endpoint definitions could not be built; fix them in models.json, then restart.'
        : code === 'unreadable'
          ? 'Check file permissions and that the path is a regular file, then restart.'
          : 'Fix models.json (the code above is the validation result) or restore models.json.bak, then restart.';

  return `no usable chat endpoints: ${file} could not be loaded (${code}). ${hint}`;
}

export interface WebConsoleDeps {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /** `/api/state` 的数据来源；缺省时该路由保持 501。 */
  state?: () => unknown;
  /** 其余 API 的挂载点（模型/对话/计划/架构）。 */
  routeHandlers?: Partial<Record<RouteKind, RouteHandler>>;
  /** `/api/health?deep=1` 的探针；缺省视为全部健康、静默 0 轮。 */
  readiness?: () => ReadinessSnapshot;
}

/**
 * 启动网页管理台。与心跳同进程运行：任何启动失败都只禁用网页并记日志，
 * harness 其余部分照常运行。返回的服务即使未启动，`stop()` 也是安全的空操作。
 */
export async function startWebConsole(deps: WebConsoleDeps): Promise<WebServer> {
  const options = webServerOptions(deps.env, deps.log);
  const server = createWebServer({
    ...options,
    ...(deps.state === undefined ? {} : { state: deps.state }),
    ...(deps.routeHandlers === undefined ? {} : { routeHandlers: deps.routeHandlers }),
    ...(deps.readiness === undefined ? {} : { readiness: deps.readiness }),
  });
  try {
    await server.start();
    deps.log(`web console: listening on http://${hostLabel(options.host)}:${server.port()}`);
  } catch (error) {
    deps.log(`web console disabled: ${error instanceof Error ? error.message : String(error)}`);
  }
  return server;
}

/**
 * `/api/state` 的 channels 列表：必须按请求从 `host.status()` 现算，
 * 启动时快照会让已停止/失败的渠道一直显示为可用。
 */
export function activeChannelLabels(plugins: readonly PluginStatus[]): string[] {
  return plugins
    .filter((plugin) => plugin.kind === 'channel' && plugin.state === 'active')
    .map((plugin) => plugin.channelPrefix ?? plugin.name);
}

export interface ShutdownDeps {
  log: (line: string) => void;
  webServer: WebServer;
  store: ConfigStore;
  /** `harness.json` 的持有者：先停 watcher，阻止关闭期间再触发重载。 */
  harnessStore: { close(): Promise<void> };
  /** 配置订阅（QQ 热重建）：退订，避免关闭期间重新激活插件。 */
  harnessReload: { stop(): void };
  loop: { stop(): Promise<void> };
  /** 控制面状态存储：等在途写入落盘。 */
  control: { stop(): Promise<void> };
  /** 审批服务：停扫描器 + flush 在途执行。 */
  approvals: { stop(): Promise<void> };
  /** 控制面审计流水：有界 flush 尾部记录。 */
  audit: { flush(timeoutMs?: number): Promise<void> };
  /** 主动私聊调度：清定时器。 */
  proactive: { stop(): void };
  host: { stopAll(): Promise<void> };
  registry: { stopAll(): Promise<void> };
  /** 网页对话桥接：宿主停完后关闭入站路径（此后 submit 返回 closed）。 */
  chatBridge: { close(): void };
  /** 对话记录写队列；关闭时在有界超时内 flush，避免丢尾部记录。 */
  transcript: { flush(timeoutMs?: number): Promise<void> };
}

export type ShutdownResult = 'done' | 'busy';

/** flush 的上限：磁盘/网络盘卡住时也不能拖住整个退出流程。 */
const TRANSCRIPT_FLUSH_TIMEOUT_MS = 5_000;

/**
 * 关闭序列（spec §9，顺序即契约）：停止接受写 → 控制面状态 → 热配置
 * watcher 与订阅 → `models.json` watcher → 心跳 → 主动调度 → flush 对话记录
 * → 审批（停扫描器 + flush 在途执行）→ 宿主 → 能力注册表 → 网页对话桥接
 * → 关闭网页。
 * 先停循环并等在途 tick 结束，再停宿主与 worker：否则 tick 的出站会打到已停的宿主上。
 * 审批在宿主之前停：在途 Applier 可能还需要注册表/宿主。
 * 热配置在宿主之前停：watcher 关闭、订阅退订后不会再有 `host.reload`。
 *
 * 重入时返回 `'busy'` 而不是静默完成：调用方据此不退出进程，让第一次关闭
 * 完整跑完（第二次信号不得跳过 loop/host/registry/web 的关闭）。
 */
export function createShutdown(
  deps: ShutdownDeps,
): (signal: string) => Promise<ShutdownResult> {
  let inFlight = false;
  return async (signal: string): Promise<ShutdownResult> => {
    if (inFlight) return 'busy';
    inFlight = true;
    deps.log(`shutting down on ${signal}`);
    deps.webServer.stopAcceptingWrites();
    await deps.control.stop();
    await deps.harnessStore.close();
    deps.harnessReload.stop();
    await deps.store.close();
    await deps.loop.stop();
    deps.proactive.stop();
    await deps.transcript.flush(TRANSCRIPT_FLUSH_TIMEOUT_MS);
    await deps.approvals.stop();
    await deps.audit.flush(TRANSCRIPT_FLUSH_TIMEOUT_MS);
    await deps.host.stopAll();
    await deps.registry.stopAll();
    deps.chatBridge.close();
    await deps.webServer.stop();
    return 'done';
  };
}

/**
 * 控制面 TTL（`CONTROL_*`）。非正整数一律回退默认值：控制面配置错误
 * 不应让 harness 起不来。
 */
export interface ControlTimings {
  /** `CONTROL_CONFIRM_TTL_MS`：`control.command` 二次确认窗口。 */
  confirmTtlMs: number;
  /** `CONTROL_APPROVAL_TTL_MS`：其余人工审批的默认 TTL。 */
  approvalTtlMs: number;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim() ?? '';
  if (!/^\d+$/.test(trimmed)) return fallback;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function controlTimingsFromEnv(env: NodeJS.ProcessEnv): ControlTimings {
  return {
    confirmTtlMs: positiveInt(env.CONTROL_CONFIRM_TTL_MS, 60_000),
    approvalTtlMs: positiveInt(env.CONTROL_APPROVAL_TTL_MS, 600_000),
  };
}

/** 主动私聊调度参数（`qq.proactive`），由装配点从 harness 配置映射后传给核心。 */
export interface ProactiveEnv {
  enabled: boolean;
  minGapMs: number;
  dailyMax: number;
  quietStart: string;
  quietEnd: string;
  intervalMs: number;
}

export interface QqRuntimeEnv {
  /** `qq.minReplyGapMs`；共享护栏用同一个值，避免装配点与插件口径分叉。 */
  minReplyGapMs: number;
  /** `qq.ownerId` 归一化后的十进制字符串；缺失/非法为 undefined。 */
  ownerId: string | undefined;
  /**
   * 控制面总开关（`qq.controlEnabled`）。与 QQ 插件同一套判定：没有 owner
   * 时开关为开也静默禁用。
   */
  controlEnabled: boolean;
  /**
   * 配置里明确关闭了控制面。只看开关本身，绝不从 owner 推导：否则没有
   * owner 的安装会被当成「显式关闭」，网页控制面被静默禁用。QQ 适配器
   * 的 owner 存在性闸在插件里单独判定。
   */
  controlExplicitOff: boolean;
  proactive: ProactiveEnv;
}

/**
 * 从已校验的 `qq` 配置段派生装配点所需的运行期参数。
 *
 * 迁移之后 `QQ_*` 环境变量不再参与运行期决策：`harness.json` 存在时 env
 * 被忽略，不存在时 `HarnessStore` 已经把它们导入一次。
 */
export function qqRuntimeFromConfig(config: HarnessQqConfig): QqRuntimeEnv {
  return {
    minReplyGapMs: config.minReplyGapMs,
    ownerId: config.ownerId === '' ? undefined : config.ownerId,
    controlEnabled: config.controlEnabled,
    controlExplicitOff: !config.controlEnabled,
    proactive: { ...config.proactive },
  };
}

/**
 * 网页控制面是否可用：只由显式开关决定。
 *
 * 没有 owner 的安装仍要能批准能力激活（R3），因此 owner 缺失不禁用网页；
 * 但 `controlEnabled: false` 是操作员的明确关闭，必须被遵守。
 */
export function controlSurfaceEnabled(config: HarnessQqConfig): boolean {
  return config.controlEnabled;
}

/**
 * 保存后无需重启即生效的配置段（spec §3.4）。这份清单与 `src/index.ts` 的
 * 消费者一一对应：
 * - `tick.*`：感知队列防抖与心跳档位按次读取；
 * - `http.timeoutMs`：`createBrainBuilder` 的 timeout 是 getter，每次请求读取；
 * - `redline.fallbackText`：心跳在下一条被拦回复时读取；
 * - `qq.*`：`createQqReloader` 在保存后触发一次 `host.reload('qq')`。
 *
 * 不在清单里的叶子按保守规则视为「需重启」：新增配置若尚未接线，设置页会
 * 如实标注，而不是静默地假装已生效。
 */
const HOT_APPLIED_SECTIONS = ['tick', 'http', 'redline', 'qq'] as const;

/** 元数据字段：只描述文件本身，不是可编辑的运行期参数。 */
const HARNESS_META_FIELDS = new Set(['version', 'importedFromEnv']);

function isHotApplied(path: string): boolean {
  return HOT_APPLIED_SECTIONS.some(
    (section) => path === section || path.startsWith(`${section}.`),
  );
}

/**
 * 由「热生效边界 + 配置的实际形状」推导 `requiresRestart`，而不是在 API 里
 * 硬编码字段名：配置新增叶子而没人接线时，它自然落进重启清单。
 */
export function requiresRestartFields(config: HarnessConfig): string[] {
  const leaves: string[] = [];
  const visit = (value: unknown, prefix: string): void => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      leaves.push(prefix);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      visit(child, prefix === '' ? key : `${prefix}.${key}`);
    }
  };
  visit(config, '');
  return leaves
    .filter((path) => !isHotApplied(path) && !HARNESS_META_FIELDS.has(path))
    .sort();
}

/** 只需要 `reload` 的宿主形状，便于测试注入假实现。 */
export interface ReloadableHost {
  reload(name: string): Promise<void>;
}

/**
 * 配置切换后的 QQ 热重建：只有 `qq` 段变化才触发一次 `host.reload('qq')`。
 *
 * `RuntimeConfigHandle.swap` 同步调用订阅者，重载本身是异步的；这里把重载
 * 串成一条链，快速连续保存不会并发进入插件。`PluginHost.reload` 自己也有
 * 逐插件串行链，两层都保证最终状态一致；失败只记日志。
 * 返回退订函数，关闭序列在停止宿主前调用。
 */
export function createQqReloader(
  handle: RuntimeConfigHandle,
  host: ReloadableHost,
  log: (line: string) => void,
): () => void {
  let previous = handle.get().qq;
  let queue: Promise<void> = Promise.resolve();
  return handle.subscribe((next) => {
    const changed = JSON.stringify(previous) !== JSON.stringify(next.qq);
    previous = next.qq;
    if (!changed) return;
    queue = queue
      .then(
        () => host.reload('qq'),
        () => host.reload('qq'),
      )
      .catch((error: unknown) => {
        log(`qq reload failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  });
}

/**
 * 启动时的一行控制面状态说明。关闭时返回静态、可操作的文本（绝不插值
 * 环境值）；开启时返回 null。让 owner 能区分「没配」和「配错了」。
 */
export function controlPlaneNotice(runtime: QqRuntimeEnv): string | null {
  if (runtime.controlExplicitOff) {
    return (
      'control plane disabled: qq.controlEnabled is off in harness.json; ' +
      'the web console control routes are disabled too'
    );
  }
  if (runtime.ownerId === undefined) {
    return (
      'QQ control disabled: qq.ownerId is missing or invalid in harness.json; ' +
      'the web console control surface is still available'
    );
  }
  return null;
}

/**
 * 渠道插件实际使用的会话前缀（manifest 的 `channelPrefix`，缺省为插件名）。
 * 出站闸与控制面都必须从同一处派生，避免硬编码 `qq` 与 manifest 漂移。
 */
export function channelPrefixOf(
  plugins: readonly PluginStatus[],
  name: string,
): string | undefined {
  const plugin = plugins.find((entry) => entry.name === name);
  if (plugin === undefined) return undefined;
  return plugin.channelPrefix ?? plugin.name;
}

export interface OutboundGateDeps {
  /** 渠道会话前缀（来自 manifest，而不是硬编码）。 */
  channelPrefix: string;
  /** 群聊护栏；`allow()` 是只读判定，不改变任何状态。 */
  guard: { allow(groupId: string): { ok: boolean } };
  /** 全局静默（保留群键 `'*'`）。 */
  isGloballySilenced: () => boolean;
}

/**
 * 心跳循环的出站闸。私聊只受全局静默约束（控制回执不走循环，因此豁免）；
 * 群聊复用 `GroupGuard`，让「被护栏丢弃的回复」在宿主记录之前就被拦下，
 * 与私聊静默保持一致：没离开循环的回复不写 dispatched 行。
 */
export function createOutboundGate(deps: OutboundGateDeps): (channel: string) => boolean {
  const privatePrefix = `${deps.channelPrefix}:private:`;
  const groupPrefix = `${deps.channelPrefix}:group:`;
  return (channel) => {
    if (channel.startsWith(privatePrefix)) return !deps.isGloballySilenced();
    if (channel.startsWith(groupPrefix)) {
      const groupId = channel.slice(groupPrefix.length);
      // 群号必须是纯数字；畸形键交回宿主按原路径处理（记录并尝试发送）。
      if (!/^\d{1,20}$/.test(groupId)) return true;
      return deps.guard.allow(groupId).ok;
    }
    return true;
  };
}

/**
 * 入站对话记录钩子：合成事件（`synthetic: true`）不是用户消息，跳过不记。
 * 记录失败只记日志，绝不影响入队。
 */
export function transcriptOnPush(
  transcript: TranscriptSink,
  log: (line: string) => void,
): (event: PerceptionEvent) => void {
  return (event) => {
    if (event.synthetic === true) return;
    try {
      transcript.record({
        ts: new Date(event.ts).toISOString(),
        direction: 'in',
        channel: event.channel,
        actor: event.actor,
        kind: event.kind,
        importance: event.importance,
        content: event.content,
      });
    } catch (error) {
      log(`queue: onPush failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

/**
 * 审批回执：网页决策后给 owner 发一条 QQ 私聊，让「另一通道显示已处理」
 * 在 QQ 侧也可见（spec §5）。
 *
 * - 只对 `decidedVia === 'web'` 的 `decided` 事件发：QQ 通道自己的决策已经
 *   由 router 回执，重复发会让 owner 收到两条。
 * - QQ 离线时把回执放进有界队列，`setConnected(true)` 后补发；发送失败只
 *   记日志——控制面回执绝不影响审批状态或心跳。
 * - 未配置 owner 时不订阅、不发送；owner 传函数时按次读取，热改后立即生效。
 */
export interface ApprovalNotifierDeps {
  approvals: { on(listener: (event: ApprovalEvent) => void): () => void };
  /** 已归一化的 owner；传函数时按次读取（`qq.ownerId` 可热改）。 */
  owner: string | undefined | (() => string | undefined);
  send: (channel: string, text: string) => Promise<void> | void;
  log: (line: string) => void;
  /**
   * 控制面总开关。传函数时按次读取（`qq.controlEnabled` 可热改），关闭期间
   * 不排队、不发送；显式关闭与 QQ 适配器同一语义。
   */
  enabled?: boolean | (() => boolean);
  /** 离线队列上限；默认 20 条，超出淘汰最旧。 */
  maxQueued?: number;
}

export interface ApprovalNotifier {
  setConnected(connected: boolean): void;
  stop(): void;
}

const APPROVAL_RECEIPT_QUEUE_MAX = 20;
/** 回执被红线闸拦下时的固定兜底；与 QQ 控制回执同一份文案。 */
const APPROVAL_RECEIPT_FALLBACK = '已处理。';

export function createApprovalNotifier(deps: ApprovalNotifierDeps): ApprovalNotifier {
  const maxQueued = deps.maxQueued ?? APPROVAL_RECEIPT_QUEUE_MAX;
  // 按次读取：保存 qq.controlEnabled / qq.ownerId 后，下一次决策立即生效。
  const enabledNow = (): boolean =>
    typeof deps.enabled === 'function' ? deps.enabled() : deps.enabled !== false;
  const ownerNow = (): string | undefined =>
    typeof deps.owner === 'function' ? deps.owner() : deps.owner;
  const queued: string[] = [];
  let connected = false;
  let stopped = false;

  /**
   * 回执与所有出站走同一道红线闸（不变量 11）：判定与投递用同一份规范化
   * 字符串；被拦时改用固定兜底，绝不把原文换成另一种说法重试。
   */
  const deliver = (text: string): void => {
    const owner = ownerNow();
    if (!enabledNow() || owner === undefined) return;
    const channel = `qq:private:${owner}`;
    try {
      void gatedSend(
        text,
        (normalized) => deps.send(channel, normalized),
        deps.log,
        'approval-notifier',
        () => deps.send(channel, APPROVAL_RECEIPT_FALLBACK),
      ).catch((error: unknown) => {
        deps.log(
          `approval receipt failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    } catch (error) {
      deps.log(
        `approval receipt failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  // 订阅始终保留（只要 owner 可能来自配置）：开关与 owner 都可能热改，
  // 退订后就再也收不到重新配置后的第一条回执。无效状态在处理器里丢弃。
  const ownerConfigured = typeof deps.owner === 'function' || deps.owner !== undefined;
  const unsubscribe = ownerConfigured
    ? deps.approvals.on((event) => {
        if (stopped || event.type !== 'decided') return;
        if (!enabledNow() || ownerNow() === undefined) return;
        const record = event.record;
        if (record.decidedVia !== 'web') return;
        // id/status 都是代码构造的受限值；不插入任何对端文本。
        const text = `审批 ${record.id} 已处理（${record.status}）。`;
        if (connected) {
          deliver(text);
          return;
        }
        queued.push(text);
        if (queued.length > maxQueued) queued.shift();
        deps.log(`approval receipt queued (qq offline): ${record.id}`);
      })
    : () => undefined;

  return {
    setConnected(next: boolean): void {
      connected = next;
      if (!next || stopped || !enabledNow() || ownerNow() === undefined) return;
      while (queued.length > 0) {
        const text = queued.shift();
        if (text !== undefined) deliver(text);
      }
    },
    stop(): void {
      stopped = true;
      unsubscribe();
      queued.length = 0;
    },
  };
}
