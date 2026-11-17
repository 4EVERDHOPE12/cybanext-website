const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TARGETS = {
  development: {
    branchName: 'dev/cybanext-phase2c-test',
    endpointHostVariable: 'MIGRATION_DEV_ENDPOINT_HOST'
  },
  production: {
    confirmationText: 'I-UNDERSTAND-THIS-IS-PRODUCTION',
    endpointHostVariable: 'MIGRATION_PRODUCTION_ENDPOINT_HOST'
  }
};
const EXPECTED_DATABASE = 'neondb';
const MIGRATION_FILES = [
  '001_create_digital_forensics_registrations.sql',
  '002_create_applicant_magic_link_auth.sql',
  '003_create_regular_track_payment_records.sql',
  '004_create_email_notification_outbox.sql',
  '005_create_sms_consent_events.sql',
  '006_create_sms_notification_outbox.sql',
  '007_create_applicant_payment_receipts.sql',
  '008_add_applicant_receipt_resend.sql',
  '009_sms_consent_retention.sql',
  '010_applicant_portal_registration_selection.sql'
];
const EXPECTED_TABLES = [
  'digital_forensics_registrations',
  'applicant_magic_link_tokens',
  'applicant_sessions',
  'applicant_login_rate_limits',
  'regular_track_applicants',
  'regular_track_payment_attempts',
  'email_notification_outbox',
  'sms_consent_events',
  'sms_current_consent',
  'sms_notification_outbox',
  'applicant_payment_receipts'
];
const REGULAR_TRACK_OBJECTS = [
  'regular_track_applicants',
  'regular_track_applicants_pkey',
  'regular_track_applicants_email_idx',
  'regular_track_applicants_track_idx',
  'regular_track_payment_attempts',
  'regular_track_payment_attempts_pkey',
  'regular_track_payment_attempts_verified_transaction_id_key',
  'regular_track_payment_attempts_registration_idx'
];

function splitSqlStatements(script) {
  const statements = [];
  let statementStart = 0;
  let state = 'normal';
  let dollarTag = '';
  let blockCommentDepth = 0;

  for (let index = 0; index < script.length; index += 1) {
    const character = script[index];
    const next = script[index + 1];
    if (state === 'single-quoted') {
      if (character === "'" && next === "'") index += 1;
      else if (character === "'") state = 'normal';
      else if (character === '\\') index += 1;
      continue;
    }
    if (state === 'double-quoted') {
      if (character === '"' && next === '"') index += 1;
      else if (character === '"') state = 'normal';
      continue;
    }
    if (state === 'line-comment') {
      if (character === '\n') state = 'normal';
      continue;
    }
    if (state === 'block-comment') {
      if (character === '/' && next === '*') { blockCommentDepth += 1; index += 1; }
      else if (character === '*' && next === '/') {
        blockCommentDepth -= 1; index += 1;
        if (blockCommentDepth === 0) state = 'normal';
      }
      continue;
    }
    if (state === 'dollar-quoted') {
      if (script.startsWith(dollarTag, index)) {
        index += dollarTag.length - 1;
        state = 'normal';
      }
      continue;
    }
    if (character === "'") state = 'single-quoted';
    else if (character === '"') state = 'double-quoted';
    else if (character === '-' && next === '-') { state = 'line-comment'; index += 1; }
    else if (character === '/' && next === '*') { state = 'block-comment'; blockCommentDepth = 1; index += 1; }
    else if (character === '$') {
      const match = script.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) { dollarTag = match[0]; state = 'dollar-quoted'; index += dollarTag.length - 1; }
    } else if (character === ';') {
      const statement = script.slice(statementStart, index).trim();
      if (statement) statements.push(statement);
      statementStart = index + 1;
    }
  }
  if (state !== 'normal' && state !== 'line-comment') {
    throw new Error('Migration contains an unterminated SQL literal or comment.');
  }
  const remaining = script.slice(statementStart).trim();
  if (remaining) statements.push(remaining);
  return statements;
}

function normalizeSqlStatement(statement) {
  return statement.replace(/\s+/g, ' ').trim().toLowerCase();
}

function isAllowedFunctionStatement(filename, statement) {
  const normalized = normalizeSqlStatement(statement);
  const allowed = {
    '005_create_sms_consent_events.sql': [
      "create or replace function public.prevent_sms_consent_event_mutation() returns trigger language plpgsql as $$ begin raise exception 'sms consent history is append-only' using errcode = '55000'; end; $$"
    ],
    '006_create_sms_notification_outbox.sql': [
      "create or replace function public.require_paid_sms_notification_registration() returns trigger language plpgsql security invoker as $$ begin if new.regular_track_registration_id is not null then if not exists ( select 1 from public.regular_track_applicants where registration_id = new.regular_track_registration_id and status = 'payment_verified' ) then raise exception 'sms payment notifications require a verified payment' using errcode = '23514'; end if; elsif not exists ( select 1 from public.digital_forensics_registrations where registration_id = new.digital_forensics_registration_id and status = 'payment_verified' ) then raise exception 'sms payment notifications require a verified payment' using errcode = '23514'; end if; return new; end; $$",
      "create or replace function public.set_sms_notification_outbox_completion_timestamp() returns trigger language plpgsql security invoker as $$ begin if tg_op = 'update' then if old.completed_at is not null then if new.completed_at is distinct from old.completed_at then raise exception 'sms notification completion timestamp is immutable' using errcode = '55000'; end if; return new; end if; end if; if new.completed_at is not null then raise exception 'sms notification completion timestamp is database-controlled' using errcode = '55000'; end if; if new.status in ('sent', 'permanent_failed', 'cancelled') then new.completed_at := clock_timestamp(); end if; return new; end; $$",
      "create or replace function public.prevent_early_sms_notification_outbox_deletion() returns trigger language plpgsql security invoker as $$ begin if old.status not in ('sent', 'permanent_failed', 'cancelled') or old.completed_at is null or old.completed_at > clock_timestamp() - interval '90 days' then raise exception 'sms notification records cannot be deleted before the retention period' using errcode = '55000'; end if; return old; end; $$",
      "create or replace function public.prevent_sms_notification_outbox_truncate() returns trigger language plpgsql security invoker as $$ begin raise exception 'sms notification records cannot be truncated' using errcode = '55000'; return null; end; $$",
      "create or replace function public.purge_expired_sms_notification_outbox() returns integer language plpgsql security invoker as $$ declare deleted_count integer; begin delete from public.sms_notification_outbox where status in ('sent', 'permanent_failed', 'cancelled') and completed_at <= clock_timestamp() - interval '90 days'; get diagnostics deleted_count = row_count; return deleted_count; end; $$"
    ],
    '009_sms_consent_retention.sql': [
      "create or replace function public.prevent_sms_current_consent_mutation() returns trigger language plpgsql as $$ begin raise exception 'current sms consent state cannot be changed directly' using errcode = '55000'; end; $$",
      "create or replace function public.prevent_sms_consent_event_mutation() returns trigger language plpgsql as $$ begin if tg_op = 'delete' and current_user = 'cybanext_sms_consent_retention_owner' and old.occurred_at <= pg_catalog.clock_timestamp() - interval '90 days' then return old; end if; raise exception 'sms consent history is append-only except for authorized retention cleanup' using errcode = '55000'; end; $$",
      "create or replace function public.prevent_sms_consent_truncate() returns trigger language plpgsql as $$ begin raise exception '% cannot be truncated', tg_table_name using errcode = '55000'; end; $$",
      "create or replace function public.purge_expired_sms_consent_events() returns integer language plpgsql security definer set search_path = pg_catalog as $$ declare deleted_count integer; begin with expired as ( select event_id from public.sms_consent_events where occurred_at <= pg_catalog.clock_timestamp() - interval '90 days' order by occurred_at, event_id for update skip locked limit 1000 ), deleted as ( delete from public.sms_consent_events as event using expired where event.event_id = expired.event_id returning event.event_id ) select pg_catalog.count(*)::integer into deleted_count from deleted; return deleted_count; end; $$",
      "create or replace function public.record_sms_consent( p_regular_track_registration_id text, p_digital_forensics_registration_id text, p_phone_snapshot text, p_policy_version text, p_source text ) returns boolean language plpgsql security definer set search_path = pg_catalog as $$ begin if (p_regular_track_registration_id is null) = (p_digital_forensics_registration_id is null) then raise exception 'sms consent must identify exactly one registration' using errcode = '23514'; end if; if p_phone_snapshot is null or p_phone_snapshot !~ '^\\+233[0-9]{9}$' or p_policy_version is null or pg_catalog.char_length(p_policy_version) not between 1 and 80 then raise exception 'sms consent details are invalid' using errcode = '23514'; end if; if p_regular_track_registration_id is not null then if p_source is distinct from 'main_application' or not exists ( select 1 from public.regular_track_applicants where registration_id = p_regular_track_registration_id and phone = p_phone_snapshot ) then raise exception 'sms consent does not match the regular-track registration' using errcode = '23514'; end if; else if p_source is distinct from 'digital_forensics_standalone' or not exists ( select 1 from public.digital_forensics_registrations where registration_id = p_digital_forensics_registration_id and phone = p_phone_snapshot ) then raise exception 'sms consent does not match the digital forensics registration' using errcode = '23514'; end if; end if; insert into public.sms_consent_events ( regular_track_registration_id, digital_forensics_registration_id, event_type, phone_snapshot, purpose, policy_version, source ) values ( p_regular_track_registration_id, p_digital_forensics_registration_id, 'grant', p_phone_snapshot, 'sms notifications confirming successful payment for a cybanext programme.', p_policy_version, p_source ); insert into public.sms_current_consent ( regular_track_registration_id, digital_forensics_registration_id, phone_snapshot ) values ( p_regular_track_registration_id, p_digital_forensics_registration_id, p_phone_snapshot ); return true; end; $$"
    ]
  };
  return Boolean(allowed[filename]?.includes(normalized));
}

function isAllowedTriggerStatement(filename, statement) {
  const normalized = normalizeSqlStatement(statement);
  const allowed = {
    '005_create_sms_consent_events.sql': [
      'create trigger sms_consent_events_append_only before delete or update on public.sms_consent_events for each row execute function public.prevent_sms_consent_event_mutation()'
    ],
    '006_create_sms_notification_outbox.sql': [
      'create trigger sms_notification_outbox_payment_success_guard before insert or update on public.sms_notification_outbox for each row execute function public.require_paid_sms_notification_registration()',
      'create trigger sms_notification_outbox_completion_timestamp before insert or update on public.sms_notification_outbox for each row execute function public.set_sms_notification_outbox_completion_timestamp()',
      'create trigger sms_notification_outbox_retention_guard before delete on public.sms_notification_outbox for each row execute function public.prevent_early_sms_notification_outbox_deletion()',
      'create trigger sms_notification_outbox_no_truncate before truncate on public.sms_notification_outbox for each statement execute function public.prevent_sms_notification_outbox_truncate()'
    ],
    '009_sms_consent_retention.sql': [
      'create trigger sms_current_consent_append_only before delete or update on public.sms_current_consent for each row execute function public.prevent_sms_current_consent_mutation()',
      'create trigger sms_consent_events_no_truncate before truncate on public.sms_consent_events for each statement execute function public.prevent_sms_consent_truncate()',
      'create trigger sms_current_consent_no_truncate before truncate on public.sms_current_consent for each statement execute function public.prevent_sms_consent_truncate()'
    ]
  };
  return Boolean(allowed[filename]?.includes(normalized));
}

function isAllowedReceiptResendMigrationStatement(statement) {
  const allowedStatements = [
    `ALTER TABLE public.applicant_login_rate_limits
      DROP CONSTRAINT applicant_login_rate_limits_scope_check`,
    `ALTER TABLE public.applicant_login_rate_limits
      ADD CONSTRAINT applicant_login_rate_limits_scope_check
      CHECK (scope IN ('email', 'ip', 'receipt_resend_email', 'receipt_resend_ip'))`,
    `ALTER TABLE public.email_notification_outbox
      DROP CONSTRAINT email_notification_outbox_event_type_check`,
    `ALTER TABLE public.email_notification_outbox
      ADD CONSTRAINT email_notification_outbox_event_type_check
      CHECK (event_type IN (
        'regular_track_registration_confirmation',
        'digital_forensics_registration_confirmation',
        'regular_track_payment_success',
        'digital_forensics_payment_success',
        'regular_track_payment_failure',
        'digital_forensics_payment_failure',
        'digital_forensics_receipt_resend'
      ))`,
    `ALTER TABLE public.email_notification_outbox
      DROP CONSTRAINT email_notification_outbox_event_registration_check`,
    `ALTER TABLE public.email_notification_outbox
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
      )`
  ].map(normalizeSqlStatement);
  return allowedStatements.includes(normalizeSqlStatement(statement));
}

function isAllowedSmsOutboxStatement(statement) {
  const normalized = normalizeSqlStatement(statement);
  const exactStatements = [
    `CREATE TABLE IF NOT EXISTS sms_notification_outbox (
      event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_key TEXT NOT NULL UNIQUE CHECK (char_length(event_key) BETWEEN 1 AND 256),
      event_type TEXT NOT NULL CHECK (event_type = 'sms_payment_success'),
      regular_track_registration_id TEXT
        REFERENCES regular_track_applicants (registration_id) ON DELETE RESTRICT,
      digital_forensics_registration_id TEXT
        REFERENCES digital_forensics_registrations (registration_id) ON DELETE RESTRICT,
      phone_snapshot TEXT NOT NULL CHECK (phone_snapshot ~ '^\\+233[0-9]{9}$'),
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
    )`,
    `CREATE INDEX IF NOT EXISTS sms_notification_outbox_regular_registration_idx
      ON sms_notification_outbox (regular_track_registration_id)`,
    `CREATE INDEX IF NOT EXISTS sms_notification_outbox_digital_registration_idx
      ON sms_notification_outbox (digital_forensics_registration_id)`,
    `CREATE INDEX IF NOT EXISTS sms_notification_outbox_pending_due_idx
      ON sms_notification_outbox (next_attempt_at, created_at)
      WHERE status = 'pending'`,
    `CREATE INDEX IF NOT EXISTS sms_notification_outbox_lease_expiry_idx
      ON sms_notification_outbox (lease_expires_at)
      WHERE status = 'sending'`,
    `CREATE INDEX IF NOT EXISTS sms_notification_outbox_completed_retention_idx
      ON sms_notification_outbox (completed_at)
      WHERE completed_at IS NOT NULL`
  ].map(normalizeSqlStatement);
  return exactStatements.includes(normalized) ||
    isAllowedFunctionStatement('006_create_sms_notification_outbox.sql', statement) ||
    isAllowedTriggerStatement('006_create_sms_notification_outbox.sql', statement) ||
    normalized === normalizeSqlStatement(`REVOKE ALL ON FUNCTION
      public.require_paid_sms_notification_registration(),
      public.set_sms_notification_outbox_completion_timestamp(),
      public.prevent_early_sms_notification_outbox_deletion(),
      public.prevent_sms_notification_outbox_truncate(),
      public.purge_expired_sms_notification_outbox()
    FROM PUBLIC`);
}

function isAllowedApplicantPortalMigrationStatement(statement) {
  const allowedStatements = new Set([
    'alter table public.applicant_magic_link_tokens alter column registration_id drop not null',
    'alter table public.applicant_magic_link_tokens add column regular_track_registration_id text references public.regular_track_applicants (registration_id) on delete cascade',
    'alter table public.applicant_magic_link_tokens add constraint applicant_magic_link_tokens_registration_type_check check ( (registration_id is not null and regular_track_registration_id is null) or (registration_id is null and regular_track_registration_id is not null) )',
    'alter table public.applicant_sessions alter column registration_id drop not null',
    'alter table public.applicant_sessions add column regular_track_registration_id text references public.regular_track_applicants (registration_id) on delete cascade',
    'alter table public.applicant_sessions add column verification_registration_id text references public.digital_forensics_registrations (registration_id) on delete cascade',
    'alter table public.applicant_sessions add column verification_regular_track_registration_id text references public.regular_track_applicants (registration_id) on delete cascade',
    'update public.applicant_sessions set verification_registration_id = registration_id where registration_id is not null',
    'alter table public.applicant_sessions add constraint applicant_sessions_registration_type_check check ( registration_id is null or regular_track_registration_id is null )',
    'alter table public.applicant_sessions add constraint applicant_sessions_verification_registration_type_check check ( (verification_registration_id is not null and verification_regular_track_registration_id is null) or (verification_registration_id is null and verification_regular_track_registration_id is not null) or (verification_registration_id is null and verification_regular_track_registration_id is null and registration_id is not null and regular_track_registration_id is null) )',
    'create index if not exists applicant_magic_link_tokens_registration_idx on public.applicant_magic_link_tokens (registration_id)',
    'create index if not exists applicant_magic_link_tokens_regular_track_registration_idx on public.applicant_magic_link_tokens (regular_track_registration_id)',
    'create index if not exists applicant_sessions_regular_track_registration_idx on public.applicant_sessions (regular_track_registration_id)',
    'create index if not exists applicant_sessions_verification_registration_idx on public.applicant_sessions (verification_registration_id)',
    'create index if not exists applicant_sessions_verification_regular_track_registration_idx on public.applicant_sessions (verification_regular_track_registration_id)'
  ]);
  return allowedStatements.has(statement.replace(/\s+/g, ' ').trim().toLowerCase());
}

