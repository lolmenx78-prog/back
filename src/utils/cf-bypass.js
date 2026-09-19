/**
 * advanced-solver.js — Advanced, browser-free Cloudflare bypass engine.
 *
 * Design goals (per request): NO browser, NO manual cookie. Rely entirely on
 * libraries. This module maximizes the success rate of a pure-library approach
 * and removes the manual-cookie step by AUTO-CAPTURING and CACHING cf_clearance
 * whenever any layer succeeds.
 *
 * Honest capability note — read this:
 *   Cloudflare "Managed Challenge" (response header `cf-mitigated: challenge`)
 *   is specifically engineered to defeat headless/library clients. It runs
 *   obfuscated JS plus browser-environment probes (canvas/WebGL/timing/Turnstile)
 *   that a non-browser cannot satisfy. Therefore the layers below are tried in
 *   order of cost, and the engine is honest about what it could and could not do:
 *
 *   Layer 1  TLS impersonation (wreq-js): rotates browser profiles, emulation
 *            headers, session warmup, retries+backoff. Beats TLS/WAF and
 *            passive bot-management. Does NOT beat an active managed challenge.
 *   Layer 2  Proxy rotation (optional): the real lever for IP reputation. From a
 *            clean residential/mobile IP, many "protected" sites never show the
 *            interstitial and Layer 1 then succeeds.
 *   Layer 3  Solver backend (optional, pluggable): CapSolver (antiCloudflare/
 *            Turnstile) or a FlareSolverr endpoint. This is the only reliable
 *            no-manual-cookie path for an active managed challenge. Off unless
 *            configured via env/opts.
 *
 * On success from any layer, the resulting cf_clearance (+ the exact UA it is
 * bound to) is cached to disk and reused until it expires — so callers never
 * paste a cookie by hand.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const zlib = require('zlib');

// ── wreq-js lazy loader ──────────────────────────────────────────
let _wreq = null;
function wreq() {
  if (!_wreq) _wreq = require('wreq-js');
  return _wreq;
}

// ── Forward-proxy transport (absolute-URI over plain HTTP) ────────
// Webshare-style HTTP proxies here do NOT accept CONNECT tunnels (verified),
// but they DO honour the classic forward-proxy form: send the absolute target
// URL as the request-line path and the proxy terminates TLS to the origin.
// This is the only working way to route HTTPS through these proxies, and it is
// exactly what we need to REPLAY a request with a solved cf_clearance from the
// SAME exit IP the cookie was bound to.
//
// @param {string} url     absolute https target
// @param {object} o       { proxy, headers, method, body, timeoutMs }
// @returns {Promise<{status,html,headers,cookies}>}
function forwardProxyFetch(url, { proxy, headers = {}, method = 'GET', body = null, timeoutMs = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    let pu;
    try {
      pu = new URL(proxy);
    } catch (e) {
      return reject(new Error(`invalid proxy url: ${proxy}`));
    }
    const target = new URL(url);
    const hdrs = {
      Host: target.host,
      // Ask origin for identity encoding so we never have to gunzip a truncated
      // stream; keeps the client simple and robust.
      'Accept-Encoding': 'identity',
      Connection: 'close',
      ...headers,
    };
    if (pu.username || pu.password) {
      const auth = Buffer.from(
        `${decodeURIComponent(pu.username)}:${decodeURIComponent(pu.password)}`
      ).toString('base64');
      hdrs['Proxy-Authorization'] = `Basic ${auth}`;
    }
    const transport = pu.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        host: pu.hostname,
        port: pu.port || (pu.protocol === 'https:' ? 443 : 80),
        method,
        path: url, // absolute-URI request line → forward-proxy mode
        headers: hdrs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          let buf = Buffer.concat(chunks);
          const enc = (res.headers['content-encoding'] || '').toLowerCase();
          try {
            if (enc.includes('gzip')) buf = zlib.gunzipSync(buf);
            else if (enc.includes('br')) buf = zlib.brotliDecompressSync(buf);
            else if (enc.includes('deflate')) buf = zlib.inflateSync(buf);
          } catch {
            /* leave raw on decode failure */
          }
          const cookies = {};
          const sc = res.headers['set-cookie'] || [];
          for (const line of Array.isArray(sc) ? sc : [sc]) {
            const first = String(line).split(';')[0];
            const eq = first.indexOf('=');
            if (eq > 0) cookies[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
          }
          resolve({ status: res.statusCode, html: buf.toString('utf-8'), headers: res.headers, cookies });
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('forward-proxy timeout'));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Default browser identities (profile must match the UA string) ─
// Keeping UA in lock-step with the wreq profile matters: Cloudflare binds
// cf_clearance to the UA that solved it.
const IDENTITIES = [
  {
    profile: 'chrome_149',
    os: 'windows',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  },
  {
    profile: 'chrome_141',
    os: 'windows',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  },
  {
    profile: 'edge_141',
    os: 'windows',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  },
  {
    profile: 'firefox_143',
    os: 'windows',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0',
  },
  {
    profile: 'chrome_141',
    os: 'macos',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  },
];

