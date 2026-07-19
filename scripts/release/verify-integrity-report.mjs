/* global console, process */

import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const requestedPath = process.argv[2];

if (!requestedPath) {
  throw new Error('Usage: node scripts/release/verify-integrity-report.mjs <report.json>');
}

const reportPath = resolve(repositoryRoot, requestedPath);
const pathWithinRepository = relative(repositoryRoot, reportPath);
if (pathWithinRepository.startsWith('..') || isAbsolute(pathWithinRepository)) {
  throw new Error(`Integrity report must stay inside the repository: ${requestedPath}`);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8').replace(/^\uFEFF/, ''));
const integrity = Array.isArray(report.integrity) ? report.integrity : [];
const foreignKeyViolations = Array.isArray(report.foreignKeyViolations)
  ? report.foreignKeyViolations
  : undefined;

if (
  report.ok !== true ||
  integrity.length !== 1 ||
  integrity[0] !== 'ok' ||
  foreignKeyViolations === undefined ||
  foreignKeyViolations.length !== 0
) {
  throw new Error(`SQLite integrity evidence failed: ${JSON.stringify(report)}`);
}

console.log(`integrity: verified SQLite and foreign keys in ${pathWithinRepository}`);
