import {
  DEFAULT_LIVE_PROVIDER_ID,
  type AirspaceSnapshot,
  type LiveFeedBinding,
  type LiveFeedHealth,
} from './types';
import { isCanonicalTimestamp, isLiveIdentifier, isSafeInteger } from './validation';

export function sameLiveFeed(
  left: LiveFeedBinding | undefined,
  right: LiveFeedBinding | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    left.providerId === right.providerId &&
    left.regionId === right.regionId &&
    left.feedEpoch === right.feedEpoch,
  );
}

/** Acceptance precedes both evidence mutation and delivery-clock calibration. */
export class LiveFeedOrder {
  private current?: Readonly<LiveFeedBinding> | undefined;
  private sequence = -1;
  private snapshotAt = Number.NEGATIVE_INFINITY;
  private healthAt = Number.NEGATIVE_INFINITY;
  private healthSnapshotAt = Number.NEGATIVE_INFINITY;
  private revisionValue = 0;

  constructor(
    private readonly regionId: string,
    private readonly providerId = DEFAULT_LIVE_PROVIDER_ID,
  ) {
    if (!isLiveIdentifier(regionId) || !isLiveIdentifier(providerId)) {
      throw new TypeError('Feed providerId and regionId must be bounded identifiers.');
    }
  }

  get binding(): Readonly<LiveFeedBinding> | undefined {
    return this.current;
  }
  get revision(): number {
    return this.revisionValue;
  }

  reset(): void {
    this.current = undefined;
    this.sequence = -1;
    this.snapshotAt = Number.NEGATIVE_INFINITY;
    this.healthAt = Number.NEGATIVE_INFINITY;
    this.healthSnapshotAt = Number.NEGATIVE_INFINITY;
    this.revisionValue += 1;
  }

  acceptHello(binding: LiveFeedBinding, allowEpochChange: boolean): boolean {
    if (
      binding.providerId !== this.providerId ||
      binding.regionId !== this.regionId ||
      !isLiveIdentifier(binding.feedEpoch)
    )
      return false;
    if (sameLiveFeed(this.current, binding)) return true;
    if (this.current && !allowEpochChange) return false;
    this.reset();
    this.current = Object.freeze({
      providerId: binding.providerId,
      regionId: binding.regionId,
      feedEpoch: binding.feedEpoch,
    });
    return true;
  }

  acceptSnapshot(snapshot: AirspaceSnapshot): boolean {
    if (
      !isSafeInteger(snapshot.sequence) ||
      !isCanonicalTimestamp(snapshot.generatedAt) ||
      !this.acceptHello(snapshot, false) ||
      snapshot.sequence <= this.sequence
    )
      return false;
    this.sequence = snapshot.sequence;
    this.snapshotAt = Math.max(this.snapshotAt, Date.parse(snapshot.generatedAt));
    this.revisionValue += 1;
    return true;
  }

  acceptHealth(health: LiveFeedHealth): boolean {
    if (
      !isCanonicalTimestamp(health.checkedAt) ||
      (health.lastSnapshotAt !== undefined && !isCanonicalTimestamp(health.lastSnapshotAt)) ||
      !this.acceptHello(health, false)
    )
      return false;
    const checkedAt = Date.parse(health.checkedAt);
    const snapshotAt =
      health.lastSnapshotAt === undefined ? undefined : Date.parse(health.lastSnapshotAt);
    if (
      checkedAt <= this.healthAt ||
      checkedAt < this.snapshotAt ||
      (snapshotAt !== undefined && snapshotAt < Math.max(this.snapshotAt, this.healthSnapshotAt))
    )
      return false;
    this.healthAt = checkedAt;
    if (snapshotAt !== undefined) this.healthSnapshotAt = snapshotAt;
    this.revisionValue += 1;
    return true;
  }
}
