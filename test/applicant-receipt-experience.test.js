const assert = require('node:assert/strict');
const test = require('node:test');
const applicantSessionEndpoint = require('../api/applicant-session');
const {
  CONFIRMATION_MESSAGE,
  createApplicantReceiptResendService
} = require('../lib/applicant-receipt-resend-service');

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
    },
    send(body) {
      this.body = body;
      return this;
    }
  };
}

function createResendService({
  receipt,
  paymentVerified = true,
  allowed = true,
  now = 1_800_000_000_000,
  enqueue = async () => true
} = {}) {
  const rateLimits = [];
  const lookups = [];
  const service = createApplicantReceiptResendService({
    rateLimitSecret: 'r'.repeat(40),
    now: () => now,
    minimumResponseTimeMs: 0,
    store: {
      async incrementRateLimit(scope, keyHash, limit) {
        rateLimits.push({ scope, keyHash, limit });
        return { allowed };
      }
    },
    receiptService: {
      async findReadyReceiptForEmail(email) {
        lookups.push(email);
        return receipt || null;
      },
      async getReceiptEligibilityForRegistration(registrationId) {
        lookups.push(registrationId);
        return {
          paymentVerified,
          receipt: receipt || null
        };
      }
    },
    enqueue
  });
  return { service, rateLimits, lookups };
}

test('download uses only the authenticated session registration and verifies private receipt bytes', async () => {
  const pdf = Buffer.from('%PDF-1.4\nreceipt');
  const lookupIds = [];
  const storageReceipts = [];
  const handler = applicantSessionEndpoint.createHandler(
    {
      async getSession(cookie) {
        assert.equal(cookie, 'session-cookie');
        return {
          registrationId: 'DF-session-owner',
          applicantType: 'digital_forensics'
        };
      }
    },
    async () => null,
    {
      async getReceiptEligibilityForRegistration(registrationId) {
        lookupIds.push(registrationId);
        return {
          paymentVerified: true,
          receipt: {
            registrationId,
            generationStatus: 'ready',
            receiptNumber: 'CN-DF-2026-ABC123',
            blobPathname: 'private-path-not-for-response',
            pdfSha256: 'a'.repeat(64)
          }
        };
      }
    },
    {
      async getVerifiedReceiptPdf(receipt) {
        storageReceipts.push(receipt);
        return pdf;
      }
    }
  );
  const response = createResponse();

  await handler({
    method: 'POST',
    headers: { cookie: 'session-cookie' },
    body: {
      action: 'download-receipt',
      registrationId: 'DF-attacker',
      paymentReference: 'ATTACKER-REFERENCE'
    }
  }, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(lookupIds, ['DF-session-owner']);
  assert.equal(storageReceipts.length, 1);
  assert.equal(storageReceipts[0].registrationId, 'DF-session-owner');
  assert.equal(response.body, pdf);
  assert.equal(response.headers['Content-Type'], 'application/pdf');
  assert.equal(
    response.headers['Content-Disposition'],
    'attachment; filename="Cybanext-Payment-Receipt-CN-DF-2026-ABC123.pdf"'
  );
  assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(JSON.stringify(response.body).includes('private-path'), false);
});

test('unauthenticated, unpaid, and missing receipt downloads are rejected before Blob retrieval', async () => {
  let storageCalls = 0;
  const receiptService = {
    async getReceiptEligibilityForRegistration(registrationId) {
      if (registrationId === 'DF-unpaid') {
        return { paymentVerified: false, receipt: null };
      }
      return { paymentVerified: true, receipt: null };
    }
  };
  const storage = {
    async getVerifiedReceiptPdf() {
      storageCalls += 1;
      return Buffer.from('%PDF');
    }
  };

  for (const item of [
    { session: null, status: 401, action: 'download-receipt' },
    {
      session: {
        registrationId: 'DF-unpaid',
        applicantType: 'digital_forensics'
      },
      status: 409,
      action: 'download-receipt'
    },
    {
      session: {
        registrationId: 'DF-missing',
        applicantType: 'digital_forensics'
      },
      status: 404,
      action: 'download-receipt'
    }
  ]) {
    const handler = applicantSessionEndpoint.createHandler(
      { async getSession() { return item.session; } },
      async () => null,
      receiptService,
      storage
    );
    const response = createResponse();
    await handler({ method: 'POST', headers: {}, body: { action: item.action } }, response);
    assert.equal(response.statusCode, item.status);
  }
  assert.equal(storageCalls, 0);
});

test('private storage or checksum errors become a generic unavailable response', async () => {
  const handler = applicantSessionEndpoint.createHandler(
    {
      async getSession() {
        return {
          registrationId: 'DF-owner',
          applicantType: 'digital_forensics'
        };
      }
    },
    async () => null,
    {
      async getReceiptEligibilityForRegistration(registrationId) {
        return {
          paymentVerified: true,
          receipt: {
            registrationId,
            generationStatus: 'ready',
            receiptNumber: 'CN-DF-2026-ABC123'
          }
        };
      }
    },
    {
      async getVerifiedReceiptPdf() {
        throw new Error('private storage path and provider detail');
      }
    }
  );
  const response = createResponse();
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    await handler({
      method: 'POST',
      headers: {},
      body: { action: 'download-receipt' }
    }, response);
  } finally {
    console.error = originalError;
  }
  assert.equal(response.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(response.body), /private storage|provider detail/);
});

