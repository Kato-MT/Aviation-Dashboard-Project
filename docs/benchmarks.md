# Benchmark record

## Status

The local working tree produced the measurements below on 2026-07-17. The machine-readable source is [`benchmark/latest.json`](../benchmark/latest.json). A tagged release must rerun the benchmark with `sourceRevision` set to the exact commit before presenting these as release results.

All benchmark datasets are generated synthetic and unclassified data. Results apply only to the recorded environment, configuration, and seed. They are not operational-performance claims.

## Method

- Benchmark: profile-driven deterministic rule engine
- Application version: `2.1.0`
- Source revision: `working-tree`
- Profile: `generic-fixed-wing` version `1.0.0`, synthetic demonstration profile
- Seed: `20260717`
- Sizes: 1,000, 10,000, and 100,000 samples
- Warm-up: one iteration
- Measured iterations: three
- Correctness check: every measured run completed with zero unexpected findings
- Excluded: browser rendering and network latency

Run:

```powershell
pnpm benchmark
```

## Recorded environment

| Field               | Value                      |
| ------------------- | -------------------------- |
| Recorded at         | `2026-07-17T08:27:01.037Z` |
| Node                | `v24.14.0`                 |
| Platform            | Windows `10.0.26200`, x64  |
| Logical CPUs        | 12                         |
| CI environment flag | `true`                     |

The environment flag was set during a local working-tree verification. It does not make this result a hosted CI or tagged-release result.

## Deterministic rule-engine results

`durationMs` is the mean of three measured iterations. With only three iterations, minimum and maximum show observed variation more honestly than an estimated p95.

| Samples | Mean ms | Minimum ms | Maximum ms | Samples/second | Peak heap bytes | Findings |
| ------: | ------: | ---------: | ---------: | -------------: | --------------: | -------: |
|   1,000 |  11.399 |      0.939 |     29.984 |         87,726 |      72,508,448 |        0 |
|  10,000 |  26.191 |      9.419 |     59.370 |        381,809 |      71,328,840 |        0 |
| 100,000 | 194.666 |    158.983 |    213.070 |        513,700 |     174,412,376 |        0 |

`peakHeapBytes` is absolute Node.js process heap, including loaded benchmark dependencies. It is not incremental rule-engine allocation.

## Reproducibility identities

| Samples | Dataset SHA-256                                                    | Configuration SHA-256                                              |
| ------: | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
|   1,000 | `d7a3df0c57f116254cb4243fa49863abbd963279911ca385a3734488982796ed` | `704a4e388a07e0258b8ed3718dfe362c4049c7d7ec99e8678816df14c669f446` |
|  10,000 | `af00383801d26e2c63cf56e0bb1b5d9cb4e43f8b882ec7184e41bbab823c2a55` | `1a613c11a0f5da54013e93f30cd05062b691e74dd2c684e169f5fd3444a703f6` |
| 100,000 | `dc6f4d5866131806103a9298fe3d5cd401a3efacdac7e8e506e9b2f28e48db2c` | `310761fff442896764c7cf4508b0a380ed72294930fad88fabb74b689afd4ede` |

## Interpretation

The three-sample timing set has visible host variation, especially at 1,000 samples. Compare trends only when source revision, generator, seed, profile, Node version, hardware, and iteration method are equivalent. A release report must retain accepted counts and finding parity so a faster incorrect result cannot pass as a performance improvement.
