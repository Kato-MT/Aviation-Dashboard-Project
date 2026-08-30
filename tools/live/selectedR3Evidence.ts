import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { format } from 'prettier';

const MANIFEST_SCHEMA_VERSION = 'selected-r3-evidence.v1' as const;
const SOURCE_SCHEMA_VERSION = 'selected-r3-source-content.v1' as const;
const DEFAULT_MANIFEST_PATH = 'hardening/r3/selected-evidence.manifest.json';
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const GIT_OBJECT_PATTERN = /^[0-9a-f]{40,64}$/u;

const SELECTED_OPTION_IDS = [
  'regional-operations-contract',
  'central-runtime-policy-contract',
] as const;

const AUTHORITY_BOUNDARY =
  'Local R3 implementation only. No commit, push, provider contact, Cloudflare mutation, billing, deployment, or publication authority.';

interface SelectedTestCase {
  readonly id: string;
  readonly requirementId: string;
  readonly evidencePaths: readonly string[];
}

interface SelectedArea {
  readonly area: string;
  readonly requirementIds: readonly string[];
  readonly testCases: readonly SelectedTestCase[];
}

const OPERATIONAL_TEST_CASES = [
  {
    id: 'TC-OPS-001',
    requirementId: 'FDW-OPS-001',
    evidencePaths: [
      'schemas/operations-v1.schema.json',
      'src/operations/contract.ts',
      'tests/live/operations-contract.test.ts',
    ],
  },
  {
    id: 'TC-OPS-002',
    requirementId: 'FDW-OPS-002',
    evidencePaths: [
      'src/evidence/health.ts',
      'worker/index.ts',
      'worker/regionalFeedHub.ts',
      'tests/worker/worker.test.ts',
      'tests/evidence/health.test.ts',
    ],
  },
  {
    id: 'TC-OPS-003',
    requirementId: 'FDW-OPS-003',
    evidencePaths: [
      'src/operations/classifier.ts',
      'worker/metrics.ts',
      'worker/delivery.ts',
      'worker/admission.ts',
      'tests/live/admission.test.ts',
      'tests/worker/metrics.test.ts',
      'tests/worker/delivery.test.ts',
      'tests/live/operations-classifier.test.ts',
    ],
  },
  {
    id: 'TC-OPS-004',
    requirementId: 'FDW-OPS-004',
    evidencePaths: [
      'src/operations/contract.ts',
      'tools/live/operationsPrivacyAudit.ts',
      'tools/live/runG2Firebreak.ts',
      'tools/live/retainCandidate.ts',
      'tools/live/verifyBuilds.ts',
      'tests/live/operations-privacy.test.ts',
      'tests/live/g2-evidence-policy.test.ts',
      'tests/live/retain-candidate.test.ts',
      'tests/live-browser/g2-provider-smoke.spec.ts',
      'playwright.g2.config.ts',
    ],
  },
  {
    id: 'TC-OPS-005',
    requirementId: 'FDW-OPS-005',
    evidencePaths: [
      'worker/metrics.ts',
      'worker/regionalFeedHub.ts',
      'tests/worker/retention.test.ts',
      'tests/worker/metrics.test.ts',
    ],
  },
  {
    id: 'TC-OPS-006',
    requirementId: 'FDW-OPS-006',
    evidencePaths: [
      'worker/delivery.ts',
      'worker/admission.ts',
      'tests/worker/delivery.test.ts',
      'tests/live/admission.test.ts',
      'tests/live/operations-classifier.test.ts',
      'tests/live/regional-delivery.test.ts',
    ],
  },
  {
    id: 'TC-OPS-007',
    requirementId: 'FDW-OPS-007',
    evidencePaths: [
      'src/features/evidence/EvidenceApp.tsx',
      'src/features/evidence/evidence.css',
      'tests/evidence/EvidenceApp.test.tsx',
      'tests/live-browser/replay-evidence.spec.ts',
      'tests/accessibility/workbench.spec.ts',
    ],
  },
  {
    id: 'TC-OPS-008',
    requirementId: 'FDW-OPS-008',
    evidencePaths: [
      'tools/live/loadHarness.ts',
      'tools/live/loadHarnessReport.ts',
      'tools/live/recordCandidateAcceptance.ts',
      'tests/live/candidate-acceptance.test.ts',
      'tests/live/load-harness-artifact.test.ts',
      'tests/live/workflow-policy.test.ts',
    ],
  },
] as const satisfies readonly SelectedTestCase[];

