/**
 * A shop says where it wants to be paid.
 *
 * Payout release is a person in Operations opening a wallet app and scanning
 * the shop's own receiving QR - the same laminated GCash or Maya plate that
 * sits on the counter of every print shop in Davao. Until now nothing in
 * GRIDGO recorded that plate, so the release desk had to ask over chat every
 * time money moved.
 *
 * One row per supplier. `provider` names the wallet or rail; `account_name`
 * is what the wallet app shows back so the person releasing can check they
 * scanned the right shop; `account_number` is the mobile number or bank
 * account, optional because a QR carries it already; `institution` names the
 * bank or the wallet when the provider is `bank` or `other`.
 *
 * The plate itself is an ordinary stored file with purpose
 * `supplier_payout_qr`, bound here by `qr_file_id` and referenced from
 * `file_references` as `supplier_payout_account` so it cannot be deleted
 * out from under the account. Replacing the plate retires the previous file
 * the same way the platform's own receiving QR does.
 *
 * `version` is the optimistic lock the shop's own screens round-trip.
 */
export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE supplier_payout_accounts (
      supplier_id text PRIMARY KEY REFERENCES supplier_profiles(user_id) ON DELETE CASCADE,
      provider text NOT NULL CHECK (provider IN ('gcash', 'maya', 'bank', 'other')),
      account_name text NOT NULL CHECK (btrim(account_name) <> ''),
      account_number text,
      institution text,
      qr_file_id text REFERENCES files(file_id) ON DELETE SET NULL,
      version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
      updated_at timestamptz NOT NULL
    );

    ALTER TABLE file_references
      DROP CONSTRAINT file_references_reference_type_check;
    ALTER TABLE file_references
      ADD CONSTRAINT file_references_reference_type_check
        CHECK (reference_type IN (
          'order', 'supplier_service', 'user', 'rider_document',
          'supplier_catalog_item', 'supplier_shop_media', 'supplier_payout_account'
        ));
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DELETE FROM file_references WHERE reference_type = 'supplier_payout_account';
    ALTER TABLE file_references
      DROP CONSTRAINT file_references_reference_type_check;
    ALTER TABLE file_references
      ADD CONSTRAINT file_references_reference_type_check
        CHECK (reference_type IN (
          'order', 'supplier_service', 'user', 'rider_document',
          'supplier_catalog_item', 'supplier_shop_media'
        ));
    DROP TABLE IF EXISTS supplier_payout_accounts;
  `);
}
