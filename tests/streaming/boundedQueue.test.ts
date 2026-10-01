import { describe, expect, it } from 'vitest';

import { BoundedQueue } from '../../src/streaming/boundedQueue';

describe('BoundedQueue', () => {
  describe('constructor and initialization', () => {
    it('initializes with valid capacity and default overflow strategy', () => {
      const queue = new BoundedQueue<string>(5);
      expect(queue.capacity).toBe(5);
      expect(queue.overflowStrategy).toBe('drop-oldest');
      expect(queue.length).toBe(0);

      const snapshot = queue.snapshot();
      expect(snapshot).toEqual({
        capacity: 5,
        depth: 0,
        totalEnqueued: 0,
        totalDequeued: 0,
        totalDropped: 0,
        overflowStrategy: 'drop-oldest',
      });
    });

    it('initializes with custom overflow strategy', () => {
      const queue = new BoundedQueue<number>(10, 'drop-newest');
      expect(queue.capacity).toBe(10);
      expect(queue.overflowStrategy).toBe('drop-newest');
    });

    it.each([0, -1, -10, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
      'throws RangeError for invalid capacity: %s',
      (invalidCapacity) => {
        expect(() => new BoundedQueue(invalidCapacity)).toThrow(RangeError);
      },
    );
  });

  describe('push operations', () => {
    it('accepts items when within capacity', () => {
      const queue = new BoundedQueue<string>(3);

      const res1 = queue.push('item1');
      expect(res1).toEqual({
        accepted: true,
        depth: 1,
        totalDropped: 0,
      });
      expect(queue.length).toBe(1);

      const res2 = queue.push('item2');
      expect(res2).toEqual({
        accepted: true,
        depth: 2,
        totalDropped: 0,
      });
      expect(queue.length).toBe(2);
    });

    describe('overflow strategy: drop-oldest', () => {
      it('drops the oldest item when capacity is reached', () => {
        const queue = new BoundedQueue<string>(2, 'drop-oldest');
        queue.push('a');
        queue.push('b');

        const res = queue.push('c');
        expect(res).toEqual({
          accepted: true,
          depth: 2,
          dropped: 'a',
          totalDropped: 1,
        });
        expect(queue.length).toBe(2);

        // Remaining items should be 'b' and 'c'
        expect(queue.shift()).toBe('b');
        expect(queue.shift()).toBe('c');
      });

      it('tracks totalEnqueued correctly when items are dropped', () => {
        const queue = new BoundedQueue<string>(2, 'drop-oldest');
        queue.push('a');
        queue.push('b');
        queue.push('c');

        const snapshot = queue.snapshot();
        expect(snapshot.totalEnqueued).toBe(3);
        expect(snapshot.totalDropped).toBe(1);
      });
    });

    describe('overflow strategy: drop-newest', () => {
      it('rejects and drops the new item when capacity is reached', () => {
        const queue = new BoundedQueue<string>(2, 'drop-newest');
        queue.push('a');
        queue.push('b');

        const res = queue.push('c');
        expect(res).toEqual({
          accepted: false,
          depth: 2,
          dropped: 'c',
          totalDropped: 1,
        });
        expect(queue.length).toBe(2);

        // Existing items remain unchanged
        expect(queue.shift()).toBe('a');
        expect(queue.shift()).toBe('b');
      });

      it('does not increment totalEnqueued when new item is rejected', () => {
        const queue = new BoundedQueue<string>(2, 'drop-newest');
        queue.push('a');
        queue.push('b');
        queue.push('c');

        const snapshot = queue.snapshot();
        expect(snapshot.totalEnqueued).toBe(2);
        expect(snapshot.totalDropped).toBe(1);
      });
    });
  });

  describe('shift operations', () => {
    it('dequeues items in FIFO order and updates stats', () => {
      const queue = new BoundedQueue<number>(3);
      queue.push(10);
      queue.push(20);

      expect(queue.shift()).toBe(10);
      expect(queue.length).toBe(1);

      expect(queue.shift()).toBe(20);
      expect(queue.length).toBe(0);

      expect(queue.shift()).toBeUndefined();
      expect(queue.length).toBe(0);

      const snapshot = queue.snapshot();
      expect(snapshot.totalDequeued).toBe(2);
    });

    it('returns undefined and does not increment totalDequeued for empty queue', () => {
      const queue = new BoundedQueue<number>(3);
      expect(queue.shift()).toBeUndefined();

      const snapshot = queue.snapshot();
      expect(snapshot.totalDequeued).toBe(0);
    });
  });

  describe('drain operations', () => {
    it('drains all items by default', () => {
      const queue = new BoundedQueue<string>(5);
      queue.push('x');
      queue.push('y');
      queue.push('z');

      const drained = queue.drain();
      expect(drained).toEqual(['x', 'y', 'z']);
      expect(queue.length).toBe(0);

      const snapshot = queue.snapshot();
      expect(snapshot.totalDequeued).toBe(3);
    });

    it('drains up to the specified limit', () => {
      const queue = new BoundedQueue<string>(5);
      queue.push('x');
      queue.push('y');
      queue.push('z');

      const drained = queue.drain(2);
      expect(drained).toEqual(['x', 'y']);
      expect(queue.length).toBe(1);
      expect(queue.shift()).toBe('z');

      const snapshot = queue.snapshot();
      expect(snapshot.totalDequeued).toBe(3);
    });

    it('handles fractional limits by flooring them', () => {
      const queue = new BoundedQueue<string>(5);
      queue.push('a');
      queue.push('b');
      queue.push('c');

      const drained = queue.drain(2.9);
      expect(drained).toEqual(['a', 'b']);
      expect(queue.length).toBe(1);
    });

    it('returns empty array when limit is <= 0', () => {
      const queue = new BoundedQueue<string>(5);
      queue.push('a');

      expect(queue.drain(0)).toEqual([]);
      expect(queue.drain(-5)).toEqual([]);
      expect(queue.length).toBe(1);

      const snapshot = queue.snapshot();
      expect(snapshot.totalDequeued).toBe(0);
    });

    it('drains empty queue gracefully', () => {
      const queue = new BoundedQueue<string>(5);
      expect(queue.drain()).toEqual([]);
      expect(queue.snapshot().totalDequeued).toBe(0);
    });
  });

  describe('clear operation', () => {
    it('clears all items and increments dequeued count', () => {
      const queue = new BoundedQueue<number>(5);
      queue.push(1);
      queue.push(2);
      queue.push(3);

      queue.clear();
      expect(queue.length).toBe(0);
      expect(queue.shift()).toBeUndefined();

      const snapshot = queue.snapshot();
      expect(snapshot.depth).toBe(0);
      expect(snapshot.totalDequeued).toBe(3);
    });

    it('handles clear on empty queue', () => {
      const queue = new BoundedQueue<number>(5);
      queue.clear();
      expect(queue.length).toBe(0);
      expect(queue.snapshot().totalDequeued).toBe(0);
    });
  });

  describe('snapshot metric consistency', () => {
    it('accurately tracks metrics over complex sequence of operations', () => {
      const queue = new BoundedQueue<string>(3, 'drop-oldest');

      // Enqueue 4 items (1 drop)
      queue.push('1');
      queue.push('2');
      queue.push('3');
      queue.push('4'); // '1' dropped

      // Dequeue 1 item
      expect(queue.shift()).toBe('2');

      // Enqueue 2 items (1 drop)
      queue.push('5');
      queue.push('6'); // '3' dropped

      // Drain 2 items
      const drained = queue.drain(2);
      expect(drained).toEqual(['4', '5']);

      // Clear remaining (1 item: '6')
      queue.clear();

      const snapshot = queue.snapshot();
      expect(snapshot).toEqual({
        capacity: 3,
        depth: 0,
        totalEnqueued: 6,
        totalDequeued: 4, // 1 shifted + 2 drained + 1 cleared
        totalDropped: 2,
        overflowStrategy: 'drop-oldest',
      });
    });
  });
});
