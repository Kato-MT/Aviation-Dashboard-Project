# Nominal correction experiment: rejected

The targeted correction reduced false alarms but suppressed too many faults. It is not a usable model fix, and the production app and registered model remain unchanged.

## Fresh final evidence

The candidate was frozen after development and tested once on seeds 17101–17180: 3,280 missions, including 80 nominal and 3,200 fault missions. The fitted envelope used seeds 14101–14140, calibration 15101–15140, and development 16101–16140. No final-data tuning occurred.

| Metric                                   | Registered v2        | Experimental nominal envelope |
| ---------------------------------------- | -------------------- | ----------------------------- |
| Nominal missions with alerts             | 80/80                | 9/80                          |
| Active faults detected                   | 2,523/3,200 (78.84%) | 603/3,200 (18.84%)            |
| Missed faults                            | 677                  | 2,597                         |
| False-alarm episodes across all missions | 9,244                | 347                           |
| Abstention                               | 55.62%               | 10.88%                        |
| Unavailable samples                      | 0                    | 0                             |
| Recovery alarm exposure                  | 16,027 seconds       | 5,205 seconds                 |

Paired p95 added delay was **29 seconds**, exceeding the five-second limit. Recall fell **60 percentage points**, exceeding the two-point limit. Cross-sensor decoupling and lag fell to zero active detections, and every family exceeded its allowed five-point loss. The correction fails all three performance guardrails.

The 1,000 paired seed bootstrap gave a nominal-mission false-alarm-rate change interval of **−95.00 to −81.25 percentage points**, but a recall change interval of **−61.00 to −59.16 points**. A supported false-alarm reduction does not override the failed recall and delay requirements.

The deterministic rules remained separate: 46/80 nominal missions alarmed and 2,514/3,200 faults were detected. Their behavior was not modified.

## Development was already negative

All three preregistered settings failed. Nominal alarms and recall were:

| Calibration setting          | Nominal alarms | Active-fault recall |
| ---------------------------- | -------------- | ------------------- |
| Registered v2                | 40/40          | 78.94%              |
| Window distance p95          | 40/40          | 51.31%              |
| Window distance p99          | 33/40          | 34.25%              |
| Mission maximum distance p95 | 4/40           | 18.50%              |

Following the predeclared fallback, the lowest-alarm setting was frozen as a rejected candidate for final confirmation. The final result did not trigger another tuning cycle.

## What the diagnosis established

The old model's five nominal prototypes and selected-window calibration underrepresent full-mission transitions. Almost-constant training features scaled by `1e-9` can magnify small discrete changes. A nominal window outside the distance threshold is forced into the fault-class search, where broad class radii can allow a false alert.

The new envelope addresses that normal-coverage problem but also absorbs many fault windows. Merely adding a nominal rejection gate does not restore adequate fault separation. A future correction should reconsider the feature scaling and fault classifier together using full-mission nominal and fault data. This experiment does not establish which replacement model will succeed.

## A limitation in the original recall interpretation

For each final fault mission, compare its first credited baseline alert start with all alert starts in the nominal mission having the same seed. **1,974 of 2,523** first credited starts coincide exactly. The candidate has **17 of 603** coincident starts.

The generator constructs the full nominal trajectory and noise before applying a fault, so these same-seed controls share the underlying mission. Coincidence means the alert timing is not unique evidence of the injected fault. It does not prove the fault had no effect on scores, labels, or duration. Stateful fusion and trailing windows may retain fault effects after recovery.

This is a descriptive post-evaluation diagnostic, not a replacement metric or an adjusted acceptance result. The published active-interval metric remains unchanged, and the candidate remains rejected. Future evaluations would benefit from a separately preregistered fault-specificity metric alongside the existing active-interval recall.

## Three exact replays

1. `17101:nominal:default`: the baseline produces five false-alarm episodes; the candidate produces none.
2. `17101:gradual-drift:default`: active interval 45–76. The baseline's first qualifying start is 57 and the candidate's is 67, preserving detection with ten seconds of added delay.
3. `17101:gradual-drift:low-short-climb`: active interval 36–59. The baseline starts at 39; the candidate first alarms at 69, during recovery. That is correctly counted as a miss.

Replay commands and the complete protocol are in [nominal-correction.md](nominal-correction.md).

## Verification

Fresh checks: source formatting, lint, typecheck, traceability, 491 TypeScript tests, 91.52% repository branch coverage, three exact replays, byte-identical cached final resume, and offline report rendering on desktop/mobile with zero serious or critical accessibility findings. Fourteen new tests cover numerical fitting, leakage, causality, paired comparisons, seed separation, provenance and failure paths.

The production `src/`, `models/`, dependency files, simulator and build/browser configurations are byte-unchanged from `d49e6bc`. The successful prior 42 Python tests, normal/offline builds, and 49 production-preview browser tests are reused on those unchanged inputs. The existing browser skip and the default dev-server hang remain documented in the original verification record. Blanket formatting still encounters two untouched personal Markdown notes; the full source formatting check passes.

All data is synthetic. There was no publication, model promotion, retraining of the registered classifier, new dependency, or paid service.
