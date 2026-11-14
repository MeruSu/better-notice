// test/classify.test.mjs — runs the real client.js in Node against stubs.
// Covers the settings seam, the pure seat-plan builder, and the tab-row adapter.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const SRC_VERSION = /const VERSION = '([^']+)';/.exec(source)[1];
new Function(source)();

const api = loaded.api;
assert.equal(loaded.id, 'dsh-better-notice');
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

/** Slot kinds as the host declares them; only used by `slots.spec()`. */
const SLOT_SPECS = {
  'conversation.view': { kind: 'list', scope: 'session' },
  'shell.overlay': { kind: 'list', scope: 'root' },
  'settings.section': { kind: 'list', scope: 'root' },
  'settings.section.icon': { kind: 'list', scope: 'root' },
};

const ALL_SLOTS = Object.keys(SLOT_SPECS);

/**
 * `slotsDeclared` models the host's *declaration order*: a slot nobody has
 * declared yet cannot be registered into (`SlotCore.register` throws exactly
 * that), and `slots.inject(key, cb)` only runs `cb` once the key is declared.
 * Tests that do not care about the order get everything declared up front.
 */
function createCtx({
  list,
  statuses = new Map(),
  groups,
  workspace,
  binding = () => undefined,
  without = [],
  slotsDeclared = ALL_SLOTS,
}) {
  const declared = new Set(slotsDeclared);
  /** `inject` callbacks parked until their slot exists, mirroring the host. */
  const waiting = new Map();
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
      spec: (key) => (declared.has(key) === true && SLOT_SPECS[key] !== undefined ? SLOT_SPECS[key] : undefined),
      register: (spec, Component) => {
        if (declared.has(spec.name) === false) {
          throw new Error('slot "' + spec.name + '" is not declared (a parent entry\'s children table must declare it)');
        }
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
        if (declared.has(key)) {
          track(callback());
          return () => {};
        }
        const parked = waiting.get(key) ?? [];
        parked.push(callback);
        waiting.set(key, parked);
        return () => {};
      },
    },
  };
  const declareSlot = (key) => {
    declared.add(key);
    const parked = waiting.get(key) ?? [];
    waiting.delete(key);
    for (const callback of parked) track(callback());
  };
  return {
    declared,
    declareSlot,
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

const HERE = dirname(fileURLToPath(import.meta.url));

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
  assert.deepEqual(DEFAULTS.positions, { tab: true, topbar: true, sidebar: true });
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
  /** v4 shipped the top-bar switch disabled, so the archived `false` is the old factory default and yields to v5. */
  assert.deepEqual(migrated.positions, { tab: false, topbar: true, sidebar: true });
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
      pending: { order: 500, glyph: { kind: 'animated', value: 'xy' }, glyphSecondary: { value: '🎉' } },
      nope: { enabled: true },
      favorite: { enabled: true, glyph: { value: '🔥' } },
      error: { glyph: { value: 'overlongemoji' } },
    },
  }));
  const settings = api.readSettings();
  assert.equal(settings.version, 4);
  assert.equal(settings.maxSeats, 6);
  assert.deepEqual(settings.positions, { tab: true, topbar: true, sidebar: true });
  assert.equal(settings.overlay.side, 'auto');
  assert.equal(settings.overlay.sizeMax, 900);
  assert.equal(settings.overlay.fallbackImage, '');
  assert.equal(settings.collect.completedTtlMs, 60000);
  assert.equal(settings.pinned.maxSeats, 12);
  assert.equal(settings.categories.pending.order, 99);
  assert.equal(settings.categories.pending.glyph.kind, 'emoji');
  /** `kind` follows the pool now, and a non-image `value` is plain glyph text. */
  assert.equal(settings.categories.pending.glyph.value, 'xy', 'a short non-image value is plain glyph text');
  assert.equal(settings.categories.pending.glyph.uploads.length, 0);
  /** Text longer than the two-code-point limit is dropped, so the default glyph draws instead. */
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

  /** Idle is a window, not a flag: at the boundary yes, one second later no. */
  const windowMs = settings.collect.recentWindowMinutes * 60_000;
  const inside = api.classify(settings, {
    surface: 'sidebar',
    list: { ids: ['session-idle-at'], byId: { 'session-idle-at': session({ id: 'session-idle-at', updatedAt: NOW - windowMs }) } },
    statuses: new Map(),
    errors: new Map(),
    completedAt: new Map(),
    now: NOW,
    workspaceIds: null,
  });
  assert.deepEqual(inside.map((row) => row.category), ['idle']);
  const outside = api.classify(settings, {
    surface: 'sidebar',
    list: { ids: ['session-idle-at'], byId: { 'session-idle-at': session({ id: 'session-idle-at', updatedAt: NOW - windowMs - 1 }) } },
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
    surface: 'sidebar', list, statuses, errors: new Map(), completedAt: new Map(), now: NOW, workspaceIds: null,
  });
  const tokens = Object.fromEntries(rows.map((row) => [row.sessionId, `${row.category}:${row.token}`]));
  assert.equal(tokens.a, 'pending:approval');
  assert.equal(tokens.q, 'pending:question');
  assert.equal(tokens.p, 'pending:question');
  assert.equal(tokens.parent, 'running:running');
  assert.equal(rows.filter((row) => row.category === 'pending').length, 3);
});

// 8. A pin is a class with an `order` like any other: at the shipped order it loses to
// `idle`, and once its order is made cheaper it wins and follows the store list.
test('pinned follows the configured order', () => {
  const settings = api.defaultSettings();
  /** The workspace store, most recently pinned first: `pinLevel` is index + 1. */
  const pinnedSessionIds = ['s1', 's3'];
  const list = {
    ids: ['s1', 's2', 's3'],
    byId: { s1: session({ id: 's1' }), s2: session({ id: 's2', running: true }), s3: session({ id: 's3' }) },
  };
  const input = {
    surface: 'sidebar',
    list,
    statuses: new Map([['s2', { running: true }]]),
    errors: new Map(),
    completedAt: new Map(),
    now: NOW,
    workspaceIds: null,
    limit: 5,
    pinnedSessionIds,
  };
  /** Shipped order: `pinned` (60) sits behind `idle` (50), so a pinned recent session is idle. */
  const shipped = api.buildSeatPlan(input, settings);
  assert.deepEqual(shipped.map((seat) => [seat.sessionId, seat.order]), [['s2', 3001], ['s1', 5001], ['s3', 5002]]);
  assert.deepEqual(shipped.map((seat) => seat.token), ['running', 'idle', 'idle']);
  /** Make the pin the cheapest class and the same two rows become pins, in store order. */
  const cheap = api.defaultSettings();
  cheap.categories.pinned.order = 5;
  const plan = api.buildSeatPlan(input, cheap);
  assert.deepEqual(plan.map((seat) => [seat.sessionId, seat.order]), [['s1', 501], ['s3', 502], ['s2', 3001]]);
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
    surface: 'sidebar',
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
    surface: 'sidebar', list, statuses, errors, completedAt: new Map(), now: NOW, workspaceIds: null, limit: 2,
  }, settings);
  assert.deepEqual(plan.map((seat) => seat.category), ['error', 'error', 'pending', 'running', 'running']);
  /** `me` is still inside the idle window, so it is classified but cut by the limit. */
  assert.equal(plan.overflow, 1);
  const withCurrent = api.buildSeatPlan({
    surface: 'sidebar', list, statuses, errors, completedAt: new Map(), now: NOW, workspaceIds: null, limit: 5, currentId: 'ask',
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
    surface: 'sidebar', list, statuses, errors: new Map(), completedAt: new Map(), now: NOW, workspaceIds: null, limit: 1,
  }, settings);
  assert.equal(plan.length, 5);
  assert.equal(plan.overflow, 2);
  assert.deepEqual(plan.map((seat) => seat.sessionId), ['p1', 'p2', 'p3', 'p4', 'p5']);
});

// 11. A surface that is off produces no rows; turning `idle.tab` off keeps the sidebar row.
test('surface gating', () => {
  const settings = api.defaultSettings();
  /** The shipped split: the band is the urgent row, the tab row is the background row. */
  const split = ['pinned', 'error', 'pending', 'completed', 'running', 'idle'].map((category) => [
    category,
    settings.categories[category].surfaces.tab,
    settings.categories[category].surfaces.topbar,
  ]);
  assert.deepEqual(split, [
    ['pinned', true, false],
    ['error', false, true],
    ['pending', false, true],
    ['completed', false, true],
    ['running', false, false],
    ['idle', true, false],
  ]);

  const list = {
    ids: ['idle1', 'run1', 'err1'],
    byId: { idle1: session({ id: 'idle1' }), run1: session({ id: 'run1', running: true }), err1: session({ id: 'err1' }) },
  };
  const statuses = new Map([['run1', { running: true }]]);
  const errors = new Map([['err1', { message: 'boom', at: NOW }]]);
  const input = { list, statuses, errors, completedAt: new Map(), now: NOW, workspaceIds: null, limit: 5 };
  const tab = api.buildSeatPlan({ ...input, surface: 'tab' }, settings);
  assert.deepEqual(tab.map((seat) => seat.sessionId), ['idle1'], 'the tab row shows the background classes only');
  const band = api.buildSeatPlan({ ...input, surface: 'topbar' }, settings);
  assert.deepEqual(band.map((seat) => seat.sessionId), ['err1'], 'the band shows the urgent classes only');
  const sidebar = api.classify(settings, { ...input, surface: 'sidebar' });
  assert.deepEqual(sidebar.map((row) => row.sessionId).sort(), ['err1', 'idle1', 'run1'], 'the sidebar still shows all six');

  /** Every surface off is the same as "hide", not a fallback to the tab row. */
  const off = api.sanitizeSettings({
    ...settings,
    positions: { tab: false, topbar: false, sidebar: false },
    /** Marked: an unmarked `false` is the v4 factory default and would yield to the v5 default. */
    choices: { 'positions.topbar': true },
  });
  assert.equal(api.positionsOf(off).allPositionsOff, true);
  assert.equal(api.positionsOf(off).surfaceVisible, false);
});

