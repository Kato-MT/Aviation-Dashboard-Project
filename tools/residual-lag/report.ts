import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { REPOSITORY_ROOT } from '../mission-evaluation/protocol';
import { escapeHtml as esc } from '../mission-evaluation/report';
import type { Inference, RecordResult, Setting } from './evaluate';
import type { Report } from './run';

const pct = (v: number | null) => (v === null ? 'undefined' : `${(100 * v).toFixed(2)}%`);
const pair = (n: number, d: number) => `${n}/${d}`;
const interval = (v: { lower: number | null; upper: number | null }) =>
  `${pct(v.lower)} to ${pct(v.upper)}`;
const json = (v: unknown) => JSON.stringify(v).replaceAll('<', '\\u003c');
function table(headers: string[], rows: (string | number | null)[][]) {
  return `<div class="scroll"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((x, i) => `<${i ? 'td' : 'th'}>${esc(String(x ?? 'undefined'))}</${i ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
async function document(title: string, body: string, script: string, path: string) {
  const chart = await readFile(
    resolve(REPOSITORY_ROOT, 'node_modules/chart.js/dist/chart.umd.js'),
    'utf8',
  );
  await writeFile(
    path,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>:root{font-family:Arial,sans-serif;color:#19323e;background:#edf3f6}*{box-sizing:border-box}body{margin:0}main{max-width:1240px;margin:auto;padding:30px 24px}h1{font-size:36px;letter-spacing:-.8px}h2{font-size:23px}p,li{line-height:1.65}section,.card{background:#fff;border:1px solid #c6d4dd;border-radius:12px;margin:18px 0;padding:24px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.grid>div{min-width:0}.chart{height:330px;position:relative}canvas{max-width:100%}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:10px;border-bottom:1px solid #d5e0e5}th{background:#eef3f5}a{color:#075b91}code{overflow-wrap:anywhere}.eyebrow{font-size:12px;font-weight:bold;letter-spacing:1.8px;color:#346376}.decision{font-size:22px;font-weight:bold}.small{font-size:13px;color:#415b67}@media(max-width:650px){main{padding:18px 12px}h1{font-size:29px}.grid{grid-template-columns:1fr}section,.card{padding:16px}}</style></head><body><main>${body}</main><script>${chart}</script><script>Chart.defaults.animation=false;${script}</script></body></html>`,
  );
}
export async function writeReport(report: Report, records: readonly RecordResult[], path: string) {
  const c = report.comparisons.find((x) => x.setting.id === report.selectedId)!,
    a = c.ordinary.baseline,
    b = c.ordinary.candidate,
    s = c.confirmed,
    ab = report.ablation;
  const primary = records.filter((r) => r.spec.stream === 'primary' && r.spec.family !== 'nominal');
  const groupRows = [...new Set(primary.map((r) => `${r.spec.family}|${r.spec.variantId}`))]
    .sort()
    .map((key) => {
      const [family, variant] = key.split('|'),
        rows = primary.filter((r) => r.spec.family === family && r.spec.variantId === variant);
      return [
        family!,
        variant!,
        pair(
          rows.filter((r) => r.evaluations.incumbent!.policies['model-k1']!.activeDetected).length,
          rows.length,
        ),
        pair(
          rows.filter((r) => r.evaluations[c.setting.id]!.policies['model-k1']!.activeDetected)
            .length,
          rows.length,
        ),
        pair(rows.filter((r) => r.specific.incumbent!.detected).length, rows.length),
        pair(rows.filter((r) => r.specific[c.setting.id]!.detected).length, rows.length),
      ];
    });
  const body = `<div class="eyebrow">FLIGHT DIAGNOSTICS · SYNTHETIC RESEARCH · PRODUCTION UNCHANGED</div><h1>Residual alarms and cruise lag</h1><p>${report.stage === 'final' ? 'Fresh final evaluation' : 'Development selection'}: ${report.primaryMissions} primary missions and ${report.challengeMissions} separate current-noise challenges. Each mission has180 one-second samples.</p>
  <section><div class="decision">${report.stage === 'final' ? 'Final' : 'Development'} decision: ${esc(c.decision)}</div><p>Targeted candidate <strong>${esc(c.setting.id)}</strong>, threshold ${c.setting.threshold.toPrecision(6)}. Nominal missions with alerts: <strong>${pair(a.nominalFalseAlarmMissions, a.nominalEvaluableMissions)} → ${pair(b.nominalFalseAlarmMissions, b.nominalEvaluableMissions)}</strong>. Confirmed cruise-lag responses: <strong>${pair(c.cruise.baseline.detected, c.cruise.baseline.observable)} → ${pair(c.cruise.candidate.detected, c.cruise.candidate.observable)}</strong>.</p><p>${c.reasons.length ? esc(c.reasons.join(' ')) : 'All frozen improvement and preservation gates pass.'}</p><p>The comparator is the previous full-mission forest at0.80. The registered v2 model and deterministic rules are separate references. This experiment does not change production, diagnose fault families, or establish real-aircraft performance.</p></section>
  <div class="grid"><div class="card"><h2>Nominal missions with alerts</h2><div class="chart"><canvas id="nominal" role="img" aria-label="Nominal mission alarm rates; exact counts follow."></canvas></div></div><div class="card"><h2>Confirmed cruise-lag responses</h2><div class="chart"><canvas id="cruise" role="img" aria-label="Confirmed cruise-lag rates for primary and current-noise challenges; exact counts follow."></canvas></div></div></div>
  <section><h2>What the targeted fix tests</h2><p>Short sensor-disagreement noise clusters caused most remaining nominal episodes. The candidate retains five-sample summaries and adds fifteen-sample mean, RMS and missingness for altitude, speed and vertical-rate sensor pairs. It replaces the old raw lag-offset search with signed evidence comparing contemporaneous and three-sample-delayed GPS references on identical timestamps.</p><p>Seven-point GPS smoothing stays wholly inside the current40-sample window. Its three-sample reporting lag is included in detection delay. Missing support is explicit. Neither truth, true phase, seed, absolute time index, future readings nor the nominal control enters inference.</p><p>Both forests use the same fresh fitting missions, weighting, robust scale floors and fixed64-tree configuration. The control retains72 features; the targeted model uses81 of the shared83 columns. Training covers all eligible endpoints, including full-stream negatives and declared recovery. Scores are not operational probabilities.</p></section>
  <section><h2>Primary full-mission results</h2>${table(
    ['Metric', 'Registered v2', 'Previous forest', 'Targeted candidate', 'Rules'],
    [
      [
        'Nominal missions with alarms',
        pair(
          report.registered.nominalFalseAlarmMissions,
          report.registered.nominalEvaluableMissions,
        ),
        pair(a.nominalFalseAlarmMissions, a.nominalEvaluableMissions),
        pair(b.nominalFalseAlarmMissions, b.nominalEvaluableMissions),
        pair(report.rules.nominalFalseAlarmMissions, report.rules.nominalEvaluableMissions),
      ],
      [
        'Active-fault detections',
        pair(report.registered.detectedFaultMissions, report.registered.observableFaultMissions),
        pair(a.detectedFaultMissions, a.observableFaultMissions),
        pair(b.detectedFaultMissions, b.observableFaultMissions),
        pair(report.rules.detectedFaultMissions, report.rules.observableFaultMissions),
      ],
      [
        'Active misses',
        report.registered.missedFaultMissions,
        a.missedFaultMissions,
        b.missedFaultMissions,
        report.rules.missedFaultMissions,
      ],
      [
        'Confirmed fault-specific responses',
        'Separate reference',
        pair(s.baseline.detected, s.baseline.observable),
        pair(s.candidate.detected, s.candidate.observable),
        'Separate reference',
      ],
      [
        'False-alarm episodes',
        report.registered.falseAlarmEpisodes,
        a.falseAlarmEpisodes,
        b.falseAlarmEpisodes,
        report.rules.falseAlarmEpisodes,
      ],
      [
        'Nominal-only alarm episodes',
        report.registered.byFamily.nominal!.falseAlarmEpisodes,
        a.byFamily.nominal!.falseAlarmEpisodes,
        b.byFamily.nominal!.falseAlarmEpisodes,
        report.rules.byFamily.nominal!.falseAlarmEpisodes,
      ],
      [
        'Detection-delay p95 (ms)',
        report.registered.detectionDelayMs.p95,
        a.detectionDelayMs.p95,
        b.detectionDelayMs.p95,
        report.rules.detectionDelayMs.p95,
      ],
      [
        'Recovery alarm seconds',
        report.registered.recoveryAlarmMs / 1000,
        a.recoveryAlarmMs / 1000,
        b.recoveryAlarmMs / 1000,
        report.rules.recoveryAlarmMs / 1000,
      ],
      [
        'Post-recovery carryover seconds',
        report.registered.carryoverAfterRecoveryMs / 1000,
        a.carryoverAfterRecoveryMs / 1000,
        b.carryoverAfterRecoveryMs / 1000,
        report.rules.carryoverAfterRecoveryMs / 1000,
      ],
      [
        'Abstention',
        pct(report.registered.abstentionFraction),
        pct(a.abstentionFraction),
        pct(b.abstentionFraction),
        pct(report.rules.abstentionFraction),
      ],
      [
        'Unavailable samples',
        report.registered.unavailableSamples,
        a.unavailableSamples,
        b.unavailableSamples,
        report.rules.unavailableSamples,
      ],
      [
        'Warmup samples',
        report.registered.warmupSamples,
        a.warmupSamples,
        b.warmupSamples,
        report.rules.warmupSamples,
      ],
      [
        'Unobservable faults',
        report.registered.unobservableFaultMissions,
        a.unobservableFaultMissions,
        b.unobservableFaultMissions,
        report.rules.unobservableFaultMissions,
      ],
    ],
  )}</section>
  <section><h2>Cruise-lag evidence and uncertainty</h2>${table(
    [
      'Evidence',
      'Previous forest',
      'Targeted candidate',
      'Paired candidate-minus-previous95% interval',
    ],
    [
      [
        'Primary confirmed cruise lag',
        pair(c.cruise.baseline.detected, c.cruise.baseline.observable),
        pair(c.cruise.candidate.detected, c.cruise.candidate.observable),
        interval(c.cruise.recallGainInterval),
      ],
      [
        'Current-noise challenge confirmation',
        pair(c.challenge.baseline.detected, c.challenge.baseline.observable),
        pair(c.challenge.candidate.detected, c.challenge.candidate.observable),
        interval(c.challenge.recallGainInterval),
      ],
      [
        'Nominal mission alarm rate',
        pct(a.nominalFalseAlarmRate),
        pct(b.nominalFalseAlarmRate),
        interval(c.ordinary.confidence.nominalFalseAlarmRateDelta!),
      ],
      [
        'Overall active recall',
        pct(a.activeRecall),
        pct(b.activeRecall),
        interval(c.ordinary.confidence.activeRecallDelta!),
      ],
      [
        'Overall confirmed recall',
        pct(s.baseline.recall),
        pct(s.candidate.recall),
        interval(s.recallGainInterval),
      ],
    ],
  )}<p>Ordinary paired p95 added delay: ${c.ordinary.constraints.pairedP95AddedDelayMs ?? 'undefined'}ms across ${c.ordinary.constraints.pairedDetections} jointly detected cases. Confirmed paired p95 added delay: ${s.p95AddedDelayMs ?? 'undefined'}ms across ${s.pairedDetections} jointly confirmed cases.</p><p>All intervals use1,000 paired bootstrap resamples of whole seed clusters. Misses stay in recall denominators. Delay comparisons include only joint detections. The challenge preserves current-time IAS noise while delaying latent speed; it does not change the primary41-case matrix.</p><p>Acceptance preserves ordinary and confirmed recall within two points overall and five points per family, and paired p95 added delays within five seconds. Nominal reduction needs a negative upper confidence bound. Confirmed cruise-lag gains must be at least ten points with a positive lower bound in both streams. A passing relative gain does not mean cruise-lag detection is solved.</p></section>
  <section><h2>Does the feature change help beyond retraining?</h2><p>The separately frozen control uses the original72 features with the same new fitting data and forest parameters. It is a descriptive ablation, not a replacement candidate selected after final results.</p>${table(
    ['Metric', 'Retrained original features', 'Targeted features', 'Paired95% difference interval'],
    [
      [
        'Nominal alarm rate',
        pct(ab.ordinary.baseline.nominalFalseAlarmRate),
        pct(ab.ordinary.candidate.nominalFalseAlarmRate),
        interval(ab.ordinary.confidence.nominalFalseAlarmRateDelta!),
      ],
      [
        'Confirmed cruise-lag recall',
        pct(ab.cruise.baseline.recall),
        pct(ab.cruise.candidate.recall),
        interval(ab.cruise.recallGainInterval),
      ],
      [
        'Current-noise challenge recall',
        pct(ab.challenge.baseline.recall),
        pct(ab.challenge.candidate.recall),
        interval(ab.challenge.recallGainInterval),
      ],
    ],
  )}</section>
  <section><h2>Every fault family and variant</h2>${table(['Family', 'Variant', 'Previous active', 'Targeted active', 'Previous confirmed', 'Targeted confirmed'], groupRows)}<p>Confirmed response requires a new active alert and three consecutive active samples with a clear independently scored nominal control. Timestamp is the third sample. A coincident, abstained or unavailable control disqualifies that episode; later control clearing cannot repair it. This is controlled synthetic responsiveness, not fault-family identification.</p></section>
  <section><h2>Frozen candidate comparison</h2>${table(
    [
      'Setting',
      'Threshold',
      'Nominal alarms',
      'Active recall',
      'Confirmed recall',
      'Cruise confirmation',
      'Decision',
    ],
    report.comparisons.map((x) => [
      x.setting.id,
      x.setting.threshold.toPrecision(6),
      pair(
        x.ordinary.candidate.nominalFalseAlarmMissions,
        x.ordinary.candidate.nominalEvaluableMissions,
      ),
      pct(x.ordinary.candidate.activeRecall),
      pct(x.confirmed.candidate.recall),
      pct(x.cruise.candidate.recall),
      x.decision,
    ]),
  )}<p>Development statistics are selection evidence. Final settings were frozen before accessing final seeds, and a failed development candidate cannot be rescued by final results. No final-data tuning is permitted.</p></section>
  <section><h2>Limitations and reproducibility</h2><p>Results cover one synthetic mission profile and the existing duration/severity variants. They do not establish real-aircraft performance, low operational false-alarm rates, calibrated probabilities or robustness to arbitrary sensor failures. The binary detector answers all post-warmup windows; zero abstention is not proof of certainty.</p><p><a href="report.json">Machine-readable results</a> · <a href="../manifest.json">Protocol and source manifest</a> · <a href="../selection.json">Frozen settings</a> · <a href="../model.json">Candidate/control model</a> · <a href="../incumbent.json">Previous forest</a></p><p class="small">Source: <code>${report.sourceSha256}</code><br>Model: <code>${report.modelSha256}</code><br>Report: <code>${report.contentSha256}</code></p></section>`;
  const script = `new Chart(document.getElementById('nominal'),{type:'bar',data:{labels:['Registered v2','Previous forest','Targeted','Rules'],datasets:[{label:'Nominal mission alarm rate (%)',data:${json([report.registered.nominalFalseAlarmRate, a.nominalFalseAlarmRate, b.nominalFalseAlarmRate, report.rules.nominalFalseAlarmRate].map((x) => (x ?? 0) * 100))},backgroundColor:['#6c7c88','#365b7a','#007c70','#90632e']}]},options:{maintainAspectRatio:false,scales:{y:{min:0,max:100}},plugins:{legend:{display:false}}}});new Chart(document.getElementById('cruise'),{type:'bar',data:{labels:['Primary cruise lag','Current-noise challenge'],datasets:[{label:'Previous forest',data:${json([c.cruise.baseline.recall, c.challenge.baseline.recall].map((x) => (x ?? 0) * 100))},backgroundColor:'#365b7a'},{label:'Targeted',data:${json([c.cruise.candidate.recall, c.challenge.candidate.recall].map((x) => (x ?? 0) * 100))},backgroundColor:'#007c70'}]},options:{maintainAspectRatio:false,scales:{y:{min:0,max:100}}}});`;
  await document('Residual alarms and cruise-lag evaluation', body, script, path);
}
export async function writeReplay(
  replay: {
    exactMatch: boolean;
    selectedId: string;
    settings: Setting[];
    result: Inference;
    control: Inference;
  },
  path: string,
) {
  const id = replay.selectedId,
    c = replay.settings.find((x) => x.id === id)!,
    r = replay.result,
    n = replay.control,
    t = r.record.evaluations.incumbent!.faultTimeline;
  const body = `<div class="eyebrow">EXACT MODEL AND NOMINAL-CONTROL REPLAY</div><h1>${esc(r.record.spec.caseId)}</h1><p>${esc(r.record.spec.stream)} stream. Targeted setting ${esc(id)}, threshold${c.threshold.toPrecision(6)}. ${t ? `Active interval${t.onsetIndex}–${t.activeEndIndex}; recovery ends${t.recoveryEndIndex}.` : 'Nominal mission.'}</p><section><div class="chart"><canvas id="scores" role="img" aria-label="Candidate and matched nominal-control score curves with threshold and active interval."></canvas></div></section><section><h2>Alert states</h2>${table(
    ['Sample', 'Registered v2', 'Previous forest', 'Targeted', 'Targeted nominal control'],
    r.predictions.incumbent!.map((p, i) => [
      i,
      r.predictions.registered![i]!.modelState,
      p.modelState,
      r.predictions[id]![i]!.modelState,
      n.predictions[id]![i]!.modelState,
    ]),
  )}<p>JSON beside this file stores exact-match confirmation, score curves, alert states, replay parameters and hashes. Raw sensor measurements regenerate from the parameters. Controls are evaluation-only.</p></section>`;
  const score = r.scores[c.modelId]!;
  const script = `new Chart(document.getElementById('scores'),{type:'line',data:{labels:${json(score.map((_, i) => i + 39))},datasets:[{label:'Targeted score',data:${json(score)},borderColor:'#007c70',pointRadius:0},{label:'Targeted nominal control',data:${json(n.scores[c.modelId])},borderColor:'#365b7a',pointRadius:0},{label:'Frozen threshold',data:${json(score.map(() => c.threshold))},borderColor:'#90632e',borderDash:[4,4],pointRadius:0},{label:'Active truth',data:${json(score.map((_, i) => (t && i + 39 >= t.onsetIndex && i + 39 <= t.activeEndIndex ? 1 : 0)))},borderColor:'#775685',borderDash:[2,5],pointRadius:0,stepped:true}]},options:{maintainAspectRatio:false,scales:{y:{min:0,max:1},x:{title:{display:true,text:'Elapsed seconds'}}}}});`;
  await document(r.record.spec.caseId, body, script, path);
}
