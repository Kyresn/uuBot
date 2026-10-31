/**
 * 设置 API（spec §3.5）：
 * - `GET /api/settings` → `{ok, config: 掩码, importedFromEnv, requiresRestart, revision}`；
 * - `PUT /api/settings` → 干跑 → 原子写 → 热生效；失败 400 且磁盘不变。
 *
 * 密钥三态（缺省保持、`null` 清除、字符串替换）与打码值拒绝全部由
 * `HarnessStore` 统一解析，这里不重新实现：API 与存储的口径必须只有一份。
 * `requiresRestart` 由装配点注入 `requiresRestartFields`（`src/startup.ts`），
 * 与热生效逻辑同源，不在本文件硬编码字段名。
 *
 * PUT 是整份文档：缺任何一个顶层段都会让 schema 用默认值填上（默认值里
 * `qq.controlEnabled` 是 true、名单是空、`qq.enabled` 是 false）——一次漏发
 * 整段就是看不见的配置回滚。因此五个段必须齐全，否则 400 点名缺失段。
 * 并发：GET 下发 `revision`（文件内容摘要），PUT 回传；不一致返回 409
 * `conflict`，让页面重新加载而不是覆盖另一标签页的保存。
 *
 * 每个请求独立 try/catch：设置页故障只降级本页，绝不冒泡到心跳。
 */
import type { HarnessConfig } from '../config/harness-schema.js';
import type { HarnessStore } from '../config/harness-store.js';
import type { RouteHandler } from './server.js';

export interface SettingsApiDeps {
  store: Pick<HarnessStore, 'get' | 'getMasked' | 'save' | 'revision'>;
  /** 与装配点共用同一份热生效边界推导（`src/startup.ts`）。 */
  requiresRestart: (config: HarnessConfig) => string[];
  log?: (line: string) => void;
}

/** PUT 必须携带的顶层段；省略任何一段都会触发 schema 默认值回滚。 */
const REQUIRED_SECTIONS = ['tick', 'http', 'redline', 'qq', 'capability'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 返回第一个缺失的顶层段；齐全时返回 undefined。 */
function missingSection(body: Record<string, unknown>): string | undefined {
  return REQUIRED_SECTIONS.find((section) => body[section] === undefined);
}

export interface SettingsApi {
  handlers: {
    settings: RouteHandler;
    settingsSave: RouteHandler;
  };
}

export function createSettingsApi(deps: SettingsApiDeps): SettingsApi {
  const log = deps.log ?? (() => {});

  const settings: RouteHandler = (ctx) => {
    try {
      const config = deps.store.get();
      if (config === null) {
        // 只有装配错误会走到这里：HarnessStore 在网页启动前必须已加载。
        ctx.send(503, { ok: false, code: 'unavailable' });
        return;
      }
      ctx.send(200, {
        ok: true,
        config: deps.store.getMasked(),
        importedFromEnv: config.importedFromEnv,
        requiresRestart: deps.requiresRestart(config),
        revision: deps.store.revision(),
      });
    } catch (error) {
      log(`settings api: ${error instanceof Error ? error.message : String(error)}`);
      ctx.send(503, { ok: false, code: 'settings_unavailable' });
    }
  };

  const settingsSave: RouteHandler = async (ctx) => {
    try {
      const body = ctx.body;

      // 非对象文档交给存储层：错误码与 models 路由保持一致（invalid_config）。
      if (!isPlainObject(body)) {
        const result = await deps.store.save(body);
        if (result.ok) {
          ctx.send(200, { ok: true });
          return;
        }
        ctx.send(400, {
          ok: false,
          code: result.code,
          ...(result.field === undefined ? {} : { field: result.field }),
        });
        return;
      }

      // 乐观并发：版本令牌来自 GET；磁盘在两次请求之间变过就拒绝覆盖。
      const revision = body['revision'];
      if (revision !== undefined && revision !== null && typeof revision !== 'string') {
        ctx.send(400, { ok: false, code: 'invalid_field', field: 'revision' });
        return;
      }
      if (typeof revision === 'string') {
        const current = deps.store.revision();
        if (current !== null && revision !== current) {
          ctx.send(409, { ok: false, code: 'conflict' });
          return;
        }
      }

      // 整份文档：缺任何顶层段都会让 schema 用默认值填上（见文件头注释）。
      const missing = missingSection(body);
      if (missing !== undefined) {
        ctx.send(400, { ok: false, code: 'invalid_field', field: missing });
        return;
      }

      const { revision: _revision, ...document } = body;
      const result = await deps.store.save(document);
      if (result.ok) {
        ctx.send(200, { ok: true });
        return;
      }
      // 非法输入、干跑失败与写失败都用 400：这是「配置未生效」的稳定失败码，
      // 磁盘上仍是上一份合法配置（spec 安全不变量 4）。
      ctx.send(400, {
        ok: false,
        code: result.code,
        ...(result.field === undefined ? {} : { field: result.field }),
      });
    } catch (error) {
      log(`settings api: ${error instanceof Error ? error.message : String(error)}`);
      ctx.send(503, { ok: false, code: 'settings_unavailable' });
    }
  };

  return { handlers: { settings, settingsSave } };
}