const POLICY_TEST_CASES = [
  {
    id: 'TC-POL-001',
    requirementId: 'FDW-POL-001',
    evidencePaths: [
      'schemas/runtime-policy-v1.schema.json',
      'src/live/runtimePolicy.ts',
      'src/live/runtimePolicyLimits.ts',
      'tests/live/runtime-policy.test.ts',
      'tests/live/runtime-policy-limits.test.ts',
    ],
  },
  {
    id: 'TC-POL-002',
    requirementId: 'FDW-POL-002',
    evidencePaths: [
      'src/live/runtimePolicy.ts',
      'tests/live/runtime-policy.test.ts',
      'tests/live/provider-config.test.ts',
      'tests/worker/worker.test.ts',
    ],
  },
  {
    id: 'TC-POL-003',
    requirementId: 'FDW-POL-003',
    evidencePaths: [
      'tools/live/runtimePolicyArtifact.ts',
      'vite.live.config.ts',
      'tools/live/verifyBuilds.ts',
      'tools/live/retainCandidate.ts',
      'tests/live/artifact-policy.test.ts',
      'tests/live/retain-candidate.test.ts',
    ],
  },
  {
    id: 'TC-POL-004',
    requirementId: 'FDW-POL-004',
    evidencePaths: [
      'public/_headers',
      'worker/responsePolicy.ts',
      'tests/live/artifact-policy.test.ts',
      'tests/worker/worker.test.ts',
      'tests/live-browser/live-flow.spec.ts',
      'tests/live-browser/m34-entry-artifact.spec.ts',
    ],
  },
  {
    id: 'TC-POL-005',
    requirementId: 'FDW-POL-005',
    evidencePaths: [
      'src/live/runtimePolicy.ts',
      'worker/regionalFeedHub.ts',
      'tests/worker/worker.test.ts',
      'tests/worker/polling.test.ts',
      'tests/live-browser/replay-evidence.spec.ts',
    ],
  },
  {
    id: 'TC-POL-006',
    requirementId: 'FDW-POL-006',
    evidencePaths: [
      'src/live/runtimePolicy.ts',
      'worker/index.ts',
      'worker/providerConfig.ts',
      'worker/mapAssets.ts',
      'tools/live/buildConfig.ts',
      'tests/live/runtime-policy.test.ts',
      'tests/live/admission.test.ts',
    ],
  },
  {
    id: 'TC-POL-007',
    requirementId: 'FDW-POL-007',
    evidencePaths: [
      'docs/operations/manifest.json',
      'docs/operations/candidate-retention.json',
      'docs/operations/disablement.json',
      'docs/operations/internal-fault.json',
      'docs/operations/provider-term-hold.json',
      'docs/operations/quota-hold.json',
      'docs/operations/recovery.json',
      'docs/operations/rollback.json',
      'docs/operations/stale-feed.json',
      'tools/live/verifyRunbooks.ts',
      'tools/live/rehearseRunbooks.ts',
      'tools/live/rehearseCandidateRunbooks.ts',
      'tests/live/runbook-policy.test.ts',
      'tests/live/runbook-rehearsal.test.ts',
      'tests/live/rehearse-candidate-runbooks.test.ts',
      'tests/live/workflow-policy.test.ts',
    ],
  },
  {
    id: 'TC-POL-008',
    requirementId: 'FDW-POL-008',
    evidencePaths: [
      '.github/workflows/v3-release-preflight.yml',
      '.github/workflows/ci.yml',
      'tools/live/verifyBuilds.ts',
      'tools/live/verifyBrowserBudgets.ts',
      'tools/live/runBrowserPerformance.ts',
      'tools/live/performanceReporter.ts',
      'tools/live/rehearseCandidateRunbooks.ts',
      'tools/live/recordCandidateAcceptance.ts',
      'playwright.performance.config.ts',
      'playwright.visual.config.ts',
      'vite.performance.config.ts',
      'tests/live/browser-budgets.test.ts',
      'tests/live/rehearse-candidate-runbooks.test.ts',
      'tests/live/workflow-policy.test.ts',
      'tests/live/candidate-acceptance.test.ts',
      'tests/live-browser/performanceHarness.tsx',
      'tests/live-browser/performance.spec.ts',
      'tests/live-browser/visual-regression.spec.ts',
      'tests/live-browser/visual-regression.spec.ts-snapshots/design-a-overview-desktop.png',
      'tests/live-browser/visual-regression.spec.ts-snapshots/design-a-overview-mobile.png',
      'tests/live-browser/visual-regression.spec.ts-snapshots/design-b-investigation-desktop.png',
      'tests/live-browser/visual-regression.spec.ts-snapshots/design-b-investigation-mobile.png',
      'tests/live-browser/m34-entry-artifact.spec.ts',
    ],
  },
] as const satisfies readonly SelectedTestCase[];

const SELECTED_AREAS = [
  {
    area: 'live-airspace-operational-evidence',
    requirementIds: OPERATIONAL_TEST_CASES.map(({ requirementId }) => requirementId),
    testCases: OPERATIONAL_TEST_CASES,
  },
  {
    area: 'live-airspace-runtime-release-policy',
    requirementIds: POLICY_TEST_CASES.map(({ requirementId }) => requirementId),
    testCases: POLICY_TEST_CASES,
  },
] as const satisfies readonly SelectedArea[];

