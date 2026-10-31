import { describe, expect, it } from 'vitest';
import { parseCommand } from '../../src/control/grammar.js';

const ID = 'ap_0123456789abcdef0123456789abcdef';

function command(text: string): { name: string; args: string[] } | null {
  const parsed = parseCommand(text);
  if (parsed === null || parsed.kind !== 'command') return null;
  return { name: parsed.name, args: parsed.args };
}

describe('control grammar', () => {
  it('accepts the full-width hash and normalizes it', () => {
    expect(command('＃状态')).toEqual({ name: 'status', args: [] });
    expect(command('＃审批')).toEqual({ name: 'approvals', args: [] });
  });

  it('collapses arbitrary whitespace between tokens', () => {
    expect(command('#安静   123\t30')).toEqual({ name: 'quiet', args: ['123', '30'] });
    expect(command('  #同意    ap_0123456789abcdef0123456789abcdef  ')).toEqual({
      name: 'approve',
      args: ['ap_0123456789abcdef0123456789abcdef'],
    });
  });

  it('maps every Chinese command and its English alias', () => {
    const cases: Array<[string, string]> = [
      ['#帮助', 'help'],
      ['#help', 'help'],
      ['#状态', 'status'],
      ['#status', 'status'],
      ['#审批', 'approvals'],
      ['#approvals', 'approvals'],
      ['#同意', 'approve'],
      ['#approve', 'approve'],
      ['#拒绝', 'deny'],
      ['#deny', 'deny'],
      ['#封禁', 'ban'],
      ['#ban', 'ban'],
      ['#解封', 'unban'],
      ['#unban', 'unban'],
      ['#安静', 'quiet'],
      ['#quiet', 'quiet'],
      ['#恢复', 'resume'],
      ['#resume', 'resume'],
    ];

    for (const [text, name] of cases) {
      expect(command(text)).toEqual({ name, args: [] });
    }
  });

  it('is case-insensitive for ASCII aliases', () => {
    expect(command('#HELP')).toEqual({ name: 'help', args: [] });
    expect(command('#Approve ap_0123456789abcdef0123456789abcdef')).toEqual({
      name: 'approve',
      args: ['ap_0123456789abcdef0123456789abcdef'],
    });
  });

  it('only accepts a full approval id after 确认', () => {
    expect(command('确认 ap_0123456789abcdef0123456789abcdef')).toEqual({
      name: 'confirm',
      args: ['ap_0123456789abcdef0123456789abcdef'],
    });
    // 裸「确认」不构成指令：不批准任何动作，按聊天处理。
    expect(parseCommand('确认')).toBeNull();
    // 普通聊天词不是指令。
    expect(parseCommand('确认一下明天几点')).toBeNull();
    // 只有完整 ap_ id 才是确认指令；其他文本交回聊天/分类器。
    expect(parseCommand('确认 明天下午三点')).toBeNull();
    expect(parseCommand('确认 ap_short')).toBeNull();
  });

  it('returns null for ordinary chat', () => {
    expect(parseCommand('你好')).toBeNull();
    expect(parseCommand('今天天气不错')).toBeNull();
    expect(parseCommand('')).toBeNull();
  });

  it('treats an unknown # command as usage, never as chat', () => {
    expect(parseCommand('#不存在')).toEqual({ kind: 'usage', reason: expect.any(String) });
    expect(parseCommand('#')).toEqual({ kind: 'usage', reason: expect.any(String) });
  });

  it('rejects more than four arguments as usage', () => {
    expect(parseCommand('#安静 1 2 3 4 5')).toEqual({
      kind: 'usage',
      reason: expect.any(String),
    });
  });

  it('rejects commands longer than 512 characters as usage', () => {
    const long = `#封禁 ${'a'.repeat(600)}`;
    expect(parseCommand(long)).toEqual({ kind: 'usage', reason: expect.any(String) });
  });

  it('accepts exactly 512 characters', () => {
    const reason = 'a'.repeat(512 - '#拒绝 '.length - ID.length - 1);
    const text = `#拒绝 ${ID} ${reason}`;
    expect([...text].length).toBe(512);
    expect(command(text)).toEqual({ name: 'deny', args: [ID, reason] });
  });

  it('rejects exactly 513 characters as usage', () => {
    const reason = 'a'.repeat(513 - '#拒绝 '.length - ID.length - 1);
    const text = `#拒绝 ${ID} ${reason}`;
    expect([...text].length).toBe(513);
    expect(parseCommand(text)?.kind).toBe('usage');
  });

  it('never echoes unsafe control characters in the usage reason', () => {
    const parsed = parseCommand('#\u001b[31m坏\u001b[0m');
    expect(parsed?.kind).toBe('usage');
    if (parsed?.kind === 'usage') {
      expect(parsed.reason).not.toContain('\u001b');
    }
  });

  it('leaves missing arguments to the intent layer', () => {
    expect(command('#同意')).toEqual({ name: 'approve', args: [] });
    expect(command('#封禁')).toEqual({ name: 'ban', args: [] });
  });
});
