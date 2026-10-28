import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { REPOSITORY_ROOT } from '../mission-evaluation/protocol';
import { escapeHtml as esc } from '../mission-evaluation/report';
import type { Envelope } from './core';
import type { Report, pairedMission } from './run';

const pct = (v: number | null) => (v === null ? 'undefined' : `${(v * 100).toFixed(2)}%`);
const num = (v: number | null) =>
  v === null ? 'undefined' : v.toLocaleString('en-US', { maximumFractionDigits: 2 });
const css = `:root{font-family:Arial,sans-serif;color:#142a3b;background:#eef2f5}*{box-sizing:border-box}body{margin:0}main{max-width:1180px;margin:auto;padding:36px 24px}h1{font-size:38px;letter-spacing:-1px;margin:12px 0}h2{font-size:24px}p{line-height:1.6;max-width:85ch}.eyebrow{font-size:12px;font-weight:bold;letter-spacing:2px;color:#245b73}.card,section{background:white;border:1px solid #ccd7df;border-radius:12px;padding:24px;margin:18px 0}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.grid>div{min-width:0}.chart{height:330px;position:relative}.table{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{padding:11px;text-align:left;border-bottom:1px solid #dce3e8}th{background:#eff4f6}code{overflow-wrap:anywhere}a{color:#075c9a}li{line-height:1.7}.verdict{font-size:20px;font-weight:bold;color:#6e3c00}.small{font-size:13px;color:#435968}canvas{max-width:100%}@media(max-width:650px){main{padding:20px 12px}h1{font-size:29px}.grid{grid-template-columns:1fr}section,.card{padding:18px}.chart{height:300px}}`;
const json = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c');
async function html(title: string, body: string, script: string, path: string) {
  const chart = await readFile(
    resolve(REPOSITORY_ROOT, 'node_modules/chart.js/dist/chart.umd.js'),
    'utf8',
  );
  await writeFile(
    path,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${css}</style></head><body><main>${body}</main><script>${chart}</script><script>${script}</script></body></html>`,
  );
}

export async function writeReport(report: Report, envelope: Envelope, path: string) {
  const selected = report.comparisons.find((c) => c.candidateId === report.selectedCandidateId)!;
  const a = selected.baseline,
    b = selected.candidate;
  const families = Object.keys(a.byFamily).filter((n) => a.byFamily[n]!.faultMissions > 0);
  const body = `<div class="eyebrow">FLIGHT DIAGNOSTICS WORKBENCH · SYNTHETIC EXPERIMENT</div><h1>Fixing nominal false alarms</h1><p>${report.stage === 'final' ? 'Fresh held-out evaluation' : 'Development and candidate selection'} · ${a.missions} missions · ${a.nominalMissions} independent seeds · 180 samples per mission</p>
  <section><div class="verdict">${report.stage === 'final' ? 'Final decision' : 'Development finding'}: ${esc(selected.decision)}</div><p>The registered model alerted on <strong>${a.nominalFalseAlarmMissions}/${a.nominalEvaluableMissions}</strong> nominal missions. The experimental correction alerted on <strong>${b.nominalFalseAlarmMissions}/${b.nominalEvaluableMissions}</strong>. Active-fault recall changed from <strong>${pct(a.activeRecall)}</strong> to <strong>${pct(b.activeRecall)}</strong>.</p><p>Selected correction: <code>${esc(selected.candidateId)}</code>, threshold ${num(envelope.thresholds[selected.candidateId]!)}. Production app, registered model, classifier, and rule thresholds remain unchanged.</p><p>${selected.constraints.reasons.length ? esc(selected.constraints.reasons.join(' ')) : 'The recall, family, and paired delay guardrails pass.'}</p></section>
  <div class="grid"><div class="card"><h2>Nominal missions with alerts</h2><div class="chart"><canvas id="falseAlarms" role="img" aria-label="Nominal mission false-alarm rates. Exact counts are in the table below."></canvas></div></div><div class="card"><h2>Fault recall by family</h2><div class="chart"><canvas id="recall" role="img" aria-label="Active-fault recall by family. Exact values are in the following table."></canvas></div></div></div>
  <section><h2>Why normal missions alarmed</h2><p>The registered model learned five nominal prototypes from 40 selected windows and calibrated on 20 selected nominal windows. It then scored 141 windows per full mission. Normal windows spanning changing flight regimes were outside that sparse nominal coverage.</p><p>Some features had a scale of 10<sup>−9</sup>. A single discrete change in a freeze-ratio feature could therefore create an enormous standardized distance. Once outside the nominal threshold, the v2 scorer considers only fault classes; broad fault-class radii let some of these normal windows become alerts.</p><p>The correction fits 141 nominal centroids from all eligible windows of 40 new nominal missions, uses full-stream variability and discrete-resolution scale floors, and calibrates on another 40 nominal missions. Its observed-only gate searches all centroids. It does not use truth, seed, mission time, or true phase to decide normality. Windows recognized as normal become nominal; other decisions retain the registered classifier output.</p></section>
  <section><h2>Matched evidence</h2><div class="table"><table><thead><tr><th>Metric</th><th>Registered v2</th><th>Experimental correction</th><th>Deterministic rules</th></tr></thead><tbody>${[
    [
      'Nominal missions with alarms',
      `${a.nominalFalseAlarmMissions}/${a.nominalEvaluableMissions}`,
      `${b.nominalFalseAlarmMissions}/${b.nominalEvaluableMissions}`,
      `${report.rules.nominalFalseAlarmMissions}/${report.rules.nominalEvaluableMissions}`,
    ],
    [
      'Active faults detected',
      `${a.detectedFaultMissions}/${a.observableFaultMissions}`,
      `${b.detectedFaultMissions}/${b.observableFaultMissions}`,
      `${report.rules.detectedFaultMissions}/${report.rules.observableFaultMissions}`,
    ],
    [
      'Missed faults',
      a.missedFaultMissions,
      b.missedFaultMissions,
      report.rules.missedFaultMissions,
    ],
    [
      'False-alarm episodes',
      a.falseAlarmEpisodes,
      b.falseAlarmEpisodes,
      report.rules.falseAlarmEpisodes,
    ],
    [
      'Detection delay p95 (seconds)',
      a.detectionDelayMs.p95 === null ? null : a.detectionDelayMs.p95 / 1000,
      b.detectionDelayMs.p95 === null ? null : b.detectionDelayMs.p95 / 1000,
      report.rules.detectionDelayMs.p95 === null ? null : report.rules.detectionDelayMs.p95 / 1000,
    ],
    [
      'Abstention',
      pct(a.abstentionFraction),
      pct(b.abstentionFraction),
      pct(report.rules.abstentionFraction),
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
    [
      'Unavailable samples',
      a.unavailableSamples,
      b.unavailableSamples,
      report.rules.unavailableSamples,
    ],
    [
      'Unobservable fault missions',
      a.unobservableFaultMissions,
      b.unobservableFaultMissions,
      report.rules.unobservableFaultMissions,
    ],
    ['Warmup samples', a.warmupSamples, b.warmupSamples, report.rules.warmupSamples],
  ]
    .map(
      (row) =>
        `<tr>${row.map((v, i) => `<${i ? 'td' : 'th'}>${esc(String(v ?? 'undefined'))}</${i ? 'td' : 'th'}>`).join('')}</tr>`,
    )
    .join(
      '',
    )}</tbody></table></div><p class="small">A detection requires a new alert to begin during the inclusive active fault interval. Pre-existing and recovery-only alarms do not count. Both model paths use one anomalous window to start an alert. Warmup is 39 samples. Rules are reported independently.</p></section>
  <section><h2>Uncertainty and acceptance</h2><p>1,000 paired bootstrap resamples keep all 41 variants for each seed together. Candidate minus baseline 95% intervals:</p><ul>${Object.entries(
    selected.confidence,
  )
    .map(
      ([name, ci]) =>
        `<li>${esc(name)}: [${num(ci.lower)}, ${num(ci.upper)}], ${ci.validReplicates} valid resamples</li>`,
    )
    .join(
      '',
    )}</ul><p>Paired p95 added delay: ${num(selected.constraints.pairedP95AddedDelayMs)} ms across ${selected.constraints.pairedDetections} jointly detected faults. Required limits: overall recall loss ≤2 percentage points, each family ≤5 points, paired p95 delay increase ≤5 seconds. An improvement also requires the false-alarm-rate delta interval to lie below zero.</p><p class="small">Delay comparisons exclude cases missed by either detector, so miss counts remain essential. Zero observed alarms does not establish zero future risk. The one-sided 95% exact upper bound after 0/${b.nominalEvaluableMissions} nominal alarms would be ${pct(1 - Math.pow(0.05, 1 / b.nominalEvaluableMissions))}. These are synthetic missions from one generator, not operational aircraft evidence.</p></section>
  <section><h2>Where it helps and hurts</h2><div class="table"><table><thead><tr><th>Fault family</th><th>Baseline recall</th><th>Candidate recall</th><th>Recall loss, points</th><th>Candidate misses</th></tr></thead><tbody>${families.map((name) => `<tr><th>${esc(name)}</th><td>${pct(a.byFamily[name]!.activeRecall)}</td><td>${pct(b.byFamily[name]!.activeRecall)}</td><td>${num((selected.constraints.perFamilyRecallDrop[name] ?? 0) * 100)}</td><td>${b.byFamily[name]!.missedFaultMissions}</td></tr>`).join('')}</tbody></table></div><h3>Scenario variants</h3><div class="table"><table><thead><tr><th>Variant</th><th>Baseline recall</th><th>Candidate recall</th><th>Candidate misses</th></tr></thead><tbody>${Object.keys(
    b.byVariant,
  )
    .map(
      (name) =>
        `<tr><th>${esc(name)}</th><td>${pct(a.byVariant[name]!.activeRecall)}</td><td>${pct(b.byVariant[name]!.activeRecall)}</td><td>${b.byVariant[name]!.missedFaultMissions}</td></tr>`,
    )
    .join(
      '',
    )}</tbody></table></div><p>Full per-mission intervals and all three development candidates are available in the machine-readable evidence.</p></section>
  <section><h2>Reproducible, isolated experiment</h2><p><a href="report.json">Machine-readable report</a> · <a href="../manifest.json">Frozen protocol and source identity</a> · <a href="../envelope.json">Fitted experimental envelope</a> · <a href="../selection.json">Selection frozen before final testing</a></p><p class="small">Report SHA-256: <code>${report.contentSha256}</code><br>Source SHA-256: <code>${report.sourceSha256}</code><br>Envelope SHA-256: <code>${report.envelopeSha256}</code></p></section>`;
  const series = {
    labels: families,
    baseline: families.map((n) => (a.byFamily[n]!.activeRecall ?? 0) * 100),
    candidate: families.map((n) => (b.byFamily[n]!.activeRecall ?? 0) * 100),
  };
  const script = `Chart.defaults.animation=false;Chart.defaults.font.family='Arial';new Chart(document.getElementById('falseAlarms'),{type:'bar',data:{labels:['Registered v2','Correction','Rules'],datasets:[{label:'Nominal missions with false alarms (%)',data:${json([a.nominalFalseAlarmRate, b.nominalFalseAlarmRate, report.rules.nominalFalseAlarmRate].map((v) => (v ?? 0) * 100))},backgroundColor:['#355c7d','#007d70','#8b5b30']}]},options:{maintainAspectRatio:false,scales:{y:{min:0,max:100}},plugins:{legend:{display:false}}}});const s=${json(series)};new Chart(document.getElementById('recall'),{type:'bar',data:{labels:s.labels,datasets:[{label:'Registered v2',data:s.baseline,backgroundColor:'#355c7d'},{label:'Correction',data:s.candidate,backgroundColor:'#007d70'}]},options:{indexAxis:'y',maintainAspectRatio:false,scales:{x:{min:0,max:100}}}});`;
  await html('Nominal false-alarm correction', body, script, path);
}

export async function writeReplay(replay: ReturnType<typeof pairedMission>, path: string) {
  const id = Object.keys(replay.candidatePredictions)[0]!;
  const base = replay.baselinePredictions,
    other = replay.candidatePredictions[id]!;
  const timeline = replay.record.baseline.faultTimeline;
  const body = `<div class="eyebrow">EXACT SYNTHETIC REPLAY</div><h1>${esc(replay.record.spec.caseId)}</h1><p>Candidate: ${esc(id)}. ${timeline ? `Active interval: ${timeline.onsetIndex}–${timeline.activeEndIndex}; recovery ends ${timeline.recoveryEndIndex}.` : 'Nominal mission, no declared fault.'}</p><section><div class="chart"><canvas id="replay" role="img" aria-label="Baseline and corrected alarm samples over the mission; detailed states follow."></canvas></div></section><section><h2>Observed decisions</h2><div class="table"><table><thead><tr><th>Second</th><th>Baseline</th><th>Correction</th><th>Rules</th></tr></thead><tbody>${base.map((p, i) => `<tr><td>${i}</td><td>${esc(p.modelState)}</td><td>${esc(other[i]!.modelState)}</td><td>${p.deterministic ? 'alarm' : 'clear'}</td></tr>`).join('')}</tbody></table></div><p>JSON beside this file contains exact scenario parameters, hashes, paired evaluations and prediction traces.</p></section>`;
  const script = `Chart.defaults.animation=false;new Chart(document.getElementById('replay'),{type:'line',data:{labels:${json(base.map((p) => p.sampleIndex))},datasets:[{label:'Registered alert',data:${json(base.map((p) => Number(p.modelState === 'anomalous')))},borderColor:'#355c7d',pointRadius:0,stepped:true},{label:'Corrected alert',data:${json(other.map((p) => Number(p.modelState === 'anomalous')))},borderColor:'#007d70',pointRadius:0,stepped:true},{label:'Active fault truth',data:${json(base.map((p) => Number(timeline !== null && p.sampleIndex >= timeline.onsetIndex && p.sampleIndex <= timeline.activeEndIndex)))},borderColor:'#b55b17',borderDash:[4,4],pointRadius:0,stepped:true}]},options:{maintainAspectRatio:false,scales:{y:{min:0,max:1},x:{title:{display:true,text:'Elapsed seconds'}}}}});`;
  await html(replay.record.spec.caseId, body, script, path);
}
