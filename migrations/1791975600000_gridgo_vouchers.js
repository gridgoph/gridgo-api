/** GRIDGO funding is separate from gross delivery and supplier entitlements. */
export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE voucher_campaigns (
      id text PRIMARY KEY, name text NOT NULL, code text NOT NULL UNIQUE,
      mode text NOT NULL CHECK (mode IN ('assigned','shared')),
      status text NOT NULL CHECK (status IN ('draft','active','paused','ended')),
      value_minor money_minor NOT NULL CHECK (value_minor > 0),
      total_limit integer NOT NULL CHECK (total_limit BETWEEN 1 AND 1000000),
      per_account_limit integer NOT NULL CHECK (per_account_limit = 1),
      ends_at timestamptz, validity_days integer CHECK (validity_days BETWEEN 1 AND 365),
      created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
      CHECK ((ends_at IS NULL) <> (validity_days IS NULL))
    );
    CREATE TABLE vouchers (
      id text PRIMARY KEY, campaign_id text NOT NULL REFERENCES voucher_campaigns(id),
      client_id text NOT NULL REFERENCES users(id),
      status text NOT NULL CHECK (status IN ('available','used','void')),
      value_minor money_minor NOT NULL CHECK (value_minor > 0),
      issued_at timestamptz NOT NULL, expires_at timestamptz NOT NULL CHECK (expires_at > issued_at),
      email_allowed boolean NOT NULL DEFAULT false, data jsonb NOT NULL DEFAULT '{}',
      UNIQUE (campaign_id, client_id)
    );
    CREATE INDEX vouchers_wallet_idx ON vouchers(client_id, status, expires_at);
    CREATE TABLE voucher_reservations (
      id text PRIMARY KEY, voucher_id text NOT NULL REFERENCES vouchers(id),
      client_id text NOT NULL REFERENCES users(id), cart_id text NOT NULL REFERENCES client_carts(id),
      status text NOT NULL CHECK (status IN ('reserved','released','consumed')),
      expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL DEFAULT '{}'
    );
    CREATE UNIQUE INDEX voucher_one_reservation ON voucher_reservations(voucher_id) WHERE status = 'reserved';
    CREATE UNIQUE INDEX voucher_one_cart ON voucher_reservations(cart_id) WHERE status = 'reserved';
    CREATE TABLE voucher_redemptions (
      id text PRIMARY KEY, voucher_id text NOT NULL REFERENCES vouchers(id),
      reservation_id text NOT NULL UNIQUE REFERENCES voucher_reservations(id),
      client_id text NOT NULL REFERENCES users(id), amount_minor money_minor NOT NULL CHECK (amount_minor > 0),
      status text NOT NULL CHECK (status IN ('consumed','restored')), created_at timestamptz NOT NULL, data jsonb NOT NULL
    );
    CREATE UNIQUE INDEX voucher_one_use ON voucher_redemptions(voucher_id) WHERE status = 'consumed';
    CREATE TABLE voucher_ledger (
      id text PRIMARY KEY, voucher_id text NOT NULL REFERENCES vouchers(id),
      campaign_id text NOT NULL REFERENCES voucher_campaigns(id), client_id text NOT NULL REFERENCES users(id),
      kind text NOT NULL CHECK (kind IN ('issued','reserved','released','redeemed','restored','client_fault','no_fault','void','reissue')),
      amount_minor money_minor NOT NULL, at timestamptz NOT NULL, data jsonb NOT NULL
    );
    CREATE INDEX voucher_ledger_filter_idx ON voucher_ledger(campaign_id, client_id, at);
    CREATE FUNCTION voucher_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'voucher ledger is append only' USING ERRCODE = '23514'; END $$;
    CREATE TRIGGER voucher_ledger_immutable BEFORE UPDATE OR DELETE ON voucher_ledger FOR EACH ROW EXECUTE FUNCTION voucher_append_only();
    CREATE TABLE voucher_code_attempts (
      id text PRIMARY KEY REFERENCES users(id), window_at timestamptz NOT NULL,
      failures integer NOT NULL CHECK (failures >= 0), locked_until timestamptz
    );
    CREATE TABLE voucher_cart_choices (
      id text PRIMARY KEY REFERENCES client_carts(id), voucher_id text REFERENCES vouchers(id), removed boolean NOT NULL
    );
    CREATE TABLE voucher_email_outbox (
      id text PRIMARY KEY, voucher_id text NOT NULL REFERENCES vouchers(id), email text NOT NULL,
      subject text NOT NULL, body text NOT NULL, status text NOT NULL CHECK (status IN ('pending','sent','failed')),
      attempts integer NOT NULL DEFAULT 0, next_at timestamptz NOT NULL, created_at timestamptz NOT NULL
    );
    CREATE FUNCTION guard_voucher_order() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE v numeric; f numeric; d numeric;
    BEGIN
      IF TG_OP = 'UPDATE' AND OLD.commercial_committed_at IS NOT NULL AND
        (OLD.data->'voucher' IS DISTINCT FROM NEW.data->'voucher' OR
         OLD.data->'voucherDiscountMinor' IS DISTINCT FROM NEW.data->'voucherDiscountMinor' OR
         OLD.data->'voucherServiceFeeMinor' IS DISTINCT FROM NEW.data->'voucherServiceFeeMinor' OR
         OLD.data->'voucherDeliveryMinor' IS DISTINCT FROM NEW.data->'voucherDeliveryMinor') THEN
        RAISE EXCEPTION 'voucher money snapshot is immutable' USING ERRCODE = '23514';
      END IF;
      IF NOT NEW.data ? 'voucher' THEN RETURN NEW; END IF;
      v := (NEW.data->>'voucherDiscountMinor')::numeric;
      f := (NEW.data->>'voucherServiceFeeMinor')::numeric;
      d := (NEW.data->>'voucherDeliveryMinor')::numeric;
      IF NEW.money_model_version <> 3 OR v IS NULL OR f IS NULL OR d IS NULL
        OR v <> trunc(v) OR f <> trunc(f) OR d <> trunc(d) OR v <= 0 OR f < 0 OR d < 0
        OR v <> f + d OR f > NEW.service_fee_minor OR d > NEW.delivery_fee_minor
        OR (d > 0 AND f <> NEW.service_fee_minor)
        OR COALESCE((NEW.data->>'organizationDiscountMinor')::numeric, 0) <> 0
        OR NEW.total_minor <> NEW.supplier_subtotal_minor + NEW.service_fee_minor + NEW.delivery_fee_minor - v
        OR NEW.online_due_minor <> NEW.total_minor OR NEW.supplier_platform_payout_minor <> NEW.supplier_subtotal_minor
        OR NEW.data->'voucher'->>'fundedBy' IS DISTINCT FROM 'GRIDGO' THEN
        RAISE EXCEPTION 'invalid GRIDGO-funded voucher snapshot' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER voucher_order_guard BEFORE INSERT OR UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION guard_voucher_order();
    CREATE FUNCTION validate_voucher_allocations() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target text; o orders%ROWTYPE; principal bigint; fee bigint; delivery bigint; payments bigint;
    BEGIN
      IF TG_TABLE_NAME = 'orders' THEN target := NEW.id; ELSE target := COALESCE(NEW.order_id, OLD.order_id); END IF;
      SELECT * INTO o FROM orders WHERE id = target;
      IF NOT o.data ? 'voucher' THEN RETURN NULL; END IF;
      SELECT COALESCE(sum(amount_minor) FILTER (WHERE component='supplier_principal'),0),
        COALESCE(sum(amount_minor) FILTER (WHERE component='service_fee'),0),
        COALESCE(sum(amount_minor) FILTER (WHERE component='delivery_pass_through'),0)
        INTO principal, fee, delivery FROM order_payment_allocations WHERE order_id=target;
      SELECT sum(amount_minor) INTO payments FROM order_payments WHERE order_id=target;
      IF principal <> o.supplier_subtotal_minor OR fee <> o.service_fee_minor - (o.data->>'voucherServiceFeeMinor')::bigint
        OR delivery <> o.delivery_fee_minor - (o.data->>'voucherDeliveryMinor')::bigint OR payments IS DISTINCT FROM o.total_minor
        OR EXISTS (SELECT 1 FROM order_payments p WHERE p.order_id=target AND p.amount_minor <>
          (SELECT COALESCE(sum(a.amount_minor),0) FROM order_payment_allocations a WHERE a.order_id=target AND a.payment_code=p.code)) THEN
        RAISE EXCEPTION 'voucher payment allocations do not reconcile' USING ERRCODE = '23514';
      END IF;
      RETURN NULL;
    END $$;
    CREATE CONSTRAINT TRIGGER voucher_order_allocations AFTER INSERT OR UPDATE ON orders
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_voucher_allocations();
    CREATE CONSTRAINT TRIGGER voucher_payment_allocations AFTER INSERT OR UPDATE OR DELETE ON order_payment_allocations
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_voucher_allocations();
    CREATE CONSTRAINT TRIGGER voucher_payments AFTER INSERT OR UPDATE OR DELETE ON order_payments
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_voucher_allocations();
  `);
  pgm.sql(`
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
        OR rate <> trunc(rate) OR rate < 0 OR rate > NEW.service_fee_rate_bps
        OR gross <> floor((NEW.supplier_subtotal_minor::numeric * NEW.service_fee_rate_bps + 5000) / 10000)
        OR discount <> floor((NEW.supplier_subtotal_minor::numeric * rate + 5000) / 10000)
        OR NEW.service_fee_minor IS DISTINCT FROM gross - discount
        OR NEW.total_minor IS DISTINCT FROM NEW.supplier_subtotal_minor + NEW.service_fee_minor + NEW.delivery_fee_minor - COALESCE((NEW.data->>'voucherDiscountMinor')::bigint, 0)
        OR NEW.supplier_platform_payout_minor IS DISTINCT FROM NEW.supplier_subtotal_minor - NEW.direct_store_due_minor THEN
        RAISE EXCEPTION 'organization discount must be funded only from service fee' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END $$;
  `);
}
export async function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM voucher_campaigns)
        OR EXISTS (SELECT 1 FROM voucher_code_attempts)
        OR EXISTS (SELECT 1 FROM voucher_cart_choices)
        OR EXISTS (SELECT 1 FROM orders WHERE data ? 'voucher') THEN
        RAISE EXCEPTION 'Vouchers require a forward migration once used';
      END IF;
    END $$;
    DROP TRIGGER voucher_order_guard ON orders;
    DROP TRIGGER voucher_order_allocations ON orders;
    DROP TRIGGER voucher_payment_allocations ON order_payment_allocations;
    DROP TRIGGER voucher_payments ON order_payments;
    DROP FUNCTION guard_voucher_order();
    DROP FUNCTION validate_voucher_allocations();
    DROP TABLE voucher_email_outbox, voucher_cart_choices, voucher_code_attempts,
      voucher_ledger, voucher_redemptions, voucher_reservations, vouchers, voucher_campaigns;
    DROP FUNCTION voucher_append_only();
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
  `);
}
