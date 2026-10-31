import type { EndpointConfig, RequestTier } from '../config.js';
import {
  AllEndpointsDownError,
  classifyHttpError,
  type EndpointError,
  type EndpointSnapshot,
  EndpointPool,
} from './endpoints.js';
import type { ChatMessage, ToolCall, ToolDef, Usage } from './types.js';
import { readBoundedErrorBody } from '../util/error-body.js';

export type BrainResponse = {
  content: string | null;
  toolCalls: ToolCall[];
  reasoning: string | null;
  usage: Usage;
  endpoint: string;
  model: string;
};

export type BrainUsageEvent = {
  endpoint: string;
  model: string;
  usage: Usage;
};

export type BrainOptions = {
  /** 单次请求超时；传函数时每次请求读取（热生效的 `http.timeoutMs`）。 */
  timeoutMs: number | (() => number);
  onUsage?: (event: BrainUsageEvent) => void;
};

export type ChatOptions = {
  tier?: RequestTier;
  tools?: ToolDef[];
};

function errorName(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = (error as { name: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return '';
}

/** Maps a fetch rejection (network failure or AbortSignal timeout) to a pool error. */
export function classifyFetchError(error: unknown): EndpointError {
  const name = errorName(error);
  if (name === 'TimeoutError' || name === 'AbortError') return { kind: 'timeout' };
  return { kind: 'network' };
}

/** Only the endpoint name and status/kind ever reach an error message — never headers or bodies. */
function describeFailure(endpoint: string, error: EndpointError): string {
  return `${endpoint} (${error.status ?? error.kind})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Extracts a chat completion from a raw JSON body. `reasoning_content` is split out
 * so it never re-enters the conversation history. Returns null for a malformed body
 * so the caller can treat it as an endpoint failure.
 */
export function parseCompletion(payload: unknown): Omit<BrainResponse, 'endpoint' | 'model'> | null {
  if (!isRecord(payload)) return null;

  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;

  const choice = choices[0];
  if (!isRecord(choice)) return null;

  const message = choice.message;
  if (!isRecord(message)) return null;

  const content = typeof message.content === 'string' ? message.content : null;
  const reasoning =
    typeof message.reasoning_content === 'string' ? message.reasoning_content : null;
  const toolCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as ToolCall[]) : [];

  // An empty assistant message is not a usable completion; fail over instead of
  // returning a blank response.
  if (content === null && reasoning === null && toolCalls.length === 0) return null;

  let promptTokens = 0;
  let completionTokens = 0;
  if (isRecord(payload.usage)) {
    if (typeof payload.usage.prompt_tokens === 'number') promptTokens = payload.usage.prompt_tokens;
    if (typeof payload.usage.completion_tokens === 'number') {
      completionTokens = payload.usage.completion_tokens;
    }
  }

  return {
    content,
    toolCalls,
    reasoning,
    usage: { promptTokens, completionTokens },
  };
}

export class Brain {
  private readonly pool: EndpointPool;
  private readonly timeoutMs: number | (() => number);
  private readonly onUsage: ((event: BrainUsageEvent) => void) | undefined;

  constructor(pool: EndpointPool, opts: BrainOptions) {
    this.pool = pool;
    this.timeoutMs = opts.timeoutMs;
    this.onUsage = opts.onUsage;
  }

  /** 当前请求超时：按次读取，配置热改后下一次调用即生效。 */
  private currentTimeoutMs(): number {
    return typeof this.timeoutMs === 'function' ? this.timeoutMs() : this.timeoutMs;
  }

  /** 健康快照：委托给本 brain 绑定的端点池（网页 `/api/state` 使用）。 */
  snapshot(): EndpointSnapshot[] {
    return this.pool.snapshot();
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<BrainResponse> {
    const tier = opts.tier ?? 'flash';
    const failures: string[] = [];
    const attempted = new Set<string>();

    // Exactly one pass over the pool. Attempted names are excluded from subsequent
    // picks because a slow attempt (up to timeoutMs) can outlive the 5s backoff
    // window, which would otherwise make a failed endpoint eligible for a second try
    // before later endpoints have been tried.
    for (;;) {
      let endpoint: EndpointConfig;
      try {
        endpoint = this.pool.pick(tier, attempted);
      } catch (error) {
        if (failures.length === 0) throw error;
        throw new AllEndpointsDownError(
          `all endpoints are degraded after failover: ${failures.join(', ')}`,
        );
      }

      attempted.add(endpoint.name);

      const model = tier === 'pro' ? endpoint.proModel : endpoint.flashModel;

      let response: Response;
      try {
        response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${endpoint.apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages,
            ...(opts.tools === undefined ? {} : { tools: opts.tools }),
          }),
          signal: AbortSignal.timeout(this.currentTimeoutMs()),
        });
      } catch (error) {
        const endpointError = classifyFetchError(error);
        this.pool.reportFailure(endpoint.name, endpointError);
        failures.push(describeFailure(endpoint.name, endpointError));
        continue;
      }

      if (!response.ok) {
        const endpointError = classifyHttpError(
          response.status,
          await readBoundedErrorBody(response),
        );
        this.pool.reportFailure(endpoint.name, endpointError);
        failures.push(describeFailure(endpoint.name, endpointError));
        continue;
      }

      let payload: unknown;
      let readError: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        payload = undefined;
        readError = error;
      }

      const parsed = parseCompletion(payload);
      if (parsed === null) {
        const readName = errorName(readError);
        const endpointError: EndpointError =
          readName === 'TimeoutError' || readName === 'AbortError'
            ? { kind: 'timeout' }
            : { kind: 'http', status: response.status };
        this.pool.reportFailure(endpoint.name, endpointError);
        failures.push(describeFailure(endpoint.name, endpointError));
        continue;
      }

      this.pool.reportSuccess(endpoint.name);
      try {
        this.onUsage?.({ endpoint: endpoint.name, model, usage: parsed.usage });
      } catch {
        // The ledger must never discard a successful response.
      }

      return { ...parsed, endpoint: endpoint.name, model };
    }
  }
}
