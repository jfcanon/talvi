// USB serial provisioning + ops console (115200, line-based).
// This is how secrets get onto the device: over the local USB cable into
// NVS — never compiled in, never in git.
#pragma once
namespace console {
void begin();
void loop();  // call every loop(); non-blocking line reader
}
