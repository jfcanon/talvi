/* Leoncito dashboard — Chart.js glucose views for a diabetic cat.
 * Data contract: data/glucose.json with { readings: [{timestamp, glucose, unit}], ... }
 */

'use strict';

// Cat glucose zones (mg/dL). Diabetic cat target range is 90-270.
const ZONES = { HYPO: 70, LOW: 90, TARGET_HIGH: 270 };
const REFRESH_MS = 5 * 60 * 1000; // optional auto-refresh
const SENSOR_LIFE_DAYS = 14;
const EVENTS_STORAGE_KEY = 'leoncito-events';

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
  rocBadge: document.getElementById('roc-badge'),
  sensorLife: document.getElementById('sensor-life'),
  sensorLifeFill: document.getElementById('sensor-life-fill'),
  sensorLifeText: document.getElementById('sensor-life-text'),
  tirCard: document.querySelector('.tir-card'),
  tirViewLabel: document.getElementById('tir-view-label'),
  tirHypo: document.getElementById('tir-hypo'),
  tirLow: document.getElementById('tir-low'),
  tirTarget: document.getElementById('tir-target'),
  tirHigh: document.getElementById('tir-high'),
  tirStats: document.getElementById('tir-stats'),
  eventForm: document.getElementById('event-form'),
  eventType: document.getElementById('event-type'),
  eventTime: document.getElementById('event-time'),
  eventNote: document.getElementById('event-note'),
  eventsList: document.getElementById('events-list'),
};

let store = { readings: [] };
let currentView = '24h';
let chart = null;
let events = [];

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

