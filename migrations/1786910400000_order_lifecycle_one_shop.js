/**
 * One shop per order, and a cancellation that can be recorded.
 *
 * The order lifecycle needs almost no new vocabulary. A cart checkout now lands
 * at `initial_payment_review` (Operations confirms the transfer), moves to
 * `needs_qa` (Operations checks the artwork), then to `supplier_assigned` --
 * which is where the shop sees it for the first time, already priced and
 * already dated. Accepting moves it to `payment_authorized`, and the whole back
 * half from `production` onward is unchanged.
 *
 * `cancelled` is the one addition. Operations can already fail a quality check
 * back to the client, but until now there was no way to end an order at all --
 * so a job that genuinely could not be fixed had nowhere to go and no record of
 * why. Refunding is still manual; this records the decision and its reason.
 *
 * The one-shop rule is a cart-time refusal rather than a constraint. The
 * order_jobs table stays for now because orders placed under the old multi-shop
 * checkout still reference it, and dropping it belongs with the rest of the
 * removal rather than in the middle of the lifecycle change.
 */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE orders
      DROP CONSTRAINT orders_state_check;

    ALTER TABLE orders
      ADD CONSTRAINT orders_state_check CHECK (state IN (
        'draft', 'submitted', 'needs_qa', 'client_correction', 'proof_approval',
        'approved_for_matching', 'supplier_assigned', 'awaiting_checkout',
        'awaiting_initial_payment', 'initial_payment_review', 'awaiting_downpayment',
        'downpayment_review', 'payment_authorized', 'production', 'supplier_self_qc',
        'ready_for_dispatch', 'rider_assigned', 'picked_up', 'out_for_delivery',
        'delivered', 'issue_window_open', 'completed', 'payout_released',
        'cancelled'
      ));

    -- Why an order ended, and who ended it. A cancellation with no reason
    -- attached is indistinguishable from a mistake a month later.
    ALTER TABLE orders
      ADD COLUMN cancelled_at timestamptz,
      ADD COLUMN cancelled_by text REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL,
      ADD COLUMN cancellation_reason text
        CHECK (cancellation_reason IS NULL OR btrim(cancellation_reason) <> ''),
      ADD CONSTRAINT orders_cancellation_shape_check CHECK (
        (state <> 'cancelled' AND cancelled_at IS NULL)
        OR (state = 'cancelled' AND cancelled_at IS NOT NULL AND btrim(cancellation_reason) <> '')
      );
  `);
}

export async function down(pgm) {
  pgm.sql(`
    UPDATE orders SET state = 'needs_qa' WHERE state = 'cancelled';

    ALTER TABLE orders
      DROP CONSTRAINT orders_cancellation_shape_check,
      DROP COLUMN cancellation_reason,
      DROP COLUMN cancelled_by,
      DROP COLUMN cancelled_at;

    ALTER TABLE orders
      DROP CONSTRAINT orders_state_check;

    ALTER TABLE orders
      ADD CONSTRAINT orders_state_check CHECK (state IN (
        'draft', 'submitted', 'needs_qa', 'client_correction', 'proof_approval',
        'approved_for_matching', 'supplier_assigned', 'awaiting_checkout',
        'awaiting_initial_payment', 'initial_payment_review', 'awaiting_downpayment',
        'downpayment_review', 'payment_authorized', 'production', 'supplier_self_qc',
        'ready_for_dispatch', 'rider_assigned', 'picked_up', 'out_for_delivery',
        'delivered', 'issue_window_open', 'completed', 'payout_released'
      ));
  `);
}
