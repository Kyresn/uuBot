/**
 * Schema for `config/harness.json` — 运行期可热改的全部参数（心跳、HTTP、红线、
 * QQ 通道、能力插件开关）。
 *
 * 校验方式与 `models.json` 完全一致：显式 schema、未知键拒绝、`version > 1`
 * 拒绝、数值区间显式检查，结果永远是全新对象，构造过的 `__proto__` /
 * `constructor` 键无法进入原型链。
 *
 * `wsToken` 沿用三态契约：GET 只回 `hasWsToken` / `wsTokenLast4`；把打码占位符
 * 当值提交一律 `invalid_field`；缺省保持、`null` 清除、字符串替换（三态解析在
 * `HarnessStore` 里完成，因为只有它知道当前存储的 token）。
 */
import { DEFAULT_REFUSAL_FALLBACK_TEXT } from '../persona/refusal.js';
import { isMaskedKey } from './models-schema.js';

export type HarnessTickConfig = {
  fastMs: number;
  slowMs: number;
  wakeDebounceMs: number;
};

export type HarnessHttpConfig = {
  timeoutMs: number;
};

export type HarnessRedlineConfig = {
  fallbackText: string;
};

export type HarnessProactiveConfig = {
  enabled: boolean;
  minGapMs: number;
  dailyMax: number;
  quietStart: string;
  quietEnd: string;
  intervalMs: number;
};

export type HarnessQqConfig = {
  enabled: boolean;
  wsToken: string;
  wsHost: string;
  wsPort: number;
  ownerId: string;
  selfId: string;
  controlEnabled: boolean;
  controlNl: boolean;
  nlMinConfidence: number;
  minReplyGapMs: number;
  groupAllowlist: string[];
  groupDenylist: string[];
  privateAllowlist: string[];
  privateDenylist: string[];
  privateOpen: boolean;
  proactive: HarnessProactiveConfig;
};

export type HarnessCapabilityConfig = {
  autoActivate: boolean;
};

export type HarnessConfig = {
  version: 1;
  importedFromEnv: boolean;
  tick: HarnessTickConfig;
  http: HarnessHttpConfig;
  redline: HarnessRedlineConfig;
  qq: HarnessQqConfig;
  capability: HarnessCapabilityConfig;
};

export type ParseHarnessConfigResult =
  | { ok: true; value: HarnessConfig }
  | { ok: false; code: string; field?: string };

type Failure = { ok: false; code: string; field?: string };
type Parsed<T> = { ok: true; value: T } | Failure;

const TOP_LEVEL_KEYS = new Set([
  'version',
  'importedFromEnv',
  'tick',
  'http',
  'redline',
  'qq',
  'capability',
]);

const TICK_KEYS = new Set(['fastMs', 'slowMs', 'wakeDebounceMs']);
const HTTP_KEYS = new Set(['timeoutMs']);
const REDLINE_KEYS = new Set(['fallbackText']);
const CAPABILITY_KEYS = new Set(['autoActivate']);

/** GET 回显的只读掩码字段：接受但丢弃，保证 GET → PUT 往返不丢 token。 */
const READ_ONLY_QQ_KEYS = new Set(['hasWsToken', 'wsTokenLast4']);

const QQ_KEYS = new Set([
  'enabled',
  'wsToken',
  'wsHost',
  'wsPort',
  'ownerId',
  'selfId',
  'controlEnabled',
  'controlNl',
  'nlMinConfidence',
  'minReplyGapMs',
  'groupAllowlist',
  'groupDenylist',
  'privateAllowlist',
  'privateDenylist',
  'privateOpen',
  'proactive',
  ...READ_ONLY_QQ_KEYS,
]);

const PROACTIVE_KEYS = new Set([
  'enabled',
  'minGapMs',
  'dailyMax',
  'quietStart',
  'quietEnd',
  'intervalMs',
]);

