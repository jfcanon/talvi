/* Leoncito dashboard — Chart.js glucose views for a diabetic cat.
 * Data contract: API returns { readings: [{timestamp, glucose, unit}], events: [...], ... }
 */

'use strict';

// Cat glucose zones (mg/dL). Diabetic cat target range is 90-270.
const ZONES = { HYPO: 70, LOW: 90, TARGET_HIGH: 270 };
const REFRESH_MS = 5 * 60 * 1000; // optional auto-refresh

// API endpoint - can be overridden via <meta name="glucose-api" content="..."> in HTML
const META_API = document.querySelector('meta[name="glucose-api"]');
const DATA_URL = META_API?.content || 'data/glucose.json'; // fallback to static file
const META_INSULIN_API = document.querySelector('meta[name="insulin-api"]');
const INSULIN_API = META_INSULIN_API?.content || '/api/insulin';
const INSULIN_CACHE_KEY = 'leoncito-insulin-cache'; // offline/device-local fallback
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
  // F1: Rate of change
  rocValue: document.getElementById('roc-value'),
  rocUnit: document.getElementById('roc-unit'),
  rocArrow: document.getElementById('roc-arrow'),
  // F2: Time in range
  tirTarget: document.getElementById('tir-target'),
  tirLow: document.getElementById('tir-low'),
  tirHypo: document.getElementById('tir-hypo'),
  tirHigh: document.getElementById('tir-high'),
  tirHypoCount: document.getElementById('tir-hypo-count'),
  tirHyperCount: document.getElementById('tir-hyper-count'),
  tirMin: document.getElementById('tir-min'),
  tirMax: document.getElementById('tir-max'),
  // F3: Sensor life
  sensorLifeElapsed: document.getElementById('sensor-life-elapsed'),
  sensorLifeLeft: document.getElementById('sensor-life-left'),
  sensorLifeExpires: document.getElementById('sensor-life-expires'),
  sensorLifeStatus: document.getElementById('sensor-life-status'),
  // NID-402: insulin tracker
  calGrid: document.getElementById('cal-grid'),
  calMonthLabel: document.getElementById('cal-month-label'),
  calPrev: document.getElementById('cal-prev'),
  calNext: document.getElementById('cal-next'),
  shotList: document.getElementById('shot-list'),
  dayTitle: document.getElementById('insulin-day-title'),
  shotTime: document.getElementById('shot-time'),
  shotNote: document.getElementById('shot-note'),
  shotAdd: document.getElementById('shot-add'),
  addNow: document.getElementById('insulin-add-now'),
  saveBtn: document.getElementById('insulin-save'),
  statusLine: document.getElementById('insulin-status'),
};

let store = { readings: [], events: [] };
let currentView = '24h';
let chart = null;

// Insulin tracker state. shots = persisted truth (server or cache);
// pendingAdds / pendingDeletes are unsaved local edits (Save button syncs).
let insulin = { shots: [], pendingAdds: [], pendingDeletes: new Set(), online: null };
let calCursor = startOfDay(new Date());
let selectedDayKey = isoDateKey(new Date());

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
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

/* ---------- F1: Rate of Change (velocity) ---------- */

function computeROC(readings) {
  if (readings.length < 2) return { rocPerHour: null, rocPerMin: null, arrow: '—' };
  const last = readings[readings.length - 1];
  const prev = readings[readings.length - 2];
  const dtHours = (last.ts - prev.ts) / 3600000; // hours between readings
  if (dtHours <= 0) return { rocPerHour: null, rocPerMin: null, arrow: '—' };
  const rocPerHour = (last.value - prev.value) / dtHours;
  const rocPerMin = rocPerHour / 60;
  let arrow = '→';
  if (rocPerHour > 2) arrow = '↑↑';
  else if (rocPerHour > 0.5) arrow = '↑';
  else if (rocPerHour < -2) arrow = '↓↓';
  else if (rocPerHour < -0.5) arrow = '↓';
  return { rocPerHour, rocPerMin, arrow };
}

/* ---------- F2: Time in Range + Excursions ---------- */

