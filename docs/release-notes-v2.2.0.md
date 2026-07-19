# v2.2.0 release notes

## Status

This release turns the dashboard into a deeper fault-investigation and repeatable verification workbench. The repository records local working-tree evidence separately from protected CI, CodeQL, Pages, provenance, and tagged release evidence. GitHub checks and attached release artifacts remain authoritative for the published commit.

## Highlights

### Minimalist workbench interface

- Refined all five views with flatter graphite surfaces, restrained aviation-blue accents, clearer typographic hierarchy, quieter status treatments, visible focus, and responsive chart containment.
- Preserved the existing workbench identity, information density, replay controls, and non-color status cues while removing decorative visual noise.

### Reproducible development environment

- Added an optional development-container configuration based on the official JavaScript and Node.js 22 Bookworm image, pinned by digest and configured for the non-root `node` user, pnpm 11.9.0, the frozen lockfile, and only the Vite and simulator ports.
- Added a required CI job that builds the pinned container without publishing an image and runs validation plus the normal and offline builds. Its result is part of the aggregate `CI required` check.

### Temporal mission investigation

- Added a deterministic `temporal-synthetic.v1` generic fixed-wing generator with a nominal mission and ten declared synthetic fault scenarios.
- Added ground, takeoff, climb, cruise, descent, landing, and return-to-ground phase estimation with separate entry and maintain thresholds and two-sample hysteresis.
- Added redundant altitude and vertical-rate fusion with prediction, observation, estimate, innovations, missing sensors, and 95 percent uncertainty.
- Added evidence-backed deterministic indications for missing sensors, large fusion innovation, redundant-sensor disagreement, vibration noise, stuck altitude, and abnormal fuel quantity-flow behavior.
- Added aligned onset, active-end, recovery-end, phase, uncertainty, residual, rule, model, and detection-delay evidence.
- Wired an Investigation application view with synthetic scenario controls, replay, keyboard-capable charts, overlays, evidence lists, phase log, optional model hypotheses, and JSON export.
- Added capture-and-replace comparison baselines. Current and captured observed and predicted altitude waveforms are overlaid only when profile, cadence, sample count, and sample indices match exactly. The application does not guess or interpolate a mismatch.
- Added selected-sample evidence for four signals: authoritative deterministic rules, advisory robust covariance, supporting Kalman innovations with top residual sensors, and the advisory temporal model. The four-way summary never changes deterministic authority.
- Minimized Investigation JSON by default. Generated samples, point traces, and series are included only after an explicit source-export selection. Campaign JSON continues to omit source telemetry rows.

### Experimental temporal model

- Preserved `temporal-fault-model.v1` as research-evidence-only. Its separate five-channel generator, same-population detector comparison, and post-hoc challenge do not describe the browser Investigation path.
- Added the production-integrated advisory `temporal-fault-model.v2`, trained and evaluated with selected 40-sample windows produced by the actual synthetic mission generator and Investigation projection.
- Added a deterministic 51-feature causal multiscale encoder with learned standardization, lifecycle-and-phase-partitioned nearest-prototype classification, class radii, normalized distance similarity, anomaly margin, and explicit `unknown` abstention. Similarity scores rank declared classes and are not calibrated probabilities.
- Added separate Python generation and TypeScript inference parity evidence for both artifact roles.
- Added an immutable registry entry with exact profile, schema, channel, unit, cadence, window, artifact hash, configuration hash, training, calibration, held-out evaluation, model-card, and gate evidence references.
- Kept the registry user default disabled and all model results advisory. Deterministic rules remain authoritative.

### Reproducible campaigns and history

- Added `campaign.v1` specification and result contracts.
- Added deterministic profile, parameterized scenario, and seed matrix execution through injected builder and evaluator callbacks. The wired matrix includes low-short climb, standard cruise, and high-long descent variants for every fault family.
- Added progress, `AbortSignal` cancellation, contained case failures, replay manifests, and stable specification SHA-256 identity.
- Added expected, missing, and unexpected detections; confusion by profile, phase, and fault; scenario coverage; episode metrics; false alarms; time to detection; calibration; abstention; and seeded bootstrap intervals.
- Added `campaign-worker.v1`, an inline worker handler, and a validating browser client. The temporal executor maps `sensor-lag` to the mission generator's `lag` and keeps model details advisory.
- Wired the campaign panel to seed validation, worker execution, progress, cooperative event-loop cancellation, validated partial-result rendering and export, configuration and error states, metric rendering, and versioned JSON export.
- Added three ordered SQLite campaign migrations, run-scoped deterministic case identity, foreign keys, indexes, idempotent ingestion, integrity checks, queryable variation dimensions, and concise summary reporting that does not duplicate the stored full result payload.

## Checked model evidence

The repository contains two evidence tracks with different roles and evaluation units. They must not be combined into one release-performance claim.

### V2 production-integrated advisory

Exact synthetic observations from `models/temporal_evaluation_v2.json`:

