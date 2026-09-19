const cheerio = require('cheerio');
const { getPage, BASE } = require('../utils/fetcher');
const { parseContentCard, parseEpisodeCard, dedupe } = require('./home');

// ─── Generic grid scraper ────────────────────────────────────────
function scrapeContents(html) {
  const $ = cheerio.load(html);
  const items = [];
  $('.contents .content, .list-section .content, .content').each((_, el) => {
    const c = parseContentCard($, el);
    if (c.slug) items.push(c);
  });
  return dedupe(items, (c) => c.slug);
}

/** Read the highest page number from .pagination. */
function readTotalPages(html) {
  const $ = cheerio.load(html);
  let max = 1;
  $('.pagination .page-link, .pagination a, a.page-link').each((_, a) => {
    const href = $(a).attr('href') || '';
    const hm = href.match(/[?&]page=(\d+)/);
    if (hm) max = Math.max(max, parseInt(hm[1], 10));
    const t = parseInt($(a).text().trim(), 10);
    if (!isNaN(t)) max = Math.max(max, t);
  });
  return max;
}

// Map of listing "type" → path segment on animeblkom
const LIST_PATHS = {
  anime: '/anime-list',
  animes: '/animes-list',
  movie: '/movie-list',
  movies: '/movie-list',
  ova: '/ova-list',
  ona: '/ona-list',
  special: '/special-list',
  specials: '/special-list',
};

/**
 * Listing with filters + pagination.
 * Supported query keys (passed straight through to animeblkom):
 *   page, query, genres, studios, year, status, type, sort, age, season
 * `genres`/`studios` may be comma-separated or repeated.
 */
async function listContents(type = 'anime', params = {}) {
  const base = LIST_PATHS[type] || LIST_PATHS.anime;
  const qs = new URLSearchParams();

  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || k === 'genres' || k === 'studios') continue;
    qs.set(k, String(v));
  }
  const appendMulti = (key, val) => {
    if (!val) return;
    const arr = Array.isArray(val) ? val : String(val).split(',');
    arr.map((s) => s.trim()).filter(Boolean).forEach((s) => qs.append(key, s));
  };
  appendMulti('genres', params.genres);
  appendMulti('studios', params.studios);

  const path = base + (qs.toString() ? `?${qs}` : '');
  const html = await getPage(path);
  const items = scrapeContents(html);
  return {
    type,
    page: parseInt(params.page, 10) || 1,
    totalPages: readTotalPages(html),
    count: items.length,
    items,
  };
}

// ─── Search ──────────────────────────────────────────────────────
async function search(query, page = 1) {
  const qs = new URLSearchParams({ query });
  if (page > 1) qs.set('page', page);
  const html = await getPage(`/search?${qs}`);
  let items = scrapeContents(html);

  // Some search results render as episode cards; capture those too.
  if (!items.length) {
    const $ = cheerio.load(html);
    const eps = [];
    $('.recent-episode, .episode').each((_, el) => {
      const c = parseEpisodeCard($, el);
      if (c.slug) eps.push(c);
    });
    items = dedupe(eps, (c) => c.url);
  }
  return { query, page, totalPages: readTotalPages(html), count: items.length, items };
}

// ─── Timeline (release schedule) ─────────────────────────────────
async function parseTimeline() {
  const html = await getPage('/timeline');
  const $ = cheerio.load(html);
  const items = [];
  $('.recent-episode, .episode, .content, .timeline-item').each((_, el) => {
    const $el = $(el);
    if ($el.find('a[href*="/watch/"]').length) {
      const c = parseEpisodeCard($, el);
      if (c.slug) items.push(c);
    } else {
      const c = parseContentCard($, el);
      if (c.slug) items.push(c);
    }
  });
  return { count: items.length, items: dedupe(items, (c) => c.url || c.slug) };
}

module.exports = {
  listContents,
  search,
  parseTimeline,
  scrapeContents,
  readTotalPages,
  LIST_PATHS,
};