function computeTimeInRange(readings) {
  if (!readings.length) return null;
  const values = readings.map(r => r.value);
  const total = values.length;
  let hypo = 0, low = 0, target = 0, high = 0;
  let hypoEvents = 0, hyperEvents = 0;
  let inHypo = false, inHyper = false;
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);

  for (const v of values) {
    const z = zoneOf(v);
    if (z === 'hypo') { hypo++; if (!inHypo) { hypoEvents++; inHypo = true; } else inHypo = false; }
    else if (z === 'low') { low++; inHypo = false; }
    else if (z === 'target') { target++; inHypo = false; inHyper = false; }
    else { high++; if (!inHyper) { hyperEvents++; inHyper = true; } else inHyper = false; }
  }

  return {
    total,
    targetPct: total ? Math.round((target / total) * 100 * 10) / 10 : 0,
    lowPct: total ? Math.round((low / total) * 100 * 10) / 10 : 0,
    hypoPct: total ? Math.round((hypo / total) * 100 * 10) / 10 : 0,
    highPct: total ? Math.round((high / total) * 100 * 10) / 10 : 0,
    hypoEvents,
    hyperEvents,
    minVal,
    maxVal,
  };
}

/* ---------- F3: Sensor Life Countdown ---------- */

function computeSensorLife(readings, sensorId) {
  if (!readings.length) return null;
  const firstReading = readings[0].ts;
  const now = new Date();
  const SENSOR_LIFE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
  const elapsedMs = now - firstReading;
  const elapsedDays = elapsedMs / (24 * 60 * 60 * 1000);
  const leftDays = Math.max(0, 14 - elapsedDays);
  const expires = new Date(firstReading.getTime() + SENSOR_LIFE_MS);
  const replaceNow = leftDays <= 1;
  return {
    sensorStart: firstReading.toISOString().replace('T', ' ').slice(0, 16),
    daysElapsed: Math.round(elapsedDays * 10) / 10,
    daysLeft: Math.round(leftDays * 10) / 10,
    expires: expires.toISOString().replace('T', ' ').slice(0, 16),
    replaceNow,
  };
}

/* ---------- F4: Event markers on chart ---------- */

function buildEventAnnotations(readings, events) {
  if (!events || !events.length) return {};
  const annotations = {};
  events.forEach((e, i) => {
    const eventTime = new Date(e.timestamp).getTime();
    // Only show events in current view range
    const viewStart = getViewStart();
    if (eventTime < viewStart) return;
    const color = eventColor(e.type);
    annotations[`event-${i}`] = {
      type: 'line',
      mode: 'x',
      scaleID: 'x',
      value: eventTime,
      borderColor: color,
      borderWidth: 2,
      borderDash: [5, 5],
      label: {
        enabled: true,
        content: eventLabel(e),
        position: 'start',
        backgroundColor: color,
        color: '#fff',
        font: { size: 10, weight: 'bold' },
        padding: 4,
      },
    };
  });
  return annotations;
}

function getViewStart() {
  const now = Date.now();
  const dayMs = 86400000;
  switch (currentView) {
    case '24h': return now - dayMs;
    case '7d': return now - 7 * dayMs;
    case '30d': return now - 30 * dayMs;
    default: return 0;
  }
}

function eventColor(type) {
  switch (type) {
    case 'food': return '#34d399'; // green
    case 'insulin': return '#f472b6'; // pink
    case 'note': return '#60a5fa'; // blue
    case 'exercise': return '#fbbf24'; // amber
    case 'medication': return '#a78bfa'; // purple
    default: return '#9ca3af'; // gray
  }
}

function eventLabel(e) {
  const t = new Date(e.timestamp);
  const timeStr = fmtTime(t);
  const parts = [timeStr, e.type];
  if (e.carbs_g) parts.push(`${e.carbs_g}g carbs`);
  if (e.insulin_units) parts.push(`${e.insulin_units}U insulin`);
  if (e.note) parts.push(e.note);
  return parts.join(' • ');
}

/* ---------- NID-402: injection markers on chart ---------- */

// One solid pink vertical line + 💉 label per recorded shot (distinct from
// the dashed LibreLinkUp logbook lines). Timestamps are ISO -03:00 and parse
// natively on the chart's existing time scale.
function buildInsulinAnnotations() {
  const annotations = {};
  const viewStart = getViewStart();
  const shots = allInsulinShots();
  shots.forEach((s) => {
    const t = new Date(s.timestamp).getTime();
    if (!isFinite(t) || t < viewStart) return;
    const timeStr = fmtTime(new Date(s.timestamp));
    annotations[`shot-${s.id}`] = {
      type: 'line',
      mode: 'x',
      scaleID: 'x',
      value: t,
      borderColor: '#f472b6',
      borderWidth: 2,
      label: {
        enabled: true,
        content: `💉 ${timeStr}`,
        position: 'start',
        backgroundColor: '#f472b6',
        color: '#fff',
        font: { size: 10, weight: 'bold' },
        padding: 4,
      },
    };
  });
  return annotations;
}

