/** Retire incidental normalization of old review payments during unrelated saves. */
export async function up(pgm) {
  pgm.sql(`
    SELECT pg_advisory_xact_lock(hashtext('gridgo-domain-mutation'));
    UPDATE order_payments p SET data = p.data || jsonb_build_object('simulated',true)
      || CASE WHEN p.status='confirmed' THEN jsonb_build_object('confirmationSource','review_data') ELSE '{}'::jsonb END
    FROM orders o WHERE o.id=p.order_id AND o.review_data
      AND (p.data->'simulated' IS DISTINCT FROM 'true'::jsonb
        OR (p.status='confirmed' AND p.data->>'confirmationSource' IS DISTINCT FROM 'review_data'));
    UPDATE order_baskets b SET payment = b.payment || jsonb_build_object('simulated',true)
      || CASE WHEN b.payment->>'status'='confirmed' THEN jsonb_build_object('confirmationSource','review_data') ELSE '{}'::jsonb END
    WHERE b.payment IS NOT NULL AND EXISTS (SELECT 1 FROM order_basket_groups g JOIN orders o ON o.id=g.order_id WHERE g.basket_id=b.id AND o.review_data)
      AND (b.payment->'simulated' IS DISTINCT FROM 'true'::jsonb
        OR (b.payment->>'status'='confirmed' AND b.payment->>'confirmationSource' IS DISTINCT FROM 'review_data'));
  `);
}
export async function down() { throw new Error('Forward migrations only'); }
