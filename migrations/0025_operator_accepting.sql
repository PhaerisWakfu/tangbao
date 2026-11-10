ALTER TABLE operators ADD COLUMN accepting INTEGER NOT NULL DEFAULT 1;
INSERT OR IGNORE INTO settings(key, value) VALUES ('home_accepting', '1');