function isAllowedSmsConsentRetentionStatement(statement) {
  const normalized = normalizeSqlStatement(statement);
  const exactStatements = [
    `CREATE TABLE IF NOT EXISTS public.sms_current_consent (
      regular_track_registration_id TEXT
        REFERENCES public.regular_track_applicants (registration_id) ON DELETE RESTRICT,
      digital_forensics_registration_id TEXT
        REFERENCES public.digital_forensics_registrations (registration_id) ON DELETE RESTRICT,
      phone_snapshot TEXT NOT NULL CHECK (phone_snapshot ~ '^\\+233[0-9]{9}$'),
      CONSTRAINT sms_current_consent_registration_check CHECK (
        (regular_track_registration_id IS NOT NULL AND digital_forensics_registration_id IS NULL)
        OR
        (regular_track_registration_id IS NULL AND digital_forensics_registration_id IS NOT NULL)
      )
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS sms_current_consent_regular_registration_key
      ON public.sms_current_consent (regular_track_registration_id)
      WHERE regular_track_registration_id IS NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS sms_current_consent_digital_registration_key
      ON public.sms_current_consent (digital_forensics_registration_id)
      WHERE digital_forensics_registration_id IS NOT NULL`,
    `INSERT INTO public.sms_current_consent (
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
    WHERE latest.event_type = 'grant'`,
    `REVOKE ALL ON FUNCTION public.purge_expired_sms_consent_events() FROM PUBLIC`,
    `REVOKE ALL ON FUNCTION public.record_sms_consent(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC`,
    `REVOKE ALL ON FUNCTION public.prevent_sms_consent_truncate() FROM PUBLIC`,
    `GRANT EXECUTE ON FUNCTION public.purge_expired_sms_consent_events()
      TO cybanext_sms_consent_retention_operator`,
    `GRANT EXECUTE ON FUNCTION public.record_sms_consent(TEXT, TEXT, TEXT, TEXT, TEXT)
      TO cybanext_sms_consent_application`,
    `GRANT SELECT ON TABLE public.sms_current_consent
      TO cybanext_sms_consent_application`,
    `GRANT USAGE ON SCHEMA public
      TO cybanext_sms_consent_retention_operator`,
    `GRANT USAGE ON SCHEMA public
      TO cybanext_sms_consent_retention_owner`,
    `GRANT USAGE ON SCHEMA public
      TO cybanext_sms_consent_application`,
    `GRANT SELECT (registration_id, phone)
      ON TABLE public.regular_track_applicants
      TO cybanext_sms_consent_retention_owner`,
    `GRANT SELECT (registration_id, phone)
      ON TABLE public.digital_forensics_registrations
      TO cybanext_sms_consent_retention_owner`,
    `GRANT CREATE ON SCHEMA public TO cybanext_sms_consent_retention_owner`,
    `GRANT cybanext_sms_consent_retention_owner TO CURRENT_USER`,
    `ALTER TABLE public.sms_consent_events
      OWNER TO cybanext_sms_consent_retention_owner`,
    `ALTER TABLE public.sms_current_consent
      OWNER TO cybanext_sms_consent_retention_owner`,
    `ALTER FUNCTION public.purge_expired_sms_consent_events()
      OWNER TO cybanext_sms_consent_retention_owner`,
    `ALTER FUNCTION public.record_sms_consent(TEXT, TEXT, TEXT, TEXT, TEXT)
      OWNER TO cybanext_sms_consent_retention_owner`,
    `REVOKE ALL ON TABLE public.sms_consent_events FROM PUBLIC`,
    `REVOKE ALL ON TABLE public.sms_current_consent FROM PUBLIC`,
    `REVOKE ALL ON TABLE public.sms_consent_events FROM CURRENT_USER`,
    `REVOKE ALL ON TABLE public.sms_current_consent FROM CURRENT_USER`,
    `REVOKE cybanext_sms_consent_retention_owner FROM CURRENT_USER`,
    `REVOKE CREATE ON SCHEMA public FROM cybanext_sms_consent_retention_owner`,
    `REVOKE ALL ON FUNCTION public.prevent_sms_consent_event_mutation() FROM PUBLIC`,
    `REVOKE ALL ON FUNCTION public.prevent_sms_current_consent_mutation() FROM PUBLIC`
  ].map(normalizeSqlStatement);
  const roleSetup = normalizeSqlStatement(`DO $cybanext_sms_consent_roles$
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
        WHERE role.rolname = 'cybanext_sms_consent_retention_owner'
           OR member.rolname = 'cybanext_sms_consent_retention_owner'
      ) THEN
        RAISE EXCEPTION 'SMS consent retention owner role has unsafe memberships';
      END IF;
    END
    $cybanext_sms_consent_roles$`);
  return exactStatements.includes(normalized) ||
    normalized === roleSetup ||
    isAllowedFunctionStatement('009_sms_consent_retention.sql', statement) ||
    isAllowedTriggerStatement('009_sms_consent_retention.sql', statement);
}

function loadMigrations(migrationsDirectory = path.join(__dirname, '..', 'db', 'migrations')) {
  return MIGRATION_FILES.map((filename) => {
    const content = fs.readFileSync(path.join(migrationsDirectory, filename), 'utf8');
    const statements = splitSqlStatements(content);
    const supportedStatement = filename === '006_create_sms_notification_outbox.sql'
      ? isAllowedSmsOutboxStatement
      : filename === '009_sms_consent_retention.sql'
        ? isAllowedSmsConsentRetentionStatement
      : filename === '010_applicant_portal_registration_selection.sql'
        ? isAllowedApplicantPortalMigrationStatement
      : filename === '008_add_applicant_receipt_resend.sql'
        ? isAllowedReceiptResendMigrationStatement
      : (statement) =>
        /^CREATE\s+(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\b/i.test(statement) ||
        isAllowedFunctionStatement(filename, statement) ||
        isAllowedTriggerStatement(filename, statement) ||
        (filename === '004_create_email_notification_outbox.sql' &&
          /^ALTER\s+TABLE\s+public\.digital_forensics_registrations\s+(?:DROP\s+CONSTRAINT\s+digital_forensics_registrations_status_check|ADD\s+CONSTRAINT\s+digital_forensics_registrations_status_check\s+CHECK\s*\(status\s+IN\s*\('pending',\s*'payment_initiated',\s*'payment_verified',\s*'paid',\s*'payment_failed'\)\))$/i.test(statement));
    if (statements.length === 0 || statements.some((statement) =>
      !supportedStatement(statement))) {
      throw new Error(`Migration ${filename} contains an unsupported statement.`);
    }
    return { filename, statements, checksum: crypto.createHash('sha256').update(content, 'utf8').digest('hex') };
  });
}

function parseArguments(args) {
  let apply = false;
  let preflight = false;
  let target = null;
  let developmentConfirmation = null;
  let productionConfirmation = null;
  let adoptExisting = false;
  for (const argument of args) {
    if (argument === '--apply') apply = true;
    else if (argument === '--preflight') preflight = true;
    else if (argument.startsWith('--target=')) {
      if (target !== null) throw new Error('--target may be specified only once.');
      target = argument.slice('--target='.length);
    } else if (argument.startsWith('--confirm-development=')) {
      if (developmentConfirmation !== null) throw new Error('Development confirmation may be specified only once.');
      developmentConfirmation = argument.slice('--confirm-development='.length);
    } else if (argument.startsWith('--confirm-production=')) {
      if (productionConfirmation !== null) throw new Error('Production confirmation may be specified only once.');
      productionConfirmation = argument.slice('--confirm-production='.length);
    } else if (argument === '--adopt-existing') adoptExisting = true;
    else throw new Error('Unsupported migration runner argument.');
  }
  if (!target) throw new Error('--target=development or --target=production is required.');
  if (!Object.hasOwn(TARGETS, target)) throw new Error('Migration target must be development or production.');
  if (preflight && target !== 'development') {
    throw new Error('--preflight is only supported with --target=development.');
  }
  if (preflight && apply) throw new Error('--preflight cannot be combined with --apply.');
  if (apply && target === 'development' && developmentConfirmation !== TARGETS.development.branchName) {
    throw new Error(`Development apply requires --confirm-development=${TARGETS.development.branchName}.`);
  }
  if (apply && target === 'production' && productionConfirmation !== TARGETS.production.confirmationText) {
    throw new Error(`Production apply requires --confirm-production=${TARGETS.production.confirmationText}.`);
  }
  if (developmentConfirmation && target !== 'development') throw new Error('Development confirmation can only be used with --target=development.');
  if (productionConfirmation && target !== 'production') throw new Error('Production confirmation can only be used with --target=production.');
  if ((!apply || preflight) && (developmentConfirmation || productionConfirmation || adoptExisting)) {
    throw new Error('Confirmations and --adopt-existing require --apply.');
  }
  if (adoptExisting && target !== 'development') throw new Error('--adopt-existing is only supported for the development target.');
  return { apply, preflight, target, adoptExisting };
}

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function validateEndpointConfiguration(target, environment) {
  const hostFor = (name) => {
    const variable = TARGETS[name].endpointHostVariable;
    const value = environment[variable];
    const labels = typeof value === 'string' ? value.toLowerCase().split('.') : [];
    if (typeof value !== 'string' || !value || value !== value.trim() ||
        !value.toLowerCase().endsWith('.neon.tech') ||
        labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw new Error(`${variable} is missing or malformed; use the hostname from the verified Neon Connect details.`);
    }
    return value.toLowerCase();
  };
  const developmentHost = hostFor('development');
  const productionHost = hostFor('production');
  if (developmentHost === productionHost) {
    throw new Error('Development and production endpoint host configuration is ambiguous.');
  }
  const selectedHost = target === 'development' ? developmentHost : productionHost;
  let connectionUrl;
  try { connectionUrl = new URL(environment.DATABASE_URL); }
  catch { throw new Error('DATABASE_URL is not a valid PostgreSQL URL.'); }
  if (!['postgres:', 'postgresql:'].includes(connectionUrl.protocol)) throw new Error('DATABASE_URL must use PostgreSQL.');
  const hasHostOverride = [...connectionUrl.searchParams.keys()].some((parameter) =>
    ['host', 'hostaddr'].includes(parameter.toLowerCase()));
  if (hasHostOverride) {
    throw new Error('DATABASE_URL must not override the configured endpoint host.');
  }
  let effectiveHost;
  try {
    const { Client } = require('@neondatabase/serverless');
    effectiveHost = new Client({ connectionString: environment.DATABASE_URL }).connectionParameters.host;
  } catch {
    throw new Error('Could not verify the effective database endpoint host.');
  }
  if (typeof effectiveHost !== 'string' || effectiveHost.toLowerCase() !== selectedHost) {
    throw new Error('DATABASE_URL endpoint does not match the selected migration target.');
  }
}

async function verifyConnectionTarget(sql, target, environment) {
  validateEndpointConfiguration(target, environment);
  let rows;
  try { rows = await sql.query('SELECT current_database() AS database_name'); }
  catch { throw new Error('Could not verify the database name for the selected target.'); }
  if (!rows[0] || rows[0].database_name !== EXPECTED_DATABASE) {
    throw new Error('Connected database does not match the expected database for this project.');
  }
}

function normalizeDefinition(value) {
  return String(value).toLowerCase().replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim();
}

function normalizeFunctionSource(value) {
  return String(value).replace(/\r\n/g, '\n').trim().replace(/;\s*$/, '');
}

function normalizePredicate(value) {
  return stripEnclosingParentheses(normalizeDefinition(value));
}

function stripEnclosingParentheses(value) {
  let result = value.trim();
  while (result.startsWith('(') && result.endsWith(')')) {
    let depth = 0;
    let enclosed = true;
    let quote = false;
    for (let index = 0; index < result.length; index += 1) {
      const character = result[index];
      if (character === "'") {
        if (quote && result[index + 1] === "'") { index += 1; continue; }
        quote = !quote;
      } else if (!quote && character === '(') depth += 1;
      else if (!quote && character === ')') {
        depth -= 1;
        if (depth === 0 && index !== result.length - 1) { enclosed = false; break; }
      }
    }
    if (!enclosed || depth !== 0) break;
    result = result.slice(1, -1).trim();
  }
  return result;
}

function normalizeConstraintDefinition(value) {
  const normalized = String(value).trim();
  const match = normalized.match(/^check\s*\((.*)\)$/is);
  if (!match) return normalized;
  return `check(${canonicalizeCheckExpression(match[1])})`;
}

function canonicalizeCheckExpression(expression) {
  let result = stripEnclosingParentheses(expression);
  let changed = true;
  while (changed) {
    changed = false;
    let quote = null;
    const removals = [];
    for (let start = 0; start < result.length; start += 1) {
      const character = result[start];
      if (quote) {
        if (character === quote && result[start + 1] === quote) start += 1;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === "'" || character === '"') { quote = character; continue; }
      if (character !== '(') continue;

      let depth = 1;
      let innerQuote = null;
      let end = start + 1;
      for (; end < result.length && depth > 0; end += 1) {
        const innerCharacter = result[end];
        if (innerQuote) {
          if (innerCharacter === innerQuote && result[end + 1] === innerQuote) end += 1;
          else if (innerCharacter === innerQuote) innerQuote = null;
        } else if (innerCharacter === "'" || innerCharacter === '"') innerQuote = innerCharacter;
        else if (innerCharacter === '(') depth += 1;
        else if (innerCharacter === ')') depth -= 1;
      }
      if (depth !== 0) continue;
      const close = end - 1;
      const content = result.slice(start + 1, close);
      if (hasTopLevelBooleanOperator(content)) continue;
      if (hasTopLevelPredicateOperator(content) || isNumericLiteral(content)) {
        removals.push([start, close]);
        start = close;
      }
    }
    if (removals.length) {
      for (let index = removals.length - 1; index >= 0; index -= 1) {
        const [start, close] = removals[index];
        const inner = result.slice(start + 1, close);
        const before = result[start - 1] || '';
        const after = result[close + 1] || '';
        const leadingSpace = /[A-Za-z0-9_$]/.test(before) && /[A-Za-z0-9_$]/.test(inner[0] || '') ? ' ' : '';
        const trailingSpace = /[A-Za-z0-9_$]/.test(inner.at(-1) || '') && /[A-Za-z0-9_$]/.test(after) ? ' ' : '';
        result = result.slice(0, start) + leadingSpace + inner + trailingSpace + result.slice(close + 1);
      }
      changed = true;
    }
  }
  return canonicalizeSqlTokens(result);
}

function isNumericLiteral(value) {
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(stripEnclosingParentheses(value).trim());
}

function canonicalizeSqlTokens(expression) {
  const tokens = [];
  for (let index = 0; index < expression.length;) {
    const character = expression[index];
    if (/\s/.test(character)) { index += 1; continue; }
    if (character === "'" || character === '"') {
      const quote = character;
      let token = character;
      index += 1;
      while (index < expression.length) {
        const next = expression[index];
        token += next;
        index += 1;
        if (next === quote) {
          if (expression[index] === quote) { token += expression[index]; index += 1; }
          else break;
        }
      }
      tokens.push({ value: token, quoted: true });
      continue;
    }
    const word = expression.slice(index).match(/^[A-Za-z_][A-Za-z0-9_$]*|^\d+(?:\.\d+)?/);
    if (word) {
      tokens.push({ value: word[0].toLowerCase(), quoted: false });
      index += word[0].length;
      continue;
    }
    const operator = expression.slice(index).match(/^(?:::|!~\*|!~|~\*|<=|>=|<>|!=|=|<|>|~)/);
    if (operator) {
      tokens.push({ value: operator[0], quoted: false });
      index += operator[0].length;
      continue;
    }
    tokens.push({ value: character, quoted: false });
    index += 1;
  }

  let output = '';
  let previous = null;
  for (const token of tokens) {
    const value = token.value;
    const upper = token.quoted ? '' : value.toUpperCase();
    if (upper === 'AND' || upper === 'OR') {
      output = `${output.trimEnd()} ${value} `;
    } else if (['=', '>=', '<=', '<>', '!=', '<', '>', '~', '~*', '!~', '!~*'].includes(value)) {
      output = `${output.trimEnd()}${value}`;
    } else if (value === '::') {
      output = `${output.trimEnd()}::`;
    } else if ([')', ']', ','].includes(value)) {
      output = `${output.trimEnd()}${value}`;
    } else if (['(', '['].includes(value)) {
      output = `${output.trimEnd()}${value}`;
    } else {
      const previousValue = previous && previous.value;
      const needsSpace = Boolean(previous) &&
        !['(', '[', ',', '::'].includes(previousValue) &&
        !['::'].includes(value) &&
        !['=', '>=', '<=', '<>', '!=', '<', '>', '~', '~*', '!~', '!~*'].includes(previousValue);
      output += `${needsSpace && !output.endsWith(' ') ? ' ' : ''}${value}`;
    }
    previous = token;
  }
  return output.trim();
}

function topLevelTokens(expression) {
  const tokens = [];
  let depth = 0;
  let quote = null;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (quote) {
      if (character === quote && expression[index + 1] === quote) index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === '(' || character === '[') { depth += 1; continue; }
    if (character === ')' || character === ']') { depth -= 1; continue; }
    if (depth !== 0) continue;
    const rest = expression.slice(index);
    const keyword = rest.match(/^(AND|OR|IS|IN|LIKE|ILIKE|BETWEEN)\b/i);
    const operator = rest.match(/^(?:!~\*|!~|~\*|~|<=|>=|<>|!=|=|<|>)/);
    if (keyword) {
      tokens.push(keyword[1].toUpperCase());
      index += keyword[0].length - 1;
    } else if (operator) {
      tokens.push('PREDICATE');
      index += operator[0].length - 1;
    }
  }
  return tokens;
}

