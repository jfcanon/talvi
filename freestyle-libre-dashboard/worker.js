// Leoncito Glucose Worker — fetches from LibreLinkUp on cron, stores in KV, serves via HTTP
// Replaces GitHub Actions fetch_glucose.py + static data/glucose.json

const KV_KEY = 'glucose.json';
const STATUS_KEY = '_status.json'; // last fetch result, for observability (RCA)
const CRON_SCHEDULE = '17 * * * *'; // every hour at :17 (matches old GitHub Actions)

// All timestamps are stored in Argentina time (GMT-3, America/Argentina/
// Buenos_Aires — fixed UTC-3, no DST since 2009). LibreLinkUp returns UTC;
// the JSON the dashboard consumes must read as Buenos Aires wall-clock.
const ART_OFFSET_MS = -3 * 60 * 60 * 1000;
const ART_OFFSET_SUFFIX = '-03:00';

function toArtIso(value) {
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  const local = new Date(d.getTime() - ART_OFFSET_MS); // local wall clock = UTC - 3h
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

async function handleFetch(env) {
  const status = { checked_at: new Date().toISOString().replace('+00:00', 'Z') };
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

    // Manual trigger endpoint (for testing)
    if (url.pathname === '/api/fetch') {
      return handleFetch(env);
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

  // Cron trigger - runs hourly at :17
  async scheduled(event, env, ctx) {
    if (event.cron === CRON_SCHEDULE) {
      console.log('Cron triggered: fetching glucose data');
      await handleFetch(env);
    }
  },
};