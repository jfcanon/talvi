// Smoke tests for the leoncito-glucose Worker (NID-403): /api/ingest auth,
// schema validation, merge contract, and regression on existing routes.
// Run: node scripts/leoncito-ingest-test.mjs   (no deps — node:test)

import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../freestyle-libre-dashboard/worker.js';

const BASE = 'https://app.ygdcbtmc4u.uk';

function mockKV(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    async get(key, type) {
      if (!m.has(key)) return null;
      const v = m.get(key);
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) { m.set(key, String(value)); },
    _raw: m,
  };
}

function envWith(kv = {}, extra = {}) {
  return { LEONCITO_DATA: mockKV(kv), ...extra };
}

function req(path, { method = 'GET', headers = {}, body } = {}) {
  return new Request(BASE + path, { method, headers, body });
}

test('ingest: GET is rejected with 405', async () => {
  const res = await worker.fetch(req('/api/ingest'), envWith());
  assert.equal(res.status, 405);
});

test('ingest: fail-closed when INGEST_TOKEN binding missing', async () => {
  const res = await worker.fetch(req('/api/ingest', {
    method: 'POST',
    headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
    body: JSON.stringify({ readings: [] }),
  }), envWith());
  assert.equal(res.status, 503);
});

test('ingest: 401 on wrong token, and status untouched', async () => {
  const env = envWith({}, { INGEST_TOKEN: 'correct-horse' });
  const res = await worker.fetch(req('/api/ingest', {
    method: 'POST',
    headers: { Authorization: 'Bearer nope', 'Content-Type': 'application/json' },
    body: JSON.stringify({ readings: [] }),
  }), env);
  assert.equal(res.status, 401);
  assert.equal(await env.LEONCITO_DATA.get('_status.json'), null);
});

test('ingest: valid UTC payload merges, normalizes to GMT-3, records status', async () => {
  const env = envWith({
    'glucose.json': JSON.stringify({
      readings: [{ timestamp: '2026-08-20T09:00:00-03:00', glucose: 150, unit: 'mg/dL' }],
      events: [], last_updated: '2026-08-20T09:00:00-03:00', sensor_id: 'ABC123', trend: null,
    }),
  }, { INGEST_TOKEN: 'tok-1' });

  const res = await worker.fetch(req('/api/ingest', {
    method: 'POST',
    headers: { Authorization: 'Bearer tok-1', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // fresh window in UTC (as fetch_glucose.py emits)
      readings: [
        { timestamp: '2026-08-21T12:00:00Z', glucose: 142.44, unit: 'mg/dL' },
        { timestamp: '2026-08-21T12:05:00Z', glucose: 999, unit: 'mg/dL' },  // out of range → dropped
        { timestamp: '2026-08-21T12:00:00Z', glucose: 143, unit: 'mg/dL' },  // dup ts → fresh wins
      ],
      events: [{ timestamp: '2026-08-21T11:00:00Z', type: 'MEAL', carbs_g: 20 }],
      sensor_id: 'ABC123',
      trend: 'UP_SLOW',
    }),
  }), env);

  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.success, true);
  assert.equal(out.dropped_readings, 1);
  assert.equal(out.total_readings, 2); // 1 existing + fresh window

  const stored = await env.LEONCITO_DATA.get('glucose.json', 'json');
  assert.deepEqual(stored.readings.map(r => r.timestamp), [
    '2026-08-20T09:00:00-03:00',
    '2026-08-21T09:00:00-03:00',       // 12:00Z − 3h
  ]);
  assert.equal(stored.readings[1].glucose, 143); // fresh wins dedup
  assert.equal(stored.events[0].type, 'food');   // MEAL → food label
  assert.equal(stored.trend, 'rising');

  const status = await env.LEONCITO_DATA.get('_status.json', 'json');
  assert.equal(status.ok, true);
  assert.equal(status.source, 'ingest');
  assert.equal(status.dropped_readings, 1);
});

test('ingest: malformed reading rejects whole payload with 400', async () => {
  const env = envWith({}, { INGEST_TOKEN: 'tok-2' });
  for (const bad of [
    { readings: [{ glucose: 100 }] },                          // missing ts
    { readings: [{ timestamp: 'not-a-date', glucose: 100 }] }, // bad ts
    { readings: [{ timestamp: '2026-08-21T12:00:00Z', glucose: 'high' }] }, // non-numeric
    { readings: 'nope' },                                      // not array
    { events: [{ timestamp: '2026-08-21T12:00:00Z' }] },       // event w/o type
  ]) {
    const res = await worker.fetch(req('/api/ingest', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok-2', 'Content-Type': 'application/json' },
      body: JSON.stringify(bad),
    }), env);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
  }
  const status = await env.LEONCITO_DATA.get('_status.json', 'json');
  assert.equal(status.ok, false);
  assert.match(status.error, /^rejected:/);
});

test('ingest: invalid JSON body → 400; oversized Content-Length → 413', async () => {
  const env = envWith({}, { INGEST_TOKEN: 'tok-3' });
  let res = await worker.fetch(req('/api/ingest', {
    method: 'POST',
    headers: { Authorization: 'Bearer tok-3', 'Content-Type': 'application/json' },
    body: '{oops',
  }), env);
  assert.equal(res.status, 400);

  res = await worker.fetch(new Request(BASE + '/api/ingest', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer tok-3',
      'Content-Type': 'application/json',
      'Content-Length': String(6 * 1024 * 1024),
    },
    body: JSON.stringify({ readings: [] }),
  }), env);
  assert.equal(res.status, 413);
});

test('regression: /api/glucose serves and normalizes a legacy UTC store', async () => {
  const env = envWith({
    'glucose.json': JSON.stringify({
      readings: [{ timestamp: '2026-08-21T12:00:00Z', glucose: 140, unit: 'mg/dL' }],
      events: [],
      last_updated: '2026-08-21T12:00:00Z',
      sensor_id: 'XYZ789',
      trend: null,
    }),
  });
  const res = await worker.fetch(req('/api/glucose'), env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.readings[0].timestamp, '2026-08-21T09:00:00-03:00');
});

test('regression: /health OK, unknown path 404', async () => {
  let res = await worker.fetch(req('/health'), envWith());
  assert.equal(res.status, 200);
  res = await worker.fetch(req('/nope'), envWith());
  assert.equal(res.status, 404);
});

test('regression: /api/fetch still present as manual diagnostic', async () => {
  // No creds bound → loud 500 with the exact reason, status recorded.
  const env = envWith();
  const res = await worker.fetch(req('/api/fetch'), env);
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /LIBRELINK_EMAIL/);
});
