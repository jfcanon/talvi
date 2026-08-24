// Minimal LibreLinkUp client. Protocol verified live 2026-08-24 with plain
// HTTP from the same account: POST /llu/auth/login (region redirect aware),
// GET /llu/connections, GET /llu/connections/{patientId}/graph.
// Session discipline ("keep session alive"): the bearer token (valid for
// months) + account-id hash + patientId persist in NVS and are reused across
// polls AND reboots; re-login only on 401/410/expiry.
#pragma once
#include <Arduino.h>
#include <vector>

struct GlucoseReading {
  String iso_ts;      // ISO-8601 Z (from FactoryTimestamp, which is UTC)
  float mgdl;
};

struct LluWindow {
  std::vector<GlucoseReading> readings;  // ~12h graph + live latest appended
  String latest_iso;
  String trend_enum;   // DOWN_FAST..UP_FAST ("" if unknown)
  String sensor_id;    // patientId first 6, uppercased
  bool ok = false;
  String error;
};

namespace llu {
void loadSession();                 // NVS -> RAM at boot
void forgetSession();               // console `llu-reset`
String sessionStatus();
LluWindow fetchWindow();            // login if needed, then graph
}
