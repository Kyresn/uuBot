/**
 * 网页对话 API（spec §3.5）：
 * - `POST /api/chat/messages` `{text}` → `{ok, seq}`；
 * - `GET /api/chat/messages?after=<seq>` → `{ok, messages, lastSeq}`。
 *
 * 两条路由沿用既有全部闸：会话、Host、Origin、`X-Uuharness-Console`、JSON、
 * 体积上限。这里只做形状校验与桥接调用：入站上限、空输入与关闭语义都在
 * `WebChatBridge` 里，API 把错误码原样映射为 400/503。
 *
 * `after` 缺省（或空串）表示「最近 200 条」；非法值一律 400 `invalid_query`，
 * 不把 seq 空间变成探测 oracle。
 */
import type { ChatMessage, WebChatBridge } from './chat-bridge.js';
import type { RouteHandler } from './server.js';

/** 缺省页大小：只影响首屏与重连，不影响增量轮询。 */
const DEFAULT_PAGE_LIMIT = 200;

export interface ChatApiDeps {
  /** 与 web 插件共用的唯一桥接实例。 */
  bridge: WebChatBridge;
  log?: (line: string) => void;
}

export interface ChatApi {
  handlers: {
    chatMessages: RouteHandler;
    chatHistory: RouteHandler;
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 最新一条消息的 seq；空缓冲为 0。GET 用它推进前端的游标。 */
function lastSeqOf(bridge: WebChatBridge): number {
  return bridge.snapshot(1)[0]?.seq ?? 0;
}

export function createChatApi(deps: ChatApiDeps): ChatApi {
  const log = deps.log ?? (() => {});
  const bridge = deps.bridge;

  const chatMessages: RouteHandler = (ctx) => {
    const body = ctx.body;
    if (!isPlainObject(body)) {
      ctx.send(400, { ok: false, code: 'invalid_body' });
      return;
    }
    const text = body['text'];
    if (typeof text !== 'string') {
      ctx.send(400, { ok: false, code: 'invalid_body' });
      return;
    }

    try {
      const result = bridge.submit(text);
      if (!result.ok) {
        if (result.code === 'closed') {
          // 桥接关闭只发生在关闭序列：写入闸之后仍可能有在途请求。
          ctx.send(503, { ok: false, code: 'closed' });
          return;
        }
        ctx.send(400, { ok: false, code: result.code });
        return;
      }

      const newest = bridge.snapshot(1)[0];
      if (newest === undefined) {
        // 理论不可达：submit 成功必然刚追加一条。
        ctx.send(503, { ok: false, code: 'closed' });
        return;
      }
      ctx.send(200, { ok: true, seq: newest.seq });
    } catch (error) {
      // 桥接故障只降级本页；绝不冒泡到心跳。
      log(`chat api: ${error instanceof Error ? error.message : String(error)}`);
      ctx.send(503, { ok: false, code: 'chat_unavailable' });
    }
  };

  const chatHistory: RouteHandler = (ctx) => {
    const raw = ctx.url.searchParams.get('after');
    let messages: ChatMessage[];

    try {
      if (raw === null || raw === '') {
        messages = bridge.snapshot(DEFAULT_PAGE_LIMIT);
      } else {
        if (!/^\d+$/.test(raw)) {
          ctx.send(400, { ok: false, code: 'invalid_query' });
          return;
        }
        const after = Number(raw);
        if (!Number.isSafeInteger(after)) {
          ctx.send(400, { ok: false, code: 'invalid_query' });
          return;
        }
        messages = bridge.since(after);
      }
      ctx.send(200, { ok: true, messages, lastSeq: lastSeqOf(bridge) });
    } catch (error) {
      log(`chat api: ${error instanceof Error ? error.message : String(error)}`);
      ctx.send(503, { ok: false, code: 'chat_unavailable' });
    }
  };

  return { handlers: { chatMessages, chatHistory } };
}
