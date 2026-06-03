CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND is_admin = true
  );
$$;

ALTER TABLE public.seasons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read" ON public.seasons;
CREATE POLICY "Anyone can read" ON public.seasons
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Admins can modify" ON public.seasons;
CREATE POLICY "Admins can modify" ON public.seasons
  FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

ALTER TABLE public.season_pokemon_tiers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read" ON public.season_pokemon_tiers;
CREATE POLICY "Anyone can read" ON public.season_pokemon_tiers
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Admins can modify" ON public.season_pokemon_tiers;
CREATE POLICY "Admins can modify" ON public.season_pokemon_tiers
  FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

ALTER TABLE public.drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read" ON public.drafts;
CREATE POLICY "Anyone can read" ON public.drafts
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Admins can modify" ON public.drafts;
CREATE POLICY "Admins can modify" ON public.drafts
  FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

ALTER TABLE public.players ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read" ON public.players;
CREATE POLICY "Anyone can read" ON public.players
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Admins can modify" ON public.players;
CREATE POLICY "Admins can modify" ON public.players
  FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

ALTER TABLE public.showdown_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read" ON public.showdown_accounts;
CREATE POLICY "Anyone can read" ON public.showdown_accounts
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Admins can modify" ON public.showdown_accounts;
CREATE POLICY "Admins can modify" ON public.showdown_accounts
  FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read" ON public.teams;
CREATE POLICY "Anyone can read" ON public.teams
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Admins can modify" ON public.teams;
CREATE POLICY "Admins can modify" ON public.teams
  FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

ALTER TABLE public.team_owners ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read" ON public.team_owners;
CREATE POLICY "Anyone can read" ON public.team_owners
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Admins can modify" ON public.team_owners;
CREATE POLICY "Admins can modify" ON public.team_owners
  FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

ALTER TABLE public.team_pokemon ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read" ON public.team_pokemon;
CREATE POLICY "Anyone can read" ON public.team_pokemon
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Admins can modify" ON public.team_pokemon;
CREATE POLICY "Admins can modify" ON public.team_pokemon
  FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

ALTER TABLE public.matches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read" ON public.matches;
CREATE POLICY "Anyone can read" ON public.matches
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Admins can modify" ON public.matches;
CREATE POLICY "Admins can modify" ON public.matches
  FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

ALTER TABLE public.games ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read" ON public.games;
CREATE POLICY "Anyone can read" ON public.games
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Admins can modify" ON public.games;
CREATE POLICY "Admins can modify" ON public.games
  FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

ALTER TABLE public.game_pokemon_stats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read" ON public.game_pokemon_stats;
CREATE POLICY "Anyone can read" ON public.game_pokemon_stats
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Admins can modify" ON public.game_pokemon_stats;
CREATE POLICY "Admins can modify" ON public.game_pokemon_stats
  FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

ALTER TABLE public.free_agency_moves ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read" ON public.free_agency_moves;
CREATE POLICY "Anyone can read" ON public.free_agency_moves
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Admins can modify" ON public.free_agency_moves;
CREATE POLICY "Admins can modify" ON public.free_agency_moves
  FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read" ON public.trades;
CREATE POLICY "Anyone can read" ON public.trades
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Admins can modify" ON public.trades;
CREATE POLICY "Admins can modify" ON public.trades
  FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

ALTER TABLE public.potw ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read" ON public.potw;
CREATE POLICY "Anyone can read" ON public.potw
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Admins can modify" ON public.potw;
CREATE POLICY "Admins can modify" ON public.potw
  FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own profile" ON public.profiles;
CREATE POLICY "Users can read own profile" ON public.profiles
  FOR SELECT USING (id = (select auth.uid()));

DROP POLICY IF EXISTS "Admins can modify" ON public.profiles;
CREATE POLICY "Admins can modify" ON public.profiles
  FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());
