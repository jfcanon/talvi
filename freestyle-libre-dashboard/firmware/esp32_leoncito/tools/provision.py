#!/usr/bin/env python3
"""Provision the Leoncito ESP32 over USB serial.

Reads values from environment variables and sends `set` commands to the
firmware console — secrets travel Mac->USB->NVS and never touch disk/git.

Env vars (any subset): WIFI_SSID, WIFI_PASS, LLU_EMAIL, LLU_PASS,
INGEST_TOKEN, INGEST_URL, LLU_REGION, POLL_S.

Usage: provision.py [--port /dev/cu.usbmodem101] [--show] [extra raw commands...]
"""
import argparse
import os
import sys
import time

import serial

ENV_TO_KEY = [
    ("WIFI_SSID", "wifi_ssid"), ("WIFI_PASS", "wifi_pass"),
    ("LLU_EMAIL", "llu_email"), ("LLU_PASS", "llu_pass"),
    ("INGEST_TOKEN", "ingest_token"), ("INGEST_URL", "ingest_url"),
    ("LLU_REGION", "region"), ("POLL_S", "poll_s"),
]
SECRET_KEYS = {"wifi_pass", "llu_pass", "ingest_token", "llu_email"}


def send(ser, line, quiet=False):
    shown = line
    parts = line.split(" ", 2)
    if len(parts) == 3 and parts[0] == "set" and parts[1] in SECRET_KEYS:
        shown = f"set {parts[1]} ********"
    print(f">>> {shown}")
    ser.write((line + "\n").encode())
    time.sleep(0.6)
    out = ser.read(ser.in_waiting or 1).decode(errors="replace")
    if not quiet:
        print(out, end="")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default="/dev/cu.usbmodem101")
    ap.add_argument("--show", action="store_true")
    ap.add_argument("commands", nargs="*")
    args = ap.parse_args()

    ser = serial.Serial(args.port, 115200, timeout=1)
    time.sleep(2.5)  # board may reset on port open
    ser.reset_input_buffer()

    for env, key in ENV_TO_KEY:
        val = os.environ.get(env, "").strip()
        if val:
            send(ser, f"set {key} {val}", quiet=key in SECRET_KEYS)
    for cmd in args.commands:
        send(ser, cmd)
        time.sleep(1.5)
        print(ser.read(ser.in_waiting or 1).decode(errors="replace"), end="")
    if args.show:
        send(ser, "show")
        send(ser, "status")
    ser.close()


if __name__ == "__main__":
    sys.exit(main())
