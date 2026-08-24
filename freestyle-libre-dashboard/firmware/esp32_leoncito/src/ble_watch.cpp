#include "ble_watch.h"
#include <NimBLEDevice.h>
#include "config.h"

namespace ble_watch {

static String s_report = "(no scan yet)";
static unsigned long s_next_scan_ms = 20000;  // first scan shortly after boot
static bool s_inited = false;

void begin() {
  NimBLEDevice::init("");
  s_inited = true;
}

static void runScan() {
  NimBLEScan* scan = NimBLEDevice::getScan();
  scan->setActiveScan(false);  // passive: listen only, radiate nothing extra
  NimBLEScanResults results = scan->start(cfg::BLE_SCAN_DURATION_SECONDS, false);
  int total = results.getCount();
  int named = 0, abbott = 0;
  String lines;
  for (int i = 0; i < total; i++) {
    NimBLEAdvertisedDevice d = results.getDevice(i);
    String name = d.haveName() ? String(d.getName().c_str()) : "";
    if (name.isEmpty()) continue;
    named++;
    String upper = name; upper.toUpperCase();
    bool isAbbott = upper.startsWith("ABBOTT");
    if (isAbbott) abbott++;
    if (isAbbott || named <= 12) {
      lines += "  " + String(isAbbott ? "[LIBRE] " : "        ") + name +
               " rssi=" + String(d.getRSSI()) + "\n";
    }
  }
  scan->clearResults();
  s_report = "last passive scan: " + String(total) + " adverts, " + String(named) +
             " named, " + String(abbott) + " ABBOTT*\n" + lines;
  Serial.printf("[ble] %d adverts, %d named, %d ABBOTT*\n", total, named, abbott);
}

void loop() {
  if (!s_inited || millis() < s_next_scan_ms) return;
  s_next_scan_ms = millis() + cfg::BLE_SCAN_EVERY_SECONDS * 1000UL;
  runScan();
}

String lastReport() { return s_report; }

}  // namespace ble_watch
