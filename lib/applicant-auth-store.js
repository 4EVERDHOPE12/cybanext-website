const database = require('./digital-forensics-database');

async function findEligibleApplicant(email) {
  const rows = await database.query`
    SELECT registration_id AS "registrationId"
    FROM digital_forensics_registrations
    WHERE email = ${email}
    ORDER BY created_at DESC
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

async function createMagicLinkToken({ registrationId, tokenHash, expiresAt }) {
  await database.query`
    INSERT INTO applicant_magic_link_tokens (
      registration_id,
      token_hash,
      expires_at
    )
    VALUES (${registrationId}, ${tokenHash}, ${expiresAt})
  `;
}

async function redeemMagicLinkToken({
  tokenHash,
  sessionTokenHash,
  expiresAt
}) {
  const rows = await database.query`
    WITH redeemed AS (
      UPDATE applicant_magic_link_tokens
      SET used_at = CURRENT_TIMESTAMP
      WHERE token_hash = ${tokenHash}
        AND used_at IS NULL
        AND expires_at > CURRENT_TIMESTAMP
      RETURNING registration_id
    ),
    created AS (
      INSERT INTO applicant_sessions (
        registration_id,
        session_token_hash,
        expires_at
      )
      SELECT registration_id, ${sessionTokenHash}, ${expiresAt}
      FROM redeemed
      RETURNING registration_id, expires_at
    )
    SELECT
      registration_id AS "registrationId",
      expires_at AS "expiresAt"
    FROM created
  `;

  return rows[0] || null;
}

async function findApplicantSession(sessionTokenHash) {
  const rows = await database.query`
    SELECT
      registration_id AS "registrationId",
      expires_at AS "expiresAt"
    FROM applicant_sessions
    WHERE session_token_hash = ${sessionTokenHash}
      AND revoked_at IS NULL
      AND expires_at > CURRENT_TIMESTAMP
    LIMIT 1
  `;

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
  redeemMagicLinkToken,
  revokeApplicantSession
};
