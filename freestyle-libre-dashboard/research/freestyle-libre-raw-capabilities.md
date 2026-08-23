# FreeStyle Libre 1/2 — raw sensor capabilities research

Research for NID-396 (CC-DS lane). Evidence-based survey of what the sensor
physically measures, the reverse-engineered raw-data format, and what the
LibreLinkUp cloud API does *not* expose. Companion artifacts in this directory:

- `libre_raw_parser.py` — reference `LibreRawParser` (spec STEP 2)
- `parser_output_schema.json` — standardized output payload (spec STEP 3)
- `feasibility-matrix.md` — feature feasibility + delivery-gap + $0 proposals

## 1. Hard physical limits (verified)

The FreeStyle Libre 1/2 sensor contains two transducers inside interstitial
fluid (ISF):

1. **A glucose-oxidase electrode** — produces an electric current proportional
   to glucose in the ISF. This is the *only* glucose signal.
2. **A thermistor** — produces a temperature-dependent count. This is the *only*
   temperature signal.

Confirmed by the LibreMonitor OOP investigation, which shows the 6-byte record
carries exactly these two families of values (raw glucose, raw temperature) plus
quality/error metadata. There is **no** signal for blood cells, lipids,
cholesterol, mood, fat, or weight — a sensor reading cannot be re-derived into
those. Any such metric must come from an external device (smart scale, lab
work, food tracker); the parser's output schema lists those external endpoints
explicitly rather than pretending the sensor can measure them.

ISF glucose lags capillary blood glucose by ~5–15 minutes. This lag is a
hardware property, not correctable in software — dashboards must label
"current" values as *ISF glucose ~5–15 min behind blood*.

## 2. What the sensor stores (raw FRAM, Libre 1/2)

Verified against vicktor/FreeStyleLibre-NFC-Reader wiki, jamorham/xDrip-plus
`NFCReaderX.java`, JohanDegraeve/xdripswift `LibreDataParser.swift`, and
gui-dos/DiaBLE `Libre.swift`.

| Region | Bytes | Content |
|---|---|---|
| Header CRC | 0–1 | CRC-16/CCITT over bytes 2–317 |
| Patch info | 2–3 | sensor type / patch identifier |
| State byte | 4 | sensor state (not activated / active / expiring / expired / shutdown / failure) |
| Trend buffer | 28–123 | 16 records × 6 bytes, 1-min interval, ring buffer (~last 15 min) |
| History buffer | 124–315 | 32 records × 6 bytes, 15-min interval, ring buffer (~last 8 h) |
| Sensor age | 316–317 | life counter, minutes since activation (little-endian) |
| Max life | 326–327 | configured lifetime in minutes (Libre 2: 20160 = 14 days) |
| Calibration footer | 2, 0x150 | per-sensor factory calibration parameters (i1–i6) |
| Trend write index | 26 | ring pointer: next trend slot to be written |
| History write index | 27 | ring pointer: next history slot to be written |

Each 6-byte record, decoded bit-level (DiaBLE bit offsets):

| Field | Bit offset | Bits | Notes |
|---|---|---|---|
| Raw glucose | 0 | 14 | `0x3FFF` mask (byte-swapped view) |
| Quality | 0x0E | 11 | 0 = good; error flags on `0x8000`-style bits |
| Error flag | 0x19 | 1 | 1 = invalid/errored record |
| Raw temperature | 0x1A | 12 | stored as top 12 bits of the 14-bit word; read back `<< 2` |
| Temperature adjustment | 0x26 | 9 | signed via sign bit at 0x2F; used by OOP |
| Sign | 0x2F | 1 | sign of the temperature adjustment |

Equivalently, LibreMonitor's byte view: raw glucose = swap(bytes 0–1), mask
`0x3FFF`; raw temperature = swap(bytes 3–4), mask `0x3FFF`. The bit-level and
byte-level views agree (the 12-bit temperature field is the top 12 bits of the
14-bit word, so the low 2 bits of the byte-swapped pair are dropped by the
mask).

History timing (xDripswift): history slots are committed every 15 minutes but
the value is written ~3 minutes late — the newest history reading is
`(age − 3) % 15 + 3` minutes old. Trend values are 1 minute apart.

## 3. Calibration: raw counts → mg/dL

Raw glucose counts are **not** a glucose reading. The community-reverse-
engineered transform is linear:

```
glucose_mgdl = slope(raw_temp) * raw_glucose + offset(raw_temp)
```

where slope and offset are themselves linear in raw temperature:

```
slope(raw_temp)  = slope_slope  * raw_temp + slope_offset
offset(raw_temp) = offset_slope * raw_temp + offset_offset
```

LibreMonitor's "Libre OOP Investigation" documents an example sensor:

| Parameter | Value |
|---|---|
| slope at raw_temp 7124 | 0.113 mg/dL per count |
| offset at raw_temp 7124 | −21.1 mg/dL |
| slope(raw_temp) | 0.000015623 × raw_temp + 0.0017457 |
| offset(raw_temp) | −0.0002327 × raw_temp − 19.47 |

