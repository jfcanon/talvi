"""Regression tests for LibreLinkUp timestamp handling (run: python -m unittest scripts/test_fetch_glucose_timestamps.py).

LibreLinkUp's `Timestamp` is the account's LOCAL wall clock (naive) while
`FactoryTimestamp` is UTC. Treating the local one as UTC shifted every reading
3 h early for a Buenos Aires account (2026-08-22).
"""
import sys
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_glucose import measurement_utc  # noqa: E402

UTC = timezone.utc


class MeasurementUtcTest(unittest.TestCase):
    def test_prefers_factory_timestamp_utc(self):
        m = SimpleNamespace(
            factory_timestamp=datetime(2026, 8, 22, 4, 1, 53, tzinfo=UTC),
            timestamp=datetime(2026, 8, 22, 1, 1, 53),  # ART wall clock, naive
        )
        self.assertEqual(measurement_utc(m), datetime(2026, 8, 22, 4, 1, 53, tzinfo=UTC))

    def test_naive_factory_timestamp_is_utc(self):
        m = SimpleNamespace(factory_timestamp=datetime(2026, 8, 22, 4, 1, 53), timestamp=datetime(2026, 8, 22, 1, 1, 53))
        self.assertEqual(measurement_utc(m), datetime(2026, 8, 22, 4, 1, 53, tzinfo=UTC))

    def test_naive_local_timestamp_treated_as_art_when_no_factory(self):
        m = SimpleNamespace(timestamp=datetime(2026, 8, 22, 1, 1, 53))
        self.assertEqual(measurement_utc(m), datetime(2026, 8, 22, 4, 1, 53, tzinfo=UTC))

    def test_aware_timestamp_respected(self):
        aware = datetime(2026, 8, 22, 1, 1, 53, tzinfo=timezone(timedelta(hours=-3)))
        m = SimpleNamespace(timestamp=aware)
        self.assertEqual(measurement_utc(m), datetime(2026, 8, 22, 4, 1, 53, tzinfo=UTC))


if __name__ == "__main__":
    unittest.main()
