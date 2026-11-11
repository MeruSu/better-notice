// test/classify.test.mjs — runs the real client.js in Node against stubs.
// Covers the settings seam, the pure seat-plan builder, and the tab-row adapter.
import assert from 'node:assert/strict';

const DICT = {
  'tab.untitled': '未命名会话',
  'tab.placeholder': '正在切换…',
  'tab.error': '切换失败',
  'tab.failed': '上次运行失败：',
  'settings.nav': '热表',
  'settings.title': '热表',
};

const stateUpdates = [];
const ReactStub = {
  createElement: (type, props, children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, (next) => { stateUpdates.push(next); }],
  useEffect: (fn) => { fn(); },
};

class MemoryStorage {
  constructor(entries = {}) {
    this.map = new Map(Object.entries(entries));
  }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
}

const storage = new MemoryStorage({
  'dsh.conversation.session-a': JSON.stringify({ view: 'seat-session-a' }),
  'dsh.conversation.session-b': JSON.stringify({ view: 'hotlist-seat-session-b' }),
  'dsh.conversation.session-c': JSON.stringify({ view: 'session-switcher' }),
  'dsh.conversation.session-d': JSON.stringify({ view: 'chat' }),
  'dsh.conversation.session-e': JSON.stringify({ view: 'trajectory' }),
  'unrelated.key': 'keep me',
});
globalThis.localStorage = storage;

let rowWidth = 2000;

function descendants(node) {
  const found = [];
  for (const child of node.children) {
    found.push(child);
    found.push(...descendants(child));
  }
  return found;
}

function matchesSelector(element, selector) {
  return selector.split(',').some((part) => {
    let rest = part.trim();
    let tag = null;
    const attributes = [];
    const classes = [];
    while (rest.length > 0) {
      if (rest.startsWith('[')) {
        const end = rest.indexOf(']');
        const body = rest.slice(1, end);
        rest = rest.slice(end + 1);
        const prefixed = body.indexOf('^=');
        const equals = body.indexOf('=');
        if (prefixed > 0) {
          attributes.push([body.slice(0, prefixed), '^=', body.slice(prefixed + 2).replace(/^"|"$/g, '')]);
        } else if (equals > 0) {
          attributes.push([body.slice(0, equals), '=', body.slice(equals + 1).replace(/^"|"$/g, '')]);
        } else attributes.push([body, '', '']);
      } else if (rest.startsWith('.')) {
        const match = /^\.([a-zA-Z][a-zA-Z0-9_-]*)/.exec(rest);
        if (match === null) return false;
        classes.push(match[1]);
        rest = rest.slice(match[0].length);
      } else {
        const match = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(rest);
        if (match === null) return false;
        tag = match[0].toUpperCase();
        rest = rest.slice(match[0].length);
      }
    }
    if (tag !== null && element.tagName !== tag) return false;
    const own = String(element.className || '').split(/\s+/).filter(Boolean);
    if (classes.every((name) => own.includes(name)) === false) return false;
    return attributes.every(([name, operator, value]) => {
      if (!element.hasAttribute(name)) return false;
      if (operator === '=') return element.getAttribute(name) === value;
      if (operator === '^=') return element.getAttribute(name).startsWith(value);
      return true;
    });
  });
}

