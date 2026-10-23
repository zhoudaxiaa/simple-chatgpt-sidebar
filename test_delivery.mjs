/**
 * Delivery-channel behaviour tests for chatgpt-inject.js.
 *
 * The injector is an IIFE with no exports, so it is executed for real inside a
 * vm context with a stubbed DOM/storage. Timers are compressed to ~0ms, which
 * turns the 20s composer wait into an instant decision.
 *
 * Covered:
 *   1. a delivery with a ready composer is inserted, acked and removed
 *   2. a delivery with no composer is acked as failed AND removed (no replay)
 *   3. an expired delivery is dropped without touching the composer
 *   4. a nested chatgpt.com frame never consumes (ownership guard)
 *   5. a top-level chatgpt.com tab never consumes (ownership guard)
 *   6. external links leave the panel instead of navigating it
 *
 * Run: node test_delivery.mjs
 */

import fs from 'node:fs';
import vm from 'node:vm';

const SOURCE = fs.readFileSync(new URL('./chatgpt-inject.js', import.meta.url), 'utf8');
const PASTE_PREFIX = 'paste:';
const ACK_KEY = 'pendingPasteAck';

const cases = [];
const eq = (name, actual, expected) =>
  cases.push({ name, ok: actual === expected, actual, expected });
const ok = (name, condition, detail = '') =>
  cases.push({ name, ok: Boolean(condition), actual: detail, expected: '' });

const flatten = value => (value || '').replace(/\s+/g, '');

/**
 * Builds a vm context with a fake composer and a fake storage area, then runs
 * the injector against it.
 *
 * @param {object} options
 * @param {Record<string, object>} options.stored  initial storage.local content
 * @param {boolean} options.hasComposer
 * @param {string[]} options.ancestorOrigins
 * @param {boolean} options.isTopFrame
 * @param {boolean} options.fireChangeEvents  whether writes notify listeners
 */
function runInjector({ stored = {}, hasComposer = true, ancestorOrigins = ['chrome-extension://abc'], isTopFrame = false, fireChangeEvents = true, execMode = 'ok', composerBox = { width: 320, height: 48 }, htmlClass = '', pageHref = 'https://chatgpt.com/', pagePath = '/' } = {}) {
  /** @type {Record<string, any>} */
  const store = { ...stored };
  const changeListeners = [];
  /** Every CHATGPT_READY the injector sent, in order. */
  const readyMessages = [];
  /** Every CHATGPT_THEME the injector sent, in order. */
  const themeMessages = [];
  /** Every OPEN_LINK_IN_TAB the injector sent, in order. */
  const linkMessages = [];
  /** Capture-phase click listeners the injector registered. */
  const clickListeners = [];
  /** Models the DOM selection: replace-on-first-insert, append afterwards. */
  const selection = { active: false };

  const composer = {
    tagName: 'DIV',
    style: {},
    _text: '',
    focus() {},
    getBoundingClientRect() {
      return { ...composerBox, top: 0, left: 0, right: composerBox.width, bottom: composerBox.height };
    },
    get textContent() {
      return this._text;
    }
  };

  const document = {
    documentElement: { className: htmlClass },
    referrer: '',
    querySelector(selector) {
      if (!hasComposer) return null;
      return /contenteditable|textarea|prompt-textarea|ProseMirror/.test(selector) ? composer : null;
    },
    createRange() {
      return { selectNodeContents() {}, collapse() {} };
    },
    execCommand(command, _ui, value) {
      if (command === 'insertText') {
        const text = value == null ? '' : String(value);
        if (execMode === 'noop') return false;
        // Mirrors builds that refuse a multi-line insertText outright.
        if (execMode === 'reject-multiline' && text.includes('\n')) return false;

        composer._text = selection.active ? text : composer._text + text;
        selection.active = false;
        return true;
      }
      if (command === 'insertParagraph' || command === 'insertLineBreak') {
        if (execMode === 'noop') return false;
        composer._text += '\n';
        selection.active = false;
        return true;
      }
      return false;
    },
    addEventListener(type, fn, capture) {
      if (type === 'click' && capture) clickListeners.push(fn);
    }
  };

  const window = {
    location: {
      ancestorOrigins,
      origin: 'https://chatgpt.com',
      href: pageHref,
      pathname: pagePath
    },
    getSelection() {
      return {
        removeAllRanges() {
          selection.active = false;
        },
        addRange() {
          selection.active = true;
        }
      };
    },
    open() {},
    addEventListener() {}
  };
  window.top = isTopFrame ? window : {};

  function notify(changes) {
    if (!fireChangeEvents) return;
    for (const listener of changeListeners) listener(changes, 'local');
  }

  const chrome = {
    storage: {
      local: {
        get: async key => (key === null ? { ...store } : { [key]: store[key] }),
        set: async patch => {
          Object.assign(store, patch);
          notify(Object.fromEntries(Object.keys(patch).map(k => [k, { newValue: patch[k] }])));
        },
        remove: async keys => {
          const list = Array.isArray(keys) ? keys : [keys];
          const changes = {};
          for (const key of list) {
            if (!(key in store)) continue;
            changes[key] = { oldValue: store[key] };
            delete store[key];
          }
          if (Object.keys(changes).length) notify(changes);
        }
      },
      sync: { get: async () => ({}) },
      onChanged: { addListener: fn => changeListeners.push(fn) }
    },
    runtime: {
      onMessage: { addListener() {} },
      sendMessage: message => {
        if (message?.type === 'CHATGPT_READY') readyMessages.push(message);
        if (message?.type === 'CHATGPT_THEME') themeMessages.push(message);
        if (message?.type === 'OPEN_LINK_IN_TAB') {
          linkMessages.push(message);
          return Promise.resolve({ ok: true });
        }
        return Promise.resolve();
      },
      lastError: undefined
    }
  };

  const fastSetTimeout = fn => setTimeout(fn, 0);
  const sandbox = {
    window,
    document,
    chrome,
    console,
    setTimeout: fastSetTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    Date,
    Math,
    Object,
    Array,
    Promise,
    Set,
    Map,
    String,
    Number,
    JSON,
    URL,
    KeyboardEvent: class {}
  };

  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'chatgpt-inject.js' });

  /**
   * Fires a click the way a browser would: through the capture listeners the
   * injector registered on `document`.
   * @param {string} href
   */
  function click(href, { button = 0, ctrlKey = false, metaKey = false, shiftKey = false, altKey = false, download = false } = {}) {
    const anchor = {
      tagName: 'A',
      href,
      parentNode: null,
      hasAttribute: name => (name === 'download' ? download : false)
    };

    const event = {
      type: 'click',
      button,
      ctrlKey,
      metaKey,
      shiftKey,
      altKey,
      defaultPrevented: false,
      propagationStopped: false,
      target: anchor,
      composedPath: () => [anchor, document],
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      }
    };

    for (const listener of clickListeners) listener(event);
    return event;
  }

  return { store, composer, readyMessages, themeMessages, linkMessages, click };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 60));

