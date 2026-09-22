/**
 * A listing can state the soonest and latest it will be ready.
 *
 * `turnaround_hours` is still the promised ready-in (the latest). This column
 * is the soonest. Both optional until the shop overrides ready-in time; when
 * they do, the floor cannot sit after the promise.
 */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE supplier_catalog_items
      ADD COLUMN minimum_turnaround_hours integer;
    ALTER TABLE supplier_catalog_items
      ADD CONSTRAINT supplier_catalog_items_minimum_turnaround_hours_check
        CHECK (
          minimum_turnaround_hours IS NULL
          OR (
            minimum_turnaround_hours > 0
            AND (turnaround_hours IS NULL OR minimum_turnaround_hours <= turnaround_hours)
          )
        );
  `);
}

export async function down(pgm) {
  pgm.sql(`
    ALTER TABLE supplier_catalog_items
      DROP CONSTRAINT IF EXISTS supplier_catalog_items_minimum_turnaround_hours_check;
    ALTER TABLE supplier_catalog_items
      DROP COLUMN IF EXISTS minimum_turnaround_hours;
  `);
}
