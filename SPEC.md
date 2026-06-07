# Springfield Battle League Hub: Project Spec

This doc is meant to outline the web app for the main hub site for the Springfield Battle League, a Pokemon VGC Draft League.

---

## 1. Architecture

### 1.1 Broad Strokes

Two related but independently deployed applications, sharing a common pokemon.json database:

- **League Hub** (this project): static html/JS frontend + Supabase backend. Hosted at the project's primary domain (TBD).
- **Draft Planner** (existing): static html/JS frontend with no backend. Hosted on its own subdomain (`planner.<Domain TBD>.com`). Deployed independently with its own repo.

The hub is a static site (no application server). All dynamic data flows through Supabase's REST API. The only server-side code is Supabase's database functions. Eventually functions might be necessary to handle ingesting replay analyzer data, but the initial release will not include this.

### 1.2 Components

| Component | Technology | Hosted on |
|-----------|------------|-----------|
| Hub frontend | Vanilla HTML/CSS/JS | GitHub Pages |
| Planner frontend | Vanilla HTML/CSS/JS (existing) | GitHub Pages, `planner.<Domain TBD>.com` subdomain |
| Database + API | Supabase (Postgres + PostgREST + Auth) | Supabase Cloud |
| Auth | Supabase magic-link email | Supabase Cloud |
| Replay ingest | Supabase Edge Function | Supabase Cloud |
| Pokemon reference data | `pokemon.json` static file | GitHub Pages, likely remaining in planner repository |

### 1.3 Project Structure

- **Static HTML/JS frontend** The hub itself is mostly read-only, and making it static allows me to reuse some things from the Draft Planner and also reduces the amount of new things I need to learn to implement everything.
- **Supabase** Provides a Postgres database, auto-generated API, and auth in one product, with a free tier that sufficiently covers project scope. Can lean into past SQL experience.
- **Shared `pokemon.json`** This is intended to maintain data continuity between the two apps rather than separately hosting two different sources of truth.

### 1.4 Auth model

One auth boundary: admin or anonymous.

- Admins log in via Supabase magic-link email. A `profiles` table flags which user IDs are admins.
- Everyone else reads without logging in. Anonymous reads are permitted by Row Level Security policies on every public table.

---

## 2. Data Model

The schema is designed so that all aggregate views (standings, kill leaders, etc.) are SQL queries over a small set of leaf tables. Stats are entered once at the game level and every higher-level view derives from there.

### 2.1 Pokemon reference data

Pokemon data lives in `pokemon.json`, not in Postgres. The hub fetches it the same way the planner does. Database tables reference Pokemon by the string `id` field used in that file.

This keeps the dataset where it already lives, avoids duplicating ~1000 rows into the database, and lets a single update to `pokemon.json` propagate to both apps.

### 2.2 Tables

