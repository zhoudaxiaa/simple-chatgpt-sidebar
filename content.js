/**
 * Simple ChatGPT Sidebar — page content script.
 *
 * Runs on every page except ChatGPT itself. Two jobs:
 *   1. hand the current selection back to the service worker (Alt+G)
 *   2. report the page's title / URL for the page-level prompts
 *
 * Why (2) lives here: `chrome.contextMenus.onClicked` does provide a Tab
 * object, but Chrome strips `url` and `title` from it unless the extension
 * holds the `tabs` permission or host access to that page. This extension has
 * neither for ordinary websites, so the Tab it receives looks blank. Reading
 * them from inside the page needs no permission at all.
 *
 * (The original build duplicated the shortcut here as a `keydown` listener.
 * It has been removed: the real `commands` entry gives the service worker a
 * genuine user gesture, which `chrome.sidePanel.open()` requires.)
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'GET_PAGE_INFO') {
    sendResponse({ title: document.title, url: location.href });
    return false;
  }

  if (message?.type !== 'GET_SELECTION') return false;

  const selection = window.getSelection();
  sendResponse({ text: selection ? selection.toString().trim() : '' });
  return false;
});
