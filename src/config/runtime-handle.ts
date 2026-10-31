/**
 * 稳定门面：`HeartbeatLoop`、QQ 渠道插件等消费者在构造时按值捕获配置，
 * 直接替换实例不会生效。`HarnessStore` 保存成功（干跑 + 落盘都通过）后调用
 * `swap(next)`，所有消费者仍持有同一个 handle，下一次读取自动看到新值。
 *
 * 保存失败不调用 `swap`，旧配置继续服务；订阅者用于「需要立即反应」的装配点
 * （例如重建 QQ 插件），消费者本身仍应按次读取，不缓存配置。
 */
import type { HarnessConfig } from './harness-schema.js';

export class RuntimeConfigHandle {
  private current: HarnessConfig;
  private readonly listeners = new Set<(config: HarnessConfig) => void>();

  constructor(initial: HarnessConfig) {
    this.current = initial;
  }

  /** 按次读取；调用方不得缓存返回值用于后续 tick。 */
  get(): HarnessConfig {
    return this.current;
  }

  /** 热切换：调用方只应在保存成功、且已落盘之后调用。 */
  swap(next: HarnessConfig): void {
    this.current = next;
    for (const listener of [...this.listeners]) {
      try {
        listener(next);
      } catch {
        // 一个订阅者失败不能阻止其他订阅者看到新配置；这里没有 logger 可用。
      }
    }
  }

  /** 订阅配置切换；返回退订函数（幂等）。 */
  subscribe(listener: (config: HarnessConfig) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
