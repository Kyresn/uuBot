import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PerceptionQueue } from '../src/core/events.js';
import { CliChannel } from '../src/channels/cli.js';

/** Minimal readable-stream stand-in: readline only needs data/on/setEncoding/resume. */
class FakeInput extends EventEmitter {
  setEncoding(_encoding: string): this {
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
  asStream(): NodeJS.ReadableStream {
    return this as unknown as NodeJS.ReadableStream;
  }
}

describe('CliChannel', () => {
  let queue: PerceptionQueue;
  let input: FakeInput;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new PerceptionQueue();
    input = new FakeInput();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pushes a cli_message event for each input line', () => {
    const channel = new CliChannel({ queue, input: input.asStream(), onSend: vi.fn() });
    channel.start();

    input.emit('data', 'hello\n');
    input.emit('data', 'second line\n');

    const events = queue.drain();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: 'cli_message',
      channel: 'cli',
      actor: 'user',
      content: 'hello',
      importance: 8,
    });
    expect(events[0]?.id).toBeTypeOf('string');
    expect(events[0]?.id).not.toBe('');
    expect(events[0]?.ts).toBeTypeOf('number');
    expect(events[1]?.content).toBe('second line');
    expect(events[0]?.id).not.toBe(events[1]?.id);
  });

  it('requests a debounced wake for each input line', () => {
    const channel = new CliChannel({ queue, input: input.asStream(), onSend: vi.fn() });
    const wake = vi.fn();
    queue.onWake(wake);
    channel.start();

    input.emit('data', 'wake me\n');
    expect(wake).not.toHaveBeenCalled();

    vi.advanceTimersByTime(3000);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('send delegates to the injected onSend', () => {
    const onSend = vi.fn();
    const channel = new CliChannel({ queue, input: input.asStream(), onSend });

    channel.send('hi');

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('hi');
  });

  it('send defaults to console.log', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const channel = new CliChannel({ queue, input: input.asStream() });

    channel.send('hi');

    expect(log).toHaveBeenCalledWith('hi');
    log.mockRestore();
  });

  it('uses the queue id generator for input events', () => {
    queue.setSizeGen(() => 'fixed-id');
    const channel = new CliChannel({ queue, input: input.asStream(), onSend: vi.fn() });
    channel.start();

    input.emit('data', 'hello\n');

    expect(queue.drain()[0]?.id).toBe('fixed-id');
  });

  it('ignores blank and whitespace-only input lines', () => {
    const channel = new CliChannel({ queue, input: input.asStream(), onSend: vi.fn() });
    channel.start();

    input.emit('data', '\n');
    input.emit('data', '   \n');
    input.emit('data', '\t\n');

    expect(queue.drain()).toHaveLength(0);
  });

  it('start is idempotent and does not double-subscribe', () => {
    const channel = new CliChannel({ queue, input: input.asStream(), onSend: vi.fn() });
    channel.start();
    channel.start();

    input.emit('data', 'once\n');

    expect(queue.drain()).toHaveLength(1);
  });
});
