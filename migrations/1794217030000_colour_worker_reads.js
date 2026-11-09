/** Selected source/foreign-reference probes for upload-triggered colour work. */
export async function up(pgm) {
  pgm.noTransaction();
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS files_pending_colour_position_idx ON files (position)
    WHERE state='ready' AND coalesce(data->>'deleteRequestedAt','')=''
      AND data @? '$.colourAnalyses[*] ? (@.status == "pending")';`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS cart_lines_artwork_source_idx ON client_cart_lines (artwork_file_id,cart_id)
    WHERE artwork_attachments IS NULL;`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS cart_lines_artwork_attachments_idx ON client_cart_lines
    USING gin (artwork_attachments jsonb_path_ops);`);
}
export async function down() {
  throw new Error('Forward migrations only');
}
