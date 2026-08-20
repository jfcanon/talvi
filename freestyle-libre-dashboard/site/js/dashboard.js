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
  currentRoc: document.getElementById('current-roc'),
  currentTrend: document.getElementById('current-trend'),
  sensorId: document.getElementById('sensor-id'),
  sensorLife: document.querySelector('.sensor-life'),
  eventForm: document.getElementById('event-form'),
  eventLabel: document.getElementById('event-label'),
  eventTime: document.getElementById('event-time'),
  eventNote: document.getElementById('event-note'),
  eventCancel: document.getElementById('event-cancel'),
  eventSave: document.getElementById('event-save'),
  lastUpdated: document.getElementById('last-updated'),
  syncStatus: document.getElementById('sync-status'),
  footerTime: document.getElementById('footer-time'),
  chartEmpty: document.getElementById('chart-empty'),
  exportCsv: document.getElementById('export-csv'),
  canvas: document.getElementById('glucose-chart'),
  addEventBtn: document.getElementById('add-event'),
};

let store = { readings: [] };
let currentView = '24h';
let chart = null;

/* ---------- rate-of-change (ROC) ---------- */

function computeROC(readings) {
  if (readings.length < 2) return null;
  const last = readings[readings.length - 1];
  const fifteenMinAgo = new Date(last.ts.getTime() - 15 * 60 * 1000);
  const earlier = readings.find(
    (r) => r.ts >= fifteenMinAgo && r.ts < last.ts
  );
  if (!earlier) return null;
  const deltaGlucose = last.value - earlier.value;
  const deltaMinutes = (last.ts - earlier.ts) / 60000;
  const roc = deltaMinutes > 0 ? deltaGlucose / (deltaMinutes / 15) : 0;
  return Number(roc.toFixed(1));
}

function rocArrowAndColor(roc) {
  if (roc >= 4) return { arrow: '↑', color: 'var(--hypo)' };
  if (roc <= -4) return { arrow: '↓', color: 'var(--hypo)' };
  if (roc > 0) return { arrow: '→', color: 'var(--target)' };
  if (roc < 0) return { arrow: '←', color: 'var(--low)' };
  return { arrow: '→', color: 'var(--target)' };
}

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

  // Time-in-range summary
  const viewReadings = readings.filter((r) => {
    const now = Date.now();
    if (currentView === '24h') return now - r.ts.getTime() <= 86400000;
    if (currentView === '7d') return now - r.ts.getTime() <= 7 * 86400000;
    if (currentView === '30d') return now - r.ts.getTime() <= 30 * 86400000;
    return true; // all
  });

  const zoneCounts = { hypo: 0, low: 0, target: 0, high: 0 };
  viewReadings.forEach((r) => {
    const z = zoneOf(r.value);
    zoneCounts[z]++;
  });
  const total = viewReadings.length || 1;
  const hypoPct = ((zoneCounts.hypo / total) * 100).toFixed(0);
  const lowPct = ((zoneCounts.low / total) * 100).toFixed(0);
  const targetPct = ((zoneCounts.target / total) * 100).toFixed(0);
  const highPct = ((zoneCounts.high / total) * 100).toFixed(0);

  const summaryBar = document.querySelectorAll('.summary-bar-segment');
  summaryBar[0].style.width = `${hypoPct}%`;
  summaryBar[0].setAttribute('aria-label', `${hypoPct}% hypo`);
  summaryBar[1].style.width = `${lowPct}%`;
  summaryBar[1].setAttribute('aria-label', `${lowPct}% low`);
  summaryBar[2].style.width = `${targetPct}%`;
  summaryBar[2].setAttribute('aria-label', `${targetPct}% target`);
  summaryBar[3].style.width = `${highPct}%`;
  summaryBar[3].setAttribute('aria-label', `${highPct}% high`);

  const inRangePct = Number(targetPct);
  document.getElementById('summary-in-range').textContent =
    `${inRangePct}% in range (90–270) last ${currentView}`;

  // Render event markers on chart
  renderEvents(chart, store.readings || []);


function computeSensorLife(readings) {
  if (!readings.length) return { start: null, daysElapsed: 0, pct: 0, remaining: 14, label: '' };
  const earliest = readings[0];
  const now = new Date().getTime();
  const daysElapsed = (now - earliest.ts.getTime()) / 86400000;
  const pct = daysElapsed / 14;
  const remaining = 14 - daysElapsed;

  let label;
  if (store.sensor_id) {
    const sensorDate = new Date(earliest.ts);
    const opts = { year: 'numeric', month: 'short', day: 'numeric' };
    label = `Sensor active since ${sensorDate.toLocaleDateString(undefined, opts)} — ${Math.round(daysElapsed)} of 14 days remaining`;
  } else {
    label = 'estimate from first observed reading (not official activation date)';
  }

  return {
    start: earliest.ts,
    daysElapsed: Math.round(daysElapsed),
    pct: Math.min(Math.max(pct, 0), 1),
    remaining: Math.max(Math.round(remaining), 0),
    label,
  };
}


