import { describe, expect, it } from 'vitest';
import { createMockProvider } from '../support/mockProvider';

const url = 'https://mock-provider.invalid/v2/point/33.6407/-84.4277/100';

describe('controlled raw synthetic provider', () => {
  it.each(['nominal', 'empty', 'stale'] as const)(
    'returns provider-shaped %s observations',
    async (scenario) => {
      const response = createMockProvider(() => 1_000_000).fetch(new Request(url), {
        MOCK_SCENARIO: scenario,
      });
      const body = await response.json();
      expect(body.now).toBe(1_000_000);
      expect(body.ac).toHaveLength(scenario === 'empty' ? 0 : 3);
      if (scenario !== 'empty') expect(body.ac[0].seen_pos).toBe(scenario === 'stale' ? 61 : 2);
    },
  );

  it('recovers without changing source or adding a browser control endpoint', () => {
    let now = 0;
    const provider = createMockProvider(() => now);
    expect(provider.fetch(new Request(url), { MOCK_SCENARIO: 'recovery' }).status).toBe(503);
    now = 15_000;
    expect(provider.fetch(new Request(url), { MOCK_SCENARIO: 'recovery' }).status).toBe(200);
  });

  it('visits every walkthrough state on actual requests despite receipt-clock jitter', async () => {
    let now = 0;
    const provider = createMockProvider(() => now);
    for (const [time, status, count, age] of [
      [0, 200, 3, 1],
      [9_998, 200, 0, 0],
      [20_003, 200, 3, 60],
      [31_500, 503, 0, 0],
      [53_001, 200, 3, 1],
      [64_000, 200, 3, 1],
    ]) {
      now = time!;
      const response = provider.fetch(new Request(url), { MOCK_SCENARIO: 'walkthrough' });
      expect(response.status).toBe(status);
      if (status === 200) {
        const body = await response.json();
        expect(body.ac).toHaveLength(count!);
        if (count) expect(body.ac[0].seen).toBe(age);
      }
    }
  });

  it('keeps the bounded walkthrough sequence independent for each fixed region', async () => {
    const provider = createMockProvider(() => 1_000_000);
    const savannah = 'https://mock-provider.invalid/v2/point/32.3/-81.5/100';
    const fetch = async (location: string) =>
      provider.fetch(new Request(location), { MOCK_SCENARIO: 'walkthrough' }).json();
    expect((await fetch(url)).ac).toHaveLength(3);
    expect((await fetch(url)).ac).toHaveLength(0);
    expect((await fetch(savannah)).ac).toHaveLength(3);
    expect((await fetch(savannah)).ac).toHaveLength(0);
    expect((await fetch(url)).ac[0].seen).toBe(60);
  });

  it.each([
    new Request('https://api.adsb.lol/v2/point/33.6407/-84.4277/100'),
    new Request(url + '?scenario=live'),
    new Request(url, { method: 'POST' }),
    new Request('https://mock-provider.invalid/v2/all'),
    new Request(url, { headers: { authorization: 'test' } }),
    new Request(url, { headers: { cookie: 'test' } }),
  ])('rejects requests outside the isolated raw-feed interface: %j', (request) => {
    expect(createMockProvider().fetch(request, {}).status).toBe(400);
  });

  it('fails closed on an invalid server scenario', () => {
    expect(createMockProvider().fetch(new Request(url), { MOCK_SCENARIO: 'unknown' }).status).toBe(
      503,
    );
  });
});
