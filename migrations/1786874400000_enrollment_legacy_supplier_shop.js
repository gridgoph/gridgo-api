export async function up(pgm) {
  pgm.sql(`
    DO $migration$
    DECLARE
      shop_constraint text;
    BEGIN
      SELECT conname INTO shop_constraint
        FROM pg_constraint
       WHERE conrelid = 'users'::regclass
         AND contype = 'c'
         AND pg_get_constraintdef(oid) LIKE '%shop_lat IS NULL%'
         AND pg_get_constraintdef(oid) LIKE '%role = ''supplier''%';
      IF shop_constraint IS NULL THEN
        RAISE EXCEPTION 'users legacy supplier shop constraint not found';
      END IF;
      EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', shop_constraint);
    END
    $migration$;

    ALTER TABLE users
      ADD CONSTRAINT users_legacy_shop_shape_check CHECK (
        (shop_lat IS NULL AND shop_lng IS NULL AND shop_label IS NULL)
        OR (
          shop_lat IS NOT NULL
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
      ADD CONSTRAINT users_legacy_supplier_shop_shape_check CHECK (
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
