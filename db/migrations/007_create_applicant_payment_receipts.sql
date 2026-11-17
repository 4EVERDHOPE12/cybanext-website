CREATE TABLE IF NOT EXISTS applicant_payment_receipts (
  receipt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id TEXT NOT NULL UNIQUE
    REFERENCES digital_forensics_registrations (registration_id) ON DELETE RESTRICT,
  receipt_number TEXT NOT NULL UNIQUE,
  payment_reference TEXT NOT NULL UNIQUE,
  verified_transaction_id TEXT NOT NULL UNIQUE,
  applicant_name TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL CHECK (currency = 'GHS'),
  verified_at TIMESTAMPTZ NOT NULL,
  blob_pathname TEXT UNIQUE,
  generation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (generation_status IN ('pending', 'generating', 'ready')),
  generation_token UUID,
  lease_expires_at TIMESTAMPTZ,
  pdf_sha256 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
