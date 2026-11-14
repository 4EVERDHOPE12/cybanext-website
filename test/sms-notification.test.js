const assert = require('node:assert/strict');
const test = require('node:test');
const database = require('../lib/digital-forensics-database');
const {
  ARKESEL_SEND_URL,
  createPaymentSuccessMessage,
  sendPaymentSuccessSms
} = require('../lib/arkesel-sms');
const {
  MAX_ATTEMPTS,
  processDueEvents
} = require('../lib/sms-notification-outbox');
const workerHandler = require('../api/process-sms-notifications');

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

function smsEvent(overrides = {}) {
  return {
    eventId: '00000000-0000-4000-8000-000000000001',
    eventKey: 'sms:payment-success:regular-track:RT-123:CYB-123456',
    eventType: 'sms_payment_success',
    regularTrackRegistrationId: 'RT-123',
    digitalForensicsRegistrationId: null,
    phoneSnapshot: '+233201234567',
    templateData: { track: 'incident_response' },
    attemptCount: 1,
    claimToken: '00000000-0000-4000-8000-000000000002',
    claimStatus: 'sending',
    ...overrides
  };
}

function withFetch(t, fetch) {
  const original = global.fetch;
  global.fetch = fetch;
  t.after(() => { global.fetch = original; });
}

function successfulArkeselResponse(messageId = 'arkesel-message-1') {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        status: 'success',
        data: [{ recipient: '233201234567', id: messageId }]
      };
    }
  };
}

test('payment-success SMS formatting rejects other notification types', () => {
  assert.equal(
    createPaymentSuccessMessage(smsEvent()),
    'Cybanext: Your payment for Incident Response is confirmed.'
  );
  assert.throws(
    () => createPaymentSuccessMessage(smsEvent({ eventType: 'marketing' })),
    (error) => error.notificationErrorCode === 'invalid_template_data' &&
      error.permanentFailure === true
  );
});

test('Arkesel adapter sends a Ghanaian recipient with configured credentials', async (t) => {
  withEnvironment(t, {
    ARKESEL_API_KEY: 'test_arkesel_key',
    ARKESEL_SENDER_ID: 'CYBANEXT'
  });
  let request;
  withFetch(t, async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return successfulArkeselResponse();
  });

  const result = await sendPaymentSuccessSms(smsEvent());

  assert.equal(request.url, ARKESEL_SEND_URL);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['api-key'], 'test_arkesel_key');
  assert.equal(request.body.sender, 'CYBANEXT');
  assert.deepEqual(request.body.recipients, ['233201234567']);
  assert.match(request.body.message, /payment for Incident Response is confirmed/);
  assert.equal(result.providerMessageId, 'arkesel-message-1');
});

test('Arkesel adapter reports safe configuration, timeout, and provider errors', async (t) => {
  withEnvironment(t, {
    ARKESEL_API_KEY: 'private-test-key',
    ARKESEL_SENDER_ID: 'CYBANEXT'
  });
  withFetch(t, async () => ({ ok: false, status: 429 }));
  await assert.rejects(
    sendPaymentSuccessSms(smsEvent()),
    (error) => error.notificationErrorCode === 'arkesel_rate_limited' &&
      !error.message.includes('private-test-key')
  );

  global.fetch = async () => ({ ok: false, status: 400 });
  await assert.rejects(
    sendPaymentSuccessSms(smsEvent()),
    (error) => error.notificationErrorCode === 'arkesel_rejected' &&
      error.permanentFailure === true
  );

  global.fetch = async () => ({ ok: false, status: 401 });
  await assert.rejects(
    sendPaymentSuccessSms(smsEvent()),
    (error) => error.notificationErrorCode === 'configuration_missing' &&
      error.message === 'Arkesel SMS authentication failed.'
  );

  global.fetch = async () => ({ ok: false, status: 403 });
  await assert.rejects(
    sendPaymentSuccessSms(smsEvent()),
    (error) => error.notificationErrorCode === 'configuration_missing' &&
      error.message === 'Arkesel SMS gateway is inactive.'
  );

  global.fetch = async () => {
    const error = new Error('sensitive network detail');
    error.name = 'TimeoutError';
    throw error;
  };
  await assert.rejects(
    sendPaymentSuccessSms(smsEvent()),
    (error) => error.notificationErrorCode === 'timeout' &&
      !error.message.includes('sensitive network detail')
  );

  process.env.ARKESEL_API_KEY = '';
  await assert.rejects(
    sendPaymentSuccessSms(smsEvent()),
    (error) => error.notificationErrorCode === 'configuration_missing'
  );
});

