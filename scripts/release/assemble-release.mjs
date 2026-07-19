/* global console, process */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const releaseDirectory = resolve(repositoryRoot, 'release');
const packageDocument = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'));
const releaseVersion = process.argv[2] || `v${packageDocument.version}`;
const normalizedReleaseVersion = releaseVersion.replace(/^v/, '');
const includeExpandedEvidence = /^v?2\.(?:1|2)\./.test(releaseVersion);
const includeTemporalEvidence = /^v?2\.2\./.test(releaseVersion);

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

const copyPlan = [];

function copyRequired(source, destinationName) {
  if (!existsSync(source) || !statSync(source).isFile() || statSync(source).size === 0) {
    throw new Error(`Required release input is missing: ${source}`);
  }
  const destination = resolve(releaseDirectory, destinationName);
  if (copyPlan.some((item) => item.destination === destination)) {
    throw new Error(`Duplicate release destination: ${destinationName}`);
  }
  copyPlan.push({ source, destination });
}

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
copyRequired(offlineCandidates[0], 'flight-diagnostics-workbench.html');

copyRequired(resolve(repositoryRoot, 'requirements', 'traceability.md'), 'traceability-report.md');
copyRequired(
  resolve(repositoryRoot, 'requirements', 'traceability.json'),
  'traceability-report.json',
);
copyRequired(
  resolve(repositoryRoot, 'docs', 'release-verification.md'),
  'release-verification-template.md',
);
copyRequired(
  resolve(repositoryRoot, 'artifacts', 'verification-report.json'),
  'verification-report.json',
);
copyRequired(resolve(repositoryRoot, 'dist', 'sbom.cdx.json'), 'sbom.cdx.json');
if (includeExpandedEvidence) {
  copyRequired(resolve(repositoryRoot, 'benchmark', 'latest.json'), 'benchmark-report.json');
  copyRequired(resolve(repositoryRoot, 'models', 'MODEL_CARD.md'), 'model-card.md');
  copyRequired(resolve(repositoryRoot, 'models', 'evaluation_v1.json'), 'model-evaluation.json');
  copyRequired(
    resolve(repositoryRoot, 'models', 'robust_covariance_v1.json'),
    'robust-covariance-model-v1.json',
  );
  copyRequired(
    resolve(repositoryRoot, 'models', 'inference_parity_v1.json'),
    'inference-parity-vector-v1.json',
  );
  copyRequired(
    resolve(repositoryRoot, 'analytics', 'latest-report.md'),
    'verification-history-analytics.md',
  );
  copyRequired(
    resolve(repositoryRoot, 'docs', 'screenshots', 'workbench-diagnostics.png'),
    'workbench-diagnostics.png',
  );
  copyRequired(
    resolve(repositoryRoot, 'docs', 'screenshots', 'workbench-configuration.png'),
    'workbench-configuration.png',
  );
}
if (includeTemporalEvidence) {
  copyRequired(
    resolve(repositoryRoot, 'benchmark', 'temporal-latest.json'),
    'temporal-benchmark-report.json',
  );
  copyRequired(
    resolve(repositoryRoot, 'docs', 'benchmarks-temporal.md'),
    'temporal-benchmark-report.md',
  );
  copyRequired(
    resolve(repositoryRoot, 'models', 'temporal_fault_model_v1.json'),
    'temporal-fault-model-v1.json',
  );
  copyRequired(
    resolve(repositoryRoot, 'models', 'temporal_evaluation_v1.json'),
    'temporal-model-evaluation-v1.json',
  );
  copyRequired(
    resolve(repositoryRoot, 'models', 'temporal_inference_parity_v1.json'),
    'temporal-inference-parity-v1.json',
  );
  copyRequired(
    resolve(repositoryRoot, 'models', 'model_configuration_manifest_v1.json'),
    'model-configuration-manifest-v1.json',
  );
  copyRequired(
    resolve(repositoryRoot, 'models', 'TEMPORAL_MODEL_CARD.md'),
    'temporal-model-card.md',
  );
  copyRequired(
    resolve(repositoryRoot, 'models', 'temporal_fault_model_v2.json'),
    'temporal-fault-model-v2.json',
  );
  copyRequired(
    resolve(repositoryRoot, 'models', 'temporal_evaluation_v2.json'),
    'temporal-model-evaluation-v2.json',
  );
  copyRequired(
    resolve(repositoryRoot, 'models', 'temporal_inference_parity_v2.json'),
    'temporal-inference-parity-v2.json',
  );
  copyRequired(
    resolve(repositoryRoot, 'models', 'TEMPORAL_INTEGRATION_MODEL_CARD.md'),
    'temporal-integration-model-card-v2.md',
  );
  copyRequired(
    resolve(repositoryRoot, 'artifacts', 'temporal-campaign-report.json'),
    'temporal-campaign-report.json',
  );
  copyRequired(
    resolve(repositoryRoot, 'analytics', 'temporal-campaign-history.json'),
    'temporal-campaign-history.json',
  );
  copyRequired(
    resolve(repositoryRoot, 'analytics', 'temporal-campaign-integrity.json'),
    'temporal-campaign-integrity.json',
  );
  copyRequired(
    resolve(repositoryRoot, 'analytics', 'verification-history-integrity.json'),
    'verification-history-integrity.json',
  );
  copyRequired(
    resolve(repositoryRoot, 'docs', 'temporal-model-evidence.md'),
    'temporal-model-evidence.md',
  );
  copyRequired(
    resolve(repositoryRoot, 'docs', 'temporal-threat-model.md'),
    'temporal-threat-model.md',
  );
  copyRequired(
    resolve(repositoryRoot, 'docs', `release-notes-v${normalizedReleaseVersion}.md`),
    `release-notes-v${normalizedReleaseVersion}.md`,
  );
  copyRequired(
    resolve(repositoryRoot, 'docs', 'screenshots', 'workbench-investigation.png'),
    'workbench-investigation.png',
  );
  copyRequired(
    resolve(repositoryRoot, 'docs', 'screenshots', 'metadata.json'),
    'workbench-screenshot-metadata.json',
  );
}
copyRequired(
  resolve(repositoryRoot, 'docs', 'screenshots', 'workbench-desktop.png'),
  'workbench-desktop.png',
);
copyRequired(
  resolve(repositoryRoot, 'docs', 'screenshots', 'workbench-mobile.png'),
  'workbench-mobile.png',
);

rmSync(releaseDirectory, { force: true, recursive: true });
mkdirSync(releaseDirectory, { recursive: true });
for (const { source, destination } of copyPlan) {
  copyFileSync(source, destination);
}

console.log(`release: assembled artifacts in ${releaseDirectory}`);
