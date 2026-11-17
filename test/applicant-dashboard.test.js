const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const applicantSessionEndpoint = require('../api/applicant-session');
const database = require('../lib/digital-forensics-database');
const authStore = require('../lib/applicant-auth-store');
const {
  SESSION_COOKIE_NAME,
  createApplicantAuthService
} = require('../lib/applicant-auth-service');
const {
  applicationStatusLabel,
  getApplicantDashboardData,
  normalizeStatus,
  paymentStatusLabel
} = require('../lib/applicant-dashboard-data');

function createResponse() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
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

function createApplicant(overrides = {}) {
  return {
    id: 'DF-own-registration',
    fullName: 'Test Applicant',
    email: 'applicant@example.test',
    course: 'digital_forensics',
    status: 'pending',
    expectedAmount: 1500,
    expectedCurrency: 'GHS',
    pricingOption: 'GHS',
    paymentReference: null,
    verifiedTransactionId: null,
    paymentVerificationTimestamp: null,
    createdAt: '2026-10-20T12:00:00.000Z',
    ...overrides
  };
}

test('unauthenticated dashboard requests return 401 without loading registration data', async () => {
  let lookupCount = 0;
  const handler = applicantSessionEndpoint.createHandler(
    { async getSession() { return null; } },
    async () => {
      lookupCount += 1;
      return createApplicant();
    }
  );
  const response = createResponse();

  await handler({
    method: 'GET',
    headers: {},
    query: { includeDashboard: 'true' }
  }, response);

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, { authenticated: false });
  assert.equal(lookupCount, 0);
});

test('authenticated applicant receives dashboard data for the session registration only', async () => {
  const lookupIds = [];
  const sessionService = {
    async getSession(cookie) {
      assert.equal(cookie, 'session-cookie');
      return {
        applicantType: 'digital_forensics',
        registrationId: 'DF-own-registration'
      };
    }
  };
  const handler = applicantSessionEndpoint.createHandler(
    sessionService,
    async (registrationId, applicantType) => {
      lookupIds.push(registrationId);
      assert.equal(applicantType, 'digital_forensics');
      return { fullName: 'Test Applicant', registrationId };
    }
  );
  const response = createResponse();

  await handler({
    method: 'GET',
    headers: { cookie: 'session-cookie' },
    query: { includeDashboard: 'true' }
  }, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(lookupIds, ['DF-own-registration']);
  assert.deepEqual(response.body, {
    authenticated: true,
    applicant: {
      fullName: 'Test Applicant',
      registrationId: 'DF-own-registration'
    }
  });
  assert.equal(response.headers['Cache-Control'], 'no-store');
});

test('payment query parameters cannot authenticate or select another applicant', async () => {
  let lookupCount = 0;
  const handler = applicantSessionEndpoint.createHandler(
    {
      async getSession(cookie) {
        assert.equal(cookie, undefined);
        return null;
      },
      async verifyLoginToken() {
        assert.fail('dashboard requests must not redeem login tokens');
      }
    },
    async () => {
      lookupCount += 1;
      return createApplicant({ id: 'DF-other-registration' });
    }
  );
  const response = createResponse();

  await handler({
    method: 'GET',
    headers: {},
    query: {
      includeDashboard: 'true',
      status: 'success',
      success: 'true',
      reference: 'DF-OTHER-APPLICANT-REFERENCE',
      trxref: 'DF-OTHER-APPLICANT-REFERENCE',
      payment_reference: 'DF-OTHER-APPLICANT-REFERENCE',
      registrationId: 'DF-other-registration'
    }
  }, response);

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, { authenticated: false });
  assert.equal(lookupCount, 0);
  assert.equal(JSON.stringify(response.body).includes('DF-other-registration'), false);
});

