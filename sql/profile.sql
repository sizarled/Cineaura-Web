-- CineAura social profile
-- Run in the Supabase SQL editor.

alter table public.profiles add column if not exists display_name text default '';
alter table public.profiles add column if not exists follow_policy text default 'instant';
alter table public.profiles add column if not exists show_country boolean default true;
alter table public.profiles add column if not exists show_gender boolean default true;
alter table public.profiles add column if not exists show_language boolean default true;
alter table public.profiles add column if not exists websites text default '';

create table if not exists public.follows (
  id bigint generated always as identity primary key,
  follower_id text not null,
  following_id text not null,
  follower_username text default '',
  following_username text default '',
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  constraint follows_status_check check (status in ('pending', 'accepted', 'rejected'))
);

create table if not exists public.blocks (
  id bigint generated always as identity primary key,
  blocker_id text not null,
  blocked_id text not null,
  blocker_username text default '',
  blocked_username text default '',
  kind text not null default 'full',
  features text default '',
  created_at timestamptz not null default now(),
  constraint blocks_kind_check check (kind in ('full', 'partial'))
);

create table if not exists public.messages (
  id bigint generated always as identity primary key,
  sender_id text not null,
  receiver_id text not null,
  sender_username text default '',
  receiver_username text default '',
  body text not null,
  created_at timestamptz not null default now(),
  read boolean not null default false
);

create table if not exists public.notifications (
  id bigint generated always as identity primary key,
  member_id text not null,
  kind text default 'info',
  title text default '',
  body text default '',
  href text default '',
  from_id text default '',
  from_username text default '',
  created_at timestamptz not null default now(),
  read boolean not null default false
);

create table if not exists public.posts (
  id bigint generated always as identity primary key,
  post_id text unique not null,
  owner_id text not null,
  owner_username text not null,
  kind text not null,
  title text not null,
  body text default '',
  visibility text not null default 'public',
  playlist_id text default '',
  require_followers boolean default false,
  min_age integer,
  max_age integer,
  languages text default '',
  countries text default '',
  watched_tmdb text default '',
  year_mode text default '',
  year_value integer,
  actors text default '',
  directors text default '',
  titles text default '',
  created_at timestamptz not null default now(),
  constraint posts_kind_check check (kind in ('playlist', 'recommendation', 'reclist', 'account', 'review')),
  constraint posts_vis_check check (visibility in ('public', 'exclusive', 'private'))
);

create table if not exists public.post_items (
  id bigint generated always as identity primary key,
  post_id text not null,
  tmdb_id integer not null,
  media_type text not null,
  title text default '',
  poster_path text default '',
  rating numeric default 0
);

create table if not exists public.post_access (
  id bigint generated always as identity primary key,
  post_id text not null,
  username text not null
);

create table if not exists public.post_votes (
  id bigint generated always as identity primary key,
  post_id text not null,
  member_id text not null,
  username text default '',
  vote text not null,
  created_at timestamptz not null default now(),
  constraint post_votes_vote_check check (vote in ('up', 'down'))
);

create table if not exists public.post_comments (
  id bigint generated always as identity primary key,
  post_id text not null,
  member_id text not null,
  username text default '',
  comment text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.updates (
  id bigint generated always as identity primary key,
  actor_id text not null,
  actor_username text default '',
  target_id text default '',
  target_username text default '',
  kind text not null,
  post_id text default '',
  created_at timestamptz not null default now()
);

alter table public.posts add column if not exists actors text default '';
alter table public.posts add column if not exists directors text default '';
alter table public.posts add column if not exists titles text default '';
-- reviews / rich posts (see sql/post_reviews.sql for existing databases)
alter table public.posts add column if not exists display text default 'info,cast,trailer';
alter table public.posts add column if not exists pros text default '';
alter table public.posts add column if not exists cons text default '';
alter table public.post_items add column if not exists year text default '';
alter table public.post_items add column if not exists genres text default '';
alter table public.post_items add column if not exists overview text default '';
alter table public.post_items add column if not exists cast_json text default '[]';
alter table public.post_items add column if not exists trailer_key text default '';
alter table public.post_items add column if not exists backdrop_path text default '';

create unique index if not exists follows_pair_idx on public.follows (follower_id, following_id);
create unique index if not exists blocks_pair_idx on public.blocks (blocker_id, blocked_id);
create unique index if not exists post_votes_pair_idx on public.post_votes (post_id, member_id);
create index if not exists messages_pair_idx on public.messages (sender_id, receiver_id, created_at desc);
create index if not exists notifications_member_idx on public.notifications (member_id, created_at desc);
create index if not exists posts_owner_idx on public.posts (owner_id, created_at desc);
create index if not exists updates_actor_idx on public.updates (actor_id, created_at desc);

alter table public.follows enable row level security;
alter table public.blocks enable row level security;
alter table public.messages enable row level security;
alter table public.notifications enable row level security;
alter table public.posts enable row level security;
alter table public.post_items enable row level security;
alter table public.post_access enable row level security;
alter table public.post_votes enable row level security;
alter table public.post_comments enable row level security;
alter table public.updates enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'follows','blocks','messages','notifications','posts','post_items',
    'post_access','post_votes','post_comments','updates'
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
