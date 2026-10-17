-- ============================================================
-- CineAura — Market.html: the members' market
-- Run this in the Supabase SQL editor (safe to run more than once), AFTER content.sql,
-- account_deadline.sql and image_uploads.sql.
--
-- Unlike the Prizes (published by the staff), the market is filled by the members: every
-- member can open one store and sell products for points; every member can buy.
--
--   stores       market_stores       one per member (Market.html > Store settings): logo and
--                                    cover (an image link, or uploaded to IPTV/Market/Logo/<id>.jpg
--                                    and IPTV/Market/Cover/<id>.jpg), name, description, related
--                                    links, open / closed, reach (city / country / continent /
--                                    world), sale (instant / on request), shipping (yes / no),
--                                    returns (allowed / not) and the return period in days.
--                                    A store without a product for sale is closed by itself and
--                                    opens again as soon as one is for sale.
--   categories   market_categories   written by the sellers: a product names 1 to 5 categories,
--                                    a name nobody used yet becomes a new category.
--   products     market_products     title, description, physical / digital, price in points
--                                    (PT), shipping cost, pieces left, pictures (links, or
--                                    uploaded to IPTV/Market/Product/<id>.jpg, <id>-1.jpg …) and
--                                    one embedded video.
--   buy later    market_saved
--   orders       market_orders
--   reviews      market_reviews      buyers only: the good points and the bad points
--   requests     market_requests     "can you get this item?" / a question about a product
--
-- Ids: stores STR + 9 digits, products PRD + 10, categories CAT + 7, orders ORD + 10.
--
-- An order, and its points:
--
--   requested ──accept──► sold ──ship──► shipped ──received──► delivered ──► (paid)
--      │ decline / cancel    │ cancel      (14 days after shipping: received by itself)
--      ▼                     ▼                                     │ return (within the period)
--   declined / cancelled (points back)                    return_requested ──accept──► returned
--                                                                 └─refuse──► delivered (points back on accept)
--
--   * "instant" stores start at sold, "on request" stores at requested (the seller accepts).
--   * The buyer pays at once (price x pieces + shipping): profiles.points_spent grows and
--     point_spends gets a row (mode 'market'). The points are held: the seller receives them
--     when the order is delivered and its return period is over (at once when the store takes
--     no returns). A cancelled, declined or returned order gives them back to the buyer
--     (a point_spends row with a negative amount, mode 'market_refund').
--   * Sharing: Market.html?Product=<id>&@<username>. A sale made through that link gives the
--     member who shared it 25% of the price (pieces x price, shipping not included), added by
--     the site when the seller is paid — the seller still receives everything. Not for the
--     buyer or the seller themselves.
--   * The points received (sales: profiles.market_points / market_sales; shares:
--     market_ref_points / market_refs) are earned points like the others: they count for the
--     level (_points() below).
--
-- Who sees what: nothing here is open to the public API; the browser calls the functions
-- (security definer), which check the member, the owner and the order of every action.
-- As everywhere on the site (custom sign-in), the browser says which member it is.
--
-- Optional (Supabase > Database > Extensions > pg_cron): pay the sellers on time even when
-- nobody opens the market:
--   select cron.schedule('market-settle', '23 * * * *', $$select public.market_settle()$$);
-- ============================================================

-- ------------------------------------------------------------------ 1. points columns
alter table public.profiles add column if not exists market_points bigint not null default 0;
alter table public.profiles add column if not exists market_sales integer not null default 0;
alter table public.profiles add column if not exists market_ref_points bigint not null default 0;
alter table public.profiles add column if not exists market_refs integer not null default 0;
comment on column public.profiles.market_points is 'Points received for the sales of the member''s store (Market.html, sql/market.sql).';
comment on column public.profiles.market_sales is 'Sales of the member''s store already paid.';
comment on column public.profiles.market_ref_points is 'Points received for sales made through the member''s share links (25% of the price).';
comment on column public.profiles.market_refs is 'Sales made through the member''s share links (paid).';

create or replace function public._guard_market_points() returns trigger language plpgsql as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      new.market_points := 0; new.market_sales := 0; new.market_ref_points := 0; new.market_refs := 0;
    else
      new.market_points := old.market_points; new.market_sales := old.market_sales;
      new.market_ref_points := old.market_ref_points; new.market_refs := old.market_refs;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists profiles_guard_market_points on public.profiles;
create trigger profiles_guard_market_points before insert or update on public.profiles
  for each row execute function public._guard_market_points();

-- ------------------------------------------------------------------ 2. tables
create table if not exists public.market_stores (
  id text primary key,
  owner_id text not null unique references public.members(member_id) on delete cascade,
  name text not null,
  description text not null default '',
  logo_url text not null default '',
  cover_url text not null default '',
  links jsonb not null default '[]'::jsonb,           -- [{ label, url }]
  is_open boolean not null default true,              -- the seller's switch
  scope text not null default 'country',
  country text not null default '',                   -- where the store is (ISO code)
  city text not null default '',
  sale_mode text not null default 'instant',
  shipping boolean not null default true,
  returns boolean not null default false,
  return_days integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint market_stores_scope check (scope in ('city', 'country', 'continent', 'world')),
  constraint market_stores_mode check (sale_mode in ('instant', 'request')),
  constraint market_stores_days check (return_days between 0 and 90)
);