const delivery = (id, text, ageMs = 0) => ({
  id,
  text,
  preview: text,
  ts: Date.now() - ageMs
});

// --- 1. happy path -----------------------------------------------------------

{
  const text = '解释一下：\n\nconst a = 1;';
  const { store, composer } = runInjector({
    stored: { [PASTE_PREFIX + 'one']: delivery('one', text) }
  });
  await settle();

  eq('ready composer receives the text', flatten(composer._text), flatten(text));
  ok('delivery key removed after insert', !(PASTE_PREFIX + 'one' in store));
  eq('ack reports success', store[ACK_KEY]?.ok, true);
  eq('ack carries the delivery id', store[ACK_KEY]?.id, 'one');
}

// --- 1b. readiness signal (drives the panel's loading cover) -----------------

{
  const { readyMessages } = runInjector({});
  await settle();

  eq('visible composer announces readiness', readyMessages.length, 1);
  eq('readiness carries its reason', readyMessages[0]?.reason, 'composer');
  eq('readiness is typed for the panel', readyMessages[0]?.type, 'CHATGPT_READY');
}

{
  // ChatGPT ships hidden textarea/contenteditable helpers that match the loose
  // selectors; they must never be mistaken for a usable UI.
  const { readyMessages } = runInjector({ composerBox: { width: 0, height: 0 } });
  await settle();

  eq('hidden composer announces nothing', readyMessages.length, 0);
}

{
  const { readyMessages } = runInjector({ isTopFrame: true });
  await settle();

  eq('a plain chatgpt.com tab announces nothing', readyMessages.length, 0);
}

// --- 1c. theme signal (drives the panel's palette) ---------------------------

{
  const { themeMessages } = runInjector({ htmlClass: 'dark' });
  await settle();

  eq('dark theme is reported', themeMessages.length, 1);
  eq('theme value is dark', themeMessages[0]?.theme, 'dark');
}

{
  const { themeMessages } = runInjector({ htmlClass: 'light' });
  await settle();

  eq('theme value is light', themeMessages[0]?.theme, 'light');
}

{
  // No class and no getComputedStyle in the sandbox: stay silent instead of
  // guessing, so the panel keeps following the OS preference.
  const { themeMessages } = runInjector({});
  await settle();

  eq('unknown theme is not reported', themeMessages.length, 0);
}

// --- 2. no composer: fail loudly, never leave a zombie ------------------------

{
  const { store, composer } = runInjector({
    hasComposer: false,
    stored: { [PASTE_PREFIX + 'two']: delivery('two', '总结以下内容：\n\nabc') }
  });
  await settle();

  eq('nothing typed without a composer', composer._text, '');
  eq('ack reports failure', store[ACK_KEY]?.ok, false);
  eq('failure reason is no-composer', store[ACK_KEY]?.reason, 'no-composer');
  ok('failed delivery is dropped, not replayed', !(PASTE_PREFIX + 'two' in store));
}