The simple (temperature-independent) form `glucose = 0.13 × raw − 20`
"mostly works fine" for typical sensors but must be tuned per sensor. Real
sensors carry their **factory calibration parameters in the FRAM footer**
(i1–i6 — DiaBLE extracts these at byte 2 and 0x150). The mapping from i1–i6 to
slope/intercept is not fully public; the reference parser exposes the raw
values and lets the operator supply calibration constants.

Range: OOP returns 39–501 mg/dL — 39 is "LO", 501 is "HI"; the linear range is
40–500 mg/dL.

## 4. Raw temperature → Celsius

The exact thermistor transfer function is Abbott-proprietary; LibreMonitor
explicitly defers to Pierre Vandevenne's blog (not fully indexed). What is
verified from the OOP investigation is an **inverse relationship**:

| Raw temperature | Observed condition |
|---|---|
| 7124 | room temperature ≈ 25 °C |
| 5816 | highest (warm water) |

The reference parser ships a two-point linear fit through those observations
(`a = −0.009174 °C/count`, `b = +90.36 °C`) and labels it clearly as a
community calibration requiring per-sensor verification — not an official
Abbott formula. The raw temperature count is the authoritative metric.

## 5. Sensor temperature is the OOP's key covariate

The temperature field is not just a "nice extra": the calibrated glucose
*requires* it. The per-sensor slope and intercept drift with thermistor
reading, and the OOP uses the temperature adjustment field (bytes 3–4 + adj
bits) to keep the linear transform accurate across the thermal range. This is
the mechanism that "decouples ambient/skin temperature effects from the
glucose-related voltage reading" — it is already inside the calibration
model, not a separate post-hoc correction.

## 6. Libre 2 crypto caveat — the big operational wall

Libre 1 FRAM reads over NFC are plaintext. **Libre 2 is different**: the FRAM
is encrypted and a shared key is established during the first NFC scan. Whoever
scans first (the official LibreLink app, a patched app, xDrip, etc.) holds the
pairing key; other readers cannot decrypt the sensor data. Confirmed by
xDrip+/AAPS Libre 2 setup docs and DiaBLE's Libre 2 decryption path.

Additional NFC artifact: a Libre 2 NFC scan returns a raw glucose of 0 and
reinterprets the temperature field as an RF-error code (e.g. `32` = `RF`)
because the NFC antenna draw corrupts the live measurement (DiaBLE discussion
#9). The last good values for a single scan therefore come from the history
buffer, not the live trend. The reference parser flags such records as
corrupted instead of emitting garbage.

This means any raw-data pipeline for this dashboard needs **hardware + the
pairing key**, not just a code change.

## 7. What LibreLinkUp (the current pipeline) exposes

From pylibrelinkup v0.10.0 (Context7 docs + source):

- `GlucoseMeasurement`: `timestamp`, `factory_timestamp`, `value_in_mg_per_dl`,
  `value`, `is_high`, `is_low`, `measurement_color`, `glucose_units`, `type`
- `graph()`: ~last 12 hours of calibrated values
- `logbook()`: ~last 14 days of event-tagged measurements (food/insulin notes
  if the user logged them)
- `latest()`: most recent calibrated value + trend arrow

**No raw current, no temperature, no sub-15-minute resolution, no sensor
diagnostics.** The cloud API is a *calibrated-values-only* surface. Everything
the current dashboard can know is already calibrated mg/dL at 15-min/1-h
granularity.

## 8. Sources

Web / primary:

- LibreMonitor — Libre OOP Investigation (temperature bytes, OOP slope/offset):
  https://github.com/UPetersen/LibreMonitor/wiki/Libre-OOP-Investigation
- vicktor/FreeStyleLibre-NFC-Reader wiki — FRAM layout, ring buffers, decoding:
  https://github.com/vicktor/FreeStyleLibre-NFC-Reader/wiki/Progress-&-ToDo
  https://github.com/vicktor/FreeStyleLibre-NFC-Reader/wiki/Decoding-of-tag-data
- jamorham/xDrip-plus `NFCReaderX.java` — trend/history ring parsing, sensor
  time, raw masks: https://github.com/jamorham/xDrip-plus
- JohanDegraeve/xdripswift `LibreDataParser.swift` — history delay formula,
  sensor time: https://github.com/JohanDegraeve/xdripswift
- gui-dos/DiaBLE `Libre.swift` — bit-level record decode, calibration info
  (i1–i6): https://github.com/gui-dos/DiaBLE
- glucometer-protocols `abbott/freestyle-libre.md` — reader-device HID protocol,
  record field meanings (food flag, insulin, direction arrows):
  https://github.com/glucometers-tech/glucometer-protocols
- DiaBLE discussion #9 — Libre 2 NFC raw-0/RF-error artifact; Libre 3 payload
  layout: https://github.com/gui-dos/DiaBLE/discussions/9
- xDrip+/AAPS Libre 2 docs — shared-key pairing, OOP2:
  https://wiki.aaps.app (Libre 2 Minimal L00per page)
- Flameeyes blog — Libre CGM reverse-engineering chapter 1 (reader protocol,
  records): https://flameeyes.blog/2016/03/21/reverse-engineering-the-freestyle-libre-cgm-chapter-1/

Context7:

- `/websites/pylibrelinkup_readthedocs_io_en` — pylibrelinkup data model
  (GlucoseMeasurement), graph/logbook surface. Confirms the cloud API returns
  only calibrated values + trend.