const CONTRACT_PATHS = [
  'requirements/requirements.md',
  'requirements/test-cases.md',
  'requirements/traceability.json',
] as const;

const SELECTION_BASIS_PATHS = [
  'hardening/r3/context.md',
  'hardening/r3/hardening.json',
  'hardening/r3/hardening.md',
  'hardening/r3/proposals/operational-evidence.md',
  'hardening/r3/proposals/runtime-policy.md',
] as const;

export const selectedR3Contract = {
  optionIds: SELECTED_OPTION_IDS,
  authorityBoundary: AUTHORITY_BOUNDARY,
  areas: SELECTED_AREAS,
  contractPaths: CONTRACT_PATHS,
  selectionBasisPaths: SELECTION_BASIS_PATHS,
} as const;

interface TraceabilityMapping {
  readonly area?: unknown;
  readonly requirements?: unknown;
  readonly tests?: unknown;
  readonly evidencePaths?: unknown;
}

interface TraceabilityDocument {
  readonly schemaVersion?: unknown;
  readonly mappings?: unknown;
}

interface FileIdentity {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface SourceContentIdentity {
  readonly schemaVersion: typeof SOURCE_SCHEMA_VERSION;
  readonly excludedPaths: readonly string[];
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly missingTrackedFileCount: number;
  readonly trackedWorktreeMismatchCount: number;
  readonly untrackedFileCount: number;
  readonly indexDiffersFromHead: boolean;
  readonly sha256: string;
}

export interface SelectedR3EvidenceManifest {
  readonly schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  readonly selection: {
    readonly status: 'approved_for_local_implementation';
    readonly optionIds: readonly string[];
    readonly authorityBoundary: string;
  };
  readonly contract: {
    readonly requirementIds: readonly string[];
    readonly testCases: readonly {
      readonly id: string;
      readonly requirementId: string;
      readonly evidencePaths: readonly string[];
    }[];
    readonly traceabilityAreas: readonly {
      readonly area: string;
      readonly requirementIds: readonly string[];
      readonly testIds: readonly string[];
      readonly evidencePaths: readonly string[];
    }[];
  };
  readonly source: {
    readonly baseHead: string;
    readonly dirty: boolean;
    readonly content: SourceContentIdentity;
  };
  readonly evidence: {
    readonly digestFormat: 'sha256(sorted UTF-8 `<path>|<sha256>\\n` lines)';
    readonly scope: readonly string[];
    readonly exclusions: readonly string[];
    readonly fileCount: number;
    readonly totalBytes: number;
    readonly collectionSha256: string;
    readonly files: readonly FileIdentity[];
  };
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareNames);
}

function exactArray(actual: unknown, expected: readonly string[], label: string): void {
  if (!Array.isArray(actual) || actual.some((value) => typeof value !== 'string')) {
    throw new Error(`${label} must be an array of strings.`);
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} does not match the pinned selected-R3 contract.`);
  }
}

function normalizeRepositoryPath(path: string, label: string): string {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`${label} must be a normalized repository-relative path: ${path}`);
  }
  return path;
}

function repositoryPath(repositoryRoot: string, path: string, label: string): string {
  const normalized = normalizeRepositoryPath(path, label);
  const absolute = resolve(repositoryRoot, ...normalized.split('/'));
  const relativePath = relative(repositoryRoot, absolute);
  if (
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`${label} escapes the repository: ${path}`);
  }
  return absolute;
}

function requiredRegularFile(repositoryRoot: string, path: string, label: string): string {
  const absolute = repositoryPath(repositoryRoot, path, label);
  let status;
  try {
    status = lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label} does not exist: ${path}`, { cause: error });
    }
    throw error;
  }
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file: ${path}`);
  }
  const realRoot = realpathSync(repositoryRoot);
  const realFile = realpathSync(absolute);
  const realRelative = relative(realRoot, realFile);
  if (realRelative === '..' || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) {
    throw new Error(`${label} resolves outside the repository: ${path}`);
  }
  return absolute;
}

function sha256(contents: Uint8Array | string): string {
  return createHash('sha256').update(contents).digest('hex');
}

function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
}

function selectedRequirementIds(): string[] {
  return SELECTED_AREAS.flatMap(({ requirementIds }) => [...requirementIds]);
}

function selectedTestCases(): SelectedTestCase[] {
  return SELECTED_AREAS.flatMap(({ testCases }) => [...testCases]);
}

function selectedAreaEvidencePaths(area: SelectedArea): string[] {
  return uniqueSorted(area.testCases.flatMap(({ evidencePaths }) => [...evidencePaths]));
}

function parseSelectedIds(text: string, prefix: 'FDW' | 'TC'): string[] {
  const pattern =
    prefix === 'FDW' ? /\|\s*(FDW-(?:OPS|POL)-\d{3})\s*\|/gu : /\|\s*(TC-(?:OPS|POL)-\d{3})\s*\|/gu;
  return [...text.matchAll(pattern)].map((match) => match[1]!).sort(compareNames);
}

function parseTestCaseEvidencePaths(text: string, testId: string): string[] {
  const rows = text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('|') && line.split('|')[1]?.trim() === testId);
  if (rows.length !== 1) {
    throw new Error(`${testId} must have exactly one declared test-case row.`);
  }
  const cells = rows[0]!.split('|');
  if (cells.length < 5) throw new Error(`${testId} is not a complete Markdown table row.`);
  const evidenceCell = cells.at(-2)?.trim() ?? '';
  if (!evidenceCell.startsWith('Linked:')) {
    throw new Error(`${testId} must declare a Linked evidence cell.`);
  }
  return [...evidenceCell.matchAll(/`([^`]+)`/gu)].map((match) => match[1]!);
}

