# PN5180 <-> Libre 2 bench — `firmware/pn5180_bench`

Validation bench for NID-420: can a **PN5180** (NXP, ISO 15693) module driven
by the owner's **Waveshare ESP32-S3-Touch-AMOLED-1.8** run the FreeStyle Libre 2
NFC sequence — inventory → `Select (0x25)` → custom `0xA1` patchInfo → `0xA1
0x1E` enable-streaming → optional FRAM read (`0x23`)?

Answer (CC-DS lane, 2026-08-25): **yes — and it builds clean.** The frames are
plain ISO 15693-3 custom commands; the Arduino `ATrappmann/PN5180-Library`
handles them once four bugs are fixed (all fixed here). Full evidence, wiring
table and confidence estimate: `research/pn5180-libre2-custom-commands.md`.

## What it does

Boots the PN5180 (SPI2 on the free header GPIO, RF field stays on), then in a
loop:

1. **Inventory** (`26 01 00`) → prints the 8-byte UID (LSB first) + IC-mfg byte
   (expect `0x07` = TI for a Libre).
2. **Raw `02 A1 <mfg>`** → prints the untouched reply (usually `00` + 24 B patchInfo).
3. **patchInfo** → prints the 24-byte generation info + a generation guess
   (Libre 2 EU `9D 08`, 2 Plus `C5/C6 09`, Libre US `E5 00`, Libre 1 `DF 00`…).
4. Typing `s` in the USB-CDC console also sends **enable-streaming** with
   unlock code `42` and prints the returned BLE MAC. **Warning:** that evicts
   the phone's BLE stream (ping-pong on a real sensor) — a bench-only action.

## Wiring (free header GPIO, board V2)

| Signal | GPIO |
|---|---|
| SCK  | 36 |
| MISO | 37 |
| MOSI | 35 |
| NSS  | 34 |
| BUSY | 38 |
| RST  | 33 |

Power: PN5180 needs **5 V** for the RF front-end **and** 3.3 V for logic; keep
the 5 V/3.3 V common-ground. See the research doc's wiring table for the exact
header pins.

## Build / flash (runtime Mac)

```bash
PIO=~/.leoncito-pio-venv/bin/pio        # PlatformIO venv used by esp32_leoncito
cd freestyle-libre-dashboard/firmware/pn5180_bench
$PIO run -t upload                      # port /dev/cu.usbmodem101 (USB-Serial-JTAG)
screen /dev/cu.usbmodem101 115200       # console: UID + patchInfo; `s` = stream
```

Same board block as `esp32_leoncito/platformio.ini`; only `lib_deps` differs
(the ATrappmann library, pinned by commit URL). Build verified 2026-08-25:
RAM 5.9%, flash 4.2%.

## Library fixes vs. stock `ATrappmann/PN5180-Library`

1. **Bounded wait** — stock `transceive` spins `while (0 == (status & RX_IRQ_STAT))`
   forever on a silent tag; here a 100 ms `millis()` timeout returns
   `LIBRE_NO_CARD`/`LIBRE_TIMEOUT`.
2. **Caller-owned reply buffer** — stock `readData()` reuses a static buffer;
   `LibrePN5180::transceive()` fills a caller buffer, never overruns it.
3. **Explicit `SPI.begin(SCK, MISO, MOSI, NSS)`** on ESP32-S3 before `nfc.begin()`
   (stock calls `SPI.begin()` with no pins; the core's `SPI.begin()` is a no-op
   once the bus is up, so the header pins were never wired).
4. **Tap-to-pair** — `waitForTag()` polls `getInventory()` so the owner can tap
   the sensor when ready instead of holding it at power-on.

## Crypto

`libre2UsefulFunction()` is a 1:1 port of DiaBLE `Libre2.swift` (`usefulFunction`
/ `prepareVariables` / `processCrypto`); the enable-streaming frame is built per
DiaBLE `Libre2.swift:190-198` and xDrip `NFCReaderX.java`. No test vector yet —
open item, see research doc.