const FAST_MS_MIN = 1_000;
const FAST_MS_MAX = 3_600_000;
const SLOW_MS_MAX = 86_400_000;
const WAKE_DEBOUNCE_MS_MAX = 600_000;
const HTTP_TIMEOUT_MS_MIN = 1_000;
const HTTP_TIMEOUT_MS_MAX = 600_000;
const MIN_REPLY_GAP_MS_MAX = 86_400_000;
const DAILY_MAX = 100;
const PROACTIVE_MIN_GAP_MS_MAX = 86_400_000;
const PROACTIVE_INTERVAL_MS_MAX = 86_400_000;
const PORT_MAX = 65_535;

const MAX_HOST_CHARS = 255;
const MAX_TOKEN_CHARS = 4_096;
const MAX_FALLBACK_CHARS = 2_000;
const MAX_LIST_ENTRY_CHARS = 64;
const MAX_LIST_ITEMS = 256;
const MAX_QQ_ID_CHARS = 20;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DECIMAL = /^\d+$/;

/** 与 `models.json` 的默认值保持同一口径；`importFromEnv` 会逐项覆盖。 */
function defaultHarnessConfig(): HarnessConfig {
  return {
    version: 1,
    importedFromEnv: false,
    // 与 `loadConfig` 的历史默认值一致：裸安装（无文件、无 env）行为不变。
    tick: { fastMs: 300_000, slowMs: 3_600_000, wakeDebounceMs: 3_000 },
    http: { timeoutMs: 120_000 },
    redline: { fallbackText: DEFAULT_REFUSAL_FALLBACK_TEXT },
    qq: {
      enabled: false,
      wsToken: '',
      wsHost: '127.0.0.1',
      wsPort: 3_001,
      ownerId: '',
      selfId: '',
      controlEnabled: true,
      controlNl: true,
      nlMinConfidence: 0.75,
      minReplyGapMs: 90_000,
      groupAllowlist: [],
      groupDenylist: [],
      privateAllowlist: [],
      privateDenylist: [],
      privateOpen: false,
      proactive: {
        enabled: false,
        minGapMs: 21_600_000,
        dailyMax: 2,
        quietStart: '23:00',
        quietEnd: '08:00',
        intervalMs: 1_800_000,
      },
    },
    capability: { autoActivate: false },
  };
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

function findUnknownKey(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): string | null {
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

function readBoolean(value: unknown, field: string, fallback: boolean): Parsed<boolean> {
  if (value === undefined) return { ok: true, value: fallback };
  if (typeof value !== 'boolean') return fail('invalid_field', field);
  return { ok: true, value };
}

function readIntInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
): Parsed<number> {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    return fail('invalid_field', field);
  }
  return { ok: true, value };
}

function readNumberInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
): Parsed<number> {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    return fail('invalid_field', field);
  }
  return { ok: true, value };
}

function readClock(value: unknown, field: string): Parsed<string> {
  if (typeof value !== 'string' || !CLOCK.test(value)) return fail('invalid_field', field);
  return { ok: true, value };
}

/** 空串或 1..20 位十进制 QQ 号；超过 `MAX_SAFE_INTEGER` 的值在运行期无法精确比较。 */
function readQqId(value: unknown, field: string): Parsed<string> {
  if (value === '') return { ok: true, value: '' };
  if (typeof value !== 'string' || !DECIMAL.test(value) || value.length > MAX_QQ_ID_CHARS) {
    return fail('invalid_field', field);
  }
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) return fail('invalid_field', field);
  return { ok: true, value };
}

function readStringList(value: unknown, field: string): Parsed<string[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return fail('invalid_field', field);
  if (value.length > MAX_LIST_ITEMS) return fail('invalid_field', field);

  const list: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = readString(value[index], `${field}[${index}]`, 1, MAX_LIST_ENTRY_CHARS);
    if (!entry.ok) return entry;
    list.push(entry.value);
  }
  return { ok: true, value: list };
}

