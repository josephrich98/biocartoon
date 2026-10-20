-- Optional accounts (src/accounts.ts): signing in with Google or GitHub keeps an online copy of
-- each project in the private users bucket, under users/<user id>/. No passwords are stored.
CREATE TABLE users (
    id          TEXT PRIMARY KEY,             -- random; also the bucket prefix
    provider    TEXT NOT NULL CHECK (provider IN ('google', 'github')),
    subject     TEXT NOT NULL,                -- the provider's stable id for the person
    email       TEXT NOT NULL DEFAULT '',     -- shown in the app's account menu
    name        TEXT NOT NULL DEFAULT '',
    ip_hash     TEXT NOT NULL,                -- salted hash of the sign-up address, for rate limiting only
    created_at  TEXT NOT NULL,
    last_seen   TEXT NOT NULL,
    UNIQUE (provider, subject)
);
CREATE INDEX users_ip ON users (ip_hash, created_at);
-- The app holds the token; only its SHA-256 is kept, so a leaked table can't sign anyone in.
CREATE TABLE sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    last_used   TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);
-- One row per online project; the file is users/<user_id>/projects/<id>.biocartoon.
CREATE TABLE cloud_projects (
    user_id     TEXT NOT NULL,
    id          TEXT NOT NULL,                -- the app's project id (a UUID)
    name        TEXT NOT NULL,
    modified    INTEGER NOT NULL,             -- the app's "last modified", Unix milliseconds
    bytes       INTEGER NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (user_id, id)
);
