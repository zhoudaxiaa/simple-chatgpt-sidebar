/**
 * Simple ChatGPT Sidebar — background service worker (MV3, module).
 *
 * Responsibilities
 *   1. Register every context menu from the stored prompt lists.
 *   2. Turn a context-menu click into a fully formatted prompt.
 *   3. Publish that prompt on the storage channel (`paste:<id>` keys)
 *      which the ChatGPT inject script consumes, and read back the
 *      per-delivery ack it publishes on `pendingPasteAck`.
 *   4. Open the browser side panel — the only surface that keeps ChatGPT
 *      logged in, because Chrome computes the cookie "site for cookies" from
 *      the top-level frame and only an extension page counts as first-party.
 *   5. Hand the ChatGPT session to a local Electron shell (session-bridge.js).
 *
 * Design note: the original build used two competing delivery channels
 * (postMessage + storage) and the side panel re-wrote the same key it was
 * listening to, which produced double pastes. Storage is still the *only*
 * channel, but it is now two-way: one `paste:<id>` key per delivery, and an
 * ack the inject script writes back after it either filled the composer or
 * gave up. That ack is what the toast reports — a bare storage write is not
 * evidence that ChatGPT ever received anything.
 */

import {
  DEFAULT_PAGE_PROMPTS,
  DEFAULT_SELECTION_PROMPTS,
  clonePagePrompts,
  cloneSelectionPrompts,
  localizePrompts
} from './shared/defaults.js';
import { formatPagePrompt, formatSelectionPrompt, stripEmptyLabels } from './shared/template.js';
import { resolvePageInfo } from './shared/page-info.js';
import { readBridgeConfig, syncSession } from './session-bridge.js';

// =============================================================================
// Constants
// =============================================================================

/** Context-menu id prefixes. The prompt id follows the separator. */
const SEL_PREFIX = 'sel|';
const PAGE_PREFIX = 'page|';

const MENU = {
  selectionRoot: 'ask-chatgpt',
  selectionRaw: 'selection-raw',
  selectionSep: 'selection-sep',
  pageRoot: 'page-chatgpt',
  pageCustom: 'page-custom-input',
  pageSep1: 'page-sep-1',
  pageSep2: 'page-sep-2',
  pageOpen: 'page-open-sidebar',
  pageSep3: 'page-sep-3',
  pageSyncSession: 'page-sync-session',
  pageSettings: 'page-settings'
};

/** Storage keys owned by this extension. */
const KEY = {
  pagePrompts: 'pagePrompts',
  selectionPrompts: 'selectionPrompts',
  autoSubmit: 'autoSubmit',
  /**
   * One storage key per delivery: `paste:<id>`. A single shared slot would
   * overwrite an in-flight prompt and forced read-modify-write on every
   * consumer; distinct keys mean the inject script only ever deletes the
   * exact item it handled.
   */
  pastePrefix: 'paste:',
  /** Pre-1.1 single slot. Swept on boot so old payloads cannot replay. */
  legacyPaste: 'pendingPaste',
  pageInfo: 'promptInputPageInfo',
  promptTabId: 'promptInputTabId'
};

/** A delivery older than this is dropped instead of pasted late. */
const PASTE_TTL = 30000;
/** Stale keys are swept at twice the TTL to leave the consumer room to react. */
const PASTE_SWEEP_AGE = PASTE_TTL * 4;

// =============================================================================
// Boot
// =============================================================================

chrome.runtime.onInstalled.addListener(async () => {
  await seedDefaults();
  await buildContextMenus();
  void autoSync();
  console.log('[sidebar] installed, menus built');
});

chrome.runtime.onStartup.addListener(() => {
  buildContextMenus();
  void autoSync();
});

// Runs on every service-worker boot as well: an unpacked reload does not always
// fire onInstalled, and the localisation migration below has to reach installs
// that were created while the defaults were still English.
void seedDefaults();

// Which build is actually running is the first question in every bug report,
// and "I reloaded it" is not proof. One line on every worker boot settles it.
console.log(`[sidebar] background v${chrome.runtime.getManifest().version}`);

// Drops the pre-1.1 single slot. The old reader replayed whatever it found
// there on every panel load, so a failed delivery from an older build could
// still surface as a phantom paste in the composer.
void chrome.storage.local.remove(KEY.legacyPaste);

/**
 * Writes the default prompt lists into storage the first time the extension
 * runs, and translates defaults that are still in their original English form.
 * Every context reads from the same place, so this is the only writer.
 */
