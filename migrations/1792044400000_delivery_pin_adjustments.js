export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE refund_requests DROP CONSTRAINT refund_requests_kind_check;
    ALTER TABLE refund_requests ADD CONSTRAINT refund_requests_kind_check CHECK (kind IN ('cancellation','complaint','delivery_pin'));
    ALTER TABLE refund_settlements DROP CONSTRAINT refund_settlements_disposition_check;
    ALTER TABLE refund_settlements ADD CONSTRAINT refund_settlements_disposition_check CHECK (disposition IN ('cancelled','fulfilled_with_refund','delivery_adjustment'));
    ALTER TABLE refund_settlements ADD CONSTRAINT delivery_credit_components_check CHECK
      (disposition <> 'delivery_adjustment' OR (principal_minor=0 AND fee_minor=0 AND rider_entitlement_minor=0));

    CREATE TABLE delivery_pin_payments (
      id text PRIMARY KEY,
      order_id text NOT NULL UNIQUE REFERENCES orders(id),
      change_id text NOT NULL UNIQUE,
      amount_minor money_minor NOT NULL CHECK (amount_minor > 0),
      reference text NOT NULL CHECK (btrim(reference) <> ''),
      proof_file_id text NOT NULL UNIQUE REFERENCES files(file_id),
      confirmed_by text NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL
    );
    CREATE TRIGGER delivery_pin_payment_immutable BEFORE UPDATE OR DELETE ON delivery_pin_payments
      FOR EACH ROW EXECUTE FUNCTION protect_refund_ledger();

    CREATE FUNCTION protect_delivery_pin() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE old_pin jsonb := OLD.data->'deliveryPin'; new_pin jsonb := NEW.data->'deliveryPin';
    BEGIN
      IF old_pin IS NOT NULL AND (
        new_pin IS NULL OR new_pin->'original' IS DISTINCT FROM old_pin->'original'
        OR new_pin->'pricing' IS DISTINCT FROM old_pin->'pricing'
        OR (old_pin->>'dispatchedAt' IS NOT NULL AND new_pin->'dispatchedAt' IS DISTINCT FROM old_pin->'dispatchedAt')
        OR (old_pin->'change'->>'status'='applied' AND
          (new_pin->'change' IS DISTINCT FROM old_pin->'change'
           OR new_pin->'point' IS DISTINCT FROM old_pin->'point'
           OR new_pin->'changeUsed' IS DISTINCT FROM old_pin->'changeUsed'))
      ) THEN RAISE EXCEPTION 'original and applied delivery pins are immutable' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER delivery_pin_snapshot_immutable BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION protect_delivery_pin();

    CREATE FUNCTION check_delivery_pin_payment() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target text; pin jsonb; payment delivery_pin_payments%ROWTYPE;
    BEGIN
      IF TG_TABLE_NAME='orders' THEN target := NEW.id; ELSE target := NEW.order_id; END IF;
      SELECT data->'deliveryPin'->'change' INTO pin FROM orders WHERE id=target;
      SELECT * INTO payment FROM delivery_pin_payments WHERE order_id=target;
      IF payment.id IS NOT NULL OR (pin->>'status'='applied' AND (pin->>'feeDifferenceMinor')::bigint > 0) THEN
        IF payment.id IS NULL OR pin IS NULL OR pin->>'status' IS DISTINCT FROM 'applied'
          OR pin->>'id' IS DISTINCT FROM payment.change_id
          OR (pin->>'feeDifferenceMinor')::bigint IS DISTINCT FROM payment.amount_minor
          OR (pin->'payment'->>'amountMinor')::bigint IS DISTINCT FROM payment.amount_minor
          OR pin->'payment'->>'proofFileId' IS DISTINCT FROM payment.proof_file_id
          OR pin->'payment'->>'reference' IS DISTINCT FROM payment.reference THEN
          RAISE EXCEPTION 'saved pin must match its immutable collection' USING ERRCODE='23514';
        END IF;
      END IF;
      IF pin->>'status'='applied' AND (pin->>'feeDifferenceMinor')::bigint < 0 AND NOT EXISTS (
        SELECT 1 FROM refund_settlements s JOIN refund_requests r ON r.id=s.request_id
        WHERE s.order_id=target AND r.order_id=target AND r.kind='delivery_pin'
          AND s.request_id=pin->>'refundRequestId' AND s.disposition='delivery_adjustment'
          AND s.total_minor=-(pin->>'feeDifferenceMinor')::bigint
          AND s.platform_delivery_minor=-(pin->>'platformDifferenceMinor')::bigint
      ) THEN RAISE EXCEPTION 'lower-priced pin requires its exact reserved credit' USING ERRCODE='23514'; END IF;
      RETURN NULL;
    END; $$;
    CREATE CONSTRAINT TRIGGER delivery_pin_credit_matches_order AFTER INSERT ON refund_settlements
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_delivery_pin_payment();
    CREATE CONSTRAINT TRIGGER delivery_pin_payment_matches_order AFTER INSERT ON delivery_pin_payments
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_delivery_pin_payment();
    CREATE CONSTRAINT TRIGGER delivery_pin_order_matches_payment AFTER INSERT OR UPDATE ON orders
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_delivery_pin_payment();
    CREATE OR REPLACE FUNCTION protect_refund_milestone() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM refund_settlements WHERE order_id=OLD.order_id AND disposition <> 'delivery_adjustment') OR
        EXISTS (SELECT 1 FROM refund_requests WHERE order_id=OLD.order_id AND kind <> 'delivery_pin' AND status NOT IN ('paid','rejected','withdrawn')) THEN
        IF OLD.status IN ('released','superseded') AND (TG_OP='DELETE' OR NEW IS DISTINCT FROM OLD) THEN
          RAISE EXCEPTION 'refund preserves released and superseded milestones' USING ERRCODE='23514', CONSTRAINT='refund_milestone_closed';
        END IF;
        IF TG_OP='UPDATE' AND NEW.status='released' AND OLD.status <> 'released' AND
          (EXISTS (SELECT 1 FROM refund_settlements WHERE order_id=OLD.order_id AND disposition <> 'delivery_adjustment') OR
           EXISTS (SELECT 1 FROM refund_requests WHERE order_id=OLD.order_id AND kind <> 'delivery_pin' AND status NOT IN ('paid','rejected','withdrawn'))) THEN
          RAISE EXCEPTION 'refund holds the original payout stages' USING ERRCODE='23514', CONSTRAINT='refund_milestone_held';
        END IF;
      END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END; $$;

    CREATE OR REPLACE FUNCTION validate_refund_funds(target_order text) RETURNS void LANGUAGE plpgsql AS $$
    DECLARE principal numeric; fee numeric; delivery numeric; released numeric; obligation numeric; entitlement numeric;
    DECLARE rider_obligation numeric; refunded record;
    BEGIN
      SELECT COALESCE(sum(a.amount_minor) FILTER (WHERE a.component='supplier_principal'),0),
             COALESCE(sum(a.amount_minor) FILTER (WHERE a.component='service_fee'),0),
             COALESCE(sum(a.amount_minor) FILTER (WHERE a.component='delivery_pass_through'),0)
        INTO principal, fee, delivery FROM order_payment_allocations a JOIN order_payments p
          ON p.order_id=a.order_id AND p.code=a.payment_code
        WHERE a.order_id=target_order AND p.status='confirmed';
      delivery := delivery + COALESCE((SELECT sum(amount_minor) FROM delivery_pin_payments WHERE order_id=target_order),0);
      SELECT COALESCE(sum(amount_minor),0) INTO released FROM payout_milestones WHERE order_id=target_order AND status='released';
      SELECT COALESCE(sum(amount_minor),0) INTO obligation FROM refund_supplier_payouts
        WHERE order_id=target_order AND status IN ('pending','released');
      SELECT COALESCE(sum(principal_minor),0) AS principal, COALESCE(sum(fee_minor),0) AS fee,
        COALESCE(sum(delivery_minor),0) AS delivery INTO refunded FROM refund_settlements WHERE order_id=target_order;
      SELECT shop_entitlement_minor INTO entitlement FROM refund_settlements
        WHERE order_id=target_order AND disposition <> 'delivery_adjustment' ORDER BY sequence DESC LIMIT 1;
      SELECT COALESCE(max(rider_entitlement_minor),0) INTO rider_obligation FROM refund_settlements WHERE order_id=target_order;
      IF refunded.principal > principal OR refunded.fee > fee OR refunded.delivery + rider_obligation > delivery
        OR (entitlement IS NOT NULL AND (refunded.principal + entitlement > principal OR released + obligation > entitlement)) THEN
        RAISE EXCEPTION 'refund and payout exceed verified collection' USING ERRCODE='23514', CONSTRAINT='refund_available_funds_check';
      END IF;
    END; $$;
    CREATE CONSTRAINT TRIGGER delivery_pin_refund_funds AFTER INSERT ON delivery_pin_payments
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_refund_funds();
  `);
}

export async function down() {
  throw new Error('Delivery pin collections and reserved credits are durable; use a forward migration.');
}
