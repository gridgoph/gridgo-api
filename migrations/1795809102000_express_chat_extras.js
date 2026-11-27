/** One narrow, checked price amendment at accept-first acceptance. All other commitments stay frozen. */
export async function up(pgm) {
  pgm.sql(`
    CREATE FUNCTION express_chat_extra_reprice(old_order orders, new_order orders) RETURNS boolean LANGUAGE plpgsql AS $$
    DECLARE extras jsonb; item jsonb; principal numeric; gross numeric; discount numeric;
    BEGIN
      extras := new_order.data#>'{expressOrder,shopExtras}';
      IF old_order.state IS DISTINCT FROM 'supplier_assigned' OR new_order.state IS DISTINCT FROM 'awaiting_initial_payment'
        OR old_order.data#>>'{expressOrder,acceptFlow}' IS DISTINCT FROM '2'
        OR old_order.data#>>'{shopAcceptance,status}' IS DISTINCT FROM 'pending'
        OR new_order.data#>>'{shopAcceptance,status}' IS DISTINCT FROM 'accepted'
        OR old_order.data#>>'{expressOrder,shopExtras,appliedAt}' IS NOT NULL
        OR extras->>'appliedAt' IS NULL OR jsonb_typeof(extras->'items') IS DISTINCT FROM 'array'
        OR extras->'items' IS DISTINCT FROM old_order.data#>'{expressOrder,shopExtras,items}'
        OR (extras->>'printingMinor')::numeric IS DISTINCT FROM old_order.supplier_subtotal_minor
        OR new_order.data->'serviceFeeSchedule' IS DISTINCT FROM old_order.data->'serviceFeeSchedule'
        OR new_order.data#>>'{serviceFeeSchedule,version}' IS DISTINCT FROM '3'
        OR EXISTS(SELECT 1 FROM order_payments WHERE order_id=old_order.id AND status NOT IN ('not_submitted','not_required'))
        OR EXISTS(SELECT 1 FROM payout_milestones WHERE order_id=old_order.id AND status <> 'pending_pof') THEN RETURN false; END IF;
      principal := old_order.supplier_subtotal_minor;
      IF jsonb_array_length(extras->'items') NOT BETWEEN 1 AND 20 THEN RETURN false; END IF;
      FOR item IN SELECT value FROM jsonb_array_elements(extras->'items') LOOP
        IF jsonb_typeof(item->'quantity') IS DISTINCT FROM 'number' OR jsonb_typeof(item->'unitPriceMinor') IS DISTINCT FROM 'number'
          OR (item->>'quantity')::numeric <> trunc((item->>'quantity')::numeric) OR (item->>'quantity')::numeric NOT BETWEEN 1 AND 10000
          OR (item->>'unitPriceMinor')::numeric <> trunc((item->>'unitPriceMinor')::numeric) OR (item->>'unitPriceMinor')::numeric < 0
          OR NOT EXISTS(SELECT 1 FROM client_shop_chat_messages WHERE id=(item->>'agreedMessageId')::uuid
            AND order_id=old_order.id AND supplier_id=old_order.supplier_id AND sender_role='client' AND btrim(original_body)<>'') THEN RETURN false; END IF;
        principal := principal + (item->>'quantity')::numeric * (item->>'unitPriceMinor')::numeric;
      END LOOP;
      gross := gridgo_service_fee(principal,new_order.data->'serviceFeeSchedule');
      discount := least(gross,floor((principal*COALESCE((old_order.data->>'organizationDiscountRateBps')::numeric,0)+5000)/10000));
      IF new_order.supplier_subtotal_minor IS DISTINCT FROM principal OR new_order.subtotal_minor IS DISTINCT FROM principal
        OR new_order.supplier_platform_payout_minor IS DISTINCT FROM principal
        OR (new_order.data->>'grossServiceFeeMinor')::numeric IS DISTINCT FROM gross
        OR (new_order.data->>'organizationDiscountMinor')::numeric IS DISTINCT FROM discount
        OR new_order.service_fee_minor IS DISTINCT FROM gross-discount-COALESCE((old_order.data->>'memberPerkMinor')::numeric,0)
        OR new_order.total_minor IS DISTINCT FROM principal+new_order.service_fee_minor+old_order.delivery_fee_minor-COALESCE((old_order.data->>'voucherDiscountMinor')::numeric,0)
        OR new_order.online_due_minor IS DISTINCT FROM new_order.total_minor
        OR (new_order.data->'serviceFeeWorking') IS DISTINCT FROM jsonb_build_array(jsonb_build_object(
          'rule','express_minimum_or_rate','applied',CASE WHEN principal>0 AND principal*(new_order.data#>>'{serviceFeeSchedule,rateBps}')::numeric >= (new_order.data#>>'{serviceFeeSchedule,minimumMinor}')::numeric*10000 THEN 'rate' ELSE 'minimum' END,
          'minimumMinor',new_order.data#>'{serviceFeeSchedule,minimumMinor}','rateBps',new_order.data#>'{serviceFeeSchedule,rateBps}',
          'roundTotalUpToMinor',50,'amountMinor',gross)) THEN RETURN false; END IF;
      IF (to_jsonb(new_order)-ARRAY['rider_payout_minor','platform_delivery_share_minor','state','updated_at','data','supplier_subtotal_minor','subtotal_minor','service_fee_minor','total_minor','online_due_minor','supplier_platform_payout_minor'])
        IS DISTINCT FROM (to_jsonb(old_order)-ARRAY['rider_payout_minor','platform_delivery_share_minor','state','updated_at','data','supplier_subtotal_minor','subtotal_minor','service_fee_minor','total_minor','online_due_minor','supplier_platform_payout_minor'])
        OR (new_order.data-ARRAY['grossServiceFeeMinor','organizationDiscountMinor','serviceFeeWorking','expressOrder','shopAcceptance','timeline','clientServiceFeeMinor','clientSupplierSubtotalMinor'])
        IS DISTINCT FROM (old_order.data-ARRAY['grossServiceFeeMinor','organizationDiscountMinor','serviceFeeWorking','expressOrder','shopAcceptance','timeline','clientServiceFeeMinor','clientSupplierSubtotalMinor'])
        OR ((new_order.data->'expressOrder')-ARRAY['shopExtras','payBy','paymentOptions','events','reroute'])
        IS DISTINCT FROM ((old_order.data->'expressOrder')-ARRAY['shopExtras','payBy','paymentOptions','events','reroute']) THEN RETURN false; END IF;
      RETURN true;
    END $$;
    DO $$ DECLARE definition text; updated text; name text; BEGIN
      FOREACH name IN ARRAY ARRAY['protect_committed_order_money','guard_service_fee_snapshot','guard_organization_discount'] LOOP
        SELECT pg_get_functiondef((name||'()')::regprocedure) INTO definition;
        updated := regexp_replace(definition,'BEGIN',E'BEGIN\n      IF TG_OP = ''UPDATE'' AND express_chat_extra_reprice(OLD,NEW) THEN RETURN NEW; END IF;');
        IF updated=definition THEN RAISE EXCEPTION 'price guard patch did not apply: %',name; END IF;
        EXECUTE updated;
      END LOOP;
    END $$;
    CREATE FUNCTION guard_express_chat_extras() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF OLD.data#>>'{expressOrder,shopExtras,appliedAt}' IS NOT NULL
        AND OLD.data#>'{expressOrder,shopExtras}' IS DISTINCT FROM NEW.data#>'{expressOrder,shopExtras}' THEN
        RAISE EXCEPTION 'accepted chat extras are immutable' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER express_chat_extras_immutable BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION guard_express_chat_extras();
  `);
}
export async function down() { throw new Error('Forward-only migration'); }
