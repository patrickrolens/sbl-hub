CREATE TABLE public.seasons(
    id uuid PRIMARY KEY default gen_random_uuid(),
    slug text unique not null,
    name text unique not null,
    vgc_format text,
    point_limit integer default 0,
    team_size integer default 10,
    started_at date,
    ended_at date,
    is_current boolean not null default false
);

CREATE UNIQUE INDEX seasons_one_current_idx
    ON public.seasons (is_current)
    WHERE is_current;

CREATE TABLE public.season_pokemon_tiers(
    id uuid PRIMARY KEY default gen_random_uuid(),
    season_id uuid not null references public.seasons(id) ON DELETE CASCADE,
    pokemon_id text not null,
    point_cost integer,
    constraint unique_season_pokemon unique(season_id, pokemon_id)
);

CREATE TABLE public.drafts(
    id uuid PRIMARY KEY default gen_random_uuid(),
    season_id uuid unique not null references public.seasons(id) ON DELETE CASCADE,
    draft_order uuid[],
    status text not null default 'pending'
        CHECK (status IN('pending', 'in_progress', 'complete')),
    current_pick_number integer,
    started_at timestamptz,
    completed_at timestamptz
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
    started_week integer not null,
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
    notes text
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
    winner_team_id uuid GENERATED ALWAYS AS (
        CASE
            WHEN team_a_score > series_length / 2 THEN team_a_id
            WHEN team_b_score > series_length / 2 THEN team_b_id
            ELSE NULL
        END
    ) STORED
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