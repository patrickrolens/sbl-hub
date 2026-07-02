-- Reconstructed 2026-07-01 to match production, which had drifted from this file
-- (divisions/match_pokemon tables, several columns, and the drafts uniqueness
-- constraint existed live but weren't reflected here). Fully cross-checked against
-- live `information_schema`/`pg_constraint` dumps, including every FK's ON DELETE
-- action and every multi-column UNIQUE constraint.
-- Regenerate this from `information_schema` / `pg_dump` periodically instead of
-- hand-editing where possible.
CREATE TABLE public.seasons(
    id uuid PRIMARY KEY default gen_random_uuid(),
    slug text unique not null,
    name text unique not null,
    vgc_format text,
    point_limit integer default 0,
    team_size integer default 10,
    started_at date,
    ended_at date,
    is_current boolean not null default false,
    postseason_published boolean not null default false,
    playoff_format text not null default 'single_elim'
);

CREATE UNIQUE INDEX seasons_one_current_idx
    ON public.seasons (is_current)
    WHERE is_current;

-- A season optionally splits into divisions (e.g. two conferences drafting/competing
-- separately). Undivided seasons simply have zero rows here.
CREATE TABLE public.divisions(
    id uuid PRIMARY KEY default gen_random_uuid(),
    season_id uuid not null references public.seasons(id) ON DELETE CASCADE,
    name text not null,
    abbr text not null,
    color text,
    logo_url text,
    sort_order integer not null default 0,
    created_at timestamptz not null default now()
    -- No DB-level unique(season_id, abbr): admin-seasons.html checks "abbr already
    -- used this season" in JS before insert, but nothing stops a race/manual insert.
);

CREATE TABLE public.season_pokemon_tiers(
    id uuid PRIMARY KEY default gen_random_uuid(),
    season_id uuid not null references public.seasons(id) ON DELETE CASCADE,
    pokemon_id text not null,
    point_cost integer,
    tera_point_cost integer,
    constraint unique_season_pokemon unique(season_id, pokemon_id)
);

-- One draft per season normally, but a divisioned season runs one draft per division
-- (division_id null = undivided season's single draft).
CREATE TABLE public.drafts(
    id uuid PRIMARY KEY default gen_random_uuid(),
    season_id uuid not null references public.seasons(id) ON DELETE CASCADE,
    division_id uuid references public.divisions(id) ON DELETE CASCADE,
    draft_order uuid[],
    status text not null default 'pending'
        CHECK (status IN('pending', 'in_progress', 'complete')),
    current_pick_number integer,
    draft_date date,
    started_at timestamptz,
    completed_at timestamptz
    -- No DB-level unique(season_id, division_id): confirmed live that >1 row can
    -- share a season_id (one per division), but nothing in the schema enforces
    -- "at most one draft per season+division" beyond app-side upsert-by-id logic.
);

CREATE TABLE public.players(
    id uuid PRIMARY KEY default gen_random_uuid(),
    display_name text not null,
    discord_id text,
    notes text
);

CREATE TABLE public.showdown_accounts(
    id uuid PRIMARY KEY default gen_random_uuid(),
    player_id uuid not null references public.players(id) ON DELETE CASCADE,
    username text unique not null,
    is_primary boolean default false,
    notes text
);

CREATE UNIQUE INDEX showdown_accounts_unique_primary
    ON public.showdown_accounts (player_id)
    WHERE is_primary;

CREATE TABLE public.teams(
    id uuid PRIMARY KEY default gen_random_uuid(),
    season_id uuid not null references public.seasons(id) ON DELETE CASCADE,
    division_id uuid references public.divisions(id) ON DELETE SET NULL,
    name text not null,
    slug text not null,
    logo_url text,
    initial_seed integer,
    playoff_seed integer,
    cup_seed integer,
    constraint unique_season_team_name unique(season_id, name),
    constraint unique_season_team_slug unique(season_id, slug)
);

CREATE TABLE public.team_owners(
    id uuid PRIMARY KEY default gen_random_uuid(),
    team_id uuid not null references public.teams(id) ON DELETE CASCADE,
    player_id uuid not null references public.players(id) ON DELETE RESTRICT,
    started_week integer not null default 1,
    ended_week integer,
    notes text
);

CREATE TABLE public.team_pokemon(
    id uuid PRIMARY KEY default gen_random_uuid(),
    team_id uuid not null references public.teams(id) ON DELETE CASCADE,
    pokemon_id text not null,
    acquired_week integer not null,
    released_week integer,
    acquired_via text not null default 'draft'
        CHECK(acquired_via IN('draft', 'free_agency', 'trade')),
    draft_pick_number integer,
    notes text,
    is_tera boolean not null default false
);

CREATE TABLE public.matches(
    id uuid PRIMARY KEY default gen_random_uuid(),
    season_id uuid not null references public.seasons(id) ON DELETE CASCADE,
    stage text not null default 'regular'
        CHECK(stage IN('regular', 'playoffs', 'cup')),
    week integer not null,
    postseason_round text,
    bracket_position text,
    series_length integer not null default 3
        CHECK(series_length IN(3, 5, 7)),
    team_a_id uuid not null references public.teams(id) ON DELETE CASCADE,
    team_b_id uuid not null references public.teams(id) ON DELETE CASCADE,
    team_a_score integer not null default 0,
    team_b_score integer not null default 0,
    match_date timestamptz,
    -- The admin's schema dump rendered this as a plain DEFAULT (its export tool's
    -- generic representation for computed columns), but GENERATED...STORED is very
    -- likely still correct: admin-matches.html only ever writes team_a_score/
    -- team_b_score on a result update and never touches winner_team_id directly,
    -- and every match's winner_team_id observed live is consistent with the current
    -- scores — a plain DEFAULT would only apply on INSERT and go stale on score edits.
    winner_team_id uuid GENERATED ALWAYS AS (
        CASE
            WHEN team_a_score > series_length / 2 THEN team_a_id
            WHEN team_b_score > series_length / 2 THEN team_b_id
            ELSE NULL
        END
    ) STORED
);

-- The roster a team actually brought to a match (as opposed to team_pokemon, which
-- is a team's full season-long roster). Distinct from game_pokemon_stats: a mon can
-- be brought without recording a kill/death (e.g. never sent out).
CREATE TABLE public.match_pokemon(
    id uuid PRIMARY KEY default gen_random_uuid(),
    match_id uuid references public.matches(id) ON DELETE CASCADE,
    team_id uuid references public.teams(id),  -- no ON DELETE action, unlike match_id above (confirmed
                                                 -- via pg_constraint; likely inconsistency, not intentional)
    pokemon_id text not null,
    -- match_id/team_id are nullable live despite the app always populating both on
    -- insert — likely an oversight when this table was created rather than intentional.
    constraint unique_match_pokemon unique(match_id, team_id, pokemon_id)
);

CREATE TABLE public.games(
    id uuid PRIMARY KEY default gen_random_uuid(),
    match_id uuid not null references public.matches(id) ON DELETE CASCADE,
    game_number integer not null,
    replay_url text,
    game_date timestamptz default now() not null,
    winner_team_id uuid not null references public.teams(id) ON DELETE CASCADE,
    constraint unique_game_number unique(match_id, game_number)
);

CREATE TABLE public.game_pokemon_stats(
    id uuid PRIMARY KEY default gen_random_uuid(),
    game_id uuid not null references public.games(id) ON DELETE CASCADE,
    team_id uuid not null references public.teams(id) ON DELETE CASCADE,
    pokemon_id text not null,
    kills integer default 0 not null,
    deaths integer default 0 not null,
    constraint unique_game_team_pokemon unique(game_id, team_id, pokemon_id)
);

CREATE TABLE public.free_agency_moves(
    id uuid PRIMARY KEY default gen_random_uuid(),
    season_id uuid not null references public.seasons(id) ON DELETE CASCADE,
    team_id uuid not null references public.teams(id) ON DELETE CASCADE,
    pokemon_added_id text not null,
    pokemon_dropped_id text not null,
    effective_week integer not null,
    occurred_at timestamptz not null default now(),
    notes text
);

CREATE TABLE public.trades(
    id uuid PRIMARY KEY default gen_random_uuid(),
    season_id uuid not null references public.seasons(id) ON DELETE CASCADE,
    team_a_id uuid not null references public.teams(id) ON DELETE CASCADE,
    pokemon_a_id text not null,
    team_b_id uuid not null references public.teams(id) ON DELETE CASCADE,
    pokemon_b_id text not null,
    effective_week integer not null,
    occurred_at timestamptz not null default now(),
    notes text
);

CREATE TABLE public.potw(
    id uuid PRIMARY KEY default gen_random_uuid(),
    season_id uuid not null references public.seasons(id) ON DELETE CASCADE,
    week integer not null,
    pokemon_id text not null,
    nickname text,
    team_id uuid not null references public.teams(id) ON DELETE CASCADE,
    player_id uuid not null references public.players(id) ON DELETE CASCADE,
    notes text
);

CREATE TABLE public.profiles(
    id uuid PRIMARY KEY references auth.users(id) ON DELETE CASCADE,
    display_name text,
    is_admin boolean not null default false,
    player_id uuid references public.players(id) ON DELETE SET NULL
);