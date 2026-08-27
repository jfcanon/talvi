#include "LibrePN5180.h"
#include <SPI.h>

// ---------------- Libre 2 crypto (DiaBLE Libre2.swift:64-127, verbatim port) ----------------
static const uint16_t LIBRE2_KEY[4] = {0xA0C5, 0x6860, 0x0000, 0x14C6};
static const uint16_t LIBRE2_SECRET = 0x1b6a;

static inline uint16_t be16(uint8_t high, uint8_t low) { return (uint16_t)low | ((uint16_t)high << 8); }

static void prepareVariables(const uint8_t id[8], uint16_t x, uint16_t y, uint16_t s[4]) {
  s[0] = (uint16_t)(be16(id[5], id[4]) + x + y);
  s[1] = (uint16_t)(be16(id[3], id[2]) + LIBRE2_KEY[2]);
  s[2] = (uint16_t)(be16(id[1], id[0]) + x * 2);
  s[3] = 0x241a ^ LIBRE2_KEY[3];
}

static uint16_t cryptoOp(uint16_t v) {
  uint16_t r = v >> 2;
  if (v & 1) r ^= LIBRE2_KEY[1];
  if (v & 2) r ^= LIBRE2_KEY[0];
  return r;
}

static void processCrypto(const uint16_t in[4], uint16_t out[4]) {
  uint16_t r0 = cryptoOp(in[0]) ^ in[3];
  uint16_t r1 = cryptoOp(r0) ^ in[2];
  uint16_t r2 = cryptoOp(r1) ^ in[1];
  uint16_t r3 = cryptoOp(r2) ^ in[0];
  uint16_t r4 = cryptoOp(r3);
  uint16_t r5 = cryptoOp(r4 ^ r0);
  uint16_t r6 = cryptoOp(r5 ^ r1);
  uint16_t r7 = cryptoOp(r6 ^ r2);
  out[0] = r3 ^ r7;  // f4
  out[1] = r2 ^ r6;  // f3
  out[2] = r1 ^ r5;  // f2
  out[3] = r0 ^ r4;  // f1
}

void libre2UsefulFunction(const uint8_t uid[8], uint16_t x, uint16_t y, uint8_t out[4]) {
  uint16_t s[4], k[4];
  prepareVariables(uid, x, y, s);
  processCrypto(s, k);
  uint16_t r1 = k[0] ^ 0x4163;
  uint16_t r2 = k[1] ^ 0x4344;
  out[0] = r1 & 0xFF; out[1] = r1 >> 8;
  out[2] = r2 & 0xFF; out[3] = r2 >> 8;
}

// ---------------- reader ----------------
bool LibrePN5180::beginLibre() {
  SPI.begin(LIBRE_PIN_SCK, LIBRE_PIN_MISO, LIBRE_PIN_MOSI, LIBRE_PIN_NSS);  // fix 3
  begin();   // library's SPI.begin() is a no-op once the bus is up (ESP32 core)
  reset();
  uint8_t ver[2] = {0, 0};
  readEEprom(FIRMWARE_VERSION, ver, 2);
  Serial.printf("[pn5180] firmware %d.%d\n", ver[1], ver[0]);
  if (ver[0] == 0xFF && ver[1] == 0xFF) return false;  // nothing on the bus
  return setupRF();                                     // RF on, stays on
}

bool LibrePN5180::waitForTag(uint8_t uid[8], uint32_t timeoutMs) {
  uint32_t t0 = millis();
  while (millis() - t0 < timeoutMs) {
    if (getInventory(uid) == ISO15693_EC_OK) return true;
    delay(50);
  }
  return false;
}