function hasTopLevelBooleanOperator(expression) {
  return topLevelTokens(expression).some((token) => token === 'AND' || token === 'OR');
}

function hasTopLevelPredicateOperator(expression) {
  return topLevelTokens(expression).some((token) =>
    token === 'PREDICATE' || token === 'IS' || token === 'IN' || token === 'LIKE' || token === 'ILIKE' || token === 'BETWEEN');
}

function expectedSchema({
  includeApplicantAuth = true,
  includeRegularTrack = true,
  includeEmailOutbox = includeRegularTrack,
  includePaymentFailed = includeEmailOutbox,
  includeSmsConsent = includeEmailOutbox,
  includeSmsOutbox = includeSmsConsent,
  includeApplicantReceipts = includeSmsOutbox,
  includeReceiptResend = includeApplicantReceipts,
  includeSmsConsentRetention = includeSmsConsent && includeSmsOutbox && includeApplicantReceipts,
  includeApplicantRegistrationSelection = includeRegularTrack,
  includeMigrationHistory = false
} = {}) {
  const columns = {
    digital_forensics_registrations: {
      registration_id: ['text', true, null], full_name: ['text', true, null], email: ['text', true, null],
      phone: ['text', true, "''::text"], course: ['text', true, "'digital_forensics'::text"], status: ['text', true, null],
      pricing_option: ['text', false, null], expected_amount: ['numeric(12,2)', true, null],
      expected_currency: ['text', true, null], payment_reference: ['text', false, null],
      verified_transaction_id: ['text', false, null], payment_verification_timestamp: ['timestamp with time zone', false, null],
      email_notification_status: ['text', true, "'pending'::text"], sms_notification_status: ['text', true, "'pending'::text"],
      created_at: ['timestamp with time zone', true, 'CURRENT_TIMESTAMP'], updated_at: ['timestamp with time zone', true, 'CURRENT_TIMESTAMP']
    },
    applicant_magic_link_tokens: {
      token_hash: ['text', true, null], registration_id: ['text', true, null], expires_at: ['timestamp with time zone', true, null],
      used_at: ['timestamp with time zone', false, null], created_at: ['timestamp with time zone', true, 'CURRENT_TIMESTAMP']
    },
    applicant_sessions: {
      session_token_hash: ['text', true, null], registration_id: ['text', true, null], expires_at: ['timestamp with time zone', true, null],
      revoked_at: ['timestamp with time zone', false, null], created_at: ['timestamp with time zone', true, 'CURRENT_TIMESTAMP']
    },
    applicant_login_rate_limits: {
      scope: ['text', true, null], key_hash: ['text', true, null], window_started_at: ['timestamp with time zone', true, null],
      request_count: ['integer', true, null]
    },
    schema_migrations: {
      filename: ['text', true, null],
      checksum: ['text', true, null],
      applied_at: ['timestamp with time zone', true, 'CURRENT_TIMESTAMP']
    },
    regular_track_applicants: {
      registration_id: ['text', true, null], full_name: ['text', true, null], email: ['text', true, null],
      phone: ['text', true, "''::text"], track: ['text', true, null], status: ['text', true, null],
      created_at: ['timestamp with time zone', true, 'CURRENT_TIMESTAMP'], updated_at: ['timestamp with time zone', true, 'CURRENT_TIMESTAMP']
    },
    regular_track_payment_attempts: {
      payment_reference: ['text', true, null], registration_id: ['text', true, null],
      reference_amount: ['numeric(12,2)', true, null], reference_currency: ['text', true, null],
      expected_amount: ['integer', true, null], expected_currency: ['text', true, null],
      status: ['text', true, null], verified_transaction_id: ['text', false, null],
      payment_verification_timestamp: ['timestamp with time zone', false, null],
      created_at: ['timestamp with time zone', true, 'CURRENT_TIMESTAMP'], updated_at: ['timestamp with time zone', true, 'CURRENT_TIMESTAMP']
    },
    email_notification_outbox: {
      event_id: ['uuid', true, 'gen_random_uuid()'], event_key: ['text', true, null],
      event_type: ['text', true, null], regular_track_registration_id: ['text', false, null],
      digital_forensics_registration_id: ['text', false, null], recipient_email: ['text', true, null],
      template_data: ['jsonb', true, null], status: ['text', true, "'pending'::text"],
      attempt_count: ['integer', true, '0'], next_attempt_at: ['timestamp with time zone', true, 'CURRENT_TIMESTAMP'],
      lease_expires_at: ['timestamp with time zone', false, null], claim_token: ['uuid', false, null],
      last_error_code: ['text', false, null], created_at: ['timestamp with time zone', true, 'CURRENT_TIMESTAMP'],
      updated_at: ['timestamp with time zone', true, 'CURRENT_TIMESTAMP'],
      sent_at: ['timestamp with time zone', false, null]
    },
    sms_consent_events: {
      event_id: ['uuid', true, 'gen_random_uuid()'],
      regular_track_registration_id: ['text', false, null],
      digital_forensics_registration_id: ['text', false, null],
      event_type: ['text', true, null],
      phone_snapshot: ['text', true, null],
      purpose: ['text', true, null],
      policy_version: ['text', true, null],
      source: ['text', true, null],
      occurred_at: ['timestamp with time zone', true, 'CURRENT_TIMESTAMP']
    },
    sms_current_consent: {
      regular_track_registration_id: ['text', false, null],
      digital_forensics_registration_id: ['text', false, null],
      phone_snapshot: ['text', true, null]
    },
    sms_notification_outbox: {
      event_id: ['uuid', true, 'gen_random_uuid()'],
      event_key: ['text', true, null],
      event_type: ['text', true, null],
      regular_track_registration_id: ['text', false, null],
      digital_forensics_registration_id: ['text', false, null],
      phone_snapshot: ['text', true, null],
      template_data: ['jsonb', true, null],
      status: ['text', true, "'pending'::text"],
      attempt_count: ['integer', true, '0'],
      next_attempt_at: ['timestamp with time zone', true, 'CURRENT_TIMESTAMP'],
      lease_expires_at: ['timestamp with time zone', false, null],
      claim_token: ['uuid', false, null],
      provider_message_id: ['text', false, null],
      last_error_code: ['text', false, null],
      created_at: ['timestamp with time zone', true, 'CURRENT_TIMESTAMP'],
      updated_at: ['timestamp with time zone', true, 'CURRENT_TIMESTAMP'],
      sent_at: ['timestamp with time zone', false, null],
      completed_at: ['timestamp with time zone', false, null]
    },
    applicant_payment_receipts: {
      receipt_id: ['uuid', true, 'gen_random_uuid()'],
      registration_id: ['text', true, null],
      receipt_number: ['text', true, null],
      payment_reference: ['text', true, null],
      verified_transaction_id: ['text', true, null],
      applicant_name: ['text', true, null],
      amount: ['numeric(12,2)', true, null],
      currency: ['text', true, null],
      verified_at: ['timestamp with time zone', true, null],
      blob_pathname: ['text', false, null],
      generation_status: ['text', true, "'pending'::text"],
      generation_token: ['uuid', false, null],
      lease_expires_at: ['timestamp with time zone', false, null],
      pdf_sha256: ['text', false, null],
      created_at: ['timestamp with time zone', true, 'CURRENT_TIMESTAMP'],
      updated_at: ['timestamp with time zone', true, 'CURRENT_TIMESTAMP']
    }
  };
  if (includeApplicantRegistrationSelection) {
    columns.applicant_magic_link_tokens.registration_id = ['text', false, null];
    columns.applicant_magic_link_tokens.regular_track_registration_id = ['text', false, null];
    columns.applicant_sessions.registration_id = ['text', false, null];
    columns.applicant_sessions.regular_track_registration_id = ['text', false, null];
    columns.applicant_sessions.verification_registration_id = ['text', false, null];
    columns.applicant_sessions.verification_regular_track_registration_id = ['text', false, null];
  }
  const constraint = (table, type, columnsList, definition = null, references = null) => ({
    table, type, columns: columnsList, definition: definition === null ? null : normalizeConstraintDefinition(definition),
    references, validated: true, deferrable: false, deferred: false,
   noInherit: type !== 'c', nullsNotDistinct: false
  });
  const constraints = [
    constraint('digital_forensics_registrations', 'p', ['registration_id']),
    constraint('digital_forensics_registrations', 'u', ['payment_reference']),
    constraint('digital_forensics_registrations', 'u', ['verified_transaction_id']),
    constraint('digital_forensics_registrations', 'c', [], 'CHECK ((char_length(full_name) >= 1) AND (char_length(full_name) <= 120))'),
    constraint('digital_forensics_registrations', 'c', [], 'CHECK ((email = lower(email)))'),
    constraint('digital_forensics_registrations', 'c', [], "CHECK ((course = 'digital_forensics'::text))"),
    constraint('digital_forensics_registrations', 'c', [], `CHECK ((status = ANY (ARRAY['pending'::text, 'payment_initiated'::text, 'payment_verified'::text, 'paid'::text${includePaymentFailed ? ", 'payment_failed'::text" : ''}])))`),
    constraint('digital_forensics_registrations', 'c', [], "CHECK (((pricing_option IS NULL) OR (pricing_option = ANY (ARRAY['GHS'::text, 'USD_REFERENCE'::text]))))"),
    constraint('digital_forensics_registrations', 'c', [], 'CHECK ((expected_amount > (0)::numeric))'),
    constraint('digital_forensics_registrations', 'c', [], "CHECK ((expected_currency = 'GHS'::text))"),
    constraint('digital_forensics_registrations', 'c', [], "CHECK ((email_notification_status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text])))"),
    constraint('digital_forensics_registrations', 'c', [], "CHECK ((sms_notification_status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text])))"),
    constraint('applicant_magic_link_tokens', 'p', ['token_hash']),
    constraint('applicant_magic_link_tokens', 'f', ['registration_id'], null, { table: 'digital_forensics_registrations', columns: ['registration_id'], deleteAction: 'c', updateAction: 'a', matchType: 's' }),
    ...(includeApplicantRegistrationSelection ? [
      constraint('applicant_magic_link_tokens', 'f', ['regular_track_registration_id'], null, { table: 'regular_track_applicants', columns: ['registration_id'], deleteAction: 'c', updateAction: 'a', matchType: 's' }),
      constraint('applicant_magic_link_tokens', 'c', [], "CHECK (registration_id IS NOT NULL AND regular_track_registration_id IS NULL OR registration_id IS NULL AND regular_track_registration_id IS NOT NULL)")
    ] : []),
    constraint('applicant_magic_link_tokens', 'c', [], "CHECK ((token_hash ~ '^[a-f0-9]{64}$'::text))"),
    constraint('applicant_sessions', 'p', ['session_token_hash']),
    constraint('applicant_sessions', 'f', ['registration_id'], null, { table: 'digital_forensics_registrations', columns: ['registration_id'], deleteAction: 'c', updateAction: 'a', matchType: 's' }),
    ...(includeApplicantRegistrationSelection ? [
      constraint('applicant_sessions', 'f', ['regular_track_registration_id'], null, { table: 'regular_track_applicants', columns: ['registration_id'], deleteAction: 'c', updateAction: 'a', matchType: 's' }),
      constraint('applicant_sessions', 'f', ['verification_registration_id'], null, { table: 'digital_forensics_registrations', columns: ['registration_id'], deleteAction: 'c', updateAction: 'a', matchType: 's' }),
      constraint('applicant_sessions', 'f', ['verification_regular_track_registration_id'], null, { table: 'regular_track_applicants', columns: ['registration_id'], deleteAction: 'c', updateAction: 'a', matchType: 's' }),
      constraint('applicant_sessions', 'c', [], "CHECK (((registration_id IS NULL) OR (regular_track_registration_id IS NULL)))"),
      constraint('applicant_sessions', 'c', [], "CHECK (verification_registration_id IS NOT NULL AND verification_regular_track_registration_id IS NULL OR verification_registration_id IS NULL AND verification_regular_track_registration_id IS NOT NULL OR verification_registration_id IS NULL AND verification_regular_track_registration_id IS NULL AND registration_id IS NOT NULL AND regular_track_registration_id IS NULL)")
    ] : []),
    constraint('applicant_sessions', 'c', [], "CHECK ((session_token_hash ~ '^[a-f0-9]{64}$'::text))"),
    constraint('applicant_login_rate_limits', 'p', ['scope', 'key_hash']),
    constraint('applicant_login_rate_limits', 'c', [], includeReceiptResend
      ? "CHECK ((scope = ANY (ARRAY['email'::text, 'ip'::text, 'receipt_resend_email'::text, 'receipt_resend_ip'::text])))"
      : "CHECK ((scope = ANY (ARRAY['email'::text, 'ip'::text])))"),
    constraint('applicant_login_rate_limits', 'c', [], "CHECK ((key_hash ~ '^[a-f0-9]{64}$'::text))"),
    constraint('applicant_login_rate_limits', 'c', [], 'CHECK ((request_count > 0))'),
    constraint('regular_track_applicants', 'p', ['registration_id']),
    constraint('regular_track_applicants', 'c', [], 'CHECK ((char_length(full_name) >= 1) AND (char_length(full_name) <= 120))'),
    constraint('regular_track_applicants', 'c', [], 'CHECK ((email = lower(email)))'),
    constraint('regular_track_applicants', 'c', [], "CHECK ((track = ANY (ARRAY['incident_response'::text, 'soc_analyst'::text, 'network_security'::text, 'web_app_penetration_testing'::text, 'cloud_security'::text])))"),
    constraint('regular_track_applicants', 'c', [], "CHECK ((status = ANY (ARRAY['pending'::text, 'payment_initiated'::text, 'payment_verified'::text])))"),
    constraint('regular_track_payment_attempts', 'p', ['payment_reference']),
    constraint('regular_track_payment_attempts', 'f', ['registration_id'], null, { table: 'regular_track_applicants', columns: ['registration_id'], deleteAction: 'c', updateAction: 'a', matchType: 's' }),
    constraint('regular_track_payment_attempts', 'u', ['verified_transaction_id']),
    constraint('regular_track_payment_attempts', 'c', [], 'CHECK ((reference_amount > (0)::numeric))'),
    constraint('regular_track_payment_attempts', 'c', [], "CHECK ((reference_currency = 'USD'::text))"),
    constraint('regular_track_payment_attempts', 'c', [], 'CHECK ((expected_amount > 0))'),
    constraint('regular_track_payment_attempts', 'c', [], "CHECK ((expected_currency = 'GHS'::text))"),
    constraint('regular_track_payment_attempts', 'c', [], "CHECK ((status = ANY (ARRAY['initializing'::text, 'payment_initiated'::text, 'payment_verified'::text, 'failed'::text, 'initialization_failed'::text])))"),
    constraint('email_notification_outbox', 'p', ['event_id']),
    constraint('email_notification_outbox', 'u', ['event_key']),
    constraint('email_notification_outbox', 'f', ['regular_track_registration_id'], null, { table: 'regular_track_applicants', columns: ['registration_id'], deleteAction: 'c', updateAction: 'a', matchType: 's' }),
    constraint('email_notification_outbox', 'f', ['digital_forensics_registration_id'], null, { table: 'digital_forensics_registrations', columns: ['registration_id'], deleteAction: 'c', updateAction: 'a', matchType: 's' }),
    constraint('email_notification_outbox', 'c', [], includeReceiptResend
      ? "CHECK ((event_type = ANY (ARRAY['regular_track_registration_confirmation'::text, 'digital_forensics_registration_confirmation'::text, 'regular_track_payment_success'::text, 'digital_forensics_payment_success'::text, 'regular_track_payment_failure'::text, 'digital_forensics_payment_failure'::text, 'digital_forensics_receipt_resend'::text])))"
      : "CHECK ((event_type = ANY (ARRAY['regular_track_registration_confirmation'::text, 'digital_forensics_registration_confirmation'::text, 'regular_track_payment_success'::text, 'digital_forensics_payment_success'::text, 'regular_track_payment_failure'::text, 'digital_forensics_payment_failure'::text])))"),
    constraint('email_notification_outbox', 'c', [], "CHECK ((recipient_email = lower(recipient_email)))"),
    constraint('email_notification_outbox', 'c', [], "CHECK ((jsonb_typeof(template_data) = 'object'::text))"),
    constraint('email_notification_outbox', 'c', [], "CHECK ((status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'permanent_failed'::text])))"),
    constraint('email_notification_outbox', 'c', [], 'CHECK ((attempt_count >= 0))'),
    constraint('email_notification_outbox', 'c', [], "CHECK (((last_error_code IS NULL) OR (last_error_code = ANY (ARRAY['configuration_missing'::text, 'resend_rejected'::text, 'resend_rate_limited'::text, 'resend_server_error'::text, 'network_error'::text, 'timeout'::text, 'invalid_response'::text, 'invalid_template_data'::text, 'delivery_error'::text, 'max_attempts'::text]))))"),
    constraint('email_notification_outbox', 'c', [], includeReceiptResend
      ? "CHECK (event_type = ANY (ARRAY['regular_track_registration_confirmation'::text, 'regular_track_payment_success'::text, 'regular_track_payment_failure'::text]) AND regular_track_registration_id IS NOT NULL AND digital_forensics_registration_id IS NULL OR event_type = ANY (ARRAY['digital_forensics_registration_confirmation'::text, 'digital_forensics_payment_success'::text, 'digital_forensics_payment_failure'::text, 'digital_forensics_receipt_resend'::text]) AND digital_forensics_registration_id IS NOT NULL AND regular_track_registration_id IS NULL)"
      : "CHECK (event_type = ANY (ARRAY['regular_track_registration_confirmation'::text, 'regular_track_payment_success'::text, 'regular_track_payment_failure'::text]) AND regular_track_registration_id IS NOT NULL AND digital_forensics_registration_id IS NULL OR event_type = ANY (ARRAY['digital_forensics_registration_confirmation'::text, 'digital_forensics_payment_success'::text, 'digital_forensics_payment_failure'::text]) AND digital_forensics_registration_id IS NOT NULL AND regular_track_registration_id IS NULL)"),
    constraint('email_notification_outbox', 'c', [], "CHECK (status = 'sending'::text AND lease_expires_at IS NOT NULL AND claim_token IS NOT NULL OR status <> 'sending'::text AND lease_expires_at IS NULL AND claim_token IS NULL)"),
    constraint('email_notification_outbox', 'c', [], "CHECK (status = 'sent'::text AND sent_at IS NOT NULL OR status <> 'sent'::text AND sent_at IS NULL)"),
    constraint('sms_consent_events', 'p', ['event_id']),
    constraint('sms_consent_events', 'f', ['regular_track_registration_id'], null, { table: 'regular_track_applicants', columns: ['registration_id'], deleteAction: 'r', updateAction: 'a', matchType: 's' }),
    constraint('sms_consent_events', 'f', ['digital_forensics_registration_id'], null, { table: 'digital_forensics_registrations', columns: ['registration_id'], deleteAction: 'r', updateAction: 'a', matchType: 's' }),
    constraint('sms_consent_events', 'c', [], "CHECK ((event_type = ANY (ARRAY['grant'::text, 'withdrawal'::text])))"),
    constraint('sms_consent_events', 'c', [], "CHECK ((phone_snapshot ~ '^\\+[1-9][0-9]{1,14}$'::text))"),
    constraint('sms_consent_events', 'c', [], "CHECK ((purpose = 'SMS notifications confirming successful payment for a Cybanext programme.'::text))"),
    constraint('sms_consent_events', 'c', [], 'CHECK ((char_length(policy_version) >= 1) AND (char_length(policy_version) <= 80))'),
    constraint('sms_consent_events', 'c', [], "CHECK ((source = ANY (ARRAY['main_application'::text, 'digital_forensics_standalone'::text])))"),
    constraint('sms_consent_events', 'c', [], "CHECK (regular_track_registration_id IS NOT NULL AND digital_forensics_registration_id IS NULL OR regular_track_registration_id IS NULL AND digital_forensics_registration_id IS NOT NULL)"),
    ...(includeSmsConsentRetention ? [
      constraint('sms_current_consent', 'f', ['regular_track_registration_id'], null, { table: 'regular_track_applicants', columns: ['registration_id'], deleteAction: 'r', updateAction: 'a', matchType: 's' }),
      constraint('sms_current_consent', 'f', ['digital_forensics_registration_id'], null, { table: 'digital_forensics_registrations', columns: ['registration_id'], deleteAction: 'r', updateAction: 'a', matchType: 's' }),
      constraint('sms_current_consent', 'c', [], "CHECK ((phone_snapshot ~ '^\\+233[0-9]{9}$'::text))"),
      constraint('sms_current_consent', 'c', [], "CHECK (regular_track_registration_id IS NOT NULL AND digital_forensics_registration_id IS NULL OR regular_track_registration_id IS NULL AND digital_forensics_registration_id IS NOT NULL)")
    ] : []),
    constraint('sms_notification_outbox', 'p', ['event_id']),
    constraint('sms_notification_outbox', 'u', ['event_key']),
    constraint('sms_notification_outbox', 'f', ['regular_track_registration_id'], null, { table: 'regular_track_applicants', columns: ['registration_id'], deleteAction: 'r', updateAction: 'a', matchType: 's' }),
    constraint('sms_notification_outbox', 'f', ['digital_forensics_registration_id'], null, { table: 'digital_forensics_registrations', columns: ['registration_id'], deleteAction: 'r', updateAction: 'a', matchType: 's' }),
    constraint('sms_notification_outbox', 'c', [], 'CHECK ((char_length(event_key) >= 1) AND (char_length(event_key) <= 256))'),
    constraint('sms_notification_outbox', 'c', [], "CHECK ((event_type = 'sms_payment_success'::text))"),
    constraint('sms_notification_outbox', 'c', [], "CHECK ((phone_snapshot ~ '^\\+233[0-9]{9}$'::text))"),
    constraint('sms_notification_outbox', 'c', [], "CHECK ((jsonb_typeof(template_data) = 'object'::text))"),
    constraint('sms_notification_outbox', 'c', [], "CHECK ((status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'permanent_failed'::text, 'cancelled'::text])))"),
    constraint('sms_notification_outbox', 'c', [], 'CHECK ((attempt_count >= 0))'),
    constraint('sms_notification_outbox', 'c', [], "CHECK (last_error_code IS NULL OR char_length(last_error_code) >= 1 AND char_length(last_error_code) <= 80)"),
    constraint('sms_notification_outbox', 'c', [], "CHECK (regular_track_registration_id IS NOT NULL AND digital_forensics_registration_id IS NULL OR regular_track_registration_id IS NULL AND digital_forensics_registration_id IS NOT NULL)"),
    constraint('sms_notification_outbox', 'c', [], "CHECK (status = 'sending'::text AND lease_expires_at IS NOT NULL AND claim_token IS NOT NULL OR status <> 'sending'::text AND lease_expires_at IS NULL AND claim_token IS NULL)"),
    constraint('sms_notification_outbox', 'c', [], "CHECK (status = 'sent'::text AND sent_at IS NOT NULL OR status <> 'sent'::text AND sent_at IS NULL)"),
    constraint('sms_notification_outbox', 'c', [], "CHECK (status = ANY (ARRAY['sent'::text, 'permanent_failed'::text, 'cancelled'::text]) AND completed_at IS NOT NULL OR status = ANY (ARRAY['pending'::text, 'sending'::text]) AND completed_at IS NULL)"),
    constraint('applicant_payment_receipts', 'p', ['receipt_id']),
    constraint('applicant_payment_receipts', 'f', ['registration_id'], null, {
      table: 'digital_forensics_registrations',
      columns: ['registration_id'],
      deleteAction: 'r',
      updateAction: 'a',
      matchType: 's'
    }),
    constraint('applicant_payment_receipts', 'u', ['registration_id']),
    constraint('applicant_payment_receipts', 'u', ['receipt_number']),
    constraint('applicant_payment_receipts', 'u', ['payment_reference']),
    constraint('applicant_payment_receipts', 'u', ['verified_transaction_id']),
    constraint('applicant_payment_receipts', 'u', ['blob_pathname']),
    constraint('applicant_payment_receipts', 'c', [], 'CHECK ((amount > (0)::numeric))'),
    constraint('applicant_payment_receipts', 'c', [], "CHECK ((currency = 'GHS'::text))"),
    constraint('applicant_payment_receipts', 'c', [], "CHECK ((generation_status = ANY (ARRAY['pending'::text, 'generating'::text, 'ready'::text])))"),
    constraint('schema_migrations', 'p', ['filename']),
    constraint('schema_migrations', 'c', [], "CHECK ((checksum ~ '^[a-f0-9]{64}$'::text))")
  ];

  const indexes = [
    ['schema_migrations_pkey', 'schema_migrations', ['filename'], true, true, null],
    ['digital_forensics_registrations_pkey', 'digital_forensics_registrations', ['registration_id'], true, true, null],
    ['digital_forensics_registrations_payment_reference_key', 'digital_forensics_registrations', ['payment_reference'], true, false, null],
    ['digital_forensics_registrations_verified_transaction_id_key', 'digital_forensics_registrations', ['verified_transaction_id'], true, false, null],
    ['digital_forensics_registrations_email_idx', 'digital_forensics_registrations', ['email'], false, false, null],
    ['digital_forensics_registrations_status_idx', 'digital_forensics_registrations', ['status'], false, false, null],
    ['applicant_magic_link_tokens_pkey', 'applicant_magic_link_tokens', ['token_hash'], true, true, null],
    ['applicant_magic_link_tokens_expiry_idx', 'applicant_magic_link_tokens', ['expires_at'], false, false, '(used_at IS NULL)'],
    ...(includeApplicantRegistrationSelection ? [
      ['applicant_magic_link_tokens_registration_idx', 'applicant_magic_link_tokens', ['registration_id'], false, false, null],
      ['applicant_magic_link_tokens_regular_track_registration_idx', 'applicant_magic_link_tokens', ['regular_track_registration_id'], false, false, null]
    ] : []),
    ['applicant_sessions_pkey', 'applicant_sessions', ['session_token_hash'], true, true, null],
    ['applicant_sessions_registration_idx', 'applicant_sessions', ['registration_id'], false, false, null],
    ...(includeApplicantRegistrationSelection ? [
      ['applicant_sessions_regular_track_registration_idx', 'applicant_sessions', ['regular_track_registration_id'], false, false, null],
      ['applicant_sessions_verification_registration_idx', 'applicant_sessions', ['verification_registration_id'], false, false, null],
      ['applicant_sessions_verification_regular_track_registration_idx', 'applicant_sessions', ['verification_regular_track_registration_id'], false, false, null]
    ] : []),
    ['applicant_sessions_expiry_idx', 'applicant_sessions', ['expires_at'], false, false, '(revoked_at IS NULL)'],
    ['applicant_login_rate_limits_pkey', 'applicant_login_rate_limits', ['scope', 'key_hash'], true, true, null],
    ['regular_track_applicants_pkey', 'regular_track_applicants', ['registration_id'], true, true, null],
    ['regular_track_applicants_email_idx', 'regular_track_applicants', ['email'], false, false, null],
    ['regular_track_applicants_track_idx', 'regular_track_applicants', ['track'], false, false, null],
    ['regular_track_payment_attempts_pkey', 'regular_track_payment_attempts', ['payment_reference'], true, true, null],
    ['regular_track_payment_attempts_verified_transaction_id_key', 'regular_track_payment_attempts', ['verified_transaction_id'], true, false, null],
    ['regular_track_payment_attempts_registration_idx', 'regular_track_payment_attempts', ['registration_id'], false, false, null],
    ['email_notification_outbox_pkey', 'email_notification_outbox', ['event_id'], true, true, null],
    ['email_notification_outbox_event_key_key', 'email_notification_outbox', ['event_key'], true, false, null],
    ['email_notification_outbox_regular_registration_idx', 'email_notification_outbox', ['regular_track_registration_id'], false, false, null],
    ['email_notification_outbox_digital_registration_idx', 'email_notification_outbox', ['digital_forensics_registration_id'], false, false, null],
    ['email_notification_outbox_pending_due_idx', 'email_notification_outbox', ['next_attempt_at', 'created_at'], false, false, "(status = 'pending'::text)"],
    ['email_notification_outbox_lease_expiry_idx', 'email_notification_outbox', ['lease_expires_at'], false, false, "(status = 'sending'::text)"],
    ['sms_consent_events_pkey', 'sms_consent_events', ['event_id'], true, true, null],
    ['sms_consent_events_regular_registration_idx', 'sms_consent_events', ['regular_track_registration_id', 'occurred_at'], false, false, null],
    ['sms_consent_events_digital_registration_idx', 'sms_consent_events', ['digital_forensics_registration_id', 'occurred_at'], false, false, null],
    ...(includeSmsConsentRetention ? [
      ['sms_current_consent_regular_registration_key', 'sms_current_consent', ['regular_track_registration_id'], true, false, '(regular_track_registration_id IS NOT NULL)'],
      ['sms_current_consent_digital_registration_key', 'sms_current_consent', ['digital_forensics_registration_id'], true, false, '(digital_forensics_registration_id IS NOT NULL)']
    ] : []),
    ['sms_notification_outbox_pkey', 'sms_notification_outbox', ['event_id'], true, true, null],
    ['sms_notification_outbox_event_key_key', 'sms_notification_outbox', ['event_key'], true, false, null],
    ['sms_notification_outbox_regular_registration_idx', 'sms_notification_outbox', ['regular_track_registration_id'], false, false, null],
    ['sms_notification_outbox_digital_registration_idx', 'sms_notification_outbox', ['digital_forensics_registration_id'], false, false, null],
    ['sms_notification_outbox_pending_due_idx', 'sms_notification_outbox', ['next_attempt_at', 'created_at'], false, false, "(status = 'pending'::text)"],
    ['sms_notification_outbox_lease_expiry_idx', 'sms_notification_outbox', ['lease_expires_at'], false, false, "(status = 'sending'::text)"],
    ['sms_notification_outbox_completed_retention_idx', 'sms_notification_outbox', ['completed_at'], false, false, '(completed_at IS NOT NULL)'],
    ['applicant_payment_receipts_pkey', 'applicant_payment_receipts', ['receipt_id'], true, true, null],
    ['applicant_payment_receipts_registration_id_key', 'applicant_payment_receipts', ['registration_id'], true, false, null],
    ['applicant_payment_receipts_receipt_number_key', 'applicant_payment_receipts', ['receipt_number'], true, false, null],
    ['applicant_payment_receipts_payment_reference_key', 'applicant_payment_receipts', ['payment_reference'], true, false, null],
    ['applicant_payment_receipts_verified_transaction_id_key', 'applicant_payment_receipts', ['verified_transaction_id'], true, false, null],
    ['applicant_payment_receipts_blob_pathname_key', 'applicant_payment_receipts', ['blob_pathname'], true, false, null]
  ].map(([name, table, columnsList, unique, primary, predicate]) => ({
    name, table, columns: columnsList, unique, primary, method: 'btree', predicate: predicate && normalizePredicate(predicate),
    valid: true, ready: true, live: true, nullsNotDistinct: false
  }));
  if (!includeApplicantAuth) {
    delete columns.applicant_magic_link_tokens;
    delete columns.applicant_sessions;
    delete columns.applicant_login_rate_limits;
  }
  if (!includeMigrationHistory) delete columns.schema_migrations;
  if (!includeRegularTrack) {
    delete columns.regular_track_applicants;
    delete columns.regular_track_payment_attempts;
  }
  if (!includeEmailOutbox) {
    delete columns.email_notification_outbox;
  }
  if (!includeSmsConsent) {
    delete columns.sms_consent_events;
  }
  if (!includeSmsOutbox) {
    delete columns.sms_notification_outbox;
  }
  if (!includeSmsConsentRetention) {
    delete columns.sms_current_consent;
  }
  if (!includeApplicantReceipts) {
    delete columns.applicant_payment_receipts;
  }
  const relevantTables = new Set(Object.keys(columns));
  const filteredConstraints = constraints.filter((item) =>
    relevantTables.has(item.table) &&
    (includePaymentFailed || item.table !== 'digital_forensics_registrations' ||
      item.type !== 'c' || !item.definition.includes("'payment_failed'")));
  const filteredIndexes = indexes.filter((item) =>
    relevantTables.has(item.table));
  const triggers = [
    ...(includeSmsConsent ? [{
      table: 'sms_consent_events',
      name: 'sms_consent_events_append_only',
      enabled: 'O',
      definition: 'CREATE TRIGGER sms_consent_events_append_only BEFORE DELETE OR UPDATE ON sms_consent_events FOR EACH ROW EXECUTE FUNCTION prevent_sms_consent_event_mutation()',
      functionName: 'prevent_sms_consent_event_mutation',
      functionSource: includeSmsConsentRetention
        ? `BEGIN
  IF TG_OP = 'DELETE'
     AND current_user = 'cybanext_sms_consent_retention_owner'
     AND OLD.occurred_at <= pg_catalog.clock_timestamp() - INTERVAL '90 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'SMS consent history is append-only except for authorized retention cleanup'
    USING ERRCODE = '55000';
END`
        : "BEGIN\n  RAISE EXCEPTION 'SMS consent history is append-only' USING ERRCODE = '55000';\nEND"
    }] : []),
    ...(includeSmsConsentRetention ? [{
      table: 'sms_current_consent',
      name: 'sms_current_consent_append_only',
      enabled: 'O',
      definition: 'CREATE TRIGGER sms_current_consent_append_only BEFORE DELETE OR UPDATE ON sms_current_consent FOR EACH ROW EXECUTE FUNCTION prevent_sms_current_consent_mutation()',
      functionName: 'prevent_sms_current_consent_mutation',
      functionSource: `BEGIN
  RAISE EXCEPTION 'Current SMS consent state cannot be changed directly'
    USING ERRCODE = '55000';
END`
    }, {
      table: 'sms_consent_events',
      name: 'sms_consent_events_no_truncate',
      enabled: 'O',
      definition: 'CREATE TRIGGER sms_consent_events_no_truncate BEFORE TRUNCATE ON sms_consent_events FOR EACH STATEMENT EXECUTE FUNCTION prevent_sms_consent_truncate()',
      functionName: 'prevent_sms_consent_truncate',
      functionSource: `BEGIN
  RAISE EXCEPTION '% cannot be truncated', TG_TABLE_NAME
    USING ERRCODE = '55000';
END`
    }, {
      table: 'sms_current_consent',
      name: 'sms_current_consent_no_truncate',
      enabled: 'O',
      definition: 'CREATE TRIGGER sms_current_consent_no_truncate BEFORE TRUNCATE ON sms_current_consent FOR EACH STATEMENT EXECUTE FUNCTION prevent_sms_consent_truncate()',
      functionName: 'prevent_sms_consent_truncate',
      functionSource: `BEGIN
  RAISE EXCEPTION '% cannot be truncated', TG_TABLE_NAME
    USING ERRCODE = '55000';
END`
    }] : []),
    ...(includeSmsOutbox ? [{
      table: 'sms_notification_outbox',
      name: 'sms_notification_outbox_payment_success_guard',
      enabled: 'O',
      definition: 'CREATE TRIGGER sms_notification_outbox_payment_success_guard BEFORE INSERT OR UPDATE ON sms_notification_outbox FOR EACH ROW EXECUTE FUNCTION require_paid_sms_notification_registration()',
      functionName: 'require_paid_sms_notification_registration',
      functionSource: "BEGIN\n  IF NEW.regular_track_registration_id IS NOT NULL THEN\n    IF NOT EXISTS (\n      SELECT 1\n      FROM public.regular_track_applicants\n      WHERE registration_id = NEW.regular_track_registration_id\n        AND status = 'payment_verified'\n    ) THEN\n      RAISE EXCEPTION 'SMS payment notifications require a verified payment'\n        USING ERRCODE = '23514';\n    END IF;\n  ELSIF NOT EXISTS (\n    SELECT 1\n    FROM public.digital_forensics_registrations\n    WHERE registration_id = NEW.digital_forensics_registration_id\n      AND status = 'payment_verified'\n  ) THEN\n    RAISE EXCEPTION 'SMS payment notifications require a verified payment'\n      USING ERRCODE = '23514';\n  END IF;\n  RETURN NEW;\nEND"
    }, {
      table: 'sms_notification_outbox',
      name: 'sms_notification_outbox_retention_guard',
      enabled: 'O',
      definition: 'CREATE TRIGGER sms_notification_outbox_retention_guard BEFORE DELETE ON sms_notification_outbox FOR EACH ROW EXECUTE FUNCTION prevent_early_sms_notification_outbox_deletion()',
      functionName: 'prevent_early_sms_notification_outbox_deletion',
      functionSource: "BEGIN\n  IF OLD.status NOT IN ('sent', 'permanent_failed', 'cancelled')\n    OR OLD.completed_at IS NULL\n    OR OLD.completed_at > clock_timestamp() - INTERVAL '90 days'\n  THEN\n    RAISE EXCEPTION 'SMS notification records cannot be deleted before the retention period'\n      USING ERRCODE = '55000';\n  END IF;\n  RETURN OLD;\nEND"
    }, {
      table: 'sms_notification_outbox',
      name: 'sms_notification_outbox_completion_timestamp',
      enabled: 'O',
      definition: 'CREATE TRIGGER sms_notification_outbox_completion_timestamp BEFORE INSERT OR UPDATE ON sms_notification_outbox FOR EACH ROW EXECUTE FUNCTION set_sms_notification_outbox_completion_timestamp()',
      functionName: 'set_sms_notification_outbox_completion_timestamp',
      functionSource: `BEGIN
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
END`
    }, {
      table: 'sms_notification_outbox',
      name: 'sms_notification_outbox_no_truncate',
      enabled: 'O',
      definition: 'CREATE TRIGGER sms_notification_outbox_no_truncate BEFORE TRUNCATE ON sms_notification_outbox FOR EACH STATEMENT EXECUTE FUNCTION prevent_sms_notification_outbox_truncate()',
      functionName: 'prevent_sms_notification_outbox_truncate',
      functionSource: `BEGIN
  RAISE EXCEPTION 'SMS notification records cannot be truncated'
    USING ERRCODE = '55000';
  RETURN NULL;
END`
    }] : [])
  ];
  const functions = [
    ...(includeSmsOutbox ? [{
    name: 'require_paid_sms_notification_registration',
    identityArguments: '',
    returnType: 'trigger',
    language: 'plpgsql',
    securityDefiner: false,
    publicExecute: false,
    otherPrivileges: [],
    source: `BEGIN
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
END`
  }, {
    name: 'set_sms_notification_outbox_completion_timestamp',
    identityArguments: '',
    returnType: 'trigger',
    language: 'plpgsql',
    securityDefiner: false,
    publicExecute: false,
    otherPrivileges: [],
    source: `BEGIN
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
END`
  }, {
    name: 'prevent_early_sms_notification_outbox_deletion',
    identityArguments: '',
    returnType: 'trigger',
    language: 'plpgsql',
    securityDefiner: false,
    publicExecute: false,
    otherPrivileges: [],
    source: `BEGIN
  IF OLD.status NOT IN ('sent', 'permanent_failed', 'cancelled')
    OR OLD.completed_at IS NULL
    OR OLD.completed_at > clock_timestamp() - INTERVAL '90 days'
  THEN
    RAISE EXCEPTION 'SMS notification records cannot be deleted before the retention period'
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END`
  }, {
    name: 'prevent_sms_notification_outbox_truncate',
    identityArguments: '',
    returnType: 'trigger',
    language: 'plpgsql',
    securityDefiner: false,
    publicExecute: false,
    otherPrivileges: [],
    source: `BEGIN
  RAISE EXCEPTION 'SMS notification records cannot be truncated'
    USING ERRCODE = '55000';
  RETURN NULL;
END`
  }, {
    name: 'purge_expired_sms_notification_outbox',
    identityArguments: '',
    returnType: 'integer',
    language: 'plpgsql',
    securityDefiner: false,
    publicExecute: false,
    otherPrivileges: [],
    source: `DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM public.sms_notification_outbox
  WHERE status IN ('sent', 'permanent_failed', 'cancelled')
    AND completed_at <= clock_timestamp() - INTERVAL '90 days';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END`
    }] : []),
    ...(includeSmsConsentRetention ? [{
      name: 'prevent_sms_consent_event_mutation',
      identityArguments: '',
      returnType: 'trigger',
      language: 'plpgsql',
      securityDefiner: false,
      publicExecute: false,
      otherPrivileges: [],
      source: `BEGIN
  IF TG_OP = 'DELETE'
     AND current_user = 'cybanext_sms_consent_retention_owner'
     AND OLD.occurred_at <= pg_catalog.clock_timestamp() - INTERVAL '90 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'SMS consent history is append-only except for authorized retention cleanup'
    USING ERRCODE = '55000';
END`
    }, {
      name: 'prevent_sms_current_consent_mutation',
      identityArguments: '',
      returnType: 'trigger',
      language: 'plpgsql',
      securityDefiner: false,
      publicExecute: false,
      otherPrivileges: [],
      source: `BEGIN
  RAISE EXCEPTION 'Current SMS consent state cannot be changed directly'
    USING ERRCODE = '55000';
END`
    }, {
      name: 'prevent_sms_consent_truncate',
      identityArguments: '',
      returnType: 'trigger',
      language: 'plpgsql',
      securityDefiner: false,
      publicExecute: false,
      otherPrivileges: [],
      source: `BEGIN
  RAISE EXCEPTION '% cannot be truncated', TG_TABLE_NAME
    USING ERRCODE = '55000';
END`
    }, {
      name: 'purge_expired_sms_consent_events',
      identityArguments: '',
      returnType: 'integer',
      language: 'plpgsql',
      securityDefiner: true,
      publicExecute: false,
      otherPrivileges: ['cybanext_sms_consent_retention_operator:EXECUTE:false'],
      ownerRole: 'cybanext_sms_consent_retention_owner',
      configuration: ['search_path=pg_catalog'],
      source: `DECLARE
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
END`
    }, {
      name: 'record_sms_consent',
      identityArguments: 'p_regular_track_registration_id text, p_digital_forensics_registration_id text, p_phone_snapshot text, p_policy_version text, p_source text',
      returnType: 'boolean',
      language: 'plpgsql',
      securityDefiner: true,
      publicExecute: false,
      otherPrivileges: ['cybanext_sms_consent_application:EXECUTE:false'],
      ownerRole: 'cybanext_sms_consent_retention_owner',
      configuration: ['search_path=pg_catalog'],
      source: `BEGIN
  IF (p_regular_track_registration_id IS NULL) =
     (p_digital_forensics_registration_id IS NULL) THEN
    RAISE EXCEPTION 'SMS consent must identify exactly one registration'
      USING ERRCODE = '23514';
  END IF;

  IF p_phone_snapshot IS NULL OR p_phone_snapshot !~ '^\\+233[0-9]{9}$'
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
END`
    }] : [])
  ];
  const tables = Object.keys(columns).map((name) => ({
    name,
    kind: 'r',
    persistence: 'p',
    rowSecurity: false,
    forceRowSecurity: false,
    ...(includeSmsConsentRetention &&
      ['sms_consent_events', 'sms_current_consent'].includes(name)
      ? { ownerRole: 'cybanext_sms_consent_retention_owner' }
      : {})
  }));
  const roles = includeSmsConsentRetention ? [
    {
      name: 'cybanext_sms_consent_retention_owner',
      canLogin: false, superuser: false, createDb: false, createRole: false,
      inherit: false, replication: false, bypassRls: false
    },
    {
      name: 'cybanext_sms_consent_retention_operator',
      canLogin: false, superuser: false, createDb: false, createRole: false,
      inherit: false, replication: false, bypassRls: false
    },
    {
      name: 'cybanext_sms_consent_application',
      canLogin: false, superuser: false, createDb: false, createRole: false,
      inherit: false, replication: false, bypassRls: false
    }
  ] : [];
  const privileges = includeSmsConsentRetention ? [
    { table: 'regular_track_applicants', column: 'registration_id', grantee: 'cybanext_sms_consent_retention_owner', privilege: 'SELECT', grantable: false },
    { table: 'regular_track_applicants', column: 'phone', grantee: 'cybanext_sms_consent_retention_owner', privilege: 'SELECT', grantable: false },
    { table: 'digital_forensics_registrations', column: 'registration_id', grantee: 'cybanext_sms_consent_retention_owner', privilege: 'SELECT', grantable: false },
    { table: 'digital_forensics_registrations', column: 'phone', grantee: 'cybanext_sms_consent_retention_owner', privilege: 'SELECT', grantable: false },
    { table: 'sms_current_consent', column: null, grantee: 'cybanext_sms_consent_application', privilege: 'SELECT', grantable: false }
  ] : [];
  const schemaPrivileges = includeSmsConsentRetention ? [
    { grantee: 'cybanext_sms_consent_retention_owner', usage: true, create: false },
    { grantee: 'cybanext_sms_consent_retention_operator', usage: true, create: false },
    { grantee: 'cybanext_sms_consent_application', usage: true, create: false }
  ] : [];
  return {
    tables,
    columns,
    constraints: filteredConstraints,
    indexes: filteredIndexes,
    triggers,
    functions,
    roles,
    privileges,
    schemaPrivileges
  };
}