// --- 3. expired delivery -----------------------------------------------------

{
  const { store, composer } = runInjector({
    stored: { [PASTE_PREFIX + 'old']: delivery('old', '很久以前的问题', 120000) }
  });
  await settle();

  eq('expired delivery is not pasted', composer._text, '');
  ok('expired delivery is cleaned up', !(PASTE_PREFIX + 'old' in store));
  eq('no ack for an expired delivery', store[ACK_KEY], undefined);
}

// --- 4. nested chatgpt.com frame --------------------------------------------

{
  const { store, composer } = runInjector({
    ancestorOrigins: ['https://chatgpt.com'],
    stored: { [PASTE_PREFIX + 'three']: delivery('three', 'nested') }
  });
  await settle();

  eq('nested frame does not paste', composer._text, '');
  ok('nested frame leaves the delivery alone', PASTE_PREFIX + 'three' in store);
}

// --- 5. top-level chatgpt.com tab -------------------------------------------

{
  const { store, composer } = runInjector({
    isTopFrame: true,
    stored: { [PASTE_PREFIX + 'four']: delivery('four', 'top level') }
  });
  await settle();

  eq('top-level tab does not paste', composer._text, '');
  ok('top-level tab leaves the delivery alone', PASTE_PREFIX + 'four' in store);
}

// --- 6. editor refuses a multi-line insert: per-line fallback ----------------

{
  const text = '总结以下内容：\n\n第一行\n第二行';
  const { store, composer } = runInjector({
    execMode: 'reject-multiline',
    stored: { [PASTE_PREFIX + 'five']: delivery('five', text) }
  });
  await settle();

  eq('per-line fallback keeps every line', composer._text, text);
  eq('per-line fallback still acks success', store[ACK_KEY]?.ok, true);
  ok('per-line fallback removes the key', !(PASTE_PREFIX + 'five' in store));
}

// --- 7. editor swallows everything: report failure, never fake success ------

{
  const { store, composer } = runInjector({
    execMode: 'noop',
    stored: { [PASTE_PREFIX + 'six']: delivery('six', '第一行\n第二行') }
  });
  await settle();

  eq('no text without a working editor', composer._text, '');
  eq('ack reports insert-failed', store[ACK_KEY]?.reason, 'insert-failed');
  ok('failed insert is dropped', !(PASTE_PREFIX + 'six' in store));
}

// --- 8. link routing --------------------------------------------------------

{
  const { click, linkMessages } = runInjector({});
  const event = click('https://example.com/article');
  await settle();

  eq('external link is handed to the worker', linkMessages[0]?.url, 'https://example.com/article');
  eq('external link uses the routing message', linkMessages[0]?.type, 'OPEN_LINK_IN_TAB');
  ok('external click is taken over', event.defaultPrevented);
  eq('one tab request per click', linkMessages.length, 1);
}

{
  // Another conversation: navigating inside the panel is the point.
  const { click, linkMessages } = runInjector({});
  const event = click('/c/abc123');
  await settle();

  eq('in-site link stays in the panel', linkMessages.length, 0);
  ok('in-site click is not prevented', !event.defaultPrevented);
}

{
  const { click, linkMessages } = runInjector({});
  click('mailto:someone@example.com');
  await settle();

  eq('mailto is left to the browser', linkMessages.length, 0);
}

{
  const { click, linkMessages } = runInjector({});
  click('https://example.com/report.pdf', { download: true });
  await settle();

  eq('download links are left alone', linkMessages.length, 0);
}

{
  // Opening the OAuth hop in another tab would strand the session.
  const { click, linkMessages } = runInjector({});
  const event = click('https://accounts.google.com/o/oauth2/v2/auth');
  await settle();

  eq('sign-in hosts stay in the panel', linkMessages.length, 0);
  ok('sign-in click is not prevented', !event.defaultPrevented);
}

{
  const { click, linkMessages } = runInjector({ pagePath: '/auth/login' });
  click('https://help.openai.com/');
  await settle();

  eq('no routing while signing in', linkMessages.length, 0);
}

{
  const { click, linkMessages } = runInjector({});
  const event = click('https://example.com/article', { ctrlKey: true });
  await settle();

  eq('ctrl-click keeps the browser default', linkMessages.length, 0);
  ok('ctrl-click is not prevented', !event.defaultPrevented);
}

{
  const { click, linkMessages } = runInjector({ isTopFrame: true });
  click('https://example.com/article');
  await settle();

  eq('a plain chatgpt.com tab keeps its own links', linkMessages.length, 0);
}

// --- report -----------------------------------------------------------------

let failed = 0;
for (const test of cases) {
  if (test.ok) {
    console.log(`  PASS  ${test.name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${test.name}  (got ${JSON.stringify(test.actual)}, want ${JSON.stringify(test.expected)})`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
