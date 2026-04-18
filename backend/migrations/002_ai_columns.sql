-- AI feature columns
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS risk_score    INTEGER      DEFAULT 0,
  ADD COLUMN IF NOT EXISTS risk_reason   TEXT,
  ADD COLUMN IF NOT EXISTS risk_action   VARCHAR(20)  DEFAULT 'allow';

ALTER TABLE webhook_deliveries
  ADD COLUMN IF NOT EXISTS ai_diagnosis  TEXT;
