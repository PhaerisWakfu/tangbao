ALTER TABLE operators ADD COLUMN away_at INTEGER NOT NULL DEFAULT 0;
INSERT OR IGNORE INTO settings(key, value) VALUES ('home_away_at', '0');
