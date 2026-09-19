const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const http = require('http');
const apiRoutes = require('./routes/api');
const { UA } = require('./utils/fetcher');

const app = express();
const PORT = process.env.PORT || 7000;

// Keep the process alive on stray async errors.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.message ? err.message : err);
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── Image proxy (uploads on animeblkom.net) ─────────────────────
app.get('/api/proxy/image', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ ok: false, error: 'Missing ?url=' });
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ ok: false, error: 'Invalid url' });
  }
  const mod = parsed.protocol === 'https:' ? https : http;
  mod
    .get(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: { 'User-Agent': UA, Referer: 'https://animeblkom.net/' },
      },
      (imgRes) => {
        res.set({
          'Content-Type': imgRes.headers['content-type'] || 'image/jpeg',
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*',
        });
        imgRes.pipe(res);
      }
    )
    .on('error', (e) => res.status(502).json({ ok: false, error: e.message }));
});

app.use('/api', apiRoutes);

app.get('/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

app.get('/api-docs', (_, res) =>
  res.json({
    name: 'AnimeBlkom API',
    version: '1.0.0',
    source: 'animeblkom.net (HTML scraping + Cloudflare TLS bypass)',
    endpoints: {
      'GET /api/home': 'Homepage: latest episodes + featured + sections',
      'GET /api/list/:type': 'List by type (anime, movie, ova, ona, special). Filters: ?page, query, genres, studios, year, status, sort, age, season',
      'GET /api/anime?...': 'Alias for /api/list/anime',
      'GET /api/movies?...': 'Alias for /api/list/movie',
      'GET /api/timeline': 'Release schedule / timeline',
      'GET /api/search?q=keyword&page=1': 'Search anime + movies',
      'GET /api/anime/:slug': 'Anime detail: metadata, genres, story, rating, trailer, episode list',
      'GET /api/watch/:slug/:episode': 'Watch page: streaming servers + downloads. Add ?resolve=1 to resolve embeds',
      'GET /api/sources/:slug/:episode': 'Servers + downloads only (lighter)',
      'GET /api/resolve?url=EMBED_URL': 'Resolve a player embed → direct video/mp4/m3u8 URLs',
      'GET /api/proxy/image?url=...': 'Image proxy for animeblkom uploads',
      'POST /api/set-cookies': 'Store cf_clearance cookie { cookies: "cf_clearance=..." }',
      'GET /api/status': 'Cookie / Cloudflare status',
      'GET /api/help': 'How to bypass the Cloudflare challenge',
    },
  })
);

app.listen(PORT, () => {
  console.log('═══════════════════════════════════════════');
  console.log(`  AnimeBlkom API → http://localhost:${PORT}`);
  console.log('═══════════════════════════════════════════');
});
