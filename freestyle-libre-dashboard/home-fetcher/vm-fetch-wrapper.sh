#!/bin/bash
# Leoncito VM fetch wrapper — runs INSIDE the Lima VM.
# Reads Bitwarden master password from libsecret keyring, unlocks vault,
# pulls credentials, and runs fetch_glucose.py --ingest-url.
# Designed to run from cron every 15 min.

set -euo pipefail

# Configuration — adjust item names if your vault differs
LIBRE_EMAIL_ITEM="LIBRELINK_EMAIL_2"
LIBRE_PASSWORD_ITEM="LIBRELINK_PASSWORD_2"
TOKEN_ITEM="Leoncito ingest token"
INGEST_URL="https://app.ygdcbtmc4u.uk/api/ingest"
KEYRING_LABEL="leoncito-bitwarden-master"
KEYRING_ATTR="service"
KEYRING_VALUE="leoncito-fetcher"

LOG_FILE="/home/nahuelavalos.guest/leoncito-fetcher/state/vm-fetch.log"

log() {
    printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"$LOG_FILE"
}

# Get master password from keyring
get_master_password() {
    secret-tool lookup "$KEYRING_ATTR" "$KEYRING_VALUE" 2>/dev/null || {
        log "ERROR: Master password not found in keyring. Run setup-vm-secrets.sh first."
        return 1
    }
}

# Verify we can unlock with the password
verify_bw_unlock() {
    local pw="$1"
    BW_PASSWORD="$pw" bw unlock --passwordenv BW_PASSWORD --raw >/dev/null 2>&1
}

main() {
    log "=== Starting VM fetch run ==="

    # 1. Get master password from keyring
    MASTER_PW="$(get_master_password)" || exit 1

    # 2. Verify it works (catches typo/rotation)
    if ! verify_bw_unlock "$MASTER_PW"; then
        log "ERROR: Master password from keyring failed to unlock Bitwarden."
        exit 1
    fi

    # 3. Unlock and get session
    export BW_PASSWORD="$MASTER_PW"
    BW_SESSION="$(bw unlock --passwordenv BW_PASSWORD --raw 2>/dev/null || true)"
    unset BW_PASSWORD

    if [ -z "$BW_SESSION" ]; then
        log "ERROR: bw unlock returned empty session"
        exit 1
    fi

    # 4. Sync vault (required before reads)
    bw sync --session "$BW_SESSION" >/dev/null

    # 5. Resolve credentials from vault (using list+filter for reliability)
    ITEMS_JSON="$(bw list items --session "$BW_SESSION")"

    jget() {
        printf '%s' "$ITEMS_JSON" |
        jq -r --arg n "$1" --arg f "$2" '.[] | select(.name == $n) | .login[$f] // empty' | head -1
    }

    EMAIL="$(jget "$LIBRE_EMAIL_ITEM" username)"
    [ -z "$EMAIL" ] && EMAIL="$(jget "$LIBRE_EMAIL_ITEM" password)"

    PASS="$(jget "$LIBRE_PASSWORD_ITEM" password)"
    [ -z "$PASS" ] && PASS="$(jget "$LIBRE_PASSWORD_ITEM" username)"

    TOKEN="$(jget "$TOKEN_ITEM" password)"

    if [ -z "$EMAIL" ] || [ -z "$PASS" ] || [ -z "$TOKEN" ]; then
        log "ERROR: One or more credentials missing from vault"
        exit 1
    fi

    unset ITEMS_JSON

    # 6. Run fetch_glucose.py with credentials via environment
    cd /home/nahuelavalos.guest/leoncito-fetcher
    log "Running fetch_glucose.py --ingest-url $INGEST_URL"

    LIBRELINK_EMAIL="$EMAIL" \
    LIBRELINK_PASSWORD="$PASS" \
    INGEST_TOKEN="$TOKEN" \
    /home/nahuelavalos.guest/leoncito-fetcher/.venv/bin/python fetch_glucose.py \
        --data state/glucose.json \
        --ingest-url "$INGEST_URL" \
        --ingest-token-env INGEST_TOKEN 2>&1 | while IFS= read -r line; do
        log "$line"
    done

    RC=${PIPESTATUS[0]}
    log "=== Fetch run complete (exit $RC) ==="
    exit "$RC"
}

main "$@"