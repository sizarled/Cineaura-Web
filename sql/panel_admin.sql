-- ============================================================
-- CineAura — Panel: the overview, the announcements, the bar of the home page and the
-- settings of the Panel button
-- Run this in the Supabase SQL editor (safe to run more than once), LAST: after
-- prize_secure.sql, profile.sql, content.sql, iptv_lists.sql, point_codes.sql, market.sql,
-- packages.sql and withdrawals.sql.
--
--   Panel > Overview        panel_overview(): the numbers of the site and what is waiting for
--                           the team. Each staff member sees the numbers of their own sections
--                           (the Super Admin: all of them).
--   Panel > Announcements   (the Super Admin, or staff with the Announcements section)
--                           * a message to the members: their bell (notifications, kind
--                             'announce'), to all of them, a plan (free / premium) or a country
--                             (announce_send; the history: site_announcements)
--                           * the bar at the top of the home page (site_banner: a text, an
--                             optional link, a colour, the dates it shows between), read by
--                             everybody through site_banner_get()
--   Panel > Accounts        panel_member_summary(): a member at a glance (Full info): points and
--                           level, videos, IPTV lists, store and orders, reviews, codes, claims,
--                           withdrawals.
--   Panel > Settings        panel_settings_save(): who sees the Panel button of the dashboard
--                           (admins / moderators / members; the Super Admin only). The page
--                           reads panel_settings; only this function writes it (section 8).
--
-- A table some installs do not have yet (the market, the IPTV lists…) is simply left out.
-- ============================================================

-- ------------------------------------------------------------------ 1. the bar of the home page
create table if not exists public.site_banner (
  id integer primary key default 1,
  text text not null default '',
  link text not null default '',                      -- https://… or a page of the site (./Market.html…)
  link_label text not null default '',
  tone text not null default 'info',                  -- info | success | warning | promo
  active boolean not null default false,
  starts_at timestamptz,                              -- empty: at once
  ends_at timestamptz,                                -- empty: until it is turned off
  version integer not null default 0,                 -- grows when the text changes: a visitor who closed it sees it again
  updated_by text not null default '',
  updated_at timestamptz not null default now(),
  constraint site_banner_one check (id = 1),
  constraint site_banner_tone check (tone in ('info', 'success', 'warning', 'promo')),
  constraint site_banner_len check (char_length(text) <= 280 and char_length(link) <= 500 and char_length(link_label) <= 40)
);
insert into public.site_banner (id) values (1) on conflict (id) do nothing;

-- ------------------------------------------------------------------ 2. announcements
create table if not exists public.site_announcements (
  id bigint generated always as identity primary key,
  title text not null,
  body text not null default '',
  href text not null default '',
  audience text not null default 'all',               -- all | free | premium | country
  country text not null default '',
  sent integer not null default 0,                    -- members who got it
  sent_by text not null default '',
  created_at timestamptz not null default now(),
  constraint site_announcements_audience check (audience in ('all', 'free', 'premium', 'country'))
);
create index if not exists site_announcements_created_idx on public.site_announcements (created_at desc);

-- nothing of this is open to the public API (site_banner_get() reads the bar)
do $$
declare t text; pol record;
begin
  foreach t in array array['site_banner', 'site_announcements'] loop
    execute format('alter table public.%I enable row level security', t);
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', pol.policyname, t);
    end loop;
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- ------------------------------------------------------------------ 3. helpers
-- The sections of a staff member: every section for the Super Admin.
create or replace function public._panel_sections(s public.staff) returns text[]
language sql immutable as $$
  select case when s.role = 'super'
              then array['accounts', 'links', 'iptv', 'apps', 'reports', 'prizes', 'messages', 'content', 'market', 'packages',
                         'withdrawals', 'announce', 'staff', 'settings']
              else array(select x from unnest(string_to_array(replace(coalesce(s.sections, ''), ' ', ''), ',')) x where x <> '') end
$$;

-- The Super Admin, or a staff member with section p_section. -> who did it
create or replace function public._panel_staff(p_token text, p_section text) returns text
language plpgsql security definer set search_path = public as $$
declare s public.staff;
begin
  s := public._staff(p_token);
  if not p_section = any (public._panel_sections(s)) then raise exception 'staff_forbidden'; end if;
  return coalesce(nullif(s.username, ''), s.role);
