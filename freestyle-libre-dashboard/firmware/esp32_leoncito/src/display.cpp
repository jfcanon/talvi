#include "display.h"
#include <Wire.h>
#include <Arduino_GFX_Library.h>
#include "board_pins.h"

namespace display {

static Arduino_DataBus* s_bus = nullptr;
static Arduino_CO5300* s_gfx = nullptr;
static bool s_ok = false;

// CO5300 brightness register (0x51); upstream 1.4.9's Arduino_CO5300 has no setBrightness().
static void setBrightness(uint8_t b) {
  s_bus->beginWrite();
  s_bus->writeC8D8(0x51, b);
  s_bus->endWrite();
}
static constexpr uint8_t BRIGHTNESS = 120;  // AMOLED: modest, always-on device

// TCA9554 registers: 0x01 output, 0x03 config (0 = output).
static bool expanderWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(pins::EXPANDER_ADDR);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

// Same power-up pulse the Waveshare examples use: P0..P2 low 20 ms, then high.
static bool panelPowerCycle() {
  if (!expanderWrite(0x03, 0xF8)) return false;  // P0..P2 outputs
  expanderWrite(0x01, 0x00);
  delay(20);
  expanderWrite(0x01, 0x07);
  delay(50);
  return true;
}

bool begin() {
  Wire.begin(pins::IIC_SDA, pins::IIC_SCL);
  if (!panelPowerCycle()) {
    Serial.println("[display] TCA9554 expander not found — running headless");
    return false;
  }
  s_bus = new Arduino_ESP32QSPI(pins::LCD_CS, pins::LCD_SCLK, pins::LCD_SDIO0,
                                pins::LCD_SDIO1, pins::LCD_SDIO2, pins::LCD_SDIO3);
  // Board revision V2 (I2C scan: CST820 touch @0x15) => CO5300 panel.
  // Waveshare arduino-v2 HelloWorld: Arduino_CO5300(bus, RST, 0, W, H, 16, 0, 0, 0).
  s_gfx = new Arduino_CO5300(s_bus, GFX_NOT_DEFINED, 0, false, pins::LCD_WIDTH, pins::LCD_HEIGHT,
                             pins::LCD_COL_OFFSET, 0, 0, 0);
  if (!s_gfx->begin(40000000)) {
    Serial.println("[display] CO5300 init failed — running headless");
    return false;
  }
  s_gfx->fillScreen(RGB565_BLACK);
  setBrightness(BRIGHTNESS);
  s_ok = true;
  Serial.println("[display] CO5300 up");
  return true;
}

static void header(const String& title, uint16_t color) {
  s_gfx->fillScreen(RGB565_BLACK);
  s_gfx->setTextColor(color);
  s_gfx->setTextSize(3);
  s_gfx->setCursor(16, 24);
  s_gfx->println(title);
  s_gfx->drawFastHLine(16, 60, pins::LCD_WIDTH - 32, color);
}

static void line(int y, const String& text, uint8_t size = 2, uint16_t color = RGB565_WHITE) {
  s_gfx->setTextColor(color);
  s_gfx->setTextSize(size);
  s_gfx->setCursor(16, y);
  s_gfx->println(text);
}

void showSetup(const String& ap_ssid, const String& ap_pass) {
  if (!s_ok) return;
  header("Wi-Fi setup", RGB565_YELLOW);
  line(84,  "1. On your phone, join");
  line(108, "   Wi-Fi network:", 2);
  line(140, ap_ssid, 3, RGB565_CYAN);
  line(180, "   password:", 2);
  line(204, ap_pass, 3, RGB565_CYAN);
  line(250, "2. A setup page opens");
  line(274, "   (or open 192.168.4.1)");
  line(310, "3. Tap Configure WiFi,");
  line(334, "   pick your network,");
  line(358, "   type its password.");
  line(400, "Password stays on this", 2, RGB565_DARKGREY);
  line(420, "device only.", 2, RGB565_DARKGREY);
}

void showConnecting(const String& ssid) {
  if (!s_ok) return;
  header("Connecting", RGB565_CYAN);
  line(100, "Joining Wi-Fi:");
  line(130, ssid, 3, RGB565_WHITE);
}

void selfTest() {
  if (!s_ok) { Serial.println("[display] not initialised"); return; }
  const uint16_t colors[] = {RGB565_RED, RGB565_GREEN, RGB565_BLUE, RGB565_WHITE};
  for (uint16_t c : colors) { s_gfx->fillScreen(c); delay(700); }
  setBrightness(255);
  header("Screen test", RGB565_YELLOW);
  line(120, "If you can read this,", 2);
  line(150, "the panel works.", 2);
  Serial.println("[display] self-test drawn (red/green/blue/white, then text)");
}

void showMessage(const String& title, const String& body) {
  if (!s_ok) return;
  header(title, RGB565_WHITE);
  line(100, body);
}

void showStatus(const String& wifi_line, const String& cycle_line,
                float latest_mgdl, const String& trend, const String& latest_iso) {
  if (!s_ok) return;
  header("Leoncito", RGB565_GREEN);
  if (latest_mgdl > 0) {
    s_gfx->setTextColor(RGB565_WHITE);
    s_gfx->setTextSize(9);
    s_gfx->setCursor(24, 100);
    s_gfx->print((int)latest_mgdl);
    line(180, "mg/dL  " + trend, 2, RGB565_LIGHTGREY);
    line(206, latest_iso.length() >= 16 ? latest_iso.substring(11, 16) + " UTC" : latest_iso, 2, RGB565_DARKGREY);
  } else {
    line(110, "no reading yet", 3, RGB565_LIGHTGREY);
  }
  s_gfx->drawFastHLine(16, 250, pins::LCD_WIDTH - 32, RGB565_DARKGREY);
  line(270, wifi_line, 1, RGB565_LIGHTGREY);
  line(290, cycle_line, 1, RGB565_LIGHTGREY);
  line(420, "app.ygdcbtmc4u.uk/leoncito", 1, RGB565_DARKGREY);
}

}  // namespace display