const el = (tagName) => {
  const classes = new Set();
  const attributes = new Map();
  const node = {
    tagName: tagName.toUpperCase(),
    id: '',
    dataset: null,
    children: [],
    attributes,
    className: '',
    textContent: '',
    parentNode: null,
    style: {
      animation: '',
      display: '',
      setProperty(name, value) { this[name] = value; },
      removeProperty(name) { this[name] = ''; },
    },
    classList: {
      add(...names) { for (const name of names) classes.add(name); },
      remove(...names) { for (const name of names) classes.delete(name); },
      contains(name) { return classes.has(name); },
      toggle(name, force) { if (force === false) classes.delete(name); else classes.add(name); },
    },
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; },
    hasAttribute(name) { return this.attributes.has(name); },
    removeAttribute(name) { this.attributes.delete(name); },
    appendChild(child) { child.parentNode = node; node.children.push(child); return child; },
    insertBefore(child, reference) {
      const at = node.children.indexOf(reference);
      child.parentNode = node;
      if (at < 0) node.children.push(child);
      else node.children.splice(at, 0, child);
      return child;
    },
    removeChild(child) {
      const at = node.children.indexOf(child);
      if (at >= 0) node.children.splice(at, 1);
      child.parentNode = null;
      return child;
    },
    remove() { node.parentNode?.removeChild(node); },
    addEventListener() {},
    removeEventListener() {},
    getAnimations() { return []; },
    getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0 }; },
    querySelector(selector) { return node.querySelectorAll(selector)[0] ?? null; },
    querySelectorAll(selector) { return descendants(node).filter((candidate) => matchesSelector(candidate, selector)); },
    get parentElement() { return node.parentNode; },
    get isConnected() { return true; },
    get offsetWidth() { return 0; },
  };
  /** `dataset` mirrors real DOM behaviour: writing a key writes a `data-*` attribute. */
  node.dataset = new Proxy({}, {
    get: (_, name) => attributes.get(`data-${String(name).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`),
    set: (_, name, value) => {
      attributes.set(`data-${String(name).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, String(value));
      return true;
    },
    deleteProperty: (_, name) => {
      attributes.delete(`data-${String(name).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
      return true;
    },
  });
  return node;
};

const html = el('html');
const head = el('head');
html.appendChild(head);
const body = el('body');
html.appendChild(body);
const tree = el('div');
tree.setAttribute('role', 'tree');
body.appendChild(tree);
const tabBox = el('div');
Object.defineProperty(tabBox, 'clientWidth', { get: () => rowWidth });
const tabRow = el('div');
tabRow.setAttribute('data-conversation-tabs', '');
tabBox.appendChild(tabRow);
body.appendChild(tabBox);

function sidebarRow(sessionId, titleText, options = {}) {
  const row = el('div');
  row.setAttribute('role', 'treeitem');
  row.setAttribute('data-row-key', `session:${sessionId}`);
  const slot = el('span');
  if (options.nativeDot === true) {
    const dot = el('span');
    dot.setAttribute('data-state', 'running');
    slot.appendChild(dot);
  }
  row.appendChild(slot);
  const title = el('span');
  title.className = 'wnFoaW_title';
  title.textContent = titleText;
  row.appendChild(title);
  const resting = el('span');
  resting.className = 'wnFoaW_rowResting';
  const time = el('span');
  time.textContent = '2分钟';
  resting.appendChild(time);
  row.appendChild(resting);
  let dsmDot = null;
  if (options.dsmDot === true) {
    dsmDot = el('span');
    dsmDot.setAttribute('data-dsm-dot', '');
    row.appendChild(dsmDot);
  }
  tree.appendChild(row);
  return { row, slot, title, dsmDot };
}

function clearSidebarRows() {
  tree.children.length = 0;
}

/** Adapters from earlier groups may leave their own `<style>` blocks behind; each group starts clean. */
function clearStyleBlocks() {
  for (const style of head.querySelectorAll('[data-hotlist-style]')) style.remove();
}

globalThis.document = {
  documentElement: html,
  head,
  body,
  hidden: false,
  createElement: el,
  getElementById: (id) => descendants(html).find((node) => node.id === id || node.getAttribute('id') === id) ?? null,
  querySelector: (selector) => html.querySelector(selector),
  querySelectorAll: (selector) => html.querySelectorAll(selector),
  addEventListener() {},
  removeEventListener() {},
};

const windowListeners = new Map();
const win = {
  devicePixelRatio: 2,
  matchMedia: (query) => ({ media: query, matches: false, addEventListener() {}, removeEventListener() {} }),
  addEventListener(type, handler) { windowListeners.set(type, handler); },
  removeEventListener(type) { windowListeners.delete(type); },
};
globalThis.window = win;
document.defaultView = win;

const loaded = {};
win.__ModuleLoader__ = {
  load(spec) {
    loaded.id = spec.id;
    const requireModule = (name) => {
      if (name === 'react') return ReactStub;
      throw new Error(`unexpected module: ${name}`);
    };
    requireModule.asset = (ref) => `asset:${ref}`;
    loaded.api = spec.factory(requireModule);
  },
};

const { readFile } = await import('node:fs/promises');
const source = await readFile(new URL('./../client.js', import.meta.url), 'utf8');
new Function(source)();

const api = loaded.api;
assert.equal(loaded.id, '@merusu/dsh-better-notice');
assert.ok(api && typeof api.apply === 'function');

const tick = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const NOW = 1_800_000_000_000;
const TTL = 7 * 60 * 1000;
const DEFAULTS = api.readSettings();

function store(initial) {
  let value = initial;
  const subscribers = new Set();
  return {
    getSnapshot: () => value,
    set(next) {
      value = next;
      for (const subscriber of [...subscribers]) subscriber();
    },
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
  };
}

function session(fields) {
  return {
    id: fields.id,
    displayTitle: fields.displayTitle ?? `会话 ${fields.id}`,
    running: fields.running ?? false,
    blank: fields.blank ?? false,
    updatedAt: fields.updatedAt ?? NOW - 60_000,
    retainedBy: fields.retainedBy ?? {},
    ...fields,
  };
}

function planInput(overrides = {}) {
  return {
    list: { ids: [], byId: {} },
    statuses: new Map(),
    errors: new Map(),
    completedAt: new Map(),
    entered: new Map(),
    currentId: undefined,
    workspaceIds: null,
    now: NOW,
    limit: 20,
    ...overrides,
  };
}

function createCtx({ list, statuses = new Map(), groups, workspace, binding = () => undefined, without = [] }) {
  /** `phase` is part of the real list snapshot: only 'ready' means every row has landed. */
  const listStore = store({ phase: 'ready', ...list });
  const statusStore = store(statuses);
  const groupStore = store(groups);
  const entries = new Map();
  const opened = [];
  const activated = [];
  const registrations = [];
  const remoteHandlers = new Map();
  const effects = [];
  let cleanup = () => {};
  /** Every `slots.inject` callback owns a disposer; all of them run on teardown, newest first. */
  const injected = [];
  let mutations = 0;
  /** Every disposer (slot injection or soft dependency) unwinds newest first. */
  const track = (dispose) => {
    injected.push(dispose ?? (() => {}));
    cleanup = () => {
      for (let index = injected.length - 1; index >= 0; index -= 1) injected[index]();
      injected.length = 0;
      for (let index = effects.length - 1; index >= 0; index -= 1) effects[index]();
      effects.length = 0;
    };
  };
  /** `shortcuts`: the only soft dependency; the plugin must work without it too. */
  const shortcutRegistrations = [];
  let shortcutInput = null;
  const shortcuts = {
    describeBinding: ({ code, modifiers }) => ({ keys: [...(modifiers ?? []), code].join('+') }),
    registerFixed: (spec) => {
      shortcutRegistrations.push(spec);
      return () => {
        const index = shortcutRegistrations.indexOf(spec);
        if (index !== -1) shortcutRegistrations.splice(index, 1);
      };
    },
    observeFixedInput: (handler) => {
      shortcutInput = handler;
      return () => { shortcutInput = null; };
    },
  };
  const services = {
    shortcuts,
    sessions: { list: listStore, binding: (id) => binding(id) },
    uiSession: { sessionStatus: statusStore },
    uiWorkspace: {
      workspaces: { list: groupStore },
      openSession: (id) => {
        opened.push(id);
        return workspace === undefined ? Promise.resolve() : workspace(id);
      },
    },
    uiConversation: {
      binding: (id) => ({ activate: (viewId) => { activated.push([id, viewId]); } }),
    },
  };
  for (const name of without) delete services[name];
  const ctx = {
    get: (name) => services[name],
    locale: { register: () => () => {}, bind: () => (key) => DICT[key] ?? key },
    remote: {
      $on: (event, handler) => {
        remoteHandlers.set(event, handler);
        return () => remoteHandlers.delete(event);
      },
    },
    effect: (fn) => {
      const dispose = fn();
      effects.push(dispose ?? (() => {}));
      return () => {};
    },
    /** Soft dependency resolution; the callback receives only what it asked for. */
    inject: (deps, callback) => {
      const scope = {};
      for (const dep of deps) scope[dep] = services[dep];
      track(callback(scope));
      return () => {};
    },
    slots: {
      register: (spec, Component) => {
        mutations += 1;
        /** The nav icon lives in another slot with the same id; the registry is per slot. */
        if (spec.name === 'settings.section.icon') {
          registrations.push(`${spec.name}:${spec.id}`);
          return () => { mutations += 1; };
        }
        entries.set(spec.id, { order: spec.order, label: typeof spec.label === 'function' ? spec.label() : spec.label, Component });
        registrations.push(spec.id);
        return () => {
          mutations += 1;
          entries.delete(spec.id);
        };
      },
      inject: (key, callback) => {
        track(callback());
        return () => {};
      },
    },
  };
  return {
    ctx,
    listStore,
    statusStore,
    groupStore,
    entries,
    opened,
    activated,
    registrations,
    remoteHandlers,
    effects,
    shortcuts,
    shortcutRegistrations,
    /** Feed one key event into the registered observeFixedInput handler. */
    dispatchShortcut: (input) => {
      if (shortcutInput === null) return false;
      shortcutInput(input);
      return true;
    },
    mutations: () => mutations,
    cleanup: () => cleanup(),
  };
}

function orders(entries) {
  return [...entries.entries()]
    .filter(([id]) => id.startsWith('hotlist-seat-'))
    .map(([id, entry]) => [id.replace('hotlist-seat-', ''), entry.order])
    .sort((left, right) => left[1] - right[1]);
}

function textOf(element) {
  if (typeof element === 'string') return element;
  if (element === null || element === undefined || typeof element !== 'object') return '';
  const children = element.children;
  if (Array.isArray(children)) return children.map(textOf).join('');
  if (children !== undefined) return textOf(children);
  return '';
}

/** Every element of a rendered tree, depth first (React.Stub elements are plain objects). */
function walk(element, visit) {
  if (Array.isArray(element)) {
    element.forEach((child) => walk(child, visit));
    return;
  }
  if (element === null || element === undefined || typeof element !== 'object') return;
  visit(element);
  walk(element.children, visit);
}

let groups = 0;

function test(name, fn) {
  try {
    fn();
    groups += 1;
    console.log(`ok ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    groups += 1;
    console.log(`ok ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

console.log(`node ${process.version}`);

// 1. View preferences left behind by an older seat are healed at load time.
test('heal view preferences', () => {
  assert.equal(JSON.parse(storage.getItem('dsh.conversation.session-a')).view, 'chat');
  assert.deepEqual(JSON.parse(storage.getItem('dsh.conversation.session-b')), { view: 'chat' });
  assert.equal(JSON.parse(storage.getItem('dsh.conversation.session-c')).view, 'chat');
  assert.equal(JSON.parse(storage.getItem('dsh.conversation.session-d')).view, 'chat');
  assert.equal(JSON.parse(storage.getItem('dsh.conversation.session-e')).view, 'trajectory');
  assert.equal(storage.getItem('unrelated.key'), 'keep me');
});

// 2. The v5 settings shape: seven categories, global collect/overlay/pinned; a v3-shaped patch still works.
test('settings read/write', () => {
  assert.equal(DEFAULTS.version, 4);
  assert.deepEqual(DEFAULTS.positions, { tab: true, topbar: false, sidebar: true });
  assert.deepEqual(Object.keys(DEFAULTS.categories).sort(), [
    'completed', 'error', 'idle', 'pending', 'pinned', 'running',
  ]);
  assert.equal(DEFAULTS.categories.pending.glyph.value, '🔐');
  assert.equal(DEFAULTS.categories.pending.glyphSecondary.value, '❓');
  assert.equal(DEFAULTS.categories.idle.enabled, true);
  assert.equal(DEFAULTS.categories.idle.surfaces.tab, true);
  assert.equal(DEFAULTS.categories.idle.surfaces.sidebar, true);
  assert.equal(DEFAULTS.collect.completedTtlMs, TTL);
  assert.equal(DEFAULTS.pinned.maxSeats, 3);
  assert.deepEqual(DEFAULTS.overlay, { side: 'auto', sizeMin: 260, sizeMax: 520, fallbackImage: '' });
  assert.deepEqual(DEFAULTS.sound, { volume: 60 });
  assert.equal('states' in DEFAULTS, false);
  assert.equal('showIdle' in DEFAULTS, false);
  assert.equal('placement' in DEFAULTS, false);
  assert.equal('enabled' in DEFAULTS.overlay, false);

  const written = api.writeSettings({ maxSeats: 40, pinned: { maxSeats: 99 } });
  assert.equal(written.maxSeats, 12);
  assert.equal(written.pinned.maxSeats, 12);
  api.writeSettings({ maxSeats: 6 });
  api.writeSettings({ pinned: { maxSeats: 3 } });

  /** The v3 page still speaks eight states and one overlay flag; those patches land on categories. */
  const legacy = api.writeSettings({ showIdle: true, completedTtlMs: 300000 });
  assert.equal(legacy.categories.idle.enabled, true);
  assert.equal(legacy.collect.completedTtlMs, 300000);
  const glyphs = api.writeSettings({ states: { approval: { value: '🔔' }, question: { value: '🙋' } } });
  assert.equal(glyphs.categories.pending.glyph.value, '🔔');
  assert.equal(glyphs.categories.pending.glyphSecondary.value, '🙋');
  const reset = api.resetSettings();
  assert.equal(reset.categories.idle.enabled, true);
  assert.equal(reset.categories.pending.glyph.value, '🔐');
});

// 3. v3 storage migrates in one pass: eight states -> categories, overlay.enabled -> popout, old keys removed.
test('migrate v3 to v4', () => {
  const legacyImage = 'data:image/png;base64,AAAA';
  storage.setItem('dsh.hotlist.settings.v1', JSON.stringify({
    version: 3,
    maxSeats: 40,
    completedTtlMs: 120000,
    showIdle: true,
    positions: { tab: false, topbar: false, sidebar: true },
    states: {
      approval: { kind: 'emoji', value: '🔔', motion: 'pulse', motionTarget: 'glyph' },
      question: { kind: 'emoji', value: '🙋' },
      'plan-review': { kind: 'emoji', value: '📝' },
      running: { kind: 'emoji', value: '🏃', motion: 'spin' },
      subagents: { kind: 'emoji', value: '🧵' },
      completed: { kind: 'img', value: legacyImage },
      error: { kind: 'emoji', value: '💥', motion: 'bounce' },
      idle: { kind: 'emoji', value: '🌙' },
    },
    overlay: { enabled: true, side: 'left', scale: 4, shortcut: 'Alt+X', source: 'custom', customImage: legacyImage },
  }));
  const migrated = api.readSettings();
  assert.equal(migrated.version, 4);
  assert.equal(migrated.maxSeats, 12);
  assert.equal(migrated.collect.completedTtlMs, 120000);
  assert.deepEqual(migrated.positions, { tab: false, topbar: false, sidebar: true });
  assert.equal(migrated.categories.pending.glyph.value, '🔔');
  assert.equal(migrated.categories.pending.glyph.motion, 'pulse');
  assert.equal(migrated.categories.pending.glyphSecondary.value, '🙋');
  assert.equal(migrated.categories.running.glyph.value, '🏃');
  assert.equal(migrated.categories.running.glyph.motion, 'spin');
  assert.equal(migrated.categories.completed.glyph.kind, 'img');
  /** A v3 inline picture becomes the first entry of the v4.2 pool, not a lone value. */
  assert.equal(migrated.categories.completed.glyph.uploads.length, 1);
  assert.equal(migrated.categories.completed.glyph.uploads[0].dataUrl, legacyImage);
  assert.equal(migrated.categories.completed.glyph.uploads[0].name, 'legacy');
  /** `value` is the emoji slot now, so it comes back as the category default. */
  assert.equal(migrated.categories.completed.glyph.value, '✅');
  assert.equal(migrated.categories.completed.glyph.source, 'upload');
  assert.equal(migrated.categories.error.glyph.value, '💥');
  assert.equal(migrated.categories.idle.glyph.value, '🌙');
  assert.equal(migrated.categories.idle.enabled, true);
  assert.equal(migrated.overlay.side, 'left');
  assert.equal(migrated.overlay.sizeMin, 260);
  assert.equal(migrated.overlay.sizeMax, 900);
  assert.equal(migrated.overlay.fallbackImage, legacyImage);
  assert.equal(migrated.shortcuts.overlayKey, 'Alt+X');
  assert.equal(migrated.categories.pending.popout.enabled, true);
  assert.equal(migrated.categories.error.popout.enabled, true);
  assert.equal(migrated.categories.running.popout.enabled, true);
  /** Written back under the current key and without the v3 vocabulary, then stable on a second read. */
  const stored = JSON.parse(storage.getItem('dsh.hotlist.settings.v1'));
  assert.equal(stored.version, 4);
  assert.equal('states' in stored, false);
  assert.equal('glyphs' in stored, false);
  assert.equal('motion' in stored, false);
  assert.equal('placement' in stored, false);
  const again = api.readSettings();
  assert.deepEqual(again, migrated);
  storage.removeItem('dsh.hotlist.settings.v1');
  api.resetSettings();
});

// 4. Current-version storage keeps its custom order; the alpha build's stray `version: 5` normalizes safely.
test('current version keeps custom order', () => {
  const v4 = api.defaultSettings();
  v4.version = 4;
  v4.categories.error.order = 5;
  v4.categories.idle.enabled = true;
  storage.setItem('dsh.hotlist.settings.v1', JSON.stringify(v4));
  const migrated = api.readSettings();
  assert.equal(migrated.version, 4);
  assert.equal(migrated.categories.error.order, 5);
  assert.equal(migrated.categories.idle.enabled, true);
  storage.removeItem('dsh.hotlist.settings.v1');
  api.resetSettings();
});

// 4b. The alpha build wrote `version: 5` before the phantom hop was removed; such an object
//     falls through the v3 migration and comes back as a clean v4 record instead of throwing.
test('alpha version 5 normalizes safely', () => {
  storage.setItem('dsh.hotlist.settings.v1', JSON.stringify({
    ...api.defaultSettings(),
    version: 5,
    categories: { error: { order: 5 } },
  }));
  const normalized = api.readSettings();
  assert.equal(normalized.version, 4);
  assert.equal(normalized.categories.error.order, 5);
  assert.equal(normalized.maxSeats, 6);
  storage.removeItem('dsh.hotlist.settings.v1');
  api.resetSettings();
});

// 5. Bad values fall back one field at a time; an unknown category is dropped, never thrown.
test('bad data falls back', () => {
  storage.setItem('dsh.hotlist.settings.v1', JSON.stringify({
    version: 'five',
    maxSeats: 'many',
    positions: { tab: 'yes' },
    overlay: { side: 'up', scale: 99, fallbackImage: 'data:image/svg+xml;base64,PHN2Zz4=' },
    collect: { completedTtlMs: -5 },
    pinned: { maxSeats: 400 },
    categories: {
      pending: { order: 500, glyph: { kind: 'animated', value: 'x.gif' }, glyphSecondary: { value: '🎉' } },
      nope: { enabled: true },
      favorite: { enabled: true, glyph: { value: '🔥' } },
      error: { glyph: { value: 'overlongemoji' } },
    },
  }));
  const settings = api.readSettings();
  assert.equal(settings.version, 4);
  assert.equal(settings.maxSeats, 6);
  assert.deepEqual(settings.positions, { tab: true, topbar: false, sidebar: true });
  assert.equal(settings.overlay.side, 'auto');
  assert.equal(settings.overlay.sizeMax, 900);
  assert.equal(settings.overlay.fallbackImage, '');
  assert.equal(settings.collect.completedTtlMs, 60000);
  assert.equal(settings.pinned.maxSeats, 12);
  assert.equal(settings.categories.pending.order, 99);
  assert.equal(settings.categories.pending.glyph.kind, 'emoji');
  /** `kind` follows the pool now, and a non-image `value` is plain glyph text. */
  assert.equal(settings.categories.pending.glyph.value, 'x.gif');
  assert.equal(settings.categories.pending.glyph.uploads.length, 0);
  /** Text longer than the eight-character limit is dropped, so the default glyph draws instead. */
  assert.equal(settings.categories.error.glyph.value, '');
  assert.equal(settings.categories.pending.glyphSecondary.value, '🎉');
  assert.equal('nope' in settings.categories, false);
  /** v4.6.2 retired the favorite category: a stored copy is dropped, not kept as a future key. */
  assert.equal('favorite' in settings.categories, false);
  assert.equal(String(storage.getItem('dsh.betterNotice.preserved.v1') ?? '').includes('categories.favorite'), false);
  storage.removeItem('dsh.hotlist.settings.v1');
  api.resetSettings();
});

// 6. Six categories, one session each; `idle` obeys its window.
test('seven categories', () => {
  const settings = api.defaultSettings();
  settings.categories.idle.enabled = true;
  settings.pinned.maxSeats = 3;
  const ids = ['session-pinned', 'session-approval', 'session-error', 'session-finished', 'session-running', 'session-idle'];
  const byId = {
    'session-pinned': session({ id: 'session-pinned', updatedAt: NOW - 60 * 60_000 }),
    'session-approval': session({ id: 'session-approval' }),
    'session-error': session({ id: 'session-error' }),
    'session-finished': session({ id: 'session-finished' }),
    'session-running': session({ id: 'session-running', running: true }),
    'session-idle': session({ id: 'session-idle', updatedAt: NOW - 4 * 60_000 }),
  };
  const statuses = new Map([
    ['session-approval', { pendingInteraction: { kind: 'approval' } }],
    ['session-running', { running: true }],
  ]);
  const errors = new Map([['session-error', { message: 'boom', at: NOW }]]);
  const completedAt = new Map([['session-finished', NOW - 1000]]);
  const rows = api.classify(settings, {
    surface: 'sidebar',
    list: { ids, byId },
    statuses,
    errors,
    completedAt,
    now: NOW,
    workspaceIds: null,
    pinnedSessionIds: ['session-pinned'],
  });
  const found = Object.fromEntries(rows.map((row) => [row.sessionId, `${row.category}:${row.token}`]));
  assert.equal(found['session-pinned'], 'pinned:pinned');
  assert.equal(found['session-approval'], 'pending:approval');
  assert.equal(found['session-error'], 'error:error');
  assert.equal(found['session-finished'], 'completed:completed');
  assert.equal(found['session-running'], 'running:running');
  assert.equal(found['session-idle'], 'idle:idle');

  /** Idle is a window, not a flag: five minutes in, yes; one second later, no. */
  const inside = api.classify(settings, {
    surface: 'sidebar',
    list: { ids: ['session-idle-at'], byId: { 'session-idle-at': session({ id: 'session-idle-at', updatedAt: NOW - 5 * 60_000 }) } },
    statuses: new Map(),
    errors: new Map(),
    completedAt: new Map(),
    now: NOW,
    workspaceIds: null,
  });
  assert.deepEqual(inside.map((row) => row.category), ['idle']);
  const outside = api.classify(settings, {
    surface: 'sidebar',
    list: { ids: ['session-idle-at'], byId: { 'session-idle-at': session({ id: 'session-idle-at', updatedAt: NOW - 5 * 60_000 - 1 }) } },
    statuses: new Map(),
    errors: new Map(),
    completedAt: new Map(),
    now: NOW,
    workspaceIds: null,
  });
  assert.deepEqual(outside, []);
});

// 7. Pending merges approval and question into one category with two glyphs; subagents fold into running.
test('pending merge and subagents', () => {
  const settings = api.defaultSettings();
  const list = {
    ids: ['a', 'q', 'p', 'parent'],
    byId: {
      a: session({ id: 'a' }),
      q: session({ id: 'q' }),
      p: session({ id: 'p' }),
      parent: session({ id: 'parent', running: false }),
    },
    projectionsBySession: { parent: { values: { subagentCatalog: [{ id: 'child' }] } } },
  };
  const statuses = new Map([
    ['a', { pendingInteraction: { kind: 'approval' } }],
    ['q', { pendingInteraction: { kind: 'question' } }],
    ['p', { pendingInteraction: { kind: 'plan-review' } }],
    ['child', { running: true }],
  ]);
  const rows = api.classify(settings, {
    surface: 'tab', list, statuses, errors: new Map(), completedAt: new Map(), now: NOW, workspaceIds: null,
  });
  const tokens = Object.fromEntries(rows.map((row) => [row.sessionId, `${row.category}:${row.token}`]));
  assert.equal(tokens.a, 'pending:approval');
  assert.equal(tokens.q, 'pending:question');
  assert.equal(tokens.p, 'pending:question');
  assert.equal(tokens.parent, 'running:running');
  assert.equal(rows.filter((row) => row.category === 'pending').length, 3);
});

// 8. Pinned rows follow the store list (most recent first) and sit in their own order block.
test('pinned first', () => {
  const settings = api.defaultSettings();
  /** The workspace store, most recently pinned first: `pinLevel` is index + 1. */
  const pinnedSessionIds = ['s1', 's3'];
  const list = {
    ids: ['s1', 's2', 's3'],
    byId: { s1: session({ id: 's1' }), s2: session({ id: 's2', running: true }), s3: session({ id: 's3' }) },
  };
  const plan = api.buildSeatPlan({
    surface: 'tab',
    list,
    statuses: new Map([['s2', { running: true }]]),
    errors: new Map(),
    completedAt: new Map(),
    now: NOW,
    workspaceIds: null,
    limit: 5,
    pinnedSessionIds,
  }, settings);
  assert.deepEqual(plan.map((seat) => [seat.sessionId, seat.order]), [['s1', 1501], ['s3', 1502], ['s2', 3001]]);
  assert.deepEqual(plan.map((seat) => seat.token), ['pinned', 'pinned', 'running']);
});

// 9. Category order is configurable and drives both the sequence and the seat order numbers.
test('category order', () => {
  const settings = api.defaultSettings();
  settings.categories.error.order = 5;
  settings.categories.pending.order = 20;
  const list = {
    ids: ['err', 'ask'],
    byId: { err: session({ id: 'err' }), ask: session({ id: 'ask' }) },
  };
  const plan = api.buildSeatPlan({
    surface: 'tab',
    list,
    statuses: new Map([['ask', { pendingInteraction: { kind: 'approval' } }]]),
    errors: new Map([['err', { message: 'boom', at: NOW }]]),
    completedAt: new Map(),
    now: NOW,
    workspaceIds: null,
    limit: 5,
  }, settings);
  assert.deepEqual(plan.map((seat) => [seat.sessionId, seat.order]), [['err', 501], ['ask', 2001]]);
});

// 10. The plan keeps user-facing categories and fills the rest up to `limit`; the current session never gets a seat.
test('plan limit and current session', () => {
  const settings = api.defaultSettings();
  const list = {
    ids: ['ask', 'err1', 'err2', 'run1', 'run2', 'me'],
    byId: {
      ask: session({ id: 'ask' }),
      err1: session({ id: 'err1' }),
      err2: session({ id: 'err2' }),
      run1: session({ id: 'run1', running: true }),
      run2: session({ id: 'run2', running: true }),
      me: session({ id: 'me' }),
    },
  };
  const statuses = new Map([
    ['ask', { pendingInteraction: { kind: 'approval' } }],
    ['run1', { running: true }],
    ['run2', { running: true }],
  ]);
  const errors = new Map([['err1', { message: 'a', at: NOW }], ['err2', { message: 'b', at: NOW }]]);
  const plan = api.buildSeatPlan({
    surface: 'tab', list, statuses, errors, completedAt: new Map(), now: NOW, workspaceIds: null, limit: 2,
  }, settings);
  assert.deepEqual(plan.map((seat) => seat.category), ['error', 'error', 'pending', 'running', 'running']);
  /** `me` is still inside the idle window, so it is classified but cut by the limit. */
  assert.equal(plan.overflow, 1);
  const withCurrent = api.buildSeatPlan({
    surface: 'tab', list, statuses, errors, completedAt: new Map(), now: NOW, workspaceIds: null, limit: 5, currentId: 'ask',
  }, settings);
  assert.equal(withCurrent.some((seat) => seat.sessionId === 'ask'), false);
});

// 10b. Urgent categories may exceed `maxSeats`, but only by ALWAYS_OVERFLOW (4); the rest are counted.
test('urgent overflow hard cap', () => {
  const settings = api.defaultSettings();
  const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
  const list = { ids, byId: {} };
  const statuses = new Map();
  for (const [index, id] of ids.entries()) {
    list.byId[id] = session({ id, updatedAt: NOW - index * 1000 });
    statuses.set(id, { pendingInteraction: { kind: 'approval' } });
  }
  const plan = api.buildSeatPlan({
    surface: 'tab', list, statuses, errors: new Map(), completedAt: new Map(), now: NOW, workspaceIds: null, limit: 1,
  }, settings);
  assert.equal(plan.length, 5);
  assert.equal(plan.overflow, 2);
  assert.deepEqual(plan.map((seat) => seat.sessionId), ['p1', 'p2', 'p3', 'p4', 'p5']);
});

// 11. A surface that is off produces no rows; turning `idle.tab` off keeps the sidebar row.
test('surface gating', () => {
  const settings = api.defaultSettings();
  settings.categories.idle.surfaces = { tab: false, sidebar: true, topbar: false };
  const list = { ids: ['idle1', 'run1'], byId: { idle1: session({ id: 'idle1' }), run1: session({ id: 'run1', running: true }) } };
  const tab = api.buildSeatPlan({
    surface: 'tab', list, statuses: new Map([['run1', { running: true }]]), errors: new Map(), completedAt: new Map(), now: NOW, workspaceIds: null, limit: 5,
  }, settings);
  assert.deepEqual(tab.map((seat) => seat.sessionId), ['run1']);
  const sidebar = api.classify(settings, {
    surface: 'sidebar', list, statuses: new Map([['run1', { running: true }]]), errors: new Map(), completedAt: new Map(), now: NOW, workspaceIds: null,
  });
  assert.deepEqual(sidebar.map((row) => row.sessionId).sort(), ['idle1', 'run1']);
  /** Every surface off is the same as "hide", not a fallback to the tab row. */
  const off = api.sanitizeSettings({ ...settings, positions: { tab: false, topbar: false, sidebar: false } });
  assert.equal(api.positionsOf(off).allPositionsOff, true);
  assert.equal(api.positionsOf(off).surfaceVisible, false);
});

// 11b. `idle` keeps its tab seat by default: the third tier is what the user asked for in the tab row.
test('idle third tier on the tab row', () => {
  const settings = api.defaultSettings();
  assert.equal(settings.categories.idle.surfaces.tab, true);
  assert.equal(settings.collect.recentWindowMinutes, 5);
  const list = { ids: ['plain'], byId: { plain: session({ id: 'plain' }) } };
  const input = {
    surface: 'tab', list, statuses: new Map(), errors: new Map(), completedAt: new Map(), now: NOW, workspaceIds: null, limit: 5,
  };
  const rows = api.classify(settings, input);
  assert.deepEqual(rows.map((row) => [row.sessionId, row.category]), [['plain', 'idle']]);
  /** `recentWindowMinutes: 0` closes the window, so the same session gets no row. */
  assert.deepEqual(api.classify(api.sanitizeSettings({ ...settings, collect: { recentWindowMinutes: 0 } }), input), []);
  /** The user can still mute the third tier on the tab row only. */
  const muted = api.sanitizeSettings({ ...settings, categories: { idle: { surfaces: { tab: false } } } });
  assert.deepEqual(api.classify(muted, input), []);
});

// 12. Labels use the token's emoji; an uploaded glyph falls back to that category's emoji.
test('labels', () => {
  const settings = api.defaultSettings();
  const t = (key) => DICT[key] ?? key;
  assert.equal(api.labelOf(t, { token: 'approval', title: '写入工作区外审批' }, settings), '🔐 写入工作区外审批');
  assert.equal(api.labelOf(t, { token: 'question', title: '选一个' }, settings), '❓ 选一个');
  assert.equal(api.labelOf(t, { token: null, title: '' }, settings), '未命名会话');
  settings.categories.pending.glyph = { ...settings.categories.pending.glyph, kind: 'img', value: 'data:image/png;base64,AAAA' };
  assert.equal(api.labelOf(t, { token: 'approval', title: 'x' }, settings), '🔐 x');
});

// 13. The sidebar token honors pins, category surfaces and the idle window.
test('sidebar priority', () => {
  const settings = api.defaultSettings();
  settings.categories.idle.enabled = true;
  const base = { settings, now: NOW, completedAt: undefined, error: undefined, children: 0 };
  const row = session({ id: 'x', updatedAt: NOW - 60_000 });
  assert.equal(api.sidebarStateOf({ ...base, session: row, status: { pendingInteraction: { kind: 'approval' } } }), 'approval');
  assert.equal(api.sidebarStateOf({ ...base, session: row, status: { pendingInteraction: { kind: 'plan-review' } } }), 'question');
  assert.equal(api.sidebarStateOf({ ...base, session: row, status: { running: true } }), 'running');
  assert.equal(api.sidebarStateOf({ ...base, session: row, status: undefined, pinned: true }), 'pinned');
  /** Only `idle` ranks below a pin: a run or a finish still owns the row. */
  assert.equal(api.sidebarStateOf({ ...base, session: row, status: { running: true }, pinned: true }), 'running');
  assert.equal(api.sidebarStateOf({ ...base, session: row, status: { completionUnread: true }, pinned: true }), 'completed');
  assert.equal(api.sidebarStateOf({ ...base, session: row, status: undefined, pinned: true, error: { message: 'x', at: NOW } }), 'error');
  assert.equal(api.sidebarStateOf({ ...base, session: row, status: { completionUnread: true } }), 'completed');
  assert.equal(api.sidebarStateOf({ ...base, session: row, status: undefined }), 'idle');
  const old = session({ id: 'y', updatedAt: NOW - 5 * 60_000 - 1 });
  assert.equal(api.sidebarStateOf({ ...base, session: old, status: undefined }), null);
  settings.categories.running.surfaces.sidebar = false;
  assert.equal(api.sidebarStateOf({ ...base, session: row, status: { running: true } }), 'idle');
  assert.equal(api.sidebarStateOf({ ...base, session: row, status: { running: true, pendingInteraction: { kind: 'approval' } } }), 'approval');
});

// 14. Sanitizing: image whitelist, motion names, overlay steps, popout/sound/within/pins ranges.
test('settings sanitizing', () => {
  const sanitized = api.sanitizeSettings({
    maxSeats: 'auto',
    categories: {
      pending: {
        glyph: { kind: 'img', value: 'data:image/gif;base64,xx' },
        glyphSecondary: { kind: 'img', value: 'data:image/svg+xml;base64,PHN2Zz4=' },
        popout: { displayMs: 123456, entrance: 'nope', ambient: 'float', exit: 'fade', side: 'right' },
        sound: { kind: 'chime2', volume: 400, enabled: true, src: 'data:audio/mpeg;base64,AAAA' },
      },
      error: { glyph: { motion: 'wiggle' }, sound: { kind: 'beep' } },
    },
    collect: { recentWindowMinutes: 500 },
    overlay: { scale: 2.5, side: 'right' },
  });
  assert.equal(sanitized.maxSeats, 'auto');
  assert.equal(sanitized.categories.pending.glyph.kind, 'img');
  assert.equal(sanitized.categories.pending.glyphSecondary.kind, 'emoji');
  assert.equal(sanitized.categories.pending.glyphSecondary.value, '');
  assert.equal(sanitized.categories.pending.popout.displayMs, 20000);
  assert.equal(sanitized.categories.pending.popout.entrance, 'slide');
  assert.equal(sanitized.categories.pending.popout.ambient, 'float');
  assert.equal(sanitized.categories.pending.popout.exit, 'fade');
  assert.equal(sanitized.categories.pending.sound.enabled, true);
  /** v4.2 has no sound kinds: a legacy `kind` only decides built-in versus uploaded. */
  assert.equal('kind' in sanitized.categories.pending.sound, false);
  assert.equal(sanitized.categories.pending.sound.builtin, true);
  assert.equal(sanitized.categories.pending.sound.uploads.length, 0);
  assert.equal('volume' in sanitized.categories.pending.sound, false);
  assert.equal(sanitized.sound.volume, 100);
  assert.equal(sanitized.collect.recentWindowMinutes, 120);
  assert.equal(sanitized.categories.error.glyph.motion, 'bounce');
  assert.equal(sanitized.categories.error.sound.enabled, true);
  /** A v3 zoom multiplier has no v4.1 counterpart: both size fields keep their defaults. */
  assert.equal(sanitized.overlay.sizeMin, 260);
  assert.equal(sanitized.overlay.sizeMax, 520);
  assert.equal(sanitized.overlay.side, 'right');
  /** `pinned` is an ordinary class now: order 15, not a forced 0. */
  assert.equal(api.sanitizeSettings({ pinLevels: {} }).categories.pinned.order, 15);
  const noOverlayEnabled = api.sanitizeSettings({ overlay: { enabled: true } });
  assert.equal('enabled' in noOverlayEnabled.overlay, false);
});

// 15. Settings surface: one object, override works, and the v3 view is projected from v5.
test('settings surface', () => {
  assert.equal(typeof win.__HOTLIST_SETTINGS__.get, 'function');
  const overridden = api.overrideSettings({ maxSeats: 9 });
  assert.equal(overridden.maxSeats, 9);
  const projected = win.__HOTLIST_SETTINGS__.get();
  assert.equal(projected.categories.pending.glyph.value, '🔐');
  assert.equal(api.overrideSettings(null).maxSeats, 6);
  storage.removeItem('dsh.hotlist.settings.v1');
  storage.setItem('dsh.session-switcher.settings', JSON.stringify({ version: 3, maxSeats: 3 }));
  const migrated = api.readSettings();
  assert.equal(migrated.maxSeats, 3);
  assert.equal(storage.getItem('dsh.session-switcher.settings'), null);
  storage.removeItem('dsh.hotlist.settings.v1');
  api.resetSettings();
  storage.setItem('dsh.session-switcher.settings', JSON.stringify({ maxSeats: 4, showIdle: true }));
  api.resetSettings();
  storage.removeItem('dsh.session-switcher.settings');
});

// 16. Seat adapter: seats appear/disappear, the click handler opens the session, a rejection is shown.
await testAsync('adapter plan', async () => {
  rowWidth = 2000;
  const ids = ['s1', 's2', 's3'];
  const byId = {
    s1: session({ id: 's1', updatedAt: NOW - 60_000 }),
    /** Epoch-old activity: outside the idle window no matter which clock the adapter reads. */
    s2: session({ id: 's2', updatedAt: 1000 }),
    s3: session({ id: 's3', blank: true, updatedAt: NOW - 90_000 }),
  };
  const list = { ids, byId };
  /** Idle is sidebar-only by default; turn its tab surface on so the third row has a seat to compare. */
  api.overrideSettings({ categories: { idle: { surfaces: { tab: true } } } });
  const harness = createCtx({
    list,
    statuses: new Map([['s2', { running: true }]]),
    groups: { items: [{ workspaceId: 'w1', sessionIds: ids }], archivedSessionIds: [] },
  });
  api.apply(harness.ctx, {});
  await tick();
  const seats = () => orders(harness.entries);
  assert.deepEqual(seats(), [['s2', 3001], ['s1', 5001]]);
  const registrations = harness.registrations.length;

  /** A settings write through the public surface recomputes seats immediately. */
  win.__HOTLIST_SETTINGS__.set({ categories: { running: { surfaces: { tab: false } } } });
  await tick();
  assert.deepEqual(seats(), [['s1', 5001]]);
  win.__HOTLIST_SETTINGS__.set({ categories: { running: { surfaces: { tab: true } } } });
  await tick();
  assert.deepEqual(seats(), [['s2', 3001], ['s1', 5001]]);

  /** Clicking a seat opens that session and falls back to `chat` on both sides. */
  const entry = harness.entries.get('hotlist-seat-s1');
  const element = entry.Component({ sessionId: 's2' });
  const tree = typeof element.type === 'function' ? element.type(element.props) : element;
  let host = null;
  walk(tree, (node) => {
    if (host === null && node.props && node.props['data-hotlist-seat'] !== undefined) host = node;
  });
  assert.ok(host !== null);
  host.props.onClick({ preventDefault() {} });
  await sleep(10);
  /** Both the mount effect and the pointer handler may ask for the switch; the call is idempotent. */
  assert.deepEqual([...new Set(harness.opened)], ['s1']);
  assert.ok(harness.opened.length >= 1);
  assert.deepEqual(harness.activated.map((pair) => pair[1]).slice(0, 3), ['chat', 'chat', 'chat']);

  /** A rejected switch shows a message instead of throwing. */
  harness.cleanup();
  const rejecting = createCtx({
    list,
    statuses: new Map(),
    groups: { items: [{ workspaceId: 'w1', sessionIds: ids }], archivedSessionIds: [] },
    workspace: () => Promise.reject(new Error('nope')),
  });
  api.apply(rejecting.ctx, {});
  await tick();
  const seat = rejecting.entries.get('hotlist-seat-s1').Component({ sessionId: 's2' });
  const node2 = typeof seat.type === 'function' ? seat.type(seat.props) : seat;
  let host2 = null;
  walk(node2, (item) => {
    if (host2 === null && item.props && item.props['data-hotlist-seat'] !== undefined) host2 = item;
  });
  host2.props.onClick({ preventDefault() {} });
  await sleep(10);
  assert.ok(stateUpdates.some((value) => value === 'nope' || (value && value.message === 'nope')));
  rejecting.cleanup();
});

// 17. Sidebar markers: one host per row, right glyph, idempotent, fully removed on stop.
test('adapter sidebar markers', () => {
  clearSidebarRows();
  const ask = sidebarRow('session-ask', '写入工作区外审批', { nativeDot: true, dsmDot: true });
  const run = sidebarRow('session-run', '跑任务', { nativeDot: true });
  const settings = api.defaultSettings();
  settings.categories.idle.enabled = true;
  settings.takeOverStatusDot = true;
  const adapter = api.createSidebarAdapter({
    document: globalThis.document,
    readSettings: () => settings,
    readSession: (sessionId) => ({
      session: session({ id: sessionId, at: NOW }),
      status: sessionId === 'session-ask'
        ? { pendingInteraction: { kind: 'approval' } }
        : { running: true },
      error: undefined,
      completedAt: undefined,
      pinned: false,
      children: 0,
    }),
  });
  adapter.start();
  const marker = ask.row.children.find((child) => child.hasAttribute('data-hotlist-glyph'));
  assert.ok(marker !== undefined);
  assert.equal(marker.getAttribute('data-hotlist-char'), '🔐');
  assert.equal(ask.row.getAttribute('data-hotlist-hide-native'), '');
  assert.equal(run.row.children.find((child) => child.hasAttribute('data-hotlist-glyph')).getAttribute('data-hotlist-char'), '⏳');
  adapter.refresh();
  assert.equal(ask.row.children.filter((child) => child.hasAttribute('data-hotlist-glyph')).length, 1);
  adapter.stop();
  assert.equal(ask.row.children.some((child) => child.hasAttribute('data-hotlist-glyph')), false);
  assert.equal(ask.row.hasAttribute('data-hotlist-hide-native'), false);
  clearSidebarRows();
});

// 18. Takeover gate: the style block and the inline dot hide exist only while the flag is on.
// 17b. The sidebar must see what the tab row sees: a pin and a parent waiting on children.
test('adapter sidebar pinned and children', () => {
  clearSidebarRows();
  clearStyleBlocks();
  const pinnedRow = sidebarRow('session-pin', '置顶会话');
  const parentRow = sidebarRow('session-parent', '父会话');
  const settings = api.defaultSettings();
  const adapter = api.createSidebarAdapter({
    document: globalThis.document,
    readSettings: () => settings,
    readSession: (sessionId) => ({
      session: session({ id: sessionId }),
      status: {},
      error: undefined,
      completedAt: undefined,
      pinned: sessionId === 'session-pin',
      children: sessionId === 'session-parent' ? 2 : 0,
    }),
  });
  adapter.start();
  const charOf = (row) => row.children
    .find((child) => child.hasAttribute('data-hotlist-glyph'))
    ?.getAttribute('data-hotlist-char');
  assert.equal(charOf(pinnedRow.row), '📌');
  assert.equal(charOf(parentRow.row), '⏳');
  adapter.stop();
  clearSidebarRows();
});

test('takeover gate', () => {
  clearSidebarRows();
  clearStyleBlocks();
  const row = sidebarRow('session-run', '跑任务', { nativeDot: true, dsmDot: true });
  const settings = api.defaultSettings();
  const adapter = api.createSidebarAdapter({
    document: globalThis.document,
    readSettings: () => settings,
    readSession: (sessionId) => ({
      session: session({ id: sessionId }),
      status: { running: true },
      error: undefined,
      completedAt: undefined,
      pinned: false,
      children: 0,
    }),
  });
  adapter.start();
  const styles = head.querySelectorAll('[data-hotlist-style]');
  const takeover = styles.filter((style) => style.getAttribute('data-hotlist-style') === 'takeover');
  assert.equal(takeover.length, 1);
  assert.equal(row.dsmDot.style.display, 'none');
  settings.takeOverStatusDot = false;
  adapter.refresh();
  assert.equal(head.querySelectorAll('[data-hotlist-style="takeover"]').length, 0);
  assert.equal(row.dsmDot.style.display, '');
  adapter.stop();
  clearSidebarRows();
});

// 19. Every generated style block is valid CSS text (no `[[`), and stop() leaves nothing behind.
test('styles stay valid', () => {
  clearSidebarRows();
  sidebarRow('session-run', '跑任务', { nativeDot: true, dsmDot: true });
  const settings = api.defaultSettings();
  const adapter = api.createSidebarAdapter({
    document: globalThis.document,
    readSettings: () => settings,
    readSession: (sessionId) => ({ session: session({ id: sessionId }), status: { running: true }, error: undefined, completedAt: undefined, pinned: false, children: 0 }),
  });
  adapter.start();
  for (const style of head.querySelectorAll('[data-hotlist-style]')) {
    assert.equal(style.textContent.includes('[['), false);
  }
  adapter.stop();
  assert.equal(head.querySelectorAll('[data-hotlist-style]').length, 0);
  clearSidebarRows();
});

// 20. The settings page: nav entry, one collapsed card per category in draw order, chips, global rows.
function renderPage(t = (key) => DICT[key] ?? key) {
  const harness = createCtx({ list: { ids: [], byId: {} }, statuses: new Map(), groups: { items: [], archivedSessionIds: [] } });
  api.apply(harness.ctx, {});
  const entry = harness.entries.get('hotlist');
  let page = entry.Component({ close() {}, t });
  if (typeof page.type === 'function') page = page.type(page.props);
  return { harness, entry, page };
}

function collect(page, predicate) {
  const found = [];
  walk(page, (node) => {
    if (node.props !== undefined && predicate(node.props) === true) found.push(node);
  });
  return found;
}

test('settings page', () => {
  const seen = [];
  const harness = createCtx({ list: { ids: [], byId: {} }, statuses: new Map(), groups: { items: [], archivedSessionIds: [] } });
  const register = harness.ctx.slots.register;
  harness.ctx.slots.register = (spec, Component) => {
    if (spec.name === 'settings.section') seen.push([spec.id, spec.order]);
    return register(spec, Component);
  };
  api.apply(harness.ctx, {});
  assert.deepEqual(seen, [['hotlist', 30]]);
  const entry = harness.entries.get('hotlist');
  assert.equal(entry.label, '热表');
  let page = entry.Component({ close() {}, t: (key) => DICT[key] ?? key });
  if (typeof page.type === 'function') page = page.type(page.props);
  assert.equal(page.props['data-hotlist-settings'], 'v4.6.3');

  const rows = collect(page, (props) => typeof props['data-hotlist-row'] === 'string')
    .map((node) => node.props['data-hotlist-row']);
  for (const key of [
    'maxSeats', 'pinned.maxSeats', 'collect.completedTtlMs', 'sound.volume', 'recentWindow',
    'positions.tab', 'positions.topbar',
    'takeOverStatusDot',
  ]) {
    assert.equal(rows.includes(key), true, `missing row ${key}`);
  }
  /** v4.4 and v4.5 removed these rows: the fields survive for compatibility, the controls do not. */
  for (const key of ['hideNativeDot', 'shortcuts.jumpEnabled', 'shortcuts.overlayEnabled', 'shortcuts.keys', 'reset', 'within', 'overlay.size']) {
    assert.equal(rows.includes(key), false, `removed row ${key} is still rendered`);
  }
  for (const category of ['pinned', 'error', 'pending', 'completed', 'running', 'idle']) {
    assert.equal(rows.includes(`categories.${category}`), true, `missing card ${category}`);
  }
  assert.equal(rows.includes('categories.favorite'), false, 'the retired favorite card is gone');

  const cards = collect(page, (props) => typeof props['data-category'] === 'string')
    .map((node) => node.props['data-category']);
  assert.deepEqual(cards, ['error', 'pending', 'pinned', 'completed', 'running', 'idle']);
  assert.equal(collect(page, (props) => props['data-hotlist-card-body'] !== undefined).length, 0);

  const chips = collect(page, (props) => props.className === 'hl-chip');
  assert.equal(chips.length, 30);
  for (const chip of chips) {
    assert.equal(typeof chip.props['aria-label'], 'string');
    assert.equal(['true', 'false'].includes(chip.props['data-on']), true);
  }
  /** `topbar` is announced but not implemented: its chip is always off and disabled. */
  const topbar = chips.filter((chip) => chip.props['data-disabled'] === 'true');
  assert.equal(topbar.length, 6);
  assert.equal(topbar.every((chip) => chip.props['data-on'] === 'false'), true);

  /** Position chips point at the global block instead of pretending to be clickable. */
  for (const chip of chips.filter((node) => ['Tab', '栏', '顶'].includes(node.props['aria-label']))) {
    assert.equal(chip.props.title, 'settings.chip.positionHint');
  }
  /** The scripting surface sits next to the settings one, both bound to the same store. */
  assert.equal(typeof win.__HOTLIST__.settings.set, 'function');
  assert.deepEqual(win.__HOTLIST__.assets.list('pending', 'glyph'), []);
  assert.equal(win.__HOTLIST__.assets.add('pending', 'nope', { dataUrl: '' }).reason, 'invalid');
  harness.cleanup();
});

// 21. Cards follow the configured draw order, not the constant order.
test('settings page card order', () => {
  api.overrideSettings({ categories: { error: { order: 5 } } });
  const { harness, page } = renderPage();
  const cards = collect(page, (props) => typeof props['data-category'] === 'string')
    .map((node) => node.props['data-category']);
  /** `error` now asks for 5, so it leads the tie-break group; `pinned` sits at 15, after both. */
  assert.deepEqual(cards.slice(0, 3), ['error', 'pending', 'pinned']);
  assert.equal(cards[cards.length - 1], 'idle');
  harness.cleanup();
  api.overrideSettings(null);
});

// 23. v4.4 dropped the overflow notice: the plan still counts, nothing on the page shows it.
test('settings page overflow notice', () => {
  assert.equal(typeof api.publishOverflow, 'undefined', 'the overflow channel went with the notice');
  assert.equal(typeof api.currentOverflow, 'undefined');
  assert.equal(typeof api.onOverflowChange, 'undefined');
  const harness = renderPage();
  const notices = collect(harness.page, (props) => props['data-hotlist-overflow'] !== undefined);
  assert.equal(notices.length, 0);
  assert.equal(textOf(harness.page).includes('settings.overflow'), false);
  harness.harness.cleanup();

  /** The plan still reports how many rows the limit hid, so nothing was lost under the notice. */
  const ids = ['a', 'b', 'c'];
  const byId = {};
  for (const id of ids) byId[id] = session({ id });
  const plan = api.buildSeatPlan({
    surface: 'tab', list: { ids, byId }, statuses: new Map(), errors: new Map(), completedAt: new Map(), now: NOW, workspaceIds: null, limit: 1,
  }, api.defaultSettings());
  assert.equal(plan.overflow, 2);
});

// 24. Upload gate: type whitelist first, source size second, 16KB after re-encoding.
test('settings upload gate', () => {
  assert.equal(api.glyphUploadReject(null), 'missing');
  assert.equal(api.glyphUploadReject({ type: 'image/svg+xml', size: 100 }), 'type');
  assert.equal(api.glyphUploadReject({ type: 'image/gif', size: 100 }), null);
  assert.equal(api.glyphUploadReject({ type: 'image/webp', size: 5 * 1024 * 1024 }), 'size');
  /** 24000 base64 chars decode to ~18000 bytes: above GLYPH_MAX_BYTES, so the glyph falls back to emoji. */
  const oversized = `data:image/png;base64,${'A'.repeat(24000)}`;
  const sanitized = api.sanitizeSettings({ categories: { running: { glyph: { kind: 'img', value: oversized } } } });
  assert.equal(sanitized.categories.running.glyph.kind, 'emoji');
  assert.equal(sanitized.categories.running.glyph.value, '');
});

// 25. Reset writes a clean v4 record: no v3 keys survive.
test('settings reset drops legacy keys', () => {
  storage.setItem('dsh.hotlist.settings.v1', JSON.stringify({
    version: 4,
    maxSeats: 3,
    states: { approval: { value: 'X' } },
    glyphs: { approval: { emoji: 'X' } },
    motion: { approval: 'pulse' },
    placement: 'tabs',
    showIdle: true,
  }));
  api.readSettings();
  api.writeSettings({ maxSeats: 9 });
  api.resetSettings();
  const stored = JSON.parse(storage.getItem('dsh.hotlist.settings.v1'));
  assert.equal(stored.version, 4);
  assert.equal(stored.maxSeats, 6);
  for (const key of ['states', 'glyphs', 'motion', 'placement', 'showIdle']) {
    assert.equal(key in stored, false, `legacy key ${key} survived`);
  }
});

// 26. `maxSeats` reaches the seat plan on the same settings write, no reload.
await testAsync('settings maxSeats applies at once', async () => {
  rowWidth = 2000;
  /** A real write (not an override, which would shadow later writes): idle needs a tab surface to have seats. */
  api.writeSettings({ maxSeats: 6, categories: { idle: { surfaces: { tab: true } } } });
  const ids = ['m1', 'm2', 'm3'];
  const byId = {};
  for (const id of ids) byId[id] = session({ id, updatedAt: NOW - 60_000 });
  const harness = createCtx({
    list: { ids, byId },
    statuses: new Map(),
    groups: { items: [{ workspaceId: 'w1', sessionIds: ids }], archivedSessionIds: [] },
  });
  api.apply(harness.ctx, {});
  await tick();
  assert.equal(orders(harness.entries).length, 3);

  win.__HOTLIST_SETTINGS__.set({ maxSeats: 2 });
  /** Dropping a seat goes through the two-stage deferred dispose, so wait it out. */
  await tick();
  await tick();
  assert.equal(orders(harness.entries).length, 2);

  win.__HOTLIST_SETTINGS__.set({ maxSeats: 6 });
  await tick();
  await tick();
  assert.equal(orders(harness.entries).length, 3);
  harness.cleanup();
  api.resetSettings();
});

/** Popout controller fixture: settings are a plain object so a test can flip one field. */
function popoutHarness(adjust) {
  const settings = JSON.parse(JSON.stringify(api.defaultSettings()));
  for (const category of ['error', 'pending', 'completed']) settings.categories[category].popout.enabled = true;
  if (typeof adjust === 'function') adjust(settings);
  const events = [];
  const controller = api.createPopoutController({
    getSettings: () => settings,
    openSession: (id) => events.push(['open', id]),
    isCurrent: (id) => id === 'me',
    asset: (ref) => `asset:${ref}`,
    log: () => {},
  });
  return { settings, events, controller, shell: () => document.body.querySelector('[data-hotlist-popout]') };
}

test('popout side resolution', () => {
  assert.equal(api.resolvePopoutSide('left', document), 'left');
  assert.equal(api.resolvePopoutSide('right', document), 'right');
  assert.equal(api.resolvePopoutSide('auto', document), 'left', 'no session column → left edge');

  const column = el('div');
  column.className = 'mP3x-q_sidebarCol';
  Object.defineProperty(column, 'getBoundingClientRect', { value: () => ({ width: 240, height: 800 }) });
  body.appendChild(column);
  assert.equal(api.resolvePopoutSide('auto', document), 'right', 'session column takes the left edge');
  column.remove();

  const narrow = el('div');
  narrow.className = 'mP3x-q_sidebarCol';
  Object.defineProperty(narrow, 'getBoundingClientRect', { value: () => ({ width: 0, height: 0 }) });
  body.appendChild(narrow);
  assert.equal(api.resolvePopoutSide('auto', document), 'left', 'a collapsed column does not count');
  narrow.remove();

  assert.equal(api.tierFor(260, 1), 320);
  assert.equal(api.tierFor(260, 3), 780);
  assert.equal(api.tierFor(780, 3), 1560);
  assert.equal(api.assetRef('error', 320), 'plugins/@merusu/dsh-better-notice/assets/error-320.webp');
  assert.equal(api.fallbackRef('error'), 'plugins/@merusu/dsh-better-notice/assets/error.svg');
  assert.equal(api.dropDistance(400), 184);
});

test('popout priority arbitration', () => {
  const harness = popoutHarness();
  const { controller } = harness;
  assert.equal(controller.offer('completed', 'other', NOW), true);
  assert.equal(controller.showing().category, 'completed');
  assert.equal(controller.offer('pending', 'other', NOW + 1), true, 'pending preempts completed');
  assert.equal(controller.showing().category, 'pending');
  assert.equal(controller.offer('error', 'other', NOW + 2), true, 'error preempts pending');
  assert.equal(controller.showing().category, 'error');
  assert.equal(controller.offer('pending', 'other2', NOW + 3), false, 'a lower priority is dropped, never queued');
  assert.equal(controller.showing().category, 'error');
  assert.equal(controller.offer('error', 'other3', NOW + 4), true, 'the same priority takes the slot');
  assert.equal(controller.showing().sessionId, 'other3');
  controller.destroy();
});

test('popout seq guard', () => {
  const harness = popoutHarness((settings) => {
    settings.categories.pending.popout.displayMs = 2000;
  });
  const { controller } = harness;
  const timers = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  /** Fake timers make the guard observable without waiting 2 s. */
  globalThis.setTimeout = (fn, ms) => {
    timers.push({ fn, ms, cleared: false });
    return timers.length;
  };
  globalThis.clearTimeout = (handle) => {
    const timer = timers[handle - 1];
    if (timer !== undefined) timer.cleared = true;
  };
  try {
    assert.equal(controller.offer('pending', 'other', NOW), true);
    const pendingTimers = timers.filter((timer) => timer.ms === 2000 && timer.cleared === false);
    assert.equal(pendingTimers.length, 1, 'the displayMs timer is scheduled');
    assert.equal(controller.offer('error', 'other2', NOW + 1), true);
    /** The stale timer must never close the overlay that replaced it. */
    for (const timer of pendingTimers) timer.fn();
    assert.equal(controller.showing().category, 'error');
    assert.equal(controller.showing().sessionId, 'other2');
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    controller.destroy();
  }
});

test('popout reduce merge', () => {
  const harness = popoutHarness((settings) => {
    settings.display.reduceMotion = 'on';
  });
  assert.equal(harness.controller.offer('pending', 'other', NOW), true);
  const shell = harness.shell();
  assert.ok(shell);
  assert.equal(shell.dataset.reduceMotion, '1', 'the product setting forces the downgrade');
  assert.equal(shell.dataset.hotlistPopoutCat, 'pending');
  assert.equal(shell.style['--hl-enter-ms'], '120ms', 'the entrance runs at the reduce duration');
  /** The kit chooses fade for the exit only when the caller reports reduce. */
  harness.controller.dismiss();
  assert.equal(shell.classList.contains('exit-fade'), true, 'a reduced exit is always the short fade');
  assert.equal(shell.classList.contains('exit-drop'), false);
  harness.controller.destroy();

  const auto = popoutHarness();
  assert.equal(auto.controller.offer('pending', 'other', NOW), true);
  assert.equal(auto.shell().dataset.reduceMotion, '0', 'OS preference false → normal motion');
  auto.controller.destroy();
});

test('popout cooldown', () => {
  const harness = popoutHarness();
  const { controller } = harness;
  assert.equal(controller.offer('pending', 'same', NOW), true);
  controller.dismiss();
  assert.equal(controller.offer('pending', 'same', NOW + 9_999), false, 'inside the 10 s window');
  assert.equal(controller.showing(), null);
  assert.equal(controller.offer('pending', 'same', NOW + 10_001), true, 'the window is over');
  assert.equal(controller.offer('pending', 'same2', NOW + 10_002), true, 'another session is a different key');
  controller.destroy();
});

test('popout first entry only', () => {
  const harness = popoutHarness();
  const { controller } = harness;
  const list = {
    ids: ['me', 'other'],
    byId: {
      me: session({ id: 'me', updatedAt: NOW - 1_000 }),
      other: session({ id: 'other', updatedAt: NOW - 1_000 }),
    },
  };
  const statuses = new Map([['other', { running: false, pendingInteraction: { kind: 'approval' }, completionUnread: false }]]);
  const snapshot = { list, statuses, currentId: 'me', errors: new Map(), completedAt: new Map() };

  controller.observe(snapshot, NOW);
  assert.equal(controller.showing()?.category, 'pending', 'a category entry shows');
  controller.dismiss();
  controller.observe(snapshot, NOW + 1_000);
  assert.equal(controller.showing(), null, 'a session that is still pending does not show again');

  /** The current session never pops, even when it enters a category. */
  const mine = new Map([['me', { running: false, pendingInteraction: { kind: 'approval' }, completionUnread: false }]]);
  controller.observe({ list, statuses: mine, currentId: 'me', errors: new Map(), completedAt: new Map() }, NOW + 2_000);
  assert.equal(controller.showing(), null);

  /** A different category is a new entry. */
  const errored = new Map([['other', { running: false, pendingInteraction: null, completionUnread: false }]]);
  const errors = new Map([['other', { message: 'boom', at: NOW }]]);
  controller.observe({ list, statuses: errored, currentId: 'me', errors, completedAt: new Map() }, NOW + 11_000);
  assert.equal(controller.showing()?.category, 'error', 'error beats the pending entry it replaced');
  controller.destroy();
});

// 36. Overlay image size: clamped to 120–900, and a crossed pair is swapped.
test('overlay size sanitising', () => {
  const swapped = api.sanitizeSettings({ overlay: { sizeMin: 900, sizeMax: 200 } });
  assert.equal(swapped.overlay.sizeMin, 200, 'the smaller number always ends up in sizeMin');
  assert.equal(swapped.overlay.sizeMax, 900);

  const clamped = api.sanitizeSettings({ overlay: { sizeMin: 10, sizeMax: 5000 } });
  assert.equal(clamped.overlay.sizeMin, 120);
  assert.equal(clamped.overlay.sizeMax, 900);

  const missing = api.sanitizeSettings({ overlay: { side: 'left' } });
  assert.equal(missing.overlay.sizeMin, DEFAULTS.overlay.sizeMin);
  assert.equal(missing.overlay.sizeMax, DEFAULTS.overlay.sizeMax);
});

// 37. Playback frequency: 0 never plays, 1 every beat, and a v4.3 interval migrates onto the same scale.
test('playback frequency sanitising', () => {
  const off = api.sanitizeSettings({ categories: { pending: { glyph: { frequency: 0 } } } });
  assert.equal(off.categories.pending.glyph.frequency, 0);

  const full = api.sanitizeSettings({ categories: { pending: { glyph: { frequency: 1 } } } });
  assert.equal(full.categories.pending.glyph.frequency, 1);

  const snapped = api.sanitizeSettings({ categories: { pending: { glyph: { frequency: 0.42 } } } });
  assert.equal(snapped.categories.pending.glyph.frequency, 0.4, 'the slider only has 5% steps');

  const high = api.sanitizeSettings({ categories: { pending: { glyph: { frequency: 9 } } } });
  assert.equal(high.categories.pending.glyph.frequency, 1);
  const low = api.sanitizeSettings({ categories: { pending: { glyph: { frequency: -3 } } } });
  assert.equal(low.categories.pending.glyph.frequency, 0);

  /** v4.3 stored an average interval: 2s meant "every beat", 60s meant "almost never". */
  const everyBeat = api.sanitizeSettings({ categories: { pending: { glyph: { motionIntervalMs: 2000 } } } });
  assert.equal(everyBeat.categories.pending.glyph.frequency, 1);
  const never = api.sanitizeSettings({ categories: { pending: { glyph: { motionIntervalMs: 0 } } } });
  assert.equal(never.categories.pending.glyph.frequency, 0, 'interval 0 meant "never", so it maps to 0 not 1');
  const rare = api.sanitizeSettings({ categories: { pending: { glyph: { motionIntervalMs: 60000 } } } });
  assert.equal(rare.categories.pending.glyph.frequency, 0);
  const middle = api.sanitizeSettings({ categories: { pending: { glyph: { motionIntervalMs: 8000 } } } });
  assert.equal(middle.categories.pending.glyph.frequency, 0.9);
  assert.equal('motionIntervalMs' in middle.categories.pending.glyph, false, 'only the frequency is written back');

  /** A v4.0 global interval lands on every class at once. */
  const global = api.sanitizeSettings({ display: { motionIntervalMs: 30000 } });
  assert.equal(global.categories.pending.glyph.frequency, 0.5);
  assert.equal(global.categories.running.glyph.frequency, 0.5);
  assert.equal(global.categories.pending.glyphSecondary.frequency, 0.5);
});

// 38. `glyph.source` decides what is drawn: the upload, that category's popout art, or the emoji.
test('glyph source resolution', () => {
  const settings = api.sanitizeSettings(api.defaultSettings());
  const first = 'data:image/webp;base64,AAAA';
  const second = 'data:image/webp;base64,BBBB';
  settings.categories.pending.glyph = {
    ...settings.categories.pending.glyph,
    source: 'upload',
    uploads: [{ name: 'a', dataUrl: first }, { name: 'b', dataUrl: second }],
  };
  const seed = 'session-1|pending|1800000000000';
  const picked = api.resolveStateGlyph(settings, 'approval', seed);
  assert.equal(picked.kind, 'img');
  assert.equal(api.resolveStateGlyph(settings, 'approval', seed).value, picked.value, 'one seed, one picture');
  /** Deterministic hash, not a coin: eight different seeds must split across both entries. */
  const drawn = new Set(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'].map((value) => api.resolveStateGlyph(settings, 'approval', value).value));
  assert.equal(drawn.size, 2, 'a different session may draw a different picture');
  assert.equal(api.resolveStateGlyph(settings, 'approval', seed).value, picked.value, 'a repaint keeps the picture');

  settings.categories.pending.glyph = { ...settings.categories.pending.glyph, source: 'popout' };
  assert.deepEqual(api.resolveStateGlyph(settings, 'approval'), { kind: 'img', value: api.fallbackRef('pending') });

  settings.categories.pending.popout = { ...settings.categories.pending.popout, images: [{ name: 'art', dataUrl: first }] };
  assert.deepEqual(api.resolveStateGlyph(settings, 'approval'), { kind: 'img', value: first });

  settings.categories.pending.popout = { ...settings.categories.pending.popout, images: [], builtin: false };
  assert.deepEqual(api.resolveStateGlyph(settings, 'approval'), { kind: 'emoji', value: '🔐' }, 'a popout source with nothing to draw keeps the emoji');

  settings.categories.pending.glyph = { ...settings.categories.pending.glyph, source: 'emoji', value: '🔔' };
  assert.deepEqual(api.resolveStateGlyph(settings, 'approval'), { kind: 'emoji', value: '🔔' });

  settings.categories.pending.glyph = { ...settings.categories.pending.glyph, value: '' };
  assert.equal(api.resolveStateGlyph(settings, 'approval').value, '🔐', 'an empty emoji falls back to the built-in');
});

// 39. Sidebar motion is a scheduled burst: one roll per class per tick, four spans at most, none under reduce.
test('sidebar motion bursts', () => {
  const realRandom = Math.random;
  let rolls = 0;
  let value = 0.2;
  Math.random = () => {
    rolls += 1;
    return value;
  };
  const settings = api.sanitizeSettings(api.defaultSettings());
  for (const category of ['pending', 'running', 'error']) settings.categories[category].glyph.frequency = 1;
  const rows = {
    'session-pending': { status: { running: true, pendingInteraction: { kind: 'approval' } } },
    'session-running': { status: { running: true } },
    'session-error': { status: { running: false }, error: { message: 'boom', at: NOW } },
  };
  clearSidebarRows();
  for (const sessionId of Object.keys(rows)) sidebarRow(sessionId, `会话 ${sessionId}`);
  const adapter = api.createSidebarAdapter({
    document: globalThis.document,
    readSettings: () => settings,
    readSession: (sessionId) => ({
      session: session({ id: sessionId }),
      status: rows[sessionId].status,
      error: rows[sessionId].error,
      completedAt: undefined,
      pinned: false,
      children: 0,
    }),
  });
  try {
    adapter.start();
    adapter.tick();
    assert.equal(rolls, 3, 'one roll per class, never one per row');
    assert.equal(document.querySelectorAll('[data-hotlist-burst]').length, 3, 'one burst per class, three classes');

    /** Reduce stops every running burst and never rolls again. */
    settings.display.reduceMotion = 'on';
    adapter.tick();
    assert.equal(document.querySelectorAll('[data-hotlist-burst]').length, 0);
    assert.equal(rolls, 3);

    /** Frequency 0 is the explicit "never animate this class" switch, and it skips the roll itself. */
    settings.display.reduceMotion = 'auto';
    for (const category of ['pending', 'running', 'error']) settings.categories[category].glyph.frequency = 0;
    adapter.tick();
    assert.equal(document.querySelectorAll('[data-hotlist-burst]').length, 0);
    assert.equal(rolls, 3, 'a class at 0% is skipped before it ever rolls');

    /** A low frequency still rolls once, then almost always loses: that is the whole point of the slider. */
    for (const category of ['pending', 'running', 'error']) settings.categories[category].glyph.frequency = 0.05;
    value = 0.9;
    adapter.tick();
    assert.equal(rolls, 6);
    assert.equal(document.querySelectorAll('[data-hotlist-burst]').length, 0, 'a 5% class usually loses its roll');
    value = 0.02;
    adapter.tick();
    assert.equal(rolls, 9);
    assert.equal(document.querySelectorAll('[data-hotlist-burst]').length <= 4, true, 'a winner still respects the cap');
  } finally {
    adapter.stop();
    Math.random = realRandom;
    clearSidebarRows();
    clearStyleBlocks();
  }
});

// 40. Cards open independently: the stored array opens every listed card, unknown ids do not.
test('settings page multiple open cards', () => {
  globalThis.sessionStorage = new MemoryStorage({ 'dsh.hotlist.open': JSON.stringify(['error', 'nope', 'pending']) });
  try {
    const { harness, page } = renderPage();
    const opened = collect(page, (props) => typeof props['data-hotlist-card-body'] === 'string')
      .map((node) => node.props['data-hotlist-card-body']);
    assert.deepEqual(opened, ['error', 'pending']);
    assert.equal(collect(page, (props) => props['data-hotlist-card-body'] === 'error').length, 1);
    harness.cleanup();
  } finally {
    delete globalThis.sessionStorage;
  }

  /** A single bare id from an older build opens that one card. */
  globalThis.sessionStorage = new MemoryStorage({ 'dsh.hotlist.open': 'idle' });
  try {
    const { harness, page } = renderPage();
    const opened = collect(page, (props) => typeof props['data-hotlist-card-body'] === 'string')
      .map((node) => node.props['data-hotlist-card-body']);
    assert.deepEqual(opened, ['idle']);
    harness.cleanup();
  } finally {
    delete globalThis.sessionStorage;
  }
});

// 41. Row density: presets share rows, hint spans the full width, and the removed rows are gone.
test('settings page densified rows', () => {
  globalThis.sessionStorage = new MemoryStorage({
    'dsh.hotlist.open': JSON.stringify(['pinned', 'error', 'pending', 'completed', 'running', 'idle']),
  });
  const { harness, page } = renderPage();
  try {
    const grids = collect(page, (props) => props.className === 'hl-rowMulti');
    const columns = grids.map((node) => node.props.style['--hl-cols']);
    assert.equal(columns.includes('3'), true, 'the popout and motion groups put three controls on one line');
    assert.equal(columns.includes('2'), true, 'the glyph source/size pair shares a line');

    const cells = collect(page, (props) => props.className === 'hl-cell');
    assert.equal(cells.length >= 10, true);

    const rows = collect(page, (props) => typeof props['data-hotlist-row'] === 'string')
      .map((node) => node.props['data-hotlist-row']);
    assert.equal(rows.includes('recentWindow'), true, 'the recent window lives in the global block, not in a card');
    assert.equal(rows.includes('within'), false, 'the idle card no longer owns a window of its own');
    assert.equal(rows.includes('overlay.size'), false, 'v4.5 dropped the size row; the numbers stay in the schema');
    assert.equal(rows.includes('sound.volume'), true);
    assert.equal(rows.some((row) => row.includes('positions.sidebar')), false);
    assert.equal(rows.some((row) => row.startsWith('categories.favorite')), false);

    /** The entrance control is fixed for this build: it renders as text with the reason, never as a picker. */
    const fixed = collect(page, (props) => props.title === 'settings.popout.entranceFixed');
    assert.equal(fixed.length, 6, 'every card explains why its entrance control is read-only');
    assert.equal(fixed.every((node) => node.type === 'span'), true);
  } finally {
    harness.cleanup();
    delete globalThis.sessionStorage;
  }
});

// 42. v4.4 removed the reset row from the page; the API still resets for anyone scripting it.
test('settings page has no reset row', () => {
  const rendered = renderPage();
  try {
    const rows = collect(rendered.page, (props) => typeof props['data-hotlist-row'] === 'string')
      .map((node) => node.props['data-hotlist-row']);
    assert.equal(rows.includes('reset'), false, 'the reset control left the page in v4.4');
    assert.equal(collect(rendered.page, (props) => props['data-hotlist-reset'] !== undefined).length, 0);
  } finally {
    rendered.harness.cleanup();
  }
  /** The documented API keeps working: a scripted reset writes the defaults back. */
  const before = api.readSettings();
  api.writeSettings({ maxSeats: 9 });
  assert.equal(api.readSettings().maxSeats, 9);
  api.resetSettings();
  assert.deepEqual(api.readSettings(), before);
});

// 43. Finished marks survive a reload: throttled write, one per sync burst, immediate drop on view.
await testAsync('completedAt persistence', async () => {
  const realSetItem = storage.setItem.bind(storage);
  const writesByKey = new Map();
  storage.setItem = (key, value) => {
    writesByKey.set(key, (writesByKey.get(key) ?? 0) + 1);
    realSetItem(key, value);
  };
  const completedKey = () => {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      try {
        const parsed = JSON.parse(storage.getItem(key));
        if (parsed !== null && typeof parsed === 'object' && typeof parsed.entries === 'object') return key;
      } catch {
        /* not ours */
      }
    }
    return null;
  };
  const harnesses = [];
  try {
    const ids = ['done-1', 'done-2'];
    const list = { ids, byId: { 'done-1': session({ id: 'done-1', running: true }), 'done-2': session({ id: 'done-2', running: true }) } };
    const statuses = new Map([['done-1', { running: true }], ['done-2', { running: true }]]);
    const harness = createCtx({ list, statuses, groups: { items: [{ workspaceId: 'w1', sessionIds: ids }], archivedSessionIds: [] } });
    harnesses.push(harness);
    api.apply(harness.ctx, {});
    await tick();
    /** Two sessions finish inside one sync: the throttle still writes once. */
    harness.statusStore.set(new Map([['done-1', { running: false }], ['done-2', { running: false }]]));
    await sleep(700);
    const key = completedKey();
    assert.equal(typeof key, 'string', 'finished marks reach storage');
    const stored = JSON.parse(storage.getItem(key));
    assert.equal(stored.version, 4);
    assert.deepEqual(Object.keys(stored.entries).sort(), ['done-1', 'done-2']);
    assert.equal(writesByKey.get(key), 1, 'a burst of finishes is written once');

    /** Opening one of them means it is no longer "done": the entry goes at once. */
    harness.listStore.set({
      phase: 'ready',
      ids,
      byId: { 'done-1': session({ id: 'done-1', running: false, retainedBy: { mainView: 1 } }), 'done-2': session({ id: 'done-2', running: false }) },
    });
    await tick();
    const afterView = JSON.parse(storage.getItem(key));
    assert.deepEqual(Object.keys(afterView.entries), ['done-2']);
    assert.equal(writesByKey.get(key), 2, 'the current session is dropped without waiting for the throttle');

    /** Stale and foreign entries are pruned on the next boot. */
    const now = Date.now();
    storage.setItem(key, JSON.stringify({
      version: 4,
      entries: { 'done-2': now, stale: now - 8 * 60_000, foreign: now },
    }));
    const next = createCtx({
      list: { ids: ['done-2', 'done-3'], byId: { 'done-2': session({ id: 'done-2' }), 'done-3': session({ id: 'done-3', retainedBy: { mainView: 1 } }) } },
      statuses: new Map(),
      groups: { items: [{ workspaceId: 'w1', sessionIds: ['done-2', 'done-3'] }], archivedSessionIds: [] },
    });
    harnesses.push(next);
    api.apply(next.ctx, {});
    await tick();
    await sleep(700);
    const pruned = JSON.parse(storage.getItem(key));
    assert.deepEqual(Object.keys(pruned.entries), ['done-2'], 'expired and foreign-workspace marks are dropped');

    /** A list that is still loading must not prune: every mark would look "gone". */
    const booting = createCtx({
      list: { phase: 'pending', ids: [], byId: {} },
      statuses: new Map(),
      groups: { items: [], archivedSessionIds: [] },
    });
    harnesses.push(booting);
    storage.setItem(key, JSON.stringify({ version: 4, entries: { 'done-2': Date.now() } }));
    api.apply(booting.ctx, {});
    await tick();
    await sleep(700);
    const kept = JSON.parse(storage.getItem(key));
    assert.deepEqual(Object.keys(kept.entries), ['done-2'], 'a pending list keeps marks read from disk');
    booting.listStore.set({ phase: 'ready', ids: [], byId: {} });
    await tick();
    await sleep(700);
    const dropped = JSON.parse(storage.getItem(key));
    assert.deepEqual(Object.keys(dropped.entries), [], 'once the list is ready, a missing session is pruned');
  } finally {
    for (const harness of harnesses) harness.cleanup();
    storage.setItem = realSetItem;
    const key = completedKey();
    if (key !== null) storage.removeItem(key);
  }
});

// 44. No identifier may look like a constant without being declared: `node --check` cannot see this.
test('no undefined constants', () => {
  const strip = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:/])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
  const code = strip(source);
  const declared = new Set();
  for (const match of code.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) declared.add(match[1]);
  for (const match of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?::|\()/g)) declared.add(match[1]);
  const platform = new Set(['JSON', 'URL', 'CSS', 'DOM', 'HTML', 'SHA', 'PNG', 'UTF', 'IDB', 'ARIA', 'HTTP', 'SVG', 'WEBP', 'MAX', 'MIN']);
  const offenders = [];
  for (const match of code.matchAll(/(^|[^.\w$])([A-Z][A-Z0-9_]{2,})\b/g)) {
    const name = match[2];
    if (declared.has(name) || platform.has(name)) continue;
    offenders.push(name);
  }
  assert.deepEqual([...new Set(offenders)], []);
});

// 45. Boot smoke: the module loads and reads settings even from a corrupted store.
test('module boot smoke', () => {
  assert.equal(loaded.id, '@merusu/dsh-better-notice');
  assert.equal(typeof api.readSettings, 'function');
  const key = 'dsh.hotlist.settings.v1';
  const previous = storage.getItem(key);
  try {
    storage.setItem(key, '{{{');
    const broken = api.readSettings();
    assert.equal(broken.version, 4);
    assert.equal(broken.maxSeats, DEFAULTS.maxSeats);
    storage.setItem(key, JSON.stringify({ version: 3, maxSeats: 'many', overlay: { scale: 'huge' } }));
    const migrated = api.readSettings();
    assert.equal(migrated.version, 4);
    assert.equal(migrated.overlay.sizeMin, 260);
    assert.equal(migrated.overlay.sizeMax, 520, 'an unusable zoom multiplier falls back to the default max');
  } finally {
    if (previous === null) storage.removeItem(key);
    else storage.setItem(key, previous);
  }
});

// 46. Sound player: the first sync only arms, a repaint is silent, re-entry rings, 1.5s apart.
test('sound player dedupe', () => {
  const settings = api.sanitizeSettings(api.defaultSettings());
  settings.categories.pending.sound.enabled = true;
  const plays = [];
  const logs = [];
  const player = api.createSoundPlayer({
    getSettings: () => settings,
    createAudio: (url) => ({
      url,
      volume: 1,
      play() {
        plays.push({ url, volume: this.volume });
        return Promise.resolve();
      },
    }),
    log: (...args) => logs.push(args.join(' ')),
  });
  const shot = (entries) => {
    const ids = entries.map(([id]) => id);
    return {
      list: { ids, byId: Object.fromEntries(ids.map((id) => [id, session({ id })])) },
      statuses: new Map(entries),
      errors: new Map(),
      completedAt: new Map(),
    };
  };
  const pending = { pendingInteraction: { kind: 'approval' } };

  player.observe(shot([['a', pending]]), 1000);
  assert.equal(plays.length, 0, 'the opening sync only arms the player');
  /** The arm decision leaves a trace: the real machine has to prove the cold start stayed quiet. */
  assert.equal(logs.includes('armed pending'), true);
  player.observe(shot([['a', pending]]), 2000);
  assert.equal(plays.length, 0, 'the same session in the same class is a repaint');
  player.observe(shot([['a', pending]]), 3000);
  assert.equal(plays.length, 0);

  player.observe(shot([]), 4000);
  player.observe(shot([['a', pending]]), 5000);
  assert.equal(plays.length, 1, 'leaving and re-entering the class rings once');
  assert.match(plays[0].url, /^\/hotlist-sound\/attention\.wav$/);
  assert.equal(plays[0].volume, 0.6, 'the global volume drives every sound');

  player.observe(shot([['b', pending]]), 6000);
  assert.equal(plays.length, 1, 'a second session inside the throttle window stays silent');
  assert.equal(logs.some((line) => line.startsWith('throttle pending')), true, 'a skipped sound is logged');
  /** The skipped session is spent, not queued: only a new entry may ring after the window. */
  player.observe(shot([['b', pending], ['c', pending]]), 6600);
  assert.equal(plays.length, 2, 'past the window a fresh entry rings again');

  assert.equal(player.preview('pending'), true, 'the preview ignores the throttle');
  assert.equal(plays.length, 3);
  assert.equal(logs.some((line) => line.startsWith('preview pending')), true);

  settings.categories.pending.sound.enabled = false;
  player.observe(shot([['d', pending]]), 9000);
  assert.equal(plays.length, 3, 'a disabled class never rings');
  /** Only the three packaged classes may build a URL; a click elsewhere stays mute instead of 404. */
  assert.equal(api.pickSoundUrl(settings, 'running'), '');
  assert.equal(player.preview('running'), false);
});

// 47. Picks: the icon seed is a hash (stable per session), popout art and sounds fire per event.
test('seeded and random asset picks', () => {
  assert.equal(api.pickIndex('alpha', 3), api.pickIndex('alpha', 3));
  assert.equal(api.pickIndex('alpha', 1), 0);
  const spread = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map((seed) => api.pickIndex(seed, 4)));
  assert.equal(spread.size > 1, true, 'different seeds reach different entries');
  assert.equal(api.randomIndex(1), 0);

  const realRandom = Math.random;
  Math.random = () => 0.99;
  try {
    assert.equal(api.randomIndex(5), 4);
  } finally {
    Math.random = realRandom;
  }

  const settings = api.sanitizeSettings(api.defaultSettings());
  settings.categories.pending.sound.builtin = true;
  assert.match(api.pickSoundUrl(settings, 'pending'), /^\/hotlist-sound\/attention\.wav$/);
  assert.match(api.pickSoundUrl(settings, 'error'), /^\/hotlist-sound\/attention\.wav$/);
  assert.match(api.pickSoundUrl(settings, 'completed'), /^\/hotlist-sound\/complete\.wav$/);
  assert.equal(api.pickSoundUrl(settings, 'pinned'), '', 'no packaged clip for pinned');
  assert.deepEqual(api.BUILTIN_SOUND, { pending: 'attention.wav', error: 'attention.wav', completed: 'complete.wav' });
  settings.categories.pending.sound.builtin = false;
  assert.equal(api.pickSoundUrl(settings, 'pending'), '', 'no upload and no built-in means no sound');

  settings.categories.pending.popout.builtin = true;
  assert.deepEqual(api.pickPopoutArt(settings, 'pending'), { kind: 'builtin', value: api.fallbackRef('pending') });
  settings.categories.pending.popout.images = [{ name: 'x', dataUrl: 'data:image/png;base64,AAAA' }];
  assert.deepEqual(api.pickPopoutArt(settings, 'pending'), { kind: 'data', value: 'data:image/png;base64,AAAA' });
  settings.categories.pending.popout.images = [];
  settings.categories.pending.popout.builtin = false;
  assert.deepEqual(api.pickPopoutArt(settings, 'pending'), { kind: 'emoji', value: '' });
});

