/* ============================================================================
   SBL Hub — shared Supabase pagination helpers (db-utils.js)
   Drop into any page with:  <script src="/db-utils.js"></script>
   (after /nav.js, before the page's own inline <script>).
   Falls back to its own client if window.sb isn't set yet, mirroring the same
   fallback every page's local `sb` const already uses — so a page that somehow
   loads without nav.js succeeding doesn't lose pagination specifically while
   everything else on the page still degrades gracefully.
   ============================================================================ */
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
