/**
 * Substitute-shop price rule (gridgoph/gridgo-api#225).
 *
 * 1. A cheaper substitute reserves its difference as a `shop_move` refund request
 *    with a `price_adjustment` settlement. Like the delivery-pin credit, it is
 *    paid through the manual refund flow and never stops work, holds payout
 *    stages or counts as a terminal settlement.
 * 2. The substitute is paid on its own price while committed order money stays
 *    immutable: each stage stores a signed `priceAdjustmentMinor` in its jsonb
 *    `data` and a net `amount_minor`. Gross published shares are unchanged.
 *
 * The function bodies are the latest definitions with only those exceptions widened.
 */
const PLAN_STAGES = `
  (VALUES
    (1, 'printing', 5000, false),
    (1, 'packaging_qc', 1500, false),
    (1, 'delivered', 2500, false),
    (1, 'retention', 1000, true),
    (2, 'production_started', 4000, false),
    (2, 'delivered', 3500, false),
    (2, 'issue_window', 2500, true)
  ) AS plan(version, code, share_bps, is_last)
`;
const ADJUSTMENT = "COALESCE((m.data->>'priceAdjustmentMinor')::bigint, 0)";

const payoutStages = (adjusted) => `
    CREATE OR REPLACE FUNCTION validate_order_payout_stages(target_order_id text)
    RETURNS void
    LANGUAGE plpgsql
    AS $$
    DECLARE committed orders%ROWTYPE;
    BEGIN
      SELECT * INTO committed FROM orders WHERE id = target_order_id;
      -- Exactly the stages of the order's own plan, each but the last rounded
      -- half-up from the shop's payout and all of them summing to exactly it.
      -- Net amounts add back production deductions and remove substitute-price adjustments.
      IF (SELECT COALESCE(sum(m.amount_minor + m.production_deduction_minor${adjusted ? ` - ${ADJUSTMENT}` : ''}), 0) FROM payout_milestones m WHERE m.order_id = committed.id)
           <> committed.supplier_platform_payout_minor OR
         (SELECT count(*) FROM payout_milestones WHERE order_id = committed.id) <>
           (SELECT count(*) FROM ${PLAN_STAGES} WHERE plan.version = committed.payout_plan_version) OR
         EXISTS (
           SELECT 1 FROM payout_milestones m
            WHERE m.order_id = committed.id
              AND NOT EXISTS (
                SELECT 1 FROM ${PLAN_STAGES}
                 WHERE plan.version = committed.payout_plan_version AND plan.code = m.code
              )
         ) OR
         EXISTS (
           SELECT 1
             FROM ${PLAN_STAGES}
             JOIN payout_milestones m ON m.order_id = committed.id AND m.code = plan.code
            WHERE plan.version = committed.payout_plan_version
              AND NOT plan.is_last
              AND m.amount_minor + m.production_deduction_minor${adjusted ? ` - ${ADJUSTMENT}` : ''} <> floor(
                (committed.supplier_platform_payout_minor::numeric * plan.share_bps + 5000) / 10000
              )
         ) THEN
        RAISE EXCEPTION 'payout milestones do not match committed supplier payout'
          USING ERRCODE = '23514', CONSTRAINT = 'payout_milestones_amount_check';
      END IF;
    END;
    $$;
`;

const refundMilestone = (credits, adjustments) => `
    CREATE OR REPLACE FUNCTION protect_refund_milestone() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM refund_settlements WHERE order_id=OLD.order_id AND disposition NOT IN (${adjustments})) OR
        EXISTS (SELECT 1 FROM refund_requests WHERE order_id=OLD.order_id AND kind NOT IN (${credits}) AND status NOT IN ('paid','rejected','withdrawn')) THEN
        IF OLD.status IN ('released','superseded') AND (TG_OP='DELETE' OR NEW IS DISTINCT FROM OLD) THEN
          RAISE EXCEPTION 'refund preserves released and superseded milestones' USING ERRCODE='23514', CONSTRAINT='refund_milestone_closed';
        END IF;
        IF TG_OP='UPDATE' AND NEW.status='released' AND OLD.status <> 'released' AND
          (EXISTS (SELECT 1 FROM refund_settlements WHERE order_id=OLD.order_id AND disposition NOT IN (${adjustments})) OR
           EXISTS (SELECT 1 FROM refund_requests WHERE order_id=OLD.order_id AND kind NOT IN (${credits}) AND status NOT IN ('paid','rejected','withdrawn'))) THEN
          RAISE EXCEPTION 'refund holds the original payout stages' USING ERRCODE='23514', CONSTRAINT='refund_milestone_held';
        END IF;
      END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END; $$;
`;

