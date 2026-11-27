/** Forward-only release controls and server-owned standard-document provenance. */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE supplier_catalog_items ADD COLUMN signup_document_standard boolean NOT NULL DEFAULT false;
    UPDATE platform_settings SET settings=settings || jsonb_build_object(
      'supplierOnboarding',COALESCE(settings->'supplierOnboarding','{"autoApproveDocuments":false,"unverifiedShopsEnabled":false}'::jsonb),
      'areaPriceGuides',COALESCE(settings->'areaPriceGuides','[]'::jsonb));

    CREATE FUNCTION supplier_payout_verified(shop text) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT EXISTS(SELECT 1 FROM approval_cases WHERE user_id=shop AND kind='supplier' AND status='approved')
        AND NOT EXISTS(SELECT 1 FROM supplier_profiles p WHERE p.user_id=shop AND p.home_printer IS NOT NULL
          AND (p.home_printer->>'starterApprovedAt' IS NULL
            OR NOT EXISTS(SELECT 1 FROM files f JOIN file_references r ON r.file_id=f.file_id
              WHERE f.owner_id=shop AND f.purpose='verification_document' AND f.state='ready'
                AND f.data->>'deletedAt' IS NULL AND f.data->>'deleteRequestedAt' IS NULL
                AND r.reference_type='user' AND r.reference_id=shop
                AND COALESCE(f.data->>'verificationDocumentType',r.data->>'documentType')='tin')
            OR NOT EXISTS(SELECT 1 FROM files f JOIN file_references r ON r.file_id=f.file_id
              WHERE f.owner_id=shop AND f.purpose='verification_document' AND f.state='ready'
                AND f.data->>'deletedAt' IS NULL AND f.data->>'deleteRequestedAt' IS NULL
                AND r.reference_type='user' AND r.reference_id=shop
                AND COALESCE(f.data->>'verificationDocumentType',r.data->>'documentType') IN('business_permit','barangay_clearance'))));
    $$;
    -- Bonus reservations on cash orders occupy capacity too. Principal cash
    -- transfers remain verified-only and never consume an unverified allowance.
    DO $$ DECLARE definition text; BEGIN
      SELECT pg_get_viewdef('supplier_verification_capacity_items'::regclass,true) INTO definition;
      definition:=rtrim(definition,E';\\n ');
      EXECUTE 'CREATE OR REPLACE VIEW supplier_verification_capacity_items AS ' || definition ||
        ' UNION ALL SELECT l.supplier_id,l.order_id,l.payout_key,l.amount_minor,l.net_amount_minor,''reserved''::text
          FROM supplier_verification_ledger l JOIN orders o ON o.id=l.order_id
          WHERE l.kind=''reserved'' AND l.payout_key LIKE ''bonus:%'' AND NOT o.review_data
            AND (o.payout_plan_version=3 OR jsonb_typeof(o.data->''cash'')=''object'')
            AND l.position=(SELECT max(position) FROM supplier_verification_ledger WHERE payout_key=l.payout_key)
            AND NOT EXISTS(SELECT 1 FROM supplier_verification_ledger WHERE payout_key=l.payout_key AND kind=''released'')';
    END $$;
    CREATE FUNCTION supplier_onboarding_payout_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target text; shop text; payout text; cap bigint; total numeric; exposure numeric; enabled boolean;
    BEGIN
      target:=COALESCE(to_jsonb(NEW)->>'order_id',to_jsonb(NEW)->>'id');
      SELECT supplier_id INTO shop FROM orders WHERE id=target;
      IF shop IS NULL OR supplier_payout_verified(shop) THEN RETURN NULL; END IF;
      IF TG_TABLE_NAME='cash_journals' THEN
        IF (NEW.kind='shop_paid' OR (NEW.kind='remedy_paid' AND NEW.evidence->>'remedyType' IN('reprint','replacement')))
          AND EXISTS(SELECT 1 FROM supplier_signups WHERE supplier_id=shop AND steps#>'{prints,documents,pricesMinor}' IS NOT NULL)
          THEN RAISE EXCEPTION 'cash_supplier_verification_required' USING ERRCODE='23514'; END IF;
        RETURN NULL;
      ELSIF TG_TABLE_NAME='supplier_verification_ledger' THEN
        IF NEW.kind NOT IN('reserved','released') THEN RETURN NULL; END IF;
        payout:=NEW.payout_key;
      ELSE
        IF TG_OP='UPDATE' AND to_jsonb(OLD)->>'status'='released' THEN RETURN NULL; END IF;
        IF TG_TABLE_NAME<>'order_change_payouts' AND to_jsonb(NEW)->>'status' IS DISTINCT FROM 'released' THEN RETURN NULL; END IF;
        payout:=CASE TG_TABLE_NAME WHEN 'payout_milestones' THEN 'stage:'||target||':'||(to_jsonb(NEW)->>'code')
          WHEN 'refund_supplier_payouts' THEN 'settlement:'||(to_jsonb(NEW)->>'id')
          ELSE 'change:'||target||':'||(to_jsonb(NEW)->>'change_id') END;
      END IF;
      -- Old cash protocols cannot become a payout path for a now-unverified shop.
      IF EXISTS(SELECT 1 FROM orders WHERE id=target AND (payout_plan_version=3 OR jsonb_typeof(data->'cash')='object'))
        AND payout NOT LIKE 'bonus:%' THEN
        IF EXISTS(SELECT 1 FROM supplier_signups WHERE supplier_id=shop AND steps#>'{prints,documents,pricesMinor}' IS NOT NULL) THEN RAISE EXCEPTION 'cash_supplier_verification_required' USING ERRCODE='23514'; END IF;
        RETURN NULL;
      END IF;
      SELECT COALESCE((settings#>>'{supplierVerification,payoutCapMinor}')::bigint,500000),
        COALESCE((settings#>>'{supplierOnboarding,unverifiedShopsEnabled}')::boolean,false)
        INTO cap,enabled FROM platform_settings WHERE singleton;
      IF NOT COALESCE(enabled,false) AND EXISTS(SELECT 1 FROM supplier_signups s WHERE s.supplier_id=shop
          AND s.steps#>'{prints,documents,pricesMinor}' IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM supplier_verification_ledger l WHERE l.payout_key=payout AND l.kind='released')
        AND (TG_TABLE_NAME<>'supplier_verification_ledger' OR to_jsonb(NEW)->>'kind'='reserved')
        THEN RAISE EXCEPTION 'supplier_verification_required' USING ERRCODE='23514'; END IF;
      SELECT COALESCE(sum(amount_minor),0) INTO total FROM supplier_verification_capacity_items WHERE supplier_id=shop;
      SELECT COALESCE(max(amount_minor),0) INTO exposure FROM supplier_verification_capacity_items WHERE supplier_id=shop AND payout_key=payout;
      IF exposure>0 AND total>COALESCE(cap,500000) THEN RAISE EXCEPTION 'verification_payout_cap' USING ERRCODE='23514'; END IF;
      RETURN NULL;
    END; $$;
    CREATE CONSTRAINT TRIGGER supplier_onboarding_stage_cap AFTER INSERT OR UPDATE ON payout_milestones
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION supplier_onboarding_payout_guard();
    CREATE CONSTRAINT TRIGGER supplier_onboarding_settlement_cap AFTER INSERT OR UPDATE ON refund_supplier_payouts
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION supplier_onboarding_payout_guard();
    CREATE CONSTRAINT TRIGGER supplier_onboarding_change_cap AFTER INSERT ON order_change_payouts
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION supplier_onboarding_payout_guard();
    CREATE CONSTRAINT TRIGGER supplier_onboarding_reservation_cap AFTER INSERT ON supplier_verification_ledger
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION supplier_onboarding_payout_guard();
    CREATE CONSTRAINT TRIGGER supplier_onboarding_cash_cap AFTER INSERT ON cash_journals
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION supplier_onboarding_payout_guard();
  `);
}
export async function down() { throw new Error('Forward-only migration'); }
