/**
 * 入口装配：ConfigStore → BrainHandle → 各层 → 插件宿主 → 能力注册表 → 心跳 → 信号退出。
 * 只做接线，不含业务逻辑。可信日志用 '| ' 前缀，模型输出用 '|> ' 前缀；
 * 共用同一 TTY 出口并经 sanitizeForTty 净化。
 *
 * M2b 的装配点（T5a）：
 * - 唯一 `ApprovalService` 实例（QQ 私聊与网页共用），`load()` 先于服务；
 * - 唯一 `ControlRouter`，赋给 `controlRouter.current`（漏接会让前缀指令永远回
 *   「控制面尚未启用」）；
 * - 共享 `GroupGuard`：`#安静`、`#状态`、出站闸与平台 notice 共用一份状态；
 * - 主动私聊调度器默认关闭（由 `src/startup.ts` 解析环境开关）。
 * 所有控制路径独立 try/catch：控制面故障只降级对应部分，绝不影响心跳。
 *
 * M2.6 的装配点：
 * - `HarnessStore` / `RuntimeConfigHandle` 先于所有消费者加载；保存成功后
 *   `swap`，订阅者据此重建 QQ 渠道；
 * - 心跳、唤醒防抖、HTTP 超时与红线兜底话术按次读取，保存后下一次使用生效；
 * - `qq` 段变化触发一次 `host.reload('qq')`，护栏与控制状态由本文件持有。
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig } from './config.js';
import { ConfigStore } from './config/store.js';
import { HarnessStore } from './config/harness-store.js';
import { RuntimeConfigHandle } from './config/runtime-handle.js';
import { BrainHandle } from './brain/handle.js';
import { createPersonaState } from './persona/persona.js';
import { PerceptionQueue } from './core/events.js';
import { createControlPort, createControlRouter, type ControlRouter } from './control/router.js';
import type { CapabilityControl } from './control/router.js';
import { ControlStateStore } from './control/state-store.js';
import { ControlAuditLog } from './control/audit-log.js';
import { buildStatusSnapshot } from './control/status.js';
import { ProactiveScheduler } from './core/proactive.js';
import { PluginHost } from './plugins/host.js';
import { GroupGuard } from '../plugins/channels/qq/guard.js';
import {
  activateCapabilityApproved,
  autoActivatePendingCapabilities,
  proposeCapabilityActivation,
  startCapabilities,
} from './plugins/capability-wiring.js';
import type { CapabilityRegistry } from './plugins/capability-registry.js';
import { toBrainToolDefs } from './plugins/tool-adapter.js';
import { HeartbeatLoop } from './core/loop.js';
import { sanitizeForTty } from './util/tty.js';
import { ApprovalService } from './approvals/service.js';
import type { ApplierHooks } from './approvals/appliers.js';
import { createModelsApi } from './web/models-api.js';
import { createConversationsApi } from './web/transcript.js';
import { createPlanApi } from './web/plan-api.js';
import { createArchitectureApi } from './web/architecture.js';
import { createControlApi } from './web/control-api.js';
import { WebChatBridge } from './web/chat-bridge.js';
import { createChatApi } from './web/chat-api.js';
import { createSettingsApi } from './web/settings-api.js';
import {
  activeChannelLabels, channelPrefixOf, configDirFromEnv, configWithEndpoints,
  controlPlaneNotice, controlSurfaceEnabled, controlTimingsFromEnv, createApprovalNotifier,
  createBrainBuilder, createOutboundGate, createQqReloader, createShutdown, createTranscript,
  dataDirFromEnv, harnessConfigSourceExists, noEndpointsMessage, qqEnvIgnoredNotice,
  qqRuntimeFromConfig, requiresRestartFields, settingsEnv, startWebConsole, transcriptOnPush,
  type ApprovalNotifier,
} from './startup.js';

// 目录按本模块位置解析而非 cwd（tsc 产物不复制 manifest.json，仅支持 tsx 运行源码）。
const PLUGINS_DIR = fileURLToPath(new URL('../plugins/channels', import.meta.url));
const CAPABILITIES_DIR = fileURLToPath(new URL('../plugins/capabilities', import.meta.url));

async function main(): Promise<void> {
  const log = (line: string, prefix = '| '): void => console.log(sanitizeForTty(line, prefix));

  // 热配置必须先加载：builder 的 timeout 与 QQ 参数都从 handle 按次读取。
  // 文件存在与否要在 load 之前判断——首次加载会创建它并写回 env 导入结果。
  const configDir = configDirFromEnv(process.env);
  const harnessFileExisted = await harnessConfigSourceExists(configDir);
  const harnessRef: { handle: RuntimeConfigHandle | null } = { handle: null };
  const harnessStore = new HarnessStore({
    configDir,
    env: process.env,
    log: (line) => log(line),
    // harness 配置不影响端点池构建；schema 已完成全部校验，干跑恒通过。
    build: () => ({ ok: true }),
    // 保存或外部重载成功后切换门面；消费者下一次读取即看到新值。
    onChange: (next) => harnessRef.handle?.swap(next),
  });
  const loadedHarness = await harnessStore.load();
  if (!loadedHarness.ok) {
    await harnessStore.close();
    throw new Error(`harness config could not be loaded (${loadedHarness.code})`);
  }
  const harness = new RuntimeConfigHandle(loadedHarness.config);
  harnessRef.handle = harness;
  harnessStore.watch();
  // 双源规则：文件存在（或本次就是从 env 导入的那一次）时 env 的 QQ 配置
  // 被忽略；只在 env 里确实还有这些键时提示。迁移那一次也必须提示，否则
  // 用户会以为继续改 .env 仍然有效。
  const ignoredQqEnv = qqEnvIgnoredNotice(
    process.env,
    harnessFileExisted || loadedHarness.config.importedFromEnv,
  );
  if (ignoredQqEnv !== null) log(ignoredQqEnv);

  // 非端点设置（并发/队列上限等）仍来自 .env；chat 端点唯一来源是 models.json。
  // 心跳间隔、HTTP 超时、红线话术与 QQ 参数改由 config/harness.json 持有，
  // 因此先从 env 副本里去掉这些键，避免旧值再次参与解析。
  const settings = loadConfig(settingsEnv(process.env), { requireEndpoints: false });

  const builder = createBrainBuilder({
    timeoutMs: () => harness.get().http.timeoutMs,
    log: (line) => log(line),
    onUsage: ({ endpoint, model, usage }) => {
      log(`${endpoint}/${model} tokens: in=${usage.promptTokens} out=${usage.completionTokens}`);
    },
  });

  // 启动顺序：ConfigStore 先加载（models.json → .bak → env 导入），再建池与门面。
  // onChange 只在保存/外部重载成功后触发；失败路径不 swap，旧 brain 继续服务。
  const runtime: { handle: BrainHandle | null } = { handle: null };
  const store = new ConfigStore({
    configDir,
    env: process.env,
    log: (line) => log(line),
    build: builder.build,
    // 迁移源只在真正提交后前进：干跑与写失败的候选不得覆盖服务中池的健康状态。
    onCommit: (change) => builder.commit(change.pool),
    onChange: (change) => runtime.handle?.swap(change.brain),
  });

  const loaded = await store.load();
  let initial = builder.latest();
  if (!loaded.ok || initial === null) {
    const code = loaded.ok ? 'build_failed' : loaded.code;
    // 没有端点不是致命错误：网页是主界面，用户可以在「模型」页添加。用一个
    // 空端点池的 brain 起步；循环在端点就绪前不 drain、不调用模型。
    if (code === 'no_config' || code === 'missing') {
      const empty = builder.build({ version: 1, importedFromEnv: false, endpoints: [] });
      if (empty.ok) {
        initial = { pool: empty.pool, brain: empty.brain };
        log(noEndpointsMessage(configDir, code));
      }
    }
    if (initial === null) {
      await harnessStore.close();
      await store.close();
      throw new Error(noEndpointsMessage(configDir, code));
    }
  }
  const handle = new BrainHandle(initial.brain);
  runtime.handle = handle;
  store.watch();

  // 初始值同时写入 Config：循环仍用它取非热字段（并发/队列上限），
  // 热字段由 handle 按次覆盖。没有 models.json 时用空端点集起步；模型页
  // 保存后 ConfigStore 的 onChange 会把 brain handle 换掉。
  const initialHarness = harness.get();
  const initialModels = loaded.ok
    ? loaded.config
    : { version: 1 as const, importedFromEnv: false, endpoints: [] };
  const config = {
    ...configWithEndpoints(settings, initialModels),
    tickFastMs: initialHarness.tick.fastMs,
    tickSlowMs: initialHarness.tick.slowMs,
    wakeDebounceMs: initialHarness.tick.wakeDebounceMs,
    httpTimeoutMs: initialHarness.http.timeoutMs,
    redlineFallbackText: initialHarness.redline.fallbackText,
  };
  const persona = createPersonaState(Math.random);
  const dataDir = dataDirFromEnv(process.env);
  // QQ 运行期参数一律来自 harness.json；env 只在首次导入时参与一次。
  const qqRuntime = qqRuntimeFromConfig(initialHarness.qq);
  // owner 也按次读取：保存 qq.ownerId 后回执与主动私聊立即换目标。
  const currentOwner = (): string | undefined => {
    const owner = harness.get().qq.ownerId;
    return owner === '' ? undefined : owner;
  };
  const timings = controlTimingsFromEnv(process.env);
  // 控制面被关闭时留一行可操作的说明：owner 要能区分「没配」与「配错」。
  const controlNotice = controlPlaneNotice(qqRuntime);
  if (controlNotice !== null) log(controlNotice);
  // 审计流水：每条指令 / 决策 / 执行各一行，关闭时由 createShutdown flush。
  const audit = new ControlAuditLog({
    file: path.join(dataDir, 'control-audit.jsonl'),
    log: (line) => log(line),
  });

  // 唯一写入器：入站（队列 onPush）与出站（插件宿主）共用，关闭时统一 flush。
  const transcript = createTranscript(process.env, (line) => log(line));
  // QQ 连接状态只由 `qq_connection` 感知事件驱动；主动私聊的「已连接」闸用它。
  const connection = { connected: false };
  // 审批回执在宿主构造后才有发送出口；连接事件可能更早到达，用引用桥接。
  const notifierRef: { current: ApprovalNotifier | null } = { current: null };
  const recordInbound = transcriptOnPush(transcript, (line) => log(line));
  const queue = new PerceptionQueue({
    // 按次读取：保存 tick.wakeDebounceMs 后下一次唤醒即生效。
    debounceMs: () => harness.get().tick.wakeDebounceMs,
    maxSize: config.maxQueueSize,
    log: (line) => log(line),
    // 入队时记录：之后被淘汰或静默重排的事件仍会出现在对话记录里。
    // 合成事件（主动私聊 tick）不是用户消息，跳过不记。
    onPush: (event) => {
      if (event.kind === 'qq_connection') {
        connection.connected = event.content === 'qq 已连接';
        notifierRef.current?.setConnected(connection.connected);
      }
      recordInbound(event);
    },
  });

  // ---- M2b 控制面装配（宿主构造前完成：QQ 一启动就可能来 owner 私聊） ----
  // 共享护栏：qq 插件通过宿主注入拿到同一个实例，`#安静`/`#状态`/出站闸
  // 与平台 notice 因此共用一份权威状态（不变量 13、22）。
  // 最小间隔用 getter：保存 qq.minReplyGapMs 后下一次 allow() 即生效。
  const guard = new GroupGuard({
    minGapMs: () => harness.get().qq.minReplyGapMs,
  });
  const controlState = new ControlStateStore({ dataDir, log: (line) => log(line) });
  try {
    await controlState.load();
    // 护栏状态往返：control-state.json → restoreOperatorState。
    guard.restoreOperatorState(controlState.operatorState());
  } catch (error) {
    // 控制面故障只降级控制面：护栏按空状态继续服务。
    log(`control state disabled: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 唯一审批实例：QQ 私聊与网页共用；load() 先于任何 propose/serve。
  // 三个可变引用先声明：Applier 与 status 快照都通过它们取装配后的实例。
  const registryRef: { current: CapabilityRegistry | null } = { current: null };
  const loopRef: { current: HeartbeatLoop | null } = { current: null };
  const controlRouter: { current: ControlRouter | null } = { current: null };
  const applierHooks: ApplierHooks = {
    executeControlCommand: async (record) =>
      controlRouter.current === null
        ? { ok: false, code: 'not_implemented' }
        : controlRouter.current.executeApproved(record),
    activateCapability: async (record) =>
      registryRef.current === null
        ? { ok: false, code: 'not_implemented' }
        : activateCapabilityApproved(registryRef.current, record),
  };
  const approvals = new ApprovalService({
    dataDir,
    log: (line) => log(line),
    ttl: {
      controlCommandMs: timings.confirmTtlMs,
      defaultMs: timings.approvalTtlMs,
    },
    hooks: applierHooks,
  });
  try {
    await approvals.load();
  } catch (error) {
    // 加载失败时审批服务以空状态继续：控制面可用性不阻断心跳。
    log(`approvals load failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 审批决策与执行结果写入审计流水（存储只留 pending，重启后靠这里追责）。
  const stopAuditSubscription = approvals.on((event) => {
    const record = event.record;
    try {
      if (event.type === 'decided' || event.type === 'expired') {
        audit.record({
          event: 'decision',
          id: record.id,
          kind: record.kind,
          decision: record.status,
          ...(record.decidedVia === undefined ? {} : { via: record.decidedVia }),
          ...(record.decidedBy === undefined ? {} : { by: record.decidedBy }),
          ...(record.decisionReason === undefined ? {} : { reason: record.decisionReason }),
        });
      } else if (event.type === 'executed') {
        audit.record({
          event: 'execution',
          id: record.id,
          ok: record.execution?.state === 'done',
          // 持久化失败时服务不会补发 decided 事件：把决策者带在执行行里，
          // 审计仍然能回答「谁批的」。
          ...(record.decidedVia === undefined ? {} : { via: record.decidedVia }),
          ...(record.decidedBy === undefined ? {} : { by: record.decidedBy }),
          ...(record.execution?.error === undefined ? {} : { error: record.execution.error }),
        });
      }
    } catch (error) {
      log(`control audit failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // 能力控制适配：`#封禁` 收窄权限；`#解封` 只清封禁，激活另起一条审批。
  const capabilityControl: CapabilityControl = {
    status: () => registryRef.current?.status() ?? [],
    ban: async (name) => {
      await registryRef.current?.ban(name);
    },
    unban: async (name) => {
      await registryRef.current?.unban(name);
    },
    requestActivation: async (name, meta) => {
      const registry = registryRef.current;
      if (registry === null) return { ok: false, code: 'not_implemented' };
      try {
        const result = await proposeCapabilityActivation(
          registry,
          approvals,
          name,
          // 谁发起的就记谁：`#解封` 的审批不能一律记成 system。
          meta ?? { createdVia: 'system', createdBy: 'control' },
        );
        return result.ok ? { ok: true, id: result.id } : { ok: false, code: result.code };
      } catch (error) {
        return {
          ok: false,
          code: error instanceof Error ? error.message : 'conflict',
        };
      }
    },
  };

  // 已知群 = 护栏见过的群 ∪ 有操作员状态的群。NL 只允许对已知目标提案。
  const isKnownGroup = (groupId: string): boolean =>
    groupId === '*' ||
    guard.snapshot().some((entry) => entry.groupId === groupId) ||
    controlState.snapshot().groups[groupId] !== undefined;

  // `#状态`、`GET /api/control` 与网页控制页共用同一份只读快照。
  const statusSnapshot = () =>
    buildStatusSnapshot({
      state: controlState,
      approvals,
      plugins: () => host.status(),
      capabilities: () => registryRef.current?.status() ?? [],
      channels: () =>
        host
          .status()
          .filter((plugin) => plugin.kind === 'channel')
          .map((plugin) => ({
            name: plugin.channelPrefix ?? plugin.name,
            state: plugin.state,
            ...(plugin.name === 'qq' ? { connected: connection.connected } : {}),
          })),
      heartbeat: () => {
        const status = loopRef.current?.status();
        return {
          silentRounds: status?.silentRounds ?? 0,
          inFlight: status?.inFlight ?? false,
          nextFastMs: loopRef.current?.nextFastMs() ?? config.tickFastMs,
        };
      },
      queueSize: () => queue.size(),
      endpoints: () => handle.snapshot(),
      guard: () => guard.snapshot(),
    });

  controlRouter.current = createControlRouter({
    approvals,
    state: controlState,
    guard,
    capabilities: capabilityControl,
    status: statusSnapshot,
    brain: handle,
    log: (line) => log(line),
    isKnownGroup,
    audit,
  });
  const controlApi = createControlApi({
    approvals,
    status: statusSnapshot,
    router: () => controlRouter.current,
    // 网页只受显式开关约束：没有 owner 的安装仍要能批准能力激活。
    // getter：保存 qq.controlEnabled 后下一次请求即生效。
    enabled: () => controlSurfaceEnabled(harness.get().qq),
    log: (line) => log(line),
  });
  // ---- M2b 控制面装配结束 ----

  // 宿主拥有全部渠道：日志与插件输出走同一 TTY 出口，memory 由宿主兜底。
  // 控制端口逐插件授予，只给 qq：manifest 不能自称拥有控制权限。
  // 共享护栏同样只交给 qq：`createPlugin({ guard })` 是 T3 已有的注入点。
  const controlPort = createControlPort({
    getRouter: () => controlRouter.current,
    log: (line) => log(line),
  });
  // 网页对话的唯一桥接：插件（入站/出站）与 HTTP API 共用同一个实例。
  // 只存内存；关闭序列里由 createShutdown 关闭。
  const chatBridge = new WebChatBridge();
  const host = new PluginHost({
    queue,
    brain: handle,
    log,
    transcript,
    control: { forPlugin: (name) => (name === 'qq' ? controlPort : undefined) },
    // 同一个护栏 + 同一个配置门面：重载后插件仍读最新配置，护栏状态不丢。
    // web 拿到同一个桥接，网页与插件看到的是同一份对话。
    pluginFactoryArgs: (name) => {
      if (name === 'qq') return [{ guard, config: harness }];
      if (name === 'web') return [{ bridge: chatBridge }];
      return undefined;
    },
  });
  await host.loadFrom(PLUGINS_DIR);
  await host.startAll();
  // qq 段变化 → 停插件再用新配置重激活；其他段的保存不重建通道。
  const stopQqReload = createQqReloader(harness, host, (line) => log(line));
  for (const plugin of host.status()) log(`plugin ${plugin.name}: ${plugin.state}`);
  if (activeChannelLabels(host.status()).length === 0) {
    log('no active channel plugins; the agent cannot send anything');
  }

  // 网页决策后补一条 QQ 回执；离线时排队，连接事件恢复后补发。
  const approvalNotifier = createApprovalNotifier({
    approvals,
    owner: currentOwner,
    send: (channel, text) => host.send(channel, text),
    log: (line) => log(line),
    // getter：保存 qq.controlEnabled 后下一条决策即按新开关处理。
    enabled: () => harness.get().qq.controlEnabled,
  });
  notifierRef.current = approvalNotifier;
  approvalNotifier.setConnected(connection.connected);

  // 能力注册表在通道之后装配；只加载并生成激活审批，绝不自动 spawn。
  const registry = await startCapabilities({
    brain: handle,
    log,
    dir: CAPABILITIES_DIR,
    dataDir,
    approvals,
  });
  registryRef.current = registry;

  // `capability.autoActivate` 是启动期决策（设置页标「需重启」）。必须在
  // registryRef 指向注册表之后批准：applier 通过它执行激活与指纹复核。
  if (initialHarness.capability.autoActivate) {
    const approved = await autoActivatePendingCapabilities(approvals, (line) => log(line));
    if (approved > 0) {
      const active = registry.status().filter((entry) => entry.state === 'active').length;
      log(`capability auto-activate: ${approved} approved, ${active} active`);
    }
  }

  // 出站闸：前缀来自 manifest（channelPrefix），群聊复用同一个护栏，
  // 私聊受全局静默约束。被丢弃的回复不写 dispatched 行。
  const qqPrefix = channelPrefixOf(host.status(), 'qq') ?? 'qq';
  const outboundGate = createOutboundGate({
    channelPrefix: qqPrefix,
    guard,
    isGloballySilenced: () => controlState.isSilenced('*'),
  });

  const loop = new HeartbeatLoop({
    config,
    // tick.fastMs / tick.slowMs / redline.fallbackText 每次使用时读取。
    runtimeConfig: harness,
    // 没有端点时（首次启动、尚未在模型页配置）循环只记一行状态，不调模型。
    endpointsAvailable: () => handle.snapshot().some((endpoint) => endpoint.enabled),
    queue,
    brain: handle,
    persona,
    channels: { send: (channel, text, opts) => host.send(channel, text, opts) },
    tools: {
      getToolDefs: () => toBrainToolDefs(registry.getToolDefs()),
      invokeTool: (name, args) => registry.invokeTool(name, args),
    },
    // 红线改写在生产里必须是活的：模板选择用同一 brain，兜底话术来自 env。
    refusal: handle,
    outboundGate,
    transcript,
    log,
  });
  loopRef.current = loop;

  const proactive = new ProactiveScheduler({
    // 构造期兜底；实际参数每次判定与每次 start() 都从 config getter 读取。
    enabled: qqRuntime.proactive.enabled,
    config: () => harness.get().qq.proactive,
    owner: currentOwner,
    isConnected: () => connection.connected,
    queueSize: () => queue.size(),
    inFlight: () => loop.status().inFlight,
    silentRounds: () => loop.status().silentRounds,
    // 全局静默时连 tick 都不合成：不烧模型调用、不递增日计数。
    isGloballySilenced: () => controlState.isSilenced('*'),
    state: controlState,
    queue,
    log: (line) => log(line),
  });

  loop.start();
  proactive.start();
  // 保存后重新对齐调度器：enabled 翻转时建/停定时器，周期变化时重建。
  const stopProactiveReconfigure = harness.subscribe(() => proactive.start());
  log(`startup: ${config.endpoints.length} endpoint(s); fast=${initialHarness.tick.fastMs}ms slow=${initialHarness.tick.slowMs}ms`);

  // ---- 网页管理台（append-only 区块；后续任务只替换注入的 handler） ----
  // 与心跳同进程运行：启动失败只禁用网页。状态与模型 API 共用同一份实时快照。
  const modelsApi = createModelsApi({
    store,
    endpoints: () => handle.snapshot(),
    silentRounds: () => loop.status().silentRounds,
    nextFastMs: () => loop.nextFastMs(),
    inFlight: () => loop.status().inFlight,
    queueSize: () => queue.size(),
    plugins: () => host.status(),
    capabilities: () => registry.status(),
    // 每个请求现算：已停止/失败的渠道必须从列表里消失。
    channels: () => activeChannelLabels(host.status()),
  });
  const planApi = createPlanApi({
    dataDir,
    log: (line) => log(line),
  });
  const architectureApi = createArchitectureApi({
    endpoints: () => handle.snapshot(),
    queueSize: () => queue.size(),
    silentRounds: () => loop.status().silentRounds,
    inFlight: () => loop.status().inFlight,
    plugins: () => host.status(),
    capabilities: () => registry.status(),
  });
  // 对话 API 与 web 插件共用同一个桥接：网页发出的消息就是插件推入队列的事件。
  const chatApi = createChatApi({
    bridge: chatBridge,
    log: (line) => log(line),
  });
  // 设置 API 与装配点共用同一份热生效边界：需重启字段由 startup 推导。
  const settingsApi = createSettingsApi({
    store: harnessStore,
    requiresRestart: requiresRestartFields,
    log: (line) => log(line),
  });
  const webServer = await startWebConsole({
    env: process.env,
    log: (line) => log(line),
    state: modelsApi.state,
    // deep 探针现算：flash 端点的可用性与心跳静默轮数都随运行期变化。
    readiness: () => ({
      allDegraded: handle.readiness().allDegraded,
      silentRounds: loop.status().silentRounds,
    }),
    routeHandlers: {
      ...modelsApi.handlers,
      conversations: createConversationsApi({ file: transcript.file }),
      ...planApi.handlers,
      ...architectureApi.handlers,
      ...controlApi.handlers,
      ...chatApi.handlers,
      ...settingsApi.handlers,
    },
  });
  // ---- 网页管理台区块结束 ----

  const shutdown = createShutdown({
    log: (line) => log(line),
    webServer,
    store,
    // 先停热配置 watcher 与订阅，再停消费者：关闭期间不得再触发 reload。
    harnessStore,
    harnessReload: {
      stop: () => {
        stopQqReload();
        stopProactiveReconfigure();
      },
    },
    loop,
    // 关闭前把护栏的操作员状态（静默 + 平台观察）落盘，再等在途写入完成。
    control: {
      stop: async () => {
        try {
          await controlState.replaceOperatorState(guard.exportOperatorState());
        } catch (error) {
          log(`control state export failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        await controlState.stop();
      },
    },
    approvals: {
      stop: async () => {
        notifierRef.current?.stop();
        // 先等在途执行收尾并落审计，再退订：否则关闭期间完成的 executed
        // 事件会丢一行。flush 由 createShutdown 在本步之后执行。
        await approvals.stop();
        stopAuditSubscription();
      },
    },
    audit,
    proactive,
    host,
    registry,
    transcript,
    // 宿主停完之后再关闭桥接：此后任何 submit 都返回 closed。
    chatBridge,
  });
  // 第二次信号只返回 'busy'：绝不能让它提前 process.exit 而截断关闭序列。
  const onSignal = (signal: string): void => {
    void shutdown(signal)
      .then((result) => {
        if (result === 'done') process.exit(0);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        log(`shutdown failed: ${message}`);
        process.exit(1);
      });
  };
  // 用 on 而非 once：同一信号的第二次按下必须被吞掉并等待第一次关闭完成，
  // 否则 Node 的默认处理会立即终止进程。
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
}

void main().catch((error: unknown) => {
  // 错误信息同样是不可信文本（可能含端点返回内容），走同一 TTY 中和。
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(sanitizeForTty(message));
  process.exit(1);
});
