/** Legacy preparations cannot act as the payer of a daily batch. The database
 * additionally blocks privileged historical recording and cancellation. */
export async function up(pgm) {
  pgm.sql(`
    CREATE INDEX shop_money_transfer_outcomes ON shop_money_events((data->>'transferId'))
      WHERE kind IN ('transfer_paid','transfer_cancelled');
    CREATE INDEX shop_money_shop_kind_position ON shop_money_events(supplier_id,kind,position DESC);
    CREATE FUNCTION protect_shop_money_claim() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE transfer text;
    BEGIN
      IF NEW.kind NOT IN ('reserved','released','reservation_cancelled') THEN RETURN NEW; END IF;
      SELECT b.id INTO transfer FROM shop_money_events b
        WHERE b.kind='transfer_reserved' AND b.supplier_id=NEW.supplier_id
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(b.data->'items') item WHERE item->>'key'=NEW.payout_key)
          AND NOT EXISTS(SELECT 1 FROM shop_money_events outcome
            WHERE outcome.kind IN ('transfer_paid','transfer_cancelled') AND outcome.data->>'transferId'=b.id)
        LIMIT 1;
      IF transfer IS NOT NULL AND current_setting('gridgo.shop_money_transfer',true) IS DISTINCT FROM transfer
      THEN RAISE EXCEPTION 'shop_money_transfer_route_required' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER shop_money_claim_mutations BEFORE INSERT ON supplier_verification_ledger
      FOR EACH ROW EXECUTE FUNCTION protect_shop_money_claim();
  `);
}
