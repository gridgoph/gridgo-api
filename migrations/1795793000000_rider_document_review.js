export const up = pgm => pgm.sql(`
  ALTER TABLE rider_documents DROP CONSTRAINT rider_documents_kind_check;
  ALTER TABLE rider_documents ADD CONSTRAINT rider_documents_kind_check
    CHECK (kind IN ('drivers_license','drivers_license_back','or_cr','selfie','motorcycle_photo','resume'));
  ALTER TABLE rider_documents ADD COLUMN description text,
    ADD COLUMN reupload_reason text,
    ADD CONSTRAINT rider_documents_description_check CHECK (description IS NULL OR (kind = 'motorcycle_photo' AND length(btrim(description)) BETWEEN 1 AND 500)),
    ADD CONSTRAINT rider_documents_reupload_reason_check CHECK (reupload_reason IS NULL OR length(btrim(reupload_reason)) BETWEEN 1 AND 1000);
  ALTER TABLE approval_cases ADD COLUMN rider_review jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD CONSTRAINT approval_cases_rider_review_check CHECK (jsonb_typeof(rider_review) = 'object' AND (kind = 'rider' OR rider_review = '{}'::jsonb));
  UPDATE approval_cases SET rider_review = '{"legacyApproved":true}'::jsonb
    WHERE kind = 'rider' AND status = 'approved';
`);
export const down = () => { throw new Error('Forward-only rider document review migration'); };
