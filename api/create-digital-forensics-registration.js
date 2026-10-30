const { createRegistration } = require('../lib/digital-forensics-store');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const body = req.body || {};
    const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const phone = typeof body.phone === 'string' ? body.phone.trim() : '';

    if (!fullName || fullName.length > 120) {
      return res.status(400).json({ error: 'Please provide your full name.' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Please provide a valid email address.' });
    }

    if (phone && phone.length > 30) {
      return res.status(400).json({ error: 'Please provide a valid phone number.' });
    }

    const registration = await createRegistration({ fullName, email, phone });

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
