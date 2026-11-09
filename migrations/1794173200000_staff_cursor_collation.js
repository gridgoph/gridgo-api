/** JS localeCompare has no binary tie-break for opaque cursor input. */
export async function up(pgm) {
  pgm.sql(`CREATE COLLATION IF NOT EXISTS gridgo_staff_cursor
    (provider=icu, locale='en', deterministic=false);`);
}
export async function down() { throw new Error('Forward migrations only'); }
