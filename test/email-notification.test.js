const assert = require('node:assert/strict');
const test = require('node:test');
const database = require('../lib/digital-forensics-database');
const {
  createMessage,
  createNotificationDelivery
} = require('../lib/email-notification');
const {
  attemptImmediateDelivery,
  claimDueEvents,
  enqueueReceiptResend,
  deliverEventByKey,
  deliverClaimedEvent,
  processDueEvents,
  requeuePermanentFailure
} = require('../lib/email-notification-outbox');
const { sendMagicLink, sendNotificationEmail } = require('../lib/applicant-email');
const cronHandler = require('../api/process-email-notifications');

function notificationEvent(eventKey = 'registration:unit-test') {
  return {
    eventId: '00000000-0000-4000-8000-000000000001',
    eventKey,
    eventType: 'regular_track_registration_confirmation',
    recipientEmail: 'applicant@example.com',
    templateData: { fullName: '<Applicant>', track: 'Incident Response' },
    attemptCount: 1,
    claimToken: '00000000-0000-4000-8000-000000000002',
    digitalForensicsRegistrationId: null
  };
}

function digitalForensicsPaymentEvent() {
  return {
    ...notificationEvent('digital-forensics-payment-success:DF-123456-ABCDEF:DF-PAY-123456'),
    eventType: 'digital_forensics_payment_success',
    digitalForensicsRegistrationId: 'DF-123456-ABCDEF'
  };
}

function withEnvironment(t, values) {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function withDatabase(t, query) {
  const original = database.query;
  database.query = query;
  t.after(() => { database.query = original; });
}

function stateUpdateRows(statement, values) {
  if (statement.includes("SET status = 'sent'")) {
    return [{ eventId: '00000000-0000-4000-8000-000000000001' }];
  }
  return [{
    status: values.includes('permanent_failed') ? 'permanent_failed' : 'pending'
  }];
}

function response() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('notification templates cover registration, verified payment, and definitive failure', () => {
  const types = [
    'regular_track_registration_confirmation',
    'digital_forensics_registration_confirmation',
    'regular_track_payment_success',
    'digital_forensics_payment_success',
    'digital_forensics_receipt_resend',
    'regular_track_payment_failure',
    'digital_forensics_payment_failure'
  ];

  for (const eventType of types) {
    const message = createMessage({
      eventType,
      templateData: { fullName: '<Applicant>', track: 'Digital Forensics' }
    });
    assert.ok(message.subject);
    assert.match(message.text, /Applicant/);
    assert.match(message.html, /&lt;Applicant&gt;/);
    assert.doesNotMatch(message.html, /<Applicant>/);
  }
});

test('Digital Forensics payment-success CTA links to the applicant login page', (t) => {
  withEnvironment(t, { SITE_URL: 'https://example.test/' });
  const message = createMessage({
    eventType: 'digital_forensics_payment_success',
    templateData: { fullName: 'Ada Applicant', track: 'Digital Forensics' }
  });
  const applicantLoginUrl = 'https://example.test/applicant-login.html';

  assert.ok(message.html.includes(
    `<a href="${applicantLoginUrl}">Visit Applicant Dashboard</a>`
  ));
  assert.ok(message.text.includes(
    `Visit Applicant Dashboard: ${applicantLoginUrl}`
  ));
  assert.doesNotMatch(message.html, /applicant-dashboard\\.html/);

  const regularMessage = createMessage({
    eventType: 'regular_track_payment_success',
    templateData: { fullName: 'Ada Applicant', track: 'Incident Response' }
  });
  assert.match(regularMessage.html, /href="https:\/\/example\.test">Visit Cybanext<\/a>/);
  assert.match(regularMessage.text, /https:\/\/example\.test$/);
});

test('Resend notification transport reports configuration and provider failures without raw details', async (t) => {
  withEnvironment(t, { RESEND_API_KEY: '', AUTH_EMAIL_FROM: 'verified@example.com' });
  await assert.rejects(
    sendNotificationEmail({ to: 'applicant@example.com', subject: 'Test', text: 'Test', html: '<p>Test</p>' }),
    (error) => error.notificationErrorCode === 'configuration_missing'
  );

  process.env.RESEND_API_KEY = 'test_resend_key';
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => ({ ok: false, status: 429 });
  await assert.rejects(
    sendNotificationEmail({ to: 'applicant@example.com', subject: 'Test', text: 'Test', html: '<p>Test</p>' }),
    (error) => error.notificationErrorCode === 'resend_rate_limited' &&
      !error.message.includes('test_resend_key')
  );
});

test('Resend transport sends PDF attachments as base64 with the PDF MIME type', async (t) => {
  withEnvironment(t, { RESEND_API_KEY: 'test_resend_key', AUTH_EMAIL_FROM: 'verified@example.com' });
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let requestBody;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return { ok: true, status: 200 };
  };

  await sendNotificationEmail({
    to: 'applicant@example.com',
    subject: 'Cybanext payment confirmed',
    text: 'Payment verified',
    html: '<p>Payment verified</p>',
    attachments: [{
      filename: 'Cybanext-Payment-Receipt-CN-DF-2025-ABC123.pdf',
      content: Buffer.from('%PDF-1.4\nreceipt').toString('base64'),
      content_type: 'application/pdf'
    }]
  });

  assert.equal(requestBody.attachments.length, 1);
  assert.equal(
    Buffer.from(requestBody.attachments[0].content, 'base64').toString(),
    '%PDF-1.4\nreceipt'
  );
  assert.equal(requestBody.attachments[0].content_type, 'application/pdf');
  assert.equal(
    requestBody.attachments[0].filename,
    'Cybanext-Payment-Receipt-CN-DF-2025-ABC123.pdf'
  );
});

