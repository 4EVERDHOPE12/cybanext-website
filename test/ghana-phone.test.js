const assert = require('node:assert/strict');
const test = require('node:test');

process.env.QUALIFICATION_TOKEN_SECRET =
  'test-only-qualification-token-secret-with-more-than-32-characters';

const { normalizeGhanaPhone } = require('../lib/ghana-phone');
const {
  createQualificationToken,
  verifyQualificationToken
} = require('../lib/qualification-token');

test('optional Ghana phone input preserves an empty value', () => {
  assert.equal(normalizeGhanaPhone(undefined), '');
  assert.equal(normalizeGhanaPhone(''), '');
  assert.equal(normalizeGhanaPhone('   '), '');
});

test('local, international, and no-plus Ghana formats normalize to E.164', () => {
  assert.equal(normalizeGhanaPhone('0241234567'), '+233241234567');
  assert.equal(normalizeGhanaPhone('+233241234567'), '+233241234567');
  assert.equal(normalizeGhanaPhone('233241234567'), '+233241234567');
});

test('malformed, non-Ghanaian, and overlength numbers are rejected', () => {
  for (const value of ['not-a-number', '+12025550123', '2'.repeat(31)]) {
    assert.throws(() => normalizeGhanaPhone(value), /valid Ghanaian phone number/);
  }
});

test('qualification tokens carry the same normalized Ghana phone used by registration', () => {
  const token = createQualificationToken({
    name: 'Test Applicant',
    email: 'applicant@example.com',
    phone: '0241234567',
    track: 'incident_response'
  });

  assert.equal(verifyQualificationToken(token).phone, '+233241234567');
});
