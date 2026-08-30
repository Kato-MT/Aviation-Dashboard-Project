import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import mapManifest from '../../maps/manifest.json';
import { compileRuntimePolicy } from '../../src/live/runtimePolicy';
import { describeLiveSource } from '../../src/live/source';
import { OPERATIONS_LIMITATIONS, operationsWindowStarts } from '../../src/operations/contract';
import {
  G2_AGGREGATE_RECEIPT_VERSION,
  G2_EVIDENCE_MANIFEST_VERSION,
  G2_EVIDENCE_POLICY,
  G2_RETAINED_FILES,
  OPERATIONS_PRIVACY_AUDIT_VERSION,
  OPERATIONS_PRIVACY_INVENTORY_VERSION,
  PRIVACY_TREE_IDENTITY_VERSION,
  OperationsPrivacyAuditError,
  assertDurableObjectStoragePrivacy,
  assertG2AggregateArtifacts,
  assertHibernationAttachmentPrivacy,
  auditG2EvidenceDirectory,
  auditOperationsPrivacy,
  auditPrivacyTree,
  privacyTreeExpectedIdentity,
  type AggregateArtifactSet,
  type AggregateEvidenceDirectoryDeclaration,
  type G2AggregateReceiptV1,
  type G2EvidenceManifestV1,
  type G2ExpectedIdentity,
  type OperationsPrivacyInventoryV1,
  type PrivacyTreeDeclaration,
  type PrivacyTreeExpectedIdentity,
} from '../../tools/live/operationsPrivacyAudit';

const roots: string[] = [];
const CHECKED_AT = '2026-08-29T16:30:00.000Z';
const POLICY_ID = 'a'.repeat(64);
const CANDIDATE_ID = 'b'.repeat(64);
const SOURCE_HEAD = 'c'.repeat(40);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function counters(accounting: 'best-effort' | 'exact', trailing: boolean) {
  return {
    provider: {
      accounting,
      pollCount: trailing ? 4 : 1,
      successCount: trailing ? 3 : 1,
      failureCount: trailing ? 1 : 0,
      rateLimitCount: trailing ? 1 : 0,
    },
    validation: {
      accounting,
      acceptedSnapshotCount: trailing ? 3 : 1,
      rejectedSnapshotCount: trailing ? 1 : 0,
      invalidFieldCount: trailing ? 2 : 0,
    },
    delivery: {
      accounting: 'best-effort',
      acknowledgmentCount: trailing ? 3 : 1,
      timeoutCount: trailing ? 1 : 0,
      sendFailureCount: 0,
      invalidControlCount: 0,
      hibernationLossCount: 0,
    },
  };
}

function operationsValue(): Record<string, any> {
  const starts = operationsWindowStarts(CHECKED_AT);
  const windows = {
    currentHour: {
      startedAt: starts.currentHour,
      ...counters('exact', false),
    },
    trailing24Hours: {
      startedAt: starts.trailing24Hours,
      ...counters('best-effort', true),
    },
  };
  const region = (regionId: string) => ({
    regionId,
    availability: { state: 'available', reasonCodes: ['REGION_AVAILABLE'] },
    provider: { state: 'live', reasonCodes: ['PROVIDER_LIVE'] },
    delivery: { state: 'healthy', reasonCodes: ['DELIVERY_HEALTHY'] },
    freshness: {
      state: 'current',
      reasonCodes: ['FRESHNESS_CURRENT'],
      observationAgeSeconds: 10,
    },
    windows: structuredClone(windows),
  });
  return {
    schemaVersion: 'operations.v1',
    identity: {
      applicationVersion: '3.0.0-dev',
      releaseSha: 'local-unreleased',
      source: { ...describeLiveSource('local-mock', 'mock') },
      policyId: POLICY_ID,
    },
    checkedAt: CHECKED_AT,
    application: { state: 'available', reasonCodes: ['APPLICATION_AVAILABLE'] },
    admission: {
      state: 'accepting',
      reasonCodes: ['ADMISSION_ACCEPTING'],
      scope: 'worker-isolate',
      windows: {
        currentHour: {
          startedAt: starts.currentHour,
          counters: {
            accounting: 'best-effort',
            acceptedCount: 1,
            rateLimitRejectionCount: 0,
            capacityRejectionCount: 0,
          },
        },
        trailing24Hours: {
          startedAt: starts.trailing24Hours,
          counters: {
            accounting: 'best-effort',
            acceptedCount: 4,
            rateLimitRejectionCount: 1,
            capacityRejectionCount: 0,
          },
        },
      },
    },
    limitations: { ...OPERATIONS_LIMITATIONS },
    regions: [region('atlanta'), region('savannah-statesboro'), region('central-georgia')],
  };
}

