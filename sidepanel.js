/**
 * Simple ChatGPT Sidebar — side panel logic.
 *
 * The panel does not talk to the iframe directly. It watches the same
 * `pendingPaste` key the inject script watches and turns it into a toast;
 * delivery is the inject script's job. One writer path, no double paste.
 */

const notification = document.getElementById('notification');
const notificationText = document.getElementById('notification-text');
const dismissBtn = document.getElementById('dismiss-notification');
const iframe = document.getElementById('chatgpt-frame');

/** @type {number|null} */
let hideTimer = null;

/**
 * Shows a toast with the beginning of the delivered prompt.
 * @param {string} text
 * @param {number} duration ms
 */
function showNotification(text, duration = 2600) {
  const preview = text.length > 42 ? `${text.slice(0, 42)}…` : text;
  notificationText.textContent = `已发送到 ChatGPT：“${preview}”`;
  notification.classList.remove('hidden');

  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideNotification, duration);
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

// --- Follow deliveries -------------------------------------------------------

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const payload = changes.pendingPaste?.newValue;
  if (payload?.text) showNotification(payload.text);
});

// A prompt may already be waiting when the panel opens (right-click → prompt
// opens the panel first, then writes the text).
chrome.storage.local.get('pendingPaste').then(result => {
  if (result?.pendingPaste?.text) showNotification(result.pendingPaste.text);
});

// --- Housekeeping -----------------------------------------------------------

iframe.addEventListener('load', () => {
  console.log('[sidebar] ChatGPT frame loaded');
});