test('Digital Forensics payment-success delivery attaches the verified private receipt', async () => {
  const pdf = Buffer.from('%PDF-1.4\nverified receipt');
  const receipt = {
    generationStatus: 'ready',
    receiptNumber: 'CN-DF-2025-ABC123',
    blobPathname: 'applicant-payment-receipts/CN-DF-2025-ABC123/claim.pdf',
    pdfSha256: 'a'.repeat(64)
  };
  const ensuredRegistrations = [];
  const readReceipts = [];
  let sentMessage;
  const deliverNotification = createNotificationDelivery({
    receiptService: {
      async ensureReceiptForRegistration(registrationId) {
        ensuredRegistrations.push(registrationId);
        return receipt;
      }
    },
    receiptStorage: {
      async getVerifiedReceiptPdf(value) {
        readReceipts.push(value);
        return pdf;
      }
    },
    async emailSender(message) {
      sentMessage = message;
    }
  });

  await deliverNotification(digitalForensicsPaymentEvent());

  assert.deepEqual(ensuredRegistrations, ['DF-123456-ABCDEF']);
  assert.deepEqual(readReceipts, [receipt]);
  assert.equal(sentMessage.subject, 'Cybanext payment confirmed');
  assert.match(sentMessage.text, /payment for Incident Response has been verified/);
  assert.deepEqual(sentMessage.attachments, [{
    filename: 'Cybanext-Payment-Receipt-CN-DF-2025-ABC123.pdf',
    content: pdf.toString('base64'),
    content_type: 'application/pdf'
  }]);
});

test('receipt resend delivery reuses only the existing ready receipt', async () => {
  const pdf = Buffer.from('%PDF-1.4\nexisting receipt');
  const receipt = {
    generationStatus: 'ready',
    receiptNumber: 'CN-DF-2025-ABC123',
    blobPathname: 'applicant-payment-receipts/CN-DF-2025-ABC123/claim.pdf',
    pdfSha256: 'a'.repeat(64)
  };
  let lookupId;
  let sentMessage;
  const delivery = createNotificationDelivery({
    receiptService: {
      async ensureReceiptForRegistration() {
        assert.fail('receipt resend must not create or generate a receipt');
      },
      async getReadyReceiptForRegistration(registrationId) {
        lookupId = registrationId;
        return receipt;
      }
    },
    receiptStorage: {
      async getVerifiedReceiptPdf(value) {
        assert.equal(value, receipt);
        return pdf;
      }
    },
    async emailSender(message) {
      sentMessage = message;
    }
  });

  await delivery({
    ...notificationEvent('digital-forensics-receipt-resend:opaque-key'),
    eventType: 'digital_forensics_receipt_resend',
    digitalForensicsRegistrationId: 'DF-resend-owner'
  });

  assert.equal(lookupId, 'DF-resend-owner');
  assert.equal(sentMessage.subject, 'Your Cybanext payment receipt');
  assert.match(sentMessage.text, /As requested/);
  assert.equal(sentMessage.attachments[0].filename,
    'Cybanext-Payment-Receipt-CN-DF-2025-ABC123.pdf');
  assert.equal(
    Buffer.from(sentMessage.attachments[0].content, 'base64').toString(),
    pdf.toString()
  );
});

test('receipt resend outbox insertion is Digital Forensics-only and idempotent by event key', async (t) => {
  const originalQuery = database.query;
  const calls = [];
  database.query = async (strings, ...values) => {
    calls.push({ statement: strings.join(' '), values });
    return calls.length === 1 ? [{ eventId: 'resend-event' }] : [];
  };
  t.after(() => { database.query = originalQuery; });

  const request = {
    registrationId: 'DF-resend-owner',
    eventKey: 'digital-forensics-receipt-resend:opaque-key'
  };
  assert.equal(await enqueueReceiptResend(request), true);
  assert.equal(await enqueueReceiptResend(request), false);
  assert.equal(calls.length, 2);
  for (const { statement, values } of calls) {
    assert.match(statement, /digital_forensics_receipt_resend/);
    assert.match(statement, /ON CONFLICT \(event_key\) DO NOTHING/);
    assert.match(statement, /generation_status = 'ready'/);
    assert.match(statement, /status IN \('payment_verified', 'paid'\)/);
    assert.ok(values.includes(request.registrationId));
    assert.ok(values.includes(request.eventKey));
  }
});

test('receipt resend outbox delivery does not alter payment notification status', async (t) => {
  const statements = [];
  withDatabase(t, async (strings, ...values) => {
    const statement = strings.join(' ');
    statements.push(statement);
    return stateUpdateRows(statement, values);
  });
  const event = {
    ...notificationEvent('digital-forensics-receipt-resend:opaque-key'),
    eventType: 'digital_forensics_receipt_resend',
    digitalForensicsRegistrationId: 'DF-resend-owner'
  };

  assert.deepEqual(
    await deliverClaimedEvent(event, async () => {}),
    { eventKey: event.eventKey, status: 'sent' }
  );
  assert.match(statements[0], /updated\.event_type <> 'digital_forensics_receipt_resend'/);

  statements.length = 0;
  assert.deepEqual(
    await deliverClaimedEvent(event, async () => {
      throw Object.assign(new Error('temporary delivery failure'), {
        notificationErrorCode: 'network_error'
      });
    }),
    { eventKey: event.eventKey, status: 'retry_scheduled' }
  );
  assert.match(statements[0], /updated\.event_type <> 'digital_forensics_receipt_resend'/);
});

