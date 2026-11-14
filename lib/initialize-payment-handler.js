const https = require('https');
const { getPaymentPrice } = require('./payment-prices');
const { verifyQualificationToken } = require('./qualification-token');
const regularPaymentStore = require('./regular-track-payment-store');
const { getPaystackSecretKeyMode } = require('./paystack-secret-key');

function createPaystackInitializationError(message, providerOutcome = 'unknown') {
  const error = new Error(message);
  error.providerOutcome = providerOutcome;
  return error;
}

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
              const confirmedRejection =
                response.statusCode >= 400 &&
                response.statusCode < 500 &&
                result.status === false &&
                !result.data;
              return reject(createPaystackInitializationError(
                'Paystack rejected payment initialization.',
                confirmedRejection ? 'rejected' : 'unknown'
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
      request.destroy(new Error('Paystack payment initialization timed out.'));
    });
    request.write(payload);
    request.end();
  });
}

function createInitializePaymentHandler(options = {}) {
  const { fixedTrack, paymentStore = regularPaymentStore } = options;

  return async (req, res) => {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed.' });
    }

    const secretKey = process.env.PAYSTACK_SECRET_KEY;

    if (!getPaystackSecretKeyMode(secretKey)) {
      console.error('A valid Paystack secret key is not configured.');
      return res.status(500).json({
        error: 'Payment service is not configured.'
      });
    }

    try {
      const {
        email: requestedEmail,
        track: requestedTrack,
        pricingOption = 'GHS',
        qualificationToken,
        registrationId: requestedRegistrationId
      } = req.body || {};
      const claims = verifyQualificationToken(qualificationToken);

      if (!claims) {
        return res.status(403).json({
          error: 'CV qualification is required before payment.'
        });
      }

      if (
        (fixedTrack && claims.track !== fixedTrack) ||
        (requestedTrack && requestedTrack !== claims.track) ||
        (requestedEmail &&
          (typeof requestedEmail !== 'string' ||
            requestedEmail.toLowerCase() !== claims.email))
      ) {
        return res.status(403).json({
          error: 'Payment details do not match the qualified application.'
        });
      }

      const track = claims.track;
      if (!fixedTrack && track === 'digital_forensics') {
        return res.status(400).json({
          error: 'Digital Forensics payments must use the dedicated payment page.'
        });
      }

      const registrationId = typeof requestedRegistrationId === 'string'
        ? requestedRegistrationId.trim()
        : '';
      let applicant = null;
      if (!fixedTrack) {
        if (!registrationId) {
          return res.status(400).json({
            error: 'A valid regular-track registration ID is required.'
          });
        }

        applicant = await paymentStore.findApplicant(registrationId);
        if (!applicant) {
          return res.status(404).json({
            error: 'The regular-track registration could not be found.'
          });
        }

        if (
          applicant.track !== track ||
          applicant.email !== claims.email
        ) {
          return res.status(403).json({
            error: 'Payment details do not match the registration.'
          });
        }
      }

      const selectedPricingOption = track === 'digital_forensics'
        ? pricingOption
        : 'USD_REFERENCE';
      const price = getPaymentPrice(track, selectedPricingOption);

      if (!price) {
        return res.status(400).json({
          error: track === 'digital_forensics'
            ? 'Invalid Digital Forensics pricing option.'
            : 'Invalid internship track.'
        });
      }

      const reference =
        `CYB-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      if (!fixedTrack) {
        const paymentAttempt = await paymentStore.createPaymentAttempt({
          reference,
          registrationId,
          referenceAmount: price.referenceAmount,
          expectedAmount: price.chargeAmountGhs,
          expectedCurrency: price.paystackCurrency
        });

        if (!paymentAttempt) {
          return res.status(409).json({
            error: 'This registration already has an active payment attempt.'
          });
        }
      }

      const metadata = {
        applicant_name: claims.name || '',
        track,
        ...(registrationId ? { registration_id: registrationId } : {}),
        pricing_option: price.pricingOption,
        reference_amount: price.referenceAmount,
        reference_currency: price.referenceCurrency,
        charge_currency: price.paystackCurrency,
        charge_amount_ghs: price.chargeAmountGhs,
        paystack_amount: price.paystackAmount,
        qualification_token: qualificationToken
      };

      if (price.exchangeRate) {
        metadata.exchange_rate = price.exchangeRate;
      }

      if (claims.phone) {
        metadata.applicant_phone = claims.phone;
      }

      let transaction;
      try {
        transaction = await initializePaystackTransaction({
          email: claims.email,
          amount: price.paystackAmount,
          currency: price.paystackCurrency,
          reference,
          channels: price.channels,
          metadata,
          callback_url:
            `${process.env.SITE_URL || 'https://cybanext-website.vercel.app'}/payment/success.html`
        });
      } catch (error) {
        if (!fixedTrack && error.providerOutcome === 'rejected') {
          await paymentStore.updatePaymentAttemptStatus(
            reference,
            'initialization_failed'
          );
        }
        throw error;
      }

      if (transaction.data.reference !== reference) {
        throw new Error('Paystack returned a mismatched payment reference.');
      }

      if (!fixedTrack) {
        const initiated = await paymentStore.updatePaymentAttemptStatus(
          reference,
          'payment_initiated'
        );
        if (!initiated) {
          return res.status(503).json({
            error: 'The payment was created but is still being activated. Please verify it shortly.'
          });
        }
      }

      return res.status(200).json({
        authorizationUrl: transaction.data.authorization_url,
        reference: transaction.data.reference,
        track,
        currency: price.paystackCurrency,
        pricingOption: price.pricingOption,
        referenceAmount: price.referenceAmount,
        referenceCurrency: price.referenceCurrency,
        chargeAmountGhs: price.chargeAmountGhs,
        ...(registrationId ? { registrationId } : {})
      });
    } catch (error) {
      console.error('Paystack initialization error:', error);

      return res.status(502).json({
        error: 'We could not start the payment right now. Please try again.'
      });
    }
  };
}

module.exports = createInitializePaymentHandler;