test('SMS worker rechecks payment consent and cancels withdrawn or mismatched events', async (t) => {
  let fetchCount = 0;
  withFetch(t, async () => {
    fetchCount += 1;
    return successfulArkeselResponse();
  });
  const statements = [];
  withDatabase(t, async (strings) => {
    const statement = strings.join(' ');
    statements.push(statement);
    if (statement.includes('WITH exhausted')) return [smsEvent()];
    if (statement.includes('SELECT EXISTS')) return [{ eligible: false }];
    if (statement.includes("SET status = 'cancelled'")) {
      return [{ eventId: smsEvent().eventId }];
    }
    return [];
  });

  const results = await processDueEvents(1);

  assert.deepEqual(results, [{
    eventKey: smsEvent().eventKey,
    status: 'cancelled'
  }]);
  assert.equal(fetchCount, 0);
  assert.match(statements[0], /FOR UPDATE SKIP LOCKED/);
  assert.match(statements[1], /sms_consent_events/);
  assert.match(statements[1], /payment_verified/);
  assert.match(statements[1], /ORDER BY occurred_at DESC, event_id DESC/);
  assert.match(statements[1], /consent\.phone_snapshot = outbox\.phone_snapshot/);
  assert.match(statements[2], /claim_token =/);
});

test('SMS worker sends eligible events and records the provider message ID', async (t) => {
  withEnvironment(t, {
    ARKESEL_API_KEY: 'test_arkesel_key',
    ARKESEL_SENDER_ID: 'CYBANEXT'
  });
  let fetchCount = 0;
  withFetch(t, async () => {
    fetchCount += 1;
    return successfulArkeselResponse();
  });
  const statements = [];
  withDatabase(t, async (strings) => {
    const statement = strings.join(' ');
    statements.push(statement);
    if (statement.includes('WITH exhausted')) return [smsEvent()];
    if (statement.includes('SELECT EXISTS')) return [{ eligible: true }];
    if (statement.includes("SET status = 'sent'")) {
      return [{ eventId: smsEvent().eventId }];
    }
    return [];
  });

  const results = await processDueEvents(1);

  assert.deepEqual(results, [{
    eventKey: smsEvent().eventKey,
    status: 'sent'
  }]);
  assert.equal(fetchCount, 1);
  assert.match(statements[2], /provider_message_id =/);
  assert.match(statements[2], /claim_token =/);
});

test('SMS provider failures schedule bounded retries and exhaust at the attempt limit', async (t) => {
  withEnvironment(t, {
    ARKESEL_API_KEY: 'test_arkesel_key',
    ARKESEL_SENDER_ID: 'CYBANEXT'
  });
  withFetch(t, async () => ({ ok: false, status: 503 }));
  let currentEvent = smsEvent();
  const failureStatements = [];
  withDatabase(t, async (strings, ...values) => {
    const statement = strings.join(' ');
    if (statement.includes('WITH exhausted')) return [currentEvent];
    if (statement.includes('SELECT EXISTS')) return [{ eligible: true }];
    if (statement.includes('SET status =')) {
      failureStatements.push({ statement, values });
      return [{ eventId: currentEvent.eventId }];
    }
    return [];
  });

  const retryResult = await processDueEvents(1);
  assert.equal(retryResult[0].status, 'retry_scheduled');
  assert.match(failureStatements[0].statement, /next_attempt_at/);
  assert.match(failureStatements[0].statement, /INTERVAL '1 second'/);

  currentEvent = smsEvent({ attemptCount: MAX_ATTEMPTS });
  const exhaustedResult = await processDueEvents(1);
  assert.equal(exhaustedResult[0].status, 'permanent_failed');
  assert.ok(failureStatements[1].values.includes('permanent_failed'));
  assert.ok(failureStatements[1].values.includes('max_attempts'));
});

