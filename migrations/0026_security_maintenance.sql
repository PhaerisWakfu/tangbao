CREATE INDEX idx_rate_buckets_expiry ON rate_buckets(reset_at);
CREATE INDEX idx_auth_rate_buckets_expiry ON auth_rate_buckets(reset_at);

UPDATE settings SET value='26' WHERE key='app_schema_version';
