# Alarm reduction and cruise-lag preservation results

The adaptive policy is **rejected** under the frozen acceptance rules. On 80 fresh final seeds it reduces nominal alarm missions from 40 to 18 and preserves the same 41 primary cruise-lag confirmations. However, current-noise challenge confirmations fall from 39 to 38. Development had also failed preservation. Production, registered models and trained weights remain unchanged.

The selected rule alerts when `score > 0.95`, or when `score > 0.70` with positive signed lag evidence and at least 8/17 valid support. Four settings were declared before development seeds 26101–26140. The fallback selected this rejected setting and froze it before final seeds 27101–27180. Final evaluation includes 3,280 primary missions and 80 separate current-noise challenges. Each mission has 180 one-second samples. No final-data tuning occurred.

## Fresh final evidence

All columns use matching final cases. The earlier forest is the previous full-mission model at 0.80; the lag target and adaptive policy share the same frozen targeted forest.

| Metric                                       |       Earlier forest |      Lag target 0.70 |   Adaptive candidate |
| -------------------------------------------- | -------------------: | -------------------: | -------------------: |
| Nominal missions with alarms                 |       25/80 (31.25%) |       40/80 (50.00%) |       18/80 (22.50%) |
| Nominal alarm episodes                       |                   27 |                   56 |                   25 |
| Active-fault detections                      |          3,134/3,200 |          3,160/3,200 |          3,163/3,200 |
| Active misses                                |                   66 |                   40 |                   37 |
| Confirmed fault-specific detections          | 3,055/3,200 (95.47%) | 3,037/3,200 (94.91%) | 3,100/3,200 (96.88%) |
| Confirmed primary cruise lag                 |                 3/80 |                41/80 |                41/80 |
| Confirmed current-noise cruise lag           |                 4/80 |                39/80 |                38/80 |
| Ordinary primary cruise detections           |                19/80 |                61/80 |                57/80 |
| Ordinary current-noise cruise detections     |                18/80 |                56/80 |                50/80 |
| False-alarm episodes across primary missions |                  594 |                1,359 |                  570 |

The adaptive policy removes alarms from 22 nominal missions and introduces none relative to the lag target. Against the earlier forest it removes 13 nominal alarm missions but introduces six. Registered v2 alarms in 80/80 nominal missions and detects 2,526/3,200 active faults. Deterministic rules alarm in 46/80 nominal missions and detect 2,512/3,200. Those references remain separate; they do not determine promotion.

The uniform 0.95 reference alarms in only 12/80 nominal missions but confirms just 19/80 primary and 18/80 current-noise cruise cases. The sensitive lag branch retains substantial cruise benefit while adding six nominal alarm missions relative to that reference. It does not eliminate the noise-versus-sensitivity tradeoff.

Recovery alarm exposure falls from 44,378 to 43,054 seconds summed across primary missions, and post-recovery carryover falls from 150 to 22 seconds. Both experimental policies have 127,920 warmup samples, zero abstained or unavailable samples, and zero unobservable faults in this matrix. The report retains undefined denominators explicitly in groups where a rate has no applicable cases.

## Uncertainty and the failed acceptance gate

Intervals use 1,000 paired bootstrap resamples of whole seed clusters, preserving related variants and nominal controls. Differences are adaptive minus lag target, in percentage points.

| Difference                            | Estimate | Paired 95% interval |
| ------------------------------------- | -------: | ------------------: |
| Nominal mission alarm rate            |   -27.50 |    -37.50 to -18.75 |
| Ordinary active recall                |    +0.09 |      -0.16 to +0.47 |
| Confirmed fault-specific recall       |    +1.97 |      +0.88 to +3.22 |
| Confirmed primary cruise recall       |     0.00 |        0.00 to 0.00 |
| Confirmed current-noise cruise recall |    -1.25 |       -3.75 to 0.00 |

Nominal reduction versus the lag target is supported, with a 55% relative reduction in the observed mission count. Versus the earlier forest, the nominal difference interval is -20.00 to +1.25 points, so its lower point estimate does not establish a reduction against that comparator. Cruise gains over the earlier forest remain supported: +37.50 to +58.75 points for primary confirmation and +31.25 to +53.75 for the challenge.

