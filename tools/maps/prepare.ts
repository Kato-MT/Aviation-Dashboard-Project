import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { unzipSync } from 'fflate';
import recipe from '../../maps/recipe.json';

const root = resolve('.');
const cache = join(root, '.tmp-tests/map-preparation');
const output = join(root, '.map-data', recipe.id);
const ceiling = 256 * 1024 * 1024;
await mkdir(cache, { recursive: true });
await mkdir(output, { recursive: true });
assert.equal(process.platform, 'win32', 'This pinned CLI bootstrap currently supports Windows.');
assert.equal(process.arch, 'x64', 'This pinned CLI bootstrap currently supports x64.');
assert.equal(recipe.cliVersion, '1.31.2');
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

const cliZip = await download(
  'https://github.com/protomaps/go-pmtiles/releases/download/v1.31.2/go-pmtiles_1.31.2_Windows_x86_64.zip',
  join(cache, 'pmtiles-1.31.2-windows-x64.zip'),
  24 * 1024 * 1024,
);
assert.equal(
  createHash('sha256').update(cliZip).digest('hex'),
  'a658baa4d7e55020aef6ca17bd9ff9faa1582671266b36f58c52db0ac8e785a1',
  'CLI archive does not match its published release digest.',
);
const cliDirectory = join(cache, 'pmtiles-1.31.2');
await extractZip(cliZip, cliDirectory);
const cli = join(cliDirectory, 'pmtiles.exe');

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
await extractZip(assetsZip, join(cache, 'assets'));
console.log('Regional archive and pinned font/sprite sources ready. Nothing was uploaded.');
