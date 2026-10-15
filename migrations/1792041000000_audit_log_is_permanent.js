/**
 * The audit log is append-only.
 *
 * A trigger refuses UPDATE and DELETE for every role, including the table
 * owner the API uses. Foreign keys are dropped so deleting a user or an
 * order cannot rewrite or cascade-truncate the history. Rows stay at least
 * as long as the orders and invoices they describe. Nothing here deletes
 * them: the accountant has not named a retention period.
 */

export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_actor_id_fkey;
    ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_order_id_fkey;

    CREATE OR REPLACE FUNCTION gridgo_audit_log_immutable()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'audit_log is append-only'
        USING ERRCODE = '55000';
    END;
    $$;

    DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
    CREATE TRIGGER audit_log_no_update
      BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW
      EXECUTE FUNCTION gridgo_audit_log_immutable();

    REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;
    REVOKE UPDATE, DELETE ON audit_log FROM CURRENT_USER;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
    DROP FUNCTION IF EXISTS gridgo_audit_log_immutable();
    GRANT UPDATE, DELETE ON audit_log TO CURRENT_USER;
    ALTER TABLE audit_log
      ADD CONSTRAINT audit_log_actor_id_fkey
      FOREIGN KEY (actor_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL;
    ALTER TABLE audit_log
      ADD CONSTRAINT audit_log_order_id_fkey
      FOREIGN KEY (order_id) REFERENCES orders(id) ON UPDATE CASCADE ON DELETE SET NULL;
  `);
}
