# Temporal intelligence threat model

## Scope

This threat model covers the v2.2 temporal scenario generator, mission-phase detector, sensor-fusion estimator, deterministic investigation analyzer, temporal model artifact and browser inference, model registry, four-way detector evidence, captured waveform comparison, minimized exports, campaign engine, investigation chart renderer, and optional SQLite campaign importer.

It does not cover real aircraft, operational networks, proprietary data, maintenance decisions, certification, or safety decisions. All intended inputs and evidence are synthetic and unclassified.

## Security objectives

- Preserve the integrity and reproducibility of synthetic scenarios, rules, model artifacts, campaign results, and hashes.
- Prevent an advisory model from becoming authoritative through code, UI, or wording.
- Represent unsupported input as mismatch, failure, or abstention instead of guessing.
- Prevent ground-truth labels from leaking into detection logic.
- Keep user-selected or callback-provided data out of normal evidence unless explicitly declared.
- Bound CPU, memory, message, result, and disk usage before exposing campaigns to untrusted input.
- Render all labels, evidence, and errors as data rather than executable markup or SQL.

## Assets

- temporal artifact and configuration identity;
- seed partitions and reproducible generated windows;
- phase, fusion, indication, and detection-timing evidence;
- deterministic authority and explicit model activation state;
- campaign replay manifest, metrics, and result JSON;
- SQLite relationships and integrity;
- browser responsiveness and user-controlled cancellation;
- synthetic-only and employer-neutral boundaries.

## Trust boundaries

1. **Artifact boundary:** checked JSON becomes model parameters.
2. **Scenario boundary:** a seed and scenario specification become generated samples and labels.
3. **Callback boundary:** injected campaign builders and evaluators return evidence to the runner.
4. **Worker boundary:** versioned structured messages cross between the browser client and an inline Web Worker.
5. **DOM boundary:** labels, details, and errors become visible text or chart labels.
6. **Serialization boundary:** a campaign result becomes JSON and later SQLite rows.
7. **Filesystem boundary:** the Python CLI reads a result path and writes a user-selected database.
8. **Release boundary:** source, registry hashes, generated artifacts, and offline output are asserted to describe the same commit.

## Threats and controls

