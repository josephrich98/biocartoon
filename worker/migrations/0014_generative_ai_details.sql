-- How generative AI was used, in the contributor's words (optional; only when they said AI was used).
-- Published in an asset's sidecar and a template's meta as `generative_ai_details`.
ALTER TABLE submissions ADD COLUMN generative_ai_details TEXT NOT NULL DEFAULT '';
