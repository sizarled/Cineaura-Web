-- ============================================================
-- Watch points by country and by account level (LV0 … LV Max)
-- Run in the Supabase SQL editor AFTER points.sql and prize_secure.sql
-- (safe to run again).
--
-- One watched minute is worth
--
--        multiplier of the level of the member who earns
--        ------------------------------------------------
--        minutes of the country tier of the viewer
--
--   Country tiers (the "Watchin Rate" tables):
--     Tier 1  US CA GB                                      1 point / 1 minute
--     Tier 2  DE FR NL BE AT CH IE LU SE NO DK FI IS IT ES
--             PT GR MT CY                                   1 point / 5 minutes
--     Tier 3  SA AE QA KW BH OM PL CZ HU RO BG HR SI SK EE
--             LV LT SG ID MY                                1 point / 10 minutes
--     Tier 4  every other country (INTL)                    1 point / 50 minutes
--
--   Levels, by every point the account has earned:
--     LV0 0+ (new account) x1   LV1 10+ x1    LV2 100+ x2   LV3 1K+ x3
--     LV4 10K+ x4               LV5 100K+ x5  LV6 1M+ x6    LV7 10M+ x7
--     LV8 100M+ x8              LV9 1B+ x9    LV Max 10B+ x10
--
--   Example: Morocco is in tier 4; at LV2 a minute is worth 2 / 50 = 0.04
--   point, so 50 minutes give 2 points. In the US at LV2: 2 points a minute.
--
-- The level counts the points EARNED from every source (the _points() formula),
-- so spending points on prizes never lowers it. A new account starts at LV0 and
-- earns like LV1 (x1): it needs those first 10 points to reach LV1 at all.
--
-- Who earns, for each counted minute:
--   - the member who watches (their own minute);
--   - the member whose link was watched (views.link_owner_id), when someone
--     else watched it. Guests' minutes count for the link owner too.
--   Both at the rate of the VIEWER's country, each with their own level.
--
-- The viewer's country is the cf-ipcountry header (Cloudflare, in front of
-- Supabase, adds it to every request). Only when that header is missing is the
-- IP country found by the browser used — never the country picked in Site
-- Settings. XX (unknown) and T1 (Tor) count as "every other country".
--
-- Because the value of a minute depends on the level at that moment, watch
-- points cannot be worked out from the minutes afterwards: they are stored in
-- profiles.watch_points, with hundredths (50 minutes in tier 4 at x1 are
-- 50 x 0.02 = 1 point); whole points count. The first time this file runs,
-- the minutes already watched keep the points they had: 1 point a minute.
-- The minutes themselves (private_minutes, public_minutes) are counted as
-- before and still decide the "minutes required" of a prize.
--
-- The watch page calls watch_minute() once per counted minute. One minute per
-- viewer is credited every 45 seconds at most, and only these functions can
-- change watch_points. A minute that takes a member to a new level sends them
-- a notification.
--
-- js/common.js holds the same tables for the display (CineAura.WATCH_TIERS,
-- CineAura.POINT_LEVELS, CineAura.levelInfo).
-- ============================================================

-- ------------------------------------------------------------------ 1. stored watch points
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'profiles' and column_name = 'watch_points') then
    alter table public.profiles add column watch_points numeric(18,2);
    -- the minutes watched until now keep the points they were worth: 1 point a minute
    update public.profiles set watch_points = coalesce(private_minutes, 0) + coalesce(public_minutes, 0);
  end if;
end $$;
update public.profiles set watch_points = 0 where watch_points is null;
alter table public.profiles alter column watch_points set default 0;
alter table public.profiles alter column watch_points set not null;

comment on column public.profiles.watch_points is
  'Watch points earned (hundredths kept), credited by watch_minute(): level multiplier / minutes of the viewer''s country tier, per watched minute. Points of the minutes watched before sql/point_levels.sql: 1 a minute.';

