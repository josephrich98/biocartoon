-- Requests from the app's "Submit a suggestion" form for an icon or template the library lacks.
-- Nothing is published from here: a reviewer reads them and marks them done.
CREATE TABLE suggestions (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('icon', 'template')),
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    name        TEXT NOT NULL DEFAULT '',     -- optional, as the sender gave it
    ip_hash     TEXT NOT NULL,                -- salted hash, for rate limiting only
    created_at  TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
    reviewed_at TEXT,
    reviewed_by TEXT
);
CREATE INDEX suggestions_ip ON suggestions (ip_hash, created_at);
CREATE INDEX suggestions_status ON suggestions (status, created_at);
