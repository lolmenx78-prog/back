const cheerio = require('cheerio');
const { getPage, BASE } = require('../utils/fetcher');
const { abs } = require('./home');

// Arabic info-table label → normalized key
const INFO_KEYS = {
  'عدد الحلقات': 'episodeCount',
  'التصنيف العمري': 'ageRating',
  'تاريخ الانتاج': 'releaseDate',
  'تاريخ الإنتاج': 'releaseDate',
  'حالة الأنمي': 'status',
  'الاستديو': 'studio',
  'الأستوديو': 'studio',
  'المخرج': 'director',
  'المصدر': 'source',
  'النوع': 'kind',
  'الموسم': 'season',
  'المدة': 'duration',
};

function textOrNull(s) {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t && t !== '-' ? t : null;
}

/**
 * Anime detail: /anime/{slug}
 * Returns metadata, genres, story, rating, poster, trailer, episode list.
 */
async function parseAnimeDetail(slug) {
  const html = await getPage(`/anime/${slug}`);
  const $ = cheerio.load(html);

  // Title (strip trailing "(anime)" / "(movie)" small tag)
  const rawTitle = $('.namengenres .name h1, .anime-info .name h1, h1').first().text().trim();
  const kindTag = $('.namengenres .name h1 small, h1 small').first().text().replace(/[()]/g, '').trim();
  const title = rawTitle.replace(/\(\s*(anime|movie|ova|ona|special)\s*\)/i, '').trim();

  // Poster
  const poster =
    abs($('.poster-column img, .poster img, .anime-info .poster img').first().attr('data-original') ||
      $('.poster-column img, .poster img').first().attr('src')) || null;

  // Genres
  const genres = [];
  $('.namengenres .genres a, .genres a').each((_, a) => {
    const g = $(a).text().trim();
    if (g && !genres.includes(g)) genres.push(g);
  });

  // Story / synopsis
  const story =
    textOrNull($('.story-container .story, .story-column .story, .story').first().text()) || null;

  // Info table (episodes, age, date, status)
  const info = {};
  $('.info-table > div').each((_, row) => {
    const head = $(row).find('.head').first().text().trim();
    const val = textOrNull($(row).find('.info').first().text());
    const key = INFO_KEYS[head];
    if (key && val) info[key] = val;
  });

  // Info cards (studio, director, source ...) — may contain links
  const meta = {};
  $('.info-cards > div').each((_, row) => {
    const head = $(row).find('.head').first().text().trim();
    const key = INFO_KEYS[head] || head;
    const links = [];
    $(row).find('.info a').each((_, a) => {
      const name = $(a).text().trim();
      if (name) links.push({ name, url: abs($(a).attr('href')) });
    });
    const val = links.length ? links : textOrNull($(row).find('.info').first().text());
    if (val && (Array.isArray(val) ? val.length : true)) meta[key] = val;
  });

  // Rating
  const ratingTitle = $('.rating-box [title], .rating-container [title]').first().attr('title') || '';
  const ratingVal = parseFloat($('.rating-box, .rating').first().text().trim()) || null;
  const ratingCount = (ratingTitle.match(/(\d[\d,]*)\s*تقييم/) || [])[1] || null;

  // Trailer (YouTube)
  let trailer = null;
  const yt = $('a[href*="youtube.com/watch"], a[href*="youtu.be"], iframe[src*="youtube"]').first();
  if (yt.length) {
    const src = yt.attr('href') || yt.attr('src');
    const id = (String(src).match(/(?:v=|youtu\.be\/|embed\/)([\w-]{11})/) || [])[1];
    if (id) {
      trailer = {
        id,
        url: `https://www.youtube.com/watch?v=${id}`,
        embedUrl: `https://www.youtube.com/embed/${id}`,
        thumbnail: `https://img.youtube.com/vi/${id}/hqdefault.jpg`,
      };
    }
  }

  // Episode list
  const episodes = [];
  $('.episodes-links li a, .episodes-list a[href*="/watch/"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const m = href.match(/\/watch\/[^/]+\/([^/?#]+)/);
    const numText = $(a).find('span').filter((_, s) => /^\d/.test($(s).text().trim())).last().text().trim();
    const number = numText || (m ? m[1] : null);
    if (m) {
      episodes.push({
        number,
        url: abs(href),
        active: $(a).closest('li').hasClass('active'),
      });
    }
  });
  // De-dupe + keep source order
  const seenEp = new Set();
  const episodeList = episodes.filter((e) => {
    if (seenEp.has(e.url)) return false;
    seenEp.add(e.url);
    return true;
  });

  // Alternate names
  const names = [];
  $('.names .name, .other-names, .alt-names').each((_, n) => {
    const t = $(n).text().trim();
    if (t) names.push(t);
  });

  return {
    slug,
    title,
    kind: kindTag || info.kind || 'anime',
    url: `${BASE}/anime/${slug}`,
    poster,
    genres,
    story,
    rating: ratingVal ? { value: ratingVal, count: ratingCount ? parseInt(ratingCount.replace(/\D/g, ''), 10) : null } : null,
    info,
    meta,
    trailer,
    ...(names.length ? { names } : {}),
    episodeCount: episodeList.length,
    episodes: episodeList,
  };
}

module.exports = { parseAnimeDetail };
