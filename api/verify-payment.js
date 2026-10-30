const https = require('https');
const { getPaymentPrice } = require('../lib/payment-prices');
const { verifyQualificationToken } = require('../lib/qualification-token');
const { findRegistration, updateRegistration } = require('../lib/digital-forensics-store');

function verifyPaystackTransaction(reference) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: 'api.paystack.co',
        path: `/transaction/verify/${encodeURIComponent(reference)}`,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
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
              return reject(new Error(
                result.message || 'Paystack verification failed.'
              ));
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
      request.destroy(new Error('Paystack verification timed out.'));
    });
    request.end();
  });
}

function parseMetadata(metadata) {
  if (typeof metadata === 'string') {
    try {
      return JSON.parse(metadata);
    } catch (error) {
      return null;
    }
  }

  return metadata && typeof metadata === 'object' ? metadata : null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const secretKey = process.env.PAYSTACK_SECRET_KEY;

  if (!secretKey || !secretKey.startsWith('sk_test_')) {
    console.error('A Paystack TEST secret key is not configured.');
    return res.status(500).json({
      verified: false,
      error: 'Test payment service is not configured.'
    });
  }

  const { reference } = req.body || {};

  if (
    typeof reference !== 'string' ||
    reference.length < 6 ||
    reference.length > 100 ||
    !/^[A-Za-z0-9_-]+$/.test(reference)
  ) {
    return res.status(400).json({
      verified: false,
      error: 'A valid payment reference is required.'
    });
  }

  try {
    const result = await verifyPaystackTransaction(reference);

    if (
      !result.status ||
      !result.data ||
      result.data.status !== 'success' ||
      result.data.reference !== reference
    ) {
      return res.status(400).json({
        verified: false,
        error: 'The payment was not completed successfully.'
      });
    }

    const transaction = result.data;
    const metadata = parseMetadata(transaction.metadata);
    const track = metadata && metadata.track;
    const pricingOption = metadata && metadata.pricing_option;
    const registrationId = metadata && metadata.registration_id;
    const qualificationClaims = metadata && verifyQualificationToken(
      metadata.qualification_token,
      { allowExpired: true }
    );

    if (track === 'digital_forensics') {
      if (!registrationId) {
        return res.status(400).json({
          verified: false,
          error: 'Digital Forensics payment registration could not be verified.'
        });
      }

      const registration = await findRegistration(registrationId);
      if (!registration) {
        return res.status(404).json({
          verified: false,
          error: 'The Digital Forensics registration could not be found.'
        });
      }

      if (
        registration.course !== 'digital_forensics' ||
        registration.paymentReference !== reference ||
        registration.pricingOption !== pricingOption
      ) {
        return res.status(400).json({
          verified: false,
          error: 'The Digital Forensics payment is not associated with this registration.'
        });
      }

      if (!['GHS', 'USD_REFERENCE'].includes(pricingOption)) {
        return res.status(400).json({
          verified: false,
          error: 'Payment pricing option could not be verified.'
        });
      }

      const expectedPayment = getPaymentPrice(track, pricingOption);
      const expectedPaystackAmount =
        Math.round(Number(registration.expectedAmount) * 100);
      if (
        !expectedPayment ||
        !Number.isSafeInteger(expectedPaystackAmount) ||
        transaction.currency !== registration.expectedCurrency ||
        Number(transaction.amount) !== expectedPaystackAmount ||
        expectedPayment.paystackCurrency !== registration.expectedCurrency ||
        !transaction.customer ||
        typeof transaction.customer.email !== 'string' ||
        transaction.customer.email.toLowerCase() !== registration.email
      ) {
        return res.status(400).json({
          verified: false,
          error: 'The Digital Forensics payment details could not be verified.'
        });
      }

      if (
        ['payment_verified', 'paid'].includes(registration.status) &&
        registration.verifiedTransactionId === transaction.id
      ) {
        return res.status(200).json({
          verified: true,
          reference: transaction.reference,
          track,
          currency: transaction.currency,
          registrationId
        });
      }

      if (registration.status !== 'payment_initiated') {
        return res.status(409).json({
          verified: false,
          error: 'The registration is not awaiting this payment.'
        });
      }

      const updatedRegistration = await updateRegistration(registrationId, {
        status: 'payment_verified',
        verifiedTransactionId: transaction.id || null,
        paymentVerificationTimestamp: new Date().toISOString()
      }, {
        expectedStatus: 'payment_initiated',
        expectedPaymentReference: reference
      });

      if (!updatedRegistration) {
        const latestRegistration = await findRegistration(registrationId);
        if (
          latestRegistration &&
          latestRegistration.status === 'payment_verified' &&
          latestRegistration.paymentReference === reference &&
          latestRegistration.verifiedTransactionId === transaction.id
        ) {
          return res.status(200).json({
            verified: true,
            reference: transaction.reference,
            track,
            currency: transaction.currency,
            registrationId
          });
        }

        return res.status(409).json({
          verified: false,
          error: 'The registration changed while payment was being verified.'
        });
      }

      return res.status(200).json({
        verified: true,
        reference: transaction.reference,
        track,
        currency: transaction.currency,
        registrationId
      });
    }

    if (
      !qualificationClaims ||
      qualificationClaims.track !== track ||
      !track ||
      (transaction.customer?.email &&
        transaction.customer.email.toLowerCase() !== qualificationClaims.email)
    ) {
      console.error('Payment verification failed: qualification details mismatch.', reference);
      return res.status(400).json({
        verified: false,
        error: 'Payment information could not be verified.'
      });
    }

    if (
      (track === 'digital_forensics' &&
        !['GHS', 'USD_REFERENCE'].includes(pricingOption)) ||
      (track !== 'digital_forensics' && pricingOption !== 'USD_REFERENCE')
    ) {
      return res.status(400).json({
        verified: false,
        error: 'Payment pricing option could not be verified.'
      });
    }

    const expectedPayment = getPaymentPrice(track, pricingOption);

    if (
      !expectedPayment ||
      transaction.currency !== expectedPayment.paystackCurrency ||
      Number(transaction.amount) !== expectedPayment.paystackAmount
    ) {
      console.error('Payment amount or currency mismatch.', {
        reference,
        track,
        currency: transaction.currency,
        amount: transaction.amount
      });
      return res.status(400).json({
        verified: false,
        error: 'The payment amount or currency could not be verified.'
      });
    }

    return res.status(200).json({
      verified: true,
      reference: transaction.reference,
      track,
      currency: transaction.currency
    });
  } catch (error) {
    console.error('Payment verification failed.', {
      code: error && typeof error.code === 'string' ? error.code : 'unknown'
    });
    return res.status(502).json({
      verified: false,
      error: 'We could not verify your payment. Please try again.'
    });
  }
};
