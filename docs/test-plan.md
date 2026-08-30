# Test plan

## Objective

Verify that the same synthetic input, configuration, and seed produce the same canonical samples, findings, comparison result, and evidence. Validate normal, empty, warning, failure, offline, accessibility, responsive, security, and performance paths.

No test count, coverage percentage, accessibility result, performance measurement, model metric, or vulnerability result is a release claim until CI evidence for the exact commit verifies it.

## Test levels

| Level         | Scope                                                                                                             | Primary command                                |
| ------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Unit          | parsers, normalization, rules, phase, fusion, models, campaigns, exports                                          | `pnpm test:coverage`                           |
| Integration   | adapter to report, temporal investigation, worker, and history import                                             | `pnpm validate`                                |
| Browser       | legacy five-view behavior plus v3 Live, Replay, six-workflow Lab, Evidence, offline, exports, and stream journeys | `pnpm test:e2e` and `pnpm test:live-browser`   |
| Accessibility | keyboard, focus, names, status semantics, reduced motion, automated scan                                          | `pnpm test:e2e`                                |
| Responsive    | narrow mobile, tablet, desktop, content reflow and no hidden controls                                             | `pnpm test:e2e`                                |
| Security      | hostile strings, formula cells, limits, dependency review, CodeQL                                                 | CI workflows                                   |
| Offline       | one HTML file, no runtime CDN, supported browser smoke test                                                       | `pnpm build:offline` and `pnpm test:e2e`       |
| Performance   | deterministic and temporal fixed-seed scales with environment evidence                                            | `pnpm benchmark` and `pnpm benchmark:temporal` |
| Analytics     | run and campaign migrations, integrity, queries, repeatable trends                                                | `pnpm analytics` and `pnpm analytics:campaign` |
| Model         | disjoint seeds, faults, gates, abstention, identity, and parity                                                   | `pnpm ml:train`                                |

## v2.0 behavior inventory

The authoritative case definitions are in [requirements/test-cases.md](../requirements/test-cases.md). The v2.0 inventory contains more than 50 distinct behavior cases across:

- legacy CSV and versioned JSON adapters;
- blank, missing, nonnumeric, nonfinite, and hostile values;
- fatal versus recoverable validation;
- explicit unit mappings and profile compatibility;
- range, rate, timing, sequence, frozen, stale, and compatibility rules;
- eight seeded fault scenarios and determinism;
- baseline/candidate resolution, persistence, and regression classification;
- JSON and CSV evidence exports;
- file and sample limits;
- loading, empty, nominal, warning, and failure UI states;
- keyboard, focus, reduced motion, non-color status, and responsive layouts;
- normal and self-contained offline builds.

Each automated test should include its `TC-*` identifier in the test name so CI output can be traced back without interpreting line numbers.

## v2.2 behavior inventory

The v2.2 catalog adds stable cases for:

- model-registry identity, compatibility reasons, eligibility, user enablement, and deterministic authority;
- six mission phases, hysteresis, transition evidence, redundant measurements, Kalman prediction and update, uncertainty bands, missing sensors, and residual ordering;
- ten seeded temporal scenarios, nominal behavior, onset, active duration, recovery, and no ground-truth leakage;
- disjoint training, calibration, and held-out seeds; unseen magnitude evidence; quality gates; unknown abstention; and Python-to-TypeScript parity;
- Investigation linked charts, replay, phase and fault markers, hypotheses, deterministic indications, compatible comparison overlays, empty and failure states, and minimized export;
- campaign matrix validation, deterministic replay, progress, one-active-request bound, cancellation, malformed messages, contained failures, expected/missing/unexpected detections, grouped confusion, detection delay, calibration, abstention, and bootstrap intervals;
- SQLite campaign migration, foreign-key enforcement, indexes, idempotent ingest, integrity, and report generation;
- desktop, mobile, 200 percent zoom, keyboard, reduced motion, automated accessibility, normal build, self-contained offline build, and offline worker behavior.

## Mandatory regression tests

### Included fixture

For `data/flight.csv`, verify:

- SHA-256 `b3b50781afde9b3895707109e40e86b2fae82ed8e38cc4e964d9cb2de327b700`;
- 85 accepted records;
- zero unaccounted rows;
- exactly 5 overspeed, 3 rapid-descent, and 1 fuel-change compatibility finding;
- stable finding order and stable rule IDs.

### Adapter equivalence

Normalize equivalent CSV and versioned JSON fixtures, remove format-specific provenance, and assert deep equality of samples, units, quality flags, and deterministic findings.

### Fault scenarios

For every declared seeded scenario, compare actual stable rule IDs and locations to the expected manifest. Require all expected findings and zero unexpected findings. Run each scenario twice and compare outputs for determinism.

### Comparison

Use controlled baseline and candidate fixtures to exercise resolved, persisting, and newly introduced findings separately and together. Include validation regressions and fatal candidate input.