test('receipt-generation contention is retryable and does not send an unattached payment email', async () => {
  let storageCalls = 0;
  let emailCalls = 0;
  const deliverNotification = createNotificationDelivery({
    receiptService: {
      async ensureReceiptForRegistration() {
        return { generationStatus: 'generating' };
      }
    },
    receiptStorage: {
      async getVerifiedReceiptPdf() { storageCalls += 1; }
    },
    async emailSender() { emailCalls += 1; }
  });

  await assert.rejects(
    deliverNotification(digitalForensicsPaymentEvent()),
    (error) => error.notificationErrorCode === 'delivery_error'
  );
  assert.equal(storageCalls, 0);
  assert.equal(emailCalls, 0);
});

test('regular-track and other notification events are sent without receipt lookup or attachments', async () => {
  let receiptLookups = 0;
  const sentMessages = [];
  const deliverNotification = createNotificationDelivery({
    receiptService: {
      async ensureReceiptForRegistration() {
        receiptLookups += 1;
        throw new Error('receipt lookup must not run');
      }
    },
    receiptStorage: {
      async getVerifiedReceiptPdf() {
        receiptLookups += 1;
        throw new Error('receipt retrieval must not run');
      }
    },
    async emailSender(message) { sentMessages.push(message); }
  });
  const unrelatedEvents = [
    notificationEvent(),
    { ...notificationEvent(), eventType: 'digital_forensics_registration_confirmation' },
    { ...notificationEvent(), eventType: 'regular_track_payment_success' },
    { ...notificationEvent(), eventType: 'digital_forensics_payment_failure' }
  ];

  for (const event of unrelatedEvents) await deliverNotification(event);

  assert.equal(receiptLookups, 0);
  assert.equal(sentMessages.length, unrelatedEvents.length);
  assert.ok(sentMessages.every((message) => !Object.hasOwn(message, 'attachments')));
});

test('receipt retrieval failure schedules the existing outbox retry without changing payment state', async (t) => {
  const statements = [];
  withDatabase(t, async (strings, ...values) => {
    statements.push({ statement: strings.join(' '), values });
    return stateUpdateRows(strings.join(' '), values);
  });
  const deliverNotification = createNotificationDelivery({
    receiptService: {
      async ensureReceiptForRegistration() {
        return {
          generationStatus: 'ready',
          receiptNumber: 'CN-DF-2025-ABC123'
        };
      }
    },
    receiptStorage: {
      async getVerifiedReceiptPdf() {
        throw new Error('private receipt retrieval failed');
      }
    },
    async emailSender() {
      throw new Error('email must not be sent');
    }
  });

  const result = await deliverClaimedEvent(digitalForensicsPaymentEvent(), deliverNotification);

  assert.equal(result.status, 'retry_scheduled');
  assert.equal(statements.length, 1);
  assert.match(statements[0].statement, /SET status =/);
  assert.ok(statements[0].values.includes('delivery_error'));
  assert.doesNotMatch(statements[0].statement, /SET payment_status|status = 'payment_failed'/i);
});

test('Resend failure after receipt retrieval leaves the payment verified and event retryable', async (t) => {
  const statements = [];
  const pdf = Buffer.from('%PDF-1.4\nverified receipt');
  withDatabase(t, async (strings, ...values) => {
    statements.push({ statement: strings.join(' '), values });
    return stateUpdateRows(strings.join(' '), values);
  });
  const deliverNotification = createNotificationDelivery({
    receiptService: {
      async ensureReceiptForRegistration() {
        return {
          generationStatus: 'ready',
          receiptNumber: 'CN-DF-2025-ABC123'
        };
      }
    },
    receiptStorage: {
      async getVerifiedReceiptPdf() { return pdf; }
    },
    async emailSender() {
      throw Object.assign(new Error('provider rejected'), {
        notificationErrorCode: 'resend_server_error'
      });
    }
  });

  const result = await deliverClaimedEvent(digitalForensicsPaymentEvent(), deliverNotification);

  assert.equal(result.status, 'retry_scheduled');
  assert.ok(statements[0].values.includes('resend_server_error'));
  assert.doesNotMatch(statements[0].statement, /SET payment_status|status = 'payment_failed'/i);
});

test('Resend HTTP errors distinguish permanent requests, credentials, and transient responses', async (t) => {
  withEnvironment(t, { RESEND_API_KEY: 'test_resend_key', AUTH_EMAIL_FROM: 'verified@example.com' });
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const cases = [
    { status: 400, code: 'resend_rejected', permanentFailure: true },
    { status: 422, code: 'resend_rejected', permanentFailure: true },
    { status: 401, code: 'configuration_missing' },
    { status: 403, code: 'configuration_missing' },
    { status: 408, code: 'timeout' },
    { status: 425, code: 'timeout' },
    { status: 429, code: 'resend_rate_limited' },
    { status: 503, code: 'resend_server_error' },
    { status: 404, code: 'resend_rejected' }
  ];

  for (const expected of cases) {
    global.fetch = async () => ({ ok: false, status: expected.status });
    await assert.rejects(
      sendNotificationEmail({
        to: 'applicant@example.com',
        subject: 'Test',
        text: 'Test',
        html: '<p>Test</p>'
      }),
      (error) => error.notificationErrorCode === expected.code &&
        error.permanentFailure === (expected.permanentFailure === true) &&
        !Object.hasOwn(error, 'retryWithoutAttempt')
    );
  }

  global.fetch = async () => {
    const error = new Error('timeout details are not persisted');
    error.name = 'TimeoutError';
    throw error;
  };
  await assert.rejects(
    sendNotificationEmail({
      to: 'applicant@example.com',
      subject: 'Test',
      text: 'Test',
      html: '<p>Test</p>'
    }),
    (error) => error.notificationErrorCode === 'timeout' &&
      !error.message.includes('timeout details')
  );
  global.fetch = async () => { throw new TypeError('network details are not persisted'); };
  await assert.rejects(
    sendNotificationEmail({
      to: 'applicant@example.com',
      subject: 'Test',
      text: 'Test',
      html: '<p>Test</p>'
    }),
    (error) => error.notificationErrorCode === 'network_error' &&
      !error.message.includes('network details')
  );
});

