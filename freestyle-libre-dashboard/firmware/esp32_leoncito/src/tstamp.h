// LibreLinkUp timestamp handling. FactoryTimestamp is UTC in the form
// "M/D/YYYY H:MM:SS AM"; the dashboard contract wants ISO-8601 Zulu.
// (The naive local `Timestamp` field is intentionally ignored — see
// scripts/fetch_glucose.py NID-403 3h-early fix for the history.)
#pragma once
#include <Arduino.h>

// "8/24/2026 8:20:39 PM" -> "2026-08-24T20:20:39Z". Empty string on parse error.
String lluFactoryToIso(const char* factory_ts);