function parseTick(value: unknown, base: HarnessTickConfig): Parsed<HarnessTickConfig> {
  if (!isPlainObject(value)) return fail('invalid_field', 'tick');
  const unsafe = findUnsafeKey(value);
  if (unsafe !== null) return fail('invalid_field', `tick.${unsafe}`);
  const unknown = findUnknownKey(value, TICK_KEYS);
  if (unknown !== null) return fail('invalid_field', `tick.${unknown}`);

  const fastMs = readIntInRange(
    value.fastMs === undefined ? base.fastMs : value.fastMs,
    'tick.fastMs',
    FAST_MS_MIN,
    FAST_MS_MAX,
  );
  if (!fastMs.ok) return fastMs;

  const slowMs = readIntInRange(
    value.slowMs === undefined ? base.slowMs : value.slowMs,
    'tick.slowMs',
    FAST_MS_MIN + 1,
    SLOW_MS_MAX,
  );
  if (!slowMs.ok) return slowMs;

  const wakeDebounceMs = readIntInRange(
    value.wakeDebounceMs === undefined ? base.wakeDebounceMs : value.wakeDebounceMs,
    'tick.wakeDebounceMs',
    0,
    WAKE_DEBOUNCE_MS_MAX,
  );
  if (!wakeDebounceMs.ok) return wakeDebounceMs;

  // 快心跳必须严格快于慢心跳，否则慢档永远不会被选中。
  if (fastMs.value >= slowMs.value) return fail('invalid_field', 'tick.fastMs');

  return {
    ok: true,
    value: { fastMs: fastMs.value, slowMs: slowMs.value, wakeDebounceMs: wakeDebounceMs.value },
  };
}

function parseHttp(value: unknown, base: HarnessHttpConfig): Parsed<HarnessHttpConfig> {
  if (!isPlainObject(value)) return fail('invalid_field', 'http');
  const unsafe = findUnsafeKey(value);
  if (unsafe !== null) return fail('invalid_field', `http.${unsafe}`);
  const unknown = findUnknownKey(value, HTTP_KEYS);
  if (unknown !== null) return fail('invalid_field', `http.${unknown}`);

  const timeoutMs = readIntInRange(
    value.timeoutMs === undefined ? base.timeoutMs : value.timeoutMs,
    'http.timeoutMs',
    HTTP_TIMEOUT_MS_MIN,
    HTTP_TIMEOUT_MS_MAX,
  );
  if (!timeoutMs.ok) return timeoutMs;
  return { ok: true, value: { timeoutMs: timeoutMs.value } };
}

function parseRedline(
  value: unknown,
  base: HarnessRedlineConfig,
): Parsed<HarnessRedlineConfig> {
  if (!isPlainObject(value)) return fail('invalid_field', 'redline');
  const unsafe = findUnsafeKey(value);
  if (unsafe !== null) return fail('invalid_field', `redline.${unsafe}`);
  const unknown = findUnknownKey(value, REDLINE_KEYS);
  if (unknown !== null) return fail('invalid_field', `redline.${unknown}`);

  const fallbackText = readString(
    value.fallbackText === undefined ? base.fallbackText : value.fallbackText,
    'redline.fallbackText',
    1,
    MAX_FALLBACK_CHARS,
  );
  if (!fallbackText.ok) return fallbackText;
  return { ok: true, value: { fallbackText: fallbackText.value } };
}

function parseCapability(
  value: unknown,
  base: HarnessCapabilityConfig,
): Parsed<HarnessCapabilityConfig> {
  if (!isPlainObject(value)) return fail('invalid_field', 'capability');
  const unsafe = findUnsafeKey(value);
  if (unsafe !== null) return fail('invalid_field', `capability.${unsafe}`);
  const unknown = findUnknownKey(value, CAPABILITY_KEYS);
  if (unknown !== null) return fail('invalid_field', `capability.${unknown}`);

  const autoActivate = readBoolean(
    value.autoActivate,
    'capability.autoActivate',
    base.autoActivate,
  );
  if (!autoActivate.ok) return autoActivate;
  return { ok: true, value: { autoActivate: autoActivate.value } };
}

