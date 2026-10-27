/** Launch claims extend the existing voucher wallet; cash and GRIDGO funding stay separate. */
export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE promotion_settings (
      id text PRIMARY KEY CHECK (id='launch'), version integer NOT NULL CHECK(version>0), settings jsonb NOT NULL
    );
    INSERT INTO promotion_settings VALUES ('launch',1,'{
      "founding":{"amountMinor":20000,"slots":30,"startsAt":"2026-10-26T16:00:00.000Z","endsAt":"2026-11-08T15:59:59.000Z","enabled":true},
      "friendPass":{"amountMinor":10000,"perFounder":1,"total":20,"upgradeAt":"2026-11-01T15:59:59.000Z","enabled":true},
      "budgetCapMinor":900000,"rewards":{"surveyMinor":1500,"missionMinor":1500,"inviteMinor":1500}}');
    ALTER TABLE voucher_campaigns ADD COLUMN covers_order_total boolean NOT NULL DEFAULT false;
    ALTER TABLE voucher_campaigns DROP CONSTRAINT voucher_campaigns_purpose_check;
    ALTER TABLE voucher_campaigns ADD CONSTRAINT voucher_campaigns_purpose_check
      CHECK(purpose IN ('manual','survey','founding_tester','tester_referral','founding_launch','friend_pass'));
    ALTER TABLE vouchers ADD COLUMN promotion_kind text CHECK(promotion_kind IN ('founding','friend_pass'));
    CREATE UNIQUE INDEX promotion_one_discount_per_person ON vouchers(client_id) WHERE promotion_kind IS NOT NULL;
    CREATE TABLE promotion_invites (
      id text PRIMARY KEY, founder_id text NOT NULL REFERENCES users(id),
      email text NOT NULL UNIQUE CHECK(email=lower(btrim(email))), client_id text REFERENCES users(id),
      voucher_id text UNIQUE REFERENCES vouchers(id), status text NOT NULL CHECK(status IN ('invited','claimed','skipped_already_founder')),
      created_at timestamptz NOT NULL, claimed_at timestamptz, notified_at timestamptz,
      CHECK(client_id IS NULL OR client_id<>founder_id),
      CHECK((status='claimed')=(voucher_id IS NOT NULL AND claimed_at IS NOT NULL))
    );
    CREATE INDEX promotion_invites_founder ON promotion_invites(founder_id);
    ALTER TABLE voucher_ledger DROP CONSTRAINT voucher_ledger_kind_check;
    ALTER TABLE voucher_ledger ADD CONSTRAINT voucher_ledger_kind_check
      CHECK(kind IN ('issued','reserved','released','redeemed','restored','client_fault','no_fault','void','reissue','upgraded'));
    ALTER TABLE order_payment_allocations ADD COLUMN gridgo_funded_minor money_minor NOT NULL DEFAULT 0 CHECK(gridgo_funded_minor>=0);

    CREATE OR REPLACE FUNCTION guard_voucher_order() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE v numeric; f numeric; d numeric; s numeric; whole boolean;
    BEGIN
      IF TG_OP='UPDATE' AND OLD.commercial_committed_at IS NOT NULL AND
        (OLD.data->'voucher' IS DISTINCT FROM NEW.data->'voucher' OR
         OLD.data->'voucherDiscountMinor' IS DISTINCT FROM NEW.data->'voucherDiscountMinor' OR
         OLD.data->'voucherServiceFeeMinor' IS DISTINCT FROM NEW.data->'voucherServiceFeeMinor' OR
         OLD.data->'voucherDeliveryMinor' IS DISTINCT FROM NEW.data->'voucherDeliveryMinor' OR
         OLD.data->'voucherSupplierMinor' IS DISTINCT FROM NEW.data->'voucherSupplierMinor' OR
         OLD.data->'gridgoSupplierTopupMinor' IS DISTINCT FROM NEW.data->'gridgoSupplierTopupMinor' OR
         OLD.data->'gridgoRiderTopupMinor' IS DISTINCT FROM NEW.data->'gridgoRiderTopupMinor' OR
         OLD.data->'coversOrderTotal' IS DISTINCT FROM NEW.data->'coversOrderTotal') THEN
        RAISE EXCEPTION 'voucher money snapshot is immutable' USING ERRCODE='23514';
      END IF;
      IF NOT NEW.data ? 'voucher' THEN RETURN NEW; END IF;
      whole := COALESCE((NEW.data->'voucher'->>'coversOrderTotal')::boolean,false);
      v := (NEW.data->>'voucherDiscountMinor')::numeric;
      f := (NEW.data->>'voucherServiceFeeMinor')::numeric;
      d := (NEW.data->>'voucherDeliveryMinor')::numeric;
      s := COALESCE((NEW.data->>'voucherSupplierMinor')::numeric,0);
      IF NEW.money_model_version<>3 OR v IS NULL OR f IS NULL OR d IS NULL
        OR v<>trunc(v) OR f<>trunc(f) OR d<>trunc(d) OR s<>trunc(s) OR v<=0 OR f<0 OR d<0 OR s<0
        OR v<>f+d+s OR f>NEW.service_fee_minor OR d>NEW.delivery_fee_minor OR s>NEW.supplier_subtotal_minor
        OR (d>0 AND f<>NEW.service_fee_minor) OR (s>0 AND (NOT whole OR d<>NEW.delivery_fee_minor))
        OR COALESCE((NEW.data->>'organizationDiscountMinor')::numeric,0)<>0
        OR NEW.total_minor<>NEW.supplier_subtotal_minor+NEW.service_fee_minor+NEW.delivery_fee_minor-v
        OR NEW.online_due_minor<>NEW.total_minor OR NEW.supplier_platform_payout_minor<>NEW.supplier_subtotal_minor
        OR NEW.data->'voucher'->>'fundedBy' IS DISTINCT FROM 'GRIDGO' THEN
        RAISE EXCEPTION 'invalid GRIDGO-funded voucher snapshot' USING ERRCODE='23514';
      END IF;
      IF whole AND (NOT EXISTS (SELECT 1 FROM vouchers x JOIN voucher_campaigns c ON c.id=x.campaign_id
          WHERE x.id=NEW.data->'voucher'->>'id' AND x.client_id=NEW.client_id AND c.covers_order_total)
        OR COALESCE((NEW.data->>'gridgoSupplierTopupMinor')::numeric,-1)<>s
        OR COALESCE((NEW.data->>'gridgoRiderTopupMinor')::numeric,-1)<>greatest(0,
          floor((NEW.delivery_fee_minor::numeric*COALESCE(NEW.rider_commission_bps,10000)+5000)/10000)-(NEW.delivery_fee_minor-d))) THEN
        RAISE EXCEPTION 'invalid GRIDGO top-up' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE OR REPLACE FUNCTION validate_voucher_allocations() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target text; o orders%ROWTYPE; principal bigint; fee bigint; delivery bigint; payments bigint;
      funded_principal bigint; funded_fee bigint; funded_delivery bigint; whole boolean;
    BEGIN
      IF TG_TABLE_NAME='orders' THEN target:=NEW.id; ELSE target:=COALESCE(NEW.order_id,OLD.order_id); END IF;
      SELECT * INTO o FROM orders WHERE id=target;
      IF o.id IS NULL THEN RETURN NULL; END IF;
      whole := COALESCE((o.data->'voucher'->>'coversOrderTotal')::boolean,false);
      IF NOT o.data ? 'voucher' THEN
        IF EXISTS(SELECT 1 FROM order_payment_allocations WHERE order_id=target AND gridgo_funded_minor<>0) THEN
          RAISE EXCEPTION 'GRIDGO allocation requires a whole-order voucher' USING ERRCODE='23514'; END IF;
        RETURN NULL;
      END IF;
      SELECT COALESCE(sum(amount_minor) FILTER(WHERE component='supplier_principal'),0),
        COALESCE(sum(amount_minor) FILTER(WHERE component='service_fee'),0),
        COALESCE(sum(amount_minor) FILTER(WHERE component='delivery_pass_through'),0),
        COALESCE(sum(gridgo_funded_minor) FILTER(WHERE component='supplier_principal'),0),
        COALESCE(sum(gridgo_funded_minor) FILTER(WHERE component='service_fee'),0),
        COALESCE(sum(gridgo_funded_minor) FILTER(WHERE component='delivery_pass_through'),0)
        INTO principal,fee,delivery,funded_principal,funded_fee,funded_delivery FROM order_payment_allocations WHERE order_id=target;
      SELECT sum(amount_minor) INTO payments FROM order_payments WHERE order_id=target;
      IF principal<>o.supplier_subtotal_minor-COALESCE((o.data->>'voucherSupplierMinor')::bigint,0)
        OR fee<>o.service_fee_minor-(o.data->>'voucherServiceFeeMinor')::bigint
        OR delivery<>o.delivery_fee_minor-(o.data->>'voucherDeliveryMinor')::bigint OR payments IS DISTINCT FROM o.total_minor
        OR funded_principal<>(CASE WHEN whole THEN COALESCE((o.data->>'voucherSupplierMinor')::bigint,0) ELSE 0 END)
        OR funded_fee<>(CASE WHEN whole THEN (o.data->>'voucherServiceFeeMinor')::bigint ELSE 0 END)
        OR funded_delivery<>(CASE WHEN whole THEN (o.data->>'voucherDeliveryMinor')::bigint ELSE 0 END)
        OR EXISTS(SELECT 1 FROM order_payments p WHERE p.order_id=target AND p.amount_minor<>
          (SELECT COALESCE(sum(a.amount_minor),0) FROM order_payment_allocations a WHERE a.order_id=target AND a.payment_code=p.code)) THEN
        RAISE EXCEPTION 'voucher payment allocations do not reconcile' USING ERRCODE='23514';
      END IF;
      IF whole AND (SELECT COALESCE(sum(amount_minor),0) FROM payout_milestones WHERE order_id=target AND status='released') >
        (SELECT COALESCE(sum(a.amount_minor) FILTER(WHERE p.status='confirmed'),0)+COALESCE(sum(a.gridgo_funded_minor),0)
         FROM order_payment_allocations a JOIN order_payments p ON p.order_id=a.order_id AND p.code=a.payment_code
         WHERE a.order_id=target AND a.component='supplier_principal' AND (p.status='confirmed' OR p.status='not_required' AND EXISTS
          (SELECT 1 FROM order_payments i WHERE i.order_id=target AND i.code='initial' AND i.status='confirmed'))) THEN
        RAISE EXCEPTION 'released payout exceeds confirmed cash and GRIDGO funding' USING ERRCODE='23514';
      END IF;
      RETURN NULL;
    END $$;
    CREATE CONSTRAINT TRIGGER voucher_payout_funding AFTER INSERT OR UPDATE OR DELETE ON payout_milestones
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_voucher_allocations();

    -- A funding column cannot change a committed promise, even if its sum stays constant.
    CREATE FUNCTION protect_gridgo_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF (TG_OP='DELETE' AND OLD.gridgo_funded_minor>0 OR TG_OP='UPDATE' AND
          (OLD.gridgo_funded_minor>0 OR NEW.gridgo_funded_minor>0) AND OLD IS DISTINCT FROM NEW) AND EXISTS
        (SELECT 1 FROM orders WHERE id=OLD.order_id AND commercial_committed_at IS NOT NULL) THEN
        RAISE EXCEPTION 'GRIDGO funding snapshot is immutable' USING ERRCODE='23514'; END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER gridgo_allocation_immutable BEFORE UPDATE OR DELETE ON order_payment_allocations FOR EACH ROW EXECUTE FUNCTION protect_gridgo_allocation();
  `);
  pgm.sql(`
