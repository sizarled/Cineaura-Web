-- CineAura cast follows & blocks
-- Run in the Supabase SQL editor (safe to re-run).
--
-- Members can follow a cast / crew member (TMDB person) to receive updates
-- about new work that person takes part in, and block one to stop receiving
-- any update about work they appear in.

create table if not exists public.person_follows (
  id bigint generated always as identity primary key,
  member_id text not null,
  person_id integer not null,
  person_name text default '',
  created_at timestamptz not null default now()
);

create table if not exists public.person_blocks (
  id bigint generated always as identity primary key,
  member_id text not null,
  person_id integer not null,
  person_name text default '',
  created_at timestamptz not null default now()
);

create unique index if not exists person_follows_pair_idx on public.person_follows (member_id, person_id);
create unique index if not exists person_blocks_pair_idx on public.person_blocks (member_id, person_id);
create index if not exists person_follows_member_idx on public.person_follows (member_id, created_at desc);

alter table public.person_follows enable row level security;
alter table public.person_blocks enable row level security;

do $$

declare t text;
begin
  foreach t in array array['person_follows', 'person_blocks']
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

-- Ask PostgREST to pick up the new tables right away.
notify pgrst, 'reload schema';
