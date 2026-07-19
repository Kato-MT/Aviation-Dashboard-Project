/* global console, process */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const releaseDirectory = resolve(repositoryRoot, process.argv[2] || 'release');
const packageDocument = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'));
const releaseVersion = process.argv[3] || `v${packageDocument.version}`;
const normalizedReleaseVersion = releaseVersion.replace(/^v/, '');
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
if (/^v?2\.(?:1|2)\./.test(releaseVersion)) {
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
if (/^v?2\.2\./.test(releaseVersion)) {
  required.push(
    'temporal-benchmark-report.json',
    'temporal-benchmark-report.md',
    'temporal-fault-model-v1.json',
    'temporal-model-evaluation-v1.json',
    'temporal-inference-parity-v1.json',
    'model-configuration-manifest-v1.json',
    'temporal-model-card.md',
    'temporal-fault-model-v2.json',
    'temporal-model-evaluation-v2.json',
    'temporal-inference-parity-v2.json',
    'temporal-integration-model-card-v2.md',
    'temporal-campaign-report.json',
    'temporal-campaign-history.json',
    'temporal-model-evidence.md',
    'temporal-threat-model.md',
    `release-notes-v${normalizedReleaseVersion}.md`,
    'workbench-investigation.png',
    'workbench-screenshot-metadata.json',
    'temporal-campaign-integrity.json',
    'verification-history-integrity.json',
  );
}
const errors = [];
let verificationReport;

function sha256File(name) {
  const path = resolve(releaseDirectory, name);
  return existsSync(path) && statSync(path).isFile()
    ? createHash('sha256').update(readFileSync(path)).digest('hex')
    : undefined;
}

function readJsonArtifact(name) {
  const path = resolve(releaseDirectory, name);
  if (!existsSync(path) || !statSync(path).isFile()) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    errors.push(`${name} is not valid JSON: ${error.message}`);
    return undefined;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteMetric(record, key) {
  const value = isRecord(record) ? record[key] : undefined;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function integratedTemporalEligibility(document) {
  const evaluation = isRecord(document?.evaluation) ? document.evaluation : {};
  const selectedWindowMetrics = isRecord(evaluation.selectedWindowMetrics)
    ? evaluation.selectedWindowMetrics
    : undefined;
  const episodeMetrics = isRecord(evaluation.episodeMetrics)
    ? evaluation.episodeMetrics
    : undefined;
  const qualityGate = isRecord(document?.qualityGate) ? document.qualityGate : {};
  const byFault = isRecord(evaluation.byFault) ? evaluation.byFault : {};
  const recalls = Object.values(byFault).flatMap((entry) => {
    const recall = finiteMetric(entry, 'classificationRecall');
    return recall === undefined ? [] : [recall];
  });
  const evaluationUnit =
    typeof evaluation.evaluationUnit === 'string'
      ? evaluation.evaluationUnit
      : 'selected causal rolling-window observation';
  const metricScope = selectedWindowMetrics
    ? 'selected-window'
    : /full[-\s]?stream/i.test(evaluationUnit)
      ? 'full-stream'
      : 'episode';
  const metrics = selectedWindowMetrics ?? episodeMetrics ?? {};
  const thresholds = {
    minimumF1: Math.max(
      selectedWindowMetrics ? 0.85 : 0.8,
      selectedWindowMetrics
        ? (finiteMetric(qualityGate, 'minimumSelectedWindowF1') ?? 0)
        : (finiteMetric(qualityGate, 'minimumEpisodeF1') ?? 0),
    ),
    maximumFalsePositiveRate: Math.min(
      0.05,
      selectedWindowMetrics
        ? (finiteMetric(qualityGate, 'maximumSelectedWindowFalsePositiveRate') ?? 1)
        : (finiteMetric(qualityGate, 'maximumFalsePositiveRate') ?? 1),
    ),
    minimumClassificationMacroF1: Math.max(
      0.65,
      finiteMetric(qualityGate, 'minimumClassificationMacroF1') ?? 0,
    ),
    minimumPerFaultClassificationRecall: Math.max(
      0.65,
      finiteMetric(qualityGate, 'minimumPerFaultClassificationRecall') ?? 0,
    ),
    minimumAnsweredObservations: Math.max(
      1,
      finiteMetric(qualityGate, 'minimumAnsweredObservations') ?? 1,
    ),
    maximumAbstentionRate: finiteMetric(qualityGate, 'maximumAbstentionRate') ?? 1,
  };
  const observed = {
    f1: finiteMetric(metrics, 'f1'),
    falsePositiveRate: finiteMetric(metrics, 'falsePositiveRate'),
    classificationMacroF1: finiteMetric(evaluation, 'classificationMacroF1'),
    minimumPerFaultClassificationRecall:
      recalls.length === Object.keys(byFault).length && recalls.length > 0
        ? Math.min(...recalls)
        : undefined,
    answeredObservations: finiteMetric(evaluation, 'answeredObservations'),
    abstentionRate: finiteMetric(evaluation, 'abstentionRate'),
  };
  return {
    metricScope,
    evaluationUnit,
    thresholds,
    observed,
    passed:
      qualityGate.passed === true &&
      observed.f1 !== undefined &&
      observed.f1 >= thresholds.minimumF1 &&
      observed.falsePositiveRate !== undefined &&
      observed.falsePositiveRate <= thresholds.maximumFalsePositiveRate &&
      observed.classificationMacroF1 !== undefined &&
      observed.classificationMacroF1 >= thresholds.minimumClassificationMacroF1 &&
      observed.minimumPerFaultClassificationRecall !== undefined &&
      observed.minimumPerFaultClassificationRecall >=
        thresholds.minimumPerFaultClassificationRecall &&
      observed.answeredObservations !== undefined &&
      observed.answeredObservations >= thresholds.minimumAnsweredObservations &&
      observed.abstentionRate !== undefined &&
      observed.abstentionRate <= thresholds.maximumAbstentionRate,
  };
}

if (normalizedReleaseVersion !== packageDocument.version) {
  errors.push(
    `release version '${releaseVersion || '(missing)'}' does not match package version '${packageDocument.version}'`,
  );
}

for (const name of required) {
  const path = resolve(releaseDirectory, name);
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
    errors.push(`missing or empty required artifact: ${name}`);
  }
}

if (existsSync(checksumPath)) {
  const lines = readFileSync(checksumPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const checksummedPaths = new Set();
  for (const line of lines) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    if (!match) {
      errors.push(`invalid checksum line: ${line}`);
      continue;
    }
    const [, expected, relativePath] = match;
    if (relativePath === 'checksums.sha256') {
      errors.push('checksum manifest must not checksum itself');
      continue;
    }
    if (checksummedPaths.has(relativePath)) {
      errors.push(`duplicate checksum path: ${relativePath}`);
      continue;
    }
    checksummedPaths.add(relativePath);
    const path = resolve(releaseDirectory, relativePath);
    const pathWithinRelease = relative(releaseDirectory, path);
    if (pathWithinRelease.startsWith('..') || isAbsolute(pathWithinRelease)) {
      errors.push(`checksum path escapes release directory: ${relativePath}`);
      continue;
    }
    if (!existsSync(path) || !statSync(path).isFile()) {
      errors.push(`checksum references missing file: ${relativePath}`);
      continue;
    }
    const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (actual !== expected) {
      errors.push(`checksum mismatch: ${relativePath}`);
    }
  }

  const listedPaths = [...checksummedPaths];
  const sortedPaths = [...listedPaths].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(listedPaths) !== JSON.stringify(sortedPaths)) {
    errors.push('checksum paths are not in deterministic lexical order');
  }

  for (const entry of readdirSync(releaseDirectory, { withFileTypes: true })) {
    if (!entry.isFile()) {
      errors.push(`release directory must be flat, found non-file entry: ${entry.name}`);
      continue;
    }
    if (entry.name !== 'checksums.sha256' && !checksummedPaths.has(entry.name)) {
      errors.push(`release artifact is missing a checksum: ${entry.name}`);
    }
  }
}

const verificationReportPath = resolve(releaseDirectory, 'verification-report.json');
if (existsSync(verificationReportPath)) {
  try {
    verificationReport = JSON.parse(readFileSync(verificationReportPath, 'utf8'));
    if (verificationReport.applicationVersion !== packageDocument.version) {
      errors.push('verification report applicationVersion does not match package version');
    }
    if (
      verificationReport.status !== 'pass' ||
      verificationReport.releaseContext?.exactTagReleaseContext !== true ||
      Object.values(verificationReport.releaseGates ?? {}).some((passed) => passed !== true)
    ) {
      errors.push('verification report does not record a passing release gate set');
    }
    if (
      process.env.GITHUB_SHA &&
      verificationReport.provenance?.sourceRevision !== process.env.GITHUB_SHA
    ) {
      errors.push('verification report source revision does not match the release commit');
    }
  } catch (error) {
    errors.push(`verification report is not valid JSON: ${error.message}`);
  }
}

if (/^v?2\.2\./.test(releaseVersion)) {
  const temporalResearchArtifact = readJsonArtifact('temporal-fault-model-v1.json');
  const temporalResearchEvaluation = readJsonArtifact('temporal-model-evaluation-v1.json');
  const temporalResearchParity = readJsonArtifact('temporal-inference-parity-v1.json');
  const temporalIntegratedArtifact = readJsonArtifact('temporal-fault-model-v2.json');
  const temporalIntegratedEvaluation = readJsonArtifact('temporal-model-evaluation-v2.json');
  const temporalIntegratedParity = readJsonArtifact('temporal-inference-parity-v2.json');
  const temporalConfigurationManifest = readJsonArtifact('model-configuration-manifest-v1.json');
  const temporalBenchmark = readJsonArtifact('temporal-benchmark-report.json');
  const temporalCampaign = readJsonArtifact('temporal-campaign-report.json');
  const researchArtifactSha256 = sha256File('temporal-fault-model-v1.json');
  const integratedArtifactSha256 = sha256File('temporal-fault-model-v2.json');
  const temporalCampaignSha256 = sha256File('temporal-campaign-report.json');
  const integratedEligibility = integratedTemporalEligibility(temporalIntegratedEvaluation);

  const temporalBundles = [
    {
      label: 'v1 research',
      modelVersion: '1.0.0',
      artifactVersion: 'temporal-fault-model.v1',
      modelType: 'causal-dilated-convolution-nearest-centroid',
      artifact: temporalResearchArtifact,
      evaluation: temporalResearchEvaluation,
      parity: temporalResearchParity,
    },
    {
      label: 'v2 integrated',
      modelVersion: '2.0.0',
      artifactVersion: 'temporal-fault-model.v1',
      modelType: 'causal-multiscale-feature-nearest-prototype',
      artifact: temporalIntegratedArtifact,
      evaluation: temporalIntegratedEvaluation,
      parity: temporalIntegratedParity,
    },
  ];
  for (const bundle of temporalBundles) {
    if (
      !isRecord(bundle.artifact) ||
      bundle.artifact.modelVersion !== bundle.modelVersion ||
      bundle.artifact.artifactVersion !== bundle.artifactVersion ||
      bundle.artifact.modelType !== bundle.modelType ||
      !isRecord(bundle.artifact.qualityGate) ||
      bundle.artifact.qualityGate.passed !== true
    ) {
      errors.push(`${bundle.label} temporal model artifact identity or quality gate is invalid`);
    }
    if (
      !isRecord(bundle.evaluation) ||
      bundle.evaluation.modelVersion !== bundle.modelVersion ||
      !isRecord(bundle.evaluation.qualityGate) ||
      bundle.evaluation.qualityGate.passed !== true ||
      bundle.evaluation.artifactVersion !== bundle.artifact?.artifactVersion
    ) {
      errors.push(`${bundle.label} temporal evaluation identity or quality gate is invalid`);
    }
    if (
      !isRecord(bundle.parity) ||
      !Array.isArray(bundle.parity.cases) ||
      bundle.parity.cases.length === 0 ||
      bundle.parity.artifactVersion !== bundle.artifact?.artifactVersion ||
      (bundle.modelVersion === '2.0.0' && bundle.parity.modelVersion !== bundle.modelVersion)
    ) {
      errors.push(`${bundle.label} temporal inference parity evidence is invalid`);
    }
  }

  if (
    temporalResearchEvaluation?.postHocGeneralizationChallenge?.frozenInference?.artifactSha256 !==
    researchArtifactSha256
  ) {
    errors.push('v1 research evaluation does not identify the released raw artifact bytes');
  }
  if (temporalIntegratedEvaluation?.artifactSha256 !== integratedArtifactSha256) {
    errors.push('v2 integrated evaluation does not identify the released raw artifact bytes');
  }
  if (!integratedEligibility.passed) {
    errors.push(
      'v2 integrated temporal model is ineligible under FDW-TML-004 and its artifact-declared thresholds',
    );
  }

  const manifestEntries = Array.isArray(temporalConfigurationManifest?.entries)
    ? temporalConfigurationManifest.entries
    : [];
  const reportModels = verificationReport?.temporalEvidence?.models;
  for (const expected of [
    {
      label: 'v1 research',
      modelVersion: '1.0.0',
      artifactVersion: 'temporal-fault-model.v1',
      modelType: 'causal-dilated-convolution-nearest-centroid',
      artifactSha256: researchArtifactSha256,
      report: reportModels?.research,
      role: 'research-evidence-only',
      productionPath: false,
    },
    {
      label: 'v2 integrated',
      modelVersion: '2.0.0',
      artifactVersion: 'temporal-fault-model.v1',
      modelType: 'causal-multiscale-feature-nearest-prototype',
      artifactSha256: integratedArtifactSha256,
      report: reportModels?.integrated,
      role: 'production-integrated-advisory',
      productionPath: true,
    },
  ]) {
    const manifestEntry = manifestEntries.find(
      (entry) =>
        entry?.registryEntryId === 'generic-fixed-wing.temporal-fault' &&
        entry?.modelVersion === expected.modelVersion,
    );
    const configurationSha256 =
      typeof manifestEntry?.canonicalJson === 'string'
        ? createHash('sha256').update(manifestEntry.canonicalJson).digest('hex')
        : undefined;
    if (
      configurationSha256 === undefined ||
      configurationSha256 !== manifestEntry?.sha256 ||
      expected.report?.configurationSha256 !== configurationSha256
    ) {
      errors.push(`${expected.label} temporal configuration identity is invalid`);
    }
    if (
      expected.report?.role !== expected.role ||
      expected.report?.productionPath !== expected.productionPath ||
      expected.report?.authority !== 'deterministic-rules' ||
      expected.report?.modelVersion !== expected.modelVersion ||
      expected.report?.artifactVersion !== expected.artifactVersion ||
      expected.report?.modelType !== expected.modelType ||
      expected.report?.artifactSha256 !== expected.artifactSha256 ||
      expected.report?.qualityGatePassed !== true ||
      expected.report?.evaluation?.modelVersion !== expected.modelVersion ||
      expected.report?.evaluation?.qualityGate?.passed !== true ||
      !isRecord(expected.report?.evaluation?.evaluation) ||
      expected.report?.registry?.modelVersion !== expected.modelVersion ||
      expected.report?.registry?.identities?.artifactSha256 !== expected.artifactSha256
    ) {
      errors.push(
        `${expected.label} verification-report identity or authority boundary is invalid`,
      );
    }
    if (
      expected.productionPath &&
      (expected.report?.eligibility?.passed !== true ||
        expected.report?.eligibility?.metricScope !== integratedEligibility.metricScope ||
        JSON.stringify(expected.report?.eligibility?.thresholds) !==
          JSON.stringify(integratedEligibility.thresholds) ||
        JSON.stringify(expected.report?.eligibility?.observed) !==
          JSON.stringify(integratedEligibility.observed))
    ) {
      errors.push('v2 integrated verification-report eligibility evidence is invalid');
    }
  }

  if (
    temporalBenchmark?.reproducibility?.model?.role !== 'integrated-production-advisory' ||
    temporalBenchmark?.reproducibility?.model?.modelVersion !== '2.0.0' ||
    temporalBenchmark?.reproducibility?.model?.artifactPath !==
      'models/temporal_fault_model_v2.json' ||
    temporalBenchmark?.reproducibility?.model?.artifactSha256 !== integratedArtifactSha256 ||
    temporalBenchmark?.reproducibility?.model?.authority !== 'deterministic-rules'
  ) {
    errors.push('temporal benchmark does not identify the released v2 integrated advisory path');
  }

  const campaignSummary = temporalCampaign?.summary;
  const reportCampaign = verificationReport?.temporalEvidence?.campaign;
  if (
    temporalCampaign?.schemaVersion !== 'campaign.v1' ||
    temporalCampaign?.status !== 'completed' ||
    !isRecord(campaignSummary) ||
    campaignSummary.plannedCases !== campaignSummary.completedCases ||
    campaignSummary.failedCases !== 0 ||
    reportCampaign?.artifactPath !== 'artifacts/temporal-campaign-report.json' ||
    reportCampaign?.artifactSha256 !== temporalCampaignSha256 ||
    reportCampaign?.runId !== temporalCampaign.runId ||
    reportCampaign?.replaySpecSha256 !== temporalCampaign?.replayManifest?.specSha256 ||
    reportCampaign?.evidencePolicy?.fullCampaignEmbedded !== false
  ) {
    errors.push('temporal campaign artifact or minimized verification reference is invalid');
  }

  for (const integrityName of [
    'verification-history-integrity.json',
    'temporal-campaign-integrity.json',
  ]) {
    const integrityPath = resolve(releaseDirectory, integrityName);
    if (!existsSync(integrityPath)) continue;
    try {
      const integrityReport = JSON.parse(readFileSync(integrityPath, 'utf8'));
      if (
        integrityReport.ok !== true ||
        JSON.stringify(integrityReport.integrity) !== '["ok"]' ||
        !Array.isArray(integrityReport.foreignKeyViolations) ||
        integrityReport.foreignKeyViolations.length !== 0
      ) {
        errors.push(`SQLite integrity report is not passing: ${integrityName}`);
      }
    } catch (error) {
      errors.push(`SQLite integrity report is not valid JSON (${integrityName}): ${error.message}`);
    }
  }

  const screenshotMetadataPath = resolve(releaseDirectory, 'workbench-screenshot-metadata.json');
  if (existsSync(screenshotMetadataPath)) {
    try {
      const screenshotMetadata = JSON.parse(readFileSync(screenshotMetadataPath, 'utf8'));
      const captures = Array.isArray(screenshotMetadata.captures)
        ? screenshotMetadata.captures.map((capture) => capture?.file)
        : [];
      if (
        screenshotMetadata.applicationVersion !== packageDocument.version ||
        !captures.includes('workbench-investigation.png') ||
        !captures.includes('workbench-mobile.png')
      ) {
        errors.push(
          'screenshot metadata does not match the release application and required views',
        );
      }
    } catch (error) {
      errors.push(`screenshot metadata is not valid JSON: ${error.message}`);
    }
  }

  const releaseNotesPath = resolve(
    releaseDirectory,
    `release-notes-v${normalizedReleaseVersion}.md`,
  );
  if (existsSync(releaseNotesPath)) {
    const releaseNotes = readFileSync(releaseNotesPath, 'utf8');
    if (
      /^##\s+status:\s*unreleased/im.test(releaseNotes) ||
      /^#\s+v[^\n]*candidate release notes/im.test(releaseNotes)
    ) {
      errors.push('release notes still declare a candidate or unreleased status');
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