| ID      | Threat                                                                            | Current control                                                                                                                                                                                                                    | Residual risk or required work                                                                                                                                                                   |
| ------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TTI-001 | Ground-truth labels influence a detector and inflate results                      | Investigation indications use observations and fused state; a test removes all labels and compares indications                                                                                                                     | Continue code review and campaign tests that separate truth from detector input                                                                                                                  |
| TTI-002 | A modified model artifact is treated as the registered model                      | Registry stores exact artifact and configuration SHA-256 identities; identity tests recompute them; the Configuration view displays compatibility                                                                                  | The investigation analyzer imports the bundled artifact directly, and low-level scoring does not recompute file bytes. Keep UI activation aligned with compatibility and verify release bytes    |
| TTI-003 | Schema, profile, unit, cadence, or window mismatch changes model meaning          | Registry has explicit mismatch reasons and an exact 40-sample contract                                                                                                                                                             | A caller can bypass the registry today. Do not expose direct scoring as an activated workflow                                                                                                    |
| TTI-004 | A model indication or four-way majority is shown as verified truth                | Scores and four-way evidence carry `authority: deterministic-rules`; the authoritative decision is always the rule state; both learned controls default disabled                                                                   | UI wording and exported evidence still need integrated browser execution                                                                                                                         |
| TTI-005 | Out-of-distribution input is forced into a known class                            | Class radius, artifact-specific abstention rules, quality gate, and user selection can produce `unknown`                                                                                                                           | Synthetic support thresholds do not prove unknown detection on other distributions; normalized distance similarity is not a calibrated probability                                               |
| TTI-006 | Missing values are hidden by imputation                                           | Missing fraction is a feature; deterministic missing indications remain authoritative                                                                                                                                              | Forward fill and all-zero fallback can still create plausible features. Sustained missingness must never rely on the model alone                                                                 |
| TTI-007 | Research, integrated selected-window, and full-stream evidence are conflated      | Registry and documentation identify v1 as research-evidence-only and v2 as production-integrated advisory; the worker explicitly maps `lag` to `sensor-lag`                                                                        | V2 evaluates selected windows rather than complete streams. V1 comparisons and v2 selected-window values must not be presented as full Investigation performance                                 |
| TTI-008 | A large campaign exhausts browser CPU or memory                                   | The validator caps specifications at 4 profiles, 64 scenarios, 12 seeds, 372 total cases, and 256 KiB; the temporal worker uses 180 samples per case, yields between cases, and returns validated partial evidence on cancellation | One in-flight synchronous case remains non-preemptible until it reaches the next yield boundary                                                                                                  |
| TTI-009 | A forged worker message starts work or associates a result with the wrong request | `campaign-worker.v1` uses versions, request IDs, one active browser request, duplicate rejection, response validation, stale-ID rejection, deep spec validation, and a 10 MiB result-validation boundary                           | Browser and network-disabled offline execution remain release gates                                                                                                                              |
| TTI-010 | Huge result JSON or evidence details exhaust memory or disk                       | Campaign parsing caps results at 10 MiB, 372 cases, 128 detections and 2,048 calibration observations per case; SQLite caps retained result payloads at 64 MiB and the database at 128 MiB without silent pruning                  | Parsing is not streaming, detection details remain flexible inside the total budget, and local-history retention remains a user-managed operation                                                |
| TTI-011 | SQL injection through campaign fields                                             | All ingestion and report values use parameterized SQL; no report field becomes SQL text                                                                                                                                            | The user controls the database path, and a valid result can still consume disk                                                                                                                   |
| TTI-012 | Private or operational samples leak through evidence                              | Campaign results omit source telemetry rows; Investigation JSON excludes generated samples, points, and series unless the user explicitly selects source inclusion; policy is recorded in the export                               | Detection `details` remains an arbitrary record, SQLite stores the complete campaign result JSON, and browser execution of both Investigation export choices remains pending                     |
| TTI-013 | Labels or errors execute markup or spreadsheet formulas                           | Investigation labels and details are assigned through text nodes; temporal exports use JSON; existing finding CSV export has formula-neutralization tests                                                                          | Integrated hostile-string browser execution remains a release gate                                                                                                                               |
| TTI-014 | Nonfinite or malformed numeric state corrupts analysis                            | Generator rejects nonfinite output; phase, fusion, model parser, and campaign validators reject invalid values                                                                                                                     | Large finite magnitudes can still stress calculations or create meaningless evidence. Add domain bounds at integration boundaries                                                                |
| TTI-015 | Timestamp manipulation creates misleading fusion state                            | Fusion requires strictly increasing timestamps                                                                                                                                                                                     | Deltas above 60 seconds are capped for prediction. Upstream gap and stale-feed diagnostics must remain visible                                                                                   |
| TTI-016 | Artifact `passed` or `enabledByDefault` is trusted without recomputation          | TypeScript recomputes artifact-declared quality conditions; registry separately requires quality eligibility and user enablement                                                                                                   | Artifact-declared thresholds must remain consistent with requirements, and full regeneration plus registry routing must be verified on the release commit                                        |
| TTI-017 | Training, calibration, and evaluation overlap                                     | Fixed seed ranges are disjoint and a Python test asserts separation                                                                                                                                                                | All are generated by one family of code and are not independent real-world distributions                                                                                                         |
| TTI-018 | A compromised dependency or build changes inference or charts                     | Frozen dependencies and repository release controls exist outside this module                                                                                                                                                      | Local compilation is not an exact-commit CI, SBOM, runtime-verified offline artifact, or provenance result                                                                                       |
| TTI-019 | Downsampling removes decisive evidence                                            | Chart sampling always includes phase boundaries and fault markers, even when that exceeds the requested point target                                                                                                               | Dense critical evidence can exceed the display budget and still affect responsiveness                                                                                                            |
| TTI-020 | A hostile callback ignores cancellation                                           | The runner passes `AbortSignal`, the browser client sends cancellation, and the worker tracks one `AbortController` per request                                                                                                    | JavaScript cannot preempt a synchronous callback. The current client sends a cancel message rather than terminating the worker, so a CPU-bound worker that does not yield may delay cancellation |
| TTI-021 | Incompatible baseline and candidate waveforms are silently aligned                | Comparison requires exact profile, cadence, sample count, and sample-index equality; a mismatch disables the overlay and reports explicit reasons                                                                                  | Browser execution must confirm the warning remains visible and cannot be bypassed through stale UI state                                                                                         |