end $$;

-- A count (0 when its table or column is not there on this install).
create or replace function public._panel_n(p_sql text) returns bigint
language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  execute p_sql into n;
  return coalesce(n, 0);
exception when undefined_table or undefined_column or undefined_function then
  return 0;
end $$;

-- A link of the bar or of an announcement: https://…, or a page of the site (./Page.html…,
-- Page.html…). '' when it is not one.
create or replace function public._panel_link(p text) returns text language sql immutable as $$
  select case
    when btrim(coalesce(p, '')) ~* '^https?://[^/?#[:space:]<>"`]+[^[:space:]<>"`]*$' and length(btrim(p)) <= 500 then btrim(p)
    when btrim(coalesce(p, '')) ~ '^(\./)?[A-Za-z][A-Za-z0-9_-]*\.html([?#][^[:space:]<>"`]*)?$' and length(btrim(p)) <= 500
      then case when btrim(p) like './%' then btrim(p) else './' || btrim(p) end
    else '' end
$$;

-- ------------------------------------------------------------------ 4. the bar: read and save
-- The home page: the bar when it is on (and between its dates). -> { active, text, link, link_label, tone, version }
create or replace function public.site_banner_get() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((
    select jsonb_build_object('active', true, 'text', b.text, 'link', b.link, 'link_label', b.link_label, 'tone', b.tone,
                              'version', b.version)
      from public.site_banner b
     where b.id = 1 and b.active and btrim(b.text) <> ''
       and (b.starts_at is null or b.starts_at <= now()) and (b.ends_at is null or b.ends_at > now())),
    jsonb_build_object('active', false))
$$;

