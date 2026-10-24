-- Requests from the app's "Request removal from BioCartoon library" popup, by the uploader or
-- anyone else. Nothing is removed from here: a reviewer reads them, takes the icon down if they
-- agree (Undo on its approval, or data/upload_blocklist.txt), and marks them done.
CREATE TABLE removal_requests (
    id          TEXT PRIMARY KEY,
    asset_id    TEXT NOT NULL,                -- the catalog id the app sent (unchecked)
    title       TEXT NOT NULL DEFAULT '',     -- the icon's title, as the app showed it
    reason      TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',     -- optional, as the sender gave it
    email       TEXT NOT NULL DEFAULT '',     -- optional, private to reviewers
    ip_hash     TEXT NOT NULL,                -- salted hash, for rate limiting only
    created_at  TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
    reviewed_at TEXT,
    reviewed_by TEXT
);
CREATE INDEX removal_requests_ip ON removal_requests (ip_hash, created_at);
CREATE INDEX removal_requests_status ON removal_requests (status, created_at);
