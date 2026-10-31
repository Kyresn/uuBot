/**
 * 能力插件 worker 宿主。
 *
 * 每个能力插件跑在独立 worker 线程里；宿主只通过结构化消息驱动它：
 * init → ready、tool → tool-result、shutdown。插件对核心能力的每次调用
 * 都是 worker → 宿主的 rpc，权限按 manifest.permissions 在宿主侧裁决——
 * worker 里的代理 api 只是桩，拿不到任何宿主对象。
 *
 * 所有外部故障（spawn 失败、init 超时、fatal、崩溃、工具超时）都转成
 * rejected promise 或日志，绝不让单个插件把宿主拖垮。
 *
 * 隔离边界说明：worker 线程**不是安全沙箱**。插件代码仍可直接
 * `import('node:fs')`、`node:net`、`node:child_process` 等内置模块，worker
 * 只隔离了“核心能力”的调用路径（RPC 代理 + manifest 权限裁决 + 审批状态机）。
 * 真正的安全边界来自 M4 的 shell 沙箱（阻止 agent 写入仓库）；不要把 worker
 * 当作安全边界，也不要把这里的权限检查当作对抗恶意代码的完整防线。
 */

import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { PluginApiV1 } from './api.js';
import type { PluginManifest } from './manifest.js';
import {
  isRpcMethod,
  PERMISSION_METHODS,
  type HostReply,
  type RpcMethod,
  type WorkerRequest,
} from './worker-protocol.js';

/** worker 宿主可注入的最小 Worker 表面；测试用假实现。 */
export interface WorkerLike {
  postMessage(message: unknown): void;
  on(event: 'message' | 'error' | 'exit', cb: (...args: any[]) => void): void;
  terminate(): Promise<number> | void;
}

export interface WorkerHostDeps {
  brain: PluginApiV1['brain'];
  memory: PluginApiV1['memory'];
  log: (line: string, prefix?: string) => void;
  /** 默认 `new Worker(pathToFileURL(bootstrap))`；测试注入假 Worker。 */
  createWorker?: (path: string) => WorkerLike;
  /** 单调时钟（毫秒）；默认 Date.now。超时测试注入手动时钟。 */
  now?: () => number;
}

export type WorkerState = 'starting' | 'ready' | 'failed' | 'stopped' | 'crashed';

/** init/ready 超时。 */
const INIT_TIMEOUT_MS = 10_000;
/** 单次工具调用超时。 */
const TOOL_TIMEOUT_MS = 30_000;
/** stop 时等待 worker 自行退出的宽限期，超时后 terminate。 */
const STOP_GRACE_MS = 2_000;

interface PendingTool {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cancel: () => void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** bootstrap 与宿主同目录；真实 Worker 无需转译即可加载 .mjs。 */
function defaultBootstrapPath(): string {
  return fileURLToPath(new URL('./capability-worker.mjs', import.meta.url));
}

/**
 * 默认 worker 工厂：**空环境**启动。
 *
 * `new Worker(url)` 默认继承整个 `process.env`，能力插件因此能读到
 * `QQ_WS_TOKEN`、`WEB_CONSOLE_TOKEN` 与全部模型密钥。插件需要的一切都通过
 * `postMessage`（init 消息）显式传入，`workerData` 只放宿主明确决定要给的
 * 值；当前没有任何值需要给。这不是安全沙箱（插件仍可 import node:fs），
 * 只是收缩外带面（不变量 20）。
 */
const defaultCreateWorker = (path: string): WorkerLike =>
  new Worker(pathToFileURL(path), { env: {}, workerData: {} }) as unknown as WorkerLike;

export class CapabilityWorker {
  private readonly deps: WorkerHostDeps;
  private readonly manifest: PluginManifest;
  private readonly pluginDir: string;
  private readonly createWorker: (path: string) => WorkerLike;
  private readonly now: () => number;

  private currentState: WorkerState = 'starting';
  private worker: WorkerLike | undefined;
  private ready: Deferred<string[]> | undefined;
  private cancelInitTimer: () => void = () => {};
  private stopping = false;
  private stopPromise: Promise<void> | undefined;
  private exitSeen = false;
  private readonly exitWaiters: Array<() => void> = [];
  private readonly pendingTools = new Map<string, PendingTool>();
  private toolSeq = 0;

