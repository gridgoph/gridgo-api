/** Exact transactional desk totals, partitioned by immutable request owner. */
export async function up(pgm) {
  pgm.sql(`
    SELECT pg_advisory_xact_lock(hashtext('gridgo-domain-mutation'));
    LOCK TABLE orders, order_removals IN SHARE ROW EXCLUSIVE MODE;
    CREATE TABLE reschedule_request_counts (
      supplier_key jsonb NOT NULL,
      review_data boolean NOT NULL,
      request_count bigint NOT NULL CHECK (request_count >= 0),
      PRIMARY KEY (supplier_key,review_data)
    );
    CREATE FUNCTION adjust_reschedule_request_count(request jsonb, review boolean, delta bigint)
    RETURNS void LANGUAGE plpgsql AS $$
    DECLARE owner_key jsonb;
    BEGIN
      IF request IS NULL OR request IN ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb) THEN RETURN; END IF;
      -- Match ->> equality, including legacy non-string supplier identifiers.
      owner_key := coalesce(to_jsonb(request->>'supplierId'),'null'::jsonb);
      INSERT INTO reschedule_request_counts VALUES (owner_key,review,greatest(delta,0))
        ON CONFLICT (supplier_key,review_data) DO UPDATE
          SET request_count=reschedule_request_counts.request_count+delta;
      INSERT INTO reschedule_request_counts VALUES ('{"all":true}',review,greatest(delta,0))
        ON CONFLICT (supplier_key,review_data) DO UPDATE
          SET request_count=reschedule_request_counts.request_count+delta;
    END; $$;
    CREATE FUNCTION refresh_reschedule_request_counts() RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      DELETE FROM reschedule_request_counts;
      INSERT INTO reschedule_request_counts
        SELECT coalesce(to_jsonb(data#>>'{rescheduleRequest,supplierId}'),'null'::jsonb),review_data,count(*)
        FROM orders WHERE data->'rescheduleRequest' IS NOT NULL
          AND data->'rescheduleRequest' NOT IN ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb)
          AND NOT EXISTS(SELECT 1 FROM order_removals r WHERE r.order_id=orders.id)
        GROUP BY 1,2;
      INSERT INTO reschedule_request_counts
        SELECT '{"all":true}'::jsonb,review_data,sum(request_count)
        FROM reschedule_request_counts GROUP BY review_data;
    END; $$;
    SELECT refresh_reschedule_request_counts();
    CREATE FUNCTION track_reschedule_request_count() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE parent orders%ROWTYPE;
    BEGIN
      IF TG_OP='TRUNCATE' THEN
        PERFORM refresh_reschedule_request_counts(); RETURN NULL;
      END IF;
      IF TG_TABLE_NAME='orders' THEN
        IF TG_OP='UPDATE' AND OLD.id=NEW.id AND OLD.review_data=NEW.review_data
          AND OLD.data->'rescheduleRequest' IS NOT DISTINCT FROM NEW.data->'rescheduleRequest' THEN
          RETURN NEW;
        END IF;
        IF TG_OP <> 'INSERT' AND NOT EXISTS(SELECT 1 FROM order_removals WHERE order_id=OLD.id) THEN
          PERFORM adjust_reschedule_request_count(OLD.data->'rescheduleRequest',OLD.review_data,-1);
        END IF;
        IF TG_OP <> 'DELETE' AND NOT EXISTS(SELECT 1 FROM order_removals WHERE order_id=NEW.id) THEN
          PERFORM adjust_reschedule_request_count(NEW.data->'rescheduleRequest',NEW.review_data,1);
        END IF;
      ELSE
        IF TG_OP <> 'INSERT' THEN
          SELECT * INTO parent FROM orders WHERE id=OLD.order_id;
          IF FOUND THEN PERFORM adjust_reschedule_request_count(parent.data->'rescheduleRequest',parent.review_data,1); END IF;
        END IF;
        IF TG_OP <> 'DELETE' THEN
          SELECT * INTO parent FROM orders WHERE id=NEW.order_id;
          IF FOUND THEN PERFORM adjust_reschedule_request_count(parent.data->'rescheduleRequest',parent.review_data,-1); END IF;
        END IF;
      END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END; $$;
    -- Run before a cascade removes the logical removal marker.
    CREATE TRIGGER reschedule_count_order_delete BEFORE DELETE ON orders
      FOR EACH ROW EXECUTE FUNCTION track_reschedule_request_count();
    CREATE TRIGGER reschedule_count_removal_change AFTER INSERT OR UPDATE OR DELETE ON order_removals
      FOR EACH ROW EXECUTE FUNCTION track_reschedule_request_count();
    CREATE TRIGGER reschedule_count_orders_truncate AFTER TRUNCATE ON orders
      FOR EACH STATEMENT EXECUTE FUNCTION track_reschedule_request_count();
    CREATE TRIGGER reschedule_count_removals_truncate AFTER TRUNCATE ON order_removals
      FOR EACH STATEMENT EXECUTE FUNCTION track_reschedule_request_count();
  `);
  // Transition tables aggregate a bulk statement once. A large import must
  // not repeatedly update the same global counter for every inserted row.
  for (const operation of ['insert', 'update']) {
    const newRows =
      operation === 'update'
        ? `SELECT n.* FROM changed_rows n WHERE NOT EXISTS (
      SELECT 1 FROM previous_rows p WHERE p.id=n.id AND p.review_data=n.review_data
        AND p.data->'rescheduleRequest' IS NOT DISTINCT FROM n.data->'rescheduleRequest')`
        : 'SELECT * FROM changed_rows';
    const source = `SELECT n.data->'rescheduleRequest' AS request,n.review_data,1::bigint AS delta FROM (${newRows}) n
      WHERE NOT EXISTS(SELECT 1 FROM order_removals r WHERE r.order_id=n.id)${
        operation === 'update'
          ? `
      UNION ALL SELECT p.data->'rescheduleRequest',p.review_data,-1::bigint FROM previous_rows p
      WHERE NOT EXISTS(SELECT 1 FROM changed_rows n WHERE p.id=n.id AND p.review_data=n.review_data
        AND p.data->'rescheduleRequest' IS NOT DISTINCT FROM n.data->'rescheduleRequest')
        AND NOT EXISTS(SELECT 1 FROM order_removals r WHERE r.order_id=p.id)`
          : ''
      }`;
    pgm.sql(`
      CREATE FUNCTION reschedule_counts_after_${operation}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        WITH source AS (${source}), valid AS (
          SELECT * FROM source WHERE request IS NOT NULL
            AND request NOT IN ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb)
        ), deltas AS (
          SELECT coalesce(to_jsonb(request->>'supplierId'),'null'::jsonb) AS supplier_key,review_data,sum(delta) AS delta
            FROM valid GROUP BY 1,2
          UNION ALL SELECT '{"all":true}'::jsonb,review_data,sum(delta) FROM valid GROUP BY review_data
        ), changes AS (SELECT * FROM deltas WHERE delta<>0)
        INSERT INTO reschedule_request_counts(supplier_key,review_data,request_count)
          SELECT supplier_key,review_data,greatest(delta,0) FROM changes
          ON CONFLICT(supplier_key,review_data) DO UPDATE SET request_count=reschedule_request_counts.request_count + (
            SELECT delta FROM changes WHERE changes.supplier_key=EXCLUDED.supplier_key AND changes.review_data=EXCLUDED.review_data);
        RETURN NULL;
      END; $$;
      CREATE TRIGGER reschedule_count_order_${operation} AFTER ${operation.toUpperCase()} ON orders
        REFERENCING ${operation === 'update' ? 'OLD TABLE AS previous_rows ' : ''}NEW TABLE AS changed_rows
        FOR EACH STATEMENT EXECUTE FUNCTION reschedule_counts_after_${operation}();
    `);
  }
}
export async function down() {
  throw new Error('Forward migrations only');
}
