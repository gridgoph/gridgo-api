export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE client_saved_addresses
      ADD COLUMN deleted_at timestamptz,
      ADD CONSTRAINT client_saved_addresses_deleted_default_check
        CHECK (deleted_at IS NULL OR NOT is_default);
  `);
}

export async function down(pgm) {
  pgm.sql(`
    ALTER TABLE client_saved_addresses
      DROP CONSTRAINT client_saved_addresses_deleted_default_check,
      DROP COLUMN deleted_at;
  `);
}
