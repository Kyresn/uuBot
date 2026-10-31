/**
 * D1 会话维度：一次 tick 内每个会话各调一次 brain、各发一条回复。
 *
 * 回复绝不能跨会话广播：私聊生成的回复不得发进群。这里用多个会话键的
 * 事件批次验证分组、排序、截断、重排与工具缓存隔离。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HeartbeatLoop } from '../src/core/loop.js';
import { PerceptionQueue, type PerceptionEvent } from '../src/core/events.js';
import { AllEndpointsDownError } from '../src/brain/endpoints.js';
import type { BrainResponse, ChatOptions } from '../src/brain/brain.js';
import type { ChatMessage, ToolCall, ToolDef } from '../src/brain/types.js';
import { createPersonaState, type PersonaState } from '../src/persona/persona.js';
import type { Config } from '../src/config.js';

type ChatFn = (messages: ChatMessage[], opts?: ChatOptions) => Promise<BrainResponse>;
type InvokeFn = (name: string, args: unknown) => Promise<unknown>;

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    endpoints: [],
    tickFastMs: 300_000,
    tickSlowMs: 3_600_000,
    wakeDebounceMs: 3000,
    httpTimeoutMs: 120_000,
    maxConversationsPerTick: 3,
    maxEventsPerConversation: 20,
    maxQueueSize: 500,
    ...overrides,
  };
}

function makePersona(): PersonaState {
  const persona = createPersonaState(() => 0.5);
  persona.name = '小壳';
  return persona;
}

let nextEventSeq = 0;

function makeEvent(overrides: Partial<PerceptionEvent> = {}): PerceptionEvent {
  nextEventSeq += 1;
  return {
    id: `evt-${nextEventSeq}`,
    ts: 0,
    kind: 'qq_group_message',
    channel: 'qq:group:1',
    actor: 'group:1/2',
    content: '你好',
    importance: 3,
    ...overrides,
  };
}

function makeBrainResponse(overrides: Partial<BrainResponse> = {}): BrainResponse {
  return {
    content: '你好呀。',
    toolCalls: [],
    reasoning: null,
    usage: { promptTokens: 10, completionTokens: 5 },
    endpoint: 'nim-1',
    model: 'flash-model',
    ...overrides,
  };
}

const ECHO_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'echo',
    description: 'echo the given arguments back',
    parameters: { type: 'object', properties: { x: { type: 'number' } } },
  },
};

function userContent(messages: ChatMessage[]): string {
  return messages.find((message) => message.role === 'user')?.content ?? '';
}

interface Harness {
  loop: HeartbeatLoop;
  queue: PerceptionQueue;
  chat: ReturnType<typeof vi.fn<ChatFn>>;
  send: ReturnType<typeof vi.fn<(channel: string, text: string) => void>>;
  log: ReturnType<typeof vi.fn<(line: string) => void>>;
  invokeTool: ReturnType<typeof vi.fn<InvokeFn>>;
}

function makeLoop(configOverrides: Partial<Config> = {}, withTools = false): Harness {
  const config = makeConfig(configOverrides);
  const queue = new PerceptionQueue({ debounceMs: config.wakeDebounceMs });
  const chat = vi.fn<ChatFn>();
  const send = vi.fn<(channel: string, text: string) => void>();
  const log = vi.fn<(line: string) => void>();
  const invokeTool = vi.fn<InvokeFn>(async () => ({ ok: true }));

  const loop = new HeartbeatLoop({
    config,
    queue,
    brain: { chat },
    persona: makePersona(),
    channels: { send },
    log,
    ...(withTools
      ? { tools: { getToolDefs: () => [ECHO_TOOL], invokeTool } }
      : {}),
  });

  return { loop, queue, chat, send, log, invokeTool };
}

function loggedText(log: ReturnType<typeof vi.fn>): string {
  return log.mock.calls.map((call) => String(call[0])).join('\n');
}

beforeEach(() => {
  nextEventSeq = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('HeartbeatLoop per-conversation replies', () => {
  it('makes one brain call and one send per conversation, never broadcasting', async () => {
    const { loop, queue, chat, send } = makeLoop();
    queue.push(makeEvent({ channel: 'qq:group:1', content: 'g1-a', importance: 3 }));
    queue.push(makeEvent({ channel: 'qq:private:2', content: 'p2-a', importance: 9 }));
    queue.push(makeEvent({ channel: 'qq:group:3', content: 'g3-a', importance: 3 }));
    queue.push(makeEvent({ channel: 'qq:group:1', content: 'g1-b', importance: 3 }));

    chat.mockImplementation(async (messages) => {
      const content = userContent(messages);
      if (content.includes('g1-a')) return makeBrainResponse({ content: 'reply-g1' });
      if (content.includes('p2-a')) return makeBrainResponse({ content: 'reply-p2' });
      return makeBrainResponse({ content: 'reply-g3' });
    });

    await loop.runTickOnce('fast');

    expect(chat).toHaveBeenCalledTimes(3);
    const contents = chat.mock.calls.map((call) => userContent(call[0]));
    const g1 = contents.find((content) => content.includes('g1-a')) ?? '';
    const p2 = contents.find((content) => content.includes('p2-a')) ?? '';
    const g3 = contents.find((content) => content.includes('g3-a')) ?? '';

    // 每个会话只看到自己的事件。
    expect(g1).toContain('g1-b');
    expect(g1).not.toContain('p2-a');
    expect(g1).not.toContain('g3-a');
    expect(p2).not.toContain('g1-a');
    expect(g3).not.toContain('g1-a');

    // 三条回复各自发回自己的会话。
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls).toEqual(
      expect.arrayContaining([
        ['qq:group:1', 'reply-g1'],
        ['qq:private:2', 'reply-p2'],
        ['qq:group:3', 'reply-g3'],
      ]),
    );
    expect(new Set(send.mock.calls.map((call) => call[1])).size).toBe(3);
  });

  it('orders conversations by max importance and defers the rest to the next tick', async () => {
    const { loop, queue, chat, send } = makeLoop();
    queue.push(makeEvent({ channel: 'qq:group:1', content: 'conv-1', importance: 3 }));
    queue.push(makeEvent({ channel: 'qq:group:2', content: 'conv-2', importance: 9 }));
    queue.push(makeEvent({ channel: 'qq:group:3', content: 'conv-3', importance: 7 }));
    queue.push(makeEvent({ channel: 'qq:group:4', content: 'conv-4', importance: 5 }));

    chat.mockImplementation(async (messages) =>
      makeBrainResponse({ content: `reply:${userContent(messages).includes('conv-2') ? 2 : 0}` }),
    );

    await loop.runTickOnce('fast');

    expect(chat).toHaveBeenCalledTimes(3);
    const processed = chat.mock.calls.map((call) => userContent(call[0]));
    expect(processed.some((content) => content.includes('conv-1'))).toBe(false);
    expect(processed.some((content) => content.includes('conv-2'))).toBe(true);
    expect(processed.some((content) => content.includes('conv-3'))).toBe(true);
    expect(processed.some((content) => content.includes('conv-4'))).toBe(true);

    // 第四个会话的事件原序留在队列里。
    const deferredEvents = queue.drain();
    expect(deferredEvents.map((event) => event.content)).toEqual(['conv-1']);
    expect(send).toHaveBeenCalledTimes(3);

    // 下一 tick 处理它。
    chat.mockResolvedValue(makeBrainResponse({ content: 'reply:1' }));
    queue.prepend(deferredEvents);
    await loop.runTickOnce('fast');
    expect(chat).toHaveBeenCalledTimes(4);
    expect(send).toHaveBeenCalledWith('qq:group:1', 'reply:1');
  });

  it('caps a conversation at maxEventsPerConversation and requeues the overflow', async () => {
    const { loop, queue, chat } = makeLoop();
    // 21 条事件：最旧的一条重要度最低，应被截断。
    queue.push(makeEvent({ channel: 'qq:group:1', content: 'overflow', importance: 1 }));
    for (let i = 1; i < 21; i += 1) {
      queue.push(makeEvent({ channel: 'qq:group:1', content: `kept-${i}`, importance: 5 }));
    }

    chat.mockResolvedValue(makeBrainResponse({ content: '收到。' }));

    await loop.runTickOnce('fast');

    expect(chat).toHaveBeenCalledTimes(1);
    const content = userContent(chat.mock.calls[0]![0]);
    expect(content).not.toContain('overflow');
    expect(content).toContain('kept-1');
    expect(content).toContain('kept-20');

    expect(queue.drain().map((event) => event.content)).toEqual(['overflow']);
  });

  it('requeues every unprocessed event in original order when endpoints go down mid-tick', async () => {
    const { loop, queue, chat, send, log } = makeLoop();
    queue.push(makeEvent({ channel: 'qq:group:1', content: 'a-1', importance: 9 }));
    queue.push(makeEvent({ channel: 'qq:group:2', content: 'b-1', importance: 8 }));
    queue.push(makeEvent({ channel: 'qq:group:1', content: 'a-2', importance: 9 }));
    queue.push(makeEvent({ channel: 'qq:group:3', content: 'c-1', importance: 7 }));
    queue.push(makeEvent({ channel: 'qq:group:4', content: 'd-1', importance: 6 }));

    let calls = 0;
    chat.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return makeBrainResponse({ content: 'reply-a' });
      throw new AllEndpointsDownError();
    });

    await loop.runTickOnce('fast');

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('qq:group:1', 'reply-a');
    // 会话 2..n 与延后的会话 4 全部按原序放回；已成功的会话 1 不重排。
    expect(queue.drain().map((event) => event.content)).toEqual(['b-1', 'c-1', 'd-1']);
    expect(loggedText(log)).toContain('silent mode');
    // silentRounds 只加一次。
    expect(loop.nextFastMs()).toBe(600_000);
  });

  it('clears the executed-tool cache between conversations so ids do not collide', async () => {
    const { loop, queue, chat, invokeTool } = makeLoop({}, true);
    queue.push(makeEvent({ channel: 'qq:group:1', content: 'conv-a', importance: 9 }));
    queue.push(makeEvent({ channel: 'qq:group:2', content: 'conv-b', importance: 8 }));

    const toolCall: ToolCall = {
      id: 'call_0',
      type: 'function',
      function: { name: 'echo', arguments: '{"x":1}' },
    };
    const responses = [
      makeBrainResponse({ content: null, toolCalls: [toolCall] }),
      makeBrainResponse({ content: 'reply-a' }),
      makeBrainResponse({ content: null, toolCalls: [toolCall] }),
      makeBrainResponse({ content: 'reply-b' }),
    ];
    chat.mockImplementation(async () => {
      const next = responses.shift();
      if (next === undefined) throw new Error('unexpected brain call');
      return next;
    });

    await loop.runTickOnce('fast');

    // 同一个 call_0 在两个会话里都必须真正执行。
    expect(invokeTool).toHaveBeenCalledTimes(2);
  });

  it('reuses tool results when a null-content conversation is retried', async () => {
    const { loop, queue, chat, send, invokeTool } = makeLoop({}, true);
    queue.push(makeEvent({ channel: 'qq:group:1', content: 'retry-me', importance: 9 }));

    const toolCall: ToolCall = {
      id: 'call_0',
      type: 'function',
      function: { name: 'echo', arguments: '{"x":1}' },
    };
    const responses = [
      // tick 1：工具执行后模型只返回 reasoning、正文为 null → 该会话重排。
      makeBrainResponse({ content: null, toolCalls: [toolCall] }),
      makeBrainResponse({ content: null }),
      // tick 2：同一批事件重试，模型再次请求同一调用 → 必须复用已执行结果。
      makeBrainResponse({ content: null, toolCalls: [toolCall] }),
      makeBrainResponse({ content: '恢复。' }),
    ];
    chat.mockImplementation(async () => {
      const next = responses.shift();
      if (next === undefined) throw new Error('unexpected brain call');
      return next;
    });
    invokeTool.mockResolvedValue('cached-ok');

    await loop.runTickOnce('fast');
    const requeued = queue.drain();
    expect(requeued.map((event) => event.content)).toEqual(['retry-me']);

    queue.prepend(requeued);
    await loop.runTickOnce('fast');

    // 同一会话的重试不得再次触发可能已发生的副作用。
    expect(invokeTool).toHaveBeenCalledTimes(1);
    const retriedToolMessage = chat.mock.calls[3]![0].find((message) => message.role === 'tool');
    expect(retriedToolMessage?.content).toContain('cached-ok');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('qq:group:1', '恢复。');
  });

  it('requeues only unanswered conversations when an unknown error aborts the tick', async () => {
    const { loop, queue, chat, send } = makeLoop();
    queue.push(makeEvent({ channel: 'qq:group:1', content: 'c1-a', importance: 9 }));
    queue.push(makeEvent({ channel: 'qq:group:2', content: 'c2-a', importance: 8 }));
    queue.push(makeEvent({ channel: 'qq:group:1', content: 'c1-b', importance: 9 }));
    queue.push(makeEvent({ channel: 'qq:group:3', content: 'c3-a', importance: 7 }));

    let calls = 0;
    chat.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return makeBrainResponse({ content: 'reply-c1' });
      throw new Error('provider exploded');
    });

    await expect(loop.runTickOnce('fast')).rejects.toThrow('provider exploded');

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('qq:group:1', 'reply-c1');

    // 已答复的会话 1 不重排；会话 2、3 按原始下标留在队列里。
    const requeued = queue.drain();
    expect(requeued.map((event) => event.content)).toEqual(['c2-a', 'c3-a']);

    // 下一 tick 处理剩余的会话，绝不再给会话 1 发一次。
    queue.prepend(requeued);
    chat.mockReset();
    chat.mockResolvedValue(makeBrainResponse({ content: 'reply-next' }));
    await loop.runTickOnce('fast');

    expect(send.mock.calls.map((call) => call[0])).toEqual(['qq:group:1', 'qq:group:2', 'qq:group:3']);
    expect(send.mock.calls.filter((call) => call[0] === 'qq:group:1')).toHaveLength(1);
  });

  it('keeps tool-cache entries isolated per channel after a failed tick', async () => {
    const { loop, queue, chat, send, invokeTool } = makeLoop({}, true);
    queue.push(makeEvent({ channel: 'qq:group:x', content: 'conv-a', importance: 9 }));
    queue.push(makeEvent({ channel: 'qq:group:y', content: 'conv-b', importance: 8 }));

    const toolCall: ToolCall = {
      id: 'call_0',
      type: 'function',
      function: { name: 'echo', arguments: '{"x":1}' },
    };
    const responses: BrainResponse[] = [
      // 会话 A：执行工具后正文为 null → 重排。
      makeBrainResponse({ content: null, toolCalls: [toolCall] }),
      makeBrainResponse({ content: null }),
      // 会话 B：同一个 call_0 执行自己的工具，随后 brain 抛未知错误。
      makeBrainResponse({ content: null, toolCalls: [toolCall] }),
      // 下一 tick：会话 A 重试（第 4 次 brain 调用在抛错处接替）。
      makeBrainResponse({ content: null, toolCalls: [toolCall] }),
      makeBrainResponse({ content: 'A 恢复。' }),
      makeBrainResponse({ content: 'B 恢复。' }),
    ];
    let throwAtCall = 4;
    chat.mockImplementation(async () => {
      throwAtCall -= 1;
      if (throwAtCall === 0) throw new Error('provider exploded');
      const next = responses.shift();
      if (next === undefined) throw new Error('unexpected brain call');
      return next;
    });
    let executions = 0;
    invokeTool.mockImplementation(async () => {
      executions += 1;
      return executions === 1 ? 'result-from-A' : 'result-from-B';
    });

    await expect(loop.runTickOnce('fast')).rejects.toThrow('provider exploded');
    await loop.runTickOnce('fast');

    // 两个会话各执行一次；A 的重试命中自己的结果，不再执行第三次。
    expect(invokeTool).toHaveBeenCalledTimes(2);
    const retriedToolMessage = chat.mock.calls[4]![0].find((message) => message.role === 'tool');
    expect(retriedToolMessage?.content).toContain('result-from-A');
    expect(retriedToolMessage?.content).not.toContain('result-from-B');
    expect(send).toHaveBeenCalledWith('qq:group:x', 'A 恢复。');
  });
});
