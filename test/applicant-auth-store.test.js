const assert = require('node:assert/strict');
const test = require('node:test');
const database = require('../lib/digital-forensics-database');
const authStore = require('../lib/applicant-auth-store');

test('magic-link redemption and session creation use one conditional SQL statement', async (t) => {
  const originalQuery = database.query;
  let sqlText = '';
  let values = [];

  database.query = async (strings, ...parameters) => {
    sqlText = strings.join('?');
    values = parameters;
    return [{ registrationId: 'DF-test-registration' }];
  };
  t.after(() => {
    database.query = originalQuery;
  });

  const result = await authStore.redeemMagicLinkToken({
    tokenHash: 'a'.repeat(64),
    sessionTokenHash: 'b'.repeat(64),
    expiresAt: new Date('2026-10-20T12:30:00.000Z')
  });

  assert.equal(result.registrationId, 'DF-test-registration');
  assert.match(sqlText, /WITH redeemed AS/);
  assert.match(sqlText, /UPDATE applicant_magic_link_tokens/);
  assert.match(sqlText, /used_at IS NULL/);
  assert.match(sqlText, /expires_at > CURRENT_TIMESTAMP/);
  assert.match(sqlText, /INSERT INTO applicant_sessions/);
  assert.match(sqlText, /FROM redeemed/);
  assert.equal(values[0], 'a'.repeat(64));
  assert.equal(values[1], 'b'.repeat(64));
});

test('applicant lookup uses the normalized existing registration model', async (t) => {
  const originalQuery = database.query;
  let sqlText = '';
  let values = [];

  database.query = async (strings, ...parameters) => {
    sqlText = strings.join('?');
    values = parameters;
    return [{ registrationId: 'DF-test-registration' }];
  };
  t.after(() => {
    database.query = originalQuery;
  });

  const result = await authStore.findEligibleApplicant('applicant@example.com');

  assert.equal(result.registrationId, 'DF-test-registration');
  assert.match(sqlText, /FROM digital_forensics_registrations/);
  assert.match(sqlText, /WHERE email = \?/);
  assert.deepEqual(values, ['applicant@example.com']);
});

test('session revocation is conditional, persistent, and keyed by the session hash', async (t) => {
  const originalQuery = database.query;
  let sqlText = '';
  let values = [];

  database.query = async (strings, ...parameters) => {
    sqlText = strings.join('?');
    values = parameters;
    return [{ sessionTokenHash: 'a'.repeat(64) }];
  };
  t.after(() => {
    database.query = originalQuery;
  });

  const revoked = await authStore.revokeApplicantSession('a'.repeat(64));

  assert.equal(revoked, true);
  assert.match(sqlText, /UPDATE applicant_sessions/);
  assert.match(sqlText, /SET revoked_at = CURRENT_TIMESTAMP/);
  assert.match(sqlText, /revoked_at IS NULL/);
  assert.match(sqlText, /expires_at > CURRENT_TIMESTAMP/);
  assert.deepEqual(values, ['a'.repeat(64)]);
});

test('session revocation returns false when no active session matched', async (t) => {
  const originalQuery = database.query;
  database.query = async () => [];
  t.after(() => {
    database.query = originalQuery;
  });

  assert.equal(await authStore.revokeApplicantSession('b'.repeat(64)), false);
});
