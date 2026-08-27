# ESP32 + PN532 Firmware — Stage 3a Plan (Waveshare ESP32-S3-Touch-AMOLED-1.8)

> **Plan only — 2026-08-21.** The ESP32 on `/dev/cu.usbmodem101` was probed read-only (chip-id / flash-id / partition dump). No flash writes were made. This document records the live integrity snapshot, the firmware architecture, and the bring-up sequence so the next run can flash with zero discovery cost.

---

## 0. Live integrity snapshot (2026-08-21)

```
Port:            /dev/cu.usbmodem101  (also /dev/tty.usbmodem101, USB-Serial/JTAG)
Chip:            ESP32-S3 (QFN56) rev v0.2, 240 MHz, Dual + LP core
Features:        Wi-Fi, BLE 5 (LE), 8 MB PSRAM (AP_3v3), 40 MHz crystal
Flash:           16 MB quad, 3.3 V, manuf 0x20 dev 0x4018, 16 MB detected
MAC:             28:84:85:55:58:3c
Security:        Secure Boot DISABLED, Flash Encryption DISABLED, SPI_BOOT_CRYPT_CNT 0x0
Partitions:
  nvsfactory  0x009000  200 KB
  nvs         0x03b000  840 KB
  otadata     0x10d000    8 KB
  phy_init    0x10f000    4 KB
  factory     0x110000 5632 KB   ← Brookesia demo lives here
  ota_0       0x690000 3072 KB
  assets      0x990000 3072 KB
  storage     0xc90000 3520 KB   ← demo MP3/assets
Factory app:  ESP-Brookesia phone demo, IDF v5.5.4-dirty, dates May 26/27 2026,
              LVGL, SH8601 AMOLED (368×448), FT3168 touch, QMI8658, PCF85063, AXP2101
Health:       PASS — blank-check not needed, factory boots; OTA slots free
Toolchain:    esptool v5.3.1 via /Users/nahuelavalos/.local/bin/esptool
```

**Recommendation before first flash:** back up the factory demo (reversible):
```sh
esptool --port /dev/cu.usbmodem101 read-flash 0x110000 0x580000 factory_backup.bin
esptool --port /dev/cu.usbmodem101 read-flash 0x8000 0x1000 part_backup.bin
```

---

## 1. Goals (from NID-399)

1. On a **fresh sensor**, ESP32+PN532 scans **first** → obtains Libre 2 pairing key.
2. Every 60–300 s: dump decrypted **344-byte FRAM** over NFC.
3. Parse locally or forward raw bytes; compatibility with `LibreRawParser` (`research/libre_raw_parser.py`).
4. Bridge via **BLE GATT** to phone → `POST /raw-ingest` (Cloudflare Worker `talvi/leoncito` or `cinto` — TBD).
5. Unlock: `temperature_celsius`, `glucose_velocity_mgdl_per_min`, `flags.eating_event/sleep/unlogged_spike`.

Out of scope this stage: collar miniaturization, always-on daemon polish, dashboard charts (3A5).

---

## 2. Hardware wiring (read before soldering)

Full guide: `research/esp32-pn532-hardware.md` §4.

