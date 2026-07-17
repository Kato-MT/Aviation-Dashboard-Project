export type QueueOverflowStrategy = 'drop-oldest' | 'drop-newest';

export interface QueuePushResult<T> {
  accepted: boolean;
  depth: number;
  dropped?: T;
  totalDropped: number;
}

export interface QueueSnapshot {
  capacity: number;
  depth: number;
  totalEnqueued: number;
  totalDequeued: number;
  totalDropped: number;
  overflowStrategy: QueueOverflowStrategy;
}

export class BoundedQueue<T> {
  readonly capacity: number;
  readonly overflowStrategy: QueueOverflowStrategy;

  private items: T[] = [];
  private enqueued = 0;
  private dequeued = 0;
  private dropped = 0;

  constructor(capacity: number, overflowStrategy: QueueOverflowStrategy = 'drop-oldest') {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError('Queue capacity must be a positive safe integer.');
    }
    this.capacity = capacity;
    this.overflowStrategy = overflowStrategy;
  }

  get length(): number {
    return this.items.length;
  }

  push(item: T): QueuePushResult<T> {
    if (this.items.length < this.capacity) {
      this.items.push(item);
      this.enqueued += 1;
      return {
        accepted: true,
        depth: this.items.length,
        totalDropped: this.dropped,
      };
    }

    this.dropped += 1;
    if (this.overflowStrategy === 'drop-newest') {
      return {
        accepted: false,
        depth: this.items.length,
        dropped: item,
        totalDropped: this.dropped,
      };
    }

    const dropped = this.items.shift() as T;
    this.items.push(item);
    this.enqueued += 1;
    return {
      accepted: true,
      depth: this.items.length,
      dropped,
      totalDropped: this.dropped,
    };
  }

  shift(): T | undefined {
    const item = this.items.shift();
    if (item !== undefined) {
      this.dequeued += 1;
    }
    return item;
  }

  drain(limit = Number.POSITIVE_INFINITY): T[] {
    if (limit <= 0) {
      return [];
    }
    const count = Math.min(this.items.length, Math.floor(limit));
    const drained = this.items.splice(0, count);
    this.dequeued += drained.length;
    return drained;
  }

  clear(): void {
    this.dequeued += this.items.length;
    this.items = [];
  }

  snapshot(): QueueSnapshot {
    return {
      capacity: this.capacity,
      depth: this.items.length,
      totalEnqueued: this.enqueued,
      totalDequeued: this.dequeued,
      totalDropped: this.dropped,
      overflowStrategy: this.overflowStrategy,
    };
  }
}
