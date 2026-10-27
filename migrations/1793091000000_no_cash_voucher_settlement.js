/** Zero client cash is a voucher settlement, never an invented transfer. */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE order_payments DROP CONSTRAINT order_payments_method_check;
    ALTER TABLE order_payments ADD CONSTRAINT order_payments_method_check CHECK(method IN ('qr_manual','provider_online','gridgo_voucher'));
    CREATE FUNCTION validate_zero_cash_voucher_payment() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE o orders%ROWTYPE;
    BEGIN
      IF NEW.method<>'gridgo_voucher' THEN RETURN NULL; END IF;
      SELECT * INTO o FROM orders WHERE id=NEW.order_id;
      IF NEW.code<>'initial' OR NEW.amount_minor<>0 OR NEW.status<>'confirmed'
        OR NEW.data->>'confirmationSource' IS DISTINCT FROM 'gridgo_voucher'
        OR NEW.data->>'confirmedAt' IS NULL OR NEW.data->>'reference' IS NOT NULL OR NEW.data->>'proofFileId' IS NOT NULL
        OR NOT COALESCE((o.data->'voucher'->>'coversOrderTotal')::boolean,false)
        OR NOT EXISTS(SELECT 1 FROM order_payment_allocations a WHERE a.order_id=o.id AND a.payment_code='initial' AND a.gridgo_funded_minor>0)
        OR NOT EXISTS(SELECT 1 FROM voucher_redemptions r WHERE r.voucher_id=o.data->'voucher'->>'id' AND r.client_id=o.client_id AND r.data->'orderIds' ? o.id) THEN
        RAISE EXCEPTION 'zero-cash payment requires a consumed GRIDGO voucher and no transfer evidence' USING ERRCODE='23514';
      END IF;
      RETURN NULL;
    END $$;
    CREATE CONSTRAINT TRIGGER zero_cash_voucher_payment AFTER INSERT OR UPDATE ON order_payments
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_zero_cash_voucher_payment();

