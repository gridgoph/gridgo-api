export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE users
      DROP CONSTRAINT users_check6,
      ADD CONSTRAINT users_legacy_shop_shape_check CHECK (
        (shop_lat IS NULL AND shop_lng IS NULL AND shop_label IS NULL)
        OR (
          role IN ('client', 'supplier')
          AND shop_lat IS NOT NULL
          AND shop_lng IS NOT NULL
          AND shop_label IS NOT NULL
          AND btrim(shop_label) <> ''
        )
      );
  `);
}

export async function down(pgm) {
  pgm.sql(`
    ALTER TABLE users
      DROP CONSTRAINT users_legacy_shop_shape_check,
      ADD CONSTRAINT users_check6 CHECK (
        (shop_lat IS NULL AND shop_lng IS NULL AND shop_label IS NULL)
        OR (
          role = 'supplier'
          AND shop_lat IS NOT NULL
          AND shop_lng IS NOT NULL
          AND shop_label IS NOT NULL
          AND btrim(shop_label) <> ''
        )
      ) NOT VALID;
  `);
}
