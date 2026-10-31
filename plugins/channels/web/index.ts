/**
 * web 渠道插件：网页对话的人机通道（spec §3.1）。
 *
 * 与 CLI 并列：activate 把桥接的入站回调接到感知队列，非空输入转成
 * `web_message` 推入队列并请求唤醒；send 把 agent 的回复追加回桥接。
 * 会话键固定 `web:main`（单用户单会话），actor 固定 `owner`，重要度 9。
 *
 * 出站不在这里过闸：宿主（心跳循环）先做红线判定，被拦的回复不会走到
 * `send`；插件自身绝不调用 `api.send` 绕开宿主。deactivate 关闭桥接的
 * 入站路径，之后的 `submit` 返回 `closed`。
 */

import type { ChannelPlugin, ChannelPluginApiV1, PushEvent } from '../../../src/plugins/api.js';
import type { WebChatBridge } from '../../../src/web/chat-bridge.js';

/** 单用户单会话：网页对话只有这一个会话键。 */
const WEB_CHANNEL = 'web:main';
/** 网页消息是 owner 的直接输入，与 QQ @ 同级。 */
const WEB_MESSAGE_IMPORTANCE = 9;

export interface WebPluginOptions {
  /** 由装配点经 `pluginFactoryArgs` 注入的唯一桥接实例。 */
  bridge?: WebChatBridge;
}

export function createPlugin(options: WebPluginOptions = {}): ChannelPlugin {
  const bridge = options.bridge;
  let api: ChannelPluginApiV1 | null = null;
  let active = false;

  return {
    activate(injected) {
      // 幂等：重复 activate 不换回调，避免同一句话推两次。
      if (active) return;
      if (bridge === undefined) {
        throw new Error('web plugin: a WebChatBridge must be injected');
      }

      active = true;
      api = injected;
      // 重载会先 close 再 activate：这里重新打开入站路径，否则桥接永久关闭。
      bridge.open();
      bridge.onSubmit = (text) => {
        // 桥接已挡住空白；这里再判一次，保证插件单独使用时同样不产生事件。
        if (text.trim() === '') return;

        const event: PushEvent = {
          kind: 'web_message',
          channel: WEB_CHANNEL,
          actor: 'owner',
          content: text,
          importance: WEB_MESSAGE_IMPORTANCE,
        };
        injected.perception.push(event);
        injected.perception.requestWake();
      };
    },

    deactivate() {
      if (!active) return;
      active = false;
      api = null;
      if (bridge !== undefined) {
        // 先摘回调再关闭：即使 close 之后还有在途 submit，也不会再推事件。
        bridge.onSubmit = null;
        bridge.close();
      }
    },

    send(_conversationKey, text) {
      if (api === null || bridge === undefined) {
        throw new Error('web plugin: send() before activate()');
      }
      // 回复已过宿主红线闸；桥接只负责缓冲，不再净化或改写。
      bridge.appendAgent(text);
    },
  };
}
