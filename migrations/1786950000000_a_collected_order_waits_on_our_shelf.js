/**
 * A collected order has two endings, not one.
 *
 * The rider carrying it reaches GRIDGO Office, which is not the client
 * receiving it -- the client may come for it days later. Recording the drop-off
 * as a delivery closed the job and started the complaint window while the
 * package was still on our own shelf.
 *
 * `awaiting_collection` is the gap between the two: the rider is finished, the
 * client is not yet holding it, and the remaining balance is owed at the
 * counter before it is released.
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
        'awaiting_collection', 'delivered', 'issue_window_open', 'completed',
        'payout_released', 'cancelled'
      ));
  `);
}

export async function down(pgm) {
  pgm.sql(`
    UPDATE orders SET state = 'out_for_delivery' WHERE state = 'awaiting_collection';

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
  `);
}
