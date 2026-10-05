/** Late-production adjustments preserve the published gross stage shares. */
const PLAN_STAGES = `
  (VALUES
    (1, 'printing', 5000, false),
    (1, 'packaging_qc', 1500, false),
    (1, 'delivered', 2500, false),
    (1, 'retention', 1000, true),
    (2, 'production_started', 4000, false),
    (2, 'delivered', 3500, false),
    (2, 'issue_window', 2500, true)
  ) AS plan(version, code, share_bps, is_last)
`;

const PAYOUT_STAGE_CHECK = `
    CREATE OR REPLACE FUNCTION validate_order_payout_stages(target_order_id text)
    RETURNS void
    LANGUAGE plpgsql
    AS $$
    DECLARE committed orders%ROWTYPE;
    BEGIN
      SELECT * INTO committed FROM orders WHERE id = target_order_id;
      -- Exactly the stages of the order's own plan, each but the last rounded
      -- half-up from the shop's payout and all of them summing to exactly it,
      -- so a set that sums right but splits wrong is still caught.
      IF (SELECT COALESCE(sum(amount_minor + production_deduction_minor), 0) FROM payout_milestones WHERE order_id = committed.id)
           <> committed.supplier_platform_payout_minor OR
         (SELECT count(*) FROM payout_milestones WHERE order_id = committed.id) <>
           (SELECT count(*) FROM ${PLAN_STAGES} WHERE plan.version = committed.payout_plan_version) OR
         EXISTS (
           SELECT 1 FROM payout_milestones m
            WHERE m.order_id = committed.id
              AND NOT EXISTS (
                SELECT 1 FROM ${PLAN_STAGES}
                 WHERE plan.version = committed.payout_plan_version AND plan.code = m.code
              )
         ) OR
         EXISTS (
           SELECT 1
             FROM ${PLAN_STAGES}
             JOIN payout_milestones m ON m.order_id = committed.id AND m.code = plan.code
            WHERE plan.version = committed.payout_plan_version
              AND NOT plan.is_last
              AND m.amount_minor + m.production_deduction_minor <> floor(
                (committed.supplier_platform_payout_minor::numeric * plan.share_bps + 5000) / 10000
              )
         ) THEN
        RAISE EXCEPTION 'payout milestones do not match committed supplier payout'
          USING ERRCODE = '23514', CONSTRAINT = 'payout_milestones_amount_check';
      END IF;
    END;
    $$;
`;


export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE payout_milestones ADD COLUMN production_deduction_minor bigint NOT NULL DEFAULT 0
      CHECK (production_deduction_minor BETWEEN 0 AND 9007199254740991);
    CREATE TABLE production_lapses (
      id text PRIMARY KEY,
      order_id text NOT NULL UNIQUE REFERENCES orders(id),
      supplier_id text NOT NULL REFERENCES users(id),
      tier text NOT NULL CHECK (tier IN ('minor','moderate','severe')),
      deadline_at timestamptz NOT NULL,
      detected_at timestamptz NOT NULL,
      rate_bps integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
      deduction_minor bigint NOT NULL DEFAULT 0 CHECK (deduction_minor BETWEEN 0 AND 9007199254740991),
      remaining_balance_minor bigint NOT NULL DEFAULT 0 CHECK (remaining_balance_minor BETWEEN 0 AND 9007199254740991),
      applied_at timestamptz,
      data jsonb NOT NULL DEFAULT '{}',
      CHECK (deduction_minor <= remaining_balance_minor),
      CHECK (applied_at IS NOT NULL OR deduction_minor = 0),
      CHECK (applied_at IS NULL OR deduction_minor = floor((remaining_balance_minor::numeric * rate_bps + 5000) / 10000))
    );
    CREATE INDEX production_lapses_supplier_recent ON production_lapses(supplier_id, detected_at DESC);
    CREATE FUNCTION validate_production_deductions() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target text; actual bigint; recorded bigint;
    BEGIN
      target := COALESCE(NEW.order_id, OLD.order_id);
      SELECT COALESCE(sum(production_deduction_minor),0) INTO actual FROM payout_milestones WHERE order_id=target;
      SELECT COALESCE(sum(deduction_minor),0) INTO recorded FROM production_lapses WHERE order_id=target;
      IF actual <> recorded THEN
        RAISE EXCEPTION 'production deduction must match the lapse ledger' USING ERRCODE='23514', CONSTRAINT='production_deduction_ledger_check';
      END IF;
      RETURN NULL;
    END; $$;
    CREATE CONSTRAINT TRIGGER production_deduction_stages AFTER INSERT OR UPDATE OR DELETE ON payout_milestones
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_production_deductions();
    CREATE CONSTRAINT TRIGGER production_deduction_lapses AFTER INSERT OR UPDATE OR DELETE ON production_lapses
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_production_deductions();
    CREATE FUNCTION protect_production_deduction() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_TABLE_NAME = 'production_lapses' THEN
        IF OLD.applied_at IS NOT NULL AND (TG_OP = 'DELETE' OR NEW IS DISTINCT FROM OLD) THEN
          RAISE EXCEPTION 'applied production deductions are immutable' USING ERRCODE='23514';
        END IF;
      ELSIF OLD.status = 'released'
          AND EXISTS (SELECT 1 FROM production_lapses WHERE order_id = OLD.order_id)
          AND (TG_OP = 'DELETE' OR NEW.amount_minor <> OLD.amount_minor
          OR NEW.production_deduction_minor <> OLD.production_deduction_minor) THEN
        RAISE EXCEPTION 'a released payout cannot be reduced' USING ERRCODE='23514';
      END IF;
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END; $$;
    CREATE TRIGGER production_lapse_immutable BEFORE UPDATE OR DELETE ON production_lapses
      FOR EACH ROW EXECUTE FUNCTION protect_production_deduction();
    CREATE TRIGGER production_released_payout_immutable BEFORE UPDATE OR DELETE ON payout_milestones
      FOR EACH ROW EXECUTE FUNCTION protect_production_deduction();
  `);
  pgm.sql(PAYOUT_STAGE_CHECK);
}

export async function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM production_lapses) THEN RAISE EXCEPTION 'production lapse records must be preserved'; END IF;
  END $$;
  DROP TRIGGER production_deduction_stages ON payout_milestones;
  DROP TRIGGER production_released_payout_immutable ON payout_milestones;
  DROP TABLE production_lapses;
  DROP FUNCTION validate_production_deductions(), protect_production_deduction();`);
  pgm.sql(PAYOUT_STAGE_CHECK.replaceAll('amount_minor + production_deduction_minor', 'amount_minor')
    .replaceAll('m.amount_minor + m.production_deduction_minor', 'm.amount_minor'));
  pgm.sql('ALTER TABLE payout_milestones DROP COLUMN production_deduction_minor;');
}
