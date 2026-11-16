const {
  getPaymentPrice,
  getRegistrationPaymentPrice
} = require('../lib/payment-prices');
const {
  initializePaystackTransaction,
  verifyPaystackTransaction
} = require('../lib/paystack-client');
const { findRegistration, updateRegistration } = require('../lib/digital-forensics-store');
const { getPaystackSecretKeyMode } = require('../lib/paystack-secret-key');

function parseMetadata(metadata) {
  if (typeof metadata === 'string') {
    try {
      return JSON.parse(metadata);
    } catch {
      return null;
    }
  }

  return metadata && typeof metadata === 'object' ? metadata : null;
}

async function getExistingAttemptPrice(registration) {
  if (!registration.paymentReference) {
    return null;
  }

  if (!['GHS', 'USD_REFERENCE'].includes(registration.pricingOption)) {
    throw new Error('The assigned payment details could not be verified.');
  }

  const result = await verifyPaystackTransaction(registration.paymentReference);
  const transaction = result.data;
  const metadata = transaction && parseMetadata(transaction.metadata);
  const expectedAmount = Math.round(Number(registration.expectedAmount) * 100);
  const referenceAmount = Number(metadata && metadata.reference_amount);
  const exchangeRate = Number(metadata && metadata.exchange_rate);
  const validStatuses = ['success', 'pending', 'failed', 'abandoned'];

  if (
    !transaction ||
    result.status !== true ||
    transaction.reference !== registration.paymentReference ||
    !validStatuses.includes(transaction.status) ||
    transaction.currency !== registration.expectedCurrency ||
    Number(transaction.amount) !== expectedAmount ||
    registration.expectedCurrency !== 'GHS' ||
    !metadata ||
    metadata.track !== 'digital_forensics' ||
    metadata.registration_id !== registration.id ||
    metadata.pricing_option !== registration.pricingOption ||
    metadata.charge_currency !== 'GHS' ||
    Number(metadata.charge_amount_ghs) !== Number(registration.expectedAmount) ||
    Number(metadata.paystack_amount) !== expectedAmount ||
    (registration.pricingOption === 'GHS' &&
      (metadata.reference_currency !== 'GHS' ||
        referenceAmount !== Number(registration.expectedAmount))) ||
    (registration.pricingOption === 'USD_REFERENCE' &&
      (metadata.reference_currency !== 'USD' ||
        !Number.isFinite(referenceAmount) ||
        referenceAmount <= 0 ||
        !Number.isFinite(exchangeRate) ||
        exchangeRate <= 0 ||
        Math.round(referenceAmount * exchangeRate * 100) !== expectedAmount)) ||
    !transaction.customer ||
    typeof transaction.customer.email !== 'string' ||
    transaction.customer.email.toLowerCase() !== registration.email
  ) {
    throw new Error('The assigned payment details could not be verified.');
  }

  return {
    referenceAmount,
    exchangeRate,
    pricingOption: registration.pricingOption,
    status: transaction.status
  };
}

function createQuote(registration, price, attempt) {
  const currentPrice = getPaymentPrice('digital_forensics', price.pricingOption);
  const existingRegistrationPrice =
    price.referenceAmount !== currentPrice.referenceAmount ||
    price.chargeAmountGhs !== currentPrice.chargeAmountGhs ||
    (price.exchangeRate || null) !== (currentPrice.exchangeRate || null);
  const paymentPending =
    attempt && ['success', 'pending'].includes(attempt.status);

  return {
    track: 'digital_forensics',
    registrationId: registration.id,
    pricingOption: price.pricingOption,
    referenceAmount: price.referenceAmount,
    referenceCurrency: price.referenceCurrency,
    chargeAmountGhs: price.chargeAmountGhs,
    paystackAmount: price.paystackAmount,
    currency: price.paystackCurrency,
    exchangeRate: price.exchangeRate || null,
    existingRegistrationPrice,
    pricingLocked: Boolean(registration.pricingOption),
    canPay: !paymentPending,
    transactionStatus: attempt ? attempt.status : null
  };
}

function quoteMatches(expectedQuote, quote) {
  return expectedQuote &&
    expectedQuote.pricingOption === quote.pricingOption &&
    expectedQuote.referenceCurrency === quote.referenceCurrency &&
    Number(expectedQuote.referenceAmount) === quote.referenceAmount &&
    Number(expectedQuote.chargeAmountGhs) === quote.chargeAmountGhs &&
    Number(expectedQuote.paystackAmount) === quote.paystackAmount &&
    (expectedQuote.exchangeRate === null || expectedQuote.exchangeRate === undefined
      ? quote.exchangeRate === null
      : Number(expectedQuote.exchangeRate) === quote.exchangeRate);
}

