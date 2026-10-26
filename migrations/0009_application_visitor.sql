ALTER TABLE applications ADD COLUMN visitor_hash TEXT;

CREATE INDEX idx_applications_visitor ON applications (visitor_hash, created_at);
