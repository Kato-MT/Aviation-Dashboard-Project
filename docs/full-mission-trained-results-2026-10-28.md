# Full-mission trained model: final synthetic results

The frozen forest passed the declared relative improvement gates on 80 fresh seeds. It is a substantial benchmark improvement, not a production-ready replacement. Nominal missions still alarmed 23.75% of the time, and standard-cruise lag remains a major blind spot. Production code, registered v2 weights and deterministic rules were not changed.

## What changed

The earlier diagnosis found limited nominal coverage from selected midpoint windows, extreme amplification from near-zero feature scales, and loss of useful raw-sensor disagreements in the fused projection. The new experimental detector learns from all 346,860 eligible windows in 2,460 complete fitting missions. It uses 72 causal observed features, training-only robust centering and scaling with resolution floors, constant masking and clipping, and supervised fault-presence targets.

This tests a combined change to training coverage, preprocessing, features and classifier. It does not isolate each component's individual contribution. No truth, seed, scenario label, time index, future observations or nominal-control trajectory enters inference.

The fitting, calibration, development and final seeds are 18101–18160, 19101–19140, 20101–20140 and 21101–21180. Each seed has 41 missions, each with 180 one-second samples. All partitions exclude prior experiment and registered-model partitions. The full design, development refinement and commands are in [the protocol](full-mission-trained-model.md).

## Final results

The selected setting is a frozen 64-tree forest, threshold **0.80**, streak **1**. Its development-only refinement and original calibration-grid selection are both retained. Only this selected setting was scored on the final partition; there was no tuning on final results.

| Metric                                   |        Registered v2 |    Trained candidate |                   Deterministic rules |
| ---------------------------------------- | -------------------: | -------------------: | ------------------------------------: |
| Nominal missions with alerts             |                80/80 |                19/80 |                                 46/80 |
| New active-fault detections              | 2,533/3,200 (79.16%) | 3,135/3,200 (97.97%) |                  2,507/3,200 (78.34%) |
| Active-fault misses                      |                  667 |                   65 |                                   693 |
| Confirmed fault-specific detections      |     96/3,200 (3.00%) | 3,064/3,200 (95.75%) | Not used for learned-model acceptance |
| False-alarm episodes across all missions |                9,572 |                  588 |                                 1,815 |
| False-alarm episodes in nominal missions |                  425 |                   26 |     See machine-readable rule results |
| Ordinary detection-delay p95             |                 16 s |                  6 s |                                  14 s |
| Abstention among eligible samples        |               55.59% |                   0% |                                    0% |
| Recovery alarm exposure                  |             15,978 s |             42,718 s |                              21,937 s |
| Post-recovery carryover                  |              4,729 s |                 66 s |                                 105 s |

The 95% paired seed-bootstrap interval for the nominal alarm-rate change is **−85.00 to −66.25 percentage points**, supporting a reduction. The active-recall gain interval is **+17.75 to +19.84 points**. The confirmed fault-specific recall gain interval is **+91.38 to +94.06 points**. Each interval uses 1,000 resamples of whole seed clusters, preserving all related variants and their shared control.

Paired p95 added ordinary delay is **4 seconds** across 2,470 jointly detected cases, within the five-second limit. The largest family recall loss is sensor lag, **2.5 points**, within the five-point limit. Specificity's paired p95 added delay is −11 seconds across only 92 jointly confirmed cases. Joint-detection delay comparisons exclude misses, which remain explicit in the recall and family results.

All 3,200 faults had post-warmup active exposure. Every mission retains 39 warmup samples; neither detector made warmup detections. Recovery alarm exposure increased because the new training target explicitly includes declared recovery. The much smaller post-recovery carryover should not be confused with less alarm time during recovery.

## What fault-specific means here

A credited specific response requires a new active alert that persists for three samples while an independently scored same-seed nominal control remains clear. The third sample is the detection time. A coincident or unknown control before confirmation disqualifies the episode; a later clearing control cannot rescue it.

