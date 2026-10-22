-- An optional contact email on submissions and suggestions, for reviewers only: it is shown on the
-- review page and never published. Suggestions also gain the kind 'other' ("Submit an idea" in the
-- app asks for anything, not just icons and templates); SQLite can't alter a CHECK, so the table
-- is rebuilt.
ALTER TABLE submissions ADD COLUMN email TEXT NOT NULL DEFAULT '';

CREATE TABLE suggestions_new (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('icon', 'template', 'other')),
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    name        TEXT NOT NULL DEFAULT '',     -- optional, as the sender gave it
    email       TEXT NOT NULL DEFAULT '',     -- optional, private to reviewers
    ip_hash     TEXT NOT NULL,                -- salted hash, for rate limiting only
    created_at  TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
    reviewed_at TEXT,
    reviewed_by TEXT
);
INSERT INTO suggestions_new (id, kind, title, description, name, ip_hash, created_at, status, reviewed_at, reviewed_by)
    SELECT id, kind, title, description, name, ip_hash, created_at, status, reviewed_at, reviewed_by FROM suggestions;
DROP TABLE suggestions;
ALTER TABLE suggestions_new RENAME TO suggestions;
CREATE INDEX suggestions_ip ON suggestions (ip_hash, created_at);
CREATE INDEX suggestions_status ON suggestions (status, created_at);
