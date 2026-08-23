# Libre-2 NFC Validation Spike Protocol

**Issue**: NID-398 — Stage 2 validation before committing to Path B hardware investment
**Status**: Ready for execution by sensor owner; claims validated 2026-08-21 (Appendix A) against `freestyle-libre-raw-capabilities.md` + community sources
**Cost cap**: ≤ $100 total; $0 alternative exists (phone-only, **Android required**); ~$15 ESP32 path for the iOS-only owner
**Owner reality (NID-398 thread)**: iPhone 13 mini only, LibreLink already paired to the active sensor, no Android device, one ESP32 available.

---

## 1. Hardware Shortlist

| Option | Hardware | Approx. Cost | How it obtains the pairing key | Libre-2 encryption bypass? |
|--------|----------|--------------|--------------------------------|----------------------------|
| **A. Android phone** | Any Android phone with NFC + **xDrip+** (free, F-Droid) + **OOP2** helper | **$0** | Must scan **first** on a fresh sensor. xDrip+ gets the private shared key during that first NFC scan; OOP2 then decrypts raw FRAM. If LibreLink already scanned first, the key is held elsewhere — this reader gets ciphertext / `raw=0` artifact. | **No bypass.** Key-holder wins. Works only if this phone does the *first* scan on a fresh sensor. |
| **B. ACR122U USB NFC reader** | ACS ACR122U-A9 (USB-A) or ACR122U-A10 (USB-C) | **$35–50** (Amazon/eBay) | Must be the **first device to scan** a fresh sensor. Uses `libnfc` / `nfcpy` to perform the ISO-DEP handshake and derive the private shared key. Once paired, subsequent reads by *same reader* decrypt FRAM. | **No bypass.** Can decrypt *if it holds the key*. Cannot steal key from another device. |
| **C. Raspberry Pi + PN532 HAT** | Pi Zero 2 W (~$15) + PN532 NFC HAT (~$12–18) + case/SD | **$35–50** | Same as B — must scan first. Runs Python daemon (`nfcpy` or `pyscard`) to pair and dump FRAM continuously. | **Same as B.** Key-holder wins. No cryptanalytic break. |
| **D. ESP32 + PN532 (owner already has ESP32)** | ESP32 (on hand) + PN532 NFC module (~$10–15, SPI/I2C) + jumpers | **~$15–20** | Same as B — must scan first. Flash a Libre-2 NFC auth sketch (community ports exist, e.g. freestyle-libre-esp / ESP32-LibrelinkUp) that performs the first-scan key exchange and dumps decrypted FRAM over serial/WiFi. | **Same as B.** Cheapest non-phone hardware path for an owner with no Android phone. |
| **N/A — iPhone 13 mini (owner's, LibreLink)** | iOS + LibreLink app | **$0** | Already performed the **first scan** on the current sensor → **holds the private shared key**. | **Cannot be a raw reader.** iOS exposes no xDrip+/DiaBLE equivalent; LibreLink reads calibrated values only and never exposes raw FRAM. This is why the current sensor is locked to the phone's key. |

**Critical constraint**: The Libre 2 private shared key is established at **first NFC scan** (the sensor is activated/started by that scan). Whoever scans first — LibreLink app, xDrip+, ACR122U, PN532, ESP32+PN532 — holds the key; every other reader sees either AES ciphertext or the NFC artifact (`raw_glucose=0`, temperature field = RF error code). There is **no software-only bypass** for Libre 2 — decryption requires the key, and the key is only issued to the first scanner (community: xDrip+ Libre 2 setup, OOP2). **This means the active sensor — already first-scanned by the owner's iPhone — cannot be read raw by any other device until it is replaced.**

**iOS note (owner reality)**: There is no Android phone in the household. The iPhone 13 mini cannot act as the Option-A raw reader. The realistic options for *this* owner are: (a) accept PIVOT on the current sensor, and (b) use the **ESP32 + PN532 (~$15–20)** as the *first* scanner on the **next** sensor to attempt the raw path. Option A still applies if the owner borrows/obtains an Android phone for a future sensor.

---

## 2. Step-by-Step Procedure

### Pre-conditions
- Active Libre 2 sensor on the cat (or human for test), **not yet scanned by any NFC device today** (fresh sensor or >1 h since last scan to avoid cached key issues).
- One of the hardware options above available (A–D).
- `libre_raw_parser.py` cloned and runnable (`python3 libre_raw_parser.py --self-test` works).

### Step 0 — Determine the key-holder (do this first, always)

This single fact decides everything downstream:

1. Ask: **has any device already scanned this sensor?** If LibreLink on the owner's iPhone has ever scanned it (the normal case for a Libre 2 user), the iPhone holds the private shared key.
2. Check in the LibreLink app: the sensor shows as activated/paired, and readings flow to the phone. That is proof the first scan already happened.
3. **If the iPhone (or any device) already holds the key → the outcome is already known: PIVOT.** Raw FRAM is unreachable on *this* sensor regardless of reader. Skip straight to §4. The raw path only re-opens on a **fresh sensor** scanned by a non-phone reader first.

### Option A: $0 Phone-only validation (Android only)

> **Not executable on the owner's iPhone** (no xDrip+/DiaBLE on iOS). Included for when an Android phone is available (e.g. borrowed, or a future purchase). Owner with iOS-only should use Option D on the *next* sensor.

1. **Install xDrip+** on an Android phone with NFC (F-Droid or Play Store) + the **OOP2** helper app (required for Libre 2 decryption).
2. **Disable** LibreLink / LibreLinkUp on that phone (force-stop, disable NFC tag polling if possible).
3. **Enable NFC** on the phone. Open xDrip+ → Settings → NFC → "Enable NFC scanning".
4. **Tap the sensor** with the phone back (NFC antenna area). Hold 2–3 s.
5. **Observe xDrip+ result**:
   - **Success**: Raw glucose > 0, raw temperature ~6000–7200, trend/history records populate.
   - **Artifact**: Raw glucose = 0, temperature field = small integer (e.g., 32 = `RF_ERROR`), xDrip+ shows "Tag read error" or "Encrypted tag".
   - **No tag detected**: NFC hardware/position issue; retry.
6. **Export** the raw FRAM bytes if xDrip+ allows (Settings → Export → "Raw NFC data") or note the on-screen decoded values.
7. **Feed bytes to parser**: `python3 libre_raw_parser.py --fram <hex_dump> --start "<sensor_start_ISO>"` and inspect output.

### Option B: ACR122U (if phone fails or for independent verification)

1. Connect ACR122U to Linux/macOS/Windows machine. Install `libnfc`, `nfcpy`, `pcscd`.
2. Verify reader: `nfc-list` or `python3 -m nfc` → should show "ACR122U PICC".
3. Write a minimal Python script using `nfcpy`:
   ```python
   import nfc
   clf = nfc.ContactlessFrontend('usb')
   tag = clf.connect(rdwr={'on-connect': lambda tag: False})
   print(tag.identifier.hex())
   # For Libre 2, need ISO-DEP (Type 4A) mutual auth — see nfcpy examples
   ```
4. Tap sensor. If first scan → `nfcpy` performs pairing, derives session key, reads decrypted FRAM.
5. Save 344-byte FRAM dump to file. Run `libre_raw_parser.py` on it.

### Option C: Pi + PN532 (for always-on daemon path validation)

1. Assemble Pi Zero 2 W + PN532 HAT. Flash Raspberry Pi OS Lite.
2. Enable SPI/I2C/UART (PN532 typically uses I2C or UART). Install `nfcpy`, `pyscard`, `pcscd`.
3. Same pairing logic as B. Goal: verify a headless daemon can pair first and read continuously.

### Option D: ESP32 + PN532 (owner's existing hardware — cheapest non-phone path)

> For the **next** sensor only. The current sensor is already keyed to the iPhone — this can't read it.

1. Wire PN532 to the ESP32 (I2C: SDA/SCL to GPIO21/22 on most ESP32 devboards, or SPI); install the Adafruit PN532 library in the Arduino IDE.
2. Flash a Libre-2 NFC reader sketch. Community ports exist (search `freestyle-libre-esp32`, `Libre-2-NFC-ESP32`, or `ESP32-LibrelinkUp`); the sketch performs the ISO-DEP exchange, obtains the private shared key on first scan, and dumps the 344-byte FRAM (or a decoded JSON) over the serial monitor / WiFi.
3. On the **fresh** sensor (within minutes of removing the old one, before the iPhone scans it): tap the ESP32+PN532 to the sensor. If it is the first scanner, it obtains the key → raw FRAM readable.
4. Capture the FRAM dump (serial monitor log), save to file, run `libre_raw_parser.py` on it.
5. **Test the artifact case too**: after the iPhone has scanned, repeat the ESP32 read → expect `raw_glucose=0` / RF-error, confirming the key is now held by the iPhone.

### Cross-cutting verification steps (run after any successful raw read)

1. **Confirm decryption**: Parser `validation.header_crc16_ok == true`.
2. **Inspect trend buffer**: 16 records, 1-min spacing, raw glucose > 0, raw temp 5800–7200.
3. **Inspect history buffer**: 32 records, 15-min spacing, same.
4. **Check for NFC artifact**: Any record with `glucose_raw == 0` and `has_error == true` / `corrupted == true` → NFC antenna corruption (expected on live trend slot during scan; history should be clean).
5. **Verify temperature signal**: `temperature_celsius` should read 25–38 °C (cat ISF ~37–39 °C; parser linear fit is approximate).
6. **Record which device scanned first** and whether subsequent reads by *other* devices succeed.

---

## 3. Expected Outcomes Matrix

| Outcome | What you see | Meaning for hardware path | Dashboard features unlocked |
|---------|--------------|---------------------------|----------------------------|
| **A1: Phone (xDrip+) reads raw FRAM successfully** | Raw glucose > 0, raw temp valid, CRC OK, trend/history populated | **GO for Path B (phone bridge)**. Owner's phone can be the key-holder; a collar/phone BLE bridge (xDrip+ → Cloudflare Worker) is viable. No extra hardware needed beyond the phone. | Temperature trend, eating events (1-min ROC), sleep/wake heuristic, unlogged spike flags. |
| **A2: Phone sees `raw=0` / RF-error artifact** | `glucose_raw=0`, `temperature_raw` = small code (32, 64...), parser flags `corrupted=true` | **PIVOT**. The sensor was already paired (LibreLink on owner's phone). The key is held by LibreLink and is not obtainable by any other device; a different reader *cannot* become key-holder on an active sensor. | Only cloud-path features (F1–F4 from feasibility matrix). Raw features (F5+) remain blocked. |
| **B1: ACR122U reads raw FRAM (first scan on fresh sensor)** | Same as A1 but via USB reader | **GO for Path B (dedicated reader)**. ACR122U or Pi+PN532 can be the key-holder if deployed *before* LibreLink scans. Requires owner to let the reader scan first on each new sensor. | Same as A1. |
| **B2: ACR122U sees encrypted payload / `raw=0` artifact** | Ciphertext bytes or NFC artifact | **NO-GO for Path B on this sensor**. Key already held by phone. The only way to make a reader the key-holder is to apply a **fresh sensor** and have the reader scan it *before* the phone. | If owner accepts "reader scans first" workflow → GO for future sensors. Otherwise NO-GO. |
| **C1: Pi+PN532 reads raw FRAM continuously** | Daemon stays paired, dumps FRAM every N minutes | **GO for Path B (always-on daemon)**. Best for unattended collar/bridge. | Same as A1 + continuous 1-min resolution without manual taps. |
| **C2: Pi+PN532 fails (key held by phone)** | Same as B2 | **NO-GO** unless fresh sensor + reader-first workflow. | Same as B2. |
| **A2-iOS: iPhone (LibreLink) already holds key — current sensor** | Raw FRAM unreachable; every other reader sees artifact | **PIVOT (certain, no spike needed)**. The first scan already happened; the key lives with the iPhone. No iOS raw-reader app exists. | Cloud-path features only (F1–F4). Raw features blocked until next sensor. |
| **D1: ESP32+PN532 first-scans a *fresh* sensor** | Raw glucose > 0, raw temp valid, CRC OK | **GO for Path B (ESP32 bridge)**. Cheapest raw path for this owner; ESP32 becomes the key-holder and can dump FRAM each sensor change. | Temperature trend, eating flags, sleep/wake, unlogged-spike flags. |
| **D2: ESP32+PN532 tries the *current* sensor (iPhone holds key)** | `raw_glucose=0`, RF-error code in temp field | **NO-GO for current sensor**; confirms the crypto wall. Re-attempt on fresh sensor (D1). | Cloud-path features only. |

---

## 4. Decision Gate (Reference: `feasibility-matrix.md` Phase 3)

| Condition | Decision | Rationale |
|-----------|----------|-----------|
| **Any reader (A/B/C) obtains raw FRAM on a sensor where it scanned first** | **GO** → Proceed to Path B implementation (phone bridge or dedicated reader). Document the "reader-first" workflow for sensor changes. | Feasibility matrix Phase 3 is viable: `LibreRawParser` becomes the parsing library in the raw-data pipeline. |
| **All readers see `raw=0` / RF-error because owner's phone (LibreLink) already paired** | **PIVOT** → Accept cloud-only path. Ship F1–F4 now ($0). Revisit raw path only if owner agrees to "reader scans new sensor first" protocol. | Libre 2 crypto wall is real and operational. No software bypass. The feasibility matrix explicitly gates F5+ on a raw path that requires the pairing key. |
| **Reader gets ciphertext (not artifact) — encryption confirmed but key unknown** | **NO-GO** → Same as PIVOT. Crypto is holding; key extraction from phone secure element is not feasible. | Confirms the Stage 1 finding: "Libre 2 FRAM is AES-encrypted; shared key established at first NFC scan." |
| **Reader sees plaintext (Libre 1 behavior) on a Libre 2 sensor** | **GO** (unexpected) → Investigate firmware/region variance. May indicate a non-encrypted batch. | Would contradict research baseline; treat as anomaly, verify sensor type byte (patch info `0x10` = Libre 2). |

**Explicit rule**: If the spike produces **Outcome A2 or B2 on the owner's active sensor**, the decision is **PIVOT** — do not purchase hardware for Path B. The $0 cloud-path features (F1–F4) are the delivery target. Path B is only re-opened if the owner commits to the "reader-first on fresh sensor" workflow for *future* sensor changes.

**iOS-only owner (this case)**: the active sensor was already first-scanned by the owner's iPhone, so the decision is **PIVOT without running any spike** — the spike's question ("who holds the key?") is already answered. Do **not** buy an ACR122U or Pi now. The only hardware to consider is a **PN532 module (~$10–15)** to pair with the existing ESP32, and only to try the "reader-first" raw path on the *next* sensor change (Outcome D1). If that is not interesting, spend **$0** and ship F1–F4.

---

## 5. Cost Cap & $0 Alternative

| Path | Max Spend | What it buys |
|------|-----------|--------------|
| **Phone-only (Option A)** | **$0** | Uses an Android phone + xDrip+ + OOP2. Answers the critical question: *who holds the key right now?* **Requires Android** — not available to this owner today. |
| **ESP32 + PN532 (Option D)** | **~$15–20** | Uses the owner's existing ESP32; only buys the PN532 module. Raw-path probe on the *next* sensor (reader-first). Cheapest realistic option for this owner. |
| **ACR122U (Option B)** | **$50** | Independent verification; useful if phone NFC is unreliable or for a dedicated always-on reader later. **Not recommended for this owner now.** |
| **Pi + PN532 (Option C)** | **$50** | Prototype for collar/bridge daemon. Only buy if D1/B1 succeeds and always-on is desired. |

**Total cap**: **≤ $100** (buy at most one of B or C, not both). **For this owner: $0 decision is already made (PIVOT on current sensor); optional ~$15 PN532 if trying the reader-first raw path on the next sensor.** Only spend on B/C if a raw path is proven and always-on is desired.

---

## Appendix A: Claims Validation (2026-08-21, CC-DS lane)

Validation of the spike resolution's core claims against `freestyle-libre-raw-capabilities.md`
(research baseline, NID-396) and community sources. Addresses the owner's request to
review/validate the AI model claims behind the PIVOT decision.

| # | Claim | Verdict | Grounding / nuance |
|---|-------|---------|--------------------|
| C1 | Libre 2 FRAM is AES-encrypted | **CONFIRMED** | Baseline §6; xDrip+/AAPS Libre 2 docs; OOP2 helper decrypts sensor data. Community decrypts it, but only with the per-sensor key. |
| C2 | The private shared key is established at the **first NFC scan** | **CONFIRMED** | xDrip+ Libre 2 setup: the connection is made by NFC scan, not BLE pairing; the first scan activates the sensor and creates the private shared key. Only the device holding it can read the sensor. |
| C3 | A scan on a key-holder-paired sensor returns `raw_glucose=0` and temp field = RF-error code; last-good values come from the history buffer | **CONFIRMED** | Baseline §6; DiaBLE discussion #9. Operational consequence of the NFC antenna draw corrupting the live trend slot. |
| C4 | "The key lives in the iPhone's secure element and cannot be extracted" | **CONFIRMED-in-effect, IMPRECISE-in-mechanism** | The key is not stored in the Secure Enclave; it is a shared secret established between sensor and first-scanner and kept in the LibreLink app's keychain. The *effect* is correct: no iOS app can read raw FRAM (no xDrip+/DiaBLE on iOS; LibreLink exposes calibrated values only), and no other device can obtain the key from an active sensor. |
| C5 | A reader that first-scans a fresh sensor can decrypt raw FRAM (ACR122U / Pi+PN532 / ESP32+PN532) | **PLAUSIBLE, empirically testable** | Community reader-first workflow (xDrip+ on Android, Libre-2 NFC sketches for ESP32). This is exactly what the spike's Option D tests; not guaranteed on every firmware/region, hence the spike. |
| C6 | No software-only bypass exists | **CONFIRMED** | Decryption requires the key; the key is only issued to the first scanner. No code-only way to recover it from an active, already-paired sensor. |

**Bottom line**: every claim that drives the PIVOT decision for the *current* sensor is confirmed.
The only claim that needed tightening is C4's mechanism (secure-element wording), which does not
change the decision. The remaining uncertainty (C5) is what the $15 ESP32+PN532 "reader-first"
experiment on the *next* sensor is designed to resolve.

---

## Appendix B: How to Run the Parser on a Real FRAM Dump

```bash
# If you have a 344-byte hex dump from xDrip+ export or nfcpy:
python3 libre_raw_parser.py --fram "00112233...(688 hex chars)" --start "2026-08-06T00:00:00Z"

# If you have a raw binary file:
python3 libre_raw_parser.py --fram /path/to/fram.bin --start "2026-08-06T00:00:00Z"

# Key output fields to check:
# - validation.header_crc16_ok (must be true)
# - validation.records_corrupted (should be 0 for history; trend slot 0 may be 1 during scan)
# - metrics.temperature_celsius (should be 35–39 for cat ISF)
# - metrics.flags.eating_event / sleep / unlogged_spike (heuristics, not measurements)
# - sensor.factory_calibration_params (i1..i6 — per-sensor constants)
```

---

## One-Paragraph Recommendation

**For this owner (iPhone 13 mini only, LibreLink already paired to the active sensor): the decision is already PIVOT — no hardware purchase, no spike needed on the current sensor.** The private shared key was established at the iPhone's first NFC scan; iOS has no raw-FRAM reader (xDrip+/DiaBLE are Android-only), so the key-holder fact makes the raw path unreachable until the sensor is replaced. **Ship F1–F4 now (rate-of-change badge, time-in-range, sensor-life countdown, logbook events) at $0 from existing LibreLinkUp cloud data.** If raw features (temperature trend, eating/sleep/stress inference) matter, the only cheap shot is the **"reader-first" workflow on the next sensor**: buy a **PN532 module (~$10–15)**, wire it to the existing ESP32, and have the ESP32 scan the fresh sensor *before* the iPhone does — Outcome D1 in §3. That is a $15 experiment, well under the $100 cap, and it directly tests the crypto-wall hypothesis. Otherwise stay at $0. Decision gate is binary and already answered for the current sensor: **key-holder wins, no exceptions**.