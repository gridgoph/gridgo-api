/**
 * Let a starter template be reordered in one transaction.
 *
 * The two orderings are unique and were checked row by row, so a build that
 * reshuffles a template -- inserting a printer choice ahead of the material
 * one, say -- collided with the rows it was replacing: the new group claimed
 * sort order 0 while the old row still held it, inside the same statement.
 *
 * Deferring the check to commit makes a reshuffle expressible without weakening
 * anything. Two groups still cannot share a position in a saved template; they
 * are simply allowed to pass through each other on the way there.
 *
 * The constraints stay INITIALLY IMMEDIATE, so ordinary writes fail at the
 * statement that caused them and keep their own error.
 */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE listing_starter_groups
      DROP CONSTRAINT listing_starter_groups_starter_id_sort_order_key,
      ADD CONSTRAINT listing_starter_groups_starter_id_sort_order_key
        UNIQUE (starter_id, sort_order) DEFERRABLE INITIALLY IMMEDIATE;

    ALTER TABLE listing_starter_options
      DROP CONSTRAINT listing_starter_options_starter_group_id_sort_order_key,
      ADD CONSTRAINT listing_starter_options_starter_group_id_sort_order_key
        UNIQUE (starter_group_id, sort_order) DEFERRABLE INITIALLY IMMEDIATE;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    ALTER TABLE listing_starter_options
      DROP CONSTRAINT listing_starter_options_starter_group_id_sort_order_key,
      ADD CONSTRAINT listing_starter_options_starter_group_id_sort_order_key
        UNIQUE (starter_group_id, sort_order);

    ALTER TABLE listing_starter_groups
      DROP CONSTRAINT listing_starter_groups_starter_id_sort_order_key,
      ADD CONSTRAINT listing_starter_groups_starter_id_sort_order_key
        UNIQUE (starter_id, sort_order);
  `);
}