| Metric                                       |          Value | Count basis                |
| -------------------------------------------- | -------------: | -------------------------- |
| Balanced selected 40-sample windows          |            440 | 40 nominal, 400 fault      |
| True positives                               |            391 | of 400 fault windows       |
| False negatives                              |              9 | of 400 fault windows       |
| False positives                              |              2 | of 40 nominal windows      |
| True negatives                               |             38 | of 40 nominal windows      |
| Binary selected-window precision             | 0.994910941476 | point estimate             |
| Binary selected-window recall                |         0.9775 | point estimate             |
| Binary selected-window F1                    | 0.986128625473 | point estimate             |
| Observed selected-window false-positive rate |           0.05 | 2 of 40 nominal windows    |
| Classification macro F1                      |  0.98546835443 | ten declared fault classes |
| Abstention rate                              | 0.009090909091 | 4 of 440 selected windows  |

Each 180-sample mission contributes exactly one deliberately selected 40-sample causal window. These are selected-window observations, not complete episodes, full mission streams, prevalence-weighted samples, independent flights, or real-world results. Runtime scoring evaluates rolling windows after warmup, so this table does not measure full-stream false alarms, first post-onset detection, detection delay, or recovery behavior.

The observed nominal false-positive count is 2 of 40. The exact one-sided 95 percent upper confidence bound is approximately 14.92 percent. This sample therefore does not establish an underlying false-positive rate at or below 5 percent.

The deterministic seed-cluster bootstrap uses seed `22073` and 1,000 iterations. Its 95 percent interval is `0.97845373891` through `0.992481203008` for selected-window F1, `0.976720288326` through `0.992436708861` for classification macro F1, and `0.7` through `0.925` for minimum per-fault classification recall.

Every declared fault class satisfies the selected-window minimum recall of 0.65. Cross-sensor decoupling is the weakest named class at 33 of 40 correct selected windows, or 0.825 recall. Stuck value and simultaneous faults each record 39 of 40; the other seven classes record 40 of 40. The point-estimate gate passes, but hypotheses remain exploratory and the standalone full-stream learned-model evaluator is explicitly deferred to v2.3.

### V1 research-evidence-only

Exact held-out synthetic values from `models/temporal_evaluation_v1.json`:

| Metric                                  |          Value |
| --------------------------------------- | -------------: |
| Held-out examples                       |            440 |
| Episode precision                       | 0.997311827957 |
| Episode recall                          |         0.9275 |
| Episode F1                              | 0.961139896373 |
| False-positive rate                     |          0.025 |
| Classification macro F1                 |  0.94734856407 |
| Minimum per-fault classification recall |          0.675 |
| Abstention rate                         | 0.043181818182 |

The deterministic bootstrap 95 percent interval for episode F1 is `0.94405347036` through `0.973354940533`, using seed `22072` and 300 iterations.

The v1 research artifact passed its declared primary synthetic thresholds. Sensor lag is its weakest class: detection recall `0.7`, classification recall `0.675`, and four abstentions across 40 episodes. These figures support research comparison only and do not activate or validate the integrated browser path. See [temporal-model-evidence.md](temporal-model-evidence.md) for both artifact roles, hashes, partitions, counts, per-fault results, and limitations.

### V1 research same-population detector projection

The evaluation projects five detector paths onto the same 440 held-out synthetic episodes. This table uses binary episode outcomes only:

| System                            | Scope                                 |             F1 | False-positive rate |
| --------------------------------- | ------------------------------------- | -------------: | ------------------: |
| Temporal model                    | complete window-level evaluation      | 0.961139896373 |               0.025 |
| One-sample persistence predictor  | complete episode evaluation           |           0.75 |                 0.0 |
| Two-sample linear predictor       | complete episode evaluation           | 0.618307426598 |                 0.0 |
| Robust covariance detector        | unchanged cross-distribution transfer | 0.952380952381 |                 1.0 |
| Deterministic investigation rules | partial, two of eight rules eligible  | 0.333333333333 |                 0.0 |

This is not a ranking of the complete systems. The persistence and linear predictors are compact episode baselines, not the production fusion estimator. The robust covariance artifact was not recalibrated for the temporal population and marked every nominal episode positive. The deterministic row excludes six rules whose required redundant signals, fuel flow, or fusion state are unavailable in the compact five-channel windows. Ground truth is used only to choose the scoring interval and evaluate outcomes, never as detector input. Deterministic rules remain authoritative.

### V1 research post-hoc generalization challenge

The frozen artifact was also scored, without fitting or recalibration, on disjoint seeds 4101 through 4110. This evidence was designed after the primary gate and is explicitly non-gating:

| Dimension                                     | Episodes |             F1 | Recall | Fault abstention |
| --------------------------------------------- | -------: | -------------: | -----: | ---------------: |
| Magnitudes `0.45` and `1.60`                  |      210 | 0.726114649682 |   0.57 |            0.205 |
| Four onset and active-duration configurations |      410 | 0.545454545455 |  0.375 |             0.31 |
| Five novel two-fault combinations             |       60 |  0.73417721519 |   0.58 |             0.42 |

