/* CineAura — the Panel views of the team (loaded before panel.js):
 *
 *   Overview       panel_overview(): the numbers of the staff member's sections, what is waiting
 *                  for the team, the newest members and orders (sql/panel_admin.sql)
 *   Content        Videos · Playlists (sql/content.sql: content_admin, content_moderate) and the
 *                  members' IPTV lists (sql/iptv_lists.sql: iptv_lists_admin, iptv_list_moderate):
 *                  suspend (hidden from everybody but the owner, who reads why), restore, delete
 *   Market         Stores · Products · Orders · Categories · Reviews and lists (sql/market.sql,
 *                  section 16): the team refunds a buyer or pays a seller at once, with a reason
 *   Packages       Accounts · Points · Prizes: the serials of the account packages (activation and
 *                  reactivation), the points packages and the prize packages — typed or drawn, how
 *                  many uses, who may use them (public / exclusive / private); list, copy, delete
 *                  (sql/packages.sql, sql/point_codes.sql)
 *   Announcements  the bar at the top of the home page and messages to the members' bell
 *                  (sql/panel_admin.sql)
 *   Withdrawals    js/panel-withdraw.js, with the helpers of this file (CineAuraPanelAdmin.kit,
 *                  CineAuraPanelAdmin.add): the members' requests and the settings (sql/withdrawals.sql)
 *
 * panel.js calls CineAuraPanelAdmin.view(name, main, ctx) with
 *   ctx = { state, token(), go(section, opts), roleLabel(role) }.
 * A missing SQL function (the file not run yet) shows what to run instead of the view.
 */