/* ---------- aggregation ---------- */

function avg(vals) {
  return vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
}

function buildView(view, readings) {
  const now = Date.now();
  const dayMs = 86400000;

  // buildView returns labels as ISO timestamps (not display strings) — the
  // time scale owns tick formatting via viewTimeConfig(). Passing display
  // strings here produced invalid Dates (e.g. new Date("09:00")) which the
  // time scale rendered as raw epoch/year-looking ticks.
  if (view === '24h') {
    const pts = readings.filter((r) => now - r.ts.getTime() <= dayMs);
    return {
      labels: pts.map((r) => r.ts.toISOString()),
      values: pts.map((r) => r.value),
    };
  }

  if (view === '7d') {
    return aggregateDaily(readings, now - 7 * dayMs, (d) => d.toISOString());
  }

  if (view === '30d') {
    return aggregateDaily(readings, now - 30 * dayMs, (d) => d.toISOString());
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
    return new Date(Date.UTC(Number(y), 0, 1 + (Number(w) - 1) * 7)).toISOString();
  });
  return { labels, values: keys.map((k) => avg(buckets.get(k))) };
}

// Per-view X-axis time scale config: what unit the ticks use and how much
// detail each tick label carries. Applied on every render so tab switches
// restyle the axis without recreating the chart.
function viewTimeConfig(view) {
  if (view === '24h') return { unit: 'hour', maxTicks: 12, tooltipFormat: 'EEE d MMM HH:mm' };
  if (view === '7d') return { unit: 'day', maxTicks: 7, tooltipFormat: 'EEE d MMM' };
  if (view === '30d') return { unit: 'day', maxTicks: 15, tooltipFormat: 'EEE d MMM' };
  return { unit: 'week', maxTicks: 12, tooltipFormat: 'd MMM yyyy' };
}

