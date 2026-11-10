ALTER TABLE mail_deliveries ADD COLUMN mail_provider TEXT NOT NULL DEFAULT 'cloudflare';

CREATE TABLE mail_provider_budgets (
  provider TEXT NOT NULL,
  period TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, period)
);

INSERT OR IGNORE INTO mail_provider_budgets(provider, period, used)
SELECT 'cloudflare', period, used FROM mail_budgets;
