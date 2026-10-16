-- ============================================================
-- Watch codes and their devices (watch page, Dashboard > Codes > Linked devices).
-- Run in the Supabase SQL editor after codes.sql and members.sql.
-- Safe to run more than once (and over the earlier version of this file).
--
-- Every device is linked to one code, and every code to one device. While a
-- code is linked, any other device that types it is refused, until the owner
-- unlinks it in the dashboard. A device uses one code at a time: when it uses
-- another code, the link moves to that code (with the device's name and type)
-- and the previous code is set free.
--
-- A device gets into Dashboard > Codes > Linked devices in two ways:
--   - by itself, the first time a code is entered on it (watch page): with its
--     MAC address, the type "web" (for now the site is the only app) and no
--     name (the name is optional);
--   - by hand: the owner gives its name (optional), its type (web, computer,
--     phone, smart TV, tablet) and its MAC address, picks a free code, Link.
--
-- In a browser the MAC is an address the site creates and keeps there (a web
-- page can never read the real MAC address of a machine): clearing the browser
-- data, or another browser, is a new device.
--
-- "Remember the code" on the watch page keeps the code in that browser, so it
-- is not asked again there. Such a remembered code is checked silently and only
-- works while it is still linked to that device: once it was unlinked in the
-- dashboard, or the device used another code, it has to be typed again.
--
--   code_use(code, mac, ...)                   the watch page checks (and links) a code
--   code_link_here(member, code, ...)          Codes > "Use on this device"
--   code_device_add(member, code, mac, ...)    Linked devices > Add device > Link
--   code_device_edit(member, code, name, type) Linked devices > Edit
--   code_unlink(member, code)                  "Unlink" (both tabs)
--
-- The device columns can't be written through the public API (trigger below):
-- only these functions change them. Like the site's other member functions,
-- the dashboard ones trust the member id sent by the browser.
-- ============================================================

alter table public.codes add column if not exists device_mac text;
alter table public.codes add column if not exists device_ip text;
alter table public.codes add column if not exists device_name text;
alter table public.codes add column if not exists device_type text;
alter table public.codes add column if not exists device_linked_at timestamptz;
alter table public.codes add column if not exists device_seen_at timestamptz;
alter table public.codes add column if not exists device_released_at timestamptz;

-- device_agent arrived with Linked devices. Before it, device_name held the
-- browser and system the device reported ("Chrome · Windows"): that is its
-- agent, and device_name is now the name its owner gives it (optional).
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'codes' and column_name = 'device_agent') then
    alter table public.codes add column device_agent text;
    perform set_config('cineaura.code_device', '1', true);
    update public.codes set device_agent = device_name, device_name = null where device_name is not null;
    perform set_config('cineaura.code_device', '', true);
  end if;
end $$;

-- a device linked before the types existed was linked by the site
do $$
begin
  perform set_config('cineaura.code_device', '1', true);
  update public.codes set device_type = 'web' where device_mac is not null and device_type is null;
  perform set_config('cineaura.code_device', '', true);
end $$;

comment on column public.codes.device_mac is 'MAC address of the device the code is linked to (in a browser: created by the site); null = free';
comment on column public.codes.device_ip is 'Public IP of the linked device, the last time it used the code';
comment on column public.codes.device_name is 'Name the owner gave the linked device (optional), e.g. "Living room TV"';
comment on column public.codes.device_type is 'Type of the linked device: web | computer | phone | tv | tablet';
comment on column public.codes.device_agent is 'Browser and system the linked device reported when it used the code, e.g. "Chrome · Windows"';
comment on column public.codes.device_linked_at is 'When the code was linked to that device';
comment on column public.codes.device_seen_at is 'When the linked device last used the code';
comment on column public.codes.device_released_at is 'When the code was last unlinked (dashboard) or left for another code: a device that remembered it must type it again';

alter table public.codes drop constraint if exists codes_device_mac_format;
alter table public.codes add constraint codes_device_mac_format
  check (device_mac is null or device_mac ~ '^[0-9A-F]{2}(:[0-9A-F]{2}){5}$');
alter table public.codes drop constraint if exists codes_device_type_check;
alter table public.codes add constraint codes_device_type_check
  check (device_type is null or device_type in ('web', 'computer', 'phone', 'tv', 'tablet'));

