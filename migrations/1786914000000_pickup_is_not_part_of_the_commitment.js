/**
 * Which press runs the job is not part of what the client committed to.
 *
 * A committed order's money and fulfilment are immutable, and they should be:
 * the client agreed to a price, a delivery address and a payment plan, and none
 * of those may be rewritten underneath them. The pickup pin was in that set too,
 * and it does not belong there. It is the shop's counter -- the address a rider
 * collects from. The client never sees it, never chose it, and GRIDGO says so
 * outright on every screen: which press runs the job is GRIDGO's business.
 *
 * Guarding it made a declined job unrecoverable. When a shop cannot take the
 * work the order has to move to another one, and moving it changes the pin, so
 * the trigger refused the write and the whole decline failed with a server
 * error. The client had paid, the shop had said no, and nothing could happen.
 *
 * Everything the client actually agreed to stays immutable: every money column,
 * the payment plan, the fulfilment mode, and the drop-off they chose.
 */
export async function up(pgm) {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION protect_committed_order_money()
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
  `);
}

export async function down(pgm) {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION protect_committed_order_money()
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
  `);
}
