const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const successHtml = fs.readFileSync(
  path.join(__dirname, '..', 'payment', 'success.html'),
  'utf8'
);
const failedHtml = fs.readFileSync(
  path.join(__dirname, '..', 'payment', 'failed.html'),
  'utf8'
);
const successScript = successHtml.match(
  /<script>\s*([\s\S]*?)\s*<\/script>/
)[1];
const failedScript = failedHtml.match(
  /<script>\s*([\s\S]*?)\s*<\/script>/
)[1];

function createElement() {
  return {
    innerHTML: '',
    style: { display: 'none' },
    textContent: ''
  };
}

test('payment result inline scripts have valid JavaScript syntax', () => {
  assert.doesNotThrow(() => new Function(successScript));
  assert.doesNotThrow(() => new Function(failedScript));
});

async function renderSuccessPage({
  search = '?reference=CYB-TEST-123',
  verification = { ok: true, body: { verified: true } }
} = {}) {
  const elements = new Map([
    'applicantName',
    'selectedTrack',
    'paymentReference',
    'resultTitle',
    'resultMessage',
    'resultIcon',
    'resultNote',
    'homeButton',
    'retryPaymentButton'
  ].map((id) => [id, createElement()]));
  const requests = [];
  const sandbox = {
    URLSearchParams,
    console: { error() {} },
    document: {
      getElementById(id) {
        return elements.get(id) || null;
      }
    },
    fetch: async (...args) => {
      requests.push(args);
      return {
        ok: verification.ok,
        async json() {
          return verification.body;
        }
      };
    },
    sessionStorage: {
      getItem(key) {
        return {
          applicantName: 'Test Applicant',
          applicantTrackLabel: 'Digital Forensics'
        }[key] || null;
      }
    },
    window: { location: { search } }
  };

  await vm.runInNewContext(successScript, sandbox);
  return { elements, requests };
}

test('success result page keeps the Cybanext destination and removes dashboard navigation', () => {
  assert.match(successHtml, /href="\.\.\/index\.html"/);
  assert.match(successHtml, />\s*Return to Cybanext\s*<i/);
  assert.doesNotMatch(
    successHtml,
    /applicant-dashboard|Return to Applicant Dashboard|dashboardButton/i
  );
});

test('failed result page exposes Cybanext as its only return link', () => {
  const links = [...failedHtml.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
  assert.equal(links.length, 1);
  assert.match(links[0][1], /href="\.\.\/index\.html"/i);
  assert.match(links[0][2], /Return to Cybanext/);
  assert.doesNotMatch(
    failedHtml,
    /applicant-dashboard|Return to Applicant Dashboard|dashboardButton/i
  );
});

test('successful verification preserves result details and shows only the Cybanext return action', async () => {
  const { elements, requests } = await renderSuccessPage();

  assert.equal(elements.get('resultTitle').textContent, 'Payment Successful');
  assert.equal(elements.get('applicantName').textContent, 'Test Applicant');
  assert.equal(elements.get('selectedTrack').textContent, 'Digital Forensics');
  assert.equal(
    elements.get('paymentReference').textContent,
    'CYB-TEST-123'
  );
  assert.equal(elements.get('homeButton').style.display, 'inline-flex');
  assert.equal(elements.get('retryPaymentButton').style.display, 'none');
  assert.equal(requests.length, 1);
  assert.doesNotMatch(elements.get('resultNote').innerHTML, /dashboard/i);
});

test('failed, pending, missing-reference, and unavailable states never create dashboard navigation', async (t) => {
  const cases = [
    {
      name: 'failed',
      options: {
        verification: {
          ok: false,
          body: { transactionStatus: 'failed' }
        }
      },
      expectedTitle: 'Payment Not Completed',
      expectedRetryDisplay: 'inline-flex'
    },
    {
      name: 'pending',
      options: {
        verification: {
          ok: false,
          body: { transactionStatus: 'pending' }
        }
      },
      expectedTitle: 'Payment Verification Pending',
      expectedRetryDisplay: 'none'
    },
    {
      name: 'missing reference',
      options: { search: '' },
      expectedTitle: 'Payment Not Confirmed',
      expectedRetryDisplay: 'inline-flex'
    },
    {
      name: 'verification unavailable',
      options: {
        verification: {
          ok: false,
          body: { error: 'Payment Status Unavailable' }
        }
      },
      expectedTitle: 'Payment Status Unavailable',
      expectedRetryDisplay: 'none'
    }
  ];

  for (const {
    name,
    options,
    expectedTitle,
    expectedRetryDisplay
  } of cases) {
    await t.test(name, async () => {
      const { elements } = await renderSuccessPage(options);
      assert.equal(elements.get('resultTitle').textContent, expectedTitle);
      assert.equal(elements.get('homeButton').style.display, 'inline-flex');
      assert.equal(
        elements.get('retryPaymentButton').style.display,
        expectedRetryDisplay
      );
      assert.doesNotMatch(elements.get('resultNote').innerHTML, /dashboard/i);
    });
  }
});