async function seedDefaults() {
  const stored = await chrome.storage.sync.get([KEY.pagePrompts, KEY.selectionPrompts]);
  const patch = {};

  const page = stored[KEY.pagePrompts];
  if (!Array.isArray(page)) {
    patch[KEY.pagePrompts] = clonePagePrompts();
  } else {
    const localized = localizePrompts(page, DEFAULT_PAGE_PROMPTS);
    if (localized !== page) patch[KEY.pagePrompts] = localized;
  }

  const selection = stored[KEY.selectionPrompts];
  if (!Array.isArray(selection)) {
    patch[KEY.selectionPrompts] = cloneSelectionPrompts();
  } else {
    const localized = localizePrompts(selection, DEFAULT_SELECTION_PROMPTS);
    if (localized !== selection) patch[KEY.selectionPrompts] = localized;
  }

  if (Object.keys(patch).length) await chrome.storage.sync.set(patch);
}

/** @returns {Promise<{page: Array, selection: Array}>} */
async function loadPrompts() {
  const stored = await chrome.storage.sync.get([KEY.pagePrompts, KEY.selectionPrompts]);
  return {
    page: Array.isArray(stored[KEY.pagePrompts]) ? stored[KEY.pagePrompts] : clonePagePrompts(),
    selection: Array.isArray(stored[KEY.selectionPrompts])
      ? stored[KEY.selectionPrompts]
      : cloneSelectionPrompts()
  };
}

// =============================================================================
// Context menus
// =============================================================================

/**
 * Rebuilds every menu item from the stored prompt lists.
 * `removeAll` is awaited first: creating a duplicate id throws.
 */
async function buildContextMenus() {
  await chrome.contextMenus.removeAll();

  const { page, selection } = await loadPrompts();
  const enabledSelection = selection.filter(p => p.enabled !== false);
  const enabledPage = page.filter(p => p.enabled !== false);

  if (enabledSelection.length) buildSelectionMenus(enabledSelection);
  buildPageMenus(enabledPage);

  console.log('[sidebar] context menus rebuilt');
}

function createMenu(props) {
  chrome.contextMenus.create(props, () => {
    // Reading lastError suppresses the "duplicate id" noise in the console.
    void chrome.runtime.lastError;
  });
}

/** "Ask ChatGPT" submenu, shown only when text is selected. */
function buildSelectionMenus(prompts) {
  createMenu({
    id: MENU.selectionRoot,
    title: '问 ChatGPT',
    contexts: ['selection']
  });

  for (const prompt of prompts) {
    createMenu({
      id: SEL_PREFIX + prompt.id,
      parentId: MENU.selectionRoot,
      title: prompt.name,
      contexts: ['selection']
    });
  }

  createMenu({
    id: MENU.selectionSep,
    parentId: MENU.selectionRoot,
    type: 'separator',
    contexts: ['selection']
  });

  createMenu({
    id: MENU.selectionRaw,
    parentId: MENU.selectionRoot,
    title: '直接发送到 ChatGPT',
    contexts: ['selection']
  });
}

/** "Ask ChatGPT about this page" submenu. */
function buildPageMenus(prompts) {
  createMenu({
    id: MENU.pageRoot,
    title: '就这个页面问 ChatGPT',
    contexts: ['page']
  });

  for (const prompt of prompts) {
    createMenu({
      id: PAGE_PREFIX + prompt.id,
      parentId: MENU.pageRoot,
      title: prompt.name,
      contexts: ['page']
    });
  }

  if (prompts.length) {
    createMenu({
      id: MENU.pageSep1,
      parentId: MENU.pageRoot,
      type: 'separator',
      contexts: ['page']
    });
  }

  createMenu({
    id: MENU.pageCustom,
    parentId: MENU.pageRoot,
    title: '自定义提问…',
    contexts: ['page']
  });

  createMenu({
    id: MENU.pageSep2,
    parentId: MENU.pageRoot,
    type: 'separator',
    contexts: ['page']
  });

  createMenu({
    id: MENU.pageOpen,
    parentId: MENU.pageRoot,
    title: '打开侧边栏',
    contexts: ['page']
  });

  createMenu({
    id: MENU.pageSep3,
    parentId: MENU.pageRoot,
    type: 'separator',
    contexts: ['page']
  });

  createMenu({
    id: MENU.pageSyncSession,
    parentId: MENU.pageRoot,
    title: '同步登录态到桌面端',
    contexts: ['page']
  });

  createMenu({
    id: MENU.pageSettings,
    parentId: MENU.pageRoot,
    title: '设置…',
    contexts: ['page']
  });
}

// =============================================================================
// Sidebar surface
//
// The panel MUST be a top-level extension page: Chrome computes the cookie
// "site for cookies" from the top-level frame, so chatgpt.com only receives
// its SameSite=Lax session cookie when the embedding document is an extension
// page. Embedded in a normal https page it renders logged out.
//
// `chrome.sidePanel` is the native way to host such a page. It exposes open()
// only — closing the panel destroys its document, so the next open reloads
// ChatGPT. That is a Chrome limitation, not something the extension can dodge.
// =============================================================================

