-- Upload keys that can be shared (src/upload_keys.ts). The `UPLOAD_KEY` secret stays the master key:
-- it makes, lists and revokes these, and can update any upload. A shared key gets the master key's
-- daily limit, and with scope 'own' updates only uploads submitted with it ('all': any upload).
CREATE TABLE upload_keys (
  id          TEXT PRIMARY KEY,
  key_hash    TEXT NOT NULL UNIQUE,     -- sha256 hex of the key; the key itself is shown once
  label       TEXT NOT NULL,            -- who it is for
  scope       TEXT NOT NULL DEFAULT 'own',
  created_at  TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at  TEXT
);

-- `biocartoon upload --update ID`: the approved asset this submission is a new version of. On
-- approval it is published under its own id, its sidecar lists the ids it replaces, and the catalog
-- gives it the catalog id (UG/BC number) of what it replaces (data/uploads.py, publish_catalog.py).
ALTER TABLE submissions ADD COLUMN replaces TEXT;
-- Set on an approved asset when an update of it is approved (cleared if that is undone).
ALTER TABLE submissions ADD COLUMN replaced_by TEXT;
-- The shared upload key it came with ('master' for the UPLOAD_KEY secret; NULL without a key).
ALTER TABLE submissions ADD COLUMN key_id TEXT;
