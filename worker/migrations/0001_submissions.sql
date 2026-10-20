-- One row per contribution. Files live in the pending bucket under <id>/ until reviewed.
CREATE TABLE submissions (
    id          TEXT PRIMARY KEY,             -- slug; becomes user/<id> or templates/<id>
    kind        TEXT NOT NULL CHECK (kind IN ('asset', 'template')),
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category    TEXT NOT NULL DEFAULT '',
    author      TEXT NOT NULL,
    license     TEXT NOT NULL,
    files       TEXT NOT NULL,                -- JSON array of pending-bucket keys
    texts       TEXT NOT NULL DEFAULT '[]',   -- JSON array: text inside a template, for review
    width       INTEGER,
    height      INTEGER,
    bytes       INTEGER NOT NULL,
    png_sha256  TEXT,
    ip_hash     TEXT NOT NULL,                -- salted hash, for rate limiting only
    created_at  TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    reviewed_at TEXT,
    reviewed_by TEXT
);
CREATE INDEX submissions_ip ON submissions (ip_hash, created_at);
CREATE INDEX submissions_status ON submissions (status, created_at);
