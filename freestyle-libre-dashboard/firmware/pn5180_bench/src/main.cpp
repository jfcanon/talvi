// Bench: tap a Libre 2 on the PN5180, print UID + raw `02 A1 07` reply + generation guess.
// Serial console (USB CDC 115200). Type `s` to also send enable-streaming (unlock 42) —
// WARNING: that evicts the phone's BLE stream (ping-pong).
#include <Arduino.h>
#include "LibrePN5180.h"

static LibrePN5180 nfc;

static void hex(const char *tag, const uint8_t *b, size_t n) {
  Serial.printf("%s:", tag);
  for (size_t i = 0; i < n; i++) Serial.printf(" %02X", b[i]);
  Serial.println();
}

static const char *generation(const uint8_t *pi) {
  if (pi[0] == 0x9D && pi[1] == 0x08) return "Libre 2 EU (Gen1 — streaming crypto reversed)";
  if (pi[0] == 0xC5 && pi[1] == 0x09) return "Libre 2 Plus EU (C5 09)";
  if (pi[0] == 0xC6 && pi[1] == 0x09) return "Libre 2 Plus (C6 09)";
  if (pi[0] == 0xE5 && pi[1] == 0x00) return "Libre US 14-day";
  if (pi[0] == 0xDF && pi[1] == 0x00) return "Libre 1";
  if (pi[0] == 0xA2) return "'A2' kind (DiaBLE NFC.swift:382) — treat as Gen2";
  return "unknown — check DiaBLE SensorType(patchInfo:)";
}

void setup() {
  Serial.begin(115200);
  delay(1500);
  Serial.println("[bench] PN5180 <-> Libre 2");
  if (!nfc.beginLibre()) { Serial.println("[bench] PN5180 not found (check wiring/5V)"); }
}

void loop() {
  static bool wantStreaming = false;
  while (Serial.available()) if (Serial.read() == 's') wantStreaming = true;

  uint8_t uid[8];
  if (!nfc.waitForTag(uid, 1000)) return;                       // 1. inventory (26 01 00)
  hex("[bench] UID (LSB first)", uid, 8);
  Serial.printf("[bench] IC mfg byte = 0x%02X (expect 07 = TI)\n", uid[6]);

  uint8_t frame[3] = {0x02, 0xA1, uid[6]}, reply[LIBRE_MAX_REPLY], n = 0;
  LibreRc rc = nfc.transceive(frame, 3, reply, &n);             // 2. raw 02 A1 07
  Serial.printf("[bench] 02 A1 %02X -> rc=%d len=%u\n", uid[6], rc, n);
  if (n) hex("[bench] raw reply", reply, n);

  uint8_t pi[24];
  if (nfc.readPatchInfo(uid, pi) == LIBRE_OK) {
    hex("[bench] patchInfo", pi, 24);
    Serial.printf("[bench] generation: %s\n", generation(pi));
    if (wantStreaming) {
      uint8_t mac[6];
      LibreRc r = nfc.enableStreaming(uid, pi, 42, mac);        // 3. 02 A1 07 1E ...
      Serial.printf("[bench] enable streaming rc=%d\n", r);
      if (r == LIBRE_OK) Serial.printf("[bench] BLE MAC %02X:%02X:%02X:%02X:%02X:%02X\n",
                                       mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
      wantStreaming = false;
    }
  }
  delay(3000);
}
