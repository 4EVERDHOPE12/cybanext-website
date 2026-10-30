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
const digitalForensicsDatabase =
  require('../lib/digital-forensics-database');
const digitalForensicsStore =
  require('../lib/digital-forensics-store');

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

function withFakeDigitalForensicsDatabase(t) {
  const originalQuery = digitalForensicsDatabase.query;
  const registrations = new Map();
  const fake = {
    failure: null,
    async query(strings, ...values) {
      const statement = strings.join(' ');
      if (
        this.failure &&
        (!this.failure.statementIncludes ||
          statement.includes(this.failure.statementIncludes))
      ) {
        throw this.failure.error || this.failure;
      }

      if (statement.includes('INSERT INTO digital_forensics_registrations')) {
        const [
          id,
          fullName,
          email,
          phone,
          expectedAmount
        ] = values;
        const timestamp = new Date().toISOString();
        const row = {
          id,
          fullName,
          email,
          phone,
          course: 'digital_forensics',
          status: 'pending',
          pricingOption: null,
          expectedAmount,
          expectedCurrency: 'GHS',
          paymentReference: null,
          verifiedTransactionId: null,
          paymentVerificationTimestamp: null,
          emailNotificationStatus: 'pending',
          smsNotificationStatus: 'pending',
          createdAt: timestamp,
          updatedAt: timestamp
        };
        registrations.set(id, row);
        return [{ ...row }];
      }

      if (statement.includes('UPDATE digital_forensics_registrations')) {
        const [serializedPatch, id, noStatusCondition, expectedStatus,
          noReferenceCondition, expectedPaymentReference] = values;
        const row = registrations.get(id);
        if (
          !row ||
          (!noStatusCondition && row.status !== expectedStatus) ||
          (!noReferenceCondition &&
            row.paymentReference !== expectedPaymentReference)
        ) {
          return [];
        }

        const patch = JSON.parse(serializedPatch);
        if (
          Object.hasOwn(patch, 'paymentReference') &&
          patch.paymentReference !== null &&
          [...registrations.values()].some(
            (other) =>
              other.id !== id &&
              other.paymentReference === patch.paymentReference
          )
        ) {
          throw Object.assign(new Error('unique constraint violation'), {
            code: '23505'
          });
        }

        Object.assign(row, patch, { updatedAt: new Date().toISOString() });
        return [{ ...row }];
      }

      if (statement.includes('FROM digital_forensics_registrations')) {
        const row = registrations.get(values[0]);
        return row ? [{ ...row }] : [];
      }

      throw new Error('Unexpected database statement in test mock.');
    }
  };

  digitalForensicsDatabase.query = fake.query.bind(fake);
  t.after(() => {
    digitalForensicsDatabase.query = originalQuery;
  });

  return { fake, registrations };
}

