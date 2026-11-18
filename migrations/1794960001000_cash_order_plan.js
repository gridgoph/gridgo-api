export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE orders DROP CONSTRAINT orders_payment_plan_check, DROP CONSTRAINT orders_payout_plan_version_check;
    ALTER TABLE orders ADD CONSTRAINT orders_payment_plan_check CHECK(payment_plan IN
      ('delivery_online','pickup_full_online','pickup_downpayment_store','order_match_qr_75_25','cash_delivery')),
      ADD CONSTRAINT orders_payout_plan_version_check CHECK(payout_plan_version IN(1,2,3));
    ALTER TABLE order_payments DROP CONSTRAINT order_payments_method_check;
    ALTER TABLE order_payments ADD CONSTRAINT order_payments_method_check CHECK(method IN('qr_manual','provider_online','gridgo_voucher','cash'));
    ALTER TABLE payout_milestones DROP CONSTRAINT payout_milestones_code_check;
    ALTER TABLE payout_milestones ADD CONSTRAINT payout_milestones_code_check CHECK(code IN
      ('printing','packaging_qc','delivered','pickup_handover','retention','initial','completion','production_started','issue_window','cash_shop'));

    CREATE FUNCTION validate_cash_order(target text) RETURNS void LANGUAGE plpgsql AS $$
    DECLARE o orders%ROWTYPE; p order_payments%ROWTYPE; stage payout_milestones%ROWTYPE;
    BEGIN
      SELECT * INTO o FROM orders WHERE id=target;
      IF o.payment_plan IS DISTINCT FROM 'cash_delivery' THEN RETURN; END IF;
      SELECT * INTO p FROM order_payments WHERE order_id=target AND code='initial';
      SELECT * INTO stage FROM payout_milestones WHERE order_id=target AND code='cash_shop';
      IF o.data->'cash' IS NULL OR o.fulfillment_mode<>'delivery' OR o.payout_plan_version<>3
        OR o.rider_commission_bps<>8000 OR o.online_due_minor<>0 OR o.direct_store_due_minor<>0
        OR o.total_minor<>o.supplier_subtotal_minor+o.service_fee_minor+o.delivery_fee_minor-COALESCE((o.data->>'voucherDiscountMinor')::bigint,0)
        OR p.method IS DISTINCT FROM 'cash' OR p.amount_minor IS DISTINCT FROM o.total_minor
        OR (SELECT count(*) FROM order_payments WHERE order_id=target)<>2
        OR NOT EXISTS(SELECT 1 FROM order_payments WHERE order_id=target AND code='final_online' AND amount_minor=0 AND status='not_required')
        OR (SELECT COALESCE(sum(amount_minor),0) FROM order_payment_allocations WHERE order_id=target)<>o.total_minor
        OR stage.amount_minor IS DISTINCT FROM o.supplier_subtotal_minor OR stage.share_percent IS DISTINCT FROM 100
        OR (SELECT count(*) FROM payout_milestones WHERE order_id=target)<>1
        OR (stage.status='released' AND NOT EXISTS(SELECT 1 FROM cash_journals WHERE order_id=target AND kind='shop_paid'))
        OR (p.status='confirmed' AND NOT EXISTS(SELECT 1 FROM cash_journals WHERE order_id=target AND kind IN('cash_collected','no_show_repaid'))) THEN
        RAISE EXCEPTION 'invalid cash commitment or missing custody evidence' USING ERRCODE='23514'; END IF;
    END $$;
    CREATE FUNCTION cash_order_check() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      PERFORM validate_cash_order(CASE WHEN TG_TABLE_NAME='orders' THEN to_jsonb(NEW)->>'id' ELSE to_jsonb(NEW)->>'order_id' END);
      RETURN NULL; END $$;
    CREATE CONSTRAINT TRIGGER cash_order_shape AFTER INSERT OR UPDATE ON orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cash_order_check();
    CREATE CONSTRAINT TRIGGER cash_payment_shape AFTER INSERT OR UPDATE ON order_payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cash_order_check();
    CREATE CONSTRAINT TRIGGER cash_stage_shape AFTER INSERT OR UPDATE ON payout_milestones DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cash_order_check();
    CREATE FUNCTION cash_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF OLD.data->'cash' IS NOT NULL AND NEW.data->'cash' IS DISTINCT FROM OLD.data->'cash' THEN
        RAISE EXCEPTION 'cash snapshot is immutable' USING ERRCODE='23514'; END IF;
      RETURN NEW; END $$;
    CREATE TRIGGER cash_snapshot_immutable BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION cash_snapshot_guard();

    -- Keep the original online function body, widening only the new method's branch.
    DO $patch$ DECLARE definition text;
    BEGIN
      SELECT pg_get_functiondef('validate_basket_payment()'::regprocedure) INTO definition;
      definition := replace(definition, 'IF group_count < 2 OR total IS DISTINCT FROM b.total_minor',
        'IF b.payment->>''method''=''cash'' THEN
          IF group_count<2 OR total IS DISTINCT FROM b.total_minor OR b.fulfillment_mode<>''delivery''
            OR EXISTS(SELECT 1 FROM order_basket_groups g JOIN orders o ON o.id=g.order_id
              WHERE g.basket_id=target AND (o.client_id<>b.client_id OR o.payment_plan<>''cash_delivery'')) THEN
            RAISE EXCEPTION ''invalid cash basket'' USING ERRCODE=''23514''; END IF;
          RETURN NULL;
        END IF;
        IF group_count < 2 OR total IS DISTINCT FROM b.total_minor');
      EXECUTE definition;
    END $patch$;
  `);
}
export async function down() { throw new Error('Cash plans require a forward migration'); }
