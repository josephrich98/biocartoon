#!/bin/bash
# Every 5 minutes (installed by install.sh --apply as a launchd LaunchAgent): run any publish queued
# with "Publish catalog now" on the review page (data/publish_poll.py). Quiet when nothing is queued.
#
# Run by hand:   data/schedule/publish-poll.sh
# Log:           ~/Library/Logs/$BRAND-asset-sync/publish-poll.log
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
DATA="$(dirname "$HERE")"
BRAND="${BRAND:-biocartoon}"
PY="${SYNC_PYTHON:-$(command -v python3)}"

# Same environment as asset-sync.sh: cairosvg finds Homebrew's libcairo only via the fallback path.
export PATH="$(dirname "$PY"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export DYLD_FALLBACK_LIBRARY_PATH="/opt/homebrew/lib:/usr/local/lib:/usr/lib"
export LANG="en_US.UTF-8" PYTHONUNBUFFERED=1 BRAND

LOG_DIR="$HOME/Library/Logs/$BRAND-asset-sync"
LOG="$LOG_DIR/publish-poll.log"
mkdir -p "$LOG_DIR"
[ -f "$LOG" ] && [ "$(stat -f %z "$LOG")" -gt 5000000 ] && mv "$LOG" "$LOG.1"

out="$("$PY" "$DATA/publish_poll.py" 2>&1)"
rc=$?
[ -n "$out" ] && printf '=== %s (exit %d)\n%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$rc" "$out" >>"$LOG"
if [ $rc -ne 0 ]; then
  osascript -e "display notification \"see $LOG\" with title \"$BRAND publish FAILED (exit $rc)\"" >/dev/null 2>&1 || true
elif [ -n "$out" ]; then
  osascript -e "display notification \"requested from the review page\" with title \"$BRAND catalog published\"" >/dev/null 2>&1 || true
fi
exit $rc
