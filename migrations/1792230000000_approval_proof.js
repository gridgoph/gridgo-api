export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE orders ADD CONSTRAINT orders_approval_policy_check CHECK (
      NOT (data ? 'approvalPolicy') OR (
        jsonb_typeof(data->'approvalPolicy') = 'object'
        AND data->'approvalPolicy'->'version' = '1'::jsonb
        AND jsonb_typeof(data->'approvalPolicy'->'required') = 'boolean'
        AND data->'approvalPolicy'->>'method' IN ('drawn', 'one_tap')
      ) IS TRUE
    );
    ALTER TABLE orders ADD CONSTRAINT orders_approval_proofs_check CHECK (
      NOT (data ? 'approvalProofs') OR jsonb_typeof(data->'approvalProofs') = 'array'
    );
    CREATE FUNCTION preserve_order_approval_proofs() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE old_proofs jsonb := COALESCE(OLD.data->'approvalProofs', '[]'::jsonb);
      new_proofs jsonb := COALESCE(NEW.data->'approvalProofs', '[]'::jsonb);
      i integer;
    BEGIN
      IF OLD.data ? 'approvalPolicy' AND NEW.data->'approvalPolicy' IS DISTINCT FROM OLD.data->'approvalPolicy' THEN
        RAISE EXCEPTION 'order approval policy is immutable' USING ERRCODE = '23514';
      END IF;
      IF jsonb_typeof(new_proofs) IS DISTINCT FROM 'array' OR jsonb_array_length(new_proofs) < jsonb_array_length(old_proofs) THEN
        RAISE EXCEPTION 'order approval proofs are append-only' USING ERRCODE = '23514';
      END IF;
      IF jsonb_array_length(old_proofs) > 0 THEN
        FOR i IN 0..jsonb_array_length(old_proofs)-1 LOOP
          IF new_proofs->i IS DISTINCT FROM old_proofs->i THEN
            RAISE EXCEPTION 'order approval proofs are immutable' USING ERRCODE = '23514';
          END IF;
        END LOOP;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER orders_approval_proofs_immutable BEFORE UPDATE ON orders
      FOR EACH ROW EXECUTE FUNCTION preserve_order_approval_proofs();
  `);
}

export async function down() {
  throw new Error('Approval evidence must be preserved; use a forward migration.');
}
