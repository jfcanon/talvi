/* Leoncito dashboard — Chart.js glucose views for a diabetic cat.
 * Data contract: data/glucose.json with { readings: [{timestamp, glucose, unit}], ... }
 */

'use strict';

// Cat glucose zones (mg/dL). Diabetic cat target range is 90-270.
const ZONES = { HYPO: 70, LOW: 90, TARGET_HIGH: 270 };
const REFRESH_MS = 5 * 60 * 1000; // optional auto-refresh

const DATA_URL = 'data/glucose.json';
const VIEWS = ['24h', '7d', '30d', 'all'];

const els = {
  currentGlucose: document.getElementById('current-glucose'),
  currentUnit: document.getElementById('current-unit'),
  currentStatus: document.getElementById('current-status'),
  currentTrend: document.getElementById('current-trend'),
  sensorId: document.getElementById('sensor-id'),
  lastUpdated: document.getElementById('last-updated'),
  syncStatus: document.getElementById('sync-status'),
  footerTime: document.getElementById('footer-time'),
  chartEmpty: document.getElementById('chart-empty'),
  exportCsv: document.getElementById('export-csv'),
  canvas: document.getElementById('glucose-chart'),
};

let store = { readings: [] };
let currentView = '24h';
let chart = null;

/* ---------- helpers ---------- */

function parseReading(r) {
  return { ts: new Date(r.timestamp), value: Number(r.glucose), unit: r.unit || 'mg/dL' };
}

function zoneOf(v) {
  if (v < ZONES.HYPO) return 'hypo';
  if (v < ZONES.LOW) return 'low';
  if (v <= ZONES.TARGET_HIGH) return 'target';
  return 'high';
}