test('concurrent SMS workers rely on row locking and send a claimed event once', async (t) => {
  withEnvironment(t, {
    ARKESEL_API_KEY: 'test_arkesel_key',
    ARKESEL_SENDER_ID: 'CYBANEXT'
  });
  let fetchCount = 0;
  withFetch(t, async () => {
    fetchCount += 1;
    return successfulArkeselResponse();
  });
  let claimCount = 0;
  const claimStatements = [];
  withDatabase(t, async (strings) => {
    const statement = strings.join(' ');
    if (statement.includes('WITH exhausted')) {
      claimStatements.push(statement);
      claimCount += 1;
      return claimCount === 1 ? [smsEvent()] : [];
    }
    if (statement.includes('SELECT EXISTS')) return [{ eligible: true }];
    if (statement.includes("SET status = 'sent'")) {
      return [{ eventId: smsEvent().eventId }];
    }
    return [];
  });

  const results = await Promise.all([
    processDueEvents(1),
    processDueEvents(1)
  ]);

  assert.equal(fetchCount, 1);
  assert.equal(results.flat().length, 1);
  assert.match(claimStatements[0], /FOR UPDATE SKIP LOCKED/);
  assert.match(claimStatements[0], /claim_token = gen_random_uuid\(\)/);
});

test('SMS worker endpoint rejects unauthorized requests before processing', async (t) => {
  withEnvironment(t, { CRON_SECRET: 'test-cron-secret' });
  let queryCount = 0;
  withDatabase(t, async () => {
    queryCount += 1;
    return [];
  });

  const res = response();
  await workerHandler({
    method: 'POST',
    headers: { authorization: 'Bearer wrong' }
  }, res);

  assert.equal(res.statusCode, 401);
  assert.equal(queryCount, 0);
});

test('SMS worker endpoint rejects requests when CRON_SECRET is missing', async (t) => {
  withEnvironment(t, { CRON_SECRET: '' });
  let queryCount = 0;
  withDatabase(t, async () => {
    queryCount += 1;
    return [];
  });

  const res = response();
  await workerHandler({
    method: 'POST',
    headers: { authorization: 'Bearer test-cron-secret' }
  }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(queryCount, 0);
});

test('SMS worker endpoint authenticates authorized processing requests', async (t) => {
  withEnvironment(t, { CRON_SECRET: 'test-cron-secret' });
  withDatabase(t, async (strings) =>
    strings.join(' ').includes('WITH exhausted')
      ? [{
        ...smsEvent(),
        eventType: null,
        phoneSnapshot: null,
        templateData: null,
        claimToken: null,
        claimStatus: 'permanent_failed'
      }]
      : []
  );

  const res = response();
  await workerHandler({
    method: 'GET',
    headers: { authorization: 'Bearer test-cron-secret' }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    processed: 1,
    sent: 0,
    retryScheduled: 0,
    permanentFailed: 1,
    cancelled: 0
  });
});

test('SMS worker POST processes queued events with the scheduled-worker credential', async (t) => {
  withEnvironment(t, {
    CRON_SECRET: 'test-cron-secret',
    ARKESEL_API_KEY: 'test_arkesel_key',
    ARKESEL_SENDER_ID: 'CYBANEXT'
  });
  let fetchCount = 0;
  withFetch(t, async () => {
    fetchCount += 1;
    return successfulArkeselResponse();
  });

  let claimCount = 0;
  withDatabase(t, async (strings) => {
    const statement = strings.join(' ');
    if (statement.includes('WITH exhausted')) {
      claimCount += 1;
      return claimCount === 1 ? [smsEvent()] : [];
    }
    if (statement.includes('SELECT EXISTS')) return [{ eligible: true }];
    if (statement.includes("SET status = 'sent'")) {
      return [{ eventId: smsEvent().eventId }];
    }
    return [];
  });

  const res = response();
  await workerHandler({
    method: 'POST',
    headers: { authorization: 'Bearer test-cron-secret' }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    processed: 1,
    sent: 1,
    retryScheduled: 0,
    permanentFailed: 0,
    cancelled: 0
  });
  assert.equal(fetchCount, 1);
});
