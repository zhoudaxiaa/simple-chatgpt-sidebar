/**
 * Simple ChatGPT Sidebar — options page logic (ES module).
 *
 * State model
 *   pagePrompts / selectionPrompts  live in chrome.storage.sync, mirrored here.
 *   trash                           session only: closing the page empties it.
 *
 * Every mutation follows the same path: mutate the array -> saveSettings()
 * (which also asks the service worker to rebuild the context menus) -> render.
 */

import {
  DEFAULT_PAGE_PROMPTS,
  DEFAULT_SELECTION_PROMPTS,
  clonePagePrompts,
  cloneSelectionPrompts
} from './shared/defaults.js';
import { BRIDGE_DEFAULTS, readBridgeConfig } from './session-bridge.js';

// --- DOM ---------------------------------------------------------------------

const pageList = document.getElementById('page-prompts-list');
const selectionList = document.getElementById('selection-prompts-list');

const modal = document.getElementById('modal');
const modalTitle = document.getElementById('modal-title');
const modalBackdrop = document.getElementById('modal-backdrop');
const modalClose = document.getElementById('modal-close');
const modalCancel = document.getElementById('modal-cancel');
const promptForm = document.getElementById('prompt-form');
const nameInput = document.getElementById('prompt-name');
const templateInput = document.getElementById('prompt-template');
const templateHint = document.getElementById('template-hint');
const includeUrlGroup = document.getElementById('include-url-group');
const includeUrlInput = document.getElementById('prompt-include-url');

const trashModal = document.getElementById('trash-modal');
const trashModalClose = document.getElementById('trash-modal-close');
const trashDoneBtn = document.getElementById('trash-done');
const trashList = document.getElementById('trash-list');
const trashEmpty = document.getElementById('trash-empty');
const trashCount = document.getElementById('trash-count');
const openTrashBtn = document.getElementById('open-trash');
const emptyTrashBtn = document.getElementById('empty-trash');

const confirmModal = document.getElementById('confirm-modal');
const confirmClose = document.getElementById('confirm-close');
const confirmCancel = document.getElementById('confirm-cancel');
const confirmYes = document.getElementById('confirm-yes');
const restoreDefaultsBtn = document.getElementById('restore-defaults');

const autoSubmitToggle = document.getElementById('auto-submit-toggle');
const bridgeAutoToggle = document.getElementById('bridge-auto');
const bridgeUrlInput = document.getElementById('bridge-url');
const bridgeTokenInput = document.getElementById('bridge-token');
const bridgeSyncBtn = document.getElementById('bridge-sync');
const bridgeStatus = document.getElementById('bridge-status');
const toast = document.getElementById('toast');
const toastMessage = document.getElementById('toast-message');

// --- State -------------------------------------------------------------------

/** @type {Array} */ let pagePrompts = [];
/** @type {Array} */ let selectionPrompts = [];
/** @type {Array<{type: string, prompt: object}>} */ let trash = [];
/** @type {{prompt: object, index: number}|null} */ let editing = null;
/** @type {'page'|'selection'|null} */ let editingType = null;

const listFor = type => (type === 'page' ? pagePrompts : selectionPrompts);

// --- Persistence -------------------------------------------------------------

async function loadSettings() {
  const stored = await chrome.storage.sync.get([
    'pagePrompts',
    'selectionPrompts',
    'autoSubmit'
  ]);

  pagePrompts = Array.isArray(stored.pagePrompts) ? stored.pagePrompts : clonePagePrompts();
  selectionPrompts = Array.isArray(stored.selectionPrompts)
    ? stored.selectionPrompts
    : cloneSelectionPrompts();

  autoSubmitToggle.checked = stored.autoSubmit === true;

  // The bridge stores its own three keys; readBridgeConfig already applies the
  // defaults, so the inputs always show the value that will actually be used.
  const bridge = await readBridgeConfig();
  bridgeAutoToggle.checked = bridge.auto;
  bridgeUrlInput.value = bridge.url;
  bridgeTokenInput.value = bridge.token;

  renderAll();
}

