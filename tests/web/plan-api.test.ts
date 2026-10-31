import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RouteContext, RouteHandler } from '../../src/web/server.js';
import { createPlanApi } from '../../src/web/plan-api.js';

const dirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'uuharness-plan-api-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface PlanResponse {
  status: number;
  body: unknown;
}

/** 直接调用 handler：plan API 不依赖请求头，只有 send 出口。 */
function callPlan(handler: RouteHandler): Promise<PlanResponse> {
  return new Promise((resolve) => {
    const ctx = {
      send: (status: number, value: unknown) => resolve({ status, body: value }),
    } as unknown as RouteContext;
    void Promise.resolve(handler(ctx));
  });
}

function planFile(current: string): string {
  return JSON.stringify({
    updatedAt: '2026-10-29T14:30:00Z',
    current,
    milestones: [{ id: current, title: 'milestone', status: 'active' }],
    backlog: [],
  });
}

describe('GET /api/plan', () => {
  it('prefers the DATA_DIR runtime override over the bundled docs plan', async () => {
    const dataDir = await makeDir();
    const docsDir = await makeDir();
    const docsPlanPath = path.join(docsDir, 'plan.json');
    await writeFile(docsPlanPath, planFile('BUNDLED'), 'utf8');
    await writeFile(path.join(dataDir, 'plan.json'), planFile('OVERRIDE'), 'utf8');

    const api = createPlanApi({ dataDir, docsPlanPath });
    const response = await callPlan(api.handlers.plan);

    expect(response.status).toBe(200);
    const body = response.body as { ok: boolean; plan: { current: string } };
    expect(body.ok).toBe(true);
    expect(body.plan.current).toBe('OVERRIDE');
  });

  it('falls back to the bundled docs plan when no override exists', async () => {
    const dataDir = await makeDir();
    const docsDir = await makeDir();
    const docsPlanPath = path.join(docsDir, 'plan.json');
    await writeFile(docsPlanPath, planFile('BUNDLED'), 'utf8');

    const api = createPlanApi({ dataDir, docsPlanPath });
    const response = await callPlan(api.handlers.plan);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, plan: { current: 'BUNDLED' } });
  });

  it('falls back to the docs plan when the override is not valid JSON', async () => {
    const dataDir = await makeDir();
    const docsDir = await makeDir();
    const docsPlanPath = path.join(docsDir, 'plan.json');
    await writeFile(docsPlanPath, planFile('BUNDLED'), 'utf8');
    await writeFile(path.join(dataDir, 'plan.json'), '{not json', 'utf8');

    const logs: string[] = [];
    const api = createPlanApi({ dataDir, docsPlanPath, log: (line) => logs.push(line) });
    const response = await callPlan(api.handlers.plan);

    expect(response.body).toMatchObject({ ok: true, plan: { current: 'BUNDLED' } });
    expect(logs.join('\n')).toContain('plan');
  });

  it('falls back to the docs plan when the override lacks the plan shape', async () => {
    const dataDir = await makeDir();
    const docsDir = await makeDir();
    const docsPlanPath = path.join(docsDir, 'plan.json');
    await writeFile(docsPlanPath, planFile('BUNDLED'), 'utf8');
    // current 不是字符串：网页渲染不出「当前里程碑」，视为无效覆盖。
    await writeFile(
      path.join(dataDir, 'plan.json'),
      JSON.stringify({ current: 42, milestones: [] }),
      'utf8',
    );

    const logs: string[] = [];
    const api = createPlanApi({ dataDir, docsPlanPath, log: (line) => logs.push(line) });
    const response = await callPlan(api.handlers.plan);

    expect(response.body).toMatchObject({ ok: true, plan: { current: 'BUNDLED' } });
    expect(logs.join('\n')).toContain('plan rejected');
    // 日志只点名文件，绝不回显文件内容。
    expect(logs.join('\n')).not.toContain('42');
  });

  it('falls back to the docs plan when override milestones is not an array', async () => {
    const dataDir = await makeDir();
    const docsDir = await makeDir();
    const docsPlanPath = path.join(docsDir, 'plan.json');
    await writeFile(docsPlanPath, planFile('BUNDLED'), 'utf8');
    await writeFile(
      path.join(dataDir, 'plan.json'),
      JSON.stringify({ current: 'OVERRIDE', milestones: { id: 'M1' } }),
      'utf8',
    );

    const logs: string[] = [];
    const api = createPlanApi({ dataDir, docsPlanPath, log: (line) => logs.push(line) });
    const response = await callPlan(api.handlers.plan);

    expect(response.body).toMatchObject({ ok: true, plan: { current: 'BUNDLED' } });
    expect(logs.join('\n')).toContain('plan rejected');
    expect(logs.join('\n')).not.toContain('OVERRIDE');
  });

  it('answers {ok:true, plan:null} when both files are missing', async () => {
    const dataDir = await makeDir();
    const docsDir = await makeDir();

    const api = createPlanApi({ dataDir, docsPlanPath: path.join(docsDir, 'plan.json') });
    const response = await callPlan(api.handlers.plan);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, plan: null });
  });
});
