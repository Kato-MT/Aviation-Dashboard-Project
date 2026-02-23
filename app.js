/* ========================================
   FLIGHT DASHBOARD — app.js
   Core logic: CSV parsing, anomaly detection,
   charting, replay, and incident export
   ======================================== */

// ======== STATE ========
let telemetry = [];
let anomalies = [];
let altChart = null;
let spdChart = null;
let fuelChart = null;
let replayIndex = 0;
let playTimer = null;
let playSpeed = 250; // ms per step

// ======== HELPERS ========
const $ = (id) => document.getElementById(id);

function parseNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function formatNum(n) {
  return n.toLocaleString("en-US");
}

// ======== CLOCK ========
function updateClock() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  $("clock").textContent = `${h}:${m}:${s}`;
}
setInterval(updateClock, 1000);
updateClock();

// ======== ANOMALY DETECTION ========
const thresholds = {
  overspeed_kts: 520,
  rapidDescent_ft: 900,
  rapidWindow_steps: 2,
  fuelSpike_pct: 2.0
};

function detectAnomalies(data) {
  const found = [];

  for (let i = 0; i < data.length; i++) {
    const p = data[i];

    // Overspeed check
    if (p.speed_kts > thresholds.overspeed_kts) {
      found.push({
        type: "OVERSPEED",
        category: "overspeed",
        idx: i,
        timestamp: p.timestamp,
        details: `Speed ${p.speed_kts} kts exceeds ${thresholds.overspeed_kts} kts limit`
      });
    }

    // Rapid descent check
    const j = i + thresholds.rapidWindow_steps;
    if (j < data.length) {
      const future = data[j];
      const drop = p.altitude_ft - future.altitude_ft;
      if (drop > thresholds.rapidDescent_ft) {
        found.push({
          type: "RAPID DESCENT",
          category: "rapid-descent",
          idx: j,
          timestamp: future.timestamp,
          details: `Altitude dropped ${Math.round(drop)} ft within ~${thresholds.rapidWindow_steps * 10}s`
        });
      }
    }

    // Fuel burn spike check
    if (i + 1 < data.length) {
      const next = data[i + 1];
      const fuelDrop = p.fuel_pct - next.fuel_pct;
      if (fuelDrop > thresholds.fuelSpike_pct) {
        found.push({
          type: "FUEL SPIKE",
          category: "fuel-spike",
          idx: i + 1,
          timestamp: next.timestamp,
          details: `Fuel dropped ${fuelDrop.toFixed(1)}% in ~10s interval`
        });
      }
    }
  }

  return found.sort((a, b) => a.idx - b.idx);
}

// ======== DATA LOADING ========
function loadCsvText(csvText) {
  Papa.parse(csvText, {
    header: true,
    skipEmptyLines: true,
    complete: (results) => {
      telemetry = results.data.map((r, idx) => ({
        idx,
        timestamp: (r.timestamp || "").trim(),
        altitude_ft: parseNumber(r.altitude_ft),
        speed_kts: parseNumber(r.speed_kts),
        fuel_pct: parseNumber(r.fuel_pct)
      })).filter(r =>
        r.timestamp && r.altitude_ft !== null && r.speed_kts !== null && r.fuel_pct !== null
      );

      if (telemetry.length === 0) {
        alert("No valid data rows found in CSV.");
        return;
      }

      initDashboard();
    }
  });
}

async function loadDefaultDataset() {
  try {
    const res = await fetch("data/flight.csv");
    if (!res.ok) throw new Error("CSV not found");
    const text = await res.text();
    loadCsvText(text);
  } catch (err) {
    alert("Could not load default dataset. Make sure data/flight.csv exists.");
    console.error(err);
  }
}

// ======== DASHBOARD INIT ========
function initDashboard() {
  stopPlay();
  anomalies = detectAnomalies(telemetry);
  replayIndex = 0;

  setupSlider();
  renderCharts();
  renderAlerts();
  updateReadings(0);
  updateSummary();
  updateStatus();
  enableControls();
}