// 11b. `idle` keeps its tab seat by default: the third tier is what the user asked for in the tab row.
test('idle third tier on the tab row', () => {
  const settings = api.defaultSettings();
  assert.equal(settings.categories.idle.surfaces.tab, true);
  assert.equal(settings.collect.recentWindowMinutes, 17);
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
  /** A pin is the weakest class at the shipped order (60 > idle's 50), so the idle window wins. */
  assert.equal(api.sidebarStateOf({ ...base, session: row, status: undefined, pinned: true }), 'idle');
  /** A run or a finish still owns the row: their order is smaller than the pin's. */
  assert.equal(api.sidebarStateOf({ ...base, session: row, status: { running: true }, pinned: true }), 'running');
  assert.equal(api.sidebarStateOf({ ...base, session: row, status: { completionUnread: true }, pinned: true }), 'completed');
  assert.equal(api.sidebarStateOf({ ...base, session: row, status: undefined, pinned: true, error: { message: 'x', at: NOW } }), 'error');
  /** Make the pin the cheapest class and it wins over the idle window, because order is a setting. */
  const cheapPin = api.sanitizeSettings({ ...settings, categories: { pinned: { order: 5 } } });
  assert.equal(api.sidebarStateOf({ ...base, settings: cheapPin, session: row, status: undefined, pinned: true }), 'pinned');
  assert.equal(api.sidebarStateOf({ ...base, session: row, status: { completionUnread: true } }), 'completed');
  assert.equal(api.sidebarStateOf({ ...base, session: row, status: undefined }), 'idle');
  const old = session({ id: 'y', updatedAt: NOW - settings.collect.recentWindowMinutes * 60_000 - 1 });
  assert.equal(api.sidebarStateOf({ ...base, session: old, status: undefined }), null);
  /** Visible on the tab row only: the class still wins, but this surface cannot draw it. */
  settings.categories.running.surfaces = { tab: true, sidebar: false, topbar: false };
  /** No fall-through: the winning class is off on this surface, so the row shows nothing. */
  assert.equal(api.sidebarStateOf({ ...base, session: row, status: { running: true } }), null);
  /** …unless a cheaper class also qualifies: `pending` (10) beats `running` (30) and is visible. */
  assert.equal(api.sidebarStateOf({ ...base, session: row, status: { running: true, pendingInteraction: { kind: 'approval' } } }), 'approval');
  /** A class that is off on all three surfaces stops existing, so the row falls to the next one. */
  settings.categories.running.surfaces = { tab: false, sidebar: false, topbar: false };
  assert.equal(api.sidebarStateOf({ ...base, session: row, status: { running: true } }), 'idle');
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
  /** `pinned` is an ordinary class now: order 60, not a forced 0. */
  assert.equal(api.sanitizeSettings({ pinLevels: {} }).categories.pinned.order, 60);
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
  assert.deepEqual(seats(), [['s1', 5001]], 'running belongs to the band and the sidebar now, so s2 earns no tab seat');
  const registrations = harness.registrations.length;

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
  assert.equal(charOf(pinnedRow.row), '🧊');
  /** Make the pin the cheapest class and the same row turns into a pin, without a restart. */
  settings.categories.pinned.order = 5;
  adapter.refresh();
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
  assert.equal(page.props['data-hotlist-settings'], `v${SRC_VERSION}`);

  const rows = collect(page, (props) => typeof props['data-hotlist-row'] === 'string')
    .map((node) => node.props['data-hotlist-row']);
  for (const key of [
    'maxSeats', 'pinned.maxSeats', 'collect.completedTtlMs', 'sound.volume', 'recentWindow',
    'positions.tab', 'positions.topbar',
    'takeOverStatusDot',
    'ring.pending', 'ring.error', 'ring.completed',
  ]) {
    assert.equal(rows.includes(key), true, `missing row ${key}`);
  }
  /** v4.4 and v4.5 removed these rows: the fields survive for compatibility, the controls do not. */
  /** The full-screen ring is its own group, next to the sounds, not inside them. */
  const ringGroups = collect(page, (props) => props['data-hotlist-ring'] !== undefined);
  assert.equal(ringGroups.length, 1, 'the ring group renders once');
  const ringTitles = collect(ringGroups[0], (props) => props.className === 'hl-groupTitle').map((node) => node.children);
  assert.deepEqual(ringTitles, ['settings.group.ring'], 'the group is titled, and the title is the ring one');
  for (const key of ['hideNativeDot', 'shortcuts.jumpEnabled', 'shortcuts.overlayEnabled', 'shortcuts.keys', 'reset', 'within', 'overlay.size']) {
    assert.equal(rows.includes(key), false, `removed row ${key} is still rendered`);
  }
  for (const category of ['pinned', 'error', 'pending', 'completed', 'running', 'idle']) {
    assert.equal(rows.includes(`categories.${category}`), true, `missing card ${category}`);
  }
  assert.equal(rows.includes('categories.favorite'), false, 'the retired favorite card is gone');

  const cards = collect(page, (props) => typeof props['data-category'] === 'string')
    .map((node) => node.props['data-category']);
  assert.deepEqual(cards, ['error', 'pending', 'completed', 'running', 'idle', 'pinned']);
  assert.equal(collect(page, (props) => props['data-hotlist-card-body'] !== undefined).length, 0);

  const chips = collect(page, (props) => props.className === 'hl-chip');
  assert.equal(chips.length, 30);
  for (const chip of chips) {
    assert.equal(typeof chip.props['aria-label'], 'string');
    assert.equal(['true', 'false'].includes(chip.props['data-on']), true);
  }
  /** The top-bar chip mirrors the per-category switch instead of sitting disabled. */
  const topbarChips = chips.filter((chip) => chip.props['aria-label'] === 'settings.chip.topbar');
  assert.equal(topbarChips.length, 6, 'every card announces its top-bar surface');
  assert.equal(topbarChips.every((chip) => chip.props['data-disabled'] === 'false'), true);
  assert.equal(topbarChips.filter((chip) => chip.props['data-on'] === 'true').length, 3, 'error, pending and completed ride the band by default');

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
  /** `error` now asks for 5, so it leads the tie-break group; `pinned` sits at 60, last but idle. */
  assert.deepEqual(cards.slice(0, 3), ['error', 'pending', 'completed']);
  assert.equal(cards[cards.length - 1], 'pinned');
  assert.equal(cards[cards.length - 2], 'idle');
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
    surface: 'sidebar', list: { ids, byId }, statuses: new Map(), errors: new Map(), completedAt: new Map(), now: NOW, workspaceIds: null, limit: 1,
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
  assert.equal(api.assetRef('error', 320), 'plugins/dsh-better-notice/assets/error-320.webp');
  assert.equal(api.fallbackRef('error'), 'plugins/dsh-better-notice/assets/error.svg');
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

// 37. Playback frequency: 0 never plays, the max is every beat, and a v4.3 interval migrates onto the same scale.
test('playback frequency sanitising', () => {
  const at = (value) => api.sanitizeSettings({ categories: { pending: { glyph: { frequency: value } } } }).categories.pending.glyph.frequency;

  assert.equal(at(0), 0);
  /**
   * 1 was every class's v4.4 factory default, and `pending` defaults to 0.9 now, so a stored
   * 1 follows the new default instead of pinning the old one.
   */
  assert.equal(at(1), 0.9, 'an old factory default gives way to the class default');
  assert.equal(at(0.42), 0.4, 'the slider only has 5% steps');
  /** The max clamps to 1 — itself an old default — so the class default is what survives. */
  assert.equal(at(9), 0.9, 'out-of-range clamps to the max, which the preset rule then retires');
  assert.equal(at(-3), 0);
  assert.equal(at(0.65), 0.65, 'a value that was never a default is a choice and stays');

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
  assert.equal(loaded.id, 'dsh-better-notice');
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

  /** The old default is indistinguishable from "nothing set", so it follows the current default. */
  const oldDefault = api.sanitizeSettings({ categories: { idle: { within: 5 } } });
  assert.equal(oldDefault.collect.recentWindowMinutes, 17, 'an unmarked 5 was the old default, not a pick');

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
  /**
   * `spin` and a 1 default: `blink` and frequency 1 are v4.4 factory presets, so v4.6.4
   * replaces them and the rendered animation would no longer be the one this group pins.
   */
  api.writeSettings({ categories: { completed: { glyph: { motion: 'spin', frequency: 1 } } } });
  try {
    const full = renderPage();
    assert.equal(glyphFor(full.page, 'completed').props.style.animation, 'hl-pv-spin-20 2400ms linear infinite', '100% plays every loop at the base tempo');
    full.harness.cleanup();

    api.writeSettings({ categories: { completed: { glyph: { motion: 'spin', frequency: 0.5 } } } });
    const half = renderPage();
    assert.equal(glyphFor(half.page, 'completed').props.style.animation, 'hl-pv-spin-10 4800ms linear infinite', '50% halves the duty cycle and doubles the period');
    half.harness.cleanup();

    /** A class at 0% renders a still glyph: the animation is not merely slow, it is absent. */
    api.writeSettings({ categories: { completed: { glyph: { motion: 'spin', frequency: 0 } } } });
    const still = renderPage();
    assert.equal(glyphFor(still.page, 'completed').props.style.animation, undefined);
    still.harness.cleanup();

    /** Reduce motion overrides the slider entirely. */
    api.writeSettings({ categories: { completed: { glyph: { motion: 'spin', frequency: 1 } } }, display: { reduceMotion: 'on' } });
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
    surface: 'sidebar', list: { ids, byId }, statuses: new Map(), errors: new Map(), completedAt: new Map(),
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
    surface: 'sidebar', list: withError, statuses: new Map(), errors: new Map([['err', { message: 'boom', at: NOW }]]),
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

  /**
   * Both stored values are choices this build never shipped as a default: `pulse` was
   * never error's motion and `0.35` was never any class's frequency. (`motionTarget: 'glyph'`
   * and a frequency of 1 would be v4.4 factory presets and are covered by the group below.)
   */
  const stored = {
    ...settings,
    categories: {
      ...settings.categories,
      error: {
        ...settings.categories.error,
        glyph: { ...settings.categories.error.glyph, motion: 'pulse', frequency: 0.35 },
      },
    },
  };
  const sanitized = api.sanitizeSettings(stored);
  assert.equal(sanitized.categories.error.glyph.motion, 'pulse', 'a stored motion beats the new default');
  assert.equal(sanitized.categories.error.glyph.frequency.toFixed(2), '0.35', 'and so does the stored frequency');
  assert.equal(sanitized.categories.error.glyph.motionTarget, 'row', 'the untouched default still lands');
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
  assert.equal(settings.categories.pinned.order, 60, 'the old pinned default (1) moves to 60');
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
  assert.equal(stored.categories.pinned.order, 60);
  assert.equal(stored.categories.error.order, 10);
});

// 63. The page offers the same 1-120 range the store does; only zero stays out of the UI.
test('recent window UI bounds match the API', () => {
  const rendered = renderPage();
  try {
    const row = collect(rendered.page, (props) => props['data-hotlist-row'] === 'recentWindow')[0];
    let control = null;
    walk(row, (node) => {
      if (control === null && node.props?.type === 'number') control = node;
    });
    assert.ok(control !== null, 'the recent window row has a number input');
    assert.equal(control.props.min, 1, 'the page starts at one minute: zero is not a human choice');
    assert.equal(control.props.max, 120, 'the page reaches the store maximum');
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

/**
 * 65. The other half of the non-destructive rule: a stored value that only ever equalled one of
 * our own factory presets was never a choice, so the current preset replaces it. Anything else —
 * including a value that merely looks similar — is the user's and must survive byte for byte.
 */
test('factory presets are replaced, user choices are kept', () => {
  /** Exactly what v4.6.3 wrote out: its own defaults, untouched by the user. */
  const oldDefaults = {
    version: 4,
    maxSeats: 6,
    categories: {
      pinned: { glyph: { motion: 'bounce', motionTarget: 'row', frequency: 0.3 }, sound: { enabled: true } },
      /** v4.4 shipped `blink` everywhere and a flat frequency of 1. */
      error: { glyph: { motion: 'blink', motionTarget: 'glyph', frequency: 1 }, sound: { enabled: false } },
      pending: {
        glyph: { motion: 'blink', motionTarget: 'glyph', frequency: 1 },
        glyphSecondary: { motion: 'blink', frequency: 1 },
        sound: { enabled: false },
      },
      completed: { glyph: { motion: 'none', motionTarget: 'glyph', frequency: 1 }, sound: { enabled: false } },
      running: { glyph: { motion: 'none', motionTarget: 'glyph', frequency: 1 }, sound: { enabled: false } },
      /** `💤` is the generation this release exists to retire. */
      idle: { glyph: { value: '💤', motion: 'none', motionTarget: 'glyph', frequency: 1 }, sound: { enabled: false } },
      pinned_order: { order: 0 },
    },
  };
  const migrated = api.sanitizeSettings(oldDefaults);
  assert.equal(migrated.categories.idle.glyph.value, '🧊', 'the retired sleep glyph follows the new preset');
  assert.equal(migrated.categories.idle.glyph.frequency, 0, 'idle stops rolling');
  assert.equal(migrated.categories.error.glyph.motion, 'bounce', 'a stored `blink` was our default, not a choice');
  assert.equal(migrated.categories.error.glyph.motionTarget, 'row', 'so was a stored `glyph`');
  assert.equal(migrated.categories.error.glyph.frequency, 0.9, 'and so was a flat 1');
  assert.equal(migrated.categories.pending.glyph.motion, 'bounce');
  assert.equal(migrated.categories.pending.glyphSecondary.motion, 'bounce', 'the question style follows pending');
  assert.equal(migrated.categories.completed.glyph.motion, 'spin');
  assert.equal(migrated.categories.completed.glyph.frequency, 1, 'completed really does default to 1');
  assert.equal(migrated.categories.running.glyph.motion, 'spin');
  assert.equal(migrated.categories.error.sound.enabled, true, 'sound defaulted to on for the four loud classes');
  assert.equal(migrated.categories.completed.sound.enabled, true);
  assert.equal(migrated.categories.running.sound.enabled, false, 'running stays quiet: that is its current default too');
  assert.equal(migrated.categories.pinned.glyph.frequency.toFixed(2), '0.30', 'pinned already matched the current default');
  assert.deepEqual(
    migrated.categories.idle.glyph.value !== oldDefaults.categories.idle.glyph.value
    || migrated.categories.error.glyph.motion !== oldDefaults.categories.error.glyph.motion,
    true,
    'the whole point: the old presets did not survive',
  );

  /** The same file with a few real edits: nothing that differs from a preset may be touched. */
  const choices = api.sanitizeSettings({
    version: 4,
    categories: {
      idle: { glyph: { value: '🌙', motion: 'pulse', motionTarget: 'glyph', frequency: 0.15 } },
      error: { glyph: { motion: 'blink', frequency: 1 }, sound: { enabled: true } },
      pending: { glyphSecondary: { motion: 'spin', value: '❓' } },
      pinned: { order: 7 },
    },
  });
  assert.equal(choices.categories.idle.glyph.value, '🌙', 'a moon is not our preset');
  assert.equal(choices.categories.idle.glyph.motion, 'pulse');
  /** `glyph` is a retired preset for this field, so even in a hand-edited file it follows `row`. */
  assert.equal(choices.categories.idle.glyph.motionTarget, 'row', 'a value equal to a preset cannot be told from one');
  assert.equal(choices.categories.idle.glyph.frequency.toFixed(2), '0.15');
  assert.equal(choices.categories.error.glyph.motion, 'bounce', 'motion was still our default, so it moves on');
  assert.equal(choices.categories.error.glyph.frequency, 0.9, 'and so was the frequency');
  assert.equal(choices.categories.error.sound.enabled, true, 'but this user had already turned the sound on');
  assert.equal(choices.categories.pending.glyphSecondary.motion, 'spin', 'a real motion choice is kept');
  assert.equal(choices.categories.pending.glyphSecondary.value, '❓', 'the question mark is pending\'s shipped glyph');
  assert.equal(choices.categories.pinned.order, 7, 'a hand-set order is not a default');

  /** The two glyph slots keep their own tables: `glyphSecondary` must not inherit `glyph`'s. */
  const secondary = api.sanitizeSettings({
    categories: { pending: { glyphSecondary: { motion: 'blink' }, glyph: { motion: 'none' } } },
  });
  assert.equal(secondary.categories.pending.glyphSecondary.motion, 'bounce', '`blink` was the shipped secondary motion');
  assert.equal(secondary.categories.pending.glyph.motion, 'bounce', 'and `none` was the shipped primary motion');
  /** `none` was never a preset for the secondary slot, so there it is a real choice. */
  const quiet = api.sanitizeSettings({ categories: { pending: { glyphSecondary: { motion: 'none' } } } });
  assert.equal(quiet.categories.pending.glyphSecondary.motion, 'none', 'the tables are per slot, not shared');
  assert.equal(quiet.categories.pending.glyph.motion, 'bounce', 'and the primary slot still follows its own default');

  /** Reading twice must not keep rewriting: the second pass is byte-identical. */
  const once = api.sanitizeSettings(oldDefaults);
  const twice = api.sanitizeSettings(once);
  assert.deepEqual(twice, once, 'the preset rule is idempotent');
});

/**
 * 66. The other side of the preset rule: a field the user picked himself is his, even when the value
 * happens to equal a factory preset. `choices` records the picks, and the gate reads it first.
 */
test('user picks survive the preset rule', () => {
  const key = 'dsh.hotlist.settings.v1';
  const preservedKey = 'dsh.betterNotice.preserved.v1';
  const backupKey = 'dsh.betterNotice.backup.v1';
  storage.removeItem(key);
  storage.removeItem(preservedKey);
  storage.removeItem(backupKey);
  api.resetSettings();
  assert.deepEqual(api.readSettings().choices, {}, 'a fresh install has no markers');

  /** (2) The worst case: switching a class sound off must stay off instead of bouncing back on. */
  api.writeSettings({ categories: { error: { sound: { enabled: false } } } });
  assert.deepEqual(api.readSettings().choices, { 'categories.error.sound.enabled': true }, 'the marker records the pick');
  assert.equal(api.readSettings().categories.error.sound.enabled, false, 'the user switched this class off');
  assert.equal(
    api.sanitizeSettings(JSON.parse(storage.getItem(key))).categories.error.sound.enabled,
    false,
    'and a later read of the stored blob leaves it off',
  );

  /** (3) Every control the wide gate used to make dead now lands. */
  api.writeSettings({
    categories: {
      completed: { glyph: { motion: 'none' } },
      pending: { glyph: { motion: 'blink' }, glyphSecondary: { motion: 'none' } },
      running: { glyph: { motionTarget: 'glyph' } },
      pinned: { glyph: { frequency: 1 } },
      idle: { glyph: { value: '💤' } },
    },
  });
  const picked = api.readSettings();
  assert.equal(picked.categories.completed.glyph.motion, 'none', 'a class can be told not to move');
  assert.equal(picked.categories.pending.glyph.motion, 'blink', 'a retired motion is still a pick');
  assert.equal(picked.categories.pending.glyphSecondary.motion, 'none', 'the question style keeps its own pick');
  assert.equal(picked.categories.running.glyph.motionTarget, 'glyph', 'icon-only is reachable');
  assert.equal(picked.categories.pinned.glyph.frequency, 1, 'and the slider reaches 100%');
  assert.equal(picked.categories.idle.glyph.value, '💤', 'even the glyph we retired stays when the user picked it');

  /** (4) The marker alone decides: the value does not have to look unusual. */
  const marked = api.sanitizeSettings({
    choices: { 'categories.error.glyph.motion': true, 'categories.error.glyph.frequency': true },
    categories: { error: { glyph: { motion: 'blink', frequency: 1 } } },
  });
  assert.equal(marked.categories.error.glyph.motion, 'blink', 'a marked field survives its own old default');
  assert.equal(marked.categories.error.glyph.frequency, 1, 'and so does a marked 100%');

  /** (1) The neighbour the user never touched still follows the current preset. */
  const untouched = api.sanitizeSettings({
    choices: { 'categories.error.glyph.motion': true },
    categories: { error: { glyph: { motion: 'blink', motionTarget: 'glyph' } } },
  });
  assert.equal(untouched.categories.error.glyph.motion, 'blink', 'the marked field stays');
  assert.equal(untouched.categories.error.glyph.motionTarget, 'row', 'the unmarked neighbour updates');

  /** (5) A backup keeps the markers, so a restore does not lose the picks behind them. */
  api.writeSettings({ categories: { idle: { glyph: { value: '🌙' } } } });
  assert.equal(api.readSettings().categories.idle.glyph.value, '🌙');
  api.writeSettings({ categories: { idle: { glyph: { value: '🧊' } } } });
  assert.equal(api.readSettings().categories.idle.glyph.value, '🧊', 'a new pick lands');
  const surface = api.createHotlistApi({
    getSettings: api.readSettings,
    writeSettings: api.writeSettings,
    resetSettings: api.resetSettings,
    onSettingsChange: api.onSettingsChange,
    preview: () => false,
  });
  assert.equal(surface.settings.restore(0).ok, true, 'the newest backup can be put back');
  assert.equal(api.readSettings().categories.idle.glyph.value, '🌙', 'the earlier pick returns');
  assert.equal(api.readSettings().choices['categories.idle.glyph.value'], true, 'together with its marker');

  /** (6) A reset forgets the markers: the presets are factory again. */
  api.resetSettings();
  assert.deepEqual(api.readSettings().choices, {}, 'a reset clears every marker');
  assert.equal(
    api.sanitizeSettings({ categories: { error: { glyph: { motion: 'blink' } } } }).categories.error.glyph.motion,
    'bounce',
    'and the presets rule again',
  );

  /** (7) Idempotent, markers included. */
  const once = api.sanitizeSettings({
    choices: { 'categories.pending.glyph.motion': true },
    categories: { pending: { glyph: { motion: 'blink' } } },
  });
  assert.deepEqual(api.sanitizeSettings(once), once, 'a second pass changes nothing');

  /** (8) The marker map is cleaned on the way in: only `true`, only real paths, only short keys. */
  const cleaned = api.sanitizeChoices({
    'categories.pending.glyph.motion': true,
    'categories.pending.glyph.frequency': false,
    'not.a.real.path': true,
    [`categories.pending.glyph.${'x'.repeat(90)}`]: true,
    'categories.pending.glyph.motionTarget': true,
  });
  assert.deepEqual(
    Object.keys(cleaned),
    ['categories.pending.glyph.motion', 'categories.pending.glyph.motionTarget'],
    'false, unknown shapes and oversized keys are dropped',
  );

  storage.removeItem(key);
  storage.removeItem(preservedKey);
  storage.removeItem(backupKey);
  api.resetSettings();
});

// 66. The band: one entry in `shell.overlay`, no tab seats, the current pill first.
/** The band only shows categories switched on for it: these two flip every one of them. */
const topbarSurfaces = (on) => {
  const categories = {};
  for (const id of Object.keys(DEFAULTS.categories)) {
    categories[id] = { surfaces: { ...DEFAULTS.categories[id].surfaces, topbar: on } };
  }
  return { categories };
};

const enableTopbar = () => api.writeSettings({
  positions: { ...api.readSettings().positions, topbar: true },
  topbar: { ...api.readSettings().topbar, mode: 'chips', previewInWeb: true },
  ...topbarSurfaces(true),
});

const disableTopbar = () => api.writeSettings({
  positions: { ...api.readSettings().positions, topbar: false },
  topbar: { ...api.readSettings().topbar, mode: 'chips', previewInWeb: false },
  ...topbarSurfaces(false),
});

test('topbar band coexists with the tab row', () => {
  const ids = ['band-a', 'band-b'];
  const byId = {};
  for (const id of ids) byId[id] = session({ id, retainedBy: id === 'band-a' ? { mainView: 1 } : {} });
  const healBefore = storage.getItem('dsh.conversation.session-a');
  assert.equal(healBefore, JSON.stringify({ view: 'chat' }), 'the seat preference was repaired when the module loaded');

  enableTopbar();
  const harness = createCtx({
    list: { ids, byId },
    statuses: new Map(),
    groups: { items: [{ workspaceId: 'w', sessionIds: ids }], archivedSessionIds: [] },
  });
  api.apply(harness.ctx, {});

  const seatIds = [...harness.entries.keys()].filter((id) => id.startsWith('hotlist-seat-'));
  assert.deepEqual(seatIds, ['hotlist-seat-band-b'], 'the tab row keeps its own seats while the band is up');
  const entry = harness.entries.get('hotlist.topbar');
  assert.ok(entry, 'the band entry is registered in shell.overlay');
  assert.equal(entry.order, -10, 'under the toasts, above nothing it needs to cover');

  const reading = win.__HOTLIST__.topbar();
  assert.equal(reading.mounted, true);
  assert.equal(reading.mode, 'chips');
  assert.equal(reading.left, 216, 'a browser has no menu strip: 48 + 160 + 8');
  assert.equal(reading.measured, null, 'and nothing to measure');
  assert.equal(reading.reserve, 0, 'the reserve setting defaults to 0: the guard is code, not a value');
  assert.equal(reading.currentId, 'band-a');
  assert.deepEqual(reading.chips.map((chip) => chip.id), ['band-b'], 'the band skips the session the tab row already names');

  let band = entry.Component({});
  if (typeof band.type === 'function') band = band.type(band.props);
  assert.equal(band.props['data-hotlist-topbar-mode'], 'chips');
  assert.equal(band.props['data-hotlist-topbar-left'], '216');
  assert.equal(band.props['data-hotlist-version'], SRC_VERSION);
  assert.equal(band.props.style.height, 'var(--dsh-windows-titlebar-height, 40px)');
  assert.equal(band.props.style.pointerEvents, 'none');
  assert.equal(band.props.style.background, undefined, 'the band itself never paints');
  assert.equal(band.props.style.border, undefined);
  assert.equal(band.props.style.paddingLeft, '216px');
  assert.equal(band.props.style.paddingRight, '0px');

  const pills = collect(band, (props) => typeof props['data-hotlist-chip'] === 'string');
  assert.deepEqual(pills.map((pill) => pill.props['data-hotlist-chip']), ['band-b'], 'the session the tab row already names is not a pill');
  const bandPill = pills.find((pill) => pill.props['data-hotlist-chip'] === 'band-b');
  assert.ok(bandPill, 'the band renders its one session');
  assert.ok([undefined, 'none'].includes(bandPill.props.style.background), 'no fill');
  assert.equal(bandPill.props.style.borderRadius, undefined, 'no radius: it is text, not a pill');
  assert.equal(bandPill.props.style.padding, '0 6px');
  assert.equal(bandPill.props.style.cursor, 'pointer', 'the pointer is the only affordance');
  assert.ok([undefined, '0'].includes(bandPill.props.style.border), 'and no frame: separation is a hairline');
  assert.equal(bandPill.props.style.width, `${Math.min(140, api.chipWidthOf('会话 band-b') + 18)}px`, 'emoji column + label estimate, capped at the pill maximum');
  for (const pill of pills) {
    assert.equal(pill.props.style.pointerEvents, 'auto', 'the gap around it stays draggable');
    assert.equal(pill.props.style.WebkitAppRegion, 'no-drag');
    assert.equal(pill.props.style.width, pill.props.style.maxWidth, 'the pill is laid out with the estimate fitChipCount counted with');
    assert.equal(pill.props.tabIndex, -1, 'the host owns the focus ring; chips are mouse-only');
  }
  assert.equal(collect(band, (props) => props['data-hotlist-more'] !== undefined).length, 0, 'everything fits at this width');

  /** The preference repair is unconditional and module level: `topbar: true` must not skip it. */
  assert.match(source, /\n {4}healViewPreferences\(\);\n/, 'the heal call is still there, unguarded');
  assert.match(source, /function healViewPreferences\(\)/);
  assert.equal(storage.getItem('dsh.conversation.session-a'), JSON.stringify({ view: 'chat' }), 'still repaired after the band mounted');
  assert.equal(storage.getItem('dsh.conversation.session-b'), JSON.stringify({ view: 'chat' }), 'a seat id is repaired too');
  assert.equal(storage.getItem('dsh.conversation.session-e'), JSON.stringify({ view: 'trajectory' }), 'a preference we do not own is untouched');

  harness.cleanup();
  disableTopbar();
  assert.equal(win.__HOTLIST__.topbar().mounted, false, 'turning the band off unmounts it');
});

// 67. In a browser the band needs an explicit preview; on the desktop the strip alone is enough.
test('topbar needs the desktop strip or an explicit preview', () => {
  const settings = api.defaultSettings();
  assert.equal(settings.positions.topbar, true, 'on by default since v5');
  assert.equal(settings.topbar.previewInWeb, false, 'a browser draws nothing by default');
  assert.equal(settings.topbar.mode, 'chips');
  assert.equal(settings.topbar.rightReservePx, 0);

  const ids = ['web-a', 'web-b'];
  const byId = {};
  for (const id of ids) byId[id] = session({ id, retainedBy: id === 'web-a' ? { mainView: 1 } : {} });
  const open = () => {
    const harness = createCtx({
      list: { ids, byId },
      statuses: new Map(),
      groups: { items: [{ workspaceId: 'w', sessionIds: ids }], archivedSessionIds: [] },
    });
    api.apply(harness.ctx, {});
    return harness;
  };
  const seatsOf = (harness) => [...harness.entries.keys()].filter((id) => id.startsWith('hotlist-seat-'));

  /** Defaults: the tab row is the surface. */
  let harness = open();
  assert.equal(harness.entries.has('hotlist.topbar'), false, 'previewInWeb is false in a browser');
  assert.equal(seatsOf(harness).length, 1, 'the tab row keeps its seat');
  harness.cleanup();

  /** `topbar` on but no preview: the band stays down and the seats stay up. */
  api.writeSettings({ positions: { ...api.readSettings().positions, topbar: true } });
  harness = open();
  assert.equal(harness.entries.has('hotlist.topbar'), false, 'the band needs the desktop strip or an explicit preview');
  assert.equal(seatsOf(harness).length, 1, 'the tab row is the surface while the band cannot show');
  harness.cleanup();

  /** The desktop strip alone mounts it; the tab row keeps its own seats either way. */
  html.setAttribute('data-windows-titlebar', '');
  harness = open();
  assert.equal(harness.entries.has('hotlist.topbar'), true, 'the desktop strip is enough without the preview flag');
  assert.equal(seatsOf(harness).length, 1, 'the tab row is not the band\'s to switch off');
  harness.cleanup();
  html.removeAttribute('data-windows-titlebar');

  /** `mode: off` is the kill switch, preview or not. */
  api.writeSettings({ topbar: { ...api.readSettings().topbar, mode: 'off' } });
  html.setAttribute('data-windows-titlebar', '');
  harness = open();
  assert.equal(harness.entries.has('hotlist.topbar'), false, 'mode off mounts nothing');
  assert.equal(seatsOf(harness).length, 1, 'and the tab row takes the row back');
  harness.cleanup();
  html.removeAttribute('data-windows-titlebar');

  disableTopbar();
});

// 68. How many pills fit is arithmetic; what is left over becomes `+N`, which walks the tail.
test('topbar overflow counts pills and +N walks the hidden ones', () => {
  assert.equal(api.chipWidthOf(''), 72, 'a blank session still gets a pill');
  assert.equal(api.chipWidthOf('ab'), 72, 'under the minimum');
  assert.equal(api.chipWidthOf('abcd'), 72, '24 + 4 * 12 = 72 exactly');
  assert.equal(api.chipWidthOf('abcdefgh'), 120);
  assert.equal(api.chipWidthOf('😀'.repeat(10)), 140, 'counted in code points, capped at the max');
  assert.equal(api.chipWidthOf('x'.repeat(40)), 140);

  assert.equal(api.fitChipCount([72, 72], 100), 1, 'one pill; the +N pill would need 44 more');
  assert.equal(api.fitChipCount([72, 72], 148), 2, 'both fit, so there is no +N pill to reserve for');
  assert.equal(api.fitChipCount([72, 72, 72, 72, 72], 400), 5);
  assert.equal(api.fitChipCount([72, 72, 72, 72, 72], 300), 3, 'three pills plus the reserved +N pill');
  assert.equal(api.fitChipCount([72], 1000), 1);
  assert.equal(api.fitChipCount([72, 72, 72], 0), 3, 'an unreadable width shows everything instead of blinking');
  assert.equal(api.fitChipCount([72, 72, 72], Number.NaN), 3);
  assert.equal(api.fitChipCount([], 400), 0);

  const ids = ['ov-a', 'ov-b', 'ov-c', 'ov-d', 'ov-e', 'ov-f'];
  const byId = {};
  for (const id of ids) byId[id] = session({ id, retainedBy: id === 'ov-a' ? { mainView: 1 } : {} });
  enableTopbar();
  win.innerWidth = 900;
  const harness = createCtx({
    list: { ids, byId },
    statuses: new Map(),
    groups: { items: [{ workspaceId: 'w', sessionIds: ids }], archivedSessionIds: [] },
  });
  api.apply(harness.ctx, {});
  const entry = harness.entries.get('hotlist.topbar');
  const render = () => {
    let band = entry.Component({});
    if (typeof band.type === 'function') band = band.type(band.props);
    return band;
  };
  const reading = win.__HOTLIST__.topbar();
  assert.equal(reading.chips.length, 5, 'five seats: the current session is never a pill');

  const band = render();
  const pills = collect(band, (props) => typeof props['data-hotlist-chip'] === 'string');
  const more = collect(band, (props) => props['data-hotlist-more'] !== undefined);
  assert.equal(more.length, 1, 'the narrow window leaves a tail behind');
  const hidden = Number(more[0].props['data-hotlist-more']);
  assert.equal(pills.length + hidden, reading.chips.length, 'pills + hidden = the whole band');
  assert.equal(pills.length, 3, '900 - 216 - 0 - 138 - 8 = 538 px of pills');
  assert.equal(more[0].props.style.width, '40px', 'the +N pill is a fixed width');

  more[0].props.onClick();
  assert.deepEqual(harness.opened, [reading.chips[pills.length].id], 'the first click takes the first hidden session');
  collect(render(), (props) => props['data-hotlist-more'] !== undefined)[0].props.onClick();
  assert.deepEqual(
    harness.opened,
    [reading.chips[pills.length].id, reading.chips[pills.length + 1].id],
    'the next click steps further along the tail',
  );
  pills[0].props.onClick();
  assert.equal(harness.opened.length, 3, 'a pill opens its own session');
  assert.equal(harness.opened[2], pills[0].props['data-hotlist-chip'], 'its own id, not the hidden tail');

  /** Summary mode: one pill carrying how many sessions the band holds. */
  api.writeSettings({ topbar: { ...api.readSettings().topbar, mode: 'count' } });
  const countBand = render();
  const summary = collect(countBand, (props) => props['data-hotlist-chip-count'] !== undefined);
  assert.equal(summary.length, 1, 'one pill instead of a row');
  assert.equal(Number(summary[0].props['data-hotlist-chip-count']), 5, 'every session the band holds is counted');
  assert.equal(collect(countBand, (props) => typeof props['data-hotlist-chip'] === 'string').length, 0, 'no per-session pills in summary mode');
  assert.equal(collect(countBand, (props) => props['data-hotlist-more'] !== undefined).length, 0, 'no +N pill either');
  summary[0].props.onClick();
  assert.equal(harness.opened.length, 4, 'the summary pill walks the sessions too');
  assert.equal(harness.opened[3], reading.chips[0].id, 'the cursor is shared: two clicks walked the two-item tail, so it wrapped back to the head');

  harness.cleanup();
  delete win.innerWidth;
  disableTopbar();
});

// 69. The new settings block: defaults, whitelists and clamping, no version bump.
/** The factory band block: every class starts inside the custom-icon scope. */
const factoryTopbar = () => ({
  mode: 'chips',
  titleMode: 'custom',
  maxSeats: 6,
  previewInWeb: false,
  rightReservePx: 0,
  chipWidthPct: 0,
  customScope: { pinned: true, error: true, pending: true, completed: true, running: true, idle: true },
});

test('topbar settings are clamped', () => {
  assert.deepEqual(api.defaultSettings().topbar, factoryTopbar());
  assert.deepEqual(
    api.sanitizeSettings({ topbar: { mode: 'nope', previewInWeb: 'yes', rightReservePx: 9999 } }).topbar,
    { ...factoryTopbar(), rightReservePx: 400 },
    'unknown mode, non-boolean preview and an oversized reserve all fall back',
  );
  assert.deepEqual(
    api.sanitizeSettings({ topbar: { mode: 'count', rightReservePx: -20 } }).topbar,
    { ...factoryTopbar(), mode: 'count' },
  );
  assert.equal(api.sanitizeSettings({ topbar: { rightReservePx: 13.6 } }).topbar.rightReservePx, 14, 'rounded before clamping');
  assert.equal(api.sanitizeSettings({ topbar: { mode: 'off' } }).topbar.mode, 'off');
  assert.equal(api.sanitizeSettings({ topbar: { previewInWeb: true } }).topbar.previewInWeb, true);
  assert.equal(api.readSettings().version, 4, 'SETTINGS_VERSION did not move: no migration was written');
  assert.equal(DEFAULTS.topbar.rightReservePx, 0);
  assert.equal(DEFAULTS.topbar.chipWidthPct, 0);

  assert.equal(api.hasWindowsTitlebar(), false, 'a browser never marks the title strip');
  html.setAttribute('data-windows-titlebar', '');
  assert.equal(api.hasWindowsTitlebar(), true, 'the desktop shell does');
  html.removeAttribute('data-windows-titlebar');
});


// 70. The band shows only what its own surface switch allows, and pills carry no frame.
test('topbar pills have no frame and skip the current session', () => {
  const ids = ['frame-a', 'frame-b', 'frame-c'];
  const byId = {};
  for (const id of ids) byId[id] = session({ id, retainedBy: id === 'frame-a' ? { mainView: 1 } : {} });
  enableTopbar();
  win.innerWidth = 900;
  const harness = createCtx({
    list: { ids, byId },
    statuses: new Map(),
    groups: { items: [{ workspaceId: 'w', sessionIds: ids }], archivedSessionIds: [] },
  });
  api.apply(harness.ctx, {});
  try {
    const reading = win.__HOTLIST__.topbar();
    assert.deepEqual(reading.chips.map((chip) => chip.id), ['frame-b', 'frame-c'], 'the session the tab row already names is not a pill');
    assert.equal(reading.currentId, 'frame-a', 'the probe still reports which session is open');

    let band = harness.entries.get('hotlist.topbar').Component({});
    if (typeof band.type === 'function') band = band.type(band.props);
    const pills = collect(band, (props) => typeof props['data-hotlist-chip'] === 'string');
    assert.equal(pills.length, 2);
    for (const pill of pills) {
      assert.ok([undefined, 'none'].includes(pill.props.style.background), 'a pill paints no fill');
      assert.ok([undefined, '0'].includes(pill.props.style.border), 'and no frame');
      assert.equal(pill.props.style.flexShrink, 0, 'it keeps its estimated width');
    }
    /** Separation is a standalone hairline, so no pill ever paints one. */
    for (const pill of pills) {
      assert.equal(pill.props.style.boxShadow, undefined, 'the item itself carries no separator');
      assert.equal(pill.props.style.borderRadius, undefined, 'no radius: it is text, not a pill');
    }
    const separators = collect(band, (props) => props['data-hotlist-separator'] !== undefined);
    assert.equal(separators.length, pills.length - 1, 'one hairline between neighbours, none after the last');
    for (const separator of separators) {
      assert.equal(separator.props.style.width, '0px');
      assert.equal(separator.props.style.height, '12px');
      assert.equal(separator.props.style.margin, '0 2px');
      assert.ok(String(separator.props.style.borderLeft).includes('1px solid'), 'a hairline, not a box');
    }
    assert.equal(band.props.style.background, undefined, 'the band itself never paints');
    assert.equal(band.props.style.border, undefined);
  } finally {
    harness.cleanup();
    delete win.innerWidth;
    disableTopbar();
  }
});

// 71. A category decides for itself whether it belongs in the band.
test('category topbar switch decides who shows', () => {
  const ids = ['gate-a', 'gate-b', 'gate-c'];
  const byId = {};
  for (const id of ids) byId[id] = session({ id, retainedBy: id === 'gate-a' ? { mainView: 1 } : {} });
  const harness = createCtx({
    list: { ids, byId },
    statuses: new Map(),
    groups: { items: [{ workspaceId: 'w', sessionIds: ids }], archivedSessionIds: [] },
  });
  try {
    enableTopbar();
    api.apply(harness.ctx, {});
    assert.equal(harness.entries.has('hotlist.topbar'), true, 'the band does not depend on any category');
    assert.deepEqual(win.__HOTLIST__.topbar().chips.map((chip) => chip.id), ['gate-b', 'gate-c'], 'the helper switched every category on');

    /** Everything off: the band stays mounted and shows nothing. */
    api.writeSettings({ categories: topbarSurfaces(false).categories });
    assert.deepEqual(win.__HOTLIST__.topbar().chips.map((chip) => chip.id), [], 'no category belongs to the bar');

    /** The sessions above are idle, so switching that one category on is enough. */
    api.writeSettings({ categories: { idle: { surfaces: { ...DEFAULTS.categories.idle.surfaces, topbar: true } } } });
    assert.deepEqual(win.__HOTLIST__.topbar().chips.map((chip) => chip.id), ['gate-b', 'gate-c']);

    api.writeSettings({ categories: { idle: { surfaces: { ...DEFAULTS.categories.idle.surfaces, topbar: false } } } });
    assert.deepEqual(win.__HOTLIST__.topbar().chips.map((chip) => chip.id), [], 'the pills leave, the band stays mounted');
    assert.equal(harness.entries.has('hotlist.topbar'), true);
  } finally {
    harness.cleanup();
    disableTopbar();
  }
});

// 72. One setting moves the pill width; out-of-range values clamp.
test('pill width follows the setting', () => {
  /** At 0% the bounds are the shipped defaults, so every answer matches the old behaviour. */
  assert.equal(api.readSettings().topbar.chipWidthPct, 0);
  assert.equal(api.chipWidthOf(''), 72, 'the default floor stands');
  assert.equal(api.chipWidthOf('abcd'), 72, '24 + 4 * 12 = 72 exactly');
  assert.equal(api.chipWidthOf('x'.repeat(40)), 140, 'and so does the default ceiling');

  api.writeSettings({ topbar: { ...api.readSettings().topbar, chipWidthPct: -30 } });
  assert.equal(api.readSettings().topbar.chipWidthPct, -30);
  assert.equal(api.chipWidthOf(''), 50, '72 * 0.7 = 50.4, rounded');
  assert.equal(api.chipWidthOf('x'.repeat(40)), 98, '140 * 0.7 = 98');

  api.writeSettings({ topbar: { ...api.readSettings().topbar, chipWidthPct: 30 } });
  assert.equal(api.chipWidthOf(''), 94, '72 * 1.3 = 93.6, rounded');
  assert.equal(api.chipWidthOf('x'.repeat(40)), 182, '140 * 1.3 = 182');

  assert.equal(api.sanitizeSettings({ topbar: { chipWidthPct: 99 } }).topbar.chipWidthPct, 30, 'clamped to the ceiling');
  assert.equal(api.sanitizeSettings({ topbar: { chipWidthPct: -99 } }).topbar.chipWidthPct, -30, 'and to the floor');
  assert.equal(api.sanitizeSettings({ topbar: { chipWidthPct: 7 } }).topbar.chipWidthPct, 5, 'snapped to the 5% step');
  assert.equal(api.sanitizeSettings({ topbar: { chipWidthPct: -7 } }).topbar.chipWidthPct, -5);
  assert.equal(api.sanitizeSettings({ topbar: { chipWidthPct: 2.4 } }).topbar.chipWidthPct, 0, 'rounded first');

  api.writeSettings({ topbar: { ...api.readSettings().topbar, chipWidthPct: 0 } });
  assert.equal(api.chipWidthOf('x'.repeat(40)), 140, 'back to the shipped default');
});

// 73. Segment 1: a marked empty icon, the per-category reset, the two-code-point limit.
test('icon can be emptied and each category resets on its own', () => {
  const factory = api.defaultSettings();

  /** Three code points are refused; one and two pass. */
  api.writeSettings({ categories: { idle: { glyph: { kind: 'emoji', value: '🧊' } } } });
  assert.equal(api.readSettings().categories.idle.glyph.value, '🧊', 'one code point is fine');
  api.writeSettings({ categories: { idle: { glyph: { kind: 'emoji', value: 'ab' } } } });
  assert.equal(api.readSettings().categories.idle.glyph.value, 'ab', 'two code points are fine');
  api.writeSettings({ categories: { idle: { glyph: { kind: 'emoji', value: 'abc' } } } });
  assert.equal(api.readSettings().categories.idle.glyph.value, '', 'three are refused');

  /** A marked clear hides the icon wherever it is read. */
  api.writeSettings({ categories: { idle: { glyph: { kind: 'none', value: '' } } } });
  const cleared = api.readSettings();
  assert.equal(cleared.categories.idle.glyph.kind, 'none');
  assert.equal(cleared.categories.idle.glyph.value, '');
  assert.equal(cleared.choices['categories.idle.glyph.value'], true, 'clearing it is a choice, so the preset rule leaves it alone');
  assert.equal(api.emojiOf(cleared, 'idle'), '', 'the tab label drops the emoji');
  assert.deepEqual(api.resolveStateGlyph(cleared, 'idle', 'seed'), { kind: 'none', value: '' });
  assert.equal(api.labelOf((key) => DICT[key] ?? key, { title: '会话 x', token: 'idle' }, cleared), '会话 x', 'and the label keeps no leading space');

  /** An unmarked empty value still means "use the default icon" at display time. */
  const unmarked = api.sanitizeSettings({ categories: { idle: { glyph: { value: '' } } } });
  assert.equal(unmarked.categories.idle.glyph.kind, 'emoji');
  assert.equal(api.emojiOf(unmarked, 'idle'), api.CATEGORY_GLYPHS.idle, 'the default comes back');

  /** The per-category reset restores one category and drops only its markers. */
  api.writeSettings({
    maxSeats: 9,
    categories: { idle: { glyph: { kind: 'none', value: '' }, order: 42 }, pending: { order: 77 } },
  });
  const marked = api.readSettings();
  assert.equal(marked.maxSeats, 9);
  assert.equal(marked.categories.idle.order, 42);
  const after = api.resetCategory('idle');
  assert.equal(after.maxSeats, 9, 'the global block is untouched');
  assert.equal(after.categories.pending.order, 77, 'so is the other category');
  assert.equal(after.categories.idle.order, factory.categories.idle.order, 'the reset category is factory again');
  assert.equal(after.categories.idle.glyph.kind, factory.categories.idle.glyph.kind);
  assert.equal(after.categories.idle.glyph.value, factory.categories.idle.glyph.value);
  assert.deepEqual(Object.keys(after.choices).filter((key) => key.startsWith('categories.idle.')), [], 'its markers are gone');
  assert.equal(api.resetCategory('nope').maxSeats, 9, 'an unknown id changes nothing');
  assert.equal(typeof win.__HOTLIST__.settings.resetCategory, 'function', 'the scripting surface exposes it too');

  /** The page clamps what it writes, and every card carries its own reset row. */
  globalThis.sessionStorage = new MemoryStorage({ 'dsh.hotlist.open': JSON.stringify(['pinned', 'error', 'pending', 'completed', 'running', 'idle']) });
  const rendered = renderPage();
  try {
    const rows = collect(rendered.page, (props) => typeof props['data-hotlist-reset-category'] === 'string');
    assert.equal(rows.length, 6, 'one reset row per category card');
    const inputs = collect(rendered.page, (props) => typeof props.className === 'string' && props.className.includes('hl-emoji'));
    assert.equal(inputs.length, 7, 'six cards, and the pending card carries a second icon');
    /** Pick by value: this group moved `pending.order`, so the cards are not in their usual order. */
    const idleInput = inputs.find((input) => input.props.value === api.readSettings().categories.idle.glyph.value);
    assert.ok(idleInput, 'the idle card renders an emoji input');
    idleInput.props.onChange({ target: { value: 'abcd' } });
    assert.equal(api.readSettings().categories.idle.glyph.value, 'ab', 'the input stops at two code points');
  } finally {
    rendered.harness.cleanup();
    delete globalThis.sessionStorage;
  }

  api.resetSettings();
  assert.deepEqual(api.readSettings(), factory, 'left as factory defaults for whatever follows');
});
test('four new settings fields default and clamp', () => {
  const d = api.defaultSettings();
  assert.equal(d.scope, 'smart');
  assert.equal(d.positions.topbar, true, 'the band is on by default');
  assert.equal(d.topbar.titleMode, 'custom');
  assert.equal(d.topbar.maxSeats, 6);
  assert.equal(d.version, 4, 'no version bump: the fields ride the default branch');

  assert.equal(api.sanitizeSettings({}).scope, 'smart');
  assert.equal(api.sanitizeSettings({ scope: 'all' }).scope, 'all');
  assert.equal(api.sanitizeSettings({ scope: 'workspace' }).scope, 'workspace');
  assert.equal(api.sanitizeSettings({ scope: 'nope' }).scope, 'smart', 'unknown scope falls back');

  assert.equal(api.sanitizeSettings({ topbar: { maxSeats: 99 } }).topbar.maxSeats, 12, 'clamped to the ceiling');
  assert.equal(api.sanitizeSettings({ topbar: { maxSeats: 0 } }).topbar.maxSeats, 1, 'clamped to the floor');
  assert.equal(api.sanitizeSettings({ topbar: { maxSeats: 7 } }).topbar.maxSeats, 7, 'in-range passes through');
  assert.equal(api.sanitizeSettings({ topbar: { maxSeats: 'auto' } }).topbar.maxSeats, 'auto', 'auto is a legal value');

  assert.equal(api.sanitizeSettings({ topbar: { titleMode: 'icon' } }).topbar.titleMode, 'icon');
  assert.equal(api.sanitizeSettings({ topbar: { titleMode: 'bogus' } }).topbar.titleMode, 'custom', 'unknown titleMode falls back');

  /**
   * v4 shipped the band switch disabled (`() => {}, true`), so `false` on disk is that
   * generation's factory default: it yields to the new default unless the user marked it.
   */
  assert.equal(api.sanitizeSettings({ positions: { topbar: false } }).positions.topbar, true, 'an unmarked legacy false follows the new default');
  assert.equal(api.sanitizeSettings({ positions: { topbar: false }, choices: { 'positions.topbar': true } }).positions.topbar, false, 'a marked false is the user\'s pick and stays');
  assert.equal(api.sanitizeSettings({}).positions.topbar, true, 'an absent field takes the new default');
});

test('scope persists across a reload', () => {
  /** Earlier groups persisted `positions.topbar:false` — a scope write must not touch it. */
  const bandBefore = api.readSettings().positions.topbar;
  for (const value of ['all', 'workspace', 'smart']) {
    api.writeSettings({ scope: value });
    assert.equal(api.readSettings().scope, value, `${value} reads back from storage`);
    assert.equal(api.sanitizeSettings(JSON.parse(JSON.stringify(api.readSettings()))).scope, value, `${value} survives a sanitize pass`);
  }
  api.writeSettings({ scope: 'smart' });
  assert.equal(api.readSettings().scope, 'smart', 'left on the shipped default');
  assert.equal(api.readSettings().positions.topbar, bandBefore, 'scope writes leave the stored band flag alone');
});

test('scope three-way semantics', () => {
  const list = {
    ids: ['in-1', 'in-2', 'out-1'],
    byId: {
      'in-1': session({ id: 'in-1' }),
      'in-2': session({ id: 'in-2', running: true }),
      'out-1': session({ id: 'out-1' }),
    },
  };
  const statuses = new Map([['in-2', { running: true }]]);
  const pins = ['out-1', 'in-1'];
  const plan = (settings, overrides) => api.buildSeatPlan(planInput({
    list, statuses, pinnedSessionIds: pins, ...overrides,
  }), settings);
  const categoryOf = (p, id) => p.find((seat) => seat.sessionId === id)?.category;
  const ids = (p) => p.map((seat) => seat.sessionId);

  /**
   * `planInput` asks the tab surface, and running rides the band by default:
   * re-enable it for this comparison. `pinned.order` is lowered on purpose —
   * this test is about `scope`, not about which class wins — because at the
   * shipped order a pin loses to `idle` and every assertion below would be
   * measuring priority instead of the workspace cut.
   */
  const tabbed = (patch) => api.sanitizeSettings({
    ...patch,
    categories: { running: { surfaces: { tab: true } }, pinned: { order: 5 } },
  });
  const workspace = tabbed({ scope: 'workspace' });
  const wPlan = plan(workspace, { workspaceIds: ['in-1', 'in-2'] });
  assert.equal(ids(wPlan).includes('out-1'), false, 'workspace scope prunes to the current workspace');
  assert.equal(categoryOf(wPlan, 'in-1'), 'pinned', 'a pin inside the workspace keeps its row');
  assert.equal(categoryOf(wPlan, 'in-2'), 'running', 'running is unaffected by scope');

  const all = tabbed({ scope: 'all' });
  const aPlan = plan(all, { workspaceIds: null });
  assert.equal(ids(aPlan).includes('out-1'), true, 'all shows every workspace');
  assert.equal(categoryOf(aPlan, 'out-1'), 'pinned', 'all keeps cross-workspace pins');

  const smart = tabbed({ scope: 'smart' });
  const sPlan = plan(smart, { workspaceIds: null, scopeWorkspaceIds: ['in-1', 'in-2'] });
  assert.equal(ids(sPlan).includes('out-1'), true, 'smart still shows the cross-workspace session itself');
  assert.equal(categoryOf(sPlan, 'out-1'), 'idle', 'smart demotes a cross-workspace pin out of the pinned row');
  assert.equal(categoryOf(sPlan, 'in-1'), 'pinned', 'a pin inside the workspace keeps its row under smart');

  /** The sidebar reads the same two fields: `workspace` drops the row, `smart` keeps it but never as a pin. */
  const sidebar = (scope, currentWorkspaceIds, pinned) => api.sidebarStateOf({
    session: session({ id: 'out-1' }),
    status: {},
    error: undefined,
    completedAt: new Map(),
    pinned,
    children: 0,
    scope,
    currentWorkspaceIds,
    settings: smart,
    now: NOW,
  });
  assert.equal(sidebar('workspace', ['in-1', 'in-2'], true), null, 'workspace scope drops a foreign row outright');
  assert.equal(sidebar('smart', ['in-1', 'in-2'], true), 'idle', 'smart keeps the row but not as a pin');
  assert.equal(sidebar('all', null, true), 'pinned', 'all shows the foreign pin');
  assert.equal(sidebar('smart', ['in-1', 'in-2'], false), 'idle', 'an in-workspace row is untouched');

  /**
   * A fresh install has no workspace ids yet. Every scope must then behave like ll —
   * treating "unknown workspace" as "foreign" emptied the default view.
   */
  for (const scope of ['workspace', 'smart']) {
    const unknown = plan(tabbed({ scope }), { workspaceIds: null, scopeWorkspaceIds: null });
    assert.equal(ids(unknown).length, 3, scope + ' with unknown workspace keeps every row');
    assert.equal(categoryOf(unknown, 'out-1'), 'pinned', scope + ' with unknown workspace keeps the pin');
  }
});

test('titleMode reaches the pills', () => {
  const ids = ['tm-a', 'tm-b'];
  const byId = {};
  for (const id of ids) byId[id] = session({ id });
  enableTopbar();
  const harness = createCtx({ list: { ids, byId }, statuses: new Map(), groups: { items: [{ workspaceId: 'w', sessionIds: ids }], archivedSessionIds: [] } });
  api.apply(harness.ctx, {});
  try {
    const bandNode = () => {
      let band = harness.entries.get('hotlist.topbar').Component({});
      if (typeof band.type === 'function') band = band.type(band.props);
      return band;
    };
    const pills = () => collect(bandNode(), (props) => typeof props['data-hotlist-chip'] === 'string');
    const emojiCells = () => collect(bandNode(), (props) => 'data-hotlist-chip-emoji' in props).length;
    const titleCells = () => collect(bandNode(), (props) => 'data-hotlist-chip-title' in props).length;

    assert.equal(pills().length, 2, 'both sessions earn a pill');
    assert.equal(api.readSettings().topbar.titleMode, 'custom');
    assert.equal(bandNode().props['data-hotlist-title-mode'], 'custom');
    assert.equal(emojiCells(), 2, 'custom draws the emoji column on every pill');
    assert.equal(titleCells(), 2, 'and one title segment per pill');

    api.writeSettings({ topbar: { ...api.readSettings().topbar, titleMode: 'icon' } });
    assert.equal(win.__HOTLIST__.topbar().titleMode, 'icon', 'the probe reports the live titleMode');
    assert.equal(bandNode().props['data-hotlist-title-mode'], 'icon');
    assert.equal(emojiCells(), 2, 'icon keeps the emoji column');

    api.writeSettings({ topbar: { ...api.readSettings().topbar, titleMode: 'text' } });
    assert.equal(bandNode().props['data-hotlist-title-mode'], 'text');
    assert.equal(emojiCells(), 0, 'text drops the emoji column');
    assert.equal(titleCells(), 2, 'the title segment stays');
  } finally {
    harness.cleanup();
    disableTopbar();
  }
});

test('settings page shows the new rows', () => {
  const page = () => {
    const harness = createCtx({ list: { ids: [], byId: {} }, statuses: new Map(), groups: { items: [], archivedSessionIds: [] } });
    api.apply(harness.ctx, {});
    let node = harness.entries.get('hotlist').Component({ close() {}, t: (key) => DICT[key] ?? key });
    if (typeof node.type === 'function') node = node.type(node.props);
    return { node, cleanup: () => harness.cleanup() };
  };
  const rowsOf = (node) => collect(node, (props) => typeof props['data-hotlist-row'] === 'string')
    .map((entry) => entry.props['data-hotlist-row']);

  api.writeSettings({ positions: { ...api.readSettings().positions, topbar: true } });
  const on = page();
  try {
    const rows = rowsOf(on.node);
    assert.equal(rows.includes('scope'), true, 'the scope row sits in the global block');
    assert.equal(rows.includes('topbar.titleMode'), true, 'titleMode rides the band section');
    assert.equal(rows.includes('topbar.maxSeats'), true, 'so does the band seat cap');
  } finally {
    on.cleanup();
  }

  api.writeSettings({ positions: { ...api.readSettings().positions, topbar: false } });
  const off = page();
  try {
    const rows = rowsOf(off.node);
    assert.equal(rows.includes('scope'), true, 'scope is global: it never leaves');
    assert.equal(rows.includes('topbar.titleMode'), false, 'band rows hide with the band');
    assert.equal(rows.includes('topbar.maxSeats'), false);
  } finally {
    off.cleanup();
    api.writeSettings({ positions: { ...api.readSettings().positions, topbar: true } });
  }
});

// 85. The console entry point merges the live snapshot under the caller's fields, so an
// explicit ids still decides the rows and a bare module-level call stays empty by design.
test('console export defers to explicit ids', () => {
  const row = { id: 'a', displayTitle: 'Alpha', updatedAt: NOW };
  const input = {
    format: 'json', ids: ['a'], byId: { a: row }, list: { ids: ['a'], byId: { a: row } },
    statuses: new Map(), errors: new Map(), completedAt: new Map(),
    now: NOW, currentId: null, pinnedSessionIds: [], workspaceIds: null,
    settings: api.defaultSettings(),
  };
  const parsed = JSON.parse(api.exportSessions(input));
  assert.equal(Array.isArray(parsed), true);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].displayTitle, 'Alpha');
  /** Without ids the module-level function is deliberately empty; the console wrapper supplies them. */
  assert.equal(api.exportSessions({ format: 'json' }), '[]');
});
test('session export is deterministic and safe to call bare', () => {
  /** Bare call — no opts at all must not throw and must come back as Markdown. */
  const bare = api.exportSessions();
  assert.equal(typeof bare, 'string');
  assert.ok(bare.startsWith('\uFEFF'), 'the text formats carry a BOM so Notion keeps the Chinese');
  assert.ok(bare.startsWith('\uFEFF| displayTitle |'), `header first, got ${JSON.stringify(bare.slice(0, 40))}`);

  const input = {
    ids: ['err', 'idle', 'wait'],
    byId: {
      err: { id: 'err', displayTitle: 'broken | pipe', running: false, updatedAt: 1767000000000, cwd: 'C:/w', origin: 'main' },
      idle: { id: 'idle', displayTitle: 'quiet\ttab\nnewline', running: false, updatedAt: 1767000060000, cwd: 'C:/w', origin: 'main' },
      wait: { id: 'wait', displayTitle: 'waiting', running: true, updatedAt: 1767000120000, cwd: '', origin: 'main' },
    },
    list: {},
    statuses: new Map([
      ['err', { running: false, pendingInteraction: null, completionUnread: false }],
      ['idle', { running: false, pendingInteraction: null, completionUnread: false }],
      ['wait', { running: true, pendingInteraction: { kind: 'approval' }, completionUnread: false }],
    ]),
    errors: new Map([['err', { at: 1767000290000, message: 'boom' }]]),
    completedAt: new Map(),
    currentId: 'wait',
    pinnedSessionIds: [],
    workspaceIds: ['err', 'idle', 'wait'],
    archivedSessionIds: [],
    now: 1767000300000,
    settings: api.readSettings(),
  };

  const first = api.exportSessions({ ...input, format: 'md' });
  const second = api.exportSessions({ ...input, format: 'md' });
  assert.equal(first, second, 'two exports of one snapshot must be byte-identical');

  /** The error row is in the file: the plugin's own chain, never a second copy of it. */
  const rows = first.split('\n').slice(2).map((line) => line.split(' | ')[1]);
  assert.deepEqual([...rows].sort(), ['approval', 'error', 'idle'], `one row per state, got ${JSON.stringify(rows)}`);

  /** Row order is the plugin's seat order — `sortSeats`, not an ordering of my own. */
  const CATEGORY_OF = { error: 'error', approval: 'pending', question: 'pending', completed: 'completed', running: 'running', pinned: 'pinned', idle: 'idle' };
  const seatOrder = api.orderedCategories(api.readSettings());
  const ranks = rows.map((status) => seatOrder.indexOf(CATEGORY_OF[status]));
  assert.ok(ranks.every((rank) => rank >= 0), `every state maps to a real category, got ${JSON.stringify(ranks)}`);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), `rows follow the seat order, got ${JSON.stringify(rows)}`);

  /** A pipe or a newline must not be able to grow the table by a row. */
  assert.ok(first.includes('broken \\| pipe'), 'the pipe is escaped');
  assert.ok(first.includes('quiet tab newline'), 'tabs and newlines collapse');

  /** JSON is bare so `JSON.parse` works unmodified, and carries the same rows. */
  const json = api.exportSessions({ ...input, format: 'json' });
  assert.equal(json.startsWith('\uFEFF'), false, 'JSON keeps no BOM');
  const parsed = JSON.parse(json);
  assert.equal(parsed.length, 3);
  const broken = parsed.find((row) => row.id === 'err');
  const waiting = parsed.find((row) => row.id === 'wait');
  assert.equal(broken.status, 'error');
  assert.equal(typeof broken.lastActivityLocal, 'string');
  assert.match(broken.lastActivityLocal, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, 'a local time, never "3 hours ago"');
  assert.equal(broken.isCurrent, false);
  assert.equal(waiting.isCurrent, true, 'the approval row is the current session');
  assert.equal(broken.origin, 'main');

  /** An unknown format or scope falls back instead of inventing a fourth value. */
  assert.equal(typeof api.exportSessions({ ...input, format: 'csv' }), 'string');
  assert.equal(typeof api.exportSessions({ ...input, scope: 'everywhere' }), 'string');

  /**
   * `smart` keeps another workspace's pin as a row but never as a pin, `all`
   * shows it pinned, `workspace` drops it — and the export agrees with the
   * sidebar it reads from, which is the whole point of passing `scope` down.
   */
  const cross = {
    ...input,
    pinnedSessionIds: ['idle'],
    workspaceIds: ['err', 'wait'],
    /** Cheap pin: at the shipped order `idle` wins anyway, and this block is about `scope`. */
    settings: api.sanitizeSettings({ categories: { pinned: { order: 5 } } }),
  };
  const smart = JSON.parse(api.exportSessions({ ...cross, scope: 'smart', format: 'json' }));
  const all = JSON.parse(api.exportSessions({ ...cross, scope: 'all', format: 'json' }));
  const workspace = JSON.parse(api.exportSessions({ ...cross, scope: 'workspace', format: 'json' }));
  const statusOf = (rows, id) => rows.find((row) => row.id === id)?.status;
  assert.equal(statusOf(smart, 'idle'), 'idle', 'smart keeps the foreign row but demotes the pin');
  assert.equal(statusOf(all, 'idle'), 'pinned', 'all shows the foreign pin');
  assert.equal(smart.some((row) => row.id === 'idle'), true, 'smart no longer drops the row outright');
  assert.equal(all.length, 3, 'all keeps every row');
  assert.equal(workspace.length, 2, 'workspace keeps only its own');
  assert.equal(workspace.some((row) => row.id === 'idle'), false, 'workspace drops the foreign row');
});

// 80. Every "how many" row is the same `[−] [value] [+]` widget, with no second control beside it.
test('every seat count uses the same stepper', () => {
  const { harness, page } = renderPage();
  try {
    const row = (key) => collect(page, (props) => props['data-hotlist-row'] === key)[0];
    for (const key of ['maxSeats', 'pinned.maxSeats', 'topbar.maxSeats', 'collect.completedTtlMs', 'sound.volume', 'recentWindow']) {
      const node = row(key);
      assert.ok(node, `missing row ${key}`);
      assert.equal(collect(node, (props) => props['data-hotlist-stepper'] !== undefined).length, 1, `${key} uses the shared stepper`);
      const steps = collect(node, (props) => typeof props['data-hotlist-step'] === 'string').map((btn) => btn.props['data-hotlist-step']);
      assert.deepEqual(steps, ['minus', 'plus'], `${key} has one minus and one plus`);
      assert.equal(collect(node, (props) => props.className === 'hl-input hl-num').length, 1, `${key} keeps the same value box`);
    }
    /** 自动 is gone everywhere: a stored `'auto'` still works, but no row offers a second control. */
    const extra = (key) => collect(row(key), (props) => props['aria-pressed'] !== undefined).length;
    for (const key of ['maxSeats', 'pinned.maxSeats', 'topbar.maxSeats']) {
      assert.equal(extra(key), 0, `${key} carries no 自动 button`);
    }
  } finally {
    harness.cleanup();
  }
});

// 81. The point of the feature: the band is the urgent row, the tab row is the background row.
test('the band takes the urgent classes and the tab row the background ones', () => {
  const ids = ['pin-1', 'err-1', 'ask-1', 'done-1', 'idle-1', 'run-1'];
  const byId = {};
  for (const id of ids) byId[id] = session({ id });
  const statuses = new Map([['ask-1', { pendingInteraction: { kind: 'approval' } }], ['run-1', { running: true }]]);
  const errors = new Map([['err-1', { message: 'boom', at: NOW }]]);
  const completedAt = new Map([['done-1', NOW - 60_000]]);
  /**
   * Cheap pin on purpose: at the shipped order a recent pin is `idle` (idle 50
   * beats pinned 60, covered in `pinned follows the configured order`), and
   * what this group measures is which surface each class rides.
   */
  const settings = api.sanitizeSettings({ categories: { pinned: { order: 5 } } });
  const input = { list: { ids, byId }, statuses, errors, completedAt, now: NOW, workspaceIds: null, limit: 6, pinnedSessionIds: ['pin-1'] };
  const band = api.buildSeatPlan({ ...input, surface: 'topbar' }, settings);
  const tab = api.buildSeatPlan({ ...input, surface: 'tab' }, settings);
  assert.deepEqual(band.map((seat) => seat.category).sort(), ['completed', 'error', 'pending'], 'three urgent rows ride the band');
  assert.deepEqual(tab.map((seat) => seat.category).sort(), ['idle', 'pinned'], 'two background rows ride the tab');
  assert.equal(band.some((seat) => seat.sessionId === 'run-1'), false, 'running rides neither row');
  assert.equal(tab.some((seat) => seat.sessionId === 'run-1'), false, 'running rides neither row');
  assert.equal(band.some((seat) => seat.sessionId === 'idle-1'), false, 'the band never takes an idle session');
  assert.equal(tab.some((seat) => seat.sessionId === 'err-1'), false, 'and the tab row never takes an urgent one');
});

// 82. Mounted for real: pills appear without touching the per-category switches.
test('the band mounts with pills next to the tab row', () => {
  api.resetSettings();
  api.writeSettings({
    positions: { ...api.readSettings().positions, topbar: true },
    topbar: { ...api.readSettings().topbar, mode: 'chips', previewInWeb: true },
  });
  const ids = ['pv-ask', 'pv-idle'];
  const byId = {};
  for (const id of ids) byId[id] = session({ id });
  const harness = createCtx({
    list: { ids, byId },
    statuses: new Map([['pv-ask', { pendingInteraction: { kind: 'approval' } }]]),
    groups: { items: [{ workspaceId: 'w', sessionIds: ids }], archivedSessionIds: [] },
  });
  api.apply(harness.ctx, {});
  try {
    const reading = win.__HOTLIST__.topbar();
    assert.equal(reading.mounted, true, 'the band is mounted');
    assert.deepEqual(reading.chips.map((chip) => chip.id), ['pv-ask'], 'the pending session is the only pill');
    const band = harness.entries.get('hotlist.topbar').Component({});
    const pills = collect(band, (props) => typeof props['data-hotlist-chip'] === 'string');
    assert.equal(pills.length, 1, 'the band really draws something');
    const seats = [...harness.entries.keys()].filter((id) => id.startsWith('hotlist-seat-'));
    assert.deepEqual(seats, ['hotlist-seat-pv-idle'], 'the idle session keeps its tab seat');
  } finally {
    harness.cleanup();
    api.resetSettings();
  }
});

// 83. One emoji, never two: the three label modes, and the per-category scope.
test('label modes draw exactly one emoji', () => {
  assert.equal(api.leadingEmoji('✏️UI 大师'), '✏️');
  assert.equal(api.leadingEmoji('UI 大师'), '');
  assert.equal(api.leadingEmoji(''), '');
  assert.equal(api.leadingEmoji(undefined), '');
  assert.equal(api.stripLeadingEmoji('✏️UI 大师'), 'UI 大师');
  assert.equal(api.stripLeadingEmoji('UI 大师'), 'UI 大师');

  const seat = { sessionId: 'emo-1', title: '✏️UI 大师', token: 'idle' };
  const build = (titleMode, scope) => api.sanitizeSettings({
    topbar: scope === undefined ? { titleMode } : { titleMode, customScope: scope },
    categories: { idle: { glyph: { value: '👑' } } },
  });
  assert.equal(api.labelOf((key) => key, seat, build('custom')), '✏️ UI 大师', 'custom: one emoji, the title\'s own');
  assert.equal(api.labelOf((key) => key, seat, build('custom', { idle: false })), '👑 UI 大师', 'custom outside the scope: the category icon');
  assert.equal(api.labelOf((key) => key, seat, build('icon')), '👑 UI 大师', 'icon: the category icon, the title emoji stripped');
  assert.equal(api.labelOf((key) => key, seat, build('text')), 'UI 大师', 'text: no emoji at all');

  const plain = { sessionId: 'emo-2', title: 'UI 大师', token: 'idle' };
  assert.equal(api.labelOf((key) => key, plain, build('custom')), '👑 UI 大师', 'no title emoji: the category icon is the fallback');

  /**
   * A state-fixture title carries two emoji: the marker and the state. Stripping
   * only the first one left the second inside the text, so the tab row read
   * "\u2753 \u2753 待选择" — one emoji from us, one from the title.
   */
  assert.deepEqual(api.leadingEmojiRun('\u{1F9EA}\u2753 待选择 11:58:18'), ['\u{1F9EA}', '\u2753']);
  assert.equal(api.ownEmoji('\u{1F9EA}\u2753 待选择 11:58:18'), '\u2753', 'the emoji next to the words wins');
  assert.equal(api.stripLeadingEmoji('\u{1F9EA}\u2753 待选择 11:58:18'), '待选择 11:58:18', 'every leading emoji goes');
  assert.equal(api.isEmojiOnly('\u{1F9EA}'), true);
  assert.equal(api.isEmojiOnly('\u{1F9EA}\u2753'), true);
  assert.equal(api.isEmojiOnly('\u{1F9EA}\u2753 待选择'), false);
  const twoEmoji = { sessionId: 'emo-3', title: '\u{1F9EA}\u2753 待选择 11:58:18', token: 'completed' };
  assert.equal(api.labelOf((key) => key, twoEmoji, build('custom')), '\u2753 待选择 11:58:18', 'one emoji, never two');
  assert.equal(api.labelOf((key) => key, twoEmoji, build('icon')), '\u2705 待选择 11:58:18', 'icon mode: ours only');
  assert.equal(api.labelOf((key) => key, twoEmoji, build('text')), '待选择 11:58:18', 'text mode: no emoji at all');
  const emojiOnly = { sessionId: 'emo-4', title: '\u{1F9EA}', token: 'idle' };
  assert.equal(api.labelOf((key) => key, emojiOnly, build('custom')), '\u{1F9EA}', 'an emoji-only title is its own label');
});

// 84. The three modes speak readable names, and old names still load.
test('label mode names and their aliases', () => {
  assert.deepEqual(api.TOPBAR_TITLE_MODES, ['text', 'icon', 'custom']);
  assert.deepEqual(api.TITLE_MODE_ALIASES, { unified: 'text', two: 'icon', smart: 'custom', auto: 'icon' });
  const normalized = (titleMode) => api.sanitizeSettings({ topbar: { titleMode } }).topbar.titleMode;
  assert.equal(normalized('unified'), 'text', 'the v5 name for text only');
  assert.equal(normalized('two'), 'icon', 'the v5 name for the category icon');
  assert.equal(normalized('smart'), 'custom', 'the v5 name for the custom icon');
  assert.equal(normalized('auto'), 'icon', 'a name the user typed once reads as icon');
  assert.equal(normalized('text'), 'text', 'new names pass through');
  assert.equal(normalized('icon'), 'icon');
  assert.equal(normalized('custom'), 'custom');
  assert.equal(normalized('nope'), 'custom', 'an unknown name falls back to the default');
  assert.equal(normalized(undefined), 'custom', 'an absent field keeps the default');
  assert.equal(api.readSettings().version, 4, 'aliases are read, never migrated');
});

// 85. The scope is per category and only `custom` reads it.
test('custom scope decides per category', () => {
  const on = (titleMode, scope) => api.sanitizeSettings({ topbar: { titleMode, customScope: scope } }).topbar;
  const idle = { sessionId: 'scope-1', title: '🎓 大聪明', token: 'idle' };
  const pinned = { sessionId: 'scope-2', title: '🎓 大聪明', token: 'pinned' };
  const scoped = on('custom', { idle: false });
  assert.equal(scoped.customScope.idle, false, 'the switch lands');
  assert.equal(scoped.customScope.pinned, true, 'and leaves the others alone');
  assert.equal(api.labelOf((key) => key, idle, { ...api.readSettings(), topbar: scoped }), '🧊 大聪明', 'idle is out of the scope: category icon');
  assert.equal(api.labelOf((key) => key, pinned, { ...api.readSettings(), topbar: scoped }), '🎓 大聪明', 'pinned is inside it: the title\'s own emoji');
  const allOff = on('custom', { idle: false, pinned: false, error: false, pending: false, completed: false, running: false });
  assert.deepEqual(Object.values(allOff.customScope), [false, false, false, false, false, false], 'every switch can be off at once');
  const iconMode = on('icon', { idle: true });
  assert.equal(api.labelOf((key) => key, idle, { ...api.readSettings(), topbar: iconMode }), '🧊 大聪明', 'icon ignores the scope entirely');
  assert.equal(api.customIconWins({ topbar: scoped }, 'pinned'), true);
  assert.equal(api.customIconWins({ topbar: scoped }, 'idle'), false);
  assert.equal(api.customIconWins({ topbar: iconMode }, 'pinned'), false, 'only custom reads the scope');
  assert.equal(api.customIconWins({ topbar: { titleMode: 'custom' } }, 'idle'), true, 'a missing map means inside the scope');
});

// 86. The scope row exists only while `custom` is chosen.
test('the scope row only exists in custom mode', () => {
  api.writeSettings({ positions: { ...api.readSettings().positions, topbar: true } });
  const render = () => {
    const { harness, page } = renderPage();
    return { harness, rows: collect(page, (props) => typeof props['data-hotlist-scope'] === 'string') };
  };
  try {
    api.writeSettings({ topbar: { ...api.readSettings().topbar, titleMode: 'custom' } });
    const custom = render();
    try {
      assert.equal(custom.rows.length, 6, 'six categories, six switches');
      assert.deepEqual(custom.rows.map((node) => node.props['data-hotlist-scope']), ['error', 'pending', 'completed', 'running', 'idle', 'pinned'], 'ordered like the cards');
      const first = custom.rows[0];
      assert.equal(first.props['data-on'], 'true', 'factory defaults are all on');
      assert.equal(typeof first.children[0].props.onChange, 'function', 'each switch is a real toggle');
    } finally {
      custom.harness.cleanup();
    }
    api.writeSettings({ topbar: { ...api.readSettings().topbar, titleMode: 'icon' } });
    const icon = render();
    try {
      assert.equal(icon.rows.length, 0, 'icon has nothing to scope');
    } finally {
      icon.harness.cleanup();
    }
  } finally {
    api.writeSettings({ topbar: { ...api.readSettings().topbar, titleMode: 'custom' } });
  }
});

// 87. Pills strip the title emoji too: the band is not a second styling path.
test('pills strip the title emoji the same way', () => {
  const ids = ['pill-1', 'pill-2'];
  const byId = {};
  byId['pill-1'] = session({ id: 'pill-1', displayTitle: '🎓 大聪明' });
  byId['pill-2'] = session({ id: 'pill-2', displayTitle: '🎓 小聪明' });
  enableTopbar();
  const harness = createCtx({ list: { ids, byId }, statuses: new Map(), groups: { items: [{ workspaceId: 'w', sessionIds: ids }], archivedSessionIds: [] } });
  api.apply(harness.ctx, {});
  try {
    api.writeSettings({ topbar: { ...api.readSettings().topbar, titleMode: 'icon' } });
    const bandNode = () => {
      let band = harness.entries.get('hotlist.topbar').Component({});
      if (typeof band.type === 'function') band = band.type(band.props);
      return band;
    };
    const emoji = () => collect(bandNode(), (props) => 'data-hotlist-chip-emoji' in props).map((node) => textOf(node));
    const titles = () => collect(bandNode(), (props) => 'data-hotlist-chip-title' in props).map((node) => textOf(node));
    assert.equal(emoji().length, 2, 'icon draws one glyph per pill');
    assert.deepEqual(emoji(), ['🧊', '🧊'], 'the category icon, not the title\'s own');
    assert.deepEqual(titles(), ['大聪明', '小聪明'], 'and the title emoji is gone from the text');

    api.writeSettings({ topbar: { ...api.readSettings().topbar, titleMode: 'custom' } });
    /**
     * `custom` draws the title's own emoji into the glyph slot so the class
     * animation has something to run on; the text column keeps only the title.
     * Still exactly one emoji per pill.
     */
    assert.deepEqual(emoji(), ['🎓', '🎓'], 'custom paints the title emoji in the glyph slot');
    assert.deepEqual(titles(), ['大聪明', '小聪明'], 'still one emoji, never two');

    api.writeSettings({ topbar: { ...api.readSettings().topbar, titleMode: 'custom', customScope: { ...api.readSettings().topbar.customScope, idle: false } } });
    assert.deepEqual(emoji(), ['🧊', '🧊'], 'out of the scope the category icon comes back');
  } finally {
    harness.cleanup();
    disableTopbar();
  }
});

// 88. The band never starts under the desktop menu: hit testing, not guessing.
test('the band never starts under the menu', () => {
  const restore = document.elementsFromPoint;
  try {
    const block = { getBoundingClientRect: () => ({ width: 214, height: 40, left: 48, right: 262, top: 0, bottom: 40 }) };
    document.elementsFromPoint = (x) => (x < 300 ? [block] : []);
    assert.equal(api.occupiedLeft(), 270, 'the right edge of what is painted plus the gap');
    assert.equal(api.bandLeft(), 270, 'and that is what the band uses, not the guess');
    assert.equal(api.leftSource(), 'occupied', 'the source says where it came from');

    // A full-width layout container also answers the hit test; it must not become the left edge.
    const wide = { getBoundingClientRect: () => ({ width: 1564, height: 40, left: 280, right: 1844, top: 0, bottom: 40 }) };
    document.elementsFromPoint = () => [wide];
    assert.equal(api.occupiedLeft(), null, 'a full-width header is not an occupant');
    assert.equal(api.bandLeft(), api.fallbackLeft(), 'so the band keeps its documented left edge');
    const offset = { getBoundingClientRect: () => ({ width: 60, height: 40, left: 600, right: 660, top: 0, bottom: 40 }) };
    document.elementsFromPoint = () => [offset];
    assert.equal(api.occupiedLeft(), null, 'and neither is something far from the left edge');

    document.elementsFromPoint = () => [];
    assert.equal(api.occupiedLeft(), null, 'a free stretch reports nothing');
    assert.equal(api.bandLeft(), api.fallbackLeft(), 'so the documented fallback takes over');
    assert.equal(api.leftSource(), 'fallback');

    document.elementsFromPoint = undefined;
    assert.equal(api.occupiedLeft(), null, 'no hit testing: no measurement, no crash');
    assert.equal(api.bandLeft(), api.fallbackLeft());
  } finally {
    document.elementsFromPoint = restore;
  }
  assert.equal(source.includes('topbarProbed'), false, 'the frozen measurement flag is gone');
  assert.equal(source.includes("'data-hotlist-topbar-left-src': leftSource()"), true, 'the band reports which path it took');
});

// 89. The three modes say what they draw, one sentence each.
test('label mode labels name what they draw', () => {
  assert.ok(source.includes("'settings.topbar.titleMode': '标签显示设置'"), 'the row is called label display');
  assert.ok(source.includes("'settings.topbar.titleMode.text': '仅显示文本'"));
  assert.ok(source.includes("'settings.topbar.titleMode.icon': '使用插件图标'"));
  assert.ok(source.includes("'settings.topbar.titleMode.custom': '自定义显示图标'"));
  assert.equal(source.includes("'settings.topbar.titleMode.unified'"), false, 'the old keys are gone, not duplicated');
  assert.equal(source.includes("'settings.topbar.titleMode.two'"), false);
  assert.equal(source.includes("'settings.topbar.titleMode.smart'"), false);
  assert.ok(source.includes("'settings.topbar.customScope': '自定义生效范围'"), 'the scope row is named');
  assert.ok(source.includes('Label display'), 'and so does the English row');
  assert.ok(source.includes('Text only'));
  assert.ok(source.includes('Plugin icon'));
  assert.ok(source.includes('Custom icon'));
  /** One sentence of general guidance, no wall of per-mode paragraphs. */
  assert.ok(source.includes('决定会话标签前显示什么：只有文本、这类自己的图标，或会话名开头那颗 emoji。'), 'the hint is one line');
  assert.ok(source.includes('勾选的类别用会话名开头的 emoji 替换图标'), 'the scope hint explains the switch');
});


// 86. The second pass over the settings page: order, removed rows, one stepper family.
test('settings page reads as one page', () => {
  api.writeSettings({ positions: { ...api.readSettings().positions, topbar: true } });
  const { harness, page } = renderPage();
  try {
    const rows = collect(page, (props) => typeof props['data-hotlist-row'] === 'string')
      .map((node) => node.props['data-hotlist-row']);
    assert.ok(rows.indexOf('scope') >= 0 && rows.indexOf('scope') < rows.indexOf('maxSeats'), 'the scope row sits above the seat cap');
    assert.equal(rows.includes('topbar.mode'), false, 'the band style row is gone; the field stays for the API');
    assert.equal(rows.includes('topbar.rightReservePx'), false, 'so is the reserve row; the window-control guard is code');
    const row = (key) => collect(page, (props) => props['data-hotlist-row'] === key)[0];
    for (const key of ['collect.completedTtlMs', 'sound.volume', 'recentWindow']) {
      const node = row(key);
      assert.ok(node !== undefined, `missing row ${key}`);
      assert.equal(collect(node, (props) => props['data-hotlist-stepper'] !== undefined).length, 1, `${key} uses the shared stepper`);
      const steps = collect(node, (props) => typeof props['data-hotlist-step'] === 'string').map((btn) => btn.props['data-hotlist-step']);
      assert.deepEqual(steps, ['minus', 'plus'], `${key} steps both ways`);
    }
    const widthSelect = collect(row('topbar.chipWidthPct'), (props) => props.className === 'hl-select')[0];
    assert.ok(widthSelect !== undefined, 'the pill width still has its select');
    let zero = null;
    walk(widthSelect, (node) => {
      if (node.type === 'option' && node.props !== undefined && node.props.value === 0) zero = node;
    });
    assert.equal(textOf(zero), 'settings.topbar.chipWidthDefault', '0% reads as the default, not as a number');
    assert.equal(source.includes('const WINDOW_CONTROLS_GUARD = 138;'), true, 'the window buttons keep a hard guard');
    assert.equal(source.includes('width - model.left - model.reserve - WINDOW_CONTROLS_GUARD - 8'), true, 'and the band width subtracts it');
    assert.equal(source.includes("'settings.pinnedMaxSeatsHint': '对话区 tab 行最多显示几个已置顶会话（0–12）；0 = 不显示。'"), true, 'the three seat-count hints read as one family');
    assert.equal(source.includes("'settings.topbar.maxSeatsHint': '顶栏最多显示几个会话（1–12），与对话区 tab 行互不影响。'"), true);
  } finally {
    harness.cleanup();
  }
});
/**
 * A failure must survive the run flag that lags behind it. The old rule deleted
 * every error whose session was `running === true` at sync time, which wiped an
 * agent error that fires *during* the failing turn — the ⛔ glyph then never
 * showed (found on a real instance 2026-11-14). Only a newer user message may
 * retire a failure, so the activity relay has to be subscribed.
 */
test('a failure outlives the running flag', () => {
  assert.equal(
    source.includes('snapshot.statuses.get(id)?.running === true) errors.delete(id)'),
    false,
    'the eager per-sync wipe is gone',
  );
  assert.equal(
    source.includes("ctx.remote.$on('api-session/activity'"),
    true,
    'a newer user message is what retires a failure',
  );
  assert.equal(
    source.includes("'hotlist: clear a failure when a newer run starts'"),
    true,
    'and the subscription is named, so it shows up in the effect ledger',
  );
});

// 93. The sidebar row is not a second styling path: it strips the host emoji too.
test('sidebar row titles follow the same label modes', () => {
  clearSidebarRows();
  clearStyleBlocks();
  const row = sidebarRow('session-label', '🎓 大聪明');
  const settings = api.defaultSettings();
  settings.topbar.titleMode = 'icon';
  const adapter = api.createSidebarAdapter({
    document: globalThis.document,
    readSettings: () => settings,
    readSession: (sessionId) => ({
      session: session({ id: sessionId, displayTitle: '🎓 大聪明' }),
      status: {},
      error: undefined,
      completedAt: undefined,
      pinned: false,
      children: 0,
    }),
  });
  adapter.start();
  try {
    assert.equal(row.title.textContent, '大聪明', 'icon mode: our glyph stands in, so the host emoji goes');

    settings.topbar.titleMode = 'custom';
    adapter.refresh();
    /**
     * `custom` in scope: the title's emoji is drawn in the glyph slot (so the
     * class animation runs on it), which means the host text loses it. One
     * emoji on screen, never two.
     */
    assert.equal(row.title.textContent, '大聪明', 'custom in scope: the emoji moves into the glyph slot');

    settings.topbar.titleMode = 'text';
    adapter.refresh();
    assert.equal(row.title.textContent, '大聪明', 'text mode: no emoji at all');

    settings.topbar.titleMode = 'custom';
    settings.topbar.customScope = { ...settings.topbar.customScope, idle: false };
    adapter.refresh();
    assert.equal(row.title.textContent, '大聪明', 'custom outside the scope: our glyph wins, the host emoji goes');
  } finally {
    settings.topbar.customScope = { ...settings.topbar.customScope, idle: true };
    adapter.stop();
  }
  assert.equal(row.title.textContent, '🎓 大聪明', 'stopping the adapter gives the host its own text back');
  clearSidebarRows();
});

// 88. The read-only table answers "who is in the hot list, and who is not".
test('the table names every seat and why the rest are out', () => {
  /** Only the tab row is on, so every other surface has to explain itself. */
  const base = api.sanitizeSettings({ positions: { tab: true, topbar: false, sidebar: false } });
  base.categories.idle.surfaces = { tab: true, sidebar: false, topbar: false };
  const list = {
    ids: ['t-idle', 't-cap', 't-ask', 't-run', 't-blank', 't-sub'],
    byId: {},
  };
  list.byId['t-idle'] = session({ id: 't-idle', displayTitle: '空闲会话', updatedAt: NOW });
  /** Older than `t-idle`, so the cap has to be the thing that pushes it out. */
  list.byId['t-cap'] = session({ id: 't-cap', displayTitle: '被截断的会话', updatedAt: NOW - 60_000 });
  list.byId['t-ask'] = session({ id: 't-ask', displayTitle: '等审批' });
  list.byId['t-run'] = session({ id: 't-run', displayTitle: '跑任务' });
  list.byId['t-blank'] = session({ id: 't-blank', displayTitle: '空会话', blank: true });
  list.byId['t-sub'] = session({ id: 't-sub', displayTitle: '子代理', origin: 'subagent' });
  const snapshot = {
    list,
    statuses: new Map([['t-ask', { pendingInteraction: { kind: 'approval' } }], ['t-run', { running: true }]]),
    currentId: null,
    pinnedSessionIds: [],
    workspaceIds: null,
    scope: 'smart',
  };
  const runtime = {
    now: NOW,
    errors: new Map(),
    completedAt: new Map(),
    limit: 1,
    topbarLimit: 1,
    bandUp: false,
  };
  const table = api.hotlistTable(base, snapshot, runtime);
  assert.deepEqual(table.rows.map((row) => row.sessionId), ['t-idle'], 'one idle seat fits the limit');
  assert.deepEqual(table.rows[0].surfaces, { tab: true, sidebar: false, topbar: false }, 'the table knows which surface paints it');
  assert.equal(table.rows[0].index, 1, 'rows are numbered');
  const reasons = new Map(table.missing.map((item) => [item.sessionId, item.reason]));
  assert.equal(reasons.get('t-cap'), 'over-cap', 'a session past the cap says so');
  assert.equal(reasons.get('t-run'), 'position-off', 'a class whose surface is off says so');
  assert.equal(reasons.get('t-blank'), 'empty', 'a blank session is not a hot session');
  assert.equal(reasons.get('t-sub'), 'subagent', 'and neither is a subagent');
  assert.equal(table.limit, 1, 'the limit rides along for the label');

  base.categories.idle.surfaces = { tab: false, sidebar: false, topbar: false };
  const off = api.hotlistTable(base, snapshot, runtime);
  const offReasons = new Map(off.missing.map((item) => [item.sessionId, item.reason]));
  assert.equal(offReasons.get('t-idle'), 'surface-off', 'a class with every surface off says so');

  const scoped = api.hotlistTable(api.sanitizeSettings({}), { ...snapshot, scope: 'workspace', workspaceIds: ['t-idle'] }, runtime);
  const scopeReasons = new Map(scoped.missing.map((item) => [item.sessionId, item.reason]));
  assert.equal(scopeReasons.get('t-blank') ?? 'empty', 'empty');
  assert.equal(scoped.missing.some((item) => item.reason === 'scope'), true, 'another workspace is out of scope');
});

// 89. The table has a fixed seat of its own in the tab row, with a readable label.
test('the table view is a tab of its own', () => {
  const ids = ['view-a'];
  const byId = { 'view-a': session({ id: 'view-a', displayTitle: '看板会话', updatedAt: NOW }) };
  const harness = createCtx({
    list: { ids, byId },
    statuses: new Map(),
    groups: { items: [{ workspaceId: 'w', sessionIds: ids }], archivedSessionIds: [] },
  });
  api.apply(harness.ctx, {});
  try {
    const entry = harness.entries.get(api.TABLE_VIEW_ID);
    assert.ok(entry !== undefined, 'the table is registered under its fixed id');
    assert.equal(entry.order, api.TABLE_VIEW_ORDER, 'after every seat');
    let page = entry.Component({});
    if (typeof page.type === 'function') page = page.type(page.props);
    const roots = collect(page, (props) => props['data-hotlist-table'] !== undefined);
    assert.equal(roots.length, 1, 'the view paints its table');
    const rows = collect(page, (props) => typeof props['data-hotlist-table-row'] === 'string');
    assert.deepEqual(rows.map((row) => row.props['data-hotlist-table-row']), ['view-a'], 'one row per hot session');
    assert.equal(collect(page, (props) => typeof props['data-hotlist-missing'] === 'string').length, 0, 'nothing is left out here');
  } finally {
    harness.cleanup();
  }
});

// 90. Pills carry the class animation, and reduced motion takes it away.
test('pills carry the class animation', () => {
  const ids = ['anim-ask'];
  const byId = { 'anim-ask': session({ id: 'anim-ask', displayTitle: '等审批' }) };
  enableTopbar();
  const harness = createCtx({
    list: { ids, byId },
    statuses: new Map([['anim-ask', { pendingInteraction: { kind: 'approval' } }]]),
    groups: { items: [{ workspaceId: 'w', sessionIds: ids }], archivedSessionIds: [] },
  });
  api.apply(harness.ctx, {});
  try {
    const render = () => {
      const band = harness.entries.get(api.TOPBAR_ID).Component({});
      return collect(band, (props) => typeof props['data-hotlist-chip'] === 'string');
    };
    const [pill] = render();
    assert.equal(pill.props['data-hotlist-chip-motion'], 'bounce', 'the pill declares its class motion');
    api.writeSettings({ display: { ...api.readSettings().display, reduceMotion: 'on' } });
    const reduced = render();
    assert.equal(reduced[0].props['data-hotlist-chip-motion'], undefined, 'reduced motion declares none');
  } finally {
    harness.cleanup();
    api.resetSettings();
  }
});

// 91. A tab seat gets the same glyph, one emoji, never two.
test('tab seats draw the same glyph and motion', () => {
  tabRow.children.length = 0;
  const button = el('button');
  button.setAttribute('role', 'tab');
  const textNode = { nodeType: 3, textContent: '会话 tab-pin' };
  button.childNodes = [textNode];
  tabRow.appendChild(button);
  const ids = ['tab-pin'];
  const byId = { 'tab-pin': session({ id: 'tab-pin', displayTitle: '会话 tab-pin', updatedAt: NOW }) };
  api.writeSettings({ categories: { pinned: { order: 5 } } });
  const harness = createCtx({
    list: { ids, byId },
    statuses: new Map(),
    groups: { items: [{ workspaceId: 'w', sessionIds: ids }], archivedSessionIds: [], pinnedSessionIds: ids, phase: 'ready' },
  });
  api.apply(harness.ctx, {});
  try {
    const glyph = button.children.find((child) => child.hasAttribute('data-hotlist-tab-glyph'));
    assert.ok(glyph !== undefined, 'the seat grew a glyph span');
    assert.equal(glyph.textContent, '📌', 'it draws the class glyph');
    assert.equal(glyph.getAttribute('data-hotlist-motion'), 'bounce', 'and declares the class motion');
    assert.equal(textNode.textContent, '会话 tab-pin', 'the host text keeps only the title');
  } finally {
    harness.cleanup();
    tabRow.children.length = 0;
    api.resetSettings();
  }
});

// 92. Every category offers all three positions, and the chip follows the switch.
test('every category offers all three positions', () => {
  globalThis.sessionStorage = new MemoryStorage({
    'dsh.hotlist.open': JSON.stringify(['pinned', 'error', 'pending', 'completed', 'running', 'idle']),
  });
  const rowsOf = (page) => collect(page, (props) => typeof props['data-hotlist-row'] === 'string')
    .map((entry) => entry.props['data-hotlist-row']);
  const first = renderPage();
  try {
    const rows = rowsOf(first.page);
    for (const category of api.CATEGORY_IDS) {
      for (const surface of ['tab', 'sidebar', 'topbar']) {
        assert.equal(rows.includes(`categories.${category}.surfaces.${surface}`), true, `${category}/${surface} has a row`);
      }
    }
    const row = collect(first.page, (props) => props['data-hotlist-row'] === 'categories.idle.surfaces.tab')[0];
    const input = collect(row, (props) => props.type === 'checkbox')[0];
    assert.equal(input.props.checked, true, 'idle starts on for the tab row');
    input.props.onChange();
    assert.equal(api.readSettings().categories.idle.surfaces.tab, false, 'the switch writes the setting');
  } finally {
    first.harness.cleanup();
  }
  const second = renderPage();
  try {
    const chips = collect(second.page, (props) => props['aria-label'] === 'settings.chip.tab' && typeof props['data-on'] === 'string');
    const idleChip = chips.find((chip) => chip.props.key === 'tab' && chip.props['data-on'] === 'false');
    assert.ok(idleChip !== undefined, 'the chip reads the same setting, so it went off with it');
  } finally {
    second.harness.cleanup();
    delete globalThis.sessionStorage;
    api.resetSettings();
  }
});

// 93. The export left the settings page; the API stayed.
test('export is an API, not a button', () => {
  const { harness, page } = renderPage();
  try {
    assert.equal(collect(page, (props) => props['data-hotlist-export'] !== undefined).length, 0, 'no export row is painted');
    assert.equal(collect(page, (props) => typeof props['data-hotlist-row'] === 'string')
      .some((row) => row.props['data-hotlist-row'].includes('export')), false, 'and no row key mentions it');
    assert.equal(typeof win.__HOTLIST__.export, 'function', 'the console entry point is still there');
    const text = win.__HOTLIST__.export({ format: 'json' });
    assert.equal(Array.isArray(JSON.parse(text)), true, 'and it still answers with rows');
  } finally {
    harness.cleanup();
  }
});

// 94. A yield still paints a glyph: the class signal never disappears.
test('a yielded title still shows a class glyph', () => {
  clearSidebarRows();
  clearStyleBlocks();
  const row = sidebarRow('session-yield', '🎓 大聪明');
  const settings = api.defaultSettings();
  const adapter = api.createSidebarAdapter({
    document: globalThis.document,
    readSettings: () => settings,
    readSession: (sessionId) => ({
      session: session({ id: sessionId, displayTitle: '🎓 大聪明', updatedAt: NOW }),
      status: {},
      error: undefined,
      completedAt: undefined,
      pinned: false,
      children: 0,
    }),
  });
  adapter.start();
  try {
    const marker = row.row.children.find((child) => child.hasAttribute('data-hotlist-glyph'));
    assert.ok(marker !== undefined, 'the slot exists even when the title emoji wins');
    assert.equal(marker.getAttribute('data-hotlist-char'), '🎓', 'the title emoji is drawn in the slot');
    assert.equal(marker.getAttribute('data-hotlist-glyph-kind'), 'emoji', 'as an emoji, so it can move');
    assert.equal(marker.style.display, '', 'and it is not hidden');
    assert.equal(row.title.textContent, '大聪明', 'the host text lost its copy');
  } finally {
    adapter.stop();
    clearSidebarRows();
  }
});

// 95. Equal `order` keeps the old chain: error before pending, both at 10.
test('equal order falls back to the class rank', () => {
  const settings = api.sanitizeSettings({ categories: { error: { order: 10 }, pending: { order: 10 } } });
  const input = planInput({
    list: { ids: ['same-1'], byId: { 'same-1': session({ id: 'same-1' }) } },
    statuses: new Map([['same-1', { pendingInteraction: { kind: 'approval' } }]]),
    errors: new Map([['same-1', { at: NOW, message: 'boom' }]]),
  });
  const rows = api.classify(settings, { ...input, surface: 'sidebar' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, 'error', 'the rank breaks the tie, so error wins');
});


// 96. A surface that is switched off cannot name a row, so the table must not list it either.
test('the table only reads the surfaces that are on', () => {
  const ids = ['pos-1'];
  const byId = { 'pos-1': session({ id: 'pos-1', displayTitle: '会话 pos-1', updatedAt: NOW }) };
  const snapshot = {
    list: { ids, byId },
    statuses: new Map(),
    currentId: null,
    pinnedSessionIds: [],
    workspaceIds: null,
    scopeWorkspaceIds: null,
    scope: 'smart',
  };
  const runtime = { now: NOW, errors: new Map(), completedAt: new Map(), limit: 6, topbarLimit: 6, bandUp: true };
  /** Every position on, and idle allowed everywhere, so all three surfaces can name the row. */
  const allOn = api.sanitizeSettings({ positions: { tab: true, topbar: true, sidebar: true } });
  allOn.categories.idle.surfaces = { tab: true, sidebar: true, topbar: true };
  const everything = api.hotlistTable(allOn, snapshot, runtime);
  assert.deepEqual(everything.rows.map((row) => row.sessionId), ['pos-1']);
  assert.deepEqual(everything.rows[0].surfaces, { tab: true, sidebar: true, topbar: true }, 'all three name it');
  assert.deepEqual(everything.missing, [], 'and nothing is left over');

  /** The band is down, so only the tab row can name the row. */
  const tabOnly = { ...allOn, positions: { tab: true, topbar: false, sidebar: false } };
  const narrowed = api.hotlistTable(tabOnly, snapshot, { ...runtime, bandUp: false });
  assert.deepEqual(narrowed.rows.map((row) => row.sessionId), ['pos-1'], 'the tab row still names it');
  assert.deepEqual(narrowed.rows[0].surfaces, { tab: true, sidebar: false, topbar: false }, 'the off surfaces say so');

  const none = { ...allOn, positions: { tab: false, topbar: false, sidebar: false } };
  const empty = api.hotlistTable(none, snapshot, { ...runtime, bandUp: false });
  assert.deepEqual(empty.rows, [], 'with every position off nobody is painted');
  assert.equal(empty.missing.length, 1, 'and the session is explained, not silently dropped');
  assert.equal(empty.missing[0].reason, 'position-off', 'the reason names the switches');
});

// 97. A pin from another workspace is not a pin here — the table follows the same scope rule.
test('the table keeps a foreign pin out of the pinned class', () => {
  const ids = ['elsewhere-1'];
  const byId = { 'elsewhere-1': session({ id: 'elsewhere-1', displayTitle: '别的会话', updatedAt: NOW }) };
  const snapshot = {
    list: { ids, byId },
    statuses: new Map(),
    currentId: null,
    pinnedSessionIds: ids,
    workspaceIds: null,
    scopeWorkspaceIds: ['here'],
    scope: 'smart',
  };
  const runtime = { now: NOW, errors: new Map(), completedAt: new Map(), limit: 6, topbarLimit: 6, bandUp: false };
  const settings = api.sanitizeSettings({ positions: { tab: true, topbar: false, sidebar: true } });
  const table = api.hotlistTable(settings, snapshot, runtime);
  assert.equal(table.rows.length, 1, 'the row is still on screen under smart');
  assert.equal(table.rows[0].category, 'idle', 'but the foreign pin does not win: it falls to idle');

  const here = { ...snapshot, scopeWorkspaceIds: ids };
  const pinned = api.hotlistTable(settings, here, runtime);
  assert.equal(pinned.rows[0].category, 'idle', 'pinned is weak by default order, even at home');
  const ordered = api.sanitizeSettings({ categories: { pinned: { order: 5 } } });
  assert.equal(api.hotlistTable(ordered, here, runtime).rows[0].category, 'pinned', 'raise its order and it wins');
  assert.equal(api.hotlistTable(ordered, snapshot, runtime).rows[0].category, 'idle', 'a foreign pin never wins, whatever its order');
});

test('a slot declared later never gets registered early', () => {
  /**
   * The host declares `shell.overlay` before the conversation panel declares
   * `conversation.view`. Our `inject(TOPBAR_SLOT)` callback calls `sync()` the
   * moment the band's slot exists, so a sync that mounts *both* surfaces used to
   * register into a slot nobody had declared yet — the 5.0.0-alpha.1 boot crash
   * (`slot "conversation.view" is not declared`).
   */
  api.overrideSettings({ positions: { tab: true, topbar: true, sidebar: true }, topbar: { mode: 'chips', previewInWeb: true } });
  const early = createCtx({
    list: { ids: ['early-a'], byId: { 'early-a': session({ id: 'early-a' }) } },
    groups: { items: [{ workspaceId: 'w1', sessionIds: ['early-a'] }], archivedSessionIds: [] },
    workspace: 'w1',
    slotsDeclared: ['shell.overlay'],
  });
  api.apply(early.ctx, {});
  assert.ok(early.registrations.includes('hotlist.topbar'), 'the band registers into its own declared slot');
  assert.equal(early.registrations.some((id) => id.startsWith('hotlist-seat-')), false, 'no seat before conversation.view exists');
  assert.equal(early.registrations.includes('hotlist-table'), false, 'no table view before conversation.view exists');

  early.declareSlot('conversation.view');
  assert.ok(early.registrations.includes('hotlist-table'), 'the table view registers once the slot exists');
  assert.ok(early.registrations.some((id) => id.startsWith('hotlist-seat-')), 'the seats register once the slot exists');
  api.overrideSettings(null);
  early.cleanup();
});

// 105. The rows left out of the hot list are grouped by reason, in a fixed order,
// collapsed by default — 234 loose lines is what made the page four screens tall.
test('rows left out are grouped by reason, not dumped', () => {
  const ids = ['g-live', 'g-cap', 'g-blank', 'g-sub'];
  const byId = {
    'g-live': session({ id: 'g-live', displayTitle: '上座', updatedAt: NOW }),
    'g-cap': session({ id: 'g-cap', displayTitle: '被截断', updatedAt: NOW - 60_000 }),
    'g-blank': session({ id: 'g-blank', displayTitle: '空会话', blank: true }),
    'g-sub': session({ id: 'g-sub', displayTitle: '子代理', origin: 'subagent' }),
  };
  api.overrideSettings({ positions: { tab: true, topbar: false, sidebar: false }, maxSeats: 1 });
  const harness = createCtx({
    list: { ids, byId },
    statuses: new Map(),
    groups: { items: [{ workspaceId: 'w', sessionIds: ids }], archivedSessionIds: [] },
    workspace: 'w',
  });
  api.apply(harness.ctx, {});
  try {
    const entry = harness.entries.get(api.TABLE_VIEW_ID);
    assert.ok(entry !== undefined, 'the table view is mounted');
    let page = entry.Component({});
    if (typeof page.type === 'function') page = page.type(page.props);

    const groupNodes = collect(page, (props) => typeof props['data-hotlist-missing-group'] === 'string');
    const order = groupNodes.map((node) => node.props['data-hotlist-missing-group']);
    assert.deepEqual(order, ['over-cap', 'empty', 'subagent'], 'groups follow the fixed reading order, not the count order');
    assert.equal(groupNodes.every((node) => node.type === 'details'), true, 'each group is its own disclosure');
    assert.equal(
      groupNodes.every((node) => node.props.open === undefined),
      true,
      'groups start collapsed, so the page is short until someone asks',
    );

    /** Every left-out session still has to be reachable inside some group. */
    const listed = collect(page, (props) => typeof props['data-hotlist-missing'] === 'string')
      .map((node) => node.props['data-hotlist-missing']);
    assert.equal(listed.length, 3, 'all three left-out rows are still rendered');
    assert.deepEqual(listed.slice().sort(), ['empty', 'over-cap', 'subagent'], 'each row keeps the reason it was filed under');

    /** The count badge is the promise the page makes before anything is opened. */
    const badges = collect(page, (props) => props.className === 'hl-missingGroupCount')
      .map((node) => node.children);
    assert.deepEqual(badges, ['1', '1', '1'], 'every group shows how many rows it hides');
  } finally {
    harness.cleanup();
    api.overrideSettings(null);
  }
});

// 106. The seat cap is a plain stepper now, and an unmarked 5-minute window follows the new 17.
test('the cap has no auto mode and the window default replaces the old one', () => {
  const rendered = renderPage();
  try {
    const row = collect(rendered.page, (props) => props['data-hotlist-row'] === 'maxSeats')[0];
    assert.ok(row, 'the seat row is there');
    assert.equal(collect(row, (props) => props['aria-pressed'] !== undefined).length, 0, 'no second control beside the stepper');
    const steps = collect(row, (props) => typeof props['data-hotlist-step'] === 'string').map((btn) => btn.props['data-hotlist-step']);
    assert.deepEqual(steps, ['minus', 'plus'], 'one minus, one plus, nothing else');
  } finally {
    rendered.harness.cleanup();
  }

  /** A profile that stored the old default keeps working, but lands on the new default. */
  const unmarked = api.sanitizeSettings({ maxSeats: 6, collect: { recentWindowMinutes: 5 } });
  assert.equal(unmarked.collect.recentWindowMinutes, 17, 'an unmarked 5 is the old factory default');
  /** Typing 5 through the page brands it as a choice, so the preset rule never touches it again. */
  api.writeSettings({ collect: { recentWindowMinutes: 5 } });
  try {
    assert.equal(api.readSettings().collect.recentWindowMinutes, 5, 'a picked 5 sticks');
    assert.equal(api.sanitizeSettings(JSON.parse(storage.getItem('dsh.hotlist.settings.v1'))).collect.recentWindowMinutes, 5, 'and survives a reload');
  } finally {
    api.writeSettings({ collect: { recentWindowMinutes: 17 } });
  }

  /** A stored `'auto'` still means "as many as fit": only the row's button was removed. */
  const auto = api.sanitizeSettings({ maxSeats: 'auto' });
  assert.equal(auto.maxSeats, 'auto', 'the value is still legal');
  const settings = api.defaultSettings();
  settings.maxSeats = 'auto';
  const ids = ['a', 'b'];
  const byId = { a: session({ id: 'a' }), b: session({ id: 'b' }) };
  const plan = api.buildSeatPlan({
    surface: 'tab', list: { ids, byId }, statuses: new Map(), errors: new Map(), completedAt: new Map(),
    now: NOW, workspaceIds: null, limit: 1,
  }, settings);
  assert.equal(plan.length, 1, 'the plan is bounded by the width-derived limit it is handed');
});


test('display metadata: the plugin list can show a name and an icon', () => {
  const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.icon, './icon.svg', 'manifest icon');
  assert.ok(pkg.exports['./icon'], 'the icon is reachable as a package resource');
  assert.ok(pkg.exports['./locale/*.json'], 'locale files are reachable as package resources');
  assert.ok(pkg.files.includes('icon.svg') && pkg.files.includes('locale'), 'both ship inside the tarball');
  const svg = readFileSync(join(HERE, '..', 'icon.svg'), 'utf8');
  assert.ok(svg.startsWith('<svg'), 'icon.svg is an SVG');
  assert.ok(Buffer.byteLength(svg) <= 256 * 1024, 'under the hosts 256 KiB cap');
  for (const lang of ['en', 'zh']) {
    const meta = JSON.parse(readFileSync(join(HERE, '..', 'locale', lang + '.json'), 'utf8')).meta;
    assert.ok(meta && typeof meta.title === 'string' && meta.title.trim(), lang + ' title');
    assert.ok(meta && typeof meta.description === 'string' && meta.description.trim(), lang + ' description');
  }
});

/**
 * The full-screen ring: off at the factory, one request per class entry when
 * switched on, and the three script arguments come from the host's clamp.
 */
test('ring player: off by default, one ring per entry when switched on', () => {
  const settings = api.sanitizeSettings(api.defaultSettings());
  assert.deepEqual(settings.ring, { pending: false, error: false, completed: false }, 'every ring switch ships off');

  const requests = [];
  const logs = [];
  const player = api.createRingPlayer({
    getSettings: () => settings,
    request: (args) => requests.push(args),
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

  player.observe(shot([]), 1000);
  player.observe(shot([['a', pending]]), 2000);
  assert.equal(requests.length, 0, 'a switched-off class never asks the host for a ring');
  assert.equal(logs.includes('off pending'), true, 'the refusal is visible in the console');

  /** Same edge detector as the sounds: arming first, then one request per entry. */
  settings.ring.pending = true;
  player.observe(shot([]), 3000);
  player.observe(shot([['a', pending]]), 5000);
  assert.equal(requests.length, 1, 'the switch alone does not ring; entering the class does');
  player.observe(shot([['a', pending]]), 6000);
  assert.equal(requests.length, 1, 'the same session in the same class is a repaint');
  assert.deepEqual(
    requests[0],
    { category: 'pending', seconds: 4, scope: 'Primary', anim: 'Expand' },
    'the request carries the three implemented script arguments',
  );

  /** A cold player arms before it rings: the first sync after launch is never a reason to interrupt. */
  const cold = api.createRingPlayer({
    getSettings: () => ({ ...settings, ring: { pending: true, error: true, completed: true } }),
    request: (args) => requests.push(args),
    log: (...args) => logs.push(args.join(' ')),
  });
  cold.observe(shot([['c', pending]]), 9000);
  assert.equal(requests.length, 1, 'the first sync of a fresh player only arms');
  assert.equal(logs.includes('armed pending'), true);

  /** A failing host must not surface as an exception — the ring is optional. */
  const broken = api.createRingPlayer({
    getSettings: () => ({ ...settings, ring: { pending: true, error: true, completed: true } }),
    request: () => {
      throw new Error('offline');
    },
    log: (...args) => logs.push(args.join(' ')),
  });
  broken.observe(shot([['b', pending]]), 100);
  assert.doesNotThrow(() => broken.observe(shot([]), 200), 'an unarmed sync is silent');
  assert.doesNotThrow(() => {
    broken.observe(shot([['b', pending]]), 300);
  }, 'a failed request stays a console line');
});

/**
 * The host half: the arguments the script is started with, and the two ways a
 * machine without `pwsh` could take the host down — a synchronous throw and an
 * asynchronous `error` event on the child.
 */
await testAsync('host ring: script arguments and no-pwsh safety', async () => {
  const host = await import(new URL('./../index.js', import.meta.url).href);

  const clamped = host.ringArgs(new URLSearchParams('seconds=99999&scope=Bogus&anim=Breathe'));
  assert.deepEqual(clamped, { seconds: 30, scope: 'Primary', anim: 'Breathe' }, 'seconds clamp, unknown scope falls back');
  const low = host.ringArgs(new URLSearchParams('seconds=0'));
  assert.equal(low.seconds, 1, 'the floor holds');

  const built = host.ringCommand(clamped, 'C:/x/Show-AttnRing.ps1');
  assert.equal(built.script, 'C:/x/Show-AttnRing.ps1');
  for (const flag of ['-Seconds', '-Scope', '-Anim']) assert.ok(built.argv.includes(flag), `${flag} reaches the script`);
  assert.equal(built.argv[built.argv.indexOf('-Seconds') + 1], '30');

  const spawnCalls = [];
  const okSpawn = (...args) => {
    spawnCalls.push(args);
    return { on() {}, unref() {} };
  };

  /** The marker header is the only thing a foreign page cannot set. */
  const request = (url, headers) => new Request(url, { headers });
  const noMarker = host.serveRing(request('http://127.0.0.1:1/hotlist-ring?seconds=4', {}), {
    spawn: okSpawn,
    log: () => {},
  });
  assert.equal(noMarker.status, 403, 'a request without the marker is refused before anything starts');
  assert.equal(spawnCalls.length, 0);

  const started = host.serveRing(request('http://127.0.0.1:1/hotlist-ring?seconds=6&scope=All&anim=None', { 'x-hotlist-ring': '1' }), {
    spawn: okSpawn,
    log: () => {},
  });
  assert.equal(started.status, 200, 'a marked request starts the ring');
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0][1].includes('-Seconds'), true, 'the spawned argv carries the three flags');
  assert.deepEqual(spawnCalls[0][2], { stdio: 'ignore', windowsHide: true }, 'a pipe would be EPERM here, and detached silently kills the child');

  const cooling = host.serveRing(request('http://127.0.0.1:1/hotlist-ring', { 'x-hotlist-ring': '1' }), {
    spawn: okSpawn,
    log: () => {},
  });
  assert.equal(cooling.status, 429, 'a burst cannot stack processes');

  /** Missing script: no spawn, no throw, one debug line. */
  const ringLogs = [];
  const missing = host.spawnRing({ args: clamped, scriptPath: 'C:/nowhere/Show-AttnRing.ps1', log: (...a) => ringLogs.push(a.join(' ')) });
  assert.equal(missing, false);
  assert.equal(ringLogs.some((line) => line.startsWith('ring script missing')), true);

  /** A synchronous throw from spawn (no such executable) is caught, not propagated. */
  const throwLogs = [];
  const threw = host.spawnRing({
    args: clamped,
    scriptPath: new URL('./../tools/attn-ring/Show-AttnRing.ps1', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    spawn: () => {
      throw new Error('spawn ENOENT');
    },
    log: (...a) => throwLogs.push(a.join(' ')),
  });
  assert.equal(threw, false, 'a missing pwsh is a false return');
  assert.equal(throwLogs.some((line) => line.startsWith('ring spawn threw')), true, 'and one debug line');

  /** An asynchronous error event without a listener kills the host, so the listener has to exist. */
  const listeners = [];
  const child = { on: (name, fn) => listeners.push([name, fn]), unref() {} };
  host.spawnRing({
    args: clamped,
    scriptPath: new URL('./../tools/attn-ring/Show-AttnRing.ps1', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    spawn: () => child,
    log: () => {},
  });
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0][0], 'error', 'the error listener is what keeps a failed spawn from killing the host');
  await sleep(0);
  assert.doesNotThrow(() => listeners[0][1](new Error('ENOENT')), 'the listener body never throws');

  /**
   * The script has to ship with the package or an installed copy can never ring —
   * and only that folder: a bare `tools` would drag the bundled TTS helper and its
   * 1.6 MB of pylibs into every install.
   */
  const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.files.includes('tools/attn-ring'), true, 'tools/attn-ring travels inside the tarball');
  assert.equal(pkg.files.includes('tools'), false, 'the rest of tools/ stays out of the package');
  assert.equal(pkg.exports['./tools'], undefined, 'the script is read from disk, not imported through exports');
  assert.equal(existsSync(host.RING_SCRIPT), true, `the host resolves ${host.RING_SCRIPT}`);
});

console.log(`PASS — ${groups} groups`);