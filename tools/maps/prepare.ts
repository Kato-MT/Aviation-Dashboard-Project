import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { unzipSync } from 'fflate';
import recipe from '../../maps/recipe.json';
import { resolveMapPreparationLayout, selectPmtilesCliRelease } from './cliRelease';

const root = resolve('.');
const cliRelease = selectPmtilesCliRelease(process.platform, process.arch);
const { cacheRoot: cache, assetsRoot } = resolveMapPreparationLayout(
  root,
  process.platform,
  process.arch,
);
const output = join(root, '.map-data', recipe.id);
const ceiling = 256 * 1024 * 1024;
await mkdir(cache, { recursive: true });
await mkdir(output, { recursive: true });
assert.equal(recipe.cliVersion, cliRelease.version);
assert.equal(recipe.maxZoom, 12);
assert.match(recipe.source.url, /^https:\/\/build\.protomaps\.com\/\d{8}\.pmtiles$/);

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function download(url: string, target: string, maximum: number): Promise<Buffer> {
  if (await exists(target)) {
    const cached = await readFile(target);
    assert(cached.length <= maximum);
    return cached;
  }
  console.log('Downloading pinned dependency: ' + new URL(url).hostname);
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  assert(response.ok && response.body, `Download failed: HTTP ${response.status}`);
  assert(Number(response.headers.get('content-length') ?? 0) <= maximum);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      assert(length <= maximum, 'Dependency exceeded the streamed byte ceiling.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks);
  await writeFile(target, bytes, { flag: 'wx' });
  return bytes;
}

async function extractZip(bytes: Uint8Array, directory: string) {
  const allowedRoot = resolve(directory) + sep;
  assert(allowedRoot.startsWith(cache + sep));
  let expanded = 0;
  const files = unzipSync(bytes, {
    filter(entry) {
      const path = resolve(directory, entry.name);
      assert(path.startsWith(allowedRoot), 'Archive entry escapes its task cache.');
      expanded += entry.originalSize;
      assert(expanded <= 128 * 1024 * 1024, 'Archive expansion exceeds 128 MiB.');
      return !entry.name.endsWith('/');
    },
  });
  for (const [name, data] of Object.entries(files)) {
    const path = resolve(directory, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }
}

const tarStdoutCeiling = 64 * 1024 * 1024;
const tarStderrCeiling = 1024 * 1024;

async function extractPinnedLinuxExecutable(
  archivePath: string,
  target: string,
  expectedBytes: number,
  expectedSha256: string,
): Promise<void> {
  const executable = await new Promise<Buffer>((resolveExtraction, rejectExtraction) => {
    const child = spawn('tar', ['-xOzf', archivePath, '--', 'pmtiles'], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let extractionError: Error | undefined;
    let settled = false;
    let killEscalation: NodeJS.Timeout | undefined;

    const cleanup = () => {
      clearTimeout(timeout);
      if (killEscalation) clearTimeout(killEscalation);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) rejectExtraction(error);
      else resolveExtraction(Buffer.concat(stdoutChunks, stdoutBytes));
    };
    const stop = (error: Error) => {
      if (extractionError) return;
      extractionError = error;
      child.kill();
      killEscalation = setTimeout(() => child.kill('SIGKILL'), 1_000);
    };
    const timeout = setTimeout(
      () => stop(new Error('PMTiles CLI extraction exceeded its two-minute deadline.')),
      120_000,
    );

    child.stdout.on('data', (chunk: Buffer) => {
      if (extractionError) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > tarStdoutCeiling) {
        stop(new Error('PMTiles CLI extraction exceeded its 64 MiB stdout ceiling.'));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (extractionError) return;
      stderrBytes += chunk.byteLength;
      if (stderrBytes > tarStderrCeiling) {
        stop(new Error('PMTiles CLI extraction exceeded its 1 MiB stderr ceiling.'));
        return;
      }
      stderrChunks.push(chunk);
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (extractionError) {
        finish(extractionError);
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks, stderrBytes).toString('utf8').trim();
        finish(new Error(`tar exited with ${code}${stderr ? `: ${stderr}` : '.'}`));
        return;
      }
      finish();
    });
  });

  assert.equal(executable.byteLength, expectedBytes, 'CLI executable has an unexpected byte size.');
  assert.equal(
    createHash('sha256').update(executable).digest('hex'),
    expectedSha256,
    'CLI executable does not match its pinned digest.',
  );

  await mkdir(dirname(target), { recursive: true });
  const partial = `${target}.${crypto.randomUUID()}.partial`;
  try {
    await writeFile(partial, executable, { flag: 'wx', mode: 0o755 });
    await chmod(partial, 0o755);
    await rename(partial, target);
  } finally {
    await rm(partial, { force: true });
  }
  await chmod(target, 0o755);
}

const cliArchivePath = join(cache, cliRelease.archiveFileName);
const cliArchive = await download(
  cliRelease.archiveUrl,
  cliArchivePath,
  cliRelease.archiveMaximumBytes,
);
assert.equal(
  createHash('sha256').update(cliArchive).digest('hex'),
  cliRelease.archiveSha256,
  'CLI archive does not match its published release digest.',
);
const cliDirectory = join(cache, `pmtiles-${cliRelease.version}`);
const cli = join(cliDirectory, cliRelease.executableName);
if (cliRelease.archiveFormat === 'zip') {
  await extractZip(cliArchive, cliDirectory);
} else {
  await extractPinnedLinuxExecutable(
    cliArchivePath,
    cli,
    cliRelease.executableBytes,
    cliRelease.executableSha256,
  );
}

async function runCli(args: string[], boundedOutput?: string) {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(cli, args, { stdio: 'inherit', windowsHide: true });
    let limitError: Error | undefined;
    const timeout = setTimeout(() => {
      limitError = new Error('Map preparation exceeded its fifteen-minute deadline.');
      child.kill();
    }, 15 * 60_000);
    const sizeCheck = setInterval(() => {
      if (!boundedOutput) return;
      void stat(boundedOutput).then(
        (value) => {
          if (value.size > ceiling) {
            limitError = new Error('Regional extraction exceeded its 256 MiB output ceiling.');
            child.kill();
          }
        },
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') {
            limitError = error;
            child.kill();
          }
        },
      );
    }, 1_000);
    const cleanup = () => {
      clearTimeout(timeout);
      clearInterval(sizeCheck);
    };
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (code) => {
      cleanup();
      if (limitError) reject(limitError);
      else if (code !== 0) reject(new Error(`pmtiles exited with ${code}.`));
      else resolveRun();
    });
  });
}

await runCli(['version']);
const archive = join(output, 'basemap.pmtiles');
if (!(await exists(archive))) {
  const partial = join(output, `extract-${crypto.randomUUID()}.partial.pmtiles`);
  console.log('Extracting only the Georgia bounds, zooms 0-12, not the planet archive.');
  await runCli(
    [
      'extract',
      recipe.source.url,
      partial,
      `--bbox=${recipe.bounds.join(',')}`,
      '--maxzoom=12',
      '--download-threads=4',
      '--overfetch=0.05',
    ],
    partial,
  );
  assert((await stat(partial)).size <= ceiling);
  await runCli(['verify', partial]);
  await rename(partial, archive);
}
await runCli(['verify', archive]);
await runCli(['show', archive]);
const assetsZip = await download(
  `https://codeload.github.com/protomaps/basemaps-assets/zip/${recipe.assetsCommit}`,
  join(cache, `basemaps-assets-${recipe.assetsCommit}.zip`),
  32 * 1024 * 1024,
);
await extractZip(assetsZip, assetsRoot);
console.log('Regional archive and pinned font/sprite sources ready. Nothing was uploaded.');