  constructor(deps: WorkerHostDeps, manifest: PluginManifest, pluginDir: string) {
    this.deps = deps;
    this.manifest = manifest;
    this.pluginDir = pluginDir;
    this.createWorker = deps.createWorker ?? defaultCreateWorker;
    this.now = deps.now ?? Date.now;
  }

  get state(): WorkerState {
    return this.currentState;
  }

  /** spawn bootstrap 并等待 ready；超时、fatal、提前 exit 都 reject。 */
  start(): Promise<string[]> {
    const started = this.doStart();
    // 调用方可能不 await（例如 stop 先到）；内部挂 no-op catch 消化
    // unhandled rejection，同时不影响 await 的调用方收到 rejection。
    started.catch(() => {});
    return started;
  }

  private async doStart(): Promise<string[]> {
    // 状态与 worker 双重检查：spawn 失败后 state 已是 failed，重试必须
    // 立即失败而不是挂起（此时 worker 仍是 undefined）。
    if (this.worker !== undefined || this.currentState !== 'starting') {
      throw new Error(
        `plugin ${this.manifest.name} worker cannot start in state ${this.currentState}`,
      );
    }

    const ready = createDeferred<string[]>();
    this.ready = ready;

    // net 权限尚无对应 rpc 方法：显式声明时只记一次日志，不改变行为。
    if ((this.manifest.permissions ?? []).includes('net')) {
      this.deps.log(`plugin ${this.manifest.name}: net permission is not implemented; ignoring`);
    }

    let worker: WorkerLike;
    try {
      worker = this.createWorker(defaultBootstrapPath());
    } catch (error) {
      this.fail(`failed to spawn worker: ${describeError(error)}`);
      return ready.promise;
    }

    this.worker = worker;
    worker.on('message', (message: unknown) => this.onMessage(message));
    worker.on('error', (error: unknown) => {
      this.deps.log(`plugin ${this.manifest.name} worker error: ${describeError(error)}`);
    });
    worker.on('exit', (code: unknown) => this.onExit(code));

    this.cancelInitTimer = this.startTimer(INIT_TIMEOUT_MS, () => {
      this.fail(`init timed out after ${INIT_TIMEOUT_MS}ms`);
    });

    const init: WorkerRequest = {
      type: 'init',
      pluginPath: join(this.pluginDir, this.manifest.entry),
      permissions: this.manifest.permissions ?? [],
      config: this.manifest.config ?? {},
      name: this.manifest.name,
    };

    try {
      worker.postMessage(init);
    } catch (error) {
      this.fail(`failed to send init: ${describeError(error)}`);
    }

    return ready.promise;
  }

  /** 调用插件工具；30s 无结果即 reject。 */
  async invokeTool(name: string, args: unknown): Promise<unknown> {
    if (this.currentState !== 'ready') {
      throw new Error(`plugin ${this.manifest.name} is ${this.currentState}, cannot invoke tool ${name}`);
    }
    const worker = this.worker;
    if (worker === undefined) {
      throw new Error(`plugin ${this.manifest.name} worker is not running`);
    }

    const id = `tool-${++this.toolSeq}`;
    return await new Promise<unknown>((resolve, reject) => {
      const cancel = this.startTimer(TOOL_TIMEOUT_MS, () => {
        this.pendingTools.delete(id);
        reject(
          new Error(
            `plugin ${this.manifest.name} tool ${name} timed out after ${TOOL_TIMEOUT_MS}ms`,
          ),
        );
      });
      this.pendingTools.set(id, { resolve, reject, cancel });

      const request: WorkerRequest = { type: 'tool', id, name, args };
      try {
        worker.postMessage(request);
      } catch (error) {
        this.pendingTools.delete(id);
        cancel();
        reject(
          new Error(
            `plugin ${this.manifest.name} failed to send tool request: ${describeError(error)}`,
          ),
        );
      }
    });
  }

  /** 发 shutdown，等待 2s；未退出则 terminate。重复/并发调用共用同一次停止。 */
  async stop(): Promise<void> {
    if (this.stopPromise === undefined) {
      this.stopPromise = this.doStop();
    }
    return await this.stopPromise;
  }

