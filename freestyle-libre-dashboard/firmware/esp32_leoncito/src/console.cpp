#include "console.h"
#include <Arduino.h>
#include "settings.h"
#include "wifi_link.h"
#include "llu_client.h"
#include "ble_watch.h"
#include "display.h"
#include <Wire.h>

// main.cpp exposes these for `run`/`status`.
extern void requestImmediateCycle();
extern String cycleStatus();

namespace console {

static String buf;

static void help() {
  Serial.println(
    "Leoncito ESP32 console — commands:\n"
    "  show                    settings (secrets masked)\n"
    "  set <key> <value>       keys: wifi_ssid wifi_pass llu_email llu_pass\n"
    "                          ingest_url ingest_token region poll_s tls_insecure\n"
    "  clear <key> | clear all\n"
    "  wifi-scan               list visible 2.4 GHz networks\n"
    "  run                     fetch+push now\n"
    "  status                  link/session/cycle state\n"
    "  ble                     last passive BLE scan report\n"
    "  llu-reset               drop cached LLU session (forces re-login)\n"
    "  i2c-scan                list I2C devices (board revision check)\n"
    "  screen-test             fill colours + text on the AMOLED\n"
    "  portal                  forget Wi-Fi and reboot into the setup hotspot\n"
    "  reboot");
}

static void handle(String line) {
  line.trim();
  if (line.isEmpty()) return;
  int sp = line.indexOf(' ');
  String cmd = sp < 0 ? line : line.substring(0, sp);
  String rest = sp < 0 ? "" : line.substring(sp + 1);
  cmd.toLowerCase();

  if (cmd == "help" || cmd == "?") { help(); return; }
  if (cmd == "show") { Serial.print(settings.describe()); return; }
  if (cmd == "set") {
    int sp2 = rest.indexOf(' ');
    if (sp2 < 0) { Serial.println("usage: set <key> <value>"); return; }
    String key = rest.substring(0, sp2);
    String value = rest.substring(sp2 + 1);
    value.trim();
    if (settings.set(key, value)) Serial.println("ok: " + key + " saved to NVS");
    else Serial.println("unknown key: " + key);
    return;
  }
  if (cmd == "clear") {
    rest.trim();
    if (rest == "all") { settings.clearAll(); Serial.println("ok: all settings cleared"); }
    else if (settings.clearKey(rest)) Serial.println("ok: cleared " + rest);
    else Serial.println("nothing cleared");
    return;
  }
  if (cmd == "wifi-scan") { wifi_link::scanToSerial(); return; }
  if (cmd == "run") { requestImmediateCycle(); Serial.println("ok: cycle scheduled"); return; }
  if (cmd == "status") {
    Serial.println(wifi_link::status());
    Serial.println(llu::sessionStatus());
    Serial.println(cycleStatus());
    Serial.printf("heap=%u psram=%u uptime=%lus\n",
                  ESP.getFreeHeap(), ESP.getFreePsram(), millis() / 1000);
    return;
  }
  if (cmd == "ble") { Serial.print(ble_watch::lastReport()); return; }
  if (cmd == "llu-reset") { llu::forgetSession(); Serial.println("ok: LLU session dropped"); return; }
  if (cmd == "i2c-scan") {
    Serial.println("[i2c] scanning 0x08..0x77");
    for (uint8_t a = 8; a < 0x78; a++) {
      Wire.beginTransmission(a);
      if (Wire.endTransmission() == 0) Serial.printf("  found 0x%02X\n", a);
    }
    Serial.println("[i2c] done (0x38=FT3168 V1, 0x15=CST820 V2, 0x34=AXP2101, 0x20=TCA9554)");
    return;
  }
  if (cmd == "screen-test") { display::selfTest(); return; }
  if (cmd == "portal") {
    settings.clearKey("wifi_ssid"); settings.clearKey("wifi_pass");
    Serial.println("wifi cleared, rebooting into setup portal..."); delay(200); ESP.restart(); return;
  }
  if (cmd == "reboot") { Serial.println("rebooting..."); delay(200); ESP.restart(); return; }
  Serial.println("unknown command (try `help`)");
}

void begin() {
  buf.reserve(160);
  Serial.println("[console] ready — type `help`");
}

void loop() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') { handle(buf); buf = ""; continue; }
    if (buf.length() < 512) buf += c;
  }
}

}  // namespace console