Exact combination classification is undefined because no matching combination classes exist. These values reveal material generalization limits, especially for short or late fault evidence, and do not change the primary release gate.

## Evidence identities

- V2 integrated artifact SHA-256: `4cdea6792b8d302a8cc0197caccbb4498b18d136b1c2ed93fe798d66a82633af`
- V2 integrated evaluation SHA-256: `ce1597d1b5df276c082b2a41dc6f1eaa4070cb31b6c1bb77b25e275957a4145c`
- V2 integrated parity SHA-256: `e0fd67f2ffa287895ae4e711a29e5dc08cf88efa0ef37c8f8557873f0836d0fe`
- V2 canonical configuration SHA-256: `30300e753e278f3ea8633fe71fb6ecdcdecf5a52146c85d2c22c6e2facbe956c`
- V1 research artifact SHA-256: `8d238523f942ccc2b4f60a0048ff413018059dd1e583a1be216653bc3ef60cf4`
- V1 research configuration SHA-256: `9c7639745597b7b5a1b1ea7d498dfb83ae9da045316445b4d77ffbb7696fa230`
- V1 research evaluation SHA-256: `c9b9e139ee1fba643357079b2a28b9688cddceb0e8bd160b6e1369b2a11c5d08`
- V1 research parity SHA-256: `b412a6a0a06de1e3bc5892baa46308c5e0ec3b304de9b618911e71fb8efd732b`

These identify the current workspace artifacts. They are not release checksums or provenance until generated and verified from the release commit.

## Local verification record

The July 19 working-tree verification completed the following gates before the branch was published:

- 424 TypeScript behavior tests passed with 90.18 percent branch coverage;
- 41 Python analytics and model tests passed;
- 49 Playwright desktop and mobile tests passed, with one intentional mobile duplicate-parity skip;
- automated accessibility scans reported zero serious or critical findings in the tested states;
- normal Pages and self-contained offline builds completed, including network-disabled Investigation and campaign execution;
- the 93-case synthetic temporal campaign completed without case failures;
- Stryker mutation testing scored 63.25 percent against the 60 percent break threshold;
- the dependency audit reported no known vulnerabilities;
- deterministic and temporal Node proxy benchmarks were regenerated for the recorded local environment.

These are local working-tree results. The tagged workflow reruns release-critical generation and attaches exact-commit verification, checksums, SBOM, screenshots, and provenance. Local timings are descriptive Node proxy measurements, not browser or operational performance claims.

The checked-in PNGs and `docs/screenshots/metadata.json` are local v2.2 captures. The tagged workflow regenerates the release copies from the published source.

## Known limitations

- All scenarios, training windows, artifacts, and metrics are synthetic and unclassified.
- V1 uses a separate five-channel research generator. Its metrics and challenges are not integrated Investigation evidence.
- V2 uses the actual mission generator and Investigation projection, but its current evaluation selects one 40-sample window from each mission. It is not an episode, full-stream, prevalence-weighted, independent-flight, or real-world evaluation.
- `lag` and `sensor-lag` require an explicit mapping. The worker executor includes that mapping, but every future adapter must preserve it deliberately.
- V2's weakest selected-window class is cross-sensor decoupling at 33 of 40 correct classifications. The checked selected-window point-estimate gate passes, but this does not establish full-stream mission behavior.
- V2 observed 2 false positives in 40 selected nominal windows, whose exact one-sided 95 percent upper bound is approximately 14.92 percent. The point estimate is not proof of a population rate at or below 5 percent.
- Full-stream learned-model false alarms, onset detection, delay, phase, duration, and recovery evaluation are deferred to v2.3 and are not release claims for v2.2.
- Normalized distance similarities are ranking scores, not calibrated class probabilities.
- Missing values are forward-filled for model features; deterministic missing-data indications remain authoritative.
- The application displays registry compatibility, while low-level scoring can still be called without profile, unit, or file-hash verification.
- Campaign contracts enforce 12 seeds, 372 total cases, 256 KiB specifications, 10 MiB results, 128 detections and 2,048 calibration observations per case. Campaign history caps retained result payloads at 64 MiB and the SQLite database at 128 MiB without silent pruning.
- The temporal worker yields between cases and returns validated partial evidence on cancellation. Browser results apply only to the tested Chromium desktop and mobile configurations.
- Temporal performance measurements are local Node proxy evidence and are not browser latency, safe-scale, or operational-performance claims.
- No real aircraft, operational data, affiliation, certification, maintenance, or safety claim is supported.

## Publication gate

The release is published only after:

- protected CI passes the TypeScript, Python, registry-identity, build, and development-container checks;
- browser, responsive, keyboard, offline, worker, and accessibility checks pass on the release commit;
- CodeQL, dependency review, and the dependency audit pass;
- the tagged workflow publishes the SBOM, checksums, verification evidence, screenshots, and provenance;
- the Pages deployment and GitHub release resolve to the verified commit.
