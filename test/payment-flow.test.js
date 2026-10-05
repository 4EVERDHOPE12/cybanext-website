const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

process.env.USD_GHS_RATE = '11.55';
process.env.QUALIFICATION_TOKEN_SECRET =
  'test-only-qualification-token-secret-with-more-than-32-characters';
process.env.PAYSTACK_SECRET_KEY = ['sk', 'test', 'unit_test_key'].join('_');

const https = require('node:https');
const {
  REGULAR_TRACKS,
  getPaymentPrice
} = require('../lib/payment-prices');
const {
  createQualificationToken,
  verifyQualificationToken
} = require('../lib/qualification-token');
const initializePayment = require('../api/initialize-payment');
const initializeDigitalForensicsPayment =
  require('../api/initialize-digital-forensics-payment');
const getPaymentPrices = require('../api/payment-prices');
const verifyPayment = require('../api/verify-payment');

function createApplicantToken(track = 'incident_response') {
  return createQualificationToken({
    name: 'Test Applicant',
    email: 'applicant@example.com',
    phone: '+233201234567',
    track
  });
}

function createResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

function stubPaystackRequest(t, responseData) {
  const originalRequest = https.request;
  let requestOptions;
  let requestBody = '';

  https.request = (options, callback) => {
    requestOptions = options;
    const request = new EventEmitter();
    request.write = (chunk) => {
      requestBody += chunk;
    };
    request.setTimeout = () => {};
    request.destroy = (error) => request.emit('error', error);
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      callback(response);
      process.nextTick(() => {
        response.emit('data', Buffer.from(JSON.stringify(responseData)));
        response.emit('end');
      });
    };
    return request;
  };

  t.after(() => {
    https.request = originalRequest;
  });

  return {
    get options() {
      return requestOptions;
    },
    get body() {
      return requestBody ? JSON.parse(requestBody) : null;
    }
  };
}

test('central prices use GHS pesewas and both payment channels', () => {
  for (const track of REGULAR_TRACKS) {
    const price = getPaymentPrice(track);
    assert.equal(price.referenceAmount, 30);
    assert.equal(price.referenceCurrency, 'USD');
    assert.equal(price.chargeAmountGhs, 346.5);
    assert.equal(price.paystackAmount, 34650);
    assert.equal(price.paystackCurrency, 'GHS');
    assert.deepEqual(price.channels, ['card', 'mobile_money']);
  }

  const local = getPaymentPrice('digital_forensics', 'GHS');
  assert.equal(local.chargeAmountGhs, 1200);
  assert.equal(local.paystackAmount, 120000);
  assert.equal(local.paystackCurrency, 'GHS');
  assert.deepEqual(local.channels, ['card', 'mobile_money']);

  const international =
    getPaymentPrice('digital_forensics', 'USD_REFERENCE');
  assert.equal(international.referenceAmount, 120);
  assert.equal(international.referenceCurrency, 'USD');
  assert.equal(international.chargeAmountGhs, 1386);
  assert.equal(international.paystackAmount, 138600);
  assert.equal(international.paystackCurrency, 'GHS');
});

test('price lookup rejects unknown tracks and prototype properties', () => {
  assert.equal(getPaymentPrice('unknown_track'), null);
  assert.equal(getPaymentPrice('toString'), null);
  assert.equal(getPaymentPrice('digital_forensics', 'toString'), null);
});

test('public price endpoint reflects central server prices', () => {
  const response = createResponse();
  getPaymentPrices({ method: 'GET' }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.regular.chargeAmountGhs, 346.5);
  assert.equal(response.body.digitalForensics.GHS.chargeAmountGhs, 1200);
  assert.equal(
    response.body.digitalForensics.USD_REFERENCE.chargeAmountGhs,
    1386
  );
  assert.equal(
    response.body.digitalForensics.USD_REFERENCE.exchangeRate,
    11.55
  );
});

test('qualification tokens are signed, applicant-bound, and tamper evident', () => {
  const token = createApplicantToken();
  const claims = verifyQualificationToken(token);

  assert.equal(claims.email, 'applicant@example.com');
  assert.equal(claims.track, 'incident_response');
  assert.equal(claims.qualified, true);
  assert.equal(verifyQualificationToken(`${token}x`), null);
  assert.equal(verifyQualificationToken('not-a-token'), null);
});

test('qualification tokens can use the configured Paystack TEST key as a fallback', () => {
  const configuredTokenSecret = process.env.QUALIFICATION_TOKEN_SECRET;
  const configuredPaystackSecret = process.env.PAYSTACK_SECRET_KEY;
  delete process.env.QUALIFICATION_TOKEN_SECRET;

  try {
    const token = createApplicantToken();
    assert.equal(
      verifyQualificationToken(token).email,
      'applicant@example.com'
    );
  } finally {
    process.env.QUALIFICATION_TOKEN_SECRET = configuredTokenSecret;
    process.env.PAYSTACK_SECRET_KEY = configuredPaystackSecret;
  }
});

