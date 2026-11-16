const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
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

function createPaymentCheckoutHarness({ quotes, initialization } = {}) {
  const elements = new Map();
  const requests = [];
  const sessionValues = new Map([
    ['digitalForensicsRegistrationId', 'DF-123456'],
    ['digitalForensicsApplicantName', 'Test Applicant'],
    ['digitalForensicsApplicantEmail', 'applicant@example.com'],
    ['digitalForensicsApplicantPhone', '+233201234567'],
    ['selectedPricingOption', 'GHS']
  ]);
  let quoteIndex = 0;
  const location = {
    href: '',
    replacedWith: null,
    replace(value) {
      this.replacedWith = value;
    }
  };

  function getElement(id) {
    if (!elements.has(id)) {
      const listeners = new Map();
      const classes = new Set();
      elements.set(id, {
        textContent: '',
        innerHTML: '',
        className: '',
        style: {},
        hidden: false,
        disabled: false,
        listeners,
        classes,
        classList: {
          toggle(name, force) {
            if (force) classes.add(name);
            else classes.delete(name);
          }
        },
        addEventListener(name, callback) {
          listeners.set(name, callback);
        },
        click() {
          const callback = listeners.get('click');
          return callback ? callback() : undefined;
        }
      });
    }
    return elements.get(id);
  }

  const sandbox = {
    document: { getElementById: getElement },
    sessionStorage: {
      getItem(key) {
        return sessionValues.has(key) ? sessionValues.get(key) : null;
      },
      setItem(key, value) {
        sessionValues.set(key, value);
      }
    },
    window: { location },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, options, body });
      if (body.operation === 'quote') {
        const quote = quotes[quoteIndex++];
        return {
          ok: true,
          json: async () => quote
        };
      }
      return {
        ok: initialization.ok !== false,
        json: async () => initialization.body || initialization
      };
    },
    console: {
      error() {},
      warn() {}
    }
  };
  const script = fs.readFileSync(checkoutScriptPath, 'utf8');
  vm.runInNewContext(script, sandbox);

  return {
    elements,
    location,
    requests,
    async settle() {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
}

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
  assert.match(homepage, /<strong>GH₵1,500<\/strong>/);
  assert.match(homepage, /<strong>US\$150<\/strong>/);
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
  assert.match(html, /Cost \(Local\)<\/span><strong>GH₵1,500/);
  assert.match(html, /Cost \(International\)<\/span><strong>US\$150/);
  assert.match(html, /class="df-course-price-card"[\s\S]*?Local Applicants[\s\S]*?GH₵ 1,500/);
  assert.match(html, /class="df-course-price-card df-course-price-card-international"[\s\S]*?International Applicants[\s\S]*?US\$150/);
  assert.doesNotMatch(`${homepage}\n${html}`, /GH₵\s*1,200|US?\$\s*120\b/);
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
  const homepageScript = fs.readFileSync(
    path.join(__dirname, '..', 'script.js'),
    'utf8'
  );
  assert.match(homepageScript, /GH₵1,500 \(Local\) \/ US\$150 \(International\)/);
  assert.match(homepageScript, /\/ US\$\$\{prices\.digitalForensics\.USD_REFERENCE\.referenceAmount\}/);
  assert.doesNotMatch(homepageScript, /GH₵1,200|\$120/);
  assert.doesNotMatch(script, /scan-cv|formspree|qualificationToken|internship|id="cv"/i);
  assert.match(
    fs.readFileSync(checkoutScriptPath, 'utf8'),
    /return `US\$/
  );
  assert.match(
    fs.readFileSync(checkoutScriptPath, 'utf8'),
    /sessionStorage\.getItem\('selectedPricingOption'\) === 'USD_REFERENCE'/
  );
});

test('checkout displays current local and international server quotes and submits no client amount', async () => {
  const localQuote = {
    track: 'digital_forensics',
    registrationId: 'DF-123456',
    pricingOption: 'GHS',
    referenceAmount: 1500,
    referenceCurrency: 'GHS',
    chargeAmountGhs: 1500,
    paystackAmount: 150000,
    currency: 'GHS',
    exchangeRate: null,
    existingRegistrationPrice: false,
    pricingLocked: false,
    canPay: true,
    transactionStatus: null
  };
  const internationalQuote = {
    ...localQuote,
    pricingOption: 'USD_REFERENCE',
    referenceAmount: 150,
    referenceCurrency: 'USD',
    chargeAmountGhs: 1732.5,
    paystackAmount: 173250,
    exchangeRate: 11.55
  };
  const harness = createPaymentCheckoutHarness({
    quotes: [localQuote, internationalQuote],
    initialization: {
      authorizationUrl: 'https://checkout.paystack.test/authorize',
      track: 'digital_forensics',
      registrationId: 'DF-123456',
      currency: 'GHS',
      pricingOption: 'USD_REFERENCE',
      referenceAmount: 150,
      referenceCurrency: 'USD',
      chargeAmountGhs: 1732.5,
      paystackAmount: 173250,
      exchangeRate: 11.55
    }
  });
  await harness.settle();

  assert.equal(
    harness.elements.get('programPrice').textContent,
    'GH₵1,500'
  );
  assert.equal(
    harness.elements.get('totalAmount').textContent,
    'GH₵1,500'
  );
  assert.equal(
    harness.elements.get('programPriceLabel').textContent,
    'Program Price (GHS)'
  );

  harness.elements.get('usdBtn').click();
  await harness.settle();

  assert.equal(
    harness.elements.get('programPrice').textContent,
    'US$150.00'
  );
  assert.equal(
    harness.elements.get('totalAmount').textContent,
    'GH₵1,732.50'
  );
  assert.equal(
    harness.elements.get('totalAmountLabel').textContent,
    'GHS Charged by Paystack'
  );
  assert.match(
    harness.elements.get('conversionNote').textContent,
    /1 USD = GH₵11\.55/
  );

  await harness.elements.get('payNowBtn').click();
  const initializationRequest = harness.requests[2];
  assert.equal(
    initializationRequest.url,
    '/api/initialize-digital-forensics-payment'
  );
  assert.equal(initializationRequest.body.expectedQuote.paystackAmount, 173250);
  assert.equal(Object.hasOwn(initializationRequest.body, 'amount'), false);
  assert.equal(
    harness.location.href,
    'https://checkout.paystack.test/authorize'
  );
});

test('checkout displays the preserved legacy international reference and charge', async () => {
  const legacyQuote = {
    track: 'digital_forensics',
    registrationId: 'DF-123456',
    pricingOption: 'USD_REFERENCE',
    referenceAmount: 120,
    referenceCurrency: 'USD',
    chargeAmountGhs: 1386,
    paystackAmount: 138600,
    currency: 'GHS',
    exchangeRate: 11.55,
    existingRegistrationPrice: true,
    pricingLocked: false,
    canPay: true,
    transactionStatus: null
  };
  const harness = createPaymentCheckoutHarness({
    quotes: [legacyQuote]
  });
  harness.elements.get('usdBtn').disabled = false;
  await harness.settle();

  assert.equal(
    harness.elements.get('programPrice').textContent,
    'US$120.00'
  );
  assert.equal(
    harness.elements.get('totalAmount').textContent,
    'GH₵1,386.00'
  );
  assert.match(
    harness.elements.get('conversionNote').textContent,
    /original price is being retained/
  );
  assert.equal(harness.elements.get('payNowBtn').disabled, false);
});

test('checkout reports a newly pending attempt instead of claiming the price changed', async () => {
  const quote = {
    track: 'digital_forensics',
    registrationId: 'DF-123456',
    pricingOption: 'GHS',
    referenceAmount: 1500,
    referenceCurrency: 'GHS',
    chargeAmountGhs: 1500,
    paystackAmount: 150000,
    currency: 'GHS',
    exchangeRate: null,
    existingRegistrationPrice: false,
    pricingLocked: true,
    canPay: true,
    transactionStatus: null
  };
  const pendingQuote = {
    ...quote,
    canPay: false,
    transactionStatus: 'pending'
  };
  const harness = createPaymentCheckoutHarness({
    quotes: [quote],
    initialization: {
      ok: false,
      body: {
        error: 'A previous payment attempt is still being processed.',
        quote: pendingQuote
      }
    }
  });
  await harness.settle();
  await harness.elements.get('payNowBtn').click();

  assert.equal(harness.elements.get('payNowBtn').disabled, true);
  assert.match(
    harness.elements.get('paymentMessage').textContent,
    /previous payment is still processing/
  );
  assert.doesNotMatch(
    harness.elements.get('paymentMessage').textContent,
    /price changed/
  );
  assert.equal(harness.location.href, '');
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