// ── Challenge detection ──────────────────────────────────────────
function classify(status, html, headers) {
  const mitigated = headers && (headers['cf-mitigated'] || headers.get?.('cf-mitigated'));
  const body = html || '';
  const turnstile = /cf-turnstile|challenges\.cloudflare\.com\/turnstile|data-sitekey/i.test(body);
  const chal =
    /Just a moment|challenge-platform|_cf_chl_opt|cf-browser-verification/i.test(body) ||
    mitigated === 'challenge';

  if (turnstile) {
    const m = body.match(/data-sitekey=["']([^"']+)["']/);
    return { type: 'turnstile', sitekey: m ? m[1] : null };
  }
  if (chal) return { type: 'managed-challenge' };
  if (status === 403) return { type: 'waf-tls' };
  if (status >= 200 && status < 300 && body.length > 1500) return { type: 'none' };
  return { type: 'other', status };
}

function headerBag(res) {
  try {
    if (res.headers?.entries) return Object.fromEntries(res.headers.entries());
    if (res.headers?.raw) {
      const raw = res.headers.raw();
      const out = {};
      for (const k of Object.keys(raw)) out[k] = Array.isArray(raw[k]) ? raw[k].join(', ') : raw[k];
      return out;
    }
  } catch {
    /* ignore */
  }
  return {};
}

function parseSetCookie(res) {
  const out = {};
  try {
    const sc = res.headers?.raw ? res.headers.raw()['set-cookie'] : res.headers?.get?.('set-cookie');
    const list = Array.isArray(sc) ? sc : sc ? [sc] : [];
    for (const line of list) {
      const first = String(line).split(';')[0];
      const eq = first.indexOf('=');
      if (eq > 0) out[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
    }
  } catch {
    /* ignore */
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base) => base + Math.floor(Math.random() * base);

// ── Clearance cache (removes the manual-cookie step) ─────────────
class ClearanceStore {
  constructor(file) {
    this.file = file;
    this.mem = null;
  }
  load() {
    if (this.mem) return this.mem;
    try {
      if (fs.existsSync(this.file)) {
        this.mem = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      }
    } catch {
      /* ignore malformed */
    }
    return this.mem;
  }
  get(host) {
    const all = this.load();
    const e = all && all[host];
    if (!e) return null;
    if (e.expires && Date.now() > e.expires) return null; // expired
    return e; // { cookies, userAgent, savedAt, expires }
  }
  set(host, entry) {
    const all = this.load() || {};
    all[host] = { ...entry, savedAt: Date.now() };
    this.mem = all;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(all, null, 2));
    } catch {
      /* ignore */
    }
  }
}

