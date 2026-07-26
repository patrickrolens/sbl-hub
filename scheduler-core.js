/* ============================================================================
   SBL Schedule Builder — core solver (Stage 1, headless)
   ----------------------------------------------------------------------------
   Pure functions, no DOM, no network. Consumes plain data and produces a
   week-by-week schedule plus validation stats. This is the piece we validate
   before building any UI, so it deliberately knows nothing about Supabase.

   INPUT MODEL
     players: [{ id, name, elo }]           // elo already resolved (real or fallback)
     history: Map "aId|bId" -> weightedCount // cross-season prior-meeting weight
     opts: { weeks, seed }

   The matching engine:
     Each week we need a perfect matching on the players (one sits out if N is
     odd). Every candidate pair (i,j) carries a COST that blends:
       - balance:  how much pairing i and j pushes either player's running
                   average-opponent-ELO away from the field mean
       - rematch:  cross-season prior-meeting weight (soft) + a hard block on
                   same-season repeats (cost = Infinity if already scheduled)
     We pick the minimum-total-cost perfect matching for the week, commit it,
     update running opponent-ELO tallies, and move to the next week.

     For N <= 24 we don't need full blossom. We use a randomized greedy +
     local-search (2-opp swaps) matcher restarted several times and keep the
     best. At this scale that reliably finds the true optimum or within epsilon,
     and it's ~40 lines instead of ~400.
   ============================================================================ */

