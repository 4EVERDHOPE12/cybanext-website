CREATE TABLE IF NOT EXISTS applicant_magic_link_tokens (
  token_hash TEXT PRIMARY KEY
    CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  registration_id TEXT NOT NULL
    REFERENCES digital_forensics_registrations (registration_id)
    ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS applicant_magic_link_tokens_expiry_idx
  ON applicant_magic_link_tokens (expires_at)
  WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS applicant_sessions (
  session_token_hash TEXT PRIMARY KEY
    CHECK (session_token_hash ~ '^[a-f0-9]{64}$'),
  registration_id TEXT NOT NULL
    REFERENCES digital_forensics_registrations (registration_id)
    ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS applicant_sessions_registration_idx
  ON applicant_sessions (registration_id);

CREATE INDEX IF NOT EXISTS applicant_sessions_expiry_idx
  ON applicant_sessions (expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS applicant_login_rate_limits (
  scope TEXT NOT NULL
    CHECK (scope IN ('email', 'ip')),
  key_hash TEXT NOT NULL
    CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  window_started_at TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (scope, key_hash)
);
