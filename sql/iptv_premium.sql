-- ============================================================
-- Premium channels of the home page (Listchannels.html?premium=1)
-- Run in the Supabase SQL editor AFTER iptv.sql and code_devices.sql
-- (safe to run again).
--
-- The premium list is the playlist IPTV-Premuim.m3u (Supabase Storage, bucket
-- IPTV). Its links carry the words Username and Password, e.g.
--     http://line.ottcst.net:80/Username/Password/1784957
-- which the browser replaces with the username and password of a premium IPTV
-- account: the Xtream account given to a member in Panel > IPTV (type premium),
-- the one the member sees in Dashboard > IPTV.
--
-- The page unlocks the list in one of these ways:
--   iptv_premium_login(user, password)
--       the username and password of a premium account (still running)
--   iptv_premium_unlock(code, mac, ...)
--       a watch code: the premium account of the member who owns the code.
--       The code follows the rules of code_use (state, another device): with
--       "Remember the code" ticked it is linked to this device (Linked devices),
--       without it nothing is linked.
--   iptv_premium_unlock('', mac, ...)
--       no code typed: the code linked to this device in Dashboard > Codes >
--       Linked devices (remembered, or added by hand), so a linked device is
--       never asked again.
-- Both answer {ok: true, user, pass, ...} or {ok: false, reason}.
-- ============================================================

-- username + password of a premium account
--   {ok: true, user, pass, expires_at} | {ok: false, reason: bad_request | bad_login | expired (+ expires_at)}
create or replace function public.iptv_premium_login(p_user text, p_pass text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare a record;
begin
  if btrim(coalesce(p_user, '')) = '' or coalesce(p_pass, '') = ''
     or length(p_user) > 200 or length(p_pass) > 200 then
    return jsonb_build_object('ok', false, 'reason', 'bad_request');
  end if;
  select i.id, i.expires_at into a
    from public.iptv i
   where lower(btrim(coalesce(i.type, ''))) <> 'free'
     and i.xstream_user = btrim(p_user)
     and i.xstream_password = p_pass
   order by (i.expires_at is null or i.expires_at > now()) desc, i.expires_at desc nulls first, i.id desc
   limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'bad_login');
  end if;
  if a.expires_at is not null and a.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'expired', 'expires_at', a.expires_at);
  end if;
  return jsonb_build_object('ok', true, 'user', btrim(p_user), 'pass', p_pass, 'expires_at', a.expires_at);
end $$;

-- a watch code (or the code linked to this device): the premium account of its owner
--   {ok: true, user, pass, code, account_expires_at, by_device, linked, kept, ...code_use}
--   {ok: false, reason: device | no_device | owner_banned | no_premium | (every refusal of code_use)}
create or replace function public.iptv_premium_unlock(
  p_code text, p_mac text, p_name text default '', p_ip text default '',
  p_silent boolean default false, p_type text default 'web', p_remember boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  mac text := public._code_mac(p_mac);
  v_code text := btrim(coalesce(p_code, ''));
  by_device boolean := false;
  r jsonb;
  v_owner text;
  v_user text;
  a record;
begin
  if mac is null then
    return jsonb_build_object('ok', false, 'reason', 'device');
  end if;
  if v_code = '' then
    -- nothing typed: the code this device is linked to, if any
    select c.code into v_code from public.codes c where c.device_mac = mac order by c.device_linked_at desc nulls last limit 1;
    if v_code is null then
      return jsonb_build_object('ok', false, 'reason', 'no_device');
    end if;
    by_device := true;
  end if;
  -- the premium account of a banned member is not shared (checked before anything is linked)
  select c.owner into v_owner from public.codes c where c.code = v_code;
  select m.username into v_user from public.members m where m.member_id = v_owner;
  if exists (select 1 from public.members m where m.member_id = v_owner
              and (lower(btrim(coalesce(m.status, ''))) in ('banned', 'blocked') or m.status = 'محظور')) then
    return jsonb_build_object('ok', false, 'reason', 'owner_banned', 'by_device', by_device);
  end if;
  r := public.code_use(v_code, p_mac, p_name, p_ip, 0, p_silent or by_device, p_type, p_remember or by_device);
  if not coalesce((r->>'ok')::boolean, false) then
    return r || jsonb_build_object('by_device', by_device);
  end if;
  select i.xstream_user, i.xstream_password, i.expires_at into a
    from public.iptv i
   where lower(btrim(coalesce(i.type, ''))) <> 'free'
     and ltrim(lower(btrim(coalesce(i.owner_id, ''))), '@') in (lower(coalesce(v_owner, '')), lower(coalesce(v_user, '')))
     and coalesce(i.xstream_user, '') <> '' and coalesce(i.xstream_password, '') <> ''
     and (i.expires_at is null or i.expires_at > now())
   order by i.assigned_at desc nulls last, i.id desc
   limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_premium', 'by_device', by_device);
  end if;
  return r || jsonb_build_object('user', a.xstream_user, 'pass', a.xstream_password,
                                 'account_expires_at', a.expires_at, 'by_device', by_device);
end $$;

revoke all on function public.iptv_premium_login(text, text) from public, anon, authenticated;
grant execute on function public.iptv_premium_login(text, text) to anon, authenticated;
revoke all on function public.iptv_premium_unlock(text, text, text, text, boolean, text, boolean) from public, anon, authenticated;
grant execute on function public.iptv_premium_unlock(text, text, text, text, boolean, text, boolean) to anon, authenticated;

notify pgrst, 'reload schema';
