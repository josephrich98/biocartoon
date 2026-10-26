-- Your library online (src/accounts.ts): a signed-in user's own icons, saved templates and
-- favorites, one JSON file each at users/<user_id>/library/<id>.json. They count towards the same
-- online space as projects.
CREATE TABLE cloud_library (
    user_id     TEXT NOT NULL,
    id          TEXT NOT NULL,                -- "asset.<slug>", "template.<slug>" or "favorites"
    modified    INTEGER NOT NULL,             -- the app's "last modified", Unix milliseconds
    bytes       INTEGER NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (user_id, id)
);
