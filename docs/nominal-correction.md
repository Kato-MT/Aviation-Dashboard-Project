# Experimental nominal false-alarm correction

This local synthetic experiment investigates nominal alerts in registered v2. It does not change `src/`, `models/`, the model registry, app screens, package scripts, or existing mission reports. An experimental output is not eligible for production merely because it is reproducible.

The completed [results and limitations](nominal-correction-results-2026-10-28.md) record a rejected candidate, with fewer nominal alarms but unacceptable fault losses.

## Diagnosis

On the previously observed development seeds 12101–12140, 1,908 of 5,640 eligible nominal windows produced alerts. Climb accounted for 1,083, cruise for 800, and descent for 25. Sensor-lag was the most frequent false label (745 windows).

The registered model uses five nominal prototypes, fitted from 40 selected nominal windows and calibrated on 20 selected windows. It evaluates 141 windows per complete mission. Normal changing regimes are poorly represented by midpoint-only sampling. Features such as vibration freeze ratio and vertical-rate freeze ratio have a fitted scale of `1e-9`; discrete changes outside that small training sample can dominate distance. Above the nominal threshold, the integrated scorer searches only fault classes. The selected fault class radius is then the effective rejection gate because the relative-score threshold is zero.

These mechanisms are supported by observed distance contributions and source inspection. They explain why persistence did not remove the long nominal alert runs. The diagnostic script uses old development seeds only and never treats them as fresh confirmation.

## Targeted candidate

The experiment adds an offline nominal envelope before presenting an existing anomalous or abstained decision. It fits one centroid for each eligible window end, across 40 nominal fitting missions. Inference searches all 141 centroids without accessing seed, truth, scenario identity, true phase, or elapsed-time position.

For each feature, the envelope scale is the maximum of the registered scale, full-stream nominal population standard deviation, and one discrete resolution step for freeze/missing fractions (`1/39`, `1/40`). It uses the same stateful observed-only Investigation projection and encoder. A window inside the envelope becomes nominal. Otherwise it retains the registered model decision. Warmup, unavailability and deterministic rules remain unchanged.

Calibration considers exactly three preregistered thresholds: nearest-rank p95/p99 of all nominal window distances, and p95 of per-mission maximum distances. No fault examples train the envelope. This is a conservative normality correction, not a retrained fault classifier or a newly validated production model.

## Partitions and acceptance

| Partition   | Seeds       | Purpose                                        |
| ----------- | ----------- | ---------------------------------------------- |
| Fit         | 14101–14140 | Nominal centroids and scale                    |
| Calibration | 15101–15140 | Nominal threshold grid                         |
| Development | 16101–16140 | 1,640 missions; candidate selection            |
| Final       | 17101–17180 | 3,280 untouched missions; one frozen candidate |

All partitions are mutually disjoint and explicitly exclude registered training/calibration/evaluation seeds plus both partitions of the previous full-mission sprint. Each development/final seed has the existing 41-case matrix, 180 samples and 1-second cadence. Related variants stay together in 1,000 paired seed bootstrap resamples.

The acceptance limits remain an overall active-fault recall loss of at most two percentage points, each family's loss at most five points, and paired p95 added delay at most five seconds. A claimed improvement also needs a negative upper bound on the paired nominal false-alarm-rate delta interval. Undefined metrics fail acceptance. A new alert must start inside the inclusive active interval to count; recovery-only and carried-in alerts cannot repair misses.

Select the lowest nominal-mission alarm rate among candidates passing the limits, then highest recall, then smallest threshold. If all fail, freeze the lowest-alarm candidate as rejected and confirm its tradeoff on final seeds. A failed development candidate cannot become an accepted improvement from final results. No final-data tuning is allowed.

## Commands

From the repository root with pinned pnpm 11.9.0:

```powershell
pnpm exec tsx tools/nominal-correction/diagnose.ts
pnpm exec tsx tools/nominal-correction/run.ts --stage fit --output reports/nominal-correction-v1
pnpm exec tsx tools/nominal-correction/run.ts --stage development --output reports/nominal-correction-v1
pnpm exec tsx tools/nominal-correction/run.ts --stage final --output reports/nominal-correction-v1
pnpm exec tsx tools/nominal-correction/run.ts --stage replay --output reports/nominal-correction-v1 --case-id 17101:nominal:default
```

For a clean reproduction, use a different output directory with the same frozen source. Repeating seeds is reproducibility, not additional independent evidence. Final runs resume verified eight-seed batches and reproduce identical per-mission and report hashes. Development cannot restart after selection is frozen. Source changes require a new directory; never replace the frozen manifest to bypass validation.

Outputs include protocol/source hashes, an envelope checksum, frozen selection, per-case scenario and prediction hashes, paired metrics, rule metrics, complete/failed status, HTML reports, and exact replay JSON/HTML. Previous full-mission artifacts keep their existing meanings.

## Verification and limits

`TC-NC-001` through `TC-NC-014` cover numerical fixtures, finite scaling, truth/future independence, model immutability, paired comparisons, seed exclusions, exact replay, checksum failure, source drift, and freeze enforcement. Repository checks and report browser evidence are recorded with the delivered results.

No package or runtime dependency changes are needed. Existing production browser/build/Python evidence remains reusable while its inputs are unchanged. Report rendering is checked separately. The experiment does not establish real-aircraft performance, certification, calibrated probabilities, or generalization to a different mission generator.
