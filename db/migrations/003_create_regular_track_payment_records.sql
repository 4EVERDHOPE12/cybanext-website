CREATE TABLE IF NOT EXISTS regular_track_applicants (
  registration_id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 120),
  email TEXT NOT NULL CHECK (email = lower(email)),
  phone TEXT NOT NULL DEFAULT '',
  track TEXT NOT NULL CHECK (
    track IN (
      'incident_response',
      'soc_analyst',
      'network_security',
      'web_app_penetration_testing',
      'cloud_security'
    )
  ),
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'payment_initiated', 'payment_verified')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS regular_track_applicants_email_idx
  ON regular_track_applicants (email);

CREATE INDEX IF NOT EXISTS regular_track_applicants_track_idx
  ON regular_track_applicants (track);

CREATE TABLE IF NOT EXISTS regular_track_payment_attempts (
  payment_reference TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL
    REFERENCES regular_track_applicants (registration_id)
    ON DELETE CASCADE,
  reference_amount NUMERIC(12, 2) NOT NULL CHECK (reference_amount > 0),
  reference_currency TEXT NOT NULL CHECK (reference_currency = 'USD'),
  expected_amount INTEGER NOT NULL CHECK (expected_amount > 0),
  expected_currency TEXT NOT NULL CHECK (expected_currency = 'GHS'),
  status TEXT NOT NULL CHECK (
    status IN (
      'initializing',
      'payment_initiated',
      'payment_verified',
      'failed',
      'initialization_failed'
    )
  ),
  verified_transaction_id TEXT UNIQUE,
  payment_verification_timestamp TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS regular_track_payment_attempts_registration_idx
  ON regular_track_payment_attempts (registration_id);
