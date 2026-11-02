/**
 * Shop deliveries (gridgo-api#275): a shop group delivers by the earliest date
 * among its products, and the client may split it into separate deliveries.
 * A cart line's `delivery_key` names its delivery; null is the shop's main one.
 *
 * Cart groups were shop + date. Every existing cart keeps exactly its grouping:
 * the earliest-dated group of each shop stays the main delivery and each other
 * date (or undated group) gets its own key, so open baskets quote and check out
 * as before and checked-out carts still read back as they were paid. Orders,
 * baskets and payouts are snapshots and are not touched.
 */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE client_cart_lines ADD COLUMN delivery_key text
      CONSTRAINT client_cart_lines_delivery_key_check CHECK (delivery_key IS NULL OR delivery_key ~ '^dlv_[A-Za-z0-9_-]{1,96}$');

    WITH dated AS (
      SELECT l.id, l.cart_id, l.supplier_id, COALESCE(l.deadline, c.deadline, l.match_deadline) AS d
      FROM client_cart_lines l JOIN client_carts c ON c.id = l.cart_id
    ), shops AS (
      SELECT cart_id, supplier_id, min(d) AS earliest
      FROM dated GROUP BY cart_id, supplier_id
      HAVING count(DISTINCT COALESCE(d::text, 'undated')) > 1
    )
    UPDATE client_cart_lines l
      SET delivery_key = 'dlv_m' || substr(md5(dated.cart_id || '|' || dated.supplier_id || '|' || COALESCE(dated.d::text, 'undated')), 1, 24)
    FROM dated JOIN shops ON shops.cart_id = dated.cart_id AND shops.supplier_id = dated.supplier_id
    WHERE l.id = dated.id AND dated.d IS DISTINCT FROM shops.earliest;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM client_cart_lines WHERE delivery_key IS NOT NULL AND delivery_key NOT LIKE 'dlv_m%'
      ) THEN
        RAISE EXCEPTION 'Cannot reverse while clients have chosen separate deliveries';
      END IF;
    END $$;
    ALTER TABLE client_cart_lines DROP COLUMN delivery_key;
  `);
}
