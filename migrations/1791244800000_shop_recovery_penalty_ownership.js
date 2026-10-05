/** A replacement shop owns new payout stages; historical deductions stay immutable. */
export const up = (pgm) => pgm.sql(`
  ALTER TABLE production_lapses DROP CONSTRAINT production_lapses_order_id_key;
  ALTER TABLE production_lapses ADD CONSTRAINT production_lapses_order_supplier_key UNIQUE(order_id, supplier_id);
  CREATE OR REPLACE FUNCTION validate_production_deductions() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE target text; actual bigint; recorded bigint;
  BEGIN
    target := COALESCE(NEW.order_id, OLD.order_id);
    SELECT COALESCE(sum(production_deduction_minor),0) INTO actual FROM payout_milestones WHERE order_id=target;
    SELECT COALESCE(sum(l.deduction_minor),0) INTO recorded FROM production_lapses l
      JOIN orders o ON o.id=l.order_id AND o.supplier_id=l.supplier_id WHERE l.order_id=target;
    IF actual <> recorded THEN
      RAISE EXCEPTION 'production deduction must match the current shop lapse ledger'
        USING ERRCODE='23514', CONSTRAINT='production_deduction_ledger_check';
    END IF;
    RETURN NULL;
  END; $$;
`);
// Used by fresh-schema migration tests; uniqueness refuses rollback once an order
// has multiple shop ledgers instead of deleting historical deductions.
export const down = (pgm) => pgm.sql(`
  ALTER TABLE production_lapses DROP CONSTRAINT production_lapses_order_supplier_key;
  ALTER TABLE production_lapses ADD CONSTRAINT production_lapses_order_id_key UNIQUE(order_id);
  CREATE OR REPLACE FUNCTION validate_production_deductions() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE target text; actual bigint; recorded bigint;
  BEGIN
    target := COALESCE(NEW.order_id, OLD.order_id);
    SELECT COALESCE(sum(production_deduction_minor),0) INTO actual FROM payout_milestones WHERE order_id=target;
    SELECT COALESCE(sum(deduction_minor),0) INTO recorded FROM production_lapses WHERE order_id=target;
    IF actual <> recorded THEN
      RAISE EXCEPTION 'production deduction must match the lapse ledger'
        USING ERRCODE='23514', CONSTRAINT='production_deduction_ledger_check';
    END IF;
    RETURN NULL;
  END; $$;
`);
