-- This key is separate from the old request-time schema_v flag, which old
-- Workers may still overwrite during a staged code rollout.
INSERT INTO settings (key, value) VALUES ('app_schema_version', '24')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
