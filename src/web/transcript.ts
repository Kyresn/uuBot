/**
 * 对话记录：非阻塞 JSONL 追加 + 只读尾部窗口的历史查询。
 *
 * 设计约束（见 docs/superpowers/specs/2026-10-29-web-console-design.md）：
 * - 入站/出站记录只做原始 JSON 转义，不做 NFKC；净化只用于 TTY/日志。
 * - `record()` 只入队，绝不 await I/O；内部队列有界（默认 1000），溢出丢最旧。
 * - 每次 append 前 stat 判断轮转（默认 32 MB → 重命名为 `.1`），启动时也检查。
 * - 写失败只记日志，绝不影响调用方（发送与心跳路径）。
 * - 关闭时 `flush(timeoutMs)` 有界等待，超时只记日志。
 *
 * 历史查询只读文件尾部 1 MB（`fs.open` + 偏移读取），丢弃首块不完整行与
 * 末尾未终止行，跳过解析失败的行；`channel` 在解析后精确匹配。
 */
import {
  appendFile as fsAppendFile,
  chmod as fsChmod,
  mkdir as fsMkdir,
  open as fsOpen,
  rename as fsRename,
  rm as fsRm,
  stat as fsStat,
} from 'node:fs/promises';
import path from 'node:path';
import type { RouteHandler } from './server.js';

export type TranscriptDirection = 'in' | 'out';
export type TranscriptStatus = 'dispatched' | 'blocked';

/** 一行对话记录；入站与出站共用同一形状，按 direction 取不同字段。 */
export interface TranscriptRecord {
  ts: string;
  direction: TranscriptDirection;
  channel: string;
  status?: TranscriptStatus;
  actor?: string;
  kind?: string;
  importance?: number;
  content?: string;
  text?: string;
  reason?: string;
}

/** 记录接收方：写入器与测试替身的最小接口。 */
export interface TranscriptSink {
  record(event: TranscriptRecord): void;
}

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_QUEUE = 1000;
const DEFAULT_FLUSH_TIMEOUT_MS = 5_000;
const DEFAULT_TAIL_BYTES = 1024 * 1024;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const FILE_MODE = 0o600;

/** 可注入的文件系统操作；测试用它模拟写失败/卡住与轮转。 */
export interface TranscriptIo {
  mkdir(dir: string): Promise<void>;
  stat(file: string): Promise<{ size: number }>;
  appendFile(file: string, data: string, options: { mode: number }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(file: string): Promise<void>;
  chmod(file: string, mode: number): Promise<void>;
}

const defaultIo: TranscriptIo = {
  mkdir: async (dir) => {
    await fsMkdir(dir, { recursive: true });
  },
  stat: async (file) => {
    const info = await fsStat(file);
    return { size: info.size };
  },
  appendFile: (file, data, options) => fsAppendFile(file, data, options),
  rename: (from, to) => fsRename(from, to),
  rm: (file) => fsRm(file, { force: true }),
  chmod: (file, mode) => fsChmod(file, mode),
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // 不阻止进程退出：flush 的等待计时器不得在 flush 返回后继续吊住事件循环。
    timer.unref?.();
  });
}

export interface TranscriptWriterOptions {
  file: string;
  log: (line: string) => void;
  /** 轮转阈值，默认 32 MB；测试可调小。 */
  maxBytes?: number;
  /** 内存队列上限，默认 1000。 */
  maxQueue?: number;
  /** 文件系统注入，默认 node:fs/promises。 */
  io?: Partial<TranscriptIo>;
}

/**
 * 有界、非阻塞的 JSONL 写入器。所有 I/O 都在后台 drain 循环里完成，
 * `record()` 只做入队与调度，因此心跳/发送路径永远不会等待磁盘。
 */
export class TranscriptWriter implements TranscriptSink {
  readonly file: string;
  private readonly log: (line: string) => void;
  private readonly maxBytes: number;
  private readonly maxQueue: number;
  private readonly io: TranscriptIo;

  private queue: TranscriptRecord[] = [];
  private draining: Promise<void> | null = null;
  private readonly preparing: Promise<void>;

  constructor(opts: TranscriptWriterOptions) {
    this.file = opts.file;
    this.log = opts.log;
    this.maxBytes = Math.max(1, opts.maxBytes ?? DEFAULT_MAX_BYTES);
    this.maxQueue = Math.max(1, opts.maxQueue ?? DEFAULT_MAX_QUEUE);
    this.io = { ...defaultIo, ...opts.io };
    // 启动检查：目录存在 + 已有文件超过阈值时立即轮转（不阻塞构造）。
    this.preparing = this.prepare();
  }

