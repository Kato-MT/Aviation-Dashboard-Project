# Legacy defect reports

These reports capture defects observed in the original v1 implementation and define the evidence required to close them in v2. A report remains open until its linked automated test passes on the release commit.

## DEF-001: Blank numeric values become zero

- Severity: High
- Affected area: CSV normalization
- Legacy evidence: the numeric helper applies `Number(value)` before rejecting blanks. JavaScript converts an empty string and whitespace-only text to zero.
- Risk: missing telemetry can appear as a valid zero and create misleading charts or derived findings.
- Required behavior: blank and whitespace-only required numeric values produce a recoverable validation issue and quarantine the row. Literal numeric zero remains valid.
- Closure evidence: `TC-CSV-007`, `TC-CSV-008`, and `TC-CSV-009` pass.

## DEF-002: Rate checks assume sample cadence

- Severity: High
- Affected area: rapid-change detection
- Legacy evidence: rapid descent compares a fixed number of adjacent samples instead of elapsed time.
- Risk: an identical physical rate produces different results when cadence changes, gaps occur, or timestamps are irregular.
- Required behavior: rate-of-change rules divide the measurement delta by the actual normalized timestamp delta. Duplicate and non-increasing timestamps are handled as timing findings and do not cause division by zero.
- Closure evidence: `TC-RULE-008` through `TC-RULE-012` pass.

## DEF-003: Failed loads leave stale analysis visible

- Severity: High
- Affected area: application state
- Legacy evidence: a parse or file error reports a message without consistently replacing the prior dataset, charts, counters, and alerts.
- Risk: a user may believe old evidence belongs to the newly selected file.
- Required behavior: every load attempt creates a new request state. Fatal failure moves the UI to a named failure state, identifies the attempted file, and marks previous results as inactive. Recoverable rows remain associated only with the new run.
- Closure evidence: `TC-UI-014` through `TC-UI-017` pass.

## DEF-004: Uploaded text reaches an HTML interpretation path

- Severity: Critical
- Affected area: alert rendering
- Legacy evidence: an uploaded timestamp is interpolated into `innerHTML`.
- Risk: hostile strings can be interpreted as markup or script-capable DOM.
- Required behavior: external strings are assigned through text nodes or equivalent escaping. Content Security Policy limits script sources to the built application. Hostile fixtures render literally and do not create executable elements or event handlers.
- Closure evidence: `TC-SEC-001` through `TC-SEC-004` pass.

## DEF-005: Replay and alert interactions are mouse-dependent

- Severity: Medium
- Affected area: accessibility and replay
- Legacy evidence: some alert rows and icon controls rely on click behavior or visual context without a complete accessible name and keyboard-equivalent operation.
- Risk: keyboard and assistive-technology users cannot reach or understand all diagnostics.
- Required behavior: interactive alert rows are native controls or implement correct button semantics, Enter and Space activation, visible focus, stable labels, and programmatic state. Replay controls expose names, current value, range, and speed.
- Closure evidence: `TC-A11Y-001` through `TC-A11Y-012` pass with zero serious or critical automated findings.

## DEF-006: Parser errors and invalid rows are silently dropped

- Severity: High
- Affected area: import verification
- Legacy evidence: parser errors are not promoted into the run report and invalid rows are filtered out without quarantine evidence.
- Risk: accepted counts and findings cannot be reconciled with the input.
- Required behavior: parser, schema, and row validation issues are counted and visible. Every input data row is either accepted or quarantined, and totals reconcile.
- Closure evidence: `TC-CSV-003` through `TC-CSV-015` and `TC-VER-003` pass.

## DEF-007: Runtime dependencies are unpinned CDNs

- Severity: Medium
- Affected area: build reproducibility and offline use
- Legacy evidence: Chart.js and Papa Parse load at runtime from external CDNs without an immutable application lockfile.
- Risk: the same repository commit can execute different dependency code or fail without a connection.
- Required behavior: dependencies and fonts are local build inputs pinned in `pnpm-lock.yaml`; Pages and offline artifacts make no runtime CDN request.
- Closure evidence: `TC-BUILD-001` through `TC-BUILD-005` pass.

## Status handling

The release verifier updates each report to **closed** only after its tests pass on the exact release commit. A manual observation can supplement but cannot replace the automated evidence.
