export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE payout_milestones DROP CONSTRAINT payout_milestones_status_check;
    ALTER TABLE payout_milestones ADD CONSTRAINT payout_milestones_status_check
      CHECK (status IN ('pending','pending_pof','pof_attached','released','superseded'));
    ALTER TABLE file_references DROP CONSTRAINT file_references_reference_type_check;
    ALTER TABLE file_references ADD CONSTRAINT file_references_reference_type_check CHECK (reference_type IN (
      'order','supplier_service','user','rider_document','supplier_catalog_item','supplier_shop_media',
      'supplier_payout_account','tracker_decision','refund_request'));
    CREATE TABLE refund_requests (
      id text PRIMARY KEY,
      order_id text NOT NULL REFERENCES orders(id),
      client_id text NOT NULL REFERENCES users(id),
      policy_version text NOT NULL CHECK (policy_version='available_funds_v1'),
      status text NOT NULL CHECK (status IN ('requested','reviewed','approved','destination_review','payment_in_progress','payment_unknown','paid','rejected','withdrawn')),
      version integer NOT NULL CHECK (version > 0),
      kind text NOT NULL CHECK (kind IN ('cancellation','complaint')),
      reason text NOT NULL CHECK (btrim(reason) <> ''),
      before_production boolean NOT NULL,
      late boolean NOT NULL,
      filing_deadline_at timestamptz,
      order_state_at_filing text NOT NULL,
      evidence_file_ids jsonb NOT NULL DEFAULT '[]',
      destination jsonb,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      UNIQUE(id, order_id)
    );
    CREATE UNIQUE INDEX refund_requests_active_order_idx ON refund_requests(order_id)
      WHERE status NOT IN ('paid','rejected','withdrawn');
    CREATE INDEX refund_requests_client_idx ON refund_requests(client_id, created_at);
    CREATE TABLE refund_settlements (
      id text PRIMARY KEY,
      request_id text NOT NULL UNIQUE REFERENCES refund_requests(id),
      order_id text NOT NULL REFERENCES orders(id),
      sequence integer NOT NULL CHECK (sequence > 0),
      created_by text NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL,
      reason text NOT NULL CHECK (btrim(reason) <> ''),
      shop_agreement text NOT NULL,
      delivery_evidence text NOT NULL,
      disposition text NOT NULL CHECK (disposition IN ('cancelled','fulfilled_with_refund')),
      shop_entitlement_minor money_minor NOT NULL CHECK (shop_entitlement_minor >= 0),
      rider_entitlement_minor money_minor NOT NULL CHECK (rider_entitlement_minor >= 0),
      principal_minor money_minor NOT NULL CHECK (principal_minor >= 0),
      fee_minor money_minor NOT NULL CHECK (fee_minor >= 0),
      delivery_minor money_minor NOT NULL CHECK (delivery_minor >= 0),
      platform_delivery_minor money_minor NOT NULL CHECK (platform_delivery_minor BETWEEN 0 AND delivery_minor),
      total_minor money_minor NOT NULL CHECK (total_minor > 0 AND total_minor = principal_minor + fee_minor + delivery_minor),
      snapshot jsonb NOT NULL,
      UNIQUE(order_id, sequence),
      UNIQUE(id, request_id, total_minor),
      FOREIGN KEY(request_id, order_id) REFERENCES refund_requests(id, order_id)
    );
    CREATE INDEX refund_settlements_order_idx ON refund_settlements(order_id);
    CREATE TABLE refund_supplier_payouts (
      id text PRIMARY KEY,
      settlement_id text NOT NULL UNIQUE REFERENCES refund_settlements(id),
      order_id text NOT NULL REFERENCES orders(id),
      supplier_id text NOT NULL REFERENCES users(id),
      amount_minor money_minor NOT NULL CHECK (amount_minor > 0),
      status text NOT NULL CHECK (status IN ('pending','released','superseded')),
      reference text,
      receipt_file_id text UNIQUE REFERENCES files(file_id),
      released_at timestamptz,
      released_by text REFERENCES users(id),
      created_at timestamptz NOT NULL,
      CHECK ((status='released') = (reference IS NOT NULL AND btrim(reference) <> '' AND receipt_file_id IS NOT NULL
        AND released_at IS NOT NULL AND released_by IS NOT NULL))
    );
    CREATE UNIQUE INDEX refund_supplier_payout_pending_idx ON refund_supplier_payouts(order_id) WHERE status='pending';
    CREATE TABLE refund_attempts (
      id text PRIMARY KEY,
      request_id text NOT NULL REFERENCES refund_requests(id),
      settlement_id text NOT NULL REFERENCES refund_settlements(id),
      payer_id text NOT NULL REFERENCES users(id),
      status text NOT NULL CHECK (status IN ('in_progress','unknown','failed','paid')),
      destination jsonb NOT NULL,
      amount_minor money_minor NOT NULL CHECK (amount_minor > 0),
      provider text NOT NULL CHECK (btrim(provider) <> ''),
      source_wallet text NOT NULL CHECK (btrim(source_wallet) <> ''),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      FOREIGN KEY(settlement_id, request_id, amount_minor) REFERENCES refund_settlements(id, request_id, total_minor)
    );
    CREATE UNIQUE INDEX refund_attempts_active_idx ON refund_attempts(request_id) WHERE status <> 'failed';
    CREATE TABLE refund_payments (
      id text PRIMARY KEY,
      request_id text NOT NULL UNIQUE REFERENCES refund_requests(id),
      attempt_id text NOT NULL UNIQUE REFERENCES refund_attempts(id),
      provider text NOT NULL,
      source_wallet text NOT NULL,
      reference text NOT NULL CHECK (btrim(reference) <> ''),
      receipt_file_id text NOT NULL UNIQUE REFERENCES files(file_id),
      amount_minor money_minor NOT NULL CHECK (amount_minor > 0),
      paid_at timestamptz NOT NULL,
      recorded_by text NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL,
      UNIQUE(provider, source_wallet, reference)
    );
    CREATE TABLE refund_events (
      id text PRIMARY KEY,
      request_id text NOT NULL REFERENCES refund_requests(id),
      request_version integer NOT NULL CHECK (request_version > 0),
      actor_id text NOT NULL REFERENCES users(id),
      kind text NOT NULL,
      reason text NOT NULL,
      created_at timestamptz NOT NULL,
      data jsonb NOT NULL,
      UNIQUE(request_id, request_version)
    );
    CREATE TABLE refund_commands (
      id text PRIMARY KEY,
      actor_id text NOT NULL REFERENCES users(id),
      request_key text NOT NULL,
      route text NOT NULL,
      body_hash text NOT NULL,
      response jsonb NOT NULL,
      created_at timestamptz NOT NULL,
      UNIQUE(actor_id, request_key)
    );
    CREATE FUNCTION protect_refund_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'refund ledger entries are immutable' USING ERRCODE = '23514';
    END; $$;
    CREATE TRIGGER refund_settlements_immutable BEFORE UPDATE OR DELETE ON refund_settlements
      FOR EACH ROW EXECUTE FUNCTION protect_refund_ledger();
    CREATE TRIGGER refund_payments_immutable BEFORE UPDATE OR DELETE ON refund_payments
      FOR EACH ROW EXECUTE FUNCTION protect_refund_ledger();
    CREATE TRIGGER refund_events_immutable BEFORE UPDATE OR DELETE ON refund_events
      FOR EACH ROW EXECUTE FUNCTION protect_refund_ledger();
    CREATE TRIGGER refund_commands_immutable BEFORE UPDATE OR DELETE ON refund_commands
      FOR EACH ROW EXECUTE FUNCTION protect_refund_ledger();
    CREATE FUNCTION protect_refund_request() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' OR
        (to_jsonb(NEW) - 'status' - 'version' - 'destination' - 'updated_at') IS DISTINCT FROM
        (to_jsonb(OLD) - 'status' - 'version' - 'destination' - 'updated_at') THEN
        RAISE EXCEPTION 'refund request filing facts are immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER refund_request_immutable BEFORE UPDATE OR DELETE ON refund_requests
      FOR EACH ROW EXECUTE FUNCTION protect_refund_request();

    CREATE FUNCTION protect_refund_supplier_payout() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE settlement refund_settlements%ROWTYPE;
    BEGIN
      IF TG_OP='INSERT' THEN
        SELECT * INTO settlement FROM refund_settlements WHERE id=NEW.settlement_id;
        IF NEW.order_id IS DISTINCT FROM settlement.order_id OR
          NEW.supplier_id IS DISTINCT FROM (SELECT supplier_id FROM orders WHERE id=NEW.order_id) OR
          NEW.amount_minor IS DISTINCT FROM (settlement.snapshot->>'remainingShopMinor')::bigint THEN
          RAISE EXCEPTION 'shop payout must exactly match the agreed settlement remainder' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END IF;
      IF TG_OP='DELETE' OR OLD.status <> 'pending' OR
        NEW.id IS DISTINCT FROM OLD.id OR NEW.settlement_id IS DISTINCT FROM OLD.settlement_id OR
        NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id OR
        NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'settlement payout identity, amount and completed record are immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER refund_supplier_payout_immutable BEFORE INSERT OR UPDATE OR DELETE ON refund_supplier_payouts
      FOR EACH ROW EXECUTE FUNCTION protect_refund_supplier_payout();
    CREATE FUNCTION protect_refund_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' OR OLD.status IN ('failed','paid') OR
        (to_jsonb(NEW) - 'status' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'updated_at') THEN
        RAISE EXCEPTION 'refund payment attempt destination and amount are immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER refund_attempt_immutable BEFORE UPDATE OR DELETE ON refund_attempts
      FOR EACH ROW EXECUTE FUNCTION protect_refund_attempt();
    CREATE FUNCTION protect_refund_milestone() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM refund_settlements WHERE order_id=OLD.order_id) OR
        EXISTS (SELECT 1 FROM refund_requests WHERE order_id=OLD.order_id AND status NOT IN ('paid','rejected','withdrawn')) THEN
        IF OLD.status IN ('released','superseded') AND (TG_OP='DELETE' OR NEW IS DISTINCT FROM OLD) THEN
          RAISE EXCEPTION 'refund preserves released and superseded milestones' USING ERRCODE='23514', CONSTRAINT='refund_milestone_closed';
        END IF;
        IF TG_OP='UPDATE' AND NEW.status='released' AND OLD.status <> 'released' AND
          (EXISTS (SELECT 1 FROM refund_settlements WHERE order_id=OLD.order_id) OR
           EXISTS (SELECT 1 FROM refund_requests WHERE order_id=OLD.order_id AND status NOT IN ('paid','rejected','withdrawn'))) THEN
          RAISE EXCEPTION 'refund holds the original payout stages' USING ERRCODE='23514', CONSTRAINT='refund_milestone_held';
        END IF;
      END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER refund_milestone_guard BEFORE UPDATE OR DELETE ON payout_milestones
      FOR EACH ROW EXECUTE FUNCTION protect_refund_milestone();
    CREATE FUNCTION check_refund_payment() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE attempt refund_attempts%ROWTYPE;
    BEGIN
      SELECT * INTO attempt FROM refund_attempts WHERE id=NEW.attempt_id;
      IF attempt.request_id IS DISTINCT FROM NEW.request_id OR attempt.amount_minor IS DISTINCT FROM NEW.amount_minor
        OR attempt.provider IS DISTINCT FROM NEW.provider OR attempt.source_wallet IS DISTINCT FROM NEW.source_wallet
        OR attempt.status <> 'paid' THEN
        RAISE EXCEPTION 'refund payment must match its reserved attempt' USING ERRCODE='23514';
      END IF;
      RETURN NULL;
    END; $$;
    CREATE CONSTRAINT TRIGGER refund_payment_matches_attempt AFTER INSERT ON refund_payments
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_refund_payment();

    -- A separate net-collection invariant applies to every historical plan.
    -- Original payment allocations and published payout stages stay untouched.
    CREATE FUNCTION validate_refund_funds(target_order text) RETURNS void LANGUAGE plpgsql AS $$
    DECLARE principal numeric; fee numeric; delivery numeric; released numeric; obligation numeric; entitlement numeric;
    DECLARE rider_obligation numeric; refunded record;
    BEGIN
      SELECT COALESCE(sum(a.amount_minor) FILTER (WHERE a.component='supplier_principal'),0),
             COALESCE(sum(a.amount_minor) FILTER (WHERE a.component='service_fee'),0),
             COALESCE(sum(a.amount_minor) FILTER (WHERE a.component='delivery_pass_through'),0)
        INTO principal, fee, delivery FROM order_payment_allocations a JOIN order_payments p
          ON p.order_id=a.order_id AND p.code=a.payment_code
        WHERE a.order_id=target_order AND p.status='confirmed';
      SELECT COALESCE(sum(amount_minor),0) INTO released FROM payout_milestones
        WHERE order_id=target_order AND status='released';
      SELECT COALESCE(sum(amount_minor),0) INTO obligation FROM refund_supplier_payouts
        WHERE order_id=target_order AND status IN ('pending','released');
      SELECT COALESCE(sum(principal_minor),0) AS principal, COALESCE(sum(fee_minor),0) AS fee,
        COALESCE(sum(delivery_minor),0) AS delivery INTO refunded FROM refund_settlements WHERE order_id=target_order;
      SELECT shop_entitlement_minor INTO entitlement FROM refund_settlements WHERE order_id=target_order ORDER BY sequence DESC LIMIT 1;
      SELECT COALESCE(max(rider_entitlement_minor),0) INTO rider_obligation FROM refund_settlements WHERE order_id=target_order;
      IF EXISTS (SELECT 1 FROM refund_settlements WHERE order_id=target_order) AND
        (refunded.principal + entitlement > principal OR released + obligation > entitlement
          OR refunded.fee > fee OR refunded.delivery + rider_obligation > delivery) THEN
        RAISE EXCEPTION 'refund and payout exceed verified collection' USING ERRCODE='23514', CONSTRAINT='refund_available_funds_check';
      END IF;
    END; $$;
    CREATE FUNCTION check_refund_funds() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM validate_refund_funds(COALESCE(NEW.order_id, OLD.order_id));
      RETURN NULL;
    END; $$;
    CREATE CONSTRAINT TRIGGER refund_funds_settlements AFTER INSERT ON refund_settlements
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_refund_funds();
    CREATE CONSTRAINT TRIGGER refund_funds_supplier_payouts AFTER INSERT OR UPDATE OR DELETE ON refund_supplier_payouts
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_refund_funds();
    CREATE CONSTRAINT TRIGGER refund_funds_milestones AFTER INSERT OR UPDATE OR DELETE ON payout_milestones
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_refund_funds();
    CREATE CONSTRAINT TRIGGER refund_funds_payments AFTER INSERT OR UPDATE OR DELETE ON order_payments
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_refund_funds();
    CREATE CONSTRAINT TRIGGER refund_funds_allocations AFTER INSERT OR UPDATE OR DELETE ON order_payment_allocations
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_refund_funds();
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM refund_requests) OR EXISTS (SELECT 1 FROM refund_commands)
        OR EXISTS (SELECT 1 FROM payout_milestones WHERE status='superseded') THEN
        RAISE EXCEPTION 'Refund money and evidence are durable; use a forward migration';
      END IF;
    END; $$;
    DROP TRIGGER refund_funds_milestones ON payout_milestones;
    DROP TRIGGER refund_milestone_guard ON payout_milestones;
    DROP TRIGGER refund_funds_payments ON order_payments;
    DROP TRIGGER refund_funds_allocations ON order_payment_allocations;
    DROP TABLE refund_commands, refund_events, refund_payments, refund_attempts, refund_supplier_payouts, refund_settlements, refund_requests;
    DROP FUNCTION check_refund_payment(), check_refund_funds(), validate_refund_funds(text), protect_refund_attempt(),
      protect_refund_supplier_payout(), protect_refund_ledger(), protect_refund_milestone(), protect_refund_request();
    ALTER TABLE payout_milestones DROP CONSTRAINT payout_milestones_status_check;
    ALTER TABLE payout_milestones ADD CONSTRAINT payout_milestones_status_check
      CHECK (status IN ('pending','pending_pof','pof_attached','released'));
    ALTER TABLE file_references DROP CONSTRAINT file_references_reference_type_check;
    ALTER TABLE file_references ADD CONSTRAINT file_references_reference_type_check CHECK (reference_type IN (
      'order','supplier_service','user','rider_document','supplier_catalog_item','supplier_shop_media',
      'supplier_payout_account','tracker_decision'));
  `);
}
