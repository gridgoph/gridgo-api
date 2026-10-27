/** Test-owner DDL only. Runtime SQL cannot purge the permanent audit ledger. */
export async function resetDatabase(database, sql) {
  if (!process.env.DATABASE_URL || !new URL(process.env.DATABASE_URL).pathname.includes('test')) throw new Error('Test database required');
  // Promotion configuration is independent of users and operational settings.
  if (/\bplatform_settings\b/.test(sql) && !/\bpromotion_settings\b/.test(sql)) sql = sql.replace(/TRUNCATE\s+/i, 'TRUNCATE promotion_settings, ');
  if (/\busers\b/.test(sql) && !/\baudit_log\b/.test(sql)) sql = sql.replace(/TRUNCATE\s+/i, 'TRUNCATE audit_log, ');
  await database.transaction(async () => {
    await database.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_truncate');
    await database.query('ALTER TABLE acknowledgement_receipts DISABLE TRIGGER acknowledgement_receipts_no_truncate');
    await database.query(sql);
    await database.query('ALTER TABLE acknowledgement_receipts ENABLE ALWAYS TRIGGER acknowledgement_receipts_no_truncate');
    await database.query('ALTER TABLE audit_log ENABLE ALWAYS TRIGGER audit_log_no_truncate');
  });
}
