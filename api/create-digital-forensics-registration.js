const { createRegistration } = require('../lib/digital-forensics-store');
const { attemptImmediateDelivery } = require('../lib/email-notification-outbox');
const { normalizeGhanaPhone } = require('../lib/ghana-phone');
const {
  SMS_CONSENT_SOURCES,
  validateSmsConsent
} = require('../lib/sms-consent');

function createHandler(register = createRegistration, notify = attemptImmediateDelivery) {
  return async function handler(req, res) {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed.' });
    }

    try {
      const body = req.body || {};
      const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : '';
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      let phone;
      try {
        phone = normalizeGhanaPhone(body.phone);
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
      const smsConsent = body.smsConsent === undefined
        ? false
        : body.smsConsent;
      const consentSource = body.consentSource === undefined
        ? 'digital_forensics_standalone'
        : body.consentSource;

      if (!fullName || fullName.length > 120) {
        return res.status(400).json({ error: 'Please provide your full name.' });
      }

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Please provide a valid email address.' });
      }

      if (typeof consentSource !== 'string' ||
          !SMS_CONSENT_SOURCES.has(consentSource)) {
        return res.status(400).json({ error: 'Please submit a valid registration source.' });
      }

      try {
        validateSmsConsent(smsConsent, phone);
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }

      const registration = await register({
        fullName,
        email,
        phone,
        smsConsent,
        consentSource
      });
      await notify(`digital-forensics-registration:${registration.id}`);

      return res.status(200).json({
        registrationId: registration.id,
        fullName: registration.fullName,
        email: registration.email,
        phone: registration.phone,
        course: registration.course,
        status: registration.status,
        expectedAmount: registration.expectedAmount,
        expectedCurrency: registration.expectedCurrency
      });
    } catch (error) {
      console.error('Digital Forensics registration creation failed.', {
        code: error && typeof error.code === 'string' ? error.code : 'unknown'
      });
      return res.status(500).json({
        error: 'We could not create your course registration. Please try again.'
      });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
