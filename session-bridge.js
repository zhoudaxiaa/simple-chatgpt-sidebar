/**
 * ChatGPT Session Bridge — hands the browser's ChatGPT / OpenAI cookies to a
 * local Electron shell so it can restore the same login session.
 *
 * Absorbed from the standalone "ChatGPT Session Bridge" extension so both
 * features live behind one install.
 *
 * How it works
 *   1. `chrome.cookies.getAll({domain})` matches the domain *and* all of its
 *      subdomains, so chatgpt.com and auth.openai.com are both covered.
 *   2. Cookies are deduplicated on domain+name+path — the same cookie comes
 *      back from more than one query.
 *   3. They are POSTed as JSON to a loopback endpoint, authenticated with a
 *      shared token header.
 *
 * Everything stays on the machine: the endpoint is 127.0.0.1 by design.
 */

/** Endpoint, token and auto-sync defaults, matching the Electron shell. */
export const BRIDGE_DEFAULTS = {
  url: 'http://127.0.0.1:32123/import-cookies',
  token: 'dsh-chatgpt-bridge-2026',
  auto: true
};

const PARENT_DOMAINS = ['chatgpt.com', 'openai.com'];

/**
 * Flattens several cookie lists into one, dropping repeats.
 * @param {Array<Array<object>>} lists
 * @returns {Array<object>}
 */
export function dedupeCookies(lists) {
  const seen = new Set();
  const out = [];

  for (const list of lists) {
    for (const cookie of list || []) {
      const key = `${cookie.domain}\u0000${cookie.name}\u0000${cookie.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cookie);
    }
  }

  return out;
}

/** @returns {Promise<Array<object>>} */
export async function collectCookies() {
  const lists = await Promise.all(PARENT_DOMAINS.map(domain => chrome.cookies.getAll({ domain })));
  return dedupeCookies(lists);
}

/** @returns {Promise<{url: string, token: string, auto: boolean}>} */
export async function readBridgeConfig() {
  const stored = await chrome.storage.sync.get(['bridgeUrl', 'bridgeToken', 'bridgeAuto']);

  const url = typeof stored.bridgeUrl === 'string' && stored.bridgeUrl.trim()
    ? stored.bridgeUrl.trim()
    : BRIDGE_DEFAULTS.url;
  const token = typeof stored.bridgeToken === 'string' && stored.bridgeToken.trim()
    ? stored.bridgeToken.trim()
    : BRIDGE_DEFAULTS.token;

  return { url, token, auto: stored.bridgeAuto !== false };
}

/**
 * Collects the session cookies and posts them to the local shell.
 *
 * Never throws: the caller is a toolbar click or a startup hook, and both need
 * a result to show rather than an unhandled rejection.
 *
 * @param {{url: string, token: string}} [config]
 * @returns {Promise<{ok: boolean, count: number, reason: string, status?: number}>}
 */
export async function syncSession(config) {
  const settings = config || (await readBridgeConfig());

  let cookies;
  try {
    cookies = await collectCookies();
  } catch (err) {
    return { ok: false, count: 0, reason: 'cookie-api', detail: String(err) };
  }

  if (!cookies.length) return { ok: false, count: 0, reason: 'empty' };

  let response;
  try {
    response = await fetch(settings.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bridge-token': settings.token
      },
      body: JSON.stringify({ cookies })
    });
  } catch (err) {
    return { ok: false, count: cookies.length, reason: 'network', detail: String(err) };
  }

  if (!response.ok) {
    return { ok: false, count: cookies.length, reason: 'http', status: response.status };
  }

  // The shell may answer with no body at all; a 2xx is good enough then.
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* no JSON body */
  }

  return {
    ok: payload ? payload.ok !== false : true,
    count: cookies.length,
    reason: 'sent'
  };
}
