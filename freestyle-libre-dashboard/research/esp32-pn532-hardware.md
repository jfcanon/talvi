# ESP32 + PN532 Hardware Guide — Stage 3a (Plan Only)

**Issue:** NID-399 — Stage 3a: ESP32 + PN532 NFC reader for Libre 2 raw data  
**Owner hardware:** Waveshare ESP32-S3-Touch-AMOLED-1.8 (on hand) + PN532 module (~$10–15, to buy)  
**Cost cap:** ≤ $20 total (ESP32 already owned)  
**Status:** Plan only — ESP32 inspected 2026-08-21, not flashed

---

## 1. What we verified on the bench (no flash, read-only)

Probe run on `/dev/cu.usbmodem101` (USB-Serial/JTAG) with `esptool v5.3.1`.

| Property | Value | How verified |
|---|---|---|
| **Chip** | ESP32-S3 (QFN56) revision **v0.2** | `esptool chip-id` |
| **Cores / freq** | Dual-core + LP core, **240 MHz** | chip-id |
| **RAM** | 512 KB SRAM + **8 MB PSRAM (AP_3v3)** | chip-id |
| **Flash** | **16 MB**, quad, 3.3 V, manuf `0x20` dev `0x4018` | `esptool flash-id` |
| **MAC** | `28:84:85:55:58:3c` | chip-id |
| **Crystal** | 40 MHz | chip-id |
| **USB mode** | USB-Serial/JTAG | chip-id |
| **Security** | Secure Boot **disabled**, Flash Encryption **disabled**, `SPI_BOOT_CRYPT_CNT=0` | `get-security-info` |
| **Partition table** (at `0x8000`) | `nvsfactory 0x009000/200KB`, `nvs 0x03b000/840KB`, `otadata 0x10d000/8KB`, `phy_init 0x10f000/4KB`, `factory 0x110000/5632KB`, `ota_0 0x690000/3072KB`, `assets 0x990000/3072KB`, `storage 0xc90000/3520KB` | `read-flash 0x8000` + parser |
| **Factory app** (at `0x110000`) | **ESP-Brookesia phone demo** — `Project: esp-brookesia`, `ESP-IDF v5.5.4-dirty`, compile `May 26 2026 17:23:10` / `May 27 2026 09:39:19` strings | `read-flash 0x110000` + `strings` |
| **Display** | 1.8" AMOLED 368×448, driver SH8601 (QSPI), touch FT3168 (I2C), verified via `strings` (`ESP32-S3-Touch-AMOLED-1.8`, `lvgl`, `Brookesia`) | flash strings |
| **Peripherals on board** | QMI8658 IMU, PCF85063 RTC, AXP2101 PMU, ES8311 codec, TCA9554 IO-expander, SD slot, mic/speaker | waveshare wiki + `strings` (bsp calls) |
| **Storage partition** (`0xc90000`) | Contains demo assets (`/music/BGM 1.mp3`, `Levitate by Ryefield`) | `read-flash 0xc90000` |

**Integrity verdict:** healthy dev board, factory Brookesia LVGL demo intact, large free OTA/assets/storage regions, no secure-boot/encryption lock — flashable without eFuse work. **Back up `factory` (5.6 MB) before overwriting** if the demo is worth keeping (`esptool read-flash 0x110000 0x580000 factory_backup.bin`). No writes were made during this check (plan-only gate).

---

## 2. Board spec — Waveshare ESP32-S3-Touch-AMOLED-1.8