function fmtTime(d) {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtDate(d) {
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function fmtShortDate(d) {
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric' });
}

function isoDateKey(d) {
  return d.toLocaleDateString('en-CA'); // YYYY-MM-DD local
}

function weekKey(d) {
  // Monday-based ISO-ish week key for grouping weekly averages.
  const copy = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = copy.getUTCDay() || 7;
  copy.setUTCDate(copy.getUTCDate() + 4 - day); // nearest Thursday
  const year = copy.getUTCFullYear();
  const first = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((copy - first) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function accentRGB() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const m = raw.match(/#([0-9a-f]{6})/i);
  if (!m) return [45, 212, 191];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function gradientFill(ctx, chartArea) {
  if (!chartArea) return `rgba(${accentRGB()},0.15)`;
  const [r, g, b] = accentRGB();
  const grad = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
  grad.addColorStop(0, `rgba(${r},${g},${b},0.35)`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0.02)`);
  return grad;
}

/* ---------- aggregation ---------- */

function avg(vals) {
  return vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
}

function buildView(view, readings) {
  const now = Date.now();
  const dayMs = 86400000;

  if (view === '24h') {
    const pts = readings.filter((r) => now - r.ts.getTime() <= dayMs);
    return {
      labels: pts.map((r) => fmtTime(r.ts)),
      values: pts.map((r) => r.value),
    };
  }

  if (view === '7d') {
    return aggregateDaily(readings, now - 7 * dayMs, (d) => fmtShortDate(d));
  }

  if (view === '30d') {
    return aggregateDaily(readings, now - 30 * dayMs, (d) => fmtDate(d));
  }

  // all time — weekly averages
  const buckets = new Map();
  readings.forEach((r) => {
    const k = weekKey(r.ts);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r.value);
  });
  const keys = [...buckets.keys()].sort();
  // label with the first day of the bucket's month/day
  const labels = keys.map((k) => {
    const [y, w] = k.split('-W');
    const d = new Date(Date.UTC(Number(y), 0, 1 + (Number(w) - 1) * 7));
    return `Wk ${w} ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
  });
  return { labels, values: keys.map((k) => avg(buckets.get(k))) };
}

function aggregateDaily(readings, since, labelFn) {
  const buckets = new Map();
  readings
    .filter((r) => r.ts.getTime() >= since)
    .forEach((r) => {
      const k = isoDateKey(r.ts);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(r.value);
    });
  const keys = [...buckets.keys()].sort();
  return {
    labels: keys.map((k) => labelFn(new Date(`${k}T12:00:00`))),
    values: keys.map((k) => avg(buckets.get(k))),
  };
}

/* ---------- chart ---------- */

function annotationConfig() {
  return {
    annotation: {
      drawTime: 'beforeDatasetsDraw',
      annotations: {
        targetBox: {
          type: 'box',
          yMin: ZONES.LOW,
          yMax: ZONES.TARGET_HIGH,
          backgroundColor: 'rgba(52,211,153,0.08)',
          borderWidth: 0,
        },
        hypoLine: {
          type: 'line',
          yMin: ZONES.HYPO,
          yMax: ZONES.HYPO,
          borderColor: '#f43f5e',
          borderDash: [6, 6],
          borderWidth: 1,
          label: { content: 'hypo 70', enabled: true, position: 'start', display: true },
        },
        targetLow: {
          type: 'line',
          yMin: ZONES.LOW,
          yMax: ZONES.LOW,
          borderColor: '#34d399',
          borderDash: [4, 4],
          borderWidth: 1,
          label: { content: 'target 90', enabled: true, position: 'start', display: true },
        },
        targetHigh: {
          type: 'line',
          yMin: ZONES.TARGET_HIGH,
          yMax: ZONES.TARGET_HIGH,
          borderColor: '#facc15',
          borderDash: [4, 4],
          borderWidth: 1,
          label: { content: 'target 270', enabled: true, position: 'start', display: true },
        },
      },
    },
  };
}

function createChart() {
  if (typeof Chart === 'undefined') {
    showEmpty('Chart.js failed to load (CDN blocked?).');
    return;
  }
  const [r, g, b] = accentRGB();
  chart = new Chart(els.canvas, {
    type: 'line',
    data: { labels: [], datasets: [{ data: [] }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => items[0].label,
            label: (item) => `Glucose: ${Math.round(item.parsed.y)} mg/dL`,
          },
        },
        annotation: {
          annotations: annotationConfig().annotation.annotations,
        },
      },
      scales: {
        y: {
          title: { display: true, text: 'mg/dL' },
          suggestedMin: 40,
          suggestedMax: 300,
          ticks: { color: getComputedStyle(document.documentElement).getPropertyValue('--text-muted') || '#8fa3bf' },
          grid: { color: 'rgba(128,148,180,0.12)' },
        },
        x: {
          ticks: { maxTicksLimit: 12, color: getComputedStyle(document.documentElement).getPropertyValue('--text-muted') || '#8fa3bf' },
          grid: { display: false },
        },
      },
    },
  });
  return chart;
}

function render() {
  const readings = (store.readings || []).map(parseReading).sort((a, b) => a.ts - b.ts);
  updateMetrics(readings);
  updateSync(readings);

  if (!chart) chart = createChart();
  if (!chart) return;

  const { labels, values } = buildView(currentView, readings);
  const [r, g, b] = accentRGB();

  chart.data.labels = labels;
  chart.data.datasets = [{
    label: 'Glucose',
    data: values,
    borderColor: `rgb(${r},${g},${b})`,
    borderWidth: 2,
    tension: 0.25,
    pointRadius: 0,
    pointHitRadius: 8,
    fill: true,
    backgroundColor: (ctx) => gradientFill(ctx.chart.ctx, ctx.chart.chartArea),
  }];
  chart.update();

  els.chartEmpty.hidden = values.length > 0;
}

function updateMetrics(readings) {
  if (!readings.length) {
    els.currentGlucose.textContent = '—';
    els.currentStatus.textContent = '';
    els.currentTrend.textContent = '—';
    els.sensorId.textContent = store.sensor_id || '—';
    els.lastUpdated.textContent = '—';
    return;
  }
  const last = readings[readings.length - 1];
  const zone = zoneOf(last.value);
  els.currentGlucose.textContent = Math.round(last.value);
  els.currentGlucose.className = `metric-value value-${zone}`;
  els.currentUnit.textContent = last.unit;
  els.currentStatus.textContent = zoneLabel(zone);
  els.currentStatus.className = `metric-status value-${zone}`;
  els.currentTrend.textContent = store.trend || '—';
  els.sensorId.textContent = store.sensor_id || '—';
  els.lastUpdated.textContent = fmtTime(last.ts);
}

function zoneLabel(zone) {
  return { hypo: 'hypoglycaemic', low: 'low', target: 'in range', high: 'high' }[zone] || '';
}

function updateSync(readings) {
  const when = readings.length
    ? fmtTime(readings[readings.length - 1].ts)
    : (store.last_updated ? new Date(store.last_updated).toLocaleString() : 'never');
  els.syncStatus.textContent = `Last sync: ${when}`;
  els.footerTime.textContent = `synced ${when}`;
}

function showEmpty(msg) {
  els.chartEmpty.textContent = msg;
  els.chartEmpty.hidden = false;
}

/* ---------- data loading ---------- */

async function loadData() {
  try {
    const res = await fetch(DATA_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    store = await res.json();
    render();
  } catch (err) {
    store = { readings: [] };
    updateMetrics([]);
    updateSync([]);
    showEmpty('Could not load glucose data.');
    if (chart) { chart.data.labels = []; chart.data.datasets = [{ data: [] }]; chart.update(); }
    console.error('Leoncito: failed to load data', err);
  }
}

/* ---------- interactions ---------- */

function bindTabs() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentView = btn.id.replace('tab-', '');
      document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', b === btn ? 'true' : 'false'));
      render();
    });
  });
}

function bindCsv() {
  els.exportCsv.addEventListener('click', () => {
    const rows = [['timestamp', 'glucose', 'unit']];
    (store.readings || []).forEach((r) => rows.push([r.timestamp, r.glucose, r.unit]));
    const csv = rows.map((row) => row.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `leoncito-glucose-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

/* ---------- boot ---------- */

bindTabs();
bindCsv();
loadData();
setInterval(loadData, REFRESH_MS);
