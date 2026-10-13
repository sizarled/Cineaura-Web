-- CineAura staff panel
-- Run in the Supabase SQL editor.

create table if not exists public.staff (
  id bigint generated always as identity primary key,
  role text not null,
  member_id text default '',
  username text default '',
  password text not null,
  sections text default 'accounts,links,iptv,reports,prizes,messages,settings',
  created_at timestamptz not null default now(),
  constraint staff_role_check check (role in ('super', 'admin', 'moderator'))
);

create unique index if not exists staff_one_super on public.staff (role) where role = 'super';
create unique index if not exists staff_member_uniq on public.staff (member_id) where member_id is not null and member_id <> '';

-- Default Super Admin (only inserted if none exists).
-- Username: Super Admin
-- Password: CineAura#Super9xK!mQ2
insert into public.staff (role, member_id, username, password, sections)
select
  'super',
  '',
  'Super Admin',
  'b3eb15e7a998f18c33c6d8f98217ce53daafca25e74869f19c7b523c6f43d75c',
  'accounts,links,reports,prizes,messages,staff,settings'
where not exists (select 1 from public.staff where role = 'super');

create table if not exists public.panel_settings (
  id integer primary key default 1,
  show_admin boolean not null default true,
  show_moderator boolean not null default true,
  show_member boolean not null default false,
  constraint panel_settings_one check (id = 1)
);

-- Older installs may already have panel_settings without these columns.
alter table public.panel_settings add column if not exists id integer;
alter table public.panel_settings add column if not exists show_admin boolean not null default true;
alter table public.panel_settings add column if not exists show_moderator boolean not null default true;
alter table public.panel_settings add column if not exists show_member boolean not null default false;
-- Keep a single settings row and give it id = 1.
delete from public.panel_settings
where ctid not in (select min(ctid) from public.panel_settings);
update public.panel_settings set id = 1;
create unique index if not exists panel_settings_id_uniq on public.panel_settings (id);
insert into public.panel_settings (id, show_admin, show_moderator, show_member)
select 1, true, true, false
where not exists (select 1 from public.panel_settings);

create table if not exists public.sanctions (
  member_id text primary key,
  temp_until timestamptz,
  features text default '',
  updated_at timestamptz not null default now(),
  updated_by text default ''
);

create table if not exists public.panel_messages (
  id bigint generated always as identity primary key,
  source text not null default 'member',
  sender_id text default '',
  sender_name text default '',
  sender_email text default '',
  body text not null,
  created_at timestamptz not null default now(),
  read boolean not null default false,
  constraint panel_messages_source check (source in ('member', 'contact'))
);

create table if not exists public.panel_replies (
  id bigint generated always as identity primary key,
  message_id bigint not null,
  staff_role text default '',
  staff_member_id text default '',
  body text not null,
  created_at timestamptz not null default now()
);

-- Admin messages: private chat between staff rows (Panel -> Messages -> Admin messages).
create table if not exists public.staff_messages (
  id bigint generated always as identity primary key,
  sender_staff_id bigint not null,
  sender_member_id text default '',
  sender_username text default '',
  sender_role text default '',
  receiver_staff_id bigint not null,
  receiver_member_id text default '',
  receiver_username text default '',
  receiver_role text default '',
  body text not null,
  created_at timestamptz not null default now(),
  read boolean not null default false,
  sender_deleted boolean not null default false,
  receiver_deleted boolean not null default false
);

-- Make older tables compatible (no-op on fresh installs).
alter table public.staff add column if not exists role text;
alter table public.staff add column if not exists member_id text default '';
alter table public.staff add column if not exists username text default '';
alter table public.staff add column if not exists password text default '';
alter table public.staff add column if not exists sections text default 'accounts,links,iptv,reports,prizes,messages,settings';
alter table public.staff add column if not exists created_at timestamptz default now();
alter table public.sanctions add column if not exists temp_until timestamptz;
alter table public.sanctions add column if not exists features text default '';
alter table public.sanctions add column if not exists updated_at timestamptz default now();
alter table public.sanctions add column if not exists updated_by text default '';
alter table public.panel_messages add column if not exists source text default 'member';
alter table public.panel_messages add column if not exists sender_id text default '';
alter table public.panel_messages add column if not exists sender_name text default '';
alter table public.panel_messages add column if not exists sender_email text default '';
alter table public.panel_messages add column if not exists read boolean default false;
alter table public.panel_replies add column if not exists staff_role text default '';
alter table public.panel_replies add column if not exists staff_member_id text default '';
alter table public.staff_messages add column if not exists sender_member_id text default '';
alter table public.staff_messages add column if not exists sender_username text default '';
alter table public.staff_messages add column if not exists sender_role text default '';
alter table public.staff_messages add column if not exists receiver_member_id text default '';
alter table public.staff_messages add column if not exists receiver_username text default '';
alter table public.staff_messages add column if not exists receiver_role text default '';
alter table public.staff_messages add column if not exists read boolean not null default false;
alter table public.staff_messages add column if not exists sender_deleted boolean not null default false;
alter table public.staff_messages add column if not exists receiver_deleted boolean not null default false;
create index if not exists staff_messages_sender_idx on public.staff_messages (sender_staff_id, created_at desc);
create index if not exists staff_messages_receiver_idx on public.staff_messages (receiver_staff_id, created_at desc);

alter table public.prizes add column if not exists visibility text default 'public';
alter table public.prizes add column if not exists countries text default '';
alter table public.prizes add column if not exists min_age integer;
alter table public.prizes add column if not exists max_age integer;
alter table public.prizes add column if not exists watched_type text default '';
alter table public.prizes add column if not exists watched_tmdb integer;
alter table public.prizes add column if not exists allowed_usernames text default '';
alter table public.prizes add column if not exists quantity integer;
alter table public.prizes add column if not exists unlimited_time boolean default false;

alter table public.movielink add column if not exists ban_until timestamptz;
alter table public.tvlink add column if not exists ban_until timestamptz;

alter table public.staff enable row level security;
alter table public.panel_settings enable row level security;
alter table public.sanctions enable row level security;
alter table public.panel_messages enable row level security;
alter table public.panel_replies enable row level security;
alter table public.staff_messages enable row level security;

do $$
declare t text;
begin
  foreach t in array array['staff','panel_settings','sanctions','panel_messages','panel_replies','staff_messages']
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
