/** Governed document format; does not change any shop's accepted selection. */
export async function up(pgm) {
  pgm.sql(`
    INSERT INTO accepted_file_formats (code, display_name, input_kind, extensions, mime_types)
    VALUES ('docx', 'Word document', 'file', ARRAY['docx'],
      ARRAY['application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
    ON CONFLICT (code) DO NOTHING;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM files WHERE detected_content_type =
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document') THEN
        RAISE EXCEPTION 'DOCX uploads exist; rollback would remove their supported format';
      END IF;
    END $$;
    -- Listing/service foreign keys additionally refuse deletion while in use.
    DELETE FROM accepted_file_formats WHERE code = 'docx';
  `);
}
