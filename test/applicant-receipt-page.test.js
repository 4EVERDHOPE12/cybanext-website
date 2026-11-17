const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.join(__dirname, '..');

test('public receipt page explains generic eligibility without exposing account state', () => {
  const html = fs.readFileSync(path.join(root, 'applicant-receipt.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'applicant-receipt.css'), 'utf8');

  assert.match(html, /Request your payment receipt/);
  assert.match(html, /name="email" type="email"/);
  assert.match(html, /does not reveal registration or payment details/);
  assert.match(html, /Poppins/);
  assert.match(css, /#d20334/);
  assert.match(css, /#111111/);
  assert.match(css, /@media \(max-width: 420px\)/);
});

test('public receipt form sends only the email and displays generic loading and confirmation states', async () => {
  const elements = new Map();
  const form = {
    listener: null,
    addEventListener(name, callback) {
      if (name === 'submit') this.listener = callback;
    },
    reset() {
      elements.get('email').value = '';
    }
  };
  const classes = new Set();
  const message = {
    textContent: '',
    classList: {
      add(value) { classes.add(value); },
      remove(value) { classes.delete(value); }
    }
  };
  const email = { value: ' Applicant@example.test ' };
  const button = { disabled: false, textContent: 'Request receipt email' };
  elements.set('receiptResendForm', form);
  elements.set('email', email);
  elements.set('requestReceiptButton', button);
  elements.set('receiptMessage', message);

  let resolveResponse;
  const responsePromise = new Promise((resolve) => {
    resolveResponse = resolve;
  });
  let request;
  const sandbox = {
    document: {
      getElementById(id) { return elements.get(id); }
    },
    fetch: async (url, options) => {
      request = { url, options };
      return responsePromise;
    }
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(root, 'applicant-receipt.js'), 'utf8'),
    sandbox
  );

  const submission = form.listener({ preventDefault() {} });
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'Sending request…');
  resolveResponse({
    ok: true,
    status: 200,
    async json() {
      return {
        message: 'If an eligible paid application is found, the receipt will be sent to the registered email address.'
      };
    }
  });
  await submission;

  assert.equal(request.url, '/api/applicant-session');
  assert.deepEqual(JSON.parse(request.options.body), {
    action: 'request-receipt-resend',
    email: ' Applicant@example.test '
  });
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Request receipt email');
  assert.equal(classes.has('auth-error'), false);
  assert.match(message.textContent, /If an eligible paid application is found/);
  assert.equal(email.value, '');
});
