# Residual alarm and cruise-lag results

The targeted candidate is **rejected**. It detects more cruise lag, including a challenge that removes repeated historical sensor noise, but it doubles nominal missions with alerts and loses too much confirmed fault-specific recall. Production remains unchanged.

The study used 60 fresh fitting seeds, 40 calibration seeds, 40 development seeds and 80 final seeds. All were separated from prior experiments. Final evaluation contains 3,280 primary missions plus 80 separate current-noise challenges, each with 180 one-second samples. Development froze both forests at threshold 0.70 before final access. No setting passed development; the predetermined fallback prioritizes cruise recall among settings preserving detection limits, so it is a diagnostic candidate rather than a recommended operating point.

## Fresh final comparison

Both columns below use the same final seeds, 25101–25180. The incumbent is the previous full-mission forest at threshold 0.80, not the weaker registered v2 model.

| Metric                                       |      Previous forest |   Targeted candidate |
| -------------------------------------------- | -------------------: | -------------------: |
| Nominal missions with alarms                 |       20/80 (25.00%) |       40/80 (50.00%) |
| Nominal-only alarm episodes                  |                   25 |                   61 |
| Active-fault detections                      | 3,121/3,200 (97.53%) | 3,138/3,200 (98.06%) |
| Active misses                                |                   79 |                   62 |
| Confirmed fault-specific detections          | 3,064/3,200 (95.75%) | 2,977/3,200 (93.03%) |
| Confirmed cruise-lag detections              |         7/80 (8.75%) |       38/80 (47.50%) |
| Current-noise challenge confirmations        |         5/80 (6.25%) |       34/80 (42.50%) |
| False-alarm episodes across primary missions |                  592 |                1,424 |
| Recovery alarm seconds                       |               42,764 |               44,221 |
| Post-recovery carryover seconds              |                   71 |                  139 |

The candidate removes alarms from two nominal missions but introduces them in 22 others. Its 223 unconfirmed primary faults comprise 84 interrupted confirmations, 75 coincident control alarms, 62 missions without a new active alert and two confirmations interrupted by the active-interval boundary. A binary detector can produce more ordinary detections while responding less specifically to the injected fault.

The registered v2 reference alarms in 80/80 nominal missions and detects 2,518/3,200 active faults. Deterministic rules alarm in 40/80 nominal missions and detect 2,507/3,200. These remain separate references; their weaker results do not make the new candidate acceptable.

## Paired uncertainty and acceptance

Intervals use 1,000 whole-seed paired bootstrap resamples, keeping related scenarios and their nominal control together. Differences below are candidate minus incumbent, in percentage points.

| Difference                      | Estimate | Paired 95% interval |
| ------------------------------- | -------: | ------------------: |
| Nominal mission alarm rate      |   +25.00 |    +13.75 to +35.00 |
| Ordinary active recall          |    +0.53 |      -0.44 to +1.31 |
| Confirmed fault-specific recall |    -2.72 |      -4.66 to -1.03 |
| Confirmed cruise-lag recall     |   +38.75 |    +27.50 to +50.00 |
| Current-noise challenge recall  |   +36.25 |    +25.00 to +48.75 |

Ordinary detection preservation passes: the largest family loss is 1.56 points and paired p95 added delay is zero seconds across 3,094 joint detections. Confirmed preservation fails: overall loss is 2.72 points, exceeding the two-point limit, and cross-sensor decoupling loses 5.31 points, exceeding the five-point family limit. Confirmed paired p95 added delay is zero across 2,932 jointly confirmed cases. Delay results exclude missed cases, which remain in recall denominators.

Cruise gains pass their isolated ten-point and positive-confidence-bound criteria in both streams. Nominal alarm reduction fails decisively. Development had already failed, and final results cannot rescue it. No thresholds or features were changed after final access.

## Causes and what the targeted test establishes

