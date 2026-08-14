/* ============================================================================
   Teamsheet set data, shared across the public pages (teamsheet-sets.js)

   match_pokemon carries what each team actually brought to a match. Since the
   teamsheet importer landed it also carries nickname, item, ability and moves —
   this file turns those rows into the shapes the pages want and renders them,
   so matches/pokemon/team/players/statistics do not each grow their own copy.

   Drop in after utils.js:  <script src="/teamsheet-sets.js"></script>

   Only rows written by a teamsheet import have detail; every row predating it
   is species-only, so every helper here treats detail as optional and reports
   how many sheets a summary is built from. A set derived from two sheets and
   one derived from forty must not look alike.
   ============================================================================ */

const TS_SET_COLS = 'match_id, team_id, pokemon_id, nickname, item, ability, moves';

// Rows carrying actual teamsheet detail. `extra` is appended as PostgREST
// filters, e.g. '&pokemon_id=eq.212-m'.
async function fetchSheetRows(extra) {
  return paginate(() => {
    let qb = dbClient().from('match_pokemon').select(TS_SET_COLS).not('ability', 'is', null);
    (extra || []).forEach(([col, op, val]) => { qb = qb.filter(col, op, val); });
    return qb.order('match_id');
  });
}

/* Collapse many sightings of one Pokémon into "what they usually run".

   Reports the most common value per field with its share, because "Focus Sash
   on 4 of 5" and "Focus Sash on 4 of 40" are different claims. Moves are counted
   individually rather than as a set: a four-move slot is rarely identical twice,
   but the individual moves repeat, and "always brings Protect" is the useful
   fact. */
function summariseSets(rows) {
  const tally = (list) => {
    const c = {};
    list.forEach(v => { if (v) c[v] = (c[v] || 0) + 1; });
    return Object.entries(c).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  const moves = [];
  rows.forEach(r => (r.moves || []).forEach(m => moves.push(m)));
  return {
    sheets: rows.length,
    items: tally(rows.map(r => r.item)),
    abilities: tally(rows.map(r => r.ability)),
    moves: tally(moves),
    nicknames: tally(rows.map(r => r.nickname)),
  };
}

// "Focus Sash" -> "Focus Sash <span>4/5</span>"
function tsShare(entry, total) {
  if (!entry) return '';
  return escapeHtml(entry[0]) +
    ' <span class="ts-share">' + entry[1] + '/' + total + '</span>';
}

/* One mon's set as a compact block. Fields the importer could not read come
   back null and are simply omitted — an empty slot is better than a confident
   blank, the same rule the importer itself follows. */
function renderSetHtml(row) {
  if (!row) return '';
  const bits = [];
  if (row.ability) bits.push('<span class="ts-ability">' + escapeHtml(row.ability) + '</span>');
  if (row.item) bits.push('<span class="ts-item">' + escapeHtml(row.item) + '</span>');
  const moves = (row.moves || []).filter(Boolean);
  const head = bits.length ? '<div class="ts-line">' + bits.join(' · ') + '</div>' : '';
  const mv = moves.length
    ? '<div class="ts-moves">' + moves.map(m => '<span>' + escapeHtml(m) + '</span>').join('') + '</div>'
    : '';
  if (!head && !mv) return '';
  return '<div class="ts-set">' + head + mv + '</div>';
}

/* Every distinct value for a single-valued field, not just the winner.

   Showing only the most common one made "Babiri Berry 1/2" a riddle: the count
   says a second item exists and then hides what it was. When a coach alternates
   between two items week to week, that IS the interesting fact, so list them all
   in frequency order. */
function tsAllShares(entries, total) {
  return entries.map(e => tsShare(e, total)).join(' <span class="ts-or">·</span> ');
}

// The "usually runs" block, from summariseSets output.
function renderTypicalHtml(sum, opts) {
  if (!sum || !sum.sheets) return '';
  const o = opts || {};
  const topMoves = sum.moves.slice(0, o.moveCount || 6);
  const parts = [];
  if (sum.abilities.length) parts.push('<div class="ts-line"><b>Ability</b> ' + tsAllShares(sum.abilities, sum.sheets) + '</div>');
  if (sum.items.length) parts.push('<div class="ts-line"><b>Item</b> ' + tsAllShares(sum.items, sum.sheets) + '</div>');
  if (topMoves.length) {
    parts.push('<div class="ts-line"><b>Moves</b></div><div class="ts-moves">' +
      topMoves.map(m => '<span>' + escapeHtml(m[0]) +
        ' <span class="ts-share">' + m[1] + '/' + sum.sheets + '</span></span>').join('') + '</div>');
  }
  return '<div class="ts-typical">' + parts.join('') +
    '<div class="ts-from">from ' + sum.sheets + ' teamsheet' + (sum.sheets === 1 ? '' : 's') + '</div></div>';
}

/* Shared styling, injected once. The pages have no build step and each carries
   its own <style>, so a single call keeps the set blocks identical everywhere
   rather than five near-copies drifting apart. */
function injectSetStyles() {
  if (document.getElementById('ts-set-styles')) return;
  const el = document.createElement('style');
  el.id = 'ts-set-styles';
  el.textContent = [
    '.ts-set{font-size:11px;line-height:1.5;color:var(--text3,#8d94a8);margin-top:3px}',
    '.ts-line{margin-bottom:2px}',
    '.ts-ability{color:var(--text2,#b6bdd0)}',
    '.ts-item{color:var(--accent,#7c6cf0)}',
    '.ts-moves{display:flex;flex-wrap:wrap;gap:3px;margin-top:2px}',
    '.ts-moves span{background:var(--bg3,#232734);border-radius:3px;padding:1px 5px;white-space:nowrap}',
    '.ts-share{opacity:.6;font-size:10px}',
    '.ts-or{opacity:.4;margin:0 1px}',
    '.ts-typical .ts-line b{color:var(--text2,#b6bdd0);font-weight:600;margin-right:4px}',
    '.ts-from{margin-top:4px;opacity:.65;font-size:10px}',
    '.ts-empty{font-size:11px;color:var(--text3,#8d94a8);opacity:.75}',
    // pokemon.html: league-wide block, then one block per team that runs it
    '.ts-league{margin-bottom:10px}',
    '.ts-team-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}',
    '.ts-team-block{background:var(--bg2,#1b1e27);border:1px solid var(--border,#333a4a);border-radius:6px;padding:8px}',
    '.ts-team-name{font-size:11px;font-weight:600;color:var(--text2,#b6bdd0);margin-bottom:4px}',
  ].join('');
  document.head.appendChild(el);
}
