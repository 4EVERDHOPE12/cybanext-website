CREATE TABLE IF NOT EXISTS sms_notification_outbox (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key TEXT NOT NULL UNIQUE CHECK (char_length(event_key) BETWEEN 1 AND 256),
  event_type TEXT NOT NULL CHECK (event_type = 'sms_payment_success'),
  regular_track_registration_id TEXT
    REFERENCES regular_track_applicants (registration_id) ON DELETE RESTRICT,
  digital_forensics_registration_id TEXT
    REFERENCES digital_forensics_registrations (registration_id) ON DELETE RESTRICT,
  phone_snapshot TEXT NOT NULL CHECK (phone_snapshot ~ '^\+233[0-9]{9}$'),
  template_data JSONB NOT NULL CHECK (jsonb_typeof(template_data) = 'object'),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'permanent_failed', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_expires_at TIMESTAMPTZ,
  claim_token UUID,
  provider_message_id TEXT,
  last_error_code TEXT CHECK (
    last_error_code IS NULL OR char_length(last_error_code) BETWEEN 1 AND 80
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CONSTRAINT sms_notification_outbox_registration_check CHECK (
    (regular_track_registration_id IS NOT NULL AND digital_forensics_registration_id IS NULL)
    OR
    (regular_track_registration_id IS NULL AND digital_forensics_registration_id IS NOT NULL)
  ),
  CONSTRAINT sms_notification_outbox_lease_check CHECK (
    (
      status = 'sending'
      AND lease_expires_at IS NOT NULL
      AND claim_token IS NOT NULL
    )
    OR
    (
      status <> 'sending'
      AND lease_expires_at IS NULL
      AND claim_token IS NULL
    )
  ),
  CONSTRAINT sms_notification_outbox_sent_check CHECK (
    (status = 'sent' AND sent_at IS NOT NULL)
    OR (status <> 'sent' AND sent_at IS NULL)
  ),
  CONSTRAINT sms_notification_outbox_completed_check CHECK (
    (
      status IN ('sent', 'permanent_failed', 'cancelled')
      AND completed_at IS NOT NULL
    )
    OR
    (
      status IN ('pending', 'sending')
      AND completed_at IS NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS sms_notification_outbox_regular_registration_idx
  ON sms_notification_outbox (regular_track_registration_id);

CREATE INDEX IF NOT EXISTS sms_notification_outbox_digital_registration_idx
  ON sms_notification_outbox (digital_forensics_registration_id);

CREATE INDEX IF NOT EXISTS sms_notification_outbox_pending_due_idx
  ON sms_notification_outbox (next_attempt_at, created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS sms_notification_outbox_lease_expiry_idx
  ON sms_notification_outbox (lease_expires_at)
  WHERE status = 'sending';

CREATE INDEX IF NOT EXISTS sms_notification_outbox_completed_retention_idx
  ON sms_notification_outbox (completed_at)
  WHERE completed_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.require_paid_sms_notification_registration()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  IF NEW.regular_track_registration_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.regular_track_applicants
      WHERE registration_id = NEW.regular_track_registration_id
        AND status = 'payment_verified'
    ) THEN
      RAISE EXCEPTION 'SMS payment notifications require a verified payment'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1
    FROM public.digital_forensics_registrations
    WHERE registration_id = NEW.digital_forensics_registration_id
      AND status = 'payment_verified'
  ) THEN
    RAISE EXCEPTION 'SMS payment notifications require a verified payment'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sms_notification_outbox_payment_success_guard
BEFORE INSERT OR UPDATE ON public.sms_notification_outbox
FOR EACH ROW EXECUTE FUNCTION public.require_paid_sms_notification_registration();

CREATE OR REPLACE FUNCTION public.set_sms_notification_outbox_completion_timestamp()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.completed_at IS NOT NULL THEN
      IF NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
        RAISE EXCEPTION 'SMS notification completion timestamp is immutable'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END IF;
  END IF;

  IF NEW.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'SMS notification completion timestamp is database-controlled'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status IN ('sent', 'permanent_failed', 'cancelled') THEN
    NEW.completed_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sms_notification_outbox_completion_timestamp
BEFORE INSERT OR UPDATE ON public.sms_notification_outbox
FOR EACH ROW EXECUTE FUNCTION public.set_sms_notification_outbox_completion_timestamp();

CREATE OR REPLACE FUNCTION public.prevent_early_sms_notification_outbox_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  IF OLD.status NOT IN ('sent', 'permanent_failed', 'cancelled')
    OR OLD.completed_at IS NULL
    OR OLD.completed_at > clock_timestamp() - INTERVAL '90 days'
  THEN
    RAISE EXCEPTION 'SMS notification records cannot be deleted before the retention period'
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER sms_notification_outbox_retention_guard
BEFORE DELETE ON public.sms_notification_outbox
FOR EACH ROW EXECUTE FUNCTION public.prevent_early_sms_notification_outbox_deletion();

CREATE OR REPLACE FUNCTION public.prevent_sms_notification_outbox_truncate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  RAISE EXCEPTION 'SMS notification records cannot be truncated'
    USING ERRCODE = '55000';
  RETURN NULL;
END;
$$;

CREATE TRIGGER sms_notification_outbox_no_truncate
BEFORE TRUNCATE ON public.sms_notification_outbox
FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_sms_notification_outbox_truncate();

CREATE OR REPLACE FUNCTION public.purge_expired_sms_notification_outbox()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM public.sms_notification_outbox
  WHERE status IN ('sent', 'permanent_failed', 'cancelled')
    AND completed_at <= clock_timestamp() - INTERVAL '90 days';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION
  public.require_paid_sms_notification_registration(),
  public.set_sms_notification_outbox_completion_timestamp(),
  public.prevent_early_sms_notification_outbox_deletion(),
  public.prevent_sms_notification_outbox_truncate(),
  public.purge_expired_sms_notification_outbox()
FROM PUBLIC;
