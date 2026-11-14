const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const createRegistrationFormHandler =
  require('../digital-forensics-page');

const pagePath = path.join(__dirname, '..', 'digital-forensics.html');
const pageScriptPath = path.join(__dirname, '..', 'digital-forensics-page.js');
const checkoutScriptPath = path.join(
  __dirname,
  '..',
  'payment',
  'digital-forensics-payment.js'
);
const createPricingOptionHandler =
  createRegistrationFormHandler.createPricingOptionHandler;

function createFormHarness({
  isValid = true,
  fullName = 'Test Applicant',
  email = 'applicant@example.com',
  phone = '+233201234567',
  smsConsent = false,
  registerApplicant
} = {}) {
  const listeners = new Map();
  const statusElement = {
    textContent: '',
    classes: new Set(),
    classList: {
      add(name) {
        statusElement.classes.add(name);
      },
      remove(name) {
        statusElement.classes.delete(name);
      }
    }
  };
  const submitButton = { disabled: false };
  let reportValidityCalled = false;
  let destination;

  const controls = {
    form: {
      addEventListener(name, callback) {
        listeners.set(name, callback);
      },
      checkValidity() {
        return isValid;
      },
      reportValidity() {
        reportValidityCalled = true;
      }
    },
    fullNameInput: { value: fullName },
    emailInput: { value: email },
    phoneInput: { value: phone, focus() {} },
    smsConsentInput: { checked: smsConsent },
    submitButton,
    statusElement,
    navigate(pathname) {
      destination = pathname;
    }
  };

  createRegistrationFormHandler(registerApplicant)(controls);

  return {
    async submit() {
      let prevented = false;
      await listeners.get('submit')({
        preventDefault() {
          prevented = true;
        }
      });
      return prevented;
    },
    get destination() {
      return destination;
    },
    get reportValidityCalled() {
      return reportValidityCalled;
    },
    statusElement,
    submitButton
  };
}

test('course page presents the approved overview, pricing, syllabus and registration actions', () => {
  const html = fs.readFileSync(pagePath, 'utf8');
  const homepage = fs.readFileSync(
    path.join(__dirname, '..', 'index.html'),
    'utf8'
  );

  assert.match(homepage, /href="\.\/digital-forensics\.html" id="bannerDfApplyBtn"/);
  assert.match(html, /Digital Forensics &amp; Incident Response/);
  assert.match(html, /href="#overview"[^>]*>Overview/);
  assert.match(html, /href="#syllabus"[^>]*>Syllabus/);
  assert.match(html, /href="#pricing"[^>]*>Pricing/);
  assert.doesNotMatch(html, /class="df-course-nav-register"|>Register\s*<i/);
  assert.match(html, /Examine disk and memory images for useful artifacts\./);
  assert.match(html, /Recover and analyze digital evidence methodically\./);
  assert.match(html, /Reconstruct a defensible evidence timeline\./);
  assert.match(html, /Document findings in a clear forensic report\./);
  assert.match(html, /Apply investigation techniques to incident response scenarios\./);
  assert.doesNotMatch(html, /Standalone Course|Book Your Seat|Book Your Course Seat/);
  assert.match(html, /Duration<\/span><strong>2 Months/);
  assert.match(html, /Schedule<\/span><strong>Saturdays &amp; Sundays/);
  assert.match(html, /Cost \(Local\)<\/span><strong>GH₵1,200/);
  assert.match(html, /Cost \(International\)<\/span><strong>\$120/);
  assert.match(html, /class="df-course-price-card"[\s\S]*?Local Applicants[\s\S]*?GH₵ 1,200/);
  assert.match(html, /class="df-course-price-card df-course-price-card-international"[\s\S]*?International Applicants[\s\S]*?\$120/);
  assert.equal((html.match(/<li>Full access to the course<\/li>/g) || []).length, 2);
  assert.equal((html.match(/<li>Hands-on practical sessions<\/li>/g) || []).length, 2);
  assert.equal((html.match(/<li>Certificate of completion<\/li>/g) || []).length, 2);
  assert.match(html, /data-pricing-option="GHS"/);
  assert.match(html, /data-pricing-option="USD_REFERENCE"/);
  assert.match(html, /What you’ll learn/);
  assert.match(html, /id="digitalForensicsRegistrationForm"/);
  assert.match(html, /digital-forensics-registration\.js/);
  assert.match(html, /digital-forensics-page\.js/);
  assert.doesNotMatch(html, /id="applicationForm"|Formspree|id="cv"|name="track"|scan-cv/i);

  const script = fs.readFileSync(pageScriptPath, 'utf8');
  assert.doesNotMatch(script, /scan-cv|formspree|qualificationToken|internship|id="cv"/i);
  assert.match(
    fs.readFileSync(checkoutScriptPath, 'utf8'),
    /sessionStorage\.getItem\('selectedPricingOption'\) === 'USD_REFERENCE'/
  );
});

