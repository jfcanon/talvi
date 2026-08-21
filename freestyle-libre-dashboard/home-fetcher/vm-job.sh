#!/bin/bash
# Leoncito home fetcher — VM side (runs INSIDE the Lima VM).
# Reads VAR=value lines from stdin (piped by host-run.sh), runs
# fetch_glucose.py against LibreLinkUp from the VM's residential-egress
# network, and POSTs the fresh window to the Worker's /api/ingest.
# Only known variable names are accepted; nothing is echoed or logged.

set -euo pipefail

while IFS='=' read -r key value; do
  value="${value%$'\r'}"   # strip any CR
  case "$key" in
    LIBRELINK_EMAIL|LIBRELINK_PASSWORD|INGEST_TOKEN|INGEST_URL)
      export "$key=$value"
      ;;
    "") ;;                       # skip blank lines
    *) echo "vm-job: refusing unexpected stdin key: $key" >&2; exit 5 ;;
  esac
done

for v in LIBRELINK_EMAIL LIBRELINK_PASSWORD INGEST_TOKEN INGEST_URL; do
  [ -n "${!v:-}" ] || { echo "vm-job: missing $v on stdin" >&2; exit 5; }
done

cd ~/leoncito-fetcher
exec ./.venv/bin/python fetch_glucose.py \
  --data state/glucose.json \
  --ingest-url "$INGEST_URL"
