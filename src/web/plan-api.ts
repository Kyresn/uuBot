/**
 * 计划 API：`GET /api/plan`。
 *
 * 数据源两级回退（见设计「计划展示」）：
 * 1. `DATA_DIR/plan.json`：运行时覆盖，不入库；
 * 2. 入库的 `docs/plan.json`：相对本模块解析，容器镜像里同样有效。
 *
 * 两级都缺失（或不是合法 JSON 对象）时返回 `{ ok: true, plan: null }`，
 * 网页显示「未提供计划」而不是把缺文件当成错误。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RouteHandler } from './server.js';

/**
 * `src/web/plan-api.ts` → `<repo>/docs/plan.json`。当前 Dockerfile 用 tsx 直接
 * 运行源码，这个相对路径在容器内解析为 `/app/docs/plan.json`。
 * 注意：`tsc` 会按 tsconfig 的 `outDir`/`include` 输出到 `dist/src/web/`，
 * 那时 `../../docs` 指向 `dist/docs`；将来若改用编译产物启动，必须把
 * `docs/plan.json` 复制到 `dist/docs/`，或显式传入 `docsPlanPath`。
 */
const BUNDLED_PLAN_PATH = fileURLToPath(new URL('../../docs/plan.json', import.meta.url));

export interface PlanApiDeps {
  /** 运行时状态目录（`DATA_DIR`），覆盖文件位于 `plan.json`。 */
  dataDir: string;
  /** 测试用：覆盖入库计划路径。 */
  docsPlanPath?: string;
  log?: (line: string) => void;
}

export interface PlanApi {
  handlers: {
    plan: RouteHandler;
  };
}

function isPlanObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 运行期覆盖文件必须能渲染出计划页：`current` 是字符串、`milestones` 是数组。
 * 不满足就当作没有覆盖，回退到入库计划；校验只做形状检查，不校验任务字段。
 */
function isPlanShape(value: unknown): value is Record<string, unknown> {
  return (
    isPlanObject(value) &&
    typeof value['current'] === 'string' &&
    Array.isArray(value['milestones'])
  );
}

/**
 * 读取一个计划文件。缺失、不可读、非法 JSON 或未通过 `accept` 一律返回
 * `undefined`，由调用方决定回退；错误文本只进日志，绝不进响应。
 */
async function readPlanFile(
  filePath: string,
  log: (line: string) => void,
  accept: (value: unknown) => boolean = isPlanObject,
): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (accept(parsed)) return parsed as Record<string, unknown>;
    log(`plan rejected: ${path.basename(filePath)} is not a plan object`);
  } catch {
    log(`plan rejected: ${path.basename(filePath)} is not valid JSON`);
  }
  return undefined;
}

export function createPlanApi(deps: PlanApiDeps): PlanApi {
  const log = deps.log ?? (() => {});
  const docsPlanPath = deps.docsPlanPath ?? BUNDLED_PLAN_PATH;

  const plan: RouteHandler = async (ctx) => {
    const override = await readPlanFile(
      path.join(deps.dataDir, 'plan.json'),
      log,
      isPlanShape,
    );
    if (override !== undefined) {
      ctx.send(200, { ok: true, plan: override });
      return;
    }

    const bundled = await readPlanFile(docsPlanPath, log);
    ctx.send(200, { ok: true, plan: bundled ?? null });
  };

  return { handlers: { plan } };
}