CREATE OR REPLACE FUNCTION guard_service_fee_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='UPDATE' AND OLD.commercial_committed_at IS NOT NULL AND NEW.commercial_committed_at IS NOT NULL
        AND (OLD.data->'serviceFeeSchedule' IS DISTINCT FROM NEW.data->'serviceFeeSchedule'
          OR OLD.data->'serviceFeeWorking' IS DISTINCT FROM NEW.data->'serviceFeeWorking') THEN
        RAISE EXCEPTION 'committed service fee schedule is immutable' USING ERRCODE='23514';
      END IF;
      IF NEW.data->'serviceFeeSchedule'->>'version'='1' AND NEW.commercial_committed_at IS NOT NULL
        AND NEW.service_fee_rate_bps IS DISTINCT FROM (NEW.data->'serviceFeeSchedule'->>'rateBps')::integer THEN
        RAISE EXCEPTION 'flat schedule must match legacy rate' USING ERRCODE='23514';
      END IF;
      IF NEW.data->'serviceFeeSchedule'->>'version'='2' AND NEW.commercial_committed_at IS NOT NULL THEN
        IF NEW.service_fee_rate_bps IS NOT NULL OR (NEW.data->>'grossServiceFeeMinor')::numeric IS DISTINCT FROM
          gridgo_service_fee(NEW.supplier_subtotal_minor,NEW.data->'serviceFeeSchedule')
          OR (COALESCE((NEW.data->>'voucherDeliveryMinor')::numeric,0) <> 0 AND NOT COALESCE((NEW.data->'voucher'->>'coversOrderTotal')::boolean,false)) THEN
          RAISE EXCEPTION 'invalid bracket fee snapshot' USING ERRCODE='23514';
        END IF;
      END IF;
      RETURN NEW;
    END $$;
