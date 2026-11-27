/** Additive release controls only. No order, run, transfer or payout is rewritten. */
export async function up(pgm) {
  const enabled=['development','test'].includes(process.env.NODE_ENV);
  pgm.sql(`UPDATE platform_settings SET settings=jsonb_set(settings,'{shopMoney}',
    jsonb_build_object('weeklyNettingEnabled',${enabled},'overduePauseEnabled',${enabled})
      || COALESCE(settings->'shopMoney','{}'::jsonb));
    CREATE UNIQUE INDEX shop_money_receipt_reference ON shop_money_events((upper(btrim(data->>'reference'))))
      WHERE kind='payment_receipt';
    CREATE INDEX shop_money_receipt_review ON shop_money_events((data->>'reviewBy')) WHERE kind='payment_receipt';
    CREATE FUNCTION protect_scheduled_shop_payout() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE scheduled jsonb;
    BEGIN
      IF NEW.kind NOT IN ('reserved','released') THEN RETURN NEW; END IF;
      -- Keep an already reserved transfer's exact amount, including one made
      -- by the prior runtime before this protection shipped.
      IF EXISTS(SELECT 1 FROM (SELECT * FROM supplier_verification_ledger WHERE payout_key=NEW.payout_key ORDER BY position DESC LIMIT 1) prior
        WHERE prior.kind IN ('reserved','released') AND prior.amount_minor=NEW.amount_minor AND prior.net_amount_minor=NEW.net_amount_minor) THEN RETURN NEW; END IF;
      SELECT item INTO scheduled FROM shop_money_events e
        CROSS JOIN LATERAL jsonb_array_elements(e.data->'shops') shop
        CROSS JOIN LATERAL jsonb_array_elements(shop->'items') item
        WHERE e.kind='settlement_run' AND shop->>'supplierId'=NEW.supplier_id AND item->>'key'=NEW.payout_key
        ORDER BY e.position LIMIT 1;
      IF scheduled IS NOT NULL AND ((scheduled->>'amountMinor')::bigint<>NEW.amount_minor
        OR (scheduled->>'netAmountMinor')::bigint<>NEW.net_amount_minor) THEN
        RAISE EXCEPTION 'scheduled_payout_reconciliation_required' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER scheduled_shop_payout_immutable BEFORE INSERT ON supplier_verification_ledger
      FOR EACH ROW EXECUTE FUNCTION protect_scheduled_shop_payout();`);
}
export async function down() {throw new Error('forward_only');}
