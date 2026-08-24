// Waveshare ESP32-S3-Touch-AMOLED-1.8 — revision V2 (CO5300 panel + CST820 touch),
// established by I2C scan on the owner's board (0x15 = CST820). Same QSPI pins as V1.
// Source: waveshareteam/ESP32-S3-Touch-AMOLED-1.8 examples/arduino/libraries/Mylibrary/pin_config.h
#pragma once
namespace pins {
constexpr int LCD_SDIO0 = 4, LCD_SDIO1 = 5, LCD_SDIO2 = 6, LCD_SDIO3 = 7;
constexpr int LCD_SCLK = 11, LCD_CS = 12;
constexpr int LCD_WIDTH = 368, LCD_HEIGHT = 448;
constexpr int LCD_COL_OFFSET = 16;  // CO5300 column offset (Waveshare arduino-v2 example)
constexpr int IIC_SDA = 15, IIC_SCL = 14;
constexpr int TP_INT = 21;
constexpr uint8_t EXPANDER_ADDR = 0x20;  // TCA9554: P0..P2 = panel/touch reset & power
}
