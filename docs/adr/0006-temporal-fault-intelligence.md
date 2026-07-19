# ADR 0006: Temporal fault intelligence with deterministic authority

- Status: Accepted for the v2.2 candidate
- Date: 2026-07-17

## Context

Pointwise limits can identify a value that is already outside an allowed range, but they do not fully describe faults that develop across time. Drift, oscillation, lag, intermittent loss, recovery, and disagreement between redundant sensors require ordered evidence. Mission phase also changes how the same measurement should be interpreted.

The workbench needs temporal analysis that remains reproducible, inspectable, small enough for browser execution, and honest about uncertainty. It must not turn a synthetic classifier into a flight-safety claim or let an experimental score override deterministic verification.

## Decision

The v2.2 candidate uses six cooperating components:

1. A seeded `temporal-synthetic.v1` generator creates a nominal generic fixed-wing mission or one of ten declared synthetic fault scenarios. Each injected scenario records onset, active duration, recovery, target sensors, quality, and ground-truth labels. Ground truth is evaluation evidence and is not an input to deterministic detection.
2. A forward-only mission-phase state machine classifies ground, takeoff, climb, cruise, descent, landing, and return to ground. Separate entry and maintain thresholds plus a two-sample confirmation period provide explicit hysteresis.
3. A two-state Kalman estimator fuses redundant altitude and vertical-rate measurements. It preserves prediction, observation, posterior estimate, normalized innovation, missing-sensor state, Kalman gain, and 95 percent uncertainty intervals.
4. Deterministic investigation rules turn observed missingness, innovation, redundant-sensor disagreement, rolling noise, stuck values, and fuel quantity-flow relationships into evidence-backed indications. These indications determine the authoritative diagnostic state.
5. Two optional model versions share the `temporal-fault-model.v1` artifact schema. Model v1 is research-evidence-only and uses a separate five-channel generator. Model v2 is the production-integrated advisory artifact and is fitted from the actual TypeScript mission generator, Investigation projection, and 51-feature browser encoder. Both evaluate an exact 40-sample window, can rank three hypotheses or return `unknown`, remain advisory, and require explicit user enablement.
6. A versioned campaign runner evaluates profile, scenario, and seed matrices through injected builder and evaluator callbacks. It records replay identity, expected, missing, and unexpected detections, metrics, cancellation, and failures. A separate Python module persists campaign results in SQLite.

The model registry defines an exact compatibility contract before activation: schema, profile ID and version, channel units, cadence, window length, model artifact SHA-256, configuration SHA-256, quality gate, and user selection. The application Configuration view evaluates and displays that contract for the bundled temporal artifact. Low-level artifact scoring remains a separate function and does not independently accept profile metadata or recompute file bytes.

## Why a compact causal encoder instead of a Transformer

The current evidence contains no Transformer baseline, latency comparison, or accuracy comparison. The decision is therefore based on scope and assurance needs, not a claim that the selected model outperforms a Transformer.

The current task has a fixed 40-sample window, five canonical channels, 51 inspectable features, and a small synthetic training distribution. Dilated differences at offsets 1, 2, and 4 expose short temporal structure without future samples. A nearest-centroid classifier makes distance, class radius, normalized similarity, and abstention directly visible in both Python and TypeScript. The normalized similarity is a ranking score, not a calibrated class probability. The result is deterministic, dependency-light, and practical for browser parity.

A Transformer would add parameters, training choices, runtime weight, and explanation work without current evidence that attention improves this synthetic task. It should be reconsidered only after a disjoint benchmark demonstrates a material benefit under the same false-alarm, abstention, latency, artifact-size, and reproducibility constraints.

## Naming and distribution boundary

The v1 research generator remains distinct from the nine-sensor mission generator. Its same-population comparisons and post-hoc challenge are research evidence only. The v2 integrated corpus instead uses the actual mission generator and Investigation projection, with an explicit mapping from mission scenario `lag` to model class `sensor-lag`.

V2 evaluation still selects one 40-sample window from each 180-sample seed-label mission. It does not scan every rolling window or measure complete mission episodes. No selected-window metric is an end-to-end claim for the fusion estimator, investigation rules, chart renderer, complete mission stream, or real telemetry.

## Consequences

- Deterministic findings remain authoritative even when the model indicates a different hypothesis.
- The model has a 39-sample warmup before its first 40-sample score.
- Unsupported, out-of-radius, or disabled inference is represented as `unknown` and abstained. Model v1 also applies its declared confidence and anomaly-margin thresholds.
- V1's weakest recorded class is sensor lag. V2's weakest selected-window class is cross-sensor decoupling at 33 of 40 correct; stuck value and simultaneous faults each record 39 of 40. The v2 nominal false-positive point estimate is 2 of 40, but its exact one-sided 95 percent upper bound is approximately 14.92 percent.
- Exact model compatibility and identity can be rejected instead of guessed.
- Campaign evidence is reproducible from a versioned spec hash and ordered replay manifest.
- A versioned inline Web Worker handler and browser client isolate campaign work, validate request association, report progress, and expose cancellation. The application binds run, progress, cancellation, failure, partial-result metrics, and versioned JSON export states. Its default campaign bounds one profile, one nominal case, and 30 severity, duration, and onset-phase fault cases to 1 through 12 unique seeds, or 31 through 372 cases, at 180 samples per case. Lower-level validation caps a specification at 4 profiles, 64 scenarios, 12 seeds, 372 cases, and 256 KiB; a result at 10 MiB; and each case at 128 detections and 2,048 calibration observations. SQLite history caps retained result payloads at 64 MiB and the database at 128 MiB. The source path yields between cases so queued cancellation can produce a validated partial result. Cancellation and temporal offline packaging still require exact-commit browser evidence.
- All inputs, profiles, scenarios, artifacts, metrics, and conclusions in this decision are synthetic and unclassified. They are not aircraft certification, affiliation, operational, or safety evidence.
