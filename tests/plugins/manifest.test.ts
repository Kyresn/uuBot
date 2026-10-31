import { describe, it, expect } from 'vitest';
import { validateManifest, ManifestError, SUPPORTED_API_VERSION } from '../../src/plugins/manifest.js';

const base = { name: 'qq', kind: 'channel', channelPrefix: 'qq', apiVersion: 1, version: '0.1.0', entry: 'index.js' };

describe('validateManifest', () => {
  it('accepts a valid channel manifest', () => {
    expect(validateManifest(base).name).toBe('qq');
  });
  it('rejects path traversal in entry', () => {
    for (const entry of ['../../etc/passwd', '/etc/passwd', 'a/../../b.js', 'C:\\x.js']) {
      expect(() => validateManifest({ ...base, entry })).toThrow(ManifestError);
    }
  });
  it('rejects an unsupported apiVersion', () => {
    expect(() => validateManifest({ ...base, apiVersion: 2 })).toThrow(/apiVersion/);
  });
  it('requires channelPrefix for channels and forbids it for capabilities', () => {
    expect(() => validateManifest({ ...base, channelPrefix: undefined })).toThrow(/channelPrefix/);
    expect(() => validateManifest({ name: 'x', kind: 'capability', apiVersion: 1, version: '1', entry: 'i.mjs' })).not.toThrow();
    expect(() => validateManifest({ name: 'x', kind: 'capability', channelPrefix: 'x', apiVersion: 1, version: '1', entry: 'i.mjs' })).toThrow(/channelPrefix/);
  });
  it('rejects bad names and unknown kinds', () => {
    expect(() => validateManifest({ ...base, name: 'Bad Name' })).toThrow(ManifestError);
    expect(() => validateManifest({ ...base, kind: 'behavior' })).toThrow(ManifestError);
  });
  it('exposes the supported api version', () => {
    expect(SUPPORTED_API_VERSION).toBe(1);
  });
  it('accepts and copies a plain-object config', () => {
    const manifest = validateManifest({ ...base, config: { endpoint: 'x', nested: { n: 1 } } });
    expect(manifest.config).toEqual({ endpoint: 'x', nested: { n: 1 } });
  });
  it('rejects a config that is not a plain object', () => {
    for (const config of [[], 'x', 1, null]) {
      expect(() => validateManifest({ ...base, config })).toThrow(ManifestError);
    }
  });
  it('rejects malformed channelPrefix values', () => {
    for (const channelPrefix of ['Bad Prefix', 'UPPER', '-lead', 'a/b']) {
      expect(() => validateManifest({ ...base, channelPrefix })).toThrow(/channelPrefix/);
    }
  });
});
