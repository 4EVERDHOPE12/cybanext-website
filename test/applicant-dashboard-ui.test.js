const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.join(__dirname, '..');
const htmlPath = path.join(root, 'applicant-dashboard.html');
const cssPath = path.join(root, 'applicant-dashboard.css');
const scriptPath = path.join(root, 'applicant-dashboard.js');

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.children = [];
    this.hidden = false;
    this.disabled = false;
    this.className = '';
    this.style = {};
    this._textContent = '';
    this._innerHTML = '';
    const classes = new Set();
    this.classList = {
      add: (value) => classes.add(value),
      remove: (...values) => values.forEach((value) => classes.delete(value)),
      contains: (value) => classes.has(value)
    };
  }

  set textContent(value) {
    this._textContent = String(value);
    this.children = [];
  }

  get textContent() {
    return this._textContent;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
  }

  get innerHTML() {
    return this._innerHTML;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(name, callback) {
    this.listeners.set(name, callback);
  }

  click() {
    const listener = this.listeners.get('click');
    return listener ? listener({ currentTarget: this, preventDefault() {} }) : undefined;
  }

  focus(options) {
    this.ownerDocument.activeElement = this;
    this.lastFocusOptions = options;
  }

  contains(element) {
    return element === this || this.children.includes(element);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  append(...children) {
    this.children.push(...children);
  }
}

async function createDashboardHarness(applicant, initialHash = '') {
  const ids = [
    'menuToggleButton',
    'primaryNavigation',
    'logoutButton',
    'supportLink',
    'payNowButton',
    'welcomeName',
    'userNameLabel',
    'applicationReferenceText',
    'trackValue',
    'applicationStatusValue',
    'paymentValue',
    'applicationTrackValue',
    'applicationReferenceValue',
    'submissionDateValue',
    'applicantEmailValue',
    'applicationStatusDetail',
    'paymentAlertText',
    'amountValue',
    'paymentStatusValue',
    'paymentReferenceItem',
    'referenceValue',
    'verifiedTransactionItem',
    'verifiedTransactionValue',
    'paymentVerifiedDateItem',
    'paymentVerifiedDateValue',
    'progressList',
    'applicationCard',
    'paymentCard',
    'overview',
    'application',
    'support'
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
  elements.get('menuToggleButton').setAttribute('aria-label', 'Open navigation menu');
  elements.get('menuToggleButton').setAttribute('aria-expanded', 'false');
  elements.get('menuToggleButton').setAttribute('aria-controls', 'primaryNavigation');
  const links = ['overview', 'application', 'support'].map((section) => {
    const link = new FakeElement(`nav-${section}`);
    link.setAttribute('href', `#${section}`);
    return link;
  });
  links[0].setAttribute('aria-current', 'page');
  const nav = elements.get('primaryNavigation');
  nav.dataset.open = 'false';
  nav.querySelectorAll = (selector) =>
    selector === '[data-dashboard-link]' ? links : [];
  nav.querySelector = (selector) =>
    selector === '[data-dashboard-link]' ? links[0] : null;
  links.forEach((link) => {
    link.ownerDocument = {
      getElementById: (id) => elements.get(id),
      activeElement: null
    };
  });

  const documentListeners = new Map();
  const document = {
    activeElement: null,
    getElementById(id) {
      return elements.get(id) || null;
    },
    createElement() {
      const element = new FakeElement();
      element.ownerDocument = document;
      return element;
    },
    addEventListener(name, callback) {
      documentListeners.set(name, callback);
    }
  };
  for (const element of elements.values()) {
    element.ownerDocument = document;
  }
  links.forEach((link) => {
    link.ownerDocument = document;
    elements.set(link.id, link);
  });

  const windowListeners = new Map();
  const location = {
    hash: initialHash,
    replacedWith: null,
    assignedTo: null,
    replace(value) {
      this.replacedWith = value;
    },
    assign(value) {
      this.assignedTo = value;
    }
  };
  const sandbox = {
    document,
    window: {
      innerWidth: 390,
      location,
      addEventListener(name, callback) {
        windowListeners.set(name, callback);
      }
    },
    fetch: async (url) => {
      assert.equal(url, '/api/applicant-session?includeDashboard=true');
      return {
        status: 200,
        ok: true,
        async json() {
          return { authenticated: true, applicant };
        }
      };
    },
    console: { error() {} }
  };
  const script = fs.readFileSync(scriptPath, 'utf8');
  await vm.runInNewContext(script, sandbox);

  return {
    document,
    elements,
    links,
    location,
    window: sandbox.window,
    documentListeners,
    windowListeners
  };
}

function applicant(overrides = {}) {
  return {
    fullName: 'Amina Applicant',
    email: 'amina@example.test',
    registrationId: 'DF-2026-123',
    track: 'Digital Forensics',
    status: 'pending',
    applicationStatus: 'Received',
    amountDue: 1500,
    currency: 'GHS',
    paymentReference: null,
    verifiedTransactionId: null,
    paymentVerificationTimestamp: null,
    createdAt: '2026-10-20T12:00:00.000Z',
    canPay: true,
    ...overrides
  };
}

test('mobile navigation opens accessibly and Escape closes it with focus restored', async () => {
  const harness = await createDashboardHarness(applicant());
  const menuToggle = harness.elements.get('menuToggleButton');
  const nav = harness.elements.get('primaryNavigation');

  assert.equal(menuToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(menuToggle.getAttribute('aria-controls'), 'primaryNavigation');
  assert.equal(menuToggle.getAttribute('aria-label'), 'Open navigation menu');
  assert.equal(nav.inert, true);
  assert.equal(nav.getAttribute('aria-hidden'), 'true');

  menuToggle.click();
  assert.equal(nav.dataset.open, 'true');
  assert.equal(nav.inert, false);
  assert.equal(nav.getAttribute('aria-hidden'), 'false');
  assert.equal(menuToggle.getAttribute('aria-expanded'), 'true');
  assert.equal(menuToggle.getAttribute('aria-label'), 'Close navigation menu');
  assert.equal(harness.document.activeElement, harness.links[0]);
  assert.equal(harness.links[0].lastFocusOptions.preventScroll, true);
  assert.equal(harness.links[0].getAttribute('aria-current'), 'page');
  assert.equal(harness.links[1].getAttribute('aria-current'), null);

  let prevented = false;
  harness.documentListeners.get('keydown')({
    key: 'Escape',
    preventDefault() {
      prevented = true;
    }
  });

  assert.equal(prevented, true);
  assert.equal(nav.dataset.open, 'false');
  assert.equal(nav.inert, true);
  assert.equal(nav.getAttribute('aria-hidden'), 'true');
  assert.equal(menuToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(harness.document.activeElement, menuToggle);
});

test('clicking outside the mobile drawer closes it', async () => {
  const harness = await createDashboardHarness(applicant());
  const menuToggle = harness.elements.get('menuToggleButton');
  const nav = harness.elements.get('primaryNavigation');

  menuToggle.click();
  harness.documentListeners.get('click')({
    target: harness.elements.get('overview')
  });

  assert.equal(nav.dataset.open, 'false');
  assert.equal(menuToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(nav.inert, true);
});

test('desktop navigation stays visible and keyboard accessible after resizing', async () => {
  const harness = await createDashboardHarness(applicant());
  const nav = harness.elements.get('primaryNavigation');

  harness.window.innerWidth = 1024;
  harness.windowListeners.get('resize')();

  assert.equal(nav.dataset.open, 'false');
  assert.equal(nav.inert, false);
  assert.equal(nav.getAttribute('aria-hidden'), 'false');
});

test('Application navigation focuses its populated details section and closes the menu', async () => {
  const harness = await createDashboardHarness(applicant());
  const menuToggle = harness.elements.get('menuToggleButton');
  const nav = harness.elements.get('primaryNavigation');
  const applicationLink = harness.links[1];

  menuToggle.click();
  applicationLink.click();

  assert.equal(applicationLink.getAttribute('aria-current'), 'page');
  assert.equal(harness.links[0].getAttribute('aria-current'), null);
  assert.equal(nav.dataset.open, 'false');
  assert.equal(harness.document.activeElement, harness.elements.get('application'));
  assert.equal(
    harness.elements.get('applicationTrackValue').textContent,
    'Digital Forensics'
  );
  assert.equal(
    harness.elements.get('applicationReferenceValue').textContent,
    'DF-2026-123'
  );
  assert.equal(
    harness.elements.get('applicantEmailValue').textContent,
    'amina@example.test'
  );

  harness.links[0].click();
  assert.equal(harness.links[0].getAttribute('aria-current'), 'page');
  assert.equal(applicationLink.getAttribute('aria-current'), null);
  assert.equal(
    harness.links.filter((link) => link.getAttribute('aria-current') === 'page').length,
    1
  );
});

test('direct application-section links start with matching navigation state', async () => {
  const harness = await createDashboardHarness(applicant(), '#application');

  assert.equal(harness.links[1].getAttribute('aria-current'), 'page');
  assert.equal(harness.links[0].getAttribute('aria-current'), null);
  assert.equal(
    harness.links.filter((link) => link.getAttribute('aria-current') === 'page').length,
    1
  );

  harness.elements.get('menuToggleButton').click();
  assert.equal(harness.links[1].getAttribute('aria-current'), 'page');
  assert.equal(harness.links[0].getAttribute('aria-current'), null);
});

test('unrecognized section hashes fall back to the Dashboard navigation item', async () => {
  const harness = await createDashboardHarness(applicant(), '#unknown');

  assert.equal(harness.links[0].getAttribute('aria-current'), 'page');
  assert.equal(harness.links[1].getAttribute('aria-current'), null);
  assert.equal(
    harness.links.filter((link) => link.getAttribute('aria-current') === 'page').length,
    1
  );

  harness.location.hash = '#application';
  harness.windowListeners.get('hashchange')();
  assert.equal(harness.links[1].getAttribute('aria-current'), 'page');
  assert.equal(harness.links[0].getAttribute('aria-current'), null);
});

test('dashboard renders pending, failed, initiated, verified, legacy-paid, and unknown states safely', async (t) => {
  const cases = [
    {
      name: 'pending',
      status: 'pending',
      canPay: true,
      paymentLabel: 'Not started',
      paymentAction: true
    },
    {
      name: 'failed',
      status: 'payment_failed',
      canPay: true,
      paymentLabel: 'Payment failed',
      paymentAction: true
    },
    {
      name: 'initiated',
      status: 'payment_initiated',
      canPay: true,
      paymentLabel: 'Verification pending',
      paymentAction: false
    },
    {
      name: 'verified',
      status: 'payment_verified',
      canPay: true,
      paymentLabel: 'Verified',
      paymentAction: false
    },
    {
      name: 'legacy paid',
      status: 'paid',
      canPay: false,
      paymentLabel: 'Verified',
      paymentAction: false
    },
    {
      name: 'unrecognized qualification-like value',
      status: 'disqualified',
      canPay: true,
      paymentLabel: 'Status unavailable',
      paymentAction: false
    }
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const isVerified = ['payment_verified', 'paid'].includes(item.status);
      const harness = await createDashboardHarness(applicant({
        status: item.status,
        canPay: item.canPay,
        amountDue: 1200,
        paymentReference: isVerified ? 'DF-PAY-REFERENCE' : null,
        verifiedTransactionId: isVerified ? 'transaction-456' : null,
        paymentVerificationTimestamp: isVerified
          ? '2026-10-21T12:30:00.000Z'
          : null
      }));

      assert.equal(
        harness.elements.get('paymentStatusValue').textContent,
        item.paymentLabel
      );
      assert.equal(
        harness.elements.get('payNowButton').hidden,
        !item.paymentAction
      );
      assert.equal(
        harness.elements.get('amountValue').textContent,
        'GH₵1,200.00'
      );
      assert.equal(
        harness.elements.get('paymentReferenceItem').hidden,
        !isVerified
      );
      assert.equal(
        harness.elements.get('verifiedTransactionItem').hidden,
        !isVerified
      );
      assert.equal(
        harness.elements.get('paymentVerifiedDateItem').hidden,
        !isVerified
      );
      if (isVerified) {
        assert.equal(
          harness.elements.get('verifiedTransactionValue').textContent,
          'transaction-456'
        );
        assert.notEqual(
          harness.elements.get('paymentVerifiedDateValue').textContent,
          '—'
        );
      }
      if (item.status === 'disqualified') {
        assert.equal(
          harness.elements.get('applicationStatusValue').textContent,
          'Status unavailable'
        );
        assert.doesNotMatch(
          harness.elements.get('paymentAlertText').textContent,
          /disqualified|rejected/i
        );
      }
      assert.equal(harness.elements.has('receiptButton'), false);
    });
  }
});

test('application navigation and footer have real document destinations outside the header', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const css = fs.readFileSync(cssPath, 'utf8');
  const navStart = html.indexOf('<nav class="primary-nav"');
  const navEnd = html.indexOf('</nav>', navStart);
  const mainStart = html.indexOf('<main');
  const mainEnd = html.indexOf('</main>', mainStart);
  const footerStart = html.indexOf('<footer class="dashboard-footer"');

  assert.match(html, /id="menuToggleButton"[^>]*aria-label="Open navigation menu"/s);
  assert.match(html, /aria-expanded="false"[^>]*aria-controls="primaryNavigation"/);
  assert.match(html, /href="#application" data-dashboard-link/);
  assert.ok(html.includes('id="application"'));
  assert.ok(navStart >= 0 && navEnd > navStart);
  assert.ok(mainStart > navEnd);
  assert.ok(footerStart > mainEnd);
  assert.ok(footerStart > navEnd);
  assert.match(html.slice(footerStart), /© 2026 Cybanext\. All rights reserved\./);
  assert.doesNotMatch(html, />\s*(?:Download|Resend)\s+receipt/i);
  assert.doesNotMatch(html, /role="tab"/);
  assert.match(css, /@media \(max-width: 820px\)/);
  assert.match(css, /\.primary-nav\s*\{[^}]*position:\s*fixed;/s);
  assert.match(css, /\.primary-nav\s*\{[^}]*transform:\s*translateX\(100%\);/s);
  assert.match(
    css,
    /\.primary-nav\s*\{[^}]*transition:\s*transform\s+0\.4s\s+cubic-bezier\(\.22,\s*1,\s*\.36,\s*1\)/s
  );
  assert.match(
    css,
    /\.primary-nav\[data-open="true"\]\s*\{[^}]*transform:\s*translateX\(0\);/s
  );
  assert.match(css, /\.menu-toggle\[aria-expanded="true"\].*rotate\(45deg\)/s);
  assert.doesNotMatch(html, /class="nav-item active"/);
  assert.doesNotMatch(css, /\.nav-item\.active/);
  assert.doesNotMatch(css, /\.primary-nav::before/);
  assert.match(
    css,
    /\.primary-nav \.nav-item\[aria-current="page"\]\s*\{[^}]*background:\s*transparent;[^}]*color:\s*var\(--accent\);/s
  );
  assert.match(
    css,
    /\.primary-nav \.nav-item\[aria-current="page"\]::before\s*\{[^}]*position:\s*absolute;[^}]*top:\s*50%;[^}]*left:\s*0\.1rem;[^}]*transform:\s*translateY\(-50%\);/s
  );
  assert.match(
    css,
    /\.primary-nav \.nav-item:focus-visible\s*\{[^}]*outline:\s*2px solid #5f5b5c;/s
  );
  assert.match(
    css,
    /\.summary-grid,\s*\.application-details,\s*\.payment-details\s*\{\s*grid-template-columns:\s*1fr;/s
  );
  assert.doesNotMatch(css, /min-width:\s*320px/);
  assert.doesNotMatch(css, /\.dashboard-footer\s*\{[^}]*position:\s*fixed/s);
});