function validateSelectionRecord(repositoryRoot: string): void {
  const path = requiredRegularFile(
    repositoryRoot,
    'hardening/r3/hardening.json',
    'R3 selection record',
  );
  const value = readJson(path, 'R3 selection record');
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('R3 selection record must be an object.');
  }
  const record = value as {
    selection?: { status?: unknown; selectedOptionIds?: unknown };
    recommendedOptionIds?: unknown;
  };
  if (record.selection?.status !== 'approved_for_local_implementation') {
    throw new Error('R3 selection record does not authorize the pinned local implementation.');
  }
  exactArray(record.selection.selectedOptionIds, SELECTED_OPTION_IDS, 'Selected R3 option IDs');
  exactArray(record.recommendedOptionIds, SELECTED_OPTION_IDS, 'Recommended R3 option IDs');
}

export function validateSelectedR3Contract(repositoryRoot: string): void {
  const requirementsText = readFileSync(
    requiredRegularFile(
      repositoryRoot,
      'requirements/requirements.md',
      'Selected R3 requirements document',
    ),
    'utf8',
  );
  const testCasesText = readFileSync(
    requiredRegularFile(
      repositoryRoot,
      'requirements/test-cases.md',
      'Selected R3 test-cases document',
    ),
    'utf8',
  );
  const traceabilityPath = requiredRegularFile(
    repositoryRoot,
    'requirements/traceability.json',
    'Selected R3 traceability matrix',
  );
  const traceability = readJson(
    traceabilityPath,
    'Selected R3 traceability matrix',
  ) as TraceabilityDocument;

  exactArray(
    parseSelectedIds(requirementsText, 'FDW'),
    [...selectedRequirementIds()].sort(compareNames),
    'Declared selected R3 requirement IDs',
  );
  exactArray(
    parseSelectedIds(testCasesText, 'TC'),
    selectedTestCases()
      .map(({ id }) => id)
      .sort(compareNames),
    'Declared selected R3 test IDs',
  );

  for (const testCase of selectedTestCases()) {
    exactArray(
      parseTestCaseEvidencePaths(testCasesText, testCase.id),
      testCase.evidencePaths,
      `${testCase.id} evidence paths`,
    );
    for (const path of testCase.evidencePaths) {
      requiredRegularFile(repositoryRoot, path, `${testCase.id} evidence path`);
    }
  }

  if (traceability.schemaVersion !== '1.0.0' || !Array.isArray(traceability.mappings)) {
    throw new Error('Selected R3 traceability matrix must use schemaVersion 1.0.0.');
  }
  const mappings = traceability.mappings as TraceabilityMapping[];
  for (const area of SELECTED_AREAS) {
    const matches = mappings.filter((mapping) => mapping.area === area.area);
    if (matches.length !== 1) {
      throw new Error(`${area.area} must have exactly one traceability mapping.`);
    }
    const mapping = matches[0]!;
    exactArray(mapping.requirements, area.requirementIds, `${area.area} requirement IDs`);
    exactArray(
      mapping.tests,
      area.testCases.map(({ id }) => id),
      `${area.area} test IDs`,
    );
    exactArray(
      mapping.evidencePaths,
      selectedAreaEvidencePaths(area),
      `${area.area} evidence paths`,
    );
  }

  validateSelectionRecord(repositoryRoot);
}

function fileIdentity(repositoryRoot: string, path: string): FileIdentity {
  const absolute = requiredRegularFile(repositoryRoot, path, 'Selected R3 inventory path');
  const contents = readFileSync(absolute);
  return { path, bytes: contents.byteLength, sha256: sha256(contents) };
}

function inventoryPaths(): string[] {
  return uniqueSorted([
    ...CONTRACT_PATHS,
    ...SELECTION_BASIS_PATHS,
    ...selectedTestCases().flatMap(({ evidencePaths }) => [...evidencePaths]),
  ]);
}

