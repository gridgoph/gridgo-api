/** Invalidate the compatibility-normalization cache at every source write.
 * Initial dirtiness schedules legacy correction through the audited full writer.
 */
export async function up(pgm) {
  pgm.sql(`
    SELECT pg_advisory_xact_lock(hashtext('gridgo-domain-mutation'));
    CREATE TABLE store_production_normalization (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      dirty boolean NOT NULL
    );
    INSERT INTO store_production_normalization VALUES(true,true);
    CREATE FUNCTION mark_production_normalization_pending() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE store_production_normalization SET dirty=true WHERE singleton AND NOT dirty;
      RETURN NULL;
    END; $$;
    ${['supplier_profiles','supplier_services','supplier_catalog_items','supplier_catalog_speed_tiers',
      'listing_starters','order_line_items','order_jobs'].map(table => `
      CREATE TRIGGER ${table}_production_normalization
        AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${table}
        FOR EACH STATEMENT EXECUTE FUNCTION mark_production_normalization_pending();`).join('\n')}
  `);
}
export async function down() { throw new Error('Forward migrations only'); }
