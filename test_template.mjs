import { formatTemplate, formatPagePrompt, formatSelectionPrompt } from './shared/template.js';
import {
  DEFAULT_PAGE_PROMPTS,
  DEFAULT_SELECTION_PROMPTS,
  localizePrompts
} from './shared/defaults.js';
import { dedupeCookies } from './session-bridge.js';

const cases = [];
const eq = (name, actual, expected) => cases.push({ name, ok: actual === expected, actual, expected });
const ok = (name, condition, detail = '') => cases.push({ name, ok: Boolean(condition), actual: detail, expected: '' });
const NL = String.fromCharCode(10);

// --- templating --------------------------------------------------------------

eq(
  'selection prompt inserts text',
  formatSelectionPrompt(DEFAULT_SELECTION_PROMPTS[0], 'const a = 1;'),
  `解释一下：${NL}${NL}const a = 1;`
);

eq(
  'page prompt appends title/url',
  formatPagePrompt(DEFAULT_PAGE_PROMPTS[0], { title: 'Docs', url: 'https://x.dev' }),
  `请总结这个网页：${NL}${NL}标题：Docs${NL}链接：https://x.dev`
);

eq(
  'url-only page prompt',
  formatPagePrompt(DEFAULT_PAGE_PROMPTS[3], { title: 'Docs', url: 'https://x.dev' }),
  `标题：Docs${NL}链接：https://x.dev`
);

eq(
  'includeUrl:false suppresses block',
  formatPagePrompt({ template: 'Hi {title}', includeUrl: false }, { title: 'T', url: 'u' }),
  'Hi T'
);

eq('unknown placeholder preserved', formatTemplate('{foo} {text}', { text: 'X' }), '{foo} X');

eq('repeated placeholder', formatTemplate('{text}-{text}', { text: 'a' }), 'a-a');

eq(
  'empty template + includeUrl',
  formatPagePrompt({ template: '', includeUrl: true }, { title: 'T', url: 'u' }),
  `标题：T${NL}链接：u`
);

// --- English-default migration ----------------------------------------------

const legacyPage = [
  { id: 'page-summarize', name: 'Summarize this page', template: 'Please summarize this webpage:', includeUrl: true, enabled: true },
  { id: 'page-send-url', name: 'Send page URL', template: '', includeUrl: true, enabled: true }
];

const migrated = localizePrompts(legacyPage, DEFAULT_PAGE_PROMPTS);

eq('migration renames a default entry', migrated[0].name, '总结这个页面');
eq('migration translates its template', migrated[0].template, '请总结这个网页：');
eq('migration keeps unrelated fields', migrated[0].includeUrl, true);
eq('migration handles empty templates', migrated[1].name, '只发送页面链接');

const edited = [
  { id: 'page-summarize', name: '我的总结', template: 'Please summarize this webpage:', enabled: true }
];
const migratedEdited = localizePrompts(edited, DEFAULT_PAGE_PROMPTS);
eq('user-renamed entry keeps its name', migratedEdited[0].name, '我的总结');
eq('but its untouched template is translated', migratedEdited[0].template, '请总结这个网页：');

const custom = [{ id: 'my-own', name: 'My prompt', template: 'Do something' }];
ok(
  'custom prompts are never touched',
  localizePrompts(custom, DEFAULT_PAGE_PROMPTS)[0] === custom[0]
);

ok(
  'already-localised list is returned as-is',
  localizePrompts(DEFAULT_PAGE_PROMPTS, DEFAULT_PAGE_PROMPTS) === DEFAULT_PAGE_PROMPTS
);

ok(
  'selection defaults migrate too',
  localizePrompts(
    [{ id: 'chatgpt-bugs', name: 'Find bugs', template: 'Find bugs in this code:' + NL + NL + '{text}' }],
    DEFAULT_SELECTION_PROMPTS
  )[0].name === '找出代码问题'
);

// --- session bridge ----------------------------------------------------------

const cookie = (domain, name, path = '/') => ({ domain, name, path, value: 'x' });

eq(
  'cookies from overlapping domains are deduplicated',
  dedupeCookies([
    [cookie('chatgpt.com', '__Secure-next-auth.session-token')],
    [cookie('chatgpt.com', '__Secure-next-auth.session-token'), cookie('chatgpt.com', 'oai-sc')]
  ]).length,
  2
);

eq(
  'same name on different paths is kept',
  dedupeCookies([[cookie('chatgpt.com', 'sid', '/'), cookie('chatgpt.com', 'sid', '/api')]]).length,
  2
);

eq(
  'same name on different domains is kept',
  dedupeCookies([[cookie('chatgpt.com', 'sid'), cookie('auth.openai.com', 'sid')]]).length,
  2
);

eq('empty and missing lists are tolerated', dedupeCookies([[], undefined]).length, 0);

// --- report ------------------------------------------------------------------

let failed = 0;
for (const c of cases) {
  if (c.ok) {
    console.log('  PASS  ' + c.name);
  } else {
    failed += 1;
    console.log('  FAIL  ' + c.name);
    console.log('        got: ' + JSON.stringify(c.actual));
    console.log('        exp: ' + JSON.stringify(c.expected));
  }
}
console.log(`${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