function evidenceInventory(repositoryRoot: string): {
  files: FileIdentity[];
  totalBytes: number;
  collectionSha256: string;
} {
  const files = inventoryPaths().map((path) => fileIdentity(repositoryRoot, path));
  const collection = files.map((file) => `${file.path}|${file.sha256}\n`).join('');
  return {
    files,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    collectionSha256: sha256(collection),
  };
}

function git(repositoryRoot: string, arguments_: readonly string[]): Buffer {
  return execFileSync('git', arguments_, {
    cwd: repositoryRoot,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
}

function nulList(contents: Buffer, label: string): string[] {
  if (contents.byteLength === 0) return [];
  if (contents.at(-1) !== 0) throw new Error(`${label} must be NUL terminated.`);
  return contents
    .subarray(0, -1)
    .toString('utf8')
    .split('\0')
    .map((path) => normalizeRepositoryPath(path, label));
}

interface TrackedEntry {
  readonly path: string;
  readonly mode: '100644' | '100755';
  readonly objectId: string;
}

function trackedEntries(repositoryRoot: string): TrackedEntry[] {
  const entries = nulList(git(repositoryRoot, ['ls-files', '--stage', '-z']), 'Git index').map(
    (entry) => {
      const separator = entry.indexOf('\t');
      if (separator <= 0) throw new Error('Git returned an invalid index entry.');
      const [mode, objectId, stage, ...extra] = entry.slice(0, separator).split(' ');
      const path = normalizeRepositoryPath(entry.slice(separator + 1), 'Git index path');
      if (
        (mode !== '100644' && mode !== '100755') ||
        objectId === undefined ||
        !GIT_OBJECT_PATTERN.test(objectId) ||
        stage !== '0' ||
        extra.length > 0
      ) {
        throw new Error(`Selected R3 source requires a regular, unmerged Git entry: ${path}`);
      }
      return { path, mode: mode as TrackedEntry['mode'], objectId };
    },
  );
  entries.sort((left, right) => compareNames(left.path, right.path));
  if (new Set(entries.map(({ path }) => path)).size !== entries.length) {
    throw new Error('Git returned duplicate tracked source paths.');
  }
  return entries;
}

function gitDiffers(repositoryRoot: string, arguments_: readonly string[]): boolean {
  const result = spawnSync('git', arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status === 0) return false;
  if (result.status === 1) return true;
  throw new Error(
    `Git command failed (${arguments_.join(' ')}): ${result.stderr.trim() || 'unknown error'}`,
  );
}

function sourceContentIdentity(
  repositoryRoot: string,
  excludedPath: string,
): SourceContentIdentity {
  const excludedPaths = [normalizeRepositoryPath(excludedPath, 'Manifest exclusion')];
  const excluded = new Set(excludedPaths);
  const objectFormat = git(repositoryRoot, ['rev-parse', '--show-object-format'])
    .toString('utf8')
    .trim();
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
    throw new Error(`Unsupported Git object format: ${objectFormat}`);
  }
  const fileModeEnforced =
    git(repositoryRoot, ['config', '--type=bool', '--default=true', 'core.fileMode'])
      .toString('utf8')
      .trim() === 'true';
  const tracked = trackedEntries(repositoryRoot).filter(({ path }) => !excluded.has(path));
  const trackedPaths = new Set(tracked.map(({ path }) => path));
  const untracked = nulList(
    git(repositoryRoot, ['ls-files', '--others', '--exclude-standard', '-z']),
    'Git untracked paths',
  )
    .filter((path) => !excluded.has(path))
    .sort(compareNames);
  if (untracked.some((path) => trackedPaths.has(path))) {
    throw new Error('Git returned a path as both tracked and untracked.');
  }

  const hash = createHash('sha256');
  hash.update(`${SOURCE_SCHEMA_VERSION}\0${objectFormat}\0`);
  let fileCount = 0;
  let totalBytes = 0;
  let missingTrackedFileCount = 0;
  let trackedWorktreeMismatchCount = 0;

  for (const entry of tracked) {
    const absolute = repositoryPath(repositoryRoot, entry.path, 'Tracked source path');
    hash.update(`tracked\0${entry.path}\0${entry.mode}\0${entry.objectId}\0`);
    if (!existsSync(absolute)) {
      missingTrackedFileCount += 1;
      trackedWorktreeMismatchCount += 1;
      hash.update('missing\0');
      continue;
    }
    const status = lstatSync(absolute);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new Error(`Tracked selected-R3 source must be a regular file: ${entry.path}`);
    }
    const contents = readFileSync(absolute);
    const contentsSha256 = sha256(contents);
    const objectId = createHash(objectFormat)
      .update(`blob ${contents.byteLength}\0`)
      .update(contents)
      .digest('hex');
    const worktreeMode = fileModeEnforced
      ? (status.mode & 0o111) !== 0
        ? '100755'
        : '100644'
      : entry.mode;
    if (objectId !== entry.objectId || worktreeMode !== entry.mode) {
      trackedWorktreeMismatchCount += 1;
    }
    fileCount += 1;
    totalBytes += contents.byteLength;
    hash.update(`file\0${worktreeMode}\0${contents.byteLength}\0${contentsSha256}\0`);
  }

  for (const path of untracked) {
    const absolute = requiredRegularFile(repositoryRoot, path, 'Untracked selected-R3 source');
    const contents = readFileSync(absolute);
    const contentsSha256 = sha256(contents);
    fileCount += 1;
    totalBytes += contents.byteLength;
    hash.update(`untracked\0${path}\0${contents.byteLength}\0${contentsSha256}\0`);
  }

  const indexDiffersFromHead = gitDiffers(repositoryRoot, [
    'diff',
    '--cached',
    '--quiet',
    'HEAD',
    '--',
  ]);
  return {
    schemaVersion: SOURCE_SCHEMA_VERSION,
    excludedPaths,
    fileCount,
    totalBytes,
    missingTrackedFileCount,
    trackedWorktreeMismatchCount,
    untrackedFileCount: untracked.length,
    indexDiffersFromHead,
    sha256: hash.digest('hex'),
  };
}