// 48. Quotas: six entries a pool, 16KB/64KB/128KB a file, 2MB the whole bundle.
test('asset quotas', () => {
  const image = (bytes, seed = 65) => `data:image/png;base64,${Buffer.alloc(bytes, seed).toString('base64')}`;
  const sound = (bytes, seed = 65) => `data:audio/mpeg;base64,${Buffer.alloc(bytes, seed).toString('base64')}`;

  const six = [0, 1, 2, 3, 4, 5, 6].map((index) => ({ name: `s${index}`, dataUrl: image(100, 65 + index) }));
  assert.equal(api.sanitizeAssets(six, 'glyph').length, 6, 'a seventh entry is refused');
  assert.equal(api.sanitizeAssets(six, 'glyph')[0].name, 's0', 'the oldest entries are kept');

  assert.deepEqual(api.sanitizeAssets([{ name: 'huge', dataUrl: image(16 * 1024 + 1) }], 'glyph'), []);
  /** Base64 padding costs a couple of bytes, so "just fits" sits a little under the ceiling. */
  assert.equal(api.sanitizeAssets([{ name: 'ok', dataUrl: image(16 * 1024 - 8) }], 'glyph').length, 1);
  assert.deepEqual(api.sanitizeAssets([{ name: 'huge', dataUrl: image(64 * 1024 + 1) }], 'popout'), []);
  assert.equal(api.sanitizeAssets([{ name: 'ok', dataUrl: image(64 * 1024 - 8) }], 'popout').length, 1);
  assert.deepEqual(api.sanitizeAssets([{ name: 'huge', dataUrl: sound(128 * 1024 + 1) }], 'sound'), []);
  assert.equal(api.sanitizeAssets([{ name: 'ok', dataUrl: sound(128 * 1024 - 8) }], 'sound').length, 1);
  assert.deepEqual(api.sanitizeAssets([{ name: 'wrong', dataUrl: image(100) }], 'sound'), [], 'a picture is not a sound');
  assert.equal(api.sanitizeAssets([{ name: '', dataUrl: image(100) }], 'glyph')[0].name, 'glyph-1', 'a blank name is filled in');

  /** 2 × (6 sounds × 120KB + 6 pictures × 60KB) = 2.16MB, so the tail of the first pools has to go. */
  const heavy = (seed) => ({
    sound: { uploads: [0, 1, 2, 3, 4, 5].map((index) => ({ name: `s${seed}-${index}`, dataUrl: sound(120 * 1024, 65 + index) })) },
    popout: { images: [0, 1, 2, 3, 4, 5].map((index) => ({ name: `p${seed}-${index}`, dataUrl: image(60 * 1024, 65 + index) })) },
  });
  const trimmed = api.sanitizeSettings({ categories: { pending: heavy(1), error: heavy(2) } });
  const total = ['pending', 'error']
    .flatMap((category) => [...trimmed.categories[category].sound.uploads, ...trimmed.categories[category].popout.images])
    .reduce((sum, item) => sum + api.assetBytes(item.dataUrl), 0);
  assert.equal(total <= 2 * 1024 * 1024, true, 'the bundle stays under 2MB');
  /** Trimming walks `CATEGORY_IDS`, so `error` gives way before `pending`, sounds before pictures. */
  assert.equal(trimmed.categories.error.sound.uploads.length, 5, 'the first category in id order loses one sound');
  assert.equal(trimmed.categories.error.popout.images.length, 6, 'pictures are only touched after the sounds');
  assert.equal(trimmed.categories.pending.sound.uploads.length, 6, 'later categories keep their pool');
});