The old model's 3% figure is this deliberately stricter measure, not its ordinary recall. Its nominal-control alarms and abstentions prevent most confirmations. The new figure measures controlled responsiveness to injected faults. It does not establish correct fault-family classification, real-aircraft causal diagnosis or operational probability calibration. The new model is a binary detector.

## Remaining weaknesses

- **Nominal alarms remain substantial:** 19 of 80 nominal missions generated 26 episodes. The relative acceptance gates are not an operational false-alarm budget.
- **Cruise lag is poorly detected:** ordinary detections are 17/80 and confirmed specific detections are only 3/80 for `lag / standard-cruise`. The old model had 78 ordinary detections but zero confirmed specific detections in that subgroup. Improvements elsewhere must not hide this weakness.
- **Some outcomes regress:** 63 old ordinary detections became misses; four previously confirmed fault-only outcomes were lost. The candidate gains more elsewhere, but those losses remain visible.
- **Limited distribution:** the benchmark uses one synthetic mission profile, fixed duration and existing fault mechanisms. The lag generator repeats earlier noisy values at onset. No exact-repeat feature was added to exploit that artifact, but simulator-specific patterns may still help a forest.
- **No uncertainty rejection head:** the new binary model answers all post-warmup windows. Its zero abstention is a design difference, not proof that all inputs are trustworthy.

These results support retaining this as an improved experimental candidate. They do not support replacing the production family classifier or claiming that false alarms are solved.

## Demonstration cases

| Purpose                      | Case                          | What to inspect                                                                                                                                         |
| ---------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Successful specific response | `21101:gradual-drift:default` | Candidate rises above 0.80 during the active interval while the nominal control stays clear.                                                            |
| Main blind spot              | `21102:lag:standard-cruise`   | Candidate never alarms during active samples 75–106. Old ordinary detection at75 coincides with the control and is not confirmed specific.              |
| Removed false alarm          | `21102:nominal:default`       | The registered model alarms; the trained candidate stays clear throughout.                                                                              |
| Remaining false alarm        | `21101:nominal:default`       | Candidate alarms at111–113 and116–118 despite no fault.                                                                                                 |
| Genuine specificity tradeoff | `21175:lag:default`           | Both ordinary detections occur at39. Old specific confirmation occurs at56; the candidate's initial confirmation is interrupted by its nominal control. |

Replays regenerate both fault and nominal-control missions and compare the complete per-mission result hash with the frozen evidence. Their JSON stores scores, alert states, replay parameters and hashes. Raw sensor measurements are regenerated from the parameters rather than stored in replay JSON.

## Verification

The 518-test TypeScript suite passes with 91.52% core branch coverage. The five new Python numerical/training fixtures pass. Fixtures cover causal features, truth/quality independence, future independence, finite scaling, float32 tree routing, interval boundaries, control abstention, no backdating, invalid input, bootstrap pairing, source drift, corrupt caches and freeze locks. Python/TypeScript parity passes on 61 stored cases, with maximum score difference 2.22e-16.

A second full fit from the checksummed corpus reproduced the scaler, every tree, linear parameters and all thresholds exactly. Three saved Python parity scores differed by at most 5.42e-20, consistent with parallel floating-point reduction. Therefore the complete JSON file hash differs, but the selected detector's inference components are identical. The original frozen artifact remains the evaluated artifact; the repeated fit is reproducibility evidence, not another selected candidate.

Lint, typecheck, source formatting and traceability pass. The final report passes offline desktop/mobile rendering and serious/critical accessibility checks, with no JavaScript errors or external requests. Cached final evaluation reproduces the report byte-for-byte. All five illustrated cases replay exactly.

Successful existing production checks are reused because their source, package, model and configuration inputs remain unchanged: 42 Python tests, normal/offline builds, and 49 browser tests with one existing skipped duplicate. Full-source formatting excludes two untouched personal untracked Markdown files. A first concurrent coverage run hit two five-second I/O-heavy test timeouts while training ran; reducing test workers to two produced the complete passing suite without changing timeout thresholds.
