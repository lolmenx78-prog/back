const cheerio = require('cheerio');
const { getPage, request, BASE } = require('../utils/fetcher');
const { abs, parseWatchUrl } = require('./home');

function cleanUrl(u) {
  if (!u) return u;
  return u.replace(/&amp;/g, '&').trim();
}

/**
 * Watch page: /watch/{slug}/{episode}
 * Extracts streaming servers (embed URLs) + direct download links.
 */
async function parseWatchPage(slug, episode) {
  const html = await getPage(`/watch/${slug}/${episode}`);
  const $ = cheerio.load(html);

  // Title — the page <title> is the cleanest source:
  // "One Piece الحلقة 1122  مترجم أون لاين - أنمي بالكوم - Blkom"
  const rawTitle = $('title').first().text().trim();
  const title =
    rawTitle
      .split(/\s+[-|]\s+أنمي بالكوم/)[0]
      .replace(/\s+مترجم أون لاين.*$/, '')
      .trim() || `${slug} — ${episode}`;

  // Anime name (without episode marker) for convenience
  const animeName = rawTitle.split(/\s+الحلقة\s+/)[0].trim() || null;

  // ── Streaming servers ──────────────────────────────────────────
  // .servers-container .slider .item .server a[data-src]
  const servers = [];
  $('.servers-container .server, .servers .server, .server').each((i, el) => {
    const $srv = $(el);
    const $a = $srv.find('a').first();
    const embed = cleanUrl($a.attr('data-src') || $a.attr('data-url') || $a.attr('href') || '');
    if (!embed || embed === '#') return;
    // class carries the fansub/provider label (e.g. "server active crunchyroll")
    const cls = ($srv.attr('class') || '')
      .split(/\s+/)
      .filter((c) => c && !['server', 'active', 'item'].includes(c));
    servers.push({
      index: servers.length,
      label: $a.text().trim() || null,
      provider: cls[0] || null,
      embedUrl: abs(embed),
      active: $srv.hasClass('active'),
      host: (() => {
        try {
          return new URL(abs(embed)).hostname;
        } catch {
          return null;
        }
      })(),
    });
  });

  // ── Direct downloads (grouped by fansub) ───────────────────────
  const downloadGroups = [];
  $('.direct-download .panel, .video-files .panel').each((_, panel) => {
    const fansub = $(panel).find('.panel-heading a, .panel-heading').first().text().trim().replace(/^ترجمة\s*:\s*/, '').trim();
    const links = [];
    $(panel)
      .find('.panel-body a[href], a.btn[href]')
      .each((_, a) => {
        const href = cleanUrl($(a).attr('href') || '');
        if (!href) return;
        const quality =
          ($(a).text().match(/(\d{3,4}p)/) || [])[1] ||
          ($(a).clone().children().remove().end().text() || '').trim() ||
          null;
        const size = $(a).find('small').first().text().trim() || null;
        links.push({ quality, size, url: abs(href), fansub: fansub || null });
      });
    if (links.length) downloadGroups.push({ fansub: fansub || null, links });
  });

  // Flatten a convenience list too
  const downloads = downloadGroups.flatMap((g) => g.links);

  const { slug: s, episode: e } = { slug, episode };

  return {
    slug: s,
    episode: e,
    title,
    animeName,
    animeUrl: `${BASE}/anime/${slug}`,
    watchUrl: `${BASE}/watch/${slug}/${episode}`,
    servers,
    serverCount: servers.length,
    downloadGroups,
    downloads,
  };
}

// ─── Sources-only (lighter payload) ──────────────────────────────
async function getSources(slug, episode) {
  const data = await parseWatchPage(slug, episode);
  return {
    slug,
    episode,
    servers: data.servers,
    downloads: data.downloads,
  };
}

/**
 * Resolve a vid4up-style embed to a direct video URL.
 * The Blkom player host (videos.vid4up.xyz) serves:
 *   /embedvideo/{id}   → player page (contains the source / download id)
 *   /video/{id}/download → direct file
 * We fetch the embed page and scrape <source src> / file / mp4 references.
 */
async function resolveEmbed(embedUrl) {
  const url = cleanUrl(embedUrl);
  let res;
  try {
    res = await request(url, {
      headers: { Referer: BASE + '/', Accept: 'text/html,*/*' },
    });
  } catch (e) {
    return { embedUrl: url, host: null, status: null, count: 0, sources: [], error: String(e.message).replace(/^Error:\s*/, '') };
  }
  const body = await res.text();

  const sources = [];
  const push = (u, label) => {
    const clean = cleanUrl(u);
    if (clean && !sources.some((s) => s.url === clean)) sources.push({ url: clean, quality: label || null });
  };

  // <source src="..."> and file: "..." patterns
  for (const m of body.matchAll(/<source[^>]+src=["']([^"']+)["'][^>]*(?:label|res|size)=["']?([^"'>\s]+)?/gi)) {
    push(m[1], m[2]);
  }
  for (const m of body.matchAll(/(?:file|src|source)\s*:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/gi)) {
    push(m[1]);
  }
  // Direct mp4/m3u8 URLs anywhere in the page
  for (const m of body.matchAll(/https?:\/\/[^"'\s<>]+\.(?:mp4|m3u8)(?:\?[^"'\s<>]*)?/gi)) {
    push(m[0]);
  }
  // download links on the same host
  for (const m of body.matchAll(/https?:\/\/[^"'\s<>]+\/video\/[^"'\s<>]+\/download/gi)) {
    push(m[0], 'download');
  }

  return {
    embedUrl: url,
    host: (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return null;
      }
    })(),
    status: res.status,
    count: sources.length,
    sources,
  };
}

module.exports = { parseWatchPage, getSources, resolveEmbed };
