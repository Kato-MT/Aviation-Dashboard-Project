# Release verification record

Copy this template to a versioned release evidence directory or GitHub release asset. Fill values only from commands and CI results for the exact release commit.

The completed v2.1.0 record is preserved in
[`release-verification-v2.1.0.md`](release-verification-v2.1.0.md). This file remains the reusable template for future releases.

## Identity

| Field             | Verified value |
| ----------------- | -------------- |
| Release           | Pending        |
| Git commit        | Pending        |
| Tag commit        | Pending        |
| CI run            | Pending        |
| Pages deployment  | Pending        |
| Verification date | Pending        |
| Verifier          | Pending        |

## Repository gates

| Gate                                                       | Evidence link or artifact | Result  |
| ---------------------------------------------------------- | ------------------------- | ------- |
| Protected `main` checks                                    | Pending                   | Pending |
| CI validation                                              | Pending                   | Pending |
| Core branch coverage                                       | Pending                   | Pending |
| Browser and responsive tests                               | Pending                   | Pending |
| Accessibility, zero serious or critical automated findings | Pending                   | Pending |
| CodeQL                                                     | Pending                   | Pending |
| Dependency review                                          | Pending                   | Pending |
| Audit, no high or critical known vulnerabilities           | Pending                   | Pending |
| Requirements traceability                                  | Pending                   | Pending |

## Deterministic regression

| Check                    | Expected                                                           | Actual  | Result  |
| ------------------------ | ------------------------------------------------------------------ | ------- | ------- |
| Included dataset SHA-256 | `b3b50781afde9b3895707109e40e86b2fae82ed8e38cc4e964d9cb2de327b700` | Pending | Pending |
| Accepted records         | 85                                                                 | Pending | Pending |
| Overspeed findings       | 5                                                                  | Pending | Pending |
| Rapid-descent findings   | 3                                                                  | Pending | Pending |
| Fuel-change findings     | 1                                                                  | Pending | Pending |
| Equivalent CSV and JSON  | Equal canonical samples and findings                               | Pending | Pending |
| Declared fault scenarios | All expected, zero unexpected                                      | Pending | Pending |

## Build artifacts

| Artifact            | SHA-256 | SBOM subject | Provenance subject | Result  |
| ------------------- | ------- | ------------ | ------------------ | ------- |
| Pages build archive | Pending | Pending      | Pending            | Pending |
| Offline HTML        | Pending | Pending      | Pending            | Pending |
| Verification report | Pending | Pending      | Pending            | Pending |
| Traceability report | Pending | Pending      | Pending            | Pending |
| Desktop screenshot  | Pending | N/A          | Pending            | Pending |
| Mobile screenshot   | Pending | N/A          | Pending            | Pending |
| SBOM                | Pending | N/A          | Pending            | Pending |
| Checksums           | Pending | N/A          | Pending            | Pending |

Verify checksums locally:

```powershell
Get-Content .\checksums.sha256
Get-FileHash -Algorithm SHA256 .\flight-diagnostics-workbench.html
```

## Manual visual verification

| Environment | Browser and version | Viewport | Monitor | Diagnostics | Verification | Configuration | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Windows desktop | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| Mobile device or emulation | Pending | Pending | Pending | Pending | Pending | Pending | Pending |

Check loading, empty, nominal, warning, and failure states. Check visible focus, keyboard replay, reduced motion, non-color status, long findings, and overflow.

## v2.1 evidence, when applicable

| Gate                                                  | Evidence | Result  |
| ----------------------------------------------------- | -------- | ------- |
| Streaming protocol and communication faults           | Pending  | Pending |
| Bounded queue and visible drop counts                 | Pending  | Pending |
| SQLite migrations, integrity, and documented queries  | Pending  | Pending |
| Parser fuzzing and property tests                     | Pending  | Pending |
| Mutation testing                                      | Pending  | Pending |
| 1k, 10k, and 100k benchmarks                          | Pending  | Pending |
| Model held-out seeds and artifact hash                | Pending  | Pending |
| Model precision, recall, F1, and false-positive rate  | Pending  | Pending |
| TypeScript and Python inference parity                | Pending  | Pending |
| Model default enabled state justified by gates        | Pending  | Pending |
| Optional development container after native stability | Pending  | Pending |

## Approval

- [ ] Every result above is supported by evidence for the exact commit.
- [ ] No pending field is presented as a passed result.
- [ ] Release notes state known limitations and synthetic-data boundaries.
- [ ] The deployed Pages commit matches the verified release commit.
- [ ] Desktop and mobile screenshots show the verified build.

Release decision: **Pending**
