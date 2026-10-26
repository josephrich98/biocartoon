-- Stars: anyone using the app can star a catalog asset (once per app install, the "client").
-- `stars.n` is the live count the app shows and publish_catalog.py bakes into the catalog.
CREATE TABLE stars (
    asset_id    TEXT PRIMARY KEY,             -- catalog `assets.id`, e.g. BA000123
    n           INTEGER NOT NULL DEFAULT 0
);
-- One row per (asset, client), kept when unstarred (`on` = 0) so toggling back and forth
-- neither double counts nor creates rows; new rows are what the per-address quota counts.
CREATE TABLE starred (
    asset_id    TEXT NOT NULL,
    client      TEXT NOT NULL,                -- random id the app made on first run
    "on"        INTEGER NOT NULL DEFAULT 1,
    ip_hash     TEXT NOT NULL,                -- salted hash, for rate limiting only
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (asset_id, client)
);
CREATE INDEX starred_ip ON starred (ip_hash, created_at);
CREATE INDEX starred_client ON starred (client);
