import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  candidateCommitmentSha256,
  candidateSelectionRecordPath,
  captureSourceIdentity,
  sameSourceIdentity,
  verifyRetainedCandidate,
  type RetainedCandidateProvenance,
} from './retainCandidate';
import { assertEvidenceOutputPlacement } from './evidenceOutputPolicy';
import {
  candidateRunbookIdentityInput,
  readRetainedRuntimePolicyBinding,
  verifyCandidateRunbookRehearsal,
} from './rehearseCandidateRunbooks';
import { BROWSER_BUDGET_SCHEMA_VERSION, verifyBrowserBudgets } from './verifyBrowserBudgets';

const RECEIPT_SCHEMA_VERSION = 'airspace-m34-acceptance.v2';
const ACCEPTANCE_SPEC = 'm34-entry-artifact.spec.ts';
const ACCEPTANCE_PROJECT = 'm34-built-chromium';
const ACCEPTANCE_TEST_MATCH = '**/m34-entry-artifact.spec.ts';

export const M34_ACCEPTANCE_CASE_NAMES = [
  'root is the exact retained mock-staging v3 client and opens Live in the four-workspace shell',
  'all four workspace hashes survive direct entry, reload, Back, and Forward',
  'retained Worker API, WebSocket, and Durable Object prove synthetic mock provenance',
  'v2 rollback serves the exact approved HTML and JavaScript without mounting v3',
  'retained map bytes support exact range reads while absent maps and assets fail closed',
] as const;

export interface JunitSummary {
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
  durationSeconds: number;
  executedAt: string;
  suiteName: typeof ACCEPTANCE_SPEC;
  projectName: typeof ACCEPTANCE_PROJECT;
  caseNames: string[];
}

export interface RecordAcceptanceOptions {
  candidateDirectory: string;
  junitPath: string;
  runbookReceiptPath: string;
  outputPath: string;
  selectionRecordPath?: string;
  expectedSelectionRecordSha256?: string;
  expectedCandidateId?: string;
  expectedSourceHead?: string;
}

