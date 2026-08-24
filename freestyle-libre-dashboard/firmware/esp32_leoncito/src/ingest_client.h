// POST the fresh LLU window to the dashboard worker's /api/ingest.
// The worker merges idempotently (dedupe by timestamp), so re-sending the
// same ~12h window every poll is safe and makes any single failure lossless.
#pragma once
#include "llu_client.h"

struct IngestResult {
  bool ok = false;
  int http_code = 0;
  int total_readings = 0;
  int accepted = 0;
  String error;
};

namespace ingest {
IngestResult push(const LluWindow& w);
}
