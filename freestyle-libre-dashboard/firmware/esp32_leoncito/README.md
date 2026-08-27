# Leoncito ESP32 fetcher — `firmware/esp32_leoncito`

24/7 fetch node for the Leoncito glucose dashboard, running on the owner's
**Waveshare ESP32-S3-Touch-AMOLED-1.8** (ESP32-S3R8, 16 MB quad flash, 8 MB
OPI PSRAM). Sits on USB power with the board's lithium battery as outage
carry-through (charging/failover is handled by the board's power circuit, no
firmware involvement).

```
[LibreLinkUp API] ──(home Wi-Fi, residential IP)──▶ [ESP32: llu_client]
                                                        │ POST /api/ingest (Bearer)
                                                        ▼
                                  [leoncito-glucose Worker] ──▶ KV merge ──▶ app.ygdcbtmc4u.uk/leoncito
```

Runs **alongside** the Mac/Lima home-fetcher (NID-403) — the worker's merge is
idempotent (dedupe by timestamp), so both nodes pushing the same ~12h window
is redundancy, not conflict. Whichever node is alive keeps the dashboard fresh.

## Why not direct sensor BLE (yet)

The current Libre 2 sensor established its crypto session with the owner's
iPhone at activation (NID-398 validation spike). BLE streaming requires
NFC-derived unlock material this device does not hold, and the sensor accepts
its bonded phone only — so this firmware **never initiates a BLE connection**
to the sensor. `ble_watch.cpp` does passive advert scans only (listen, never
transmit-to-sensor) as groundwork. The direct path opens at the **next sensor
change**: activate reader-first with the PN532 (see
`research/esp32-pn532-hardware.md`), then this firmware grows the
authenticated GATT session.

## Protocol facts (verified live 2026-08-24)

- LLU region for this account: `la` (EU login redirects there)
- Minimum client version header: `4.16.0` (older gets `{"minimumVersion"}`)
- `account-id` header = SHA-256 hex of `data.user.id` — required
- `FactoryTimestamp` is UTC (`M/D/YYYY h:mm:ss AM`); the naive local
  `Timestamp` is ignored (NID-403 3h-early lesson)
- `TrendArrow` 1–5 → `DOWN_FAST … UP_FAST`; the worker maps enum → label
- Ingest contract exercised end-to-end from host with this exact payload
  shape: HTTP 200, readings merged

## Session discipline ("keep session alive")

- LLU bearer token (valid ~months) + account hash + patientId persist in NVS —
  reused across polls **and reboots**; re-login only on 401/expiry
- Wi-Fi auto-reconnect with exponential backoff (2 s → 2 min cap)
- Poll every `poll_s` (default 300 s); each push re-sends the full ~12h LLU
  window, so any outage shorter than ~12 h loses nothing
- 3-min hardware watchdog + reboot after 24 consecutive failed cycles

## Wi-Fi setup — on-device captive portal (no computer needed)

With no Wi-Fi saved (or if the saved network won't connect for 25 s) the
board turns into a setup hotspot and the AMOLED shows the steps:

1. On a phone, join Wi-Fi **`Leoncito-Setup`** (password **`leoncito1`**).
2. The setup page opens automatically (or browse to `192.168.4.1`).
3. *Configure WiFi* → the board lists the networks it sees → pick one →
   type its password → Save.

The board joins, stores SSID + password in its own NVS (nothing leaves the
device — not the repo, not a vault), and switches to the status screen
(latest glucose, link, last push). Portal times out after 15 min and reboots
to retry. `portal` on the console forgets Wi-Fi and re-enters setup.
Everything else (console, BLE watch) keeps running while the portal is up.

## Screen

The owner's board is **revision V2** (I2C scan: CST820 touch at 0x15 — V1
has FT3168 at 0x38), so the panel is a **CO5300**, driven by upstream
Arduino_GFX 1.4.9's `Arduino_CO5300` over QSPI (same pins as V1, column
offset 16, 40 MHz). Headless-safe: if the TCA9554 expander doesn't answer,
the firmware logs it and runs without a display. Console `i2c-scan` shows the
revision; `screen-test` cycles colours + text. Touch is not used yet.

## Provisioning the rest (no secrets in git or in the binary)

LLU credentials + ingest token live in device NVS, written over USB serial:

```bash
# interactive
screen /dev/cu.usbmodem101 115200     # then: help
set wifi_ssid Casita
set wifi_pass <the Wi-Fi password>
run        # immediate fetch+push
status

# or scripted from env (secrets masked in output)
WIFI_SSID=Casita WIFI_PASS=... python3 tools/provision.py --show
```

Console: `show` `set` `clear` `wifi-scan` `run` `status` `ble` `llu-reset`
`reboot`. Note: NVS is not flash-encrypted; anyone with physical USB access
can extract settings. Acceptable for a home device; flash encryption is a
possible (irreversible, eFuse-burning) follow-up — **not** done casually.

## TLS

Pinned root bundle (`src/certs.h`): GTS Root R4 + R1 — both
`api-*.libreview.io` and `app.ygdcbtmc4u.uk` serve Google Trust Services
chains today. If a chain rotates off GTS the fetch fails loudly;
`set tls_insecure 1` is the console escape hatch while a new root ships.

## Known risks / open items

- **Cloudflare Bot Fight Mode TLS fingerprinting**: CPython's handshake was
  blocked (error 1010) on our own zone (see `push_to_ingest` in
  `scripts/fetch_glucose.py`); curl passes. The ESP32 mbedTLS fingerprint is
  untested against both zones until Wi-Fi credentials are provisioned. If our
  zone blocks it: add a WAF skip rule for `/api/ingest` (main.tf). If
  libreview.io blocks it: revisit (e.g. fetch via worker proxy is NOT possible
  — LLU blocks CF egress — so a small LAN relay or UA/TLS tuning would be next).
- Touch keyboard on the panel (FT3168) is a possible follow-up; the phone
  captive portal covers Wi-Fi entry today.
- Events (`food`/`insulin` logbook) are not fetched by the ESP32; the Mac
  fetcher still covers them.

## Flash / restore

- Build+flash: `pio run -t upload` (PlatformIO; port `/dev/cu.usbmodem101`)
- A full 16 MB backup of the factory Waveshare demo was taken before first
  flash (2026-08-24) and lives on the host Mac; restore with
  `esptool --port /dev/cu.usbmodem101 write-flash 0x0 esp32s3_flash_backup_2026-08-24.bin`