function parseProactive(
  value: unknown,
  base: HarnessProactiveConfig,
): Parsed<HarnessProactiveConfig> {
  if (!isPlainObject(value)) return fail('invalid_field', 'qq.proactive');
  const unsafe = findUnsafeKey(value);
  if (unsafe !== null) return fail('invalid_field', `qq.proactive.${unsafe}`);
  const unknown = findUnknownKey(value, PROACTIVE_KEYS);
  if (unknown !== null) return fail('invalid_field', `qq.proactive.${unknown}`);

  const enabled = readBoolean(value.enabled, 'qq.proactive.enabled', base.enabled);
  if (!enabled.ok) return enabled;

  const minGapMs = readIntInRange(
    value.minGapMs === undefined ? base.minGapMs : value.minGapMs,
    'qq.proactive.minGapMs',
    0,
    PROACTIVE_MIN_GAP_MS_MAX,
  );
  if (!minGapMs.ok) return minGapMs;

  const dailyMax = readIntInRange(
    value.dailyMax === undefined ? base.dailyMax : value.dailyMax,
    'qq.proactive.dailyMax',
    0,
    DAILY_MAX,
  );
  if (!dailyMax.ok) return dailyMax;

  const quietStart = readClock(
    value.quietStart === undefined ? base.quietStart : value.quietStart,
    'qq.proactive.quietStart',
  );
  if (!quietStart.ok) return quietStart;

  const quietEnd = readClock(
    value.quietEnd === undefined ? base.quietEnd : value.quietEnd,
    'qq.proactive.quietEnd',
  );
  if (!quietEnd.ok) return quietEnd;

  const intervalMs = readIntInRange(
    value.intervalMs === undefined ? base.intervalMs : value.intervalMs,
    'qq.proactive.intervalMs',
    FAST_MS_MIN,
    PROACTIVE_INTERVAL_MS_MAX,
  );
  if (!intervalMs.ok) return intervalMs;

  return {
    ok: true,
    value: {
      enabled: enabled.value,
      minGapMs: minGapMs.value,
      dailyMax: dailyMax.value,
      quietStart: quietStart.value,
      quietEnd: quietEnd.value,
      intervalMs: intervalMs.value,
    },
  };
}

function parseQq(value: unknown, base: HarnessQqConfig): Parsed<HarnessQqConfig> {
  if (!isPlainObject(value)) return fail('invalid_field', 'qq');
  const unsafe = findUnsafeKey(value);
  if (unsafe !== null) return fail('invalid_field', `qq.${unsafe}`);
  const unknown = findUnknownKey(value, QQ_KEYS);
  if (unknown !== null) return fail('invalid_field', `qq.${unknown}`);

  const enabled = readBoolean(value.enabled, 'qq.enabled', base.enabled);
  if (!enabled.ok) return enabled;

  const wsToken = readString(
    value.wsToken === undefined ? base.wsToken : value.wsToken,
    'qq.wsToken',
    0,
    MAX_TOKEN_CHARS,
  );
  if (!wsToken.ok) return wsToken;
  // 打码占位符回传时绝不能落盘；只可能是 UI 把 GET 的展示值原样提交了。
  if (isMaskedKey(wsToken.value)) return fail('invalid_field', 'qq.wsToken');

  const wsHost = readString(
    value.wsHost === undefined ? base.wsHost : value.wsHost,
    'qq.wsHost',
    1,
    MAX_HOST_CHARS,
  );
  if (!wsHost.ok) return wsHost;
  if (/\s/.test(wsHost.value) || wsHost.value !== wsHost.value.trim()) {
    return fail('invalid_field', 'qq.wsHost');
  }

  const wsPort = readIntInRange(
    value.wsPort === undefined ? base.wsPort : value.wsPort,
    'qq.wsPort',
    0,
    PORT_MAX,
  );
  if (!wsPort.ok) return wsPort;

  const ownerId = readQqId(
    value.ownerId === undefined ? base.ownerId : value.ownerId,
    'qq.ownerId',
  );
  if (!ownerId.ok) return ownerId;

  const selfId = readQqId(
    value.selfId === undefined ? base.selfId : value.selfId,
    'qq.selfId',
  );
  if (!selfId.ok) return selfId;

  const controlEnabled = readBoolean(
    value.controlEnabled,
    'qq.controlEnabled',
    base.controlEnabled,
  );
  if (!controlEnabled.ok) return controlEnabled;

  const controlNl = readBoolean(value.controlNl, 'qq.controlNl', base.controlNl);
  if (!controlNl.ok) return controlNl;

  const nlMinConfidence = readNumberInRange(
    value.nlMinConfidence === undefined ? base.nlMinConfidence : value.nlMinConfidence,
    'qq.nlMinConfidence',
    0,
    1,
  );
  if (!nlMinConfidence.ok) return nlMinConfidence;

  const minReplyGapMs = readIntInRange(
    value.minReplyGapMs === undefined ? base.minReplyGapMs : value.minReplyGapMs,
    'qq.minReplyGapMs',
    0,
    MIN_REPLY_GAP_MS_MAX,
  );
  if (!minReplyGapMs.ok) return minReplyGapMs;

  const groupAllowlist = readStringList(value.groupAllowlist, 'qq.groupAllowlist');
  if (!groupAllowlist.ok) return groupAllowlist;

  const groupDenylist = readStringList(value.groupDenylist, 'qq.groupDenylist');
  if (!groupDenylist.ok) return groupDenylist;

  const privateAllowlist = readStringList(value.privateAllowlist, 'qq.privateAllowlist');
  if (!privateAllowlist.ok) return privateAllowlist;

  const privateDenylist = readStringList(value.privateDenylist, 'qq.privateDenylist');
  if (!privateDenylist.ok) return privateDenylist;

  const privateOpen = readBoolean(value.privateOpen, 'qq.privateOpen', base.privateOpen);
  if (!privateOpen.ok) return privateOpen;

  const proactive = parseProactive(
    value.proactive === undefined ? base.proactive : value.proactive,
    base.proactive,
  );
  if (!proactive.ok) return proactive;

  return {
    ok: true,
    value: {
      enabled: enabled.value,
      wsToken: wsToken.value,
      wsHost: wsHost.value,
      wsPort: wsPort.value,
      ownerId: ownerId.value,
      selfId: selfId.value,
      controlEnabled: controlEnabled.value,
      controlNl: controlNl.value,
      nlMinConfidence: nlMinConfidence.value,
      minReplyGapMs: minReplyGapMs.value,
      groupAllowlist: groupAllowlist.value,
      groupDenylist: groupDenylist.value,
      privateAllowlist: privateAllowlist.value,
      privateDenylist: privateDenylist.value,
      privateOpen: privateOpen.value,
      proactive: proactive.value,
    },
  };
}