Overall and family preservation limits against both forests pass on final data. Paired p95 added delay is one second for overall ordinary and confirmed detection. Primary and challenge cruise confirmed p95 added delay are both zero, but this statistic hides rare large delays: primary cases 27102 and 27161 add 18 and 14 seconds; current-noise case 27102 adds 19 seconds. These affect 2/41 and 1/38 jointly confirmed cases. Misses are excluded from paired delay calculations but remain in recall denominators.

The one lost challenge confirmation violates the strict point-recall preservation rule. Development also failed: primary confirmations fell from 24/40 to 23/40, the paired lower bound was -7.5 points, and challenge p95 added delay was 15 seconds. Final data cannot reverse that frozen failure. This is useful evidence of an alarm reduction, not a passing solution or a production recommendation.

## Causes, exact cases and remaining weaknesses

Already-seen diagnostic data showed that a two-window streak suppressed many brief nominal episodes but lost cruise confirmations. Nominal alerts had mixed causes: positive noisy lag evidence and other short sensor residual spikes. A gate around the frozen model therefore targeted high scores outside plausible lag evidence while preserving sensitivity when the causal lag feature was positive. Those old diagnostics are design evidence, not fresh validation.

The fresh failure identifies the gate's limitation directly. In `27105:lag:standard-cruise:current-noise`, the lag target alerts at samples 78–81 and confirms at 80, five seconds after onset. Scores are 0.793–0.838, but signed lag evidence is negative, from -12.525 to -9.196, with full valid support. The adaptive gate removes that entire episode. Its sample-86 alarm also occurs in the nominal control, sample 94 is isolated, and its next sustained interval starts at 107, after the active interval ends at 106. It therefore has ordinary detection but no confirmed fault-specific detection. This is a genuine loss under the predeclared metric, not an excluded case.

The clean preservation replay is `27107:lag:standard-cruise`: both policies alert from 93–120 and confirm at 95, 20 seconds after onset, while nominal controls stay clear. The earlier forest starts at 112, after the active fault has ended. Replay `27108:nominal:default` removes two target alarm episodes. Replay `27103:nominal:default` retains a false alarm at 111–112, illustrating that positive noisy lag evidence still opens the sensitive branch. The delayed 27102 primary and current-noise replays expose the long delay tail.

Thirty-nine primary cruise faults and 42 current-noise challenges still lack confirmation. Ordinary cruise detections also drop, even though confirmed primary cases are individually preserved. More ordinary or confirmed detections overall do not mean better underlying model scores: weights and scores are unchanged, and filtering changes alert onset boundaries and control overlap. Confirmation is a matched synthetic fault-presence test, not correct fault-family classification or real-aircraft validation.

## Verification and reproduction

- 549 TypeScript tests pass, including 15 new policy, preservation, invalid-input, provenance and report fixtures. Core branch coverage is 91.52%, which is the configured production-core scope, not experimental-tool coverage.
- Lint, typecheck, scoped formatting and traceability pass. Traceability contains 179 requirements and 352 declared test IDs across 43 areas.
- Six prior case/control replays preserve 18 baseline prediction and result streams exactly. Seven fresh illustrative case/control replays reproduce their sealed records exactly.
- Independent audit reconstructs 13,120 binary model/fault confirmations and reconciles all 3,360 final records. It does not independently recompute bootstrap intervals.
- All 128 reuse inputs remain byte-identical to this study's initial reuse receipt. Reused evidence comprises 52 Python passes, normal/offline bundling and 49 production-preview browser passes with one existing skip. No new Python training or dependency changes occurred.
- A cached final resume reads all 16 verified batches and reproduces report and selection bytes exactly. Two attempts in the OneDrive checkout hit an atomic status-rename file-lock error; both failures remain recorded. An unchanged copy outside OneDrive resumes successfully and is the delivered completed evidence.
- The delivered report and replay are checked offline at desktop and mobile sizes. Presentation-only corrections neutralize the headline and expose rare delayed cases without modifying frozen source, model, JSON or predictions.

Use [the protocol](alarm-preservation-experiment.md) for commands and [the frozen selection](alarm-preservation-freeze.json) for the pre-final checkpoint. The delivery folder includes an offline report, exact replays, a short demonstration guide, sealed batches, model artifacts, minimal parent provenance, verification receipts and file checksums. Keep outputs outside cloud-synced directories if atomic replacement is locked.

GitHub checkpoints separate design, implementation, frozen development selection and final evidence. No merge, deployment or production promotion is part of this study. Seeds through 27180 are now observed and cannot be reused as fresh evaluation in a subsequent study.