// 49. v4.1 storage: a lone image seeds the pool, a `builtin:` string flips the switch, `kind` becomes enabled.
test('asset migration', () => {
  const migrated = api.sanitizeSettings({
    categories: {
      pending: {
        glyph: { kind: 'img', value: 'data:image/png;base64,AAAA' },
        popout: { image: 'data:image/png;base64,BBBB' },
        sound: { kind: 'upload', enabled: true, volume: 80 },
      },
      error: { popout: { image: 'builtin:error' }, sound: { kind: 'none' } },
    },
  });
  assert.equal(migrated.categories.pending.glyph.uploads.length, 1);
  assert.equal(migrated.categories.pending.glyph.source, 'upload');
  assert.equal(migrated.categories.pending.popout.images[0].dataUrl, 'data:image/png;base64,BBBB');
  assert.equal(migrated.categories.pending.popout.builtin, false);
  assert.equal(migrated.categories.pending.sound.enabled, true);
  assert.equal(migrated.categories.pending.sound.builtin, false);
  assert.equal(migrated.categories.pending.sound.uploads.length, 0, 'a v4.1 `kind` carried no audio payload');
  assert.equal(migrated.sound.volume, 80);
  assert.equal(migrated.categories.error.popout.builtin, true);
  assert.equal(migrated.categories.error.sound.enabled, false);
});

