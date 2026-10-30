const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  CONFIRMATION_MESSAGE,
  SESSION_COOKIE_NAME,
  createClearedSessionCookie,
  createApplicantAuthService,
  hashToken
} = require('../lib/applicant-auth-service');
const logoutApplicant = require('../api/logout-applicant');
const getApplicantSession = require('../api/applicant-session');

const RATE_LIMIT_SECRET = 'test-only-rate-limit-secret-that-is-at-least-32-chars';
const SITE_URL = 'https://example.test';
const EMAIL = 'applicant@example.com';
const IP = '203.0.113.9';

function createFakeStore(options = {}) {
  const requests = [];
  const tokens = [];
  const rateCounts = new Map();
  let sessionHash = null;
  let sessionRevoked = false;
  let applicant = options.applicant === undefined
    ? { registrationId: 'DF-test-registration' }
    : options.applicant;

  return {
    requests,
    tokens,
    rateCounts,
    get sessionHash() {
      return sessionHash;
    },
    setApplicant(value) {
      applicant = value;
    },
    async incrementRateLimit(scope, keyHash, limit) {
      const key = `${scope}:${keyHash}`;
      const count = (rateCounts.get(key) || 0) + 1;
      rateCounts.set(key, count);
      return { allowed: count <= limit };
    },
    async findEligibleApplicant(email) {
      requests.push({ type: 'lookup', email });
      return applicant;
    },
    async createMagicLinkToken(record) {
      tokens.push(record);
    },
    async redeemMagicLinkToken(record) {
      requests.push({ type: 'redeem', ...record });
      if (options.redeem) {
        return options.redeem(record);
      }
      if (options.redeemResult === null) {
        return null;
      }
      sessionHash = record.sessionTokenHash;
      sessionRevoked = false;
      return { registrationId: 'DF-test-registration' };
    },
    async findApplicantSession(hash) {
      return hash === sessionHash && !sessionRevoked
        ? { registrationId: 'DF-test-registration' }
        : null;
    },
    async revokeApplicantSession(hash) {
      if (hash !== sessionHash || sessionRevoked) {
        return false;
      }
      sessionRevoked = true;
      return true;
    }
  };
}

function createService(options = {}) {
  const fakeStore = options.store || createFakeStore();
  const emails = [];
  const logs = [];
  const service = createApplicantAuthService({
    store: fakeStore,
    sendMagicLink: async (message) => {
      if (options.emailFailure) {
        throw new Error(message.loginUrl);
      }
      emails.push(message);
    },
    now: () => new Date('2026-10-20T12:00:00.000Z'),
    randomBytes: options.randomBytes || crypto.randomBytes,
    rateLimitSecret: RATE_LIMIT_SECRET,
    siteUrl: SITE_URL,
    minimumResponseTimeMs: 0,
    isProduction: options.isProduction || false,
    logger: { error: (...args) => logs.push(args) }
  });

  return { service, fakeStore, emails, logs };
}

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

test('invalid email is rejected without database lookup or email', async () => {
  const { service, fakeStore, emails } = createService();

  const result = await service.requestLogin({ email: 'invalid', ipAddress: IP });

  assert.equal(result.statusCode, 400);
  assert.equal(fakeStore.requests.length, 0);
  assert.equal(emails.length, 0);
});

test('known and unknown email requests share the same public confirmation', async () => {
  const known = createService();
  const unknown = createService();
  unknown.fakeStore.setApplicant(null);

  const knownResult = await known.service.requestLogin({
    email: ` ${EMAIL.toUpperCase()} `,
    ipAddress: IP
  });
  const unknownResult = await unknown.service.requestLogin({
    email: EMAIL,
    ipAddress: IP
  });

  assert.deepEqual(knownResult, {
    statusCode: 200,
    body: { message: CONFIRMATION_MESSAGE }
  });
  assert.deepEqual(unknownResult, knownResult);
  assert.equal(known.fakeStore.requests[0].email, EMAIL);
  assert.equal(known.emails.length, 1);
  assert.equal(unknown.emails.length, 0);
});

test('magic link token is high entropy and only its hash is stored', async () => {
  const { service, fakeStore, emails } = createService();

  await service.requestLogin({ email: EMAIL, ipAddress: IP });

  const token = new URL(emails[0].loginUrl).hash.slice(1).replace(/^token=/, '');
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  assert.equal(fakeStore.tokens.length, 1);
  assert.equal(fakeStore.tokens[0].tokenHash, hashToken(token));
  assert.notEqual(fakeStore.tokens[0].tokenHash, token);
  assert.equal(fakeStore.tokens[0].expiresAt.toISOString(), '2026-10-20T12:15:00.000Z');
});

