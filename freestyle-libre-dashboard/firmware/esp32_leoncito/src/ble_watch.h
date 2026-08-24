// Passive-only BLE advert watch. Groundwork for the direct-sensor phase:
// once the NEXT sensor is activated reader-first (PN532 + NFC-derived keys,
// NID-399 stage plan), this module is where the authenticated GATT session
// goes. Until then it NEVER connects and NEVER initiates pairing — the
// current sensor's BLE bond belongs to the owner's iPhone/LibreLink and an
// active connect could disturb it (and is cryptographically useless to us
// without the NFC-derived unlock anyway).
#pragma once
#include <Arduino.h>

namespace ble_watch {
void begin();
void loop();          // runs a short passive scan on its own cadence
String lastReport();  // console `ble`
}