function enableControls() {
  $("playBtn").disabled = false;
  $("resetBtn").disabled = false;
  $("exportBtn").disabled = false;
  $("replaySlider").disabled = false;
}

// ======== STATUS ========
function updateStatus() {
  const badge = $("statusBadge");
  const text = $("statusText");
  if (telemetry.length === 0) {
    badge.className = "status-badge";
    text.textContent = "NO DATA";
  } else if (anomalies.length > 0) {
    badge.className = "status-badge warning";
    text.textContent = `${anomalies.length} ALERT${anomalies.length > 1 ? "S" : ""}`;
  } else {
    badge.className = "status-badge active";
    text.textContent = "NOMINAL";
  }
}

// ======== SUMMARY ========
function updateSummary() {
  if (telemetry.length === 0) return;

  const first = telemetry[0];
  const last = telemetry[telemetry.length - 1];
  $("sumDuration").textContent = `${first.timestamp} – ${last.timestamp}`;
  $("sumMaxAlt").textContent = formatNum(Math.max(...telemetry.map(p => p.altitude_ft))) + " ft";
  $("sumMaxSpd").textContent = Math.max(...telemetry.map(p => p.speed_kts)) + " kts";
  $("sumFuelUsed").textContent = (first.fuel_pct - last.fuel_pct).toFixed(1) + "%";
  $("sumAnomalies").textContent = anomalies.length;
}

// ======== ALERTS ========
function renderAlerts() {
  const ul = $("alertsList");
  ul.innerHTML = "";
  $("alertCount").textContent = anomalies.length;

  if (anomalies.length === 0) {
    ul.innerHTML = '<li class="alert-empty">No anomalies detected — flight nominal.</li>';
    return;
  }

  for (const a of anomalies) {
    const li = document.createElement("li");
    li.className = "alert-item";
    li.innerHTML = `
      <span class="alert-type ${a.category}">${a.type}</span>
      <span class="alert-timestamp">@ ${a.timestamp}</span>
      <span class="alert-details">${a.details}</span>
    `;
    li.addEventListener("click", () => {
      stopPlay();
      setReplayIndex(a.idx);
    });
    ul.appendChild(li);
  }
}

// ======== READINGS / GAUGES ========
function updateReadings(i) {
  const p = telemetry[i];
  if (!p) return;

  $("curTime").textContent = p.timestamp;
  $("curAlt").textContent = formatNum(p.altitude_ft);
  $("curSpd").textContent = String(p.speed_kts);
  $("curFuel").textContent = p.fuel_pct.toFixed(1);

  // Update indicators in chart headers
  $("altIndicator").textContent = formatNum(p.altitude_ft);
  $("spdIndicator").textContent = p.speed_kts;
  $("fuelIndicator").textContent = p.fuel_pct.toFixed(1) + "%";

  // Gauge bars (normalized)
  const maxAlt = Math.max(...telemetry.map(d => d.altitude_ft)) || 1;
  const maxSpd = Math.max(...telemetry.map(d => d.speed_kts)) || 1;

  $("altFill").style.width = ((p.altitude_ft / maxAlt) * 100) + "%";
  $("spdFill").style.width = ((p.speed_kts / maxSpd) * 100) + "%";
  $("fuelFill").style.width = p.fuel_pct + "%";

  // Highlight gauges if current point has an anomaly
  const currentAnomalies = anomalies.filter(a => a.idx === i);
  const altGauge = $("altGauge");
  const spdGauge = $("spdGauge");
  const fuelGauge = $("fuelGauge");

  altGauge.classList.toggle("alert-active", currentAnomalies.some(a => a.type === "RAPID DESCENT"));
  spdGauge.classList.toggle("alert-active", currentAnomalies.some(a => a.type === "OVERSPEED"));
  fuelGauge.classList.toggle("alert-active", currentAnomalies.some(a => a.type === "FUEL SPIKE"));
}

// ======== CHARTS ========
const chartConfig = {
  alt: { color: "#00e5a0", bgColor: "rgba(0, 229, 160, 0.08)" },
  spd: { color: "#3b82f6", bgColor: "rgba(59, 130, 246, 0.08)" },
  fuel: { color: "#f59e0b", bgColor: "rgba(245, 158, 11, 0.08)" }
};

