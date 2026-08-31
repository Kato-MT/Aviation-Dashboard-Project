import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PMTILES_CLI_VERSION,
  resolveMapPreparationLayout,
  selectPmtilesCliRelease,
} from '../../tools/maps/cliRelease';

describe('pinned PMTiles CLI release selection', () => {
  it('preserves the published Windows x64 ZIP release', () => {
    expect(selectPmtilesCliRelease('win32', 'x64')).toEqual({
      version: PMTILES_CLI_VERSION,
      platform: 'win32',
      architecture: 'x64',
      cacheQualifier: 'win32-x64',
      archiveFormat: 'zip',
      archiveFileName: 'pmtiles-1.31.2-windows-x64.zip',
      archiveUrl:
        'https://github.com/protomaps/go-pmtiles/releases/download/v1.31.2/go-pmtiles_1.31.2_Windows_x86_64.zip',
      archiveSha256: 'a658baa4d7e55020aef6ca17bd9ff9faa1582671266b36f58c52db0ac8e785a1',
      archiveMaximumBytes: 24 * 1024 * 1024,
      executableName: 'pmtiles.exe',
    });
  });

  it('selects the published Linux x64 tarball and its verified executable contract', () => {
    expect(selectPmtilesCliRelease('linux', 'x64')).toEqual({
      version: PMTILES_CLI_VERSION,
      platform: 'linux',
      architecture: 'x64',
      cacheQualifier: 'linux-x64',
      archiveFormat: 'tar.gz',
      archiveFileName: 'pmtiles-1.31.2-linux-x64.tar.gz',
      archiveUrl:
        'https://github.com/protomaps/go-pmtiles/releases/download/v1.31.2/go-pmtiles_1.31.2_Linux_x86_64.tar.gz',
      archiveSha256: '3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f',
      archiveMaximumBytes: 24 * 1024 * 1024,
      executableName: 'pmtiles',
      executableBytes: 57_688_226,
      executableSha256: 'a7e9ae10184d109c83f456ccdf6df4f3e2a64ba6cf69d9ed0f9f1840305055c1',
    });
  });

  it.each([
    ['darwin', 'x64'],
    ['linux', 'arm64'],
    ['win32', 'arm64'],
    ['freebsd', 'x64'],
  ])('fails closed for unsupported host %s/%s', (platform, architecture) => {
    expect(() => selectPmtilesCliRelease(platform, architecture)).toThrow(
      `Unsupported PMTiles CLI host ${platform}/${architecture}. Expected win32/x64 or linux/x64.`,
    );
  });

  it.each([
    ['win32', 'x64', 'win32-x64'],
    ['linux', 'x64', 'linux-x64'],
  ])(
    'resolves one shared host-qualified preparation layout for %s/%s',
    (platform, architecture, cacheQualifier) => {
      const root = resolve('fixture-map-root');
      const cacheRoot = join(root, '.tmp-tests', 'map-preparation', cacheQualifier);
      expect(resolveMapPreparationLayout(root, platform, architecture)).toEqual({
        cacheRoot,
        assetsRoot: join(cacheRoot, 'assets'),
      });
    },
  );

  it('binds both preparation and manifest generation to the shared layout helper', async () => {
    const [prepare, manifest] = await Promise.all([
      readFile(resolve('tools/maps/prepare.ts'), 'utf8'),
      readFile(resolve('tools/maps/manifest.ts'), 'utf8'),
    ]);
    expect(prepare).toContain('resolveMapPreparationLayout(');
    expect(prepare).toContain('await extractZip(assetsZip, assetsRoot)');
    expect(manifest).toContain('resolveMapPreparationLayout(');
    expect(manifest).toContain('join(assetsRoot, `basemaps-assets-${recipe.assetsCommit}`)');
    expect(manifest).not.toContain("'.tmp-tests/map-preparation/assets'");
  });
});
