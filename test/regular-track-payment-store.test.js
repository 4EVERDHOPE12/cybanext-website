const assert = require('node:assert/strict');
const test = require('node:test');
const database = require('../lib/digital-forensics-database');
const { findLatestPaymentAttemptForApplicant } =
  require('../lib/regular-track-payment-store');

test('latest regular-track payment attempt is selected by recency, not status priority', async (t) => {
  const originalQuery = database.query;
  let sql = '';
  database.query = async (strings) => {
    sql = strings.join('?');
    return [];
  };
  t.after(() => {
    database.query = originalQuery;
  });

  assert.equal(
    await findLatestPaymentAttemptForApplicant('RT-registration'),
    null
  );
  assert.match(
    sql,
    /ORDER BY payment\.created_at DESC,\s*payment\.updated_at DESC,\s*payment\.payment_reference DESC/
  );
  assert.doesNotMatch(sql, /CASE\s+WHEN payment\.status/);
});
