import { expect, type Page } from '@playwright/test';
import {
  parseLiveAcknowledgment,
  parseLiveServerFrame,
  type LiveAcknowledgment,
  type LiveDeliveryMessage,
} from '../../src/live/delivery';
import { parseLivePing, type LiveStreamMessage } from '../../src/live/protocol';
import { sameLiveFeed } from '../../src/live/ordering';
import { LIVE_TEST_WEBSOCKET_ORIGIN } from './testOrigin';

/** Observe the actual browser protocol without sending controls on the client's behalf. */
export function captureLiveWire(page: Page) {
  const messages: LiveStreamMessage[] = [];
  const deliveries: LiveDeliveryMessage[] = [];
  const acknowledgments: LiveAcknowledgment[] = [];
  page.on('websocket', (socket) => {
    if (!socket.url().includes('/api/v1/airspace/')) return;
    expect(new URL(socket.url()).origin).toBe(LIVE_TEST_WEBSOCKET_ORIGIN);
    socket.on('framereceived', ({ payload }) => {
      const parsed = parseLiveServerFrame(String(payload));
      expect(parsed.ok, parsed.errors.join('; ')).toBe(true);
      if (!parsed.message) return;
      if (parsed.message.type === 'hello') messages.push(parsed.message);
      else {
        deliveries.push(parsed.message);
        messages.push(...parsed.message.messages);
      }
    });
    socket.on('framesent', ({ payload }) => {
      const acknowledgment = parseLiveAcknowledgment(String(payload));
      if (acknowledgment) acknowledgments.push(acknowledgment);
      else expect(parseLivePing(String(payload))).toBeDefined();
    });
  });
  return {
    messages,
    async expectAcknowledgments() {
      expect(deliveries.length).toBeGreaterThan(0);
      await expect
        .poll(() =>
          deliveries.every((delivery) =>
            acknowledgments.some(
              (ack) => ack.deliveryId === delivery.deliveryId && sameLiveFeed(ack, delivery),
            ),
          ),
        )
        .toBe(true);
      expect(new Set(acknowledgments.map((ack) => ack.deliveryId)).size).toBe(
        acknowledgments.length,
      );
      expect(
        acknowledgments.every((ack) =>
          deliveries.some(
            (delivery) => ack.deliveryId === delivery.deliveryId && sameLiveFeed(ack, delivery),
          ),
        ),
      ).toBe(true);
    },
  };
}
