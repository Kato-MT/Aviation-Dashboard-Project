import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import configurationManifest from '../../models/model_configuration_manifest_v1.json';
import {
  robustCovarianceRegistryEntry,
  temporalFaultRegistryEntry,
  temporalFaultResearchRegistryEntry,
} from '../../src/model-registry/registry';

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function resolveJsonPointer(document: unknown, pointer: string): unknown {
  return pointer
    .split('/')
    .slice(1)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce<unknown>((value, segment) => {
      if (typeof value !== 'object' || value === null || !(segment in value)) return undefined;
      return (value as Record<string, unknown>)[segment];
    }, document);
}

describe('model registry evidence identities', () => {
  it('recomputes every configuration identity from its checked-in canonical bytes', () => {
    for (const entry of configurationManifest.entries) {
      expect(sha256(entry.canonicalJson)).toBe(entry.sha256);
    }
    const configuration = (registryEntryId: string, modelVersion: string) =>
      configurationManifest.entries.find(
        (entry) => entry.registryEntryId === registryEntryId && entry.modelVersion === modelVersion,
      );
    expect(configuration(robustCovarianceRegistryEntry.registryEntryId, '1.0.0')?.sha256).toBe(
      robustCovarianceRegistryEntry.identities.configurationSha256,
    );
    expect(configuration(temporalFaultResearchRegistryEntry.registryEntryId, '1.0.0')?.sha256).toBe(
      temporalFaultResearchRegistryEntry.identities.configurationSha256,
    );
    expect(configuration(temporalFaultRegistryEntry.registryEntryId, '2.0.0')?.sha256).toBe(
      temporalFaultRegistryEntry.identities.configurationSha256,
    );
  });

  it('recomputes the registered artifact hashes from the checked-in files', async () => {
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const robust = await readFile(`${root}/models/robust_covariance_v1.json`);
    const temporalResearch = await readFile(`${root}/models/temporal_fault_model_v1.json`);
    const temporalIntegrated = await readFile(`${root}/models/temporal_fault_model_v2.json`);
    expect(sha256(robust)).toBe(robustCovarianceRegistryEntry.identities.artifactSha256);
    expect(sha256(temporalResearch)).toBe(
      temporalFaultResearchRegistryEntry.identities.artifactSha256,
    );
    expect(sha256(temporalIntegrated)).toBe(temporalFaultRegistryEntry.identities.artifactSha256);
  });

  it('keeps every declared training, calibration, evaluation, and model-card reference checked in', async () => {
    const root = fileURLToPath(new URL('../..', import.meta.url));
    for (const entry of [
      robustCovarianceRegistryEntry,
      temporalFaultResearchRegistryEntry,
      temporalFaultRegistryEntry,
    ]) {
      for (const reference of [
        entry.evidence.training,
        entry.evidence.calibration,
        entry.evidence.evaluation,
      ]) {
        expect(reference.path).toMatch(/^models\//);
        expect(reference.jsonPointer).toMatch(/^\//);
        expect(reference.seedSummary).not.toBe('');
        const evidenceText = await readFile(`${root}/${reference.path}`, 'utf8');
        expect(evidenceText).not.toBe('');
        expect(resolveJsonPointer(JSON.parse(evidenceText), reference.jsonPointer)).toBeDefined();
      }
      const evaluationText = await readFile(`${root}/${entry.evidence.evaluation.path}`, 'utf8');
      expect(
        resolveJsonPointer(JSON.parse(evaluationText), entry.evidence.qualityGateJsonPointer),
      ).toBeDefined();
      await expect(readFile(`${root}/${entry.evidence.modelCardPath}`, 'utf8')).resolves.not.toBe(
        '',
      );
    }
  });
});