/**
 * 校验候选 `harness.json`。成功返回全新的 `HarnessConfig`；失败带稳定错误码，
 * 有意义时附字段路径（顶层未知键的 `field` 就是键名本身）。
 */
export function parseHarnessConfig(value: unknown): ParseHarnessConfigResult {
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

  const defaults = defaultHarnessConfig();

  const tick = parseTick(value.tick === undefined ? defaults.tick : value.tick, defaults.tick);
  if (!tick.ok) return tick;

  const http = parseHttp(value.http === undefined ? defaults.http : value.http, defaults.http);
  if (!http.ok) return http;

  const redline = parseRedline(
    value.redline === undefined ? defaults.redline : value.redline,
    defaults.redline,
  );
  if (!redline.ok) return redline;

  const qq = parseQq(value.qq === undefined ? defaults.qq : value.qq, defaults.qq);
  if (!qq.ok) return qq;

  const capability = parseCapability(
    value.capability === undefined ? defaults.capability : value.capability,
    defaults.capability,
  );
  if (!capability.ok) return capability;

  return {
    ok: true,
    value: {
      version: 1,
      importedFromEnv,
      tick: tick.value,
      http: http.value,
      redline: redline.value,
      qq: qq.value,
      capability: capability.value,
    },
  };
}

/** 公开形状：`wsToken` 永不出现；短于 12 字符的 token 连末四位也不给。 */
function maskToken(token: string): { hasWsToken: boolean; wsTokenLast4?: string } {
  if (token.length === 0) return { hasWsToken: false };
  const masked: { hasWsToken: boolean; wsTokenLast4?: string } = { hasWsToken: true };
  if (token.length >= 12) masked.wsTokenLast4 = token.slice(-4);
  return masked;
}

