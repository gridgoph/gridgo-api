export async function up(pgm) {
  pgm.sql(`DO $$ DECLARE prior text; BEGIN
    SELECT pg_get_expr(conbin,conrelid) INTO prior FROM pg_constraint
      WHERE conrelid='file_references'::regclass AND conname='file_references_reference_type_check';
    ALTER TABLE file_references DROP CONSTRAINT file_references_reference_type_check;
    EXECUTE 'ALTER TABLE file_references ADD CONSTRAINT file_references_reference_type_check CHECK ((' || prior || ') OR reference_type = ''shop_team_member'')';
  END $$;`);
}
export async function down() { throw new Error('Forward-only migration'); }
