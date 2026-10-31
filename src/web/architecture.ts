/**
 * 架构 API：`GET /api/architecture`。
 *
 * 返回静态架构图（节点/边）+ 每个节点的实时状态快照。图本身是代码常量：
 * 新增核心模块时才改这里；实时部分全部来自注入的只读回调，因此本模块
 * 不持有任何运行期状态，也不会因为网页请求影响心跳。
 */
import type { RouteHandler } from './server.js';

export type ArchitectureNodeKind = 'input' | 'core' | 'plugin' | 'planned' | 'ui';

export interface ArchitectureNode {
  id: string;
  label: string;
  kind: ArchitectureNodeKind;
  /** 前端按层从上到下渲染；数字越大越靠近执行末端。 */
  layer: number;
  planned?: boolean;
}

export interface ArchitectureEdge {
  from: string;
  to: string;
  label?: string;
  planned?: boolean;
}

export type ArchitectureNodeState = 'ok' | 'degraded' | 'planned' | 'unknown';

export interface ArchitectureNodeStatus {
  state: ArchitectureNodeState;
  detail: string;
}

export interface ArchitectureSnapshot {
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  status: Record<string, ArchitectureNodeStatus>;
}

export interface ArchitectureDeps {
  /** 当前 live 池的端点健康快照。 */
  endpoints: () => unknown;
  queueSize: () => number;
  silentRounds: () => number;
  inFlight: () => boolean;
  /** 渠道/能力插件状态。 */
  plugins: () => unknown;
  capabilities: () => unknown;
}

export interface ArchitectureApi {
  handlers: {
    architecture: RouteHandler;
  };
}

const NODES: readonly ArchitectureNode[] = [
  { id: 'plugins', label: '渠道插件', kind: 'plugin', layer: 0 },
  { id: 'web', label: '网页管理台', kind: 'ui', layer: 0 },
  { id: 'queue', label: '感知队列', kind: 'input', layer: 1 },
  { id: 'loop', label: '心跳循环', kind: 'core', layer: 2 },
  { id: 'brain', label: '大脑（故障转移）', kind: 'core', layer: 3 },
  { id: 'capabilities', label: '能力插件', kind: 'plugin', layer: 3 },
  { id: 'memory', label: '记忆层（计划）', kind: 'planned', layer: 3, planned: true },
  { id: 'endpoints', label: 'LLM 端点', kind: 'input', layer: 4 },
];

const EDGES: readonly ArchitectureEdge[] = [
  { from: 'plugins', to: 'queue', label: '入站事件' },
  { from: 'queue', to: 'loop', label: '唤醒' },
  { from: 'loop', to: 'brain', label: '推理' },
  { from: 'brain', to: 'endpoints', label: '故障转移' },
  { from: 'loop', to: 'plugins', label: '出站发送' },
  { from: 'loop', to: 'capabilities', label: '工具往返' },
  { from: 'web', to: 'loop', label: '只读快照' },
  { from: 'memory', to: 'loop', label: 'M3', planned: true },
];

function asRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry),
  );
}

function endpointStatus(endpoints: unknown): ArchitectureNodeStatus {
  const records = asRecords(endpoints);
  const enabled = records.filter((entry) => entry['enabled'] === true);
  const degraded = enabled.filter((entry) => entry['degraded'] === true).length;

  if (enabled.length === 0) {
    return { state: 'degraded', detail: '没有启用的端点' };
  }
  return {
    state: degraded > 0 ? 'degraded' : 'ok',
    detail:
      `${enabled.length} 启用 / ${records.length} 端点` +
      (degraded > 0 ? `，${degraded} 降级` : ''),
  };
}

function pluginStatus(plugins: unknown): ArchitectureNodeStatus {
  const records = asRecords(plugins);
  const active = records.filter((entry) => entry['state'] === 'active').length;
  return {
    state: active > 0 ? 'ok' : 'degraded',
    detail: `${active}/${records.length} 活跃`,
  };
}

/** 需要单独计数的异常能力状态；`pending`/`stopped` 只反映在活跃比里。 */
const CAPABILITY_PROBLEM_STATES = ['failed', 'crashed', 'banned'] as const;

function capabilityStatus(capabilities: unknown): ArchitectureNodeStatus {
  const records = asRecords(capabilities);
  if (records.length === 0) {
    return { state: 'ok', detail: '未加载能力插件' };
  }

  const active = records.filter((entry) => entry['state'] === 'active').length;
  const problems = CAPABILITY_PROBLEM_STATES.map((state) => {
    const count = records.filter((entry) => entry['state'] === state).length;
    return count === 0 ? '' : `${count} ${state}`;
  }).filter((part) => part !== '');

  return {
    // 有任何能力不是 active（失败/崩溃/封禁，或尚未激活）都说明能力面不完整。
    state: active === records.length ? 'ok' : 'degraded',
    detail: `${active}/${records.length} 活跃${problems.length === 0 ? '' : `，${problems.join(' / ')}`}`,
  };
}

export function createArchitectureApi(deps: ArchitectureDeps): ArchitectureApi {
  const architecture: RouteHandler = (ctx) => {
    const endpoint = endpointStatus(deps.endpoints());
    const plugins = pluginStatus(deps.plugins());
    const capabilities = capabilityStatus(deps.capabilities());
    const inFlight = deps.inFlight();

    const snapshot: ArchitectureSnapshot = {
      nodes: NODES.map((node) => ({ ...node })),
      edges: EDGES.map((edge) => ({ ...edge })),
      status: {
        plugins,
        web: { state: 'ok', detail: '本页面（同进程）' },
        queue: { state: 'ok', detail: `队列 ${deps.queueSize()} 条` },
        loop: {
          state: 'ok',
          detail: `静默 ${deps.silentRounds()} 轮${inFlight ? ' · tick 在途' : ''}`,
        },
        brain: {
          state: endpoint.state,
          detail: `故障转移 · ${endpoint.detail}`,
        },
        capabilities,
        memory: { state: 'planned', detail: 'M3：SQLite/Postgres + 混合检索' },
        endpoints: endpoint,
      },
    };

    ctx.send(200, snapshot);
  };

  return { handlers: { architecture } };
}
