/** Fault-time policy facts survive late recording and verification changes. */
export async function up(pgm) {
  pgm.sql(`
    DO $$ DECLARE name text; BEGIN
      SELECT conname INTO STRICT name FROM pg_constraint
        WHERE conrelid='supplier_verification_ledger'::regclass AND contype='c'
          AND pg_get_constraintdef(oid) LIKE '%held%';
      EXECUTE format('ALTER TABLE supplier_verification_ledger DROP CONSTRAINT %I',name);
    END $$;
    ALTER TABLE supplier_verification_ledger ADD CONSTRAINT supplier_verification_ledger_kind_check
      CHECK(kind IN ('held','available','reserved','released','recovery_due','recovered','reminder','reservation_cancelled','recovery_assessment'));
    CREATE UNIQUE INDEX supplier_verification_assessment_once_idx ON supplier_verification_ledger(payout_key)
      WHERE kind='recovery_assessment';
  `);
}
export async function down() {throw new Error('Forward-only migration');}
