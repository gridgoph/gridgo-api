/** Preserve installed clients while allowing arbitrary Home card colors. */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE home_promotions ADD COLUMN color text;
    UPDATE home_promotions SET color = CASE style WHEN 'yellow' THEN '#FFDE58' ELSE '#FFFFFF' END;
    ALTER TABLE home_promotions ALTER COLUMN color SET NOT NULL;
    ALTER TABLE home_promotions ADD CONSTRAINT home_promotions_color_check
      CHECK (char_length(color) = 7 AND color ~ '^#[0-9A-F]{6}$');
  `);
}
export async function down() { throw new Error('Forward migrations only'); }
