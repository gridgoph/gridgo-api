/**
 * A 100 percent checkout has no balance to pay.
 *
 * New order-match orders are paid in full up front (gridgo-api#66). They keep
 * the `final_online` installment so every order has the same installment list,
 * at zero pesos with status `not_required`, which every balance gate treats as
 * settled. Orders already placed on 75/25 are untouched. The split itself is
 * snapshotted in `orders.data.downpaymentPercent`; the live setting is
 * `platform_settings.settings.downpaymentPercent`. Neither needs a column.
 * Contract: docs/OPERATIONAL_MODEL_V2_API.md#upfront-checkout.
 */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE order_payments
      DROP CONSTRAINT order_payments_status_check;
    ALTER TABLE order_payments
      ADD CONSTRAINT order_payments_status_check
        CHECK (status IN ('not_submitted', 'pending_confirmation', 'confirmed', 'not_required'));
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM order_payments WHERE status = 'not_required') THEN
        RAISE EXCEPTION 'orders paid in full up front exist; their balance cannot be represented without not_required';
      END IF;
    END
    $$;
    ALTER TABLE order_payments
      DROP CONSTRAINT order_payments_status_check;
    ALTER TABLE order_payments
      ADD CONSTRAINT order_payments_status_check
        CHECK (status IN ('not_submitted', 'pending_confirmation', 'confirmed'));
  `);
}
