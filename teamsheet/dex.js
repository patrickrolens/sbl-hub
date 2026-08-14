/* ============================================================================
   Dex index + species resolution (tools/teamsheet/dex.js)

   Turns pokemon.json into lookup structures and resolves a declared species
   name (from a paste) or a candidate set (from an image) to a pokemon_id in
   the same id space team_pokemon uses — confirmed live: 212-m, 678-f, 670-e,
   128-a, 1017-w all appear there verbatim.
   ============================================================================ */

// Loose key: case/space/punctuation-insensitive. "Tauros-Paldea-Aqua",
// "tauros paldea aqua" and "TaurosPaldeaAqua" all collapse to one key.
function tsNorm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

/* Showdown's species names and this dex's names diverge in a few places, and
   the differences are irregular enough that pattern rules would be guesswork.
   An explicit table is small, auditable, and fails loudly when a new form
   appears rather than silently resolving to the wrong mon.

   Every entry here is a base form whose dex name carries a form label that
   Showdown omits. Deriving them by splitting on the hyphen is not an option:
   18 base-id entries have hyphenated names, but 11 of those hyphens are part
   of the actual name (Ho-Oh, Porygon-Z, Jangmo-o, Kommo-o, Ting-Lu, Chien-Pao,
   Wo-Chien, Chi-Yu), and Nidoran-F/Nidoran-M would both collapse onto
   "nidoran". Only these seven are genuine form labels. */
const TS_SPECIES_ALIASES = {
  urshifu: '892',                  // dex calls the Single Strike base "Urshifu-SS"
  urshifusinglestrike: '892',
  urshifurapidstrike: '892-r',     // dex: "Urshifu-RS"
  meowstic: '678',                 // dex: "Meowstic-M"
  meowsticmale: '678',
  indeedee: '876',                 // dex: "Indeedee-M"
  indeedeemale: '876',
  basculegion: '902',              // dex: "Basculegion-M"
  oinkologne: '916',               // dex: "Oinkologne-M"
  oricorio: '741',                 // dex: "Oricorio-Baile"
  lycanroc: '745',                 // dex: "Lycanroc-Midday"
};

function buildDexIndex(pokemonArray) {
  const byId = new Map(), byNorm = new Map();
  for (const p of pokemonArray) {
    byId.set(p.id, p);
    const k = tsNorm(p.name);
    if (!byNorm.has(k)) byNorm.set(k, p);
  }
  for (const [alias, id] of Object.entries(TS_SPECIES_ALIASES)) {
    const e = byId.get(id);
    if (e && !byNorm.has(alias)) byNorm.set(alias, e);
  }

  /* Showdown names megas on the species line — "Charizard-Mega-Y",
     "Venusaur-Mega" — whereas the dex calls them "Mega Charizard Y". Without
     these, any paste that spells the mega out fails to resolve at all rather
     than falling back to the base form. Generated from the dex so new megas are
     picked up automatically. */
  for (const p of pokemonArray) {
    if (!/^Mega /.test(p.name)) continue;
    const rest = p.name.slice(5);                       // "Charizard Y", "Meowstic-M"
    const vm = rest.match(/^(.*?)\s+([XY])$/);          // trailing X/Y variant
    const base = vm ? vm[1] : rest;
    const variant = vm ? vm[2] : '';
    const stem = base.split('-')[0];                    // drop a form label
    [base, stem].forEach(b => {
      const alias = tsNorm(b + 'mega' + variant);
      if (!byNorm.has(alias)) byNorm.set(alias, p);
    });
  }
  return { byId, byNorm, all: pokemonArray };
}

/* Split a held item into a mega stone stem and its X/Y variant.
   "Scizorite" -> { stem: 'scizorite', variant: '' }
   "Charizardite Y" -> { stem: 'charizardite', variant: 'y' }
   Charizard and Mewtwo each have two megas, so the variant is what picks
   between 006-mx and 006-my; ignoring it resolves to a nonexistent 006-m. */
function megaStoneParts(itemName) {
  const n = tsNorm(itemName);
  const m = n.match(/^(.*ite)([xy])?$/);
  return m ? { stem: m[1], variant: m[2] || '' } : null;
}

// Base dex number of an id: "212-m" -> "212", "1017-w" -> "1017".
function baseId(id) { return String(id).split('-')[0]; }

/* Megas whose PRE-mega form is not the plain base id. Everything else megas
   from its base (Mega Venusaur from Venusaur), but these come from a specific
   alternate form, and using the plain base gives the wrong learnset — Floette
   cannot learn Light of Ruin, Floette-Eternal can. */
