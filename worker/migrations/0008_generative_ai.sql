-- Whether generative AI made a submission: 0 when the contributor checked "No generative AI was
-- used", 1 when the app knew AI made it, NULL when they didn't say (and for older apps).
ALTER TABLE submissions ADD COLUMN generative_ai_used INTEGER;
