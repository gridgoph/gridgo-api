/** Retention announcement references stay independent of unrelated inbox growth. */
export async function up(pgm) {
  pgm.noTransaction();
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS notifications_image_reference_idx
    ON notifications USING gin ((data->>'imageUrl') public.gin_trgm_ops)
    WHERE data->>'imageUrl' IS NOT NULL;`);
}
export async function down() { throw new Error('Forward migrations only'); }
