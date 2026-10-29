# Reduce alarms while preserving cruise-lag gains

This follow-up tests a causal decision rule around the frozen residual-lag forest. It changes no training weights, production source, registered model or prior report. Checkpoints are pushed to `feat/full-mission-evaluation`; no deployment or merge is part of the study.

## Diagnosis using already-seen data

The rejected target at threshold 0.70 produced 40/80 nominal missions with alarms and 61 episodes on seeds 25101–25180. Thirty-six episodes were single samples, but three lasted 9, 13 and 14 samples. A two-window streak reduced nominal alarms to 17/80 while reducing primary cruise confirmation from 38/80 to 37/80 and current-noise confirmation from 34/80 to 30/80. Three windows lost more cruise cases. Delaying a pre-onset alarm into the active interval also increased ordinary detection counts without improving model scores, so ordinary recall alone is insufficient.

A targeted threshold rule is more promising: require stronger score evidence generally, while allowing sensitivity when the observed signed lag evidence is positive. On the same old data, `score > 0.95 OR (score > 0.65 AND signedLag > 0)` gave 23/80 nominal alarm missions, 38/80 primary cruise confirmations and 36/80 current-noise confirmations. The primary total preserved its count through two lost and two gained cases; it was not individual-case lossless. These figures are design diagnostics, not fresh validation.

Extra alarms have mixed causes. Of 144 nominal alarming windows, 79 had positive lag evidence; 78 stopped alarming when only the signed lag feature was reset to its training median. Short non-lag residual spikes also contributed. A positive lag gate therefore cannot eliminate every false alarm. One filtered primary-cruise confirmation occurred at onset with strongly negative lag evidence and disappeared under the current-noise challenge, suggesting sensitivity to repeated injected noise in that individual case.

## Fixed experiment before new evaluation

Keep the forest and observed feature encoder frozen. At every eligible endpoint, a candidate alerts when:

```text
score > generalThreshold
OR (score > lagThreshold AND signedLag > 0 AND validSupport >= 8/17)
```

All comparisons are strict except the inclusive minimum valid support. Missing or invalid lag support cannot open the sensitive branch. The general branch remains available for other faults. Warmup, unavailable and abstained model states remain explicit and cannot start an alert. The rule uses current causal observations only; it receives no truth, phase labels, absolute sample index, seed or nominal-control values. It adds no backdated timestamps or alarm-holding duration.

The complete candidate grid has four settings: general thresholds 0.90/0.95 crossed with lag thresholds 0.65/0.70. The lag-evidence floor is fixed at zero. No additional grid expansion follows fresh evaluation. A uniform 0.95 threshold is a descriptive reference that shows what the sensitive lag branch contributes.

Primary comparator: the rejected residual-lag target at 0.70. A second reference is the earlier full-mission forest at 0.80, which has fewer alarms but weaker cruise detection. Registered v2 and deterministic rules remain separate references.

| Partition   | Seeds       | Primary missions | Separate current-noise challenges |
| ----------- | ----------- | ---------------: | --------------------------------: |
| Development | 26101–26140 |            1,640 |                                40 |
| Final       | 27101–27180 |            3,280 |                                80 |

Every mission retains 180 samples at one-second cadence and the existing 41-case primary matrix. Seeds must be disjoint from every registered and previous study partition through 25180. No new fitting or calibration is needed because the model is frozen and the four candidate configurations are declared here. Development chooses once; final tests the frozen setting. Five-seed batches retain explicit completion status and verified resumability.

## Acceptance and selection

- Reduce nominal mission alarms versus the 0.70 target, with a strictly negative upper bound on the paired 95% difference interval.
- Preserve ordinary and confirmed fault-specific recall against both the 0.70 target and the earlier 0.80 forest: at most two percentage points of overall loss, five points per fault family, and five seconds of paired p95 added delay.
- Preserve the 0.70 target's confirmed cruise-lag point recall in both primary and current-noise streams: neither may drop. In each stream, the paired 95% recall-difference lower bound must be at least -5 points, and paired p95 added confirmation delay at most five seconds. This is a population-rate tolerance, not a guarantee that every previously detected case remains detected; lost and gained case IDs will be disclosed.
- Retain at least a ten-point confirmed cruise-lag gain over the earlier 0.80 forest in each stream, with a strictly positive paired confidence lower bound.

All uncertainty uses 1,000 paired bootstrap resamples of whole seed clusters, keeping variants and shared nominal controls together. The existing resampling seed 22075 and existing scoring definitions remain unchanged. Undefined required comparisons fail. Misses remain in recall denominators, while paired delays use jointly detected cases.

Among passing development settings, choose the lowest nominal alarm rate, then the higher minimum confirmed recall across the two cruise streams, then higher overall confirmed recall, then higher general and lag thresholds. If none passes, apply the same order among settings meeting the preservation limits, or all settings if none preserves them, and freeze the result as rejected. A failed development result cannot be rescued by final data. No final tuning is permitted.

The older forest's nominal alarm rate remains prominent but is not the primary false-alarm improvement gate. Passing this study would establish improvement over the rejected lag-sensitive detector, not necessarily fewer alarms than every earlier detector or production readiness.

## Provenance and checkpoint

Frozen forest file SHA-256: `8b261036651f1b0708c8e45b27565d17280fc84396ca2fef6c1d41a0aa2aed6e`.

Earlier forest file SHA-256: `e1a0fa89202e33b3819ab134301b59f1dedbb4d4d0f5d209b3ead862e9d328e2`.

Parent final report content hash: `aacc41e08a844e800f7372dafaddee1c419a2a8329305ace9d06cb30367b4b8e`.

At this design checkpoint, no 261xx or 271xx mission has been generated. Implementation, tests and fresh evaluation are pending. Production remains unchanged regardless of the experimental outcome.
