# Libre-2 NFC Validation Spike Protocol

**Issue**: NID-398 — Stage 2 validation before committing to Path B hardware investment
**Status**: Ready for execution by sensor owner
**Cost cap**: ≤ $100 total; $0 alternative exists (phone-only)

---

## 1. Hardware Shortlist

| Option | Hardware | Approx. Cost | How it obtains the pairing key | Libre-2 encryption bypass? |
|--------|----------|--------------|--------------------------------|----------------------------|
| **A. Android phone (owner's)** | Existing phone with NFC + **NFC Tools** (free) or **xDrip+** (free, F-Droid/Play) | **$0** | Must scan **first** on a fresh sensor. If LibreLink already scanned it, the key is held by the phone running LibreLink — this reader gets encrypted payload only. | **No bypass.** Reads whatever the key-holder allows. If owner's phone holds key → xDrip+ on same phone *can* read (same secure element). If a different phone scans first → this reader sees ciphertext / `raw=0` artifact. |
| **B. ACR122U USB NFC reader** | ACS ACR122U-A9 (USB-A) or ACR122U-A10 (USB-C) | **$35–50** (Amazon/eBay) | Must be the **first device to scan** a fresh sensor. Uses `libnfc` / `nfcpy` to perform the ISO-DEP handshake and derive the session key. Once paired, subsequent reads by *same reader* decrypt FRAM. | **Partial.** Can decrypt *if it holds the key*. Cannot steal key from another device. If owner's phone paired first → ACR122U sees encrypted FRAM / `raw=0` artifact. |
| **C. Raspberry Pi + PN532 HAT** | Pi Zero 2 W (~$15) + PN532 NFC HAT (~$12–18) + case/SD | **$35–50** | Same as B — must scan first. Runs Python daemon (`nfcpy` or `pyscard`) to pair and dump FRAM continuously. | **Same as B.** Key-holder wins. No cryptanalytic break. |

**Critical constraint**: The Libre 2 pairing key is established at **first NFC scan** (ISO-DEP mutual auth). Whoever scans first — LibreLink app, xDrip+, ACR122U, PN532 — holds the key. All other readers see either AES ciphertext or the NFC artifact (`raw_glucose=0`, temperature field = RF error code). There is **no known software-only bypass** for Libre 2.

---

## 2. Step-by-Step Procedure

### Pre-conditions
- Active Libre 2 sensor on the cat (or human for test), **not yet scanned by any NFC device today** (fresh sensor or >1 h since last scan to avoid cached key issues).
- One of the three hardware options above available.
- `libre_raw_parser.py` cloned and runnable (`python3 libre_raw_parser.py --self-test` works).

### Option A: $0 Phone-only validation (recommended first)

1. **Install xDrip+** on an Android phone with NFC (F-Droid or Play Store).
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
| **A2: Phone sees `raw=0` / RF-error artifact** | `glucose_raw=0`, `temperature_raw` = small code (32, 64...), parser flags `corrupted=true` | **PIVOT**. The sensor was already paired (LibreLink on owner's phone). The key is in the phone's secure element — not extractable. A different reader *cannot* become key-holder on an active sensor. | Only cloud-path features (F1–F4 from feasibility matrix). Raw features (F5+) remain blocked. |
| **B1: ACR122U reads raw FRAM (first scan on fresh sensor)** | Same as A1 but via USB reader | **GO for Path B (dedicated reader)**. ACR122U or Pi+PN532 can be the key-holder if deployed *before* LibreLink scans. Requires owner to let the reader scan first on each new sensor. | Same as A1. |
| **B2: ACR122U sees encrypted payload / `raw=0` artifact** | Ciphertext bytes or NFC artifact | **NO-GO for Path B on this sensor**. Key already held by phone. The only way to make a reader the key-holder is to apply a **fresh sensor** and have the reader scan it *before* the phone. | If owner accepts "reader scans first" workflow → GO for future sensors. Otherwise NO-GO. |
| **C1: Pi+PN532 reads raw FRAM continuously** | Daemon stays paired, dumps FRAM every N minutes | **GO for Path B (always-on daemon)**. Best for unattended collar/bridge. | Same as A1 + continuous 1-min resolution without manual taps. |
| **C2: Pi+PN532 fails (key held by phone)** | Same as B2 | **NO-GO** unless fresh sensor + reader-first workflow. | Same as B2. |

---

## 4. Decision Gate (Reference: `feasibility-matrix.md` Phase 3)

| Condition | Decision | Rationale |
|-----------|----------|-----------|
| **Any reader (A/B/C) obtains raw FRAM on a sensor where it scanned first** | **GO** → Proceed to Path B implementation (phone bridge or dedicated reader). Document the "reader-first" workflow for sensor changes. | Feasibility matrix Phase 3 is viable: `LibreRawParser` becomes the parsing library in the raw-data pipeline. |
| **All readers see `raw=0` / RF-error because owner's phone (LibreLink) already paired** | **PIVOT** → Accept cloud-only path. Ship F1–F4 now ($0). Revisit raw path only if owner agrees to "reader scans new sensor first" protocol. | Libre 2 crypto wall is real and operational. No software bypass. The feasibility matrix explicitly gates F5+ on a raw path that requires the pairing key. |
| **Reader gets ciphertext (not artifact) — encryption confirmed but key unknown** | **NO-GO** → Same as PIVOT. Crypto is holding; key extraction from phone secure element is not feasible. | Confirms the Stage 1 finding: "Libre 2 FRAM is AES-encrypted; shared key established at first NFC scan." |
| **Reader sees plaintext (Libre 1 behavior) on a Libre 2 sensor** | **GO** (unexpected) → Investigate firmware/region variance. May indicate a non-encrypted batch. | Would contradict research baseline; treat as anomaly, verify sensor type byte (patch info `0x10` = Libre 2). |

**Explicit rule**: If the spike produces **Outcome A2 or B2 on the owner's active sensor**, the decision is **PIVOT** — do not purchase hardware for Path B. The $0 cloud-path features (F1–F4) are the delivery target. Path B is only re-opened if the owner commits to the "reader-first on fresh sensor" workflow for *future* sensor changes.

---

## 5. Cost Cap & $0 Alternative

| Path | Max Spend | What it buys |
|------|-----------|--------------|
| **Phone-only (Option A)** | **$0** | Uses owner's existing Android phone. Answers the critical question: *who holds the key right now?* |
| **ACR122U (Option B)** | **$50** | Independent verification; useful if phone NFC is unreliable or for a dedicated always-on reader later. |
| **Pi + PN532 (Option C)** | **$50** | Prototype for collar/bridge daemon. Only buy if B1/C1 succeeds and always-on is desired. |

**Total cap**: **$100** (buy at most one of B or C, not both). Start with A ($0). Only spend on B/C if A is inconclusive (e.g., phone NFC broken) and owner wants a second opinion before committing to the reader-first workflow.

---

## Appendix: How to Run the Parser on a Real FRAM Dump

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

**Start with the $0 phone-only spike (Option A) using xDrip+ on an Android phone.** If the owner's LibreLink app has already paired with the active sensor — which is the default for any Libre 2 user — xDrip+ will show the `raw=0 / RF-error` artifact, confirming the crypto wall is operational and the pairing key resides in the phone's secure element, unextractable by any other device. In that case, **pivot immediately to the $0 cloud-path features (F1–F4: rate-of-change badge, time-in-range, sensor-life countdown, logbook events)** and treat raw-data features (temperature, eating/sleep/stress inference) as blocked until the owner accepts a "reader scans fresh sensor first" protocol for the *next* sensor change. Only if the phone spike succeeds (raw FRAM readable) should you spend up to $50 on an ACR122U or Pi+PN532 to validate a dedicated reader/daemon path — but the decision gate is binary: **key-holder wins, no exceptions**.