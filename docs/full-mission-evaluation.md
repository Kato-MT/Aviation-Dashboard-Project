# Full-mission evaluation

This local research workflow measures the registered v2 advisory model over complete synthetic missions. It does not alter the model, application, existing `campaign.v1` metrics, or publication status.

## Reproduce the experiment

Use the repository's pinned pnpm 11.9.0 and Node 22.12 or newer:

```powershell
pnpm evaluate:missions --stage development
pnpm evaluate:missions --stage final
pnpm evaluate:missions --stage replay --case-id 13101:nominal:default
```

The default output is `reports/mission-evaluation/`, which is ignored by Git. Supply `--output DIRECTORY` on every invocation to use a different experiment directory. Replay defaults to the completed final report; add `--from development` for a development case. Case IDs have the form `SEED:FAULT:VARIANT` and are recorded in each report.

Development runs 1,640 missions from seeds 12101 through 12140. Final evaluation runs 3,280 missions from seeds 13101 through 13180. Each seed supplies one nominal mission, ten default faults, and thirty existing severity/duration/onset variants. Every mission contains 180 samples at 1,000 ms cadence, starting at the same fixed timestamp. The interval from first to last sample is 179 seconds.

The runner checks all stored covariance, temporal v1, temporal v1 challenge, and temporal v2 mission partitions for overlap. It verifies the registered model's exact file and canonical-configuration hashes and applies the same compatibility checks as the browser. The complete stateful Investigation path runs once per mission. Policy comparison reuses that prediction trace; it does not restart the estimator for individual windows.

## Frozen selection and resumable execution

The runner writes a source/model/protocol manifest before evaluating each stage. Complete batches of eight seeds, at most 328 missions, are checksummed and saved. Interrupted or failed work has an explicit status; incomplete batches are recomputed on resumption. Rerun the identical command to resume. A manifest, cached batch, selection, or source mismatch fails explicitly instead of mixing results. Individual evidence files are limited to 64 MiB, and the mission matrix is fixed.

Completion of development atomically writes `selection.json` with its embedded integrity digest, tying the chosen policy to the complete development report and exact source/model identities. Final evaluation requires this evidence. Once the final manifest exists, further development in that experiment directory is refused. Final evaluation scores only the original model, frozen selected policy, and deterministic reference. It never selects a new policy using final data.

Changing the experiment after observing final results requires a separately declared future experiment and genuinely fresh evaluation seeds. Renaming the output directory does not make these final seeds unseen again.

## Metrics and alert policies

- Model policies require one, two, three, or five consecutive anomalous windows. Any anomalous class contributes to the streak; changing class does not reset it. Nominal, abstained, or unavailable results reset it. The alarm begins on the confirming sample and is never backdated.
- Sample 39 is the first eligible model score. Both model and rule metrics use this shared post-warmup evaluation window. A rule alarm already active before sample 39 retains its true earlier start and cannot become an artificial new detection at sample 39. This is a shared-window reference, not a complete measure of early rule-engine detection capability.
- Active-fault recall requires a new alarm start within the inclusive declared active interval. Pre-onset alarms, recovery-only alarms, and continued alarm occupancy do not repair an active-fault miss. Temporal matching establishes coincidence with an injected fault, not causal fault diagnosis.
- All faults with eligible active samples stay in recall, including abstained and unavailable predictions. Faults ending before eligibility are explicitly unobservable. Detection-delay summaries show the detected-case denominator; policy delay differences use only cases detected by both policies.
- Nominal-mission false-alarm rate counts missions with any eligible alarm occupancy. False-alarm episode rates count new starts during nominal, pre-onset, or post-recovery exposure. Carryover is reported separately. Each point's exposure ends at the next sample; the last point has zero following exposure.
- Unavailable model samples contribute no evaluable time. A nominal mission with no available scores remains unavailable rather than a successful negative. Abstention remains visible and is not a calibrated statement of normality.
- Recovery and post-recovery alarm occupancy, active coverage, warmup, misses, and abstention are reported separately. Undefined metrics remain `null`.

Development selects the lowest nominal-mission false-alarm rate subject to at most 0.02 overall recall loss, 0.05 per-family recall loss, and 5,000 ms of nearest-rank p95 added delay. Undefined required constraints fail. Equal false-alarm rates favor the shorter streak, including the original one-window policy.

Uncertainty uses 1,000 paired percentile bootstrap resamples, RNG seed 22074, with whole mission-seed groups as resampling units. All related variants stay together. Final improvement requires the same tradeoff limits plus a candidate-minus-original nominal false-alarm interval whose upper endpoint is below zero. Otherwise the candidate is rejected or inconclusive. If development retained the original model, the result is explicitly `no-improvement`.

The balanced synthetic mission matrix does not represent operational fault prevalence. Resampling describes variation within this generator and does not account for generator misspecification, real aircraft, or deployment shift. Normalized model similarities are not calibrated probabilities.

## Reports and replay

Each completed stage produces a JSON report and an offline HTML report with embedded Chart.js plots and accessible numeric tables. The JSON contains exact per-mission intervals, aggregate counts, family and variant breakdowns, source/model identities, and the experiment decision. Source telemetry rows are not copied into ordinary reports.

Single-case replay regenerates the scenario, predictions, and scoring and checks all three against the recorded result. It exports a compact prediction trace and an HTML timeline. Default scenarios also replay through the existing Investigation controls. Parameterized variants require the CLI because the production UI has no severity/duration/onset override controls. Candidate policy overlays exist only in experimental reports.

## Verification

`tests/mission-evaluation/` covers hand-calculated interval boundaries, carry-in alarms, warmup, abstention, unavailable and missing data, zero denominators, paired clustered uncertainty, selection constraints, exact replay, truth-label independence, future-input causality, partition separation, provenance, and corrupt partial evidence. The new pure core participates in the repository coverage gate.

Run `pnpm validate` and `pnpm test:e2e` for the full local gates. Production publication and hosted CI remain separate from this local experiment.