  /** 入队一条记录；同步返回，绝不 await I/O。 */
  record(event: TranscriptRecord): void {
    this.queue.push(event);
    if (this.queue.length > this.maxQueue) {
      const dropped = this.queue.length - this.maxQueue;
      this.queue.splice(0, dropped);
      this.log(`transcript: dropped ${dropped} oldest record(s); queue is full`);
    }
    this.scheduleDrain();
  }

  /**
   * 等待队列清空与在途写入完成；超时后只记日志并返回（关闭流程不能卡死）。
   */
  async flush(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (this.queue.length > 0 || this.draining !== null) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.log(`transcript: flush timed out with ${this.queue.length} record(s) pending`);
        return;
      }
      const active = this.draining;
      if (active === null) {
        await sleep(Math.min(remaining, 10));
        continue;
      }
      await Promise.race([active.catch(() => undefined), sleep(remaining)]);
    }
  }

  private async prepare(): Promise<void> {
    try {
      await this.io.mkdir(path.dirname(this.file));
      // 尽力而为：Windows 忽略权限位，失败不算错误。
      await this.io.chmod(this.file, FILE_MODE).catch(() => undefined);
      await this.rotateIfNeeded();
    } catch (error) {
      this.log(`transcript: init failed: ${describeError(error)}`);
    }
  }

  /** stat 先于 append；文件达到阈值就改名到 `.1`（Windows 上先删旧 `.1`）。 */
  private async rotateIfNeeded(): Promise<void> {
    let size: number;
    try {
      size = (await this.io.stat(this.file)).size;
    } catch {
      return; // 文件不存在：无需轮转。
    }
    if (size < this.maxBytes) return;

    const rotated = `${this.file}.1`;
    try {
      await this.io.rm(rotated);
      await this.io.rename(this.file, rotated);
      this.log(`transcript: rotated ${path.basename(this.file)} at ${size} bytes`);
    } catch (error) {
      // 轮转失败不阻塞写入：继续追加到原文件。
      this.log(`transcript: rotation failed: ${describeError(error)}`);
    }
  }

  private scheduleDrain(): void {
    if (this.draining !== null) return;
    this.draining = this.drain().finally(() => {
      this.draining = null;
      if (this.queue.length > 0) this.scheduleDrain();
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      // 取走当前全部记录：单次 append 一批，减少 I/O 次数。
      const batch = this.queue.splice(0, this.queue.length);
      await this.preparing;
      try {
        await this.rotateIfNeeded();
        const payload = batch.map((event) => `${JSON.stringify(event)}\n`).join('');
        await this.io.appendFile(this.file, payload, { mode: FILE_MODE });
      } catch (error) {
        // 写失败只记日志：对话记录不得影响发送与心跳。
        this.log(`transcript: write failed: ${describeError(error)}`);
      }
    }
  }
}

export interface ReadConversationsOptions {
  file: string;
  limit: number;
  channel?: string;
  direction?: TranscriptDirection;
  /** 包含边界：`ts >= afterTs`。 */
  afterTs?: string;
  /** 排除边界：`ts < beforeTs`；这是用户可见的时间过滤，不是翻页机制。 */
  beforeTs?: string;
  /**
   * 翻页游标 `<ts>~<n>`：由上一页的 `nextCursor` 原样传回。
   * `n` 是上一页里与 `ts` 相同的记录条数，用于跳过同一毫秒内已返回的记录。
   */
  cursor?: string;
  /** 只读窗口大小，默认 1 MB；测试可调小。 */
  tailBytes?: number;
}

export interface ConversationsResult {
  records: TranscriptRecord[];
  nextCursor?: string;
}

/** 翻页游标：`ts` 是上一页最旧记录的毫秒 ISO 时间，`n` 是同 `ts` 的已返回条数。 */
export interface CursorToken {
  ts: string;
  n: number;
}

/**
 * 解析游标。格式必须是 `<ts>~<n>` 且 `n` 为正整数；返回 null 由 HTTP 层
 * 转成 400，绝不能静默当成「没有游标」而重发第一页。
 */
