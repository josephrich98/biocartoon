-- "Publish catalog now" on the review page (src/publish_requests.ts). The Mac that holds the master
-- DB polls for requests (data/publish_poll.py), runs publish_catalog.py and reports back here.
-- status: requested -> running -> done | failed
CREATE TABLE publish_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requested_at TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested',
  started_at TEXT,
  finished_at TEXT,
  message TEXT NOT NULL DEFAULT ''
);
CREATE INDEX publish_requests_status ON publish_requests (status);