function buildChart(ctx, labels, values, key) {
  const cfg = chartConfig[key];

  // Find anomaly indices for this chart type
  let anomalyMap = {};
  if (key === "alt") {
    anomalies.filter(a => a.type === "RAPID DESCENT").forEach(a => anomalyMap[a.idx] = true);
  } else if (key === "spd") {
    anomalies.filter(a => a.type === "OVERSPEED").forEach(a => anomalyMap[a.idx] = true);
  } else if (key === "fuel") {
    anomalies.filter(a => a.type === "FUEL SPIKE").forEach(a => anomalyMap[a.idx] = true);
  }

  // Point colors: red for anomaly points, transparent otherwise
  const pointBgColors = labels.map((_, idx) => anomalyMap[idx] ? "#ff3b5c" : "transparent");
  const pointRadii = labels.map((_, idx) => anomalyMap[idx] ? 5 : 0);

  return new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: key.toUpperCase(),
          data: values,
          borderColor: cfg.color,
          backgroundColor: cfg.bgColor,
          borderWidth: 1.5,
          pointRadius: pointRadii,
          pointBackgroundColor: pointBgColors,
          pointBorderColor: pointBgColors,
          fill: true,
          tension: 0.3
        },
        {
          // Replay marker
          label: "Marker",
          data: labels.map(() => null),
          borderWidth: 0,
          pointRadius: 0,
          pointBackgroundColor: "#ffffff",
          pointBorderColor: cfg.color,
          pointBorderWidth: 2,
          showLine: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 0 },
      interaction: { intersect: false, mode: "index" },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#111827",
          titleFont: { family: "'JetBrains Mono', monospace", size: 10 },
          bodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
          borderColor: cfg.color,
          borderWidth: 1,
          padding: 8,
          displayColors: false
        }
      },
      scales: {
        x: {
          ticks: {
            maxTicksLimit: 12,
            font: { family: "'JetBrains Mono', monospace", size: 9 },
            color: "#4a5568"
          },
          grid: { color: "rgba(255,255,255,0.03)" }
        },
        y: {
          ticks: {
            font: { family: "'JetBrains Mono', monospace", size: 9 },
            color: "#4a5568"
          },
          grid: { color: "rgba(255,255,255,0.03)" }
        }
      }
    }
  });
}

function renderCharts() {
  const labels = telemetry.map(p => p.timestamp);

  // Destroy existing charts
  altChart?.destroy();
  spdChart?.destroy();
  fuelChart?.destroy();

  altChart = buildChart($("altChart"), labels, telemetry.map(p => p.altitude_ft), "alt");
  spdChart = buildChart($("spdChart"), labels, telemetry.map(p => p.speed_kts), "spd");
  fuelChart = buildChart($("fuelChart"), labels, telemetry.map(p => p.fuel_pct), "fuel");

  updateReplayMarker(0);
}

function updateReplayMarker(i) {
  if (!altChart || !spdChart || !fuelChart) return;
  if (!telemetry[i]) return;

  const len = telemetry.length;

  const makeMarker = (val) => {
    const arr = new Array(len).fill(null);
    arr[i] = val;
    return arr;
  };

  altChart.data.datasets[1].data = makeMarker(telemetry[i].altitude_ft);
  spdChart.data.datasets[1].data = makeMarker(telemetry[i].speed_kts);
  fuelChart.data.datasets[1].data = makeMarker(telemetry[i].fuel_pct);

  // Show marker point only at current index
  altChart.data.datasets[1].pointRadius = makeMarker(7).map(v => v === null ? 0 : v);
  spdChart.data.datasets[1].pointRadius = makeMarker(7).map(v => v === null ? 0 : v);
  fuelChart.data.datasets[1].pointRadius = makeMarker(7).map(v => v === null ? 0 : v);

  altChart.update("none");
  spdChart.update("none");
  fuelChart.update("none");
}

// ======== REPLAY ========
function setupSlider() {
  const slider = $("replaySlider");
  slider.min = "0";
  slider.max = String(Math.max(telemetry.length - 1, 0));
  slider.value = "0";
  updateReplayCounter();
}

