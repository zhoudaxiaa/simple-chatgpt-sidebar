/**
 * Simple ChatGPT Sidebar — side panel logic.
 *
 * Ordering matters here. The panel document is destroyed every time the side
 * panel closes, so each open is a cold boot of chatgpt.com and the first frames
 * are the ones users judge. The loading cover is already in the markup, and the
 * ChatGPT frame is attached only after that cover has painted — an iframe shows
 * a white about:blank document the instant it is inserted, and that flash is
 * exactly the "空白" this panel is trying to avoid.
 *
 * The panel never talks to the frame directly. It watches the `paste:<id>` keys
 * the service worker writes and the `pendingPasteAck` the inject script writes
 * back, and reports the *acknowledged* outcome. Reporting on the write alone is
 * what made this panel lie: a successful storage write only means the delivery
 * was handed over, not that ChatGPT had a composer to put it in.
 */

const notification = document.getElementById('notification');
const notificationText = document.getElementById('notification-text');
const dismissBtn = document.getElementById('dismiss-notification');
const container = document.getElementById('container');

const overlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const retryBtn = document.getElementById('loading-retry');
const versionLabel = document.getElementById('loading-version');

const CHATGPT_URL = 'https://chatgpt.com/';

const PASTE_PREFIX = 'paste:';
const ACK_KEY = 'pendingPasteAck';
/** Must stay in sync with the inject script: older deliveries are dropped. */
const PASTE_TTL = 30000;
/** No ack by then means the panel is still booting or ChatGPT never loaded. */
const ACK_TIMEOUT = 25000;

/** Shorter than this and the cover reads as a flash rather than a state. */
const OVERLAY_MIN_VISIBLE = 400;
/** Past this, the spinner alone stops being believable. */
const OVERLAY_SLOW_AFTER = 8000;
/**
 * `load` only means the HTML arrived. ChatGPT is a SPA: the bundle still has to
 * parse, hydrate and fetch the session before anything is painted. The cover is
 * normally lifted by the readiness signal from the inject script; this is the
 * fallback for when no signal ever comes (hard failure, or a page variant
 * neither the composer nor the interstitial probe recognises).
 */
const READY_GRACE_AFTER_LOAD = 20000;

const openedAt = Date.now();

/** @type {number|null} */
let hideTimer = null;

/**
 * The delivery currently waiting for an ack. Acks for anything else are either
 * a replay from a previous panel session or a superseded delivery.
 * @type {string|null}
 */
let pendingId = null;

/** @type {number|null} */
let ackTimer = null;

let frameLoaded = false;
/** @type {number|null} */
let graceTimer = null;
/** @type {number|null} */
let slowTimer = null;

// Printed in the corner of the cover: a one-glance answer to "is the build I am
// looking at actually the one that was just installed?".
if (versionLabel) versionLabel.textContent = `v${chrome.runtime.getManifest().version}`;

// --- Toast ------------------------------------------------------------------

/**
 * @param {string} message
 * @param {number} duration ms, 0 keeps the toast until the next update
 */
function setNotification(message, duration = 2600) {
  notificationText.textContent = message;
  notification.classList.remove('hidden');

  clearTimeout(hideTimer);
  hideTimer = duration > 0 ? setTimeout(hideNotification, duration) : null;
}

function hideNotification() {
  notification.classList.add('hidden');
  clearTimeout(hideTimer);
  hideTimer = null;
}

dismissBtn.addEventListener('click', hideNotification);

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') hideNotification();
});

// --- Loading cover ----------------------------------------------------------

/**
 * Lifts the cover. Called either when the inject script reports a usable UI, or
 * when the grace period after `load` runs out.
 * @param {string} reason  for the console timeline
 */
function hideOverlay(reason = 'grace') {
  if (frameLoaded) return;
  frameLoaded = true;

  clearTimeout(slowTimer);
  clearTimeout(graceTimer);

  console.log(`[sidebar] panel usable after ${Date.now() - openedAt}ms (${reason})`);

  const wait = Math.max(0, OVERLAY_MIN_VISIBLE - (Date.now() - openedAt));
  setTimeout(() => {
    overlay.classList.add('is-done');
    // Keep it out of the layout once the fade finished, so it cannot swallow
    // clicks or sit in the accessibility tree.
    setTimeout(() => overlay.classList.add('hidden'), 260);
  }, wait);
}

function armSlowNotice() {
  slowTimer = setTimeout(() => {
    if (frameLoaded) return;
    loadingText.textContent = 'ChatGPT 加载有点慢，仍在等待…';
    retryBtn.classList.remove('hidden');
  }, OVERLAY_SLOW_AFTER);
}

// --- The ChatGPT frame ------------------------------------------------------