## Coverage

Extracted core modules require at least 90 percent branch coverage. The test runner configuration enforces the threshold and causes CI to fail below it. Generated files, view-only rendering glue, and third-party code may be excluded only with an explicit configuration comment.

Coverage is evidence of exercised control flow, not proof of correctness. The release record includes the measured result rather than a manually entered claim.

## Accessibility

Automated scans must report zero serious or critical findings across the five legacy views and the named v3 workspace and six-workflow React Lab states. Manual checks cover:

- complete keyboard traversal and activation;
- logical focus order and visible focus;
- replay slider name, value, range, and keyboard control;
- alert and finding activation with Enter and Space;
- focus placement after view changes, load errors, and export confirmation;
- 200 percent browser zoom and narrow viewport reflow;
- non-color-only status and meaningful icons;
- reduced-motion behavior;
- screen-reader announcements for load, stream, verification, and error status.
- Investigation chart seeking, overlay toggles, model enablement, campaign progress, cancellation, and unsupported compatibility reasons.

## Browser matrix

Release automation requires Chromium desktop and a mobile viewport. Before publishing, manually smoke-test current stable Chrome or Edge on Windows and one mobile browser or device emulation. Record exact versions in the release verification document.

## Performance method

Use fixed generated datasets and seeds at 1,000, 10,000, and 100,000 samples. Record environment, Node and browser versions, warm-up, iteration count, median, p95, memory where available, input hash, and commit. Do not compare results from unlike environments as a trend.

## Exit criteria for v2.0.0

- all v2.0 requirements have mapped tests;
- CI, CodeQL, and dependency review succeed on the exact release commit;
- at least 50 meaningful v2.0 behavior cases pass;
- core branch coverage gate passes;
- golden, equivalence, fault, comparison, security, and limit regressions pass;
- normal and offline builds pass;
- automated accessibility reports zero serious or critical findings;
- high and critical known dependency vulnerabilities are absent from the release audit;
- desktop and mobile visual checks are recorded;
- evidence artifacts are generated and their checksums verified.

## Exit criteria for v2.1.0

All v2.0 criteria remain satisfied, plus:

- streaming protocol, queue, reconnect, heartbeat, and communication fault tests pass;
- SQLite migrations, foreign keys, integrity check, indexes, and documented queries pass;
- parser fuzz and property tests complete without an untriaged failure;
- mutation score and surviving mutants are recorded without inflating a quality claim;
- performance results are published for all required sizes;
- model artifact evaluation is reproducible and TypeScript inference matches Python within the declared tolerance;
- the model remains disabled unless F1 is at least 0.85 and false-positive rate is at most 5 percent on held-out synthetic seeds;
- the optional development container is added only after native and CI gates are stable.

## Exit criteria for v2.2.0

All v2.0 and v2.1 criteria remain satisfied, plus:

- the preserved included test dataset still yields its exact hash, 85 accepted records, and 5/3/1 finding distribution;
- every v2.2 requirement maps to a real test case and no release-required case remains pending;
- registry identities are recomputed from the checked-in artifact and canonical configuration, and incompatible profiles produce explicit inactive reasons;
- phase, fusion, temporal generator, investigation, campaign, worker, browser client, and SQLite campaign tests pass with the expanded core branch-coverage gate;
- the v1 research artifact and v2 production-integrated advisory artifact regenerate from pinned configuration, all seed partitions remain disjoint, Python and TypeScript parity remains within the declared tolerance, and eligibility is recomputed against the unchanged requirements rather than trusted from a stored flag;
- v2 evidence reports selected-window confusion counts, exact one-sided false-positive uncertainty, and per-fault counts without describing those observations as complete episodes, full streams, prevalence-weighted samples, independent flights, calibrated probabilities, or real-world performance;
- every v2 integrated gate metric, including minimum per-fault classification recall, satisfies `FDW-TML-004` before release eligibility is claimed;
- deterministic, one-sample persistence, two-sample linear prediction, unchanged covariance, and temporal comparison evidence remains explicitly scoped to the v1 research population without changing deterministic authority;
- the v1 disjoint post-hoc challenge records unseen magnitude, onset, active-duration, phase-label, and novel-combination limitations with frozen inference and no release-performance gate;
- normal and self-contained offline builds contain the same Investigation, inline worker, and model artifacts;
- desktop and mobile browser checks cover linked replay, comparison overlays, campaign progress and cancellation, export minimization, unsupported and failure states, and network-disabled offline operation;
- automated accessibility scans report zero serious or critical findings in empty, populated, and campaign states;
- temporal benchmark evidence records the exact environment and hashes and remains labeled as local Node proxy evidence, not a browser performance target;
- release notes, limitations, threat model, model evidence, SBOM, checksums, provenance, screenshots, and exact-commit verification are complete before the tag or Pages deployment.
