import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { captureSourceIdentity } from '../../tools/live/retainCandidate';

const roots: string[] = [];

function git(repositoryRoot: string, arguments_: readonly string[]): string {
  return execFileSync('git', arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
}

async function repositoryFixture(): Promise<string> {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'source-identity-test-'));
  roots.push(repositoryRoot);
  git(repositoryRoot, ['init', '--quiet']);
  git(repositoryRoot, ['config', 'core.autocrlf', 'false']);
  git(repositoryRoot, ['config', 'user.email', 'source-identity@example.invalid']);
  git(repositoryRoot, ['config', 'user.name', 'Source Identity Test']);
  await writeFile(join(repositoryRoot, 'tracked.txt'), 'committed contents\n', 'utf8');
  git(repositoryRoot, ['add', '--', 'tracked.txt']);
  git(repositoryRoot, ['commit', '--quiet', '-m', 'test fixture']);
  return repositoryRoot;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('Git source identity', () => {
  it('reports a clean tracked worktree when its bytes match the Git index', async () => {
    const repositoryRoot = await repositoryFixture();

    const identity = await captureSourceIdentity(repositoryRoot);

    expect(identity).toMatchObject({
      schemaVersion: 'git-working-tree-content.v2',
      dirty: false,
      gitStatus: { bytes: 0 },
      trackedPatch: { bytes: 0 },
      trackedContent: {
        format: 'git-index-worktree-inventory.v2',
        fileModeEnforced: process.platform !== 'win32',
        fileCount: 1,
        missingFileCount: 0,
        executableModeMismatchCount: 0,
        indexMismatchCount: 0,
      },
      untrackedContent: { fileCount: 0, totalBytes: 0 },
    });
    expect(identity.trackedContent.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(identity.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('detects changed tracked bytes hidden from Git status by assume-unchanged', async () => {
    const repositoryRoot = await repositoryFixture();
    git(repositoryRoot, ['update-index', '--assume-unchanged', '--', 'tracked.txt']);
    await writeFile(join(repositoryRoot, 'tracked.txt'), 'hidden changed contents\n', 'utf8');

    expect(git(repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('');
    expect(git(repositoryRoot, ['diff', '--binary', '--full-index', 'HEAD', '--'])).toBe('');

    const identity = await captureSourceIdentity(repositoryRoot);

    expect(identity.dirty).toBe(true);
    expect(identity.gitStatus.bytes).toBe(0);
    expect(identity.trackedPatch.bytes).toBe(0);
    expect(identity.trackedContent).toMatchObject({
      fileCount: 1,
      missingFileCount: 0,
      indexMismatchCount: 1,
    });
    expect(identity.trackedContent.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('exercises executable-mode mismatch accounting deterministically on every host', async () => {
    const repositoryRoot = await repositoryFixture();
    const trackedPath = join(repositoryRoot, 'tracked.txt');
    const resolvedPaths: string[] = [];
    git(repositoryRoot, ['config', 'core.fileMode', 'true']);
    git(repositoryRoot, ['update-index', '--assume-unchanged', '--', 'tracked.txt']);

    expect(git(repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('');
    expect(git(repositoryRoot, ['diff', '--binary', '--full-index', 'HEAD', '--'])).toBe('');

    const identity = await captureSourceIdentity(
      repositoryRoot,
      undefined,
      (path, observedMode) => {
        resolvedPaths.push(path);
        return path === trackedPath ? observedMode | 0o111 : observedMode;
      },
    );

    expect(resolvedPaths).toEqual([trackedPath]);
    expect(identity.dirty).toBe(true);
    expect(identity.gitStatus.bytes).toBe(0);
    expect(identity.trackedPatch.bytes).toBe(0);
    expect(identity.trackedContent).toMatchObject({
      fileModeEnforced: true,
      fileCount: 1,
      missingFileCount: 0,
      executableModeMismatchCount: 1,
      indexMismatchCount: 1,
    });
  });

  it.skipIf(process.platform === 'win32')(
    'detects an executable-mode change hidden from Git status by assume-unchanged',
    async () => {
      const repositoryRoot = await repositoryFixture();
      git(repositoryRoot, ['config', 'core.fileMode', 'true']);
      git(repositoryRoot, ['update-index', '--assume-unchanged', '--', 'tracked.txt']);
      await chmod(join(repositoryRoot, 'tracked.txt'), 0o755);

      expect(git(repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('');
      expect(git(repositoryRoot, ['diff', '--binary', '--full-index', 'HEAD', '--'])).toBe('');

      const identity = await captureSourceIdentity(repositoryRoot);

      expect(identity.dirty).toBe(true);
      expect(identity.trackedContent).toMatchObject({
        fileModeEnforced: true,
        fileCount: 1,
        missingFileCount: 0,
        executableModeMismatchCount: 1,
        indexMismatchCount: 1,
      });
    },
  );
});
