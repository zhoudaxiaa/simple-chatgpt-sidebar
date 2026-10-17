/**
 * Simple ChatGPT Sidebar — page content script.
 *
 * Runs on every page except ChatGPT itself. Its only job is to hand the
 * current selection back to the service worker when the Alt+G command fires.
 *
 * (The original build duplicated the shortcut here as a `keydown` listener.
 * It has been removed: the real `commands` entry gives the service worker a
 * genuine user gesture, which `chrome.sidePanel.open()` requires.)
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'GET_SELECTION') return false;

  const selection = window.getSelection();
  sendResponse({ text: selection ? selection.toString().trim() : '' });
  return false;
});
