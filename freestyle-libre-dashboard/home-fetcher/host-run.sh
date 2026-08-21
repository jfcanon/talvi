#!/bin/bash
# Leoncito home fetcher — HOST side (macOS).
#
# Runs every 15 min from launchd (or crontab): pulls credentials from
# Bitwarden, ensures the Lima VM is up, syncs the fetch scripts into it, and
# pipes the secrets over stdin (never argv, never disk) to vm-job.sh inside
# the VM, which runs fetch_glucose.py --ingest-url and POSTs the fresh window
# to the Worker's /api/ingest.
#
# Exit codes: 0 ok · non-zero = something failed (see launchd stderr log).
# Designed to be idempotent and safe to re-run at any cadence.

set -euo pipefail

# launchd runs agents with a minimal PATH (/usr/bin:/bin:...) — restore the
# Homebrew tooling this script needs (bw, limactl).
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

VM_NAME="${LEONCITO_LIMA_VM:-agente}"
LIBRE_EMAIL_ITEM="${LEONCITO_BW_LIBRE_EMAIL_ITEM:-LIBRELINK_EMAIL_2}"
LIBRE_PASSWORD_ITEM="${LEONCITO_BW_LIBRE_PASSWORD_ITEM:-LIBRELINK_PASSWORD_2}"
TOKEN_ITEM="${LEONCITO_BW_TOKEN_ITEM:-Leoncito ingest token}"
INGEST_URL="${LEONCITO_INGEST_URL:-https://app.ygdcbtmc4u.uk/api/ingest}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Source files live either next to this script (durable install in
# ~/.leoncito-fetcher/bin) or in the repo checkout (running from a clone).
if [ -f "$SCRIPT_DIR/fetch_glucose.py" ]; then
  SRC_DIR="$SCRIPT_DIR"
else
  SRC_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)/freestyle-libre-dashboard"
fi
[ -f "$SRC_DIR/fetch_glucose.py" ] || { log "fetch_glucose.py not found next to $0"; exit 4; }
VM_STATE="$HOME/.leoncito-fetcher"
mkdir -p "$VM_STATE"
LOG="$VM_STATE/host.log"

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"$LOG"; }

# Never let a failure kill the log write; always exit non-zero visibly.
trap 'log "FAILED (exit $?)"' ERR

# ---------------------------------------------------------------------------
# 1. Resolve an unlocked Bitwarden session (in-memory only).
#    Order: existing BW_SESSION → macOS Keychain master pw → BW_PASSWORD env.
# ---------------------------------------------------------------------------
if [ -z "${BW_SESSION:-}" ] || ! bw status --session "$BW_SESSION" 2>/dev/null | grep -q '"status":"unlocked"'; then
  BW_SESSION=""
  if security find-generic-password -s leoncito-bitwarden >/dev/null 2>&1; then
    BW_PASSWORD="$(security find-generic-password -s leoncito-bitwarden -w)"
    BW_SESSION="$(bw unlock --passwordenv BW_PASSWORD --raw)"
    unset BW_PASSWORD
  elif [ -n "${BW_PASSWORD:-}" ]; then
    BW_SESSION="$(bw unlock --passwordenv BW_PASSWORD --raw)"
  fi
fi
[ -n "$BW_SESSION" ] || { log "no unlocked Bitwarden session available"; exit 4; }

# The CLI serves a local cache — sync before any get, every run.
bw sync --session "$BW_SESSION" >/dev/null

bwget() { # bwget <field> <item>
  bw get "$1" "$2" --session "$BW_SESSION"
}

# Round-trip sanity: all three items must resolve before touching the VM.
EMAIL="$(bwget username "$LIBRE_EMAIL_ITEM")"   || { log "bw item missing: $LIBRE_EMAIL_ITEM"; exit 4; }
PASS="$(bwget password "$LIBRE_PASSWORD_ITEM")" || { log "bw item missing: $LIBRE_PASSWORD_ITEM"; exit 4; }
TOKEN="$(bwget password "$TOKEN_ITEM")"         || { log "bw item missing: $TOKEN_ITEM"; exit 4; }
[ -n "$EMAIL" ] && [ -n "$PASS" ] && [ -n "$TOKEN" ] || { log "empty credential(s) from Bitwarden"; exit 4; }

# ---------------------------------------------------------------------------
# 2. Ensure the Lima VM is running (idempotent).
# ---------------------------------------------------------------------------
if ! limactl list -f '{{.Name}} {{.Status}}' 2>/dev/null | grep -q "^$VM_NAME Running$"; then
  limactl start "$VM_NAME" >/dev/null
fi

# ---------------------------------------------------------------------------
# 3. Sync code + ensure Python venv inside the VM (cheap no-ops when current).
# ---------------------------------------------------------------------------
limactl shell "$VM_NAME" -- mkdir -p ~/leoncito-fetcher/state
for f in fetch_glucose.py vm-job.sh; do
  limactl cp "$SRC_DIR/$f" "$VM_NAME:leoncito-fetcher/$f"
done
limactl shell "$VM_NAME" -- bash -c '
  set -e
  cd ~/leoncito-fetcher
  if [ ! -x .venv/bin/python ]; then
    sudo apt-get update -qq && sudo apt-get install -y -qq python3-venv
    python3 -m venv .venv
  fi
  # deps of scripts/fetch_glucose.py (see ../scripts + repo requirements.txt)
  .venv/bin/pip install --quiet --disable-pip-version-check pylibrelinkup pydantic
'

# ---------------------------------------------------------------------------
# 4. Pipe secrets over stdin into the VM job (not argv, not files).
# ---------------------------------------------------------------------------
log "running fetch+ingest in VM $VM_NAME"
set +e
printf 'LIBRELINK_EMAIL=%s\nLIBRELINK_PASSWORD=%s\nINGEST_TOKEN=%s\nINGEST_URL=%s\n' \
  "$EMAIL" "$PASS" "$TOKEN" "$INGEST_URL" \
| limactl shell "$VM_NAME" -- bash ~/leoncito-fetcher/vm-job.sh
RC=$?
set -e

unset EMAIL PASS TOKEN
log "done rc=$RC"
exit "$RC"