function setReplayIndex(i) {
  replayIndex = Math.max(0, Math.min(i, telemetry.length - 1));
  $("replaySlider").value = String(replayIndex);
  updateReadings(replayIndex);
  updateReplayMarker(replayIndex);
  updateReplayCounter();
}

function updateReplayCounter() {
  $("replayTime").textContent = telemetry.length > 0
    ? `${replayIndex + 1} / ${telemetry.length}`
    : "0 / 0";
}

function play() {
  if (playTimer || telemetry.length === 0) return;

  $("playBtn").disabled = true;
  $("pauseBtn").disabled = false;

  const badge = $("statusBadge");
  if (anomalies.length === 0) {
    badge.className = "status-badge active";
    $("statusText").textContent = "REPLAYING";
  }

  playTimer = setInterval(() => {
    if (replayIndex >= telemetry.length - 1) {
      stopPlay();
      return;
    }
    setReplayIndex(replayIndex + 1);
  }, playSpeed);
}

function stopPlay() {
  if (playTimer) clearInterval(playTimer);
  playTimer = null;
  $("playBtn").disabled = (telemetry.length === 0);
  $("pauseBtn").disabled = true;
  updateStatus();
}

function resetReplay() {
  stopPlay();
  setReplayIndex(0);
}

// ======== EXPORT ========
function exportIncidentReport() {
  const report = {
    reportTitle: "Flight Telemetry Incident Report",
    generatedAt: new Date().toISOString(),
    system: "Flight Telemetry Monitoring Dashboard v1.0",
    detectionThresholds: thresholds,
    flightSummary: {
      totalDataPoints: telemetry.length,
      startTime: telemetry[0]?.timestamp,
      endTime: telemetry[telemetry.length - 1]?.timestamp,
      maxAltitude_ft: Math.max(...telemetry.map(p => p.altitude_ft)),
      maxSpeed_kts: Math.max(...telemetry.map(p => p.speed_kts)),
      startFuel_pct: telemetry[0]?.fuel_pct,
      endFuel_pct: telemetry[telemetry.length - 1]?.fuel_pct,
      fuelConsumed_pct: +(telemetry[0].fuel_pct - telemetry[telemetry.length - 1].fuel_pct).toFixed(1)
    },
    anomalySummary: {
      totalAnomalies: anomalies.length,
      byType: {
        overspeed: anomalies.filter(a => a.type === "OVERSPEED").length,
        rapidDescent: anomalies.filter(a => a.type === "RAPID DESCENT").length,
        fuelSpike: anomalies.filter(a => a.type === "FUEL SPIKE").length
      }
    },
    anomalies: anomalies.map(a => ({
      type: a.type,
      timestamp: a.timestamp,
      dataIndex: a.idx,
      details: a.details,
      readings: {
        altitude_ft: telemetry[a.idx]?.altitude_ft,
        speed_kts: telemetry[a.idx]?.speed_kts,
        fuel_pct: telemetry[a.idx]?.fuel_pct
      }
    }))
  };

  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `incident-report-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ======== EVENT LISTENERS ========

// Load data
$("loadDefaultBtn").addEventListener("click", loadDefaultDataset);

$("fileInput").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => loadCsvText(String(reader.result));
  reader.readAsText(file);
});

// Replay controls
$("replaySlider").addEventListener("input", (e) => {
  stopPlay();
  setReplayIndex(Number(e.target.value));
});

$("playBtn").addEventListener("click", play);
$("pauseBtn").addEventListener("click", stopPlay);
$("resetBtn").addEventListener("click", resetReplay);

// Speed controls
document.querySelectorAll(".btn-speed").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".btn-speed").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    playSpeed = Number(btn.dataset.speed);

    // If currently playing, restart with new speed
    if (playTimer) {
      clearInterval(playTimer);
      playTimer = null;
      play();
    }
  });
});

// Export
$("exportBtn").addEventListener("click", exportIncidentReport);

// ======== AUTO-LOAD ========
loadDefaultDataset();
