const API = '/api';
let currentView = 'home';
const loading = document.getElementById('loading');
const content = document.getElementById('content');
const cfBanner = document.getElementById('cf-banner');
const historyStack = [];

document.querySelectorAll('nav a[data-page]').forEach((a) =>
  a.addEventListener('click', (e) => {
    e.preventDefault();
    currentView = a.dataset.page;
    document.querySelectorAll('nav a').forEach((l) => l.classList.remove('active'));
    a.classList.add('active');
    historyStack.length = 0;
    route();
  })
);

function route() {
  cfBanner.classList.add('hidden');
  switch (currentView) {
    case 'home': return loadHome();
    case 'anime': return loadList('anime', {});
    case 'movies': return loadList('movie', {});
    case 'ova': return loadList('ova', {});
    case 'search': return showSearch();
    case 'settings': return showSettings();
    case 'docs': return showDocs();
  }
}

async function api(p) {
  loading.classList.remove('hidden');
  try {
    const r = await fetch(API + p);
    const j = await r.json();
    if (!j.ok) {
      if (j.code === 'CF_CHALLENGE') showCfBanner();
      throw new Error(j.error || 'request failed');
    }
    return j;
  } catch (e) {
    content.innerHTML = `<div class="error">خطأ: ${e.message}</div>`;
    return null;
  } finally {
    loading.classList.add('hidden');
  }
}

function showCfBanner() {
  cfBanner.classList.remove('hidden');
  cfBanner.innerHTML = `<b>Cloudflare يحجب الطلب.</b> الموقع محمي بتحدّي "Just a moment".
    افتح <a href="https://animeblkom.net" target="_blank">animeblkom.net</a> في المتصفح، انسخ كوكي
    <code>cf_clearance</code> وأدخله من صفحة <a onclick="gotoSettings()">الإعدادات</a>.`;
}
window.gotoSettings = function () {
  currentView = 'settings';
  document.querySelectorAll('nav a').forEach((l) => l.classList.toggle('active', l.dataset.page === 'settings'));
  showSettings();
};

function goBack() {
  if (historyStack.length) historyStack.pop()();
  else route();
}

function esc(s) {
  return (s || '').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
}

const img = (u) => (u ? `/api/proxy/image?url=${encodeURIComponent(u)}` : '');

// ─── Cards ───────────────────────────────────────────────
function renderContentCard(item) {
  const rating = item.rating
    ? `<div class="card-rating">★ ${item.rating.value}</div>`
    : '';
  return `<div class="card" onclick="loadAnimeDetail('${esc(item.slug)}')">
    <div class="card-thumb">
      <img src="${img(item.poster)}" alt="${esc(item.name)}" loading="lazy" onerror="this.style.opacity=0">
      ${rating}
    </div>
    <div class="card-info"><h3>${esc(item.name)}</h3></div>
  </div>`;
}

function renderEpisodeCard(item) {
  const ep = item.episode ? `<div class="card-ep">حلقة ${item.episode}</div>` : '';
  const last = item.isLast ? `<div class="card-badge">الأخيرة</div>` : '';
  return `<div class="card" onclick="loadWatch('${esc(item.slug)}','${esc(item.episode)}')">
    <div class="card-thumb">
      <img src="${img(item.poster)}" alt="${esc(item.name)}" loading="lazy" onerror="this.style.opacity=0">
      ${ep}${last}
    </div>
    <div class="card-info"><h3>${esc(item.name)}</h3></div>
  </div>`;
}

// ─── Home ────────────────────────────────────────────────
async function loadHome() {
  const r = await api('/home');
  if (!r) return;
  let h = '';
  if (r.featured && r.featured.length) {
    h += '<div class="section-title">الأنميات المتجددة</div><div class="grid">';
    r.featured.forEach((i) => (h += renderEpisodeCard(i)));
    h += '</div>';
  }
  if (r.latestEpisodes && r.latestEpisodes.length) {
    h += '<div class="section-title">آخر الحلقات المضافة</div><div class="grid">';
    r.latestEpisodes.forEach((i) => (h += renderEpisodeCard(i)));
    h += '</div>';
  }
  (r.sections || []).forEach((sec) => {
    h += `<div class="section-title">${esc(sec.title)}</div><div class="grid">`;
    sec.items.forEach((i) => (h += renderContentCard(i)));
    h += '</div>';
  });
  content.innerHTML = h || '<div class="empty">لا يوجد محتوى</div>';
}

