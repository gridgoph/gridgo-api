/** Nullable, additive metadata; older profile upserts preserve this column. */
export async function up(pgm) {
  pgm.sql('ALTER TABLE supplier_profiles ADD COLUMN availability jsonb');
}
export async function down() { throw new Error('Forward-only migration'); }
