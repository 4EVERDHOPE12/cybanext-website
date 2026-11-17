ALTER TABLE public.applicant_login_rate_limits
  DROP CONSTRAINT applicant_login_rate_limits_scope_check;

ALTER TABLE public.applicant_login_rate_limits
  ADD CONSTRAINT applicant_login_rate_limits_scope_check
  CHECK (scope IN ('email', 'ip', 'receipt_resend_email', 'receipt_resend_ip'));

ALTER TABLE public.email_notification_outbox
  DROP CONSTRAINT email_notification_outbox_event_type_check;

ALTER TABLE public.email_notification_outbox
  ADD CONSTRAINT email_notification_outbox_event_type_check
  CHECK (event_type IN (
      'regular_track_registration_confirmation',
      'digital_forensics_registration_confirmation',
      'regular_track_payment_success',
      'digital_forensics_payment_success',
      'regular_track_payment_failure',
      'digital_forensics_payment_failure',
      'digital_forensics_receipt_resend'
    ));

ALTER TABLE public.email_notification_outbox
  DROP CONSTRAINT email_notification_outbox_event_registration_check;

ALTER TABLE public.email_notification_outbox
  ADD CONSTRAINT email_notification_outbox_event_registration_check
  CHECK (
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
        'digital_forensics_payment_failure',
        'digital_forensics_receipt_resend'
      )
      AND digital_forensics_registration_id IS NOT NULL
      AND regular_track_registration_id IS NULL
    )
  );