function metricRow() {
  return {
    metricsVersion: 'operations-metrics.v1',
    hour: '2026-08-29T16:00:00.000Z',
    pollCount: 3,
    successCount: 2,
    failureCount: 1,
    rateLimitCount: 1,
    acceptedSnapshotCount: 2,
    rejectedSnapshotCount: 1,
    invalidFieldCount: 2,
    deliveryAcknowledgmentCount: 2,
    deliveryTimeoutCount: 0,
    deliverySendFailureCount: 0,
    deliveryInvalidControlCount: 0,
    deliveryHibernationLossCount: 0,
    aircraftCountSum: 17,
    aircraftCountMinimum: 7,
    aircraftCountMaximum: 10,
    latencyBuckets: {
      under250Ms: 1,
      under500Ms: 1,
      under1000Ms: 0,
      under2500Ms: 0,
      over2500Ms: 1,
    },
  };
}

function durableStorage(): Record<string, unknown> {
  return {
    'state:regionId': 'atlanta',
    'state:providerId': 'local-mock',
    'state:feedEpoch': 'feed-epoch-1',
    'state:sequence': 3,
    'state:consecutiveFailures': 0,
    'state:nextPollAt': Date.parse(CHECKED_AT),
    'state:retryBlocked': false,
    'state:lastSuccessAt': CHECKED_AT,
    'state:lastProviderGeneratedAt': CHECKED_AT,
    'metrics:2026-08-29T16:00:00.000Z': metricRow(),
  };
}

function hibernationAttachment(): Record<string, unknown> {
  return {
    attachmentVersion: 'delivery.v1',
    providerId: 'local-mock',
    regionId: 'atlanta',
    feedEpoch: 'feed-epoch-1',
    pending: 0,
    lastTurn: 1,
    outstanding: {
      deliveryId: 'delivery-1',
      expiresAt: Date.parse(CHECKED_AT) + 10_000,
      bytes: 512,
      sent: true,
    },
  };
}

function g2Manifest(): G2EvidenceManifestV1 {
  return {
    schemaVersion: G2_EVIDENCE_MANIFEST_VERSION,
    auditSchemaVersion: OPERATIONS_PRIVACY_AUDIT_VERSION,
    evidencePolicy: G2_EVIDENCE_POLICY,
    candidateId: CANDIDATE_ID,
    policyId: POLICY_ID,
    sourceHead: SOURCE_HEAD,
    expectedFiles: G2_RETAINED_FILES,
    capture: {
      screenshots: false,
      traces: false,
      video: false,
      har: false,
      responseBodies: false,
      retries: 0,
      detail: 'aggregate-only',
    },
  };
}

function g2Receipt(): G2AggregateReceiptV1 {
  return {
    schemaVersion: G2_AGGREGATE_RECEIPT_VERSION,
    evidencePolicy: G2_EVIDENCE_POLICY,
    candidateId: CANDIDATE_ID,
    policyId: POLICY_ID,
    sourceHead: SOURCE_HEAD,
    result: 'pass',
    regionScope: 'three-fixed-georgia-regions',
    counters: {
      requestCount: 1,
      regionCount: 3,
      availableRegionCount: 3,
      emptyRegionCount: 2,
      nonemptyRegionCount: 1,
      failedRegionCount: 0,
      rateLimitCount: 0,
    },
    timing: { durationMs: 420, maximumObservationAgeSeconds: 12 },
    limitations: [
      'valid-empty-proves-connectivity-only',
      'nonempty-validated-observation-required-for-real-data-claim',
      'not-global-availability-proof',
    ],
  };
}

function g2Artifacts(): AggregateArtifactSet {
  return {
    artifacts: [
      { path: 'g2-aggregate-receipt.json', value: g2Receipt() },
      { path: 'g2-evidence-manifest.json', value: g2Manifest() },
    ],
  };
}