LibreRc LibrePN5180::transceive(const uint8_t *frame, uint8_t frameLen, uint8_t *reply,
                                uint8_t *replyLen, uint8_t replyCap) {
  *replyLen = 0;
  clearIRQStatus(RX_SOF_DET_IRQ_STAT | IDLE_IRQ_STAT | TX_IRQ_STAT | RX_IRQ_STAT);
  sendData((uint8_t *)frame, frameLen);  // re-arms Idle -> Transceive internally

  uint32_t t0 = millis();
  uint32_t st = 0;
  bool sof = false;
  while (millis() - t0 < LIBRE_RX_TIMEOUT_MS) {  // fix 1
    st = getIRQStatus();
    if (st & RX_SOF_DET_IRQ_STAT) sof = true;
    if (st & RX_IRQ_STAT) break;
    delay(1);
  }
  if (!(st & RX_IRQ_STAT)) {
    clearIRQStatus(RX_SOF_DET_IRQ_STAT | IDLE_IRQ_STAT | TX_IRQ_STAT | RX_IRQ_STAT);
    writeRegisterWithAndMask(SYSTEM_CONFIG, 0xfffffff8);  // back to Idle so next send is clean
    writeRegisterWithOrMask(SYSTEM_CONFIG, 0x00000003);   // Transceive
    return sof ? LIBRE_TIMEOUT : LIBRE_NO_CARD;
  }

  uint32_t rxStatus = 0;
  readRegister(RX_STATUS, &rxStatus);
  uint16_t len = rxStatus & 0x1ff;
  if (len > replyCap) len = replyCap;  // never overrun caller; flag it
  readData(len, reply);                // fix 2: caller-owned buffer
  clearIRQStatus(RX_SOF_DET_IRQ_STAT | IDLE_IRQ_STAT | TX_IRQ_STAT | RX_IRQ_STAT);
  *replyLen = (uint8_t)len;
  if ((rxStatus & 0x1ff) > replyCap) return LIBRE_TOO_LONG;
  if (len > 0 && (reply[0] & 0x01)) return LIBRE_TAG_ERROR;
  return LIBRE_OK;
}

LibreRc LibrePN5180::readPatchInfo(const uint8_t uid[8], uint8_t patchInfo[24]) {
  uint8_t frame[3] = {0x02, 0xA1, uid[6]};  // xDrip NFCReaderX.java:648
  uint8_t reply[LIBRE_MAX_REPLY], n = 0;
  LibreRc rc = transceive(frame, sizeof frame, reply, &n);
  if (rc != LIBRE_OK) return rc;
  // Libre 2: 00 + 24 bytes. Libre 3/Gen2 answer A5 00 + 24 + CRC (28+); take the last 24 before CRC.
  if (n >= 28 && reply[1] == 0xA5) memcpy(patchInfo, reply + n - 26, 24);
  else if (n >= 25) memcpy(patchInfo, reply + 1, 24);
  else return LIBRE_TAG_ERROR;
  return LIBRE_OK;
}

LibreRc LibrePN5180::enableStreaming(const uint8_t uid[8], const uint8_t patchInfo[24],
                                     uint32_t unlockCode, uint8_t macOut[6]) {
  // DiaBLE Libre2.swift:190-198 — secret = LE16(patchInfo[4..5]) ^ LE16(unlock[0..1])
  uint8_t p[4] = {(uint8_t)unlockCode, (uint8_t)(unlockCode >> 8), (uint8_t)(unlockCode >> 16),
                  (uint8_t)(unlockCode >> 24)};
  uint16_t secret = be16(patchInfo[5], patchInfo[4]) ^ be16(p[1], p[0]);
  uint8_t k[4];
  libre2UsefulFunction(uid, 0x1E, secret, k);
  uint8_t frame[12] = {0x02, 0xA1, uid[6], 0x1E, p[0], p[1], p[2], p[3], k[0], k[1], k[2], k[3]};
  uint8_t reply[LIBRE_MAX_REPLY], n = 0;
  LibreRc rc = transceive(frame, sizeof frame, reply, &n);
  if (rc != LIBRE_OK) return rc;
  if (n != 7) return LIBRE_TAG_ERROR;  // xDrip: res.length == 7 (flags + 6)
  for (int i = 0; i < 6; i++) macOut[i] = reply[6 - i];  // reversed -> MAC order
  return LIBRE_OK;
}

LibreRc LibrePN5180::readBlocks(uint8_t firstBlock, uint8_t count, uint8_t *out) {
  uint8_t frame[4] = {0x02, 0x23, firstBlock, (uint8_t)(count - 1)};  // xDrip :716
  uint8_t reply[LIBRE_MAX_REPLY], n = 0;
  LibreRc rc = transceive(frame, sizeof frame, reply, &n);
  if (rc != LIBRE_OK) return rc;
  if (n != 1 + 8 * count) return LIBRE_TAG_ERROR;
  memcpy(out, reply + 1, 8 * count);
  return LIBRE_OK;
}
