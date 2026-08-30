import { runInDurableObject } from 'cloudflare:test';
import { expect, vi } from 'vitest';
import { parseLiveServerFrame, serializeLiveAcknowledgment } from '../../src/live/delivery';
import type { LiveStreamMessage } from '../../src/live/protocol';
import type { RegionalFeedHub } from '../../worker/regionalFeedHub';
import type { ViewerAttachment } from '../../worker/delivery';

interface Reader {
  listeners: Set<(message?: LiveStreamMessage, error?: Error) => void>;
  automaticAcknowledgments: boolean;
  pendingAcknowledgment?: string;
  failed?: Error;
}

const readers = new WeakMap<WebSocket, Reader>();

function readerFor(socket: WebSocket): Reader {
  const existing = readers.get(socket);
  if (existing) return existing;
  const reader: Reader = { listeners: new Set(), automaticAcknowledgments: true };
  readers.set(socket, reader);
  const fail = (error: Error) => {
    reader.failed = error;
    for (const listener of [...reader.listeners]) listener(undefined, error);
  };
  socket.addEventListener('message', (event) => {
    const result = parseLiveServerFrame(event.data);
    if (!result.ok) {
      fail(new Error(result.errors.join(' ')));
      return;
    }
    const frame = result.message;
    const messages = frame.type === 'hello' ? [frame] : frame.messages;
    for (const message of messages) for (const listener of [...reader.listeners]) listener(message);
    // One reader owns receipts, including batches that do not match a current waiter.
    if (frame.type === 'delivery' && socket.readyState === WebSocket.OPEN) {
      const ack = serializeLiveAcknowledgment(frame);
      if (reader.automaticAcknowledgments) socket.send(ack);
      else reader.pendingAcknowledgment = ack;
    }
  });
  socket.addEventListener('close', () =>
    fail(new Error('Socket closed before expected delivery.')),
  );
  socket.addEventListener('error', () =>
    fail(new Error('Socket failed before expected delivery.')),
  );
  return reader;
}

export function setAutomaticAcknowledgments(socket: WebSocket, enabled: boolean): void {
  const reader = readerFor(socket);
  reader.automaticAcknowledgments = enabled;
  if (enabled && reader.pendingAcknowledgment && socket.readyState === WebSocket.OPEN) {
    const ack = reader.pendingAcknowledgment;
    delete reader.pendingAcknowledgment;
    socket.send(ack);
  }
}

export function nextFrame<T extends LiveStreamMessage['type']>(
  socket: WebSocket,
  type: T,
  matches: (frame: Extract<LiveStreamMessage, { type: T }>) => boolean = () => true,
  rejectProviderError = false,
): Promise<Extract<LiveStreamMessage, { type: T }>> {
  const reader = readerFor(socket);
  if (reader.failed) return Promise.reject(reader.failed);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      reader.listeners.delete(listener);
    };
    const listener = (message?: LiveStreamMessage, error?: Error) => {
      if (error || (rejectProviderError && message?.type === 'error')) {
        cleanup();
        reject(
          error ?? new Error(message?.type === 'error' ? message.message : 'Delivery failed.'),
        );
      } else if (message?.type === type) {
        const frame = message as Extract<LiveStreamMessage, { type: T }>;
        if (!matches(frame)) return;
        cleanup();
        resolve(frame);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for ' + type + '.'));
    }, 2_000);
    reader.listeners.add(listener);
  });
}

export async function nextSnapshot(socket: WebSocket) {
  return (await nextFrame(socket, 'airspace.snapshot', () => true, true)).snapshot;
}

export function nextClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener('close', closed);
      reject(new Error('Timed out waiting for the close handshake.'));
    }, 2_000);
    const closed = (event: CloseEvent) => {
      clearTimeout(timer);
      resolve(event);
    };
    socket.addEventListener('close', closed, { once: true });
  });
}

export async function deliveriesSettled(stub: DurableObjectStub<RegionalFeedHub>): Promise<void> {
  await vi.waitFor(
    async () => {
      const attachments = await runInDurableObject(stub, (_instance, state) =>
        state
          .getWebSockets()
          .filter((socket) => socket.readyState === WebSocket.OPEN)
          .map((socket) => socket.deserializeAttachment() as ViewerAttachment),
      );
      expect(
        attachments.every(
          (value) => !value.outstanding && value.pending === 0 && !value.pendingPingId,
        ),
      ).toBe(true);
    },
    { timeout: 2_000, interval: 10 },
  );
}
