/* global console, process */

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const requirementsPath = resolve(repositoryRoot, 'requirements', 'requirements.md');
const testCasesPath = resolve(repositoryRoot, 'requirements', 'test-cases.md');
const matrixPath = resolve(repositoryRoot, 'requirements', 'traceability.json');
const requireEvidencePaths = process.argv.includes('--require-evidence-paths');
const selectedR3Areas = new Set([
  'live-airspace-operational-evidence',
  'live-airspace-runtime-release-policy',
]);

function collectIds(text, pattern) {
  return new Set([...text.matchAll(pattern)].map((match) => match[1]));
}

function fail(messages) {
  for (const message of messages) {
    console.error(`traceability: ${message}`);
  }
  process.exitCode = 1;
}

const requirementsText = readFileSync(requirementsPath, 'utf8');
const testCasesText = readFileSync(testCasesPath, 'utf8');
const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'));

const declaredRequirements = collectIds(requirementsText, /\|\s*(FDW-[A-Z]+-\d{3})\s*\|/g);
const declaredTests = collectIds(testCasesText, /\|\s*(TC-[A-Z0-9]+-\d{3})\s*\|/g);

const mappedRequirements = new Set();
const mappedTests = new Set();
const errors = [];

if (matrix.schemaVersion !== '1.0.0' || !Array.isArray(matrix.mappings)) {
  errors.push('traceability.json must use schemaVersion 1.0.0 and a mappings array');
} else {
  for (const [index, mapping] of matrix.mappings.entries()) {
    const label = mapping.area || `mapping ${index + 1}`;
    if (!Array.isArray(mapping.requirements) || mapping.requirements.length === 0) {
      errors.push(`${label} has no requirement IDs`);
      continue;
    }
    if (!Array.isArray(mapping.tests) || mapping.tests.length === 0) {
      errors.push(`${label} has no test IDs`);
    }
    if (!Array.isArray(mapping.evidencePaths) || mapping.evidencePaths.length === 0) {
      errors.push(`${label} has no evidence paths`);
    }

    for (const requirementId of mapping.requirements) {
      mappedRequirements.add(requirementId);
      if (!declaredRequirements.has(requirementId)) {
        errors.push(`${label} references unknown requirement ${requirementId}`);
      }
    }

    for (const testId of mapping.tests || []) {
      mappedTests.add(testId);
      if (!declaredTests.has(testId)) {
        errors.push(`${label} references unknown test ${testId}`);
      }
    }

    if (requireEvidencePaths) {
      const observedEvidencePaths = new Set();
      for (const evidencePath of mapping.evidencePaths || []) {
        if (
          typeof evidencePath !== 'string' ||
          evidencePath.length === 0 ||
          evidencePath.includes('\\') ||
          evidencePath.startsWith('/') ||
          evidencePath.endsWith('/') ||
          isAbsolute(evidencePath) ||
          evidencePath
            .split('/')
            .some((segment) => segment === '' || segment === '.' || segment === '..')
        ) {
          errors.push(`${label} has an invalid repository-relative evidence path: ${evidencePath}`);
          continue;
        }
        if (observedEvidencePaths.has(evidencePath)) {
          errors.push(`${label} has duplicate evidence path: ${evidencePath}`);
          continue;
        }
        observedEvidencePaths.add(evidencePath);
        const absolutePath = resolve(repositoryRoot, evidencePath);
        const relativePath = relative(repositoryRoot, absolutePath);
        if (
          relativePath === '' ||
          relativePath === '..' ||
          relativePath.startsWith(`..${sep}`) ||
          isAbsolute(relativePath)
        ) {
          errors.push(`${label} evidence path escapes the repository: ${evidencePath}`);
          continue;
        }
        if (!existsSync(absolutePath)) {
          errors.push(`${label} evidence path does not exist: ${evidencePath}`);
          continue;
        }
        const status = lstatSync(absolutePath);
        if (status.isSymbolicLink()) {
          errors.push(`${label} evidence path must not be a symbolic link: ${evidencePath}`);
          continue;
        }
        if (!status.isFile() && !status.isDirectory()) {
          errors.push(`${label} evidence path is not a regular file or directory: ${evidencePath}`);
          continue;
        }
        const realRoot = realpathSync(repositoryRoot);
        const realEvidencePath = realpathSync(absolutePath);
        const realRelative = relative(realRoot, realEvidencePath);
        if (
          realRelative === '..' ||
          realRelative.startsWith(`..${sep}`) ||
          isAbsolute(realRelative)
        ) {
          errors.push(`${label} evidence path resolves outside the repository: ${evidencePath}`);
          continue;
        }
        if (selectedR3Areas.has(label) && !status.isFile()) {
          errors.push(`${label} selected-R3 evidence path must be a regular file: ${evidencePath}`);
        }
      }
    }
  }
}

for (const requirementId of declaredRequirements) {
  if (!mappedRequirements.has(requirementId)) {
    errors.push(`unmapped requirement ${requirementId}`);
  }
}

for (const testId of declaredTests) {
  if (!mappedTests.has(testId)) {
    errors.push(`unmapped test ${testId}`);
  }
}

if (errors.length > 0) {
  fail(errors);
} else {
  console.log(
    `traceability: ${declaredRequirements.size} requirements mapped to ${mappedTests.size} declared tests across ${matrix.mappings.length} areas`,
  );
}
