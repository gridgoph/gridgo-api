/** Preserve ordinary voucher allocation rules; permit only verified delivery reward wallets. */
export async function up(pgm) {
 pgm.sql(`
    CREATE OR REPLACE FUNCTION guard_voucher_order() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE v numeric; f numeric; d numeric; s numeric; whole boolean; delivery_reward boolean;
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
      delivery_reward := EXISTS (SELECT 1 FROM vouchers x JOIN voucher_campaigns c ON c.id=x.campaign_id
        WHERE x.id=NEW.data->'voucher'->>'id' AND x.client_id=NEW.client_id
          AND x.data @> '{"expressDeliveryReward":true}'::jsonb AND c.purpose='express_friend_pass');
      v := (NEW.data->>'voucherDiscountMinor')::numeric;
      f := (NEW.data->>'voucherServiceFeeMinor')::numeric;
      d := (NEW.data->>'voucherDeliveryMinor')::numeric;
      s := COALESCE((NEW.data->>'voucherSupplierMinor')::numeric,0);
      IF NEW.money_model_version<>3 OR v IS NULL OR f IS NULL OR d IS NULL
        OR v<>trunc(v) OR f<>trunc(f) OR d<>trunc(d) OR s<>trunc(s) OR v<=0 OR f<0 OR d<0 OR s<0
        OR v<>f+d+s OR f>NEW.service_fee_minor OR d>NEW.delivery_fee_minor OR s>NEW.supplier_subtotal_minor
        OR (d>0 AND f<>NEW.service_fee_minor AND NOT delivery_reward) OR (s>0 AND (NOT whole OR d<>NEW.delivery_fee_minor))
        OR COALESCE((NEW.data->>'organizationDiscountMinor')::numeric,0)<>0
        OR NEW.total_minor<>NEW.supplier_subtotal_minor+NEW.service_fee_minor+NEW.delivery_fee_minor-v
        OR NEW.online_due_minor<>(CASE WHEN NEW.payment_plan='cash_delivery' THEN 0 ELSE NEW.total_minor END) OR NEW.supplier_platform_payout_minor<>NEW.supplier_subtotal_minor
        OR NEW.data->'voucher'->>'fundedBy' IS DISTINCT FROM 'GRIDGO' THEN
        RAISE EXCEPTION 'invalid GRIDGO-funded voucher snapshot' USING ERRCODE='23514';
      END IF;
      IF delivery_reward AND (whole OR NEW.fulfillment_mode <> 'delivery' OR f<>0 OR s<>0
        OR d<>floor((NEW.delivery_fee_minor::numeric*500+5000)/10000)) THEN
        RAISE EXCEPTION 'invalid Friend Pass delivery reward' USING ERRCODE='23514';
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
 `);
}
export async function down() { throw new Error("Forward-only migration"); }
