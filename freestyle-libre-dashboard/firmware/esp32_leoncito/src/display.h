// On-screen status for the AMOLED. Two pages: SETUP (how to join the
// captive portal) and STATUS (link, last cycle, latest glucose).
#pragma once
#include <Arduino.h>

namespace display {
bool begin();  // false if the panel/expander did not answer (firmware keeps running headless)
void showSetup(const String& ap_ssid, const String& ap_pass);
void showConnecting(const String& ssid);
void showStatus(const String& wifi_line, const String& cycle_line,
                float latest_mgdl, const String& trend, const String& latest_iso);
void selfTest();  // console `screen-test`
void showMessage(const String& title, const String& body);
}