function fmtDateTimeLocal(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

/* ---------- F1: Rate of Change ---------- */

function computeROC(readings) {
  if (readings.length < 2) return null;
  const last = readings[readings.length - 1];
  const targetTime = last.ts.getTime() - 15 * 60 * 1000; // ~15 min ago
  let bestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < readings.length - 1; i++) {
    const diff = Math.abs(readings[i].ts.getTime() - targetTime);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  const prev = readings[bestIdx];
  const delta = last.value - prev.value;
  const mins = (last.ts - prev.ts) / 60000;
  if (mins <= 0) return null;
  const per15 = (delta / mins) * 15;
  return { value: per15, delta, mins };
}

function rocArrow(roc) {
  if (!roc) return '';
  const v = roc.value;
  if (v > 4) return '↑';
  if (v > 1.5) return '↗';
  if (v < -4) return '↓';
  if (v < -1.5) return '↘';
  return '→';
}

function rocClass(roc) {
  if (!roc) return '';
  const v = roc.value;
  if (Math.abs(v) > 4) return 'roc-fast';
  if (Math.abs(v) > 1.5) return 'roc-moderate';
  return 'roc-stable';
}

function updateROCBade(readings) {
  const roc = computeROC(readings);
  if (!roc) {
    els.rocBadge.hidden = true;
    els.rocBadge.textContent = '';
    return;
  }
  const arrow = rocArrow(roc);
  const cls = rocClass(roc);
  els.rocBadge.hidden = false;
  els.rocBadge.textContent = `${arrow} ${roc.value > 0 ? '+' : ''}${roc.value.toFixed(1)} mg/dL/15m`;
  els.rocBadge.className = `roc-badge ${cls}`;
}

/* ---------- F2: Time in Range ---------- */

function computeTIR(readings, view) {
  const now = Date.now();
  const dayMs = 86400000;
  let filtered;
  if (view === '24h') {
    filtered = readings.filter((r) => now - r.ts.getTime() <= dayMs);
  } else if (view === '7d') {
    filtered = readings.filter((r) => r.ts.getTime() >= now - 7 * dayMs);
  } else if (view === '30d') {
    filtered = readings.filter((r) => r.ts.getTime() >= now - 30 * dayMs);
  } else {
    filtered = readings;
  }
  if (!filtered.length) return null;
  const counts = { hypo: 0, low: 0, target: 0, high: 0 };
  filtered.forEach((r) => counts[zoneOf(r.value)]++);
  const total = filtered.length;
  return {
    hypo: (counts.hypo / total) * 100,
    low: (counts.low / total) * 100,
    target: (counts.target / total) * 100,
    high: (counts.high / total) * 100,
    total,
  };
}

function updateTIR(readings) {
  const tir = computeTIR(readings, currentView);
  if (!tir) {
    els.tirCard.hidden = true;
    return;
  }
  els.tirCard.hidden = false;
  els.tirViewLabel.textContent = `(${currentView})`;
  els.tirHypo.style.width = `${tir.hypo.toFixed(1)}%`;
  els.tirLow.style.width = `${tir.low.toFixed(1)}%`;
  els.tirTarget.style.width = `${tir.target.toFixed(1)}%`;
  els.tirHigh.style.width = `${tir.high.toFixed(1)}%`;
  const inRange = tir.target.toFixed(0);
  els.tirStats.innerHTML = `
    <span class="tir-stat tir-stat-hypo">${tir.hypo.toFixed(0)}% hypo</span>
    <span class="tir-stat tir-stat-low">${tir.low.toFixed(0)}% low</span>
    <span class="tir-stat tir-stat-target">${inRange}% in range (90–270)</span>
    <span class="tir-stat tir-stat-high">${tir.high.toFixed(0)}% high</span>
    <span class="tir-count">${tir.total} readings</span>
  `;
}

/* ---------- F3: Sensor Life Countdown ---------- */

function computeSensorLife(readings, sensorId) {
  if (!readings.length || !sensorId) return null;
  // Since we don't have per-reading sensor_id in the data, estimate from the first reading overall
  // This is a best-effort estimate as noted in the UI
  const first = readings[0];
  const start = first.ts.getTime();
  const now = Date.now();
  const elapsedDays = (now - start) / 86400000;
  const remainingDays = SENSOR_LIFE_DAYS - elapsedDays;
  const pct = Math.min(100, Math.max(0, (elapsedDays / SENSOR_LIFE_DAYS) * 100));
  return {
    elapsedDays: Math.max(0, elapsedDays),
    remainingDays,
    pct,
    expired: remainingDays <= 0,
    startDate: first.ts,
  };
}

function updateSensorLife(readings) {
  const sensorId = store.sensor_id;
  const life = computeSensorLife(readings, sensorId);
  if (!life) {
    els.sensorLife.hidden = true;
    return;
  }
  els.sensorLife.hidden = false;
  els.sensorLifeFill.style.width = `${life.pct.toFixed(1)}%`;
  els.sensorLifeFill.setAttribute('aria-valuenow', life.pct.toFixed(1));
  if (life.expired) {
    els.sensorLifeText.textContent = `Sensor change due (${life.elapsedDays.toFixed(1)} days elapsed)`;
    els.sensorLifeFill.classList.add('sensor-expired');
  } else {
    els.sensorLifeText.textContent = `Day ${life.elapsedDays.toFixed(1)} of ${SENSOR_LIFE_DAYS} · ${life.remainingDays.toFixed(1)} days remaining`;
    els.sensorLifeFill.classList.remove('sensor-expired');
  }
}

/* ---------- F4: Logbook Events ---------- */

function loadEvents() {
  try {
    const stored = localStorage.getItem(EVENTS_STORAGE_KEY);
    events = stored ? JSON.parse(stored) : [];
    // Convert timestamp strings back to Date objects
    events.forEach((e) => { e.ts = new Date(e.timestamp); });
    events.sort((a, b) => a.ts - b.ts);
  } catch (e) {
    events = [];
  }
}

function saveEvents() {
  const toStore = events.map((e) => ({
    type: e.type,
    timestamp: e.ts.toISOString(),
    note: e.note || '',
  }));
  localStorage.setItem(EVENTS_STORAGE_KEY, JSON.stringify(toStore));
}

function eventIcon(type) {
  return { food: '🍽️', insulin: '💉', exercise: '🏃', other: '📝' }[type] || '📝';
}

function eventColor(type) {
  return {
    food: '#34d399',
    insulin: '#f43f5e',
    exercise: '#38bdf8',
    other: '#facc15',
  }[type] || '#facc15';
}

function renderEventsList() {
  if (!events.length) {
    els.eventsList.innerHTML = '<p class="events-empty">No events logged yet.</p>';
    return;
  }
  els.eventsList.innerHTML = events
    .slice()
    .reverse()
    .map((e) => `
      <div class="event-item" data-id="${e.id}">
        <span class="event-icon">${eventIcon(e.type)}</span>
        <span class="event-time">${e.ts.toLocaleString()}</span>
        <span class="event-type">${e.type}</span>
        ${e.note ? `<span class="event-note">${e.note}</span>` : ''}
        <button class="event-delete" data-id="${e.id}" aria-label="Delete event">×</button>
      </div>
    `).join('');
}

function addEvent(type, time, note) {
  const evt = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    type,
    ts: new Date(time),
    note: note || '',
  };
  events.push(evt);
  events.sort((a, b) => a.ts - b.ts);
  saveEvents();
  renderEventsList();
  renderChartWithEvents();
}

function deleteEvent(id) {
  events = events.filter((e) => e.id !== id);
  saveEvents();
  renderEventsList();
  renderChartWithEvents();
}

