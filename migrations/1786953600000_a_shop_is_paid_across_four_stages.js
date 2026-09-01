/**
 * A shop is paid across the work, not at the end of it.
 *
 * Checkout replaced the four stages with two -- 75 percent when production
 * starts, 25 on delivery -- and released both automatically with no proof. That
 * left the shop's own app, the proof upload, the Operations release desk and
 * the rider's double-stored evidence all pointing at stages the platform had
 * stopped creating, which is why a shop saw both of its payouts labelled
 * "Printing".
 *
 * This converts the orders that can still be converted honestly: those where no
 * money has gone out yet. An order with a released stage keeps the two it was
 * actually paid under, because rewriting a payout that already happened would
 * make the record lie about what a shop was sent and when.
 */
export async function up(pgm) {
  pgm.sql(`
    -- Only orders where nothing has been released. One released row and the
    -- whole set is left alone.
    CREATE TEMP TABLE convertible ON COMMIT DROP AS
      SELECT o.id AS order_id,
             COALESCE(o.supplier_platform_payout_minor, 0)::bigint AS payout_base
        FROM orders o
       WHERE EXISTS (
               SELECT 1 FROM payout_milestones m
                WHERE m.order_id = o.id AND m.code IN ('initial','completion')
             )
         AND NOT EXISTS (
               SELECT 1 FROM payout_milestones m
                WHERE m.order_id = o.id AND m.status = 'released'
             );

    DELETE FROM payout_milestones m USING convertible c WHERE m.order_id = c.order_id;

    -- The first three round half-up; the last takes the remainder so the four
    -- always sum to exactly what the shop is owed.
    INSERT INTO payout_milestones (order_id, code, share_percent, amount_minor, status, position, data)
    SELECT c.order_id, s.code, s.share_percent,
           CASE WHEN s.position = 3
                THEN c.payout_base
                     - floor((c.payout_base::numeric * 5000 + 5000) / 10000)
                     - floor((c.payout_base::numeric * 1500 + 5000) / 10000)
                     - floor((c.payout_base::numeric * 2500 + 5000) / 10000)
                ELSE floor((c.payout_base::numeric * s.share_bps + 5000) / 10000)
           END,
           'pending_pof', s.position, '{"pofFileIds": []}'::jsonb
      FROM convertible c
      CROSS JOIN (VALUES
        ('printing', 50, 5000, 0),
        ('packaging_qc', 15, 1500, 1),
        ('delivered', 25, 2500, 2),
        ('retention', 10, 1000, 3)
      ) AS s(code, share_percent, share_bps, position);
  `);

  /*
   The database's own invariant has to move with the model.

   It insisted on exactly the two stages checkout created, which is what refuses
   the four the moment anything writes an order. Replaced rather than relaxed:
   a set that sums to the right total but splits it wrong is still caught.
  */
  pgm.sql(`
    CREATE OR REPLACE FUNCTION validate_order_financial_children(target_order_id text)
    RETURNS void
    LANGUAGE plpgsql
    AS $$
    DECLARE committed orders%ROWTYPE;
    DECLARE expected_downpayment bigint;
    DECLARE expected_remainder bigint;
    DECLARE expected_initial_payout bigint;
    DECLARE expected_completion_payout bigint;
    DECLARE initial_amount bigint;
    DECLARE final_amount bigint;
    DECLARE payout_sum bigint;
    DECLARE confirmed_supplier_principal bigint;
    DECLARE released_supplier_principal bigint;
    BEGIN
      SELECT * INTO committed FROM orders WHERE id = target_order_id;
      IF committed.id IS NULL OR committed.money_model_version <> 2 OR
         committed.commercial_committed_at IS NULL THEN
        RETURN;
      END IF;
      expected_downpayment := floor(
        (committed.supplier_subtotal_minor::numeric * committed.supplier_downpayment_rate_bps + 5000) / 10000
      );
      expected_remainder := committed.supplier_subtotal_minor - expected_downpayment;
      expected_initial_payout := LEAST(expected_downpayment, committed.supplier_platform_payout_minor);
      expected_completion_payout := committed.supplier_platform_payout_minor - expected_initial_payout;

      SELECT amount_minor INTO initial_amount FROM order_payments
       WHERE order_id = committed.id AND code = 'initial';
      SELECT amount_minor INTO final_amount FROM order_payments
       WHERE order_id = committed.id AND code = 'final_online';
      IF initial_amount IS DISTINCT FROM expected_downpayment + committed.service_fee_minor OR
         (SELECT count(*) FROM order_payment_allocations
           WHERE order_id = committed.id AND payment_code = 'initial') <> 2 OR
         (SELECT amount_minor FROM order_payment_allocations
           WHERE order_id = committed.id AND payment_code = 'initial' AND component = 'supplier_principal')
           IS DISTINCT FROM expected_downpayment OR
         (SELECT amount_minor FROM order_payment_allocations
           WHERE order_id = committed.id AND payment_code = 'initial' AND component = 'service_fee')
           IS DISTINCT FROM committed.service_fee_minor THEN
        RAISE EXCEPTION 'initial payment allocations do not match committed order'
          USING ERRCODE = '23514', CONSTRAINT = 'order_payment_allocations_shape_check';
      END IF;

      IF committed.payment_plan = 'delivery_online' THEN
        IF final_amount IS DISTINCT FROM expected_remainder + committed.delivery_fee_minor OR
           (SELECT count(*) FROM order_payment_allocations
             WHERE order_id = committed.id AND payment_code = 'final_online') <> 2 OR
           (SELECT amount_minor FROM order_payment_allocations
             WHERE order_id = committed.id AND payment_code = 'final_online' AND component = 'supplier_principal')
             IS DISTINCT FROM expected_remainder OR
           (SELECT amount_minor FROM order_payment_allocations
             WHERE order_id = committed.id AND payment_code = 'final_online' AND component = 'delivery_pass_through')
             IS DISTINCT FROM committed.delivery_fee_minor THEN
          RAISE EXCEPTION 'final payment allocations do not match committed delivery order'
            USING ERRCODE = '23514', CONSTRAINT = 'order_payment_allocations_shape_check';
        END IF;
      ELSIF final_amount IS NOT NULL OR EXISTS (
        SELECT 1 FROM order_payment_allocations
         WHERE order_id = committed.id AND payment_code = 'final_online'
      ) THEN
        RAISE EXCEPTION 'pickup order cannot have a final online payment'
          USING ERRCODE = '23514', CONSTRAINT = 'order_payment_allocations_shape_check';
      END IF;

      SELECT COALESCE(sum(amount_minor), 0) INTO payout_sum
        FROM payout_milestones WHERE order_id = committed.id;
      -- Four stages, always the same four, always summing to exactly what the
      -- shop is owed. The first three round half-up and the last takes the
      -- remainder, so a set that sums right but splits wrong is still caught.
      IF payout_sum <> committed.supplier_platform_payout_minor OR
         (SELECT count(*) FROM payout_milestones WHERE order_id = committed.id) <> 4 OR
         EXISTS (SELECT 1 FROM payout_milestones
                  WHERE order_id = committed.id
                    AND code NOT IN ('printing','packaging_qc','delivered','retention')) OR
         (SELECT amount_minor FROM payout_milestones
           WHERE order_id = committed.id AND code = 'printing')
           IS DISTINCT FROM floor((committed.supplier_platform_payout_minor::numeric * 5000 + 5000) / 10000) OR
         (SELECT amount_minor FROM payout_milestones
           WHERE order_id = committed.id AND code = 'packaging_qc')
           IS DISTINCT FROM floor((committed.supplier_platform_payout_minor::numeric * 1500 + 5000) / 10000) OR
         (SELECT amount_minor FROM payout_milestones
           WHERE order_id = committed.id AND code = 'delivered')
           IS DISTINCT FROM floor((committed.supplier_platform_payout_minor::numeric * 2500 + 5000) / 10000) THEN
        RAISE EXCEPTION 'payout milestones do not match committed supplier payout'
          USING ERRCODE = '23514', CONSTRAINT = 'payout_milestones_amount_check';
      END IF;

      SELECT COALESCE(sum(allocation.amount_minor), 0)
        INTO confirmed_supplier_principal
        FROM order_payment_allocations allocation
        JOIN order_payments payment
          ON payment.order_id = allocation.order_id
         AND payment.code = allocation.payment_code
       WHERE allocation.order_id = committed.id
         AND allocation.component = 'supplier_principal'
         AND payment.status = 'confirmed';
      SELECT COALESCE(sum(amount_minor), 0)
        INTO released_supplier_principal
        FROM payout_milestones
       WHERE order_id = committed.id
         AND status = 'released';
      IF released_supplier_principal > confirmed_supplier_principal THEN
        RAISE EXCEPTION 'released payout exceeds confirmed supplier principal'
          USING ERRCODE = '23514',
                CONSTRAINT = 'payout_milestones_collected_principal_check';
      END IF;
    END;
    $$;
  `);
}

/**
 * There is no honest reverse.
 *
 * Going back would have to invent which of four stages a shop had reached from
 * two that never recorded it. Down leaves the rows where they are: the code
 * constraint still permits both shapes, so the older release policy reads them
 * without a schema change.
 */
export async function down() {}