test('pricing actions save the selected option using the checkout session key', () => {
  const savedOptions = new Map();
  const classes = new Set(['is-error']);
  const statusElement = {
    textContent: 'Previous error',
    classList: {
      add(name) {
        classes.add(name);
      },
      remove(name) {
        classes.delete(name);
      }
    }
  };
  let prevented = false;
  const handler = createPricingOptionHandler(
    () => ({
      setItem(key, value) {
        savedOptions.set(key, value);
      }
    }),
    statusElement
  );

  handler({
    currentTarget: { dataset: { pricingOption: 'USD_REFERENCE' } },
    preventDefault() {
      prevented = true;
    }
  });

  assert.deepEqual(Object.fromEntries(savedOptions), {
    selectedPricingOption: 'USD_REFERENCE'
  });
  assert.equal(prevented, false);
  assert.equal(statusElement.textContent, '');
  assert.equal(classes.has('is-error'), false);
});

test('pricing selection storage errors are reported without continuing to registration', () => {
  const classes = new Set();
  const statusElement = {
    textContent: '',
    classList: {
      add(name) {
        classes.add(name);
      },
      remove(name) {
        classes.delete(name);
      }
    }
  };
  let prevented = false;
  const handler = createPricingOptionHandler(
    () => ({
      setItem() {
        throw new Error('Storage unavailable.');
      }
    }),
    statusElement
  );

  handler({
    currentTarget: { dataset: { pricingOption: 'USD_REFERENCE' } },
    preventDefault() {
      prevented = true;
    }
  });

  assert.equal(prevented, true);
  assert.equal(statusElement.textContent, 'We could not save your selected pricing. Please try again.');
  assert.equal(classes.has('is-error'), true);
});

test('valid standalone registration saves the applicant and hands off to course checkout', async () => {
  let applicant;
  const harness = createFormHarness({
    registerApplicant: async (registration) => {
      applicant = registration;
      return { registrationId: 'DF-123' };
    }
  });

  assert.equal(await harness.submit(), true);
  assert.deepEqual(applicant, {
    fullName: 'Test Applicant',
    email: 'applicant@example.com',
    phone: '+233201234567',
    smsConsent: false,
    consentSource: 'digital_forensics_standalone'
  });
  assert.equal(harness.destination, './payment/digital-forensics.html');
  assert.equal(harness.submitButton.disabled, true);
});

test('standalone course page keeps SMS consent unchecked and sends it only to registration', () => {
  const html = fs.readFileSync(pagePath, 'utf8').replace(/\s+/g, ' ');
  const checkbox = html.match(/<input(?=[^>]*type="checkbox")(?=[^>]*id="dfSmsConsent")[^>]*>/i);
  assert.ok(checkbox);
  assert.doesNotMatch(checkbox[0], /\bchecked\b/i);
  assert.match(html, /SMS notifications confirming successful payment for a Cybanext programme/);
  assert.match(html, /not marketing consent/i);
});

test('main application SMS consent is unchecked and excluded from Formspree submission', () => {
  const homepage = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
  const checkbox = homepage.match(/<input(?=[^>]*type="checkbox")(?=[^>]*id="smsConsent")[^>]*>/i);
  assert.ok(checkbox);
  assert.doesNotMatch(checkbox[0], /\bchecked\b/i);
  assert.match(script, /applicationData\.delete\('smsConsent'\)/);
  assert.match(script, /smsConsent: Boolean\(smsConsent && smsConsent\.checked\)/);
});

test('checked standalone SMS consent without a phone is rejected before registration', async () => {
  let registrationCalled = false;
  const harness = createFormHarness({
    phone: '',
    smsConsent: true,
    registerApplicant: async () => {
      registrationCalled = true;
    }
  });

  await harness.submit();

  assert.equal(registrationCalled, false);
  assert.match(harness.statusElement.textContent, /valid Ghanaian phone number/i);
  assert.equal(harness.destination, undefined);
});

test('invalid standalone registration is reported without calling registration or navigating', async () => {
  let registrationCalled = false;
  const harness = createFormHarness({
    isValid: false,
    registerApplicant: async () => {
      registrationCalled = true;
    }
  });

  assert.equal(await harness.submit(), true);
  assert.equal(harness.reportValidityCalled, true);
  assert.equal(registrationCalled, false);
  assert.equal(harness.destination, undefined);
  assert.equal(harness.submitButton.disabled, false);
});

test('registration API failure displays an error and does not redirect to checkout', async () => {
  const harness = createFormHarness({
    registerApplicant: async () => {
      throw new Error('Registration service is unavailable.');
    }
  });

  await harness.submit();

  assert.equal(harness.destination, undefined);
  assert.equal(harness.statusElement.textContent, 'Registration service is unavailable.');
  assert.equal(harness.statusElement.classes.has('is-error'), true);
  assert.equal(harness.submitButton.disabled, false);
});