  private async doStop(): Promise<void> {
    if (this.currentState === 'stopped') return;

    this.stopping = true;
    const worker = this.worker;

    if (this.currentState === 'starting') {
      this.cancelInitTimer();
      this.ready?.reject(new Error(`plugin ${this.manifest.name} worker stopped before ready`));
    }

    if (worker !== undefined) {
      try {
        const request: WorkerRequest = { type: 'shutdown' };
        worker.postMessage(request);
      } catch {
        // worker 已不可用：直接走退出/终止路径。
      }

      const exited = await this.waitForExit(STOP_GRACE_MS);
      if (!exited) {
        try {
          await worker.terminate();
        } catch (error) {
          this.deps.log(`plugin ${this.manifest.name} worker terminate failed: ${describeError(error)}`);
        }
      }
    }

    this.currentState = 'stopped';
    this.rejectPendingTools(`plugin ${this.manifest.name} worker stopped`);
  }

  private onMessage(message: unknown): void {
    if (!isRecord(message)) return;

    switch (message['type']) {
      case 'ready':
        this.onReady(message);
        break;
      case 'rpc':
        this.onRpc(message);
        break;
      case 'tool-result':
        this.onToolResult(message);
        break;
      case 'fatal':
        this.onFatal(message);
        break;
      default:
        break;
    }
  }

  private onReady(message: Record<string, unknown>): void {
    const tools = message['tools'];
    if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== 'string')) {
      this.fail('invalid ready message: tools must be an array of strings');
      return;
    }
    if (this.currentState !== 'starting') return;

