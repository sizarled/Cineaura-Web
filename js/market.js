/* CineAura — Market.html: the members' market (sql/market.sql).
 *
 * Unlike Prize.html (published by the staff), members sell here, for points:
 *
 *   Market.html                    the search box (products, categories, stores) and its filters
 *                                  (newest / oldest, country, physical / digital), then the trending
 *                                  products and the 5 best-selling categories (20 products each) —
 *                                  worldwide for guests, in the member's country once signed in
 *   Market.html?q=…&type=…        a search: products | stores | categories (&sort=new|old&country=&kind=)
 *   Market.html?Categories=<id>    the products of a category, with a search box inside it
 *   Market.html?Store=<id>         a store
 *   Market.html?Product=<id>       a product (…&@username: the share link of a member, who earns the
 *                                  commission its seller chose, up to 25% of the price of a sale
 *                                  made through it — shared equally with the member who first
 *                                  recommended it when that member recommended it again). Its page
 *                                  also recommends it, adds it to a purchase list, reviews it.
 *   Market.html?List=<id>          a purchase list (…&@username: who brings the sale of its products)
 *   Market.html#sales/requests …   the side menu of the member: points (+ add points), notifications,
 *                                  your sales (products, sale requests, sold, shipped, delivered,
 *                                  returned), your purchases (buy later, purchase requests, purchased,
 *                                  shipped, received, returned), your rating (given / received),
 *                                  your requests (sent / received) and the store settings
 *
 * The pieces (cards, dialogs, forms) are in js/market-forms.js.
 */
