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