    this.cancelInitTimer();
    this.currentState = 'ready';
    this.ready?.resolve(tools as string[]);
  }

  private onFatal(message: Record<string, unknown>): void {
    const error = typeof message['error'] === 'string' ? message['error'] : 'unknown worker error';
    if (this.currentState === 'starting') {
      this.fail(error);
      return;
    }
    this.deps.log(`plugin ${this.manifest.name} worker fatal: ${error}`);
  }

  /**
   * 权限在宿主侧裁决；log/reply 无副作用，始终放行。
   *
   * send 一律拒绝：能力插件只返回数据，说什么由 agent 决定；直接发消息会
   * 绕过人格与红线改写层。方法名仍在协议里，因此这里给出明确拒绝而不是
   * “unknown method”。
   */
  private onRpc(message: Record<string, unknown>): void {
    const id = typeof message['id'] === 'string' ? message['id'] : String(message['id'] ?? '');
    const method = message['method'];

    if (!isRpcMethod(method)) {
      this.replyRpc({
        type: 'rpc-result',
        id,
        ok: false,
        error: `unknown rpc method: ${String(method)}`,
      });
      return;
    }

    if (method === 'send') {
      this.deps.log(
        `plugin ${this.manifest.name} permission denied: send (capabilities return data, the agent decides what to say)`,
      );
      this.replyRpc({
        type: 'rpc-result',
        id,
        ok: false,
        error: 'permission denied: send (capability plugins may not send)',
      });
      return;
    }

    const declared = this.manifest.permissions ?? [];
    const allowed =
      method === 'log' || method === 'reply' || declared.includes(PERMISSION_METHODS[method]);

    if (!allowed) {
      this.deps.log(`plugin ${this.manifest.name} permission denied: ${method}`);
      this.replyRpc({
        type: 'rpc-result',
        id,
        ok: false,
        error: `permission denied: ${method}`,
      });
      return;
    }

    void this.dispatchRpc(method, message['args']).then(
      (value) => this.replyRpc({ type: 'rpc-result', id, ok: true, value }),
      (error: unknown) =>
        this.replyRpc({ type: 'rpc-result', id, ok: false, error: describeError(error) }),
    );
  }

  private async dispatchRpc(method: RpcMethod, args: unknown): Promise<unknown> {
    const list = Array.isArray(args) ? args : [];

    switch (method) {
      case 'brain.chat': {
        const messages = (list[0] ?? []) as Parameters<PluginApiV1['brain']['chat']>[0];
        const opts = list[1] as Parameters<PluginApiV1['brain']['chat']>[1];
        return await this.deps.brain.chat(messages, opts);
      }
      case 'memory.search': {
        const query = list[0];
        if (typeof query !== 'string') throw new Error('memory.search requires a string query');
        const limit = typeof list[1] === 'number' ? list[1] : undefined;
        return await this.deps.memory.search(query, limit);
      }
      case 'memory.write': {
        const entry = list[0] as Parameters<PluginApiV1['memory']['write']>[0];
        return await this.deps.memory.write(entry);
      }
      case 'log':
        this.deps.log(typeof list[0] === 'string' ? list[0] : String(list[0] ?? ''), this.capPrefix());
        return undefined;
      case 'reply':
        // 能力插件的 log/reply 同前缀：既不是可信日志，也不是 agent 的模型输出。
        this.deps.log(String(list[0] ?? ''), this.capPrefix());
        return undefined;
      default:
        throw new Error(`unknown rpc method: ${String(method)}`);
    }
  }

  /** 能力插件输出行前缀：与可信日志 '| '、模型输出 '|> ' 区分。 */
  private capPrefix(): string {
    return `| [cap:${this.manifest.name}] `;
  }

  private onToolResult(message: Record<string, unknown>): void {
    const id = typeof message['id'] === 'string' ? message['id'] : undefined;
    if (id === undefined) return;
    const pending = this.pendingTools.get(id);
    if (pending === undefined) return;

    this.pendingTools.delete(id);
    pending.cancel();

    if (message['ok'] === true) {
      pending.resolve(message['value']);
      return;
    }
    pending.reject(
      new Error(typeof message['error'] === 'string' ? message['error'] : 'tool invocation failed'),
    );
  }

  private onExit(code: unknown): void {
    this.exitSeen = true;
    for (const waiter of this.exitWaiters.splice(0)) waiter();
    this.rejectPendingTools(`plugin ${this.manifest.name} worker exited`);

    if (this.stopping) {
      this.currentState = 'stopped';
      return;
    }

    if (this.currentState === 'starting') {
      this.cancelInitTimer();
      this.currentState = 'crashed';
      this.ready?.reject(
        new Error(`plugin ${this.manifest.name} worker exited before ready (code ${String(code)})`),
      );
      this.deps.log(
        `plugin ${this.manifest.name} worker crashed before ready (exit code ${String(code)})`,
      );
      return;
    }

    if (this.currentState === 'ready') {
      this.currentState = 'crashed';
      this.deps.log(`plugin ${this.manifest.name} worker crashed (exit code ${String(code)})`);
    }
  }

  /** init 失败：标记 failed、拒绝 start、尽力终止 worker。 */
  private fail(reason: string): void {
    if (this.currentState !== 'starting') return;

    this.cancelInitTimer();
    this.currentState = 'failed';
    this.deps.log(`plugin ${this.manifest.name} worker failed: ${reason}`);
    this.ready?.reject(new Error(`plugin ${this.manifest.name} ${reason}`));

    const worker = this.worker;
    if (worker !== undefined) {
      void (async () => {
        try {
          await worker.terminate();
        } catch (error) {
          this.deps.log(
            `plugin ${this.manifest.name} worker terminate failed: ${describeError(error)}`,
          );
        }
      })();
    }
  }

  private replyRpc(reply: HostReply): void {
    const worker = this.worker;
    if (worker === undefined) return;
    try {
      worker.postMessage(reply);
    } catch (error) {
      this.deps.log(`plugin ${this.manifest.name} worker reply failed: ${describeError(error)}`);
    }
  }

  private rejectPendingTools(reason: string): void {
    for (const [id, pending] of this.pendingTools) {
      this.pendingTools.delete(id);
      pending.cancel();
      pending.reject(new Error(reason));
    }
  }

  /** 等 exit 事件；超时返回 false。 */
  private waitForExit(ms: number): Promise<boolean> {
    if (this.exitSeen) return Promise.resolve(true);

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let cancel = (): void => {};

      const finish = (exited: boolean): void => {
        if (settled) return;
        settled = true;
        cancel();
        resolve(exited);
      };

      const waiter = (): void => finish(true);
      this.exitWaiters.push(waiter);

      cancel = this.startTimer(ms, () => {
        const index = this.exitWaiters.indexOf(waiter);
        if (index >= 0) this.exitWaiters.splice(index, 1);
        finish(false);
      });
    });
  }

  /**
   * 基于注入时钟的超时定时器：触发时若时钟尚未越过 deadline（例如测试
   * 只推进了定时器），按剩余时间重新排期，避免提前误判。
   */
  private startTimer(ms: number, onTimeout: () => void): () => void {
    const deadline = this.now() + ms;
    let handle: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const tick = (): void => {
      if (cancelled) return;
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        onTimeout();
        return;
      }
      handle = setTimeout(tick, remaining);
    };

    handle = setTimeout(tick, ms);

    return () => {
      cancelled = true;
      if (handle !== undefined) clearTimeout(handle);
    };
  }
}
