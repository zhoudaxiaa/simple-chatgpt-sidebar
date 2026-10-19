/**
 * Default prompt definitions — single source of truth.
 *
 * The original extension duplicated this table in background.js and options.js,
 * which drifted over time. Both contexts now import this module instead.
 */

/**
 * Prompts shown when right-clicking a page (no text selected).
 * @typedef {Object} Prompt
 * @property {string}  id          Stable identifier, used by "Restore Defaults".
 * @property {string}  name        Label shown in the context menu.
 * @property {string}  template    Prompt body. Supports {title} / {url}.
 * @property {boolean} includeUrl  Append "Title:/URL:" block to the prompt.
 * @property {boolean} enabled     Whether it is rendered into the menu.
 */

export const DEFAULT_PAGE_PROMPTS = [
  {
    id: 'page-summarize',
    name: '总结这个页面',
    template: '请总结这个网页：',
    includeUrl: true,
    enabled: true
  },
  {
    id: 'page-explain',
    name: '解释这个页面',
    template: '请解释这个网页讲的是什么：',
    includeUrl: true,
    enabled: true
  },
  {
    id: 'page-questions',
    name: '我该问哪些问题',
    template: '针对这个网页，我可以问哪些有价值的问题？',
    includeUrl: true,
    enabled: true
  },
  {
    id: 'page-send-url',
    name: '只发送页面链接',
    template: '',
    includeUrl: true,
    enabled: true
  }
];

/**
 * Prompts shown when right-clicking selected text.
 * @property {string} template Prompt body. Supports {text}.
 */
export const DEFAULT_SELECTION_PROMPTS = [
  { id: 'chatgpt-explain', name: '解释这段内容', template: '解释一下：\n\n{text}', enabled: true },
  { id: 'chatgpt-summarize', name: '总结要点', template: '总结以下内容：\n\n{text}', enabled: true },
  { id: 'chatgpt-translate', name: '翻译成中文', template: '把下面内容翻译成中文：\n\n{text}', enabled: true },
  { id: 'chatgpt-grammar', name: '修正语法', template: '修正下面内容的语法错误：\n\n{text}', enabled: true },
  { id: 'chatgpt-code', name: '解释这段代码', template: '解释这段代码在做什么：\n\n{text}', enabled: true },
  { id: 'chatgpt-bugs', name: '找出代码问题', template: '找出这段代码里的 bug：\n\n{text}', enabled: true }
];

/** Clone helpers so callers never mutate the frozen defaults. */
export const clonePagePrompts = () => DEFAULT_PAGE_PROMPTS.map(p => ({ ...p }));
export const cloneSelectionPrompts = () => DEFAULT_SELECTION_PROMPTS.map(p => ({ ...p }));

// =============================================================================
// Localisation migration
//
// The defaults used to ship in English. An install that already ran stores
// those English entries in `storage.sync`, so translating the table above has
// no effect on it. Rewriting the whole list on upgrade would throw away user
// edits and custom prompts, so instead each entry is compared field by field:
// a field is only replaced when it still equals the shipped English value.
// =============================================================================

/** English defaults as shipped before the interface was translated. */
const LEGACY_EN = {
  'page-summarize': { name: 'Summarize this page', template: 'Please summarize this webpage:' },
  'page-explain': { name: 'Explain this page', template: 'Please explain what this webpage is about:' },
  'page-questions': {
    name: 'What questions should I ask?',
    template: 'What are some good questions I should ask about this webpage?'
  },
  'page-send-url': { name: 'Send page URL', template: '' },
  'chatgpt-explain': { name: 'Explain this', template: 'Explain this:\n\n{text}' },
  'chatgpt-summarize': { name: 'Summarize', template: 'Summarize this:\n\n{text}' },
  'chatgpt-translate': { name: 'Translate to English', template: 'Translate this to English:\n\n{text}' },
  'chatgpt-grammar': { name: 'Fix grammar', template: 'Fix the grammar in this:\n\n{text}' },
  'chatgpt-code': { name: 'Explain code', template: 'Explain what this code does:\n\n{text}' },
  'chatgpt-bugs': { name: 'Find bugs', template: 'Find bugs in this code:\n\n{text}' }
};

/**
 * Rewrites entries that are still untouched English defaults.
 * @param {Array} list      Stored prompt list.
 * @param {Array} defaults  Current (localised) defaults.
 * @returns {Array} The same array when nothing changed, so callers can skip the write.
 */
export function localizePrompts(list, defaults) {
  const byId = new Map(defaults.map(prompt => [prompt.id, prompt]));
  let changed = false;

  const next = list.map(entry => {
    const target = byId.get(entry.id);
    const legacy = LEGACY_EN[entry.id];
    if (!target || !legacy) return entry;

    const patch = {};
    // The second half of each test matters: a legacy value can equal the
    // current one (page-send-url has an empty template in both languages), and
    // patching it anyway would report a change that is not there.
    const isLegacyName =
      entry.name === legacy.name ||
      (entry.id === 'chatgpt-translate' && entry.name === '翻译成英文');
    const isLegacyTemplate =
      entry.template === legacy.template ||
      (entry.id === 'chatgpt-translate' &&
        entry.template === '把下面内容翻译成英文：\n\n{text}');

    if (isLegacyName && entry.name !== target.name) patch.name = target.name;
    if (isLegacyTemplate && entry.template !== target.template) {
      patch.template = target.template;
    }

    if (!Object.keys(patch).length) return entry;
    changed = true;
    return { ...entry, ...patch };
  });

  return changed ? next : list;
}