/**
 * Opens the side panel for a tab.
 * `open()` requires a user gesture, so it must be reached without detouring
 * through the page, and it fails cleanly on chrome:// pages.
 * @param {chrome.tabs.Tab|undefined} tab
 */
function openSidePanel(tab) {
  /** @type {{tabId?: number, windowId?: number}|null} */
  let target = null;
  if (tab?.id != null) target = { tabId: tab.id };
  else if (tab?.windowId != null) target = { windowId: tab.windowId };

  if (!target) {
    openPopupWindow();
    return;
  }

  chrome.sidePanel.open(target).catch(err => {
    console.error('[sidebar] sidePanel.open failed', err);
    openPopupWindow();
  });
}

/**
 * Last resort for pages that reject sidePanel.open() (chrome://, the Web
 * Store, the PDF viewer). A plain window still shows ChatGPT logged in: it is
 * the same top-level extension document, just hosted differently.
 */
function openPopupWindow() {
  chrome.windows.create({
    url: 'sidepanel.html',
    type: 'popup',
    width: 480,
    height: 920
  });
}

// =============================================================================
// Delivery channel
// =============================================================================

/**
 * Publishes a prompt for the inject script to paste into the ChatGPT composer.
 *
 * The write only means "handed to the panel" — it does NOT mean the text
 * reached the composer, which is why every delivery carries its own key and
 * the inject script answers on `pendingPasteAck`. The panel's toast waits for
 * that ack instead of firing on the write.
 *
 * A fresh id also makes every write observable, even when the text is
 * byte-identical to the previous one (storage.onChanged would otherwise stay
 * silent on the same key).
 *
 * @param {string} text
 * @returns {Promise<string|null>} the delivery id
 */
async function deliverPrompt(text) {
  if (!text) return null;

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const preview = text.length > 42 ? `${text.slice(0, 42)}…` : text;

  await chrome.storage.local.set({
    [KEY.pastePrefix + id]: { id, text, preview, ts: Date.now() }
  });

  void sweepStalePastes();
  return id;
}

/**
 * Removes deliveries nobody consumed (the panel was closed before the inject
 * script could run). Without this they would pile up in storage forever and,
 * worse, could be replayed long after the user asked for them.
 */
async function sweepStalePastes() {
  try {
    const all = await chrome.storage.local.get(null);
    const now = Date.now();
    const stale = Object.keys(all).filter(key => {
      if (!key.startsWith(KEY.pastePrefix)) return false;
      return now - (all[key]?.ts || 0) > PASTE_SWEEP_AGE;
    });
    if (stale.length) await chrome.storage.local.remove(stale);
  } catch {
    /* storage hiccup: the next write sweeps again */
  }
}

// =============================================================================
// Link routing
// =============================================================================

/**
 * Opens a link the user clicked inside the panel as a real tab.
 *
 * Without this, an external link clicked in the ChatGPT frame navigates that
 * frame: ChatGPT is replaced by the target page and the panel has no back
 * button, so the only way back is closing and reopening it — which also means
 * a fresh cold start.
 *
 * `chrome.tabs.create` needs no `tabs` permission (that one only gates reading
 * existing tabs), so this adds no new permission prompt.
 *
 * @param {string} rawUrl
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function openLinkInTab(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || ''));
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported-scheme' };
  }

  try {
    await chrome.tabs.create({ url: url.href, active: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'open-failed', detail: String(err) };
  }
}

// =============================================================================
// Desktop session bridge
//
// The toolbar button already opens the side panel, so the bridge hangs off two
// other entry points: a context-menu item and a button in the options page.
// Auto-sync runs on browser start rather than on every service-worker boot —
// a worker wakes roughly every 30 seconds, and posting the whole cookie jar
// that often is exactly what the standalone bridge got wrong.
// =============================================================================

/** Flashes a character on the toolbar icon for four seconds. */
function flashIcon(text, color = '#c0392b') {
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
  chrome.action.setBadgeText({ text }).catch(() => {});
  setTimeout(() => chrome.action.setBadgeText({ text: '' }).catch(() => {}), 4000);
}

/** Flashes the outcome on the toolbar icon for four seconds. */
function showSyncBadge(result) {
  const text = result.ok ? '✓' : result.reason === 'empty' ? '0' : '!';
  flashIcon(text, result.ok ? '#10a37f' : '#c0392b');
}

/** Manual sync: always reports, because the user asked for it. */
async function runSync() {
  const result = await syncSession();
  showSyncBadge(result);
  return result;
}

