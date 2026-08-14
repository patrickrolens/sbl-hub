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
    /* .order('id'), not match_id: paginate() pages with .range(), and twelve rows
       share a match_id (six a side), so ordering on it leaves ties in undefined
       order and a page boundary can drop or repeat rows. The primary key is the
       only unique column here — the same reason fetchAll/fetchAllIn order by id.
       Harmless at today's row count, wrong once a season passes 1000 sheet rows,
       which a full 14-team season does. */
    return qb.order('id');
  });
}

/* Collapse many sightings of one Pokémon into "what they usually run".

   Reports the most common value per field with its share, because "Focus Sash
   on 4 of 5" and "Focus Sash on 4 of 40" are different claims. Moves are counted
   individually rather than as a set: a four-move slot is rarely identical twice,
   but the individual moves repeat, and "always brings Protect" is the useful
   fact. */
function summarizeSets(rows) {
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

/* The "usually runs" block, from summarizeSets output.

   `opts.cls` lets a host page supply its own class names so the block adopts
   that page's existing visual language instead of importing a second one. The
   team page's roster popover already has micro-labels, purple ability pills and
   neutral move chips; passing those in makes this section look native there
   while pokemon.html keeps the default. */
const TS_DEFAULT_CLS = {
  wrap: 'ts-typical', label: 'ts-line', row: 'ts-moves',
  chip: '', abilityChip: '', share: 'ts-share', from: 'ts-from',
};

function renderTypicalHtml(sum, opts) {
  if (!sum || !sum.sheets) return '';
  const o = opts || {};
  const c = Object.assign({}, TS_DEFAULT_CLS, o.cls || {});
  const topMoves = sum.moves.slice(0, o.moveCount || 6);

  /* All three fields render as the same kind of row. Abilities and items used to
     be plain labeled text while moves were chips, which read as three different
     kinds of information when they are the same kind — a value, its count, and
     possibly an alternative. */
  const row = (entries, chipCls) => '<div class="' + c.row + '">' + entries.map(e =>
    '<span' + (chipCls ? ' class="' + chipCls + '"' : '') + '>' + escapeHtml(e[0]) +
    ' <span class="' + c.share + '">' + e[1] + '/' + sum.sheets + '</span></span>').join('') + '</div>';
  const label = t => '<div class="' + c.label + '">' + (c.label === 'ts-line' ? '<b>' + t + '</b>' : t) + '</div>';

  /* Inline "Ability  Value 4/5" for single-valued fields, chips for moves. That
     is the default because it is what pokemon.html already looked like; a host
     page wanting everything as chips passes cls.inlineSingles = false, which is
     what the team popover does to match its own card language. */
  const inline = (entries, name) => '<div class="' + c.label + '"><b>' + name + '</b> ' +
    entries.map(e => tsShare(e, sum.sheets)).join(' <span class="ts-or">·</span> ') + '</div>';

  const parts = [];
  const asChips = c.inlineSingles === false;

  /* Nicknames are opt-in (opts.showNicknames). They are the one field here that
     says nothing about how the Pokémon is built, so a page showing a set to
     answer "what does it run" does not want them — but on a roster card they
     are the whole point, since the nickname is what the opponent actually saw.
     Rendered first: it is a name, and names go above the thing they name. */
  if (o.showNicknames && sum.nicknames && sum.nicknames.length) {
    parts.push(asChips
      ? label('Nickname') + row(sum.nicknames, c.chip)
      : inline(sum.nicknames, 'Nickname'));
  }
  if (sum.abilities.length) {
    parts.push(asChips ? label('Ability') + row(sum.abilities, c.abilityChip) : inline(sum.abilities, 'Ability'));
  }
  if (sum.items.length) {
    parts.push(asChips ? label('Item') + row(sum.items, c.chip) : inline(sum.items, 'Item'));
  }
  if (topMoves.length) parts.push(label('Moves') + row(topMoves, c.chip));
  return '<div class="' + c.wrap + '">' + parts.join('') +
    '<div class="' + c.from + '">from ' + sum.sheets + ' teamsheet' + (sum.sheets === 1 ? '' : 's') + '</div></div>';
}

/* Shared styling, injected once. The pages have no build step and each carries
   its own <style>, so a single call keeps the set blocks identical everywhere
   rather than five near-copies drifting apart.

   Colors come from tokens.css via bare var() with no fallback, the same way
   the rest of the site writes them. A fallback here would be a second copy of
   the palette that no one maintains — the ones this used to carry had all
   drifted a shade or two from the real tokens. */
function injectSetStyles() {
  if (document.getElementById('ts-set-styles')) return;
  const el = document.createElement('style');
  el.id = 'ts-set-styles';
  el.textContent = [
    '.ts-set{font-size:11px;line-height:1.5;color:var(--text3);margin-top:3px}',
    '.ts-line{margin-bottom:2px}',
    '.ts-ability{color:var(--text2)}',
    '.ts-item{color:var(--accent)}',
    '.ts-moves{display:flex;flex-wrap:wrap;gap:3px;margin-top:2px;margin-bottom:4px}',
    '.ts-moves span{background:var(--bg3);border-radius:3px;padding:1px 5px;white-space:nowrap}',
    '.ts-share{opacity:.6;font-size:10px}',
    '.ts-or{opacity:.4;margin:0 1px}',
    '.ts-typical .ts-line b{color:var(--text2);font-weight:600;margin-right:4px}',
    // Color stated rather than inherited: inside .ts-set it already resolves
    // to text3, but used on its own (statistics' card footer) it inherited full
    // --text and read as body copy instead of a footnote.
    '.ts-from{margin-top:4px;opacity:.65;font-size:10px;color:var(--text3)}',
    '.ts-empty{font-size:11px;color:var(--text3);opacity:.75}',
    // pokemon.html: league-wide block, then one block per team that runs it
    '.ts-league{margin-bottom:10px}',
    '.ts-team-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}',
    '.ts-team-block{background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:8px}',
    '.ts-team-name{font-size:11px;font-weight:600;color:var(--text2);margin-bottom:4px}',
  ].join('');
  document.head.appendChild(el);
}