export interface AcceptanceReceipt {
  schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  result: 'passed';
  candidate: {
    id: string;
    buildTarget: 'mock-staging';
    providerMode: 'mock';
    sourceHead: string;
    sourceContentSha256: string;
    retainedArtifact: { fileCount: number; totalBytes: number; sha256: string };
    runtimePolicy: {
      path: 'artifact/client/runtime-policy.json';
      bytes: number;
      sha256: string;
      schemaVersion: 'runtime-policy.v1';
      policyId: string;
      policyEpoch: string;
      canonicalSha256: string;
      target: 'mock-staging';
      providerMode: 'mock';
      providerId: 'synthetic-test';
      synthetic: true;
      release: {
        applicationVersion: string;
        releaseSha: string;
        releaseStatus: 'unreleased' | 'exact-release';
        buildTarget: 'mock-staging';
      };
      limits: {
        schemaVersion: 'runtime-policy-limits.v2';
        canonicalSha256: string;
      };
    };
    checksumManifestSha256: string;
    selectionRecord: {
      path: string;
      bytes: number;
      sha256: string;
      candidateCommitmentSha256: string;
    };
  };
  browserBudgets: {
    schemaVersion: typeof BROWSER_BUDGET_SCHEMA_VERSION;
    target: 'mock-staging';
    clientIdentity: {
      schemaVersion: 'sha256-file-inventory.v1';
      fileCount: number;
      totalBytes: number;
      sha256: string;
    };
    initialShell: { limitGzipBytes: number; totalGzipBytes: number };
    lazyMap: { limitGzipBytes: number; totalGzipBytes: number };
    styles: { totalBytes: number; totalGzipBytes: number };
    fonts: { totalBytes: number; totalGzipBytes: number };
  };
  runbookRehearsal: {
    schemaVersion: 'runbook-rehearsal-receipt.v1';
    evidenceClass: 'synthetic-local-runbook-rehearsal';
    privacy: 'aggregate-only-no-aircraft-request-client-or-event-data';
    receiptPath: string;
    bytes: number;
    sha256: string;
    runbooks: {
      schemaVersion: 'operator-procedure-manifest.v1';
      path: 'manifest.json';
      bytes: number;
      sha256: string;
      procedureCount: number;
    };
    source: {
      schemaVersion: 'synthetic-source-build-identity.v1';
      head: string;
      contentSha256: string;
    };
    release: {
      applicationVersion: string;
      releaseSha: string;
      releaseStatus: 'unreleased' | 'exact-release';
      buildTarget: 'mock-staging';
    };
    syntheticArtifact: {
      schemaVersion: 'synthetic-artifact-identity.v1';
      kind: 'synthetic-source-built-artifact';
      fileCount: number;
      totalBytes: number;
      sha256: string;
    };
    policies: {
      retained: {
        policyId: string;
        policyEpoch: string;
        canonicalSha256: string;
      };
      rehearsal: {
        policyId: string;
        policyEpoch: string;
        canonicalSha256: string;
        sourceDescriptorSha256: string;
      };
      limits: {
        schemaVersion: 'runtime-policy-limits.v2';
        canonicalSha256: string;
      };
      compatibility: {
        target: 'mock-staging';
        providerMode: 'mock';
        providerId: 'synthetic-test';
        synthetic: true;
      };
    };
    approvedRollback: {
      schemaVersion: 'fdw-approved-rollback.v1';
      releaseTag: 'v2.2.0';
      sourceRevision: string;
      manifest: { bytes: number; sha256: string };
      archive: { bytes: number; sha256: string };
    };
    summary: {
      procedureCount: number;
      verifiedCount: number;
      stoppedCount: number;
      rolledBackCount: number;
      recoveredCount: number;
      finalResult: 'verified';
    };
    executionBoundary: {
      syntheticOnly: true;
      localOnly: true;
      networkRequests: 0;
      providerActions: 0;
      cloudActions: 0;
      deploymentActions: 0;
      runtimeMutations: 0;
      productionActions: 0;
    };
  };
  browser: JunitSummary & {
    framework: 'Playwright';
    reportFormat: 'JUnit XML';
    reportPath: string;
    bytes: number;
    sha256: string;
    configuredRetries: 0;
    retryEvidence: {
      format: 'Playwright configuration';
      path: 'playwright.m34.config.ts';
      bytes: number;
      sha256: string;
      testMatch: typeof ACCEPTANCE_TEST_MATCH;
      fullyParallel: false;
      workers: 1;
      retries: 0;
    };
  };
  map: {
    id: string;
    manifestSha256: string;
    basemapSha256: string;
    payload: { fileCount: number; totalBytes: number; sha256: string };
  };
  rollback: { releaseTag: string; sourceRevision: string; archiveSha256: string };
  replayScenarios: RetainedCandidateProvenance['replayScenarios'];
  truthBoundaries: {
    localOnly: true;
    buildPerformedByAcceptanceRecorder: false;
    deploymentPerformed: false;
    providerMode: 'mock';
  };
}