/**
 * Startup sync. A shell that is not running is the normal case, so a failure
 * here only goes to the console instead of leaving a red badge on the icon.
 */
async function autoSync() {
  const config = await readBridgeConfig();
  if (!config.auto) return;

  const result = await syncSession(config);
  if (result.ok) showSyncBadge(result);
  else console.info('[sidebar] session bridge skipped:', result.reason);
}

// =============================================================================
// Toolbar button + keyboard shortcuts
// =============================================================================

chrome.action.onClicked.addListener(tab => {
  openSidePanel(tab);
});

chrome.commands.onCommand.addListener(async command => {
  if (command !== 'open-sidebar-with-selection') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  // Ask the page for its current selection; silently skip when the content
  // script is not available (chrome:// pages, PDF viewer, Web Store…).
  let text = '';
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'GET_SELECTION' });
    text = res?.text || '';
  } catch {
    /* no content script on this page */
  }

  openSidePanel(tab);
  if (text) await deliverPrompt(text);
});

// =============================================================================
// Page identity
//
// See shared/page-info.js: the Tab handed over by contextMenus.onClicked has no
// url/title unless the extension holds the `tabs` permission, so the identity is
// resolved against the page instead.
// =============================================================================

// =============================================================================
// Context menu clicks
// =============================================================================

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const id = String(info.menuItemId);

  // ---- Settings: no panel needed -------------------------------------------
  if (id === MENU.pageSettings) {
    chrome.runtime.openOptionsPage();
    return;
  }

  // ---- Session bridge: no panel needed -------------------------------------
  if (id === MENU.pageSyncSession) {
    void runSync();
    return;
  }

  // ---- Custom prompt popup -------------------------------------------------
  if (id === MENU.pageCustom) {
    // Show the sidebar first: the popup window steals focus, and focus loss
    // makes a later sidePanel.open() fail.
    openSidePanel(tab);
    await chrome.storage.local.set({
      [KEY.pageInfo]: await resolvePageInfo(chrome, tab),
      [KEY.promptTabId]: tab?.id ?? null
    });
    chrome.windows.create({
      url: 'prompt-input.html',
      type: 'popup',
      width: 460,
      height: 380,
      top: 120,
      left: 120
    });
    return;
  }

  // ---- Open only -----------------------------------------------------------
  if (id === MENU.pageOpen) {
    openSidePanel(tab);
    return;
  }

  // ---- Everything below also needs the panel open --------------------------
  openSidePanel(tab);

  // ---- Raw selection -------------------------------------------------------
  if (id === MENU.selectionRaw) {
    if (info.selectionText) await deliverPrompt(info.selectionText);
    return;
  }

  const { page, selection } = await loadPrompts();

  // ---- Selection prompt ----------------------------------------------------
  if (id.startsWith(SEL_PREFIX)) {
    if (!info.selectionText) return;
    const promptId = id.slice(SEL_PREFIX.length);
    const prompt = selection.find(p => p.id === promptId);
    if (prompt) await deliverPrompt(formatSelectionPrompt(prompt, info.selectionText));
    return;
  }

  // ---- Page prompt ---------------------------------------------------------
  if (id.startsWith(PAGE_PREFIX)) {
    const promptId = id.slice(PAGE_PREFIX.length);
    const prompt = page.find(p => p.id === promptId);
    if (!prompt) return;

    const body = formatPagePrompt(prompt, await resolvePageInfo(chrome, tab));
    if (body) {
      await deliverPrompt(body);
    } else {
      // Nothing to send: the page has no identity to attach (a chrome:// page,
      // the PDF viewer, a page where the content script is not allowed).
      // Better a red "!" than a menu item that appears to do nothing.
      flashIcon('!');
    }
  }
});

// =============================================================================
// Messages from the options page, the custom-prompt window and the bridge
// =============================================================================

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message?.type) {
    case 'REBUILD_MENUS':
      buildContextMenus()
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: String(err) }));
      return true;

    case 'CUSTOM_PROMPT_SUBMIT':
      deliverPrompt(stripEmptyLabels(message.prompt))
        .then(() => chrome.storage.local.remove([KEY.pageInfo, KEY.promptTabId]))
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: String(err) }));
      return true;

    case 'OPEN_LINK_IN_TAB':
      openLinkInTab(message.url)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ ok: false, reason: 'exception', detail: String(err) }));
      return true;

    case 'SYNC_SESSION':
      runSync()
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ ok: false, count: 0, reason: 'exception', detail: String(err) }));
      return true;

    default:
      return false;
  }
});

// Exported for unit-testing the pure helpers in a plain Node context.
export { DEFAULT_PAGE_PROMPTS, DEFAULT_SELECTION_PROMPTS };
