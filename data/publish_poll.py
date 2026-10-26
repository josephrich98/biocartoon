"""Run the publishes queued with "Publish catalog now" on the review page.

The review page records a request in D1 (worker/src/publish_requests.ts); this claims it from the
submit Worker, runs publish_catalog.py against the master DB here, and reports how it went, which
the review page then shows. Run every few minutes by data/schedule/publish-poll.sh (installed by
data/schedule/install.sh --apply); does nothing when nothing is queued.

    python data/publish_poll.py

PUBLISH_TOKEN (the submit Worker's secret of that name) comes from the env or the Keychain item
service=<BRAND>-r2, account=PUBLISH_TOKEN, like the R2 credentials (upload_r2.credential).
Takes sync.py's lock, so it never publishes while the weekly sync is working on the master; when
the sync holds it, the request stays queued for the next poll.
"""
from __future__ import annotations

import fcntl
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

from config import PUBLISH_UA, SUBMIT_URL
from upload_r2 import credential

DATA = Path(__file__).resolve().parent
# What the review page shows of a run: these lines in full, plus the end of the output.
NOTABLE = ("skip ", "published ", "unchanged", "Traceback", "Error")
TAIL_LINES = 15


def call(path: str, token: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(f"{SUBMIT_URL.rstrip('/')}{path}", data=json.dumps(body or {}).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                                          "User-Agent": PUBLISH_UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def summary(output: str) -> str:
    lines = output.splitlines()
    notable = [ln for ln in lines[:-TAIL_LINES] if ln.lstrip().startswith(NOTABLE)]
    return "\n".join(notable + lines[-TAIL_LINES:])


def main() -> int:
    lock = open(DATA / ".sync.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return 0  # the weekly sync is running (and publishes too); try again next poll
    token = credential("PUBLISH_TOKEN")
    ids = call("/publish/claim", token)["ids"]
    if not ids:
        return 0
    print(f"publishing for request(s) {ids}", flush=True)
    r = subprocess.run([sys.executable, str(DATA / "publish_catalog.py")], capture_output=True, text=True)
    output = r.stdout + r.stderr
    print(output, flush=True)
    ok = r.returncode == 0
    call("/publish/finish", token, {"ids": ids, "ok": ok, "message": summary(output) or f"exit {r.returncode}"})
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