// ─── Listings ────────────────────────────────────────────
const LIST_TITLES = { anime: 'قائمة الأنمي', movie: 'أفلام الأنمي', ova: 'OVA', ona: 'ONA', special: 'حلقات خاصة' };
async function loadList(type, filters) {
  window._listType = type;
  window._listFilters = filters;
  const qs = new URLSearchParams(filters).toString();
  const r = await api(`/list/${type}` + (qs ? `?${qs}` : ''));
  if (!r) return;
  let h = `<div class="section-title">${LIST_TITLES[type] || type}</div>`;
  h += `<div class="filters">
    <input type="text" placeholder="بحث ضمن القائمة..." value="${esc(filters.query || '')}" onkeydown="if(event.key==='Enter')refilter('query',this.value)">
    <input type="text" placeholder="سنة (مثال 2024)" value="${esc(filters.year || '')}" onkeydown="if(event.key==='Enter')refilter('year',this.value)">
    <input type="text" placeholder="تصنيف (action)" value="${esc(filters.genres || '')}" onkeydown="if(event.key==='Enter')refilter('genres',this.value)">
  </div>`;
  h += '<div class="grid">';
  r.items.forEach((i) => (h += renderContentCard(i)));
  h += '</div>';
  if (!r.items.length) h += '<div class="empty">لا توجد نتائج</div>';
  h += pagination(r.page, r.totalPages, 'gotoListPage');
  content.innerHTML = h;
}
window.refilter = function (key, val) {
  const f = { ...(window._listFilters || {}) };
  if (val) f[key] = val;
  else delete f[key];
  delete f.page;
  loadList(window._listType, f);
};
window.gotoListPage = function (pg) {
  loadList(window._listType, { ...(window._listFilters || {}), page: pg });
};

// ─── Anime detail ────────────────────────────────────────
async function loadAnimeDetail(slug) {
  historyStack.push(() => route());
  const r = await api(`/anime/${encodeURIComponent(slug)}`);
  if (!r) return;
  const d = r.data;
  let h = '<button class="back-btn" onclick="goBack()">→ رجوع</button>';
  h += `<div class="detail-hero">`;
  if (d.poster) h += `<div class="detail-hero-bg" style="background-image:url('${img(d.poster)}')"></div>`;
  h += `<div class="detail-poster"><img src="${img(d.poster)}" onerror="this.style.display='none'"></div>`;
  h += '<div class="detail-info">';
  h += `<h1>${esc(d.title)}</h1>`;
  if (d.rating) h += `<div class="rating-big">★ ${d.rating.value} <span style="color:var(--text2);font-size:.8rem">(${d.rating.count || 0} تقييم)</span></div>`;
  h += '<div class="meta-grid">';
  const info = d.info || {};
  if (info.status) h += `<span class="meta-item"><b>الحالة:</b> ${esc(info.status)}</span>`;
  if (info.releaseDate) h += `<span class="meta-item"><b>الإنتاج:</b> ${esc(info.releaseDate)}</span>`;
  if (info.ageRating) h += `<span class="meta-item"><b>التصنيف:</b> ${esc(info.ageRating)}</span>`;
  if (info.episodeCount) h += `<span class="meta-item"><b>الحلقات:</b> ${esc(info.episodeCount)}</span>`;
  const studio = d.meta && d.meta.studio;
  if (studio) {
    const s = Array.isArray(studio) ? studio.map((x) => x.name).join(', ') : studio;
    h += `<span class="meta-item"><b>الاستوديو:</b> ${esc(s)}</span>`;
  }
  h += `<span class="meta-item"><b>عدد الحلقات:</b> ${d.episodeCount}</span>`;
  h += '</div>';
  if (d.genres && d.genres.length) {
    h += '<div class="meta-tags">';
    d.genres.forEach((g) => (h += `<span class="meta-tag">${esc(g)}</span>`));
    h += '</div>';
  }
  if (d.trailer) {
    h += `<div class="trailer-box"><iframe src="${d.trailer.embedUrl}" allowfullscreen></iframe></div>`;
  }
  if (d.story) h += `<p class="synopsis">${esc(d.story)}</p>`;
  h += '</div></div>';
  if (d.episodes && d.episodes.length) {
    h += '<div class="section-title">الحلقات</div><div class="ep-grid">';
    d.episodes.forEach((ep) => {
      h += `<button class="ep-btn" onclick="loadWatch('${esc(d.slug)}','${esc(ep.number)}')">${esc(ep.number)}</button>`;
    });
    h += '</div>';
  }
  content.innerHTML = h;
}

