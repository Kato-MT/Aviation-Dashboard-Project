import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadEvidenceOperations, parseEvidenceOperations } from '../../src/evidence/health';
import { OperationsContractError } from '../../src/operations/contract';
import { operationsFixture } from '../support/operationsFixture';

afterEach(() => vi.unstubAllGlobals());

describe('bounded Evidence operations service', () => {
  it('parses and deeply freezes the strict operations.v1 projection', () => {
    const fixture = operationsFixture();
    const parsed = parseEvidenceOperations(fixture);
    expect(parsed).toEqual(fixture);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.regions[0].provider.reasonCodes)).toBe(true);
  });

  it.each([
    null,
    [],
    {},
    { ...operationsFixture(), unexpected: true },
    { ...operationsFixture(), schemaVersion: 'operations.v2' },
    { ...operationsFixture(), checkedAt: 'not-a-time' },
    { ...operationsFixture(), identity: {} },
    { ...operationsFixture(), regions: [] },
    {
      ...operationsFixture(),
      regions: [operationsFixture().regions[0], operationsFixture().regions[0]],
    },
  ])('rejects malformed operational evidence: %#', (value) => {
    expect(() => parseEvidenceOperations(value)).toThrow(OperationsContractError);
  });

  it('performs one bounded same-origin request only when invoked', async () => {
    const fixture = operationsFixture();
    const fetchMock = vi.fn(async () => Response.json(fixture));
    vi.stubGlobal('fetch', fetchMock);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(loadEvidenceOperations()).resolves.toEqual(fixture);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/operations', {
      method: 'GET',
      signal: expect.any(AbortSignal),
      redirect: 'error',
      headers: { accept: 'application/json' },
    });
  });

  it.each([
    () => new Response('unavailable', { status: 503 }),
    () => new Response('not-json'),
    () => new Response('x'.repeat(129 * 1024)),
    () => Response.json({ ...operationsFixture(), identity: null }),
  ])('fails closed without replacing static Evidence: %#', async (response) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response()),
    );
    await expect(loadEvidenceOperations()).rejects.toThrow();
  });

  it('honors cancellation before issuing a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();
    await expect(loadEvidenceOperations(controller.signal)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
