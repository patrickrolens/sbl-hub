/* ============================================================================
   Teamsheet import API (teamsheet/import.js)

   One entry point per input kind, both returning the same slot shape so the
   review grid and the save path never learn which door a sheet came in through.

   Load order: dex.js, paste.js, segment.js, type-icons.js, species.js, then this.
   Everything is exposed under a single `Teamsheet` global — the site has no
   build step and plain scripts share one global scope, where a duplicated
   top-level `const` is a hard SyntaxError rather than a shadowed variable.
   ============================================================================ */

window.Teamsheet = (function () {

  // Sheets render the PRE-mega form: base sprite, base ability, base types,
  // with the held stone as the only indication. So candidate matching uses the
  // base form's types while the id that gets stored stays the mega's.
  function displayEntry(index, id) { return preMegaEntry(index, id); }

  // roster ids -> what identifySpecies() needs
  function candidatesFromRoster(index, rosterIds) {
    return rosterIds.map(id => {
      const e = displayEntry(index, id);
      return { id, types: e ? [e.type1, e.type2].filter(Boolean) : [] };
    }).filter(c => c.types.length);
  }

  function emptySlot(n) {
    return {
      slot: n, pokemon_id: null, species: null, declared_species: null,
      is_mega: false, nickname: null, item: null, ability: null,
      moves: [], confidence: 'unknown', warnings: [],
    };
  }

  /* ---- pokepaste ---------------------------------------------------------
     pokepast.es serves a CORS-open JSON view at <url>/json; the bare HTML page
     does not send the header, so the /json suffix is required. */
  async function fromPokepaste(url, index) {
    const jsonUrl = pokepasteJsonUrl(url);
    if (!jsonUrl) throw new Error('Not a pokepaste URL.');
    const res = await fetch(jsonUrl);
    if (!res.ok) throw new Error('Could not fetch paste (HTTP ' + res.status + ').');
    const meta = await res.json();
    return pasteToIR(meta.paste, index, { ref: url, author: meta.author, notes: meta.notes });
  }

  // Same parser, for when someone pastes the raw Showdown text instead of a link.
  function fromPasteText(text, index) {
    return pasteToIR(text, index, { ref: null });
  }

  /* ---- image -------------------------------------------------------------
     Species comes from the type icons, constrained to the team's active roster.
     Where the icons are not readable the slot is returned blank rather than
     guessed: the admin reviews every import, and a plausible wrong species has
     to be noticed to be fixed, whereas a blank is self-announcing. */
  // Full-resolution copy rotated by `deg`, used as the source for every later
  // crop so panel coordinates and the pixels they point at stay in agreement.
  function rotated(img, w, h, deg) {
    if (!deg) return { source: img, width: w, height: h };
    const swap = deg === 90 || deg === 270;
    const cv = document.createElement('canvas');
    cv.width = swap ? h : w;
    cv.height = swap ? w : h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.translate(cv.width / 2, cv.height / 2);
    ctx.rotate(deg * Math.PI / 180);
    ctx.drawImage(img, -w / 2, -h / 2);
    return { source: cv, width: cv.width, height: cv.height };
  }

  async function fromImage(imgOrBlob, index, rosterIds, opts) {
    opts = opts || {};
    const raw = imgOrBlob instanceof Image ? imgOrBlob : await blobToImage(imgOrBlob);
    const rawW = raw.naturalWidth || raw.width, rawH = raw.naturalHeight || raw.height;

    const candidates = candidatesFromRoster(index, rosterIds);

    /* People photograph a landscape screen holding the phone upright, so try the
       rotations rather than rejecting the sheet.

       Geometry alone cannot pick the orientation: a 3x2 grid of wide cards looks
       equally valid at 90 and 270, and choosing the first that segments gets the
       sheet upside-down half the time — panels found, every field blank. So each
       viable rotation is scored by how well its icons actually match the roster,
       which is cheap (no OCR) and measures the thing that matters. */
    const viable = [];
    let fallbackPanels = 0;
    for (const deg of [0, 90, 270, 180]) {
      const r = rotated(raw, rawW, rawH, deg);
      const s = WORK_W / r.width;
      const work = document.createElement('canvas');
      work.width = WORK_W;
      work.height = Math.round(r.height * s);
      work.getContext('2d', { willReadFrequently: true }).drawImage(r.source, 0, 0, work.width, work.height);
      const got = segmentPanels(work).panels;
      if (deg === 0) fallbackPanels = got.length;
      if (got.length !== 6) continue;

      const c = got.map(p => extractTypeIcons(r.source, p, s));
      const f = identifySpecies(c, candidates);
      viable.push({ deg, img: r.source, scale: s, panels: got, icons: c, found: f,
                    hits: f.reduce((n, x) => n + (x && x.pokemon_id ? 1 : 0), 0) });
      /* An upright image that segments into six panels IS the right
         orientation — stop, without consulting the other rotations.

         Two weaker rules were measured and rejected. Scoring all four and taking
         the best icon match dropped species 55->50 and both ability and item
         from 100% to 90%: a rotated view of an upright sheet sometimes wins on
         icon noise, and the entire import then reads sideways. Requiring only a
         "credible" upright read (3+ species) failed the same way, because
         degraded photos legitimately identify fewer than three from icons alone
         and were needlessly sent down the rotation path. Sideways photos do not
         segment at all at 0 degrees, so failing to segment is the real signal. */
      if (deg === 0) break;
    }

    let chosen = viable.sort((a, b) => b.hits - a.hits)[0];

    /* 90 and 270 both produce a valid-looking 3x2 grid, so when the icons cannot
       separate them the winner is decided by noise — and picking wrong means
       every field is read upside-down. That is exactly what a glare-covered
       sideways photo did: 0 hits against 1.

       Abilities settle it. They are 98% accurate and orientation-sensitive, so
       inverted text matches nothing in the roster's ability list. Only runs when
       the icons were genuinely inconclusive, so the common upright case pays
       nothing. */
    if (opts.ocr && window.TeamsheetOCR && viable.length > 1 && chosen.hits < 3) {
      const meta0 = opts.meta || { moveDescriptions: {}, abilityDescriptions: {} };
      const abilityNames = vocabularyFor(index, meta0, rosterIds, null).abilities;
      let bestAb = -1;
      for (const v of viable) {
        const read = await TeamsheetOCR.readAbilities(v.img, v.panels, v.scale, abilityNames, opts.onProgress);
        const n = read.filter(a => a.ability).length;
        if (n > bestAb) { bestAb = n; chosen = v; }
      }
    }

    let img = raw, scale = 0, panels = [], icons = [], found = [];
    if (chosen) {
      img = chosen.img; scale = chosen.scale; panels = chosen.panels;
      icons = chosen.icons; found = chosen.found;
    }

    if (panels.length !== 6) {
      throw new Error('Could not read the six panels (found ' + fallbackPanels +
        '). A full-screen capture of the Moves & More tab works best.');
    }

    const slots = found.map((r, i) => {
      const s = emptySlot(i + 1);
      if (r && r.pokemon_id) {
        const e = index.byId.get(r.pokemon_id);
        s.pokemon_id = r.pokemon_id;
        s.species = e ? e.name : r.pokemon_id;
        s.is_mega = !!(e && /^Mega /.test(e.name));
        s.confidence = r.score >= 0.8 && r.margin >= 0.15 ? 'high' : 'medium';
      } else {
        s.confidence = 'none';
        s.warnings.push(r && r.icons && r.icons.length
          ? 'Type icons did not clearly match any mon on this roster.'
          : 'No type icons could be read for this slot.');
      }
      // Ranked alternatives drive the review dropdown's ordering, so the likely
      // answer is one click away even when confidence was too low to fill it in.
      s.suggestions = (r && r.ranked) || [];
      return s;
    });

    if (opts.ocr && window.TeamsheetOCR) {
      const meta = opts.meta || { moveDescriptions: {}, abilityDescriptions: {} };

      /* Abilities first, against the whole roster, then use them to settle the
         species before reading anything else. An ability identifies the mon
         outright in 48 of 54 measured slots, so it is a peer of the type icons
         rather than a detail — and unlike the icons it survives photographed
         screens, where it reads 6/6 on fixtures whose icons are unreadable. */
      const rosterAbilities = vocabularyFor(index, meta, rosterIds, null).abilities;
      const abilities = await TeamsheetOCR.readAbilities(img, panels, scale, rosterAbilities, opts.onProgress);

      /* An ability that belongs to exactly one mon on the roster OUTRANKS the
         icons. Measured, abilities read 60/60 while icons carry every wrong
         answer and every blank, so on a disagreement the ability is the better
         bet. Treating it as advisory left a Venusaur whose icon row lost its
         Grass half sitting as mono-Poison Garbodor, even though its ability had
         been read as Chlorophyll — which only Venusaur has on that roster. */
      /* Deliberately NOT seeded with the type icons' assignments. Ability
         OUTRANKS icons, so it has to be able to take a mon the icons put on
         another slot — that override is what turns a mis-iconed Garbodor back
         into Venusaur. Seeding this map blocked exactly that and cost 12 moves
         on the fixture suite. Duplicates against icon-assigned slots are
         resolved after each pass instead, below. */
      const claimed = new Map();   // pokemon_id -> slot index, ability/move passes only
      abilities.forEach((a, i) => {
        slots[i].ability = a.ability || null;
        slots[i].raw = Object.assign(slots[i].raw || {}, { ability: a.raw });
        slots[i].dist = Object.assign(slots[i].dist || {}, { ability: a.dist });
      });

      const ownersOf = ability => rosterIds.filter(id => {
        const e = displayEntry(index, id);
        return e && (e.abilities || []).some(x => tsNorm(x) === tsNorm(ability));
      });

      /* Warnings raised while the icons were being read, which stop being true
         the moment another signal identifies the slot. Leaving them makes a
         successful row look broken and stacks two sentences that contradict
         each other. */
      const CHIP_WARNINGS = [
        'Type icons did not clearly match any mon on this roster.',
        'No type icons could be read for this slot.',
      ];

      /* `signal` is the human name of what identified the mon ("ability",
         "moves"); `detail` is the full explanation. They are separate arguments
         because deriving one from the other by taking the first word of the
         sentence produced 'Identified from its "Clear; type icons were
         unreadable.' — the leading token of '"Clear Body" belongs to ...'. */
      function assign(i, id, signal, detail) {
        const s = slots[i], e = index.byId.get(id);
        const had = s.pokemon_id;
        s.warnings = s.warnings.filter(w => CHIP_WARNINGS.indexOf(w) === -1);
        if (had && had !== id) {
          s.warnings.push('Type icons read ' + ((index.byId.get(had) || {}).name || '?') +
            ', but ' + detail + '. Using the ' + signal + '.');
        } else if (!had) {
          s.warnings.push('Type icons were unreadable — identified from its ' + signal + ' instead.');
        }
        s.pokemon_id = id;
        s.species = e ? e.name : id;
        s.is_mega = !!(e && /^Mega /.test(e.name));
        s.confidence = 'high';
        claimed.set(id, i);
      }

      /* Resolve abilities by elimination, repeatedly, rather than in one pass.

         A mon can only be brought once, so an ability shared by two roster mons
         still pins a slot once the other mon has been claimed elsewhere. On a
         sideways photo this is the difference between reading Delphox and giving
         up: "Blaze" belongs to both Delphox and Incineroar, but Incineroar had
         already been identified by its own unique "Intimidate", leaving Blaze
         unambiguous. A single pass cannot see that; iterating to a fixed point
         can. Six slots, so this converges almost immediately. */
      for (let pass = 0; pass < slots.length; pass++) {
        let progressed = false;
        abilities.forEach((a, i) => {
          if (!a.ability || claimed.has(slots[i].pokemon_id) && claimed.get(slots[i].pokemon_id) === i) {
            if (!a.ability) return;
          }
          if (claimed.get(slots[i].pokemon_id) === i) return;   // already settled
          const free = ownersOf(a.ability).filter(id => !claimed.has(id));
          if (free.length !== 1) return;
          assign(i, free[0], 'ability', '"' + a.ability + '" belongs to ' +
            ((index.byId.get(free[0]) || {}).name || free[0]) + ' on this roster');
          progressed = true;
        });
        if (!progressed) break;
      }

      /* A mon can only be brought once, so an icon guess that collides with an
         ability-backed slot is wrong by construction — drop it rather than
         leaving two slots claiming the same mon. */
      slots.forEach((s, i) => {
        if (!s.pokemon_id || claimed.get(s.pokemon_id) === i) return;
        if (claimed.has(s.pokemon_id)) {
          s.pokemon_id = null;
          s.species = null;
          s.is_mega = false;
          s.confidence = 'none';
          s.warnings.push('Type icons matched a mon already identified in another slot.');
        }
      });

      const read = await TeamsheetOCR.readDetails(img, panels, scale,
        i => vocabularyFor(index, meta, rosterIds, slots[i].pokemon_id),
        opts.onProgress);
      read.forEach((t, i) => {
        const s = slots[i];
        s.nickname = t.nickname || null;
        s.item = t.item || null;
        s.moves = t.moves || [];
        s.raw = Object.assign(s.raw || {}, t.raw);
        s.dist = Object.assign(s.dist || {}, t.dist || {});

        /* The "prefer the raw OCR text for mega stones" rule that used to live
           here is gone. It existed because the generated stone names were wrong,
           and it worked for Blastoisinite — but it also let a misread win: OCR
           read "Frostassite" and it overrode a correctly matched "Froslassite".
           With verified spellings in the vocabulary the fuzzy match is now the
           more reliable of the two, so the raw text no longer overrides it. */
        // moves is always 4 long now, with a null wherever a slot went unread,
        // so count what is actually there rather than the array's length.
        const readCount = s.moves.filter(Boolean).length;
        if (readCount < 4) {
          s.warnings.push('Only ' + readCount + ' of 4 moves could be read.');
        }
      });

      /* Last resort: identify by learnset.

         Where the icons are unreadable AND the ability came out as noise, the
         moves often still land — they are four chances rather than one, and a
         signature move is decisive on its own. On a sideways photo this recovers
         Zoroark-Hisui from "Bitter Malice" and Dedenne from "Nuzzle", both of
         which would otherwise be blanks.

         Requires two or more matched moves and exactly one unclaimed roster mon
         able to learn all of them — anything less is a guess, and a blank costs
         the admin less than a plausible wrong answer. */
      slots.forEach((s, i) => {
        // Only the moves that were actually read can constrain a learnset — an
        // unread slot is a null, and tsNorm(null) would match nothing anywhere.
        const known = (s.moves || []).filter(Boolean);
        if (s.pokemon_id || known.length < 2) return;
        const keys = known.map(tsNorm);
        const inUse = new Set(slots.map(x => x.pokemon_id).filter(Boolean));

        const scoredFits = rosterIds.filter(id => {
          if (claimed.has(id) || inUse.has(id)) return false;
          const learn = learnsetFor(index, displayEntry(index, id));
          return learn.length && keys.every(k => learn.indexOf(k) !== -1);
        });
        if (scoredFits.length !== 1) return;
        const fits = scoredFits;
        assign(i, fits[0], 'moves', 'only ' + ((index.byId.get(fits[0]) || {}).name || fits[0]) +
          ' can learn all of them');
        s.confidence = 'medium';   // moves are a weaker signal than a unique ability
      });

      /* If a mon can only have one ability, the sheet cannot be showing anything
         else — so fill it in rather than leaving it blank because the glyphs
         were unreadable. There is no guess involved: the species is already
         settled, and the dex lists exactly one possibility. Covers 12 of 132
         fixture slots, and disproportionately the degraded photos where the
         ability text is the first thing to go.

         Runs last, after every pass that can settle a species. Placed earlier it
         silently did nothing for the slots that needed it most: a mon identified
         from its moves still had a null pokemon_id when this ran. */
      slots.forEach(s => {
        if (s.ability || !s.pokemon_id) return;
        const e = displayEntry(index, s.pokemon_id);
        const only = e && (e.abilities || []);
        if (only && only.length === 1) {
          s.ability = only[0];
          s.warnings.push('Ability unreadable — ' + (e.name || 'this mon') +
            ' can only have ' + only[0] + '.');
        }
      });

    }

    return { source: { kind: 'image' }, slots };
  }

  /* Held items have no dictionary in pokemon.json, unlike moves and abilities,
     so this is the list: mega stones whose spelling a sheet has actually shown,
     plus the common VGC pool. An item outside it simply comes back unmatched and
     the admin types it, which is why the list does not need to be exhaustive. */
  function itemVocabulary() {
    const items = [
      'Leftovers', 'Life Orb', 'Focus Sash', 'Choice Band', 'Choice Specs', 'Choice Scarf',
      'Assault Vest', 'Rocky Helmet', 'Eviolite', 'Safety Goggles', 'Mental Herb', 'White Herb',
      'Power Herb', 'Light Clay', 'Expert Belt', 'Weakness Policy', 'Throat Spray', 'Black Sludge',
      'Air Balloon', 'Quick Claw', 'Bright Powder', 'Wide Lens', 'Zoom Lens', 'Scope Lens',
      'Metronome', 'Clear Amulet', 'Covert Cloak', 'Loaded Dice', 'Booster Energy', 'Ability Shield',
      'Light Ball',   // species-specific items still turn up on sheets
      'Punching Glove', 'Mirror Herb', 'Heavy-Duty Boots', 'Blunder Policy', 'Room Service',
      'Eject Button', 'Eject Pack', 'Red Card', 'Sharp Beak', 'Black Glasses', 'Mystic Water',
      'Charcoal', 'Magnet', 'Miracle Seed', 'Twisted Spoon', 'Never-Melt Ice', 'Poison Barb',
      'Soft Sand', 'Hard Stone', 'Silver Powder', 'Spell Tag', 'Metal Coat', 'Dragon Fang',
      'Silk Scarf', 'Fairy Feather', 'Muscle Band', 'Wise Glasses', 'Binding Band', 'Grip Claw',
      'Sitrus Berry', 'Lum Berry', 'Figy Berry', 'Iapapa Berry', 'Mago Berry', 'Aguav Berry',
      'Wiki Berry', 'Occa Berry', 'Passho Berry', 'Wacan Berry', 'Rindo Berry', 'Yache Berry',
      'Chople Berry', 'Kebia Berry', 'Shuca Berry', 'Coba Berry', 'Payapa Berry', 'Tanga Berry',
      'Charti Berry', 'Kasib Berry', 'Haban Berry', 'Colbur Berry', 'Babiri Berry', 'Chilan Berry',
      'Roseli Berry', 'Salac Berry', 'Liechi Berry', 'Petaya Berry', 'Starf Berry', 'Custap Berry',
      'Wellspring Mask', 'Hearthflame Mask', 'Cornerstone Mask', 'Rusted Sword', 'Rusted Shield',
    ];
    /* Mega stone spellings, transcribed from real sheets and human-verified.

       These cannot be derived: the stems elide, insert and mutate with no rule
       behind them — Manectric gives Manectite, Blastoise gives Blastoisinite,
       Sableye gives Sablenite, Scrafty gives Scraftinite. Generating
       "<base>ite" and its truncations produced "Manectricite" and "Blastoiseite",
       neither of which exists, so nothing is generated: a mega whose stone
       has not turned up on a sheet yet comes back unmatched and the admin
       types it. An invented name is worse than no name — it buries the item
       suggestions under hundreds of non-items, and each truncation sits one
       edit from a real stone, so "Scizoite" competes with Scizorite for the
       fuzzy match.

       Add a spelling here once a sheet shows it: run harvest-items.js, which
       lists every item in match_pokemon that this vocabulary cannot match. It
       is also how the nine stones after the original batch were found — each
       was read perfectly by OCR and thrown away for want of an entry, which
       was most of the item error on the sheet suite. It flags one-offs rather
       than listing them, so a mistyped "Frosite" on a Floette that reads
       Floettite nine times over does not get promoted to a real name. */
    const VERIFIED_STONES = [
      'Aerodactylite', 'Beedrillite', 'Blastoisinite', 'Blazikenite', 'Charizardite X',
      'Charizardite Y', 'Clefablite', 'Delphoxite', 'Dragalgite', 'Excadrite', 'Floettite',
      'Froslassite', 'Garchompite', 'Gardevoirite', 'Gengarite', 'Glalieite', 'Glimmoranite',
      'Gyaradosite', 'Kangaskhanite', 'Lopunnite', 'Malamarite', 'Manectite', 'Mawilite',
      'Meganiumite', 'Metagrossite', 'Raichuite Y', 'Sablenite', 'Sceptilite', 'Scizorite',
      'Scovillainite', 'Scraftinite', 'Skarmorite', 'Staraptite', 'Swampertite',
      'Tyranitarite', 'Venusaurite',
    ];
    items.push.apply(items, VERIFIED_STONES);
    return items;
  }

  /* Vocabularies for one panel. Narrowing to the identified species is the whole
     point: an ability becomes a 3-way choice and a move a ~60-way one, which is
     what turns marginal OCR into a confident answer. When the icons could not
     identify the mon, fall back to the union across the roster — still far
     smaller than the full 937-move dictionary. */
  function vocabularyFor(index, meta, rosterIds, speciesId) {
    const moveNames = Object.keys(meta.moveDescriptions || {});
    const abilityNames = Object.keys(meta.abilityDescriptions || {});
    const ids = speciesId ? [speciesId] : rosterIds;
    const entries = ids.map(id => displayEntry(index, id)).filter(Boolean);

    const learn = new Set();
    entries.forEach(e => learnsetFor(index, e).forEach(m => learn.add(m)));
    const moves = learn.size
      ? moveNames.filter(n => learn.has(tsNorm(n)))
      : moveNames;

    const abil = new Set();
    entries.forEach(e => (e.abilities || []).forEach(a => abil.add(tsNorm(a))));
    const abilities = abil.size
      ? abilityNames.filter(n => abil.has(tsNorm(n)))
      : abilityNames;

    return {
      moves: moves.length ? moves : moveNames,
      abilities: abilities.length ? abilities : abilityNames,
      items: itemVocabulary(),
      // Full dictionary, used as a fallback when the narrowed learnset rejects a
      // move — the dex's learnsets have holes (see ocr.js readDetails).
      allMoves: moveNames,
    };
  }

  function blobToImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image file.')); };
      img.src = url;
    });
  }

  return {
    buildDexIndex, resolveSpecies, candidatesFromRoster, displayEntry,
    itemVocabulary, vocabularyFor,
    fromPokepaste, fromPasteText, fromImage,
  };
})();
