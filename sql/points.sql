-- ============================================================
-- Points: what a member can spend on prizes
-- Run once in the Supabase SQL editor (safe to run again).
--
-- A member earns points from seven sources, each at its own rate:
--
--   watch minutes — watched by the member, or watched by someone
--                   through a link the member published:
--                   1 point per 1 / 5 / 10 / 50 minutes depending on the
--                   viewer's country, times the multiplier of the member's
--                   level (sql/point_levels.sql; 1 point a minute before it)
--   5 new-member registrations attributed to the member's shared links = 1 point
--   500 watch links published by the member (movielink + tvlink,
--       banned links excluded)                              = 1 point
--   1000 clicks on the member's download links (the same
--        tables, link_kind = 'download'; the watch page moves
--        the clicks counter)                                = 1 point
--   10 public or exclusive playlists created by the member  = 1 point
--   50 public or exclusive recommendations created by the
--      member (including the ones posted in a recommendation
--      list)                                                = 1 point
--   100 comments written by the member                      = 1 point
--
-- Fractions are dropped: 12 referred registrations are worth 2 points, not 2.4.
--
-- Point totals are not stored per source. Counts are read live from the activity
-- tables; the private member_referrals table only guarantees one conversion per new account:
--
--   minutes          profiles.watch_points (stored when each minute is credited,
--                    sql/point_levels.sql); without that file
--                    profiles.private_minutes + profiles.public_minutes
--   shares           post_events      where kind = 'share', network = 'referral', and member_id = me
--   links            movielink + tvlink where member_id = me and banned = false
--   downloads        sum(clicks) of movielink + tvlink where member_id = me
--                                     and link_kind = 'download'
--   playlists        playlists        where owner_id = me
--                                     and visibility in ('public','exclusive')
--   recommendations  posts            where owner_id = me
--                                     and kind in ('recommendation','reclist')
--                                     and visibility in ('public','exclusive')
--   comments         comments         where member_id = me
--
-- Only what has already been spent is stored, so the same bonus points cannot
-- be spent twice and the watch minutes themselves are never destroyed:
--
--   available points = earned points - points_spent
--
-- Every spend is also written to public.point_spends (with the prize and the mode), so the
-- profile page can show where the spent points went. Spends made before this table existed
-- are shown as one "earlier" row (points_spent minus the logged total).
--
-- js/common.js holds the formula (CineAura.POINT_RATES, CineAura.memberPoints,
-- CineAura.memberSpends); the prize page, the dashboard and the profile read it.
--
-- ORDER: run this file BEFORE prize_secure.sql (prize_secure.sql writes point_spends and
-- holds the server-side _points() formula used when points are spent).
-- ============================================================

-- 1) The spending ledger.
alter table public.profiles add column if not exists points_spent integer default 0;

update public.profiles set points_spent = 0 where points_spent is null;

comment on column public.profiles.points_spent is
  'Points already spent on prizes. Available points = earned points - points_spent.';

-- 2) Carry what members already paid onto the new ledger.
--
-- Before this, a prize was paid by shrinking the watch minutes: the dashboard
-- recomputed the minutes from public.views and subtracted winners.minutes_paid.
-- js/dashboard.js no longer does that subtraction (otherwise every claim would
-- be charged twice — once here and once through the minutes), so the history
-- has to move into points_spent or those members would get their points back.
--
-- Only runs for members that have not spent anything on the new ledger yet.
update public.profiles p
set points_spent = coalesce(w.paid, 0)
from (
  select member_id, sum(coalesce(minutes_paid, 0)) as paid
  from public.winners
  group by member_id
) w
where p.member_id = w.member_id
  and coalesce(p.points_spent, 0) = 0
  and coalesce(w.paid, 0) > 0;

-- 3) Referral conversions are created by the members registration trigger;
--    the browser cannot insert or edit/delete a share conversion directly.
comment on column public.post_events.member_id is
  'Member whose shared post link generated the new registration; 5 new registrations earn 1 point.';

-- 4) Indexes for the six counters, so counting a member stays cheap.
create index if not exists post_events_referral_member_idx
  on public.post_events (member_id, created_at desc) where kind = 'share' and network = 'referral';
create index if not exists playlists_owner_vis_idx
  on public.playlists (owner_id, visibility);
create index if not exists posts_owner_kind_vis_idx
  on public.posts (owner_id, kind, visibility);
create index if not exists comments_member_idx
  on public.comments (member_id);
do $$
begin
  if to_regclass('public.movielink') is not null then
    create index if not exists movielink_member_points_idx on public.movielink (member_id) where banned = false;
  end if;
  if to_regclass('public.tvlink') is not null then
    create index if not exists tvlink_member_points_idx on public.tvlink (member_id) where banned = false;
  end if;
end $$;

-- 5) The spending ledger: one row per spend, written only by the server (prize_secure.sql).
--    Readable like the winners table; the browser can never insert, change or delete a row.
create table if not exists public.point_spends (
  id bigint generated always as identity primary key,
  member_id text not null,
  amount integer not null,
  prize_title text not null default '',
  mode text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists point_spends_member_idx on public.point_spends (member_id, created_at desc);
comment on table public.point_spends is 'Points spent on prizes, one row per spend (amount > 0). Written by the server only.';
alter table public.point_spends enable row level security;
drop policy if exists "PointSpends select" on public.point_spends;
create policy "PointSpends select" on public.point_spends for select to anon, authenticated using (true);
revoke insert, update, delete on public.point_spends from anon, authenticated;

-- Ask PostgREST to pick up the new column right away.
notify pgrst, 'reload schema';
