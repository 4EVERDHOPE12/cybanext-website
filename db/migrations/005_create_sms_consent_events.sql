CREATE TABLE IF NOT EXISTS sms_consent_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  regular_track_registration_id TEXT
    REFERENCES regular_track_applicants (registration_id) ON DELETE RESTRICT,
  digital_forensics_registration_id TEXT
    REFERENCES digital_forensics_registrations (registration_id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('grant', 'withdrawal')),
  phone_snapshot TEXT NOT NULL
    CHECK (phone_snapshot ~ '^\+[1-9][0-9]{1,14}$'),
  purpose TEXT NOT NULL
    CHECK (purpose = 'SMS notifications confirming successful payment for a Cybanext programme.'),
  policy_version TEXT NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 80),
  source TEXT NOT NULL CHECK (
    source IN ('main_application', 'digital_forensics_standalone')
  ),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT sms_consent_events_registration_check CHECK (
    (regular_track_registration_id IS NOT NULL AND digital_forensics_registration_id IS NULL)
    OR
    (regular_track_registration_id IS NULL AND digital_forensics_registration_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS sms_consent_events_regular_registration_idx
  ON sms_consent_events (regular_track_registration_id, occurred_at);

CREATE INDEX IF NOT EXISTS sms_consent_events_digital_registration_idx
  ON sms_consent_events (digital_forensics_registration_id, occurred_at);

CREATE OR REPLACE FUNCTION public.prevent_sms_consent_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'SMS consent history is append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER sms_consent_events_append_only
BEFORE DELETE OR UPDATE ON public.sms_consent_events
FOR EACH ROW EXECUTE FUNCTION public.prevent_sms_consent_event_mutation();