-- Panel > Announcements: the bar as it is saved (on or off).
create or replace function public.site_banner_admin(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare who text; b public.site_banner;
begin
  who := public._panel_staff(p_token, 'announce');
  select * into b from public.site_banner where id = 1;
  return jsonb_build_object('ok', true, 'banner', jsonb_build_object(
    'text', b.text, 'link', b.link, 'link_label', b.link_label, 'tone', b.tone, 'active', b.active,
    'starts_at', b.starts_at, 'ends_at', b.ends_at, 'version', b.version, 'updated_by', b.updated_by, 'updated_at', b.updated_at,
    'showing', (public.site_banner_get()->>'active')::boolean));
end $$;

-- d = { text (3 to 280 characters when it is on), link, link_label (40), tone, active, starts_at, ends_at }
--   -> { ok: true, banner } | { ok: false, reason: text | link | label | tone | dates }
create or replace function public.site_banner_save(p_token text, d jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  who text; x jsonb := case when jsonb_typeof(d) = 'object' then d else '{}'::jsonb end; b public.site_banner;
  v_text text := btrim(regexp_replace(coalesce(x->>'text', ''), '\s+', ' ', 'g'));
  v_link text := btrim(coalesce(x->>'link', '')); v_label text := btrim(regexp_replace(coalesce(x->>'link_label', ''), '\s+', ' ', 'g'));
  v_tone text := coalesce(nullif(x->>'tone', ''), 'info'); v_on boolean := lower(coalesce(x->>'active', '')) in ('true', '1', 'yes', 'on');
  v_from timestamptz; v_to timestamptz;
begin
  who := public._panel_staff(p_token, 'announce');
  if length(v_text) > 280 or (v_on and length(v_text) < 3) then return jsonb_build_object('ok', false, 'reason', 'text'); end if;
  if v_link <> '' then
    v_link := public._panel_link(v_link);
    if v_link = '' then return jsonb_build_object('ok', false, 'reason', 'link'); end if;
  end if;
  if length(v_label) > 40 then return jsonb_build_object('ok', false, 'reason', 'label'); end if;
  if v_tone not in ('info', 'success', 'warning', 'promo') then return jsonb_build_object('ok', false, 'reason', 'tone'); end if;
  begin
    v_from := nullif(btrim(coalesce(x->>'starts_at', '')), '')::timestamptz;
    v_to := nullif(btrim(coalesce(x->>'ends_at', '')), '')::timestamptz;
  exception when others then
    return jsonb_build_object('ok', false, 'reason', 'dates');
  end;
  if v_from is not null and v_to is not null and v_to <= v_from then return jsonb_build_object('ok', false, 'reason', 'dates'); end if;
  select * into b from public.site_banner where id = 1 for update;
  update public.site_banner
     set text = v_text, link = v_link, link_label = v_label, tone = v_tone, active = v_on, starts_at = v_from, ends_at = v_to,
         -- a new text (or link): shown again to the visitors who closed the one before
         version = version + case when (b.text, b.link) is distinct from (v_text, v_link) then 1 else 0 end,
         updated_by = who, updated_at = now()
   where id = 1;
  return public.site_banner_admin(p_token);
end $$;

-- ------------------------------------------------------------------ 5. announcements: send and history
-- The members an announcement goes to: active accounts of p_audience.
create or replace function public._announce_to(p_audience text, p_country text) returns setof text
language sql stable security definer set search_path = public as $$
  select m.member_id from public.members m
   where lower(btrim(coalesce(m.status, ''))) = 'active'
     and case p_audience
           when 'free' then lower(btrim(coalesce(m.membership_type, ''))) in ('', 'free')
           when 'premium' then lower(btrim(coalesce(m.membership_type, ''))) not in ('', 'free')
           when 'country' then upper(btrim(coalesce(m.country, ''))) = upper(btrim(coalesce(p_country, '')))
           else true end
$$;

-- How many members an announcement would reach. -> { ok, count }
create or replace function public.announce_preview(p_token text, p_audience text default 'all', p_country text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare who text;
begin
  who := public._panel_staff(p_token, 'announce');
  if coalesce(p_audience, 'all') not in ('all', 'free', 'premium', 'country') then return jsonb_build_object('ok', false, 'reason', 'audience'); end if;
  return jsonb_build_object('ok', true, 'count', (select count(*) from public._announce_to(coalesce(p_audience, 'all'), p_country)));
end $$;

-- Send an announcement to the bell of the members.
--   p_title 3 to 120 characters, p_body up to 500, p_href '' | https://… | a page of the site,
--   p_audience all | free | premium | country (p_country: the ISO code, MA…)
-- The same title twice within 2 minutes is refused (a double click).
--   -> { ok: true, id, sent } | { ok: false, reason: title | body | link | audience | country | nobody | duplicate }
create or replace function public.announce_send(p_token text, p_title text, p_body text default '', p_href text default '',
  p_audience text default 'all', p_country text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  who text; v_title text := btrim(regexp_replace(coalesce(p_title, ''), '\s+', ' ', 'g'));
  v_body text := btrim(coalesce(p_body, '')); v_href text := btrim(coalesce(p_href, ''));
  aud text := coalesce(nullif(p_audience, ''), 'all'); cc text := upper(btrim(coalesce(p_country, ''))); n int; aid bigint;
begin
  who := public._panel_staff(p_token, 'announce');
  if length(v_title) < 3 or length(v_title) > 120 then return jsonb_build_object('ok', false, 'reason', 'title'); end if;
  if length(v_body) > 500 then return jsonb_build_object('ok', false, 'reason', 'body'); end if;
  if v_href <> '' then
    v_href := public._panel_link(v_href);
    if v_href = '' then return jsonb_build_object('ok', false, 'reason', 'link'); end if;
  end if;
  if aud not in ('all', 'free', 'premium', 'country') then return jsonb_build_object('ok', false, 'reason', 'audience'); end if;
  if aud = 'country' and cc !~ '^[A-Z]{2}$' then return jsonb_build_object('ok', false, 'reason', 'country'); end if;
  if aud <> 'country' then cc := ''; end if;
  if exists (select 1 from public.site_announcements where title = v_title and created_at > now() - interval '2 minutes') then
    return jsonb_build_object('ok', false, 'reason', 'duplicate');
  end if;
  if to_regclass('public.notifications') is null then return jsonb_build_object('ok', false, 'reason', 'nobody'); end if;
  insert into public.notifications (member_id, kind, title, body, href, from_id, from_username)
  select t.id, 'announce', v_title, v_body, v_href, '', 'CineAura' from public._announce_to(aud, cc) as t(id);
  get diagnostics n = row_count;
  if n = 0 then return jsonb_build_object('ok', false, 'reason', 'nobody'); end if;
  insert into public.site_announcements (title, body, href, audience, country, sent, sent_by)
  values (v_title, v_body, v_href, aud, cc, n, who) returning id into aid;
  return jsonb_build_object('ok', true, 'id', aid, 'sent', n);
end $$;

-- The announcements sent, newest first. -> { ok, items: [{ id, title, body, href, audience, country, sent, sent_by, created_at, read }] }
create or replace function public.announce_list(p_token text, p_limit int default 30)
returns jsonb language plpgsql security definer set search_path = public as $$
declare who text;
begin
  who := public._panel_staff(p_token, 'announce');
  return jsonb_build_object('ok', true, 'items', coalesce((select jsonb_agg(jsonb_build_object(
      'id', a.id, 'title', a.title, 'body', a.body, 'href', a.href, 'audience', a.audience, 'country', a.country,
      'sent', a.sent, 'sent_by', a.sent_by, 'created_at', a.created_at,
      -- how many of them opened their bell since (read)
      'read', public._panel_n(format(
        'select count(*) from public.notifications where kind = %L and title = %L and read and created_at between %L::timestamptz - interval ''1 minute'' and %L::timestamptz + interval ''1 minute''',
        'announce', a.title, a.created_at, a.created_at)))
      order by a.created_at desc)
    from (select * from public.site_announcements order by created_at desc limit least(greatest(coalesce(p_limit, 30), 1), 200)) a), '[]'::jsonb));
end $$;

-- ------------------------------------------------------------------ 6. the overview
-- Panel > Overview: numbers of the sections of the staff member, the latest members and orders,
-- and what is waiting for the team (attention: [{ key, count, section, tab }]).
create or replace function public.panel_overview(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s public.staff; secs text[]; res jsonb := jsonb_build_object('ok', true); att jsonb := '[]'::jsonb; n bigint;
  mk boolean;
begin
  s := public._staff(p_token);
  secs := public._panel_sections(s);
  res := res || jsonb_build_object('sections', to_jsonb(secs), 'role', s.role);

  if 'accounts' = any (secs) then
    res := res || jsonb_build_object('members', jsonb_build_object(
      'all', public._panel_n('select count(*) from public.members'),
      'active', public._panel_n('select count(*) from public.members where lower(btrim(coalesce(status, ''''))) = ''active'''),
      'banned', public._panel_n('select count(*) from public.members where lower(btrim(coalesce(status, ''''))) = ''banned'''),
      'waiting', public._panel_n('select count(*) from public.members where lower(btrim(coalesce(status, ''''))) not in (''active'', ''banned'')'),
      'premium', public._panel_n('select count(*) from public.members where lower(btrim(coalesce(status, ''''))) = ''active'' and lower(btrim(coalesce(membership_type, ''''))) not in ('''', ''free'')'),
      'new_7d', public._panel_n('select count(*) from public.members where created_at > now() - interval ''7 days'''),
      'new_30d', public._panel_n('select count(*) from public.members where created_at > now() - interval ''30 days'''),
      -- accounts that will be banned within 7 days (not activated in time: account_deadline.sql)
      'ban_soon', public._panel_n('select count(*) from public.members where ban_due_at is not null and ban_due_at <= now() + interval ''7 days'' and lower(btrim(coalesce(status, ''''))) <> ''banned''')));
    res := res || jsonb_build_object('recent_members', coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.member_id, 'username', m.username, 'country', m.country, 'status', m.status, 'plan', m.membership_type,
        'created_at', m.created_at,
        'avatar', coalesce((select p.avatar_url from public.profiles p where p.member_id = m.member_id), '')) order by m.created_at desc)
      from (select * from public.members order by created_at desc nulls last limit 6) m), '[]'::jsonb));
    n := (res->'members'->>'ban_soon')::bigint;
    if n > 0 then att := att || jsonb_build_object('key', 'ban_soon', 'count', n, 'section', 'accounts', 'tab', ''); end if;
  end if;

  if 'reports' = any (secs) then
    res := res || jsonb_build_object('reports', jsonb_build_object(
      'links', public._panel_n('select count(*) from public.reportlinks where verdict = ''valid'''),
      'channels', public._panel_n('select count(*) from public.channel_reports where status = ''open'''),
      'market', public._panel_n('select count(*) from public.market_reports where status = ''open''')));
    n := (res->'reports'->>'links')::bigint;
    if n > 0 then att := att || jsonb_build_object('key', 'reports_links', 'count', n, 'section', 'reports', 'tab', 'links'); end if;
    n := (res->'reports'->>'channels')::bigint;
    if n > 0 then att := att || jsonb_build_object('key', 'reports_channels', 'count', n, 'section', 'reports', 'tab', 'channels'); end if;
    n := (res->'reports'->>'market')::bigint;
    if n > 0 then att := att || jsonb_build_object('key', 'reports_market', 'count', n, 'section', 'reports', 'tab', 'market'); end if;
  end if;

  if 'prizes' = any (secs) then
    res := res || jsonb_build_object('prizes', jsonb_build_object(
      'submitted', public._panel_n('select count(*) from public.prize_claims where status = ''submitted'''),
      'review', public._panel_n('select count(*) from public.prize_claims where status = ''review'''),
      'prizes', public._panel_n('select count(*) from public.prizes')));
    n := (res->'prizes'->>'submitted')::bigint + (res->'prizes'->>'review')::bigint;
    if n > 0 then att := att || jsonb_build_object('key', 'claims', 'count', n, 'section', 'prizes', 'tab', 'claims'); end if;
  end if;

  if 'messages' = any (secs) then
    res := res || jsonb_build_object('messages', jsonb_build_object(
      'unread', public._panel_n('select count(*) from public.panel_messages where not read'),
      'all', public._panel_n('select count(*) from public.panel_messages')));
    n := (res->'messages'->>'unread')::bigint;
    if n > 0 then att := att || jsonb_build_object('key', 'messages', 'count', n, 'section', 'messages', 'tab', ''); end if;
  end if;

  if 'content' = any (secs) then
    res := res || jsonb_build_object('content', jsonb_build_object(
      'videos', public._panel_n('select count(*) from public.content'),
      'videos_7d', public._panel_n('select count(*) from public.content where created_at > now() - interval ''7 days'''),
      'views', public._panel_n('select coalesce(sum(views), 0) from public.content'),
      'suspended', public._panel_n('select count(*) from public.content where suspended_at is not null'),
      'playlists', public._panel_n('select count(*) from public.content_playlists'),
      'iptv_lists', public._panel_n('select count(*) from public.iptv_lists'),
      'iptv_suspended', public._panel_n('select count(*) from public.iptv_lists where suspended_at is not null')));
  end if;

  mk := 'market' = any (secs) or 'reports' = any (secs);
  if mk and to_regclass('public.market_orders') is not null then
    res := res || jsonb_build_object('market', jsonb_build_object(
      'stores', public._panel_n('select count(*) from public.market_stores'),
      'stores_open', public._panel_n('select count(*) from public.market_stores where is_open and not suspended'),
      'products', public._panel_n('select count(*) from public.market_products where status = ''active'''),
      'open_orders', public._panel_n('select count(*) from public.market_orders where settled_at is null and status in (''requested'', ''sold'', ''shipped'', ''delivered'', ''return_requested'')'),
      'returns', public._panel_n('select count(*) from public.market_orders where status = ''return_requested'''),
      'escrow', public._panel_n('select coalesce(sum(total), 0) from public.market_orders where settled_at is null and status in (''requested'', ''sold'', ''shipped'', ''delivered'', ''return_requested'')'),
      'sales_30d', public._panel_n('select coalesce(sum(total), 0) from public.market_orders where status = ''delivered'' and delivered_at > now() - interval ''30 days''')));
    if 'market' = any (secs) then
      -- the latest orders (Panel > Market > Orders)
      res := res || jsonb_build_object('recent_orders', coalesce((select jsonb_agg(jsonb_build_object(
          'id', o.id, 'title', o.title, 'image', o.image, 'total', o.total, 'status', o.status, 'settled', o.settled_at is not null,
          'created_at', o.created_at,
          'buyer', coalesce((select m.username from public.members m where m.member_id = o.buyer_id), ''),
          'seller', coalesce((select m.username from public.members m where m.member_id = o.seller_id), '')) order by o.created_at desc)
        from (select * from public.market_orders order by created_at desc limit 6) o), '[]'::jsonb));
      n := (res->'market'->>'returns')::bigint;
      if n > 0 then att := att || jsonb_build_object('key', 'returns', 'count', n, 'section', 'market', 'tab', 'orders'); end if;
      n := public._panel_n('select count(*) from public.market_orders where status = ''requested'' and created_at < now() - interval ''3 days''');
      if n > 0 then att := att || jsonb_build_object('key', 'requests_old', 'count', n, 'section', 'market', 'tab', 'orders'); end if;
    end if;
  end if;

  -- Panel > Packages (sql/point_codes.sql, sql/packages.sql); 'points': the section of round 27
  if 'packages' = any (secs) or 'points' = any (secs) then
    res := res || jsonb_build_object('packages', jsonb_build_object(
      'points', public._panel_n('select count(*) from public.point_codes where not used and uses < max_uses and (expires_at is null or expires_at > now())'),
      'accounts', public._panel_n('select count(*) from public.account_codes where uses < max_uses and (expires_at is null or expires_at > now())'),
      'prizes', public._panel_n('select count(*) from public.prize_pack_codes where uses < max_uses and (expires_at is null or expires_at > now())'),
      'used_30d', public._panel_n('select count(*) from public.point_code_uses where used_at > now() - interval ''30 days''')
                  + public._panel_n('select count(*) from public.account_code_uses where used_at > now() - interval ''30 days''')
                  + public._panel_n('select count(*) from public.prize_pack_uses where used_at > now() - interval ''30 days'''),
      'points_30d', public._panel_n('select coalesce(sum(points), 0) from public.point_code_uses where used_at > now() - interval ''30 days''')));
  end if;

  -- Panel > Withdrawals (sql/withdrawals.sql): the requests waiting, the points they hold, what was sent
  -- (in the currency of the settings; cents, so that _panel_n counts them)
  if 'withdrawals' = any (secs) and to_regclass('public.withdrawals') is not null then
    res := res || jsonb_build_object('withdrawals', jsonb_build_object(
      'pending', public._panel_n('select count(*) from public.withdrawals where status = ''pending'''),
      'processing', public._panel_n('select count(*) from public.withdrawals where status = ''processing'''),
      'held', public._panel_n('select coalesce(sum(points), 0) from public.withdrawals where status in (''pending'', ''processing'')'),
      'paid_30d', public._panel_n('select count(*) from public.withdrawals where status = ''paid'' and paid_at > now() - interval ''30 days'''),
      'paid_30d_cents', public._panel_n('select coalesce(round(sum(w.net) * 100), 0)::bigint from public.withdrawals w join public.withdraw_settings s on s.id = 1 and s.currency = w.currency where w.status = ''paid'' and w.paid_at > now() - interval ''30 days'''),
      'currency', coalesce((select currency from public.withdraw_settings where id = 1), 'USD')));
    n := (res->'withdrawals'->>'pending')::bigint;
    if n > 0 then att := att || jsonb_build_object('key', 'withdrawals', 'count', n, 'section', 'withdrawals', 'tab', ''); end if;
  end if;

  if 'announce' = any (secs) then
    res := res || jsonb_build_object('announce', jsonb_build_object(
      'banner', public.site_banner_get(),
      'last', (select jsonb_build_object('title', a.title, 'sent', a.sent, 'created_at', a.created_at)
                 from public.site_announcements a order by a.created_at desc limit 1)));
  end if;

  return res || jsonb_build_object('attention', att, 'at', now());
end $$;

-- ------------------------------------------------------------------ 7. a member at a glance
-- Panel > Accounts > Full info. -> { ok, points, level, content, iptv, market, codes, claims, follows } | { ok: false, reason: not_found }
create or replace function public.panel_member_summary(p_token text, p_member text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare who text; m public.members; v_id text; pts jsonb := '{}'::jsonb; lv int; st record;
begin
  who := public._panel_staff(p_token, 'accounts');
  select * into m from public.members where member_id = btrim(coalesce(p_member, ''));
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  v_id := m.member_id;
  begin
    pts := public._points(v_id);
    if to_regprocedure('public.points_level(bigint)') is not null then
      lv := public.points_level(coalesce((pts->>'earned')::bigint, 0));
    end if;
  exception when others then pts := '{}'::jsonb;
  end;
  return jsonb_build_object('ok', true,
    'points', pts,
    'level', case when lv is not null then jsonb_build_object('level', lv, 'name', public.points_level_name(lv),
                                                                'multiplier', public.points_multiplier(lv)) end,
    'follows', jsonb_build_object(
      'followers', public._panel_n(format('select count(*) from public.follows where following_id = %L and status = ''accepted''', v_id)),
      'following', public._panel_n(format('select count(*) from public.follows where follower_id = %L and status = ''accepted''', v_id))),
    'content', jsonb_build_object(
      'videos', public._panel_n(format('select count(*) from public.content where owner_id = %L', v_id)),
      'suspended', public._panel_n(format('select count(*) from public.content where owner_id = %L and suspended_at is not null', v_id)),
      'views', public._panel_n(format('select coalesce(sum(views), 0) from public.content where owner_id = %L', v_id)),
      'playlists', public._panel_n(format('select count(*) from public.content_playlists where owner_id = %L', v_id))),
    'iptv', jsonb_build_object(
      'lists', public._panel_n(format('select count(*) from public.iptv_lists where owner_id = %L', v_id)),
      'suspended', public._panel_n(format('select count(*) from public.iptv_lists where owner_id = %L and suspended_at is not null', v_id))),
    'market', jsonb_build_object(
      'store', case when to_regclass('public.market_stores') is not null then
                 (select jsonb_build_object('id', s.id, 'name', s.name, 'suspended', s.suspended, 'is_open', s.is_open,
                                            'sales_points', s.sales_points,
                                            'tier', case when to_regprocedure('public._mkt_tier(bigint)') is not null
                                                         then public._mkt_tier(s.sales_points) end)
                    from public.market_stores s where s.owner_id = v_id) end,
      'products', public._panel_n(format('select count(*) from public.market_products where owner_id = %L and status <> ''deleted''', v_id)),
      'sales', public._panel_n(format('select count(*) from public.market_orders where seller_id = %L and status = ''delivered''', v_id)),
      'purchases', public._panel_n(format('select count(*) from public.market_orders where buyer_id = %L and status not in (''declined'', ''cancelled'')', v_id)),
      'open_orders', public._panel_n(format('select count(*) from public.market_orders where (buyer_id = %L or seller_id = %L) and settled_at is null and status in (''requested'', ''sold'', ''shipped'', ''delivered'', ''return_requested'')', v_id, v_id)),
      'reviews', public._panel_n(format('select count(*) from public.market_reviews where member_id = %L', v_id)),
      'reports', public._panel_n(format('select count(*) from public.market_reports where owner_id = %L and status = ''open''', v_id))),
    'codes', jsonb_build_object(
      'used', public._panel_n(format('select count(*) from public.point_code_uses where member_id = %L', v_id)),
      'points', public._panel_n(format('select coalesce(sum(points), 0) from public.point_code_uses where member_id = %L', v_id)),
      'accounts', public._panel_n(format('select count(*) from public.account_code_uses where member_id = %L', v_id)),
      'prizes', public._panel_n(format('select count(*) from public.prize_pack_uses where member_id = %L', v_id))),
    'claims', jsonb_build_object(
      'all', public._panel_n(format('select count(*) from public.prize_claims where member_id = %L', v_id)),
      'open', public._panel_n(format('select count(*) from public.prize_claims where member_id = %L and status in (''submitted'', ''review'')', v_id))),
    -- withdrawals (sql/withdrawals.sql): sent, the points they took, the one waiting
    'withdrawals', case when to_regclass('public.withdrawals') is not null then jsonb_build_object(
      'paid', public._panel_n(format('select count(*) from public.withdrawals where member_id = %L and status = ''paid''', v_id)),
      'points', public._panel_n(format('select coalesce(sum(points), 0) from public.withdrawals where member_id = %L and status = ''paid''', v_id)),
      'open', public._panel_n(format('select count(*) from public.withdrawals where member_id = %L and status in (''pending'', ''processing'')', v_id))) end);
end $$;

-- ------------------------------------------------------------------ 8. Panel > Settings: who sees the Panel button
-- The dashboard reads panel_settings (sql/panel.sql) to show the Panel button to admins, moderators
-- or members. Saving it went straight to the table from the browser; it now goes through
-- panel_settings_save() (the Super Admin), which works whatever the table's policies and grants:
-- the Data API of the Supabase projects made since 30 May 2026 (and, on 30 October 2026, of every
-- project) no longer opens a new table by itself, so the table is opened for reading here.
create table if not exists public.panel_settings (
  id integer primary key default 1,
  show_admin boolean not null default true,
  show_moderator boolean not null default true,
  show_member boolean not null default false,
  constraint panel_settings_one check (id = 1)
);
alter table public.panel_settings add column if not exists show_admin boolean not null default true;
alter table public.panel_settings add column if not exists show_moderator boolean not null default true;
alter table public.panel_settings add column if not exists show_member boolean not null default false;
insert into public.panel_settings (show_admin, show_moderator, show_member)
select true, true, false where not exists (select 1 from public.panel_settings);
alter table public.panel_settings enable row level security;
do $$
declare pol record;
begin
  -- read by everybody, written by nobody through the API
  for pol in select policyname from pg_policies
              where schemaname = 'public' and tablename = 'panel_settings' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL') loop
    execute format('drop policy %I on public.panel_settings', pol.policyname);
  end loop;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'panel_settings' and cmd = 'SELECT') then
    create policy "open select" on public.panel_settings for select to anon, authenticated using (true);
  end if;
end $$;
revoke insert, update, delete, truncate on public.panel_settings from anon, authenticated;
grant select on public.panel_settings to anon, authenticated;

-- -> { ok: true, settings: { show_admin, show_moderator, show_member } } (staff_forbidden: not the Super Admin)
create or replace function public.panel_settings_save(p_token text, p_show_admin boolean, p_show_moderator boolean,
  p_show_member boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.staff; r record;
begin
  s := public._staff(p_token);
  if s.role <> 'super' then raise exception 'staff_forbidden'; end if;
  update public.panel_settings
     set show_admin = coalesce(p_show_admin, true), show_moderator = coalesce(p_show_moderator, true),
         show_member = coalesce(p_show_member, false);
  if not found then
    begin
      insert into public.panel_settings (id, show_admin, show_moderator, show_member)
      values (1, coalesce(p_show_admin, true), coalesce(p_show_moderator, true), coalesce(p_show_member, false));
    exception when others then
      insert into public.panel_settings (show_admin, show_moderator, show_member)
      values (coalesce(p_show_admin, true), coalesce(p_show_moderator, true), coalesce(p_show_member, false));
    end;
  end if;
  select show_admin, show_moderator, show_member into r from public.panel_settings limit 1;
  return jsonb_build_object('ok', true, 'settings', jsonb_build_object('show_admin', r.show_admin,
    'show_moderator', r.show_moderator, 'show_member', r.show_member));
end $$;

-- ------------------------------------------------------------------ 9. who may call what
do $$
declare f text;
begin
  foreach f in array array[
    'public._panel_sections(public.staff)', 'public._panel_staff(text, text)', 'public._panel_n(text)', 'public._panel_link(text)',
    'public._announce_to(text, text)']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'public.site_banner_get()', 'public.site_banner_admin(text)', 'public.site_banner_save(text, jsonb)',
    'public.announce_preview(text, text, text)', 'public.announce_send(text, text, text, text, text, text)',
    'public.announce_list(text, int)', 'public.panel_overview(text)', 'public.panel_member_summary(text, text)',
    'public.panel_settings_save(text, boolean, boolean, boolean)']
  loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