function bindEvents() {
  els.eventForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const type = els.eventType.value;
    const time = els.eventTime.value;
    const note = els.eventNote.value.trim();
    if (!time) return;
    addEvent(type, time, note);
    els.eventForm.reset();
    // Set default time to now
    els.eventTime.value = fmtDateTimeLocal(new Date());
  });

  els.eventsList.addEventListener('click', (e) => {
    if (e.target.classList.contains('event-delete')) {
      deleteEvent(e.target.dataset.id);
    }
  });

  // Set default time to now
  els.eventTime.value = fmtDateTimeLocal(new Date());
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

function eventAnnotationData(readings) {
  // Filter events that fall within the current view's time range
  const now = Date.now();
  const dayMs = 86400000;
  let since = 0;
  if (currentView === '24h') since = now - dayMs;
  else if (currentView === '7d') since = now - 7 * dayMs;
  else if (currentView === '30d') since = now - 30 * dayMs;

  const viewStart = since || readings[0]?.ts?.getTime() || 0;
  const viewEnd = readings.length ? readings[readings.length - 1].ts.getTime() : now;

  return events
    .filter((e) => e.ts.getTime() >= viewStart && e.ts.getTime() <= viewEnd)
    .map((e) => ({
      type: 'point',
      xValue: e.ts.toISOString(),
      yValue: 320, // Above chart max, will be positioned via yScale
      backgroundColor: eventColor(e.type),
      borderColor: '#fff',
      borderWidth: 2,
      radius: 8,
      pointStyle: 'triangle',
      rotation: 0,
      label: {
        enabled: true,
        content: `${eventIcon(e.type)} ${e.type}${e.note ? ': ' + e.note : ''}`,
        position: 'center',
        backgroundColor: eventColor(e.type),
        color: '#000',
        font: { size: 10, weight: 'bold' },
        padding: 4,
      },
    }));
}

function renderChartWithEvents() {
  if (!chart) return;
  const readings = (store.readings || []).map(parseReading).sort((a, b) => a.ts - b.ts);
  const { labels, values } = buildView(currentView, readings);
  const [r, g, b] = accentRGB();

  const eventAnnotations = eventAnnotationData(readings);

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

  // Update annotations with events
  chart.options.plugins.annotation.annotations = {
    ...annotationConfig().annotation.annotations,
  };
  eventAnnotations.forEach((ann, i) => {
    chart.options.plugins.annotation.annotations[`event-${i}`] = ann;
  });

  chart.update();
}

function render() {
  const readings = (store.readings || []).map(parseReading).sort((a, b) => a.ts - b.ts);
  updateMetrics(readings);
  updateSync(readings);
  updateROCBade(readings);
  updateTIR(readings);
  updateSensorLife(readings);

  if (!chart) chart = createChart();
  if (!chart) return;

  renderChartWithEvents();

  els.chartEmpty.hidden = values.length > 0;
}

function updateMetrics(readings) {
  if (!readings.length) {
    els.currentGlucose.textContent = '—';
    els.currentStatus.textContent = '';
    els.currentTrend.textContent = '—';
    els.sensorId.textContent = store.sensor_id || '—';
    els.lastUpdated.textContent = '—';
    els.rocBadge.hidden = true;
    els.sensorLife.hidden = true;
    els.tirCard.hidden = true;
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
    loadEvents();
    render();
  } catch (err) {
    store = { readings: [] };
    loadEvents();
    updateMetrics([]);
    updateSync([]);
    showEmpty('Could not load glucose data.');
    if (chart) { chart.data.labels = []; chart.data.datasets = [{ data: [] }]; chart.update(); }
    console.error('Leoncito: failed to load data', err);
  }
}

/* ---------- CSV Export (with events) ---------- */

function bindCsv() {
  els.exportCsv.addEventListener('click', () => {
    const readings = (store.readings || []).map(parseReading).sort((a, b) => a.ts - b.ts);
    const rows = [['timestamp', 'glucose', 'unit']];
    readings.forEach((r) => rows.push([r.ts.toISOString(), r.value, r.unit]));
    // Add events section
    if (events.length) {
      rows.push([]);
      rows.push(['--- Events ---']);
      rows.push(['timestamp', 'type', 'note']);
      events.forEach((e) => rows.push([e.ts.toISOString(), e.type, e.note || '']));
    }
    const csv = rows.map((row) => row.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `leoncito-glucose-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
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

/* ---------- boot ---------- */

bindTabs();
bindCsv();
bindEvents();
loadData();
setInterval(loadData, REFRESH_MS);
