#!/usr/bin/env python3
"""Hourly glucose fetch for the Leoncito dashboard.

Pulls the latest readings from the LibreLinkUp API (via pylibrelinkup),
merges them into ``data/glucose.json``, and writes the file atomically.

Designed to run on a schedule (GitHub Actions hourly cron). Safe to run
by hand: missing credentials fail loudly, but an empty patient list or a
transient API error keeps existing data intact.

Data contract (data/glucose.json):

    {
      "readings": [
        {"timestamp": "2026-08-20T14:30:00Z", "glucose": 145, "unit": "mg/dL"},
        ...
      ],
      "last_updated": "2026-08-20T14:30:00Z",
      "sensor_id": "XXXXXX",
      "trend": "stable"
    }

Usage:
    python scripts/fetch_glucose.py                      # live fetch (env creds)
    python scripts/fetch_glucose.py --mock               # deterministic sample data
    python scripts/fetch_glucose.py --data out.json      # custom output path
    python scripts/fetch_glucose.py --region api-eu.libreview.io
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import random
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from pydantic import ValidationError
from pylibrelinkup import PyLibreLinkUp
from pylibrelinkup.api_url import APIUrl

log = logging.getLogger("fetch_glucose")

# LibreLinkUp reports values down to 40 ("LO") and up to ~500 ("HI").
# The plan's 80-400 range would silently drop real hypoglycaemic readings,
# which are exactly the ones that matter for a diabetic cat — so accept the
# full measurable range and flag anything outside it as invalid.
MIN_GLUCOSE_MGDL = 40.0
MAX_GLUCOSE_MGDL = 500.0

TREND_LABEL = {
    "DOWN_FAST": "falling fast",
    "DOWN_SLOW": "falling",
    "STABLE": "stable",
    "UP_SLOW": "rising",
    "UP_FAST": "rising fast",
}

DEFAULT_DATA_PATH = "data/glucose.json"
DEFAULT_MAX_DAYS = 120  # cap history to bound repo growth
MOCK_SENSOR_ID = "MOCK-000001"


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--data", default=DEFAULT_DATA_PATH,
                   help=f"output JSON path (default: {DEFAULT_DATA_PATH})")
    p.add_argument("--mock", action="store_true",
                   help="generate deterministic sample data instead of hitting the API")
    p.add_argument("--region", default=None,
                   help="LibreLinkUp region (member name like 'EU'/'US' or full host URL); default: EU then US")
    p.add_argument("--max-days", type=int, default=DEFAULT_MAX_DAYS,
                   help=f"keep at most this many days of history (default: {DEFAULT_MAX_DAYS})")
    p.add_argument("--days", type=int, default=14,
                   help="mock mode: generate this many days of data (default: 14)")
    return p.parse_args(argv)


def load_existing(path: Path) -> dict[str, Any]:
    """Load the current store, or a minimal empty one if absent/corrupt."""
    empty: dict[str, Any] = {"readings": [], "last_updated": None, "sensor_id": None, "trend": None}
    if not path.exists():
        return empty
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or "readings" not in data:
            raise ValueError("missing 'readings' key")
        return data
    except (json.JSONDecodeError, ValueError) as e:
        # Never let a corrupt store take the pipeline down — start fresh but
        # keep the evidence in the log.
        log.warning("existing store unreadable (%s); starting fresh", e)
        return empty


def validate_reading(value: float, timestamp: str) -> bool:
    """Return True if the reading is plausible and usable."""
    if not (MIN_GLUCOSE_MGDL <= value <= MAX_GLUCOSE_MGDL):
        log.warning("dropping out-of-range reading %.1f mg/dL at %s", value, timestamp)
        return False
    return True


def merge_readings(existing: list[dict[str, Any]], fresh: list[dict[str, Any]],
                   max_days: int) -> list[dict[str, Any]]:
    """Dedup by ISO timestamp, sort ascending, cap to max_days."""
    by_ts: dict[str, dict[str, Any]] = {}
    for r in existing:
        by_ts[r["timestamp"]] = r
    for r in fresh:
        by_ts[r["timestamp"]] = r  # fresh wins on conflict

    readings = sorted(by_ts.values(), key=lambda r: r["timestamp"])
    if max_days and readings:
        cutoff = datetime.now(timezone.utc) - timedelta(days=max_days)
        readings = [r for r in readings if iso_to_dt(r["timestamp"]) >= cutoff]
    return readings


def iso_to_dt(ts: str) -> datetime:
    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def atomic_write(path: Path, data: dict[str, Any]) -> None:
    """Write JSON via a temp file + rename so a crash can't leave a half file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".glucose-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def reading_dict(value: float, timestamp: datetime) -> dict[str, Any]:
    return {
        "timestamp": timestamp.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "glucose": round(float(value), 1),
        "unit": "mg/dL",
    }


