/**
 * Simple ChatGPT Sidebar — custom prompt popup logic.
 *
 * The page identity is read from storage (written by the service worker right
 * before this window opened) and either substituted into {title}/{url} or
 * appended as a trailing block.
 */

const pageTitleEl = document.getElementById('page-title');
const pageUrlEl = document.getElementById('page-url');
const promptInput = document.getElementById('custom-prompt');
const sendBtn = document.getElementById('send-btn');
const cancelBtn = document.getElementById('cancel-btn');

/** @type {{title: string, url: string}} */
let pageInfo = { title: '', url: '' };

async function init() {
  const stored = await chrome.storage.local.get('promptInputPageInfo');
  const info = stored?.promptInputPageInfo;

  if (info) {
    pageInfo = { title: info.title || '', url: info.url || '' };
    pageTitleEl.textContent = pageInfo.title || '未命名页面';
    pageUrlEl.textContent = pageInfo.url;
    pageTitleEl.title = pageInfo.title;
    pageUrlEl.title = pageInfo.url;
  }

  promptInput.focus();
}

function submit() {
  const typed = promptInput.value.trim();
  if (!typed) {
    promptInput.focus();
    return;
  }

  const usesPlaceholders = typed.includes('{title}') || typed.includes('{url}');

  const finalPrompt = usesPlaceholders
    ? typed.replace(/\{title\}/g, pageInfo.title).replace(/\{url\}/g, pageInfo.url)
    : `${typed}\n\n标题：${pageInfo.title}\n链接：${pageInfo.url}`;

  chrome.runtime.sendMessage({ type: 'CUSTOM_PROMPT_SUBMIT', prompt: finalPrompt });
  window.close();
}

sendBtn.addEventListener('click', submit);
cancelBtn.addEventListener('click', () => window.close());

promptInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    submit();
  }
  if (event.key === 'Escape') {
    window.close();
  }
});

init();