-- When a viewer was last credited (one minute every 45 seconds at most).
create table if not exists public.watch_point_clock (
  viewer_id text primary key,
  credited_at timestamptz not null default now()
);
create index if not exists watch_point_clock_at_idx on public.watch_point_clock (credited_at);
alter table public.watch_point_clock enable row level security;
revoke all on public.watch_point_clock from anon, authenticated;

-- ------------------------------------------------------------------ 2. tiers and levels
create or replace function public.watch_tier(p_country text) returns int
language sql immutable set search_path = public as $$
  select case
    when upper(btrim(coalesce(p_country, ''))) in ('US', 'CA', 'GB') then 1
    when upper(btrim(coalesce(p_country, ''))) in ('DE', 'FR', 'NL', 'BE', 'AT', 'CH', 'IE', 'LU', 'SE', 'NO',
                                                   'DK', 'FI', 'IS', 'IT', 'ES', 'PT', 'GR', 'MT', 'CY') then 2
    when upper(btrim(coalesce(p_country, ''))) in ('SA', 'AE', 'QA', 'KW', 'BH', 'OM', 'PL', 'CZ', 'HU', 'RO',
                                                   'BG', 'HR', 'SI', 'SK', 'EE', 'LV', 'LT', 'SG', 'ID', 'MY') then 3
    else 4
  end
$$;

-- Minutes of watching for one point at x1.
create or replace function public.watch_tier_minutes(p_tier int) returns int
language sql immutable set search_path = public as $$
  select case p_tier when 1 then 1 when 2 then 5 when 3 then 10 else 50 end
$$;

-- LV0 0+, LV1 10+, LV2 100+ … LV9 1B+, LV Max (10) 10B+
create or replace function public.points_level(p_earned bigint) returns int
language sql immutable set search_path = public as $$
  select case
    when coalesce(p_earned, 0) >= 10000000000 then 10
    when p_earned >= 1000000000 then 9
    when p_earned >= 100000000 then 8
    when p_earned >= 10000000 then 7
    when p_earned >= 1000000 then 6
    when p_earned >= 100000 then 5
    when p_earned >= 10000 then 4
    when p_earned >= 1000 then 3
    when p_earned >= 100 then 2
    when p_earned >= 10 then 1
    else 0
  end
$$;

-- LV0 and LV1 x1, LV2 x2 … LV Max x10
create or replace function public.points_multiplier(p_level int) returns int
language sql immutable set search_path = public as $$
  select greatest(1, least(10, coalesce(p_level, 0)))
$$;

create or replace function public.points_level_name(p_level int) returns text
language sql immutable set search_path = public as $$
  select case when coalesce(p_level, 0) >= 10 then 'LV Max' else 'LV' || greatest(0, coalesce(p_level, 0))::text end
$$;

-- The viewer's country: Cloudflare's header when the request has one, else the
-- IP country the browser found. '' when neither is a country code.
create or replace function public._watch_country(p_country text) returns text
language plpgsql stable set search_path = public as $$
declare h jsonb; v text;
begin
  begin
    h := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    h := null;
  end;
  v := upper(btrim(coalesce(h->>'cf-ipcountry', '')));
  if v = '' then
    v := upper(btrim(coalesce(p_country, '')));
  end if;
  return case when v ~ '^[A-Z]{2}$' then v else '' end;
end $$;

