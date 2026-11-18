import { createHash, randomUUID } from 'node:crypto';
import { cashFail, cashAmounts } from './cash-policy.js';

export function cashFingerprint(value) {
  const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
/** Call inside the domain transaction. Signed debits/credits; wallet liabilities have credit balances. */
export async function postCash(db, event) {
  if (!db.inWriteTransaction()) throw new Error('cash_requires_transaction');
  const { key, kind, orderId = null, riderId = null, actorId, evidence = {} } = event;
  const entries = event.entries.filter(([, amount]) => amount !== 0);
  const zeroMemo = entries.length===0 && ['shop_paid','no_show_returned','redelivery_paid','redelivery_settled','cash_incident_opened','cash_incident_resolution'].includes(kind) && evidence.amountMinor===0;
  if ((!zeroMemo && entries.length < 2) || entries.some(([, v]) => !Number.isSafeInteger(v))
    || entries.reduce((sum, [, v]) => sum + BigInt(v), 0n) !== 0n) cashFail('cash_unbalanced');
  const fingerprint = cashFingerprint({ kind, orderId, riderId, actorId, evidence, entries });
  const previous = (await db.query('SELECT * FROM cash_journals WHERE event_key=$1', [key])).rows[0];
  if (previous) {
    if (previous.fingerprint !== fingerprint) cashFail('cash_idempotency_conflict');
    return previous.id;
  }
  const journalId = `cash_${randomUUID()}`;
  try {
    await db.query(`INSERT INTO cash_journals(id,event_key,kind,order_id,rider_id,actor_id,fingerprint,evidence)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [journalId,key,kind,orderId,riderId,actorId,fingerprint,evidence]);
  } catch(error) {
    if (error.code==='23505' && ['cash_incoming_transfer_unique','cash_remedy_transfer_unique'].includes(error.constraint)) cashFail('cash_transfer_duplicate');
    throw error;
  }
  for (const [position, [account, amount]] of entries.entries()) {
    const wallet = account.startsWith('wallet:') || account.startsWith('held:');
    await db.query('INSERT INTO cash_accounts(id,rider_id,wallet) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [account, wallet ? riderId : null, wallet]);
    await db.query('INSERT INTO cash_entries(journal_id,position,account_id,amount_minor) VALUES($1,$2,$3,$4)', [journalId,position,account,amount]);
  }
  return journalId;
}
export async function reserveCash(db, orderId, riderId, amountMinor) {
  const previous = (await db.query('SELECT * FROM cash_reservations WHERE order_id=$1', [orderId])).rows[0];
  if (previous) {
    if (previous.rider_id !== riderId || previous.amount_minor !== amountMinor || previous.released_at) cashFail('cash_reservation_conflict');
    return;
  }
  await postCash(db, { key: `reserve:${orderId}`, kind: 'wallet_reserved', orderId, riderId, actorId: riderId,
    entries: [[`wallet:${riderId}`, amountMinor], [`held:${orderId}`, -amountMinor]] });
  await db.query('INSERT INTO cash_reservations(order_id,rider_id,amount_minor) VALUES($1,$2,$3)', [orderId,riderId,amountMinor]);
}
export async function releaseCash(db, orderId, { consume = false, actorId } = {}) {
  const hold = (await db.query('SELECT * FROM cash_reservations WHERE order_id=$1 FOR UPDATE', [orderId])).rows[0];
  if (!hold || hold.released_at) {
    if (consume) cashFail('cash_reservation_required');
    return;
  }
  await postCash(db, { key: `release:${orderId}`, kind: consume ? 'gridgo_share_debited' : 'wallet_released', orderId,
    riderId: hold.rider_id, actorId: actorId || hold.rider_id,
    entries: [[`held:${orderId}`, hold.amount_minor], [consume ? 'gridgo_revenue' : `wallet:${hold.rider_id}`, -hold.amount_minor]] });
  await db.query('UPDATE cash_reservations SET released_at=now(),consumed=$2 WHERE order_id=$1', [orderId,consume]);
}
export async function cashWallet(db, riderId) {
  const { rows: [row] } = await db.query(`SELECT COALESCE((SELECT balance_minor FROM cash_accounts WHERE id=$1),0) AS available,
    COALESCE((SELECT sum(amount_minor) FROM cash_reservations WHERE rider_id=$2 AND released_at IS NULL),0)::bigint AS reserved`, [`wallet:${riderId}`,riderId]);
  return { balanceMinor: row.available + row.reserved, reservedMinor: row.reserved, availableMinor: row.available,
    lowBalance: row.available < 10000, topupAmountsMinor: [20000,50000,100000] };
}
export async function hydrateCashWallets(db, store) {
  if (!store.orders?.some(o => o.cash)) return store;
  store.cashWallets = {};
  for (const row of (await db.query(`SELECT rider_id, sum(balance_minor)::bigint AS balance,
    COALESCE(sum(balance_minor) FILTER (WHERE id LIKE 'held:%'),0)::bigint AS reserved
    FROM cash_accounts WHERE wallet GROUP BY rider_id`)).rows) store.cashWallets[row.rider_id] = { balanceMinor: row.balance, reservedMinor: row.reserved };
  return store;
}
export async function reconcileCash(db, { orderId = null, riderId = null } = {}) {
  const journals = (await db.query(`SELECT j.*,COALESCE(sum(e.amount_minor::numeric),0)::text AS difference
    FROM cash_journals j LEFT JOIN cash_entries e ON e.journal_id=j.id
    WHERE ($1::text IS NULL OR j.order_id=$1) AND ($2::text IS NULL OR j.rider_id=$2)
    GROUP BY j.id`, [orderId,riderId])).rows;
  const accounts = (await db.query(`SELECT a.id,a.balance_minor,COALESCE(sum(e.amount_minor::numeric),0)
    *CASE WHEN a.wallet THEN -1 ELSE 1 END AS derived FROM cash_accounts a LEFT JOIN cash_entries e ON e.account_id=a.id
    WHERE $1::text IS NULL OR a.rider_id=$1 GROUP BY a.id`, [riderId])).rows;
  const holds = (await db.query(`SELECT r.order_id FROM cash_reservations r LEFT JOIN cash_accounts a ON a.id='held:'||r.order_id
    WHERE a.balance_minor IS DISTINCT FROM CASE WHEN r.released_at IS NULL THEN r.amount_minor ELSE 0 END`)).rows;
  const entries=(await db.query(`SELECT e.* FROM cash_entries e JOIN cash_journals j ON j.id=e.journal_id
    WHERE ($1::text IS NULL OR j.order_id=$1) AND ($2::text IS NULL OR j.rider_id=$2)`,[orderId,riderId])).rows;
  const rows=(await db.query(`SELECT * FROM orders WHERE data ? 'cash' AND ($1::text IS NULL OR id=$1)
    AND ($2::text IS NULL OR EXISTS(SELECT 1 FROM cash_journals j WHERE j.order_id=orders.id AND j.rider_id=$2))`,[orderId,riderId])).rows;
  const vector=value=>cashFingerprint(value.filter(([,amount])=>amount!==0).sort(([a,x],[b,y])=>a.localeCompare(b)||x-y));
  const journalChecks=[];
  for (const j of journals.filter(j=>j.kind.startsWith('topup_'))) {
    const e=j.evidence,r=j.rider_id,a=e.amountMinor;
    const pending=j.kind==='topup_pending'?j:journals.find(p=>p.id===e.topupId && p.kind==='topup_pending');
    const expected=j.kind==='topup_pending'?[[`pending_bank:${r}`,a],[`pending_topup:${r}`,-a]]:
      [[`pending_bank:${r}`,-a],[`pending_topup:${r}`,a],...(j.kind==='topup_confirmed'?[['gridgo_bank',a],[`wallet:${r}`,-a]]:[])];
    const actual=entries.filter(entry=>entry.journal_id===j.id).map(entry=>[entry.account_id,entry.amount_minor]);
    journalChecks.push({journalId:j.id,ok:[20000,50000,100000].includes(a) && Boolean(pending)
      && pending.rider_id===r && pending.evidence.amountMinor===a && pending.evidence.reference===e.reference
      && vector(expected)===vector(actual)});
  }
  const orderChecks=[];
  for (const row of rows) {
    const order={...row.data,id:row.id,supplierSubtotalMinor:row.supplier_subtotal_minor,serviceFeeMinor:row.service_fee_minor,
      deliveryFeeMinor:row.delivery_fee_minor,riderCommissionBps:row.rider_commission_bps,totalMinor:row.total_minor};
    order.payoutMilestones=(await db.query('SELECT code,amount_minor,production_deduction_minor FROM payout_milestones WHERE order_id=$1',[row.id])).rows
      .map(s=>({code:s.code,amountMinor:s.amount_minor,productionDeductionMinor:s.production_deduction_minor}));
    const a=cashAmounts(order),p=order.cashProgress||{},leg=p.redelivery,related=journals.filter(j=>j.order_id===row.id),errors=[];
    const totals=new Map();
    const cases=(await db.query('SELECT data FROM issues WHERE order_id=$1',[row.id])).rows.flatMap(i=>[i.data.faultDecision,...(i.data.faultDecisionHistory||[])]).filter(Boolean);
    for (const j of related) {
      const e=j.evidence,r=j.rider_id,actual=entries.filter(entry=>entry.journal_id===j.id).map(entry=>[entry.account_id,entry.amount_minor]);
      for (const [account,amount] of actual) totals.set(account,(totals.get(account)||0n)+BigInt(amount));
      let expected;
      switch(j.kind) {
        case 'shop_paid': expected=[[`rider_cash:${r}`,-a.shopMinor],[`shop_cash:${row.supplier_id}`,a.shopMinor]];break;
        case 'cash_collected': expected=[[`client_cash:${row.client_id}`,-a.collectMinor],[`rider_cash:${r}`,a.collectMinor]];break;
        case 'wallet_reserved': expected=[[`wallet:${r}`,a.gridgoMinor],[`held:${row.id}`,-a.gridgoMinor]];break;
        case 'wallet_released': expected=[[`held:${row.id}`,a.gridgoMinor],[`wallet:${r}`,-a.gridgoMinor]];break;
        case 'gridgo_share_debited': expected=[[`held:${row.id}`,a.gridgoMinor],['gridgo_revenue',-a.gridgoMinor]];break;
        case 'voucher_funded': expected=[['voucher_expense',a.voucherMinor||0],[`wallet:${r}`,-(a.voucherMinor||0)]];break;
        case 'no_show_returned': expected=[[`client_receivable:${row.id}`,a.shopMinor],[`wallet:${r}`,-a.shopMinor]];break;
        case 'no_show_repaid': expected=[['gridgo_bank',a.collectMinor],[`client_receivable:${row.id}`,-a.shopMinor],['gridgo_revenue',-a.gridgoMinor],
          [`wallet:${r}`,-a.riderMinor],['voucher_expense',a.voucherMinor||0]];break;
        case 'remedy_paid': {
          const decision=cases.find(d=>d.id===e.decisionId && d.status==='approved' && d.costMinor===e.amountMinor && d.gridgoCostMinor===e.advanceMinor);
          if (!decision || e.advanceMinor+e.heldFeeMinor!==e.amountMinor) errors.push(`${j.id}:unapproved_remedy`);
          expected=[['cash_remedy_expense',e.advanceMinor],['gridgo_revenue',e.heldFeeMinor],['gridgo_bank',-e.amountMinor]];break;
        }
        case 'shop_recovery_created': {
          const advance=related.find(r=>r.kind==='remedy_paid' && r.evidence.remedyId===e.remedyId);
          if (!advance || advance.evidence.advanceMinor!==e.amountMinor || !e.earnedPayoutsOnly) errors.push(`${j.id}:unbacked_recovery`);
          expected=[[`shop_receivable:${row.supplier_id}`,e.amountMinor],['shop_recovery_offset',-e.amountMinor]];break;
        }
        case 'redelivery_paid': expected=leg&&[['gridgo_bank',leg.feeMinor],[`redelivery_due:${leg.id}`,-leg.feeMinor]];break;
        case 'redelivery_settled': expected=leg&&[[`redelivery_due:${leg.id}`,leg.feeMinor],[`wallet:${r}`,-leg.riderPayoutMinor],['gridgo_revenue',-leg.platformDeliveryShareMinor]];break;
        case 'cash_incident_opened': expected=[[`rider_claim:${e.incidentId}`,a.shopMinor],[`shop_return_obligation:${e.incidentId}`,-a.shopMinor]];break;
        case 'cash_incident_resolution':
          if (e.resolutionType!=='supplier_cash_return' || !e.riderReceiptConfirmed) errors.push(`${j.id}:unsupported_incident_resolution`);
          expected=[[`shop_cash:${row.supplier_id}`,-e.amountMinor],[`rider_cash:${r}`,e.amountMinor],[`rider_claim:${e.incidentId}`,-e.amountMinor],[`shop_return_obligation:${e.incidentId}`,e.amountMinor]];break;
        default: errors.push(`${j.id}:unexpected_order_movement`);
      }
      if (!expected || expected.some(([,v])=>!Number.isSafeInteger(v)) || vector(expected)!==vector(actual)) errors.push(`${j.id}:amount_mismatch`);
    }
    const count=kind=>related.filter(j=>j.kind===kind).length;
    for (const kind of ['shop_paid','cash_collected','wallet_reserved','wallet_released','gridgo_share_debited','voucher_funded','no_show_returned','no_show_repaid','redelivery_paid','redelivery_settled']) {
      if (count(kind)>1) errors.push(`${kind}:duplicate`);
    }
    if (count('cash_collected') && count('no_show_returned')) errors.push('collection_and_no_show');
    if (a.gridgoMinor && count('shop_paid') && count('wallet_reserved')!==1 && !riderId) errors.push('shop_payment_without_reservation');
    if (count('cash_collected') && count('shop_paid')!==1 && !riderId) errors.push('collection_without_shop_payment');
    const remedies=related.filter(j=>j.kind==='remedy_paid');
    const refunds=remedies.filter(j=>['partial_refund','full_refund'].includes(j.evidence.remedyType));
    if (refunds.reduce((sum,j)=>sum+BigInt(j.evidence.amountMinor),0n)>BigInt(a.collectMinor)) errors.push('refunds_exceed_collection');
    if (remedies.reduce((sum,j)=>sum+BigInt(j.evidence.heldFeeMinor),0n)>BigInt(order.serviceFeeMinor-(order.voucherServiceFeeMinor||0)+(a.productionDeductionMinor||0))) errors.push('remedy_fee_funding_exceeded');
    const incident=(await db.query('SELECT * FROM cash_incidents WHERE order_id=$1',[row.id])).rows[0];
    if (incident) {
      const resolutions=related.filter(j=>j.kind==='cash_incident_resolution');
      const returned=resolutions.reduce((sum,j)=>sum+BigInt(j.evidence.amountMinor),0n);
      if (returned!==BigInt(incident.resolved_minor) || incident.amount_minor!==a.shopMinor || !related.some(j=>j.kind==='cash_incident_opened' && j.evidence.incidentId===incident.id)) errors.push('incident_balance_mismatch');
      if (incident.status==='resolved' && (row.state!=='cancelled' || returned!==BigInt(incident.amount_minor))) errors.push('incident_closure_mismatch');
      if (count('cash_collected') || count('no_show_returned')) errors.push('incident_conflicts_with_client_collection');
    }
    if (!riderId) {
      if (Boolean(p.shopPaidAt)!==Boolean(count('shop_paid'))) errors.push('shop_payment_state_mismatch');
      if (Boolean(p.collectedAt)!==Boolean(count('cash_collected'))) errors.push('collection_state_mismatch');
      if (Boolean(p.noShowApprovedAt)!==Boolean(count('no_show_returned'))) errors.push('no_show_state_mismatch');
      if (Boolean(p.repaymentConfirmedAt)!==Boolean(count('no_show_repaid'))) errors.push('repayment_state_mismatch');
      if (p.collectedAt && a.gridgoMinor && count('gridgo_share_debited')!==1) errors.push('gridgo_share_not_debited');
      if (p.noShowApprovedAt && a.gridgoMinor && count('wallet_released')!==1) errors.push('no_show_reservation_not_released');
      if (leg?.paidAt && count('redelivery_paid')!==1 || leg?.deliveredAt && count('redelivery_settled')!==1) errors.push('redelivery_state_mismatch');
    }
    orderChecks.push({orderId:row.id,ok:errors.length===0,errors,netByAccount:Object.fromEntries([...totals].map(([account,total])=>[account,Number(total)]))});
  }
  return { ok: journals.every(j => j.difference === '0') && journalChecks.every(j=>j.ok) && accounts.every(a => BigInt(a.balance_minor) === BigInt(a.derived)) && holds.length === 0 && orderChecks.every(o=>o.ok),
    orderChecks,journalChecks,journals, accounts: accounts.map(a => ({ id: a.id, balanceMinor: a.balance_minor, derivedMinor: Number(a.derived) })), invalidReservations: holds };
}