async function saveSettings() {
  await chrome.storage.sync.set({ pagePrompts, selectionPrompts });
  // Fire and forget: the menu rebuild is idempotent and the reply is not needed.
  chrome.runtime.sendMessage({ type: 'REBUILD_MENUS' }).catch(() => {});
}

// --- Rendering ---------------------------------------------------------------

function renderAll() {
  renderList(pageList, pagePrompts, 'page');
  renderList(selectionList, selectionPrompts, 'selection');
  updateTrashCount();
}

const ICON_UP = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>`;
const ICON_DOWN = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>`;
const ICON_EDIT = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
const ICON_DELETE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
const ICON_RESTORE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`;
const ICON_X = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

function renderList(container, prompts, type) {
  container.replaceChildren();

  if (!prompts.length) {
    container.innerHTML = '<div class="empty-state">还没有提示词，点「+ 添加」新建一条。</div>';
    return;
  }

  prompts.forEach((prompt, index) => {
    const enabled = prompt.enabled !== false;
    const item = document.createElement('div');
    item.className = `prompt-item${enabled ? '' : ' disabled'}`;
    item.dataset.type = type;
    item.dataset.index = String(index);

    item.innerHTML = `
      <div class="prompt-order">
        <button class="btn btn-icon" data-action="up" title="上移" ${index === 0 ? 'disabled' : ''}>${ICON_UP}</button>
        <button class="btn btn-icon" data-action="down" title="下移" ${index === prompts.length - 1 ? 'disabled' : ''}>${ICON_DOWN}</button>
      </div>
      <div class="prompt-toggle">
        <label class="toggle-switch">
          <input type="checkbox" data-role="toggle" ${enabled ? 'checked' : ''} aria-label="启用 ${escapeAttr(prompt.name)}">
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="prompt-info">
        <span class="prompt-name">${escapeHtml(prompt.name)}</span>
      </div>
      <div class="prompt-actions">
        <button class="btn btn-icon" data-action="edit" title="编辑">${ICON_EDIT}</button>
        <button class="btn btn-icon delete" data-action="delete" title="删除">${ICON_DELETE}</button>
      </div>
    `;

    container.appendChild(item);
  });
}

// --- Delegated list events ---------------------------------------------------

function handleListClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button || button.disabled) return;

  const row = button.closest('.prompt-item');
  const type = row.dataset.type;
  const index = Number(row.dataset.index);
  const prompts = listFor(type);

  switch (button.dataset.action) {
    case 'edit':
      openEditModal(prompts[index], type, index);
      break;
    case 'delete':
      deletePrompt(type, index);
      break;
    case 'up':
      movePrompt(type, index, -1);
      break;
    case 'down':
      movePrompt(type, index, 1);
      break;
  }
}

function handleListToggle(event) {
  const checkbox = event.target.closest('input[data-role="toggle"]');
  if (!checkbox) return;

  const row = checkbox.closest('.prompt-item');
  const prompts = listFor(row.dataset.type);
  prompts[Number(row.dataset.index)].enabled = checkbox.checked;

  saveSettings();
  renderAll();
}

pageList.addEventListener('click', handleListClick);
selectionList.addEventListener('click', handleListClick);
pageList.addEventListener('change', handleListToggle);
selectionList.addEventListener('change', handleListToggle);

function movePrompt(type, index, direction) {
  const prompts = listFor(type);
  const target = index + direction;
  if (target < 0 || target >= prompts.length) return;

  [prompts[index], prompts[target]] = [prompts[target], prompts[index]];
  saveSettings();
  renderAll();
}

// --- Add / edit modal --------------------------------------------------------

function configureModalFor(type, prompt) {
  const isPage = type === 'page';
  includeUrlGroup.classList.toggle('hidden', !isPage);
  templateHint.textContent = isPage
    ? '用 {title} 和 {url} 自己决定标题、链接放在哪'
    : '用 {text} 标记选中文字插入的位置';

  if (isPage) includeUrlInput.checked = prompt ? prompt.includeUrl !== false : true;
}

function openAddModal(type) {
  editing = null;
  editingType = type;
  modalTitle.textContent = type === 'page' ? '新建页面提示词' : '新建选中文字提示词';
  nameInput.value = '';
  templateInput.value = '';
  configureModalFor(type, null);
  showModal(modal);
  nameInput.focus();
}

function openEditModal(prompt, type, index) {
  editing = { prompt, index };
  editingType = type;
  modalTitle.textContent = '编辑提示词';
  nameInput.value = prompt.name;
  templateInput.value = prompt.template;
  configureModalFor(type, prompt);
  showModal(modal);
  nameInput.focus();
}

function closeEditModal() {
  modal.classList.add('hidden');
  modalBackdrop.classList.add('hidden');
  editing = null;
  editingType = null;
}

function handleFormSubmit(event) {
  event.preventDefault();

  const name = nameInput.value.trim();
  const template = templateInput.value.trim();
  if (!name || !editingType) return;

  const prompts = listFor(editingType);

  if (editing) {
    const target = prompts[editing.index];
    target.name = name;
    target.template = template;
    if (editingType === 'page') target.includeUrl = includeUrlInput.checked;
    showToast('已保存修改');
  } else {
    const created = {
      id: `custom_${Date.now()}`,
      name,
      template,
      enabled: true
    };
    if (editingType === 'page') created.includeUrl = includeUrlInput.checked;
    prompts.push(created);
    showToast('已添加');
  }

  saveSettings();
  renderAll();
  closeEditModal();
}

document.querySelectorAll('[data-add]').forEach(button => {
  button.addEventListener('click', () => openAddModal(button.dataset.add));
});

promptForm.addEventListener('submit', handleFormSubmit);
modalClose.addEventListener('click', closeEditModal);
modalCancel.addEventListener('click', closeEditModal);

// --- Trash -------------------------------------------------------------------

function deletePrompt(type, index) {
  const prompts = listFor(type);
  const [removed] = prompts.splice(index, 1);
  if (!removed) return;

  trash.push({ type, prompt: removed });
  saveSettings();
  renderAll();
  showToast('已移到回收站');
}

function updateTrashCount() {
  trashCount.textContent = String(trash.length);
  trashCount.classList.toggle('hidden', trash.length === 0);
}

function openTrashModal() {
  renderTrash();
  showModal(trashModal);
}

function closeTrashModal() {
  trashModal.classList.add('hidden');
  modalBackdrop.classList.add('hidden');
}

function renderTrash() {
  trashList.replaceChildren();

  const isEmpty = trash.length === 0;
  trashEmpty.classList.toggle('hidden', !isEmpty);
  trashList.classList.toggle('hidden', isEmpty);
  if (isEmpty) return;

  trash.forEach((entry, index) => {
    const row = document.createElement('div');
    row.className = 'trash-item';
    row.innerHTML = `
      <div class="prompt-info">
        <span class="prompt-name">${escapeHtml(entry.prompt.name)}</span>
        <span class="prompt-type">${entry.type === 'page' ? '页面提示词' : '选中文字提示词'}</span>
      </div>
      <div class="prompt-actions">
        <button class="btn btn-icon restore" data-action="restore" data-index="${index}" title="还原">${ICON_RESTORE}</button>
        <button class="btn btn-icon delete" data-action="purge" data-index="${index}" title="彻底删除">${ICON_X}</button>
      </div>
    `;
    trashList.appendChild(row);
  });
}

trashList.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;

  const index = Number(button.dataset.index);

  if (button.dataset.action === 'restore') {
    const [entry] = trash.splice(index, 1);
    listFor(entry.type).push(entry.prompt);
    updateTrashCount();
    renderTrash();
    saveSettings();
    renderAll();
    showToast('已还原');
  } else {
    trash.splice(index, 1);
    updateTrashCount();
    renderTrash();
    showToast('已彻底删除');
  }
});

emptyTrashBtn.addEventListener('click', () => {
  trash = [];
  updateTrashCount();
  renderTrash();
  showToast('回收站已清空');
});

openTrashBtn.addEventListener('click', openTrashModal);
trashModalClose.addEventListener('click', closeTrashModal);
trashDoneBtn.addEventListener('click', closeTrashModal);

// --- Restore defaults --------------------------------------------------------

function handleRestoreDefaults() {
  const missing = (defaults, current) =>
    defaults.filter(def => !current.some(item => item.id === def.id));

  missing(DEFAULT_PAGE_PROMPTS, pagePrompts).forEach(def =>
    pagePrompts.push({ ...def, enabled: true })
  );
  missing(DEFAULT_SELECTION_PROMPTS, selectionPrompts).forEach(def =>
    selectionPrompts.push({ ...def, enabled: true })
  );

  saveSettings();
  renderAll();
  closeConfirmModal();
  showToast('默认提示词已恢复');
}

restoreDefaultsBtn.addEventListener('click', () => showModal(confirmModal));
confirmClose.addEventListener('click', closeConfirmModal);
confirmCancel.addEventListener('click', closeConfirmModal);
confirmYes.addEventListener('click', handleRestoreDefaults);

function closeConfirmModal() {
  confirmModal.classList.add('hidden');
  modalBackdrop.classList.add('hidden');
}

// --- Auto-submit -------------------------------------------------------------

autoSubmitToggle.addEventListener('change', async () => {
  await chrome.storage.sync.set({ autoSubmit: autoSubmitToggle.checked });
  showToast(autoSubmitToggle.checked ? '已开启自动发送' : '已关闭自动发送');
});

// --- Desktop session bridge --------------------------------------------------

/** Turns a syncSession() result into something a human can act on. */
function describeSync(result) {
  if (!result) return '没有拿到同步结果，重载扩展后再试';

  if (result.ok) return `已同步 ${result.count} 个 Cookie`;

  switch (result.reason) {
    case 'empty':
      return '浏览器里没有 ChatGPT 的 Cookie，先在 chatgpt.com 登录一次';
    case 'network':
      return '连不上桌面端，确认 Electron 已在监听这个地址';
    case 'http':
      return result.status === 401 || result.status === 403
        ? `令牌不匹配（HTTP ${result.status}）`
        : `桌面端返回 HTTP ${result.status}`;
    case 'cookie-api':
      return '读取 Cookie 失败，确认扩展的 cookies 权限还在';
    default:
      return '同步失败，后台控制台里有详细原因';
  }
}

async function persistBridge() {
  await chrome.storage.sync.set({
    bridgeUrl: bridgeUrlInput.value.trim() || BRIDGE_DEFAULTS.url,
    bridgeToken: bridgeTokenInput.value.trim() || BRIDGE_DEFAULTS.token
  });
}

bridgeAutoToggle.addEventListener('change', async () => {
  await chrome.storage.sync.set({ bridgeAuto: bridgeAutoToggle.checked });
  showToast(bridgeAutoToggle.checked ? '已开启启动时自动同步' : '已关闭启动时自动同步');
});

bridgeUrlInput.addEventListener('change', persistBridge);
bridgeTokenInput.addEventListener('change', persistBridge);

bridgeSyncBtn.addEventListener('click', async () => {
  // Save first: the service worker re-reads the config when it runs.
  await persistBridge();

  bridgeSyncBtn.disabled = true;
  bridgeStatus.textContent = '正在同步…';

  try {
    const result = await chrome.runtime.sendMessage({ type: 'SYNC_SESSION' });
    bridgeStatus.textContent = describeSync(result);
  } catch {
    bridgeStatus.textContent = '扩展后台没有响应，重载扩展后再试';
  } finally {
    bridgeSyncBtn.disabled = false;
  }
});

// --- Shared modal / toast helpers -------------------------------------------

function showModal(element) {
  element.classList.remove('hidden');
  modalBackdrop.classList.remove('hidden');
}

function closeAllModals() {
  [modal, trashModal, confirmModal, modalBackdrop].forEach(el => el.classList.add('hidden'));
  editing = null;
  editingType = null;
}

modalBackdrop.addEventListener('click', closeAllModals);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeAllModals();
});

let toastTimer = null;
function showToast(message) {
  toastMessage.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 1800);
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value ?? '';
  return div.innerHTML;
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

// --- Start -------------------------------------------------------------------

// A deferred module can be evaluated after DOMContentLoaded has already fired
// (slow storage, restored session, file:// loads). Registering the listener
// unconditionally would then leave every control at its markup default while
// the real values sit unread in storage.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadSettings);
} else {
  loadSettings();
}
