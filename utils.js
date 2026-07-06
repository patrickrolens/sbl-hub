/* ============================================================================
   SBL Hub — shared page helpers (utils.js)
   Drop into any page with:  <script src="/utils.js"></script>
   (after /nav.js, before the page's own inline <script>). Merges what were
   originally two files (Supabase pagination + DOM/rendering helpers) since
   every page that needs one has always needed the other too.
   ============================================================================ */

// ── Supabase pagination ──────────────────────────────────────────────────────

// Function-scoped (not top-level consts) so this doesn't collide with the
// identically-named SUPABASE_URL/SUPABASE_ANON_KEY consts every page's own
// inline <script> declares — plain scripts share one global scope, and const
// redeclaration there is a hard SyntaxError, unlike function redeclaration.
function dbClient() {
  if (window.sb) return window.sb;
  const SUPABASE_URL      = "https://arypbyzeppbpbursmzcs.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_U8J3pV_KgomrWhbgoGBSUg_ttQ4d46m";
  return supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

// Fetch every row of `table` where `column` is in `values`, defeating Supabase's
// default 1000-row response cap. The IN-list is chunked, each chunk paged until a
// short page signals the end. .order('id') is required: without a deterministic
// order, .range() pagination over an unordered result set can skip/duplicate rows.
async function fetchAllIn(table, columns, column, values) {
  const IN_CHUNK = 300, PAGE = 1000, out = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) {
    const slice = values.slice(i, i + IN_CHUNK);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await dbClient().from(table).select(columns)
        .in(column, slice).order('id').range(from, from + PAGE - 1);
      if (error) throw error;
      if (data && data.length) out.push(...data);
      if (!data || data.length < PAGE) break;
    }
  }
  return out;
}

// Paginate an entire (unfiltered) table past the 1000-row response cap.
async function fetchAll(table, columns) {
  const PAGE = 1000, out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await dbClient().from(table).select(columns).order('id').range(from, from + PAGE - 1);
    if (error) throw error;
    if (data && data.length) out.push(...data);
    if (!data || data.length < PAGE) break;
  }
  return out;
}

// ── DOM / rendering helpers ──────────────────────────────────────────────────
// ASSET_BASE and POKEBALL_FALLBACK are intentionally NOT declared here — they
// stay page-owned consts (their value can legitimately differ per page, e.g.
// relative path depth) and are referenced as bare globals below, the same way
// every host page's inline script already relies on them being in scope by the
// time these functions actually run (only ever called from render code after
// an async data load, never at script-parse time).

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

function localId(id) {
  const m = String(id).match(/^(\d+)(.*)$/);
  if (!m) return id;
  const num = parseInt(m[1], 10);
  return (num >= 1000 ? String(num) : String(num).padStart(3, '0')) + m[2];
}

// iconUrl/spriteUrl/attachIconFallback/attachSpriteFallback were called two
// different ways across pages before centralizing — some passed a Pokémon
// object (mon.id), others passed the raw pokemon_id string directly. pokeId()
// accepts either so every existing call site keeps working unchanged.
function pokeId(x) { return (x && typeof x === 'object') ? x.id : x; }
function iconUrl(x)   { const id = pokeId(x); return id ? ASSET_BASE + 'icons/'   + localId(id) + '.png' : ''; }
function spriteUrl(x) { const id = pokeId(x); return id ? ASSET_BASE + 'sprites/' + localId(id) + '.png' : ''; }
function attachIconFallback(img, x) {
  img.onerror = function () {
    if (this.src.includes('/icons/')) { this.src = spriteUrl(x); }
    else { this.onerror = null; this.src = POKEBALL_FALLBACK; this.style.opacity = '.5'; }
  };
}
function attachSpriteFallback(img, x) {
  img.onerror = function () {
    if (this.src.includes('/sprites/')) { this.src = iconUrl(x); }
    else { this.onerror = null; this.src = POKEBALL_FALLBACK; this.style.opacity = '.5'; }
  };
}

