/** A retry must stay a no-op even after every recipient deletes their inbox row. */
export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE release_announcements (
      app text NOT NULL CHECK (app IN ('client','supplier','rider')),
      version text NOT NULL,
      announcement jsonb NOT NULL CHECK (jsonb_typeof(announcement) = 'object'),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (app, version)
    );
  `);
}
export async function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM release_announcements) THEN
        RAISE EXCEPTION 'Release announcement deduplication history must be retained';
      END IF;
    END $$;
    DROP TABLE release_announcements;
  `);
}
