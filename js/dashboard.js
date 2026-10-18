(() => {
  const C = window.CineAura;
  const {
    $,
    $$,
    setupChrome,
    getSession,
    toast,
    supabaseRequest: sbRequest,
    sessionWriteBlocked,
    restValue,
    normalizeAccountStatus,
    initialsAvatar,
    avatarUrlFor,
    hydrateAvatars,
    escapeHtml,
    sha256,
    logout,
    photo,
    tmdb,
    t,
    tr,
    applyPrefs,
    translateDom,
    getLang,
    getTheme,
    validWatchUrl,
    linkQualityOptions,
    qualityPickerHtml,
    selectedQualities,
    qualityLabel,
    linkLanguageOptions,
    langPickerHtml,
    selectedLangs,
    bindLangPicker,
    publishWatchLink,
    linkKindOf,
    AGE_TIERS,
    ageTier,
  } = C;

  const PLAN = {
    Free: { maxCodes: 5, months: 1 },
    Silver: { maxCodes: 10, months: 3 },
    Gold: { maxCodes: 10, months: 6 },
    Diamond: { maxCodes: 10, months: 12 },
  };

  const DEFAULT_LISTS = [
    { key: "completed", name: "Completed" },
    { key: "incomplete", name: "In progress" },
    { key: "later", name: "Watch later" },
  ];

  // Every write on the dashboard needs a live session; the read-only path stays
  // open so the gated page can still show its own notice.
  function supabaseRequest(path, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    if (method !== "GET" && !getSession()?.member_id) {
      if (typeof sessionWriteBlocked === "function") sessionWriteBlocked();
      else toast(t("auth.gate.blocked"));
      return Promise.resolve({ ok: false, status: 401, data: null, blocked: true });
    }
    return sbRequest(path, options);
  }

  const state = {
    session: null,
    member: null,
    profile: null,
    playlists: [],
    section: "overview",
    openPlaylist: null,
    panelVisible: false,
    sanctions: null,
  };

  let profileSettingsQueue = Promise.resolve();

  function writeProfileSettings(values) {
    const memberId = state.member?.member_id;
    if (!memberId) return Promise.resolve({ ok: false, status: 401 });
    const request = profileSettingsQueue
      .catch(() => null)
      .then(() => supabaseRequest(`/rest/v1/profiles?member_id=eq.${restValue(memberId)}`, {
        method: "PATCH",
        keepalive: true,
        body: JSON.stringify(values),
      }));
    profileSettingsQueue = request;
    return request.catch(() => ({ ok: false, status: 0 }));
  }

  async function saveAppearancePreference(field, value) {
    const pref = { [field]: value };
    applyPrefs({ ...pref, persist: true });
    const result = await writeProfileSettings(pref);
    if (!result.ok) {
      toast(t("dash.settings.saveFailed"));
      return;
    }
    if (state.profile) Object.assign(state.profile, pref);
    toast(t("dash.settings.prefSaved"));
  }

  document.addEventListener("cineaura:prefs", () => {
    if (state.member && document.querySelector("#dash-root .dash-layout")) renderShell();
  });

  const gate = (title, text, actions, extra = "") => `
    <section class="glass dash-gate">
      <span class="eyebrow">${t("nav.dashboard")}</span>
      <h1>${title}</h1>
      <p>${text}</p>
      ${extra}
      <div class="success-actions">${actions}</div>
    </section>`;

  async function loadMember(id) {
    const res = await supabaseRequest(
      `/rest/v1/members?member_id=eq.${restValue(id)}&select=*`
    );
    return res.ok && Array.isArray(res.data) ? res.data[0] : null;
  }

  async function ensureProfile(member) {
    const get = await supabaseRequest(
      `/rest/v1/profiles?member_id=eq.${restValue(member.member_id)}&select=*`
    );
    if (get.ok && get.data?.[0]) {
      state.profile = get.data[0];
      return;
    }
    const row = {
      member_id: member.member_id,
      username: member.username,
      bio: "",
      membership_type: member.membership_type || "Free",
      private_minutes: Number(member.watch_minutes || 0),
      public_minutes: 0,
      avatar_url: "",
      followers: 0,
      following: 0,
      language: getLang(),
      theme: getTheme(),
      region: "",
      country: member.country || "",
    };
    await supabaseRequest("/rest/v1/profiles", {
      method: "POST",
      body: JSON.stringify(row),
    });
    state.profile = row;
  }

  function playlistId() {
    return `IDP${Math.floor(100000000 + Math.random() * 900000000)}`;
  }

  async function ensurePlaylists(member) {
    const res = await supabaseRequest(
      `/rest/v1/playlists?owner_id=eq.${restValue(member.member_id)}&select=*&order=created_at.asc`
    );
    let rows = res.ok && Array.isArray(res.data) ? res.data : [];
    if (!rows.length) {
      const seed = [];
      ["movie", "tv"].forEach((media) => {
        DEFAULT_LISTS.forEach((list) => {
          seed.push({
            playlist_id: playlistId(),
            name: list.name,
            description: `${list.name} ${media === "tv" ? "series" : "movies"}`,
            owner_username: member.username,
            owner_id: member.member_id,
            media_type: media,
            kind: "default",
            list_key: list.key,
            visibility: "private",
          });
        });
      });
      await supabaseRequest("/rest/v1/playlists", {
        method: "POST",
        body: JSON.stringify(seed),
      });
      rows = seed;
    }
    state.playlists = rows;
  }

  async function syncWatchMinutes() {
    const views = await supabaseRequest(
      `/rest/v1/views?viewer_id=eq.${restValue(state.member.member_id)}&select=minutes,playlist_id`
    );
    const rows = views.ok && Array.isArray(views.data) ? views.data : [];
    const vis = {};
    state.playlists.forEach((p) => {
      vis[p.playlist_id] = String(p.visibility || "").toLowerCase();
    });
    const extraIds = [...new Set(rows.map((r) => r.playlist_id).filter((id) => id && !vis[id]))];
    if (extraIds.length) {
      const extra = await supabaseRequest(
        `/rest/v1/playlists?playlist_id=in.(${extraIds.join(",")})&select=playlist_id,visibility`
      );
      (extra.data || []).forEach((p) => {
        vis[p.playlist_id] = String(p.visibility || "").toLowerCase();
      });
    }
    let priv = 0;
    let pub = 0;
    rows.forEach((r) => {
      const mins = Number(r.minutes || 0);
      if (vis[r.playlist_id] === "public") pub += mins;
      else priv += mins;
    });
    const owned = await supabaseRequest(
      `/rest/v1/views?link_owner_id=eq.${restValue(state.member.member_id)}&select=minutes,viewer_id`
    );
    (owned.ok && Array.isArray(owned.data) ? owned.data : []).forEach((r) => {
      if (r.viewer_id !== state.member.member_id) pub += Number(r.minutes || 0);
    });
    // Prizes are no longer paid by shrinking the watch minutes: what a member
    // spent lives in profiles.points_spent, and winners.minutes_paid is kept
    // only as a record of what each prize cost. Subtracting it here as well
    // would charge every claim twice.
    await supabaseRequest(`/rest/v1/profiles?member_id=eq.${restValue(state.member.member_id)}`, {
      method: "PATCH",
      body: JSON.stringify({ private_minutes: priv, public_minutes: pub }),
    });
    await supabaseRequest(`/rest/v1/members?member_id=eq.${restValue(state.member.member_id)}`, {
      method: "PATCH",
      body: JSON.stringify({ watch_minutes: priv + pub }),
    });
    if (state.profile) {
      state.profile.private_minutes = priv;
      state.profile.public_minutes = pub;
    }
    if (state.member) state.member.watch_minutes = priv + pub;
  }

  function avatar() {
    const m = state.member || {};
    return state.profile?.avatar_url || avatarUrlFor(m.member_id, m.username) || initialsAvatar(m.username || "CA");
  }

  function avatarTag() {
    const m = state.member || {};
    return `<img src="${escapeHtml(avatar())}" alt="" data-avatar-for="${escapeHtml(m.member_id || "")}" data-avatar-name="${escapeHtml(m.username || "")}" />`;
  }

  function listLabel(pl) {
    const map = { completed: t("list.completed"), incomplete: t("list.progress"), later: t("list.later") };
    return map[pl.list_key] || pl.name;
  }

  function renderShell() {
    const m = state.member;
    const p = state.profile || {};
    const movies = state.playlists.filter((x) => x.media_type === "movie");
    const series = state.playlists.filter((x) => x.media_type === "tv");
    const listBtns = (arr) =>
      arr
        .map(
          (pl) =>
            `<button type="button" data-open-pl="${escapeHtml(pl.playlist_id)}">${escapeHtml(listLabel(pl))}</button>`
        )
        .join("");

    $("#dash-root").innerHTML = `
      <div class="dash-layout">
        <aside class="glass dash-side">
          <a class="side-user" href="./Profile.html?@${encodeURIComponent(m.username)}">
            ${avatarTag()}
            <strong>@${escapeHtml(m.username)}</strong>
            <span>${escapeHtml(tr(p.membership_type || m.membership_type || "Free"))}</span>
            <span>${escapeHtml(m.member_id)}</span>
          </a>
          <nav class="side-nav">
            ${SECTIONS.map((s) =>
              `<button type="button" data-section="${s}" class="${state.section===s?"active":""}">${C.navIcon(s)}<span>${t("dash.nav."+s)}</span></button>`
            ).join("")}
            ${state.panelVisible ? `<a href="./Panel.html" data-panel-link>${C.navIcon("panel")}<span>${t("nav.panel")}</span></a>` : ""}
          </nav>
          <div class="side-label">${t("dash.side.movies")}</div>
          <div class="side-lists">${listBtns(movies)}</div>
          <div class="side-label">${t("dash.side.series")}</div>
          <div class="side-lists">${listBtns(series)}</div>
        </aside>
        <section class="glass dash-main" id="dash-main"></section>
      </div>`;
    $("#dash-root").onclick = onShellClick;
    C.mountSideToggle($("#dash-root .dash-layout"));
    showActiveTab();
    hydrateAvatars($("#dash-root"));
    renderSection();
  }

  // Phones: the menu is a strip that scrolls sideways. Keep the open section in
  // sight (dashboard.html#iptv from the premium channel list, or a tap further along).
  function showActiveTab() {
    const strip = $("#dash-root .side-nav");
    const on = strip?.querySelector("button.active");
    if (!on || strip.scrollWidth <= strip.clientWidth + 1) return;
    const s = strip.getBoundingClientRect();
    const b = on.getBoundingClientRect();
    strip.scrollLeft += b.left + b.width / 2 - (s.left + s.width / 2);
  }

  function onShellClick(e) {
    const sec = e.target.closest("[data-section]");
    if (sec) {
      state.section = sec.dataset.section;
      state.openPlaylist = null;
      // the address follows the open section, so a link to another one (a
      // notification: dashboard.html#claims) always counts as a change
      if (location.hash !== `#${state.section}`) history.replaceState(history.state, "", `#${state.section}`);
      renderShell();
      return;
    }
    const pl = e.target.closest("[data-open-pl]");
    if (pl) {
      state.section = "playlists";
      state.openPlaylist = pl.dataset.openPl;
      renderShell();
    }
  }

  async function renderSection() {
    const main = $("#dash-main");
    if (!main) return;
    main.onclick = null;
    const map = {
      overview: viewOverview,
      points: viewPoints,
      withdraw: viewWithdraw,
      playlists: viewPlaylists,
      links: viewLinks,
      reports: viewReports,
      codes: viewCodes,
      iptv: viewIptv,
      views: viewViews,
      analytics: viewAnalytics,
      prizes: viewPrizes,
      history: viewHistory,
      settings: viewSettings,
    };
    await (map[state.section] || viewOverview)(main);
  }

  // ---------- Tabs for multi-part sections ----------
  function wireTabs(root, key) {
    const bar = root.querySelector("[data-tabbar]");
    if (!bar) return;
    state.tabs = state.tabs || {};
    const panes = [...root.querySelectorAll("[data-dpane]")];
    const apply = () => {
      let cur = state.tabs[key];
      if (!panes.some((x) => x.dataset.dpane === cur)) cur = panes[0]?.dataset.dpane;
      state.tabs[key] = cur;
      bar.querySelectorAll("[data-dtab]").forEach((b) => {
        const on = b.dataset.dtab === cur;
        b.classList.toggle("active", on);
        b.setAttribute("aria-selected", String(on));
      });
      panes.forEach((x) => { x.hidden = x.dataset.dpane !== cur; });
      // phones: a strip that scrolls sideways keeps the open tab in sight
      // (dashboard.html#claims opens Prizes > Prize claims, near the end of the strip)
      const on = bar.querySelector("[data-dtab].active");
      if (on && bar.scrollWidth > bar.clientWidth + 1) {
        const s = bar.getBoundingClientRect();
        const b = on.getBoundingClientRect();
        bar.scrollLeft += b.left + b.width / 2 - (s.left + s.width / 2);
      }
    };
    bar.onclick = (e) => {
      const b = e.target.closest("[data-dtab]");
      if (!b) return;
      state.tabs[key] = b.dataset.dtab;
      apply();
    };
    apply();
  }

  // Splits an already-rendered section into tabs, one per <h2> block.
  function tabify(main, key, opts = {}) {
    const kids = [...main.children];
    let i = 0;
    const isIntro = (el) => el.tagName === "P" || el.tagName === "H1" || el.classList.contains("stat-row") || el.classList.contains("stat");
    while (i < kids.length && isIntro(kids[i])) i++;
    const groups = [];
    kids.slice(i).forEach((el) => {
      if (el.tagName === "H2") { groups.push({ label: el.textContent.trim(), els: [] }); el.remove(); return; }
      if (!groups.length) groups.push({ label: opts.first ? opts.first() : "", els: [] });
      groups[groups.length - 1].els.push(el);
    });
    if (groups.length < 2) return;
    const bar = document.createElement("div");
    bar.className = "tabs follow-tabs";
    bar.setAttribute("role", "tablist");
    bar.dataset.tabbar = "1";
    bar.innerHTML = groups.map((g, n) => `<button type="button" role="tab" class="follow-tab" data-dtab="${key}${n}">${escapeHtml(g.label)}</button>`).join("");
    const anchor = i > 0 ? kids[i - 1] : null;
    if (anchor) anchor.after(bar); else main.prepend(bar);
    let prev = bar;
    groups.forEach((g, n) => {
      const pane = document.createElement("div");
      pane.className = "follow-pane";
      pane.dataset.dpane = `${key}${n}`;
      g.els.forEach((el) => pane.appendChild(el));
      prev.after(pane);
      prev = pane;
    });
    wireTabs(main, key);
  }

  function tabbed(fn, key, opts) {
    return async function (main, ...rest) {
      const out = await fn.call(this, main, ...rest);
      tabify(main, key, opts);
      return out;
    };
  }

  // ---------- Overview: account, points and the member's watch codes ----------
  let overviewTimer = 0;

  async function viewOverview(main) {
    const p = state.profile || {};
    const m = state.member;
    const plan = codeLimit();
    clearInterval(overviewTimer);
    main.innerHTML = `
      <p class="eyebrow">${t("dash.overview")}</p>
      <h1>${t("common.hello", { name: escapeHtml(m.full_name || m.username) })}</h1>
      <div class="stat-row">
        <div class="stat"><b>${escapeHtml(tr(m.membership_type || "Free"))}</b><span>${t("common.membership")}</span></div>
        <div class="stat"><b>${escapeHtml(m.membership_duration || "1 month")}</b><span>${t("common.duration")}</span></div>
        <div class="stat"><b>${Number(p.private_minutes||0)+Number(p.public_minutes||0)}</b><span>${t("dash.totalMin")}</span></div>
        <div class="stat"><b>${Number(p.followers||0)}</b><span>${t("dash.followers")}</span></div>
      </div>
      <p class="muted">${t("dash.expiresOn", { date: escapeHtml(String(m.membership_expires_at||"—").slice(0,10)) })}</p>

      <section class="ov-block" id="ov-iptv" aria-labelledby="ov-iptv-h" hidden>
        <div class="ov-head">
          <div>
            <h2 id="ov-iptv-h">${t("dash.iptv.mine")}</h2>
            <p class="muted">${t("dash.ov.iptvLead")}</p>
          </div>
          <button class="btn btn-sm btn-ghost" type="button" data-section="iptv">${t("dash.ov.iptvAll")}</button>
        </div>
        <div class="ov-codes" id="ov-iptv-list"></div>
      </section>

      <section class="ov-block" aria-labelledby="ov-points-h">
        <div class="ov-head">
          <h2 id="ov-points-h">${t("points.title")}</h2>
          <div class="ov-head-btns">
            <button class="btn btn-sm btn-primary" type="button" data-section="points">${t("points.earnBtn")}</button>
            <button class="btn btn-sm btn-ghost" type="button" data-section="prizes">${t("dash.ov.toPrizes")}</button>
          </div>
        </div>
        <div class="stat-row ov-points">
          <div class="stat ov-accent"><b data-pt="available">…</b><span>${t("points.available")}</span></div>
          <div class="stat"><b data-pt="earned">…</b><span>${t("points.earned")}</span></div>
          <div class="stat"><b data-pt="spent">…</b><span>${t("points.spent")}</span></div>
          <div class="stat ov-level" data-pt-level hidden><b><bdi dir="ltr" data-pt="level"></bdi></b><span data-pt="mult"></span></div>
        </div>
        <p class="muted" id="ov-points-msg">${t("points.loading")}</p>
        <details class="ov-more" id="ov-points-more" hidden>
          <summary>${t("dash.ov.howEarned")}</summary>
          <div id="ov-points-box"></div>
        </details>
      </section>

      <section class="ov-block" aria-labelledby="ov-codes-h">
        <div class="ov-head">
          <div>
            <h2 id="ov-codes-h">${t("dash.ov.codes")}</h2>
            <p class="muted" id="ov-codes-lead"></p>
          </div>
          <button class="btn btn-sm btn-ghost" type="button" data-section="codes">${t("dash.ov.manage")}</button>
        </div>
        <div class="ov-codes" id="ov-codes"><p class="muted">${t("common.loading")}</p></div>
      </section>`;

    const memberId = m.member_id;
    const [mp, codesRes, iptvRows] = await Promise.all([
      C.memberPoints(memberId, state.profile || {}).catch(() => null),
      supabaseRequest(`/rest/v1/codes?owner=eq.${restValue(memberId)}&select=*&order=created_at.desc`).catch(() => ({ ok: false })),
      loadMyIptv().catch(() => null),
    ]);
    if (!main.isConnected || state.section !== "overview") return; // the member moved on

    const msg = main.querySelector("#ov-points-msg");
    ["available", "earned", "spent"].forEach((k) => {
      const el = main.querySelector(`[data-pt="${k}"]`);
      if (el) el.textContent = mp ? String(Number(mp[k] || 0)) : "—";
    });
    // the level (sql/point_levels.sql): LV0 … LV Max and its watch-points multiplier
    const lvStat = main.querySelector("[data-pt-level]");
    if (lvStat && mp?.levels && mp.level) {
      lvStat.querySelector('[data-pt="level"]').textContent = mp.level.name;
      lvStat.querySelector('[data-pt="mult"]').textContent = t("points.levelMult", { n: mp.level.multiplier });
      lvStat.hidden = false;
    }
    if (mp) {
      main.querySelector("#ov-points-box").innerHTML = C.pointsHtml(mp);
      main.querySelector("#ov-points-more").hidden = false;
      msg?.remove();
    } else if (msg) {
      msg.textContent = t("points.loadFail");
    }

    const codes = codesRes.ok && Array.isArray(codesRes.data) ? codesRes.data : null;
    const lead = main.querySelector("#ov-codes-lead");
    if (lead && codes) {
      lead.textContent = t("dash.ov.codesLead", { n: codes.length, max: plan.maxCodes, plan: tr(m.membership_type || "Free") });
    }
    // premium IPTV accounts given in Panel > IPTV (the block stays hidden without one)
    const iptvBox = main.querySelector("#ov-iptv");
    const paint = () => {
      const box = main.querySelector("#ov-codes");
      if (box) box.innerHTML = overviewCodesHtml(codes);
      const premium = myPremium(iptvRows);
      if (iptvBox) {
        iptvBox.hidden = !premium.length;
        iptvBox.querySelector("#ov-iptv-list").innerHTML = overviewIptvHtml(premium);
      }
    };
    paint();
    // the time left counts down while the overview stays open
    if ((codes && codes.length) || myPremium(iptvRows).length) {
      overviewTimer = setInterval(() => {
        if (!main.isConnected) {
          clearInterval(overviewTimer);
          return;
        }
        paint();
      }, 60000);
    }
  }

  const TV_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="6" width="19" height="13" rx="2.5"/><path d="M8 2.5l4 3.5 4-3.5"/></svg>';

  function overviewIptvHtml(list) {
    return list.map(({ p, tm }) => {
      const st = tm.left <= 0 ? "expired" : "active";
      return `
        <article class="ov-code-card ov-iptv-card is-${st}">
          <div class="ov-code-top">
            <span class="ov-iptv-name"><span class="ov-iptv-ic">${TV_ICON}</span><bdi>${escapeHtml(p.name)}</bdi></span>
            <span class="ov-st ${st}">${t(`dash.ov.st.${st}`)}</span>
          </div>
          <div class="ipx-badges">${iptvBadgesHtml(p, tm, false)}</div>
          ${iptvValidityHtml(tm, p)}
          <div class="ov-iptv-actions">
            <a class="btn btn-sm btn-primary" href="./Listchannels.html?package=${encodeURIComponent(p.name)}">${t("dash.ov.watch")}</a>
            <button class="btn btn-sm btn-ghost" type="button" data-section="iptv">${t("dash.ov.iptvDetails")}</button>
          </div>
        </article>`;
    }).join("");
  }

  // Codes saved before the age tiers existed carry no limit.
  function codeAgeText(value) {
    return value ? t(ageTier(value).label) : t("code.ageNone");
  }

  function codeTiming(c, now = Date.now()) {
    const exp = Date.parse(c.expires_at || "");
    if (!Number.isFinite(exp)) return { exp: null, left: Infinity, share: 1 };
    const created = Date.parse(c.created_at || "");
    const total = Number.isFinite(created) && exp > created ? exp - created : 0;
    const left = exp - now;
    const share = left <= 0 ? 0 : total ? Math.min(1, left / total) : 1;
    return { exp, left, share };
  }

  function codeState(c, timing) {
    const st = String(c.status || "active").trim().toLowerCase();
    if (st === "banned" || st === "disabled") return st;
    if (st === "expired" || timing.left <= 0) return "expired";
    return "active";
  }

  // "3 days, 4 hours" in the member's language (plural rules come from Intl).
  function unitText(n, unit) {
    try {
      return new Intl.NumberFormat(C.getLocale(), { style: "unit", unit, unitDisplay: "long", numberingSystem: "latn" }).format(n);
    } catch {
      return `${n} ${unit}${n === 1 ? "" : "s"}`;
    }
  }

  function joinUnits(parts) {
    try {
      return new Intl.ListFormat(C.getLocale(), { style: "long", type: "unit" }).format(parts);
    } catch {
      return parts.join(" ");
    }
  }

  function timeLeftText(ms) {
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return t("dash.ov.lessMin");
    const d = Math.floor(mins / 1440);
    const h = Math.floor((mins % 1440) / 60);
    const m = mins % 60;
    if (d >= 7) return unitText(d, "day");
    if (d >= 1) return joinUnits(h ? [unitText(d, "day"), unitText(h, "hour")] : [unitText(d, "day")]);
    if (h >= 1) return joinUnits(m ? [unitText(h, "hour"), unitText(m, "minute")] : [unitText(h, "hour")]);
    return unitText(m, "minute");
  }

  function dayText(ms) {
    try {
      return new Date(ms).toLocaleDateString(C.getLocale(), { dateStyle: "medium", numberingSystem: "latn" });
    } catch {
      return new Date(ms).toISOString().slice(0, 10);
    }
  }

  function whenText(ms) {
    try {
      return new Date(ms).toLocaleString(C.getLocale(), { dateStyle: "medium", timeStyle: "short", numberingSystem: "latn" });
    } catch {
      return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
    }
  }

  // "[icon] Living room TV · Smart TV" under a linked device's MAC address
  function deviceKindHtml(c) {
    const type = C.deviceType(c.device_type);
    const name = String(c.device_name || "").trim();
    if (!type && !name) return "";
    const parts = [name ? `<bdi>${escapeHtml(name)}</bdi>` : "", type ? escapeHtml(t(type.label)) : ""].filter(Boolean);
    return `<small class="dev-sub dev-kind">${type ? C.deviceTypeIcon(type.id, 14) : ""}<span>${parts.join(" · ")}</span></small>`;
  }

  // Overview card: the device the code is linked to ("This device" for this browser)
  function ovDeviceHtml(c) {
    if (!Object.prototype.hasOwnProperty.call(c, "device_mac")) return ""; // sql/code_devices.sql not run
    const mac = String(c.device_mac || "");
    const mine = Boolean(mac) && mac === C.deviceMac();
    return `
          <div class="ov-dev">
            <span class="ov-label">${t("dash.code.device")}</span>
            ${mac ? `<span class="dev-mac" dir="ltr">${escapeHtml(mac)}</span>` : `<span class="muted">${t("dash.code.notLinked")}</span>`}
            ${mine ? `<span class="code-here">${t("dash.code.thisDevice")}</span>` : ""}
            ${mac ? deviceKindHtml(c) : ""}
          </div>`;
  }

  function overviewCodesHtml(codes) {
    if (!codes) return `<p class="muted">${t("dash.ov.codesFail")}</p>`;
    if (!codes.length) {
      return `
        <div class="ov-empty">
          <p>${t("dash.noCodes")}</p>
          <button class="btn btn-sm btn-primary" type="button" data-section="codes">${t("dash.ov.create")}</button>
        </div>`;
    }
    const now = Date.now();
    const rank = { active: 0, disabled: 1, banned: 2, expired: 3 };
    const rows = codes.map((c) => {
      const timing = codeTiming(c, now);
      return { c, timing, st: codeState(c, timing) };
    });
    // still valid first, soonest to run out on top; expired ones last
    rows.sort((a, b) => rank[a.st] - rank[b.st] || (a.st === "expired" ? (b.timing.exp || 0) - (a.timing.exp || 0) : a.timing.left - b.timing.left));
    return rows.map(({ c, timing, st }) => {
      let left;
      let until = "";
      if (timing.exp === null) left = t("dash.ov.noExpiry");
      else if (timing.left <= 0) {
        left = t("dash.ov.expired");
        until = t("dash.ov.expiredOn", { date: whenText(timing.exp) });
      } else {
        left = t("dash.ov.left", { time: timeLeftText(timing.left) });
        until = t("dash.ov.expiresOn", { date: whenText(timing.exp) });
      }
      const tone = timing.left <= 0 ? "off" : timing.share < 0.15 ? "low" : timing.share < 0.5 ? "mid" : "";
      return `
        <article class="ov-code-card is-${st}">
          <div class="ov-code-top">
            <span class="ov-code" dir="ltr">${escapeHtml(c.code)}</span>
            <span class="ov-st ${st}">${t(`dash.ov.st.${st}`)}</span>
          </div>
          <div class="ov-cat">
            <span class="ov-label">${t("dash.ov.category")}</span>
            <span class="chip">${escapeHtml(codeAgeText(c.age_rating))}</span>
          </div>
          ${ovDeviceHtml(c)}
          <div class="ov-left">
            <span class="ov-label">${t("dash.ov.validity")}</span>
            <b>${escapeHtml(left)}</b>
            <div class="ov-bar ${tone}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(timing.share * 100)}" aria-label="${escapeHtml(t("dash.ov.validity"))}"><i style="width:${Math.max(timing.share > 0 ? 3 : 0, Math.round(timing.share * 100))}%"></i></div>
            ${until ? `<small>${escapeHtml(until)}</small>` : ""}
          </div>
        </article>`;
    }).join("");
  }

  function visibilityFieldsHtml(prefix, pl = {}) {
    return `
      <select id="${prefix}-vis">
        <option value="public">${t("common.public")}</option>
        <option value="private">${t("common.private")}</option>
        <option value="exclusive">${t("common.exclusive")}</option>
      </select>
      <div class="vis-fields stack" id="${prefix}-private" hidden>
        <p class="muted">${t("dash.privHint")}</p>
        <input id="${prefix}-people" placeholder="${t("dash.peoplePh")}" value="${escapeHtml((pl._people || []).join(", "))}" />
      </div>
      <div class="vis-fields stack" id="${prefix}-exclusive" hidden>
        <p class="muted">${t("dash.exclHint")}</p>
        <textarea id="${prefix}-rules" placeholder="${t("dash.rulesPh")}">${escapeHtml(pl.rules || "")}</textarea>
        <label class="lang-chip"><input type="checkbox" id="${prefix}-member" ${pl.require_member ? "checked" : ""} /> ${t("common.membersOnly")}</label>
        <label class="lang-chip"><input type="checkbox" id="${prefix}-followers" ${pl.require_followers ? "checked" : ""} /> ${t("common.followersOnly")}</label>
        <div class="form-row">
          <input id="${prefix}-countries" placeholder="${t("dash.countriesPh")}" value="${escapeHtml(pl.countries || "")}" />
          <input id="${prefix}-age" type="number" min="1" placeholder="${t("dash.maxAge")}" value="${pl.max_age || ""}" />
        </div>
        <select id="${prefix}-gender">
          <option value="any">${t("common.anyGender")}</option>
          <option value="male">${t("reg.male")}</option>
          <option value="female">${t("reg.female")}</option>
        </select>
      </div>`;
  }

  function bindVisibilityFields(prefix) {
    const vis = $(`#${prefix}-vis`);
    const priv = $(`#${prefix}-private`);
    const excl = $(`#${prefix}-exclusive`);
    const sync = () => {
      const v = vis.value;
      priv.hidden = v !== "private";
      excl.hidden = v !== "exclusive";
    };
    vis.onchange = sync;
    sync();
  }

  function readPlaylistSettings(prefix, { requirePeople, requireRules }) {
    const visibility = $(`#${prefix}-vis`).value;
    const people = String($(`#${prefix}-people`)?.value || "")
      .split(/[,;\n]+/)
      .map((s) => s.trim().replace(/^@/, ""))
      .filter(Boolean);
    const rules = String($(`#${prefix}-rules`)?.value || "").trim();
    if (visibility === "private" && requirePeople && !people.length) {
      toast(t("dash.needPeople"));
      return null;
    }
    if (visibility === "exclusive" && requireRules && !rules) {
      toast(t("dash.needRules"));
      return null;
    }
    const ageRaw = $(`#${prefix}-age`)?.value;
    return {
      visibility,
      people,
      rules,
      require_member: Boolean($(`#${prefix}-member`)?.checked),
      require_followers: Boolean($(`#${prefix}-followers`)?.checked),
      countries: String($(`#${prefix}-countries`)?.value || "").trim(),
      max_age: ageRaw ? Number(ageRaw) : null,
      gender: $(`#${prefix}-gender`)?.value || "any",
    };
  }

  async function savePlaylistAccess(playlistId, people) {
    await supabaseRequest(`/rest/v1/playlist_access?playlist_id=eq.${restValue(playlistId)}`, {
      method: "DELETE",
    });
    if (!people.length) return;
    await supabaseRequest("/rest/v1/playlist_access", {
      method: "POST",
      body: JSON.stringify(people.map((username) => ({ playlist_id: playlistId, username }))),
    });
  }

  async function copyPlaylist(pl) {
    if (!(await C.guardFeature("posts"))) return;
    const base = String(listLabel(pl)).replace(/\s+\d+$/, "").trim();
    const esc = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("^" + esc + "(?:\\s+(\\d+))?$", "i");
    let max = 1;
    state.playlists.forEach((x) => {
      const m = re.exec(String(listLabel(x)).trim());
      if (m) max = Math.max(max, m[1] ? Number(m[1]) : 1);
    });
    const row = {
      playlist_id: playlistId(),
      name: `${base} ${max + 1}`,
      description: pl.description || "",
      owner_username: state.member.username,
      owner_id: state.member.member_id,
      media_type: pl.media_type,
      kind: "custom",
      list_key: "custom",
      visibility: pl.visibility || "private",
      rules: pl.rules || "",
      require_member: !!pl.require_member,
      require_followers: !!pl.require_followers,
      countries: pl.countries || "",
      max_age: pl.max_age ?? null,
      gender: pl.gender || "any",
      avatar_url: pl.avatar_url || "",
    };
    const ins = await supabaseRequest("/rest/v1/playlists", { method: "POST", body: JSON.stringify(row) });
    if (!ins.ok) return toast(t("dash.copyFail"));
    const items = await supabaseRequest(`/rest/v1/playlist_items?playlist_id=eq.${restValue(pl.playlist_id)}&select=*&order=added_at.asc`);
    const rows = items.ok && Array.isArray(items.data) ? items.data : [];
    if (rows.length) {
      await supabaseRequest("/rest/v1/playlist_items", {
        method: "POST",
        body: JSON.stringify(rows.map((r) => ({ playlist_id: row.playlist_id, tmdb_id: r.tmdb_id, media_type: r.media_type, title: r.title || "", poster_path: r.poster_path || "", visibility: r.visibility || row.visibility }))),
      });
    }
    if (String(row.visibility).toLowerCase() === "private") {
      const acc = await supabaseRequest(`/rest/v1/playlist_access?playlist_id=eq.${restValue(pl.playlist_id)}&select=username`);
      const people = (acc.ok && Array.isArray(acc.data) ? acc.data : []).map((x) => x.username);
      if (people.length) await savePlaylistAccess(row.playlist_id, people);
    }
    state.playlists.push(row);
    toast(t("dash.copyDone", { name: row.name }));
    renderShell();
  }

  async function viewPlaylists(main) {
    if (state.openPlaylist) return viewOnePlaylist(main, state.openPlaylist);
    main.innerHTML = `
      <p class="eyebrow">${t("dash.nav.playlists")}</p>
      <h1>${t("dash.yourLists")}</h1>
      <div class="stack" style="margin:16px 0 22px">
        <div class="form-row">
          <input id="pl-name" placeholder="${t("dash.listName")}" />
          <select id="pl-type"><option value="movie">${t("common.movies")}</option><option value="tv">${t("common.series")}</option></select>
        </div>
        <textarea id="pl-desc" placeholder="${t("dash.descReq")}"></textarea>
        ${visibilityFieldsHtml("pl")}
        <button class="btn btn-sm btn-primary" id="pl-create" type="button">${t("dash.createList")}</button>
      </div>
      <div class="filter-bar">
        <div class="filter-group">
          <span class="muted">${t("common.type")}</span>
          <label class="lang-chip"><input type="radio" name="pl-ft" value="all" checked /> ${t("common.all")}</label>
          <label class="lang-chip"><input type="radio" name="pl-ft" value="movie" /> ${t("common.movies")}</label>
          <label class="lang-chip"><input type="radio" name="pl-ft" value="tv" /> ${t("common.series")}</label>
        </div>
        <div class="filter-group">
          <span class="muted">${t("common.visibility")}</span>
          <label class="lang-chip all"><input type="checkbox" id="fv-all" checked /> ${t("common.all")}</label>
          <label class="lang-chip"><input type="checkbox" class="fv" value="public" checked /> ${t("common.public")}</label>
          <label class="lang-chip"><input type="checkbox" class="fv" value="exclusive" checked /> ${t("common.exclusive")}</label>
          <label class="lang-chip"><input type="checkbox" class="fv" value="private" checked /> ${t("common.private")}</label>
        </div>
      </div>
      <div id="pl-cards" style="overflow-x:auto"></div>`;
    bindVisibilityFields("pl");
    const counts = {};
    try {
      const ids = state.playlists.map((x) => encodeURIComponent(x.playlist_id)).join(",");
      const ci = ids ? await supabaseRequest(`/rest/v1/playlist_items?playlist_id=in.(${ids})&select=playlist_id`) : null;
      (ci?.ok && Array.isArray(ci.data) ? ci.data : []).forEach((r) => { counts[r.playlist_id] = (counts[r.playlist_id] || 0) + 1; });
    } catch { /* counts are optional */ }
    const drawPlaylistCards = () => {
      const type = document.querySelector('input[name="pl-ft"]:checked')?.value || "all";
      const visSet = new Set($$(".fv:checked").map((el) => el.value));
      const list = state.playlists.filter((pl) => {
        if (type !== "all" && pl.media_type !== type) return false;
        const vis = String(pl.visibility || "private").toLowerCase();
        return visSet.has(vis);
      });
      $("#pl-cards").innerHTML = list.length
        ? `<table class="table pl-table"><thead><tr>
            <th>#</th><th>${t("dash.colName")}</th><th>${t("common.type")}</th><th>${t("common.visibility")}</th>
            <th>${t("dash.colItems")}</th><th>${t("dash.colViewers")}</th><th>${t("dash.colActions")}</th>
          </tr></thead><tbody>${list.map((pl, i) => `
          <tr>
            <td>${i + 1}</td>
            <td><strong>${escapeHtml(listLabel(pl))}</strong><div class="muted" style="font-size:12.5px">${escapeHtml(pl.description || t("dash.noDesc"))}</div></td>
            <td>${pl.media_type === "tv" ? t("common.series") : t("common.movies")}</td>
            <td>${escapeHtml(tr(pl.visibility || "private"))}</td>
            <td>${counts[pl.playlist_id] || 0}</td>
            <td>${Number(pl.viewers || 0)}</td>
            <td style="white-space:nowrap">
              <button class="btn btn-sm btn-ghost" data-open-pl="${escapeHtml(pl.playlist_id)}" type="button">${t("common.open")}</button>
              <button class="btn btn-sm btn-primary" data-copy-pl="${escapeHtml(pl.playlist_id)}" type="button">${t("dash.copyList")}</button>
              <button class="btn btn-sm btn-ghost" data-share-pl="${escapeHtml(pl.playlist_id)}" type="button">${t("dash.shareBtn")}</button>
              ${pl.kind === "default" ? "" : `<button class="btn btn-sm btn-danger" data-del-pl="${escapeHtml(pl.playlist_id)}" type="button">${t("dash.delBtn")}</button>`}
            </td>
          </tr>`).join("")}</tbody></table>`
        : `<p class="empty">${t("dash.noMatch")}</p>`;
    };
    drawPlaylistCards();
    $$('input[name="pl-ft"]').forEach((el) => {
      el.onchange = drawPlaylistCards;
    });
    $("#fv-all").onchange = () => {
      const on = $("#fv-all").checked;
      $$(".fv").forEach((el) => {
        el.checked = on;
      });
      drawPlaylistCards();
    };
    $$(".fv").forEach((el) => {
      el.onchange = () => {
        $("#fv-all").checked = $$(".fv").length > 0 && $$(".fv").every((x) => x.checked);
        drawPlaylistCards();
      };
    });
    $("#pl-cards").onclick = async (e) => {
      const share = e.target.closest("[data-share-pl]");
      if (share) {
        const url = `${location.origin}${location.pathname.replace(/[^/]*$/, "")}Playlist.html?ID=${share.dataset.sharePl}`;
        try { await navigator.clipboard.writeText(url); toast(t("dash.shareCopied")); }
        catch { toast(url); }
        return;
      }
      const del = e.target.closest("[data-del-pl]");
      if (del) {
        const target = state.playlists.find((x) => x.playlist_id === del.dataset.delPl);
        if (!target || target.kind === "default") return;
        if (!window.confirm(t("dash.confirmDelList", { name: listLabel(target) }))) return;
        del.disabled = true;
        const pid = restValue(target.playlist_id);
        await supabaseRequest(`/rest/v1/playlist_items?playlist_id=eq.${pid}`, { method: "DELETE" });
        await supabaseRequest(`/rest/v1/playlist_access?playlist_id=eq.${pid}`, { method: "DELETE" });
        const r = await supabaseRequest(`/rest/v1/playlists?playlist_id=eq.${pid}`, { method: "DELETE" });
        if (!r.ok) { del.disabled = false; return toast(t("dash.copyFail")); }
        state.playlists = state.playlists.filter((x) => x.playlist_id !== target.playlist_id);
        toast(t("dash.listDeleted"));
        renderShell();
        return;
      }
      const btn = e.target.closest("[data-copy-pl]");
      if (!btn) return;
      const pl = state.playlists.find((x) => x.playlist_id === btn.dataset.copyPl);
      if (!pl) return;
      btn.disabled = true;
      await copyPlaylist(pl);
      btn.disabled = false;
    };
    $("#pl-create").onclick = async () => {
      if (!(await C.guardFeature("posts"))) return;
      const name = $("#pl-name").value.trim();
      const description = $("#pl-desc").value.trim();
      if (!name) return toast(t("dash.nameList"));
      if (!description) return toast(t("dash.writeDesc"));
      const settings = readPlaylistSettings("pl", { requirePeople: true, requireRules: true });
      if (!settings) return;
      const row = {
        playlist_id: playlistId(),
        name,
        description,
        owner_username: state.member.username,
        owner_id: state.member.member_id,
        media_type: $("#pl-type").value,
        kind: "custom",
        list_key: "custom",
        visibility: settings.visibility,
        rules: settings.rules,
        require_member: settings.require_member,
        require_followers: settings.require_followers,
        countries: settings.countries,
        max_age: settings.max_age,
        gender: settings.gender,
      };
      const res = await supabaseRequest("/rest/v1/playlists", { method: "POST", body: JSON.stringify(row) });
      if (!res.ok) return toast(t("dash.listFail"));
      if (settings.visibility === "private") await savePlaylistAccess(row.playlist_id, settings.people);
      state.playlists.push(row);
      toast(t("dash.listCreated"));
      renderShell();
    };
  }

  async function viewOnePlaylist(main, id) {
    const pl = state.playlists.find((x) => x.playlist_id === id);
    if (!pl) return viewPlaylists(main);
    const items = await supabaseRequest(
      `/rest/v1/playlist_items?playlist_id=eq.${restValue(id)}&select=*&order=added_at.desc`
    );
    const list = items.ok && Array.isArray(items.data) ? items.data : [];
    const acc = await supabaseRequest(
      `/rest/v1/playlist_access?playlist_id=eq.${restValue(id)}&select=username`
    );
    pl._people = (acc.ok && Array.isArray(acc.data) ? acc.data : []).map((x) => x.username).filter(Boolean);
    const locked = pl.kind === "default";
    main.innerHTML = `
      <p class="eyebrow">${pl.media_type === "tv" ? t("common.series") : t("common.movies")}</p>
      <h1>${escapeHtml(listLabel(pl))}</h1>
      <div class="toolbar pl-topbar">
        <button class="btn btn-sm btn-primary" id="pl-edit" type="button" aria-expanded="false">${t("dash.editBtn")}</button>
        <button class="btn btn-sm btn-ghost" id="pl-copy" type="button">${t("dash.copyList")}</button>
        ${locked ? "" : `<button class="btn btn-sm btn-danger" id="pl-del" type="button">${t("dash.delBtn")}</button>`}
      </div>
      <div class="stat-row">
        <div class="stat"><b>${Number(pl.viewers||0)}</b><span>${t("common.viewers")}</span></div>
        <div class="stat"><b>${list.length}</b><span>${t("common.titles")}</span></div>
        <div class="stat"><b>${escapeHtml(pl.visibility)}</b><span>${t("common.visibility")}</span></div>
      </div>
      <div class="stack" id="pl-edit-box" style="margin:16px 0;display:none">
        <textarea id="ed-desc" placeholder="${t("dash.descReq")}">${escapeHtml(pl.description || "")}</textarea>
        ${visibilityFieldsHtml("ed", pl)}
        <div class="toolbar">
          <button class="btn btn-sm btn-primary" id="pl-save" type="button">${t("dash.saveSettings")}</button>
          <button class="btn btn-sm btn-ghost" id="pl-share" type="button">${t("dash.copyShare")}</button>
        </div>
      </div>
      <div id="pl-items"></div>`;
    $("#ed-vis").value = pl.visibility || "private";
    if ($("#ed-gender")) $("#ed-gender").value = pl.gender || "any";
    bindVisibilityFields("ed");
    $("#pl-save").onclick = async () => {
      const description = $("#ed-desc").value.trim();
      if (!description) return toast(t("dash.writeDesc"));
      const settings = readPlaylistSettings("ed", { requirePeople: true, requireRules: true });
      if (!settings) return;
      const patch = {
        description,
        visibility: settings.visibility,
        rules: settings.rules,
        require_member: settings.require_member,
        require_followers: settings.require_followers,
        countries: settings.countries,
        max_age: settings.max_age,
        gender: settings.gender,
      };
      const saved = await supabaseRequest(`/rest/v1/playlists?playlist_id=eq.${restValue(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      if (!saved.ok) return toast(t("dash.saveFail"));
      Object.assign(pl, patch);
      await savePlaylistAccess(id, settings.visibility === "private" ? settings.people : []);
      toast(t("dash.plSaved"));
      viewOnePlaylist(main, id);
    };
    $("#pl-share").onclick = async () => {
      const url = `${location.origin}${location.pathname.replace(/[^/]*$/, "")}Playlist.html?ID=${id}`;
      try { await navigator.clipboard.writeText(url); toast(t("dash.shareCopied")); }
      catch { toast(url); }
    };
    $("#pl-edit").onclick = () => {
      const box = $("#pl-edit-box");
      const open = box.style.display === "none";
      box.style.display = open ? "" : "none";
      $("#pl-edit").setAttribute("aria-expanded", String(open));
      if (open) box.scrollIntoView({ behavior: "smooth", block: "nearest" });
    };
    $("#pl-copy").onclick = async () => {
      const b = $("#pl-copy");
      b.disabled = true;
      await copyPlaylist(pl);
      b.disabled = false;
    };
    $("#pl-del")?.addEventListener("click", async () => {
      if (!window.confirm(t("dash.confirmDelList", { name: listLabel(pl) }))) return;
      await supabaseRequest(`/rest/v1/playlist_items?playlist_id=eq.${restValue(id)}`, { method: "DELETE" });
      await supabaseRequest(`/rest/v1/playlists?playlist_id=eq.${restValue(id)}`, { method: "DELETE" });
      await supabaseRequest(`/rest/v1/playlist_access?playlist_id=eq.${restValue(id)}`, { method: "DELETE" });
      state.playlists = state.playlists.filter((x) => x.playlist_id !== id);
      state.openPlaylist = null;
      toast(t("dash.listDeleted"));
      renderShell();
    });
    $("#pl-items").innerHTML = list.length
      ? list.map((it) => `
        <div class="item-row">
          <img src="${it.poster_path ? C.imgUrl(it.poster_path, "w92") : initialsAvatar(it.title)}" alt="" />
          <div>
            <strong>${escapeHtml(it.title || "Title")}</strong>
            <div class="muted">${t("dash.added", { date: String(it.added_at||"").slice(0,10) })}</div>
          </div>
          <div class="actions">
            <a class="btn btn-sm btn-primary" href="./watch.html?${it.media_type}=${it.tmdb_id}&Playlist=${id}">${t("common.watch")}</a>
            <button class="btn btn-sm btn-ghost" data-del-item="${it.id}" type="button">${t("common.remove")}</button>
          </div>
        </div>`).join("")
      : `<p class="empty">${t("dash.emptyList")}</p>`;
    $("#pl-items").onclick = async (e) => {
      const btn = e.target.closest("[data-del-item]");
      if (!btn) return;
      await supabaseRequest(`/rest/v1/playlist_items?id=eq.${btn.dataset.delItem}`, { method: "DELETE" });
      viewOnePlaylist(main, id);
    };
  }

  function parseTmdbInput(value, type) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return Number(raw);
    const m = raw.match(/themoviedb\.org\/(movie|tv)\/(\d+)/i);
    if (!m) return null;
    if (type && m[1].toLowerCase() !== type) return null;
    return Number(m[2]);
  }

  /* Qualities, language names, the subtitle picker and the URL check live in
     common.js, so this form and the "+" popup on the watch page publish exactly
     the same fields with the same values. */

  async function viewLinks(main) {
    const movies = await supabaseRequest(
      `/rest/v1/movielink?member_id=eq.${restValue(state.member.member_id)}&select=*&order=added_at.desc`
    );
    const series = await supabaseRequest(
      `/rest/v1/tvlink?member_id=eq.${restValue(state.member.member_id)}&select=*&order=added_at.desc`
    );
    const movieRows = movies.ok && Array.isArray(movies.data) ? movies.data : [];
    const tvRows = series.ok && Array.isArray(series.data) ? series.data : [];
    main.innerHTML = `
      <p class="eyebrow">${t("dash.linksEyebrow")}</p>
      <h1>${t("dash.addLink")}</h1>
      <p class="muted">${t("dash.linksLead")}</p>
      <div class="stack">
        <div class="form-row">
          <select id="lk-type">
            <option value="movie">${t("common.movie")}</option>
            <option value="tv">${t("common.series")}</option>
          </select>
          <input id="lk-tmdb" placeholder="${t("dash.tmdbPh")}" />
        </div>
        <input id="lk-watch" placeholder="${t("dash.watchPh")}" />
        <div class="form-row tv-fields" id="lk-tv" hidden>
          <input id="lk-season" type="number" min="1" placeholder="${t("dash.seasonPh")}" />
          <input id="lk-episode" type="number" min="1" placeholder="${t("dash.epPh")}" />
        </div>
        <div class="kind-picks" role="radiogroup" aria-label="${escapeHtml(t("dash.lkKind"))}">
          <label class="kind-pick">
            <input type="radio" name="lk-kind" value="watch" checked />
            <span>${t("dash.lkKindWatch")}</span>
          </label>
          <label class="kind-pick">
            <input type="radio" name="lk-kind" value="download" />
            <span>${t("dash.lkKindDownload")}</span>
          </label>
          <label class="kind-pick">
            <input type="radio" name="lk-kind" value="both" />
            <span>${t("dash.lkKindBoth")}</span>
          </label>
        </div>
        <p class="muted" id="lk-kind-hint">${t("dash.lkKindHint")}</p>
        <div class="sub-fields" id="lk-q-box">
          <p class="muted">${t("common.quality")} — ${t("watch.qualityHint")}</p>
          <div class="lang-picker">${qualityPickerHtml("lk-q")}</div>
        </div>
        <div class="form-row">
          <select id="lk-lang">
            <option value="">${t("common.origLang")}</option>
            ${linkLanguageOptions()}
          </select>
          <select id="lk-urlvis" aria-label="${escapeHtml(t("watch.urlField"))}">
            <option value="show">${t("watch.urlShow")}</option>
            <option value="hide">${t("watch.urlHide")}</option>
          </select>
        </div>
        <p class="muted" id="lk-kind-note" hidden>${t("watch.al.dlNote")}</p>
        <div class="form-row">
          <select id="lk-subs">
            <option value="no">${t("dash.subsNo")}</option>
            <option value="yes">${t("dash.subsYes")}</option>
          </select>
          <select id="lk-ads">
            <option value="no">${t("dash.adsNo")}</option>
            <option value="yes">${t("dash.adsYes")}</option>
          </select>
        </div>
        <div class="sub-fields" id="lk-sub-box" hidden>
          <p class="muted">${t("dash.subsHint")}</p>
          <div class="lang-picker">${langPickerHtml("lk-sub")}</div>
        </div>
        <button class="btn btn-sm btn-primary" id="lk-save" type="button">${t("dash.saveLink")}</button>
      </div>
      <h2 style="margin:22px 0 10px">${t("dash.yourMovieLinks")}</h2>
      <div id="lk-movies"></div>
      <h2 style="margin:22px 0 10px">${t("dash.yourSeriesLinks")}</h2>
      <div id="lk-series"></div>`;
    const tvBox = $("#lk-tv");
    const subBox = $("#lk-sub-box");
    $("#lk-type").onchange = (e) => {
      tvBox.hidden = e.target.value !== "tv";
    };
    $("#lk-subs").onchange = (e) => {
      subBox.hidden = e.target.value !== "yes";
    };
    $$('input[name="lk-kind"]').forEach((el) => {
      el.onchange = () => {
        if (!el.checked) return;
        const download = el.value !== "watch";
        const note = $("#lk-kind-note");
        if (note) note.hidden = !download;
      };
    });
    bindLangPicker("lk-sub");
    const watchHrefFor = (r, kind) =>
      kind === "tv"
        ? `./watch.html?tv=${r.tmdb_id}&season=${Number(r.season || 1)}&episode=${Number(r.episode || 1)}`
        : `./watch.html?movie=${r.tmdb_id}`;
    /* A source published as both a watch link and a download link is two rows on
       the same URL. Each row names its own kind, and both say the other one
       exists — so it is clear what a removal takes away. */
    const bothKinds = (rows) => {
      const seen = new Map();
      rows.forEach((r) => {
        const key = `${r.tmdb_id}|${r.watch_url}`;
        if (!seen.has(key)) seen.set(key, new Set());
        seen.get(key).add(linkKindOf(r));
      });
      return seen;
    };
    const kindChipHtml = (r, seen) => {
      const kind = linkKindOf(r);
      const other = seen?.get(`${r.tmdb_id}|${r.watch_url}`);
      const both = other && other.size > 1;
      const own = kind === "download" ? t("watch.chipDownload") : t("watch.chipWatch");
      const label = both ? `${own} · ${kind === "download" ? t("dash.alsoInWatch") : t("dash.alsoInDl")}` : own;
      return `<span class="chip chip-kind ${kind === "download" ? "is-dl" : "is-watch"}">${escapeHtml(label)}</span>`;
    };
    const drawRows = (id, rows, kind) => {
      const seen = bothKinds(rows);
      $(id).innerHTML = rows.length
        ? rows
            .map(
              (r) => `
          <div class="item-row">
            <div></div>
            <a href="${watchHrefFor(r, kind)}">
              <strong>${escapeHtml(r.title || `TMDB ${r.tmdb_id}`)}</strong>
              <div class="muted">${kindChipHtml(r, seen)} ${kind === "tv" ? `S${r.season} · E${r.episode} · ` : ""}${r.banned ? t("common.banned") + " · " : ""}${r.url_hidden ? "🔒 " + t("watch.urlHiddenChip") + " · " : ""}${escapeHtml(qualityLabel(r.quality) || r.quality || "—")} · ${escapeHtml(r.original_language || "—")} · ${r.has_subtitles ? (r.subtitle_languages === "all" ? t("dash.subsAll") : t("watch.subsYes", { langs: escapeHtml(r.subtitle_languages || "yes") })) : t("dash.noSubs")} · ${r.has_ads ? t("common.adsOn") : t("common.adsOff")} · ${Number(r.clicks || 0)} ${t("common.clicks")} · TMDB ${r.tmdb_id} · ${String(r.added_at || "").slice(0, 10)}</div>
            </a>
            <button class="btn btn-sm btn-ghost" data-toggle-url="${r.id}" data-kind="${kind}" data-hidden="${r.url_hidden ? "1" : "0"}" type="button">${r.url_hidden ? t("dash.showUrl") : t("dash.hideUrl")}</button>
            <button class="btn btn-sm btn-ghost" data-del-link="${r.id}" data-kind="${kind}" type="button">${t("common.remove")}</button>
          </div>`
            )
            .join("")
        : `<p class="empty">${t("common.none")}</p>`;
    };
    drawRows("#lk-movies", movieRows, "movie");
    drawRows("#lk-series", tvRows, "tv");
    $("#lk-save").onclick = async () => {
      if (!(await C.guardFeature("links"))) return;
      const type = $("#lk-type").value;
      const tmdbId = parseTmdbInput($("#lk-tmdb").value, type);
      const watchUrl = $("#lk-watch").value.trim();
      const kind = $('input[name="lk-kind"]:checked')?.value || "watch";
      const quality = selectedQualities("lk-q");
      const urlHidden = $("#lk-urlvis")?.value === "hide";
      const originalLanguage = $("#lk-lang").value.trim();
      const hasSubtitles = $("#lk-subs").value === "yes";
      const hasAds = $("#lk-ads").value === "yes";
      if (!tmdbId) return toast(t("dash.needTmdb"));
      if (!validWatchUrl(watchUrl)) return toast(t("dash.needUrl"));
      if (!quality) return toast(t("dash.needQuality"));
      if (!originalLanguage) return toast(t("dash.needLang"));
      let subtitleLanguages = "";
      if (hasSubtitles) {
        subtitleLanguages = selectedLangs("lk-sub");
        if (!subtitleLanguages) return toast(t("dash.needSubs"));
      }
      let season = 0;
      let episode = 0;
      if (type === "tv") {
        season = Number($("#lk-season").value);
        episode = Number($("#lk-episode").value);
        if (!Number.isInteger(season) || season < 1) return toast(t("dash.needSeason"));
        if (!Number.isInteger(episode) || episode < 1) return toast(t("dash.needEpisode"));
      }
      let title = "";
      try {
        const info = await tmdb(`/${type}/${tmdbId}`);
        title = info?.title || info?.name || "";
      } catch {
        title = "";
      }
      const row = {
        tmdb_id: tmdbId,
        member_id: state.member.member_id,
        username: state.member.username,
        watch_url: watchUrl,
        title,
        quality,
        original_language: originalLanguage,
        has_subtitles: hasSubtitles,
        subtitle_languages: subtitleLanguages,
        has_ads: hasAds,
        url_hidden: urlHidden,
        link_kind: kind,
      };
      const table = type === "tv" ? "tvlink" : "movielink";
      if (type === "tv") {
        row.season = season;
        row.episode = episode;
      }
      // One row per chosen kind: watch, download, or both at once. A kind this
      // URL already has is skipped, so publishing "both" twice never doubles it.
      const result = await publishWatchLink(table, row, [kind]);
      if (!result.ok) {
        if (!result.error) return toast(t("dash.dupUrl"));
        const raw = JSON.stringify(result.error.data || {});
        if (/duplicate|23505/i.test(raw)) return toast(t("dash.dupUrl"));
        if (/link_kind/i.test(raw)) return toast(t("watch.missingKind"));
        return toast(t("dash.linkFail"));
      }
      if (result.added.length > 1) toast(t("dash.linkSavedBoth"));
      else if (result.skipped.length) toast(t("dash.linkSavedDupKind"));
      else toast(t("dash.linkSaved"));
      viewLinks(main);
    };
    main.onclick = async (e) => {
      const flip = e.target.closest("[data-toggle-url]");
      if (flip) {
        const tbl = flip.dataset.kind === "tv" ? "tvlink" : "movielink";
        const hide = flip.dataset.hidden !== "1";
        const res = await supabaseRequest(`/rest/v1/${tbl}?id=eq.${flip.dataset.toggleUrl}`, {
          method: "PATCH",
          body: JSON.stringify({ url_hidden: hide }),
        });
        if (!res.ok) return toast(t("dash.linkFail"));
        toast(hide ? t("dash.urlNowHidden") : t("dash.urlNowShown"));
        viewLinks(main);
        return;
      }
      const btn = e.target.closest("[data-del-link]");
      if (!btn) return;
      const table = btn.dataset.kind === "tv" ? "tvlink" : "movielink";
      await supabaseRequest(`/rest/v1/${table}?id=eq.${btn.dataset.delLink}`, { method: "DELETE" });
      toast(t("dash.linkRemoved"));
      viewLinks(main);
    };
  }

  const REPORT_SUBJECTS = () => ({
    misleading: t("dash.rpt.misleading"),
    broken: t("dash.rpt.broken"),
    malicious: t("dash.rpt.malicious"),
    stolen: t("dash.rpt.stolen"),
    bad: t("dash.rpt.bad"),
    indirect: t("dash.rpt.indirect"),
  });

  async function viewReports(main) {
    const incoming = await supabaseRequest(
      `/rest/v1/reportlinks?owner_id=eq.${restValue(state.member.member_id)}&select=*&order=reported_at.desc`
    );
    const outgoing = await supabaseRequest(
      `/rest/v1/reportlinks?reporter_id=eq.${restValue(state.member.member_id)}&select=*&order=reported_at.desc`
    );
    const mineIn = incoming.ok && Array.isArray(incoming.data) ? incoming.data : [];
    const mineOut = outgoing.ok && Array.isArray(outgoing.data) ? outgoing.data : [];
    const validCount = (url, tmdb) =>
      mineIn.filter((r) => r.watch_url === url && Number(r.tmdb_id) === Number(tmdb) && r.verdict === "valid").length;
    const rowHtml = (r, kind) => `
      <div class="mini-card" style="margin-bottom:10px">
        <span class="eyebrow">${escapeHtml(tr(r.media_type || ""))} · ${escapeHtml(r.verdict === "ended" ? t("panel.ended") : r.verdict ? t("panel.valid") : "")}${kind === "in" && validCount(r.watch_url, r.tmdb_id) >= 10 ? " · banned" : ""}</span>
        <h3>${escapeHtml(REPORT_SUBJECTS()[r.subject] || tr(r.subject) || "Report")}</h3>
        <p class="muted">${escapeHtml(r.watch_url || "")}</p>
        <p class="muted">TMDB ${r.tmdb_id} · Owner ${escapeHtml(r.owner_id || "—")} · Reporter ${escapeHtml(r.reporter_id || "—")}</p>
        <p class="muted">Filed ${escapeHtml(String(r.reported_at || "").slice(0, 16).replace("T", " "))} · Verdict ${escapeHtml(String(r.verdict_at || "").slice(0, 16).replace("T", " "))}</p>
      </div>`;
    main.innerHTML = `
      <p class="eyebrow">${t("dash.moderation")}</p>
      <h1>${t("dash.reports")}</h1>
      <p class="muted">${t("dash.reportsLead")}</p>
      <div class="stat-row">
        <div class="stat"><b>${mineIn.length}</b><span>${t("dash.againstYou")}</span></div>
        <div class="stat"><b>${mineOut.length}</b><span>${t("dash.filedByYou")}</span></div>
      </div>
      <h2 style="margin:22px 0 10px">${t("dash.reportsOnYours")}</h2>
      ${mineIn.length ? mineIn.map((r) => rowHtml(r, "in")).join("") : `<p class="empty">${t("dash.noReportsIn")}</p>`}
      <h2 style="margin:22px 0 10px">${t("dash.reportsYouFiled")}</h2>
      ${mineOut.length ? mineOut.map((r) => rowHtml(r, "out")).join("") : `<p class="empty">${t("dash.noReportsOut")}</p>`}`;
  }

  function codeLimit() {
    return PLAN[state.member.membership_type] || PLAN.Free;
  }

  async function viewCodes(main) {
    const plan = codeLimit();
    const res = await supabaseRequest(
      `/rest/v1/codes?owner=eq.${restValue(state.member.member_id)}&select=*&order=created_at.desc`
    );
    const codes = res.ok && Array.isArray(res.data) ? res.data : [];
    // this browser's device address, and the code it remembers ("Remember the code")
    const here = C.deviceMac();
    const saved = C.getStoredCode();
    // a database without sql/code_devices.sql has no device columns yet, and
    // one with its first version has no device name / type yet
    const has = (c, col) => Object.prototype.hasOwnProperty.call(c, col);
    const devicesReady = !codes.length || codes.some((c) => has(c, "device_mac"));
    const typesReady = devicesReady && (!codes.length || codes.some((c) => has(c, "device_type")));
    const now = Date.now();
    const stateOf = (c) => codeState(c, codeTiming(c, now));
    // Linked devices: one per linked code, this device first, then the newest
    const devices = devicesReady
      ? codes
          .filter((c) => c.device_mac)
          .sort((a, b) => (b.device_mac === here) - (a.device_mac === here) || (Date.parse(b.device_linked_at || "") || 0) - (Date.parse(a.device_linked_at || "") || 0))
      : [];
    // the codes a device can be linked to by hand: active and free
    const freeCodes = codes.filter((c) => !c.device_mac && stateOf(c) === "active");
    main.innerHTML = `
      <p class="eyebrow">${t("dash.accessCodes")}</p>
      <h1>${t("dash.nav.codes")}</h1>
      <p class="muted">${t("dash.codesLead", { plan: tr(state.member.membership_type || "Free"), max: plan.maxCodes, months: plan.months })}</p>
      <div class="tabs follow-tabs dash-code-tabs" data-tabbar role="tablist" aria-label="${escapeHtml(t("dash.nav.codes"))}">
        <button type="button" role="tab" class="follow-tab" data-dtab="codes-list">${t("dash.nav.codes")}<span class="follow-count">${codes.length}</span></button>
        <button type="button" role="tab" class="follow-tab" data-dtab="codes-devices">${t("dash.dev.tab")}<span class="follow-count">${devices.length}</span></button>
      </div>
      <section class="follow-pane" data-dpane="codes-list" hidden>
      <div class="form-row">
        <input id="new-code" maxlength="6" placeholder="${t("dash.codePh")}" />
        <button class="btn btn-sm btn-ghost" id="gen-code" type="button">${t("common.generate")}</button>
      </div>
      <div class="form-row">
        <label class="field-label" for="new-age">${t("dash.ageLimit")}</label>
        <select id="new-age">
          ${AGE_TIERS.map(
            (tier) =>
              `<option value="${tier.id}"${tier.id === "adult" ? " selected" : ""}>${escapeHtml(
                t(tier.label)
              )}</option>`
          ).join("")}
        </select>
      </div>
      <p class="muted age-hint">${t("dash.codesAgeLead")}</p>
      <div class="form-row">
        <input id="new-ip" placeholder="${t("dash.ipPh")}" />
        <button class="btn btn-sm btn-ghost" id="detect-ip" type="button">${t("dash.detectIp")}</button>
      </div>
      <button class="btn btn-sm btn-primary" id="save-code" type="button">${t("dash.saveCode")}</button>
      ${devicesReady ? `
      <div class="code-devices-note">
        <p>${t("dash.code.deviceLead")}</p>
        <p class="code-this-mac">${t("dash.code.thisMac")} <b dir="ltr">${escapeHtml(here)}</b> <small>· ${escapeHtml(C.deviceName())}</small></p>
      </div>` : ""}
      <div class="codes-wrap">
        <table class="table codes-table"><thead><tr>
          <th>${t("dash.nav.codes")}</th>
          ${devicesReady ? `<th>${t("dash.code.device")}</th>` : ""}
          <th>IP</th>
          <th>${t("common.status")}</th>
          <th>${t("dash.ageLimit")}</th>
          <th>${t("common.expires")}</th>
          <th></th>
        </tr></thead>
        <tbody id="code-rows"></tbody></table>
      </div>
      </section>
      <section class="follow-pane dev-pane" data-dpane="codes-devices" hidden>${devicesPaneHtml()}</section>`;
    $("#code-rows").innerHTML =
      codes.map(codeRowHtml).join("") ||
      `<tr><td colspan="${devicesReady ? 7 : 6}" class="empty">${t("dash.noCodes")}</td></tr>`;

    /* One row per code. Next to the code: the MAC address and the IP of the
       device it is linked to (one device per code, sql/code_devices.sql), with
       "This device" on the code this browser uses. The IP of a code no device
       uses yet is the one it was created from. */
    function codeRowHtml(c) {
      const timing = codeTiming(c);
      const st = codeState(c, timing);
      const code = escapeHtml(c.code);
      const mac = devicesReady ? String(c.device_mac || "") : "";
      const mine = Boolean(mac) && mac === here;
      const remembered = mine && saved === String(c.code);
      const label = (key) => `data-label="${escapeHtml(t(key))}"`;
      const memo = mine && st === "active"
        ? `<small class="code-memo${remembered ? " is-on" : ""}">${t(remembered ? "dash.code.remembered" : "dash.code.notRemembered")}</small>`
        : "";
      // what can be done with the device link sits with the device
      const devActions = [];
      if (devicesReady && st === "active" && !mac) {
        devActions.push(`<button class="btn btn-sm btn-primary" data-use="${code}" type="button">${t("dash.code.useHere")}</button>`);
      }
      if (devicesReady && st === "active" && mine && !remembered) {
        devActions.push(`<button class="btn btn-sm btn-primary" data-use="${code}" type="button">${t("dash.code.rememberHere")}</button>`);
      }
      if (devicesReady && mac) {
        devActions.push(`<button class="btn btn-sm btn-ghost" data-unlink="${code}" data-mac="${escapeHtml(mac)}" type="button">${t("dash.code.unlink")}</button>`);
      }
      const devButtons = devActions.length ? `<div class="dev-actions">${devActions.join("")}</div>` : "";
      const device = !devicesReady
        ? ""
        : mac
          ? `<td class="dev-cell" ${label("dash.code.device")}><div>
              <span class="dev-mac" dir="ltr">${escapeHtml(mac)}</span>
              ${deviceKindHtml(c)}
              ${c.device_agent ? `<small class="dev-sub">${escapeHtml(c.device_agent)}</small>` : ""}
              ${c.device_linked_at ? `<small class="dev-sub">${t("dash.code.linkedOn", { date: dayText(Date.parse(c.device_linked_at)) })}</small>` : ""}
              ${devButtons}
            </div></td>`
          : `<td class="dev-cell" ${label("dash.code.device")}><div><span class="muted">${t("dash.code.notLinked")}</span>${devButtons}</div></td>`;
      let ip = "—";
      if (mac && c.device_ip) ip = `<span class="${ipClass(c.device_ip)}" dir="ltr">${escapeHtml(c.device_ip)}</span>`;
      else if (!mac && c.ip) ip = `<span class="${ipClass(c.ip)} muted" dir="ltr" title="${escapeHtml(t("dash.code.ipCreated"))}">${escapeHtml(c.ip)}</span>`;
      // "18 and over — no limit" -> "18 and over" in the table, the whole label on hover
      const age = codeAgeLabel(c.age_rating);
      return `
      <tr class="${mine ? "is-here" : ""}">
        <td class="code-cell" ${label("dash.nav.codes")}>
          <span class="code-digits" dir="ltr">${code}</span>
          ${mine ? `<span class="code-here">${t("dash.code.thisDevice")}</span>` : ""}
          ${memo}
        </td>
        ${device}
        <td ${label("dash.ipPh")}>${ip}</td>
        <td ${label("common.status")}><span class="ov-st ${st}">${t(`dash.ov.st.${st}`)}</span></td>
        <td ${label("dash.ageLimit")}><span class="chip chip-soft" title="${escapeHtml(age)}">${escapeHtml(age.split(" — ")[0])}</span></td>
        <td class="code-exp" ${label("common.expires")}>${String(c.expires_at || "").slice(0, 10) || "—"}</td>
        <td class="code-acts"><div class="actions">
          <button class="btn btn-sm btn-ghost" data-copy="${code}" type="button">${t("common.copy")}</button>
          <button class="btn btn-sm btn-danger" data-del="${code}" type="button">${t("common.delete")}</button>
        </div></td>
      </tr>`;
    }
    // Codes saved before the age tiers existed carry no limit.
    function codeAgeLabel(value) {
      return value ? t(ageTier(value).label) : t("code.ageNone");
    }

    function ipClass(value) {
      return `code-ip${String(value).includes(":") ? " is-v6" : ""}`; // a long IPv6 may wrap
    }

    /* ---------- Linked devices ----------
       One row per device, each linked to one code: added by the watch page the
       first time a code is entered on a device (type web, no name), or here by
       hand (name, type, MAC address, one of the free codes, Link). */
    function codeOptionText(c) {
      const exp = String(c.expires_at || "").slice(0, 10);
      return [c.code, codeAgeLabel(c.age_rating).split(" — ")[0], exp].filter(Boolean).map(escapeHtml).join(" · ");
    }

    function freeCodeOptions() {
      if (!freeCodes.length) return `<option value="">—</option>`;
      return `<option value="">${escapeHtml(t("dash.dev.pickCode"))}</option>${freeCodes
        .map((c) => `<option value="${escapeHtml(c.code)}">${codeOptionText(c)}</option>`)
        .join("")}`;
    }

    function devicesPaneHtml() {
      if (!devicesReady) return `<p class="dev-notice">${t("dash.code.devSql")}</p>`;
      const typeOptions = C.DEVICE_TYPES.map((type) => `<option value="${type.id}">${escapeHtml(t(type.label))}</option>`).join("");
      const form = typesReady
        ? `
        <div class="dev-toolbar">
          <button class="btn btn-sm btn-primary" id="dev-open" type="button" aria-expanded="false" aria-controls="dev-form">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
            ${t("dash.dev.add")}
          </button>
        </div>
        <form class="dev-form" id="dev-form" hidden novalidate>
          <h3 id="dev-form-title">${t("dash.dev.add")}</h3>
          <div class="dev-grid">
            <label class="dev-field">
              <span>${t("dash.dev.name")} <small>(${t("dash.dev.optional")})</small></span>
              <input id="dev-name" maxlength="60" autocomplete="off" placeholder="${escapeHtml(t("dash.dev.namePh"))}" />
            </label>
            <label class="dev-field">
              <span>${t("common.type")}</span>
              <select id="dev-type">${typeOptions}</select>
            </label>
            <label class="dev-field">
              <span>${t("dash.dev.mac")}</span>
              <input id="dev-mac" class="dev-mac-input" dir="ltr" maxlength="17" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="AA:BB:CC:DD:EE:FF" />
              <small class="dev-mine" id="dev-mine">${t("dash.code.thisMac")} <b dir="ltr">${escapeHtml(here)}</b> <button class="dev-link-btn" id="dev-use-mine" type="button">${t("dash.dev.useMine")}</button></small>
            </label>
            <label class="dev-field">
              <span>${t("dash.dev.code")}</span>
              <select id="dev-code"${freeCodes.length ? "" : " disabled"}>${freeCodeOptions()}</select>
              <small class="dev-warn" id="dev-nofree"${freeCodes.length ? " hidden" : ""}>${t("dash.dev.noFree")}</small>
            </label>
          </div>
          <p class="dev-msg" id="dev-msg" role="alert"></p>
          <div class="dev-form-actions">
            <button class="btn btn-sm btn-primary" id="dev-submit" type="submit">${t("dash.dev.link")}</button>
            <button class="btn btn-sm btn-ghost" id="dev-cancel" type="button">${t("common.cancel")}</button>
          </div>
        </form>`
        : `<p class="dev-notice">${t("dash.dev.sql")}</p>`;
      return `
        <p class="muted dev-lead">${t("dash.dev.lead")}</p>
        ${form}
        <div class="codes-wrap">
          <table class="table devices-table"><thead><tr>
            <th>${t("dash.dev.device")}</th>
            <th>${t("common.type")}</th>
            <th>${t("dash.dev.mac")}</th>
            <th>${t("dash.dev.code")}</th>
            <th>IP</th>
            <th>${t("dash.dev.linked")}</th>
            <th></th>
          </tr></thead>
          <tbody id="dev-rows">${devices.map(deviceRowHtml).join("") || `<tr><td colspan="7" class="empty">${t("dash.dev.none")}</td></tr>`}</tbody></table>
        </div>`;
    }

    function deviceRowHtml(c) {
      const code = escapeHtml(c.code);
      const mac = String(c.device_mac || "");
      const mine = mac === here;
      // a device linked before the types existed was linked by the site
      const type = C.deviceType(c.device_type) || C.deviceType("web");
      const typeLabel = t(type.label);
      const name = String(c.device_name || "").trim();
      const st = stateOf(c);
      const label = (key) => `data-label="${escapeHtml(t(key))}"`;
      const linked = Date.parse(c.device_linked_at || "");
      const seen = Date.parse(c.device_seen_at || "");
      const ip = c.device_ip
        ? `<span class="${ipClass(c.device_ip)}" dir="ltr">${escapeHtml(c.device_ip)}</span>`
        : `<span class="muted">—</span>`;
      return `
      <tr class="${mine ? "is-here" : ""}" data-dev="${code}">
        <td class="dev-main" ${label("dash.dev.device")}>
          <div class="dev-id">
            <span class="dev-ic" title="${escapeHtml(typeLabel)}">${C.deviceTypeIcon(type.id, 20)}</span>
            <div class="dev-id-text">
              <b class="dev-name${name ? "" : " is-empty"}">${name ? `<bdi>${escapeHtml(name)}</bdi>` : t("dash.dev.noName")}</b>
              ${mine ? `<span class="code-here">${t("dash.code.thisDevice")}</span>` : ""}
              ${c.device_agent ? `<small class="dev-sub">${escapeHtml(c.device_agent)}</small>` : ""}
            </div>
          </div>
        </td>
        <td ${label("common.type")}><span class="dev-type">${escapeHtml(typeLabel)}</span></td>
        <td ${label("dash.dev.mac")}><span class="dev-mac" dir="ltr">${escapeHtml(mac)}</span></td>
        <td ${label("dash.dev.code")}><div class="dev-code"><span class="code-digits" dir="ltr">${code}</span>${st !== "active" ? `<span class="ov-st ${st}">${t(`dash.ov.st.${st}`)}</span>` : ""}</div></td>
        <td ${label("dash.ipPh")}>${ip}</td>
        <td class="dev-when" ${label("dash.dev.linked")}><div>${Number.isFinite(linked) ? escapeHtml(dayText(linked)) : "—"}<small class="dev-sub">${Number.isFinite(seen) ? t("dash.dev.lastUsed", { date: escapeHtml(whenText(seen)) }) : t("dash.dev.notUsed")}</small></div></td>
        <td class="code-acts"><div class="actions">
          ${typesReady ? `<button class="btn btn-sm btn-ghost" data-dev-edit="${code}" type="button">${t("dash.editBtn")}</button>` : ""}
          <button class="btn btn-sm btn-ghost" data-unlink="${code}" data-mac="${escapeHtml(mac)}" type="button">${t("dash.code.unlink")}</button>
        </div></td>
      </tr>`;
    }

    const fillIp = (ip) => {
      const input = $("#new-ip");
      if (input && ip) input.value = ip;
    };

    async function detectPublicIp() {
      const readers = [
        ["https://api.ipify.org?format=json", (t) => JSON.parse(t).ip],
        ["https://api64.ipify.org?format=json", (t) => JSON.parse(t).ip],
        ["https://api.ipify.org", (t) => t.trim()],
        ["https://ipv4.icanhazip.com/", (t) => t.trim()],
        ["https://icanhazip.com/", (t) => t.trim()],
        ["https://ipwho.is/", (t) => JSON.parse(t).ip],
      ];
      for (const [url, read] of readers) {
        try {
          const r = await fetch(url, { cache: "no-store" });
          if (!r.ok) continue;
          const ip = String(read(await r.text()) || "").trim();
          if (ip && /^[0-9a-fA-F.:]+$/.test(ip)) return ip;
        } catch {
          /* try next */
        }
      }
      return "";
    }

    function codeSaveMessage(saved) {
      const raw = JSON.stringify(saved?.data || {});
      if (/duplicate|23505/i.test(raw)) return t("dash.codeExists");
      if (/row-level security|42501/i.test(raw)) return t("dash.codeRls");
      if (/PGRST204|schema cache|could not find.*ip/i.test(raw)) return t("dash.codeIpCol");
      if (saved?.data?.message) return saved.data.message;
      return t("dash.codeFail");
    }

    $("#gen-code").onclick = () => {
      $("#new-code").value = String(Math.floor(100000 + Math.random() * 900000));
    };
    $("#detect-ip").onclick = async (e) => {
      e.preventDefault();
      const btn = $("#detect-ip");
      btn.disabled = true;
      btn.textContent = t("dash.detecting");
      const ip = await detectPublicIp();
      btn.disabled = false;
      btn.textContent = t("dash.detectIp");
      if (!ip) {
        toast(t("dash.ipFail"));
        $("#new-ip")?.focus();
        return;
      }
      fillIp(ip);
      toast(t("dash.ipOk", { ip }));
    };
    detectPublicIp().then((ip) => {
      if (ip && !$("#new-ip")?.value) fillIp(ip);
    });
    $("#save-code").onclick = async (e) => {
      e.preventDefault();
      const code = $("#new-code").value.replace(/\D/g, "").slice(0, 6);
      let ip = $("#new-ip").value.trim();
      if (!/^\d{6}$/.test(code)) return toast(t("dash.need6"));
      if (codes.length >= plan.maxCodes) return toast(t("dash.planAllows", { n: plan.maxCodes }));
      if (!ip) {
        ip = await detectPublicIp();
        fillIp(ip);
      }
      if (!ip) return toast(t("dash.needIp"));
      const btn = $("#save-code");
      btn.disabled = true;
      const exp = new Date();
      exp.setMonth(exp.getMonth() + plan.months);
      const age = $("#new-age").value || "adult";
      const row = {
        owner: state.member.member_id,
        code,
        status: "active",
        duration: `${plan.months} month${plan.months > 1 ? "s" : ""}`,
        ip,
        age_rating: age,
        expires_at: exp.toISOString(),
      };
      // An install that has not run sql/codes.sql yet rejects the new columns:
      // retry without them rather than losing the code.
      const drop = (source, key) => {
        const copy = { ...source };
        delete copy[key];
        return copy;
      };
      const variants = [row, drop(row, "age_rating"), drop(row, "ip"), drop(drop(row, "age_rating"), "ip")];
      let saved = null;
      let used = 0;
      for (let i = 0; i < variants.length; i += 1) {
        saved = await supabaseRequest("/rest/v1/codes", { method: "POST", body: JSON.stringify(variants[i]) });
        used = i;
        if (saved.ok) break;
        if (!/PGRST204|schema cache|could not find/i.test(JSON.stringify(saved.data || {}))) break;
      }
      if (!saved.ok) {
        btn.disabled = false;
        return toast(codeSaveMessage(saved));
      }
      const sent = variants[used];
      if (sent.age_rating === undefined) toast(t("dash.codeSavedNoAge"));
      else if (sent.ip === undefined) toast(t("dash.codeSavedNoIp"));
      else toast(t("dash.codeSavedIp", { ip }));
      viewCodes(main);
    };
    const codeRpc = (name, args) =>
      supabaseRequest(`/rest/v1/rpc/${name}`, { method: "POST", body: JSON.stringify(args) });
    // the IP is only a fallback for the database (it reads the caller's own): never wait long
    const ipSoon = () => Promise.race([C.publicIp(), new Promise((r) => setTimeout(() => r(""), 1500))]);
    const rpcMissing = (r) => r.status === 404 || r.data?.code === "PGRST202";

    // "Use on this device" / "Remember on this device": the code becomes the one
    // this browser uses, and is remembered here (not asked again).
    async function useHere(btn) {
      const code = btn.dataset.use;
      btn.disabled = true;
      const r = await codeRpc("code_link_here", {
        p_member: state.member.member_id,
        p_code: code,
        p_mac: here,
        p_name: C.deviceName(),
        p_ip: await ipSoon(),
      });
      const d = r.ok && r.data && typeof r.data === "object" ? r.data : null;
      if (!d?.ok) {
        btn.disabled = false;
        if (r.blocked) return;
        if (rpcMissing(r)) return toast(t("dash.code.devSql"));
        if (d?.reason === "other_device") return toast(t("dash.code.otherFirst"));
        if (["expired", "disabled", "banned"].includes(d?.reason)) {
          return toast(t("dash.code.notUsable", { status: t(`dash.ov.st.${d.reason}`) }));
        }
        return toast(t("dash.code.devFail"));
      }
      C.setStoredCode(code);
      toast(t("dash.code.usedHere", { code }));
      viewCodes(main);
    }

    // "Unlink": the code is set free; the device it was on must type a code again
    async function unlinkCode(btn) {
      const code = btn.dataset.unlink;
      if (!window.confirm(t("dash.code.unlinkAsk", { code, mac: `\u2066${btn.dataset.mac || ""}\u2069` }))) return;
      btn.disabled = true;
      const r = await codeRpc("code_unlink", { p_member: state.member.member_id, p_code: code });
      const d = r.ok && r.data && typeof r.data === "object" ? r.data : null;
      if (!d?.ok) {
        btn.disabled = false;
        if (r.blocked) return;
        return toast(rpcMissing(r) ? t("dash.code.devSql") : t("dash.code.devFail"));
      }
      if (C.getStoredCode() === code) C.clearStoredCode();
      toast(t("dash.code.unlinked", { code }));
      viewCodes(main);
    }

    /* Linked devices > Add device / Edit: one form. Adding links a device (its
       MAC address) to one of the free codes; editing changes its name and type
       (to move a device to another code: Unlink, then add it again). */
    let editing = null;
    const devMsg = (text) => {
      const el = $("#dev-msg");
      if (el) el.textContent = text || "";
    };

    function openDeviceForm(c) {
      const form = $("#dev-form");
      if (!form) return;
      editing = c ? String(c.code) : null;
      form.hidden = false;
      form.classList.toggle("is-edit", Boolean(c));
      $("#dev-open")?.setAttribute("aria-expanded", "true");
      $("#dev-form-title").textContent = c ? t("dash.dev.editTitle") : t("dash.dev.add");
      $("#dev-submit").textContent = c ? t("common.save") : t("dash.dev.link");
      $("#dev-name").value = c ? String(c.device_name || "") : "";
      $("#dev-type").value = c ? (C.deviceType(c.device_type) || C.deviceType("web")).id : "web";
      const macInput = $("#dev-mac");
      macInput.value = c ? String(c.device_mac || "") : "";
      macInput.disabled = Boolean(c);
      $("#dev-mine").hidden = Boolean(c);
      const codeSel = $("#dev-code");
      codeSel.innerHTML = c ? `<option value="${escapeHtml(c.code)}">${codeOptionText(c)}</option>` : freeCodeOptions();
      codeSel.disabled = Boolean(c) || !freeCodes.length;
      $("#dev-nofree").hidden = Boolean(c) || freeCodes.length > 0;
      devMsg("");
      form.scrollIntoView({ block: "nearest" });
      $("#dev-name").focus({ preventScroll: true });
    }

    function closeDeviceForm() {
      const form = $("#dev-form");
      if (!form) return;
      form.hidden = true;
      editing = null;
      $("#dev-open")?.setAttribute("aria-expanded", "false");
      devMsg("");
    }

    function deviceFailText(r, d) {
      if (rpcMissing(r)) return t("dash.dev.sql");
      switch (d?.reason) {
        case "bad_mac":
          return t("dash.dev.badMac");
        case "code_linked":
          return t("dash.code.otherFirst");
        case "mac_linked":
          return t("dash.dev.macMine", { code: `\u2066${d.code || ""}\u2069` });
        case "mac_taken":
          return t("dash.dev.macTaken");
        case "expired":
        case "disabled":
        case "banned":
          return t("dash.code.notUsable", { status: t(`dash.ov.st.${d.reason}`) });
        default:
          return t("dash.code.devFail");
      }
    }

    async function submitDevice(e) {
      e.preventDefault();
      const btn = $("#dev-submit");
      const name = $("#dev-name").value.trim();
      const type = $("#dev-type").value;
      let r;
      if (editing) {
        btn.disabled = true;
        r = await codeRpc("code_device_edit", { p_member: state.member.member_id, p_code: editing, p_name: name, p_type: type });
      } else {
        const mac = C.normalizeMac($("#dev-mac").value);
        if (!mac) {
          devMsg(t("dash.dev.badMac"));
          return $("#dev-mac").focus();
        }
        const code = $("#dev-code").value;
        if (!code) {
          devMsg(freeCodes.length ? t("dash.dev.needCode") : t("dash.dev.noFree"));
          return $("#dev-code").focus();
        }
        btn.disabled = true;
        r = await codeRpc("code_device_add", { p_member: state.member.member_id, p_code: code, p_mac: mac, p_name: name, p_type: type });
      }
      const d = r.ok && r.data && typeof r.data === "object" ? r.data : null;
      btn.disabled = false;
      if (!d?.ok) {
        if (r.blocked) return;
        return devMsg(deviceFailText(r, d));
      }
      if (editing) toast(t("dash.dev.savedOk"));
      else toast(t("dash.dev.linkedOk", { device: d.name ? `\u2068${d.name}\u2069` : `\u2066${d.mac}\u2069`, code: `\u2066${d.code}\u2069` }));
      viewCodes(main);
    }

    if ($("#dev-form")) {
      $("#dev-open").onclick = () => ($("#dev-form").hidden || editing ? openDeviceForm(null) : closeDeviceForm());
      $("#dev-cancel").onclick = closeDeviceForm;
      $("#dev-form").onsubmit = submitDevice;
      // a message about the last try goes as soon as the form is changed
      $("#dev-form").addEventListener("input", () => devMsg(""));
      $("#dev-form").addEventListener("change", () => devMsg(""));
      $("#dev-use-mine").onclick = () => {
        $("#dev-mac").value = here;
        devMsg("");
      };
      // "0a1b2c3d4e5f", "0a-1b-…": shown as 0A:1B:2C:3D:4E:5F while typing
      $("#dev-mac").addEventListener("input", (e) => {
        const hex = e.target.value.toUpperCase().replace(/[^0-9A-F]/g, "").slice(0, 12);
        e.target.value = (hex.match(/.{1,2}/g) || []).join(":");
      });
    }
    const devRows = $("#dev-rows");
    if (devRows) {
      devRows.onclick = (e) => {
        const edit = e.target.closest("[data-dev-edit]");
        const unlink = e.target.closest("[data-unlink]");
        if (unlink) return unlinkCode(unlink);
        if (edit) {
          const c = codes.find((x) => String(x.code) === edit.dataset.devEdit);
          if (c) openDeviceForm(c);
        }
      };
    }

    // the two tabs; the address follows (dashboard.html#devices opens Linked devices)
    wireTabs(main, "codes");
    const syncCodesHash = () => {
      const hash = state.tabs?.codes === "codes-devices" ? "#devices" : "#codes";
      if (location.hash !== hash) history.replaceState(history.state, "", hash);
    };
    main.querySelector(".dash-code-tabs")?.addEventListener("click", (e) => {
      if (e.target.closest("[data-dtab]")) syncCodesHash();
    });
    syncCodesHash();

    $("#code-rows").onclick = async (e) => {
      const copy = e.target.closest("[data-copy]");
      const del = e.target.closest("[data-del]");
      const use = e.target.closest("[data-use]");
      const unlink = e.target.closest("[data-unlink]");
      if (use) return useHere(use);
      if (unlink) return unlinkCode(unlink);
      if (copy) {
        await navigator.clipboard.writeText(copy.dataset.copy);
        toast(t("dash.codeCopied"));
      }
      if (del) {
        await supabaseRequest(`/rest/v1/codes?code=eq.${restValue(del.dataset.del)}`, { method: "DELETE" });
        // a deleted code is no longer remembered here either
        if (C.getStoredCode() === del.dataset.del) C.clearStoredCode();
        toast(t("dash.codeDeleted"));
        viewCodes(main);
      }
    };
  }

  // Free packages (every member) + the premium accounts given to this member in
  // Panel > IPTV. owner_id normally holds the member id; a row typed by hand may
  // hold the username instead: both count (CineAura.iptvOwnedBy).
  async function loadMyIptv() {
    const m = state.member;
    const res = await supabaseRequest(`/rest/v1/iptv?${C.iptvVisibleFilter(m)}&select=*&order=id.desc`);
    if (!res.ok || !Array.isArray(res.data)) return null;
    return res.data.filter((p) => C.iptvVisibleTo(p, m));
  }

  const IPTV_NEW_MS = 7 * 86400000; // "New" badge on a premium account given this week

  // premium accounts of the member: still running first (soonest to end on top), ended ones last
  function myPremium(rows) {
    const now = Date.now();
    return (rows || [])
      .filter((p) => !C.iptvIsFree(p) && C.iptvOwnedBy(p, state.member))
      .map((p) => ({ p, tm: C.iptvTiming(p, now) }))
      .sort((a, b) => (a.tm.left <= 0) - (b.tm.left <= 0) || a.tm.left - b.tm.left || (b.tm.start || 0) - (a.tm.start || 0));
  }

  // "12 days left" + bar + "Valid until …", the same look as the codes of the overview
  function iptvValidityHtml(tm, p) {
    let left;
    let until = "";
    if (tm.exp === null) left = tm.open ? t("dash.ov.noExpiry") : `${t("common.duration")}: ${C.durationLabel(p?.duration)}`; // a duration typed in a way that cannot be counted
    else if (tm.left <= 0) {
      left = t("dash.ov.expired");
      until = t("dash.ov.expiredOn", { date: whenText(tm.exp) });
    } else {
      left = t("dash.ov.left", { time: timeLeftText(tm.left) });
      until = t("dash.ov.expiresOn", { date: whenText(tm.exp) });
    }
    const since = tm.start ? t("dash.iptv.since", { date: whenText(tm.start) }) : "";
    const tone = tm.left <= 0 ? "off" : tm.share < 0.15 ? "low" : tm.share < 0.5 ? "mid" : "";
    return `
      <div class="ov-left">
        <span class="ov-label">${t("dash.ov.validity")}</span>
        <b>${escapeHtml(left)}</b>
        ${tm.exp !== null || tm.open ? `<div class="ov-bar ${tone}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(tm.share * 100)}" aria-label="${escapeHtml(t("dash.ov.validity"))}"><i style="width:${Math.max(tm.share > 0 ? 3 : 0, Math.round(tm.share * 100))}%"></i></div>` : ""}
        ${until || since ? `<small>${escapeHtml([until, since].filter(Boolean).join(" · "))}</small>` : ""}
      </div>`;
  }

  function iptvBadgesHtml(p, tm, showEnded = true) {
    const free = C.iptvIsFree(p);
    const ended = showEnded && !free && tm && tm.left <= 0;
    const fresh = !free && tm?.start && tm.left > 0 && Date.now() - tm.start < IPTV_NEW_MS;
    return `
      <span class="ipx-badge ${free ? "free" : "paid"}">${free ? t("panel.iptv.free") : t("dash.iptv.premium")}</span>
      <span class="ipx-badge">${C.iptvKind(p) === "m3u" ? "M3U" : "Xtream"}</span>
      ${free ? `<span class="ipx-badge">${t("common.duration")}: ${escapeHtml(C.durationLabel(p.duration))}</span>` : ""}
      ${C.iptvEpgUrl(p) ? `<span class="ipx-badge epg">${t("iptv.epg")}</span>` : ""}
      ${fresh ? `<span class="ipx-badge new">${t("dash.iptv.new")}</span>` : ""}
      ${ended ? `<span class="ipx-badge off">${t("dash.ov.st.expired")}</span>` : ""}`;
  }

  // Dashboard > IPTV: two tabs. "IPTV packages": the free packages and the premium
  // accounts given to the member (Panel > IPTV). "Your lists": the IPTV lists the member
  // published (sql/iptv_lists.sql, js/iptv-lists.js): publish, edit, read the channels
  // again, copy the link, delete. dashboard.html#iptv-lists opens the second tab.
  async function viewIptv(main) {
    const [rows, lists] = await Promise.all([loadMyIptv().then((r) => r || []).catch(() => []), loadMyLists()]);
    const premium = myPremium(rows);
    const free = rows.filter((p) => C.iptvIsFree(p));
    const card = (p, tm = null) => `
          <article class="ipx-card${tm ? " ipx-premium" : ""}${tm && tm.left <= 0 ? " is-ended" : ""}" id="ipx-${escapeHtml(p.id)}">
            <header class="ipx-head">
              <h3>${escapeHtml(p.name)}</h3>
              <div class="ipx-badges">${iptvBadgesHtml(p, tm)}</div>
            </header>
            ${tm ? iptvValidityHtml(tm, p) : ""}
            <div class="ipx-rows">${C.iptvDetailRows(p)}</div>
            <footer class="ipx-actions">
              ${C.iptvActionsHtml(p)}
              <a class="btn btn-sm btn-primary" href="./Listchannels.html?package=${encodeURIComponent(p.name)}">${t("common.channels")}</a>
            </footer>
          </article>`;
    main.innerHTML = `
      <p class="eyebrow">${t("dash.liveTv")}</p>
      <h1>${t("dash.nav.iptv")}</h1>
      <div class="tabs follow-tabs dash-iptv-tabs" data-tabbar role="tablist" aria-label="${escapeHtml(t("dash.nav.iptv"))}">
        <button type="button" role="tab" class="follow-tab" data-dtab="iptv-packs">${t("dash.iptvPacks")}<span class="follow-count">${premium.length + free.length}</span></button>
        <button type="button" role="tab" class="follow-tab" data-dtab="iptv-lists">${t("ipl.yourLists")}<span class="follow-count" id="ipl-dash-count">${lists.rows.length}</span></button>
      </div>
      <section class="follow-pane" data-dpane="iptv-packs" hidden>
        <p class="muted">${t("dash.iptvLead")}</p>
        <div id="ipx-wrap">
          ${premium.length ? `
          <h2 class="ipx-group">${t("dash.iptv.mine")}</h2>
          <div class="ipx-grid" id="ipx-premium">${premium.map(({ p, tm }) => card(p, tm)).join("")}</div>
          <h2 class="ipx-group">${t("dash.iptv.freeTitle")}</h2>` : ""}
          <div class="ipx-grid" id="ipx-grid">${
            free.length ? free.map((p) => card(p)).join("") : `<p class="empty">${t(premium.length ? "dash.iptv.noFree" : "dash.noIptv")}</p>`
          }</div>
        </div>
      </section>
      <section class="follow-pane ipl-dash" data-dpane="iptv-lists" id="ipl-dash" hidden></section>`;
    C.bindIptvActions($("#ipx-wrap"), (id) => rows.find((x) => String(x.id) === id));
    const pane = $("#ipl-dash");
    drawMyLists(pane, lists);
    wireMyLists(pane);
    // the two tabs; the address follows (dashboard.html#iptv-lists opens Your lists)
    wireTabs(main, "iptv");
    const syncIptvHash = () => {
      const hash = state.tabs?.iptv === "iptv-lists" ? "#iptv-lists" : "#iptv";
      if (location.hash !== hash) history.replaceState(history.state, "", hash);
    };
    main.querySelector(".dash-iptv-tabs")?.addEventListener("click", (e) => {
      if (e.target.closest("[data-dtab]")) syncIptvHash();
    });
    syncIptvHash();
  }

  // ---------- Dashboard > IPTV > Your lists ----------
  async function loadMyLists() {
    const L = window.CineAuraIptvLists;
    if (!L || !state.member) return { ok: false, setup: true, rows: [] };
    const res = await L.call("iptv_lists_mine", { p_member: state.member.member_id });
    if (!res.ok) return { ok: false, setup: Boolean(res.setup), rows: [] };
    return { ok: true, rows: Array.isArray(res.data) ? res.data : [] };
  }

  function drawMyLists(pane, got) {
    const L = window.CineAuraIptvLists;
    pane._lists = got.rows;
    const plus = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
    const count = $("#ipl-dash-count");
    if (count) count.textContent = String(got.rows.length);
    let body;
    if (!got.ok) body = `<p class="empty">${escapeHtml(t(got.setup ? "ipl.setupText" : "ipl.loadFail"))}</p>`;
    else if (!got.rows.length) body = `<p class="empty">${escapeHtml(t("ipl.noMineText"))}</p>`;
    else body = `<div class="ipl-grid">${got.rows.map((l) => L.cardHtml(l, { manage: true, owner: false })).join("")}</div>`;
    pane.innerHTML = `
        <div class="ipl-dash-head">
          <p>${escapeHtml(t("ipl.dashLead"))}</p>
          <div class="ipl-dash-acts">
            ${got.ok || !got.setup ? `<button class="btn btn-sm btn-primary" type="button" data-ipl-new>${plus}<span>${escapeHtml(t("ipl.publish"))}</span></button>` : ""}
            <a class="btn btn-sm btn-ghost" href="./IPTV.html">${escapeHtml(t("ipl.pageLink"))}</a>
          </div>
        </div>
        ${body}`;
  }

  async function reloadMyLists(pane) {
    drawMyLists(pane, await loadMyLists());
  }

  function wireMyLists(pane) {
    const L = window.CineAuraIptvLists;
    if (!L) return;
    const find = (id) => (pane._lists || []).find((l) => l.id === id);
    pane.onclick = async (e) => {
      if (e.target.closest("[data-ipl-new]")) {
        L.openForm({ onSaved: () => reloadMyLists(pane) });
        return;
      }
      const edit = e.target.closest("[data-ipl-edit]");
      if (edit) {
        const l = find(edit.dataset.iplEdit);
        if (l) L.openForm({ list: l, onSaved: () => reloadMyLists(pane) });
        return;
      }
      const copy = e.target.closest("[data-ipl-copy]");
      if (copy) {
        const ok = await C.copyText(C.absoluteUrl(L.listHref(copy.dataset.iplCopy)));
        toast(t(ok ? "ipl.copied" : "ipl.copyFail"));
        return;
      }
      const again = e.target.closest("[data-ipl-refresh]");
      if (again) {
        const l = find(again.dataset.iplRefresh);
        const box = again.closest(".ipl-card");
        if (!l || box?.classList.contains("ipl-busy")) return;
        box?.classList.add("ipl-busy");
        again.textContent = t("ipl.refreshing");
        const r = await L.refresh(l);
        toast(r.ok ? t("ipl.refreshed", { n: L.fmt(r.counts?.channels || 0) }) : L.errText(r));
        await reloadMyLists(pane);
        return;
      }
      const del = e.target.closest("[data-ipl-delete]");
      if (del) {
        const l = find(del.dataset.iplDelete);
        if (!l || !confirm(t("ipl.confirmDelete", { name: l.name }))) return;
        const r = await L.call("iptv_list_delete", { p_member: state.member.member_id, p_id: l.id });
        toast(r.ok && r.data?.ok ? t("ipl.deleted") : L.errText(r.ok ? r.data : r));
        await reloadMyLists(pane);
      }
    };
  }

  async function viewViews(main) {
    const mineRes = await supabaseRequest(
      `/rest/v1/views?viewer_id=eq.${restValue(state.member.member_id)}&select=*`
    );
    const ids = state.playlists.map((p) => p.playlist_id).filter(Boolean);
    let extra = [];
    if (ids.length) {
      const other = await supabaseRequest(
        `/rest/v1/views?playlist_id=in.(${ids.join(",")})&select=*`
      );
      extra = other.ok && Array.isArray(other.data) ? other.data : [];
    }
    const viaLinks = await supabaseRequest(
      `/rest/v1/views?link_owner_id=eq.${restValue(state.member.member_id)}&select=*`
    );
    const linkRows = (viaLinks.ok && Array.isArray(viaLinks.data) ? viaLinks.data : []).filter(
      (r) => r.viewer_id !== state.member.member_id
    );
    const rows = [...(mineRes.ok && Array.isArray(mineRes.data) ? mineRes.data : []), ...extra, ...linkRows];
    const mine = rows.filter((r) => r.viewer_id === state.member.member_id);
    const others = extra.filter((r) => r.viewer_id !== state.member.member_id);
    const sum = (arr) => arr.reduce((a, b) => a + Number(b.minutes || 0), 0);
    main.innerHTML = `
      <p class="eyebrow">${t("dash.watchTime")}</p>
      <h1>${t("dash.nav.views")}</h1>
      <div class="toolbar">
        <select id="vf"><option value="all">${t("dash.allTime")}</option><option value="year">${t("dash.thisYear")}</option><option value="month">${t("dash.thisMonth")}</option><option value="week">${t("dash.thisWeek")}</option><option value="day">${t("dash.today")}</option></select>
      </div>
      <div class="stat-row">
        <div class="stat"><b>${sum(mine)}</b><span>${t("dash.yourMin")}</span></div>
        <div class="stat"><b>${sum(others)}</b><span>${t("dash.othersLists")}</span></div>
        <div class="stat"><b>${sum(linkRows)}</b><span>${t("dash.othersLinks")}</span></div>
      </div>
      <div id="view-list"></div>`;
    const draw = () => {
      const f = $("#vf").value;
      const now = new Date();
      const filtered = mine.filter((r) => {
        const d = new Date(r.started_at);
        if (f === "year") return d.getFullYear() === now.getFullYear();
        if (f === "month") return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        if (f === "week") return now - d < 7 * 86400000;
        if (f === "day") return d.toDateString() === now.toDateString();
        return true;
      });
      $("#view-list").innerHTML = filtered.length
        ? `<table class="table"><thead><tr><th>${t("common.id")}</th><th>${t("common.type")}</th><th>${t("common.minutes")}</th><th>${t("common.started")}</th></tr></thead><tbody>${
            filtered.map((r) => `<tr><td>${r.tmdb_id}</td><td>${r.media_type}</td><td>${r.minutes}</td><td>${String(r.started_at).slice(0,16)}</td></tr>`).join("")
          }</tbody></table>`
        : `<p class="empty">${t("dash.noViews")}</p>`;
    };
    $("#vf").onchange = draw;
    draw();
  }

  async function viewAnalytics(main) {
    const movies = await supabaseRequest(
      `/rest/v1/movielink?member_id=eq.${restValue(state.member.member_id)}&select=*&order=added_at.desc`
    );
    const series = await supabaseRequest(
      `/rest/v1/tvlink?member_id=eq.${restValue(state.member.member_id)}&select=*&order=added_at.desc`
    );
    const movieLinks = movies.ok && Array.isArray(movies.data) ? movies.data : [];
    const tvLinks = series.ok && Array.isArray(series.data) ? series.data : [];
    const allLinks = [
      ...movieLinks.map((r) => ({ ...r, media_type: "movie" })),
      ...tvLinks.map((r) => ({ ...r, media_type: "tv" })),
    ];
    const ids = [...new Set(allLinks.map((r) => Number(r.tmdb_id)).filter(Boolean))];
    let visits = [];
    let pageViews = [];
    let linkViews = [];
    if (ids.length) {
      const hist = await supabaseRequest(
        `/rest/v1/hestory?tmdb_id=in.(${ids.join(",")})&select=tmdb_id,media_type,visitor_id`
      );
      visits = hist.ok && Array.isArray(hist.data) ? hist.data : [];
      const pv = await supabaseRequest(
        `/rest/v1/views?tmdb_id=in.(${ids.join(",")})&select=tmdb_id,media_type,minutes,viewer_id,link_owner_id,watch_url,season,episode`
      );
      pageViews = pv.ok && Array.isArray(pv.data) ? pv.data : [];
    }
    const lv = await supabaseRequest(
      `/rest/v1/views?link_owner_id=eq.${restValue(state.member.member_id)}&select=*`
    );
    linkViews = lv.ok && Array.isArray(lv.data) ? lv.data : [];

    const matchLinkViews = (link) =>
      linkViews.filter((v) => {
        if (Number(v.tmdb_id) !== Number(link.tmdb_id)) return false;
        if (String(v.media_type) !== link.media_type) return false;
        if (link.watch_url && v.watch_url) return v.watch_url === link.watch_url;
        if (link.media_type === "tv") {
          return Number(v.season) === Number(link.season) && Number(v.episode) === Number(link.episode);
        }
        return true;
      });

    const draw = () => {
      const type = document.querySelector('input[name="an-ft"]:checked')?.value || "all";
      const links = allLinks.filter((l) => type === "all" || l.media_type === type);
      const tmdbSet = new Set(links.map((l) => Number(l.tmdb_id)));
      const pageVisits = visits.filter(
        (h) => tmdbSet.has(Number(h.tmdb_id)) && (type === "all" || h.media_type === type)
      );
      const titleMinutes = pageViews.filter(
        (v) => tmdbSet.has(Number(v.tmdb_id)) && (type === "all" || v.media_type === type)
      );
      const owned = linkViews.filter((v) => type === "all" || v.media_type === type);
      const pageMin = titleMinutes.reduce((a, r) => a + Number(r.minutes || 0), 0);
      const linkMin = owned.reduce((a, r) => a + Number(r.minutes || 0), 0);
      const visitors = new Set(owned.map((r) => r.viewer_id).filter(Boolean)).size;
      const clicks = owned.length;
      const ctr = pageVisits.length ? ((clicks / pageVisits.length) * 100).toFixed(1) : "0.0";
      $("#an-stats").innerHTML = `
        <div class="stat"><b>${pageVisits.length}</b><span>${t("dash.titleVisits")}</span></div>
        <div class="stat"><b>${pageMin}</b><span>${t("dash.titleMin")}</span></div>
        <div class="stat"><b>${linkMin}</b><span>${t("dash.linkMin")}</span></div>
        <div class="stat"><b>${visitors}</b><span>${t("dash.linkVisitors")}</span></div>
        <div class="stat"><b>${ctr}%</b><span>${t("dash.ctr")}</span></div>`;
      $("#an-table").innerHTML = links.length
        ? `<table class="table"><thead><tr>
            <th>TMDB</th><th>Type</th><th>${t("dash.seEp")}</th><th>${t("dash.linkVisits")}</th><th>${t("dash.linkMin")}</th>
          </tr></thead><tbody>${links
            .map((l) => {
              const rows = matchLinkViews(l);
              const ep = l.media_type === "tv" ? `S${l.season} · E${l.episode}` : t("common.excluded");
              return `<tr>
                <td><a href="${l.media_type === "tv" ? `./watch.html?tv=${l.tmdb_id}&season=${l.season}&episode=${l.episode}` : `./watch.html?movie=${l.tmdb_id}`}">${l.tmdb_id}</a></td>
                <td>${l.media_type === "tv" ? t("common.series") : t("common.movie")}</td>
                <td>${ep}</td>
                <td>${rows.length}</td>
                <td>${rows.reduce((a, r) => a + Number(r.minutes || 0), 0)}</td>
              </tr>`;
            })
            .join("")}</tbody></table>`
        : `<p class="empty">${t("dash.noPub")}</p>`;
    };

    main.innerHTML = `
      <p class="eyebrow">${t("dash.insights")}</p>
      <h1>${t("dash.nav.analytics")}</h1>
      <p class="muted">${t("dash.anLead")}</p>
      <div class="stat-row" id="an-stats"></div>
      <div class="filter-bar">
        <div class="filter-group">
          <span class="muted">${t("common.type")}</span>
          <label class="lang-chip"><input type="radio" name="an-ft" value="all" checked /> ${t("common.all")}</label>
          <label class="lang-chip"><input type="radio" name="an-ft" value="movie" /> ${t("common.movies")}</label>
          <label class="lang-chip"><input type="radio" name="an-ft" value="tv" /> ${t("common.series")}</label>
        </div>
      </div>
      <div style="overflow:auto" id="an-table"></div>`;
    $$('input[name="an-ft"]').forEach((el) => {
      el.onchange = draw;
    });
    draw();
  }

  async function viewPrizes(main) {
    const memberId = state.member.member_id;
    const memberFilter = restValue(memberId);
    const R = window.PrizeRules;
    const [
      prizeRes,
      modeRes,
      conditionRes,
      entryRes,
      progressRes,
      groupRes,
      winnerRes,
      dateRes,
      historyRes,
      limitRes,
      claimRes,
    ] = await Promise.all([
      supabaseRequest("/rest/v1/prizes?select=*&order=minutes_required.asc,id.asc"),
      supabaseRequest("/rest/v1/prize_modes?select=*&order=sort_order.asc,id.asc"),
      supabaseRequest("/rest/v1/prize_mode_conditions?select=*&order=sort_order.asc,id.asc"),
      supabaseRequest("/rest/v1/prize_mode_entries?select=*&order=id.asc"),
      supabaseRequest("/rest/v1/prize_mode_progress?select=*&order=id.asc"),
      supabaseRequest("/rest/v1/prize_groups?select=id,name,thumb,visible,sort_order&order=sort_order.asc,id.asc"),
      supabaseRequest(`/rest/v1/winners?member_id=eq.${memberFilter}&select=*`),
      supabaseRequest("/rest/v1/prize_country_dates?select=*&order=id.asc"),
      supabaseRequest(`/rest/v1/hestory?visitor_id=eq.${memberFilter}&select=tmdb_id,media_type,visited_at`),
      R?.loadLimits ? R.loadLimits() : Promise.resolve({ limits: null, ok: false }),
      R?.loadClaims ? R.loadClaims(memberId) : Promise.resolve({ ok: false, rows: [] }),
    ]);

    const prizes = prizeRes.ok && Array.isArray(prizeRes.data) ? prizeRes.data : [];
    const modes = modeRes.ok && Array.isArray(modeRes.data) ? modeRes.data : [];
    const conditions = conditionRes.ok && Array.isArray(conditionRes.data) ? conditionRes.data : [];
    const entries = entryRes.ok && Array.isArray(entryRes.data) ? entryRes.data : [];
    const progress = progressRes.ok && Array.isArray(progressRes.data) ? progressRes.data : [];
    const groups = groupRes.ok && Array.isArray(groupRes.data) ? groupRes.data : [];
    const winners = winnerRes.ok && Array.isArray(winnerRes.data) ? winnerRes.data : [];
    const countryDates = dateRes.ok && Array.isArray(dateRes.data) ? dateRes.data : [];
    const history = historyRes.ok && Array.isArray(historyRes.data) ? historyRes.data : [];
    const seen = new Set(history.map((row) => `${row.media_type}:${row.tmdb_id}`));
    // Prize claims (sql/prize_claims.sql): the review of every claim, and a block
    // on new claims after a rejected one.
    const claims = claimRes?.rows || [];
    const claimBlock = R?.claimBlock ? R.claimBlock(claims) : null;
    const entryClaim = (entryId) => (R?.claimForEntry ? R.claimForEntry(claims, entryId) : null);
    const plainClaim = (p) => (R?.claimForPrize ? R.claimForPrize(claims, p) : null);
    // The button of a prize the member won: "Claim prize", then the claim's state.
    const claimCta = (claim, requestedAt) =>
      claim ? t(`pzc.st.${R.claimState(claim)}`) : requestedAt ? t("prize.claimRequested") : t("prize.claim");
    const mp = await C.memberPoints(memberId, state.profile || {});
    const totalPoints = Number(mp.available || 0);
    const totalMinutes = Number(state.profile?.private_minutes || 0) + Number(state.profile?.public_minutes || 0);
    const active = normalizeAccountStatus(state.member.status) === "active";
    const now = Date.now();
    const country = String(state.profile?.country || state.member.country || "").trim().toLowerCase();
    const username = String(state.member.username || "").trim().toLowerCase();
    const memberKey = String(memberId || "").trim().toLowerCase();
    const ageYears = (iso) => {
      if (!iso) return null;
      const birth = new Date(iso);
      if (Number.isNaN(birth.getTime())) return null;
      let age = new Date().getFullYear() - birth.getFullYear();
      const md = new Date().getMonth() - birth.getMonth();
      if (md < 0 || (md === 0 && new Date().getDate() < birth.getDate())) age -= 1;
      return age;
    };
    const age = ageYears(state.member.birth_date);
    const groupFor = (p) => groups.find((g) => String(g.id) === String(p.group_id)) || null;
    const groupName = (p) => p.group_name || groupFor(p)?.name || "";
    const list = (value) => String(value || "").toLowerCase().split(/[,;\n\r]+/).map((x) => x.trim()).filter(Boolean);
    const modeKey = (mode) => String(mode?.mode || "gift").toLowerCase();
    const modesOf = (p) => modes.filter((mode) => String(mode.prize_id) === String(p.id));
    const entriesOf = (p, mode) => entries.filter((entry) =>
      String(entry.prize_id) === String(p.id) && String(entry.mode || "").toLowerCase() === modeKey(mode)
    );
    const mineFor = (p, mode) => entriesOf(p, mode).find((entry) =>
      String(entry.member_id || "").toLowerCase() === memberKey
    ) || null;
    const prizeVisible = (p) => {
      const group = groupFor(p);
      if (group && group.visible === false) return false;
      if (String(p.visibility || "public").toLowerCase() === "private") {
        const allowed = list(p.allowed_usernames);
        return allowed.includes(username) || allowed.includes(memberKey);
      }
      return true;
    };
    const baseConditionsMet = (p) => {
      if (!prizeVisible(p) || !active) return false;
      if (Number(p.minutes_required || 0) > totalMinutes) return false;
      const visibility = String(p.visibility || "public").toLowerCase();
      if (visibility === "exclusive") {
        const countries = list(p.countries);
        if (countries.length && !countries.includes(country)) return false;
        const minAge = p.min_age == null || p.min_age === "" ? null : Number(p.min_age);
        const maxAge = p.max_age == null || p.max_age === "" ? null : Number(p.max_age);
        if (minAge !== null && (age === null || age < minAge)) return false;
        if (maxAge !== null && (age === null || age > maxAge)) return false;
        if (p.watched_tmdb && p.watched_type && !seen.has(`${p.watched_type}:${p.watched_tmdb}`)) return false;
      }
      return true;
    };
    const dayStart = (value) => {
      if (!value) return null;
      const stamp = Date.parse(`${String(value).slice(0, 10)}T00:00:00`);
      return Number.isNaN(stamp) ? null : stamp;
    };
    const windowFor = (p, mode) => {
      const rows = countryDates.filter((row) => String(row.prize_id) === String(p.id));
      if (R?.windowFor) return R.windowFor(p, mode, rows, country);
      const row = rows.find((x) => String(x.country || "").toLowerCase() === country);
      return {
        startsAt: row?.starts_at || mode?.starts_at || p.starts_at || null,
        endsAt: row ? row.ends_at || null : (mode?.unlimited_time ? null : mode?.ends_at || p.ends_at || null),
      };
    };
    const modeTiming = (p, mode) => {
      if (String(p.status || "active").toLowerCase() === "ended") return { open: false, phase: "ended", reason: t("prize.closed") };
      const window = windowFor(p, mode);
      const start = dayStart(window.startsAt);
      if (start !== null && start > now) return { open: false, phase: "upcoming", reason: t("prize.notStarted") };
      if (modeKey(mode) !== "lottery") {
        const end = dayStart(window.endsAt);
        if (end !== null && end + 86400000 <= now) return { open: false, phase: "ended", reason: t("prize.closed") };
      }
      return { open: true, phase: "open", reason: "" };
    };
    const configOf = (mode) => {
      if (R?.cfgOf) return R.cfgOf(mode);
      try { return typeof mode?.config === "object" ? mode.config : JSON.parse(mode?.config || "{}"); }
      catch { return {}; }
    };
    const memberEntries = entries.filter((entry) => String(entry.member_id || "").toLowerCase() === memberKey);
    const prizeMap = Object.fromEntries(prizes.map((p) => [p.id, p]));
    const usage = R?.usage ? R.usage(memberEntries, prizeMap) : null;
    const limits = limitRes?.limits || R?.DEFAULT_LIMITS || null;
    const modeState = (p, mode) => {
      const key = modeKey(mode);
      const mine = mineFor(p, mode);
      const timing = modeTiming(p, mode);
      const own = entriesOf(p, mode);
      const won = own.filter((entry) => String(entry.status || "").toLowerCase() === "winner").length;
      const capValue = key === "lottery" ? mode.winners_needed : mode.quantity;
      const cap = capValue == null || capValue === "" ? null : Number(capValue);
      const full = cap !== null && won >= cap;
      const cost = Math.max(0, Number(mode.points_cost || 0));
      const audience = configOf(mode).audience || {};
      const audienceOk = !R?.audienceFails || R.audienceFails(audience, state.member).length === 0;
      const baseOk = baseConditionsMet(p);
      const quota = limits && usage && R?.limitCheck
        ? R.limitCheck(limits, state.member.membership_type, key, usage)
        : { ok: true };
      const canJoin = timing.open && !mine && !full && baseOk && audienceOk && quota.ok && totalPoints >= cost;
      return { mine, timing, full, won, cap, cost, baseOk, audienceOk, quota, canJoin };
    };
    const plainWinner = (p) => winners.some((winner) =>
      String(winner.prize_title || "") === String(p.title || "")
    );
    const canClaimPlain = (p) => {
      if (!baseConditionsMet(p) || plainWinner(p)) return false;
      if (String(p.status || "active").toLowerCase() === "ended") return false;
      const start = dayStart(p.starts_at);
      const end = p.unlimited_time ? null : dayStart(p.ends_at);
      if (start !== null && start > now) return false;
      if (end !== null && end + 86400000 <= now) return false;
      if (p.quantity != null && Number(p.winners_count || 0) >= Number(p.quantity)) return false;
      return totalPoints >= Math.max(0, Number(p.minutes_required || 0));
    };
    const activeChallenges = entries.filter((entry) =>
      String(entry.member_id || "").toLowerCase() === memberKey &&
      String(entry.mode || "").toLowerCase() === "challenge" &&
      String(entry.status || "competitor").toLowerCase() === "competitor"
    );
    const activityByEntry = {};
    if (R?.activityCounts && activeChallenges.length) {
      await Promise.all(activeChallenges.map(async (entry) => {
        const result = await R.activityCounts([memberId], entry.created_at || "");
        activityByEntry[String(entry.id)] = result?.[memberId] || {};
      }));
    }
    const challengeProgress = (p, mode, entry) => {
      const rows = conditions.filter((condition) => String(condition.mode_id) === String(mode.id));
      const activity = activityByEntry[String(entry.id)] || {};
      const completed = rows.filter((condition) => {
        const required = Math.max(1, Number(condition.required || 1));
        const stored = progress.find((row) =>
          String(row.entry_id) === String(entry.id) && String(row.condition_id) === String(condition.id)
        );
        let live = 0;
        const kind = String(condition.kind || "watch");
        if (kind === "watch") live = seen.has(`${condition.media_type || "movie"}:${condition.tmdb_id}`) ? 1 : 0;
        else if (kind === "points") live = totalMinutes;
        else if (typeof activity[kind] === "number") live = activity[kind];
        return Math.max(Number(stored?.progress || 0), Number(live || 0)) >= required;
      }).length;
      const days = Number(configOf(mode).days || 0);
      const joinedAt = Date.parse(entry.created_at || "") || 0;
      const expired = Boolean(days && joinedAt && now > joinedAt + days * 86400000);
      const winnersCount = entriesOf(p, mode).filter((row) => String(row.status || "").toLowerCase() === "winner").length;
      const cap = mode.quantity == null || mode.quantity === "" ? null : Number(mode.quantity);
      const full = cap !== null && winnersCount >= cap;
      const ready = rows.length > 0 && completed === rows.length && !expired && !full && String(p.status || "active").toLowerCase() !== "ended";
      return { ready, completed, total: rows.length };
    };

    const available = [];
    const challengeReady = new Map();
    activeChallenges.forEach((entry) => {
      const prize = prizes.find((p) => String(p.id) === String(entry.prize_id));
      const mode = modes.find((m) => String(m.id) === String(entry.mode_id));
      if (!prize || !mode || !prizeVisible(prize)) return;
      const result = challengeProgress(prize, mode, entry);
      if (result.ready) challengeReady.set(`${prize.id}:challenge`, { prize, mode, entry, progress: result, claimReady: true });
    });
    available.push(...challengeReady.values());
    prizes.forEach((p) => {
      if (!prizeVisible(p) || plainWinner(p)) return;
      const prizeModes = modesOf(p);
      const gift = prizeModes.find((mode) => modeKey(mode) === "gift");
      if (gift) {
        const result = modeState(p, gift);
        if (result.canJoin) available.push({ prize: p, mode: gift, claimReady: false });
      } else if (!prizeModes.length && canClaimPlain(p) && R?.claimState?.(plainClaim(p)) !== "rejected") {
        available.push({ prize: p, mode: null, claimReady: false, legacy: true });
      }
    });

    const challengePrizes = prizes.flatMap((p) => {
      if (!prizeVisible(p) || String(p.status || "active").toLowerCase() === "ended") return [];
      const mode = modesOf(p).find((row) => modeKey(row) === "challenge");
      if (!mode) return [];
      const status = modeState(p, mode);
      const progressInfo = status.mine && String(status.mine.status || "").toLowerCase() === "competitor"
        ? challengeProgress(p, mode, status.mine)
        : null;
      return [{ prize: p, mode, status, progress: progressInfo, claimReady: Boolean(progressInfo?.ready) }];
    });
    const lotteryPrizes = prizes.flatMap((p) => {
      if (!prizeVisible(p) || String(p.status || "active").toLowerCase() === "ended") return [];
      const mode = modesOf(p).find((row) => modeKey(row) === "lottery");
      return mode ? [{ prize: p, mode, status: modeState(p, mode) }] : [];
    });

    const imageOf = (p) => {
      const group = groupFor(p);
      const gallery = [p.prize_image, ...(Array.isArray(p.images) ? p.images : String(p.images || "").split(/[\r\n]+/)), p.group_thumb, group?.thumb];
      return gallery.map((url) => String(url || "").trim()).find((url) => /^https?:\/\//i.test(url)) || initialsAvatar(p.title || "CineAura");
    };
    const cards = (rows, kind) => rows.length
      ? `<div class="dash-prize-grid">${rows.map((row) => {
          const p = row.prize;
          const mode = row.mode;
          const modeName = mode ? modeKey(mode) : "gift";
          const image = imageOf(p);
          const fallback = initialsAvatar(p.title || "CineAura");
          const modeStatus = row.status || (mode ? modeState(p, mode) : null);
          const entryStatus = kind === "mine" ? String(p.__entryStatus || "").toLowerCase() : "";
          let action = t("dash.viewPrize");
          const details = [];
          if (kind === "mine" && entryStatus) details.push(t(`prize.status.${entryStatus}`));
          const myClaim = kind === "mine" ? p.__claim : modeStatus?.mine ? entryClaim(modeStatus.mine.id) : null;
          if (row.claimReady && modeName === "challenge") action = t("pzm.confirmWin");
          else if (kind === "available") action = t("prize.claim");
          else if (kind === "mine" && (entryStatus === "winner" || myClaim)) action = claimCta(myClaim, p.__claimRequestedAt);
          else if (modeName === "challenge") {
            action = String(modeStatus?.mine?.status || "").toLowerCase() === "winner" || myClaim
              ? claimCta(myClaim, modeStatus.mine.claim_requested_at)
              : modeStatus?.mine ? t("dash.continueChallenge") : modeStatus?.canJoin ? t("dash.joinChallenge") : t("dash.viewPrize");
          } else if (modeName === "lottery") {
            action = String(modeStatus?.mine?.status || "").toLowerCase() === "winner" || myClaim
              ? claimCta(myClaim, modeStatus.mine.claim_requested_at)
              : modeStatus?.mine ? t("dash.viewDraw") : modeStatus?.canJoin ? t("prize.enterLottery") : t("dash.viewPrize");
          }
          if (row.progress) details.push(t("dash.challengeProgress", { done: row.progress.completed, total: row.progress.total }));
          const detail = details.join(" · ");
          const cost = mode ? Number(mode.points_cost || 0) : Number(p.minutes_required || 0);
          const winCount = mode
            ? entriesOf(p, mode).filter((entry) => String(entry.status || "").toLowerCase() === "winner").length
            : Number(p.winners_count || 0);
          const cap = mode ? (modeName === "lottery" ? mode.winners_needed : mode.quantity) : p.winners_needed;
          const people = cap == null || cap === "" ? `${winCount} ${t("prize.winners")}` : `${winCount}/${cap} ${t("prize.winners")}`;
          const params = new URLSearchParams({ GroupPrize: String(p.group_id ?? 0), Prize: String(p.id), mode: modeName });
          const href = `./Prize.html?${params.toString()}`;
          const summary = [groupName(p), t("prize.points", { n: cost }), people, detail].filter(Boolean).join(" · ");
          const badge = row.claimReady ? `<span class="dash-prize-badge ready">${escapeHtml(t("dash.readyToClaim"))}</span>` : mode ? `<span class="dash-prize-badge mode-${escapeHtml(modeName)}">${escapeHtml(t(`prize.mode.${modeName}`))}</span>` : "";
          return `<a class="dash-prize-card glass" href="${escapeHtml(href)}">
            <span class="dash-prize-image"><img src="${escapeHtml(image)}" alt="${escapeHtml(p.title || "")}" loading="lazy" onerror="this.onerror=null;this.src='${escapeHtml(fallback)}'" />${badge}</span>
            <span class="dash-prize-body">
              ${groupName(p) ? `<small class="dash-prize-group">${escapeHtml(groupName(p))}</small>` : ""}
              <strong>${escapeHtml(p.title || "")}</strong>
              <span class="dash-prize-description">${escapeHtml(p.description || "")}</span>
              <span class="dash-prize-meta">${escapeHtml(summary)}</span>
              <span class="btn btn-sm btn-primary dash-prize-cta">${escapeHtml(action)}</span>
            </span>
          </a>`;
        }).join("")}</div>`
      : `<p class="empty">${escapeHtml(t(kind === "available" ? "dash.noClaimablePrizes" : kind === "challenge" ? "dash.noChallenges" : kind === "lottery" ? "dash.noLotteries" : "dash.noYourPrizes"))}</p>`;

    const myEntries = entries.filter((entry) => String(entry.member_id || "").toLowerCase() === memberKey);
    const mineRows = [];
    myEntries.forEach((entry) => {
      const prize = prizes.find((p) => String(p.id) === String(entry.prize_id));
      if (!prize) return;
      const mode = modes.find((row) => String(row.id) === String(entry.mode_id)) || null;
      const modeName = String(entry.mode || mode?.mode || "gift").toLowerCase();
      const status = String(entry.status || "competitor").toLowerCase();
      const p = { ...prize, __entryStatus: status, __entryMode: modeName, __claimRequestedAt: entry.claim_requested_at || null, __claim: entryClaim(entry.id) };
      const progressInfo = modeName === "challenge" && mode ? challengeProgress(prize, mode, entry) : null;
      mineRows.push({ prize: p, mode: mode || { mode: modeName, points_cost: entry.points_paid || 0 }, claimReady: status === "competitor" && Boolean(progressInfo?.ready), progress: progressInfo });
    });
    winners.forEach((winner) => {
      if (mineRows.some((row) => String(row.prize.title) === String(winner.prize_title))) return;
      const prize = prizes.find((p) => String(p.title) === String(winner.prize_title));
      if (prize) mineRows.push({ prize: { ...prize, __entryStatus: "winner", __entryMode: "gift", __claimRequestedAt: winner.claim_requested_at || null, __claim: plainClaim(prize) }, mode: null });
    });
    mineRows.sort((a, b) => Number(b.claimReady) - Number(a.claimReady) || String(a.prize.title).localeCompare(String(b.prize.title)));

    const groupsByName = {};
    prizes.filter(prizeVisible).forEach((p) => {
      const name = groupName(p) || t("dash.ungroupedPrizes");
      const group = groupFor(p);
      if (!groupsByName[name]) groupsByName[name] = { name, thumb: p.group_thumb || group?.thumb || "", count: 0, id: p.group_id };
      groupsByName[name].count += 1;
    });
    const groupCards = Object.values(groupsByName).length
      ? `<div class="dash-prize-grid">${Object.values(groupsByName).map((group) => {
          const image = /^https?:\/\//i.test(String(group.thumb || "")) ? group.thumb : initialsAvatar(group.name);
          const href = group.id == null ? "./Prize.html" : `./Prize.html?GroupPrize=${encodeURIComponent(group.id)}`;
          return `<a class="dash-prize-group-card glass" href="${escapeHtml(href)}"><img src="${escapeHtml(image)}" alt="" loading="lazy" /><span><strong>${escapeHtml(group.name)}</strong><small>${escapeHtml(t("dash.nPrizes", { n: group.count }))}</small></span></a>`;
        }).join("")}</div>`
      : `<p class="empty">${escapeHtml(t("dash.noGroups"))}</p>`;

    // Prize claims: every claim with its steps (Claim submitted -> Claim under
    // review -> Claim accepted / rejected); a rejected one shows the reason and
    // the action the team took.
    const CLAIM_HINT = { submitted: "pzc.hint.submitted", review: "pzc.hint.review", accepted: "pzc.hint.accepted", rejected: "pzc.hint.rejected" };
    const claimCards = claims.length && R?.claimStepsHtml
      ? `<div class="pzc-mine">${claims.map((c) => {
          const st = R.claimState(c);
          const p = prizes.find((x) => String(x.id) === String(c.prize_id)) || null;
          const title = c.prize_title || p?.title || "";
          const fallback = initialsAvatar(title || "CineAura");
          const modeName = R.lc(c.mode);
          const query = p ? new URLSearchParams({ GroupPrize: String(p.group_id ?? 0), Prize: String(p.id), ...(R.MODES.includes(modeName) ? { mode: modeName } : {}) }) : null;
          const href = query ? `./Prize.html?${query.toString()}` : "";
          const meta = [R.MODES.includes(modeName) ? t(`prize.mode.${modeName}`) : "", t("pza.paid", { n: Number(c.points_paid || 0) })].filter(Boolean).join(" · ");
          const thumb = `<img src="${escapeHtml(p ? imageOf(p) : fallback)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${escapeHtml(fallback)}'" />`;
          return `<article class="pzc-item is-${st}" data-claim="${escapeHtml(c.id)}">
            ${href ? `<a class="pzc-thumb" href="${escapeHtml(href)}" tabindex="-1" aria-hidden="true">${thumb}</a>` : `<span class="pzc-thumb">${thumb}</span>`}
            <div class="pzc-item-body">
              <div class="pzc-item-top">
                <strong>${href ? `<a href="${escapeHtml(href)}">${escapeHtml(title)}</a>` : escapeHtml(title)}</strong>
                <span class="pzc-badge cs-${st}">${escapeHtml(t(`pzc.st.${st}`))}</span>
              </div>
              <p class="pzc-meta">${escapeHtml(meta)}</p>
              ${R.claimStepsHtml(c)}
              <p class="pzc-hint">${escapeHtml(t(CLAIM_HINT[st]))}</p>
              ${R.claimVerdictHtml(c)}
            </div>
          </article>`;
        }).join("")}</div>`
      : `<p class="empty">${escapeHtml(t("pzc.none"))}</p>`;
    const blockHtml = claimBlock
      ? `<div class="pzc-blocked" role="status"><span>${R.CLAIM_ICON?.ban || ""}</span><div>
          <b>${escapeHtml(t("pzc.blocked", { d: R.claimWhen(claimBlock.claim.restricted_until) }))}</b>
          ${claimBlock.claim.reason ? `<p>${escapeHtml(t("pzc.reason"))}: <bdi>${escapeHtml(claimBlock.claim.reason)}</bdi></p>` : ""}
        </div></div>`
      : "";

    const tabs = [
      { id: "available", label: t("dash.availablePrizes"), pane: cards(available, "available") },
      { id: "challenge", label: t("prize.mode.challenge"), pane: cards(challengePrizes, "challenge") },
      { id: "lottery", label: t("prize.mode.lottery"), pane: cards(lotteryPrizes, "lottery") },
      { id: "mine", label: t("dash.yourPrizes"), pane: cards(mineRows, "mine") },
      { id: "claims", label: t("pzc.tab"), pane: claimCards },
      { id: "groups", label: t("dash.tabGroups"), pane: groupCards },
    ];
    main.innerHTML = `
      <p class="eyebrow">${t("dash.rewards")}</p>
      <h1>${t("dash.prizes")}</h1>
      <div class="stat"><b>${totalPoints}</b><span>${t("points.available")}</span></div>
      <div style="margin-top:14px">${C.pointsHtml(mp)}</div>
      <p class="muted" style="margin-top:10px">${t("dash.totalPrivPub")}: <b>${totalMinutes}</b></p>
      ${blockHtml}
      <div class="tabs follow-tabs dash-prize-tabs" data-tabbar role="tablist" aria-label="${escapeHtml(t("dash.prizes"))}">
        ${tabs.map((tab) => `<button type="button" role="tab" class="follow-tab" data-dtab="prize-${tab.id}">${escapeHtml(tab.label)}</button>`).join("")}
      </div>
      ${tabs.map((tab) => `<section class="follow-pane dash-prize-pane" data-dpane="prize-${tab.id}" hidden><h2>${escapeHtml(tab.label)}</h2>${tab.pane}</section>`).join("")}`;
    wireTabs(main, "prizeModes");
  }

  async function viewHistory(main) {
    const res = await supabaseRequest(
      `/rest/v1/hestory?visitor_id=eq.${restValue(state.member.member_id)}&select=*&order=visited_at.desc`
    );
    const rows = res.ok && Array.isArray(res.data) ? res.data : [];
    const movies = rows.filter((r) => r.media_type === "movie");
    const series = rows.filter((r) => r.media_type === "tv");
    const block = (title, arr, type) => `
      <h2 style="margin:18px 0 8px">${title}</h2>
      ${arr.length ? arr.map((r)=>`
        <div class="item-row">
          <img src="${r.poster_path ? C.imgUrl(r.poster_path,"w92") : initialsAvatar(r.title)}" alt="" />
          <div><strong>${escapeHtml(r.title||type)}</strong><div class="muted">${String(r.visited_at||"").slice(0,16)}</div></div>
          <a class="btn btn-sm btn-ghost" href="./watch.html?${type}=${r.tmdb_id}">${t("common.open")}</a>
        </div>`).join("") : `<p class="empty">${t("dash.noYet", { what: title })}</p>`}`;
    main.innerHTML = `<p class="eyebrow">${t("dash.visited")}</p><h1>${t("dash.history")}</h1>${block(t("common.movies"), movies, "movie")}${block(t("common.series"), series, "tv")}`;
  }

  // Country of the content and "Watch without ads": for guests these sit in the
  // Site Settings dialog of the header, which members do not see (css/style.css).
  function wireSiteSettings(main) {
    const sel = main.querySelector("#s-site-country");
    const hint = main.querySelector("#s-geo-hint");
    const box = main.querySelector("#s-adfree");
    const boxState = main.querySelector("#s-adfree-state");
    if (!sel || !box) return;
    let detecting = false;
    const syncCountry = () => {
      sel.innerHTML = `<option value="">${escapeHtml(t("set.countryNone"))}</option>` + C.countryChoices().map(([cc, n]) => `<option value="${cc}">${escapeHtml(n)}</option>`).join("");
      sel.value = C.currentCountry();
      hint.textContent = detecting ? t("set.detecting") : C.manualCountry() ? t("set.countryManual") : C.currentCountry() ? t("set.countryAuto") : t("set.countryFail");
    };
    syncCountry();
    sel.onchange = () => {
      C.setSiteCountry(sel.value);
      syncCountry();
    };
    main.querySelector("#s-redetect").onclick = async () => {
      if (detecting) return;
      detecting = true;
      C.setSiteCountry("");
      syncCountry();
      const cc = await C.detectGeo(true).catch(() => "");
      detecting = false;
      if (!cc) toast(t("set.countryFail"));
      C.setSiteCountry("");
      if (sel.isConnected) syncCountry();
    };
    C.membership().then((ms) => {
      if (!box.isConnected) return;
      if (ms?.premium) {
        box.disabled = false;
        box.checked = C.adFreeFlag();
        boxState.textContent = "";
      } else {
        box.disabled = true;
        box.checked = false;
        boxState.innerHTML = `${escapeHtml(t("set.adfreeLocked"))} <a href="./#plans">${escapeHtml(t("set.seePlans"))}</a>`;
      }
    });
    box.onchange = async () => {
      const on = box.checked;
      // the plan is checked again: the switch only works for an active premium member
      if (on && !(await C.membership()).premium) {
        box.checked = false;
        return;
      }
      C.setAdFreeFlag(on);
      if (on) window.CineAuraAds?.hide?.();
      toast(t(on ? "set.adfreeOn" : "set.adfreeOff"));
    };
  }

  const UPGRADE_ICON =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="m8 12 4-4 4 4"/><path d="M12 16V8"/></svg>';

  // Settings > Account & security: the plan, and an "Upgrade" button while it is
  // Free (a paid plan that has ended counts as Free). Paid plans keep the small
  // "Upgrade / activate" link to renew or change.
  function planBoxHtml(m, left) {
    const line = t("dash.membershipLine", { plan: escapeHtml(tr(m.membership_type || "Free")), left: t("common.daysLeft", { n: left }) });
    if (C.planIsPremium(m)) {
      return `<p class="muted">${line}<a href="./activate.html">${t("common.upgrade")}</a></p>`;
    }
    return `
      <div class="set-plan">
        <p class="muted set-plan-line">${line.replace(/\s*·\s*$/, "")}</p>
        <a class="btn btn-sm btn-primary set-upgrade" id="s-upgrade" href="./activate.html">${UPGRADE_ICON}<span>${escapeHtml(t("set.upgrade"))}</span></a>
      </div>`;
  }

  // ---------- Points (moved here from the profile) ----------
  // Balance, level, where the points came from and where they went, plus four ways on:
  //   Earn points   a points code — the serial of a points package (sql/point_codes.sql) —
  //                 adds the points stored with it, once
  //   Buy points    Patreon (the link is set in Panel > Settings)
  //   Earn prizes   Prize.html, where points enter the prizes
  //   Shop now      Market.html, where points buy the members' products
  const PT_ICONS = {
    earn: '<path d="M3.5 8.5V6A1.5 1.5 0 0 1 5 4.5h14A1.5 1.5 0 0 1 20.5 6v2.5a2.5 2.5 0 0 0 0 5V16a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 16v-2.5a2.5 2.5 0 0 0 0-5z"/><path d="M14 4.5v13" stroke-dasharray="2 2"/><path d="M8 9.5l1 2 2 .3-1.5 1.4.4 2L8 14.2l-1.9 1 .4-2L5 11.8l2-.3z"/>',
    buy: '<circle cx="14.5" cy="9.5" r="5.5"/><path d="M4.5 4v16"/>',
    prizes: '<rect x="3.5" y="8" width="17" height="4.5" rx="1"/><path d="M5 12.5V20.5h14v-8M12 8v12.5"/><path d="M12 8C10.5 4.5 6.5 4 6.5 6.3S9.5 8 12 8zM12 8c1.5-3.5 5.5-4 5.5-1.7S14.5 8 12 8z"/>',
    shop: '<path d="M4.5 8.5h15l-1.2 11a1.6 1.6 0 0 1-1.6 1.5H7.3a1.6 1.6 0 0 1-1.6-1.5z"/><path d="M8.8 8.5V7a3.2 3.2 0 0 1 6.4 0v1.5"/><path d="M9.5 13.5a2.5 2.5 0 0 0 5 0"/>',
  };
  const ptIcon = (k) => `<svg class="pts-act-ico" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PT_ICONS[k]}</svg>`;

  function pointsSpendsHtml(spends) {
    const modeLabel = {
      gift: t("prize.mode.gift"),
      challenge: t("prize.mode.challenge"),
      lottery: t("prize.mode.lottery"),
      claim: t("points.mode.claim"),
      // taken by the prize team when a claim was rejected (sql/prize_claims.sql)
      penalty: t("points.mode.penalty"),
      reset: t("points.mode.reset"),
      // Market.html (sql/market.sql): a purchase, and the points given back (negative amount)
      market: t("mkt.spendMode"),
      market_refund: t("mkt.refundMode"),
      // Dashboard > Withdraw (sql/withdrawals.sql): the points of a request, and the points back
      withdraw: t("wd.spendMode"),
      withdraw_refund: t("wd.refundMode"),
    };
    const rows = spends.rows.map((r) => {
      const when = String(r.created_at || "").slice(0, 10);
      const mode = modeLabel[r.mode] || "";
      const amount = Number(r.amount || 0);
      return `
        <li class="pt-row${amount < 0 ? " pt-row-refund" : ""}">
          <span class="pt-src">
            <b>${escapeHtml(r.prize_title || t("points.unnamedPrize"))}</b>
            <small>${escapeHtml([mode, when].filter(Boolean).join(" · "))}</small>
          </span>
          <span class="pt-pts">${amount < 0 ? `+${-amount}` : `−${amount}`}</span>
        </li>`;
    });
    if (spends.earlier > 0) {
      rows.push(`
        <li class="pt-row">
          <span class="pt-src"><b>${escapeHtml(t("points.earlier"))}</b></span>
          <span class="pt-pts">−${spends.earlier}</span>
        </li>`);
    }
    return rows.length
      ? `<ul class="pt-list">${rows.join("")}</ul>`
      : `<p class="muted">${escapeHtml(t("points.noSpent"))}</p>`;
  }

  function pointCodesHtml(list) {
    if (list === null) return `<p class="muted">${escapeHtml(t("points.codesSetup"))}</p>`;
    if (!list.length) return `<p class="muted">${escapeHtml(t("points.codesNone"))}</p>`;
    return `<ul class="pt-list">${list
      .map(
        (c) => `
        <li class="pt-row">
          <span class="pt-src">
            <b dir="ltr" class="pts-serial">${escapeHtml(c.code)}</b>
            <small>${escapeHtml([c.note, c.used_at ? whenText(Date.parse(c.used_at)) : ""].filter(Boolean).join(" · "))}</small>
          </span>
          <span class="pt-pts">+${Number(c.points || 0)}</span>
        </li>`
      )
      .join("")}</ul>`;
  }

  async function viewPoints(main) {
    main.innerHTML = `
      <p class="eyebrow">${t("dash.nav.points")}</p>
      <h1>${t("points.title")}</h1>
      <p class="muted">${t("points.intro")}</p>
      <div class="pts-top">
        <div class="stat-row pts-stats">
          <div class="stat ov-accent"><b data-pt="available">…</b><span>${t("points.available")}</span></div>
          <div class="stat"><b data-pt="earned">…</b><span>${t("points.earned")}</span></div>
          <div class="stat"><b data-pt="spent">…</b><span>${t("points.spent")}</span></div>
          <div class="stat ov-level" data-pt-level hidden><b><bdi dir="ltr" data-pt="level"></bdi></b><span data-pt="mult"></span></div>
        </div>
        <div class="pts-actions">
          <button class="btn btn-lg btn-primary pts-act" id="pt-earn" type="button">${ptIcon("earn")}<span><b>${t("points.earnBtn")}</b><small>${t("points.earnSub")}</small></span></button>
          <a class="btn btn-lg btn-ghost pts-act" id="pt-buy" href="${escapeHtml(C.PATREON_DEFAULT)}" target="_blank" rel="noopener noreferrer">${ptIcon("buy")}<span><b>${t("points.buyBtn")}</b><small>${t("points.buySub")}</small></span></a>
          <a class="btn btn-lg btn-ghost pts-act" id="pt-prizes" href="./Prize.html">${ptIcon("prizes")}<span><b>${t("points.prizesBtn")}</b><small>${t("points.prizesSub")}</small></span></a>
          <a class="btn btn-lg btn-ghost pts-act" id="pt-shop" href="./Market.html">${ptIcon("shop")}<span><b>${t("points.shopBtn")}</b><small>${t("points.shopSub")}</small></span></a>
        </div>
      </div>
      <div id="pt-body"><p class="muted">${t("points.loading")}</p></div>`;
    C.siteLink("patreon_points").then((url) => {
      main.querySelectorAll("#pt-buy").forEach((a) => { a.href = url; });
    });
    main.querySelector("#pt-earn").onclick = () => openEarnPoints(main);
    await drawPointsBody(main);
  }

  async function drawPointsBody(main) {
    const me = state.member.member_id;
    let mp;
    let spends;
    let codes = null;
    try {
      // the server changes the stored points (codes, videos, minutes): read the row again
      const prof = await supabaseRequest(`/rest/v1/profiles?member_id=eq.${restValue(me)}&select=*`);
      if (prof.ok && Array.isArray(prof.data) && prof.data[0]) state.profile = { ...(state.profile || {}), ...prof.data[0] };
      mp = await C.memberPoints(me, state.profile || {});
      const [sp, hist] = await Promise.all([
        C.memberSpends(me, mp.spent),
        C.rpc("points_code_history", { p_member: me }).catch(() => null),
      ]);
      spends = sp;
      codes = hist?.ok && Array.isArray(hist.data) ? hist.data : null;
    } catch {
      const body = main.querySelector("#pt-body");
      if (body) body.innerHTML = `<p class="empty">${t("points.loadFail")}</p>`;
      return;
    }
    if (!main.isConnected || state.section !== "points") return;
    ["available", "earned", "spent"].forEach((k) => {
      const el = main.querySelector(`[data-pt="${k}"]`);
      if (el) el.textContent = String(Number(mp[k] || 0));
    });
    const lvStat = main.querySelector("[data-pt-level]");
    if (lvStat && mp.levels && mp.level) {
      lvStat.querySelector('[data-pt="level"]').textContent = mp.level.name;
      lvStat.querySelector('[data-pt="mult"]').textContent = t("points.levelMult", { n: mp.level.multiplier });
      lvStat.hidden = false;
    }
    const codeRow = mp.breakdown.find((r) => r.key === "codes");
    main.querySelector("#pt-body").innerHTML = `
      <div class="pts-cols">
        <section class="pt-box">
          <div class="pt-head"><span>${escapeHtml(t("points.earned"))}</span><b class="pt-total">${mp.earned}</b></div>
          ${C.levelHtml(mp)}
          <p class="muted pts-sub">${escapeHtml(t("points.earnedFrom"))}</p>
          <ul class="pt-list">${mp.breakdown.map(C.pointRowHtml).join("")}</ul>
        </section>
        <section class="pt-box">
          <div class="pt-head"><span>${escapeHtml(t("points.spent"))}</span><b class="pt-total">${mp.spent}</b></div>
          <p class="muted pts-sub">${escapeHtml(t("points.spentOn"))}</p>
          ${pointsSpendsHtml(spends)}
        </section>
      </div>
      <section class="pt-box pts-codes" aria-labelledby="pt-codes-h">
        <div class="pt-head"><span id="pt-codes-h">${escapeHtml(t("points.codesTitle"))}</span><b class="pt-total">+${Number(codeRow?.points || 0)}</b></div>
        ${pointCodesHtml(codes)}
      </section>`;
  }

  const POINT_CODE_ERRORS = {
    invalid: "points.err.invalid",
    not_found: "points.err.notFound",
    used: "points.err.used",
    used_mine: "points.err.usedMine",
    other: "points.err.other",
    expired: "points.err.expired",
    locked: "points.err.locked",
    banned: "points.err.banned",
    member: "points.err.member",
  };

  // "Earn points": the serial of a points package; the points stored with it are added.
  function openEarnPoints(main) {
    const ov = document.createElement("div");
    ov.className = "modal-overlay pts-overlay";
    ov.innerHTML = `
      <section class="glass modal-card pts-dlg" role="dialog" aria-modal="true" aria-labelledby="pt-dlg-h" tabindex="-1">
        <div class="pts-dlg-head">
          <span class="pts-dlg-ico">${ptIcon("earn")}</span>
          <h2 id="pt-dlg-h">${t("points.earnTitle")}</h2>
          <button class="pts-x" type="button" data-close aria-label="${escapeHtml(t("common.close"))}">×</button>
        </div>
        <div id="pt-dlg-body">
          <p class="muted">${t("points.earnLead")}</p>
          <form class="stack pts-form" id="pt-form" novalidate>
            <label class="field-label" for="pt-code">${t("points.codeLabel")}</label>
            <input id="pt-code" class="pts-code-input" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="80" placeholder="XXXX-XXXX-XXXX-XXXX" dir="ltr" />
            <div class="form-alert" id="pt-alert" role="alert"></div>
            <button class="btn btn-lg btn-primary" id="pt-submit" type="submit">${t("points.addBtn")}</button>
          </form>
          <p class="muted pts-dlg-foot">${t("points.noCode")} <a id="pt-dlg-buy" href="${escapeHtml(C.PATREON_DEFAULT)}" target="_blank" rel="noopener noreferrer">${t("points.buyBtn")}</a></p>
        </div>
      </section>`;
    const prevFocus = document.activeElement;
    let changed = false;
    const close = () => {
      document.removeEventListener("keydown", onKey);
      ov.remove();
      try { prevFocus?.focus?.(); } catch { /* gone */ }
      if (changed && state.section === "points" && main.isConnected) drawPointsBody(main);
    };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    ov.addEventListener("click", (e) => {
      if (e.target === ov || e.target.closest("[data-close]")) close();
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(ov);
    C.siteLink("patreon_points").then((url) => {
      const a = ov.querySelector("#pt-dlg-buy");
      if (a) a.href = url;
    });
    const input = ov.querySelector("#pt-code");
    const alertBox = ov.querySelector("#pt-alert");
    const showError = (text) => {
      alertBox.className = "form-alert show error";
      alertBox.textContent = text;
      input.setAttribute("aria-invalid", "true");
      input.focus();
    };
    input.focus();
    input.addEventListener("input", () => {
      alertBox.className = "form-alert";
      alertBox.textContent = "";
      input.removeAttribute("aria-invalid");
    });
    ov.querySelector("#pt-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = input.value.trim();
      if (code.replace(/[^A-Za-z0-9]/g, "").length < 4) return showError(t("points.err.invalid"));
      const btn = ov.querySelector("#pt-submit");
      btn.disabled = true;
      btn.textContent = t("points.adding");
      let cc = "";
      try { cc = (await C.detectGeo()) || ""; } catch { cc = ""; }
      const res = await C.rpc("points_code_redeem", { p_member: state.member.member_id, p_code: code, p_country: cc }).catch(() => null);
      btn.disabled = false;
      btn.textContent = t("points.addBtn");
      if (!res) return showError(t("points.err.network"));
      if (!res.ok) {
        const missing = res.status === 404 || ["PGRST202", "42883"].includes(res.data?.code);
        if (missing) console.warn("CineAura: points_code_redeem() is missing — run sql/point_codes.sql in the Supabase SQL editor.");
        return showError(t(missing ? "points.err.setup" : "points.err.network"));
      }
      const r = res.data || {};
      if (!r.ok) {
        // an exclusive code of Panel > Packages this account does not meet (sql/point_codes.sql _pack_aud_ok)
        let text = r.reason === "audience"
          ? t(`pack.no.${["membership", "country", "language", "level", "age"].includes(r.why) ? r.why : "fit"}`)
          : t(POINT_CODE_ERRORS[r.reason] || "points.err.network");
        if (r.reason === "not_found" && Number.isFinite(Number(r.left)) && Number(r.left) <= 3) text += ` ${t("points.err.left", { n: Number(r.left) })}`;
        return showError(text);
      }
      changed = true;
      ov.querySelector("#pt-dlg-body").innerHTML = `
        <div class="pts-ok" role="status">
          <div class="pts-ok-num">+${Number(r.points || 0)}</div>
          <p><b>${t("points.added", { n: Number(r.points || 0) })}</b></p>
          ${r.level_up ? `<p class="pts-ok-level">${t("points.newLevel", { level: escapeHtml(r.level_name || ""), n: Number(r.multiplier || 1) })}</p>` : ""}
          <div class="pts-ok-actions">
            <button class="btn btn-lg btn-primary" type="button" data-close>${t("points.done")}</button>
            <a class="btn btn-lg btn-ghost" href="./Prize.html">${t("points.prizesBtn")}</a>
          </div>
        </div>`;
      ov.querySelector(".pts-ok [data-close]").focus();
      toast(t("points.added", { n: Number(r.points || 0) }));
    });
  }

  // ---------- Withdraw: points exchanged for real money (js/withdraw.js, sql/withdrawals.sql) ----------
  // LV3 and an account old enough for its membership (Free 12 months, Silver 6, Gold 3, Diamond 1);
  // a bank transfer or a money transfer agency such as Western Union.
  async function viewWithdraw(main) {
    const W = window.CineAuraWithdraw;
    if (!W) {
      main.innerHTML = `<p class="eyebrow">${t("dash.nav.withdraw")}</p><h1>${t("wd.title")}</h1><div class="form-alert show warn">${t("wd.loadFail")}</div>`;
      return;
    }
    await W.view(main, { member: state.member, current: () => state.section === "withdraw" && main.isConnected });
  }

  // ---- Settings > Profile: the delivery address of the Market (sql/market.sql market_addresses).
  // Each physical product the member buys gets it by itself once the order is sold; only the
  // sellers of their orders see it. dashboard.html#address opens it.
  function addressBoxHtml() {
    const f = (id, key, attrs) =>
      `<input id="${id}" ${attrs} placeholder="${escapeHtml(t(key))} *" aria-label="${escapeHtml(t(key))}" />`;
    return `
      <section class="set-site stack dash-addr" id="s-addr" aria-labelledby="s-addr-title" hidden>
        <div>
          <h2 class="sset-lbl" id="s-addr-title">${t("dash.addr.title")}</h2>
          <p class="sset-hint">${t("dash.addr.hint")}</p>
        </div>
        <div class="form-row">
          ${f("s-addr-name", "dash.addr.name", 'maxlength="80" autocomplete="name" dir="auto"')}
          ${f("s-addr-phone", "dash.addr.phone", 'maxlength="30" autocomplete="tel" inputmode="tel" dir="ltr"')}
        </div>
        <div class="form-row">
          ${f("s-addr-city", "dash.addr.city", 'maxlength="80" autocomplete="address-level2" dir="auto"')}
          ${f("s-addr-line", "dash.addr.line", 'maxlength="200" autocomplete="street-address" dir="auto"')}
        </div>
        <p class="sset-hint" id="s-addr-state" aria-live="polite"></p>
        <div class="dash-addr-acts">
          <button class="btn btn-sm btn-primary" id="s-addr-save" type="button">${t("dash.addr.save")}</button>
          <button class="btn btn-sm btn-ghost" id="s-addr-del" type="button" hidden>${t("dash.addr.remove")}</button>
        </div>
      </section>`;
  }

  function wireAddressBox(main, m) {
    const box = main.querySelector("#s-addr");
    if (!box) return;
    const el = (k) => box.querySelector(`#s-addr-${k}`);
    const stateEl = el("state");
    const digits = (v) => String(v || "")
      .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x660))
      .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x6f0));
    const phoneOk = (v) => {
      const n = v.replace(/\D/g, "").length;
      return /^\+?[0-9 ()./-]{5,30}$/.test(v) && n >= 5 && n <= 20;
    };
    const show = (a) => {
      ["name", "phone", "city", "line"].forEach((k) => { el(k).value = a?.[k] || ""; });
      el("del").hidden = !a;
      stateEl.textContent = a ? t("dash.addr.since", { date: C.formatDate(a.updated_at) }) : t("dash.addr.none");
    };
    C.rpc("market_address", { p_member: m.member_id })
      .then((r) => {
        if (!r.ok || !r.data?.ok) return; // sql/market.sql not run yet: no box
        box.hidden = false;
        show(r.data.address);
        if (location.hash === "#address") {
          box.scrollIntoView({ block: "center" });
          box.querySelector("input:placeholder-shown")?.focus();
        }
      })
      .catch(() => {});
    el("save").onclick = async () => {
      const a = {
        name: el("name").value.trim(),
        phone: digits(el("phone").value).trim(),
        city: el("city").value.trim(),
        line: el("line").value.trim(),
      };
      const bad = (a.name.length < 2 && "name") || (!phoneOk(a.phone) && "phone") || (a.city.length < 2 && "city") || (a.line.length < 4 && "line");
      if (bad) {
        stateEl.textContent = t(bad === "phone" ? "dash.addr.errPhone" : "dash.addr.errFields");
        el(bad).focus();
        return;
      }
      el("save").disabled = true;
      const r = await C.rpc("market_address_save", { p_member: m.member_id, p_address: a }).catch(() => null);
      el("save").disabled = false;
      if (!r?.ok || !r.data?.ok) {
        const why = r?.data?.reason;
        stateEl.textContent = t(why === "phone" ? "dash.addr.errPhone" : why === "address" ? "dash.addr.errFields" : "dash.addr.failed");
        return;
      }
      show(r.data.address);
      toast(Number(r.data.orders) > 0 ? t("dash.addr.savedOrders", { n: r.data.orders }) : t("dash.addr.saved"));
    };
    el("del").onclick = async () => {
      if (!confirm(t("dash.addr.confirmRemove"))) return;
      const r = await C.rpc("market_address_save", { p_member: m.member_id, p_address: null }).catch(() => null);
      if (!r?.ok || !r.data?.ok) return toast(t("dash.addr.failed"));
      show(null);
      toast(t("dash.addr.removed"));
    };
  }

  async function viewSettings(main) {
    const m = state.member;
    const p = state.profile || {};
    const left = m.membership_expires_at
      ? Math.max(0, Math.ceil((new Date(m.membership_expires_at) - Date.now()) / 86400000))
      : "—";
    main.innerHTML = `
      <p class="eyebrow">${t("dash.settings.eyebrow")}</p>
      <h1>${t("dash.settings.title")}</h1>
      <div class="tabs follow-tabs" role="tablist" data-tabbar="1">
        <button type="button" role="tab" class="follow-tab" data-dtab="set0">${t("dash.tab.profile")}</button>
        <button type="button" role="tab" class="follow-tab" data-dtab="set1">${t("dash.tab.appearance")}</button>
        <button type="button" role="tab" class="follow-tab" data-dtab="set2">${t("dash.tab.account")}</button>
      </div>
      <div class="stack">
        <div class="follow-pane stack" data-dpane="set0">
          ${C.avatarFieldHtml({ id: "s-avatar", value: p.avatar_url || "", name: m.username, memberId: m.member_id })}
          <input id="s-name" value="${escapeHtml(m.full_name||"")}" placeholder="${t("common.displayName")}" />
          <textarea id="s-bio" placeholder="${t("common.bio")}">${escapeHtml(p.bio||"")}</textarea>
          <div class="form-row">
            <input id="s-region" value="${escapeHtml(p.region||"")}" placeholder="${t("common.region")}" />
            <input id="s-country" value="${escapeHtml(p.country||m.country||"")}" placeholder="${t("common.country")}" />
          </div>
          ${addressBoxHtml()}
        </div>
        <div class="follow-pane stack" data-dpane="set1">
          <p class="muted">${t("dash.settings.appearance")}</p>
          <p class="muted">${t("dash.settings.langHint")}</p>
          <div class="form-row">
            <select id="s-theme">
              <option value="night">${t("dash.settings.theme")}</option>
              <option value="day">${t("dash.settings.day")}</option>
            </select>
            <select id="s-lang">
              <option value="en">${t("lang.en")}</option>
              <option value="ar">${t("lang.ar")}</option>
              <option value="fr">${t("lang.fr")}</option>
              <option value="de">${t("lang.de")}</option>
              <option value="es">${t("lang.es")}</option>
              <option value="nl">${t("lang.nl")}</option>
              <option value="it">${t("lang.it")}</option>
            </select>
          </div>
          <div class="set-site stack">
            <label class="sset-lbl" for="s-site-country">${t("set.country")}</label>
            <select id="s-site-country"></select>
            <p class="sset-hint" id="s-geo-hint" aria-live="polite"></p>
            <button class="sset-link" id="s-redetect" type="button">${t("set.detect")}</button>
          </div>
          <div class="set-site">
            <div class="sset-switch-line">
              <div class="sset-switch-text">
                <span class="sset-lbl" id="s-adfree-lbl">${t("set.adfree")}</span>
                <p class="sset-hint">${t("set.adfreeP")}</p>
                <p class="sset-hint sset-state" id="s-adfree-state"></p>
              </div>
              <label class="sset-switch">
                <input type="checkbox" id="s-adfree" role="switch" aria-labelledby="s-adfree-lbl" disabled />
                <span class="sset-track" aria-hidden="true"></span>
              </label>
            </div>
          </div>
        </div>
        <div class="follow-pane stack" data-dpane="set2">
          ${planBoxHtml(m, left)}
          <input id="s-email" value="${escapeHtml(m.email||"")}" placeholder="${t("common.email")}" />
          <input id="s-pass" type="password" placeholder="${t("common.newPassword")}" />
          <p class="muted">${t("common.recoveryCode")}: <strong id="s-rec">${escapeHtml(m.recovery_code||t("common.notStored"))}</strong>
            <button class="btn btn-sm btn-ghost" id="copy-rec" type="button">${t("common.copy")}</button></p>
        </div>
        <button class="btn btn-lg btn-primary" id="s-save" type="button">${t("dash.settings.save")}</button>
      </div>`;
    wireTabs(main, "set");
    wireAddressBox(main, m);
    // An uploaded photo replaces the old file at once, so the profile gets its link at once too.
    C.wireAvatarField(main, {
      memberId: m.member_id,
      name: m.username,
      save: async (url) => {
        const res = await writeProfileSettings({ avatar_url: url });
        if (!res.ok) return false;
        if (state.profile) state.profile.avatar_url = url;
        C.refreshAvatar(m.member_id, url);
        return true;
      },
    });
    $("#s-theme").value = getTheme();
    $("#s-lang").value = getLang();
    $("#s-theme").onchange = () => saveAppearancePreference("theme", $("#s-theme").value);
    $("#s-lang").onchange = () => saveAppearancePreference("language", $("#s-lang").value);
    wireSiteSettings(main);
    $("#copy-rec").onclick = async () => {
      if (!m.recovery_code) return toast(t("dash.noRec"));
      await navigator.clipboard.writeText(m.recovery_code);
      toast(t("dash.recCopied"));
    };
    $("#s-save").onclick = async () => {
      const body = {
        bio: $("#s-bio").value,
        avatar_url: $("#s-avatar").value.trim(),
        theme: $("#s-theme").value,
        language: $("#s-lang").value,
        region: $("#s-region").value.trim(),
        country: $("#s-country").value.trim(),
      };
      const profileSave = writeProfileSettings(body);
      const mem = { full_name: $("#s-name").value.trim(), email: $("#s-email").value.trim().toLowerCase() };
      const pass = $("#s-pass").value;
      if (pass.length >= 8) mem.password = await sha256(pass);
      const [profileResult, memberResult] = await Promise.all([
        profileSave,
        supabaseRequest(`/rest/v1/members?member_id=eq.${restValue(m.member_id)}`, {
          method: "PATCH",
          body: JSON.stringify(mem),
        }).catch(() => ({ ok: false, status: 0 })),
      ]);
      if (profileResult.ok) {
        Object.assign(state.profile, body);
        C.refreshAvatar(m.member_id, body.avatar_url);
      }
      if (memberResult.ok) Object.assign(state.member, mem);
      applyPrefs({ language: body.language, theme: body.theme, persist: true });
      toast(profileResult.ok && memberResult.ok ? t("dash.settings.saved") : t("dash.settings.saveFailed"));
    };
  }

  // "points" (Earn points / Buy points / Earn prizes / Shop now, the sources and the spends) moved here from the profile;
  // "withdraw": points exchanged for money (js/withdraw.js, sql/withdrawals.sql)
  const SECTIONS = ["overview","points","withdraw","playlists","links","reports","codes","iptv","views","analytics","prizes","history","settings"];
  // dashboard.html#claims: Prizes > Prize claims (where the claim notifications lead)
  // dashboard.html#devices: Codes > Linked devices (named by the watch page)
  // dashboard.html#iptv-lists: IPTV > Your lists
  const HASH_ALIASES = {
    claims: { section: "prizes", tabs: { prizeModes: "prize-claims" } },
    devices: { section: "codes", tabs: { codes: "codes-devices" } },
    // dashboard.html#iptv-lists: IPTV > Your lists (the IPTV lists the member published)
    "iptv-lists": { section: "iptv", tabs: { iptv: "iptv-lists" } },
    // dashboard.html#address: Settings > Profile, the delivery address of the Market
    address: { section: "settings", tabs: { set: "set0" } },
  };

  function routeOf(hash) {
    let key = "";
    try { key = decodeURIComponent(String(hash || "").replace(/^#/, "")); } catch { return null; }
    if (SECTIONS.includes(key)) return { key, section: key };
    if (HASH_ALIASES[key]) return { key, ...HASH_ALIASES[key] };
    return null;
  }

  function applyRoute(route) {
    state.section = route.section;
    state.openPlaylist = null;
    if (route.tabs) state.tabs = { ...(state.tabs || {}), ...route.tabs };
  }

  // A link to another section of this page (a notification in the bell while
  // the dashboard is open) switches the section without a reload.
  window.addEventListener("hashchange", () => {
    const route = routeOf(location.hash);
    if (!route || !state.member || !$("#dash-main")) return;
    applyRoute(route);
    renderShell();
  });

  // Who sees the Panel link: staff by their member account (staff.member_id) as
  // the Panel's settings allow (admins / moderators / members; the Super Admin
  // always), and whoever holds a valid Panel session in this browser — a staff
  // row without a member id (the Super Admin of sql/panel.sql) or with another one.
  async function panelSessionRole() {
    let token = "";
    try {
      token = JSON.parse(sessionStorage.getItem("cineaura_panel") || localStorage.getItem("cineaura_panel") || "null")?.token || "";
    } catch {
      token = "";
    }
    if (!token) return "";
    const res = await C.rpc("staff_session", { p_token: token }).catch(() => null);
    return res?.ok && res.data?.role ? String(res.data.role) : "";
  }

  async function computePanelVisible() {
    const [staffRes, setRes] = await Promise.all([
      supabaseRequest(`/rest/v1/staff?member_id=eq.${restValue(state.member.member_id)}&select=role`),
      supabaseRequest("/rest/v1/panel_settings?id=eq.1&select=*"),
    ]);
    let role = (Array.isArray(staffRes.data) && staffRes.data[0]?.role) || "";
    if (!role) role = await panelSessionRole();
    const ps = (Array.isArray(setRes.data) && setRes.data[0]) || { show_admin: true, show_moderator: true, show_member: false };
    return (
      role === "super" ||
      (role === "admin" && ps.show_admin !== false) ||
      (role === "moderator" && ps.show_moderator !== false) ||
      (!role && ps.show_member === true)
    );
  }

  // The menu follows changes made meanwhile (a staff account removed and added
  // again in the Panel, its settings): checked again when the page comes back
  // into view, and when the browser restores it from its back/forward cache.
  let menuCheckAt = 0;
  async function refreshMenus(force = false) {
    if (!state.member || !$("#dash-root .side-nav")) return;
    if (!force && Date.now() - menuCheckAt < 10000) return;
    menuCheckAt = Date.now();
    const visible = await computePanelVisible().catch(() => state.panelVisible);
    if (visible === state.panelVisible) return;
    state.panelVisible = visible;
    const nav = $("#dash-root .side-nav");
    if (!nav) return;
    nav.querySelector("[data-panel-link]")?.remove();
    if (visible) nav.insertAdjacentHTML("beforeend", `<a href="./Panel.html" data-panel-link>${C.navIcon("panel")}<span>${t("nav.panel")}</span></a>`);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshMenus();
  });
  window.addEventListener("focus", () => refreshMenus());
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) refreshMenus(true);
  });

  async function boot() {
    setupChrome();
    const route = routeOf(location.hash);
    if (route) applyRoute(route);
    // signing in brings the member back here, to the section in the address
    // (dashboard.html#iptv: "Find them in Dashboard → IPTV" of the premium channel list)
    const signin = `<a class="btn btn-lg btn-primary" href="./login.html?next=${encodeURIComponent(
      route ? `dashboard.html#${route.key}` : "dashboard.html"
    )}">${t("common.signin")}</a>`;
    state.session = getSession();
    if (!state.session?.member_id) {
      $("#dash-root").innerHTML = gate(t("dash.gate.title"), t("dash.gate.text"), signin);
      return;
    }
    // an account past its 30 days (not activated / re-activated) is banned first
    // (sql/account_deadline.sql); the answer gives the day of the ban
    const acct = await C.accountCheck({ fresh: true }).catch(() => null);
    state.member = await loadMember(state.session.member_id);
    if (!state.member) {
      $("#dash-root").innerHTML = gate(t("dash.gate.title"), t("dash.loadFail"), signin);
      return;
    }
    const sanRes = await supabaseRequest(
      `/rest/v1/sanctions?member_id=eq.${restValue(state.member.member_id)}&select=*`
    );
    state.sanctions = sanRes.ok && Array.isArray(sanRes.data) ? sanRes.data[0] : null;
    if (state.sanctions?.temp_until && Date.parse(state.sanctions.temp_until) > Date.now()) {
      $("#dash-root").innerHTML = gate(
        t("dash.bannedTitle"),
        t("panel.tempUntil", { date: String(state.sanctions.temp_until).slice(0, 16).replace("T", " ") }),
        `<button class="btn btn-lg btn-danger" id="gate-logout" type="button">${t("nav.logout")}</button>`
      );
      $("#gate-logout").onclick = () => { logout(); location.href = "./"; };
      return;
    }
    state.panelVisible = await computePanelVisible().catch(() => false);
    menuCheckAt = Date.now();
    const status = normalizeAccountStatus(state.member.status);
    if (status === "banned") {
      const why = C.accountBanText(state.member.ban_reason);
      $("#dash-root").innerHTML = gate(
        t("dash.bannedTitle"),
        why ? escapeHtml(why) : t("dash.bannedText"),
        `<button class="btn btn-lg btn-danger" id="gate-logout" type="button">${t("nav.logout")}</button>`
      );
      $("#gate-logout").onclick = () => { logout(); location.href = "./"; };
      return;
    }
    if (status === "disabled") {
      const due = C.accountDeadlineText(acct, "gate");
      $("#dash-root").innerHTML = gate(
        t("dash.disabledTitle"),
        t("dash.disabledText"),
        `<a class="btn btn-lg btn-primary" href="./activate.html">${t("dash.activate")}</a>`,
        due ? `<p class="acct-gate-due" role="status">${due}</p>` : ""
      );
      if (due) document.getElementById("acct-due")?.remove(); // the gate says it already
      return;
    }
    await ensureProfile(state.member);
    applyPrefs({
      language: state.profile?.language,
      theme: state.profile?.theme,
      persist: true,
    });
    await ensurePlaylists(state.member);
    await syncWatchMinutes();
    renderShell();
  }

  viewLinks = tabbed(viewLinks, "links", { first: () => t("dash.addLink") });
  viewReports = tabbed(viewReports, "reports");
  viewHistory = tabbed(viewHistory, "history");

  document.addEventListener("DOMContentLoaded", boot);
})();
