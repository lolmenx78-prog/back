const cheerio = require('cheerio');
const { getPage, BASE } = require('../utils/fetcher');

// ─── Shared helpers ──────────────────────────────────────────────
function abs(url) {
  if (!url) return null;
  if (url.startsWith('http')) return url;
  if (url.startsWith('//')) return 'https:' + url;
  return BASE + (url.startsWith('/') ? url : '/' + url);
}

/** Pull slug from /anime/{slug} or /movie/{slug}. */
function slugFromAnimeUrl(href = '') {
  const m = href.match(/\/(?:anime|movie)\/([^/?#]+)/);
  return m ? m[1] : null;
}

/** Pull { slug, episode } from /watch/{slug}/{episode}. */
function parseWatchUrl(href = '') {
  const m = href.match(/\/watch\/([^/?#]+)\/([^/?#]+)/);
  return m ? { slug: m[1], episode: m[2] } : { slug: null, episode: null };
}

/** Lazy images store the real src in data-original / data-src / owl-lazy. */
function imgSrc($, el) {
  const $img = $(el).find('img').first();
  const src =
    $img.attr('data-original') ||
    $img.attr('data-src') ||
    $img.attr('data-lazy') ||
    $img.attr('src') ||
    null;
  return abs(src);
}

/**
 * Parse an anime "content" card (used on listing pages, sliders, search).
 * Structure: .content > .poster a[href=/anime/slug] img + .info .name a
 */
function parseContentCard($, el) {
  const $el = $(el);
  const $link = $el.find('.poster a, a.poster, .name a').first();
  const href = abs($link.attr('href'));
  const slug = slugFromAnimeUrl($link.attr('href') || '');
  const name = $el.find('.info .name a, .name a, .name').first().text().trim() ||
    $el.find('img').first().attr('alt')?.replace(/\s*poster$/i, '').trim() || null;

  const genres = [];
  $el.find('.genres a').each((_, a) => {
    const g = $(a).text().trim();
    if (g) genres.push(g);
  });

  const story = $el.find('.story .story-text p, .story p').first().text().trim() || null;

  // Rating lives in .badges .badge[title="4.69 ( 5 تقييم)"]
  let rating = null;
  const $rate = $el.find('.badges .badge[title]').first();
  if ($rate.length) {
    const val = parseFloat($rate.text().trim());
    const title = $rate.attr('title') || '';
    const cnt = (title.match(/(\d[\d,]*)\s*تقييم/) || [])[1];
    if (!isNaN(val)) rating = { value: val, count: cnt ? parseInt(cnt.replace(/\D/g, ''), 10) : null };
  }

  return {
    name,
    slug,
    url: href,
    kind: (href || '').includes('/movie/') ? 'movie' : 'anime',
    poster: imgSrc($, el),
    genres,
    ...(story ? { story } : {}),
    ...(rating ? { rating } : {}),
  };
}

/**
 * Parse a "recent-episode" card from the homepage.
 * Structure: .recent-episode > a[href=/watch/slug/ep] .poster img + .name + .episode-number
 */
function parseEpisodeCard($, el) {
  const $el = $(el);
  const $a = $el.find('a').first();
  const href = abs($a.attr('href'));
  const { slug, episode } = parseWatchUrl($a.attr('href') || '');
  const name = $el.find('.name').first().text().trim() ||
    $el.find('img').first().attr('alt')?.replace(/\s*poster$/i, '').trim() || null;
  const epText = $el.find('.episode-number').first().text().trim();
  const epNum = (epText.match(/(\d+(?:\.\d+)?)/) || [])[1] || episode;

  const badges = [];
  $el.find('.badge').each((_, b) => {
    const t = $(b).text().trim();
    if (t) badges.push(t);
  });
  const viewsBadge = badges.find((b) => /^\d[\d,]*$/.test(b.replace(/[^\d,]/g, '')) && /\d/.test(b));

  return {
    name,
    slug,
    episode: epNum,
    url: href,
    watchUrl: href,
    animeUrl: slug ? `${BASE}/anime/${slug}` : null,
    poster: imgSrc($, el),
    isLast: badges.some((b) => b.includes('الأخيرة')),
    views: viewsBadge ? parseInt(viewsBadge.replace(/\D/g, ''), 10) : null,
    badges,
  };
}

// ─── Home page ───────────────────────────────────────────────────
async function parseHome() {
  const html = await getPage('/');
  const $ = cheerio.load(html);

  // Latest added episodes
  const latestEpisodes = [];
  $('.recently-added .recent-episode, .recent-episodes .recent-episode').each((_, el) => {
    const c = parseEpisodeCard($, el);
    if (c.slug) latestEpisodes.push(c);
  });

  // Slider "الانميات المتجددة" — .eps-slider .owl-carousel .item.episode
  // These are episode cards (link to /watch/slug/ep).
  const featured = [];
  $('.eps-slider .owl-carousel .item, .eps-slider .item.episode, .container.eps-slider .item').each((_, el) => {
    const c = parseEpisodeCard($, el);
    if (c.slug) featured.push(c);
  });

  // Any additional content grids on the home page
  const sections = [];
  $('.section, section').each((_, sec) => {
    const heading = $(sec).find('.heading h1, .heading h2, h1, h2').first().text().trim();
    if (!heading) return;
    const items = [];
    $(sec)
      .find('.content')
      .each((_, el) => {
        const c = parseContentCard($, el);
        if (c.slug) items.push(c);
      });
    if (items.length) sections.push({ title: heading, count: items.length, items });
  });

  return {
    latestEpisodes: dedupe(latestEpisodes, (c) => c.url),
    featured: dedupe(featured, (c) => c.slug),
    sections,
  };
}

function dedupe(arr, keyFn) {
  const seen = new Set();
  return arr.filter((x) => {
    const k = keyFn(x);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

module.exports = {
  parseHome,
  parseContentCard,
  parseEpisodeCard,
  slugFromAnimeUrl,
  parseWatchUrl,
  abs,
  imgSrc,
  dedupe,
};
