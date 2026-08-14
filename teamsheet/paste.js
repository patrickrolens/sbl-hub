/* ============================================================================
   Showdown paste parsing (tools/teamsheet/paste.js)

   pokepast.es serves a CORS-open JSON view at <url>/json returning
   { author, notes, paste } — verified Access-Control-Allow-Origin: *, so the
   admin page can fetch a submitted paste directly with no proxy. The bare HTML
   page does NOT send that header; always append /json.

   Produces the same intermediate form the image path emits, so the review grid
   and the save path never learn which door a sheet came in through.
   ============================================================================ */

function pokepasteJsonUrl(url) {
  const m = String(url).trim().match(/^https?:\/\/pokepast\.es\/([0-9a-f]+)/i);
  return m ? `https://pokepast.es/${m[1]}/json` : null;
}

/* Showdown's export format, one mon per blank-line-separated block:

     Nickname (Species) (F) @ Item
     Ability: Intimidate
     Level: 50
     Tera Type: Water
     EVs: 4 HP / 252 Atk / 252 Spe
     Adamant Nature
     - Fake Out

   Species/nickname/gender/item all live on the header line and every part
   except the species is optional, so it's parsed right-to-left. */
function parseHeaderLine(line) {
  const out = { nickname: null, species: null, item: null };
  let s = line.trim();

  const at = s.lastIndexOf(' @ ');
  if (at !== -1) { out.item = s.slice(at + 3).trim() || null; s = s.slice(0, at).trim(); }

  /* The (M)/(F) marker is still stripped even though the league does not track
     gender — leaving it attached would corrupt the species name that follows. */
  const g = s.match(/\s\((M|F)\)\s*$/);
  if (g) s = s.slice(0, g.index).trim();

  // "Nickname (Species)" — the parenthesised half is the species. Without
  // parens the whole string is the species and there is no nickname.
  const sp = s.match(/^(.*)\s\(([^()]+)\)\s*$/);
  if (sp) { out.nickname = sp[1].trim(); out.species = sp[2].trim(); }
  else { out.species = s; }
  return out;
}

function parseStatLine(line) {
  const out = {};
  for (const part of line.split('/')) {
    const m = part.trim().match(/^(\d+)\s+(HP|Atk|Def|SpA|SpD|Spe)$/i);
    if (m) out[m[2].toLowerCase()] = parseInt(m[1], 10);
  }
  return Object.keys(out).length ? out : null;
}

// Splits a paste into raw per-mon records. No dex knowledge here — resolution
// happens in pasteToIR so this stays testable on its own.
function parseShowdownPaste(text) {
  const blocks = String(text).replace(/\r/g, '').split(/\n\s*\n/)
    .map(b => b.trim()).filter(Boolean);
  return blocks.map(block => {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    const mon = Object.assign(
      { level: null, ability: null, teraType: null, nature: null, evs: null, ivs: null, moves: [] },
      parseHeaderLine(lines[0])
    );
    for (const line of lines.slice(1)) {
      let m;
      if (line.startsWith('-')) { mon.moves.push(line.replace(/^-\s*/, '').trim()); }
      else if ((m = line.match(/^Ability:\s*(.+)$/i)))   { mon.ability = m[1].trim(); }
      else if ((m = line.match(/^Level:\s*(\d+)$/i)))    { mon.level = parseInt(m[1], 10); }
      else if ((m = line.match(/^Tera Type:\s*(.+)$/i))) { mon.teraType = m[1].trim(); }
      else if ((m = line.match(/^EVs:\s*(.+)$/i)))       { mon.evs = parseStatLine(m[1]); }
      else if ((m = line.match(/^IVs:\s*(.+)$/i)))       { mon.ivs = parseStatLine(m[1]); }
      else if ((m = line.match(/^(\w+)\s+Nature$/i)))    { mon.nature = m[1]; }
    }
    return mon;
  });
}

/* Raw records -> the shared intermediate form.

   `ability` is kept as declared (the sheet/paste shows the PRE-mega ability),
   and `species` reports the resolved form, so a Scovillain holding
   Scovillainite comes out as pokemon_id 952-m with ability "Moody". Tera is
   parsed but not carried into the IR: it lives on team_pokemon.is_tera at the
   draft level in this league, not per match. */
function pasteToIR(text, index, meta) {
  const raw = parseShowdownPaste(text);
  const slots = raw.map((mon, i) => {
    const res = resolveSpecies(index, mon.species, mon.item);
    const learnset = res ? learnsetFor(index, res.declared) : [];
    const unknownMoves = mon.moves.filter(mv => learnset.length && !learnset.includes(tsNorm(mv)));
    /* Checked against the BASE form only, deliberately. A sheet always shows
       the pre-mega ability, so that is what a paste is expected to declare —
       "Charizard-Mega-Y @ Charizardite Y" should say Blaze, not Mega Charizard
       Y's Drought. Accepting the mega's own ability here was tried and removed:
       it silenced a warning on a real submission error. */
    const abilities = res ? (res.declared.abilities || []) : [];
    const abilityOk = !mon.ability || !abilities.length ||
      abilities.some(a => tsNorm(a) === tsNorm(mon.ability));
    return {
      slot: i + 1,
      pokemon_id: res ? res.id : null,
      species: res ? res.entry.name : null,
      declared_species: mon.species,
      is_mega: res ? res.isMega : false,
      nickname: mon.nickname,
      item: mon.item,
      ability: mon.ability,
      moves: mon.moves,
      level: mon.level,
      nature: mon.nature,
      evs: mon.evs,
      // Everything a paste gives is explicit, so the only doubt is whether the
      // species name resolved at all. The image path is where confidence varies.
      confidence: res ? 'high' : 'unresolved',
      warnings: [].concat(
        res ? [] : [`Unknown species "${mon.species}"`],
        abilityOk ? [] : [`"${mon.ability}" is not an ability of ${res.declared.name}`],
        unknownMoves.length ? [`Not in ${res.declared.name}'s learnset: ${unknownMoves.join(', ')}`] : []
      ),
    };
  });
  return {
    source: Object.assign({ kind: 'pokepaste' }, meta || {}),
    slots,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { pokepasteJsonUrl, parseHeaderLine, parseShowdownPaste, pasteToIR };
}
