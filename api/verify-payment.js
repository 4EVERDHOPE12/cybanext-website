const { getPaymentPrice } = require('../lib/payment-prices');
const { verifyPaystackTransaction } = require('../lib/paystack-client');
const { verifyQualificationToken } = require('../lib/qualification-token');
const { getPaystackSecretKeyMode } = require('../lib/paystack-secret-key');
const {
  findRegistration,
  updatePaymentStatusWithNotification
} = require('../lib/digital-forensics-store');
const regularPaymentStore = require('../lib/regular-track-payment-store');
const { attemptImmediateDelivery } = require('../lib/email-notification-outbox');

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

  if (!getPaystackSecretKeyMode(secretKey)) {
    console.error('A valid Paystack secret key is not configured.');
    return res.status(500).json({
      verified: false,
      error: 'Payment service is not configured.'
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

    if (!result.status || !result.data || result.data.reference !== reference) {
      return res.status(400).json({
        verified: false,
        error: 'The payment was not completed successfully.'
      });
    }

    const transaction = result.data;
    if (transaction.status === 'pending') {
      return res.status(400).json({
        verified: false,
        transactionStatus: 'pending',
        error: 'Paystack has not completed this payment yet.'
      });
    }

    if (!['success', 'failed'].includes(transaction.status)) {
      return res.status(400).json({
        verified: false,
        transactionStatus: 'unknown',
        error: 'The payment status could not be verified.'
      });
    }

    const metadata = parseMetadata(transaction.metadata);
    const track = metadata && metadata.track;
    const pricingOption = metadata && metadata.pricing_option;
    const registrationId = metadata && metadata.registration_id;
    const qualificationClaims = metadata && verifyQualificationToken(
      metadata.qualification_token,
      { allowExpired: true }
    );

    if (transaction.status === 'failed') {
      if (transaction.status === 'failed' && track === 'digital_forensics' && registrationId) {
        const registration = await findRegistration(registrationId);
        const pricingOption = metadata && metadata.pricing_option;
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
      }

      if (track !== 'digital_forensics') {
        const attempt = await regularPaymentStore.findPaymentAttempt(reference);
        const validRegularPayment =
          attempt &&
          attempt.registrationId === registrationId &&
          attempt.applicantStatus === 'payment_initiated' &&
          ['initializing', 'payment_initiated'].includes(attempt.status) &&
          track === attempt.track &&
          attempt.track !== 'digital_forensics' &&
          pricingOption === 'USD_REFERENCE' &&
          transaction.currency === attempt.expectedCurrency &&
          Number(transaction.amount) === Number(attempt.expectedAmount) &&
          transaction.customer &&
          typeof transaction.customer.email === 'string' &&
          transaction.customer.email.toLowerCase() === attempt.email;

        if (validRegularPayment) {
          const failedAttempt =
            await regularPaymentStore.markPaymentAttemptFailed(reference);
          if (failedAttempt) {
            await attemptImmediateDelivery(failedAttempt.eventKey);
          }
        }
      }

      return res.status(400).json({
        verified: false,
        transactionStatus: 'failed',
        error: 'The payment was not completed successfully.'
      });
    }

    if (transaction.status !== 'success') {
      return res.status(400).json({
        verified: false,
        error: 'The payment status could not be verified.'
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

      const updatedRegistration = await updatePaymentStatusWithNotification({
        registrationId,
        reference,
        status: 'payment_verified',
        transactionId: transaction.id || null,
        paymentVerificationTimestamp: new Date().toISOString()
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

      await attemptImmediateDelivery(updatedRegistration.notificationEventKey);
      return res.status(200).json({
        verified: true,
        reference: transaction.reference,
        track,
        currency: transaction.currency,
        registrationId
      });
    }

    if (track !== 'digital_forensics') {
      const attempt = await regularPaymentStore.findPaymentAttempt(reference);
      const validRegularPayment =
        attempt &&
        attempt.registrationId === registrationId &&
        track === attempt.track &&
        attempt.track !== 'digital_forensics' &&
        pricingOption === 'USD_REFERENCE' &&
        transaction.currency === attempt.expectedCurrency &&
        Number(transaction.amount) === Number(attempt.expectedAmount) &&
        transaction.customer &&
        typeof transaction.customer.email === 'string' &&
        transaction.customer.email.toLowerCase() === attempt.email &&
        qualificationClaims &&
        qualificationClaims.track === attempt.track &&
        qualificationClaims.email === attempt.email;

      if (!validRegularPayment) {
        return res.status(400).json({
          verified: false,
          error: 'Payment information could not be verified.'
        });
      }

      if (
        attempt.status === 'payment_verified' &&
        String(attempt.verifiedTransactionId) === String(transaction.id)
      ) {
        return res.status(200).json({
          verified: true,
          reference: transaction.reference,
          track,
          currency: transaction.currency,
          registrationId
        });
      }

      if (
        !['initializing', 'payment_initiated'].includes(attempt.status) ||
        attempt.applicantStatus !== 'payment_initiated'
      ) {
        return res.status(409).json({
          verified: false,
          error: 'The payment attempt is not awaiting verification.'
        });
      }

      const verifiedAttempt =
        await regularPaymentStore.markPaymentAttemptVerified(
          reference,
          transaction.id
        );

      if (!verifiedAttempt) {
        const latestAttempt =
          await regularPaymentStore.findPaymentAttempt(reference);
        if (
          latestAttempt &&
          latestAttempt.registrationId === registrationId &&
          latestAttempt.status === 'payment_verified' &&
          String(latestAttempt.verifiedTransactionId) === String(transaction.id)
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
          error: 'The payment attempt changed while being verified.'
        });
      }

      await attemptImmediateDelivery(verifiedAttempt.eventKey);
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
