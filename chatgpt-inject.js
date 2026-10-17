/**
 * Simple ChatGPT Sidebar — ChatGPT composer injector.
 *
 * Injected into every frame of chatgpt.com. Watches the `pendingPaste` storage
 * key and writes the incoming prompt into ChatGPT's composer.
 *
 * Why not just set `innerHTML`?
 *   ChatGPT's composer is a ProseMirror editor wrapped in React. Writing DOM
 *   directly updates pixels but not the editor state, so the Send button stays
 *   disabled and Enter submits nothing. `execCommand('insertText')` goes through
 *   the browser's editing pipeline, which fires `beforeinput`/`input` with
 *   `inputType: insertText` — exactly what ProseMirror listens for.
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

  const PASTE_KEY = 'pendingPaste';
  const FLASH_COLOR = 'rgba(16, 163, 127, 0.25)';

  /**
   * The sidebar hosts ChatGPT inside a frame, so only embedded frames should
   * consume deliveries. Without this guard, having chatgpt.com open in a normal
   * tab would make that tab swallow prompts meant for the sidebar.
   */
  const IS_EMBEDDED = window.top !== window;

  /** Ids already consumed, so a storage echo cannot paste twice. */
  let handledId = null;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
   * Waits for the composer to exist instead of retrying forever.
   * Resolves with the element, or null when the timeout expires.
   * @param {number} timeout ms
   */
  function waitForComposer(timeout = 15000) {
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

  /** Sets a value on a textarea through React's value tracker. */
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

  /** @returns {boolean} whether the text made it into the editor. */
  function insertIntoEditable(element, text) {
    element.focus();
    selectAllIn(element);

    // Preferred path: goes through the editing pipeline (ProseMirror aware).
    let ok = false;
    try {
      ok = document.execCommand('insertText', false, text);
    } catch {
      ok = false;
    }

    if (!ok || element.textContent.trim() !== text.trim()) {
      // Fallback for editors that ignore execCommand.
      element.textContent = '';
      const paragraph = document.createElement('p');
      paragraph.textContent = text;
      element.appendChild(paragraph);

      element.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: text
        })
      );
    }

    caretToEnd(element);
    return true;
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
  // Paste pipeline
  // ===========================================================================

  /**
   * @param {string} text
   * @param {string|null} id  Storage id of this delivery, used for de-duping.
   */
  async function pastePrompt(text, id = null) {
    if (!text) return;

    // Only the frame that actually owns a composer should react.
    const composer = await waitForComposer(3000);
    if (!composer) return;

    if (composer.tagName === 'TEXTAREA') {
      setTextareaValue(composer, text);
    } else {
      insertIntoEditable(composer, text);
    }

    flash(composer);

    if (id) await chrome.storage.local.remove(PASTE_KEY);

    await maybeAutoSubmit();
  }

  /** Consumes a `pendingPaste` payload exactly once. */
  function consume(payload) {
    if (!IS_EMBEDDED) return;
    if (!payload || !payload.text) return;
    if (payload.id && payload.id === handledId) return;
    handledId = payload.id || null;
    pastePrompt(payload.text, payload.id || null);
  }

  // ===========================================================================
  // Listeners
  // ===========================================================================

  // Primary channel: the service worker / custom-prompt popup publish here.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!changes[PASTE_KEY]?.newValue) return;
    consume(changes[PASTE_KEY].newValue);
  });

  // Secondary channel, kept for automation and manual testing:
  // sidepanel.postMessage({type:'CHATGPT_SIDEBAR_PASTE', text})
  window.addEventListener('message', event => {
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (data?.type === 'CHATGPT_SIDEBAR_PASTE' && data.text) {
      pastePrompt(String(data.text));
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'PASTE_TO_CHATGPT' && message.text) {
      pastePrompt(String(message.text));
      sendResponse({ ok: true });
    }
    return false;
  });

  // Anything delivered while the panel was still loading.
  chrome.storage.local.get(PASTE_KEY).then(result => {
    const payload = result?.[PASTE_KEY];
    if (!payload) return;
    // Let the composer mount before writing into it.
    setTimeout(() => consume(payload), 600);
  });
})();