// 47. Hotkeys: the cycle chords walk the live seats and every guard holds.
test('shortcut cycle and guards', () => {
  const ids = ['s1', 's2', 's3'];
  const byId = {};
  for (const id of ids) byId[id] = session({ id });
  const harness = createCtx({ list: { ids, byId }, groups: { items: [], archivedSessionIds: [] } });
  api.apply(harness.ctx, {});

  assert.deepEqual(
    harness.shortcutRegistrations.map((spec) => spec.id),
    ['hotlist.cycle.prev', 'hotlist.cycle.next', 'hotlist.overlay.once'],
  );
  for (const spec of harness.shortcutRegistrations) {
    const code = spec.id === 'hotlist.overlay.once' ? 'KeyS' : (spec.id.endsWith('prev') ? 'BracketLeft' : 'BracketRight');
    assert.deepEqual(spec.bindings, [{ code, modifiers: ['alt', 'shift'] }]);
    assert.equal(spec.group, 'application');
  }

  /** One key event; the return value is whether the plugin claimed it. */
  const press = (scope, code, context = { region: 'page', modal: null }, gesture = {}) => {
    const state = { consumed: false };
    scope.dispatchShortcut({
      type: 'key',
      gesture: { code, alt: true, shift: true, control: false, meta: false, repeat: false, composing: false, defaultPrevented: false, ...gesture },
      context,
      consume: () => { state.consumed = true; },
    });
    return state.consumed;
  };

  /** No current session: `]` starts at the first seat and `[` at the last. */
  assert.equal(press(harness, 'BracketRight'), true);
  assert.equal(press(harness, 'BracketLeft'), true);
  assert.deepEqual(harness.opened, ['s1', 's3']);

  /** Every guard drops the event before it can open anything. */
  harness.opened.length = 0;
  assert.equal(press(harness, 'BracketRight', { region: 'settings', modal: null }), false);
  assert.equal(press(harness, 'BracketRight', { region: 'page', modal: {} }), false);
  assert.equal(press(harness, 'BracketRight', { region: 'page', modal: null }, { repeat: true }), false);
  assert.equal(press(harness, 'BracketRight', { region: 'page', modal: null }, { control: true }), false);
  assert.equal(press(harness, 'BracketRight', { region: 'page', modal: null }, { defaultPrevented: true }), false);
  assert.deepEqual(harness.opened, []);

  /** The manual popout key only fires while `shortcuts.overlayEnabled` is on. */
  assert.equal(press(harness, 'KeyS'), false);
  api.overrideSettings({ shortcuts: { overlayEnabled: true } });
  assert.equal(press(harness, 'KeyS'), true);
  api.overrideSettings(null);
  harness.cleanup();

  /**
   * The current session never owns a seat (§4), so with s2 on screen the walk is
   * still `s1` and `s3`; the second `[` keeps moving instead of re-entering at the end.
   */
  const byId2 = {};
  for (const id of ids) byId2[id] = session({ id });
  byId2.s2 = session({ id: 's2', retainedBy: { mainView: 1 } });
  const focused = createCtx({ list: { ids, byId: byId2 }, groups: { items: [], archivedSessionIds: [] } });
  api.apply(focused.ctx, {});
  assert.equal(press(focused, 'BracketRight'), true);
  assert.equal(press(focused, 'BracketLeft'), true);
  assert.equal(press(focused, 'BracketLeft'), true);
  assert.deepEqual(focused.opened, ['s1', 's3', 's1']);
  focused.cleanup();
});

