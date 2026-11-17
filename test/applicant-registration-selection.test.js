const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.join(__dirname, '..');

class FakeElement {
  constructor() {
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.disabled = false;
    this.innerHTML = '';
    this.classList = {
      toggle() {}
    };
    this.textContent = '';
  }

  addEventListener(name, callback) {
    this.listeners.set(name, callback);
  }

  append(...children) {
    this.children.push(...children);
  }

  appendChild(child) {
    this.children.push(child);
  }
}

test('registration selection is fetched after verification and submits the typed choice to the session endpoint', async () => {
  const elements = new Map([
    ['registrationOptions', new FakeElement()],
    ['selectionMessage', new FakeElement()]
  ]);
  const fetchCalls = [];
  const location = { replacedWith: null, replace(value) { this.replacedWith = value; } };
  const document = {
    getElementById(id) {
      return elements.get(id);
    },
    createElement() {
      return new FakeElement();
    }
  };
  const sandbox = {
    document,
    window: { location },
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url, options });
      if (options.method === 'POST') {
        return {
          status: 200,
          ok: true,
          async json() { return { selected: true }; }
        };
      }
      return {
        status: 200,
        ok: true,
        async json() {
          return {
            authenticated: true,
            selectionRequired: true,
            registrations: [
              {
                applicantType: 'regular_track',
                registrationId: 'RT-123',
                track: 'soc_analyst',
                createdAt: '2026-10-20T12:00:00.000Z'
              },
              {
                applicantType: 'digital_forensics',
                registrationId: 'DF-456',
                track: 'digital_forensics',
                createdAt: '2026-10-21T12:00:00.000Z'
              }
            ]
          };
        }
      };
    }
  };

  const script = fs.readFileSync(
    path.join(root, 'applicant-registration-selection.js'),
    'utf8'
  );
  await vm.runInNewContext(script, sandbox);
  await new Promise((resolve) => setImmediate(resolve));

  const options = elements.get('registrationOptions');
  assert.equal(fetchCalls[0].url, '/api/applicant-session?includeRegistrations=true');
  assert.equal(options.children.length, 2);
  assert.equal(options.children[0].children[0].children[0].textContent, 'SOC Analyst');

  await options.children[0].children[0].listeners.get('click')();

  assert.equal(fetchCalls[1].url, '/api/applicant-session');
  assert.deepEqual(JSON.parse(fetchCalls[1].options.body), {
    action: 'select-registration',
    applicantType: 'regular_track',
    registrationId: 'RT-123'
  });
  assert.equal(location.replacedWith, '/applicant-dashboard.html');
});

test('selection-page identifiers are rendered as text rather than markup', async () => {
  const elements = new Map([
    ['registrationOptions', new FakeElement()],
    ['selectionMessage', new FakeElement()]
  ]);
  const document = {
    getElementById(id) {
      return elements.get(id);
    },
    createElement() {
      return new FakeElement();
    }
  };
  const sandbox = {
    document,
    window: { location: { replace() {} } },
    fetch: async () => ({
      status: 200,
      ok: true,
      async json() {
        return {
          authenticated: true,
          selectionRequired: true,
          registrations: [{
            applicantType: 'regular_track',
            registrationId: '<img src=x>',
            track: 'incident_response',
            createdAt: '2026-10-20T12:00:00.000Z'
          }]
        };
      }
    })
  };

  await vm.runInNewContext(
    fs.readFileSync(path.join(root, 'applicant-registration-selection.js'), 'utf8'),
    sandbox
  );
  await new Promise((resolve) => setImmediate(resolve));

  const button = elements.get('registrationOptions').children[0].children[0];
  assert.equal(button.innerHTML, '');
  assert.match(button.children[1].textContent, /<img src=x>/);
});
