export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE user_role_memberships (
      user_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      role text NOT NULL CHECK (role IN
        ('client','supplier','rider','ops_admin','super_admin')),
      created_at timestamptz NOT NULL,
      created_by text REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      PRIMARY KEY (user_id, role)
    );
    CREATE INDEX user_role_memberships_role_idx
      ON user_role_memberships (role, user_id);

    CREATE TABLE client_profiles (
      user_id text PRIMARY KEY REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      client_kind text NOT NULL CHECK (client_kind IN ('personal','business')),
      business_name text,
      business_nature text,
      updated_at timestamptz NOT NULL,
      CHECK (client_kind <> 'personal' OR
        (business_name IS NULL AND business_nature IS NULL))
    );

    CREATE TABLE supplier_profiles (
      user_id text PRIMARY KEY REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      shop_name text NOT NULL CHECK (btrim(shop_name) <> ''),
      contact_name text NOT NULL CHECK (btrim(contact_name) <> ''),
      shop_lat double precision NOT NULL CHECK (shop_lat BETWEEN -90 AND 90),
      shop_lng double precision NOT NULL CHECK (shop_lng BETWEEN -180 AND 180),
      shop_label text NOT NULL CHECK (btrim(shop_label) <> ''),
      pickup_available boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL
    );

    CREATE TABLE rider_profiles (
      user_id text PRIMARY KEY REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      vehicle_type text NOT NULL CHECK (vehicle_type IN
        ('motorcycle','car','van','truck','bicycle')),
      plate_number text NOT NULL CHECK (btrim(plate_number) <> ''),
      license_number text,
      updated_at timestamptz NOT NULL
    );

    CREATE TABLE approval_cases (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      kind text NOT NULL CHECK (kind IN ('business_client','supplier','rider')),
      status text NOT NULL CHECK (status IN
        ('pending','approved','rejected','suspended')),
      version integer NOT NULL DEFAULT 1 CHECK (version > 0),
      application_revision integer NOT NULL DEFAULT 1 CHECK (application_revision > 0),
      submitted_at timestamptz,
      decided_at timestamptz,
      decided_by text REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      rejection_reason text,
      suspension_reason text,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      UNIQUE (user_id, kind),
      CHECK (status <> 'rejected' OR
        (rejection_reason IS NOT NULL AND btrim(rejection_reason) <> '')),
      CHECK (status <> 'suspended' OR
        (suspension_reason IS NOT NULL AND btrim(suspension_reason) <> '')),
      CHECK (decided_by IS NULL OR decided_at IS NOT NULL)
    );
    CREATE INDEX approval_cases_queue_idx
      ON approval_cases (status, kind, submitted_at, updated_at)
      WHERE submitted_at IS NOT NULL;

    CREATE TABLE approval_case_events (
      id text PRIMARY KEY,
      approval_case_id text NOT NULL REFERENCES approval_cases(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      application_revision integer NOT NULL CHECK (application_revision > 0),
      from_status text,
      to_status text NOT NULL CHECK (to_status IN
        ('pending','approved','rejected','suspended')),
      actor_user_id text REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      actor_kind text NOT NULL CHECK (actor_kind IN ('applicant','approver','system')),
      reason text,
      request_id text NOT NULL UNIQUE,
      snapshot jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL
    );

    CREATE FUNCTION reject_approval_case_event_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'approval case events are append-only'
        USING ERRCODE = '42501';
    END;
    $$;

    CREATE TRIGGER approval_case_events_append_only_trigger
      BEFORE UPDATE OR DELETE ON approval_case_events
      FOR EACH ROW EXECUTE FUNCTION reject_approval_case_event_mutation();

    ALTER TABLE file_references
      DROP CONSTRAINT file_references_reference_type_check,
      ADD CONSTRAINT file_references_reference_type_check
        CHECK (reference_type IN ('order', 'supplier_service', 'user', 'rider_document'));

    CREATE TABLE rider_documents (
      id text PRIMARY KEY,
      rider_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      kind text NOT NULL CHECK (kind IN ('drivers_license','or_cr','selfie')),
      file_id text NOT NULL REFERENCES files(file_id) ON UPDATE CASCADE ON DELETE RESTRICT,
      expires_on date,
      is_current boolean NOT NULL DEFAULT true,
      uploaded_at timestamptz NOT NULL,
      replaced_at timestamptz,
      CHECK (kind <> 'drivers_license' OR expires_on IS NOT NULL)
    );
    CREATE UNIQUE INDEX rider_documents_one_current_kind_idx
      ON rider_documents (rider_id, kind) WHERE is_current;
    CREATE INDEX rider_documents_expiry_idx
      ON rider_documents (expires_on, rider_id)
      WHERE is_current AND kind = 'drivers_license';

    CREATE FUNCTION enforce_approval_case_membership()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      required_role text;
    BEGIN
      required_role := CASE NEW.kind
        WHEN 'business_client' THEN 'client'
        WHEN 'supplier' THEN 'supplier'
        WHEN 'rider' THEN 'rider'
      END;

      IF NOT EXISTS (
        SELECT 1
          FROM user_role_memberships membership
         WHERE membership.user_id = NEW.user_id
           AND membership.role = required_role
      ) THEN
        RAISE EXCEPTION 'approval case % requires % membership for user %',
          NEW.kind, required_role, NEW.user_id
          USING ERRCODE = '23514',
                CONSTRAINT = 'approval_cases_matching_membership_check';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE CONSTRAINT TRIGGER approval_cases_matching_membership_trigger
      AFTER INSERT OR UPDATE ON approval_cases
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION enforce_approval_case_membership();

    INSERT INTO user_role_memberships (user_id, role, created_at, created_by)
    SELECT id, role, created_at, NULL
      FROM users;

    INSERT INTO client_profiles
      (user_id, client_kind, business_name, business_nature, updated_at)
    SELECT
      id,
      CASE account_type WHEN 'individual' THEN 'personal' ELSE 'business' END,
      CASE WHEN account_type = 'individual' THEN NULL ELSE org_name END,
      CASE WHEN account_type = 'individual' THEN NULL
           ELSE NULLIF(btrim(data->>'businessNature'), '') END,
      created_at
      FROM users
     WHERE role = 'client';

    -- The settled contract permits a legacy business without a nature to survive
    -- this one migration. NOT VALID keeps that row while enforcing the exact
    -- business-field rule for every new or subsequently changed profile.
    ALTER TABLE client_profiles
      ADD CONSTRAINT client_profiles_business_fields_check
      CHECK (client_kind <> 'business' OR
        (business_name IS NOT NULL AND btrim(business_name) <> '' AND
         business_nature IS NOT NULL AND btrim(business_nature) <> ''))
      NOT VALID;

    INSERT INTO supplier_profiles
      (user_id, shop_name, contact_name, shop_lat, shop_lng, shop_label,
       pickup_available, updated_at)
    SELECT
      id,
      COALESCE(NULLIF(btrim(data->>'shopName'), ''),
               NULLIF(btrim(data->>'supplierName'), ''), name),
      COALESCE(NULLIF(btrim(data->>'contactName'), ''), name),
      COALESCE(shop_lat, 0),
      COALESCE(shop_lng, 0),
      COALESCE(NULLIF(btrim(shop_label), ''), 'Profile completion required'),
      CASE WHEN data->>'pickupAvailable' IN ('true', 'false')
           THEN (data->>'pickupAvailable')::boolean ELSE false END,
      created_at
      FROM users
     WHERE role = 'supplier';

    INSERT INTO rider_profiles
      (user_id, vehicle_type, plate_number, license_number, updated_at)
    SELECT
      id,
      CASE WHEN data->>'vehicleType' IN ('motorcycle','car','van','truck','bicycle')
           THEN data->>'vehicleType' ELSE 'motorcycle' END,
      COALESCE(NULLIF(btrim(data->>'plateNumber'), ''), 'PROFILE-COMPLETION-REQUIRED'),
      NULLIF(btrim(data->>'licenseNumber'), ''),
      created_at
      FROM users
     WHERE role = 'rider';

    INSERT INTO approval_cases
      (id, user_id, kind, status, version, application_revision,
       submitted_at, decided_at, decided_by, rejection_reason,
       suspension_reason, created_at, updated_at)
    SELECT
      'approval_case_legacy_' || id || '_' ||
        CASE WHEN role = 'client' THEN 'business_client' ELSE role END,
      id,
      CASE WHEN role = 'client' THEN 'business_client' ELSE role END,
      CASE WHEN role = 'client' THEN 'approved'
           WHEN verification_status = 'unverified' THEN 'pending'
           ELSE verification_status END,
      1,
      1,
      CASE
        WHEN role = 'rider' AND verification_status IN ('unverified', 'pending') THEN NULL
        ELSE created_at
      END,
      CASE
        WHEN role = 'client' OR verification_status IN ('approved', 'rejected', 'suspended')
          THEN created_at
        ELSE NULL
      END,
      NULL,
      CASE WHEN verification_status = 'rejected'
        THEN COALESCE(NULLIF(btrim(data->>'rejectionReason'), ''),
                      NULLIF(btrim(data->>'verificationNote'), ''),
                      'Legacy verification rejection')
        ELSE NULL END,
      CASE WHEN verification_status = 'suspended'
        THEN COALESCE(NULLIF(btrim(data->>'suspensionReason'), ''),
                      NULLIF(btrim(data->>'verificationNote'), ''),
                      'Legacy verification suspension')
        ELSE NULL END,
      created_at,
      created_at
      FROM users
     WHERE (role = 'client' AND account_type IN ('business', 'organization'))
        OR role IN ('supplier', 'rider');

    INSERT INTO approval_case_events
      (id, approval_case_id, application_revision, from_status, to_status,
       actor_user_id, actor_kind, reason, request_id, snapshot, created_at)
    SELECT
      'approval_case_event_legacy_' || approval_case.user_id || '_' || approval_case.kind,
      approval_case.id,
      approval_case.application_revision,
      NULL,
      approval_case.status,
      NULL,
      'system',
      COALESCE(approval_case.rejection_reason, approval_case.suspension_reason),
      'approval-backfill:' || approval_case.user_id || ':' || approval_case.kind,
      '{}',
      approval_case.created_at
      FROM approval_cases approval_case;

    REVOKE UPDATE, DELETE ON approval_case_events FROM CURRENT_USER;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP TABLE rider_documents;

    ALTER TABLE file_references
      DROP CONSTRAINT file_references_reference_type_check,
      ADD CONSTRAINT file_references_reference_type_check
        CHECK (reference_type IN ('order', 'supplier_service', 'user'));

    DROP TABLE approval_case_events;
    DROP FUNCTION reject_approval_case_event_mutation();
    DROP TABLE approval_cases;
    DROP FUNCTION enforce_approval_case_membership();
    DROP TABLE rider_profiles;
    DROP TABLE supplier_profiles;
    DROP TABLE client_profiles;
    DROP TABLE user_role_memberships;
  `);
}