// 48. The uploaded glyph seeds on identity, never on when the session entered: a reload must not re-roll.
test('glyph seed ignores time', () => {
  const settings = api.sanitizeSettings(api.defaultSettings());
  settings.categories.pending.glyph.source = 'upload';
  settings.categories.pending.glyph.uploads = [
    { name: 'a', dataUrl: 'data:image/webp;base64,AAAA' },
    { name: 'b', dataUrl: 'data:image/webp;base64,BBBB' },
  ];
  const picks = [];
  for (let round = 0; round < 5; round += 1) picks.push(api.resolveStateGlyph(settings, 'approval', 's1|pending'));
  assert.equal(new Set(picks.map((pick) => pick.value)).size, 1, 'five renders pick the same upload');
  assert.equal(picks[0].kind, 'img');
  /** The table that used to carry the entry timestamp is gone, so no caller can seed on it. */
  assert.equal(source.includes('enteredAt'), false);
});

// 49. Hotkey edges: empty plan, single seat, wrap-around, wrong modifiers, and no shortcuts service at all.
test('shortcut edges', () => {
  const press = (scope, code, gesture = {}) => {
    const state = { consumed: false };
    scope.dispatchShortcut({
      type: 'key',
      gesture: { code, alt: true, shift: true, control: false, meta: false, repeat: false, composing: false, defaultPrevented: false, ...gesture },
      context: { region: 'page', modal: null },
      consume: () => { state.consumed = true; },
    });
    return state.consumed;
  };
  const empty = createCtx({ list: { ids: [], byId: {} }, groups: { items: [], archivedSessionIds: [] } });
  api.apply(empty.ctx, {});
  assert.equal(press(empty, 'BracketRight'), false, 'an empty plan claims nothing');
  assert.deepEqual(empty.opened, []);
  empty.cleanup();

  const single = createCtx({ list: { ids: ['only'], byId: { only: session({ id: 'only' }) } }, groups: { items: [], archivedSessionIds: [] } });
  api.apply(single.ctx, {});
  assert.equal(press(single, 'BracketRight'), true);
  assert.equal(press(single, 'BracketLeft'), true);
  assert.deepEqual(single.opened, ['only', 'only'], 'a single seat wraps onto itself');
  single.cleanup();

  const ids = ['a', 'b', 'c'];
  const byId = {};
  for (const id of ids) byId[id] = session({ id });
  const three = createCtx({ list: { ids, byId }, groups: { items: [], archivedSessionIds: [] } });
  api.apply(three.ctx, {});
  /** Opening a seat makes it the current session, which is exactly what happens on the real host. */
  const focus = (scope, id) => {
    const rows = ids.map((sid) => session({ id: sid, retainedBy: sid === id ? { mainView: 1 } : undefined }));
    scope.listStore.set({ ids: [...ids], byId: Object.fromEntries(rows.map((row) => [row.id, row])) });
  };
  for (const id of ['a', 'b', 'c', 'a']) {
    assert.equal(press(three, 'BracketRight'), true);
    assert.equal(three.opened[three.opened.length - 1], id, 'the walk wraps from the last seat back to the first');
    focus(three, id);
  }
  assert.deepEqual(three.opened, ['a', 'b', 'c', 'a']);
  assert.equal(press(three, 'BracketRight', { shift: false }), false, 'alt without shift is not our chord');
  assert.equal(press(three, 'BracketRight', { alt: false }), false);
  assert.equal(press(three, 'KeyQ'), false, 'an unrelated code is ignored');
  three.cleanup();

  /** Without the optional shortcuts service the plugin still loads and registers its slots. */
  const bare = createCtx({ list: { ids, byId }, groups: { items: [], archivedSessionIds: [] }, without: ['shortcuts'] });
  api.apply(bare.ctx, {});
  assert.equal(bare.shortcutRegistrations.length, 0, 'nothing is registered without the service');
  assert.equal(bare.registrations.some((id) => id.startsWith('hotlist-seat-')), true, 'seats still register');
  assert.equal(press(bare, 'BracketRight'), false);
  bare.cleanup();
});

