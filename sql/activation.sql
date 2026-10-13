-- CineAura activation codes
-- Run in the Supabase SQL editor.

create table if not exists public.activation (
  id bigint generated always as identity primary key,
  activation_code text unique not null,
  member_id text,
  membership_type text not null,
  duration text not null,
  started_at timestamptz,
  expires_at timestamptz,
  ip text,
  country text,
  used boolean not null default false,
  used_at timestamptz,
  kind text default 'activate'
);

alter table public.activation drop constraint if exists activation_type_check;
alter table public.activation add constraint activation_type_check
  check (membership_type in ('Free', 'Silver', 'Gold', 'Diamond'));

create unique index if not exists activation_code_idx on public.activation (activation_code);

comment on table public.activation is 'One-time membership activation codes';
comment on column public.activation.activation_code is 'One-time code; duration starts on first use';
comment on column public.activation.used is 'A code can be used only once';

-- Example premium codes (optional):
-- insert into public.activation (activation_code, membership_type, duration)
-- values ('SILVERDEMOCODE01', 'Silver', '3 months'),
--        ('GOLDDEMOCODE0001', 'Gold', '6 months'),
--        ('DIAMONDDEMOCODE1', 'Diamond', '12 months');

alter table public.activation enable row level security;

drop policy if exists "Activation select" on public.activation;
create policy "Activation select"
  on public.activation for select to anon, authenticated using (true);

drop policy if exists "Activation insert" on public.activation;
create policy "Activation insert"
  on public.activation for insert to anon, authenticated with check (true);

drop policy if exists "Activation update" on public.activation;
create policy "Activation update"
  on public.activation for update to anon, authenticated using (true) with check (true);
