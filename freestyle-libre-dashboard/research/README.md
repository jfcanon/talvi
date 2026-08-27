# FreeStyle Libre raw-sensor research (NID-396)

Research deliverables for the Leoncito dashboard. Goal: understand the
FreeStyle Libre 1/2 sensor's raw capabilities so we can decide which new
dashboard features are genuinely possible.

## Files

| File | What it is |
|---|---|
| `freestyle-libre-raw-capabilities.md` | Research report — verified capabilities, FRAM byte layout, calibration math, Libre 2 crypto caveat, sources (web + Context7) |
| `libre_raw_parser.py` | Reference `LibreRawParser` — production-grade Python decoder for raw NFC/BLE byte streams (spec STEP 2). `python3 libre_raw_parser.py --self-test` prints the full payload. |
| `parser_output_schema.json` | Standardized output payload — example scan (spec STEP 3) |
| `feasibility-matrix.md` | Feature feasibility matrix, delivery-gap assessment, and $0 dashboard feature proposals with JSON contracts |
| `pn5180-libre2-custom-commands.md` | NID-420 — PN5180 + ESP32-S3 can run the Libre 2 ISO 15693 sequence (patchInfo, enable streaming); library patch, wiring, bench decision table |

## Headline findings

- The sensor physically measures **two things only**: glucose-related electric
  current and thermistor temperature. Everything else (fat, weight, calories,
  mood, cholesterol, blood cells) is impossible on this hardware.
- **Raw** glucose counts, raw temperature, and per-sensor factory calibration
  live in the FRAM's trend/history buffers — readable over NFC (Libre 1) or
  NFC/BLE (Libre 2, **requires the pairing key**).
- The current pipeline's cloud API (LibreLinkUp via pylibrelinkup) exposes
  **only calibrated mg/dL** — no raw current, no temperature. Raw-data features
  are hardware-gated, not code-gated.
- Cheap, doable-now dashboard features: rate-of-change badge, time-in-range
  summary, sensor-life countdown, event layer (F1–F4 in the feasibility
  matrix). All $0 and static-compatible.
