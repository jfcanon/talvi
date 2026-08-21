// Leoncito Glucose Worker — store + dashboard backend.
// Since NID-403 the LibreLinkUp fetch runs OFF this Worker: libreview.io
// blocks Cloudflare datacenter egress IPs with 403 (residential IPs work),
// so a fetcher on the owner's home network pulls readings and pushes them
// here via POST /api/ingest (bearer-gated with INGEST_TOKEN). This Worker
// no longer talks to libreview.io itself; /api/fetch stays as a manual
// diagnostic (and fails loudly while datacenter egress remains blocked).

const KV_KEY = 'glucose.json';
const STATUS_KEY = '_status.json'; // last successful ingest/fetch, for observability (RCA)

// Bounds for accepted ingest payloads. A fresh LibreLinkUp graph call is
// ~12h at 5-min cadence (~144 readings); generous caps keep even a full
// backfill well under the limit while bounding abuse if the token leaks.
const MAX_INGEST_BYTES = 5 * 1024 * 1024;
const MAX_INGEST_READINGS = 5000;
const MAX_INGEST_EVENTS = 2000;

// All timestamps are stored in Argentina time (GMT-3, America/Argentina/
// Buenos_Aires — fixed UTC-3, no DST since 2009). LibreLinkUp returns UTC;
// the JSON the dashboard consumes must read as Buenos Aires wall-clock.
const ART_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC → ART: subtract 3h (fixed, no DST)
const ART_OFFSET_SUFFIX = '-03:00';

function toArtIso(value) {
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  // Local wall clock (ART) = instant − 3h, labeled with the -03:00 suffix.
  // (Bug fixed 2026-08-21: ART_OFFSET_MS was -3h, so `getTime() - ART_OFFSET_MS`
  // ADDED 3h and every normalize pass shifted all timestamps +6h forward —
  // each read of /api/glucose re-wrote the store with future-dated readings.)
  const local = new Date(d.getTime() - ART_OFFSET_MS);
  return local.toISOString().replace(/\.\d{3}Z$/, ART_OFFSET_SUFFIX);
}

// Normalize any legacy UTC ("Z") timestamps to GMT-3. Idempotent on data that
// is already GMT-3. Applied on read AND on merge so a store seeded with old
// UTC values converges to the GMT-3 contract on first serve.
function normalizeToArt(data) {
  if (!data) return data;
  return {
    ...data,
    last_updated: toArtIso(data.last_updated),
    readings: (data.readings || []).map((r) => ({ ...r, timestamp: toArtIso(r.timestamp) })),
    events: (data.events || []).map((e) => ({ ...e, timestamp: toArtIso(e.timestamp) })),
  };
}

// LibreLinkUp's graph endpoint only returns ~12h per call, so each cron run
// must MERGE with what's already stored instead of overwriting — otherwise the
// KV store never accumulates the history the dashboard expects. New data wins
// on duplicate timestamps; the combined set is capped at 120 days.
function mergeHistory(existing, fresh) {
  const existingN = normalizeToArt(existing);
  const freshN = normalizeToArt(fresh);
  const cutoff = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);

  const readingsMap = new Map();
  for (const r of [...(existingN?.readings || []), ...(freshN?.readings || [])]) {
    if (r?.timestamp) readingsMap.set(r.timestamp, r);
  }
  const readings = Array.from(readingsMap.values())
    .filter(r => new Date(r.timestamp) >= cutoff)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const eventMap = new Map();
  for (const e of [...(existingN?.events || []), ...(freshN?.events || [])]) {
    if (e?.timestamp) eventMap.set(`${e.timestamp}|${e.type}`, e);
  }
  const events = Array.from(eventMap.values()).sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
  );

  return {
    readings,
    events,
    last_updated: readings.length
      ? readings[readings.length - 1].timestamp
      : toArtIso(new Date()),
    sensor_id: freshN?.sensor_id || existingN?.sensor_id || null,
    trend: freshN?.trend ?? existingN?.trend ?? null,
  };
}