Source: [Waveshare Wiki](https://www.waveshare.com/wiki/ESP32-S3-Touch-AMOLED-1.8) + live flash dump.

- **Mcu:** ESP32-S3R8 (Xtensa LX7 dual-core 240 MHz, Wi-Fi 802.11 b/g/n, BLE 5, 512 KB SRAM, 384 KB ROM, 8 MB PSRAM)
- **Flash:** 16 MB NOR (verified; wiki lists "16 MB")
- **Display:** 1.8" AMOLED 368×448, 16.7M colors, SH8601 via QSPI, FT3168 touch via I2C
- **Power:** AXP2101 PMU, MX1.25 2P LiPo header (3.7 V), charge management, backup battery pad for RTC
- **Sensors:** QMI8658 6-axis IMU, PCF85063 RTC
- **Audio:** ES8311 codec + mic + speaker
- **Storage:** TF slot (SDMMC: CS=EXIO7, MOSI=GPIO1, MISO=GPIO3, SCK=GPIO2 via expander)
- **Buttons:** BOOT + PWR (side, customizable)
- **Exposed pads:** 7× GPIO, 1× I2C, 1× UART, 1× USB (1.0 mm pitch) — labels on bottom silkscreen; exact GPIO numbers vary by rev. **You must photograph your board's pad labels** before wiring.
- **Dev stacks:** Arduino (≥ esp32 3.0.6, GFX 1.4.9, lvgl 8.4.0, XPowersLib 0.2.6, SensorLib 0.2.1) or ESP-IDF (VS Code + Espressif plugin, IDF ≥ 5.1)

**Implication for PN532:** internal I2C bus is occupied (FT3168 @ ~0x38, PCF85063 @ 0x51, QMI8658 @ 0x6A/0x6B, TCA9554 expander @ 0x20). The PN532 default I2C address is `0x24` → **no conflict**, but you should run an I²C scan to confirm before locking the address (some PN532 boards use `0x48` in SPI-remap). The AMOLED QSPI pins are **not** reusable for NFC.

---

## 3. PN532 module

Buy: **PN532 NFC RFID module V3** (HiLetgo / Elechouse / Waveshare), ~$10–15, 3.3 V I²C/SPI/HSU jumper. Comes with antenna PCB (~40×40 mm) and 4-pin header.

| Bus | Pros | Cons | Pins on PN532 | Typical wiring |
|---|---|---|---|---|
| **I²C** (recommended for this board) | 2 wires, 3.3 V-native, no level shifter, works alongside display | 400 kHz max, address scan needed, shared bus noise | SDA, SCL, VCC 3.3 V, GND, IRQ, RSTO optional | Board I2C SDA/SCL + 3.3 V + GND |
| **SPI** | Faster (≈ 5 Mbps), dedicated CS, less bus contention | 4–5 wires, consumes more of the 7 free GPIOs | SCK, MISO, MOSI, SS, VCC, GND, IRQ | Any 4 free GPIOs + 3.3 V |
| **HSU (UART)** | Simple serial | Occupies the one UART pad, conflicts with debug | TX, RX | Not recommended — debug UART needed |

**Power:** PN532 draws ~80–150 mA burst during RF polling, ~30 mA idle. AXP2101 3.3 V rail can source it, but add a **100 µF decoupling cap** at the module and power it from `3V3`, **not** VBAT. Do not use 5 V — ESP32 GPIOs are 3.3 V.

**Antenna:** keep PN532 antenna parallel to sensor face, < 15 mm gap; the board's metal shielding matters — **point the PN532 antenna face-out**, not sandwiched against the ESP32 PCB. For a cat collar mockup this board is **too large** (≈ 60×36 mm) — final wearable is a smaller ESP32-C3/S3-Mini + PN532 breakout with flex cable; this dev board is for bench validation.

---

## 4. Wiring — this board + PN532 (I²C plan)

> Do not solder until PN532 arrives and pad labels are confirmed by photo. This is a plan, not a build.

### Option A — I²C on the exposed pad (preferred, 4 wires + 2 optional)

| PN532 pin | Board pad | Notes |
|---|---|---|
| `VCC` | `3V3` | 3.3 V only |
| `GND` | `GND` | common ground |
| `SDA` | exposed `SDA` (or GPIO 8/10 depending on rev) | I2C data |
| `SCL` | exposed `SCL` (or GPIO 9/11) | I2C clock |
| `IRQ` | any free GPIO (e.g. pad GPIO 4) | optional, poll IRQ instead of blocking |
| `RSTO` | any free GPIO or `3V3` via 10 kΩ |_optional — tie high if unused_|
| Jumpers | set `SEL0=L, SEL1=H` for I2C (see PN532 silkscreen) | many boards: dip switch `1=ON 2=ON` = I2C |

Run `i2c_scan` sketch after wiring: expect to see devices at `0x20` (expander), `0x38` (FT3168), `0x51` (RTC), `0x6A` (IMU), **`0x24` (PN532)**. If `0x24` missing, check VCC and jumper.

### Option B — SPI (if I²C bus is noisy/noisy touch)

| PN532 pin | Board GPIO | Notes |
|---|---|---|
| `VCC`/`GND` | `3V3`/`GND` | |
| `SCK` | GPIO 2 | free pad |
| `MISO` | GPIO 3 | free pad |
| `MOSI` | GPIO 1 | free pad (note: also SD MOSI — time-share or avoid SD during NFC) |
| `SS` | GPIO 4 | free pad |
| Jumpers | `SEL0=H, SEL1=L` for SPI | |

SPI avoids I²C contention but costs 4 GPIOs and collides with the SD slot if SD is active. Prefer I²C.

**After arrival:** solder, then run the `i2c_scan` Arduino sketch (Wire @ 100 kHz) to confirm `0x24` before flashing Libre-2 code.

---

## 5. Why reader-first matters (Libre 2 crypto recap)

From `libre2-nfc-validation-spike.md` §1 + Appendix A (all claims confirmed 2026-08-21):

- Libre 2 FRAM is **AES-encrypted**; the private shared key is issued at the **first NFC scan** that activates the sensor. Whoever scans first holds the key.
- Every other reader sees `raw_glucose=0` + RF-error code in the temp field (`32` = `RF_ERROR`) or ciphertext. There is **no software bypass**.
- The owner's iPhone (LibreLink) already scanned the **current** sensor → key is with the phone → **PIVOT on this sensor** (F1–F4 cloud features only, $0). Raw path reopens only on a **fresh sensor** where the **ESP32+PN532 scans first**, before the iPhone.
- The one-minute trend slot at scan time can show `corrupted=true`; history is clean. Parser flags this, never emits garbage.

**Owner protocol for next sensor change (~14 d lifetime):**

1. Old sensor out, new sensor on (cat or test site).
2. **Within minutes, before LibreLink:** tap **ESP32+PN532** to the new sensor (hold 2–3 s, antenna face-out, < 15 mm). Display shows "Pairing…" → "Key OK" or "RF_ERROR".
3. Only then scan with iPhone LibreLink (so both hold readings; ESP32 holds the decrypt key).
4. Every ~14 d, repeat — key is per-sensor.

---

## 6. Cost

| Item | Price | Notes |
|---|---|---|
| ESP32-S3-Touch-AMOLED-1.8 | **$0** (on hand) | no purchase |
| PN532 NFC module V3 (with antenna) | **$10–15** | Amazon/Ali, one unit |
| Jumpers / decoupling cap / tape | **$1–2** | |
| **Total Stage 3a (hardware)** | **~$12–17** | well under $20 cap; remaining $3–8 is contingency |

No ACR122U, no Pi — separate future work if this path validates.

---

## 7. Plan-only guardrail (do not flash yet)

At owner's explicit request (2026-08-21 update): **no writes to the plugged ESP32 this run**.

- [x] Read-only integrity checks done (chip-id, flash-id, partition dump, strings) — §1.
- [ ] PN532 purchase + wiring photo — next run, with module in hand.
- [ ] Firmware flash — after wiring verified (`i2c_scan` → `0x24` seen).
- [ ] Fresh-sensor paired scan — only when next sensor change window arrives.

**Before flashing**, back up the factory Brookesia demo (optional but reversible):
```sh
esptool --port /dev/cu.usbmodem101 read-flash 0x110000 0x580000 factory_backup.bin
esptool --port /dev/cu.usbmodem101 read-flash 0x000000 0x100000 boot_and_parts.bin
```

---

## 8. References

- Validation spike: `research/libre2-nfc-validation-spike.md` (Option D, Appendix A)
- Capabilities: `research/freestyle-libre-raw-capabilities.md`
- Feasibility: `research/feasibility-matrix.md` Phase 3
- Parser: `research/libre_raw_parser.py` + `research/parser_output_schema.json`
- Waveshare wiki: https://www.waveshare.com/wiki/ESP32-S3-Touch-AMOLED-1.8
- PN532 datasheet: NXP PN532/C1, I²C addr `0x24` (7-bit `0x48` with R/W bit)
