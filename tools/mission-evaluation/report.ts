import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { type MissionGroupSummary, type PredictionPoint } from '../../src/mission-evaluation';
import type { EvidenceReport } from './run';
import type { MissionRecord } from './protocol';

const require = createRequire(import.meta.url);
const labels: Record<string, string> = {
  'model-k1': 'Original model (1 window)',
  'model-k2': '2-window policy',
  'model-k3': '3-window policy',
  'model-k5': '5-window policy',
  deterministic: 'Deterministic rules',
};
export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
function percent(value: number | null): string {
  return value === null ? 'Not identifiable' : `${(value * 100).toFixed(1)}%`;
}
function number(value: number | null, digits = 1): string {
  return value === null
    ? 'Not identifiable'
    : value.toLocaleString('en-US', { maximumFractionDigits: digits });
}
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

const css = `:root{color-scheme:light;font-family:Inter,system-ui,sans-serif;color:#152436;background:#f4f6f8}*{box-sizing:border-box}body{margin:0}main{max-width:1180px;margin:auto;padding:40px 28px 70px}header{border-top:6px solid #3158c9;padding-top:24px;margin-bottom:36px}.eyebrow{font-size:12px;font-weight:750;letter-spacing:.14em;text-transform:uppercase;color:#3158c9}h1{font-size:clamp(28px,4vw,46px);letter-spacing:-.04em;margin:12px 0;line-height:1.1}h2{font-size:24px;margin:0 0 16px}h3{font-size:17px}p,li{line-height:1.65;max-width:95ch}a{color:#254fc2}section{background:white;border:1px solid #dce2ea;border-radius:12px;padding:26px;margin:22px 0}.decision{background:#eaf0ff;border-left:5px solid #3158c9;padding:16px 20px;margin:18px 0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:22px}.grid>div{min-width:0}.chart{height:320px;position:relative;min-width:0}canvas{max-width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere}.table{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}th,td{padding:12px 10px;text-align:left;border-bottom:1px solid #e2e7ed;vertical-align:top}th{font-weight:700;background:#f5f7fa}td:first-child{font-weight:600}code{font-family:Consolas,monospace;overflow-wrap:anywhere;font-size:12px}small,.muted{color:#536477}.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:15px}.kpi{background:#f5f7fa;border-radius:8px;padding:18px}.kpi strong{display:block;font-size:28px;margin-bottom:5px}.note{font-size:13px}details{margin:16px 0}summary{cursor:pointer;font-weight:650}footer{font-size:12px;color:#536477;margin-top:30px}@media(max-width:700px){main{padding:22px 14px}.grid,.kpis{grid-template-columns:1fr}section{padding:18px}.chart{height:280px}}@media print{main{max-width:none;padding:0}section{break-inside:avoid}details{display:block}.chart{height:260px}body{background:white}}`;