(() => {
  const C = window.CineAura;
  if (!C) return;
  const { escapeHtml: esc, t, toast, initialsAvatar } = C;
  let ctx = null;

  // ---------------------------------------------------------------- small helpers
  const locale = () => `${C.getLocale?.() || "en"}-u-nu-latn`;
  const num = (n) => {
    try {
      return new Intl.NumberFormat(locale()).format(Number(n) || 0);
    } catch {
      return String(Number(n) || 0);
    }
  };
  // an amount kept as "7,780 PT" in Arabic too (a bidi isolate)
  const pt = (n) => `\u2066${num(n)} PT\u2069`;
  const when = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    try {
      return d.toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" });
    } catch {
      return d.toLocaleString();
    }
  };
  const day = (iso) => (iso ? C.formatDate(iso) : "");
  const rpc = (fn, args) => C.rpc(fn, { p_token: ctx.token(), ...args }).catch(() => null);
  const data = (r) => (r?.ok && r.data && typeof r.data === "object" && r.data.ok !== false ? r.data : null);
  const errKey = (r) => {
    const raw = JSON.stringify(r?.data || {});
    if (/staff_auth/.test(raw)) return "pza.errAuth";
    if (/staff_forbidden/.test(raw)) return "pa.forbidden";
    if (r?.status === 404 || /PGRST202|42883|schema cache|does not exist/i.test(raw)) return "pa.setup";
    return "panel.actFail";
  };
  const failToast = (r, reasons = {}) => {
    const why = r?.data?.reason;
    toast(t(reasons[why] || (why === "reason" ? "pa.errReason" : why === "state" ? "pa.errState" : why === "not_found" ? "pa.errGone" : errKey(r))));
  };
  const who = (o) => {
    const u = o?.username || "";
    return u ? `<a href="${esc(C.profileHref(u))}" target="_blank" rel="noopener"><bdi>@${esc(u)}</bdi></a>` : `<span dir="ltr">${esc(o?.id || "—")}</span>`;
  };
  const tag = (text, cls = "") => `<span class="crp-tag${cls ? " " + cls : ""}">${esc(text)}</span>`;
  const visTag = (v) => tag(t(`ipl.vis.${["public", "exclusive", "private"].includes(v) ? v : "public"}`), `pa-vis-${esc(v || "public")}`);
  const tierPct = (pct) => {
    const v = Math.max(0, Math.min(100, Number(pct) || 0));
    return v >= 10 ? String(Math.floor(v)) : String(Math.floor(v * 10) / 10);
  };
  const tierHtml = (tier) =>
    tier && tier.code
      ? `<span class="mkt-tier t-${esc(tier.code)}" dir="ltr" title="${esc(t("mkt.tier.badge", { code: tier.code, pct: tierPct(tier.pct), points: num(tier.points) }))}"><b>${esc(tier.code)}</b><span>${esc(tierPct(tier.pct))}%</span></span>`
      : "";
  const suspLine = (s) =>
    s ? `<p class="mkr-why pa-why">${t("pa.suspendedBy", { by: esc(s.by || "—"), date: esc(when(s.at)) })} <q>${esc(s.reason || "")}</q></p>` : "";
  const img = (src, name) => `<img src="${esc(src || initialsAvatar(name || "CA"))}" alt="" loading="lazy" />`;
  const head = (eyebrow, title, lead) => `
    <p class="eyebrow">${esc(eyebrow)}</p>
    <h1>${esc(title)}</h1>
    ${lead ? `<p class="muted pa-lead">${esc(lead)}</p>` : ""}`;
  const tabsHtml = (attr, list, active) => `
    <div class="tabs follow-tabs pa-tabs" role="tablist">
      ${list.map(([k, label, n]) => `<button type="button" role="tab" class="follow-tab${k === active ? " active" : ""}" aria-selected="${k === active}" data-${attr}="${k}">${esc(label)}${n ? `<span class="follow-count">${n > 99 ? "99+" : n}</span>` : ""}</button>`).join("")}
    </div>`;
  const reasonForm = (action, label, effect, button, danger = true) => `
    <form class="mkr-suspend pa-reason" data-pa-form="${action}">
      <label><span>${esc(label)}</span>
        <textarea name="reason" rows="2" maxlength="300" required placeholder="${esc(t("pa.reasonPh"))}"></textarea></label>
      ${effect ? `<p class="muted">${effect}</p>` : ""}
      <div class="acc-actions">
        <button class="btn btn-sm ${danger ? "btn-danger" : "btn-primary"}" type="submit">${esc(button)}</button>
        <button class="btn btn-sm btn-ghost" type="button" data-pa-cancel>${t("common.cancel")}</button>
      </div>
    </form>`;
  const openSlot = (cardEl, html) => {
    const slot = cardEl.querySelector("[data-pa-slot]");
    if (!slot) return null;
    slot.innerHTML = html;
    slot.querySelector("textarea, input:not([type=hidden])")?.focus();
    return slot;
  };
  const reasonOf = (form) => {
    const v = String(form.reason?.value || "").trim();
    if (v.length < 3) {
      toast(t("pa.errReason"));
      form.reason?.focus();
      return null;
    }
    return v;
  };
  const busy = async (form, fn) => {
    const btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    try {
      return await fn();
    } finally {
      if (btn && btn.isConnected) btn.disabled = false;
    }
  };

  // ---------------------------------------------------------------- one list (filters, search, pages)
  // cfg = { key, fetch(st, offset), filters: [[key, label]], sorts: [[key, label]], placeholder,
  //         card(item, i), act(action, item, cardEl, btn, redraw), submit(action, form, item, cardEl, redraw),
  //         lead, empty, before(st, data), change(event, st, redraw) }
  const PAGE = 30;
  function listState(cfg) {
    const all = ctx.state.pa || (ctx.state.pa = {});
    const st = all[cfg.key] || (all[cfg.key] = {
      filter: cfg.filters?.[0]?.[0] || "all", q: "", sort: cfg.sorts?.[0]?.[0] || "", items: [], total: 0,
    });
    // opened from another section (Overview, a store's orders…): its filter and search, once
    if (ctx.state.paPreset) {
      Object.assign(st, ctx.state.paPreset);
      ctx.state.paPreset = null;
    }
    return st;
  }

  async function drawList(pane, cfg, more = false) {
    const st = listState(cfg);
    const seq = (st.seq = (st.seq || 0) + 1);
    pane.classList.add("pa-busy");
    const r = await cfg.fetch(st, more ? st.items.length : 0);
    if (seq !== st.seq || !pane.isConnected) return;
    pane.classList.remove("pa-busy");
    const d = data(r);
    const counts = d?.counts || null;
    const chip = ([k, label]) =>
      `<button type="button" class="crp-filter${k === st.filter ? " active" : ""}" data-pa-filter="${k}">${esc(label)}${counts && counts[k] != null ? ` <span class="pa-n">${num(counts[k])}</span>` : ""}</button>`;
    const top = `
      ${cfg.lead ? `<p class="muted pa-lead">${esc(cfg.lead)}</p>` : ""}
      <div class="crp-bar pa-bar">
        ${cfg.filters ? `<div class="crp-filters">${cfg.filters.map(chip).join("")}</div>` : ""}
        <form class="pa-tools" data-pa-search role="search">
          <input type="search" name="q" value="${esc(st.q)}" placeholder="${esc(cfg.placeholder || t("pa.searchPh"))}" aria-label="${esc(t("pa.search"))}" />
          <button class="btn btn-sm btn-primary" type="submit">${t("pa.search")}</button>
          ${cfg.sorts ? `<label class="pa-sort"><span>${t("pa.sortBy")}</span><select name="sort" data-pa-sort>${cfg.sorts.map(([k, label]) => `<option value="${k}"${k === st.sort ? " selected" : ""}>${esc(label)}</option>`).join("")}</select></label>` : ""}
        </form>
      </div>
      ${cfg.before ? cfg.before(st, d) : ""}`;
    if (!d) {
      pane.innerHTML = `${top}<div class="form-alert show warn">${t(errKey(r))}</div>`;
    } else {
      st.items = more ? st.items.concat(d.items || []) : d.items || [];
      st.total = Number(d.total ?? st.items.length) || 0;
      pane.innerHTML = `${top}
        <p class="muted pa-total">${t("pa.shown", { n: num(st.items.length), total: num(st.total) })}</p>
        <div class="crp-list pa-list">${st.items.map((it, i) => cfg.card(it, i)).join("") || `<p class="empty">${esc(cfg.empty || t("pa.none"))}</p>`}</div>
        ${st.items.length < st.total ? `<button class="btn btn-sm btn-ghost pa-more" type="button" data-pa-more>${t("pa.more")}</button>` : ""}`;
      C.hydrateAvatars?.(pane);
    }
    const redraw = () => drawList(pane, cfg);
    pane.onclick = (e) => {
      const f = e.target.closest("[data-pa-filter]");
      if (f) {
        st.filter = f.dataset.paFilter;
        redraw();
        return;
      }
      if (e.target.closest("[data-pa-more]")) {
        drawList(pane, cfg, true);
        return;
      }
      const cancel = e.target.closest("[data-pa-cancel]");
      if (cancel) {
        const slot = cancel.closest("[data-pa-slot]");
        if (slot) slot.innerHTML = "";
        return;
      }
      const btn = e.target.closest("[data-pa-act]");
      const cardEl = btn?.closest("[data-pa-i]");
      const item = cardEl ? st.items[Number(cardEl.dataset.paI)] : null;
      if (btn && cfg.act && (item || btn.dataset.paAny)) cfg.act(btn.dataset.paAct, item, cardEl, btn, redraw, st);
    };
    pane.onchange = (e) => {
      if (e.target.matches("[data-pa-sort]")) {
        st.sort = e.target.value;
        redraw();
      } else if (cfg.change) cfg.change(e, st, redraw);
    };
    pane.onsubmit = (e) => {
      const sf = e.target.closest("[data-pa-search]");
      if (sf) {
        e.preventDefault();
        st.q = String(sf.q.value || "").trim();
        redraw();
        return;
      }
      const form = e.target.closest("[data-pa-form]");
      if (!form) return;
      e.preventDefault();
      const cardEl = form.closest("[data-pa-i]");
      const item = cardEl ? st.items[Number(cardEl.dataset.paI)] : null;
      if (cfg.submit) cfg.submit(form.dataset.paForm, form, item, cardEl, redraw, st);
    };
  }

  // ================================================================ Overview
  const ATTENTION = {
    ban_soon: ["pa.att.banSoon", "accounts"],
    reports_links: ["pa.att.reportsLinks", "reports", { reportTab: "links" }],
    reports_channels: ["pa.att.reportsChannels", "reports", { reportTab: "channels" }],
    reports_market: ["pa.att.reportsMarket", "reports", { reportTab: "market" }],
    claims: ["pa.att.claims", "prizes"],
    messages: ["pa.att.messages", "messages"],
    returns: ["pa.att.returns", "market", { marketTab: "orders", filter: "return_requested" }],
    requests_old: ["pa.att.requestsOld", "market", { marketTab: "orders", filter: "requested" }],
    // withdrawal requests waiting for the team (sql/withdrawals.sql)
    withdrawals: ["pw.att", "withdrawals", { filter: "pending" }],
  };

  async function viewOverview(main) {
    main.innerHTML = `${head(t("panel.nav.overview"), t("pa.ov.title"), t("pa.ov.lead"))}<div class="pa-ov" id="pa-ov"><p class="muted">${t("pa.loading")}</p></div>`;
    const box = main.querySelector("#pa-ov");
    const r = await rpc("panel_overview", {});
    if (!box.isConnected) return;
    const d = data(r);
    if (!d) {
      box.innerHTML = `<div class="form-alert show warn">${t(errKey(r))}</div>`;
      return;
    }
    const secs = new Set(d.sections || []);
    const att = (d.attention || []).map((a) => {
      const def = ATTENTION[a.key];
      if (!def) return "";
      return `
        <li class="pa-att-item">
          <span class="pa-att-n">${num(a.count)}</span>
          <span class="pa-att-text">${esc(t(def[0], { n: num(a.count) }))}</span>
          <button class="btn btn-sm btn-primary" type="button" data-pa-go="${def[1]}" data-pa-opts='${esc(JSON.stringify(def[2] || {}))}'>${t("pa.open")}</button>
        </li>`;
    }).join("");
    const tile = (label, value, sub, go, opts, tone = "") => `
      <button type="button" class="pa-tile${tone ? " " + tone : ""}" ${go ? `data-pa-go="${go}" data-pa-opts='${esc(JSON.stringify(opts || {}))}'` : "disabled"}>
        <span class="pa-tile-label">${esc(label)}</span>
        <strong class="pa-tile-value" dir="ltr">${value}</strong>
        ${sub ? `<span class="pa-tile-sub">${sub}</span>` : ""}
      </button>`;
    const groups = [];
    if (d.members) {
      const m = d.members;
      groups.push([t("pa.ov.members"), [
        tile(t("pa.ov.membersAll"), num(m.all), esc(t("pa.ov.membersSub", { active: num(m.active), premium: num(m.premium) })), "accounts"),
        tile(t("pa.ov.newMembers"), num(m.new_7d), esc(t("pa.ov.newSub", { n: num(m.new_30d) })), "accounts"),
        tile(t("pa.ov.banned"), num(m.banned), esc(t("pa.ov.waitingSub", { n: num(m.waiting) })), "accounts", null, m.ban_soon ? "warn" : ""),
      ]]);
    }
    if (d.content) {
      const c = d.content;
      groups.push([t("panel.nav.content"), [
        tile(t("pa.ov.videos"), num(c.videos), esc(t("pa.ov.videosSub", { n: num(c.videos_7d), views: num(c.views) })), "content", { contentTab: "videos" }),
        tile(t("pa.ov.iptvLists"), num(c.iptv_lists), esc(t("pa.ov.playlistsSub", { n: num(c.playlists) })), "content", { contentTab: "iptv" }),
        tile(t("pa.ov.suspended"), num(Number(c.suspended || 0) + Number(c.iptv_suspended || 0)), esc(t("pa.ov.suspendedSub")), "content", { contentTab: "videos", filter: "suspended" }),
      ]]);
    }
    if (d.market) {
      const k = d.market;
      const tiles = [
        tile(t("pa.ov.stores"), num(k.stores_open), esc(t("pa.ov.storesSub", { n: num(k.stores) })), secs.has("market") ? "market" : "", { marketTab: "stores" }),
        tile(t("pa.ov.products"), num(k.products), "", secs.has("market") ? "market" : "", { marketTab: "products" }),
        tile(t("pa.ov.openOrders"), num(k.open_orders), t("pa.ov.escrowSub", { pts: pt(k.escrow) }), secs.has("market") ? "market" : "", { marketTab: "orders", filter: "open" }, k.returns ? "warn" : ""),
        tile(t("pa.ov.sales30"), pt(k.sales_30d), "", secs.has("market") ? "market" : "", { marketTab: "orders", filter: "paid" }),
      ];
      groups.push([t("panel.nav.market"), tiles]);
    }
    if (d.packages) {
      const p = d.packages;
      groups.push([t("panel.nav.packages"), [
        tile(t("pk.tab.account"), num(p.accounts), esc(t("pk.ov.ready")), "packages", { packTab: "account" }),
        tile(t("pk.tab.points"), num(p.points), esc(t("pk.ov.ready")), "packages", { packTab: "points" }),
        tile(t("pk.tab.prize"), num(p.prizes), esc(t("pk.ov.ready")), "packages", { packTab: "prize" }),
        tile(t("pk.ov.used30"), num(p.used_30d), t("pk.ov.pointsSub", { pts: pt(p.points_30d) }), "packages", { packTab: "points", filter: "all" }),
      ]]);
    }
    if (d.withdrawals) {
      const w = d.withdrawals;
      const money = (n) => `\u2066${C.moneyText(n, w.currency)}\u2069`;
      groups.push([t("panel.nav.withdrawals"), [
        tile(t("pw.ov.pending"), num(w.pending), t("pw.ov.heldSub", { pts: pt(w.held) }), "withdrawals", { filter: "pending" }, Number(w.pending) ? "warn" : ""),
        tile(t("pw.ov.processing"), num(w.processing), "", "withdrawals", { filter: "processing" }),
        tile(t("pw.ov.paid30"), money(Number(w.paid_30d_cents || 0) / 100), esc(t("pw.ov.paid30Sub", { n: num(w.paid_30d) })), "withdrawals", { filter: "paid" }),
      ]]);
    }
    const misc = [];
    if (d.prizes) misc.push(tile(t("pa.ov.claims"), num(Number(d.prizes.submitted || 0) + Number(d.prizes.review || 0)), "", "prizes", null, Number(d.prizes.submitted || 0) + Number(d.prizes.review || 0) ? "warn" : ""));
    if (d.messages) misc.push(tile(t("pa.ov.unread"), num(d.messages.unread), esc(t("pa.ov.messagesSub", { n: num(d.messages.all) })), "messages", null, d.messages.unread ? "warn" : ""));
    if (d.reports) misc.push(tile(t("pa.ov.reports"), num(Number(d.reports.links || 0) + Number(d.reports.channels || 0) + Number(d.reports.market || 0)), "", "reports"));
    if (d.announce) {
      const b = d.announce.banner || {};
      misc.push(tile(t("pa.ov.banner"), esc(t(b.active ? "pa.on" : "pa.off")), d.announce.last ? esc(t("pa.ov.lastAnn", { title: d.announce.last.title, date: day(d.announce.last.created_at) })) : "", "announce", null, b.active ? "ok" : ""));
    }
    if (misc.length) groups.push([t("pa.ov.team"), misc]);
    const quick = [
      secs.has("announce") && [t("pa.ov.qAnnounce"), "announce"],
      secs.has("packages") && [t("pk.ov.quick"), "packages"],
      secs.has("withdrawals") && [t("pw.ov.quick"), "withdrawals", { filter: "pending" }],
      secs.has("market") && [t("pa.ov.qOrders"), "market", { marketTab: "orders", filter: "open" }],
      secs.has("content") && [t("pa.ov.qContent"), "content"],
    ].filter(Boolean);
    const members = (d.recent_members || []).map((m) => `
      <li class="pa-mini">
        <img src="${esc(m.avatar || initialsAvatar(m.username || "CA"))}" alt="" data-avatar-for="${esc(m.id)}" data-avatar-name="${esc(m.username || "")}" loading="lazy" />
        <span class="pa-mini-main"><a href="${esc(C.profileHref(m.username || ""))}" target="_blank" rel="noopener"><bdi>@${esc(m.username || m.id)}</bdi></a>
          <small>${esc([m.country, C.tr ? C.tr(m.plan || "Free") : m.plan, C.tr ? C.tr(m.status || "") : m.status].filter(Boolean).join(" · "))}</small></span>
        <time>${esc(day(m.created_at))}</time>
      </li>`).join("");
    const orders = (d.recent_orders || []).map((o) => `
      <li class="pa-mini">
        <img src="${esc(o.image || initialsAvatar(o.title || "CA"))}" alt="" loading="lazy" />
        <span class="pa-mini-main"><strong>${esc(o.title)}</strong>
          <small><bdi>@${esc(o.buyer)}</bdi> → <bdi>@${esc(o.seller)}</bdi> · ${esc(t(`mkt.st.${o.status}`))}${o.settled ? " · " + esc(t("pa.mk.paid")) : ""}</small></span>
        <b class="pa-mini-pt">${pt(o.total)}</b>
      </li>`).join("");
    box.innerHTML = `
      <div class="pa-ov-top">
        <span class="muted">${t("pa.ov.updated", { time: esc(when(d.at)) })}</span>
        <button class="btn btn-sm btn-ghost" type="button" data-pa-refresh>${t("pa.refresh")}</button>
      </div>
      <section class="pa-att${att ? "" : " clear"}">
        <h2>${t("pa.ov.attention")}</h2>
        ${att ? `<ul class="pa-att-list">${att}</ul>` : `<p class="pa-clear">${t("pa.ov.clear")}</p>`}
      </section>
      ${groups.map(([title, tiles]) => `
        <section class="pa-group">
          <h2>${esc(title)}</h2>
          <div class="pa-tiles">${tiles.join("")}</div>
        </section>`).join("")}
      ${members || orders ? `
        <div class="pa-two">
          ${d.recent_members ? `<section class="pa-box"><h2>${t("pa.ov.newest")}</h2>${members ? `<ul class="pa-minis">${members}</ul>` : `<p class="empty">${t("pa.none")}</p>`}</section>` : ""}
          ${d.recent_orders ? `<section class="pa-box"><h2>${t("pa.ov.latestOrders")}</h2>${orders ? `<ul class="pa-minis">${orders}</ul>` : `<p class="empty">${t("pa.none")}</p>`}</section>` : ""}
        </div>` : ""}
      ${quick.length ? `
        <section class="pa-group">
          <h2>${t("pa.ov.quick")}</h2>
          <div class="pa-quick">${quick.map(([label, go, opts]) => `<button class="btn btn-sm btn-ghost" type="button" data-pa-go="${go}" data-pa-opts='${esc(JSON.stringify(opts || {}))}'>${esc(label)}</button>`).join("")}</div>
        </section>` : ""}`;
    C.hydrateAvatars?.(box);
    box.onclick = (e) => {
      if (e.target.closest("[data-pa-refresh]")) {
        viewOverview(main);
        return;
      }
      const go = e.target.closest("[data-pa-go]");
      if (!go || !go.dataset.paGo) return;
      let opts = {};
      try {
        opts = JSON.parse(go.dataset.paOpts || "{}");
      } catch {
        opts = {};
      }
      ctx.go(go.dataset.paGo, opts);
    };
  }

  // ================================================================ Content
  const VIS_FILTERS = () => [["all", t("pa.f.all")], ["public", t("ipl.vis.public")], ["exclusive", t("ipl.vis.exclusive")], ["private", t("ipl.vis.private")]];
  const contentCfg = {
    videos: () => ({
      key: "ct-videos",
      filters: [...VIS_FILTERS(), ["scheduled", t("pa.ct.scheduled")], ["suspended", t("pa.f.suspended")]],
      sorts: [["new", t("pa.s.new")], ["old", t("pa.s.old")], ["views", t("pa.s.views")], ["minutes", t("pa.s.minutes")], ["likes", t("pa.s.likes")], ["comments", t("pa.s.comments")]],
      placeholder: t("pa.ct.searchVideos"),
      fetch: (st, off) => rpc("content_admin", { p_kind: "videos", p_filter: st.filter, p_q: st.q, p_sort: st.sort, p_limit: PAGE, p_offset: off }),
      card: (v, i) => {
        const href = `./Content.html?idcontent=${encodeURIComponent(v.id)}`;
        return `
          <article class="crp-card pa-card${v.suspended ? " pa-susp" : ""}" data-pa-i="${i}">
            <div class="crp-top">
              <a class="pa-thumb wide" href="${href}" target="_blank" rel="noopener">${img(v.thumb, v.title)}</a>
              <div class="crp-title">
                <h3><a href="${href}" target="_blank" rel="noopener">${esc(v.title)}</a></h3>
                <p>${who(v.owner)} · <span dir="ltr">${esc(v.id)}</span> · ${esc(day(v.created_at))}</p>
                <p class="pa-stats">${t("pa.ct.stats", { views: num(v.views), minutes: num(v.minutes), likes: num(v.likes), comments: num(v.comments) })}</p>
              </div>
            </div>
            <div class="crp-tags">
              ${visTag(v.visibility)}
              ${v.scheduled ? tag(t("pa.ct.scheduledFor", { date: day(v.publish_at) })) : ""}
              ${v.age ? tag(`+${v.age}`) : ""}
              ${v.suspended ? tag(t("pa.suspended"), "mkr-susp") : ""}
              ${v.owner?.banned ? tag(t("pa.ownerBanned"), "mkr-susp") : ""}
            </div>
            ${suspLine(v.suspended)}
            <div class="crp-actions">
              ${v.url ? `<a class="btn btn-sm btn-ghost" href="${esc(v.url)}" target="_blank" rel="noopener noreferrer">${t("pa.ct.source")}</a>` : ""}
              ${v.suspended
                ? `<button class="btn btn-sm btn-primary" type="button" data-pa-act="restore">${t("pa.restore")}</button>`
                : `<button class="btn btn-sm btn-danger" type="button" data-pa-act="suspend">${t("pa.suspend")}</button>`}
              <button class="btn btn-sm btn-ghost pa-del" type="button" data-pa-act="delete">${t("pa.delete")}</button>
            </div>
            <div data-pa-slot></div>
          </article>`;
      },
      act: (a, v, cardEl, btn, redraw) => moderateAct("video", a, v, cardEl, btn, redraw),
      submit: (a, form, v, cardEl, redraw) => moderateSubmit("video", a, form, v, redraw),
    }),
    playlists: () => ({
      key: "ct-playlists",
      filters: [["all", t("pa.f.all")], ["suspended", t("pa.f.suspended")]],
      sorts: [["new", t("pa.s.new")], ["old", t("pa.s.old")], ["items", t("pa.s.items")]],
      placeholder: t("pa.ct.searchPlaylists"),
      fetch: (st, off) => rpc("content_admin", { p_kind: "playlists", p_filter: st.filter, p_q: st.q, p_sort: st.sort, p_limit: PAGE, p_offset: off }),
      card: (p, i) => {
        const href = `${C.profileHref(p.owner?.username || "")}#playlist/${encodeURIComponent(p.id)}`;
        return `
          <article class="crp-card pa-card${p.suspended ? " pa-susp" : ""}" data-pa-i="${i}">
            <div class="crp-top">
              <span class="pa-thumb pa-ico">${C.navIcon ? C.navIcon("playlists") : ""}</span>
              <div class="crp-title">
                <h3><a href="${href}" target="_blank" rel="noopener">${esc(p.name)}</a></h3>
                <p>${who(p.owner)} · <span dir="ltr">${esc(p.id)}</span> · ${esc(day(p.created_at))}</p>
                <p class="pa-stats">${t("pa.ct.items", { n: num(p.count) })}</p>
              </div>
            </div>
            ${p.suspended ? `<div class="crp-tags">${tag(t("pa.suspended"), "mkr-susp")}</div>` : ""}
            ${suspLine(p.suspended)}
            <div class="crp-actions">
              ${p.suspended
                ? `<button class="btn btn-sm btn-primary" type="button" data-pa-act="restore">${t("pa.restore")}</button>`
                : `<button class="btn btn-sm btn-danger" type="button" data-pa-act="suspend">${t("pa.suspend")}</button>`}
              <button class="btn btn-sm btn-ghost pa-del" type="button" data-pa-act="delete">${t("pa.delete")}</button>
            </div>
            <div data-pa-slot></div>
          </article>`;
      },
      act: (a, p, cardEl, btn, redraw) => moderateAct("playlist", a, p, cardEl, btn, redraw),
      submit: (a, form, p, cardEl, redraw) => moderateSubmit("playlist", a, form, p, redraw),
    }),
    iptv: () => ({
      key: "ct-iptv",
      filters: [...VIS_FILTERS(), ["suspended", t("pa.f.suspended")]],
      sorts: [["new", t("pa.s.updated")], ["old", t("pa.s.old")], ["views", t("pa.s.views")], ["channels", t("pa.s.channels")]],
      placeholder: t("pa.ct.searchLists"),
      fetch: (st, off) => rpc("iptv_lists_admin", { p_filter: st.filter, p_q: st.q, p_sort: st.sort, p_limit: PAGE, p_offset: off }),
      card: (l, i) => {
        const href = `./Listchannels.html?list=${encodeURIComponent(l.id)}`;
        const src = l.url || l.path || "";
        return `
          <article class="crp-card pa-card${l.suspended ? " pa-susp" : ""}" data-pa-i="${i}">
            <div class="crp-top">
              <span class="pa-thumb pa-ico">${C.navIcon ? C.navIcon("iptv") : ""}</span>
              <div class="crp-title">
                <h3><a href="${href}" target="_blank" rel="noopener">${esc(l.name)}</a></h3>
                <p>${who({ id: l.owner_id, username: l.owner })} · <span dir="ltr">${esc(l.id)}</span> · ${esc(day(l.updated_at || l.created_at))}</p>
                <p class="pa-stats">${t("pa.ct.listStats", { channels: num(l.channels ?? l.channel_count), views: num(l.views) })}</p>
                ${src ? `<p class="pa-src" dir="ltr">${esc(src)}</p>` : ""}
              </div>
            </div>
            <div class="crp-tags">${visTag(l.visibility)}${l.suspended ? tag(t("pa.suspended"), "mkr-susp") : ""}</div>
            ${suspLine(l.suspended)}
            <div class="crp-actions">
              ${l.suspended
                ? `<button class="btn btn-sm btn-primary" type="button" data-pa-act="restore">${t("pa.restore")}</button>`
                : `<button class="btn btn-sm btn-danger" type="button" data-pa-act="suspend">${t("pa.suspend")}</button>`}
              <button class="btn btn-sm btn-ghost pa-del" type="button" data-pa-act="delete">${t("pa.delete")}</button>
            </div>
            <div data-pa-slot></div>
          </article>`;
      },
      act: (a, l, cardEl, btn, redraw) => moderateAct("iptv", a, l, cardEl, btn, redraw),
      submit: (a, form, l, cardEl, redraw) => moderateSubmit("iptv", a, form, l, redraw),
    }),
  };

  const MOD_TEXT = {
    video: { susp: "pa.ct.suspendVideo", effect: "pa.ct.effectVideo", del: "pa.ct.deleteVideo", delEffect: "pa.ct.delEffectVideo" },
    playlist: { susp: "pa.ct.suspendPlaylist", effect: "pa.ct.effectPlaylist", del: "pa.ct.deletePlaylist", delEffect: "pa.ct.delEffectPlaylist" },
    iptv: { susp: "pa.ct.suspendList", effect: "pa.ct.effectList", del: "pa.ct.deleteList", delEffect: "pa.ct.delEffectList" },
  };
  const modCall = (kind, id, action, reason) =>
    kind === "iptv"
      ? rpc("iptv_list_moderate", { p_id: id, p_action: action, p_reason: reason || "" })
      : rpc("content_moderate", { p_kind: kind, p_id: id, p_action: action, p_reason: reason || "" });

  async function moderateAct(kind, action, item, cardEl, btn, redraw) {
    const tx = MOD_TEXT[kind];
    if (action === "restore") {
      if (!confirm(t("pa.restoreAsk"))) return;
      btn.disabled = true;
      const r = await modCall(kind, item.id, "restore");
      btn.disabled = false;
      if (!data(r)) return failToast(r);
      toast(t("pa.restored"));
      redraw();
      return;
    }
    if (action === "suspend") openSlot(cardEl, reasonForm("suspend", t("pa.reasonOwner"), esc(t(tx.effect)), t(tx.susp)));
    if (action === "delete") openSlot(cardEl, reasonForm("delete", t("pa.reasonOwner"), esc(t(tx.delEffect)), t(tx.del)));
  }

  async function moderateSubmit(kind, action, form, item, redraw) {
    const reason = reasonOf(form);
    if (!reason) return;
    if (action === "delete" && !confirm(t("pa.deleteAsk"))) return;
    const r = await busy(form, () => modCall(kind, item.id, action, reason));
    if (!data(r)) return failToast(r);
    toast(t(action === "delete" ? "pa.deleted" : "pa.suspendedDone"));
    redraw();
  }

  async function viewContent(main) {
    const tab = ["videos", "playlists", "iptv"].includes(ctx.state.paContentTab) ? ctx.state.paContentTab : "videos";
    main.innerHTML = `
      ${head(t("panel.nav.content"), t("pa.ct.title"), t("pa.ct.lead"))}
      ${tabsHtml("pa-ctab", [["videos", t("pa.ct.videos")], ["playlists", t("pa.ct.playlists")], ["iptv", t("pa.ct.iptv")]], tab)}
      <div class="follow-pane pa-pane" id="pa-pane"></div>`;
    main.querySelector(".pa-tabs").onclick = (e) => {
      const b = e.target.closest("[data-pa-ctab]");
      if (!b || b.dataset.paCtab === tab) return;
      ctx.state.paContentTab = b.dataset.paCtab;
      viewContent(main);
    };
    await drawList(main.querySelector("#pa-pane"), contentCfg[tab]());
  }

  // ================================================================ Market
  const ORDER_FILTERS = () => [
    ["open", t("pa.mk.fOpen")], ["requested", t("mkt.st.requested")], ["sold", t("mkt.st.sold")], ["shipped", t("mkt.st.shipped")],
    ["delivered", t("pa.mk.fDelivered")], ["return_requested", t("mkt.st.return_requested")], ["paid", t("pa.mk.paid")],
    ["closed", t("pa.mk.fClosed")], ["staff", t("pa.mk.fStaff")], ["all", t("pa.f.all")],
  ];
  const marketCfg = {
    stores: () => ({
      key: "mk-stores",
      filters: [["all", t("pa.f.all")], ["open", t("pa.mk.open")], ["closed", t("pa.mk.closed")], ["suspended", t("pa.f.suspended")]],
      sorts: [["new", t("pa.s.new")], ["old", t("pa.s.old")], ["sales", t("pa.s.salesPoints")], ["products", t("pa.s.products")]],
      placeholder: t("pa.mk.searchStores"),
      fetch: (st, off) => rpc("market_admin_stores", { p_filter: st.filter, p_q: st.q, p_sort: st.sort, p_limit: PAGE, p_offset: off }),
      card: (s, i) => {
        const href = `./Market.html?Store=${encodeURIComponent(s.id)}`;
        return `
          <article class="crp-card pa-card${s.suspended ? " pa-susp" : ""}" data-pa-i="${i}">
            <div class="crp-top">
              <a class="pa-thumb" href="${href}" target="_blank" rel="noopener">${img(s.logo, s.name)}</a>
              <div class="crp-title">
                <h3><a href="${href}" target="_blank" rel="noopener">${esc(s.name)}</a> ${tierHtml(s.tier)}</h3>
                <p>${who(s.owner)} · <span dir="ltr">${esc(s.id)}</span> · ${esc([s.city, s.country].filter(Boolean).join(", "))} · ${esc(day(s.created_at))}</p>
                <p class="pa-stats">${t("pa.mk.storeStats", { products: num(s.products), sales: num(s.sales), points: pt(s.sales_points), orders: num(s.open_orders) })}</p>
              </div>
            </div>
            <div class="crp-tags">
              ${s.suspended ? tag(t("pa.suspended"), "mkr-susp") : tag(t(s.is_open ? "pa.mk.open" : "pa.mk.closed"), s.is_open ? "st-resolved" : "")}
              ${s.reports ? tag(t("pa.mk.reports", { n: num(s.reports) }), "st-open") : ""}
              ${s.owner_status && s.owner_status !== "active" ? tag(C.tr ? C.tr(s.owner_status) : s.owner_status, "mkr-susp") : ""}
            </div>
            ${s.suspended && s.suspended_reason ? `<p class="mkr-why pa-why">${t("panel.mkr.why")} <q>${esc(s.suspended_reason)}</q></p>` : ""}
            <div class="crp-actions">
              <button class="btn btn-sm btn-ghost" type="button" data-pa-act="orders">${t("pa.mk.seeOrders")}</button>
              <button class="btn btn-sm btn-ghost" type="button" data-pa-act="products">${t("pa.mk.seeProducts")}</button>
              ${s.suspended
                ? `<button class="btn btn-sm btn-primary" type="button" data-pa-act="restore">${t("panel.mkr.restoreStore")}</button>`
                : `<button class="btn btn-sm btn-danger" type="button" data-pa-act="suspend">${t("panel.mkr.suspendStore")}</button>`}
            </div>
            <div data-pa-slot></div>
          </article>`;
      },
      act: async (a, s, cardEl, btn, redraw) => {
        if (a === "orders" || a === "products") {
          ctx.go("market", { marketTab: a, filter: a === "orders" ? "all" : "all", q: s.id });
          return;
        }
        if (a === "restore") {
          if (!confirm(t("panel.mkr.restoreStoreAsk"))) return;
          btn.disabled = true;
          const r = await rpc("market_moderate", { p_kind: "store", p_id: s.id, p_action: "restore", p_reason: "" });
          btn.disabled = false;
          if (!data(r)) return failToast(r);
          toast(t("panel.mkr.storeRestored"));
          redraw();
          return;
        }
        if (a === "suspend") openSlot(cardEl, reasonForm("suspend", t("panel.mkr.reasonStore"), esc(t("panel.mkr.storeEffect")), t("panel.mkr.suspendStore")));
      },
      submit: async (a, form, s, cardEl, redraw) => {
        const reason = reasonOf(form);
        if (!reason) return;
        const r = await busy(form, () => rpc("market_moderate", { p_kind: "store", p_id: s.id, p_action: "suspend", p_reason: reason }));
        if (!data(r)) return failToast(r);
        toast(t("panel.mkr.storeSuspendedDone"));
        redraw();
      },
    }),
    products: () => ({
      key: "mk-products",
      filters: [["all", t("pa.f.all")], ["active", t("pa.mk.onSale")], ["hidden", t("panel.mkr.hidden")], ["suspended", t("pa.f.suspended")], ["reported", t("pa.mk.reported")]],
      sorts: [["new", t("pa.s.new")], ["old", t("pa.s.old")], ["sales", t("pa.s.sales")], ["price", t("pa.s.price")]],
      placeholder: t("pa.mk.searchProducts"),
      fetch: (st, off) => rpc("market_admin_products", { p_filter: st.filter, p_q: st.q, p_sort: st.sort, p_limit: PAGE, p_offset: off }),
      card: (p, i) => {
        const href = `./Market.html?Product=${encodeURIComponent(p.id)}`;
        const susp = p.status === "suspended";
        return `
          <article class="crp-card pa-card${susp ? " pa-susp" : ""}" data-pa-i="${i}">
            <div class="crp-top">
              <a class="pa-thumb" href="${href}" target="_blank" rel="noopener">${img(p.images?.[0], p.title)}</a>
              <div class="crp-title">
                <h3><a href="${href}" target="_blank" rel="noopener">${esc(p.title)}</a></h3>
                <p>${esc(p.store?.name || "")} ${tierHtml(p.store?.tier)} · ${who(p.seller)} · <span dir="ltr">${esc(p.id)}</span></p>
                <p class="pa-stats">${t("pa.mk.productStats", { price: pt(p.price), sales: num(p.sales), stock: num(p.stock) })}</p>
              </div>
            </div>
            <div class="crp-tags">
              ${tag(t(p.kind === "digital" ? "pa.mk.digital" : "pa.mk.physical"))}
              ${susp ? tag(t("pa.suspended"), "mkr-susp") : p.status === "hidden" ? tag(t("panel.mkr.hidden")) : tag(t("pa.mk.onSale"), "st-resolved")}
              ${p.suspended_with_store ? tag(t("panel.mkr.storeSuspended"), "mkr-susp") : ""}
              ${p.reports ? tag(t("pa.mk.reports", { n: num(p.reports) }), "st-open") : ""}
            </div>
            ${susp && p.suspended_reason ? `<p class="mkr-why pa-why">${t("panel.mkr.why")} <q>${esc(p.suspended_reason)}</q></p>` : ""}
            <div class="crp-actions">
              ${susp
                ? (p.suspended_with_store ? "" : `<button class="btn btn-sm btn-primary" type="button" data-pa-act="restore">${t("panel.mkr.restoreProduct")}</button>`)
                : `<button class="btn btn-sm btn-danger" type="button" data-pa-act="suspend">${t("panel.mkr.suspendProduct")}</button>`}
              <button class="btn btn-sm btn-ghost pa-del" type="button" data-pa-act="delete">${t("pa.delete")}</button>
            </div>
            <div data-pa-slot></div>
          </article>`;
      },
      act: async (a, p, cardEl, btn, redraw) => {
        if (a === "restore") {
          if (!confirm(t("panel.mkr.restoreProductAsk"))) return;
          btn.disabled = true;
          const r = await rpc("market_moderate", { p_kind: "product", p_id: p.id, p_action: "restore", p_reason: "" });
          btn.disabled = false;
          if (!data(r)) return failToast(r, { store: "panel.mkr.errStore" });
          toast(t("panel.mkr.productRestored"));
          redraw();
          return;
        }
        if (a === "suspend") openSlot(cardEl, reasonForm("suspend", t("panel.mkr.reasonProduct"), esc(t("panel.mkr.productEffect")), t("panel.mkr.suspendProduct")));
        if (a === "delete") openSlot(cardEl, reasonForm("delete", t("pa.reasonOwner"), esc(t("pa.mk.delEffect")), t("pa.mk.deleteProduct")));
      },
      submit: async (a, form, p, cardEl, redraw) => {
        const reason = reasonOf(form);
        if (!reason) return;
        if (a === "delete" && !confirm(t("pa.deleteAsk"))) return;
        const r = await busy(form, () => rpc("market_moderate", { p_kind: "product", p_id: p.id, p_action: a, p_reason: reason }));
        if (!data(r)) return failToast(r);
        toast(t(a === "delete" ? "pa.deleted" : "panel.mkr.productSuspendedDone"));
        redraw();
      },
    }),
    orders: () => ({
      key: "mk-orders",
      filters: ORDER_FILTERS(),
      placeholder: t("pa.mk.searchOrders"),
      lead: t("pa.mk.ordersLead"),
      fetch: (st, off) => rpc("market_admin_orders", { p_filter: st.filter, p_q: st.q, p_limit: PAGE, p_offset: off }),
      card: (o, i) => {
        const href = `./Market.html?Product=${encodeURIComponent(o.product_id)}`;
        const paid = Boolean(o.settled_at);
        const can = Array.isArray(o.can) ? o.can : [];
        const staff = o.staff;
        return `
          <article class="crp-card pa-card pa-order st-${esc(o.status)}${staff ? " pa-staffed" : ""}" data-pa-i="${i}">
            <div class="crp-top">
              <a class="pa-thumb" href="${href}" target="_blank" rel="noopener">${img(o.image, o.title)}</a>
              <div class="crp-title">
                <h3><a href="${href}" target="_blank" rel="noopener">${esc(o.title)}</a>${o.qty > 1 ? ` <span class="muted">× ${num(o.qty)}</span>` : ""}</h3>
                <p><span dir="ltr">${esc(o.id)}</span> · ${esc(when(o.created_at))} · ${esc(o.store_name || "")}</p>
                <p>${t("pa.mk.buyer")} ${who(o.buyer)} → ${t("pa.mk.seller")} ${who(o.seller)}</p>
              </div>
              <span class="crp-count pa-total-pt">${pt(o.total)}</span>
            </div>
            <div class="crp-tags">
              ${tag(t(`mkt.st.${o.status}`), `pa-st pa-st-${esc(o.status)}`)}
              ${paid ? tag(t("pa.mk.paidOn", { date: day(o.settled_at) }), "st-resolved") : ["declined", "cancelled", "returned"].includes(o.status) ? "" : tag(o.release_at ? t("pa.mk.escrowUntil", { date: day(o.release_at) }) : t("pa.mk.escrow"), "st-open")}
              ${o.via_link ? tag(t("pa.mk.viaLink", { pts: num(o.commission || 0) })) : ""}
              ${o.delivery === "online" ? tag(t("pa.mk.digital")) : ""}
            </div>
            ${o.reason ? `<p class="mkr-why pa-why">${t("pa.mk.memberReason")} <q>${esc(o.reason)}</q></p>` : ""}
            ${staff ? `<p class="mkr-why pa-why pa-staff-line">${t(staff.action === "release" ? "pa.mk.staffReleased" : "pa.mk.staffRefunded", { by: esc(o.staff_by || "—"), date: esc(when(staff.at)) })} <q>${esc(staff.reason || "")}</q></p>` : ""}
            ${can.length ? `
              <div class="crp-actions">
                ${can.includes("refund") ? `<button class="btn btn-sm btn-danger" type="button" data-pa-act="refund">${t("pa.mk.refund")}</button>` : ""}
                ${can.includes("release") ? `<button class="btn btn-sm btn-primary" type="button" data-pa-act="release">${t("pa.mk.release")}</button>` : ""}
              </div>` : ""}
            <div data-pa-slot></div>
          </article>`;
      },
      act: (a, o, cardEl) => {
        if (a === "refund") {
          const effect = ["requested", "sold"].includes(o.status) ? "pa.mk.refundCancel" : o.status === "shipped" ? "pa.mk.refundShipped" : "pa.mk.refundReturned";
          openSlot(cardEl, reasonForm("refund", t("pa.mk.reasonBoth"), t(effect, { pts: pt(o.total) }), t("pa.mk.refundNow")));
        }
        if (a === "release") openSlot(cardEl, reasonForm("release", t("pa.mk.reasonBoth"), t("pa.mk.releaseEffect", { pts: pt(o.seller_gets ?? o.total) }), t("pa.mk.releaseNow"), false));
      },
      submit: async (a, form, o, cardEl, redraw) => {
        const reason = reasonOf(form);
        if (!reason) return;
        if (!confirm(t(a === "refund" ? "pa.mk.refundAsk" : "pa.mk.releaseAsk"))) return;
        const r = await busy(form, () => rpc("market_admin_order", { p_id: o.id, p_action: a, p_reason: reason }));
        if (!data(r)) return failToast(r, { settled: "pa.mk.errSettled" });
        toast(t(a === "refund" ? "pa.mk.refunded" : "pa.mk.released", { pts: pt(r.data.points) }));
        redraw();
      },
    }),
    categories: () => ({
      key: "mk-cats",
      sorts: [["products", t("pa.s.products")], ["new", t("pa.s.new")], ["name", t("pa.s.az")]],
      placeholder: t("pa.mk.searchCats"),
      lead: t("pa.mk.catsLead"),
      fetch: (st, off) => rpc("market_admin_categories", { p_q: st.q, p_sort: st.sort, p_limit: 60, p_offset: off }),
      card: (c, i) => `
        <article class="crp-card pa-card pa-cat" data-pa-i="${i}">
          <div class="crp-top">
            <div class="crp-title">
              <h3><a href="./Market.html?Categories=${encodeURIComponent(c.id)}" target="_blank" rel="noopener">${esc(c.name)}</a></h3>
              <p><span dir="ltr">${esc(c.id)}</span> · ${t("pa.mk.catBy", { name: c.by?.username ? "@" + esc(c.by.username) : "—" })} · ${esc(day(c.created_at))}</p>
            </div>
            <span class="crp-count">${t("pa.mk.catCount", { n: num(c.products) })}</span>
          </div>
          ${c.used ? "" : `<div class="crp-tags">${tag(t("pa.mk.unused"), "st-open")}</div>`}
          <div class="crp-actions">
            <button class="btn btn-sm btn-ghost" type="button" data-pa-act="rename">${t("pa.mk.rename")}</button>
            <button class="btn btn-sm btn-ghost" type="button" data-pa-act="merge">${t("pa.mk.merge")}</button>
            ${c.used ? "" : `<button class="btn btn-sm btn-danger" type="button" data-pa-act="delete">${t("pa.delete")}</button>`}
          </div>
          <div data-pa-slot></div>
        </article>`,
      act: async (a, c, cardEl, btn, redraw) => {
        if (a === "delete") {
          if (!confirm(t("pa.mk.catDeleteAsk", { name: c.name }))) return;
          btn.disabled = true;
          const r = await rpc("market_admin_category", { p_id: c.id, p_action: "delete", p_value: "" });
          btn.disabled = false;
          if (!data(r)) return failToast(r, { used: "pa.mk.errUsed" });
          toast(t("pa.deleted"));
          redraw();
          return;
        }
        const isRename = a === "rename";
        openSlot(cardEl, `
          <form class="pa-inline" data-pa-form="${a}">
            <label><span>${t(isRename ? "pa.mk.newName" : "pa.mk.mergeInto")}</span>
              <input name="value" type="text" maxlength="${isRename ? 40 : 20}" required value="${isRename ? esc(c.name) : ""}" placeholder="${esc(isRename ? "" : "CAT0000000")}" dir="auto" /></label>
            ${isRename ? "" : `<p class="muted">${t("pa.mk.mergeHint", { name: esc(c.name) })}</p>`}
            <div class="acc-actions">
              <button class="btn btn-sm btn-primary" type="submit">${t(isRename ? "common.save" : "pa.mk.merge")}</button>
              <button class="btn btn-sm btn-ghost" type="button" data-pa-cancel>${t("common.cancel")}</button>
            </div>
          </form>`);
      },
      submit: async (a, form, c, cardEl, redraw) => {
        const value = String(form.value.value || "").trim();
        if (!value) return;
        const r = await busy(form, () => rpc("market_admin_category", { p_id: c.id, p_action: a, p_value: value }));
        if (!data(r)) {
          if (r?.data?.reason === "exists") return toast(t("pa.mk.errExists", { name: r.data.name || "" }));
          return failToast(r, { name: "pa.mk.errName", target: "pa.mk.errTarget" });
        }
        toast(t(a === "merge" ? "pa.mk.merged" : "pa.saved"));
        redraw();
      },
    }),
    social: () => ({
      key: "mk-social",
      filters: [["reviews", t("pa.mk.reviews")], ["lists", t("pa.mk.lists")], ["recs", t("pa.mk.recs")]],
      placeholder: t("pa.mk.searchSocial"),
      before: (st) => `<label class="pa-check"><input type="checkbox" data-pa-only-susp ${st.onlySusp ? "checked" : ""} /> ${t("pa.mk.onlySuspended")}</label>`,
      change: (e, st, redraw) => {
        if (e.target.matches("[data-pa-only-susp]")) {
          st.onlySusp = e.target.checked;
          redraw();
        }
      },
      fetch: (st, off) => rpc("market_admin_social", { p_kind: st.filter, p_filter: st.onlySusp ? "suspended" : "all", p_q: st.q, p_limit: PAGE, p_offset: off }),
      card: (x, i) => `
        <article class="crp-card pa-card${x.suspended ? " pa-susp" : ""}" data-pa-i="${i}">
          <div class="crp-top">
            <a class="pa-thumb" href="${esc(x.href)}" target="_blank" rel="noopener">${img(x.image, x.title)}</a>
            <div class="crp-title">
              <h3><a href="${esc(x.href)}" target="_blank" rel="noopener">${esc(x.title || "—")}</a></h3>
              <p>${t(`pa.mk.kind.${x.kind}`)} · ${who(x.author)} · <span dir="ltr">${esc(x.id)}</span> · ${esc(day(x.created_at))}</p>
            </div>
          </div>
          ${x.text ? `<p class="pa-text">${x.kind === "review" ? `<b class="pa-pro">+</b> ` : ""}${esc(x.text)}</p>` : ""}
          ${x.cons ? `<p class="pa-text"><b class="pa-con">−</b> ${esc(x.cons)}</p>` : ""}
          <div class="crp-tags">${visTag(x.visibility)}${x.verified && x.kind === "review" ? tag(t("pa.mk.verified"), "st-resolved") : ""}${x.suspended ? tag(t("pa.suspended"), "mkr-susp") : ""}</div>
          ${suspLine(x.suspended)}
          <div class="crp-actions">
            ${x.suspended
              ? `<button class="btn btn-sm btn-primary" type="button" data-pa-act="restore">${t("pa.restore")}</button>`
              : `<button class="btn btn-sm btn-danger" type="button" data-pa-act="suspend">${t("pa.suspend")}</button>`}
            <button class="btn btn-sm btn-ghost pa-del" type="button" data-pa-act="delete">${t("pa.delete")}</button>
          </div>
          <div data-pa-slot></div>
        </article>`,
      act: async (a, x, cardEl, btn, redraw) => {
        if (a === "restore") {
          if (!confirm(t("pa.restoreAsk"))) return;
          btn.disabled = true;
          const r = await rpc("market_admin_social_moderate", { p_kind: x.kind, p_id: x.id, p_action: "restore", p_reason: "" });
          btn.disabled = false;
          if (!data(r)) return failToast(r);
          toast(t("pa.restored"));
          redraw();
          return;
        }
        openSlot(cardEl, reasonForm(a, t("pa.reasonOwner"), esc(t(a === "delete" ? "pa.mk.socialDelEffect" : "pa.mk.socialEffect")), t(a === "delete" ? "pa.delete" : "pa.suspend")));
      },
      submit: async (a, form, x, cardEl, redraw) => {
        const reason = reasonOf(form);
        if (!reason) return;
        if (a === "delete" && !confirm(t("pa.deleteAsk"))) return;
        const r = await busy(form, () => rpc("market_admin_social_moderate", { p_kind: x.kind, p_id: x.id, p_action: a, p_reason: reason }));
        if (!data(r)) return failToast(r);
        toast(t(a === "delete" ? "pa.deleted" : "pa.suspendedDone"));
        redraw();
      },
    }),
  };

  async function viewMarket(main) {
    const tabs = ["stores", "products", "orders", "categories", "social"];
    const tab = tabs.includes(ctx.state.paMarketTab) ? ctx.state.paMarketTab : "orders";
    main.innerHTML = `
      ${head(t("panel.nav.market"), t("pa.mk.title"), t("pa.mk.lead"))}
      <div class="pa-strip" id="pa-mk-strip"></div>
      ${tabsHtml("pa-mtab", [["orders", t("pa.mk.orders")], ["stores", t("pa.mk.stores")], ["products", t("pa.mk.products")], ["categories", t("pa.mk.categories")], ["social", t("pa.mk.social")]], tab)}
      <div class="follow-pane pa-pane" id="pa-pane"></div>`;
    main.querySelector(".pa-tabs").onclick = (e) => {
      const b = e.target.closest("[data-pa-mtab]");
      if (!b || b.dataset.paMtab === tab) return;
      ctx.state.paMarketTab = b.dataset.paMtab;
      viewMarket(main);
    };
    const strip = main.querySelector("#pa-mk-strip");
    rpc("market_admin_overview", {}).then((r) => {
      const d = data(r);
      if (!d || !strip.isConnected) {
        strip.hidden = true;
        return;
      }
      const cell = (label, value, extra = "") => `<div class="pa-cell${extra}"><span>${esc(label)}</span><strong dir="ltr">${value}</strong></div>`;
      strip.innerHTML = `
        ${cell(t("pa.ov.stores"), `${num(d.stores.open)}<small>/${num(d.stores.all)}</small>`)}
        ${cell(t("pa.ov.products"), num(d.products.active))}
        ${cell(t("pa.ov.openOrders"), num(d.orders.open))}
        ${cell(t("pa.mk.returns"), num(d.orders.return_requested), d.orders.return_requested ? " warn" : "")}
        ${cell(t("pa.mk.escrowHeld"), pt(d.orders.escrow))}
        ${cell(t("pa.ov.sales30"), pt(d.orders.sales_30d))}
        ${d.reports ? `<button type="button" class="pa-cell warn" data-pa-go-reports><span>${t("pa.ov.reports")}</span><strong dir="ltr">${num(d.reports)}</strong></button>` : ""}`;
      strip.onclick = (e) => {
        if (e.target.closest("[data-pa-go-reports]")) ctx.go("reports", { reportTab: "market" });
      };
    });
    await drawList(main.querySelector("#pa-pane"), marketCfg[tab]());
  }

  // ================================================================ Packages
  // Accounts · Points · Prizes (sql/packages.sql, sql/point_codes.sql): one form and one list each.
  const PK_KINDS = ["account", "points", "prize"];
  const PK_PLANS = ["Free", "Silver", "Gold", "Diamond"];
  const PK_MONTHS = { Free: 1, Silver: 3, Gold: 6, Diamond: 12 };
  const PK_LANGS = ["en", "ar", "fr", "de", "es", "nl", "it"];
  const PK_ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const pkLevel = (n) => (Number(n) >= 10 ? "LV Max" : `LV${Number(n) || 0}`);
  const pkSerial = () => {
    const bytes = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    const raw = [...bytes].map((b) => PK_ABC[b % PK_ABC.length]).join("");
    return raw.match(/.{4}/g).join("-");
  };
  const pkPlan = (p) => (C.tr ? C.tr(p) : p);
  const pkMonths = (n) => t(Number(n) === 1 ? "pk.month1" : "pk.monthsN", { n: num(n) });
  // what a code gives: "Gold · 3 months · activation or reactivation", "+500 PT", "−200 PT off a prize"
  const pkValue = (kind, v = {}) => {
    if (kind === "account") return `${esc(pkPlan(v.plan || ""))} · ${esc(pkMonths(v.months))} · ${esc(t(`pk.use.${v.use_for || "both"}`))}`;
    if (kind === "points") return t("pk.addsN", { pts: pt(v.points) });
    return t("pk.offN", { pts: pt(v.points_off) });
  };
  // who may use it, in a line
  const pkAudText = (a = {}) => {
    if (a.type === "private") {
      const list = (a.members || []).map((m) => (m.username ? `<bdi>@${esc(m.username)}</bdi>` : `<span dir="ltr">${esc(m.id)}</span>`)).join(", ");
      return `${esc(t("pk.aud.private"))}: ${list || "—"}`;
    }
    if (a.type !== "exclusive") return esc(t("pk.aud.publicLine"));
    const bits = [];
    if (a.memberships?.length) bits.push(a.memberships.map((p) => esc(pkPlan(p))).join(" / "));
    if (a.countries?.length) bits.push(a.countries.map((cc) => esc(C.countryName?.(cc) || cc)).join(", "));
    if (a.languages?.length) bits.push(a.languages.map((l) => esc((C.LANG_NAMES && C.LANG_NAMES[l]) || l)).join(", "));
    if (a.min_level != null || a.max_level != null) {
      bits.push(a.min_level != null && a.max_level != null ? `${pkLevel(a.min_level)}–${pkLevel(a.max_level)}`
        : a.min_level != null ? esc(t("pk.levelFrom", { lv: pkLevel(a.min_level) })) : esc(t("pk.levelTo", { lv: pkLevel(a.max_level) })));
    }
    if (a.min_days != null || a.max_days != null) {
      bits.push(a.min_days != null && a.max_days != null ? esc(t("pk.ageBetween", { a: num(a.min_days), b: num(a.max_days) }))
        : a.min_days != null ? esc(t("pk.ageMin", { n: num(a.min_days) })) : esc(t("pk.ageMax", { n: num(a.max_days) })));
    }
    return `${esc(t("pk.aud.exclusive"))}: ${bits.join(" · ")}`;
  };
  const PK_ERR = {
    code: "pk.err.code", taken: "pk.err.taken", plan: "pk.err.plan", months: "pk.err.months", use_for: "pk.err.useFor",
    points: "pk.err.points", uses: "pk.err.uses", days: "pk.err.days", note: "pk.err.note", audience: "pk.err.audience",
    criteria: "pk.err.criteria", level: "pk.err.level", age: "pk.err.age", members: "pk.err.members", members_many: "pk.err.membersMany",
    kind: "panel.actFail",
  };

  function pkFormHtml(kind) {
    const levels = `<option value="">—</option>${Array.from({ length: 11 }, (_, i) => `<option value="${i}">${pkLevel(i)}</option>`).join("")}`;
    return `
      <form class="pa-form-grid pk-form" id="pk-form" novalidate>
        <label class="wide"><span>${t("pk.serial")}</span>
          <span class="pk-serial">
            <input name="code" type="text" maxlength="40" dir="ltr" autocomplete="off" spellcheck="false" autocapitalize="characters" placeholder="${esc(t("pk.serialPh"))}" />
            <button class="btn btn-sm btn-ghost" type="button" data-pk-gen>${C.navIcon("codes")}<span>${t("pk.generate")}</span></button>
          </span>
          <small class="muted">${t("pk.serialHint")}</small>
        </label>
        ${kind === "account" ? `
        <label><span>${t("pk.useFor")}</span>
          <select name="use_for">${["both", "activate", "reactivate"].map((k) => `<option value="${k}">${esc(t(`pk.use.${k}`))}</option>`).join("")}</select></label>
        <label><span>${t("pk.plan")}</span>
          <select name="plan">${PK_PLANS.map((p) => `<option value="${p}"${p === "Silver" ? " selected" : ""}>${esc(pkPlan(p))}</option>`).join("")}</select></label>
        <label><span>${t("pk.months")}</span><input name="months" type="number" min="1" max="120" step="1" value="${PK_MONTHS.Silver}" required /></label>`
        : `<label><span>${t(kind === "points" ? "pk.points" : "pk.pointsOff")}</span>
          <input name="points" type="number" min="1" max="100000000" step="1" value="${kind === "points" ? 500 : 100}" required /></label>`}
        <label data-pk-uses><span>${t("pk.uses")}</span><input name="max_uses" type="number" min="1" max="1000000" step="1" value="1" required />
          <small class="muted">${t("pk.usesHint")}</small></label>
        <label><span>${t("pk.days")}</span><input name="days" type="number" min="1" max="3650" step="1" placeholder="${esc(t("pk.daysPh"))}" /></label>
        <label class="wide"><span>${t("pk.note")}</span><input name="note" type="text" maxlength="120" placeholder="${esc(t("pk.notePh"))}" dir="auto" /></label>
        <fieldset class="wide pk-aud">
          <legend>${t("pk.audience")}</legend>
          <div class="pk-aud-pick">
            ${["public", "exclusive", "private"].map((a) => `
              <label class="pk-aud-opt"><input type="radio" name="audience" value="${a}"${a === "public" ? " checked" : ""} />
                <span><b>${t(`pk.aud.${a}`)}</b><small>${t(`pk.aud.${a}Hint`)}</small></span></label>`).join("")}
          </div>
          <div class="pk-excl" data-pk-excl hidden>
            ${kind === "account" ? "" : `
            <div class="pk-row"><span class="pk-lbl">${t("pk.c.memberships")}</span>
              <span class="pk-checks">${PK_PLANS.map((p) => `<label class="lang-chip"><input type="checkbox" name="memberships" value="${p}" /> ${esc(pkPlan(p))}</label>`).join("")}</span></div>`}
            <div class="pk-row"><span class="pk-lbl">${t("pk.c.countries")}</span>
              <span class="pk-countries">
                <select data-pk-cty aria-label="${esc(t("pk.c.addCountry"))}"><option value="">${esc(t("pk.c.addCountry"))}</option>${C.countryChoices().map(([cc, n]) => `<option value="${cc}">${esc(n)}</option>`).join("")}</select>
                <span class="pk-chips" data-pk-chips></span>
              </span></div>
            <div class="pk-row"><span class="pk-lbl">${t("pk.c.languages")}</span>
              <span class="pk-checks">${PK_LANGS.map((l) => `<label class="lang-chip"><input type="checkbox" name="languages" value="${l}" /> <span lang="${l}">${esc((C.LANG_NAMES && C.LANG_NAMES[l]) || l)}</span></label>`).join("")}</span></div>
            <div class="pk-row"><span class="pk-lbl">${t("pk.c.level")}</span>
              <span class="pk-range">
                <label><span>${t("pk.from")}</span><select name="min_level">${levels}</select></label>
                <label><span>${t("pk.to")}</span><select name="max_level">${levels}</select></label>
              </span></div>
            <div class="pk-row"><span class="pk-lbl">${t("pk.c.age")}</span>
              <span class="pk-range">
                <label><span>${t("pk.atLeast")}</span><input name="min_days" type="number" min="0" max="36500" step="1" placeholder="0" /></label>
                <label><span>${t("pk.atMost")}</span><input name="max_days" type="number" min="0" max="36500" step="1" placeholder="∞" /></label>
                <small class="muted">${t("pk.c.ageHint")}</small>
              </span></div>
            <p class="muted pk-excl-hint">${t("pk.c.allHint")}</p>
          </div>
          <div class="pk-priv" data-pk-priv hidden>
            <label><span>${t("pk.members")}</span>
              <textarea name="members" rows="2" dir="auto" placeholder="${esc(t("pk.membersPh"))}"></textarea></label>
            <small class="muted">${t("pk.membersHint")}</small>
            <p class="pk-auto-hint">${C.navIcon("notifications")}<span>${t(`pk.auto.${kind}`)}</span></p>
          </div>
        </fieldset>
        <div class="wide pa-form-foot">
          <p class="muted" id="pk-sum"></p>
          <button class="btn btn-sm btn-primary" type="submit">${t("pk.save")}</button>
        </div>
      </form>`;
  }

  async function viewPackages(main) {
    const st = ctx.state;
    const kind = PK_KINDS.includes(st.paPackTab) ? st.paPackTab : "account";
    main.innerHTML = `
      ${head(t("panel.nav.packages"), t("pk.title"), t("pk.lead"))}
      ${tabsHtml("pk-tab", PK_KINDS.map((k) => [k, t(`pk.tab.${k}`)]), kind)}
      <section class="pa-box pa-make pk-make">
        <h2>${t(`pk.new.${kind}`)}</h2>
        <p class="muted pk-where">${t(`pk.where.${kind}`)}</p>
        ${pkFormHtml(kind)}
        <div id="pk-made"></div>
      </section>
      <section class="pa-group">
        <h2>${t(`pk.list.${kind}`)}</h2>
        <div class="pa-pane" id="pa-pane"></div>
      </section>`;
    main.querySelectorAll("[data-pk-tab]").forEach((b) => {
      b.onclick = () => {
        st.paPackTab = b.dataset.pkTab;
        viewPackages(main);
      };
    });
    const form = main.querySelector("#pk-form");
    const countries = [];
    const sum = main.querySelector("#pk-sum");
    const audOf = () => form.querySelector('input[name="audience"]:checked')?.value || "public";
    const drawChips = () => {
      form.querySelector("[data-pk-chips]").innerHTML = countries
        .map((cc) => `<span class="ipl-chip">${esc(C.countryName?.(cc) || cc)}<button type="button" data-pk-uncty="${esc(cc)}" aria-label="${esc(t("rich.remove"))} ${esc(C.countryName?.(cc) || cc)}">×</button></span>`)
        .join("");
    };
    const showSum = () => {
      const a = audOf();
      form.querySelector("[data-pk-excl]").hidden = a !== "exclusive";
      form.querySelector("[data-pk-priv]").hidden = a !== "private";
      // private: once for each member named, by itself (the server counts them)
      form.querySelector("[data-pk-uses]").hidden = a === "private";
      const uses = Math.max(1, Number(form.max_uses.value) || 1);
      const what = kind === "account"
        ? pkValue("account", { plan: form.plan.value, months: Number(form.months.value) || 1, use_for: form.use_for.value })
        : pkValue(kind, kind === "points" ? { points: form.points.value } : { points_off: form.points.value });
      const usesText = a === "private" ? t("pk.autoEach") : t(uses === 1 ? "pk.usesOne" : "pk.usesN", { n: num(uses) });
      sum.innerHTML = t("pk.sum", { what, uses: esc(usesText), who: esc(t(`pk.aud.${a}`)) });
    };
    form.addEventListener("input", showSum);
    form.addEventListener("change", (e) => {
      if (e.target.name === "plan" && form.months) form.months.value = PK_MONTHS[e.target.value] || 1;
      if (e.target.matches("[data-pk-cty]")) {
        const cc = e.target.value;
        if (cc && !countries.includes(cc)) countries.push(cc);
        e.target.value = "";
        drawChips();
      }
      showSum();
    });
    form.addEventListener("click", (e) => {
      if (e.target.closest("[data-pk-gen]")) {
        form.code.value = pkSerial();
        form.code.focus();
        return;
      }
      const un = e.target.closest("[data-pk-uncty]");
      if (un) {
        countries.splice(countries.indexOf(un.dataset.pkUncty), 1);
        drawChips();
      }
    });
    showSum();

    const pane = main.querySelector("#pa-pane");
    const cfg = {
      key: `pk-${kind}`,
      filters: [["unused", t("pk.f.unused")], ["used", t("pk.f.used")], ["expired", t("pk.f.expired")], ["all", t("pa.f.all")]],
      placeholder: t("pk.search"),
      fetch: (s, off) => rpc("pack_codes_admin", { p_kind: kind, p_filter: s.filter, p_q: s.q, p_limit: 50, p_offset: off }),
      card: (c, i) => {
        const can = c.state !== "used";
        const recent = (c.recent || []).map((u) => (u.username ? `<a href="${esc(C.profileHref(u.username))}" target="_blank" rel="noopener"><bdi>@${esc(u.username)}</bdi></a>` : `<span dir="ltr">${esc(u.id)}</span>`)).join(", ");
        return `
        <article class="crp-card pa-card pa-code pk-card st-${esc(c.state)}" data-pa-i="${i}">
          <div class="crp-top">
            ${can ? `<input class="pa-pick" type="checkbox" data-pa-pick aria-label="${esc(t("pa.pc.pick"))}" />` : ""}
            <div class="crp-title">
              <h3><code dir="ltr">${esc(c.code)}</code></h3>
              <p class="pk-value">${pkValue(kind, c.value)}</p>
              <p>${pkAudText(c.audience)}${c.expires_at ? ` · ${t(c.state === "expired" ? "pa.pc.expiredOn" : "pa.pc.expiresOn", { date: esc(day(c.expires_at)) })}` : ""}</p>
              <p class="muted">${c.note ? `${esc(c.note)} · ` : ""}${esc(day(c.created_at))}${c.made_by ? ` · ${t("pa.pc.by", { name: esc(c.made_by) })}` : ""}</p>
              ${recent ? `<p class="pk-recent">${t(c.audience?.type === "private" && kind !== "prize" ? "pk.givenTo" : "pk.usedBy", { list: recent })}</p>` : ""}
            </div>
            <span class="crp-count pk-uses" dir="ltr" title="${esc(t("pk.usesTitle"))}">${num(c.uses)} / ${num(c.max_uses)}</span>
          </div>
          <div class="crp-actions">
            ${tag(t(`pk.f.${c.state}`), c.state === "unused" ? "st-resolved" : c.state === "expired" ? "mkr-susp" : "")}
            <button class="btn btn-sm btn-ghost" type="button" data-pa-act="copy">${t("common.copy")}</button>
            ${can ? `<button class="btn btn-sm btn-ghost pa-del" type="button" data-pa-act="delete">${t("pa.delete")}</button>` : ""}
          </div>
        </article>`;
      },
      // "Delete the chosen codes", above a list with codes that can still be deleted
      before: (s, d) => (s.filter !== "used" && Number(d?.total) > 0 ? `<div class="pa-bulk" data-pa-i="-1"><button class="btn btn-sm btn-ghost pa-del" type="button" data-pa-act="delete-picked" data-pa-any="1">${t("pa.pc.deletePicked")}</button></div>` : ""),
      act: async (a, c, cardEl, btn, redraw, s) => {
        if (a === "copy") return copy(c.code);
        const del = async (codes) => {
          const r = await rpc("pack_codes_delete", { p_kind: kind, p_codes: codes });
          if (!data(r)) return failToast(r);
          toast(t("pa.pc.deleted", { n: num(r.data.deleted) }));
          redraw();
        };
        if (a === "delete-picked") {
          const picked = [...pane.querySelectorAll("[data-pa-pick]:checked")].map((x) => s.items[Number(x.closest("[data-pa-i]").dataset.paI)]?.code).filter(Boolean);
          if (!picked.length) return toast(t("pa.pc.pickSome"));
          if (!confirm(t("pa.pc.deleteMany", { n: num(picked.length) }))) return;
          return del(picked);
        }
        if (a === "delete") {
          if (!confirm(t("pa.pc.deleteOne", { code: c.code }))) return;
          return del([c.code]);
        }
      },
    };
    drawList(pane, cfg);

    form.onsubmit = async (e) => {
      e.preventDefault();
      const aud = audOf();
      const val = (n) => String(form[n]?.value ?? "").trim();
      const d = { code: val("code"), max_uses: val("max_uses"), days: val("days"), note: val("note"), audience: aud, aud: {} };
      if (kind === "account") Object.assign(d, { plan: val("plan"), months: val("months"), use_for: val("use_for") });
      else d[kind === "points" ? "points" : "points_off"] = val("points");
      if (aud === "exclusive") {
        const picked = (n) => [...form.querySelectorAll(`input[name="${n}"]:checked`)].map((x) => x.value);
        d.aud = {
          memberships: kind === "account" ? [] : picked("memberships"), countries: countries.slice(), languages: picked("languages"),
          min_level: val("min_level"), max_level: val("max_level"), min_days: val("min_days"), max_days: val("max_days"),
        };
      } else if (aud === "private") {
        d.aud = { members: val("members").split(/[\s,;،]+/).map((x) => x.trim()).filter(Boolean) };
      }
      const r = await busy(form, () => rpc("pack_code_save", { p_kind: kind, d }));
      const res = data(r);
      if (!res) {
        if (r?.data?.reason === "members" && r.data.unknown?.length) return toast(t("pk.err.unknown", { list: r.data.unknown.join(", ") }));
        return failToast(r, PK_ERR);
      }
      const it = res.item;
      // a private code went by itself to the members named: how many, and who could not have it
      const au = res.auto;
      const skipped = (au?.skipped || []).map((x) => `${x.username ? `<bdi>@${esc(x.username)}</bdi>` : `<span dir="ltr">${esc(x.id)}</span>`} (${esc(t(`pk.skip.${x.reason}`))})`).join(", ");
      const autoHtml = au ? `
          <p class="pk-auto-done">${C.navIcon("notifications")}<span>${t(kind === "prize" ? "pk.autoTold" : "pk.autoGiven", { n: num(au.given), m: num(au.members) })}</span></p>
          ${skipped ? `<p class="pk-auto-skip">${t("pk.autoSkipped", { list: skipped })}</p>` : ""}` : "";
      main.querySelector("#pk-made").innerHTML = `
        <div class="pa-made pk-made-box" role="status">
          <p><strong>${t("pk.made")}</strong></p>
          <p class="pk-made-code"><code dir="ltr">${esc(it.code)}</code>
            <button class="btn btn-sm btn-primary" type="button" data-pk-copy>${t("common.copy")}</button></p>
          <p>${pkValue(kind, it.value)} · ${esc(au ? t("pk.autoEach") : t(Number(it.max_uses) === 1 ? "pk.usesOne" : "pk.usesN", { n: num(it.max_uses) }))}</p>
          <p class="muted">${pkAudText(it.audience)}${it.expires_at ? ` · ${t("pa.pc.expiresOn", { date: esc(day(it.expires_at)) })}` : ""}</p>${autoHtml}
        </div>`;
      main.querySelector("[data-pk-copy]").onclick = () => copy(it.code);
      toast(au && kind !== "prize" ? t("pk.madeAuto", { n: num(au.given), m: num(au.members) }) : t("pk.madeToast"));
      form.code.value = "";
      const s = listState(cfg);
      s.filter = "unused";
      s.q = "";
      drawList(pane, cfg);
    };
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast(t("pa.copied"));
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        toast(t("pa.copied"));
      } catch {
        toast(t("panel.actFail"));
      }
      ta.remove();
    }
  }

  // ================================================================ Announcements
  const TONES = ["info", "success", "warning", "promo"];
  const localInput = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  async function viewAnnounce(main) {
    main.innerHTML = `
      ${head(t("panel.nav.announce"), t("pa.an.title"), t("pa.an.lead"))}
      <section class="pa-box" id="pa-banner"><p class="muted">${t("pa.loading")}</p></section>
      <section class="pa-box" id="pa-send"></section>
      <section class="pa-group"><h2>${t("pa.an.history")}</h2><div id="pa-hist"><p class="muted">${t("pa.loading")}</p></div></section>`;
    const bannerBox = main.querySelector("#pa-banner");
    const sendBox = main.querySelector("#pa-send");
    const hist = main.querySelector("#pa-hist");
    const [rb, rh] = await Promise.all([rpc("site_banner_admin", {}), rpc("announce_list", { p_limit: 30 })]);
    if (!bannerBox.isConnected) return;
    const b = data(rb)?.banner;
    if (!b) {
      bannerBox.innerHTML = `<div class="form-alert show warn">${t(errKey(rb))}</div>`;
      sendBox.hidden = true;
      hist.innerHTML = "";
      return;
    }
    // the bar of the home page
    bannerBox.innerHTML = `
      <h2>${t("pa.an.banner")}</h2>
      <p class="muted">${t("pa.an.bannerLead")}</p>
      <div class="pa-banner-preview" id="pa-bp"></div>
      <form class="pa-form-grid" id="pa-bform">
        <label class="wide"><span>${t("pa.an.text")} <small class="muted" id="pa-bcount"></small></span>
          <textarea name="text" rows="2" maxlength="280" placeholder="${esc(t("pa.an.textPh"))}" dir="auto">${esc(b.text || "")}</textarea></label>
        <label><span>${t("pa.an.link")}</span><input name="link" type="text" maxlength="500" value="${esc(b.link || "")}" placeholder="./Market.html" dir="ltr" /></label>
        <label><span>${t("pa.an.linkLabel")}</span><input name="link_label" type="text" maxlength="40" value="${esc(b.link_label || "")}" placeholder="${esc(t("pa.an.linkLabelPh"))}" dir="auto" /></label>
        <label><span>${t("pa.an.tone")}</span><select name="tone">${TONES.map((x) => `<option value="${x}"${x === b.tone ? " selected" : ""}>${t(`pa.an.tone.${x}`)}</option>`).join("")}</select></label>
        <label><span>${t("pa.an.starts")}</span><input name="starts_at" type="datetime-local" value="${esc(localInput(b.starts_at))}" /></label>
        <label><span>${t("pa.an.ends")}</span><input name="ends_at" type="datetime-local" value="${esc(localInput(b.ends_at))}" /></label>
        <label class="pa-switch"><input name="active" type="checkbox" ${b.active ? "checked" : ""} /> <span>${t("pa.an.active")}</span></label>
        <div class="wide pa-form-foot">
          <p class="muted">${[b.updated_by ? t("pa.an.updatedBy", { name: esc(b.updated_by), date: esc(when(b.updated_at)) }) : "", b.active ? `<strong>${t(b.showing ? "pa.an.showing" : "pa.an.notShowing")}</strong>` : ""].filter(Boolean).join(" · ")}</p>
          <button class="btn btn-sm btn-primary" type="submit">${t("pa.an.saveBanner")}</button>
        </div>
      </form>`;
    const bform = bannerBox.querySelector("#pa-bform");
    const preview = () => {
      const text = bform.text.value.trim();
      const tone = bform.tone.value;
      bannerBox.querySelector("#pa-bcount").textContent = `${bform.text.value.length}/280`;
      bannerBox.querySelector("#pa-bp").innerHTML = text
        ? `<div class="site-banner tone-${esc(tone)}"><span class="site-banner-text" dir="auto">${esc(text)}</span>${bform.link.value.trim() ? `<span class="site-banner-link">${esc(bform.link_label.value.trim() || t("hb.more"))}</span>` : ""}<span class="site-banner-x" aria-hidden="true">×</span></div>`
        : `<p class="muted pa-bp-empty">${t("pa.an.previewEmpty")}</p>`;
    };
    bform.oninput = preview;
    bform.onchange = preview;
    preview();
    bform.onsubmit = async (e) => {
      e.preventDefault();
      const iso = (v) => (v ? new Date(v).toISOString() : "");
      const r = await busy(bform, () => rpc("site_banner_save", {
        d: {
          text: bform.text.value, link: bform.link.value.trim(), link_label: bform.link_label.value.trim(), tone: bform.tone.value,
          active: bform.active.checked, starts_at: iso(bform.starts_at.value), ends_at: iso(bform.ends_at.value),
        },
      }));
      if (!data(r)) return failToast(r, { text: "pa.an.errText", link: "pa.an.errLink", label: "pa.an.errLabel", dates: "pa.an.errDates", tone: "panel.actFail" });
      toast(t("pa.an.bannerSaved"));
      viewAnnounce(main);
    };

    // a message to the members
    sendBox.innerHTML = `
      <h2>${t("pa.an.send")}</h2>
      <p class="muted">${t("pa.an.sendLead")}</p>
      <form class="pa-form-grid" id="pa-aform">
        <label class="wide"><span>${t("pa.an.aTitle")}</span><input name="title" type="text" maxlength="120" required placeholder="${esc(t("pa.an.aTitlePh"))}" dir="auto" /></label>
        <label class="wide"><span>${t("pa.an.aBody")}</span><textarea name="body" rows="3" maxlength="500" placeholder="${esc(t("pa.an.aBodyPh"))}" dir="auto"></textarea></label>
        <label><span>${t("pa.an.link")}</span><input name="href" type="text" maxlength="500" placeholder="./Market.html" dir="ltr" /></label>
        <label><span>${t("pa.an.audience")}</span>
          <select name="audience">
            <option value="all">${t("pa.an.aud.all")}</option>
            <option value="free">${t("pa.an.aud.free")}</option>
            <option value="premium">${t("pa.an.aud.premium")}</option>
            <option value="country">${t("pa.an.aud.country")}</option>
          </select></label>
        <label data-pa-country hidden><span>${t("pa.an.country")}</span><input name="country" type="text" maxlength="2" placeholder="MA" dir="ltr" /></label>
        <div class="wide pa-form-foot">
          <p class="muted" id="pa-reach"></p>
          <button class="btn btn-sm btn-primary" type="submit">${t("pa.an.sendBtn")}</button>
        </div>
      </form>`;
    const aform = sendBox.querySelector("#pa-aform");
    const reach = sendBox.querySelector("#pa-reach");
    let reachSeq = 0;
    const updateReach = async () => {
      const aud = aform.audience.value;
      aform.querySelector("[data-pa-country]").hidden = aud !== "country";
      const cc = aform.country.value.trim().toUpperCase();
      if (aud === "country" && !/^[A-Z]{2}$/.test(cc)) {
        reach.textContent = t("pa.an.pickCountry");
        return;
      }
      const seq = ++reachSeq;
      const r = await rpc("announce_preview", { p_audience: aud, p_country: cc });
      if (seq !== reachSeq || !reach.isConnected) return;
      const d = data(r);
      reach.innerHTML = d ? t("pa.an.reach", { n: `<strong>${num(d.count)}</strong>` }) : "";
    };
    aform.audience.onchange = updateReach;
    aform.country.oninput = updateReach;
    updateReach();
    aform.onsubmit = async (e) => {
      e.preventDefault();
      const title = aform.title.value.trim();
      if (title.length < 3) return toast(t("pa.an.errTitle"));
      if (!confirm(t("pa.an.sendAsk", { reach: reach.textContent || "" }))) return;
      const r = await busy(aform, () => rpc("announce_send", {
        p_title: title, p_body: aform.body.value.trim(), p_href: aform.href.value.trim(),
        p_audience: aform.audience.value, p_country: aform.country.value.trim().toUpperCase(),
      }));
      const d = data(r);
      if (!d) return failToast(r, { title: "pa.an.errTitle", body: "pa.an.errBody", link: "pa.an.errLink", country: "pa.an.pickCountry", nobody: "pa.an.errNobody", duplicate: "pa.an.errDuplicate", audience: "panel.actFail" });
      toast(t("pa.an.sent", { n: num(d.sent) }));
      viewAnnounce(main);
    };

    // what was sent
    const items = data(rh)?.items || [];
    hist.innerHTML = items.length
      ? `<div class="crp-list">${items.map((a) => `
          <article class="crp-card pa-card pa-ann">
            <div class="crp-top">
              <span class="pa-thumb pa-ico">${C.navIcon ? C.navIcon("announce") : ""}</span>
              <div class="crp-title">
                <h3>${esc(a.title)}</h3>
                ${a.body ? `<p class="pa-text">${esc(a.body)}</p>` : ""}
                <p>${esc(when(a.created_at))} · ${t("pa.an.by", { name: esc(a.sent_by || "—") })}${a.href ? ` · <span dir="ltr">${esc(a.href)}</span>` : ""}</p>
              </div>
              <span class="crp-count">${t("pa.an.sentN", { n: num(a.sent) })}</span>
            </div>
            <div class="crp-tags">${tag(a.audience === "country" ? `${t("pa.an.aud.country")}: ${a.country}` : t(`pa.an.aud.${a.audience}`))}${tag(t("pa.an.readN", { n: num(a.read), pct: a.sent ? Math.round((100 * Number(a.read || 0)) / Number(a.sent)) : 0 }))}</div>
          </article>`).join("")}</div>`
      : `<p class="empty">${t("pa.an.none")}</p>`;
  }

  // ================================================================ Accounts > Full info: a member at a glance
  async function memberSummary(box, memberId) {
    if (!box) return;
    box.innerHTML = `<p class="muted">${t("pa.loading")}</p>`;
    const r = await rpc("panel_member_summary", { p_member: memberId });
    if (!box.isConnected) return;
    const d = data(r);
    if (!d) {
      box.innerHTML = errKey(r) === "pa.setup" ? `<p class="muted">${t("pa.setup")}</p>` : "";
      return;
    }
    const row = (label, value) => `<div>${esc(label)} <strong>${value}</strong></div>`;
    const lv = d.level;
    const st = d.market?.store;
    box.innerHTML = `
      <h3 class="pa-sum-title">${t("pa.sum.title")}</h3>
      <div class="success-meta pa-sum">
        ${row(t("pa.sum.points"), `${pt(d.points?.available ?? 0)} <small class="muted">${t("pa.sum.earned", { pts: pt(d.points?.earned ?? 0) })}</small>`)}
        ${lv ? row(t("pa.sum.level"), `${esc(lv.name)} · ×${esc(lv.multiplier)}`) : ""}
        ${row(t("pa.sum.follows"), t("pa.sum.followsV", { followers: num(d.follows?.followers), following: num(d.follows?.following) }))}
        ${row(t("pa.sum.videos"), t("pa.sum.videosV", { n: num(d.content?.videos), views: num(d.content?.views), s: num(d.content?.suspended) }))}
        ${row(t("pa.sum.playlists"), t("pa.sum.listsV", { playlists: num(d.content?.playlists), iptv: num(d.iptv?.lists) }))}
        ${row(t("pa.sum.store"), st ? `${esc(st.name)} ${tierHtml(st.tier)}${st.suspended ? ` · ${esc(t("pa.suspended"))}` : ""}` : "—")}
        ${row(t("pa.sum.orders"), t("pa.sum.ordersV", { sales: num(d.market?.sales), purchases: num(d.market?.purchases), open: num(d.market?.open_orders) }))}
        ${row(t("pa.sum.reviews"), num(d.market?.reviews))}
        ${d.market?.reports ? row(t("pa.sum.reports"), num(d.market.reports)) : ""}
        ${row(t("pa.sum.codes"), t("pa.sum.codesV", { n: num(d.codes?.used), pts: pt(d.codes?.points) }))}
        ${d.codes?.accounts != null ? row(t("pk.sum.packs"), t("pk.sum.packsV", { a: num(d.codes.accounts), p: num(d.codes.prizes) })) : ""}
        ${row(t("pa.sum.claims"), t("pa.sum.claimsV", { n: num(d.claims?.all), open: num(d.claims?.open) }))}
        ${d.withdrawals ? row(t("pw.sum"), t("pw.sumV", { n: num(d.withdrawals.paid), pts: pt(d.withdrawals.points), open: num(d.withdrawals.open) })) : ""}
      </div>`;
  }

  const VIEWS = { overview: viewOverview, content: viewContent, market: viewMarket, packages: viewPackages, announce: viewAnnounce };

  window.CineAuraPanelAdmin = {
    get SECTIONS() {
      return Object.keys(VIEWS);
    },
    has: (name) => Boolean(VIEWS[name]),
    // another file's view (js/panel-withdraw.js), drawn with the helpers below
    add(name, fn) {
      VIEWS[name] = fn;
    },
    kit: {
      ctx: () => ctx, num, pt, when, day, rpc, data, errKey, failToast, who, tag, img, head, tabsHtml, reasonForm,
      openSlot, reasonOf, busy, drawList, PAGE,
    },
    async view(name, main, context) {
      ctx = context;
      await VIEWS[name](main);
    },
    memberSummary(box, memberId, context) {
      ctx = context;
      return memberSummary(box, memberId);
    },
  };
})();
