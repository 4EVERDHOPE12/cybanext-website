ALTER TABLE public.digital_forensics_registrations
  DROP CONSTRAINT digital_forensics_registrations_status_check;

ALTER TABLE public.digital_forensics_registrations
  ADD CONSTRAINT digital_forensics_registrations_status_check
  CHECK (status IN ('pending', 'payment_initiated', 'payment_verified', 'paid', 'payment_failed'));

CREATE TABLE IF NOT EXISTS email_notification_outbox (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'regular_track_registration_confirmation',
      'digital_forensics_registration_confirmation',
      'regular_track_payment_success',
      'digital_forensics_payment_success',
      'regular_track_payment_failure',
      'digital_forensics_payment_failure'
    )
  ),
  regular_track_registration_id TEXT
    REFERENCES regular_track_applicants (registration_id) ON DELETE CASCADE,
  digital_forensics_registration_id TEXT
    REFERENCES digital_forensics_registrations (registration_id) ON DELETE CASCADE,
  recipient_email TEXT NOT NULL CHECK (recipient_email = lower(recipient_email)),
  template_data JSONB NOT NULL CHECK (jsonb_typeof(template_data) = 'object'),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'permanent_failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_expires_at TIMESTAMPTZ,
  claim_token UUID,
  last_error_code TEXT CHECK (
    last_error_code IS NULL OR last_error_code IN (
      'configuration_missing',
      'resend_rejected',
      'resend_rate_limited',
      'resend_server_error',
      'network_error',
      'timeout',
      'invalid_response',
      'invalid_template_data',
      'delivery_error',
      'max_attempts'
    )
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TIMESTAMPTZ,
  CONSTRAINT email_notification_outbox_event_registration_check CHECK (
    (
      event_type IN (
        'regular_track_registration_confirmation',
        'regular_track_payment_success',
        'regular_track_payment_failure'
      )
      AND regular_track_registration_id IS NOT NULL
      AND digital_forensics_registration_id IS NULL
    )
    OR
    (
      event_type IN (
        'digital_forensics_registration_confirmation',
        'digital_forensics_payment_success',
        'digital_forensics_payment_failure'
      )
      AND digital_forensics_registration_id IS NOT NULL
      AND regular_track_registration_id IS NULL
    )
  ),
  CONSTRAINT email_notification_outbox_lease_check CHECK (
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
  CONSTRAINT email_notification_outbox_sent_check CHECK (
    (status = 'sent' AND sent_at IS NOT NULL)
    OR (status <> 'sent' AND sent_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS email_notification_outbox_regular_registration_idx
  ON email_notification_outbox (regular_track_registration_id);

CREATE INDEX IF NOT EXISTS email_notification_outbox_digital_registration_idx
  ON email_notification_outbox (digital_forensics_registration_id);

CREATE INDEX IF NOT EXISTS email_notification_outbox_pending_due_idx
  ON email_notification_outbox (next_attempt_at, created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS email_notification_outbox_lease_expiry_idx
  ON email_notification_outbox (lease_expires_at)
  WHERE status = 'sending';
