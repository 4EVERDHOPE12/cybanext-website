const assert = require('node:assert/strict');
const test = require('node:test');
const applicantSessionEndpoint = require('../api/applicant-session');
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
      return { registrationId: 'DF-own-registration' };
    }
  };
  const handler = applicantSessionEndpoint.createHandler(
    sessionService,
    async (registrationId) => {
      lookupIds.push(registrationId);
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

test('URL and request-body registration IDs cannot override session ownership', async () => {
  const lookupIds = [];
  const handler = applicantSessionEndpoint.createHandler(
    {
      async getSession() {
        return { registrationId: 'DF-session-registration' };
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
      { async getSession() { return { registrationId: 'DF-missing' }; } },
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

test('dashboard data lookup errors return a generic response without database details', async () => {
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    const handler = applicantSessionEndpoint.createHandler(
      { async getSession() { return { registrationId: 'DF-own-registration' }; } },
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
    paymentReference: 'DF-HISTORICAL-123'
  });
  const lookupIds = [];
  const applicant = await getApplicantDashboardData(
    historical.id,
    async (registrationId) => {
      lookupIds.push(registrationId);
      return historical;
    }
  );

  assert.deepEqual(lookupIds, ['DF-historical']);
  assert.equal(applicant.amountDue, 1200);
  assert.equal(applicant.currency, 'GHS');
  assert.equal(applicant.paymentReference, 'DF-HISTORICAL-123');
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
        async () => createApplicant({ status: storedStatus })
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
