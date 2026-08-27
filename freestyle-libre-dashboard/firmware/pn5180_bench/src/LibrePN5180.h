// LibrePN5180 — thin wrapper over ATrappmann/PN5180-Library for FreeStyle Libre 2
// ISO 15693 custom commands. Fixes vs. the stock library:
//   1. bounded wait (millis timeout) instead of the unbounded RX_IRQ_STAT spin
//   2. reply copied into a caller buffer (no static readData() buffer reuse)
//   3. explicit SPI.begin(SCK, MISO, MOSI, NSS) for ESP32-S3 before nfc.begin()
//   4. tap-to-pair helper that polls getInventory()
// Frame format (ISO 15693-3 custom command): FLAGS | CMD | IC-MFG(0x07) | params
// Sources: xDrip NFCReaderX.java:641-652 / :536-563, DiaBLE NFC.swift:110-121,
//          DiaBLE Libre2.swift:64-127 / :190-210.
#pragma once
#include <Arduino.h>
#include <PN5180ISO15693.h>

// ---- pin map: ESP32-S3-Touch-AMOLED-1.8 V2 free header GPIO ----
#define LIBRE_PIN_SCK  36
#define LIBRE_PIN_MISO 37
#define LIBRE_PIN_MOSI 35
#define LIBRE_PIN_NSS  34
#define LIBRE_PIN_BUSY 38
#define LIBRE_PIN_RST  33

#define LIBRE_RX_TIMEOUT_MS 100  // Libre answers within ~1 ms at 26 kbps
#define LIBRE_MAX_REPLY     64

enum LibreRc : int8_t {
  LIBRE_OK = 0,
  LIBRE_NO_CARD = -1,   // no SOF: tag silent (bad frame, out of range, field off)
  LIBRE_TIMEOUT = -2,   // SOF seen but no end-of-frame
  LIBRE_TAG_ERROR = -3, // ISO error flag set; err code in reply[1]
  LIBRE_TOO_LONG = -4,
};

class LibrePN5180 : public PN5180ISO15693 {
 public:
  LibrePN5180(uint8_t nss = LIBRE_PIN_NSS, uint8_t busy = LIBRE_PIN_BUSY,
              uint8_t rst = LIBRE_PIN_RST)
      : PN5180ISO15693(nss, busy, rst) {}

  // fix 3: bring up the S3 SPI2 bus on the header pins, then the chip + RF field
  bool beginLibre();

  // fix 4: poll inventory until a tag answers (or timeout). uid = 8 bytes LSB first.
  bool waitForTag(uint8_t uid[8], uint32_t timeoutMs);

  // Raw ISO 15693 frame in, reply out (reply[0] = response flags).
  // fixes 1 + 2 live here.
  LibreRc transceive(const uint8_t *frame, uint8_t frameLen, uint8_t *reply,
                     uint8_t *replyLen, uint8_t replyCap = LIBRE_MAX_REPLY);

  // 02 A1 <mfg>  -> 24-byte patchInfo (flags byte already stripped)
  LibreRc readPatchInfo(const uint8_t uid[8], uint8_t patchInfo[24]);

  // 02 A1 <mfg> 1E <unlock LE x4> <usefulFunction x4> -> 6-byte BLE MAC (reversed)
  LibreRc enableStreaming(const uint8_t uid[8], const uint8_t patchInfo[24],
                          uint32_t unlockCode, uint8_t macOut[6]);

  // 02 23 <block> <n-1> -> n*8 bytes (Libre 2 FRAM is encrypted; see DiaBLE decryptFRAM)
  LibreRc readBlocks(uint8_t firstBlock, uint8_t count, uint8_t *out);
};

// DiaBLE Libre2.usefulFunction(id, x, y) port — 4 bytes out
void libre2UsefulFunction(const uint8_t uid[8], uint16_t x, uint16_t y, uint8_t out[4]);
