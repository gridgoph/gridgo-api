/** Sum only saved/reserved originals, not every unsaved upload by the owner. */
export async function up(pgm) {
  pgm.noTransaction();
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS files_saved_quota_idx
    ON files (owner_id) INCLUDE (size_bytes)
    WHERE purpose IN ('artwork', 'mockup') AND state IN ('pending_upload', 'ready', 'delete_pending')
      AND ((data->'savedAt' IS NOT NULL
        AND data->'savedAt' NOT IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb))
      OR (data->'saveToMyFilesRequestedAt' IS NOT NULL
        AND data->'saveToMyFilesRequestedAt' NOT IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb)));`);
}
export async function down() { throw new Error('Forward migrations only'); }