test('outbox delivery claims once and records a sent event', async (t) => {
  withEnvironment(t, {
    RESEND_API_KEY: 'test_resend_key',
    AUTH_EMAIL_FROM: 'verified@example.com',
    SITE_URL: 'https://example.test/'
  });
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let fetchCount = 0;
  global.fetch = async (url, options) => {
    fetchCount += 1;
    assert.equal(url, 'https://api.resend.com/emails');
    const body = JSON.parse(options.body);
    assert.equal(body.to[0], 'applicant@example.com');
    assert.equal(body.from, 'verified@example.com');
    return { ok: true, status: 200 };
  };

  let claimed = false;
  const statements = [];
  withDatabase(t, async (strings, ...values) => {
    const statement = strings.join(' ');
    statements.push(statement);
    if (statement.includes('WHERE event_key =')) {
      if (claimed) return [];
      claimed = true;
      return [notificationEvent(values[0])];
    }
    return stateUpdateRows(statement, values);
  });

  const result = await deliverEventByKey('registration:unit-test');
  assert.equal(result.status, 'sent');
  assert.equal(fetchCount, 1);
  assert.equal(statements.length, 2);
  assert.match(statements[0], /FOR UPDATE SKIP LOCKED/);
  assert.match(statements[0], /claim_token = gen_random_uuid\(\)/);
  assert.match(statements[0], /digital_forensics_registration_id AS "digitalForensicsRegistrationId"/);
  assert.match(statements[1], /SET status = 'sent'/);
});

test('concurrent duplicate event processing sends no more than one email', async (t) => {
  withEnvironment(t, { RESEND_API_KEY: 'test_key', AUTH_EMAIL_FROM: 'verified@example.com' });
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let fetchCount = 0;
  global.fetch = async () => {
    fetchCount += 1;
    return { ok: true, status: 200 };
  };
  let claimCount = 0;
  withDatabase(t, async (strings, ...values) => {
    const statement = strings.join(' ');
    if (statement.includes('WHERE event_key =')) {
      claimCount += 1;
      return claimCount === 1 ? [notificationEvent(values[0])] : [];
    }
    return stateUpdateRows(statement, values);
  });

  const results = await Promise.all([
    deliverEventByKey('registration:unit-test'),
    deliverEventByKey('registration:unit-test')
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['not_claimed', 'sent']);
  assert.equal(fetchCount, 1);
});

test('long-running delivery renews its active claim before the lease expires', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const event = notificationEvent();
  let markDeliveryStarted;
  const deliveryStarted = new Promise((resolve) => { markDeliveryStarted = resolve; });
  let finishDelivery;
  const deliveryGate = new Promise((resolve) => { finishDelivery = resolve; });
  let renewalQuery;
  withDatabase(t, async (strings, ...values) => {
    const statement = strings.join(' ');
    if (statement.includes('SET lease_expires_at =')) {
      renewalQuery = { statement, values };
    }
    return [{ eventId: event.eventId }];
  });

  const delivery = deliverClaimedEvent(event, async () => {
    markDeliveryStarted();
    await deliveryGate;
  });
  await deliveryStarted;
  t.mock.timers.tick(20_000);
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(renewalQuery);
  assert.match(renewalQuery.statement, /status = 'sending'/);
  assert.match(renewalQuery.statement, /claim_token =/);
  assert.match(renewalQuery.statement, /lease_expires_at > clock_timestamp\(\)/);
  assert.ok(renewalQuery.values.includes(event.claimToken));

  finishDelivery();
  assert.deepEqual(await delivery, { eventKey: event.eventKey, status: 'sent' });
});