export function parseCursorToken(raw: string): CursorToken | null {
  const index = raw.lastIndexOf('~');
  if (index <= 0) return null;
  const ts = raw.slice(0, index);
  const count = raw.slice(index + 1);
  // ts 必须是可解析的 ISO 时间：否则游标毫无意义，应当 400 而不是空页。
  if (!Number.isFinite(Date.parse(ts))) return null;
  if (!/^\d+$/.test(count)) return null;
  const n = Number(count);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return { ts, n };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 只保留已知字段并做类型检查；坏行返回 null 由调用方跳过。 */
function normalizeRecord(value: unknown): TranscriptRecord | null {
  if (!isPlainObject(value)) return null;

  const ts = value['ts'];
  const direction = value['direction'];
  const channel = value['channel'];
  if (typeof ts !== 'string') return null;
  if (direction !== 'in' && direction !== 'out') return null;
  if (typeof channel !== 'string') return null;

  const record: TranscriptRecord = { ts, direction, channel };
  const status = value['status'];
  if (status === 'dispatched' || status === 'blocked') record.status = status;
  for (const key of ['actor', 'kind', 'content', 'text', 'reason'] as const) {
    const field = value[key];
    if (typeof field === 'string') record[key] = field;
  }
  const importance = value['importance'];
  if (typeof importance === 'number' && Number.isFinite(importance)) {
    record.importance = importance;
  }
  return record;
}

interface TailRead {
  text: string;
  /** 窗口没有覆盖文件开头：更早的记录可能还存在。 */
  truncated: boolean;
}

async function readTail(file: string, tailBytes: number): Promise<TailRead | null> {
  let handle;
  try {
    handle = await fsOpen(file, 'r');
  } catch {
    return null; // 文件尚不存在：空历史。
  }

  try {
    const info = await handle.stat();
    const length = Math.min(info.size, Math.max(0, tailBytes));
    const buffer = Buffer.alloc(length);
    // 用实际读到的字节数切片：短读时 buffer 尾部是 NUL，直接 toString 会污染
    // 最后一行（甚至让整行解析失败而被丢弃）。
    const bytesRead =
      length > 0 ? (await handle.read(buffer, 0, length, info.size - length)).bytesRead : 0;
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), truncated: info.size > length };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * 读取并过滤历史记录。返回按时间正序的最后一页；`nextCursor` 是
 * `<最旧记录的 ts>~<该 ts 在本页出现的条数>`，把它原样传回 `cursor` 即可
 * 继续向前翻页。记录按追加顺序存放且没有稳定 id，同一毫秒可能有多条，
 * 因此游标必须同时携带「位置」而不能只靠时间戳。
 *
 * 每次查询都只重读尾部窗口，因此 cursor 只在**窗口内**匹配记录多于 limit
 * 时返回：否则继续翻页会重新读同一窗口、过滤后为空，翻页成为死路。
 * 窗口本身是硬边界，更早的记录（已轮转或被窗口截断）无法通过 cursor 取到。
 */
export async function readConversations(
  opts: ReadConversationsOptions,
): Promise<ConversationsResult> {
  const cursor = opts.cursor === undefined ? null : parseCursorToken(opts.cursor);
  // 直接调用时传入坏游标：返回空页而不是重发第一页（HTTP 层已先行 400）。
  if (opts.cursor !== undefined && cursor === null) return { records: [] };

  const tail = await readTail(opts.file, opts.tailBytes ?? DEFAULT_TAIL_BYTES);
  if (tail === null) return { records: [] };

  const lines = tail.text.split('\n');
  // 窗口从文件中间开始时，第一段可能被截断；一律丢弃更安全。
  if (tail.truncated && lines.length > 0) lines.shift();
  // 末尾没有换行说明最后一行可能只写了一半（进程崩溃）：丢弃。
  if (lines.length > 0 && !tail.text.endsWith('\n')) lines.pop();

  const parsed: TranscriptRecord[] = [];
  for (const line of lines) {
    if (line === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue; // 跳过解析失败的行。
    }
    const record = normalizeRecord(value);
    if (record !== null) parsed.push(record);
  }

  let filtered = parsed.filter((record) => {
    if (opts.channel !== undefined && record.channel !== opts.channel) return false;
    if (opts.direction !== undefined && record.direction !== opts.direction) return false;
    if (opts.afterTs !== undefined && record.ts < opts.afterTs) return false;
    if (opts.beforeTs !== undefined && record.ts >= opts.beforeTs) return false;
    return true;
  });

  if (cursor !== null) {
    // 按出现顺序数每个 ts 的总数，再保留 ts 更早的记录，以及 ts 相同但
    // 序号落在「总数 - 已返回条数」以内的记录；不依赖排序。
    const totals = new Map<string, number>();
    for (const record of filtered) totals.set(record.ts, (totals.get(record.ts) ?? 0) + 1);
    const seen = new Map<string, number>();
    const kept: TranscriptRecord[] = [];
    for (const record of filtered) {
      const occurrence = (seen.get(record.ts) ?? 0) + 1;
      seen.set(record.ts, occurrence);
      if (record.ts < cursor.ts) {
        kept.push(record);
      } else if (
        record.ts === cursor.ts &&
        occurrence <= (totals.get(record.ts) ?? 0) - cursor.n
      ) {
        kept.push(record);
      }
    }
    filtered = kept;
  }

  const rawLimit = Number.isFinite(opts.limit) ? Math.trunc(opts.limit) : DEFAULT_LIMIT;
  const limit = Math.min(MAX_LIMIT, Math.max(1, rawLimit));
  const page = filtered.length > limit ? filtered.slice(filtered.length - limit) : filtered;

  let nextCursor: string | undefined;
  // 只有窗口内还有未返回的匹配记录时才给 cursor；截断本身不是翻页依据，
  // 因为窗口每次查询都会重读，指向窗口外的 cursor 只会得到空页。
  if (filtered.length > limit) {
    const oldest = page[0];
    if (oldest !== undefined) {
      const shared = page.filter((record) => record.ts === oldest.ts).length;
      // 游标是无状态的：每次请求都重读同一窗口，`n` 必须表示该 ts 已**累计**
      // 返回的条数。若本页最旧记录与来游标同 ts，要把上一页的 n 累加进来；
      // 否则游标原地打转，更早的同毫秒记录永远取不到、翻页也不会结束。
      const n = cursor !== null && oldest.ts === cursor.ts ? cursor.n + shared : shared;
      nextCursor = `${oldest.ts}~${n}`;
    }
  }

  return nextCursor === undefined ? { records: page } : { records: page, nextCursor };
}

export interface ConversationsApiOptions {
  file: string;
  tailBytes?: number;
  /** 未提供 limit 时的默认值，默认 200。 */
  defaultLimit?: number;
}

type ParsedLimit = { ok: true; value: number } | { ok: false };
type ParsedDirection = { ok: true; value: TranscriptDirection | undefined } | { ok: false };

/** 严格整数解析：`abc`/`1.5` 一律 400；合法整数再 clamp 到 [1,500]。 */
function parseLimit(raw: string | null, fallback: number): ParsedLimit {
  if (raw === null || raw.trim() === '') {
    return { ok: true, value: Math.min(MAX_LIMIT, Math.max(1, Math.trunc(fallback))) };
  }
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return { ok: false };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) return { ok: false };
  return { ok: true, value: Math.min(MAX_LIMIT, Math.max(1, value)) };
}