The already-observed diagnostic set had 19 nominal missions with 26 alarm episodes. At 19 episode peaks, tree-path contrasts were led by short sensor-disagreement summaries. Only seven episodes began near a phase transition. This supports investigating brief disagreement noise clusters rather than blanket transition suppression, but path contrasts alone do not prove causation.

Cruise lag produces a much weaker speed shift than climb lag. Its roughly 0.78-knot maximum shift is below the nominal sensor-pair noise standard deviation of about 1.22 knots. The old raw lag search also compares leading and lagging offsets over unequal timestamp supports. The targeted feature uses smoothed GPS and signed three-sample lag evidence on common supports, entirely inside the current window, while recording missing support. Fifteen-sample agreement summaries add context without removing prompt five-sample features.

The matched feature ablation uses the same fresh training corpus and forest parameters. At the separately frozen 0.70 thresholds, the retrained original-feature control confirms only 3/80 primary cruise-lag cases and 1/80 current-noise challenges, versus 38/80 and 34/80 for the targeted feature bundle. Paired gain intervals are +33.75 to +53.75 points and +30.00 to +52.50 points. This supports a cruise-lag benefit beyond retraining alone and weakens the explanation that the gain depends on repeated historical IAS noise.

The control alarms on 34/80 nominal missions versus 40/80 for the targeted model; their paired difference interval spans -5.00 to +18.75 points. The feature bundle does not establish a nominal-alarm benefit. It also does not identify which added feature supplies every benefit. Short-disagreement features still dominate the fitted forest's descriptive importance. Better sensitivity at the selected low threshold leaves a substantial noise-versus-fault tradeoff.

The blind spot is only partially reduced: 42/80 primary cruise-lag cases and 46/80 current-noise challenges still fail confirmation. Confirmed cruise-lag median delay is 21 seconds. These are synthetic fault-presence results, not fault-family classification, operational probabilities or real-aircraft validation.

## Verification and reproducibility

- 534 TypeScript tests and five new Python tests pass. Hand-computed fixtures cover causal lag evidence, missing support, feature masks, float32 tree routing, truth independence, paired gates and freeze guards.
- Formatting of source/documentation, lint, typecheck and traceability pass. Core branch coverage is 91.52%; this is the configured production-core scope, not a claim of experimental-tool branch coverage.
- All 123 relevant production input files match the prior verified commits. Reused checks: 42 production Python tests, normal and offline bundling, and 49 production-preview browser passes with one existing skip. Fresh typecheck covers the new tools included by build wrappers.
- Both forests, scaler, thresholds and parity metadata reproduce byte for byte in an independent repeat fit. Python/TypeScript parity covers 57 cases with maximum error 3.82e-16.
- Six case/control replays match the frozen evidence exactly. Cached final evaluation reproduces the report bytes and selection unchanged from 16 verified batches.
- An independent interval audit reconstructs 9,840 binary model/fault confirmations across the incumbent, targeted model and retrained control, and reconciles all 3,360 case records. It does not claim to independently recompute the bootstrap intervals.
- The delivered report and illustrative replay pass offline desktop/mobile browser checks: no JavaScript errors, external network requests, serious/critical accessibility findings or page overflow. The report's recorded presentation-only correction distinguishes diagnostic association from proven causation.

Model SHA-256: `8b261036651f1b0708c8e45b27565d17280fc84396ca2fef6c1d41a0aa2aed6e`.

Final report content hash: `aacc41e08a844e800f7372dafaddee1c419a2a8329305ace9d06cb30367b4b8e`.

The delivered package contains the offline HTML report, sealed JSON results and batches, learned artifacts, frozen selection, corpus metadata, exact replays, verification receipts and demonstration guide. Binary feature matrices regenerate from the frozen protocol and are omitted from the package. All four new partitions are now seen and cannot become fresh holdouts for another tuning cycle.

GitHub checkpoints on `feat/full-mission-evaluation`: `9c70614` diagnosis/design, `fe365ac` implementation/tests, and `930913a` rejected development freeze before final. The results are a separate final checkpoint. Main, production inference and the registered model are unchanged.
