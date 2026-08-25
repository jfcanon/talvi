# PN5180 + ESP32-S3 — Libre 2 ISO 15693 custom commands (patchInfo, enable streaming)

**Issue**: NID-420 — investigate whether a **PN5180** driven by the ESP32-S3 can
execute the Libre 2 NFC sequence (inventory → `0xA1` patchInfo → `0xA1 0x1E`
enable-streaming → optional FRAM read), which library + patch, which wiring.
**Parent**: NID-419 (converges all lanes).
**Verdict (CC-DS, 2026-08-25)**: **Yes.** Chip-capability confidence **~85% →
`02 A1 07` reply on the bench closes it**; "works first try" ~55-60% until that
reply lands (sub-90%, so a Stage-2 GO waits on the bench test).
**Code**: `firmware/pn5180_bench/` — a ready-to-build PlatformIO bench that
prints UID + raw `02 A1 07` reply + patchInfo + generation. Build verified
2026-08-25 (RAM 5.9 %, flash 4.2 %); **not flashed** (NID-420 was investigation-only).

This supersedes the PN532 path for *this* reader question: the PN532 has no
ISO 15693 support, so it was ruled out in
[libre2-nfc-validation-spike.md](libre2-nfc-validation-spike.md). The PN5180 is
an ISO 15693-native reader, so it is the candidate for the direct-sensor path.

---

## 1. The wire sequence (what a Libre 2 actually receives)

Every ISO 15693-3 custom command is `Flags | CmdCode | IC-Mfg-code | params`,
with the CRC appended by the PN5180. The Mfg code is UID byte 6 — `0x07` =
Texas Instruments (RF430FRL152H) — for a Libre.

| Step | Frame sent (hex) | Reply | Source |
|---|---|---|---|
| Inventory | `26 01 00` | `00 DSFID UID[8]` (UID LSB-first, `…A4 07 E0`) | ATrappmann `PN5180ISO15693.cpp` `uint8_t inventory[] = { 0x26, 0x01, 0x00 };` |
| (optional) Get system info | `02 2B` | infoFlags + UID… | DiaBLE `NFC.swift:273` `tag.systemInfo(requestFlags: .highDataRate)` |
| **patchInfo** | `02 A1 07` | `00` + **24 bytes** (strip flags byte) | xDrip `NFCReaderX.java:641-652`: `manufacturerCode = patchUid[6]; cmd = {0x02, 0xa1, manufacturerCode}; patchInfo = nfcvTag.transceive(cmd)` |
| **Enable streaming** | `02 A1 07 1E u0 u1 u2 u3 k0 k1 k2 k3` | `00` + 6-byte BLE MAC (reversed) | xDrip `NFCReaderX.java:536-541` (`res.length == 7`, reverse bytes 1..6 at `:557-563`); DiaBLE `Libre2.swift:190-210` |
| FRAM read (optional) | `02 23 <blk> <n-1>` | `00` + `8*n` bytes | xDrip `NFCReaderX.java:713-716` `cmd = {0x02, 0x23, i, read_blocks-1}`; Libre 2 FRAM is encrypted (needs pairing key) |

The 8 parameter bytes of `A1 1E` are built as (DiaBLE `NFC.swift:110-121`,
`Libre2.swift:190-198`):

- `secret = UInt16(patchInfo[4...5]) ^ UInt16(unlock[1], unlock[0])` — i.e.
  `LE16(patchInfo[4..5]) ^ (unlockCode & 0xFFFF)`.
- `k = usefulFunction(uid, code=0x1E, secret)` — the 4-byte crypto output
  (`Libre2.swift:64-127`, keys `A0C5 6860 0000 14C6`, `secret 0x1b6a`; the same
  key material must later be fed to `streamingUnlockPayload` on BLE login,
  `Libre2.swift:248-261`).
- Unlock code is **arbitrary** (`streamingUnlockCode could be any 32 bit
  value`); DiaBLE and xDrip both default to **42** (xDrip
  `NFCReaderX.java:525`).

**Flags**: all three code bases use `0x02` = high-data-rate only — **not
addressed, not selected**. Nobody sends `Select 0x25`. CoreNFC's
`.highDataRate` is the same `0x02`; CoreNFC inserts the `0x07` Mfg byte itself
(inference from DiaBLE passing only `code + params` while Android must add it).

### Why playfultechnology/PN5180 issue #2 timed out (inference, strong)

The author sent `iso15693Send(flags=0x12, cmd=0xA1, uid=nullptr, params=nullptr)`
— three bytes `12 A1` with **no `07` Mfg byte**. A TI RF430 silently ignores a
malformed custom command (no error frame → "timeout"). Secondary defect in that
fork: `PN5180.cpp:getInventory()` ends with `disableRF()`, so any later command
runs with the RF field down unless re-armed. Neither is a PN5180 limitation:
`captainbeeheart/pypn5180 iso_iec_15693.py customCommand()` frames
`[flags, cmdCode, mfCode, data…]` with `self.flags = 0x02` and drove A0/A1/A5 on
a Libre through the same chip.

## 2. Library + the concrete patch

**Use `ATrappmann/PN5180-Library`** (Arduino; matches the existing PlatformIO /
Arduino-core-2.x stack in `esp32_leoncito`). Four fixes are required — all
implemented in `firmware/pn5180_bench/src/LibrePN5180.h/.cpp`:

