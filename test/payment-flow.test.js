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
const regularTrackDatabase = require('../lib/digital-forensics-database');
const regularTrackStore = require('../lib/regular-track-payment-store');
const createRegularTrackRegistration =
  require('../api/create-regular-track-registration');

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
  const consentEvents = [];
  const statements = [];
  const fake = {
    failure: null,
    async query(strings, ...values) {
      const statement = strings.join(' ');
      statements.push(statement);
      if (
        this.failure &&
        (!this.failure.statementIncludes ||
          statement.includes(this.failure.statementIncludes))
      ) {
        throw this.failure.error || this.failure;
      }

      if (statement.includes('FROM email_notification_outbox')) return [];

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
        if (values.at(-1) === true) {
          consentEvents.push({
            registrationId: id,
            eventType: 'grant',
            phoneSnapshot: phone,
            purpose: values[5],
            policyVersion: values[6],
            source: values[7],
            occurredAt: timestamp
          });
        }
        return [{ ...row }];
      }

      if (statement.includes('UPDATE digital_forensics_registrations')) {
        if (statement.includes('WITH updated AS')) {
          const [status, , transactionId, , verificationTimestamp, id, reference] = values;
          const row = registrations.get(id);
          if (!row || row.status !== 'payment_initiated' ||
              row.paymentReference !== reference) return [];
          Object.assign(row, {
            status,
            verifiedTransactionId: status === 'payment_verified'
              ? String(transactionId)
              : null,
            paymentVerificationTimestamp: status === 'payment_verified'
              ? verificationTimestamp
              : null,
            updatedAt: new Date().toISOString()
          });
          return [{
            ...row,
            notificationEventKey: `digital-forensics-payment-success:${id}:${reference}`
          }];
        }
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

  return { fake, registrations, consentEvents, statements };
}

function withFakeRegularTrackDatabase(t) {
  const originalQuery = regularTrackDatabase.query;
  const applicants = new Map();
  const consentEvents = [];
  const attempts = new Map();
  const statements = [];
  const fake = {
    failure: null,
    async query(strings, ...values) {
      const statement = strings.join(' ');
      statements.push(statement);
      const normalizedStatement = statement.replace(/\s+/g, ' ').trim();
      if (
        this.failure &&
        (!this.failure.statementIncludes ||
          statement.includes(this.failure.statementIncludes))
      ) {
        throw this.failure.error || this.failure;
      }

      if (statement.includes('FROM email_notification_outbox')) return [];

      if (statement.includes('INSERT INTO regular_track_applicants')) {
        const [id, fullName, email, phone, track] = values;
        const applicant = {
          id,
          fullName,
          email,
          phone,
          track,
          status: 'pending'
        };
        applicants.set(id, applicant);
        if (values.at(-1) === true) {
          consentEvents.push({
            registrationId: id,
            eventType: 'grant',
            phoneSnapshot: phone,
            purpose: values[5],
            policyVersion: values[6],
            source: 'main_application',
            occurredAt: new Date().toISOString()
          });
        }
        return [{ ...applicant }];
      }

      if (statement.includes('INSERT INTO regular_track_payment_attempts')) {
        const [registrationId, reference, referenceAmount, expectedAmount,
          expectedCurrency] = values;
        const applicant = applicants.get(registrationId);
        const hasActiveAttempt = [...attempts.values()].some((attempt) =>
          attempt.registrationId === registrationId &&
          ['initializing', 'payment_initiated'].includes(attempt.status)
        );
        if (!applicant || applicant.status !== 'pending' || hasActiveAttempt) {
          return [];
        }

        const attempt = {
          reference,
          registrationId,
          referenceAmount,
          referenceCurrency: 'USD',
          expectedAmount,
          expectedCurrency,
          status: 'initializing',
          verifiedTransactionId: null,
          paymentVerificationTimestamp: null
        };
        attempts.set(reference, attempt);
        applicant.status = 'payment_initiated';
        return [{ ...attempt }];
      }

      if (statement.includes('FROM regular_track_payment_attempts AS payment')) {
        const attempt = attempts.get(values[0]);
        const applicant = attempt && applicants.get(attempt.registrationId);
        return attempt && applicant
          ? [{ ...attempt, email: applicant.email, track: applicant.track, applicantStatus: applicant.status }]
          : [];
      }

      if (
        statement.includes('UPDATE regular_track_payment_attempts') &&
        values.includes('initialization_failed')
      ) {
        const reference = values.find((value) => attempts.has(value));
        const attempt = attempts.get(reference);
        if (!attempt || attempt.status !== 'initializing') {
          return [];
        }
        attempt.status = 'initialization_failed';
        const applicant = applicants.get(attempt.registrationId);
        if (
          applicant.status !== 'payment_verified' &&
          ![...attempts.values()].some((candidate) =>
            candidate.registrationId === applicant.id &&
            ['initializing', 'payment_initiated'].includes(candidate.status)
          )
        ) {
          applicant.status = 'pending';
        }
        return [{ registrationId: attempt.registrationId }];
      }

      if (
        normalizedStatement.startsWith(
          'UPDATE regular_track_payment_attempts SET status = , updated_at = CURRENT_TIMESTAMP'
        )
      ) {
        const [status, reference] = values;
        const attempt = attempts.get(reference);
        if (!attempt || attempt.status !== 'initializing') {
          return [];
        }
        attempt.status = status;
        return [{ reference, registrationId: attempt.registrationId }];
      }

      if (statement.includes("SET status = 'failed'")) {
        const [reference] = values;
        const attempt = attempts.get(reference);
        if (
          !attempt ||
          !['initializing', 'payment_initiated'].includes(attempt.status)
        ) {
          return [];
        }
        attempt.status = 'failed';
        const applicant = applicants.get(attempt.registrationId);
        applicant.status = [...attempts.values()].some((candidate) =>
          candidate.registrationId === applicant.id &&
          ['initializing', 'payment_initiated'].includes(candidate.status)
        )
          ? 'payment_initiated'
          : 'pending';
        return [{ registrationId: attempt.registrationId }];
      }

      if (
        statement.includes('WITH applicant AS MATERIALIZED') &&
        statement.includes('UPDATE regular_track_payment_attempts')
      ) {
        const [lookupReference, transactionId, reference] = values;
        const attempt = attempts.get(reference);
        const applicant = attempt && applicants.get(attempt.registrationId);
        if (
          lookupReference !== reference ||
          !attempt ||
          !applicant ||
          applicant.status === 'payment_verified' ||
          !['initializing', 'payment_initiated'].includes(attempt.status)
        ) {
          return [];
        }
        attempt.status = 'payment_verified';
        attempt.verifiedTransactionId = transactionId;
        attempt.paymentVerificationTimestamp = new Date().toISOString();
        applicant.status = 'payment_verified';
        return [{ reference, registrationId: attempt.registrationId }];
      }

      if (statement.includes('FROM regular_track_applicants')) {
        const applicant = applicants.get(values[0]);
        return applicant ? [{ ...applicant }] : [];
      }

      throw new Error('Unexpected regular-track database statement in test mock.');
    }
  };

  regularTrackDatabase.query = fake.query.bind(fake);
  t.after(() => {
    regularTrackDatabase.query = originalQuery;
  });

  return { fake, applicants, consentEvents, attempts, statements };
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

async function createAwaitingRegularTrackPayment(email, reference) {
  const applicant = await regularTrackStore.createApplicant({
    fullName: 'Test Applicant',
    email,
    phone: '+233201234567',
    track: 'incident_response'
  });
  await regularTrackStore.createPaymentAttempt({
    reference,
    registrationId: applicant.id,
    referenceAmount: 30,
    expectedAmount: 34650,
    expectedCurrency: 'GHS'
  });
  await regularTrackStore.updatePaymentAttemptStatus(
    reference,
    'payment_initiated'
  );
  return {
    applicant,
    token: createApplicantToken(),
    reference
  };
}

function stubPaystackRequest(t, responseData) {
  const originalRequest = https.request;
  let requestOptions;
  let requestBody = '';
  let requestCount = 0;

  https.request = (options, callback) => {
    requestCount += 1;
    requestOptions = options;
    const request = new EventEmitter();
    request.write = (chunk) => {
      requestBody += chunk;
    };
    request.setTimeout = () => {};
    request.destroy = (error) => request.emit('error', error);
    request.end = () => {
      const requestData = requestBody ? JSON.parse(requestBody) : null;
      const reply = typeof responseData === 'function'
        ? responseData(requestOptions, requestData)
        : responseData;
      const response = new EventEmitter();
      response.statusCode = 200;
      callback(response);
      process.nextTick(() => {
        response.emit('data', Buffer.from(JSON.stringify(reply)));
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
    },
    get requestCount() {
      return requestCount;
    }
  };
}

test('Digital Forensics registration records can be created, found, and updated', async (t) => {
  const { consentEvents } = withFakeDigitalForensicsDatabase(t);
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
  assert.equal(consentEvents.length, 0);
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

test('Digital Forensics opt-in persists immutable grant evidence with normalized phone', async (t) => {
  const { consentEvents } = withFakeDigitalForensicsDatabase(t);
  const registration = await digitalForensicsStore.createRegistration({
    fullName: 'Consent Applicant',
    email: 'consent@example.com',
    phone: '0241234567',
    smsConsent: true,
    consentSource: 'main_application'
  });

  assert.equal(registration.phone, '+233241234567');
  assert.equal(consentEvents.length, 1);
  assert.deepEqual(consentEvents[0], {
    registrationId: registration.id,
    eventType: 'grant',
    phoneSnapshot: '+233241234567',
    purpose: 'SMS notifications confirming successful payment for a Cybanext programme.',
    policyVersion: 'sms-payment-success-v1',
    source: 'main_application',
    occurredAt: consentEvents[0].occurredAt
  });
  assert.ok(Number.isFinite(Date.parse(consentEvents[0].occurredAt)));
});

test('Digital Forensics consent cannot be recorded without valid phone and DB failure is atomic', async (t) => {
  const { fake, registrations, consentEvents } =
    withFakeDigitalForensicsDatabase(t);
  await assert.rejects(
    digitalForensicsStore.createRegistration({
      fullName: 'Consent Applicant',
      email: 'consent@example.com',
      phone: '',
      smsConsent: true
    }),
    /valid Ghanaian phone number/
  );
  fake.failure = Object.assign(new Error('database unavailable'), {
    code: 'ECONNREFUSED'
  });
  await assert.rejects(
    digitalForensicsStore.createRegistration({
      fullName: 'Consent Applicant',
      email: 'consent@example.com',
      phone: '+233241234567',
      smsConsent: true
    }),
    { code: 'ECONNREFUSED' }
  );
  assert.equal(registrations.size, 0);
  assert.equal(consentEvents.length, 0);
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

test('regular-track registration requires qualification and persists applicant details', async (t) => {
  const { consentEvents } = withFakeRegularTrackDatabase(t);
  const response = createResponse();

  await createRegularTrackRegistration({
    method: 'POST',
    body: {
      fullName: 'Test Applicant',
      email: 'applicant@example.com',
      phone: '+233201234567',
      qualificationToken: createApplicantToken()
    }
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.track, 'incident_response');
  assert.equal(response.body.status, 'pending');
  const savedApplicant =
    await regularTrackStore.findApplicant(response.body.registrationId);
  assert.equal(savedApplicant.fullName, 'Test Applicant');
  assert.equal(savedApplicant.email, 'applicant@example.com');
  assert.equal(savedApplicant.phone, '+233201234567');
  assert.equal(consentEvents.length, 0);
});

test('regular-track registration captures explicit consent and rejects consent without phone', async () => {
  const saved = [];
  const handler = createRegularTrackRegistration.createHandler({
    async createApplicant(applicant) {
      saved.push(applicant);
      return {
        id: 'RT-CONSENT-123',
        track: applicant.track,
        status: 'pending'
      };
    }
  });
  const token = createQualificationToken({
    name: 'Test Applicant',
    email: 'applicant@example.com',
    phone: '0241234567',
    track: 'incident_response'
  });
  const response = createResponse();
  await handler({
    method: 'POST',
    body: {
      fullName: 'Test Applicant',
      email: 'applicant@example.com',
      phone: '0241234567',
      smsConsent: true,
      qualificationToken: token
    }
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(saved[0].phone, '+233241234567');
  assert.equal(saved[0].smsConsent, true);

  const invalidResponse = createResponse();
  await handler({
    method: 'POST',
    body: {
      fullName: 'Test Applicant',
      email: 'applicant@example.com',
      phone: '',
      smsConsent: true,
      qualificationToken: createApplicantToken()
    }
  }, invalidResponse);
  assert.equal(invalidResponse.statusCode, 400);
  assert.match(invalidResponse.body.error, /valid Ghanaian phone number/i);
  assert.equal(saved.length, 1);
});

test('regular-track store inserts consent event with the registration statement', async (t) => {
  const { consentEvents, statements } = withFakeRegularTrackDatabase(t);
  const applicant = await regularTrackStore.createApplicant({
    fullName: 'Consent Applicant',
    email: 'consent@example.com',
    phone: '0241234567',
    track: 'incident_response',
    smsConsent: true
  });

  assert.equal(applicant.phone, '+233241234567');
  assert.equal(consentEvents.length, 1);
  assert.equal(consentEvents[0].phoneSnapshot, '+233241234567');
  assert.equal(consentEvents[0].purpose,
    'SMS notifications confirming successful payment for a Cybanext programme.');
  assert.equal(consentEvents[0].source, 'main_application');
  assert.ok(statements.some((statement) =>
    statement.includes('INSERT INTO sms_consent_events')));
});

test('regular payment initialization ignores client price and currency', async (t) => {
  withFakeRegularTrackDatabase(t);
  const applicant = await regularTrackStore.createApplicant({
    fullName: 'Test Applicant',
    email: 'applicant@example.com',
    phone: '+233201234567',
    track: 'incident_response'
  });
  const paystack = stubPaystackRequest(t, (_options, body) => ({
    status: true,
    data: {
      authorization_url: 'https://checkout.paystack.test/authorize',
      access_code: 'access-code',
      reference: body.reference
    }
  }));
  const response = createResponse();

  await initializePayment({
    method: 'POST',
    body: {
      email: 'applicant@example.com',
      track: 'incident_response',
      registrationId: applicant.id,
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
  assert.equal(paystack.body.metadata.registration_id, applicant.id);
  assert.equal(
    (await regularTrackStore.findPaymentAttempt(paystack.body.reference)).status,
    'payment_initiated'
  );
  assert.equal(
    (await regularTrackStore.findApplicant(applicant.id)).status,
    'payment_initiated'
  );
  assert.equal(Object.hasOwn(response.body, 'amount'), false);
});

test('regular payment metadata uses normalized Ghana phone numbers', async (t) => {
  withFakeRegularTrackDatabase(t);
  const applicant = await regularTrackStore.createApplicant({
    fullName: 'Test Applicant',
    email: 'applicant@example.com',
    phone: '0241234567',
    track: 'incident_response'
  });
  const paystack = stubPaystackRequest(t, (_options, body) => ({
    status: true,
    data: {
      authorization_url: 'https://checkout.paystack.test/authorize',
      reference: body.reference
    }
  }));
  const response = createResponse();
  const qualificationToken = createQualificationToken({
    name: 'Test Applicant',
    email: 'applicant@example.com',
    phone: '0241234567',
    track: 'incident_response'
  });

  await initializePayment({
    method: 'POST',
    body: {
      registrationId: applicant.id,
      qualificationToken
    }
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(paystack.body.metadata.applicant_phone, '+233241234567');
});

test('failed initialization releases the applicant for a new payment attempt', async (t) => {
  withFakeRegularTrackDatabase(t);
  const applicant = await regularTrackStore.createApplicant({
    fullName: 'Test Applicant',
    email: 'applicant@example.com',
    phone: '+233201234567',
    track: 'incident_response'
  });
  const firstAttempt = await regularTrackStore.createPaymentAttempt({
    reference: 'CYB-INITIALIZING-123456',
    registrationId: applicant.id,
    referenceAmount: 30,
    expectedAmount: 34650,
    expectedCurrency: 'GHS'
  });
  assert.ok(firstAttempt);

  await regularTrackStore.updatePaymentAttemptStatus(
    firstAttempt.reference,
    'initialization_failed'
  );

  assert.equal(
    (await regularTrackStore.findPaymentAttempt(firstAttempt.reference)).status,
    'initialization_failed'
  );
  assert.equal(
    (await regularTrackStore.findApplicant(applicant.id)).status,
    'pending'
  );
  const retry = await regularTrackStore.createPaymentAttempt({
    reference: 'CYB-RETRY-123456',
    registrationId: applicant.id,
    referenceAmount: 30,
    expectedAmount: 34650,
    expectedCurrency: 'GHS'
  });
  assert.ok(retry);
});

test('concurrent regular payment initialization creates only one active attempt', async (t) => {
  const { applicants, attempts } = withFakeRegularTrackDatabase(t);
  const applicant = await regularTrackStore.createApplicant({
    fullName: 'Test Applicant',
    email: 'applicant@example.com',
    phone: '+233201234567',
    track: 'incident_response'
  });
  const paystack = stubPaystackRequest(t, (_options, body) => ({
    status: true,
    data: {
      authorization_url: 'https://checkout.paystack.test/authorize',
      access_code: 'access-code',
      reference: body.reference
    }
  }));
  const request = {
    method: 'POST',
    body: {
      email: applicant.email,
      track: applicant.track,
      registrationId: applicant.id,
      qualificationToken: createApplicantToken()
    }
  };
  const responses = [createResponse(), createResponse()];

  await Promise.all(responses.map((response) =>
    initializePayment(request, response)));

  assert.deepEqual(
    responses.map((response) => response.statusCode).sort(),
    [200, 409]
  );
  assert.equal(paystack.requestCount, 1);
  assert.equal(attempts.size, 1);
  assert.equal(applicants.get(applicant.id).status, 'payment_initiated');
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
    phone: '0241234568'
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
  assert.equal(paystack.body.metadata.applicant_phone, '+233241234568');
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
  const { statements } = withFakeDigitalForensicsDatabase(t);
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
  assert.equal(savedRegistration.verifiedTransactionId, String(transaction.id));
  assert.ok(savedRegistration.paymentVerificationTimestamp);
  assert.ok(statements.some((statement) =>
    statement.includes('INSERT INTO email_notification_outbox') &&
    statement.includes('WITH updated AS')
  ));
});

test('Digital Forensics repeat verification normalizes PostgreSQL text transaction IDs', async (t) => {
  const { statements } = withFakeDigitalForensicsDatabase(t);
  const reference = 'DF-345678-REPEATED';
  const registration = await createAwaitingDigitalForensicsRegistration(
    'course@example.com',
    reference
  );
  const transaction = {
    id: 998879,
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

  const firstResponse = createResponse();
  await verifyPayment({ method: 'POST', body: { reference } }, firstResponse);
  const secondResponse = createResponse();
  await verifyPayment({ method: 'POST', body: { reference } }, secondResponse);

  assert.equal(firstResponse.statusCode, 200);
  assert.equal(secondResponse.statusCode, 200);
  assert.equal(secondResponse.body.verified, true);
  assert.equal(
    (await digitalForensicsStore.findRegistration(registration.id)).verifiedTransactionId,
    String(transaction.id)
  );
  assert.equal(statements.filter((statement) =>
    statement.includes('INSERT INTO email_notification_outbox') &&
    statement.includes('WITH updated AS')
  ).length, 1);
});

test('Digital Forensics only records and notifies an explicitly failed Paystack payment', async (t) => {
  const { statements } = withFakeDigitalForensicsDatabase(t);
  const reference = 'DF-345678-FAILURE';
  const registration = await createAwaitingDigitalForensicsRegistration(
    'course@example.com',
    reference
  );
  stubPaystackRequest(t, {
    status: true,
    data: {
      id: 998878,
      status: 'failed',
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

  assert.equal(response.statusCode, 400);
  assert.equal(
    (await digitalForensicsStore.findRegistration(registration.id)).status,
    'payment_failed'
  );
  assert.ok(statements.some((statement) =>
    statement.includes('INSERT INTO email_notification_outbox')
  ));
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
  const { statements } = withFakeRegularTrackDatabase(t);
  const reference = 'CYB-345678-ABCDEF';
  const { applicant, token } = await createAwaitingRegularTrackPayment(
    'applicant@example.com',
    reference
  );
  stubPaystackRequest(t, {
    status: true,
    data: {
      id: 7654321,
      status: 'success',
      reference,
      currency: 'GHS',
      amount: 34650,
      customer: { email: 'applicant@example.com' },
      metadata: {
        registration_id: applicant.id,
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
  assert.equal(response.body.registrationId, applicant.id);
  const attempt = await regularTrackStore.findPaymentAttempt(reference);
  assert.equal(attempt.status, 'payment_verified');
  assert.equal(attempt.verifiedTransactionId, '7654321');
  assert.ok(statements.some((statement) =>
    statement.includes('INSERT INTO email_notification_outbox') &&
    statement.includes('WITH applicant AS MATERIALIZED')
  ));
  assert.equal(
    (await regularTrackStore.findApplicant(applicant.id)).status,
    'payment_verified'
  );
});

test('verification rejects a mismatched transaction amount', async (t) => {
  withFakeRegularTrackDatabase(t);
  const reference = 'CYB-456789-ABCDEF';
  const { applicant, token } = await createAwaitingRegularTrackPayment(
    'applicant@example.com',
    reference
  );
  stubPaystackRequest(t, {
    status: true,
    data: {
      status: 'success',
      reference,
      currency: 'GHS',
      amount: 1,
      customer: { email: 'applicant@example.com' },
      metadata: {
        registration_id: applicant.id,
        track: 'incident_response',
        pricing_option: 'USD_REFERENCE',
        qualification_token: token
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
    body: { reference }
  }, response);

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.verified, false);
  assert.equal(
    (await regularTrackStore.findPaymentAttempt(reference)).status,
    'payment_initiated'
  );
});

test('verification rejects an incorrect transaction currency', async (t) => {
  withFakeRegularTrackDatabase(t);
  const reference = 'CYB-456790-ABCDEF';
  const { applicant, token } = await createAwaitingRegularTrackPayment(
    'applicant@example.com',
    reference
  );
  stubPaystackRequest(t, {
    status: true,
    data: {
      id: 7654322,
      status: 'success',
      reference,
      currency: 'USD',
      amount: 34650,
      customer: { email: 'applicant@example.com' },
      metadata: {
        registration_id: applicant.id,
        track: 'incident_response',
        pricing_option: 'USD_REFERENCE',
        qualification_token: token
      }
    }
  });
  const response = createResponse();

  await verifyPayment({ method: 'POST', body: { reference } }, response);

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.verified, false);
  assert.equal(
    (await regularTrackStore.findPaymentAttempt(reference)).status,
    'payment_initiated'
  );
});

test('unsuccessful Paystack verification marks the known payment attempt failed', async (t) => {
  const { statements } = withFakeRegularTrackDatabase(t);
  const reference = 'CYB-456791-ABCDEF';
  const { applicant, token } = await createAwaitingRegularTrackPayment(
    'applicant@example.com',
    reference
  );
  stubPaystackRequest(t, {
    status: true,
    data: {
      id: 7654323,
      status: 'failed',
      reference,
      currency: 'GHS',
      amount: 34650,
      customer: { email: 'applicant@example.com' },
      metadata: {
        registration_id: applicant.id,
        track: 'incident_response',
        pricing_option: 'USD_REFERENCE',
        qualification_token: token
      }
    }
  });
  const response = createResponse();

  await verifyPayment({ method: 'POST', body: { reference } }, response);

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.verified, false);
  assert.equal(
    (await regularTrackStore.findPaymentAttempt(reference)).status,
    'failed'
  );
  assert.equal(
    (await regularTrackStore.findApplicant(applicant.id)).status,
    'pending'
  );
  assert.ok(statements.some((statement) =>
    statement.includes("'regular_track_payment_failure'") &&
    statement.includes('INSERT INTO email_notification_outbox')
  ));
});

test('unknown regular-track payment references are rejected after Paystack verification', async (t) => {
  withFakeRegularTrackDatabase(t);
  const reference = 'CYB-UNKNOWN-123456';
  stubPaystackRequest(t, {
    status: true,
    data: {
      id: 7654324,
      status: 'success',
      reference,
      currency: 'GHS',
      amount: 34650,
      customer: { email: 'applicant@example.com' },
      metadata: {
        registration_id: 'RT-UNKNOWN',
        track: 'incident_response',
        pricing_option: 'USD_REFERENCE',
        qualification_token: createApplicantToken()
      }
    }
  });
  const response = createResponse();

  await verifyPayment({ method: 'POST', body: { reference } }, response);

  assert.equal(response.statusCode, 404);
  assert.equal(response.body.verified, false);
});

test('duplicate verification is idempotent and repeated callbacks update one record', async (t) => {
  withFakeRegularTrackDatabase(t);
  const reference = 'CYB-DUPLICATE-123456';
  const { applicant, token } = await createAwaitingRegularTrackPayment(
    'applicant@example.com',
    reference
  );
  stubPaystackRequest(t, {
    status: true,
    data: {
      id: 7654325,
      status: 'success',
      reference,
      currency: 'GHS',
      amount: 34650,
      customer: { email: 'applicant@example.com' },
      metadata: {
        registration_id: applicant.id,
        track: 'incident_response',
        pricing_option: 'USD_REFERENCE',
        qualification_token: token
      }
    }
  });
  const responses = [createResponse(), createResponse()];

  await Promise.all(responses.map((response) =>
    verifyPayment({ method: 'POST', body: { reference } }, response)));

  assert.deepEqual(responses.map((response) => response.statusCode), [200, 200]);
  assert.deepEqual(responses.map((response) => response.body.verified), [true, true]);
  const attempt = await regularTrackStore.findPaymentAttempt(reference);
  assert.equal(attempt.status, 'payment_verified');
  assert.equal(attempt.verifiedTransactionId, '7654325');
});

test('database persistence failure never reports a regular-track payment as verified', async (t) => {
  const { fake } = withFakeRegularTrackDatabase(t);
  const reference = 'CYB-DB-FAIL-123456';
  const { applicant, token } = await createAwaitingRegularTrackPayment(
    'applicant@example.com',
    reference
  );
  fake.failure = Object.assign(new Error('database unavailable'), {
    statementIncludes: "status = 'payment_verified'",
    error: Object.assign(new Error('database unavailable'), {
      code: 'ECONNREFUSED'
    })
  });
  stubPaystackRequest(t, {
    status: true,
    data: {
      id: 7654326,
      status: 'success',
      reference,
      currency: 'GHS',
      amount: 34650,
      customer: { email: 'applicant@example.com' },
      metadata: {
        registration_id: applicant.id,
        track: 'incident_response',
        pricing_option: 'USD_REFERENCE',
        qualification_token: token
      }
    }
  });
  const response = createResponse();

  await verifyPayment({ method: 'POST', body: { reference } }, response);

  assert.equal(response.statusCode, 502);
  assert.equal(response.body.verified, false);
  fake.failure = null;
  assert.equal(
    (await regularTrackStore.findPaymentAttempt(reference)).status,
    'payment_initiated'
  );
  assert.equal(
    (await regularTrackStore.findApplicant(applicant.id)).status,
    'payment_initiated'
  );
});