- **PN532 bus: I²C** (`0x24` / 8-bit `0x48`) — 2-wire, 3.3 V, no level shifter. 100 kHz to start, 400 kHz after validation.
- **Free pads:** use the exposed `SDA`/`SCL` pad (check your board's silkscreen photo). Avoid QSPI display pins. Share is safe — existing I²C devices are at `0x20` (TCA9554), `0x38` (FT3168), `0x51` (PCF85063), `0x6A` (QMI8658); `0x24` does not collide.
- **Jumpers on PN532 board:** `SEL0=L SEL1=H` for I²C (verify on your module's silkscreen).
- **Power:** `3V3` + common `GND` + 100 µF cap at module; ~80–150 mA RF burst.
- **First-wire test:** after soldering, flash the `i2c_scan` sketch (Arduino Wire) and confirm `0x24` appears alongside the onboard devices.

---

## 3. Firmware architecture

### 3.1 Stack choice

- **Primary:** **ESP-IDF 5.3** (C/C++) — best BLE + deep-sleep + NVS control for this S3 board; AMOLED BSP is IDF-first in Waveshare's repo (`esp32_s3_touch_amoled_1_8` component). Arduino is fallback if PN532 library is Arduino-only.
- **Alt:** Arduino core 3.0.6 + `Adafruit_PN532` (proven for Libre-2 sketches) — faster to port community Libre sketches. Decision gate: if the first IDF bring-up stalls on PN532 driver, switch to Arduino and keep the same GATT contract.

### 3.2 Modules

```
firmware/esp32_pn532/
├── platformio.ini            # (future) env:esp32-s3-devkitc-1, framework=arduino or espidf
├── src/main.cpp              # plan skeleton (this repo — not flashed yet)
├── lib/
│   ├── pn532/                # Adafruit PN532 or esp-idf-lib/nfc wrapper
│   └── libre2/               # Libre 2 ISO-DEP mutual auth + FRAM crypto
├── docs/bringup.md           # i2c_scan + first-scan checklist
└── README.md                 # this file
```

| Module | Responsibility | Library / reference |
|---|---|---|
| `bsp` | init AXP2101, display, LVGL, PSRAM — reuse Waveshare `esp32_s3_touch_amoled_1_8` BSP | waveshare BSP on GitHub |
| `nfc` | PN532 init (I²C), `inListPassiveTarget`, ISO-DEP (14443-4A), Libre 2 `anticollision → select → mutual auth` | Adafruit PN532; community ports: `freestyle-libre-esp`, `Libre-2-NFC-ESP32` |
| `libre2_auth` | derive per-sensor session key on **first scan**, persist to NVS; on later scans reuse key; flag `RF_ERROR` slot | xDrip+ OOP2 key derivation notes, DiaBLE `Libre.swift` decrypt |
| `fram` | issue `ReadMultipleBlocks` to dump **344-byte FRAM**, CRC-16/CCITT check (`libre_raw_parser.py: crc16_ccitt`), ring-buffer indexes at 26/27 | same as above |
| `ble_gatt` | BLE GATT server: service `0xF0C0` / char `FRAM` (344 B, notify), char `STATUS` (JSON), char `CTRL` (scan-now) | ESP-IDF Bluedroid / NimBLE |
| `store` | NVS: `sensor_uid`, `session_key`, `sensor_start_utc`, FRAM ring for offline queue (5–10 dumps → BLE batch) | `nvs_flash` |
| `ui` | AMOLED: "Ready / Place sensor / Pairing… / Key OK / RF_ERROR / FRAM 344 B / BLE → phone" + battery | LVGL (Brookesia already wired) |
| `power` | AXP2101 + light-sleep between polls (60–300 s interval, configurable via BLE `CTRL`) | IDF power mgmt |

### 3.3 BLE GATT contract (phone bridge reads this)

| Element | UUID (example) | Props | Payload |
|---|---|---|---|
| Service `LEONCITO_RAW` | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` or `0000f0c0-…` | — | — |
| Char `FRAM_RAW` | `6e400002-…` | Notify, Read | 344-byte FRAM LE bytes (binary) |
| Char `FRAM_META` | `6e400003-…` | Notify, Read | JSON: `{sensor_uid, sensor_time_minutes, crc_ok, rssi, uptime_s, key_present}` |
| Char `CONTROL` | `6e400004-…` | Write | `{"cmd":"scan_now"}` / `{"cmd":"set_interval","seconds":120}` |
| Advertising | name `Leoncito-NFC` | — | `flags 0x06`, service UUID, `tx_power` |

Chunking: BLE notify MTU ~185–512 B on S3 → send 344 B as two writes (e.g. 180+164) or one if MTU negotiated ≥ 344. Phone reassembles before `POST`.

### 3.4Poll loop

```
loop():
  if now - last_scan < interval_s: sleep
  if nfc.isTagPresent():
     fram = nfc.dumpFram()          # 344 B, ISO-DEP auth if key held
     crc_ok = crc16_ccitt(fram[2:318]) == (fram[0]|fram[1]<<8)
     if !crc_ok: ui.warn("CRC fail"); retry next cycle
     if framHasRfError(fram): ui.warn("RF_ERROR — history buffer still valid")
     nvs.store(fram, meta)
     ble.notifyFram(fram, meta)
     ui.showSuccess(fram, meta)
  else:
     ui.idle()
  if ble.connected: flushOfflineQueue()
```

**Key persistence:** on first-scan success, write `sensor_uid → {session_key, sensor_start_utc}` to NVS; on sensor change the old key becomes invalid — next fresh sensor triggers a **new** first-scan pairing (owner must again present ESP32 first per hardware guide §5).

**NFC artifact handling:** `libre_raw_parser.py` already flags `corrupted/has_error` in the live trend slot during RF — firmware forwards raw bytes unmodified and sets `meta.rf_error=true` so the worker/parser can choose history vs trend.

---

## 4. End-to-end flow

```
[Fresh Libre 2 sensor] --NFC ISO-DEP (first scan, <15mm)--> [ESP32-S3 + PN532]
                                                           | 344 B FRAM, CRC OK
                                                           | NVS key store
                                                           v  BLE GATT notify
                                                    [Phone bridge app]
                                                           | POST /raw-ingest (bearer)
                                                           v
                                              [Cloudflare Worker: /raw-ingest]
                                                       LibreRawParser (TS port or Pyodide)
                                                       -> merge into data/glucose.json
                                                           v
                                                    [Dashboard: temp / ROC / flags]
```

Phone bridge is batching + offline queue (see §5). Worker is validate + parse + merge (see §6).

---

## 5. Phone bridge (Android, plan)

- **Preferred:** extend **xDrip+** (already speaks Libre 2 NFC/BLE + OOP2) — add a custom uploader that mirrors readings to `POST https://app.ygdcbtmc4u.uk/leoncito/api/raw-ingest` with `Authorization: Bearer <INGEST_TOKEN>` (same gate as `/api/ingest`). This avoids a new app.
- **Minimal custom app (fallback):** tiny Kotlin app (one Activity + Foreground Service): scans BLE `Leoncito-NFC`, connects, subscribes to `FRAM_RAW`/`FRAM_META`, reassembles 344 B, `POST`s to `/raw-ingest`, retries with exponential backoff. Stores 24 h offline queue in Room if Worker unreachable.
- **Reconnection:** auto-reconnect every 15 s while ESP32 advertises; show notification "Leoncito NFC connected / N readings pending".
- **No iOS app this stage** — owner has iPhone; BLE bridge is a **borrowed Android or cheap Android phone** ($0 if available) or skip BLE and have ESP32 post via **Wi-Fi** directly when on home network (ESP32 can `POST /raw-ingest` itself if Wi-Fi creds are provisioned via the touch UI — cheaper than BLE bridge; add as optional `CONFIG_WIFI_DIRECT` flag).

---

## 6. Worker endpoint `/raw-ingest` (plan)

Location: `talvi/freestyle-libre-dashboard/worker.js` (current Worker is Pages+proxy; spec says `src/routes/raw-ingest.ts` in issue — adapt to `worker.js` routing).

- **Auth:** `Authorization: Bearer <INGEST_TOKEN>` (same secret as `/api/ingest`), plus `Content-Type: application/octet-stream` or `application/json`.
- **Payload:** either raw 344-byte binary (preferred, one FRAM dump) or JSON `{fram_hex: "0011…", sensor_uid, sensor_start_iso, rssi}`.
- **Validation:** size == 344, header CRC `crc16_ccitt(fram[2:318])` matches `fram[0..1]` LE, reject `sensor_time > max_life`, reject if all-zero.
- **Parse:** call a **TypeScript port** of `LibreRawParser` (bit offsets, CRC, trend/history ring, factory calibration i1..i6, temperature C, velocity, flags). Port lives in `lib/libre_raw_parser.ts` (mechanical translation of `research/libre_raw_parser.py` — 344 B geometry + `read_bits` + calibration constants). Pyodide is fallback if port slips.
- **Schema:** output identical to `research/parser_output_schema.json` (§sensor, trend, history, metrics, validation) — secondary table alongside `data/glucose.json` or merged as `raw:{temperature_celsius, velocity, flags}` fields on overlapping timestamps.
- **Merge:** same `mergeHistory` strategy as `worker.js` existing ingest (dedup by timestamp, 120-day cap, ART normalization). Write to KV `raw.json` or extend `glucose.json` with `readings[i].raw`.
- **Dashboard (3A5, follow-up):** secondary Y-axis for temperature, eating-event markers, sleep shading, `unlogged_spike` badge — no dashboard code this stage.

---

## 7. Bring-up sequence (next runs, do not execute now)

1. **Buy PN532 V3**, photo board pads, confirm 3.3 V rail with DMM.
2. Solder 4-wire I²C, add 100 µF cap, set I²C jumpers. Power via USB, not battery.
3. Flash **i2c_scan Arduino sketch** → expect `0x20 0x38 0x51 0x6A 0x24` → confirms wiring.
4. Flash **PN532 `readMifare`** example → confirms RF field toggles.
5. Flash **Libre firmware** from `src/main.cpp` (this skeleton → expanded with real `libre2_auth` port).
6. **Fresh sensor test:** ESP32 first-scan (antenna <15 mm, 2–3 s) → expect `FRAM 344 B / Key OK / crc_ok=true` on AMOLED + BLE notify. Only then scan iPhone.
7. Capture FRAM hex via BLE or serial, run `python3 research/libre_raw_parser.py --fram <hex> --start <ISO>` → expect `validation.header_crc16_ok == true` and historical records clean.
8. `POST /raw-ingest` with captured FRAM → verify Worker parse + KV write.

If any step fails: fall back to SPI wiring (Option B in hardware guide) or Arduino core for PN532 library compatibility.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **This ESP32 is 60×36 mm — too large for a collar** | Bench validator only; final wearable is a mini board (ESP32-C3 SuperMini / S3-Mini, ~20×18 mm) + flex PN532 antenna. |
| **I²C bus shared with touch/RTC/IMU** | Address `0x24` is free; run scan; keep bus at 100 kHz during NFC; avoid SD+I²C concurrency. |
| **Libre 2 key loss on sensor change** | Owner protocol §5 in hardware guide; firmware NVS stores per-sensor key, clears on new UID. |
| **RF burst starves 3.3 V / resets** | 100 µF + short leads; AXP2101 rail not VBAT. |
| **Wi-Fi vs BLE bridge** | Offer both: BLE for offline cat-roaming, direct Wi-Fi POST when at home (touch-provisioned SSID). |
| **Parser drift (Python → TS port)** | Port `read_bits` LSB-first exactly (`(byte>>(bit&7))&1)<<i`); copy `FRAM_SIZE/CAL_FOOTER/TEMP_CAL_A` constants verbatim; run `parser_output_schema.json` as golden test vector. |

---

## 9. What is in this directory

| File | State |
|---|---|
| `README.md` | This plan (integrity + architecture) |
| `docs/bringup.md` | Step-by-step bring-up checklist (next run) |
| `platformio.ini` | Skeleton (IDF vs Arduino envs) |
| `src/main.cpp` | Minimal skeleton: BSP init → BLE advertise → PN532 stub — not flashed |

## 10. References

- Hardware: `research/esp32-pn532-hardware.md`
- Research: `research/freestyle-libre-raw-capabilities.md`, `libre2-nfc-validation-spike.md`, `feasibility-matrix.md`
- Parser: `research/libre_raw_parser.py`, `research/parser_output_schema.json`
- Waveshare BSP: https://github.com/waveshareteam/ESP32-S3-Touch-AMOLED-1.8 (BSP component `esp32_s3_touch_amoled_1_8`)
- Community Libre ports: `freestyle-libre-esp`, `ESP32-LibrelinkUp`, DiaBLE `Libre.swift` decrypt