test('renewal query failures are logged and retried while the active claim remains valid', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const event = notificationEvent();
  let markDeliveryStarted;
  const deliveryStarted = new Promise((resolve) => { markDeliveryStarted = resolve; });
  let finishDelivery;
  const deliveryGate = new Promise((resolve) => { finishDelivery = resolve; });
  const renewalErrors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => renewalErrors.push(args);
  t.after(() => { console.error = originalConsoleError; });
  let renewalCount = 0;
  withDatabase(t, async (strings) => {
    const statement = strings.join(' ');
    if (statement.includes('SET lease_expires_at =')) {
      renewalCount += 1;
      if (renewalCount === 1) {
        throw Object.assign(new Error('database details are private'), { code: '08006' });
      }
    }
    return [{ eventId: event.eventId }];
  });

  const delivery = deliverClaimedEvent(event, async () => {
    markDeliveryStarted();
    await deliveryGate;
  });
  await deliveryStarted;

  t.mock.timers.tick(20_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(renewalCount, 1);
  assert.deepEqual(renewalErrors, [[
    'Email notification claim renewal failed.',
    { code: '08006' }
  ]]);

  t.mock.timers.tick(20_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(renewalCount, 2);

  finishDelivery();
  assert.deepEqual(await delivery, { eventKey: event.eventKey, status: 'sent' });
  t.mock.timers.tick(60_000);
  assert.equal(renewalCount, 2);
});

test('an in-flight renewal cannot report sent or failed after another worker takes ownership', async (t) => {
  await t.test('provider acceptance after claim loss', async (st) => {
    await verifyInFlightRenewalLosesOwnership(st, 'success');
  });
  await t.test('delivery failure after claim loss', async (st) => {
    await verifyInFlightRenewalLosesOwnership(st, 'failure');
  });
});

async function verifyInFlightRenewalLosesOwnership(t, outcome) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const event = notificationEvent();
  const newerClaimToken = '00000000-0000-4000-8000-000000000003';
  let ownerToken = event.claimToken;
  let eventStatus = 'sending';
  let markRenewalStarted;
  const renewalStarted = new Promise((resolve) => { markRenewalStarted = resolve; });
  let finishRenewal;
  const renewalGate = new Promise((resolve) => { finishRenewal = resolve; });
  let markDeliveryStarted;
  const deliveryStarted = new Promise((resolve) => { markDeliveryStarted = resolve; });
  let finishDelivery;
  const deliveryGate = new Promise((resolve) => { finishDelivery = resolve; });
  let renewalCount = 0;
  let stateUpdateQuery;

  withDatabase(t, async (strings, ...values) => {
    const statement = strings.join(' ');
    if (statement.includes('SET lease_expires_at =')) {
      renewalCount += 1;
      markRenewalStarted();
      return renewalGate;
    }
    stateUpdateQuery = { statement, values };
    if (values.includes(ownerToken)) {
      eventStatus = outcome === 'success' ? 'sent' : 'pending';
      return [{ eventId: event.eventId, status: eventStatus }];
    }
    return [];
  });

  const delivery = deliverClaimedEvent(event, async () => {
    markDeliveryStarted();
    await deliveryGate;
    if (outcome === 'failure') throw new Error('simulated provider failure');
  });
  await deliveryStarted;
  t.mock.timers.tick(20_000);
  await renewalStarted;

  ownerToken = newerClaimToken;
  finishDelivery();
  const result = await delivery;

  assert.deepEqual(result, { eventKey: event.eventKey, status: 'claim_lost' });
  assert.equal(eventStatus, 'sending');
  assert.ok(stateUpdateQuery);
  assert.match(stateUpdateQuery.statement, /claim_token =/);
  assert.match(stateUpdateQuery.statement, /lease_expires_at > clock_timestamp\(\)/);
  assert.ok(stateUpdateQuery.values.includes(event.claimToken));

  finishRenewal([]);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(60_000);
  assert.equal(renewalCount, 1);
  assert.equal(ownerToken, newerClaimToken);
  assert.equal(eventStatus, 'sending');
}

test('expired claim can be reclaimed and the prior provider-accepted worker cannot complete it', async (t) => {
  const staleEvent = notificationEvent();
  const newerEvent = {
    ...staleEvent,
    claimToken: '00000000-0000-4000-8000-000000000003'
  };
  let ownerToken = staleEvent.claimToken;
  let leaseActive = true;
  let eventStatus = 'sending';
  let markDeliveryStarted;
  const deliveryStarted = new Promise((resolve) => { markDeliveryStarted = resolve; });
  let providerAccepted;
  const providerGate = new Promise((resolve) => { providerAccepted = resolve; });
  let successQuery;
  let queryCount = 0;
  withDatabase(t, async (strings, ...values) => {
    const statement = strings.join(' ');
    queryCount += 1;
    if (statement.includes('WHERE event_key =')) return [staleEvent];
    if (statement.includes('WITH exhausted AS')) {
      assert.equal(leaseActive, false);
      assert.match(statement, /status = 'sending' AND lease_expires_at <= clock_timestamp\(\)/);
      assert.match(statement, /claim_token = gen_random_uuid\(\)/);
      ownerToken = newerEvent.claimToken;
      leaseActive = true;
      return [{ ...newerEvent, claimStatus: 'sending' }];
    }
    if (statement.includes("SET status = 'sent'")) {
      successQuery = { statement, values };
      if (leaseActive && values.includes(ownerToken)) {
        eventStatus = 'sent';
        return [{ eventId: staleEvent.eventId }];
      }
      return [];
    }
    return [];
  });

  const staleDelivery = deliverClaimedEvent(staleEvent, async () => {
    markDeliveryStarted();
    await providerGate;
  });
  await deliveryStarted;

  leaseActive = false;
  const [reclaimedEvent] = await claimDueEvents();
  assert.equal(reclaimedEvent.claimToken, newerEvent.claimToken);
  assert.notEqual(reclaimedEvent.claimToken, staleEvent.claimToken);
  assert.equal(ownerToken, newerEvent.claimToken);

  providerAccepted();
  const staleResult = await staleDelivery;
  assert.deepEqual(staleResult, { eventKey: staleEvent.eventKey, status: 'claim_lost' });
  assert.equal(eventStatus, 'sending');
  assert.equal(ownerToken, newerEvent.claimToken);
  assert.match(successQuery.statement, /claim_token =/);
  assert.match(successQuery.statement, /lease_expires_at > clock_timestamp\(\)/);
  assert.ok(successQuery.values.includes(staleEvent.claimToken));

  const winningResult = await deliverClaimedEvent(reclaimedEvent, async () => {});
  assert.deepEqual(winningResult, { eventKey: staleEvent.eventKey, status: 'sent' });
  assert.equal(eventStatus, 'sent');
  assert.equal(queryCount, 3);
});

