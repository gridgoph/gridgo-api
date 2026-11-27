/** Express accept-first: the fee rule (schedule version 3) joins the database fee
 * function, so committed Express money is checked by the same arithmetic. Versions
 * 1 and 2 are copied unchanged; existing rows are not touched. Forward-only. */
export async function up(pgm) {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION gridgo_service_fee(principal numeric, schedule jsonb) RETURNS numeric
    LANGUAGE plpgsql IMMUTABLE AS $$
    DECLARE band jsonb; ceiling numeric; lower_bound numeric := 0; rate numeric;
      numerator numeric := 0; idx integer := 0; count_bands integer; result numeric;
      minimum numeric; step numeric; exact_total numeric;
    BEGIN
      IF principal IS NULL OR principal < 0 OR principal > 9007199254740991 OR principal <> trunc(principal)
        OR jsonb_typeof(schedule) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'invalid service fee input' USING ERRCODE='23514';
      END IF;
      IF schedule->'version' = '3'::jsonb THEN
        rate := (schedule->>'rateBps')::numeric;
        minimum := (schedule->>'minimumMinor')::numeric;
        step := (schedule->>'roundTotalUpToMinor')::numeric;
        IF schedule->>'rule' IS DISTINCT FROM 'express_minimum_or_rate'
          OR jsonb_typeof(schedule->'rateBps') IS DISTINCT FROM 'number' OR rate <> trunc(rate) OR rate < 0 OR rate > 10000
          OR jsonb_typeof(schedule->'minimumMinor') IS DISTINCT FROM 'number' OR minimum <> trunc(minimum) OR minimum < 0
          OR minimum > 9007199254740991 OR step IS DISTINCT FROM 50 THEN
          RAISE EXCEPTION 'invalid express fee rule' USING ERRCODE='23514';
        END IF;
        exact_total := principal * 10000 + CASE WHEN principal > 0 AND principal * rate >= minimum * 10000
          THEN principal * rate ELSE minimum * 10000 END;
        result := ceil(exact_total / (step * 10000)) * step - principal;
        IF principal + result > 9007199254740991 THEN RAISE EXCEPTION 'unsafe service fee total' USING ERRCODE='23514'; END IF;
        RETURN result;
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

    CREATE OR REPLACE FUNCTION guard_service_fee_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
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
          OR (COALESCE((NEW.data->>'voucherDeliveryMinor')::numeric,0) <> 0 AND NOT COALESCE((NEW.data->'voucher'->>'coversOrderTotal')::boolean,false)) THEN
          RAISE EXCEPTION 'invalid bracket fee snapshot' USING ERRCODE='23514';
        END IF;
      END IF;
      -- The Express rule exists only on Express orders. At commitment the shop is
      -- owed its full price; later refunds and settlements keep their own rules.
      IF NEW.data->'serviceFeeSchedule'->>'version'='3' AND NEW.commercial_committed_at IS NOT NULL THEN
        IF NEW.data->>'orderType' IS DISTINCT FROM 'express' OR NEW.service_fee_rate_bps IS NOT NULL
          OR (NEW.data->>'grossServiceFeeMinor')::numeric IS DISTINCT FROM
            gridgo_service_fee(NEW.supplier_subtotal_minor,NEW.data->'serviceFeeSchedule')
          OR ((TG_OP='INSERT' OR OLD.commercial_committed_at IS NULL)
            AND NEW.supplier_platform_payout_minor IS DISTINCT FROM NEW.supplier_subtotal_minor) THEN
          RAISE EXCEPTION 'invalid express fee snapshot' USING ERRCODE='23514';
        END IF;
      END IF;
      RETURN NEW;
    END $$;
  `);
}
export async function down() { throw new Error('Forward-only migration'); }
