#include "llu_client.h"
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include "mbedtls/sha256.h"
#include "settings.h"
#include "config.h"
#include "certs.h"
#include "tstamp.h"

namespace llu {

static String s_token, s_account_hash, s_patient_id, s_region;
static time_t s_expires = 0;
static const char* NS = "llusession";

static void persistSession() {
  Preferences p;
  p.begin(NS, false);
  p.putString("token", s_token);
  p.putString("acct", s_account_hash);
  p.putString("patient", s_patient_id);
  p.putString("region", s_region);
  p.putLong64("expires", (int64_t)s_expires);
  p.end();
}

void loadSession() {
  Preferences p;
  p.begin(NS, true);
  s_token = p.getString("token", "");
  s_account_hash = p.getString("acct", "");
  s_patient_id = p.getString("patient", "");
  s_region = p.getString("region", "");
  s_expires = (time_t)p.getLong64("expires", 0);
  p.end();
  if (s_region.isEmpty()) s_region = settings.region;
}

void forgetSession() {
  Preferences p;
  p.begin(NS, false);
  p.clear();
  p.end();
  s_token = s_account_hash = s_patient_id = "";
  s_expires = 0;
  s_region = settings.region;
}

String sessionStatus() {
  String s = "llu region=" + s_region;
  s += s_token.isEmpty() ? " token=none" : (" token=cached exp=" + String((long)s_expires));
  s += s_patient_id.isEmpty() ? " patient=none" : " patient=known";
  return s;
}

static String sha256hex(const String& in) {
  unsigned char out[32];
  mbedtls_sha256((const unsigned char*)in.c_str(), in.length(), out, 0);
  char hex[65];
  for (int i = 0; i < 32; i++) sprintf(hex + i * 2, "%02x", out[i]);
  return String(hex);
}

static void applyTls(WiFiClientSecure& c) {
  if (settings.tls_insecure) c.setInsecure();
  else c.setCACert(GTS_ROOTS_PEM);
}

static String baseUrl() { return "https://api-" + s_region + ".libreview.io"; }

static void commonHeaders(HTTPClient& http, bool authed) {
  http.setUserAgent(cfg::LLU_USER_AGENT);
  http.addHeader("product", cfg::LLU_PRODUCT);
  http.addHeader("version", cfg::LLU_VERSION);
  http.addHeader("Accept", "application/json");
  if (authed) {
    http.addHeader("Authorization", "Bearer " + s_token);
    http.addHeader("account-id", s_account_hash);
  }
}

// Returns "" on success, error string otherwise. Follows one region redirect
// per call; caller loop bounds total attempts.
static String loginOnce(bool& redirected) {
  redirected = false;
  WiFiClientSecure client;
  applyTls(client);
  HTTPClient http;
  http.setTimeout(20000);
  if (!http.begin(client, baseUrl() + "/llu/auth/login")) return "http begin failed";
  commonHeaders(http, false);
  http.addHeader("Content-Type", "application/json");
  JsonDocument body;
  body["email"] = settings.llu_email;
  body["password"] = settings.llu_pass;
  String payload;
  serializeJson(body, payload);
  int code = http.POST(payload);
  if (code != 200) { http.end(); return "login HTTP " + String(code); }

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, http.getStream());
  http.end();
  if (err) return String("login parse: ") + err.c_str();

  JsonObject data = doc["data"];
  if (data["redirect"] | false) {
    const char* region = data["region"];
    if (!region) return "redirect without region";
    s_region = region;
    Serial.printf("[llu] account redirects to region '%s'\n", region);
    redirected = true;
    return "";
  }
  int status = doc["status"] | -1;
  const char* token = data["authTicket"]["token"];
  const char* uid = data["user"]["id"];
  if (status != 0 || !token || !uid) return "login rejected status=" + String(status);
  s_token = token;
  s_expires = (time_t)(data["authTicket"]["expires"] | 0);
  s_account_hash = sha256hex(String(uid));
  persistSession();
  Serial.println("[llu] login ok, session persisted");
  return "";
}

static String login() {
  for (int i = 0; i < 3; i++) {
    bool redirected = false;
    String err = loginOnce(redirected);
    if (!err.isEmpty()) return err;
    if (!redirected) return "";
  }
  return "too many region redirects";
}

