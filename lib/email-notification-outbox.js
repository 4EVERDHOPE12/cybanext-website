const database = require('./digital-forensics-database');
const { deliverNotification, MAX_ATTEMPTS } = require('./email-notification');

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

async function claimEvent(eventKey) {
  const rows = await database.query`
    UPDATE email_notification_outbox
    SET status = 'sending',
        attempt_count = attempt_count + 1,
        lease_expires_at = CURRENT_TIMESTAMP + (${LEASE_SECONDS} * INTERVAL '1 second'),
        claim_token = gen_random_uuid(),
        updated_at = CURRENT_TIMESTAMP
    WHERE event_id = (
      SELECT event_id
      FROM email_notification_outbox
      WHERE event_key = ${eventKey}
        AND attempt_count < ${MAX_ATTEMPTS}
        AND (
          (status = 'pending' AND next_attempt_at <= CURRENT_TIMESTAMP)
          OR (status = 'sending' AND lease_expires_at <= CURRENT_TIMESTAMP)
        )
      FOR UPDATE SKIP LOCKED
    )
    RETURNING event_id AS "eventId", event_key AS "eventKey",
      event_type AS "eventType", recipient_email AS "recipientEmail",
      template_data AS "templateData", attempt_count AS "attemptCount",
      claim_token AS "claimToken"
  `;
  return toEvent(rows[0]);
}

async function claimDueEvents(limit = BATCH_SIZE) {
  const boundedLimit = Math.max(1, Math.min(BATCH_SIZE, Number(limit) || BATCH_SIZE));
  const rows = await database.query`
    WITH exhausted AS (
      UPDATE email_notification_outbox
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
      RETURNING event_id, event_key, digital_forensics_registration_id
    ),
    exhausted_registrations AS (
      UPDATE digital_forensics_registrations AS registration
      SET email_notification_status = 'failed',
          updated_at = CURRENT_TIMESTAMP
      FROM exhausted
      WHERE registration.registration_id = exhausted.digital_forensics_registration_id
      RETURNING registration.registration_id
    ),
    due AS (
      SELECT event_id
      FROM email_notification_outbox
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
      UPDATE email_notification_outbox AS outbox
      SET status = 'sending',
          attempt_count = outbox.attempt_count + 1,
          lease_expires_at = CURRENT_TIMESTAMP + (${LEASE_SECONDS} * INTERVAL '1 second'),
          claim_token = gen_random_uuid(),
          updated_at = CURRENT_TIMESTAMP
      FROM due
      WHERE outbox.event_id = due.event_id
      RETURNING outbox.event_id, outbox.event_key, outbox.event_type,
        outbox.recipient_email, outbox.template_data, outbox.attempt_count,
        outbox.claim_token
    )
    SELECT event_id AS "eventId", event_key AS "eventKey",
      event_type AS "eventType", recipient_email AS "recipientEmail",
      template_data AS "templateData", attempt_count AS "attemptCount",
      claim_token AS "claimToken", 'sending'::text AS "claimStatus"
    FROM claimed
    UNION ALL
    SELECT event_id AS "eventId", event_key AS "eventKey",
      NULL::text AS "eventType", NULL::text AS "recipientEmail",
      NULL::jsonb AS "templateData", ${MAX_ATTEMPTS}::integer AS "attemptCount",
      NULL::uuid AS "claimToken", 'permanent_failed'::text AS "claimStatus"
    FROM exhausted
  `;
  return rows.map(toEvent);
}

function getErrorCode(error) {
  const allowedCodes = new Set([
    'configuration_missing',
    'resend_rejected',
    'resend_rate_limited',
    'resend_server_error',
    'network_error',
    'timeout',
    'invalid_response',
    'invalid_template_data',
    'delivery_error'
  ]);
  return allowedCodes.has(error?.notificationErrorCode)
    ? error.notificationErrorCode
    : 'delivery_error';
}