(function (root) {
  'use strict';

  // ── tiny seeded RNG (mulberry32) so runs are reproducible ────────────────
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function pairKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }

  // ── cost between two players, given current running state ────────────────
  // state.avgTarget is the field-mean ELO (the number every player's average
  // opponent "should" trend toward). state.sum[id] / state.cnt[id] track each
  // player's opponents so far. We score the *marginal* deviation this pairing
  // would create for both players, plus the rematch penalty.
  function pairCost(pi, pj, state, cfg) {
    // hard same-season repeat block
    if (state.played.has(pairKey(pi.id, pj.id))) return Infinity;

    // balance term: after this pairing, what's each player's avg-opp-elo, and
    // how far from target? We sum squared deviations (L2) so one very lopsided
    // slate is punished more than two mildly-off ones.
    const t = state.avgTarget;
    const ni = state.cnt[pi.id] + 1, si = state.sum[pi.id] + pj.elo;
    const nj = state.cnt[pj.id] + 1, sj = state.sum[pj.id] + pi.elo;
    const di = si / ni - t;
    const dj = sj / nj - t;
    const balance = di * di + dj * dj;

    // rematch term: cross-season weighted prior meetings (soft)
    const hist = state.history.get(pairKey(pi.id, pj.id)) || 0;
    const rematch = hist * cfg.rematchWeight;

    return cfg.balanceWeight * balance + rematch;
  }

  // ── one week's matching: min-cost perfect matching via restarts ──────────
  // Returns { pairs: [[i,j],...], bye: id|null, cost }.
  function matchWeek(players, state, cfg, rng) {
    const n = players.length;
    const odd = n % 2 === 1;

    // Choose the bye first when odd: give it to whoever is *most* owed one
    // (fewest byes so far), tie-broken randomly. This keeps byes evenly spread
    // and — since a bye counts as a neutral non-match — doesn't touch balance.
    let byeId = null, pool = players;
    if (odd) {
      const minByes = Math.min(...players.map(p => state.byes[p.id]));
      const cands = players.filter(p => state.byes[p.id] === minByes);
      byeId = cands[Math.floor(rng() * cands.length)].id;
      pool = players.filter(p => p.id !== byeId);
    }

    let best = null;
    const RESTARTS = 40;
    for (let r = 0; r < RESTARTS; r++) {
      const order = pool.slice();
      // shuffle
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      // greedy: repeatedly take the cheapest available pair from the front
      const used = new Set();
      const pairs = [];
      let total = 0, feasible = true;
      const remaining = order.slice();
      while (remaining.length) {
        const a = remaining.shift();
        if (used.has(a.id)) continue;
        let bestJ = -1, bestC = Infinity;
        for (let k = 0; k < remaining.length; k++) {
          const b = remaining[k];
          if (used.has(b.id)) continue;
          const c = pairCost(a, b, state, cfg);
          if (c < bestC) { bestC = c; bestJ = k; }
        }
        if (bestJ === -1 || bestC === Infinity) { feasible = false; break; }
        const b = remaining[bestJ];
        used.add(a.id); used.add(b.id);
        pairs.push([a, b]); total += bestC;
      }
      if (!feasible) continue;

      // local search: try swapping opponents between two pairs if it lowers cost
      let improved = true;
      while (improved) {
        improved = false;
        for (let x = 0; x < pairs.length; x++) {
          for (let y = x + 1; y < pairs.length; y++) {
            const [a, b] = pairs[x], [c, d] = pairs[y];
            const cur = pairCost(a, b, state, cfg) + pairCost(c, d, state, cfg);
            const alt1 = pairCost(a, c, state, cfg) + pairCost(b, d, state, cfg);
            const alt2 = pairCost(a, d, state, cfg) + pairCost(b, c, state, cfg);
            if (alt1 < cur - 1e-9 && alt1 < alt2) {
              pairs[x] = [a, c]; pairs[y] = [b, d]; improved = true;
            } else if (alt2 < cur - 1e-9) {
              pairs[x] = [a, d]; pairs[y] = [b, c]; improved = true;
            }
          }
        }
      }
      // recompute total after local search
      total = pairs.reduce((s, [a, b]) => s + pairCost(a, b, state, cfg), 0);
      if (!best || total < best.cost) best = { pairs, bye: byeId, cost: total };
    }
    return best; // may be null if infeasible (e.g. everyone already played)
  }

  // ── full schedule ────────────────────────────────────────────────────────
  function buildSchedule(players, history, opts) {
    const cfg = {
      balanceWeight: (opts && opts.balanceWeight) != null ? opts.balanceWeight : 1,
      rematchWeight: (opts && opts.rematchWeight) != null ? opts.rematchWeight : 40,
    };
    const weeks = (opts && opts.weeks) || 9;
    const rng = mulberry32((opts && opts.seed) || 1234567);

    const avgTarget = players.reduce((s, p) => s + p.elo, 0) / players.length;
    const state = {
      avgTarget,
      history,
      sum: {}, cnt: {}, byes: {},
      played: new Set(),
    };
    players.forEach(p => { state.sum[p.id] = 0; state.cnt[p.id] = 0; state.byes[p.id] = 0; });

    const schedule = [];         // [{ week, pairs:[[a,b]], bye }]
    const problems = [];
    for (let w = 1; w <= weeks; w++) {
      const res = matchWeek(players, state, cfg, rng);
      if (!res) { problems.push('Week ' + w + ': no feasible matching (too many prior pairings).'); break; }
      // commit
      res.pairs.forEach(([a, b]) => {
        state.sum[a.id] += b.elo; state.cnt[a.id] += 1;
        state.sum[b.id] += a.elo; state.cnt[b.id] += 1;
        state.played.add(pairKey(a.id, b.id));
      });
      if (res.bye) state.byes[res.bye] += 1;
      schedule.push({
        week: w,
        pairs: res.pairs.map(([a, b]) => [a.id, b.id]),
        bye: res.bye,
      });
    }

    return { schedule, state, avgTarget, problems, cfg, weeks };
  }

  // ── validation report ─────────────────────────────────────────────────────
  function report(players, result) {
    const byId = {}; players.forEach(p => byId[p.id] = p);
    const s = result.state;
    const rows = players.map(p => {
      const avg = s.cnt[p.id] ? s.sum[p.id] / s.cnt[p.id] : result.avgTarget;
      return {
        id: p.id, name: p.name, elo: p.elo,
        games: s.cnt[p.id], byes: s.byes[p.id],
        avgOpp: avg, dev: avg - result.avgTarget,
      };
    });
    const devs = rows.map(r => r.dev);
    const spread = Math.max(...devs) - Math.min(...devs);
    const rms = Math.sqrt(devs.reduce((a, d) => a + d * d, 0) / devs.length);

    // rematch accounting across the produced schedule
    let crossSeasonHits = 0, sameSeasonRepeats = 0;
    const seen = new Set();
    result.schedule.forEach(wk => wk.pairs.forEach(([a, b]) => {
      const k = a < b ? a + '|' + b : b + '|' + a;
      if (seen.has(k)) sameSeasonRepeats++;
      seen.add(k);
      if (result.state.history.get(k)) crossSeasonHits++;
    }));

    return { rows, spread, rms, crossSeasonHits, sameSeasonRepeats,
             avgTarget: result.avgTarget };
  }

  // ── multi-seed auto-pick ───────────────────────────────────────────────────
  // Because the per-week matcher is a heuristic on a non-convex landscape,
  // different seeds land in different local optima. Rather than make the user
  // hunt for a good seed, try several and keep the best by balance RMS (the
  // stable metric). Returns { result, report, seed, tried }. The chosen seed is
  // reported so the user can reproduce or re-roll from it.
  function buildScheduleBest(players, history, opts) {
    const tries = (opts && opts.tries) || 6;
    const baseSeed = (opts && opts.seed) || 1234567;
    let best = null, bestRep = null, bestSeed = null, bestResult = null;
    for (let i = 0; i < tries; i++) {
      const seed = baseSeed + i * 7919; // spread seeds apart
      const res = buildSchedule(players, history, Object.assign({}, opts, { seed }));
      if (res.problems.length) continue; // skip infeasible
      const rep = report(players, res);
      // primary: RMS; tiny tiebreak toward fewer cross-season reuses
      const score = rep.rms + 0.01 * rep.crossSeasonHits;
      if (best == null || score < best) { best = score; bestRep = rep; bestSeed = seed; bestResult = res; }
    }
    if (best == null) {
      // everything infeasible — fall back to a single run so caller sees problems
      const res = buildSchedule(players, history, opts);
      return { result: res, report: report(players, res), seed: baseSeed, tried: tries };
    }
    return { result: bestResult, report: bestRep, seed: bestSeed, tried: tries };
  }

  // ── re-optimize around locked matches ─────────────────────────────────────
  // Given an existing schedule and a set of locked pair-keys, re-solve each
  // week's UNLOCKED players while holding locked matches fixed. Weeks stay fixed
  // (a match never moves to another week). Returns the same shape as
  // buildSchedule. Locked pairs are committed first each week so the unlocked
  // remainder optimizes against them.
  //   locks: Set of pairKey strings that must be preserved, in whatever week
  //          they currently occupy.
  function reoptimizeAroundLocks(players, history, existingSchedule, locks, opts) {
    const cfg = {
      balanceWeight: (opts && opts.balanceWeight) != null ? opts.balanceWeight : 1,
      rematchWeight: (opts && opts.rematchWeight) != null ? opts.rematchWeight : 40,
    };
    const rng = mulberry32((opts && opts.seed) || 1234567);
    const byId = {}; players.forEach(p => byId[p.id] = p);
    const avgTarget = players.reduce((s, p) => s + p.elo, 0) / players.length;
    const state = { avgTarget, history, sum: {}, cnt: {}, byes: {}, played: new Set() };
    players.forEach(p => { state.sum[p.id] = 0; state.cnt[p.id] = 0; state.byes[p.id] = 0; });

    const schedule = [];
    const problems = [];

    for (const wk of existingSchedule) {
      // partition this week's players into locked (fixed pairs) and free
      const lockedPairs = [];
      const lockedIds = new Set();
      wk.pairs.forEach(([a, b]) => {
        if (locks.has(pairKey(a, b))) {
          lockedPairs.push([a, b]);
          lockedIds.add(a); lockedIds.add(b);
        }
      });
      // who was playing this week (excludes byes); free = playing − locked
      const playingIds = new Set();
      wk.pairs.forEach(([a, b]) => { playingIds.add(a); playingIds.add(b); });
      const freeIds = [...playingIds].filter(id => !lockedIds.has(id));

      // commit locked pairs to state first
      lockedPairs.forEach(([a, b]) => {
        state.sum[a] += byId[b].elo; state.cnt[a] += 1;
        state.sum[b] += byId[a].elo; state.cnt[b] += 1;
        state.played.add(pairKey(a, b));
      });

      // solve the free remainder (even count expected; if odd, something's off —
      // preserve as-is rather than fabricate a bye mid-edit)
      let freePairs = [];
      if (freeIds.length % 2 === 0 && freeIds.length > 0) {
        const freePlayers = freeIds.map(id => byId[id]);
        const sub = matchFreeSet(freePlayers, state, cfg, rng);
        if (!sub) {
          problems.push('Week ' + wk.week + ': could not re-solve unlocked players (constraints too tight); kept original.');
          freePairs = wk.pairs.filter(([a, b]) => !locks.has(pairKey(a, b)));
        } else {
          freePairs = sub.map(([a, b]) => [a.id, b.id]);
        }
      } else {
        // odd free set or none: keep original unlocked pairs untouched
        freePairs = wk.pairs.filter(([a, b]) => !locks.has(pairKey(a, b)));
      }

      // commit the freshly solved free pairs
      freePairs.forEach(([a, b]) => {
        if (!state.played.has(pairKey(a, b))) {
          state.sum[a] += byId[b].elo; state.cnt[a] += 1;
          state.sum[b] += byId[a].elo; state.cnt[b] += 1;
          state.played.add(pairKey(a, b));
        }
      });

      const byes = (wk.byes || (wk.bye ? [wk.bye] : []));
      byes.forEach(id => { state.byes[id] += 1; });

      schedule.push({ week: wk.week, pairs: lockedPairs.concat(freePairs),
                      bye: byes.length === 1 ? byes[0] : null, byes });
    }

    return { schedule, state, avgTarget, problems, cfg, weeks: schedule.length };
  }

  // Solve a min-cost perfect matching on an arbitrary even-sized set of players,
  // against the current running state. Same greedy + local-search as matchWeek
  // but without bye handling (caller guarantees even count). Returns [[pi,pj]].
  function matchFreeSet(pool, state, cfg, rng) {
    let best = null;
    const RESTARTS = 40;
    for (let r = 0; r < RESTARTS; r++) {
      const order = pool.slice();
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      const used = new Set();
      const pairs = [];
      let feasible = true;
      const remaining = order.slice();
      while (remaining.length) {
        const a = remaining.shift();
        if (used.has(a.id)) continue;
        let bestJ = -1, bestC = Infinity;
        for (let k = 0; k < remaining.length; k++) {
          const b = remaining[k];
          if (used.has(b.id)) continue;
          const c = pairCost(a, b, state, cfg);
          if (c < bestC) { bestC = c; bestJ = k; }
        }
        if (bestJ === -1 || bestC === Infinity) { feasible = false; break; }
        const b = remaining[bestJ];
        used.add(a.id); used.add(b.id);
        pairs.push([a, b]);
      }
      if (!feasible) continue;
      let improved = true;
      while (improved) {
        improved = false;
        for (let x = 0; x < pairs.length; x++) {
          for (let y = x + 1; y < pairs.length; y++) {
            const [a, b] = pairs[x], [c, d] = pairs[y];
            const cur = pairCost(a, b, state, cfg) + pairCost(c, d, state, cfg);
            const alt1 = pairCost(a, c, state, cfg) + pairCost(b, d, state, cfg);
            const alt2 = pairCost(a, d, state, cfg) + pairCost(b, c, state, cfg);
            if (alt1 < cur - 1e-9 && alt1 < alt2) { pairs[x] = [a, c]; pairs[y] = [b, d]; improved = true; }
            else if (alt2 < cur - 1e-9) { pairs[x] = [a, d]; pairs[y] = [b, c]; improved = true; }
          }
        }
      }
      const total = pairs.reduce((s, [a, b]) => s + pairCost(a, b, state, cfg), 0);
      if (!best || total < best.total) best = { pairs, total };
    }
    return best ? best.pairs : null;
  }

  // ── division-aware scheduling ─────────────────────────────────────────────
  // Circle-method round robin: returns an array of rounds, each round a list of
  // [i,j] index pairs. For odd n, a virtual "bye" slot (index n) is added and any
  // pairing against it is dropped (that player byes that round).
  function roundRobinRounds(ids) {
    const arr = ids.slice();
    const odd = arr.length % 2 === 1;
    if (odd) arr.push(null); // bye marker
    const n = arr.length;
    const rounds = [];
    const fixed = arr[0];
    let rot = arr.slice(1);
    for (let r = 0; r < n - 1; r++) {
      const row = [fixed].concat(rot);
      const pairs = [];
      let bye = null;
      for (let i = 0; i < n / 2; i++) {
        const a = row[i], b = row[n - 1 - i];
        if (a === null) bye = b; else if (b === null) bye = a; else pairs.push([a, b]);
      }
      rounds.push({ pairs, bye });
      // rotate all but the fixed element
      rot.unshift(rot.pop());
    }
    return rounds;
  }

  // Score a set of pairs (a "round") against current state — lower is better.
  function scoreRound(pairs, byId, state, cfg) {
    return pairs.reduce((s, [a, b]) => s + pairCost(byId[a], byId[b], state, cfg), 0);
  }

  // Build a divisional schedule.
  //   players: [{id,elo,...}]
  //   divisionOf: Map(playerId -> divisionId)
  //   opts: { weeks, seed, balanceWeight, rematchWeight }
  // Intra-division round robin fills weeks first (best rounds chosen when the
  // week count is fewer than a full round robin). Cross-division play is added
  // only for weeks the intra-division rounds cannot cover.
  function buildDivisionalSchedule(players, history, divisionOf, opts) {
    const cfg = {
      balanceWeight: (opts && opts.balanceWeight) != null ? opts.balanceWeight : 1,
      rematchWeight: (opts && opts.rematchWeight) != null ? opts.rematchWeight : 40,
    };
    const weeks = (opts && opts.weeks) || 11;
    const rng = mulberry32((opts && opts.seed) || 1234567);
    const byId = {}; players.forEach(p => byId[p.id] = p);
    const avgTarget = players.reduce((s, p) => s + p.elo, 0) / players.length;
    const state = { avgTarget, history, sum: {}, cnt: {}, byes: {}, played: new Set() };
    players.forEach(p => { state.sum[p.id] = 0; state.cnt[p.id] = 0; state.byes[p.id] = 0; });

    // group players by division
    const divs = new Map();
    players.forEach(p => {
      const d = divisionOf.get(p.id);
      if (!divs.has(d)) divs.set(d, []);
      divs.get(d).push(p.id);
    });

    // generate each division's round-robin rounds
    const perDiv = [];
    divs.forEach((ids, divId) => {
      perDiv.push({ divId, ids, rounds: roundRobinRounds(ids), used: new Array(0) });
    });
    const maxIntraRounds = Math.max(...perDiv.map(d => d.rounds.length));

    const schedule = [];
    const problems = [];
    const commit = (pairs, bye) => {
      pairs.forEach(([a, b]) => {
        state.sum[a] += byId[b].elo; state.cnt[a] += 1;
        state.sum[b] += byId[a].elo; state.cnt[b] += 1;
        state.played.add(pairKey(a, b));
      });
      (bye ? [].concat(bye) : []).forEach(id => { state.byes[id] += 1; });
    };

    // Track which rounds each division has left to play, choosing greedily the
    // best-scoring remaining round each week (so a partial season plays its most
    // valuable rounds). For a full round robin all rounds are used regardless.
    const remaining = perDiv.map(d => ({ divId: d.divId, rounds: d.rounds.slice() }));

    const intraWeeks = Math.min(weeks, maxIntraRounds);
    for (let w = 1; w <= intraWeeks; w++) {
      let weekPairs = [];
      const weekByes = [];
      remaining.forEach(d => {
        if (!d.rounds.length) return;
        // pick the best-scoring remaining round for this division
        let bestIdx = 0, bestScore = Infinity;
        d.rounds.forEach((rd, i) => {
          const sc = scoreRound(rd.pairs, byId, state, cfg);
          if (sc < bestScore) { bestScore = sc; bestIdx = i; }
        });
        const chosen = d.rounds.splice(bestIdx, 1)[0];
        weekPairs = weekPairs.concat(chosen.pairs);
        if (chosen.bye) weekByes.push(chosen.bye);
      });
      commit(weekPairs, weekByes);
      schedule.push({ week: w, pairs: weekPairs, bye: weekByes.length === 1 ? weekByes[0] : null, byes: weekByes });
    }

    // cross-division fill for any weeks beyond the intra-division supply
    for (let w = intraWeeks + 1; w <= weeks; w++) {
      // eligible = players who still need a game this week; cross-division only,
      // and never a same-season repeat (enforced by pairCost = Infinity).
      const pool = players.slice();
      const res = matchWeekCross(pool, divisionOf, state, cfg, rng);
      if (!res) { problems.push('Week ' + w + ': could not build cross-division matchups.'); break; }
      commit(res.pairs.map(([a, b]) => [a.id, b.id]), res.bye ? [res.bye] : []);
      schedule.push({ week: w, pairs: res.pairs.map(([a, b]) => [a.id, b.id]),
                      bye: res.bye, byes: res.bye ? [res.bye] : [] });
    }

    return { schedule, state, avgTarget, problems, cfg, weeks: schedule.length };
  }

  // Cross-division matching for a fill week: like matchWeek, but pairings within
  // the same division are forbidden (cost Infinity), so only cross-division games
  // are produced.
  function matchWeekCross(players, divisionOf, state, cfg, rng) {
    const n = players.length;
    const odd = n % 2 === 1;
    let byeId = null, pool = players;
    if (odd) {
      const minByes = Math.min(...players.map(p => state.byes[p.id]));
      const cands = players.filter(p => state.byes[p.id] === minByes);
      byeId = cands[Math.floor(rng() * cands.length)].id;
      pool = players.filter(p => p.id !== byeId);
    }
    const crossCost = (a, b) => {
      if (divisionOf.get(a.id) === divisionOf.get(b.id)) return Infinity; // same div forbidden
      return pairCost(a, b, state, cfg);
    };
    let best = null;
    const RESTARTS = 40;
    for (let r = 0; r < RESTARTS; r++) {
      const order = pool.slice();
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      const used = new Set(); const pairs = []; let feasible = true;
      const remaining = order.slice();
      while (remaining.length) {
        const a = remaining.shift(); if (used.has(a.id)) continue;
        let bestJ = -1, bestC = Infinity;
        for (let k = 0; k < remaining.length; k++) {
          const b = remaining[k]; if (used.has(b.id)) continue;
          const c = crossCost(a, b); if (c < bestC) { bestC = c; bestJ = k; }
        }
        if (bestJ === -1 || bestC === Infinity) { feasible = false; break; }
        const b = remaining[bestJ]; used.add(a.id); used.add(b.id); pairs.push([a, b]);
      }
      if (!feasible) continue;
      let improved = true;
      while (improved) {
        improved = false;
        for (let x = 0; x < pairs.length; x++) for (let y = x + 1; y < pairs.length; y++) {
          const [a, b] = pairs[x], [c, d] = pairs[y];
          const cur = crossCost(a, b) + crossCost(c, d);
          const alt1 = crossCost(a, c) + crossCost(b, d);
          const alt2 = crossCost(a, d) + crossCost(b, c);
          if (alt1 < cur - 1e-9 && alt1 < alt2) { pairs[x] = [a, c]; pairs[y] = [b, d]; improved = true; }
          else if (alt2 < cur - 1e-9) { pairs[x] = [a, d]; pairs[y] = [b, c]; improved = true; }
        }
      }
      const total = pairs.reduce((s, [a, b]) => s + crossCost(a, b), 0);
      if (!best || total < best.total) best = { pairs, bye: byeId, total };
    }
    return best;
  }

  root.SBLScheduler = { buildSchedule, buildScheduleBest, reoptimizeAroundLocks, buildDivisionalSchedule, report, pairKey };
})(typeof window !== 'undefined' ? window : globalThis);