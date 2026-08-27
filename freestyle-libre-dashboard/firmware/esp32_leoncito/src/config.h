// Compile-time defaults. Everything operational is overridable at runtime via
// the USB serial console (see console.cpp) and persisted in NVS — no secret
// ever lives in this repo or in the compiled binary.
#pragma once

namespace cfg {
// LibreLinkUp API (unofficial, same protocol the LibreLinkUp app speaks).
constexpr const char* LLU_DEFAULT_REGION = "la";      // verified for this account (redirect from EU)
constexpr const char* LLU_PRODUCT        = "llu.android";
constexpr const char* LLU_VERSION        = "4.16.0";  // min accepted as of 2026-08 (older -> {"minimumVersion"})
constexpr const char* LLU_USER_AGENT     = "LibreLinkUp";

// Dashboard worker ingest (bearer-gated, merge-idempotent).
constexpr const char* DEFAULT_INGEST_URL = "https://app.ygdcbtmc4u.uk/api/ingest";
constexpr const char* INGEST_USER_AGENT  = "leoncito-esp32/1.0";

// Cadence
constexpr unsigned DEFAULT_POLL_SECONDS   = 300;   // sensor emits every 5 min
constexpr unsigned BLE_SCAN_EVERY_SECONDS = 600;   // passive advert watch
constexpr unsigned BLE_SCAN_DURATION_SECONDS = 15;
constexpr unsigned WIFI_RETRY_BASE_MS     = 2000;  // exponential backoff base
constexpr unsigned MAX_CONSECUTIVE_FAILURES = 24;  // ~2 h of failed cycles -> reboot

// Wi-Fi setup captive portal (shown on the AMOLED)
constexpr const char* SETUP_AP_SSID = "Leoncito-Setup";
constexpr const char* SETUP_AP_PASS = "leoncito1";      // WPA2 needs >= 8 chars; printed on screen
constexpr unsigned SETUP_PORTAL_TIMEOUT_S = 900;      // then reboot & retry
constexpr unsigned STORED_CREDS_WAIT_MS   = 25000;    // before falling back to the portal
constexpr unsigned SCREEN_REFRESH_SECONDS = 30;
constexpr int LOCAL_UTC_OFFSET_HOURS = -3;   // Argentina (ART), no DST

// Bounds
constexpr float MIN_GLUCOSE_MGDL = 40.0f;
constexpr float MAX_GLUCOSE_MGDL = 500.0f;
}  // namespace cfg
