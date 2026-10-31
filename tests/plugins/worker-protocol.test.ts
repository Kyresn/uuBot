import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  PERMISSION_METHODS,
  type HostReply,
  type WorkerRequest,
  type WorkerResponse,
} from '../../src/plugins/worker-protocol.js';

describe('worker protocol', () => {
  it('maps every non-send rpc method to a permission group', () => {
    // send 仍保留在 RPC_METHODS 中以便给出明确拒绝，但不再映射权限组。
    expect(PERMISSION_METHODS).toEqual({
      'brain.chat': 'brain',
      'memory.search': 'memory',
      'memory.write': 'memory',
      log: 'log',
      reply: 'log',
    });
    expect(Object.keys(PERMISSION_METHODS)).toHaveLength(5);
  });

  it('models every worker request variant', () => {
    const requests = [
      {
        type: 'init',
        pluginPath: '/plugins/demo/index.mjs',
        permissions: ['brain'],
        config: { key: 'value' },
        name: 'demo',
      },
      { type: 'tool', id: 'tool-1', name: 'echo', args: { text: 'hi' } },
      { type: 'shutdown' },
    ] satisfies WorkerRequest[];

    expect(requests.map((request) => request.type)).toEqual(['init', 'tool', 'shutdown']);
  });

  it('models every worker response and host reply variant', () => {
    const responses = [
      { type: 'ready', tools: ['echo'] },
      { type: 'rpc', id: 'rpc-1', method: 'brain.chat', args: [[{ role: 'user', content: 'hi' }]] },
      { type: 'tool-result', id: 'tool-1', ok: true, value: { echoed: 'hi' } },
      { type: 'tool-result', id: 'tool-2', ok: false, error: 'boom' },
      { type: 'fatal', error: 'cannot load plugin' },
    ] satisfies WorkerResponse[];

    const replies = [
      { type: 'rpc-result', id: 'rpc-1', ok: true, value: null },
      { type: 'rpc-result', id: 'rpc-2', ok: false, error: 'permission denied: brain.chat' },
    ] satisfies HostReply[];

    expect(responses.map((response) => response.type)).toEqual([
      'ready',
      'rpc',
      'tool-result',
      'tool-result',
      'fatal',
    ]);
    expect(replies.map((reply) => reply.type)).toEqual(['rpc-result', 'rpc-result']);
  });

  it('keeps the bootstrap free of host imports', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../../src/plugins/capability-worker.mjs', import.meta.url)),
      'utf8',
    );
    const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)]
      .map((match) => match[1])
      .sort();

    expect(specifiers).toEqual(['node:url', 'node:worker_threads']);
  });
});
