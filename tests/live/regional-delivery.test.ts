import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_LIVE_HANDSHAKE_BYTES,
  liveDeliveryBytes,
  parseLiveServerFrame,
  prepareLivePayload,
  serializeLiveAcknowledgment,
  type LiveAcknowledgment,
  type LiveDeliveryMessage,
} from '../../src/live/delivery';
import { LIVE_STREAM_PROTOCOL_VERSION } from '../../src/live/protocol';
import type { AircraftQualityFlag, LiveFeedBinding } from '../../src/live/types';
import { MAX_LIVE_AIRCRAFT, MAX_LIVE_MESSAGE_BYTES } from '../../src/live/validation';
import {
  DELIVERY_METRIC_FLUSH_INTERVAL_MS,
  LIVE_DELIVERY_ACK_TIMEOUT_MS,
  MAX_REGIONAL_DELIVERY_BYTES,
  MAX_REGIONAL_CONTROL_BURST,
  MAX_REGIONAL_VIEWERS,
  MAX_SOCKET_CONTROLS_PER_WINDOW,
  MAX_VIEWER_ATTACHMENT_BYTES,
  RegionalDelivery,
  readViewerAttachment,
  type DeliverySocket,
  type ViewerAttachment,
} from '../../worker/delivery';
import {
  aircraftFixture,
  healthFixture,
  LIVE_FIXTURE_EPOCH,
  LIVE_FIXTURE_TIME,
  snapshotFixture,
} from './fixtures';

const binding: LiveFeedBinding = {
  providerId: 'adsb-lol',
  regionId: 'atlanta',
  feedEpoch: LIVE_FIXTURE_EPOCH,
};

class Socket implements DeliverySocket {
  readyState = 1;
  sent: string[] = [];
  private attachment: unknown;
  send = vi.fn((message: string) => {
    this.sent.push(message);
  });
  close = vi.fn((_code: number, _reason: string) => {
    this.readyState = 2;
  });
  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }
  deserializeAttachment(): unknown {
    return structuredClone(this.attachment);
  }
}

function snapshotPayload(sequence = 1, count = 1) {
  return prepareLivePayload({
    type: 'airspace.snapshot',
    protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
    snapshot: snapshotFixture({
      sequence,
      aircraft: Array.from({ length: count }, (_, index) =>
        aircraftFixture({ aircraftId: index.toString(16).padStart(6, '0') }),
      ),
    }),
  });
}

function nearLimitSnapshotPayload(sequence = 1) {
  const shortText = '界'.repeat(16);
  const sourceText = '界'.repeat(32);
  const qualityFlags: AircraftQualityFlag[] = [
    'missing-position',
    'stale-position',
    'stale-contact',
    'provider-time-regression',
    'time-uncertain',
  ];
  return prepareLivePayload({
    type: 'airspace.snapshot',
    protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
    snapshot: snapshotFixture({
      sequence,
      aircraft: Array.from({ length: MAX_LIVE_AIRCRAFT }, (_, index) =>
        aircraftFixture({
          aircraftId: index.toString(16).padStart(6, '0'),
          callsign: shortText,
          registration: shortText,
          aircraftType: shortText,
          category: shortText,
          sourceType: sourceText,
          barometricAltitudeFeet: Number.MAX_VALUE,
          geometricAltitudeFeet: -Number.MAX_VALUE,
          groundSpeedKnots: Number.MAX_VALUE,
          trackDegrees: 359.99999999999994,
          qualityFlags,
        }),
      ),
    }),
  });
}

function healthPayload(message = 'The provider responded.') {
  return prepareLivePayload({
    type: 'feed.health',
    protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
    health: healthFixture({ message }),
  });
}

function frame(socket: Socket): LiveDeliveryMessage {
  const parsed = parseLiveServerFrame(socket.sent.at(-1));
  if (!parsed.ok || parsed.message.type !== 'delivery') throw new Error('Expected a delivery.');
  return parsed.message;
}

function metadata(socket: Socket): ViewerAttachment {
  const value = readViewerAttachment(socket, binding);
  if (!value) throw new Error('Expected bounded viewer metadata.');
  return value;
}

