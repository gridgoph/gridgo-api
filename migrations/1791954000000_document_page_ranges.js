export async function up(pgm) {
  for (const table of ['client_cart_lines', 'order_line_items']) {
    pgm.addColumn(table, { document_pages: { type: 'jsonb', default: null } });
  }
  pgm.sql(`
    CREATE FUNCTION protect_document_pages() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.snapshot_finalized AND NEW.document_pages IS DISTINCT FROM OLD.document_pages THEN
        RAISE EXCEPTION 'document page selection is immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER document_pages_immutable BEFORE UPDATE ON order_line_items
      FOR EACH ROW EXECUTE FUNCTION protect_document_pages();
  `);
}
export async function down(pgm) {
  pgm.sql('DROP TRIGGER document_pages_immutable ON order_line_items; DROP FUNCTION protect_document_pages();');
  for (const table of ['client_cart_lines', 'order_line_items']) pgm.dropColumn(table, 'document_pages');
}
