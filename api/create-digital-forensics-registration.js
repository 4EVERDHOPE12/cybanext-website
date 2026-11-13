const { createRegistration } = require('../lib/digital-forensics-store');
const { normalizeGhanaPhone } = require('../lib/ghana-phone');
const { validateSmsConsent } = require('../lib/sms-consent');

module.exports = async function handler(req, res) {
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
      validateSmsConsent(body.smsConsent === undefined ? false : body.smsConsent, phone);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const smsConsent = body.smsConsent === true;

    if (!fullName || fullName.length > 120) {
      return res.status(400).json({ error: 'Please provide your full name.' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Please provide a valid email address.' });
    }

    const registration = await createRegistration({
      fullName,
      email,
      phone,
      smsConsent
    });

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