(() => {
  "use strict";
  const C = window.CineAura;
  const M = window.CineAuraMarket;
  const { t, escapeHtml: esc } = C;
  const { ICON } = M;

  const PAGE = 24;
  const SECTIONS = {
    notifications: [],
    sales: ["products", "requests", "sold", "shipped", "delivered", "returned"],
    purchases: ["later", "requests", "purchased", "shipped", "received", "returned"],
    ratings: ["purchases", "sales"],
    requests: ["sent", "received"],
    settings: [],
  };
  const TYPES = ["products", "stores", "categories"];
  const SORTS = ["new", "old"];
  const KINDS = ["", "physical", "digital"];
  const REF_KEY = "cineaura_market_ref";
  const REF_DAYS = 30;

  const state = {
    me: null, // market_me()
    meDone: false,
    points: null,
    route: { view: "home" },
    seq: 0,
    list: null, // { args, items, total, type } of the list on screen
    product: null, // market_product() of the product on screen
  };
  const $ = (s, r = document) => r.querySelector(s);
  const main = () => $("#mkt-main");
  const signedIn = () => Boolean(M.memberId());

  const svgNav = (body) =>
    `<svg class="nav-ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
  const NAV_ICON = {
    notifications: svgNav('<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>'),
    sales: svgNav('<path d="M3.5 9.5l1.5-5h14l1.5 5"/><path d="M4.5 9.5v10h15v-10"/><path d="M3.5 9.5a2.8 2.8 0 0 0 5.6 0 2.8 2.8 0 0 0 5.6 0 2.8 2.8 0 0 0 5.6 0"/>'),
    purchases: svgNav('<path d="M5 8h14l-1.2 11.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>'),
    ratings: svgNav('<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>'),
    requests: svgNav('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8M8 12.5h5"/>'),
    published: svgNav('<path d="M7 10.5v9H4v-9z"/><path d="M7 10.5l3.6-6.3a1.9 1.9 0 0 1 3.4 1.3l-.5 3.5h5a2 2 0 0 1 2 2.3l-1.1 6.4a2 2 0 0 1-2 1.8H7"/>'),
    settings: svgNav('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  };

  // ---------------------------------------------------------------- address
  // Market.html?Product=… and ?product=… both work
  function param(name) {
    const want = name.toLowerCase();
    for (const [k, v] of new URLSearchParams(location.search)) if (k.toLowerCase() === want) return v;
    return null;
  }

  function readRefs() {
    try {
      const m = JSON.parse(localStorage.getItem(REF_KEY) || "{}");
      return m && typeof m === "object" ? m : {};
    } catch {
      return {};
    }
  }
  // Market.html?Product=PRD…&@alice: alice shared it. Kept for 30 days for that product.
  function captureRef() {
    const id = (param("Product") || "").trim();
    if (!id) return;
    for (const [k] of new URLSearchParams(location.search)) {
      if (!k.startsWith("@") || k.length < 2) continue;
      const u = k.slice(1).trim();
      if (!/^[^\s&=#?/<>"']{1,40}$/.test(u)) continue;
      const refs = readRefs();
      refs[id] = { u, ts: Date.now() };
      // forget the old ones
      Object.keys(refs).forEach((key) => {
        if (Date.now() - Number(refs[key]?.ts || 0) > REF_DAYS * 864e5) delete refs[key];
      });
      try {
        localStorage.setItem(REF_KEY, JSON.stringify(refs));
      } catch {
        /* storage unavailable */
      }
    }
  }
  // the @username of the address (a purchase list page: who brings the sale of its products)
  function refParam() {
    for (const [k] of new URLSearchParams(location.search)) {
      if (k.startsWith("@") && /^[^\s&=#?/<>"']{1,40}$/.test(k.slice(1).trim())) return k.slice(1).trim();
    }
    return "";
  }
  function refFor(id) {
    const r = readRefs()[id];
    if (!r || Date.now() - Number(r.ts || 0) > REF_DAYS * 864e5) return "";
    return String(r.u || "").toLowerCase() === M.username().toLowerCase() ? "" : r.u;
  }

  function parseRoute() {
    let hash = "";
    try {
      hash = decodeURIComponent(location.hash.replace(/^#/, ""));
    } catch {
      hash = "";
    }
    const [sec, tab] = hash.split("/");
    if (Object.prototype.hasOwnProperty.call(SECTIONS, sec)) {
      const tabs = SECTIONS[sec];
      return { view: "panel", section: sec, tab: tabs.includes(tab) ? tab : tabs[0] || "" };
    }
    const product = (param("Product") || "").trim();
    if (product) return { view: "product", id: product };
    const list = (param("List") || "").trim();
    if (list) return { view: "list", id: list, ref: refParam() };
    const sort = SORTS.includes(param("sort")) ? param("sort") : "new";
    const cc = String(param("country") || "").toUpperCase();
    const filters = {
      q: String(param("q") || "").trim().slice(0, 100),
      sort,
      country: /^[A-Z]{2}$/.test(cc) ? cc : "",
      kind: KINDS.includes(param("kind") || "") ? param("kind") || "" : "",
    };
    const cat = (param("Categories") || "").trim();
    if (cat) return { view: "category", id: cat, ...filters };
    const store = (param("Store") || "").trim();
    if (store) return { view: "store", id: store };
    const type = TYPES.includes(param("type")) ? param("type") : "products";
    if (filters.q || param("type") || filters.country || filters.kind || param("sort")) return { view: "search", type, ...filters };
    return { view: "home" };
  }

  function searchHref(f) {
    const q = new URLSearchParams();
    if (f.q) q.set("q", f.q);
    if (f.type && f.type !== "products") q.set("type", f.type);
    if (f.sort && f.sort !== "new") q.set("sort", f.sort);
    if (f.country) q.set("country", f.country);
    if (f.kind && f.type !== "stores") q.set("kind", f.kind);
    if (![...q.keys()].length) q.set("type", "products");
    return `./Market.html?${q}`;
  }
  function categoryHref(id, f = {}) {
    const q = new URLSearchParams({ Categories: id });
    if (f.q) q.set("q", f.q);
    if (f.sort && f.sort !== "new") q.set("sort", f.sort);
    if (f.country) q.set("country", f.country);
    if (f.kind) q.set("kind", f.kind);
    return `./Market.html?${q}`;
  }

  function go(href, { replace = false } = {}) {
    const url = new URL(href, location.href);
    const target = `${url.pathname}${url.search}${url.hash}`;
    if (replace) history.replaceState(null, "", target);
    else if (target !== `${location.pathname}${location.search}${location.hash}`) history.pushState(null, "", target);
    route();
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------- the member
  async function loadMe() {
    if (!signedIn()) {
      state.me = null;
      state.meDone = true;
      return;
    }
    const r = await M.call("market_me", { p_member: M.memberId() });
    state.meDone = true;
    state.me = r.ok && r.data?.ok ? r.data : { ok: false, setup: r.setup, reason: r.data?.reason || "" };
  }
  async function loadPoints() {
    if (!signedIn()) return;
    try {
      const mp = await C.memberPoints(M.memberId(), {});
      state.points = Number(mp?.available) || 0;
    } catch {
      state.points = null;
    }
    const el = $("#mkt-side [data-points]");
    if (el) el.textContent = state.points == null ? "—" : M.pt(state.points);
  }
  // after a sale, a purchase, an action: badges and points again
  async function refreshMe() {
    await loadMe();
    drawSide();
    drawActs();
    loadPoints();
  }

  const badge = (n) => (Number(n) > 0 ? `<span class="crp-badge">${Number(n) > 99 ? "99+" : Number(n)}</span>` : "");

  function drawSide() {
    const side = $("#mkt-side");
    if (!signedIn()) {
      side.innerHTML = `
        <div class="mkt-side-guest">
          <span class="mkt-side-ico">${ICON.bigBag}</span>
          <h2>${esc(t("mkt.guestTitle"))}</h2>
          <p class="muted">${esc(t("mkt.guestText"))}</p>
          <a class="btn btn-sm btn-primary" href="${esc(M.signinHref())}">${esc(t("nav.signin"))}</a>
          <a class="btn btn-sm btn-ghost" href="./register.html">${esc(t("nav.signup"))}</a>
        </div>`;
      return;
    }
    const me = state.me;
    const s = C.getSession() || {};
    const username = me?.member?.username || M.username();
    const id = me?.member?.id || M.memberId();
    const c = me?.counts || {};
    const active = state.route.view === "panel" ? state.route.section : "";
    const items = [
      ["notifications", me?.unread],
      ["sales", (c.sales?.requests || 0) + (c.sales?.returned || 0)],
      ["purchases", c.purchases?.shipped || 0],
      ["ratings", c.reviews?.to_write || 0],
      ["requests", (c.requests?.received || 0) + (c.requests?.sent || 0)],
      ["settings", 0],
    ];
    side.innerHTML = `
      <a class="side-user" href="${esc(M.profileHref(username))}">
        ${C.avatarImg(id, username, s.full_name || username)}
        <strong>@${esc(username)}</strong>
        <span>${esc(id)}</span>
      </a>
      <div class="mkt-points">
        <span class="mkt-points-label">${ICON.coins}<span>${esc(t("mkt.yourPoints"))}</span></span>
        <b data-points dir="ltr">${state.points == null ? "…" : esc(M.pt(state.points))}</b>
        <a class="btn btn-sm btn-primary mkt-add-points" href="./dashboard.html#points">${ICON.plus}<span>${esc(t("mkt.addPoints"))}</span></a>
      </div>
      ${me && me.ok === false ? `<p class="muted mkt-side-note">${esc(t(me.setup ? "mkt.setupText" : "mkt.err.member"))}</p>` : ""}
      <nav class="side-nav mkt-nav" aria-label="${esc(t("mkt.yourMarket"))}">
        ${items.map(([k, n]) => `<button type="button" data-panel="${k}" class="${active === k ? "active" : ""}" ${active === k ? 'aria-current="page"' : ""}>${NAV_ICON[k]}<span>${esc(t(`mkt.nav.${k}`))}</span>${badge(n)}</button>`).join("")}
        <a class="mkt-nav-link" href="${esc(M.profileMarketHref(username))}">${NAV_ICON.published}<span>${esc(t("mkt.nav.published"))}</span></a>
      </nav>`;
    C.hydrateAvatars?.(side);
  }

  function drawActs() {
    const box = $("#mkt-acts");
    if (!signedIn()) {
      box.innerHTML = `<a class="btn btn-sm btn-primary" href="${esc(M.signinHref("Market.html#sales/products"))}">${ICON.plus}<span>${esc(t("mkt.signinSell"))}</span></a>`;
      return;
    }
    const store = state.me?.store;
    box.innerHTML = `
      <button class="btn btn-sm btn-primary" type="button" data-sell>${ICON.plus}<span>${esc(t("mkt.sell"))}</span></button>
      ${store ? `<a class="btn btn-sm btn-ghost mkt-your-store" href="${esc(M.storeHref(store.id))}" data-nav>${ICON.store}<span>${esc(t("mkt.yourStore"))}</span>${M.tierHtml(store.tier)}</a>`
        : `<a class="btn btn-sm btn-ghost" href="#settings" data-panel-link="settings">${ICON.store}<span>${esc(t("mkt.openStore"))}</span></a>`}`;
  }

  // ---------------------------------------------------------------- the tools under the search box
  function countryOptions(sel) {
    return `<option value="">${esc(t("mkt.allCountries"))}</option>${C.countryChoices()
      .map(([code, name]) => `<option value="${code}" ${code === sel ? "selected" : ""}>${esc(name)}</option>`)
      .join("")}`;
  }
  function filtersHtml(f, { tabs = true, kind = true } = {}) {
    return `
      ${tabs ? `<div class="follow-tabs mkt-types" role="tablist" aria-label="${esc(t("mkt.searchIn"))}">${TYPES.map((k) => {
        const on = state.route.view === "search" && f.type === k;
        return `<button type="button" role="tab" class="follow-tab${on ? " active" : ""}" data-type="${k}" aria-selected="${on}">${esc(t(`mkt.type.${k}`))}</button>`;
      }).join("")}</div>` : ""}
      <div class="mkt-filters">
        <label class="vs-filter"><span>${esc(t("vid.sortBy"))}</span>
          <select data-f="sort">${SORTS.map((s) => `<option value="${s}" ${f.sort === s ? "selected" : ""}>${esc(t(`mkt.sort.${s}`))}</option>`).join("")}</select></label>
        <label class="vs-filter"><span>${esc(t("mkt.country"))}</span>
          <select data-f="country">${countryOptions(f.country || "")}</select></label>
        ${kind ? `<label class="vs-filter"><span>${esc(t("mkt.kind"))}</span>
          <select data-f="kind">${KINDS.map((k) => `<option value="${k}" ${f.kind === k ? "selected" : ""}>${esc(t(`mkt.kind.${k || "all"}`))}</option>`).join("")}</select></label>` : ""}
      </div>`;
  }

  function drawTools() {
    const r = state.route;
    const tools = $("#mkt-tools");
    const q = $("#mkt-q");
    if (r.view === "home" || r.view === "search") {
      const f = r.view === "search" ? r : { type: "products", sort: "new", country: "", kind: "" };
      tools.innerHTML = filtersHtml(f, { kind: f.type !== "stores" });
      tools.hidden = false;
    } else {
      tools.innerHTML = "";
      tools.hidden = true;
    }
    q.value = r.view === "search" ? r.q : "";
  }

  // ---------------------------------------------------------------- shared markup
  const loadingHtml = () => `<div class="mkt-loading glass"><span class="mkt-spin" aria-hidden="true"></span><span>${esc(t("common.loading"))}</span></div>`;
  function failHtml(res) {
    return `<div class="vs-none glass"><h2>${esc(t(res?.setup ? "mkt.setupTitle" : "mkt.loadFail"))}</h2><p class="muted">${esc(res?.setup ? t("mkt.setupText") : t("mkt.loadFailText"))}</p></div>`;
  }
  const rowHtml = (items) => `
    <div class="mkt-row" data-row>
      <button class="mkt-row-go prev" type="button" data-row-go="-1" aria-label="${esc(t("mkt.prev"))}">${ICON.left}</button>
      <div class="mkt-row-track" data-row-track>${items.map(M.cardHtml).join("")}</div>
      <button class="mkt-row-go next" type="button" data-row-go="1" aria-label="${esc(t("mkt.next"))}">${ICON.right}</button>
    </div>`;
  function gridHtml(type, items) {
    if (type === "stores") return `<div class="mkt-grid mkt-grid-stores">${items.map(M.storeCardHtml).join("")}</div>`;
    if (type === "categories") return `<div class="mkt-grid mkt-grid-cats">${items.map(M.categoryCardHtml).join("")}</div>`;
    return `<div class="mkt-grid">${items.map(M.cardHtml).join("")}</div>`;
  }
  const countText = (type, n) => {
    const one = Number(n) === 1;
    if (type === "stores") return t(one ? "mkt.storesOne" : "mkt.storesN", { n: M.fmt(n) });
    if (type === "categories") return t(one ? "mkt.catsOne" : "mkt.catsN", { n: M.fmt(n) });
    return t(one ? "mkt.productsOne" : "mkt.productsN", { n: M.fmt(n) });
  };
  // text with line breaks and links (http/https only)
  function richText(v) {
    return esc(String(v || ""))
      .replace(/https?:\/\/[^\s<>"']+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer nofollow">${u}</a>`)
      .replace(/\n/g, "<br>");
  }
  function sellEmptyHtml(text) {
    const act = signedIn()
      ? `<button class="btn btn-sm btn-primary" type="button" data-sell>${ICON.plus}<span>${esc(t("mkt.sell"))}</span></button>`
      : `<a class="btn btn-sm btn-primary" href="${esc(M.signinHref("Market.html#sales/products"))}">${esc(t("mkt.signinSell"))}</a>`;
    return `<div class="vs-none glass mkt-empty"><span class="mkt-empty-ico">${ICON.bigBag}</span><h2>${esc(t("mkt.noneTitle"))}</h2><p class="muted">${esc(text || t("mkt.noneText"))}</p>${act}</div>`;
  }

  // A list that loads more on demand: products, stores or categories.
  async function loadList(box, args, type, { more = false, emptyText = "" } = {}) {
    const seq = more ? state.seq : ++state.seq;
    if (!more) {
      state.list = { args, type, items: [], total: 0 };
      box.innerHTML = loadingHtml();
    } else {
      box.querySelector("[data-more]")?.setAttribute("disabled", "");
    }
    const r = await M.call("market_search", { ...args, p_limit: PAGE, p_offset: more ? state.list.items.length : 0 });
    if (seq !== state.seq) return;
    if (!r.ok) {
      box.innerHTML = failHtml(r);
      return;
    }
    const items = Array.isArray(r.data?.items) ? r.data.items : [];
    state.list.items = more ? state.list.items.concat(items) : items;
    state.list.total = Number(r.data?.total || 0);
    if (!state.list.items.length) {
      box.innerHTML = type === "products" && !args.p_q ? sellEmptyHtml(emptyText) : `<div class="vs-none glass"><h2>${esc(t("vid.noResults"))}</h2><p class="muted">${esc(emptyText || t("mkt.noResultsText"))}</p></div>`;
      return;
    }
    box.innerHTML = `
      <div class="vs-results-head"><span class="muted">${esc(countText(type, state.list.total))}</span></div>
      ${gridHtml(type, state.list.items)}
      ${state.list.items.length < state.list.total ? `<div class="vs-more"><button class="btn btn-lg btn-ghost" type="button" data-more>${esc(t("vid.loadMore"))}</button></div>` : ""}`;
    box.querySelector("[data-more]")?.addEventListener("click", () => loadList(box, args, type, { more: true, emptyText }));
  }

  const searchArgs = (f, extra = {}) => ({
    p_member: M.memberId(),
    p_q: f.q || "",
    p_type: f.type || "products",
    p_sort: f.sort || "new",
    p_country: f.country || "",
    p_kind: f.type === "stores" ? "" : f.kind || "",
    p_category: "",
    p_store: "",
    ...extra,
  });

  // ---------------------------------------------------------------- views
  async function drawHome() {
    document.title = t("mkt.pageTitle");
    const seq = ++state.seq;
    const box = main();
    box.innerHTML = loadingHtml();
    const r = await M.call("market_home", { p_member: M.memberId() });
    if (seq !== state.seq) return;
    if (!r.ok) {
      box.innerHTML = failHtml(r);
      return;
    }
    const d = r.data || {};
    const trending = Array.isArray(d.trending) ? d.trending : [];
    const cats = Array.isArray(d.categories) ? d.categories : [];
    const where = d.country ? M.country(d.country) : "";
    if (!trending.length && !cats.length) {
      box.innerHTML = sellEmptyHtml(where ? t("mkt.noneHere", { country: where }) : "");
      return;
    }
    box.innerHTML = `
      <section class="mkt-sec">
        <div class="mkt-sec-head">
          <h2>${esc(where ? t("mkt.trendingIn", { country: where }) : t("mkt.trendingWorld"))}</h2>
          <span class="muted">${esc(t("mkt.trendingHint"))}</span>
        </div>
        ${rowHtml(trending)}
      </section>
      ${cats.length ? `<h2 class="mkt-h2">${esc(where ? t("mkt.topCatsIn", { country: where }) : t("mkt.topCats"))}</h2>` : ""}
      ${cats.map((c) => `
        <section class="mkt-sec">
          <div class="mkt-sec-head">
            <h3><a href="${esc(M.categoryHref(c.id))}" data-nav dir="auto">${esc(c.name)}</a></h3>
            <a class="mkt-see" href="${esc(M.categoryHref(c.id))}" data-nav>${esc(t("mkt.seeAll"))}</a>
          </div>
          ${rowHtml(Array.isArray(c.products) ? c.products : [])}
        </section>`).join("")}`;
  }

  async function drawSearch(r) {
    document.title = `${r.q ? `${r.q} — ` : ""}${t("mkt.pageTitle")}`;
    const box = main();
    box.innerHTML = `
      <div class="mkt-sec-head mkt-results-title"><h2>${esc(r.q ? t("vid.resultsFor", { q: r.q }) : t(`mkt.all.${r.type}`))}</h2></div>
      <div data-list></div>`;
    loadList(box.querySelector("[data-list]"), searchArgs(r), r.type);
  }

  async function drawCategory(r) {
    const seq = ++state.seq;
    const box = main();
    box.innerHTML = loadingHtml();
    const c = await M.call("market_category", { p_id: r.id });
    if (seq !== state.seq) return;
    if (!c.ok) {
      box.innerHTML = failHtml(c);
      return;
    }
    if (!c.data?.ok) {
      box.innerHTML = `<div class="vs-none glass"><h2>${esc(t("mkt.catGone"))}</h2><p><a class="btn btn-sm btn-primary" href="./Market.html" data-nav>${esc(t("mkt.backToMarket"))}</a></p></div>`;
      return;
    }
    const cat = c.data.category;
    document.title = `${cat.name} — ${t("mkt.pageTitle")}`;
    box.innerHTML = `
      <section class="glass mkt-cat-head">
        <nav class="mkt-crumbs" aria-label="${esc(t("mkt.crumbs"))}"><a href="./Market.html" data-nav>${esc(t("mkt.eyebrow"))}</a><span aria-hidden="true">›</span><span>${esc(t("mkt.categories"))}</span></nav>
        <h1 dir="auto">${esc(cat.name)}</h1>
        <form class="vs-searchbar mkt-cat-search" data-cat-form role="search">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.3-4.3"/></svg>
          <input name="q" type="search" dir="auto" autocomplete="off" enterkeyhint="search" value="${esc(r.q)}" placeholder="${esc(t("mkt.searchInCat", { name: cat.name }))}" aria-label="${esc(t("mkt.searchInCat", { name: cat.name }))}" />
          <button class="btn btn-primary" type="submit">${esc(t("nav.search"))}</button>
        </form>
        <div class="mkt-tools mkt-cat-tools" data-cat-tools>${filtersHtml(r, { tabs: false })}</div>
      </section>
      <div data-list></div>`;
    const form = box.querySelector("[data-cat-form]");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      go(categoryHref(r.id, { ...r, q: form.q.value.trim() }));
    });
    box.querySelector("[data-cat-tools]").addEventListener("change", (e) => {
      const k = e.target.dataset.f;
      if (k) go(categoryHref(r.id, { ...r, [k]: e.target.value }));
    });
    loadList(box.querySelector("[data-list]"), searchArgs({ ...r, type: "products" }, { p_category: r.id }), "products", {
      emptyText: r.q ? t("mkt.noResultsText") : t("mkt.catEmpty"),
    });
  }

  // What the team suspended (Panel > Reports > Market), as its seller sees it.
  function suspendedHtml(kind, reason, { withStore = false } = {}) {
    return `
      <div class="mkt-suspended glass" role="status">
        ${ICON.flag}
        <div>
          <b>${esc(t(kind === "store" ? "mkt.susp.store" : withStore ? "mkt.susp.withStore" : "mkt.susp.product"))}</b>
          ${reason ? `<span>${esc(t("mkt.susp.reason"))} <q dir="auto">${esc(reason)}</q></span>` : ""}
          <span class="muted">${esc(t(kind === "store" ? "mkt.susp.storeText" : "mkt.susp.productText"))}</span>
        </div>
      </div>`;
  }

  function storeChips(s) {
    return [
      `<span class="mkt-open ${s.open ? "on" : "off"}">${esc(t(s.open ? "mkt.open" : "mkt.closed"))}</span>`,
      `<span class="mkt-chip">${ICON.globe}${esc(t("mkt.sellsIn", { where: M.reachText(s) }))}</span>`,
      `<span class="mkt-chip">${ICON.cart}${esc(t(s.sale_mode === "request" ? "mkt.sale.request" : "mkt.sale.instant"))}</span>`,
      `<span class="mkt-chip">${ICON.truck}${esc(t(s.shipping ? "mkt.s.shipYes" : "mkt.s.shipNo"))}</span>`,
      `<span class="mkt-chip">${ICON.clock}${esc(s.returns ? t("mkt.returnsDays", { n: s.return_days }) : t("mkt.s.returnsNo"))}</span>`,
    ].join("");
  }

  async function drawStore(r) {
    const seq = ++state.seq;
    const box = main();
    box.innerHTML = loadingHtml();
    const res = await M.call("market_store", { p_id: r.id, p_member: M.memberId() });
    if (seq !== state.seq) return;
    if (!res.ok) {
      box.innerHTML = failHtml(res);
      return;
    }
    if (!res.data?.ok) {
      box.innerHTML = `<div class="vs-none glass"><h2>${esc(t("mkt.storeGone"))}</h2><p><a class="btn btn-sm btn-primary" href="./Market.html" data-nav>${esc(t("mkt.backToMarket"))}</a></p></div>`;
      return;
    }
    const s = res.data.store;
    const own = res.data.own;
    document.title = `${s.name} — ${t("mkt.pageTitle")}`;
    const links = (Array.isArray(s.links) ? s.links : []).filter((l) => /^https?:\/\//i.test(l?.url || ""));
    const reportBtn = signedIn()
      ? `<button class="btn btn-sm btn-ghost mkt-report-btn" type="button" data-report-store>${ICON.flag}<span>${esc(t("mkt.rp.btn"))}</span></button>`
      : `<a class="btn btn-sm btn-ghost mkt-report-btn" href="${esc(M.signinHref())}">${ICON.flag}<span>${esc(t("mkt.rp.btn"))}</span></a>`;
    box.innerHTML = `
      ${own && s.suspended ? suspendedHtml("store", s.suspended_reason) : ""}
      <section class="glass mkt-store-head">
        <div class="mkt-store-banner">${s.cover ? `<img src="${esc(s.cover)}" alt="" />` : ""}</div>
        <div class="mkt-store-id">
          <img class="mkt-store-logo-lg" src="${esc(s.logo || C.initialsAvatar(s.name || "CA"))}" alt="" />
          <div class="mkt-store-title">
            <h1><span dir="auto">${esc(s.name)}</span>${M.tierHtml(s.tier, { big: true })}</h1>
            <p class="muted">${t("mkt.by")} <a href="${esc(M.profileHref(s.owner?.username))}">@${esc(s.owner?.username || "")}</a> · ${ICON.pin} ${esc([s.city, M.country(s.country)].filter(Boolean).join(t("mkt.listSep")))}</p>
          </div>
          <div class="mkt-store-acts">
            ${own ? `<a class="btn btn-sm btn-ghost" href="#settings" data-panel-link="settings">${ICON.edit}<span>${esc(t("mkt.nav.settings"))}</span></a>
                     <button class="btn btn-sm btn-primary" type="button" data-sell>${ICON.plus}<span>${esc(t("mkt.sell"))}</span></button>`
              : signedIn() ? `<button class="btn btn-sm btn-primary" type="button" data-ask-store>${ICON.chat}<span>${esc(t("mkt.rq.itemBtn"))}</span></button>${reportBtn}`
              : `<a class="btn btn-sm btn-ghost" href="${esc(M.signinHref())}">${esc(t("mkt.rq.itemBtn"))}</a>${reportBtn}`}
          </div>
        </div>
        <div class="mkt-chips">${storeChips(s)}</div>
        <div class="mkt-store-stats">
          <span><b>${esc(M.fmt(s.products))}</b> ${esc(t("mkt.statProducts"))}</span>
          <span><b>${esc(M.fmt(s.sales))}</b> ${esc(t("mkt.statSales"))}</span>
          <span class="pro"><b>${esc(M.fmt(s.pros))}</b> ${esc(t("mkt.pros"))}</span>
          <span class="con"><b>${esc(M.fmt(s.cons))}</b> ${esc(t("mkt.cons"))}</span>
        </div>
        ${M.tierBoxHtml(s.tier)}
        ${s.description ? `<div class="mkt-store-desc" dir="auto">${richText(s.description)}</div>` : ""}
        ${links.length ? `<div class="mkt-store-links"><span class="muted">${esc(t("mkt.s.links"))}</span>${links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer nofollow">${ICON.link}<span dir="auto">${esc(l.label || l.url.replace(/^https?:\/\//i, ""))}</span></a>`).join("")}</div>` : ""}
      </section>
      <div class="mkt-sec-head"><h2>${esc(t("mkt.storeProducts"))}</h2></div>
      <div data-list></div>`;
    box.querySelector("[data-ask-store]")?.addEventListener("click", () => M.openRequest({ store: s, kind: "item", onSent: refreshMe }));
    box.querySelector("[data-report-store]")?.addEventListener("click", () => M.openReport({ kind: "store", id: s.id, name: s.name }));
    loadList(box.querySelector("[data-list]"), searchArgs({ type: "products", sort: "new" }, { p_store: s.id }), "products", {
      emptyText: own ? t("mkt.storeEmptyOwn") : t("mkt.storeEmpty"),
    });
  }

  // ---------------------------------------------------------------- the product
  // After Buy now: the tab of Your purchases where the order is (a request, a digital product
  // delivered at once, or bought); after its address: that list again.
  function afterCheckout(o) {
    refreshMe();
    go(`./Market.html#purchases/${o.status === "requested" ? "requests" : o.status === "shipped" ? "shipped" : "purchased"}`);
  }
  function afterAddress() {
    refreshMe();
    if (state.route.view === "panel" && state.route.section === "purchases") route();
  }

  function shipLine(p, s, v) {
    if (p.kind === "digital" && p.download) {
      return { cls: "ok", icon: ICON.download, text: t(s.sale_mode === "request" ? "mkt.ship.downloadAccept" : "mkt.ship.download") };
    }
    if (p.kind === "digital") return { cls: "ok", icon: ICON.cloud, text: t("mkt.ship.digital") };
    if (!s.shipping) return { cls: "", icon: ICON.pin, text: t("mkt.ship.none", { where: M.reachText(s) }) };
    const where = v.country ? M.country(v.country) : "";
    if (v.reach === true) return { cls: "ok", icon: ICON.truck, text: where ? t("mkt.ship.yes", { country: where }) : t("mkt.ship.world") };
    if (v.reach === false) return { cls: "bad", icon: ICON.truck, text: where ? t("mkt.ship.no", { country: where }) : t("mkt.ship.noHere") };
    return { cls: "", icon: ICON.truck, text: t("mkt.ship.within", { where: M.reachText(s) }) };
  }

  function buyBlocker(p, s, v) {
    if (v.own) return "";
    if (p.status !== "active") return t("mkt.hidden");
    if (Number(p.stock) <= 0) return t("mkt.soldOut");
    if (!s.is_open) return t("mkt.storeClosed");
    if (v.member && v.reach === false) return t("mkt.notHere");
    return "";
  }

  function reviewsHtml(d) {
    const pros = [];
    const cons = [];
    (d.reviews || []).forEach((r) => {
      const who = r.author?.username || "";
      const it = { who, at: r.created_at, verified: Boolean(r.verified), vis: r.mine && r.visibility !== "public" ? r.visibility : "" };
      (r.pros || []).forEach((x) => pros.push({ ...it, x }));
      (r.cons || []).forEach((x) => cons.push({ ...it, x }));
    });
    // a member who received the product: a verified purchase; your review not public: its audience
    const tag = (it) =>
      `${it.verified ? ` <span class="mkt-verified" title="${esc(t("mkt.rv.verified"))}">${ICON.verified}<span>${esc(t("mkt.rv.verifiedShort"))}</span></span>` : ""}${it.vis ? ` ${M.visBadge(it.vis)}` : ""}`;
    const col = (list, cls, icon, title, empty) => `
      <div class="mkt-pc-col ${cls}">
        <h3>${icon}<span>${esc(title)}</span><b>${esc(M.fmt(list.length))}</b></h3>
        ${list.length ? `<ul>${list.map((it) => `<li><p dir="auto">${esc(it.x)}</p><small><a href="${esc(M.profileMarketHref(it.who, "reviews"))}">@${esc(it.who)}</a>${tag(it)} · ${esc(M.date(it.at))}</small></li>`).join("")}</ul>` : `<p class="muted">${esc(empty)}</p>`}
      </div>`;
    return `<div class="mkt-pc-cols">
      ${col(pros, "pro", ICON.up, t("mkt.pros"), t("mkt.noPros"))}
      ${col(cons, "con", ICON.down, t("mkt.cons"), t("mkt.noCons"))}
    </div>`;
  }

  // "Share", with the product's share commission when its seller pays one
  function shareLabel(p, v) {
    const pct = Number(p.commission) || 0;
    if (!pct) return t("mkt.share");
    return v.own ? `${t("mkt.share")} · ${t("mkt.commissionN", { pct })}` : t("mkt.shareEarnPct", { pct });
  }

  function productHtml(d) {
    const p = d.product;
    const s = d.store;
    const v = d.viewer || {};
    const imgs = M.images(p);
    const ship = shipLine(p, s, v);
    const block = buyBlocker(p, s, v);
    const request = s.sale_mode === "request";
    const gallery = `
      <div class="mkt-gallery">
        <div class="mkt-slider mkt-gallery-main" data-slider>
          <div class="mkt-slides" data-slides>
            ${imgs.length ? imgs.map((src, i) => `<button class="mkt-slide" type="button" data-zoom="${i}" aria-label="${esc(t("mkt.zoom"))}"><img src="${esc(src)}" alt="${esc(p.title)} ${i + 1}" ${i ? 'loading="lazy"' : ""} /></button>`).join("")
              : `<div class="mkt-slide mkt-slide-empty">${ICON.bigBag}</div>`}
          </div>
          ${imgs.length > 1 ? `
          <button class="mkt-sl mkt-sl-prev" type="button" data-sl="-1" aria-label="${esc(t("mkt.prevPic"))}">${ICON.left}</button>
          <button class="mkt-sl mkt-sl-next" type="button" data-sl="1" aria-label="${esc(t("mkt.nextPic"))}">${ICON.right}</button>
          <span class="mkt-dots" aria-hidden="true">${imgs.map((_, i) => `<i class="${i ? "" : "on"}"></i>`).join("")}</span>` : ""}
          ${imgs.length ? `<span class="mkt-zoom-hint" aria-hidden="true">${ICON.zoom}</span>` : ""}
        </div>
        ${imgs.length > 1 ? `<div class="mkt-thumbs">${imgs.map((src, i) => `<button type="button" data-thumb="${i}" class="${i ? "" : "on"}" aria-label="${esc(t("mkt.photoN", { n: i + 1 }))}"><img src="${esc(src)}" alt="" loading="lazy" /></button>`).join("")}</div>` : ""}
        ${p.video_url ? M.videoHtml(p.video_url) : ""}
      </div>`;
    const buyBtn = v.own
      ? `<button class="btn btn-lg btn-primary" type="button" data-edit-product>${ICON.edit}<span>${esc(t("mkt.editProduct"))}</span></button>`
      : block
        ? `<button class="btn btn-lg btn-primary" type="button" disabled>${esc(block)}</button>`
        : `<button class="btn btn-lg btn-primary" type="button" data-buy>${ICON.cart}<span>${esc(t(request ? "mkt.buyRequest" : "mkt.buyNow"))}</span></button>`;
    return `
      <nav class="mkt-crumbs mkt-pcats" aria-label="${esc(t("mkt.categories"))}">
        <a href="./Market.html" data-nav>${esc(t("mkt.eyebrow"))}</a><span aria-hidden="true">›</span>
        ${(p.categories || []).map((c) => `<a class="mkt-cat-chip" href="${esc(M.categoryHref(c.id))}" data-nav dir="auto">${esc(c.name)}</a>`).join("")}
      </nav>
      <article class="mkt-product">
        ${gallery}
        <div class="glass mkt-pinfo">
          ${p.status === "suspended" ? suspendedHtml("product", p.suspended_reason, { withStore: p.suspended_with_store })
            : p.status !== "active" ? `<p class="mkt-badge b-hidden">${esc(t("mkt.hiddenNote"))}</p>` : ""}
          <h1 class="mkt-ptitle" dir="auto">${esc(p.title)}</h1>
          <div class="mkt-pprice"><b dir="ltr">${esc(M.pt(p.price))}</b><small dir="ltr">≈ ${esc(M.usd(p.price))}</small></div>
          <div class="mkt-pstats">
            <span>${esc(t(Number(p.sales) === 1 ? "mkt.salesOne" : "mkt.salesN", { n: M.fmt(p.sales) }))}</span>
            <span class="${Number(p.stock) > 0 ? "" : "bad"}">${esc(Number(p.stock) > 0 ? t("mkt.leftN", { n: M.fmt(p.stock) }) : t("mkt.soldOut"))}</span>
            <span>${esc(t(p.kind === "digital" ? "mkt.kind.digital" : "mkt.kind.physical"))}</span>
          </div>
          ${Number(d.recs) > 0 ? `<p class="mkt-recs-n">${ICON.thumb}<span>${esc(t(Number(d.recs) === 1 ? "mkt.rc.countOne" : "mkt.rc.countN", { n: M.fmt(d.recs) }))}</span></p>` : ""}
          <p class="mkt-ship ${ship.cls}">${ship.icon}<span>${esc(ship.text)}</span></p>
          ${p.kind !== "digital" && s.shipping ? `<p class="mkt-shipcost">${ICON.truck}<span>${esc(t("mkt.shippingCost"))}: <b dir="ltr">${Number(p.shipping_cost) ? esc(M.pt(p.shipping_cost)) : esc(t("mkt.free"))}</b></span></p>` : ""}
          <div class="mkt-buybox">
            ${buyBtn}
            ${v.own ? "" : `<button class="btn btn-lg btn-ghost" type="button" data-later aria-pressed="${v.saved ? "true" : "false"}">${ICON.clock}<span>${esc(t(v.saved ? "mkt.laterSaved" : "mkt.buyLater"))}</span></button>`}
          </div>
          <p class="muted mkt-pnote">${esc(request ? t("mkt.requestNote") : t("mkt.instantNote"))} ${esc(s.returns ? t("mkt.returnsDays", { n: s.return_days }) : t("mkt.s.returnsNo"))}</p>
          <div class="mkt-pacts mkt-pacts-social">
            ${p.status === "active" ? `<button class="btn btn-sm ${v.my_rec ? "btn-primary" : "btn-ghost"}" type="button" data-recommend aria-pressed="${v.my_rec ? "true" : "false"}">${ICON.thumb}<span>${esc(t(v.my_rec ? "mkt.rc.mine" : "mkt.rc.btn"))}</span></button>
            <button class="btn btn-sm btn-ghost" type="button" data-addlist>${ICON.list}<span>${esc(t("mkt.ls.btn"))}</span></button>` : ""}
            ${v.own ? "" : `<button class="btn btn-sm btn-ghost" type="button" data-review>${ICON.star}<span>${esc(t(v.my_review ? "mkt.act.editReview" : "mkt.act.review"))}</span></button>`}
          </div>
          <div class="mkt-pacts">
            <button class="btn btn-sm btn-ghost" type="button" data-share>${ICON.share}<span>${esc(shareLabel(p, v))}</span></button>
            ${v.own ? "" : `<button class="btn btn-sm btn-ghost" type="button" data-ask>${ICON.chat}<span>${esc(t("mkt.ask"))}</span></button>`}
            ${v.own ? "" : `<button class="btn btn-sm btn-ghost mkt-report-btn" type="button" data-report-product>${ICON.flag}<span>${esc(t("mkt.rp.btn"))}</span></button>`}
          </div>
          <a class="mkt-pstore" href="${esc(M.storeHref(s.id))}" data-nav>
            <img src="${esc(s.logo || C.initialsAvatar(s.name || "CA"))}" alt="" />
            <span><b><span dir="auto">${esc(s.name)}</span>${M.tierHtml(s.tier)}</b><small>@${esc(s.owner?.username || "")} · ${esc(M.reachText(s))}</small></span>
            <span class="mkt-open ${s.open ? "on" : "off"}">${esc(t(s.open ? "mkt.open" : "mkt.closed"))}</span>
          </a>
          <p class="muted mkt-added">${esc(t("mkt.addedOn", { date: M.date(p.created_at) }))} · <a href="${esc(M.profileHref(s.owner?.username))}">@${esc(s.owner?.username || "")}</a></p>
        </div>
      </article>
      <section class="glass mkt-sec mkt-desc">
        <h2>${esc(t("mkt.description"))}</h2>
        ${p.description ? `<div class="mkt-desc-text" dir="auto">${richText(p.description)}</div>` : `<p class="muted">${esc(t("mkt.noDescription"))}</p>`}
      </section>
      <section class="glass mkt-sec mkt-reviews">
        <div class="mkt-sec-head">
          <h2>${esc(t("mkt.reviews"))}</h2>
          ${v.own ? "" : `<button class="btn btn-sm btn-primary" type="button" data-review>${esc(t(v.my_review ? "mkt.act.editReview" : "mkt.act.review"))}</button>`}
        </div>
        <p class="muted">${esc(t("mkt.reviewsHint"))}</p>
        ${reviewsHtml(d)}
      </section>
      <section class="mkt-sec mkt-suggest">
        <div class="mkt-sec-head"><h2>${esc(t("mkt.suggestions"))}</h2></div>
        <div data-suggest>${loadingHtml()}</div>
      </section>`;
  }

  async function drawProduct(r) {
    const seq = ++state.seq;
    const box = main();
    box.innerHTML = loadingHtml();
    const [res, sug] = await Promise.all([
      M.call("market_product", { p_id: r.id, p_member: M.memberId(), p_country: C.currentCountry?.() || "" }),
      M.call("market_suggest", { p_id: r.id, p_limit: 12 }),
    ]);
    if (seq !== state.seq) return;
    if (!res.ok) {
      box.innerHTML = failHtml(res);
      return;
    }
    if (!res.data?.ok) {
      document.title = t("mkt.pageTitle");
      box.innerHTML = `<div class="vs-none glass"><h2>${esc(t("mkt.productGone"))}</h2><p class="muted">${esc(t("mkt.productGoneText"))}</p><p><a class="btn btn-sm btn-primary" href="./Market.html" data-nav>${esc(t("mkt.backToMarket"))}</a></p></div>`;
      return;
    }
    const d = res.data;
    state.product = d;
    document.title = `${d.product.title} — ${t("mkt.pageTitle")}`;
    box.innerHTML = productHtml(d);
    const list = sug.ok && Array.isArray(sug.data) ? sug.data : [];
    box.querySelector("[data-suggest]").innerHTML = list.length
      ? `<div class="mkt-grid">${list.map(M.cardHtml).join("")}</div>`
      : `<p class="muted">${esc(t("mkt.noSuggestions"))}</p>`;
    wireProduct(box, d);
  }

  function wireProduct(box, d) {
    const p = d.product;
    const s = d.store;
    const v = d.viewer || {};
    const imgs = M.images(p);
    const track = box.querySelector(".mkt-gallery-main [data-slides]");
    box.querySelectorAll("[data-zoom]").forEach((b) => b.addEventListener("click", () => M.openZoom(imgs, Number(b.dataset.zoom))));
    box.querySelectorAll("[data-thumb]").forEach((b) =>
      b.addEventListener("click", () => {
        const i = Number(b.dataset.thumb);
        const rtl = getComputedStyle(track).direction === "rtl";
        track.scrollTo({ left: i * track.clientWidth * (rtl ? -1 : 1), behavior: "smooth" });
      })
    );
    track?.addEventListener("scroll", () => {
      const i = Math.round(Math.abs(track.scrollLeft) / Math.max(1, track.clientWidth));
      box.querySelectorAll("[data-thumb]").forEach((b, k) => b.classList.toggle("on", k === i));
    });
    const needSignin = () => {
      location.href = M.signinHref(`Market.html?Product=${encodeURIComponent(p.id)}`);
    };
    box.querySelector("[data-buy]")?.addEventListener("click", () => {
      if (!signedIn()) return needSignin();
      M.openCheckout({
        product: p,
        store: s,
        ref: refFor(p.id),
        onDone: afterCheckout,
        onAddress: afterAddress,
      });
    });
    box.querySelector("[data-later]")?.addEventListener("click", async (e) => {
      if (!signedIn()) return needSignin();
      const btn = e.currentTarget;
      const on = btn.getAttribute("aria-pressed") !== "true";
      btn.disabled = true;
      const r = await M.call("market_later", { p_member: M.memberId(), p_product: p.id, p_on: on });
      btn.disabled = false;
      if (!r.ok || !r.data?.ok) return C.toast(M.failText(r));
      btn.setAttribute("aria-pressed", String(r.data.saved));
      btn.querySelector("span").textContent = t(r.data.saved ? "mkt.laterSaved" : "mkt.buyLater");
      C.toast(t(r.data.saved ? "mkt.laterAdded" : "mkt.laterRemoved"));
      refreshMe();
    });
    box.querySelector("[data-share]")?.addEventListener("click", () => M.openShare({ product: p, own: Boolean(v.own) }));
    box.querySelector("[data-report-product]")?.addEventListener("click", () => {
      if (!signedIn()) return needSignin();
      M.openReport({ kind: "product", id: p.id, name: p.title });
    });
    box.querySelector("[data-ask]")?.addEventListener("click", () => {
      if (!signedIn()) return needSignin();
      M.openRequest({ store: s, product: p, kind: "question" });
    });
    // any member but the seller reviews it (a buyer who received it: a verified purchase)
    box.querySelectorAll("[data-review]").forEach((b) =>
      b.addEventListener("click", () => {
        if (!signedIn()) return needSignin();
        M.openReview({ product: p, review: v.my_review, onSaved: () => route() });
      })
    );
    box.querySelector("[data-recommend]")?.addEventListener("click", () => {
      if (!signedIn()) return needSignin();
      M.openRecommend({ product: p, rec: v.my_rec, onSaved: () => route() });
    });
    box.querySelector("[data-addlist]")?.addEventListener("click", () => {
      if (!signedIn()) return needSignin();
      M.openListPicker({ product: p });
    });
    box.querySelector("[data-edit-product]")?.addEventListener("click", () =>
      M.openProductForm({ product: { ...p, categories: p.categories }, store: s, onSaved: () => route() })
    );
  }

  // ---------------------------------------------------------------- a purchase list
  // Market.html?List=<id>&@ref: its products on sale; their links carry ref (else its author), who
  // brings the sale. Its author changes it, takes products out; another member recommends it again.
  async function drawList(r) {
    const seq = ++state.seq;
    const box = main();
    box.innerHTML = loadingHtml();
    const res = await M.call("market_list", { p_list: r.id, p_member: M.memberId() });
    if (seq !== state.seq) return;
    if (!res.ok) {
      box.innerHTML = failHtml(res);
      return;
    }
    if (!res.data?.ok) {
      document.title = t("mkt.pageTitle");
      box.innerHTML = `<div class="vs-none glass"><h2>${esc(t("mkt.ls.gone"))}</h2><p class="muted">${esc(t("mkt.ls.goneText"))}</p><p><a class="btn btn-sm btn-primary" href="./Market.html" data-nav>${esc(t("mkt.backToMarket"))}</a></p></div>`;
      return;
    }
    const l = res.data.list;
    const items = res.data.items || [];
    const author = l.author?.username || "";
    const ref = r.ref && r.ref.toLowerCase() !== M.username().toLowerCase() ? r.ref : author;
    document.title = `${l.name} — ${t("mkt.pageTitle")}`;
    const imgs = (Array.isArray(l.images) ? l.images : []).filter(Boolean).slice(0, 4);
    box.innerHTML = `
      <nav class="mkt-crumbs" aria-label="${esc(t("mkt.ls.eyebrow"))}">
        <a href="./Market.html" data-nav>${esc(t("mkt.eyebrow"))}</a><span aria-hidden="true">›</span>
        <a href="${esc(M.profileMarketHref(author, "lists"))}">@${esc(author)}</a><span aria-hidden="true">›</span>
        <span>${esc(t("mkt.ls.eyebrow"))}</span>
      </nav>
      <section class="glass mkt-lhead">
        <span class="mkt-cat-mosaic n${imgs.length}">${imgs.length ? imgs.map((src) => `<img src="${esc(src)}" alt="" />`).join("") : ICON.list}</span>
        <div class="mkt-lhead-body">
          <span class="eyebrow">${ICON.list}<span>${esc(t("mkt.ls.eyebrow"))}</span></span>
          <h1 dir="auto">${esc(l.name)}</h1>
          ${l.description ? `<p class="mkt-lhead-desc" dir="auto">${esc(l.description)}</p>` : ""}
          <p class="mkt-lhead-meta">
            <a class="mkt-lhead-author" href="${esc(M.profileMarketHref(author, "lists"))}">${C.avatarImg(l.author?.id, author, author)}<b>@${esc(author)}</b></a>
            <span>${esc(t(Number(l.count) === 1 ? "mkt.productsOne" : "mkt.productsN", { n: M.fmt(l.count) }))}</span>
            <span>${esc(t("mkt.ls.updated", { date: M.date(l.updated_at) }))}</span>
            ${Number(l.shares) > 0 ? `<span>${ICON.repost}${esc(t(Number(l.shares) === 1 ? "mkt.rc.sharesOne" : "mkt.rc.sharesN", { n: M.fmt(l.shares) }))}</span>` : ""}
            ${l.mine ? M.visBadge(l.visibility) : ""}
          </p>
          <div class="mkt-lhead-acts">
            ${l.can_share ? `<button class="btn btn-sm btn-primary" type="button" data-l-reshare>${ICON.repost}<span>${esc(t("mkt.rs.btn"))}</span></button>` : ""}
            ${l.my_share ? `<span class="mkt-mi-done">${ICON.check}<span>${esc(t("mkt.rs.done"))}</span></span>` : ""}
            ${l.mine ? `<button class="btn btn-sm btn-ghost" type="button" data-l-edit>${ICON.edit}<span>${esc(t("mkt.edit"))}</span></button>` : ""}
            ${l.mine || l.my_share ? `<button class="btn btn-sm btn-ghost" type="button" data-l-copy>${ICON.link}<span>${esc(t("mkt.copyLink"))}</span></button>` : ""}
          </div>
        </div>
      </section>
      <section class="mkt-sec">
        ${items.length ? `<div class="mkt-grid">${items.map((p) => M.cardHtml(p, { ref, remove: l.mine })).join("")}</div>`
          : `<div class="vs-none glass"><p class="muted">${esc(t(l.mine ? "mkt.ls.emptyMine" : "mkt.ls.empty"))}</p></div>`}
      </section>`;
    C.hydrateAvatars?.(box);
    box.querySelector("[data-l-reshare]")?.addEventListener("click", () => {
      if (!signedIn()) return (location.href = M.signinHref());
      M.openReshare({ kind: "list", item: l, onSaved: () => route() });
    });
    box.querySelector("[data-l-edit]")?.addEventListener("click", () =>
      M.openListForm({ list: l, onSaved: (d) => (d ? route() : go(M.profileMarketHref(M.username(), "lists"))) })
    );
    box.querySelector("[data-l-copy]")?.addEventListener("click", async () => {
      const href = M.absolute(M.listHref(l.id, M.username()));
      try {
        await navigator.clipboard.writeText(href);
        C.toast(t("mkt.copied"));
      } catch {
        window.prompt(t("mkt.shareLink"), href);
      }
    });
    box.querySelectorAll("[data-card-remove]").forEach((b) =>
      b.addEventListener("click", async (e) => {
        e.preventDefault();
        b.disabled = true;
        const res2 = await M.call("market_list_item", { p_member: M.memberId(), p_list: l.id, p_product: b.dataset.cardRemove, p_on: false });
        if (!res2.ok || !res2.data?.ok) {
          b.disabled = false;
          return C.toast(M.failText(res2));
        }
        C.toast(t("mkt.ls.removed"));
        route();
      })
    );
  }

  // ---------------------------------------------------------------- the member's panels
  function panelShell(r, body, { tabs = true, extra = "" } = {}) {
    const list = SECTIONS[r.section];
    const counts = tabCounts(r.section);
    return `
      <section class="glass mkt-panel">
        <div class="mkt-panel-head">
          <h1>${NAV_ICON[r.section]}<span>${esc(t(`mkt.nav.${r.section}`))}</span></h1>
          ${extra}
        </div>
        ${tabs && list.length ? `<div class="follow-tabs mkt-tabs" role="tablist">${list.map((k) => {
          const on = r.tab === k;
          return `<button type="button" role="tab" class="follow-tab${on ? " active" : ""}" data-tab="${k}" aria-selected="${on}">${esc(t(`mkt.tab.${r.section}.${k}`))}${counts[k] ? ` <span class="follow-count">${esc(M.fmt(counts[k]))}</span>` : ""}</button>`;
        }).join("")}</div>` : ""}
        <div class="mkt-panel-body" data-panel-body>${body}</div>
      </section>`;
  }

  function tabCounts(section) {
    const c = state.me?.counts || {};
    if (section === "sales") return { products: c.products, ...(c.sales || {}) };
    if (section === "purchases") return { ...(c.purchases || {}) };
    if (section === "ratings") return { purchases: c.reviews?.to_write, sales: c.reviews?.received };
    if (section === "requests") return { sent: c.requests?.sent, received: c.requests?.received };
    return {};
  }

  async function drawPanel(r) {
    document.title = `${t(`mkt.nav.${r.section}`)} — ${t("mkt.pageTitle")}`;
    const box = main();
    if (!signedIn()) {
      box.innerHTML = `<div class="vs-none glass"><h2>${esc(t("mkt.guestTitle"))}</h2><p class="muted">${esc(t("mkt.guestText"))}</p><p><a class="btn btn-sm btn-primary" href="${esc(M.signinHref(`Market.html#${r.section}${r.tab ? `/${r.tab}` : ""}`))}">${esc(t("nav.signin"))}</a></p></div>`;
      return;
    }
    if (r.section === "settings") return drawSettings(r);
    if (r.section === "notifications") return drawNotifications(r);
    const extra = r.section === "sales" ? `<button class="btn btn-sm btn-primary" type="button" data-sell>${ICON.plus}<span>${esc(t("mkt.addProduct"))}</span></button>` : "";
    box.innerHTML = panelShell(r, loadingHtml(), { extra });
    const body = box.querySelector("[data-panel-body]");
    if (r.section === "sales" && r.tab === "products") return loadMyProducts(body);
    if (r.section === "sales" || r.section === "purchases") return loadOrders(body, r);
    if (r.section === "ratings") return loadReviews(body, r);
    if (r.section === "requests") return loadRequests(body, r);
  }

  // a list in a panel, page after page: fetch(offset) -> { ok, total, items }
  async function pagedList(body, fetch, render, { empty, before = "" } = {}) {
    const seq = ++state.seq;
    let items = [];
    let total = 0;
    const paint = () => {
      body.innerHTML = `
        ${typeof before === "function" ? before() : before}
        ${items.length ? render(items) : `<p class="mkt-panel-empty muted">${esc(empty)}</p>`}
        ${items.length < total ? `<div class="vs-more"><button class="btn btn-ghost" type="button" data-more>${esc(t("vid.loadMore"))}</button></div>` : ""}`;
      C.hydrateAvatars?.(body);
      body.querySelector("[data-more]")?.addEventListener("click", more);
    };
    async function more() {
      body.querySelector("[data-more]")?.setAttribute("disabled", "");
      const r = await fetch(items.length);
      if (seq !== state.seq) return;
      if (!r.ok || r.data?.ok === false) {
        body.innerHTML = r.ok ? `<p class="mkt-panel-empty muted">${esc(M.errText(r.data))}</p>` : failHtml(r);
        return;
      }
      items = items.concat(Array.isArray(r.data?.items) ? r.data.items : []);
      total = Number(r.data?.total || 0);
      paint();
    }
    await more();
    return () => items;
  }

  // --- Your sales > Products
  function myProductHtml(p) {
    const img = M.images(p)[0];
    const suspended = p.status === "suspended";
    const status = suspended ? "suspended" : p.status === "active" ? (Number(p.stock) > 0 ? "on" : "out") : "hidden";
    const stLabel = { on: "mkt.forSale", out: "mkt.soldOut", hidden: "mkt.hidden", suspended: "mkt.susp.badge" }[status];
    const stCls = { on: "sold", out: "cancelled", hidden: "declined", suspended: "suspended" }[status];
    return `
      <article class="mkt-order mkt-mine" data-mine="${esc(p.id)}">
        <a class="mkt-order-img" href="${esc(M.productHref(p.id))}" data-nav>${img ? `<img src="${esc(img)}" alt="" loading="lazy" />` : ICON.bag}</a>
        <div class="mkt-order-body">
          <div class="mkt-order-top">
            <a class="mkt-order-title" href="${esc(M.productHref(p.id))}" data-nav dir="auto">${esc(p.title)}</a>
            <span class="mkt-status st-${stCls}">${esc(t(stLabel))}</span>
          </div>
          ${suspended ? `<p class="mkt-order-note bad">${ICON.flag} <b>${esc(t(p.suspended_with_store ? "mkt.susp.withStore" : "mkt.susp.product"))}</b>${p.suspended_reason ? ` <q dir="auto">${esc(p.suspended_reason)}</q>` : ""}</p>` : ""}
          <div class="mkt-order-meta">
            <b dir="ltr">${esc(M.pt(p.price))}</b> · ${esc(t("mkt.leftN", { n: M.fmt(p.stock) }))} · ${esc(t(Number(p.sales) === 1 ? "mkt.salesOne" : "mkt.salesN", { n: M.fmt(p.sales) }))}
            · <span class="pro">+${esc(M.fmt(p.pros))}</span> / <span class="con">−${esc(M.fmt(p.cons))}</span>
            · <span class="mkt-comm-${p.commission_on ? "on" : "off"}">${esc(p.commission_on ? t("mkt.commissionN", { pct: p.commission_pct }) : t("mkt.noCommission"))}</span>
            ${Number(p.open_orders) ? ` · <b>${esc(t("mkt.openOrders", { n: M.fmt(p.open_orders) }))}</b>` : ""}
            ${p.kind === "digital" ? ` · <span class="mkt-dl-${p.download_url ? "on" : "off"}">${p.download_url ? ICON.download : ""}${esc(t(p.download_url ? "mkt.dl.set" : "mkt.dl.none"))}</span>` : ""}
          </div>
          <div class="mkt-order-meta">${esc((p.categories || []).join(" · "))}</div>
          <div class="mkt-order-acts">
            <button class="btn btn-sm btn-ghost" type="button" data-mine-edit>${ICON.edit}<span>${esc(t("mkt.edit"))}</span></button>
            ${suspended ? ""
              : p.status === "active"
              ? `<button class="btn btn-sm btn-ghost" type="button" data-mine-status="hidden">${esc(t("mkt.hide"))}</button>`
              : `<button class="btn btn-sm btn-ghost" type="button" data-mine-status="active">${esc(t("mkt.show"))}</button>`}
            <button class="btn btn-sm btn-danger" type="button" data-mine-status="deleted">${esc(t("common.delete"))}</button>
          </div>
        </div>
      </article>`;
  }

  async function loadMyProducts(body) {
    const items = await pagedList(
      body,
      (off) => M.call("market_my_products", { p_member: M.memberId(), p_limit: 20, p_offset: off }),
      (list) => `<div class="mkt-orders">${list.map(myProductHtml).join("")}</div>`,
      { empty: t("mkt.noProducts") }
    );
    body.onclick = async (e) => {
      const row = e.target.closest("[data-mine]");
      if (!row) return;
      const p = (items?.() || []).find((x) => x.id === row.dataset.mine);
      if (!p) return;
      if (e.target.closest("[data-mine-edit]")) {
        M.openProductForm({ product: p, store: state.me?.store, onSaved: () => { refreshMe(); route(); } });
        return;
      }
      const st = e.target.closest("[data-mine-status]");
      if (!st) return;
      const to = st.dataset.mineStatus;
      if (to === "deleted" && !confirm(t("mkt.confirmDelete"))) return;
      st.disabled = true;
      const r = await M.call("market_product_status", { p_member: M.memberId(), p_id: p.id, p_status: to });
      st.disabled = false;
      if (!r.ok || !r.data?.ok) return C.toast(M.failText(r));
      C.toast(t(to === "deleted" ? "mkt.deleted" : to === "hidden" ? "mkt.hiddenDone" : "mkt.shownDone"));
      refreshMe();
      route();
    };
  }

  // --- orders
  const ACT = {
    accept: { label: "mkt.act.accept", cls: "btn-primary" },
    decline: { label: "mkt.act.decline", cls: "btn-danger" },
    ship: { label: "mkt.act.ship", cls: "btn-primary" },
    cancel: { label: "mkt.act.cancel", cls: "btn-danger" },
    received: { label: "mkt.act.received", cls: "btn-primary" },
    review: { label: "mkt.act.review", cls: "btn-ghost" },
    return: { label: "mkt.act.return", cls: "btn-ghost" },
    return_accept: { label: "mkt.act.returnAccept", cls: "btn-primary" },
    return_refuse: { label: "mkt.act.returnRefuse", cls: "btn-danger" },
    address: { label: "mkt.act.address", cls: "btn-primary" },
  };

  function actLabel(a, o, side) {
    if (a === "ship" && o.kind === "digital") return t("mkt.act.deliver");
    if (a === "cancel" && side === "purchases") return t("mkt.act.cancelRequest");
    if (a === "review" && o.reviewed) return t("mkt.act.editReview");
    if (a === "address" && o.address?.name) return t("mkt.act.addressChange");
    return t(ACT[a]?.label || a);
  }

  function orderHtml(o, side) {
    const other = side === "sales" ? o.buyer : o.seller;
    const a = o.address || {};
    const addr = [a.name, a.phone, a.line, a.city].filter(Boolean);
    const notes = [];
    if (o.status === "shipped" && o.auto_at) notes.push(t(side === "sales" ? "mkt.o.autoSeller" : "mkt.o.autoBuyer", { date: M.date(o.auto_at) }));
    if (o.release_at && !o.settled_at) notes.push(t(side === "sales" ? "mkt.o.releaseSeller" : "mkt.o.releaseBuyer", { date: M.date(o.release_at) }));
    if (o.settled_at) notes.push(t(side === "sales" ? "mkt.o.paid" : "mkt.o.paidBuyer", { date: M.date(o.settled_at) }));
    if (o.status === "requested") notes.push(t(side === "sales" ? "mkt.o.requestSeller" : "mkt.o.requestBuyer"));
    if (o.status === "sold" && o.needs_address && side === "sales") notes.push(t("mkt.o.waitAddress"));
    else if (o.status === "sold" && !o.needs_address) notes.push(t(side === "sales" ? (o.kind === "digital" ? "mkt.o.soldDigital" : "mkt.o.soldSeller") : "mkt.o.soldBuyer"));
    if (["cancelled", "declined", "returned"].includes(o.status)) notes.push(t("mkt.o.refunded", { pts: M.pt(o.total) }));
    if (o.via_link && side === "sales") {
      // an order of the first version of the market (no percentage kept): CineAura paid the 25%
      if (o.commission_pct == null) notes.push(t("mkt.o.viaLink"));
      else if (Number(o.commission) > 0) notes.push(t("mkt.o.commission", { pct: o.commission_pct, pts: M.pt(o.commission), net: M.pt(o.seller_gets) }));
      else notes.push(t("mkt.o.viaLinkFree"));
    }
    return `
      <article class="mkt-order" data-order="${esc(o.id)}">
        <a class="mkt-order-img" href="${esc(M.productHref(o.product_id))}" data-nav>${o.image ? `<img src="${esc(o.image)}" alt="" loading="lazy" />` : ICON.bag}</a>
        <div class="mkt-order-body">
          <div class="mkt-order-top">
            <a class="mkt-order-title" href="${esc(M.productHref(o.product_id))}" data-nav dir="auto">${esc(o.title)}</a>
            <span class="mkt-status st-${esc(o.status)}">${esc(t(`mkt.st.${o.status}`))}</span>
          </div>
          <div class="mkt-order-meta">
            <span dir="ltr">#${esc(o.id)}</span> · <time datetime="${esc(o.created_at)}">${esc(M.dateTime(o.created_at))}</time>
            · ${esc(t(side === "sales" ? "mkt.buyer" : "mkt.seller"))} <a href="${esc(M.profileHref(other?.username))}">@${esc(other?.username || "")}</a>
            ${side === "purchases" ? ` · <a href="${esc(M.storeHref(o.store_id))}" data-nav>${esc(o.store_name)}</a>` : ""}
          </div>
          <div class="mkt-order-money">
            <bdi dir="ltr">${esc(M.fmt(o.qty))} × ${esc(M.pt(o.unit_price))}</bdi>${Number(o.shipping_cost) ? ` + ${esc(t("mkt.shippingCost"))} <bdi dir="ltr">${esc(M.pt(o.shipping_cost))}</bdi>` : ""} = <b dir="ltr">${esc(M.pt(o.total))}</b>
            <span class="muted">· ${esc(t(o.kind === "digital" ? "mkt.kind.digital" : "mkt.kind.physical"))}</span>
          </div>
          ${o.needs_address && side === "purchases" ? `<p class="mkt-order-alert" role="status">${ICON.home}<span>${esc(t(o.delivery === "hand" ? "mkt.o.addHand" : "mkt.o.addAddress"))}</span></p>` : ""}
          ${addr.length ? `<p class="mkt-order-note"><b>${esc(t(side === "sales" ? (o.delivery === "hand" ? "mkt.o.handTo" : "mkt.o.shipTo") : "mkt.o.yourAddress"))}</b> ${esc(addr.join(" · "))}${a.note ? `<br><span class="muted">${esc(a.note)}</span>` : ""}</p>` : a.note ? `<p class="mkt-order-note"><b>${esc(t("mkt.co.note"))}</b> ${esc(a.note)}</p>` : ""}
          ${o.download_url ? (side === "purchases"
            ? `<p class="mkt-order-dl"><a class="btn btn-sm btn-primary" href="${esc(o.download_url)}" target="_blank" rel="noopener noreferrer" data-download>${ICON.download}<span>${esc(t("mkt.dl.btn"))}</span></a><span class="muted">${esc(t("mkt.dl.private"))}</span></p>`
            : `<p class="mkt-order-note"><b>${esc(t("mkt.dl.sent"))}</b> <a href="${esc(o.download_url)}" target="_blank" rel="noopener noreferrer" dir="ltr">${esc(o.download_url.replace(/^https?:\/\//i, "").slice(0, 60))}</a></p>`) : ""}
          ${o.tracking ? `<p class="mkt-order-note"><b>${esc(t(o.kind === "digital" ? "mkt.o.delivery" : "mkt.o.tracking"))}</b> ${richText(o.tracking)}</p>` : ""}
          ${o.reason ? `<p class="mkt-order-note bad"><b>${esc(t("mkt.o.reason"))}</b> ${esc(o.reason)}</p>` : ""}
          ${o.staff ? `<p class="mkt-staff-note" role="note"><b>${esc(t(o.staff.action === "release" ? (side === "sales" ? "mkt.o.staffReleasedSeller" : "mkt.o.staffReleasedBuyer") : (side === "sales" ? "mkt.o.staffRefundedSeller" : "mkt.o.staffRefundedBuyer"), { date: M.date(o.staff.at) }))}</b> ${esc(o.staff.reason || "")}</p>` : ""}
          ${o.review ? `<div class="mkt-order-review">${(o.review.pros || []).map((x) => `<span class="pro">+ ${esc(x)}</span>`).join("")}${(o.review.cons || []).map((x) => `<span class="con">− ${esc(x)}</span>`).join("")}</div>` : ""}
          ${notes.length ? `<p class="mkt-order-hint muted">${notes.map(esc).join("<br>")}</p>` : ""}
          ${(o.actions || []).length ? `<div class="mkt-order-acts">${o.actions.map((k) => `<button class="btn btn-sm ${ACT[k]?.cls || "btn-ghost"}" type="button" data-act="${k}">${esc(actLabel(k, o, side))}</button>`).join("")}</div>` : ""}
        </div>
      </article>`;
  }

  async function laterHtml(list) {
    return `<div class="mkt-grid mkt-later">${list.map((p) => `
      <div class="mkt-later-item" data-later-item="${esc(p.id)}">
        ${M.cardHtml(p)}
        <div class="mkt-later-acts">
          ${p.available ? `<button class="btn btn-sm btn-primary" type="button" data-later-buy>${ICON.cart}<span>${esc(t("mkt.buyNow"))}</span></button>` : `<span class="muted">${esc(t("mkt.unavailable"))}</span>`}
          <button class="btn btn-sm btn-ghost" type="button" data-later-del>${esc(t("pic.remove"))}</button>
        </div>
      </div>`).join("")}</div>`;
  }

  async function loadOrders(body, r) {
    const side = r.section;
    if (side === "purchases" && r.tab === "later") {
      const seq = ++state.seq;
      const res = await M.call("market_orders", { p_member: M.memberId(), p_side: "purchases", p_tab: "later", p_limit: 60, p_offset: 0 });
      if (seq !== state.seq) return;
      if (!res.ok || !res.data?.ok) {
        body.innerHTML = res.ok ? `<p class="mkt-panel-empty muted">${esc(M.errText(res.data))}</p>` : failHtml(res);
        return;
      }
      const list = res.data.items || [];
      body.innerHTML = list.length ? await laterHtml(list) : `<p class="mkt-panel-empty muted">${esc(t("mkt.empty.purchases.later"))}</p>`;
      body.onclick = async (e) => {
        const item = e.target.closest("[data-later-item]");
        if (!item) return;
        const id = item.dataset.laterItem;
        if (e.target.closest("[data-later-del]")) {
          const x = await M.call("market_later", { p_member: M.memberId(), p_product: id, p_on: false });
          if (!x.ok || !x.data?.ok) return C.toast(M.failText(x));
          C.toast(t("mkt.laterRemoved"));
          refreshMe();
          return route();
        }
        if (e.target.closest("[data-later-buy]")) {
          const d = await M.call("market_product", { p_id: id, p_member: M.memberId(), p_country: "" });
          if (!d.ok || !d.data?.ok) return C.toast(M.failText(d));
          const blocked = buyBlocker(d.data.product, d.data.store, d.data.viewer || {});
          if (blocked) return C.toast(blocked);
          M.openCheckout({
            product: d.data.product,
            store: d.data.store,
            ref: refFor(id),
            onDone: afterCheckout,
            onAddress: afterAddress,
          });
        }
      };
      return;
    }
    const items = await pagedList(
      body,
      (off) => M.call("market_orders", { p_member: M.memberId(), p_side: side, p_tab: r.tab, p_limit: 20, p_offset: off }),
      (list) => `<div class="mkt-orders">${list.map((o) => orderHtml(o, side)).join("")}</div>`,
      { empty: t(`mkt.empty.${side}.${r.tab}`) }
    );
    body.onclick = (e) => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      const o = (items?.() || []).find((x) => x.id === b.closest("[data-order]")?.dataset.order);
      if (o) orderAction(o, b.dataset.act, side, b);
    };
  }

  async function orderAction(o, act, side, btn) {
    let note = "";
    if (act === "address") {
      M.openAddress({ order: o, onSaved: () => { refreshMe(); route(); } });
      return;
    }
    if (act === "review") {
      M.openReview({
        product: { id: o.product_id, title: o.title, images: o.image ? [o.image] : [], price: o.unit_price },
        review: o.review,
        onSaved: () => { refreshMe(); route(); },
      });
      return;
    }
    if (act === "decline" || (act === "cancel" && side === "sales") || act === "return" || act === "return_refuse") {
      const titles = {
        decline: ["mkt.act.decline", "mkt.n.declineLabel"],
        cancel: ["mkt.act.cancel", "mkt.n.cancelLabel"],
        return: ["mkt.act.return", "mkt.n.returnLabel"],
        return_refuse: ["mkt.act.returnRefuse", "mkt.n.refuseLabel"],
      }[act];
      note = await M.openNote({ title: t(titles[0]), label: t(titles[1]), danger: act !== "return", confirm: t(titles[0]) });
      if (note == null) return;
    } else if (act === "ship") {
      const digital = o.kind === "digital";
      note = await M.openNote({
        title: t(digital ? "mkt.act.deliver" : "mkt.act.ship"),
        label: t(digital ? "mkt.n.deliverLabel" : "mkt.n.shipLabel"),
        hint: t(digital ? "mkt.n.deliverHint" : "mkt.n.shipHint"),
        required: digital,
        min: 1,
        confirm: t(digital ? "mkt.act.deliver" : "mkt.act.ship"),
      });
      if (note == null) return;
    } else if (act === "cancel" || act === "received" || act === "accept" || act === "return_accept") {
      const q = { cancel: "mkt.c.cancel", received: "mkt.c.received", accept: "mkt.c.accept", return_accept: "mkt.c.returnAccept" }[act];
      if (!confirm(t(q, { pts: M.pt(o.total) }))) return;
    }
    if (btn) btn.disabled = true;
    const r = await M.call("market_order_action", { p_member: M.memberId(), p_order: o.id, p_action: act, p_note: note || "" });
    if (btn) btn.disabled = false;
    if (!r.ok || !r.data?.ok) return C.toast(M.failText(r));
    C.toast(t(`mkt.done.${act}`));
    await refreshMe();
    route();
  }

  // --- Your rating
  // a review (sql: _mkt_review_json): given = yours (its seller, its audience); received = of
  // your products (its author, a verified purchase or not)
  function reviewCardHtml(rv, side) {
    const pr = rv.product || {};
    const img = M.images(pr)[0];
    const who = side === "given" ? rv.seller : rv.author;
    return `
      <article class="mkt-order" data-review-card="${esc(rv.id)}">
        <a class="mkt-order-img" href="${esc(M.productHref(pr.id || ""))}" data-nav>${img ? `<img src="${esc(img)}" alt="" loading="lazy" />` : ICON.bag}</a>
        <div class="mkt-order-body">
          <div class="mkt-order-top">
            <a class="mkt-order-title" href="${esc(M.productHref(pr.id || ""))}" data-nav dir="auto">${esc(pr.title || t("mkt.productGone"))}</a>
            <span class="muted">${esc(M.date(rv.updated_at || rv.created_at))}</span>
          </div>
          <div class="mkt-order-meta">${esc(t(side === "given" ? "mkt.seller" : "mkt.rv.by"))} <a href="${esc(M.profileHref(who?.username))}">@${esc(who?.username || "")}</a>${pr.store?.name ? ` · ${esc(pr.store.name)}` : ""}
            ${rv.verified ? `<span class="mkt-verified">${ICON.verified}<span>${esc(t("mkt.rv.verified"))}</span></span>` : ""}
            ${side === "given" ? M.visBadge(rv.visibility) : ""}</div>
          <div class="mkt-pc-mini">
            <ul class="pro">${(rv.pros || []).map((x) => `<li dir="auto">${esc(x)}</li>`).join("") || `<li class="muted">${esc(t("mkt.noPros"))}</li>`}</ul>
            <ul class="con">${(rv.cons || []).map((x) => `<li dir="auto">${esc(x)}</li>`).join("") || `<li class="muted">${esc(t("mkt.noCons"))}</li>`}</ul>
          </div>
          ${side === "given" ? `<div class="mkt-order-acts"><button class="btn btn-sm btn-ghost" type="button" data-rv-edit>${esc(t("mkt.act.editReview"))}</button></div>` : ""}
        </div>
      </article>`;
  }

  async function loadReviews(body, r) {
    const side = r.tab === "sales" ? "received" : "given";
    let pending = [];
    const items = await pagedList(
      body,
      async (off) => {
        const res = await M.call("market_reviews", { p_member: M.memberId(), p_side: side, p_limit: 20, p_offset: off });
        if (res.ok && res.data?.ok && off === 0) pending = res.data.pending || [];
        return res;
      },
      (list) => `<div class="mkt-orders">${list.map((x) => reviewCardHtml(x, side)).join("")}</div>`,
      {
        empty: t(side === "given" ? "mkt.empty.ratings.purchases" : "mkt.empty.ratings.sales"),
        // the products you received and haven't reviewed come first
        before: () =>
          side === "given" && pending.length
            ? `<div class="mkt-pending"><h2>${esc(t("mkt.toReview"))}</h2><div class="mkt-orders">${pending.map((o) => orderHtml(o, "purchases")).join("")}</div></div>`
            : "",
      }
    );
    body.onclick = (e) => {
      const act = e.target.closest("[data-act]");
      if (act) {
        const o = pending.find((x) => x.id === act.closest("[data-order]")?.dataset.order);
        if (o) orderAction(o, act.dataset.act, "purchases", act);
        return;
      }
      if (e.target.closest("[data-rv-edit]")) {
        const id = e.target.closest("[data-review-card]").dataset.reviewCard;
        const rv = (items?.() || []).find((x) => String(x.id) === id);
        if (rv) M.openReview({ product: rv.product || {}, review: rv, onSaved: () => route() });
      }
    };
  }

  // --- Your requests
  function requestHtml(q, side) {
    const who = side === "sent" ? q.to : q.from;
    return `
      <article class="mkt-request st-${esc(q.status)}" data-request="${esc(q.id)}">
        <div class="mkt-order-top">
          <span class="mkt-chip">${esc(t(q.kind === "question" ? "mkt.rq.question" : "mkt.rq.item"))}</span>
          <span class="mkt-status st-req-${esc(q.status)}">${esc(t(`mkt.rq.st.${q.status}`))}</span>
        </div>
        <div class="mkt-order-meta">
          ${esc(t(side === "sent" ? "mkt.rq.to" : "mkt.rq.from"))} <a href="${esc(M.profileHref(who?.username))}">@${esc(who?.username || "")}</a>
          ${q.store?.id ? ` · <a href="${esc(M.storeHref(q.store.id))}" data-nav>${esc(q.store.name)}</a>` : ""}
          ${q.product ? ` · <a href="${esc(M.productHref(q.product.id))}" data-nav>${esc(q.product.title)}</a>` : ""}
          · ${esc(M.dateTime(q.created_at))}
        </div>
        <p class="mkt-request-body" dir="auto">${richText(q.body)}</p>
        ${q.reply ? `<div class="mkt-request-reply"><b>${esc(t("mkt.rq.reply"))}</b> <bdi>${richText(q.reply)}</bdi><small class="muted"> · ${esc(M.dateTime(q.replied_at))}</small></div>` : ""}
        ${side === "received" && q.status !== "closed" ? `
        <form class="mkt-reply-form" data-reply>
          <textarea name="reply" dir="auto" rows="2" maxlength="1000" placeholder="${esc(t("mkt.rq.replyPh"))}">${esc(q.reply || "")}</textarea>
          <button class="btn btn-sm btn-primary" type="submit">${esc(t(q.reply ? "mkt.rq.update" : "mkt.rq.answer"))}</button>
        </form>` : ""}
        ${q.status !== "closed" ? `<div class="mkt-order-acts"><button class="btn btn-sm btn-ghost" type="button" data-close-request>${esc(t("mkt.rq.close"))}</button></div>` : ""}
      </article>`;
  }

  async function loadRequests(body, r) {
    const side = r.tab;
    await pagedList(
      body,
      (off) => M.call("market_requests", { p_member: M.memberId(), p_side: side, p_limit: 20, p_offset: off }),
      (list) => `<div class="mkt-requests">${list.map((x) => requestHtml(x, side)).join("")}</div>`,
      { empty: t(`mkt.empty.requests.${side}`), before: `<p class="muted mkt-panel-hint">${esc(t(side === "sent" ? "mkt.rq.sentHint" : "mkt.rq.receivedHint"))}</p>` }
    );
    body.onsubmit = async (e) => {
      const form = e.target.closest("[data-reply]");
      if (!form) return;
      e.preventDefault();
      const id = Number(form.closest("[data-request]").dataset.request);
      const reply = form.reply.value.trim();
      if (!reply) return C.toast(t("mkt.err.body"));
      const btn = form.querySelector("button");
      btn.disabled = true;
      const x = await M.call("market_request_reply", { p_member: M.memberId(), p_id: id, p_reply: reply });
      btn.disabled = false;
      if (!x.ok || !x.data?.ok) return C.toast(M.failText(x));
      C.toast(t("mkt.rq.answered"));
      refreshMe();
      route();
    };
    body.onclick = async (e) => {
      const b = e.target.closest("[data-close-request]");
      if (!b) return;
      const id = Number(b.closest("[data-request]").dataset.request);
      b.disabled = true;
      const x = await M.call("market_request_close", { p_member: M.memberId(), p_id: id });
      if (!x.ok || !x.data?.ok) {
        b.disabled = false;
        return C.toast(M.failText(x));
      }
      refreshMe();
      route();
    };
  }

  // --- Notifications (of the market)
  async function drawNotifications(r) {
    const box = main();
    box.innerHTML = panelShell(r, loadingHtml(), {
      tabs: false,
      extra: `<a class="btn btn-sm btn-ghost" href="./notifications.html">${esc(t("mkt.allNotifications"))}</a>`,
    });
    const body = box.querySelector("[data-panel-body]");
    const seq = ++state.seq;
    const res = await C.supabaseRequest(
      `/rest/v1/notifications?member_id=eq.${C.restValue(M.memberId())}&kind=like.market*&select=*&order=created_at.desc&limit=60`
    ).catch(() => null);
    if (seq !== state.seq) return;
    const rows = res?.ok && Array.isArray(res.data) ? res.data : [];
    if (!rows.length) {
      body.innerHTML = `<p class="mkt-panel-empty muted">${esc(t("mkt.noNotifications"))}</p>`;
      return;
    }
    body.innerHTML = `<ul class="mkt-notes">${rows.map((n) => {
      const href = C.noteHref(n);
      const inPage = /market(\.html)?(\?|#|$)/i.test(href);
      return `<li class="${n.read ? "" : "unread"}">
        <a href="${esc(href)}" ${inPage ? "data-nav" : ""}>
          <span class="mkt-note-ico">${ICON.bag}</span>
          <span class="mkt-note-text"><b>${esc(C.noteTitle(n))}</b><span>${esc(n.body || "")}</span></span>
          <time class="muted" datetime="${esc(n.created_at)}">${esc(C.noteWhen(n.created_at))}</time>
        </a>
      </li>`;
    }).join("")}</ul>`;
    const unread = rows.filter((n) => !n.read).map((n) => n.id);
    if (unread.length) {
      C.markNotesRead(unread).then(() => {
        if (state.me) state.me.unread = Math.max(0, Number(state.me.unread || 0) - unread.length);
        drawSide();
      });
    }
  }

  // --- Store settings
  function drawSettings(r) {
    const box = main();
    const me = state.me;
    const store = me?.store || null;
    box.innerHTML = panelShell(
      r,
      `${store?.suspended ? suspendedHtml("store", store.suspended_reason) : ""}${store ? "" : `<p class="mkt-panel-hint">${esc(t("mkt.s.intro"))}</p>`}${M.storeFormHtml(store, me?.member || { username: M.username(), country: "" })}`,
      { tabs: false }
    );
    M.wireStoreForm(box, {
      onSaved: async () => {
        await refreshMe();
        if (location.hash.startsWith("#settings")) route();
      },
    });
  }

  // ---------------------------------------------------------------- routing
  function route() {
    // a product reached inside the page (a purchase list's card: …&@ref) keeps who brings the sale too
    captureRef();
    state.route = parseRoute();
    document.body.dataset.mktView = state.route.view;
    drawTools();
    drawSide();
    const r = state.route;
    if (r.view === "panel") return drawPanel(r);
    if (r.view === "product") return drawProduct(r);
    if (r.view === "list") return drawList(r);
    if (r.view === "category") return drawCategory(r);
    if (r.view === "store") return drawStore(r);
    if (r.view === "search") return drawSearch(r);
    return drawHome();
  }

  function sell() {
    if (!signedIn()) {
      location.href = M.signinHref("Market.html#sales/products");
      return;
    }
    if (state.me?.store?.suspended) {
      C.toast(t("mkt.err.suspendedStore"));
      return;
    }
    M.openProductForm({
      store: state.me?.store || null,
      onSaved: async (id, info) => {
        await refreshMe();
        if (!info?.partial) go(M.productHref(id));
      },
    });
  }

  function wire() {
    $("#mkt-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const r = state.route.view === "search" ? state.route : { type: "products", sort: "new", country: "", kind: "" };
      go(searchHref({ ...r, q: $("#mkt-q").value.trim().slice(0, 100) }));
    });
    $("#mkt-tools").addEventListener("click", (e) => {
      const b = e.target.closest("[data-type]");
      if (!b) return;
      const r = state.route.view === "search" ? state.route : { q: "", sort: "new", country: "", kind: "" };
      go(searchHref({ ...r, type: b.dataset.type }));
    });
    $("#mkt-tools").addEventListener("change", (e) => {
      const k = e.target.dataset.f;
      if (!k) return;
      const r = state.route.view === "search" ? state.route : { q: "", type: "products", sort: "new", country: "", kind: "" };
      go(searchHref({ ...r, [k]: e.target.value }));
    });
    document.addEventListener("click", (e) => {
      if (e.target.closest("[data-sell]")) {
        e.preventDefault();
        sell();
        return;
      }
      const panel = e.target.closest("[data-panel], [data-panel-link]");
      if (panel) {
        e.preventDefault();
        go(`./Market.html#${panel.dataset.panel || panel.dataset.panelLink}`);
        return;
      }
      const tab = e.target.closest(".mkt-tabs [data-tab]");
      if (tab && state.route.view === "panel") {
        go(`./Market.html#${state.route.section}/${tab.dataset.tab}`, { replace: true });
        return;
      }
      const a = e.target.closest("a[data-nav]");
      if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target === "_blank") return;
      const url = new URL(a.getAttribute("href"), location.href);
      if (url.origin !== location.origin || !/\/market(\.html)?$/i.test(url.pathname)) return;
      e.preventDefault();
      document.querySelectorAll(".mkt-modal-back").forEach((m) => m.close?.());
      go(url.href);
    });
    window.addEventListener("popstate", route);
    window.addEventListener("hashchange", route);
    // the language changes: labels, dates and numbers follow
    document.addEventListener("cineaura:prefs", () => {
      drawActs();
      route();
    });
  }

  async function boot() {
    captureRef();
    C.setupChrome();
    // the sign-in links come back to this very page
    document.querySelectorAll("[data-mkt-signin]").forEach((a) => (a.href = M.signinHref()));
    wire();
    state.route = parseRoute();
    drawSide();
    drawActs();
    const first = loadMe();
    if (state.route.view === "panel" && signedIn()) {
      // a panel needs the counts (tabs) and the store (settings)
      await first;
      drawActs();
      route();
    } else {
      // the other views draw at once; the side menu follows
      route();
      await first;
      drawSide();
      drawActs();
    }
    loadPoints();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