test('regular payment initialization ignores client price and currency', async (t) => {
  const paystack = stubPaystackRequest(t, {
    status: true,
    data: {
      authorization_url: 'https://checkout.paystack.test/authorize',
      access_code: 'access-code',
      reference: 'CYB-123456-ABCDEF'
    }
  });
  const response = createResponse();

  await initializePayment({
    method: 'POST',
    body: {
      email: 'applicant@example.com',
      track: 'incident_response',
      qualificationToken: createApplicantToken(),
      amount: 1,
      currency: 'USD',
      price: 1
    }
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(paystack.body.amount, 34650);
  assert.equal(paystack.body.currency, 'GHS');
  assert.deepEqual(paystack.body.channels, ['card', 'mobile_money']);
  assert.equal(paystack.body.metadata.track, 'incident_response');
  assert.equal(Object.hasOwn(response.body, 'amount'), false);
});

test('payment initialization rejects absent or mismatched qualification', async () => {
  const noTokenResponse = createResponse();
  await initializePayment({
    method: 'POST',
    body: { track: 'incident_response' }
  }, noTokenResponse);
  assert.equal(noTokenResponse.statusCode, 403);

  const mismatchedResponse = createResponse();
  await initializePayment({
    method: 'POST',
    body: {
      track: 'digital_forensics',
      qualificationToken: createApplicantToken('incident_response')
    }
  }, mismatchedResponse);
  assert.equal(mismatchedResponse.statusCode, 403);
});

test('payment initialization requires a TEST key and refuses live keys', async () => {
  const configuredKey = process.env.PAYSTACK_SECRET_KEY;
  process.env.PAYSTACK_SECRET_KEY = ['sk', 'live', 'unsupported'].join('_');
  const response = createResponse();

  try {
    await initializePayment({
      method: 'POST',
      body: {
        track: 'incident_response',
        qualificationToken: createApplicantToken()
      }
    }, response);
  } finally {
    process.env.PAYSTACK_SECRET_KEY = configuredKey;
  }

  assert.equal(response.statusCode, 500);
});

test('Digital Forensics endpoint selects local or reference price server-side', async (t) => {
  const paystack = stubPaystackRequest(t, {
    status: true,
    data: {
      authorization_url: 'https://checkout.paystack.test/authorize',
      access_code: 'access-code',
      reference: 'CYB-234567-ABCDEF'
    }
  });
  const response = createResponse();

  await initializeDigitalForensicsPayment({
    method: 'POST',
    body: {
      email: 'applicant@example.com',
      track: 'digital_forensics',
      pricingOption: 'USD_REFERENCE',
      qualificationToken: createApplicantToken('digital_forensics'),
      amount: 1,
      currency: 'USD'
    }
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(paystack.body.amount, 138600);
  assert.equal(paystack.body.currency, 'GHS');
  assert.deepEqual(paystack.body.channels, ['card', 'mobile_money']);
  assert.equal(paystack.body.metadata.pricing_option, 'USD_REFERENCE');
});

test('Digital Forensics local option initializes exactly GH₵1,200 in GHS pesewas', async (t) => {
  const paystack = stubPaystackRequest(t, {
    status: true,
    data: {
      authorization_url: 'https://checkout.paystack.test/authorize',
      access_code: 'access-code',
      reference: 'CYB-246810-ABCDEF'
    }
  });
  const response = createResponse();

  await initializeDigitalForensicsPayment({
    method: 'POST',
    body: {
      track: 'digital_forensics',
      pricingOption: 'GHS',
      qualificationToken: createApplicantToken('digital_forensics'),
      amount: 1,
      currency: 'USD'
    }
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(paystack.body.amount, 120000);
  assert.equal(paystack.body.currency, 'GHS');
  assert.equal(paystack.body.metadata.charge_amount_ghs, 1200);
});

test('regular endpoint cannot skip the Digital Forensics payment page', async () => {
  const response = createResponse();
  await initializePayment({
    method: 'POST',
    body: {
      track: 'digital_forensics',
      qualificationToken: createApplicantToken('digital_forensics')
    }
  }, response);

  assert.equal(response.statusCode, 400);
});

test('verification only accepts a successful, matching server-priced payment', async (t) => {
  const reference = 'CYB-345678-ABCDEF';
  const token = createApplicantToken();
  stubPaystackRequest(t, {
    status: true,
    data: {
      status: 'success',
      reference,
      currency: 'GHS',
      amount: 34650,
      customer: { email: 'applicant@example.com' },
      metadata: {
        track: 'incident_response',
        pricing_option: 'USD_REFERENCE',
        qualification_token: token
      }
    }
  });
  const response = createResponse();

  await verifyPayment({
    method: 'POST',
    body: { reference }
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.verified, true);
  assert.equal(response.body.reference, reference);
});

test('verification rejects a mismatched transaction amount', async (t) => {
  stubPaystackRequest(t, {
    status: true,
    data: {
      status: 'success',
      reference: 'CYB-456789-ABCDEF',
      currency: 'GHS',
      amount: 1,
      customer: { email: 'applicant@example.com' },
      metadata: {
        track: 'incident_response',
        pricing_option: 'USD_REFERENCE',
        qualification_token: createApplicantToken()
      }
    }
  });
  const response = createResponse();
  const originalConsoleError = console.error;
  t.after(() => {
    console.error = originalConsoleError;
  });
  console.error = () => {};

  await verifyPayment({
    method: 'POST',
    body: { reference: 'CYB-456789-ABCDEF' }
  }, response);

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.verified, false);
});