1. **Bounded wait** — stock `PN5180ISO15693::issueISO15693Command` spins
   `while (0 == (status & RX_IRQ_STAT))` forever on a silent tag. The wrapper
   rebuilds transceive from the public primitives (`sendData / getIRQStatus /
   readData(len, buf) / clearIRQStatus / readRegister`) with a **100 ms
   `millis()` timeout** → `LIBRE_NO_CARD` / `LIBRE_TIMEOUT`.
   (`issueISO15693Command` is `private` in `PN5180ISO15693.h:44-45`, so the
   wrapper cannot call it; the library's `sendData()` re-arms Idle→Transceive
   internally, `PN5180.cpp:315-318`.)
2. **Caller-owned reply buffer** — stock `readData()` reuses a static buffer;
   the wrapper fills a caller buffer and never overruns it (`replyCap`).
3. **Explicit `SPI.begin(SCK, MISO, MOSI, NSS)`** on ESP32-S3 before
   `nfc.begin()` — stock calls `SPI.begin()` with no pins and the core's
   `SPI.begin()` is a no-op once the bus is up, so the header pins would never
   be wired without this.
4. **Tap-to-pair** — `waitForTag()` polls `getInventory()` every 50 ms so the
   owner can tap the sensor when ready instead of holding it at power-on.

`beginLibre()` also does a firmware-version sanity read (all-`0xFF` = nothing
on the bus → wiring/5 V problem) and calls `setupRF()` once so the RF field
stays on across commands.

## 3. Wiring (ESP32-S3-Touch-AMOLED-1.8, free header GPIO)

| Signal | GPIO |
|---|---|
| SCK  | 36 |
| MISO | 37 |
| MOSI | 35 |
| NSS  | 34 |
| BUSY | 38 |
| RST  | 33 |

Power: PN5180 needs **5 V for the RF front-end** and **3.3 V for logic**
(common ground). Keep the antenna within ~2 cm of the sensor (fur!), and watch
5 V rail sag on battery.

## 4. Bench usage

```bash
PIO=~/.leoncito-pio-venv/bin/pio        # PlatformIO venv used by esp32_leoncito
cd freestyle-libre-dashboard/firmware/pn5180_bench
$PIO run -t upload                      # port /dev/cu.usbmodem101 (USB-Serial-JTAG)
screen /dev/cu.usbmodem101 115200       # console: UID + patchInfo; `s` = enable streaming
```

Expected on a Libre 2 EU (from the bench sketch):

```
[pn5180] firmware 4.0            <- bus OK; "255.255" = wiring/5 V problem
[bench] UID (LSB first): xx xx xx xx 00 A4 07 E0
[bench] IC mfg byte = 0x07 (expect 07 = TI)
[bench] 02 A1 07 -> rc=0 len=25
[bench] raw reply: 00 9D 08 30 01 ...
[bench] patchInfo: 9D 08 30 01 ...
[bench] generation: Libre 2 EU (Gen1 — streaming crypto reversed)
```

Decision table for the raw line:

- `rc=0 len=25` → chip-capability question closed (NID-420 ✔); bytes 1–2 of the
  reply answer NID-421's gate (`9D 08` = Libre 2 EU Gen1 / `C5 09`, `C6 09` =
  Libre 2 Plus / `A2 xx` = Gen2).
- `rc=-1` (no SOF) → tag silent: antenna distance, RF field, or wrong Mfg byte —
  check the printed `uid[6]`.
- `rc=-2` (SOF, no EOF) → RF-config / CRC problem; try `loadRFConfig(0x0d,0x8d)`
  re-run and a shorter cable.
- `rc=-3` → ISO error frame; `reply[1]` = code (`01` unsupported, `02` format,
  `0F` unknown).
- `len=28+` with `A5 00 …` → Gen2/Libre-3-style reply; the wrapper already
  extracts the trailing 24 bytes.

`enableStreaming` (`s` on the console, unlock code 42) is opt-in on purpose —
it evicts the phone's BLE stream on a live sensor (ping-pong).

## 5. Crypto

`libre2UsefulFunction()` in `firmware/pn5180_bench/src/LibrePN5180.cpp` is a
1:1 port of DiaBLE `Libre2.swift:64-127`
(`prepareVariables` / `processCrypto` / `usefulFunction`); byte order confirmed
against DiaBLE `Extensions.swift:56-67`. **Not yet validated against a known
test vector** — DiaBLE ships none; the first real `A1 1E` reply (7 bytes,
`00` + MAC) is the validation.

## 6. Open risks / open items

- **No live-sensor validation yet** — build-only. The `A1 1E` reply must be
  checked against a real sensor before this is trusted.
- **Gen2 / Libre 3** answer `A5 00` + longer payloads; the reply-offset handling
  (`reply + n - 26`) is a best-effort inference, untested.
- **NVS persistence** belongs in the real firmware (unlock code + patchInfo +
  unlock count so a reboot doesn't force a re-tap) — out of scope for the bench.
- **`.pio/` build artifacts were committed** on the PR #215 branch
  (`esp32_leoncito`); `.gitignore` now excludes `.pio/` under
  `freestyle-libre-dashboard/` — the leftover dir on that branch should be
  removed before merge.
- **Not flashed** — the NID-420 brief was investigation-only.

## 7. Related docs

- `research/libre2-nfc-validation-spike.md` — NID-398 spike; ruled out PN532,
  established the "key-holder wins" constraint that shapes the sensor-activation
  plan.
- `research/feasibility-matrix.md` — feature feasibility for raw sensor data.
- `firmware/esp32_leoncito/docs/HANDOVER.md` — the 24/7 LLU→worker fetcher the
  direct-sensor path will eventually replace/supplement.
- `firmware/pn5180_bench/README.md` — build/flash/console quick-start for the bench.