test('email delivery failure retains the generic response and logs no link or token', async () => {
  const { service, logs, fakeStore } = createService({
    emailFailure: true,
    randomBytes: () => Buffer.alloc(32, 1)
  });

  const result = await service.requestLogin({ email: EMAIL, ipAddress: IP });
  const logged = JSON.stringify(logs);
  const tokenHash = fakeStore.tokens[0].tokenHash;
  const rawToken = Buffer.alloc(32, 1).toString('base64url');

  assert.deepEqual(result, {
    statusCode: 200,
    body: { message: CONFIRMATION_MESSAGE }
  });
  assert.equal(logs.length, 1);
  assert.equal(logged.includes('https://'), false);
  assert.equal(logged.includes(tokenHash), false);
  assert.equal(logged.includes(rawToken), false);
});

test('email limit blocks after three requests while returning the same confirmation', async () => {
  const { service, emails } = createService();
  const results = [];

  for (let index = 0; index < 4; index += 1) {
    results.push(await service.requestLogin({ email: EMAIL, ipAddress: IP }));
  }

  assert.equal(emails.length, 3);
  assert.equal(results.every((result) =>
    result.body.message === CONFIRMATION_MESSAGE), true);
});

test('IP limit blocks after ten requests', async () => {
  const { service, emails } = createService();
  const results = [];

  for (let index = 0; index < 11; index += 1) {
    results.push(await service.requestLogin({
      email: `applicant${index}@example.com`,
      ipAddress: IP
    }));
  }

  assert.equal(emails.length, 10);
  assert.equal(results.every((result) =>
    result.body.message === CONFIRMATION_MESSAGE), true);
});

test('expired and previously used tokens are rejected', async (t) => {
  for (const name of ['expired', 'used']) {
    await t.test(name, async () => {
      const fakeStore = createFakeStore({ redeemResult: null });
      const { service } = createService({ store: fakeStore });

      const result = await service.verifyLoginToken('a'.repeat(43));

      assert.deepEqual(result, { authenticated: false });
    });
  }
});

test('successful token redemption creates hashed session and secure cookie flags', async () => {
  const { service, fakeStore, logs } = createService({ isProduction: true });
  const token = crypto.randomBytes(32).toString('base64url');

  const result = await service.verifyLoginToken(token);

  assert.equal(result.authenticated, true);
  assert.equal(fakeStore.requests.length, 1);
  assert.equal(fakeStore.requests[0].tokenHash, hashToken(token));
  assert.match(fakeStore.requests[0].sessionTokenHash, /^[a-f0-9]{64}$/);
  assert.match(result.cookie, new RegExp(`^${SESSION_COOKIE_NAME}=`));
  assert.match(result.cookie, /HttpOnly/);
  assert.match(result.cookie, /SameSite=Lax/);
  assert.match(result.cookie, /Path=\//);
  assert.match(result.cookie, /Secure/);
  assert.match(result.cookie, /Max-Age=2592000/);
  assert.match(result.cookie, /Expires=/);
  assert.equal(result.cookie.includes(token), false);
  assert.equal(JSON.stringify(logs).includes(result.cookie.split('=')[1].split(';')[0]), false);
});

test('concurrent redemption permits only one session', async () => {
  let redeemed = false;
  const fakeStore = createFakeStore({
    redeem: async (record) => {
      if (redeemed) {
        return null;
      }
      redeemed = true;
      await Promise.resolve();
      return { registrationId: 'DF-test-registration', ...record };
    }
  });
  const { service } = createService({ store: fakeStore });
  const token = crypto.randomBytes(32).toString('base64url');

  const results = await Promise.all([
    service.verifyLoginToken(token),
    service.verifyLoginToken(token)
  ]);

  assert.equal(results.filter((result) => result.authenticated).length, 1);
  assert.equal(results.filter((result) => !result.authenticated).length, 1);
});

test('session validation hashes the cookie token before looking it up', async () => {
  const { service, fakeStore } = createService();
  const loginToken = crypto.randomBytes(32).toString('base64url');

  const verification = await service.verifyLoginToken(loginToken);
  const sessionToken = verification.cookie.match(
    new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`)
  )[1];
  const session = await service.getSession(verification.cookie);

  assert.deepEqual(session, { registrationId: 'DF-test-registration' });
  assert.equal(fakeStore.sessionHash, hashToken(sessionToken));
});

test('logout revokes the current hashed session and is safe to repeat', async () => {
  const { service, fakeStore } = createService({ isProduction: true });
  const loginToken = crypto.randomBytes(32).toString('base64url');
  const verified = await service.verifyLoginToken(loginToken);
  const cookieToken = verified.cookie.match(
    new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`)
  )[1];
  const cookieHeader = `${SESSION_COOKIE_NAME}=${cookieToken}`;

  assert.equal(await service.getSession(cookieHeader) !== null, true);
  assert.equal(await service.logout(cookieHeader), true);
  assert.equal(await service.logout(cookieHeader), false);
  assert.equal(await service.getSession(cookieHeader), null);
  assert.equal(fakeStore.sessionHash, hashToken(cookieToken));
});

