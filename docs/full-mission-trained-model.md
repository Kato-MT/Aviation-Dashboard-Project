# Full-mission supervised model experiment

This experiment replaces the underlying experimental detector, rather than adding a broad nominal suppression gate to registered v2. The production app, registered model, deterministic rules, and earlier reports remain unchanged.

## Frozen design

| Partition   | Seeds       | Missions | Use                                          |
| ----------- | ----------- | -------- | -------------------------------------------- |
| Fit         | 18101–18160 | 2,460    | Fit preprocessing and supervised classifiers |
| Calibration | 19101–19140 | 1,640    | Derive nominal mission maximum thresholds    |
| Development | 20101–20140 | 1,640    | Select a model and threshold                 |
| Final       | 21101–21180 | 3,280    | Test the frozen candidate                    |

All partitions exclude the registered models' historical seeds and both completed full-mission experiments. Each seed retains the same nominal mission, ten default faults and thirty existing variants. Every mission has 180 samples at one-second cadence. Every eligible endpoint, 39 through 179, enters the corpus. The 39-sample warmup remains explicit.

The training label is positive from declared onset through inclusive recovery end. Nominal, pre-onset and post-recovery endpoints are negative. This target uses truth only for supervision. Each mission/target-class group receives equal total weight, followed by global binary-class balancing. The detector outputs binary fault presence, not fault-family classification.

The candidate uses 72 causal observed features: the existing 51, twelve redundant-sensor disagreement summaries, fuel flow and quantity change, raw altitude range, recent vibration variation, and raw speed-pair lag summaries. It does not receive seed, fault family, truth, quality labels, phase truth, absolute sample index, or a nominal-control trajectory. The stateful Investigation projection initializes once per mission. Missingness remains explicit.

Preprocessing is fitted only on fitting data. It centers at the training median, uses the maximum of IQR/1.349, one tenth of population standard deviation and a documented resolution floor, masks features constant in training, and clips transformed values at ±50. This avoids the original `1e-9` scale amplification. Calibration and evaluation never refit these values.

Two fixed algorithms are compared: L2 logistic regression and a 64-tree random forest limited to depth18, leaf size5 and two worker threads. Their parameters are in `tools/full-mission-model/protocol.ts`. Candidate thresholds are 0.5 and the nearest-rank p50, p90, p95 and maximum of complete calibration nominal-mission maxima, with duplicates removed. A score must be strictly greater than the threshold to alarm. The score is not claimed to be an operationally calibrated probability.

The fitted artifact is portable JSON containing centers, scales, masks, linear coefficients, tree arrays, threshold grids, training provenance and cross-runtime parity cases. TypeScript inference validates the artifact and reproduces Python's float32 tree-routing contract. No untrusted pickle loading or production registration is involved.

## Fault-specific detection

Conventional active-interval recall remains unchanged. A credited conventional detection requires a new alert to begin during the inclusive active fault interval. Carried-in and recovery-only alerts cannot repair misses.

The additional **confirmed fault-specific detection** requires a new active fault-run alert and three consecutive active samples with the fault run alarming while its independently scored same-seed nominal control is explicitly nominal. Its timestamp is the third sample. There is no backdating. If the control alarms, abstains or is unavailable before confirmation, that entire alert episode is disqualified; later control clearing cannot manufacture a detection. A later new fault-run episode may qualify. A confirmed detection is not retrospectively revoked by later observations.

The same nominal control is shared by its forty related fault variants. The evaluator verifies alignment, and bootstrap resamples retain the whole seed cluster. All originally observable faults remain in the denominator, including short active intervals that cannot complete confirmation. Unknown control output never proves normality. Reports include misses, reasons, fault-only/control-only/both-alarm sample counts, delay, recovery persistence and abstention.

This measures responsiveness to a controlled synthetic injection. It does not establish correct fault-family diagnosis, causal attribution in uncontrolled real data, or aircraft suitability.

## Acceptance

Both sets of gates must pass:

- Conventional active recall may lose at most two percentage points overall and five points in any family. Paired p95 added conventional delay must be at most five seconds.
- Confirmed fault-specific recall must improve by at least five points, with a positive lower bound in its paired95% interval. No family's fault-specific recall may lose more than five points. Paired p95 added specific delay must be at most five seconds; its matched-case count is reported and undefined evidence fails.
- The paired95% interval for candidate-minus-original nominal-mission false-alarm rate must lie strictly below zero.