function throwSchemaMismatch(category, expected, actual, testOnly) {
  const error = new Error(`Database schema does not exactly match the migrations (${category}).`);
  error.schemaMismatchCategory = category;
  if (testOnly) error.schemaDiagnostic = { category, expected, actual };
  throw error;
}

function safeSchemaMismatchCategory(error) {
  const categories = [
    'tables and row-level security settings',
    'unexpected public relations',
    'columns',
    'unexpected or missing columns',
    'constraints and relationships',
    'indexes',
    'triggers',
    'functions',
    'roles',
    'schema privileges',
    'row-level security policies',
    'table and column privileges',
    'migration history triggers',
    'migration history row-level security',
    'migration history privileges',
    'migration history records'
  ];
  if (categories.includes(error?.schemaMismatchCategory)) return error.schemaMismatchCategory;
  return categories.find((category) => error?.message?.includes(category)) || null;
}

async function inspectExistingSchema(sql, {
  testOnly = false,
  includeRegularTrack = true,
  includeApplicantAuth = true,
  includeEmailOutbox = includeRegularTrack,
  includePaymentFailed = includeEmailOutbox,
  includeSmsConsent = includeEmailOutbox,
  includeSmsOutbox = includeSmsConsent,
  includeApplicantReceipts = includeSmsOutbox,
  includeReceiptResend = includeApplicantReceipts,
  includeSmsConsentRetention = includeSmsConsent && includeSmsOutbox && includeApplicantReceipts,
  includeApplicantRegistrationSelection = true,
  includeMigrationHistory = false
} = {}) {
  const expected = expectedSchema({
    includeApplicantAuth,
    includeRegularTrack,
    includeEmailOutbox,
    includePaymentFailed,
    includeSmsConsent,
    includeSmsOutbox,
    includeApplicantReceipts,
    includeReceiptResend,
    includeSmsConsentRetention,
    includeApplicantRegistrationSelection,
    includeMigrationHistory
  });
  const expectedTableNames = expected.tables.map((table) => table.name);
  const safeQuery = async (statement) => {
    try { return await sql.query(statement); }
    catch { throw new Error('Could not inspect the existing development schema.'); }
  };
  const tables = await safeQuery(`
    SELECT c.relname AS table_name, c.relkind AS relation_kind, c.relpersistence AS persistence,
           c.relrowsecurity AS row_security, c.relforcerowsecurity AS force_row_security,
           pg_catalog.pg_get_userbyid(c.relowner) AS owner_role
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname IN (${expectedTableNames.map(quoteLiteral).join(', ')})
  `);
  const actualTables = tables.map((row) => JSON.stringify({
    name: row.table_name, kind: row.relation_kind, persistence: row.persistence,
    rowSecurity: row.row_security, forceRowSecurity: row.force_row_security,
    ...(expected.tables.find(({ name }) => name === row.table_name)?.ownerRole
      ? { ownerRole: row.owner_role }
      : {})
  })).sort();
  const expectedTables = expected.tables.map((item) => JSON.stringify(item)).sort();
  if (JSON.stringify(actualTables) !== JSON.stringify(expectedTables)) {
    throwSchemaMismatch('tables and row-level security settings', expected.tables, actualTables.map(JSON.parse), testOnly);
  }

  const columns = await safeQuery(`
    SELECT c.relname AS table_name, a.attname AS column_name,
           pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
           a.attnotnull AS not_null, pg_catalog.pg_get_expr(d.adbin, d.adrelid, true) AS column_default,
           a.attgenerated AS generated, a.attidentity AS identity
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    WHERE n.nspname = 'public' AND c.relname IN (${expectedTableNames.map(quoteLiteral).join(', ')})
      AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
  `);
  const actualColumns = new Map(columns.map((column) => [
    `${column.table_name}.${column.column_name}`,
    [column.data_type.toLowerCase(), column.not_null, column.column_default === null ? null : normalizeDefinition(column.column_default), column.generated || '', column.identity || '']
  ]));
  const expectedColumnKeys = new Set();
  for (const [table, tableColumns] of Object.entries(expected.columns)) {
    for (const [column, [type, notNull, defaultValue]] of Object.entries(tableColumns)) {
      const key = `${table}.${column}`;
      expectedColumnKeys.add(key);
      const actual = actualColumns.get(key);
      const normalizedDefault = defaultValue === null ? null : normalizeDefinition(defaultValue);
      if (!actual || actual[0] !== type || actual[1] !== notNull || actual[2] !== normalizedDefault || actual[3] !== '' || actual[4] !== '') {
        throwSchemaMismatch('columns', { [key]: [type, notNull, normalizedDefault, '', ''] }, { [key]: actual || null }, testOnly);
      }
    }
  }
  if (actualColumns.size !== expectedColumnKeys.size) {
    throwSchemaMismatch('unexpected or missing columns', [...expectedColumnKeys], [...actualColumns.keys()], testOnly);
  }

  const constraints = await safeQuery(`
    SELECT rel.relname AS table_name, con.contype AS constraint_type,
           pg_catalog.pg_get_constraintdef(con.oid, true) AS definition,
           con.convalidated AS validated, con.condeferrable AS deferrable, con.condeferred AS deferred,
           con.connoinherit AS no_inherit,
           COALESCE((pg_catalog.to_jsonb(con)->>'connullsnotdistinct')::boolean, false) AS nulls_not_distinct,
           to_json(ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord)) AS columns,
           ref.relname AS referenced_table,
           to_json(ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_catalog.pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord)) AS referenced_columns,
           con.confdeltype AS delete_action, con.confupdtype AS update_action,
           con.confmatchtype AS match_type
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid
    JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
    LEFT JOIN pg_catalog.pg_class ref ON ref.oid = con.confrelid
    WHERE ns.nspname = 'public' AND rel.relname IN (${expectedTableNames.map(quoteLiteral).join(', ')})
      AND con.contype <> 'n'
  `);
  const actualConstraintKeys = constraints.map((row) => {
    const item = {
      table: row.table_name, type: row.constraint_type,
      columns: row.constraint_type === 'c' ? [] : (row.columns || []),
      definition: row.constraint_type === 'c' ? normalizeConstraintDefinition(row.definition) : null,
      references: row.constraint_type === 'f' ? {
        table: row.referenced_table, columns: row.referenced_columns || [], deleteAction: row.delete_action,
        updateAction: row.update_action, matchType: row.match_type
      } : null,
      validated: row.validated, deferrable: row.deferrable, deferred: row.deferred,
      noInherit: row.no_inherit,
      nullsNotDistinct: row.nulls_not_distinct
    };
    return JSON.stringify(item);
  }).sort();
  const expectedConstraintKeys = expected.constraints.map((item) => JSON.stringify(item)).sort();
  if (JSON.stringify(actualConstraintKeys) !== JSON.stringify(expectedConstraintKeys)) {
    throwSchemaMismatch('constraints and relationships', expectedConstraintKeys.map(JSON.parse), actualConstraintKeys.map(JSON.parse), testOnly);
  }

  const indexes = await safeQuery(`
    SELECT idx.relname AS index_name, tbl.relname AS table_name,
           i.indisunique AS is_unique, i.indisprimary AS is_primary,
           i.indisvalid AS is_valid, i.indisready AS is_ready, i.indislive AS is_live,
           COALESCE((pg_catalog.to_jsonb(i)->>'indnullsnotdistinct')::boolean, false) AS nulls_not_distinct,
           i.indnatts = i.indnkeyatts AS no_included_columns, am.amname AS method,
           ARRAY(SELECT pg_catalog.pg_get_indexdef(i.indexrelid, keynum, true)
                 FROM generate_series(1, i.indnkeyatts) AS keynum ORDER BY keynum) AS columns,
           pg_catalog.pg_get_expr(i.indpred, i.indrelid, true) AS predicate
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_catalog.pg_class tbl ON tbl.oid = i.indrelid
    JOIN pg_catalog.pg_namespace ns ON ns.oid = tbl.relnamespace
    JOIN pg_catalog.pg_am am ON am.oid = idx.relam
    WHERE ns.nspname = 'public' AND tbl.relname IN (${expectedTableNames.map(quoteLiteral).join(', ')})
  `);
  const actualIndexes = indexes.map((row) => JSON.stringify({
    name: row.index_name, table: row.table_name, columns: row.columns || [], unique: row.is_unique,
    primary: row.is_primary, method: row.method, predicate: row.predicate === null ? null : normalizePredicate(row.predicate),
    noIncludedColumns: row.no_included_columns, valid: row.is_valid, ready: row.is_ready,
    live: row.is_live, nullsNotDistinct: row.nulls_not_distinct
  })).sort();
  const expectedIndexes = expected.indexes.map((item) => JSON.stringify({
    name: item.name, table: item.table, columns: item.columns, unique: item.unique,
    primary: item.primary, method: item.method, predicate: item.predicate,
    noIncludedColumns: true, valid: item.valid, ready: item.ready,
    live: item.live, nullsNotDistinct: item.nullsNotDistinct
  })).sort();
  if (JSON.stringify(actualIndexes) !== JSON.stringify(expectedIndexes)) {
    throwSchemaMismatch('indexes', expectedIndexes.map(JSON.parse), actualIndexes.map(JSON.parse), testOnly);
  }

  const triggers = await safeQuery(`
    SELECT tbl.relname AS table_name, t.tgname AS trigger_name,
           t.tgenabled AS enabled, pg_catalog.pg_get_triggerdef(t.oid, true) AS definition,
           proc.proname AS function_name, proc.prosrc AS function_source
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class tbl ON tbl.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace ns ON ns.oid = tbl.relnamespace
    JOIN pg_catalog.pg_proc proc ON proc.oid = t.tgfoid
    WHERE ns.nspname = 'public' AND tbl.relname IN (${expectedTableNames.map(quoteLiteral).join(', ')})
      AND NOT t.tgisinternal
  `);
  const actualTriggers = triggers.map((trigger) => ({
    table: trigger.table_name,
    name: trigger.trigger_name,
    enabled: trigger.enabled,
    definition: normalizeDefinition(trigger.definition),
    functionName: trigger.function_name,
    functionSource: normalizeFunctionSource(trigger.function_source)
  })).sort((left, right) => left.name.localeCompare(right.name));
  const expectedTriggers = expected.triggers.map((trigger) => ({
    ...trigger,
    functionSource: normalizeFunctionSource(trigger.functionSource),
    definition: normalizeDefinition(trigger.definition)
  })).sort((left, right) => left.name.localeCompare(right.name));
  if (JSON.stringify(actualTriggers) !== JSON.stringify(expectedTriggers)) {
    throwSchemaMismatch('triggers', expectedTriggers, actualTriggers, testOnly);
  }

  const functions = expected.functions.length
    ? await safeQuery(`
      SELECT p.proname AS function_name,
             pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments,
             pg_catalog.format_type(p.prorettype, NULL) AS return_type,
             language.lanname AS language,
             p.prosecdef AS security_definer,
             pg_catalog.pg_get_userbyid(p.proowner) AS owner_role,
             p.proconfig AS configuration,
             p.prosrc AS function_source,
             EXISTS (
               SELECT 1
               FROM pg_catalog.aclexplode(
                 COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
               ) permission
               WHERE permission.grantee = 0
                 AND permission.privilege_type = 'EXECUTE'
             ) AS public_execute,
             ARRAY(
               SELECT CASE WHEN permission.grantee = 0 THEN 'PUBLIC'
                           ELSE pg_catalog.pg_get_userbyid(permission.grantee) END
                      || ':' || permission.privilege_type
                      || ':' || permission.is_grantable::text
               FROM pg_catalog.aclexplode(
                 COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
               ) permission
               WHERE permission.grantee <> p.proowner
               ORDER BY permission.grantee, permission.privilege_type
             ) AS other_privileges
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_catalog.pg_language language ON language.oid = p.prolang
      WHERE n.nspname = 'public'
        AND p.proname IN (${expected.functions.map(({ name }) => quoteLiteral(name)).join(', ')})
    `)
    : [];
  const actualFunctions = functions.map((row) => ({
    name: row.function_name,
    identityArguments: row.identity_arguments,
    returnType: row.return_type,
    language: row.language,
    securityDefiner: row.security_definer,
    publicExecute: row.public_execute,
    otherPrivileges: row.other_privileges,
    ...(expected.functions.find(({ name }) => name === row.function_name)?.ownerRole
      ? { ownerRole: row.owner_role }
      : {}),
    configuration: row.configuration || [],
    source: normalizeFunctionSource(row.function_source)
  })).sort((left, right) => left.name.localeCompare(right.name));
  const expectedFunctions = expected.functions.map((item) => ({
    name: item.name,
    identityArguments: item.identityArguments,
    returnType: item.returnType,
    language: item.language,
    securityDefiner: item.securityDefiner,
    publicExecute: item.publicExecute,
    otherPrivileges: item.otherPrivileges,
    ...(item.ownerRole ? { ownerRole: item.ownerRole } : {}),
    configuration: item.configuration || [],
    source: normalizeFunctionSource(item.source)
  })).sort((left, right) => left.name.localeCompare(right.name));
  if (JSON.stringify(actualFunctions) !== JSON.stringify(expectedFunctions)) {
    throwSchemaMismatch('functions', expectedFunctions, actualFunctions, testOnly);
  }

  const roles = expected.roles.length
    ? await safeQuery(`
      SELECT rolname AS name, rolcanlogin AS can_login, rolsuper AS superuser,
             rolcreatedb AS create_db, rolcreaterole AS create_role,
             rolinherit AS inherit, rolreplication AS replication,
             rolbypassrls AS bypass_rls
      FROM pg_catalog.pg_roles
      WHERE rolname IN (${expected.roles.map(({ name }) => quoteLiteral(name)).join(', ')})
    `)
    : [];
  const actualRoles = roles.map((role) => ({
    name: role.name,
    canLogin: role.can_login,
    superuser: role.superuser,
    createDb: role.create_db,
    createRole: role.create_role,
    inherit: role.inherit,
    replication: role.replication,
    bypassRls: role.bypass_rls
  })).sort((left, right) => left.name.localeCompare(right.name));
  const expectedRoles = [...expected.roles].sort((left, right) =>
    left.name.localeCompare(right.name));
  if (JSON.stringify(actualRoles) !== JSON.stringify(expectedRoles)) {
    throwSchemaMismatch('roles', expectedRoles, actualRoles, testOnly);
  }
  if (expected.roles.length) {
    const unsafeMemberships = await safeQuery(`
      SELECT role.rolname AS role_name, member.rolname AS member_name
      FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles role ON role.oid = membership.roleid
      JOIN pg_catalog.pg_roles member ON member.oid = membership.member
      WHERE role.rolname = 'cybanext_sms_consent_retention_owner'
         OR member.rolname = 'cybanext_sms_consent_retention_owner'
    `);
    if (unsafeMemberships.length) {
      throwSchemaMismatch('roles', expectedRoles, unsafeMemberships, testOnly);
    }
  }

  const schemaPrivileges = expected.schemaPrivileges.length
    ? await safeQuery(`
      SELECT role.rolname AS grantee,
             pg_catalog.has_schema_privilege(role.rolname, 'public', 'USAGE') AS usage,
             pg_catalog.has_schema_privilege(role.rolname, 'public', 'CREATE') AS can_create
      FROM pg_catalog.pg_roles role
      WHERE role.rolname IN (${expected.schemaPrivileges.map(({ grantee }) =>
        quoteLiteral(grantee)).join(', ')})
    `)
    : [];
  const actualSchemaPrivileges = schemaPrivileges.map((item) => ({
    grantee: item.grantee,
    usage: item.usage,
    create: item.can_create
  })).sort((left, right) => left.grantee.localeCompare(right.grantee));
  const expectedSchemaPrivileges = [...expected.schemaPrivileges].sort((left, right) =>
    left.grantee.localeCompare(right.grantee));
  if (JSON.stringify(actualSchemaPrivileges) !== JSON.stringify(expectedSchemaPrivileges)) {
    throwSchemaMismatch(
      'schema privileges',
      expectedSchemaPrivileges,
      actualSchemaPrivileges,
      testOnly
    );
  }

  const policies = await safeQuery(`
    SELECT tbl.relname AS table_name, p.polname AS policy_name, p.polcmd AS command,
           p.polpermissive AS permissive, p.polroles AS role_ids,
           pg_catalog.pg_get_expr(p.polqual, p.polrelid, true) AS using_expression,
           pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid, true) AS check_expression
    FROM pg_catalog.pg_policy p
    JOIN pg_catalog.pg_class tbl ON tbl.oid = p.polrelid
    JOIN pg_catalog.pg_namespace ns ON ns.oid = tbl.relnamespace
    WHERE ns.nspname = 'public' AND tbl.relname IN (${expectedTableNames.map(quoteLiteral).join(', ')})
  `);
  if (policies.length) throwSchemaMismatch('row-level security policies', [], policies, testOnly);

  const privileges = await safeQuery(`
    SELECT tbl.relname AS table_name, NULL::text AS column_name,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee) END AS grantee,
           acl.privilege_type, acl.is_grantable
    FROM pg_catalog.pg_class tbl
    JOIN pg_catalog.pg_namespace ns ON ns.oid = tbl.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(tbl.relacl, pg_catalog.acldefault('r', tbl.relowner))
    ) acl
    WHERE ns.nspname = 'public' AND tbl.relname IN (${expectedTableNames.map(quoteLiteral).join(', ')})
      AND acl.grantee <> tbl.relowner
    UNION ALL
    SELECT tbl.relname AS table_name, att.attname AS column_name,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee) END AS grantee,
           acl.privilege_type, acl.is_grantable
    FROM pg_catalog.pg_attribute att
    JOIN pg_catalog.pg_class tbl ON tbl.oid = att.attrelid
    JOIN pg_catalog.pg_namespace ns ON ns.oid = tbl.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) acl
    WHERE ns.nspname = 'public' AND tbl.relname IN (${expectedTableNames.map(quoteLiteral).join(', ')})
      AND att.attnum > 0 AND NOT att.attisdropped AND acl.grantee <> tbl.relowner
  `);
  const actualPrivileges = privileges.map((privilege) => ({
    table: privilege.table_name,
    column: privilege.column_name,
    grantee: privilege.grantee,
    privilege: privilege.privilege_type,
    grantable: privilege.is_grantable
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const expectedPrivileges = [...expected.privileges].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)));
  if (JSON.stringify(actualPrivileges) !== JSON.stringify(expectedPrivileges)) {
    throwSchemaMismatch('table and column privileges', expectedPrivileges, actualPrivileges, testOnly);
  }
}

