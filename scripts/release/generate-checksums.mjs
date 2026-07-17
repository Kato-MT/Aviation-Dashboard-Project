/* global console, process */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const target = resolve(repositoryRoot, process.argv[2] || 'release');
const outputName = process.argv[3] || 'checksums.sha256';
const outputPath = resolve(target, outputName);

function walk(path) {
  if (statSync(path).isFile()) {
    return [path];
  }

  return readdirSync(path, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const child = resolve(path, entry.name);
      return entry.isDirectory() ? walk(child) : [child];
    });
}

const files = walk(target).filter((path) => resolve(path) !== outputPath);
const lines = files.map((path) => {
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  const displayPath = statSync(target).isFile()
    ? basename(path)
    : relative(target, path).replaceAll('\\', '/');
  return `${digest}  ${displayPath}`;
});

writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
console.log(`checksums: wrote ${lines.length} SHA-256 entries to ${outputPath}`);
