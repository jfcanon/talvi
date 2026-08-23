# Feasibility matrix + delivery-gap assessment

Companion to `freestyle-libre-raw-capabilities.md` (research) and
`libre_raw_parser.py` (reference implementation). Answers the question: which
of the candidate dashboard features are physically supported by the sensor,
how would the data be obtained, and what is worth doing on a $0 budget today.

## 1. Feasibility matrix

| Feature | Sensor supports? | Data source | How obtained | Dashboard priority |
|---|---|---|---|---|
| **Temperature trend** | **Yes** — thermistor is a primary measurement | Raw FRAM bytes 3–4 per record (bit offset 0x1A) | NFC/BLE read + `LibreRawParser`; Libre 2 needs pairing key | **High** (new capability; only raw path provides it) |
| **Eating-event flags** | **Indirect** — no food sensor; inferred from 1-min glucose velocity | 1-min trend buffer (16×6 bytes) | NFC/BLE read; ROC ≥ +2.5 mg/dL/min sustained → flag | **Medium** (useful for a diabetic cat's feeding schedule) |
| **Sleep / wake heuristic** | **Indirect** — low glucose variance + thermistor drop hint rest | 1-min trend buffer + temperature | NFC/BLE read; needs multi-day 1-min data; accelerometer (smartwatch/collar) for movement verification | **Low** |
| **Stress / "unlogged spike" flags** | **No** — cannot measure cortisol/adrenaline; can only flag a fast unlogged rise | 1-min trend buffer | NFC/BLE read; flag pattern, label as unlogged spike, never "stress" | **Low** |
| **Glycemic excursions (hypo/hyper events)** | **Yes** (calibrated values already carry this) | LibreLinkUp cloud (existing) | `is_low`/`is_high` + mg/dL bounds | **High** (free, doable today) |
| **Rate-of-change / trend arrow** | **Yes** | LibreLinkUp `TrendArrow` today; 1-min trend via raw | Cloud API now; raw parser later | **High** (free, doable today) |
| **Fat / weight / calories / mood / cholesterol / blood cells** | **No** — chemically impossible on this sensor | External devices (smart scale, lab, food tracker) | Separate integrations; schema included in parser output | **Not applicable to sensor** |

## 2. Delivery-gap assessment

### Today (current pipeline, live)

- Source: LibreLinkUp cloud API via `pylibrelinkup` (hourly CI cron).
- Data: **calibrated mg/dL only** — no raw current, no temperature, no
  diagnostics. 15-min resolution from the API, 1-h persistence cadence, ~12 h
  graph window, ~120-day capped store.
- Everything the dashboard can show is already calibrated glucose. Trend arrow
  is available as a label from `latest()`.

### Gap: raw sensor data is physically unreachable from the cloud path

- The LibreLinkUp API intentionally returns only calibrated values. There is no
  API endpoint that returns raw counts or temperature.
- Raw bytes live on the sensor's FRAM, read over NFC (or mirrored via BLE for
  Libre 2). This requires **physical hardware** (an NFC reader / BLE bridge
  near the cat) and, for Libre 2, **the sensor pairing key** established at
  first scan.
- Therefore: **temperature trend, eating events, sleep/wake, and stress flags
  are aspirational today** — they all need a raw-data capture path that does
  not exist in the current architecture.

### Path from today → aspirational

1. **Now, $0, no hardware:** derive everything the cloud data already permits —
   rate-of-change per hour, time-in-range stats, excursion counts, sensor-life
   countdown, day-over-day patterns. All client-side in the static dashboard.
2. **Phase 2, low effort:** persist richer LibreLinkUp fields (`is_high`,
   `is_low`, `measurement_color`, trend arrow, logbook food/insulin notes) into
   `data/glucose.json` so the dashboard can render events, not just the series.
3. **Phase 3, hardware-gated:** deploy a phone/collar BLE bridge (xDrip+ /
   Libre 2 pairing) or an NFC reader that dumps the decrypted FRAM to a
   Cloudflare Worker endpoint. `LibreRawParser` becomes the parsing library in
   that pipeline, emitting the standardized payload. This is the only path to
   temperature, eating events, sleep/wake, stress flags.

## 3. Concrete $0 dashboard features (proposals)

All of these fit the static, Cloudflare-free-tier architecture — they consume
`data/glucose.json` and render client-side. No live-dashboard changes unless
warranted; proposed JSON contract shown per feature.

### F1 — Rate-of-change badge (velocity per hour)

Computed client-side from existing 1-h readings. Catches "food spike incoming"
without any new data source.

```json
{
  "view": "24h",
  "series": [{"timestamp": "2026-08-20T14:00:00Z", "glucose": 145.0, "roc_per_hour": 18.5}],
  "roc_now_per_hour": 18.5,
  "roc_now_per_min": 0.31,
  "trend_arrow": "rising"
}
```

### F2 — Time-in-range + excursion summary

Leverages the existing cat zones (hypo <70, low 70–90, target 90–270, high
>270) already in the dashboard.

```json
{
  "range_summary": {
    "since": "2026-08-06T00:00:00Z",
    "total_readings": 336,
    "time_in_target_pct": 72.4,
    "hypo_events": 2,
    "hyper_events": 1,
    "min_glucose": 58.0,
    "max_glucose": 312.0
  }
}
```

### F3 — Sensor-life countdown

Libre 2 lifetime is 14 days (20160 min). Derivable from the earliest reading
timestamp in `glucose.json` (sensor start ≈ first reading). Warns when a swap
is due.

```json
{
  "sensor_life": {
    "sensor_start": "2026-08-06T00:00:00Z",
    "days_elapsed": 13.6,
    "days_left": 0.4,
    "expires": "2026-08-20T09:36:00Z",
    "replace_now": true
  }
}
```

### F4 — Event layer (logbook passthrough)

Persist LibreLinkUp `logbook()` events (food/insulin/notes, if ever logged in
the Libre app) into the store and draw them as markers on the 24h chart.

```json
{
  "events": [
    {"timestamp": "2026-08-20T13:45:00Z", "type": "food", "carbs_g": 25, "note": "breakfast"}
  ]
}
```

### F5 — (Hardware-gated) Temperature trend

Consumes the `LibreRawParser` payload once a raw path exists. Rendered as a
second series under the glucose chart.

```json
{
  "temperature": [
    {"timestamp": "2026-08-20T13:30:00Z", "temperature_celsius": 27.6, "temperature_raw": 6840}
  ]
}
```

## 4. Recommendation

Ship F1–F4 now (all $0, all static-compatible, no sensor/hardware work). Treat
F5 and the eating/sleep/stress flags as gated on a Phase-3 raw-data path; the
`LibreRawParser` spec in this directory is the contract that path will consume.
Do not claim sensor-based sleep/stress/eating detection until that path exists.
