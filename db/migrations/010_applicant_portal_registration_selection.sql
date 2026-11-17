ALTER TABLE public.applicant_magic_link_tokens
  ALTER COLUMN registration_id DROP NOT NULL;

ALTER TABLE public.applicant_magic_link_tokens
  ADD COLUMN regular_track_registration_id TEXT
  REFERENCES public.regular_track_applicants (registration_id)
  ON DELETE CASCADE;

ALTER TABLE public.applicant_magic_link_tokens
  ADD CONSTRAINT applicant_magic_link_tokens_registration_type_check
  CHECK (
    (registration_id IS NOT NULL AND regular_track_registration_id IS NULL)
    OR
    (registration_id IS NULL AND regular_track_registration_id IS NOT NULL)
  );

ALTER TABLE public.applicant_sessions
  ALTER COLUMN registration_id DROP NOT NULL;

ALTER TABLE public.applicant_sessions
  ADD COLUMN regular_track_registration_id TEXT
  REFERENCES public.regular_track_applicants (registration_id)
  ON DELETE CASCADE;

ALTER TABLE public.applicant_sessions
  ADD COLUMN verification_registration_id TEXT
  REFERENCES public.digital_forensics_registrations (registration_id)
  ON DELETE CASCADE;

ALTER TABLE public.applicant_sessions
  ADD COLUMN verification_regular_track_registration_id TEXT
  REFERENCES public.regular_track_applicants (registration_id)
  ON DELETE CASCADE;

UPDATE public.applicant_sessions
SET verification_registration_id = registration_id
WHERE registration_id IS NOT NULL;

ALTER TABLE public.applicant_sessions
  ADD CONSTRAINT applicant_sessions_registration_type_check
  CHECK (
    registration_id IS NULL OR regular_track_registration_id IS NULL
  );

ALTER TABLE public.applicant_sessions
  ADD CONSTRAINT applicant_sessions_verification_registration_type_check
  CHECK (
    (verification_registration_id IS NOT NULL
      AND verification_regular_track_registration_id IS NULL)
    OR
    (verification_registration_id IS NULL
      AND verification_regular_track_registration_id IS NOT NULL)
    OR
    (verification_registration_id IS NULL
      AND verification_regular_track_registration_id IS NULL
      AND registration_id IS NOT NULL
      AND regular_track_registration_id IS NULL)
  );

CREATE INDEX IF NOT EXISTS applicant_magic_link_tokens_registration_idx
  ON public.applicant_magic_link_tokens (registration_id);

CREATE INDEX IF NOT EXISTS applicant_magic_link_tokens_regular_track_registration_idx
  ON public.applicant_magic_link_tokens (regular_track_registration_id);

CREATE INDEX IF NOT EXISTS applicant_sessions_regular_track_registration_idx
  ON public.applicant_sessions (regular_track_registration_id);

CREATE INDEX IF NOT EXISTS applicant_sessions_verification_registration_idx
  ON public.applicant_sessions (verification_registration_id);

CREATE INDEX IF NOT EXISTS applicant_sessions_verification_regular_track_registration_idx
  ON public.applicant_sessions (verification_regular_track_registration_id);
