/**
 * Schema for `config/models.json` — the user-editable model endpoint configuration.
 *
 * Validation is explicit and fail-closed: every field is type/length/enum checked,
 * unknown keys are rejected, URLs must be https (or http on a loopback literal), and
 * the result is always a brand-new object so a crafted `__proto__`/`constructor` key
 * can never reach the prototype chain.
 */
import type { EndpointTier } from '../config.js';

export type ModelsEndpoint = {
  name: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  tier: EndpointTier;
  flashModel: string;
  proModel: string;
};

export type ModelsService = {
  baseUrl: string;
  path: string;
  model: string;
  apiKey: string;
  enabled: boolean;
  /** Embedding only. `null` means "provider default". */
  maxDims?: number | null;
  /** TTS only. */
  voice?: string;
  /** TTS only. */
  format?: string;
  /** STT only. */
  language?: string;
};

export type ModelsConfig = {
  version: 1;
  importedFromEnv: boolean;
  endpoints: ModelsEndpoint[];
  embedding?: ModelsService;
  rerank?: ModelsService;
  tts?: ModelsService;
  stt?: ModelsService;
};

export type ModelsServiceName = 'embedding' | 'rerank' | 'tts' | 'stt';

export const MODELS_SERVICE_NAMES: readonly ModelsServiceName[] = [
  'embedding',
  'rerank',
  'tts',
  'stt',
] as const;

export type ParseModelsConfigResult =
  | { ok: true; value: ModelsConfig }
  | { ok: false; code: string; field?: string };

type Failure = { ok: false; code: string; field?: string };
type Parsed<T> = { ok: true; value: T } | Failure;

const TOP_LEVEL_KEYS = new Set([
  'version',
  'importedFromEnv',
  'endpoints',
  'embedding',
  'rerank',
  'tts',
  'stt',
]);

/** Read-only fields the web UI echoes back from GET; accepted and dropped. */
const READ_ONLY_KEYS = new Set(['hasApiKey', 'keyLast4']);

const ENDPOINT_KEYS = new Set([
  'name',
  'provider',
  'baseUrl',
  'apiKey',
  'enabled',
  'tier',
  'flashModel',
  'proModel',
  ...READ_ONLY_KEYS,
]);

const SERVICE_KEYS: Record<ModelsServiceName, ReadonlySet<string>> = {
  embedding: new Set([
    'baseUrl',
    'path',
    'model',
    'apiKey',
    'enabled',
    'maxDims',
    ...READ_ONLY_KEYS,
  ]),
  rerank: new Set(['baseUrl', 'path', 'model', 'apiKey', 'enabled', ...READ_ONLY_KEYS]),
  tts: new Set([
    'baseUrl',
    'path',
    'model',
    'apiKey',
    'enabled',
    'voice',
    'format',
    ...READ_ONLY_KEYS,
  ]),
  stt: new Set([
    'baseUrl',
    'path',
    'model',
    'apiKey',
    'enabled',
    'language',
    ...READ_ONLY_KEYS,
  ]),
};

const SERVICE_DEFAULT_PATHS: Record<ModelsServiceName, string> = {
  embedding: '/embeddings',
  rerank: '/reranking',
  tts: '/audio/speech',
  stt: '/audio/transcriptions',
};

const TIERS: ReadonlySet<string> = new Set(['flash', 'pro', 'both']);

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const MAX_NAME_CHARS = 64;
const MAX_PROVIDER_CHARS = 64;
const MAX_URL_CHARS = 2_048;
const MAX_KEY_CHARS = 4_096;
const MAX_MODEL_CHARS = 200;
const MAX_PATH_CHARS = 256;
const MAX_OPTION_CHARS = 64;
const MAX_ENDPOINTS = 64;
const MAX_DIMS = 65_536;

/** Markers that identify a value as a masked placeholder rather than a real key. */
export function isMaskedKey(key: string): boolean {
  return key.includes('…') || key.includes('•') || key.includes('***');
}

/**
 * Public shape of a stored key. Never returns the key itself; `keyLast4` is only
 * exposed for keys long enough that four characters reveal nothing useful.
 */
export function maskKey(key: string): { hasApiKey: boolean; keyLast4?: string } {
  if (key.length === 0) return { hasApiKey: false };
  const masked: { hasApiKey: boolean; keyLast4?: string } = { hasApiKey: true };
  if (key.length >= 12) masked.keyLast4 = key.slice(-4);
  return masked;
}

function fail(code: string, field?: string): Failure {
  return field === undefined ? { ok: false, code } : { ok: false, code, field };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Rejects prototype-pollution keys before any field is read. */
function findUnsafeKey(value: Record<string, unknown>): string | null {
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return key;
  }
  return null;
}

function findUnknownKey(value: Record<string, unknown>, allowed: ReadonlySet<string>): string | null {
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!allowed.has(key)) return key;
  }
  return null;
}