function cookieHeader(obj) {
  return Object.entries(obj || {})
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/**
 * AdvancedSolver
 *
 * @param {object} cfg
 *   cfg.cacheFile   path for clearance cache (default ./cf-clearance-cache.json)
 *   cfg.identities  override identity list
 *   cfg.proxies     array of proxy URLs to rotate through (optional)
 *   cfg.retries     TLS attempts per identity (default 2)
 *   cfg.clearanceTtlMs  how long a captured clearance is trusted (default 30m)
 *   cfg.solver      { backend: 'capsolver'|'flaresolverr', apiKey, url }  (optional)
 *   cfg.log         logger fn (default no-op)
 */
class AdvancedSolver {
  constructor(cfg = {}) {
    this.identities = cfg.identities || IDENTITIES;
    this.proxies = cfg.proxies && cfg.proxies.length ? cfg.proxies : [null];
    this.retries = cfg.retries ?? 2;
    this.clearanceTtlMs = cfg.clearanceTtlMs ?? 30 * 60 * 1000;
    this.store = new ClearanceStore(
      cfg.cacheFile || path.join(process.cwd(), 'cf-clearance-cache.json')
    );
    this.solver =
      cfg.solver ||
      (process.env.CAPSOLVER_API_KEY
        ? { backend: 'capsolver', apiKey: process.env.CAPSOLVER_API_KEY }
        : process.env.FLARESOLVERR_URL
          ? { backend: 'flaresolverr', url: process.env.FLARESOLVERR_URL }
          : null);
    // Remote clearance source: a URL (e.g. a GitHub Gist raw link) that a
    // scheduled browser solver keeps fresh. Lets a browser-free host reuse a
    // cf_clearance solved elsewhere, as long as both egress the SAME proxy IP.
    this.clearanceUrl = cfg.clearanceUrl || process.env.ABLK_CLEARANCE_URL || null;
    this._remoteFetchedAt = 0;
    this.log = cfg.log || (() => {});
  }

  /**
   * Pull a clearance published by the scheduled solver and seed the local store.
   * Expected JSON (single host):
   *   { host, cf_clearance, cookies?, user_agent, proxy?, solved_at, ttl_ms? }
   * A map keyed by host is also accepted.
   */
  async _loadRemoteClearance(host) {
    if (!this.clearanceUrl) return null;
    // Avoid hammering the source: refresh at most every 60s.
    if (Date.now() - this._remoteFetchedAt < 60 * 1000) return this.store.get(host);
    this._remoteFetchedAt = Date.now();
    try {
      const res = await new Promise((resolve, reject) => {
        const u = new URL(this.clearanceUrl);
        const transport = u.protocol === 'https:' ? https : http;
        const req = transport.get(
          this.clearanceUrl,
          { headers: { 'User-Agent': 'animeblkom-api/clearance-fetch', 'Cache-Control': 'no-cache' } },
          (r) => {
            const chunks = [];
            r.on('data', (d) => chunks.push(d));
            r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
          }
        );
        req.setTimeout(15000, () => req.destroy(new Error('clearance fetch timeout')));
        req.on('error', reject);
      });
      if (res.status < 200 || res.status >= 300) {
        this.log(`remote clearance HTTP ${res.status}`);
        return this.store.get(host);
      }
      let data = JSON.parse(res.body);
      // Accept either a single-host object or a { host: entry } map.
      if (data && !data.cf_clearance && !data.cookies && data[host]) data = data[host];
      if (!data) return this.store.get(host);

      const targetHost = data.host || host;
      const cookies = data.cookies && typeof data.cookies === 'object'
        ? data.cookies
        : data.cf_clearance
          ? { cf_clearance: data.cf_clearance }
          : null;
      if (!cookies || !cookies.cf_clearance) {
        this.log('remote clearance missing cf_clearance');
        return this.store.get(host);
      }
      const solvedAt = data.solved_at ? Date.parse(data.solved_at) : Date.now();
      const ttl = data.ttl_ms || this.clearanceTtlMs;
      const expires = solvedAt + ttl;
      if (Date.now() > expires) {
        this.log(`remote clearance already expired (solved_at=${data.solved_at})`);
        return this.store.get(host);
      }
      this.store.set(targetHost, {
        cookies,
        userAgent: data.user_agent || this.identities[0].ua,
        proxy: data.proxy || null,
        expires,
      });
      this.log(`remote clearance loaded for ${targetHost}, expires in ${Math.round((expires - Date.now()) / 1000)}s`);
      return this.store.get(host);
    } catch (e) {
      this.log(`remote clearance load failed: ${e.message}`);
      return this.store.get(host);
    }
  }

  baseHeaders(ua) {
    return {
      'User-Agent': ua,
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    };
  }

  /**
   * Primary entry: fetch a URL, transparently bypassing CF when possible.
   * @returns {object} { ok, html, status, method, protection, cookies, userAgent, error }
   */
  async fetch(url, opts = {}) {
    const host = new URL(url).host;

    // 0) Reuse a cached clearance if we have a fresh one. If the local cache is
    //    empty/stale and a remote source is configured, pull the latest first.
    let cached = this.store.get(host);
    if ((!cached || !cached.cookies) && this.clearanceUrl) {
      cached = await this._loadRemoteClearance(host);
    }
    if (cached && cached.cookies) {
      const r = await this._replayWithClearance(url, cached, opts);
      if (r && r.protection.type === 'none') {
        return this._ok(r, cached.proxy ? 'clearance:forward-proxy' : 'cached-clearance', cached.cookies, cached.userAgent);
      }
      this.log(`cached clearance stale for ${host}, re-solving`);
    }

    // 1) TLS layer: rotate identities × proxies with warmup + retry/backoff.
    const tls = await this._tlsLayer(url, opts);
    if (tls.ok) return tls;

    // 2) Solver backend (only if configured) for managed-challenge/turnstile.
    if (this.solver && (tls.protection?.type === 'managed-challenge' || tls.protection?.type === 'turnstile')) {
      try {
        const solved = await this._solverLayer(url, tls, opts);
        if (solved && solved.ok) return solved;
        if (solved && solved.error) tls.error = solved.error;
      } catch (e) {
        tls.error = `solver backend failed: ${e.message}`;
      }
    }

    // Nothing worked — return a precise diagnostic.
    return {
      ok: false,
      status: tls.status,
      method: tls.method,
      protection: tls.protection,
      error:
        tls.error ||
        this._diagnostic(tls.protection, host),
    };
  }

  _diagnostic(protection, host) {
    const t = protection?.type;
    if (t === 'managed-challenge') {
      return (
        `Cloudflare Managed Challenge active for ${host} (cf-mitigated: challenge). ` +
        `A browser-free TLS client cannot pass this from the current IP. Enable a clean ` +
        `residential/mobile proxy (cfg.proxies / opts.proxy) or a solver backend ` +
        `(CAPSOLVER_API_KEY or FLARESOLVERR_URL) to obtain cf_clearance automatically.`
      );
    }
    if (t === 'turnstile') {
      return `Turnstile challenge for ${host}. Configure a solver backend (CAPSOLVER_API_KEY) to solve it.`;
    }
    if (t === 'waf-tls') {
      return `WAF/403 for ${host} after TLS rotation. Try a proxy with better IP reputation.`;
    }
    return `Unresolved protection for ${host}.`;
  }

  _ok(r, method, cookies, ua) {
    return {
      ok: true,
      html: r.html,
      status: r.status,
      method,
      protection: { type: 'none' },
      cookies: cookies || r.cookies,
      userAgent: ua || r.userAgent,
    };
  }

  async _tlsLayer(url, opts) {
    const host = new URL(url).host;
    let last = { status: 0, method: 'tls', protection: { type: 'other' }, error: null };

    for (const proxy of this.proxies) {
      for (const identity of this.identities) {
        for (let attempt = 0; attempt < this.retries; attempt++) {
          try {
            // Warm the session on the first attempt of each identity so CF sees
            // a returning visitor (cookie + connection reuse).
            const r = await this._sessionWarmup(url, { identity, proxy, extraHeaders: opts.headers });
            last = r;
            if (r.protection.type === 'none') {
              // Capture any cf_clearance for reuse.
              if (r.cookies && r.cookies.cf_clearance) {
                this.store.set(host, {
                  cookies: r.cookies,
                  userAgent: identity.ua,
                  expires: Date.now() + this.clearanceTtlMs,
                });
              }
              return this._ok(r, `tls:${identity.profile}${proxy ? ':proxied' : ''}`, r.cookies, identity.ua);
            }
          } catch (e) {
            last = { status: 0, method: 'tls', protection: { type: 'other' }, error: e.message };
          }
          await sleep(jitter(400)); // backoff + jitter between attempts
        }
      }
    }
    return { ok: false, ...last };
  }

  /** One identity: warm up (hit root, collect cookies) then request target. */
  async _sessionWarmup(url, { identity, proxy, extraHeaders }) {
    const origin = new URL(url).origin + '/';
    let session;
    try {
      session = await wreq().createSession({
        browser: identity.profile,
        os: identity.os,
        ...(proxy ? { proxy } : {}),
      });
    } catch {
      session = null; // fall back to stateless fetch
    }

    const doFetch = async (target, referer) => {
      const headers = {
        ...this.baseHeaders(identity.ua),
        ...(referer ? { Referer: referer, 'Sec-Fetch-Site': 'same-origin' } : {}),
        ...(extraHeaders || {}),
      };
      if (session) return session.fetch(target, { headers });
      return wreq().fetch(target, { browser: identity.profile, os: identity.os, headers, ...(proxy ? { proxy } : {}) });
    };

    try {
      // Warmup hit (ignore body); collect cookies.
      const warm = await doFetch(origin, null);
      const warmCookies = parseSetCookie(warm);
      try {
        await warm.text();
      } catch {
        /* ignore */
      }
      await sleep(jitter(500));

      // Real request, reusing cookies from warmup if stateless.
      const target = url;
      const res = await doFetch(target, origin);
      const html = await res.text();
      const headers = headerBag(res);
      const cookies = { ...warmCookies, ...parseSetCookie(res) };
      const protection = classify(res.status, html, headers);
      return { ok: protection.type === 'none', html, status: res.status, method: `tls:${identity.profile}`, protection, cookies, userAgent: identity.ua };
    } finally {
      try {
        if (session && session.close) await session.close();
      } catch {
        /* ignore */
      }
    }
  }

  /** Layer 3: hand the challenge to an external solver (no local browser). */
  async _solverLayer(url, tls, opts) {
    const host = new URL(url).host;
    if (this.solver.backend === 'flaresolverr') {
      return this._flaresolverr(url, host);
    }
    if (this.solver.backend === 'capsolver') {
      return this._capsolver(url, host, tls, opts);
    }
    return { ok: false, error: `unknown solver backend '${this.solver.backend}'` };
  }

  /**
   * FlareSolverr: a self-hosted service that returns cookies + UA. It uses a
   * headless browser internally (not in THIS process), so it fits "no browser in
   * our code / no manual cookie" while still solving managed challenges.
   */
  async _flaresolverr(url, host) {
    const endpoint = this.solver.url.replace(/\/$/, '') + '/v1';
    const res = await wreq().fetch(endpoint, {
      browser: 'chrome_149',
      os: 'windows',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'request.get', url, maxTimeout: 60000 }),
    });
    const data = JSON.parse(await res.text());
    if (data.status !== 'ok' || !data.solution) {
      return { ok: false, error: `flaresolverr: ${data.message || 'no solution'}` };
    }
    const sol = data.solution;
    const cookies = {};
    for (const c of sol.cookies || []) cookies[c.name] = c.value;
    if (cookies.cf_clearance) {
      this.store.set(host, {
        cookies,
        userAgent: sol.userAgent,
        expires: Date.now() + this.clearanceTtlMs,
      });
    }
    const protection = classify(sol.status || 200, sol.response || '', {});
    return {
      ok: protection.type === 'none',
      html: sol.response,
      status: sol.status || 200,
      method: 'flaresolverr',
      protection,
      cookies,
      userAgent: sol.userAgent,
    };
  }

  /**
   * CapSolver: AntiCloudflareTask returns cf_clearance + UA for managed
   * challenges; TurnstileTask returns a token. API-only, no local browser.
   */
  async _capsolver(url, host, tls, opts) {
    const apiKey = this.solver.apiKey || process.env.CAPSOLVER_API_KEY;
    if (!apiKey) return { ok: false, error: 'capsolver: no apiKey' };
    const proxy = (opts && opts.proxy) || this.proxies.find(Boolean) || null;

    // AntiCloudflareTask needs a proxy (CapSolver solves from your IP context).
    if (!proxy) {
      return {
        ok: false,
        error:
          'capsolver AntiCloudflareTask requires a proxy (cfg.proxies/opts.proxy) so the returned cf_clearance matches an IP. Provide one.',
      };
    }

    const task = {
      type: 'AntiCloudflareTask',
      websiteURL: url,
      proxy,
    };
    const created = await this._capPost('https://api.capsolver.com/createTask', {
      clientKey: apiKey,
      task,
    });
    if (created.errorId) return { ok: false, error: `capsolver create: ${created.errorDescription}` };

    // Poll for result.
    let result = null;
    for (let i = 0; i < 40; i++) {
      await sleep(1500);
      const r = await this._capPost('https://api.capsolver.com/getTaskResult', {
        clientKey: apiKey,
        taskId: created.taskId,
      });
      if (r.status === 'ready') {
        result = r.solution;
        break;
      }
      if (r.status === 'failed' || r.errorId) {
        return { ok: false, error: `capsolver task: ${r.errorDescription || 'failed'}` };
      }
    }
    if (!result) return { ok: false, error: 'capsolver: timeout waiting for solution' };

    const cookies = {};
    if (result.cookies) {
      if (Array.isArray(result.cookies)) {
        for (const c of result.cookies) cookies[c.name] = c.value;
      } else if (typeof result.cookies === 'object') {
        Object.assign(cookies, result.cookies);
      }
    }
    if (result.cf_clearance && !cookies.cf_clearance) cookies.cf_clearance = result.cf_clearance;
    const ua = result.userAgent || this.identities[0].ua;
    if (cookies.cf_clearance) {
      this.store.set(host, { cookies, userAgent: ua, expires: Date.now() + this.clearanceTtlMs });
    }

    // Re-fetch the target with the fresh clearance through the same proxy.
    const r = await this._raw(url, {
      identity: { profile: 'chrome_149', os: 'windows', ua },
      cookie: cookieHeader(cookies),
      proxy,
      extraHeaders: opts.headers,
    });
    if (r && r.protection.type === 'none') {
      return this._ok(r, 'capsolver', cookies, ua);
    }
    return { ok: false, error: 'capsolver returned clearance but target still challenged (IP/UA mismatch?)' };
  }

  async _capPost(endpoint, payload) {
    const res = await wreq().fetch(endpoint, {
      browser: 'chrome_149',
      os: 'windows',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return JSON.parse(await res.text());
  }

  /**
   * Replay a request using a solved clearance. Chooses the transport that
   * actually works for the bound IP:
   *   - clearance has a proxy → forward-proxy transport (Webshare-style HTTP
   *     proxy; the only working HTTPS path AND it pins the same exit IP the
   *     cf_clearance was bound to).
   *   - no proxy → wreq-js direct with a browser TLS fingerprint.
   */
  async _replayWithClearance(url, cached, opts = {}) {
    const cookie = cookieHeader(cached.cookies);
    const proxy = cached.proxy || (this.proxies[0] && this.proxies[0] !== null ? this.proxies[0] : null);
    const ua = cached.userAgent || this.identities[0].ua;

    if (proxy) {
      try {
        const r = await forwardProxyFetch(url, {
          proxy,
          headers: {
            'User-Agent': ua,
            Accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
            Cookie: cookie,
            ...(opts.headers || {}),
          },
        });
        const protection = classify(r.status, r.html, r.headers);
        return { html: r.html, status: r.status, protection, cookies: { ...cached.cookies, ...r.cookies }, userAgent: ua };
      } catch (e) {
        this.log(`forward-proxy replay failed: ${e.message}`);
        return { html: '', status: 0, protection: { type: 'other' }, error: e.message };
      }
    }

    return this._raw(url, {
      identity: { profile: 'chrome_149', os: 'windows', ua },
      cookie,
      proxy: null,
      extraHeaders: opts.headers,
    });
  }

  /** Stateless single fetch with a specific identity+cookie (used after solve). */
  async _raw(url, { identity, cookie, proxy, extraHeaders }) {
    try {
      const res = await wreq().fetch(url, {
        browser: identity.profile,
        os: identity.os,
        headers: {
          ...this.baseHeaders(identity.ua),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(extraHeaders || {}),
        },
        ...(proxy ? { proxy } : {}),
      });
      const html = await res.text();
      const protection = classify(res.status, html, headerBag(res));
      return { html, status: res.status, protection, cookies: parseSetCookie(res), userAgent: identity.ua };
    } catch (e) {
      return { html: '', status: 0, protection: { type: 'other' }, error: e.message };
    }
  }
}

module.exports = { AdvancedSolver, classify, IDENTITIES, forwardProxyFetch };
