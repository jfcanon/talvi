// Leoncito 24/7 fetcher — Waveshare ESP32-S3-Touch-AMOLED-1.8 (headless).
//
// Role: always-on residential-IP fetch node for the Leoncito glucose
// dashboard. Pulls the ~12h LibreLinkUp window every poll_s seconds and
// POSTs it to the Cloudflare worker's /api/ingest (idempotent merge). Runs
// alongside the Mac/Lima home-fetcher (NID-403) as redundancy: whichever
// node is alive keeps app.ygdcbtmc4u.uk/leoncito fresh.
//
// Direct sensor BLE is intentionally NOT attempted yet: the current Libre 2
// sensor's keys were established by the owner's iPhone at activation (the
// NID-398 crypto wall). Until the next sensor is activated reader-first with
// the PN532, this firmware only watches adverts passively (ble_watch.cpp).
#include <Arduino.h>
#include <esp_task_wdt.h>
#include "config.h"
#include "settings.h"
#include "console.h"
#include "wifi_link.h"
#include "llu_client.h"
#include "ingest_client.h"
#include "ble_watch.h"

static unsigned long s_next_cycle_ms = 0;
static unsigned s_consecutive_failures = 0;
static String s_last_cycle = "never ran";

void requestImmediateCycle() { s_next_cycle_ms = 0; }
String cycleStatus() {
  return "cycle: " + s_last_cycle + " | failures=" + String(s_consecutive_failures) +
         " | next in " + String(s_next_cycle_ms > millis() ? (s_next_cycle_ms - millis()) / 1000 : 0) + "s";
}

static void runCycle() {
  if (!settings.readyForFetch()) {
    s_last_cycle = "waiting for provisioning (`show` lists missing keys)";
    return;
  }
  Serial.println("[cycle] fetching LLU window...");
  LluWindow w = llu::fetchWindow();
  if (!w.ok) {
    s_consecutive_failures++;
    s_last_cycle = "LLU fetch failed: " + w.error;
    Serial.println("[cycle] " + s_last_cycle);
    return;
  }
  Serial.printf("[cycle] got %u readings, trend=%s\n",
                (unsigned)w.readings.size(), w.trend_enum.c_str());
  IngestResult r = ingest::push(w);
  if (r.ok) {
    s_consecutive_failures = 0;
    s_last_cycle = "ok: pushed " + String((unsigned)w.readings.size()) +
                   " readings (worker total " + String(r.total_readings) + ")";
  } else {
    s_consecutive_failures++;
    s_last_cycle = "ingest failed: " + r.error;
  }
  Serial.println("[cycle] " + s_last_cycle);
}

void setup() {
  Serial.begin(115200);
  unsigned long t0 = millis();
  while (!Serial && millis() - t0 < 3000) delay(10);  // wait briefly for CDC host
  Serial.println("\n=== Leoncito ESP32 fetcher (build " __DATE__ " " __TIME__ ") ===");

  settings.load();
  llu::loadSession();
  console::begin();
  wifi_link::begin();
  ble_watch::begin();

  esp_task_wdt_init(180, true);   // hard watchdog: any 3-min stall reboots
  esp_task_wdt_add(nullptr);

  s_next_cycle_ms = millis() + 8000;  // give Wi-Fi + SNTP a head start
}

void loop() {
  esp_task_wdt_reset();
  console::loop();
  wifi_link::loop();
  ble_watch::loop();

  if (millis() >= s_next_cycle_ms) {
    if (wifi_link::connected() && wifi_link::timeSynced()) {
      runCycle();
    } else if (settings.readyForWifi()) {
      s_last_cycle = "waiting for wifi/time";
    }
    s_next_cycle_ms = millis() + settings.poll_s * 1000UL;
  }

  if (s_consecutive_failures >= cfg::MAX_CONSECUTIVE_FAILURES) {
    Serial.println("[main] too many consecutive failures — rebooting");
    delay(500);
    ESP.restart();
  }
  delay(10);
}
