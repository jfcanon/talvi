#include "settings.h"
#include <Preferences.h>
#include "config.h"

Settings settings;
static Preferences prefs;
static const char* NS = "leoncito";

// Key table keeps set/get/clear symmetric and the console honest.
struct KeyDef { const char* name; String Settings::*sfield; };
static const KeyDef STR_KEYS[] = {
  {"wifi_ssid",    &Settings::wifi_ssid},
  {"wifi_pass",    &Settings::wifi_pass},
  {"llu_email",    &Settings::llu_email},
  {"llu_pass",     &Settings::llu_pass},
  {"ingest_url",   &Settings::ingest_url},
  {"ingest_token", &Settings::ingest_token},
  {"region",       &Settings::region},
};

void Settings::load() {
  prefs.begin(NS, true);
  for (auto& k : STR_KEYS) this->*(k.sfield) = prefs.getString(k.name, "");
  poll_s = prefs.getUInt("poll_s", cfg::DEFAULT_POLL_SECONDS);
  tls_insecure = prefs.getBool("tls_insecure", false);
  prefs.end();
  if (ingest_url.isEmpty()) ingest_url = cfg::DEFAULT_INGEST_URL;
  if (region.isEmpty()) region = cfg::LLU_DEFAULT_REGION;
  if (poll_s < 60) poll_s = 60;  // stay polite to the LLU API
}

bool Settings::set(const String& key, const String& value) {
  prefs.begin(NS, false);
  bool ok = false;
  for (auto& k : STR_KEYS) {
    if (key == k.name) { prefs.putString(k.name, value); this->*(k.sfield) = value; ok = true; }
  }
  if (key == "poll_s") {
    unsigned v = value.toInt();
    if (v >= 60 && v <= 86400) { prefs.putUInt("poll_s", v); poll_s = v; ok = true; }
  }
  if (key == "tls_insecure") {
    bool v = (value == "1" || value == "true");
    prefs.putBool("tls_insecure", v); tls_insecure = v; ok = true;
  }
  prefs.end();
  return ok;
}

bool Settings::clearKey(const String& key) {
  prefs.begin(NS, false);
  bool ok = prefs.remove(key.c_str());
  prefs.end();
  load();
  return ok;
}

void Settings::clearAll() {
  prefs.begin(NS, false);
  prefs.clear();
  prefs.end();
  load();
}

static String mask(const String& v) {
  if (v.isEmpty()) return "(unset)";
  return String("(set, ") + v.length() + " chars)";
}

String Settings::describe(bool) const {
  String s;
  s += "wifi_ssid    = " + (wifi_ssid.isEmpty() ? String("(unset)") : wifi_ssid) + "\n";
  s += "wifi_pass    = " + mask(wifi_pass) + "\n";
  s += "llu_email    = " + mask(llu_email) + "\n";
  s += "llu_pass     = " + mask(llu_pass) + "\n";
  s += "ingest_url   = " + ingest_url + "\n";
  s += "ingest_token = " + mask(ingest_token) + "\n";
  s += "region       = " + region + "\n";
  s += "poll_s       = " + String(poll_s) + "\n";
  s += "tls_insecure = " + String(tls_insecure ? "1" : "0") + "\n";
  return s;
}
