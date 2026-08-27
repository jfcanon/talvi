# Bring-up Checklist (next run, after PN532 arrives)

Do not execute until the PN532 V3 module is in hand; this run was plan-only.

## 0. Before soldering

- [ ] Photo your board's bottom pad labels (7 GPIO + I2C + UART + USB).
- [ ] Confirm PN532 jumper is I2C: `SEL0=L SEL1=H` (or dip `1=ON 2=ON` — check your module's silkscreen).
- [ ] DMM: `3V3` rail vs `GND` with USB powered.

## 1. Solder

- [ ] 4-wire I2C: `PN532 VCC→3V3`, `GND→GND`, `SDA→pad SDA`, `SCL→pad SCL`. Add 100 µF cap at PN532.
- [ ] Optional `IRQ→GPIO4`, `RSTO→3V3 via 10k`.

## 2. Smoke test (no Libre code yet)

```sh
# i2c_scan Arduino sketch via platformio env esp32-s3-amoled-1_8-arduino
pio run -e esp32-s3-amoled-1_8-arduino --target upload && pio device monitor
# expect: 0x20 (expander) 0x38 (FT3168) 0x51 (RTC) 0x6A (QMI8658) 0x24 (PN532)
```

- [ ] `0x24` appears at 100 kHz. If missing: check VCC, jumper, SDA/SCL swapped.

## 3. PN532 RF test

- [ ] Flash Adafruit PN532 `readMifare` example; tap any NFC tag → UID prints.

## 4. Libre firmware

- [ ] Flash `firmware/esp32_pn532/src/main.cpp` (expanded with real `libre2_auth`) and observe AMOLED: `Ready — place sensor`.
- [ ] Verify BLE advertises `Leoncito-NFC`.

## 5. Fresh-sensor pairing (reader-first)

See `research/esp32-pn532-hardware.md` §5.

- [ ] New sensor on, **ESP32 first** tap (<15 mm, 2–3 s) → `Key OK / FRAM 344 B / crc_ok`.
- [ ] Only then iPhone LibreLink tap.
- [ ] Capture FRAM hex via BLE or serial, run:
  ```sh
  python3 research/libre_raw_parser.py --fram <688-hex> --start <ISO>
  # expect validation.header_crc16_ok == true
  ```

## 6. Worker

- [ ] `POST /raw-ingest` with captured FRAM → Worker validates, parses, merges into KV.

## Backup reminder

```sh
esptool --port /dev/cu.usbmodem101 read-flash 0x110000 0x580000 factory_backup.bin
```

