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
# ~/.leoncito-fetcher/bin) or in a repo checkout (running from a clone).
if [ -f "$SCRIPT_DIR/fetch_glucose.py" ]; then
  SRC_DIR="$SCRIPT_DIR"
elif [ -f "$HOME/.leoncito-fetcher/bin/fetch_glucose.py" ]; then
  SRC_DIR="$HOME/.leoncito-fetcher/bin"
else
  SRC_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)/freestyle-libre-dashboard"
fi
[ -f "$SRC_DIR/fetch_glucose.py" ] || { echo "fetch_glucose.py not found (looked in $SCRIPT_DIR, ~/.leoncito-fetcher/bin, repo)" >&2; exit 4; }
VM_STATE="$HOME/.leoncito-fetcher"
mkdir -p "$VM_STATE"
LOG="$VM_STATE/host.log"

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"$LOG"; }

# Never let a failure kill the log write; always exit non-zero visibly.
trap 'log "FAILED (exit $?)"' ERR

# ---------------------------------------------------------------------------
# 1. Resolve an unlocked Bitwarden session (in-memory only).
#    Order: existing BW_SESSION env → cached session in Keychain → full
#    unlock (Keychain master pw → BW_PASSWORD env). A valid bw session key
#    stays valid for a long time, so the cached path avoids the flaky
#    headless unlock on every tick.
# ---------------------------------------------------------------------------
session_valid() { bw status --session "$1" 2>/dev/null | grep -q '"status":"unlocked"'; }

if [ -z "${BW_SESSION:-}" ] || ! session_valid "$BW_SESSION"; then
  BW_SESSION=""
  if security find-generic-password -s leoncito-bw-session >/dev/null 2>&1; then
    BW_SESSION="$(security find-generic-password -s leoncito-bw-session -w || true)"
  fi
fi

if [ -z "$BW_SESSION" ] || ! session_valid "$BW_SESSION"; then
  BW_SESSION=""
  if security find-generic-password -s leoncito-bitwarden >/dev/null 2>&1; then
    BW_PASSWORD="$(security find-generic-password -s leoncito-bitwarden -w)"
    # script(1) gives bw a pseudo-TTY: under launchd/cron stdin is not a TTY
    # and bw's interactive unlock aborts (rc=1, empty key). The pty also
    # pads/echoes noise around the session key — extract just the base64
    # token (last long run) rather than joining everything. The unlock is
    # occasionally flaky headless → retry.
    for _ in 1 2 3; do
      # '|| true': an empty capture makes grep exit 1, which would otherwise
      # kill the script via set -e before the retry ever runs.
      BW_SESSION="$(script -q /dev/null bw unlock --passwordenv BW_PASSWORD --raw 2>/dev/null \
        | tr -d '\r' | sed 's/\x1b\[[0-9;]*[a-zA-Z]//g' | tr -d '\b' \
        | grep -Eo '[A-Za-z0-9+/=]{40,}' | tail -1 || true)"
      if [ -n "$BW_SESSION" ] && session_valid "$BW_SESSION"; then break; fi
      BW_SESSION=""
      sleep 2
    done
    unset BW_PASSWORD
  elif [ -n "${BW_PASSWORD:-}" ]; then
    BW_SESSION="$(bw unlock --passwordenv BW_PASSWORD --raw || true)"
  fi
  # Refresh the cached session so subsequent ticks skip unlocking entirely.
  if [ -n "$BW_SESSION" ]; then
    security delete-generic-password -s leoncito-bw-session >/dev/null 2>&1 || true
    security add-generic-password -s leoncito-bw-session -a "$USER" -w "$BW_SESSION" -A
  fi
fi

[ -n "$BW_SESSION" ] || { log "no unlocked Bitwarden session available"; exit 4; }
# This bw build exits 0 with empty output even on an invalid session —
# verify the session actually unlocked (a mistyped Keychain password
# surfaces here as 'decryption operation failed').
if ! session_valid "$BW_SESSION"; then
  log "Bitwarden session invalid and unlock failed — run ~/.leoncito-fetcher/finish-keychain.sh"
  exit 4
fi

# The CLI serves a local cache — sync before any read, every run.
bw sync --session "$BW_SESSION" >/dev/null

# NOTE: this bw build's `bw get <field> <item>` name-lookup can answer
# "Not found." for items that `bw list items` clearly shows — so resolve
# everything from one list call via jq instead.
ITEMS_JSON="$(bw list items --session "$BW_SESSION")"
jget() { # jget <item-name> <login-field>
  printf '%s' "$ITEMS_JSON" \
    | jq -r --arg n "$1" --arg f "$2" \
        '.[] | select(.name == $n) | .login[$f] // empty' | head -1
}
# Some vault items keep the value in the other login field — accept either.
jfirst() { # jfirst <item-name> <preferred-field> <fallback-field>
  local v
  v="$(jget "$1" "$2")"
  if [ -z "$v" ] && [ -n "${3:-}" ]; then v="$(jget "$1" "$3")"; fi
  printf '%s' "$v"
}

# Round-trip sanity: all three items must resolve before touching the VM.
EMAIL="$(jfirst "$LIBRE_EMAIL_ITEM" username password)"     || { log "bw item missing: $LIBRE_EMAIL_ITEM"; exit 4; }
PASS="$(jfirst "$LIBRE_PASSWORD_ITEM" password username)"   || { log "bw item missing: $LIBRE_PASSWORD_ITEM"; exit 4; }
TOKEN="$(jget "$TOKEN_ITEM" password)"                      || { log "bw item missing: $TOKEN_ITEM"; exit 4; }
[ -n "$EMAIL" ] && [ -n "$PASS" ] && [ -n "$TOKEN" ] || { log "empty credential(s) from Bitwarden"; exit 4; }
unset ITEMS_JSON

# ---------------------------------------------------------------------------
# 2. Ensure the Lima VM is running (idempotent).
# ---------------------------------------------------------------------------
if ! limactl list -f '{{.Name}} {{.Status}}' 2>/dev/null | grep -q "^$VM_NAME Running$"; then
  limactl start "$VM_NAME" >/dev/null
fi

# ---------------------------------------------------------------------------
# 3. Sync code + ensure Python venv inside the VM (cheap no-ops when current).
# ---------------------------------------------------------------------------
limactl shell "$VM_NAME" -- sh -c 'mkdir -p ~/leoncito-fetcher/state'
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
  .venv/bin/pip install --quiet --disable-pip-version-check \
    $(grep -v "^#" requirements.txt | tr "\n" " ")
'

# ---------------------------------------------------------------------------
# 4. Pipe secrets over stdin into the VM job (not argv, not files).
# ---------------------------------------------------------------------------
log "running fetch+ingest in VM $VM_NAME"
set +e
printf 'LIBRELINK_EMAIL=%s\nLIBRELINK_PASSWORD=%s\nINGEST_TOKEN=%s\nINGEST_URL=%s\n' \
  "$EMAIL" "$PASS" "$TOKEN" "$INGEST_URL" \
| limactl shell "$VM_NAME" -- bash -c 'cd ~/leoncito-fetcher && exec bash vm-job.sh'
RC=$?
set -e

unset EMAIL PASS TOKEN
log "done rc=$RC"
exit "$RC"
