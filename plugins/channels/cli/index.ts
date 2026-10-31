/**
 * CLI 渠道插件：调试用的人机通道。
 *
 * activate 在注入的输入流上建 readline，逐行把非空输入转成 cli_message
 * 推入宿主感知队列并请求唤醒；send 把 agent 的回复交给 api.reply（不可信
 * 前缀 '|> '，与可信日志区分），并带上 CLI 的 '它: ' 显示前缀。空行/纯空白
 * 不产生事件，避免用户随手回车触发一轮无意义的心跳。
 */

import { createInterface, type Interface } from 'node:readline';
import type { ChannelPlugin, ChannelPluginApiV1, PushEvent } from '../../../src/plugins/api.js';

/** CLI 每行消息的重要度。 */
const CLI_MESSAGE_IMPORTANCE = 8;

export interface CliPluginOptions {
  /** 输入流，默认 process.stdin；测试注入假流。 */
  input?: NodeJS.ReadableStream;
}

export function createPlugin(options: CliPluginOptions = {}): ChannelPlugin {
  const input = options.input ?? process.stdin;
  let api: ChannelPluginApiV1 | null = null;
  let readline: Interface | null = null;

  return {
    activate(injected) {
      // 幂等：重复 activate 不重建 readline，避免双订阅。
      if (readline !== null) return;

      api = injected;
      readline = createInterface({ input });
      readline.on('line', (line) => {
        if (line.trim() === '') return;

        const event: PushEvent = {
          kind: 'cli_message',
          // 用宿主注入的前缀，未注入时退回 'cli'（兼容壳路径）。
          channel: injected.channelPrefix ?? 'cli',
          actor: 'user',
          content: line,
          importance: CLI_MESSAGE_IMPORTANCE,
        };
        injected.perception.push(event);
        injected.perception.requestWake();
      });
    },

    deactivate() {
      if (readline === null) return;
      readline.close();
      readline = null;
    },

    send(_conversationKey, text) {
      if (api === null) throw new Error('cli plugin: send() before activate()');
      // '它: ' 是 CLI 的显示选择，留在渠道层；宿主只负责不可信前缀。
      api.reply(`它: ${text}`);
    },
  };
}
