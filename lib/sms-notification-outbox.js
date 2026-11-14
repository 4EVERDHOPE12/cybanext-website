const database = require('./digital-forensics-database');
const { sendPaymentSuccessSms } = require('./arkesel-sms');

const MAX_ATTEMPTS = 5;
const LEASE_SECONDS = 60;
const BATCH_SIZE = 10;
const CONFIGURATION_RETRY_SECONDS = 3600;

function toEvent(row) {
  if (!row) return null;
  return {
    ...row,
    templateData: typeof row.templateData === 'string'
      ? JSON.parse(row.templateData)
      : row.templateData
  };
}

async function claimDueEvents(limit = BATCH_SIZE) {
  const boundedLimit = Math.max(1, Math.min(BATCH_SIZE, Number(limit) || BATCH_SIZE));
  const rows = await database.query`
    WITH exhausted AS (
      UPDATE sms_notification_outbox
      SET status = 'permanent_failed',
          lease_expires_at = NULL,
          claim_token = NULL,
          last_error_code = 'max_attempts',
          updated_at = CURRENT_TIMESTAMP
      WHERE attempt_count >= ${MAX_ATTEMPTS}
        AND (
          (status = 'pending' AND next_attempt_at <= CURRENT_TIMESTAMP)
          OR (status = 'sending' AND lease_expires_at <= CURRENT_TIMESTAMP)
        )
      RETURNING event_id, event_key
    ),
    due AS (
      SELECT event_id
      FROM sms_notification_outbox
      WHERE attempt_count < ${MAX_ATTEMPTS}
        AND (
          (status = 'pending' AND next_attempt_at <= CURRENT_TIMESTAMP)
          OR (status = 'sending' AND lease_expires_at <= CURRENT_TIMESTAMP)
        )
      ORDER BY next_attempt_at, created_at
      FOR UPDATE SKIP LOCKED
      LIMIT ${boundedLimit}
    ),
    claimed AS (
      UPDATE sms_notification_outbox AS outbox
      SET status = 'sending',
          attempt_count = outbox.attempt_count + 1,
          lease_expires_at = CURRENT_TIMESTAMP + (${LEASE_SECONDS} * INTERVAL '1 second'),
          claim_token = gen_random_uuid(),
          updated_at = CURRENT_TIMESTAMP
      FROM due
      WHERE outbox.event_id = due.event_id
      RETURNING outbox.event_id, outbox.event_key, outbox.event_type,
        outbox.regular_track_registration_id, outbox.digital_forensics_registration_id,
        outbox.phone_snapshot, outbox.template_data, outbox.attempt_count,
        outbox.claim_token
    )
    SELECT event_id AS "eventId", event_key AS "eventKey",
      event_type AS "eventType",
      regular_track_registration_id AS "regularTrackRegistrationId",
      digital_forensics_registration_id AS "digitalForensicsRegistrationId",
      phone_snapshot AS "phoneSnapshot", template_data AS "templateData",
      attempt_count AS "attemptCount", claim_token AS "claimToken",
      'sending'::text AS "claimStatus"
    FROM claimed
    UNION ALL
    SELECT event_id AS "eventId", event_key AS "eventKey",
      NULL::text AS "eventType", NULL::text AS "regularTrackRegistrationId",
      NULL::text AS "digitalForensicsRegistrationId", NULL::text AS "phoneSnapshot",
      NULL::jsonb AS "templateData", ${MAX_ATTEMPTS}::integer AS "attemptCount",
      NULL::uuid AS "claimToken", 'permanent_failed'::text AS "claimStatus"
    FROM exhausted
  `;
  return rows.map(toEvent);
}

async function hasCurrentConsent(event) {
  const rows = await database.query`
    SELECT EXISTS (
      SELECT 1
      FROM sms_notification_outbox AS outbox
      JOIN regular_track_applicants AS registration
        ON registration.registration_id = outbox.regular_track_registration_id
      JOIN LATERAL (
        SELECT event_type, phone_snapshot
        FROM sms_consent_events
        WHERE regular_track_registration_id = registration.registration_id
        ORDER BY occurred_at DESC, event_id DESC
        LIMIT 1
      ) AS consent ON true
      WHERE outbox.event_id = ${event.eventId}
        AND outbox.status = 'sending'
        AND outbox.claim_token = ${event.claimToken}
        AND registration.status = 'payment_verified'
        AND registration.phone = outbox.phone_snapshot
        AND consent.event_type = 'grant'
        AND consent.phone_snapshot = outbox.phone_snapshot
      UNION ALL
      SELECT 1
      FROM sms_notification_outbox AS outbox
      JOIN digital_forensics_registrations AS registration
        ON registration.registration_id = outbox.digital_forensics_registration_id
      JOIN LATERAL (
        SELECT event_type, phone_snapshot
        FROM sms_consent_events
        WHERE digital_forensics_registration_id = registration.registration_id
        ORDER BY occurred_at DESC, event_id DESC
        LIMIT 1
      ) AS consent ON true
      WHERE outbox.event_id = ${event.eventId}
        AND outbox.status = 'sending'
        AND outbox.claim_token = ${event.claimToken}
        AND registration.status = 'payment_verified'
        AND registration.phone = outbox.phone_snapshot
        AND consent.event_type = 'grant'
        AND consent.phone_snapshot = outbox.phone_snapshot
    ) AS eligible
  `;
  return rows[0]?.eligible === true;
}

