DO $cybanext_sms_consent_roles$
DECLARE
  role_record RECORD;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'cybanext_sms_consent_retention_owner'
  ) THEN
    EXECUTE 'CREATE ROLE cybanext_sms_consent_retention_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'cybanext_sms_consent_retention_operator'
  ) THEN
    EXECUTE 'CREATE ROLE cybanext_sms_consent_retention_operator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'cybanext_sms_consent_application'
  ) THEN
    EXECUTE 'CREATE ROLE cybanext_sms_consent_application NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;

  SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
         rolreplication, rolbypassrls
  INTO role_record
  FROM pg_catalog.pg_roles
  WHERE rolname = 'cybanext_sms_consent_retention_owner';
  IF role_record.rolcanlogin OR role_record.rolsuper OR role_record.rolcreatedb
     OR role_record.rolcreaterole OR role_record.rolinherit
     OR role_record.rolreplication OR role_record.rolbypassrls THEN
    RAISE EXCEPTION 'SMS consent retention owner role has unsafe attributes';
  END IF;

  SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
         rolreplication, rolbypassrls
  INTO role_record
  FROM pg_catalog.pg_roles
  WHERE rolname = 'cybanext_sms_consent_retention_operator';
  IF role_record.rolcanlogin OR role_record.rolsuper OR role_record.rolcreatedb
     OR role_record.rolcreaterole OR role_record.rolinherit
     OR role_record.rolreplication OR role_record.rolbypassrls THEN
    RAISE EXCEPTION 'SMS consent retention operator role has unsafe attributes';
  END IF;

  SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
         rolreplication, rolbypassrls
  INTO role_record
  FROM pg_catalog.pg_roles
  WHERE rolname = 'cybanext_sms_consent_application';
  IF role_record.rolcanlogin OR role_record.rolsuper OR role_record.rolcreatedb
     OR role_record.rolcreaterole OR role_record.rolinherit
     OR role_record.rolreplication OR role_record.rolbypassrls THEN
    RAISE EXCEPTION 'SMS consent application role has unsafe attributes';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members membership
    JOIN pg_catalog.pg_roles role ON role.oid = membership.roleid
    JOIN pg_catalog.pg_roles member ON member.oid = membership.member
    JOIN pg_catalog.pg_roles grantor ON grantor.oid = membership.grantor
    WHERE (
      role.rolname = 'cybanext_sms_consent_retention_owner'
      OR member.rolname = 'cybanext_sms_consent_retention_owner'
    )
    AND NOT (
      role.rolname = 'cybanext_sms_consent_retention_owner'
      AND member.rolname = current_user
      AND grantor.rolname = 'cloud_admin'
      AND membership.admin_option = true
    )
  ) THEN
    RAISE EXCEPTION 'SMS consent retention owner role has unsafe memberships';
  END IF;
END
$cybanext_sms_consent_roles$;

