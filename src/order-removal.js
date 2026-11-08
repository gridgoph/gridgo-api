import { identityHasMembership } from './authorization-context.js';

export const ORDER_REMOVAL_ROUTE = /^\/ops\/orders\/([^/]+)\/remove$/;
export const activeOrderSql = (expression) => `NOT EXISTS (SELECT 1 FROM order_removals removed WHERE removed.order_id = ${expression})`;
const activeBasketSql = (expression) => `NOT EXISTS (SELECT 1 FROM order_basket_groups members
  JOIN order_removals removed ON removed.order_id = members.order_id WHERE members.basket_id = ${expression})`;
const activeOrderBasketSql = (expression) => `NOT EXISTS (SELECT 1 FROM order_basket_groups membership
  WHERE membership.order_id = ${expression} AND NOT (${activeBasketSql('membership.basket_id')}))`;
const activeOrderAndBasketSql = (expression) => `${activeOrderSql(expression)} AND ${activeOrderBasketSql(expression)}`;

/** Every compatibility graph (including writers and sweeps) reads the same active
 * domain. Hidden rows are absent from both its baseline and current rows, so an
 * unrelated save cannot delete or rewrite the retained history. Audit is exempt. */
export function orderReadQuery({ name, columns }, where = '') {
  let predicate;
  if (name === 'orders') predicate = activeOrderSql('orders.id');
  else if (name === 'order_invoices') predicate = activeOrderAndBasketSql('order_invoices.order_id');
  else if (name !== 'audit_log' && columns.includes('order_id')) predicate = activeOrderSql(`${name}.order_id`);
  else if (name === 'order_line_item_options') predicate = `NOT EXISTS (SELECT 1 FROM order_line_items parent
    JOIN order_removals removed ON removed.order_id = parent.order_id WHERE parent.id = order_line_item_options.order_line_item_id)`;
  else if (['refund_attempts', 'refund_payments', 'refund_events'].includes(name)) predicate = `NOT EXISTS (SELECT 1 FROM refund_requests parent
    JOIN order_removals removed ON removed.order_id = parent.order_id WHERE parent.id = ${name}.request_id)`;
  else if (name === 'client_carts') predicate = activeOrderAndBasketSql('client_carts.checked_out_order_id');
  else if (['client_cart_lines', 'checkout_visits', 'checkout_exit_prompts'].includes(name)) predicate = `NOT EXISTS (
    SELECT 1 FROM client_carts parent WHERE parent.id = ${name}.cart_id
      AND NOT (${activeOrderAndBasketSql('parent.checked_out_order_id')}))`;
  else if (name === 'sample_batch_drafts') predicate = `${activeOrderSql('sample_batch_drafts.sample_order_id')} AND ${activeOrderSql('sample_batch_drafts.batch_order_id')}`;
  else if (name === 'quote_requests') predicate = activeOrderSql("quote_requests.data->>'orderId'");
  else if (name === 'quote_replies') predicate = `NOT EXISTS (SELECT 1 FROM quote_requests parent
    JOIN order_removals removed ON removed.order_id = parent.data->>'orderId' WHERE parent.id = quote_replies.quote_request_id)`;
  else if (name === 'refund_commands') predicate = activeOrderSql("refund_commands.response#>>'{body,refund,orderId}'");
  if (name === 'order_baskets' || name === 'order_basket_groups') {
    const basket = name === 'order_baskets' ? 'order_baskets.id' : 'order_basket_groups.basket_id';
    predicate = activeBasketSql(basket);
  }
  // Nonrecursive same-name CTEs bind the active table for the entire scoped
  // query (including nested references); PostgreSQL inlines these predicates.
  const source = predicate ? `WITH ${name} AS NOT MATERIALIZED (SELECT * FROM ${name} WHERE ${predicate}) ` : '';
  return `${source}SELECT ${columns.join(', ')} FROM ${name} ${where}`;
}

/** Policy facts only: never hydrate removed orders into a served/work graph.
 * Non-enumerable sets cannot enter an HTTP projection or a persistence baseline.
 * The complete writer/retention graph preserves verification holds; realtime
 * needs only the removed subject's review mark for its silent queue refresh. */
export async function attachOrderRemovalContext(database, store, { subjectId = null, retention = false } = {}) {
  const holds = retention ? `(o.payout_hold OR o.data->>'disputeStatus' = 'open'
    OR EXISTS (SELECT 1 FROM claims c WHERE c.order_id=o.id AND c.status NOT IN ('released','resolved'))
    OR EXISTS (SELECT 1 FROM issues i WHERE i.order_id=o.id AND i.status NOT IN ('resolved','dismissed'))
    OR EXISTS (SELECT 1 FROM escalations e WHERE e.order_id=o.id AND e.status NOT IN ('resolved','dismissed'))
    OR EXISTS (SELECT 1 FROM refund_requests r WHERE r.order_id=o.id AND r.status NOT IN ('paid','rejected','withdrawn')))` : 'false';
  const { rows } = await database.query(`SELECT o.id, o.review_data,
    CASE WHEN ${holds} THEN ARRAY[o.client_id,o.supplier_id,o.rider_id] ELSE ARRAY[]::text[] END AS hold_owners
    FROM order_removals removed JOIN orders o ON o.id=removed.order_id WHERE ($1::text IS NULL OR o.id=$1)`, [subjectId]);
  // Public basket rows stay hidden, but their immutable membership must still
  // govern an active sibling's payment routes. No money or removed order graph
  // is loaded into this private lookup.
  const memberships = retention && rows.length ? (await database.query(`SELECT membership.order_id, b.id, b.client_id
    FROM order_basket_groups membership JOIN order_baskets b ON b.id=membership.basket_id
    WHERE ${activeOrderSql('membership.order_id')} AND NOT (${activeBasketSql('b.id')})`)).rows : [];
  Object.defineProperties(store, {
    removedReviewOrderIds: { value: new Set(rows.filter(row => row.review_data).map(row => row.id)) },
    removedVerificationHoldOwnerIds: { value: new Set(rows.flatMap(row => row.hold_owners).filter(Boolean)) },
    removedBasketMemberships: { value: new Map(memberships.map(row => [row.order_id, { id: row.id, clientId: row.client_id }])) },
  });
  return store;
}

