/**
 * 工具定义适配：能力注册表暴露扁平的 PluginToolDef，brain 需要
 * `{ type: 'function', function: {...} }` 包装。保持两侧类型独立，
 * 适配只发生在装配层（index.ts 的 tools 依赖）。
 */

import type { ToolDef } from '../brain/types.js';
import type { PluginToolDef } from './manifest.js';

export function toBrainToolDefs(defs: PluginToolDef[]): ToolDef[] {
  return defs.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}