async function inspectUnexpectedPublicRelations(sql, expectedNames) {
  let relations;
  try {
    relations = await sql.query(`
      SELECT c.relname AS relation_name, c.relkind AS relation_kind
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    `);
  } catch {
    throw new Error('Could not inspect public schema relations.');
  }
  if (!Array.isArray(relations)) {
    throw new Error('Public schema relation inspection returned an invalid result.');
  }
  const expected = new Set(expectedNames);
  const unexpected = relations
    .filter(({ relation_name }) => !expected.has(relation_name))
    .map(({ relation_name: name, relation_kind: kind }) => ({ name, kind }));
  if (unexpected.length) {
    throwSchemaMismatch('unexpected public relations', [...expected].sort(), unexpected, false);
  }
}

function validateMigrationHistory(rows, migrations) {
  const errors = [];
  const checksumMismatches = [];
  if (!Array.isArray(rows)) {
    return {
      valid: false,
      orderedPrefix: false,
      appliedMigrations: [],
      checksumMismatches,
      errors: ['Migration history query returned an invalid result.']
    };
  }
  const appliedMigrations = rows.map((row) =>
    row && typeof row.filename === 'string' ? row.filename : null);
  let orderedPrefix = rows.length <= migrations.length;
  if (!orderedPrefix) errors.push('Migration history contains more records than local migrations.');

  for (let index = 0; index < rows.length; index += 1) {
    const recorded = rows[index];
    const expected = migrations[index];
    if (!recorded || typeof recorded.filename !== 'string' ||
        typeof recorded.checksum !== 'string' ||
        !expected || recorded.filename !== expected.filename) {
      orderedPrefix = false;
      errors.push(`Migration history is not an ordered prefix at position ${index + 1}.`);
      continue;
    }
    if (recorded.checksum !== expected.checksum) {
      checksumMismatches.push({
        filename: expected.filename,
        expected: expected.checksum,
        recorded: recorded.checksum
      });
    }
  }

  for (const mismatch of checksumMismatches) {
    errors.push(`Checksum mismatch for ${mismatch.filename}.`);
  }
  return {
    valid: errors.length === 0,
    orderedPrefix,
    appliedMigrations,
    checksumMismatches,
    errors
  };
}

