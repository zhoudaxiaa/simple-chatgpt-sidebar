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
 * Formats a page prompt and optionally appends the page identity block.
 * @param {object} prompt  A page prompt definition.
 * @param {{title?: string, url?: string}} tab
 * @returns {string}
 */
export function formatPagePrompt(prompt, tab) {
  const title = tab.title || '';
  const url = tab.url || '';

  let result = formatTemplate(prompt.template, { title, url });

  if (prompt.includeUrl !== false) {
    result = `${result.trim()}\n\n标题：${title}\n链接：${url}`;
  }

  return result.trim();
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