/** GET `/api/settings` 的形状：密钥只以 `hasWsToken` / `wsTokenLast4` 出现。 */
export function maskHarnessConfig(config: HarnessConfig): unknown {
  const { wsToken, ...qq } = config.qq;
  return {
    version: config.version,
    importedFromEnv: config.importedFromEnv,
    tick: { ...config.tick },
    http: { ...config.http },
    redline: { ...config.redline },
    qq: {
      ...qq,
      groupAllowlist: [...config.qq.groupAllowlist],
      groupDenylist: [...config.qq.groupDenylist],
      privateAllowlist: [...config.qq.privateAllowlist],
      privateDenylist: [...config.qq.privateDenylist],
      proactive: { ...config.qq.proactive },
      ...maskToken(wsToken),
    },
    capability: { ...config.capability },
  };
}

function envString(env: NodeJS.ProcessEnv, key: string): string {
  return env[key]?.trim() ?? '';
}

/** 空值/非法/越界一律回退默认值：导入失败不能砖化首次启动。 */
function envInt(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = envString(env, key);
  if (raw === '' || !DECIMAL.test(raw)) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

function envNumber(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = envString(env, key);
  if (raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) return fallback;
  return value;
}

/** 布尔语义与 QQ 插件一致：只有 1/true/yes 为真，其余一律 false。 */
function envFlag(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = envString(env, key).toLowerCase();
  if (raw === '') return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/** `7:05` → `07:05`；非法时刻回退默认。 */
function envClock(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(envString(env, key));
  if (match === null) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? `${String(hour).padStart(2, '0')}:${match[2]}` : fallback;
}

/** 逗号分隔；丢弃空白、超长与控制字符项，保证导入结果一定过 schema。 */
function envList(env: NodeJS.ProcessEnv, key: string): string[] {
  const raw = env[key];
  if (raw === undefined) return [];
  const list: string[] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '' || trimmed.length > MAX_LIST_ENTRY_CHARS) continue;
    if (CONTROL_CHARS.test(trimmed)) continue;
    list.push(trimmed);
  }
  return list;
}

/** `0200` 与 `200` 是同一个 QQ 号；非数字项原样保留，与 `normalizeIdList` 一致。 */
function envIdList(env: NodeJS.ProcessEnv, key: string): string[] {
  return envList(env, key).map((entry) => {
    if (!DECIMAL.test(entry) || entry.length > MAX_QQ_ID_CHARS) return entry;
    const numeric = Number(entry);
    return Number.isSafeInteger(numeric) && numeric > 0 ? String(numeric) : entry;
  });
}

/** 与 `normalizeOwnerId` 同一口径：非十进制/越界 → 空串。 */
function envQqId(env: NodeJS.ProcessEnv, key: string): string {
  const raw = envString(env, key);
  if (!DECIMAL.test(raw) || raw.length > MAX_QQ_ID_CHARS) return '';
  const numeric = Number(raw);
  return Number.isSafeInteger(numeric) && numeric > 0 ? String(numeric) : '';
}

/**
 * 首次启动（`harness.json` 不存在）时的 env 导入。只读白名单键：
 * `QQ_*`、`TICK_*`、`WAKE_DEBOUNCE_MS`、`HTTP_TIMEOUT_MS`、
 * `REDLINE_FALLBACK_TEXT`；不读 `.env` 文件本身，也不读任何 `WEB_*`。
 *
 * 每个值独立回退默认：一个坏 env 值不能阻止首次启动，更不能写出一份非法配置。
 */
