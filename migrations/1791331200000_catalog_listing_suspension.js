/**
 * A Super Admin can take one listing off the board and say why.
 *
 * The shop's own `active` flag stays the board switch. A suspension is the
 * reason beside it: clients stop seeing that listing, and the shop cannot
 * put it back until the suspension is cleared. A sibling listing is untouched.
 */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE supplier_catalog_items
      ADD COLUMN suspend_reason text,
      ADD COLUMN suspended_at timestamptz,
      ADD COLUMN suspended_by text REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL;
    ALTER TABLE supplier_catalog_items
      ADD CONSTRAINT supplier_catalog_items_suspension_check CHECK (
        (
          suspend_reason IS NULL
          AND suspended_at IS NULL
          AND suspended_by IS NULL
        )
        OR (
          suspend_reason IS NOT NULL
          AND btrim(suspend_reason) <> ''
          AND suspended_at IS NOT NULL
        )
      );
  `);
}

export async function down(pgm) {
  pgm.sql(`
    ALTER TABLE supplier_catalog_items
      DROP CONSTRAINT IF EXISTS supplier_catalog_items_suspension_check;
    ALTER TABLE supplier_catalog_items
      DROP COLUMN IF EXISTS suspended_by,
      DROP COLUMN IF EXISTS suspended_at,
      DROP COLUMN IF EXISTS suspend_reason;
  `);
}
