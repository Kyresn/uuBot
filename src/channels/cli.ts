/**
 * CLI 渠道兼容壳（P3 删除）。
 *
 * 实现已迁到 `plugins/channels/cli`；这里保留 `CliChannel` 的旧构造签名
 * 与 start()/send() 方法，供 `src/index.ts` 与既有测试无改动使用。
 *
 * 壳在构造时自建最小 api 适配器：perception.push 补 id/ts 后入队，
 * requestWake 直连队列，log/reply 均指向 onSend。brain/memory/send 不是
 * CLI 插件会碰的东西，提供即抛错的桩。
 */

import { createPlugin } from '../../plugins/channels/cli/index.js';
import type { ChannelPlugin, ChannelPluginApiV1, PushEvent } from '../plugins/api.js';
import type { PerceptionQueue } from '../core/events.js';

export interface CliChannelOptions {
  queue: PerceptionQueue;
  /** 回复出口，默认 console.log。 */
  onSend?: (text: string) => void;
  /** 输入流，默认 process.stdin；测试注入假流。 */
  input?: NodeJS.ReadableStream;
}

/** 壳不提供的能力：插件 activate 不会触碰它们，误用即明确报错。 */
function unavailable(member: string): never {
  throw new Error(`cli channel shell: ${member} is not available`);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class CliChannel {
  private readonly onSend: (text: string) => void;
  private readonly plugin: ChannelPlugin;
  private readonly api: ChannelPluginApiV1;
  private started = false;

  constructor(options: CliChannelOptions) {
    this.onSend = options.onSend ?? ((text) => console.log(text));

    const queue = options.queue;
    this.api = {
      name: 'cli',
      kind: 'channel',
      channelPrefix: 'cli',
      config: {},
      log: (line) => this.onSend(line),
      // 壳的 onSend 由调用方决定渲染；reply 与 log 一样落到 onSend。
      reply: (text) => this.onSend(text),
      brain: {
        chat: () => unavailable('brain.chat'),
      },
      memory: {
        search: () => unavailable('memory.search'),
        write: () => unavailable('memory.write'),
      },
      send: () => unavailable('send'),
      perception: {
        push: (event: PushEvent) => {
          queue.push({
            id: queue.nextEventId(),
            ts: Date.now(),
            kind: event.kind,
            channel: event.channel,
            actor: event.actor,
            content: event.content,
            importance: event.importance,
          });
        },
        requestWake: () => queue.requestWake(),
      },
    };

    this.plugin = createPlugin({ input: options.input });
  }

  /** 开始监听输入流。重复调用无副作用。 */
  start(): void {
    if (this.started) return;

    const result = this.plugin.activate(this.api);
    this.started = true;
    if (result instanceof Promise) {
      void result.catch((error: unknown) => {
        this.onSend(`cli channel shell: activate failed: ${describeError(error)}`);
      });
    }
  }

  /** 把回复发给用户。 */
  send(text: string): void {
    // 旧渠道允许 start 之前 send；此时 api 尚未注入插件，直接走 onSend。
    if (!this.started) {
      this.onSend(text);
      return;
    }

    const result = this.plugin.send('cli', text);
    if (result instanceof Promise) {
      void result.catch((error: unknown) => {
        this.onSend(`cli channel shell: send failed: ${describeError(error)}`);
      });
    }
  }
}