test('stale worker failure cannot change the newer claim state', async (t) => {
  const event = notificationEvent();
  const newerClaimToken = '00000000-0000-4000-8000-000000000003';
  let ownerToken = newerClaimToken;
  let eventStatus = 'sending';
  let failureQuery;
  withDatabase(t, async (strings, ...values) => {
    failureQuery = { statement: strings.join(' '), values };
    if (
      values.includes(ownerToken) &&
      failureQuery.statement.includes('SET status =')
    ) {
      eventStatus = 'pending';
      return [{ status: 'pending' }];
    }
    return [];
  });

  const result = await deliverClaimedEvent(event, async () => {
    throw new Error('delivery failed after claim was replaced');
  });

  assert.deepEqual(result, { eventKey: event.eventKey, status: 'claim_lost' });
  assert.match(failureQuery.statement, /claim_token =/);
  assert.match(failureQuery.statement, /lease_expires_at > clock_timestamp\(\)/);
  assert.ok(failureQuery.values.includes(event.claimToken));
  assert.equal(ownerToken, newerClaimToken);
  assert.equal(eventStatus, 'sending');
});

test('Resend rejection is persisted as a retryable failure', async (t) => {
  withEnvironment(t, { RESEND_API_KEY: 'test_key', AUTH_EMAIL_FROM: 'verified@example.com' });
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => ({ ok: false, status: 503 });
  const statements = [];
  withDatabase(t, async (strings, ...values) => {
    const statement = strings.join(' ');
    statements.push({ statement, values });
    return statement.includes('WHERE event_key =')
      ? [notificationEvent(values[0])]
      : stateUpdateRows(statement, values);
  });

  const result = await deliverEventByKey('registration:unit-test');
  assert.equal(result.status, 'retry_scheduled');
  assert.equal(statements.length, 2);
  assert.match(statements[1].statement, /SET status =/);
  assert.ok(statements[1].values.includes('resend_server_error'));
  assert.ok(statements[1].values.includes(60));
  assert.doesNotMatch(statements[1].statement, /response body|api key/i);
});

test('missing Resend configuration consumes the bounded attempts and can be requeued after repair', async (t) => {
  withEnvironment(t, { RESEND_API_KEY: '', AUTH_EMAIL_FROM: 'verified@example.com' });
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let fetchCount = 0;
  global.fetch = async () => {
    fetchCount += 1;
    return { ok: true, status: 200 };
  };
  let attemptCount = 0;
  let permanentFailed = false;
  const statements = [];
  withDatabase(t, async (strings, ...values) => {
    const statement = strings.join(' ');
    if (statement.includes("SET status = 'pending'") &&
        statement.includes("status = 'permanent_failed'")) {
      if (!permanentFailed) return [];
      permanentFailed = false;
      attemptCount = 0;
      return [{ eventKey: values[0] }];
    }
    if (statement.includes('WHERE event_key =')) {
      if (permanentFailed) return [];
      attemptCount += 1;
      return [{ ...notificationEvent(values[0]), attemptCount }];
    }

    statements.push({ statement, values });
    assert.doesNotMatch(statement, /attempt_count\s*=\s*CASE|attempt_count\s*-\s*1/i);
    if (attemptCount >= 5) permanentFailed = true;
    return stateUpdateRows(statement, values);
  });

  const statuses = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    statuses.push((await deliverEventByKey('registration:unit-test')).status);
  }
  assert.deepEqual(statuses, [
    'retry_scheduled', 'retry_scheduled', 'retry_scheduled',
    'retry_scheduled', 'permanent_failed'
  ]);
  assert.equal(attemptCount, 5);
  assert.equal(permanentFailed, true);
  assert.ok(statements.every(({ values }) => values.includes(3600)));
  assert.equal(fetchCount, 0);

  const notClaimed = await deliverEventByKey('registration:unit-test');
  assert.equal(notClaimed.status, 'not_claimed');
  assert.equal(await requeuePermanentFailure('registration:unit-test'), true);

  process.env.RESEND_API_KEY = 'test_resend_key';
  const recovered = await deliverEventByKey('registration:unit-test');
  assert.equal(recovered.status, 'sent');
  assert.equal(fetchCount, 1);
});

test('Resend 401 and 403 responses consume attempts and retain the configuration retry delay', async (t) => {
  withEnvironment(t, { RESEND_API_KEY: 'test_resend_key', AUTH_EMAIL_FROM: 'verified@example.com' });
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  for (const statusCode of [401, 403]) {
    let attemptCount = 0;
    let failureValues;
    global.fetch = async () => ({ ok: false, status: statusCode });
    withDatabase(t, async (strings, ...values) => {
      const statement = strings.join(' ');
      if (statement.includes('WHERE event_key =')) {
        attemptCount += 1;
        return [{ ...notificationEvent(values[0]), attemptCount }];
      }
      failureValues = values;
      assert.doesNotMatch(statement, /attempt_count\s*=\s*CASE|attempt_count\s*-\s*1/i);
      return stateUpdateRows(statement, values);
    });

    const result = await deliverEventByKey(`credential-${statusCode}`);
    assert.equal(result.status, 'retry_scheduled');
    assert.equal(attemptCount, 1);
    assert.ok(failureValues.includes(3600));
  }
});