function setup(viewers = 1, aircraft = 1, initialSnapshot = snapshotPayload(1, aircraft)) {
  const sockets: Socket[] = [];
  const schedule = vi.fn(async () => {});
  const hooks = { sockets: () => sockets, binding: () => binding, schedule };
  const delivery = new RegionalDelivery(hooks);
  delivery.prime([initialSnapshot, healthPayload()]);
  for (let index = 0; index < viewers; index++) {
    const socket = new Socket();
    sockets.push(socket);
    delivery.initialize(socket);
  }
  const acknowledge = async (socket: Socket) => {
    const ack = serializeLiveAcknowledgment(frame(socket));
    await delivery.control(socket, ack);
  };
  const chargedBytes = () =>
    MAX_REGIONAL_VIEWERS * MAX_LIVE_HANDSHAKE_BYTES +
    sockets.reduce((total, socket) => total + (metadata(socket).outstanding?.bytes ?? 0), 0);
  return { sockets, schedule, hooks, delivery, acknowledge, chargedBytes };
}

const ping = (requestId: string) =>
  JSON.stringify({ type: 'ping', protocolVersion: LIVE_STREAM_PROTOCOL_VERSION, requestId });

describe('bounded regional delivery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(LIVE_FIXTURE_TIME));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('admits 100 attached viewers and retains closing viewers in the cap', () => {
    const state = setup(MAX_REGIONAL_VIEWERS - 1);
    expect(state.delivery.canAccept()).toBe(true);
    const socket = new Socket();
    state.sockets.push(socket);
    state.delivery.initialize(socket);
    expect(state.delivery.canAccept()).toBe(false);
    socket.close(1000, 'Closing');
    expect(state.delivery.canAccept()).toBe(false);
    state.sockets.pop();
    expect(state.delivery.canAccept()).toBe(true);
  });

  it('commits an expiry before sending and holds exactly one delivery per viewer', async () => {
    const state = setup(2);
    state.schedule.mockImplementation(async () => {
      expect(state.sockets.every((socket) => socket.sent.length === 0)).toBe(true);
      expect(state.sockets.every((socket) => metadata(socket).outstanding?.sent === false)).toBe(
        true,
      );
      expect(state.delivery.nextDeadline()).toBe(Date.now() + LIVE_DELIVERY_ACK_TIMEOUT_MS);
    });
    await state.delivery.flush();
    expect(state.schedule).toHaveBeenCalledOnce();
    expect(state.sockets.map((socket) => socket.sent.length)).toEqual([1, 1]);
    expect(frame(state.sockets[0]!).messages.map((message) => message.type)).toEqual([
      'airspace.snapshot',
      'feed.health',
    ]);
    await state.delivery.flush();
    expect(state.sockets.map((socket) => socket.sent.length)).toEqual([1, 1]);
  });

  it('batches ACK and invalid-control operations without an ACK persistence deadline', async () => {
    const state = setup();
    await state.delivery.flush();
    await state.acknowledge(state.sockets[0]!);
    expect(state.delivery.operationalSnapshot()).toEqual({
      acknowledgmentCount: 1,
      timeoutCount: 0,
      sendFailureCount: 0,
      invalidControlCount: 0,
      hibernationLossCount: 0,
    });
    expect(state.delivery.nextOperationalFlushAt()).toBeUndefined();

    await state.delivery.control(state.sockets[0]!, 'invalid');
    expect(state.delivery.operationalSnapshot().invalidControlCount).toBe(1);
    expect(state.delivery.nextOperationalFlushAt()).toBe(
      Date.now() + DELIVERY_METRIC_FLUSH_INTERVAL_MS,
    );
    expect(state.delivery.takeOperationalCounters(Date.now())).toBeUndefined();
    vi.setSystemTime(Date.now() + DELIVERY_METRIC_FLUSH_INTERVAL_MS);
    expect(state.delivery.takeOperationalCounters(Date.now())).toEqual({
      acknowledgmentCount: 1,
      timeoutCount: 0,
      sendFailureCount: 0,
      invalidControlCount: 1,
      hibernationLossCount: 0,
    });
    expect(state.delivery.operationalSnapshot().acknowledgmentCount).toBe(0);
  });

  it('coalesces updates to the latest shared state with no aircraft data in attachments', async () => {
    const state = setup();
    const socket = state.sockets[0]!;
    await state.delivery.flush();
    await state.delivery.publish([snapshotPayload(2)]);
    await state.delivery.publish([snapshotPayload(3)]);
    expect(socket.sent).toHaveLength(1);
    const attachment = metadata(socket);
    expect(attachment.pending).toBe(1);
    expect(Object.keys(attachment).sort()).toEqual([
      'attachmentVersion',
      'feedEpoch',
      'lastTurn',
      'outstanding',
      'pending',
      'providerId',
      'regionId',
    ]);
    expect(new TextEncoder().encode(JSON.stringify(attachment)).byteLength).toBeLessThan(
      MAX_VIEWER_ATTACHMENT_BYTES,
    );
    expect(JSON.stringify(attachment)).not.toMatch(
      /aircraft|position|callsign|registration|TEST123/u,
    );
    await state.acknowledge(socket);
    expect(socket.sent).toHaveLength(2);
    expect(frame(socket).messages[0]).toMatchObject({ snapshot: { sequence: 3 } });
    await state.acknowledge(socket);
    expect(metadata(socket).outstanding).toBeUndefined();
    expect(state.delivery.nextDeadline()).toBeUndefined();
  });

  it('lets 99 healthy viewers advance while one viewer stalls', async () => {
    const state = setup(100);
    await state.delivery.flush();
    for (const socket of state.sockets.slice(1)) await state.acknowledge(socket);
    await state.delivery.publish([snapshotPayload(2)]);
    expect(state.sockets[0]!.sent).toHaveLength(1);
    expect(state.sockets.slice(1).every((socket) => socket.sent.length === 2)).toBe(true);
    for (const socket of state.sockets.slice(1)) await state.acknowledge(socket);
    vi.setSystemTime(Date.now() + LIVE_DELIVERY_ACK_TIMEOUT_MS);
    state.delivery.expire();
    expect(state.sockets[0]!.close).toHaveBeenCalledWith(
      1008,
      'Live delivery acknowledgment timed out.',
    );
    expect(state.sockets.slice(1).every((socket) => socket.close.mock.calls.length === 0)).toBe(
      true,
    );
  });

  it('bounds all-stalled maximum-input fan-out and does not free closing credit', async () => {
    const state = setup(100, MAX_LIVE_AIRCRAFT);
    await state.delivery.flush();
    const sent = state.sockets.filter((socket) => socket.sent.length > 0);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThan(100);
    const charged = state.chargedBytes();
    expect(charged).toBeLessThanOrEqual(MAX_REGIONAL_DELIVERY_BYTES);
    await state.delivery.publish([snapshotPayload(2, MAX_LIVE_AIRCRAFT)]);
    expect(state.chargedBytes()).toBe(charged);
    vi.setSystemTime(Date.now() + LIVE_DELIVERY_ACK_TIMEOUT_MS);
    await state.delivery.flush();
    expect(sent.every((socket) => socket.readyState === 2)).toBe(true);
    expect(state.chargedBytes()).toBe(charged);
    await state.delivery.control(sent[0]!, serializeLiveAcknowledgment(frame(sent[0]!)));
    expect(state.chargedBytes()).toBe(charged);
    for (const socket of sent) state.sockets.splice(state.sockets.indexOf(socket), 1);
    await state.delivery.flush();
    expect(state.sockets.some((socket) => socket.sent.length > 0)).toBe(true);
    expect(state.chargedBytes()).toBeLessThanOrEqual(MAX_REGIONAL_DELIVERY_BYTES);
  });

  it('reserves all connection credit before admitting late viewers to a saturated region', async () => {
    const state = setup(4);
    const reservedConnections = MAX_REGIONAL_VIEWERS * MAX_LIVE_HANDSHAKE_BYTES;
    const occupied = [
      MAX_LIVE_MESSAGE_BYTES,
      MAX_LIVE_MESSAGE_BYTES,
      MAX_LIVE_MESSAGE_BYTES,
      MAX_LIVE_MESSAGE_BYTES - reservedConnections,
    ];
    // Recovered old large batches can coexist with a much smaller current snapshot.
    for (const [index, socket] of state.sockets.entries()) {
      socket.serializeAttachment({
        ...metadata(socket),
        pending: 0,
        outstanding: {
          deliveryId: 'held-' + index,
          bytes: occupied[index]!,
          expiresAt: Date.now() + LIVE_DELIVERY_ACK_TIMEOUT_MS,
          sent: true,
        },
      } satisfies ViewerAttachment);
    }
    expect(state.chargedBytes()).toBe(MAX_REGIONAL_DELIVERY_BYTES);
    const lateViewers: Socket[] = [];
    while (state.delivery.canAccept()) {
      const socket = new Socket();
      lateViewers.push(socket);
      state.sockets.push(socket);
      state.delivery.initialize(socket);
      await state.delivery.flush();
      expect(state.chargedBytes()).toBe(MAX_REGIONAL_DELIVERY_BYTES);
      expect(socket.sent).toHaveLength(0);
    }
    expect(lateViewers).toHaveLength(MAX_REGIONAL_VIEWERS - occupied.length);
    await state.delivery.control(
      state.sockets[0]!,
      JSON.stringify({
        type: 'ack',
        protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
        ...binding,
        deliveryId: 'held-0',
      } satisfies LiveAcknowledgment),
    );
    expect(lateViewers.every((socket) => socket.sent.length === 1)).toBe(true);
    expect(state.chargedBytes()).toBeLessThanOrEqual(MAX_REGIONAL_DELIVERY_BYTES);
  });

  it('serves an older waiting large viewer before re-serving a fast viewer', async () => {
    const state = setup(10, MAX_LIVE_AIRCRAFT);
    await state.delivery.flush();
    const waiting = state.sockets.find((socket) => socket.sent.length === 0)!;
    expect(waiting).toBeDefined();
    const fast = state.sockets[0]!;
    await state.delivery.publish([snapshotPayload(2, MAX_LIVE_AIRCRAFT)]);
    await state.acknowledge(fast);
    expect(waiting.sent).toHaveLength(1);
    expect(frame(waiting).messages[0]).toMatchObject({ snapshot: { sequence: 2 } });
    expect(fast.sent).toHaveLength(1);
    expect(state.chargedBytes()).toBeLessThanOrEqual(MAX_REGIONAL_DELIVERY_BYTES);
  });

  it('eventually serves every older ready viewer under valid near-limit mixed-size releases', async () => {
    const nearLimit = nearLimitSnapshotPayload();
    const initialHealth = healthPayload();
    const envelopeBytes = liveDeliveryBytes(binding, '00000000-0000-4000-8000-000000000000', [
      nearLimit,
      initialHealth,
    ]);
    expect(envelopeBytes).toBeGreaterThanOrEqual(Math.floor(MAX_LIVE_MESSAGE_BYTES * 0.95));
    expect(envelopeBytes).toBeLessThanOrEqual(MAX_LIVE_MESSAGE_BYTES);

    const state = setup(MAX_REGIONAL_VIEWERS, 1, nearLimit);
    await state.delivery.flush();
    const initiallyServed = state.sockets.filter((socket) => socket.sent.length === 1);
    const waiting = state.sockets.filter((socket) => socket.sent.length === 0);
    expect(initiallyServed.length).toBeGreaterThan(0);
    expect(waiting.length).toBeGreaterThan(0);
    expect(state.chargedBytes()).toBeLessThanOrEqual(MAX_REGIONAL_DELIVERY_BYTES);

    const fast = initiallyServed[0]!;
    await state.delivery.publish([healthPayload('Mixed-size fairness update.')]);
    const acknowledgeOutstanding = async (socket: Socket) => {
      const outstanding = metadata(socket).outstanding;
      if (!outstanding?.sent) throw new Error('Expected a sent delivery receipt.');
      await state.delivery.control(
        socket,
        JSON.stringify({
          type: 'ack',
          protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
          ...binding,
          deliveryId: outstanding.deliveryId,
        } satisfies LiveAcknowledgment),
      );
    };

    let creditOwner = fast;
    for (const [index, expected] of waiting.entries()) {
      await acknowledgeOutstanding(creditOwner);
      expect(expected.sent).toHaveLength(1);
      const remaining = waiting.slice(index + 1);
      expect(remaining.every((socket) => socket.sent.length === 0)).toBe(true);
      if (remaining.length > 0) expect(fast.sent).toHaveLength(1);
      expect(state.chargedBytes()).toBeLessThanOrEqual(MAX_REGIONAL_DELIVERY_BYTES);
      creditOwner = expected;
    }

    if (fast.sent.length === 1) await acknowledgeOutstanding(creditOwner);
    expect(fast.sent).toHaveLength(2);
    expect(frame(fast).messages.map((message) => message.type)).toEqual(['feed.health']);
    expect(state.sockets.every((socket) => socket.sent.length > 0)).toBe(true);
    expect(state.chargedBytes()).toBeLessThanOrEqual(MAX_REGIONAL_DELIVERY_BYTES);
  }, 20_000);

  it.each(['wrong-token', 'wrong-binding', 'cross-socket', 'stale-token'])(
    'does not release another delivery for %s',
    async (kind) => {
      const state = setup(2);
      const [first, second] = state.sockets as [Socket, Socket];
      await state.delivery.flush();
      const original = frame(first);
      const beforeSecond = metadata(second).outstanding;
      let ack = JSON.parse(serializeLiveAcknowledgment(original)) as Record<string, unknown>;
      if (kind === 'wrong-token') ack.deliveryId = 'unknown';
      if (kind === 'wrong-binding') ack.feedEpoch = 'other';
      if (kind === 'cross-socket') ack = JSON.parse(serializeLiveAcknowledgment(frame(second)));
      if (kind === 'stale-token') {
        await state.acknowledge(first);
        await state.delivery.publish([snapshotPayload(2)]);
      }
      const expected = metadata(first).outstanding;
      await state.delivery.control(first, JSON.stringify(ack));
      expect(first.close).toHaveBeenCalledWith(1008, 'Invalid live delivery acknowledgment.');
      expect(metadata(first).outstanding).toEqual(expected);
      expect(metadata(second).outstanding).toEqual(beforeSecond);
    },
  );

  it('rejects an otherwise matching ACK at the exact deadline', async () => {
    const state = setup();
    await state.delivery.flush();
    const socket = state.sockets[0]!;
    const outstanding = metadata(socket).outstanding;
    vi.setSystemTime(outstanding!.expiresAt);
    await state.acknowledge(socket);
    expect(socket.close).toHaveBeenCalledWith(1008, 'Live delivery acknowledgment timed out.');
    expect(metadata(socket).outstanding).toEqual(outstanding);
    expect(state.delivery.nextDeadline()).toBeUndefined();
  });

  it('queues one ping and timestamps its pong at actual send after scheduling', async () => {
    const state = setup();
    const socket = state.sockets[0]!;
    await state.delivery.flush();
    await state.delivery.control(socket, ping('waiting-ping'));
    expect(metadata(socket).pendingPingId).toBe('waiting-ping');
    expect(socket.sent).toHaveLength(1);
    let release!: () => void;
    state.schedule.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const acknowledgment = state.acknowledge(socket);
    await Promise.resolve();
    await Promise.resolve();
    expect(release).toBeTypeOf('function');
    vi.setSystemTime(Date.now() + 5_000);
    release();
    await acknowledgment;
    expect(frame(socket).messages).toEqual([
      expect.objectContaining({
        type: 'pong',
        requestId: 'waiting-ping',
        generatedAt: new Date(Date.now()).toISOString(),
      }),
    ]);
    expect(metadata(socket).pendingPingId).toBeUndefined();
  });

  it.each(['invalid', 'oversized', 'binary', 'ping-flood', 'queued-ping-flood'])(
    'closes %s without an error echo or a control queue',
    async (kind) => {
      const state = setup();
      const socket = state.sockets[0]!;
      await state.delivery.flush();
      let message: unknown = '{';
      if (kind === 'oversized') message = 'x'.repeat(513);
      if (kind === 'binary') message = new ArrayBuffer(1);
      if (kind.includes('flood')) {
        await state.delivery.control(socket, ping('first'));
        if (kind === 'queued-ping-flood') vi.setSystemTime(Date.now() + 1_000);
        message = ping('second');
      }
      await state.delivery.control(socket, message);
      expect(socket.close).toHaveBeenCalledWith(
        1008,
        'Invalid or excessive live control messages.',
      );
      expect(socket.sent).toHaveLength(1);
    },
  );

  it('accepts the exact per-socket control window and closes control nine before a scan', async () => {
    const state = setup();
    const socket = state.sockets[0]!;
    await state.delivery.flush();
    for (let sequence = 1; sequence <= MAX_SOCKET_CONTROLS_PER_WINDOW; sequence++) {
      await state.acknowledge(socket);
      if (sequence < MAX_SOCKET_CONTROLS_PER_WINDOW) {
        await state.delivery.publish([snapshotPayload(sequence + 1)]);
      }
    }
    await state.delivery.publish([snapshotPayload(MAX_SOCKET_CONTROLS_PER_WINDOW + 1)]);
    const before = metadata(socket).outstanding;
    await state.acknowledge(socket);
    expect(socket.close).toHaveBeenCalledWith(1008, 'Invalid or excessive live control messages.');
    expect(metadata(socket).outstanding).toEqual(before);
  });

  it('closes regional control 513 while preserving its unprocessed receipt', async () => {
    const state = setup(100);
    await state.delivery.flush();
    for (const socket of state.sockets) await state.acknowledge(socket);
    for (let sequence = 2; sequence <= 5; sequence++) {
      await state.delivery.publish([snapshotPayload(sequence)]);
      for (const socket of state.sockets) await state.acknowledge(socket);
    }
    await state.delivery.publish([snapshotPayload(6)]);
    const finalRound = MAX_REGIONAL_CONTROL_BURST - 500;
    for (const socket of state.sockets.slice(0, finalRound)) await state.acknowledge(socket);
    const rejected = state.sockets[finalRound]!;
    const before = metadata(rejected).outstanding;
    await state.acknowledge(rejected);
    expect(rejected.close).toHaveBeenCalledWith(
      1013,
      'Regional live control capacity is temporarily full.',
    );
    expect(metadata(rejected).outstanding).toEqual(before);
    const healthy = state.sockets[finalRound + 1]!;
    vi.setSystemTime(Date.now() + 1_000);
    await state.acknowledge(healthy);
    expect(healthy.close).not.toHaveBeenCalled();
    expect(metadata(healthy).outstanding).toBeUndefined();
  });

  it('fails closed without sending when the durable deadline cannot commit', async () => {
    const state = setup(2);
    state.schedule.mockRejectedValue(new Error('Controlled schedule failure'));
    await expect(state.delivery.flush()).rejects.toThrow('Controlled schedule failure');
    expect(state.sockets.every((socket) => socket.sent.length === 0)).toBe(true);
    expect(state.sockets.every((socket) => metadata(socket).outstanding?.sent === false)).toBe(
      true,
    );
    expect(state.sockets.every((socket) => socket.readyState === 2)).toBe(true);
  });

  it('closes an expired reservation instead of sending after a slow alarm commit', async () => {
    const state = setup();
    state.schedule.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + LIVE_DELIVERY_ACK_TIMEOUT_MS);
    });
    await state.delivery.flush();
    expect(state.sockets[0]!.sent).toEqual([]);
    expect(state.sockets[0]!.readyState).toBe(2);
    expect(state.delivery.operationalSnapshot().timeoutCount).toBe(1);
  });

  it('isolates a send failure and preserves conservative credit for the closing socket', async () => {
    const state = setup(2);
    state.sockets[0]!.send.mockImplementation(() => {
      throw new Error('Controlled send failure');
    });
    await state.delivery.flush();
    expect(state.sockets[0]!.close).toHaveBeenCalledWith(1011, 'Live delivery send failed.');
    expect(metadata(state.sockets[0]!).outstanding).toBeDefined();
    expect(state.sockets[1]!.sent).toHaveLength(1);
    expect(state.delivery.operationalSnapshot().sendFailureCount).toBe(1);
  });

  it('reconstructs sent and unsent reservations after a mid-fan-out interruption', async () => {
    const state = setup(2);
    const [first, second] = state.sockets as [Socket, Socket];
    const originalSerialize = second.serializeAttachment.bind(second);
    const interrupted = vi
      .spyOn(second, 'serializeAttachment')
      .mockImplementation((value: unknown) => {
        const attachment = value as ViewerAttachment;
        if (attachment.outstanding?.sent) {
          throw new Error('Controlled interruption during fan-out');
        }
        originalSerialize(value);
      });

    await expect(state.delivery.flush()).rejects.toThrow('Controlled interruption during fan-out');
    expect(first.sent).toHaveLength(1);
    expect(metadata(first).outstanding?.sent).toBe(true);
    expect(second.sent).toHaveLength(0);
    expect(metadata(second).outstanding?.sent).toBe(false);
    const charged = state.chargedBytes();

    interrupted.mockRestore();
    const restored = new RegionalDelivery(state.hooks);
    expect(restored.nextDeadline()).toBe(Date.now() + LIVE_DELIVERY_ACK_TIMEOUT_MS);
    await restored.control(first, serializeLiveAcknowledgment(frame(first)));
    expect(metadata(first).outstanding).toBeUndefined();
    expect(metadata(second).outstanding?.sent).toBe(false);
    expect(state.chargedBytes()).toBeLessThan(charged);

    vi.setSystemTime(Date.now() + LIVE_DELIVERY_ACK_TIMEOUT_MS);
    restored.expire();
    expect(second.close).toHaveBeenCalledWith(1008, 'Live delivery acknowledgment timed out.');
    state.sockets.splice(state.sockets.indexOf(second), 1);
    await restored.publish([snapshotPayload(2)]);
    expect(frame(first).messages[0]).toMatchObject({ snapshot: { sequence: 2 } });
    expect(state.chargedBytes()).toBeLessThanOrEqual(MAX_REGIONAL_DELIVERY_BYTES);
  });

  it('reconstructs credit and receipt deadlines from metadata after a cold activation', async () => {
    const state = setup(10, MAX_LIVE_AIRCRAFT);
    await state.delivery.flush();
    const deadline = state.delivery.nextDeadline();
    const before = state.chargedBytes();
    const restored = new RegionalDelivery(state.hooks);
    expect(restored.nextDeadline()).toBe(deadline);
    await restored.publish([snapshotPayload(2, MAX_LIVE_AIRCRAFT)]);
    expect(state.chargedBytes()).toBe(before);
    const first = state.sockets[0]!;
    await restored.control(first, serializeLiveAcknowledgment(frame(first)));
    expect(
      state.sockets.some(
        (socket) =>
          socket.sent.length === 1 &&
          frame(socket).messages.some(
            (message) => message.type === 'airspace.snapshot' && message.snapshot.sequence === 2,
          ),
      ),
    ).toBe(true);
    expect(state.chargedBytes()).toBeLessThanOrEqual(MAX_REGIONAL_DELIVERY_BYTES);
  });

  it('rejects non-allowlisted attachment data and unsafe fairness ordinals', async () => {
    const state = setup(2);
    state.sockets[0]!.serializeAttachment({ ...metadata(state.sockets[0]!), aircraft: [] });
    expect(readViewerAttachment(state.sockets[0]!, binding)).toBeUndefined();
    state.delivery.expire();
    expect(state.sockets[0]!.close).toHaveBeenCalledWith(1012, 'Feed identity changed; reconnect.');
    state.sockets[1]!.serializeAttachment({
      ...metadata(state.sockets[1]!),
      lastTurn: Number.MAX_SAFE_INTEGER,
    });
    await expect(state.delivery.flush()).rejects.toThrow('scheduling ordinal is exhausted');
    expect(state.sockets[1]!.sent).toEqual([]);
  });
});