## Privacy analysis

The intended temporal generators do not need personal, proprietary, or operational data. Generated artifacts contain synthetic model parameters, seeds, metrics, and parity windows. Normal campaign contracts do not include the builder input. Investigation exports also omit generated samples, point traces, and series by default, while an explicit source-inclusion checkbox adds them and records that choice. Detections can still carry arbitrary `details`, and SQLite stores the full serialized campaign result.

Required policy before accepting external or untrusted campaign input:

- accept only declared synthetic profiles and scenarios;
- prohibit raw sample arrays in detection details;
- display an evidence-size estimate before export or import;
- omit source telemetry unless a separate, explicit, warned export exists, as the current Investigation source-inclusion control does;
- document retention and provide a recoverable deletion workflow for local history;
- never imply that `SYNTHETIC_UNCLASSIFIED` is a classification review for user-provided data.

## Denial-of-service analysis

The generic campaign count is `profiles x scenarios x seeds`. Contract validation now caps it at 372 total cases, with separate limits for profiles, scenarios, seeds, specification bytes, result bytes, per-case detections, and calibration observations. The wired UI remains narrower in practice: one profile, one nominal case plus 30 parameterized fault cases, and 1 through 12 seeds. The temporal worker uses 180 samples per case, and the wired Investigation control accepts 60 through 2,000 samples. SQLite ingestion applies the same case and result-byte boundary, plus retained-payload and database quotas. Limits reject work explicitly and never silently discard older evidence.

Remaining denial-of-service work is to consider streaming import if campaign contracts grow, provide a documented recoverable history-archival workflow, keep display downsampling budgets under review, and verify worker progress, cancellation, stale-response handling, and terminal cleanup in the exact release browser.

- time and memory measurements on the release environment.

The checked Node benchmark is a local proxy, not browser timing or a safe operating limit. No browser performance or maximum safe scale is claimed.

## Accepted limitations

- All model evidence is synthetic and distribution-specific.
- V1 research evidence records sensor lag as its weakest held-out class. Its post-hoc challenge records materially lower recall for changed onset and duration and is not a release-performance gate.
- V2 uses the actual Investigation projection but evaluates balanced selected windows, not complete mission streams. Its weakest selected-window class is cross-sensor decoupling at 33 of 40 correct classifications; stuck value and simultaneous faults each record 39 of 40.
- Two false positives among 40 selected nominal v2 windows produces a 5 percent point estimate and an exact one-sided 95 percent upper bound of approximately 14.92 percent, so it does not establish a population false-positive rate at or below 5 percent.
- Model registry compatibility is displayed by the application, while low-level scoring remains independently callable.
- Campaign worker, browser-client, UI-controller, and self-contained offline behavior require exact-commit browser evidence. Source presence or compilation alone is not proof; the generated release verification report records the applicable result.
- The model ranks hypotheses and does not establish cause.
- No current result supports real-aircraft, certification, affiliation, operational, or safety claims.
