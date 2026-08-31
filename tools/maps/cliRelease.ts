export const PMTILES_CLI_VERSION = '1.31.2' as const;

interface PmtilesCliReleaseBase {
  readonly version: typeof PMTILES_CLI_VERSION;
  readonly platform: 'win32' | 'linux';
  readonly architecture: 'x64';
  readonly cacheQualifier: 'win32-x64' | 'linux-x64';
  readonly archiveFileName: string;
  readonly archiveUrl: string;
  readonly archiveSha256: string;
  readonly archiveMaximumBytes: number;
}

export interface PmtilesWindowsCliRelease extends PmtilesCliReleaseBase {
  readonly platform: 'win32';
  readonly cacheQualifier: 'win32-x64';
  readonly archiveFormat: 'zip';
  readonly executableName: 'pmtiles.exe';
}

export interface PmtilesLinuxCliRelease extends PmtilesCliReleaseBase {
  readonly platform: 'linux';
  readonly cacheQualifier: 'linux-x64';
  readonly archiveFormat: 'tar.gz';
  readonly executableName: 'pmtiles';
  readonly executableBytes: 57_688_226;
  readonly executableSha256: 'a7e9ae10184d109c83f456ccdf6df4f3e2a64ba6cf69d9ed0f9f1840305055c1';
}

export type PmtilesCliRelease = PmtilesWindowsCliRelease | PmtilesLinuxCliRelease;

const archiveMaximumBytes = 24 * 1024 * 1024;

const windowsX64Release: PmtilesWindowsCliRelease = {
  version: PMTILES_CLI_VERSION,
  platform: 'win32',
  architecture: 'x64',
  cacheQualifier: 'win32-x64',
  archiveFormat: 'zip',
  archiveFileName: 'pmtiles-1.31.2-windows-x64.zip',
  archiveUrl:
    'https://github.com/protomaps/go-pmtiles/releases/download/v1.31.2/go-pmtiles_1.31.2_Windows_x86_64.zip',
  archiveSha256: 'a658baa4d7e55020aef6ca17bd9ff9faa1582671266b36f58c52db0ac8e785a1',
  archiveMaximumBytes,
  executableName: 'pmtiles.exe',
};

const linuxX64Release: PmtilesLinuxCliRelease = {
  version: PMTILES_CLI_VERSION,
  platform: 'linux',
  architecture: 'x64',
  cacheQualifier: 'linux-x64',
  archiveFormat: 'tar.gz',
  archiveFileName: 'pmtiles-1.31.2-linux-x64.tar.gz',
  archiveUrl:
    'https://github.com/protomaps/go-pmtiles/releases/download/v1.31.2/go-pmtiles_1.31.2_Linux_x86_64.tar.gz',
  archiveSha256: '3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f',
  archiveMaximumBytes,
  executableName: 'pmtiles',
  executableBytes: 57_688_226,
  executableSha256: 'a7e9ae10184d109c83f456ccdf6df4f3e2a64ba6cf69d9ed0f9f1840305055c1',
};

export function selectPmtilesCliRelease(platform: string, architecture: string): PmtilesCliRelease {
  if (platform === 'win32' && architecture === 'x64') return windowsX64Release;
  if (platform === 'linux' && architecture === 'x64') return linuxX64Release;
  throw new Error(
    `Unsupported PMTiles CLI host ${platform}/${architecture}. Expected win32/x64 or linux/x64.`,
  );
}