/**
 * The host calls `command.label()` when it builds its catalog
 * (`dsh-client-shortcuts/lib/client.js:1190` and `:1249`). Handing it a translated
 * string instead of a thunk throws `TypeError: command.label is not a function`
 * inside `refreshLabels`, which takes the whole web boot down — every UI service
 * goes `pending (waiting for service: …)` and the page shows only a banner.
 * This group exists because the unit suite stubs the service, so the mistake is
 * invisible until a real browser loads it.
 */
test('shortcut labels are thunks', () => {
  const ids = ['a', 'b', 'c'];
  const byId = {};
  for (const id of ids) byId[id] = session({ id });
  const ctx = createCtx({ list: { ids, byId }, groups: { items: [], archivedSessionIds: [] } });
  api.apply(ctx.ctx, {});
  assert.equal(ctx.shortcutRegistrations.length, 3, 'three fixed commands');
  for (const spec of ctx.shortcutRegistrations) {
    assert.equal(typeof spec.label, 'function', `${spec.id} label must be a thunk`);
    const label = spec.label();
    assert.equal(typeof label, 'string', `${spec.id} label() must return a string`);
    assert.equal(label.length > 0, true, `${spec.id} label() must not be empty`);
  }
  assert.deepEqual(
    ctx.shortcutRegistrations.map((spec) => spec.id),
    ['hotlist.cycle.prev', 'hotlist.cycle.next', 'hotlist.overlay.once'],
  );
  assert.deepEqual(
    ctx.shortcutRegistrations.map((spec) => spec.bindings[0].code),
    ['BracketLeft', 'BracketRight', 'KeyS'],
  );
  ctx.cleanup();
});

// 46. The recent window used to belong to the idle class; v4.4 made it one global setting.
test('recent window migration and clamping', () => {
  const fromClass = api.sanitizeSettings({ categories: { idle: { within: 30 } } });
  assert.equal(fromClass.collect.recentWindowMinutes, 30, 'a custom class window migrates into the global value');
  assert.equal('within' in fromClass.categories.idle, false, 'the class field is gone after sanitising');

  /** The old default is indistinguishable from "nothing set", so it falls back to the same default. */
  const oldDefault = api.sanitizeSettings({ categories: { idle: { within: 5 } } });
  assert.equal(oldDefault.collect.recentWindowMinutes, 5);

  const stored = api.sanitizeSettings({ collect: { recentWindowMinutes: 500 }, categories: { idle: { within: 30 } } });
  assert.equal(stored.collect.recentWindowMinutes, 120, 'the explicit value wins and clamps to the maximum');
  const negative = api.sanitizeSettings({ collect: { recentWindowMinutes: -4 } });
  assert.equal(negative.collect.recentWindowMinutes, 0, 'a negative window clamps to zero');

  /** Zero closes the third tier: nothing lands in idle. */
  const settings = api.defaultSettings();
  settings.collect.recentWindowMinutes = 0;
  const ids = ['fresh'];
  const byId = { fresh: session({ id: 'fresh', updatedAt: NOW - 60_000 }) };
  const input = { list: { ids, byId }, statuses: new Map(), errors: new Map(), completedAt: new Map(), now: NOW, workspaceIds: null, limit: 6 };
  assert.deepEqual(api.classify(settings, input).filter((row) => row.category === 'idle'), []);
  settings.collect.recentWindowMinutes = 5;
  assert.equal(api.classify(settings, input).filter((row) => row.category === 'idle').length, 1);
});

