const database = require('./digital-forensics-database');

async function findEligibleApplicant(email) {
  const rows = await database.query`
    SELECT applicant_type AS "applicantType",
      registration_id AS "registrationId"
    FROM (
      SELECT
        'digital_forensics'::TEXT AS applicant_type,
        registration_id,
        created_at
      FROM digital_forensics_registrations
      WHERE email = ${email}
      UNION ALL
      SELECT
        'regular_track'::TEXT AS applicant_type,
        registration_id,
        created_at
      FROM regular_track_applicants
      WHERE email = ${email}
    ) AS registrations
    ORDER BY created_at DESC, applicant_type, registration_id
    LIMIT 1
  `;

  return rows[0] || null;
}

async function incrementRateLimit(scope, keyHash, limit) {
  const rows = await database.query`
    INSERT INTO applicant_login_rate_limits (
      scope,
      key_hash,
      window_started_at,
      request_count
    )
    VALUES (${scope}, ${keyHash}, CURRENT_TIMESTAMP, 1)
    ON CONFLICT (scope, key_hash) DO UPDATE
    SET
      window_started_at = CASE
        WHEN applicant_login_rate_limits.window_started_at <=
          CURRENT_TIMESTAMP - INTERVAL '15 minutes'
        THEN CURRENT_TIMESTAMP
        ELSE applicant_login_rate_limits.window_started_at
      END,
      request_count = CASE
        WHEN applicant_login_rate_limits.window_started_at <=
          CURRENT_TIMESTAMP - INTERVAL '15 minutes'
        THEN 1
        ELSE applicant_login_rate_limits.request_count + 1
      END
    RETURNING
      request_count,
      window_started_at AS "windowStartedAt",
      request_count <= ${limit} AS allowed
  `;

  return rows[0];
}

async function createMagicLinkToken({
  applicantType,
  registrationId,
  tokenHash,
  expiresAt
}) {
  if (applicantType === 'digital_forensics') {
    await database.query`
      INSERT INTO applicant_magic_link_tokens (
        registration_id,
        regular_track_registration_id,
        token_hash,
        expires_at
      )
      VALUES (${registrationId}, NULL, ${tokenHash}, ${expiresAt})
    `;
    return;
  }

  if (applicantType === 'regular_track') {
    await database.query`
      INSERT INTO applicant_magic_link_tokens (
        registration_id,
        regular_track_registration_id,
        token_hash,
        expires_at
      )
      VALUES (NULL, ${registrationId}, ${tokenHash}, ${expiresAt})
    `;
    return;
  }

  throw new Error('Unsupported applicant registration type.');
}

async function redeemMagicLinkToken({
  tokenHash,
  sessionTokenHash,
  expiresAt
}) {
  const rows = await database.query`
    WITH token_context AS MATERIALIZED (
      SELECT
        token.token_hash,
        token.registration_id,
        token.regular_track_registration_id,
        COALESCE(digital.email, regular.email) AS applicant_email
      FROM applicant_magic_link_tokens AS token
      LEFT JOIN digital_forensics_registrations AS digital
        ON digital.registration_id = token.registration_id
      LEFT JOIN regular_track_applicants AS regular
        ON regular.registration_id = token.regular_track_registration_id
      WHERE token.token_hash = ${tokenHash}
        AND token.used_at IS NULL
        AND token.expires_at > CURRENT_TIMESTAMP
    ),
    candidates AS MATERIALIZED (
      SELECT
        'digital_forensics'::TEXT AS applicant_type,
        registration_id
      FROM digital_forensics_registrations
      WHERE email = (SELECT applicant_email FROM token_context)
      UNION ALL
      SELECT
        'regular_track'::TEXT AS applicant_type,
        registration_id
      FROM regular_track_applicants
      WHERE email = (SELECT applicant_email FROM token_context)
    ),
    candidate_count AS (
      SELECT COUNT(*)::INTEGER AS count
      FROM candidates
    ),
    sole_candidate AS (
      SELECT applicant_type, registration_id
      FROM candidates
      WHERE (SELECT count FROM candidate_count) = 1
    ),
    redeemed AS (
      UPDATE applicant_magic_link_tokens AS token
      SET used_at = CURRENT_TIMESTAMP
      FROM token_context AS context
      CROSS JOIN candidate_count
      WHERE token.token_hash = context.token_hash
        AND token.used_at IS NULL
        AND token.expires_at > CURRENT_TIMESTAMP
        AND candidate_count.count > 0
      RETURNING token.token_hash
    ),
    created AS (
      INSERT INTO applicant_sessions (
        registration_id,
        regular_track_registration_id,
        verification_registration_id,
        verification_regular_track_registration_id,
        session_token_hash,
        expires_at
      )
      SELECT
        CASE WHEN candidate_count.count = 1
          AND sole_candidate.applicant_type = 'digital_forensics'
          THEN sole_candidate.registration_id END,
        CASE WHEN candidate_count.count = 1
          AND sole_candidate.applicant_type = 'regular_track'
          THEN sole_candidate.registration_id END,
        context.registration_id,
        context.regular_track_registration_id,
        ${sessionTokenHash},
        ${expiresAt}
      FROM redeemed
      JOIN token_context AS context USING (token_hash)
      CROSS JOIN candidate_count
      LEFT JOIN sole_candidate ON TRUE
      RETURNING
        registration_id,
        regular_track_registration_id,
        expires_at
    )
    SELECT
      COALESCE(registration_id, regular_track_registration_id)
        AS "registrationId",
      CASE
        WHEN registration_id IS NOT NULL THEN 'digital_forensics'
        WHEN regular_track_registration_id IS NOT NULL THEN 'regular_track'
        ELSE NULL
      END AS "applicantType",
      registration_id IS NULL
        AND regular_track_registration_id IS NULL AS "selectionRequired",
      expires_at AS "expiresAt"
    FROM created
  `;

  return rows[0] || null;
}

