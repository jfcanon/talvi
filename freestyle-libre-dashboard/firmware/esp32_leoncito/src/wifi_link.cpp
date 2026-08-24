#include "wifi_link.h"
#include <WiFi.h>
#include <time.h>
#include "settings.h"
#include "config.h"

namespace wifi_link {

static unsigned long next_attempt_ms = 0;
static unsigned backoff_ms = cfg::WIFI_RETRY_BASE_MS;
static bool sntp_started = false;

void begin() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false);  // creds live in our NVS namespace, not the driver's
  if (settings.readyForWifi()) {
    Serial.printf("[wifi] connecting to '%s'\n", settings.wifi_ssid.c_str());
    WiFi.begin(settings.wifi_ssid.c_str(), settings.wifi_pass.c_str());
  } else {
    Serial.println("[wifi] no credentials provisioned — `set wifi_ssid ...` + `set wifi_pass ...`");
  }
}

bool connected() { return WiFi.status() == WL_CONNECTED; }

bool timeSynced() {
  time_t now = time(nullptr);
  return now > 1700000000;  // sanity: after 2023 => SNTP answered
}

void loop() {
  if (!settings.readyForWifi()) return;
  if (connected()) {
    backoff_ms = cfg::WIFI_RETRY_BASE_MS;
    if (!sntp_started) {
      configTime(0, 0, "pool.ntp.org", "time.google.com");
      sntp_started = true;
      Serial.println("[wifi] link up, SNTP requested");
    }
    return;
  }
  sntp_started = false;
  unsigned long now = millis();
  if (now < next_attempt_ms) return;
  Serial.printf("[wifi] retrying '%s' (backoff %us)\n",
                settings.wifi_ssid.c_str(), backoff_ms / 1000);
  WiFi.disconnect();
  WiFi.begin(settings.wifi_ssid.c_str(), settings.wifi_pass.c_str());
  next_attempt_ms = now + backoff_ms;
  backoff_ms = min(backoff_ms * 2, 120000u);
}

String status() {
  String s = "wifi=";
  if (connected()) {
    s += "up ssid=" + WiFi.SSID() + " ip=" + WiFi.localIP().toString()
       + " rssi=" + String(WiFi.RSSI()) + "dBm";
  } else {
    s += settings.readyForWifi() ? "connecting" : "unprovisioned";
  }
  s += timeSynced() ? " time=synced" : " time=unsynced";
  return s;
}

void scanToSerial() {
  Serial.println("[wifi] scanning (2.4 GHz)...");
  int n = WiFi.scanNetworks(false, true);
  for (int i = 0; i < n; i++) {
    Serial.printf("  %2d. %-32s ch%-2d %ddBm %s\n", i + 1,
                  WiFi.SSID(i).isEmpty() ? "(hidden)" : WiFi.SSID(i).c_str(),
                  WiFi.channel(i), WiFi.RSSI(i),
                  WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? "open" : "sec");
  }
  if (n <= 0) Serial.println("  (none found)");
  WiFi.scanDelete();
}

}  // namespace wifi_link
