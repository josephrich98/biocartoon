-- Why a reviewer rejected a submission (optional, up to 200 characters; '' when none was given).
-- Shown to the contributor by GET /status?ids=...&detail=1, and cleared when a decision is undone.
ALTER TABLE submissions ADD COLUMN reject_reason TEXT NOT NULL DEFAULT '';