function captureSource(
  repositoryRoot: string,
  manifestPath: string,
): SelectedR3EvidenceManifest['source'] {
  const baseHead = git(repositoryRoot, ['rev-parse', '--verify', 'HEAD']).toString('utf8').trim();
  if (!GIT_OBJECT_PATTERN.test(baseHead))
    throw new Error(`Git returned an invalid HEAD: ${baseHead}`);
  const content = sourceContentIdentity(repositoryRoot, manifestPath);
  const dirty =
    content.indexDiffersFromHead ||
    content.trackedWorktreeMismatchCount > 0 ||
    content.untrackedFileCount > 0;
  return { baseHead, dirty, content };
}

function sameSource(
  left: SelectedR3EvidenceManifest['source'],
  right: SelectedR3EvidenceManifest['source'],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return (
    JSON.stringify(Object.keys(value).sort(compareNames)) ===
    JSON.stringify([...expected].sort(compareNames))
  );
}

function storedManifestSource(text: string): SelectedR3EvidenceManifest['source'] | null {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return null;
  const source = (document as Record<string, unknown>).source;
  if (
    typeof source !== 'object' ||
    source === null ||
    Array.isArray(source) ||
    !exactObjectKeys(source as Record<string, unknown>, ['baseHead', 'content', 'dirty'])
  ) {
    return null;
  }
  const sourceRecord = source as Record<string, unknown>;
  const content = sourceRecord.content;
  if (
    typeof sourceRecord.baseHead !== 'string' ||
    !GIT_OBJECT_PATTERN.test(sourceRecord.baseHead) ||
    typeof sourceRecord.dirty !== 'boolean' ||
    typeof content !== 'object' ||
    content === null ||
    Array.isArray(content) ||
    !exactObjectKeys(content as Record<string, unknown>, [
      'excludedPaths',
      'fileCount',
      'indexDiffersFromHead',
      'missingTrackedFileCount',
      'schemaVersion',
      'sha256',
      'totalBytes',
      'trackedWorktreeMismatchCount',
      'untrackedFileCount',
    ])
  ) {
    return null;
  }
  const contentRecord = content as Record<string, unknown>;
  const excludedPaths = contentRecord.excludedPaths;
  const integerFields = [
    'fileCount',
    'totalBytes',
    'missingTrackedFileCount',
    'trackedWorktreeMismatchCount',
    'untrackedFileCount',
  ] as const;
  if (
    contentRecord.schemaVersion !== SOURCE_SCHEMA_VERSION ||
    !Array.isArray(excludedPaths) ||
    excludedPaths.some((path) => typeof path !== 'string') ||
    integerFields.some(
      (field) => !Number.isSafeInteger(contentRecord[field]) || Number(contentRecord[field]) < 0,
    ) ||
    typeof contentRecord.indexDiffersFromHead !== 'boolean' ||
    typeof contentRecord.sha256 !== 'string' ||
    !SHA256_PATTERN.test(contentRecord.sha256)
  ) {
    return null;
  }
  return {
    baseHead: sourceRecord.baseHead,
    dirty: sourceRecord.dirty,
    content: {
      schemaVersion: SOURCE_SCHEMA_VERSION,
      excludedPaths: [...excludedPaths] as string[],
      fileCount: Number(contentRecord.fileCount),
      totalBytes: Number(contentRecord.totalBytes),
      missingTrackedFileCount: Number(contentRecord.missingTrackedFileCount),
      trackedWorktreeMismatchCount: Number(contentRecord.trackedWorktreeMismatchCount),
      untrackedFileCount: Number(contentRecord.untrackedFileCount),
      indexDiffersFromHead: contentRecord.indexDiffersFromHead,
      sha256: contentRecord.sha256,
    },
  };
}

