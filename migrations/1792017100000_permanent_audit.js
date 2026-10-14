export const up = pgm => pgm.sql(`
  -- Historical references must survive removal of their source account/order.
  -- SET NULL/CASCADE would edit evidence, so audit identifiers are snapshots.
  ALTER TABLE audit_log DROP CONSTRAINT audit_log_actor_id_fkey;
  ALTER TABLE audit_log DROP CONSTRAINT audit_log_order_id_fkey;
  UPDATE audit_log SET order_id = entity_id WHERE order_id IS NULL AND entity_type = 'order';
  UPDATE audit_log SET data = jsonb_set(data, '{orderIds}', data->'detail'->'orderIds')
    WHERE entity_type = 'basket' AND jsonb_typeof(data->'detail'->'orderIds') = 'array';
  CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = '23514';
  END $$;
  CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
  ALTER TABLE audit_log ENABLE ALWAYS TRIGGER audit_log_append_only;
  CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
  ALTER TABLE audit_log ENABLE ALWAYS TRIGGER audit_log_no_truncate;
  REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM PUBLIC;
  CREATE INDEX audit_log_actor_time_idx ON audit_log(actor_id, at DESC, id DESC);
  CREATE INDEX audit_log_action_time_idx ON audit_log(action, at DESC, id DESC);
  CREATE INDEX audit_log_orders_idx ON audit_log USING gin ((data->'orderIds'));
  CREATE INDEX audit_log_page_idx ON audit_log(at DESC, id DESC);
  CREATE UNIQUE INDEX audit_staff_session_idx ON audit_log(actor_id, (data->'detail'->>'sessionHash'))
    WHERE action = 'staff.sign_in';
`);
export const down = () => { throw new Error('Permanent audit retention cannot be rolled back'); };
