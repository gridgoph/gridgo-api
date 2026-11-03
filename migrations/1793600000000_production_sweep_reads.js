/** Indexed inputs for the production lifecycle probes (issue 307). */
export async function up(pgm) {
  // Each build must be its own autocommit command, including with the runner's
  // default singleTransaction option. See DEPLOYMENT.md for interrupted builds.
  pgm.noTransaction();
  // Sent production reminders for the watched jobs, without scanning the inbox history.
  pgm.sql('CREATE INDEX CONCURRENTLY IF NOT EXISTS notifications_order_type_idx ON notifications (order_id, type) WHERE order_id IS NOT NULL;');
  // Proof files attached to a watched job, whatever the reference type.
  pgm.sql('CREATE INDEX CONCURRENTLY IF NOT EXISTS file_references_reference_id_idx ON file_references (reference_id);');
}
export async function down() { throw new Error('Forward migrations only'); }
