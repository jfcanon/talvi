// NVS-backed runtime settings. Single source of truth for everything the
// firmware needs that must not be compiled in (Wi-Fi + LLU credentials,
// ingest token). Provisioned over the USB serial console.
#pragma once
#include <Arduino.h>

struct Settings {
  String wifi_ssid;
  String wifi_pass;
  String llu_email;
  String llu_pass;
  String ingest_url;
  String ingest_token;
  String region;        // LLU region slug, e.g. "la"
  unsigned poll_s = 300;
  bool tls_insecure = false;  // console escape hatch if a root CA rotates

  void load();
  bool set(const String& key, const String& value);  // persists immediately
  bool clearKey(const String& key);
  void clearAll();
  bool readyForWifi() const { return wifi_ssid.length() > 0; }
  bool readyForFetch() const {
    return llu_email.length() && llu_pass.length() && ingest_token.length();
  }
  String describe(bool reveal_lengths_only = true) const;
};

extern Settings settings;
