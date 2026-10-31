import { DEFAULT_REFUSAL_FALLBACK_TEXT } from './persona/refusal.js';

/** Which request tier an endpoint may serve. */
export type EndpointTier = 'flash' | 'pro' | 'both';
/** A concrete request tier; `both` only describes endpoints, never requests. */
export type RequestTier = Exclude<EndpointTier, 'both'>;

export interface EndpointConfig {
  name: string;
  /** Provider family label, e.g. `nvidia_nim` or `agnes` (used by the web console). */
  provider?: string;
  baseUrl: string;
  apiKey: string;
  flashModel: string;
  proModel: string;
  enabled: boolean;
  /** Which request tier this endpoint may serve. Missing means `both`. */
  tier?: EndpointTier;
}

export interface Config {
  endpoints: EndpointConfig[];
  tickFastMs: number;
  tickSlowMs: number;
  wakeDebounceMs: number;
  httpTimeoutMs: number;
  /** 单 tick 最多处理的会话数（D1）。 */
  maxConversationsPerTick: number;
  /** 单会话单 tick 最多处理的事件数（D1）。 */
  maxEventsPerConversation: number;
  /** 感知队列上限（D8）。 */
  maxQueueSize: number;
  /**
   * 红线拒绝改写失败时的兜底话术（`REDLINE_FALLBACK_TEXT`）。
   * 空白/缺失 → 内置默认值；循环仍会让它过一遍红线闸。
   */
  redlineFallbackText?: string;
}

const NIM_BASE_URL = 'https://integrate.api.nvidia.com/v1';

function readInt(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`invalid ${key}: "${raw}" is not a non-negative integer`);
  }
  return value;
}

function readPositiveInt(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`invalid ${key}: "${raw}" is not a positive integer`);
  }
  return value;
}

function readString(
  env: Record<string, string | undefined>,
  key: string,
  fallback: string,
): string {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim();
}

export interface LoadConfigOptions {
  /**
   * 端点是否必须来自 `.env`。网页管理台上端点改由 `config/models.json` 提供，
   * 启动时用 `false` 只取非端点设置；默认 `true` 保持既有行为。
   */
  requireEndpoints?: boolean;
}

export function loadConfig(
  env: Record<string, string | undefined>,
  opts: LoadConfigOptions = {},
): Config {
  const endpoints: EndpointConfig[] = [];

  const nimKeysRaw = env.NIM_API_KEYS ?? '';
  const nimKeys = nimKeysRaw
    .split(',')
    .map(k => k.trim())
    .filter(k => k !== '');

  const nimFlashModel = readString(env, 'NIM_FLASH_MODEL', 'deepseek-ai/deepseek-v4.1-flash');
  const nimProModel = readString(env, 'NIM_PRO_MODEL', nimFlashModel);

  nimKeys.forEach((apiKey, i) => {
    endpoints.push({
      name: `nim-${i + 1}`,
      provider: 'nvidia_nim',
      baseUrl: NIM_BASE_URL,
      apiKey,
      flashModel: nimFlashModel,
      proModel: nimProModel,
      enabled: true,
      tier: 'both',
    });
  });

  const agnesComKey = env.AGNES_COM_API_KEY?.trim() ?? '';
  const agnesCnKey = env.AGNES_CN_API_KEY?.trim() ?? '';

  const agnesFlashModel = readString(env, 'AGNES_FLASH_MODEL', 'agnes-3.0-flash');
  const agnesProModel = readString(env, 'AGNES_PRO_MODEL', 'agnes-2.5-pro');

  if (agnesComKey !== '') {
    endpoints.push({
      name: 'agnes_com',
      provider: 'agnes',
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      apiKey: agnesComKey,
      flashModel: agnesFlashModel,
      proModel: agnesProModel,
      enabled: true,
      tier: 'both',
    });
  }

  if (agnesCnKey !== '') {
    endpoints.push({
      name: 'agnes_cn',
      provider: 'agnes',
      baseUrl: 'https://api.agnes-ai.cn/v1',
      apiKey: agnesCnKey,
      flashModel: agnesFlashModel,
      proModel: agnesProModel,
      enabled: true,
      tier: 'both',
    });
  }

  if (endpoints.length === 0 && opts.requireEndpoints !== false) {
    throw new Error(
      'no endpoint keys found: set at least one endpoint key (NIM_API_KEYS / AGNES_COM_API_KEY / AGNES_CN_API_KEY) in .env',
    );
  }

  return {
    endpoints,
    tickFastMs: readInt(env, 'TICK_FAST_MS', 300000),
    tickSlowMs: readInt(env, 'TICK_SLOW_MS', 3600000),
    wakeDebounceMs: readInt(env, 'WAKE_DEBOUNCE_MS', 3000),
    httpTimeoutMs: readInt(env, 'HTTP_TIMEOUT_MS', 120000),
    maxConversationsPerTick: readPositiveInt(env, 'MAX_CONVERSATIONS_PER_TICK', 3),
    maxEventsPerConversation: readPositiveInt(env, 'MAX_EVENTS_PER_CONVERSATION', 20),
    maxQueueSize: readPositiveInt(env, 'MAX_QUEUE_SIZE', 500),
    redlineFallbackText: readString(
      env,
      'REDLINE_FALLBACK_TEXT',
      DEFAULT_REFUSAL_FALLBACK_TEXT,
    ),
  };
}
