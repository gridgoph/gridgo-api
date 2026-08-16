export async function up(pgm) {
  pgm.sql(`
    UPDATE platform_settings
       SET settings = settings
         || CASE WHEN settings ? 'serviceFeeRateBps' THEN '{}'::jsonb
                 ELSE '{"serviceFeeRateBps":1000}'::jsonb END,
           version = version + CASE
             WHEN settings ? 'serviceFeeRateBps' THEN 0
             ELSE 1
           END;

    ALTER TABLE orders RENAME COLUMN supplier_price_minor TO supplier_subtotal_minor;

    DO $$
    DECLARE constraint_record record;
    BEGIN
      FOR constraint_record IN
        SELECT DISTINCT constraint_name
          FROM information_schema.constraint_column_usage
         WHERE table_schema = current_schema()
           AND table_name = 'orders'
           AND column_name IN (
             'supplier_subtotal_minor', 'commission_minor', 'subtotal_minor',
             'delivery_fee_minor', 'total_minor', 'downpayment_minor', 'balance_minor'
           )
      LOOP
        EXECUTE format('ALTER TABLE orders DROP CONSTRAINT %I', constraint_record.constraint_name);
      END LOOP;
    END;
    $$;

    ALTER TABLE orders
      ADD COLUMN fulfillment_mode text
        CHECK (fulfillment_mode IN ('delivery','pickup')),
      ADD COLUMN payment_plan text
        CHECK (payment_plan IN
          ('delivery_online','pickup_full_online','pickup_downpayment_store')),
      ADD COLUMN quote_version integer CHECK (quote_version > 0),
      ADD COLUMN service_fee_rate_bps integer
        CHECK (service_fee_rate_bps BETWEEN 0 AND 10000),
      ADD COLUMN service_fee_minor money_minor CHECK (service_fee_minor >= 0),
      ADD COLUMN supplier_downpayment_rate_bps integer
        CHECK (supplier_downpayment_rate_bps IN (0,2500,5000,10000)),
      ADD COLUMN online_due_minor money_minor CHECK (online_due_minor >= 0),
      ADD COLUMN direct_store_due_minor money_minor CHECK (direct_store_due_minor >= 0),
      ADD COLUMN supplier_platform_payout_minor money_minor
        CHECK (supplier_platform_payout_minor >= 0),
      ADD COLUMN commercial_committed_at timestamptz,
      ADD COLUMN money_model_version integer NOT NULL DEFAULT 1
        CHECK (money_model_version IN (1,2));

    UPDATE orders
       SET fulfillment_mode = CASE WHEN supplier_subtotal_minor IS NULL THEN NULL ELSE 'delivery' END,
           payment_plan = CASE WHEN supplier_subtotal_minor IS NULL THEN NULL ELSE 'delivery_online' END,
           quote_version = CASE WHEN supplier_subtotal_minor IS NULL THEN NULL ELSE 1 END,
           service_fee_rate_bps = CASE WHEN supplier_subtotal_minor IS NULL THEN NULL ELSE 1000 END,
           service_fee_minor = commission_minor,
           subtotal_minor = supplier_subtotal_minor,
           online_due_minor = total_minor,
           direct_store_due_minor = CASE WHEN supplier_subtotal_minor IS NULL THEN NULL ELSE 0 END,
           supplier_platform_payout_minor = supplier_subtotal_minor,
           commercial_committed_at = CASE WHEN supplier_subtotal_minor IS NULL THEN NULL ELSE updated_at END,
           money_model_version = 1;

    ALTER TABLE orders DROP COLUMN commission_minor;
    ALTER TABLE orders DROP COLUMN downpayment_minor;
    ALTER TABLE orders DROP COLUMN balance_minor;

    DO $$
    DECLARE state_constraint text;
    BEGIN
      SELECT conname INTO state_constraint
        FROM pg_constraint
       WHERE conrelid = 'orders'::regclass
         AND contype = 'c'
         AND pg_get_constraintdef(oid) LIKE '%state%'
       ORDER BY oid
       LIMIT 1;
      IF state_constraint IS NOT NULL THEN
        EXECUTE format('ALTER TABLE orders DROP CONSTRAINT %I', state_constraint);
      END IF;
    END;
    $$;

    ALTER TABLE orders
      ADD CONSTRAINT orders_state_check CHECK (state IN (
        'draft', 'submitted', 'needs_qa', 'client_correction', 'proof_approval',
        'approved_for_matching', 'supplier_assigned', 'awaiting_checkout',
        'awaiting_initial_payment', 'initial_payment_review',
        'awaiting_downpayment', 'downpayment_review', 'payment_authorized',
        'production', 'supplier_self_qc', 'ready_for_dispatch',
        'rider_assigned', 'picked_up', 'out_for_delivery', 'delivered',
        'issue_window_open', 'completed', 'payout_released'
      )),
      ADD CONSTRAINT orders_supplier_subtotal_nonnegative_check
        CHECK (supplier_subtotal_minor IS NULL OR supplier_subtotal_minor >= 0),
      ADD CONSTRAINT orders_subtotal_nonnegative_check
        CHECK (subtotal_minor IS NULL OR subtotal_minor >= 0),
      ADD CONSTRAINT orders_delivery_fee_nonnegative_check
        CHECK (delivery_fee_minor IS NULL OR delivery_fee_minor >= 0),
      ADD CONSTRAINT orders_total_nonnegative_check
        CHECK (total_minor IS NULL OR total_minor >= 0),
      ALTER COLUMN dropoff_lat DROP NOT NULL,
      ALTER COLUMN dropoff_lng DROP NOT NULL,
      ALTER COLUMN dropoff_label DROP NOT NULL,
      DROP CONSTRAINT orders_dropoff_label_check;

    ALTER TABLE order_payments DROP CONSTRAINT order_payments_code_check;
    ALTER TABLE order_payments DROP CONSTRAINT order_payments_method_check;
    UPDATE order_payments
       SET code = CASE code WHEN 'downpayment' THEN 'initial' ELSE 'final_online' END;
    ALTER TABLE order_payments
      ADD CONSTRAINT order_payments_code_check
        CHECK (code IN ('initial','final_online')),
      ADD CONSTRAINT order_payments_method_check
        CHECK (method IN ('qr_manual','provider_online'));

    CREATE TABLE order_payment_allocations (
      order_id text NOT NULL,
      payment_code text NOT NULL,
      component text NOT NULL CHECK (component IN
        ('supplier_principal','service_fee','delivery_pass_through')),
      amount_minor money_minor NOT NULL CHECK (amount_minor >= 0),
      PRIMARY KEY (order_id, payment_code, component),
      FOREIGN KEY (order_id, payment_code)
        REFERENCES order_payments(order_id, code)
        ON UPDATE CASCADE ON DELETE CASCADE
    );
    CREATE INDEX order_payment_allocations_component_idx
      ON order_payment_allocations (component, order_id);

    CREATE TABLE platform_revenue_adjustments (
      id text PRIMARY KEY,
      order_id text NOT NULL REFERENCES orders(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      kind text NOT NULL CHECK (kind IN ('refund','adjustment')),
      amount_minor money_minor NOT NULL CHECK (amount_minor < 0),
      reason text NOT NULL CHECK (btrim(reason) <> ''),
      created_by text REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at timestamptz NOT NULL
    );
    CREATE INDEX platform_revenue_adjustments_order_idx
      ON platform_revenue_adjustments (order_id, created_at);

    CREATE FUNCTION reject_platform_revenue_adjustment_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'platform revenue adjustments are append-only'
        USING ERRCODE = '42501';
    END;
    $$;
    CREATE TRIGGER platform_revenue_adjustments_append_only_trigger
      BEFORE UPDATE OR DELETE ON platform_revenue_adjustments
      FOR EACH ROW EXECUTE FUNCTION reject_platform_revenue_adjustment_mutation();

    INSERT INTO order_payment_allocations
      (order_id, payment_code, component, amount_minor)
    SELECT payment.order_id, payment.code, 'service_fee',
           LEAST(payment.amount_minor, COALESCE(orders.service_fee_minor, 0))
      FROM order_payments payment
      JOIN orders ON orders.id = payment.order_id
     WHERE payment.code = 'initial'
       AND payment.amount_minor IS NOT NULL
       AND orders.supplier_subtotal_minor IS NOT NULL;

    INSERT INTO order_payment_allocations
      (order_id, payment_code, component, amount_minor)
    SELECT payment.order_id, payment.code, 'supplier_principal',
           LEAST(
             orders.supplier_subtotal_minor,
             GREATEST(payment.amount_minor - COALESCE(orders.service_fee_minor, 0), 0)
           )
      FROM order_payments payment
      JOIN orders ON orders.id = payment.order_id
     WHERE payment.code = 'initial'
       AND payment.amount_minor IS NOT NULL
       AND orders.supplier_subtotal_minor IS NOT NULL;

    INSERT INTO order_payment_allocations
      (order_id, payment_code, component, amount_minor)
    SELECT payment.order_id, payment.code, 'delivery_pass_through',
           GREATEST(
             payment.amount_minor - COALESCE(orders.service_fee_minor, 0)
               - LEAST(orders.supplier_subtotal_minor,
                   GREATEST(payment.amount_minor - COALESCE(orders.service_fee_minor, 0), 0)),
             0
           )
      FROM order_payments payment
      JOIN orders ON orders.id = payment.order_id
     WHERE payment.code = 'initial'
       AND payment.amount_minor IS NOT NULL
       AND orders.supplier_subtotal_minor IS NOT NULL;

    INSERT INTO order_payment_allocations
      (order_id, payment_code, component, amount_minor)
    SELECT payment.order_id, payment.code, 'supplier_principal',
           LEAST(
             payment.amount_minor,
             GREATEST(
               orders.supplier_subtotal_minor
                 - COALESCE((
                     SELECT amount_minor FROM order_payment_allocations allocation
                      WHERE allocation.order_id = payment.order_id
                        AND allocation.payment_code = 'initial'
                        AND allocation.component = 'supplier_principal'
                   ), 0),
               0
             )
           )
      FROM order_payments payment
      JOIN orders ON orders.id = payment.order_id
     WHERE payment.code = 'final_online'
       AND payment.amount_minor IS NOT NULL
       AND orders.supplier_subtotal_minor IS NOT NULL;

    INSERT INTO order_payment_allocations
      (order_id, payment_code, component, amount_minor)
    SELECT payment.order_id, payment.code, 'delivery_pass_through',
           payment.amount_minor - COALESCE((
             SELECT amount_minor FROM order_payment_allocations allocation
              WHERE allocation.order_id = payment.order_id
                AND allocation.payment_code = 'final_online'
                AND allocation.component = 'supplier_principal'
           ), 0)
      FROM order_payments payment
     WHERE payment.code = 'final_online'
       AND payment.amount_minor IS NOT NULL;

    ALTER TABLE payout_milestones DROP CONSTRAINT payout_milestones_code_check;
    ALTER TABLE payout_milestones
      ADD CONSTRAINT payout_milestones_code_check CHECK (code IN
        ('printing','packaging_qc','delivered','pickup_handover','retention','initial','completion'));
    ALTER TABLE payout_milestones DROP CONSTRAINT payout_milestones_status_check;
    ALTER TABLE payout_milestones
      ADD CONSTRAINT payout_milestones_status_check CHECK (status IN
        ('pending','pending_pof','pof_attached','released'));

    CREATE TABLE supplier_payment_terms (
      supplier_id text PRIMARY KEY REFERENCES supplier_profiles(user_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      delivery_downpayment_rate_bps integer NOT NULL DEFAULT 0
        CHECK (delivery_downpayment_rate_bps IN (0,2500,5000)),
      pickup_full_online_enabled boolean NOT NULL DEFAULT true,
      pickup_downpayment_store_enabled boolean NOT NULL DEFAULT false,
      pickup_downpayment_rate_bps integer
        CHECK (pickup_downpayment_rate_bps IN (2500,5000)),
      updated_at timestamptz NOT NULL,
      CHECK (pickup_downpayment_store_enabled =
        (pickup_downpayment_rate_bps IS NOT NULL))
    );

    INSERT INTO supplier_payment_terms (supplier_id, updated_at)
    SELECT user_id, updated_at FROM supplier_profiles;

    CREATE FUNCTION enforce_supplier_pickup_terms()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE supplier_key text;
    DECLARE profile supplier_profiles%ROWTYPE;
    DECLARE terms supplier_payment_terms%ROWTYPE;
    BEGIN
      IF TG_TABLE_NAME = 'supplier_payment_terms' AND TG_OP = 'UPDATE' AND
         NEW.supplier_id IS DISTINCT FROM OLD.supplier_id THEN
        RAISE EXCEPTION 'supplier payment terms cannot be reassigned'
          USING ERRCODE = '23514',
                CONSTRAINT = 'supplier_payment_terms_supplier_immutable';
      END IF;
      IF TG_OP = 'DELETE' THEN
        supplier_key := OLD.supplier_id;
      ELSIF TG_TABLE_NAME = 'supplier_profiles' THEN
        supplier_key := NEW.user_id;
      ELSE
        supplier_key := NEW.supplier_id;
      END IF;
      SELECT * INTO profile FROM supplier_profiles
       WHERE user_id = supplier_key;
      SELECT * INTO terms FROM supplier_payment_terms
       WHERE supplier_id = supplier_key;
      IF profile.pickup_available AND
         (terms.supplier_id IS NULL OR NOT (
           terms.pickup_full_online_enabled OR terms.pickup_downpayment_store_enabled
         )) THEN
        RAISE EXCEPTION 'pickup requires at least one enabled payment mode'
          USING ERRCODE = '23514',
                CONSTRAINT = 'supplier_payment_terms_pickup_mode_check';
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $$;

    CREATE CONSTRAINT TRIGGER supplier_profiles_pickup_terms_trigger
      AFTER INSERT OR UPDATE OF pickup_available ON supplier_profiles
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION enforce_supplier_pickup_terms();
    CREATE CONSTRAINT TRIGGER supplier_payment_terms_pickup_mode_trigger
      AFTER INSERT OR UPDATE OR DELETE ON supplier_payment_terms
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION enforce_supplier_pickup_terms();

    CREATE FUNCTION validate_order_financial_children(target_order_id text)
    RETURNS void
    LANGUAGE plpgsql
    AS $$
    DECLARE committed orders%ROWTYPE;
    DECLARE expected_downpayment bigint;
    DECLARE expected_remainder bigint;
    DECLARE expected_initial_payout bigint;
    DECLARE expected_completion_payout bigint;
    DECLARE initial_amount bigint;
    DECLARE final_amount bigint;
    DECLARE payout_sum bigint;
    DECLARE confirmed_supplier_principal bigint;
    DECLARE released_supplier_principal bigint;
    BEGIN
      SELECT * INTO committed FROM orders WHERE id = target_order_id;
      IF committed.id IS NULL OR committed.money_model_version <> 2 OR
         committed.commercial_committed_at IS NULL THEN
        RETURN;
      END IF;
      expected_downpayment := floor(
        (committed.supplier_subtotal_minor::numeric * committed.supplier_downpayment_rate_bps + 5000) / 10000
      );
      expected_remainder := committed.supplier_subtotal_minor - expected_downpayment;
      expected_initial_payout := LEAST(expected_downpayment, committed.supplier_platform_payout_minor);
      expected_completion_payout := committed.supplier_platform_payout_minor - expected_initial_payout;

      SELECT amount_minor INTO initial_amount FROM order_payments
       WHERE order_id = committed.id AND code = 'initial';
      SELECT amount_minor INTO final_amount FROM order_payments
       WHERE order_id = committed.id AND code = 'final_online';
      IF initial_amount IS DISTINCT FROM expected_downpayment + committed.service_fee_minor OR
         (SELECT count(*) FROM order_payment_allocations
           WHERE order_id = committed.id AND payment_code = 'initial') <> 2 OR
         (SELECT amount_minor FROM order_payment_allocations
           WHERE order_id = committed.id AND payment_code = 'initial' AND component = 'supplier_principal')
           IS DISTINCT FROM expected_downpayment OR
         (SELECT amount_minor FROM order_payment_allocations
           WHERE order_id = committed.id AND payment_code = 'initial' AND component = 'service_fee')
           IS DISTINCT FROM committed.service_fee_minor THEN
        RAISE EXCEPTION 'initial payment allocations do not match committed order'
          USING ERRCODE = '23514', CONSTRAINT = 'order_payment_allocations_shape_check';
      END IF;

      IF committed.payment_plan = 'delivery_online' THEN
        IF final_amount IS DISTINCT FROM expected_remainder + committed.delivery_fee_minor OR
           (SELECT count(*) FROM order_payment_allocations
             WHERE order_id = committed.id AND payment_code = 'final_online') <> 2 OR
           (SELECT amount_minor FROM order_payment_allocations
             WHERE order_id = committed.id AND payment_code = 'final_online' AND component = 'supplier_principal')
             IS DISTINCT FROM expected_remainder OR
           (SELECT amount_minor FROM order_payment_allocations
             WHERE order_id = committed.id AND payment_code = 'final_online' AND component = 'delivery_pass_through')
             IS DISTINCT FROM committed.delivery_fee_minor THEN
          RAISE EXCEPTION 'final payment allocations do not match committed delivery order'
            USING ERRCODE = '23514', CONSTRAINT = 'order_payment_allocations_shape_check';
        END IF;
      ELSIF final_amount IS NOT NULL OR EXISTS (
        SELECT 1 FROM order_payment_allocations
         WHERE order_id = committed.id AND payment_code = 'final_online'
      ) THEN
        RAISE EXCEPTION 'pickup order cannot have a final online payment'
          USING ERRCODE = '23514', CONSTRAINT = 'order_payment_allocations_shape_check';
      END IF;

      SELECT COALESCE(sum(amount_minor), 0) INTO payout_sum
        FROM payout_milestones WHERE order_id = committed.id;
      IF payout_sum <> committed.supplier_platform_payout_minor OR
         EXISTS (SELECT 1 FROM payout_milestones
                  WHERE order_id = committed.id AND code NOT IN ('initial','completion')) OR
         (committed.supplier_downpayment_rate_bps = 0 AND (
           (SELECT count(*) FROM payout_milestones WHERE order_id = committed.id) <> 1 OR
           (SELECT amount_minor FROM payout_milestones
             WHERE order_id = committed.id AND code = 'completion')
             IS DISTINCT FROM expected_completion_payout
         )) OR
         (committed.supplier_downpayment_rate_bps > 0 AND (
           (SELECT count(*) FROM payout_milestones WHERE order_id = committed.id) <>
             1 + CASE WHEN expected_completion_payout > 0 THEN 1 ELSE 0 END OR
           (SELECT amount_minor FROM payout_milestones
             WHERE order_id = committed.id AND code = 'initial')
             IS DISTINCT FROM expected_initial_payout OR
           (expected_completion_payout > 0 AND
             (SELECT amount_minor FROM payout_milestones
               WHERE order_id = committed.id AND code = 'completion')
               IS DISTINCT FROM expected_completion_payout) OR
           (expected_completion_payout = 0 AND EXISTS (
             SELECT 1 FROM payout_milestones
              WHERE order_id = committed.id AND code = 'completion'
           ))
         )) THEN
        RAISE EXCEPTION 'payout milestones do not match committed supplier payout'
          USING ERRCODE = '23514', CONSTRAINT = 'payout_milestones_amount_check';
      END IF;

      SELECT COALESCE(sum(allocation.amount_minor), 0)
        INTO confirmed_supplier_principal
        FROM order_payment_allocations allocation
        JOIN order_payments payment
          ON payment.order_id = allocation.order_id
         AND payment.code = allocation.payment_code
       WHERE allocation.order_id = committed.id
         AND allocation.component = 'supplier_principal'
         AND payment.status = 'confirmed';
      SELECT COALESCE(sum(amount_minor), 0)
        INTO released_supplier_principal
        FROM payout_milestones
       WHERE order_id = committed.id
         AND status = 'released';
      IF released_supplier_principal > confirmed_supplier_principal THEN
        RAISE EXCEPTION 'released payout exceeds confirmed supplier principal'
          USING ERRCODE = '23514',
                CONSTRAINT = 'payout_milestones_collected_principal_check';
      END IF;
    END;
    $$;

    CREATE FUNCTION enforce_changed_order_financial_children()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        PERFORM validate_order_financial_children(OLD.order_id);
        RETURN OLD;
      END IF;
      IF TG_OP = 'UPDATE' AND NEW.order_id IS DISTINCT FROM OLD.order_id THEN
        PERFORM validate_order_financial_children(OLD.order_id);
      END IF;
      PERFORM validate_order_financial_children(NEW.order_id);
      RETURN NEW;
    END;
    $$;

    CREATE CONSTRAINT TRIGGER order_payments_financial_shape_trigger
      AFTER INSERT OR UPDATE OR DELETE ON order_payments
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION enforce_changed_order_financial_children();
    CREATE CONSTRAINT TRIGGER order_payment_allocations_financial_shape_trigger
      AFTER INSERT OR UPDATE OR DELETE ON order_payment_allocations
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION enforce_changed_order_financial_children();
    CREATE CONSTRAINT TRIGGER payout_milestones_financial_shape_trigger
      AFTER INSERT OR UPDATE OR DELETE ON payout_milestones
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION enforce_changed_order_financial_children();

    CREATE FUNCTION enforce_committed_order_money()
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
      IF NEW.service_fee_minor <> expected_fee OR
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

    CREATE CONSTRAINT TRIGGER orders_committed_money_trigger
      AFTER INSERT OR UPDATE ON orders
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION enforce_committed_order_money();

    CREATE FUNCTION protect_committed_order_money()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF OLD.commercial_committed_at IS NOT NULL AND
         OLD.state = 'awaiting_initial_payment' AND
         NEW.state = 'awaiting_checkout' AND
         NEW.commercial_committed_at IS NULL AND
         NEW.money_model_version IS NOT DISTINCT FROM OLD.money_model_version AND
         NOT EXISTS (SELECT 1 FROM order_payments WHERE order_id = OLD.id) THEN
        RETURN NEW;
      END IF;
      IF OLD.commercial_committed_at IS NOT NULL AND (
        NEW.money_model_version IS DISTINCT FROM OLD.money_model_version OR
        NEW.supplier_subtotal_minor IS DISTINCT FROM OLD.supplier_subtotal_minor OR
        NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor OR
        NEW.service_fee_rate_bps IS DISTINCT FROM OLD.service_fee_rate_bps OR
        NEW.service_fee_minor IS DISTINCT FROM OLD.service_fee_minor OR
        NEW.delivery_fee_minor IS DISTINCT FROM OLD.delivery_fee_minor OR
        NEW.total_minor IS DISTINCT FROM OLD.total_minor OR
        NEW.fulfillment_mode IS DISTINCT FROM OLD.fulfillment_mode OR
        NEW.payment_plan IS DISTINCT FROM OLD.payment_plan OR
        NEW.quote_version IS DISTINCT FROM OLD.quote_version OR
        NEW.supplier_downpayment_rate_bps IS DISTINCT FROM OLD.supplier_downpayment_rate_bps OR
        NEW.online_due_minor IS DISTINCT FROM OLD.online_due_minor OR
        NEW.direct_store_due_minor IS DISTINCT FROM OLD.direct_store_due_minor OR
        NEW.supplier_platform_payout_minor IS DISTINCT FROM OLD.supplier_platform_payout_minor OR
        NEW.pickup_lat IS DISTINCT FROM OLD.pickup_lat OR
        NEW.pickup_lng IS DISTINCT FROM OLD.pickup_lng OR
        NEW.pickup_label IS DISTINCT FROM OLD.pickup_label OR
        NEW.dropoff_lat IS DISTINCT FROM OLD.dropoff_lat OR
        NEW.dropoff_lng IS DISTINCT FROM OLD.dropoff_lng OR
        NEW.dropoff_label IS DISTINCT FROM OLD.dropoff_label OR
        NEW.commercial_committed_at IS DISTINCT FROM OLD.commercial_committed_at
        OR NEW.data->'acceptedQuote' IS DISTINCT FROM OLD.data->'acceptedQuote'
        OR NEW.data->'promisedDate' IS DISTINCT FROM OLD.data->'promisedDate'
        OR NEW.data->'deliveryDistanceMeters' IS DISTINCT FROM OLD.data->'deliveryDistanceMeters'
        OR NEW.data->'initialSupplierPrincipalMinor' IS DISTINCT FROM OLD.data->'initialSupplierPrincipalMinor'
        OR NEW.data->'supplierRemainderMinor' IS DISTINCT FROM OLD.data->'supplierRemainderMinor'
        OR NEW.data->'initialOnlineMinor' IS DISTINCT FROM OLD.data->'initialOnlineMinor'
        OR NEW.data->'finalOnlineMinor' IS DISTINCT FROM OLD.data->'finalOnlineMinor'
      ) THEN
        RAISE EXCEPTION 'committed order money and fulfillment snapshots are immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'orders_committed_snapshot_immutable';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER orders_committed_money_immutable_trigger
      BEFORE UPDATE ON orders
      FOR EACH ROW EXECUTE FUNCTION protect_committed_order_money();
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP TRIGGER IF EXISTS orders_committed_money_immutable_trigger ON orders;
    DROP FUNCTION IF EXISTS protect_committed_order_money();
    DROP TRIGGER IF EXISTS orders_committed_money_trigger ON orders;
    DROP FUNCTION IF EXISTS enforce_committed_order_money();
    DROP TRIGGER IF EXISTS payout_milestones_financial_shape_trigger ON payout_milestones;
    DROP TRIGGER IF EXISTS order_payment_allocations_financial_shape_trigger ON order_payment_allocations;
    DROP TRIGGER IF EXISTS order_payments_financial_shape_trigger ON order_payments;
    DROP FUNCTION IF EXISTS enforce_changed_order_financial_children();
    DROP FUNCTION IF EXISTS validate_order_financial_children(text);
    DROP TRIGGER IF EXISTS supplier_payment_terms_pickup_mode_trigger ON supplier_payment_terms;
    DROP TRIGGER IF EXISTS supplier_profiles_pickup_terms_trigger ON supplier_profiles;
    DROP FUNCTION IF EXISTS enforce_supplier_pickup_terms();
    DROP TABLE supplier_payment_terms;

    ALTER TABLE payout_milestones DROP CONSTRAINT payout_milestones_code_check;
    ALTER TABLE payout_milestones DROP CONSTRAINT payout_milestones_status_check;
    DELETE FROM payout_milestones WHERE code IN ('pickup_handover','initial','completion');
    ALTER TABLE payout_milestones ADD CONSTRAINT payout_milestones_code_check
      CHECK (code IN ('printing','packaging_qc','delivered','retention'));
    ALTER TABLE payout_milestones ADD CONSTRAINT payout_milestones_status_check
      CHECK (status IN ('pending_pof','pof_attached','released'));

    DROP TABLE order_payment_allocations;
    DROP TRIGGER IF EXISTS platform_revenue_adjustments_append_only_trigger ON platform_revenue_adjustments;
    DROP FUNCTION IF EXISTS reject_platform_revenue_adjustment_mutation();
    DROP TABLE platform_revenue_adjustments;
    ALTER TABLE order_payments DROP CONSTRAINT order_payments_code_check;
    ALTER TABLE order_payments DROP CONSTRAINT order_payments_method_check;
    UPDATE order_payments
       SET code = CASE code WHEN 'initial' THEN 'downpayment' ELSE 'balance' END,
           method = 'qr_manual';
    ALTER TABLE order_payments
      ADD CONSTRAINT order_payments_code_check CHECK (code IN ('downpayment','balance')),
      ADD CONSTRAINT order_payments_method_check CHECK (method = 'qr_manual');

    UPDATE orders SET state = CASE state
      WHEN 'awaiting_checkout' THEN 'supplier_assigned'
      WHEN 'awaiting_initial_payment' THEN 'awaiting_downpayment'
      WHEN 'initial_payment_review' THEN 'downpayment_review'
      ELSE state
    END;

    ALTER TABLE orders
      ADD COLUMN commission_minor money_minor,
      ADD COLUMN downpayment_minor money_minor,
      ADD COLUMN balance_minor money_minor;
    UPDATE orders
       SET commission_minor = service_fee_minor,
           subtotal_minor = supplier_subtotal_minor + service_fee_minor,
           downpayment_minor = (SELECT amount_minor FROM order_payments
             WHERE order_id = orders.id AND code = 'downpayment'),
           balance_minor = (SELECT amount_minor FROM order_payments
             WHERE order_id = orders.id AND code = 'balance'),
           dropoff_lat = COALESCE(dropoff_lat, pickup_lat, 0),
           dropoff_lng = COALESCE(dropoff_lng, pickup_lng, 0),
           dropoff_label = COALESCE(NULLIF(dropoff_label, ''), pickup_label, 'Legacy pickup');
    UPDATE orders
       SET downpayment_minor = COALESCE(downpayment_minor, total_minor),
           balance_minor = COALESCE(
             balance_minor,
             total_minor - COALESCE(downpayment_minor, total_minor)
           )
     WHERE supplier_subtotal_minor IS NOT NULL;
    INSERT INTO order_payments
      (order_id, code, amount_minor, method, status, position, data)
    SELECT id, 'balance', balance_minor, 'qr_manual', 'not_submitted', 1, '{}'
      FROM orders
     WHERE supplier_subtotal_minor IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM order_payments payment
          WHERE payment.order_id = orders.id AND payment.code = 'balance'
       );

    ALTER TABLE orders
      DROP CONSTRAINT orders_state_check,
      DROP CONSTRAINT orders_supplier_subtotal_nonnegative_check,
      DROP CONSTRAINT orders_subtotal_nonnegative_check,
      DROP CONSTRAINT orders_delivery_fee_nonnegative_check,
      DROP CONSTRAINT orders_total_nonnegative_check,
      DROP COLUMN fulfillment_mode,
      DROP COLUMN payment_plan,
      DROP COLUMN quote_version,
      DROP COLUMN service_fee_rate_bps,
      DROP COLUMN service_fee_minor,
      DROP COLUMN supplier_downpayment_rate_bps,
      DROP COLUMN online_due_minor,
      DROP COLUMN direct_store_due_minor,
      DROP COLUMN supplier_platform_payout_minor,
      DROP COLUMN commercial_committed_at,
      DROP COLUMN money_model_version,
      ALTER COLUMN dropoff_lat SET NOT NULL,
      ALTER COLUMN dropoff_lng SET NOT NULL,
      ALTER COLUMN dropoff_label SET NOT NULL,
      ADD CONSTRAINT orders_state_check CHECK (state IN (
        'draft', 'submitted', 'needs_qa', 'client_correction', 'proof_approval',
        'approved_for_matching', 'supplier_assigned', 'awaiting_downpayment',
        'downpayment_review', 'payment_authorized', 'production', 'supplier_self_qc',
        'ready_for_dispatch', 'rider_assigned', 'picked_up', 'out_for_delivery',
        'delivered', 'issue_window_open', 'completed', 'payout_released'
      )),
      ADD CONSTRAINT orders_supplier_price_minor_check
        CHECK (supplier_subtotal_minor IS NULL OR supplier_subtotal_minor >= 0),
      ADD CONSTRAINT orders_commission_minor_check
        CHECK (commission_minor IS NULL OR commission_minor >= 0),
      ADD CONSTRAINT orders_subtotal_minor_check
        CHECK (subtotal_minor IS NULL OR subtotal_minor >= 0),
      ADD CONSTRAINT orders_delivery_fee_minor_check
        CHECK (delivery_fee_minor IS NULL OR delivery_fee_minor >= 0),
      ADD CONSTRAINT orders_total_minor_check
        CHECK (total_minor IS NULL OR total_minor >= 0),
      ADD CONSTRAINT orders_downpayment_minor_check
        CHECK (downpayment_minor IS NULL OR downpayment_minor >= 0),
      ADD CONSTRAINT orders_balance_minor_check
        CHECK (balance_minor IS NULL OR balance_minor >= 0),
      ADD CONSTRAINT orders_price_sum_check
        CHECK (supplier_subtotal_minor IS NULL OR commission_minor IS NULL OR
          subtotal_minor = supplier_subtotal_minor + commission_minor),
      ADD CONSTRAINT orders_total_sum_check
        CHECK (subtotal_minor IS NULL OR delivery_fee_minor IS NULL OR
          total_minor = subtotal_minor + delivery_fee_minor),
      ADD CONSTRAINT orders_payment_sum_check
        CHECK (downpayment_minor IS NULL OR balance_minor IS NULL OR
          total_minor = downpayment_minor + balance_minor),
      ADD CONSTRAINT orders_dropoff_label_check CHECK (btrim(dropoff_label) <> '');
    ALTER TABLE orders RENAME COLUMN supplier_subtotal_minor TO supplier_price_minor;

  `);
}
