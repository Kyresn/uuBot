/**
 * TTY 输出中和：模型文本与端点文本都是不可信数据，直接打到终端可注入
 * ANSI/OSC/C1 转义、伪造换行或覆盖既有日志行。本模块提供唯一出口。
 *
 * 红线判定必须与出站使用同一份字符串：先 stripUnsafeControls 规范化，
 * 判定与发送都用它，避免“校验一份、渲染另一份”的差分绕过。
 */

/** 可信日志行的默认前缀。模型文本应传入不同的前缀（如 '|> '）以便区分。 */
const DEFAULT_LINE_PREFIX = '| ';

/**
 * 零宽/双向/不可见格式字符：可拆开关键词绕过红线匹配，也可伪造视觉顺序。
 * 含软连字符、蒙古文元音分隔符、词连接符、BOM、变体选择符与 tag 字符。
 */
const FORMAT_CHARS = new RegExp(
  '[\\u00ad\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060\\u2066-\\u2069\\ufeff\\ufe00-\\ufe0f\\u{e0000}-\\u{e007f}]',
  'gu',
);

/** C0（保留 \n \t）、DEL、C1、行/段分隔符。 */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g');

/** 转义序列：OSC（BEL/ST 结尾）、CSI（含私有参数如 ESC[>0c）、其他两字符转义。 */
const ESCAPE_SEQUENCES: ReadonlyArray<RegExp> = [
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g,
  /\u001b\[[0-?]*[ -\/]*[@-~]/g,
  /\u001b[@-Z\\-_]/g,
];

/** 只做净化，不加行前缀；红线判定与出站必须使用同一份字符串。 */
export function stripUnsafeControls(text: string): string {
  let result = text;
  for (const pattern of ESCAPE_SEQUENCES) result = result.replace(pattern, '');
  result = result.replace(FORMAT_CHARS, '').replace(CONTROL_CHARS, '');
  // NFKC 折叠全角/兼容字符（如 ｂｏｍｂ → bomb），让红线判定看到规范形式。
  // NFKC 可能产生新的格式/控制字符，因此规范化后二次剥离。
  result = result.normalize('NFKC');
  return result.replace(FORMAT_CHARS, '').replace(CONTROL_CHARS, '');
}

/**
 * 净化 + 每行前缀。前缀只负责区分来源（可信日志 vs 模型输出），本身不能
 * 阻止伪造——不可信文本里若自带同样的前缀，仍可能看起来像一条日志。
 * 真正的中和来自剥离转义/控制符；前缀用于让两类输出一眼可分。
 */
export function sanitizeForTty(text: string, linePrefix: string = DEFAULT_LINE_PREFIX): string {
  return stripUnsafeControls(text)
    .split('\n')
    .map(line => `${linePrefix}${line}`)
    .join('\n');
}