`);
  pgm.sql(`
CREATE OR REPLACE FUNCTION guard_order_survey() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'survey history is immutable' USING ERRCODE = '23514';
      END IF;
      IF TG_OP = 'UPDATE' AND (OLD.submitted_at IS NOT NULL OR
        ROW(OLD.order_id,OLD.client_id,OLD.completed_at,OLD.opened_at,OLD.expires_at,OLD.fulfillment_kind,OLD.notified_at)
        IS DISTINCT FROM ROW(NEW.order_id,NEW.client_id,NEW.completed_at,NEW.opened_at,NEW.expires_at,NEW.fulfillment_kind,NEW.notified_at)) THEN
        RAISE EXCEPTION 'survey facts and submitted answers are immutable' USING ERRCODE = '23514';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM orders WHERE id=NEW.order_id AND client_id=NEW.client_id) THEN
        RAISE EXCEPTION 'survey owner mismatch' USING ERRCODE = '23514';
      END IF;
      IF NEW.reward_voucher_id IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtext('gridgo-domain-mutation'));
        IF NOT EXISTS (SELECT 1 FROM vouchers v JOIN voucher_campaigns c ON c.id=v.campaign_id
          WHERE v.id=NEW.reward_voucher_id AND v.client_id=NEW.client_id AND v.value_minor=c.value_minor
          AND v.issued_at=NEW.submitted_at AND v.expires_at=v.issued_at + interval '720 hours'
          AND NOT v.email_allowed AND c.purpose='survey') THEN
          RAISE EXCEPTION 'invalid survey reward' USING ERRCODE = '23514';
        END IF;
        IF EXISTS (SELECT 1 FROM order_surveys s WHERE s.client_id=NEW.client_id AND s.order_id<>NEW.order_id
          AND s.reward_voucher_id IS NOT NULL AND s.submitted_at > NEW.submitted_at - interval '168 hours'
          AND s.submitted_at < NEW.submitted_at + interval '168 hours') THEN
          RAISE EXCEPTION 'survey reward cooldown' USING ERRCODE = '23514';
        END IF;
      END IF;
      RETURN NEW;
    END $$;
