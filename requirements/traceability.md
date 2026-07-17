# Requirements-to-test traceability

The machine-readable source is [`traceability.json`](traceability.json). CI checks that every stable requirement in [`requirements.md`](requirements.md) appears in at least one mapping and that every mapped test ID exists in [`test-cases.md`](test-cases.md).

Evidence paths identify the source directories expected to implement the cases. A mapping is not a test result. Actual pass, coverage, accessibility, security, model, and performance results come from CI or release evidence for the exact commit.

| Area                             | Requirement IDs               | Test IDs                                           | Evidence roots                                 |
| -------------------------------- | ----------------------------- | -------------------------------------------------- | ---------------------------------------------- |
| Canonical model                  | FDW-ING-001..002              | TC-CSV-001, TC-JSON-001, TC-PRO-006                | `tests/core`, `tests/integration`              |
| Included regression              | FDW-ING-003, FDW-RUL-009      | TC-CSV-001..002, TC-RULE-001..004                  | `tests/core`, `tests/integration`              |
| JSON and explicit mappings       | FDW-ING-004..005              | TC-JSON-001..005                                   | `tests/core`                                   |
| Invalid values and quarantine    | FDW-ING-006..007, 009         | TC-CSV-007..015, TC-JSON-006                       | `tests/core`, `tests/integration`              |
| Fatal validation                 | FDW-ING-008, 016, FDW-RUL-008 | CSV, JSON, and profile fatal cases                 | `tests/core`, `tests/integration`              |
| Adapter equivalence              | FDW-ING-010                   | TC-JSON-008..009                                   | `tests/integration`                            |
| Timing and sequence              | FDW-ING-011..012              | TC-RULE-011..017                                   | `tests/core`                                   |
| Limits and hashing               | FDW-ING-013..015              | TC-CSV-002, 018..020                               | `tests/core`, `tests/performance`              |
| Profiles and rule identity       | FDW-RUL-001..003              | TC-PRO-001..003, 006, TC-RULE-007                  | `tests/core`                                   |
| Rule families                    | FDW-RUL-004..007              | TC-RULE-005..010, 018..021                         | `tests/core`                                   |
| Finding evidence and determinism | FDW-RUL-010..012              | TC-RULE-007, 022..023                              | `tests/core`                                   |
| Fault injection                  | FDW-FLT-001..005              | TC-FLT-001..012                                    | `tests/core`, `tests/integration`              |
| Verification                     | FDW-VER-001..008              | TC-VER-001..009                                    | `tests/core`, `tests/integration`              |
| Four-view UI                     | FDW-UI-001..006, 008, 010     | TC-UI-001..012                                     | `tests/browser`, `tests/accessibility`         |
| State isolation                  | FDW-UI-007, 009               | TC-UI-013..017                                     | `tests/unit`, `tests/browser`                  |
| Exports                          | FDW-EXP-001..006              | TC-EXP-001..006                                    | `tests/core`, `tests/unit`, `tests/browser`    |
| DOM and CSP                      | FDW-SEC-001, 009              | TC-SEC-001..004                                    | `tests/unit`, `tests/browser`                  |
| Accessibility and responsive     | FDW-SEC-002..007              | TC-A11Y-001..012                                   | `tests/accessibility`, `tests/browser`         |
| Dependency security              | FDW-SEC-008                   | release audit and TC-BUILD-001                     | `.github/workflows`                            |
| Build and offline                | FDW-CM-001..003               | TC-BUILD-001..005                                  | `tests/browser`, `.github/workflows`           |
| Coverage and traceability        | FDW-CM-004..007               | TC-CM-001..003                                     | all test roots and workflows                   |
| Release evidence                 | FDW-CM-008..010               | build and traceability controls                    | `scripts/release`, `.github/workflows`, `docs` |
| Streaming                        | FDW-STR-001..008              | TC-STR-001..011                                    | `tests/streaming`                              |
| Learned baseline                 | FDW-ML-001..007               | TC-ML-001..008                                     | `tests/ml`                                     |
| History analytics                | FDW-DB-001..005               | TC-DB-001..006                                     | `tests/analytics`                              |
| Advanced assurance               | FDW-ADV-001..004              | TC-ADV-001..003, TC-PERF-001..003, TC-DEV-001..002 | core, performance, container evidence          |

Run the structural check with:

```powershell
pnpm requirements:check
```

Use the stricter optional source-root check after all planned test roots exist:

```powershell
node scripts/release/verify-traceability.mjs --require-evidence-paths
```
