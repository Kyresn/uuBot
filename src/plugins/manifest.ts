/**
 * 插件 manifest 类型与校验。
 *
 * manifest 是插件目录下唯一的声明文件（`manifest.json`）。宿主在加载模块
 * 之前先校验它：名称、类型、API 版本、入口路径与渠道前缀。入口路径的校验
 * 同时承担路径穿越防护——`..`、绝对路径与盘符一律拒绝。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 插件类型：渠道插件接入外部消息源，能力插件只提供工具。 */
export type PluginKind = 'channel' | 'capability';

/** 插件声明的工具定义，形状与 brain 的 ToolDef.function 一致。 */
export interface PluginToolDef {
  name: string;
  description: string;
  parameters: object;
}

/** 校验通过的 manifest。 */
export interface PluginManifest {
  name: string;
  kind: PluginKind;
  apiVersion: number;
  version: string;
  entry: string;
  description?: string;
  channelPrefix?: string;
  /** 插件私有配置；宿主只校验形状，原样透传给插件 api.config。 */
  config?: Record<string, unknown>;
  permissions?: string[];
  tools?: PluginToolDef[];
}

/** 当前宿主支持的插件 API 版本。 */
export const SUPPORTED_API_VERSION = 1;

/** manifest 缺失、不可读或不符合规则时抛出。 */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** channelPrefix 同时用作路由键与 `${prefix}:` 命名空间，只允许小写与分隔符。 */
const CHANNEL_PREFIX_PATTERN = /^[a-z0-9][a-z0-9:-]*$/;
const DRIVE_PREFIX = /^[A-Za-z]:/;
const KINDS: readonly PluginKind[] = ['channel', 'capability'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validateEntry(entry: unknown): string {
  if (!nonEmptyString(entry)) throw new ManifestError('entry must be a non-empty string');
  if (entry.includes('..')) throw new ManifestError(`entry must not contain "..": ${entry}`);
  if (entry.startsWith('/') || entry.startsWith('\\')) {
    throw new ManifestError(`entry must be relative: ${entry}`);
  }
  if (DRIVE_PREFIX.test(entry)) throw new ManifestError(`entry must be relative: ${entry}`);
  return entry;
}

function validateTools(tools: unknown): PluginToolDef[] | undefined {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools)) throw new ManifestError('tools must be an array');
  return tools.map((tool, index) => {
    if (!isRecord(tool)) throw new ManifestError(`tools[${index}] must be an object`);
    if (!nonEmptyString(tool.name)) throw new ManifestError(`tools[${index}].name must be a non-empty string`);
    if (!nonEmptyString(tool.description)) {
      throw new ManifestError(`tools[${index}].description must be a non-empty string`);
    }
    if (!isRecord(tool.parameters)) throw new ManifestError(`tools[${index}].parameters must be an object`);
    return { name: tool.name, description: tool.description, parameters: tool.parameters };
  });
}

/**
 * 校验任意 JSON 值并返回类型化的 manifest。失败时抛 ManifestError，
 * 消息带具体原因，方便宿主直接记日志。
 */
export function validateManifest(raw: unknown): PluginManifest {
  if (!isRecord(raw)) throw new ManifestError('manifest must be a JSON object');

  if (typeof raw.name !== 'string' || !NAME_PATTERN.test(raw.name)) {
    throw new ManifestError(`name must match ${NAME_PATTERN}: ${String(raw.name)}`);
  }

  if (typeof raw.kind !== 'string' || !KINDS.includes(raw.kind as PluginKind)) {
    throw new ManifestError(`kind must be one of ${KINDS.join(', ')}: ${String(raw.kind)}`);
  }
  const kind = raw.kind as PluginKind;

  if (raw.apiVersion !== SUPPORTED_API_VERSION) {
    throw new ManifestError(
      `apiVersion must be ${SUPPORTED_API_VERSION}: ${String(raw.apiVersion)}`,
    );
  }

  if (!nonEmptyString(raw.version)) throw new ManifestError('version must be a non-empty string');

  const entry = validateEntry(raw.entry);

  if (raw.description !== undefined && typeof raw.description !== 'string') {
    throw new ManifestError('description must be a string');
  }

  if (kind === 'channel') {
    if (!nonEmptyString(raw.channelPrefix) || !CHANNEL_PREFIX_PATTERN.test(raw.channelPrefix)) {
      throw new ManifestError(
        `channelPrefix must match ${CHANNEL_PREFIX_PATTERN}: ${String(raw.channelPrefix)}`,
      );
    }
  } else if (raw.channelPrefix !== undefined) {
    throw new ManifestError('channelPrefix is only allowed on channel plugins');
  }

  let config: Record<string, unknown> | undefined;
  if (raw.config !== undefined) {
    if (!isRecord(raw.config)) throw new ManifestError('config must be a plain object');
    config = { ...raw.config };
  }

  let permissions: string[] | undefined;
  if (raw.permissions !== undefined) {
    if (!Array.isArray(raw.permissions) || raw.permissions.some((p) => typeof p !== 'string')) {
      throw new ManifestError('permissions must be an array of strings');
    }
    permissions = [...raw.permissions];
  }

  const tools = validateTools(raw.tools);

  return {
    name: raw.name,
    kind,
    apiVersion: raw.apiVersion,
    version: raw.version,
    entry,
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    ...(typeof raw.channelPrefix === 'string' ? { channelPrefix: raw.channelPrefix } : {}),
    ...(config === undefined ? {} : { config }),
    ...(permissions === undefined ? {} : { permissions }),
    ...(tools === undefined ? {} : { tools }),
  };
}

/** 读取 `<pluginDir>/manifest.json` 并校验。 */
export async function readManifest(pluginDir: string): Promise<PluginManifest> {
  const path = join(pluginDir, 'manifest.json');

  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new ManifestError(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ManifestError(
      `manifest.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return validateManifest(raw);
}
