import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { layers, namedFlavor } from '@protomaps/basemaps';
import { PMTiles } from 'pmtiles';
import { format, resolveConfig } from 'prettier';
import recipe from '../../maps/recipe.json';
import { resolveMapPreparationLayout } from './cliRelease';

const root = resolve('.');
const output = join(root, '.map-data', recipe.id);
async function writeJson(relativePath: string, value: unknown): Promise<void> {
  const filepath = join(root, relativePath);
  await writeFile(
    filepath,
    await format(JSON.stringify(value, null, 2), {
      ...(await resolveConfig(filepath)),
      filepath,
      parser: 'json',
    }),
  );
}
const { assetsRoot } = resolveMapPreparationLayout(root, process.platform, process.arch);
const sources = join(assetsRoot, `basemaps-assets-${recipe.assetsCommit}`);
const archivePath = join(output, 'basemap.pmtiles');
const archiveFile = await open(archivePath, 'r');
const archive = new PMTiles({
  getKey: () => archivePath,
  async getBytes(offset, length) {
    assert(length <= 1024 * 1024, 'Metadata read exceeds the preparation limit.');
    const data = new Uint8Array(length);
    const result = await archiveFile.read(data, 0, length, offset);
    assert.equal(result.bytesRead, length);
    return { data: data.buffer };
  },
});
const header = await archive.getHeader();
const metadata = (await archive.getMetadata()) as Record<string, unknown>;
await archiveFile.close();
assert.equal(header.minZoom, 0);
assert.equal(header.maxZoom, recipe.maxZoom);
assert.deepEqual([header.minLon, header.minLat, header.maxLon, header.maxLat], recipe.bounds);
assert.equal(metadata.version, recipe.source.tilesetVersion);

interface Asset {
  path: string;
  bytes: number;
  sha256: string;
  contentType: string;
}
const assets: Asset[] = [];
async function hashFile(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function record(path: string, contentType: string) {
  const file = join(output, path);
  assets.push({ path, bytes: (await stat(file)).size, sha256: await hashFile(file), contentType });
}
async function copy(path: string, contentType: string) {
  const file = join(output, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, await readFile(join(sources, path)));
  await record(path, contentType);
}
await record('basemap.pmtiles', 'application/octet-stream');
for (const font of ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic']) {
  const directory = `fonts/${font}`;
  const files = await readdir(join(sources, directory));
  assert.equal(files.filter((file) => file.endsWith('.pbf')).length, 256);
  for (const name of files.sort()) {
    if (/^\d+-\d+\.pbf$/.test(name)) await copy(`${directory}/${name}`, 'application/x-protobuf');
  }
}
await copy('fonts/OFL.txt', 'text/plain; charset=utf-8');
for (const suffix of ['.json', '.png', '@2x.json', '@2x.png']) {
  await copy(
    `sprites/v4/light${suffix}`,
    suffix.endsWith('.json') ? 'application/json' : 'image/png',
  );
}
for (const name of ['LICENSE.md', 'LICENSE_DATA.md']) {
  const response = await fetch(
    `https://raw.githubusercontent.com/protomaps/basemaps/${recipe.styleCommit}/${name}`,
    { signal: AbortSignal.timeout(15_000) },
  );
  assert(response.ok, 'Could not obtain the pinned basemap license.');
  const text = await response.text();
  assert(Buffer.byteLength(text) <= 32 * 1024);
  const path = `licenses/${basename(name)}`;
  await mkdir(join(output, 'licenses'), { recursive: true });
  await writeFile(join(output, path), text);
  await record(path, 'text/plain; charset=utf-8');
}
const style = {
  version: 8,
  name: 'Georgia observation basemap',
  metadata: {
    'workbench:map-id': recipe.id,
    'workbench:style-version': recipe.styleVersion,
    'workbench:changes': 'Regional bounds, local assets and aircraft observation overlays.',
  },
  sources: {},
  layers: layers('basemap', namedFlavor('light'), { lang: 'en' }),
};
await writeJson('maps/style.json', style);
const manifest = {
  schemaVersion: 'map-assets.v1',
  ...recipe,
  osmReplicationTime: metadata['planetiler:osm:osmosisreplicationtime'],
  sourceHashNote:
    'The planet BLAKE3 is provider-reported, not locally verified by a partial extract.',
  archive: {
    addressedTiles: header.numAddressedTiles,
    tileEntries: header.numTileEntries,
    tileContents: header.numTileContents,
    clustered: header.clustered,
  },
  totalBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
  assets: assets.sort((left, right) => left.path.localeCompare(right.path, 'en')),
};
await writeJson('maps/manifest.json', manifest);
console.log(
  `Map manifest ready: ${assets.length} local assets, ${manifest.totalBytes.toLocaleString('en-US')} bytes. Archive SHA-256 ${assets.find((asset) => asset.path === 'basemap.pmtiles')!.sha256}. No upload.`,
);