// Week tick label as a day-of-month range: "17/08–23/08" (Monday → Sunday).
function weekTickLabel(value) {
  const d = new Date(value);
  const start = new Date(d);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // back to Monday
  const end = new Date(start);
  end.setDate(start.getDate() + 6); // Sunday
  const fmt = (x) => x.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' });
  return `${fmt(start)}–${fmt(end)}`;
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

function annotationConfig(readings, events) {
  const eventAnnotations = buildEventAnnotations(readings, events);
  const shotAnnotations = buildInsulinAnnotations();
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
        ...eventAnnotations,
        ...shotAnnotations,
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
  const readings = (store.readings || []).map(parseReading).sort((a, b) => a.ts - b.ts);
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
          annotations: annotationConfig(readings, store.events || []).annotation.annotations,
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
          type: 'time',
          // Unit / label formats are set per view in render() via
          // viewTimeConfig() — these are just the initial defaults.
          time: {
            tooltipFormat: 'EEE d MMM HH:mm',
            displayFormats: { hour: 'HH:mm', day: 'EEE d MMM', week: 'd MMM' },
          },
          ticks: { maxTicksLimit: 12, color: getComputedStyle(document.documentElement).getPropertyValue('--text-muted') || '#8fa3bf', callback: null },
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
  updateROC(readings);
  updateTimeInRange(readings);
  updateSensorLife(readings);

  if (!chart) chart = createChart();
  if (!chart) return;

  const { labels, values } = buildView(currentView, readings);
  const [r, g, b] = accentRGB();

  chart.data.labels = labels.map(l => new Date(l)); // time scale expects Date objects
  chart.data.datasets = [{
    label: 'Glucose',
    data: values.map((v, i) => ({ x: new Date(labels[i]), y: v })),
    borderColor: `rgb(${r},${g},${b})`,
    borderWidth: 2,
    tension: 0.25,
    pointRadius: 0,
    pointHitRadius: 8,
    fill: true,
    backgroundColor: (ctx) => gradientFill(ctx.chart.ctx, ctx.chart.chartArea),
  }];
  // Update annotations for events
  chart.options.plugins.annotation.annotations = annotationConfig(readings, store.events || []).annotation.annotations;
  // Apply per-view X-axis time config (unit, tick density, week ranges).
  const tcfg = viewTimeConfig(currentView);
  const xScale = chart.options.scales.x;
  xScale.time.unit = tcfg.unit;
  xScale.time.tooltipFormat = tcfg.tooltipFormat;
  xScale.ticks.maxTicksLimit = tcfg.maxTicks;
  xScale.ticks.callback = tcfg.unit === 'week' ? weekTickLabel : null;
  chart.update();

  els.chartEmpty.hidden = values.length > 0;
}

/* ---------- F1: Update Rate of Change ---------- */

function updateROC(readings) {
  if (!els.rocValue) return;
  const { rocPerHour, rocPerMin, arrow } = computeROC(readings);
  if (rocPerHour === null) {
    els.rocValue.textContent = '—';
    els.rocArrow.textContent = '—';
    return;
  }
  els.rocValue.textContent = rocPerHour >= 0 ? `+${rocPerHour.toFixed(1)}` : rocPerHour.toFixed(1);
  els.rocUnit.textContent = 'mg/dL/hr';
  els.rocArrow.textContent = arrow;
  // Color code
  const rocEl = els.rocValue.parentElement;
  if (rocPerHour > 2) rocEl.className = 'metric-value value-high';
  else if (rocPerHour > 0.5) rocEl.className = 'metric-value value-low';
  else if (rocPerHour < -2) rocEl.className = 'metric-value value-hypo';
  else if (rocPerHour < -0.5) rocEl.className = 'metric-value value-low';
  else rocEl.className = 'metric-value value-target';
}

/* ---------- F2: Update Time in Range ---------- */

function updateTimeInRange(readings) {
  if (!els.tirTarget) return;
  const tir = computeTimeInRange(readings);
  if (!tir) {
    [els.tirTarget, els.tirLow, els.tirHypo, els.tirHigh].forEach(el => el && (el.textContent = '—'));
    [els.tirHypoCount, els.tirHyperCount, els.tirMin, els.tirMax].forEach(el => el && (el.textContent = '—'));
    return;
  }
  els.tirTarget.textContent = `${tir.targetPct}%`;
  els.tirLow.textContent = `${tir.lowPct}%`;
  els.tirHypo.textContent = `${tir.hypoPct}%`;
  els.tirHigh.textContent = `${tir.highPct}%`;
  els.tirHypoCount.textContent = tir.hypoEvents;
  els.tirHyperCount.textContent = tir.hyperEvents;
  els.tirMin.textContent = `${Math.round(tir.minVal)} mg/dL`;
  els.tirMax.textContent = `${Math.round(tir.maxVal)} mg/dL`;
}

/* ---------- F3: Update Sensor Life ---------- */

function updateSensorLife(readings) {
  if (!els.sensorLifeElapsed) return;
  const life = computeSensorLife(readings, store.sensor_id);
  if (!life) {
    [els.sensorLifeElapsed, els.sensorLifeLeft, els.sensorLifeExpires, els.sensorLifeStatus].forEach(el => el && (el.textContent = '—'));
    return;
  }
  els.sensorLifeElapsed.textContent = `${life.daysElapsed} days`;
  els.sensorLifeLeft.textContent = `${life.daysLeft} days`;
  els.sensorLifeExpires.textContent = life.expires;
  els.sensorLifeStatus.textContent = life.replaceNow ? '⚠️ Replace soon' : '✓ Active';
  els.sensorLifeStatus.className = life.replaceNow ? 'metric-status value-hypo' : 'metric-status value-target';
}

/* ---------- metrics & sync ---------- */

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
    store = { readings: [], events: [] };
    updateMetrics([]);
    updateSync([]);
    updateROC([]);
    updateTimeInRange([]);
    updateSensorLife([]);
    showEmpty('Could not load glucose data.');
    if (chart) { chart.data.labels = []; chart.data.datasets = [{ data: [] }]; chart.update(); }
    console.error('Leoncito: failed to load data', err);
  }
}

/* ---------- NID-402: Insulin-shot tracker ---------- */

// Every timestamp is stored/read as Buenos Aires wall clock (ISO -03:00),
// matching the worker's GMT-3 contract — independent of the viewing device's
// timezone. Stored strings are fixed-shape ("YYYY-MM-DDTHH:mm:ss.sss-03:00"),
// so the calendar day key is a plain string slice.
function artDateKey(tsStr) {
  return String(tsStr).slice(0, 10);
}

