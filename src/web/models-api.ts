/**
 * 模型配置 API：`GET /api/state`、`PUT /api/models`、`POST /api/models/test`。
 *
 * 安全不变量（见设计「安全不变量」第 4 条）：
 * - 状态接口只回 `getMasked()`，密钥永不进入响应；
 * - 保存走 `ConfigStore.save`（干跑 → 原子写 → 热切换），失败只回稳定错误码；
 * - 探测用临时 `EndpointPool`，绝不触碰 live 池的健康状态，也绝不回显上游 body。
 */
import { EndpointPool, classifyHttpError } from '../brain/endpoints.js';
import { classifyFetchError } from '../brain/brain.js';
import type { EndpointConfig } from '../config.js';
import type { ModelsConfig, ModelsService } from '../config/models-schema.js';
import type { ConfigStore } from '../config/store.js';
import { readBoundedErrorBody } from '../util/error-body.js';
import type { RouteHandler } from './server.js';

/** 探测超时上限：10 秒；测试可注入更短的值。 */
const DEFAULT_TEST_TIMEOUT_MS = 10_000;

export const MODEL_TEST_TIERS = ['flash', 'pro', 'embedding', 'rerank', 'tts', 'stt'] as const;
export type ModelTestTier = (typeof MODEL_TEST_TIERS)[number];

/** 出站 fetch 的最小接口；测试注入替身，生产用全局 fetch。 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ModelsApiDeps {
  store: ConfigStore;
  /** 当前 live 池的健康快照。 */
  endpoints: () => unknown;
  silentRounds: () => number;
  nextFastMs: () => number;
  inFlight: () => boolean;
  queueSize: () => number;
  plugins: () => unknown;
  capabilities: () => unknown;
  channels: () => unknown;
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
}

export interface ModelsApi {
  state: () => unknown;
  handlers: {
    models: RouteHandler;
    modelsTest: RouteHandler;
  };
}

type ProbeRequest = {
  url: string;
  init: RequestInit;
  endpoint: string;
  model: string;
};

