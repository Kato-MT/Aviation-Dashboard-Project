/* global console, process */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const releaseDirectory = resolve(repositoryRoot, process.argv[2] || 'release');
const releaseVersion = process.argv[3] || '';
const checksumPath = resolve(releaseDirectory, 'checksums.sha256');
const required = [
  'pages-build.tar.gz',
  'flight-diagnostics-workbench.html',
  'traceability-report.md',
  'traceability-report.json',
  'release-verification-template.md',
  'verification-report.json',
  'sbom.cdx.json',
  'workbench-desktop.png',
  'workbench-mobile.png',
  'checksums.sha256',
];
if (/^v?2\.1\./.test(releaseVersion)) {
  required.push(
    'benchmark-report.json',
    'model-card.md',
    'model-evaluation.json',
    'robust-covariance-model-v1.json',
    'inference-parity-vector-v1.json',
    'verification-history-analytics.md',
    'workbench-diagnostics.png',
    'workbench-configuration.png',
  );
}
const errors = [];

for (const name of required) {
  const path = resolve(releaseDirectory, name);
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
    errors.push(`missing or empty required artifact: ${name}`);
  }
}

if (existsSync(checksumPath)) {
  const lines = readFileSync(checksumPath, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    if (!match) {
      errors.push(`invalid checksum line: ${line}`);
      continue;
    }
    const [, expected, relativePath] = match;
    const path = resolve(releaseDirectory, relativePath);
    const pathWithinRelease = relative(releaseDirectory, path);
    if (pathWithinRelease.startsWith('..') || isAbsolute(pathWithinRelease)) {
      errors.push(`checksum path escapes release directory: ${relativePath}`);
      continue;
    }
    if (!existsSync(path)) {
      errors.push(`checksum references missing file: ${relativePath}`);
      continue;
    }
    const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (actual !== expected) {
      errors.push(`checksum mismatch: ${relativePath}`);
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`release: ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log('release: required artifacts and SHA-256 checksums verified');
}