test('expired session cookie is rejected without dashboard lookup or renewal', async (t) => {
  const originalQuery = database.query;
  let sessionQuery = '';
  database.query = async (strings) => {
    sessionQuery = strings.join(' ');
    return [];
  };
  t.after(() => {
    database.query = originalQuery;
  });

  const handler = applicantSessionEndpoint.createHandler(
    createApplicantAuthService({ store: authStore }),
    async () => assert.fail('expired sessions must not load applicant data')
  );
  const sessionToken = crypto.randomBytes(32).toString('base64url');
  const response = createResponse();

  await handler({
    method: 'GET',
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`
    },
    query: { includeDashboard: 'true' }
  }, response);

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, { authenticated: false });
  assert.match(sessionQuery, /expires_at > CURRENT_TIMESTAMP/);
  assert.doesNotMatch(sessionQuery, /INSERT INTO applicant_sessions/);
});

test('URL and request-body registration IDs cannot override session ownership', async () => {
  const lookupIds = [];
  const handler = applicantSessionEndpoint.createHandler(
    {
      async getSession() {
        return {
          applicantType: 'digital_forensics',
          registrationId: 'DF-session-registration'
        };
      }
    },
    async (registrationId) => {
      lookupIds.push(registrationId);
      return { registrationId };
    }
  );
  const response = createResponse();

  await handler({
    method: 'GET',
    headers: { 'x-registration-id': 'DF-attacker-header' },
    query: {
      includeDashboard: 'true',
      registrationId: 'DF-attacker-query'
    },
    params: { registrationId: 'DF-attacker-params' },
    body: { registrationId: 'DF-attacker-body' }
  }, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(lookupIds, ['DF-session-registration']);
  assert.equal(response.body.applicant.registrationId, 'DF-session-registration');
});

test('missing session registration and missing persisted registration are safely rejected', async (t) => {
  await t.test('missing session registration', async () => {
    const handler = applicantSessionEndpoint.createHandler(
      { async getSession() { return {}; } },
      async () => assert.fail('registration lookup should not run')
    );
    const response = createResponse();

    await handler({
      method: 'GET',
      headers: {},
      query: { includeDashboard: 'true' }
    }, response);

    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.body, { authenticated: false });
  });

  await t.test('missing persisted registration', async () => {
    const handler = applicantSessionEndpoint.createHandler(
      {
        async getSession() {
          return {
            applicantType: 'digital_forensics',
            registrationId: 'DF-missing'
          };
        }
      },
      async () => null
    );
    const response = createResponse();

    await handler({
      method: 'GET',
      headers: {},
      query: { includeDashboard: 'true' }
    }, response);

    assert.equal(response.statusCode, 404);
    assert.equal(response.body.authenticated, true);
    assert.equal(response.body.applicant, null);
    assert.equal(JSON.stringify(response.body).includes('DF-missing'), false);
  });
});

test('verified multi-registration sessions list choices and bind only a server-validated selection', async () => {
  const calls = [];
  const service = {
    async getSession() {
      return { registrationId: null, selectionRequired: true };
    },
    async listApplicantRegistrations(cookie) {
      calls.push({ type: 'list', cookie });
      return [{
        applicantType: 'regular_track',
        registrationId: 'RT-owned',
        track: 'incident_response'
      }];
    },
    async selectApplicantRegistration(cookie, selection) {
      calls.push({ type: 'select', cookie, selection });
      return selection.registrationId === 'RT-owned' ? selection : null;
    }
  };
  const handler = applicantSessionEndpoint.createHandler(
    service,
    async () => assert.fail('pending selection sessions must not load a dashboard')
  );
  const listResponse = createResponse();
  await handler({
    method: 'GET',
    headers: { cookie: 'verified-cookie' },
    query: { includeRegistrations: 'true' }
  }, listResponse);

  assert.equal(listResponse.statusCode, 200);
  assert.deepEqual(listResponse.body, {
    authenticated: true,
    selectionRequired: true,
    registrations: [{
      applicantType: 'regular_track',
      registrationId: 'RT-owned',
      track: 'incident_response'
    }]
  });

  const selectResponse = createResponse();
  await handler({
    method: 'POST',
    headers: { cookie: 'verified-cookie' },
    body: {
      action: 'select-registration',
      applicantType: 'regular_track',
      registrationId: 'RT-owned'
    }
  }, selectResponse);

  assert.equal(selectResponse.statusCode, 200);
  assert.deepEqual(selectResponse.body, { selected: true });
  assert.deepEqual(calls, [
    { type: 'list', cookie: 'verified-cookie' },
    {
      type: 'select',
      cookie: 'verified-cookie',
      selection: {
        applicantType: 'regular_track',
        registrationId: 'RT-owned'
      }
    }
  ]);
});

test('regular-track sessions cannot download or resend Digital Forensics receipts', async (t) => {
  for (const action of ['download-receipt', 'resend-receipt']) {
    await t.test(action, async () => {
      const handler = applicantSessionEndpoint.createHandler({
        async getSession() {
          return {
            applicantType: 'regular_track',
            registrationId: 'RT-own-registration',
            selectionRequired: false
          };
        }
      });
      const response = createResponse();
      await handler({
        method: 'POST',
        headers: {},
        body: { action }
      }, response);

      assert.equal(response.statusCode, 403);
      assert.equal(response.body.error, 'Receipts are not available for this registration.');
    });
  }
});

test('dashboard data lookup errors return a generic response without database details', async () => {
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    const handler = applicantSessionEndpoint.createHandler(
      {
        async getSession() {
          return {
            applicantType: 'digital_forensics',
            registrationId: 'DF-own-registration'
          };
        }
      },
      async () => {
        throw new Error('private database connection string');
      }
    );
    const response = createResponse();

    await handler({
      method: 'GET',
      headers: {},
      query: { includeDashboard: 'true' }
    }, response);

    assert.equal(response.statusCode, 503);
    assert.equal(response.body.authenticated, false);
    assert.equal(JSON.stringify(response.body).includes('private database'), false);
    assert.equal(JSON.stringify(errors).includes('private database'), false);
  } finally {
    console.error = originalError;
  }
});

test('dashboard data uses persisted registration values and leaves historical amounts unchanged', async () => {
  const historical = createApplicant({
    id: 'DF-historical',
    status: 'payment_initiated',
    expectedAmount: 1200,
    expectedCurrency: 'GHS',
    pricingOption: 'GHS',
    paymentReference: 'DF-HISTORICAL-123',
    verifiedTransactionId: 'transaction-123',
    paymentVerificationTimestamp: '2026-10-21T12:30:00.000Z'
  });
  const lookupIds = [];
  const applicant = await getApplicantDashboardData(
    historical.id,
    'digital_forensics',
    {
      async findDigitalForensicsRegistration(registrationId) {
        lookupIds.push(registrationId);
        return historical;
      }
    }
  );

  assert.deepEqual(lookupIds, ['DF-historical']);
  assert.equal(applicant.amountDue, 1200);
  assert.equal(applicant.currency, 'GHS');
  assert.equal(applicant.paymentReference, 'DF-HISTORICAL-123');
  assert.equal(applicant.verifiedTransactionId, 'transaction-123');
  assert.equal(
    applicant.paymentVerificationTimestamp,
    '2026-10-21T12:30:00.000Z'
  );
  assert.equal(applicant.createdAt, historical.createdAt);
  assert.equal(applicant.canPay, false);
});

test('all persisted registration statuses map explicitly, with paid normalized as verified', async (t) => {
  const expected = [
    ['pending', 'pending', 'Not started', 'Received', true],
    ['payment_initiated', 'payment_initiated', 'Verification pending', 'Received', false],
    ['payment_verified', 'payment_verified', 'Verified', 'Confirmed', false],
    ['paid', 'payment_verified', 'Verified', 'Confirmed', false],
    ['payment_failed', 'payment_failed', 'Payment failed', 'Received', true]
  ];

  for (const [storedStatus, normalized, paymentLabel, applicationLabel, canPay] of expected) {
    await t.test(storedStatus, async () => {
      const applicant = await getApplicantDashboardData(
        'DF-registration',
        'digital_forensics',
        {
          async findDigitalForensicsRegistration() {
            return createApplicant({ status: storedStatus });
          },
          async getReceiptEligibility() {
            return { paymentVerified: false, receipt: null };
          }
        }
      );

      assert.equal(normalizeStatus(storedStatus), normalized);
      assert.equal(applicant.status, normalized);
      assert.equal(applicant.paymentStatus, paymentLabel);
      assert.equal(applicant.applicationStatus, applicationLabel);
      assert.equal(applicant.canPay, canPay);
      assert.equal(paymentStatusLabel(storedStatus), paymentLabel);
      assert.equal(applicationStatusLabel(storedStatus), applicationLabel);
    });
  }

  assert.equal(normalizeStatus('unexpected'), 'unknown');
  assert.equal(paymentStatusLabel('unexpected'), 'Status unavailable');
  assert.equal(applicationStatusLabel('unexpected'), 'Status unavailable');
});

test('regular-track dashboard uses persisted payment attempt details without exposing private fields', async () => {
  const applicant = await getApplicantDashboardData(
    'RT-own-registration',
    'regular_track',
    {
      async findRegularTrackApplicant(registrationId) {
        assert.equal(registrationId, 'RT-own-registration');
        return {
          id: registrationId,
          fullName: 'Regular Applicant',
          email: 'regular@example.test',
          phone: '+233201234567',
          track: 'soc_analyst',
          status: 'pending',
          createdAt: '2026-10-20T12:00:00.000Z'
        };
      },
      async findLatestRegularTrackPaymentAttempt(registrationId) {
        assert.equal(registrationId, 'RT-own-registration');
        return {
          reference: 'CYB-regular-reference',
          expectedAmount: 34650,
          expectedCurrency: 'GHS',
          status: 'failed',
          verifiedTransactionId: null,
          paymentVerificationTimestamp: null
        };
      }
    }
  );

  assert.equal(applicant.track, 'SOC Analyst');
  assert.equal(applicant.registrationId, 'RT-own-registration');
  assert.equal(applicant.status, 'payment_failed');
  assert.equal(applicant.paymentStatus, 'Payment failed');
  assert.equal(applicant.amountDue, null);
  assert.equal(applicant.currency, null);
  assert.equal(applicant.paymentReference, 'CYB-regular-reference');
  assert.equal(applicant.canPay, false);
  assert.equal(applicant.canDownloadReceipt, false);
  assert.equal(applicant.canResendReceipt, false);
  assert.equal(Object.hasOwn(applicant, 'phone'), false);
});

test('regular-track dashboard reflects the latest attempt when registration status lags', async () => {
  for (const [attemptStatus, expectedStatus] of [
    ['initializing', 'payment_initiated'],
    ['payment_initiated', 'payment_initiated'],
    ['failed', 'payment_failed'],
    ['initialization_failed', 'payment_failed'],
    ['payment_verified', 'payment_verified']
  ]) {
    const applicant = await getApplicantDashboardData(
      'RT-lagging-registration',
      'regular_track',
      {
        async findRegularTrackApplicant() {
          return {
            id: 'RT-lagging-registration',
            fullName: 'Regular Applicant',
            email: 'regular@example.test',
            track: 'soc_analyst',
            status: 'pending'
          };
        },
        async findLatestRegularTrackPaymentAttempt() {
          return { status: attemptStatus };
        }
      }
    );

    assert.equal(applicant.status, expectedStatus, attemptStatus);
  }

  const verifiedApplicant = await getApplicantDashboardData(
    'RT-verified-registration',
    'regular_track',
    {
      async findRegularTrackApplicant() {
        return {
          id: 'RT-verified-registration',
          fullName: 'Regular Applicant',
          email: 'regular@example.test',
          track: 'soc_analyst',
          status: 'payment_verified'
        };
      },
      async findLatestRegularTrackPaymentAttempt() {
        return { status: 'failed' };
      }
    }
  );
  assert.equal(verifiedApplicant.status, 'payment_verified');
});
