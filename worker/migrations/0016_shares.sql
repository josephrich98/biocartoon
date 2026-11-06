-- Share links (src/shares.ts): a project encrypted in the app, kept in the private users bucket
-- under shares/<id>/. The key that decrypts it is only in the link, never sent here;
-- the edit and owner secrets are kept only as SHA-256 hashes.
CREATE TABLE shares (
    id          TEXT PRIMARY KEY,             -- random, 22 base64url characters
    edit_hash   TEXT NOT NULL,                -- SHA-256 of the edit secret (in edit links)
    owner_hash  TEXT NOT NULL,                -- SHA-256 of the owner secret (kept by the sharer's app)
    user_id     TEXT,                         -- the signed-in sharer, if any (higher limits; deleted with the account)
    ip_hash     TEXT NOT NULL,                -- salted hash of the sharer's address, for rate limiting only
    version     INTEGER NOT NULL,             -- the latest version
    bytes       INTEGER NOT NULL,             -- the latest version's size
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    last_used   TEXT NOT NULL                 -- last opened, checked or saved; idle shares expire
);
CREATE INDEX shares_ip ON shares (ip_hash, created_at);
CREATE INDEX shares_user ON shares (user_id);
CREATE INDEX shares_last_used ON shares (last_used);
-- The versions kept online (the latest few), so an overwrite can be undone.
CREATE TABLE share_versions (
    share_id    TEXT NOT NULL,
    version     INTEGER NOT NULL,
    bytes       INTEGER NOT NULL,
    blob        TEXT NOT NULL,                -- its object in the users bucket
    created_at  TEXT NOT NULL,
    PRIMARY KEY (share_id, version)
);
