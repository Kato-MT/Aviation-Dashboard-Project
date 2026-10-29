import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { REPOSITORY_ROOT } from '../mission-evaluation/protocol';
import { escapeHtml as esc } from '../mission-evaluation/report';
import type { Inference, RecordResult } from './evaluate';
import type { Setting } from './policy';
import type { Report } from './run';

const pct = (v: number | null) => (v === null ? 'undefined' : `${(v * 100).toFixed(2)}%`);
const count = (n: number, d: number) => `${n}/${d}`;
const interval = (v: { lower: number | null; upper: number | null }) =>
  `${pct(v.lower)} to ${pct(v.upper)}`;
const json = (v: unknown) => JSON.stringify(v).replaceAll('<', '\\u003c');
function table(headers: readonly string[], rows: (string | number | null)[][]) {
  return `<div class="scroll"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((x, i) => `<${i ? 'td' : 'th'}>${esc(String(x ?? 'undefined'))}</${i ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
async function document(title: string, body: string, script: string, path: string) {
  const chart = await readFile(
    resolve(REPOSITORY_ROOT, 'node_modules/chart.js/dist/chart.umd.js'),
    'utf8',
  );
  await writeFile(
    path,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>:root{font-family:Arial,sans-serif;color:#19323e;background:#edf3f6}*{box-sizing:border-box}body{margin:0}main{max-width:1260px;margin:auto;padding:30px 24px}h1{font-size:36px;letter-spacing:-.8px}h2{font-size:23px}p,li{line-height:1.65}section,.card{background:#fff;border:1px solid #c6d4dd;border-radius:12px;margin:18px 0;padding:24px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.grid>div{min-width:0}.chart{height:350px;position:relative}canvas{max-width:100%}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:10px;border-bottom:1px solid #d5e0e5}th{background:#eef3f5}a{color:#075b91}code{overflow-wrap:anywhere}.eyebrow{font-size:12px;font-weight:bold;letter-spacing:1.8px;color:#346376}.decision{font-size:24px;font-weight:bold}.pass{color:#006453}.fail{color:#943c32}.small{font-size:13px;color:#415b67}summary{cursor:pointer;line-height:1.8}@media(max-width:650px){main{padding:18px 12px}h1{font-size:29px}.grid{grid-template-columns:1fr}section,.card{padding:16px}}</style></head><body><main>${body}</main><script>${chart}</script><script>Chart.defaults.animation=false;${script}</script></body></html>`,
  );
}
function changes(rows: readonly RecordResult[], id: string) {
  return {
    lost: rows
      .filter((r) => r.specific['lag-baseline']!.detected && !r.specific[id]!.detected)
      .map((r) => r.spec.caseId),
    gained: rows
      .filter((r) => !r.specific['lag-baseline']!.detected && r.specific[id]!.detected)
      .map((r) => r.spec.caseId),
  };
}
export async function writeReport(report: Report, records: readonly RecordResult[], path: string) {
  const c = report.comparisons.find((x) => x.setting.id === report.selectedId)!;
  const t = c.versusTarget,
    old = c.versusIncumbent,
    a = t.ordinary.baseline,
    b = t.ordinary.candidate;
  const primary = records.filter((r) => r.spec.stream === 'primary');
  const faults = primary.filter((r) => r.spec.family !== 'nominal');
  const cruise = primary.filter(
    (r) => r.spec.family === 'lag' && r.spec.variantId === 'standard-cruise',
  );
  const challenge = records.filter((r) => r.spec.stream === 'current-noise');
  const cruiseChanges = changes(cruise, c.setting.id),
    challengeChanges = changes(challenge, c.setting.id);
  const metricHeaders = [
    'Metric',
    'Registered v2',
    'Earlier forest 0.80',
    'Lag target 0.70',
    'Adaptive candidate',
    'Uniform 0.95',
    'Rules',
  ];
  const metrics = [
    report.references.registered!,
    report.references.incumbent!,
    report.references['lag-baseline']!,
    b,
    report.references['strict-high']!,
    report.references.rules!,
  ];
  const groupRows = [...new Set(faults.map((r) => `${r.spec.family}|${r.spec.variantId}`))]
    .sort()
    .map((key) => {
      const [family, variant] = key.split('|'),
        rows = faults.filter((r) => r.spec.family === family && r.spec.variantId === variant);
      return [
        family!,
        variant!,
        count(
          rows.filter((r) => r.evaluations['lag-baseline']!.policies['model-k1']!.activeDetected)
            .length,
          rows.length,
        ),
        count(
          rows.filter((r) => r.evaluations[c.setting.id]!.policies['model-k1']!.activeDetected)
            .length,
          rows.length,
        ),
        count(rows.filter((r) => r.specific.incumbent!.detected).length, rows.length),
        count(rows.filter((r) => r.specific['lag-baseline']!.detected).length, rows.length),
        count(rows.filter((r) => r.specific[c.setting.id]!.detected).length, rows.length),
      ];
    });
  const strictCruise = cruise.filter((r) => r.specific['strict-high']!.detected).length;
  const strictChallenge = challenge.filter((r) => r.specific['strict-high']!.detected).length;
  const nominal = primary.filter((r) => r.spec.family === 'nominal');
  const removed = nominal
    .filter(
      (r) =>
        r.evaluations['lag-baseline']!.policies['model-k1']!.nominalFalseAlarm &&
        !r.evaluations[c.setting.id]!.policies['model-k1']!.nominalFalseAlarm,
    )
    .map((r) => r.spec.caseId);
  const introduced = nominal
    .filter(
      (r) =>
        !r.evaluations['lag-baseline']!.policies['model-k1']!.nominalFalseAlarm &&
        r.evaluations[c.setting.id]!.policies['model-k1']!.nominalFalseAlarm,
    )
    .map((r) => r.spec.caseId);
  const body = `<div class="eyebrow">FLIGHT DIAGNOSTICS · SYNTHETIC RESEARCH · PRODUCTION UNCHANGED</div><h1>Fewer alarms, preserved cruise-lag evidence</h1><p>${report.stage === 'final' ? 'Fresh final evaluation' : 'Development selection'}: ${report.primaryMissions} primary missions and ${report.challengeMissions} separate current-noise challenges. Every mission has 180 one-second samples.</p>
  <section><div class="decision ${c.passed ? 'pass' : 'fail'}">${report.stage === 'final' ? 'Final' : 'Development'} decision: ${esc(c.decision)}</div><p>Nominal missions with alerts: <strong>${count(a.nominalFalseAlarmMissions, a.nominalEvaluableMissions)} → ${count(b.nominalFalseAlarmMissions, b.nominalEvaluableMissions)}</strong>. Confirmed cruise lag: <strong>${count(t.cruise.baseline.detected, t.cruise.baseline.observable)} → ${count(t.cruise.candidate.detected, t.cruise.candidate.observable)}</strong>. Current-noise confirmations: <strong>${count(t.challenge.baseline.detected, t.challenge.baseline.observable)} → ${count(t.challenge.candidate.detected, t.challenge.candidate.observable)}</strong>.</p><p>${c.reasons.length ? esc(c.reasons.join(' ')) : 'All frozen alarm-reduction and preservation gates pass.'}</p><p>The primary comparison is against the rejected lag-sensitive forest at 0.70. The earlier forest at 0.80 is a separate reference: ${count(old.ordinary.baseline.nominalFalseAlarmMissions, old.ordinary.baseline.nominalEvaluableMissions)} nominal missions with alerts. Passing this study does not imply fewer alarms than every previous detector or readiness for production.</p></section>
  <div class="grid"><div class="card"><h2>Nominal missions with alerts</h2><div class="chart"><canvas id="nominal" role="img" aria-label="Nominal mission alarm rates; exact counts follow."></canvas></div></div><div class="card"><h2>Confirmed cruise-lag responses</h2><div class="chart"><canvas id="cruise" role="img" aria-label="Primary and current-noise confirmed cruise-lag rates; exact counts follow."></canvas></div></div></div>
  <section><h2>The targeted decision rule</h2><p>Frozen setting: <strong>${esc(c.setting.id)}</strong>. Alert if score &gt; ${c.setting.generalThreshold.toFixed(2)}, or if score &gt; ${c.setting.lagThreshold.toFixed(2)} with positive signed lag evidence and at least eight valid comparisons out of seventeen. The model weights and feature scaling are unchanged.</p><p>The sensitive branch requires observed evidence consistent with lag; other cases need a stronger score. Warmup, abstention and unavailable states cannot start alerts. Missing lag evidence cannot open the sensitive branch. No true phase, absolute time, seed, future observation or nominal-control value enters the rule. Alerts are neither backdated nor held after the current evidence clears.</p><p>Old-data diagnostics found 36 single-sample nominal episodes, but a simple two-window requirement also lost cruise confirmations. The adaptive rule tests a more targeted response to mixed lag-feature noise and other sensor-disagreement spikes. Those diagnostics are separate from the fresh results below.</p></section>
  <section><h2>Primary full-mission results</h2>${table(metricHeaders, [
    [
      'Nominal missions with alarms',
      ...metrics.map((m) => count(m.nominalFalseAlarmMissions, m.nominalEvaluableMissions)),
    ],
    ['Nominal-only alarm episodes', ...metrics.map((m) => m.byFamily.nominal!.falseAlarmEpisodes)],
    [
      'Active-fault detections',
      ...metrics.map((m) => count(m.detectedFaultMissions, m.observableFaultMissions)),
    ],
    ['Active misses', ...metrics.map((m) => m.missedFaultMissions)],
    ['False-alarm episodes', ...metrics.map((m) => m.falseAlarmEpisodes)],
    ['Detection-delay p95 (ms)', ...metrics.map((m) => m.detectionDelayMs.p95)],
    ['Recovery alarm seconds', ...metrics.map((m) => m.recoveryAlarmMs / 1000)],
    ['Post-recovery carryover seconds', ...metrics.map((m) => m.carryoverAfterRecoveryMs / 1000)],
    ['Abstention', ...metrics.map((m) => pct(m.abstentionFraction))],
    ['Unavailable samples', ...metrics.map((m) => m.unavailableSamples)],
    ['Warmup samples', ...metrics.map((m) => m.warmupSamples)],
    ['Unobservable faults', ...metrics.map((m) => m.unobservableFaultMissions)],
  ])}<p>Confirmed fault-specific detections: earlier forest ${count(old.confirmed.baseline.detected, old.confirmed.baseline.observable)}; lag-sensitive target ${count(t.confirmed.baseline.detected, t.confirmed.baseline.observable)}; adaptive candidate ${count(t.confirmed.candidate.detected, t.confirmed.candidate.observable)}.</p></section>
  <section><h2>Paired uncertainty and preservation</h2>${table(
    ['Evidence', 'Comparator', 'Candidate', 'Candidate-minus-comparator 95% interval'],
    [
      [
        'Nominal alarm rate vs lag target',
        pct(a.nominalFalseAlarmRate),
        pct(b.nominalFalseAlarmRate),
        interval(t.ordinary.confidence.nominalFalseAlarmRateDelta!),
      ],
      [
        'Nominal alarm rate vs earlier forest',
        pct(old.ordinary.baseline.nominalFalseAlarmRate),
        pct(b.nominalFalseAlarmRate),
        interval(old.ordinary.confidence.nominalFalseAlarmRateDelta!),
      ],
      [
        'Ordinary active recall vs lag target',
        pct(a.activeRecall),
        pct(b.activeRecall),
        interval(t.ordinary.confidence.activeRecallDelta!),
      ],
      [
        'Confirmed recall vs lag target',
        pct(t.confirmed.baseline.recall),
        pct(t.confirmed.candidate.recall),
        interval(t.confirmed.recallGainInterval),
      ],
      [
        'Confirmed recall vs earlier forest',
        pct(old.confirmed.baseline.recall),
        pct(old.confirmed.candidate.recall),
        interval(old.confirmed.recallGainInterval),
      ],
      [
        'Primary cruise confirmation vs lag target',
        count(t.cruise.baseline.detected, t.cruise.baseline.observable),
        count(t.cruise.candidate.detected, t.cruise.candidate.observable),
        interval(t.cruise.recallGainInterval),
      ],
      [
        'Current-noise confirmation vs lag target',
        count(t.challenge.baseline.detected, t.challenge.baseline.observable),
        count(t.challenge.candidate.detected, t.challenge.candidate.observable),
        interval(t.challenge.recallGainInterval),
      ],
      [
        'Primary cruise confirmation vs earlier forest',
        count(old.cruise.baseline.detected, old.cruise.baseline.observable),
        count(old.cruise.candidate.detected, old.cruise.candidate.observable),
        interval(old.cruise.recallGainInterval),
      ],
      [
        'Current-noise confirmation vs earlier forest',
        count(old.challenge.baseline.detected, old.challenge.baseline.observable),
        count(old.challenge.candidate.detected, old.challenge.candidate.observable),
        interval(old.challenge.recallGainInterval),
      ],
    ],
  )}<p>Intervals use 1,000 paired bootstrap resamples of whole seed clusters. Related variants and shared nominal controls stay together. Required undefined evidence fails; misses remain in recall denominators.</p>${table(
    ['Delay comparison', 'Joint detections', 'Paired p95 added delay (ms)'],
    [
      [
        'Ordinary vs lag target',
        t.ordinary.constraints.pairedDetections,
        t.ordinary.constraints.pairedP95AddedDelayMs,
      ],
      ['Confirmed vs lag target', t.confirmed.pairedDetections, t.confirmed.p95AddedDelayMs],
      [
        'Ordinary vs earlier forest',
        old.ordinary.constraints.pairedDetections,
        old.ordinary.constraints.pairedP95AddedDelayMs,
      ],
      [
        'Confirmed vs earlier forest',
        old.confirmed.pairedDetections,
        old.confirmed.p95AddedDelayMs,
      ],
      ['Primary cruise vs lag target', t.cruise.pairedDetections, t.cruise.p95AddedDelayMs],
      [
        'Current-noise cruise vs lag target',
        t.challenge.pairedDetections,
        t.challenge.p95AddedDelayMs,
      ],
    ],
  )}<p>Acceptance requires a supported nominal reduction; ordinary and confirmed recall preservation against both forests within two points overall and five points per family; and paired p95 delay within five seconds. Cruise confirmation may not drop in either stream versus the lag target, its paired lower bound must be at least -5 points, and the ten-point supported gain over the earlier forest must remain. Delay summaries only include joint detections.</p></section>
  <section><h2>What the sensitive branch adds</h2><p>A uniform 0.95 threshold on the same frozen model confirms ${count(strictCruise, cruise.length)} primary cruise cases and ${count(strictChallenge, challenge.length)} current-noise cases. The adaptive rule confirms ${count(t.cruise.candidate.detected, t.cruise.candidate.observable)} and ${count(t.challenge.candidate.detected, t.challenge.candidate.observable)}. This is a descriptive reference, not an alternative chosen after final testing.</p></section>
  <section><h2>Individual cases gained and lost</h2><p>Aggregate preservation is not individual-case preservation. Relative to the lag target, primary cruise loses ${cruiseChanges.lost.length} confirmations and gains ${cruiseChanges.gained.length}; the current-noise challenge loses ${challengeChanges.lost.length} and gains ${challengeChanges.gained.length}. Nominal alarms are removed from ${removed.length} missions and introduced in ${introduced.length}.</p>${Object.entries(
    {
      'Primary cruise losses': cruiseChanges.lost,
      'Primary cruise gains': cruiseChanges.gained,
      'Current-noise losses': challengeChanges.lost,
      'Current-noise gains': challengeChanges.gained,
      'Removed nominal alarms': removed,
      'Introduced nominal alarms': introduced,
    },
  )
    .map(
      ([title, ids]) =>
        `<details><summary>${esc(title)} (${ids.length})</summary><p><code>${esc(ids.length ? ids.join(', ') : 'None')}</code></p></details>`,
    )
    .join('')}</section>
  <section><h2>Every fault family and variant</h2>${table(['Family', 'Variant', 'Target active', 'Candidate active', 'Earlier confirmed', 'Target confirmed', 'Candidate confirmed'], groupRows)}<p>Confirmed detection requires a new alert within the active interval followed by three consecutive active samples with a clear, independently scored nominal control. Confirmation time is the third sample. A pre-existing alert, later-clearing control or recovery-only response cannot repair a miss.</p></section>
  <section><h2>Frozen candidate comparison</h2>${table(
    [
      'Setting',
      'Nominal alarms',
      'Active recall',
      'Confirmed recall',
      'Primary cruise',
      'Current-noise cruise',
      'Decision',
    ],
    report.comparisons.map((x) => [
      x.setting.id,
      count(
        x.versusTarget.ordinary.candidate.nominalFalseAlarmMissions,
        x.versusTarget.ordinary.candidate.nominalEvaluableMissions,
      ),
      pct(x.versusTarget.ordinary.candidate.activeRecall),
      pct(x.versusTarget.confirmed.candidate.recall),
      pct(x.versusTarget.cruise.candidate.recall),
      pct(x.versusTarget.challenge.candidate.recall),
      x.decision,
    ]),
  )}<p>Development chooses among four declared settings once. Final evaluates only the frozen setting; a failed development result cannot be rescued. The model is not retrained and final results cannot trigger another tuning cycle on these seeds.</p></section>
  <section><h2>Limitations and reproducibility</h2><p>Results cover one synthetic mission profile and declared severity/duration variants. They establish neither real-aircraft reliability nor calibrated probabilities or fault-family identification. The baseline is already an experimental binary detector. Relative improvement does not eliminate remaining alarms or cruise misses. Production and deterministic authority are unchanged.</p><p><a href="report.json">Machine-readable report</a> · <a href="../manifest.json">Protocol and source manifest</a> · <a href="../selection.json">Frozen selection</a> · <a href="../model.json">Frozen lag-sensitive forest</a> · <a href="../incumbent.json">Earlier forest</a></p><p class="small">Source: <code>${report.sourceSha256}</code><br>Model: <code>${report.modelSha256}</code><br>Report: <code>${report.contentSha256}</code></p></section>`;
  const script = `new Chart(document.getElementById('nominal'),{type:'bar',data:{labels:['Earlier forest','Lag target','Adaptive','Uniform 0.95'],datasets:[{label:'Nominal mission alarm rate (%)',data:${json([old.ordinary.baseline.nominalFalseAlarmRate, a.nominalFalseAlarmRate, b.nominalFalseAlarmRate, report.references['strict-high']!.nominalFalseAlarmRate].map((x) => (x ?? 0) * 100))},backgroundColor:['#6c7c88','#365b7a','#007c70','#90632e']}]},options:{maintainAspectRatio:false,scales:{y:{min:0,max:100}},plugins:{legend:{display:false}}}});new Chart(document.getElementById('cruise'),{type:'bar',data:{labels:['Primary cruise lag','Current-noise challenge'],datasets:[{label:'Earlier forest',data:${json([old.cruise.baseline.recall, old.challenge.baseline.recall].map((x) => (x ?? 0) * 100))},backgroundColor:'#6c7c88'},{label:'Lag target',data:${json([t.cruise.baseline.recall, t.challenge.baseline.recall].map((x) => (x ?? 0) * 100))},backgroundColor:'#365b7a'},{label:'Adaptive',data:${json([t.cruise.candidate.recall, t.challenge.candidate.recall].map((x) => (x ?? 0) * 100))},backgroundColor:'#007c70'}]},options:{maintainAspectRatio:false,scales:{y:{min:0,max:100}}}});`;
  await document('Alarm reduction and cruise-lag preservation', body, script, path);
}
export async function writeReplay(
  replay: { exactMatch: boolean; setting: Setting; result: Inference; control: Inference },
  path: string,
) {
  const { result: r, control: n, setting: s } = replay,
    t = r.record.evaluations.incumbent!.faultTimeline;
  const effective = r.lag.map((l) =>
    l.value > 0 && l.validFraction >= 8 / 17 ? s.lagThreshold : s.generalThreshold,
  );
  const body = `<div class="eyebrow">EXACT ADAPTIVE POLICY AND NOMINAL-CONTROL REPLAY</div><h1>${esc(r.record.spec.caseId)}</h1><p>${esc(r.record.spec.stream)} stream. Setting ${esc(s.id)}. ${t ? `Active interval ${t.onsetIndex}–${t.activeEndIndex}; recovery ends ${t.recoveryEndIndex}.` : 'Nominal mission.'}</p><section><h2>Scores and causal threshold</h2><div class="chart"><canvas id="scores" role="img" aria-label="Frozen model scores, adaptive threshold, baseline threshold and active interval."></canvas></div></section><section><h2>Signed lag evidence</h2><div class="chart"><canvas id="lag" role="img" aria-label="Observed signed lag evidence and zero boundary; positive valid evidence permits the sensitive threshold."></canvas></div></section><section><h2>Alert states</h2>${table(
    ['Sample', 'Earlier forest', 'Lag target 0.70', 'Adaptive', 'Adaptive nominal control'],
    r.predictions.incumbent!.map((p, i) => [
      i,
      p.modelState,
      r.predictions['lag-baseline']![i]!.modelState,
      r.predictions[s.id]![i]!.modelState,
      n.predictions[s.id]![i]!.modelState,
    ]),
  )}<p>The JSON beside this file stores exact-match confirmation, scores, lag evidence, alert states, replay parameters and hashes. Raw sensor measurements regenerate from those parameters. Controls are evaluation-only, after independent inference.</p></section>`;
  const labels = r.scores.targeted!.map((_, i) => i + 39);
  const script = `new Chart(document.getElementById('scores'),{type:'line',data:{labels:${json(labels)},datasets:[{label:'Frozen model score',data:${json(r.scores.targeted)},borderColor:'#007c70',pointRadius:0},{label:'Nominal-control score',data:${json(n.scores.targeted)},borderColor:'#365b7a',pointRadius:0},{label:'Adaptive threshold',data:${json(effective)},borderColor:'#90632e',borderDash:[4,4],pointRadius:0,stepped:true},{label:'Baseline 0.70',data:${json(labels.map(() => 0.7))},borderColor:'#6c7c88',borderDash:[2,3],pointRadius:0},{label:'Active truth',data:${json(labels.map((i) => (t && i >= t.onsetIndex && i <= t.activeEndIndex ? 1 : 0)))},borderColor:'#775685',borderDash:[2,5],pointRadius:0,stepped:true}]},options:{maintainAspectRatio:false,scales:{y:{min:0,max:1},x:{title:{display:true,text:'Elapsed seconds'}}}}});new Chart(document.getElementById('lag'),{type:'line',data:{labels:${json(labels)},datasets:[{label:'Signed lag evidence',data:${json(r.lag.map((l) => (l.validFraction >= 8 / 17 ? l.value : null)))},borderColor:'#007c70',pointRadius:0},{label:'Zero boundary',data:${json(labels.map(() => 0))},borderColor:'#90632e',borderDash:[3,4],pointRadius:0}]},options:{maintainAspectRatio:false,scales:{x:{title:{display:true,text:'Elapsed seconds'}}}}});`;
  await document(r.record.spec.caseId, body, script, path);
}