const MIN_GLUCOSE = 40.0;
const MAX_GLUCOSE = 500.0;

const TREND_LABEL = {
  DOWN_FAST: 'falling fast',
  DOWN_SLOW: 'falling',
  STABLE: 'stable',
  UP_SLOW: 'rising',
  UP_FAST: 'rising fast',
};

const EVENT_TYPE_LABEL = {
  MEAL: 'food',
  INSULIN: 'insulin',
  NOTE: 'note',
  EXERCISE: 'exercise',
  MEDICATION: 'medication',
};

const API_URLS = [
  'https://api-eu.libreview.io',  // EU
  'https://api.libreview.io',     // US/Global
];

async function authenticate(email, password, baseUrl) {
  const authUrl = `${baseUrl}/llu/auth/login`;
  const response = await fetch(authUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'product': 'llu.android',
      'version': '4.16.0',
    },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Auth failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  const jwt = data.auth?.ticket?.token;
  if (!jwt) {
    throw new Error('No JWT in auth response');
  }
  return jwt;
}

async function getPatients(jwt, baseUrl) {
  const url = `${baseUrl}/llu/connections`;
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'product': 'llu.android',
      'version': '4.16.0',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Get patients failed (${response.status}): ${text}`);
  }

  return response.json();
}

async function getGraph(jwt, patientId, baseUrl) {
  const url = `${baseUrl}/llu/connections/${patientId}/graph`;
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'product': 'llu.android',
      'version': '4.16.0',
    },
  });

  if (!response.ok) {
    return []; // Return empty array on error
  }

  return response.json();
}

async function getLatest(jwt, patientId, baseUrl) {
  const url = `${baseUrl}/llu/connections/${patientId}/latest`;
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'product': 'llu.android',
      'version': '4.16.0',
    },
  });

  if (!response.ok) {
    return null;
  }

  return response.json();
}

async function getLogbook(jwt, patientId, baseUrl) {
  const url = `${baseUrl}/llu/connections/${patientId}/logbook`;
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'product': 'llu.android',
      'version': '4.16.0',
    },
  });

  if (!response.ok) {
    return [];
  }

  return response.json();
}

async function fetchFromLibreLinkUp(env) {
  const email = env.LIBRELINK_EMAIL;
  const password = env.LIBRELINK_PASSWORD;

  if (!email || !password) {
    throw new Error('LIBRELINK_EMAIL / LIBRELINK_PASSWORD not configured');
  }

  let jwt = null;
  let baseUrl = null;
  let lastAuthError = null;

  // Try each region until one works
  for (const url of API_URLS) {
    try {
      jwt = await authenticate(email, password, url);
      baseUrl = url;
      console.log(`Authenticated via ${url}`);
      break;
    } catch (e) {
      lastAuthError = e.message;
      console.warn(`Auth failed via ${url}: ${e.message}`);
    }
  }

  if (!jwt) {
    // Surface the underlying HTTP status/text so /api/status pinpoints the
    // cause (401 = bad credentials, 403 = blocked, 5xx = upstream, etc.).
    throw new Error(`LibreLinkUp auth failed on all regions: ${lastAuthError}`);
  }

  const patients = await getPatients(jwt, baseUrl);
  if (!patients?.data?.length) {
    throw new Error('No connected patients (link sensor in LibreLinkUp)');
  }

  const patient = patients.data[0];
  const patientId = patient.patientId;

  // Fetch graph (~12h), latest, and logbook in parallel
  const [graph, latest, logbook] = await Promise.all([
    getGraph(jwt, patientId, baseUrl).catch(() => ({ data: [] })),
    getLatest(jwt, patientId, baseUrl).catch(() => null),
    getLogbook(jwt, patientId, baseUrl).catch(() => ({ data: [] })),
  ]);

  // Process readings from graph
  const readings = [];
  for (const m of graph.data || []) {
    const ts = m.timestamp;
    const value = Number(m.valueInMgPerDl || m.ValueInMgPerDl || m.value_in_mg_per_dl);
    if (value >= MIN_GLUCOSE && value <= MAX_GLUCOSE) {
      readings.push({
        timestamp: toArtIso(ts),
        glucose: Math.round(value * 10) / 10,
        unit: 'mg/dL',
      });
    }
  }

  // Process latest reading
  let trend = null;
  if (latest?.data?.valueInMgPerDl) {
    const ts = latest.data.timestamp;
    const value = Number(latest.data.valueInMgPerDl);
    if (value >= MIN_GLUCOSE && value <= MAX_GLUCOSE) {
      const latestReading = {
        timestamp: toArtIso(ts),
        glucose: Math.round(value * 10) / 10,
        unit: 'mg/dL',
      };
      const existingIdx = readings.findIndex(r => r.timestamp === latestReading.timestamp);
      if (existingIdx >= 0) readings[existingIdx] = latestReading;
      else readings.push(latestReading);
    }
    if (latest.data.trend) {
      trend = TREND_LABEL[latest.data.trend] || latest.data.trend;
    }
  }

  // Sort readings by timestamp
  readings.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  // Cap to 120 days
  const cutoff = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
  const filtered = readings.filter(r => new Date(r.timestamp) >= cutoff);

  // Process events from logbook
  const events = [];
  for (const e of logbook.data || []) {
    const ts = e.timestamp;
    const eventType = EVENT_TYPE_LABEL[e.type] || String(e.type).toLowerCase();
    events.push({
      timestamp: toArtIso(ts),
      type: eventType,
      carbs_g: e.carbs ?? null,
      insulin_units: e.insulin ?? null,
      note: e.notes ?? null,
    });
  }

  // Dedup events
  const eventMap = new Map();
  for (const e of events) {
    eventMap.set(`${e.timestamp}|${e.type}`, e);
  }

  return {
    readings: filtered,
    events: Array.from(eventMap.values()),
    last_updated: filtered.length ? filtered[filtered.length - 1].timestamp : toArtIso(new Date()),
    sensor_id: String(patientId).slice(0, 6).toUpperCase(),
    trend,
  };
}

// Constant-time string comparison via SHA-256 digests — comparing digests of
// fixed length avoids both length leaks and early-exit timing differences.
async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

// Structural validation for an ingest payload. Returns { error } on a
// malformed record (reject the whole POST) or { readings, events } with
// out-of-range values dropped (same policy as the Worker's own fetch path:
// 40–500 mg/dL is the full LibreLinkUp measurable range).
function validateIngestPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: 'payload must be a JSON object' };
  }
  if (!Array.isArray(payload.readings)) {
    return { error: "payload.readings must be an array" };
  }
  if (payload.readings.length > MAX_INGEST_READINGS) {
    return { error: `payload.readings exceeds ${MAX_INGEST_READINGS} entries` };
  }
  if (payload.events !== undefined && !Array.isArray(payload.events)) {
    return { error: "payload.events must be an array" };
  }
  if ((payload.events?.length || 0) > MAX_INGEST_EVENTS) {
    return { error: `payload.events exceeds ${MAX_INGEST_EVENTS} entries` };
  }
  for (const k of ['sensor_id', 'trend', 'last_updated']) {
    if (payload[k] !== undefined && payload[k] !== null && typeof payload[k] !== 'string') {
      return { error: `payload.${k} must be a string or null` };
    }
  }

  const readings = [];
  let dropped = 0;
  for (const r of payload.readings) {
    if (!r || typeof r !== 'object'
        || typeof r.timestamp !== 'string'
        || isNaN(new Date(r.timestamp).getTime())) {
      return { error: 'each reading needs {timestamp: ISO string, glucose: number}' };
    }
    if (typeof r.glucose !== 'number' || !Number.isFinite(r.glucose)) {
      return { error: 'each reading needs a numeric glucose value' };
    }
    if (r.unit !== undefined && r.unit !== null && r.unit !== 'mg/dL') {
      return { error: `unsupported unit ${JSON.stringify(r.unit)} (only mg/dL)` };
    }
    if (r.glucose < MIN_GLUCOSE || r.glucose > MAX_GLUCOSE) {
      dropped++;
      continue;
    }
    readings.push({
      timestamp: toArtIso(r.timestamp),
      glucose: Math.round(r.glucose * 10) / 10,
      unit: 'mg/dL',
    });
  }

  const events = [];
  for (const e of payload.events || []) {
    if (!e || typeof e !== 'object'
        || typeof e.timestamp !== 'string'
        || isNaN(new Date(e.timestamp).getTime())
        || typeof e.type !== 'string') {
      return { error: 'each event needs {timestamp: ISO string, type: string}' };
    }
    events.push({
      timestamp: toArtIso(e.timestamp),
      type: EVENT_TYPE_LABEL[e.type] || String(e.type).toLowerCase(),
      carbs_g: e.carbs_g ?? null,
      insulin_units: e.insulin_units ?? null,
      note: e.note ?? null,
    });
  }

  return {
    readings,
    events,
    dropped,
    sensor_id: payload.sensor_id ?? null,
    // Translate LibreLinkUp's UP_SLOW-style enums to dashboard labels — same
    // mapping the Worker's own fetch path applies before merging.
    trend: payload.trend ? (TREND_LABEL[payload.trend] || payload.trend) : null,
    last_updated: payload.last_updated ?? null,
  };
}

// POST /api/ingest — home fetcher pushes a fresh LibreLinkUp window here.
// Auth: Authorization: Bearer $INGEST_TOKEN (Worker secret binding, set in
// main.tf from the ingest_token TF var / GitHub secret TF_VAR_INGEST_TOKEN).
// The store contract is unchanged: mergeHistory dedupes by timestamp, caps at
// 120 days, sorts ascending, normalizes to GMT-3. Fail-closed: no INGEST_TOKEN
// binding means every request is rejected.
async function handleIngest(request, env) {
  if (!env.INGEST_TOKEN) {
    // Not configured yet → refuse rather than run open.
    return new Response(JSON.stringify({ success: false, error: 'ingest not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const auth = request.headers.get('Authorization') || '';
  const expected = `Bearer ${env.INGEST_TOKEN}`;
  if (!(await timingSafeEqual(auth, expected))) {
    return new Response(JSON.stringify({ success: false, error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > MAX_INGEST_BYTES) {
    return new Response(JSON.stringify({ success: false, error: 'payload too large' }), {
      status: 413,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response(JSON.stringify({ success: false, error: 'invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const v = validateIngestPayload(payload);
  if (v.error) {
    await writeStatus(env, { ok: false, source: 'ingest', error: `rejected: ${v.error}` });
    return new Response(JSON.stringify({ success: false, error: v.error }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const existing = await env.LEONCITO_DATA.get(KV_KEY, 'json').catch(() => null);
    const fresh = {
      readings: v.readings,
      events: v.events,
      last_updated: v.last_updated || (v.readings.length ? v.readings[v.readings.length - 1].timestamp : toArtIso(new Date())),
      sensor_id: v.sensor_id,
      trend: v.trend,
    };
    const data = mergeHistory(existing, fresh);
    await env.LEONCITO_DATA.put(KV_KEY, JSON.stringify(data, null, 2));
    await writeStatus(env, {
      ok: true,
      source: 'ingest',
      total_readings: data.readings.length,
      new_readings: fresh.readings.length,
      dropped_readings: v.dropped,
      total_events: data.events.length,
    });
    return new Response(JSON.stringify({
      success: true,
      total_readings: data.readings.length,
      accepted_readings: fresh.readings.length,
      dropped_readings: v.dropped,
      total_events: data.events.length,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Ingest failed:', err);
    await writeStatus(env, { ok: false, source: 'ingest', error: err.message }).catch(() => {});
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// Shared status writer so every path records into _status.json consistently.
// checked_at stays UTC ISO (machine-facing); reading timestamps remain GMT-3.
async function writeStatus(env, extra) {
  const status = { checked_at: new Date().toISOString().replace('+00:00', 'Z'), ...extra };
  await env.LEONCITO_DATA.put(STATUS_KEY, JSON.stringify(status));
  return status;
}

async function handleFetch(env) {
  let status = { checked_at: new Date().toISOString().replace('+00:00', 'Z') };
  try {
    const fresh = await fetchFromLibreLinkUp(env);
    const existing = await env.LEONCITO_DATA.get(KV_KEY, 'json').catch(() => null);
    const data = mergeHistory(existing, fresh);
    await env.LEONCITO_DATA.put(KV_KEY, JSON.stringify(data, null, 2));
    Object.assign(status, {
      ok: true,
      total_readings: data.readings.length,
      new_readings: fresh.readings.length,
      total_events: data.events.length,
    });
    await env.LEONCITO_DATA.put(STATUS_KEY, JSON.stringify(status));
    console.log(`Stored ${data.readings.length} readings (${fresh.readings.length} fresh) and ${data.events.length} events to KV`);
    return new Response(JSON.stringify({ success: true, ...data }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Fetch failed:', err);
    Object.assign(status, { ok: false, error: err.message });
    await env.LEONCITO_DATA.put(STATUS_KEY, JSON.stringify(status)).catch(() => {});
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function handleGetData(env) {
  const stored = await env.LEONCITO_DATA.get(KV_KEY, 'json').catch(() => null);
  if (!stored) {
    return new Response(JSON.stringify({ readings: [], events: [], error: 'No data yet' }, null, 2), {
      status: 404,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
  // Normalize to GMT-3 on serve and persist the normalized copy so the store
  // converges even before the next successful fetch (legacy UTC seed → ART).
  const normalized = normalizeToArt(stored);
  // Sort ascending by timestamp — the read path must not depend on whoever
  // wrote the key last (mergeHistory sorts, but the seed file or any
  // out-of-order write may not be).
  normalized.readings = (normalized.readings || []).sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
  );
  normalized.events = (normalized.events || []).sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
  );
  await env.LEONCITO_DATA.put(KV_KEY, JSON.stringify(normalized, null, 2)).catch(() => {});
  // Pretty-printed (2-space indent) for human-friendly reads.
  return new Response(JSON.stringify(normalized, null, 2), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // API endpoint for dashboard to fetch data
    if (url.pathname === '/api/glucose') {
      return handleGetData(env);
    }

    // Manual trigger endpoint (for testing / diagnostics — datacenter egress
    // is IP-blocked by libreview.io, so this fails loudly until run from an
    // allowed network; the home fetcher + /api/ingest is the real pipeline)
    if (url.pathname === '/api/fetch') {
      return handleFetch(env);
    }

    // Home fetcher pushes fresh LibreLinkUp windows here (bearer-gated)
    if (url.pathname === '/api/ingest') {
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ success: false, error: 'method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json', 'Allow': 'POST' },
        });
      }
      return handleIngest(request, env);
    }

    // Last fetch status — surfaces auth/fetch errors for RCA when data is missing
    if (url.pathname === '/api/status') {
      const status = await env.LEONCITO_DATA.get(STATUS_KEY, 'json').catch(() => null);
      return new Response(JSON.stringify(status || { ok: null, error: 'no fetch recorded yet' }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response('OK', { headers: { 'Content-Type': 'text/plain' } });
    }

    return new Response('Not Found', { status: 404 });
  },
  // No scheduled handler — the Worker cron trigger was removed with the
  // Terraform change that moved fetching to the home network (NID-403).
};