function sameCommittedContent(
  staged: SourceContentIdentity,
  committed: SourceContentIdentity,
): boolean {
  return (
    staged.schemaVersion === committed.schemaVersion &&
    JSON.stringify(staged.excludedPaths) === JSON.stringify(committed.excludedPaths) &&
    staged.fileCount === committed.fileCount &&
    staged.totalBytes === committed.totalBytes &&
    staged.missingTrackedFileCount === committed.missingTrackedFileCount &&
    staged.trackedWorktreeMismatchCount === committed.trackedWorktreeMismatchCount &&
    staged.untrackedFileCount === committed.untrackedFileCount &&
    staged.sha256 === committed.sha256
  );
}

interface TreeBlobEntry {
  readonly mode: '100644' | '100755';
  readonly objectId: string;
}

function treeBlobEntry(
  repositoryRoot: string,
  revision: string,
  path: string,
): TreeBlobEntry | null {
  const normalizedPath = normalizeRepositoryPath(path, 'Manifest tree path');
  const result = git(repositoryRoot, ['ls-tree', '-z', revision, '--', normalizedPath]);
  if (result.byteLength === 0) return null;
  if (result.at(-1) !== 0 || result.subarray(0, -1).includes(0)) return null;
  const entry = result.subarray(0, -1).toString('utf8');
  const separator = entry.indexOf('\t');
  if (separator <= 0 || entry.slice(separator + 1) !== normalizedPath) return null;
  const [mode, type, objectId, ...extra] = entry.slice(0, separator).split(' ');
  if (
    (mode !== '100644' && mode !== '100755') ||
    type !== 'blob' ||
    objectId === undefined ||
    !GIT_OBJECT_PATTERN.test(objectId) ||
    extra.length > 0
  ) {
    return null;
  }
  return { mode, objectId };
}

function commitParents(repositoryRoot: string, revision: string): string[] {
  const headers = git(repositoryRoot, ['cat-file', '-p', revision])
    .toString('utf8')
    .split(/\r?\n\r?\n/u, 1)[0]
    ?.split(/\r?\n/u);
  if (headers === undefined) return [];
  const parents: string[] = [];
  for (const header of headers) {
    if (!header.startsWith('parent ')) continue;
    const parent = header.slice('parent '.length);
    if (!GIT_OBJECT_PATTERN.test(parent)) return [];
    parents.push(parent);
  }
  return parents;
}

function manifestSealedByChild(
  repositoryRoot: string,
  manifestPath: string,
  actualText: string,
  stagedBaseHead: string,
  committedHead: string,
): boolean {
  const childEntry = treeBlobEntry(repositoryRoot, committedHead, manifestPath);
  if (childEntry === null) return false;
  const parentEntry = treeBlobEntry(repositoryRoot, stagedBaseHead, manifestPath);
  if (
    parentEntry !== null &&
    parentEntry.mode === childEntry.mode &&
    parentEntry.objectId === childEntry.objectId
  ) {
    return false;
  }
  const committedContents = git(repositoryRoot, ['show', `${committedHead}:${manifestPath}`]);
  return committedContents.equals(Buffer.from(actualText, 'utf8'));
}

function isExactCleanChildTransition(
  repositoryRoot: string,
  staged: SelectedR3EvidenceManifest['source'],
  committed: SelectedR3EvidenceManifest['source'],
): boolean {
  if (
    !staged.dirty ||
    !staged.content.indexDiffersFromHead ||
    staged.content.missingTrackedFileCount !== 0 ||
    staged.content.trackedWorktreeMismatchCount !== 0 ||
    staged.content.untrackedFileCount !== 0 ||
    committed.dirty ||
    committed.content.indexDiffersFromHead ||
    committed.content.missingTrackedFileCount !== 0 ||
    committed.content.trackedWorktreeMismatchCount !== 0 ||
    committed.content.untrackedFileCount !== 0 ||
    !sameCommittedContent(staged.content, committed.content)
  ) {
    return false;
  }
  const parents = commitParents(repositoryRoot, committed.baseHead);
  return parents.length === 1 && parents[0] === staged.baseHead;
}

