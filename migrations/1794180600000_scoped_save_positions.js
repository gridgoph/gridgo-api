/** Exact append ordinals and conservative layout health for scoped writers. */
export async function up(pgm) {
  const tables = ['audit_log', 'notifications', 'orders', 'files'];
  pgm.sql(`
    SELECT pg_advisory_xact_lock(hashtext('gridgo-domain-mutation'));
    LOCK TABLE audit_log, notifications, orders, files, order_removals IN SHARE ROW EXCLUSIVE MODE;
    CREATE TABLE store_collection_counts (
      name text PRIMARY KEY CHECK (name IN ('audit_log','notifications','orders','files')),
      row_count bigint NOT NULL CHECK (row_count >= 0),
      positions_contiguous boolean NOT NULL
    );
    ${tables.map(table => `INSERT INTO store_collection_counts(name,row_count,positions_contiguous)
      SELECT '${table}',count(*),count(*)=count(DISTINCT position)
        AND coalesce(min(position),0)=0 AND coalesce(max(position),-1)=count(*)-1
        ${table === 'orders' ? 'AND NOT EXISTS(SELECT 1 FROM order_removals)' : ''} FROM ${table}
        ${table === 'notifications' ? 'WHERE NOT EXISTS(SELECT 1 FROM order_removals r WHERE r.order_id=notifications.order_id)' : ''};`).join('\n')}
    CREATE FUNCTION update_store_collection_count() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE delta bigint; first_position integer; last_position integer; distinct_positions bigint;
    BEGIN
      IF TG_OP='TRUNCATE' THEN
        UPDATE store_collection_counts SET row_count=0,positions_contiguous=true WHERE name=TG_TABLE_NAME;
      ELSIF TG_OP='UPDATE' THEN
        IF TG_TABLE_NAME='notifications' THEN
          SELECT (SELECT count(*) FROM updated_rows r WHERE NOT EXISTS(SELECT 1 FROM order_removals removed WHERE removed.order_id=to_jsonb(r)->>'order_id'))
            - (SELECT count(*) FROM previous_rows r WHERE NOT EXISTS(SELECT 1 FROM order_removals removed WHERE removed.order_id=to_jsonb(r)->>'order_id')) INTO delta;
          IF delta<>0 THEN UPDATE store_collection_counts SET row_count=row_count+delta,positions_contiguous=false WHERE name=TG_TABLE_NAME; END IF;
        END IF;
        IF EXISTS (
          (SELECT to_jsonb(r)->>'id',to_jsonb(r)->>'file_id',to_jsonb(r)->>'position' FROM updated_rows r)
          EXCEPT (SELECT to_jsonb(r)->>'id',to_jsonb(r)->>'file_id',to_jsonb(r)->>'position' FROM previous_rows r)
        ) THEN UPDATE store_collection_counts SET positions_contiguous=false WHERE name=TG_TABLE_NAME; END IF;
      ELSIF TG_OP='INSERT' THEN
        SELECT count(*),min((to_jsonb(r)->>'position')::integer),max((to_jsonb(r)->>'position')::integer),
          count(DISTINCT (to_jsonb(r)->>'position')::integer)
          INTO delta,first_position,last_position,distinct_positions FROM added_rows r
          WHERE TG_TABLE_NAME<>'notifications' OR NOT EXISTS(SELECT 1 FROM order_removals removed WHERE removed.order_id=to_jsonb(r)->>'order_id');
        IF delta=0 THEN RETURN NULL; END IF;
        UPDATE store_collection_counts SET
          positions_contiguous=positions_contiguous AND first_position=row_count
            AND last_position=row_count+delta-1 AND distinct_positions=delta,
          row_count=row_count+delta WHERE name=TG_TABLE_NAME;
      ELSE
        SELECT count(*) INTO delta FROM removed_rows r WHERE TG_TABLE_NAME<>'notifications'
          OR NOT EXISTS(SELECT 1 FROM order_removals removed WHERE removed.order_id=to_jsonb(r)->>'order_id');
        IF delta=0 THEN RETURN NULL; END IF;
        UPDATE store_collection_counts SET row_count=row_count-delta,positions_contiguous=false WHERE name=TG_TABLE_NAME;
      END IF;
      RETURN NULL;
    END; $$;
    ${tables.map(table => `
      CREATE TRIGGER ${table}_collection_insert AFTER INSERT ON ${table} REFERENCING NEW TABLE AS added_rows
        FOR EACH STATEMENT EXECUTE FUNCTION update_store_collection_count();
      CREATE TRIGGER ${table}_collection_delete AFTER DELETE ON ${table} REFERENCING OLD TABLE AS removed_rows
        FOR EACH STATEMENT EXECUTE FUNCTION update_store_collection_count();
      CREATE TRIGGER ${table}_collection_update AFTER UPDATE ON ${table} REFERENCING OLD TABLE AS previous_rows NEW TABLE AS updated_rows
        FOR EACH STATEMENT EXECUTE FUNCTION update_store_collection_count();
      CREATE TRIGGER ${table}_collection_truncate AFTER TRUNCATE ON ${table}
        FOR EACH STATEMENT EXECUTE FUNCTION update_store_collection_count();`).join('\n')}
    CREATE FUNCTION mark_removed_order_positions() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE delta bigint;
    BEGIN
      IF TG_OP='TRUNCATE' THEN
        UPDATE store_collection_counts SET (row_count,positions_contiguous)=(
          SELECT count(*),count(*)=count(DISTINCT position) AND coalesce(min(position),0)=0
            AND coalesce(max(position),-1)=count(*)-1 FROM notifications) WHERE name='notifications';
        UPDATE store_collection_counts SET (row_count,positions_contiguous)=(
          SELECT count(*),count(*)=count(DISTINCT position) AND coalesce(min(position),0)=0
            AND coalesce(max(position),-1)=count(*)-1 FROM orders) WHERE name='orders';
        RETURN NULL;
      ELSIF TG_OP='INSERT' THEN
        SELECT -count(*) INTO delta FROM notifications n JOIN added_removals r ON r.order_id=n.order_id;
      ELSE
        SELECT count(*) INTO delta FROM notifications n JOIN removed_removals r ON r.order_id=n.order_id;
      END IF;
      UPDATE store_collection_counts SET positions_contiguous=false WHERE name='orders';
      UPDATE store_collection_counts SET row_count=row_count+delta,positions_contiguous=false WHERE name='notifications';
      RETURN NULL;
    END; $$;
    CREATE TRIGGER removed_order_positions_insert AFTER INSERT ON order_removals REFERENCING NEW TABLE AS added_removals
      FOR EACH STATEMENT EXECUTE FUNCTION mark_removed_order_positions();
    CREATE TRIGGER removed_order_positions_delete AFTER DELETE ON order_removals REFERENCING OLD TABLE AS removed_removals
      FOR EACH STATEMENT EXECUTE FUNCTION mark_removed_order_positions();
    CREATE TRIGGER removed_order_positions_truncate AFTER TRUNCATE ON order_removals
      FOR EACH STATEMENT EXECUTE FUNCTION mark_removed_order_positions();
  `);
}
export async function down() { throw new Error('Forward migrations only'); }
