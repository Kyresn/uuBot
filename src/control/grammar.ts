/**
 * 前缀指令语法：`#帮助` / `＃状态` / `确认 <id>`。
 *
 * 这里只做**词法**：规范化（NFKC 折叠全角 `＃`）、长度与参数个数上限、
 * 命令词到内部名的映射。参数是否符合 `<id>` / `<能力插件>` / `<群号>` /
 * `<分钟>` 的正则由 `INTENT_SPECS[intent].parse` 负责，语义错误回「用法」
 * 文本而不是猜。
 *
 * 以 `#` 开头但解析失败一律回 `{ kind:'usage' }`：控制面的错误提示不能
 * 变成聊天消息进入感知队列（不变量 1、2）。
 */
import { stripUnsafeControls } from '../util/tty.js';

/** 控制指令的内部名；一个名字对应一个或多个别名。 */
export type CommandName =
  | 'help'
  | 'status'
  | 'approvals'
  | 'approve'
  | 'deny'
  | 'ban'
  | 'unban'
  | 'quiet'
  | 'resume'
  | 'confirm';

export type ParsedCommand =
  | { kind: 'command'; name: CommandName; args: string[] }
  | { kind: 'usage'; reason: string };

/** 指令上限：超长输入不解析，避免把整段聊天当参数。 */
export const MAX_COMMAND_LENGTH = 512;
/** 参数上限（`#拒绝 <id> [理由]` 的理由也在这个预算内）。 */
export const MAX_COMMAND_ARGS = 4;

const ALIASES: Readonly<Record<string, CommandName>> = {
  '#帮助': 'help',
  '#help': 'help',
  '#状态': 'status',
  '#status': 'status',
  '#审批': 'approvals',
  '#approvals': 'approvals',
  '#同意': 'approve',
  '#approve': 'approve',
  '#拒绝': 'deny',
  '#deny': 'deny',
  '#封禁': 'ban',
  '#ban': 'ban',
  '#解封': 'unban',
  '#unban': 'unban',
  '#安静': 'quiet',
  '#quiet': 'quiet',
  '#恢复': 'resume',
  '#resume': 'resume',
};

/** 审批 id 的完整形状；`确认` 只有带完整 id 才构成指令。 */
const ID_PATTERN = /^ap_[0-9a-f]{32}$/;

/** 用法提示里最多回显多少字符的命令词（不可信文本，净化 + 限长）。 */
const MAX_ECHO_LENGTH = 32;

function safeEcho(value: string): string {
  const cleaned = stripUnsafeControls(value).replace(/[\r\n]+/g, ' ').trim();
  return cleaned.length > MAX_ECHO_LENGTH ? `${cleaned.slice(0, MAX_ECHO_LENGTH)}...` : cleaned;
}

/**
 * 解析一条文本。不是指令时返回 `null`（调用方按普通聊天处理）；
 * 是指令但语法不合法时返回 `{ kind:'usage' }`（调用方回帮助摘要）。
 */
export function parseCommand(text: string): ParsedCommand | null {
  // stripUnsafeControls 同时做 NFKC：全角 `＃` 会折叠成 `#`。
  const normalized = stripUnsafeControls(text).trim();
  if (normalized === '') return null;

  const hashPrefixed = normalized.startsWith('#');
  // `确认` 只有在独立成词时才可能是指令；「确认一下」是普通聊天。
  const confirmPrefixed = /^确认(?:\s|$)/u.test(normalized);
  if (!hashPrefixed && !confirmPrefixed) return null;

  const tokens = normalized.split(/\s+/u);
  if (!hashPrefixed) {
    // 只有「确认 <完整 ap_ id>」才是指令。裸「确认」、`确认 明天下午三点`
    // 以及任何其他文本都交回聊天/分类器，绝不在这里吞掉。
    if (tokens.length !== 2 || !ID_PATTERN.test(tokens[1] ?? '')) return null;
  }

  if ([...normalized].length > MAX_COMMAND_LENGTH) {
    return { kind: 'usage', reason: `指令过长（上限 ${MAX_COMMAND_LENGTH} 字符）。` };
  }

  const head = tokens[0] ?? '';
  let name: CommandName;
  if (!hashPrefixed) {
    name = 'confirm';
  } else {
    const resolved = ALIASES[head.toLowerCase()];
    if (resolved === undefined) {
      return { kind: 'usage', reason: `未知指令「${safeEcho(head)}」。` };
    }
    name = resolved;
  }

  const args = tokens.slice(1);
  if (args.length > MAX_COMMAND_ARGS) {
    return { kind: 'usage', reason: `参数过多（上限 ${MAX_COMMAND_ARGS} 个）。` };
  }

  return { kind: 'command', name, args };
}
