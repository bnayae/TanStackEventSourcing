-- Add last_event_at column to account_balances
ALTER TABLE account_balances
  ADD COLUMN IF NOT EXISTS last_event_at BIGINT NOT NULL DEFAULT 0;

-- Create balance_snapshots table
CREATE TABLE IF NOT EXISTS balance_snapshots (
  id            BIGSERIAL    PRIMARY KEY,
  account_id    TEXT         NOT NULL,
  owner_name    TEXT         NOT NULL DEFAULT '',
  balance       NUMERIC      NOT NULL,
  last_seq      INTEGER      NOT NULL,
  last_event_at BIGINT       NOT NULL,
  captured_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_balance_snapshots_account_time
  ON balance_snapshots (account_id, last_event_at DESC);

-- Create app_settings table for configurable snapshot interval
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO app_settings (key, value)
VALUES ('snapshot_interval_seconds', '60')
ON CONFLICT DO NOTHING;

-- Replace apply_event_to_balance trigger function with snapshot support
CREATE OR REPLACE FUNCTION apply_event_to_balance()
RETURNS TRIGGER AS $$
DECLARE
  v_amount              NUMERIC;
  v_ref_id              TEXT;
  v_cap_amount          NUMERIC;
  v_owner_name          TEXT;
  v_interval_seconds    INTEGER;
  v_current             account_balances%ROWTYPE;
BEGIN
  -- Fetch configurable snapshot interval
  SELECT value::INTEGER INTO v_interval_seconds
    FROM app_settings WHERE key = 'snapshot_interval_seconds';
  v_interval_seconds := COALESCE(v_interval_seconds, 60);

  -- Ensure account_balances row exists
  INSERT INTO account_balances (account_id, owner_name, balance, last_seq, last_event_at, updated_at)
  VALUES (NEW.account_id, '', 0, 0, 0, now())
  ON CONFLICT (account_id) DO NOTHING;

  -- Load current state
  SELECT * INTO v_current
    FROM account_balances WHERE account_id = NEW.account_id;

  -- Write snapshot if existing row is stale (last_seq > 0 and updated_at is old enough)
  IF v_current.last_seq > 0
     AND v_current.updated_at < now() - (v_interval_seconds || ' seconds')::INTERVAL
  THEN
    INSERT INTO balance_snapshots
      (account_id, owner_name, balance, last_seq, last_event_at)
    VALUES
      (v_current.account_id, v_current.owner_name, v_current.balance,
       v_current.last_seq, v_current.last_event_at);
  END IF;

  -- Apply the event
  CASE NEW.type
    WHEN 'ACCOUNT_CREATED' THEN
      v_owner_name := NEW.payload->>'ownerName';
      UPDATE account_balances
      SET owner_name    = v_owner_name,
          last_seq      = NEW.sequence_number,
          last_event_at = NEW.created_at,
          updated_at    = now()
      WHERE account_id = NEW.account_id;

    WHEN 'DEPOSITED' THEN
      v_amount := (NEW.payload->>'amount')::NUMERIC;
      UPDATE account_balances
      SET balance       = balance + v_amount,
          last_seq      = NEW.sequence_number,
          last_event_at = NEW.created_at,
          updated_at    = now()
      WHERE account_id = NEW.account_id;

    WHEN 'WITHDRAWN' THEN
      v_amount := (NEW.payload->>'amount')::NUMERIC;
      UPDATE account_balances
      SET balance       = balance - v_amount,
          last_seq      = NEW.sequence_number,
          last_event_at = NEW.created_at,
          updated_at    = now()
      WHERE account_id = NEW.account_id;

    WHEN 'CAPTURED' THEN
      v_amount := (NEW.payload->>'amount')::NUMERIC;
      UPDATE account_balances
      SET balance       = balance - v_amount,
          last_seq      = NEW.sequence_number,
          last_event_at = NEW.created_at,
          updated_at    = now()
      WHERE account_id = NEW.account_id;

    WHEN 'CAPTURE_RELEASED' THEN
      v_ref_id := NEW.payload->>'referenceId';
      SELECT (payload->>'amount')::NUMERIC
      INTO   v_cap_amount
      FROM   events
      WHERE  account_id            = NEW.account_id
        AND  type                  = 'CAPTURED'
        AND  payload->>'referenceId' = v_ref_id
      LIMIT 1;

      IF v_cap_amount IS NOT NULL THEN
        UPDATE account_balances
        SET balance       = balance + v_cap_amount,
            last_seq      = NEW.sequence_number,
            last_event_at = NEW.created_at,
            updated_at    = now()
        WHERE account_id = NEW.account_id;
      ELSE
        UPDATE account_balances
        SET last_seq      = NEW.sequence_number,
            last_event_at = NEW.created_at,
            updated_at    = now()
        WHERE account_id = NEW.account_id;
      END IF;

    ELSE
      UPDATE account_balances
      SET last_seq      = NEW.sequence_number,
          last_event_at = NEW.created_at,
          updated_at    = now()
      WHERE account_id = NEW.account_id;
  END CASE;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
