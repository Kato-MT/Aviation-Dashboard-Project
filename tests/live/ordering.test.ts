import { describe, expect, it } from 'vitest';

import { LiveFeedOrder, sameLiveFeed } from '../../src/live/ordering';
import type { LiveFeedBinding } from '../../src/live/types';
import { healthFixture, LIVE_FIXTURE_EPOCH, snapshotFixture } from './fixtures';

const binding: LiveFeedBinding = {
  providerId: 'adsb-lol',
  regionId: 'atlanta',
  feedEpoch: LIVE_FIXTURE_EPOCH,
};

describe('feed identity and ordering', () => {
  it('binds the initial snapshot and accepts only increasing sequence within that epoch', () => {
    const order = new LiveFeedOrder('atlanta');
    expect(order.acceptSnapshot(snapshotFixture({ sequence: 10 }))).toBe(true);
    const revision = order.revision;
    expect(order.binding).toEqual(binding);
    expect(Object.isFrozen(order.binding)).toBe(true);
    expect(order.acceptSnapshot(snapshotFixture({ sequence: 10 }))).toBe(false);
    expect(order.acceptSnapshot(snapshotFixture({ sequence: 9 }))).toBe(false);
    expect(order.revision).toBe(revision);
    expect(order.acceptSnapshot(snapshotFixture({ sequence: 11 }))).toBe(true);
  });

  it.each([
    { providerId: 'other-provider' },
    { regionId: 'savannah-statesboro' },
    { feedEpoch: 'other-epoch' },
    { feedEpoch: '' },
  ])('cannot rebind from a snapshot or health update: %j', (overrides) => {
    const order = new LiveFeedOrder('atlanta');
    order.acceptHello(binding, true);
    const revision = order.revision;
    expect(order.acceptSnapshot(snapshotFixture(overrides))).toBe(false);
    expect(order.acceptHealth(healthFixture(overrides))).toBe(false);
    expect(order.binding).toEqual(binding);
    expect(order.revision).toBe(revision);
  });

  it('requires explicit new-epoch hello, then resets sequence without allowing the old epoch back', () => {
    const order = new LiveFeedOrder('atlanta');
    order.acceptSnapshot(snapshotFixture({ sequence: 20 }));
    const next = { ...binding, feedEpoch: 'test-feed-2' };
    expect(order.acceptHello(next, false)).toBe(false);
    expect(order.acceptHello(next, true)).toBe(true);
    expect(order.acceptSnapshot(snapshotFixture({ feedEpoch: next.feedEpoch, sequence: 0 }))).toBe(
      true,
    );
    expect(order.acceptSnapshot(snapshotFixture({ sequence: 100 }))).toBe(false);
    expect(order.acceptHello(binding, false)).toBe(false);
    expect(order.binding).toEqual(next);
    order.reset();
    expect(order.binding).toBeUndefined();
    expect(order.acceptSnapshot(snapshotFixture({ sequence: 0 }))).toBe(true);
  });

  it('rejects duplicate, regressed and older-snapshot health without changing accepted state', () => {
    const order = new LiveFeedOrder('atlanta');
    const latest = '2026-08-27T12:00:10.000Z';
    order.acceptSnapshot(snapshotFixture({ generatedAt: latest }));
    expect(order.acceptHealth(healthFixture())).toBe(false);
    const current = healthFixture({
      checkedAt: '2026-08-27T12:00:11.000Z',
      lastSnapshotAt: latest,
    });
    expect(order.acceptHealth(current)).toBe(true);
    const revision = order.revision;
    expect(order.acceptHealth(current)).toBe(false);
    expect(order.acceptHealth({ ...current, status: 'offline' })).toBe(false);
    expect(order.acceptHealth({ ...current, checkedAt: latest })).toBe(false);
    expect(order.acceptHealth(healthFixture({ checkedAt: '2026-08-27T12:00:12.000Z' }))).toBe(
      false,
    );
    expect(order.revision).toBe(revision);
    expect(order.acceptHealth({ ...current, checkedAt: '2026-08-27T12:00:12.000Z' })).toBe(true);
  });

  it('can bind initial unavailable health without claiming any snapshot exists', () => {
    const order = new LiveFeedOrder('atlanta');
    expect(
      order.acceptHealth(healthFixture({ status: 'offline', lastSnapshotAt: undefined })),
    ).toBe(true);
    expect(order.binding).toEqual(binding);
    expect(order.acceptSnapshot(snapshotFixture({ sequence: 0 }))).toBe(true);
  });

  it('does not let invalid control values establish a binding', () => {
    const order = new LiveFeedOrder('atlanta');
    expect(order.acceptSnapshot(snapshotFixture({ sequence: -1 }))).toBe(false);
    expect(order.acceptSnapshot(snapshotFixture({ generatedAt: 'invalid' }))).toBe(false);
    expect(order.acceptHealth(healthFixture({ checkedAt: 'invalid' }))).toBe(false);
    expect(order.acceptHealth(healthFixture({ lastSnapshotAt: 'invalid' }))).toBe(false);
    expect(order.binding).toBeUndefined();
    expect(sameLiveFeed(undefined, binding)).toBe(false);
    expect(sameLiveFeed(binding, { ...binding, providerId: 'other' })).toBe(false);
    expect(() => new LiveFeedOrder('')).toThrow('bounded identifiers');
    expect(() => new LiveFeedOrder('atlanta', '')).toThrow('bounded identifiers');
  });
});