type ProbeResult = {
  ok: boolean;
  latencyMs: number;
  endpoint: string;
  model: string;
  errorKind?: string;
  status?: number;
  code?: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isModelTestTier(value: string): value is ModelTestTier {
  return (MODEL_TEST_TIERS as readonly string[]).includes(value);
}

function authHeaders(apiKey: string): Record<string, string> {
  return apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` };
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 已消费或已关闭。
  }
}

/** 44 字节的空 WAV 头：STT 端点要求 multipart 文件，但不做真实转写。 */
function silentWav(): Uint8Array {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8_000, 24);
  header.writeUInt32LE(8_000, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(0, 40);
  return new Uint8Array(header);
}

function chatRequest(endpoint: EndpointConfig, tier: 'flash' | 'pro'): ProbeRequest {
  const model = tier === 'pro' ? endpoint.proModel : endpoint.flashModel;
  return {
    url: `${endpoint.baseUrl}/chat/completions`,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(endpoint.apiKey),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
      redirect: 'error',
    },
    endpoint: endpoint.name,
    model,
  };
}

function serviceRequest(
  service: ModelsService,
  tier: Exclude<ModelTestTier, 'flash' | 'pro'>,
): ProbeRequest {
  const url = `${service.baseUrl}${service.path}`;

  if (tier === 'stt') {
    const form = new FormData();
    form.set('model', service.model);
    if (service.language !== undefined && service.language !== '') {
      form.set('language', service.language);
    }
    form.set('file', new Blob([silentWav()], { type: 'audio/wav' }), 'test.wav');
    return {
      url,
      init: {
        method: 'POST',
        headers: authHeaders(service.apiKey),
        body: form,
        redirect: 'error',
      },
      endpoint: tier,
      model: service.model,
    };
  }

  let payload: Record<string, unknown>;
  if (tier === 'embedding') {
    payload = { model: service.model, input: 'ping' };
  } else if (tier === 'rerank') {
    payload = { model: service.model, query: 'ping', documents: ['ping'], top_n: 1 };
  } else {
    payload = { model: service.model, input: 'ping' };
    if (service.voice !== undefined && service.voice !== '') payload['voice'] = service.voice;
    if (service.format !== undefined && service.format !== '') {
      payload['response_format'] = service.format;
    }
  }

  return {
    url,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(service.apiKey),
      },
      body: JSON.stringify(payload),
      redirect: 'error',
    },
    endpoint: tier,
    model: service.model,
  };
}

/**
 * 执行一次探测。失败只返回分类（`errorKind`/`status`），不返回上游文本；
 * 探测池是临时对象，因此这里的任何失败都不会写回 live 端点健康状态。
 */
async function runProbe(
  request: ProbeRequest,
  opts: { fetch: FetchLike; now: () => number; timeoutMs: number },
): Promise<ProbeResult> {
  const started = opts.now();
  let response: Response;
  try {
    response = await opts.fetch(request.url, {
      ...request.init,
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (error) {
    const classified = classifyFetchError(error);
    return {
      ok: false,
      latencyMs: opts.now() - started,
      endpoint: request.endpoint,
      model: request.model,
      errorKind: classified.kind,
    };
  }

  const latencyMs = opts.now() - started;

  if (!response.ok) {
    const bodyText = await readBoundedErrorBody(response);
    // 401/403 是凭据/权限问题，修复方式与余额耗尽完全不同：探测层单独报 `auth`。
    const errorKind =
      response.status === 401 || response.status === 403
        ? 'auth'
        : classifyHttpError(response.status, bodyText).kind;
    return {
      ok: false,
      latencyMs,
      endpoint: request.endpoint,
      model: request.model,
      errorKind,
      status: response.status,
    };
  }

  await discardBody(response);
  return { ok: true, latencyMs, endpoint: request.endpoint, model: request.model };
}

function serviceOf(
  config: ModelsConfig,
  tier: Exclude<ModelTestTier, 'flash' | 'pro'>,
): ModelsService | undefined {
  return config[tier];
}

export function createModelsApi(deps: ModelsApiDeps): ModelsApi {
  const fetchImpl: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;

  const state = (): unknown => ({
    endpoints: deps.endpoints(),
    silentRounds: deps.silentRounds(),
    nextFastMs: deps.nextFastMs(),
    inFlight: deps.inFlight(),
    queueSize: deps.queueSize(),
    plugins: deps.plugins(),
    capabilities: deps.capabilities(),
    models: deps.store.getMasked(),
    channels: deps.channels(),
  });

  const save: RouteHandler = async (ctx) => {
    const result = await deps.store.save(ctx.body);
    if (result.ok) {
      ctx.send(200, { ok: true });
      return;
    }
    // 写失败不是客户端输入问题，但仍用 400：这是「配置未生效」的稳定失败码，
    // 与 4xx 语义一致（重试前必须先修环境），且设计只定义了 400/401/403/413。
    ctx.send(400, {
      ok: false,
      code: result.code,
      ...(result.field === undefined ? {} : { field: result.field }),
    });
  };

  /**
   * 服务档（embedding/rerank/tts/stt）的探测只需要该档位自己的段：前端只发
   * 这一段，后端用已保存配置补齐 endpoints 等必填项，避免表单里一个空端点行
   * 让测试按钮全部变成 `invalid_field: endpoints`。
   */
  const draftForTier = (tier: ModelTestTier, draft: unknown): unknown => {
    if (tier === 'flash' || tier === 'pro') return draft;
    if (!isPlainObject(draft) || Array.isArray(draft['endpoints'])) return draft;
    const stored = deps.store.get();
    if (stored === null) return draft;
    return { ...stored, [tier]: draft[tier] };
  };

  const test: RouteHandler = async (ctx) => {
    const body = ctx.body;
    if (!isPlainObject(body)) {
      ctx.send(400, { ok: false, code: 'invalid_body' });
      return;
    }

    const tier = body.tier;
    if (typeof tier !== 'string' || !isModelTestTier(tier)) {
      ctx.send(400, { ok: false, code: 'invalid_tier', field: 'tier' });
      return;
    }

    // 缺省 draft 时探测当前已保存配置；draft 存在时按三态密钥契约与已保存配置合并。
    const draft = body.draft === undefined ? deps.store.get() : body.draft;
    const candidate = draftForTier(tier, draft);
    if (candidate === null) {
      ctx.send(200, { ok: false, code: 'not_configured' });
      return;
    }

    const preview = deps.store.preview(candidate);
    if (!preview.ok) {
      ctx.send(400, {
        ok: false,
        code: preview.code,
        ...(preview.field === undefined ? {} : { field: preview.field }),
      });
      return;
    }

    let request: ProbeRequest;
    if (tier === 'flash' || tier === 'pro') {
      // 临时池：绝不调用 live 池的 reportFailure/reportSuccess。
      const pool = new EndpointPool(preview.config.endpoints);
      let endpoint: EndpointConfig;
      try {
        endpoint = pool.pick(tier);
      } catch {
        ctx.send(200, { ok: false, code: 'no_endpoint' });
        return;
      }
      request = chatRequest(endpoint, tier);
    } else {
      const service = serviceOf(preview.config, tier);
      if (service === undefined) {
        ctx.send(200, { ok: false, code: 'not_configured' });
        return;
      }
      request = serviceRequest(service, tier);
    }

    ctx.send(200, await runProbe(request, { fetch: fetchImpl, now, timeoutMs }));
  };

  return { state, handlers: { models: save, modelsTest: test } };
}
