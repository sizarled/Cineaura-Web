/* CineAura — the home page (index.html), what the last updates added:
 *
 *   the bar of the team    site_banner_get() (Panel > Announcements, sql/panel_admin.sql) at the top
 *                          of the hero; closed by the visitor until its text changes (its version)
 *   What's new             the numbers under the cards: products on sale, videos, IPTV lists, your level
 *   the Market             trending products and popular categories (market_home), the top stores
 *                          with their tier (market_top_stores); hidden without sql/market.sql
 *   members' IPTV lists    the most viewed lists the visitor may open (iptv_lists_search, filter open)
 *   Points & levels        the member's own level and the way to the next one (CineAura.memberPoints),
 *                          and the levels LV0 to LV Max with their multipliers
 * Every part stays as the page shipped it when its SQL is not run (or the call fails).
 */
(() => {
  const C = window.CineAura;
  if (!C || !document.getElementById("whats-new")) return;
  const { t, escapeHtml: esc } = C;
  const memberId = () => (C.getSession ? C.getSession()?.member_id || "" : "");
  const call = (fn, args = {}) => C.rpc(fn, args).catch(() => null);
  const payload = (r) => (r?.ok && r.data != null && typeof r.data === "object" ? r.data : null);
  const locale = () => `${C.getLocale?.() || "en"}-u-nu-latn`;
  const num = (n) => {
    try {
      return new Intl.NumberFormat(locale()).format(Number(n) || 0);
    } catch {
      return String(Number(n) || 0);
    }
  };
  const pt = (n) => `${num(n)} PT`;
  const SVG = (body, size = 18) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
  const ICON = {
    bag: '<path d="M4.5 8.5h15l-1.2 11a1.6 1.6 0 0 1-1.6 1.5H7.3a1.6 1.6 0 0 1-1.6-1.5z"/><path d="M8.8 8.5V7a3.2 3.2 0 0 1 6.4 0v1.5"/>',
    tv: '<rect x="3" y="6.5" width="18" height="12.5" rx="2"/><path d="M8.5 3l3.5 3.5L15.5 3"/>',
    megaphone: '<path d="M4 10.2v3.6a1 1 0 0 0 1 1h2.2L12.5 19V5L7.2 9.2H5a1 1 0 0 0-1 1z"/><path d="M16 9a4.2 4.2 0 0 1 0 6M18.6 6.4a8 8 0 0 1 0 11.2"/>',
    star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  };
  const tierPct = (pct) => {
    const v = Math.max(0, Math.min(100, Number(pct) || 0));
    return v >= 10 ? String(Math.floor(v)) : String(Math.floor(v * 10) / 10);
  };
  const tierHtml = (tier) =>
    tier && tier.code
      ? `<span class="mkt-tier t-${esc(tier.code)}" dir="ltr" title="${esc(t("mkt.tier.badge", { code: tier.code, pct: tierPct(tier.pct), points: num(tier.points) }))}"><b>${esc(tier.code)}</b><span>${esc(tierPct(tier.pct))}%</span></span>`
      : "";
  // a link of the bar: https://… (a new tab) or a page of the site
  const safeLink = (raw) => {
    const v = String(raw || "").trim();
    if (/^https?:\/\/[^\s<>"`]+$/i.test(v)) return { href: v, external: true };
    if (/^(\.\/)?[A-Za-z][\w-]*\.html([?#][^\s<>"`]*)?$/.test(v)) return { href: v.startsWith("./") ? v : `./${v}`, external: false };
    return null;
  };
  const setStat = (key, text) => {
    const el = document.querySelector(`[data-hh-stat="${key}"]`);
    if (!el || !text) return;
    el.textContent = text;
    el.hidden = false;
  };

  // ---------------------------------------------------------------- the bar of the team
  const CLOSED_KEY = "cineaura_banner_closed";
  async function banner() {
    const slot = document.getElementById("site-banner");
    if (!slot) return;
    const b = payload(await call("site_banner_get"));
    if (!b?.active || !String(b.text || "").trim()) return;
    try {
      if (localStorage.getItem(CLOSED_KEY) === String(b.version)) return;
    } catch {
      /* storage blocked: shown every time */
    }
    const tone = ["info", "success", "warning", "promo"].includes(b.tone) ? b.tone : "info";
    const link = safeLink(b.link);
    slot.innerHTML = `
      <div class="site-banner tone-${tone}" role="region" aria-label="${esc(t("hb.label"))}">
        <span class="site-banner-ico">${SVG(ICON.megaphone, 18)}</span>
        <span class="site-banner-text" dir="auto">${esc(b.text)}</span>
        ${link ? `<a class="site-banner-link" href="${esc(link.href)}"${link.external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${esc(b.link_label || t("hb.more"))}</a>` : ""}
        <button class="site-banner-x" type="button" aria-label="${esc(t("hb.close"))}" title="${esc(t("hb.close"))}">×</button>
      </div>`;
    slot.hidden = false;
    slot.querySelector(".site-banner-x").addEventListener("click", () => {
      try {
        localStorage.setItem(CLOSED_KEY, String(b.version));
      } catch {
        /* closed for this visit only */
      }
      slot.hidden = true;
    });
  }

  // ---------------------------------------------------------------- What's new: the numbers
  async function stats() {
    const [prods, vids, lists] = await Promise.all([
      call("market_search", { p_member: memberId(), p_q: "", p_type: "products", p_sort: "", p_country: "", p_kind: "", p_category: "", p_store: "", p_limit: 1, p_offset: 0 }),
      call("content_search", { p_member: memberId(), p_q: "", p_sort: "date", p_limit: 1, p_offset: 0 }),
      call("iptv_lists_search", { p_member: memberId(), p_q: "", p_sort: "views", p_filter: "open", p_limit: 1, p_offset: 0 }),
    ]);
    const n = (r) => {
      const d = payload(r);
      return d && Number.isFinite(Number(d.total)) ? Number(d.total) : 0;
    };
    if (n(prods)) setStat("market", t("hh.stat.products", { n: num(n(prods)) }));
    if (n(vids)) setStat("videos", t("hh.stat.videos", { n: num(n(vids)) }));
    if (n(lists)) setStat("lists", t("hh.stat.lists", { n: num(n(lists)) }));
  }

  // ---------------------------------------------------------------- the Market
  const productCard = (p) => {
    const img = Array.isArray(p.images) && p.images[0] ? p.images[0] : "";
    return `
      <a class="glass hh-prod" href="./Market.html?Product=${encodeURIComponent(p.id)}">
        <span class="hh-prod-img">${img ? `<img src="${esc(img)}" alt="" loading="lazy" decoding="async" />` : SVG(ICON.bag, 34)}</span>
        <span class="hh-prod-body">
          <b class="hh-prod-title" dir="auto">${esc(p.title)}</b>
          <span class="hh-prod-price" dir="ltr">${esc(pt(p.price))}</span>
          <span class="hh-prod-store"><span dir="auto">${esc(p.store?.name || "")}</span> ${tierHtml(p.store?.tier)}</span>
        </span>
      </a>`;
  };
  const storeCard = (s) => `
    <a class="glass hh-store" href="./Market.html?Store=${encodeURIComponent(s.id)}">
      <span class="hh-store-logo">${s.logo ? `<img src="${esc(s.logo)}" alt="" loading="lazy" decoding="async" />` : SVG(ICON.bag, 22)}</span>
      <span class="hh-store-body">
        <b dir="auto">${esc(s.name)}</b>
        <small>${tierHtml(s.tier)} ${esc(t("hh.mkt.storeLine", { n: num(s.products) }))}${s.country ? ` · ${esc(C.countryName?.(s.country) || s.country)}` : ""}</small>
      </span>
    </a>`;

  async function market() {
    const sec = document.getElementById("home-market");
    if (!sec) return;
    const [home, top] = await Promise.all([call("market_home", { p_member: memberId() }), call("market_top_stores", { p_member: memberId(), p_limit: 8 })]);
    const h = payload(home);
    const products = Array.isArray(h?.trending) ? h.trending.slice(0, 16) : [];
    const stores = Array.isArray(payload(top)?.items) ? payload(top).items : [];
    if (!products.length && !stores.length) return;
    sec.hidden = false;
    const row = document.getElementById("hh-products");
    row.removeAttribute("aria-busy");
    row.innerHTML = products.length ? products.map(productCard).join("") : `<p class="muted hh-empty">${esc(t("hh.mkt.none"))}</p>`;
    const cats = Array.isArray(h?.categories) ? h.categories : [];
    const nav = document.getElementById("hh-cats");
    if (cats.length && nav) {
      nav.innerHTML = cats
        .map((c) => `<a class="hv-chip hh-cat" href="./Market.html?Categories=${encodeURIComponent(c.id)}"><span dir="auto">${esc(c.name)}</span> <b>${num(Array.isArray(c.products) ? c.products.length : 0)}</b></a>`)
        .join("");
      nav.hidden = false;
    }
    if (stores.length) {
      document.getElementById("hh-stores").innerHTML = stores.map(storeCard).join("");
      document.getElementById("hh-stores-wrap").hidden = false;
    }
  }

  // ---------------------------------------------------------------- members' IPTV lists
  async function lists() {
    const box = document.getElementById("hh-lists");
    if (!box) return;
    const d = payload(await call("iptv_lists_search", { p_member: memberId(), p_q: "", p_sort: "views", p_filter: "open", p_limit: 8, p_offset: 0 }));
    const items = Array.isArray(d?.items) ? d.items.filter((l) => l.ready !== false && !l.locked) : [];
    if (!items.length) return;
    document.getElementById("hh-list-grid").innerHTML = items
      .map((l) => `
        <a class="glass hh-list" href="./Listchannels.html?list=${encodeURIComponent(l.id)}">
          <span class="hh-list-cover" aria-hidden="true">${SVG(ICON.tv, 20)}<b dir="ltr">${esc(num(l.channels))}</b><small>${esc(t("common.channels"))}</small></span>
          <span class="hh-list-body">
            <b dir="auto">${esc(l.name)}</b>
            <small><bdi>@${esc(l.owner || "")}</bdi> · ${esc(t("hh.lists.views", { n: num(l.views) }))}</small>
            ${l.visibility && l.visibility !== "public" ? `<span class="hh-vis is-${esc(l.visibility)}">${esc(t(`ipl.vis.${l.visibility}`))}</span>` : ""}
          </span>
        </a>`)
      .join("");
    box.hidden = false;
  }

  // ---------------------------------------------------------------- Points & levels
  function ladder(level = -1) {
    const ol = document.getElementById("hh-ladder");
    if (!ol || !Array.isArray(C.POINT_LEVELS)) return;
    const compact = C.compactPoints || ((n) => String(n));
    ol.innerHTML = C.POINT_LEVELS.map((at, i) => `
      <li class="${i === level ? "is-you" : ""}"${i === level ? ' aria-current="true"' : ""}>
        <b dir="ltr">${esc(C.levelName(i))}</b>
        <span dir="ltr">${esc(compact(at))}+</span>
        <i dir="ltr">×${esc(C.levelMultiplier(i))}</i>
        ${i === level ? `<em>${esc(t("points.you"))}</em>` : ""}
      </li>`).join("");
  }

  async function points() {
    ladder();
    const id = memberId();
    const card = document.getElementById("hh-me");
    if (!id || !card || !C.memberPoints) return;
    let mp = null;
    try {
      mp = await C.memberPoints(id);
    } catch {
      mp = null;
    }
    if (!mp?.level) return;
    const lv = mp.level;
    const pct = Math.round((lv.progress || 0) * 100);
    const name = C.getSession()?.username || "";
    card.classList.add("is-member");
    card.innerHTML = `
      <span class="eyebrow">${esc(t("hh.pts.yours"))}</span>
      <div class="hh-me-top">
        <span class="hh-me-lv" dir="ltr">${esc(lv.name)}</span>
        <span class="hh-me-mult">${esc(t("hh.pts.mult", { n: lv.multiplier }))}</span>
      </div>
      ${name ? `<p class="hh-me-hi">${esc(t("hh.pts.hi", { name: `@${name}` }))}</p>` : ""}
      <div class="hh-me-nums">
        <div><span>${esc(t("hh.pts.available"))}</span><strong dir="ltr">${esc(pt(mp.available))}</strong></div>
        <div><span>${esc(t("hh.pts.earned"))}</span><strong dir="ltr">${esc(pt(mp.earned))}</strong></div>
      </div>
      <div class="hh-me-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>
      <p class="hh-me-next">${esc(lv.next ? t("hh.pts.toNext", { n: num(Math.max(0, lv.next.at - lv.earned)), level: lv.next.name }) : t("points.levelTop"))}</p>
      <a class="btn btn-lg btn-primary" href="./dashboard.html#points">${esc(t("hh.pts.open"))}</a>`;
    setStat("points", t("hh.stat.level", { level: lv.name }));
    ladder(lv.level);
  }

  function boot() {
    banner();
    stats();
    market();
    lists();
    points();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
