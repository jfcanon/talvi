# /raw-ingest Worker Endpoint — Stage 3a Spec (Plan)

**Related:** `research/esp32-pn532-hardware.md`, `firmware/esp32_pn532/README.md` §6  
**Current Worker:** `freestyle-libre-dashboard/worker.js` (KV `glucose.json`, ingest token gated) — this spec extends it; the issue's `src/routes/raw-ingest.ts` maps to adding a handler in `worker.js` (talvi has no `src/routes/` yet).

---

## Contract

```http
POST /api/raw-ingest
Authorization: Bearer <INGEST_TOKEN>   # same secret as POST /api/ingest
Content-Type: application/octet-stream   # or application/json
X-Sensor-Uid: <uid>                      # optional header fallback
# body = exactly 344 bytes of decrypted FRAM (binary)
#  — OR —
# body = {"fram_hex":"001122... (688 hex)","sensor_uid":"...","sensor_start_iso":"2026-08-20T00:00:00Z","rssi":-42}
```

## Validation (reject 400 if)

- `len != 344` (hex string must be 688 chars after strip)
- `header_crc16 != crc16_ccitt(fram[2:318])` (LE, same as `libre_raw_parser.py: crc16_ccitt`)
- all-zero frame / `FRAM_SIZE` mismatch
- `age_minutes` out of `[0, max_life]` (326–327 LE)

On `RF_ERROR` (Libre 2 NFC artifact `raw=0` + temp small int) → accept but flag `meta.rf_error=true` so consumer prefers history buffer.

## Parsing

Port `research/libre_raw_parser.py` → `lib/libre_raw_parser.ts` (mechanical):

- constants: `FRAM_SIZE=344`, `TREND_START=28`, `HISTORY_START=124`, `RECORD_SIZE=6`, `BYTE_TREND_INDEX=26`, `BYTE_HISTORY_INDEX=27`, `TEMP_CAL_A=-0.009174`, `TEMP_CAL_B=90.36`, etc.
- `read_bits(buf, byte, bit, count)` LSB-first: `((byte >> (bit&7)) & 1) << i` — parentheses are load-bearing vs Swift.
- per-record: raw_glucose (14 bits), quality (11), has_error (1), raw_temp (12 → <<2), temp_adj (9 + sign)
- calibration: simple vs oop (sensor footer i1..i6 when available, else mock), `celsius_from_raw = -0.009174*raw + 90.36`
- emit identical shape to `research/parser_output_schema.json` (sensor/trend/history/metrics/validation/out_of_scope)

Golden test: feed the schema's example FRAM (or `python3 libre_raw_parser.py --self-test` output) and assert `header_crc16_ok == true`.

## Merge & storage

Reuse `worker.js: mergeHistory` pattern:

- KV key `raw.json` or extend `glucose.json` readings with `.raw = {temperature_celsius, velocity_mgdl_per_min, flags}` keyed by `timestamp` (ART normalized via `toArtIso`).
- Dedup by `timestamp`, cap 120 days, sort ascending.
- Write atomically; on KV failure return 502 so phone retries.

## Security

- Bearer gate (401 on bad token) — same as `/api/ingest`.
- Caps already in `worker.js`: `MAX_INGEST_BYTES` / `MAX_INGEST_READINGS` — extend for single binary 344 B (negligible).
- No credential logging; `Authorization` never echoed.

## Phone / ESP32 retry contract

- ESP32 BLE → phone bridge `POST` with exponential backoff (1s, 5s, 30s), 24 h offline queue.
- Optionally ESP32 Wi-Fi direct `POST` when home (SSID provisioned via touch UI).
- Worker returns `{ok:true, stored:1, crc_ok:true}` or `{error:"crc mismatch"}`.

## Dashboard next step (3A5, not this PR)

- Secondary Y-axis for `temperature_celsius` from raw store, markers for `flags.eating_event`, shading for `flags.sleep`, badge for `flags.unlogged_spike` — all client-side from `data/raw.json` after ingest exists.
