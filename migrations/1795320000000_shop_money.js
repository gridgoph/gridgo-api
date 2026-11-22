/** Separate append-only tables preserve legacy INSERT/upsert shapes. */
export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE shop_money_ledger (
      id text PRIMARY KEY, event_key text NOT NULL UNIQUE,
      supplier_id text NOT NULL REFERENCES users(id), order_id text REFERENCES orders(id), kind text NOT NULL,
      owed_delta_minor bigint NOT NULL CHECK(owed_delta_minor BETWEEN -9007199254740991 AND 9007199254740991),
      owing_delta_minor bigint NOT NULL CHECK(owing_delta_minor BETWEEN -9007199254740991 AND 9007199254740991),
      created_at timestamptz NOT NULL, position integer NOT NULL, data jsonb NOT NULL DEFAULT '{}'
    );
    CREATE INDEX shop_money_ledger_shop ON shop_money_ledger(supplier_id,created_at,id);
    CREATE TABLE shop_money_events (
      id text PRIMARY KEY, event_key text NOT NULL UNIQUE, supplier_id text REFERENCES users(id),
      kind text NOT NULL, created_at timestamptz NOT NULL, position integer NOT NULL, data jsonb NOT NULL DEFAULT '{}'
    );
    CREATE INDEX shop_money_events_shop ON shop_money_events(supplier_id,created_at,id);
    CREATE UNIQUE INDEX shop_money_outgoing_reference ON shop_money_events((upper(btrim(data->>'reference'))))
      WHERE kind='transfer_paid' AND data->>'reference' IS NOT NULL;
    CREATE UNIQUE INDEX shop_money_incoming_reference ON shop_money_events((upper(btrim(data->>'reference'))))
      WHERE kind='pay_confirmed';
    CREATE TRIGGER shop_money_ledger_immutable BEFORE UPDATE OR DELETE ON shop_money_ledger
      FOR EACH ROW EXECUTE FUNCTION protect_refund_ledger();
    CREATE TRIGGER shop_money_events_immutable BEFORE UPDATE OR DELETE ON shop_money_events
      FOR EACH ROW EXECUTE FUNCTION protect_refund_ledger();
    UPDATE orders SET data=data || jsonb_build_object('clientPayment',jsonb_build_object(
      'methods',CASE WHEN COALESCE(data->'coversOrderTotal','false'::jsonb)='true'::jsonb THEN '[]'::jsonb
        ELSE jsonb_build_array(CASE WHEN jsonb_typeof(data->'cash')='object' THEN 'cash_to_rider'
          WHEN data->>'paymentMethod'='counter_cash' THEN 'counter_cash' ELSE 'in_app_qr' END) END
        || CASE WHEN jsonb_typeof(data->'voucher')='object' OR COALESCE((data->>'voucherDiscountMinor')::bigint,0)>0
          OR COALESCE(data->'coversOrderTotal','false'::jsonb)='true'::jsonb THEN '["voucher"]'::jsonb ELSE '[]'::jsonb END,
      'settlement',CASE WHEN data->>'orderType'='express' THEN 'daily' ELSE 'staged' END))
      WHERE NOT (data ? 'clientPayment');
    -- Include bonuses in the same cap as principal and in-flight reservations.
    DO $$ DECLARE definition text; BEGIN
      SELECT pg_get_viewdef('supplier_verification_capacity_items'::regclass,true) INTO definition;
      definition:=rtrim(definition, E';\\n ');
      EXECUTE 'CREATE OR REPLACE VIEW supplier_verification_capacity_items AS ' || definition ||
        ' UNION ALL SELECT l.supplier_id,l.order_id,l.payout_key,l.amount_minor,l.net_amount_minor,''paid''::text
          FROM supplier_verification_ledger l JOIN orders o ON o.id=l.order_id
          WHERE l.kind=''released'' AND l.payout_key LIKE ''bonus:%'' AND NOT o.review_data';
    END $$;
    UPDATE platform_settings SET settings=settings || jsonb_build_object('riderCommissionBps',8000,
      'shopMoney',jsonb_build_object('launchedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'payoutTime','16:00','minimumMinor',10000,'payDeadline','18:00','reminderTime','17:00',
        'bonusRateBps',2000,'bonusDays',7,'bonusCapMinor',50000,
        'businessWeekdays',jsonb_build_array(1,2,3,4,5),'holidays','[]'::jsonb,'extraBusinessDates','[]'::jsonb));
  `);
}
