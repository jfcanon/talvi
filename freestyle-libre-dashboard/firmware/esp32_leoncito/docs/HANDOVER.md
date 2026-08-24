# Leoncito ESP32 — handover (2026-08-24, NID-399 session)

Self-contained state of the ESP32 work so a fresh run can continue without
re-reading the NID-399 thread. Grounding: `sb query "leoncito esp32 handover"`,
gbrain entity `leoncito-esp32`. Code: PR https://github.com/jfcanon/talvi/pull/215
(branch `agent/lane-cc-fable/50d06243`), dir `freestyle-libre-dashboard/firmware/esp32_leoncito/`.

## What is running right now

- Device: Waveshare **ESP32-S3-Touch-AMOLED-1.8, revision V2** (I2C scan on the
  owner's unit: `0x15` CST820 touch ⇒ **CO5300** panel; also 0x18 ES8311,
  0x20 TCA9554, 0x34 AXP2101, 0x51 PCF85063, 0x6B QMI8658). Earlier notes
  claiming SH8601/FT3168 (V1) were wrong. 16 MB quad flash, 8 MB OPI PSRAM.
- Firmware `esp32_leoncito` (PlatformIO, Arduino core 2.x via `espressif32@^6.9`):
  Wi-Fi (`Casita`, captive-portal setup `Leoncito-Setup`/`leoncito1`) →
  LibreLinkUp fetch every 300 s → POST `https://app.ygdcbtmc4u.uk/api/ingest`
  (bearer). Status screen: glucose, trend, time in ART, Wi-Fi, last push.
  Passive-only BLE advert watch (never connects). Console over USB CDC
  115200: `help show set clear wifi-scan run status ble i2c-scan screen-test
  llu-reset portal reboot`.
- **It is the sole dashboard feeder**: the owner shut the Lima VM home-fetcher
  (NID-403) down on 2026-08-24. Verified: 46–47 readings per cycle accepted,
  worker total ~674, zero failures. Cloudflare accepts the ESP32 TLS handshake.
- Secrets live only in device NVS (LLU creds + ingest token from Bitwarden
  items `LIBRELINK_EMAIL_2`/`LIBRELINK_PASSWORD_2`/`Leoncito ingest token`;
  Wi-Fi password entered by the owner via the portal — **never** in the vault,
  by the owner's explicit wish).
- Factory-firmware backup (16 MB) on the runtime Mac:
  `multica_workspaces/07fee086-…/50d06243/workdir/esp32s3_flash_backup_2026-08-24.bin`
  (restore: `esptool --port /dev/cu.usbmodem101 write-flash 0x0 <file>`).

## How to build / flash / talk to it (runtime Mac)

```bash
PIO=~/.leoncito-pio-venv/bin/pio        # PlatformIO in a venv (pyserial too)
cd freestyle-libre-dashboard/firmware/esp32_leoncito
$PIO run -t upload                      # port /dev/cu.usbmodem101 (USB-Serial-JTAG)
# console: screen /dev/cu.usbmodem101 115200   or   tools/provision.py <cmd>
# if "port busy": retry after a few seconds (transient after a serial session)
```

Opening the port may reset the board; boot log shows `[display] CO5300 up`,
`[wifi] link up`, `[cycle] ok: pushed N readings`.

## Verified protocol facts (LibreLinkUp, 2026-08-24)

- Login `POST https://api-eu.libreview.io/llu/auth/login` redirects this
  account to region **`la`** → use `api-la.libreview.io`.
- Headers: `product: llu.android`, **`version: 4.16.0`** (older ⇒
  `{"minimumVersion"}`), `account-id: sha256hex(data.user.id)`,
  `Authorization: Bearer <authTicket.token>` (token valid ~months; persisted).
- `GET /llu/connections` → `data[0].patientId`;
  `GET /llu/connections/{pid}/graph` → `data.graphData[]` (~45 pts / 12 h) +
  `data.connection.glucoseMeasurement` (live). `FactoryTimestamp` is **UTC**
  in `M/D/YYYY h:mm:ss AM`; the naive `Timestamp` is ART — ignore it.
  `TrendArrow` 1–5 ⇒ DOWN_FAST … UP_FAST. Responses are **chunked** — use
  `HTTPClient::getString()`; `getStream()` breaks ArduinoJson silently.
- `/logbook` for this account holds only NFC-scan (type 1) and alarm (type 3)
  entries — no meals/insulin — so the ESP32 not fetching it loses nothing.
- Ingest contract: `{readings:[{timestamp ISO, glucose, unit:"mg/dL"}],
  sensor_id, trend, last_updated}` → worker merges idempotently (dedupe by ts).

## The direct-sensor goal — corrected understanding

Owner's goal: ESP32 near the cat, 24/7 on USB + Li battery, reading the
Libre 2 **directly over Bluetooth** and uploading; iPhone becomes optional.

- Libre 2 BLE has **one listener at a time**. Whoever **NFC-scans last sets
  the BLE key** (streaming unlock) and receives the live stream. Third-party
  apps (xDrip+) take over **running** sensors this way — no fresh sensor
  needed. A LibreLink NFC scan on the phone steals the stream back
  (ping-pong). Sources: xDrip+ Libre setup docs, AndroidAPS Libre2 guide,
  DiaBLE README, NightscoutFoundation/xDrip#4363.
- The phone's key cannot be exported (iOS sandbox) and is worthless to copy:
  the ESP32 must **set its own** via an NFC tap. No tap ⇒ no stream.
- **PN532 is the wrong chip**: it does not implement ISO 15693 (NFC-V), which
  every Libre uses. Working Libre readers use **PN5180**, CR95HF (BM019) or
  ST25R3916. PN5180 modules: ~USD 6–13 (Elechouse 12.80), SPI + BUSY + RST,
  5 V RF supply + 3.3 V logic. Known snag: Arduino PN5180 libs need work for
  Libre custom commands (playfultechnology/PN5180#2: inventory OK, `0xA1`
  times out; iPhone CoreNFC does Select 0x25 + high-data-rate flag 0x12 and
  keeps the field on). `captainbeeheart/pypn5180` proves the chip can do
  A0/A1/A5 custom commands.
- BLE decryption + streaming-unlock payload exist open-source in Swift
  (gui-dos/DiaBLE `Libre2.swift`, LibreTransmitter `Libre2BLEUtilities`)
  and in xDrip+ (Java). **Caveat**: "Gen2" sensors (Libre 2 Sense/US/CA/AU,
  Libre 2 Plus?) are *not* reversed per DiaBLE — the exact sensor generation
  on the cat must be checked (LLU `connection.sensor` / patchInfo).
- Header GPIO on the Waveshare board (variant `pins_arduino.h`): 1–7 (but
  4–7 = panel QSPI, 1–3 = SD), 33–40, 43/44 (UART), 17/18. SPI2 defaults
  34/35/36/37 (SS/MOSI/SCK/MISO) — candidates for the PN5180.

## Open decisions for the convergence step

1. Reader: PN5180 vs CR95HF vs ST25R3916 vs iPhone-as-reader (DiaBLE mod).
2. Sensor generation on the cat ⇒ is the BLE crypto reversed for it?
3. Stream ownership policy: ESP32 owns BLE (LibreLink/LibreView go
   scan-only; dashboard depends solely on ESP32) vs phone keeps it.
4. Physical: fixed ESP32 near the resting spot (BLE range) + one manual NFC
   tap, vs anything collar-mounted (the AMOLED board is not collar-sized).
5. Obsolete: the older `esp32_pn532` skeleton branch
   `agent/lane-muse-spark-1-2-zen/3cf56ff1` (wrong chip).
