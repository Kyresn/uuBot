/**
 * 稳定门面：`HeartbeatLoop`、`PluginHost`、`CapabilityRegistry`、`WorkerHost`
 * 在构造时按值捕获 brain，直接替换实例不会生效。保存配置重建成功后调用
 * `swap(next)`，所有消费者仍持有同一个 handle，新请求自动走新 brain。
 *
 * 保存失败（校验、干跑、落盘任一步失败）不调用 `swap`，旧 brain 继续服务。
 */
import type { Brain, BrainResponse, ChatOptions } from './brain.js';
import type { EndpointPool } from './endpoints.js';
import type { ChatMessage } from './types.js';

/** 稳定门面：消费者只依赖 `chat()`，测试可用 `{ chat }` 的替身替代。 */
export class BrainHandle {
  private current: Brain;

  constructor(initial: Brain) {
    this.current = initial;
  }

  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<BrainResponse> {
    return this.current.chat(messages, opts);
  }

  /** 热切换：调用方只应在重建成功、且已落盘之后调用。 */
  swap(next: Brain): void {
    this.current = next;
  }

  /** 当前池的端点健康快照（网页 `/api/state` 使用）。 */
  snapshot(): ReturnType<EndpointPool['snapshot']> {
    return this.current.snapshot();
  }

  /**
   * 就绪探针（网页 `/api/health?deep=1` 使用）。
   *
   * 只按能服务 flash 档的启用端点判定：快心跳走 flash，这些端点全在退避里
   * 就等于本轮心跳必然失败。若配置里没有任何 flash 端点（全是 pro），
   * 退回全部启用端点，避免把「空集合」误判成全部降级。
   * 没有任何启用端点时也不算降级——那是配置问题，不是运行期故障。
   */
  readiness(): { allDegraded: boolean } {
    const enabled = this.snapshot().filter((entry) => entry.enabled);
    const flashCapable = enabled.filter(
      (entry) => entry.tier === 'flash' || entry.tier === 'both',
    );
    const considered = flashCapable.length > 0 ? flashCapable : enabled;
    const allDegraded =
      considered.length > 0 &&
      considered.every((entry) => entry.degraded || entry.remainingBackoffMs > 0);
    return { allDegraded };
  }
}
