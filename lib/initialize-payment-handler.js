const https = require('https');
const { getPaymentPrice } = require('./payment-prices');
const { verifyQualificationToken } = require('./qualification-token');

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

            if (
              response.statusCode >= 400 ||
              !result.status ||
              !result.data
            ) {
              return reject(new Error(
                result.message || 'Paystack could not initialize this payment.'
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
  const { fixedTrack } = options;

  return async (req, res) => {
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
      const {
        email: requestedEmail,
        track: requestedTrack,
        pricingOption = 'GHS',
        qualificationToken
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
      const metadata = {
        applicant_name: claims.name || '',
        track,
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

      const transaction = await initializePaystackTransaction({
        email: claims.email,
        amount: price.paystackAmount,
        currency: price.paystackCurrency,
        reference,
        channels: price.channels,
        metadata,
        callback_url:
          `${process.env.SITE_URL || 'https://cybanext-website.vercel.app'}/payment/success.html`
      });

      return res.status(200).json({
        authorizationUrl: transaction.data.authorization_url,
        reference: transaction.data.reference,
        track,
        currency: price.paystackCurrency,
        pricingOption: price.pricingOption,
        referenceAmount: price.referenceAmount,
        referenceCurrency: price.referenceCurrency,
        chargeAmountGhs: price.chargeAmountGhs
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