async function recordFailure(event, error) {
  const errorCode = getErrorCode(error);
  const permanent = event.attemptCount >= MAX_ATTEMPTS ||
    errorCode === 'invalid_template_data' ||
    error?.permanentFailure === true;
  const delaySeconds = errorCode === 'configuration_missing'
    ? CONFIGURATION_RETRY_SECONDS
    : Math.min(86400, 60 * (2 ** Math.max(0, event.attemptCount - 1)));
  await database.query`
    WITH updated AS (
    UPDATE email_notification_outbox
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
    RETURNING digital_forensics_registration_id, status
    )
    UPDATE digital_forensics_registrations AS registration
    SET email_notification_status = CASE
      WHEN updated.status = 'permanent_failed' THEN 'failed'
      ELSE 'pending'
    END,
    updated_at = CURRENT_TIMESTAMP
    FROM updated
    WHERE registration.registration_id = updated.digital_forensics_registration_id
  `;
  return permanent ? 'permanent_failed' : 'retry_scheduled';
}

async function recordSuccess(event) {
  await database.query`
    WITH updated AS (
    UPDATE email_notification_outbox
    SET status = 'sent',
        sent_at = CURRENT_TIMESTAMP,
        lease_expires_at = NULL,
        claim_token = NULL,
        last_error_code = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE event_id = ${event.eventId}
      AND status = 'sending'
      AND claim_token = ${event.claimToken}
    RETURNING digital_forensics_registration_id
    )
    UPDATE digital_forensics_registrations AS registration
    SET email_notification_status = 'sent', updated_at = CURRENT_TIMESTAMP
    FROM updated
    WHERE registration.registration_id = updated.digital_forensics_registration_id
  `;
}

async function deliverClaimedEvent(event) {
  try {
    await deliverNotification(event);
  } catch (error) {
    const status = await recordFailure(event, error);
    return { eventKey: event.eventKey, status };
  }
  await recordSuccess(event);
  return { eventKey: event.eventKey, status: 'sent' };
}

async function deliverEventByKey(eventKey) {
  const event = await claimEvent(eventKey);
  if (!event) return { eventKey, status: 'not_claimed' };
  return deliverClaimedEvent(event);
}

async function processDueEvents(limit = BATCH_SIZE) {
  const events = await claimDueEvents(limit);
  const exhausted = events
    .filter((event) => event.claimStatus === 'permanent_failed')
    .map((event) => ({ eventKey: event.eventKey, status: 'permanent_failed' }));
  const claimed = events.filter((event) => event.claimStatus !== 'permanent_failed');
  return [...exhausted, ...await Promise.all(claimed.map(deliverClaimedEvent))];
}

async function requeuePermanentFailure(eventKey) {
  const rows = await database.query`
    WITH requeued AS (
      UPDATE email_notification_outbox
      SET status = 'pending',
          attempt_count = 0,
          next_attempt_at = CURRENT_TIMESTAMP,
          lease_expires_at = NULL,
          claim_token = NULL,
          last_error_code = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE event_key = ${eventKey}
        AND status = 'permanent_failed'
      RETURNING event_key AS "eventKey", digital_forensics_registration_id
    ),
    registration AS (
      UPDATE digital_forensics_registrations AS applicant
      SET email_notification_status = 'pending',
          updated_at = CURRENT_TIMESTAMP
      FROM requeued
      WHERE applicant.registration_id = requeued.digital_forensics_registration_id
      RETURNING applicant.registration_id
    )
    SELECT "eventKey" FROM requeued
  `;
  return rows.length > 0;
}

async function attemptImmediateDelivery(eventKey) {
  try {
    return await deliverEventByKey(eventKey);
  } catch (error) {
    console.error('Email notification processing failed.', {
      code: error && typeof error.code === 'string' ? error.code : 'unknown'
    });
    return { eventKey, status: 'deferred' };
  }
}

module.exports = {
  BATCH_SIZE,
  LEASE_SECONDS,
  attemptImmediateDelivery,
  claimDueEvents,
  deliverEventByKey,
  processDueEvents,
  requeuePermanentFailure
};