// Carry the active ?season=<slug> onto internal links so navigating from a past
// season keeps you in it. Absent (current season) → links stay bare. Preserves
// any existing query/hash on the href.
const SEASON_SLUG = new URLSearchParams(location.search).get('season') || '';
function withSeason(href) {
  if (!SEASON_SLUG) return href;
  if (/^https?:\/\//i.test(href)) return href;            // external, leave alone
  const hashI = href.indexOf('#');
  const hash = hashI === -1 ? '' : href.slice(hashI);
  const base = hashI === -1 ? href : href.slice(0, hashI);
  const sep = base.indexOf('?') === -1 ? '?' : '&';
  return base + sep + 'season=' + encodeURIComponent(SEASON_SLUG) + hash;
}
function patchStaticSeasonLinks() {
  if (!SEASON_SLUG) return;
  document.querySelectorAll('a[href]').forEach(a => {
    const raw = a.getAttribute('href');
    if (!raw || raw.startsWith('#') || /^https?:\/\//i.test(raw) || raw.startsWith('mailto:')) return;
    if (/[?&]season=/.test(raw)) return;
    a.setAttribute('href', withSeason(raw));
  });
}

// ── Week cap (nav's Week Selector: ?week=N caps a page's data at week N) ────────
// Used by standings.html/statistics.html/matches.html/team.html. Kept as small,
// composable pieces rather than one do-everything function: resolveWeekCap() is
// pure and cheap to call repeatedly; applyWeekCap() is pure (just filters + measures,
// no DOM); updateWeekBanner() is the only one that touches the DOM, so a page with
// multiple data-load call sites (team.html) can filter every time but only manage
// the banner/recompute the season's true max week once.

// Reads ?week=N from the current URL. Returns an integer, or null (live/uncapped).
function resolveWeekCap() {
  const p = new URLSearchParams(location.search).get('week');
  return p && /^\d+$/.test(p) ? parseInt(p, 10) : null;
}

// Filters `matches` to weekCap by week number alone, postseason included - postseason
// happens chronologically after the regular season, so "view as of week N" should
// hide it too rather than showing bracket results that haven't happened yet from
// that vantage point. This is safe/complete for any weekCap the nav's Week Selector
// can actually produce: its dropdown only offers 1..maxRegularWeek (nav.js), and
// postseason weeks are always assigned strictly after the regular season ends
// (postseasonWeekBase() = maxRegWeek + 1), so weekCap < every postseason week always.
// trueMaxWeek stays scoped to regular season only (computed from the ORIGINAL,
// unfiltered array) - it's "how many weeks has the season had," which postseason
// isn't part of. Pure - takes no `weekCap == null` shortcut internally so
// trueMaxWeek is always accurate even when the caller isn't capping anything.
function applyWeekCap(matches, weekCap) {
  const trueMaxWeek = matches.reduce((m, x) => x.stage === 'regular' ? Math.max(m, x.week || 0) : m, 0);
  const filtered = weekCap == null ? matches : matches.filter(m => m.week <= weekCap);
  return { filtered, trueMaxWeek };
}

// Toggles the page's own #week-banner element (each page defines the div; this
// just owns the show/hide + text, matching nav.js's season-banner pattern - same
// sticky positioning, same "get back to the live view" link). Also asks nav.js to
// re-measure --nav-h, since this banner's height/visibility affects it too (see
// nav.js's setNavHeight - it finds this element generically by class).
function updateWeekBanner(weekCap, trueMaxWeek) {
  const wb = document.getElementById('week-banner');
  if (!wb) return;
  const show = weekCap != null && weekCap < trueMaxWeek;
  wb.hidden = !show;
  if (show) {
    const u = new URL(location.href);
    u.searchParams.delete('week');
    wb.innerHTML = 'Viewing Week ' + weekCap + ' of ' + trueMaxWeek
      + ' — <a href="' + escapeHtml(u.pathname + u.search + u.hash) + '">Back to live view</a>';
  }
  if (window.SBLNav && window.SBLNav.refreshLayout) window.SBLNav.refreshLayout();
}
