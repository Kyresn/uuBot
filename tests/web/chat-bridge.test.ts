/**
 * T3 对话桥接：入站边界（空/超长/关闭）、seq 单调、环形淘汰与增量读取。
 *
 * 桥接只存内存，不写日志正文；这些测试只断言结构与顺序，不依赖时间。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_CHAT_INBOUND_BYTES,
  MAX_CHAT_MESSAGES,
  WebChatBridge,
} from '../../src/web/chat-bridge.js';

describe('WebChatBridge inbound', () => {
  it('records an accepted message as an owner message with a monotonic seq', () => {
    const bridge = new WebChatBridge();

    expect(bridge.submit('你好')).toEqual({ ok: true });

    const messages = bridge.snapshot();
    expect(messages).toHaveLength(1);
    const message = messages[0];
    expect(message).toMatchObject({ seq: 1, role: 'owner', text: '你好' });
    expect(typeof message?.ts).toBe('string');
    expect(Number.isNaN(Date.parse(message?.ts ?? ''))).toBe(false);
  });

  it('rejects empty and whitespace-only input without consuming a seq', () => {
    const bridge = new WebChatBridge();

    expect(bridge.submit('')).toEqual({ ok: false, code: 'empty' });
    expect(bridge.submit('   \n\t ')).toEqual({ ok: false, code: 'empty' });
    expect(bridge.snapshot()).toEqual([]);

    expect(bridge.submit('hi')).toEqual({ ok: true });
    expect(bridge.snapshot()[0]?.seq).toBe(1);
  });

  it('enforces the 4 KiB limit in UTF-8 bytes', () => {
    const bridge = new WebChatBridge();

    expect(bridge.submit('a'.repeat(MAX_CHAT_INBOUND_BYTES))).toEqual({ ok: true });
    expect(bridge.submit('a'.repeat(MAX_CHAT_INBOUND_BYTES + 1))).toEqual({
      ok: false,
      code: 'too_long',
    });
    // 每个汉字 3 字节：1366 个字符 = 4098 字节，超过上限。
    expect(bridge.submit('中'.repeat(1366))).toEqual({ ok: false, code: 'too_long' });
    expect(bridge.snapshot()).toHaveLength(1);
  });

  it('notifies the inbound handler only for accepted messages', () => {
    const bridge = new WebChatBridge();
    const onSubmit = vi.fn<(text: string) => void>();
    bridge.onSubmit = onSubmit;

    expect(bridge.submit('')).toEqual({ ok: false, code: 'empty' });
    expect(bridge.submit('a'.repeat(MAX_CHAT_INBOUND_BYTES + 1))).toEqual({
      ok: false,
      code: 'too_long',
    });
    expect(onSubmit).not.toHaveBeenCalled();

    expect(bridge.submit('你好')).toEqual({ ok: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('你好');
  });

  it('does not let a throwing inbound handler reject the submission', () => {
    const bridge = new WebChatBridge();
    bridge.onSubmit = () => {
      throw new Error('plugin boom');
    };

    expect(bridge.submit('你好')).toEqual({ ok: true });
    expect(bridge.snapshot()).toHaveLength(1);
  });

  it('returns closed after close() and detaches the inbound handler', () => {
    const bridge = new WebChatBridge();
    const onSubmit = vi.fn<(text: string) => void>();
    bridge.onSubmit = onSubmit;

    bridge.close();
    bridge.close();

    expect(bridge.submit('你好')).toEqual({ ok: false, code: 'closed' });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(bridge.onSubmit).toBeNull();
  });
});

describe('WebChatBridge outbound', () => {
  it('appends agent messages in order with their own seq', () => {
    const bridge = new WebChatBridge();
    bridge.submit('问题');
    bridge.appendAgent('回答一');
    bridge.appendAgent('回答二');

    expect(bridge.snapshot().map((message) => [message.seq, message.role, message.text])).toEqual([
      [1, 'owner', '问题'],
      [2, 'agent', '回答一'],
      [3, 'agent', '回答二'],
    ]);
  });

  it('ignores appends after close', () => {
    const bridge = new WebChatBridge();
    bridge.close();
    bridge.appendAgent('迟到的回复');
    expect(bridge.snapshot()).toEqual([]);
  });
});

describe('WebChatBridge ring buffer', () => {
  it('keeps the newest 500 messages and never reuses a seq', () => {
    const bridge = new WebChatBridge();
    for (let index = 0; index < MAX_CHAT_MESSAGES + 5; index += 1) {
      bridge.submit(`m${index}`);
    }

    const messages = bridge.snapshot();
    expect(messages).toHaveLength(MAX_CHAT_MESSAGES);
    expect(messages[0]?.seq).toBe(6);
    expect(messages[0]?.text).toBe('m5');
    expect(messages[messages.length - 1]?.seq).toBe(MAX_CHAT_MESSAGES + 5);

    // 淘汰后 seq 继续递增：新消息拿到的编号不能被已淘汰的旧编号复用。
    bridge.submit('after eviction');
    expect(bridge.snapshot(1)[0]?.seq).toBe(MAX_CHAT_MESSAGES + 6);
  });

  it('reads increments strictly after the given seq', () => {
    const bridge = new WebChatBridge();
    for (let index = 0; index < 4; index += 1) bridge.submit(`m${index}`);

    expect(bridge.since(0).map((message) => message.seq)).toEqual([1, 2, 3, 4]);
    expect(bridge.since(2).map((message) => message.seq)).toEqual([3, 4]);
    expect(bridge.since(4)).toEqual([]);
    expect(bridge.since(99)).toEqual([]);
  });

  it('returns the most recent messages from snapshot(limit)', () => {
    const bridge = new WebChatBridge();
    for (let index = 0; index < 10; index += 1) bridge.submit(`m${index}`);

    expect(bridge.snapshot(3).map((message) => message.seq)).toEqual([8, 9, 10]);
    expect(bridge.snapshot(0)).toEqual([]);
    expect(bridge.snapshot(-1)).toEqual([]);
    expect(bridge.snapshot(100)).toHaveLength(10);
    expect(bridge.snapshot()).toHaveLength(10);
  });

  it('reopens after close without losing the buffer', () => {
    // 插件重载走 close → activate → open；不重开的话网页对话永久发不出消息。
    const bridge = new WebChatBridge();
    bridge.submit('before');

    bridge.close();
    expect(bridge.submit('while closed')).toEqual({ ok: false, code: 'closed' });

    bridge.open();
    expect(bridge.submit('after')).toEqual({ ok: true });
    expect(bridge.snapshot().map((message) => message.text)).toEqual(['before', 'after']);
  });
});
