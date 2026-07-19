# v2.2 candidate demonstration script

## Purpose

This script contains approximately two minutes of spoken narration. Allow closer to two and a half minutes when demonstrating controls at an accessible pace. Use it only after the local application loads successfully. Do not present the offline artifact or v2.2 release as complete until the remaining gates are verified.

## Accessible setup

- Turn on captions and record at 1080p or higher.
- Set browser zoom to at least 125 percent and keep text readable.
- Use keyboard navigation where practical and keep the visible focus indicator on screen.
- Narrate every status, marker, and chart change. Do not rely on color alone.
- Leave the experimental temporal model disabled at the start.
- Suggested investigation: `Cross-sensor decoupling`, seed `3101`, 180 samples.
- Suggested campaign seed: `3101`. If it does not finish promptly, demonstrate cancellation instead of waiting in silence.

## Narration and actions

### Set the boundary

**On screen:** Open the Investigation tab and focus the scenario controls.

**Say:**

"This is the v2.2 candidate for Flight Diagnostics Workbench. Everything shown is generated synthetic, unclassified, and employer-neutral. It is a software verification demonstration, not an aircraft, maintenance, certification, or safety system."

### Reproduce a fault lifecycle

**On screen:** Select Cross-sensor decoupling, enter seed 3101 and 180 samples, then activate Run investigation.

**Say:**

"A seed recreates the same mission and fault timeline. This scenario drives two redundant altitude sensors apart, then records onset, active duration, and recovery. The detector does not read those ground-truth labels. It uses observed sensor and fusion evidence."

### Show phase, fusion, and rules

**On screen:** Move the replay slider to the onset and then the first detection. Point to the phase label, observed and predicted altitude, uncertainty band, residual chart, and deterministic indication list.

**Say:**

"The phase state machine uses explicit hysteresis. The fusion estimator shows predicted, observed, and estimated state with uncertainty. Here the normalized residual and redundant-sensor disagreement create stable evidence. The rule indication is authoritative, and detection delay is measured from the declared onset."

### Explain advisory intelligence

**On screen:** Open Configuration, distinguish the v1 research-evidence-only artifact from the v2 production-integrated advisory artifact, show the current requirement result and disabled user state, then point to the v2 identity prefixes and 40-sample window. Enable experimental temporal hypotheses only if the exact build reports the v2 artifact eligible, then return to the same replay point.

**Say:**

"The optional v2 model is disabled by default. Activation requires the exact profile, schema, units, cadence, window, artifact identity, configuration identity, and unchanged requirement gate. It ranks synthetic hypotheses after a 40-sample warmup using normalized distance similarity, not calibrated probability. It can abstain as unknown, and deterministic rules always retain authority."

### State measured evidence honestly

**On screen:** Show the model evidence table or `docs/temporal-model-evidence.md`.

**Say:**

"The integrated v2 table reports counts from 440 balanced, selected 40-sample windows, one per synthetic mission. Those observations are not complete episodes, full streams, independent flights, or real-world results. I report the false-positive numerator and denominator beside its one-sided 95 percent upper bound, and I show the weakest per-fault result instead of hiding it behind aggregate F1. The separate v1 numbers are research comparisons only."

### Exercise the campaign worker

**On screen:** Open the campaign panel, enter seed 3101, and activate Run campaign. Point to progress and cancellation. If results arrive, point to F1, false alarms per run, median time to detect, abstention, and the confidence interval. Otherwise, activate Cancel campaign.

**Say:**

"The campaign evaluates one nominal case and three severity, duration, and onset-phase variants for each of ten synthetic fault families. The worker reports progress and responsive cancellation, and its evidence records replay parameters without copying source rows."

### Close

**On screen:** Return focus to the Investigation or campaign status.

**Say:**

"This remains a synthetic, unreleased candidate: reproducible evidence, explicit uncertainty, and deterministic authority."

## Presenter checklist

- Do not say "AI diagnosed the fault." Say "the advisory model ranked synthetic hypotheses."
- Do not describe the stored gate as proof of general performance.
- State the current v2 weakest-class count from the checked artifact without hiding it behind aggregate F1.
- State the v2 nominal false-positive count and one-sided 95 percent upper bound together. Do not present the point estimate as proof of a population rate.
- Keep the v1 post-hoc challenge labeled research-only and non-gating, and state its reduced onset-duration recall only in that context.
- If the model returns `unknown`, keep it in the demo. Explain that abstention is intentional.
- Verify the campaign worker and controls in the exact demo commit before recording.
- If a control, chart, export, or build is not working in the exact demo commit, stop and report it rather than narrating a planned result.
