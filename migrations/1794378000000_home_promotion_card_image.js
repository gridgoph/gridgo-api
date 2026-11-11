/** Additive and nullable so previous API writers remain valid during deployment. */
export async function up(pgm) {
  pgm.sql(`ALTER TABLE home_promotions ADD COLUMN card_image_file_id text REFERENCES files(file_id)`);
}
export async function down() { throw new Error('Forward migrations only'); }
