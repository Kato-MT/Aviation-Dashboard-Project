# Temporal performance benchmark

## Evidence status

This file records locally measured **Node.js proxy evidence**. Rerun it on the exact release commit before presenting the measurements as release evidence. It does not measure browser rendering, worker startup, network latency, or user interaction latency. All inputs are generated synthetic and unclassified demonstration data.

Machine-readable evidence: [`benchmark/temporal-latest.json`](../benchmark/temporal-latest.json)

Run:

```powershell
pnpm benchmark:temporal
```

## Reproducibility

- Application version: `2.2.0`
- Source revision: `working-tree`
- Integrated temporal advisory model: `2.0.0`
- Model role: `integrated-production-advisory`
- Artifact: `models/temporal_fault_model_v2.json`
- Artifact SHA-256: `4cdea6792b8d302a8cc0197caccbb4498b18d136b1c2ed93fe798d66a82633af`
- Production projection: `investigation-model-projection@1.0.0`
- Authority: `deterministic-rules`
- Window length: 40 samples
- Warmups: 1
- Measured repetitions: 3
- Fixed inference seed: 22201
- Fixed investigation seed: 22202
- Fixed campaign seed base: 32001

## Recorded environment

| Field        | Value                              |
| ------------ | ---------------------------------- |
| Recorded at  | `2026-07-19T21:52:47.702Z`         |
| Runtime      | `node-proxy`                       |
| Node         | `v24.14.0`                         |
| V8           | `13.6.233.17-node.41`              |
| Platform     | `win32 10.0.26200`                 |
| Architecture | `x64`                              |
| CPU          | AMD Ryzen 5 5600X 6-Core Processor |
| Logical CPUs | 12                                 |
| CI flag      | `false`                            |

## Measured results

Timing values are descriptive, not pass or fail gates. Output hashes must remain stable across measured repetitions.

| Operation                |                     Work | Mean ms | Minimum ms | Maximum ms | Units/second |
| ------------------------ | -----------------------: | ------: | ---------: | ---------: | -----------: |
| temporal-model-inference |        141 model windows |  15.635 |     13.827 |     17.971 |    9,018.171 |
| temporal-model-inference |        961 model windows | 111.078 |     92.981 |    132.697 |    8,651.612 |
| temporal-model-inference |      9,961 model windows | 545.672 |    490.073 |    602.544 |   18,254.561 |
| temporal-investigation   |    180 telemetry samples |  13.140 |      9.370 |     15.568 |   13,699.082 |
| temporal-investigation   |  1,000 telemetry samples |  63.618 |     59.318 |     67.317 |   15,718.855 |
| temporal-investigation   | 10,000 telemetry samples | 645.870 |    582.898 |    730.062 |   15,482.999 |
| temporal-campaign        |        11 campaign cases | 151.609 |    142.953 |    168.185 |       72.555 |
| temporal-campaign        |        33 campaign cases | 337.690 |    319.723 |    352.883 |       97.723 |

## Reproducibility identities

| Benchmark                      | Input SHA-256                                                      | Configuration SHA-256                                              | Output SHA-256                                                     |
| ------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| temporal-model-inference-180   | `46bc75959dbc25c623afd8d01a73bd5442f9bb07c90becaa6db40731008e9c87` | `c8c1763000d0c821f251813d79003b9f5cca6f23c437cbce3ae9f68679565b83` | `56ef791fa0ff8a948994869dcb1bff6025bf4c56f690daa24453c4eabc63592d` |
| temporal-model-inference-1000  | `0e9cb46de2ea3b98b1672c3a26da56892c1e0881950971089cfe95c09b4cd1f1` | `ebf7731867a3760db0161401ad25d119019779df36830c8805a3887a78e6bc29` | `48a090886055f3a901bb94322d7b271b7bf114235c218241b74e30c9b66a5788` |
| temporal-model-inference-10000 | `c5b286bf76c124e4100e76889cee50f63d2414978c717018febe5f28b5dc9c28` | `6255201834113374d57cad8ac1947bbd3d5999a537033ae3e5bed9fe24bd52b0` | `9c499fbf93cfb930fccde3377c86c4600982209080afcd82ae3cede00906526c` |
| temporal-investigation-180     | `bbae4d898da25da334dd21a406dc46007d77e2e3c909d434c8d83e1aadc3c168` | `c9f3aaea45582e0e3498ea1f5c1d0ded4fa99428a42f0ae0d5c5957aad832f45` | `4e633708572363e6e19fa81b397c8a26bdf95feac93a5163d57c452bd2bd2fd2` |
| temporal-investigation-1000    | `a0f2c583c2f2e6b31d75a91b831b57d240819e0e7a65a01fceb5cb43b754c497` | `8067b14a5ea62518af37e03c5b1e98ae8c3cfcf1a5b5f88d40a87d3178485351` | `7e33f85fe2e38be821fb18f4335766c7d101395c291b9f6296b834caf3238f67` |
| temporal-investigation-10000   | `a25f041d99a700cb3243050afdde41d17753bc5f686b3148625884de1d5c8c2c` | `bb01c17c9a5b7b0a0f6166b0a955488ccfbdf9374b586cdd672896d2b71fe865` | `2ac300b1745718be2cfbda43f8d477a51d474b142589c0c8e0266040ef1278ce` |
| temporal-campaign-11           | `1269c09bcaae170da453a121d55135a39d58010296e5f72f2d59240599ccb474` | `a0723bd34ea1b09f8717e9920254a6bb51bff58288cca4d9d17dfe25196e6ee1` | `3f12aff4116795a8a2491643cce9d97763d2916b90f5f57d5500bf1d1d15f198` |
| temporal-campaign-33           | `7b28ee2ac7828f5bb1cd7278286b841cd7cc1dc0f35d9ce5fc06c544ac311f91` | `15b97b96462b744344f58c42fed4bf58b3ef8a79ddcb80accbb09cd5c0a53ea6` | `382f1e33d67c29396383178e408e5af386e9b59ccfd78a66791fad7d1976d6fc` |

## Limitations

- These are local Node.js proxy measurements, not browser rendering or interaction latency.
- Results depend on hardware, operating system, Node.js version, and background load.
- All inputs are generated synthetic and unclassified demonstration data.
- Campaign timing includes scenario generation, investigation, model advisory scoring, and campaign aggregation.
- maximumObservedHeapBytes is the absolute Node.js heap sampled at measurement boundaries, not incremental allocation or a guaranteed peak.
- No timing threshold is a release gate; deterministic output identity and completed execution are the correctness invariants.
