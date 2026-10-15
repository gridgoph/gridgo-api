// Forward-only: retain flat commitments and lock existing carts/quotes before enabling brackets.
export async function up(pgm) {
  pgm.sql(`
    CREATE FUNCTION gridgo_service_fee(principal numeric, schedule jsonb) RETURNS numeric
    LANGUAGE plpgsql IMMUTABLE AS $$
    DECLARE band jsonb; ceiling numeric; lower_bound numeric := 0; rate numeric;
      numerator numeric := 0; idx integer := 0; count_bands integer; result numeric;
    BEGIN
      IF principal IS NULL OR principal < 0 OR principal > 9007199254740991 OR principal <> trunc(principal)
        OR jsonb_typeof(schedule) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'invalid service fee input' USING ERRCODE='23514';
      END IF;
      IF schedule->'version' = '1'::jsonb THEN
        rate := (schedule->>'rateBps')::numeric;
        IF jsonb_typeof(schedule->'rateBps') IS DISTINCT FROM 'number' OR rate <> trunc(rate) OR rate < 0 OR rate > 10000 THEN
          RAISE EXCEPTION 'invalid flat fee' USING ERRCODE='23514';
        END IF;
        numerator := principal * rate;
      ELSIF schedule->'version' = '2'::jsonb THEN
        IF schedule->>'rounding' IS DISTINCT FROM 'half_up_once' OR jsonb_typeof(schedule->'brackets') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'invalid bracket schedule' USING ERRCODE='23514';
        END IF;
        count_bands := jsonb_array_length(schedule->'brackets');
        IF count_bands < 1 OR count_bands > 20 THEN RAISE EXCEPTION 'invalid bracket count' USING ERRCODE='23514'; END IF;
        FOR band IN SELECT value FROM jsonb_array_elements(schedule->'brackets') LOOP
          idx := idx + 1;
          rate := (band->>'rateBps')::numeric;
          ceiling := (band->>'upToMinor')::numeric;
          IF jsonb_typeof(band->'rateBps') IS DISTINCT FROM 'number' OR rate <> trunc(rate) OR rate < 0 OR rate > 10000
            OR (idx = count_bands AND band->'upToMinor' IS DISTINCT FROM 'null'::jsonb)
            OR (idx < count_bands AND (jsonb_typeof(band->'upToMinor') IS DISTINCT FROM 'number'
              OR ceiling <> trunc(ceiling) OR ceiling <= lower_bound OR ceiling > 9007199254740991)) THEN
            RAISE EXCEPTION 'invalid service fee bracket' USING ERRCODE='23514';
          END IF;
          numerator := numerator + greatest(0, least(principal, COALESCE(ceiling,principal)) - lower_bound) * rate;
          lower_bound := ceiling;
        END LOOP;
      ELSE RAISE EXCEPTION 'invalid service fee version' USING ERRCODE='23514'; END IF;
      result := floor((numerator + 5000) / 10000);
      IF principal + result > 9007199254740991 THEN RAISE EXCEPTION 'unsafe service fee total' USING ERRCODE='23514'; END IF;
      RETURN result;
    END $$;

    ALTER TABLE client_cart_lines ADD COLUMN service_fee_snapshot jsonb;
    UPDATE client_cart_lines l SET service_fee_snapshot = jsonb_build_object(
      'groupKey', jsonb_build_array(l.supplier_id,
        to_char(COALESCE(l.deadline,c.deadline,l.match_deadline) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      'schedule', jsonb_build_object('version',1,'rateBps',(p.settings->>'serviceFeeRateBps')::integer))
      FROM client_carts c, platform_settings p WHERE c.id=l.cart_id;
    UPDATE orders o SET data = jsonb_set(o.data, '{pendingQuote,serviceFeeSchedule}',
      jsonb_build_object('version',1,'rateBps',(p.settings->>'serviceFeeRateBps')::integer))
      FROM platform_settings p WHERE o.commercial_committed_at IS NULL AND jsonb_typeof(o.data->'pendingQuote')='object'
        AND NOT (o.data->'pendingQuote' ? 'serviceFeeSchedule');

    ALTER TABLE platform_settings DROP CONSTRAINT organization_fee_floor;
    ALTER TABLE platform_settings ADD CONSTRAINT organization_fee_floor CHECK (
      jsonb_typeof(settings->'organizationDiscountRateBps') = 'number'
      AND (settings->>'organizationDiscountRateBps')::numeric = trunc((settings->>'organizationDiscountRateBps')::numeric)
      AND (settings->>'organizationDiscountRateBps')::numeric BETWEEN 0 AND 10000
      AND (settings ? 'serviceFeeSchedule' OR (settings->>'serviceFeeRateBps')::numeric >= (settings->>'organizationDiscountRateBps')::numeric)
    );
    CREATE FUNCTION guard_service_fee_settings() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.settings ? 'serviceFeeSchedule' THEN PERFORM gridgo_service_fee(0,NEW.settings->'serviceFeeSchedule'); END IF;
      IF NEW.settings->'scheduledServiceFee' IS NOT NULL AND NEW.settings->'scheduledServiceFee' <> 'null'::jsonb THEN
        PERFORM gridgo_service_fee(0,NEW.settings->'scheduledServiceFee');
        IF NEW.settings->'scheduledServiceFee'->>'effectiveFrom' IS NULL THEN RAISE EXCEPTION 'effective date required' USING ERRCODE='23514'; END IF;
        PERFORM (NEW.settings->'scheduledServiceFee'->>'effectiveFrom')::timestamptz;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER service_fee_settings_guard BEFORE INSERT OR UPDATE ON platform_settings FOR EACH ROW EXECUTE FUNCTION guard_service_fee_settings();

    CREATE FUNCTION guard_service_fee_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='UPDATE' AND OLD.commercial_committed_at IS NOT NULL AND NEW.commercial_committed_at IS NOT NULL
        AND (OLD.data->'serviceFeeSchedule' IS DISTINCT FROM NEW.data->'serviceFeeSchedule'
          OR OLD.data->'serviceFeeWorking' IS DISTINCT FROM NEW.data->'serviceFeeWorking') THEN
        RAISE EXCEPTION 'committed service fee schedule is immutable' USING ERRCODE='23514';
      END IF;
      IF NEW.data->'serviceFeeSchedule'->>'version'='1' AND NEW.commercial_committed_at IS NOT NULL
        AND NEW.service_fee_rate_bps IS DISTINCT FROM (NEW.data->'serviceFeeSchedule'->>'rateBps')::integer THEN
        RAISE EXCEPTION 'flat schedule must match legacy rate' USING ERRCODE='23514';
      END IF;
      IF NEW.data->'serviceFeeSchedule'->>'version'='2' AND NEW.commercial_committed_at IS NOT NULL THEN
        IF NEW.service_fee_rate_bps IS NOT NULL OR (NEW.data->>'grossServiceFeeMinor')::numeric IS DISTINCT FROM
          gridgo_service_fee(NEW.supplier_subtotal_minor,NEW.data->'serviceFeeSchedule')
          OR COALESCE((NEW.data->>'voucherDeliveryMinor')::numeric,0) <> 0 THEN
          RAISE EXCEPTION 'invalid bracket fee snapshot' USING ERRCODE='23514';
        END IF;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER service_fee_snapshot_guard BEFORE INSERT OR UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION guard_service_fee_snapshot();
    CREATE OR REPLACE FUNCTION enforce_committed_order_money()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE expected_fee bigint;
    DECLARE expected_downpayment bigint;
    BEGIN
      IF NEW.money_model_version <> 2 OR NEW.commercial_committed_at IS NULL THEN
        RETURN NEW;
      END IF;
      IF NEW.supplier_subtotal_minor IS NULL OR (NEW.service_fee_rate_bps IS NULL AND NEW.data->'serviceFeeSchedule'->>'version' IS DISTINCT FROM '2') OR
         NEW.service_fee_minor IS NULL OR NEW.subtotal_minor IS NULL OR
         NEW.delivery_fee_minor IS NULL OR NEW.total_minor IS NULL OR
         NEW.fulfillment_mode IS NULL OR NEW.payment_plan IS NULL OR
         NEW.quote_version IS NULL OR NEW.supplier_downpayment_rate_bps IS NULL OR
         NEW.online_due_minor IS NULL OR NEW.direct_store_due_minor IS NULL OR
         NEW.supplier_platform_payout_minor IS NULL THEN
        RAISE EXCEPTION 'committed order money snapshot is incomplete'
          USING ERRCODE = '23514', CONSTRAINT = 'orders_committed_money_check';
      END IF;

      expected_fee := gridgo_service_fee(NEW.supplier_subtotal_minor, COALESCE(NEW.data->'serviceFeeSchedule', jsonb_build_object('version',1,'rateBps',NEW.service_fee_rate_bps)));
      expected_downpayment := floor(
        (NEW.supplier_subtotal_minor::numeric * NEW.supplier_downpayment_rate_bps + 5000) / 10000
      );
      IF NEW.service_fee_minor <> expected_fee - COALESCE((NEW.data->>'organizationDiscountMinor')::bigint, 0) OR
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
    CREATE OR REPLACE FUNCTION guard_organization_discount() RETURNS trigger LANGUAGE plpgsql AS $$
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
        OR rate <> trunc(rate) OR rate < 0 OR rate > (CASE WHEN NEW.data->'serviceFeeSchedule'->>'version' IN ('1','2') THEN 10000 ELSE NEW.service_fee_rate_bps END)
        OR gross <> gridgo_service_fee(NEW.supplier_subtotal_minor, COALESCE(NEW.data->'serviceFeeSchedule', jsonb_build_object('version',1,'rateBps',NEW.service_fee_rate_bps)))
        OR discount <> least(gross, floor((NEW.supplier_subtotal_minor::numeric * rate + 5000) / 10000))
        OR NEW.service_fee_minor IS DISTINCT FROM gross - discount
        OR NEW.total_minor IS DISTINCT FROM NEW.supplier_subtotal_minor + NEW.service_fee_minor + NEW.delivery_fee_minor - COALESCE((NEW.data->>'voucherDiscountMinor')::bigint, 0)
        OR NEW.supplier_platform_payout_minor IS DISTINCT FROM NEW.supplier_subtotal_minor - NEW.direct_store_due_minor THEN
        RAISE EXCEPTION 'organization discount must be funded only from service fee' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END $$;

    WITH previous AS MATERIALIZED (SELECT settings FROM platform_settings WHERE NOT settings ? 'serviceFeeSchedule'),
    changed AS (UPDATE platform_settings SET settings = settings || jsonb_build_object('serviceFeeSchedule',
      jsonb_build_object('version',2,'rounding','half_up_once','settingsVersion',version+1,'effectiveFrom',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'brackets','[{"upToMinor":200000,"rateBps":4500},{"upToMinor":2000000,"rateBps":2500},{"upToMinor":null,"rateBps":1500}]'::jsonb)), version=version+1
      WHERE NOT settings ? 'serviceFeeSchedule' RETURNING settings)
    INSERT INTO audit_log(id,at,actor_id,actor_role,action,entity_type,entity_id,position,data)
      SELECT 'aud_service_fee_brackets_1792037400000',clock_timestamp(),NULL,'system','settings.operational_update','settings','operational',
        COALESCE((SELECT max(position) FROM audit_log),0)+1,
        jsonb_build_object('reason','Report 5A07D2C2 bracket rollout','detail',jsonb_build_object('previous',previous.settings,'current',changed.settings))
      FROM previous CROSS JOIN changed;
  `);
}
export async function down() { throw new Error('Service fee snapshots require a forward migration'); }