async function createAwaitingDigitalForensicsRegistration(email, reference) {
  const registration = await digitalForensicsStore.createRegistration({
    fullName: 'Payment Applicant',
    email
  });
  const updated = await digitalForensicsStore.updateRegistration(
    registration.id,
    {
      status: 'payment_initiated',
      paymentReference: reference,
      pricingOption: 'GHS'
    },
    { expectedStatus: 'pending', expectedPaymentReference: null }
  );
  assert.ok(updated);
  return updated;
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

test('Digital Forensics registration records can be created, found, and updated', async (t) => {
  withFakeDigitalForensicsDatabase(t);
  const registration = await digitalForensicsStore.createRegistration({
    fullName: 'Database Applicant',
    email: 'APPLICANT@example.com',
    phone: ' +233201234567 '
  });

  assert.equal(registration.email, 'applicant@example.com');
  assert.equal(registration.phone, '+233201234567');
  assert.equal(registration.status, 'pending');
  assert.equal(registration.course, 'digital_forensics');
  assert.equal(registration.expectedAmount, 1200);
  assert.deepEqual(
    await digitalForensicsStore.findRegistration(registration.id),
    registration
  );

  const updated = await digitalForensicsStore.updateRegistration(
    registration.id,
    {
      status: 'payment_initiated',
      paymentReference: 'DF-123456-ABCDEF',
      pricingOption: 'GHS'
    },
    { expectedStatus: 'pending', expectedPaymentReference: null }
  );
  assert.equal(updated.status, 'payment_initiated');
  assert.equal(updated.paymentReference, 'DF-123456-ABCDEF');
  assert.equal(await digitalForensicsStore.findRegistration('DF-MISSING'), null);
});

test('Digital Forensics database failures are propagated instead of appearing empty', async (t) => {
  const { fake } = withFakeDigitalForensicsDatabase(t);
  fake.failure = Object.assign(new Error('database unavailable'), {
    code: 'ECONNREFUSED'
  });

  await assert.rejects(
    digitalForensicsStore.findRegistration('DF-123456'),
    { code: 'ECONNREFUSED' }
  );
});

test('Digital Forensics initialization returns an error when registration storage fails', async (t) => {
  const { fake } = withFakeDigitalForensicsDatabase(t);
  fake.failure = Object.assign(new Error('database unavailable'), {
    code: 'ECONNREFUSED'
  });
  const paystack = stubPaystackRequest(t, {
    status: true,
    data: {
      authorization_url: 'https://checkout.paystack.test/authorize',
      reference: 'DF-UNUSED'
    }
  });
  const response = createResponse();

  await initializeDigitalForensicsPayment({
    method: 'POST',
    body: { registrationId: 'DF-123456', pricingOption: 'GHS' }
  }, response);

  assert.equal(response.statusCode, 502);
  assert.equal(paystack.options, undefined);
});

test('Digital Forensics conditional updates are atomic and payment references are unique', async (t) => {
  withFakeDigitalForensicsDatabase(t);
  const first = await digitalForensicsStore.createRegistration({
    fullName: 'First Applicant',
    email: 'first@example.com'
  });
  const second = await digitalForensicsStore.createRegistration({
    fullName: 'Second Applicant',
    email: 'second@example.com'
  });

  const attempts = await Promise.all([
    digitalForensicsStore.updateRegistration(
      first.id,
      { status: 'payment_initiated', paymentReference: 'DF-UNIQUE-123' },
      { expectedStatus: 'pending', expectedPaymentReference: null }
    ),
    digitalForensicsStore.updateRegistration(
      first.id,
      { status: 'payment_initiated', paymentReference: 'DF-OTHER-456' },
      { expectedStatus: 'pending', expectedPaymentReference: null }
    )
  ]);
  assert.equal(attempts.filter(Boolean).length, 1);

  const winningReference =
    attempts.find(Boolean).paymentReference;
  await assert.rejects(
    digitalForensicsStore.updateRegistration(second.id, {
      paymentReference: winningReference
    }),
    { code: '23505' }
  );
});

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
  withFakeDigitalForensicsDatabase(t);
  const paystack = stubPaystackRequest(t, {
    status: true,
    data: {
      authorization_url: 'https://checkout.paystack.test/authorize',
      access_code: 'access-code',
      reference: 'CYB-234567-ABCDEF'
    }
  });
  const response = createResponse();

  const { createRegistration } = require('../lib/digital-forensics-store');
  const registration = await createRegistration({
    fullName: 'Test Applicant',
    email: 'applicant@example.com',
    phone: '+233201234567'
  });

  await initializeDigitalForensicsPayment({
    method: 'POST',
    body: {
      email: 'applicant@example.com',
      registrationId: registration.id,
      pricingOption: 'USD_REFERENCE'
    }
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(paystack.body.amount, 138600);
  assert.equal(paystack.body.currency, 'GHS');
  assert.deepEqual(paystack.body.channels, ['card', 'mobile_money']);
  assert.equal(paystack.body.metadata.pricing_option, 'USD_REFERENCE');
});

test('Digital Forensics registration flow requires a valid registration ID and blocks token-only attempts', async (t) => {
  withFakeDigitalForensicsDatabase(t);
  const { createRegistration } = require('../lib/digital-forensics-store');
  const registration = await createRegistration({
    fullName: 'Token-Only Applicant',
    email: 'tokenonly@example.com',
    phone: '+233201234569'
  });

  const missingResponse = createResponse();
  await initializeDigitalForensicsPayment({
    method: 'POST',
    body: { email: 'tokenonly@example.com' }
  }, missingResponse);
  assert.equal(missingResponse.statusCode, 400);

  const invalidResponse = createResponse();
  await initializeDigitalForensicsPayment({
    method: 'POST',
    body: {
      registrationId: 'DF-NOT-REAL',
      email: 'tokenonly@example.com',
      pricingOption: 'GHS'
    }
  }, invalidResponse);
  assert.equal(invalidResponse.statusCode, 404);

  const tokenOnlyResponse = createResponse();
  await initializeDigitalForensicsPayment({
    method: 'POST',
    body: {
      email: 'applicant@example.com',
      qualificationToken: createApplicantToken('digital_forensics')
    }
  }, tokenOnlyResponse);
  assert.equal(tokenOnlyResponse.statusCode, 400);

  const paystack = stubPaystackRequest(t, {
    status: true,
    data: {
      authorization_url: 'https://checkout.paystack.test/authorize',
      access_code: 'access-code',
      reference: 'CYB-246810-ABCDEF'
    }
  });
  const successResponse = createResponse();

  await initializeDigitalForensicsPayment({
    method: 'POST',
    body: {
      registrationId: registration.id,
      email: registration.email,
      pricingOption: 'GHS'
    }
  }, successResponse);

  assert.equal(successResponse.statusCode, 200);
  assert.equal(paystack.body.amount, 120000);
  assert.equal(paystack.body.currency, 'GHS');
  assert.equal(paystack.body.metadata.registration_id, registration.id);
});

test('Digital Forensics local option initializes exactly GH₵1,200 in GHS pesewas', async (t) => {
  withFakeDigitalForensicsDatabase(t);
  const paystack = stubPaystackRequest(t, {
    status: true,
    data: {
      authorization_url: 'https://checkout.paystack.test/authorize',
      access_code: 'access-code',
      reference: 'CYB-246810-ABCDEF'
    }
  });
  const response = createResponse();

  const { createRegistration } = require('../lib/digital-forensics-store');
  const registration = await createRegistration({
    fullName: 'Local Applicant',
    email: 'local@example.com',
    phone: '+233201234568'
  });

  await initializeDigitalForensicsPayment({
    method: 'POST',
    body: {
      registrationId: registration.id,
      email: 'local@example.com',
      pricingOption: 'GHS'
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

test('Digital Forensics verification associates and conditionally marks the persisted registration paid', async (t) => {
  withFakeDigitalForensicsDatabase(t);
  const reference = 'DF-345678-ABCDEF';
  const registration = await createAwaitingDigitalForensicsRegistration(
    'course@example.com',
    reference
  );
  const transaction = {
    id: 998877,
    status: 'success',
    reference,
    currency: 'GHS',
    amount: 120000,
    customer: { email: 'course@example.com' },
    metadata: {
      track: 'digital_forensics',
      pricing_option: 'GHS',
      registration_id: registration.id
    }
  };
  stubPaystackRequest(t, { status: true, data: transaction });
  const response = createResponse();

  await verifyPayment({ method: 'POST', body: { reference } }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.verified, true);
  const savedRegistration =
    await digitalForensicsStore.findRegistration(registration.id);
  assert.equal(savedRegistration.status, 'payment_verified');
  assert.equal(savedRegistration.paymentReference, reference);
  assert.equal(savedRegistration.verifiedTransactionId, transaction.id);
  assert.ok(savedRegistration.paymentVerificationTimestamp);
});

test('Digital Forensics verification does not report success when the database payment update fails', async (t) => {
  const { fake } = withFakeDigitalForensicsDatabase(t);
  const reference = 'DF-345679-ABCDEF';
  const registration = await createAwaitingDigitalForensicsRegistration(
    'course@example.com',
    reference
  );
  fake.failure = {
    statementIncludes: 'UPDATE digital_forensics_registrations',
    error: Object.assign(new Error('database unavailable'), {
      code: 'ECONNREFUSED'
    })
  };
  stubPaystackRequest(t, {
    status: true,
    data: {
      id: 998881,
      status: 'success',
      reference,
      currency: 'GHS',
      amount: 120000,
      customer: { email: 'course@example.com' },
      metadata: {
        track: 'digital_forensics',
        pricing_option: 'GHS',
        registration_id: registration.id
      }
    }
  });
  const response = createResponse();

  await verifyPayment({ method: 'POST', body: { reference } }, response);

  assert.equal(response.statusCode, 502);
  assert.equal(response.body.verified, false);
  fake.failure = null;
  assert.equal(
    (await digitalForensicsStore.findRegistration(registration.id)).status,
    'payment_initiated'
  );
});

test('Digital Forensics verification rejects a wrong amount without marking paid', async (t) => {
  withFakeDigitalForensicsDatabase(t);
  const reference = 'DF-456789-ABCDEF';
  const registration = await createAwaitingDigitalForensicsRegistration(
    'course@example.com',
    reference
  );
  stubPaystackRequest(t, {
    status: true,
    data: {
      id: 998878,
      status: 'success',
      reference,
      currency: 'GHS',
      amount: 1,
      customer: { email: 'course@example.com' },
      metadata: {
        track: 'digital_forensics',
        pricing_option: 'GHS',
        registration_id: registration.id
      }
    }
  });
  const response = createResponse();

  await verifyPayment({ method: 'POST', body: { reference } }, response);

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.verified, false);
  assert.equal(
    (await digitalForensicsStore.findRegistration(registration.id)).status,
    'payment_initiated'
  );
});

test('Digital Forensics verification rejects a wrong currency without marking paid', async (t) => {
  withFakeDigitalForensicsDatabase(t);
  const reference = 'DF-456790-ABCDEF';
  const registration = await createAwaitingDigitalForensicsRegistration(
    'course@example.com',
    reference
  );
  stubPaystackRequest(t, {
    status: true,
    data: {
      id: 998880,
      status: 'success',
      reference,
      currency: 'USD',
      amount: 120000,
      customer: { email: 'course@example.com' },
      metadata: {
        track: 'digital_forensics',
        pricing_option: 'GHS',
        registration_id: registration.id
      }
    }
  });
  const response = createResponse();

  await verifyPayment({ method: 'POST', body: { reference } }, response);

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.verified, false);
  assert.equal(
    (await digitalForensicsStore.findRegistration(registration.id)).status,
    'payment_initiated'
  );
});

test('Digital Forensics verification rejects a Paystack reference not recorded for that registration', async (t) => {
  withFakeDigitalForensicsDatabase(t);
  const storedReference = 'DF-STORED-123456';
  const transactionReference = 'DF-OTHER-123456';
  const registration = await createAwaitingDigitalForensicsRegistration(
    'course@example.com',
    storedReference
  );
  stubPaystackRequest(t, {
    status: true,
    data: {
      id: 998879,
      status: 'success',
      reference: transactionReference,
      currency: 'GHS',
      amount: 120000,
      customer: { email: 'course@example.com' },
      metadata: {
        track: 'digital_forensics',
        pricing_option: 'GHS',
        registration_id: registration.id
      }
    }
  });
  const response = createResponse();

  await verifyPayment({
    method: 'POST',
    body: { reference: transactionReference }
  }, response);

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.verified, false);
  assert.equal(
    (await digitalForensicsStore.findRegistration(registration.id)).status,
    'payment_initiated'
  );
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
