#!/bin/bash
# Scheduled run of data/sync.py (installed by install.sh as a launchd LaunchAgent).
#
# Run by hand:   data/schedule/asset-sync.sh            (mode from $SYNC_MODE, default dry-run)
# Force the job: launchctl kickstart -k gui/$(id -u)/com.$BRAND.asset-sync
# Logs:          ~/Library/Logs/$BRAND-asset-sync/      reports: data/sync-reports/
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
DATA="$(dirname "$HERE")"
BRAND="${BRAND:-biocartoon}"
PY="${SYNC_PYTHON:-$(command -v python3)}"
MODE="${SYNC_MODE:-dry-run}"   # dry-run | apply

# launchd gives a bare PATH; cairosvg finds Homebrew's libcairo only via the fallback path.
export PATH="$(dirname "$PY"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export DYLD_FALLBACK_LIBRARY_PATH="/opt/homebrew/lib:/usr/local/lib:/usr/lib"
export LANG="en_US.UTF-8" PYTHONUNBUFFERED=1 BRAND

LOG_DIR="$HOME/Library/Logs/$BRAND-asset-sync"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$(date +%Y-%m-%d_%H%M%S)-$MODE.log"
find "$LOG_DIR" -name '*.log' -mtime +180 -delete 2>/dev/null

notify() {  # title, message
  osascript -e "display notification \"$2\" with title \"$1\"" >/dev/null 2>&1 || true
}

args=()
[ "$MODE" = "apply" ] && args+=(--apply)
"$PY" "$DATA/sync.py" ${args[@]+"${args[@]}"} "$@" >"$LOG" 2>&1
rc=$?

summary="$(grep '^SUMMARY:' "$LOG" | tail -1 | sed 's/^SUMMARY: //')"
new="$(grep -c '^    + ' "$LOG")"
case $rc in
  0) [ "$MODE" = "apply" ] && [ "${summary%% *}" != "0" ] && notify "$BRAND asset sync" "$summary"
     [ "$MODE" != "apply" ] && [ "$new" -gt 0 ] && notify "$BRAND asset sync (dry run)" "$new new upstream assets found; see $LOG" ;;
  2) notify "$BRAND asset sync: needs a look" "${summary:-see log}; $LOG" ;;
  *) notify "$BRAND asset sync FAILED (exit $rc)" "$LOG" ;;
esac
exit $rc