test('permanent Resend request errors stop retrying and maximum attempts are enforced', async (t) => {
  withEnvironment(t, { RESEND_API_KEY: 'test_key', AUTH_EMAIL_FROM: 'verified@example.com' });
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const statements = [];
  let responseStatus = 400;
  let attemptCount = 1;
  global.fetch = async () => ({ ok: false, status: responseStatus });
  withDatabase(t, async (strings, ...values) => {
    const statement = strings.join(' ');
    statements.push({ statement, values });
    return statement.includes('WHERE event_key =')
      ? [{ ...notificationEvent(values[0]), attemptCount }]
      : stateUpdateRows(statement, values);
  });

  const result = await deliverEventByKey('registration:unit-test');
  assert.equal(result.status, 'permanent_failed');
  assert.ok(statements[1].values.includes('permanent_failed'));

  statements.length = 0;
  responseStatus = 503;
  attemptCount = 5;
  const exhausted = await deliverEventByKey('registration:unit-test');
  assert.equal(exhausted.status, 'permanent_failed');
  assert.ok(statements[1].values.includes('permanent_failed'));
  assert.ok(statements[1].values.includes('max_attempts'));
});

test('database failure recording delivery outcome surfaces after Resend succeeds', async (t) => {
  withEnvironment(t, { RESEND_API_KEY: 'test_key', AUTH_EMAIL_FROM: 'verified@example.com' });
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let fetchCount = 0;
  global.fetch = async () => {
    fetchCount += 1;
    return { ok: true, status: 200 };
  };
  let calls = 0;
  withDatabase(t, async (strings, ...values) => {
    calls += 1;
    if (calls === 1) return [notificationEvent(values[0])];
    throw Object.assign(new Error('database details are private'), { code: '08006' });
  });

  await assert.rejects(deliverEventByKey('registration:unit-test'), /database details are private/);
  assert.equal(fetchCount, 1);
  assert.equal(calls, 2);
});

test('existing magic-link email transport remains available', async (t) => {
  withEnvironment(t, { RESEND_API_KEY: 'test_key', AUTH_EMAIL_FROM: 'verified@example.com' });
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let requestBody;
  global.fetch = async (url, options) => {
    requestBody = JSON.parse(options.body);
    return { ok: true, status: 200 };
  };
  await sendMagicLink({
    to: 'applicant@example.com',
    loginUrl: 'https://example.test/login',
    expiresInMinutes: 15
  });
  assert.equal(requestBody.subject, 'Your Cybanext applicant sign-in link');
});

