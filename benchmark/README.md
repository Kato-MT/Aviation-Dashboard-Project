# Reproducible Performance Benchmark

`pnpm benchmark` measures the real profile-driven rule engine against generated
synthetic runs of 1,000, 10,000, and 100,000 samples. A fixed seed, fixed
timestamps, one warm-up, and three measured iterations are recorded with the
runtime environment in `benchmark/latest.json`.

Results vary by machine and background load. They are engineering evidence for
the measured commit and environment only, not operational performance claims.
Browser rendering and network latency are intentionally outside this benchmark.
`peakHeapBytes` is the absolute Node.js process heap, including loaded benchmark
dependencies, not incremental rule-engine allocation.
