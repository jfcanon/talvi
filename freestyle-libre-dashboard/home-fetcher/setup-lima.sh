#!/bin/bash
# Leoncito home fetcher — ONE-TIME setup on the home Mac.
#
# Verifies prerequisites, bootstraps the Lima VM job directory + venv,
# installs the launchd agent (every 15 min), and stores the Bitwarden master
# password in the macOS Keychain so scheduled runs can unlock the vault
# non-interactively. Idempotent: safe to re-run.
#
# Prereqs already on this machine: limactl (agente VM), docker NOT required,
# bw CLI logged in once interactively, gh not needed here.

set -euo pipefail

VM_NAME="${LEONCITO_LIMA_VM:-agente}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"   # talvi repo root
VM_STATE="$HOME/.leoncito-fetcher"
PLIST_LABEL="io.talvi.leoncito-fetcher"
mkdir -p "$VM_STATE"

echo "== 1/5 Lima VM '$VM_NAME'"
limactl list 2>/dev/null | grep -q "^$VM_NAME " || {
  echo "Lima VM '$VM_NAME' not found. Create one first: limactl start --name=$VM_NAME template://ubuntu-lts"; exit 1;
}
limactl list 2>/dev/null | grep -q "^$VM_NAME Running" || limactl start "$VM_NAME"

echo "== 2/5 Syncing fetch scripts into the VM"
limactl shell "$VM_NAME" -- mkdir -p ~/leoncito-fetcher/state
for f in scripts/fetch_glucose.py requirements.txt home-fetcher/vm-job.sh; do
  limactl cp "$REPO_DIR/freestyle-libre-dashboard/$f" \
    "$VM_NAME:leoncito-fetcher/$(basename "$f")"
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
echo "   venv ready in VM"

echo "== 3/5 Bitwarden master password → macOS Keychain"
if security find-generic-password -s leoncito-bitwarden >/dev/null 2>&1; then
  echo "   already stored (service: leoncito-bitwarden)"
else
  echo "   Enter the Bitwarden MASTER PASSWORD (input hidden; stored in your login keychain):"
  read -rs BW_PW
  # Verify BEFORE storing — a typo here silently breaks every scheduled run.
  if ! BW_PASSWORD="$BW_PW" script -q /dev/null bw unlock --passwordenv BW_PASSWORD --raw >/dev/null 2>&1; then
    echo "   ✗ that password did not unlock the vault — nothing stored"; exit 1
  fi
  # -w takes the password as an ARGUMENT (never pipe it); -A trusts all local
  # apps so the launchd agent can read the item headlessly.
  security add-generic-password -s leoncito-bitwarden -a "$USER" -w "$BW_PW" -A
  unset BW_PW
  echo "   stored (verified)."
fi

echo "== 4/5 Required Bitwarden items present?"
BW_PASSWORD="$(security find-generic-password -s leoncito-bitwarden -w)"
BW_SESSION="$(BW_PASSWORD="$(security find-generic-password -s leoncito-bitwarden -w)" \
  script -q /dev/null bw unlock --passwordenv BW_PASSWORD --raw 2>/dev/null | tr -d '\r')"
unset BW_PASSWORD
bw sync --session "$BW_SESSION" >/dev/null
while IFS='|' read -r field item; do
  [ -n "$field" ] || continue
  if bw get "$field" "$item" --session "$BW_SESSION" >/dev/null 2>&1; then
    echo "   OK: $item"
  else
    echo "   MISSING: $item — create it in Bitwarden before the first run"
  fi
done <<'ITEMS'
username|LIBRELINK_EMAIL_2
password|LIBRELINK_PASSWORD_2
password|Leoncito ingest token
ITEMS
bw lock >/dev/null 2>&1 || true

echo "== 5/5 Installing launchd agent ($PLIST_LABEL, every 15 min)"
cat >"$VM_STATE/$PLIST_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$PLIST_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$SCRIPT_DIR/host-run.sh</string>
  </array>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$VM_STATE/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$VM_STATE/launchd.err.log</string>
  <key>Nice</key><integer>10</integer>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/$PLIST_LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$VM_STATE/$PLIST_LABEL.plist"

echo
echo "Setup complete. The agent runs at login + every 15 min."
echo "  Run now:        bash \"$SCRIPT_DIR/host-run.sh\""
echo "  Data/status:    curl -s https://app.ygdcbtmc4u.uk/api/status"
echo "  Host log:       tail -f $VM_STATE/host.log"
echo "  VM data:        limactl shell $VM_NAME -- cat ~/leoncito-fetcher/state/glucose.json"