```
seasons
  id              uuid pk
  slug            text unique not null    -- "s10"
  name            text unique not null    -- "Springfield Battle League Season 10"
  vgc_format      text                    -- "VGC 2024 Reg G"
  point_limit     integer default 0       -- draft budget per team
  team_size       integer default 10
  started_at      date nullable
  ended_at        date nullable
  is_current      boolean not null default false

season_pokemon_tiers                      -- per-season tier list (point costs + legality)
  id              uuid pk
  season_id       uuid fk seasons
  pokemon_id      text not null           -- references pokemon.json id
  point_cost      integer nullable
  unique (season_id, pokemon_id)

drafts                                    -- one per season
  id                  uuid pk
  season_id           uuid fk seasons unique
  draft_order         uuid[]              -- ordered team_ids for round 1; snake reverses on even rounds
  status              text default 'pending'  -- IN('pending', 'in_progress', 'complete')
  current_pick_number integer nullable    -- whose turn it is during live drafting
  started_at          timestamptz nullable
  completed_at        timestamptz nullable
  draft_date          date nullable       -- Added for Standings display when draft is pending or in progress

players
  id                  uuid pk
  display_name        text not null       -- "Shrug"
  discord_id          text nullable
  notes               text nullable

showdown_accounts                         -- handling for multiple showdown accounts
  id                  uuid pk
  player_id           uuid fk players
  username            text unique not null
  is_primary          boolean default false   -- which handle is the default for display
  notes               text nullable

teams
  id                  uuid pk
  season_id           uuid fk seasons on delete cascade
  name                text not null       -- "Violet City Woopers"
  slug                text not null       -- "violet-city-woopers" or maybe "vcw" for URLs
  logo_url            text nullable       -- probably store in a directory in the repository
  initial_seed        integer nullable    -- pre-season seeding for schedule
  playoff_seed        integer nullable    -- end-of-regular-season seed for playoffs bracket
  cup_seed            integer nullable    -- seeding for the amateur bracket
  unique (season_id, name)
  unique (season_id, slug)

team_owners                               -- handling for coach substitutions
  id                  uuid pk
  team_id             uuid fk teams on delete cascade
  player_id           uuid fk players on delete restrict
  started_week        integer not null    -- week this player took over
  ended_week          integer nullable    -- null if still owner
  notes               text nullable

team_pokemon                              -- handling for trades and free agency swaps
  id                  uuid pk
  team_id             uuid fk teams
  pokemon_id          text not null       -- references pokemon.json id field
  acquired_week       integer not null    -- effective week the pokemon joined; 1 for Pokemon obtained in draft
  released_week       integer nullable    -- null if still on team
  acquired_via        text not null       -- IN('draft', 'free_agency', 'trade')
  draft_pick_number   integer nullable    -- only set for acquired_via = 'draft'
  notes               text nullable

matches
  id                  uuid pk
  season_id           uuid fk seasons
  stage               text default 'regular' not null  -- 'regular' | 'playoffs' | 'cup'
  week                integer not null    -- Post-season week numbers pick up where regular season leaves off
  postseason_round    text nullable       -- "Playoffs Round 1" | "Cup Semifinals"
  bracket_position    text nullable       -- "A", "B", etc. for bracket UI
  series_length       integer default 3 not null  -- 3, 5, or 7
  team_a_id           uuid not null references teams(id)
  team_b_id           uuid not null references teams(id)
  team_a_score        integer not null default 0   -- games won by team A
  team_b_score        integer not null default 0   -- games won by team B
  match_date          timestamptz nullable
  winner_team_id      uuid fk teams nullable   -- redundant but useful, computed by generated column

games
  id                  uuid pk
  match_id            uuid fk matches
  game_number         integer not null    -- 1, 2, 3, ...
  replay_url          text nullable       -- Showdown link, YouTube link, or null
  game_date           timestamptz default now() not null
  winner_team_id      uuid fk teams nullable
  unique (match_id, game_number)

game_pokemon_stats
  id                  uuid pk
  game_id             uuid fk games
  team_id             uuid fk teams       -- which side the pokemon played for in this game
  pokemon_id          text not null       -- references pokemon.json id field
  kills               integer default 0 not null
  deaths              integer default 0 not null
  unique (game_id, team_id, pokemon_id)
  -- presence of a row implies the pokemon was sent out in the battle

free_agency_moves
  id                  uuid pk
  season_id           uuid fk seasons
  team_id             uuid fk teams
  pokemon_added_id    text not null       -- references pokemon.json id field
  pokemon_dropped_id  text not null       -- references pokemon.json id field
  effective_week      integer not null
  occurred_at         timestamptz default now()
  notes               text nullable

trades
  id                  uuid pk
  season_id           uuid fk seasons
  team_a_id           uuid fk teams
  pokemon_a_id        text not null       -- references pokemon.json id field; what team_a gives up
  team_b_id           uuid fk teams
  pokemon_b_id        text not null       -- references pokemon.json id field; what team_b gives up
  effective_week      integer not null
  occurred_at         timestamptz default now()
  notes               text nullable

potw                                      -- Pokemon of the Week
  id                  uuid pk
  season_id           uuid fk seasons
  week                integer not null
  pokemon_id          text not null
  team_id             uuid fk teams
  player_id           uuid fk players
  notes               text nullable

match_pokemon                            -- Added to handle which Pokemon were brought to a given match for Standings and Match displays
  id          uuid pk
  match_id    uuid fk matches on delete cascade
  team_id     uuid fk teams
  pokemon_id  text not null          -- references pokemon.json id
  unique (match_id, team_id, pokemon_id)

profiles                                  -- linked to Supabase auth users; needed for RLS policies. Don't try adding those until this table is created or else bad things will happen!
  id                  uuid not null references auth.users(id) on delete cascade pk
  display_name        text
  is_admin            boolean not null default false
  player_id           uuid fk players nullable  -- if this admin is also a league player
```

