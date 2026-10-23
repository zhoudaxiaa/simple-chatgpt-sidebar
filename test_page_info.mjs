/**
 * Fallback-chain tests for shared/page-info.js.
 *
 * The bug this guards: contextMenus.onClicked hands over a Tab whose url/title
 * are empty, so the identity has to be read from the page. Each step of the
 * chain is exercised by making the cheaper step fail.
 *
 * Run: node test_page_info.mjs
 */

import { resolvePageInfo } from './shared/page-info.js';

const cases = [];
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  cases.push({ name, ok: a === b, actual: a, expected: b });
};

/** Builds a stubbed chrome namespace. */
const api = ({ sendMessage, executeScript }) => ({
  tabs: { sendMessage: sendMessage || (async () => { throw new Error('no receiver'); }) },
  scripting: {
    executeScript: executeScript || (async () => { throw new Error('cannot access'); })
  }
});

const TAB = { id: 7, title: '', url: '' };

// --- 1. content script answers ----------------------------------------------

eq(
  'content script wins',
  await resolvePageInfo(api({ sendMessage: async () => ({ title: 'Docs', url: 'https://x.dev/a' }) }), TAB),
  { title: 'Docs', url: 'https://x.dev/a' }
);

// --- 2. no content script (tab opened before the extension was reloaded) ----

eq(
  'executeScript rescues a tab without a content script',
  await resolvePageInfo(
    api({
      sendMessage: async () => { throw new Error('Could not establish connection'); },
      executeScript: async () => [{ result: { title: 'Later', url: 'https://y.dev' } }]
    }),
    TAB
  ),
  { title: 'Later', url: 'https://y.dev' }
);

// --- 3. content script answers with empty fields ----------------------------

eq(
  'empty content-script answer falls through',
  await resolvePageInfo(
    api({
      sendMessage: async () => ({ title: '', url: '' }),
      executeScript: async () => [{ result: { title: 'T', url: 'https://z.dev' } }]
    }),
    TAB
  ),
  { title: 'T', url: 'https://z.dev' }
);

// --- 4. nothing works: use whatever the Tab carries -------------------------

eq(
  'tab fields are the last resort',
  await resolvePageInfo(api({}), { id: 7, title: 'From Tab', url: 'https://tab.dev' }),
  { title: 'From Tab', url: 'https://tab.dev' }
);

eq(
  'nothing at all still returns empty strings',
  await resolvePageInfo(api({}), TAB),
  { title: '', url: '' }
);

eq(
  'no tab id short-circuits safely',
  await resolvePageInfo(api({}), undefined),
  { title: '', url: '' }
);

// --- report -----------------------------------------------------------------

let failed = 0;
for (const test of cases) {
  if (test.ok) {
    console.log(`  PASS  ${test.name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${test.name}  (got ${test.actual}, want ${test.expected})`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
