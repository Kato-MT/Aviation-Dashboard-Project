# Flight Diagnostics Workbench v2.1.0 release verification

This record closes the reusable release template with evidence from the exact tagged commit. All telemetry, profiles, thresholds, and injected scenarios are synthetic and unclassified.

## Identity

| Field              | Verified value                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Release            | [`v2.1.0`](https://github.com/Kato-MT/Aviation-Dashboard-Project/releases/tag/v2.1.0), published with 18 assets         |
| Pull request       | [`#9`](https://github.com/Kato-MT/Aviation-Dashboard-Project/pull/9)                                                    |
| Git and tag commit | `4439cbe06f5c7e85fba523e25cc04b3eba2c7f98`                                                                              |
| CI run             | [`29573374418`](https://github.com/Kato-MT/Aviation-Dashboard-Project/actions/runs/29573374418)                         |
| Release run        | [`29574353288`](https://github.com/Kato-MT/Aviation-Dashboard-Project/actions/runs/29574353288)                         |
| Pages deployment   | [`29574326869`](https://github.com/Kato-MT/Aviation-Dashboard-Project/actions/runs/29574326869), exact commit, HTTP 200 |
| Verification date  | 2026-07-17                                                                                                              |
| Verifier           | Automated CI, release workflow, and final browser inspection                                                            |

## Repository gates

| Gate                                   | Evidence                                                                                                                              | Result |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Protected `main`                       | Pull request, conversation resolution, six required checks, administrators enforced, force pushes and deletions disabled              | Pass   |
| Validation and core coverage           | CI run `29573374418`; 98.50% lines, 98.16% statements, 95.83% functions, 91.27% branches                                              | Pass   |
| Browser, responsive, and accessibility | 30 Playwright cases on desktop and Pixel 7; zero serious or critical axe findings                                                     | Pass   |
| CodeQL                                 | [`29573374486`](https://github.com/Kato-MT/Aviation-Dashboard-Project/actions/runs/29573374486), JavaScript/TypeScript and Python     | Pass   |
| Dependency review                      | [`29573374431`](https://github.com/Kato-MT/Aviation-Dashboard-Project/actions/runs/29573374431)                                       | Pass   |
| Dependency audit                       | Release verification report records no high or critical known vulnerability gate failure                                              | Pass   |
| Mutation testing                       | [`29573374449`](https://github.com/Kato-MT/Aviation-Dashboard-Project/actions/runs/29573374449); 63.79% score against a 60% threshold | Pass   |
| Requirements traceability              | 100 requirements and 159 declared test IDs in `traceability-report.json`                                                              | Pass   |

Mutation evidence covered 1,803 generated mutants: 1,113 valid, 690 killed, 20 timed out, 367 survived, and 36 had no coverage. The reported mutation score is not a claim of defect-free software.

## Deterministic regression

| Check                    |                                                           Expected | Actual | Result |
| ------------------------ | -----------------------------------------------------------------: | -----: | ------ |
| Included dataset SHA-256 | `b3b50781afde9b3895707109e40e86b2fae82ed8e38cc4e964d9cb2de327b700` |   Same | Pass   |
| Accepted records         |                                                                 85 |     85 | Pass   |
| Quarantined records      |                                                                  0 |      0 | Pass   |
| Overspeed findings       |                                                                  5 |      5 | Pass   |
| Rapid-descent findings   |                                                                  3 |      3 | Pass   |
| Fuel-change findings     |                                                                  1 |      1 | Pass   |
| Total findings           |                                                                  9 |      9 | Pass   |

Equivalent CSV and JSON normalization, declared deterministic fault scenarios, invalid-row quarantine, and failure paths passed in the exact-commit unit and integration suite.

## Model and analytics evidence

| Check                        | Verified value                                                                                                                            | Result |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Model artifact               | `learned-baseline.v1`, version `1.0.0`, SHA-256 `6b8f286e2b2d7db49a8953cae5e301c40bc3f6154cd0b3197afad5647310ce66`                        | Pass   |
| Evaluation artifact          | SHA-256 `253c5558a68b8b3cd433779b6212eac80f6d2767597b3ff143ec0cb493c1a9e7`                                                                | Pass   |
| TypeScript and Python parity | Reference score `27.18691586461726`, tolerance `1e-10`; vector SHA-256 `e1ebf1406c10256bd6d2bb553c3faf96170c49ce0433aa465a954a6532c637f7` | Pass   |
| Held-out metrics             | Precision 0.845070422535, recall 1.0, F1 0.916030534351, false-positive rate 0.011702127660                                               | Pass   |
| Enablement gates             | F1 at least 0.85 and false-positive rate at most 0.05                                                                                     | Pass   |
| SQLite analytics             | Migrations, foreign keys, indexes, integrity checks, and 14 documented queries                                                            | Pass   |

The learned detector remains experimental and cannot change authoritative deterministic verification status.

## Build and release artifacts

| Artifact            | SHA-256                                                            | Result |
| ------------------- | ------------------------------------------------------------------ | ------ |
| Pages build archive | `29e2478cddcaaeaf67c31396988865df0b3593f38937958b84adbd79f9cc4f21` | Pass   |
| Offline HTML        | `02f856f42f7ff21432bd83014ba35e2bbbcc96830f80e06a8af73ff231a76cba` | Pass   |
| Verification report | `bbf238b7ae51f02b732955c04ce86ede0caa1d36fbd59b34075609a290d539f5` | Pass   |
| Traceability JSON   | `a8eb15e231b5fa2453432022a1a1ade6daa60f31979717b7173867ffe6fddbf9` | Pass   |
| SBOM                | `340fb35e159581c20ee4649a4c5378ddafcba3b616d6e1a0806c551323d49b5a` | Pass   |
| Checksums           | All 17 listed release payloads matched                             | Pass   |

GitHub Actions generated the SBOM, SHA-256 manifest, and artifact attestations from the tagged commit. Source telemetry was excluded from the verification report.

## Manual visual verification

| Environment      | Browser                  | Viewport                  | Views checked                                     | Result |
| ---------------- | ------------------------ | ------------------------- | ------------------------------------------------- | ------ |
| Windows desktop  | Chromium `149.0.7827.55` | 1440 by 1000              | Monitor, Diagnostics, Verification, Configuration | Pass   |
| Mobile emulation | Chromium `149.0.7827.55` | 390 by 844, Pixel 7 class | Monitor, Diagnostics, Verification, Configuration | Pass   |

The live GitHub Pages build loaded successfully over HTTPS. The final checks covered responsive layout, keyboard replay operation, visible focus, non-color status text, and the loading, empty, nominal, warning, and failure paths represented by the automated browser suite.

## Decision

- Every result above is tied to the exact tagged commit or its release artifacts.
- Known limitations and the synthetic-data boundary are published.
- The deployed Pages commit matches the release commit.
- The offline and Pages outputs were produced from the same verified source revision.

Release decision: **Pass**
