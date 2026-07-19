# Requirements-to-test traceability

The machine-readable source is [`traceability.json`](traceability.json). CI checks that every stable requirement in [`requirements.md`](requirements.md) appears in at least one mapping and that every mapped test ID exists in [`test-cases.md`](test-cases.md).

Evidence paths identify the source directories expected to implement the cases. A mapping is not a test result. Actual pass, coverage, accessibility, security, model, and performance results come from CI or release evidence for the exact commit.

The v2.2 catalog also labels release-required cases as `Linked` or `Pending`. `Linked` identifies an existing test source only; it does not claim that the test passed. Every `Pending` case must gain automated evidence and pass the release gates before v2.2 can be described as verified.

| Area                                 | Requirement IDs                    | Test IDs                                           | Evidence roots                                  |
| ------------------------------------ | ---------------------------------- | -------------------------------------------------- | ----------------------------------------------- |
| Canonical model                      | FDW-ING-001..002                   | TC-CSV-001, TC-JSON-001, TC-PRO-006                | `tests/core`, `tests/integration`               |
| Included regression                  | FDW-ING-003, FDW-RUL-009           | TC-CSV-001..002, TC-RULE-001..004                  | `tests/core`, `tests/integration`               |
| JSON and explicit mappings           | FDW-ING-004..005                   | TC-JSON-001..005                                   | `tests/core`                                    |
| Invalid values and quarantine        | FDW-ING-006..007, 009              | TC-CSV-007..015, TC-JSON-006                       | `tests/core`, `tests/integration`               |
| Fatal validation                     | FDW-ING-008, 016, FDW-RUL-008      | CSV, JSON, and profile fatal cases                 | `tests/core`, `tests/integration`               |
| Adapter equivalence                  | FDW-ING-010                        | TC-JSON-008..009                                   | `tests/integration`                             |
| Timing and sequence                  | FDW-ING-011..012                   | TC-RULE-011..017                                   | `tests/core`                                    |
| Limits and hashing                   | FDW-ING-013..015                   | TC-CSV-002, 018..020                               | `tests/core`, `tests/performance`               |
| Profiles and rule identity           | FDW-RUL-001..003                   | TC-PRO-001..003, 006, TC-RULE-007                  | `tests/core`                                    |
| Rule families                        | FDW-RUL-004..007                   | TC-RULE-005..010, 018..021                         | `tests/core`                                    |
| Finding evidence and determinism     | FDW-RUL-010..012                   | TC-RULE-007, 022..023                              | `tests/core`                                    |
| Fault injection                      | FDW-FLT-001..005                   | TC-FLT-001..012                                    | `tests/core`, `tests/integration`               |
| Verification                         | FDW-VER-001..008                   | TC-VER-001..009                                    | `tests/core`, `tests/integration`               |
| Four-view UI                         | FDW-UI-001..006, 008, 010          | TC-UI-001..012                                     | `tests/browser`, `tests/accessibility`          |
| State isolation                      | FDW-UI-007, 009                    | TC-UI-013..017                                     | `tests/unit`, `tests/browser`                   |
| Exports                              | FDW-EXP-001..006                   | TC-EXP-001..006                                    | `tests/core`, `tests/unit`, `tests/browser`     |
| DOM and CSP                          | FDW-SEC-001, 009                   | TC-SEC-001..004                                    | `tests/unit`, `tests/browser`                   |
| Accessibility and responsive         | FDW-SEC-002..007                   | TC-A11Y-001..012                                   | `tests/accessibility`, `tests/browser`          |
| Dependency security                  | FDW-SEC-008                        | release audit and TC-BUILD-001                     | `.github/workflows`                             |
| Build and offline                    | FDW-CM-001..003                    | TC-BUILD-001..005                                  | `tests/browser`, `.github/workflows`            |
| Coverage and traceability            | FDW-CM-004..007                    | TC-CM-001..003                                     | all test roots and workflows                    |
| Release evidence                     | FDW-CM-008..010                    | build and traceability controls                    | `scripts/release`, `.github/workflows`, `docs`  |
| Streaming                            | FDW-STR-001..008                   | TC-STR-001..011                                    | `tests/streaming`                               |
| Learned baseline                     | FDW-ML-001..007                    | TC-ML-001..008                                     | `tests/ml`                                      |
| History analytics                    | FDW-DB-001..005                    | TC-DB-001..006                                     | `tests/analytics`                               |
| Advanced assurance                   | FDW-ADV-001..004                   | TC-ADV-001..003, TC-PERF-001..003, TC-DEV-001..002 | core, performance, container evidence           |
| v2.2 model registry                  | FDW-REG-001..005                   | TC-REG-001..008, TC-TML-010, 013                   | `tests/model-registry`, `tests/ml`, `models`    |
| v2.2 phase and fusion                | FDW-PHA-001..003, FDW-FUS-001..004 | TC-PHA-001..003, TC-FUS-001..004, TC-INV-003       | `tests/temporal`, `tests/investigation`         |
| v2.2 temporal scenarios              | FDW-TMP-001..006                   | TC-TMP-001..008, TC-INV-002                        | `tests/temporal`, `tests/investigation`         |
| v2.2 Investigation core              | FDW-INV-003..006                   | TC-INV-001..011                                    | `tests/investigation`, `tests/ui`               |
| v2.2 Investigation browser           | FDW-INV-001..002, 007              | TC-INV-012..014, TC-TACC-001, 003                  | browser and accessibility evidence              |
| v2.2 temporal v1 research evidence   | FDW-TML-001..011                   | TC-TML-001..015                                    | `tests/ml`, `tools/ml`, `models`                |
| v2.2 temporal v2 integrated advisory | FDW-TML-001..009                   | TC-TML-016..021                                    | `tests/ml`, `tools/ml`, `models`, Investigation |
| v2.2 campaign core and worker        | FDW-CAM-001..007, 009              | TC-CAM-001..012, 014                               | `tests/campaign`, `src/workers`                 |
| v2.2 campaign browser UI             | FDW-CAM-008                        | TC-CAM-012..013, TC-TACC-001..003                  | browser and accessibility evidence              |
| v2.2 campaign history                | FDW-TDB-001..006                   | TC-TDB-001..006                                    | `tests/analytics`, `tools/analytics`            |
| v2.2 data boundary                   | FDW-BND-001..003                   | TC-BND-001..004, TC-INV-006, 014                   | temporal, investigation, campaign, browser      |
| v2.2 accessibility                   | FDW-SEC-010..011                   | TC-INV-013, TC-TACC-001..003                       | `tests/accessibility`, `tests/browser`          |
| v2.2 offline browser assurance       | FDW-CM-011..012                    | TC-TOFF-001..003                                   | browser and Vite build evidence                 |

The integrated v2 selected-window cases verify the production data path, counts, identities, uncertainty, and the v2.2 evidence gate. They do not establish episode or full-stream learned-model performance. Full-stream false-alarm, onset, delay, phase, duration, and recovery evaluation is deferred to v2.3 and must remain separate from the v2.2 selected-window claim.

Run the structural check with:

```powershell
pnpm requirements:check
```

Use the stricter optional source-root check after all planned test roots exist:

```powershell
node scripts/release/verify-traceability.mjs --require-evidence-paths
```