function parseDirection(raw: string | null): ParsedDirection {
  if (raw === null || raw.trim() === '') return { ok: true, value: undefined };
  const value = raw.trim();
  if (value === 'in' || value === 'out') return { ok: true, value };
  return { ok: false };
}

function queryValue(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key);
  return value === null || value === '' ? undefined : value;
}

/** `GET /api/conversations` 的路由处理函数。 */
export function createConversationsApi(opts: ConversationsApiOptions): RouteHandler {
  const defaultLimit = opts.defaultLimit ?? DEFAULT_LIMIT;

  return async (ctx) => {
    const limit = parseLimit(ctx.url.searchParams.get('limit'), defaultLimit);
    if (!limit.ok) {
      ctx.send(400, { ok: false, code: 'invalid_limit', field: 'limit' });
      return;
    }

    const direction = parseDirection(ctx.url.searchParams.get('direction'));
    if (!direction.ok) {
      ctx.send(400, { ok: false, code: 'invalid_direction', field: 'direction' });
      return;
    }

    const channel = queryValue(ctx.url, 'channel');
    const afterTs = queryValue(ctx.url, 'afterTs');
    const beforeTs = queryValue(ctx.url, 'beforeTs');
    const cursor = queryValue(ctx.url, 'cursor');
    if (cursor !== undefined && parseCursorToken(cursor) === null) {
      ctx.send(400, { ok: false, code: 'invalid_cursor' });
      return;
    }

    const result = await readConversations({
      file: opts.file,
      limit: limit.value,
      ...(channel === undefined ? {} : { channel }),
      ...(direction.value === undefined ? {} : { direction: direction.value }),
      ...(afterTs === undefined ? {} : { afterTs }),
      ...(beforeTs === undefined ? {} : { beforeTs }),
      ...(cursor === undefined ? {} : { cursor }),
      ...(opts.tailBytes === undefined ? {} : { tailBytes: opts.tailBytes }),
    });

    ctx.send(200, { ok: true, ...result });
  };
}