// ─── Watch (player) ──────────────────────────────────────
async function loadWatch(slug, episode) {
  historyStack.push(() => loadAnimeDetail(slug));
  const r = await api(`/watch/${encodeURIComponent(slug)}/${encodeURIComponent(episode)}?resolve=1`);
  if (!r) return;
  const d = r.data;
  let h = '<button class="back-btn" onclick="goBack()">→ رجوع</button>';
  h += `<h1 style="font-size:1.2rem;margin-bottom:6px;direction:ltr;text-align:right">${esc(d.title)}</h1>`;
  h += `<div style="color:var(--text2);margin-bottom:14px;font-size:.88rem;cursor:pointer" onclick="loadAnimeDetail('${esc(d.slug)}')">عرض صفحة الأنمي ←</div>`;
  h += '<div class="player-box"><div class="player-placeholder">اختر سيرفر لبدء المشاهدة</div></div>';

  if (d.servers && d.servers.length) {
    h += '<div class="servers-section"><div class="servers-label">سيرفرات المشاهدة</div><div class="servers-grid">';
    d.servers.forEach((s, i) => {
      const payload = esc(JSON.stringify({ embedUrl: s.embedUrl, sources: s.sources || [] }));
      h += `<button class="server-btn" data-srv='${payload}' onclick="playServer(this)">${esc(s.label || s.provider || 'سيرفر ' + (i + 1))}</button>`;
    });
    h += '</div></div>';
  } else {
    h += '<div class="empty">لا توجد سيرفرات متاحة لهذه الحلقة</div>';
  }

  if (d.downloadGroups && d.downloadGroups.length) {
    h += '<div class="section-title">روابط التحميل</div>';
    d.downloadGroups.forEach((g) => {
      h += `<div class="dl-group"><div class="dl-group-title">ترجمة: ${esc(g.fansub || '—')}</div><div class="dl-links">`;
      g.links.forEach((l) => {
        h += `<a class="dl-btn" href="${l.url}" target="_blank" rel="noopener">
          <span class="q-badge">${esc(l.quality || '?')}</span>
          ${l.size ? `<span class="dl-size">${esc(l.size)}</span>` : ''}
        </a>`;
      });
      h += '</div></div>';
    });
  }
  content.innerHTML = h;
}

