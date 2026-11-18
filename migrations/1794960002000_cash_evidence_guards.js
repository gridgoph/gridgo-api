export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE file_references DROP CONSTRAINT file_references_reference_type_check;
    ALTER TABLE file_references ADD CONSTRAINT file_references_reference_type_check CHECK(reference_type IN
      ('order','supplier_service','user','rider_document','supplier_catalog_item','supplier_shop_media','supplier_payout_account',
       'tracker_decision','refund_request','support_chat_message','delivery_chat_message','pickup_chat_message','client_shop_chat_message','quote_request','home_promotion','cash'));
    CREATE UNIQUE INDEX cash_incoming_transfer_unique ON cash_journals ((upper(evidence->>'reference')))
      WHERE kind IN('topup_confirmed','no_show_repaid');
    CREATE UNIQUE INDEX cash_remedy_transfer_unique ON cash_journals ((evidence->>'provider'),(evidence->>'sourceWallet'),(evidence->>'reference')) WHERE kind='remedy_paid';
    CREATE FUNCTION cash_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM cash_journals WHERE id=NEW.journal_id AND xmin=pg_current_xact_id()::text::xid) THEN
        RAISE EXCEPTION 'cash journal entries are immutable after commit' USING ERRCODE='23514'; END IF;
      RETURN NEW; END $$;
    CREATE TRIGGER cash_entries_same_transaction BEFORE INSERT ON cash_entries FOR EACH ROW EXECUTE FUNCTION cash_entry_guard();
    CREATE FUNCTION cash_account_initial() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.balance_minor<>0 THEN RAISE EXCEPTION 'cash initial balances are derived' USING ERRCODE='23514'; END IF;
      RETURN NEW; END $$;
    CREATE TRIGGER cash_initial_balance BEFORE INSERT ON cash_accounts FOR EACH ROW EXECUTE FUNCTION cash_account_initial();
    CREATE TRIGGER cash_no_truncate BEFORE TRUNCATE ON cash_journals FOR EACH STATEMENT EXECUTE FUNCTION cash_immutable();
    CREATE TRIGGER cash_no_truncate BEFORE TRUNCATE ON cash_entries FOR EACH STATEMENT EXECUTE FUNCTION cash_immutable();
    CREATE TRIGGER cash_no_truncate BEFORE TRUNCATE ON cash_accounts FOR EACH STATEMENT EXECUTE FUNCTION cash_immutable();
    CREATE TRIGGER cash_no_truncate BEFORE TRUNCATE ON cash_requests FOR EACH STATEMENT EXECUTE FUNCTION cash_immutable();
    CREATE TRIGGER cash_no_truncate BEFORE TRUNCATE ON cash_reservations FOR EACH STATEMENT EXECUTE FUNCTION cash_immutable();
    -- Published plans 1/2 retain their previous function body. Version 3 is the exact cash shop payment.
    DO $patch$ DECLARE definition text; updated text;
    BEGIN
      SELECT pg_get_functiondef('validate_order_payout_stages(text)'::regprocedure) INTO definition;
      updated := replace(definition, 'BEGIN', 'BEGIN
        IF EXISTS(SELECT 1 FROM orders WHERE id=target_order_id AND payout_plan_version=3) THEN
          PERFORM validate_cash_order(target_order_id); RETURN;
        END IF;');
      IF updated=definition THEN RAISE EXCEPTION 'cash payout function patch failed'; END IF;
      EXECUTE updated;
    END $patch$;
  `);
}
export async function down() { throw new Error('Cash evidence requires a forward migration'); }
