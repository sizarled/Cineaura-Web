-- ============================================================
-- Prize center: categories (groups), prize pages, subscriptions
-- Run once in the Supabase SQL editor (safe to run again).
-- ============================================================

-- 1) Categories. The numeric id is what appears in the URL:
--    ./Prize.html?GroupPrize=<prize_groups.id>&Prize=<prizes.id>
create table if not exists public.prize_groups (
  id bigint generated always as identity primary key,
  name text not null,
  thumb text default '',
  visible boolean default true,      -- staff can hide a category from the Prizes page
  sort_order integer default 0,
  created_at timestamptz default now()
);

-- 2) Extra prize fields used by the prize page
alter table public.prizes add column if not exists group_id bigint;
alter table public.prizes add column if not exists images text default '';          -- one image URL per line (carousel)
alter table public.prizes add column if not exists video_url text default '';       -- embeddable video link
alter table public.prizes add column if not exists terms text default '';           -- free-text conditions shown under the description
alter table public.prizes add column if not exists subscribers_needed integer;     -- target number of subscribers (empty = no target)
alter table public.prizes add column if not exists created_at timestamptz default now();

-- 3) Create a category for every group name already used by existing prizes,
--    then link the prizes to it.
insert into public.prize_groups (name, thumb)
select p.group_name, coalesce(max(nullif(p.group_thumb, '')), '')
from public.prizes p
where coalesce(p.group_name, '') <> ''
  and not exists (select 1 from public.prize_groups g where g.name = p.group_name)
group by p.group_name;

update public.prizes p
set group_id = g.id
from public.prize_groups g
where p.group_id is null and g.name = p.group_name;

create index if not exists prizes_group_idx on public.prizes (group_id);

-- 4) Subscriptions: one row per member per prize
create table if not exists public.prize_entries (
  id bigint generated always as identity primary key,
  prize_id bigint not null,
  member_id text not null,
  created_at timestamptz default now(),
  unique (prize_id, member_id)
);
create index if not exists prize_entries_prize_idx on public.prize_entries (prize_id);
create index if not exists prize_entries_member_idx on public.prize_entries (member_id);

-- 5) Same open policies as the other site tables (the site talks to Supabase with the anon key)
alter table public.prize_groups enable row level security;
alter table public.prize_entries enable row level security;

do $$
declare t text;
begin
  foreach t in array array['prize_groups','prize_entries']
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
