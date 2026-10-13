-- CineAura ReportLinks
-- Run in the Supabase SQL editor.

create table if not exists public.reportlinks (
  id bigint generated always as identity primary key,
  reported_at timestamptz not null default now(),
  subject text not null,
  watch_url text not null,
  media_type text not null,
  tmdb_id integer not null,
  owner_id text not null,
  verdict text not null default 'valid',
  verdict_at timestamptz not null default now(),
  reporter_id text not null,
  link_id bigint,
  constraint reportlinks_type_check check (media_type in ('movie', 'tv')),
  constraint reportlinks_verdict_check check (verdict in ('valid', 'ended')),
  constraint reportlinks_subject_check check (subject in (
    'misleading', 'broken', 'malicious', 'stolen', 'bad', 'indirect'
  ))
);

comment on table public.reportlinks is 'ReportLinks: member reports against published watch URLs';
comment on column public.reportlinks.verdict is 'valid on create; ended when closed';

create index if not exists reportlinks_url_idx on public.reportlinks (tmdb_id, watch_url, verdict);
create index if not exists reportlinks_owner_idx on public.reportlinks (owner_id, reported_at desc);
create index if not exists reportlinks_reporter_idx on public.reportlinks (reporter_id, reported_at desc);

alter table public.reportlinks enable row level security;

drop policy if exists "ReportLinks select" on public.reportlinks;
create policy "ReportLinks select" on public.reportlinks for select to anon, authenticated using (true);
drop policy if exists "ReportLinks insert" on public.reportlinks;
create policy "ReportLinks insert" on public.reportlinks for insert to anon, authenticated with check (true);
drop policy if exists "ReportLinks update" on public.reportlinks;
create policy "ReportLinks update" on public.reportlinks for update to anon, authenticated using (true) with check (true);
drop policy if exists "ReportLinks delete" on public.reportlinks;
create policy "ReportLinks delete" on public.reportlinks for delete to anon, authenticated using (true);

alter table public.movielink add column if not exists banned boolean not null default false;
alter table public.tvlink add column if not exists banned boolean not null default false;

create unique index if not exists movielink_unique_url on public.movielink (tmdb_id, watch_url);
create unique index if not exists tvlink_unique_url on public.tvlink (tmdb_id, watch_url);
