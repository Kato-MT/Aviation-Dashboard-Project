# GitHub milestone and issue plan

The v2.0 and v2.1 work was published through the closed [Flight Diagnostics Workbench v2.1 milestone](https://github.com/Kato-MT/Aviation-Dashboard-Project/milestone/1). The v2.2 candidate is tracked by the public [Flight Diagnostics Workbench v2.2 milestone](https://github.com/Kato-MT/Aviation-Dashboard-Project/milestone/2), umbrella issue [#16](https://github.com/Kato-MT/Aviation-Dashboard-Project/issues/16), and focused issues [#17](https://github.com/Kato-MT/Aviation-Dashboard-Project/issues/17) through [#22](https://github.com/Kato-MT/Aviation-Dashboard-Project/issues/22). This file preserves their acceptance boundaries and prevents ad hoc scope drift; create additional v2.2 issues only when the draft PR or CI evidence needs independently assignable follow-up work.

## Milestone: Flight Diagnostics Workbench v2.0.0

- Target: 2026-07-31
- Description: Deterministic telemetry integration, diagnostics, verification, evidence exports, accessibility, security automation, documentation, offline release, and Pages deployment using synthetic unclassified data.

## Focused v2.0 issues

### 1. `foundation: migrate to strict TypeScript and Vite`

- Labels: `type:foundation`, `release:v2.0`
- Acceptance: strict build, local dependencies and fonts, no runtime CDN, normal and offline builds, original visual identity retained.

### 2. `adapters: canonical telemetry model and versioned imports`

- Labels: `type:feature`, `area:adapters`, `release:v2.0`
- Acceptance: legacy CSV and versioned JSON, explicit units, fatal and recoverable validation, quarantine, limits, equivalence tests.

### 3. `diagnostics: profile-driven deterministic rules`

- Labels: `type:feature`, `area:diagnostics`, `release:v2.0`
- Acceptance: stable rule IDs, required rule families, evidence fields, three synthetic profiles, preserved 5/3/1 baseline.

### 4. `faults: seeded synthetic fault injection`

- Labels: `type:feature`, `area:diagnostics`, `release:v2.0`
- Acceptance: at least eight declared scenarios, deterministic manifests, all expected findings and zero unexpected findings.

### 5. `verification: baseline and candidate comparison`

- Labels: `type:feature`, `area:verification`, `release:v2.0`
- Acceptance: resolved, persisting, and new classifications; provenance; pass/fail requirements; JSON and CSV exports without source data by default.

### 6. `ui: four-view accessible workbench`

- Labels: `type:feature`, `area:ui`, `release:v2.0`
- Acceptance: Monitor, Diagnostics, Verification, Configuration; named states; keyboard replay and alerts; focus, reduced motion, responsive checks.

### 7. `tests: regression, limits, browser, accessibility, and traceability`

- Labels: `type:test`, `release:v2.0`
- Acceptance: 50 or more meaningful v2.0 cases, 90 percent core branch gate, exact golden regression, equivalent adapters, hostile inputs, offline and responsive checks.

### 8. `security: input, export, dependency, and pipeline hardening`

- Labels: `type:security`, `release:v2.0`
- Acceptance: XSS path closed, CSV formula neutralization, CodeQL, dependency review, Dependabot, audit gate, threat model, pinned actions.

### 9. `docs: architecture, test evidence, limitations, and demo`

- Labels: `type:documentation`, `release:v2.0`
- Acceptance: README, architecture, ADRs, test plan, defect reports, threat model, benchmark record, limitations, release record, changelog, security policy, demo script.

### 10. `release: v2.0.0 artifacts, Pages, and verification`

- Labels: `type:release`, `release:v2.0`
- Acceptance: protected branch, exact-commit gates, offline app, reports, SBOM, checksums, provenance, release notes, screenshots, desktop/mobile Pages verification.

## Milestone: Flight Diagnostics Workbench v2.1.0

Create only after v2.0.0 remains stable.

Issues:

- `streaming: versioned local simulator and browser adapter`
- `communications: health, bounded queue, and injected failures`
- `model: generated-data training, held-out evaluation, and TypeScript inference`
- `analytics: SQLite migrations, integrity, queries, and trend reports`
- `assurance: fuzzing, properties, mutation testing, and reproducible benchmarks`
- `tooling: optional development container after native stability`
- `release: v2.1.0 evidence and artifacts`

Each v2.1 issue inherits the same synthetic-data, deterministic-authority, traceability, and evidence requirements.

## Milestone: Flight Diagnostics Workbench v2.2.0

The public milestone, umbrella, and focused issues are tracking records, not completion evidence. The branch, pull request, CI, release, and Pages deployment remain candidate work until each result is verified for one exact commit.

### 1. [#17 `registry: profile-specific model compatibility and detector agreement`](https://github.com/Kato-MT/Aviation-Dashboard-Project/issues/17)

- Labels: `type:foundation`, `area:model-registry`, `release:v2.2`
- Acceptance: immutable registry entries, exact artifact and configuration identities, explicit mismatch reasons, disabled learned defaults, authoritative deterministic decision, and four-way unavailable-state handling.

### 2. [#18 `temporal: seeded phases, fusion, and declared fault scenarios`](https://github.com/Kato-MT/Aviation-Dashboard-Project/issues/18)

- Labels: `type:feature`, `area:temporal`, `release:v2.2`
- Acceptance: deterministic synthetic mission generation, ten declared scenarios plus nominal, phase hysteresis, redundant-sensor Kalman estimation, uncertainty, innovations, lifecycle labels, and no detector use of ground-truth labels.

### 3. [#19 `model: temporal advisory inference and evaluation evidence`](https://github.com/Kato-MT/Aviation-Dashboard-Project/issues/19)

- Labels: `type:feature`, `area:model`, `release:v2.2`
- Acceptance: separate v1 research and v2 production-integrated advisory roles; versioned 40-sample artifacts; disjoint seeds; explicit abstention without a calibrated-probability claim; Python-to-TypeScript parity; gate recomputation against the unchanged requirements; selected-window counts, uncertainty bounds, and per-fault limitations for v2; a v1 same-population projection against persistence, linear, unchanged covariance, and compatible deterministic paths; and a separately labeled v1 post-hoc non-gating challenge over unseen magnitude, onset, duration, and novel combinations. V2 selected-window evidence must not be described as episode, full-stream, prevalence-weighted, independent-flight, or real-world performance. The deterministic projection must remain labeled partial.

### 4. [#20 `campaign: worker evaluation, replay, and SQLite history`](https://github.com/Kato-MT/Aviation-Dashboard-Project/issues/20)

- Labels: `type:feature`, `area:campaign`, `release:v2.2`
- Acceptance: versioned contracts, deterministic matrix and replay identity, progress, contained errors, cancellation, expected and unexpected detections, confusion, calibration, timing, bootstrap intervals, minimized JSON, foreign keys, idempotent ingestion, integrity checks, and documented resource limits.

### 5. [#21 `investigation: linked evidence, comparison waveforms, and accessible exports`](https://github.com/Kato-MT/Aviation-Dashboard-Project/issues/21)

- Labels: `type:feature`, `area:ui`, `release:v2.2`
- Acceptance: linked state and residual charts, phase and lifecycle markers, keyboard replay, selected-sample four-way evidence, exact profile/cadence/count/index comparison compatibility, no silent interpolation, responsive and non-color states, generated source windows excluded by default, and explicit source inclusion recorded in export policy.

### 6. [#22 `assurance: temporal tests, benchmarks, documentation, and release gates`](https://github.com/Kato-MT/Aviation-Dashboard-Project/issues/22)

- Labels: `type:test`, `type:documentation`, `type:release`, `release:v2.2`
- Acceptance: strict traceability, deterministic artifact regeneration, model and comparison hashes, TypeScript and Python suites, browser and accessibility execution, network-disabled offline execution, normal and offline build evidence, reproducible bounded benchmarks, security review, SBOM, checksums, provenance, screenshots, and exact-commit release verification.

All v2.2 issues retain the synthetic and unclassified boundary. Learned paths remain optional and advisory. No issue closure, metric, test pass, deployment, or release status is public evidence until it is verified for the recorded commit.