`);
  pgm.sql(`
CREATE OR REPLACE FUNCTION guard_founding_tester() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'tester history is immutable' USING ERRCODE='23514'; END IF;
      IF TG_OP='UPDATE' AND (OLD.client_id IS DISTINCT FROM NEW.client_id
        OR (OLD.awarded_at IS NOT NULL AND ROW(OLD.awarded_at,OLD.reward_voucher_id,OLD.reward_reused)
          IS DISTINCT FROM ROW(NEW.awarded_at,NEW.reward_voucher_id,NEW.reward_reused))
        OR (OLD.reminded_2_at IS NOT NULL AND OLD.reminded_2_at IS DISTINCT FROM NEW.reminded_2_at)
        OR (OLD.reminded_5_at IS NOT NULL AND OLD.reminded_5_at IS DISTINCT FROM NEW.reminded_5_at)) THEN
        RAISE EXCEPTION 'tester history is immutable' USING ERRCODE='23514';
      END IF;
      IF NEW.awarded_at IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM vouchers v JOIN voucher_campaigns c ON c.id=v.campaign_id
        JOIN users u ON u.id=v.client_id WHERE v.id=NEW.reward_voucher_id AND v.client_id=NEW.client_id
          AND NOT u.review_data AND v.value_minor=c.value_minor AND NOT v.email_allowed
          AND v.expires_at=v.issued_at + interval '720 hours'
          AND ((NEW.reward_reused AND c.purpose='survey' AND EXISTS
            (SELECT 1 FROM order_surveys s WHERE s.client_id=NEW.client_id AND s.reward_voucher_id=v.id))
            OR (NOT NEW.reward_reused AND c.purpose='founding_tester' AND v.issued_at=NEW.awarded_at))
      ) THEN RAISE EXCEPTION 'invalid tester reward' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $$;
