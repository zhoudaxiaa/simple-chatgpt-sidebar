/**
 * Prompt templating helpers.
 *
 * Placeholders: {text} {title} {url}
 * Unknown placeholders are left untouched so a user template that literally
 * contains "{foo}" is not silently mangled.
 */

/**
 * Replaces known placeholders in a template.
 * @param {string} template
 * @param {{text?: string, title?: string, url?: string}} data
 * @returns {string}
 */
export function formatTemplate(template, data = {}) {
  let result = template || '';
  if (data.title != null) result = result.replace(/\{title\}/g, data.title);
  if (data.url != null) result = result.replace(/\{url\}/g, data.url);
  if (data.text != null) result = result.replace(/\{text\}/g, data.text);
  return result;
}

/**
 * Drops "标题：" / "链接：" lines that ended up with nothing after them.
 *
 * The identity block used to be appended unconditionally, and prompts saved by
 * older builds can carry those labels literally in their template. Either way
 * an empty label tells ChatGPT nothing and only makes the prompt look broken,
 * so it is removed wherever it appears.
 * @param {string} text
 * @returns {string}
 */
export function stripEmptyLabels(text) {
  return (text || '')
    .split('\n')
    .filter(line => !/^\s*(标题|链接|Title|URL)\s*[:：]\s*$/i.test(line))
    .join('\n')
    .trim();
}

/**
 * Formats a page prompt and optionally appends the page identity block.
 * Lines whose value is unknown are left out entirely: a delivery of
 * "标题：\n链接：" carries no information and only wastes the turn.
 * @param {object} prompt  A page prompt definition.
 * @param {{title?: string, url?: string}} tab
 * @returns {string}
 */
export function formatPagePrompt(prompt, tab) {
  const title = tab?.title || '';
  const url = tab?.url || '';

  let result = formatTemplate(prompt.template, { title, url }).trim();

  if (prompt.includeUrl !== false) {
    const identity = [];
    if (title) identity.push(`标题：${title}`);
    if (url) identity.push(`链接：${url}`);
    if (identity.length) result = `${result}\n\n${identity.join('\n')}`;
  }

  return stripEmptyLabels(result);
}

/**
 * Formats a selection prompt around the captured text.
 * @param {object} prompt
 * @param {string} selectionText
 * @returns {string}
 */
export function formatSelectionPrompt(prompt, selectionText) {
  return formatTemplate(prompt.template, { text: selectionText }).trim();
}