test('authenticated resend derives registration ownership only from the session', async () => {
  let requestedRegistrationId;
  const handler = applicantSessionEndpoint.createHandler(
    {
      async getSession() {
        return {
          registrationId: 'DF-session-owner',
          applicantType: 'digital_forensics'
        };
      }
    },
    async () => null,
    undefined,
    undefined,
    {
      async requestAuthenticatedResend(request) {
        requestedRegistrationId = request.registrationId;
        return { statusCode: 202, body: { message: 'accepted' } };
      },
      getClientIp() {
        return '192.0.2.10';
      }
    }
  );
  const response = createResponse();
  await handler({
    method: 'POST',
    headers: {},
    body: { action: 'resend-receipt', registrationId: 'DF-attacker' }
  }, response);

  assert.equal(response.statusCode, 202);
  assert.equal(requestedRegistrationId, 'DF-session-owner');
});

test('public endpoint returns a generic response and ignores client-supplied ownership fields', async () => {
  let request;
  const handler = applicantSessionEndpoint.createHandler(
    {
      async getSession() {
        assert.fail('public receipt requests do not require or inspect a session');
      }
    },
    async () => null,
    undefined,
    undefined,
    {
      async requestPublicResend(value) {
        request = value;
        return {
          statusCode: 200,
          body: { message: CONFIRMATION_MESSAGE }
        };
      }
    }
  );
  const response = createResponse();
  await handler({
    method: 'POST',
    headers: { 'x-forwarded-for': '198.51.100.10, 198.51.100.11' },
    body: {
      action: 'request-receipt-resend',
      email: 'applicant@example.test',
      registrationId: 'DF-attacker',
      paymentReference: 'ATTACKER-REFERENCE'
    }
  }, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(request, {
    email: 'applicant@example.test',
    ipAddress: '198.51.100.11'
  });
  assert.deepEqual(response.body, { message: CONFIRMATION_MESSAGE });
  assert.doesNotMatch(JSON.stringify(response.body), /registration|paymentReference|DF-/i);
});

test('public endpoint returns the same generic response when rate limiting or enqueueing fails', async () => {
  const handler = applicantSessionEndpoint.createHandler(
    { async getSession() { return null; } },
    async () => null,
    undefined,
    undefined,
    {
      async requestPublicResend() {
        throw Object.assign(
          new Error('private database or provider details'),
          { code: 'known@example.test' }
        );
      }
    }
  );
  const response = createResponse();
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    await handler({
      method: 'POST',
      headers: { 'x-forwarded-for': '192.0.2.50' },
      body: {
        action: 'request-receipt-resend',
        email: 'known@example.test',
        registrationId: 'DF-private'
      }
    }, response);
  } finally {
    console.error = originalError;
  }

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { message: CONFIRMATION_MESSAGE });
  assert.doesNotMatch(JSON.stringify(response.body), /private database|DF-private/);
  assert.doesNotMatch(JSON.stringify(logged), /known@example\.test|DF-private|private database/);
});