-- one code per device
create unique index if not exists codes_device_mac_key on public.codes (device_mac) where device_mac is not null;

-- ------------------------------------------------------------------ helpers
-- "02-5a-3c-9f-e1-07", "025A3C9FE107", "025a.3c9f.e107" -> "02:5A:3C:9F:E1:07".
-- Anything else is null, and so are the addresses no device has: all zeros,
-- broadcast (FF:FF:…) and multicast (odd first byte).
create or replace function public._code_mac(p_mac text)
returns text language sql immutable set search_path = public as $$
  select case
    when hex !~ '^[0-9A-F]{12}$' then null
    when hex in ('000000000000', 'FFFFFFFFFFFF') then null
    when substr(hex, 2, 1) in ('1', '3', '5', '7', '9', 'B', 'D', 'F') then null
    else substr(hex, 1, 2) || ':' || substr(hex, 3, 2) || ':' || substr(hex, 5, 2) || ':' ||
         substr(hex, 7, 2) || ':' || substr(hex, 9, 2) || ':' || substr(hex, 11, 2)
  end
  from (
    select case
      when v ~ '^[0-9A-F]{2}([:-][0-9A-F]{2}){5}$' then replace(replace(v, ':', ''), '-', '')
      when v ~ '^[0-9A-F]{12}$' then v
      when v ~ '^[0-9A-F]{4}\.[0-9A-F]{4}\.[0-9A-F]{4}$' then replace(v, '.', '')
      else ''
    end as hex
    from (select upper(btrim(coalesce(p_mac, ''))) as v) raw
  ) x
$$;

-- 'Web ' -> 'web'; anything that is not a known type -> null
create or replace function public._code_type(p_type text)
returns text language sql immutable set search_path = public as $$
  select case when v in ('web', 'computer', 'phone', 'tv', 'tablet') then v end
  from (select lower(btrim(coalesce(p_type, ''))) as v) x
$$;