export function createSelectedR3EvidenceManifest(
  repositoryRoot: string,
  manifestPath = DEFAULT_MANIFEST_PATH,
): SelectedR3EvidenceManifest {
  validateSelectedR3Contract(repositoryRoot);
  const sourceBefore = captureSource(repositoryRoot, manifestPath);
  const inventory = evidenceInventory(repositoryRoot);
  validateSelectedR3Contract(repositoryRoot);
  const sourceAfter = captureSource(repositoryRoot, manifestPath);
  if (!sameSource(sourceBefore, sourceAfter)) {
    throw new Error('Selected R3 source changed while the evidence manifest was being captured.');
  }
  const testCases = selectedTestCases().map(({ id, requirementId, evidencePaths }) => ({
    id,
    requirementId,
    evidencePaths: [...evidencePaths],
  }));
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    selection: {
      status: 'approved_for_local_implementation',
      optionIds: [...SELECTED_OPTION_IDS],
      authorityBoundary: AUTHORITY_BOUNDARY,
    },
    contract: {
      requirementIds: selectedRequirementIds(),
      testCases,
      traceabilityAreas: SELECTED_AREAS.map((area) => ({
        area: area.area,
        requirementIds: [...area.requirementIds],
        testIds: area.testCases.map(({ id }) => id),
        evidencePaths: selectedAreaEvidencePaths(area),
      })),
    },
    source: sourceBefore,
    evidence: {
      digestFormat: 'sha256(sorted UTF-8 `<path>|<sha256>\\n` lines)',
      scope: [
        'The two options approved for local R3 implementation.',
        'The exact FDW-OPS-001..008 and FDW-POL-001..008 requirement rows.',
        'The exact TC-OPS-001..008 and TC-POL-001..008 rows and their regular-file evidence paths.',
        'The selected hardening record and proposal basis.',
        'The current non-ignored Git source content, excluding only this self-referential generated manifest.',
      ],
      exclusions: [
        'Ignored build outputs, dependency caches, test outputs, credentials, and local temporary files.',
        'Cloudflare account state, hosted routes, billing, platform observability, and deployment evidence.',
        'Provider terms, provider contact, authorization for real-aircraft access, and real-source captures.',
        'Commit, push, hosted CI, retained-candidate, release, deployment, and publication proof.',
      ],
      fileCount: inventory.files.length,
      totalBytes: inventory.totalBytes,
      collectionSha256: inventory.collectionSha256,
      files: inventory.files,
    },
  };
}

function serializedManifest(manifest: SelectedR3EvidenceManifest): Promise<string> {
  return format(JSON.stringify(manifest), {
    parser: 'json',
    printWidth: 100,
    singleQuote: true,
    trailingComma: 'all',
    semi: true,
    endOfLine: 'lf',
  });
}

export async function writeSelectedR3EvidenceManifest(
  repositoryRoot: string,
  manifestPath = DEFAULT_MANIFEST_PATH,
): Promise<SelectedR3EvidenceManifest> {
  const normalizedPath = normalizeRepositoryPath(manifestPath, 'Selected R3 manifest path');
  const outputPath = repositoryPath(repositoryRoot, normalizedPath, 'Selected R3 manifest path');
  if (!existsSync(dirname(outputPath))) {
    throw new Error('Selected R3 manifest parent directory does not exist.');
  }
  const manifest = createSelectedR3EvidenceManifest(repositoryRoot, normalizedPath);
  writeFileSync(outputPath, await serializedManifest(manifest), { encoding: 'utf8', flag: 'w' });
  return manifest;
}

export async function verifySelectedR3EvidenceManifest(
  repositoryRoot: string,
  manifestPath = DEFAULT_MANIFEST_PATH,
): Promise<SelectedR3EvidenceManifest> {
  const normalizedPath = normalizeRepositoryPath(manifestPath, 'Selected R3 manifest path');
  const absolutePath = requiredRegularFile(
    repositoryRoot,
    normalizedPath,
    'Selected R3 evidence manifest',
  );
  const expected = createSelectedR3EvidenceManifest(repositoryRoot, normalizedPath);
  const actualText = readFileSync(absolutePath, 'utf8');
  const expectedText = await serializedManifest(expected);
  let verified = expected;
  if (actualText !== expectedText) {
    const stagedSource = storedManifestSource(actualText);
    if (stagedSource === null) {
      throw new Error(
        'Selected R3 evidence manifest is stale or does not match the pinned contract. Run pnpm r3:evidence:refresh after all source changes are complete.',
      );
    }
    const committedCandidate = { ...expected, source: stagedSource };
    if (
      actualText !== (await serializedManifest(committedCandidate)) ||
      !isExactCleanChildTransition(repositoryRoot, stagedSource, expected.source) ||
      !manifestSealedByChild(
        repositoryRoot,
        normalizedPath,
        actualText,
        stagedSource.baseHead,
        expected.source.baseHead,
      )
    ) {
      throw new Error(
        'Selected R3 evidence manifest is stale or does not match the pinned contract. Run pnpm r3:evidence:refresh after all source changes are complete.',
      );
    }
    verified = committedCandidate;
  }
  if (!SHA256_PATTERN.test(verified.evidence.collectionSha256)) {
    throw new Error('Selected R3 evidence collection digest is invalid.');
  }
  return verified;
}

export { DEFAULT_MANIFEST_PATH };