const refundFunds = (adjustments) => `
    CREATE OR REPLACE FUNCTION validate_refund_funds(target_order text) RETURNS void LANGUAGE plpgsql AS $$
    DECLARE principal numeric; fee numeric; delivery numeric; released numeric; obligation numeric; entitlement numeric;
    DECLARE topup_principal numeric; topup_delivery numeric;
    DECLARE rider_obligation numeric; refunded record;
    BEGIN
      SELECT COALESCE(sum(a.amount_minor) FILTER (WHERE a.component='supplier_principal'),0),
             COALESCE(sum(a.amount_minor) FILTER (WHERE a.component='service_fee'),0),
             COALESCE(sum(a.amount_minor) FILTER (WHERE a.component='delivery_pass_through'),0)
        INTO principal, fee, delivery FROM order_payment_allocations a JOIN order_payments p
          ON p.order_id=a.order_id AND p.code=a.payment_code
        WHERE a.order_id=target_order AND p.status='confirmed';
      SELECT COALESCE(sum(a.gridgo_funded_minor) FILTER(WHERE component='supplier_principal'),0),
        COALESCE(sum(a.gridgo_funded_minor) FILTER(WHERE component='delivery_pass_through'),0)
        INTO topup_principal,topup_delivery FROM order_payment_allocations a JOIN order_payments p ON p.order_id=a.order_id AND p.code=a.payment_code
        WHERE a.order_id=target_order AND (p.status='confirmed' OR p.status='not_required' AND EXISTS(SELECT 1 FROM order_payments i WHERE i.order_id=target_order AND i.code='initial' AND i.status='confirmed'));
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
        WHERE order_id=target_order AND disposition NOT IN (${adjustments}) ORDER BY sequence DESC LIMIT 1;
      SELECT COALESCE(max(rider_entitlement_minor),0) INTO rider_obligation FROM refund_settlements WHERE order_id=target_order;
      IF refunded.principal > principal OR refunded.fee > fee OR refunded.delivery > delivery OR refunded.delivery + rider_obligation > delivery + topup_delivery
        OR (entitlement IS NOT NULL AND (refunded.principal + entitlement > principal + topup_principal OR released + obligation > entitlement)) THEN
        RAISE EXCEPTION 'refund and payout exceed verified collection' USING ERRCODE='23514', CONSTRAINT='refund_available_funds_check';
      END IF;
    END; $$;
`;

const changeMoney = (adjustments) => `
    CREATE OR REPLACE FUNCTION check_order_change_money() RETURNS trigger LANGUAGE plpgsql AS $$
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
          OR EXISTS (SELECT 1 FROM refund_settlements WHERE order_id=change.order_id AND disposition NOT IN (${adjustments})) THEN
          RAISE EXCEPTION 'supplement requires collected funds and final payout stage' USING ERRCODE='23514'; END IF;
      END IF;
      RETURN NULL;
    END; $$;
`;

const CREDITS = "'delivery_pin','shop_move'";
const ADJUSTMENTS = "'delivery_adjustment','price_adjustment'";

export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE refund_requests DROP CONSTRAINT refund_requests_kind_check;
    ALTER TABLE refund_requests ADD CONSTRAINT refund_requests_kind_check CHECK (kind IN ('cancellation','complaint','delivery_pin','shop_move'));
    ALTER TABLE refund_settlements DROP CONSTRAINT refund_settlements_disposition_check;
    ALTER TABLE refund_settlements ADD CONSTRAINT refund_settlements_disposition_check
      CHECK (disposition IN ('cancelled','fulfilled_with_refund','delivery_adjustment','price_adjustment'));
    -- A price-difference credit returns item principal only.
    ALTER TABLE refund_settlements ADD CONSTRAINT price_adjustment_components_check CHECK
      (disposition <> 'price_adjustment' OR (fee_minor=0 AND delivery_minor=0 AND platform_delivery_minor=0 AND rider_entitlement_minor=0 AND principal_minor>0));
    -- Only a shop-move request carries a price adjustment, and it carries nothing else.
    CREATE FUNCTION check_price_adjustment_request() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF (NEW.disposition = 'price_adjustment') IS DISTINCT FROM
         EXISTS (SELECT 1 FROM refund_requests WHERE id=NEW.request_id AND order_id=NEW.order_id AND kind='shop_move') THEN
        RAISE EXCEPTION 'price adjustment requires its own shop-move request' USING ERRCODE='23514';
      END IF;
      RETURN NULL;
    END; $$;
    CREATE CONSTRAINT TRIGGER price_adjustment_request_matches AFTER INSERT ON refund_settlements
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_price_adjustment_request();
  `);
  pgm.sql(payoutStages(true));
  pgm.sql(refundMilestone(CREDITS, ADJUSTMENTS));
  pgm.sql(refundFunds(ADJUSTMENTS));
  pgm.sql(changeMoney(ADJUSTMENTS));
}

export async function down() {
  throw new Error('Substitute-shop credits and adjusted payout stages are durable money records; use a forward migration.');
}
