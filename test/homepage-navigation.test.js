const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const source = fs.readFileSync(path.join(root, 'script.js'), 'utf8');

class FakeLink {
  constructor(href, isCurrent) {
    this.attributes = new Map([['href', href]]);
    this.listeners = new Map();
    if (isCurrent) this.attributes.set('aria-current', 'page');
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(name, callback) {
    this.listeners.set(name, callback);
  }

  click() {
    this.listeners.get('click')?.();
  }
}

function createHomepageNavigation(hash = '') {
  const navMarkup = html.match(
    /<nav class="main-nav" id="mainNav">([\s\S]*?)<\/nav>/
  )?.[1];
  assert.ok(navMarkup, 'homepage navigation markup should exist');
  const records = [...navMarkup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)]
    .map(([, attributes, contents]) => ({
      href: attributes.match(/\bhref="([^"]+)"/)?.[1],
      label: navigationLabel(contents),
      current: /\baria-current="page"/.test(attributes)
    }));
  const links = records.map((record) => new FakeLink(record.href, record.current));
  const navClasses = new Set();
  const buttonClasses = new Set();
  const createClassList = (classes) => ({
    toggle(name) {
      if (classes.has(name)) {
        classes.delete(name);
        return false;
      }
      classes.add(name);
      return true;
    },
    add(name) { classes.add(name); },
    remove(name) { classes.delete(name); },
    contains(name) { return classes.has(name); }
  });
  const nav = {
    classList: createClassList(navClasses),
    querySelectorAll(selector) { return selector === 'a' ? links : []; },
    contains(target) { return target === this || links.includes(target); }
  };
  const button = {
    classList: createClassList(buttonClasses),
    attributes: new Map(),
    listeners: new Map(),
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    getAttribute(name) { return this.attributes.get(name) || null; },
    addEventListener(name, callback) { this.listeners.set(name, callback); },
    click() { this.listeners.get('click')?.(); },
    contains(target) { return target === this; }
  };
  const documentListeners = new Map();
  const windowListeners = new Map();
  const document = {
    getElementById(id) {
      if (id === 'mainNav') return nav;
      if (id === 'hamburgerBtn') return button;
      return null;
    },
    addEventListener(name, callback) {
      documentListeners.set(name, callback);
    }
  };
  const window = {
    location: { hash },
    addEventListener(name, callback) {
      windowListeners.set(name, callback);
    }
  };
  const navScriptEnd = source.indexOf('\nconst regularTrackPriceNote');
  assert.notEqual(navScriptEnd, -1, 'homepage navigation script boundary should exist');
  vm.runInNewContext(source.slice(0, navScriptEnd), { document, window });

  return { records, links, nav, button, window, windowListeners };
}

test('homepage navigation keeps one active link in sync with the current hash', () => {
  const navigation = createHomepageNavigation();
  const currentLinks = () =>
    navigation.links.filter((link) => link.getAttribute('aria-current') === 'page');

  assert.equal(currentLinks().length, 1);
  assert.equal(navigation.records[navigation.links.indexOf(currentLinks()[0])].label, 'Home');

  navigation.window.location.hash = '#about';
  navigation.windowListeners.get('hashchange')();
  assert.equal(currentLinks().length, 1);
  assert.equal(navigation.records[navigation.links.indexOf(currentLinks()[0])].label, 'About');

  navigation.window.location.hash = '#unknown';
  navigation.windowListeners.get('hashchange')();
  assert.equal(currentLinks().length, 0);

  navigation.window.location.hash = '';
  navigation.windowListeners.get('hashchange')();
  assert.equal(currentLinks().length, 1);
  assert.equal(navigation.records[navigation.links.indexOf(currentLinks()[0])].label, 'Home');
});

test('hamburger navigation preserves destinations and closes after an in-page selection', () => {
  const navigation = createHomepageNavigation();
  assert.deepEqual(
    navigation.records.map(({ href }) => href),
    ['#', '#tracks', '#about', '#contact', 'blog/', 'applicant-login.html']
  );
  assert.equal(navigation.records[5].label, 'Applicant Login');

  navigation.button.click();
  assert.equal(navigation.nav.classList.contains('open'), true);
  assert.equal(navigation.button.getAttribute('aria-expanded'), 'true');
  const aboutLink = navigation.links.find((link) => link.getAttribute('href') === '#about');
  aboutLink.click();

  assert.equal(navigation.nav.classList.contains('open'), false);
  assert.equal(navigation.button.getAttribute('aria-expanded'), 'false');
  assert.equal(aboutLink.getAttribute('aria-current'), 'page');
  assert.equal(
    navigation.links.filter((link) => link.getAttribute('aria-current') === 'page').length,
    1
  );
});

test('mobile active indicator is attached to the current link and focus styling remains distinct', () => {
  assert.doesNotMatch(css, /\.main-nav(?:\.open)?::before/);
  assert.match(
    css,
    /\.main-nav a\[aria-current="page"\]::before\s*\{[^}]*top:\s*50%;[^}]*transform:\s*translateY\(-50%\);/s
  );
  assert.match(css, /\.main-nav a:focus-visible\s*\{[^}]*outline:/s);
  assert.deepEqual(
    navigationCurrentLabels(),
    ['Home']
  );
});

function navigationCurrentLabels() {
  const navMarkup = html.match(
    /<nav class="main-nav" id="mainNav">([\s\S]*?)<\/nav>/
  )?.[1];
  return [...navMarkup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)]
    .filter(([, attributes]) => /\baria-current="page"/.test(attributes))
    .map(([, , contents]) => navigationLabel(contents));
}

function navigationLabel(contents) {
  return contents
    .replace(/<span class="nav-number">[\s\S]*?<\/span>/, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}
