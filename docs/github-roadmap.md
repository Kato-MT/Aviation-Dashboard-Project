# GitHub milestone and issue plan

Create the milestone and issues only after repository publishing access is confirmed. This file is the source text for API or manual creation and prevents ad hoc scope drift.

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
