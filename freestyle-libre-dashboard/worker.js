// Leoncito Glucose Worker — fetches from LibreLinkUp on cron, stores in KV, serves via HTTP
// Replaces GitHub Actions fetch_glucose.py + static data/glucose.json

const KV_KEY = 'glucose.json';
const CRON_SCHEDULE = '17 * * * *'; // every hour at :17 (matches old GitHub Actions)

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

  // Try each region until one works
  for (const url of API_URLS) {
    try {
      jwt = await authenticate(email, password, url);
      baseUrl = url;
      console.log(`Authenticated via ${url}`);
      break;
    } catch (e) {
      console.warn(`Auth failed via ${url}: ${e.message}`);
    }
  }

  if (!jwt) {
    throw new Error('LibreLinkUp auth failed on all regions');
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
        timestamp: new Date(ts).toISOString().replace('+00:00', 'Z'),
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
        timestamp: new Date(ts).toISOString().replace('+00:00', 'Z'),
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
      timestamp: new Date(ts).toISOString().replace('+00:00', 'Z'),
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
    last_updated: filtered.length ? filtered[filtered.length - 1].timestamp : new Date().toISOString().replace('+00:00', 'Z'),
    sensor_id: String(patientId).slice(0, 6).toUpperCase(),
    trend,
  };
}

async function handleFetch(env) {
  try {
    const data = await fetchFromLibreLinkUp(env);
    await env.LEONCITO_DATA.put(KV_KEY, JSON.stringify(data, null, 2));
    console.log(`Stored ${data.readings.length} readings and ${data.events.length} events to KV`);
    return new Response(JSON.stringify({ success: true, ...data }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Fetch failed:', err);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function handleGetData(env) {
  const stored = await env.LEONCITO_DATA.get(KV_KEY);
  if (!stored) {
    return new Response(JSON.stringify({ readings: [], events: [], error: 'No data yet' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
  return new Response(stored, {
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