import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('sanitized ADSB.lol coordination record', () => {
  it('records confirmed guidance and unresolved exact-envelope questions without claiming G2', async () => {
    const text = await readFile('docs/provider/adsb-lol-coordination-2026-08-30.json', 'utf8');
    const record = JSON.parse(text) as Record<string, unknown>;

    expect(record).toMatchObject({
      schemaVersion: 'provider-coordination.v1',
      providerId: 'adsb-lol',
      recordDate: '2026-08-30',
      sourceEvidence: 'owner-controlled-email',
      repositoryRetention: 'sanitized-summary-only',
      disposition: 'coordination-received-terms-unresolved',
      g2GateStatus: 'pending',
      requestScope: {
        endpointPath: '/v2/point/33.6407/-84.4277/100',
        regionId: 'atlanta',
        minimumPollIntervalSeconds: 20,
        maximumConcurrentViewers: 25,
        commercial: false,
      },
    });
    expect(record.confirmedGuidance).toEqual(
      expect.arrayContaining([
        'visible-odbl-attribution-required',
        'identifiable-user-agent-with-contact-required',
        'respect-http-errors-and-retry-after',
        'cache-and-deduplicate',
        'no-rate-limit-circumvention',
        'no-sla-or-data-guarantee',
      ]),
    );
    expect(record.unresolved).toEqual(
      expect.arrayContaining([
        'exact-cadence-and-daily-request-ceiling',
        'exact-user-agent-value',
        'public-no-key-access',
        'transient-normalization-and-odbl-obligations',
      ]),
    );
    expect(text).not.toMatch(/katomakell|gmail\.com|message-id|subject:|from:|to:/iu);
  });
});
