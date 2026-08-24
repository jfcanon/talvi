#include "ingest_client.h"
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include "settings.h"
#include "config.h"
#include "certs.h"

namespace ingest {

IngestResult push(const LluWindow& w) {
  IngestResult r;
  if (!settings.ingest_url.startsWith("https://")) { r.error = "ingest_url must be https"; return r; }
  if (settings.ingest_token.isEmpty()) { r.error = "ingest_token not provisioned"; return r; }

  JsonDocument doc;
  JsonArray readings = doc["readings"].to<JsonArray>();
  for (const auto& g : w.readings) {
    JsonObject o = readings.add<JsonObject>();
    o["timestamp"] = g.iso_ts;
    o["glucose"] = ((int)(g.mgdl * 10.0f + 0.5f)) / 10.0f;
    o["unit"] = "mg/dL";
  }
  doc["sensor_id"] = w.sensor_id;
  if (!w.trend_enum.isEmpty()) doc["trend"] = w.trend_enum;  // worker maps enum -> label
  if (!w.latest_iso.isEmpty()) doc["last_updated"] = w.latest_iso;
  String payload;
  serializeJson(doc, payload);

  WiFiClientSecure client;
  if (settings.tls_insecure) client.setInsecure();
  else client.setCACert(GTS_ROOTS_PEM);
  HTTPClient http;
  http.setTimeout(30000);
  if (!http.begin(client, settings.ingest_url)) { r.error = "http begin failed"; return r; }
  http.setUserAgent(cfg::INGEST_USER_AGENT);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", "Bearer " + settings.ingest_token);
  r.http_code = http.POST(payload);

  JsonDocument resp;
  deserializeJson(resp, http.getStream());
  http.end();
  if (r.http_code == 200 && (resp["success"] | false)) {
    r.ok = true;
    r.total_readings = resp["total_readings"] | 0;
    r.accepted = resp["accepted_readings"] | 0;
  } else {
    const char* e = resp["error"];
    r.error = "HTTP " + String(r.http_code) + (e ? (String(" ") + e) : String(""));
  }
  return r;
}

}  // namespace ingest
