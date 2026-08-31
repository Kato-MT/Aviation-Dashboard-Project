import { describe, expect, it } from 'vitest';
import manifest from '../../maps/manifest.json';
import {
  BUNDLED_MAP_SUMMARY,
  BUNDLED_SCHEMA_IDENTITIES,
  DEFAULT_RELEASE_GATES,
  parseMapManifestSummary,
} from '../../src/evidence/catalog';

describe('static Evidence catalog', () => {
  it('projects the checked map manifest without retaining its asset inventory', () => {
    const summary = parseMapManifestSummary(manifest);
    expect(summary).toEqual(BUNDLED_MAP_SUMMARY);
    expect(summary).not.toHaveProperty('assets');
    expect(JSON.stringify(summary).length).toBeLessThan(2_000);
    expect(manifest.assets).toHaveLength(776);
  });

  it('fails closed for malformed or incomplete map identities', () => {
    expect(() => parseMapManifestSummary(null)).toThrow();
    expect(() => parseMapManifestSummary({ ...manifest, schemaVersion: 'unknown' })).toThrow();
    expect(() => parseMapManifestSummary({ ...manifest, bounds: [1, 2, 0, 3] })).toThrow();
    expect(() => parseMapManifestSummary({ ...manifest, assets: [] })).toThrow();
    expect(() =>
      parseMapManifestSummary({
        ...manifest,
        assets: manifest.assets.map((asset) =>
          asset.path === 'basemap.pmtiles' ? { ...asset, sha256: 'not-a-digest' } : asset,
        ),
      }),
    ).toThrow();
  });

  it('ships schema identities and a three-stage gate ledger', () => {
    expect(BUNDLED_SCHEMA_IDENTITIES).toEqual([
      'airspace.v1',
      'live-stream.1.0.0',
      'map-assets.v1',
      'operations.v1',
      'runtime-policy.v1',
    ]);
    expect(DEFAULT_RELEASE_GATES.length).toBeGreaterThanOrEqual(5);
    for (const gate of DEFAULT_RELEASE_GATES) {
      expect(gate).toHaveProperty('implementation');
      expect(gate).toHaveProperty('execution');
      expect(gate).toHaveProperty('release');
    }
    expect(DEFAULT_RELEASE_GATES.every(({ release }) => release === 'pending')).toBe(true);
    expect(DEFAULT_RELEASE_GATES.every(({ execution }) => execution !== 'executed-local')).toBe(
      true,
    );
    const load = DEFAULT_RELEASE_GATES.find(({ id }) => id === 'm3-load-soak');
    const soak = DEFAULT_RELEASE_GATES.find(({ id }) => id === 'm3-soak');
    expect(load).toMatchObject({ implementation: 'implemented', execution: 'passed-historical' });
    expect(soak).toMatchObject({ implementation: 'implemented', execution: 'passed-historical' });
    expect(load?.evidence).toContain(
      '32d2ff35734f8dfebcdbab319d577b57587cdff379ea5ea285eb47b2f60353bb',
    );
    expect(load?.evidence).toContain(
      'a5fce408cf8d62b5e291b383cef8b364852637a5bfbfa09a0497b8b12a7e5023',
    );
    expect(soak?.evidence).toContain(
      '41cda60f3c50172ef3b8f46f114668d9710fc6862b5a8f7f10da4afbf9beef95',
    );
  });

  it('keeps G2 pending after the sanitized provider-coordination response', () => {
    const providerGate = DEFAULT_RELEASE_GATES.find(({ id }) => id === 'g2-provider');

    expect(providerGate).toMatchObject({
      implementation: 'not-applicable',
      execution: 'external-evidence-needed',
      release: 'pending',
    });
    expect(providerGate?.evidence).toContain('response received on 2026-08-30');
    expect(providerGate?.evidence).toContain('not an approved provider-gate receipt');
    expect(providerGate?.evidence).toContain('G2 remains pending');
  });
});
