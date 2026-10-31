/**
 * 能力插件 worker 的引导脚本。
 *
 * 独立文件：真实 Worker 直接加载它，不经过 TypeScript 转译，因此只允许
 * import node:worker_threads 与 node:url。这里不含任何宿主实现，只把插件
 * 的 API 调用转发给宿主，并等待同一 id 的 rpc-result。
 *
 * 协议形状见 src/plugins/worker-protocol.ts；本文件不 import 它，以免
 * worker 依赖宿主构建产物。
 *
 * 隔离边界说明：worker 线程**不是安全沙箱**。插件代码仍可直接
 * `import('node:fs')`、`node:net`、`node:child_process` 等内置模块；代理
 * api 只限制“核心能力”的调用路径。真正的安全边界来自 M4 的 shell 沙箱
 * （阻止 agent 写入仓库），不要把 worker 当作安全边界。
 */

import { parentPort } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

/** selfTest 的保留工具名；宿主激活插件时调用它。 */
const SELF_TEST_TOOL = '__selfTest';

/** rpc id → 等待中的 promise 处理器。 */
const pending = new Map();
let rpcSeq = 0;

/** 当前插件实例的工具表；init 成功后填充。 */
let activeTools = {};

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 向宿主发一条 rpc 请求，等待同 id 的 rpc-result。 */
function callHost(method, args) {
  const id = `rpc-${++rpcSeq}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      parentPort.postMessage({ type: 'rpc', id, method, args });
    } catch (error) {
      // 参数不可结构化克隆时立即清掉等待项并拒绝，避免泄漏与 unhandled rejection。
      pending.delete(id);
      reject(new Error(`failed to send rpc ${method}: ${describeError(error)}`));
    }
  });
}

/**
 * 代理 API：插件拿到的每个能力都是 RPC 桩。权限由宿主裁决——未声明的
 * 方法仍可调用，但宿主会回 permission denied，插件侧表现为 rejected
 * promise；插件无法绕过代理直接接触宿主对象。
 */
function createProxyApi(init) {
  return {
    name: init.name,
    kind: 'capability',
    config: init.config ?? {},
    log: (line) => callHost('log', [line]),
    reply: (text) => callHost('reply', [text]),
    brain: {
      chat: (messages, opts) => callHost('brain.chat', [messages, opts]),
    },
    memory: {
      search: (query, limit) => callHost('memory.search', [query, limit]),
      write: (entry) => callHost('memory.write', [entry]),
    },
    send: (channel, text) => callHost('send', [channel, text]),
  };
}

/** 优先 createPlugin()，其次函数形式的默认导出。 */
function resolvePluginFactory(module) {
  if (typeof module.createPlugin === 'function') return module.createPlugin;
  if (typeof module.default === 'function') return module.default;
  return undefined;
}

async function handleInit(message) {
  try {
    const url = pathToFileURL(message.pluginPath).href;
    const module = await import(url);
    const factory = resolvePluginFactory(module);

    let instance;
    if (factory !== undefined) {
      instance = await factory(createProxyApi(message));
    } else if (module.default !== null && typeof module.default === 'object') {
      instance = module.default;
    }

    if (instance === null || typeof instance !== 'object' || Array.isArray(instance)) {
      throw new Error('plugin module must export createPlugin(api) or a default plugin object');
    }

    const declared = instance.tools;
    if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) {
      throw new Error('plugin must return a tools object');
    }

    const tools = {};
    for (const [name, fn] of Object.entries(declared)) {
      if (typeof fn === 'function') tools[name] = fn;
    }
    // selfTest 使用保留名，不占用插件声明的工具命名空间。
    if (typeof instance.selfTest === 'function') {
      tools[SELF_TEST_TOOL] = instance.selfTest;
    }

    activeTools = tools;
    parentPort.postMessage({ type: 'ready', tools: Object.keys(tools) });
  } catch (error) {
    parentPort.postMessage({ type: 'fatal', error: describeError(error) });
  }
}

async function handleTool(message) {
  const fn = activeTools[message.name];
  if (typeof fn !== 'function') {
    parentPort.postMessage({
      type: 'tool-result',
      id: message.id,
      ok: false,
      error: `unknown tool: ${String(message.name)}`,
    });
    return;
  }

  try {
    const value = await fn(message.args);
    try {
      parentPort.postMessage({ type: 'tool-result', id: message.id, ok: true, value });
    } catch (error) {
      // 返回值不可结构化克隆时，把错误当作工具结果回传。
      parentPort.postMessage({
        type: 'tool-result',
        id: message.id,
        ok: false,
        error: `tool result is not cloneable: ${describeError(error)}`,
      });
    }
  } catch (error) {
    parentPort.postMessage({
      type: 'tool-result',
      id: message.id,
      ok: false,
      error: describeError(error),
    });
  }
}

parentPort.on('message', (message) => {
  if (message === null || typeof message !== 'object') return;

  switch (message.type) {
    case 'init':
      void handleInit(message);
      break;
    case 'tool':
      void handleTool(message);
      break;
    case 'rpc-result': {
      const waiter = pending.get(message.id);
      if (waiter === undefined) return;
      pending.delete(message.id);
      if (message.ok === true) {
        waiter.resolve(message.value);
      } else {
        waiter.reject(new Error(typeof message.error === 'string' ? message.error : 'rpc failed'));
      }
      break;
    }
    case 'shutdown':
      process.exit(0);
      break;
    default:
      break;
  }
});