-- ------------------------------------------------------------------ 3. the points formula
-- Same body as in prize_secure.sql (kept identical, so the file run last always
-- leaves the same formula). Watch points come from profiles.watch_points; on a
-- database without that column, from the minutes (1 point a minute).
create or replace function public._points(p_member text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  pr record; earned bigint; watch bigint; sh int; pl int; rc int; cm int; lk int := 0;
  dl bigint := 0; clicks bigint; has_dl boolean;
begin
  select coalesce(p.private_minutes, 0) + coalesce(p.public_minutes, 0) as mins,
         coalesce(p.points_spent, 0) as spent,
         to_jsonb(p) ->> 'watch_points' as wp
    into pr
  from public.profiles p where p.member_id = p_member;
  if not found then return jsonb_build_object('earned', 0, 'spent', 0, 'available', 0, 'watch', 0); end if;
  -- watch points: stored by sql/point_levels.sql (country tier x level); before that file, 1 a minute
  watch := case when pr.wp is null then pr.mins else floor(pr.wp::numeric)::bigint end;
  select count(*) into sh from public.post_events where kind = 'share' and network = 'referral' and member_id = p_member;
  select count(*) into pl from public.playlists where owner_id = p_member and visibility in ('public', 'exclusive');
  select count(*) into rc from public.posts where owner_id = p_member and kind in ('recommendation', 'reclist') and visibility in ('public', 'exclusive');
  select count(*) into cm from public.comments where member_id = p_member;
  -- watch links published: 500 links = 1 point; banned links do not count
  if to_regclass('public.movielink') is not null then
    select count(*) into lk from public.movielink where member_id = p_member and coalesce(banned, false) = false;
  end if;
  if to_regclass('public.tvlink') is not null then
    select lk + count(*) into lk from public.tvlink where member_id = p_member and coalesce(banned, false) = false;
  end if;
  -- Clicks on the member's download links: 1000 clicks = 1 point. The counter
  -- (movielink / tvlink .clicks) only exists after sql/links.sql has been run,
  -- so the term is skipped on a database that never had it.
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name in ('movielink', 'tvlink')
      and column_name in ('clicks', 'link_kind')
    group by column_name having count(*) = 2
  ) into has_dl;
  if coalesce(has_dl, false) then
    if to_regclass('public.movielink') is not null then
      execute 'select coalesce(sum(clicks), 0) from public.movielink
               where member_id = $1 and coalesce(link_kind, ''watch'') = ''download'''
        into clicks using p_member;
      dl := dl + coalesce(clicks, 0);
    end if;
    if to_regclass('public.tvlink') is not null then
      execute 'select coalesce(sum(clicks), 0) from public.tvlink
               where member_id = $1 and coalesce(link_kind, ''watch'') = ''download'''
        into clicks using p_member;
      dl := dl + coalesce(clicks, 0);
    end if;
  end if;
  earned := watch + sh / 5 + pl / 10 + rc / 50 + cm / 100 + lk / 500 + dl / 1000;
  return jsonb_build_object('earned', earned, 'spent', pr.spent, 'available', greatest(0, earned - pr.spent), 'watch', watch);
end $$;

