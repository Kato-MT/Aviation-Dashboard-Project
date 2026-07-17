# Synthetic WebSocket Simulator

The simulator emits the same versioned `hello`, `telemetry`, `heartbeat`, and
`end` messages consumed by the in-browser streaming adapter. It supports
multiple deterministic sources and nine declared communication fault scenarios.
All generated data is synthetic and unclassified.

Run it after project dependencies are installed:

```powershell
pnpm simulator
```

Example with reproducible communications faults:

```powershell
pnpm simulator -- --seed 2021 --sources 3 --faults latency,jitter,dropped-packet,duplicate,reorder,stale-heartbeat,disconnect,queue-pressure
```

The `ws` runtime package and its TypeScript declarations are expected to be
provided by the root project. Run `pnpm simulator -- --help` for all options.
