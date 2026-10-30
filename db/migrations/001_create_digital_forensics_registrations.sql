CREATE TABLE IF NOT EXISTS digital_forensics_registrations (
  registration_id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 120),
  email TEXT NOT NULL CHECK (email = lower(email)),
  phone TEXT NOT NULL DEFAULT '',
  course TEXT NOT NULL DEFAULT 'digital_forensics'
    CHECK (course = 'digital_forensics'),
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'payment_initiated', 'payment_verified', 'paid')),
  pricing_option TEXT
    CHECK (pricing_option IS NULL OR pricing_option IN ('GHS', 'USD_REFERENCE')),
  expected_amount NUMERIC(12, 2) NOT NULL CHECK (expected_amount > 0),
  expected_currency TEXT NOT NULL CHECK (expected_currency = 'GHS'),
  payment_reference TEXT UNIQUE,
  verified_transaction_id TEXT UNIQUE,
  payment_verification_timestamp TIMESTAMPTZ,
  email_notification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (email_notification_status IN ('pending', 'sent', 'failed')),
  sms_notification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (sms_notification_status IN ('pending', 'sent', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS
  digital_forensics_registrations_email_idx
  ON digital_forensics_registrations (email);

CREATE INDEX IF NOT EXISTS
  digital_forensics_registrations_status_idx
  ON digital_forensics_registrations (status);
