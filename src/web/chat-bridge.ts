/**
 * 网页对话桥接：入站提交、出站追加、按 `seq` 增量读取。
 *
 * 语义（spec §3.2）：
 * - 只存内存：网页对话不是记忆；重启即清空，页面明写这一点。
 * - 环形缓冲上限 500 条，超出淘汰最旧；`seq` 单调递增、永不重用。
 * - 入站单条上限 4 KiB（UTF-8 字节），超出 `too_long`；空白输入 `empty`。
 * - 出站文本已经过红线闸，追加前不再净化；渲染端一律 `textContent`。
 *
 * 入站回调 `onSubmit` 由 web 插件在 `activate` 时挂上、`close` 时摘下：
 * 桥接不依赖插件，API 只认这一个实例。
 */

/** 环形缓冲上限。 */
export const MAX_CHAT_MESSAGES = 500;
/** 入站单条消息的字节上限（UTF-8）。 */
export const MAX_CHAT_INBOUND_BYTES = 4 * 1024;

export type ChatRole = 'owner' | 'agent';

export interface ChatMessage {
  seq: number;
  ts: string;
  role: ChatRole;
  text: string;
}

export type ChatSubmitResult =
  | { ok: true }
  | { ok: false; code: 'empty' | 'too_long' | 'closed' };

export class WebChatBridge {
  /**
   * 入站回调：web 插件在 activate 时赋值，deactivate/close 时清空。
   * 抛错只影响本条提交的唤醒，绝不把异常抛回 HTTP 请求。
   */
  onSubmit: ((text: string) => void) | null = null;

  private readonly messages: ChatMessage[] = [];
  private nextSeq = 1;
  private closed = false;

  /**
   * 提交一条 owner 消息。校验顺序固定：关闭 → 空白 → 超长，因此关闭后
   * 任何输入都只得到 `closed`，不会泄露消息是否合法。
   */
  submit(text: string): ChatSubmitResult {
    if (this.closed) return { ok: false, code: 'closed' };
    if (text.trim() === '') return { ok: false, code: 'empty' };
    if (Buffer.byteLength(text, 'utf8') > MAX_CHAT_INBOUND_BYTES) {
      return { ok: false, code: 'too_long' };
    }

    this.push('owner', text);

    const handler = this.onSubmit;
    if (handler !== null) {
      try {
        handler(text);
      } catch {
        // 插件故障不得影响 API：消息已入桥接，只是这次没有唤醒。
      }
    }
    return { ok: true };
  }

  /** 追加一条 agent 回复；关闭后忽略（关闭意味着进程正在退出）。 */
  appendAgent(text: string): void {
    if (this.closed) return;
    this.push('agent', text);
  }

  /** 返回 `seq` 严格大于给定值的最旧→最新消息。 */
  since(seq: number): ChatMessage[] {
    const after = Number.isFinite(seq) ? Math.max(0, Math.floor(seq)) : 0;
    return this.messages.filter((message) => message.seq > after);
  }

  /** 返回最近的 `limit` 条消息（缺省为整个缓冲，最多 500 条）。 */
  snapshot(limit: number = MAX_CHAT_MESSAGES): ChatMessage[] {
    const count = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
    if (count === 0) return [];
    return this.messages.slice(Math.max(0, this.messages.length - count));
  }

  /**
   * 关闭入站路径：之后的 `submit` 返回 `closed`，`appendAgent` 被忽略。
   * 幂等；关闭后仍可读缓冲（关闭序列里网页读请求晚于写入关闭）。
   */
  close(): void {
    this.closed = true;
    this.onSubmit = null;
  }

  /**
   * 重新打开入站路径。插件重载（`host.reload('web')`）会先 `close` 再
   * `activate`，没有这一步桥接就永久关闭，网页对话再也发不出消息。
   * 只清关闭标志，不碰缓冲——重载不该抹掉已经发生的对话。
   */
  open(): void {
    this.closed = false;
  }

  private push(role: ChatRole, text: string): void {
    this.messages.push({
      seq: this.nextSeq,
      ts: new Date().toISOString(),
      role,
      text,
    });
    this.nextSeq += 1;

    // 环形语义：只保留最新 500 条，`seq` 不随淘汰回收。
    const overflow = this.messages.length - MAX_CHAT_MESSAGES;
    if (overflow > 0) this.messages.splice(0, overflow);
  }
}