### 2.3 Some Notes on Tables

**Temporal roster tracking.** A Pokemon's stint on a team is its own row in `team_pokemon` with `acquired_week` and `released_week`. A trade or free agency move closes one row (setting `released_week`) and opens another. To ask "what was Shrug's roster in week 5", filter `WHERE team_id = ? AND acquired_week <= 5 AND (released_week IS NULL OR released_week > 5)`. This should copy the current behavior in the league doc where an inactive mon still contributes to its original team's stats, and the new owner starts with a clean slate.

**Stats attribution by ownership at game time.** Stats in `game_pokemon_stats` are tied to `(game_id, team_id, pokemon_id)`. The `team_id` records which team the Pokemon was playing for in that game. This should allow us to appropriately assign stats to the correct Pokemon and team without getting screwed up by trades or Free Agency swaps.

**Two competition stages in one matches table.** `matches.stage` distinguishes 'regular', 'playoffs', and 'cup'. Regular season and postseason matches all use 'week'; postseason matches also use `postseason_round` and `bracket_position`. Standings queries filter to `stage = 'regular'`. The Cup is its own bracket for players who did not make it to Playoffs.

**Two transaction tables.** Free agency and trades are kept separate because they're meaningfully different events (one team and a free agent pool vs two teams swapping). A polymorphic single table would leave half the fields null on every row. Both can be unioned into a chronological feed when displaying transactions to users.

**Series length on the match.** Best-of-3 for regular season, best-of-5 for most playoff rounds, best-of-7 for finals. Stored per-match because it varies and historical data should reflect the actual format used.

**No `pokemon` table.** `pokemon.json` is the single source of truth, so the database will simply foreign key to the id when referencing Pokemon

**Showdown accounts as a separate table.** Players sometimes use alt accounts. This table allows us to handle this without using arrays, which can be a little awkward to work with compared to this approach.

