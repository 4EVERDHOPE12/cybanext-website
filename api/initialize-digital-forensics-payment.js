const https = require('https');
const { getPaymentPrice } = require('../lib/payment-prices');
const { findRegistration, updateRegistration } = require('../lib/digital-forensics-store');

function initializePaystackTransaction(data) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const request = https.request(
      {
        hostname: 'api.paystack.co',
        path: '/transaction/initialize',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (response) => {
        let body = '';
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            const result = JSON.parse(body);
            if (response.statusCode >= 400 || !result.status || !result.data) {
              return reject(new Error(result.message || 'Paystack could not initialize this payment.'));
            }
            resolve(result);
          } catch (error) {
            reject(new Error('Invalid response received from Paystack.'));
          }
        });
      }
    );

    request.on('error', reject);
    request.setTimeout(15000, () => {
      request.destroy(new Error('Paystack payment initialization timed out.'));
    });
    request.write(payload);
    request.end();
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey || !secretKey.startsWith('sk_test_')) {
    console.error('A Paystack TEST secret key is not configured.');
    return res.status(500).json({
      error: 'Test payment service is not configured.'
    });
  }

  try {
    const body = req.body || {};
    const registrationId = typeof body.registrationId === 'string' ? body.registrationId.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const pricingOption = body.pricingOption || 'GHS';

    if (!registrationId) {
      return res.status(400).json({
        error: 'A valid Digital Forensics registration ID is required.'
      });
    }

    if (!['GHS', 'USD_REFERENCE'].includes(pricingOption)) {
      return res.status(400).json({ error: 'Invalid Digital Forensics pricing option.' });
    }

    const registration = await findRegistration(registrationId);

    if (!registration) {
      return res.status(404).json({ error: 'The Digital Forensics registration could not be found.' });
    }

    if (registration.course !== 'digital_forensics') {
      return res.status(400).json({ error: 'The registration is not for Digital Forensics.' });
    }

    if (registration.status === 'paid' || registration.status === 'payment_verified') {
      return res.status(409).json({ error: 'This registration has already been paid.' });
    }

    if (email && email !== registration.email) {
      return res.status(403).json({ error: 'The supplied email does not match the registration.' });
    }

    const price = getPaymentPrice('digital_forensics', pricingOption);
    if (!price) {
      return res.status(400).json({ error: 'Invalid Digital Forensics pricing option.' });
    }

    const reference = `DF-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const metadata = {
      registration_id: registrationId,
      applicant_name: registration.fullName || '',
      track: 'digital_forensics',
      pricing_option: price.pricingOption,
      reference_amount: price.referenceAmount,
      reference_currency: price.referenceCurrency,
      charge_currency: price.paystackCurrency,
      charge_amount_ghs: price.chargeAmountGhs,
      paystack_amount: price.paystackAmount,
      course: 'digital_forensics',
      applicant_email: registration.email,
      applicant_phone: registration.phone || ''
    };

    if (price.exchangeRate) {
      metadata.exchange_rate = price.exchangeRate;
    }

    const reservation = await updateRegistration(registrationId, {
      paymentReference: reference,
      status: 'payment_initiated',
      expectedAmount: Number(price.chargeAmountGhs),
      expectedCurrency: price.paystackCurrency,
      pricingOption: price.pricingOption
    }, {
      expectedStatus: registration.status,
      expectedPaymentReference: registration.paymentReference
    });

    if (!reservation) {
      return res.status(409).json({
        error: 'This registration changed while payment was being prepared. Please try again.'
      });
    }

    const transaction = await initializePaystackTransaction({
      email: registration.email,
      amount: price.paystackAmount,
      currency: price.paystackCurrency,
      reference,
      channels: price.channels,
      metadata,
      callback_url: `${process.env.SITE_URL || 'https://cybanext-website.vercel.app'}/payment/success.html?course=digital_forensics`
    });

    return res.status(200).json({
      authorizationUrl: transaction.data.authorization_url,
      reference: transaction.data.reference,
      registrationId,
      track: 'digital_forensics',
      currency: price.paystackCurrency,
      pricingOption: price.pricingOption,
      referenceAmount: price.referenceAmount,
      referenceCurrency: price.referenceCurrency,
      chargeAmountGhs: price.chargeAmountGhs
    });
  } catch (error) {
    console.error('Digital Forensics payment initialization failed.', {
      code: error && typeof error.code === 'string' ? error.code : 'unknown'
    });
    return res.status(502).json({
      error: 'We could not start the payment right now. Please try again.'
    });
  }
};
