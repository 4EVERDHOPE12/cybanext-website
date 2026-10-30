const assert = require('node:assert/strict');
const test = require('node:test');
const registerDigitalForensicsApplicant =
  require('../digital-forensics-registration');

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
    phone: '+233201234567'
  });
  assert.equal(result.registrationId, 'DF-123');
  assert.deepEqual(Object.fromEntries(values), {
    digitalForensicsRegistrationId: 'DF-123',
    digitalForensicsApplicantName: 'Test Applicant',
    digitalForensicsApplicantEmail: 'applicant@example.com',
    digitalForensicsApplicantPhone: '+233201234567'
  });
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
