const crypto = require('node:crypto');
const {
  BATCH_SIZE,
  processDueEvents
} = require('../lib/sms-notification-outbox');

function isAuthorized(req, secret) {
  const authorization = req.headers?.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    return false;
  }
  const provided = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(secret);
  return provided.length === expected.length &&
    crypto.timingSafeEqual(provided, expected);
}

module.exports = async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('SMS notification worker is not configured.');
    return res.status(500).json({ error: 'SMS notification worker is not configured.' });
  }
  if (!isAuthorized(req, secret)) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  try {
    const results = await processDueEvents(BATCH_SIZE);
    return res.status(200).json({
      processed: results.length,
      sent: results.filter((result) => result.status === 'sent').length,
      retryScheduled: results.filter((result) => result.status === 'retry_scheduled').length,
      permanentFailed: results.filter((result) => result.status === 'permanent_failed').length,
      cancelled: results.filter((result) => result.status === 'cancelled').length
    });
  } catch (error) {
    console.error('SMS notification worker failed.', {
      code: error && typeof error.code === 'string' ? error.code : 'unknown'
    });
    return res.status(500).json({ error: 'SMS notification processing failed.' });
  }
};