**Team ownership as a temporal table.** Players sometimes drop out mid-season and are replaced. Team-level records (standings, season stats, the team's roster) belong to the team across all owners. Player-level individual records belong to specific owners during their window. Modeling ownership as `team_owners` with `started_week` and `ended_week` lets us handle this similar to how Pokemon swaps/trades are handled. The team stays put with its name, roster, and record, and ownership can be assigned to reflect who was actually piloting the team at the time of a given match.

**Per-season tier list.** Point costs and legality change from season to season. `season_pokemon_tiers` captures this. `pokemon.json` remains the canonical Pokemon database, and the tier table layers season-specific rules on top. The draft pool view sources its list from this table for the current season.

**Draft as a first-class entity.** A `drafts` row per season tracks the draft order (snake-draft, reversing on even rounds), current pick, and status. Individual picks are still recorded as `team_pokemon` rows with `acquired_via = 'draft'` and `draft_pick_number`, so the same query that returns a team's roster also returns their draft history. Skipping this table would require encoding the draft order somewhere else (probably a per-team `draft_position` field on `teams`), but a dedicated table keeps draft state in one place and makes the live-draft tool cleaner to write.


### 2.4 SQL views (illustrative)

These are not stored, they're computed on read. Materializing them is a v2 optimization if needed.

**Team season totals (W, L, differential, KD):**
```sql
SELECT
  t.id,
  t.name,
  SUM(CASE WHEN m.winner_team_id = t.id THEN 1 ELSE 0 END) as wins,
  SUM(CASE WHEN m.winner_team_id != t.id AND m.winner_team_id IS NOT NULL THEN 1 ELSE 0 END) as losses,
  SUM(CASE WHEN m.team_a_id = t.id THEN m.team_a_score - m.team_b_score
           ELSE m.team_b_score - m.team_a_score END) as differential,
  (SELECT SUM(s.kills - s.deaths) FROM game_pokemon_stats s
   JOIN games g ON g.id = s.game_id
   JOIN matches m2 ON m2.id = g.match_id
   WHERE s.team_id = t.id AND m2.stage = 'regular') as kd
FROM teams t
LEFT JOIN matches m ON (m.team_a_id = t.id OR m.team_b_id = t.id) AND m.stage = 'regular'
WHERE t.season_id = $1
GROUP BY t.id, t.name
ORDER BY wins DESC, differential DESC, kd DESC;
```

**Kill leaders for a season (all stages count):**
```sql
SELECT
  s.pokemon_id,
  s.team_id,
  t.name as team_name,
  SUM(s.kills) as total_kills,
  SUM(s.deaths) as total_deaths,
  SUM(s.kills - s.deaths) as kd
FROM game_pokemon_stats s
JOIN games g ON g.id = s.game_id
JOIN matches m ON m.id = g.match_id
JOIN teams t ON t.id = s.team_id
WHERE m.season_id = $1
GROUP BY s.pokemon_id, s.team_id, t.name
ORDER BY total_kills DESC;
```

**Team page — active and inactive rosters with stats:**
```sql
-- Active roster
SELECT tp.pokemon_id, tp.acquired_week,
       (SELECT SUM(s.kills) FROM game_pokemon_stats s
        JOIN games g ON g.id = s.game_id
        JOIN matches m ON m.id = g.match_id
        WHERE s.team_id = tp.team_id AND s.pokemon_id = tp.pokemon_id
          AND m.week >= tp.acquired_week
          AND (tp.released_week IS NULL OR m.week < tp.released_week)) as kills_while_owned
FROM team_pokemon tp
WHERE tp.team_id = $1 AND tp.released_week IS NULL;
```

**Strength of Schedule and SoSoS.**

The league's SoS is the average win rate of a team's opponents. SoSoS (second-degree SoS) is the average win rate of the opponents' opponents, used as a deep tiebreaker.

```sql
-- Team win rates for the season (regular season only)
WITH team_records AS (
  SELECT
    t.id as team_id,
    SUM(CASE WHEN m.winner_team_id = t.id THEN 1 ELSE 0 END)::float
    / NULLIF(SUM(CASE WHEN m.winner_team_id IS NOT NULL THEN 1 ELSE 0 END), 0) as win_rate
  FROM teams t
  LEFT JOIN matches m ON (m.team_a_id = t.id OR m.team_b_id = t.id)
    AND m.stage = 'regular'
  WHERE t.season_id = $1
  GROUP BY t.id
),
-- For every (team, opponent) pair, list the opponents a team has faced
team_opponents AS (
  SELECT
    t.id as team_id,
    CASE WHEN m.team_a_id = t.id THEN m.team_b_id ELSE m.team_a_id END as opponent_id
  FROM teams t
  JOIN matches m ON (m.team_a_id = t.id OR m.team_b_id = t.id)
    AND m.stage = 'regular'
  WHERE t.season_id = $1
),
-- First-degree SoS: average win rate of the team's opponents
sos AS (
  SELECT
    to1.team_id,
    AVG(tr.win_rate) as sos
  FROM team_opponents to1
  JOIN team_records tr ON tr.team_id = to1.opponent_id
  GROUP BY to1.team_id
),
-- Second-degree SoS: average win rate of opponents' opponents
sosos AS (
  SELECT
    to1.team_id,
    AVG(tr.win_rate) as sosos
  FROM team_opponents to1
  JOIN team_opponents to2 ON to2.team_id = to1.opponent_id
  JOIN team_records tr ON tr.team_id = to2.opponent_id
  GROUP BY to1.team_id
)
SELECT t.id, t.name, tr.win_rate, sos.sos, sosos.sosos
FROM teams t
LEFT JOIN team_records tr ON tr.team_id = t.id
LEFT JOIN sos ON sos.team_id = t.id
LEFT JOIN sosos ON sosos.team_id = t.id
WHERE t.season_id = $1;
```

Notes:
- This version includes all opponent games when computing opponent win rates, including head-to-head. If the league prefers excluding head-to-head, add a filter to `team_records` to exclude games against the team being evaluated. That's a one-line change.
- Both SoS and SoSoS naturally extend the standings query — they're just extra columns. The full standings query joins these CTEs onto the wins/losses/differential/KD computation.

### 2.5 Row Level Security

Every table has RLS enabled. Two policy patterns:

- **Public read:** `CREATE POLICY "anyone can read" ON {table} FOR SELECT USING (true);`
- **Admin write:** `CREATE POLICY "admins can modify" ON {table} FOR ALL USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = true));`

Applied to all tables. `profiles` itself has a special policy where users can read their own row.

---

## 3. Pages

URLs below show the eventual clean structure (`/teams/shrug`). In vanilla v1, these are implemented with hash routing — `/team.html#joel` instead of `/teams/joel` — so the same page can render different teams based on `location.hash`. Hash URLs are still shareable and bookmarkable.

| Eventual Path | v1 Implementation | Purpose | Source data |
|------|------|---------|-------------|
| `/standings` | `standings.html` | Full standings table for the current season; also serves as main landing page | standings view |
| `/team/[slug]` | `team.html#slug` | Single team page with selector dropdown | team_pokemon + games + matches |
| `/schedule` | `schedule.html` | Week-by-week schedule with results | matches (stage=regular) |
| `/matches/[id]` | `match.html#id` | Single match detail: each game, replays, per-Pokemon stats | match + games + stats |
| `/statistics` | `statistics.html` | KOs, Faints, and all other stats brought together | aggregated stats |
| `/transactions` | `transactions.html` | Chronological feed of free agency moves and trades | free_agency_moves ∪ trades |
| `/playoffs` | `playoffs.html` | Single-elimination bracket view for the season | matches (stage=playoffs) |
| `/cup` | `cup.html` | Same renderer, different data | matches (stage=cup) |
| `/potw` | `potw.html` | Pokemon of the Week gallery | potw |
| `/draft` | `draft.html` | Live draft view if active, final draft results if complete | drafts + team_pokemon |
| `/rules` | `rules.html` | Static rules and resources page | markdown in repo |
| `planner.springfieldbattleleague.com` | (separate deployment) | The existing draft planner, untouched, on its own subdomain | static |
| `/admin` | `admin.html` | Admin landing page (after login) | — |
| `/admin/draft` | `admin-draft.html` | Draft operator tool (click-to-pick during live draft) | — |
| `/admin/tiers` | `admin-tiers.html` | Per-season tier list editor (set legal Pokemon and point costs) | — |
| `/admin/matches` | `admin-matches.html` | List, create, edit matches and games | — |
| `/admin/rosters` | `admin-rosters.html` | Manage team rosters, free agency, trades | — |
| `/admin/seasons` | `admin-seasons.html` | Create new season, set current season | — |

The team page should include a dropdown to switch between teams quickly while preserving the URL-based-on-selection pattern. Same for the match detail page when navigated to from a list. This gives users both fast switching (the dropdown) and shareable links (the URL).

The planner lives on its own subdomain (`planner.springfieldbattleleague.com`) as a fully separate static deployment. The hub never touches the planner's code, and the two have independent repos and deploy pipelines. They share only the parent domain and the canonical `pokemon.json`. Note that as separate origins, the two apps can't share cookies or localStorage across the subdomain boundary.

---

## 4. Draft Tool

At the start of each season, after sign-ups, players take turns in snake-draft format selecting Pokemon for their teams. The league hub captures this both as data and as an operator tool used during the live event.

### 4.1 Scope

Build:
- A per-season tier list (set point costs and legal Pokemon for the season before the draft)
- An admin operator tool: click-to-pick during the live draft, with real-time visual updates
- A public draft view: shows current state during the draft, then final results after

- Automatic snake-order calculation and turn validation.

### 4.2 Admin operator tool (`/admin/draft`)

Layout:
- **Status bar**: current pick number, whose turn, snake direction indicator, point budget remaining for the current picker
- **Left panel — teams**: each team as a card showing name, owner, drafted Pokemon (icon + name + cost), remaining points. Current picker's card highlighted.
- **Right panel — draft pool**: every legal Pokemon for the season, sourced from `season_pokemon_tiers`. Shows icon, name, cost. Grouped by cost or type, with filters. Drafted Pokemon stay visible but are visually dimmed (grayed out, strikethrough, lower opacity — design call).
- **Action**: clicking a Pokemon in the pool prompts "Draft [Pokemon] to [current team]?" — on confirm, inserts a `team_pokemon` row, increments `current_pick_number`, both panels re-render.

The visual style should match the planner — same sprite/icon rendering, same type badges, same color tokens. Users of the planner should feel like they're using a sibling tool.

### 4.3 Public draft view (`/draft`)

When `drafts.status = 'in_progress'`, mirrors the operator view but read-only. When `status = 'complete'`, shows the final ordered list of picks per round, the resulting rosters, and point totals.

For viewers to see live updates without manual refresh, Supabase Realtime subscriptions on `team_pokemon` would push pick events to all open browsers. This is a small amount of code (~20 lines) and is worth doing if the live draft experience matters. If skipped, viewers refresh manually or watch via Discord screen-share of the operator's screen.

### 4.4 Draft workflow

The hub is the primary stage for the draft. Players are on Discord audio while watching the public draft page (or the operator's screen-share). Big sprites, smooth pick transitions, broadcast-friendly layout. Plan for the draft page to require real design time, not just functional UI.

Realtime subscriptions on `team_pokemon` are valuable here — they let viewers see picks land without manual refresh. Worth implementing in v1 if the schedule allows; if not, manual refresh is an acceptable compromise.

---

## 5. Replay Parser Integration (Deferred)

In v1, all match data is entered manually via the admin UI. The replay parser integration is planned for a later phase.

When integrated, the contract will look like:

```
POST /functions/v1/ingest-replay
Authorization: Bearer <service_role_key>
Content-Type: application/json

{
  "replay_url": "https://replay.pokemonshowdown.com/...",
  "team_a_showdown_username": "Saget69",
  "team_b_showdown_username": "Cyb3rstr4w",
  "winner_side": "a" | "b",
  "stats": [
    {"side": "a", "pokemon_name": "Tyranitar", "kills": 3, "deaths": 1},
    {"side": "b", "pokemon_name": "Garchomp", "kills": 2, "deaths": 0}
  ]
}
```

The endpoint:
1. Looks up the `games` row by `replay_url`. If none exists, returns 404.
2. Resolves Pokemon names to `pokemon_id` via the same alias/normalization logic the planner uses.
3. Resolves sides to `team_id` via match metadata.
4. Upserts `game_pokemon_stats` rows.
5. Sets `parse_status = 'parsed'` and `parsed_at = now()`.

Idempotent on `replay_url`. The parser developer adapts their existing script to POST to this endpoint instead of writing to spreadsheet cells. Discussions to lock the contract happen before the parser work begins, not during v1.

---

## 6. Build Plan

### Phase 1

- Create Supabase project. Configure auth (magic link only) and email templates.
- Implement full schema as defined in section 2. Seed `seasons`, `players`, `teams`, `team_owners` for Season 10. Leave `team_pokemon` empty (the draft will populate it).
- Populate `season_pokemon_tiers` for Season 10 (this is the legal Pokemon and their point costs — likely a one-time bulk import from whatever spreadsheet currently holds the tier list).
- Set up RLS policies on every table.
- Create the static frontend repo. Copy the planner's CSS variables and base styles.
- Stand up a "Hello World" page that reads from Supabase to validate the connection.
- Decide where `pokemon.json` lives canonically. Update planner to fetch it from the new location if needed - planner lives in Planner repository

### Phase 2: Draft

The draft itself is the first league event the hub needs to support. Build the operator tool and a basic public view so the draft can run on the new system.

- Tier list admin page (`/admin/tiers`): bulk-ingest tier list for selected season
- Draft operator page (`/admin/draft`): teams panel, draft pool panel, click-to-pick - merged into /draft
- Public draft page (`/draft`): read-only view of current draft state.
- Magic-link auth flow (needed for admin pages).
- Realtime subscription on `team_pokemon` and 'drafts' so the public draft view updates live (optional polish; defer if time-pressed).

### Phase 3: Read Values

- Single team page - highest-information page on the site; getting this right de-risks the rest. With the draft complete, real roster data exists.
- Teams index page - possibly redundant thanks to draft and team pages
- Standings page - Became main landing page with standings, stat leaderboards, and recent/upcoming matches displayed
- Kill Leaders page - Rebranded to Statistics page with plans to add more visualizations over time
- Apply planner styling consistently (type badges, color tokens, sprite handling)

### Phase 4: Schedule and Matches

- Schedule + Results page. - Merged Schedule and Match Details
- Single match detail page (drill-down from schedule).
- Admin forms: enter match result, enter per-game stats. While it will ideally be automated in the future, the manual entry should be as frictionless as possible.
- Schedule entry (one-time bulk insert of all regular season matches before the season starts).

### Phase 5: Transactions and Domain

- Admin forms: record trade, record free agency move.
- Transactions page.
- Mobile responsive check.
- Domain configuration (if a domain has been chosen).

### Phase 6: Final Pieces and Polish

- Playoffs bracket renderer (won't have data yet, but the page exists for testing).
- Cup bracket (same renderer).
- Final visual pass across all pages.
- Rules and Resources (static markdown rendered).
- Document admin workflows.

---

## 7. Open Questions and Deferred Work
- POTW page.
- Migrate any test data out, prepare clean Season 10 state.
- Soft launch to league members for feedback before draft day.

Things explicitly punted from v1, recorded so they don't get lost.

### Deferred features

- **Replay parser integration.** Manual entry only in v1. Plan and implement in a v1.5 cycle after launch.
- **Historical season migration.** Bring in Seasons 1–9 after Season 10 is running smoothly. The schema supports multi-season natively.
- **Schedule builder UI.** Schedules are constructed externally (the helper Sheet) and entered manually. A scheduling assistant could be a separate tool in a future phase.
- **Forfeit special handling.** Forfeits are entered manually as a match with a score but no associated games. No automated handling.
- **Multi-user live drafting.** v1 has a single-operator draft tool. A version where each player drafts from their own device with turn enforcement and timers is a substantially larger feature; deferred to v2+.
- **Draft turn enforcement.** v1's operator tool trusts the admin to click for the right team. Automatic enforcement of snake-draft order is a v2 polish.
- **Season superlatives / award polls.** End-of-season community-voted awards (MVP, biggest upset, best pick, etc.). When implemented, likely a `season_awards` table; voting probably stays in Discord polls for v1+ since the hub has no player accounts.
- **Multiple concurrent team owners.** The `team_owners` schema already supports this via overlapping rows; UI doesn't need to handle it until the league adopts the practice.

### Open questions

- **Domain choice.** Currently no domain. Develop and deploy on `github.io` URL; pick a domain before launch. Likely springfieldbattleleague.com
- **Materialized views vs live queries.** Start with live queries (regular SQL `VIEW`s, or just queries from the application). Live queries re-run on every read; materialized views save the result and serve cached rows until refreshed. For a league with dozens of viewers and weekly data changes, live queries are cheap enough and avoid staleness. If a specific page becomes measurably slow, that page's query can be materialized later — the application code doesn't change, only the database object does.

### Known edge cases to handle in admin UX

- Non-Showdown replay URLs. `replay_url` accepts any string (YouTube link, blank, anything). The admin enters stats manually for these.
- Forfeits and lost replays. Match exists with a score but the affected games have no `game_pokemon_stats` rows. No special schema treatment; if forfeit reporting becomes important later, a `playback_source` column can be added.

---

## 8. Credits

#### Patrick Rolens (Shrug)
- Discord @callmeshrug
- Main developer; SBL Staff

#### Jdawgin13
- SBL Commissioner

#### Ulico
- Replay Analyzer developer
- Discord bot developer