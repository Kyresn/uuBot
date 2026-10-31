import { describe, it, expect } from 'vitest';
import { readManifest } from '../../src/plugins/manifest.js';

describe('cli channel manifest', () => {
  it('is valid and declares the cli channel contract', async () => {
    const manifest = await readManifest('plugins/channels/cli');

    expect(manifest.name).toBe('cli');
    expect(manifest.kind).toBe('channel');
    expect(manifest.channelPrefix).toBe('cli');
    expect(manifest.apiVersion).toBe(1);
  });
});
