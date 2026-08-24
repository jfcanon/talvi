#include "wifi_link.h"
#include <WiFi.h>
#include <WiFiManager.h>
#include <time.h>
#include "settings.h"
#include "config.h"
#include "display.h"

namespace wifi_link {

static unsigned long next_attempt_ms = 0;
static unsigned backoff_ms = cfg::WIFI_RETRY_BASE_MS;
static bool sntp_started = false;

static bool tryStored(unsigned wait_ms) {
  WiFi.begin(settings.wifi_ssid.c_str(), settings.wifi_pass.c_str());
  unsigned long t0 = millis();
  while (millis() - t0 < wait_ms && WiFi.status() != WL_CONNECTED) delay(100);
  return WiFi.status() == WL_CONNECTED;
}

// Captive portal: phone joins the AP -> scan list -> pick SSID -> type
// password. Non-blocking so the serial console, BLE watch and screen keep
// running; reboots on timeout so a stuck portal can never wedge the device.
static WiFiManager* s_wm = nullptr;
static unsigned long s_portal_deadline_ms = 0;

static void startPortal() {
  display::showSetup(cfg::SETUP_AP_SSID, cfg::SETUP_AP_PASS);
  Serial.printf("[wifi] starting setup portal AP '%s' for %us\n",
                cfg::SETUP_AP_SSID, cfg::SETUP_PORTAL_TIMEOUT_S);
  s_wm = new WiFiManager();
  s_wm->setConfigPortalBlocking(false);
  s_wm->setConnectTimeout(30);
  s_wm->setTitle("Leoncito ESP32");
  s_wm->setShowInfoUpdate(false);
  s_wm->startConfigPortal(cfg::SETUP_AP_SSID, cfg::SETUP_AP_PASS);
  s_portal_deadline_ms = millis() + cfg::SETUP_PORTAL_TIMEOUT_S * 1000UL;
}

bool portalActive() { return s_wm != nullptr; }

static void portalLoop() {
  if (s_wm->process()) {
    // process() returns true once the portal succeeded in joining a network.
    if (WiFi.status() == WL_CONNECTED) {
      settings.set("wifi_ssid", WiFi.SSID());
      settings.set("wifi_pass", WiFi.psk());
      Serial.printf("[wifi] portal: joined '%s', credentials saved to NVS\n", WiFi.SSID().c_str());
      s_wm->stopConfigPortal();
      delete s_wm; s_wm = nullptr;
      WiFi.mode(WIFI_STA);
      return;
    }
  }
  if (millis() > s_portal_deadline_ms) {
    Serial.println("[wifi] portal timed out - rebooting to retry");
    delay(300);
    ESP.restart();
  }
}

void begin() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false);  // creds live in our NVS namespace, not the driver's
  if (settings.readyForWifi()) {
    Serial.printf("[wifi] connecting to '%s'\n", settings.wifi_ssid.c_str());
    display::showConnecting(settings.wifi_ssid);
    if (tryStored(cfg::STORED_CREDS_WAIT_MS)) return;
    Serial.println("[wifi] stored credentials did not connect");
  }
  startPortal();
}

bool connected() { return WiFi.status() == WL_CONNECTED; }

bool timeSynced() {
  time_t now = time(nullptr);
  return now > 1700000000;  // sanity: after 2023 => SNTP answered
}

void loop() {
  if (s_wm) { portalLoop(); return; }
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
  } else if (s_wm) {
    s += "setup-portal";
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