-- ------------------------------------------------------------------ 4. crediting a minute
-- Adds one minute's worth of watch points to a member, at their current level.
-- NULL when the member has no profile (a guest id). Caller: watch_minute().
create or replace function public._credit_watch(p_member text, p_minutes int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  wp_before numeric; wp_after numeric; earned bigint; lv int; lv_after int; mult int; gain numeric(18,2);
begin
  if coalesce(p_member, '') = '' then return null; end if;
  select coalesce(watch_points, 0) into wp_before from public.profiles where member_id = p_member for update;
  if not found then return null; end if;
  earned := coalesce((public._points(p_member)->>'earned')::bigint, 0);
  lv := public.points_level(earned);
  mult := public.points_multiplier(lv);
  gain := round(mult::numeric / greatest(1, coalesce(p_minutes, 50)), 2);
  update public.profiles set watch_points = coalesce(watch_points, 0) + gain
   where member_id = p_member
  returning watch_points into wp_after;
  lv_after := public.points_level(earned - floor(wp_before)::bigint + floor(wp_after)::bigint);
  if lv_after > lv and to_regclass('public.notifications') is not null then
    insert into public.notifications (member_id, kind, title, body, href)
    values (p_member, 'points_level', 'New level',
            public.points_level_name(lv_after) || ' · ×' || public.points_multiplier(lv_after)::text,
            './dashboard.html#prizes');
  end if;
  return jsonb_build_object('level', lv, 'multiplier', mult, 'gain', gain, 'watch_points', wp_after, 'level_after', lv_after);
end $$;

-- Called by the watch page for every counted minute of a view (public.views.id).
--   p_viewer   the member id, or the guest id, the view row was created with
--   p_country  the IP country the browser found (used only without cf-ipcountry)
-- -> { ok, country, tier, minutes, viewer?: {level, multiplier, gain, watch_points, level_after}, owner?: {gain} }
--    { ok: false, reason: bad_request | not_found | too_soon }
create or replace function public.watch_minute(p_view bigint, p_viewer text, p_country text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v record; cc text; tier int; mins int; res jsonb; got jsonb;
begin
  p_viewer := btrim(coalesce(p_viewer, ''));
  if p_view is null or p_viewer = '' or length(p_viewer) > 120 then
    return jsonb_build_object('ok', false, 'reason', 'bad_request');
  end if;
  select viewer_id, coalesce(link_owner_id, '') as owner into v from public.views where id = p_view;
  if not found or v.viewer_id is distinct from p_viewer then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  -- one credited minute per viewer every 45 seconds
  insert into public.watch_point_clock as c (viewer_id, credited_at) values (p_viewer, now())
  on conflict (viewer_id) do update set credited_at = excluded.credited_at
   where c.credited_at <= now() - interval '45 seconds';
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'too_soon');
  end if;
  if random() < 0.01 then
    delete from public.watch_point_clock where credited_at < now() - interval '2 days';
  end if;
  cc := public._watch_country(p_country);
  tier := public.watch_tier(cc);
  mins := public.watch_tier_minutes(tier);
  res := jsonb_build_object('ok', true, 'country', cc, 'tier', tier, 'minutes', mins);
  got := public._credit_watch(p_viewer, mins);
  if got is not null then
    res := res || jsonb_build_object('viewer', got);
  end if;
  if v.owner <> '' and v.owner <> p_viewer then
    got := public._credit_watch(v.owner, mins);
    if got is not null then
      res := res || jsonb_build_object('owner', jsonb_build_object('gain', got->'gain'));
    end if;
  end if;
  return res;
end $$;

-- ------------------------------------------------------------------ 5. nobody else writes watch_points
create or replace function public._guard_watch_points() returns trigger language plpgsql as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      new.watch_points := 0;
    else
      new.watch_points := old.watch_points;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists profiles_guard_watch_points on public.profiles;
create trigger profiles_guard_watch_points before insert or update on public.profiles
  for each row execute function public._guard_watch_points();

-- ------------------------------------------------------------------ 6. who may call what
-- _spend_prize (prize_secure.sql) reads 'available' as a bigint from here on.
create or replace function public._spend_prize(p_member text, p_amount int, p_prize text, p_mode text) returns boolean
language plpgsql security definer set search_path = public as $$
declare pts jsonb;
begin
  if p_amount <= 0 then return true; end if;
  perform 1 from public.profiles where member_id = p_member for update;
  if not found then return false; end if;
  pts := public._points(p_member);
  if (pts->>'available')::bigint < p_amount then return false; end if;
  update public.profiles set points_spent = coalesce(points_spent, 0) + p_amount where member_id = p_member;
  insert into public.point_spends (member_id, amount, prize_title, mode) values (p_member, p_amount, coalesce(p_prize, ''), coalesce(p_mode, ''));
  return true;
end $$;

revoke all on function public._points(text) from public, anon, authenticated;
revoke all on function public._spend_prize(text, int, text, text) from public, anon, authenticated;
revoke all on function public._watch_country(text) from public, anon, authenticated;
revoke all on function public._credit_watch(text, int) from public, anon, authenticated;
revoke all on function public._guard_watch_points() from public, anon, authenticated;
revoke all on function public.watch_minute(bigint, text, text) from public, anon, authenticated;
grant execute on function public.watch_minute(bigint, text, text) to anon, authenticated;
grant execute on function public.watch_tier(text) to anon, authenticated;
grant execute on function public.watch_tier_minutes(int) to anon, authenticated;
grant execute on function public.points_level(bigint) to anon, authenticated;
grant execute on function public.points_multiplier(int) to anon, authenticated;
grant execute on function public.points_level_name(int) to anon, authenticated;

notify pgrst, 'reload schema';
