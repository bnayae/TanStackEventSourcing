-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "sequence_number" INTEGER NOT NULL,
    "created_at" BIGINT NOT NULL,
    "synced_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_balances" (
    "account_id" TEXT NOT NULL,
    "owner_name" TEXT NOT NULL DEFAULT '',
    "balance" NUMERIC NOT NULL DEFAULT 0,
    "last_seq" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "account_balances_pkey" PRIMARY KEY ("account_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "events_account_id_sequence_number_key" ON "events"("account_id", "sequence_number");

-- CreateIndex
CREATE INDEX "idx_events_account_seq" ON "events"("account_id", "sequence_number");

-- CreateTriggerFunction
CREATE OR REPLACE FUNCTION apply_event_to_balance()
RETURNS TRIGGER AS $$
DECLARE
  v_amount      NUMERIC;
  v_ref_id      TEXT;
  v_cap_amount  NUMERIC;
  v_owner_name  TEXT;
BEGIN
  -- Ensure account_balances row exists
  INSERT INTO account_balances (account_id, owner_name, balance, last_seq, updated_at)
  VALUES (NEW.account_id, '', 0, 0, now())
  ON CONFLICT (account_id) DO NOTHING;

  -- Apply the event
  CASE NEW.type
    WHEN 'ACCOUNT_CREATED' THEN
      v_owner_name := NEW.payload->>'ownerName';
      UPDATE account_balances
      SET owner_name = v_owner_name,
          last_seq   = GREATEST(last_seq, NEW.sequence_number),
          updated_at = now()
      WHERE account_id = NEW.account_id;

    WHEN 'DEPOSITED' THEN
      v_amount := (NEW.payload->>'amount')::NUMERIC;
      UPDATE account_balances
      SET balance    = balance + v_amount,
          last_seq   = GREATEST(last_seq, NEW.sequence_number),
          updated_at = now()
      WHERE account_id = NEW.account_id;

    WHEN 'WITHDRAWN' THEN
      v_amount := (NEW.payload->>'amount')::NUMERIC;
      UPDATE account_balances
      SET balance    = balance - v_amount,
          last_seq   = GREATEST(last_seq, NEW.sequence_number),
          updated_at = now()
      WHERE account_id = NEW.account_id;

    WHEN 'CAPTURED' THEN
      v_amount := (NEW.payload->>'amount')::NUMERIC;
      UPDATE account_balances
      SET balance    = balance - v_amount,
          last_seq   = GREATEST(last_seq, NEW.sequence_number),
          updated_at = now()
      WHERE account_id = NEW.account_id;

    WHEN 'CAPTURE_RELEASED' THEN
      v_ref_id := NEW.payload->>'referenceId';
      -- Find original captured amount
      SELECT (payload->>'amount')::NUMERIC
      INTO   v_cap_amount
      FROM   events
      WHERE  account_id       = NEW.account_id
        AND  type             = 'CAPTURED'
        AND  payload->>'referenceId' = v_ref_id
      LIMIT 1;

      IF v_cap_amount IS NOT NULL THEN
        UPDATE account_balances
        SET balance    = balance + v_cap_amount,
            last_seq   = GREATEST(last_seq, NEW.sequence_number),
            updated_at = now()
        WHERE account_id = NEW.account_id;
      ELSE
        UPDATE account_balances
        SET last_seq   = GREATEST(last_seq, NEW.sequence_number),
            updated_at = now()
        WHERE account_id = NEW.account_id;
      END IF;

    ELSE
      -- Unknown event type: still update last_seq
      UPDATE account_balances
      SET last_seq   = GREATEST(last_seq, NEW.sequence_number),
          updated_at = now()
      WHERE account_id = NEW.account_id;
  END CASE;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- CreateTrigger
CREATE TRIGGER trg_apply_event_to_balance
AFTER INSERT ON events
FOR EACH ROW
EXECUTE FUNCTION apply_event_to_balance();
