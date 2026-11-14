const crypto = require('node:crypto');
const {
  BATCH_SIZE,
  processDueEvents,
  requeuePermanentFailure
} = require('../lib/email-notification-outbox');

function secretsMatch(first, second) {
  if (typeof first !== 'string' || typeof second !== 'string') {
    return false;
  }
  const firstBuffer = Buffer.from(first);
  const secondBuffer = Buffer.from(second);
  return firstBuffer.length === secondBuffer.length &&
    crypto.timingSafeEqual(firstBuffer, secondBuffer);
}

function isAuthorized(req, secret) {
  const authorization = req.headers?.authorization;
  return typeof authorization === 'string' &&
    authorization.startsWith('Bearer ') &&
    secretsMatch(authorization.slice(7), secret);
}

module.exports = async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const isRecoveryRequest = req.method === 'POST';
  const secret = isRecoveryRequest
    ? process.env.EMAIL_RECOVERY_SECRET
    : process.env.CRON_SECRET;
  if (!secret || (isRecoveryRequest && secretsMatch(secret, process.env.CRON_SECRET))) {
    const operation = isRecoveryRequest
      ? 'Email notification recovery'
      : 'Email notification worker';
    console.error(`${operation} is not configured.`);
    return res.status(500).json({ error: `${operation} is not configured.` });
  }
  if (!isAuthorized(req, secret)) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  if (req.method === 'POST') {
    const { action, eventKey } = req.body || {};
    if (
      action !== 'requeue-permanent-failed' ||
      typeof eventKey !== 'string' ||
      !/^[A-Za-z0-9:_-]{1,256}$/.test(eventKey)
    ) {
      return res.status(400).json({ error: 'Invalid notification recovery request.' });
    }

    try {
      const requeued = await requeuePermanentFailure(eventKey);
      return res.status(requeued ? 200 : 404).json({ requeued });
    } catch (error) {
      console.error('Email notification recovery failed.', {
        code: error && typeof error.code === 'string' ? error.code : 'unknown'
      });
      return res.status(500).json({ error: 'Email notification recovery failed.' });
    }
  }

  try {
    const results = await processDueEvents(BATCH_SIZE);
    return res.status(200).json({
      processed: results.length,
      sent: results.filter((result) => result.status === 'sent').length,
      retryScheduled: results.filter((result) => result.status === 'retry_scheduled').length,
      permanentFailed: results.filter((result) => result.status === 'permanent_failed').length
    });
  } catch (error) {
    console.error('Email notification worker failed.', {
      code: error && typeof error.code === 'string' ? error.code : 'unknown'
    });
    return res.status(500).json({ error: 'Email notification processing failed.' });
  }
};
