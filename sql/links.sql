-- CineAura member watch links and download links
-- MovieLink / TVLink — run in the Supabase SQL editor (safe to re-run).
--
-- One row is one source a member published for a title (or for one episode of a
-- series). link_kind says what the visitor gets:
--
--   watch     the link opens in the player on the watch page
--   download  the link opens on its own site, in a new tab
--
-- Both forms — the dashboard and the "+" popup on the watch page — let a member
-- publish a source as a watch link, as a download link, or as both at once. "Both"
-- writes one row per kind (the same URL, the same description, both sections).
--
-- Both kinds keep the same description — quality, original language, subtitles,
-- ads — so the watch page can show them side by side, in one panel, and both are
-- filtered by quality and platform there. clicks counts how often the row was
-- opened; the rails are ordered by it, and every 1000 clicks on a member's
-- download links pays that member one point (js/common.js POINT_RATES).

create table if not exists public.movielink (
  id bigint generated always as identity primary key,
  tmdb_id integer not null,
  member_id text not null,
  username text not null,
  watch_url text not null,
  title text default '',
  added_at timestamptz not null default now()
);

create table if not exists public.tvlink (
  id bigint generated always as identity primary key,
  tmdb_id integer not null,
  member_id text not null,
  username text not null,
  watch_url text not null,
  season integer not null,
  episode integer not null,
  title text default '',
  added_at timestamptz not null default now()
);

alter table public.movielink add column if not exists quality text default '';
alter table public.movielink add column if not exists original_language text default '';
alter table public.movielink add column if not exists has_subtitles boolean not null default false;
alter table public.movielink add column if not exists subtitle_languages text default '';

alter table public.tvlink add column if not exists quality text default '';
alter table public.tvlink add column if not exists original_language text default '';
alter table public.tvlink add column if not exists has_subtitles boolean not null default false;
alter table public.tvlink add column if not exists subtitle_languages text default '';

alter table public.movielink add column if not exists banned boolean not null default false;
alter table public.tvlink add column if not exists banned boolean not null default false;

-- Does the source play ads before or during the title? Asked in the "+" popup on
-- the watch page and in the dashboard link form, shown as a chip next to the link.
alter table public.movielink add column if not exists has_ads boolean not null default false;
alter table public.tvlink add column if not exists has_ads boolean not null default false;

create unique index if not exists movielink_unique_url on public.movielink (tmdb_id, watch_url);
create unique index if not exists tvlink_unique_url on public.tvlink (tmdb_id, watch_url);

comment on table public.movielink is 'MovieLink: member-submitted movie watch URLs';
comment on table public.tvlink is 'TVLink: member-submitted episode watch URLs';
comment on column public.movielink.quality is 'Playback quality (SD, HD, Full HD, 2K, 4K, 8K)';
comment on column public.movielink.has_ads is 'Whether the source plays ads';
comment on column public.tvlink.has_ads is 'Whether the source plays ads';
-- Watch links and download links share the tables: link_kind tells them apart.
alter table public.movielink add column if not exists link_kind text not null default 'watch';
alter table public.tvlink add column if not exists link_kind text not null default 'watch';

-- How often the link was opened. The watch page moves this counter on every
-- click, orders the rails by it (most viewed first) and reads it for the points
-- rule. Anything published before this column existed reads as 0.
alter table public.movielink add column if not exists clicks integer not null default 0;
alter table public.tvlink add column if not exists clicks integer not null default 0;

-- The same URL may be published once as a watch link and once as a download, so
-- the kind belongs to the uniqueness rule.
drop index if exists public.movielink_unique_url;
create unique index if not exists movielink_unique_kind_url on public.movielink (tmdb_id, watch_url, link_kind);
drop index if exists public.tvlink_unique_url;
create unique index if not exists tvlink_unique_kind_url on public.tvlink (tmdb_id, watch_url, link_kind);

create index if not exists movielink_clicks_idx on public.movielink (tmdb_id, clicks desc);
create index if not exists tvlink_clicks_idx on public.tvlink (tmdb_id, season, episode, clicks desc);