function makeArtTimestamp(dateKey, timeStr) {
  const t = String(timeStr || '00:00').slice(0, 5); // HH:MM
  return `${dateKey}T${t}:00-03:00`;
}

function artNowParts() {
  // Buenos Aires wall clock regardless of device timezone (UTC − 3h).
  const d = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  return { date: d.slice(0, 10), time: d.slice(11, 16) };
}

function allInsulinShots() {
  const deleted = insulin.pendingDeletes;
  const merged = [
    ...insulin.shots.filter((s) => !deleted.has(s.id)),
    ...insulin.pendingAdds,
  ];
  return merged.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

function insulinDirty() {
  return insulin.pendingAdds.length > 0 || insulin.pendingDeletes.size > 0;
}

async function loadInsulin() {
  try {
    const res = await fetch(INSULIN_API, { cache: 'no-store' });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    const data = await res.json();
    insulin.shots = Array.isArray(data.shots) ? data.shots : [];
    insulin.online = true;
    try { localStorage.setItem(INSULIN_CACHE_KEY, JSON.stringify(insulin.shots)); } catch {}
  } catch (err) {
    // Offline fallback: device-local copy (per NID-402 design decision #1).
    insulin.online = false;
    try { insulin.shots = JSON.parse(localStorage.getItem(INSULIN_CACHE_KEY) || '[]'); } catch {}
    insulin.shots = Array.isArray(insulin.shots) ? insulin.shots : [];
    setStatus(
      err.status === 401
        ? 'Sign-in required — showing device-local copy.'
        : 'API unreachable — showing device-local copy; saves stay on this device.'
    );
  }
  renderCalendar();
  renderDayPanel();
  updateSaveState();
}

async function saveInsulin() {
  if (!insulinDirty()) return;
  if (!insulin.online) {
    saveLocalFallback();
    return;
  }
  els.saveBtn.disabled = true;
  setStatus('Saving…');
  try {
    for (const s of insulin.pendingAdds) {
      const res = await fetch(INSULIN_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timestamp: s.timestamp, note: s.note }),
      });
      if (!res.ok) throw Object.assign(new Error(`save failed: HTTP ${res.status}`), { status: res.status });
    }
    for (const id of insulin.pendingDeletes) {
      const res = await fetch(`${INSULIN_API}?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error(`delete failed: HTTP ${res.status}`);
    }
    insulin.pendingAdds = [];
    insulin.pendingDeletes = new Set();
    await loadInsulin(); // re-sync from source of truth (also refreshes markers)
    setStatus('Saved ✓');
    refreshChartAnnotations();
  } catch (err) {
    setStatus(err.status === 401
      ? 'Sign-in required — not saved to the cloud. Try again after signing in.'
      : `Could not save (${err.message}). Your edits are kept — press Save again.`);
  } finally {
    updateSaveState();
  }
}

function saveLocalFallback() {
  try {
    localStorage.setItem(INSULIN_CACHE_KEY, JSON.stringify(allInsulinShots()));
    insulin.shots = allInsulinShots();
    insulin.pendingAdds = [];
    insulin.pendingDeletes = new Set();
    renderCalendar();
    renderDayPanel();
    setStatus('Saved on this device only (offline mode).');
  } catch {
    setStatus('Could not save — storage unavailable.');
  } finally {
    updateSaveState();
  }
}

function setStatus(msg) {
  if (els.statusLine) els.statusLine.textContent = msg;
}

function updateSaveState() {
  els.saveBtn.disabled = !insulinDirty();
}

function refreshChartAnnotations() {
  if (!chart) return;
  const readings = (store.readings || []).map(parseReading);
  chart.options.plugins.annotation.annotations =
    annotationConfig(readings, store.events || []).annotation.annotations;
  chart.update();
}

/* Calendar month view — Monday-first grid matching the weekday header. */

function renderCalendar() {
  if (!els.calGrid) return;
  const year = calCursor.getFullYear();
  const month = calCursor.getMonth();
  els.calMonthLabel.textContent = calCursor.toLocaleDateString([], { month: 'long', year: 'numeric' });

  const counts = new Map(); // dateKey -> shot count (persisted + pending)
  for (const s of allInsulinShots()) {
    const k = artDateKey(s.timestamp);
    counts.set(k, (counts.get(k) || 0) + 1);
  }

  const todayKey = isoDateKey(new Date());
  const firstDow = (new Date(year, month, 1).getDay() + 6) % 7; // Mon=0
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  els.calGrid.innerHTML = '';
  for (let i = 0; i < firstDow; i++) {
    const pad = document.createElement('span');
    pad.className = 'cal-cell cal-pad';
    els.calGrid.appendChild(pad);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cal-cell';
    if (key === todayKey) cell.classList.add('cal-today');
    if (key === selectedDayKey) cell.classList.add('cal-selected');
    const num = document.createElement('span');
    num.className = 'cal-day-num';
    num.textContent = String(day);
    cell.appendChild(num);
    const n = counts.get(key) || 0;
    if (n > 0) {
      const badge = document.createElement('span');
      badge.className = 'cal-shot-badge';
      badge.textContent = n > 1 ? `💉×${n}` : '💉';
      cell.appendChild(badge);
    }
    cell.addEventListener('click', () => {
      selectedDayKey = key;
      renderCalendar();
      renderDayPanel();
    });
    els.calGrid.appendChild(cell);
  }
}

function renderDayPanel() {
  if (!els.shotList) return;
  const [y, m, d] = selectedDayKey.split('-').map(Number);
  const dayDate = new Date(y, m - 1, d);
  els.dayTitle.textContent = dayDate.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });

  const shots = allInsulinShots().filter((s) => artDateKey(s.timestamp) === selectedDayKey);
  els.shotList.innerHTML = '';
  if (!shots.length) {
    const li = document.createElement('li');
    li.className = 'shot-empty';
    li.textContent = 'No shots recorded for this day.';
    els.shotList.appendChild(li);
  }
  for (const s of shots) {
    const li = document.createElement('li');
    li.className = 'shot-item';
    const time = document.createElement('span');
    time.className = 'shot-time';
    time.textContent = fmtTime(new Date(s.timestamp));
    li.appendChild(time);
    if (s.note) {
      const note = document.createElement('span');
      note.className = 'shot-note';
      note.textContent = s.note;
      li.appendChild(note);
    }
    if (!insulin.pendingDeletes.has(s.id)) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'shot-delete';
      del.setAttribute('aria-label', `Delete shot at ${time.textContent}`);
      del.textContent = '✕';
      del.addEventListener('click', () => removeShot(s.id));
      li.appendChild(del);
    } else {
      li.classList.add('shot-deleted');
      const undo = document.createElement('button');
      undo.type = 'button';
      undo.className = 'shot-delete';
      undo.textContent = '↺';
      undo.addEventListener('click', () => {
        insulin.pendingDeletes.delete(s.id);
        renderCalendar();
        renderDayPanel();
        updateSaveState();
      });
      li.appendChild(undo);
    }
    els.shotList.appendChild(li);
  }

  // Default the time input to now (Buenos Aires wall clock).
  if (!els.shotTime.value) {
    const { time } = artNowParts();
    els.shotTime.value = time;
  }
}

function removeShot(id) {
  if (String(id).startsWith('tmp-')) {
    insulin.pendingAdds = insulin.pendingAdds.filter((s) => s.id !== id);
  } else {
    insulin.pendingDeletes.add(id);
  }
  renderCalendar();
  renderDayPanel();
  updateSaveState();
}

function addShot(dateKey, timeStr, note) {
  insulin.pendingAdds.push({
    id: `tmp-${crypto.randomUUID()}`,
    timestamp: makeArtTimestamp(dateKey, timeStr),
    note: note || null,
  });
  selectedDayKey = dateKey;
  renderCalendar();
  renderDayPanel();
  updateSaveState();
}

function bindInsulin() {
  if (!els.calGrid) return;
  els.calPrev.addEventListener('click', () => {
    calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() - 1, 1);
    renderCalendar();
  });
  els.calNext.addEventListener('click', () => {
    calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 1);
    renderCalendar();
  });
  els.addNow.addEventListener('click', () => {
    const { date, time } = artNowParts();
    addShot(date, time, els.shotNote.value.trim() || null);
    els.shotTime.value = time;
  });
  els.shotAdd.addEventListener('click', () => {
    const time = els.shotTime.value || artNowParts().time;
    addShot(selectedDayKey, time, els.shotNote.value.trim() || null);
    els.shotNote.value = '';
  });
  els.saveBtn.addEventListener('click', saveInsulin);
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
bindInsulin();
loadData();
loadInsulin();
setInterval(loadData, REFRESH_MS);