function schemaOptionsForMigrationVersion(version) {
  return {
    includeApplicantAuth: version >= 2,
    includeRegularTrack: version >= 3,
    includeEmailOutbox: version >= 4,
    includePaymentFailed: version >= 4,
    includeSmsConsent: version >= 5,
    includeSmsOutbox: version >= 6,
    includeApplicantReceipts: version >= 7,
    includeReceiptResend: version >= 8,
    includeSmsConsentRetention: version >= 9,
    includeApplicantRegistrationSelection: version >= 10,
    includeMigrationHistory: true
  };
}

function historyValidationBlock(migrations, adoptExisting = false) {
  const names = `ARRAY[${migrations.map(({ filename }) => quoteLiteral(filename)).join(', ')}]::text[]`;
  const checksums = `ARRAY[${migrations.map(({ checksum }) => quoteLiteral(checksum)).join(', ')}]::text[]`;
  const historyGuard = `
    IF (SELECT count(*) FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'schema_migrations') <> 3
       OR EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'schema_migrations'
           AND NOT (
             (column_name = 'filename' AND data_type = 'text' AND is_nullable = 'NO' AND column_default IS NULL) OR
             (column_name = 'checksum' AND data_type = 'text' AND is_nullable = 'NO' AND column_default IS NULL) OR
             (column_name = 'applied_at' AND data_type = 'timestamp with time zone' AND is_nullable = 'NO' AND column_default LIKE 'CURRENT_TIMESTAMP%')
           )
       )
       OR (SELECT count(*) FROM pg_catalog.pg_constraint con
           JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname = 'schema_migrations'
             AND con.contype = 'p' AND pg_catalog.pg_get_constraintdef(con.oid) = 'PRIMARY KEY (filename)'
             AND con.convalidated) <> 1
       OR (SELECT count(*) FROM pg_catalog.pg_constraint con
           JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname = 'schema_migrations' AND con.contype = 'c'
             AND pg_catalog.pg_get_constraintdef(con.oid, true) = 'CHECK (checksum ~ ''^[a-f0-9]{64}$''::text)'
             AND con.convalidated) <> 1
       OR (SELECT count(*) FROM pg_catalog.pg_constraint con
           JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname = 'schema_migrations' AND con.contype = 'c') <> 1
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_constraint con
           JOIN pg_catalog.pg_class c ON c.oid = con.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname = 'schema_migrations' AND con.contype NOT IN ('p', 'c', 'n'))
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname = 'schema_migrations' AND NOT i.indisprimary)
    THEN RAISE EXCEPTION 'migration history table schema is invalid'; END IF;
  `;
  const body = adoptExisting ? `
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext('cybanext_schema_migrations'));
      ${historyGuard}
    IF EXISTS (SELECT 1 FROM public.schema_migrations) THEN
      RAISE EXCEPTION 'existing migration history prevents adoption';
    END IF;
    ${migrations.map((migration) => `INSERT INTO public.schema_migrations (filename, checksum) VALUES (${quoteLiteral(migration.filename)}, ${quoteLiteral(migration.checksum)});`).join('\n')}
    END;
  ` : `
    DECLARE expected_names text[] := ${names}; expected_checksums text[] := ${checksums};
            recorded_count integer; idx integer; recorded_checksum text;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext('cybanext_schema_migrations'));
      ${historyGuard}
      IF (SELECT count(*) FROM public.schema_migrations) > cardinality(expected_names) THEN
        RAISE EXCEPTION 'migration history has extra records';
      END IF;
      IF EXISTS (SELECT 1 FROM public.schema_migrations WHERE NOT (filename = ANY(expected_names))) THEN
        RAISE EXCEPTION 'migration history contains an unknown filename';
      END IF;
      SELECT count(*) INTO recorded_count FROM public.schema_migrations;
      IF recorded_count > 0 THEN
        FOR idx IN 1..recorded_count LOOP
          SELECT checksum INTO recorded_checksum FROM public.schema_migrations WHERE filename = expected_names[idx];
          IF NOT FOUND THEN RAISE EXCEPTION 'migration history is not an ordered prefix'; END IF;
          IF recorded_checksum <> expected_checksums[idx] THEN RAISE EXCEPTION 'migration checksum mismatch'; END IF;
        END LOOP;
      END IF;
      IF recorded_count = 0 AND EXISTS (
        SELECT 1 FROM unnest(ARRAY[${EXPECTED_TABLES.map(quoteLiteral).join(', ')}]::text[]) AS app_table(name)
        WHERE to_regclass('public.' || app_table.name) IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'application tables exist without migration history';
      END IF;
      FOR idx IN (recorded_count + 1)..cardinality(expected_names) LOOP
        CASE idx
          ${migrations.map((migration, index) => `WHEN ${index + 1} THEN ${migration.statements.map((statement) => `EXECUTE ${quoteLiteral(statement)};`).join('\n')}`).join('\n')}
        END CASE;
        INSERT INTO public.schema_migrations (filename, checksum) VALUES (expected_names[idx], expected_checksums[idx]);
      END LOOP;
    END;
  `;
  return `DO $cybanext_migration$ ${body} $cybanext_migration$`;
}

