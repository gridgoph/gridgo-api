/** Tracking policy is live; bump the existing settings handshake for old installs. */
export async function up(pgm) {
  pgm.sql(`UPDATE platform_settings SET settings =
    '{"riderLocationRefreshIntervalSeconds":20,"riderLocationStaleAfterSeconds":120}'::jsonb || settings,
    version = version + 1
    WHERE NOT settings ? 'riderLocationRefreshIntervalSeconds' OR NOT settings ? 'riderLocationStaleAfterSeconds';`);
}
export async function down() {
  throw new Error('Use a forward migration for rider tracking settings');
}