test('cron notification worker rejects unauthorized requests before processing', async (t) => {
  withEnvironment(t, { CRON_SECRET: 'test-cron-secret' });
  const res = response();
  await cronHandler({ method: 'GET', headers: { authorization: 'Bearer wrong' } }, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Unauthorized.' });
});

test('cron notification worker rejects unsupported methods and missing configuration', async (t) => {
  withEnvironment(t, {
    CRON_SECRET: 'test-cron-secret',
    EMAIL_RECOVERY_SECRET: ''
  });
  const unsupported = response();
  await cronHandler({ method: 'PUT', headers: {} }, unsupported);
  assert.equal(unsupported.statusCode, 405);

  process.env.CRON_SECRET = '';
  const unconfigured = response();
  await cronHandler({ method: 'GET', headers: {} }, unconfigured);
  assert.equal(unconfigured.statusCode, 500);

  const recoveryUnconfigured = response();
  await cronHandler({ method: 'POST', headers: {}, body: {} }, recoveryUnconfigured);
  assert.equal(recoveryUnconfigured.statusCode, 500);
});

test('cron notification worker processes authorized requests and reports permanent failures', async (t) => {
  withEnvironment(t, { CRON_SECRET: 'test-cron-secret' });
  withDatabase(t, async () => [{
    ...notificationEvent(),
    eventType: null,
    recipientEmail: null,
    templateData: null,
    claimToken: null,
    claimStatus: 'permanent_failed'
  }]);
  const res = response();
  await cronHandler({
    method: 'GET',
    headers: { authorization: 'Bearer test-cron-secret' }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    processed: 1,
    sent: 0,
    retryScheduled: 0,
    permanentFailed: 1
  });
});

test('cron notification worker successfully delivers an authenticated due event', async (t) => {
  withEnvironment(t, {
    CRON_SECRET: 'test-cron-secret',
    RESEND_API_KEY: 'test_resend_key',
    AUTH_EMAIL_FROM: 'verified@example.com'
  });
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let fetchCount = 0;
  global.fetch = async () => {
    fetchCount += 1;
    return { ok: true, status: 200 };
  };
  let queryCount = 0;
  withDatabase(t, async (strings, ...values) => {
    queryCount += 1;
    return queryCount === 1
      ? [{
        ...notificationEvent(values[0]),
        claimStatus: 'sending'
      }]
      : stateUpdateRows(strings.join(' '), values);
  });
  const res = response();
  await cronHandler({
    method: 'GET',
    headers: { authorization: 'Bearer test-cron-secret' }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    processed: 1,
    sent: 1,
    retryScheduled: 0,
    permanentFailed: 0
  });
  assert.equal(fetchCount, 1);
});

test('scheduled outbox claims carry the authoritative Digital Forensics registration ID', async (t) => {
  const expectedId = 'DF-123456-ABCDEF';
  let claimStatement;
  withDatabase(t, async (strings) => {
    claimStatement = strings.join(' ');
    return [{
      ...digitalForensicsPaymentEvent(),
      claimStatus: 'sending'
    }];
  });

  const events = await claimDueEvents();

  assert.equal(events[0].digitalForensicsRegistrationId, expectedId);
  assert.match(
    claimStatement,
    /digital_forensics_registration_id AS "digitalForensicsRegistrationId"/
  );
});

test('operator recovery only requeues a permanently failed event', async (t) => {
  const statements = [];
  let shouldRequeue = true;
  withDatabase(t, async (strings, ...values) => {
    statements.push({ statement: strings.join(' '), values });
    return shouldRequeue ? [{ eventKey: values[0] }] : [];
  });
  const recovered = await requeuePermanentFailure('registration:unit-test');
  assert.equal(recovered, true);
  assert.match(statements[0].statement, /status = 'permanent_failed'/);
  assert.ok(statements[0].values.includes('registration:unit-test'));

  shouldRequeue = false;
  assert.equal(await requeuePermanentFailure('registration:not-found'), false);
});

test('requeued Digital Forensics payment-success event reuses its receipt', async (t) => {
  let requeueQuery;
  withDatabase(t, async (strings, ...values) => {
    requeueQuery = { statement: strings.join(' '), values };
    return [{ eventKey: values[0] }];
  });
  assert.equal(
    await requeuePermanentFailure(
      'digital-forensics-payment-success:DF-123456-ABCDEF:DF-PAY-123456'
    ),
    true
  );
  assert.match(requeueQuery.statement, /attempt_count = 0/);

  const receipt = {
    generationStatus: 'ready',
    receiptNumber: 'CN-DF-2025-ABC123',
    blobPathname: 'applicant-payment-receipts/CN-DF-2025-ABC123/claim.pdf',
    pdfSha256: 'a'.repeat(64)
  };
  const receiptResults = [];
  let ensureCount = 0;
  const deliverNotification = createNotificationDelivery({
    receiptService: {
      async ensureReceiptForRegistration() {
        ensureCount += 1;
        receiptResults.push(receipt);
        return receipt;
      }
    },
    receiptStorage: {
      async getVerifiedReceiptPdf(value) {
        assert.equal(value.blobPathname, receipt.blobPathname);
        return Buffer.from('%PDF-1.4\nverified receipt');
      }
    },
    async emailSender() {}
  });

  await deliverNotification(digitalForensicsPaymentEvent());
  await deliverNotification(digitalForensicsPaymentEvent());

  assert.equal(ensureCount, 2);
  assert.equal(receiptResults[0], receiptResults[1]);
  assert.equal(receiptResults[1].receiptNumber, receipt.receiptNumber);
  assert.equal(receiptResults[1].pdfSha256, receipt.pdfSha256);
});

test('Digital Forensics payment-success email is deferred to the scheduled worker', async () => {
  let queryCount = 0;
  const original = database.query;
  database.query = async () => {
    queryCount += 1;
    return [];
  };
  try {
    const eventKey =
      'digital-forensics-payment-success:DF-123456-ABCDEF:DF-PAY-123456';
    const result = await attemptImmediateDelivery(eventKey);
    assert.deepEqual(result, { eventKey, status: 'deferred' });
    assert.equal(queryCount, 0);
  } finally {
    database.query = original;
  }
});

test('email recovery POST requires its separate credential and validates the event key', async (t) => {
  withEnvironment(t, {
    CRON_SECRET: 'test-cron-secret',
    EMAIL_RECOVERY_SECRET: 'test-email-recovery-secret'
  });

  const cronCredential = response();
  await cronHandler({
    method: 'POST',
    headers: { authorization: 'Bearer test-cron-secret' },
    body: {
      action: 'requeue-permanent-failed',
      eventKey: 'registration:unit-test'
    }
  }, cronCredential);
  assert.equal(cronCredential.statusCode, 401);

  const unauthorized = response();
  await cronHandler({ method: 'POST', headers: {}, body: {} }, unauthorized);
  assert.equal(unauthorized.statusCode, 401);

  const invalid = response();
  await cronHandler({
    method: 'POST',
    headers: { authorization: 'Bearer test-email-recovery-secret' },
    body: { action: 'requeue-permanent-failed', eventKey: 'invalid event key' }
  }, invalid);
  assert.equal(invalid.statusCode, 400);
});

test('cron operator recovery requeues an authenticated permanent failure', async (t) => {
  withEnvironment(t, {
    CRON_SECRET: 'test-cron-secret',
    EMAIL_RECOVERY_SECRET: 'test-email-recovery-secret'
  });
  withDatabase(t, async () => [{ eventKey: 'registration:unit-test' }]);
  const res = response();
  await cronHandler({
    method: 'POST',
    headers: { authorization: 'Bearer test-email-recovery-secret' },
    body: {
      action: 'requeue-permanent-failed',
      eventKey: 'registration:unit-test'
    }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { requeued: true });
});

test('email recovery rejects a credential shared with the scheduled worker', async (t) => {
  withEnvironment(t, {
    CRON_SECRET: 'shared-test-secret',
    EMAIL_RECOVERY_SECRET: 'shared-test-secret'
  });
  const res = response();
  await cronHandler({
    method: 'POST',
    headers: { authorization: 'Bearer shared-test-secret' },
    body: {
      action: 'requeue-permanent-failed',
      eventKey: 'registration:unit-test'
    }
  }, res);

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'Email notification recovery is not configured.' });
});