interface StableFile {
  path: string;
  contents: Buffer;
  bytes: number;
  sha256: string;
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(contents: string | Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex');
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function attribute(attributes: string, name: string): string {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`, 'u').exec(attributes);
  if (match?.[1] === undefined) throw new Error(`JUnit report is missing ${name}.`);
  return decodeXml(match[1]);
}

function countAttribute(attributes: string, name: string): number {
  const value = attribute(attributes, name);
  if (!/^\d+$/u.test(value)) throw new Error(`JUnit ${name} must be a non-negative integer.`);
  return Number(value);
}

function durationAttribute(attributes: string, name: string): number {
  const value = Number(attribute(attributes, name));
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`JUnit ${name} must be a non-negative finite number.`);
  }
  return value;
}

export function parsePassingJunit(contents: string): JunitSummary {
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[|<!--/iu.test(contents)) {
    throw new Error('JUnit report contains unsupported XML constructs.');
  }
  const root = /<testsuites\b([^>]*)>/u.exec(contents);
  const suite = /<testsuite\b([^>]*)>/u.exec(contents);
  if (root?.[1] === undefined || suite?.[1] === undefined) {
    throw new Error('JUnit report must contain testsuites and testsuite elements.');
  }
  const tests = countAttribute(root[1], 'tests');
  const failures = countAttribute(root[1], 'failures');
  const errors = countAttribute(root[1], 'errors');
  const skipped = countAttribute(root[1], 'skipped');
  const durationSeconds = durationAttribute(root[1], 'time');
  if (tests !== M34_ACCEPTANCE_CASE_NAMES.length) {
    throw new Error(`M3.4 acceptance requires exactly ${M34_ACCEPTANCE_CASE_NAMES.length} cases.`);
  }
  if (failures !== 0 || errors !== 0 || skipped !== 0) {
    throw new Error('M3.4 acceptance requires zero failed, errored, or skipped browser cases.');
  }
  for (const name of ['tests', 'failures', 'errors', 'skipped'] as const) {
    if (countAttribute(suite[1], name) !== countAttribute(root[1], name)) {
      throw new Error('JUnit root and suite result counts do not match.');
    }
  }
  if (/<(?:failure|error|skipped)\b/iu.test(contents)) {
    throw new Error('M3.4 acceptance report contains a non-passing result element.');
  }
  const suiteName = attribute(suite[1], 'name');
  const projectName = attribute(suite[1], 'hostname');
  if (suiteName !== ACCEPTANCE_SPEC || projectName !== ACCEPTANCE_PROJECT) {
    throw new Error('JUnit suite does not identify the exact M3.4 spec and project.');
  }
  const executedAt = attribute(suite[1], 'timestamp');
  if (Number.isNaN(Date.parse(executedAt))) throw new Error('JUnit timestamp is invalid.');

  const caseNames = [...contents.matchAll(/<testcase\b([^>]*)>/gu)].map((match) => {
    const attributes = match[1];
    if (attributes === undefined) throw new Error('JUnit testcase attributes are missing.');
    if (attribute(attributes, 'classname') !== ACCEPTANCE_SPEC) {
      throw new Error('JUnit testcase does not belong to the exact M3.4 spec.');
    }
    return attribute(attributes, 'name');
  });
  if (caseNames.length !== tests || new Set(caseNames).size !== caseNames.length) {
    throw new Error('JUnit test count does not match unique named test cases.');
  }
  caseNames.sort(compareNames);
  const expected = [...M34_ACCEPTANCE_CASE_NAMES].sort(compareNames);
  if (JSON.stringify(caseNames) !== JSON.stringify(expected)) {
    throw new Error('JUnit report does not contain the exact M3.4 acceptance cases.');
  }
  return {
    tests,
    failures,
    errors,
    skipped,
    durationSeconds,
    executedAt,
    suiteName: ACCEPTANCE_SPEC,
    projectName: ACCEPTANCE_PROJECT,
    caseNames,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function portablePath(path: string): string {
  return path.replaceAll('\\', '/');
}

async function readStableRegularFile(path: string, label: string): Promise<StableFile> {
  const absolutePath = resolve(path);
  const before = await lstat(absolutePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label} is missing: ${absolutePath}`);
    }
    throw error;
  });
  if (!before.isFile() || before.isSymbolicLink() || before.size === 0) {
    throw new Error(`${label} must be a non-empty regular file: ${absolutePath}`);
  }
  const contents = await readFile(absolutePath);
  const after = await lstat(absolutePath);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    contents.byteLength !== after.size
  ) {
    throw new Error(`${label} changed while it was read.`);
  }
  return {
    path: absolutePath,
    contents,
    bytes: contents.byteLength,
    sha256: sha256(contents),
  };
}

