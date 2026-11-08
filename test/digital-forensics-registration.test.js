const assert = require('node:assert/strict');
const test = require('node:test');
const registerDigitalForensicsApplicant =
  require('../digital-forensics-registration');
const createDigitalForensicsRegistrationHandler =
  require('../api/create-digital-forensics-registration');

test('Digital Forensics registration is saved before returning checkout details', async () => {
  const values = new Map();
  let request;
  const registration = {
    registrationId: 'DF-123',
    fullName: 'Test Applicant',
    email: 'applicant@example.com',
    phone: '+233201234567'
  };

  const result = await registerDigitalForensicsApplicant({
    fullName: registration.fullName,
    email: registration.email,
    phone: registration.phone
  }, {
    fetchRequest: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        async json() {
          return registration;
        }
      };
    },
    storage: {
      setItem(key, value) {
        values.set(key, value);
      }
    }
  });

  assert.equal(request.url, '/api/create-digital-forensics-registration');
  assert.deepEqual(JSON.parse(request.options.body), {
    fullName: 'Test Applicant',
    email: 'applicant@example.com',
    phone: '+233201234567',
    smsConsent: false,
    consentSource: 'digital_forensics_standalone'
  });
  assert.equal(result.registrationId, 'DF-123');
  assert.deepEqual(Object.fromEntries(values), {
    digitalForensicsRegistrationId: 'DF-123',
    selectedTrack: 'digital_forensics',
    digitalForensicsApplicantName: 'Test Applicant',
    digitalForensicsApplicantEmail: 'applicant@example.com',
    digitalForensicsApplicantPhone: '+233201234567'
  });
});

test('Digital Forensics registration helper forwards an explicit grant and source', async () => {
  let requestBody;
  await registerDigitalForensicsApplicant({
    fullName: 'Test Applicant',
    email: 'applicant@example.com',
    phone: '0241234567',
    smsConsent: true,
    consentSource: 'main_application'
  }, {
    fetchRequest: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        async json() {
          return {
            registrationId: 'DF-124',
            fullName: 'Test Applicant',
            email: 'applicant@example.com',
            phone: '+233241234567'
          };
        }
      };
    },
    storage: { setItem() {} }
  });

  assert.equal(requestBody.phone, '0241234567');
  assert.equal(requestBody.smsConsent, true);
  assert.equal(requestBody.consentSource, 'main_application');
});

test('Digital Forensics registration errors do not save checkout session data', async () => {
  const values = new Map();

  await assert.rejects(
    registerDigitalForensicsApplicant({
      fullName: 'Test Applicant',
      email: 'applicant@example.com',
      phone: ''
    }, {
      fetchRequest: async () => ({
        ok: false,
        async json() {
          return { error: 'Registration unavailable.' };
        }
      }),
      storage: {
        setItem(key, value) {
          values.set(key, value);
        }
      }
    }),
    /Registration unavailable\./
  );

  assert.equal(values.size, 0);
});

test('Digital Forensics registration rejects responses without an ID', async () => {
  const values = new Map();

  await assert.rejects(
    registerDigitalForensicsApplicant({
      fullName: 'Test Applicant',
      email: 'applicant@example.com',
      phone: ''
    }, {
      fetchRequest: async () => ({
        ok: true,
        async json() {
          return { fullName: 'Test Applicant' };
        }
      }),
      storage: {
        setItem(key, value) {
          values.set(key, value);
        }
      }
    }),
    /could not save your Digital Forensics registration/i
  );

  assert.equal(values.size, 0);
});

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

test('Digital Forensics API normalizes valid Ghana numbers and accepts omitted phone', async () => {
  const registrations = [];
  const handler = createDigitalForensicsRegistrationHandler.createHandler(
    async (registration) => {
      registrations.push(registration);
      return {
        id: `DF-${registrations.length}`,
        ...registration,
        course: 'digital_forensics',
        status: 'pending',
        expectedAmount: 1200,
        expectedCurrency: 'GHS'
      };
    },
    async () => {}
  );
  const localResponse = createResponse();
  await handler({
    method: 'POST',
    body: {
      fullName: 'Test Applicant',
      email: 'applicant@example.com',
      phone: '0241234567',
      smsConsent: true,
      consentSource: 'digital_forensics_standalone'
    }
  }, localResponse);
  const emptyResponse = createResponse();
  await handler({
    method: 'POST',
    body: {
      fullName: 'Test Applicant',
      email: 'applicant@example.com'
    }
  }, emptyResponse);

  assert.equal(localResponse.statusCode, 200);
  assert.equal(localResponse.body.phone, '+233241234567');
  assert.equal(registrations[0].phone, '+233241234567');
  assert.equal(registrations[0].smsConsent, true);
  assert.equal(emptyResponse.statusCode, 200);
  assert.equal(emptyResponse.body.phone, '');
  assert.equal(registrations[1].smsConsent, false);
});

test('Digital Forensics API rejects opt-in without a valid Ghanaian phone', async (t) => {
  let registrationCalled = false;
  const handler = createDigitalForensicsRegistrationHandler.createHandler(
    async () => {
      registrationCalled = true;
      throw new Error('must not register');
    },
    async () => {}
  );

  for (const phone of ['', '+12025550123', 'not-a-number']) {
    const response = createResponse();
    await handler({
      method: 'POST',
      body: {
        fullName: 'Test Applicant',
        email: 'applicant@example.com',
        phone,
        smsConsent: true
      }
    }, response);
    assert.equal(response.statusCode, 400);
    assert.match(response.body.error, /Ghanaian phone number/i);
  }
  assert.equal(registrationCalled, false);
});
