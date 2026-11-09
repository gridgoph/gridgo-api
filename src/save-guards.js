import { activeOrderSql } from './order-removal.js';
import { changePaymentPending, changeWindowOpen, changesFor } from './order-change-policy.js';
import { awaitedTopUp } from './shop-move-pricing.js';
import { deliveryPinPaymentPending, deliveryPinLocked } from './delivery-pin-policy.js';

const fail = (code, message) => { throw Object.assign(new Error(message), { status: 409, code }); };

/** Existing global guard remains global even when upkeep is requester-scoped. */
export async function assertStoredSupplementUnique(database) {
  const duplicate = await database.query(`SELECT 1 FROM order_change_payments c WHERE ${activeOrderSql('c.order_id')} AND (
    EXISTS (SELECT 1 FROM order_payments p WHERE ${activeOrderSql('p.order_id')} AND p.status='confirmed'
      AND (p.data->>'proofFileId'=c.proof_file_id OR ((p.data->>'reference') !~ '[^ -~]' AND upper(btrim(p.data->>'reference'))=c.reference)))
    OR EXISTS (SELECT 1 FROM delivery_pin_payments p WHERE ${activeOrderSql('p.order_id')}
      AND (p.proof_file_id=c.proof_file_id OR (p.reference !~ '[^ -~]' AND upper(btrim(p.reference))=c.reference)))) LIMIT 1`);
  if (duplicate.rowCount) fail('change_payment_reference_used', 'This transfer is already recorded as a supplement.');
  // SQL upper/btrim are not JS Unicode trim/toUpperCase. Preserve the original
  // policy for unusual historical references using a partial-index candidate.
  const unusual = await database.query(`SELECT data->>'reference' AS reference FROM order_payments p
    WHERE ${activeOrderSql('p.order_id')} AND status='confirmed' AND (data->>'reference') ~ '[^ -~]'
    UNION ALL SELECT reference FROM delivery_pin_payments p WHERE ${activeOrderSql('p.order_id')} AND reference ~ '[^ -~]'`);
  if (unusual.rowCount) {
    const refs = unusual.rows.map(row => row.reference.trim().toUpperCase());
    const hit = await database.query('SELECT 1 FROM order_change_payments c WHERE '+activeOrderSql('c.order_id')+' AND reference=ANY($1::text[]) LIMIT 1', [refs]);
    if (hit.rowCount) fail('change_payment_reference_used', 'This transfer is already recorded as a supplement.');
  }
}

export function assertExistingOrderPaymentGuards(store, order) {
  const topUpPending = changesFor(store, order).some(row => row.status === 'pending_confirmation' && awaitedTopUp(order, row));
  if (changePaymentPending(store, order) && (!changeWindowOpen(order)
      || (order.shopRecovery && order.shopRecovery.status !== 'accepted' && !topUpPending))) {
    fail('change_payment_pending', 'Resolve the submitted change transfer before closing production or changing shops.');
  }
  if (deliveryPinPaymentPending(order) && deliveryPinLocked(order)) {
    fail('delivery_pin_payment_pending', 'Verify or reject the submitted delivery transfer before dispatch or closure.');
  }
}

/** Draft line/token writes never change assignment or money; only existing
 * pending guards need a global check. Changed-order checks still run in save.
 */
export async function assertStoredOrderPaymentGuards(database) {
  const { rows } = await database.query(`SELECT o.id,o.state,o.supplier_id,o.rider_id,o.data FROM orders o
    WHERE ${activeOrderSql('o.id')} AND o.id IN (
      SELECT id FROM orders WHERE data#>>'{deliveryPin,change,status}'='pending_confirmation'
      UNION SELECT order_id FROM order_change_requests WHERE status='pending_confirmation')
    ORDER BY o.position`);
  if (!rows.length) return;
  const changes = (await database.query(`SELECT * FROM order_change_requests WHERE status='pending_confirmation' AND order_id=ANY($1::text[])`, [rows.map(row => row.id)])).rows;
  const store = { orderChanges: changes.map(row => ({ ...row, orderId: row.order_id, supplierId: row.supplier_id })) };
  for (const row of rows) assertExistingOrderPaymentGuards(store, { ...row.data, id: row.id, state: row.state, supplierId: row.supplier_id, riderId: row.rider_id });
}
