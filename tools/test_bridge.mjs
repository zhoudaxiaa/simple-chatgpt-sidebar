/**
 * Session bridge contract tests.
 *
 * Runs the real syncSession() against a real local HTTP server, with only
 * `chrome.cookies` mocked. This pins down the wire format the Electron shell
 * relies on: the token header and the `{ cookies: [...] }` body.
 *
 *   node tools/test_bridge.mjs
 */

import { createServer } from 'node:http';

const FAKE = {
  'chatgpt.com': [
    { domain: 'chatgpt.com', name: '__Secure-next-auth.session-token', path: '/', value: 'a' },
    { domain: 'chatgpt.com', name: 'oai-did', path: '/', value: 'b' }
  ],
  'openai.com': [
    { domain: 'auth.openai.com', name: '__Secure-next-auth.session-token', path: '/', value: 'a' },
    { domain: 'openai.com', name: 'login_session', path: '/', value: 'c' }
  ]
};

globalThis.chrome = {
  cookies: {
    async getAll({ domain }) {
      return FAKE[domain] || [];
    }
  }
};

const { syncSession } = await import('../session-bridge.js');

// --- helpers -----------------------------------------------------------------

let received = null;
let mode = 'ok';

const server = createServer((req, res) => {
  let body = '';
  req.on('data', chunk => {
    body += chunk;
  });
  req.on('end', () => {
    received = { headers: req.headers, body };

    if (mode === 'unauthorized') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, imported: JSON.parse(body || '{}').cookies?.length ?? 0 }));
  });
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/import-cookies`;

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// --- 1. happy path -----------------------------------------------------------

const ok = await syncSession({ url: endpoint, token: 'secret-token' });
check('reports success', ok.ok === true, JSON.stringify(ok));
// 4 distinct cookies across the two queries (dedupe itself is unit-tested).
check('counts every distinct cookie', ok.count === 4, String(ok.count));
check('sends the token header', received?.headers['x-bridge-token'] === 'secret-token', String(received?.headers['x-bridge-token']));
check('posts JSON', String(received?.headers['content-type']).startsWith('application/json'));

const sent = JSON.parse(received?.body || '{}');
check('body is { cookies: [...] }', Array.isArray(sent.cookies) && sent.cookies.length === 4);
check('cookies keep their domain', sent.cookies.some(c => c.domain === 'auth.openai.com'));

// --- 2. no cookies -----------------------------------------------------------

const saved = FAKE['chatgpt.com'];
const savedOpenai = FAKE['openai.com'];
FAKE['chatgpt.com'] = [];
FAKE['openai.com'] = [];
received = null;

const empty = await syncSession({ url: endpoint, token: 'secret-token' });
check('reports empty instead of posting', empty.ok === false && empty.reason === 'empty', JSON.stringify(empty));
check('no request is sent when empty', received === null);

FAKE['chatgpt.com'] = saved;
FAKE['openai.com'] = savedOpenai;

// --- 3. rejected token -------------------------------------------------------

mode = 'unauthorized';
const denied = await syncSession({ url: endpoint, token: 'wrong' });
check('surfaces the HTTP status', denied.reason === 'http' && denied.status === 401, JSON.stringify(denied));

// --- 4. shell not running ----------------------------------------------------

mode = 'ok';
await new Promise(resolve => server.close(resolve));
const offline = await syncSession({ url: endpoint, token: 'secret-token' });
check('reports a network failure when the shell is closed', offline.reason === 'network', JSON.stringify(offline));

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);
