/** Supplier invoices are incoming shop documents, separate from customer receipts. */
export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE supplier_invoices (
      order_id text PRIMARY KEY REFERENCES orders(id),
      supplier_id text NOT NULL REFERENCES users(id),
      expected_at timestamptz NOT NULL,
      month text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
      file_id text UNIQUE REFERENCES files(file_id),
      number text CHECK (length(btrim(number)) BETWEEN 1 AND 100 AND number !~ '[[:cntrl:]]'),
      invoice_date date,
      amount_minor money_minor CHECK (amount_minor >= 0),
      submitted_at timestamptz,
      updated_at timestamptz,
      version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
      collected_at timestamptz,
      collected_by text REFERENCES users(id),
      CHECK (month = to_char(expected_at AT TIME ZONE 'Asia/Manila', 'YYYY-MM')),
      CHECK ((file_id IS NULL AND number IS NULL AND invoice_date IS NULL AND amount_minor IS NULL
        AND submitted_at IS NULL AND updated_at IS NULL AND version = 0)
        OR (file_id IS NOT NULL AND number IS NOT NULL AND invoice_date IS NOT NULL AND amount_minor IS NOT NULL
        AND submitted_at IS NOT NULL AND updated_at IS NOT NULL AND version > 0)),
      CHECK ((collected_at IS NULL AND collected_by IS NULL) OR
        (collected_at IS NOT NULL AND collected_by IS NOT NULL AND submitted_at IS NOT NULL AND collected_at >= submitted_at))
    );
    CREATE INDEX supplier_invoices_month_shop_idx ON supplier_invoices(month, supplier_id, order_id);

    -- No inference from current status or creation date: only recorded readiness.
    -- Recovery retains the prior supplier in its failure history. Prefer that
    -- snapshot when readiness predates recovery, otherwise the readiness actor
    -- if it is a supplier, then the order's assigned supplier.
    INSERT INTO supplier_invoices(order_id,supplier_id,expected_at,month)
    SELECT o.id, COALESCE(failure.supplier_id, actor.id, o.supplier_id), ready.at,
      to_char(ready.at AT TIME ZONE 'Asia/Manila','YYYY-MM')
    FROM orders o
    CROSS JOIN LATERAL (
      SELECT (e->>'at')::timestamptz AS at, e->>'by' AS actor_id
      FROM jsonb_array_elements(COALESCE(o.data->'timeline','[]'::jsonb)) e
      WHERE e->>'state' = 'ready_for_dispatch' AND e->>'at' IS NOT NULL
      ORDER BY (e->>'at')::timestamptz LIMIT 1
    ) ready
    LEFT JOIN LATERAL (
      SELECT e->>'supplierId' AS supplier_id
      FROM jsonb_array_elements(COALESCE(o.data->'shopFailureEvents','[]'::jsonb)) e
      WHERE (e->>'at')::timestamptz >= ready.at AND EXISTS (SELECT 1 FROM users WHERE id=e->>'supplierId')
      ORDER BY (e->>'at')::timestamptz LIMIT 1
    ) failure ON true
    LEFT JOIN users actor ON actor.id=ready.actor_id AND EXISTS
      (SELECT 1 FROM user_role_memberships m WHERE m.user_id=actor.id AND m.role='supplier')
    WHERE COALESCE(failure.supplier_id,actor.id,o.supplier_id) IS NOT NULL;

    INSERT INTO audit_log(id,at,actor_id,actor_role,action,entity_type,entity_id,order_id,position,data)
    SELECT 'supplier_invoice_backfill_' || order_id, date_trunc('milliseconds',now()), NULL,'system',
      'supplier_invoice.expected','supplier_invoice',order_id,order_id,
      (SELECT COALESCE(max(position),0) FROM audit_log) + row_number() OVER (ORDER BY order_id),
      jsonb_build_object('detail',jsonb_build_object('source','readiness_timeline_backfill',
        'supplierId',supplier_id,'expectedAt',expected_at,'month',month))
    FROM supplier_invoices;

    CREATE FUNCTION guard_supplier_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN
        RAISE EXCEPTION 'supplier invoice history is immutable' USING ERRCODE='23514';
      END IF;
      IF TG_OP='UPDATE' THEN
        IF ROW(OLD.order_id,OLD.supplier_id,OLD.expected_at,OLD.month)
          IS DISTINCT FROM ROW(NEW.order_id,NEW.supplier_id,NEW.expected_at,NEW.month)
          OR (OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at)
          OR (OLD.collected_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
          RAISE EXCEPTION 'supplier invoice facts and collection are immutable' USING ERRCODE='23514';
        END IF;
        IF NEW IS DISTINCT FROM OLD AND NEW.version <> OLD.version+1 THEN
          RAISE EXCEPTION 'supplier invoice version must advance once' USING ERRCODE='23514';
        END IF;
      END IF;
      IF NEW.file_id IS NOT NULL AND (TG_OP='INSERT' OR NEW.file_id IS DISTINCT FROM OLD.file_id) THEN
        IF NOT EXISTS (SELECT 1 FROM files f JOIN file_references r ON r.file_id=f.file_id
          WHERE f.file_id=NEW.file_id AND f.owner_id=NEW.supplier_id AND f.purpose='supplier_invoice'
          AND f.state='ready' AND r.reference_type='order' AND r.reference_id=NEW.order_id) THEN
          RAISE EXCEPTION 'supplier invoice scan must belong to its shop and order' USING ERRCODE='23514';
        END IF;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER supplier_invoices_guard BEFORE INSERT OR UPDATE OR DELETE ON supplier_invoices
      FOR EACH ROW EXECUTE FUNCTION guard_supplier_invoice();
  `);
}
export async function down() { throw new Error('Supplier invoice history is forward-only'); }
