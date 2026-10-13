-- CineAura access codes
-- Run this in the Supabase SQL editor if the table has not been created yet.

create table if not exists public.codes (
  id bigint generated always as identity primary key,
  owner text not null,
  code text not null unique,
  status text not null default 'active',
  duration text,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  ip text,
  constraint codes_owner_format check (owner ~ '^ID[0-9]+$'),
  constraint codes_code_format check (code ~ '^[0-9]{6}$'),
  constraint codes_status_check check (
    status in ('active', 'disabled', 'banned', 'expired')
  )
);

comment on table public.codes is 'CineAura membership access codes';
comment on column public.codes.owner is 'Account id of the code creator, formatted as ID followed by digits';
comment on column public.codes.code is 'Six-digit access code';
comment on column public.codes.status is 'active | disabled | banned | expired';
comment on column public.codes.duration is 'Plan length, e.g. 1 month, 3 months, 6 months, 12 months';
comment on column public.codes.ip is 'Public IP bound to this access code';

alter table public.codes add column if not exists ip text;
alter table public.codes add column if not exists duration text;
alter table public.codes add column if not exists owner text;

-- Age tiers: which ratings a code may unlock. A code only opens a title whose
-- certificate sits inside its ceiling, so a parent can give a child a code that
-- cannot reach older content. null (codes saved before this column) = no limit.
--   u13   -> for viewers under 13 (G, TV-Y, TV-Y7, TV-G, PG, U, 0+, 6, 12)
--   u16   -> for viewers under 16 (adds PG-13, TV-14, 13, 14, 15, M)
--   u18   -> for viewers under 18 (adds R, 16, 17)
--   adult -> 18 and over, unrestricted (adds TV-MA, 18, 18+, NC-17, X)
alter table public.codes add column if not exists age_rating text;

alter table public.codes drop constraint if exists codes_age_rating_check;
alter table public.codes add constraint codes_age_rating_check check (
  age_rating in ('u13', 'u16', 'u18', 'adult')
);

comment on column public.codes.age_rating is
  'Age tier this code may unlock: u13 | u16 | u18 | adult (null = no limit)';

create index if not exists codes_code_idx on public.codes (code);
create index if not exists codes_owner_idx on public.codes (owner);
create index if not exists codes_age_idx on public.codes (age_rating);

alter table public.codes enable row level security;

drop policy if exists "Verify access codes" on public.codes;
create policy "Verify access codes"
  on public.codes
  for select
  to anon, authenticated
  using (true);

drop policy if exists "Owners insert codes" on public.codes;
drop policy if exists "Codes insert" on public.codes;
create policy "Codes insert"
  on public.codes
  for insert
  to anon, authenticated
  with check (true);

drop policy if exists "Codes update" on public.codes;
create policy "Codes update"
  on public.codes
  for update
  to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "Codes delete" on public.codes;
create policy "Codes delete"
  on public.codes
  for delete
  to anon, authenticated
  using (true);
