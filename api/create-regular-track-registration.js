const {
  REGULAR_TRACKS
} = require('../lib/payment-prices');
const {
  createApplicant
} = require('../lib/regular-track-payment-store');
const { attemptImmediateDelivery } = require('../lib/email-notification-outbox');
const {
  verifyQualificationToken
} = require('../lib/qualification-token');
const { normalizeGhanaPhone } = require('../lib/ghana-phone');
const { validateSmsConsent } = require('../lib/sms-consent');

function createHandler(store = { createApplicant }, notify = async () => {}) {
  return async function createRegularTrackRegistration(req, res) {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed.' });
    }

    const body = req.body || {};
    const claims = verifyQualificationToken(body.qualificationToken);
    if (!claims || !REGULAR_TRACKS.includes(claims.track)) {
      return res.status(403).json({
        error: 'A valid qualified cybersecurity application is required.'
      });
    }

    const fullName = typeof body.fullName === 'string'
      ? body.fullName.trim()
      : '';
    const email = typeof body.email === 'string'
      ? body.email.trim().toLowerCase()
      : '';
    let phone;
    try {
      phone = normalizeGhanaPhone(body.phone);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const smsConsent = body.smsConsent === undefined
      ? false
      : body.smsConsent;

    try {
      validateSmsConsent(smsConsent, phone);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    if (
      !fullName ||
      fullName.length > 120 ||
      fullName !== claims.name ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254 ||
      email !== claims.email ||
      phone !== claims.phone
    ) {
      return res.status(400).json({
        error: 'Registration details do not match the qualified application.'
      });
    }

    try {
      const applicant = await store.createApplicant({
        fullName,
        email,
        phone,
        track: claims.track,
        smsConsent
      });
      await notify(`regular-track-registration:${applicant.id}`);

      return res.status(200).json({
        registrationId: applicant.id,
        track: applicant.track,
        status: applicant.status
      });
    } catch (error) {
      console.error('Regular-track registration creation failed.', {
        code: error && typeof error.code === 'string' ? error.code : 'unknown'
      });
      return res.status(502).json({
        error: 'We could not save your internship registration. Please try again.'
      });
    }
  };
}

module.exports = createHandler(undefined, attemptImmediateDelivery);
module.exports.createHandler = createHandler;
