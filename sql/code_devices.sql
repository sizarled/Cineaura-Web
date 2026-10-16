-- ============================================================
-- Watch codes: one device per code (watch page, Dashboard > Codes).
-- Run in the Supabase SQL editor after codes.sql and members.sql.
-- Safe to run more than once.
--
-- A code is linked to the device that uses it. While it is linked, any other
-- device that types it is refused, until the owner unlinks it in
-- Dashboard > Codes. A device uses one code at a time: when it uses another
-- code, the link moves to that code and the previous one is set free.
--
-- The device is known by a MAC-style address the site creates in each browser
-- and keeps there (a web page can never read the real MAC address of a
-- machine). Clearing the browser data, or another browser, is a new device.
--
-- "Remember the code" on the watch page keeps the code in that browser, so it
-- is not asked again there. Such a remembered code is checked silently and only
-- works while it is still linked to that device: once it was unlinked in the
-- dashboard, or the device used another code, it has to be typed again.
--
--   code_use(code, mac, ...)          the watch page checks (and links) a code
--   code_link_here(member, code, ...) Dashboard > Codes > "Use on this device"
--   code_unlink(member, code)         Dashboard > Codes > "Unlink"
--
-- The device columns can't be written through the public API (trigger below):
-- only these functions change them. Like the site's other member functions,
-- the dashboard ones trust the member id sent by the browser.
-- ============================================================

alter table public.codes add column if not exists device_mac text;
alter table public.codes add column if not exists device_ip text;
alter table public.codes add column if not exists device_name text;
alter table public.codes add column if not exists device_linked_at timestamptz;
alter table public.codes add column if not exists device_seen_at timestamptz;
alter table public.codes add column if not exists device_released_at timestamptz;

comment on column public.codes.device_mac is 'MAC-style address of the device the code is linked to (created by the site in that browser); null = free';
comment on column public.codes.device_ip is 'Public IP of the linked device, the last time it used the code';
comment on column public.codes.device_name is 'Browser and system of the linked device, e.g. "Chrome · Windows"';
comment on column public.codes.device_linked_at is 'When the code was linked to that device';
comment on column public.codes.device_seen_at is 'When the linked device last used the code';
comment on column public.codes.device_released_at is 'When the code was last unlinked (dashboard) or left for another code: a device that remembered it must type it again';

alter table public.codes drop constraint if exists codes_device_mac_format;
alter table public.codes add constraint codes_device_mac_format
  check (device_mac is null or device_mac ~ '^[0-9A-F]{2}(:[0-9A-F]{2}){5}$');

-- one code per device
create unique index if not exists codes_device_mac_key on public.codes (device_mac) where device_mac is not null;

-- ------------------------------------------------------------------ helpers
-- "02-5a-3c-9f-e1-07" -> "02:5A:3C:9F:E1:07"; anything else -> null
create or replace function public._code_mac(p_mac text)
returns text language sql immutable set search_path = public as $$
  select case when v ~ '^[0-9A-F]{2}(:[0-9A-F]{2}){5}$' then v end
  from (select upper(replace(btrim(coalesce(p_mac, '')), '-', ':')) as v) x
$$;

-- The public IP of the caller: what the API gateway saw first (it can't be
-- faked from the browser), else what the browser sent.
create or replace function public._code_ip(p_ip text)
returns text language plpgsql stable set search_path = public as $$
declare h jsonb; v text;
begin
  begin
    h := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    h := null;
  end;
  if h is not null then
    v := coalesce(nullif(btrim(h->>'cf-connecting-ip'), ''),
                  nullif(btrim(h->>'x-real-ip'), ''),
                  nullif(btrim(split_part(coalesce(h->>'x-forwarded-for', ''), ',', 1)), ''));
  end if;
  v := coalesce(v, nullif(btrim(coalesce(p_ip, '')), ''));
  if v is null or length(v) > 45 or v !~ '^[0-9A-Fa-f:.]+$' then
    return null;
  end if;
  return v;
end $$;

-- active | expired | disabled | banned
create or replace function public._code_state(c public.codes)
returns text language sql stable set search_path = public as $$
  select case
    when lower(btrim(coalesce(c.status, 'active'))) in ('banned', 'disabled') then lower(btrim(c.status))
    when lower(btrim(coalesce(c.status, 'active'))) = 'expired' then 'expired'
    when c.expires_at is not null and c.expires_at < now() then 'expired'
    else 'active'
  end
