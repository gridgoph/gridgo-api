// Existing commitments retain their original fee and discount snapshots.
function committedMoneyGuard(discounted) {
  return `    CREATE OR REPLACE FUNCTION enforce_committed_order_money()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE expected_fee bigint;
    DECLARE expected_downpayment bigint;
    BEGIN
      IF NEW.money_model_version <> 2 OR NEW.commercial_committed_at IS NULL THEN
        RETURN NEW;
      END IF;
      IF NEW.supplier_subtotal_minor IS NULL OR NEW.service_fee_rate_bps IS NULL OR
         NEW.service_fee_minor IS NULL OR NEW.subtotal_minor IS NULL OR
         NEW.delivery_fee_minor IS NULL OR NEW.total_minor IS NULL OR
         NEW.fulfillment_mode IS NULL OR NEW.payment_plan IS NULL OR
         NEW.quote_version IS NULL OR NEW.supplier_downpayment_rate_bps IS NULL OR
         NEW.online_due_minor IS NULL OR NEW.direct_store_due_minor IS NULL OR
         NEW.supplier_platform_payout_minor IS NULL THEN
        RAISE EXCEPTION 'committed order money snapshot is incomplete'
          USING ERRCODE = '23514', CONSTRAINT = 'orders_committed_money_check';
      END IF;

      expected_fee := floor(
        (NEW.supplier_subtotal_minor::numeric * NEW.service_fee_rate_bps + 5000) / 10000
      );
      expected_downpayment := floor(
        (NEW.supplier_subtotal_minor::numeric * NEW.supplier_downpayment_rate_bps + 5000) / 10000
      );
      IF NEW.service_fee_minor <> expected_fee ${discounted ? "- COALESCE((NEW.data->>'organizationDiscountMinor')::bigint, 0)" : ''} OR
         NEW.subtotal_minor <> NEW.supplier_subtotal_minor OR
         NEW.total_minor <> NEW.supplier_subtotal_minor + NEW.service_fee_minor + NEW.delivery_fee_minor OR
         NEW.online_due_minor + NEW.direct_store_due_minor <> NEW.total_minor OR
         NEW.supplier_platform_payout_minor <> NEW.supplier_subtotal_minor - NEW.direct_store_due_minor THEN
        RAISE EXCEPTION 'committed order money totals are inconsistent'
          USING ERRCODE = '23514', CONSTRAINT = 'orders_committed_money_check';
      END IF;

      IF NEW.payment_plan = 'delivery_online' THEN
        IF NEW.fulfillment_mode <> 'delivery' OR
           NEW.supplier_downpayment_rate_bps NOT IN (0,2500,5000) OR
           NEW.direct_store_due_minor <> 0 OR NEW.online_due_minor <> NEW.total_minor OR
           NEW.dropoff_lat IS NULL OR NEW.dropoff_lng IS NULL OR
           NEW.dropoff_label IS NULL OR btrim(NEW.dropoff_label) = '' THEN
          RAISE EXCEPTION 'invalid delivery payment plan snapshot'
            USING ERRCODE = '23514', CONSTRAINT = 'orders_payment_plan_shape_check';
        END IF;
      ELSIF NEW.payment_plan = 'pickup_full_online' THEN
        IF NEW.fulfillment_mode <> 'pickup' OR NEW.supplier_downpayment_rate_bps <> 10000 OR
           NEW.delivery_fee_minor <> 0 OR NEW.direct_store_due_minor <> 0 OR
           NEW.online_due_minor <> NEW.total_minor OR NEW.rider_id IS NOT NULL OR
           NEW.pickup_lat IS NULL OR NEW.pickup_lng IS NULL OR NEW.pickup_label IS NULL THEN
          RAISE EXCEPTION 'invalid pickup full-online snapshot'
            USING ERRCODE = '23514', CONSTRAINT = 'orders_payment_plan_shape_check';
        END IF;
      ELSIF NEW.payment_plan = 'pickup_downpayment_store' THEN
        IF NEW.fulfillment_mode <> 'pickup' OR NEW.supplier_downpayment_rate_bps NOT IN (2500,5000) OR
           NEW.delivery_fee_minor <> 0 OR
           NEW.online_due_minor <> expected_downpayment + NEW.service_fee_minor OR
           NEW.direct_store_due_minor <> NEW.supplier_subtotal_minor - expected_downpayment OR
           NEW.rider_id IS NOT NULL OR NEW.pickup_lat IS NULL OR NEW.pickup_lng IS NULL OR
           NEW.pickup_label IS NULL THEN
          RAISE EXCEPTION 'invalid pickup downpayment-at-store snapshot'
            USING ERRCODE = '23514', CONSTRAINT = 'orders_payment_plan_shape_check';
        END IF;
      ELSE
        RAISE EXCEPTION 'unknown committed payment plan'
          USING ERRCODE = '23514', CONSTRAINT = 'orders_payment_plan_shape_check';
      END IF;
      PERFORM validate_order_financial_children(NEW.id);
      RETURN NEW;
    END;
    $$;
`;
}
export async function up(pgm) {
  pgm.sql(`
    UPDATE platform_settings SET settings = settings || '{"organizationDiscountRateBps":500}'::jsonb
      WHERE NOT settings ? 'organizationDiscountRateBps';
    ALTER TABLE platform_settings ADD CONSTRAINT organization_fee_floor CHECK (
      jsonb_typeof(settings->'organizationDiscountRateBps') = 'number'
      AND (settings->>'organizationDiscountRateBps')::numeric = trunc((settings->>'organizationDiscountRateBps')::numeric)
      AND (settings->>'organizationDiscountRateBps')::numeric BETWEEN 0 AND 10000
      AND (settings->>'serviceFeeRateBps')::numeric >= COALESCE((settings->>'organizationDiscountRateBps')::numeric, 500)
    );
    CREATE FUNCTION guard_organization_discount() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE rate numeric; discount numeric; gross numeric;
    BEGIN
      IF TG_OP = 'UPDATE' AND OLD.commercial_committed_at IS NOT NULL AND NEW.commercial_committed_at IS NOT NULL
        AND (NEW.data->'organizationDiscountRateBps' IS DISTINCT FROM OLD.data->'organizationDiscountRateBps'
          OR NEW.data->'organizationDiscountMinor' IS DISTINCT FROM OLD.data->'organizationDiscountMinor'
          OR NEW.data->'grossServiceFeeMinor' IS DISTINCT FROM OLD.data->'grossServiceFeeMinor') THEN
        RAISE EXCEPTION 'committed organization discount is immutable' USING ERRCODE = '23514';
      END IF;
      IF NEW.commercial_committed_at IS NULL OR NOT (NEW.data ?| ARRAY['organizationDiscountMinor','organizationDiscountRateBps','grossServiceFeeMinor']) THEN RETURN NEW; END IF;
      rate := (NEW.data->>'organizationDiscountRateBps')::numeric;
      discount := (NEW.data->>'organizationDiscountMinor')::numeric;
      gross := (NEW.data->>'grossServiceFeeMinor')::numeric;
      IF rate IS NULL OR discount IS NULL OR gross IS NULL
        OR jsonb_typeof(NEW.data->'organizationDiscountRateBps') <> 'number'
        OR jsonb_typeof(NEW.data->'organizationDiscountMinor') <> 'number'
        OR jsonb_typeof(NEW.data->'grossServiceFeeMinor') <> 'number'
        OR rate <> trunc(rate) OR rate < 0 OR rate > NEW.service_fee_rate_bps
        OR gross <> floor((NEW.supplier_subtotal_minor::numeric * NEW.service_fee_rate_bps + 5000) / 10000)
        OR discount <> floor((NEW.supplier_subtotal_minor::numeric * rate + 5000) / 10000)
        OR NEW.service_fee_minor IS DISTINCT FROM gross - discount
        OR NEW.total_minor IS DISTINCT FROM NEW.supplier_subtotal_minor + NEW.service_fee_minor + NEW.delivery_fee_minor
        OR NEW.supplier_platform_payout_minor IS DISTINCT FROM NEW.supplier_subtotal_minor - NEW.direct_store_due_minor THEN
        RAISE EXCEPTION 'organization discount must be funded only from service fee' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER organization_discount_guard BEFORE INSERT OR UPDATE ON orders
      FOR EACH ROW EXECUTE FUNCTION guard_organization_discount();
    ${committedMoneyGuard(true)}
  `);
}
export async function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM orders WHERE commercial_committed_at IS NOT NULL AND data ? 'organizationDiscountMinor') THEN
        RAISE EXCEPTION 'Committed organization discount snapshots require a forward migration';
      END IF;
    END $$;
    DROP TRIGGER organization_discount_guard ON orders;
    DROP FUNCTION guard_organization_discount();
    ALTER TABLE platform_settings DROP CONSTRAINT organization_fee_floor;
    UPDATE platform_settings SET settings = settings - 'organizationDiscountRateBps';
    ${committedMoneyGuard(false)}
  `);
}
