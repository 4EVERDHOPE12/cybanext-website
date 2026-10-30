const crypto = require('crypto');
const database = require('./digital-forensics-database');
const { getPaymentPrice } = require('./payment-prices');

const PATCH_FIELDS = new Set([
  'fullName',
  'email',
  'phone',
  'course',
  'status',
  'pricingOption',
  'expectedAmount',
  'expectedCurrency',
  'paymentReference',
  'verifiedTransactionId',
  'paymentVerificationTimestamp',
  'emailNotificationStatus',
  'smsNotificationStatus'
]);

function sanitizePhone(phone) {
  return typeof phone === 'string' ? phone.trim() : '';
}

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function normalizeTimestamp(value) {
  if (!value) {
    return null;
  }

  const timestamp = value instanceof Date ? value : new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toISOString();
}

function toRegistration(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    expectedAmount: Number(row.expectedAmount),
    paymentVerificationTimestamp:
      normalizeTimestamp(row.paymentVerificationTimestamp),
    createdAt: normalizeTimestamp(row.createdAt),
    updatedAt: normalizeTimestamp(row.updatedAt)
  };
}

async function createRegistration({ fullName, email, phone }) {
  const coursePrice = getPaymentPrice('digital_forensics', 'GHS');

  if (!coursePrice) {
    throw new Error('Digital Forensics pricing is unavailable.');
  }

  const registrationId =
    `DF-${Date.now()}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  const rows = await database.query`
    INSERT INTO digital_forensics_registrations (
      registration_id,
      full_name,
      email,
      phone,
      course,
      status,
      expected_amount,
      expected_currency,
      email_notification_status,
      sms_notification_status
    )
    VALUES (
      ${registrationId},
      ${String(fullName || '').trim()},
      ${normalizeEmail(email)},
      ${sanitizePhone(phone)},
      'digital_forensics',
      'pending',
      ${Number(coursePrice.chargeAmountGhs)},
      'GHS',
      'pending',
      'pending'
    )
    RETURNING
      registration_id AS id,
      full_name AS "fullName",
      email,
      phone,
      course,
      status,
      pricing_option AS "pricingOption",
      expected_amount AS "expectedAmount",
      expected_currency AS "expectedCurrency",
      payment_reference AS "paymentReference",
      verified_transaction_id AS "verifiedTransactionId",
      payment_verification_timestamp AS "paymentVerificationTimestamp",
      email_notification_status AS "emailNotificationStatus",
      sms_notification_status AS "smsNotificationStatus",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
  `;

  return toRegistration(rows[0]);
}

async function findRegistration(registrationId) {
  const rows = await database.query`
    SELECT
      registration_id AS id,
      full_name AS "fullName",
      email,
      phone,
      course,
      status,
      pricing_option AS "pricingOption",
      expected_amount AS "expectedAmount",
      expected_currency AS "expectedCurrency",
      payment_reference AS "paymentReference",
      verified_transaction_id AS "verifiedTransactionId",
      payment_verification_timestamp AS "paymentVerificationTimestamp",
      email_notification_status AS "emailNotificationStatus",
      sms_notification_status AS "smsNotificationStatus",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM digital_forensics_registrations
    WHERE registration_id = ${registrationId}
    LIMIT 1
  `;

  return toRegistration(rows[0]);
}

async function updateRegistration(registrationId, patch = {}, conditions = {}) {
  for (const field of Object.keys(patch)) {
    if (!PATCH_FIELDS.has(field)) {
      throw new Error(`Unsupported registration field: ${field}`);
    }
  }

  const serializedPatch = JSON.stringify(patch);
  const rows = await database.query`
    UPDATE digital_forensics_registrations AS registration
    SET
      full_name = CASE WHEN patch ? 'fullName' THEN patch->>'fullName' ELSE registration.full_name END,
      email = CASE WHEN patch ? 'email' THEN patch->>'email' ELSE registration.email END,
      phone = CASE WHEN patch ? 'phone' THEN patch->>'phone' ELSE registration.phone END,
      course = CASE WHEN patch ? 'course' THEN patch->>'course' ELSE registration.course END,
      status = CASE WHEN patch ? 'status' THEN patch->>'status' ELSE registration.status END,
      pricing_option = CASE WHEN patch ? 'pricingOption' THEN patch->>'pricingOption' ELSE registration.pricing_option END,
      expected_amount = CASE WHEN patch ? 'expectedAmount' THEN (patch->>'expectedAmount')::numeric ELSE registration.expected_amount END,
      expected_currency = CASE WHEN patch ? 'expectedCurrency' THEN patch->>'expectedCurrency' ELSE registration.expected_currency END,
      payment_reference = CASE WHEN patch ? 'paymentReference' THEN patch->>'paymentReference' ELSE registration.payment_reference END,
      verified_transaction_id = CASE WHEN patch ? 'verifiedTransactionId' THEN patch->>'verifiedTransactionId' ELSE registration.verified_transaction_id END,
      payment_verification_timestamp = CASE WHEN patch ? 'paymentVerificationTimestamp' THEN (patch->>'paymentVerificationTimestamp')::timestamptz ELSE registration.payment_verification_timestamp END,
      email_notification_status = CASE WHEN patch ? 'emailNotificationStatus' THEN patch->>'emailNotificationStatus' ELSE registration.email_notification_status END,
      sms_notification_status = CASE WHEN patch ? 'smsNotificationStatus' THEN patch->>'smsNotificationStatus' ELSE registration.sms_notification_status END,
      updated_at = CURRENT_TIMESTAMP
    FROM (SELECT ${serializedPatch}::jsonb AS patch) AS input
    WHERE registration.registration_id = ${registrationId}
      AND (${conditions.expectedStatus === undefined} OR registration.status = ${conditions.expectedStatus ?? null})
      AND (${conditions.expectedPaymentReference === undefined} OR registration.payment_reference IS NOT DISTINCT FROM ${conditions.expectedPaymentReference ?? null})
    RETURNING
      registration.registration_id AS id,
      registration.full_name AS "fullName",
      registration.email,
      registration.phone,
      registration.course,
      registration.status,
      registration.pricing_option AS "pricingOption",
      registration.expected_amount AS "expectedAmount",
      registration.expected_currency AS "expectedCurrency",
      registration.payment_reference AS "paymentReference",
      registration.verified_transaction_id AS "verifiedTransactionId",
      registration.payment_verification_timestamp AS "paymentVerificationTimestamp",
      registration.email_notification_status AS "emailNotificationStatus",
      registration.sms_notification_status AS "smsNotificationStatus",
      registration.created_at AS "createdAt",
      registration.updated_at AS "updatedAt"
  `;

  return toRegistration(rows[0]);
}

module.exports = {
  createRegistration,
  findRegistration,
  normalizeEmail,
  sanitizePhone,
  updateRegistration
};