$$;

-- the oldest age a code may open (js/common.js AGE_TIERS); no tier = no limit
create or replace function public._code_age_max(p_tier text)
returns integer language sql immutable set search_path = public as $$
  select case btrim(coalesce(p_tier, '')) when 'u13' then 12 when 'u16' then 15 when 'u18' then 17 else 99 end
$$;

-- Link code c to device mac. The code the device used before is set free.
-- Returns the codes that were set free.
create or replace function public._code_link(c public.codes, p_mac text, p_ip text, p_name text)
returns text[] language plpgsql security definer set search_path = public as $$
declare freed text[]; fresh boolean := c.device_mac is distinct from p_mac;
begin
  perform set_config('cineaura.code_device', '1', true);
  with r as (
    update public.codes
       set device_mac = null, device_ip = null, device_name = null,
           device_linked_at = null, device_seen_at = null, device_released_at = now()
     where device_mac = p_mac and id <> c.id
    returning code)
  select coalesce(array_agg(code), '{}') into freed from r;
  update public.codes
     set device_mac = p_mac,
         device_ip = coalesce(p_ip, case when fresh then null else device_ip end),
         device_name = coalesce(nullif(left(btrim(coalesce(p_name, '')), 80), ''), case when fresh then null else device_name end),
         device_linked_at = case when fresh then now() else device_linked_at end,
         device_seen_at = now(),
         device_released_at = null
   where id = c.id;
  perform set_config('cineaura.code_device', '', true);
  return freed;
end $$;

-- ------------------------------------------------------------------ watch page
-- Checks a code for the device p_mac and links it to that device.
--   p_age    the age the title asks for (0 = none): a younger code is refused
--   p_silent true for a code remembered in the browser (not typed): it only
--            works while it is still linked to this device
-- Returns {ok: true, linked, ip, freed} or {ok: false, reason}:
--   invalid | device | not_found | expired | disabled | banned
--   age (+ age_rating) | other_device (+ device_tail) | unlinked
create or replace function public.code_use(
  p_code text, p_mac text, p_name text default '', p_ip text default '',
  p_age integer default 0, p_silent boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c public.codes;
  mac text := public._code_mac(p_mac);
  st text;
  freed text[] := '{}';
  fresh boolean;
begin
  if coalesce(p_code, '') !~ '^[0-9]{6}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if mac is null then
    return jsonb_build_object('ok', false, 'reason', 'device');
  end if;
  select * into c from public.codes where code = p_code for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  st := public._code_state(c);
  if st <> 'active' then
    return jsonb_build_object('ok', false, 'reason', st);
  end if;
  if coalesce(p_age, 0) > public._code_age_max(c.age_rating) then
    return jsonb_build_object('ok', false, 'reason', 'age', 'age_rating', c.age_rating);
  end if;
  if c.device_mac is not null and c.device_mac <> mac then
    -- only the end of the other address: enough for its owner to recognise it
    return jsonb_build_object('ok', false, 'reason', 'other_device', 'device_tail', right(c.device_mac, 5));
  end if;
  -- a remembered code that was unlinked, or left for another code, is typed again
  if c.device_mac is null and p_silent and c.device_released_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'unlinked');
  end if;
  fresh := c.device_mac is null;
  freed := public._code_link(c, mac, public._code_ip(p_ip), p_name);
  select * into c from public.codes where id = c.id;
  return jsonb_build_object(
    'ok', true, 'reason', 'active', 'code', c.code, 'age_rating', c.age_rating, 'expires_at', c.expires_at,
    'linked', fresh, 'ip', c.device_ip is not null, 'freed', to_jsonb(freed));
end $$;