def resolve_regions(region: str | None) -> list[APIUrl]:
    """Turn a --region value (member name like 'EU' or a full host URL) into
    an ordered list of APIUrl members to try. Default: EU first, then US."""
    by_value = {u.value: u for u in APIUrl}
    if region:
        try:
            return [APIUrl[region.strip().upper()]]
        except KeyError:
            pass
        match = by_value.get(region.strip())
        if match:
            return [match]
        log.warning("unknown region %r; falling back to defaults", region)
    return [APIUrl.EU, APIUrl.US]


def fetch_live(data_path: Path, region: str | None, max_days: int) -> int:
    email = os.environ.get("LIBRELINK_EMAIL", "").strip()
    password = os.environ.get("LIBRELINK_PASSWORD", "").strip()
    if not email or not password:
        log.error("LIBRELINK_EMAIL / LIBRELINK_PASSWORD not set (refusing to guess)")
        return 2

    store = load_existing(data_path)

    client = None
    last_err: Exception | None = None
    regions = resolve_regions(region)
    for host in regions:
        try:
            c = PyLibreLinkUp(email=email, password=password, api_url=host)
            c.authenticate()
            client = c
            log.info("authenticated via %s", host.value)
            break
        except Exception as e:  # pylint: disable=broad-except
            last_err = e
            log.warning("auth failed via %s: %s", host.value, e)
    if client is None:
        log.error("LibreLinkUp auth failed on all regions (%s)", last_err)
        return 2

    try:
        patients = client.get_patients()
    except Exception as e:  # pylint: disable=broad-except
        log.error("get_patients failed: %s", e)
        return 2

    if not patients:
        # Account is authenticated but has no sensor connection linked yet.
        # Not a pipeline failure — keep existing data, report clearly.
        log.warning("account has 0 connected patients; no data to fetch (link the sensor in LibreLinkUp)")
        return 0

    patient = patients[0]
    fresh: list[dict[str, Any]] = []
    latest_value: float | None = None
    latest_ts: datetime | None = None
    trend: str | None = None

    try:
        graph = client.graph(patient_identifier=patient.patient_id)  # ~last 12h
        latest = client.latest(patient_identifier=patient.patient_id)
    except ValidationError as e:
        # Connection exists but the API reports no glucose measurements yet
        # (sensor not scanned since the follow was added, or still pending).
        # Transient — not a pipeline failure. Keep existing data.
        log.warning("connection present but no measurements yet (%s); scan the sensor with the LibreLink app", e.errors()[0].get("type") if e.errors() else "validation error")
        return 0
    except Exception as e:  # pylint: disable=broad-except
        log.error("graph/latest failed: %s", e)
        return 2

    for m in graph:
        ts = m.timestamp
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        if validate_reading(float(m.value_in_mg_per_dl), ts.isoformat()):
            fresh.append(reading_dict(m.value_in_mg_per_dl, ts))

    if latest is not None and latest.value_in_mg_per_dl:
        latest_value = float(latest.value_in_mg_per_dl)
        latest_ts = latest.timestamp
        if latest.trend is not None:
            trend = TREND_LABEL.get(latest.trend.name, latest.trend.name)

    merged = merge_readings(store.get("readings", []), fresh, max_days)
    store["readings"] = merged
    if merged:
        store["last_updated"] = max(r["timestamp"] for r in merged)
    if latest_ts is not None:
        store["last_updated"] = latest_ts.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    store["trend"] = trend
    store["sensor_id"] = store.get("sensor_id") or str(patient.patient_id)[:6].upper()

    atomic_write(data_path, store)
    log.info("wrote %d readings (%d fresh) to %s",
             len(merged), len(fresh), data_path)
    if latest_value is not None:
        log.info("latest: %.1f mg/dL at %s (%s)", latest_value, latest_ts, trend)
    return 0


def fetch_mock(data_path: Path, days: int, max_days: int) -> int:
    """Deterministic sample series so the dashboard renders without a sensor.

    Hourly readings for `days` days, wandering inside the cat target range
    (90-270) with a couple of hypo/hyper excursions, so every chart view has
    something meaningful to draw.
    """
    rng = random.Random(42)
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    start = now - timedelta(days=days - 1)

    readings: list[dict[str, Any]] = []
    glucose = 160.0
    t = start
    while t <= now:
        # random walk, clamped to the measurable range
        glucose += rng.uniform(-9, 9)
        # occasional excursions
        if rng.random() < 0.02:
            glucose += rng.uniform(-70, -40)  # hypo dip
        elif rng.random() < 0.03:
            glucose += rng.uniform(50, 90)  # hyper spike
        glucose = max(MIN_GLUCOSE_MGDL, min(MAX_GLUCOSE_MGDL, glucose))
        readings.append(reading_dict(glucose, t))
        t += timedelta(hours=1)

    store = {
        "readings": readings,
        "last_updated": readings[-1]["timestamp"],
        "sensor_id": MOCK_SENSOR_ID,
        "trend": "stable",
    }
    atomic_write(data_path, store)
    log.info("mock: wrote %d sample readings to %s", len(readings), data_path)
    return 0


def main(argv: list[str]) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = parse_args(argv)
    data_path = Path(args.data)

    if args.mock:
        return fetch_mock(data_path, args.days, args.max_days)
    return fetch_live(data_path, args.region, args.max_days)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