export function importFromEnv(env: NodeJS.ProcessEnv): HarnessConfig {
  const defaults = defaultHarnessConfig();

  const fastMs = envInt(env, 'TICK_FAST_MS', defaults.tick.fastMs, FAST_MS_MIN, FAST_MS_MAX);
  const slowMs = envInt(
    env,
    'TICK_SLOW_MS',
    defaults.tick.slowMs,
    FAST_MS_MIN + 1,
    SLOW_MS_MAX,
  );
  // 两个值都合法但关系反转时整体回退，避免导入一份永远过不了 schema 的配置。
  const tick =
    fastMs < slowMs
      ? {
          fastMs,
          slowMs,
          wakeDebounceMs: envInt(
            env,
            'WAKE_DEBOUNCE_MS',
            defaults.tick.wakeDebounceMs,
            0,
            WAKE_DEBOUNCE_MS_MAX,
          ),
        }
      : { ...defaults.tick };

  const token = envString(env, 'QQ_WS_TOKEN');
  const ownerId = envQqId(env, 'QQ_OWNER_ID');
  // 开关只表达「是否显式关闭」：未配置时用 schema 默认 true，绝不从 owner
  // 推导——否则没有 owner 的安装会被误判成「操作员显式关闭」，网页控制面
  // 被静默禁用。QQ 适配器自己另有一道 owner 存在性闸。
  const controlEnabled = envFlag(env, 'QQ_CONTROL_ENABLED', defaults.qq.controlEnabled);

  const wsHost = envString(env, 'QQ_WS_HOST');
  const rawFallbackText = envString(env, 'REDLINE_FALLBACK_TEXT');
  const fallbackText =
    rawFallbackText === '' || CONTROL_CHARS.test(rawFallbackText)
      ? defaults.redline.fallbackText
      : rawFallbackText.slice(0, MAX_FALLBACK_CHARS);

  const qq: HarnessQqConfig = {
    enabled: token !== '',
    // 打码占位符不可能是真 token；控制字符同样不可能通过 schema 校验。
    wsToken: isMaskedKey(token) || CONTROL_CHARS.test(token) ? '' : token,
    wsHost: wsHost === '' || /\s/.test(wsHost) ? defaults.qq.wsHost : wsHost,
    // 0 = 让内核挑临时端口；与 schema 的允许区间一致，导入不得夹紧。
    wsPort: envInt(env, 'QQ_WS_PORT', defaults.qq.wsPort, 0, PORT_MAX),
    ownerId,
    selfId: envQqId(env, 'QQ_SELF_ID'),
    controlEnabled,
    controlNl: envFlag(env, 'QQ_CONTROL_NL', false),
    nlMinConfidence: envNumber(env, 'QQ_NL_MIN_CONFIDENCE', defaults.qq.nlMinConfidence, 0, 1),
    minReplyGapMs: envInt(
      env,
      'QQ_MIN_REPLY_GAP_MS',
      defaults.qq.minReplyGapMs,
      0,
      MIN_REPLY_GAP_MS_MAX,
    ),
    groupAllowlist: envList(env, 'QQ_GROUP_ALLOWLIST'),
    groupDenylist: envList(env, 'QQ_GROUP_DENYLIST'),
    privateAllowlist: envList(env, 'QQ_PRIVATE_ALLOWLIST'),
    privateDenylist: envIdList(env, 'QQ_PRIVATE_DENYLIST'),
    privateOpen: envFlag(env, 'QQ_PRIVATE_OPEN', false),
    proactive: {
      enabled: envFlag(env, 'QQ_PROACTIVE_ENABLED', false),
      minGapMs: envInt(
        env,
        'QQ_PROACTIVE_MIN_GAP_MS',
        defaults.qq.proactive.minGapMs,
        0,
        PROACTIVE_MIN_GAP_MS_MAX,
      ),
      dailyMax: envInt(env, 'QQ_PROACTIVE_DAILY_MAX', defaults.qq.proactive.dailyMax, 0, DAILY_MAX),
      quietStart: envClock(env, 'QQ_PROACTIVE_QUIET_START', defaults.qq.proactive.quietStart),
      quietEnd: envClock(env, 'QQ_PROACTIVE_QUIET_END', defaults.qq.proactive.quietEnd),
      intervalMs: envInt(
        env,
        'QQ_PROACTIVE_INTERVAL_MS',
        defaults.qq.proactive.intervalMs,
        FAST_MS_MIN,
        PROACTIVE_INTERVAL_MS_MAX,
      ),
    },
  };

  return {
    version: 1,
    importedFromEnv: true,
    tick,
    http: {
      timeoutMs: envInt(
        env,
        'HTTP_TIMEOUT_MS',
        defaults.http.timeoutMs,
        HTTP_TIMEOUT_MS_MIN,
        HTTP_TIMEOUT_MS_MAX,
      ),
    },
    redline: {
      fallbackText,
    },
    qq,
    capability: { ...defaults.capability },
  };
}
