/**
 * 控制面审计流水：`DATA_DIR/control-audit.jsonl`。
 *
 * spec §9 承诺的「可审计」落在这里：每条 owner 指令、每次审批决策、每次
 * 执行结果各追加一行。与 `transcript.jsonl` 一样是非阻塞有界队列：
 * `record()` 只入队，写盘在后台 drain；写失败只记日志，绝不抛进控制面
 * 或心跳。文件 0600，达到 16 MB 轮转到 `.1`。
 *
 * 字段都是代码构造的受限值；唯一来自外部的 `command` 文本先净化、压成
 * 单行并截断，避免 ANSI/换行破坏 JSONL 或伪造审计行。
 */
import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { stripUnsafeControls } from '../util/tty.js';

export type ControlAuditEvent = 'command' | 'decision' | 'execution';

/** 一行审计记录；按 event 使用不同字段。 */
export interface ControlAuditRow {
  ts?: string;
  event: ControlAuditEvent;
  /** command：来源通道与 actor。 */
  via?: string;
  actor?: string;
  command?: string;
  intent?: string;
  result?: string;
  approvalId?: string;
  /** decision / execution：审批身份与结果。 */
  id?: string;
  kind?: string;
  decision?: string;
  by?: string;
  reason?: string;
  ok?: boolean;
  error?: string;
}

export interface ControlAuditSink {
  record(row: ControlAuditRow): void;
}

export interface ControlAuditLogOptions {
  file: string;
  log: (line: string) => void;
  /** 轮转阈值，默认 16 MB。 */
  maxBytes?: number;
  /** 内存队列上限，默认 1000；溢出丢最旧并记日志。 */
  maxQueue?: number;
  now?: () => number;
}

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_QUEUE = 1000;
const DEFAULT_FLUSH_TIMEOUT_MS = 5_000;
const FILE_MODE = 0o600;
const MAX_FIELD = 200;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** 字符串字段统一净化：单行 + 限长；数字/布尔原样保留。 */
function cleanRow(row: ControlAuditRow): ControlAuditRow {
  const out: ControlAuditRow = { ...row };
  for (const key of [
    'via',
    'actor',
    'command',
    'intent',
    'result',
    'approvalId',
    'id',
    'kind',
    'decision',
    'by',
    'reason',
    'error',
  ] as const) {
    const value = out[key];
    if (typeof value !== 'string') continue;
    const cleaned = stripUnsafeControls(value).replace(/[\r\n]+/g, ' ').trim();
    out[key] = cleaned.length > MAX_FIELD ? `${cleaned.slice(0, MAX_FIELD)}...` : cleaned;
  }
  return out;
}

export class ControlAuditLog implements ControlAuditSink {
  readonly file: string;
  private readonly log: (line: string) => void;
  private readonly maxBytes: number;
  private readonly maxQueue: number;
  private readonly now: () => number;

  private queue: ControlAuditRow[] = [];
  private draining: Promise<void> | null = null;

  constructor(opts: ControlAuditLogOptions) {
    this.file = opts.file;
    this.log = opts.log;
    this.maxBytes = Math.max(1, opts.maxBytes ?? DEFAULT_MAX_BYTES);
    this.maxQueue = Math.max(1, opts.maxQueue ?? DEFAULT_MAX_QUEUE);
    this.now = opts.now ?? Date.now;
  }

  /** 入队一行；同步返回，绝不 await I/O，也绝不抛错。 */
  record(row: ControlAuditRow): void {
    this.queue.push(cleanRow({ ...row, ts: row.ts ?? new Date(this.now()).toISOString() }));
    if (this.queue.length > this.maxQueue) {
      const dropped = this.queue.length - this.maxQueue;
      this.queue.splice(0, dropped);
      this.log(`control-audit: dropped ${dropped} oldest row(s); queue is full`);
    }
    this.scheduleDrain();
  }

  /** 等待队列清空与在途写入完成；超时只记日志并返回。 */
  async flush(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (this.queue.length > 0 || this.draining !== null) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.log(`control-audit: flush timed out with ${this.queue.length} row(s) pending`);
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

  private scheduleDrain(): void {
    if (this.draining !== null) return;
    this.draining = this.drain().finally(() => {
      this.draining = null;
      if (this.queue.length > 0) this.scheduleDrain();
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.queue.length);
      try {
        await mkdir(path.dirname(this.file), { recursive: true });
        await this.rotateIfNeeded();
        const payload = batch.map((row) => `${JSON.stringify(row)}\n`).join('');
        await appendFile(this.file, payload, { mode: FILE_MODE });
      } catch (error) {
        // 审计写失败只记日志：控制面与心跳绝不因磁盘问题失败。
        this.log(`control-audit: write failed: ${describeError(error)}`);
      }
    }
  }

  private async rotateIfNeeded(): Promise<void> {
    let size: number;
    try {
      size = (await stat(this.file)).size;
    } catch {
      return; // 文件不存在：无需轮转。
    }
    if (size < this.maxBytes) return;

    const rotated = `${this.file}.1`;
    try {
      await rm(rotated, { force: true });
      await rename(this.file, rotated);
      this.log(`control-audit: rotated ${path.basename(this.file)} at ${size} bytes`);
    } catch (error) {
      this.log(`control-audit: rotation failed: ${describeError(error)}`);
    }
  }
}