-- ------------------------------------------------------------------ dashboard
-- Dashboard > Codes > "Use on this device": the owner links one of their codes
-- to the device the dashboard is open on. A code linked to another device must
-- be unlinked first.
-- {ok: true, linked, freed} or {ok: false, reason: bad_request | unknown_member |
--  not_found | expired | disabled | banned | other_device}
create or replace function public.code_link_here(
  p_member text, p_code text, p_mac text, p_name text default '', p_ip text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c public.codes;
  mac text := public._code_mac(p_mac);
  st text;
  freed text[];
  fresh boolean;
begin
  if btrim(coalesce(p_member, '')) = '' or coalesce(p_code, '') !~ '^[0-9]{6}$' or mac is null then
    return jsonb_build_object('ok', false, 'reason', 'bad_request');
  end if;
  if not exists (select 1 from public.members m where m.member_id = btrim(p_member) and coalesce(m.status, 'active') = 'active') then
    return jsonb_build_object('ok', false, 'reason', 'unknown_member');
  end if;
  select * into c from public.codes where code = p_code and owner = btrim(p_member) for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  st := public._code_state(c);
  if st <> 'active' then
    return jsonb_build_object('ok', false, 'reason', st);
  end if;
  if c.device_mac is not null and c.device_mac <> mac then
    return jsonb_build_object('ok', false, 'reason', 'other_device');
  end if;
  fresh := c.device_mac is null;
  freed := public._code_link(c, mac, public._code_ip(p_ip), p_name);
  return jsonb_build_object('ok', true, 'code', c.code, 'linked', fresh, 'freed', to_jsonb(freed));
end $$;

-- Dashboard > Codes > "Unlink": the owner sets a code free. The device it was
-- linked to has to type a code again; any device may then use it.
-- {ok: true, unlinked, mac} or {ok: false, reason: bad_request | unknown_member | not_found}
create or replace function public.code_unlink(p_member text, p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.codes;
begin
  if btrim(coalesce(p_member, '')) = '' or coalesce(p_code, '') !~ '^[0-9]{6}$' then
    return jsonb_build_object('ok', false, 'reason', 'bad_request');
  end if;
  if not exists (select 1 from public.members m where m.member_id = btrim(p_member) and coalesce(m.status, 'active') = 'active') then
    return jsonb_build_object('ok', false, 'reason', 'unknown_member');
  end if;
  select * into c from public.codes where code = p_code and owner = btrim(p_member) for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if c.device_mac is null then
    return jsonb_build_object('ok', true, 'code', c.code, 'unlinked', false);
  end if;
  perform set_config('cineaura.code_device', '1', true);
  update public.codes
     set device_mac = null, device_ip = null, device_name = null,
         device_linked_at = null, device_seen_at = null, device_released_at = now()
   where id = c.id;
  perform set_config('cineaura.code_device', '', true);
  return jsonb_build_object('ok', true, 'code', c.code, 'unlinked', true, 'mac', c.device_mac);
end $$;

-- ------------------------------------------------------------------ guard
-- The table stays open to the public key (codes.sql), but its device columns
-- only change through the functions above: a new row starts without a device,
-- and an update through the API keeps them as they were.
create or replace function public._codes_device_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if coalesce(current_setting('cineaura.code_device', true), '') = '1' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.device_mac := null;
    new.device_ip := null;
    new.device_name := null;
    new.device_linked_at := null;
    new.device_seen_at := null;
    new.device_released_at := null;
  else
    new.device_mac := old.device_mac;
    new.device_ip := old.device_ip;
    new.device_name := old.device_name;
    new.device_linked_at := old.device_linked_at;
    new.device_seen_at := old.device_seen_at;
    new.device_released_at := old.device_released_at;
  end if;
  return new;
end $$;

drop trigger if exists codes_device_guard on public.codes;
create trigger codes_device_guard before insert or update on public.codes
  for each row execute function public._codes_device_guard();

-- ------------------------------------------------------------------ grants
revoke all on function public._code_mac(text) from public, anon, authenticated;
revoke all on function public._code_ip(text) from public, anon, authenticated;
revoke all on function public._code_state(public.codes) from public, anon, authenticated;
revoke all on function public._code_age_max(text) from public, anon, authenticated;
revoke all on function public._code_link(public.codes, text, text, text) from public, anon, authenticated;
revoke all on function public._codes_device_guard() from public, anon, authenticated;

revoke all on function public.code_use(text, text, text, text, integer, boolean) from public, anon, authenticated;
grant execute on function public.code_use(text, text, text, text, integer, boolean) to anon, authenticated;
revoke all on function public.code_link_here(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.code_link_here(text, text, text, text, text) to anon, authenticated;
revoke all on function public.code_unlink(text, text) from public, anon, authenticated;
grant execute on function public.code_unlink(text, text) to anon, authenticated;
