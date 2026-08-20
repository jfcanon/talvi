#!/usr/bin/env python3
"""LibreRawParser — reference implementation for Abbott FreeStyle Libre 1/2 raw sensor payloads.

Decodes a raw FRAM byte stream retrieved over NFC (or via a BLE bridge that
mirrors the FRAM), applies the calibrated transformations that the community
has reverse-engineered, and emits a standardized JSON payload.

GROUND TRUTH / SOURCES
----------------------
* FRAM layout and ring buffers: vicktor/FreeStyleLibre-NFC-Reader wiki,
  jamorham/xDrip-plus NFCReaderX.java, JohanDegraeve/xdripswift LibreDataParser.swift
* 6-byte record bit offsets (raw glucose, quality, error, raw temperature,
  temperature adjustment): gui-dos/DiaBLE Libre.swift parseFRAM()
* OOP calibration (temperature-dependent slope/offset): UPetersen/LibreMonitor
  "Libre OOP Investigation" wiki
* Libre 2 NFC encryption caveat: xDrip+/AAPS docs (shared-key pairing race)

HARDWARE LIMITS — do not extend beyond the two physical signals.
The sensor measures only (1) a glucose-related electric current and (2) a
thermistor temperature inside interstitial fluid. It cannot measure blood
cells, lipids, cholesterol, mood, fat, or weight. Everything downstream of
raw glucose + raw temperature in this file is an *inference heuristic* and
is labeled as such in the output schema.

Design notes
------------
* Bit-level record parsing follows DiaBLE's readBits (LSB-first bit indexing).
* Raw temperature is a 12-bit field at bit offset 0x1a, shifted left 2 into
  a 14-bit word — equivalent to the LibreMonitor "swap bytes 3-4, mask 0x3FFF"
  view. The mask 0x3FFF is applied for both raw glucose and raw temperature.
* Calibration constants are per-sensor. This file ships a *mock* calibration
  (documented below) plus the optional temperature-dependent OOP form. Real
  sensors store their factory parameters in the FRAM footer (i1..i6); see
  parse_calibration_info(). Do not treat the shipped constants as universal.
* Libre 2 NFC scans: the sensor returns a raw glucose of 0 and reinterprets
  the temperature field as an RF-error code (e.g. 32) because the NFC antenna
  draw corrupts the current measurement. The last good readings live in the
  history buffer. The parser flags such records instead of producing garbage.

Usage
-----
    parser = LibreRawParser(fram_bytes, sensor_start_utc=datetime.now(timezone.utc))
    parser.parse()
    print(json.dumps(parser.output(), indent=2))

    # or from the CLI with the bundled example payload:
    python3 libre_raw_parser.py --self-test
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

# ---------------------------------------------------------------------------
# FRAM geometry (FreeStyle Libre 1 & 2) — verified byte offsets
# ---------------------------------------------------------------------------

FRAM_SIZE = 344                     # Libre 1/2 decrypted FRAM is 344 bytes

# Header
BYTE_STATE = 4                      # sensor state byte
BYTE_CRC_LO, BYTE_CRC_HI = 0, 1     # header CRC16 (CCITT), little-endian
BYTE_PATCH_INFO_LO, BYTE_PATCH_INFO_HI = 2, 3   # patch/type info

# Sensor time / life counter (little-endian)
BYTE_AGE_LO, BYTE_AGE_HI = 316, 317
MAX_LIFE_LO, MAX_LIFE_HI = 326, 327  # configured lifetime in minutes

# Ring-buffer write pointers (next block to be written)
BYTE_TREND_INDEX = 26
BYTE_HISTORY_INDEX = 27

# Buffers
TREND_START = 28                    # 16 records x 6 bytes -> bytes 28..123
TREND_COUNT = 16                    # 1-minute interval, ~last 15 min
HISTORY_START = 124                 # 32 records x 6 bytes -> bytes 124..315
HISTORY_COUNT = 32                  # 15-minute interval, ~last 8 h
RECORD_SIZE = 6

# Calibration info in FRAM footer (DiaBLE CalibrationInfo extraction)
CAL_BYTE = 2                        # i1 (3 bits), i2 (10 bits)
CAL_FOOTER = 0x150                  # 336: i3, i4, i5, i6

# Glucose range (LibreLinkUp measurable range; LO/HI sentinels)
GLUCOSE_LO = 39                     # "LO" sentinel
GLUCOSE_HI = 501                    # "HI" sentinel (upper bound)
GLUCOSE_MIN_VALID = 40.0
GLUCOSE_MAX_VALID = 500.0

# ---------------------------------------------------------------------------
# Mock calibration constants — see notes above; per-sensor values vary widely.
# ---------------------------------------------------------------------------
# Simple linear: glucose = slope * raw_glucose + offset.
# LibreMonitor: "slope = 0.13, offset = -20 mostly work fine".
MOCK_SLOPE = 0.13
MOCK_OFFSET = -20.0

# Temperature-dependent OOP form (LibreMonitor "main example" sensor):
#   slope(raw_temp)  = SLOPE_SLOPE * raw_temp + SLOPE_OFFSET
#   offset(raw_temp) = OFFSET_SLOPE * raw_temp + OFFSET_OFFSET
MOCK_SLOPE_SLOPE = 0.000015623
MOCK_SLOPE_OFFSET = 0.0017457
MOCK_OFFSET_SLOPE = -0.0002327
MOCK_OFFSET_OFFSET = -19.47

# Raw temperature (thermistor counts) -> Celsius, linear two-point community
# calibration. Fit through the LibreMonitor OOP-investigation observations:
#   raw 7124 -> ~25 C (room), raw 5816 -> ~37 C (warm). Inverse relationship.
# NOT an Abbott transfer function — per-sensor recalibration recommended.
TEMP_CAL_A = -0.009174            # dC per raw count
TEMP_CAL_B = 90.36                # intercept C

# Inference thresholds (heuristics, not sensor measurements)
ROC_EAT_SPIKE = 2.5               # mg/dL/min sustained rise -> possible intake
ROC_DRIFT = 0.5                   # mg/dL/min below this = baseline drift
EAT_RISE_WINDOW_MIN = 30          # cumulative rise window (minutes)
EAT_RISE_MIN_MGDL = 30            # cumulative rise to confirm an event
EAT_SUSTAIN_MIN = 10              # minutes the spike must hold
SPIKE_RISE_STRESS_MGDL = 50       # unlogged rise this large -> flag "unlogged spike"
CV_FLATLINE = 0.03                # glucose coefficient of variation -> "flat"
REST_WINDOW_MIN = 60              # sleep/wake heuristic window


# ---------------------------------------------------------------------------
# Bit-level reader (ported from DiaBLE readBits — LSB-first bit ordering)
# ---------------------------------------------------------------------------

def read_bits(buf: bytes, byte_offset: int, bit_offset: int, bit_count: int) -> int:
    """Read `bit_count` bits starting at (byte_offset, bit_offset), LSB-first.

    Matches DiaBLE's readBits exactly: each source bit is extracted with
    ``((byte >> (bit & 7)) & 1) << i``. Parentheses are load-bearing here —
    Python binds shifts tighter than ``&``, unlike Swift, so a naive port
    silently returns wrong values.
    """
    res = 0
    for i in range(bit_count):
        bit = bit_offset + i
        byte = buf[byte_offset + (bit >> 3)]
        res |= ((byte >> (bit & 0x7)) & 0x1) << i
    return res


def crc16_ccitt(data: bytes) -> int:
    """CRC-16/CCITT-FALSE over the header bytes (DiaBLE-compatible)."""
    crc = 0xFFFF
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


# ---------------------------------------------------------------------------
# Sensor state byte decoding (state byte at FRAM[4])
# ---------------------------------------------------------------------------

class SensorState:
    NOT_ACTIVATED = 0
    EXPIRING = 1
    ACTIVE = 2
    EXPIRED = 3
    SHUTDOWN = 4
    FAILURE = 5
    UNKNOWN = 0xFF

    NAMES = {
        NOT_ACTIVATED: "not_activated",
        EXPIRING: "expiring",
        ACTIVE: "active",
        EXPIRED: "expired",
        SHUTDOWN: "shutdown",
        FAILURE: "failure",
        UNKNOWN: "unknown",
    }

    @classmethod
    def name(cls, value: int) -> str:
        return cls.NAMES.get(value, cls.NAMES[cls.UNKNOWN])


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------

@dataclass
class SensorInfo:
    uid: Optional[str] = None
    sensor_type: str = "libre"
    region: str = "unknown"
    state: str = "unknown"
    age_minutes: int = 0
    max_life_minutes: int = 0
    state_byte_raw: int = 0


@dataclass
class Calibration:
    """Per-sensor calibration parameters.

    mode == "simple"  -> glucose = slope * raw + offset
    mode == "oop"     -> glucose = slope(raw_temp) * raw + offset(raw_temp)
                         with slope/offset themselves linear in raw_temp
    source is "mock" for the bundled example constants, "sensor_footer" when
    parsed from the FRAM footer i1..i6, or "user" for operator overrides.
    """
    mode: str = "simple"
    source: str = "mock"
    slope: float = MOCK_SLOPE
    offset: float = MOCK_OFFSET
    slope_slope: float = MOCK_SLOPE_SLOPE
    slope_offset: float = MOCK_SLOPE_OFFSET
    offset_slope: float = MOCK_OFFSET_SLOPE
    offset_offset: float = MOCK_OFFSET_OFFSET
    temp_a: float = TEMP_CAL_A
    temp_b: float = TEMP_CAL_B

    def glucose_from_raw(self, raw_glucose: int, raw_temperature: int) -> float:
        if self.mode == "oop":
            slope = self.slope_slope * raw_temperature + self.slope_offset
            offset = self.offset_slope * raw_temperature + self.offset_offset
        else:
            slope, offset = self.slope, self.offset
        return slope * raw_glucose + offset

    def celsius_from_raw(self, raw_temperature: int) -> float:
        return self.temp_a * raw_temperature + self.temp_b


@dataclass
class GlucoseRecord:
    """One decoded 6-byte trend/history record."""
    sensor_time_minutes: int
    timestamp_utc: datetime
    glucose_raw: int
    glucose_mgdl: Optional[float]
    temperature_raw: int
    temperature_celsius: Optional[float]
    temperature_adjustment: int
    quality: int
    quality_flags: str
    has_error: bool
    corrupted: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "sensor_time_minutes": self.sensor_time_minutes,
            "timestamp": self.timestamp_utc.isoformat().replace("+00:00", "Z"),
            "glucose_raw": self.glucose_raw,
            "glucose_mgdl": self.glucose_mgdl,
            "temperature_raw": self.temperature_raw,
            "temperature_celsius": self.temperature_celsius,
            "temperature_adjustment": self.temperature_adjustment,
            "quality": self.quality,
            "quality_flags": self.quality_flags,
            "has_error": self.has_error,
            "corrupted": self.corrupted,
        }


# ---------------------------------------------------------------------------
# The parser
# ---------------------------------------------------------------------------

class LibreRawParser:
    """Parse a raw FreeStyle Libre 1/2 FRAM byte stream into a JSON payload."""

    def __init__(
        self,
        fram: bytes,
        sensor_start_utc: Optional[datetime] = None,
        calibration: Optional[Calibration] = None,
        sensor_uid: Optional[str] = None,
        region: str = "unknown",
    ) -> None:
        if len(fram) < FRAM_SIZE:
            raise ValueError(
                f"FRAM too short: got {len(fram)} bytes, need >= {FRAM_SIZE}"
            )
        self.fram = fram[:FRAM_SIZE]
        # Absolute start time of the sensor. If unknown, records are emitted
        # with relative sensor_time only (timestamp_utc = None).
        self.sensor_start_utc = sensor_start_utc or datetime.now(timezone.utc)
        self.calibration = calibration or Calibration()
        self.sensor_uid = sensor_uid
        self.region = region

        self.sensor: SensorInfo = SensorInfo()
        self.trend: list[GlucoseRecord] = []
        self.history: list[GlucoseRecord] = []
        self.metrics: dict[str, Any] = {}
        self.validation: dict[str, Any] = {}
        self._calibration_info: dict[str, int] = {}

    # -- FRAM decoding ----------------------------------------------------

    def _parse_header(self) -> None:
        buf = self.fram
        self.sensor.state_byte_raw = buf[BYTE_STATE]
        self.sensor.state = SensorState.name(buf[BYTE_STATE])
        self.sensor.age_minutes = (
            buf[BYTE_AGE_LO] | (buf[BYTE_AGE_HI] << 8)
        )
        self.sensor.max_life_minutes = (
            buf[MAX_LIFE_LO] | (buf[MAX_LIFE_HI] << 8)
        )
        patch = buf[BYTE_PATCH_INFO_LO] | (buf[BYTE_PATCH_INFO_HI] << 8)
        # Community patch-info decode: bits select family/model/region.
        # Full mapping is firmware-specific; keep the raw value plus a
        # conservative family guess.
        self.sensor.sensor_type = "libre2" if (patch & 0x0F00) else "libre1"
        self.sensor.region = self.region or "unknown"
        self.sensor.uid = self.sensor_uid

    def _parse_calibration_info(self) -> None:
        """Extract per-sensor factory calibration params from the FRAM footer.

        Mirrors DiaBLE CalibrationInfo. Mapping of these to slope/offset is
        not fully public; we expose the raw values and leave the calibrated
        glucose on the mock constants unless the operator supplies real ones.
        """
        buf = self.fram
        i1 = read_bits(buf, CAL_BYTE, 0, 3)
        i2 = read_bits(buf, CAL_BYTE, 3, 0xA)
        i3 = read_bits(buf, CAL_FOOTER, 0, 8)
        neg_i3 = read_bits(buf, CAL_FOOTER, 0x21, 1) != 0
        i4 = read_bits(buf, CAL_FOOTER, 8, 0xE)
        i5 = read_bits(buf, CAL_FOOTER, 0x28, 0xC) << 2
        i6 = read_bits(buf, CAL_FOOTER, 0x34, 0xC) << 2
        self._calibration_info = {
            "i1": i1, "i2": i2, "i3": -i3 if neg_i3 else i3, "i4": i4,
            "i5": i5, "i6": i6,
        }

    def _decode_record(self, offset: int, sensor_time: int) -> GlucoseRecord:
        buf = self.fram
        raw_glucose = read_bits(buf, offset, 0, 0xE)          # 14 bits
        quality = read_bits(buf, offset, 0xE, 0xB) & 0x1FF     # 11 bits
        has_error = read_bits(buf, offset, 0x19, 0x1) != 0      # 1 bit
        raw_temp = read_bits(buf, offset, 0x1A, 0xC) << 2       # 12 bits -> 14-bit word
        temp_adj = read_bits(buf, offset, 0x26, 0x9) << 2       # 9 bits
        if read_bits(buf, offset, 0x2F, 0x1):                   # sign bit
            temp_adj = -temp_adj

        ts = self._time_at(sensor_time)

        # Quality flag decoding (best-effort, community-sourced).
        qflags = []
        if quality == 0 and has_error:
            qflags.append("ERROR")
        elif has_error:
            qflags.append("PARTIAL")
        if raw_glucose == 0:
            qflags.append("ZERO")
        if not qflags:
            qflags.append("OK")

        # Libre 2 NFC corruption caveat: a raw glucose of 0 with an error code
        # in the temperature field is the NFC-antenna artifact, not a reading.
        corrupted = (raw_glucose == 0 and (has_error or raw_temp < 40))

        glucose_mgdl = None
        if not corrupted and not has_error and raw_glucose > 0:
            glucose_mgdl = self.calibration.glucose_from_raw(raw_glucose, raw_temp)

        temp_celsius = None
        if not corrupted:
            temp_celsius = self.calibration.celsius_from_raw(raw_temp)

        return GlucoseRecord(
            sensor_time_minutes=sensor_time,
            timestamp_utc=ts,
            glucose_raw=raw_glucose,
            glucose_mgdl=glucose_mgdl,
            temperature_raw=raw_temp,
            temperature_celsius=temp_celsius,
            temperature_adjustment=temp_adj,
            quality=quality,
            quality_flags=",".join(qflags),
            has_error=has_error,
            corrupted=corrupted,
        )

    def _time_at(self, sensor_time_minutes: int) -> datetime:
        """Absolute wall-clock for a sensor-time minute offset."""
        return self.sensor_start_utc + timedelta(minutes=sensor_time_minutes)

    def _parse_ring(
        self, start: int, count: int, write_index: int,
        interval_minutes: int, kind: str,
    ) -> list[GlucoseRecord]:
        """Read a ring buffer of `count` 6-byte records.

        The write pointer (byte 26/27) marks the *next* slot to be written, so
        the newest record sits one slot before it. Records are returned oldest
        -> newest.
        """
        records: list[GlucoseRecord] = []
        age = self.sensor.age_minutes
        for i in range(count):
            slot = write_index - 1 - i
            if slot < 0:
                slot += count
            offset = start + slot * RECORD_SIZE
            if kind == "history":
                # History is committed every 15 min but delivered ~3 min late
                # (xDripswift dateOfMostRecentHistoryValue).
                m = max(0, ((age - 3) // interval_minutes) * interval_minutes - i * interval_minutes)
            else:
                m = max(0, age - i * interval_minutes)
            records.append(self._decode_record(offset, m))
        return records

    def parse(self) -> "LibreRawParser":
        self._parse_header()
        self._parse_calibration_info()
        self.trend = self._parse_ring(
            TREND_START, TREND_COUNT, self.fram[BYTE_TREND_INDEX], 1, "trend"
        )
        self.history = self._parse_ring(
            HISTORY_START, HISTORY_COUNT, self.fram[BYTE_HISTORY_INDEX], 15, "history"
        )
        self._compute_metrics()
        self._validate()
        return self

    # -- Derived metrics (STEP 1: math logic) -----------------------------

    @staticmethod
    def _velocity(records: list[GlucoseRecord]) -> tuple[float, list[float]]:
        """First derivative (mg/dL/min) over consecutive valid records.

        Uses 1-min deltas where available (trend buffer); falls back to
        15-min deltas /15 for history. Returns (latest_roc, roc_series).
        """
        roc: list[float] = []
        prev: GlucoseRecord | None = None
        for r in records:
            if r.corrupted or r.glucose_mgdl is None:
                prev = None
                continue
            if prev is not None:
                dt_min = max(1, r.sensor_time_minutes - prev.sensor_time_minutes)
                roc.append((r.glucose_mgdl - prev.glucose_mgdl) / dt_min)
            prev = r
        latest = roc[-1] if roc else 0.0
        return latest, roc

    def _smooth(self, roc_series: list[float], window: int = 5) -> list[float]:
        """Simple trailing moving average — damps single-point noise."""
        if not roc_series:
            return []
        out = []
        for i, v in enumerate(roc_series):
            lo = max(0, i - window + 1)
            out.append(sum(roc_series[lo:i + 1]) / (i - lo + 1))
        return out

    def _compute_metrics(self) -> None:
        cal = self.calibration

        # Latest valid glucose (prefer trend, else history).
        latest: GlucoseRecord | None = None
        for r in reversed(self.trend):
            if not r.corrupted and r.glucose_mgdl is not None:
                latest = r
                break
        if latest is None:
            for r in reversed(self.history):
                if not r.corrupted and r.glucose_mgdl is not None:
                    latest = r
                    break

        glucose_now = latest.glucose_mgdl if latest else None

        # Temperature from the freshest non-corrupt trend record.
        temp_rec = next((r for r in reversed(self.trend) if not r.corrupted), None)
        temp_raw = temp_rec.temperature_raw if temp_rec else None
        temp_c = temp_rec.temperature_celsius if temp_rec else None

        # Glucose velocity on the 1-min trend.
        roc, roc_series = self._velocity(self.trend)
        roc_smoothed = self._smooth(roc_series)
        roc_now = roc_smoothed[-1] if roc_smoothed else roc

        # --- Eating-event heuristic --------------------------------------
        # Sharp, sustained upward movement in the 1-min trend vs baseline
        # drift. This is an inference, not a sensor measurement.
        eating = False
        spike_note = None
        if len(self.trend) >= EAT_SUSTAIN_MIN:
            sustained = sum(1 for v in roc_smoothed if v >= ROC_EAT_SPIKE)
            rise = 0.0
            if glucose_now and len(self.trend) >= 2:
                rise = glucose_now - self.trend[0].glucose_mgdl if self.trend[0].glucose_mgdl else 0.0
            if sustained >= EAT_SUSTAIN_MIN and rise >= EAT_RISE_MIN_MGDL:
                eating = True

        # --- Sleep / wake heuristic --------------------------------------
        # Rest is inferred from low glucose variance (flat line) combined with
        # a thermistor drop; movement verification requires an external
        # 3-axis accelerometer (smartwatch/collar) — API input outlined below.
        sleep = False
        window = [r.glucose_mgdl for r in self.trend if r.glucose_mgdl is not None]
        cv = None
        if len(window) >= 6:
            mean = sum(window) / len(window)
            var = sum((x - mean) ** 2 for x in window) / len(window)
            std = math.sqrt(var)
            cv = std / mean if mean else 0.0
        if cv is not None and cv < CV_FLATLINE and temp_c is not None:
            # Flat glucose + cooler tissue than the active baseline.
            if temp_c < 30.0:
                sleep = True

        # --- Unlogged spike (stress check) -------------------------------
        # A large, fast rise with no food logged cannot be attributed to
        # intake by the sensor. We flag the *pattern* as an unlogged spike —
        # never as "stress", because the sensor cannot measure cortisol.
        unlogged_spike = False
        if glucose_now and len(self.trend) >= 2:
            first = self.trend[0].glucose_mgdl
            if first is not None and glucose_now - first >= SPIKE_RISE_STRESS_MGDL and not eating:
                unlogged_spike = True

        # --- Trend arrow (mirror LibreLinkUp labels) ---------------------
        if roc_now is None:
            arrow = "n/a"
        elif roc_now >= 2.0:
            arrow = "rising fast"
        elif roc_now >= 0.5:
            arrow = "rising"
        elif roc_now <= -2.0:
            arrow = "falling fast"
        elif roc_now <= -0.5:
            arrow = "falling"
        else:
            arrow = "stable"

        hypo = glucose_now is not None and glucose_now < 70.0
        hyper = glucose_now is not None and glucose_now > 270.0

        self.metrics = {
            "temperature_raw": temp_raw,
            "temperature_celsius": round(temp_c, 2) if temp_c is not None else None,
            "glucose_current_mgdl": round(glucose_now, 1) if glucose_now is not None else None,
            "glucose_velocity_mgdl_per_min": round(roc_now, 2),
            "glucose_velocity_mgdl_per_hour": round(roc_now * 60, 1),
            "trend_arrow": arrow,
            "glucose_cv_window": round(cv, 4) if cv is not None else None,
            "flags": {
                "eating_event": eating,
                "sleep": sleep,
                "wake": (sleep is False),
                "unlogged_spike": unlogged_spike,
                "hypo": hypo,
                "hyper": hyper,
            },
        }

    def _validate(self) -> None:
        header = self.fram[BYTE_CRC_LO] | (self.fram[BYTE_CRC_HI] << 8)
        # DiaBLE computes the header CRC over bytes 2..317 (the two CRC bytes
        # at the front are excluded).
        computed = crc16_ccitt(self.fram[2:BYTE_AGE_LO + 2])
        errors = sum(1 for r in self.trend + self.history if r.has_error)
        corrupted = sum(1 for r in self.trend + self.history if r.corrupted)
        out_of_range = sum(
            1 for r in self.trend + self.history
            if r.glucose_mgdl is not None
            and not (GLUCOSE_MIN_VALID <= r.glucose_mgdl <= GLUCOSE_MAX_VALID)
        )
        self.validation = {
            "header_crc16_ok": header == computed,
            "header_crc16_read": header,
            "header_crc16_computed": computed,
            "records_with_error_flag": errors,
            "records_corrupted": corrupted,
            "glucose_out_of_range": out_of_range,
        }

    # -- Output (STEP 3: standardized JSON schema) ------------------------

    def output(self) -> dict[str, Any]:
        cal = self.calibration
        cal_out: dict[str, Any] = {
            "source": cal.source,
            "mode": cal.mode,
            "temperature": {"a": cal.temp_a, "b": cal.temp_b},
            "glucose_simple": {"slope": cal.slope, "offset": cal.offset},
        }
        if cal.mode == "oop":
            cal_out["glucose_oop"] = {
                "slope_slope": cal.slope_slope,
                "slope_offset": cal.slope_offset,
                "offset_slope": cal.offset_slope,
                "offset_offset": cal.offset_offset,
            }
        return {
            "schema_version": "1.0.0",
            "parser": "LibreRawParser",
            "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "sensor": {
                "uid": self.sensor.uid,
                "type": self.sensor.sensor_type,
                "region": self.sensor.region,
                "state": self.sensor.state,
                "state_byte_raw": self.sensor.state_byte_raw,
                "age_minutes": self.sensor.age_minutes,
                "max_life_minutes": self.sensor.max_life_minutes,
                "life_left_days": round(
                    (self.sensor.max_life_minutes - self.sensor.age_minutes) / 1440, 1
                ) if self.sensor.max_life_minutes else None,
                "factory_calibration_params": self._calibration_info,
                "calibration": cal_out,
            },
            "metrics": self.metrics,
            "trend": {
                "interval_minutes": 1,
                "count": len(self.trend),
                "records": [r.to_dict() for r in self.trend],
            },
            "history": {
                "interval_minutes": 15,
                "count": len(self.history),
                "records": [r.to_dict() for r in self.history],
            },
            "validation": self.validation,
            # Out-of-scope metrics: the sensor cannot chemically read these.
            # Schema for external devices (smart scale / lab work) below.
            "out_of_scope": {
                "note": "Fat, weight, calories, mood, cholesterol, and blood-cell "
                        "counts are NOT measurable by this sensor (current + "
                        "temperature only).",
                "external_sources_schema": [
                    {
                        "metric": "weight_kg", "source": "smart_scale",
                        "type": "number", "unit": "kg",
                    },
                    {
                        "metric": "fat_percent", "source": "smart_scale",
                        "type": "number", "unit": "%",
                    },
                    {
                        "metric": "cholesterol_total_mgdl", "source": "lab_work",
                        "type": "number", "unit": "mg/dL",
                    },
                    {
                        "metric": "blood_cell_counts", "source": "lab_work",
                        "type": "object",
                        "fields": ["rbc", "wbc", "hemoglobin"],
                    },
                    {
                        "metric": "calories_kcal", "source": "food_tracker",
                        "type": "number", "unit": "kcal",
                    },
                    {
                        "metric": "mood", "source": "user_log",
                        "type": "string", "enum": ["low", "neutral", "good"],
                    },
                ],
            },
        }


# ---------------------------------------------------------------------------
# CLI / self-test
# ---------------------------------------------------------------------------

def build_example_fram(rng_seed: int = 7) -> bytes:
    """Build a deterministic synthetic FRAM for --self-test.

    Not a real sensor dump — exercises every code path with a plausible
    344-byte payload (state byte, ring pointers, records with glucose,
    temperature, error flags, footer calibration fields).
    """
    import random
    rng = random.Random(rng_seed)
    fram = bytearray([0]) * FRAM_SIZE

    fram[BYTE_STATE] = SensorState.ACTIVE
    fram[BYTE_AGE_LO] = 0x20
    fram[BYTE_AGE_HI] = 0x30            # age = 0x3020 = 12320 min (~8.6 days)
    fram[MAX_LIFE_LO], fram[MAX_LIFE_HI] = 0xE0, 0x4E  # 20160 min = 14 days

    fram[BYTE_PATCH_INFO_LO], fram[BYTE_PATCH_INFO_HI] = 0x00, 0x10  # libre2-ish
    fram[BYTE_TREND_INDEX] = 12
    fram[BYTE_HISTORY_INDEX] = 3

    def write_record(base: int, raw_glucose: int, raw_temp: int,
                     temp_adj: int = 0, error: bool = False) -> None:
        v = raw_glucose & 0x3FFF
        # The 12-bit temp field stores the TOP 12 bits of the 14-bit raw
        # temperature word (DiaBLE reads it back as `readBits(...) << 2`).
        t_field = (raw_temp >> 2) & 0xFFF
        a_field = (temp_adj >> 2) & 0x1FF
        # pack 14-bit glucose (bits 0-13), 11-bit quality (bits 14-24),
        # error bit (25), 12-bit temp (bits 26-37), 9-bit adj (bits 38-46),
        # sign (47)
        for i in range(48):
            bit_val = 0
            if i < 14:
                bit_val = (v >> i) & 1
            elif i < 25:
                bit_val = 0  # quality 0
            elif i == 25:
                bit_val = 1 if error else 0
            elif i < 38:
                bit_val = (t_field >> (i - 26)) & 1   # 12 temp bits: i=26..37
            elif i < 47:
                bit_val = (a_field >> (i - 38)) & 1   # 9 adjustment bits: i=38..46
            elif i == 47:
                bit_val = 1 if temp_adj < 0 else 0
            byte_idx = base + (i >> 3)
            fram[byte_idx] |= bit_val << (i & 7)

    # Trend: 16 records, 1-min apart; a rising run then flat.
    base_g = 900
    for i in range(TREND_COUNT):
        raw_g = base_g + (4 * i)      # +4 raw counts/min -> rising
        raw_t = 6900 - (i * 5)        # slightly cooling
        error = i == 0                # first slot: a deliberately errored record
        write_record(TREND_START + i * RECORD_SIZE, raw_g, raw_t, 0, error)

    # History: 32 records, 15-min apart, wandering around 1000-1200 raw.
    for i in range(HISTORY_COUNT):
        raw_g = 1000 + int(80 * math.sin(i / 3)) + rng.randint(-10, 10)
        raw_t = 7000 - i
        write_record(HISTORY_START + i * RECORD_SIZE, raw_g, raw_t)

    # Footer calibration params (i1..i6) at the DiaBLE offsets.
    def write_bits(base: int, bit_off: int, count: int, value: int) -> None:
        for k in range(count):
            b = base + ((bit_off + k) >> 3)
            fram[b] |= ((value >> k) & 1) << ((bit_off + k) & 7)

    write_bits(CAL_BYTE, 0, 3, 0b101)
    write_bits(CAL_BYTE, 3, 10, 0b0101010101)
    write_bits(CAL_FOOTER, 0, 8, 90)
    write_bits(CAL_FOOTER, 0x21, 1, 1)       # negative i3
    write_bits(CAL_FOOTER, 8, 14, 4000)
    write_bits(CAL_FOOTER, 0x28, 12, 500)
    write_bits(CAL_FOOTER, 0x34, 12, 300)

    # Header CRC16 over bytes 2..317 (CRC bytes excluded), like DiaBLE.
    # Computed last: the header region includes the trend/history buffers.
    crc = crc16_ccitt(fram[2:BYTE_AGE_LO + 2])
    fram[BYTE_CRC_LO], fram[BYTE_CRC_HI] = crc & 0xFF, (crc >> 8) & 0xFF

    return bytes(fram)


def self_test() -> int:
    fram = build_example_fram()
    start = datetime(2026, 8, 20, 12, 0, tzinfo=timezone.utc)
    parser = LibreRawParser(
        fram,
        sensor_start_utc=start,
        calibration=Calibration(mode="oop", source="mock"),
        sensor_uid="EXAMPLE-UID",
        region="EU",
    )
    parser.parse()
    out = parser.output()
    print(json.dumps(out, indent=2, default=str))
    print("\n--- validation ---")
    print(json.dumps(parser.validation, indent=2))
    return 0


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--self-test", action="store_true",
                   help="run on a deterministic synthetic FRAM and print JSON")
    p.add_argument("--fram", type=str, default=None,
                   help="path to a raw 344-byte FRAM dump (hex or raw binary)")
    p.add_argument("--start", type=str, default=None,
                   help="sensor start time ISO-8601 (default: now)")
    args = p.parse_args(argv)

    if args.self_test or (args.fram is None):
        return self_test()

    data = open(args.fram, "rb").read()
    if len(data) == FRAM_SIZE * 2 and all(c in "0123456789abcdefABCDEF" for c in data.decode()):
        data = bytes.fromhex(data.decode())
    start = datetime.fromisoformat(args.start.replace("Z", "+00:00")) if args.start else None
    parser = LibreRawParser(data, sensor_start_utc=start)
    parser.parse()
    print(json.dumps(parser.output(), indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