static String resolvePatient() {
  WiFiClientSecure client;
  applyTls(client);
  HTTPClient http;
  http.setTimeout(20000);
  if (!http.begin(client, baseUrl() + "/llu/connections")) return "http begin failed";
  commonHeaders(http, true);
  int code = http.GET();
  if (code == 401 || code == 403) { http.end(); return "AUTH"; }
  if (code != 200) { http.end(); return "connections HTTP " + String(code); }
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, http.getStream());
  http.end();
  if (err) return String("connections parse: ") + err.c_str();
  if (!doc["data"].is<JsonArray>()) return "connections: unexpected shape (version gate?)";
  JsonArray arr = doc["data"].as<JsonArray>();
  if (arr.size() == 0) return "account has 0 connections";
  const char* pid = arr[0]["patientId"];
  if (!pid) return "no patientId";
  s_patient_id = pid;
  persistSession();
  Serial.printf("[llu] patient resolved\n");
  return "";
}

static const char* TREND_ENUM[] = {"", "DOWN_FAST", "DOWN_SLOW", "STABLE", "UP_SLOW", "UP_FAST"};

static String fetchGraphInto(LluWindow& w) {
  WiFiClientSecure client;
  applyTls(client);
  HTTPClient http;
  http.setTimeout(25000);
  String url = baseUrl() + "/llu/connections/" + s_patient_id + "/graph";
  if (!http.begin(client, url)) return "http begin failed";
  commonHeaders(http, true);
  int code = http.GET();
  if (code == 401 || code == 403) { http.end(); return "AUTH"; }
  if (code != 200) { http.end(); return "graph HTTP " + String(code); }

  // Filter keeps the parse small even though the raw response is large.
  JsonDocument filter;
  filter["data"]["connection"]["glucoseMeasurement"]["FactoryTimestamp"] = true;
  filter["data"]["connection"]["glucoseMeasurement"]["ValueInMgPerDl"] = true;
  filter["data"]["connection"]["glucoseMeasurement"]["TrendArrow"] = true;
  filter["data"]["graphData"][0]["FactoryTimestamp"] = true;
  filter["data"]["graphData"][0]["ValueInMgPerDl"] = true;
  JsonDocument doc;
  DeserializationError err =
      deserializeJson(doc, http.getStream(), DeserializationOption::Filter(filter));
  http.end();
  if (err) return String("graph parse: ") + err.c_str();

  for (JsonObject pt : doc["data"]["graphData"].as<JsonArray>()) {
    float v = pt["ValueInMgPerDl"] | 0.0f;
    String iso = lluFactoryToIso(pt["FactoryTimestamp"]);
    if (iso.isEmpty() || v < cfg::MIN_GLUCOSE_MGDL || v > cfg::MAX_GLUCOSE_MGDL) continue;
    w.readings.push_back({iso, v});
  }
  JsonObject gm = doc["data"]["connection"]["glucoseMeasurement"];
  if (!gm.isNull()) {
    float v = gm["ValueInMgPerDl"] | 0.0f;
    String iso = lluFactoryToIso(gm["FactoryTimestamp"]);
    if (!iso.isEmpty() && v >= cfg::MIN_GLUCOSE_MGDL && v <= cfg::MAX_GLUCOSE_MGDL) {
      w.readings.push_back({iso, v});   // live value; graph endpoint lags it
      w.latest_iso = iso;
    }
    int arrow = gm["TrendArrow"] | 0;
    if (arrow >= 1 && arrow <= 5) w.trend_enum = TREND_ENUM[arrow];
  }
  w.sensor_id = s_patient_id.substring(0, 6);
  w.sensor_id.toUpperCase();
  return "";
}

LluWindow fetchWindow() {
  LluWindow w;
  if (!settings.readyForFetch()) { w.error = "credentials not provisioned"; return w; }

  bool retried_auth = false;
  for (int attempt = 0; attempt < 2; attempt++) {
    if (s_token.isEmpty() || (s_expires && time(nullptr) > s_expires - 3600)) {
      String err = login();
      if (!err.isEmpty()) { w.error = err; return w; }
    }
    if (s_patient_id.isEmpty()) {
      String err = resolvePatient();
      if (err == "AUTH" && !retried_auth) { retried_auth = true; s_token = ""; continue; }
      if (!err.isEmpty()) { w.error = err; return w; }
    }
    String err = fetchGraphInto(w);
    if (err == "AUTH" && !retried_auth) { retried_auth = true; s_token = ""; continue; }
    if (!err.isEmpty()) { w.error = err; return w; }
    w.ok = true;
    return w;
  }
  w.error = "auth retry exhausted";
  return w;
}

}  // namespace llu