const frame = document.createElement('iframe');
frame.id = 'chatgpt-frame';
frame.setAttribute('allow', 'clipboard-read; clipboard-write');
frame.setAttribute('referrerpolicy', 'no-referrer');

frame.addEventListener('load', () => {
  console.log('[sidebar] ChatGPT frame load');
  // The HTML is here, the UI is not. Let the readiness signal finish the job.
  clearTimeout(graceTimer);
  graceTimer = setTimeout(() => hideOverlay('grace'), READY_GRACE_AFTER_LOAD);
});

// Two frames: the first lets the cover paint, the second guarantees it did
// before an about:blank iframe can paint white over it.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    frame.src = CHATGPT_URL;
    container.insertBefore(frame, overlay);
    armSlowNotice();
  });
});

// Only reachable while the cover is still up, i.e. no `load` ever arrived.
retryBtn.addEventListener('click', () => {
  retryBtn.classList.add('hidden');
  loadingText.textContent = '正在重新加载 ChatGPT…';
  frame.src = CHATGPT_URL;
});

// --- Signals from inside the frame ------------------------------------------

chrome.runtime.onMessage.addListener(message => {
  // Repaint the panel in ChatGPT's own colours. Until this arrives the CSS
  // follows the OS preference, which is right for most setups but not for
  // someone who picked a theme inside ChatGPT.
  if (message?.type === 'CHATGPT_THEME') {
    if (message.theme === 'light' || message.theme === 'dark') {
      document.documentElement.dataset.theme = message.theme;
    }
    return;
  }

  if (message?.type !== 'CHATGPT_READY') return;
  // A chatgpt.com tab that was already open can answer too; only a signal newer
  // than this panel is talking about this frame.
  if ((message.ts || 0) < openedAt) return;

  hideOverlay(message.reason || 'composer');
});

// --- Follow deliveries ------------------------------------------------------

function clearPending() {
  clearTimeout(ackTimer);
  ackTimer = null;
  pendingId = null;
}

/** The write landed in storage; the composer may still be loading. */
function onDelivered(payload) {
  if (!payload?.text || !payload.id) return;

  pendingId = payload.id;
  clearTimeout(ackTimer);
  setNotification(`正在发送到 ChatGPT：“${payload.preview || payload.text}”`, 0);

  ackTimer = setTimeout(() => {
    if (pendingId !== payload.id) return;
    clearPending();
    setNotification('没收到 ChatGPT 的回应：侧边栏可能还在加载，请再试一次。', 6000);
  }, ACK_TIMEOUT);
}

/** The inject script reports what actually happened. */
function onAck(ack) {
  if (!ack?.id) return;
  if (pendingId && ack.id !== pendingId) return;

  clearPending();

  if (ack.ok) {
    setNotification(`已填入输入框：“${ack.preview || ''}”`, 3200);
    return;
  }

  const reason =
    ack.reason === 'insert-failed'
      ? '输入框拒绝写入，点一下输入框后再试一次。'
      : 'ChatGPT 还没有可用的输入框，这次没能填入，请稍后再试一次。';
  setNotification(reason, 6000);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  const pasteKeys = Object.keys(changes).filter(key => key.startsWith(PASTE_PREFIX));
  // A removal also triggers a change without newValue; ignore those.
  const newest = pasteKeys
    .map(key => changes[key].newValue)
    .filter(Boolean)
    .sort((a, b) => (a.ts || 0) - (b.ts || 0))
    .pop();
  if (newest) onDelivered(newest);

  if (changes[ACK_KEY]?.newValue) onAck(changes[ACK_KEY].newValue);
});

// A prompt may already be waiting when the panel opens (right-click → the
// panel opens first, then the text is written). Restore the *real* state: if
// the inject script already answered, show the answer instead of a spinner.
chrome.storage.local.get(null).then(all => {
  const now = Date.now();
  const latest = Object.keys(all)
    .filter(key => key.startsWith(PASTE_PREFIX))
    .map(key => all[key])
    .filter(item => item?.text && now - (item.ts || 0) <= PASTE_TTL)
    .sort((a, b) => (a.ts || 0) - (b.ts || 0))
    .pop();

  if (!latest) {
    // The inject script can finish before this document finishes booting: the
    // delivery key is already gone, only the ack is left. Still worth saying.
    const ack = all[ACK_KEY];
    if (ack?.id && now - (ack.ts || 0) < 5000) onAck(ack);
    return;
  }

  const ack = all[ACK_KEY];
  if (ack?.id === latest.id) onAck(ack);
  else onDelivered(latest);
});

// --- Housekeeping -----------------------------------------------------------

console.log(`[sidebar] panel v${chrome.runtime.getManifest().version}`);
