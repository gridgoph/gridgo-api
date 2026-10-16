/** Play and TestFlight notices are deduplicated separately from the APK notice for the same version. */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE release_announcements
      ADD COLUMN channel text NOT NULL DEFAULT 'apk' CHECK (channel IN ('apk','play','ios'));
    ALTER TABLE release_announcements
      DROP CONSTRAINT release_announcements_pkey,
      ADD PRIMARY KEY (app, version, channel);
  `);
}
export async function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM release_announcements WHERE channel <> 'apk') THEN
        RAISE EXCEPTION 'Store release announcement deduplication history must be retained';
      END IF;
    END $$;
    ALTER TABLE release_announcements
      DROP CONSTRAINT release_announcements_pkey,
      ADD PRIMARY KEY (app, version);
    ALTER TABLE release_announcements DROP COLUMN channel;
  `);
}
