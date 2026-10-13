-- ============================================================
-- Prize subscription modes
-- Run once in the Supabase SQL editor (safe to run again).
--
-- Every prize supports at least one mode and can support all three:
--   gift      — pay the points and get the prize. Costs the most points but
--               gives the most time: it stays open for the prize window
--               (starts_at .. ends_at).
--   challenge — cheaper to join, but the winner is the one who completes the
--               required actions (prize_mode_conditions) first. Limited by
--               `quantity`, and usually open for a longer window than gift.
--   lottery   — the cheapest to join and the biggest prizes. No end date;
--               limited by `winners_needed`. The draw runs once `draw_at`
--               members have joined.
--
-- Points are the watch minutes of the member
-- (profiles.private_minutes + profiles.public_minutes), the same balance the
-- dashboard already spends when a prize is claimed.
--
-- Without this file the prize page still works: every prize is shown with a
-- single gift mode built from its own row (minutes_required, starts_at,
-- ends_at, quantity, winners_needed, subscribers_needed).
-- ============================================================

-- 1) One row per supported mode of a prize.
create table if not exists public.prize_modes (
  id bigint generated always as identity primary key,
  prize_id bigint not null,
  mode text not null,
  points_cost integer not null default 0,   -- points needed to subscribe
  starts_at date,                           -- opening of the subscription window
  ends_at date,                             -- gift/challenge: closing date; lottery: null
  unlimited_time boolean default false,     -- no closing date
  quantity integer,                         -- challenge: winner slots available
  winners_needed integer,                   -- lottery: winners picked by the draw
  draw_at integer,                          -- lottery: participants needed before the draw
  terms text default '',                    -- extra terms of this mode (one per line)
  sort_order integer default 0,
  created_at timestamptz default now(),
  constraint prize_modes_mode_check check (mode in ('gift', 'challenge', 'lottery')),
  unique (prize_id, mode)
);
create index if not exists prize_modes_prize_idx on public.prize_modes (prize_id);

-- 2) The actions a mode requires. Every kind is checked like this:
--      watch  — the member must have watched the title (tmdb_id / media_type)
--      share  — the member must have shared the title (progress is recorded
--               in prize_mode_progress)
--      invite — `required` new members must register (progress recorded too)
--      points — collect `required` watch points inside the window
create table if not exists public.prize_mode_conditions (
  id bigint generated always as identity primary key,
  mode_id bigint not null,
  kind text not null,
  media_type text,                          -- movie | tv (watch / share)
  tmdb_id integer,                          -- target title (watch / share)
  required integer not null default 1,
  title text default '',                    -- optional label shown to the member
  sort_order integer default 0,
  constraint prize_mode_conditions_kind_check
    check (kind in ('watch', 'share', 'invite', 'points'))
);
create index if not exists prize_mode_conditions_mode_idx on public.prize_mode_conditions (mode_id);

-- 3) Subscriptions: one row per member per mode.
--    status: competitor (still playing), winner, excluded, withdrawn.
--    A gift subscription is a winner as soon as the points are paid.
create table if not exists public.prize_mode_entries (
  id bigint generated always as identity primary key,
  prize_id bigint not null,
  mode_id bigint not null,
  member_id text not null,
  mode text not null,
  points_paid integer default 0,
  status text default 'competitor',
  lottery_wins integer default 0,           -- lottery: draws this member won
  lottery_plays integer default 0,          -- lottery: draws this member entered
  created_at timestamptz default now(),
  constraint prize_mode_entries_status_check
    check (status in ('competitor', 'winner', 'excluded', 'withdrawn')),
  constraint prize_mode_entries_mode_check
    check (mode in ('gift', 'challenge', 'lottery')),
  unique (mode_id, member_id)
);
create index if not exists prize_mode_entries_prize_idx on public.prize_mode_entries (prize_id);
create index if not exists prize_mode_entries_member_idx on public.prize_mode_entries (member_id);

-- 4) Progress of one member on one required action. The page computes `watch`
--    and `points` from the member data; `share` and `invite` are written here
--    by the panel/staff or by the member's own actions.
create table if not exists public.prize_mode_progress (
  id bigint generated always as identity primary key,
  entry_id bigint not null,
  condition_id bigint not null,
  progress integer default 0,
  updated_at timestamptz default now(),
  unique (entry_id, condition_id)
);
create index if not exists prize_mode_progress_entry_idx on public.prize_mode_progress (entry_id);

-- 5) Seed a gift mode for every prize that has none yet, so the prize page
--    keeps showing the same window and cost it already used.
insert into public.prize_modes (prize_id, mode, points_cost, starts_at, ends_at, unlimited_time, quantity, winners_needed, draw_at, terms)
select p.id, 'gift', coalesce(p.minutes_required, 0), p.starts_at, p.ends_at,
       coalesce(p.unlimited_time, false), p.quantity, p.winners_needed, p.subscribers_needed, coalesce(p.terms, '')
from public.prizes p
where not exists (select 1 from public.prize_modes m where m.prize_id = p.id);

-- 6) Same open policies as the other site tables (the site talks to Supabase
--    with the anon key).
alter table public.prize_modes enable row level security;
alter table public.prize_mode_conditions enable row level security;
alter table public.prize_mode_entries enable row level security;
alter table public.prize_mode_progress enable row level security;

do $$
declare t text;
begin
  foreach t in array array['prize_modes','prize_mode_conditions','prize_mode_entries','prize_mode_progress']
  loop
    execute format('drop policy if exists "open select" on public.%I', t);
    execute format('create policy "open select" on public.%I for select to anon, authenticated using (true)', t);
    execute format('drop policy if exists "open insert" on public.%I', t);
    execute format('create policy "open insert" on public.%I for insert to anon, authenticated with check (true)', t);
    execute format('drop policy if exists "open update" on public.%I', t);
    execute format('create policy "open update" on public.%I for update to anon, authenticated using (true) with check (true)', t);
    execute format('drop policy if exists "open delete" on public.%I', t);
    execute format('create policy "open delete" on public.%I for delete to anon, authenticated using (true)', t);
  end loop;
end $$;