const related = (row, order) => row.orderId === order.id || row.data?.orderId === order.id
  || (row.orderIds || row.data?.orderIds || []).includes(order.id);
const paidOrSubmitted = payment => payment && ['confirmed', 'pending_confirmation', 'submitted'].includes(payment.status);

const ORDER_REMOVAL_MESSAGES = {
  payout_released: 'This order has a released payout and must stay in the financial records.',
  refund_activity: 'This order has a refund in progress or a completed refund and must stay in the financial records.',
  payment_submitted: 'This order has a submitted or confirmed payment. Keep it for payment review and financial records.',
  financial_activity: 'This order has financial activity and must stay in the financial records.',
  shop_assigned: 'This order already has an assigned shop. Use the existing order recovery or cancellation process.',
};

// Stable reason codes shared by the Super Admin projection and mutation guard.
export function orderRemovalBlock(store, order) {
  if ((order.payoutMilestones || []).some(row => row.status === 'released') || order.state === 'payout_released'
      || (store.refundSupplierPayouts || []).some(row => related(row, order) && row.status === 'released')) {
    return 'payout_released';
  }
  if ((store.refundRequests || []).some(row => related(row, order) && !['rejected', 'withdrawn'].includes(row.status))) {
    return 'refund_activity';
  }
  // Review marks alone never erase real money. Simulation is server-generated.
  const client = store.users.find(row => row.id === order.clientId);
  const simulated = order.reviewData === true && client?.reviewData === true;
  const payments = [...Object.values(order.payments || {}), ...(store.baskets || []).filter(row => related(row, order)).map(row => row.payment)];
  if (payments.some(payment => paidOrSubmitted(payment) && !(simulated && payment.simulated === true))) {
    return 'payment_submitted';
  }
  const finance = ['orderChangePayments', 'orderChangePayouts', 'deliveryPinPayments', 'refundSettlements',
    'refundSupplierPayouts', 'voucherReservations', 'voucherRedemptions', 'voucherLedger'];
  if (finance.some(key => (store[key] || []).some(row => related(row, order)))
      || Object.values(store.credits || {}).some(account => (account.ledger || []).some(row => related(row, order)))
      || (order.revenueAdjustments || []).length || order.voucherRedemptionId || order.voucherDiscountMinor > 0 || order.voucher?.amountMinor > 0
      || (store.orderChanges || []).some(row => related(row, order) && row.status === 'pending_confirmation')
      || order.deliveryPin?.change?.status === 'pending_confirmation') {
    return 'financial_activity';
  }
  if (!simulated && (order.supplierId || (store.orderJobs || []).some(row => related(row, order) && row.supplierId))) {
    return 'shop_assigned';
  }
  return null;
}

export async function removeOrder({ database, store, user, orderId, body, at, audit, invalidate, load, save }) {
  if (!identityHasMembership(user, 'super_admin')) return { status: 403, body: { error: 'forbidden' } };
  const removed = await database.query('SELECT removed_at FROM order_removals WHERE order_id = $1', [orderId]);
  if (removed.rowCount) return { status: 409, body: { error: 'order_already_removed' } };
  const order = store.orders.find(row => row.id === orderId);
  if (!order) return { status: 404, body: { error: 'order_not_found' } };
  if (typeof body?.reason !== 'string' || !body.reason.trim() || body.reason.trim().length > 2000) {
    return { status: 400, body: { error: 'reason_required' } };
  }
  const client = store.users.find(row => row.id === order.clientId);
  if (typeof body.confirmEmail !== 'string' || !client?.email || body.confirmEmail !== client.email) {
    return { status: 400, body: { error: 'confirm_email_mismatch' } };
  }
  const blocked = orderRemovalBlock(store, order);
  if (blocked) return { status: 409, body: { error: 'order_removal_blocked', message: ORDER_REMOVAL_MESSAGES[blocked] } };
  // Reload AFTER the marker in the same locked transaction. Maintenance at the
  // save boundary must never process the removed order, and the fresh baseline
  // keeps its retained children out of diff-based deletes on every later save.
  await database.query(`INSERT INTO order_removals (order_id, removed_at, removed_by, reason) VALUES ($1, $2, $3, $4)`,
    [order.id, at, user.id, body.reason.trim()]);
  const active = await load();
  audit(active, { actor: user, action: 'order.remove', entityType: 'order', entityId: order.id,
    orderId: order.id, reason: body.reason.trim(), before: { state: order.state }, after: { removedAt: at } });
  invalidate(active, order, ['orders', 'jobs', 'dispatch', 'availability', 'claims', 'escalations', 'payouts']);
  await save(active);
  await database.query(`UPDATE notification_push_outbox SET status = 'suppressed', updated_at = now()
    WHERE status IN ('pending', 'sending') AND notification_id IN (SELECT id FROM notifications WHERE order_id = $1)`, [order.id]);
  return { status: 200, body: { id: order.id, removedAt: at } };
}
