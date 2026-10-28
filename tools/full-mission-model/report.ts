import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { REPOSITORY_ROOT } from '../mission-evaluation/protocol';
import { escapeHtml as esc } from '../mission-evaluation/report';
import type { Artifact } from './model';
import type { Report, Setting, inferCase } from './run';

const pct = (v: number | null) => (v === null ? 'undefined' : `${(v * 100).toFixed(2)}%`);
const num = (v: number | null) =>
  v === null ? 'undefined' : v.toLocaleString('en-US', { maximumFractionDigits: 2 });
const json = (v: unknown) => JSON.stringify(v).replaceAll('<', '\\u003c');
const style = `:root{font-family:Arial,sans-serif;color:#172e3c;background:#eef3f6}*{box-sizing:border-box}body{margin:0}main{max-width:1220px;margin:auto;padding:32px 24px}h1{font-size:38px;letter-spacing:-1px}h2{font-size:23px}p,li{line-height:1.65}p{max-width:90ch}section,.card{background:white;border:1px solid #c8d5df;border-radius:12px;padding:24px;margin:18px 0}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.grid>div{min-width:0}.chart{height:340px;position:relative}.table{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{padding:11px;text-align:left;border-bottom:1px solid #dce3e8}th{background:#eff4f6}code{overflow-wrap:anywhere}a{color:#075b96}.small{font-size:13px;color:#445b68}.eyebrow{font-size:12px;letter-spacing:2px;font-weight:bold;color:#225b72}.decision{font-size:22px;font-weight:bold}canvas{max-width:100%}@media(max-width:650px){main{padding:18px 12px}h1{font-size:29px}.grid{grid-template-columns:1fr}section,.card{padding:16px}}`;
async function document(title: string, body: string, script: string, path: string) {
  const chart = await readFile(
    resolve(REPOSITORY_ROOT, 'node_modules/chart.js/dist/chart.umd.js'),
    'utf8',
  );
  await writeFile(
    path,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${style}</style></head><body><main>${body}</main><script>${chart}</script><script>Chart.defaults.animation=false;${script}</script></body></html>`,
  );
}
function table(headers: string[], rows: (string | number | null)[][]) {
  return `<div class="table"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell, i) => `<${i ? 'td' : 'th'}>${esc(String(cell ?? 'undefined'))}</${i ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

export async function writeReport(report: Report, artifact: Artifact, path: string) {
  const comparison = report.comparisons.find((c) => c.setting.id === report.selectedId)!;
  const a = comparison.ordinary.baseline,
    b = comparison.ordinary.candidate,
    sa = comparison.specific.baseline,
    sb = comparison.specific.candidate;
  const families = Object.keys(sa.byFamily);
  const body = `<div class="eyebrow">FLIGHT DIAGNOSTICS · FULL-MISSION SUPERVISED TRAINING · SYNTHETIC ONLY</div><h1>Does the detector respond to the fault?</h1><p>${report.stage === 'final' ? 'Fresh final evaluation' : 'Development selection'} · ${report.missions} missions · ${a.nominalMissions} seeds · 180 samples at one-second cadence</p>
  <section><div class="decision">${report.stage === 'final' ? 'Final decision' : 'Development decision'}: ${esc(comparison.decision)}</div><p>Candidate <strong>${esc(comparison.setting.id)}</strong>, threshold ${comparison.setting.threshold.toPrecision(6)}. Nominal missions with false alarms: <strong>${a.nominalFalseAlarmMissions}/${a.nominalEvaluableMissions} → ${b.nominalFalseAlarmMissions}/${b.nominalEvaluableMissions}</strong>. Conventional active-fault recall: <strong>${pct(a.activeRecall)} → ${pct(b.activeRecall)}</strong>. Confirmed fault-specific recall: <strong>${pct(sa.recall)} → ${pct(sb.recall)}</strong>.</p><p>${comparison.reasons.length ? esc(comparison.reasons.join(' ')) : 'All preregistered conventional and fault-specific gates pass.'}</p><p>The production app, registered v2 artifact, and deterministic rules remain unchanged. This is an experimental binary fault-presence model; it does not identify a fault family.</p></section>
  <div class="grid"><div class="card"><h2>Nominal false alarms</h2><div class="chart"><canvas id="nominal" role="img" aria-label="Nominal mission false-alarm rates. Exact counts follow."></canvas></div></div><div class="card"><h2>Detection versus fault specificity</h2><div class="chart"><canvas id="recall" role="img" aria-label="Conventional and confirmed fault-specific recall. Exact metrics follow."></canvas></div></div></div>
  <section><h2>What changed in the model</h2><p>Training uses every eligible window from ${artifact.fitSummary.missions} complete missions, totaling ${artifact.fitSummary.windows.toLocaleString('en-US')} windows. It includes nominal, onset, active, recovery, and post-recovery observations. Supervision marks declared fault presence through recovery; evaluation still requires a new alert during the active interval.</p><p>The ${artifact.featureNames.length} observed features retain the existing causal encoder and add redundant-sensor disagreements, fuel flow, recent raw-sensor variability, and speed-pair lag summaries. No truth, quality labels, time index, seed or matched control enters inference. Scaling is fitted only on training data, uses median and dispersion with finite resolution floors, masks ${artifact.fitSummary.constantFeatureCount} constant features, and clips standardized values at ±50. Minimum scale: ${num(artifact.fitSummary.minimumScale)}.</p><p>A linear classifier and a bounded random forest were trained with balanced mission/class contributions. Calibration derives thresholds from complete nominal-mission maxima. Development selects the model and threshold before final seeds are accessed. Scores are not calibrated operational probabilities.</p></section>
  <section><h2>Fault specificity has a stricter definition</h2><p>A new alert must begin during the declared active interval and stay alarming for three consecutive samples while the same-seed nominal control is explicitly clear at all three. Detection is timestamped at the third sample. A coincident, abstained or unavailable control at the start disqualifies the entire episode; later control clearing cannot manufacture a detection.</p><p>Controls are scored independently and used only by the evaluator. All observable faults remain in the denominator, including misses and intervals too short for confirmation. This tests controlled synthetic responsiveness to injected faults, not correct fault-family diagnosis or real-aircraft generalization.</p></section>
  <section><h2>Matched results</h2>${table(
    ['Metric', 'Registered v2', 'Trained candidate', 'Deterministic rules'],
    [
      [
        'Nominal missions with alarms',
        `${a.nominalFalseAlarmMissions}/${a.nominalEvaluableMissions}`,
        `${b.nominalFalseAlarmMissions}/${b.nominalEvaluableMissions}`,
        `${report.rules.nominalFalseAlarmMissions}/${report.rules.nominalEvaluableMissions}`,
      ],
      [
        'Conventional active detections',
        `${a.detectedFaultMissions}/${a.observableFaultMissions}`,
        `${b.detectedFaultMissions}/${b.observableFaultMissions}`,
        `${report.rules.detectedFaultMissions}/${report.rules.observableFaultMissions}`,
      ],
      [
        'Conventional misses',
        a.missedFaultMissions,
        b.missedFaultMissions,
        report.rules.missedFaultMissions,
      ],
      [
        'Confirmed fault-specific detections',
        `${sa.detected}/${sa.observable}`,
        `${sb.detected}/${sb.observable}`,
        'Not used for learned-model acceptance',
      ],
      ['Confirmed fault-specific misses', sa.missed, sb.missed, 'See ordinary rule reference'],
      [
        'False-alarm episodes',
        a.falseAlarmEpisodes,
        b.falseAlarmEpisodes,
        report.rules.falseAlarmEpisodes,
      ],
      [
        'Conventional delay p95 (ms)',
        a.detectionDelayMs.p95,
        b.detectionDelayMs.p95,
        report.rules.detectionDelayMs.p95,
      ],
      ['Fault-specific delay p95 (ms)', sa.p95DelayMs, sb.p95DelayMs, 'Not compared'],
      [
        'Abstention',
        pct(a.abstentionFraction),
        pct(b.abstentionFraction),
        pct(report.rules.abstentionFraction),
      ],
      [
        'Unavailable samples',
        a.unavailableSamples,
        b.unavailableSamples,
        report.rules.unavailableSamples,
      ],
      [
        'Recovery alarm seconds',
        a.recoveryAlarmMs / 1000,
        b.recoveryAlarmMs / 1000,
        report.rules.recoveryAlarmMs / 1000,
      ],
      [
        'Post-recovery carryover seconds',
        a.carryoverAfterRecoveryMs / 1000,
        b.carryoverAfterRecoveryMs / 1000,
        report.rules.carryoverAfterRecoveryMs / 1000,
      ],
      ['Warmup samples', a.warmupSamples, b.warmupSamples, report.rules.warmupSamples],
      [
        'Unobservable faults',
        a.unobservableFaultMissions,
        b.unobservableFaultMissions,
        report.rules.unobservableFaultMissions,
      ],
    ],
  )}</section>
  <section><h2>Acceptance and uncertainty</h2><p>1,000 paired bootstrap resamples keep each seed's nominal control and all 40 fault variants together. Conventional recall loss must be ≤2 percentage points overall and ≤5 points per family; paired p95 added delay must be ≤5 seconds. Fault-specific recall must gain at least five points with a positive lower confidence bound, no family may lose more than five points, and paired p95 added specific delay must be ≤5 seconds. Nominal false-alarm reduction needs a negative upper confidence bound.</p>${table(
    ['Evidence', 'Result'],
    [
      [
        'Nominal false-alarm-rate delta95% CI',
        `${pct(comparison.ordinary.confidence.nominalFalseAlarmRateDelta!.lower)} to ${pct(comparison.ordinary.confidence.nominalFalseAlarmRateDelta!.upper)}`,
      ],
      [
        'Conventional recall delta95% CI',
        `${pct(comparison.ordinary.confidence.activeRecallDelta!.lower)} to ${pct(comparison.ordinary.confidence.activeRecallDelta!.upper)}`,
      ],
      [
        'Fault-specific recall gain95% CI',
        `${pct(comparison.specific.recallGainInterval.lower)} to ${pct(comparison.specific.recallGainInterval.upper)}`,
      ],
      [
        'Paired conventional p95 added delay',
        `${num(comparison.ordinary.constraints.pairedP95AddedDelayMs)} ms; ${comparison.ordinary.constraints.pairedDetections} matched detections`,
      ],
      [
        'Paired fault-specific p95 added delay',
        `${num(comparison.specific.p95AddedDelayMs)} ms; ${comparison.specific.pairedDetections} matched detections`,
      ],
    ],
  )}<p class="small">Delay comparisons include only jointly detected cases. Misses and family results remain essential. Zero observed nominal alarms does not prove zero future risk. If there are zero alarms among ${b.nominalEvaluableMissions} nominal missions, the one-sided exact95% population-rate upper bound is ${pct(1 - Math.pow(0.05, 1 / b.nominalEvaluableMissions))}.</p></section>
  <section><h2>Fault-family weaknesses</h2>${table(
    [
      'Family',
      'Original active recall',
      'Candidate active recall',
      'Original specific recall',
      'Candidate specific recall',
    ],
    families.map((f) => [
      f,
      pct(a.byFamily[f]!.activeRecall),
      pct(b.byFamily[f]!.activeRecall),
      pct(sa.byFamily[f]!.recall),
      pct(sb.byFamily[f]!.recall),
    ]),
  )}<h3>Scenario variants</h3>${table(
    ['Variant', 'Original active recall', 'Candidate active recall', 'Candidate specific recall'],
    Object.keys(sb.byVariant).map((v) => [
      v,
      pct(a.byVariant[v]!.activeRecall),
      pct(b.byVariant[v]!.activeRecall),
      pct(sb.byVariant[v]!.recall),
    ]),
  )}<p>Standard-cruise lag has a weaker signal than climb lag. The model does not include an exact-repeat feature to exploit the generator's replayed-noise onset artifact. This benchmark uses one synthetic mission profile and fixed duration; these limitations remain even if acceptance passes.</p></section>
  <section><h2>Candidate selection</h2>${table(
    ['Candidate', 'Threshold', 'Nominal alarms', 'Active recall', 'Specific recall', 'Decision'],
    report.comparisons.map((c) => [
      c.setting.id,
      c.setting.threshold.toPrecision(5),
      `${c.ordinary.candidate.nominalFalseAlarmMissions}/${c.ordinary.candidate.nominalMissions}`,
      pct(c.ordinary.candidate.activeRecall),
      pct(c.specific.candidate.recall),
      c.decision,
    ]),
  )}<p>The complete development grid is in the development report. A candidate rejected during development cannot be accepted using final results.</p></section>
  <section><h2>Reproduce and inspect</h2><p><a href="report.json">Machine-readable report</a> · <a href="../model.json">Portable fitted model</a> · <a href="../manifest.json">Protocol and source identity</a> · <a href="../selection.json">Frozen selection</a></p><p>Per-mission results and matched-control outcomes are stored in checksummed batch files referenced by report.json. The original campaign and earlier experiment reports retain their meanings.</p><p class="small">Source SHA-256: <code>${report.sourceSha256}</code><br>Model SHA-256: <code>${report.modelSha256}</code><br>Report SHA-256: <code>${report.contentSha256}</code></p></section>`;
  const script = `new Chart(document.getElementById('nominal'),{type:'bar',data:{labels:['Registered v2','Trained candidate','Rules'],datasets:[{label:'Nominal mission false-alarm rate (%)',data:${json([a.nominalFalseAlarmRate, b.nominalFalseAlarmRate, report.rules.nominalFalseAlarmRate].map((v) => (v ?? 0) * 100))},backgroundColor:['#365b7a','#007c70','#90632e']}]},options:{maintainAspectRatio:false,scales:{y:{min:0,max:100}},plugins:{legend:{display:false}}}});new Chart(document.getElementById('recall'),{type:'bar',data:{labels:['Conventional active recall','Confirmed fault-specific recall'],datasets:[{label:'Registered v2',data:${json([a.activeRecall, sa.recall].map((v) => (v ?? 0) * 100))},backgroundColor:'#365b7a'},{label:'Trained candidate',data:${json([b.activeRecall, sb.recall].map((v) => (v ?? 0) * 100))},backgroundColor:'#007c70'}]},options:{maintainAspectRatio:false,scales:{y:{min:0,max:100}}}});`;
  await document('Full-mission trained model evaluation', body, script, path);
}

export async function writeReplay(
  replay: {
    exactMatch: boolean;
    reportSha256: string;
    setting: Setting;
    result: ReturnType<typeof inferCase>;
    control: ReturnType<typeof inferCase>;
  },
  path: string,
) {
  const r = replay.result,
    c = replay.control,
    id = replay.setting.id,
    t = r.record.baseline.faultTimeline;
  const body = `<div class="eyebrow">EXACT MODEL AND MATCHED-CONTROL REPLAY</div><h1>${esc(r.record.spec.caseId)}</h1><p>Candidate ${esc(id)}, threshold ${replay.setting.threshold.toPrecision(6)}. ${t ? `Active interval${t.onsetIndex}–${t.activeEndIndex}; recovery ends${t.recoveryEndIndex}.` : 'Nominal mission.'}</p><section><div class="chart"><canvas id="scores" role="img" aria-label="Candidate scores for fault and nominal-control missions, and frozen threshold."></canvas></div></section><section><h2>Alert decisions</h2>${table(
    ['Sample', 'Registered', 'Candidate', 'Candidate nominal control'],
    r.baselinePredictions.map((p, i) => [
      i,
      p.modelState,
      r.predictions[id]![i]!.modelState,
      c.predictions[id]![i]!.modelState,
    ]),
  )}<p>Full observed traces and hashes are saved in the JSON beside this file. Controls are evaluation-only.</p></section>`;
  const scores = r.scores[replay.setting.modelId]!,
    controls = c.scores[replay.setting.modelId]!;
  const script = `new Chart(document.getElementById('scores'),{type:'line',data:{labels:${json(scores.map((_, i) => i + 39))},datasets:[{label:'Fault-run score',data:${json(scores)},borderColor:'#365b7a',pointRadius:0},{label:'Nominal-control score',data:${json(controls)},borderColor:'#007c70',pointRadius:0},{label:'Frozen threshold',data:${json(scores.map(() => replay.setting.threshold))},borderColor:'#9b591b',borderDash:[4,4],pointRadius:0},{label:'Active fault truth',data:${json(scores.map((_, i) => (t && i + 39 >= t.onsetIndex && i + 39 <= t.activeEndIndex ? 1 : 0)))},borderColor:'#6f507c',borderDash:[2,5],pointRadius:0,stepped:true}]},options:{maintainAspectRatio:false,scales:{y:{min:0,max:1},x:{title:{display:true,text:'Elapsed seconds'}}}}});`;
  await document(r.record.spec.caseId, body, script, path);
}