CREATE OR REPLACE FUNCTION validate_basket_payment() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target text; b order_baskets%ROWTYPE; group_count integer; total bigint;
    BEGIN
      IF TG_TABLE_NAME = 'order_baskets' THEN target := NEW.id;
      ELSIF TG_TABLE_NAME = 'order_basket_groups' THEN target := NEW.basket_id;
      ELSE
        SELECT basket_id INTO target FROM order_basket_groups WHERE order_id = COALESCE(NEW.order_id, OLD.order_id);
      END IF;
      IF target IS NULL THEN RETURN NULL; END IF;
      SELECT * INTO b FROM order_baskets WHERE id = target;
      SELECT count(*), sum(o.total_minor) INTO group_count, total FROM order_basket_groups g
        JOIN orders o ON o.id = g.order_id WHERE g.basket_id = target;
      IF group_count < 2 OR total IS DISTINCT FROM b.total_minor
        OR b.payment->>'method' IS NULL OR b.payment->>'method' NOT IN ('qr_manual','gridgo_voucher')
        OR (b.payment->>'method'='gridgo_voucher' AND (b.total_minor<>0 OR b.payment->>'status' IS DISTINCT FROM 'confirmed'
          OR b.payment->>'confirmationSource' IS DISTINCT FROM 'gridgo_voucher' OR b.payment->>'reference' IS NOT NULL OR b.payment->>'proofFileId' IS NOT NULL))
        OR NOT EXISTS (SELECT 1 FROM order_basket_groups WHERE basket_id = target AND order_id = b.receipt_order_id AND position = 0)
        OR EXISTS (SELECT 1 FROM order_basket_groups g JOIN orders o ON o.id = g.order_id
          LEFT JOIN order_payments p ON p.order_id = o.id AND p.code = 'initial'
          LEFT JOIN order_payments f ON f.order_id = o.id AND f.code = 'final_online'
          WHERE g.basket_id = target AND (o.client_id <> b.client_id OR o.fulfillment_mode <> b.fulfillment_mode
            OR p.amount_minor IS DISTINCT FROM o.total_minor OR p.status IS DISTINCT FROM b.payment->>'status'
            OR p.method IS DISTINCT FROM b.payment->>'method'
            OR (p.method='gridgo_voucher' AND p.data->>'confirmationSource' IS DISTINCT FROM b.payment->>'confirmationSource') OR p.data->>'reference' IS DISTINCT FROM b.payment->>'reference'
            OR p.data->>'proofFileId' IS DISTINCT FROM b.payment->>'proofFileId'
            OR (b.pickup_fee_minor IS NOT NULL AND (
              o.data->'hubPickup' IS NULL OR o.rider_commission_bps IS DISTINCT FROM 0
              OR o.delivery_fee_minor IS DISTINCT FROM b.pickup_fee_minor / group_count
                + CASE WHEN g.position < b.pickup_fee_minor % group_count THEN 1 ELSE 0 END
              OR g.position >= group_count))
            OR f.amount_minor IS DISTINCT FROM 0::bigint OR f.status IS DISTINCT FROM 'not_required')) THEN
        RAISE EXCEPTION 'basket payment must cover every group exactly once' USING ERRCODE = '23514';
      END IF;
      RETURN NULL;
    END $$;

    ALTER TABLE refund_settlements DROP CONSTRAINT refund_settlements_check1;
    ALTER TABLE refund_settlements ADD CONSTRAINT refund_settlements_total_minor_check CHECK(
      total_minor>=0 AND total_minor=principal_minor+fee_minor+delivery_minor
      AND (total_minor>0 OR COALESCE(snapshot->'noCashSettlement'='true'::jsonb,false)));
    CREATE FUNCTION validate_zero_cash_remedy() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE s refund_settlements%ROWTYPE; o orders%ROWTYPE; r refund_requests%ROWTYPE;
    BEGIN
      IF TG_TABLE_NAME='refund_settlements' THEN SELECT * INTO s FROM refund_settlements WHERE id=NEW.id;
      ELSE SELECT * INTO s FROM refund_settlements WHERE request_id=NEW.id; END IF;
      IF s.id IS NULL OR s.total_minor<>0 THEN RETURN NULL; END IF;
      SELECT * INTO o FROM orders WHERE id=s.order_id;
      SELECT * INTO r FROM refund_requests WHERE id=s.request_id;
      IF r.status<>'paid' OR r.kind='delivery_pin' OR NOT o.data ? 'voucher' OR o.review_data
        OR jsonb_typeof(s.snapshot->'clientCaused') IS DISTINCT FROM 'boolean'
        OR NOT EXISTS(SELECT 1 FROM order_payments WHERE order_id=o.id AND code='initial' AND status='confirmed')
        OR NOT EXISTS(SELECT 1 FROM voucher_redemptions v WHERE v.voucher_id=o.data->'voucher'->>'id' AND v.data->'orderIds' ? o.id)
        OR EXISTS(SELECT 1 FROM order_payments WHERE order_id=o.id AND status='confirmed' AND amount_minor>0)
        OR EXISTS(SELECT 1 FROM order_change_payments WHERE order_id=o.id)
        OR EXISTS(SELECT 1 FROM delivery_pin_payments WHERE order_id=o.id)
        OR NOT EXISTS(SELECT 1 FROM order_payment_allocations a JOIN order_payments p ON p.order_id=a.order_id AND p.code=a.payment_code
          WHERE a.order_id=o.id AND a.gridgo_funded_minor>0 AND (p.status='confirmed' OR p.status='not_required'))
        OR EXISTS(SELECT 1 FROM refund_attempts WHERE request_id=r.id)
        OR EXISTS(SELECT 1 FROM refund_payments WHERE request_id=r.id) THEN
        RAISE EXCEPTION 'no-cash remedy requires settled voucher funding, recorded fault and no client transfer' USING ERRCODE='23514';
      END IF;
      RETURN NULL;
    END $$;
    CREATE CONSTRAINT TRIGGER zero_cash_remedy_settlement AFTER INSERT ON refund_settlements
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_zero_cash_remedy();
    CREATE CONSTRAINT TRIGGER zero_cash_remedy_request AFTER INSERT OR UPDATE ON refund_requests
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_zero_cash_remedy();

    ALTER TABLE promotion_invites ADD COLUMN unmatched_reason text CHECK(unmatched_reason IN ('no_client_account','ambiguous_email','self_invite','account_already_attributed'));
    CREATE UNIQUE INDEX promotion_one_friend_attribution ON promotion_invites(client_id)
      WHERE client_id IS NOT NULL AND status<>'skipped_already_founder';
  `);
}
export async function down() { throw new Error('Voucher settlement and invitation history require a forward migration'); }