async function page(title: string, body: string, chartCode: string): Promise<string> {
  const chartPath = require.resolve('chart.js');
  const library = await readFile(resolve(chartPath, '..', 'chart.umd.js'), 'utf8');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${css}</style></head><body><main>${body}<footer>Synthetic, unclassified educational evidence. No operational aircraft, maintenance, safety, or certification claim. Charts and data are embedded; no network connection is required.</footer></main><script>${library.replaceAll('</script', '<\\/script')}</script><script>${chartCode}</script></body></html>`;
}

function metricsRow(name: string, metric: MissionGroupSummary): string {
  return `<tr><td>${escapeHtml(name)}</td><td>${metric.detectedFaultMissions}/${metric.observableFaultMissions}<br>${percent(metric.activeRecall)}</td><td>${metric.missedFaultMissions}</td><td>${metric.nominalFalseAlarmMissions}/${metric.nominalEvaluableMissions}<br>${percent(metric.nominalFalseAlarmRate)}</td><td>${number(metric.detectionDelayMs.median)} / ${number(metric.detectionDelayMs.p95)} ms<br><small>${metric.detectionDelayMs.count} detected cases</small></td><td>${percent(metric.abstentionFraction)}</td></tr>`;
}

export async function writeEvidenceReport(
  report: EvidenceReport,
  destination: string,
): Promise<void> {
  const selected = report.selection?.selectedPolicyId ?? report.decision!.selectedPolicyId;
  const baseline = report.aggregates.find((item) => item.policyId === 'model-k1')!;
  const candidate = report.aggregates.find((item) => item.policyId === selected)!;
  const rules = report.aggregates.find((item) => item.policyId === 'deterministic')!;
  const confidence = report.confidence;
  const familyNames = Object.keys(baseline.byFamily).filter((name) => name !== 'nominal');
  const outcome = report.decision?.decision ?? `Selected ${labels[selected]}`;
  const reason = report.decision?.reason ?? report.selection!.reason;
  const interval = (value: { lower: number | null; upper: number | null }) =>
    `${percent(value.lower)} to ${percent(value.upper)}`;
  const extraRows = report.aggregates
    .map(
      (m) =>
        `<tr><td>${escapeHtml(labels[m.policyId])}</td><td>${m.falseAlarmEpisodes}</td><td>${m.preOnsetFalseAlarmEpisodes} / ${m.postRecoveryFalseAlarmEpisodes}</td><td>${number(m.falseAlarmsPerSyntheticHour)}</td><td>${number(m.recoveryAlarmMs / 1000)} / ${number(m.postRecoveryAlarmMs / 1000)}</td><td>${m.unobservableFaultMissions} / ${m.nominalUnavailableMissions}</td></tr>`,
    )
    .join('');
  const comparisons =
    report.selection?.comparisons ??
    (report.decision?.comparison ? [report.decision.comparison] : []);
  const comparisonRows = comparisons
    .map(
      (c) =>
        `<tr><td>${escapeHtml(labels[c.candidatePolicyId])}</td><td>${c.constraints.passed ? 'Passed' : 'Failed'}</td><td>${percent(c.constraints.overallRecallDrop)}</td><td>${percent(c.constraints.maximumFamilyRecallDrop)}</td><td>${number(c.constraints.pairedP95AddedDelayMs)} ms<br><small>${c.constraints.pairedDetections} paired detections</small></td><td>${interval(c.confidence.nominalFalseAlarmRateDelta)}</td></tr>`,
    )
    .join('');
  const body = `<header><div class="eyebrow">Flight Diagnostics Workbench · ${escapeHtml(report.manifest.stage)} evidence</div><h1>What happens over a whole mission?</h1><p>Every eligible rolling window is scored, including the quiet periods before and after a fault. This report evaluates the frozen v2 model and a bounded alert-persistence experiment.</p><div class="decision"><strong>${escapeHtml(outcome.toUpperCase())}</strong><br>${escapeHtml(reason)}</div></header>
  <div class="kpis"><div class="kpi"><strong>${report.results.length.toLocaleString('en-US')}</strong>complete synthetic missions</div><div class="kpi"><strong>${report.manifest.seeds.length}</strong>seed groups for paired resampling</div><div class="kpi"><strong>180 samples</strong>180 samples per mission; 39 warmup samples</div></div>
  <section><h2>Detection and false alarms</h2><p>A detection requires a new alarm to begin during the active fault interval. An alarm already active before onset, or first appearing during recovery, does not count as an active-fault detection. Recall measures this strict alert-onset behavior.</p><div class="table"><table><thead><tr><th>Detector</th><th>Active detections / eligible faults</th><th>Misses</th><th>Nominal missions with alarm</th><th>Delay median / p95</th><th>Abstention</th></tr></thead><tbody>${report.aggregates.map((m) => metricsRow(labels[m.policyId]!, m)).join('')}</tbody></table></div><p class="note">Delay includes only detected cases and is shown alongside its denominator. All faults with post-warmup active samples remain in recall, including abstained windows. Rules remain authoritative; learned output is advisory.</p></section>
  <section><h2>Where the detector succeeds and fails</h2><div class="grid"><div><h3>Active-fault recall by family</h3><div class="chart"><canvas id="family" role="img" aria-label="Recall by fault family, with accessible values in the table below"></canvas></div></div><div><h3>False alarms versus recall</h3><div class="chart"><canvas id="tradeoff" role="img" aria-label="Each detector's nominal false alarm rate and active recall, values in the detection table"></canvas></div></div></div><details><summary>Accessible fault-family values</summary><div class="table"><table><thead><tr><th>Fault family</th><th>Original recall</th><th>Selected recall</th><th>Rules recall</th></tr></thead><tbody>${familyNames.map((name) => `<tr><td>${escapeHtml(name)}</td><td>${percent(baseline.byFamily[name]!.activeRecall)}</td><td>${percent(candidate.byFamily[name]!.activeRecall)}</td><td>${percent(rules.byFamily[name]!.activeRecall)}</td></tr>`).join('')}</tbody></table></div></details></section>
  <section><h2>Uncertainty and the experiment decision</h2><p>95% paired percentile bootstrap intervals use 1,000 resamples of complete seed groups. All 41 related missions remain together. These intervals describe variation inside this synthetic generator, not real-world reliability.</p><ul><li>Original nominal-mission false-alarm rate: ${interval(confidence.baselineNominalFalseAlarmRate)}.</li><li>Original active-fault recall: ${interval(confidence.baselineActiveRecall)}.</li><li>Selected minus original false-alarm rate: ${interval(confidence.nominalFalseAlarmRateDelta)}.</li></ul><p>The selected policy is <strong>${escapeHtml(labels[selected])}</strong>. Development limits permit at most 2 percentage points of overall recall loss, 5 points within any fault family, and 5 seconds of p95 added delay among jointly detected cases. A final improvement claim additionally requires the false-alarm difference interval to remain below zero.</p>${comparisonRows ? `<div class="table"><table><thead><tr><th>Policy</th><th>Tradeoff limits</th><th>Overall recall loss</th><th>Worst family loss</th><th>Paired p95 added delay</th><th>False-alarm difference, 95% interval</th></tr></thead><tbody>${comparisonRows}</tbody></table></div>` : '<p>No longer-streak candidate advanced from development. The final set measures the original policy without further tuning.</p>'}</section>
  <section><h2>Exposure, recovery, and unobservable cases</h2><div class="table"><table><thead><tr><th>Detector</th><th>False-alarm starts</th><th>Before onset / after recovery</th><th>Starts per fault-free simulated hour</th><th>Recovery / post-recovery alarm seconds</th><th>Unobservable faults / unavailable nominal missions</th></tr></thead><tbody>${extraRows}</tbody></table></div><p class="note">Exposure uses the interval to the next sample; the final sample has no following exposure. A 180-sample mission spans 179 seconds. Alarm occupancy is distinct from new alarm starts. The JSON also records carryover, active coverage, warmup, missing availability, and per-variant summaries.</p><details><summary>Results by scenario variant</summary><div class="table"><table><thead><tr><th>Original-model variant</th><th>Active detections / eligible faults</th><th>Misses</th><th>Nominal missions with alarm</th><th>Delay median / p95</th><th>Abstention</th></tr></thead><tbody>${Object.entries(
    baseline.byVariant,
  )
    .map(([name, m]) => metricsRow(name, m))
    .join('')}</tbody></table></div></details></section>
  <section><h2>Replay and provenance</h2><p>Default scenarios replay in the existing Investigation view using the recorded scenario, seed, and 180 samples. Severity, duration, and onset variants replay through the CLI. Candidate policy overlays are experimental report results; they are not installed in the application.</p><p><a href="report.json">Machine-readable results</a> · <a href="manifest.json">Frozen run manifest</a> · <a href="../selection.json">Development selection</a></p><p>CLI: <code>pnpm evaluate:missions --stage replay --case-id CASE_ID --from ${report.manifest.stage}</code></p><details><summary>Exact evidence identities</summary><p>Source: <code>${report.manifest.source.sha256}</code></p><p>Git HEAD at capture: <code>${report.manifest.source.gitHead}</code></p><p>Model: <code>${report.manifest.model.artifactSha256}</code></p><p>Results: <code>${report.resultsSha256}</code></p></details><p class="note">The baseline model, generator, and production app remain unchanged. Forty development seeds and eighty final seeds are disjoint from all registered historical model partitions. The final report evaluates only the frozen selection. A failure to improve is a valid experimental result.</p></section>`;
  const colors = ['#3158c9', '#0e846a', '#ae6922', '#8a4fa8', '#526579'];
  const chartCode = `Chart.defaults.font.family='system-ui';Chart.defaults.color='#45556a';const names=${jsonForScript(familyNames)};new Chart(document.getElementById('family'),{type:'bar',data:{labels:names,datasets:${jsonForScript([baseline, ...(selected === 'model-k1' ? [] : [candidate]), rules].map((m, i) => ({ label: labels[m.policyId], data: familyNames.map((name) => (m.byFamily[name]!.activeRecall === null ? null : m.byFamily[name]!.activeRecall! * 100)), backgroundColor: colors[i] })))}},options:{responsive:true,maintainAspectRatio:false,indexAxis:'y',scales:{x:{min:0,max:100,title:{display:true,text:'Active-fault recall (%)'}}},plugins:{legend:{position:'bottom'}}}});new Chart(document.getElementById('tradeoff'),{type:'scatter',data:{datasets:${jsonForScript(report.aggregates.map((m, i) => ({ label: labels[m.policyId], data: m.nominalFalseAlarmRate === null || m.activeRecall === null ? [] : [{ x: m.nominalFalseAlarmRate * 100, y: m.activeRecall * 100 }], backgroundColor: colors[i], pointRadius: 7 })))}},options:{responsive:true,maintainAspectRatio:false,scales:{x:{min:0,max:100,title:{display:true,text:'Nominal missions with an alarm (%)'}},y:{min:0,max:100,title:{display:true,text:'Active-fault recall (%)'}}},plugins:{legend:{position:'bottom'}}}});`;
  await writeFile(
    destination,
    await page('Full-mission evaluation | Flight Diagnostics', body, chartCode),
    'utf8',
  );
}

export async function writeReplayReport(
  record: MissionRecord,
  predictions: readonly PredictionPoint[],
  destination: string,
): Promise<void> {
  const result = record.evaluation;
  const timeline = result.faultTimeline;
  const policyRows = Object.values(result.policies);
  const truth = predictions.map((point) =>
    timeline === null
      ? 0
      : point.sampleIndex >= timeline.onsetIndex && point.sampleIndex <= timeline.activeEndIndex
        ? 1
        : point.sampleIndex > timeline.activeEndIndex &&
            point.sampleIndex <= timeline.recoveryEndIndex
          ? 0.5
          : 0,
  );
  const datasets = [
    {
      label: 'Truth: active 1, recovery 0.5',
      data: truth,
      borderColor: '#a5b1bf',
      borderDash: [5, 5],
      pointRadius: 0,
      stepped: true,
    },
    ...policyRows.map((policy, i) => ({
      label: labels[policy.policyId],
      data: predictions.map((point) =>
        policy.intervals.some(
          (interval) =>
            point.sampleIndex >= interval.startIndex && point.sampleIndex <= interval.endIndex,
        )
          ? 1
          : 0,
      ),
      borderColor: ['#3158c9', '#0e846a', '#ae6922'][i],
      pointRadius: 0,
      stepped: true,
    })),
  ];
  const body = `<header><div class="eyebrow">Exact synthetic mission replay</div><h1>${escapeHtml(record.spec.family)}</h1><p>Seed ${record.spec.options.seed} · ${escapeHtml(record.spec.variantId)} · 180 samples at one-second cadence</p><div class="decision">Recomputed scenario, prediction trace, and evaluated results match their recorded SHA-256 identities.</div></header><section><h2>Fault lifecycle and alerts</h2><div class="chart"><canvas id="timeline" role="img" aria-label="Fault lifecycle and policy alert timelines, exact event boundaries listed below"></canvas></div><p>Index 39 is the first eligible model window. ${timeline ? `Active fault: indices ${timeline.onsetIndex} through ${timeline.activeEndIndex}; recovery ends at ${timeline.recoveryEndIndex}.` : 'This is a nominal mission without an injected fault.'}</p><div class="table"><table><thead><tr><th>Policy</th><th>Active detection</th><th>Delay</th><th>Alarm intervals (inclusive indices)</th></tr></thead><tbody>${policyRows.map((policy) => `<tr><td>${escapeHtml(labels[policy.policyId])}</td><td>${policy.activeDetected === null ? 'Not applicable' : policy.activeDetected ? 'Detected' : 'Missed'}</td><td>${number(policy.detectionDelayMs)} ms</td><td>${policy.intervals.map((interval) => `${interval.startIndex}–${interval.endIndex}`).join(', ') || 'None'}</td></tr>`).join('')}</tbody></table></div></section><section><h2>Reproduce this case</h2><p><code>pnpm evaluate:missions --stage replay --case-id ${escapeHtml(record.spec.caseId)}</code></p><p>${record.spec.variantId === 'default' ? 'This default scenario is also reproducible through the existing Investigation controls.' : 'This parameterized case requires CLI replay; the current app does not expose its severity, duration, and onset overrides.'}</p><pre><code>${escapeHtml(JSON.stringify(record.spec.options, null, 2))}</code></pre><p>Prediction SHA-256: <code>${record.predictionsSha256}</code></p><p>The plot shows binary alert behavior, not calibrated fault probabilities. Experimental streak policies remain outside the production application.</p></section>`;
  await writeFile(
    destination,
    await page(
      `Replay ${record.spec.caseId}`,
      body,
      `new Chart(document.getElementById('timeline'),{type:'line',data:{labels:${jsonForScript(predictions.map((point) => point.sampleIndex))},datasets:${jsonForScript(datasets)}},options:{responsive:true,maintainAspectRatio:false,scales:{x:{title:{display:true,text:'Sample index (one sample per second)'},ticks:{maxTicksLimit:12}},y:{min:0,max:1.1,title:{display:true,text:'Alert active / fault lifecycle'}}},plugins:{legend:{position:'bottom'}}}});`,
    ),
    'utf8',
  );
}