async function assertUnchanged(file: StableFile, label: string): Promise<void> {
  const current = await readStableRegularFile(file.path, label);
  if (current.bytes !== file.bytes || current.sha256 !== file.sha256) {
    throw new Error(`${label} changed during acceptance recording.`);
  }
}

function validatePlaywrightConfiguration(contents: string): void {
  const exactDeclarations = [
    /^\s*testMatch:\s*['"]\*\*\/m34-entry-artifact\.spec\.ts['"]\s*,\s*$/gmu,
    /^\s*fullyParallel:\s*false\s*,\s*$/gmu,
    /^\s*workers:\s*1\s*,\s*$/gmu,
    /^\s*retries:\s*0\s*,\s*$/gmu,
    /\[\s*['"]junit['"]\s*,\s*\{\s*outputFile:\s*`\$\{resultRoot\}\/results\.xml`\s*\}\s*\]/gu,
  ];
  if (exactDeclarations.some((pattern) => [...contents.matchAll(pattern)].length !== 1)) {
    throw new Error(
      'M3.4 Playwright configuration does not prove the exact spec, serial worker, JUnit, and zero-retry policy.',
    );
  }
}

export async function recordCandidateAcceptance(
  options: RecordAcceptanceOptions,
): Promise<AcceptanceReceipt> {
  const candidateDirectory = resolve(options.candidateDirectory);
  const junitPath = resolve(options.junitPath);
  const runbookReceiptPath = resolve(options.runbookReceiptPath);
  const outputPath = resolve(options.outputPath);
  const checksumOutputPath = `${outputPath}.sha256`;
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const protectedPaths = [
    candidateDirectory,
    join(repositoryRoot, 'dist-live'),
    join(repositoryRoot, 'dist-mock-staging'),
    join(repositoryRoot, 'dist'),
    join(repositoryRoot, 'maps'),
    join(repositoryRoot, '.map-data'),
    join(repositoryRoot, 'rollback'),
  ];
  await assertEvidenceOutputPlacement({
    repositoryRoot,
    outputPath,
    label: 'Acceptance evidence',
    allowedRepositoryRoots: ['test-results'],
    protectedPaths,
  });
  await assertEvidenceOutputPlacement({
    repositoryRoot,
    outputPath: checksumOutputPath,
    label: 'Acceptance evidence checksum',
    allowedRepositoryRoots: ['test-results'],
    protectedPaths,
  });
  if ((await exists(outputPath)) || (await exists(checksumOutputPath))) {
    throw new Error('Acceptance output already exists.');
  }

  const configPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'playwright.m34.config.ts',
  );
  const sourceBefore = await captureSourceIdentity(repositoryRoot);
  const config = await readStableRegularFile(configPath, 'M3.4 Playwright configuration');
  validatePlaywrightConfiguration(config.contents.toString('utf8'));
  const checksumPath = resolve(candidateDirectory, 'checksums.sha256');
  const checksumBefore = await readStableRegularFile(checksumPath, 'Candidate checksum manifest');
  const selectionPath = resolve(
    options.selectionRecordPath ?? candidateSelectionRecordPath(candidateDirectory),
  );
  const selectionBefore = await readStableRegularFile(selectionPath, 'Candidate selection record');
  const verificationOptions = {
    candidateDirectory,
    selectionRecordPath: selectionPath,
    expectedSourceIdentity: sourceBefore,
    expectedTarget: 'mock-staging',
    ...(options.expectedSelectionRecordSha256 === undefined
      ? {}
      : { expectedSelectionRecordSha256: options.expectedSelectionRecordSha256 }),
    ...(options.expectedCandidateId === undefined
      ? {}
      : { expectedCandidateId: options.expectedCandidateId }),
    ...(options.expectedSourceHead === undefined
      ? {}
      : { expectedSourceHead: options.expectedSourceHead }),
  } as const;
  const firstProvenance = await verifyRetainedCandidate(verificationOptions);
  const retainedRuntimePolicy = await readRetainedRuntimePolicyBinding(candidateDirectory);
  const runbookIdentityInput = candidateRunbookIdentityInput(
    firstProvenance,
    retainedRuntimePolicy,
  );
  const verifiedRunbook = await verifyCandidateRunbookRehearsal(
    runbookReceiptPath,
    runbookIdentityInput,
    { repositoryRoot },
  );
  const rehearsalPolicy = verifiedRunbook.receipt.bindings.compiledPolicy;
  if (retainedRuntimePolicy.limits.canonicalSha256 !== rehearsalPolicy.limitsSha256) {
    throw new Error(
      'Runbook rehearsal and retained runtime policy have different canonical limits.',
    );
  }
  const budget = await verifyBrowserBudgets(
    join(candidateDirectory, 'artifact'),
    'mock-staging',
    retainedRuntimePolicy.policy.limits.browser.bundle,
  );
  const junit = await readStableRegularFile(junitPath, 'M3.4 JUnit report');
  const summary = parsePassingJunit(junit.contents.toString('utf8'));
  await assertUnchanged(checksumBefore, 'Candidate checksum manifest');

  const receipt: AcceptanceReceipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    result: 'passed',
    candidate: {
      id: firstProvenance.candidateId,
      buildTarget: firstProvenance.application.buildTarget,
      providerMode: firstProvenance.application.providerMode,
      sourceHead: firstProvenance.source.head,
      sourceContentSha256: firstProvenance.source.contentSha256,
      retainedArtifact: {
        fileCount: firstProvenance.retainedArtifact.fileCount,
        totalBytes: firstProvenance.retainedArtifact.totalBytes,
        sha256: firstProvenance.retainedArtifact.sha256,
      },
      runtimePolicy: {
        ...retainedRuntimePolicy.identity,
        schemaVersion: retainedRuntimePolicy.policy.schemaVersion,
        policyId: retainedRuntimePolicy.policy.policyId,
        policyEpoch: retainedRuntimePolicy.policy.policyEpoch,
        canonicalSha256: retainedRuntimePolicy.canonicalSha256,
        target: 'mock-staging',
        providerMode: 'mock',
        providerId: 'synthetic-test',
        synthetic: true,
        release: {
          applicationVersion: retainedRuntimePolicy.policy.release.applicationVersion,
          releaseSha: retainedRuntimePolicy.policy.release.releaseSha,
          releaseStatus: retainedRuntimePolicy.policy.release.releaseStatus,
          buildTarget: 'mock-staging',
        },
        limits: retainedRuntimePolicy.limits,
      },
      checksumManifestSha256: checksumBefore.sha256,
      selectionRecord: {
        path: portablePath(relative(resolve('.'), selectionPath)),
        bytes: selectionBefore.bytes,
        sha256: selectionBefore.sha256,
        candidateCommitmentSha256: candidateCommitmentSha256(firstProvenance),
      },
    },
    browser: {
      framework: 'Playwright',
      reportFormat: 'JUnit XML',
      reportPath: portablePath(relative(resolve('.'), junitPath)),
      bytes: junit.bytes,
      sha256: junit.sha256,
      configuredRetries: 0,
      retryEvidence: {
        format: 'Playwright configuration',
        path: 'playwright.m34.config.ts',
        bytes: config.bytes,
        sha256: config.sha256,
        testMatch: ACCEPTANCE_TEST_MATCH,
        fullyParallel: false,
        workers: 1,
        retries: 0,
      },
      ...summary,
    },
    browserBudgets: {
      schemaVersion: budget.schemaVersion,
      target: 'mock-staging',
      clientIdentity: budget.artifact.clientIdentity,
      initialShell: {
        limitGzipBytes: budget.initialShell.limitGzipBytes,
        totalGzipBytes: budget.initialShell.totalGzipBytes,
      },
      lazyMap: {
        limitGzipBytes: budget.lazyMap.limitGzipBytes,
        totalGzipBytes: budget.lazyMap.totalGzipBytes,
      },
      styles: {
        totalBytes: budget.styles.totalBytes,
        totalGzipBytes: budget.styles.totalGzipBytes,
      },
      fonts: {
        totalBytes: budget.fonts.totalBytes,
        totalGzipBytes: budget.fonts.totalGzipBytes,
      },
    },
    runbookRehearsal: {
      schemaVersion: verifiedRunbook.receipt.schemaVersion,
      evidenceClass: verifiedRunbook.receipt.evidenceClass,
      privacy: verifiedRunbook.receipt.privacy,
      receiptPath: portablePath(relative(resolve('.'), runbookReceiptPath)),
      bytes: verifiedRunbook.receiptIdentity.bytes,
      sha256: verifiedRunbook.receiptIdentity.sha256,
      runbooks: verifiedRunbook.receipt.bindings.runbooks,
      source: verifiedRunbook.receipt.bindings.source,
      release: {
        applicationVersion: verifiedRunbook.receipt.bindings.release.applicationVersion,
        releaseSha: verifiedRunbook.receipt.bindings.release.releaseSha,
        releaseStatus: verifiedRunbook.receipt.bindings.release.releaseStatus,
        buildTarget: 'mock-staging',
      },
      syntheticArtifact: verifiedRunbook.receipt.bindings.syntheticArtifact,
      policies: {
        retained: {
          policyId: retainedRuntimePolicy.policy.policyId,
          policyEpoch: retainedRuntimePolicy.policy.policyEpoch,
          canonicalSha256: retainedRuntimePolicy.canonicalSha256,
        },
        rehearsal: {
          policyId: rehearsalPolicy.policyId,
          policyEpoch: rehearsalPolicy.policyEpoch,
          canonicalSha256: rehearsalPolicy.canonicalSha256,
          sourceDescriptorSha256: rehearsalPolicy.sourceDescriptorSha256,
        },
        limits: {
          schemaVersion: rehearsalPolicy.limitsSchemaVersion,
          canonicalSha256: rehearsalPolicy.limitsSha256,
        },
        compatibility: {
          target: 'mock-staging',
          providerMode: 'mock',
          providerId: 'synthetic-test',
          synthetic: true,
        },
      },
      approvedRollback: verifiedRunbook.receipt.bindings.approvedRollback,
      summary: {
        ...verifiedRunbook.receipt.summary,
        finalResult: 'verified',
      },
      executionBoundary: verifiedRunbook.receipt.executionBoundary,
    },
    map: {
      id: firstProvenance.mapManifest.id,
      manifestSha256: firstProvenance.mapManifest.sha256,
      basemapSha256: firstProvenance.mapManifest.basemapSha256,
      payload: {
        fileCount: firstProvenance.mapManifest.payload.fileCount,
        totalBytes: firstProvenance.mapManifest.payload.totalBytes,
        sha256: firstProvenance.mapManifest.payload.sha256,
      },
    },
    rollback: {
      releaseTag: firstProvenance.rollback.releaseTag,
      sourceRevision: firstProvenance.rollback.sourceRevision,
      archiveSha256: firstProvenance.rollback.archive.sha256,
    },
    replayScenarios: firstProvenance.replayScenarios,
    truthBoundaries: {
      localOnly: true,
      buildPerformedByAcceptanceRecorder: false,
      deploymentPerformed: false,
      providerMode: 'mock',
    },
  };

  await mkdir(dirname(outputPath), { recursive: true });
  const receiptContents = `${JSON.stringify(receipt, null, 2)}\n`;
  let wroteReceipt = false;
  let wroteChecksum = false;
  try {
    await writeFile(outputPath, receiptContents, { encoding: 'utf8', flag: 'wx' });
    wroteReceipt = true;
    await writeFile(checksumOutputPath, `${sha256(receiptContents)}  ${basename(outputPath)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    wroteChecksum = true;
    const finalProvenance = await verifyRetainedCandidate(verificationOptions);
    if (JSON.stringify(finalProvenance) !== JSON.stringify(firstProvenance)) {
      throw new Error('Candidate identity changed during acceptance recording.');
    }
    await assertUnchanged(checksumBefore, 'Candidate checksum manifest');
    await assertUnchanged(selectionBefore, 'Candidate selection record');
    await assertUnchanged(junit, 'M3.4 JUnit report');
    await assertUnchanged(config, 'M3.4 Playwright configuration');
    const finalRuntimePolicy = await readRetainedRuntimePolicyBinding(candidateDirectory);
    if (JSON.stringify(finalRuntimePolicy) !== JSON.stringify(retainedRuntimePolicy)) {
      throw new Error('Retained runtime policy changed during acceptance recording.');
    }
    const finalRunbook = await verifyCandidateRunbookRehearsal(
      runbookReceiptPath,
      runbookIdentityInput,
      { repositoryRoot },
    );
    if (JSON.stringify(finalRunbook) !== JSON.stringify(verifiedRunbook)) {
      throw new Error('Runbook rehearsal receipt changed during acceptance recording.');
    }
    const sourceAfter = await captureSourceIdentity(repositoryRoot);
    if (!sameSourceIdentity(sourceBefore, sourceAfter)) {
      throw new Error('Exact checkout source changed during acceptance recording.');
    }
  } catch (error) {
    if (wroteChecksum) await rm(checksumOutputPath, { force: true });
    if (wroteReceipt) await rm(outputPath, { force: true });
    throw error;
  }
  return receipt;
}

function cliArguments(arguments_: readonly string[]): RecordAcceptanceOptions {
  const candidateDirectory = arguments_[0];
  const junitPath = arguments_[1];
  const runbookReceiptPath = arguments_[2];
  if (
    candidateDirectory === undefined ||
    junitPath === undefined ||
    runbookReceiptPath === undefined ||
    candidateDirectory.startsWith('--') ||
    junitPath.startsWith('--') ||
    runbookReceiptPath.startsWith('--')
  ) {
    throw new Error(
      'Usage: tsx tools/live/recordCandidateAcceptance.ts <candidate-directory> <junit-file> <runbook-rehearsal-receipt> --output <new-file> (--expected-selection-sha256 <sha256> | --expected-candidate-id <id>) [--selection-record <file>] [--expected-source-head <sha>]',
    );
  }
  let outputPath: string | undefined;
  let expectedSourceHead: string | undefined;
  let selectionRecordPath: string | undefined;
  let expectedSelectionRecordSha256: string | undefined;
  let expectedCandidateId: string | undefined;
  for (let index = 3; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${flag ?? 'CLI argument'}.`);
    }
    if (flag === '--output') outputPath = value;
    else if (flag === '--expected-source-head') expectedSourceHead = value;
    else if (flag === '--selection-record') selectionRecordPath = value;
    else if (flag === '--expected-selection-sha256') expectedSelectionRecordSha256 = value;
    else if (flag === '--expected-candidate-id') expectedCandidateId = value;
    else throw new Error(`Unknown argument: ${flag ?? ''}`);
  }
  if (outputPath === undefined) throw new Error('Acceptance receipt output is required.');
  return {
    candidateDirectory,
    junitPath,
    runbookReceiptPath,
    outputPath,
    ...(selectionRecordPath === undefined ? {} : { selectionRecordPath }),
    ...(expectedSelectionRecordSha256 === undefined ? {} : { expectedSelectionRecordSha256 }),
    ...(expectedCandidateId === undefined ? {} : { expectedCandidateId }),
    ...(expectedSourceHead === undefined ? {} : { expectedSourceHead }),
  };
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  recordCandidateAcceptance(cliArguments(process.argv.slice(2))).then(
    (receipt) => {
      console.log(
        `Recorded passing M3.4 evidence for ${receipt.candidate.id}. No build, deployment, or network request was performed.`,
      );
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
