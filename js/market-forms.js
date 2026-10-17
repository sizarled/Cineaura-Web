/* CineAura — Market.html, the shared pieces (sql/market.sql): calls, numbers, cards and the
 * dialogs. js/market.js draws the page with them.
 *
 *   M.call(name, args)              a market function -> { ok, data } | { ok:false, setup | network | data }
 *   M.cardHtml(product)             a product card: its pictures as a slideshow, title, price (PT),
 *                                   date added and the member who sells it
 *   M.storeCardHtml / M.categoryCardHtml
 *   M.openProductForm({ product })  add / change a product: pictures (links, or uploaded to IPTV/
 *                                   Market/Product/<id>.jpg, <id>-1.jpg …), categories, video …
 *   M.storeFormHtml / M.wireStoreForm   Store settings (logo and cover: IPTV/Market/Logo|Cover/<id>.jpg)
 *   M.openCheckout, M.openReview, M.openRequest, M.openShare, M.openNote, M.openZoom
 *   M.tierHtml(tier)                the tier of a store: N / K / M / B and the progress in it (K25%)
 *   M.openReport({ kind, id })      the Report button of a store / product (Panel > Reports > Market)
 *   M.openAddress({ order })        the buyer's delivery address of a sold physical order
 */
(() => {
  "use strict";
  const C = window.CineAura;
  const { t, escapeHtml: esc } = C;
  const M = {};

  M.memberId = () => String(C.getSession()?.member_id || "");
  M.username = () => String(C.getSession()?.username || "").replace(/^@/, "");

  // ---------------------------------------------------------------- icons
  const svg = (body, size = 18, sw = 2) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
  const ICON = {
    bag: svg('<path d="M5 8h14l-1.2 11.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>', 18, 1.8),
    bigBag: svg('<path d="M5 8h14l-1.2 11.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>', 40, 1.4),
    plus: svg('<path d="M12 5v14M5 12h14"/>', 16, 2.4),
    left: svg('<path d="M15 6l-6 6 6 6"/>', 18, 2.4),
    right: svg('<path d="M9 6l6 6-6 6"/>', 18, 2.4),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>', 18, 2.2),
    share: svg('<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/>', 16),
    cart: svg('<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2.5 3.5h2.6l2.3 11.2a1.6 1.6 0 0 0 1.6 1.3h8.6a1.6 1.6 0 0 0 1.6-1.2l1.4-6.3H6.1"/>', 16),
    clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>', 16),
    truck: svg('<path d="M2.5 6.5h11v9h-11zM13.5 9.5h4l3 3v3h-7z"/><circle cx="6.5" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>', 16),
    cloud: svg('<path d="M7 18.5h10.5a4 4 0 0 0 .5-8 6 6 0 0 0-11.6 1.6A3.3 3.3 0 0 0 7 18.5z"/>', 16),
    store: svg('<path d="M3.5 9.5l1.5-5h14l1.5 5"/><path d="M4.5 9.5v10h15v-10"/><path d="M3.5 9.5a2.8 2.8 0 0 0 5.6 0 2.8 2.8 0 0 0 5.6 0 2.8 2.8 0 0 0 5.6 0"/><path d="M10 19.5v-5h4v5"/>', 16),
    globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>', 14),
    pin: svg('<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>', 14),
    up: svg('<path d="M7 11l5-5 5 5M12 6v12"/>', 16),
    down: svg('<path d="M7 13l5 5 5-5M12 18V6"/>', 16),
    chat: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>', 16),
    link: svg('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>', 14),
    copy: svg('<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v9A1.5 1.5 0 0 0 5 15.5h3.5"/>', 16),
    edit: svg('<path d="M4 20h4l10.5-10.5a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>', 15),
    zoom: svg('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.3-4.3M11 8.5v5M8.5 11h5"/>', 16),
    coins: svg('<ellipse cx="9" cy="7" rx="5.5" ry="2.8"/><path d="M3.5 7v4c0 1.5 2.5 2.8 5.5 2.8s5.5-1.3 5.5-2.8V7"/><path d="M9.5 16.6c.8.2 1.6.2 2.5.2 3 0 5.5-1.3 5.5-2.8v-4"/><path d="M14.5 10.2c1.7.3 3 1.2 3 2.3"/>', 18, 1.8),
    flag: svg('<path d="M5 21V4"/><path d="M5 4.5h11.5l-2.2 4 2.2 4H5"/>', 16),
    download: svg('<path d="M12 4v11"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19.5h14"/>', 16),
    home: svg('<path d="M4 10.5L12 4l8 6.5"/><path d="M6 9v10.5h12V9"/><path d="M10 19.5v-5h4v5"/>', 16),
    lock: svg('<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>', 14),
  };
  M.ICON = ICON;

  // ---------------------------------------------------------------- calls
  function setupMissing(res) {
    const code = res?.data?.code;
    return res?.status === 404 || code === "PGRST202" || code === "PGRST205" || code === "42883";
  }

  // -> { ok: true, data } | { ok: false, setup | network | status, data }
  M.call = async (name, args = {}) => {
    let res;
    try {
      res = await C.rpc(name, args);
    } catch {
      return { ok: false, network: true };
    }
    if (!res.ok) {
      if (setupMissing(res)) {
        console.warn(`CineAura: ${name}() is missing — run sql/image_uploads.sql and sql/market.sql in the Supabase SQL editor.`);
        return { ok: false, setup: true };
      }
      return { ok: false, status: res.status, data: res.data };
    }
    return { ok: true, data: res.data };
  };

  // A refusal of the server ({ ok:false, reason }) as a sentence.
  const REASONS = [
    "member", "blocked", "name", "description", "links", "logo", "cover", "scope", "country", "city", "sale_mode",
    "return_days", "title", "kind", "price", "shipping_cost", "stock", "categories", "images", "video", "limit",
    "not_found", "own", "closed", "qty", "address", "points", "state", "note", "window", "empty", "text", "body",
    "product", "orders", "commission", "download", "suspended", "reason", "already", "phone",
  ];
  M.errText = (data) => {
    const r = String(data?.reason || "");
    if (r === "points") return t("mkt.err.points", { need: M.fmt(data.need), have: M.fmt(data.have) });
    if (r === "stock" && data?.stock != null) return t("mkt.err.stockLeft", { n: M.fmt(data.stock) });
    if (r === "city" && data?.city) return t("mkt.err.cityOnly", { city: data.city });
    return t(REASONS.includes(r) || r === "stock" || r === "city" ? `mkt.err.${r}` : "mkt.err.failed");
  };
  // A failed call (no answer, SQL missing…) or a refusal, as a sentence.
  M.failText = (res) => {
    if (res?.setup) return t("mkt.setupText");
    if (res?.network) return t("mkt.err.network");
    if (res?.ok && res.data && res.data.ok === false) return M.errText(res.data);
    return t("mkt.err.failed");
  };

  // ---------------------------------------------------------------- numbers, dates, places
  const locale = () => `${C.getLocale?.() || "en"}-u-nu-latn`;
  M.fmt = (n) => {
    try {
      return new Intl.NumberFormat(locale()).format(Number(n) || 0);
    } catch {
      return String(Number(n) || 0);
    }
  };
  M.pt = (n) => `${M.fmt(n)} PT`;
  // an amount inside a sentence: kept as "7,780 PT" in Arabic too (a bidi isolate)
  M.ptIn = (n) => `\u2066${M.pt(n)}\u2069`;
  // 1 point = 1 cent
  M.usd = (points) => {
    try {
      return new Intl.NumberFormat(locale(), { style: "currency", currency: "USD" }).format((Number(points) || 0) / 100);
    } catch {
      return `$${((Number(points) || 0) / 100).toFixed(2)}`;
    }
  };
  M.date = (v) => (v ? C.formatDate(v) : "");
  M.dateTime = (v) => {
    if (!v) return "";
    try {
      return new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(v));
    } catch {
      return String(v).slice(0, 16).replace("T", " ");
    }
  };
  M.country = (cc) => (cc ? C.countryName(cc) || cc : "");
  M.continent = (key) => (key ? t(`mkt.cont.${key}`) : "");
  // Where a store sells: "Casablanca, Morocco" / "Morocco" / "Africa" / "Worldwide"
  M.reachText = (s) => {
    if (!s) return "";
    if (s.scope === "world") return t("mkt.reach.world");
    if (s.scope === "continent") return M.continent(s.continent) || M.country(s.country);
    if (s.scope === "city") return [s.city, M.country(s.country)].filter(Boolean).join(t("mkt.listSep"));
    return M.country(s.country);
  };

  // ---------------------------------------------------------------- addresses
  // ---------------------------------------------------------------- the tier of a store
  // { code: N|K|M|B, pct, points, top, next } (sql/market.sql _mkt_tier): the points of its
  // successful orders. The progress: one decimal under 10% (K0.6%), then whole numbers (K25%).
  M.tierPct = (pct) => {
    const v = Math.max(0, Math.min(100, Number(pct) || 0));
    return v >= 10 ? String(Math.floor(v)) : String(Math.floor(v * 10) / 10);
  };
  M.tierTitle = (tier) =>
    tier ? t("mkt.tier.badge", { code: tier.code, pct: M.tierPct(tier.pct), points: M.fmt(tier.points) }) : "";
  M.tierHtml = (tier, { big = false } = {}) => {
    if (!tier || !tier.code) return "";
    const title = M.tierTitle(tier);
    return `<span class="mkt-tier t-${esc(tier.code)}${big ? " big" : ""}" title="${esc(title)}" aria-label="${esc(title)}" dir="ltr"><b>${esc(tier.code)}</b><span>${esc(M.tierPct(tier.pct))}%</span></span>`;
  };
  // The tier box of a store page: the badge, a bar and what is left to the next tier.
  M.tierBoxHtml = (tier) => {
    if (!tier || !tier.code) return "";
    const left = Math.max(0, Number(tier.top) - Number(tier.points));
    const pct = Math.max(0, Math.min(100, Number(tier.pct) || 0));
    const next = tier.next
      ? t("mkt.tier.toNext", { left: M.ptIn(left), next: tier.next })
      : pct >= 100 ? t("mkt.tier.top") : t("mkt.tier.toEnd", { left: M.ptIn(left) });
    return `
      <div class="mkt-tierbox" data-tierbox>
        <div class="mkt-tierbox-head">
          ${M.tierHtml(tier, { big: true })}
          <div>
            <b>${esc(t("mkt.tier.label"))}</b>
            <span class="muted">${esc(t("mkt.tier.sold", { points: M.ptIn(tier.points) }))}</span>
          </div>
        </div>
        <div class="mkt-tierbar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${esc(String(pct))}" aria-label="${esc(M.tierTitle(tier))}"><i style="width:${Math.max(pct, pct > 0 ? 1.5 : 0)}%"></i></div>
        <p class="muted mkt-tierbox-next">${esc(next)}</p>
        <details class="mkt-tierbox-help"><summary>${esc(t("mkt.tier.how"))}</summary><p>${esc(t("mkt.tier.help"))}</p></details>
      </div>`;
  };

  M.productHref = (id, ref = "") => `./Market.html?Product=${encodeURIComponent(id)}${ref ? `&@${encodeURIComponent(ref)}` : ""}`;
  M.storeHref = (id) => `./Market.html?Store=${encodeURIComponent(id)}`;
  M.categoryHref = (id) => `./Market.html?Categories=${encodeURIComponent(id)}`;
  M.profileHref = (u) => `./Profile.html?@${encodeURIComponent(String(u || "").replace(/^@/, ""))}`;
  M.absolute = (href) => new URL(href, location.href).href;
  M.signinHref = (back) => `./login.html?next=${encodeURIComponent(back || `Market.html${location.search}${location.hash}`)}`;

  // The embedded video of a product: YouTube, Vimeo, Dailymotion become their player; any
  // other https link is embedded as it is.
  M.videoEmbed = (url) => {
    let u;
    try {
      u = new URL(String(url || ""));
    } catch {
      return "";
    }
    if (!/^https?:$/.test(u.protocol)) return "";
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return `https://www.youtube-nocookie.com/embed/${u.pathname.slice(1)}`;
    if (/(^|\.)youtube(-nocookie)?\.com$/.test(host)) {
      const m = u.pathname.match(/^\/(embed|shorts|live)\/([\w-]+)/);
      const id = m ? m[2] : u.searchParams.get("v");
      return id ? `https://www.youtube-nocookie.com/embed/${id}` : "";
    }
    if (host === "vimeo.com") {
      const m = u.pathname.match(/(\d+)/);
      return m ? `https://player.vimeo.com/video/${m[1]}` : "";
    }
    if (host.endsWith("dailymotion.com")) {
      const m = u.pathname.match(/video\/([\w]+)/);
      return m ? `https://www.dailymotion.com/embed/video/${m[1]}` : "";
    }
    return u.href;
  };
  M.videoHtml = (url) => {
    const src = M.videoEmbed(url);
    if (!src) return "";
    if (/\.(mp4|webm|ogv|ogg)(\?|$)/i.test(src)) {
      return `<div class="mkt-video"><video controls preload="metadata" src="${esc(src)}"></video></div>`;
    }
    return `<div class="mkt-video"><iframe src="${esc(src)}" title="${esc(t("mkt.video"))}" loading="lazy" allowfullscreen allow="accelerometer; autoplay; encrypted-media; fullscreen; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"></iframe></div>`;
  };

  // ---------------------------------------------------------------- cards
  const images = (p) => (Array.isArray(p?.images) ? p.images.filter((x) => typeof x === "string" && x) : []);
  M.images = images;

  // The pictures as a slideshow: the arrows (several pictures) and the dots follow the scroll.
  M.slidesHtml = (imgs, href, { cls = "", label = "" } = {}) => {
    const multi = imgs.length > 1;
    const slides = imgs.length
      ? imgs.map((src, i) => `<a class="mkt-slide" href="${esc(href)}" data-nav ${i ? 'tabindex="-1"' : ""} aria-label="${esc(label)}"><img src="${esc(src)}" alt="" ${i ? 'loading="lazy"' : 'loading="lazy"'} /></a>`).join("")
      : `<a class="mkt-slide mkt-slide-empty" href="${esc(href)}" data-nav aria-label="${esc(label)}">${ICON.bigBag}</a>`;
    return `
      <div class="mkt-slider ${cls}" data-slider>
        <div class="mkt-slides" data-slides>${slides}</div>
        ${multi ? `
        <button class="mkt-sl mkt-sl-prev" type="button" data-sl="-1" aria-label="${esc(t("mkt.prevPic"))}">${ICON.left}</button>
        <button class="mkt-sl mkt-sl-next" type="button" data-sl="1" aria-label="${esc(t("mkt.nextPic"))}">${ICON.right}</button>
        <span class="mkt-dots" aria-hidden="true">${imgs.map((_, i) => `<i class="${i ? "" : "on"}"></i>`).join("")}</span>` : ""}
      </div>`;
  };

  M.cardHtml = (p) => {
    const href = M.productHref(p.id);
    const badges = [
      p.kind === "digital" ? `<span class="mkt-badge b-digital">${esc(t("mkt.kind.digital"))}</span>` : "",
      Number(p.stock) <= 0 ? `<span class="mkt-badge b-out">${esc(t("mkt.soldOut"))}</span>` : "",
      p.status === "hidden" ? `<span class="mkt-badge b-hidden">${esc(t("mkt.hidden"))}</span>` : "",
    ].join("");
    const user = p.seller?.username || "";
    return `
      <article class="mkt-card" data-product="${esc(p.id)}">
        <div class="mkt-card-media">
          ${M.slidesHtml(images(p), href, { label: p.title })}
          ${badges ? `<span class="mkt-badges">${badges}</span>` : ""}
        </div>
        <div class="mkt-card-body">
          <a class="mkt-card-title" href="${esc(href)}" data-nav dir="auto">${esc(p.title)}</a>
          <div class="mkt-price" dir="ltr">${esc(M.pt(p.price))}</div>
          <div class="mkt-card-meta">
            <time datetime="${esc(p.created_at || "")}">${esc(M.date(p.created_at))}</time>
            ${user ? `<span aria-hidden="true">·</span><a href="${esc(M.profileHref(user))}">@${esc(user)}</a>` : ""}
          </div>
        </div>
      </article>`;
  };

  M.storeCardHtml = (s) => `
    <a class="mkt-store-card" href="${esc(M.storeHref(s.id))}" data-nav>
      <span class="mkt-store-cover">${s.cover ? `<img src="${esc(s.cover)}" alt="" loading="lazy" />` : ""}</span>
      <img class="mkt-store-logo" src="${esc(s.logo || C.initialsAvatar(s.name || "CA"))}" alt="" loading="lazy" />
      <span class="mkt-store-body">
        <span class="mkt-store-name"><span dir="auto">${esc(s.name)}</span>${M.tierHtml(s.tier)}</span>
        <span class="mkt-store-meta">${esc([M.country(s.country), t(Number(s.products) === 1 ? "mkt.productsOne" : "mkt.productsN", { n: M.fmt(s.products) })].filter(Boolean).join(" · "))}</span>
        <span class="mkt-open ${s.open ? "on" : "off"}">${esc(t(s.open ? "mkt.open" : "mkt.closed"))}</span>
      </span>
    </a>`;

  M.categoryCardHtml = (c) => {
    const imgs = (Array.isArray(c.images) ? c.images : []).filter(Boolean).slice(0, 4);
    return `
      <a class="mkt-cat-card" href="${esc(M.categoryHref(c.id))}" data-nav>
        <span class="mkt-cat-mosaic n${imgs.length}">${imgs.length ? imgs.map((src) => `<img src="${esc(src)}" alt="" loading="lazy" />`).join("") : ICON.bigBag}</span>
        <span class="mkt-cat-name" dir="auto">${esc(c.name)}</span>
        <span class="mkt-cat-meta">${esc(t(Number(c.products) === 1 ? "mkt.productsOne" : "mkt.productsN", { n: M.fmt(c.products) }))}</span>
      </a>`;
  };

  // Arrows and dots of every slideshow and row (one listener for the page).
  function slideBy(track, dir) {
    const rtl = getComputedStyle(track).direction === "rtl";
    track.scrollBy({ left: dir * track.clientWidth * (rtl ? -1 : 1), behavior: "smooth" });
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-sl]");
    if (b) {
      e.preventDefault();
      const track = b.closest("[data-slider]")?.querySelector("[data-slides]");
      if (track) slideBy(track, Number(b.dataset.sl));
      return;
    }
    const r = e.target.closest("[data-row-go]");
    if (r) {
      const track = r.closest("[data-row]")?.querySelector("[data-row-track]");
      if (!track) return;
      const rtl = getComputedStyle(track).direction === "rtl";
      track.scrollBy({ left: Number(r.dataset.rowGo) * track.clientWidth * 0.85 * (rtl ? -1 : 1), behavior: "smooth" });
    }
  });
  document.addEventListener(
    "scroll",
    (e) => {
      const track = e.target?.closest?.("[data-slides]");
      if (!track) return;
      const dots = track.parentElement.querySelectorAll(".mkt-dots i");
      if (!dots.length) return;
      const i = Math.round(Math.abs(track.scrollLeft) / Math.max(1, track.clientWidth));
      dots.forEach((d, k) => d.classList.toggle("on", k === i));
    },
    true
  );

  // ---------------------------------------------------------------- dialogs
  M.modal = (html, { cls = "", label = "" } = {}) => {
    document.querySelectorAll(".mkt-modal-back").forEach((x) => x.close?.());
    const wrap = document.createElement("div");
    wrap.className = "mkt-modal-back";
    wrap.innerHTML = `<section class="glass mkt-modal ${cls}" role="dialog" aria-modal="true" aria-label="${esc(label)}">${html}</section>`;
    const onKey = (e) => {
      if (e.key === "Escape") close();
    };
    function close() {
      wrap.remove();
      document.removeEventListener("keydown", onKey);
      if (!document.querySelector(".mkt-modal-back, .mkt-zoom")) document.documentElement.classList.remove("mkt-noscroll");
    }
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap || e.target.closest("[data-close]")) close();
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(wrap);
    document.documentElement.classList.add("mkt-noscroll");
    wrap.close = close;
    setTimeout(() => wrap.querySelector("[autofocus], input:not([type=hidden]):not([readonly]), textarea, select")?.focus(), 40);
    return wrap;
  };
  const head = (title) => `
    <header class="mkt-modal-head">
      <h2>${esc(title)}</h2>
      <button class="mkt-x" type="button" data-close aria-label="${esc(t("common.close"))}">${ICON.close}</button>
    </header>`;
  M.modalHead = head;

  // A short text asked before an action (why an order is declined, the tracking number…).
  // -> Promise<string | null>
  M.openNote = ({ title, label, hint = "", placeholder = "", required = true, min = 2, confirm = t("common.save"), danger = false }) =>
    new Promise((resolve) => {
      let done = false;
      const wrap = M.modal(`
        ${head(title)}
        <form class="mkt-form" data-note>
          <label class="mkt-field"><span>${esc(label)}${required ? " *" : ""}</span>
            <textarea name="note" dir="auto" rows="4" maxlength="1000" placeholder="${esc(placeholder)}"></textarea></label>
          ${hint ? `<p class="muted">${esc(hint)}</p>` : ""}
          <p class="mkt-form-err" data-err role="alert"></p>
          <div class="mkt-form-acts">
            <button class="btn btn-ghost" type="button" data-close>${esc(t("common.cancel"))}</button>
            <button class="btn ${danger ? "btn-danger" : "btn-primary"}" type="submit">${esc(confirm)}</button>
          </div>
        </form>`, { cls: "mkt-modal-sm", label: title });
      const form = wrap.querySelector("[data-note]");
      const finish = (v) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      const obs = new MutationObserver(() => {
        if (!wrap.isConnected) {
          obs.disconnect();
          finish(null);
        }
      });
      obs.observe(document.body, { childList: true });
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const v = form.note.value.trim();
        if (required && v.length < min) {
          form.querySelector("[data-err]").textContent = t("mkt.err.note");
          return;
        }
        finish(v);
        wrap.close();
      });
    });

  // The pictures of a product, full screen: arrows, keys, a click zooms in.
  M.openZoom = (imgs, start = 0) => {
    if (!imgs.length) return;
    let i = Math.max(0, Math.min(imgs.length - 1, start));
    const box = document.createElement("div");
    box.className = "mkt-zoom";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", t("mkt.photos"));
    box.innerHTML = `
      <button class="mkt-zoom-x" type="button" data-zx aria-label="${esc(t("common.close"))}">${ICON.close}</button>
      ${imgs.length > 1 ? `<button class="mkt-zoom-nav prev" type="button" data-zgo="-1" aria-label="${esc(t("mkt.prevPic"))}">${ICON.left}</button>
      <button class="mkt-zoom-nav next" type="button" data-zgo="1" aria-label="${esc(t("mkt.nextPic"))}">${ICON.right}</button>` : ""}
      <figure class="mkt-zoom-stage"><img data-zimg alt="" /></figure>
      <span class="mkt-zoom-count" data-zcount></span>`;
    const img = box.querySelector("[data-zimg]");
    const show = () => {
      img.classList.remove("zoomed");
      img.style.transformOrigin = "";
      img.src = imgs[i];
      box.querySelector("[data-zcount]").textContent = imgs.length > 1 ? `${i + 1} / ${imgs.length}` : "";
    };
    const go = (d) => {
      i = (i + d + imgs.length) % imgs.length;
      show();
    };
    const onKey = (e) => {
      if (e.key === "Escape") close();
      const rtl = document.documentElement.dir === "rtl";
      if (e.key === "ArrowRight") go(rtl ? -1 : 1);
      if (e.key === "ArrowLeft") go(rtl ? 1 : -1);
    };
    function close() {
      box.remove();
      document.removeEventListener("keydown", onKey);
      if (!document.querySelector(".mkt-modal-back, .mkt-zoom")) document.documentElement.classList.remove("mkt-noscroll");
    }
    box.addEventListener("click", (e) => {
      if (e.target.closest("[data-zx]") || e.target === box) return close();
      const g = e.target.closest("[data-zgo]");
      if (g) return go(Number(g.dataset.zgo));
      if (e.target === img) {
        const r = img.getBoundingClientRect();
        img.style.transformOrigin = `${((e.clientX - r.left) / r.width) * 100}% ${((e.clientY - r.top) / r.height) * 100}%`;
        img.classList.toggle("zoomed");
      }
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(box);
    document.documentElement.classList.add("mkt-noscroll");
    show();
    box.querySelector("[data-zx]").focus();
  };

  // ---------------------------------------------------------------- share
  // own: the seller's own product (the seller pays the commission, never earns it)
  M.openShare = ({ product, own = false }) => {
    const me = M.username();
    const link = M.absolute(M.productHref(product.id, me));
    const text = product.title;
    const enc = encodeURIComponent;
    const nets = [
      ["facebook", "Facebook", `https://www.facebook.com/sharer/sharer.php?u=${enc(link)}`],
      ["x", "X", `https://twitter.com/intent/tweet?url=${enc(link)}&text=${enc(text)}`],
      ["whatsapp", "WhatsApp", `https://wa.me/?text=${enc(`${text} ${link}`)}`],
      ["telegram", "Telegram", `https://t.me/share/url?url=${enc(link)}&text=${enc(text)}`],
      ["pinterest", "Pinterest", `https://pinterest.com/pin/create/button/?url=${enc(link)}&description=${enc(text)}`],
      ["email", t("mkt.email"), `mailto:?subject=${enc(text)}&body=${enc(link)}`],
    ];
    // the product's share commission, chosen by its seller (0: none)
    const pct = Math.max(0, Math.min(25, Math.floor(Number(product.commission) || 0)));
    const earn = M.commissionOf(product.price, pct);
    let intro = "";
    if (own) {
      const text = pct ? t("mkt.f.commissionCalc", { pts: M.pt(earn), net: M.pt(Number(product.price || 0) - earn) }) : t("mkt.f.commissionNone");
      intro = `<p class="muted mkt-share-none">${esc(text)}</p>`;
    } else if (pct && me) intro = `<p class="mkt-share-earn">${ICON.coins}<span>${esc(t("mkt.shareEarn", { pts: M.pt(earn), usd: M.usd(earn) }))}</span></p>`;
    else if (pct) intro = `<p class="muted">${esc(t("mkt.shareGuest", { pct }))} <a href="${esc(M.signinHref())}">${esc(t("nav.signin"))}</a></p>`;
    else if (me) intro = `<p class="muted mkt-share-none">${esc(t("mkt.shareNone"))}</p>`;
    const wrap = M.modal(`
      ${head(t("mkt.shareTitle"))}
      <div class="mkt-share">
        ${intro}
        <label class="mkt-field"><span>${esc(t("mkt.shareLink"))}</span>
          <span class="mkt-copy"><input type="text" readonly dir="ltr" value="${esc(link)}" data-share-link />
          <button class="btn btn-sm btn-primary" type="button" data-copy>${ICON.copy}<span>${esc(t("mkt.copy"))}</span></button></span></label>
        <div class="mkt-share-nets">
          ${nets.map(([k, name, href]) => `<a class="mkt-net n-${k}" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(name)}</a>`).join("")}
          ${navigator.share ? `<button class="mkt-net n-more" type="button" data-native>${esc(t("mkt.shareMore"))}</button>` : ""}
        </div>
        ${me && pct && !own ? `<p class="muted mkt-share-note">${esc(t("mkt.shareNote", { pct }))}</p>` : ""}
      </div>`, { cls: "mkt-modal-sm", label: t("mkt.shareTitle") });
    wrap.querySelector("[data-copy]").addEventListener("click", async () => {
      const input = wrap.querySelector("[data-share-link]");
      try {
        await navigator.clipboard.writeText(input.value);
      } catch {
        input.select();
        document.execCommand?.("copy");
      }
      C.toast(t("mkt.copied"));
    });
    wrap.querySelector("[data-native]")?.addEventListener("click", () => navigator.share({ title: text, url: link }).catch(() => {}));
  };

  // ---------------------------------------------------------------- the product form
  const MAX_PICS = 8;
  const MAX_CATS = 5;
  // The share commission of a product: chosen by its seller, 1 to 25% of the price, paid from
  // the seller's points to the member whose link brought the sale (sql/market.sql).
  const MAX_COMMISSION = 25;
  const commissionOk = (v) => Number.isInteger(v) && v >= 1 && v <= MAX_COMMISSION;
  // what the member who shared it receives for one piece
  M.commissionOf = (price, pct) => (commissionOk(Number(pct)) ? Math.floor((Number(price) || 0) * Number(pct) / 100) : 0);

  function chipsHtml(list) {
    return list
      .map((c, i) => `<span class="mkt-chip-x">${esc(c)}<button type="button" data-cat-del="${i}" aria-label="${esc(t("pic.remove"))}">${ICON.close}</button></span>`)
      .join("");
  }

  // A product's pictures go up after the save, named after its id (sql/image_uploads.sql).
  async function storeProductPictures(ctrl, id) {
    if (!ctrl?.pending()) return "";
    ctrl.say(t("pic.uploading"));
    const up = await C.uploadPictures(ctrl, {
      folder: "Market/Product",
      id,
      ticket: async (names) => {
        const r = await M.call("market_upload", { p_member: M.memberId(), p_kind: "product", p_id: id, p_names: names });
        return Boolean(r.ok && r.data?.ok);
      },
    });
    const r = await M.call("market_images", { p_member: M.memberId(), p_kind: "product", p_id: id, p_urls: up.urls });
    if (!r.ok || !r.data?.ok) return t("pic.errSave");
    if (!up.ok) return up.reason === "ticket" ? t("pic.errSetup") : `${t("pic.someFailed", { n: up.failed })} ${C.pictureErrorText(up.reason)}`;
    ctrl.say(t("pic.uploaded"), "ok");
    return "";
  }

  // Add (no product) or change a product. store: the member's store (shipping on/off), or null.
  M.openProductForm = ({ product = null, store = null, onSaved = null } = {}) => {
    const p = product || {};
    const editing = Boolean(p.id);
    let cats = (Array.isArray(p.categories) ? p.categories : []).map((c) => (typeof c === "string" ? c : c?.name)).filter(Boolean).slice(0, MAX_CATS);
    const kind = p.kind === "digital" ? "digital" : "physical";
    const ships = store ? store.shipping !== false : true;
    // off for a new product; the percentage chosen before is kept while it is off
    const cOn = typeof p.commission_on === "boolean" ? p.commission_on : Number(p.commission) > 0;
    const cPct = commissionOk(Number(p.commission_pct)) ? Number(p.commission_pct) : commissionOk(Number(p.commission)) ? Number(p.commission) : 10;
    const wrap = M.modal(`
      ${head(t(editing ? "mkt.editProduct" : "mkt.addProduct"))}
      <form class="mkt-form" data-pform novalidate>
        <label class="mkt-field"><span>${esc(t("mkt.f.title"))} *</span>
          <input name="title" dir="auto" maxlength="120" required value="${esc(p.title || "")}" placeholder="${esc(t("mkt.f.titlePh"))}" /></label>
        <label class="mkt-field"><span>${esc(t("mkt.f.description"))}</span>
          <textarea name="description" dir="auto" rows="5" maxlength="5000" placeholder="${esc(t("mkt.f.descriptionPh"))}">${esc(p.description || "")}</textarea></label>
        <fieldset class="mkt-field mkt-seg"><legend>${esc(t("mkt.f.kind"))}</legend>
          <label><input type="radio" name="kind" value="physical" ${kind === "physical" ? "checked" : ""} /><span>${ICON.truck}${esc(t("mkt.kind.physical"))}</span></label>
          <label><input type="radio" name="kind" value="digital" ${kind === "digital" ? "checked" : ""} /><span>${ICON.cloud}${esc(t("mkt.kind.digital"))}</span></label>
        </fieldset>
        <div class="mkt-form-row">
          <label class="mkt-field"><span>${esc(t("mkt.f.price"))} *</span>
            <input name="price" type="number" min="1" max="10000000" step="1" inputmode="numeric" required value="${esc(p.price ?? "")}" /></label>
          <label class="mkt-field"><span>${esc(t("mkt.f.stock"))} *</span>
            <input name="stock" type="number" min="0" max="100000" step="1" inputmode="numeric" required value="${esc(p.stock ?? 1)}" /></label>
          <label class="mkt-field" data-ship-cost ${kind === "digital" ? "hidden" : ""}><span>${esc(t("mkt.f.shipping"))}</span>
            <input name="shipping_cost" type="number" min="0" max="1000000" step="1" inputmode="numeric" value="${esc(p.shipping_cost ?? 0)}" /></label>
        </div>
        <p class="muted mkt-f-hint" data-price-hint></p>
        ${!ships ? `<p class="muted mkt-f-hint">${esc(t("mkt.f.noShipHint"))}</p>` : ""}
        <div class="mkt-field mkt-f-download" data-download ${kind === "digital" ? "" : "hidden"}>
          <label class="mkt-field"><span>${ICON.lock} ${esc(t("mkt.f.download"))}</span>
            <input name="download_url" type="url" dir="ltr" maxlength="500" value="${esc(p.download_url || "")}" placeholder="https://…" /></label>
          <p class="muted mkt-f-hint">${esc(t("mkt.f.downloadHint"))}</p>
        </div>
        <fieldset class="mkt-field mkt-seg"><legend>${esc(t("mkt.f.commission"))}</legend>
          <label><input type="radio" name="commission_on" value="1" ${cOn ? "checked" : ""} /><span>${esc(t("mkt.f.commissionOn"))}</span></label>
          <label><input type="radio" name="commission_on" value="0" ${cOn ? "" : "checked"} /><span>${esc(t("mkt.f.commissionOff"))}</span></label>
        </fieldset>
        <label class="mkt-field mkt-f-pct" data-commission ${cOn ? "" : "hidden"}><span>${esc(t("mkt.f.commissionPct"))} *</span>
          <input name="commission_pct" type="number" min="1" max="${MAX_COMMISSION}" step="1" inputmode="numeric" value="${esc(cPct)}" /></label>
        <p class="muted mkt-f-hint" data-commission-hint></p>
        <div class="mkt-field">
          <span id="mkt-cats-label">${esc(t("mkt.f.categories"))} *</span>
          <div class="mkt-chips-in" data-cats>
            <span data-cat-chips>${chipsHtml(cats)}</span>
            <input list="mkt-cat-list" data-cat-in dir="auto" maxlength="40" aria-labelledby="mkt-cats-label" placeholder="${esc(t("mkt.f.categoriesPh"))}" />
            <datalist id="mkt-cat-list"></datalist>
          </div>
          <p class="muted mkt-f-hint">${esc(t("mkt.f.categoriesHint", { n: MAX_CATS }))}</p>
        </div>
        ${C.pictureFieldHtml({ label: t("mkt.f.pictures"), hint: t("mkt.f.picturesHint", { n: MAX_PICS }), values: images(p), max: MAX_PICS })}
        <label class="mkt-field"><span>${esc(t("mkt.f.video"))}</span>
          <input name="video_url" type="url" dir="ltr" maxlength="500" value="${esc(p.video_url || "")}" placeholder="https://www.youtube.com/watch?v=…" /></label>
        <p class="mkt-form-err" data-err role="alert"></p>
        <div class="mkt-form-acts">
          <button class="btn btn-ghost" type="button" data-close>${esc(t("common.cancel"))}</button>
          <button class="btn btn-primary" type="submit" data-save>${esc(t(editing ? "common.save" : "mkt.publishProduct"))}</button>
        </div>
      </form>`, { cls: "mkt-modal-wide", label: t(editing ? "mkt.editProduct" : "mkt.addProduct") });
    const form = wrap.querySelector("[data-pform]");
    const pics = C.wirePictureField(form.querySelector("[data-pcf]"), { maxSide: 1600 });
    const err = form.querySelector("[data-err]");
    const catIn = form.querySelector("[data-cat-in]");
    const catChips = form.querySelector("[data-cat-chips]");
    const priceHint = form.querySelector("[data-price-hint]");
    const drawCats = () => {
      catChips.innerHTML = chipsHtml(cats);
      catIn.disabled = cats.length >= MAX_CATS;
      catIn.placeholder = cats.length >= MAX_CATS ? t("mkt.f.categoriesFull") : t("mkt.f.categoriesPh");
    };
    const addCat = () => {
      const v = catIn.value.replace(/[,،]/g, " ").replace(/\s+/g, " ").trim();
      if (!v) return;
      if (v.length < 2 || v.length > 40) {
        err.textContent = t("mkt.err.categories");
        return;
      }
      if (!cats.some((c) => c.toLowerCase() === v.toLowerCase()) && cats.length < MAX_CATS) cats.push(v);
      catIn.value = "";
      err.textContent = "";
      drawCats();
    };
    catIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "," || e.key === "،") {
        e.preventDefault();
        addCat();
      } else if (e.key === "Backspace" && !catIn.value && cats.length) {
        cats.pop();
        drawCats();
      }
    });
    catIn.addEventListener("change", addCat);
    catIn.addEventListener("blur", addCat);
    let sugTimer = 0;
    catIn.addEventListener("input", () => {
      clearTimeout(sugTimer);
      sugTimer = setTimeout(async () => {
        const r = await M.call("market_categories", { p_q: catIn.value.trim(), p_limit: 12 });
        const list = r.ok && Array.isArray(r.data) ? r.data : [];
        form.querySelector("#mkt-cat-list").innerHTML = list.map((c) => `<option value="${esc(c.name)}"></option>`).join("");
      }, 220);
    });
    catChips.addEventListener("click", (e) => {
      const b = e.target.closest("[data-cat-del]");
      if (!b) return;
      cats.splice(Number(b.dataset.catDel), 1);
      drawCats();
    });
    drawCats();
    catIn.dispatchEvent(new Event("input"));
    const commissionHint = form.querySelector("[data-commission-hint]");
    const commissionIsOn = () => form.commission_on.value === "1";
    // the price in dollars, and what the commission takes from one piece
    const showPrice = () => {
      const v = Number(form.price.value) || 0;
      priceHint.textContent = v > 0 ? t("mkt.f.priceUsd", { usd: M.usd(v) }) : "";
      const on = commissionIsOn();
      form.querySelector("[data-commission]").hidden = !on;
      if (!on) {
        commissionHint.textContent = t("mkt.f.commissionNone");
        return;
      }
      const pct = Number(form.commission_pct.value);
      const cut = M.commissionOf(v, pct);
      commissionHint.textContent = commissionOk(pct) && v > 0
        ? `${t("mkt.f.commissionHint")} ${t("mkt.f.commissionCalc", { pts: M.pt(cut), net: M.pt(v - cut) })}`
        : t("mkt.f.commissionHint");
    };
    form.price.addEventListener("input", showPrice);
    form.commission_pct.addEventListener("input", showPrice);
    showPrice();
    form.addEventListener("change", (e) => {
      if (e.target.name === "kind") {
        form.querySelector("[data-ship-cost]").hidden = form.kind.value === "digital";
        form.querySelector("[data-download]").hidden = form.kind.value !== "digital";
      }
      if (e.target.name === "commission_on") {
        showPrice();
        if (commissionIsOn()) form.commission_pct.focus();
      }
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      addCat();
      err.textContent = "";
      const d = {
        title: form.title.value.trim(),
        description: form.description.value.trim(),
        kind: form.kind.value,
        price: form.price.value.trim(),
        stock: form.stock.value.trim(),
        shipping_cost: form.kind.value === "digital" ? "0" : form.shipping_cost.value.trim() || "0",
        categories: cats.slice(),
        images: pics.urls(),
        video_url: form.video_url.value.trim(),
        commission_on: commissionIsOn(),
        commission_pct: form.commission_pct.value.trim(),
      };
      if (editing) d.id = p.id;
      // the private download link (digital); a product opened without it (not from Your
      // products / its page) leaves it as it is unless something was typed
      const dl = form.download_url.value.trim();
      if (d.kind === "digital" && (!editing || typeof p.download_url === "string" || dl)) d.download_url = dl;
      const bad =
        (d.title.length < 3 && "title") ||
        (!(Number(d.price) >= 1) && "price") ||
        (!(Number(d.stock) >= 0) || d.stock === "" ? "stock" : "") ||
        (!cats.length && "categories") ||
        (d.video_url && !/^https?:\/\/\S+$/i.test(d.video_url) && "video") ||
        (d.download_url && !/^https?:\/\/[^\s<>"']+$/i.test(d.download_url) && "download") ||
        (d.commission_on && !(d.commission_pct !== "" && commissionOk(Number(d.commission_pct))) && "commission");
      if (bad) {
        err.textContent = M.errText({ reason: bad });
        const field = { categories: "kind", video: "video_url", commission: "commission_pct", download: "download_url" }[bad] || bad;
        form.querySelector(`[name="${field}"]`)?.focus?.();
        if (bad === "categories") catIn.focus();
        return;
      }
      const btn = form.querySelector("[data-save]");
      btn.disabled = true;
      const r = await M.call("market_product_save", { p_member: M.memberId(), d });
      if (!r.ok || !r.data?.ok) {
        btn.disabled = false;
        err.textContent = M.failText(r);
        return;
      }
      const id = r.data.id;
      const picErr = await storeProductPictures(pics, id);
      btn.disabled = false;
      if (picErr) {
        // saved; the pictures that did not go up stay in the field, to try again
        err.textContent = `${t(editing ? "mkt.productSaved" : "mkt.productAdded")} ${picErr}`;
        p.id = id;
        onSaved?.(id, { created: r.data.created, partial: true });
        return;
      }
      wrap.close();
      C.toast(t(editing || !r.data.created ? "mkt.productSaved" : "mkt.productAdded"));
      onSaved?.(id, { created: r.data.created });
    });
    return wrap;
  };

  // ---------------------------------------------------------------- store settings
  const SCOPES = ["city", "country", "continent", "world"];
  M.storeFormHtml = (store, member) => {
    const s = store || {};
    const cc = s.country || member?.country || C.currentCountry?.() || "";
    const links = Array.isArray(s.links) && s.links.length ? s.links : [{ label: "", url: "" }];
    const yes = (name, v, on, off, val = v) => `
      <fieldset class="mkt-field mkt-seg"><legend>${esc(t(`mkt.s.${name}`))}</legend>
        <label><input type="radio" name="${name}" value="1" ${val ? "checked" : ""} /><span>${esc(t(on))}</span></label>
        <label><input type="radio" name="${name}" value="0" ${val ? "" : "checked"} /><span>${esc(t(off))}</span></label>
      </fieldset>`;
    return `
      <form class="mkt-form mkt-store-form" data-sform novalidate>
        <div class="mkt-form-2">
          <div data-logo>${C.pictureFieldHtml({ label: t("mkt.s.logo"), hint: t("mkt.s.logoHint"), values: [s.logo].filter(Boolean), max: 1, shape: "square" })}</div>
          <div data-cover>${C.pictureFieldHtml({ label: t("mkt.s.cover"), hint: t("mkt.s.coverHint"), values: [s.cover].filter(Boolean), max: 1 })}</div>
        </div>
        <label class="mkt-field"><span>${esc(t("mkt.s.name"))} *</span>
          <input name="name" dir="auto" maxlength="60" required value="${esc(s.name || member?.username || "")}" /></label>
        <label class="mkt-field"><span>${esc(t("mkt.s.description"))}</span>
          <textarea name="description" dir="auto" rows="4" maxlength="2000" placeholder="${esc(t("mkt.s.descriptionPh"))}">${esc(s.description || "")}</textarea></label>
        <div class="mkt-field">
          <span>${esc(t("mkt.s.links"))}</span>
          <div class="mkt-links-in" data-links>
            ${links.map((l) => linkRowHtml(l)).join("")}
          </div>
          <div><button class="btn btn-sm btn-ghost" type="button" data-link-add>${ICON.plus}<span>${esc(t("mkt.s.addLink"))}</span></button></div>
          <p class="muted mkt-f-hint">${esc(t("mkt.s.linksHint"))}</p>
        </div>
        <fieldset class="mkt-field mkt-seg"><legend>${esc(t("mkt.s.open"))}</legend>
          <label><input type="radio" name="is_open" value="1" ${s.is_open === false ? "" : "checked"} /><span>${esc(t("mkt.open"))}</span></label>
          <label><input type="radio" name="is_open" value="0" ${s.is_open === false ? "checked" : ""} /><span>${esc(t("mkt.closed"))}</span></label>
        </fieldset>
        <p class="muted mkt-f-hint">${esc(t("mkt.s.openHint"))}${store ? ` <b class="mkt-open ${s.open ? "on" : "off"}">${esc(t(s.open ? "mkt.s.nowOpen" : "mkt.s.nowClosed"))}</b>` : ""}</p>
        <fieldset class="mkt-field mkt-seg mkt-seg-4"><legend>${esc(t("mkt.s.scope"))}</legend>
          ${SCOPES.map((k) => `<label><input type="radio" name="scope" value="${k}" ${(s.scope || "country") === k ? "checked" : ""} /><span>${esc(t(`mkt.scope.${k}`))}</span></label>`).join("")}
        </fieldset>
        <div class="mkt-form-row">
          <label class="mkt-field"><span>${esc(t("mkt.s.country"))} *</span>
            <select name="country">${C.countryChoices().map(([code, name]) => `<option value="${code}" ${code === cc ? "selected" : ""}>${esc(name)}</option>`).join("")}</select></label>
          <label class="mkt-field"><span>${esc(t("mkt.s.city"))}<b data-city-star ${s.scope === "city" ? "" : "hidden"}> *</b></span>
            <input name="city" dir="auto" maxlength="80" value="${esc(s.city || "")}" /></label>
        </div>
        <fieldset class="mkt-field mkt-seg"><legend>${esc(t("mkt.s.sale"))}</legend>
          <label><input type="radio" name="sale_mode" value="instant" ${s.sale_mode === "request" ? "" : "checked"} /><span>${esc(t("mkt.sale.instant"))}</span></label>
          <label><input type="radio" name="sale_mode" value="request" ${s.sale_mode === "request" ? "checked" : ""} /><span>${esc(t("mkt.sale.request"))}</span></label>
        </fieldset>
        ${yes("shipping", s.shipping !== false, "mkt.s.shipYes", "mkt.s.shipNo")}
        ${yes("returns", Boolean(s.returns), "mkt.s.returnsYes", "mkt.s.returnsNo")}
        <label class="mkt-field" data-days ${s.returns ? "" : "hidden"}><span>${esc(t("mkt.s.returnDays"))} *</span>
          <input name="return_days" type="number" min="1" max="90" step="1" inputmode="numeric" value="${esc(s.return_days || 7)}" /></label>
        <p class="mkt-form-err" data-err role="alert"></p>
        <div class="mkt-form-acts">
          ${store ? `<a class="btn btn-ghost" href="${esc(M.storeHref(store.id))}" data-nav>${esc(t("mkt.viewStore"))}</a>` : ""}
          <button class="btn btn-primary" type="submit" data-save>${esc(t(store ? "common.save" : "mkt.s.create"))}</button>
        </div>
      </form>`;
  };
  function linkRowHtml(l = {}) {
    return `
      <div class="mkt-link-row" data-link-row>
        <input data-l="label" dir="auto" maxlength="40" value="${esc(l.label || "")}" placeholder="${esc(t("mkt.s.linkLabel"))}" />
        <input data-l="url" type="url" dir="ltr" maxlength="500" value="${esc(l.url || "")}" placeholder="https://…" />
        <button class="mkt-x" type="button" data-link-del aria-label="${esc(t("pic.remove"))}">${ICON.close}</button>
      </div>`;
  }

  // Saves the store (and uploads the logo / cover picked on the device). onSaved(storeId)
  M.wireStoreForm = (root, { onSaved = null } = {}) => {
    const form = root.querySelector("[data-sform]");
    if (!form) return;
    const logo = C.wirePictureField(form.querySelector("[data-logo] [data-pcf]"), { maxSide: 512, square: true });
    const cover = C.wirePictureField(form.querySelector("[data-cover] [data-pcf]"), { maxSide: 1920 });
    const err = form.querySelector("[data-err]");
    const links = form.querySelector("[data-links]");
    form.querySelector("[data-link-add]").addEventListener("click", () => {
      if (links.querySelectorAll("[data-link-row]").length >= 8) return;
      links.insertAdjacentHTML("beforeend", linkRowHtml());
    });
    links.addEventListener("click", (e) => {
      if (e.target.closest("[data-link-del]")) e.target.closest("[data-link-row]").remove();
    });
    form.addEventListener("change", (e) => {
      if (e.target.name === "returns") form.querySelector("[data-days]").hidden = form.returns.value !== "1";
      if (e.target.name === "scope") form.querySelector("[data-city-star]").hidden = form.scope.value !== "city";
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      const d = {
        name: form.name.value.trim(),
        description: form.description.value.trim(),
        links: [...links.querySelectorAll("[data-link-row]")]
          .map((row) => ({ label: row.querySelector('[data-l="label"]').value.trim(), url: row.querySelector('[data-l="url"]').value.trim() }))
          .filter((l) => l.url),
        is_open: form.is_open.value === "1",
        scope: form.scope.value,
        country: form.country.value,
        city: form.city.value.trim(),
        sale_mode: form.sale_mode.value,
        shipping: form.shipping.value === "1",
        returns: form.returns.value === "1",
        return_days: form.returns.value === "1" ? form.return_days.value.trim() : "0",
        logo_url: logo.urls()[0] || "",
        cover_url: cover.urls()[0] || "",
      };
      const bad =
        (d.name.length < 2 && "name") ||
        (d.links.some((l) => !/^https?:\/\/\S+$/i.test(l.url)) && "links") ||
        (d.scope === "city" && d.city.length < 2 && "city") ||
        (d.returns && !(Number(d.return_days) >= 1 && Number(d.return_days) <= 90) && "return_days");
      if (bad) {
        err.textContent = M.errText({ reason: bad });
        return;
      }
      const btn = form.querySelector("[data-save]");
      btn.disabled = true;
      const r = await M.call("market_store_save", { p_member: M.memberId(), d });
      if (!r.ok || !r.data?.ok) {
        btn.disabled = false;
        err.textContent = M.failText(r);
        return;
      }
      const id = r.data.id;
      const msgs = [];
      for (const [ctrl, kind] of [[logo, "logo"], [cover, "cover"]]) {
        if (!ctrl.pending()) continue;
        ctrl.say(t("pic.uploading"));
        const up = await C.uploadPictures(ctrl, {
          folder: kind === "logo" ? "Market/Logo" : "Market/Cover",
          id,
          ticket: async (names) => {
            const tk = await M.call("market_upload", { p_member: M.memberId(), p_kind: kind, p_id: id, p_names: names });
            return Boolean(tk.ok && tk.data?.ok);
          },
        });
        if (up.urls.length) {
          const s = await M.call("market_images", { p_member: M.memberId(), p_kind: kind, p_id: id, p_urls: up.urls.slice(0, 1) });
          if (!s.ok || !s.data?.ok) msgs.push(t("pic.errSave"));
        }
        if (!up.ok) msgs.push(up.reason === "ticket" ? t("pic.errSetup") : C.pictureErrorText(up.reason));
        else ctrl.say(t("pic.uploaded"), "ok");
      }
      btn.disabled = false;
      if (msgs.length) err.textContent = `${t("mkt.storeSaved")} ${msgs.join(" ")}`;
      else C.toast(t(r.data.created ? "mkt.storeCreated" : "mkt.storeSaved"));
      onSaved?.(id, { created: r.data.created });
    });
  };

  // ---------------------------------------------------------------- the delivery address
  // Never asked at checkout: once a physical order is sold (at once in an instant store, when
  // the seller accepts in the others) the address saved in the profile goes with it, or the
  // buyer gives it in Your purchases (M.openAddress).
  const ADDR_KEY = "cineaura_market_addr"; // the last address typed (fills the form next time)
  const readAddr = () => {
    try {
      return JSON.parse(localStorage.getItem(ADDR_KEY) || "{}") || {};
    } catch {
      return {};
    }
  };
  const keepAddr = (a) => {
    try {
      localStorage.setItem(ADDR_KEY, JSON.stringify({ name: a.name || "", phone: a.phone || "", city: a.city || "", line: a.line || "" }));
    } catch {
      /* storage unavailable */
    }
  };
  // Arabic-Indic digits as 0-9 (the server does the same)
  M.digits = (v) =>
    String(v ?? "")
      .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x660))
      .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x6f0));
  M.phoneOk = (v) => {
    const x = M.digits(v).trim();
    const n = x.replace(/\D/g, "").length;
    return /^\+?[0-9 ()./-]{5,30}$/.test(x) && n >= 5 && n <= 20;
  };
  M.addressText = (a) => (a ? [a.name, a.phone, [a.line, a.city].filter(Boolean).join(", ")].filter(Boolean).join(" · ") : "");
  M.addressHref = "./dashboard.html#address";
  // The address saved in the profile -> { name, phone, city, line } | null (asked once a page)
  let savedAddr;
  M.savedAddress = async (fresh = false) => {
    if (!M.memberId()) return null;
    if (savedAddr !== undefined && !fresh) return savedAddr;
    const r = await M.call("market_address", { p_member: M.memberId() });
    if (!r.ok || !r.data?.ok) return null;
    savedAddr = r.data.address || null;
    return savedAddr;
  };

  // The buyer's address for a sold physical order: name and phone, the city and the street when
  // the store ships; "keep it in my profile" for the next orders. -> calls onSaved(result)
  M.openAddress = async ({ order, onSaved = null }) => {
    const o = order || {};
    const ships = o.delivery !== "hand";
    const cur = o.address && o.address.name ? o.address : null;
    const saved = await M.savedAddress();
    const a = cur || saved || readAddr();
    const cityOnly = o.city_only || "";
    const title = t(cur ? "mkt.ad.change" : "mkt.ad.title");
    const wrap = M.modal(`
      ${head(title)}
      <form class="mkt-form" data-addr novalidate>
        <div class="mkt-co-item">
          <img src="${esc(o.image || C.initialsAvatar(o.title || "CA"))}" alt="" />
          <div><b dir="auto">${esc(o.title || "")}</b><span class="muted" dir="auto">${esc(o.store_name || "")}</span><span class="muted" dir="ltr">${esc(o.id || "")}</span></div>
        </div>
        <p class="muted mkt-f-hint">${esc(t(ships ? "mkt.ad.hintShip" : "mkt.ad.hintHand"))}</p>
        <div class="mkt-form-row">
          <label class="mkt-field"><span>${esc(t("mkt.co.name"))} *</span><input name="name" dir="auto" maxlength="80" autocomplete="name" value="${esc(a.name || "")}" /></label>
          <label class="mkt-field"><span>${esc(t("mkt.co.phone"))} *</span><input name="phone" maxlength="30" autocomplete="tel" dir="ltr" inputmode="tel" value="${esc(a.phone || "")}" placeholder="+212 6…" /></label>
        </div>
        <label class="mkt-field"><span>${esc(t("mkt.co.city"))}${ships || cityOnly ? " *" : ""}</span><input name="city" dir="auto" maxlength="80" autocomplete="address-level2" value="${esc(a.city || "")}" /></label>
        ${ships ? `<label class="mkt-field"><span>${esc(t("mkt.co.line"))} *</span><input name="line" dir="auto" maxlength="200" autocomplete="street-address" value="${esc(a.line || "")}" /></label>` : ""}
        ${cityOnly ? `<p class="muted mkt-f-hint">${esc(t("mkt.co.cityOnly", { city: cityOnly }))}</p>` : ""}
        ${ships ? `<label class="mkt-check"><input type="checkbox" name="save" ${saved ? "" : "checked"} /><span>${esc(t("mkt.ad.save"))}</span></label>` : ""}
        <p class="mkt-form-err" data-err role="alert"></p>
        <div class="mkt-form-acts">
          <button class="btn btn-ghost" type="button" data-close>${esc(t("common.cancel"))}</button>
          <button class="btn btn-primary" type="submit" data-save>${ICON.home}<span>${esc(t("mkt.ad.send"))}</span></button>
        </div>
      </form>`, { cls: "mkt-modal-sm", label: title });
    const form = wrap.querySelector("[data-addr]");
    const err = form.querySelector("[data-err]");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      const val = (n) => (form[n] ? form[n].value.trim() : "");
      const ad = { name: val("name"), phone: M.digits(val("phone")), city: val("city"), line: val("line") };
      const save = Boolean(form.save?.checked);
      const bad =
        (ad.name.length < 2 && "name") ||
        (!M.phoneOk(ad.phone) && "phone") ||
        ((ships || cityOnly) && ad.city.length < 2 && "city") ||
        (ships && ad.line.length < 4 && "line");
      if (bad) {
        err.textContent = t(bad === "phone" ? "mkt.err.phone" : "mkt.err.address");
        form[bad]?.focus();
        return;
      }
      const btn = form.querySelector("[data-save]");
      btn.disabled = true;
      const r = await M.call("market_order_address", { p_member: M.memberId(), p_order: o.id, p_address: ad, p_save: save });
      btn.disabled = false;
      if (!r.ok || !r.data?.ok) {
        err.textContent = M.failText(r);
        return;
      }
      keepAddr(ad);
      if (r.data.saved) savedAddr = { ...ad };
      wrap.close();
      C.toast(t(r.data.saved ? "mkt.ad.savedBoth" : "mkt.ad.saved"));
      onSaved?.(r.data);
    });
    return wrap;
  };

  // ---------------------------------------------------------------- checkout
  // Buy now: pieces, a note, the city for a store of one city, the total and the points. A
  // physical product shows where it goes (the address saved in the profile) or that the address
  // comes after; a digital one when its download link comes.
  M.openCheckout = ({ product, store, ref = "", onDone = null, onAddress = null }) => {
    const p = product;
    const s = store || {};
    const physical = p.kind !== "digital";
    const ships = physical && s.shipping !== false;
    const cityOnly = s.scope === "city";
    const maxQty = Math.max(1, Math.min(100, Number(p.stock) || 1));
    const request = s.sale_mode === "request";
    const digitalText = p.download ? (request ? "mkt.co.downloadAccept" : "mkt.co.downloadNow") : "mkt.co.digital";
    const wrap = M.modal(`
      ${head(t(request ? "mkt.co.titleRequest" : "mkt.co.title"))}
      <form class="mkt-form" data-co novalidate>
        <div class="mkt-co-item">
          <img src="${esc(images(p)[0] || C.initialsAvatar(p.title))}" alt="" />
          <div><b dir="auto">${esc(p.title)}</b><span class="muted" dir="auto">${esc(s.name || "")}</span><span class="mkt-price" dir="ltr">${esc(M.pt(p.price))}</span></div>
        </div>
        <label class="mkt-field mkt-qty"><span>${esc(t("mkt.co.qty"))}</span>
          <input name="qty" type="number" min="1" max="${maxQty}" step="1" value="1" inputmode="numeric" /></label>
        ${physical ? `<div class="mkt-co-deliv" data-deliv>${ICON.home}<div data-deliv-text><span class="muted">${esc(t("common.loading"))}</span></div></div>`
          : `<p class="mkt-co-deliv">${p.download ? ICON.download : ICON.cloud}<span>${esc(t(digitalText))}</span></p>`}
        ${cityOnly ? `
        <label class="mkt-field"><span>${esc(t("mkt.co.yourCity"))} *</span><input name="city" dir="auto" maxlength="80" autocomplete="address-level2" value="" /></label>
        <p class="muted mkt-f-hint">${esc(t("mkt.co.cityOnly", { city: s.city || "" }))}</p>` : ""}
        <label class="mkt-field"><span>${esc(t("mkt.co.note"))}</span><textarea name="note" dir="auto" rows="2" maxlength="300"></textarea></label>
        <dl class="mkt-co-sum" data-sum></dl>
        <p class="muted mkt-f-hint">${esc(t(request ? "mkt.co.holdRequest" : "mkt.co.hold"))}</p>
        <p class="mkt-form-err" data-err role="alert"></p>
        <div class="mkt-form-acts">
          <button class="btn btn-ghost" type="button" data-close>${esc(t("common.cancel"))}</button>
          <button class="btn btn-primary" type="submit" data-co-buy>${ICON.cart}<span>${esc(t(request ? "mkt.co.sendRequest" : "mkt.co.confirm"))}</span></button>
        </div>
      </form>`, { label: t("mkt.co.title") });
    const form = wrap.querySelector("[data-co]");
    const err = form.querySelector("[data-err]");
    let have = null;
    const sum = () => {
      const q = Math.max(1, Math.min(maxQty, Math.floor(Number(form.qty.value) || 1)));
      const ship = ships ? Number(p.shipping_cost) || 0 : 0;
      const total = Number(p.price) * q + ship;
      form.querySelector("[data-sum]").innerHTML = `
        <dt>${esc(t("mkt.co.subtotal", { n: M.fmt(q) }))}</dt><dd dir="ltr">${esc(M.pt(Number(p.price) * q))}</dd>
        ${ships ? `<dt>${esc(t("mkt.shippingCost"))}</dt><dd dir="ltr">${ship ? esc(M.pt(ship)) : esc(t("mkt.free"))}</dd>` : ""}
        <dt class="tot">${esc(t("mkt.co.total"))}</dt><dd class="tot" dir="ltr">${esc(M.pt(total))}</dd>
        <dt>${esc(t("mkt.co.yourPoints"))}</dt><dd dir="ltr">${have == null ? "…" : esc(M.pt(have))}</dd>
        ${have != null ? `<dt>${esc(t("mkt.co.after"))}</dt><dd class="${have - total < 0 ? "neg" : ""}" dir="ltr">${esc(M.pt(have - total))}</dd>` : ""}`;
      return { q, total };
    };
    form.qty.addEventListener("input", sum);
    sum();
    C.memberPoints(M.memberId(), {})
      .then((mp) => {
        have = Number(mp?.available) || 0;
        if (form.isConnected) sum();
      })
      .catch(() => {});
    // where it goes: the address saved in the profile, or "you give it after"
    if (physical) {
      M.savedAddress().then((a) => {
        const box = form.querySelector("[data-deliv-text]");
        if (!box) return;
        const when = t(request ? "mkt.co.whenAccepted" : "mkt.co.whenBought");
        box.innerHTML = a
          ? `<b>${esc(t(ships ? "mkt.co.shipTo" : "mkt.co.handTo"))}</b>
             <span dir="auto" data-saved-addr>${esc(M.addressText({ ...a, line: ships ? a.line : "" }))}</span>
             <span class="muted">${esc(t("mkt.co.savedGoes", { when }))} <a href="${esc(M.addressHref)}">${esc(t("mkt.co.changeProfile"))}</a></span>`
          : `<b>${esc(t("mkt.co.addrLater"))}</b>
             <span class="muted">${esc(t("mkt.co.addrAfter", { when }))} <a href="${esc(M.addressHref)}">${esc(t("mkt.co.saveProfile"))}</a></span>`;
        if (!ships) box.insertAdjacentHTML("beforeend", `<span class="muted">${esc(t("mkt.co.noShip"))}</span>`);
        if (cityOnly && form.city && !form.city.value && a?.city) form.city.value = a.city;
      });
    }
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      const { q, total } = sum();
      const val = (n) => (form[n] ? form[n].value.trim() : "");
      const addr = { note: val("note"), city: val("city") };
      if (cityOnly && addr.city.length < 2) {
        err.textContent = t("mkt.err.cityOnly", { city: s.city || "" });
        form.city.focus();
        return;
      }
      if (have != null && have < total) {
        err.textContent = t("mkt.err.points", { need: M.fmt(total), have: M.fmt(have) });
        return;
      }
      const btn = form.querySelector("[data-co-buy]");
      btn.disabled = true;
      const r = await M.call("market_buy", { p_member: M.memberId(), p_product: p.id, p_qty: q, p_address: addr, p_ref: ref || "" });
      btn.disabled = false;
      if (!r.ok || !r.data?.ok) {
        err.textContent = M.failText(r);
        return;
      }
      wrap.close();
      const d = r.data;
      C.toast(t(d.status === "requested" ? "mkt.co.requested" : d.delivered ? "mkt.co.downloadReady" : d.needs_address ? "mkt.co.boughtAddress" : "mkt.co.bought"));
      onDone?.(d);
      // bought at once and no address saved: ask for it now
      if (d.needs_address) {
        M.openAddress({
          order: { id: d.id, title: p.title, image: images(p)[0] || "", store_name: s.name || "", delivery: ships ? "ship" : "hand", city_only: cityOnly ? s.city || "" : "" },
          onSaved: (x) => onAddress?.(x),
        });
      }
    });
    return wrap;
  };

  // ---------------------------------------------------------------- report
  // The Report button of a store page and of a product page: a reason (and a few words);
  // the team reads it in Panel > Reports > Market.
  const REPORT_REASONS = ["fake", "scam", "prohibited", "misleading", "offensive", "no_delivery", "other"];
  M.openReport = ({ kind, id, name = "", onSent = null }) => {
    const title = t(kind === "store" ? "mkt.rp.titleStore" : "mkt.rp.titleProduct");
    const wrap = M.modal(`
      ${head(title)}
      <form class="mkt-form" data-rp novalidate>
        <p class="mkt-rp-what">${ICON.flag}<b dir="auto">${esc(name)}</b></p>
        <fieldset class="mkt-field mkt-rp-reasons"><legend>${esc(t("mkt.rp.why"))} *</legend>
          ${REPORT_REASONS.map((r) => `<label><input type="radio" name="reason" value="${r}" /><span>${esc(t(`mkt.rp.r.${r}`))}</span></label>`).join("")}
        </fieldset>
        <label class="mkt-field"><span>${esc(t("mkt.rp.note"))}</span>
          <textarea name="note" dir="auto" rows="3" maxlength="500" placeholder="${esc(t("mkt.rp.notePh"))}"></textarea></label>
        <p class="muted mkt-f-hint">${esc(t("mkt.rp.hint"))}</p>
        <p class="mkt-form-err" data-err role="alert"></p>
        <div class="mkt-form-acts">
          <button class="btn btn-ghost" type="button" data-close>${esc(t("common.cancel"))}</button>
          <button class="btn btn-danger" type="submit" data-send>${ICON.flag}<span>${esc(t("mkt.rp.send"))}</span></button>
        </div>
      </form>`, { cls: "mkt-modal-sm", label: title });
    const form = wrap.querySelector("[data-rp]");
    const err = form.querySelector("[data-err]");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      const reason = form.querySelector('input[name="reason"]:checked')?.value || "";
      const note = form.note.value.trim();
      if (!reason) {
        err.textContent = t("mkt.err.reason");
        form.querySelector('input[name="reason"]')?.focus();
        return;
      }
      if (reason === "other" && note.length < 5) {
        err.textContent = t("mkt.rp.noteNeeded");
        form.note.focus();
        return;
      }
      const btn = form.querySelector("[data-send]");
      btn.disabled = true;
      const r = await M.call("market_report", { p_member: M.memberId(), p_kind: kind, p_id: id, p_reason: reason, p_note: note });
      btn.disabled = false;
      if (!r.ok || !r.data?.ok) {
        err.textContent = M.failText(r);
        return;
      }
      wrap.close();
      C.toast(t("mkt.rp.sent"));
      onSent?.();
    });
    return wrap;
  };

  // ---------------------------------------------------------------- review
  // The good points and the bad points of a delivered order, one per line.
  M.openReview = ({ order, review = null, onSaved = null }) => {
    const lines = (a) => (Array.isArray(a) ? a.join("\n") : "");
    const wrap = M.modal(`
      ${head(t(review ? "mkt.rv.edit" : "mkt.rv.title"))}
      <form class="mkt-form" data-rv novalidate>
        <p class="muted">${esc(order.title || "")}</p>
        <div class="mkt-form-2">
          <label class="mkt-field mkt-rv-pros"><span>${ICON.up} ${esc(t("mkt.pros"))}</span>
            <textarea name="pros" dir="auto" rows="6" placeholder="${esc(t("mkt.rv.prosPh"))}">${esc(lines(review?.pros))}</textarea></label>
          <label class="mkt-field mkt-rv-cons"><span>${ICON.down} ${esc(t("mkt.cons"))}</span>
            <textarea name="cons" dir="auto" rows="6" placeholder="${esc(t("mkt.rv.consPh"))}">${esc(lines(review?.cons))}</textarea></label>
        </div>
        <p class="muted mkt-f-hint">${esc(t("mkt.rv.hint"))}</p>
        <p class="mkt-form-err" data-err role="alert"></p>
        <div class="mkt-form-acts">
          <button class="btn btn-ghost" type="button" data-close>${esc(t("common.cancel"))}</button>
          <button class="btn btn-primary" type="submit" data-save>${esc(t("mkt.rv.publish"))}</button>
        </div>
      </form>`, { cls: "mkt-modal-wide", label: t("mkt.rv.title") });
    const form = wrap.querySelector("[data-rv]");
    const err = form.querySelector("[data-err]");
    const split = (v) => v.split(/\n+/).map((x) => x.replace(/^[\s•\-*–]+/, "").trim()).filter(Boolean);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const pros = split(form.pros.value);
      const cons = split(form.cons.value);
      if (!pros.length && !cons.length) {
        err.textContent = t("mkt.err.empty");
        return;
      }
      if (pros.length > 10 || cons.length > 10 || [...pros, ...cons].some((x) => x.length < 2 || x.length > 200)) {
        err.textContent = t("mkt.err.text");
        return;
      }
      const btn = form.querySelector("[data-save]");
      btn.disabled = true;
      const r = await M.call("market_review_save", { p_member: M.memberId(), p_order: order.id || order.order_id, p_pros: pros, p_cons: cons });
      btn.disabled = false;
      if (!r.ok || !r.data?.ok) {
        err.textContent = M.failText(r);
        return;
      }
      wrap.close();
      C.toast(t("mkt.rv.saved"));
      onSaved?.();
    });
  };

  // ---------------------------------------------------------------- requests
  // A question about a product, or "can you get this item?" to a store.
  M.openRequest = ({ store, product = null, kind = "question", onSent = null }) => {
    const wrap = M.modal(`
      ${head(t(kind === "question" ? "mkt.rq.askTitle" : "mkt.rq.itemTitle"))}
      <form class="mkt-form" data-rq novalidate>
        <p class="muted">${esc(product ? product.title : store?.name || "")}</p>
        ${product ? `
        <fieldset class="mkt-field mkt-seg"><legend>${esc(t("mkt.rq.kind"))}</legend>
          <label><input type="radio" name="kind" value="question" ${kind === "question" ? "checked" : ""} /><span>${esc(t("mkt.rq.question"))}</span></label>
          <label><input type="radio" name="kind" value="item" ${kind === "item" ? "checked" : ""} /><span>${esc(t("mkt.rq.item"))}</span></label>
        </fieldset>` : `<input type="hidden" name="kind" value="item" />`}
        <label class="mkt-field"><span>${esc(t("mkt.rq.body"))} *</span>
          <textarea name="body" dir="auto" rows="5" maxlength="1000" placeholder="${esc(t(kind === "question" ? "mkt.rq.questionPh" : "mkt.rq.itemPh"))}"></textarea></label>
        <p class="mkt-form-err" data-err role="alert"></p>
        <div class="mkt-form-acts">
          <button class="btn btn-ghost" type="button" data-close>${esc(t("common.cancel"))}</button>
          <button class="btn btn-primary" type="submit" data-send>${esc(t("mkt.rq.send"))}</button>
        </div>
      </form>`, { cls: "mkt-modal-sm", label: t("mkt.rq.askTitle") });
    const form = wrap.querySelector("[data-rq]");
    const err = form.querySelector("[data-err]");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = form.body.value.trim();
      if (body.length < 2) {
        err.textContent = t("mkt.err.body");
        return;
      }
      const btn = form.querySelector("[data-send]");
      btn.disabled = true;
      const r = await M.call("market_request_send", {
        p_member: M.memberId(),
        p_store: store?.id || "",
        p_product: product?.id || "",
        p_kind: form.kind.value,
        p_body: body,
      });
      btn.disabled = false;
      if (!r.ok || !r.data?.ok) {
        err.textContent = M.failText(r);
        return;
      }
      wrap.close();
      C.toast(t("mkt.rq.sent"));
      onSent?.();
    });
  };

  window.CineAuraMarket = M;
})();