const TS_PRE_MEGA = {
  '670-m': '670-e',      // Mega Floette <- Floette-Eternal
  '678-mf': '678-f',     // Mega Meowstic-F <- Meowstic-F
};

/* Is this id a mega? The suffix is "-m", but also "-mx"/"-my" for the two
   species with an X and a Y mega, and "-mf" for Mega Meowstic-F. Testing only
   /-m$/ silently excluded all of those, so Mega Charizard Y was matched against
   Drought instead of Charizard's Blaze — and a sheet never shows the mega's
   ability. The name check still matters because 479-m is Rotom-Mow and 745-m is
   Lycanroc-Midnight, neither of which is a mega. */
function isMegaId(id, index) {
  const e = index.byId.get(id);
  return !!(e && /-m[a-z]?$/.test(String(id)) && /^Mega /.test(e.name));
}

// The form a sheet actually renders for this id: the pre-mega form for a mega,
// otherwise the mon itself.
function preMegaEntry(index, id) {
  if (!isMegaId(id, index)) return index.byId.get(id);
  const mapped = TS_PRE_MEGA[id];
  return index.byId.get(mapped || baseId(id)) || index.byId.get(id);
}

/* A team sheet shows the PRE-mega sprite and ability — Scovillain reads "Moody",
   not Mega Scovillain's "Spicy Spray" — so the mega is signalled only by the
   held item. Rather than classify stones in the open (the mega roster shifts
   between generations and several are newer than any list I could hardcode),
   this asks a much easier 1-vs-1 question: is this item plausibly THIS
   species' stone? Stones are the base name with an "-ite" ending, elided
   irregularly (Scizor/Scizorite, Floette/Floettite, Staraptor/Staraptite), so
   a shared prefix plus the suffix is enough. */
function megaFormFor(itemName, speciesEntry, index) {
  const parts = megaStoneParts(itemName);
  if (!parts) return null;
  const target = index.byId.get(baseId(speciesEntry.id) + '-m' + parts.variant);
  // The "-m" suffix means mega everywhere except 479-m (Rotom-Mow) and 745-m
  // (Lycanroc-Midnight), where it abbreviates the form name instead. Trusting
  // the id shape alone would resolve a Rotom holding any "-ite" item to
  // Rotom-Mow, so the name is what actually decides.
  if (!target || !/^Mega /.test(target.name)) return null;
  const speciesNorm = tsNorm(speciesEntry.name.replace(/^Mega /, '').split('-')[0]);
  const shared = speciesNorm.split('')
    .reduce((acc, ch, i) => (parts.stem[i] === ch && acc === i ? i + 1 : acc), 0);
  return shared >= 4 ? target : null;
}

/* Resolve a declared species + item to the id that should be stored.
   Returns { id, entry, declared, isMega } — `declared` keeps the pre-mega
   entry so callers can validate the sheet's ability against the base form's
   ability list, which is what the sheet actually shows. */
function resolveSpecies(index, declaredName, itemName) {
  let declared = index.byNorm.get(tsNorm(declaredName));
  if (!declared) return null;

  /* A paste may name the mega outright ("Charizard-Mega-Y"). Report the base
     form as `declared` regardless, because that is what a sheet shows and what
     the ability/learnset checks must run against. */
  if (/^Mega /.test(declared.name)) {
    // preMegaEntry, not baseId: Mega Floette's pre-mega form is Floette-Eternal,
    // whose learnset is what a sheet's moves must be checked against.
    const base = preMegaEntry(index, declared.id);
    return { id: declared.id, entry: declared, declared: base || declared, isMega: true };
  }

  if (itemName) {
    const mega = megaFormFor(itemName, declared, index);
    if (mega) return { id: mega.id, entry: mega, declared, isMega: true };
  }
  return { id: declared.id, entry: declared, declared, isMega: false };
}

// Megas inherit the base form's learnset when the dex doesn't give them one
// (only 957 of 1270 entries carry fullLearnset).
function learnsetFor(index, entry) {
  if (entry.fullLearnset && entry.fullLearnset.length) return entry.fullLearnset;
  const base = index.byId.get(baseId(entry.id));
  return (base && base.fullLearnset) || [];
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { tsNorm, buildDexIndex, baseId, isMegaId, preMegaEntry, megaStoneParts, megaFormFor, resolveSpecies, learnsetFor };
}
