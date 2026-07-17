/* global console, process */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const releaseDirectory = resolve(repositoryRoot, 'release');
const releaseVersion = process.argv[2] || '';
const includeExpandedEvidence = /^v?2\.1\./.test(releaseVersion);

function findFiles(root, predicate) {
  if (!existsSync(root)) {
    return [];
  }
  if (statSync(root).isFile()) {
    return predicate(root) ? [root] : [];
  }
  return readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const child = resolve(root, entry.name);
      return entry.isDirectory() ? findFiles(child, predicate) : predicate(child) ? [child] : [];
    });
}

function copyRequired(source, destinationName) {
  if (!existsSync(source)) {
    throw new Error(`Required release input is missing: ${source}`);
  }
  copyFileSync(source, resolve(releaseDirectory, destinationName));
}

function copyOptional(source, destinationName = basename(source)) {
  if (existsSync(source)) {
    copyFileSync(source, resolve(releaseDirectory, destinationName));
  }
}

rmSync(releaseDirectory, { force: true, recursive: true });
mkdirSync(releaseDirectory, { recursive: true });

const pagesDirectory = resolve(repositoryRoot, 'dist');
if (!existsSync(resolve(pagesDirectory, 'index.html'))) {
  throw new Error('The normal production build is missing dist/index.html');
}

const preferredOfflineArtifact = resolve(repositoryRoot, 'dist-offline', 'index.html');
const offlineCandidates = [
  ...(existsSync(preferredOfflineArtifact) ? [preferredOfflineArtifact] : []),
  ...findFiles(
    resolve(repositoryRoot, 'dist-offline'),
    (path) => path.endsWith('.html') && path !== preferredOfflineArtifact,
  ),
  ...findFiles(resolve(repositoryRoot, 'dist-offline.html'), (path) => path.endsWith('.html')),
];
if (offlineCandidates.length === 0) {
  throw new Error('The offline build did not produce an HTML artifact');
}
copyFileSync(offlineCandidates[0], resolve(releaseDirectory, 'flight-diagnostics-workbench.html'));

copyRequired(resolve(repositoryRoot, 'requirements', 'traceability.md'), 'traceability-report.md');
copyRequired(
  resolve(repositoryRoot, 'requirements', 'traceability.json'),
  'traceability-report.json',
);
copyRequired(
  resolve(repositoryRoot, 'docs', 'release-verification.md'),
  'release-verification-template.md',
);
copyOptional(
  resolve(repositoryRoot, 'artifacts', 'verification-report.json'),
  'verification-report.json',
);
copyOptional(resolve(repositoryRoot, 'artifacts', 'sbom.cdx.json'), 'sbom.cdx.json');
copyOptional(resolve(repositoryRoot, 'dist', 'sbom.cdx.json'), 'sbom.cdx.json');
if (includeExpandedEvidence) {
  copyOptional(resolve(repositoryRoot, 'artifacts', 'benchmark-report.json'));
  copyOptional(resolve(repositoryRoot, 'artifacts', 'model-card.md'));
  copyOptional(resolve(repositoryRoot, 'benchmark', 'latest.json'), 'benchmark-report.json');
  copyOptional(resolve(repositoryRoot, 'models', 'MODEL_CARD.md'), 'model-card.md');
  copyOptional(resolve(repositoryRoot, 'models', 'evaluation_v1.json'), 'model-evaluation.json');
  copyOptional(
    resolve(repositoryRoot, 'models', 'robust_covariance_v1.json'),
    'robust-covariance-model-v1.json',
  );
  copyOptional(
    resolve(repositoryRoot, 'models', 'inference_parity_v1.json'),
    'inference-parity-vector-v1.json',
  );
  copyOptional(
    resolve(repositoryRoot, 'analytics', 'latest-report.md'),
    'verification-history-analytics.md',
  );
  copyOptional(
    resolve(repositoryRoot, 'docs', 'screenshots', 'workbench-diagnostics.png'),
    'workbench-diagnostics.png',
  );
  copyOptional(
    resolve(repositoryRoot, 'docs', 'screenshots', 'workbench-configuration.png'),
    'workbench-configuration.png',
  );
}
copyOptional(
  resolve(repositoryRoot, 'docs', 'screenshots', 'workbench-desktop.png'),
  'workbench-desktop.png',
);
copyOptional(
  resolve(repositoryRoot, 'docs', 'screenshots', 'workbench-mobile.png'),
  'workbench-mobile.png',
);

console.log(`release: assembled artifacts in ${releaseDirectory}`);
