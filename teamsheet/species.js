/* ============================================================================
   Species identification from type icons (tools/teamsheet/species.js)

   Given a panel's icons and the team's active roster, pick the mon. Measured
   over the ground-truth fixtures, a type pair uniquely identifies the mon in
   54/54 slots within a 10-mon roster, so icons are the primary signal and the
   sprite is only a tiebreak.

   Design rule, from how this gets used: the admin reviews every import, so a
   confidently wrong species costs more than a blank — a blank is obvious, a
   plausible-looking error has to be noticed. Anything below the confidence
   floor returns null rather than a guess.
   ============================================================================ */

/* Calibrated from the labeled fixtures (see calibrate-type-icons.js), inlined
   rather than fetched because tools/ is gitignored and never deploys — the
   admin page must carry this table with it. */
const TYPE_COLORS = {
  Normal: [159, 159, 160], Fire: [207, 40, 43], Water: [42, 126, 232],
  Electric: [250, 192, 71], Grass: [68, 153, 66], Ice: [111, 216, 255],
  Fighting: [225, 116, 100], Poison: [144, 64, 204], Ground: [144, 81, 52],
  Flying: [127, 183, 238], Psychic: [220, 71, 130], Bug: [142, 156, 76],
  Rock: [174, 167, 135], Ghost: [112, 65, 114], Dragon: [81, 97, 224],
  Dark: [80, 65, 66], Steel: [97, 160, 184], Fairy: [218, 112, 233],
};

function colorDist(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

// 0..1, where 1 is exact. 300 total-channel error is treated as no match.
function colorScore(a, b) { return Math.max(0, 1 - colorDist(a, b) / 300); }

/* Score one candidate against an icon row.

   Type icons are right-aligned as [gender?] [type1] [type2?], so the candidate's
   types are compared against the rightmost N icons. Order is not dex order —
   the dex has Medicham as Psychic/Fighting while the game renders it
   Fighting/Psychic — so both pairings are tried and the better one wins. */
function scoreCandidate(icons, types) {
  if (!icons.length || !types.length || icons.length < types.length) return 0;

  const tail = icons.slice(icons.length - types.length);
  const perms = types.length === 2 ? [[0, 1], [1, 0]] : [[0]];
  let best = 0;
  for (const perm of perms) {
    let sum = 0;
    perm.forEach((ti, k) => {
      const want = TYPE_COLORS[types[ti]];
      sum += want ? colorScore(tail[k].color, want) : 0;
    });
    best = Math.max(best, sum / types.length);
  }

  /* Penalise, but do not disqualify, a candidate that leaves icons unexplained.

     Scoring only the rightmost N icons rewards mono-type candidates for having
     less to match: on a Grass/Poison row reading [male, Grass, Poison],
     Venusaur matched two icons at 0.95 while mono-Poison Garbodor matched the
     single rightmost one at a perfect 1.00 and won, with the Grass icon simply
     ignored. Everything left of the types can only be the gender marker, so one
     leftover is expected and more is suspicious.

     This started as a hard zero, which was too absolute: on a photographed
     screen rows routinely pick up a spurious blob or drop a real one, and
     zeroing every affected candidate collapsed a sideways fixture from six
     identifications to one — leaving the choice of rotation to noise. Halving
     per extra icon still lets Venusaur (0.95) beat Garbodor (1.00 -> 0.50)
     while leaving a noisy row usable. */
  const extra = Math.max(0, (icons.length - types.length) - 1);
  return best / (1 + extra);
}

/* Rejected: disqualifying a candidate whose tail icon sits nearer a gender
   color than the type it is matched against.

   The motivating failure is real — Blaziken (male/Fire/Fighting) lost two icons
   and the leftover blue gender marker was confidently read as mono-Water
   Blastoise. But the guard cost more than it saved, 1 wrong -> 2 wrong, because
   several real types sit close to the gender colors (Dragon by male blue,
   Psychic and Fairy by female red). It disqualified the CORRECT candidate on
   panels whose rows were merely imperfect, which raised the runner-up's margin
   past the confidence floor and converted blanks into wrong answers.

   Escalating it to "blank the whole panel on any clash" was worse still,
   blanking 52/54 — across ten candidates something always clashes. Restricting
   that to competitive clashes landed back at 2 wrong.

   Left out deliberately. The league does not track gender, so the marker is
   only ever noise to be tolerated, never something to read. */

/* Resolve six panels against the roster.

   candidates: [{ id, types: [..] }] using the DISPLAY form's types — sheets
   render the pre-mega species, so a drafted 212-m is matched on Scizor's
   Bug/Steel, not Mega Scizor's.

   Assignment is 1:1 (a mon can only be brought once), greedy over globally
   sorted scores, which is optimal enough at 6x10 and easy to reason about. */
const SPECIES_MIN_SCORE = 0.62;   // below this the icons did not really match
const SPECIES_MIN_MARGIN = 0.05;  // below this two candidates are too close to call

function identifySpecies(panelIcons, candidates) {
  const matrix = panelIcons.map(icons => candidates.map(c => scoreCandidate(icons, c.types)));

  const pairs = [];
  matrix.forEach((row, p) => row.forEach((s, c) => pairs.push({ p, c, s })));
  pairs.sort((a, b) => b.s - a.s);

  const takenP = new Set(), takenC = new Set();
  const out = panelIcons.map(() => null);
  for (const { p, c, s } of pairs) {
    if (takenP.has(p) || takenC.has(c)) continue;
    takenP.add(p); takenC.add(c);
    const ranked = matrix[p]
      .map((v, i) => ({ id: candidates[i].id, s: v }))
      .sort((a, b) => b.s - a.s);
    const runnerUp = ranked.find(r => r.id !== candidates[c].id);
    const margin = s - (runnerUp ? runnerUp.s : 0);
    const confident = s >= SPECIES_MIN_SCORE && margin >= SPECIES_MIN_MARGIN;
    out[p] = {
      pokemon_id: confident ? candidates[c].id : null,
      best: candidates[c].id,
      score: +s.toFixed(3),
      margin: +margin.toFixed(3),
      ranked: ranked.slice(0, 3).map(r => ({ id: r.id, s: +r.s.toFixed(3) })),
      // Surfaced so the review grid can show what was actually read when a slot
      // comes back blank, instead of just an empty box.
      icons: panelIcons[p].map(ch => ch.color),
    };
  }
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TYPE_COLORS, identifySpecies, scoreCandidate };
}
