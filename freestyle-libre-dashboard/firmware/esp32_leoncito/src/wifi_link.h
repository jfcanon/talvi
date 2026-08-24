// Wi-Fi STA link with auto-reconnect + SNTP time. The fetch loop only runs
// once link + wall-clock time are up (TLS needs valid time).
#pragma once
#include <Arduino.h>

namespace wifi_link {
void begin();            // starts connection attempts if creds provisioned
void loop();             // reconnect state machine, call every loop()
bool connected();
bool portalActive();  // captive portal running (setup screen shown)
bool timeSynced();
String status();         // human-readable one-liner for the console
void scanToSerial();     // sync scan, prints SSID/RSSI/channel table
}
