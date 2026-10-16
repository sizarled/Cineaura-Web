-- ============================================================
-- App downloads: the "Get the app" cards of the home page (Panel > Apps)
-- Run in the Supabase SQL editor AFTER prize_secure.sql, because saving uses the
-- panel's staff sessions. Safe to run more than once.
--
-- One row per platform: Windows, Linux, macOS (CineAura PC), Android, iPhone
-- (CineAura Mobile) and Android TV (CineAura TV). A platform with a download link
-- shows "Available", its version and a Download button on the home page; one
-- without a link shows "Coming soon".
--
-- Everyone can read the table. Only the Super Admin and staff with the Apps
-- section can change it, through staff_app_save(), so nobody can swap a download
-- link for another file with the public key.
-- ============================================================

create table if not exists public.app_downloads (
  platform text primary key,
  url text not null default '',
  version text not null default '1.0',
  updated_at timestamptz not null default now(),
  updated_by text not null default ''
);

alter table public.app_downloads add column if not exists url text not null default '';
alter table public.app_downloads add column if not exists version text not null default '1.0';
alter table public.app_downloads add column if not exists updated_at timestamptz not null default now();
alter table public.app_downloads add column if not exists updated_by text not null default '';

do $$
begin
  alter table public.app_downloads add constraint app_downloads_platform_check
    check (platform in ('windows', 'linux', 'macos', 'android', 'ios', 'androidtv'));
exception when duplicate_object then null;
end $$;

insert into public.app_downloads (platform) values
  ('windows'), ('linux'), ('macos'), ('android'), ('ios'), ('androidtv')
on conflict (platform) do nothing;

-- public read, no public write
alter table public.app_downloads enable row level security;
do $$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'app_downloads' loop
    execute format('drop policy %I on public.app_downloads', pol.policyname);
  end loop;
end $$;
create policy app_downloads_read on public.app_downloads for select to anon, authenticated using (true);
revoke all on public.app_downloads from anon, authenticated;
grant select on public.app_downloads to anon, authenticated;

-- Panel > Apps: save the download link and version of one platform.
-- p_url = '' removes the link: the platform shows "Coming soon" again.
-- A link is a web address (http/https) or a file on this site (/downloads/...).
create or replace function public.staff_app_save(p_token text, p_platform text, p_url text, p_version text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  s public.staff;
  u text := btrim(coalesce(p_url, ''));
  v text := btrim(coalesce(p_version, ''));
  r public.app_downloads;
begin
  s := public._staff(p_token);
  if s.role <> 'super' and position(',apps,' in ',' || replace(coalesce(s.sections, ''), ' ', '') || ',') = 0 then
    raise exception 'staff_forbidden';
  end if;
  if p_platform is null or p_platform not in ('windows', 'linux', 'macos', 'android', 'ios', 'androidtv') then
    return jsonb_build_object('ok', false, 'error', 'bad_platform');
  end if;
  if u <> '' and (length(u) > 1000 or u ~ '[[:space:]<>"''`]' or not (u ~* '^https?://[^/?#]+' or u ~ '^/[^/\\]')) then
    return jsonb_build_object('ok', false, 'error', 'bad_url');
  end if;
  if length(v) > 20 then
    return jsonb_build_object('ok', false, 'error', 'bad_version');
  end if;
  insert into public.app_downloads as a (platform, url, version, updated_at, updated_by)
  values (p_platform, u, v, now(), coalesce(nullif(s.username, ''), s.role))
  on conflict (platform) do update
    set url = excluded.url, version = excluded.version, updated_at = excluded.updated_at, updated_by = excluded.updated_by
  returning a.* into r;
  return jsonb_build_object('ok', true, 'row', to_jsonb(r));
end $$;

revoke all on function public.staff_app_save(text, text, text, text) from public, anon, authenticated;
grant execute on function public.staff_app_save(text, text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