function historyTableDefinition() {
  return `CREATE TABLE IF NOT EXISTS public.schema_migrations (
    filename TEXT PRIMARY KEY,
    checksum TEXT NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`;
}

function historyIntegrityValidationStatement(migrations) {
  const names = `ARRAY[${migrations.map(({ filename }) => quoteLiteral(filename)).join(', ')}]::text[]`;
  const checksums = `ARRAY[${migrations.map(({ checksum }) => quoteLiteral(checksum)).join(', ')}]::text[]`;
  return `DO $cybanext_history_integrity$
  DECLARE expected_names text[] := ${names}; expected_checksums text[] := ${checksums};
          idx integer; recorded_checksum text; recorded_count integer;
  BEGIN
    SELECT count(*) INTO recorded_count FROM public.schema_migrations;
    IF recorded_count <> cardinality(expected_names) THEN
      RAISE EXCEPTION 'migration history records';
    END IF;
    FOR idx IN 1..cardinality(expected_names) LOOP
      SELECT checksum INTO recorded_checksum
      FROM public.schema_migrations
      WHERE filename = expected_names[idx];
      IF NOT FOUND OR recorded_checksum <> expected_checksums[idx] THEN
        RAISE EXCEPTION 'migration history records';
      END IF;
    END LOOP;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid = 'public.schema_migrations'::regclass AND NOT tgisinternal
    ) THEN RAISE EXCEPTION 'migration history triggers'; END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_class tbl
      JOIN pg_catalog.pg_namespace ns ON ns.oid = tbl.relnamespace
      WHERE ns.nspname = 'public' AND tbl.relname = 'schema_migrations'
        AND (tbl.relrowsecurity OR tbl.relforcerowsecurity)
    ) OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_policy policy
      JOIN pg_catalog.pg_class tbl ON tbl.oid = policy.polrelid
      JOIN pg_catalog.pg_namespace ns ON ns.oid = tbl.relnamespace
      WHERE ns.nspname = 'public' AND tbl.relname = 'schema_migrations'
    ) THEN RAISE EXCEPTION 'migration history row-level security'; END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_class tbl
      JOIN pg_catalog.pg_namespace ns ON ns.oid = tbl.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(tbl.relacl, pg_catalog.acldefault('r', tbl.relowner))
      ) acl
      WHERE ns.nspname = 'public' AND tbl.relname = 'schema_migrations'
        AND acl.grantee <> tbl.relowner
    ) OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute att
      JOIN pg_catalog.pg_class tbl ON tbl.oid = att.attrelid
      JOIN pg_catalog.pg_namespace ns ON ns.oid = tbl.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) acl
      WHERE ns.nspname = 'public' AND tbl.relname = 'schema_migrations'
        AND att.attnum > 0 AND NOT att.attisdropped AND acl.grantee <> tbl.relowner
    ) THEN RAISE EXCEPTION 'migration history privileges'; END IF;
  END $cybanext_history_integrity$`;
}

function advisoryLockStatement() {
  return "SELECT pg_advisory_xact_lock(hashtext('cybanext_schema_migrations'))";
}

function historyStructureValidationStatement(testOnly = false) {
  const invalid = (category) => testOnly
    ? `migration history table schema is invalid: ${category}`
    : 'migration history table schema is invalid';
  const expectedMetadata = {
    columns: [
      { name: 'filename', dataType: 'text', nullable: 'NO', default: null },
      { name: 'checksum', dataType: 'text', nullable: 'NO', default: null },
      { name: 'applied_at', dataType: 'timestamp with time zone', nullable: 'NO', default: 'CURRENT_TIMESTAMP' }
    ],
    primaryKey: { definition: 'PRIMARY KEY (filename)', validated: true },
    checkConstraint: { definition: "CHECK (checksum ~ '^[a-f0-9]{64}$'::text)", validated: true },
    extraConstraints: [], extraIndexes: []
  };
  const diagnosticDeclaration = testOnly ? 'DECLARE actual_catalog jsonb;' : '';
  const diagnosticQuery = testOnly ? `
      SELECT jsonb_build_object(
        'columns', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', column_name, 'dataType', data_type,
          'nullable', is_nullable, 'default', column_default) ORDER BY ordinal_position)
          FROM information_schema.columns WHERE table_schema='public' AND table_name='schema_migrations'), '[]'::jsonb),
        'constraints', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', con.conname, 'type', con.contype,
          'definition', pg_catalog.pg_get_constraintdef(con.oid, true), 'validated', con.convalidated)
          ORDER BY con.conname) FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class c ON c.oid=con.conrelid
          JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='schema_migrations'), '[]'::jsonb),
        'indexes', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', idx.relname, 'primary', i.indisprimary,
          'unique', i.indisunique, 'valid', i.indisvalid, 'definition', pg_catalog.pg_get_indexdef(i.indexrelid))
          ORDER BY idx.relname) FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class idx ON idx.oid=i.indexrelid
          JOIN pg_catalog.pg_class tbl ON tbl.oid=i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=tbl.relnamespace
          WHERE n.nspname='public' AND tbl.relname='schema_migrations'), '[]'::jsonb)
      ) INTO actual_catalog;
  ` : '';
  const raise = (category) => testOnly
    ? `RAISE EXCEPTION USING MESSAGE = ${quoteLiteral(invalid(category))}, DETAIL = jsonb_build_object('expected', ${quoteLiteral(JSON.stringify(expectedMetadata))}::jsonb, 'actual', actual_catalog)::text;`
    : `RAISE EXCEPTION ${quoteLiteral(invalid(category))};`;
  return `DO $cybanext_history_structure$
  ${diagnosticDeclaration}
  BEGIN
    ${diagnosticQuery}
    IF to_regclass('public.schema_migrations') IS NULL THEN RETURN; END IF;
    IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='schema_migrations') <> 3
       OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='schema_migrations'
         AND NOT ((column_name='filename' AND data_type='text' AND is_nullable='NO' AND column_default IS NULL)
           OR (column_name='checksum' AND data_type='text' AND is_nullable='NO' AND column_default IS NULL)
           OR (column_name='applied_at' AND data_type='timestamp with time zone' AND is_nullable='NO' AND column_default LIKE 'CURRENT_TIMESTAMP%')))
    THEN ${raise('columns')} END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class c ON c.oid=con.conrelid
         JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='schema_migrations' AND con.contype='p'
         AND pg_catalog.pg_get_constraintdef(con.oid)='PRIMARY KEY (filename)' AND con.convalidated) <> 1
    THEN ${raise('primary key')} END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class c ON c.oid=con.conrelid
         JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='schema_migrations' AND con.contype='c'
         AND pg_catalog.pg_get_constraintdef(con.oid, true)='CHECK (checksum ~ ''^[a-f0-9]{64}$''::text)'
         AND con.convalidated) <> 1
       OR (SELECT count(*) FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class c ON c.oid=con.conrelid
         JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='schema_migrations' AND con.contype='c') <> 1
    THEN ${raise('checksum constraint')} END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class c ON c.oid=con.conrelid
         JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='schema_migrations' AND con.contype NOT IN ('p','c','n'))
    THEN ${raise('unexpected constraint')} END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indrelid
         JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='schema_migrations' AND NOT i.indisprimary)
    THEN ${raise('unexpected index')} END IF;
  END $cybanext_history_structure$`;
}