test('public resend gives identical generic responses for unknown and eligible emails', async () => {
  const queued = [];
  const receipt = { registrationId: 'DF-private-registration' };
  const known = createResendService({
    receipt,
    enqueue: async (request) => {
      queued.push(request);
      return true;
    }
  });
  const unknown = createResendService();
  const ineligible = createResendService({ receipt: null });

  const [knownResult, unknownResult, ineligibleResult] = await Promise.all([
    known.service.requestPublicResend({
      email: '  APPLICANT@example.test ',
      ipAddress: '192.0.2.20'
    }),
    unknown.service.requestPublicResend({
      email: 'unknown@example.test',
      ipAddress: '192.0.2.21'
    }),
    ineligible.service.requestPublicResend({
      email: 'unpaid@example.test',
      ipAddress: '192.0.2.22'
    })
  ]);

  assert.deepEqual(knownResult, unknownResult);
  assert.deepEqual(knownResult, ineligibleResult);
  assert.deepEqual(knownResult, {
    statusCode: 200,
    body: { message: CONFIRMATION_MESSAGE }
  });
  assert.deepEqual(known.lookups, ['applicant@example.test']);
  assert.deepEqual(unknown.lookups, ['unknown@example.test']);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].registrationId, receipt.registrationId);
  assert.equal(knownResult.body.message.includes(receipt.registrationId), false);
  assert.deepEqual(
    known.rateLimits.map(({ scope, limit }) => [scope, limit]).sort(),
    [['receipt_resend_email', 3], ['receipt_resend_ip', 10]]
  );
  assert.ok(known.rateLimits.every(({ keyHash }) => /^[a-f0-9]{64}$/.test(keyHash)));
});

test('public resend rate limits independently, validates email, and never queues repeated requests twice per window', async () => {
  const receipt = { registrationId: 'DF-owner' };
  const inserted = new Set();
  const queued = [];
  const setup = createResendService({
    receipt,
    now: 1_800_000_000_000,
    enqueue: async (request) => {
      if (inserted.has(request.eventKey)) return false;
      inserted.add(request.eventKey);
      queued.push(request);
      return true;
    }
  });
  const request = {
    email: 'applicant@example.test',
    ipAddress: '192.0.2.30'
  };
  const results = await Promise.all([
    setup.service.requestPublicResend(request),
    setup.service.requestPublicResend(request)
  ]);

  assert.deepEqual(results[0], results[1]);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].eventKey, [...inserted][0]);
  assert.doesNotMatch(queued[0].eventKey, /DF-owner/);
  assert.ok(setup.rateLimits.every(({ scope }) =>
    scope.startsWith('receipt_resend_')));

  const denied = createResendService({ receipt, allowed: false });
  const deniedResult = await denied.service.requestPublicResend(request);
  assert.deepEqual(deniedResult, {
    statusCode: 200,
    body: { message: CONFIRMATION_MESSAGE }
  });
  assert.deepEqual(denied.lookups, []);

  const invalid = await setup.service.requestPublicResend({
    email: 'not-an-email',
    ipAddress: '192.0.2.30'
  });
  assert.equal(invalid.statusCode, 400);
});

test('authenticated resend rechecks payment and ready receipt eligibility', async () => {
  const eligible = createResendService({
    receipt: { registrationId: 'DF-owner' }
  });
  const result = await eligible.service.requestAuthenticatedResend({
    registrationId: 'DF-owner',
    ipAddress: '192.0.2.40'
  });
  assert.equal(result.statusCode, 202);
  assert.deepEqual(eligible.lookups, ['DF-owner']);

  const unpaid = createResendService({
    receipt: null,
    paymentVerified: false
  });
  const rejected = await unpaid.service.requestAuthenticatedResend({
    registrationId: 'DF-unpaid',
    ipAddress: '192.0.2.41'
  });
  assert.equal(rejected.statusCode, 409);
  assert.equal(unpaid.lookups.includes('DF-unpaid'), true);
});
