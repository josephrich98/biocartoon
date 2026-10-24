-- Whether the contributor asked for an asset or template to be listed under the official BioCartoon library
-- ("Submit as official BioCartoon asset" in the app). A reviewer can accept it as official
-- (`official`) only when this is 1; either way it stays credited to the contributor.
ALTER TABLE submissions ADD COLUMN official_requested INTEGER NOT NULL DEFAULT 0;
