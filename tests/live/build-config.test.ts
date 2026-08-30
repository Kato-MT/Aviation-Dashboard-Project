import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evidenceBuildIdentity,
  LIVE_APPLICATION_VERSION,
  LOCAL_UNRELEASED_SHA,
  liveBuildOptions,
} from '../../tools/live/buildConfig';
import {
  assertLiveBuildInvocation,
  LIVE_BUILD_WRAPPER_ENV,
  LIVE_CLIENT_INPUTS,
} from '../../vite.live.config';
import {
  OFFLINE_AIRSPACE_MAP_IMPORT,
  OFFLINE_AIRSPACE_MAP_STUB,
  OFFLINE_FORBIDDEN_RUNTIME_TOKENS,
  OFFLINE_OUTPUT,
  OFFLINE_OUTPUT_DIRECTORY,
  OFFLINE_SOURCE,
} from '../../vite.offline.config';

describe('isolated live build targets', () => {
  it('creates one target-specific unreleased identity for local builds', () => {
    expect(evidenceBuildIdentity('local-mock', {})).toEqual({
      applicationVersion: LIVE_APPLICATION_VERSION,
      releaseSha: LOCAL_UNRELEASED_SHA,
      releaseStatus: 'unreleased',
      buildTarget: 'local-mock',
    });
    expect(evidenceBuildIdentity('static-preview', {}).buildTarget).toBe('static-preview');
    expect(evidenceBuildIdentity('offline', {}).buildTarget).toBe('offline');
  });

  it('uses and validates the exact source identity supplied by CI', () => {
    const sha = 'a'.repeat(40);
    const cleanSource = { head: sha, clean: true };
    expect(
      evidenceBuildIdentity('mock-staging', { M34_EXPECTED_SOURCE_HEAD: sha }, cleanSource),
    ).toEqual({
      applicationVersion: LIVE_APPLICATION_VERSION,
      releaseSha: sha,
      releaseStatus: 'unreleased',
      buildTarget: 'mock-staging',
    });
    expect(
      evidenceBuildIdentity('production', { GITHUB_SHA: sha.toUpperCase() }, cleanSource)
        .releaseSha,
    ).toBe(sha);
    expect(() => evidenceBuildIdentity('production', { GITHUB_SHA: 'short' })).toThrow(
      'GITHUB_SHA must be a full 40-character Git SHA.',
    );
    expect(() =>
      evidenceBuildIdentity(
        'production',
        {
          GITHUB_SHA: 'a'.repeat(40),
          M34_EXPECTED_SOURCE_HEAD: 'b'.repeat(40),
        },
        cleanSource,
      ),
    ).toThrow('identify different source revisions');
    expect(() =>
      evidenceBuildIdentity('production', { GITHUB_SHA: sha }, { head: sha, clean: false }),
    ).toThrow('dirty working tree');
    expect(() =>
      evidenceBuildIdentity(
        'production',
        { GITHUB_SHA: sha },
        {
          head: 'b'.repeat(40),
          clean: true,
        },
      ),
    ).toThrow('does not match the checked-out HEAD');
  });

  it('serves only a local development mock', () => {
    expect(liveBuildOptions('serve', 'development')).toMatchObject({
      target: 'local-mock',
      synthetic: true,
      providerMode: 'mock',
      mockDevOnly: true,
      workerMain: './tests/support/guardedAirspaceWorker.ts',
      mockMain: './tests/support/guardedMockProvider.ts',
    });
  });
  it('builds a deployable mock service only for explicit mock staging', () => {
    expect(liveBuildOptions('build', 'mock-staging')).toMatchObject({
      target: 'mock-staging',
      synthetic: true,
      providerMode: 'mock',
      mockDevOnly: false,
      outDir: 'dist-mock-staging',
      workerMain: './worker/index.ts',
      mockMain: './tests/support/mockProvider.ts',
    });
  });
  it('keeps public production disabled and free of mock service selection', () => {
    expect(liveBuildOptions('build', 'production')).toMatchObject({
      target: 'production',
      synthetic: false,
      providerMode: 'disabled',
      outDir: 'dist-live',
      workerMain: './worker/index.ts',
    });
  });
  it.each([
    ['serve', 'production'],
    ['serve', 'mock-staging'],
    ['build', 'development'],
    ['build', 'local-mock'],
    ['build', 'live-staging'],
    ['build', 'unknown'],
  ] as const)('rejects implicit or unsupported targets: %s %s', (command, mode) => {
    expect(() => liveBuildOptions(command, mode)).toThrow();
  });

  it('keeps rollback assembly outside the Live build inputs', () => {
    expect(LIVE_CLIENT_INPUTS).toEqual({ index: 'index.html', live: 'live.html' });
    expect(Object.values(LIVE_CLIENT_INPUTS)).not.toContain('v2.html');
  });

  it('requires the final whole-tree build wrapper and rejects watch mode', () => {
    expect(() => assertLiveBuildInvocation('build', {})).toThrow(/whole-tree verification/u);
    expect(() =>
      assertLiveBuildInvocation('build', { [LIVE_BUILD_WRAPPER_ENV]: '1' }),
    ).not.toThrow();
    expect(() =>
      assertLiveBuildInvocation('build', { [LIVE_BUILD_WRAPPER_ENV]: '1' }, true),
    ).toThrow(/watch builds are unsupported/u);
    expect(() => assertLiveBuildInvocation('serve', {}, true)).not.toThrow();
  });

  it('uses the standalone React entry and renderer-free map replacement offline', async () => {
    expect(OFFLINE_SOURCE).toBe('offline.html');
    expect(OFFLINE_OUTPUT_DIRECTORY).toBe('dist-offline');
    expect(OFFLINE_OUTPUT).toBe('index.html');
    expect(OFFLINE_AIRSPACE_MAP_IMPORT).toBe('./AirspaceMap');
    expect(OFFLINE_AIRSPACE_MAP_STUB.replaceAll('\\', '/')).toMatch(
      /src\/features\/offline\/OfflineAirspaceMap\.tsx$/u,
    );
    expect(OFFLINE_FORBIDDEN_RUNTIME_TOKENS).toContain('/api/v1/health');
    expect(OFFLINE_FORBIDDEN_RUNTIME_TOKENS).toContain('/api/v1/operations');
    expect(OFFLINE_FORBIDDEN_RUNTIME_TOKENS).toContain('/map-assets/');

    const html = await readFile(resolve(OFFLINE_SOURCE), 'utf8');
    expect(html).toContain('/src/offline-main.tsx');
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain('worker-src blob: data:');
    expect(html).not.toContain('/src/live-main.tsx');
    expect(html).not.toContain('/src/main.ts');
    expect(html).not.toContain('v2.html');
  });

  it('keeps transformed dev assets on Vite while API and map routes stay Worker-first', async () => {
    const configuration = await readFile(resolve('wrangler.jsonc'), 'utf8');
    const redirects = await readFile(resolve('public/_redirects'), 'utf8');
    expect(configuration).toContain('"html_handling": "none"');
    expect(configuration).toContain('"not_found_handling": "none"');
    expect(configuration).toContain('"run_worker_first": ["/api/v1/*", "/map-assets/*"]');
    expect(redirects).toBe(
      '/ /index.html 200\n/Aviation-Dashboard-Project/ /Aviation-Dashboard-Project/index.html 200\n',
    );
  });
});
