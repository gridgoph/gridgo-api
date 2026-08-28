export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE rider_profiles
      ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);
  `);
}

export async function down(pgm) {
  pgm.sql(`
    ALTER TABLE rider_profiles DROP COLUMN IF EXISTS version;
  `);
}