function testDatabaseDiagnostic(error) {
  const redact = (value) => typeof value === 'string'
    ? value.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[redacted connection string]')
      .replace(/(password\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    : undefined;
  return {
    message: redact(error?.message),
    sqlstate: typeof error?.code === 'string' ? error.code : undefined,
    detail: redact(error?.detail),
    hint: redact(error?.hint),
    context: redact(error?.where),
    ...(error?.schemaDiagnostic ? { schema: error.schemaDiagnostic } : {})
  };
}

function reportTestDatabaseDiagnostic(error, options) {
  if (options.testOnly === true && typeof options.onTestDiagnostic === 'function') {
    options.onTestDiagnostic(testDatabaseDiagnostic(error));
  }
}

function assertReadOnlyPreflightQuery(statement) {
  const statements = splitSqlStatements(statement);
  if (
    statements.length !== 1 ||
    !/^\s*SELECT\b/i.test(statements[0]) ||
    /\b(?:pg_advisory_[a-z_]+|nextval|setval|set_config)\s*\(/i.test(statements[0]) ||
    /\bFOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)\b/i.test(statements[0])
  ) {
    throw new Error('Read-only preflight accepts catalog SELECT statements only.');
  }
}

function hasExplicitEnvironmentFile() {
  return process.execArgv.some((argument) =>
    argument === '--env-file' || argument.startsWith('--env-file='));
}

function createNeonMigrationClient(connectionString) {
  const { Pool } = require('@neondatabase/serverless');
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10000 });
  return {
    async query(statement) {
      return (await pool.query(statement)).rows;
    },
    async withTransaction(callback) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await callback({
          query: async (statement) => (await client.query(statement)).rows
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
        throw error;
      } finally {
        client.release();
      }
    },
    async withReadOnlyTransaction(callback) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN READ ONLY');
        const result = await callback({
          query: async (statement) => {
            assertReadOnlyPreflightQuery(statement);
            return (await client.query(statement)).rows;
          }
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end()
  };
}

async function runDevelopmentPreflight({ environment, migrations, logger, createClient }) {
  if (!environment.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for development preflight.');
  }
  validateEndpointConfiguration('development', environment);

  let sql;
  try {
    sql = createClient();
  } catch {
    throw new Error('Could not initialize the development preflight database client.');
  }

  try {
    if (typeof sql.withReadOnlyTransaction !== 'function') {
      throw new Error('Database client does not support a read-only transaction.');
    }

    let report;
    try {
      report = await sql.withReadOnlyTransaction(async (tx) => {
        const databaseRows = await tx.query('SELECT current_database() AS database_name');
        if (!databaseRows[0] || databaseRows[0].database_name !== EXPECTED_DATABASE) {
          throw new Error('Connected database does not match the expected database for this project.');
        }

        const historyTableRows = await tx.query(
          "SELECT to_regclass('public.schema_migrations') AS history_table"
        );
        if (!historyTableRows[0] || !historyTableRows[0].history_table) {
          return {
            preflight: true,
            target: 'development',
            database: EXPECTED_DATABASE,
            ready: false,
            history: {
              valid: false,
              appliedMigrations: [],
              checksumMismatches: [],
              errors: ['Migration history table is missing.']
            },
            pendingMigrations: null,
            schema: {
              valid: false,
              migrationVersion: null,
              error: 'Cannot determine the schema version without migration history.'
            }
          };
        }

        const historyRows = await tx.query(`
          SELECT filename, checksum
          FROM public.schema_migrations
          ORDER BY filename
        `);
        const history = validateMigrationHistory(historyRows, migrations);
        const pendingMigrations = history.orderedPrefix
          ? migrations.slice(historyRows.length).map(({ filename }) => filename)
          : null;

        if (!history.valid) {
          return {
            preflight: true,
            target: 'development',
            database: EXPECTED_DATABASE,
            ready: false,
            history,
            pendingMigrations,
            schema: {
              valid: false,
              migrationVersion: null,
              error: 'Schema version is untrusted until migration history is valid.'
            }
          };
        }

        if (historyRows.length === 0) {
          return {
            preflight: true,
            target: 'development',
            database: EXPECTED_DATABASE,
            ready: false,
            history,
            pendingMigrations,
            schema: {
              valid: false,
              migrationVersion: 0,
              error: 'No migrations are recorded; the current schema version cannot be verified.'
            }
          };
        }

        const migrationVersion = historyRows.length;
        const schemaOptions = schemaOptionsForMigrationVersion(migrationVersion);
        let schema;
        try {
          await inspectExistingSchema(tx, schemaOptions);
          const expected = expectedSchema(schemaOptions);
          await inspectUnexpectedPublicRelations(
            tx,
            expected.tables.map(({ name }) => name)
          );
          schema = { valid: true, migrationVersion, error: null };
        } catch (error) {
          schema = {
            valid: false,
            migrationVersion,
            error: safeSchemaMismatchCategory(error) || 'schema inspection failed'
          };
        }

        return {
          preflight: true,
          target: 'development',
          database: EXPECTED_DATABASE,
          ready: schema.valid,
          history,
          pendingMigrations,
          schema
        };
      });
    } catch (error) {
      if (error?.message === 'Connected database does not match the expected database for this project.') {
        throw error;
      }
      throw new Error('Development read-only preflight failed during database validation.');
    }

    logger.log('Read-only development preflight; no migrations or writes executed.');
    logger.log(`Configured development endpoint and ${EXPECTED_DATABASE} database verified.`);
    if (report.history.appliedMigrations.length) {
      logger.log(`Applied migrations: ${report.history.appliedMigrations.join(', ')}.`);
    } else if (report.history.valid) {
      logger.log('Applied migrations: none.');
    }
    for (const mismatch of report.history.checksumMismatches) {
      logger.error(
        `Checksum mismatch for ${mismatch.filename}: expected ${mismatch.expected}, recorded ${mismatch.recorded}.`
      );
    }
    for (const error of report.history.errors) logger.error(error);
    if (report.pendingMigrations) {
      logger.log(`Pending migrations: ${report.pendingMigrations.join(', ') || 'none'}.`);
    } else {
      logger.log('Pending migrations: unknown because migration history is invalid.');
    }
    if (report.schema.valid) {
      logger.log(`Schema matches the expected migration ${report.schema.migrationVersion} state.`);
    } else {
      logger.error(`Schema validation failed: ${report.schema.error}.`);
    }
    logger.log(report.ready
      ? 'Preflight verdict: ready for migration approval.'
      : 'Preflight verdict: not ready.');
    return report;
  } finally {
    if (typeof sql.close === 'function') {
      try { await sql.close(); } catch { /* Preserve the preflight result. */ }
    }
  }
}

async function runMigrations(options = {}) {
  const args = options.args || [];
  const logger = options.logger || console;
  const migrationsDirectory = options.migrationsDirectory || path.join(__dirname, '..', 'db', 'migrations');
  const migrations = loadMigrations(migrationsDirectory);
  const { apply, preflight, target, adoptExisting } = parseArguments(args);
  if (preflight) {
    if (!options.environment && !hasExplicitEnvironmentFile()) {
      throw new Error('Development preflight requires an explicit Node --env-file; ambient database variables are not accepted.');
    }
    const environment = options.environment || process.env;
    const createClient = options.createClient || (() =>
      createNeonMigrationClient(environment.DATABASE_URL));
    return runDevelopmentPreflight({
      environment,
      migrations,
      logger,
      createClient
    });
  }
  if (!apply) {
    logger.log('Dry run only. No database connection or SQL execution.');
    logger.log(`Selected target: ${target}.`);
    logger.log('Migration order:');
    for (const migration of migrations) logger.log(`- ${migration.filename}`);
    return { applied: false, migrations: migrations.map(({ filename }) => filename) };
  }
  const environment = options.environment || process.env;
  if (!environment.DATABASE_URL) throw new Error('DATABASE_URL is required to apply migrations.');
  const testOnly = options.testOnly === true;
  if (testOnly) {
    if (options.testOnlyToken !== TEST_ONLY_TOKEN || options.testTarget !== 'loopback-postgres') {
      throw new Error('Test-only migration entry point is unavailable.');
    }
    validateLoopbackTestTarget(environment.DATABASE_URL);
  } else {
    validateEndpointConfiguration(target, environment);
  }
  let sql;
  try {
    const createClient = options.createClient || (() => {
      return createNeonMigrationClient(environment.DATABASE_URL);
    });
    sql = createClient();
  } catch {
    throw new Error('Could not initialize the database client.');
  }
  try {
    if (typeof sql.withTransaction !== 'function') {
      throw new Error('Migration database client must support interactive transactions.');
    }
    if (testOnly) await verifyLoopbackTestConnection(sql, environment.DATABASE_URL);
    else await verifyConnectionTarget(sql, target, environment);
    logger.log(testOnly ? 'Verified loopback PostgreSQL test target.' : `Verified ${target} endpoint host and ${EXPECTED_DATABASE} database name.`);

    if (adoptExisting) {
      let upgradedLegacySchema = false;
      try {
        await sql.withTransaction(async (tx) => {
          await tx.query(advisoryLockStatement());
          try {
            await inspectExistingSchema(tx, { testOnly });
          } catch (currentSchemaError) {
            const existingObjects = await tx.query(`
              SELECT relname AS object_name
              FROM pg_catalog.pg_class
              JOIN pg_catalog.pg_namespace ON pg_catalog.pg_namespace.oid = pg_class.relnamespace
              WHERE pg_catalog.pg_namespace.nspname = 'public'
                AND relname IN (${[
                  ...REGULAR_TRACK_OBJECTS,
                  'email_notification_outbox',
                  'sms_consent_events',
                  'sms_notification_outbox',
                  'applicant_payment_receipts',
                  'sms_current_consent'
                ].map(quoteLiteral).join(', ')})
            `);
            const selectionColumns = await tx.query(`
              SELECT table_name, column_name
              FROM information_schema.columns
              WHERE table_schema = 'public'
                AND (
                  (table_name = 'applicant_magic_link_tokens'
                    AND column_name = 'regular_track_registration_id')
                  OR
                  (table_name = 'applicant_sessions'
                    AND column_name IN (
                      'regular_track_registration_id',
                      'verification_registration_id',
                      'verification_regular_track_registration_id'
                    ))
                )
            `);
            const existingNames = new Set(existingObjects.map(({ object_name }) => object_name));
            const existingSelectionColumns = new Set(selectionColumns.map(
              ({ table_name, column_name }) => `${table_name}.${column_name}`
            ));
            const hasApplicantRegistrationSelection = [
              'applicant_magic_link_tokens.regular_track_registration_id',
              'applicant_sessions.regular_track_registration_id',
              'applicant_sessions.verification_registration_id',
              'applicant_sessions.verification_regular_track_registration_id'
            ].every((column) => existingSelectionColumns.has(column));
            const hasRegularTrackObjects = REGULAR_TRACK_OBJECTS.some((name) =>
              existingNames.has(name));
            const hasEmailOutbox = existingNames.has('email_notification_outbox');
            const hasSmsConsent = existingNames.has('sms_consent_events');
            const hasSmsOutbox = existingNames.has('sms_notification_outbox');
            await inspectExistingSchema(tx, {
              testOnly,
              includeRegularTrack: hasRegularTrackObjects,
              includeEmailOutbox: hasEmailOutbox,
              includePaymentFailed: hasEmailOutbox,
              includeSmsConsent: hasSmsConsent,
              includeSmsOutbox: hasSmsOutbox,
              includeApplicantReceipts: existingNames.has('applicant_payment_receipts'),
              includeReceiptResend: false,
              includeSmsConsentRetention: existingNames.has('sms_current_consent'),
              includeApplicantRegistrationSelection: hasApplicantRegistrationSelection
            });

            const migrationsToApply = [
              ['regular_track_applicants', '003_create_regular_track_payment_records.sql'],
              ['email_notification_outbox', '004_create_email_notification_outbox.sql'],
              ['sms_consent_events', '005_create_sms_consent_events.sql'],
              ['sms_notification_outbox', '006_create_sms_notification_outbox.sql'],
              ['applicant_payment_receipts', '007_create_applicant_payment_receipts.sql'],
              [null, '008_add_applicant_receipt_resend.sql'],
              ['sms_current_consent', '009_sms_consent_retention.sql'],
              [null, '010_applicant_portal_registration_selection.sql']
            ];
            for (const [objectName, filename] of migrationsToApply) {
              if (objectName && existingNames.has(objectName)) continue;
              const migration = migrations.find((item) => item.filename === filename);
              if (!migration) throw currentSchemaError;
              for (const statement of migration.statements) {
                await tx.query(statement);
              }
            }
            await inspectExistingSchema(tx, { testOnly });
            upgradedLegacySchema = true;
          }
          await tx.query(historyTableDefinition());
          await tx.query(historyStructureValidationStatement(testOnly));
          await tx.query('SELECT filename, checksum FROM public.schema_migrations');
          await tx.query(historyValidationBlock(migrations, true));
          await tx.query(historyIntegrityValidationStatement(migrations));
        });
      } catch (error) {
        reportTestDatabaseDiagnostic(error, { ...options, testOnly });
        const category = safeSchemaMismatchCategory(error);
        const mismatch = category ? ` (schema mismatch: ${category})` : '';
        throw new Error(`Development schema adoption failed${mismatch}; no raw database details are available.`);
      }
      logger.log(upgradedLegacySchema
        ? 'Exact pre-notification development schema upgraded and adopted transactionally.'
        : 'Existing development schema verified and adopted; migration DDL was not rerun.');
      return {
        applied: true,
        adopted: true,
        upgradedLegacySchema,
        migrations: migrations.map(({ filename }) => filename)
      };
    }

    try {
      await sql.withTransaction(async (tx) => {
        await tx.query(advisoryLockStatement());
        await tx.query(historyTableDefinition());
        await tx.query(historyStructureValidationStatement(testOnly));
        await tx.query('SELECT filename, checksum FROM public.schema_migrations');
        await tx.query(historyValidationBlock(migrations, false));
        await tx.query(historyIntegrityValidationStatement(migrations));
        await inspectExistingSchema(tx, { testOnly });
      });
    } catch (error) {
      reportTestDatabaseDiagnostic(error, { ...options, testOnly });
      const code = error && typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : 'unknown';
      const category = safeSchemaMismatchCategory(error);
      const mismatch = category ? ` (schema mismatch: ${category})` : '';
      logger.error(`Migration transaction failed${mismatch}; no raw database details are available (code: ${code}).`);
      throw Object.assign(new Error(`Migration operation failed${mismatch}.`), { safeMigrationError: true, code, schemaMismatchCategory: category });
    }
    logger.log('All listed migrations completed or were already applied with matching checksums.');
    return { applied: true, migrations: migrations.map(({ filename }) => filename) };
  } finally {
    if (typeof sql.close === 'function') {
      try { await sql.close(); } catch { /* Do not replace the migration result with a pool-close error. */ }
    }
  }
}

const TEST_ONLY_TOKEN = Symbol('migration-test-only-entry-point');

function validateLoopbackTestTarget(connectionUrl) {
  let parsed;
  try { parsed = new URL(connectionUrl); } catch { throw new Error('Test database URL is invalid.'); }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const hasHostOverride = [...parsed.searchParams.keys()].some((parameter) =>
    ['host', 'hostaddr'].includes(parameter.toLowerCase()));
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      !['localhost', '127.0.0.1', '::1'].includes(host) ||
      hasHostOverride ||
      parsed.username === '' || parsed.password === '' || parsed.pathname.length < 2) {
    throw new Error('Test database must use an explicit loopback PostgreSQL URL with credentials and a database name.');
  }
  return parsed;
}

async function verifyLoopbackTestConnection(sql, connectionUrl) {
  validateLoopbackTestTarget(connectionUrl);
  let rows;
  try { rows = await sql.query('SELECT current_database() AS database_name'); }
  catch { throw new Error('Could not verify the loopback PostgreSQL test target.'); }
  if (!rows[0] || rows[0].database_name !== decodeURIComponent(new URL(connectionUrl).pathname.slice(1))) {
    throw new Error('Connected database is not the requested loopback PostgreSQL test target.');
  }
}

async function runTestMigrations(options = {}) {
  const connectionUrl = options.connectionUrl;
  validateLoopbackTestTarget(connectionUrl);
  const { apply = true, adoptExisting = false, logger = console, createClient } = options;
  if (!apply) {
    logger.log('Dry run only. No database connection or SQL execution.');
    logger.log('Selected target: isolated PostgreSQL test database.');
    logger.log('Migration order:');
    for (const migration of loadMigrations()) logger.log(`- ${migration.filename}`);
    return { applied: false, migrations: loadMigrations().map(({ filename }) => filename) };
  }
  if (typeof createClient !== 'function') throw new Error('A test-only PostgreSQL client factory is required.');
  return runMigrations({
    args: ['--target=development', '--apply', '--confirm-development=dev/cybanext-phase2c-test', ...(adoptExisting ? ['--adopt-existing'] : [])],
    environment: { DATABASE_URL: connectionUrl }, logger, createClient,
    migrationsDirectory: options.migrationsDirectory,
    testOnly: true, testOnlyToken: TEST_ONLY_TOKEN, testTarget: 'loopback-postgres',
    onTestDiagnostic: options.onTestDiagnostic
  });
}

function sanitizeError(error) {
  const code = error && typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : 'unknown';
  const category = safeSchemaMismatchCategory(error);
  const mismatch = category ? ` (schema mismatch: ${category})` : '';
  return `Migration operation failed${mismatch}. (code: ${code})`;
}

if (require.main === module) {
  runMigrations({ args: process.argv.slice(2) })
    .then((result) => {
      if (result.preflight && !result.ready) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(sanitizeError(error));
      process.exitCode = 1;
    });
}

module.exports = {
  EXPECTED_DATABASE,
  EXPECTED_TABLES,
  MIGRATION_FILES,
  expectedSchema,
  historyValidationBlock,
  historyIntegrityValidationStatement,
  inspectExistingSchema,
  loadMigrations,
  parseArguments,
  runMigrations,
  runTestMigrations,
  sanitizeError,
  splitSqlStatements,
  validateEndpointConfiguration,
  verifyConnectionTarget
};
