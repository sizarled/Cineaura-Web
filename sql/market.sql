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
--   reviews      market_reviews      one per member and product (any member but its seller; a
--                                    member who received it: a verified purchase): the good
--                                    points and the bad points, and who may read it
--   purchase lists  market_lists, market_list_items   products a member gathers, with an audience
--   recommendations market_recs      of a product, or again of a public recommendation / list
--   requests     market_requests     "can you get this item?" / a question about a product
--
-- Ids: stores STR + 9 digits, products PRD + 10, categories CAT + 7, orders ORD + 10,
-- purchase lists MPL + 9, recommendations REC + 10.
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
--   * Sharing: Market.html?Product=<id>&@<username>. Every product has its share commission,
--     chosen by the seller in the product form: off (the default), or on with 1 to 25%.
--     A sale made through that link gives the member who shared it that part of the price
--     (pieces x price, shipping not included), taken from what the seller receives when the
--     order is paid. Not for the buyer or the seller themselves. The percentage of the day of
--     the order is kept with the order (market_orders.commission_pct). Orders of the first
--     version of this file (commission_pct empty) keep its rule: the site added 25%.
--   * The points received (sales: profiles.market_points / market_sales; shares:
--     market_ref_points / market_refs) are earned points like the others: they count for the
--     level (_points() below).
--   * Delivery (market_orders.delivery): ship (a physical product, the store ships), hand (a
--     physical product, the store does not ship) or online (a digital product). A physical
--     order needs the buyer's delivery address and phone once it is sold (bought in an instant
--     store, or accepted), never before: the address saved in the buyer's profile
--     (market_addresses: Dashboard > Settings > Profile) goes with it by itself, otherwise the
--     buyer gives it in Your purchases (market_order_address). The seller ships after that.
--   * A digital product can have a private download link (market_products.download_url): its
--     orders are delivered online as soon as they are sold, and the buyer gets the link in
--     Your purchases. Without a link the seller delivers each order (a code, a message…).
--
-- The tier of a store (market_stores.sales_points): the points of its successful orders
-- (delivered: received by the buyer and not returned):
--   N under 1,000 PT · K under 1 million · M under 1 billion · B under 1 trillion
-- shown with the progress inside the tier: K25 = 250,000 PT (25% of 1 million).
--
-- Reports (market_reports): the Report button of every store page and product page. The team
-- reads them in Panel > Reports > Market and can suspend a product or a whole store: hidden
-- from everybody but its seller, who cannot show it again until the team restores it.
--
-- The social side (product page buttons; a member's page > Market; Profile > Updates):
--   * recommendations (market_recs) of a product, purchase lists (market_lists) and reviews
--     (market_reviews, any member but the seller; a buyer's is a verified purchase), each one
--     public, exclusive (followers / premium / countries) or private (members named).
--   * The members you follow show up in your Updates. A public recommendation or purchase list
--     can be recommended again (a re-recommendation keeps the first one as its root).
--   * The share commission of a sale (chosen by the seller, paid from what the seller receives)
--     goes to the member whose link brought the buyer (market_orders.referrer_id); when that
--     member recommended it again from somebody else's recommendation or purchase list, it is
--     shared equally with the member who first recommended it (root_referrer_id): the first
--     and the last of the chain, whoever passed it on in between.
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
comment on column public.profiles.market_ref_points is 'Points received for sales made through the member''s share links (the commission each seller chose, up to 25% of the price).';
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
  sales_points bigint not null default 0,             -- the totals of its delivered orders: the tier (N K M B)
  suspended boolean not null default false,           -- by the team (Panel > Reports > Market)
  suspended_reason text not null default '',
  suspended_at timestamptz,
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
  status text not null default 'active',              -- active | hidden (by the seller) | deleted | suspended (by the team)
  sales integer not null default 0,                   -- pieces sold (orders not cancelled / returned)
  pros integer not null default 0,                    -- good points written by buyers
  cons integer not null default 0,                    -- bad points
  commission_on boolean not null default false,       -- the share commission (…?Product=<id>&@username), paid by the seller
  commission_pct smallint not null default 10,        -- its percentage of the price (kept while it is off)
  download_url text not null default '',              -- digital: the private download link the buyers get
  suspended_reason text not null default '',          -- why the team suspended it
  status_before text,                                 -- the status a suspension replaced (back on restore)
  suspended_with_store boolean not null default false,  -- suspended because its store was
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint market_products_kind check (kind in ('physical', 'digital')),
  constraint market_products_commission check (commission_pct between 1 and 25),
  constraint market_products_status check (status in ('active', 'hidden', 'deleted', 'suspended')),
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
  commission integer not null default 0,              -- commission_pct % of unit_price x qty for the referrer
  commission_pct smallint,                            -- the product's share commission that day (0: none), paid by
                                                      -- the seller; empty: an order of the first version (the site paid 25%)
  root_referrer_id text,                              -- who first recommended it, when the referrer recommended it again
  root_commission integer not null default 0,         -- their equal share of the commission (the referrer keeps the rest)
  buyer_country text not null default '',
  address jsonb not null default '{}'::jsonb,         -- note (checkout); name, phone, city, line once it is sold
  delivery text not null default 'ship',              -- ship | hand (the store does not ship) | online (digital)
  address_at timestamptz,                             -- when the buyer's address came with it
  download_url text not null default '',              -- digital: the link when it was delivered online
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

-- Added after the first version of this file (a database that already ran it gets them here):
-- the share commission of each product, and its percentage kept with each order.
alter table public.market_products add column if not exists commission_on boolean not null default false;
alter table public.market_products add column if not exists commission_pct smallint not null default 10;
alter table public.market_orders add column if not exists commission_pct smallint;
do $$
begin
  alter table public.market_products add constraint market_products_commission check (commission_pct between 1 and 25);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table public.market_orders add constraint market_orders_commission check (commission_pct between 0 and 25);
exception when duplicate_object then null;
end $$;

-- Added in the third version: the tier of each store, the team's suspensions, the download
-- link of a digital product, the delivery of each order and the address given after the sale.
alter table public.market_stores add column if not exists sales_points bigint not null default 0;
alter table public.market_stores add column if not exists suspended boolean not null default false;
alter table public.market_stores add column if not exists suspended_reason text not null default '';
alter table public.market_stores add column if not exists suspended_at timestamptz;
alter table public.market_products add column if not exists download_url text not null default '';
alter table public.market_products add column if not exists suspended_reason text not null default '';
alter table public.market_products add column if not exists status_before text;
alter table public.market_products add column if not exists suspended_with_store boolean not null default false;
alter table public.market_orders add column if not exists delivery text;
alter table public.market_orders add column if not exists address_at timestamptz;
alter table public.market_orders add column if not exists download_url text not null default '';
-- the orders of before: from the product and the store
update public.market_orders o
   set delivery = case when o.kind = 'digital' then 'online'
                       when coalesce((select s.shipping from public.market_stores s where s.id = o.store_id), true) then 'ship'
                       else 'hand' end
 where o.delivery is null;
update public.market_orders set address_at = coalesce(accepted_at, created_at) where address_at is null and address ? 'name';
alter table public.market_orders alter column delivery set default 'ship';
alter table public.market_orders alter column delivery set not null;
alter table public.market_products drop constraint if exists market_products_status;
alter table public.market_products add constraint market_products_status check (status in ('active', 'hidden', 'deleted', 'suspended'));
do $$
begin
  alter table public.market_orders add constraint market_orders_delivery check (delivery in ('ship', 'hand', 'online'));
exception when duplicate_object then null;
end $$;

-- The tier: market_stores.sales_points follows the orders (+ the total when one is delivered,
-- - when it leaves that state: a return asked, then accepted) …
create or replace function public._mkt_tier_points() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op <> 'INSERT' and old.status = 'delivered' then
    update public.market_stores set sales_points = greatest(0, sales_points - old.total) where id = old.store_id;
  end if;
  if tg_op <> 'DELETE' and new.status = 'delivered' then
    update public.market_stores set sales_points = sales_points + new.total where id = new.store_id;
  end if;
  return null;
end $$;
drop trigger if exists market_orders_tier on public.market_orders;
create trigger market_orders_tier after insert or delete or update of status, total, store_id on public.market_orders
  for each row execute function public._mkt_tier_points();
-- … and is counted again from the orders every time this file runs.
update public.market_stores s set sales_points = x.pts
  from (select s2.id, coalesce((select sum(o.total) from public.market_orders o where o.store_id = s2.id and o.status = 'delivered'), 0) as pts
          from public.market_stores s2) x
 where x.id = s.id and s.sales_points is distinct from x.pts;

-- The delivery address kept in a member's profile (Dashboard > Settings > Profile, or the
-- checkbox of the address form in Your purchases): it goes with each physical order by itself
-- once the order is sold. Seen by the member, and by the sellers of their sold orders.
create table if not exists public.market_addresses (
  member_id text primary key references public.members(member_id) on delete cascade,
  name text not null,
  phone text not null,
  city text not null,
  line text not null,
  updated_at timestamptz not null default now()
);

-- The Report button of the store pages and product pages (Panel > Reports > Market).
create table if not exists public.market_reports (
  id bigint generated always as identity primary key,
  kind text not null,                                 -- store | product
  target_id text not null,                            -- STR… | PRD…
  store_id text not null,                             -- the store (of the product)
  owner_id text not null,                             -- its seller
  reporter_id text not null,
  reason text not null,
  note text not null default '',
  status text not null default 'open',                -- open | resolved | dismissed
  handled_by text not null default '',
  handled_at timestamptz,
  created_at timestamptz not null default now(),
  constraint market_reports_kind check (kind in ('store', 'product')),
  constraint market_reports_reason check (reason in ('fake', 'scam', 'prohibited', 'misleading', 'offensive', 'no_delivery', 'other')),
  constraint market_reports_status check (status in ('open', 'resolved', 'dismissed')),
  constraint market_reports_note check (char_length(note) <= 500)
);
create index if not exists market_reports_status_idx on public.market_reports (status, created_at desc);
create index if not exists market_reports_target_idx on public.market_reports (kind, target_id);
create index if not exists market_reports_reporter_idx on public.market_reports (reporter_id, created_at desc);
-- one open report per member and store / product
create unique index if not exists market_reports_one_open on public.market_reports (reporter_id, kind, target_id) where status = 'open';

-- Added in the fourth version: reviews by any member (one per member and product) with an
-- audience, purchase lists, recommendations, and the root of a recommended sale.
alter table public.market_orders add column if not exists root_referrer_id text;
alter table public.market_orders add column if not exists root_commission integer not null default 0;

-- Purchase lists: products a member gathers (any product of the market), with an audience.
create table if not exists public.market_lists (
  id text primary key,                                -- MPL + 9 digits
  member_id text not null references public.members(member_id) on delete cascade,
  name text not null,
  description text not null default '',
  visibility text not null default 'public',
  excl_followers boolean not null default false,
  excl_premium boolean not null default false,
  excl_countries text not null default '',
  allowed text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint market_lists_vis check (visibility in ('public', 'exclusive', 'private')),
  constraint market_lists_text check (char_length(name) between 2 and 80 and char_length(description) <= 500)
);
create index if not exists market_lists_member_idx on public.market_lists (member_id, created_at desc);
create table if not exists public.market_list_items (
  list_id text not null references public.market_lists(id) on delete cascade,
  product_id text not null references public.market_products(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (list_id, product_id)
);
create index if not exists market_list_items_product_idx on public.market_list_items (product_id);

-- Recommendations of a product, and re-recommendations of a public recommendation or of a public
-- purchase list. One per member and product / list.
--   an original:            kind product, root_id and parent_id empty
--   recommended again:      root_id = the original (kind product), parent_id = the one it came from
--   a purchase list again:  kind list (its root: the list's author), parent_id = the one it came from
create table if not exists public.market_recs (
  id text primary key,                                -- REC + 10 digits
  member_id text not null references public.members(member_id) on delete cascade,
  kind text not null,                                 -- product | list
  product_id text references public.market_products(id) on delete cascade,
  list_id text references public.market_lists(id) on delete cascade,
  root_id text references public.market_recs(id) on delete set null,
  parent_id text references public.market_recs(id) on delete set null,
  note text not null default '',
  visibility text not null default 'public',
  excl_followers boolean not null default false,
  excl_premium boolean not null default false,
  excl_countries text not null default '',
  allowed text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint market_recs_kind check ((kind = 'product' and product_id is not null and list_id is null)
                                     or (kind = 'list' and list_id is not null and product_id is null)),
  constraint market_recs_vis check (visibility in ('public', 'exclusive', 'private')),
  constraint market_recs_note check (char_length(note) <= 500)
);
create unique index if not exists market_recs_one on public.market_recs (member_id, kind, coalesce(product_id, list_id));
create index if not exists market_recs_member_idx on public.market_recs (member_id, created_at desc);
create index if not exists market_recs_product_idx on public.market_recs (product_id) where product_id is not null;
create index if not exists market_recs_list_idx on public.market_recs (list_id) where list_id is not null;
create index if not exists market_recs_root_idx on public.market_recs (root_id) where root_id is not null;

-- Reviews: one per member and product (any member but its seller). The review of somebody who
-- received the product keeps that order: a verified purchase. Who may read it: its audience.
-- (The first version had one per order, by buyers only: see the upgrade block below.)
create table if not exists public.market_reviews (
  id bigint generated always as identity primary key,
  order_id text references public.market_orders(id) on delete set null,   -- a received order of its author
  product_id text not null,
  store_id text not null,
  seller_id text not null,
  member_id text not null,                            -- who wrote it
  pros jsonb not null default '[]'::jsonb,            -- ["…", …] the good points
  cons jsonb not null default '[]'::jsonb,            -- the bad points
  visibility text not null default 'public',          -- public | exclusive | private
  excl_followers boolean not null default false,      -- exclusive: followers of its author only
  excl_premium boolean not null default false,        -- exclusive: premium plans only
  excl_countries text not null default '',            -- exclusive: 'MA,FR' (empty: any country)
  allowed text[] not null default '{}',               -- private: the member ids who may read it
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists market_reviews_product_idx on public.market_reviews (product_id, created_at desc);
create index if not exists market_reviews_seller_idx on public.market_reviews (seller_id, created_at desc);
-- the first version (one per order, by its buyer) -> one per member and product
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'market_reviews' and column_name = 'buyer_id') then
    alter table public.market_reviews rename column buyer_id to member_id;
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'market_reviews' and column_name = 'id') then
    alter table public.market_reviews add column id bigint generated always as identity;
  end if;
  if not exists (select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
                  where i.indrelid = 'public.market_reviews'::regclass and i.indisprimary and a.attname = 'id') then
    alter table public.market_reviews drop constraint if exists market_reviews_pkey;
    alter table public.market_reviews add constraint market_reviews_pkey primary key (id);
  end if;
end $$;
alter table public.market_reviews alter column order_id drop not null;
alter table public.market_reviews add column if not exists visibility text not null default 'public';
alter table public.market_reviews add column if not exists excl_followers boolean not null default false;
alter table public.market_reviews add column if not exists excl_premium boolean not null default false;
alter table public.market_reviews add column if not exists excl_countries text not null default '';
alter table public.market_reviews add column if not exists allowed text[] not null default '{}';
alter table public.market_reviews drop constraint if exists market_reviews_order_id_fkey;
alter table public.market_reviews add constraint market_reviews_order_id_fkey
  foreign key (order_id) references public.market_orders(id) on delete set null;
do $$
begin
  alter table public.market_reviews add constraint market_reviews_vis check (visibility in ('public', 'exclusive', 'private'));
exception when duplicate_object then null;
end $$;
-- two orders of the same product reviewed by the same buyer: the newest review stays
delete from public.market_reviews r using public.market_reviews r2
 where r.member_id = r2.member_id and r.product_id = r2.product_id and (r.updated_at, r.id) < (r2.updated_at, r2.id);
drop index if exists public.market_reviews_buyer_idx;
create unique index if not exists market_reviews_one on public.market_reviews (member_id, product_id);
create index if not exists market_reviews_member_idx on public.market_reviews (member_id, created_at desc);
-- the counts of good and bad points of the products: their public reviews only
update public.market_products p set pros = x.pros, cons = x.cons
  from (select p2.id,
               coalesce((select sum(jsonb_array_length(r.pros)) from public.market_reviews r
                          where r.product_id = p2.id and r.visibility = 'public'), 0) as pros,
               coalesce((select sum(jsonb_array_length(r.cons)) from public.market_reviews r
                          where r.product_id = p2.id and r.visibility = 'public'), 0) as cons
          from public.market_products p2) x
 where x.id = p.id and (p.pros, p.cons) is distinct from (x.pros::int, x.cons::int);

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
                           'market_saved', 'market_orders', 'market_reviews', 'market_requests', 'market_addresses',
                           'market_reports', 'market_lists', 'market_list_items', 'market_recs']
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
  -- the market (sql/market.sql): sales of the member's store (less the share commissions they pay), and the commissions of the sales made through their share links
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

-- The tier of a store from the points of its successful orders:
--   N under 1,000 · K under 1,000,000 · M under 1,000,000,000 · B under 1,000,000,000,000
--   -> { code, pct, points, top, next }: pct = points x 100 / top, rounded down to 0.1 (K25 = 250,000 PT
--      of 1,000,000; K0.6 = 6,400 PT); 1 trillion and more stays B100.
create or replace function public._mkt_tier(p_points bigint) returns jsonb language sql immutable as $$
  select jsonb_build_object('code', x.code, 'pct', least(100, round(floor(x.pts * 1000 / x.top) / 10, 1)), 'points', x.pts, 'top', x.top,
                            'next', case x.code when 'N' then 'K' when 'K' then 'M' when 'M' then 'B' end)
    from (select greatest(coalesce(p_points, 0), 0)::numeric as pts) v,
         lateral (select v.pts,
                         case when v.pts < 1000 then 'N' when v.pts < 1000000 then 'K' when v.pts < 1000000000 then 'M' else 'B' end as code,
                         case when v.pts < 1000 then 1000::numeric when v.pts < 1000000 then 1000000::numeric
                              when v.pts < 1000000000 then 1000000000::numeric else 1000000000000::numeric end as top) x
$$;

-- Who may see a recommendation, a purchase list or a review (the rules of the videos):
--   public     everybody
--   exclusive  signed-in members who follow its author (when asked), have a premium plan (when
--              asked) and live in one of its countries (when given)
--   private    the members named (p_allowed: member ids)
-- Its author always does; nobody sees what a member who isn't active wrote.
create or replace function public._mkt_sees(p_owner text, p_vis text, p_fol boolean, p_prem boolean, p_cty text,
                                            p_allowed text[], p_viewer text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v public.members;
begin
  if coalesce(p_viewer, '') <> '' and p_viewer = p_owner then return true; end if;
  if not exists (select 1 from public.members o where o.member_id = p_owner and lower(btrim(coalesce(o.status, ''))) = 'active') then
    return false;
  end if;
  if p_vis = 'public' then return true; end if;
  if coalesce(p_viewer, '') = '' then return false; end if;
  select * into v from public.members where member_id = p_viewer and lower(btrim(coalesce(status, ''))) = 'active';
  if not found then return false; end if;
  if p_vis = 'private' then return v.member_id = any (coalesce(p_allowed, '{}')); end if;
  if p_vis <> 'exclusive' then return false; end if;
  if coalesce(p_fol, false) and not exists (select 1 from public.follows f where f.follower_id = v.member_id
                                             and f.following_id = p_owner and f.status = 'accepted') then
    return false;
  end if;
  if coalesce(p_prem, false) and not (coalesce(v.membership_type, 'Free') in ('Silver', 'Gold', 'Diamond')
                                      and (v.membership_expires_at is null or v.membership_expires_at > now())) then
    return false;
  end if;
  if btrim(coalesce(p_cty, '')) <> ''
     and not (upper(coalesce(v.country, '')) = any (string_to_array(upper(replace(p_cty, ' ', '')), ','))) then
    return false;
  end if;
  return true;
end $$;

-- An audience as the forms send it: { visibility, followers, premium, countries: "MA,FR" | ["MA"],
-- people: "alice, ID1003" } (people: usernames or member ids, for a private one; at most 50).
--   -> { visibility, excl_followers, excl_premium, excl_countries, allowed: [member ids] }
--      { reason: visibility | people, unknown?: [names nobody has] }
create or replace function public._mkt_audience(d jsonb, p_owner text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  x jsonb := case when jsonb_typeof(d) = 'object' then d else '{}'::jsonb end;
  vis text := coalesce(nullif(btrim(x->>'visibility'), ''), 'public');
  raw text; cty text; names text[]; ids text[] := '{}'; unknown text[] := '{}'; n text; mid text;
  yes text[] := array['true', 't', '1', 'on', 'yes'];
begin
  if vis not in ('public', 'exclusive', 'private') then return jsonb_build_object('reason', 'visibility'); end if;
  raw := case when jsonb_typeof(x->'countries') = 'array'
              then (select string_agg(c, ',') from jsonb_array_elements_text(x->'countries') c)
              else coalesce(x->>'countries', '') end;
  cty := coalesce((select string_agg(distinct c, ',' order by c)
                     from unnest(string_to_array(upper(regexp_replace(coalesce(raw, ''), '[^A-Za-z,]', '', 'g')), ',')) c
                    where c ~ '^[A-Z]{2}$'), '');
  if vis = 'private' then
    names := (select array_agg(distinct z.v) from (
                select btrim(regexp_replace(y, '^@', '')) as v
                  from regexp_split_to_table(coalesce(x->>'people', ''), '[,;[:space:]]+') y) z where z.v <> '');
    if names is null or cardinality(names) = 0 or cardinality(names) > 50 then return jsonb_build_object('reason', 'people'); end if;
    foreach n in array names loop
      mid := null;
      select member_id into mid from public.members
       where (lower(username) = lower(n) or upper(member_id) = upper(n)) and lower(btrim(coalesce(status, ''))) = 'active' limit 1;
      if mid is null then unknown := unknown || n; elsif mid <> coalesce(p_owner, '') then ids := ids || mid; end if;
    end loop;
    if cardinality(unknown) > 0 then return jsonb_build_object('reason', 'people', 'unknown', to_jsonb(unknown)); end if;
    if cardinality(ids) = 0 then return jsonb_build_object('reason', 'people'); end if;
  end if;
  return jsonb_build_object('visibility', vis,
    'excl_followers', vis = 'exclusive' and lower(coalesce(x->>'followers', '')) = any (yes),
    'excl_premium', vis = 'exclusive' and lower(coalesce(x->>'premium', '')) = any (yes),
    'excl_countries', case when vis = 'exclusive' then cty else '' end,
    'allowed', to_jsonb(coalesce((select array_agg(distinct i order by i) from unnest(ids) i), '{}'::text[])));
end $$;

-- The audience for its author's forms: { visibility, followers, premium, countries: [..], people: "alice, bob" }
create or replace function public._mkt_audience_out(p_vis text, p_fol boolean, p_prem boolean, p_cty text, p_allowed text[])
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('visibility', p_vis, 'followers', coalesce(p_fol, false), 'premium', coalesce(p_prem, false),
    'countries', to_jsonb(coalesce(string_to_array(nullif(p_cty, ''), ','), '{}'::text[])),
    'people', coalesce((select string_agg(m.username, ', ' order by lower(m.username))
                          from public.members m where m.member_id = any (coalesce(p_allowed, '{}'))), ''))
$$;

-- A phone number: digits (Arabic-Indic ones too), spaces, + ( ) . / -; 5 to 20 digits.
create or replace function public._mkt_phone(p text) returns text language sql immutable as $$
  select left(btrim(regexp_replace(translate(coalesce(p, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '\s+', ' ', 'g')), 30)
$$;
create or replace function public._mkt_phone_ok(p text) returns boolean language sql immutable as $$
  select coalesce(p ~ '^\+?[0-9 ()./-]{5,30}$' and length(regexp_replace(p, '\D', '', 'g')) between 5 and 20, false)
$$;

-- A delivery address as the forms send it -> { name, phone, city, line } (trimmed, cut to size).
create or replace function public._mkt_addr(p jsonb) returns jsonb language sql immutable as $$
  select jsonb_build_object('name', left(public._mkt_line(x->>'name'), 80), 'phone', public._mkt_phone(x->>'phone'),
                            'city', left(public._mkt_line(x->>'city'), 80), 'line', left(btrim(coalesce(x->>'line', '')), 200))
    from (select case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end as x) v
$$;

-- What is wrong with an address (null: nothing) for p_for: ship (name, phone, city, address),
-- hand (name, phone) or profile (the four). p_city: the city of a store of one city.
create or replace function public._mkt_addr_check(a jsonb, p_for text, p_city text default null) returns text
language sql immutable as $$
  select case
    when length(coalesce(a->>'name', '')) < 2 then 'address'
    when not public._mkt_phone_ok(a->>'phone') then 'phone'
    when p_for in ('ship', 'profile') and (length(coalesce(a->>'city', '')) < 2 or length(coalesce(a->>'line', '')) < 4) then 'address'
    when coalesce(p_city, '') <> '' and public._mkt_norm(coalesce(a->>'city', '')) <> public._mkt_norm(p_city) then 'city'
  end
$$;

-- A product as a card (Market.html lists).
create or replace function public._mkt_card(p public.market_products) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', p.id, 'title', p.title, 'price', p.price, 'kind', p.kind, 'images', public._mkt_images(p.images, 5),
    'created_at', p.created_at, 'sales', p.sales, 'stock', p.stock, 'status', p.status, 'shipping_cost', p.shipping_cost,
    'pros', p.pros, 'cons', p.cons,
    'commission', case when p.commission_on then p.commission_pct else 0 end,   -- % for a share link (0: none)
    'store', jsonb_build_object('id', s.id, 'name', s.name, 'logo', s.logo_url, 'country', s.country, 'is_open', s.is_open,
                                'tier', public._mkt_tier(s.sales_points)),
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
    'tier', public._mkt_tier(s.sales_points),
    -- only its seller still sees a suspended store
    'suspended', s.suspended, 'suspended_reason', s.suspended_reason, 'suspended_at', s.suspended_at,
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

-- What the seller receives for an order: the total, less the share commission the seller
-- pays (an order of the first version of this file, commission_pct empty: the site paid it).
create or replace function public._mkt_seller_gets(o public.market_orders) returns int
language sql immutable as $$
  select o.total - case when o.referrer_id is not null and o.commission_pct is not null then greatest(o.commission, 0) else 0 end
$$;

-- Orders that are due: shipped for 14 days → received; delivered and past their return
-- period → the seller is paid (and the member who shared the link). Called by the market
-- functions below, and by market_settle() (pg_cron, optional).
create or replace function public._mkt_settle(p_limit int default 200) returns int
language plpgsql security definer set search_path = public as $$
declare o public.market_orders; n int := 0; gets int;
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
    gets := public._mkt_seller_gets(o);
    perform public._mkt_credit(o.seller_id, gets, false);
    perform public._mkt_notify(o.seller_id, 'market_paid', 'Points received for a sale',
      '+' || gets::text || ' PT · ' || o.title, './Market.html#sales/delivered', o.buyer_id);
    if o.referrer_id is not null and o.commission > 0 then
      -- the referrer, and the member who first recommended it (an equal share, when there is one)
      perform public._mkt_credit(o.referrer_id, o.commission - coalesce(o.root_commission, 0), true);
      perform public._mkt_notify(o.referrer_id, 'market_commission', 'You earned points from a shared link',
        '+' || (o.commission - coalesce(o.root_commission, 0))::text || ' PT · ' || o.title, './Market.html?Product=' || o.product_id);
      if o.root_referrer_id is not null and coalesce(o.root_commission, 0) > 0 then
        perform public._mkt_credit(o.root_referrer_id, o.root_commission, true);
        perform public._mkt_notify(o.root_referrer_id, 'market_root_commission', 'You earned points from your recommendation',
          '+' || o.root_commission::text || ' PT · ' || o.title, './Market.html?Product=' || o.product_id);
      end if;
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
    -- a physical order is shipped once the buyer's address is there
    case when p_viewer = o.seller_id and o.status = 'sold' and (o.delivery = 'online' or o.address ? 'name') then 'ship' end,
    case when p_viewer = o.buyer_id and o.status = 'sold' and o.delivery <> 'online' then 'address' end,
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
    'delivery', o.delivery, 'address_at', o.address_at,
    'needs_address', o.status = 'sold' and o.delivery <> 'online' and not (o.address ? 'name'),
    -- a digital order delivered online: the product's link of today (or the one it was delivered with)
    'download_url', case when p_viewer in (o.seller_id, o.buyer_id) and o.delivery = 'online'
                              and o.status in ('shipped', 'delivered', 'return_requested')
                         then coalesce(nullif((select p.download_url from public.market_products p where p.id = o.product_id), ''),
                                       nullif(o.download_url, '')) end,
    'via_link', o.referrer_id is not null,
    -- the seller's side: the commission of the share link and what the seller receives
    'commission', case when p_viewer = o.seller_id then o.commission end,
    'commission_pct', case when p_viewer = o.seller_id then o.commission_pct end,
    'shared_commission', case when p_viewer = o.seller_id then o.root_referrer_id is not null end,
    'seller_gets', case when p_viewer = o.seller_id then public._mkt_seller_gets(o) end,
    'created_at', o.created_at, 'accepted_at', o.accepted_at, 'shipped_at', o.shipped_at, 'delivered_at', o.delivered_at,
    'auto_delivered', o.auto_delivered, 'return_requested_at', o.return_requested_at, 'returned_at', o.returned_at,
    'closed_at', o.closed_at, 'settled_at', o.settled_at, 'updated_at', o.updated_at,
    'auto_at', case when o.status = 'shipped' then o.shipped_at + interval '14 days' end,
    'release_at', case when o.status in ('delivered', 'return_requested') and o.settled_at is null then o.delivered_at + make_interval(days => o.return_days) end,
    'store_name', coalesce((select s.name from public.market_stores s where s.id = o.store_id), ''),
    'city_only', (select s.city from public.market_stores s where s.id = o.store_id and s.scope = 'city'),   -- the address must be there
    'seller', jsonb_build_object('id', o.seller_id, 'username', coalesce((select m.username from public.members m where m.member_id = o.seller_id), '')),
    'buyer', jsonb_build_object('id', o.buyer_id, 'username', coalesce((select m.username from public.members m where m.member_id = o.buyer_id), '')),
    -- the buyer's review of the product (one per member and product), when the viewer may read it
    'reviewed', exists (select 1 from public.market_reviews r where r.member_id = o.buyer_id and r.product_id = o.product_id),
    'review', (select jsonb_build_object('id', r.id, 'pros', r.pros, 'cons', r.cons, 'visibility', r.visibility,
                                         'verified', r.order_id is not null)
                      || case when p_viewer = r.member_id
                              then jsonb_build_object('audience', public._mkt_audience_out(r.visibility, r.excl_followers, r.excl_premium,
                                                                                            r.excl_countries, r.allowed))
                              else '{}'::jsonb end
                 from public.market_reviews r
                where r.member_id = o.buyer_id and r.product_id = o.product_id
                  and public._mkt_sees(r.member_id, r.visibility, r.excl_followers, r.excl_premium, r.excl_countries, r.allowed, p_viewer)),
    'actions', public._mkt_actions(o, p_viewer))
$$;

-- An order that has just been sold (bought in an instant store, or accepted):
--   ship / hand  the address saved in the buyer's profile goes with it, when it fits (a shipped
--                order needs the city and the address; a store of one city, its city);
--                otherwise the buyer is asked for it (Your purchases)
--   online       a product with a download link: delivered online at once
--   -> 'address' (it has one) | 'ask' (the buyer must give it) | 'online' (delivered) | '' (nothing)
create or replace function public._mkt_after_sale(p_order text) returns text
language plpgsql security definer set search_path = public as $$
declare o public.market_orders; st public.market_stores; a jsonb; link text;
begin
  select * into o from public.market_orders where id = p_order for update;
  if not found or o.status <> 'sold' then return ''; end if;
  if o.delivery = 'online' then
    select download_url into link from public.market_products where id = o.product_id;
    if coalesce(link, '') = '' then return ''; end if;
    update public.market_orders set status = 'shipped', shipped_at = now(), download_url = link, updated_at = now() where id = o.id;
    return 'online';
  end if;
  if o.address ? 'name' then return 'address'; end if;
  select jsonb_build_object('name', ad.name, 'phone', ad.phone, 'city', ad.city, 'line', ad.line) into a
    from public.market_addresses ad where ad.member_id = o.buyer_id;
  select * into st from public.market_stores where id = o.store_id;
  if a is null or public._mkt_addr_check(a, o.delivery, case when st.scope = 'city' then st.city end) is not null then
    return 'ask';
  end if;
  update public.market_orders
     set address = o.address || jsonb_strip_nulls(jsonb_build_object('name', a->>'name', 'phone', a->>'phone',
                     'city', nullif(a->>'city', ''), 'line', case when o.delivery = 'ship' then nullif(a->>'line', '') end)),
         address_at = now(), updated_at = now()
   where id = o.id;
  return 'address';
end $$;

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

-- A store page: Market.html?Store=<id> (a suspended store: its seller only)
--   -> { ok: true, store: {…}, own } | { ok: false, reason: not_found }
create or replace function public.market_store(p_id text, p_member text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare st public.market_stores; owner_ok boolean;
begin
  select * into st from public.market_stores where id = btrim(coalesce(p_id, ''));
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  select lower(btrim(coalesce(status, ''))) = 'active' into owner_ok from public.members where member_id = st.owner_id;
  if (not coalesce(owner_ok, false) or st.suspended) and st.owner_id <> btrim(coalesce(p_member, '')) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  return jsonb_build_object('ok', true, 'store', public._mkt_store_card(st), 'own', st.owner_id = btrim(coalesce(p_member, '')));
end $$;

-- ------------------------------------------------------------------ 7. products
-- Add (no id) or change a product. d = { id?, title, description, kind, price, shipping_cost, stock,
-- categories: ["…"], images?: ["https://…"], video_url, commission_on?, commission_pct? (1 to 25),
-- download_url? (digital: the private link its buyers get; absent: unchanged) }.
-- The first product opens the store. A product the team suspended can be changed, and stays
-- suspended; a suspended store cannot add products. A digital product that gets a download link
-- delivers its sold orders that were waiting.
--   -> { ok: true, id, created, store_id } | { ok: false, reason: member | blocked | title | description |
--      kind | price | shipping_cost | stock | categories | images | video | commission | download | limit |
--      suspended | not_found }
create or replace function public.market_product_save(p_member text, d jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m public.members; st public.market_stores; pr public.market_products; pid text; ttl text; descr text; knd text;
  v_price int; ship int; stk int; cats text[] := '{}'; c text; ckey text; cid text; imgs jsonb := '[]'::jsonb; x jsonb;
  vid text; created boolean := false; keys text[] := '{}'; c_on boolean; c_raw text; c_pct int; dl text; w_id text;
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
  -- the share commission: commission_on (absent: unchanged, off for a new product) and
  -- commission_pct, 1 to 25 (absent: unchanged, 10 for a new product). While it is off, a
  -- wrong percentage is not kept rather than refused (the field is hidden then).
  c_on := case when d ? 'commission_on' then public._mkt_bool(d->>'commission_on', false) end;
  c_raw := btrim(coalesce(d->>'commission_pct', ''));
  c_pct := public._mkt_int(nullif(c_raw, ''));
  if c_raw <> '' and (c_pct is null or c_pct < 1 or c_pct > 25) then
    if coalesce(c_on, false) then return jsonb_build_object('ok', false, 'reason', 'commission'); end if;
    c_pct := null;
  end if;
  -- the download link (a physical product has none)
  dl := btrim(coalesce(d->>'download_url', ''));
  if knd = 'digital' and dl <> '' and (not public._image_url_ok(dl) or length(dl) > 500) then
    return jsonb_build_object('ok', false, 'reason', 'download');
  end if;
  if knd <> 'digital' then dl := ''; end if;

  if pid is null then
    if (select count(*) from public.market_products where owner_id = m.member_id and created_at > now() - interval '1 day') >= 30
       or (select count(*) from public.market_products where owner_id = m.member_id and status <> 'deleted') >= 500 then
      return jsonb_build_object('ok', false, 'reason', 'limit');
    end if;
    if exists (select 1 from public.market_stores where owner_id = m.member_id and suspended) then
      return jsonb_build_object('ok', false, 'reason', 'suspended');
    end if;
    st := public._mkt_ensure_store(m);
    loop
      pid := 'PRD' || lpad(floor(random() * 1e10)::bigint::text, 10, '0');
      exit when not exists (select 1 from public.market_products where id = pid);
    end loop;
    insert into public.market_products (id, store_id, owner_id, title, description, kind, price, shipping_cost, stock, images, video_url,
                                        commission_on, commission_pct, download_url)
    values (pid, st.id, m.member_id, ttl, descr, knd, v_price, ship, stk, imgs, vid, coalesce(c_on, false), coalesce(c_pct, 10), dl);
    created := true;
  else
    select * into pr from public.market_products where id = pid for update;
    if not found or pr.owner_id <> m.member_id or pr.status = 'deleted' then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
    update public.market_products set
      title = ttl, description = descr, kind = knd, price = v_price, shipping_cost = ship, stock = stk,
      images = case when d ? 'images' then imgs else images end, video_url = vid,
      commission_on = coalesce(c_on, commission_on), commission_pct = coalesce(c_pct, commission_pct),
      download_url = case when knd <> 'digital' then '' when d ? 'download_url' then dl else download_url end, updated_at = now()
    where id = pid;
    st.id := pr.store_id;
    -- sold orders of it that were waiting for their download link
    for w_id in select o.id from public.market_orders o where o.product_id = pid and o.status = 'sold' and o.delivery = 'online' loop
      if public._mkt_after_sale(w_id) = 'online' then
        perform public._mkt_notify(o2.buyer_id, 'market_download', 'Your download link is ready', o2.title,
                                   './Market.html#purchases/shipped', m.member_id)
           from public.market_orders o2 where o2.id = w_id;
      end if;
    end loop;
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
-- are still open cannot be deleted; a product the team suspended can only be deleted.
--   -> { ok: true } | { ok: false, reason: member | not_found | status | orders | suspended }
create or replace function public.market_product_status(p_member text, p_id text, p_status text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.members; pr public.market_products;
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  if p_status not in ('active', 'hidden', 'deleted') then return jsonb_build_object('ok', false, 'reason', 'status'); end if;
  select * into pr from public.market_products where id = btrim(coalesce(p_id, '')) for update;
  if not found or pr.owner_id <> m.member_id or pr.status = 'deleted' then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if pr.status = 'suspended' and p_status <> 'deleted' then return jsonb_build_object('ok', false, 'reason', 'suspended'); end if;
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
        'commission_on', p.commission_on, 'commission_pct', p.commission_pct, 'download_url', p.download_url,
        'suspended_reason', p.suspended_reason, 'suspended_with_store', p.suspended_with_store,
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
             where not s.suspended
               and (q = '' or lower(s.name) like pat or lower(s.description) like pat)
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

-- Market.html?Product=<id>: the product, its store, the reviews the viewer may read and what
-- the viewer may do (review it, recommend it: their own review and recommendation of it).
-- p_country: the country of a guest (the browser's guess), only for "ships to your region".
--   -> { ok: true, product, store, viewer, reviews } | { ok: false, reason: not_found }
create or replace function public.market_product(p_id text, p_member text, p_country text default '')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  p public.market_products; st public.market_stores; m public.members; me text; cc text; owner_ok boolean;
  mine jsonb; my_rec jsonb;
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
    select public._mkt_review_json(r, me) into mine from public.market_reviews r where r.member_id = me and r.product_id = p.id;
    select public._mkt_rec_json(r, me) into my_rec from public.market_recs r
     where r.member_id = me and r.kind = 'product' and r.product_id = p.id;
  end if;
  return jsonb_build_object(
    'ok', true,
    'product', jsonb_build_object(
      'id', p.id, 'title', p.title, 'description', p.description, 'kind', p.kind, 'price', p.price,
      'shipping_cost', p.shipping_cost, 'stock', p.stock, 'sales', p.sales, 'images', p.images, 'video_url', p.video_url,
      'status', p.status, 'pros', p.pros, 'cons', p.cons, 'created_at', p.created_at, 'updated_at', p.updated_at,
      'commission', case when p.commission_on then p.commission_pct else 0 end,
      'download', p.kind = 'digital' and p.download_url <> '',      -- the link itself: its buyers only
      'categories', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.name)
                                from public.market_product_categories pc join public.market_categories c on c.id = pc.category_id
                               where pc.product_id = p.id), '[]'::jsonb))
      -- the seller's own page also gets the switch and the percentage kept while it is off (the form)
      || case when me = st.owner_id then jsonb_build_object('commission_on', p.commission_on, 'commission_pct', p.commission_pct,
                                                            'download_url', p.download_url, 'suspended_reason', p.suspended_reason,
                                                            'suspended_with_store', p.suspended_with_store)
              else '{}'::jsonb end,
    'store', public._mkt_store_card(st),
    'viewer', jsonb_build_object(
      'member', me <> '', 'own', me = st.owner_id, 'country', cc,
      'reach', public._mkt_reach(st.scope, st.country, cc),
      'saved', me <> '' and exists (select 1 from public.market_saved sv where sv.member_id = me and sv.product_id = p.id),
      -- any member but the seller reviews it; a buyer who received it, as a verified purchase
      'can_review', me <> '' and me <> st.owner_id, 'my_review', mine, 'my_rec', my_rec,
      'bought', me <> '' and exists (select 1 from public.market_orders o where o.product_id = p.id and o.buyer_id = me
                                                                              and o.status in ('delivered', 'returned')),
      'open_orders', case when me = '' then 0 else (select count(*) from public.market_orders o where o.product_id = p.id and o.buyer_id = me
                                                      and o.status in ('requested', 'sold', 'shipped')) end),
    -- how many members recommend it (publicly)
    'recs', (select count(*) from public.market_recs r where r.kind = 'product' and r.product_id = p.id and r.visibility = 'public'
                                                           and public._mkt_sees(r.member_id, 'public', false, false, '', '{}', me)),
    'reviews', coalesce((select jsonb_agg(public._mkt_review_json(r, me) - 'product' order by r.created_at desc)
                           from (select * from public.market_reviews x
                                  where x.product_id = p.id
                                    and public._mkt_sees(x.member_id, x.visibility, x.excl_followers, x.excl_premium, x.excl_countries,
                                                         x.allowed, me)
                                  order by x.created_at desc limit 200) r), '[]'::jsonb));
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
-- "Buy now". p_address = { note, city }: a note for the seller, and for a store of one city the
-- buyer's city (empty: the city of the address saved in the profile), which must be its city.
-- The delivery address itself never comes with the purchase: once the order is sold (at once in
-- an instant store, when the seller accepts in the others) the address saved in the buyer's
-- profile goes with it, or the buyer gives it in Your purchases (market_order_address).
-- p_ref = the username of the share link the buyer came from.
--   -> { ok: true, id, status, total, available, needs_address, delivered } | { ok: false, reason: member |
--      blocked | not_found | own | closed | stock | qty | scope | city | limit | points (need, have) }
create or replace function public.market_buy(p_member text, p_product text, p_qty int, p_address jsonb, p_ref text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m public.members; p public.market_products; st public.market_stores; q int := coalesce(p_qty, 1); addr jsonb;
  a_city text; a_note text; ship_on boolean; v_total int; ref text; oid text; st_code text;
  pts jsonb; c_pct int; dlv text; after text := ''; final text; root text; v_comm int;
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  if public._mkt_blocked(m.member_id, false) then return jsonb_build_object('ok', false, 'reason', 'blocked'); end if;
  select * into p from public.market_products where id = btrim(coalesce(p_product, '')) for update;
  if not found or p.status <> 'active' then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  select * into st from public.market_stores where id = p.store_id;
  if st.suspended or not exists (select 1 from public.members where member_id = st.owner_id and lower(btrim(coalesce(status, ''))) = 'active') then
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

  dlv := case when p.kind = 'digital' then 'online' when st.shipping then 'ship' else 'hand' end;
  ship_on := dlv = 'ship';
  p_address := case when jsonb_typeof(p_address) = 'object' then p_address else '{}'::jsonb end;
  a_city := left(public._mkt_line(p_address->>'city'), 80);
  a_note := left(btrim(coalesce(p_address->>'note', '')), 300);
  if st.scope = 'city' then
    if a_city = '' then a_city := coalesce((select ad.city from public.market_addresses ad where ad.member_id = m.member_id), ''); end if;
    if public._mkt_norm(a_city) <> public._mkt_norm(st.city) then
      return jsonb_build_object('ok', false, 'reason', 'city', 'city', st.city);
    end if;
  end if;
  addr := jsonb_strip_nulls(jsonb_build_object('note', nullif(a_note, '')));

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
  -- the product's share commission today (the seller pays it when the order is paid)
  c_pct := case when ref is not null and p.commission_on then p.commission_pct else 0 end;
  v_comm := floor(p.price::numeric * q * c_pct / 100)::int;
  -- the referrer recommended it again: shared equally with the member who first recommended it
  if ref is not null and v_comm > 0 then
    root := public._mkt_root_of(ref, p.id);
    if root = ref or root in (m.member_id, st.owner_id)
       or not exists (select 1 from public.members mm where mm.member_id = root and lower(btrim(coalesce(mm.status, ''))) = 'active') then
      root := null;
    end if;
  end if;

  st_code := case when st.sale_mode = 'request' then 'requested' else 'sold' end;
  loop
    oid := 'ORD' || lpad(floor(random() * 1e10)::bigint::text, 10, '0');
    exit when not exists (select 1 from public.market_orders where id = oid);
  end loop;
  insert into public.market_orders (id, product_id, store_id, seller_id, buyer_id, referrer_id, title, image, kind, qty, unit_price,
                                    shipping_cost, total, commission, commission_pct, root_referrer_id, root_commission,
                                    buyer_country, address, delivery, status, return_days, accepted_at)
  values (oid, p.id, st.id, st.owner_id, m.member_id, ref, p.title, coalesce(p.images->>0, ''), p.kind, q, p.price,
          case when ship_on then p.shipping_cost else 0 end, v_total, v_comm, c_pct,
          root, case when root is not null then v_comm / 2 else 0 end,
          upper(coalesce(m.country, '')), addr, dlv, st_code, case when st.returns then st.return_days else 0 end,
          case when st_code = 'sold' then now() end);
  update public.market_products set stock = stock - q, sales = sales + case when st_code = 'sold' then q else 0 end, updated_at = now() where id = p.id;
  delete from public.market_saved where member_id = m.member_id and product_id = p.id;
  -- sold at once: the saved address goes with it, or a download link delivers it
  if st_code = 'sold' then after := public._mkt_after_sale(oid); end if;
  final := case when after = 'online' then 'shipped' else st_code end;
  perform public._mkt_notify(st.owner_id,
    case when st_code = 'requested' then 'market_request' else 'market_order' end,
    case when st_code = 'requested' then 'New purchase request' else 'New order' end,
    q::text || ' × ' || p.title,
    './Market.html#sales/' || case final when 'requested' then 'requests' when 'shipped' then 'shipped' else 'sold' end, m.member_id);
  pts := public._points(m.member_id);
  return jsonb_build_object('ok', true, 'id', oid, 'status', final, 'total', v_total, 'available', coalesce((pts->>'available')::bigint, 0),
                            'needs_address', after = 'ask', 'delivered', after = 'online');
end $$;

-- What the seller and the buyer do with an order:
--   seller: accept | decline (note = why) | cancel (sold; note) | ship (note = tracking / for a
--           digital product what the buyer receives; a physical order needs the buyer's address
--           first) | return_accept | return_refuse (note)
--   buyer:  cancel (a request) | received | return (note = why; within the return period)
--   (the buyer's delivery address: market_order_address below)
--   -> { ok: true, status, needs_address? } | { ok: false, reason: member | not_found | state | note | window | address }
create or replace function public.market_order_action(p_member text, p_order text, p_action text, p_note text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m public.members; o public.market_orders; me text; seller boolean; buyer boolean; note text := left(btrim(coalesce(p_note, '')), 1000);
  href_b text; href_s text; after text;
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
    -- the buyer's saved address goes with it (or the buyer is asked for it); a download link delivers it
    after := public._mkt_after_sale(o.id);
    if after = 'online' then
      perform public._mkt_notify(o.buyer_id, 'market_download', 'Your purchase was accepted: the download link is ready', o.title, href_b || 'shipped', me);
    elsif after = 'ask' then
      perform public._mkt_notify(o.buyer_id, 'market_address_needed', 'Your purchase was accepted: add your delivery address', o.title, href_b || 'purchased', me);
    else
      perform public._mkt_notify(o.buyer_id, 'market_accepted', 'Your purchase request was accepted', o.title, href_b || 'purchased', me);
    end if;
    return jsonb_build_object('ok', true, 'status', case when after = 'online' then 'shipped' else 'sold' end, 'needs_address', after = 'ask');

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
    if o.delivery <> 'online' and not (o.address ? 'name') then return jsonb_build_object('ok', false, 'reason', 'address'); end if;
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

-- The buyer's delivery address for a sold physical order, until it is shipped (given again, it
-- replaces the one before). p_address = { name, phone, city, line }: name and phone; a shipped
-- order also the city and the address; a store of one city, its city. p_save: also keep it in
-- the profile (the four are needed then), for the next orders.
--   -> { ok: true, address, saved } | { ok: false, reason: member | not_found | state | address | phone | city (city) }
create or replace function public.market_order_address(p_member text, p_order text, p_address jsonb, p_save boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.members; o public.market_orders; st public.market_stores; a jsonb; bad text; first boolean; kept boolean := false;
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  select * into o from public.market_orders where id = btrim(coalesce(p_order, '')) for update;
  if not found or o.buyer_id <> m.member_id then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if o.status <> 'sold' or o.delivery = 'online' then return jsonb_build_object('ok', false, 'reason', 'state', 'status', o.status); end if;
  select * into st from public.market_stores where id = o.store_id;
  a := public._mkt_addr(p_address);
  bad := public._mkt_addr_check(a, o.delivery, case when st.scope = 'city' then st.city end);
  if bad is null and coalesce(p_save, false) then bad := public._mkt_addr_check(a, 'profile'); end if;
  if bad is not null then
    return jsonb_build_object('ok', false, 'reason', bad) || case when bad = 'city' then jsonb_build_object('city', st.city) else '{}'::jsonb end;
  end if;
  first := not (o.address ? 'name');
  update public.market_orders
     set address = jsonb_strip_nulls(jsonb_build_object('name', a->>'name', 'phone', a->>'phone', 'city', nullif(a->>'city', ''),
                     'line', case when o.delivery = 'ship' then nullif(a->>'line', '') end, 'note', nullif(o.address->>'note', ''))),
         address_at = now(), updated_at = now()
   where id = o.id;
  if coalesce(p_save, false) then
    insert into public.market_addresses (member_id, name, phone, city, line)
    values (m.member_id, a->>'name', a->>'phone', a->>'city', a->>'line')
    on conflict (member_id) do update set name = excluded.name, phone = excluded.phone, city = excluded.city, line = excluded.line, updated_at = now();
    kept := true;
  end if;
  perform public._mkt_notify(o.seller_id, 'market_address',
    case when first then 'The buyer added the delivery address' else 'The buyer changed the delivery address' end,
    o.title, './Market.html#sales/sold', m.member_id);
  return jsonb_build_object('ok', true, 'address', (select x.address from public.market_orders x where x.id = o.id), 'saved', kept);
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
-- The counts of good and bad points of a product (its cards, its page): its public reviews.
create or replace function public._mkt_review_counts(p_product text) returns void
language sql security definer set search_path = public as $$
  update public.market_products set
    pros = (select coalesce(sum(jsonb_array_length(r.pros)), 0) from public.market_reviews r where r.product_id = p_product and r.visibility = 'public'),
    cons = (select coalesce(sum(jsonb_array_length(r.cons)), 0) from public.market_reviews r where r.product_id = p_product and r.visibility = 'public')
  where id = p_product;
$$;

-- A review: its points, who wrote it (a verified purchase or not), the product (a card) and, for
-- its author, the audience.
create or replace function public._mkt_review_json(r public.market_reviews, p_viewer text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'type', 'review', 'id', r.id, 'at', r.created_at, 'created_at', r.created_at, 'updated_at', r.updated_at,
    'pros', r.pros, 'cons', r.cons, 'verified', r.order_id is not null, 'visibility', r.visibility,
    'mine', r.member_id = coalesce(p_viewer, ''),
    'author', jsonb_build_object('id', r.member_id,
                                 'username', coalesce((select mm.username from public.members mm where mm.member_id = r.member_id), '')),
    'seller', jsonb_build_object('id', r.seller_id,
                                 'username', coalesce((select mm.username from public.members mm where mm.member_id = r.seller_id), '')),
    'product', (select public._mkt_card(p) from public.market_products p where p.id = r.product_id))
  || case when r.member_id = coalesce(p_viewer, '')
          then jsonb_build_object('audience', public._mkt_audience_out(r.visibility, r.excl_followers, r.excl_premium, r.excl_countries, r.allowed))
          else '{}'::jsonb end
$$;

-- Write (or change) your review of a product: any member but its seller. The good points and the
-- bad points (1 to 10 each, 2 to 200 characters) and who may read it (p_audience: see
-- _mkt_audience). A member who received the product writes a verified purchase.
--   -> { ok: true, id, created, verified } | { ok: false, reason: member | blocked | not_found | own | empty |
--      text | visibility | people (unknown) }
create or replace function public.market_review_save(p_member text, p_product text, p_pros jsonb, p_cons jsonb,
                                                     p_audience jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m public.members; p public.market_products; st public.market_stores; old public.market_reviews;
  v_pros jsonb := '[]'::jsonb; v_cons jsonb := '[]'::jsonb; x jsonb; v text; aud jsonb; ord text; rid bigint;
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  if public._mkt_blocked(m.member_id, true) then return jsonb_build_object('ok', false, 'reason', 'blocked'); end if;
  select * into p from public.market_products where id = btrim(coalesce(p_product, ''));
  if not found or p.status = 'deleted' then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  select * into old from public.market_reviews where member_id = m.member_id and product_id = p.id;
  -- a new review: a product on sale (one already written can still change)
  if old.id is null and p.status <> 'active' then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  select * into st from public.market_stores where id = p.store_id;
  if st.owner_id = m.member_id then return jsonb_build_object('ok', false, 'reason', 'own'); end if;
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
  aud := public._mkt_audience(p_audience, m.member_id);
  if aud ? 'reason' then return jsonb_build_object('ok', false) || aud; end if;
  -- a received order: a verified purchase
  select o.id into ord from public.market_orders o
   where o.product_id = p.id and o.buyer_id = m.member_id and o.status in ('delivered', 'returned')
   order by o.delivered_at desc nulls last, o.created_at desc limit 1;
  insert into public.market_reviews (order_id, product_id, store_id, seller_id, member_id, pros, cons, visibility,
                                     excl_followers, excl_premium, excl_countries, allowed)
  values (ord, p.id, p.store_id, st.owner_id, m.member_id, v_pros, v_cons, aud->>'visibility',
          (aud->>'excl_followers')::boolean, (aud->>'excl_premium')::boolean, aud->>'excl_countries',
          array(select jsonb_array_elements_text(aud->'allowed')))
  on conflict (member_id, product_id) do update
     set order_id = excluded.order_id, pros = excluded.pros, cons = excluded.cons, visibility = excluded.visibility,
         excl_followers = excluded.excl_followers, excl_premium = excluded.excl_premium,
         excl_countries = excluded.excl_countries, allowed = excluded.allowed, updated_at = now()
  returning id into rid;
  perform public._mkt_review_counts(p.id);
  if old.id is null and public._mkt_sees(m.member_id, aud->>'visibility', (aud->>'excl_followers')::boolean,
                                          (aud->>'excl_premium')::boolean, aud->>'excl_countries',
                                          array(select jsonb_array_elements_text(aud->'allowed')), st.owner_id) then
    perform public._mkt_notify(st.owner_id, 'market_review', 'A member reviewed your product', p.title, './Market.html#ratings/sales', m.member_id);
  end if;
  return jsonb_build_object('ok', true, 'id', rid, 'created', old.id is null, 'verified', ord is not null);
end $$;

-- Remove your review of a product. -> { ok: true } | { ok: false, reason: member | not_found }
create or replace function public.market_review_delete(p_member text, p_product text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.members; pid text;
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  delete from public.market_reviews where member_id = m.member_id and product_id = btrim(coalesce(p_product, ''))
  returning product_id into pid;
  if pid is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  perform public._mkt_review_counts(pid);
  return jsonb_build_object('ok', true);
end $$;

-- Your rating: given (your reviews; first, the products you received and haven't reviewed) |
-- received (the reviews of your products you may read).
create or replace function public.market_reviews(p_member text, p_side text, p_limit int default 20, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare m public.members; me text; lim int := least(greatest(coalesce(p_limit, 20), 1), 100); off int := greatest(coalesce(p_offset, 0), 0);
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  me := m.member_id;
  if p_side not in ('given', 'received') then return jsonb_build_object('ok', false, 'reason', 'side'); end if;
  return jsonb_build_object('ok', true,
    'total', (select count(*) from public.market_reviews r
               where case when p_side = 'given' then r.member_id = me
                          else r.seller_id = me and public._mkt_sees(r.member_id, r.visibility, r.excl_followers, r.excl_premium,
                                                                     r.excl_countries, r.allowed, me) end),
    'items', coalesce((select jsonb_agg(public._mkt_review_json(r, me) order by r.created_at desc)
      from (select * from public.market_reviews r
             where case when p_side = 'given' then r.member_id = me
                        else r.seller_id = me and public._mkt_sees(r.member_id, r.visibility, r.excl_followers, r.excl_premium,
                                                                   r.excl_countries, r.allowed, me) end
             order by r.created_at desc limit lim offset off) r), '[]'::jsonb),
    -- one received order per product not reviewed yet
    'pending', case when p_side = 'given' and off = 0 then coalesce((select jsonb_agg(public._mkt_order_json(x.ord, me) order by (x.ord).delivered_at desc nulls last)
        from (select distinct on (o.product_id) o as ord from public.market_orders o
               where o.buyer_id = me and o.status in ('delivered', 'returned')
                 and not exists (select 1 from public.market_reviews r where r.member_id = me and r.product_id = o.product_id)
               order by o.product_id, o.delivered_at desc nulls last limit 50) x), '[]'::jsonb) else '[]'::jsonb end);
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
  if st.suspended then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
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

-- ------------------------------------------------------------------ 12. the delivery address
-- The address kept in the member's profile (Dashboard > Settings > Profile). Each physical order
-- the member buys gets it by itself once it is sold.
--   -> { ok: true, address: { name, phone, city, line, updated_at } | null } | { ok: false, reason: member }
create or replace function public.market_address(p_member text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare m public.members;
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  return jsonb_build_object('ok', true, 'address',
    (select jsonb_build_object('name', a.name, 'phone', a.phone, 'city', a.city, 'line', a.line, 'updated_at', a.updated_at)
       from public.market_addresses a where a.member_id = m.member_id));
end $$;

-- Saves it: p_address = { name, phone, city, line } (the four are needed); null removes it.
-- The sold orders still waiting for an address (and not for a city it does not fit) get it too.
--   -> { ok: true, address, orders } | { ok: false, reason: member | address | phone }
create or replace function public.market_address_save(p_member text, p_address jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.members; a jsonb; bad text; w_id text; n int := 0;
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  if p_address is null or jsonb_typeof(p_address) = 'null' then
    delete from public.market_addresses where member_id = m.member_id;
    return jsonb_build_object('ok', true, 'address', null, 'orders', 0);
  end if;
  a := public._mkt_addr(p_address);
  bad := public._mkt_addr_check(a, 'profile');
  if bad is not null then return jsonb_build_object('ok', false, 'reason', bad); end if;
  insert into public.market_addresses (member_id, name, phone, city, line)
  values (m.member_id, a->>'name', a->>'phone', a->>'city', a->>'line')
  on conflict (member_id) do update set name = excluded.name, phone = excluded.phone, city = excluded.city, line = excluded.line, updated_at = now();
  for w_id in select o.id from public.market_orders o
               where o.buyer_id = m.member_id and o.status = 'sold' and o.delivery <> 'online' and not (o.address ? 'name') loop
    if public._mkt_after_sale(w_id) = 'address' then
      n := n + 1;
      perform public._mkt_notify(o.seller_id, 'market_address', 'The buyer added the delivery address', o.title, './Market.html#sales/sold', m.member_id)
         from public.market_orders o where o.id = w_id;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'orders', n,
    'address', (select jsonb_build_object('name', x.name, 'phone', x.phone, 'city', x.city, 'line', x.line, 'updated_at', x.updated_at)
                  from public.market_addresses x where x.member_id = m.member_id));
end $$;

-- ------------------------------------------------------------------ 13. reports and the team
-- The Report button of a store page and of a product page (not your own). One open report per
-- member and store / product, 20 a day.
--   p_reason: fake | scam | prohibited | misleading | offensive | no_delivery | other (other: p_note says why)
--   -> { ok: true, id } | { ok: false, reason: member | blocked | kind | not_found | own | reason | note | already | limit }
create or replace function public.market_report(p_member text, p_kind text, p_id text, p_reason text, p_note text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m public.members; st public.market_stores; pr public.market_products; v_id text := btrim(coalesce(p_id, ''));
  why text := coalesce(p_reason, ''); v_note text := left(btrim(coalesce(p_note, '')), 500); rid bigint;
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  if public._mkt_blocked(m.member_id, false) then return jsonb_build_object('ok', false, 'reason', 'blocked'); end if;
  if p_kind = 'product' then
    select * into pr from public.market_products where id = v_id and status <> 'deleted';
    if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
    select * into st from public.market_stores where id = pr.store_id;
  elsif p_kind = 'store' then
    select * into st from public.market_stores where id = v_id;
    if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  else
    return jsonb_build_object('ok', false, 'reason', 'kind');
  end if;
  if st.owner_id = m.member_id then return jsonb_build_object('ok', false, 'reason', 'own'); end if;
  if why not in ('fake', 'scam', 'prohibited', 'misleading', 'offensive', 'no_delivery', 'other') then
    return jsonb_build_object('ok', false, 'reason', 'reason');
  end if;
  if why = 'other' and length(v_note) < 5 then return jsonb_build_object('ok', false, 'reason', 'note'); end if;
  if exists (select 1 from public.market_reports where reporter_id = m.member_id and kind = p_kind and target_id = v_id and status = 'open') then
    return jsonb_build_object('ok', false, 'reason', 'already');
  end if;
  if (select count(*) from public.market_reports where reporter_id = m.member_id and created_at > now() - interval '1 day') >= 20 then
    return jsonb_build_object('ok', false, 'reason', 'limit');
  end if;
  insert into public.market_reports (kind, target_id, store_id, owner_id, reporter_id, reason, note)
  values (p_kind, v_id, st.id, st.owner_id, m.member_id, why, v_note)
  on conflict do nothing
  returning id into rid;
  if rid is null then return jsonb_build_object('ok', false, 'reason', 'already'); end if;
  return jsonb_build_object('ok', true, 'id', rid);
end $$;

-- The team (staff sessions of sql/prize_secure.sql): the Super Admin, or a staff member with the
-- Reports section. -> who did it, for handled_by.
create or replace function public._mkt_staff(p_token text) returns text
language plpgsql security definer set search_path = public as $$
declare s record;
begin
  s := public._staff(p_token);
  if s.role <> 'super' and position(',reports,' in ',' || coalesce(s.sections, '') || ',') = 0 then
    raise exception 'staff_forbidden';
  end if;
  return coalesce(nullif(s.username, ''), s.role);
end $$;

create or replace function public._mkt_report_json(r public.market_reports) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', r.id, 'kind', r.kind, 'target_id', r.target_id, 'store_id', r.store_id, 'reason', r.reason, 'note', r.note,
    'status', r.status, 'created_at', r.created_at, 'handled_by', r.handled_by, 'handled_at', r.handled_at,
    'reporter', jsonb_build_object('id', r.reporter_id, 'username', coalesce((select mm.username from public.members mm where mm.member_id = r.reporter_id), '')),
    'owner', jsonb_build_object('id', r.owner_id, 'username', coalesce((select mm.username from public.members mm where mm.member_id = r.owner_id), '')),
    'store', (select jsonb_build_object('id', s.id, 'name', s.name, 'logo', s.logo_url, 'suspended', s.suspended,
                                        'suspended_reason', s.suspended_reason, 'tier', public._mkt_tier(s.sales_points))
                from public.market_stores s where s.id = r.store_id),
    'product', case when r.kind = 'product' then
                 (select jsonb_build_object('id', p.id, 'title', p.title, 'image', coalesce(p.images->>0, ''), 'price', p.price,
                                            'kind', p.kind, 'status', p.status, 'suspended_reason', p.suspended_reason,
                                            'suspended_with_store', p.suspended_with_store)
                    from public.market_products p where p.id = r.target_id) end)
$$;

-- Panel > Reports > Market. p_filter: open | closed | all
--   -> { ok: true, open, items: [ report ] }  (an expired session: error staff_auth)
create or replace function public.market_reports_admin(p_token text, p_filter text default 'open', p_limit int default 400)
returns jsonb language plpgsql security definer set search_path = public as $$
declare who text; lim int := least(greatest(coalesce(p_limit, 400), 1), 1000);
begin
  who := public._mkt_staff(p_token);
  return jsonb_build_object('ok', true,
    'open', (select count(*) from public.market_reports where status = 'open'),
    'items', coalesce((select jsonb_agg(public._mkt_report_json(r) order by r.created_at desc)
                         from (select * from public.market_reports
                                where case coalesce(p_filter, 'open') when 'open' then status = 'open'
                                                                      when 'closed' then status <> 'open' else true end
                                order by created_at desc limit lim) r), '[]'::jsonb));
end $$;

-- The open market reports (the badge of Reports in the side menu of the panel).
create or replace function public.market_reports_count(p_token text)
returns int language plpgsql security definer set search_path = public as $$
declare who text;
begin
  who := public._mkt_staff(p_token);
  return (select count(*) from public.market_reports where status = 'open');
end $$;

-- p_status: resolved | dismissed | open (reopen)
--   -> { ok: true, changed } | { ok: false, reason: status }
create or replace function public.market_reports_set(p_token text, p_ids bigint[], p_status text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare who text; n int;
begin
  who := public._mkt_staff(p_token);
  if p_status not in ('resolved', 'dismissed', 'open') then return jsonb_build_object('ok', false, 'reason', 'status'); end if;
  if p_status = 'open' then
    -- one open report per member and thing: their latest one, unless another one is open already
    update public.market_reports r set status = 'open', handled_by = '', handled_at = null
     where r.id in (select distinct on (x.reporter_id, x.kind, x.target_id) x.id from public.market_reports x
                     where x.id = any (coalesce(p_ids, '{}')) and x.status <> 'open'
                     order by x.reporter_id, x.kind, x.target_id, x.created_at desc, x.id desc)
       and not exists (select 1 from public.market_reports o2 where o2.status = 'open' and o2.reporter_id = r.reporter_id
                         and o2.kind = r.kind and o2.target_id = r.target_id);
  else
    update public.market_reports set status = p_status, handled_by = who, handled_at = now()
     where id = any (coalesce(p_ids, '{}')) and status <> p_status;
  end if;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'changed', n);
end $$;

--   -> { ok: true, deleted }
create or replace function public.market_reports_delete(p_token text, p_ids bigint[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare who text; n int;
begin
  who := public._mkt_staff(p_token);
  delete from public.market_reports where id = any (coalesce(p_ids, '{}'));
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'deleted', n);
end $$;

-- Suspend or restore a product or a whole store (Panel > Reports > Market).
--   p_kind store | product, p_action suspend (p_reason: 3 to 300 characters, the seller reads it) | restore
--   A suspended product is hidden from everybody but its seller, who cannot show it again (only
--   delete it). A suspended store is hidden with all its products and cannot add any; the orders
--   already made go on. Suspending closes the open reports of it (resolved); the seller gets a
--   notification both times.
--   -> { ok: true, status } | { ok: false, reason: kind | action | not_found | reason | state | store }
create or replace function public.market_moderate(p_token text, p_kind text, p_id text, p_action text, p_reason text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  who text; st public.market_stores; pr public.market_products; v_id text := btrim(coalesce(p_id, ''));
  why text := left(btrim(regexp_replace(coalesce(p_reason, ''), '\s+', ' ', 'g')), 300); v_status text;
begin
  who := public._mkt_staff(p_token);
  if p_action not in ('suspend', 'restore') then return jsonb_build_object('ok', false, 'reason', 'action'); end if;
  if p_action = 'suspend' and length(why) < 3 then return jsonb_build_object('ok', false, 'reason', 'reason'); end if;
  if p_kind = 'product' then
    select * into pr from public.market_products where id = v_id for update;
    if not found or pr.status = 'deleted' then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
    if p_action = 'suspend' then
      update public.market_products
         set status_before = case when status = 'suspended' then status_before else status end,
             status = 'suspended', suspended_reason = why, suspended_with_store = false, updated_at = now()
       where id = pr.id;
      update public.market_reports set status = 'resolved', handled_by = who, handled_at = now()
       where kind = 'product' and target_id = pr.id and status = 'open';
      perform public._mkt_notify(pr.owner_id, 'market_suspended', 'The team suspended your product', pr.title || ' · ' || why,
                                 './Market.html#sales/products');
      return jsonb_build_object('ok', true, 'status', 'suspended');
    end if;
    if pr.status <> 'suspended' then return jsonb_build_object('ok', false, 'reason', 'state'); end if;
    if exists (select 1 from public.market_stores s where s.id = pr.store_id and s.suspended) then
      return jsonb_build_object('ok', false, 'reason', 'store');
    end if;
    v_status := case when pr.status_before in ('active', 'hidden') then pr.status_before else 'hidden' end;
    update public.market_products
       set status = v_status, status_before = null, suspended_reason = '', suspended_with_store = false, updated_at = now()
     where id = pr.id;
    perform public._mkt_notify(pr.owner_id, 'market_restored', 'The team restored your product', pr.title, './Market.html#sales/products');
    return jsonb_build_object('ok', true, 'status', v_status);
  elsif p_kind = 'store' then
    select * into st from public.market_stores where id = v_id for update;
    if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
    if p_action = 'suspend' then
      update public.market_stores set suspended = true, suspended_reason = why, suspended_at = coalesce(suspended_at, now()), updated_at = now()
       where id = st.id;
      update public.market_products
         set status_before = status, status = 'suspended', suspended_reason = why, suspended_with_store = true, updated_at = now()
       where store_id = st.id and status in ('active', 'hidden');
      update public.market_products set suspended_reason = why, updated_at = now()
       where store_id = st.id and status = 'suspended' and suspended_with_store;
      update public.market_reports set status = 'resolved', handled_by = who, handled_at = now()
       where kind = 'store' and target_id = st.id and status = 'open';
      perform public._mkt_notify(st.owner_id, 'market_suspended', 'The team suspended your store', st.name || ' · ' || why, './Market.html#settings');
      return jsonb_build_object('ok', true, 'status', 'suspended');
    end if;
    if not st.suspended then return jsonb_build_object('ok', false, 'reason', 'state'); end if;
    update public.market_stores set suspended = false, suspended_reason = '', suspended_at = null, updated_at = now() where id = st.id;
    update public.market_products
       set status = case when status_before in ('active', 'hidden') then status_before else 'hidden' end,
           status_before = null, suspended_reason = '', suspended_with_store = false, updated_at = now()
     where store_id = st.id and status = 'suspended' and suspended_with_store;
    perform public._mkt_notify(st.owner_id, 'market_restored', 'The team restored your store', st.name, './Market.html#settings');
    return jsonb_build_object('ok', true, 'status', 'active');
  end if;
  return jsonb_build_object('ok', false, 'reason', 'kind');
end $$;

-- ------------------------------------------------------------------ 15. purchase lists, recommendations, Updates
-- A purchase list as a card: its author, the products on sale in it (how many, the first pictures)
-- and, for its author, the audience.
create or replace function public._mkt_list_json(l public.market_lists, p_viewer text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'type', 'list', 'id', l.id, 'name', l.name, 'description', l.description, 'visibility', l.visibility,
    'at', l.created_at, 'created_at', l.created_at, 'updated_at', l.updated_at, 'mine', l.member_id = coalesce(p_viewer, ''),
    'author', jsonb_build_object('id', l.member_id,
                                 'username', coalesce((select mm.username from public.members mm where mm.member_id = l.member_id), '')),
    'count', (select count(*) from public.market_list_items i join public.market_products p on p.id = i.product_id and p.status = 'active'
               where i.list_id = l.id),
    'images', coalesce((select jsonb_agg(x.img) from (
                select p.images->>0 as img from public.market_list_items i
                  join public.market_products p on p.id = i.product_id and p.status = 'active'
                 where i.list_id = l.id and jsonb_array_length(p.images) > 0
                 order by i.added_at desc limit 4) x), '[]'::jsonb),
    -- recommended again: how many times; may the viewer (a public list of somebody else, once)
    'shares', (select count(*) from public.market_recs x where x.kind = 'list' and x.list_id = l.id),
    'can_share', coalesce(p_viewer, '') <> '' and l.member_id <> coalesce(p_viewer, '') and l.visibility = 'public'
                 and not exists (select 1 from public.market_recs x where x.member_id = p_viewer and x.kind = 'list' and x.list_id = l.id),
    'my_share', (select x.id from public.market_recs x where x.member_id = coalesce(p_viewer, '') and x.kind = 'list' and x.list_id = l.id))
  || case when l.member_id = coalesce(p_viewer, '')
          then jsonb_build_object('audience', public._mkt_audience_out(l.visibility, l.excl_followers, l.excl_premium, l.excl_countries, l.allowed))
          else '{}'::jsonb end
$$;

-- A recommendation: its author and note, the product (a card) or the purchase list, and when it
-- was recommended again: the member who first recommended it (root, with their note when the
-- viewer may read it) and the one it came from (via). can_share: the viewer may recommend it
-- again (a public one, of somebody else, of something they don't recommend yet).
create or replace function public._mkt_rec_json(r public.market_recs, p_viewer text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'type', 'rec', 'id', r.id, 'kind', r.kind, 'note', r.note, 'visibility', r.visibility,
    'at', r.created_at, 'created_at', r.created_at, 'updated_at', r.updated_at, 'mine', r.member_id = coalesce(p_viewer, ''),
    'author', jsonb_build_object('id', r.member_id,
                                 'username', coalesce((select mm.username from public.members mm where mm.member_id = r.member_id), '')),
    'product', case when r.kind = 'product' then (select public._mkt_card(p) from public.market_products p where p.id = r.product_id) end,
    'list', case when r.kind = 'list' then (select public._mkt_list_json(l, p_viewer) from public.market_lists l where l.id = r.list_id) end,
    'root', case when r.kind = 'product' then
              (select jsonb_build_object('id', o.id, 'author', jsonb_build_object('id', o.member_id, 'username', mm.username),
                        'note', case when public._mkt_sees(o.member_id, o.visibility, o.excl_followers, o.excl_premium, o.excl_countries,
                                                            o.allowed, p_viewer) then o.note else '' end)
                 from public.market_recs o join public.members mm on mm.member_id = o.member_id where o.id = r.root_id)
            else (select jsonb_build_object('id', l.id, 'author', jsonb_build_object('id', l.member_id, 'username', mm.username), 'note', '')
                    from public.market_lists l join public.members mm on mm.member_id = l.member_id where l.id = r.list_id) end,
    'via', (select jsonb_build_object('id', v.id, 'author', jsonb_build_object('id', v.member_id, 'username', mm.username))
              from public.market_recs v join public.members mm on mm.member_id = v.member_id
             where v.id = r.parent_id and v.id is distinct from r.root_id),
    'shares', (select count(*) from public.market_recs x
                where (r.kind = 'product' and x.root_id = coalesce(r.root_id, r.id))
                   or (r.kind = 'list' and x.kind = 'list' and x.list_id = r.list_id)),
    'can_share', coalesce(p_viewer, '') <> '' and r.member_id <> coalesce(p_viewer, '') and r.visibility = 'public'
                 and case when r.kind = 'product'
                          then exists (select 1 from public.market_products p where p.id = r.product_id and p.status = 'active')
                               and not exists (select 1 from public.market_recs o where o.id = r.root_id and o.member_id = p_viewer)
                          else exists (select 1 from public.market_lists l where l.id = r.list_id and l.visibility = 'public'
                                                                              and l.member_id <> p_viewer) end
                 and not exists (select 1 from public.market_recs x where x.member_id = p_viewer and x.kind = r.kind
                                   and coalesce(x.product_id, x.list_id) = coalesce(r.product_id, r.list_id)),
    'my_share', (select x.id from public.market_recs x where x.member_id = coalesce(p_viewer, '') and x.kind = r.kind
                   and coalesce(x.product_id, x.list_id) = coalesce(r.product_id, r.list_id) and x.id <> r.id))
  || case when r.member_id = coalesce(p_viewer, '')
          then jsonb_build_object('audience', public._mkt_audience_out(r.visibility, r.excl_followers, r.excl_premium, r.excl_countries, r.allowed))
          else '{}'::jsonb end
$$;

-- What brought a buyer who came through p_ref's link: the member who first recommended it, when
-- p_ref recommended it again — p_ref's newest recommendation of the product, of a purchase list
-- holding it, or purchase list of their own holding it. Null when p_ref started it (their own
-- recommendation or list, a plain share link, or a first recommendation that is gone).
create or replace function public._mkt_root_of(p_ref text, p_product text) returns text
language sql stable security definer set search_path = public as $$
  select case x.src
           when 'product' then (select o.member_id from public.market_recs o where o.id = x.root_id)
           when 'list' then (select l.member_id from public.market_lists l where l.id = x.list_id and l.member_id <> p_ref)
         end
  from (
    select 'product' as src, r.root_id, null::text as list_id, r.created_at as at
      from public.market_recs r where r.member_id = p_ref and r.kind = 'product' and r.product_id = p_product
    union all
    select 'list', null, r.list_id, r.created_at
      from public.market_recs r where r.member_id = p_ref and r.kind = 'list'
       and exists (select 1 from public.market_list_items i where i.list_id = r.list_id and i.product_id = p_product)
    union all
    select 'own', null, l.id, greatest(l.created_at, i.added_at)
      from public.market_lists l join public.market_list_items i on i.list_id = l.id and i.product_id = p_product
     where l.member_id = p_ref
    order by 4 desc limit 1
  ) x
$$;

-- ---- purchase lists
-- Create (no id) or change a purchase list. d = { id?, name, description, visibility, followers,
-- premium, countries, people } (see _mkt_audience). 50 lists per member.
--   -> { ok: true, id, created } | { ok: false, reason: member | blocked | not_found | name | description |
--      visibility | people (unknown) | limit }
create or replace function public.market_list_save(p_member text, d jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m public.members; x jsonb := case when jsonb_typeof(d) = 'object' then d else '{}'::jsonb end;
  v_id text := btrim(coalesce(x->>'id', '')); nm text := left(public._mkt_line(x->>'name'), 200);
  descr text := btrim(coalesce(x->>'description', '')); aud jsonb; created boolean := false;
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  if public._mkt_blocked(m.member_id, true) then return jsonb_build_object('ok', false, 'reason', 'blocked'); end if;
  if v_id <> '' and not exists (select 1 from public.market_lists where id = v_id and member_id = m.member_id) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if length(nm) < 2 or length(nm) > 80 then return jsonb_build_object('ok', false, 'reason', 'name'); end if;
  if length(descr) > 500 then return jsonb_build_object('ok', false, 'reason', 'description'); end if;
  aud := public._mkt_audience(x, m.member_id);
  if aud ? 'reason' then return jsonb_build_object('ok', false) || aud; end if;
  if v_id = '' then
    if (select count(*) from public.market_lists where member_id = m.member_id) >= 50 then
      return jsonb_build_object('ok', false, 'reason', 'limit');
    end if;
    loop
      v_id := 'MPL' || lpad(floor(random() * 1e9)::bigint::text, 9, '0');
      exit when not exists (select 1 from public.market_lists where id = v_id);
    end loop;
    insert into public.market_lists (id, member_id, name, description, visibility, excl_followers, excl_premium, excl_countries, allowed)
    values (v_id, m.member_id, nm, descr, aud->>'visibility', (aud->>'excl_followers')::boolean, (aud->>'excl_premium')::boolean,
            aud->>'excl_countries', array(select jsonb_array_elements_text(aud->'allowed')));
    created := true;
  else
    update public.market_lists
       set name = nm, description = descr, visibility = aud->>'visibility', excl_followers = (aud->>'excl_followers')::boolean,
           excl_premium = (aud->>'excl_premium')::boolean, excl_countries = aud->>'excl_countries',
           allowed = array(select jsonb_array_elements_text(aud->'allowed')), updated_at = now()
     where id = v_id;
    -- not public any more: nobody can recommend it again (those already made stay with their author)
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'created', created);
end $$;

--   -> { ok: true } | { ok: false, reason: member | not_found }
create or replace function public.market_list_delete(p_member text, p_list text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.members;
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  delete from public.market_lists where id = btrim(coalesce(p_list, '')) and member_id = m.member_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end $$;

-- Put a product in one of your purchase lists (p_on), or take it out. 100 products per list.
--   -> { ok: true, on, count } | { ok: false, reason: member | not_found | product | full }
create or replace function public.market_list_item(p_member text, p_list text, p_product text, p_on boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.members; l public.market_lists; pid text := btrim(coalesce(p_product, ''));
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  select * into l from public.market_lists where id = btrim(coalesce(p_list, '')) and member_id = m.member_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if coalesce(p_on, false) then
    if not exists (select 1 from public.market_products where id = pid and status = 'active') then
      return jsonb_build_object('ok', false, 'reason', 'product');
    end if;
    if not exists (select 1 from public.market_list_items where list_id = l.id and product_id = pid) then
      if (select count(*) from public.market_list_items where list_id = l.id) >= 100 then
        return jsonb_build_object('ok', false, 'reason', 'full');
      end if;
      insert into public.market_list_items (list_id, product_id) values (l.id, pid);
      update public.market_lists set updated_at = now() where id = l.id;
    end if;
  else
    delete from public.market_list_items where list_id = l.id and product_id = pid;
  end if;
  return jsonb_build_object('ok', true, 'on', coalesce(p_on, false),
                            'count', (select count(*) from public.market_list_items where list_id = l.id));
end $$;

-- Your purchase lists (the "Add to a purchase list" dialog of a product page), and whether
-- p_product is in each one. -> { ok: true, items: [{ id, name, visibility, count, has }] }
create or replace function public.market_lists_mine(p_member text, p_product text default '')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare m public.members;
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  return jsonb_build_object('ok', true, 'items', coalesce((select jsonb_agg(jsonb_build_object(
      'id', l.id, 'name', l.name, 'visibility', l.visibility,
      'count', (select count(*) from public.market_list_items i where i.list_id = l.id),
      'has', exists (select 1 from public.market_list_items i where i.list_id = l.id and i.product_id = btrim(coalesce(p_product, '')))
    ) order by l.updated_at desc) from public.market_lists l where l.member_id = m.member_id), '[]'::jsonb));
end $$;

-- A purchase list page: Market.html?List=<id>. Its products on sale (newest first), for whoever
-- may see it. -> { ok: true, list, items: [cards] } | { ok: false, reason: not_found }
create or replace function public.market_list(p_list text, p_member text default '')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare l public.market_lists; me text;
begin
  me := coalesce((public._mkt_member(p_member)).member_id, '');
  select * into l from public.market_lists where id = btrim(coalesce(p_list, ''));
  if not found or not public._mkt_sees(l.member_id, l.visibility, l.excl_followers, l.excl_premium, l.excl_countries, l.allowed, me) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  return jsonb_build_object('ok', true,
    'list', public._mkt_list_json(l, me),
    'items', coalesce((select jsonb_agg(public._mkt_card(p) || jsonb_build_object('added_at', i.added_at) order by i.added_at desc)
                         from public.market_list_items i join public.market_products p on p.id = i.product_id and p.status = 'active'
                        where i.list_id = l.id), '[]'::jsonb));
end $$;

-- ---- recommendations
-- Recommend a product (its page), or change your recommendation of it (note: 0 to 500
-- characters; d also holds the audience). A recommendation made again from somebody else's stays
-- linked to the first one.
--   -> { ok: true, id, created } | { ok: false, reason: member | blocked | not_found | note | visibility | people | limit }
create or replace function public.market_rec_save(p_member text, p_product text, d jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m public.members; p public.market_products; x jsonb := case when jsonb_typeof(d) = 'object' then d else '{}'::jsonb end;
  v_note text := btrim(coalesce(x->>'note', '')); aud jsonb; rid text; created boolean := false;
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  if public._mkt_blocked(m.member_id, true) then return jsonb_build_object('ok', false, 'reason', 'blocked'); end if;
  select * into p from public.market_products where id = btrim(coalesce(p_product, '')) and status = 'active';
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if length(v_note) > 500 then return jsonb_build_object('ok', false, 'reason', 'note'); end if;
  aud := public._mkt_audience(x, m.member_id);
  if aud ? 'reason' then return jsonb_build_object('ok', false) || aud; end if;
  select id into rid from public.market_recs where member_id = m.member_id and kind = 'product' and product_id = p.id;
  if rid is null then
    if (select count(*) from public.market_recs where member_id = m.member_id and created_at > now() - interval '1 day') >= 100 then
      return jsonb_build_object('ok', false, 'reason', 'limit');
    end if;
    loop
      rid := 'REC' || lpad(floor(random() * 1e10)::bigint::text, 10, '0');
      exit when not exists (select 1 from public.market_recs where id = rid);
    end loop;
    insert into public.market_recs (id, member_id, kind, product_id, note, visibility, excl_followers, excl_premium, excl_countries, allowed)
    values (rid, m.member_id, 'product', p.id, v_note, aud->>'visibility', (aud->>'excl_followers')::boolean,
            (aud->>'excl_premium')::boolean, aud->>'excl_countries', array(select jsonb_array_elements_text(aud->'allowed')));
    created := true;
  else
    update public.market_recs
       set note = v_note, visibility = aud->>'visibility', excl_followers = (aud->>'excl_followers')::boolean,
           excl_premium = (aud->>'excl_premium')::boolean, excl_countries = aud->>'excl_countries',
           allowed = array(select jsonb_array_elements_text(aud->'allowed')), updated_at = now()
     where id = rid;
  end if;
  return jsonb_build_object('ok', true, 'id', rid, 'created', created);
end $$;

-- Recommend again (Updates, a member's page, a purchase list page) a public recommendation
-- (p_kind rec, p_id REC…) or a public purchase list (p_kind list, p_id MPL…) of somebody else.
-- d: the note and the audience of yours. The member who first recommended it is told.
--   -> { ok: true, id } | { ok: false, reason: member | blocked | kind | not_found | private | own | already |
--      note | visibility | people | limit }
create or replace function public.market_rec_share(p_member text, p_kind text, p_id text, d jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m public.members; par public.market_recs; l public.market_lists; x jsonb := case when jsonb_typeof(d) = 'object' then d else '{}'::jsonb end;
  v_note text := btrim(coalesce(x->>'note', '')); aud jsonb; rid text; v_kind text; v_product text; v_list text;
  v_root text; root_member text; what text;
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  if public._mkt_blocked(m.member_id, true) then return jsonb_build_object('ok', false, 'reason', 'blocked'); end if;
  if p_kind = 'rec' then
    select * into par from public.market_recs where id = btrim(coalesce(p_id, ''));
    if not found or not public._mkt_sees(par.member_id, par.visibility, par.excl_followers, par.excl_premium, par.excl_countries,
                                         par.allowed, m.member_id) then
      return jsonb_build_object('ok', false, 'reason', 'not_found');
    end if;
    if par.visibility <> 'public' then return jsonb_build_object('ok', false, 'reason', 'private'); end if;
    if par.member_id = m.member_id then return jsonb_build_object('ok', false, 'reason', 'own'); end if;
    v_kind := par.kind; v_product := par.product_id; v_list := par.list_id;
    if v_kind = 'product' then
      v_root := coalesce(par.root_id, par.id);
      select member_id into root_member from public.market_recs where id = v_root;
      if not exists (select 1 from public.market_products where id = v_product and status = 'active') then
        return jsonb_build_object('ok', false, 'reason', 'not_found');
      end if;
    end if;
  elsif p_kind = 'list' then
    v_kind := 'list'; v_list := btrim(coalesce(p_id, ''));
  else
    return jsonb_build_object('ok', false, 'reason', 'kind');
  end if;
  if v_kind = 'list' then
    select * into l from public.market_lists where id = v_list;
    if not found or not public._mkt_sees(l.member_id, l.visibility, l.excl_followers, l.excl_premium, l.excl_countries,
                                         l.allowed, m.member_id) then
      return jsonb_build_object('ok', false, 'reason', 'not_found');
    end if;
    if l.visibility <> 'public' then return jsonb_build_object('ok', false, 'reason', 'private'); end if;
    root_member := l.member_id;
  end if;
  if root_member = m.member_id then return jsonb_build_object('ok', false, 'reason', 'own'); end if;
  if exists (select 1 from public.market_recs where member_id = m.member_id and kind = v_kind
                                                  and coalesce(product_id, list_id) = coalesce(v_product, v_list)) then
    return jsonb_build_object('ok', false, 'reason', 'already');
  end if;
  if length(v_note) > 500 then return jsonb_build_object('ok', false, 'reason', 'note'); end if;
  aud := public._mkt_audience(x, m.member_id);
  if aud ? 'reason' then return jsonb_build_object('ok', false) || aud; end if;
  if (select count(*) from public.market_recs where member_id = m.member_id and created_at > now() - interval '1 day') >= 100 then
    return jsonb_build_object('ok', false, 'reason', 'limit');
  end if;
  loop
    rid := 'REC' || lpad(floor(random() * 1e10)::bigint::text, 10, '0');
    exit when not exists (select 1 from public.market_recs where id = rid);
  end loop;
  insert into public.market_recs (id, member_id, kind, product_id, list_id, root_id, parent_id, note, visibility,
                                  excl_followers, excl_premium, excl_countries, allowed)
  values (rid, m.member_id, v_kind, v_product, v_list, v_root, par.id, v_note, aud->>'visibility', (aud->>'excl_followers')::boolean,
          (aud->>'excl_premium')::boolean, aud->>'excl_countries', array(select jsonb_array_elements_text(aud->'allowed')));
  if root_member is not null then
    what := case when v_kind = 'list' then (select name from public.market_lists where id = v_list)
                 else (select title from public.market_products where id = v_product) end;
    perform public._mkt_notify(root_member, 'market_rerec',
      case when v_kind = 'list' then 'A member recommended your purchase list' else 'A member recommended your recommendation again' end,
      '@' || m.username || ' · ' || coalesce(what, ''),
      case when v_kind = 'list' then './Market.html?List=' || v_list else './Market.html?Product=' || v_product end, m.member_id);
  end if;
  return jsonb_build_object('ok', true, 'id', rid);
end $$;

--   -> { ok: true } | { ok: false, reason: member | not_found }
create or replace function public.market_rec_delete(p_member text, p_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.members;
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  delete from public.market_recs where id = btrim(coalesce(p_id, '')) and member_id = m.member_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end $$;

-- ---- a member's page > Market, Profile > Updates
-- What p_owner published that the viewer may see, still on sale: recommendations (of a product on
-- sale, or of a purchase list the viewer may see with products in it), purchase lists (with
-- products in it; their author also sees the empty ones), reviews (of a product on sale).
create or replace function public._mkt_published(p_owners text[], p_viewer text)
returns table (t text, id text, at timestamptz, owner text)
language sql stable security definer set search_path = public as $$
  select 'rec', r.id, r.created_at, r.member_id from public.market_recs r
   where r.member_id = any (p_owners)
     and public._mkt_sees(r.member_id, r.visibility, r.excl_followers, r.excl_premium, r.excl_countries, r.allowed, p_viewer)
     and case when r.kind = 'product'
              then exists (select 1 from public.market_products p where p.id = r.product_id and p.status = 'active')
              else exists (select 1 from public.market_lists l where l.id = r.list_id
                             and public._mkt_sees(l.member_id, l.visibility, l.excl_followers, l.excl_premium, l.excl_countries, l.allowed, p_viewer)
                             and exists (select 1 from public.market_list_items i join public.market_products p on p.id = i.product_id
                                          where i.list_id = l.id and p.status = 'active')) end
  union all
  select 'list', l.id, l.created_at, l.member_id from public.market_lists l
   where l.member_id = any (p_owners)
     and public._mkt_sees(l.member_id, l.visibility, l.excl_followers, l.excl_premium, l.excl_countries, l.allowed, p_viewer)
     and (l.member_id = coalesce(p_viewer, '')
          or exists (select 1 from public.market_list_items i join public.market_products p on p.id = i.product_id
                      where i.list_id = l.id and p.status = 'active'))
  union all
  select 'review', 'RV' || r.id::text, r.created_at, r.member_id from public.market_reviews r
   where r.member_id = any (p_owners)
     and public._mkt_sees(r.member_id, r.visibility, r.excl_followers, r.excl_premium, r.excl_countries, r.allowed, p_viewer)
     and exists (select 1 from public.market_products p where p.id = r.product_id and p.status = 'active')
$$;

create or replace function public._mkt_published_json(p_t text, p_id text, p_viewer text) returns jsonb
language sql stable security definer set search_path = public as $$
  select case p_t
    when 'rec' then (select public._mkt_rec_json(r, p_viewer) from public.market_recs r where r.id = p_id)
    when 'list' then (select public._mkt_list_json(l, p_viewer) from public.market_lists l where l.id = p_id)
    when 'review' then (select public._mkt_review_json(r, p_viewer) from public.market_reviews r where r.id = substr(p_id, 3)::bigint)
  end
$$;

-- A member's page > Market: their store (the Visit store button) and what they published that the
-- viewer may see. p_tab: recs | lists | reviews.
--   -> { ok: true, store: card | null, counts: { recs, lists, reviews }, items, total } | { ok: false, reason: not_found | tab }
create or replace function public.market_profile(p_owner text, p_member text default '', p_tab text default 'recs',
                                                 p_limit int default 24, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  o public.members; me text; st public.market_stores; lim int := least(greatest(coalesce(p_limit, 24), 1), 60);
  off int := greatest(coalesce(p_offset, 0), 0); v_t text;
begin
  select * into o from public.members where member_id = btrim(coalesce(p_owner, '')) and lower(btrim(coalesce(status, ''))) = 'active';
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  v_t := case p_tab when 'recs' then 'rec' when 'lists' then 'list' when 'reviews' then 'review' end;
  if v_t is null then return jsonb_build_object('ok', false, 'reason', 'tab'); end if;
  me := coalesce((public._mkt_member(p_member)).member_id, '');
  select * into st from public.market_stores where owner_id = o.member_id;
  return jsonb_build_object('ok', true,
    'store', case when st.id is not null and (not st.suspended or me = o.member_id) then public._mkt_store_card(st) end,
    'counts', (select jsonb_build_object('recs', count(*) filter (where x.t = 'rec'), 'lists', count(*) filter (where x.t = 'list'),
                                         'reviews', count(*) filter (where x.t = 'review'))
                 from public._mkt_published(array[o.member_id], me) x),
    'total', (select count(*) from public._mkt_published(array[o.member_id], me) x where x.t = v_t),
    'items', coalesce((select jsonb_agg(public._mkt_published_json(x.t, x.id, me) order by x.at desc, x.id desc)
                         from (select * from public._mkt_published(array[o.member_id], me) y where y.t = v_t
                                order by y.at desc, y.id desc limit lim offset off) x), '[]'::jsonb));
end $$;

-- Profile > Updates: what the members you follow recommended (or recommended again), the purchase
-- lists they made and their reviews, that you may see; newest first, p_limit at a time
-- (p_before / p_before_id: the date and id of the last one shown).
--   -> { ok: true, items: [rec | list | review (+ feed_id)], more } | { ok: false, reason: member }
create or replace function public.market_feed(p_member text, p_limit int default 20, p_before timestamptz default null,
                                              p_before_id text default '')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare m public.members; lim int := least(greatest(coalesce(p_limit, 20), 1), 50); fol text[]; items jsonb; n int;
begin
  m := public._mkt_member(p_member);
  if m.member_id is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  -- the members you follow, but when one blocked the other (as Profile > Updates does for videos):
  -- they blocked you fully or from their updates, or you blocked them fully
  select coalesce(array_agg(f.following_id), '{}') into fol from public.follows f
   where f.follower_id = m.member_id and f.status = 'accepted'
     and not exists (select 1 from public.blocks b
                      where (b.blocker_id = f.following_id and b.blocked_id = m.member_id
                             and (b.kind = 'full' or 'updates' = any (string_to_array(replace(coalesce(b.features, ''), ' ', ''), ','))))
                         or (b.blocker_id = m.member_id and b.blocked_id = f.following_id and b.kind = 'full'));
  -- feed_id: what p_before_id takes for the next ones
  select coalesce(jsonb_agg(public._mkt_published_json(x.t, x.id, m.member_id) || jsonb_build_object('feed_id', x.id)
                            order by x.at desc, x.id desc), '[]'::jsonb), count(*)
    into items, n
    from (select * from public._mkt_published(fol, m.member_id) y
           where p_before is null or (y.at, y.id) < (p_before, coalesce(p_before_id, ''))
           order by y.at desc, y.id desc limit lim + 1) x;
  if n > lim then items := items - lim; end if;
  return jsonb_build_object('ok', true, 'items', items, 'more', n > lim);
end $$;

drop function if exists public.market_review_save(text, text, jsonb, jsonb);   -- the first version: one review per order

-- ------------------------------------------------------------------ 14. who may call what
do $$
declare f text;
begin
  foreach f in array array[
    'public._mkt_member(text)', 'public._mkt_blocked(text, boolean)', 'public._mkt_card(public.market_products)',
    'public._mkt_store_card(public.market_stores)', 'public._mkt_notify(text, text, text, text, text, text)',
    'public._mkt_spend(text, int, text)', 'public._mkt_refund(public.market_orders)', 'public._mkt_credit(text, int, boolean)',
    'public._mkt_settle(int)', 'public.market_settle()', 'public._mkt_order_json(public.market_orders, text)',
    'public._mkt_seller_gets(public.market_orders)', 'public._mkt_ensure_store(public.members)', 'public._guard_market_points()',
    'public._mkt_tier_points()', 'public._mkt_after_sale(text)', 'public._mkt_staff(text)', 'public._mkt_report_json(public.market_reports)',
    'public._mkt_sees(text, text, boolean, boolean, text, text[], text)', 'public._mkt_audience(jsonb, text)',
    'public._mkt_audience_out(text, boolean, boolean, text, text[])', 'public._mkt_review_counts(text)',
    'public._mkt_review_json(public.market_reviews, text)', 'public._mkt_list_json(public.market_lists, text)',
    'public._mkt_rec_json(public.market_recs, text)', 'public._mkt_root_of(text, text)', 'public._mkt_published(text[], text)',
    'public._mkt_published_json(text, text, text)']
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
    'public.market_orders(text, text, text, int, int)', 'public.market_review_save(text, text, jsonb, jsonb, jsonb)',
    'public.market_review_delete(text, text)', 'public.market_list_save(text, jsonb)', 'public.market_list_delete(text, text)',
    'public.market_list_item(text, text, text, boolean)', 'public.market_lists_mine(text, text)', 'public.market_list(text, text)',
    'public.market_rec_save(text, text, jsonb)', 'public.market_rec_share(text, text, text, jsonb)', 'public.market_rec_delete(text, text)',
    'public.market_profile(text, text, text, int, int)', 'public.market_feed(text, int, timestamptz, text)',
    'public.market_reviews(text, text, int, int)', 'public.market_request_send(text, text, text, text, text)',
    'public.market_request_reply(text, bigint, text)', 'public.market_request_close(text, bigint)',
    'public.market_requests(text, text, int, int)', 'public.market_order_address(text, text, jsonb, boolean)',
    'public.market_address(text)', 'public.market_address_save(text, jsonb)', 'public.market_report(text, text, text, text, text)',
    'public.market_reports_admin(text, text, int)', 'public.market_reports_count(text)',
    'public.market_reports_set(text, bigint[], text)', 'public.market_reports_delete(text, bigint[])',
    'public.market_moderate(text, text, text, text, text)']
  loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;
revoke all on function public._points(text) from public, anon, authenticated;

notify pgrst, 'reload schema';
