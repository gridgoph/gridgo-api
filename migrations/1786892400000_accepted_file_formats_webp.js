export async function up(pgm) {
  pgm.sql(`
    INSERT INTO accepted_file_formats
      (code, display_name, input_kind, extensions, mime_types)
    VALUES
      ('webp', 'WebP', 'file', ARRAY['webp'], ARRAY['image/webp'])
    ON CONFLICT (code) DO NOTHING;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DELETE FROM accepted_file_formats WHERE code = 'webp';
  `);
}