create table if not exists public.market_categories (
  id text primary key,
  name text not null,
  name_key text not null unique,                      -- lower case, single spaces
  created_by text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.market_products (
  id text primary key,
  store_id text not null references public.market_stores(id) on delete cascade,
  owner_id text not null,
  title text not null,
  description text not null default '',
  kind text not null default 'physical',
  price integer not null,
  shipping_cost integer not null default 0,
  stock integer not null default 1,
  images jsonb not null default '[]'::jsonb,
  video_url text not null default '',
  status text not null default 'active',              -- active | hidden (by the seller) | deleted
  sales integer not null default 0,                   -- pieces sold (orders not cancelled / returned)
  pros integer not null default 0,                    -- good points written by buyers
  cons integer not null default 0,                    -- bad points
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint market_products_kind check (kind in ('physical', 'digital')),
  constraint market_products_status check (status in ('active', 'hidden', 'deleted')),
  constraint market_products_price check (price between 1 and 10000000),
  constraint market_products_ship check (shipping_cost between 0 and 1000000),
  constraint market_products_stock check (stock between 0 and 100000)
);
create index if not exists market_products_store_idx on public.market_products (store_id, status);
create index if not exists market_products_live_idx on public.market_products (status, created_at desc);
create index if not exists market_products_owner_idx on public.market_products (owner_id, created_at desc);

create table if not exists public.market_product_categories (
  product_id text not null references public.market_products(id) on delete cascade,
  category_id text not null references public.market_categories(id) on delete cascade,
  primary key (product_id, category_id)
);
create index if not exists market_product_categories_cat_idx on public.market_product_categories (category_id);

create table if not exists public.market_saved (
  member_id text not null,
  product_id text not null references public.market_products(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (member_id, product_id)
);

create table if not exists public.market_orders (
  id text primary key,
  product_id text not null,
  store_id text not null,
  seller_id text not null,
  buyer_id text not null,
  referrer_id text,                                   -- who shared the link the buyer came from
  title text not null,                                -- the product when it was bought
  image text not null default '',
  kind text not null default 'physical',
  qty integer not null default 1,
  unit_price integer not null,
  shipping_cost integer not null default 0,
  total integer not null,                             -- unit_price x qty + shipping_cost
  commission integer not null default 0,              -- 25% of unit_price x qty for the referrer
  buyer_country text not null default '',
  address jsonb not null default '{}'::jsonb,         -- name, phone, city, line, note
  status text not null,
  tracking text not null default '',                  -- the seller's shipping note / digital delivery
  reason text not null default '',                    -- why it was declined, cancelled, returned, refused
  return_days integer not null default 0,             -- the store's return period on the day of the order
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  shipped_at timestamptz,
  delivered_at timestamptz,
  auto_delivered boolean not null default false,
  return_requested_at timestamptz,
  returned_at timestamptz,
  closed_at timestamptz,
  settled_at timestamptz,                             -- the seller (and the referrer) were paid
  updated_at timestamptz not null default now(),
  constraint market_orders_status check (status in ('requested', 'sold', 'shipped', 'delivered', 'return_requested', 'returned', 'cancelled', 'declined')),
  constraint market_orders_qty check (qty between 1 and 100)
);
create index if not exists market_orders_seller_idx on public.market_orders (seller_id, status, updated_at desc);
create index if not exists market_orders_buyer_idx on public.market_orders (buyer_id, status, updated_at desc);
create index if not exists market_orders_product_idx on public.market_orders (product_id, created_at desc);
create index if not exists market_orders_country_idx on public.market_orders (buyer_country, created_at desc);
create index if not exists market_orders_due_idx on public.market_orders (status, shipped_at, delivered_at) where settled_at is null;

create table if not exists public.market_reviews (
  order_id text primary key references public.market_orders(id) on delete cascade,
  product_id text not null,
  store_id text not null,
  seller_id text not null,
  buyer_id text not null,
  pros jsonb not null default '[]'::jsonb,            -- ["…", …] the good points
  cons jsonb not null default '[]'::jsonb,            -- the bad points
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists market_reviews_product_idx on public.market_reviews (product_id, created_at desc);
create index if not exists market_reviews_seller_idx on public.market_reviews (seller_id, created_at desc);
create index if not exists market_reviews_buyer_idx on public.market_reviews (buyer_id, created_at desc);

create table if not exists public.market_requests (
  id bigint generated always as identity primary key,
  from_id text not null,
  to_id text not null,                                -- the owner of the store
  store_id text not null,
  product_id text,                                    -- a question is about a product
  kind text not null,                                 -- item | question
  body text not null,
  reply text not null default '',
  status text not null default 'open',                -- open | answered | closed
  created_at timestamptz not null default now(),
  replied_at timestamptz,
  constraint market_requests_kind check (kind in ('item', 'question')),
  constraint market_requests_status check (status in ('open', 'answered', 'closed'))
);
create index if not exists market_requests_to_idx on public.market_requests (to_id, created_at desc);
create index if not exists market_requests_from_idx on public.market_requests (from_id, created_at desc);

-- Faster "contains" searches when pg_trgm can be installed (optional).
do $$
begin
  create extension if not exists pg_trgm with schema extensions;
  execute 'create index if not exists market_products_title_trgm_idx on public.market_products using gin (lower(title) gin_trgm_ops)';
  execute 'create index if not exists market_stores_name_trgm_idx on public.market_stores using gin (lower(name) gin_trgm_ops)';
  execute 'create index if not exists market_categories_name_trgm_idx on public.market_categories using gin (lower(name) gin_trgm_ops)';
exception when others then
  raise notice 'pg_trgm is not available: the market search reads the names one by one.';
end $$;

-- nothing of this is open to the public API
do $$
declare t text; pol record;
begin
  foreach t in array array['market_stores', 'market_categories', 'market_products', 'market_product_categories',
                           'market_saved', 'market_orders', 'market_reviews', 'market_requests']
  loop
    execute format('alter table public.%I enable row level security', t);
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', pol.policyname, t);
    end loop;
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- ------------------------------------------------------------------ 3. the points formula
-- Same body in prize_secure.sql, point_levels.sql, point_codes.sql, content.sql and market.sql
-- (kept identical, so the file run last always leaves the same formula). Every column is read
-- through to_jsonb(), so a database that never ran one of those files simply has 0 for its source.
create or replace function public._points(p_member text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  pr record; earned bigint; watch bigint; vids bigint; codes bigint; mk bigint; mr bigint; sh int; pl int; rc int; cm int; lk int := 0;
  dl bigint := 0; clicks bigint; has_dl boolean;
begin
  select coalesce(p.private_minutes, 0) + coalesce(p.public_minutes, 0) as mins,
         coalesce(p.points_spent, 0) as spent,
         to_jsonb(p) ->> 'watch_points' as wp,
         to_jsonb(p) ->> 'content_points' as vp,
         to_jsonb(p) ->> 'code_points' as cp,
         to_jsonb(p) ->> 'market_points' as mp,
         to_jsonb(p) ->> 'market_ref_points' as mrp
    into pr
  from public.profiles p where p.member_id = p_member;
  if not found then return jsonb_build_object('earned', 0, 'spent', 0, 'available', 0, 'watch', 0, 'videos', 0, 'codes', 0, 'market', 0, 'market_refs', 0); end if;
  -- watch points: stored by sql/point_levels.sql (country tier x level); before that file, 1 a minute
  watch := case when pr.wp is null then pr.mins else floor(pr.wp::numeric)::bigint end;
  -- videos (sql/content.sql): minutes watched, shares, comments and positive recommendations
  vids := floor(coalesce(pr.vp, '0')::numeric)::bigint;
  -- points codes (sql/point_codes.sql)
  codes := floor(coalesce(pr.cp, '0')::numeric)::bigint;
  -- the market (sql/market.sql): sales of the member's store, and 25% of the sales made through their links
  mk := floor(coalesce(pr.mp, '0')::numeric)::bigint;
  mr := floor(coalesce(pr.mrp, '0')::numeric)::bigint;
  select count(*) into sh from public.post_events where kind = 'share' and network = 'referral' and member_id = p_member;
  select count(*) into pl from public.playlists where owner_id = p_member and visibility in ('public', 'exclusive');
  select count(*) into rc from public.posts where owner_id = p_member and kind in ('recommendation', 'reclist') and visibility in ('public', 'exclusive');
  select count(*) into cm from public.comments where member_id = p_member;
  -- watch links published: 500 links = 1 point; banned links do not count
  if to_regclass('public.movielink') is not null then
    select count(*) into lk from public.movielink where member_id = p_member and coalesce(banned, false) = false;
  end if;
  if to_regclass('public.tvlink') is not null then
    select lk + count(*) into lk from public.tvlink where member_id = p_member and coalesce(banned, false) = false;
  end if;
  -- Clicks on the member's download links: 1000 clicks = 1 point. The counter
  -- (movielink / tvlink .clicks) only exists after sql/links.sql has been run,
  -- so the term is skipped on a database that never had it.
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name in ('movielink', 'tvlink')
      and column_name in ('clicks', 'link_kind')
    group by column_name having count(*) = 2
  ) into has_dl;
  if coalesce(has_dl, false) then
    if to_regclass('public.movielink') is not null then
      execute 'select coalesce(sum(clicks), 0) from public.movielink
               where member_id = $1 and coalesce(link_kind, ''watch'') = ''download'''
        into clicks using p_member;
      dl := dl + coalesce(clicks, 0);
    end if;
    if to_regclass('public.tvlink') is not null then
      execute 'select coalesce(sum(clicks), 0) from public.tvlink
               where member_id = $1 and coalesce(link_kind, ''watch'') = ''download'''
        into clicks using p_member;
      dl := dl + coalesce(clicks, 0);
    end if;
  end if;
  earned := watch + vids + codes + mk + mr + sh / 5 + pl / 10 + rc / 50 + cm / 100 + lk / 500 + dl / 1000;
  return jsonb_build_object('earned', earned, 'spent', pr.spent, 'available', greatest(0, earned - pr.spent),
                            'watch', watch, 'videos', vids, 'codes', codes, 'market', mk, 'market_refs', mr);
end $$;

-- ------------------------------------------------------------------ 4. helpers
-- The member who acts: an active account (not banned, not disabled), else a row of nulls.
create or replace function public._mkt_member(p_member text) returns public.members
language sql stable security definer set search_path = public as $$
  select m.* from public.members m
   where m.member_id = btrim(coalesce(p_member, ''))
     and lower(btrim(coalesce(m.status, ''))) = 'active'
$$;

-- Restricted by Panel > Accounts: a temporary ban stops everything; a ban on posts stops
-- selling, reviews and requests (p_publish).
create or replace function public._mkt_blocked(p_member text, p_publish boolean default false) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare s record; feats text[];
begin
  if to_regclass('public.sanctions') is null then return false; end if;
  select features, temp_until into s from public.sanctions where member_id = p_member;
  if not found then return false; end if;
  if s.temp_until is not null and s.temp_until > now() then return true; end if;
  if not p_publish then return false; end if;
  feats := string_to_array(replace(coalesce(s.features, ''), ' ', ''), ',');
  return 'posts' = any (feats);
end $$;

create or replace function public._mkt_int(p text) returns int language sql immutable as $$
  select case when btrim(coalesce(p, '')) ~ '^-?[0-9]{1,9}$' then btrim(p)::int end
$$;

create or replace function public._mkt_bool(p text, p_default boolean) returns boolean language sql immutable as $$
  select case when lower(btrim(coalesce(p, ''))) in ('true', 't', '1', 'yes', 'on') then true
              when lower(btrim(coalesce(p, ''))) in ('false', 'f', '0', 'no', 'off') then false
              else p_default end
$$;

-- one line, single spaces
create or replace function public._mkt_line(p text) returns text language sql immutable as $$
  select btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g'))
$$;

create or replace function public._mkt_norm(p text) returns text language sql immutable as $$
  select lower(public._mkt_line(p))
$$;

-- The continent of a country (ISO code), for the stores that sell to their continent.
create or replace function public._mkt_continent(p_cc text) returns text language sql immutable as $$
  select case
    when c = any (string_to_array('DZ AO BJ BW BF BI CV CM CF TD KM CG CD CI DJ EG GQ ER SZ ET GA GM GH GN GW KE LS LR LY MG MW ML MR MU YT MA MZ NA NE NG RE RW SH ST SN SC SL SO ZA SS SD TZ TG TN UG EH ZM ZW', ' ')) then 'africa'
    when c = any (string_to_array('AF AM AZ BH BD BT BN KH CN GE HK IN ID IR IQ IL JP JO KZ KW KG LA LB MO MY MV MN MM NP KP OM PK PS PH QA SA SG KR LK SY TW TJ TH TL TR TM AE UZ VN YE IO CC CX', ' ')) then 'asia'
    when c = any (string_to_array('AD AL AT AX BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM UA VA XK', ' ')) then 'europe'
    when c = any (string_to_array('AG AI AW BB BL BM BQ BS BZ CA CR CU CW DM DO GD GL GP GT HN HT JM KN KY LC MF MQ MS MX NI PA PM PR SV SX TC TT US VC VG VI', ' ')) then 'north_america'
    when c = any (string_to_array('AR BO BR CL CO EC FK GF GY PE PY SR UY VE', ' ')) then 'south_america'
    when c = any (string_to_array('AS AU CK FJ FM GU KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV UM VU WF WS', ' ')) then 'oceania'
    when c = any (string_to_array('AQ BV GS HM TF', ' ')) then 'antarctica'
    else '' end
  from (select upper(btrim(coalesce(p_cc, ''))) as c) x
$$;

-- Does a store sell to a country? null when the country is unknown (a guest) and the store
-- does not sell to the whole world. A store of one city sells in its country (the city of the
-- address is checked when the order is placed).
create or replace function public._mkt_reach(p_scope text, p_store_cc text, p_cc text) returns boolean
language sql immutable as $$
  select case
    when p_scope = 'world' then true
    when coalesce(btrim(p_cc), '') = '' then null
    when p_scope = 'continent' then public._mkt_continent(p_store_cc) <> '' and public._mkt_continent(p_store_cc) = public._mkt_continent(p_cc)
    else upper(btrim(coalesce(p_store_cc, ''))) = upper(btrim(p_cc))
  end
$$;

-- The first n pictures of a product
create or replace function public._mkt_images(p_images jsonb, p_n int) returns jsonb language sql immutable as $$
  select coalesce((select jsonb_agg(x order by i) from jsonb_array_elements(case when jsonb_typeof(p_images) = 'array' then p_images else '[]'::jsonb end) with ordinality e(x, i) where i <= p_n), '[]'::jsonb)
$$;

-- A product as a card (Market.html lists).
create or replace function public._mkt_card(p public.market_products) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', p.id, 'title', p.title, 'price', p.price, 'kind', p.kind, 'images', public._mkt_images(p.images, 5),
    'created_at', p.created_at, 'sales', p.sales, 'stock', p.stock, 'status', p.status, 'shipping_cost', p.shipping_cost,
    'pros', p.pros, 'cons', p.cons,
    'store', jsonb_build_object('id', s.id, 'name', s.name, 'logo', s.logo_url, 'country', s.country, 'is_open', s.is_open),
    'seller', jsonb_build_object('id', s.owner_id, 'username', coalesce(m.username, '')))
  from public.market_stores s left join public.members m on m.member_id = s.owner_id
  where s.id = p.store_id
$$;

-- A store as a card (and the top of its page).
create or replace function public._mkt_store_card(s public.market_stores) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', s.id, 'name', s.name, 'description', s.description, 'logo', s.logo_url, 'cover', s.cover_url, 'links', s.links,
    'country', s.country, 'city', s.city, 'scope', s.scope, 'continent', public._mkt_continent(s.country),
    'sale_mode', s.sale_mode, 'shipping', s.shipping, 'returns', s.returns, 'return_days', s.return_days,
    'is_open', s.is_open,
    'open', s.is_open and exists (select 1 from public.market_products p where p.store_id = s.id and p.status = 'active' and p.stock > 0),
    'products', (select count(*) from public.market_products p where p.store_id = s.id and p.status = 'active'),
    'sales', (select coalesce(sum(p.sales), 0) from public.market_products p where p.store_id = s.id and p.status <> 'deleted'),
    'pros', (select coalesce(sum(p.pros), 0) from public.market_products p where p.store_id = s.id),
    'cons', (select coalesce(sum(p.cons), 0) from public.market_products p where p.store_id = s.id),
    'created_at', s.created_at,
    'owner', jsonb_build_object('id', s.owner_id, 'username', coalesce((select m.username from public.members m where m.member_id = s.owner_id), '')))
$$;

create or replace function public._mkt_notify(p_to text, p_kind text, p_title text, p_body text, p_href text, p_from text default '')
returns void language plpgsql security definer set search_path = public as $$
begin
  if coalesce(p_to, '') = '' or to_regclass('public.notifications') is null then return; end if;
  insert into public.notifications (member_id, kind, title, body, href, from_id, from_username)
  values (p_to, p_kind, p_title, left(coalesce(p_body, ''), 300), p_href, coalesce(p_from, ''),
          coalesce((select m.username from public.members m where m.member_id = p_from), ''));
end $$;

-- Takes the price of an order from the buyer (false: not enough points).
create or replace function public._mkt_spend(p_member text, p_amount int, p_title text) returns boolean
language plpgsql security definer set search_path = public as $$
declare pts jsonb;
begin
  if p_amount <= 0 then return true; end if;
  perform 1 from public.profiles where member_id = p_member for update;
  if not found then return false; end if;
  pts := public._points(p_member);
  if (pts->>'available')::bigint < p_amount then return false; end if;
  update public.profiles set points_spent = coalesce(points_spent, 0) + p_amount where member_id = p_member;
  insert into public.point_spends (member_id, amount, prize_title, mode) values (p_member, p_amount, coalesce(p_title, ''), 'market');
  return true;
end $$;

-- Gives the price of an order back to the buyer.
create or replace function public._mkt_refund(o public.market_orders) returns void
language plpgsql security definer set search_path = public as $$
begin
  if o.total <= 0 then return; end if;
  update public.profiles set points_spent = greatest(0, coalesce(points_spent, 0) - o.total) where member_id = o.buyer_id;
  insert into public.point_spends (member_id, amount, prize_title, mode) values (o.buyer_id, -o.total, o.title, 'market_refund');
end $$;

-- Credits points to a member (sales or shares) and tells them about a new level.
create or replace function public._mkt_credit(p_member text, p_points int, p_ref boolean) returns void
language plpgsql security definer set search_path = public as $$
declare lv_before int; lv_after int; levels boolean := to_regprocedure('public.points_level(bigint)') is not null;
begin
  if p_points <= 0 then return; end if;
  if levels then lv_before := public.points_level((public._points(p_member)->>'earned')::bigint); end if;
  if p_ref then
    update public.profiles set market_ref_points = market_ref_points + p_points, market_refs = market_refs + 1 where member_id = p_member;
  else
    update public.profiles set market_points = market_points + p_points, market_sales = market_sales + 1 where member_id = p_member;
  end if;
  if levels then
    lv_after := public.points_level((public._points(p_member)->>'earned')::bigint);
    if lv_after > lv_before then
      perform public._mkt_notify(p_member, 'points_level', 'New level',
        public.points_level_name(lv_after) || ' · ×' || public.points_multiplier(lv_after)::text, './dashboard.html#points');
    end if;
  end if;
end $$;

-- Orders that are due: shipped for 14 days → received; delivered and past their return
-- period → the seller is paid (and the member who shared the link). Called by the market
-- functions below, and by market_settle() (pg_cron, optional).
create or replace function public._mkt_settle(p_limit int default 200) returns int
language plpgsql security definer set search_path = public as $$
declare o public.market_orders; n int := 0;
begin
  update public.market_orders
     set status = 'delivered', delivered_at = shipped_at + interval '14 days', auto_delivered = true, updated_at = now()
   where status = 'shipped' and settled_at is null and shipped_at <= now() - interval '14 days';
  for o in
    select * from public.market_orders
     where status = 'delivered' and settled_at is null
       and delivered_at + make_interval(days => return_days) <= now()
     order by delivered_at
     limit greatest(1, coalesce(p_limit, 200))
     for update skip locked
  loop
    update public.market_orders set settled_at = now(), updated_at = now() where id = o.id;
    perform public._mkt_credit(o.seller_id, o.total, false);
    perform public._mkt_notify(o.seller_id, 'market_paid', 'Points received for a sale',
      '+' || o.total::text || ' PT · ' || o.title, './Market.html#sales/delivered', o.buyer_id);
    if o.referrer_id is not null and o.commission > 0 then
      perform public._mkt_credit(o.referrer_id, o.commission, true);
      perform public._mkt_notify(o.referrer_id, 'market_commission', 'You earned points from a shared link',
        '+' || o.commission::text || ' PT · ' || o.title, './Market.html?Product=' || o.product_id);
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.market_settle() returns int
language sql security definer set search_path = public as $$ select public._mkt_settle(1000) $$;

-- What a member may do with an order now.
create or replace function public._mkt_actions(o public.market_orders, p_viewer text) returns jsonb
language sql stable as $$
  select to_jsonb(array_remove(array[
    case when p_viewer = o.seller_id and o.status = 'requested' then 'accept' end,
    case when p_viewer = o.seller_id and o.status = 'requested' then 'decline' end,
    case when p_viewer = o.seller_id and o.status = 'sold' then 'ship' end,
    case when (p_viewer = o.seller_id and o.status = 'sold') or (p_viewer = o.buyer_id and o.status = 'requested') then 'cancel' end,
    case when p_viewer = o.buyer_id and o.status = 'shipped' then 'received' end,
    case when p_viewer = o.buyer_id and o.status in ('delivered', 'returned') then 'review' end,
    case when p_viewer = o.buyer_id and o.status = 'delivered' and o.settled_at is null and o.return_days > 0
              and now() <= o.delivered_at + make_interval(days => o.return_days) then 'return' end,
    case when p_viewer = o.seller_id and o.status = 'return_requested' then 'return_accept' end,
    case when p_viewer = o.seller_id and o.status = 'return_requested' then 'return_refuse' end
  ], null))
$$;

create or replace function public._mkt_order_json(o public.market_orders, p_viewer text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', o.id, 'product_id', o.product_id, 'store_id', o.store_id, 'title', o.title, 'image', o.image, 'kind', o.kind,
    'qty', o.qty, 'unit_price', o.unit_price, 'shipping_cost', o.shipping_cost, 'total', o.total,
    'status', o.status, 'tracking', o.tracking, 'reason', o.reason, 'return_days', o.return_days,
    'address', case when p_viewer in (o.seller_id, o.buyer_id) then o.address else '{}'::jsonb end,
    'via_link', o.referrer_id is not null,
    'created_at', o.created_at, 'accepted_at', o.accepted_at, 'shipped_at', o.shipped_at, 'delivered_at', o.delivered_at,
    'auto_delivered', o.auto_delivered, 'return_requested_at', o.return_requested_at, 'returned_at', o.returned_at,
    'closed_at', o.closed_at, 'settled_at', o.settled_at, 'updated_at', o.updated_at,
    'auto_at', case when o.status = 'shipped' then o.shipped_at + interval '14 days' end,
    'release_at', case when o.status in ('delivered', 'return_requested') and o.settled_at is null then o.delivered_at + make_interval(days => o.return_days) end,
    'store_name', coalesce((select s.name from public.market_stores s where s.id = o.store_id), ''),
    'seller', jsonb_build_object('id', o.seller_id, 'username', coalesce((select m.username from public.members m where m.member_id = o.seller_id), '')),
    'buyer', jsonb_build_object('id', o.buyer_id, 'username', coalesce((select m.username from public.members m where m.member_id = o.buyer_id), '')),
    'reviewed', exists (select 1 from public.market_reviews r where r.order_id = o.id),
    'review', (select jsonb_build_object('pros', r.pros, 'cons', r.cons) from public.market_reviews r where r.order_id = o.id),
    'actions', public._mkt_actions(o, p_viewer))
$$;

-- A store for a member who sells their first product before opening Store settings.
create or replace function public._mkt_ensure_store(m public.members) returns public.market_stores
language plpgsql security definer set search_path = public as $$
declare st public.market_stores; sid text;
begin
  select * into st from public.market_stores where owner_id = m.member_id;
  if found then return st; end if;
  loop
    sid := 'STR' || lpad(floor(random() * 1e9)::bigint::text, 9, '0');
    exit when not exists (select 1 from public.market_stores where id = sid);
  end loop;
  insert into public.market_stores (id, owner_id, name, country)
  values (sid, m.member_id, m.username, upper(coalesce(m.country, '')))
  on conflict (owner_id) do nothing;
  select * into st from public.market_stores where owner_id = m.member_id;
  return st;
end $$;

-- ------------------------------------------------------------------ 5. the member
-- The side menu of Market.html.
--   -> { ok: true, member: { id, username, country }, store: {…} | null, counts: {…}, unread }
--      { ok: false, reason: member }
create or replace function public.market_me(p_member text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.members; st public.market_stores; me text;
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  me := m.member_id;
  perform public._mkt_settle(100);
  select * into st from public.market_stores where owner_id = me;
  return jsonb_build_object(
    'ok', true,
    'member', jsonb_build_object('id', me, 'username', m.username, 'country', upper(coalesce(m.country, ''))),
    'blocked', public._mkt_blocked(me, false), 'blocked_selling', public._mkt_blocked(me, true),
    'store', case when st.id is null then null else public._mkt_store_card(st) end,
    'counts', jsonb_build_object(
      'products', (select count(*) from public.market_products where owner_id = me and status <> 'deleted'),
      'sales', (select jsonb_build_object(
          'requests', count(*) filter (where status = 'requested'),
          'sold', count(*) filter (where status = 'sold'),
          'shipped', count(*) filter (where status = 'shipped'),
          'delivered', count(*) filter (where status = 'delivered'),
          'returned', count(*) filter (where status = 'return_requested'))
        from public.market_orders where seller_id = me),
      'purchases', (select jsonb_build_object(
          'later', (select count(*) from public.market_saved where member_id = me),
          'requests', count(*) filter (where status = 'requested'),
          'purchased', count(*) filter (where status = 'sold'),
          'shipped', count(*) filter (where status = 'shipped'),
          'received', count(*) filter (where status = 'delivered'),
          'returned', count(*) filter (where status = 'return_requested'))
        from public.market_orders where buyer_id = me),
      'reviews', jsonb_build_object(
        'to_write', (select count(*) from public.market_orders o where o.buyer_id = me and o.status in ('delivered', 'returned')
                       and not exists (select 1 from public.market_reviews r where r.order_id = o.id)),
        'received', (select count(*) from public.market_reviews where seller_id = me)),
      'requests', jsonb_build_object(
        'sent', (select count(*) from public.market_requests where from_id = me and status = 'answered'),
        'received', (select count(*) from public.market_requests where to_id = me and status = 'open'))),
    'unread', case when to_regclass('public.notifications') is null then 0 else
      (select count(*) from public.notifications n where n.member_id = me and n.kind like 'market%' and not n.read) end);
end $$;

-- ------------------------------------------------------------------ 6. the store
-- Market.html > Store settings. d = { name, description, logo_url?, cover_url?, links: [{label,url}],
-- is_open, scope, country, city, sale_mode, shipping, returns, return_days }
--   -> { ok: true, id, created } | { ok: false, reason: member | blocked | name | description | links |
--      logo | cover | scope | country | city | sale_mode | return_days }
create or replace function public.market_store_save(p_member text, d jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m public.members; st public.market_stores; nm text; descr text; v_links jsonb := '[]'::jsonb; l jsonb; lbl text; url text;
  sc text; cc text; ct text; mode text; ship boolean; ret boolean; days int; logo text; cover text; created boolean := false; sid text;
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  if public._mkt_blocked(m.member_id, true) then return jsonb_build_object('ok', false, 'reason', 'blocked'); end if;
  d := coalesce(d, '{}'::jsonb);
  nm := public._mkt_line(d->>'name');
  if length(nm) < 2 or length(nm) > 60 then return jsonb_build_object('ok', false, 'reason', 'name'); end if;
  descr := btrim(coalesce(d->>'description', ''));
  if length(descr) > 2000 then return jsonb_build_object('ok', false, 'reason', 'description'); end if;
  if jsonb_typeof(coalesce(d->'links', '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(d->'links', '[]'::jsonb)) > 8 then
    return jsonb_build_object('ok', false, 'reason', 'links');
  end if;
  for l in select * from jsonb_array_elements(coalesce(d->'links', '[]'::jsonb)) loop
    if jsonb_typeof(l) <> 'object' then return jsonb_build_object('ok', false, 'reason', 'links'); end if;
    url := btrim(coalesce(l->>'url', ''));
    lbl := public._mkt_line(l->>'label');
    if url = '' then continue; end if;
    if not public._image_url_ok(url) or length(url) > 500 or length(lbl) > 40 then return jsonb_build_object('ok', false, 'reason', 'links'); end if;
    v_links := v_links || jsonb_build_array(jsonb_build_object('label', lbl, 'url', url));
  end loop;
  sc := coalesce(nullif(d->>'scope', ''), 'country');
  if sc not in ('city', 'country', 'continent', 'world') then return jsonb_build_object('ok', false, 'reason', 'scope'); end if;
  cc := upper(btrim(coalesce(nullif(btrim(coalesce(d->>'country', '')), ''), m.country, '')));
  if cc !~ '^[A-Z]{2}$' then return jsonb_build_object('ok', false, 'reason', 'country'); end if;
  ct := public._mkt_line(d->>'city');
  if length(ct) > 80 or (sc = 'city' and length(ct) < 2) then return jsonb_build_object('ok', false, 'reason', 'city'); end if;
  mode := coalesce(nullif(d->>'sale_mode', ''), 'instant');
  if mode not in ('instant', 'request') then return jsonb_build_object('ok', false, 'reason', 'sale_mode'); end if;
  ship := public._mkt_bool(d->>'shipping', true);
  ret := public._mkt_bool(d->>'returns', false);
  days := case when ret then public._mkt_int(d->>'return_days') else 0 end;
  if ret and (days is null or days < 1 or days > 90) then return jsonb_build_object('ok', false, 'reason', 'return_days'); end if;
  logo := btrim(coalesce(d->>'logo_url', ''));
  cover := btrim(coalesce(d->>'cover_url', ''));
  if logo <> '' and not public._image_url_ok(logo) then return jsonb_build_object('ok', false, 'reason', 'logo'); end if;
  if cover <> '' and not public._image_url_ok(cover) then return jsonb_build_object('ok', false, 'reason', 'cover'); end if;

  select * into st from public.market_stores where owner_id = m.member_id for update;
  if not found then
    loop
      sid := 'STR' || lpad(floor(random() * 1e9)::bigint::text, 9, '0');
      exit when not exists (select 1 from public.market_stores where id = sid);
    end loop;
    insert into public.market_stores (id, owner_id, name, description, logo_url, cover_url, links, is_open, scope, country, city,
                                      sale_mode, shipping, returns, return_days)
    values (sid, m.member_id, nm, descr, logo, cover, v_links, public._mkt_bool(d->>'is_open', true), sc, cc, ct, mode, ship, ret, days);
    created := true;
  else
    sid := st.id;
    update public.market_stores set
      name = nm, description = descr, links = v_links,
      logo_url = case when d ? 'logo_url' then logo else logo_url end,
      cover_url = case when d ? 'cover_url' then cover else cover_url end,
      is_open = public._mkt_bool(d->>'is_open', is_open), scope = sc, country = cc, city = ct,
      sale_mode = mode, shipping = ship, returns = ret, return_days = days, updated_at = now()
    where id = sid;
  end if;
  return jsonb_build_object('ok', true, 'id', sid, 'created', created);
end $$;

-- A store page: Market.html?Store=<id>
--   -> { ok: true, store: {…}, own } | { ok: false, reason: not_found }
create or replace function public.market_store(p_id text, p_member text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare st public.market_stores; owner_ok boolean;
begin
  select * into st from public.market_stores where id = btrim(coalesce(p_id, ''));
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  select lower(btrim(coalesce(status, ''))) = 'active' into owner_ok from public.members where member_id = st.owner_id;
  if not coalesce(owner_ok, false) and st.owner_id <> btrim(coalesce(p_member, '')) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  return jsonb_build_object('ok', true, 'store', public._mkt_store_card(st), 'own', st.owner_id = btrim(coalesce(p_member, '')));
end $$;

-- ------------------------------------------------------------------ 7. products
-- Add (no id) or change a product. d = { id?, title, description, kind, price, shipping_cost, stock,
-- categories: ["…"], images?: ["https://…"], video_url }. The first product opens the store.
--   -> { ok: true, id, created, store_id } | { ok: false, reason: member | blocked | title | description |
--      kind | price | shipping_cost | stock | categories | images | video | limit | not_found }
create or replace function public.market_product_save(p_member text, d jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m public.members; st public.market_stores; pr public.market_products; pid text; ttl text; descr text; knd text;
  v_price int; ship int; stk int; cats text[] := '{}'; c text; ckey text; cid text; imgs jsonb := '[]'::jsonb; x jsonb;
  vid text; created boolean := false; keys text[] := '{}';
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  if public._mkt_blocked(m.member_id, true) then return jsonb_build_object('ok', false, 'reason', 'blocked'); end if;
  d := coalesce(d, '{}'::jsonb);
  pid := nullif(btrim(coalesce(d->>'id', '')), '');
  ttl := public._mkt_line(d->>'title');
  if length(ttl) < 3 or length(ttl) > 120 then return jsonb_build_object('ok', false, 'reason', 'title'); end if;
  descr := btrim(coalesce(d->>'description', ''));
  if length(descr) > 5000 then return jsonb_build_object('ok', false, 'reason', 'description'); end if;
  knd := coalesce(nullif(d->>'kind', ''), 'physical');
  if knd not in ('physical', 'digital') then return jsonb_build_object('ok', false, 'reason', 'kind'); end if;
  v_price := public._mkt_int(d->>'price');
  if v_price is null or v_price < 1 or v_price > 10000000 then return jsonb_build_object('ok', false, 'reason', 'price'); end if;
  ship := coalesce(public._mkt_int(nullif(btrim(coalesce(d->>'shipping_cost', '')), '')), 0);
  if ship < 0 or ship > 1000000 then return jsonb_build_object('ok', false, 'reason', 'shipping_cost'); end if;
  if knd = 'digital' then ship := 0; end if;
  stk := public._mkt_int(d->>'stock');
  if stk is null or stk < 0 or stk > 100000 then return jsonb_build_object('ok', false, 'reason', 'stock'); end if;
  if jsonb_typeof(coalesce(d->'categories', '[]'::jsonb)) <> 'array' then return jsonb_build_object('ok', false, 'reason', 'categories'); end if;
  for x in select * from jsonb_array_elements(coalesce(d->'categories', '[]'::jsonb)) loop
    c := public._mkt_line(x #>> '{}');
    if c = '' then continue; end if;
    if length(c) < 2 or length(c) > 40 then return jsonb_build_object('ok', false, 'reason', 'categories'); end if;
    if not public._mkt_norm(c) = any (keys) then
      keys := keys || public._mkt_norm(c);
      cats := cats || c;
    end if;
  end loop;
  if cardinality(cats) < 1 or cardinality(cats) > 5 then return jsonb_build_object('ok', false, 'reason', 'categories'); end if;
  if d ? 'images' then
    if jsonb_typeof(d->'images') <> 'array' or jsonb_array_length(d->'images') > 8 then return jsonb_build_object('ok', false, 'reason', 'images'); end if;
    for x in select * from jsonb_array_elements(d->'images') loop
      if jsonb_typeof(x) <> 'string' or not public._image_url_ok(btrim(x #>> '{}')) then return jsonb_build_object('ok', false, 'reason', 'images'); end if;
      imgs := imgs || to_jsonb(btrim(x #>> '{}'));
    end loop;
  end if;
  vid := btrim(coalesce(d->>'video_url', ''));
  if vid <> '' and (not public._image_url_ok(vid) or length(vid) > 500) then return jsonb_build_object('ok', false, 'reason', 'video'); end if;

  if pid is null then
    if (select count(*) from public.market_products where owner_id = m.member_id and created_at > now() - interval '1 day') >= 30
       or (select count(*) from public.market_products where owner_id = m.member_id and status <> 'deleted') >= 500 then
      return jsonb_build_object('ok', false, 'reason', 'limit');
    end if;
    st := public._mkt_ensure_store(m);
    loop
      pid := 'PRD' || lpad(floor(random() * 1e10)::bigint::text, 10, '0');
      exit when not exists (select 1 from public.market_products where id = pid);
    end loop;
    insert into public.market_products (id, store_id, owner_id, title, description, kind, price, shipping_cost, stock, images, video_url)
    values (pid, st.id, m.member_id, ttl, descr, knd, v_price, ship, stk, imgs, vid);
    created := true;
  else
    select * into pr from public.market_products where id = pid for update;
    if not found or pr.owner_id <> m.member_id or pr.status = 'deleted' then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
    update public.market_products set
      title = ttl, description = descr, kind = knd, price = v_price, shipping_cost = ship, stock = stk,
      images = case when d ? 'images' then imgs else images end, video_url = vid, updated_at = now()
    where id = pid;
    st.id := pr.store_id;
  end if;

  delete from public.market_product_categories where product_id = pid;
  foreach c in array cats loop
    ckey := public._mkt_norm(c);
    select id into cid from public.market_categories where name_key = ckey;
    if cid is null then
      loop
        cid := 'CAT' || lpad(floor(random() * 1e7)::bigint::text, 7, '0');
        exit when not exists (select 1 from public.market_categories where id = cid);
      end loop;
      insert into public.market_categories (id, name, name_key, created_by) values (cid, c, ckey, m.member_id)
      on conflict (name_key) do nothing;
      select id into cid from public.market_categories where name_key = ckey;
    end if;
    insert into public.market_product_categories (product_id, category_id) values (pid, cid) on conflict do nothing;
    cid := null;
  end loop;
  return jsonb_build_object('ok', true, 'id', pid, 'created', created, 'store_id', st.id);
end $$;

-- Show (active), hide or delete a product of the member's store. A product with orders that
-- are still open cannot be deleted.
--   -> { ok: true } | { ok: false, reason: member | not_found | status | orders }
create or replace function public.market_product_status(p_member text, p_id text, p_status text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.members; pr public.market_products;
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  if p_status not in ('active', 'hidden', 'deleted') then return jsonb_build_object('ok', false, 'reason', 'status'); end if;
  select * into pr from public.market_products where id = btrim(coalesce(p_id, '')) for update;
  if not found or pr.owner_id <> m.member_id or pr.status = 'deleted' then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if p_status = 'active' and public._mkt_blocked(m.member_id, true) then return jsonb_build_object('ok', false, 'reason', 'blocked'); end if;
  if p_status = 'deleted' and exists (select 1 from public.market_orders where product_id = pr.id
                                       and status in ('requested', 'sold', 'shipped', 'return_requested')) then
    return jsonb_build_object('ok', false, 'reason', 'orders');
  end if;
  update public.market_products set status = p_status, updated_at = now() where id = pr.id;
  if p_status = 'deleted' then delete from public.market_saved where product_id = pr.id; end if;
  return jsonb_build_object('ok', true);
end $$;

-- Upload tickets for pictures (sql/image_uploads.sql), asked by the owner after saving:
--   kind 'product': p_names = {'PRD…', 'PRD…-1', …}  → Market/Product/<name>.jpg
--   kind 'logo' | 'cover': p_names = {'STR…'}         → Market/Logo/<id>.jpg | Market/Cover/<id>.jpg
--   -> { ok: true, paths } | { ok: false, reason: member | not_found | kind | names }
create or replace function public.market_upload(p_member text, p_kind text, p_id text, p_names text[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.members; folder text; nm text; paths text[] := '{}'; v_id text := btrim(coalesce(p_id, ''));
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  if p_kind = 'product' then
    if not exists (select 1 from public.market_products mp where mp.id = v_id and mp.owner_id = m.member_id and mp.status <> 'deleted') then
      return jsonb_build_object('ok', false, 'reason', 'not_found');
    end if;
    folder := 'Market/Product/';
  elsif p_kind in ('logo', 'cover') then
    if not exists (select 1 from public.market_stores s where s.id = v_id and s.owner_id = m.member_id) then
      return jsonb_build_object('ok', false, 'reason', 'not_found');
    end if;
    folder := case p_kind when 'logo' then 'Market/Logo/' else 'Market/Cover/' end;
  else
    return jsonb_build_object('ok', false, 'reason', 'kind');
  end if;
  if p_names is null or cardinality(p_names) = 0 or cardinality(p_names) > 8 then return jsonb_build_object('ok', false, 'reason', 'names'); end if;
  foreach nm in array p_names loop
    if nm is null or (p_kind <> 'product' and nm <> v_id) or (p_kind = 'product' and nm !~ ('^' || v_id || '(-[1-9][0-9]?)?$')) then
      return jsonb_build_object('ok', false, 'reason', 'names');
    end if;
    perform public._upload_ticket(folder || nm || '.jpg', m.member_id, null);
    paths := paths || (folder || nm || '.jpg');
  end loop;
  return jsonb_build_object('ok', true, 'paths', to_jsonb(paths));
end $$;

-- The pictures once the uploads are done: kind 'product' (a list, in order), 'logo', 'cover'
-- (p_urls = ["https://…"] or []).
--   -> { ok: true } | { ok: false, reason: member | not_found | kind | images }
create or replace function public.market_images(p_member text, p_kind text, p_id text, p_urls jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.members; imgs jsonb := '[]'::jsonb; x jsonb; v_id text := btrim(coalesce(p_id, ''));
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  if jsonb_typeof(coalesce(p_urls, '[]'::jsonb)) <> 'array' then return jsonb_build_object('ok', false, 'reason', 'images'); end if;
  for x in select * from jsonb_array_elements(coalesce(p_urls, '[]'::jsonb)) loop
    if jsonb_typeof(x) <> 'string' or not public._image_url_ok(btrim(x #>> '{}')) then return jsonb_build_object('ok', false, 'reason', 'images'); end if;
    imgs := imgs || to_jsonb(btrim(x #>> '{}'));
  end loop;
  if p_kind = 'product' then
    if jsonb_array_length(imgs) > 8 then return jsonb_build_object('ok', false, 'reason', 'images'); end if;
    update public.market_products mp set images = imgs, updated_at = now()
     where mp.id = v_id and mp.owner_id = m.member_id and mp.status <> 'deleted';
  elsif p_kind in ('logo', 'cover') then
    if jsonb_array_length(imgs) > 1 then return jsonb_build_object('ok', false, 'reason', 'images'); end if;
    update public.market_stores s set
      logo_url = case when p_kind = 'logo' then coalesce(imgs->>0, '') else logo_url end,
      cover_url = case when p_kind = 'cover' then coalesce(imgs->>0, '') else cover_url end,
      updated_at = now()
     where s.id = v_id and s.owner_id = m.member_id;
  else
    return jsonb_build_object('ok', false, 'reason', 'kind');
  end if;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end $$;

-- Market.html > Your sales > Products: the member's products (not deleted), newest first.
create or replace function public.market_my_products(p_member text, p_limit int default 24, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare m public.members; lim int := least(greatest(coalesce(p_limit, 24), 1), 100); off int := greatest(coalesce(p_offset, 0), 0);
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  return jsonb_build_object('ok', true,
    'total', (select count(*) from public.market_products where owner_id = m.member_id and status <> 'deleted'),
    'items', coalesce((select jsonb_agg(public._mkt_card(p) || jsonb_build_object(
        'description', p.description, 'video_url', p.video_url, 'images', p.images, 'updated_at', p.updated_at,
        'categories', coalesce((select jsonb_agg(c.name order by c.name) from public.market_product_categories pc
                                  join public.market_categories c on c.id = pc.category_id where pc.product_id = p.id), '[]'::jsonb),
        'open_orders', (select count(*) from public.market_orders o where o.product_id = p.id and o.status in ('requested', 'sold', 'shipped', 'return_requested')))
      order by p.created_at desc)
      from (select mp.* from public.market_products mp where mp.owner_id = m.member_id and mp.status <> 'deleted'
            order by mp.created_at desc limit lim offset off) x
      join public.market_products p on p.id = x.id), '[]'::jsonb));
end $$;

-- Category names for the product form (as the seller types).
create or replace function public.market_categories(p_q text default '', p_limit int default 12)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'products', x.n) order by x.n desc, x.name), '[]'::jsonb)
  from (
    select c.id, c.name, count(p.id) as n
      from public.market_categories c
      left join public.market_product_categories pc on pc.category_id = c.id
      left join public.market_products p on p.id = pc.product_id and p.status = 'active'
     where public._mkt_norm(p_q) = '' or c.name_key like '%' || replace(replace(replace(public._mkt_norm(p_q), '\', '\\'), '%', '\%'), '_', '\_') || '%'
     group by c.id, c.name
     order by count(p.id) desc, c.name
     limit least(greatest(coalesce(p_limit, 12), 1), 50)
  ) x
$$;

-- ------------------------------------------------------------------ 8. browsing
-- Market.html (home): the trending products (most pieces sold in the last 30 days), then the
-- 5 categories that sell most, 20 products each. Worldwide for guests; for a member, sales in
-- their country and products their country can buy only.
--   -> { country, trending: [card], categories: [{ id, name, products: [card] }] }
create or replace function public.market_home(p_member text)
returns jsonb language sql stable security definer set search_path = public as $$
with viewer as (
  select upper(coalesce((select m.country from public.members m
                          where m.member_id = btrim(coalesce(p_member, '')) and lower(btrim(coalesce(m.status, ''))) = 'active'), '')) as cc
), live as (
  select p as prod, p.id, p.sales, p.created_at
    from public.market_products p
    join public.market_stores s on s.id = p.store_id
    join public.members mm on mm.member_id = s.owner_id and lower(btrim(coalesce(mm.status, ''))) = 'active'
   cross join viewer v
   where p.status = 'active' and p.stock > 0 and s.is_open
     and (v.cc = '' or coalesce(public._mkt_reach(s.scope, s.country, v.cc), false))
), sold as (
  select o.product_id,
         sum(o.qty) filter (where o.created_at > now() - interval '30 days') as recent,
         sum(o.qty) as units
    from public.market_orders o cross join viewer v
   where o.status in ('sold', 'shipped', 'delivered', 'return_requested')
     and (v.cc = '' or o.buyer_country = v.cc)
   group by o.product_id
), ranked as (
  select l.*, coalesce(sd.recent, 0) as recent, coalesce(sd.units, 0) as units
    from live l left join sold sd on sd.product_id = l.id
), tops as (
  select c.id, c.name, sum(r.units) as units, count(*) as n
    from ranked r
    join public.market_product_categories pc on pc.product_id = r.id
    join public.market_categories c on c.id = pc.category_id
   group by c.id, c.name
   order by sum(r.units) desc, count(*) desc, c.name
   limit 5
)
select jsonb_build_object(
  'country', (select cc from viewer),
  'trending', coalesce((select jsonb_agg(public._mkt_card(t.prod) order by t.recent desc, t.units desc, t.sales desc, t.created_at desc)
                          from (select * from ranked order by recent desc, units desc, sales desc, created_at desc limit 20) t), '[]'::jsonb),
  'categories', coalesce((select jsonb_agg(jsonb_build_object('id', tp.id, 'name', tp.name, 'products',
        coalesce((select jsonb_agg(public._mkt_card(q.prod) order by q.units desc, q.sales desc, q.created_at desc)
                    from (select r.* from ranked r
                           where exists (select 1 from public.market_product_categories pc where pc.product_id = r.id and pc.category_id = tp.id)
                           order by r.units desc, r.sales desc, r.created_at desc limit 20) q), '[]'::jsonb))
      order by tp.units desc, tp.n desc, tp.name) from tops tp), '[]'::jsonb))
$$;

-- The search box and the lists of Market.html:
--   p_type     products | stores | categories
--   p_sort     new (newest first) | old (oldest first)
--   p_country  the country of the store ('' = every country)
--   p_kind     '' | physical | digital (products)
--   p_category Market.html?Categories=<id>: products of one category
--   p_store    Market.html?Store=<id>: products of one store (sold out ones too)
--   -> { total, items: [card] }
create or replace function public.market_search(p_member text, p_q text, p_type text, p_sort text, p_country text,
                                                p_kind text, p_category text, p_store text, p_limit int, p_offset int)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  q text := left(public._mkt_line(p_q), 100);
  pat text;
  cc text := upper(btrim(coalesce(p_country, '')));
  knd text := coalesce(nullif(btrim(coalesce(p_kind, '')), ''), '');
  cat text := nullif(btrim(coalesce(p_category, '')), '');
  sto text := nullif(btrim(coalesce(p_store, '')), '');
  old boolean := coalesce(p_sort, '') = 'old';
  lim int := least(greatest(coalesce(p_limit, 24), 1), 60);
  off int := greatest(coalesce(p_offset, 0), 0);
  total bigint; items jsonb;
begin
  pat := '%' || replace(replace(replace(lower(q), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  if cc !~ '^[A-Z]{2}$' then cc := ''; end if;
  if p_type = 'stores' then
    select count(*), coalesce(jsonb_agg(public._mkt_store_card(x.st) order by
             case when old then x.created_at end asc, x.created_at desc), '[]'::jsonb)
      into total, items
      from (select s as st, s.created_at from public.market_stores s
              join public.members mm on mm.member_id = s.owner_id and lower(btrim(coalesce(mm.status, ''))) = 'active'
             where (q = '' or lower(s.name) like pat or lower(s.description) like pat)
               and (cc = '' or s.country = cc)
             order by case when old then s.created_at end asc, s.created_at desc) x;
    select coalesce(jsonb_agg(e order by i), '[]'::jsonb) into items
      from jsonb_array_elements(items) with ordinality a(e, i) where i > off and i <= off + lim;
  elsif p_type = 'categories' then
    select count(*), coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'products', x.n,
             'images', x.imgs) order by case when old then x.created_at end asc, x.created_at desc), '[]'::jsonb)
      into total, items
      from (select c.id, c.name, c.created_at, count(p.id) as n,
                   (select coalesce(jsonb_agg(z.img), '[]'::jsonb) from (
                      select p2.images->>0 as img from public.market_product_categories pc2
                        join public.market_products p2 on p2.id = pc2.product_id and p2.status = 'active' and jsonb_array_length(p2.images) > 0
                       where pc2.category_id = c.id order by p2.sales desc, p2.created_at desc limit 4) z) as imgs
              from public.market_categories c
              join public.market_product_categories pc on pc.category_id = c.id
              join public.market_products p on p.id = pc.product_id and p.status = 'active'
              join public.market_stores s on s.id = p.store_id and (cc = '' or s.country = cc)
              join public.members mm on mm.member_id = s.owner_id and lower(btrim(coalesce(mm.status, ''))) = 'active'
             where (q = '' or c.name_key like pat)
               and (knd = '' or p.kind = knd)
             group by c.id, c.name, c.created_at) x;
    select coalesce(jsonb_agg(e order by i), '[]'::jsonb) into items
      from jsonb_array_elements(items) with ordinality a(e, i) where i > off and i <= off + lim;
  else
    with hits as (
      select p from public.market_products p
        join public.market_stores s on s.id = p.store_id
        join public.members mm on mm.member_id = s.owner_id and lower(btrim(coalesce(mm.status, ''))) = 'active'
       where p.status = 'active'
         and (sto is not null or (p.stock > 0 and s.is_open))
         and (sto is null or p.store_id = sto)
         and (cat is null or exists (select 1 from public.market_product_categories pc where pc.product_id = p.id and pc.category_id = cat))
         and (cc = '' or s.country = cc)
         and (knd = '' or p.kind = knd)
         and (q = '' or lower(p.title) like pat or lower(p.description) like pat or lower(s.name) like pat
              or exists (select 1 from public.market_product_categories pc join public.market_categories c on c.id = pc.category_id
                          where pc.product_id = p.id and c.name_key like pat))
    )
    select (select count(*) from hits),
           coalesce((select jsonb_agg(public._mkt_card(h.p) order by case when old then (h.p).created_at end asc, (h.p).created_at desc)
                       from (select * from hits order by case when old then (hits.p).created_at end asc, (hits.p).created_at desc
                             limit lim offset off) h), '[]'::jsonb)
      into total, items;
  end if;
  return jsonb_build_object('total', total, 'items', items);
end $$;

-- Market.html?Categories=<id>: the name of the category.
create or replace function public.market_category(p_id text)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce((
    select jsonb_build_object('ok', true, 'category', jsonb_build_object('id', c.id, 'name', c.name,
             'products', (select count(*) from public.market_product_categories pc
                            join public.market_products p on p.id = pc.product_id and p.status = 'active'
                           where pc.category_id = c.id)))
      from public.market_categories c where c.id = btrim(coalesce(p_id, ''))),
    jsonb_build_object('ok', false, 'reason', 'not_found'))
$$;

-- Market.html?Product=<id>: the product, its store, the reviews and what the viewer may do.
-- p_country: the country of a guest (the browser's guess), only for "ships to your region".
--   -> { ok: true, product, store, viewer, reviews } | { ok: false, reason: not_found }
create or replace function public.market_product(p_id text, p_member text, p_country text default '')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  p public.market_products; st public.market_stores; m public.members; me text; cc text; owner_ok boolean;
  rev_order text; mine jsonb;
begin
  select * into p from public.market_products where id = btrim(coalesce(p_id, ''));
  if not found or p.status = 'deleted' then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  select * into st from public.market_stores where id = p.store_id;
  m := public._mkt_member(p_member);
  me := coalesce(m.member_id, '');
  select lower(btrim(coalesce(status, ''))) = 'active' into owner_ok from public.members where member_id = st.owner_id;
  if me <> st.owner_id and (p.status <> 'active' or not coalesce(owner_ok, false)) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  cc := case when me <> '' then upper(coalesce(m.country, '')) else upper(btrim(coalesce(p_country, ''))) end;
  if cc !~ '^[A-Z]{2}$' then cc := ''; end if;
  if me <> '' then
    select o.id into rev_order from public.market_orders o
     where o.product_id = p.id and o.buyer_id = me and o.status in ('delivered', 'returned')
     order by (select count(*) from public.market_reviews r where r.order_id = o.id) desc, o.created_at desc limit 1;
    select jsonb_build_object('order_id', r.order_id, 'pros', r.pros, 'cons', r.cons) into mine
      from public.market_reviews r where r.order_id = rev_order;
  end if;
  return jsonb_build_object(
    'ok', true,
    'product', jsonb_build_object(
      'id', p.id, 'title', p.title, 'description', p.description, 'kind', p.kind, 'price', p.price,
      'shipping_cost', p.shipping_cost, 'stock', p.stock, 'sales', p.sales, 'images', p.images, 'video_url', p.video_url,
      'status', p.status, 'pros', p.pros, 'cons', p.cons, 'created_at', p.created_at, 'updated_at', p.updated_at,
      'categories', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.name)
                                from public.market_product_categories pc join public.market_categories c on c.id = pc.category_id
                               where pc.product_id = p.id), '[]'::jsonb)),
    'store', public._mkt_store_card(st),
    'viewer', jsonb_build_object(
      'member', me <> '', 'own', me = st.owner_id, 'country', cc,
      'reach', public._mkt_reach(st.scope, st.country, cc),
      'saved', me <> '' and exists (select 1 from public.market_saved sv where sv.member_id = me and sv.product_id = p.id),
      'review_order', rev_order, 'my_review', mine,
      'open_orders', case when me = '' then 0 else (select count(*) from public.market_orders o where o.product_id = p.id and o.buyer_id = me
                                                      and o.status in ('requested', 'sold', 'shipped')) end),
    'reviews', coalesce((select jsonb_agg(jsonb_build_object('order_id', r.order_id, 'buyer', jsonb_build_object('id', r.buyer_id, 'username', coalesce(mm.username, '')),
                                                      'pros', r.pros, 'cons', r.cons, 'created_at', r.created_at, 'updated_at', r.updated_at)
                                   order by r.created_at desc)
                           from (select * from public.market_reviews where product_id = p.id order by created_at desc limit 200) r
                           left join public.members mm on mm.member_id = r.buyer_id), '[]'::jsonb));
end $$;

-- The suggestions under a product, in this order: more categories in common with it, then
-- more purchases, then more good points, then fewer bad points.
create or replace function public.market_suggest(p_id text, p_limit int default 12)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(public._mkt_card(x.p) order by x.common desc, (x.p).sales desc, (x.p).pros desc, (x.p).cons asc, (x.p).created_at desc), '[]'::jsonb)
  from (
    select p, (select count(*) from public.market_product_categories pc
                where pc.product_id = p.id
                  and pc.category_id in (select category_id from public.market_product_categories where product_id = btrim(coalesce(p_id, '')))) as common
      from public.market_products p
      join public.market_stores s on s.id = p.store_id and s.is_open
      join public.members mm on mm.member_id = s.owner_id and lower(btrim(coalesce(mm.status, ''))) = 'active'
     where p.id <> btrim(coalesce(p_id, '')) and p.status = 'active' and p.stock > 0
     order by 2 desc, p.sales desc, p.pros desc, p.cons asc, p.created_at desc
     limit least(greatest(coalesce(p_limit, 12), 1), 40)
  ) x
$$;

-- Buy later (on: true adds, false removes).
--   -> { ok: true, saved } | { ok: false, reason: member | not_found | own | limit }
create or replace function public.market_later(p_member text, p_product text, p_on boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.members; p public.market_products;
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  if not coalesce(p_on, true) then
    delete from public.market_saved where member_id = m.member_id and product_id = btrim(coalesce(p_product, ''));
    return jsonb_build_object('ok', true, 'saved', false);
  end if;
  select * into p from public.market_products where id = btrim(coalesce(p_product, '')) and status = 'active';
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if p.owner_id = m.member_id then return jsonb_build_object('ok', false, 'reason', 'own'); end if;
  if (select count(*) from public.market_saved where member_id = m.member_id) >= 500 then return jsonb_build_object('ok', false, 'reason', 'limit'); end if;
  insert into public.market_saved (member_id, product_id) values (m.member_id, p.id) on conflict do nothing;
  return jsonb_build_object('ok', true, 'saved', true);
end $$;

-- ------------------------------------------------------------------ 9. orders
-- "Buy now". p_address = { name, phone, city, line, note } (a physical product: name and phone;
-- shipped: city and address too; a store of one city: its city). p_ref = the username of the
-- share link the buyer came from.
--   -> { ok: true, id, status, total, available } | { ok: false, reason: member | blocked | not_found |
--      own | closed | stock | qty | scope | city | address | limit | points (need, have) }
create or replace function public.market_buy(p_member text, p_product text, p_qty int, p_address jsonb, p_ref text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m public.members; p public.market_products; st public.market_stores; q int := coalesce(p_qty, 1); addr jsonb := '{}'::jsonb;
  a_name text; a_phone text; a_city text; a_line text; a_note text; ship_on boolean; v_total int; ref text; oid text; st_code text;
  pts jsonb; need_addr boolean;
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  if public._mkt_blocked(m.member_id, false) then return jsonb_build_object('ok', false, 'reason', 'blocked'); end if;
  select * into p from public.market_products where id = btrim(coalesce(p_product, '')) for update;
  if not found or p.status <> 'active' then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  select * into st from public.market_stores where id = p.store_id;
  if not exists (select 1 from public.members where member_id = st.owner_id and lower(btrim(coalesce(status, ''))) = 'active') then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if st.owner_id = m.member_id then return jsonb_build_object('ok', false, 'reason', 'own'); end if;
  if not st.is_open then return jsonb_build_object('ok', false, 'reason', 'closed'); end if;
  if q < 1 or q > 100 then return jsonb_build_object('ok', false, 'reason', 'qty'); end if;
  if p.stock < q then return jsonb_build_object('ok', false, 'reason', 'stock', 'stock', p.stock); end if;
  if not coalesce(public._mkt_reach(st.scope, st.country, m.country), false) then return jsonb_build_object('ok', false, 'reason', 'scope'); end if;
  if (select count(*) from public.market_orders where buyer_id = m.member_id and created_at > now() - interval '1 day') >= 50 then
    return jsonb_build_object('ok', false, 'reason', 'limit');
  end if;

  ship_on := p.kind = 'physical' and st.shipping;
  need_addr := p.kind = 'physical';
  p_address := case when jsonb_typeof(p_address) = 'object' then p_address else '{}'::jsonb end;
  a_name := left(public._mkt_line(p_address->>'name'), 80);
  a_phone := left(public._mkt_line(p_address->>'phone'), 30);
  a_city := left(public._mkt_line(p_address->>'city'), 80);
  a_line := left(btrim(coalesce(p_address->>'line', '')), 200);
  a_note := left(btrim(coalesce(p_address->>'note', '')), 300);
  if need_addr and (length(a_name) < 2 or length(a_phone) < 5) then return jsonb_build_object('ok', false, 'reason', 'address'); end if;
  if ship_on and (length(a_city) < 2 or length(a_line) < 4) then return jsonb_build_object('ok', false, 'reason', 'address'); end if;
  if st.scope = 'city' and public._mkt_norm(a_city) <> public._mkt_norm(st.city) then
    return jsonb_build_object('ok', false, 'reason', 'city', 'city', st.city);
  end if;
  if need_addr or st.scope = 'city' or a_note <> '' then
    addr := jsonb_strip_nulls(jsonb_build_object('name', nullif(a_name, ''), 'phone', nullif(a_phone, ''), 'city', nullif(a_city, ''),
                                                 'line', nullif(a_line, ''), 'note', nullif(a_note, '')));
  end if;

  v_total := p.price * q + case when ship_on then p.shipping_cost else 0 end;
  if not public._mkt_spend(m.member_id, v_total, p.title) then
    pts := public._points(m.member_id);
    return jsonb_build_object('ok', false, 'reason', 'points', 'need', v_total, 'have', coalesce((pts->>'available')::bigint, 0));
  end if;

  select mm.member_id into ref from public.members mm
   where lower(mm.username) = lower(btrim(coalesce(p_ref, ''))) and btrim(coalesce(p_ref, '')) <> ''
     and lower(btrim(coalesce(mm.status, ''))) = 'active'
     and mm.member_id not in (m.member_id, st.owner_id)
   limit 1;

  st_code := case when st.sale_mode = 'request' then 'requested' else 'sold' end;
  loop
    oid := 'ORD' || lpad(floor(random() * 1e10)::bigint::text, 10, '0');
    exit when not exists (select 1 from public.market_orders where id = oid);
  end loop;
  insert into public.market_orders (id, product_id, store_id, seller_id, buyer_id, referrer_id, title, image, kind, qty, unit_price,
                                    shipping_cost, total, commission, buyer_country, address, status, return_days, accepted_at)
  values (oid, p.id, st.id, st.owner_id, m.member_id, ref, p.title, coalesce(p.images->>0, ''), p.kind, q, p.price,
          case when ship_on then p.shipping_cost else 0 end, v_total,
          case when ref is null then 0 else floor(p.price * q * 0.25)::int end,
          upper(coalesce(m.country, '')), addr, st_code, case when st.returns then st.return_days else 0 end,
          case when st_code = 'sold' then now() end);
  update public.market_products set stock = stock - q, sales = sales + case when st_code = 'sold' then q else 0 end, updated_at = now() where id = p.id;
  delete from public.market_saved where member_id = m.member_id and product_id = p.id;
  perform public._mkt_notify(st.owner_id,
    case when st_code = 'requested' then 'market_request' else 'market_order' end,
    case when st_code = 'requested' then 'New purchase request' else 'New order' end,
    q::text || ' × ' || p.title, './Market.html#sales/' || case when st_code = 'requested' then 'requests' else 'sold' end, m.member_id);
  pts := public._points(m.member_id);
  return jsonb_build_object('ok', true, 'id', oid, 'status', st_code, 'total', v_total, 'available', coalesce((pts->>'available')::bigint, 0));
end $$;

-- What the seller and the buyer do with an order:
--   seller: accept | decline (note = why) | cancel (sold; note) | ship (note = tracking / for a
--           digital product what the buyer receives) | return_accept | return_refuse (note)
--   buyer:  cancel (a request) | received | return (note = why; within the return period)
--   -> { ok: true, status } | { ok: false, reason: member | not_found | state | note | window }
create or replace function public.market_order_action(p_member text, p_order text, p_action text, p_note text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m public.members; o public.market_orders; me text; seller boolean; buyer boolean; note text := left(btrim(coalesce(p_note, '')), 1000);
  href_b text; href_s text;
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  me := m.member_id;
  perform public._mkt_settle(50);
  select * into o from public.market_orders where id = btrim(coalesce(p_order, '')) for update;
  if not found or me not in (o.seller_id, o.buyer_id) then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  seller := me = o.seller_id; buyer := me = o.buyer_id;
  href_b := './Market.html#purchases/';
  href_s := './Market.html#sales/';

  if p_action = 'accept' and seller and o.status = 'requested' then
    update public.market_orders set status = 'sold', accepted_at = now(), updated_at = now() where id = o.id;
    update public.market_products set sales = sales + o.qty where id = o.product_id;
    perform public._mkt_notify(o.buyer_id, 'market_accepted', 'Your purchase request was accepted', o.title, href_b || 'purchased', me);
    return jsonb_build_object('ok', true, 'status', 'sold');

  elsif p_action = 'decline' and seller and o.status = 'requested' then
    if length(note) < 2 then return jsonb_build_object('ok', false, 'reason', 'note'); end if;
    perform public._mkt_refund(o);
    update public.market_products set stock = least(100000, stock + o.qty) where id = o.product_id;
    update public.market_orders set status = 'declined', reason = note, closed_at = now(), updated_at = now() where id = o.id;
    perform public._mkt_notify(o.buyer_id, 'market_declined', 'Your purchase request was declined', o.title || ' · ' || note, href_b || 'requests', me);
    return jsonb_build_object('ok', true, 'status', 'declined');

  elsif p_action = 'cancel' and ((seller and o.status = 'sold') or (buyer and o.status = 'requested')) then
    if seller and length(note) < 2 then return jsonb_build_object('ok', false, 'reason', 'note'); end if;
    perform public._mkt_refund(o);
    update public.market_products set stock = least(100000, stock + o.qty),
           sales = greatest(0, sales - case when o.status = 'sold' then o.qty else 0 end) where id = o.product_id;
    update public.market_orders set status = 'cancelled', reason = note, closed_at = now(), updated_at = now() where id = o.id;
    if seller then
      perform public._mkt_notify(o.buyer_id, 'market_cancelled', 'Your order was cancelled', o.title || ' · ' || note, href_b || 'requests', me);
    else
      perform public._mkt_notify(o.seller_id, 'market_cancelled', 'A purchase request was cancelled', o.title, href_s || 'requests', me);
    end if;
    return jsonb_build_object('ok', true, 'status', 'cancelled');

  elsif p_action = 'ship' and seller and o.status = 'sold' then
    if o.kind = 'digital' and length(note) < 1 then return jsonb_build_object('ok', false, 'reason', 'note'); end if;
    update public.market_orders set status = 'shipped', shipped_at = now(), tracking = note, updated_at = now() where id = o.id;
    perform public._mkt_notify(o.buyer_id, 'market_shipped',
      case when o.kind = 'digital' then 'Your order was delivered online' else 'Your order was shipped' end, o.title, href_b || 'shipped', me);
    return jsonb_build_object('ok', true, 'status', 'shipped');

  elsif p_action = 'received' and buyer and o.status = 'shipped' then
    update public.market_orders set status = 'delivered', delivered_at = now(), updated_at = now() where id = o.id;
    perform public._mkt_notify(o.seller_id, 'market_received', 'The buyer received the order', o.title, href_s || 'delivered', me);
    perform public._mkt_settle(50);
    return jsonb_build_object('ok', true, 'status', 'delivered');

  elsif p_action = 'return' and buyer and o.status = 'delivered' then
    if o.settled_at is not null or o.return_days <= 0 or now() > o.delivered_at + make_interval(days => o.return_days) then
      return jsonb_build_object('ok', false, 'reason', 'window');
    end if;
    if length(note) < 2 then return jsonb_build_object('ok', false, 'reason', 'note'); end if;
    update public.market_orders set status = 'return_requested', return_requested_at = now(), reason = note, updated_at = now() where id = o.id;
    perform public._mkt_notify(o.seller_id, 'market_return', 'A buyer asked to return an order', o.title || ' · ' || note, href_s || 'returned', me);
    return jsonb_build_object('ok', true, 'status', 'return_requested');

  elsif p_action = 'return_accept' and seller and o.status = 'return_requested' then
    perform public._mkt_refund(o);
    update public.market_products set sales = greatest(0, sales - o.qty) where id = o.product_id;
    update public.market_orders set status = 'returned', returned_at = now(), updated_at = now() where id = o.id;
    perform public._mkt_notify(o.buyer_id, 'market_returned', 'Your return was accepted: points refunded', o.title, href_b || 'returned', me);
    return jsonb_build_object('ok', true, 'status', 'returned');

  elsif p_action = 'return_refuse' and seller and o.status = 'return_requested' then
    if length(note) < 2 then return jsonb_build_object('ok', false, 'reason', 'note'); end if;
    update public.market_orders set status = 'delivered', reason = note, updated_at = now() where id = o.id;
    perform public._mkt_notify(o.buyer_id, 'market_refused', 'Your return was refused', o.title || ' · ' || note, href_b || 'received', me);
    perform public._mkt_settle(50);
    return jsonb_build_object('ok', true, 'status', 'delivered');
  end if;
  return jsonb_build_object('ok', false, 'reason', 'state', 'status', o.status);
end $$;

-- The tabs of Your sales / Your purchases.
--   sales:     requests | sold | shipped | delivered | returned
--   purchases: later (Buy later) | requests | purchased | shipped | received | returned
--   (requests also lists the declined and cancelled orders; returned the return requests)
--   -> { ok: true, total, items } | { ok: false, reason: member | tab }
create or replace function public.market_orders(p_member text, p_side text, p_tab text, p_limit int default 20, p_offset int default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m public.members; me text; sts text[]; lim int := least(greatest(coalesce(p_limit, 20), 1), 100); off int := greatest(coalesce(p_offset, 0), 0);
  total bigint; items jsonb;
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  me := m.member_id;
  perform public._mkt_settle(100);
  if p_side = 'purchases' and p_tab = 'later' then
    select count(*) into total from public.market_saved sv join public.market_products p on p.id = sv.product_id and p.status <> 'deleted' where sv.member_id = me;
    select coalesce(jsonb_agg(public._mkt_card(x.p) || jsonb_build_object('saved_at', x.created_at,
             'available', (x.p).status = 'active' and (x.p).stock > 0 and coalesce((select s.is_open from public.market_stores s where s.id = (x.p).store_id), false))
           order by x.created_at desc), '[]'::jsonb)
      into items
      from (select p, sv.created_at from public.market_saved sv join public.market_products p on p.id = sv.product_id and p.status <> 'deleted'
             where sv.member_id = me order by sv.created_at desc limit lim offset off) x;
    return jsonb_build_object('ok', true, 'total', total, 'items', items);
  end if;
  sts := case p_tab
    when 'requests' then array['requested', 'declined', 'cancelled']
    when 'sold' then array['sold'] when 'purchased' then array['sold']
    when 'shipped' then array['shipped']
    when 'delivered' then array['delivered'] when 'received' then array['delivered']
    when 'returned' then array['return_requested', 'returned']
    else null end;
  if sts is null or p_side not in ('sales', 'purchases')
     or (p_side = 'sales' and p_tab in ('purchased', 'received')) or (p_side = 'purchases' and p_tab in ('sold', 'delivered')) then
    return jsonb_build_object('ok', false, 'reason', 'tab');
  end if;
  select count(*) into total from public.market_orders o
   where o.status = any (sts) and case when p_side = 'sales' then o.seller_id = me else o.buyer_id = me end;
  select coalesce(jsonb_agg(public._mkt_order_json(x.ord, me) order by x.waiting desc, (x.ord).updated_at desc), '[]'::jsonb) into items
    from (select o as ord, (o.status in ('requested', 'return_requested')) as waiting from public.market_orders o
           where o.status = any (sts) and case when p_side = 'sales' then o.seller_id = me else o.buyer_id = me end
           order by (o.status in ('requested', 'return_requested')) desc, o.updated_at desc limit lim offset off) x;
  return jsonb_build_object('ok', true, 'total', total, 'items', items);
end $$;

-- ------------------------------------------------------------------ 10. reviews
-- Only the buyer of a delivered (or returned) order: the good points and the bad points
-- (1 to 10 each, 2 to 200 characters). Saving again changes the review.
--   -> { ok: true, created } | { ok: false, reason: member | blocked | not_found | state | empty | text }
create or replace function public.market_review_save(p_member text, p_order text, p_pros jsonb, p_cons jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m public.members; o public.market_orders; v_pros jsonb := '[]'::jsonb; v_cons jsonb := '[]'::jsonb; x jsonb; v text; created boolean;
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  if public._mkt_blocked(m.member_id, true) then return jsonb_build_object('ok', false, 'reason', 'blocked'); end if;
  select * into o from public.market_orders where id = btrim(coalesce(p_order, ''));
  if not found or o.buyer_id <> m.member_id then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if o.status not in ('delivered', 'returned') then return jsonb_build_object('ok', false, 'reason', 'state'); end if;
  for x in select * from jsonb_array_elements(case when jsonb_typeof(p_pros) = 'array' then p_pros else '[]'::jsonb end) loop
    v := public._mkt_line(x #>> '{}');
    if v = '' then continue; end if;
    if length(v) < 2 or length(v) > 200 then return jsonb_build_object('ok', false, 'reason', 'text'); end if;
    v_pros := v_pros || to_jsonb(v);
  end loop;
  for x in select * from jsonb_array_elements(case when jsonb_typeof(p_cons) = 'array' then p_cons else '[]'::jsonb end) loop
    v := public._mkt_line(x #>> '{}');
    if v = '' then continue; end if;
    if length(v) < 2 or length(v) > 200 then return jsonb_build_object('ok', false, 'reason', 'text'); end if;
    v_cons := v_cons || to_jsonb(v);
  end loop;
  if jsonb_array_length(v_pros) + jsonb_array_length(v_cons) = 0 then return jsonb_build_object('ok', false, 'reason', 'empty'); end if;
  if jsonb_array_length(v_pros) > 10 or jsonb_array_length(v_cons) > 10 then return jsonb_build_object('ok', false, 'reason', 'text'); end if;
  created := not exists (select 1 from public.market_reviews where order_id = o.id);
  insert into public.market_reviews (order_id, product_id, store_id, seller_id, buyer_id, pros, cons)
  values (o.id, o.product_id, o.store_id, o.seller_id, o.buyer_id, v_pros, v_cons)
  on conflict (order_id) do update set pros = excluded.pros, cons = excluded.cons, updated_at = now();
  update public.market_products set
    pros = (select coalesce(sum(jsonb_array_length(r.pros)), 0) from public.market_reviews r where r.product_id = o.product_id),
    cons = (select coalesce(sum(jsonb_array_length(r.cons)), 0) from public.market_reviews r where r.product_id = o.product_id)
  where id = o.product_id;
  if created then
    perform public._mkt_notify(o.seller_id, 'market_review', 'A buyer reviewed your product', o.title, './Market.html#ratings/sales', m.member_id);
  end if;
  return jsonb_build_object('ok', true, 'created', created);
end $$;

-- Your rating: given (your reviews of others, and the orders waiting for one) | received (others' reviews of you)
create or replace function public.market_reviews(p_member text, p_side text, p_limit int default 20, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare m public.members; me text; lim int := least(greatest(coalesce(p_limit, 20), 1), 100); off int := greatest(coalesce(p_offset, 0), 0);
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  me := m.member_id;
  if p_side not in ('given', 'received') then return jsonb_build_object('ok', false, 'reason', 'side'); end if;
  return jsonb_build_object('ok', true,
    'total', (select count(*) from public.market_reviews r where case when p_side = 'given' then r.buyer_id = me else r.seller_id = me end),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'order_id', r.order_id, 'product_id', r.product_id, 'title', o.title, 'image', o.image,
        'store_name', coalesce((select s.name from public.market_stores s where s.id = r.store_id), ''),
        'buyer', jsonb_build_object('id', r.buyer_id, 'username', coalesce((select mm.username from public.members mm where mm.member_id = r.buyer_id), '')),
        'seller', jsonb_build_object('id', r.seller_id, 'username', coalesce((select mm.username from public.members mm where mm.member_id = r.seller_id), '')),
        'pros', r.pros, 'cons', r.cons, 'created_at', r.created_at, 'updated_at', r.updated_at) order by r.created_at desc)
      from (select * from public.market_reviews r where case when p_side = 'given' then r.buyer_id = me else r.seller_id = me end
            order by r.created_at desc limit lim offset off) r
      join public.market_orders o on o.id = r.order_id), '[]'::jsonb),
    'pending', case when p_side = 'given' and off = 0 then coalesce((select jsonb_agg(public._mkt_order_json(x.ord, me) order by (x.ord).delivered_at desc nulls last)
        from (select o as ord from public.market_orders o where o.buyer_id = me and o.status in ('delivered', 'returned')
                and not exists (select 1 from public.market_reviews r where r.order_id = o.id)
              order by o.delivered_at desc nulls last limit 50) x), '[]'::jsonb) else '[]'::jsonb end);
end $$;

-- ------------------------------------------------------------------ 11. requests
-- "Can you get this item?" (kind item, to a store) or a question about a product (kind question).
--   -> { ok: true, id } | { ok: false, reason: member | blocked | kind | not_found | product | own | body | limit }
create or replace function public.market_request_send(p_member text, p_store text, p_product text, p_kind text, p_body text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.members; st public.market_stores; p public.market_products; v_body text := btrim(coalesce(p_body, '')); rid bigint;
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  if public._mkt_blocked(m.member_id, true) then return jsonb_build_object('ok', false, 'reason', 'blocked'); end if;
  if p_kind not in ('item', 'question') then return jsonb_build_object('ok', false, 'reason', 'kind'); end if;
  if nullif(btrim(coalesce(p_product, '')), '') is not null then
    select * into p from public.market_products where id = btrim(p_product) and status = 'active';
    if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
    select * into st from public.market_stores where id = p.store_id;
  else
    if p_kind = 'question' then return jsonb_build_object('ok', false, 'reason', 'product'); end if;
    select * into st from public.market_stores where id = btrim(coalesce(p_store, ''));
    if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  end if;
  if st.owner_id = m.member_id then return jsonb_build_object('ok', false, 'reason', 'own'); end if;
  if length(v_body) < 2 or length(v_body) > 1000 then return jsonb_build_object('ok', false, 'reason', 'body'); end if;
  if (select count(*) from public.market_requests where from_id = m.member_id and created_at > now() - interval '1 day') >= 30 then
    return jsonb_build_object('ok', false, 'reason', 'limit');
  end if;
  insert into public.market_requests (from_id, to_id, store_id, product_id, kind, body)
  values (m.member_id, st.owner_id, st.id, p.id, p_kind, v_body) returning id into rid;
  perform public._mkt_notify(st.owner_id, 'market_question',
    case when p_kind = 'question' then 'New question about your product' else 'New item request' end,
    coalesce(p.title || ' · ', '') || left(v_body, 200), './Market.html#requests/received', m.member_id);
  return jsonb_build_object('ok', true, 'id', rid);
end $$;

--   -> { ok: true } | { ok: false, reason: member | not_found | body | state }
create or replace function public.market_request_reply(p_member text, p_id bigint, p_reply text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.members; r public.market_requests; v_body text := btrim(coalesce(p_reply, ''));
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  select * into r from public.market_requests where id = p_id for update;
  if not found or r.to_id <> m.member_id then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if r.status = 'closed' then return jsonb_build_object('ok', false, 'reason', 'state'); end if;
  if length(v_body) < 1 or length(v_body) > 1000 then return jsonb_build_object('ok', false, 'reason', 'body'); end if;
  update public.market_requests set reply = v_body, status = 'answered', replied_at = now() where id = r.id;
  perform public._mkt_notify(r.from_id, 'market_reply', 'A store answered your request', left(v_body, 200), './Market.html#requests/sent', m.member_id);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.market_request_close(p_member text, p_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.members;
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  update public.market_requests set status = 'closed' where id = p_id and m.member_id in (from_id, to_id);
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end $$;

-- Your requests: sent (your requests to stores) | received (requests to your store)
create or replace function public.market_requests(p_member text, p_side text, p_limit int default 20, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare m public.members; me text; lim int := least(greatest(coalesce(p_limit, 20), 1), 100); off int := greatest(coalesce(p_offset, 0), 0);
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  me := m.member_id;
  if p_side not in ('sent', 'received') then return jsonb_build_object('ok', false, 'reason', 'side'); end if;
  return jsonb_build_object('ok', true,
    'total', (select count(*) from public.market_requests r where case when p_side = 'sent' then r.from_id = me else r.to_id = me end),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'kind', r.kind, 'body', r.body, 'reply', r.reply, 'status', r.status, 'created_at', r.created_at, 'replied_at', r.replied_at,
        'store', jsonb_build_object('id', r.store_id, 'name', coalesce((select s.name from public.market_stores s where s.id = r.store_id), '')),
        'product', case when r.product_id is null then null else (select jsonb_build_object('id', p.id, 'title', p.title, 'image', coalesce(p.images->>0, ''))
                                                                    from public.market_products p where p.id = r.product_id) end,
        'from', jsonb_build_object('id', r.from_id, 'username', coalesce((select mm.username from public.members mm where mm.member_id = r.from_id), '')),
        'to', jsonb_build_object('id', r.to_id, 'username', coalesce((select mm.username from public.members mm where mm.member_id = r.to_id), '')))
      order by (r.status = case when p_side = 'sent' then 'answered' else 'open' end) desc, r.created_at desc)
      from (select * from public.market_requests r where case when p_side = 'sent' then r.from_id = me else r.to_id = me end
            order by (r.status = case when p_side = 'sent' then 'answered' else 'open' end) desc, r.created_at desc limit lim offset off) r), '[]'::jsonb));
end $$;

-- ------------------------------------------------------------------ 12. who may call what
do $$
declare f text;
begin
  foreach f in array array[
    'public._mkt_member(text)', 'public._mkt_blocked(text, boolean)', 'public._mkt_card(public.market_products)',
    'public._mkt_store_card(public.market_stores)', 'public._mkt_notify(text, text, text, text, text, text)',
    'public._mkt_spend(text, int, text)', 'public._mkt_refund(public.market_orders)', 'public._mkt_credit(text, int, boolean)',
    'public._mkt_settle(int)', 'public.market_settle()', 'public._mkt_order_json(public.market_orders, text)',
    'public._mkt_ensure_store(public.members)', 'public._guard_market_points()']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'public.market_me(text)', 'public.market_store_save(text, jsonb)', 'public.market_store(text, text)',
    'public.market_product_save(text, jsonb)', 'public.market_product_status(text, text, text)',
    'public.market_upload(text, text, text, text[])', 'public.market_images(text, text, text, jsonb)',
    'public.market_my_products(text, int, int)', 'public.market_categories(text, int)', 'public.market_home(text)',
    'public.market_search(text, text, text, text, text, text, text, text, int, int)', 'public.market_category(text)',
    'public.market_product(text, text, text)', 'public.market_suggest(text, int)', 'public.market_later(text, text, boolean)',
    'public.market_buy(text, text, int, jsonb, text)', 'public.market_order_action(text, text, text, text)',
    'public.market_orders(text, text, text, int, int)', 'public.market_review_save(text, text, jsonb, jsonb)',
    'public.market_reviews(text, text, int, int)', 'public.market_request_send(text, text, text, text, text)',
    'public.market_request_reply(text, bigint, text)', 'public.market_request_close(text, bigint)',
    'public.market_requests(text, text, int, int)']
  loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;
revoke all on function public._points(text) from public, anon, authenticated;

notify pgrst, 'reload schema';
