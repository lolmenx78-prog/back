/**
 * fetcher.js — HTTP client for animeblkom.net (browser-free CF bypass).
 *
 * animeblkom.net sits behind a Cloudflare "managed challenge". This client uses
 * the AdvancedSolver engine (src/utils/cf-bypass.js) which needs NO browser and
 * NO manual cookie:
 *
 *   Layer 1  TLS-fingerprint impersonation (wreq-js) with profile rotation,
 *            emulation headers, session warmup and retry/backoff.
 *   Layer 2  Optional proxy rotation (ABLK_PROXIES) — the real IP-reputation
 *            lever; from a clean residential IP Layer 1 usually succeeds.
 *   Layer 3  Optional solver backend (CAPSOLVER_API_KEY or FLARESOLVERR_URL) for
 *            an active managed challenge; it returns cf_clearance automatically.
 *
 * Any cf_clearance obtained by any layer is cached (cf-clearance-cache.json) and
 * reused transparently, so there is no manual cookie step.
 *
 * Honest ceiling: an ACTIVE managed challenge (cf-mitigated: challenge) cannot be
 * solved by Layer 1 alone from a hard-blocked datacenter IP. Provide a proxy or a
 * solver backend to unlock those cases. A manually-pasted cf_clearance still works
 * as a last-resort override (POST /api/set-cookies or CF_CLEARANCE env).
 *
 * All parsers call getPage()/getJson(); they never touch the transport.
 */
const fs = require('fs');
const path = require('path');
const { AdvancedSolver } = require('./cf-bypass');

const BASE = process.env.ABLK_BASE || 'https://animeblkom.net';

// UA used for manual-cookie / XHR requests (must match a solved cf_clearance).
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': UA,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
};

// ── Proxy list (optional) ────────────────────────────────────────
function loadProxies() {
  const raw = process.env.ABLK_PROXIES || process.env.CF_PROXIES || '';
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── Advanced engine (singleton) ──────────────────────────────────
const proxies = loadProxies();
const solver = new AdvancedSolver({
  cacheFile: path.join(__dirname, '..', '..', 'cf-clearance-cache.json'),
  proxies,
  retries: 2,
  // Remote clearance published by the scheduled GitHub Actions browser-solver.
  clearanceUrl: process.env.ABLK_CLEARANCE_URL || null,
  log: (m) => process.env.ABLK_DEBUG && console.log('[cf-bypass]', m),
});

// ── Manual cookie override (last resort, optional) ───────────────
const COOKIE_FILE = path.join(__dirname, '..', '..', 'cf-cookies.json');
let _manualCookies = null;

function manualCookieString() {
  if (!_manualCookies) return '';
  return Object.entries(_manualCookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function seedManualCookies() {
  if (_manualCookies) return;
  _manualCookies = {};
  if (process.env.CF_CLEARANCE) _manualCookies.cf_clearance = process.env.CF_CLEARANCE;
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const data = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf-8'));
      const raw = typeof data === 'string' ? data : data.cookies;
      if (raw) {
        for (const pair of String(raw).split(/;\s*/)) {
          const eq = pair.indexOf('=');
          if (eq > 0) _manualCookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
        }
      }
    }
  } catch {
    /* ignore malformed cookie file */
  }
}

function setCookiesManually(cookieStr) {
  _manualCookies = {};
  for (const pair of String(cookieStr).split(/;\s*/)) {
    const eq = pair.indexOf('=');
    if (eq > 0) _manualCookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  try {
    fs.writeFileSync(
      COOKIE_FILE,
      JSON.stringify(
        {
          cookies: cookieStr,
          updatedAt: new Date().toISOString(),
          userAgent: UA,
          note: 'Optional override. The engine normally obtains cf_clearance automatically.',
        },
        null,
        2
      )
    );
  } catch {
    /* ignore */
  }
  return manualCookieString();
}

// ── Challenge detection (kept for compatibility) ─────────────────
function isChallenge(html, status) {
  if (!html) return status === 403;
  return (
    html.includes('Just a moment') ||
    html.includes('challenge-platform') ||
    html.includes('cf-browser-verification') ||
    html.includes('_cf_chl_opt')
  );
}

class CloudflareError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'CloudflareError';
    this.code = 'CF_CHALLENGE';
  }
}

/**
 * GET a page and return HTML. Throws CloudflareError if every layer is blocked.
 * @param {string} pathOrUrl  '/anime-list' or a full URL
 */
async function getPage(pathOrUrl) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : BASE + pathOrUrl;

  seedManualCookies();
  const manual = manualCookieString();

  const result = await solver.fetch(url, {
    headers: manual ? { Cookie: manual, Referer: BASE + '/' } : { Referer: BASE + '/' },
  });

  if (result.ok) return result.html;

  throw new CloudflareError(
    (result.error || 'Cloudflare challenge active.') +
      ' (engine tried TLS rotation' +
      (proxies.length ? ' + proxies' : '') +
      (solver.solver ? ' + solver backend' : '') +
      '.)'
  );
}

/** GET returning parsed JSON (for any XHR endpoints). */
async function getJson(pathOrUrl, extraHeaders = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : BASE + pathOrUrl;
  seedManualCookies();
  const manual = manualCookieString();

  const result = await solver.fetch(url, {
    headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      ...(manual ? { Cookie: manual } : {}),
      ...extraHeaders,
    },
  });
  if (!result.ok) {
    throw new CloudflareError(result.error || 'Cloudflare challenge on XHR endpoint.');
  }
  try {
    return JSON.parse(result.html);
  } catch {
    return result.html;
  }
}

/** Low-level request kept for image proxy / resolver (uses engine cache). */
async function request(url, { headers = {} } = {}) {
  const result = await solver.fetch(url, { headers });
  return {
    status: result.ok ? result.status || 200 : result.status || 403,
    ok: result.ok,
    text: async () => result.html || '',
    headers: { get: () => undefined, raw: () => ({}) },
  };
}

/** Report engine + clearance state for the status endpoint. */
function engineStatus() {
  const host = new URL(BASE).host;
  const entry = solver.store.get(host);
  return {
    engine: 'AdvancedSolver (browser-free)',
    layers: ['tls-rotation+warmup', proxies.length ? `proxies(${proxies.length})` : 'proxies(off)',
      solver.clearanceUrl ? 'remote-clearance(on)' : 'remote-clearance(off)',
      solver.solver ? `solver:${solver.solver.backend}` : 'solver(off)'],
    proxies: proxies.length,
    remoteClearanceUrl: solver.clearanceUrl ? 'configured' : null,
    solverBackend: solver.solver ? solver.solver.backend : null,
    cachedClearance: entry
      ? { userAgent: entry.userAgent, savedAt: new Date(entry.savedAt).toISOString(), expiresInSec: Math.max(0, Math.round((entry.expires - Date.now()) / 1000)) }
      : null,
    manualCookie: !!manualCookieString(),
  };
}

module.exports = {
  BASE,
  UA,
  HEADERS,
  getPage,
  getJson,
  request,
  setCookiesManually,
  cookieString: manualCookieString,
  engineStatus,
  CloudflareError,
  isChallenge,
};
