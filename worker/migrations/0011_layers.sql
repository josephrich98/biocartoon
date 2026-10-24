-- The named colour layers of an SVG asset (a JSON array of {"name", "colors": ["#rrggbb", ...]}), as the
-- contributor named them in the app; published in the asset's sidecar and from there in the catalog's `layers`.
ALTER TABLE submissions ADD COLUMN layers TEXT NOT NULL DEFAULT '[]';
