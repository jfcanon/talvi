/**
 * Leoncito ESP32 + PN532 — plan skeleton (Stage 3a)
 * Target: Waveshare ESP32-S3-Touch-AMOLED-1.8 + PN532 over I2C (0x24)
 *
 * PLAN ONLY: do not flash until PN532 is wired and i2c_scan shows 0x24.
 * This file is a compile-checked skeleton that demonstrates the intended
 * module boundaries; real Libre 2 ISO-DEP auth is TODO and will be ported
 * from the community sketches (freestyle-libre-esp / ESP32-LibrelinkUp).
 *
 * Build (after wiring):
 *   pio run -e esp32-s3-amoled-1_8-arduino --target upload
 *   pio device monitor
 */

#include <Arduino.h>
#include <Wire.h>

// Uncomment after PN532 arrives and wiring is verified:
// #include <Adafruit_PN532.h>
// #define PN532_IRQ   4
// #define PN532_RESET 5
// Adafruit_PN532 nfc(PN532_IRQ, PN532_RESET);

static const char *TAG = "leoncito";
static const uint8_t PN532_I2C_ADDR = 0x24; // 7-bit; 0x48 with R/W bit
static const int I2C_SDA = 8;  // CHECK your board pad label before soldering
static const int I2C_SCL = 9;  // CHECK — these are placeholders
static const uint32_t POLL_INTERVAL_MS = 120000; // 2 min, 60–300 s range

void i2c_scan() {
  Serial.println("I2C scan (expect 0x20 0x38 0x51 0x6A and 0x24 when PN532 wired):");
  for (uint8_t addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.printf("  0x%02X\n", addr);
    }
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n[leoncito] ESP32-S3-Touch-AMOLED-1.8 + PN532 — skeleton (plan only)");
  Serial.printf("Chip: ESP32-S3 rev 0.2, 16MB flash, PSRAM 8MB, MAC 28:84:85:55:58:3c\n");
  Serial.printf("PN532 I2C addr 0x%02X on SDA=%d SCL=%d, poll %lus\n",
                PN532_I2C_ADDR, I2C_SDA, I2C_SCL, POLL_INTERVAL_MS / 1000);

  Wire.begin(I2C_SDA, I2C_SCL, 100000);
  i2c_scan();

  // TODO after wiring:
  // nfc.begin();
  // uint32_t ver = nfc.getFirmwareVersion();
  // if (!ver) { Serial.println("PN532 not found — check wiring/jumpers"); return; }
  // nfc.SAMConfig();
  // ble_init("Leoncito-NFC", FRAM_GATT_SERVICE);
  // lvgl_init + show "Ready — place sensor (reader must scan fresh sensor FIRST)"

  Serial.println("[leoncito] skeleton ready — no Libre auth yet (see README §3).");
}

void loop() {
  // TODO poll loop (see README §3.4):
  // if (millis() - last_scan < POLL_INTERVAL_MS) { delay(100); return; }
  // if (nfc.inListPassiveTarget()) {
  //   uint8_t fram[344];
  //   bool ok = libre2_dump_fram(fram); // ISO-DEP mutual auth + ReadMultipleBlocks
  //   if (ok && crc16_ccitt(fram+2, 316) == (fram[0]|fram[1]<<8)) {
  //     nvs_store(fram); ble_notify(fram); ui_show_ok(fram);
  //   } else {
  //     ui_show_rf_error(fram);
  //   }
  // }
  delay(1000);
  Serial.printf("[leoncito] idle — poll in %lus (wire PN532 to enable)\n",
                POLL_INTERVAL_MS / 1000);
}
