#!/bin/bash
# Install / update / remove the weekly asset-sync LaunchAgent (com.$BRAND.asset-sync), and with
# --apply the publish poller (com.$BRAND.publish-poll), which every 5 minutes runs any publish
# queued with "Publish catalog now" on the review page (publish-poll.sh).
#
#   data/schedule/install.sh             weekly DRY RUN: reports what is new, changes nothing
#   data/schedule/install.sh --apply     weekly real sync: upload, insert, publish the catalog; + poller
#   data/schedule/install.sh --uninstall
#
# Renaming the product: `BRAND=old data/schedule/install.sh --uninstall`, then
# `BRAND=new data/schedule/install.sh [--apply]` (and update data/config.py's default).
# Schedule: Mondays 09:30 local; a slot missed while asleep runs on wake.
#
# The real sync needs R2 credentials, read from the env or the login Keychain:
#   for k in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
#     security add-generic-password -U -s "$BRAND-r2" -a "$k" -w; done   # prompts for each value
# The poller also needs the submit Worker's PUBLISH_TOKEN secret, stored the same way:
#   security add-generic-password -U -s "$BRAND-r2" -a PUBLISH_TOKEN -w
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
BRAND="${BRAND:-biocartoon}"
LABEL="com.$BRAND.asset-sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
POLL_LABEL="com.$BRAND.publish-poll"
POLL_PLIST="$HOME/Library/LaunchAgents/$POLL_LABEL.plist"
PY="${SYNC_PYTHON:-$(command -v python3)}"
MODE="dry-run"

case "${1:-}" in
  --apply) MODE="apply" ;;
  --uninstall)
    for l in "$LABEL" "$POLL_LABEL"; do
      launchctl bootout "gui/$(id -u)/$l" 2>/dev/null || true
      rm -f "$HOME/Library/LaunchAgents/$l.plist"
      echo "removed $l"
    done
    exit 0 ;;
  "") ;;
  *) echo "usage: $0 [--apply | --uninstall]" >&2; exit 64 ;;
esac

"$PY" -c "import boto3, cairosvg, PIL, requests" 2>/dev/null || DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib \
  "$PY" -c "import boto3, cairosvg, PIL, requests" || {
  echo "missing packages: $PY -m pip install -r data/requirements.txt (and brew install cairo)" >&2; exit 1; }

chmod +x "$HERE/asset-sync.sh"
mkdir -p "$(dirname "$PLIST")"
cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$HERE/asset-sync.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BRAND</key>
    <string>$BRAND</string>
    <key>SYNC_MODE</key>
    <string>$MODE</string>
    <key>SYNC_PYTHON</key>
    <string>$PY</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key>
    <integer>1</integer>
    <key>Hour</key>
    <integer>9</integer>
    <key>Minute</key>
    <integer>30</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$HOME/Library/Logs/$BRAND-asset-sync/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/$BRAND-asset-sync/launchd.err.log</string>
</dict>
</plist>
EOF
mkdir -p "$HOME/Library/Logs/$BRAND-asset-sync"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL ($MODE, Mondays 09:30) -> $PLIST"
echo "run now: launchctl kickstart -k gui/$(id -u)/$LABEL"

launchctl bootout "gui/$(id -u)/$POLL_LABEL" 2>/dev/null || true
if [ "$MODE" != "apply" ]; then
  rm -f "$POLL_PLIST"
  exit 0
fi
chmod +x "$HERE/publish-poll.sh"
cat >"$POLL_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$POLL_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$HERE/publish-poll.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BRAND</key>
    <string>$BRAND</string>
    <key>SYNC_PYTHON</key>
    <string>$PY</string>
  </dict>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$HOME/Library/Logs/$BRAND-asset-sync/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/$BRAND-asset-sync/launchd.err.log</string>
</dict>
</plist>
EOF
launchctl bootstrap "gui/$(id -u)" "$POLL_PLIST"
echo "installed $POLL_LABEL (every 5 minutes) -> $POLL_PLIST"