-- a device name as kept: trimmed, without control characters, 60 characters at most
create or replace function public._code_device_name(p_name text)
returns text language sql immutable set search_path = public as $$
  select nullif(left(btrim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]+', ' ', 'g')), 60), '')
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

-- Links code c to device p_mac. The code the device used before is set free
-- and the device takes its name, type, agent and IP along.
--   p_agent     browser and system the device reports (null = keep)
--   p_used      the device itself uses the code now (watch page): last seen = now
--   p_name      null = keep the device's name; '' = no name; else the new name
--   p_type      null = keep the device's type; else the new type
--   p_type_new  the type of a device seen for the first time
-- Returns the codes that were set free.
drop function if exists public._code_link(public.codes, text, text, text);
create or replace function public._code_link(
  c public.codes, p_mac text, p_ip text, p_agent text,
  p_used boolean default true, p_name text default null,
  p_type text default null, p_type_new text default 'web')
returns text[] language plpgsql security definer set search_path = public as $$
declare
  freed text[];
  fresh boolean := c.device_mac is distinct from p_mac;
  prev public.codes;
begin
  perform set_config('cineaura.code_device', '1', true);
  if fresh then
    select * into prev from public.codes where device_mac = p_mac and id <> c.id limit 1;
  end if;
  with r as (
    update public.codes
       set device_mac = null, device_ip = null, device_name = null, device_type = null, device_agent = null,
           device_linked_at = null, device_seen_at = null, device_released_at = now()
     where device_mac = p_mac and id <> c.id
    returning code)
  select coalesce(array_agg(code), '{}') into freed from r;
  update public.codes
     set device_mac = p_mac,
         device_ip = coalesce(p_ip, case when fresh then prev.device_ip else device_ip end),
         device_agent = coalesce(nullif(left(btrim(coalesce(p_agent, '')), 80), ''),
                                 case when fresh then prev.device_agent else device_agent end),
         device_name = case when p_name is not null then public._code_device_name(p_name)
                            when fresh then prev.device_name else device_name end,
         device_type = coalesce(public._code_type(p_type),
                                case when fresh then prev.device_type else device_type end,
                                public._code_type(p_type_new), 'web'),
         device_linked_at = case when fresh then now() else device_linked_at end,
         device_seen_at = case when p_used then now() when fresh then prev.device_seen_at else device_seen_at end,
         device_released_at = null
   where id = c.id;
  perform set_config('cineaura.code_device', '', true);
  return freed;
end $$;

-- ------------------------------------------------------------------ watch page
-- Checks a code for the device p_mac and links it to that device: a device
-- that had no code yet joins its owner's Linked devices by itself.
--   p_name   browser and system of the device ("Chrome · Windows"), kept as
--            its agent; the device's own name is only given in the dashboard
--   p_age    the age the title asks for (0 = none): a younger code is refused
--   p_silent true for a code remembered in the browser (not typed): it only
--            works while it is still linked to this device
--   p_type   the type of a device seen for the first time: 'web' for the site
--            (the apps can send theirs); a known device keeps its type
-- Returns {ok: true, linked, ip, freed} or {ok: false, reason}:
--   invalid | device | not_found | expired | disabled | banned
--   age (+ age_rating) | other_device (+ device_tail) | unlinked
drop function if exists public.code_use(text, text, text, text, integer, boolean);
create or replace function public.code_use(
  p_code text, p_mac text, p_name text default '', p_ip text default '',
  p_age integer default 0, p_silent boolean default false, p_type text default 'web')
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
  freed := public._code_link(c, mac, public._code_ip(p_ip), p_name, true, null, null, coalesce(public._code_type(p_type), 'web'));
  select * into c from public.codes where id = c.id;
  return jsonb_build_object(
    'ok', true, 'reason', 'active', 'code', c.code, 'age_rating', c.age_rating, 'expires_at', c.expires_at,
    'linked', fresh, 'ip', c.device_ip is not null, 'freed', to_jsonb(freed), 'device_type', c.device_type);
end $$;

-- ------------------------------------------------------------------ dashboard
-- The member asking, when active (the dashboard functions trust this id).
create or replace function public._code_member(p_member text)
returns text language sql stable security definer set search_path = public as $$
  select m.member_id from public.members m
   where m.member_id = btrim(coalesce(p_member, '')) and coalesce(m.status, 'active') = 'active'
$$;

-- Codes > "Use on this device": the owner links one of their codes to the
-- device the dashboard is open on. A code linked to another device must be
-- unlinked first.
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
  if public._code_member(p_member) is null then
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
  freed := public._code_link(c, mac, public._code_ip(p_ip), p_name, false);
  return jsonb_build_object('ok', true, 'code', c.code, 'linked', fresh, 'freed', to_jsonb(freed));
end $$;

-- Linked devices > Add device > Link: the owner links a device to one of their
-- free codes by its MAC address, with a name (optional) and a type. The device
-- has nothing to do: from then on the code works on it, and on no other device.
-- {ok: true, code, mac, name, type} or {ok: false, reason: bad_request | bad_mac |
--  bad_type | unknown_member | not_found | expired | disabled | banned |
--  code_linked (+ device_tail) | mac_linked (+ code: the member's code that has
--  it) | mac_taken (a code of another account has it)}
create or replace function public.code_device_add(
  p_member text, p_code text, p_mac text, p_name text default '', p_type text default 'web')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c public.codes;
  other public.codes;
  mac text := public._code_mac(p_mac);
  typ text := public._code_type(coalesce(nullif(btrim(coalesce(p_type, '')), ''), 'web'));
  st text;
begin
  if btrim(coalesce(p_member, '')) = '' or coalesce(p_code, '') !~ '^[0-9]{6}$' then
    return jsonb_build_object('ok', false, 'reason', 'bad_request');
  end if;
  if mac is null then
    return jsonb_build_object('ok', false, 'reason', 'bad_mac');
  end if;
  if typ is null then
    return jsonb_build_object('ok', false, 'reason', 'bad_type');
  end if;
  if public._code_member(p_member) is null then
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
    return jsonb_build_object('ok', false, 'reason', 'code_linked', 'device_tail', right(c.device_mac, 5));
  end if;
  -- one code per device: a device that already has a code keeps it
  select * into other from public.codes where device_mac = mac and id <> c.id;
  if found then
    if other.owner = btrim(p_member) then
      return jsonb_build_object('ok', false, 'reason', 'mac_linked', 'code', other.code);
    end if;
    return jsonb_build_object('ok', false, 'reason', 'mac_taken');
  end if;
  begin
    perform public._code_link(c, mac, null, null, false, coalesce(p_name, ''), typ, typ);
  exception when unique_violation then
    -- the same device was linked at the same moment
    return jsonb_build_object('ok', false, 'reason', 'mac_taken');
  end;
  select * into c from public.codes where id = c.id;
  return jsonb_build_object('ok', true, 'code', c.code, 'mac', c.device_mac,
    'name', c.device_name, 'type', c.device_type);
end $$;

-- Linked devices > Edit: the owner renames a linked device or changes its type.
-- {ok: true, code, name, type} or {ok: false, reason: bad_request | bad_type |
--  unknown_member | not_found | not_linked}
create or replace function public.code_device_edit(
  p_member text, p_code text, p_name text default '', p_type text default 'web')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c public.codes;
  typ text := public._code_type(p_type);
begin
  if btrim(coalesce(p_member, '')) = '' or coalesce(p_code, '') !~ '^[0-9]{6}$' then
    return jsonb_build_object('ok', false, 'reason', 'bad_request');
  end if;
  if typ is null then
    return jsonb_build_object('ok', false, 'reason', 'bad_type');
  end if;
  if public._code_member(p_member) is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown_member');
  end if;
  select * into c from public.codes where code = p_code and owner = btrim(p_member) for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if c.device_mac is null then
    return jsonb_build_object('ok', false, 'reason', 'not_linked');
  end if;
  perform set_config('cineaura.code_device', '1', true);
  update public.codes
     set device_name = public._code_device_name(p_name), device_type = typ
   where id = c.id
  returning * into c;
  perform set_config('cineaura.code_device', '', true);
  return jsonb_build_object('ok', true, 'code', c.code, 'name', c.device_name, 'type', c.device_type);
end $$;

-- "Unlink" (Codes and Linked devices): the owner sets a code free. The device
-- leaves Linked devices and has to type a code again; any device may then use it.
-- {ok: true, unlinked, mac} or {ok: false, reason: bad_request | unknown_member | not_found}
create or replace function public.code_unlink(p_member text, p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.codes;
begin
  if btrim(coalesce(p_member, '')) = '' or coalesce(p_code, '') !~ '^[0-9]{6}$' then
    return jsonb_build_object('ok', false, 'reason', 'bad_request');
  end if;
  if public._code_member(p_member) is null then
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
     set device_mac = null, device_ip = null, device_name = null, device_type = null, device_agent = null,
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
    new.device_type := null;
    new.device_agent := null;
    new.device_linked_at := null;
    new.device_seen_at := null;
    new.device_released_at := null;
  else
    new.device_mac := old.device_mac;
    new.device_ip := old.device_ip;
    new.device_name := old.device_name;
    new.device_type := old.device_type;
    new.device_agent := old.device_agent;
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
revoke all on function public._code_type(text) from public, anon, authenticated;
revoke all on function public._code_device_name(text) from public, anon, authenticated;
revoke all on function public._code_ip(text) from public, anon, authenticated;
revoke all on function public._code_state(public.codes) from public, anon, authenticated;
revoke all on function public._code_age_max(text) from public, anon, authenticated;
revoke all on function public._code_member(text) from public, anon, authenticated;
revoke all on function public._code_link(public.codes, text, text, text, boolean, text, text, text) from public, anon, authenticated;
revoke all on function public._codes_device_guard() from public, anon, authenticated;

revoke all on function public.code_use(text, text, text, text, integer, boolean, text) from public, anon, authenticated;
grant execute on function public.code_use(text, text, text, text, integer, boolean, text) to anon, authenticated;
revoke all on function public.code_link_here(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.code_link_here(text, text, text, text, text) to anon, authenticated;
revoke all on function public.code_device_add(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.code_device_add(text, text, text, text, text) to anon, authenticated;
revoke all on function public.code_device_edit(text, text, text, text) from public, anon, authenticated;
grant execute on function public.code_device_edit(text, text, text, text) to anon, authenticated;
revoke all on function public.code_unlink(text, text) from public, anon, authenticated;
grant execute on function public.code_unlink(text, text) to anon, authenticated;

notify pgrst, 'reload schema';
