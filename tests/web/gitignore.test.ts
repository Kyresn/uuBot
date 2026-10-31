import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DOCKERIGNORE = fileURLToPath(new URL('../../deploy/Dockerfile.dockerignore', import.meta.url));

/**
 * `git check-ignore` is the only honest assertion here: it exercises the real
 * ignore rules instead of re-implementing pattern matching. `--no-index` keeps
 * the answer independent of whether a file happens to exist or be tracked.
 * Works on Windows (git.exe is resolved from PATH).
 */
function isIgnored(relativePath: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '--no-index', '-q', relativePath], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch (error) {
    const status = (error as { status?: number | null }).status;
    // 1 = checked and not ignored; anything else is a real git failure.
    if (status === 1) return false;
    throw error;
  }
}

describe('.gitignore', () => {
  it('keeps runtime configuration and state out of the repository', () => {
    expect(isIgnored('config/models.json')).toBe(true);
    expect(isIgnored('config/models.json.bak')).toBe(true);
    // harness.json 含 qq.wsToken；漏掉它等于把密钥提交进仓库。
    expect(isIgnored('config/harness.json')).toBe(true);
    expect(isIgnored('config/harness.json.bak')).toBe(true);
    expect(isIgnored('state/transcript.jsonl')).toBe(true);
  });

  it('keeps the bundled plan tracked', () => {
    expect(isIgnored('docs/plan.json')).toBe(false);
  });

  it('ignores the atomic-write temp files that hold the plaintext config', () => {
    expect(isIgnored('config/.models.json.1234.abcdef.tmp')).toBe(true);
    expect(isIgnored('config/.models.json.bak.1234.abcdef.tmp')).toBe(true);
  });
});

describe('deploy/Dockerfile.dockerignore', () => {
  it('keeps keys, transcripts and nested env files out of the build context', async () => {
    const text = await readFile(DOCKERIGNORE, 'utf8');
    const patterns = text
      .split('\n')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '' && !entry.startsWith('#'));
    expect(patterns).toContain('config/');
    expect(patterns).toContain('state/');
    expect(patterns).toContain('**/.env');
  });
});
