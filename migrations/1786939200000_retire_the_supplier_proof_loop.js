/**
 * Drop the two tables the retired order model left behind.
 *
 * `proofs` held the supplier print-proof loop: a shop sent the client a proof
 * and waited for approve or request-changes before production. That loop was
 * removed by the captain's decision -- the states `supplier_proof_*` and
 * `awaiting_payment` are gone from every transition table and no route reads
 * or writes this table. `job_qa_checklist` is the same story from the same
 * model: a per-job checklist Operations ticked off, replaced by the order
 * pipeline that runs today.
 *
 * Both were still being loaded and saved on every request, so every mutation
 * paid for two collections nothing consumed, and every reader of the schema
 * had to work out for themselves that they were dead.
 *
 * Both are empty. The down migration restores the structure exactly, so a
 * revert is a schema revert -- there is no data to lose and none to bring back.
 */
export async function up(pgm) {
  pgm.sql(`
    DROP TABLE job_qa_checklist;
    DROP TABLE proofs;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    CREATE TABLE proofs (
      id text PRIMARY KEY,
      order_id text NOT NULL REFERENCES orders(id) ON UPDATE CASCADE ON DELETE CASCADE,
      uploader_id text REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at timestamptz NOT NULL,
      position integer NOT NULL CHECK (position >= 0),
      data jsonb NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE TABLE job_qa_checklist (
      id text PRIMARY KEY,
      job_id text NOT NULL REFERENCES order_jobs(id) ON UPDATE CASCADE ON DELETE CASCADE,
      code text NOT NULL CHECK (btrim(code) <> ''),
      label text NOT NULL CHECK (btrim(label) <> ''),
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'passed', 'failed')),
      note text,
      sort_order integer NOT NULL CHECK (sort_order >= 0),
      checked_at timestamptz,
      checked_by text REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      UNIQUE (job_id, code),
      UNIQUE (job_id, sort_order)
    );
  `);
}
