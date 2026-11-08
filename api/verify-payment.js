const https = require('https');
const { getPaymentPrice } = require('../lib/payment-prices');
const { verifyQualificationToken } = require('../lib/qualification-token');
const {
  findRegistration,
  updatePaymentStatusWithNotification
} = require('../lib/digital-forensics-store');
const regularTrackStore = require('../lib/regular-track-payment-store');
const { attemptImmediateDelivery } = require('../lib/email-notification-outbox');

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

function normalizeTransactionId(transactionId) {
  if (typeof transactionId !== 'string' && typeof transactionId !== 'number') {
    return null;
  }
  if (typeof transactionId === 'number' && !Number.isSafeInteger(transactionId)) {
    return null;
  }
  const normalized = String(transactionId).trim();
  return normalized || null;
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
      result.data.reference !== reference
    ) {
      return res.status(400).json({
        verified: false,
        error: 'The payment could not be verified.'
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

    if (transaction.status !== 'success') {
      if (transaction.status === 'failed' && track === 'digital_forensics' && registrationId) {
        const registration = await findRegistration(registrationId);
        const price = pricingOption && getPaymentPrice(track, pricingOption);
        const expectedAmount = registration
          ? Math.round(Number(registration.expectedAmount) * 100)
          : NaN;
        if (
          registration &&
          registration.course === 'digital_forensics' &&
          registration.paymentReference === reference &&
          registration.pricingOption === pricingOption &&
          price &&
          registration.expectedCurrency === price.paystackCurrency &&
          Number.isSafeInteger(expectedAmount) &&
          transaction.currency === registration.expectedCurrency &&
          Number(transaction.amount) === expectedAmount &&
          (typeof transaction.customer?.email !== 'string' ||
            transaction.customer.email.toLowerCase() === registration.email)
        ) {
          const failedRegistration = await updatePaymentStatusWithNotification({
            registrationId,
            reference,
            status: 'payment_failed'
          });
          if (failedRegistration) {
            await attemptImmediateDelivery(failedRegistration.notificationEventKey);
          }
        }
      } else if (transaction.status === 'failed' && track !== 'digital_forensics' &&
        registrationId) {
        const attempt = await regularTrackStore.findPaymentAttempt(reference);
        const expectedPayment = track === 'digital_forensics'
          ? null
          : getPaymentPrice(track, pricingOption);
        if (
          attempt &&
          attempt.registrationId === registrationId &&
          attempt.track === track &&
          qualificationClaims &&
          qualificationClaims.track === track &&
          qualificationClaims.email === attempt.email &&
          typeof transaction.customer?.email === 'string' &&
          transaction.customer.email.toLowerCase() === attempt.email &&
          expectedPayment &&
          attempt.referenceAmount === expectedPayment.referenceAmount &&
          attempt.referenceCurrency === expectedPayment.referenceCurrency &&
          attempt.expectedAmount === expectedPayment.paystackAmount &&
          attempt.expectedCurrency === expectedPayment.paystackCurrency &&
          transaction.currency === attempt.expectedCurrency &&
          Number(transaction.amount) === attempt.expectedAmount
        ) {
          const failedAttempt = await regularTrackStore.markPaymentAttemptFailed(reference);
          if (failedAttempt) await attemptImmediateDelivery(failedAttempt.eventKey);
        }
      }
      return res.status(400).json({
        verified: false,
        error: 'The payment was not completed successfully.'
      });
    }

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
        normalizeTransactionId(registration.verifiedTransactionId) ===
          normalizeTransactionId(transaction.id)
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

      const updatedRegistration = await updatePaymentStatusWithNotification({
        registrationId,
        reference,
        status: 'payment_verified',
        transactionId: normalizeTransactionId(transaction.id),
        paymentVerificationTimestamp: new Date().toISOString()
      });

      if (!updatedRegistration) {
        const latestRegistration = await findRegistration(registrationId);
        if (
          latestRegistration &&
          latestRegistration.status === 'payment_verified' &&
          latestRegistration.paymentReference === reference &&
          normalizeTransactionId(latestRegistration.verifiedTransactionId) ===
            normalizeTransactionId(transaction.id)
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

      await attemptImmediateDelivery(updatedRegistration.notificationEventKey);
      return res.status(200).json({
        verified: true,
        reference: transaction.reference,
        track,
        currency: transaction.currency,
        registrationId
      });
    }

    if (!metadata?.registration_id) {
      return res.status(400).json({
        verified: false,
        error: 'Payment registration could not be verified.'
      });
    }

    const attempt = await regularTrackStore.findPaymentAttempt(reference);
    if (!attempt) {
      return res.status(404).json({
        verified: false,
        error: 'The payment reference could not be found.'
      });
    }

    if (
      attempt.registrationId !== metadata.registration_id ||
      attempt.track !== track ||
      !qualificationClaims ||
      qualificationClaims.track !== track ||
      qualificationClaims.email !== attempt.email ||
      !transaction.customer ||
      typeof transaction.customer.email !== 'string' ||
      transaction.customer.email.toLowerCase() !== attempt.email
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
      attempt.referenceAmount !== expectedPayment.referenceAmount ||
      attempt.referenceCurrency !== expectedPayment.referenceCurrency ||
      attempt.expectedCurrency !== expectedPayment.paystackCurrency ||
      attempt.expectedAmount !== expectedPayment.paystackAmount ||
      transaction.currency !== attempt.expectedCurrency ||
      Number(transaction.amount) !== attempt.expectedAmount
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

    const transactionId = transaction.id === undefined || transaction.id === null
      ? null
      : String(transaction.id);

    if (!transactionId) {
      return res.status(400).json({
        verified: false,
        error: 'The payment transaction could not be verified.'
      });
    }

    if (attempt.status === 'payment_verified') {
      if (attempt.verifiedTransactionId === transactionId) {
        return res.status(200).json({
          verified: true,
          reference: transaction.reference,
          track,
          currency: transaction.currency,
          registrationId: attempt.registrationId
        });
      }

      return res.status(409).json({
        verified: false,
        error: 'This payment reference is already associated with another transaction.'
      });
    }

    if (!['initializing', 'payment_initiated'].includes(attempt.status)) {
      return res.status(409).json({
        verified: false,
        error: 'This payment attempt is not awaiting verification.'
      });
    }

    const updatedAttempt = await regularTrackStore.markPaymentAttemptVerified(
      reference,
      transactionId
    );

    if (!updatedAttempt) {
      const latestAttempt = await regularTrackStore.findPaymentAttempt(reference);
      if (
        latestAttempt &&
        latestAttempt.status === 'payment_verified' &&
        latestAttempt.verifiedTransactionId === transactionId
      ) {
        return res.status(200).json({
          verified: true,
          reference: transaction.reference,
          track,
          currency: transaction.currency,
          registrationId: latestAttempt.registrationId
        });
      }

      return res.status(409).json({
        verified: false,
        error: 'The payment attempt changed while it was being verified.'
      });
    }

    await attemptImmediateDelivery(updatedAttempt.eventKey);
    return res.status(200).json({
      verified: true,
      reference: transaction.reference,
      track,
      currency: transaction.currency,
      registrationId: attempt.registrationId
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
