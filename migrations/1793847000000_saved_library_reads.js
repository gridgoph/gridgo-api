/** Saved-file page ordering without scanning or sorting the owner's originals. */
export async function up(pgm) {
  pgm.noTransaction();
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS files_saved_library_idx
    ON files (owner_id, (data->>'savedAt') COLLATE "en-x-icu" DESC, file_id COLLATE "en-x-icu")
    WHERE purpose IN ('artwork', 'mockup') AND state = 'ready'
      AND data->'savedAt' IS NOT NULL
      AND data->'savedAt' NOT IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb);`);
}
export async function down() { throw new Error('Forward migrations only'); }