`);
  pgm.sql(`
CREATE OR REPLACE FUNCTION guard_tester_reward() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'tester reward history is immutable' USING ERRCODE='23514'; END IF;
      IF TG_OP='UPDATE' AND (ROW(OLD.id,OLD.kind,OLD.client_id,OLD.inviter_id,OLD.invite_id,OLD.amount_minor,OLD.created_at)
        IS DISTINCT FROM ROW(NEW.id,NEW.kind,NEW.client_id,NEW.inviter_id,NEW.invite_id,NEW.amount_minor,NEW.created_at)
        OR (OLD.status IN ('voided','blocked') AND OLD IS DISTINCT FROM NEW)
        OR (OLD.issued_at IS NOT NULL AND (ROW(OLD.issued_at,OLD.voucher_id,OLD.inviter_voucher_id,OLD.checks,OLD.evidence)
          IS DISTINCT FROM ROW(NEW.issued_at,NEW.voucher_id,NEW.inviter_voucher_id,NEW.checks,NEW.evidence) OR NEW.status NOT IN ('issued','voided')))) THEN
        RAISE EXCEPTION 'tester reward history is immutable' USING ERRCODE='23514';
      END IF;
      IF NEW.kind='referral' AND NOT EXISTS(SELECT 1 FROM tester_invites WHERE id=NEW.invite_id AND client_id=NEW.client_id AND inviter_id=NEW.inviter_id) THEN
        RAISE EXCEPTION 'tester reward attribution mismatch' USING ERRCODE='23514'; END IF;
      IF NEW.voucher_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM vouchers WHERE id=NEW.voucher_id AND client_id=NEW.client_id AND value_minor=CASE WHEN NEW.amount_minor=0 THEN (SELECT value_minor FROM voucher_campaigns WHERE id=campaign_id) WHEN NEW.kind='referral' THEN NEW.amount_minor/2 ELSE NEW.amount_minor END) THEN
        RAISE EXCEPTION 'tester reward owner mismatch' USING ERRCODE='23514'; END IF;
      IF NEW.inviter_voucher_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM vouchers WHERE id=NEW.inviter_voucher_id AND client_id=NEW.inviter_id AND value_minor=CASE WHEN NEW.amount_minor=0 THEN (SELECT value_minor FROM voucher_campaigns WHERE id=campaign_id) WHEN NEW.kind='referral' THEN NEW.amount_minor/2 ELSE NEW.amount_minor END) THEN
        RAISE EXCEPTION 'tester inviter reward owner mismatch' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $$;
`);
  pgm.sql(`
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
        WHERE order_id=target_order AND disposition <> 'delivery_adjustment' ORDER BY sequence DESC LIMIT 1;
      SELECT COALESCE(max(rider_entitlement_minor),0) INTO rider_obligation FROM refund_settlements WHERE order_id=target_order;
      IF refunded.principal > principal OR refunded.fee > fee OR refunded.delivery > delivery OR refunded.delivery + rider_obligation > delivery + topup_delivery
        OR (entitlement IS NOT NULL AND (refunded.principal + entitlement > principal + topup_principal OR released + obligation > entitlement)) THEN
        RAISE EXCEPTION 'refund and payout exceed verified collection' USING ERRCODE='23514', CONSTRAINT='refund_available_funds_check';
      END IF;
    END; $$;
`);
  pgm.sql(`
    ALTER TABLE tester_rewards DROP CONSTRAINT tester_rewards_amount_minor_check;
    ALTER TABLE tester_rewards ADD CONSTRAINT tester_rewards_amount_minor_check CHECK(amount_minor BETWEEN 0 AND 9007199254740991);
    ALTER TABLE tester_rewards DROP CONSTRAINT tester_rewards_check;
    ALTER TABLE tester_rewards ADD CONSTRAINT tester_rewards_check CHECK(
      (kind='mission' AND inviter_id IS NULL AND invite_id IS NULL AND inviter_voucher_id IS NULL)
      OR (kind='referral' AND inviter_id IS NOT NULL AND invite_id IS NOT NULL AND inviter_id<>client_id AND amount_minor>0 AND amount_minor%2=0));
  `);
}
export async function down() { throw new Error('Launch promotions and funding snapshots require a forward migration'); }