function expectedIdentity(): G2ExpectedIdentity {
  return {
    candidateId: CANDIDATE_ID,
    policyId: POLICY_ID,
    sourceHead: SOURCE_HEAD,
  };
}

async function evidenceDirectory(
  name: string,
  mode: 'empty' | 'g2-bundle',
): Promise<AggregateEvidenceDirectoryDeclaration> {
  const root = await mkdtemp(join(tmpdir(), `fdw-${name}-`));
  roots.push(root);
  if (mode === 'g2-bundle') {
    await writeFile(
      join(root, 'g2-aggregate-receipt.json'),
      `${JSON.stringify(g2Receipt(), null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      join(root, 'g2-evidence-manifest.json'),
      `${JSON.stringify(g2Manifest(), null, 2)}\n`,
      'utf8',
    );
  }
  return { root, mode };
}

async function tree(name: string, path: string, value: unknown): Promise<PrivacyTreeDeclaration> {
  const root = await mkdtemp(join(tmpdir(), `fdw-${name}-`));
  roots.push(root);
  const absolute = join(root, ...path.split('/'));
  await mkdir(join(absolute, '..'), { recursive: true });
  const text = typeof value === 'string' ? value : `${JSON.stringify(value)}\n`;
  await writeFile(absolute, text, 'utf8');
  return {
    root,
    files: [
      {
        path,
        sha256: createHash('sha256').update(text).digest('hex'),
        bytes: Buffer.byteLength(text),
      },
    ],
  };
}

async function inventory(): Promise<OperationsPrivacyInventoryV1> {
  return {
    schemaVersion: OPERATIONS_PRIVACY_INVENTORY_VERSION,
    apiValues: [operationsValue()],
    durableObjectStorageValues: [durableStorage()],
    hibernationAttachments: [hibernationAttachment()],
    browserStorage: {
      localStorage: [],
      sessionStorage: [],
      cookies: [],
      indexedDbDatabases: [],
      cacheStorageKeys: [],
      opfsEntries: [],
      serviceWorkers: [],
    },
    browserDownloads: await evidenceDirectory('browser-downloads', 'empty'),
    reports: await evidenceDirectory('reports', 'g2-bundle'),
    testResults: await evidenceDirectory('test-results', 'g2-bundle'),
    screenshotMetadata: {
      files: [],
      outputDirectory: await evidenceDirectory('screenshots', 'empty'),
    },
    retainedCandidates: [
      await tree('candidate', 'evidence/aggregate.json', {
        schemaVersion: 'candidate-aggregate.v1',
        result: 'pass',
      }),
    ],
    releases: [await tree('release', 'evidence/summary.txt', 'aggregate-only\n')],
  };
}

function selectedTreeIdentity(tree: PrivacyTreeDeclaration): PrivacyTreeExpectedIdentity {
  return privacyTreeExpectedIdentity(tree.files);
}

async function auditTree(tree: PrivacyTreeDeclaration): Promise<number> {
  return auditPrivacyTree(tree, selectedTreeIdentity(tree));
}

function auditInventory(value: OperationsPrivacyInventoryV1) {
  return auditOperationsPrivacy(value, expectedIdentity(), {
    retainedCandidates: value.retainedCandidates.map(selectedTreeIdentity),
    releases: value.releases.map(selectedTreeIdentity),
  });
}

function expectPrivacyFailure(action: () => unknown, code?: string): void {
  try {
    action();
    throw new Error('Expected privacy failure.');
  } catch (error) {
    expect(error).toBeInstanceOf(OperationsPrivacyAuditError);
    if (code) expect((error as OperationsPrivacyAuditError).code).toBe(code);
  }
}

describe('operations privacy auditor', () => {
  it('audits every required surface and returns only aggregate counts', async () => {
    const receipt = await auditInventory(await inventory());

    expect(receipt).toEqual({
      schemaVersion: OPERATIONS_PRIVACY_AUDIT_VERSION,
      evidencePolicy: G2_EVIDENCE_POLICY,
      result: 'pass',
      surfaces: {
        apiValues: 1,
        durableObjectStorageValues: 1,
        hibernationAttachments: 1,
        browserStorageEntries: 0,
        browserDownloadFiles: 0,
        reportFiles: 2,
        testResultFiles: 2,
        screenshotFiles: 0,
        retainedCandidateFiles: 1,
        releaseFiles: 1,
      },
    });
    expect(JSON.stringify(receipt)).not.toMatch(
      /aircraftId|callsign|latitude|longitude|providerPayload|requestId|userAgent|clientId/iu,
    );
  });

  it('fails closed without externally selected candidate and release commitments', async () => {
    const value = await inventory();
    await expect(auditOperationsPrivacy(value, expectedIdentity())).rejects.toMatchObject({
      code: 'INVALID_INVENTORY',
    });
    await expect(auditPrivacyTree(value.retainedCandidates[0]!)).rejects.toMatchObject({
      code: 'INVALID_INVENTORY',
    });
  });

  it('rejects unknown fields before treating a complete inventory as audited', async () => {
    const value = (await inventory()) as OperationsPrivacyInventoryV1 & { detail?: string };
    value.detail = 'not allowed';
    await expect(auditInventory(value)).rejects.toMatchObject({
      code: 'UNKNOWN_FIELD',
    });
  });

  it('refuses to issue a pass receipt for an inventory that skipped required surfaces', async () => {
    const value = (await inventory()) as unknown as { apiValues: unknown[] };
    value.apiValues = [];
    await expect(
      auditInventory(value as unknown as OperationsPrivacyInventoryV1),
    ).rejects.toMatchObject({
      code: 'INVALID_INVENTORY',
    });
  });

  it.each([
    ['aircraft identifier', 'abc123'],
    ['registration', 'N123AB'],
    ['callsign', 'DAL123'],
    ['IP address', '192.0.2.25'],
    ['complete URL', 'https://provider.example/aircraft'],
    ['coordinate pair', '33.7488,-84.3880'],
    ['user agent', 'Mozilla/5.0'],
    ['request metadata', 'request-metadata:canary'],
    ['client identifier', 'client-id:canary'],
  ])(
    'rejects the %s sentinel when hidden in an otherwise allowed API identity',
    async (_label, sentinel) => {
      const value = await inventory();
      (value.apiValues[0] as Record<string, any>).identity.releaseSha = sentinel;
      await expect(auditInventory(value)).rejects.toBeDefined();
    },
  );

  it('rejects unknown, identifying, and provider-payload Durable Object values', () => {
    const unknown = durableStorage();
    unknown['state:clientId'] = 'viewer-1';
    expectPrivacyFailure(() => assertDurableObjectStoragePrivacy(unknown), 'UNKNOWN_FIELD');

    const identifying = durableStorage();
    identifying['state:providerId'] = 'N123AB';
    expectPrivacyFailure(() => assertDurableObjectStoragePrivacy(identifying), 'FORBIDDEN_VALUE');

    const payload = durableStorage();
    (payload['metrics:2026-08-29T16:00:00.000Z'] as Record<string, unknown>).providerPayload = {
      ac: [],
    };
    expectPrivacyFailure(() => assertDurableObjectStoragePrivacy(payload), 'UNKNOWN_FIELD');
  });

  it('rejects unknown hibernation fields, client canaries, and unbounded attachments', () => {
    const unknown = { ...hibernationAttachment(), clientId: 'viewer-1' };
    expectPrivacyFailure(() => assertHibernationAttachmentPrivacy(unknown), 'UNKNOWN_FIELD');

    const identifying = { ...hibernationAttachment(), providerId: 'abc123' };
    expectPrivacyFailure(() => assertHibernationAttachmentPrivacy(identifying), 'FORBIDDEN_VALUE');

    const unbounded = {
      ...hibernationAttachment(),
      pendingPingId: `ping-${'x'.repeat(2_100)}`,
      lastPingAt: Date.parse(CHECKED_AT),
    };
    expectPrivacyFailure(() => assertHibernationAttachmentPrivacy(unbounded), 'FORBIDDEN_VALUE');
  });

  it.each([
    'localStorage',
    'sessionStorage',
    'cookies',
    'indexedDbDatabases',
    'cacheStorageKeys',
    'opfsEntries',
    'serviceWorkers',
  ] as const)('requires observed-empty browser persistence for %s', async (surface) => {
    const stored = await inventory();
    (stored.browserStorage[surface] as unknown as unknown[]).push('synthetic-canary');
    await expect(auditInventory(stored)).rejects.toMatchObject({
      code: 'FORBIDDEN_VALUE',
    });
  });

  it('requires empty screenshot metadata and an observed-empty screenshot output directory', async () => {
    const captured = await inventory();
    (captured.screenshotMetadata.files as unknown as unknown[]).push('failure.png');
    await expect(auditInventory(captured)).rejects.toMatchObject({
      code: 'FORBIDDEN_VALUE',
    });

    const contaminatedOutput = await inventory();
    await writeFile(
      join(contaminatedOutput.screenshotMetadata.outputDirectory.root, 'failure.png'),
      'synthetic-canary',
      'utf8',
    );
    await expect(auditInventory(contaminatedOutput)).rejects.toMatchObject({
      code: 'UNDECLARED_FILE',
    });
  });

  it('accepts only the exact two-file, no-capture, identity-bound G2 output', () => {
    expect(assertG2AggregateArtifacts(g2Artifacts(), expectedIdentity())).toMatchObject({
      manifest: { capture: { screenshots: false, traces: false, video: false, har: false } },
      receipt: { counters: { requestCount: 1, regionCount: 3 } },
    });

    const extra = g2Artifacts() as unknown as { artifacts: Array<Record<string, unknown>> };
    extra.artifacts.push({ path: 'trace.zip', value: {} });
    expectPrivacyFailure(
      () => assertG2AggregateArtifacts(extra, expectedIdentity()),
      'UNDECLARED_FILE',
    );

    const detail = g2Artifacts() as { artifacts: Array<{ path: string; value: any }> };
    detail.artifacts[0]!.value.errorDetail = 'provider response body';
    expectPrivacyFailure(
      () => assertG2AggregateArtifacts(detail, expectedIdentity()),
      'UNKNOWN_FIELD',
    );

    const capture = g2Artifacts() as { artifacts: Array<{ path: string; value: any }> };
    capture.artifacts[1]!.value.capture.har = true;
    expectPrivacyFailure(
      () => assertG2AggregateArtifacts(capture, expectedIdentity()),
      'INVALID_G2_EVIDENCE',
    );

    const mismatch = g2Artifacts() as { artifacts: Array<{ path: string; value: any }> };
    mismatch.artifacts[0]!.value.candidateId = 'd'.repeat(64);
    expectPrivacyFailure(
      () => assertG2AggregateArtifacts(mismatch, expectedIdentity()),
      'INVALID_G2_EVIDENCE',
    );

    expectPrivacyFailure(() => assertG2AggregateArtifacts(g2Artifacts()), 'INVALID_G2_EVIDENCE');
    expectPrivacyFailure(
      () =>
        assertG2AggregateArtifacts(g2Artifacts(), {
          ...expectedIdentity(),
          candidateId: 'd'.repeat(64),
        }),
      'INVALID_G2_EVIDENCE',
    );
  });

  it('rejects a false-pass G2 receipt even when its aggregate fields are well typed', () => {
    const falsePass = g2Artifacts() as { artifacts: Array<{ path: string; value: any }> };
    const receipt = falsePass.artifacts.find(
      ({ path }) => path === 'g2-aggregate-receipt.json',
    )!.value;
    Object.assign(receipt.counters, {
      availableRegionCount: 0,
      emptyRegionCount: 0,
      nonemptyRegionCount: 0,
      failedRegionCount: 3,
      rateLimitCount: 999,
    });
    receipt.timing.durationMs = 0;
    expectPrivacyFailure(
      () => assertG2AggregateArtifacts(falsePass, expectedIdentity()),
      'INVALID_G2_EVIDENCE',
    );

    const emptyPass = g2Artifacts() as { artifacts: Array<{ path: string; value: any }> };
    const emptyReceipt = emptyPass.artifacts.find(
      ({ path }) => path === 'g2-aggregate-receipt.json',
    )!.value;
    Object.assign(emptyReceipt.counters, {
      emptyRegionCount: 3,
      nonemptyRegionCount: 0,
    });
    emptyReceipt.timing.maximumObservationAgeSeconds = null;
    expectPrivacyFailure(
      () => assertG2AggregateArtifacts(emptyPass, expectedIdentity()),
      'INVALID_G2_EVIDENCE',
    );
  });

  it('audits G2 and no-capture directories from their actual strict JSON bytes', async () => {
    const clean = await evidenceDirectory('g2-clean', 'g2-bundle');
    await expect(auditG2EvidenceDirectory(clean, expectedIdentity())).resolves.toBe(2);

    const unbound = { root: clean.root, mode: 'g2-bundle' as const };
    await expect(auditG2EvidenceDirectory(unbound)).rejects.toMatchObject({
      code: 'INVALID_INVENTORY',
    });
    const selfBound = { ...clean, expectedIdentity: expectedIdentity() };
    await expect(auditG2EvidenceDirectory(selfBound, expectedIdentity())).rejects.toMatchObject({
      code: 'UNKNOWN_FIELD',
    });

    const unexpected = await evidenceDirectory('g2-extra', 'g2-bundle');
    await writeFile(join(unexpected.root, 'results.xml'), '<testsuite/>\n', 'utf8');
    await expect(auditG2EvidenceDirectory(unexpected, expectedIdentity())).rejects.toMatchObject({
      code: 'UNDECLARED_FILE',
    });

    const duplicate = await evidenceDirectory('g2-duplicate', 'g2-bundle');
    const duplicateReceipt = `${JSON.stringify({
      ...g2Receipt(),
      schemaVersionCanary: G2_AGGREGATE_RECEIPT_VERSION,
    })}\n`.replace('"schemaVersionCanary"', '"schemaVersion"');
    await writeFile(join(duplicate.root, 'g2-aggregate-receipt.json'), duplicateReceipt, 'utf8');
    await expect(auditG2EvidenceDirectory(duplicate, expectedIdentity())).rejects.toMatchObject({
      code: 'FORBIDDEN_VALUE',
    });

    const noCapture = await evidenceDirectory('g2-empty', 'empty');
    await writeFile(join(noCapture.root, 'failure.har'), '{}\n', 'utf8');
    await expect(auditG2EvidenceDirectory(noCapture)).rejects.toMatchObject({
      code: 'UNDECLARED_FILE',
    });
  });

  it('rejects unknown files, screenshot media, structured flight detail, and hash drift', async () => {
    const undeclared = await tree('unknown-file', 'evidence/aggregate.json', {
      schemaVersion: 'aggregate.v1',
    });
    await writeFile(join(undeclared.root, 'evidence', 'extra.json'), '{}\n', 'utf8');
    await expect(auditTree(undeclared)).rejects.toMatchObject({ code: 'UNDECLARED_FILE' });

    const screenshot = await tree('screenshot', 'screenshots/failure.png', 'not-an-image');
    await expect(auditTree(screenshot)).rejects.toMatchObject({ code: 'UNDECLARED_FILE' });

    const detail = await tree('detail', 'evidence/aggregate.json', {
      schemaVersion: 'aggregate.v1',
      aircraftId: 'abc123',
    });
    await expect(auditTree(detail)).rejects.toMatchObject({ code: 'FORBIDDEN_VALUE' });

    const unknownField = await tree('unknown-field', 'evidence/aggregate.json', {
      schemaVersion: 'candidate-aggregate.v1',
      result: 'pass',
      arbitraryUnknownCounter: 7,
    });
    await expect(auditTree(unknownField)).rejects.toMatchObject({ code: 'UNKNOWN_FIELD' });

    const callerRole = await tree('caller-role', 'evidence/aggregate.json', {
      schemaVersion: 'candidate-aggregate.v1',
      result: 'pass',
    });
    (callerRole.files[0] as unknown as Record<string, unknown>).kind = 'aggregate-json';
    await expect(auditTree(callerRole)).rejects.toMatchObject({ code: 'UNKNOWN_FIELD' });

    const drift = await tree('drift', 'evidence/aggregate.json', {
      schemaVersion: 'aggregate.v1',
    });
    await writeFile(
      join(drift.root, 'evidence', 'aggregate.json'),
      '{"schemaVersion":"changed"}\n',
    );
    await expect(auditTree(drift)).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
  });

  it.each([
    ['fake IP', '192.0.2.44'],
    ['endpoint', 'https://provider.example/point/33/-84'],
    ['Windows username path', 'C:\\Users\\privacy-canary\\workspace'],
    ['POSIX username path', '/home/privacy-canary/workspace'],
    ['credential', 'ghp_123456789012345678901234567890'],
    ['provider payload', '{"ac":[{"hex":"abc123"}]}'],
    ['unbounded text', 'x'.repeat(129)],
    ['large JSON text', 'x'.repeat(4_096)],
  ])(
    'rejects the %s canary from aggregate candidate and release evidence',
    async (_label, canary) => {
      const candidate = await tree('tree-canary', 'evidence/aggregate.json', {
        schemaVersion: 'aggregate.v1',
        value: canary,
      });
      await expect(auditTree(candidate)).rejects.toMatchObject({ code: 'FORBIDDEN_VALUE' });

      const release = await tree('text-canary', 'evidence/summary.txt', canary);
      await expect(auditTree(release)).rejects.toMatchObject({ code: 'FORBIDDEN_VALUE' });
    },
  );

  it('rejects numeric position detail and caller-declared opaque payloads', async () => {
    const position = await tree('position', 'evidence/aggregate.json', {
      schemaVersion: 'aggregate.v1',
      position: 33.7488,
    });
    await expect(auditTree(position)).rejects.toMatchObject({ code: 'FORBIDDEN_VALUE' });

    const coordinateAliases = await tree('coordinate-aliases', 'evidence/aggregate.json', {
      schemaVersion: 'candidate-aggregate.v1',
      result: 'pass',
      lat: 33.7488,
      lon: -84.388,
    });
    await expect(auditTree(coordinateAliases)).rejects.toBeDefined();

    const gzip = await tree('opaque-gzip', 'evidence/payload.gz', 'synthetic-canary');
    await expect(auditTree(gzip)).rejects.toMatchObject({ code: 'INVALID_INVENTORY' });

    const tarball = await tree('opaque-tarball', 'evidence/payload.tar.gz', 'synthetic-canary');
    await expect(auditTree(tarball)).rejects.toMatchObject({ code: 'INVALID_INVENTORY' });

    const codeText = await tree(
      'code-text',
      'evidence/payload.js',
      `const positionDegrees = 33.7488; /* ${'x'.repeat(4_096)} */\n`,
    );
    await expect(auditTree(codeText)).rejects.toMatchObject({ code: 'INVALID_INVENTORY' });

    const deployableCodeText = await tree(
      'deployable-code-text',
      'client/assets/payload.js',
      `const positionDegrees = 33.7488; /* ${'x'.repeat(4_096)} */\n`,
    );
    await expect(auditTree(deployableCodeText)).rejects.toMatchObject({
      code: 'INVALID_INVENTORY',
    });

    const encodedComputedKey = await tree(
      'encoded-computed-key',
      'client/assets/payload.js',
      `const first = 'air'; const key = first + '\\x63raftId'; const value = { [key]: 'abc123', ['pos' + 'ition']: [33.7488, -84.388] };\n`,
    );
    await expect(auditTree(encodedComputedKey)).rejects.toMatchObject({
      code: 'INVALID_INVENTORY',
    });
  });

  it('enforces the exact retained-candidate provenance field schema', async () => {
    const provenanceWithCoordinateAliases = await tree(
      'provenance-coordinate-aliases',
      'evidence/provenance.json',
      {
        schemaVersion: 'airspace-retained-candidate.v1',
        candidateId: 'mock-staging-000000000000000000000000',
        deterministic: true,
        buildPerformed: false,
        deploymentPerformed: false,
        source: {},
        application: {},
        sourceArtifact: {},
        retainedArtifact: {},
        mapManifest: {},
        replayScenarios: [],
        rollback: {},
        sbom: {},
        checksums: {},
        latDegrees: 33.7488,
        lonDegrees: -84.388,
      },
    );
    await expect(auditTree(provenanceWithCoordinateAliases)).rejects.toMatchObject({
      code: 'UNKNOWN_FIELD',
    });
  });

  it.each(['client/assets/live-main-abcdefgh.js', 'airspace_worker/index.js'])(
    'treats %s as opaque selected bytes and rejects a forged executable against the trusted identity',
    async (path) => {
      expect(PRIVACY_TREE_IDENTITY_VERSION).toBe('sha256-file-inventory.v1');
      const selected = await tree('selected-executable', path, 'export const selected = true;\n');
      const forged = await tree(
        'forged-executable',
        path,
        `const parts=['pos','ition'];const record={ [parts.join('')]:[31.234567,-81.654321] };\n`,
      );

      await expect(auditTree(selected)).resolves.toBe(1);
      await expect(auditPrivacyTree(forged)).rejects.toMatchObject({
        code: 'INVALID_INVENTORY',
      });
      await expect(auditPrivacyTree(forged, selectedTreeIdentity(selected))).rejects.toMatchObject({
        code: 'HASH_MISMATCH',
      });
    },
  );

  it('rejects an unrecognized executable role even when self-hashed by the caller', async () => {
    const executable = await tree(
      'computed-executable-canary',
      'client/assets/payload-abcdefgh.js',
      `const first='air';const key=first+'\\x63raftId';const value={[key]:'abc123'};\n`,
    );
    await expect(auditTree(executable)).rejects.toMatchObject({
      code: 'INVALID_INVENTORY',
    });
  });

  it('enforces fixed content schemas for map-manifest and runtime-policy roles', async () => {
    const cleanMapManifest = await tree(
      'map-manifest-clean',
      'evidence/map-manifest.json',
      mapManifest,
    );
    await expect(auditTree(cleanMapManifest)).resolves.toBe(1);

    const unsafeMapManifest = structuredClone(mapManifest) as typeof mapManifest & {
      latDegrees?: number;
      lonDegrees?: number;
    };
    unsafeMapManifest.latDegrees = 31.234567;
    unsafeMapManifest.lonDegrees = -81.654321;
    const map = await tree(
      'map-manifest-coordinate-aliases',
      'evidence/map-manifest.json',
      unsafeMapManifest,
    );
    await expect(auditTree(map)).rejects.toMatchObject({ code: 'UNKNOWN_FIELD' });

    const runtimePolicy = await compileRuntimePolicy({
      target: 'mock-staging',
      providerMode: 'mock',
      providerBaseUrl: 'https://mock-provider.invalid',
      mockBindingPresent: true,
      allowedOrigins: ['http://127.0.0.1:4174'],
      deploymentClass: 'loopback',
      release: {
        applicationVersion: '3.0.0-dev',
        releaseSha: 'local-unreleased',
        releaseStatus: 'unreleased',
        buildTarget: 'mock-staging',
      },
      policyEpoch: 'r3-local-1',
      providerGate: { status: 'closed', reason: 'source-disabled' },
    });
    const cleanRuntimePolicy = await tree(
      'runtime-policy-clean',
      'client/runtime-policy.json',
      runtimePolicy,
    );
    await expect(auditTree(cleanRuntimePolicy)).resolves.toBe(1);

    const driftedRuntimePolicy = structuredClone(runtimePolicy) as unknown as {
      limits: { provider: { pollIntervalMs: number } };
    };
    driftedRuntimePolicy.limits.provider.pollIntervalMs += 1;
    const driftedPolicy = await tree(
      'runtime-policy-limit-drift',
      'client/runtime-policy.json',
      driftedRuntimePolicy,
    );
    await expect(auditTree(driftedPolicy)).rejects.toMatchObject({ code: 'UNKNOWN_FIELD' });

    const unsafeRuntimePolicy = structuredClone(runtimePolicy) as typeof runtimePolicy & {
      aircraftPositionDegrees?: number;
    };
    unsafeRuntimePolicy.aircraftPositionDegrees = 31.234567;
    const policy = await tree(
      'runtime-policy-coordinate-alias',
      'client/runtime-policy.json',
      unsafeRuntimePolicy,
    );
    await expect(auditTree(policy)).rejects.toMatchObject({ code: 'UNKNOWN_FIELD' });
  });

  it('rejects symlinked tree nodes when the host permits creating one', async () => {
    const declaration = await tree('symlink', 'evidence/aggregate.json', {
      schemaVersion: 'aggregate.v1',
    });
    const target = join(declaration.root, 'evidence', 'aggregate.json');
    const alias = join(declaration.root, 'evidence', 'alias.json');
    try {
      await symlink(target, alias, 'file');
    } catch {
      return;
    }
    await expect(auditTree(declaration)).rejects.toMatchObject({ code: 'UNSAFE_NODE' });
  });
});
