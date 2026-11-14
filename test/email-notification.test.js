const assert = require('node:assert/strict');
const test = require('node:test');
const database = require('../lib/digital-forensics-database');
const { createMessage } = require('../lib/email-notification');
const {
  deliverEventByKey,
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
    claimToken: '00000000-0000-4000-8000-000000000002'
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
    return [];
  });

  const result = await deliverEventByKey('registration:unit-test');
  assert.equal(result.status, 'sent');
  assert.equal(fetchCount, 1);
  assert.equal(statements.length, 2);
  assert.match(statements[0], /FOR UPDATE SKIP LOCKED/);
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
    return [];
  });

  const results = await Promise.all([
    deliverEventByKey('registration:unit-test'),
    deliverEventByKey('registration:unit-test')
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['not_claimed', 'sent']);
  assert.equal(fetchCount, 1);
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
      : [];
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
    return [];
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
      return [];
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
      : [];
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
    return queryCount === 1 ? [{
      ...notificationEvent(values[0]),
      claimStatus: 'sending'
    }] : [];
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
