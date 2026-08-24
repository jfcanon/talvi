#!/bin/bash
# Leoncito VM secrets setup — run ONCE inside the Lima VM.
# Stores the Bitwarden master password in the libsecret keyring
# so the cron wrapper can unlock the vault non-interactively.

set -euo pipefail

KEYRING_LABEL="leoncito-bitwarden-master"
KEYRING_ATTR="service"
KEYRING_VALUE="leoncito-fetcher"

echo "=== Leoncito VM Secrets Setup ==="
echo ""
echo "This script stores your Bitwarden MASTER PASSWORD in the VM's"
echo "libsecret keyring (gnome-keyring backend). The cron wrapper"
echo "will read it from there to unlock the vault automatically."
echo ""
echo "IMPORTANT: This is for your lab environment. For production/VPS,"
echo "use a proper secrets manager (1Password Connect, Doppler, Vault, etc.)"
echo ""

# Verify we can unlock with the provided password before storing
read -rsp "Enter Bitwarden MASTER PASSWORD (hidden): " BW_PW
echo ""

if ! BW_PASSWORD="$BW_PW" bw unlock --passwordenv BW_PASSWORD --raw >/dev/null 2>&1; then
    echo "✗ That password did not unlock the vault — nothing stored"
    exit 1
fi

echo "✓ Password verified — unlocks vault successfully"

# Store in keyring
# secret-tool store --label="label" attribute value
# The password is passed via stdin (secure)
printf '%s' "$BW_PW" | secret-tool store --label="$KEYRING_LABEL" "$KEYRING_ATTR" "$KEYRING_VALUE"

unset BW_PW

# Verify we can read it back
STORED="$(secret-tool lookup "$KEYRING_ATTR" "$KEYRING_VALUE" 2>/dev/null || true)"
if [ -n "$STORED" ]; then
    echo "✓ Master password stored in keyring (attribute: $KEYRING_ATTR=$KEYRING_VALUE)"
    echo ""
    echo "Next steps:"
    echo "  1. Test the wrapper:  bash ~/leoncito-fetcher/vm-fetch-wrapper.sh"
    echo "  2. Check log:         tail -f ~/leoncito-fetcher/state/vm-fetch.log"
    echo "  3. Install cron:      crontab -e  (add the line below)"
    echo ""
    echo "Cron entry (every 15 min):"
    echo "  */15 * * * * /home/nahuelavalos.guest/leoncito-fetcher/vm-fetch-wrapper.sh"
else
    echo "✗ Failed to read back from keyring — something went wrong"
    exit 1
fi