async function findApplicantSession(sessionTokenHash) {
  const rows = await database.query`
    SELECT
      COALESCE(session.registration_id, session.regular_track_registration_id)
        AS "registrationId",
      CASE
        WHEN session.registration_id IS NOT NULL THEN 'digital_forensics'
        WHEN session.regular_track_registration_id IS NOT NULL THEN 'regular_track'
        ELSE NULL
      END AS "applicantType",
      session.registration_id IS NULL
        AND session.regular_track_registration_id IS NULL AS "selectionRequired",
      session.expires_at AS "expiresAt"
    FROM applicant_sessions AS session
    WHERE session.session_token_hash = ${sessionTokenHash}
      AND session.revoked_at IS NULL
      AND session.expires_at > CURRENT_TIMESTAMP
    LIMIT 1
  `;

  return rows[0] || null;
}

async function listApplicantRegistrationsForSession(sessionTokenHash) {
  const rows = await database.query`
    WITH session_email AS (
      SELECT COALESCE(digital.email, regular.email) AS email
      FROM applicant_sessions AS session
      LEFT JOIN digital_forensics_registrations AS digital
        ON digital.registration_id = session.verification_registration_id
      LEFT JOIN regular_track_applicants AS regular
        ON regular.registration_id =
          session.verification_regular_track_registration_id
      WHERE session.session_token_hash = ${sessionTokenHash}
        AND session.revoked_at IS NULL
        AND session.expires_at > CURRENT_TIMESTAMP
        AND session.registration_id IS NULL
        AND session.regular_track_registration_id IS NULL
    )
    SELECT
      registration.applicant_type AS "applicantType",
      registration.registration_id AS "registrationId",
      registration.track,
      registration.status,
      registration.created_at AS "createdAt"
    FROM (
      SELECT
        'digital_forensics'::TEXT AS applicant_type,
        registration_id,
        email,
        'digital_forensics'::TEXT AS track,
        status,
        created_at
      FROM digital_forensics_registrations
      UNION ALL
      SELECT
        'regular_track'::TEXT AS applicant_type,
        registration_id,
        email,
        track,
        status,
        created_at
      FROM regular_track_applicants
    ) AS registration
    JOIN session_email ON session_email.email = registration.email
    ORDER BY registration.created_at DESC,
      registration.applicant_type,
      registration.registration_id
  `;

  return rows;
}

async function selectApplicantRegistration({
  applicantType,
  registrationId,
  sessionTokenHash
}) {
  let rows;

  if (applicantType === 'digital_forensics') {
    rows = await database.query`
      UPDATE applicant_sessions AS session
      SET registration_id = ${registrationId}
      FROM digital_forensics_registrations AS selected
      WHERE session.session_token_hash = ${sessionTokenHash}
        AND session.revoked_at IS NULL
        AND session.expires_at > CURRENT_TIMESTAMP
        AND session.registration_id IS NULL
        AND session.regular_track_registration_id IS NULL
        AND selected.registration_id = ${registrationId}
        AND EXISTS (
          SELECT 1
          FROM (
            SELECT email
            FROM digital_forensics_registrations
            WHERE registration_id = session.verification_registration_id
            UNION ALL
            SELECT email
            FROM regular_track_applicants
            WHERE registration_id =
              session.verification_regular_track_registration_id
          ) AS source
          WHERE source.email = selected.email
        )
      RETURNING session.registration_id AS "registrationId"
    `;
  } else if (applicantType === 'regular_track') {
    rows = await database.query`
      UPDATE applicant_sessions AS session
      SET regular_track_registration_id = ${registrationId}
      FROM regular_track_applicants AS selected
      WHERE session.session_token_hash = ${sessionTokenHash}
        AND session.revoked_at IS NULL
        AND session.expires_at > CURRENT_TIMESTAMP
        AND session.registration_id IS NULL
        AND session.regular_track_registration_id IS NULL
        AND selected.registration_id = ${registrationId}
        AND EXISTS (
          SELECT 1
          FROM (
            SELECT email
            FROM digital_forensics_registrations
            WHERE registration_id = session.verification_registration_id
            UNION ALL
            SELECT email
            FROM regular_track_applicants
            WHERE registration_id =
              session.verification_regular_track_registration_id
          ) AS source
          WHERE source.email = selected.email
        )
      RETURNING session.regular_track_registration_id AS "registrationId"
    `;
  } else {
    throw new Error('Unsupported applicant registration type.');
  }

  return rows[0] || null;
}

async function revokeApplicantSession(sessionTokenHash) {
  const rows = await database.query`
    UPDATE applicant_sessions
    SET revoked_at = CURRENT_TIMESTAMP
    WHERE session_token_hash = ${sessionTokenHash}
      AND revoked_at IS NULL
      AND expires_at > CURRENT_TIMESTAMP
    RETURNING session_token_hash
  `;

  return rows.length > 0;
}

module.exports = {
  createMagicLinkToken,
  findApplicantSession,
  findEligibleApplicant,
  incrementRateLimit,
  listApplicantRegistrationsForSession,
  redeemMagicLinkToken,
  revokeApplicantSession,
  selectApplicantRegistration
};
