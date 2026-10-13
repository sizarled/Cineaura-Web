-- CineAura dashboard tables
-- Run in the Supabase SQL editor.

alter table public.codes add column if not exists ip text;
alter table public.codes add column if not exists owner text;
alter table public.codes add column if not exists duration text;

drop policy if exists "Codes insert" on public.codes;
create policy "Codes insert" on public.codes for insert to anon, authenticated with check (true);
drop policy if exists "Codes update" on public.codes;
create policy "Codes update" on public.codes for update to anon, authenticated using (true) with check (true);
drop policy if exists "Codes delete" on public.codes;
create policy "Codes delete" on public.codes for delete to anon, authenticated using (true);

drop policy if exists "Members update" on public.members;
create policy "Members update" on public.members for update to anon, authenticated using (true) with check (true);

create table if not exists public.profiles (
  member_id text primary key,
  username text unique not null,
  bio text default '',
  membership_type text default 'Free',
  private_minutes integer default 0,
  public_minutes integer default 0,
  avatar_url text default '',
  followers integer default 0,
  following integer default 0,
  theme text default 'night',
  language text default 'en',
  region text default '',
  country text default ''
);

-- CREATE TABLE does not update an existing table, so add preferences for older installs too.
alter table public.profiles add column if not exists theme text default 'night';
alter table public.profiles add column if not exists language text default 'en';

create table if not exists public.playlists (
  playlist_id text primary key,
  name text not null,
  description text default '',
  owner_username text not null,
  owner_id text not null,
  media_type text not null check (media_type in ('movie', 'tv')),
  kind text not null default 'custom',
  list_key text default 'custom',
  visibility text not null default 'private',
  created_at timestamptz default now(),
  viewers integer default 0,
  watch_minutes integer default 0,
  avatar_url text default '',
  require_member boolean default false,
  require_followers boolean default false,
  countries text default '',
  max_age integer,
  gender text default 'any',
  rules text default ''
);

alter table public.playlists add column if not exists rules text default '';

create table if not exists public.playlist_items (
  id bigint generated always as identity primary key,
  playlist_id text not null,
  tmdb_id integer not null,
  media_type text not null,
  title text default '',
  poster_path text default '',
  added_at timestamptz default now(),
  visibility text default 'private'
);

create table if not exists public.playlist_access (
  id bigint generated always as identity primary key,
  playlist_id text not null,
  username text not null
);

create table if not exists public.iptv (
  id bigint generated always as identity primary key,
  name text not null,
  owner_id text,
  type text not null default 'free',
  m3u_url text default '',
  xstream_user text default '',
  xstream_password text default '',
  duration text default 'unlimited'
);

create table if not exists public.listchannels (
  id bigint generated always as identity primary key,
  package_name text not null,
  channel_name text not null,
  group_name text default 'General',
  logo_url text default '',
  channel_type text default 'live'
);

create table if not exists public.views (
  id bigint generated always as identity primary key,
  viewer_id text not null,
  tmdb_id integer not null,
  media_type text default 'movie',
  playlist_id text default '',
  started_at timestamptz default now(),
  minutes integer default 0,
  link_owner_id text default ''
);

alter table public.views add column if not exists link_owner_id text default '';
alter table public.views add column if not exists watch_url text default '';
alter table public.views add column if not exists season integer;
alter table public.views add column if not exists episode integer;
-- Post attribution: watch links shared inside a post carry &post=POST_ID,
-- so the watched minutes can be credited to the post owner and used to rank search results.
alter table public.views add column if not exists post_id text default '';
create index if not exists views_post_idx on public.views (post_id);

create table if not exists public.prizes (
  id bigint generated always as identity primary key,
  title text not null,
  description text default '',
  minutes_required integer not null default 0,
  winners_count integer default 0,
  winners_needed integer default 1,
  group_name text default 'General',
  group_thumb text default '',
  prize_image text default '',
  starts_at date,
  ends_at date
);

create table if not exists public.winners (
  id bigint generated always as identity primary key,
  prize_title text not null,
  member_id text not null,
  minutes_paid integer default 0,
  awarded_at timestamptz default now(),
  ends_at date,
  group_name text default ''
);

create table if not exists public.hestory (
  id bigint generated always as identity primary key,
  tmdb_id integer not null,
  media_type text not null,
  visitor_id text not null,
  visited_at timestamptz default now(),
  title text default '',
  poster_path text default ''
);

alter table public.profiles enable row level security;
alter table public.playlists enable row level security;
alter table public.playlist_items enable row level security;
alter table public.playlist_access enable row level security;
alter table public.iptv enable row level security;
alter table public.listchannels enable row level security;
alter table public.views enable row level security;
alter table public.prizes enable row level security;
alter table public.winners enable row level security;
alter table public.hestory enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'profiles','playlists','playlist_items','playlist_access','iptv',
    'listchannels','views','prizes','winners','hestory'
  ]
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
