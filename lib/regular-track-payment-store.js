const crypto = require('node:crypto');
const database = require('./digital-forensics-database');
const { REGULAR_TRACKS } = require('./payment-prices');
const { normalizeGhanaPhone } = require('./ghana-phone');
const {
  SMS_CONSENT_POLICY_VERSION,
  SMS_CONSENT_PURPOSE,
  validateSmsConsent
} = require('./sms-consent');

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function createRegistrationId() {
  return `RT-${Date.now()}-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
}

function toApplicant(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    createdAt: row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : row.createdAt,
    updatedAt: row.updatedAt instanceof Date
      ? row.updatedAt.toISOString()
      : row.updatedAt
  };
}

function toPaymentAttempt(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    referenceAmount: Number(row.referenceAmount),
    expectedAmount: Number(row.expectedAmount),
    paymentVerificationTimestamp: row.paymentVerificationTimestamp instanceof Date
      ? row.paymentVerificationTimestamp.toISOString()
      : row.paymentVerificationTimestamp
  };
}

async function createApplicant({
  fullName,
  email,
  phone,
  track,
  smsConsent = false
}) {
  if (!REGULAR_TRACKS.includes(track)) {
    throw new Error('Unsupported regular cybersecurity track.');
  }

  const normalizedPhone = normalizeGhanaPhone(phone);
  validateSmsConsent(smsConsent, normalizedPhone);
  const registrationId = createRegistrationId();
  const rows = await database.query`
    WITH inserted AS (
    INSERT INTO regular_track_applicants (
      registration_id,
      full_name,
      email,
      phone,
      track,
      status
    )
    VALUES (
      ${registrationId},
      ${fullName.trim()},
      ${normalizeEmail(email)},
      ${normalizedPhone},
      ${track},
      'pending'
    )
    RETURNING
      registration_id AS id,
      full_name AS "fullName",
      email,
      phone,
      track,
      status,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    ),
    consent AS (
      INSERT INTO sms_consent_events (
        regular_track_registration_id,
        event_type,
        phone_snapshot,
        purpose,
        policy_version,
        source
      )
      SELECT
        id,
        'grant',
        phone,
        ${SMS_CONSENT_PURPOSE},
        ${SMS_CONSENT_POLICY_VERSION},
        'main_application'
      FROM inserted
      WHERE ${smsConsent}
      RETURNING event_id
    ),
    notification AS (
      INSERT INTO email_notification_outbox (
        event_key, event_type, regular_track_registration_id,
        recipient_email, template_data
      )
      SELECT
        'regular-track-registration:' || id,
        'regular_track_registration_confirmation',
        id,
        email,
        jsonb_build_object('fullName', "fullName", 'track', track)
      FROM inserted
      ON CONFLICT (event_key) DO NOTHING
      RETURNING event_id
    )
    SELECT inserted.* FROM inserted
  `;

  return toApplicant(rows[0]);
}

async function findApplicant(registrationId) {
  const rows = await database.query`
    SELECT
      registration_id AS id,
      full_name AS "fullName",
      email,
      phone,
      track,
      status,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM regular_track_applicants
    WHERE registration_id = ${registrationId}
    LIMIT 1
  `;

  return toApplicant(rows[0]);
}

async function createPaymentAttempt({
  reference,
  registrationId,
  referenceAmount,
  expectedAmount,
  expectedCurrency
}) {
  const rows = await database.query`
    WITH applicant AS MATERIALIZED (
      SELECT applicant.registration_id
      FROM regular_track_applicants AS applicant
      WHERE applicant.registration_id = ${registrationId}
        AND applicant.status = 'pending'
        AND NOT EXISTS (
          SELECT 1
          FROM regular_track_payment_attempts AS active
          WHERE active.registration_id = applicant.registration_id
            AND active.status IN ('initializing', 'payment_initiated')
        )
      FOR UPDATE
    ),
    inserted AS (
      INSERT INTO regular_track_payment_attempts (
        payment_reference,
        registration_id,
        reference_amount,
        reference_currency,
        expected_amount,
        expected_currency,
        status
      )
      SELECT
        ${reference},
        applicant.registration_id,
        ${referenceAmount},
        'USD',
        ${expectedAmount},
        ${expectedCurrency},
        'initializing'
      FROM applicant
      RETURNING
        payment_reference AS reference,
        registration_id AS "registrationId",
        reference_amount AS "referenceAmount",
        reference_currency AS "referenceCurrency",
        expected_amount AS "expectedAmount",
        expected_currency AS "expectedCurrency",
        status,
        verified_transaction_id AS "verifiedTransactionId",
        payment_verification_timestamp AS "paymentVerificationTimestamp",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    ),
    updated AS (
      UPDATE regular_track_applicants AS applicant
      SET status = 'payment_initiated', updated_at = CURRENT_TIMESTAMP
      FROM inserted
      WHERE applicant.registration_id = inserted."registrationId"
      RETURNING applicant.registration_id
    )
    SELECT inserted.*
    FROM inserted
    JOIN updated ON updated.registration_id = inserted."registrationId"
  `;

  return toPaymentAttempt(rows[0]);
}

async function updatePaymentAttemptStatus(reference, status) {
  if (!['payment_initiated', 'initialization_failed'].includes(status)) {
    throw new Error('Unsupported regular-track payment status.');
  }

  if (status === 'initialization_failed') {
    const rows = await database.query`
      WITH applicant AS MATERIALIZED (
        SELECT registration_id
        FROM regular_track_applicants
        WHERE registration_id = (
          SELECT registration_id
          FROM regular_track_payment_attempts
          WHERE payment_reference = ${reference}
        )
        FOR UPDATE
      ),
      updated AS (
        UPDATE regular_track_payment_attempts
        SET status = ${status}, updated_at = CURRENT_TIMESTAMP
        WHERE payment_reference = ${reference}
          AND status = 'initializing'
          AND registration_id IN (
            SELECT registration_id FROM applicant
          )
        RETURNING registration_id
      ),
      applicant_updated AS (
        UPDATE regular_track_applicants AS applicant
        SET status = CASE
          WHEN EXISTS (
            SELECT 1
            FROM regular_track_payment_attempts AS active
            WHERE active.registration_id = applicant.registration_id
              AND active.payment_reference <> ${reference}
              AND active.status IN ('initializing', 'payment_initiated')
          ) THEN 'payment_initiated'
          ELSE 'pending'
        END,
        updated_at = CURRENT_TIMESTAMP
        FROM updated
        WHERE applicant.registration_id = updated.registration_id
          AND applicant.status <> 'payment_verified'
        RETURNING applicant.registration_id
      )
      SELECT updated.registration_id AS "registrationId"
      FROM updated
      JOIN applicant_updated
        ON applicant_updated.registration_id = updated.registration_id
    `;

    return rows[0] || null;
  }

  const rows = await database.query`
    UPDATE regular_track_payment_attempts
    SET status = ${status}, updated_at = CURRENT_TIMESTAMP
    WHERE payment_reference = ${reference}
      AND status = 'initializing'
    RETURNING payment_reference AS reference, registration_id AS "registrationId"
  `;

  return rows[0] || null;
}

async function findPaymentAttempt(reference) {
  const rows = await database.query`
    SELECT
      payment.payment_reference AS reference,
      payment.registration_id AS "registrationId",
      payment.reference_amount AS "referenceAmount",
      payment.reference_currency AS "referenceCurrency",
      payment.expected_amount AS "expectedAmount",
      payment.expected_currency AS "expectedCurrency",
      payment.status,
      payment.verified_transaction_id AS "verifiedTransactionId",
      payment.payment_verification_timestamp AS "paymentVerificationTimestamp",
      applicant.email,
      applicant.track,
      applicant.status AS "applicantStatus"
    FROM regular_track_payment_attempts AS payment
    JOIN regular_track_applicants AS applicant
      ON applicant.registration_id = payment.registration_id
    WHERE payment.payment_reference = ${reference}
    LIMIT 1
  `;

  return toPaymentAttempt(rows[0]);
}

async function markPaymentAttemptFailed(reference) {
  const rows = await database.query`
    WITH applicant AS MATERIALIZED (
      SELECT registration_id
      FROM regular_track_applicants
      WHERE registration_id = (
        SELECT registration_id
        FROM regular_track_payment_attempts
        WHERE payment_reference = ${reference}
      )
      FOR UPDATE
    ),
    failed AS (
      UPDATE regular_track_payment_attempts
      SET status = 'failed', updated_at = CURRENT_TIMESTAMP
      WHERE payment_reference = ${reference}
        AND status IN ('initializing', 'payment_initiated')
        AND registration_id IN (
          SELECT registration_id FROM applicant
        )
      RETURNING registration_id
    ),
    updated AS (
      UPDATE regular_track_applicants AS applicant
      SET status = CASE
        WHEN EXISTS (
          SELECT 1
          FROM regular_track_payment_attempts AS active
          WHERE active.registration_id = applicant.registration_id
            AND active.payment_reference <> ${reference}
            AND active.status IN ('initializing', 'payment_initiated')
        ) THEN 'payment_initiated'
        ELSE 'pending'
      END,
      updated_at = CURRENT_TIMESTAMP
      FROM failed
      WHERE applicant.registration_id = failed.registration_id
        AND applicant.status <> 'payment_verified'
      RETURNING applicant.registration_id
    ),
    notification AS (
      INSERT INTO email_notification_outbox (
        event_key, event_type, regular_track_registration_id,
        recipient_email, template_data
      )
      SELECT
        'regular-track-payment-failure:' || failed.registration_id || ':' || ${reference},
        'regular_track_payment_failure',
        failed.registration_id,
        applicant.email,
        jsonb_build_object('fullName', applicant.full_name, 'track', applicant.track)
      FROM failed
      JOIN regular_track_applicants AS applicant
        ON applicant.registration_id = failed.registration_id
      ON CONFLICT (event_key) DO NOTHING
      RETURNING event_id
    )
    SELECT registration_id AS "registrationId" FROM updated
  `;

  return rows[0] ? {
    ...rows[0],
    eventKey: `regular-track-payment-failure:${rows[0].registrationId}:${reference}`
  } : null;
}

async function markPaymentAttemptVerified(reference, transactionId) {
  const rows = await database.query`
    WITH applicant AS MATERIALIZED (
      SELECT registration_id
      FROM regular_track_applicants
      WHERE registration_id = (
        SELECT registration_id
        FROM regular_track_payment_attempts
        WHERE payment_reference = ${reference}
      )
        AND status <> 'payment_verified'
      FOR UPDATE
    ),
    verified AS (
      UPDATE regular_track_payment_attempts
      SET
        status = 'payment_verified',
        verified_transaction_id = ${transactionId},
        payment_verification_timestamp = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE payment_reference = ${reference}
        AND status IN ('initializing', 'payment_initiated')
        AND verified_transaction_id IS NULL
        AND registration_id IN (
          SELECT registration_id FROM applicant
        )
      RETURNING registration_id, payment_reference
    ),
    updated AS (
      UPDATE regular_track_applicants AS applicant
      SET status = 'payment_verified', updated_at = CURRENT_TIMESTAMP
      FROM verified
      WHERE applicant.registration_id = verified.registration_id
      RETURNING applicant.registration_id
    ),
    notification AS (
      INSERT INTO email_notification_outbox (
        event_key, event_type, regular_track_registration_id,
        recipient_email, template_data
      )
      SELECT
        'regular-track-payment-success:' || applicant.registration_id || ':' || verified.payment_reference,
        'regular_track_payment_success',
        applicant.registration_id,
        applicant.email,
        jsonb_build_object('fullName', applicant.full_name, 'track', applicant.track)
      FROM verified
      JOIN updated ON updated.registration_id = verified.registration_id
      JOIN regular_track_applicants AS applicant
        ON applicant.registration_id = verified.registration_id
      ON CONFLICT (event_key) DO NOTHING
      RETURNING event_id
    )
    SELECT verified.payment_reference AS reference,
      verified.registration_id AS "registrationId"
    FROM verified
    JOIN updated ON updated.registration_id = verified.registration_id
  `;

  return rows[0] ? {
    ...rows[0],
    eventKey: `regular-track-payment-success:${rows[0].registrationId}:${rows[0].reference}`
  } : null;
}

module.exports = {
  createApplicant,
  createPaymentAttempt,
  findApplicant,
  findPaymentAttempt,
  markPaymentAttemptFailed,
  markPaymentAttemptVerified,
  normalizeEmail,
  updatePaymentAttemptStatus
};