CREATE TABLE IF NOT EXISTS public.sms_current_consent (
  regular_track_registration_id TEXT
    REFERENCES public.regular_track_applicants (registration_id) ON DELETE RESTRICT,
  digital_forensics_registration_id TEXT
    REFERENCES public.digital_forensics_registrations (registration_id) ON DELETE RESTRICT,
  phone_snapshot TEXT NOT NULL CHECK (phone_snapshot ~ '^\+233[0-9]{9}$'),
  CONSTRAINT sms_current_consent_registration_check CHECK (
    (regular_track_registration_id IS NOT NULL AND digital_forensics_registration_id IS NULL)
    OR
    (regular_track_registration_id IS NULL AND digital_forensics_registration_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS sms_current_consent_regular_registration_key
  ON public.sms_current_consent (regular_track_registration_id)
  WHERE regular_track_registration_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS sms_current_consent_digital_registration_key
  ON public.sms_current_consent (digital_forensics_registration_id)
  WHERE digital_forensics_registration_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.prevent_sms_current_consent_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Current SMS consent state cannot be changed directly'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER sms_current_consent_append_only
BEFORE DELETE OR UPDATE ON public.sms_current_consent
FOR EACH ROW EXECUTE FUNCTION public.prevent_sms_current_consent_mutation();

CREATE OR REPLACE FUNCTION public.prevent_sms_consent_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% cannot be truncated', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER sms_consent_events_no_truncate
BEFORE TRUNCATE ON public.sms_consent_events
FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_sms_consent_truncate();

CREATE TRIGGER sms_current_consent_no_truncate
BEFORE TRUNCATE ON public.sms_current_consent
FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_sms_consent_truncate();

INSERT INTO public.sms_current_consent (
  regular_track_registration_id,
  digital_forensics_registration_id,
  phone_snapshot
)
SELECT latest.regular_track_registration_id,
       latest.digital_forensics_registration_id,
       latest.phone_snapshot
FROM (
  SELECT DISTINCT ON (regular_track_registration_id)
    regular_track_registration_id,
    NULL::TEXT AS digital_forensics_registration_id,
    event_type,
    phone_snapshot,
    occurred_at,
    event_id
  FROM public.sms_consent_events
  WHERE regular_track_registration_id IS NOT NULL
  ORDER BY regular_track_registration_id, occurred_at DESC, event_id DESC
) AS latest
WHERE latest.event_type = 'grant'
UNION ALL
SELECT latest.regular_track_registration_id,
       latest.digital_forensics_registration_id,
       latest.phone_snapshot
FROM (
  SELECT DISTINCT ON (digital_forensics_registration_id)
    NULL::TEXT AS regular_track_registration_id,
    digital_forensics_registration_id,
    event_type,
    phone_snapshot,
    occurred_at,
    event_id
  FROM public.sms_consent_events
  WHERE digital_forensics_registration_id IS NOT NULL
  ORDER BY digital_forensics_registration_id, occurred_at DESC, event_id DESC
) AS latest
WHERE latest.event_type = 'grant';

CREATE OR REPLACE FUNCTION public.prevent_sms_consent_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_user = 'cybanext_sms_consent_retention_owner'
     AND OLD.occurred_at <= pg_catalog.clock_timestamp() - INTERVAL '90 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'SMS consent history is append-only except for authorized retention cleanup'
    USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION public.purge_expired_sms_consent_events()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  WITH expired AS (
    SELECT event_id
    FROM public.sms_consent_events
    WHERE occurred_at <= pg_catalog.clock_timestamp() - INTERVAL '90 days'
    ORDER BY occurred_at, event_id
    FOR UPDATE SKIP LOCKED
    LIMIT 1000
  ),
  deleted AS (
    DELETE FROM public.sms_consent_events AS event
    USING expired
    WHERE event.event_id = expired.event_id
    RETURNING event.event_id
  )
  SELECT pg_catalog.count(*)::INTEGER
  INTO deleted_count
  FROM deleted;

  RETURN deleted_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_sms_consent(
  p_regular_track_registration_id TEXT,
  p_digital_forensics_registration_id TEXT,
  p_phone_snapshot TEXT,
  p_policy_version TEXT,
  p_source TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF (p_regular_track_registration_id IS NULL) =
     (p_digital_forensics_registration_id IS NULL) THEN
    RAISE EXCEPTION 'SMS consent must identify exactly one registration'
      USING ERRCODE = '23514';
  END IF;

  IF p_phone_snapshot IS NULL OR p_phone_snapshot !~ '^\+233[0-9]{9}$'
     OR p_policy_version IS NULL
     OR pg_catalog.char_length(p_policy_version) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'SMS consent details are invalid'
      USING ERRCODE = '23514';
  END IF;

  IF p_regular_track_registration_id IS NOT NULL THEN
    IF p_source IS DISTINCT FROM 'main_application'
       OR NOT EXISTS (
         SELECT 1
         FROM public.regular_track_applicants
         WHERE registration_id = p_regular_track_registration_id
           AND phone = p_phone_snapshot
       ) THEN
      RAISE EXCEPTION 'SMS consent does not match the regular-track registration'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF p_source IS DISTINCT FROM 'digital_forensics_standalone'
       OR NOT EXISTS (
         SELECT 1
         FROM public.digital_forensics_registrations
         WHERE registration_id = p_digital_forensics_registration_id
           AND phone = p_phone_snapshot
       ) THEN
      RAISE EXCEPTION 'SMS consent does not match the Digital Forensics registration'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  INSERT INTO public.sms_consent_events (
    regular_track_registration_id,
    digital_forensics_registration_id,
    event_type,
    phone_snapshot,
    purpose,
    policy_version,
    source
  )
  VALUES (
    p_regular_track_registration_id,
    p_digital_forensics_registration_id,
    'grant',
    p_phone_snapshot,
    'SMS notifications confirming successful payment for a Cybanext programme.',
    p_policy_version,
    p_source
  );

  INSERT INTO public.sms_current_consent (
    regular_track_registration_id,
    digital_forensics_registration_id,
    phone_snapshot
  )
  VALUES (
    p_regular_track_registration_id,
    p_digital_forensics_registration_id,
    p_phone_snapshot
  );

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_expired_sms_consent_events() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_sms_consent_event_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_sms_current_consent_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_sms_consent_truncate() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_sms_consent(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_expired_sms_consent_events()
  TO cybanext_sms_consent_retention_operator;
GRANT EXECUTE ON FUNCTION public.record_sms_consent(TEXT, TEXT, TEXT, TEXT, TEXT)
  TO cybanext_sms_consent_application;
GRANT SELECT ON TABLE public.sms_current_consent
  TO cybanext_sms_consent_application;
GRANT USAGE ON SCHEMA public
  TO cybanext_sms_consent_retention_operator;
GRANT USAGE ON SCHEMA public
  TO cybanext_sms_consent_retention_owner;
GRANT USAGE ON SCHEMA public
  TO cybanext_sms_consent_application;
GRANT SELECT (registration_id, phone)
  ON TABLE public.regular_track_applicants
  TO cybanext_sms_consent_retention_owner;
GRANT SELECT (registration_id, phone)
  ON TABLE public.digital_forensics_registrations
  TO cybanext_sms_consent_retention_owner;
GRANT CREATE ON SCHEMA public TO cybanext_sms_consent_retention_owner;
GRANT cybanext_sms_consent_retention_owner TO CURRENT_USER;
ALTER TABLE public.sms_consent_events
  OWNER TO cybanext_sms_consent_retention_owner;
ALTER TABLE public.sms_current_consent
  OWNER TO cybanext_sms_consent_retention_owner;
ALTER FUNCTION public.purge_expired_sms_consent_events()
  OWNER TO cybanext_sms_consent_retention_owner;
ALTER FUNCTION public.record_sms_consent(TEXT, TEXT, TEXT, TEXT, TEXT)
  OWNER TO cybanext_sms_consent_retention_owner;
REVOKE ALL ON TABLE public.sms_consent_events FROM PUBLIC;
REVOKE ALL ON TABLE public.sms_current_consent FROM PUBLIC;
REVOKE ALL ON TABLE public.sms_consent_events FROM CURRENT_USER;
REVOKE ALL ON TABLE public.sms_current_consent FROM CURRENT_USER;
REVOKE cybanext_sms_consent_retention_owner FROM CURRENT_USER;
REVOKE CREATE ON SCHEMA public FROM cybanext_sms_consent_retention_owner;