window.playServer = function (btn) {
  document.querySelectorAll('.server-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  const box = document.querySelector('.player-box');
  let data = {};
  try { data = JSON.parse(btn.dataset.srv); } catch {}
  const mp4 = (data.sources || []).find((s) => /\.mp4/.test(s.url));
  if (mp4) {
    box.innerHTML = `<video src="${mp4.url}" controls autoplay></video>`;
  } else if (data.embedUrl) {
    box.innerHTML = `<iframe src="${data.embedUrl}" allowfullscreen allow="autoplay; encrypted-media; fullscreen" referrerpolicy="no-referrer"></iframe>`;
  } else {
    box.innerHTML = '<div class="player-placeholder">تعذّر فتح السيرفر — جرّب سيرفرًا آخر</div>';
  }
};

// ─── Search ──────────────────────────────────────────────
function showSearch() {
  content.innerHTML = `<div class="section-title">بحث</div>
  <div class="search-box"><input type="text" id="si" placeholder="ابحث بالاسم (romaji/إنجليزي)..." onkeydown="if(event.key==='Enter')doSearch()"><button onclick="doSearch()">بحث</button></div>
  <div id="sr"></div>`;
  setTimeout(() => document.getElementById('si')?.focus(), 100);
}
async function doSearch() {
  const q = document.getElementById('si')?.value;
  if (!q?.trim()) return;
  const r = await api(`/search?q=${encodeURIComponent(q)}`);
  if (!r) return;
  let h = '<div class="grid">';
  r.items.forEach((i) => (h += i.episode ? renderEpisodeCard(i) : renderContentCard(i)));
  h += '</div>';
  if (!r.items?.length) h = '<div class="empty">لا توجد نتائج</div>';
  (document.getElementById('sr') || content).innerHTML = h;
}

// ─── Settings (cf_clearance) ─────────────────────────────
async function showSettings() {
  let status = null;
  try { status = await (await fetch(`${API}/status`)).json(); } catch {}
  const ok = status && status.hasClearance;
  content.innerHTML = `<div class="section-title">إعدادات — تجاوز Cloudflare</div>
  <div class="settings-card">
    <h2>كوكي cf_clearance</h2>
    <p>موقع animeblkom.net محمي بتحدّي Cloudflare المُدار. عند ظهور خطأ الحجب، أدخل كوكي <code>cf_clearance</code> من متصفحك:</p>
    <ol>
      <li>افتح <a href="https://animeblkom.net" target="_blank" style="color:var(--accent2)">animeblkom.net</a> وتجاوز فحص "Just a moment".</li>
      <li>DevTools (F12) ← Application ← Cookies ← animeblkom.net</li>
      <li>انسخ قيمة <code>cf_clearance</code> والصقها بالأسفل.</li>
      <li>مهم: استخدم Chrome (نفس User-Agent الذي يستخدمه الـ API).</li>
    </ol>
    <textarea id="cf-input" placeholder="cf_clearance=XXXXXXXX...">${''}</textarea>
    <button class="btn-primary" onclick="saveCookies()">حفظ الكوكيز</button>
    <div class="status-line ${ok ? 'status-ok' : 'status-bad'}">
      الحالة: ${ok ? '✓ كوكي cf_clearance مُخزّن' : '✗ لا يوجد كوكي مُخزّن'}
    </div>
    <div id="save-result" class="status-line"></div>
  </div>`;
}
window.saveCookies = async function () {
  const val = document.getElementById('cf-input')?.value?.trim();
  const out = document.getElementById('save-result');
  if (!val) { out.innerHTML = '<span class="status-bad">أدخل قيمة الكوكي أولًا</span>'; return; }
  const cookies = val.includes('=') ? val : `cf_clearance=${val}`;
  try {
    const r = await fetch(`${API}/set-cookies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies }),
    });
    const j = await r.json();
    out.innerHTML = j.ok
      ? '<span class="status-ok">✓ تم الحفظ. جرّب الرئيسية الآن.</span>'
      : `<span class="status-bad">فشل: ${j.error}</span>`;
  } catch (e) {
    out.innerHTML = `<span class="status-bad">خطأ: ${e.message}</span>`;
  }
};

// ─── Docs ────────────────────────────────────────────────
function showDocs() {
  content.innerHTML = `<div class="section-title">AnimeBlkom API — التوثيق</div>
  <p style="color:#c9bdb1;margin-bottom:20px;line-height:1.8">واجهة برمجية لموقع أنمي بالكوم. HTML scraping عبر cheerio + تجاوز Cloudflare ببصمة Chrome TLS (wreq-js) واحتياطيًا كوكي cf_clearance.</p>
  ${[
    ['الرئيسية', 'GET /api/home', 'آخر الحلقات + الأنميات المتجددة + أقسام'],
    ['قائمة', 'GET /api/list/:type', 'anime, movie, ova, ona, special (+فلاتر)'],
    ['أفلام', 'GET /api/movies?page=1', 'أفلام الأنمي'],
    ['بحث', 'GET /api/search?q=one+piece', 'بحث في الأنمي والأفلام'],
    ['تفاصيل', 'GET /api/anime/:slug', 'ميتاداتا + تقييم + تريلر + كل الحلقات'],
    ['مشاهدة', 'GET /api/watch/:slug/:episode', 'سيرفرات + تحميل (?resolve=1)'],
    ['سيرفرات', 'GET /api/sources/:slug/:episode', 'سيرفرات وتحميل فقط'],
    ['حل مشغّل', 'GET /api/resolve?url=EMBED', 'embed → mp4/m3u8'],
    ['صور', 'GET /api/proxy/image?url=...', 'بروكسي صور'],
    ['كوكيز CF', 'POST /api/set-cookies', 'تخزين cf_clearance'],
    ['الحالة', 'GET /api/status', 'حالة Cloudflare والكوكيز'],
  ].map(([t, e, d]) => `<div class="docs-section"><div class="docs-title">${t}</div><div class="docs-endpoint">${e}</div><div class="docs-desc">${d}</div></div>`).join('')}`;
}

function pagination(pg, total, fn) {
  if (!total || total <= 1) return '';
  let h = '<div class="pagination">';
  if (pg > 1) h += `<button onclick="${fn}(${pg - 1})">السابق</button>`;
  h += `<span class="page-info">صفحة ${pg} من ${total}</span>`;
  if (pg < total) h += `<button onclick="${fn}(${pg + 1})">التالي</button>`;
  return h + '</div>';
}

window.loadAnimeDetail = loadAnimeDetail;
window.loadWatch = loadWatch;
window.doSearch = doSearch;
window.goBack = goBack;

loadHome();
