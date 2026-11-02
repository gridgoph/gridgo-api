/** Query statistics for issue 307. The library itself is preloaded by the
 * PostgreSQL server command (deploy/docker-compose.yml); a migration cannot set
 * shared_preload_libraries or restart the server. Without the preload, or
 * without privilege to create the extension, this leaves a notice and the
 * operator steps in DEPLOYMENT.md#postgresql-query-statistics still apply.
 */
export async function up(pgm) {
  pgm.sql(`DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_stat_statements') THEN
    CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA public;
  ELSE
    RAISE NOTICE 'pg_stat_statements is not installed on this server';
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'pg_stat_statements needs a database administrator: see DEPLOYMENT.md';
END $$;`);
}
export async function down() { throw new Error('Forward migrations only'); }