test('logout safely ignores invalid and expired session cookies', async () => {
  const { service, fakeStore } = createService();
  const calls = fakeStore.requests.length;

  assert.equal(await service.logout('cybanext_applicant_session=invalid'), false);
  assert.equal(
    await service.logout(
      `${SESSION_COOKIE_NAME}=${crypto.randomBytes(32).toString('base64url')}`
    ),
    false
  );
  assert.equal(fakeStore.requests.length, calls);

  const expiredToken = crypto.randomBytes(32).toString('base64url');
  const expiredHash = hashToken(expiredToken);
  const expiredSession = { expired: true, revoked: false };
  const expiredService = createApplicantAuthService({
    store: {
      async revokeApplicantSession(sessionTokenHash) {
        assert.equal(sessionTokenHash, expiredHash);
        return !expiredSession.expired && !expiredSession.revoked;
      }
    }
  });
  assert.equal(
    await expiredService.logout(`${SESSION_COOKIE_NAME}=${expiredToken}`),
    false
  );
  assert.equal(expiredSession.revoked, false);
});

test('logout endpoint clears the matching cookie and session endpoint rejects it', async (t) => {
  const { service } = createService({ isProduction: true });
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });
  const loginToken = crypto.randomBytes(32).toString('base64url');
  const verified = await service.verifyLoginToken(loginToken);
  const cookieToken = verified.cookie.match(
    new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`)
  )[1];
  const cookieHeader = `${SESSION_COOKIE_NAME}=${cookieToken}`;

  const logoutResponse = createResponse();
  await logoutApplicant.createHandler(service)(
    { method: 'POST', headers: { cookie: cookieHeader } },
    logoutResponse
  );

  assert.equal(logoutResponse.statusCode, 200);
  assert.deepEqual(logoutResponse.body, { loggedOut: true });
  assert.equal(
    logoutResponse.headers['Set-Cookie'],
    createClearedSessionCookie(true)
  );
  assert.match(logoutResponse.headers['Set-Cookie'], /HttpOnly/);
  assert.match(logoutResponse.headers['Set-Cookie'], /SameSite=Lax/);
  assert.match(logoutResponse.headers['Set-Cookie'], /Path=\//);
  assert.match(logoutResponse.headers['Set-Cookie'], /Secure/);
  assert.equal(logoutResponse.headers['Set-Cookie'].includes(cookieToken), false);

  const sessionResponse = createResponse();
  await getApplicantSession.createHandler(service)(
    { method: 'GET', headers: { cookie: cookieHeader } },
    sessionResponse
  );
  assert.equal(sessionResponse.statusCode, 401);
  assert.deepEqual(sessionResponse.body, { authenticated: false });
});

test('logout endpoint requires POST and clears an invalid cookie without exposing session data', async () => {
  const { service } = createService({ isProduction: false });
  const getResponse = createResponse();
  await logoutApplicant.createHandler(service)(
    { method: 'GET', headers: {} },
    getResponse
  );
  assert.equal(getResponse.statusCode, 405);

  const postResponse = createResponse();
  await logoutApplicant.createHandler(service)(
    { method: 'POST', headers: { cookie: `${SESSION_COOKIE_NAME}=invalid` } },
    postResponse
  );
  assert.equal(postResponse.statusCode, 200);
  assert.deepEqual(postResponse.body, { loggedOut: true });
  assert.equal(postResponse.headers['Set-Cookie'], createClearedSessionCookie(false));
});