module.exports = async function handler(req, res) {
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
    const body = req.body || {};
    const registrationId = typeof body.registrationId === 'string' ? body.registrationId.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const operation = body.operation || 'initialize';
    const requestedPricingOption = body.pricingOption || 'GHS';

    if (!registrationId) {
      return res.status(400).json({
        error: 'A valid Digital Forensics registration ID is required.'
      });
    }

    if (!['initialize', 'quote'].includes(operation)) {
      return res.status(400).json({ error: 'Invalid payment operation.' });
    }

    if (!['GHS', 'USD_REFERENCE'].includes(requestedPricingOption)) {
      return res.status(400).json({ error: 'Invalid Digital Forensics pricing option.' });
    }

    const registration = await findRegistration(registrationId);

    if (!registration) {
      return res.status(404).json({ error: 'The Digital Forensics registration could not be found.' });
    }

    if (registration.course !== 'digital_forensics') {
      return res.status(400).json({ error: 'The registration is not for Digital Forensics.' });
    }

    if (email && email !== registration.email) {
      return res.status(403).json({ error: 'The supplied email does not match the registration.' });
    }

    if (operation === 'quote' && !email) {
      return res.status(400).json({ error: 'A valid applicant email is required.' });
    }

    if (registration.status === 'paid' || registration.status === 'payment_verified') {
      return res.status(409).json({ error: 'This registration has already been paid.' });
    }

    const pricingOption = operation === 'quote' && registration.pricingOption
      ? registration.pricingOption
      : requestedPricingOption;

    if (operation === 'initialize' &&
      registration.pricingOption &&
      registration.pricingOption !== pricingOption) {
      return res.status(409).json({
        error: 'This registration is already associated with a different pricing option.'
      });
    }

    const existingAttempt = await getExistingAttemptPrice(registration);
    const price = getRegistrationPaymentPrice(
      registration,
      pricingOption,
      existingAttempt
    );
    if (!price) {
      return res.status(400).json({ error: 'Invalid Digital Forensics pricing option.' });
    }

    const quote = createQuote(registration, price, existingAttempt);

    if (operation === 'quote') {
      return res.status(200).json(quote);
    }

    if (existingAttempt && ['success', 'pending'].includes(existingAttempt.status)) {
      return res.status(409).json({
        error: 'A previous payment attempt is still being processed. Please wait for verification.',
        quote
      });
    }

    if (body.expectedQuote && !quoteMatches(body.expectedQuote, quote)) {
      return res.status(409).json({
        error: 'The assigned price changed. Review the updated amount before continuing.',
        quote
      });
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

    let transaction;
    try {
      transaction = await initializePaystackTransaction({
        email: registration.email,
        amount: price.paystackAmount,
        currency: price.paystackCurrency,
        reference,
        channels: price.channels,
        metadata,
        callback_url: `${process.env.SITE_URL || 'https://cybanext-website.vercel.app'}/payment/success.html?course=digital_forensics`
      });
    } catch (error) {
      if (error.providerOutcome === 'rejected') {
        const restoredRegistration = await updateRegistration(registrationId, {
          paymentReference: registration.paymentReference,
          status: registration.status,
          expectedAmount: registration.expectedAmount,
          expectedCurrency: registration.expectedCurrency,
          pricingOption: registration.pricingOption
        }, {
          expectedStatus: 'payment_initiated',
          expectedPaymentReference: reference
        });

        if (!restoredRegistration) {
          throw new Error('The rejected payment reservation could not be restored.');
        }
      }

      throw error;
    }

    if (
      typeof transaction.data.authorization_url !== 'string' ||
      transaction.data.reference !== reference
    ) {
      throw new Error('Paystack returned an invalid payment authorization.');
    }

    return res.status(200).json({
      authorizationUrl: transaction.data.authorization_url,
      reference: transaction.data.reference,
      registrationId,
      track: 'digital_forensics',
      currency: price.paystackCurrency,
      pricingOption: price.pricingOption,
      referenceAmount: price.referenceAmount,
      referenceCurrency: price.referenceCurrency,
      chargeAmountGhs: price.chargeAmountGhs,
      paystackAmount: price.paystackAmount,
      exchangeRate: price.exchangeRate || null,
      existingRegistrationPrice: quote.existingRegistrationPrice
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
