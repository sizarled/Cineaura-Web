-- CineAura IPTV channels: stream links + channel reports
-- Run this in the Supabase SQL editor. It is safe to run again.
--
-- 1) public.listchannels keeps the stream link of every channel (the URL line
--    under #EXTINF in the M3U), so the channel player on Listchannels.html can
--    open it. Packages imported before this column existed have an empty link:
--    the player then looks the channel up in the package playlist, and an import
--    from Panel > IPTV fills the column for good.
-- 2) public.channel_reports receives the "Report channel" button of the player
--    and feeds Panel > Reports > Channels.
-- 3) public.listchannels.epg_id links a channel to the programme guide (EPG).

alter table public.listchannels add column if not exists stream_url text not null default '';
-- epg_id is the tvg-id of the channel in the M3U: the key of the channel in the
-- programme guide (XMLTV) of its package. Channels imported before this column
-- existed are matched to the guide by their name.
alter table public.listchannels add column if not exists epg_id text not null default '';

comment on column public.listchannels.stream_url is
  'Stream link of the channel: the URL line under #EXTINF in the imported M3U';
comment on column public.listchannels.epg_id is
  'tvg-id of the channel in the imported M3U: its id in the package programme guide (XMLTV)';

create index if not exists listchannels_package_idx on public.listchannels (package_name, group_name);

create table if not exists public.channel_reports (
  id bigint generated always as identity primary key,
  reported_at timestamptz not null default now(),
  -- listchannels.id when the report was sent. An import that replaces the
  -- package gives its channels new ids, so the columns below keep a copy of
  -- what the member saw.
  channel_id bigint,
  package_name text not null default '',
  channel_name text not null default '',
  group_name text not null default '',
  logo_url text not null default '',
  stream_url text not null default '',
  reason text not null default 'not_working',
  note text not null default '',
  -- what the player itself saw (for example "hls/proxy: manifestLoadError 404")
  error_detail text not null default '',
  reporter_id text not null,
  reporter_name text not null default '',
  status text not null default 'open',
  handled_by text not null default '',
  handled_at timestamptz,
  constraint channel_reports_reason_check check (
    reason in ('not_working', 'buffering', 'wrong', 'audio', 'other')
  ),
  constraint channel_reports_status_check check (
    status in ('open', 'resolved', 'dismissed')
  ),
  constraint channel_reports_note_len check (char_length(note) <= 500),
  constraint channel_reports_detail_len check (char_length(error_detail) <= 1000)
);

comment on table public.channel_reports is 'Member reports against IPTV channels that do not play';
comment on column public.channel_reports.reason is 'not_working | buffering | wrong | audio | other';
comment on column public.channel_reports.status is 'open on create; resolved (fixed) or dismissed by the staff';

create index if not exists channel_reports_status_idx on public.channel_reports (status, reported_at desc);
create index if not exists channel_reports_channel_idx on public.channel_reports (package_name, channel_name);
create index if not exists channel_reports_reporter_idx on public.channel_reports (reporter_id, reported_at desc);

-- One open report per member and channel: a second click is answered with
-- "already reported" instead of a duplicate row.
create unique index if not exists channel_reports_one_open
  on public.channel_reports (reporter_id, package_name, channel_name)
  where status = 'open';

alter table public.channel_reports enable row level security;

drop policy if exists "Channel reports select" on public.channel_reports;
create policy "Channel reports select" on public.channel_reports for select to anon, authenticated using (true);
drop policy if exists "Channel reports insert" on public.channel_reports;
create policy "Channel reports insert" on public.channel_reports for insert to anon, authenticated with check (true);
drop policy if exists "Channel reports update" on public.channel_reports;
create policy "Channel reports update" on public.channel_reports for update to anon, authenticated using (true) with check (true);
drop policy if exists "Channel reports delete" on public.channel_reports;
create policy "Channel reports delete" on public.channel_reports for delete to anon, authenticated using (true);

-- PostgREST caches the schema: make the new column and table visible at once.
notify pgrst, 'reload schema';