function updateMetrics(readings) {
  if (!readings.length) {
    els.currentGlucose.textContent = '—';
    els.currentStatus.textContent = '';
    els.currentTrend.textContent = '—';
    els.currentRoc.textContent = '';
    els.sensorId.textContent = store.sensor_id || '—';
    els.lastUpdated.textContent = '—';
    return;
  }
  const last = readings[readings.length - 1];
  const zone = zoneOf(last.value);
  const roc = computeROC(readings);
  els.currentGlucose.textContent = Math.round(last.value);
  els.currentGlucose.className = `metric-value value-${zone}`;
  els.currentUnit.textContent = last.unit;
  els.currentStatus.textContent = zoneLabel(zone);
  els.currentStatus.className = `metric-status value-${zone}`;
  els.currentTrend.textContent = store.trend || '—';
  // Rate-of-change badge
  els.currentRoc.textContent = roc
    ? `${rocArrowAndColor(roc).arrow} ${Math.abs(roc).toFixed(1)} mg/dL/15min`
    : '';
  els.currentRoc.style.color = rocArrowAndColor(roc).color;
  els.sensorId.textContent = store.sensor_id || '—';

  // Sensor life countdown
  const sensorLife = computeSensorLife(readings);
  if (sensorLife.start) {
    const startDate = new Date(sensorLife.start);
    const opts = { year: 'numeric', month: 'short', day: 'numeric' };
    const startStr = startDate.toLocaleDateString(undefined, opts);
    els.sensorLife.innerHTML = `
      <div class="sensor-life-text">${sensorLife.label}</div>
      <progress class="sensor-life-progress" value="${sensorLife.pct * 100}" max="100"></progress>
      <span>${sensorLife.remaining} of 14 days remaining</span>
    `;
  } else {
    els.sensorLife.innerHTML = '';
  }
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



function loadEvents() {
  const raw = localStorage.getItem('leoncito-events');
  return raw ? JSON.parse(raw) : [];
}

function saveEvents(events) {
  localStorage.setItem('leoncito-events', JSON.stringify(events));
}

function renderEvents(chart, readings) {
  const events = loadEvents();
  if (!events.length) {
    if (chart.data.datasets[1]) {
      chart.data.datasets.pop();
      chart.update();
    }
    return;
  }

  // Filter events to current view
  const now = Date.now();
  const viewStart = now - (currentView === '24h' ? 86400000 : currentView === '7d' ? 7 * 86400000 : currentView === '30d' ? 30 * 86400000 : 0);

  const viewEvents = events.filter((e) => new Date(e.timestamp).getTime() >= viewStart);

  // Build data for event markers: find closest reading index for each event
  const dataset = {
    label: 'Events',
    data: [],
    pointRadius: 6,
    pointStyle: 'triangle',
    borderColor: 'orange',
    backgroundColor: 'orange',
    fill: false,
    tension: 0,
  };

  viewEvents.forEach((e) => {
    const ts = new Date(e.timestamp).getTime();
    // Find closest reading index in the current view
    const viewReadings = (store.readings || [])
      .map(r => ({ ...parseReading(r), ts: new Date(r.timestamp).getTime() }))
      .sort((a, b) => a.ts - b.ts);

    const inView = viewReadings.filter(r => r.ts >= viewStart && r.ts <= now);
    if (!inView.length) return;

    const closest = inView.reduce((a, b) => Math.abs(a.ts - ts) < Math.abs(b.ts - ts) ? a : b);
    const idx = viewReadings.indexOf(closest);

    // Only add if index is within the current view's data range
    if (idx >= 0 && idx < (chart.data.labels ? chart.data.labels.length : 0)) {
      dataset.data.push({ x: idx, y: closest.value });
    }
  });

  if (dataset.data.length > 0) {
    chart.data.datasets.push(dataset);
    chart.update();
  } else if (chart.data.datasets.length > 1) {
    chart.data.datasets.pop();
    chart.update();
  }
}

function bindEvent() {
  const form = els.eventForm;
  const overlay = form.querySelector('.event-form-overlay');

  // Show form
  els.addEventBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    form.hidden = false;
    overlay.hidden = false;
    els.eventLabel.focus();
  });

  // Hide form when clicking outside
  document.addEventListener('click', (e) => {
    if (e.target === form || e.target === overlay) {
      form.hidden = true;
      overlay.hidden = true;
    }
  });

  // Form save
  els.eventSave.addEventListener('click', () => {
    const label = els.eventLabel.value;
    const time = els.eventTime.value;
    const note = els.eventNote.value.trim();

    if (!time) return;

    const event = {
      timestamp: time,
      label,
      note,
    };

    let events = loadEvents();
    // Avoid duplicates at the same time
    const existingIdx = events.findIndex(e => e.timestamp === time && e.label === label);
    if (existingIdx >= 0) events.splice(existingIdx, 1);

    events.push(event);
    saveEvents(events);

    // Re-render events on chart
    renderEvents(chart, store.readings || []);

    form.hidden = true;
    overlay.hidden = true;
    els.eventLabel.value = '';
    els.eventTime.value = '';
    els.eventNote.value = '';
  });

  // Form cancel
  els.eventCancel.addEventListener('click', () => {
    form.hidden = true;
    overlay.hidden = true;
    els.eventLabel.value = '';
    els.eventTime.value = '';
    els.eventNote.value = '';
  });
}

/* ---------- boot ---------- */

bindTabs();
bindCsv();
bindEvent();
loadData();
setInterval(loadData, REFRESH_MS);