// 47. The preview loops while the card is open, and its duty cycle is the frequency.
test('preview loop lifecycle', () => {
  const glyphFor = (page, category) => collect(page, (props) => props.key === `glyph-${category}-primary`)
    .find((node) => node.props['data-hotlist-glyph'] !== undefined);
  api.writeSettings({ categories: { pending: { glyph: { motion: 'blink', frequency: 1 } } } });
  try {
    const full = renderPage();
    assert.equal(glyphFor(full.page, 'pending').props.style.animation, 'hl-pv-blink-20 1200ms linear infinite', '100% plays every loop at the base tempo');
    full.harness.cleanup();

    api.writeSettings({ categories: { pending: { glyph: { motion: 'blink', frequency: 0.5 } } } });
    const half = renderPage();
    assert.equal(glyphFor(half.page, 'pending').props.style.animation, 'hl-pv-blink-10 2400ms linear infinite', '50% halves the duty cycle and doubles the period');
    half.harness.cleanup();

    /** A class at 0% renders a still glyph: the animation is not merely slow, it is absent. */
    api.writeSettings({ categories: { pending: { glyph: { motion: 'blink', frequency: 0 } } } });
    const still = renderPage();
    assert.equal(glyphFor(still.page, 'pending').props.style.animation, undefined);
    still.harness.cleanup();

    /** Reduce motion overrides the slider entirely. */
    api.writeSettings({ categories: { pending: { glyph: { motion: 'blink', frequency: 1 } } }, display: { reduceMotion: 'on' } });
    const reduced = renderPage();
    assert.equal(glyphFor(reduced.page, 'pending').props.style.animation, undefined, 'reduce wins over a 100% frequency');
    reduced.harness.cleanup();
  } finally {
    api.resetSettings();
  }
});

/**
 * `motionTarget: 'row'` used to look dead: the title keyframes only faded opacity,
 * so a 1px-wide glyph moving read as "nothing happens". v4.4 adds a small translate
 * and this group pins both halves — the title gets the burst, and the keyframes move.
 */
test('motion target row reaches the title', () => {
  const settings = api.defaultSettings();
  settings.categories.pending.glyph.motion = 'blink';
  settings.categories.pending.glyph.frequency = 1;
  settings.categories.pending.glyph.motionTarget = 'row';
  clearSidebarRows();
  const { row, title } = sidebarRow('session-ask', '会话 待审');
  const adapter = api.createSidebarAdapter({
    document: globalThis.document,
    readSettings: () => settings,
    readSession: () => ({
      session: session({ id: 'session-ask' }),
      status: { running: true, pendingInteraction: { kind: 'approval' } },
      error: undefined,
      completedAt: undefined,
      pinned: false,
      children: 0,
    }),
  });
  try {
    adapter.start();
    adapter.tick();
    assert.equal(title.style.animation, 'hl-text-blink 1.2s ease-in-out 1', 'the row target animates the title itself');
    assert.equal(title.hasAttribute('data-hotlist-text-motion'), true);
    assert.equal(row.querySelectorAll('[data-hotlist-burst]').length, 1);

    /** The text keyframes must actually move pixels; opacity alone is what made the option look broken. */
    const css = head.querySelectorAll('[data-hotlist-style]').map((node) => node.textContent).join('\n');
    assert.equal(css.includes('@keyframes hl-text-bounce'), true);
    assert.equal(/@keyframes hl-text-bounce\{[^}]*translateY/.test(css), true, 'row motion needs a translate, not just an opacity wave');
  } finally {
    adapter.stop();
    clearSidebarRows();
    clearStyleBlocks();
  }
});

// 48. Every page control writes through the same store, so a change lands before the next frame.
test('settings page writes land immediately', async () => {
  const ids = ['q1', 'q2', 'q3'];
  const byId = {};
  for (const id of ids) byId[id] = session({ id, updatedAt: NOW - 60_000 });
  const harness = createCtx({
    list: { ids, byId },
    statuses: new Map(),
    groups: { items: [{ workspaceId: 'w1', sessionIds: ids }], archivedSessionIds: [] },
  });
  api.apply(harness.ctx, {});
  await tick();
  const entry = harness.entries.get('hotlist');
  const render = () => {
    let page = entry.Component({ close() {}, t: (key) => DICT[key] ?? key });
    if (typeof page.type === 'function') page = page.type(page.props);
    return page;
  };
  const controlIn = (page, rowKey, type) => {
    const row = collect(page, (props) => props['data-hotlist-row'] === rowKey)[0];
    assert.ok(row !== undefined, `row ${rowKey} is missing`);
    let found = null;
    walk(row, (node) => {
      if (found === null && node.props?.type === type) found = node;
    });
    assert.ok(found !== null, `row ${rowKey} has no ${type} control`);
    return found;
  };
  try {
    /** A global number lands in the store on the same tick the control fires. */
    controlIn(render(), 'recentWindow', 'number').props.onChange({ target: { value: '30' } });
    assert.equal(api.readSettings().collect.recentWindowMinutes, 30);

    /** A seat cap change reaches the tab row: three seats become two after the deferred dispose. */
    assert.equal(orders(harness.entries).length, 3);
    controlIn(render(), 'maxSeats', 'number').props.onChange({ target: { value: '1' } });
    assert.equal(api.readSettings().maxSeats, 1, 'the write itself is synchronous');
    await tick();
    await tick();
    assert.equal(orders(harness.entries).length, 1, 'the row follows within two frames');

    /** A checkbox works the same way: the popout switch is a plain store write. */
    const positionSwitch = controlIn(render(), 'positions.tab', 'checkbox');
    positionSwitch.props.onChange();
    assert.equal(api.readSettings().positions.tab, false);
    await tick();
    await tick();
    assert.equal(orders(harness.entries).length, 0, 'turning the tab position off empties the row');

    api.writeSettings({ positions: { tab: true }, maxSeats: 6, collect: { completedTtlMs: 7 * 60 * 1000, recentWindowMinutes: 5 } });
  } finally {
    harness.cleanup();
  }
});

// 59. The hard ceiling keeps the priority head: 37 rows, and the tail loses out, never the head.
test('plan hard ceiling keeps the priority head', () => {
  const settings = api.defaultSettings();
  const ids = [];
  const byId = {};
  for (let index = 0; index < 60; index += 1) {
    const id = `idle-${index}`;
    ids.push(id);
    byId[id] = session({ id, updatedAt: NOW - 60_000 });
  }
  const crowded = api.buildSeatPlan({
    surface: 'tab', list: { ids, byId }, statuses: new Map(), errors: new Map(), completedAt: new Map(),
    now: NOW, workspaceIds: null, limit: 40,
  }, settings);
  assert.equal(crowded.length, 37, 'the hard ceiling is 37, whatever the limit says');
  assert.equal(crowded.overflow, 20, 'overflow counts every row the ceiling and the limit dropped');

  /** One urgent row joins 37 idle ones: it takes the head and the last idle falls off the tail. */
  const withError = { ids: ['err', ...ids.slice(0, 37)], byId: { err: session({ id: 'err', updatedAt: NOW - 120_000 }) } };
  for (const [index, id] of ids.slice(0, 37).entries()) {
    withError.byId[id] = session({ id, updatedAt: NOW - 60_000 - index * 1000 });
  }
  const plan = api.buildSeatPlan({
    surface: 'tab', list: withError, statuses: new Map(), errors: new Map([['err', { message: 'boom', at: NOW }]]),
    completedAt: new Map(), now: NOW, workspaceIds: null, limit: 40,
  }, settings);
  assert.equal(plan.length, 37);
  assert.equal(plan[0].category, 'error', 'the urgent row keeps the head');
  assert.equal(plan.some((seat) => seat.sessionId === 'idle-36'), false, 'the oldest idle row is the one that goes');
  assert.equal(plan.some((seat) => seat.sessionId === 'idle-0'), true);
});

// 60. v4.6 defaults only fill gaps: a stored choice survives a default change.
test('defaults never overwrite stored values', () => {
  const settings = api.defaultSettings();
  for (const category of Object.keys(settings.categories)) {
    assert.equal(settings.categories[category].glyph.motionTarget, 'row', 'titles move with the glyph by default');
  }
  assert.deepEqual(api.tokenMotion(settings, 'error'), { motion: 'bounce', motionTarget: 'row' });

  const stored = {
    ...settings,
    categories: {
      ...settings.categories,
      error: {
        ...settings.categories.error,
        glyph: { ...settings.categories.error.glyph, motionTarget: 'glyph', frequency: 0.35 },
      },
    },
  };
  const sanitized = api.sanitizeSettings(stored);
  assert.equal(sanitized.categories.error.glyph.motionTarget, 'glyph', 'a stored target beats the new default');
  assert.equal(sanitized.categories.error.glyph.frequency.toFixed(2), '0.35', 'and so does the stored frequency');
});

// 61. Non-destructive updates: what this build cannot represent is kept, not deleted, and writes keep a backup ring.
test('user settings are never overwritten', () => {
  const key = 'dsh.hotlist.settings.v1';
  const preservedKey = 'dsh.betterNotice.preserved.v1';
  const backupKey = 'dsh.betterNotice.backup.v1';
  storage.setItem(key, JSON.stringify({ ...api.defaultSettings(), maxSeats: 40, experimental: { flag: true } }));
  storage.removeItem(preservedKey);
  storage.removeItem(backupKey);

  const settings = api.readSettings();
  assert.equal(settings.maxSeats, 12, 'the live value is clamped to what this build supports');
  const preserved = JSON.parse(storage.getItem(preservedKey));
  assert.deepEqual(preserved.unknown.experimental, { flag: true }, 'a key from a newer build stays on disk');
  assert.deepEqual(preserved.outOfRange.maxSeats, { raw: 40, clamped: 12 }, 'the raw number is kept next to its clamp');

  const surface = api.createHotlistApi({
    getSettings: api.readSettings,
    writeSettings: api.writeSettings,
    resetSettings: api.resetSettings,
    onSettingsChange: api.onSettingsChange,
    preview: () => false,
  });
  assert.deepEqual(surface.settings.backups(), []);
  api.writeSettings({ maxSeats: 5 });
  const backups = surface.settings.backups();
  assert.equal(backups.length, 1, 'the blob replaced by a write is kept');
  assert.equal(typeof backups[0].at, 'number');
  assert.equal(backups[0].version, 4);

  api.resetSettings();
  storage.removeItem(preservedKey);
  storage.removeItem(backupKey);
});

// 62. An order that only ever equalled an old default is not a choice: it follows the new default.
test('legacy default order is adopted, real choices are kept', () => {
  const settings = api.sanitizeSettings({
    categories: {
      pinned: { order: 1 },
      pending: { order: 20 },
      completed: { order: 30 },
      running: { order: 40 },
    },
  });
  assert.equal(settings.categories.pinned.order, 15, 'the old pinned default (1) moves to 15');
  assert.equal(settings.categories.pending.order, 10, 'the old pending default (20) moves to 10');
  assert.equal(settings.categories.completed.order, 20, 'the old completed default (30) moves to 20');
  assert.equal(settings.categories.running.order, 30, 'the old running default (40) moves to 30');

  /** A number the user actually typed is a choice, even when it sits next to an old default. */
  const chosen = api.sanitizeSettings({
    categories: { pending: { order: 42 }, running: { order: 7 }, idle: { order: 60 } },
  });
  assert.equal(chosen.categories.pending.order, 42);
  assert.equal(chosen.categories.running.order, 7);
  assert.equal(chosen.categories.idle.order, 60, 'idle never had a competing default, so 60 is user input');

  /** The same rule covers a whole stored blob, which is how an old install actually arrives. */
  const stored = api.sanitizeSettings({ version: 4, categories: { pinned: { order: 0 }, error: { order: 10 } } });
  assert.equal(stored.categories.pinned.order, 15);
  assert.equal(stored.categories.error.order, 10);
});

// 63. The page offers 1-36 minutes; the store still accepts the whole 0-120 range an API caller may want.
test('recent window UI bounds are narrower than the API', () => {
  const rendered = renderPage();
  try {
    const row = collect(rendered.page, (props) => props['data-hotlist-row'] === 'recentWindow')[0];
    let control = null;
    walk(row, (node) => {
      if (control === null && node.props?.type === 'number') control = node;
    });
    assert.ok(control !== null, 'the recent window row has a number input');
    assert.equal(control.props.min, 1, 'the page starts at one minute: zero is not a human choice');
    assert.equal(control.props.max, 36, 'the page stops at 36 minutes');
  } finally {
    rendered.harness.cleanup();
  }

  /** An AI writing through the API is not held to the slider's bounds. */
  try {
    api.writeSettings({ collect: { recentWindowMinutes: 90 } });
    assert.equal(api.readSettings().collect.recentWindowMinutes, 90, '90 minutes survives the store');
    const stored = JSON.parse(storage.getItem('dsh.hotlist.settings.v1'));
    assert.equal(stored.collect.recentWindowMinutes, 90, 'and it is what lands on disk');
  } finally {
    api.writeSettings({ collect: { recentWindowMinutes: 5 } });
  }
});

// 64. v4.6.3 only moved default parameters: six categories, four fields each, plus the frozen idle artwork.
test('defaults for v4.6.3', () => {
  const settings = api.defaultSettings();
  const table = {
    pinned: { motion: 'bounce', motionTarget: 'row', frequency: 0.3, sound: true },
    error: { motion: 'bounce', motionTarget: 'row', frequency: 0.9, sound: true },
    pending: { motion: 'bounce', motionTarget: 'row', frequency: 0.9, sound: true },
    completed: { motion: 'spin', motionTarget: 'row', frequency: 1, sound: true },
    running: { motion: 'spin', motionTarget: 'row', frequency: 1, sound: false },
    idle: { motion: 'none', motionTarget: 'row', frequency: 0, sound: false },
  };
  for (const [category, want] of Object.entries(table)) {
    const entry = settings.categories[category];
    assert.equal(entry.glyph.motion, want.motion, `${category}.motion`);
    assert.equal(entry.glyph.motionTarget, want.motionTarget, `${category}.motionTarget`);
    assert.equal(entry.glyph.frequency, want.frequency, `${category}.frequency`);
    assert.equal(entry.sound.enabled, want.sound, `${category}.sound.enabled`);
  }
  assert.equal(settings.categories.idle.glyph.motion, 'none', 'idle never animates');
  assert.equal(settings.categories.idle.glyph.frequency, 0, 'idle never rolls for a burst');
  assert.equal(settings.categories.pending.glyphSecondary.motion, 'bounce', 'the question style moves like the rest of pending');
  assert.equal(api.CATEGORY_GLYPHS.idle, '🧊', 'idle shows an ice cube, not the three-codepoint sleep glyph');
  assert.equal(settings.sound.volume, 60, 'the global volume default did not move');
});

console.log(`PASS — ${groups} groups`);
