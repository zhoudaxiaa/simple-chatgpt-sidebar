/**
 * Simple ChatGPT Sidebar — ChatGPT composer injector.
 *
 * Injected into every frame of chatgpt.com. Claims the `paste:<id>` deliveries
 * written by the service worker, types them into the composer, and reports the
 * outcome on `pendingPasteAck` — the side panel shows *that*, not the write,
 * because a successful storage write is no evidence that the text ever landed.
 *
 * Only the frame that has both an extension parent and a composer may consume.
 * `all_frames` also injects into chatgpt.com's own nested frames (auth, bot
 * check, analytics); those used to run the old consume path too and could win
 * the race for a delivery meant for the visible composer.
 *
 * Why not just set `innerHTML`?
 *   ChatGPT's composer is a ProseMirror editor wrapped in React. Writing DOM
 *   directly updates pixels but not the editor state, so the Send button stays
 *   disabled and Enter submits nothing — and the next React render paints the
 *   state back over the DOM, which makes the text vanish. `execCommand`
 *   ('insertText') goes through the browser's editing pipeline, which fires
 *   `beforeinput`/`input` with `inputType: insertText` — exactly what
 *   ProseMirror listens for.
 */

(() => {
  if (window.__simpleChatGptSidebarLoaded) return;
  window.__simpleChatGptSidebarLoaded = true;

  // ===========================================================================
  // Selectors — ordered from most to least specific
  // ===========================================================================

  const COMPOSER_SELECTORS = [
    '#prompt-textarea',
    'div.ProseMirror[contenteditable="true"]',
    'form div[contenteditable="true"]',
    'div[contenteditable="true"]',
    'textarea[data-id="root"]',
    'textarea'
  ];

  const SEND_BUTTON_SELECTORS = [
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="发送"]'
  ];

  const PASTE_PREFIX = 'paste:';
  const ACK_KEY = 'pendingPasteAck';
  /** Deliveries older than this are dropped rather than pasted late. */
  const PASTE_TTL = 30000;
  /**
   * How long a delivery waits for the composer. A cold panel has to boot the
   * whole ChatGPT SPA — loading, hydration and a possible session redirect all
   * happen inside this window, and the old 3s budget routinely ran out.
   */
  const COMPOSER_TIMEOUT = 20000;

  const FLASH_COLOR = 'rgba(16, 163, 127, 0.25)';

  /**
   * Whether this frame is the chatgpt.com document embedded by the extension
   * (side panel, or the popup fallback window).
   * @returns {boolean}
   */
  function isExtensionHosted() {
    if (window.top === window) return false;

    try {
      const parentOrigin = window.location.ancestorOrigins?.[0];
      if (parentOrigin && parentOrigin !== 'null') {
        return parentOrigin.startsWith('chrome-extension://');
      }
    } catch {
      /* ancestorOrigins is not available everywhere */
    }

    // Fallback: a cross-origin parent only contributes its origin, and the
    // extension page's origin is exactly what we are looking for.
    try {
      return document.referrer.startsWith('chrome-extension://');
    } catch {
      return false;
    }
  }

  // A plain chatgpt.com tab, or any nested frame inside one, has no business
  // consuming deliveries: it would steal them from the panel.
  if (!isExtensionHosted()) return;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  /**
   * Whitespace-insensitive comparison. ProseMirror turns `\n` into real
   * paragraph elements, and `textContent` walks them back together without
   * separators — so a byte comparison against the original text would report
   * a mismatch for every multi-line prompt that was in fact inserted fine.
   * @param {string} value
   */
  const flatten = value => (value || '').replace(/\s+/g, '');

  // ===========================================================================
  // Composer lookup
  // ===========================================================================

  function findComposer() {
    for (const selector of COMPOSER_SELECTORS) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  /**
   * An element that occupies space on screen. ChatGPT ships hidden `textarea`
   * and `contenteditable` helpers, and the loose selectors above match them —
   * treating one of those as "the UI is ready" is what let the panel drop its
   * loading cover while the screen was still blank.
   * @param {Element|null} el
   */
  function isVisible(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /** The composer only counts once it is actually on screen. */
  function findVisibleComposer() {
    for (const selector of COMPOSER_SELECTORS) {
      const el = document.querySelector(selector);
      if (isVisible(el)) return el;
    }
    return null;
  }

  /**
   * Waits for the composer to exist instead of retrying forever.
   * Resolves with the element, or null when the timeout expires.
   * @param {number} timeout ms
   */
  function waitForComposer(timeout = COMPOSER_TIMEOUT) {
    const existing = findComposer();
    if (existing) return Promise.resolve(existing);

    return new Promise(resolve => {
      let settled = false;
      const observer = new MutationObserver(() => {
        const el = findComposer();
        if (el) finish(el);
      });
      const timer = setTimeout(() => finish(null), timeout);

      function finish(el) {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(el);
      }

      observer.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  // ===========================================================================
  // Writing into the composer
  // ===========================================================================

  /**
   * Sets a value on a textarea through React's value tracker.
   * @returns {boolean} whether the value stuck
   */
  function setTextareaValue(textarea, value) {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )?.set;

    textarea.focus();
    if (setter) setter.call(textarea, value);
    else textarea.value = value;

    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));

    caretToEnd(textarea);
    return flatten(textarea.value) === flatten(value);
  }

  /** Selects the whole composer content so an insert replaces it. */
  function selectAllIn(element) {
    const range = document.createRange();
    range.selectNodeContents(element);

    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /** Collapses the caret to the end of the composer. */
  function caretToEnd(element) {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);

    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /**
   * Types `text` through the editing pipeline, paragraph by paragraph.
   * Never touches `textContent` / `innerHTML`: that leaves ProseMirror's state
   * empty, so the editor paints the text away on its next render.
   * @returns {boolean} whether the text made it into the editor
   */
  function insertIntoEditable(element, text) {
    element.focus();
    selectAllIn(element);

    // Preferred path: one call, the browser splits paragraphs itself.
    try {
      document.execCommand('insertText', false, text);
    } catch {
      /* fall through to the per-line path */
    }
    if (flatten(element.textContent) === flatten(text)) {
      caretToEnd(element);
      return true;
    }

    // Second path: some builds refuse a multi-line insertText but accept a
    // paragraph break between two single-line inserts.
    element.focus();
    selectAllIn(element);

    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      try {
        if (line) document.execCommand('insertText', false, line);
      } catch {
        return false;
      }

      if (i === lines.length - 1) break;

      let broke = false;
      try {
        broke = document.execCommand('insertParagraph');
      } catch {
        broke = false;
      }
      if (!broke) {
        try {
          broke = document.execCommand('insertLineBreak');
        } catch {
          broke = false;
        }
      }
      if (!broke) {
        try {
          document.execCommand('insertText', false, '\n');
        } catch {
          return false;
        }
      }
    }

    caretToEnd(element);
    return flatten(element.textContent) === flatten(text);
  }

  /**
   * Two soft green pulses so the user can see where the text landed.
   * Restores the element's original inline styles afterwards.
   */
  function flash(element) {
    const previousTransition = element.style.transition;
    const previousBackground = element.style.backgroundColor;

    element.style.transition = 'background-color 180ms ease-in-out';
    element.style.backgroundColor = FLASH_COLOR;

    setTimeout(() => {
      element.style.backgroundColor = 'transparent';
      setTimeout(() => {
        element.style.backgroundColor = FLASH_COLOR;
        setTimeout(() => {
          element.style.backgroundColor = 'transparent';
          setTimeout(() => {
            element.style.backgroundColor = previousBackground;
            element.style.transition = previousTransition;
          }, 220);
        }, 320);
      }, 180);
    }, 320);
  }

  // ===========================================================================
  // Submitting
  // ===========================================================================

  function findSendButton() {
    for (const selector of SEND_BUTTON_SELECTORS) {
      const btn = document.querySelector(selector);
      if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') return btn;
    }
    return null;
  }

  /**
   * Auto-submits when the "Auto-submit prompts" option is enabled.
   * Clicking the send button is tried first (it survives UI rewrites better
   * than a synthetic Enter), with a keyboard fallback.
   */
  async function maybeAutoSubmit() {
    let autoSubmit = false;
    try {
      ({ autoSubmit = false } = await chrome.storage.sync.get('autoSubmit'));
    } catch {
      return;
    }
    if (autoSubmit !== true) return;

    // Give React a tick to re-enable the send button after the insert.
    await sleep(400);

    const button = findSendButton();
    if (button) {
      button.click();
      return;
    }

    const composer = findComposer();
    if (!composer) return;

    composer.focus();
    composer.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      })
    );
  }

  // ===========================================================================
  // Delivery channel
  // ===========================================================================

  /** Reports back to the panel: the only source of a success toast. */
  async function publishAck(item, ok, reason) {
    try {
      await chrome.storage.local.set({
        [ACK_KEY]: {
          id: item.id,
          ok,
          reason,
          preview: item.preview || (item.text || '').slice(0, 42),
          ts: Date.now()
        }
      });
    } catch {
      /* the panel falls back to its own timeout message */
    }
  }

  /** Drops one delivery. Only the claimed key is removed, never the whole set. */
  async function dropDelivery(item) {
    try {
      await chrome.storage.local.remove(item.key);
    } catch {
      /* a stale key is swept by the next write */
    }
  }

  /**
   * Oldest fresh delivery that this document has not touched yet, or null.
   * Expired ones are removed here so they can never replay later.
   */
  async function nextDelivery(handled) {
    const all = await chrome.storage.local.get(null);
    const now = Date.now();

    const entries = Object.keys(all)
      .filter(key => key.startsWith(PASTE_PREFIX))
      .map(key => ({ key, ...all[key] }))
      .filter(item => item?.id && item.text);

    const expired = entries
      .filter(item => now - (item.ts || 0) > PASTE_TTL)
      .map(item => item.key);
    if (expired.length) await chrome.storage.local.remove(expired);

    const fresh = entries
      .filter(item => now - (item.ts || 0) <= PASTE_TTL && !handled.has(item.id))
      .sort((a, b) => (a.ts || 0) - (b.ts || 0));

    return fresh[0] || null;
  }

  /**
   * Fills the composer with one delivery.
   * @returns {Promise<boolean>} false when the composer was never usable
   */
  async function applyDelivery(item) {
    const composer = await waitForComposer();
    if (!composer) {
      await publishAck(item, false, 'no-composer');
      await dropDelivery(item);
      return false;
    }

    const ok =
      composer.tagName === 'TEXTAREA'
        ? setTextareaValue(composer, item.text)
        : insertIntoEditable(composer, item.text);

    if (!ok) {
      await publishAck(item, false, 'insert-failed');
      await dropDelivery(item);
      return false;
    }

    flash(composer);
    await publishAck(item, true, 'inserted');
    await dropDelivery(item);

    await maybeAutoSubmit();
    return true;
  }

  /**
   * Single-flight worker over the delivery keys. Runs one delivery at a time so
   * a slow first one cannot interleave with a second write into the same
   * composer, and stops early once the composer proves unavailable.
   */
  let draining = false;
  let retryTimer = null;
  const handled = new Set();

  /**
   * A delivery that arrived while the worker was busy is only visible through
   * storage, and nothing would wake the worker again once it gives up. One
   * bounded retry covers a ChatGPT that needs a little longer than the wait.
   */
  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void drain();
    }, 5000);
  }

  async function drain() {
    if (draining) return;
    draining = true;

    try {
      for (;;) {
        const item = await nextDelivery(handled);
        if (!item) break;

        handled.add(item.id);
        const ok = await applyDelivery(item);
        if (!ok) {
          scheduleRetry();
          break;
        }
      }
    } catch (err) {
      console.warn('[sidebar] delivery failed:', err);
    } finally {
      draining = false;
    }
  }

  // ===========================================================================
  // Readiness signal
  // ===========================================================================

  /**
   * The panel cannot see inside this frame, and `iframe.onload` fires as soon
   * as the HTML arrives — which for ChatGPT is long before anything is painted.
   * The SPA still has to download its bundle, hydrate and fetch the session, and
   * the panel used to lift its loading cover right at `load`, exposing exactly
   * the blank screen it was meant to hide.
   *
   * The composer showing up is the first moment the UI is actually usable, so
   * that is what gets reported. Only extension-hosted frames get this far
   * (see the guard above), so a normal chatgpt.com tab never sends it.
   */
  let announced = false;

  const readyObserver = new MutationObserver(() => announceReady());

  /**
   * Pages that are *not* the chat UI but are perfectly valid destinations: the
   * login form and the bot check. Waiting for a composer that will never come
   * would leave the panel's loading cover on top of the form the user has to
   * fill in.
   */
  const INTERSTITIAL_SELECTORS = [
    'input[name="username"]',
    'input[name="email"][type="email"]',
    'button[data-testid="login-button"]',
    'form[action*="login"]',
    '#challenge-stage',
    '#cf-challenge-running'
  ];

  /** @returns {{ready: boolean, reason: string}} */
  function detectReady() {
    if (findVisibleComposer()) return { ready: true, reason: 'composer' };

    for (const selector of INTERSTITIAL_SELECTORS) {
      if (isVisible(document.querySelector(selector))) {
        return { ready: true, reason: 'interstitial' };
      }
    }

    return { ready: false, reason: '' };
  }

  function announceReady() {
    if (announced) return;

    const mark = detectReady();
    if (!mark.ready) return;

    announced = true;
    readyObserver.disconnect();

    try {
      // MV3 returns a promise; nobody listening rejects it, which would surface
      // as an unhandled rejection in the page console.
      chrome.runtime
        .sendMessage({ type: 'CHATGPT_READY', reason: mark.reason, ts: Date.now() })
        ?.catch?.(() => {});
    } catch {
      /* panel already closed; nobody to tell */
    }
  }

  announceReady();
  if (!announced) {
    readyObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ===========================================================================
  // Theme signal
  // ===========================================================================

  /**
   * The panel paints a cover over this frame and cannot look inside it, so the
   * theme has to be volunteered. Guessing wrong is very visible: a dark cover
   * over a light ChatGPT ends in a black → white flash the moment it lifts,
   * which reads as the panel having failed to load.
   */
  let lastTheme = '';

  function readTheme() {
    try {
      const cls = document.documentElement.className || '';
      if (/(^|\s)dark(\s|$)/.test(cls)) return 'dark';
      if (/(^|\s)light(\s|$)/.test(cls)) return 'light';

      // Fallback: judge by the page's own background.
      const bg = getComputedStyle(document.body || document.documentElement).backgroundColor;
      const parts = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg || '');
      if (!parts) return '';

      const [r, g, b] = [parts[1], parts[2], parts[3]].map(v => Number(v) / 255);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? 'light' : 'dark';
    } catch {
      return '';
    }
  }

  function reportTheme() {
    const theme = readTheme();
    if (!theme || theme === lastTheme) return;

    lastTheme = theme;
    try {
      chrome.runtime.sendMessage({ type: 'CHATGPT_THEME', theme })?.catch?.(() => {});
    } catch {
      /* panel already closed */
    }
  }

  reportTheme();

  new MutationObserver(reportTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-theme']
  });

  // ===========================================================================
  // Link routing
  // ===========================================================================

  /**
   * A plain left click on a link inside the panel used to navigate the panel
   * itself: ChatGPT was replaced by the target page, and since a side panel has
   * no back button the only way out was closing and reopening it — a fresh cold
   * start, several seconds of loading, lost scroll position.
   *
   * So external links are handed to the service worker, which opens them as a
   * normal tab in the window that hosts the panel. In-site links (another
   * conversation, settings) still navigate in place, because that is what the
   * panel is for.
   */

  /**
   * Hosts the sign-in flow travels through. Opening one of these in another tab
   * would drop the session cookie somewhere the panel cannot see, so the click
   * is left alone and the navigation stays inside the panel.
   */
  const AUTH_HOSTS = [
    'auth.openai.com',
    'auth0.openai.com',
    'accounts.google.com',
    'login.microsoftonline.com',
    'login.live.com',
    'appleid.apple.com'
  ];

  /** Paths where every link belongs to the sign-in flow. */
  const AUTH_PATH = /^\/(auth|login|log-in|signup|sign-up)(\/|$)/i;

  /** The nearest anchor in the event path, shadow DOM included. */
  function findAnchor(event) {
    if (typeof event.composedPath === 'function') {
      for (const node of event.composedPath()) {
        if (node && node.tagName === 'A' && node.href) return node;
      }
    }

    let node = event.target;
    while (node && node !== document) {
      if (node.tagName === 'A' && node.href) return node;
      node = node.parentNode;
    }
    return null;
  }

  /**
   * @param {HTMLAnchorElement} anchor
   * @returns {string|null} url to open in a tab, or null to leave the click be
   */
  function externalTarget(anchor) {
    if (anchor.hasAttribute && anchor.hasAttribute('download')) return null;

    let url;
    try {
      url = new URL(anchor.href, window.location.href);
    } catch {
      return null;
    }

    // mailto:, tel:, blob:, javascript: — the browser handles those better.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    // Same site: keep it in the panel, the SPA router knows what to do.
    if (url.origin === window.location.origin) return null;

    if (AUTH_PATH.test(window.location.pathname || '')) return null;
    if (AUTH_HOSTS.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
      return null;
    }

    return url.href;
  }

  async function openInTab(url) {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'OPEN_LINK_IN_TAB', url });
      if (result?.ok) return;
    } catch {
      /* worker asleep or extension context gone */
    }

    // Last resort: a popup window, still outside the panel.
    try {
      window.open(url, '_blank', 'noopener');
    } catch {
      /* popup blocked; nothing else to try */
    }
  }

  // Capture phase: run before ChatGPT's own handlers, so the SPA router never
  // sees an external click and cannot navigate the frame out from under us.
  document.addEventListener(
    'click',
    event => {
      if (event.defaultPrevented) return;
      // Modified and middle clicks keep the browser's own behaviour: new tab,
      // new window, download — all of which already land outside the panel.
      if (event.button !== 0) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;

      const anchor = findAnchor(event);
      if (!anchor) return;

      const url = externalTarget(anchor);
      if (!url) return;

      event.preventDefault();
      event.stopPropagation();
      void openInTab(url);
    },
    true
  );

  // ===========================================================================
  // Listeners
  // ===========================================================================

  // Primary channel: the service worker publishes one `paste:<id>` key each.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!Object.keys(changes).some(key => key.startsWith(PASTE_PREFIX))) return;
    void drain();
  });

  // Secondary channel, kept for automation and manual testing:
  // sidepanel.postMessage({type:'CHATGPT_SIDEBAR_PASTE', text})
  window.addEventListener('message', event => {
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (data?.type !== 'CHATGPT_SIDEBAR_PASTE' || !data.text) return;

    void (async () => {
      const composer = await waitForComposer();
      if (!composer) return;
      insertIntoEditable(composer, String(data.text));
    })();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'PASTE_TO_CHATGPT' || !message.text) return false;

    void (async () => {
      const composer = await waitForComposer();
      const ok = !!composer && insertIntoEditable(composer, String(message.text));
      sendResponse({ ok });
    })();

    return true;
  });

  // Anything delivered while the panel was still booting. The worker starts
  // before the composer exists and keeps waiting for it, so this no longer
  // races the ChatGPT SPA.
  void drain();
})();
