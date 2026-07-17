# Threat model

## Scope and assumptions

This model covers the static browser application, local synthetic WebSocket simulator, evidence exports, build pipeline, release artifacts, and optional local analytics import. It does not cover real systems, operational networks, or safety decisions.

All bundled data is synthetic and unclassified. Users are instructed not to load proprietary, personal, controlled, or operational data.

## Assets

- integrity of normalized samples and diagnostic findings;
- accuracy of dataset hashes, counts, profile versions, and report provenance;
- confidentiality of user-selected source data in the local browser;
- availability of the browser during bounded imports and streams;
- integrity of source code, dependencies, CI, Pages, and release artifacts;
- clear separation between deterministic results and experimental model output.

## Trust boundaries

1. **File boundary:** uploaded bytes enter the browser parser.
2. **Message boundary:** WebSocket messages enter the versioned protocol adapter.
3. **DOM boundary:** untrusted values become visible text.
4. **Export boundary:** browser state becomes a downloaded file.
5. **Tool boundary:** a user deliberately imports reports into local Python analytics.
6. **Supply-chain boundary:** package registry and GitHub Actions inputs become build code.
7. **Release boundary:** CI outputs become Pages or downloadable release artifacts.

## Threats and mitigations

| ID      | Threat                                                      | Boundary     | Mitigation and required evidence                                                                           | Residual risk                                                       |
| ------- | ----------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| THR-001 | Markup or script injection through uploaded text            | File to DOM  | Render external values as text, enforce a restrictive CSP, test hostile strings                            | Browser or dependency defects can still exist                       |
| THR-002 | Formula injection in exported CSV                           | Export       | Prefix or escape cells beginning with spreadsheet formula indicators; test `=`, `+`, `-`, and `@` prefixes | A consuming tool may interpret nonstandard syntax differently       |
| THR-003 | Memory or CPU exhaustion from large input                   | File         | Enforce 10 MiB and 250,000-sample limits before analysis; bound parsing and display                        | Inputs below limits can still be expensive on low-end devices       |
| THR-004 | Silent message loss under queue pressure                    | Message      | Bounded queue, visible dropped count, requirement failure on loss                                          | A disconnected source cannot be reconstructed without replay        |
| THR-005 | Spoofed or mixed streaming source                           | Message      | Versioned hello, explicit source IDs, per-source sequence state, duplicate-source rejection                | No cryptographic source authentication in the local demo protocol   |
| THR-006 | Reordered, duplicated, or replayed messages hide faults     | Message      | Sequence and timestamp diagnostics, evidence for duplicates and disorder                                   | Intentional adversarial traffic is outside the demo assurance level |
| THR-007 | Stale prior state is mistaken for a failed new load         | UI state     | Request-scoped state machine and named failure state; inactive prior run indicator                         | User screenshots can omit context                                   |
| THR-008 | Malformed numeric values become trusted values              | File         | Reject blanks, nonnumeric, `NaN`, and infinity before normalization                                        | Locale-specific numeric formats are rejected rather than inferred   |
| THR-009 | Profile or schema confusion changes rule meaning            | File/config  | Exact supported versions, explicit mapping, mismatch block, provenance in every report                     | A malicious but syntactically valid custom profile is not supported |
| THR-010 | Source data leaks through normal reports                    | Export       | Omit samples by default; separate explicit source-data export choice                                       | The user can deliberately export and share data                     |
| THR-011 | Dependency or action compromise changes builds              | Supply chain | Frozen lockfile, SHA-pinned actions, dependency review, CodeQL, SBOM, provenance                           | Registries and runners remain external trust dependencies           |
| THR-012 | Release artifact differs from deployed artifact             | Release      | Build from exact commit, checksums, artifact attestation, Pages deployment after CI                        | GitHub account compromise is outside repository controls            |
| THR-013 | Model output is presented as authoritative                  | Analysis/UI  | Deterministic authority, disabled-by-default gate, visible model version and limitations                   | Users may still overinterpret scores                                |
| THR-014 | Local SQLite import executes unexpected data as code        | Tool         | Parameterized SQL, schema validation, no dynamic SQL from report fields                                    | Local filesystem compromise is outside scope                        |
| THR-015 | Spreadsheet viewers execute exported hyperlinks or formulas | Export       | Neutralize formula prefixes and avoid automatic hyperlinks                                                 | Viewer-specific behavior varies                                     |
| THR-016 | Denial through endless reconnect                            | Message      | Bounded attempts and backoff, manual retry after terminal state                                            | Prolonged outage remains unavailable                                |

## Abuse cases

### Hostile upload

An attacker gives a user a CSV whose timestamp contains HTML and whose numeric cells contain whitespace, `Infinity`, and formula-like text. The adapter must quarantine invalid rows, render the timestamp literally, and neutralize exported CSV cells.

### Queue pressure

A synthetic source sends faster than the renderer can consume. The queue must remain bounded, record drops, and show health degradation. It must not silently discard data while reporting nominal status.

### Evidence substitution

A release asset is copied or renamed. Users can compare its SHA-256 value with `checksums.sha256` and inspect the GitHub artifact attestation for the release workflow subject.

## Security verification

- dependency audit fails for high or critical known vulnerabilities at release;
- dependency review blocks newly introduced high or critical vulnerabilities;
- CodeQL scans JavaScript, TypeScript, Python, and workflow-relevant source changes;
- browser tests exercise hostile strings and CSP behavior;
- export tests cover CSV formula neutralization and source-data exclusion;
- release verification records actual audit, CodeQL, SBOM, checksum, and provenance evidence.

## Accepted limitations

The local WebSocket protocol does not provide encryption or authentication because it binds to a local development interface and carries synthetic data. If remote connectivity is ever added, transport security and source authentication require a new threat-model review before implementation.