function readString(
  value: unknown,
  field: string,
  minLength: number,
  maxLength: number,
): Parsed<string> {
  if (typeof value !== 'string') return fail('invalid_field', field);
  if (value.length < minLength || value.length > maxLength) return fail('invalid_field', field);
  if (CONTROL_CHARS.test(value)) return fail('invalid_field', field);
  return { ok: true, value };
}

function readOptionalString(
  value: unknown,
  field: string,
  minLength: number,
  maxLength: number,
): Parsed<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  return readString(value, field, minLength, maxLength);
}

function readBoolean(value: unknown, field: string, fallback: boolean): Parsed<boolean> {
  if (value === undefined) return { ok: true, value: fallback };
  if (typeof value !== 'boolean') return fail('invalid_field', field);
  return { ok: true, value };
}

function parseBaseUrl(value: unknown, field: string): Parsed<string> {
  const text = readString(value, field, 1, MAX_URL_CHARS);
  if (!text.ok) return text;

  let url: URL;
  try {
    url = new URL(text.value);
  } catch {
    return fail('invalid_field', field);
  }

  if (url.username !== '' || url.password !== '') return fail('invalid_field', field);
  // Query strings and fragments are not part of the endpoint base URL; keeping them
  // would silently corrupt every request built by appending a path.
  if (url.search !== '' || url.hash !== '') return fail('invalid_field', field);

  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    return fail('invalid_field', field);
  }

  // Store the normalized form: trims stray whitespace, lowercases the host and
  // guarantees the value used at request time is the value that was validated.
  // `URL.toString()` appends a bare "/" when there is no path; drop any single
  // trailing slash so callers that join `baseUrl + "/chat/completions"` do not
  // produce a double slash (pathless and pathed URLs alike).
  const normalized = url.toString();
  const stored = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  return { ok: true, value: stored };
}

