import { WebSocket, WebSocketServer } from 'ws';

import { BrowserDemoAdapter } from '../src/streaming/browserDemoAdapter';
import { serializeStreamMessage } from '../src/streaming/protocol';
import { buildFaultPlan, parseSimulatorArgs, simulatorHelp } from './config';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  process.stdout.write(`${simulatorHelp()}\n`);
  process.exit(0);
}

let config;
try {
  config = parseSimulatorArgs(args);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.stderr.write('Run with --help for usage.\n');
  process.exit(2);
}

const sources = Array.from({ length: config.sourceCount }, (_, index) => ({
  sourceId: `sim-${String(index + 1).padStart(2, '0')}`,
  profileId:
    index % 2 === 0 ? 'generic-fixed-wing.synthetic.v1' : 'generic-rotary-wing.synthetic.v1',
  phase: index * 0.83,
}));

const server = new WebSocketServer({ port: config.port });
const adapter = new BrowserDemoAdapter({
  seed: config.seed,
  sources,
  sampleIntervalMs: config.sampleIntervalMs,
  samplesPerSource: config.samplesPerSource,
  queueCapacity: config.queueCapacity,
  faultPlan: buildFaultPlan(config),
});

let started = false;

server.on('connection', () => {
  if (!started) {
    started = true;
    adapter.start();
  }
});

adapter.subscribe((event) => {
  if (event.type === 'message') {
    broadcast(serializeStreamMessage(event.message));
  } else if (event.type === 'queue-pressure') {
    process.stdout.write(
      `Synthetic queue pressure: depth=${event.depth} dropped=${event.totalDropped}\n`,
    );
  } else if (event.type === 'disconnect') {
    for (const socket of server.clients) {
      socket.close(1012, 'synthetic disconnect fault');
    }
  } else if (event.type === 'complete') {
    setTimeout(() => {
      for (const socket of server.clients) {
        socket.close(1000, 'simulation complete');
      }
    }, 50);
  }
});

server.on('listening', () => {
  process.stdout.write(
    [
      `Synthetic simulator listening on ws://localhost:${config.port}`,
      `seed=${config.seed}`,
      `sources=${config.sourceCount}`,
      `faults=${config.enabledFaults.join(',') || 'none'}`,
    ].join(' ') + '\n',
  );
});

server.on('error', (error) => {
  process.stderr.write(`Simulator error: ${error.message}\n`);
  process.exitCode = 1;
});

function broadcast(payload: string): void {
  for (const socket of server.clients) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(payload);
    }
  }
}

function shutdown(): void {
  adapter.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2_000).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
