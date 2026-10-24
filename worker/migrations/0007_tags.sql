-- Optional search words sent with a submission (a JSON array of strings).
ALTER TABLE submissions ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
