const { Router } = require('express');
const { parseHome } = require('../parsers/home');
const { listContents, search, parseTimeline, LIST_PATHS } = require('../parsers/listings');
const { parseAnimeDetail } = require('../parsers/anime');
const { parseWatchPage, getSources, resolveEmbed } = require('../parsers/watch');
const { setCookiesManually, cookieString, engineStatus, UA, CloudflareError } = require('../utils/fetcher');

const router = Router();

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    const status = e instanceof CloudflareError ? 503 : 500;
    res.status(status).json({ ok: false, error: e.message, ...(e.code ? { code: e.code } : {}) });
  });

// ─── Home ────────────────────────────────────────────────────────
router.get('/home', wrap(async (_, res) => {
  res.json({ ok: true, ...(await parseHome()) });
}));

// ─── Listings (anime / movie / ova / ona / special) ──────────────
// GET /api/list/:type?page=&genres=&studios=&year=&status=&sort=&query=
router.get('/list/:type', wrap(async (req, res) => {
  res.json({ ok: true, filters: req.query, ...(await listContents(req.params.type, req.query)) });
}));

// Convenience aliases
router.get('/anime', wrap(async (req, res) => {
  res.json({ ok: true, filters: req.query, ...(await listContents('anime', req.query)) });
}));
router.get('/movies', wrap(async (req, res) => {
  res.json({ ok: true, filters: req.query, ...(await listContents('movie', req.query)) });
}));

// ─── Timeline (release schedule) ─────────────────────────────────
router.get('/timeline', wrap(async (_, res) => {
  res.json({ ok: true, ...(await parseTimeline()) });
}));

// ─── Search ──────────────────────────────────────────────────────
router.get('/search', wrap(async (req, res) => {
  const q = req.query.q || req.query.query;
  if (!q) return res.status(400).json({ ok: false, error: 'Missing ?q= parameter' });
  res.json({ ok: true, ...(await search(q, parseInt(req.query.page, 10) || 1)) });
}));

// ─── Anime detail ────────────────────────────────────────────────
router.get('/anime/:slug', wrap(async (req, res) => {
  res.json({ ok: true, data: await parseAnimeDetail(req.params.slug) });
}));

// ─── Watch page (servers + downloads) ────────────────────────────
// Add ?resolve=1 to also resolve each server embed → direct video URLs
router.get('/watch/:slug/:episode', wrap(async (req, res) => {
  const data = await parseWatchPage(req.params.slug, req.params.episode);
  if (req.query.resolve === '1') {
    for (const s of data.servers) {
      try {
        const r = await resolveEmbed(s.embedUrl);
        s.sources = r.sources;
      } catch (e) {
        s.resolveError = e.message;
      }
    }
  }
  res.json({ ok: true, data });
}));

// ─── Sources manifest only ───────────────────────────────────────
router.get('/sources/:slug/:episode', wrap(async (req, res) => {
  res.json({ ok: true, ...(await getSources(req.params.slug, req.params.episode)) });
}));

// ─── Resolve a single embed URL → direct video sources ───────────
// GET /api/resolve?url=https://videos.vid4up.xyz/embedvideo/xxxx
router.get('/resolve', wrap(async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ ok: false, error: 'Missing ?url= parameter' });
  res.json({ ok: true, ...(await resolveEmbed(url)) });
}));

// ─── Cloudflare cookie management ────────────────────────────────
// POST /api/set-cookies  { cookies: "cf_clearance=...; ..." }
router.post('/set-cookies', (req, res) => {
  const cookies = req.body && req.body.cookies;
  if (!cookies) return res.status(400).json({ ok: false, error: 'Missing "cookies" in body' });
  const merged = setCookiesManually(cookies);
  res.json({ ok: true, message: 'Cookies stored. Ensure they were captured with this User-Agent.', userAgent: UA, active: !!merged });
});

router.get('/status', (_, res) => {
  res.json({ ok: true, ...engineStatus() });
});

router.get('/help', (_, res) => {
  res.json({
    ok: true,
    title: 'AnimeBlkom API — Cloudflare bypass engine',
    note:
      'animeblkom.net is behind a Cloudflare Managed Challenge. The API uses a browser-free engine (AdvancedSolver) that needs no manual cookie: it rotates Chrome/Firefox/Edge/Safari TLS fingerprints (wreq-js), warms up a session, retries with backoff, and auto-caches any cf_clearance it obtains.',
    unlockingActiveChallenge: {
      note:
        'An ACTIVE managed challenge (cf-mitigated: challenge) cannot be solved by TLS alone from a hard-blocked datacenter IP. Use ONE of these (both browser-free, no manual cookie):',
      options: [
        'Proxy: set ABLK_PROXIES=http://user:pass@host:port (comma-separated for rotation). A clean residential/mobile IP usually removes the challenge entirely.',
        'Solver backend: set CAPSOLVER_API_KEY=... (AntiCloudflareTask, needs a proxy too) OR run FlareSolverr and set FLARESOLVERR_URL=http://localhost:8191.',
      ],
    },
    manualOverride: {
      note: 'Optional last resort if you cannot use a proxy/solver:',
      steps: [
        '1. Open https://animeblkom.net in Chrome and pass the "Just a moment" check.',
        '2. DevTools → Application → Cookies → animeblkom.net → copy cf_clearance.',
        '3. POST /api/set-cookies { "cookies": "cf_clearance=VALUE" } OR set env CF_CLEARANCE=VALUE.',
        `4. cf_clearance is bound to this User-Agent: ${UA}`,
      ],
    },
  });
});

module.exports = router;
