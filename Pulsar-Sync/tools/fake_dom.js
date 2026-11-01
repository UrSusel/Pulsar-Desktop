/**
 * Minimalny DOM dla testów panelu ustawień: odtwarza strukturę, jakiej używa
 * runtime Pulsara (#settingsMenu → .sm-nav + #smBody → .sm-pane), plus tyle
 * selektorów, ile potrzebuje drive-sync.js. Bez zależności zewnętrznych.
 */

const VOID_TAGS = new Set(['input', 'br', 'hr', 'img', 'meta', 'link']);

function matches(element, selector) {
  if (selector === '*') return true;
  const pattern = /^([a-zA-Z]*)((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/.exec(selector);
  if (!pattern) return false;
  const [, tag, classes, attrs] = pattern;
  if (tag && element.tagName.toLowerCase() !== tag.toLowerCase()) return false;
  for (const cls of (classes.match(/\.[\w-]+/g) || [])) {
    if (!element.classList.contains(cls.slice(1))) return false;
  }
  for (const attr of (attrs.match(/\[[^\]]+\]/g) || [])) {
    const inner = attr.slice(1, -1);
    const eq = inner.indexOf('=');
    if (eq === -1) {
      if (!element.hasAttribute(inner)) return false;
    } else {
      const name = inner.slice(0, eq);
      const value = inner.slice(eq + 1).replace(/^["']|["']$/g, '');
      if (element.getAttribute(name) !== value) return false;
    }
  }
  return true;
}

class FakeClassList {
  constructor(element) { this.element = element; this.set = new Set(); }
  add(...names) { names.forEach((name) => this.set.add(name)); }
  remove(...names) { names.forEach((name) => this.set.delete(name)); }
  contains(name) { return this.set.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : !!force;
    if (on) this.set.add(name); else this.set.delete(name);
    return on;
  }
  get value() { return Array.from(this.set).join(' '); }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName || 'div').toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.classList = new FakeClassList(this);
    this.style = {};
    this.listeners = new Map();
    this._text = '';
    this.value = '';
    this.dataset = new Proxy({}, {
      get: (_target, prop) => {
        const name = 'data-' + String(prop).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
        return this.attributes.has(name) ? this.attributes.get(name) : undefined;
      },
      set: (_target, prop, value) => {
        const name = 'data-' + String(prop).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
        this.attributes.set(name, String(value));
        return true;
      },
      has: (_target, prop) => this.attributes.has('data-' + String(prop).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())),
    });
  }
  set className(value) {
    this.classList.set = new Set(String(value).split(/\s+/).filter(Boolean));
  }
  get className() { return this.classList.value; }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'class') this.className = value;
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() {
    if (this.children.length) return this.children.map((child) => child.textContent).join('');
    return this._text;
  }
  set innerHTML(html) {
    this.children = [];
    this._text = '';
    const stack = [this];
    const tokens = String(html).split(/(<[^>]+>)/).filter((token) => token !== '');
    for (const token of tokens) {
      if (token.startsWith('</')) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      if (token.startsWith('<')) {
        const name = /^<([a-zA-Z][\w-]*)/.exec(token);
        if (!name) continue;
        const element = new FakeElement(name[1]);
        const attrPattern = /([a-zA-Z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;
        let attr;
        while ((attr = attrPattern.exec(token))) element.setAttribute(attr[1], attr[2]);
        stack[stack.length - 1].appendChild(element);
        if (!VOID_TAGS.has(name[1].toLowerCase()) && !token.endsWith('/>')) stack.push(element);
        continue;
      }
      const text = token.trim();
      if (text) stack[stack.length - 1]._text += text;
    }
  }
  get innerHTML() { return ''; }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  dispatchEvent(event) {
    (this.listeners.get(event.type) || []).forEach((handler) => handler(event));
    return true;
  }
  /** Klik jak od użytkownika: zdarzenie bąbelkuje do przodków. */
  click() {
    let node = this;
    while (node) {
      node.dispatchEvent({ type: 'click', target: this });
      node = node.parentNode;
    }
  }
  change(value) {
    if (value !== undefined) {
      if (String(this.getAttribute('type') || '') === 'checkbox') this.checked = !!value;
      else this.value = value;
    }
    let node = this;
    while (node) {
      node.dispatchEvent({ type: 'change', target: this });
      node = node.parentNode;
    }
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      node.children.forEach((child) => {
        if (matches(child, selector)) out.push(child);
        walk(child);
      });
    };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  contains(node) {
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }
}

/** Struktura ustawień taka, jak w runtime: .sm-nav z zakładkami i #smBody z pane'ami. */
function makeSettingsDom() {
  const body = new FakeElement('body');
  const settingsMenu = new FakeElement('div');
  settingsMenu.setAttribute('id', 'settingsMenu');
  body.appendChild(settingsMenu);

  const side = new FakeElement('div');
  side.setAttribute('class', 'sm-side');
  settingsMenu.appendChild(side);
  const nav = new FakeElement('div');
  nav.setAttribute('class', 'sm-nav');
  side.appendChild(nav);

  const main = new FakeElement('div');
  main.setAttribute('class', 'sm-main');
  settingsMenu.appendChild(main);
  const search = new FakeElement('input');
  search.setAttribute('id', 'smSearch');
  search.setAttribute('type', 'search');
  main.appendChild(search);
  const smBody = new FakeElement('div');
  smBody.setAttribute('class', 'sm-body');
  smBody.setAttribute('id', 'smBody');
  main.appendChild(smBody);

  // Panele runtime'u mieszkają w smBody, a nie bezpośrednio w menu.
  ['play', 'look', 'lib'].forEach((pane, index) => {
    const tab = new FakeElement('button');
    tab.setAttribute('class', 'sm-tab');
    tab.setAttribute('data-pane', pane);
    nav.appendChild(tab);
    const panel = new FakeElement('div');
    panel.setAttribute('class', index === 0 ? 'sm-pane active' : 'sm-pane');
    panel.setAttribute('data-pane', pane);
    smBody.appendChild(panel);
  });

  return { body, settingsMenu, nav, smBody, search };
}

function findById(root, id) {
  if (root.getAttribute && root.getAttribute('id') === id) return root;
  for (const child of root.children) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

function makeDocument(dom) {
  const document = {
    readyState: 'complete',
    body: dom.body,
    createElement: (tag) => new FakeElement(tag),
    getElementById: (id) => findById(dom.body, id),
    querySelector: (selector) => dom.body.querySelector(selector),
    querySelectorAll: (selector) => dom.body.querySelectorAll(selector),
    addEventListener() {},
    dispatchEvent() {},
  };
  return document;
}

module.exports = { FakeElement, makeSettingsDom, makeDocument, matches, findById };