async function recordCancellation(event) {
  const rows = await database.query`
    UPDATE sms_notification_outbox
    SET status = 'cancelled',
        lease_expires_at = NULL,
        claim_token = NULL,
        last_error_code = 'consent_not_active',
        updated_at = CURRENT_TIMESTAMP
    WHERE event_id = ${event.eventId}
      AND status = 'sending'
      AND claim_token = ${event.claimToken}
    RETURNING event_id
  `;
  return rows.length > 0;
}

function getErrorCode(error) {
  const allowedCodes = new Set([
    'configuration_missing',
    'arkesel_rejected',
    'arkesel_rate_limited',
    'arkesel_server_error',
    'network_error',
    'timeout',
    'invalid_response',
    'invalid_phone',
    'invalid_template_data',
    'eligibility_check_failed',
    'delivery_error'
  ]);
  return allowedCodes.has(error?.notificationErrorCode)
    ? error.notificationErrorCode
    : 'delivery_error';
}

async function recordFailure(event, error) {
  const errorCode = getErrorCode(error);
  const permanent = event.attemptCount >= MAX_ATTEMPTS ||
    errorCode === 'invalid_phone' ||
    errorCode === 'invalid_template_data' ||
    error?.permanentFailure === true;
  const delaySeconds = errorCode === 'configuration_missing'
    ? CONFIGURATION_RETRY_SECONDS
    : Math.min(86400, 60 * (2 ** Math.max(0, event.attemptCount - 1)));
  const rows = await database.query`
    UPDATE sms_notification_outbox
    SET status = ${permanent ? 'permanent_failed' : 'pending'},
        next_attempt_at = CASE WHEN ${permanent} THEN next_attempt_at
          ELSE CURRENT_TIMESTAMP + (${delaySeconds} * INTERVAL '1 second') END,
        lease_expires_at = NULL,
        claim_token = NULL,
        last_error_code = ${event.attemptCount >= MAX_ATTEMPTS ? 'max_attempts' : errorCode},
        updated_at = CURRENT_TIMESTAMP
    WHERE event_id = ${event.eventId}
      AND status = 'sending'
      AND claim_token = ${event.claimToken}
    RETURNING event_id
  `;
  if (!rows.length) return 'lease_lost';
  return permanent ? 'permanent_failed' : 'retry_scheduled';
}

async function recordSuccess(event, providerMessageId) {
  const rows = await database.query`
    UPDATE sms_notification_outbox
    SET status = 'sent',
        sent_at = CURRENT_TIMESTAMP,
        lease_expires_at = NULL,
        claim_token = NULL,
        provider_message_id = ${providerMessageId},
        last_error_code = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE event_id = ${event.eventId}
      AND status = 'sending'
      AND claim_token = ${event.claimToken}
    RETURNING event_id
  `;
  return rows.length > 0;
}

async function deliverClaimedEvent(event) {
  if (event.claimStatus === 'permanent_failed') {
    return { eventKey: event.eventKey, status: 'permanent_failed' };
  }

  let eligible;
  try {
    eligible = await hasCurrentConsent(event);
  } catch {
    return {
      eventKey: event.eventKey,
      status: await recordFailure(event, {
        notificationErrorCode: 'eligibility_check_failed'
      })
    };
  }

  if (!eligible) {
    const cancelled = await recordCancellation(event);
    return { eventKey: event.eventKey, status: cancelled ? 'cancelled' : 'lease_lost' };
  }

  try {
    const { providerMessageId } = await sendPaymentSuccessSms(event);
    const saved = await recordSuccess(event, providerMessageId);
    return { eventKey: event.eventKey, status: saved ? 'sent' : 'lease_lost' };
  } catch (error) {
    return {
      eventKey: event.eventKey,
      status: await recordFailure(event, error)
    };
  }
}

async function processDueEvents(limit = BATCH_SIZE) {
  const events = await claimDueEvents(limit);
  return Promise.all(events.map(deliverClaimedEvent));
}

module.exports = {
  BATCH_SIZE,
  CONFIGURATION_RETRY_SECONDS,
  LEASE_SECONDS,
  MAX_ATTEMPTS,
  claimDueEvents,
  hasCurrentConsent,
  processDueEvents
};