function isLoopbackUrl(value: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

function parseEndpoint(value: unknown, index: number): Parsed<ModelsEndpoint> {
  const field = `endpoints[${index}]`;
  if (!isPlainObject(value)) return fail('invalid_field', field);

  const unsafe = findUnsafeKey(value);
  if (unsafe !== null) return fail('invalid_field', `${field}.${unsafe}`);

  const unknown = findUnknownKey(value, ENDPOINT_KEYS);
  if (unknown !== null) return fail('invalid_field', `${field}.${unknown}`);

  const name = readString(value.name, `${field}.name`, 1, MAX_NAME_CHARS);
  if (!name.ok) return name;
  if (name.value !== name.value.trim()) return fail('invalid_field', `${field}.name`);

  const provider =
    value.provider === undefined
      ? ({ ok: true, value: 'unknown' } as const)
      : readString(value.provider, `${field}.provider`, 1, MAX_PROVIDER_CHARS);
  if (!provider.ok) return provider;

  const baseUrl = parseBaseUrl(value.baseUrl, `${field}.baseUrl`);
  if (!baseUrl.ok) return baseUrl;

  const apiKey =
    value.apiKey === undefined
      ? ({ ok: true, value: '' } as const)
      : readString(value.apiKey, `${field}.apiKey`, 0, MAX_KEY_CHARS);
  if (!apiKey.ok) return apiKey;

  // A remote endpoint without a key can never authenticate; only loopback
  // (local model servers) may omit one.
  if (apiKey.value === '' && !isLoopbackUrl(baseUrl.value)) {
    return fail('invalid_field', `${field}.apiKey`);
  }

  const enabled = readBoolean(value.enabled, `${field}.enabled`, true);
  if (!enabled.ok) return enabled;

  let tier: EndpointTier = 'both';
  if (value.tier !== undefined) {
    if (typeof value.tier !== 'string' || !TIERS.has(value.tier)) {
      return fail('invalid_field', `${field}.tier`);
    }
    tier = value.tier as EndpointTier;
  }

  const flashModel = readString(value.flashModel, `${field}.flashModel`, 1, MAX_MODEL_CHARS);
  if (!flashModel.ok) return flashModel;

  const proModel =
    value.proModel === undefined
      ? ({ ok: true, value: flashModel.value } as const)
      : readString(value.proModel, `${field}.proModel`, 1, MAX_MODEL_CHARS);
  if (!proModel.ok) return proModel;

  return {
    ok: true,
    value: {
      name: name.value,
      provider: provider.value,
      baseUrl: baseUrl.value,
      apiKey: apiKey.value,
      enabled: enabled.value,
      tier,
      flashModel: flashModel.value,
      proModel: proModel.value,
    },
  };
}

function parseService(
  value: unknown,
  service: ModelsServiceName,
): Parsed<ModelsService> {
  const field = service;
  if (!isPlainObject(value)) return fail('invalid_field', field);

  const unsafe = findUnsafeKey(value);
  if (unsafe !== null) return fail('invalid_field', `${field}.${unsafe}`);

  const unknown = findUnknownKey(value, SERVICE_KEYS[service]);
  if (unknown !== null) return fail('invalid_field', `${field}.${unknown}`);

  const baseUrl = parseBaseUrl(value.baseUrl, `${field}.baseUrl`);
  if (!baseUrl.ok) return baseUrl;

  const pathField = `${field}.path`;
  const pathValue =
    value.path === undefined
      ? ({ ok: true, value: SERVICE_DEFAULT_PATHS[service] } as const)
      : readString(value.path, pathField, 1, MAX_PATH_CHARS);
  if (!pathValue.ok) return pathValue;
  if (!pathValue.value.startsWith('/') || pathValue.value.includes('..')) {
    return fail('invalid_field', pathField);
  }

  const model = readString(value.model, `${field}.model`, 1, MAX_MODEL_CHARS);
  if (!model.ok) return model;

  const apiKey =
    value.apiKey === undefined
      ? ({ ok: true, value: '' } as const)
      : readString(value.apiKey, `${field}.apiKey`, 0, MAX_KEY_CHARS);
  if (!apiKey.ok) return apiKey;

  const enabled = readBoolean(value.enabled, `${field}.enabled`, false);
  if (!enabled.ok) return enabled;

  const result: ModelsService = {
    baseUrl: baseUrl.value,
    path: pathValue.value,
    model: model.value,
    apiKey: apiKey.value,
    enabled: enabled.value,
  };

  if (service === 'embedding') {
    if (value.maxDims === null) {
      result.maxDims = null;
    } else if (value.maxDims !== undefined) {
      if (
        typeof value.maxDims !== 'number' ||
        !Number.isInteger(value.maxDims) ||
        value.maxDims < 1 ||
        value.maxDims > MAX_DIMS
      ) {
        return fail('invalid_field', `${field}.maxDims`);
      }
      result.maxDims = value.maxDims;
    }
  }

  if (service === 'tts') {
    const voice = readOptionalString(value.voice, `${field}.voice`, 0, MAX_OPTION_CHARS);
    if (!voice.ok) return voice;
    if (voice.value !== undefined) result.voice = voice.value;

    const format = readOptionalString(value.format, `${field}.format`, 0, MAX_OPTION_CHARS);
    if (!format.ok) return format;
    if (format.value !== undefined) result.format = format.value;
  }

  if (service === 'stt') {
    const language = readOptionalString(value.language, `${field}.language`, 0, MAX_OPTION_CHARS);
    if (!language.ok) return language;
    if (language.value !== undefined) result.language = language.value;
  }

  return { ok: true, value: result };
}

/**
 * Validates a candidate `models.json` value. Returns a fresh `ModelsConfig` on
 * success; failures carry a stable machine code and, when meaningful, the field path.
 */
export function parseModelsConfig(value: unknown): ParseModelsConfigResult {
  if (!isPlainObject(value)) return fail('invalid_config');

  const unsafe = findUnsafeKey(value);
  if (unsafe !== null) return fail('invalid_field', unsafe);

  const unknown = findUnknownKey(value, TOP_LEVEL_KEYS);
  if (unknown !== null) return fail('invalid_field', unknown);

  if (value.version !== 1) return fail('unsupported_version', 'version');

  let importedFromEnv = false;
  if (value.importedFromEnv !== undefined) {
    if (typeof value.importedFromEnv !== 'boolean') {
      return fail('invalid_field', 'importedFromEnv');
    }
    importedFromEnv = value.importedFromEnv;
  }

  if (!Array.isArray(value.endpoints)) return fail('invalid_field', 'endpoints');
  if (value.endpoints.length === 0) return fail('invalid_field', 'endpoints');
  if (value.endpoints.length > MAX_ENDPOINTS) return fail('invalid_field', 'endpoints');

  const endpoints: ModelsEndpoint[] = [];
  const names = new Set<string>();
  for (let index = 0; index < value.endpoints.length; index += 1) {
    const parsed = parseEndpoint(value.endpoints[index], index);
    if (!parsed.ok) return parsed;
    if (names.has(parsed.value.name)) {
      return fail('invalid_field', `endpoints[${index}].name`);
    }
    names.add(parsed.value.name);
    endpoints.push(parsed.value);
  }

  // A config with no enabled endpoint can never serve chat; reject it up front
  // instead of failing every request at runtime.
  if (!endpoints.some((entry) => entry.enabled)) {
    return fail('invalid_field', 'endpoints');
  }

  const config: ModelsConfig = { version: 1, importedFromEnv, endpoints };

  for (const service of MODELS_SERVICE_NAMES) {
    const raw = value[service];
    if (raw === undefined) continue;
    const parsed = parseService(raw, service);
    if (!parsed.ok) return parsed;
    config[service] = parsed.value;
  }

  return { ok: true, value: config };
}
