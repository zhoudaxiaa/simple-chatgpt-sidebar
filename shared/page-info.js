/**
 * Page identity resolution.
 *
 * `chrome.contextMenus.onClicked` hands over a Tab object, but Chrome strips
 * `url` and `title` from it unless the extension holds the `tabs` permission or
 * host access to that page. This extension has neither for ordinary websites,
 * so the Tab it receives looks blank — which is how every page prompt ended up
 * carrying an empty "标题：" / "链接：" pair.
 *
 * Three ways in, cheapest first:
 *   1. the content script that already runs on every page (no permission)
 *   2. `scripting.executeScript` under `activeTab`, granted by the context-menu
 *      click itself — this is what rescues tabs that were already open when the
 *      extension was (re)loaded, since Chrome never injects content scripts
 *      into those retroactively
 *   3. whatever the Tab object happens to carry
 *
 * The API is injected instead of reached through a global so the fallback chain
 * can be tested without Chrome.
 */

/**
 * @typedef {{title: string, url: string}} PageInfo
 * @typedef {{tabs: any, scripting: any}} ChromeApi
 */

/**
 * @param {ChromeApi} api  The `chrome` namespace (stubbed in tests).
 * @param {chrome.tabs.Tab|undefined} tab
 * @returns {Promise<PageInfo>}
 */
export async function resolvePageInfo(api, tab) {
  const fallback = { title: tab?.title || '', url: tab?.url || '' };
  if (tab?.id == null) return fallback;

  // 1. Ask the content script.
  try {
    const info = await api.tabs.sendMessage(tab.id, { type: 'GET_PAGE_INFO' });
    if (info?.url || info?.title) {
      return { title: info.title || '', url: info.url || '' };
    }
  } catch {
    /* no content script in this tab */
  }

  // 2. Read it from the page directly.
  try {
    const [injection] = await api.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({ title: document.title, url: location.href })
    });
    const info = injection?.result;
    if (info?.url || info?.title) {
      return { title: info.title || fallback.title, url: info.url || fallback.url };
    }
  } catch {
    /* chrome:// pages, the Web Store, the PDF viewer, activeTab not granted */
  }

  // 3. Last resort.
  return fallback;
}
