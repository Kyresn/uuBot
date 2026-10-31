/**
 * 插件 API v1 的类型定义。
 *
 * 宿主把 PluginApiV1（以及渠道插件额外的 ChannelPluginApiV1）注入插件；
 * 插件只依赖这些接口，不直接接触宿主内部对象。brain 与 memory 由宿主
 * 透传，log 一律走宿主的日志出口。
 */

import type { BrainResponse } from '../brain/brain.js';
import type { ChatMessage } from '../brain/types.js';
import type { ControlPort } from '../control/types.js';
import type { PluginKind } from './manifest.js';

/** 插件推入感知队列的事件。id 与 ts 由宿主补齐。 */
export interface PushEvent {
  kind: string;
  channel: string;
  actor: string;
  content: string;
  importance: number;
}

/** 所有插件共享的 API 表面。 */
export interface PluginApiV1 {
  readonly name: string;
  readonly kind: PluginKind;
  /** 渠道插件声明的 channelPrefix；能力插件为 undefined。 */
  readonly channelPrefix?: string;
  /** manifest 的 config 对象；manifest 未声明时为空对象。 */
  config: Record<string, unknown>;
  /**
   * 可信文本日志出口。只用于插件自己生成的文本；不可信文本
   * （网络输入、模型输出、外部用户内容）必须走 reply()。
   */
  log(line: string): void;
  /**
   * 渲染不可信模型输出；宿主必须使用与 log 不同的行前缀（'|> '），
   * 避免模型文本伪装成可信日志行。
   */
  reply(text: string): void;
  brain: {
    chat(messages: ChatMessage[], opts?: { tier?: 'flash' | 'pro' }): Promise<BrainResponse>;
  };
  memory: {
    search(query: string, limit?: number): Promise<unknown[]>;
    write(entry: { content: string; kind: string; importance?: number }): Promise<void>;
  };
  /**
   * 投递到指定渠道。与核心循环同一条红线闸：文本先规范化再判定，
   * 被拦时不投递。Promise 在消息交给宿主路由（dispatched）后即 resolve，
   * 不代表目标渠道已送达。
   *
   * 仅渠道插件可用；能力插件的 send rpc 会被 worker 宿主拒绝——能力插件
   * 返回数据，由模型决定说什么。
   */
  send(channel: string, text: string): Promise<void>;
}

/** 渠道插件额外获得感知入口。 */
export interface ChannelPluginApiV1 extends PluginApiV1 {
  perception: {
    push(event: PushEvent): void;
    requestWake(): void;
  };
  /**
   * 控制面端口。只有核心接线显式授予的插件才有（当前只有 qq）；
   * manifest 不能自称拥有它。缺省时渠道行为与 M2a 完全一致。
   */
  control?: ControlPort;
}

/** 渠道插件实例形状：模块的 createPlugin() 或默认导出应返回该对象。 */
export interface ChannelPlugin {
  /**
   * 可选：插件当前是否被配置启用。宿主在 activate 前询问；返回 false 时
   * 插件状态记为 `stopped`（配置关闭）而不是 `failed`（激活出错）。
   */
  enabled?(): boolean;
  activate(api: ChannelPluginApiV1): void | Promise<void>;
  deactivate(): void | Promise<void>;
  send(conversationKey: string, text: string): void | Promise<void>;
}
