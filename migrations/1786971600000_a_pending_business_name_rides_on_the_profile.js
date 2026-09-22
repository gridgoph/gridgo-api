/**
 * A business application no longer flips the client on the spot: the profile
 * stays `personal` and holds the requested name and nature until Operations
 * approves the case. The original table forbade business fields on a personal
 * profile, so every pending application was refused by PostgreSQL.
 *
 * `client_profiles_business_fields_check` stays: a business profile still needs
 * both fields.
 */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE client_profiles
      DROP CONSTRAINT IF EXISTS client_profiles_check;
  `);
}

export async function down(pgm) {
  // NOT VALID keeps any application still under review while restoring the
  // older rule for every new or subsequently changed profile.
  pgm.sql(`
    ALTER TABLE client_profiles
      ADD CONSTRAINT client_profiles_check
      CHECK (client_kind <> 'personal' OR
        (business_name IS NULL AND business_nature IS NULL))
      NOT VALID;
  `);
}
