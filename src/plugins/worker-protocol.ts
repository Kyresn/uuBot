/**
 * 能力插件 worker 协议。
 *
 * 宿主与 worker 之间只通过结构化消息通信：宿主发 init/tool/shutdown，
 * worker 回 ready/tool-result/fatal，并在插件调用核心能力时发 rpc 请求，
 * 宿主以 rpc-result 应答。协议类型是两侧唯一的共享契约；bootstrap 是
 * 独立 .mjs，不 import 本文件，只按同一形状收发消息。
 */

/** 插件可向宿主发起的 rpc 方法。 */
export const RPC_METHODS = [
  'brain.chat',
  'memory.search',
  'memory.write',
  'send',
  'log',
  'reply',
] as const;

export type RpcMethod = (typeof RPC_METHODS)[number];

/**
 * 每个 rpc 方法对应的 manifest 权限组。
 *
 * `send` 故意不在此表：能力插件不得冒充 agent 发消息（返回数据，由模型
 * 决定怎么说）。方法名保留在 RPC_METHODS 中，宿主才能给出明确的拒绝，
 * 而不是“unknown method”。
 */
export const PERMISSION_METHODS: Record<Exclude<RpcMethod, 'send'>, string> = {
  'brain.chat': 'brain',
  'memory.search': 'memory',
  'memory.write': 'memory',
  log: 'log',
  reply: 'log',
};

/** 运行时校验不可信 worker 消息里的 method 字段。 */
export function isRpcMethod(value: unknown): value is RpcMethod {
  return typeof value === 'string' && (RPC_METHODS as readonly string[]).includes(value);
}

/** 宿主 → worker 的请求。 */
export type WorkerRequest =
  | {
      type: 'init';
      pluginPath: string;
      permissions: string[];
      config: Record<string, unknown>;
      name: string;
    }
  | { type: 'tool'; id: string; name: string; args: unknown }
  | { type: 'shutdown' };

/** worker → 宿主的响应。 */
export type WorkerResponse =
  | { type: 'ready'; tools: string[] }
  | { type: 'rpc'; id: string; method: RpcMethod; args: unknown[] }
  | { type: 'tool-result'; id: string; ok: true; value: unknown }
  | { type: 'tool-result'; id: string; ok: false; error: string }
  | { type: 'fatal'; error: string };

/** 宿主对 rpc 请求的应答。 */
export type HostReply =
  | { type: 'rpc-result'; id: string; ok: true; value: unknown }
  | { type: 'rpc-result'; id: string; ok: false; error: string };