All intervals use 1,000 paired seed-cluster bootstrap resamples. Among passing candidates, selection minimizes nominal alarms, then maximizes specific recall and conventional recall, then prefers the linear model and lower threshold. If none passes, the best specific-recall candidate that reduces nominal alarms is frozen as rejected for confirmation. Final results cannot rescue a candidate that already failed development, and cannot be used for another tuning cycle.

## Commands

Create a local Python environment and install the pinned experimental requirements. The production Node/Python environment does not require these new dependencies.

```powershell
python -m venv .tmp-tests/full-mission-venv
.tmp-tests/full-mission-venv/Scripts/python.exe -m pip install -r tools/full-mission-model/requirements.txt
pnpm exec tsx tools/full-mission-model/run.ts --stage train --output reports/full-mission-model-v1 --python .tmp-tests/full-mission-venv/Scripts/python.exe
pnpm exec tsx tools/full-mission-model/run.ts --stage development --output reports/full-mission-model-v1
pnpm exec tsx tools/full-mission-refinement/run.ts --stage development --parent reports/full-mission-model-v1 --output reports/full-mission-refinement-v2
pnpm exec tsx tools/full-mission-refinement/run.ts --stage final --parent reports/full-mission-model-v1 --output reports/full-mission-refinement-v2
pnpm exec tsx tools/full-mission-refinement/run.ts --stage replay --parent reports/full-mission-model-v1 --output reports/full-mission-refinement-v2 --case-id 21101:nominal:default
.tmp-tests/full-mission-venv/Scripts/python.exe -m unittest discover -s tests/full-mission-model -p "test_*.py"
```

Use Python3.12 and pnpm11.9.0. Commands are local and synthetic. Fitting/calibration features are stored in bounded little-endian float64 batches with checksums. Development/final reports reference complete checksummed per-mission batches. A stopped run resumes only verified matching batches. After freezing selection, training/development cannot restart. Source changes require a new output directory, not a rewritten manifest.

For a clean reproduction, use a new output directory at the same source. Repeating the same seeds is a reproducibility check, not fresh statistical evidence. Corpus binary files need not be distributed with a demonstration because the exact generator, cases, features and checksums reconstruct them.

## Recorded development refinement

The original calibration-derived grid selected the forest at threshold `0.6322699583395381`. It passed the relative acceptance limits, but 19 of 40 nominal development missions still alarmed. Higher calibration thresholds reduced alarms further but lost too much sensor-lag recall. This finding motivated an additional, explicitly development-guided threshold/persistence search. It was not part of the initial preregistered grid.

The trained weights, scaling, features and acceptance limits remained frozen. The sibling `tools/full-mission-refinement` runner tested thresholds 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.925, 0.95 and 0.975 with streaks of 1, 2, 3 and 5, plus the exact previous passing setting. Both ordinary and fault-specific evaluation use the same filtered alert stream, including independently filtered nominal controls. Pending streak samples mean no alert yet; they do not establish that a raw score was low.

Selection among passing settings minimizes nominal alarms, then prefers a shorter streak, higher specific recall, higher ordinary recall and a lower threshold. All 49 settings use development seeds 20101–20140. Their intervals are selection evidence, not independent confirmation. Final seeds 21101–21180 were first opened only after the selected threshold 0.80 and streak 1 were frozen. No setting was changed based on final results.

The partial refinement-v1 run was interrupted to strengthen the parent-final-access resume guard. Its incomplete evidence was retained, and the finalized source ran in a new `full-mission-refinement-v2` directory. The original trained artifact and its initial development report are preserved byte-for-byte. Each stage checks both the parent training identity and the sibling refinement identity.

## Known limitations and method references

The generator has a fixed mission profile. Standard-cruise lag produces a weak speed-pair shift relative to noise. Its implementation also repeats previously observed noisy readings at onset. No exact-repeat feature was added to exploit that artifact. Results must preserve this weak-signal case and must not claim general lag detection from a synthetic benchmark alone.

The algorithm's documented parameters and tree contracts are described in the official [scikit-learn random forest documentation](https://scikit-learn.org/1.7/modules/generated/sklearn.ensemble.RandomForestClassifier.html). Median/quantile-based preprocessing is described in [RobustScaler](https://scikit-learn.org/1.7/modules/generated/sklearn.preprocessing.RobustScaler.html); this experiment additionally defines its own scale floors, constant mask and clipping, all stored in the artifact.
