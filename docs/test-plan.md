# Test plan

## Objective

Verify that the same synthetic input, configuration, and seed produce the same canonical samples, findings, comparison result, and evidence. Validate normal, empty, warning, failure, offline, accessibility, responsive, security, and performance paths.

No test count, coverage percentage, accessibility result, performance measurement, model metric, or vulnerability result is a release claim until CI evidence for the exact commit verifies it.

## Test levels

| Level         | Scope                                                                    | Primary command                          |
| ------------- | ------------------------------------------------------------------------ | ---------------------------------------- |
| Unit          | parsers, normalization, rules, hashing, comparison, exports, queues      | `pnpm test:coverage`                     |
| Integration   | adapter to run to finding to report, equivalent formats, history import  | `pnpm validate`                          |
| Browser       | four views, upload states, replay, filters, exports, streaming health    | `pnpm test:e2e`                          |
| Accessibility | keyboard, focus, names, status semantics, reduced motion, automated scan | `pnpm test:e2e`                          |
| Responsive    | narrow mobile, tablet, desktop, content reflow and no hidden controls    | `pnpm test:e2e`                          |
| Security      | hostile strings, formula cells, limits, dependency review, CodeQL        | CI workflows                             |
| Offline       | one HTML file, no runtime CDN, supported browser smoke test              | `pnpm build:offline` and `pnpm test:e2e` |
| Performance   | 1,000, 10,000, and 100,000 samples with fixed seeds and environment      | `pnpm benchmark`                         |
| Analytics     | migrations, foreign keys, integrity, queries, repeatable trends          | `pnpm analytics`                         |
| Model         | held-out seeds, labeled faults, metrics, artifact parity                 | model evaluation command                 |

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

Automated scans must report zero serious or critical findings on all four views and named application states. Manual checks cover:

- complete keyboard traversal and activation;
- logical focus order and visible focus;
- replay slider name, value, range, and keyboard control;
- alert and finding activation with Enter and Space;
- focus placement after view changes, load errors, and export confirmation;
- 200 percent browser zoom and narrow viewport reflow;
- non-color-only status and meaningful icons;
- reduced-motion behavior;
- screen-reader announcements for load, stream, verification, and error status.

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