comment on column public.movielink.link_kind is 'watch = opens in the player, download = opens on its own site';
comment on column public.tvlink.link_kind is 'watch = opens in the player, download = opens on its own site';
comment on column public.movielink.clicks is 'How often the link was opened; 1000 clicks on a download link = 1 point for the publisher';
comment on column public.tvlink.clicks is 'How often the link was opened; 1000 clicks on a download link = 1 point for the publisher';

comment on column public.movielink.has_subtitles is 'Whether translation / subtitles are available';
comment on column public.movielink.subtitle_languages is 'all, or comma-separated language names';

create index if not exists movielink_tmdb_idx on public.movielink (tmdb_id, added_at desc);
create index if not exists tvlink_tmdb_ep_idx on public.tvlink (tmdb_id, season, episode, added_at desc);

-- One row per click on a member link. The counter above is the total; this log
-- carries the viewer, which is what keeps a refresh loop from doing the counting
-- (the watch page lets one viewer count once per link per day) and lets the
-- dashboard tell real clicks from repeated ones.
create table if not exists public.link_clicks (
  id bigint generated always as identity primary key,
  link_table text not null default 'movielink',
  link_id bigint not null,
  link_kind text not null default 'watch',
  tmdb_id integer,
  media_type text default '',
  season integer,
  episode integer,
  owner_id text default '',
  owner_username text default '',
  viewer_id text default '',
  watch_url text default '',
  clicked_at timestamptz not null default now()
);

create index if not exists link_clicks_link_idx on public.link_clicks (link_table, link_id, clicked_at desc);
create index if not exists link_clicks_owner_idx on public.link_clicks (owner_id, clicked_at desc);
create index if not exists link_clicks_viewer_idx on public.link_clicks (viewer_id, link_id, clicked_at desc);

comment on table public.link_clicks is 'One row per click on a member link (watch or download)';

alter table public.movielink enable row level security;
alter table public.tvlink enable row level security;
alter table public.link_clicks enable row level security;

drop policy if exists "LinkClick select" on public.link_clicks;
create policy "LinkClick select" on public.link_clicks for select to anon, authenticated using (true);
drop policy if exists "LinkClick insert" on public.link_clicks;
create policy "LinkClick insert" on public.link_clicks for insert to anon, authenticated with check (true);

drop policy if exists "MovieLink select" on public.movielink;
create policy "MovieLink select" on public.movielink for select to anon, authenticated using (true);
drop policy if exists "MovieLink insert" on public.movielink;
create policy "MovieLink insert" on public.movielink for insert to anon, authenticated with check (true);
drop policy if exists "MovieLink update" on public.movielink;
create policy "MovieLink update" on public.movielink for update to anon, authenticated using (true) with check (true);
drop policy if exists "MovieLink delete" on public.movielink;
create policy "MovieLink delete" on public.movielink for delete to anon, authenticated using (true);

drop policy if exists "TVLink select" on public.tvlink;
create policy "TVLink select" on public.tvlink for select to anon, authenticated using (true);
drop policy if exists "TVLink insert" on public.tvlink;
create policy "TVLink insert" on public.tvlink for insert to anon, authenticated with check (true);
drop policy if exists "TVLink update" on public.tvlink;
create policy "TVLink update" on public.tvlink for update to anon, authenticated using (true) with check (true);
drop policy if exists "TVLink delete" on public.tvlink;
create policy "TVLink delete" on public.tvlink for delete to anon, authenticated using (true);

-- The publisher decides whether the platform URL is shown to visitors. A hidden
-- URL is not printed in the details panel under the player (the publisher still
-- sees it, marked as hidden). Several qualities are stored in the existing
-- `quality` column as one comma-separated text, e.g. 'SD, HD, FHD'.
alter table public.movielink add column if not exists url_hidden boolean not null default false;
alter table public.tvlink add column if not exists url_hidden boolean not null default false;
comment on column public.movielink.url_hidden is 'true = the platform URL is hidden from visitors';
comment on column public.tvlink.url_hidden is 'true = the platform URL is hidden from visitors';
comment on column public.movielink.quality is 'Playback qualities, comma separated (SD, HD, FHD, 2K, 4K, 8K)';
comment on column public.tvlink.quality is 'Playback qualities, comma separated (SD, HD, FHD, 2K, 4K, 8K)';
