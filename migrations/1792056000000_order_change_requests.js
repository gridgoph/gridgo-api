export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE client_cart_lines ADD COLUMN special_instructions text NOT NULL DEFAULT '' CHECK (char_length(special_instructions) <= 300);
    ALTER TABLE order_line_items ADD COLUMN special_instructions text NOT NULL DEFAULT '' CHECK (char_length(special_instructions) <= 300);
    CREATE FUNCTION protect_special_instructions() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.special_instructions IS DISTINCT FROM NEW.special_instructions THEN
        RAISE EXCEPTION 'order special instructions are immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER order_special_instructions_immutable BEFORE UPDATE ON order_line_items
      FOR EACH ROW EXECUTE FUNCTION protect_special_instructions();

    CREATE TABLE order_change_requests (
      id text PRIMARY KEY, order_id text NOT NULL REFERENCES orders(id), supplier_id text NOT NULL REFERENCES users(id),
      line_item_id text REFERENCES order_line_items(id), status text NOT NULL CHECK (status IN ('pending','declined','pending_payment','pending_confirmation','applied','closed')),
      version integer NOT NULL CHECK (version > 0), extra_principal_minor money_minor NOT NULL CHECK (extra_principal_minor >= 0),
      fee_minor money_minor NOT NULL CHECK (fee_minor >= 0), total_minor money_minor NOT NULL CHECK (total_minor = extra_principal_minor + fee_minor),
      created_at timestamptz NOT NULL, data jsonb NOT NULL CHECK (jsonb_typeof(data)='object')
    );
    CREATE UNIQUE INDEX order_change_one_open ON order_change_requests(order_id) WHERE status IN ('pending','pending_payment','pending_confirmation');
    CREATE INDEX order_change_by_order ON order_change_requests(order_id, created_at);
    CREATE TABLE order_change_payments (
      id text PRIMARY KEY, order_id text NOT NULL REFERENCES orders(id), change_id text NOT NULL UNIQUE REFERENCES order_change_requests(id),
      principal_minor money_minor NOT NULL CHECK (principal_minor > 0), fee_minor money_minor NOT NULL CHECK (fee_minor >= 0),
      amount_minor money_minor NOT NULL CHECK (amount_minor=principal_minor+fee_minor), reference text NOT NULL UNIQUE CHECK (btrim(reference)<>''),
      proof_file_id text NOT NULL UNIQUE REFERENCES files(file_id), confirmed_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL
    );
    CREATE TABLE order_change_payouts (
      id text PRIMARY KEY, order_id text NOT NULL REFERENCES orders(id), change_id text NOT NULL UNIQUE REFERENCES order_change_requests(id),
      supplier_id text NOT NULL REFERENCES users(id), amount_minor money_minor NOT NULL CHECK (amount_minor > 0),
      reference text NOT NULL CHECK (btrim(reference)<>''), receipt_file_id text NOT NULL REFERENCES files(file_id),
      released_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL
    );
    CREATE TRIGGER order_change_payment_immutable BEFORE UPDATE OR DELETE ON order_change_payments FOR EACH ROW EXECUTE FUNCTION protect_refund_ledger();
    CREATE TRIGGER order_change_payout_immutable BEFORE UPDATE OR DELETE ON order_change_payouts FOR EACH ROW EXECUTE FUNCTION protect_refund_ledger();
    CREATE FUNCTION protect_order_change_request() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' OR OLD.status IN ('declined','applied','closed') OR
        ROW(OLD.order_id,OLD.supplier_id,OLD.line_item_id,OLD.extra_principal_minor,OLD.fee_minor,OLD.total_minor,OLD.created_at)
        IS DISTINCT FROM ROW(NEW.order_id,NEW.supplier_id,NEW.line_item_id,NEW.extra_principal_minor,NEW.fee_minor,NEW.total_minor,NEW.created_at)
        OR (OLD.data - ARRAY['payment','paymentHistory','answeredAt','answeredBy','appliedAt','rejectionReason','priorLapse','closedAt','closureReason'])
          IS DISTINCT FROM (NEW.data - ARRAY['payment','paymentHistory','answeredAt','answeredBy','appliedAt','rejectionReason','priorLapse','closedAt','closureReason']) THEN
        RAISE EXCEPTION 'change request terms and final decisions are immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER order_change_request_immutable BEFORE UPDATE OR DELETE ON order_change_requests FOR EACH ROW EXECUTE FUNCTION protect_order_change_request();
    CREATE FUNCTION check_order_change_money() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target text; change order_change_requests%ROWTYPE; payment order_change_payments%ROWTYPE; payout order_change_payouts%ROWTYPE;
    BEGIN
      IF TG_TABLE_NAME='order_change_requests' THEN target:=NEW.id; ELSE target:=NEW.change_id; END IF;
      SELECT * INTO change FROM order_change_requests WHERE id=target;
      SELECT * INTO payment FROM order_change_payments WHERE change_id=target;
      SELECT * INTO payout FROM order_change_payouts WHERE change_id=target;
      IF change.fee_minor IS DISTINCT FROM gridgo_service_fee((change.data->>'originalPrincipalMinor')::numeric + change.extra_principal_minor, change.data->'feeSchedule')
        - gridgo_service_fee((change.data->>'originalPrincipalMinor')::numeric, change.data->'feeSchedule') THEN
        RAISE EXCEPTION 'change fee must match frozen incremental schedule' USING ERRCODE='23514'; END IF;
      IF change.line_item_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM order_line_items WHERE id=change.line_item_id AND order_id=change.order_id) THEN
        RAISE EXCEPTION 'change line belongs to another order' USING ERRCODE='23514'; END IF;
      IF payment.id IS NOT NULL OR (change.status='applied' AND change.total_minor>0) THEN
        IF payment.id IS NULL OR change.status<>'applied' OR payment.order_id<>change.order_id OR payment.amount_minor<>change.total_minor
          OR payment.principal_minor<>change.extra_principal_minor OR payment.fee_minor<>change.fee_minor
          OR payment.proof_file_id IS DISTINCT FROM change.data->'payment'->>'proofFileId'
          OR payment.reference IS DISTINCT FROM change.data->'payment'->>'reference' THEN
          RAISE EXCEPTION 'applied priced change requires matching collection' USING ERRCODE='23514'; END IF;
      END IF;
      IF payout.id IS NOT NULL THEN
        IF payment.id IS NULL OR payout.order_id<>change.order_id OR payout.supplier_id<>change.supplier_id OR payout.amount_minor<>payment.principal_minor
          OR NOT EXISTS (SELECT 1 FROM payout_milestones p JOIN orders o ON o.id=p.order_id WHERE p.order_id=change.order_id
            AND p.code=CASE WHEN o.payout_plan_version=2 THEN 'issue_window' ELSE 'retention' END AND p.status='released')
          OR EXISTS (SELECT 1 FROM refund_settlements WHERE order_id=change.order_id AND disposition<>'delivery_adjustment') THEN
          RAISE EXCEPTION 'supplement requires collected funds and final payout stage' USING ERRCODE='23514'; END IF;
      END IF;
      RETURN NULL;
    END; $$;
    CREATE CONSTRAINT TRIGGER change_request_money AFTER INSERT OR UPDATE ON order_change_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_order_change_money();
    CREATE CONSTRAINT TRIGGER change_payment_money AFTER INSERT ON order_change_payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_order_change_money();
    CREATE CONSTRAINT TRIGGER change_payout_money AFTER INSERT ON order_change_payouts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_order_change_money();
  `);
  pgm.sql(`
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
      principal := principal + COALESCE((SELECT sum(principal_minor) FROM order_change_payments WHERE order_id=target_order),0);
      fee := fee + COALESCE((SELECT sum(fee_minor) FROM order_change_payments WHERE order_id=target_order),0);
      delivery := delivery + COALESCE((SELECT sum(amount_minor) FROM delivery_pin_payments WHERE order_id=target_order),0);
      SELECT COALESCE(sum(amount_minor),0) INTO released FROM payout_milestones WHERE order_id=target_order AND status='released';
      released := released + COALESCE((SELECT sum(amount_minor) FROM order_change_payouts WHERE order_id=target_order),0);
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

    CREATE CONSTRAINT TRIGGER change_collection_refund_funds AFTER INSERT ON order_change_payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_refund_funds();
    CREATE CONSTRAINT TRIGGER change_payout_refund_funds AFTER INSERT ON order_change_payouts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_refund_funds();
    CREATE FUNCTION check_supplement_collection_unique() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM order_change_payments c JOIN order_payments p ON p.status='confirmed'
        AND (upper(btrim(p.data->>'reference'))=c.reference OR p.data->>'proofFileId'=c.proof_file_id))
        OR EXISTS (SELECT 1 FROM order_change_payments c JOIN delivery_pin_payments p
          ON upper(btrim(p.reference))=c.reference OR p.proof_file_id=c.proof_file_id) THEN
        RAISE EXCEPTION 'supplement transfer already used by another collection' USING ERRCODE='23514';
      END IF;
      RETURN NULL;
    END; $$;
    CREATE CONSTRAINT TRIGGER supplement_collection_unique AFTER INSERT ON order_change_payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_supplement_collection_unique();
    CREATE CONSTRAINT TRIGGER installment_supplement_unique AFTER INSERT OR UPDATE ON order_payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_supplement_collection_unique();
    CREATE CONSTRAINT TRIGGER pin_supplement_unique AFTER INSERT ON delivery_pin_payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_supplement_collection_unique();
  `);
}
export async function down() { throw new Error('Change requests and collections are durable; use a forward migration.'); }
