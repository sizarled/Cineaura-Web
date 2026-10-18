(() => {
  const {
    $,
    $$,
    setupChrome,
    getSession,
    toast,
    supabaseRequest: sbRequest,
    sessionWriteBlocked,
    restValue,
    escapeHtml,
    initialsAvatar,
    avatarUrlFor,
    avatarImg,
    primeAvatars,
    hydrateAvatars,
    profilesByIds,
    fetchStaff,
    notifyFollowers,
    tmdb,
    imgUrl,
    watchHref,
    personHref,
    personCredits,
    profileHref: sharedProfileHref,
    postHref: sharedPostHref,
    shareRowHtml,
    trackImpressions,
    t,
    tr,
    translateDom,
    getLocale,
    memberPoints,
  } = window.CineAura;

  // Reads always go through; writes need a live session. A member who signed out
  // (see the signed-out gate in common.js) cannot post, vote, comment, follow,
  // block, message or change settings — the request never leaves the page.
  function supabaseRequest(path, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    if (method !== "GET" && !getSession()?.member_id) {
      if (typeof sessionWriteBlocked === "function") sessionWriteBlocked();
      else toast(t("auth.gate.blocked"));
      return Promise.resolve({ ok: false, status: 401, data: null, blocked: true });
    }
    return sbRequest(path, options);
  }

  const PARTIAL_FEATURES = [
    { id: "updates", labelKey: "prof.feat.updates" },
    { id: "messages", labelKey: "prof.feat.messages" },
    { id: "links", labelKey: "prof.feat.links" },
    { id: "playlists", labelKey: "prof.feat.playlists" },
  ];

  const state = {
    session: null,
    me: null,
    host: null,
    hostMember: null,
    isOwner: false,
    section: "home",
    homeTab: "activity",
    followRow: null,
    followTab: "sent",
    blockRow: null,
    notes: [],
    postCache: new Map(),
    draft: null,
    ownPoints: null, // points the signed-in member can spend, once counted
    ownPointsReq: null,
    pc: null, // the Content tab (pcState)
  };

  document.addEventListener("cineaura:prefs", () => {
    if (state.hostMember && document.querySelector("#prof-root .prof-layout")) renderShell();
  });

  const uid = (p) => `${p}${Math.floor(100000000 + Math.random() * 900000000)}`;

  function ageOf(birth) {
    if (!birth) return null;
    const d = new Date(birth);
    if (Number.isNaN(d.getTime())) return null;
    return Math.max(0, Math.floor((Date.now() - d.getTime()) / (365.25 * 86400000)));
  }

  // Calendar age of the account: whole years, months and days since it was
  // created. A month is complete once its day comes round again; a day that the
  // month does not have (31 January -> 28 February) counts as that month's last day.
  function daysInMonth(year, month) {
    return new Date(year, month + 1, 0).getDate();
  }

  function accountAge(createdAt, now = new Date()) {
    if (!createdAt) return null;
    const start = new Date(createdAt);
    if (Number.isNaN(start.getTime())) return null;
    // The k-th monthly anniversary of the account.
    const anniversary = (k) => {
      const index = start.getMonth() + k;
      const year = start.getFullYear() + Math.floor(index / 12);
      const month = ((index % 12) + 12) % 12;
      const day = Math.min(start.getDate(), daysInMonth(year, month));
      return new Date(
        year,
        month,
        day,
        start.getHours(),
        start.getMinutes(),
        start.getSeconds(),
        start.getMilliseconds()
      );
    };
    // The calendar month difference is exact or one too high (the anniversary
    // day may still be ahead in the current month), so one step back is enough.
    let months = Math.max(0, (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth()));
    while (months > 0 && anniversary(months) > now) months -= 1;
    const days = Math.max(0, Math.floor((now - anniversary(months)) / 86400000));
    return { years: Math.floor(months / 12), months: months % 12, days };
  }

  // "1 year · 3 months · 12 days" in the page language. Intl writes the plural
  // forms itself (Arabic: سنة، سنتان، 3 سنوات …) and the digits stay western.
  function accountAgeText(age) {
    if (!age) return "—";
    const unit = (n, name) => {
      try {
        return new Intl.NumberFormat(getLocale(), {
          style: "unit",
          unit: name,
          unitDisplay: "long",
          numberingSystem: "latn",
        }).format(n);
      } catch {
        return `${n} ${name}${n === 1 ? "" : "s"}`;
      }
    };
    return [unit(age.years, "year"), unit(age.months, "month"), unit(age.days, "day")].join(" · ");
  }

  // Only the signed-in member sees these two numbers: the points they can spend
  // and how long the account has existed. The points figure is filled in later.
  function ownStatsHtml() {
    const age = accountAge(state.hostMember?.created_at);
    return `
      <div class="stat-row prof-stats">
        <a class="stat prof-stat-link" href="./dashboard.html#points" title="${escapeHtml(t("dash.nav.points"))}">
          <b data-own-points>${escapeHtml(state.ownPoints ?? "…")}</b>
          <span>${escapeHtml(t("prof.pointsAvail"))}</span>
        </a>
        <div class="stat">
          <b class="prof-age">${escapeHtml(accountAgeText(age))}</b>
          <span>${escapeHtml(t("prof.accountAge"))}</span>
        </div>
        <div class="stat ov-level" data-own-level hidden>
          <b><bdi dir="ltr" data-lv-name></bdi></b>
          <span data-lv-mult></span>
        </div>
      </div>`;
  }

  // The points of the member whose profile this is, counted once per page load:
  // their level (LV0 … LV Max, sql/point_levels.sql) for every visitor, and for
  // the owner also the points they can spend (earned minus spent).
  function hostPoints() {
    const id = state.hostMember?.member_id;
    if (!id) return Promise.resolve(null);
    if (state.hostPointsFor !== id) {
      state.hostPointsFor = id;
      state.hostPointsReq = memberPoints(id, state.host || {}).catch(() => null);
    }
    return state.hostPointsReq;
  }

  function paintLevel(mp) {
    if (!mp?.levels || !mp.level) return;
    const mult = t("points.levelMult", { n: mp.level.multiplier });
    document.querySelectorAll("[data-prof-level]").forEach((badge) => {
      badge.textContent = mp.level.name;
      badge.title = `${t("points.colLevel")} · ${mult}`;
      badge.setAttribute("aria-label", `${t("points.colLevel")} ${mp.level.name} · ${mult}`);
      badge.hidden = false;
    });
    const stat = document.querySelector("[data-own-level]");
    if (stat) {
      stat.querySelector("[data-lv-name]").textContent = mp.level.name;
      stat.querySelector("[data-lv-mult]").textContent = mult;
      stat.hidden = false;
    }
  }

  function loadHostLevel() {
    hostPoints().then((mp) => {
      if (mp) paintLevel(mp);
    });
  }

  function loadOwnPoints() {
    if (!state.isOwner || !state.hostMember?.member_id) return;
    hostPoints().then((mp) => {
      state.ownPoints = mp ? String(mp.available) : "—";
      const el = document.querySelector("[data-own-points]");
      if (el) el.textContent = state.ownPoints;
    });
  }

  function avatarOf(p, name) {
    const who = name || p?.username || "";
    return p?.avatar_url || avatarUrlFor(p?.member_id, who) || initialsAvatar(who || "CA");
  }

  function avatarTag(p, name) {
    const who = name || p?.username || "";
    return `<img src="${escapeHtml(avatarOf(p, who))}" alt="" data-avatar-for="${escapeHtml(p?.member_id || "")}" data-avatar-name="${escapeHtml(who.replace(/^@/, ""))}" />`;
  }

  function profileHref(username) {
    if (typeof sharedProfileHref === "function") return sharedProfileHref(username);
    return `./Profile.html?@${encodeURIComponent(username)}`;
  }

  // Every post gets its own link, so it can be shared and opened on its own:
  // ./Profile.html?post=P123456789
  function postHref(post) {
    const id = typeof post === "string" ? post : post?.post_id || "";
    if (typeof sharedPostHref === "function") return sharedPostHref(id);
    return `./Profile.html?post=${encodeURIComponent(id)}`;
  }

  // The caption the networks receive when a post is shared.
  function postShareText(p) {
    const title = String(p?.title || "").trim();
    const owner = String(p?.owner_username || "").replace(/^@/, "");
    return `«${title}» — @${owner} · CineAura`;
  }

  // A username written in the link itself: "?@alice" or "?username=alice".
  function explicitUsername() {
    const q = new URLSearchParams(location.search);
    const named = q.get("username") || q.get("@");
    if (named) return named.replace(/^@/, "");
    const raw = decodeURIComponent(location.search.slice(1));
    return raw.startsWith("@") ? raw.slice(1).split("&")[0] : "";
  }

  function parseHostName() {
    const named = explicitUsername();
    if (named) return named;
    const raw = decodeURIComponent(location.search.slice(1));
    // "?post=P123" opens one shared post: its owner comes from the post row, so
    // the query must not be mistaken for a username.
    if (raw && !raw.startsWith("post=")) return raw.replace(/^@/, "").split("&")[0];
    return getSession()?.username || "";
  }

  // The post a shared link points at ("./Profile.html?post=P123456789").
  function sharedPostId() {
    return new URLSearchParams(location.search).get("post") || "";
  }

  async function loadByUsername(username) {
    const p = await supabaseRequest(
      `/rest/v1/profiles?username=eq.${restValue(username)}&select=*`
    );
    const profile = p.ok && p.data?.[0];
    const m = await supabaseRequest(
      `/rest/v1/members?username=eq.${restValue(username)}&select=member_id,username,full_name,gender,birth_date,country,status,created_at`
    );
    const member = m.ok && m.data?.[0];
    return { profile, member };
  }

  async function loadMe() {
    const s = getSession();
    if (!s?.member_id) return null;
    const p = await supabaseRequest(
      `/rest/v1/profiles?member_id=eq.${restValue(s.member_id)}&select=*`
    );
    const m = await supabaseRequest(
      `/rest/v1/members?member_id=eq.${restValue(s.member_id)}&select=member_id,username,full_name,gender,birth_date,country,status`
    );
    return {
      session: s,
      profile: p.data?.[0] || null,
      member: m.data?.[0] || { member_id: s.member_id, username: s.username },
    };
  }

  async function notify(memberId, payload) {
    if (!memberId) return;
    await supabaseRequest("/rest/v1/notifications", {
      method: "POST",
      body: JSON.stringify({ member_id: memberId, ...payload }),
    });
  }

  // Same notification, but one per (sender + kind + link): repeated votes update
  // the existing row instead of stacking a new one every click.
  async function notifyOnce(memberId, payload) {
    if (!memberId) return;
    const q = [
      `member_id=eq.${restValue(memberId)}`,
      `from_id=eq.${restValue(payload.from_id || "")}`,
      `kind=eq.${restValue(payload.kind || "info")}`,
      payload.href ? `href=eq.${restValue(payload.href)}` : "",
      "select=id",
    ]
      .filter(Boolean)
      .join("&");
    try {
      const found = await supabaseRequest(`/rest/v1/notifications?${q}`);
      const row = Array.isArray(found.data) ? found.data[0] : null;
      if (row?.id) {
        await supabaseRequest(`/rest/v1/notifications?id=eq.${row.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            title: payload.title,
            body: payload.body,
            read: false,
            created_at: new Date().toISOString(),
          }),
        });
        return;
      }
    } catch {
      /* fall through to a plain insert */
    }
    await notify(memberId, payload);
  }

  // Where a post lives: its playlist page, otherwise the author's profile.
  function postDest(p, fallbackUsername) {
    if (!p) return profileHref(fallbackUsername);
    if (p.playlist_id) return `./Playlist.html?ID=${encodeURIComponent(p.playlist_id)}`;
    return profileHref(p.owner_username || fallbackUsername);
  }

  function postNoun(kind) {
    if (kind === "playlist") return t("prof.updNounPlaylist");
    if (kind === "review") return t("prof.updNounReview");
    if (kind === "reclist") return t("prof.updNounRecList");
    return t("prof.updNounRec");
  }

  // One short line for an updates row: "@a recommends the recommendation «X» by
  // @b". links=false renders it as plain text for the notification bell.
  function updateLine(r, p, opts = {}) {
    const links = opts.links !== false;
    const actorName = String(r.actor_username || "").replace(/^@/, "");
    const title = escapeHtml(p?.title || p?.post_id || r.post_id || "");
    const ownerName = String(p?.owner_username || r.target_username || "").replace(/^@/, "");
    const actor = links
      ? `<a href="${profileHref(actorName)}"><strong>@${escapeHtml(actorName)}</strong></a>`
      : `@${escapeHtml(actorName)}`;
    const owner = links
      ? `<a href="${profileHref(ownerName)}">@${escapeHtml(ownerName)}</a>`
      : `@${escapeHtml(ownerName)}`;
    const post = !p
      ? `<span class="muted">${title}</span>`
      : links
        ? `<a href="${postDest(p, actorName)}"><strong>${title}</strong></a>`
        : `«${title}»`;
    const noun = postNoun(p?.kind);
    if (r.kind === "vote_up" || r.kind === "vote_down") {
      return t("prof.updLineVote", {
        actor,
        verb: t(r.kind === "vote_down" ? "prof.updDown" : "prof.updUp"),
        noun,
        post,
        owner,
      });
    }
    return t("prof.updLinePost", { actor, noun, post });
  }

  async function recount(memberId) {
    const fol = await supabaseRequest(
      `/rest/v1/follows?following_id=eq.${restValue(memberId)}&status=eq.accepted&select=id`
    );
    const fing = await supabaseRequest(
      `/rest/v1/follows?follower_id=eq.${restValue(memberId)}&status=eq.accepted&select=id`
    );
    await supabaseRequest(`/rest/v1/profiles?member_id=eq.${restValue(memberId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        followers: Array.isArray(fol.data) ? fol.data.length : 0,
        following: Array.isArray(fing.data) ? fing.data.length : 0,
      }),
    });
  }

  function blockedFeature(feature) {
    const b = state.blockRow;
    if (!b) return false;
    if (b.kind === "full") return true;
    return String(b.features || "")
      .split(",")
      .map((s) => s.trim())
      .includes(feature);
  }

  function theyBlockedMe() {
    return state.theirBlock;
  }

  async function loadRelations() {
    state.followRow = null;
    state.blockRow = null;
    state.theirBlock = null;
    const me = state.me?.member?.member_id;
    const host = state.hostMember?.member_id;
    if (!me || !host || me === host) return;
    const f = await supabaseRequest(
      `/rest/v1/follows?follower_id=eq.${restValue(me)}&following_id=eq.${restValue(host)}&select=*`
    );
    state.followRow = f.data?.[0] || null;
    const b = await supabaseRequest(
      `/rest/v1/blocks?blocker_id=eq.${restValue(me)}&blocked_id=eq.${restValue(host)}&select=*`
    );
    state.blockRow = b.data?.[0] || null;
    const tb = await supabaseRequest(
      `/rest/v1/blocks?blocker_id=eq.${restValue(host)}&blocked_id=eq.${restValue(me)}&select=*`
    );
    state.theirBlock = tb.data?.[0] || null;
  }

  function tmdbIdsFromText(value) {
    return String(value || "")
      .split(/[\n,;]+/)
      .map((s) => parseTmdb(s.trim()))
      .filter(Boolean)
      .map((r) => r.id);
  }

  // Age / language / country / watch-history filters an author can put on a
  // post. Shared by the profile wall and the updates feed.
  function passesAudience(post, watchedSet) {
    const me = state.me?.member;
    if (!me) return false;
    const age = ageOf(me.birth_date);
    if (post.min_age && age != null && age < post.min_age) return false;
    if (post.max_age && age != null && age > post.max_age) return false;
    const langs = String(post.languages || "")
      .split(/[,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const mine = String(state.me?.profile?.language || "").toLowerCase();
    if (langs.length && !langs.includes("all") && mine && !langs.includes(mine)) return false;
    const countries = String(post.countries || "")
      .split(/[,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (countries.length && !countries.includes(String(me.country || "").toLowerCase())) return false;
    const needed = [
      ...tmdbIdsFromText(post.watched_tmdb),
      ...tmdbIdsFromText(post.titles),
    ];
    if (needed.length && watchedSet) {
      if (!needed.every((id) => watchedSet.has(Number(id)))) return false;
    }
    return true;
  }

  // A post on the profile wall: the wall owner is the author.
  function canSeePost(post, accessNames, watchedSet) {
    if (state.isOwner) return true;
    const vis = post.visibility || "public";
    if (vis === "public") return true;
    if (vis === "private") {
      const u = String(state.me?.member?.username || "").toLowerCase();
      return accessNames.map((x) => String(x).toLowerCase()).includes(u);
    }
    if (post.require_followers && state.followRow?.status !== "accepted") return false;
    return passesAudience(post, watchedSet);
  }

  // A post inside the updates feed: the author is somebody I follow, so the
  // followers-only rule is already satisfied by the follow itself.
  function canSeeFeedPost(post, accessNames, watchedSet) {
    const me = state.me?.member;
    if (me && post.owner_id === me.member_id) return true;
    const vis = post.visibility || "public";
    if (vis === "public") return true;
    if (vis === "private") {
      const u = String(me?.username || "").toLowerCase();
      return accessNames.map((x) => String(x).toLowerCase()).includes(u);
    }
    if (!me) return false;
    return passesAudience(post, watchedSet);
  }

  function parseTmdb(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const m = raw.match(/themoviedb\.org\/(movie|tv|person)\/(\d+)/i);
    if (m) return { type: m[1].toLowerCase() === "person" ? "person" : m[1].toLowerCase(), id: Number(m[2]) };
    if (/^\d+$/.test(raw)) return { type: "movie", id: Number(raw) };
    return null;
  }

  // Sidebar entries. Every one of them reads or writes the signed-in member's
  // own rows, so a signed-out visitor gets no sidebar at all — only the public
  // home of the profile being visited.
  // Points live in Dashboard > Points; "Your content" (js/content-studio.js) holds the
  // member's videos: Create, Manage, Statistics.
  const NAV_SECTIONS = ["home", "create", "posts", "content", "messages", "search", "following", "blocked", "settings"];

  function signedIn() {
    return Boolean(state.me?.member?.member_id);
  }

  function navSections() {
    return signedIn() ? NAV_SECTIONS : [];
  }

  function secLabel(s) {
    const label = t(`prof.${s}`);
    return label !== `prof.${s}` ? label : s[0].toUpperCase() + s.slice(1);
  }

  function renderShell() {
    const sections = navSections();
    const navBtn = (s) =>
      `<button type="button" data-sec="${s}" class="${state.section===s?"active":""}">${window.CineAura.navIcon(s)}<span>${secLabel(s)}</span></button>`;
    // On somebody else's profile only Home is about that member; the rest of
    // the list is the signed-in member's own account, so it gets a caption.
    const cap = sections.length && !state.isOwner
      ? `<p class="prof-side-cap">${t("prof.sideMine")}</p>`
      : "";
    const aside = sections.length
      ? `
        <aside class="glass prof-side">
          <a class="prof-side-id" href="${escapeHtml(profileHref(state.hostMember?.username || ""))}">
            ${avatarTag(state.host, state.hostMember?.username)}
            <span class="prof-side-who">
              <strong>@${escapeHtml(state.hostMember?.username || "")}</strong>
              <span class="muted">${state.isOwner ? t("prof.you") : t("prof.visiting")}</span>
            </span>
          </a>
          <nav>
            ${navBtn("home")}
            ${cap}
            ${sections.filter((s) => s !== "home").map(navBtn).join("\n            ")}
          </nav>
        </aside>`
      : "";
    $("#prof-root").innerHTML = `
      <div class="prof-layout${sections.length ? "" : " prof-layout--solo"}">
        ${aside}
        <section class="glass prof-main" id="prof-main"></section>
      </div>`;
    if (sections.length) {
      window.CineAura.mountSideToggle($("#prof-root .prof-layout"));
      hydrateAvatars($("#prof-root"));
    }
    $("#prof-root").onclick = (e) => {
      const sec = e.target.closest("[data-sec]");
      if (sec) {
        state.section = sec.dataset.sec;
        if (state.section !== "content" && /^#content/.test(location.hash)) {
          history.replaceState(history.state, "", `${location.pathname}${location.search}`);
        }
        if (state.section !== "home" && (pcFromHash() || mkFromHash())) replaceHash("");
        renderShell();
      }
    };
    renderSection();
  }

  async function loadNotes() {
    const me = state.me?.member?.member_id;
    if (!me) return;
    const res = await supabaseRequest(
      `/rest/v1/notifications?member_id=eq.${restValue(me)}&select=*&order=created_at.desc&limit=30`
    );
    state.notes = res.ok && Array.isArray(res.data) ? res.data : [];
    const unread = state.notes.some((n) => !n.read);
    const dot = $("#bell-dot");
    if (dot) dot.hidden = !unread;
  }

  function toggleBell() {
    const panel = $("#bell-panel");
    if (!panel) return;
    const open = panel.hidden;
    panel.hidden = !open;
    if (!open) return;
    panel.innerHTML = state.notes.length
      ? state.notes.map((n) => `
        <div class="note-row">
          <div></div>
          <div>
            <strong>${escapeHtml(tr(n.title || n.kind))}</strong>
            <div class="muted">${escapeHtml(n.body || "")} · ${String(n.created_at||"").slice(0,16).replace("T"," ")}</div>
          </div>
        </div>`).join("")
      : `<p class="muted">${t("prof.noNotes")}</p>`;
    state.notes.filter((n) => !n.read).forEach((n) => {
      supabaseRequest(`/rest/v1/notifications?id=eq.${n.id}`, {
        method: "PATCH",
        body: JSON.stringify({ read: true }),
      });
      n.read = true;
    });
    const dot = $("#bell-dot");
    if (dot) dot.hidden = true;
  }

  async function renderSection() {
    const main = $("#prof-main");
    if (!main) return;
    const map = {
      home: viewHome,
      create: viewCreate,
      posts: viewManagePosts,
      content: viewContent,
      messages: viewMessages,
      search: viewSearch,
      following: viewFollowing,
      blocked: viewBlocked,
      settings: viewSettings,
    };
    // Only sections offered by the sidebar are reachable; anything else falls
    // back to Home (a signed-out visitor has no sidebar, so always Home).
    if (!navSections().includes(state.section)) state.section = "home";
    await (map[state.section] || viewHome)(main);
    hydrateAvatars(main);
  }

  function websitesHtml(p) {
    const sites = String(p.websites || "")
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!sites.length) return "";
    return `<p>${sites.map((u) => `<a href="${escapeHtml(u)}" target="_blank" rel="noopener">${escapeHtml(u)}</a>`).join(" · ")}</p>`;
  }

  // ---------- Account status badge (public) ----------
  async function loadHostStatus() {
    const id = state.hostMember?.member_id;
    state.hostSan = null;
    state.hostBannedAt = null;
    if (!id) return;
    const [san, mem] = await Promise.all([
      supabaseRequest(`/rest/v1/sanctions?member_id=eq.${restValue(id)}&select=features,temp_until`),
      supabaseRequest(`/rest/v1/members?member_id=eq.${restValue(id)}&select=banned_at`),
    ]);
    state.hostSan = san.ok && Array.isArray(san.data) ? san.data[0] || null : null;
    state.hostBannedAt = mem.ok && Array.isArray(mem.data) ? mem.data[0]?.banned_at || null : null;
  }

  function hostBans() {
    const feats = String(state.hostSan?.features || "").split(",").map((x) => x.trim()).filter(Boolean);
    const tempUntil = state.hostSan?.temp_until && Date.parse(state.hostSan.temp_until) > Date.now() ? state.hostSan.temp_until : null;
    return { feats, tempUntil };
  }

  function statusBadges() {
    const status = state.hostMember?.status;
    if (!state.hostMember?.member_id || !status) return [];
    const st = window.CineAura.normalizeAccountStatus(status);
    if (st === "banned") return [{ kind: "full", label: t("prof.st.full") }];
    const { feats, tempUntil } = hostBans();
    const out = [];
    if (st !== "active") out.push({ kind: "inactive", label: t("prof.st.inactive") });
    else if (!tempUntil && !feats.length) out.push({ kind: "active", label: t("prof.st.active") });
    if (tempUntil) out.push({ kind: "temp", label: t("prof.st.temp") });
    if (feats.length) out.push({ kind: "partial", label: t("prof.st.partial") });
    return out;
  }

  function openStatusModal(kind) {
    const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }); };
    const { feats, tempUntil } = hostBans();
    let title = "";
    let body = "";
    if (kind === "full") {
      title = t("prof.st.full");
      const since = state.hostBannedAt ? `<p>${t("prof.st.since", { date: when(state.hostBannedAt) })}</p>` : "";
      const del = state.hostBannedAt ? `<p class="muted">${t("prof.st.deleteOn", { date: when(Date.parse(state.hostBannedAt) + 90 * 86400000) })}</p>` : "";
      body = `<p>${t("prof.st.fullText")}</p>${since}${del}`;
    } else if (kind === "temp") {
      title = t("prof.st.temp");
      const ms = Math.max(0, Date.parse(tempUntil) - Date.now());
      const days = Math.floor(ms / 86400000);
      const hours = Math.floor((ms % 86400000) / 3600000);
      body = `<p>${t("prof.st.tempUntil", { date: when(tempUntil) })}</p><p><strong>${t("prof.st.remaining", { d: days, h: hours })}</strong></p><p class="muted">${t("prof.st.tempText")}</p>`;
    } else if (kind === "partial") {
      title = t("prof.st.partial");
      body = `<p>${t("prof.st.partialText")}</p><ul class="st-list">${feats.map((f) => `<li>${t(`prof.ban.${f}`)}</li>`).join("")}</ul>`;
    } else if (kind === "inactive") {
      title = t("prof.st.inactive");
      body = `<p>${t("prof.st.inactiveText")}</p>`;
    } else {
      title = t("prof.st.active");
      body = `<p>${t("prof.st.activeText")}</p>`;
    }
    const ov = document.createElement("div");
    ov.className = "modal-overlay";
    ov.innerHTML = `<section class="glass modal-card">
      <span class="eyebrow">${t("prof.st.title")}</span>
      <h2>@${escapeHtml(state.hostMember?.username || "")} · ${title}</h2>
      ${body}
      <button class="btn btn-sm btn-ghost" id="st-x" type="button" style="margin-top:12px">${t("common.close")}</button>
    </section>`;
    document.body.appendChild(ov);
    ov.addEventListener("click", (e) => { if (e.target === ov || e.target.closest("#st-x")) ov.remove(); });
  }

  async function viewHome(main) {
    if (state.theirBlock?.kind === "full") {
      main.innerHTML = `<h1>${t("prof.unavailable")}</h1><p class="muted">${t("prof.notAvail")}</p>`;
      return;
    }
    const p = state.host || {};
    const m = state.hostMember || {};
    const age = ageOf(m.birth_date);
    const showG = p.show_gender !== false;
    const showC = p.show_country !== false;
    const showL = p.show_language !== false;
    main.innerHTML = `
      <div class="prof-head">
        ${avatarTag(p, m.username)}
        <div>
          <h1>${escapeHtml(p.display_name || m.full_name || m.username)} <span class="prof-lv" data-prof-level hidden></span></h1>
          <p class="muted">@${escapeHtml(m.username || "")} · ${escapeHtml(m.member_id || "")}</p>
          <div class="status-row">${statusBadges().map((b) => `<button class="status-badge ${b.kind}" data-status="${b.kind}" title="${t("prof.st.click")}" type="button">${b.label}</button>`).join("")}</div>
          <p>${escapeHtml(p.bio || t("prof.noBio"))}</p>
          <div class="meta-row" style="margin-top:8px">
            ${showG && m.gender ? `<span class="chip">${escapeHtml(tr(m.gender))}</span>` : ""}
            ${age != null ? `<span class="chip">${age}</span>` : ""}
            ${showC && m.country ? `<span class="chip">${escapeHtml(m.country)}</span>` : ""}
            ${showL && p.language ? `<span class="chip">${escapeHtml(p.language)}</span>` : ""}
          </div>
          ${websitesHtml(p)}
          <p class="muted" style="margin-top:8px">
            <button class="btn btn-sm btn-ghost" data-people="followers" type="button">${Number(p.followers||0)} ${t("prof.followers")}</button>
            <button class="btn btn-sm btn-ghost" data-people="following" type="button">${Number(p.following||0)} ${t("prof.followingN")}</button>
          </p>
          ${state.isOwner ? ownStatsHtml() : ""}
          <div class="prof-share">${shareRowHtml(profileHref(m.username || ""), `@${m.username || ""} · CineAura`, { compact: true })}</div>
        </div>
        <div class="prof-actions" id="prof-actions"></div>
      </div>
      <div class="tabs">
        <button class="btn btn-sm auth-allow ${state.homeTab==="activity"?"btn-primary":"btn-ghost"}" data-htab="activity" type="button">${t("prof.activity")}</button>
        <button class="btn btn-sm auth-allow ${state.homeTab==="content"?"btn-primary":"btn-ghost"}" data-htab="content" type="button">${t("prof.contentTab")}</button>
        <button class="btn btn-sm auth-allow ${state.homeTab==="market"?"btn-primary":"btn-ghost"}" data-htab="market" type="button">${t("prof.marketTab")}</button>
        ${state.isOwner ? `<button class="btn btn-sm ${state.homeTab==="updates"?"btn-primary":"btn-ghost"}" data-htab="updates" type="button">${t("prof.updates")}</button>` : ""}
      </div>
      <div id="home-body"></div>`;
    drawOwnerActions();
    if (state.isOwner) loadOwnPoints();
    loadHostLevel();
    main.querySelectorAll("[data-status]").forEach((b) => { b.onclick = () => openStatusModal(b.dataset.status); });
    main.querySelectorAll("[data-htab]").forEach((b) => {
      b.onclick = () => {
        state.homeTab = b.dataset.htab;
        // #videos / #playlists / #playlist/… belong to the Content tab only, #market… to Market
        if (state.homeTab !== "content" && pcFromHash()) replaceHash("");
        if (state.homeTab === "market") replaceHash(mkHash());
        else if (mkFromHash()) replaceHash("");
        viewHome(main);
      };
    });
    main.querySelector("[data-people='followers']").onclick = () => openPeople("followers");
    main.querySelector("[data-people='following']").onclick = () => openPeople("following");
    if (state.homeTab === "updates") await drawUpdates();
    else if (state.homeTab === "content") await drawContent();
    else if (state.homeTab === "market") await drawMarket();
    else await drawActivity();
    hydrateAvatars(main);
  }

  function drawOwnerActions() {
    const box = $("#prof-actions");
    if (!box) return;
    if (state.isOwner) {
      box.innerHTML = `<span class="muted">${t("prof.you")}</span>`;
      return;
    }
    if (!state.me) {
      box.innerHTML = `<a class="btn btn-sm btn-primary" href="./login.html">${escapeHtml(t("common.signin"))}</a>`;
      return;
    }
    const f = state.followRow;
    const followLabel = !f ? t("prof.follow") : f.status === "pending" ? t("prof.requested") : f.status === "accepted" ? t("prof.unfollow") : t("prof.follow");
    const blocked = Boolean(state.blockRow);
    const msgBlocked =
      blockedFeature("messages") ||
      (state.theirBlock &&
        (state.theirBlock.kind === "full" ||
          String(state.theirBlock.features || "")
            .split(",")
            .map((s) => s.trim())
            .includes("messages")));
    box.innerHTML = `
      <button class="btn btn-sm btn-primary" id="btn-follow" type="button">${followLabel}</button>
      ${f?.status === "accepted" && !msgBlocked ? `<button class="btn btn-sm btn-ghost" id="btn-msg" type="button">${t("prof.message")}</button>` : ""}
      ${f?.status === "accepted" ? `<button class="btn btn-sm btn-ghost" id="btn-rec" type="button">${t("prof.recommend")}</button>` : ""}
      <button class="btn btn-sm btn-danger" id="btn-block" type="button">${blocked ? t("prof.unblock") : t("prof.block")}</button>`;
    $("#btn-follow").onclick = onFollow;
    $("#btn-block").onclick = onBlock;
    $("#btn-msg")?.addEventListener("click", () => openChat(state.hostMember));
    $("#btn-rec")?.addEventListener("click", recommendAccount);
  }

  async function onFollow() {
    const me = state.me.member;
    const host = state.hostMember;
    const policy = state.host?.follow_policy || "instant";
    if (state.followRow?.status === "accepted") {
      await supabaseRequest(
        `/rest/v1/follows?follower_id=eq.${restValue(me.member_id)}&following_id=eq.${restValue(host.member_id)}`,
        { method: "DELETE" }
      );
      state.followRow = null;
      await recount(me.member_id);
      await recount(host.member_id);
      toast(t("prof.unfollowed"));
      state.host.followers = Math.max(0, Number(state.host.followers || 1) - 1);
      renderShell();
      return;
    }
    if (state.followRow?.status === "pending") {
      toast(t("prof.reqSentAlready"));
      return;
    }
    if (policy === "closed") {
      toast(t("prof.closed"));
      return;
    }
    const status = policy === "approve" ? "pending" : "accepted";
    const row = {
      follower_id: me.member_id,
      following_id: host.member_id,
      follower_username: me.username,
      following_username: host.username,
      status,
      accepted_at: status === "accepted" ? new Date().toISOString() : null,
    };
    let saved;
    if (state.followRow?.id) {
      saved = await supabaseRequest(`/rest/v1/follows?id=eq.${state.followRow.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status, accepted_at: row.accepted_at }),
      });
    } else {
      saved = await supabaseRequest("/rest/v1/follows", { method: "POST", body: JSON.stringify(row) });
    }
    if (!saved.ok) return toast(t("prof.followFail"));
    state.followRow = saved.data?.[0] || { ...state.followRow, ...row };
    if (status === "accepted") {
      await recount(me.member_id);
      await recount(host.member_id);
      state.host.followers = Number(state.host.followers || 0) + 1;
      toast(t("prof.followed"));
    } else {
      await notify(host.member_id, {
        kind: "follow",
        title: t("prof.reqTitle"),
        body: `@${me.username} wants to follow you`,
        from_id: me.member_id,
        from_username: me.username,
        href: profileHref(me.username),
      });
      toast(t("prof.reqSent"));
    }
    renderShell();
  }

  function onBlock() {
    if (state.blockRow) {
      unblock(state.hostMember.member_id).then(() => {
        state.blockRow = null;
        toast(t("prof.unblocked"));
        renderShell();
      });
      return;
    }
    openBlockModal(state.hostMember);
  }

  async function unblock(id) {
    await supabaseRequest(`/rest/v1/blocks?blocker_id=eq.${restValue(state.me.member.member_id)}&blocked_id=eq.${restValue(id)}`, {
      method: "DELETE",
    });
  }

  function openBlockModal(person) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <section class="glass modal-card">
        <h2>Block @${escapeHtml(person.username)}</h2>
        <p class="muted">${t("prof.fullBlock")} hides your profile, messages, watch links, private/exclusive lists, and replies. Partial keeps the profile visible.</p>
        <select id="bk-kind"><option value="full">${t("prof.fullBlock")}</option><option value="partial">${t("prof.partialBlock")}</option></select>
        <div class="stack" id="bk-feats" hidden>
          ${PARTIAL_FEATURES.map((f) => `<label class="lang-chip"><input type="checkbox" name="bk-f" value="${f.id}" /> ${t(f.labelKey)}</label>`).join("")}
        </div>
        <div class="prof-actions" style="margin-top:12px">
          <button class="btn btn-sm btn-danger" id="bk-go" type="button">${t("prof.block")}</button>
          <button class="btn btn-sm btn-ghost" id="bk-x" type="button">${t("prof.cancel")}</button>
        </div>
      </section>`;
    document.body.appendChild(overlay);
    overlay.querySelector("#bk-kind").onchange = (e) => {
      overlay.querySelector("#bk-feats").hidden = e.target.value !== "partial";
    };
    overlay.querySelector("#bk-x").onclick = () => overlay.remove();
    overlay.querySelector("#bk-go").onclick = async () => {
      const kind = overlay.querySelector("#bk-kind").value;
      const features = [...overlay.querySelectorAll('input[name="bk-f"]:checked')].map((x) => x.value).join(",");
      if (kind === "partial" && !features) return toast(t("prof.pickFeat"));
      const row = {
        blocker_id: state.me.member.member_id,
        blocked_id: person.member_id,
        blocker_username: state.me.member.username,
        blocked_username: person.username,
        kind,
        features,
      };
      const saved = await supabaseRequest("/rest/v1/blocks", { method: "POST", body: JSON.stringify(row) });
      if (!saved.ok) return toast(t("prof.blockFail"));
      state.blockRow = saved.data?.[0] || row;
      overlay.remove();
      toast(t("prof.blockedOk"));
      renderShell();
    };
  }

  async function recommendAccount() {
    if (!(await window.CineAura.guardFeature("posts"))) return;
    const me = state.me.member;
    const host = state.hostMember;
    const fol = await supabaseRequest(
      `/rest/v1/follows?following_id=eq.${restValue(me.member_id)}&status=eq.accepted&select=follower_id`
    );
    const people = fol.data || [];
    await Promise.all(
      people.map((p) =>
        notify(p.follower_id, {
          kind: "recommend",
          title: t("prof.recAcc"),
          body: `@${me.username} recommends @${host.username}`,
          href: profileHref(host.username),
          from_id: me.member_id,
          from_username: me.username,
        })
      )
    );
    toast(t("prof.recSent"));
  }

  async function openPeople(kind) {
    const hostId = state.hostMember.member_id;
    const q =
      kind === "followers"
        ? `/rest/v1/follows?following_id=eq.${restValue(hostId)}&status=eq.accepted&select=*`
        : `/rest/v1/follows?follower_id=eq.${restValue(hostId)}&status=eq.accepted&select=*`;
    const res = await supabaseRequest(q);
    const rows = res.data || [];
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `<section class="glass modal-card"><h2>${kind === "followers" ? t("prof.followersTitle") : t("prof.following")}</h2><div id="ppl"></div><button class="btn btn-sm btn-ghost" id="ppl-x" type="button">${t("common.close")}</button></section>`;
    document.body.appendChild(overlay);
    overlay.querySelector("#ppl-x").onclick = () => overlay.remove();
    const box = overlay.querySelector("#ppl");
    if (!rows.length) {
      box.innerHTML = `<p class="empty">None yet.</p>`;
      return;
    }
    const pair = (r) =>
      kind === "followers"
        ? { u: r.follower_username, id: r.follower_id }
        : { u: r.following_username, id: r.following_id };
    await primeAvatars(rows.map((r) => pair(r).id), rows.map((r) => pair(r).u));
    box.innerHTML = rows
      .map((r) => {
        const { u, id } = pair(r);
        return `<div class="person-row">
          ${avatarImg(id, u)}
          <div><strong>@${escapeHtml(u)}</strong><div class="muted">${escapeHtml(id)}</div></div>
          <div class="prof-actions">
            <a class="btn btn-sm btn-primary" href="${profileHref(u)}">${t("common.visit")}</a>
            ${state.me ? `<button class="btn btn-sm btn-ghost" data-msg="${escapeHtml(id)}" data-user="${escapeHtml(u)}" type="button">Message</button>
            <button class="btn btn-sm btn-danger" data-blk="${escapeHtml(id)}" data-user="${escapeHtml(u)}" type="button">${t("prof.block")}</button>` : ""}
          </div>
        </div>`;
      })
      .join("");
    box.onclick = (e) => {
      const msg = e.target.closest("[data-msg]");
      const blk = e.target.closest("[data-blk]");
      if (msg) openChat({ member_id: msg.dataset.msg, username: msg.dataset.user });
      if (blk) openBlockModal({ member_id: blk.dataset.blk, username: blk.dataset.user });
    };
  }

  async function drawActivity() {
    const body = $("#home-body");
    const posts = await supabaseRequest(
      `/rest/v1/posts?owner_id=eq.${restValue(state.hostMember.member_id)}&select=*&order=created_at.desc`
    );
    const list = posts.ok && Array.isArray(posts.data) ? posts.data : [];
    const accessAll = await supabaseRequest(
      `/rest/v1/post_access?select=post_id,username`
    );
    const access = {};
    (accessAll.data || []).forEach((a) => {
      access[a.post_id] = access[a.post_id] || [];
      access[a.post_id].push(a.username);
    });
    let watchedSet = new Set();
    if (state.me?.member?.member_id) {
      const [vw, hs] = await Promise.all([
        supabaseRequest(`/rest/v1/views?viewer_id=eq.${restValue(state.me.member.member_id)}&select=tmdb_id`),
        supabaseRequest(`/rest/v1/hestory?visitor_id=eq.${restValue(state.me.member.member_id)}&select=tmdb_id`),
      ]);
      (vw.data || []).forEach((r) => watchedSet.add(Number(r.tmdb_id)));
      (hs.data || []).forEach((r) => watchedSet.add(Number(r.tmdb_id)));
    }
    const visible = list.filter((p) => canSeePost(p, access[p.post_id] || [], watchedSet));
    if (!visible.length) {
      body.innerHTML = `<p class="empty">${t("prof.noActivity")}</p>`;
      return;
    }
    const ids = visible.map((p) => p.post_id).join(",");
    const items = await supabaseRequest(`/rest/v1/post_items?post_id=in.(${ids})&select=*`);
    const votes = await supabaseRequest(`/rest/v1/post_votes?post_id=in.(${ids})&select=*`);
    const comments = await supabaseRequest(
      `/rest/v1/post_comments?post_id=in.(${ids})&select=*&order=created_at.asc`
    );
    const byPost = (arr, key) => {
      const m = {};
      (arr.data || []).forEach((r) => {
        m[r[key] || r.post_id] = m[r[key] || r.post_id] || [];
        m[r.post_id] = m[r.post_id] || [];
        m[r.post_id].push(r);
      });
      return m;
    };
    const itemMap = {};
    (items.data || []).forEach((it) => {
      itemMap[it.post_id] = itemMap[it.post_id] || [];
      itemMap[it.post_id].push(it);
    });
    const voteMap = byPost(votes, "post_id");
    const cmtMap = byPost(comments, "post_id");
    visible.forEach((p) => state.postCache.set(p.post_id, p));
    body.innerHTML = `<p class="muted">${t("common.loading")}</p>`;
    await enrichItemMap(visible, itemMap);
    body.innerHTML = visible.map((p) => renderPostCard(p, itemMap[p.post_id] || [], voteMap[p.post_id] || [], cmtMap[p.post_id] || [])).join("");
    body.onclick = (e) => onPostClick(e);
    trackImpressions(body, visible);
  }

  // ---------- Content: the member's videos and playlists (sql/content.sql) ----------
  // A tab of every profile, for every visitor: the videos of the member the visitor
  // may find (content_search with p_owner, newest / most watched / most liked / most
  // shared) and the member's playlists (content_playlists_of), each one opening its
  // videos (content_playlist_get). Profile.html?@name#videos, #playlists and
  // #playlist/CPL123456789 open it straight away; the address bar follows the tab.
  const PC_PAGE = 24;
  const PC_SORTS = [
    { key: "date", label: "vid.sort.date" },
    { key: "minutes", label: "vid.hub.tab.minutes" },
    { key: "recs", label: "vid.hub.tab.likes" },
    { key: "shares", label: "vid.hub.tab.shares" },
  ];
  const PC_ICON = {
    videos: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 9.2l5 2.8-5 2.8z"/>',
    playlists: '<path d="M4 6h11M4 11h11M4 16h6"/><path d="M15.5 13.5l5 3-5 3z"/>',
    back: '<path d="M15 6l-6 6 6 6"/>',
  };
  const pcIcon = (k, size = 16) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PC_ICON[k]}</svg>`;
  const pcWaitHtml = `<li class="pc-wait"><div class="loader" style="display:grid"><div class="spinner"></div></div></li>`;
  const pcCount = (n) =>
    Number(n) === 1 ? t("prof.pc.oneVideo") : t("vid.plCount", { n: window.CineAuraVideos.fmtNum(Number(n) || 0) });

  // #videos | #playlists | #playlist/CPL… -> { tab, playlist }; null for any other hash
  function pcFromHash(hash = location.hash) {
    const h = String(hash || "");
    if (h === "#videos") return { tab: "videos", playlist: "" };
    if (h === "#playlists") return { tab: "playlists", playlist: "" };
    const m = /^#playlist\/(CPL\d{9})$/.exec(h);
    return m ? { tab: "playlists", playlist: m[1] } : null;
  }

  function replaceHash(hash) {
    if ((location.hash || "") === hash) return;
    history.replaceState(history.state, "", `${location.pathname}${location.search}${hash}`);
  }

  // What the tab knows about the member of this page (kept while the page is open).
  function pcState() {
    const host = state.hostMember?.member_id || "";
    if (!state.pc || state.pc.host !== host) {
      state.pc = {
        host,
        tab: "videos",
        sort: "date",
        playlist: "",
        videos: null, // the cards loaded so far (pages of PC_PAGE)
        total: 0,
        vfail: "",
        vreq: null,
        vseq: 0,
        lists: null, // the playlists
        lfail: "",
        lreq: null,
        pseq: 0,
      };
    }
    return state.pc;
  }

  function pcHash() {
    const pc = pcState();
    if (pc.playlist) return `#playlist/${pc.playlist}`;
    return pc.tab === "playlists" ? "#playlists" : "#videos";
  }

  function pcLoadVideos({ more = false } = {}) {
    const pc = pcState();
    if (!more && pc.vreq) return pc.vreq;
    const V = window.CineAuraVideos;
    const seq = (pc.vseq += 1);
    const offset = more && pc.videos ? pc.videos.length : 0;
    const owner = String(state.hostMember?.username || "").trim();
    // no name, no filter: the search would list everybody's videos
    const ask = owner
      ? V.call("content_search", { p_member: V.memberId(), p_owner: owner, p_sort: pc.sort, p_limit: PC_PAGE, p_offset: offset })
      : Promise.resolve({ ok: true, data: { items: [], total: 0 } });
    const req = ask.then((res) => {
      if (seq !== pc.vseq) return; // another sort took over
      if (!res.ok) {
        pc.vfail = res.setup ? "setup" : "load";
        return;
      }
      const items = Array.isArray(res.data?.items) ? res.data.items : [];
      pc.vfail = "";
      pc.videos = offset ? (pc.videos || []).concat(items) : items;
      pc.total = Math.max(Number(res.data?.total) || 0, pc.videos.length);
    });
    if (!more) pc.vreq = req;
    return req;
  }

  function pcLoadLists() {
    const pc = pcState();
    if (pc.lreq) return pc.lreq;
    const V = window.CineAuraVideos;
    pc.lreq = V.call("content_playlists_of", {
      p_owner: state.hostMember?.member_id || "",
      p_member: V.memberId(),
    }).then((res) => {
      if (!res.ok) {
        pc.lfail = res.setup ? "setup" : "load";
        return;
      }
      pc.lfail = "";
      pc.lists = Array.isArray(res.data) ? res.data : [];
    });
    return pc.lreq;
  }

  // The numbers on the two tabs, once known.
  function pcPaintCounts() {
    const pc = pcState();
    const V = window.CineAuraVideos;
    const set = (k, n) => {
      const el = document.querySelector(`[data-pc-count="${k}"]`);
      if (!el) return;
      el.hidden = n == null;
      el.textContent = n == null ? "" : V.fmtNum(n);
    };
    set("videos", pc.videos ? pc.total : null);
    set("playlists", pc.lists ? pc.lists.length : null);
  }

  // why: setup (the SQL of the videos is missing) | load; lists: the Playlists tab (its own
  // message: the videos may work while the playlists need the newer sql/content.sql)
  function pcFailHtml(why, lists = false) {
    const key = why === "setup" ? (lists ? "prof.pc.plSetup" : "vid.setup") : "vid.loadFail";
    return `<li class="glass vs-none pc-none"><p>${escapeHtml(t(key))}</p></li>`;
  }

  // Reading, so open to signed-out visitors too: the section is .auth-allow (the
  // signed-out gate of common.js only locks actions).
  async function drawContent() {
    const body = $("#home-body");
    if (!body) return;
    // the activity wall binds its click handler on #home-body
    body.onclick = null;
    if (!window.CineAuraVideos) {
      body.innerHTML = `<p class="empty">${escapeHtml(t("vid.setup"))}</p>`;
      return;
    }
    const pc = pcState();
    const tabs = ["videos", "playlists"];
    body.innerHTML = `
      <section class="pc auth-allow" aria-label="${escapeHtml(t("prof.pc.tabsLabel"))}">
        <div class="pc-head">
          <div class="follow-tabs pc-tabs" role="tablist" aria-label="${escapeHtml(t("prof.pc.tabsLabel"))}">
            ${tabs
              .map(
                (k) =>
                  `<button type="button" role="tab" class="follow-tab" id="pc-tab-${k}" data-pctab="${k}" aria-controls="pc-pane" aria-selected="false">${pcIcon(k)}<span>${escapeHtml(t(`prof.pc.${k}`))}</span><span class="follow-count" data-pc-count="${k}" hidden></span></button>`
              )
              .join("")}
          </div>
          ${state.isOwner
            ? `<div class="pc-own">
                <a class="btn btn-sm btn-ghost" href="#content/manage">${escapeHtml(t("prof.pc.manage"))}</a>
                <a class="btn btn-sm btn-primary" href="#content">${escapeHtml(t("vid.hub.create"))}</a>
              </div>`
            : ""}
        </div>
        <div class="pc-pane" id="pc-pane" role="tabpanel"></div>
      </section>`;
    const bar = body.querySelector(".pc-tabs");
    bar.addEventListener("click", (e) => {
      const b = e.target.closest("[data-pctab]");
      if (!b) return;
      pc.tab = b.dataset.pctab;
      pc.playlist = "";
      pcShow();
    });
    // arrows move between the two tabs (the tab pattern)
    bar.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const rtl = document.documentElement.dir === "rtl";
      let i = tabs.indexOf(pc.tab);
      if (e.key === "Home") i = 0;
      else if (e.key === "End") i = tabs.length - 1;
      else i = (i + ((e.key === "ArrowRight") !== rtl ? 1 : -1) + tabs.length) % tabs.length;
      pc.tab = tabs[i];
      pc.playlist = "";
      pcShow();
      bar.querySelector(`[data-pctab="${tabs[i]}"]`)?.focus();
    });
    // both numbers from the start, whichever tab is open
    if (pc.vfail) Object.assign(pc, { vfail: "", vreq: null, videos: null });
    if (pc.lfail) Object.assign(pc, { lfail: "", lreq: null, lists: null });
    pcLoadVideos().then(pcPaintCounts);
    pcLoadLists().then(pcPaintCounts);
    pcPaintCounts();
    await pcShow();
  }

  async function pcShow() {
    const pc = pcState();
    const pane = $("#pc-pane");
    if (!pane) return;
    document.querySelectorAll(".pc-tabs [data-pctab]").forEach((b) => {
      const on = b.dataset.pctab === pc.tab;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    pane.setAttribute("aria-labelledby", `pc-tab-${pc.tab}`);
    replaceHash(pcHash());
    if (pc.playlist) return pcDrawPlaylist(pane);
    if (pc.tab === "playlists") return pcDrawLists(pane);
    return pcDrawVideos(pane);
  }

  function pcDrawVideos(pane) {
    const pc = pcState();
    pane.innerHTML = `
      <div class="pc-bar">
        ${state.isOwner ? `<p class="muted pc-note">${escapeHtml(t("prof.pc.ownerNote"))}</p>` : ""}
        <label class="pc-sort">
          <span>${escapeHtml(t("vid.sortBy"))}</span>
          <select data-pc-sort>${PC_SORTS.map((x) => `<option value="${x.key}"${x.key === pc.sort ? " selected" : ""}>${escapeHtml(t(x.label))}</option>`).join("")}</select>
        </label>
      </div>
      <ol class="vgrid pc-grid" id="pc-grid" aria-live="polite"></ol>
      <div class="pc-more" hidden><button class="btn btn-sm btn-ghost" type="button" data-pc-more>${escapeHtml(t("vid.showMore"))}</button></div>`;
    pane.querySelector("[data-pc-sort]").onchange = (e) => {
      pc.sort = e.target.value;
      Object.assign(pc, { videos: null, vreq: null, vfail: "" });
      pcFillVideos(pane);
    };
    pane.querySelector("[data-pc-more]").onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      await pcLoadVideos({ more: true });
      if (pane.isConnected) pcFillVideos(pane);
    };
    return pcFillVideos(pane);
  }

  async function pcFillVideos(pane) {
    const pc = pcState();
    const V = window.CineAuraVideos;
    const grid = pane.querySelector("#pc-grid");
    const more = pane.querySelector(".pc-more");
    if (!grid) return;
    if (!pc.videos && !pc.vfail) {
      grid.setAttribute("aria-busy", "true");
      grid.innerHTML = pcWaitHtml;
      more.hidden = true;
      const req = pcLoadVideos();
      await req;
      if (!grid.isConnected || pc.vreq !== req) return; // another tab, or another sort
    }
    grid.removeAttribute("aria-busy");
    pcPaintCounts();
    if (pc.vfail) {
      grid.innerHTML = pcFailHtml(pc.vfail);
      more.hidden = true;
      return;
    }
    if (!pc.videos.length) {
      const name = `<bdi>@${escapeHtml(state.hostMember?.username || "")}</bdi>`;
      grid.innerHTML = state.isOwner
        ? `<li class="glass vs-none pc-none"><p><b>${escapeHtml(t("prof.pc.noneMine"))}</b></p><a class="btn btn-sm btn-primary" href="#content">${escapeHtml(t("vid.hub.create"))}</a></li>`
        : `<li class="glass vs-none pc-none"><p>${t("prof.pc.none", { name })}</p></li>`;
      more.hidden = true;
      return;
    }
    grid.innerHTML = pc.videos.map((x) => `<li class="pc-item">${V.cardHtml(x, { vis: true })}</li>`).join("");
    more.hidden = pc.videos.length >= pc.total;
    more.querySelector("button").disabled = false;
    V.observeCards(grid);
  }

  function pcListCard(p) {
    const V = window.CineAuraVideos;
    const name = String(p.name || "");
    const initial = escapeHtml((name.trim()[0] || "▶").toUpperCase());
    return `<li class="pc-item">
      <a class="vcard pc-pl" href="#playlist/${encodeURIComponent(p.id)}" data-pl="${escapeHtml(p.id)}">
        <span class="vthumb pc-pl-thumb" style="--vh:${V.hueFor(p.id || name)}">
          <span class="vthumb-ph" aria-hidden="true">${initial}</span>
          ${p.thumb ? `<img src="${escapeHtml(p.thumb)}" alt="" loading="lazy" data-vthumb />` : ""}
          <span class="pc-pl-count">${pcIcon("playlists", 13)}<span>${escapeHtml(pcCount(p.count))}</span></span>
        </span>
        <span class="vcard-body">
          <b class="vcard-title">${escapeHtml(name)}</b>
          <span class="vcard-meta">${escapeHtml(t("prof.pc.updated", { when: V.timeAgo(p.updated_at) }))}</span>
          ${p.suspended ? `<span class="pc-susp">${escapeHtml(t("vid.plSuspended"))}</span><span class="pc-susp-why">${escapeHtml(t("vid.suspendedWhy", { reason: p.suspended.reason || "" }))}</span>` : ""}
          <span class="pc-pl-open">${escapeHtml(t("prof.pc.viewAll"))}</span>
        </span>
      </a>
    </li>`;
  }

  async function pcDrawLists(pane) {
    const pc = pcState();
    pane.innerHTML = `<ol class="vgrid pc-grid pc-lists" id="pc-grid" aria-live="polite"></ol>`;
    const grid = pane.querySelector("#pc-grid");
    if (!pc.lists && !pc.lfail) {
      grid.setAttribute("aria-busy", "true");
      grid.innerHTML = pcWaitHtml;
      await pcLoadLists();
      if (!grid.isConnected) return;
    }
    grid.removeAttribute("aria-busy");
    pcPaintCounts();
    if (pc.lfail) {
      grid.innerHTML = pcFailHtml(pc.lfail, true);
      return;
    }
    if (!pc.lists.length) {
      const name = `<bdi>@${escapeHtml(state.hostMember?.username || "")}</bdi>`;
      grid.innerHTML = `<li class="glass vs-none pc-none"><p>${state.isOwner ? escapeHtml(t("prof.pc.noPlMine")) : t("prof.pc.noPl", { name })}</p></li>`;
      return;
    }
    grid.innerHTML = pc.lists.map(pcListCard).join("");
  }

  async function pcDrawPlaylist(pane) {
    const pc = pcState();
    const V = window.CineAuraVideos;
    const id = pc.playlist;
    const seq = (pc.pseq += 1);
    const back = `<a class="btn btn-sm btn-ghost pc-back" href="#playlists">${pcIcon("back")}<span>${escapeHtml(t("prof.pc.back"))}</span></a>`;
    pane.innerHTML = `<ol class="vgrid pc-grid" aria-busy="true">${pcWaitHtml}</ol>`;
    const res = await V.call("content_playlist_get", { p_playlist: id, p_member: V.memberId(), p_limit: 100 });
    if (seq !== pc.pseq || !pane.isConnected || pc.playlist !== id) return;
    const p = res.ok && res.data?.ok ? res.data.playlist : null;
    // a playlist opens on its owner's page only
    if (!p || p.owner_id !== state.hostMember?.member_id) {
      pane.innerHTML = `<div class="pc-plhead">${back}</div>
        <div class="glass vs-none pc-none"><p><b>${escapeHtml(t(res.setup ? "prof.pc.plSetup" : !res.ok ? "vid.loadFail" : "prof.pc.plGone"))}</b></p></div>`;
      return;
    }
    const items = Array.isArray(res.data.items) ? res.data.items : [];
    const owner = String(p.owner || "");
    const href = `${profileHref(owner)}#playlist/${encodeURIComponent(p.id)}`;
    pane.innerHTML = `
      <div class="pc-plhead">
        ${back}
        <div class="pc-plinfo">
          <span class="eyebrow">${escapeHtml(t("prof.pc.playlist"))}</span>
          <h3>${escapeHtml(p.name || "")}</h3>
          <p class="muted"><a href="${escapeHtml(profileHref(owner))}"><bdi>@${escapeHtml(owner)}</bdi></a> · ${escapeHtml(pcCount(p.count))} · ${escapeHtml(t("prof.pc.updated", { when: V.timeAgo(p.updated_at) }))}</p>
        </div>
        <div class="pc-plshare">${shareRowHtml(href, `«${p.name || ""}» — @${owner} · CineAura`, { compact: true })}</div>
        ${state.me && p.owner_id !== state.me.member?.member_id ? `<button class="btn btn-sm btn-ghost pc-report" type="button" data-pl-report="${escapeHtml(p.id)}">${escapeHtml(t("rep.btn"))}</button>` : ""}
      </div>
      ${items.length
        ? `<ol class="vgrid pc-grid">${items.map((x, i) => `<li class="pc-item">${V.cardHtml(x, { rank: i + 1, vis: true })}</li>`).join("")}</ol>`
        : `<div class="glass vs-none pc-none"><p>${escapeHtml(t("prof.pc.plEmpty"))}</p></div>`}`;
    V.observeCards(pane);
    pane.querySelector("[data-pl-report]")?.addEventListener("click", (e) => {
      window.CineAura.reportDialog({ kind: "playlist", id: e.currentTarget.dataset.plReport, title: p.name || "" });
    });
  }

  // ---------- Rich posts (TMDB info / cast / trailer) ----------
  const Rich = window.CineAuraRich;
  const RICH_KINDS = ["recommendation", "reclist", "review"];

  function kindLabel(kind) {
    if (kind === "playlist") return t("dash.nav.playlists");
    if (kind === "reclist") return t("prof.recList");
    if (kind === "review") return t("rev.review");
    if (kind === "account") return t("prof.recAcc");
    return t("prof.recs");
  }

  function visLabel(v) {
    return t(`pm.vis.${v || "public"}`);
  }

  async function enrichItemMap(posts, itemMap) {
    await Promise.all(
      posts
        .filter((p) => RICH_KINDS.includes(p.kind) && itemMap[p.post_id]?.length)
        .map(async (p) => {
          itemMap[p.post_id] = await Rich.enrich(itemMap[p.post_id]);
        })
    );
  }

  // Body of a post card: playlists keep the poster grid, recommendations /
  // lists / reviews get poster + title + year + genre + story + cast + trailer.
  function postContentHtml(p, items) {
    if (!RICH_KINDS.includes(p.kind)) {
      const media = items
        .map((it) => {
          const href = it.media_type === "person" ? personHref(it.tmdb_id) : watchHref(it.media_type, it.tmdb_id, null, null, p.post_id);
          const img = it.poster_path ? imgUrl(it.poster_path, "w185") : initialsAvatar(it.title);
          const score = Number(it.rating || 0) ? Number(it.rating).toFixed(1) : "";
          return `<a href="${href}">${score ? `<span class="score">★ ${score}</span>` : ""}<img src="${img}" alt=""/><div class="muted">${escapeHtml(it.title)}</div></a>`;
        })
        .join("");
      return `<p>${escapeHtml(p.body || "")}</p>
        ${p.playlist_id ? `<p><a class="btn btn-sm btn-ghost" href="./Playlist.html?ID=${encodeURIComponent(p.playlist_id)}">${t("prof.openPl")}</a></p>` : ""}
        ${media ? `<div class="post-media">${media}</div>` : ""}`;
    }
    const display = Rich.parseDisplay(p.display);
    const compact = p.kind === "reclist" && items.length > 1;
    const blocks = items.map((it) => Rich.itemHtml(it, display, p.post_id, { compact })).join("");
    if (p.kind === "review") {
      return `<div class="rich-list">${blocks}</div>
        <div class="review-text">${escapeHtml(p.body || "")}</div>
        ${Rich.reviewListsHtml(p.pros, p.cons)}`;
    }
    return `<p>${escapeHtml(p.body || "")}</p><div class="rich-list">${blocks}</div>`;
  }

  function ownerToolsHtml(p) {
    if (!state.isOwner || p.owner_id !== state.me?.member?.member_id) return "";
    const v = p.visibility || "public";
    return `<div class="post-tools">
      <span class="vis-badge vis-${escapeHtml(v)}">${visLabel(v)}</span>
      <button class="btn btn-sm btn-ghost" data-pm-edit="${escapeHtml(p.post_id)}" type="button">${t("pm.edit")}</button>
      <button class="btn btn-sm btn-danger" data-pm-del="${escapeHtml(p.post_id)}" type="button">${t("pm.delete")}</button>
    </div>`;
  }

  function myVoteIn(votes) {
    const me = state.me?.member?.member_id;
    if (!me) return "";
    return (votes || []).find((v) => v.member_id === me)?.vote || "";
  }

  function renderPostCard(p, items, votes, comments) {
    return `<article class="post-card kind-${escapeHtml(p.kind)}" data-post="${escapeHtml(p.post_id)}" data-owner="${escapeHtml(p.owner_id || "")}">${postCardInnerHtml(p, items, votes, comments)}</article>`;
  }

  // Everything inside a post card. Shared by the activity wall and the updates
  // feed, so a post looks exactly the same wherever it shows up.
  function postCardInnerHtml(p, items, votes, comments) {
    const up = votes.filter((v) => v.vote === "up").length;
    const down = votes.filter((v) => v.vote === "down").length;
    const mine = myVoteIn(votes);
    const hideVote = blockedFeature("updates") && !state.isOwner;
    return `<div class="post-top">
        <span class="eyebrow">${kindLabel(p.kind)} · ${visLabel(p.visibility)} · ${String(p.created_at || "").slice(0, 10)}</span>
        ${ownerToolsHtml(p)}
      </div>
      <h3>${escapeHtml(p.title)}</h3>
      ${postContentHtml(p, items)}
      ${hideVote ? "" : `<div class="prof-actions">
        <button class="btn btn-sm ${mine === "up" ? "btn-vote-on" : "btn-ghost"}" data-vote="up" data-pid="${escapeHtml(p.post_id)}" type="button">${t("prof.recommendBtn", { n: up })}</button>
        <button class="btn btn-sm ${mine === "down" ? "btn-vote-on" : "btn-ghost"}" data-vote="down" data-pid="${escapeHtml(p.post_id)}" type="button">${t("prof.dont", { n: down })}</button>
        ${state.me && p.owner_id !== state.me.member?.member_id ? `<button class="btn btn-sm btn-ghost post-report" data-post-report="${escapeHtml(p.post_id)}" type="button">${escapeHtml(t("rep.btn"))}</button>` : ""}
      </div>`}
      <div class="stack" style="margin-top:10px">
        ${(comments || []).map((c) => `<p><a href="${profileHref(c.username)}"><strong>@${escapeHtml(c.username)}</strong></a> ${escapeHtml(c.comment)}</p>`).join("")}
        ${state.me && !blockedFeature("updates") ? `<div class="form-row"><input data-cmt="${escapeHtml(p.post_id)}" placeholder="${t("prof.writeCmt")}" /><button class="btn btn-sm btn-primary" data-send-cmt="${escapeHtml(p.post_id)}" type="button">${t("prof.comment")}</button></div>` : ""}
      </div>
      <div class="post-share">${shareRowHtml(postHref(p), postShareText(p), { compact: true, track: p.post_id })}</div>`;
  }

  async function onPostClick(e, refresh) {
    // (round 31) Report a post (Panel > Reports > Content; a valid report costs it ranking points)
    const rep = e.target.closest("[data-post-report]");
    if (rep) {
      const post = state.postCache.get(rep.dataset.postReport);
      window.CineAura.reportDialog({ kind: "post", id: rep.dataset.postReport, title: post?.title || "" });
      return;
    }
    const pmEdit = e.target.closest("[data-pm-edit]");
    const pmDel = e.target.closest("[data-pm-del]");
    if (pmEdit || pmDel) {
      const post = state.postCache.get((pmEdit || pmDel).dataset[pmEdit ? "pmEdit" : "pmDel"]);
      if (!post) return;
      const after = typeof refresh === "function" ? refresh : () => drawActivity();
      if (pmEdit) openPostManager(post, after);
      else confirmDeletePost(post, after);
      return;
    }
    const vote = e.target.closest("[data-vote]");
    const send = e.target.closest("[data-send-cmt]");
    if (!state.me) {
      if (vote || send) toast(t("prof.signFirst"));
      return;
    }
    if (vote && !(await window.CineAura.guardFeature("posts"))) return;
    if (send && !(await window.CineAura.guardFeature("comments"))) return;
    const redraw = typeof refresh === "function" ? refresh : () => drawActivity();
    if (vote) {
      const postId = vote.dataset.pid;
      const choice = vote.dataset.vote;
      await supabaseRequest(
        `/rest/v1/post_votes?post_id=eq.${restValue(postId)}&member_id=eq.${restValue(state.me.member.member_id)}`,
        { method: "DELETE" }
      );
      await supabaseRequest("/rest/v1/post_votes", {
        method: "POST",
        body: JSON.stringify({
          post_id: postId,
          member_id: state.me.member.member_id,
          username: state.me.member.username,
          vote: choice,
        }),
      });
      // The vote row belongs to the post author, which is not always the member
      // whose wall we are standing on (updates feed shows other people's posts).
      const voted = state.postCache.get(postId) || null;
      const owner = voted?.owner_id
        ? { member_id: voted.owner_id, username: voted.owner_username }
        : state.hostMember;
      const kind = choice === "up" ? "vote_up" : "vote_down";
      await supabaseRequest("/rest/v1/updates", {
        method: "POST",
        body: JSON.stringify({
          actor_id: state.me.member.member_id,
          actor_username: state.me.member.username,
          target_id: owner.member_id,
          target_username: owner.username,
          kind,
          post_id: postId,
        }),
      });
      // Tell the author, in the header bell, with the same one-line wording.
      if (voted && voted.owner_id && voted.owner_id !== state.me.member.member_id) {
        await notifyOnce(voted.owner_id, {
          kind,
          title: t("prof.notifVote"),
          body: updateLine(
            { kind, actor_username: state.me.member.username, target_username: owner.username },
            voted,
            { links: false }
          ),
          href: postDest(voted, state.me.member.username),
          from_id: state.me.member.member_id,
          from_username: state.me.member.username,
        });
      }
      toast(choice === "up" ? t("prof.youUp") : t("prof.youDown"));
      redraw();
    }
    if (send) {
      const postId = send.dataset.sendCmt;
      const input = document.querySelector(`[data-cmt="${postId}"]`);
      const text = input?.value.trim();
      if (!text) return;
      await supabaseRequest("/rest/v1/post_comments", {
        method: "POST",
        body: JSON.stringify({
          post_id: postId,
          member_id: state.me.member.member_id,
          username: state.me.member.username,
          comment: text,
        }),
      });
      redraw();
    }
  }

  /* ---------- Market: what the member published in the market (sql/market.sql) ---------- */
  // The Visit store button on top, then their recommendations, purchase lists and reviews that
  // the viewer may see (public / exclusive / private, as for the videos). Their purchases stay
  // private. Cards and dialogs: js/market-forms.js.
  const MK_TABS = ["recs", "lists", "reviews"];
  // #market | #market/recs | #market/lists | #market/reviews -> { tab }; null for any other hash
  function mkFromHash(hash = location.hash) {
    const m = /^#market(?:\/(recs|lists|reviews))?$/.exec(String(hash || ""));
    return m ? { tab: m[1] || "recs" } : null;
  }
  function mkState() {
    const host = state.hostMember?.member_id || "";
    if (!state.mk || state.mk.host !== host) {
      state.mk = { host, tab: "recs", items: [], total: 0, counts: null, store: undefined, seq: 0 };
    }
    return state.mk;
  }
  const mkHash = () => {
    const tab = mkState().tab;
    return `#market${tab && tab !== "recs" ? `/${tab}` : ""}`;
  };
  const mkWait = `<div class="loader" style="display:grid"><div class="spinner"></div></div>`;

  async function drawMarket() {
    const body = $("#home-body");
    if (!body) return;
    // the activity wall binds its click handler on #home-body
    body.onclick = null;
    const M = window.CineAuraMarket;
    if (!M) {
      body.innerHTML = `<p class="empty">${escapeHtml(t("mkt.setupText"))}</p>`;
      return;
    }
    const mk = mkState();
    body.innerHTML = `
      <section class="pm auth-allow" aria-label="${escapeHtml(t("prof.marketTab"))}">
        <div class="glass pm-store" id="pm-store">${mkWait}</div>
        <div class="follow-tabs pm-tabs" role="tablist" aria-label="${escapeHtml(t("prof.mk.tabsLabel"))}">
          ${MK_TABS.map((k) => `<button type="button" role="tab" class="follow-tab${mk.tab === k ? " active" : ""}" data-mk-tab="${k}" aria-selected="${mk.tab === k}">${escapeHtml(t(`prof.mk.${k}`))}<span class="follow-count" data-mk-count="${k}" hidden></span></button>`).join("")}
        </div>
        ${state.isOwner ? `<p class="muted pm-hint">${escapeHtml(t("prof.mk.hintMine"))} <a href="./Market.html">${escapeHtml(t("prof.mk.goMarket"))}</a></p>` : ""}
        <div class="pm-list" id="pm-list" aria-live="polite"></div>
        <div class="pm-more"><button class="btn btn-sm btn-ghost" type="button" data-mk-more hidden>${escapeHtml(t("vid.showMore"))}</button></div>
      </section>`;
    body.querySelectorAll("[data-mk-tab]").forEach((b) => {
      b.onclick = () => {
        if (mk.tab === b.dataset.mkTab) return;
        mk.tab = b.dataset.mkTab;
        replaceHash(mkHash());
        mkShowTab();
      };
    });
    body.querySelector("[data-mk-more]").onclick = () => mkLoad(true);
    M.wireItems($("#pm-list"), { items: () => mkState().items, changed: () => mkLoad(false) });
    await mkLoad(false);
  }

  function mkShowTab() {
    const mk = mkState();
    document.querySelectorAll("[data-mk-tab]").forEach((b) => {
      const on = b.dataset.mkTab === mk.tab;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
    });
    mkLoad(false);
  }

  async function mkLoad(more) {
    const M = window.CineAuraMarket;
    const mk = mkState();
    const list = $("#pm-list");
    if (!M || !list) return;
    const seq = (mk.seq += 1);
    const btn = document.querySelector("[data-mk-more]");
    if (!more) list.innerHTML = mkWait;
    if (btn) btn.disabled = true;
    const res = await M.call("market_profile", {
      p_owner: state.hostMember?.member_id || "",
      p_member: M.memberId(),
      p_tab: mk.tab,
      p_limit: 24,
      p_offset: more ? mk.items.length : 0,
    });
    if (seq !== mk.seq || !list.isConnected) return;
    if (btn) btn.disabled = false;
    if (!res.ok || !res.data?.ok) {
      const text = res.setup ? t("mkt.setupText") : res.ok ? t("prof.mk.gone") : M.failText(res);
      list.innerHTML = `<p class="empty">${escapeHtml(text)}</p>`;
      if ($("#pm-store")) $("#pm-store").hidden = true;
      if (btn) btn.hidden = true;
      return;
    }
    const d = res.data;
    mk.items = more ? mk.items.concat(d.items || []) : d.items || [];
    mk.total = Number(d.total) || 0;
    mk.counts = d.counts || null;
    mk.store = d.store || null;
    mkPaintStore();
    MK_TABS.forEach((k) => {
      const el = document.querySelector(`[data-mk-count="${k}"]`);
      const n = mk.counts ? Number(mk.counts[k]) || 0 : null;
      if (!el) return;
      el.hidden = n == null;
      el.textContent = n == null ? "" : String(n);
    });
    list.innerHTML = mk.items.length ? mk.items.map(M.itemHtml).join("") : mkEmptyHtml();
    if (btn) btn.hidden = mk.items.length >= mk.total;
    hydrateAvatars(list);
  }

  function mkEmptyHtml() {
    const tab = mkState().tab;
    const name = `<bdi>@${escapeHtml(state.hostMember?.username || "")}</bdi>`;
    return `<div class="glass vs-none pc-none"><p>${state.isOwner ? escapeHtml(t(`prof.mk.none.${tab}Mine`)) : t(`prof.mk.none.${tab}`, { name })}</p></div>`;
  }

  // The member's store and its Visit store button (none: Open your store, for its owner).
  function mkPaintStore() {
    const M = window.CineAuraMarket;
    const box = $("#pm-store");
    if (!box || !M) return;
    const s = mkState().store;
    box.hidden = false;
    if (s) {
      const meta = [M.country(s.country), t(Number(s.products) === 1 ? "mkt.productsOne" : "mkt.productsN", { n: M.fmt(s.products) })].filter(Boolean).join(" · ");
      box.innerHTML = `
        <img class="pm-store-logo" src="${escapeHtml(s.logo || initialsAvatar(s.name || "CA"))}" alt="" />
        <div class="pm-store-body">
          <span class="eyebrow">${escapeHtml(t("prof.mk.store"))}</span>
          <b><span dir="auto">${escapeHtml(s.name || "")}</span>${M.tierHtml(s.tier)}</b>
          <small class="muted">${escapeHtml(meta)}</small>
        </div>
        <a class="btn btn-sm btn-primary pm-visit" href="${escapeHtml(M.storeHref(s.id))}">${M.ICON.store}<span>${escapeHtml(t("prof.mk.visit"))}</span></a>`;
      return;
    }
    if (state.isOwner) {
      box.innerHTML = `
        <div class="pm-store-body"><b>${escapeHtml(t("prof.mk.noStoreMine"))}</b><small class="muted">${escapeHtml(t("prof.mk.noStoreMineHint"))}</small></div>
        <a class="btn btn-sm btn-primary pm-visit" href="./Market.html#settings">${M.ICON.store}<span>${escapeHtml(t("mkt.openStore"))}</span></a>`;
      return;
    }
    const name = `<bdi>@${escapeHtml(state.hostMember?.username || "")}</bdi>`;
    box.innerHTML = `<div class="pm-store-body"><b>${t("prof.mk.noStore", { name })}</b></div>
      <a class="btn btn-sm btn-ghost pm-visit" href="./Market.html">${M.ICON.bag}<span>${escapeHtml(t("prof.mk.goMarket"))}</span></a>`;
  }

  async function drawUpdates() {
    const body = $("#home-body");
    if (!state.isOwner) {
      body.innerHTML = `<p class="muted">${t("prof.updatesOwn")}</p>`;
      return;
    }
    const fol = await supabaseRequest(
      `/rest/v1/follows?follower_id=eq.${restValue(state.me.member.member_id)}&status=eq.accepted&select=following_id,following_username`
    );
    const blk = await supabaseRequest(
      `/rest/v1/blocks?blocked_id=eq.${restValue(state.me.member.member_id)}&select=blocker_id,kind,features`
    );
    const hidden = new Set(
      (blk.data || [])
        .filter(
          (b) =>
            b.kind === "full" ||
            String(b.features || "")
              .split(",")
              .map((s) => s.trim())
              .includes("updates")
        )
        .map((b) => b.blocker_id)
    );
    const ids = (fol.data || []).map((f) => f.following_id).filter((id) => !hidden.has(id));
    body.innerHTML = `
      <div class="filter-bar">
        <div class="filter-group">
          <span class="muted">${t("prof.updF.type")}</span>
          <label class="lang-chip"><input type="radio" name="up-ft" value="all" checked /> ${t("prof.updF.all")}</label>
          <label class="lang-chip"><input type="radio" name="up-ft" value="video" /> ${t("prof.updF.videos")}</label>
          <label class="lang-chip"><input type="radio" name="up-ft" value="playlist" /> ${t("prof.updF.playlists")}</label>
          <label class="lang-chip"><input type="radio" name="up-ft" value="rec" /> ${t("prof.updF.recs")}</label>
          <label class="lang-chip"><input type="radio" name="up-ft" value="review" /> ${t("rev.reviews")}</label>
          <label class="lang-chip"><input type="radio" name="up-ft" value="market" /> ${t("prof.updF.market")}</label>
        </div>
      </div>
      <div class="ad-spot" data-ad="banner"></div>
      <div id="upd-list"></div>
      <section class="person-updates">
        <div class="section-head">
          <div>
            <div class="kicker"><span class="eyebrow">${t("prof.peopleYouFollow")}</span></div>
            <h2>${t("prof.newWorkTitle")}</h2>
          </div>
        </div>
        <div id="person-upd-list"><p class="muted">${t("common.loading")}</p></div>
      </section>`;
    if (!ids.length) {
      $("#upd-list").innerHTML = `<p class="empty">${t("prof.followToSee")}</p>`;
      await drawPersonUpdates();
      return;
    }
    $("#upd-list").innerHTML = `<p class="muted">${t("common.loading")}</p>`;
    // The videos the members I follow published (sql/content.sql), newest first, a page
    // at a time; they join the other updates by date.
    const V = window.CineAuraVideos;
    const feed = { items: [], more: false };
    const loadVideos = async () => {
      if (!V) return;
      const last = feed.items[feed.items.length - 1];
      const res = await V.call("content_feed", {
        p_member: state.me.member.member_id,
        p_limit: 20,
        p_before: last ? last.publish_at : null,
        p_before_id: last ? last.id : "",
      });
      if (!res.ok || res.data?.ok === false) {
        feed.more = false;
        return;
      }
      const seen = new Set(feed.items.map((v) => v.id));
      feed.items.push(...(Array.isArray(res.data?.items) ? res.data.items : []).filter((v) => !seen.has(v.id)));
      feed.more = Boolean(res.data?.more);
    };
    const videosReady = loadVideos();
    // What they published in the market (sql/market.sql): recommendations (and recommended again),
    // purchase lists, reviews; newest first, a page at a time, joined by date too.
    const MK = window.CineAuraMarket;
    const mfeed = { items: [], more: false };
    const loadMarket = async () => {
      if (!MK) return;
      const last = mfeed.items[mfeed.items.length - 1];
      const res = await MK.call("market_feed", {
        p_member: state.me.member.member_id,
        p_limit: 20,
        p_before: last ? last.at : null,
        p_before_id: last ? last.feed_id : "",
      });
      if (!res.ok || res.data?.ok === false) {
        mfeed.more = false;
        return;
      }
      const seen = new Set(mfeed.items.map((x) => x.feed_id));
      mfeed.items.push(...(Array.isArray(res.data?.items) ? res.data.items : []).filter((x) => !seen.has(x.feed_id)));
      mfeed.more = Boolean(res.data?.more);
    };
    const marketReady = loadMarket();
    const upd = await supabaseRequest(
      `/rest/v1/updates?actor_id=in.(${ids.join(",")})&select=*&order=created_at.desc&limit=120`
    );
    const rows = (upd.data || []).filter((r) => r.post_id && !hidden.has(r.actor_id));
    const postIds = [...new Set(rows.map((r) => r.post_id))];
    const posts = postIds.length
      ? await supabaseRequest(`/rest/v1/posts?post_id=in.(${postIds.join(",")})&select=*`)
      : { data: [] };
    const postMap = {};
    (posts.data || []).forEach((p) => {
      postMap[p.post_id] = p;
    });

    // Somebody else's private / exclusive post must not open up in my feed.
    const accessAll = postIds.length
      ? await supabaseRequest(`/rest/v1/post_access?select=post_id,username`)
      : { data: [] };
    const access = {};
    (accessAll.data || []).forEach((a) => {
      (access[a.post_id] = access[a.post_id] || []).push(a.username);
    });
    const watchedSet = new Set();
    if (state.me?.member?.member_id) {
      const [vw, hs] = await Promise.all([
        supabaseRequest(`/rest/v1/views?viewer_id=eq.${restValue(state.me.member.member_id)}&select=tmdb_id`),
        supabaseRequest(`/rest/v1/hestory?visitor_id=eq.${restValue(state.me.member.member_id)}&select=tmdb_id`),
      ]);
      (vw.data || []).forEach((r) => watchedSet.add(Number(r.tmdb_id)));
      (hs.data || []).forEach((r) => watchedSet.add(Number(r.tmdb_id)));
    }

    // One feed entry per post; every actor that touched it is listed on top.
    const groups = new Map();
    rows.forEach((r) => {
      const p = postMap[r.post_id];
      if (!p) return; // post is gone
      const open = canSeeFeedPost(p, access[p.post_id] || [], watchedSet);
      const key = `${open ? "p" : "x"}:${r.post_id}`;
      if (!groups.has(key)) groups.set(key, { post: p, open, actions: [] });
      groups.get(key).actions.push(r);
    });
    const entries = [...groups.values()];
    const openPosts = entries.filter((g) => g.open).map((g) => g.post);
    const openIds = openPosts.map((p) => p.post_id).join(",");
    const itemMap = {};
    const voteMap = {};
    const cmtMap = {};
    if (openIds) {
      const [items, votes, comments] = await Promise.all([
        supabaseRequest(`/rest/v1/post_items?post_id=in.(${openIds})&select=*`),
        supabaseRequest(`/rest/v1/post_votes?post_id=in.(${openIds})&select=*`),
        supabaseRequest(`/rest/v1/post_comments?post_id=in.(${openIds})&select=*&order=created_at.asc`),
      ]);
      (items.data || []).forEach((it) => {
        (itemMap[it.post_id] = itemMap[it.post_id] || []).push(it);
      });
      (votes.data || []).forEach((v) => {
        (voteMap[v.post_id] = voteMap[v.post_id] || []).push(v);
      });
      (comments.data || []).forEach((c) => {
        (cmtMap[c.post_id] = cmtMap[c.post_id] || []).push(c);
      });
    }
    openPosts.forEach((p) => state.postCache.set(p.post_id, p));
    await videosReady;
    await marketReady;
    await primeAvatars(
      [...rows.map((r) => r.actor_id), ...feed.items.map((v) => v.owner_id), ...mfeed.items.map((x) => x.author?.id)],
      [...rows.map((r) => r.actor_username), ...feed.items.map((v) => v.owner), ...mfeed.items.map((x) => x.author?.username)]
    );
    await enrichItemMap(openPosts, itemMap);

    // One line per actor (a changed vote replaces its own line).
    const actorLines = (actions) => {
      const seen = new Set();
      return actions.filter((r) => {
        const k = `${r.actor_id}|${r.kind}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    };
    const leadHtml = (g) => {
      const head = actorLines(g.actions).slice(0, 3);
      const extra = actorLines(g.actions).length - head.length;
      const first = head[0];
      const who = (r) => `<a href="${profileHref(r.actor_username)}"><strong>@${escapeHtml(String(r.actor_username || "").replace(/^@/, ""))}</strong></a>`;
      return `<div class="upd-lead">
        ${avatarImg(first.actor_id, first.actor_username)}
        <div class="upd-lead-body">
          ${head
            .map((r) => `<p class="upd-lead-line">${g.open ? updateLine(r, g.post) : t("prof.updHidden", { actor: who(r) })}</p>`)
            .join("")}
          ${extra > 0 ? `<p class="upd-lead-line muted">${t("prof.updMore", { n: extra })}</p>` : ""}
          <div class="upd-lead-time muted">${escapeHtml(String(first.created_at || "").slice(0, 16).replace("T", " "))}</div>
        </div>
      </div>`;
    };
    // A new video of somebody I follow: the same lead line as the other entries, then
    // its card (Content.html?idcontent=…).
    const videoHtml = (v) => {
      const owner = String(v.owner || "").replace(/^@/, "");
      const actor = `<a href="${profileHref(owner)}"><strong><bdi>@${escapeHtml(owner)}</bdi></strong></a>`;
      return `<article class="post-card upd-card upd-video" data-feed-video="${escapeHtml(v.id)}" data-owner="${escapeHtml(v.owner_id || "")}">
        <div class="upd-lead">
          ${avatarImg(v.owner_id, owner)}
          <div class="upd-lead-body">
            <p class="upd-lead-line">${t("prof.updLineVideo", { actor })}</p>
            <div class="upd-lead-time muted">${escapeHtml(String(v.publish_at || "").slice(0, 16).replace("T", " "))}</div>
          </div>
        </div>
        ${V.cardHtml(v, { vis: true })}
      </article>`;
    };
    const postEntryHtml = (g) => {
      const p = g.post;
      const head = leadHtml(g);
      if (!g.open) {
        return `<article class="post-card upd-card upd-hidden" data-post="${escapeHtml(p.post_id)}" data-owner="${escapeHtml(p.owner_id || "")}">${head}</article>`;
      }
      return `<article class="post-card upd-card kind-${escapeHtml(p.kind)}" data-post="${escapeHtml(p.post_id)}" data-owner="${escapeHtml(p.owner_id || "")}">
        ${head}
        ${postCardInnerHtml(p, itemMap[p.post_id] || [], voteMap[p.post_id] || [], cmtMap[p.post_id] || [])}
      </article>`;
    };
    const timeOf = (iso) => Date.parse(iso || "") || 0;
    const draw = () => {
      const f = document.querySelector('input[name="up-ft"]:checked')?.value || "all";
      const postList = f === "video" ? [] : entries.filter((g) => {
        if (!g.open) return f === "all";
        const kind = g.post.kind;
        if (f === "playlist") return kind === "playlist";
        if (f === "rec") {
          return (
            ["recommendation", "reclist"].includes(kind) ||
            g.actions.some((r) => r.kind === "vote_up" || r.kind === "vote_down")
          );
        }
        if (f === "review") return kind === "review";
        return true;
      });
      const withVideos = V && (f === "all" || f === "video");
      // the market: all of it, or its recommendations / its reviews with the posts' ones
      const withMarket = MK && ["all", "market", "rec", "review"].includes(f);
      const marketList = !withMarket ? [] : mfeed.items.filter((x) => (f === "rec" ? x.type === "rec" : f === "review" ? x.type === "review" : true));
      // While older videos or market updates are still to come, the older entries wait with them
      // (the feed stays in date order).
      const cuts = [];
      if (withVideos && feed.more && feed.items.length) cuts.push(timeOf(feed.items[feed.items.length - 1].publish_at));
      if (withMarket && mfeed.more && mfeed.items.length) cuts.push(timeOf(mfeed.items[mfeed.items.length - 1].at));
      const cutoff = cuts.length ? Math.max(...cuts) : -Infinity;
      const list = [
        ...postList.map((g) => ({ at: timeOf(g.actions[0]?.created_at), g })),
        ...(withVideos ? feed.items.map((v) => ({ at: timeOf(v.publish_at), v })) : []),
        ...marketList.map((x) => ({ at: timeOf(x.at), m: x })),
      ].filter((e) => e.at >= cutoff).sort((a, b) => b.at - a.at);
      const box = $("#upd-list");
      box.innerHTML = list.length
        ? list.map((e) => (e.m ? MK.itemHtml(e.m) : e.v ? videoHtml(e.v) : postEntryHtml(e.g))).join("")
        : `<p class="empty">${t("prof.noUpd")}</p>`;
      if ((withVideos && feed.more) || (withMarket && mfeed.more)) {
        box.insertAdjacentHTML(
          "beforeend",
          `<div class="upd-more"><button class="btn btn-sm btn-ghost" type="button" data-upd-more>${t("vid.showMore")}</button></div>`
        );
      }
      // Ad inside the feed, after the second entry (or after the first when there is only one).
      const cards = box.querySelectorAll(".upd-card");
      if (cards.length) {
        const spot = document.createElement("div");
        spot.className = "ad-spot";
        spot.dataset.ad = "rect";
        cards[Math.min(1, cards.length - 1)].after(spot);
      }
      hydrateAvatars(box);
      trackImpressions(box, list.filter((e) => e.g).map((e) => e.g.post));
      if (V) V.observeCards(box);
    };
    $$('input[name="up-ft"]').forEach((el) => {
      el.onchange = draw;
    });
    draw();
    // The activity wall binds its click handler on #home-body: drop it here so a
    // stale copy cannot react to votes / comments inside the updates feed.
    body.onclick = null;
    $("#upd-list").onclick = async (e) => {
      const more = e.target.closest("[data-upd-more]");
      if (more) {
        more.disabled = true;
        await Promise.all([feed.more ? loadVideos() : null, mfeed.more ? loadMarket() : null]);
        await primeAvatars(
          [...feed.items.map((v) => v.owner_id), ...mfeed.items.map((x) => x.author?.id)],
          [...feed.items.map((v) => v.owner), ...mfeed.items.map((x) => x.author?.username)]
        );
        draw();
        return;
      }
      if (e.target.closest("[data-mi]")) return; // the market cards (js/market-forms.js)
      onPostClick(e, () => drawUpdates());
    };
    MK?.wireItems($("#upd-list"), { items: () => mfeed.items, changed: () => drawUpdates() });
    await drawPersonUpdates();
  }

  /* ---------- New work by cast & crew members you follow ---------- */
  async function drawPersonUpdates() {
    const box = $("#person-upd-list");
    if (!box || !state.me) return;
    const me = state.me.member.member_id;
    const [fol, blk] = await Promise.all([
      supabaseRequest(
        `/rest/v1/person_follows?member_id=eq.${restValue(me)}&select=person_id,person_name&order=created_at.desc&limit=30`
      ),
      supabaseRequest(`/rest/v1/person_blocks?member_id=eq.${restValue(me)}&select=person_id&limit=30`),
    ]);
    if (fol.data?.code === "PGRST205" || blk.data?.code === "PGRST205") {
      box.innerHTML = `<p class="empty">${t("prof.personSql")}</p>`;
      return;
    }
    // A blocked person never shows up again, in any work they take part in.
    const blocked = new Set((blk.data || []).map((r) => Number(r.person_id)));
    const people = (fol.data || []).filter((r) => !blocked.has(Number(r.person_id)));
    if (!people.length) {
      box.innerHTML = `<p class="empty">${t("prof.noPersonFollow")}</p>`;
      return;
    }
    box.innerHTML = `<p class="muted">${t("common.loading")}</p>`;

    const works = new Map();
    await Promise.all(
      people.map(async (p) => {
        const info = await personCredits(p.person_id);
        works.set(Number(p.person_id), {
          id: Number(p.person_id),
          name: p.person_name,
          photo: info.profile_path,
          keys: new Set(info.works),
        });
      })
    );
    const blockedKeys = new Set();
    await Promise.all(
      [...blocked].map(async (id) => {
        const info = await personCredits(id);
        info.works.forEach((k) => blockedKeys.add(k));
      })
    );

    const blkRes = await supabaseRequest(
      `/rest/v1/blocks?blocked_id=eq.${restValue(me)}&select=blocker_id,kind,features`
    );
    const hidden = new Set(
      (blkRes.data || [])
        .filter(
          (b) =>
            b.kind === "full" ||
            String(b.features || "")
              .split(",")
              .map((s) => s.trim())
              .includes("updates")
        )
        .map((b) => b.blocker_id)
    );

    const postsRes = await supabaseRequest(`/rest/v1/posts?select=*&order=created_at.desc&limit=60`);
    const posts = (postsRes.data || []).filter(
      (p) => (p.visibility === "public" || p.owner_id === me) && !hidden.has(p.owner_id)
    );
    let itemsByPost = {};
    if (posts.length) {
      const ids = posts.map((p) => p.post_id).join(",");
      const itemsRes = await supabaseRequest(`/rest/v1/post_items?post_id=in.(${ids})&select=*`);
      (itemsRes.data || []).forEach((it) => {
        (itemsByPost[it.post_id] = itemsByPost[it.post_id] || []).push(it);
      });
    }

    const rows = [];
    posts.forEach((p) => {
      const items = itemsByPost[p.post_id] || [];
      if (!items.length) return;
      const blockedHit = items.some(
        (it) =>
          (it.media_type === "person" && blocked.has(Number(it.tmdb_id))) ||
          (it.media_type !== "person" && blockedKeys.has(`${it.media_type}:${it.tmdb_id}`))
      );
      if (blockedHit) return;
      const hits = [];
      items.forEach((it) => {
        if (it.media_type === "person") {
          const w = works.get(Number(it.tmdb_id));
          if (w) hits.push(w);
          return;
        }
        const key = `${it.media_type}:${it.tmdb_id}`;
        works.forEach((w) => {
          if (w.keys.has(key) && !hits.some((h) => h.id === w.id)) hits.push(w);
        });
      });
      if (hits.length) rows.push({ post: p, people: hits });
    });

    // Same full post card as the rest of the feed, with the followed cast
    // members as the lead line.
    const rowIds = rows.map((r) => r.post.post_id).join(",");
    const voteMap = {};
    const cmtMap = {};
    if (rowIds) {
      const [votesRes, cmtsRes] = await Promise.all([
        supabaseRequest(`/rest/v1/post_votes?post_id=in.(${rowIds})&select=*`),
        supabaseRequest(`/rest/v1/post_comments?post_id=in.(${rowIds})&select=*&order=created_at.asc`),
      ]);
      (votesRes.data || []).forEach((v) => {
        (voteMap[v.post_id] = voteMap[v.post_id] || []).push(v);
      });
      (cmtsRes.data || []).forEach((c) => {
        (cmtMap[c.post_id] = cmtMap[c.post_id] || []).push(c);
      });
    }
    rows.forEach((r) => state.postCache.set(r.post.post_id, r.post));
    await enrichItemMap(rows.map((r) => r.post), itemsByPost);

    const kindLabel = (p) =>
      p.kind === "playlist"
        ? t("dash.nav.playlists")
        : p.kind === "review"
          ? t("rev.review")
          : p.kind === "reclist"
            ? t("prof.recList")
            : t("prof.recs");
    box.innerHTML = `
      <div class="filter-bar">
        <div class="filter-group pf-chips">
          <span class="muted">${t("prof.peopleYouFollow")}</span>
          ${people
            .map(
              (p) => `<span class="lang-chip pf-chip">
                <a href="${personHref(p.person_id)}">${escapeHtml(p.person_name || `#${p.person_id}`)}</a>
                <button type="button" data-pf-unfollow="${p.person_id}" aria-label="${t("cast.unfollow")}">✕</button>
              </span>`
            )
            .join("")}
        </div>
      </div>
      ${
        rows.length
          ? rows
              .map(({ post, people: hits }) => {
                const dest = post.playlist_id
                  ? `./Playlist.html?ID=${encodeURIComponent(post.playlist_id)}`
                  : profileHref(post.owner_username);
                const names = hits
                  .map((w) => `<a class="chip" href="${personHref(w.id)}">${escapeHtml(w.name || `#${w.id}`)}</a>`)
                  .join(" ");
                return `<article class="post-card upd-card person-work" data-post="${escapeHtml(post.post_id)}">
                  <div class="upd-lead">
                    ${avatarImg(post.owner_id, post.owner_username)}
                    <div class="upd-lead-body">
                      <p class="upd-lead-line">
                        <a href="${profileHref(post.owner_username)}"><strong>@${escapeHtml(post.owner_username || "")}</strong></a>
                        · <span class="muted">${escapeHtml(kindLabel(post))}</span>
                        <a href="${dest}"><strong>${escapeHtml(post.title || post.post_id)}</strong></a>
                      </p>
                      <p class="upd-lead-line muted">${t("prof.newWorkBy")} ${names}</p>
                      <div class="upd-lead-time muted">${escapeHtml(String(post.created_at || "").slice(0, 16).replace("T", " "))}</div>
                    </div>
                  </div>
                  ${postCardInnerHtml(post, itemsByPost[post.post_id] || [], voteMap[post.post_id] || [], cmtMap[post.post_id] || [])}
                </article>`;
              })
              .join("")
          : `<p class="empty">${t("prof.noPersonUpd")}</p>`
      }`;
    hydrateAvatars(box);
    box.onclick = async (e) => {
      const btn = e.target.closest("[data-pf-unfollow]");
      if (!btn) {
        // Votes / comments inside these cards behave like everywhere else.
        onPostClick(e, () => drawUpdates());
        return;
      }
      const id = Number(btn.dataset.pfUnfollow);
      const res = await supabaseRequest(
        `/rest/v1/person_follows?member_id=eq.${restValue(me)}&person_id=eq.${id}`,
        { method: "DELETE" }
      );
      if (!res.ok) return toast(t("cast.actFail"));
      toast(t("cast.unfollowed", { name: btn.closest(".pf-chip")?.querySelector("a")?.textContent || "" }));
      drawPersonUpdates();
    };
  }

  function exclusiveFields(prefix) {
    return `
      <div class="vis-fields stack" id="${prefix}-excl" hidden>
        <p class="muted">Exclusive: who may see this.</p>
        <label class="lang-chip"><input type="checkbox" id="${prefix}-fol" /> Followers only</label>
        <div class="form-row">
            <input id="${prefix}-minage" type="number" placeholder="${t("prof.minAge")}" />
          <input id="${prefix}-maxage" type="number" placeholder="${t("prof.maxAge")}" />
        </div>
            <input id="${prefix}-lang" placeholder="${t("prof.langsPh")}" />
            <input id="${prefix}-cty" placeholder="${t("prof.ctyPh")}" />
            <input id="${prefix}-watched" placeholder="${t("prof.mustWatched")}" />
            <input id="${prefix}-actor" placeholder="${t("prof.actorPh")}" />
            <input id="${prefix}-director" placeholder="${t("prof.directorPh")}" />
            <input id="${prefix}-title" placeholder="${t("prof.titlePh")}" />
        <div class="form-row">
          <select id="${prefix}-yearmode">
            <option value="">Year filter off</option>
            <option value="in">Released in</option>
            <option value="before">Before</option>
            <option value="after">After</option>
          </select>
            <input id="${prefix}-year" type="number" placeholder="${t("prof.year")}" />
        </div>
      </div>
      <div class="vis-fields stack" id="${prefix}-priv" hidden>
            <input id="${prefix}-people" placeholder="${t("dash.peoplePh")}" />
      </div>`;
  }

  function bindVis(prefix) {
    const vis = $(`#${prefix}-vis`);
    const sync = () => {
      $(`#${prefix}-excl`).hidden = vis.value !== "exclusive";
      $(`#${prefix}-priv`).hidden = vis.value !== "private";
    };
    vis.onchange = sync;
    sync();
  }

  function readVis(prefix) {
    const visibility = $(`#${prefix}-vis`).value;
    const people = String($(`#${prefix}-people`)?.value || "")
      .split(/[,;\n]+/)
      .map((s) => s.trim().replace(/^@/, ""))
      .filter(Boolean);
    if (visibility === "private" && !people.length) {
      toast(t("prof.privNeed"));
      return null;
    }
    return {
      visibility,
      people,
      require_followers: Boolean($(`#${prefix}-fol`)?.checked),
      min_age: Number($(`#${prefix}-minage`)?.value) || null,
      max_age: Number($(`#${prefix}-maxage`)?.value) || null,
      languages: $(`#${prefix}-lang`)?.value.trim() || "",
      countries: $(`#${prefix}-cty`)?.value.trim() || "",
      watched_tmdb: $(`#${prefix}-watched`)?.value.trim() || "",
      actors: $(`#${prefix}-actor`)?.value.trim() || "",
      directors: $(`#${prefix}-director`)?.value.trim() || "",
      titles: $(`#${prefix}-title`)?.value.trim() || "",
      year_mode: $(`#${prefix}-yearmode`)?.value || "",
      year_value: Number($(`#${prefix}-year`)?.value) || null,
    };
  }

  async function saveAccess(postId, people) {
    await supabaseRequest(`/rest/v1/post_access?post_id=eq.${restValue(postId)}`, { method: "DELETE" });
    if (!people.length) return;
    await supabaseRequest("/rest/v1/post_access", {
      method: "POST",
      body: JSON.stringify(people.map((username) => ({ post_id: postId, username }))),
    });
  }

  async function viewCreate(main) {
    const lists = await supabaseRequest(
      `/rest/v1/playlists?owner_id=eq.${restValue(state.me.member.member_id)}&select=playlist_id,name,media_type`
    );
    const playlists = lists.data || [];
    main.innerHTML = `
      <p class="eyebrow">Create</p>
      <h1>${t("prof.newPost")}</h1>
      <div class="tabs">
        <button class="btn btn-sm btn-primary" data-ck="playlist" type="button">${t("dash.nav.playlists")}</button>
        <button class="btn btn-sm btn-ghost" data-ck="recommendation" type="button">${t("prof.recs")}</button>
        <button class="btn btn-sm btn-ghost" data-ck="reclist" type="button">${t("prof.recList")}</button>
        <button class="btn btn-sm btn-ghost" data-ck="review" type="button">${t("rev.review")}</button>
      </div>
      <div id="create-box"></div>`;
    const draw = (kind) => {
      main.querySelectorAll("[data-ck]").forEach((b) => {
        b.className = `btn btn-sm ${b.dataset.ck === kind ? "btn-primary" : "btn-ghost"}`;
      });
      const box = $("#create-box");
      if (kind === "playlist") {
        box.innerHTML = `
          <div class="stack">
            <input id="c-title" placeholder="${t("prof.postTitle")}" />
            <textarea id="c-body" placeholder="${t("home.form.message")}"></textarea>
            <select id="c-pl">
              <option value="">${t("prof.createNew")}</option>
              ${playlists.map((p) => `<option value="${escapeHtml(p.playlist_id)}">${escapeHtml(p.name)}</option>`).join("")}
            </select>
            <div class="form-row" id="c-newpl">
              <input id="c-plname" placeholder="${t("prof.newList")}" />
              <select id="c-pltype"><option value="movie">Movies</option><option value="tv">Series</option></select>
            </div>
            <select id="cr-vis"><option value="public">${t("pm.vis.public")}</option><option value="exclusive">${t("pm.vis.exclusive")}</option><option value="private">${t("pm.vis.private")}</option></select>
            ${exclusiveFields("cr")}
            <button class="btn btn-sm btn-primary" id="c-save" type="button">${t("prof.publishPl")}</button>
          </div>`;
        bindVis("cr");
        $("#c-pl").onchange = () => {
          $("#c-newpl").hidden = Boolean($("#c-pl").value);
        };
        $("#c-save").onclick = () => savePlaylistPost();
      } else {
        drawRichComposer(box, kind);
      }
    };
    main.querySelectorAll("[data-ck]").forEach((b) => {
      b.onclick = () => draw(b.dataset.ck);
    });
    // Content.html > Recommend in a post / Write a review: #create/recommendation/CT… | #create/review/CT…
    const want = state.createWant;
    state.createWant = null;
    if (want && ["recommendation", "reclist", "review"].includes(want.kind)) {
      main.querySelectorAll("[data-ck]").forEach((b) => {
        b.className = `btn btn-sm ${b.dataset.ck === want.kind ? "btn-primary" : "btn-ghost"}`;
      });
      drawRichComposer($("#create-box"), want.kind, { video: want.video });
      return;
    }
    draw("playlist");
  }

  async function savePlaylistPost() {
    if (!(await window.CineAura.guardFeature("posts"))) return;
    const vis = readVis("cr");
    if (!vis) return;
    const title = $("#c-title").value.trim();
    const body = $("#c-body").value.trim();
    if (!title || !body) return toast(t("prof.needTitleDesc"));
    let playlistId = $("#c-pl").value;
    if (!playlistId) {
      const name = $("#c-plname").value.trim();
      if (!name) return toast(t("prof.namePl"));
      playlistId = `IDP${Math.floor(100000000 + Math.random() * 900000000)}`;
      const pl = await supabaseRequest("/rest/v1/playlists", {
        method: "POST",
        body: JSON.stringify({
          playlist_id: playlistId,
          name,
          description: body,
          owner_username: state.me.member.username,
          owner_id: state.me.member.member_id,
          media_type: $("#c-pltype").value,
          kind: "custom",
          visibility: vis.visibility,
        }),
      });
      if (!pl.ok) return toast(t("prof.plFail"));
    }
    await insertPost("playlist", title, body, vis, playlistId, []);
  }

  // ---------- Rich composer: recommendation / list / review ----------
  // (round 31) the items can be TMDB titles or members' videos (CineAura videos, content_search);
  // opts.video: a video to start with (Content.html > Recommend in a post / Write a review)
  function drawRichComposer(box, kind, opts = {}) {
    const d = (state.draft = {
      kind,
      items: [],
      pros: [],
      cons: [],
      display: new Set(Rich.DISPLAY_KEYS),
    });
    const multi = kind === "reclist";
    const isReview = kind === "review";
    const pickLabel = isReview ? t("rev.pickTitle") : multi ? t("rich.pickMany") : t("rich.pickOne");
    const pcCol = (key) => `
      <div class="pc-col ${key}">
        <h5>${t(`rev.${key}`)}</h5>
        <div class="form-row">
          <input id="pc-in-${key}" placeholder="${t(`rev.${key}Ph`)}" />
          <button class="btn btn-sm ${key === "pros" ? "btn-primary" : "btn-danger"}" data-pc-add="${key}" type="button">+</button>
        </div>
        <ul class="pc-list" id="pc-list-${key}"></ul>
      </div>`;
    box.innerHTML = `
      <div class="composer">
        <div class="stack composer-form">
          <label class="field-label" for="tp-q">${pickLabel}</label>
          <div class="tmdb-picker">
            <input id="tp-q" type="search" autocomplete="off" placeholder="${t("rich.searchPh")}" />
            <div class="glass tp-results" id="tp-results" hidden></div>
          </div>
          <p class="muted tp-hint">${t("rich.searchHint")}</p>
          <label class="field-label" for="c-title">${isReview ? t("rev.titleLabel") : t("prof.postTitle")}</label>
          <input id="c-title" placeholder="${isReview ? t("rev.titlePh") : multi ? t("prof.listTitle") : t("prof.recTitle")}" />
          <label class="field-label" for="c-body">${isReview ? t("rev.textLabel") : t("rich.textLabel")}</label>
          <textarea id="c-body" rows="${isReview ? 7 : 4}" placeholder="${isReview ? t("rev.textPh") : t("prof.writeRec")}"></textarea>
          ${isReview ? `<div class="pc-grid">${pcCol("pros")}${pcCol("cons")}</div>` : ""}
          <fieldset class="display-opts">
            <legend>${t("rich.displayTitle")}</legend>
            <p class="muted">${t("rich.displayHint")}</p>
            <label class="lang-chip"><input type="checkbox" name="c-disp" value="info" checked /> ${t("rich.dispInfo")}</label>
            <label class="lang-chip"><input type="checkbox" name="c-disp" value="cast" checked /> ${t("rich.dispCast")}</label>
            <label class="lang-chip"><input type="checkbox" name="c-disp" value="trailer" checked /> ${t("rich.dispTrailer")}</label>
          </fieldset>
          <label class="field-label" for="cr-vis">${t("pm.visibility")}</label>
          <select id="cr-vis"><option value="public">${t("pm.vis.public")}</option><option value="exclusive">${t("pm.vis.exclusive")}</option><option value="private">${t("pm.vis.private")}</option></select>
          ${exclusiveFields("cr")}
          <button class="btn btn-sm btn-primary" id="c-save" type="button">${isReview ? t("rev.publish") : t("prof.publish")}</button>
        </div>
        <aside class="composer-preview">
          <span class="eyebrow">${t("rich.preview")}</span>
          <div id="c-preview"></div>
        </aside>
      </div>`;
    bindVis("cr");

    const preview = () => {
      const out = $("#c-preview");
      if (!out) return;
      const title = $("#c-title")?.value.trim() || "";
      const body = $("#c-body")?.value.trim() || "";
      const fake = {
        kind,
        title,
        body,
        display: Rich.displayString(d.display),
        pros: d.pros,
        cons: d.cons,
        post_id: "",
      };
      const blocks = d.items.length
        ? `<div class="rich-list">${d.items
            .map((it) => Rich.itemHtml(it, d.display, "", { removable: true, compact: multi && d.items.length > 1 }))
            .join("")}</div>`
        : `<p class="empty">${t("rich.noneYet")}</p>`;
      out.innerHTML = `<article class="post-card kind-${kind}">
        <span class="eyebrow">${kindLabel(kind)}</span>
        <h3>${escapeHtml(title || t("rich.untitled"))}</h3>
        ${isReview
          ? `${blocks}<div class="review-text">${escapeHtml(body)}</div>${Rich.reviewListsHtml(fake.pros, fake.cons)}`
          : `${body ? `<p>${escapeHtml(body)}</p>` : ""}${blocks}`}
      </article>`;
    };

    const drawPc = (key) => {
      const ul = $(`#pc-list-${key}`);
      if (!ul) return;
      ul.innerHTML = d[key]
        .map((x, i) => `<li><span>${escapeHtml(x)}</span><button type="button" data-pc-del="${key}:${i}" aria-label="${t("rich.remove")}">✕</button></li>`)
        .join("");
    };
    const addPc = (key) => {
      const input = $(`#pc-in-${key}`);
      const vals = String(input.value || "").split(/\n+/).map((x) => x.trim()).filter(Boolean);
      if (!vals.length) return;
      d[key].push(...vals);
      input.value = "";
      input.focus();
      drawPc(key);
      preview();
    };

    // a member's video (CT…): its card (content_get), never TMDB
    const addVideo = async (id) => {
      const key = `video:${id}`;
      if (d.items.some((it) => Rich.itemKey(it) === key)) return toast(t("rich.already"));
      const results = $("#tp-results");
      if (results) results.hidden = true;
      $("#tp-q").value = "";
      const V = window.CineAuraVideos;
      const res = V ? await V.call("content_get", { p_id: id, p_member: V.memberId() }) : { ok: false };
      const c = res.ok ? res.data?.content : null;
      if (!c || res.data?.access !== "ok") return toast(t("rich.videoGone"));
      const info = Rich.fromVideo(c);
      if (multi) d.items.push(info);
      else d.items = [info];
      const titleInput = $("#c-title");
      if (titleInput && !titleInput.value.trim() && !multi && !isReview) titleInput.value = info.title;
      preview();
    };
    const addItem = async (type, id) => {
      if (type === "video") return addVideo(String(id));
      if (isReview && type === "person") return toast(t("rev.onlyTitles"));
      const key = `${type}:${id}`;
      if (d.items.some((it) => Rich.itemKey(it) === key)) return toast(t("rich.already"));
      const results = $("#tp-results");
      if (results) results.hidden = true;
      $("#tp-q").value = "";
      $("#c-preview").insertAdjacentHTML("afterbegin", `<p class="muted" id="tp-loading">${t("common.loading")}</p>`);
      try {
        const info = await Rich.details(type, id);
        if (multi) d.items.push(info);
        else d.items = [info];
        const titleInput = $("#c-title");
        if (titleInput && !titleInput.value.trim() && !multi && !isReview) titleInput.value = info.title;
      } catch {
        toast(t("rich.loadFail"));
      }
      preview();
    };

    let timer = 0;
    let seq = 0;
    const search = async () => {
      const q = $("#tp-q").value.trim();
      const results = $("#tp-results");
      if (q.length < 2 || parseTmdb(q)) {
        results.hidden = true;
        return;
      }
      const mine = ++seq;
      let rows = [];
      const V = window.CineAuraVideos;
      const [tm, vids] = await Promise.all([
        tmdb(`/search/multi?query=${encodeURIComponent(q)}&include_adult=false&page=1`).catch(() => null),
        V ? V.call("content_search", { p_member: V.memberId(), p_q: q, p_sort: "relevance", p_limit: 5, p_offset: 0 }).catch(() => null) : null,
      ]);
      rows = (tm?.results || []).filter((r) =>
        isReview ? ["movie", "tv"].includes(r.media_type) : ["movie", "tv", "person"].includes(r.media_type)
      );
      const videos = (vids?.ok && Array.isArray(vids.data?.items) ? vids.data.items : []).filter((v) => !v.locked);
      if (mine !== seq) return;
      results.hidden = false;
      const videoRows = videos.map((v) => `<button type="button" class="tp-row" data-tp-type="video" data-tp-id="${escapeHtml(v.id)}">
                <img class="is-video" src="${escapeHtml(v.thumb || initialsAvatar(v.title))}" alt="" referrerpolicy="no-referrer" />
                <span><strong>${escapeHtml(v.title)}</strong><small><bdi>@${escapeHtml(v.owner || "")}</bdi> · ${escapeHtml(t("rich.video"))}<span class="tp-vid">CineAura</span></small></span>
              </button>`).join("");
      results.innerHTML = rows.length || videoRows
        ? videoRows + rows
            .slice(0, 8)
            .map((r) => {
              const title = r.title || r.name || "";
              const year = String(r.release_date || r.first_air_date || "").slice(0, 4);
              const pic = r.poster_path || r.profile_path;
              const type = r.media_type === "tv" ? t("rich.tv") : r.media_type === "person" ? t("rich.person") : t("rich.movie");
              return `<button type="button" class="tp-row" data-tp-type="${r.media_type}" data-tp-id="${r.id}">
                <img src="${escapeHtml(pic ? imgUrl(pic, "w92") : initialsAvatar(title))}" alt="" />
                <span><strong>${escapeHtml(title)}</strong><small>${[year, type].filter(Boolean).join(" · ")}</small></span>
              </button>`;
            })
            .join("")
        : `<p class="muted">${t("rich.noResults")}</p>`;
    };

    // Content.html > Recommend in a post / Write a review: the video is already in
    if (opts.video) addVideo(opts.video);

    $("#tp-q").addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(search, 320);
    });
    $("#tp-q").addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const ref = parseTmdb($("#tp-q").value);
      if (ref) addItem(ref.type, ref.id);
      else search();
    });
    $("#c-title").addEventListener("input", preview);
    $("#c-body").addEventListener("input", preview);
    box.querySelectorAll('input[name="c-disp"]').forEach((el) => {
      el.onchange = () => {
        d.display = new Set([...box.querySelectorAll('input[name="c-disp"]:checked')].map((x) => x.value));
        preview();
      };
    });
    ["pros", "cons"].forEach((key) => {
      $(`#pc-in-${key}`)?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          addPc(key);
        }
      });
    });
    box.onclick = (e) => {
      const row = e.target.closest("[data-tp-id]");
      if (row) return addItem(row.dataset.tpType, row.dataset.tpType === "video" ? row.dataset.tpId : Number(row.dataset.tpId));
      const add = e.target.closest("[data-pc-add]");
      if (add) return addPc(add.dataset.pcAdd);
      const del = e.target.closest("[data-pc-del]");
      if (del) {
        const [key, idx] = del.dataset.pcDel.split(":");
        d[key].splice(Number(idx), 1);
        drawPc(key);
        return preview();
      }
      const rm = e.target.closest("[data-rich-remove]");
      if (rm) {
        e.preventDefault();
        d.items = d.items.filter((it) => Rich.itemKey(it) !== rm.dataset.richRemove);
        return preview();
      }
      if (!e.target.closest(".tmdb-picker")) {
        const results = $("#tp-results");
        if (results) results.hidden = true;
      }
    };
    $("#c-save").onclick = () => saveRichPost(kind);
    preview();
  }

  async function saveRichPost(kind) {
    if (!(await window.CineAura.guardFeature("posts"))) return;
    const d = state.draft;
    if (!d || d.kind !== kind) return;
    const vis = readVis("cr");
    if (!vis) return;
    const title = $("#c-title").value.trim();
    const body = $("#c-body").value.trim();
    if (!d.items.length) return toast(kind === "review" ? t("rev.needTitle") : t("rich.needItem"));
    if (!title || !body) return toast(kind === "review" ? t("rev.needText") : "Title and text are required.");
    const extras = { display: Rich.displayString(d.display) };
    if (kind === "review") {
      extras.pros = d.pros.join("\n");
      extras.cons = d.cons.join("\n");
    }
    await insertPost(kind, title, body, vis, "", d.items.map((it) => Rich.toItemRow(it)), extras);
  }

  async function insertPost(kind, title, body, vis, playlistId, items, extras = {}) {
    const postId = uid("P");
    const row = {
      post_id: postId,
      owner_id: state.me.member.member_id,
      owner_username: state.me.member.username,
      kind,
      title,
      body,
      visibility: vis.visibility,
      playlist_id: playlistId || "",
      require_followers: vis.require_followers,
      min_age: vis.min_age,
      max_age: vis.max_age,
      languages: vis.languages,
      countries: vis.countries,
      watched_tmdb: vis.watched_tmdb,
      actors: vis.actors,
      directors: vis.directors,
      titles: vis.titles,
      year_mode: vis.year_mode,
      year_value: vis.year_value,
    };
    let saved = await supabaseRequest("/rest/v1/posts", { method: "POST", body: JSON.stringify({ ...row, ...extras }) });
    if (!saved.ok && Object.keys(extras).length) {
      // Reviews need the columns + kind from sql/post_reviews.sql; other posts
      // still publish without the display options on an older schema.
      if (kind === "review") return toast(t("rev.needSql"));
      saved = await supabaseRequest("/rest/v1/posts", { method: "POST", body: JSON.stringify(row) });
    }
    if (!saved.ok) return toast(t("prof.pubFail"));
    if (items.length) {
      const rows = items.map((it) => ({ ...it, post_id: postId }));
      const full = await supabaseRequest("/rest/v1/post_items", { method: "POST", body: JSON.stringify(rows) });
      if (!full.ok) {
        await supabaseRequest("/rest/v1/post_items", {
          method: "POST",
          body: JSON.stringify(rows.map((r) => Rich.baseItemRow(r))),
        });
      }
    }
    if (vis.visibility === "private") await saveAccess(postId, vis.people);
    await supabaseRequest("/rest/v1/updates", {
      method: "POST",
      body: JSON.stringify({
        actor_id: state.me.member.member_id,
        actor_username: state.me.member.username,
        kind: "post",
        post_id: postId,
      }),
    });
    await notifyFollowers({
      ownerId: state.me.member.member_id,
      username: state.me.member.username,
      title: t("prof.newPost"),
      body: t("prof.updLinePost", {
        actor: `@${state.me.member.username}`,
        noun: postNoun(kind),
        post: `«${title}»`,
      }),
      href: playlistId
        ? `./Playlist.html?ID=${encodeURIComponent(playlistId)}`
        : profileHref(state.me.member.username),
      visibility: vis.visibility,
    });
    toast(t("prof.published"));
    state.draft = null;
    state.section = "home";
    renderShell();
  }

  // ---------- Post management (owner): visibility, display, delete ----------
  async function deletePost(post) {
    const id = restValue(post.post_id);
    const res = await supabaseRequest(
      `/rest/v1/posts?post_id=eq.${id}&owner_id=eq.${restValue(state.me.member.member_id)}`,
      { method: "DELETE" }
    );
    if (!res.ok) {
      toast(t("pm.delFail"));
      return false;
    }
    await Promise.all(
      ["post_items", "post_access", "post_votes", "post_comments", "updates"].map((tb) =>
        supabaseRequest(`/rest/v1/${tb}?post_id=eq.${id}`, { method: "DELETE" })
      )
    );
    state.postCache.delete(post.post_id);
    return true;
  }

  function confirmDeletePost(post, onDone) {
    const ov = document.createElement("div");
    ov.className = "modal-overlay";
    ov.innerHTML = `<section class="glass modal-card">
      <span class="eyebrow">${kindLabel(post.kind)}</span>
      <h2>${t("pm.delTitle")}</h2>
      <p>${t("pm.delText", { title: escapeHtml(post.title) })}</p>
      <div class="prof-actions" style="margin-top:12px">
        <button class="btn btn-sm btn-danger" id="pd-go" type="button">${t("pm.delete")}</button>
        <button class="btn btn-sm btn-ghost" id="pd-x" type="button">${t("prof.cancel")}</button>
      </div>
    </section>`;
    document.body.appendChild(ov);
    ov.addEventListener("click", async (e) => {
      if (e.target === ov || e.target.closest("#pd-x")) return ov.remove();
      if (!e.target.closest("#pd-go")) return;
      e.target.disabled = true;
      const ok = await deletePost(post);
      ov.remove();
      if (ok) {
        toast(t("pm.deleted"));
        onDone?.();
      }
    });
  }

  async function updatePostVisibility(post, vis, display) {
    const patch = {
      visibility: vis.visibility,
      require_followers: vis.require_followers,
      min_age: vis.min_age,
      max_age: vis.max_age,
      languages: vis.languages,
      countries: vis.countries,
      watched_tmdb: vis.watched_tmdb,
      actors: vis.actors,
      directors: vis.directors,
      titles: vis.titles,
      year_mode: vis.year_mode,
      year_value: vis.year_value,
    };
    const url = `/rest/v1/posts?post_id=eq.${restValue(post.post_id)}&owner_id=eq.${restValue(state.me.member.member_id)}`;
    let res = await supabaseRequest(url, {
      method: "PATCH",
      body: JSON.stringify(display != null ? { ...patch, display } : patch),
    });
    if (!res.ok && display != null) {
      res = await supabaseRequest(url, { method: "PATCH", body: JSON.stringify(patch) });
      if (res.ok) toast(t("pm.displayNeedSql"));
    }
    if (!res.ok) return false;
    await saveAccess(post.post_id, vis.visibility === "private" ? vis.people : []);
    Object.assign(post, patch, display != null ? { display } : {});
    if (post.playlist_id) {
      // keep the linked playlist in step with its post
      await supabaseRequest(`/rest/v1/playlists?playlist_id=eq.${restValue(post.playlist_id)}&owner_id=eq.${restValue(state.me.member.member_id)}`, {
        method: "PATCH",
        body: JSON.stringify({ visibility: vis.visibility }),
      });
    }
    return true;
  }

  async function openPostManager(post, onDone, presetVis) {
    const acc = await supabaseRequest(`/rest/v1/post_access?post_id=eq.${restValue(post.post_id)}&select=username`);
    const people = (acc.ok && Array.isArray(acc.data) ? acc.data : []).map((a) => a.username);
    const rich = RICH_KINDS.includes(post.kind);
    const disp = Rich.parseDisplay(post.display);
    const ov = document.createElement("div");
    ov.className = "modal-overlay";
    ov.innerHTML = `<section class="glass modal-card pm-modal">
      <span class="eyebrow">${kindLabel(post.kind)} · ${String(post.created_at || "").slice(0, 10)}</span>
      <h2>${escapeHtml(post.title)}</h2>
      <div class="stack">
        <label class="field-label" for="em-vis">${t("pm.visibility")}</label>
        <div class="vis-picker" role="radiogroup">
          ${["public", "exclusive", "private"].map((v) => `
            <label class="vis-option">
              <input type="radio" name="em-vis-r" value="${v}" />
              <span><strong>${t(`pm.vis.${v}`)}</strong><small>${t(`pm.visHint.${v}`)}</small></span>
            </label>`).join("")}
        </div>
        <select id="em-vis" hidden><option value="public">public</option><option value="exclusive">exclusive</option><option value="private">private</option></select>
        ${exclusiveFields("em")}
        ${rich ? `<fieldset class="display-opts">
          <legend>${t("rich.displayTitle")}</legend>
          <label class="lang-chip"><input type="checkbox" name="em-disp" value="info" ${disp.has("info") ? "checked" : ""} /> ${t("rich.dispInfo")}</label>
          <label class="lang-chip"><input type="checkbox" name="em-disp" value="cast" ${disp.has("cast") ? "checked" : ""} /> ${t("rich.dispCast")}</label>
          <label class="lang-chip"><input type="checkbox" name="em-disp" value="trailer" ${disp.has("trailer") ? "checked" : ""} /> ${t("rich.dispTrailer")}</label>
        </fieldset>` : ""}
      </div>
      <div class="prof-actions pm-actions">
        <button class="btn btn-sm btn-primary" id="em-save" type="button">${t("common.save")}</button>
        <button class="btn btn-sm btn-ghost" id="em-x" type="button">${t("prof.cancel")}</button>
        <button class="btn btn-sm btn-danger" id="em-del" type="button">${t("pm.delete")}</button>
      </div>
    </section>`;
    document.body.appendChild(ov);
    const set = (id, v) => {
      const el = ov.querySelector(`#${id}`);
      if (el && v != null) el.value = v;
    };
    const visNow = presetVis || post.visibility || "public";
    set("em-vis", visNow);
    ov.querySelector(`input[name="em-vis-r"][value="${visNow}"]`).checked = true;
    ov.querySelector("#em-fol").checked = Boolean(post.require_followers);
    set("em-minage", post.min_age ?? "");
    set("em-maxage", post.max_age ?? "");
    set("em-lang", post.languages || "");
    set("em-cty", post.countries || "");
    set("em-watched", post.watched_tmdb || "");
    set("em-actor", post.actors || "");
    set("em-director", post.directors || "");
    set("em-title", post.titles || "");
    set("em-yearmode", post.year_mode || "");
    set("em-year", post.year_value ?? "");
    set("em-people", people.join(", "));
    bindVis("em");
    ov.querySelectorAll('input[name="em-vis-r"]').forEach((r) => {
      r.onchange = () => {
        const sel = ov.querySelector("#em-vis");
        sel.value = r.value;
        sel.onchange();
      };
    });
    ov.addEventListener("click", async (e) => {
      if (e.target === ov || e.target.closest("#em-x")) return ov.remove();
      if (e.target.closest("#em-del")) {
        ov.remove();
        return confirmDeletePost(post, onDone);
      }
      if (!e.target.closest("#em-save")) return;
      const vis = readVis("em");
      if (!vis) return;
      const display = rich
        ? Rich.displayString(new Set([...ov.querySelectorAll('input[name="em-disp"]:checked')].map((x) => x.value)))
        : null;
      const ok = await updatePostVisibility(post, vis, display);
      if (!ok) return toast(t("pm.saveFail"));
      ov.remove();
      toast(t("pm.saved"));
      onDone?.();
    });
  }

  /* ---------- Your content: Manage posts · Analytics posts ---------- */

  // One time range for both tabs: day, week, month, year, or custom from-to.
  // "all" (the default) leaves both bounds open, so nothing disappears before a
  // period is picked.
  const RANGE_PRESETS = [["all", "pa.all"], ["day", "pa.day"], ["week", "pa.week"], ["month", "pa.month"], ["year", "pa.year"], ["custom", "pa.custom"]];
  const RANGE_DAYS = { day: 0, week: 7, month: 30, year: 365 };

  function rangeOf(ui) {
    const r = ui.range || { preset: "all", from: "", to: "" };
    const now = new Date();
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const days = RANGE_DAYS[r.preset];
    if (days != null) {
      const from = new Date(today);
      from.setDate(from.getDate() - days);
      return { from, to };
    }
    if (r.preset === "custom") {
      const from = r.from ? new Date(`${r.from}T00:00:00`) : null;
      const end = r.to ? new Date(`${r.to}T23:59:59.999`) : null;
      return { from: from && !Number.isNaN(from.getTime()) ? from : null, to: end && !Number.isNaN(end.getTime()) ? end : null };
    }
    return { from: null, to: null };
  }

  function inRange(iso, bounds) {
    if (!iso) return false;
    const when = new Date(iso);
    if (Number.isNaN(when.getTime())) return false;
    if (bounds.from && when < bounds.from) return false;
    if (bounds.to && when > bounds.to) return false;
    return true;
  }

  // Same bounds as a PostgREST filter, so events are counted server-side.
  function rangeQuery(bounds) {
    const parts = [];
    if (bounds.from) parts.push(`created_at=gte.${bounds.from.toISOString()}`);
    if (bounds.to) parts.push(`created_at=lte.${bounds.to.toISOString()}`);
    return parts.length ? `&${parts.join("&")}` : "";
  }

  function rangeText(ui, bounds) {
    const r = ui.range || {};
    if (r.preset === "custom" && (!r.from || !r.to)) return t("pa.needDates");
    const fmt = (d) => (d ? d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }) : t("pa.openEnd"));
    return `${fmt(bounds.from)} → ${fmt(bounds.to)}`;
  }

  function rangeRowHtml(ui) {
    const r = ui.range || { preset: "all", from: "", to: "" };
    return `<div class="pm-range">
      <label class="field-label" for="pm-range">${t("pa.range")}</label>
      <select id="pm-range" aria-label="${t("pa.range")}">
        ${RANGE_PRESETS.map(([value, key]) => `<option value="${value}"${value === r.preset ? " selected" : ""}>${t(key)}</option>`).join("")}
      </select>
      <span class="pm-range-custom"${r.preset === "custom" ? "" : " hidden"}>
        <label class="field-label" for="pm-from">${t("pa.from")}</label>
        <input id="pm-from" type="date" value="${escapeHtml(r.from || "")}" aria-label="${t("pa.from")}" />
        <label class="field-label" for="pm-to">${t("pa.to")}</label>
        <input id="pm-to" type="date" value="${escapeHtml(r.to || "")}" aria-label="${t("pa.to")}" />
      </span>
      <span class="muted pm-range-note" id="pm-range-note"></span>
    </div>`;
  }

  function bindRangeRow(ui, redraw) {
    const sel = document.querySelector("#pm-range");
    if (sel) {
      sel.onchange = () => {
        ui.range.preset = sel.value;
        redraw();
      };
    }
    const onDate = () => {
      ui.range.from = document.querySelector("#pm-from")?.value || "";
      ui.range.to = document.querySelector("#pm-to")?.value || "";
      redraw();
    };
    const from = document.querySelector("#pm-from");
    const to = document.querySelector("#pm-to");
    if (from) from.onchange = onDate;
    if (to) to.onchange = onDate;
  }

  // The section itself: two tabs over one time range.
  async function viewManagePosts(main) {
    const ui = (state.pmUi = state.pmUi || { tab: "manage", kind: "all", vis: "all", q: "" });
    ui.range = ui.range || { preset: "all", from: "", to: "" };
    if (!["manage", "analytics"].includes(ui.tab)) ui.tab = "manage";
    const bounds = rangeOf(ui);
    main.innerHTML = `
      <p class="eyebrow">${t("pm.eyebrow")}</p>
      <h1>${t("pm.sectionTitle")}</h1>
      <div class="tabs">
        <button class="btn btn-sm ${ui.tab === "manage" ? "btn-primary" : "btn-ghost"}" data-pmtab="manage" type="button">${t("pm.tabManage")}</button>
        <button class="btn btn-sm ${ui.tab === "analytics" ? "btn-primary" : "btn-ghost"}" data-pmtab="analytics" type="button">${t("pm.tabAnalytics")}</button>
      </div>
      ${rangeRowHtml(ui)}
      <div id="pm-pane"><p class="muted">${t("common.loading")}</p></div>`;
    const note = main.querySelector("#pm-range-note");
    if (note) note.textContent = rangeText(ui, bounds);
    main.querySelectorAll("[data-pmtab]").forEach((b) => {
      b.onclick = () => {
        if (ui.tab === b.dataset.pmtab) return;
        ui.tab = b.dataset.pmtab;
        viewManagePosts(main);
      };
    });
    bindRangeRow(ui, () => viewManagePosts(main));
    const pane = main.querySelector("#pm-pane");
    if (ui.tab === "analytics") await paneAnalytics(pane, ui);
    else await paneManagePosts(pane, ui);
  }

  async function myPosts() {
    const res = await supabaseRequest(
      `/rest/v1/posts?owner_id=eq.${restValue(state.me.member.member_id)}&select=*&order=created_at.desc`
    );
    const posts = res.ok && Array.isArray(res.data) ? res.data : [];
    posts.forEach((p) => state.postCache.set(p.post_id, p));
    return posts;
  }

  /* --- Tab 1: Manage posts --- */
  async function paneManagePosts(pane, ui) {
    const all = await myPosts();
    const bounds = rangeOf(ui);
    const posts = all.filter((p) => inRange(p.created_at, bounds));
    const ids = posts.map((p) => p.post_id);
    const q = rangeQuery(bounds);
    const [votes, cmts] = ids.length
      ? await Promise.all([
          supabaseRequest(`/rest/v1/post_votes?post_id=in.(${ids.join(",")})${q}&select=post_id,vote`),
          supabaseRequest(`/rest/v1/post_comments?post_id=in.(${ids.join(",")})${q}&select=post_id`),
        ])
      : [{ data: [] }, { data: [] }];
    const stat = {};
    ids.forEach((id) => (stat[id] = { up: 0, down: 0, cmt: 0 }));
    const rows = (res) => (Array.isArray(res?.data) ? res.data : []);
    rows(votes).forEach((v) => stat[v.post_id] && (stat[v.post_id][v.vote] += 1));
    rows(cmts).forEach((c) => stat[c.post_id] && (stat[c.post_id].cmt += 1));
    const count = (v) => posts.filter((p) => (p.visibility || "public") === v).length;
    const refresh = () => viewManagePosts(pane.closest("#prof-main") || document);

    pane.innerHTML = `
      <div class="pm-stats">
        <div class="pm-stat"><strong>${posts.length}</strong><span>${t("pm.total")}</span></div>
        <div class="pm-stat vis-public"><strong>${count("public")}</strong><span>${t("pm.vis.public")}</span></div>
        <div class="pm-stat vis-exclusive"><strong>${count("exclusive")}</strong><span>${t("pm.vis.exclusive")}</span></div>
        <div class="pm-stat vis-private"><strong>${count("private")}</strong><span>${t("pm.vis.private")}</span></div>
      </div>
      <div class="pm-controls">
        <input id="pm-q" type="search" value="${escapeHtml(ui.q)}" placeholder="${t("pm.searchPh")}" />
        <select id="pm-kind">
          <option value="all">${t("prof.allTypes")}</option>
          <option value="playlist">${t("dash.nav.playlists")}</option>
          <option value="recommendation">${t("prof.recs")}</option>
          <option value="reclist">${t("prof.recList")}</option>
          <option value="review">${t("rev.reviews")}</option>
        </select>
        <select id="pm-vis">
          <option value="all">${t("pm.allVis")}</option>
          <option value="public">${t("pm.vis.public")}</option>
          <option value="exclusive">${t("pm.vis.exclusive")}</option>
          <option value="private">${t("pm.vis.private")}</option>
        </select>
      </div>
      <div class="pm-bulk">
        <label class="check-row"><input type="checkbox" id="pm-all" /> ${t("pm.selectAll")}</label>
        <span class="muted" id="pm-selcount"></span>
        <button class="btn btn-sm btn-ghost" data-bulk="public" type="button">${t("pm.makePublic")}</button>
        <button class="btn btn-sm btn-ghost" data-bulk="exclusive" type="button">${t("pm.makeExclusive")}</button>
        <button class="btn btn-sm btn-danger" data-bulk="delete" type="button">${t("pm.deleteSel")}</button>
      </div>
      <div id="pm-list"></div>`;
    pane.querySelector("#pm-kind").value = ui.kind;
    pane.querySelector("#pm-vis").value = ui.vis;

    const filtered = () => {
      const q2 = ui.q.trim().toLowerCase();
      return posts.filter((p) => {
        if (ui.kind !== "all" && p.kind !== ui.kind) return false;
        if (ui.vis !== "all" && (p.visibility || "public") !== ui.vis) return false;
        if (q2 && !`${p.title} ${p.body}`.toLowerCase().includes(q2)) return false;
        return true;
      });
    };
    const selected = () => [...pane.querySelectorAll("[data-pm-check]:checked")].map((x) => state.postCache.get(x.dataset.pmCheck)).filter(Boolean);
    const syncSel = () => {
      const n = selected().length;
      pane.querySelector("#pm-selcount").textContent = n ? t("pm.selected", { n }) : "";
      pane.querySelectorAll("[data-bulk]").forEach((b) => (b.disabled = !n));
    };
    const draw = () => {
      const list = filtered();
      pane.querySelector("#pm-list").innerHTML = list.length
        ? list
            .map((p) => {
              const v = p.visibility || "public";
              const s = stat[p.post_id] || { up: 0, down: 0, cmt: 0 };
              return `<div class="pm-row">
                <input type="checkbox" data-pm-check="${escapeHtml(p.post_id)}" aria-label="${t("pm.select")}" />
                <div class="pm-main">
                  <div class="pm-title"><strong>${escapeHtml(p.title)}</strong><span class="chip">${kindLabel(p.kind)}</span></div>
                  <div class="muted pm-meta">${String(p.created_at || "").slice(0, 16).replace("T", " ")} · 👍 ${s.up} · 👎 ${s.down} · 💬 ${s.cmt}</div>
                  ${shareRowHtml(postHref(p), postShareText(p), { compact: true, label: false, track: p.post_id })}
                </div>
                <select class="pm-vis-select vis-${escapeHtml(v)}" data-pm-vis="${escapeHtml(p.post_id)}" aria-label="${t("pm.visibility")}">
                  ${["public", "exclusive", "private"].map((o) => `<option value="${o}" ${o === v ? "selected" : ""}>${t(`pm.vis.${o}`)}</option>`).join("")}
                </select>
                <div class="prof-actions">
                  <a class="btn btn-sm btn-primary" href="${postHref(p)}">${t("pm.open")}</a>
                  <button class="btn btn-sm btn-ghost" data-pm-edit="${escapeHtml(p.post_id)}" type="button">${t("pm.edit")}</button>
                  <button class="btn btn-sm btn-danger" data-pm-del="${escapeHtml(p.post_id)}" type="button">${t("pm.delete")}</button>
                </div>
              </div>`;
            })
            .join("")
        : `<p class="empty">${posts.length ? t("pm.noMatch") : t("pa.noneInRange")}</p>`;
      pane.querySelector("#pm-all").checked = false;
      syncSel();
    };

    pane.querySelector("#pm-q").oninput = (e) => {
      ui.q = e.target.value;
      draw();
    };
    pane.querySelector("#pm-kind").onchange = (e) => {
      ui.kind = e.target.value;
      draw();
    };
    pane.querySelector("#pm-vis").onchange = (e) => {
      ui.vis = e.target.value;
      draw();
    };
    pane.querySelector("#pm-all").onchange = (e) => {
      pane.querySelectorAll("[data-pm-check]").forEach((c) => (c.checked = e.target.checked));
      syncSel();
    };
    pane.onchange = async (e) => {
      if (e.target.matches("[data-pm-check]")) return syncSel();
      const sel = e.target.closest("[data-pm-vis]");
      if (!sel) return;
      const post = state.postCache.get(sel.dataset.pmVis);
      if (!post) return;
      const next = sel.value;
      if (next === "public") {
        const ok = await updatePostVisibility(post, { ...visOf(post), visibility: "public", people: [] }, null);
        toast(ok ? t("pm.saved") : t("pm.saveFail"));
        return refresh();
      }
      // exclusive / private need their audience settings
      sel.value = post.visibility || "public";
      openPostManager(post, refresh, next);
    };
    pane.onclick = async (e) => {
      const edit = e.target.closest("[data-pm-edit]");
      const del = e.target.closest("[data-pm-del]");
      const bulk = e.target.closest("[data-bulk]");
      if (edit) return openPostManager(state.postCache.get(edit.dataset.pmEdit), refresh);
      if (del) return confirmDeletePost(state.postCache.get(del.dataset.pmDel), refresh);
      if (!bulk) return;
      const rows = selected();
      if (!rows.length) return;
      if (bulk.dataset.bulk === "delete") {
        const ov = document.createElement("div");
        ov.className = "modal-overlay";
        ov.innerHTML = `<section class="glass modal-card"><h2>${t("pm.delTitle")}</h2><p>${t("pm.bulkDelText", { n: rows.length })}</p>
          <div class="prof-actions" style="margin-top:12px"><button class="btn btn-sm btn-danger" id="pb-go" type="button">${t("pm.delete")}</button><button class="btn btn-sm btn-ghost" id="pb-x" type="button">${t("prof.cancel")}</button></div></section>`;
        document.body.appendChild(ov);
        ov.onclick = async (ev) => {
          if (ev.target === ov || ev.target.closest("#pb-x")) return ov.remove();
          if (!ev.target.closest("#pb-go")) return;
          ev.target.disabled = true;
          for (const p of rows) await deletePost(p);
          ov.remove();
          toast(t("pm.deleted"));
          refresh();
        };
        return;
      }
      const to = bulk.dataset.bulk;
      let ok = true;
      for (const p of rows) ok = (await updatePostVisibility(p, { ...visOf(p), visibility: to, people: [] }, null)) && ok;
      toast(ok ? t("pm.saved") : t("pm.saveFail"));
      refresh();
    };
    draw();
  }

  /* --- Tab 2: Analytics posts ---
     Impressions, link clicks and successful referral sign-ups come from
     public.post_events; the recommends and "don't recommend" counts come from public.post_votes. */
  const ANALYTICS_COLS = [
    ["imp", "pa.impressions"],
    ["up", "pa.recs"],
    ["down", "pa.donts"],
    ["click", "pa.clicks"],
    ["share", "pa.shares"],
  ];

  async function paneAnalytics(pane, ui) {
    const bounds = rangeOf(ui);
    const all = await myPosts();
    if (!all.length) {
      pane.innerHTML = `<p class="empty">${t("pa.noneInRange")}</p>`;
      return;
    }
    const ids = all.map((p) => p.post_id);
    const list = ids.join(",");
    const q = rangeQuery(bounds);
    const events = (kind, extra = "") =>
      supabaseRequest(`/rest/v1/post_events?post_id=in.(${list})&kind=eq.${kind}${extra}${q}&select=post_id`);
    const [imp, clk, shr, votes] = await Promise.all([
      events("impression"),
      events("click"),
      events("share", "&network=eq.referral"),
      supabaseRequest(`/rest/v1/post_votes?post_id=in.(${list})${q}&select=post_id,vote`),
    ]);
    // The events table is optional: without sql/post_analytics.sql the votes
    // still count and the rest reads zero.
    const eventRows = [imp, clk, shr];
    const missingTable = eventRows.some((r) => !r.ok && (r.status === 404 || r.data?.code === "PGRST205"));
    // PostgREST stops at 1000 rows, so a full page means the count may be short.
    const capped = [...eventRows, votes].some((r) => Array.isArray(r.data) && r.data.length >= 1000);
    const stat = {};
    ids.forEach((id) => (stat[id] = { imp: 0, up: 0, down: 0, click: 0, share: 0 }));
    // A missing table answers with an error object, not a list.
    const rows = (res) => (Array.isArray(res?.data) ? res.data : []);
    const bump = (res, key) => rows(res).forEach((r) => stat[r.post_id] && (stat[r.post_id][key] += 1));
    bump(imp, "imp");
    bump(clk, "click");
    bump(shr, "share");
    rows(votes).forEach((v) => {
      if (stat[v.post_id] && (v.vote === "up" || v.vote === "down")) stat[v.post_id][v.vote] += 1;
    });
    // A post belongs to the period when it was published in it, or when it got
    // any activity in it: an older post still collecting impressions stays on
    // the list, while a post nothing happened to is left out.
    const active = (id) => ANALYTICS_COLS.some(([k]) => stat[id][k] > 0);
    const posts = all.filter((p) => inRange(p.created_at, bounds) || active(p.post_id));
    if (!posts.length) {
      pane.innerHTML = `<p class="empty">${t("pa.noneInRange")}</p>`;
      return;
    }
    const total = { imp: 0, up: 0, down: 0, click: 0, share: 0 };
    posts.forEach((p) => ANALYTICS_COLS.forEach(([k]) => (total[k] += stat[p.post_id][k])));

    pane.innerHTML = `
      <p class="muted">${t("pa.lead")}</p>
      <p class="muted">${t("pa.scope")}</p>
      ${missingTable ? `<p class="empty-note">${t("pa.needSql")}</p>` : ""}
      <div class="pm-stats pa-totals">
        ${ANALYTICS_COLS.map(([k, key]) => `<div class="pm-stat"><strong>${total[k]}</strong><span>${t(key)}</span></div>`).join("")}
      </div>
      <div class="pa-table">
        <div class="pa-row pa-head">
          <span>${t("pa.post")}</span>
          ${ANALYTICS_COLS.map(([, key]) => `<span>${t(key)}</span>`).join("")}
        </div>
        ${posts
          .map((p) => {
            const s = stat[p.post_id];
            return `<div class="pa-row" data-pa="${escapeHtml(p.post_id)}">
              <span class="pa-name"><a href="${postHref(p)}">${escapeHtml(p.title || p.post_id)}</a><span class="chip">${kindLabel(p.kind)}</span></span>
              ${ANALYTICS_COLS.map(([k]) => `<span class="pa-num${k === "down" ? " pa-down" : ""}">${s[k]}</span>`).join("")}
            </div>`;
          })
          .join("")}
      </div>
      ${capped ? `<p class="muted">${t("pa.capped")}</p>` : ""}`;
  }

  function visOf(p) {
    return {
      visibility: p.visibility || "public",
      people: [],
      require_followers: Boolean(p.require_followers),
      min_age: p.min_age ?? null,
      max_age: p.max_age ?? null,
      languages: p.languages || "",
      countries: p.countries || "",
      watched_tmdb: p.watched_tmdb || "",
      actors: p.actors || "",
      directors: p.directors || "",
      titles: p.titles || "",
      year_mode: p.year_mode || "",
      year_value: p.year_value ?? null,
    };
  }


  // ---------- Messages ----------
  const FAILED_KEY = "cineaura_failed_msgs";
  const getFailed = () => { try { return JSON.parse(localStorage.getItem(FAILED_KEY) || "[]"); } catch { return []; } };
  const setFailed = (rows) => { try { localStorage.setItem(FAILED_KEY, JSON.stringify(rows.slice(-100))); } catch { /* ignore */ } };
  const isOnline = (iso) => Boolean(iso) && Date.now() - new Date(iso).getTime() < 150000;
  const fmtWhen = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleString([], { dateStyle: "short", timeStyle: "short" }); };
  const byDate = (x, y) => String(y.created_at).localeCompare(String(x.created_at));
  const msgStatus = (m) => (m._failed ? "failed" : m.read ? "seen" : "unseen");
  const statusLabel = (st) => (st === "seen" ? t("prof.stSeen") : st === "failed" ? t("prof.stFailed") : st === "unseen" ? t("prof.stSent") : "");
  const hasMsgBlock = (b) => Boolean(b) && (b.kind === "full" || String(b.features || "").split(",").map((x) => x.trim()).includes("messages"));

  async function viewMessages(main) {
    const me = state.me.member;
    const myId = me.member_id;
    const ui = (state.msgUi = state.msgUi || { tab: "all", filter: "all", q: "", online: false });
    const [sent, recv, fers, fing, blocks, staffRows] = await Promise.all([
      supabaseRequest(`/rest/v1/messages?sender_id=eq.${restValue(myId)}&select=*&order=created_at.desc`),
      supabaseRequest(`/rest/v1/messages?receiver_id=eq.${restValue(myId)}&select=*&order=created_at.desc`),
      supabaseRequest(`/rest/v1/follows?following_id=eq.${restValue(myId)}&status=eq.accepted&select=follower_id,follower_username`),
      supabaseRequest(`/rest/v1/follows?follower_id=eq.${restValue(myId)}&status=eq.accepted&select=following_id,following_username`),
      supabaseRequest(`/rest/v1/blocks?blocker_id=eq.${restValue(myId)}&select=*`),
      fetchStaff(),
    ]);
    const roleRank = { super: 0, admin: 1, moderator: 2 };
    const staffByMember = new Map();
    (Array.isArray(staffRows) ? staffRows : [])
      .filter((s) => s.member_id && s.member_id !== myId)
      .forEach((s) => staffByMember.set(String(s.member_id), s));
    const staffList = [...staffByMember.values()].sort(
      (a, b) => (roleRank[a.role] ?? 9) - (roleRank[b.role] ?? 9) || String(a.username).localeCompare(String(b.username))
    );
    const people = new Map();
    const person = (id, username) => {
      if (!people.has(id)) people.set(id, { id, username: username || id, sent: [], recv: [], follower: false, following: false, last_seen: null, avatar: "" });
      const p = people.get(id);
      if (username && p.username === id) p.username = username;
      return p;
    };
    staffList.forEach((s) => person(String(s.member_id), s.username));
    (Array.isArray(sent.data) ? sent.data : []).filter((m) => !m.sender_deleted).forEach((m) => person(m.receiver_id, m.receiver_username).sent.push(m));
    (Array.isArray(recv.data) ? recv.data : []).filter((m) => !m.receiver_deleted).forEach((m) => person(m.sender_id, m.sender_username).recv.push(m));
    (Array.isArray(fers.data) ? fers.data : []).forEach((r) => { person(r.follower_id, r.follower_username).follower = true; });
    (Array.isArray(fing.data) ? fing.data : []).forEach((r) => { person(r.following_id, r.following_username).following = true; });
    getFailed().filter((f) => f.from_id === myId).forEach((f) => person(f.to_id, f.to_username).sent.push({ ...f, created_at: f.at, _failed: true }));
    people.delete(myId);
    const ids = [...people.keys()];
    if (ids.length) {
      // last_seen is optional: the helper drops missing columns instead of blanking every avatar.
      const rows = await profilesByIds(ids, ["member_id", "username", "avatar_url", "last_seen"]);
      rows.forEach((r) => {
        const p = people.get(r.member_id);
        if (!p) return;
        p.avatar = r.avatar_url || "";
        p.last_seen = r.last_seen || null;
        if (r.username) p.username = r.username;
      });
      await primeAvatars(ids, [...people.values()].map((p) => p.username));
      people.forEach((p) => { if (!p.avatar) p.avatar = avatarUrlFor(p.id, p.username); });
    }
    people.forEach((p) => { p.sent.sort(byDate); p.recv.sort(byDate); });
    const blockMap = new Map((Array.isArray(blocks.data) ? blocks.data : []).map((b) => [b.blocked_id, b]));
    const unreadOf = (p) => p.recv.filter((m) => !m.read).length;
    const unreadTotal = [...people.values()].reduce((n, p) => n + unreadOf(p), 0);
    const unreadStaff = [...people.values()].filter((p) => staffByMember.has(p.id)).reduce((n, p) => n + unreadOf(p), 0);

    const lastOf = (p) => (ui.tab === "recv" ? p.recv[0] : ui.tab === "sent" ? p.sent[0] : [p.sent[0], p.recv[0]].filter(Boolean).sort(byDate)[0]);
    const tabBtn = (k, label, extra = "") => `<button type="button" role="tab" class="follow-tab${ui.tab === k ? " active" : ""}" data-mtab="${k}">${label}${extra}</button>`;
    main.innerHTML = `
      <p class="eyebrow">${t("prof.inbox")}</p>
      <h1>${t("prof.messages")}</h1>
      <div class="tabs follow-tabs" role="tablist">
        ${tabBtn("all", t("prof.tabAll"))}
        ${tabBtn("recv", t("prof.tabRecv"), unreadTotal ? `<span class="follow-count">${unreadTotal}</span>` : "")}
        ${tabBtn("sent", t("prof.tabSent"))}
        ${tabBtn("staff", t("prof.tabAdmin"), unreadStaff ? `<span class="follow-count">${unreadStaff}</span>` : "")}
      </div>
      <div class="mp-controls">
        <input id="mp-q" type="search" value="${escapeHtml(ui.q)}" placeholder="${t("prof.msgSearch")}" />
        ${ui.tab === "staff"
          ? ""
          : `<select id="mp-filter">
          <option value="all">${t("prof.fAll")}</option>
          <option value="followers">${t("prof.fFollowers")}</option>
          <option value="following">${t("prof.fFollowing")}</option>
        </select>
        <label class="check-row"><input type="checkbox" id="mp-online" ${ui.online ? "checked" : ""} /> ${t("prof.onlineOnly")}</label>`}
      </div>
      ${ui.tab === "staff"
        ? `<div class="admin-team-head">
            <h2>${t("prof.adminTeam")}</h2>
            <p class="muted">${t("prof.adminTeamLead")}</p>
            ${staffList.length ? "" : `<p class="empty">${t("prof.noAdminTeam")}</p>`}
          </div>`
        : ""}
      <div id="mp-list"></div>`;
    if ($("#mp-filter")) $("#mp-filter").value = ui.filter;

    const rowHtml = (p) => {
      const m = lastOf(p);
      const online = isOnline(p.last_seen);
      const mine = Boolean(m) && (m._failed || m.sender_id === myId);
      const st = m && mine ? msgStatus(m) : "";
      const unread = unreadOf(p) > 0 || (Boolean(m) && !mine && !m.read);
      const blockedByMe = hasMsgBlock(blockMap.get(p.id));
      const hasAny = p.sent.some((x) => !x._failed) || p.recv.length || p.sent.length;
      const staffRow = staffByMember.get(p.id);
      return `<div class="mp-row${unread ? " mp-unread" : ""}">
        <div class="mp-avatar ${online ? "on" : "off"}" title="${online ? t("prof.online") : t("prof.offline")}">
          <img src="${escapeHtml(p.avatar || initialsAvatar(p.username))}" alt="" data-avatar-for="${escapeHtml(p.id)}" data-avatar-name="${escapeHtml(p.username)}" />
        </div>
        <div class="mp-main">
          <div class="mp-top"><strong>@${escapeHtml(p.username)}</strong>${staffRow ? `<span class="chip staff-chip">${escapeHtml(t("panel.role." + staffRow.role))}</span>` : ""}<span class="mp-state ${online ? "on" : "off"}">${online ? t("prof.online") : t("prof.offline")}</span></div>
          ${m
            ? `<div class="mp-last ${st || (unread ? "unread" : "recv")}"><span class="mp-text">${mine ? `${t("prof.you")}: ` : ""}${escapeHtml(m.body)}</span>${st ? `<span class="mp-st">${statusLabel(st)}</span>` : ""}</div>`
            : `<div class="mp-none">${staffRow ? t("prof.adminNoConv") : t("prof.noMsgYet")}</div>`}
        </div>
        <div class="mp-date">${m ? fmtWhen(m.created_at) : ""}</div>
        <div class="mp-actions">
          <button class="btn btn-sm btn-primary" data-mopen="${escapeHtml(p.id)}" data-user="${escapeHtml(p.username)}" type="button">${staffRow && !hasAny ? t("prof.message") : t("common.open")}</button>
          ${hasAny ? `<button class="btn btn-sm btn-ghost" data-mdel="${escapeHtml(p.id)}" type="button">${t("prof.delConv")}</button>` : ""}
          ${staffRow ? "" : `<button class="btn btn-sm btn-danger" data-mblock="${escapeHtml(p.id)}" data-user="${escapeHtml(p.username)}" type="button">${blockedByMe ? t("prof.unblock") : t("prof.block")}</button>`}
        </div>
      </div>`;
    };

    const draw = () => {
      let list = [...people.values()];
      if (ui.tab === "staff") {
        list = list.filter((p) => staffByMember.has(p.id));
      } else {
        list = list.filter((p) => !staffByMember.has(p.id) || p.sent.length || p.recv.length);
        if (!["recv", "sent"].includes(ui.tab)) {
          if (ui.filter === "followers") list = list.filter((p) => p.follower);
          else if (ui.filter === "following") list = list.filter((p) => p.following);
          if (ui.online) list = list.filter((p) => isOnline(p.last_seen));
        }
      }
      if (ui.tab === "recv") list = list.filter((p) => p.recv.length);
      if (ui.tab === "sent") list = list.filter((p) => p.sent.length);
      const q = ui.q.trim().toLowerCase().replace(/^@/, "");
      if (q) list = list.filter((p) => String(p.username).toLowerCase().includes(q) || String(p.id).toLowerCase().includes(q));
      list.sort((x, y) => {
        if (ui.tab === "staff") {
          const rx = roleRank[staffByMember.get(x.id)?.role] ?? 9;
          const ry = roleRank[staffByMember.get(y.id)?.role] ?? 9;
          const lx = lastOf(x);
          const ly = lastOf(y);
          if (lx && ly) return byDate(lx, ly);
          if (lx) return -1;
          if (ly) return 1;
          if (rx !== ry) return rx - ry;
          return String(x.username).localeCompare(String(y.username));
        }
        const lx = lastOf(x);
        const ly = lastOf(y);
        if (lx && ly) return byDate(lx, ly);
        if (lx) return -1;
        if (ly) return 1;
        return String(x.username).localeCompare(String(y.username));
      });
      const emptyKey = ui.tab === "staff" ? "prof.noAdminMsg" : "prof.noMsg";
      $("#mp-list").innerHTML = list.length ? list.map(rowHtml).join("") : `<p class="empty">${t(emptyKey)}</p>`;
      hydrateAvatars(main);
    };
    draw();

    $("#mp-q").oninput = (e) => { ui.q = e.target.value; draw(); };
    if ($("#mp-filter")) $("#mp-filter").onchange = (e) => { ui.filter = e.target.value; draw(); };
    if ($("#mp-online")) $("#mp-online").onchange = (e) => { ui.online = e.target.checked; draw(); };
    main.onclick = async (e) => {
      const tab = e.target.closest("[data-mtab]");
      if (tab) { ui.tab = tab.dataset.mtab; viewMessages(main); return; }
      const open = e.target.closest("[data-mopen]");
      if (open) { openChat({ member_id: open.dataset.mopen, username: open.dataset.user }, () => viewMessages(main)); return; }
      const del = e.target.closest("[data-mdel]");
      if (del) {
        if (!window.confirm(t("prof.confirmDelConv"))) return;
        const pid = del.dataset.mdel;
        const a = await supabaseRequest(`/rest/v1/messages?sender_id=eq.${restValue(myId)}&receiver_id=eq.${restValue(pid)}`, { method: "PATCH", body: JSON.stringify({ sender_deleted: true }) });
        const b = await supabaseRequest(`/rest/v1/messages?sender_id=eq.${restValue(pid)}&receiver_id=eq.${restValue(myId)}`, { method: "PATCH", body: JSON.stringify({ receiver_deleted: true }) });
        if (!a.ok || !b.ok) { toast(t("prof.sqlHint")); return; }
        await supabaseRequest(`/rest/v1/messages?sender_id=eq.${restValue(myId)}&receiver_id=eq.${restValue(pid)}&sender_deleted=eq.true&receiver_deleted=eq.true`, { method: "DELETE" });
        await supabaseRequest(`/rest/v1/messages?sender_id=eq.${restValue(pid)}&receiver_id=eq.${restValue(myId)}&sender_deleted=eq.true&receiver_deleted=eq.true`, { method: "DELETE" });
        setFailed(getFailed().filter((f) => !(f.from_id === myId && f.to_id === pid)));
        toast(t("prof.convDeleted"));
        viewMessages(main);
        return;
      }
      const blk = e.target.closest("[data-mblock]");
      if (blk) {
        const pid = blk.dataset.mblock;
        const cur = (await supabaseRequest(`/rest/v1/blocks?blocker_id=eq.${restValue(myId)}&blocked_id=eq.${restValue(pid)}&select=*`)).data?.[0];
        if (hasMsgBlock(cur)) {
          if (cur.kind === "full") await unblock(pid);
          else {
            const feats = String(cur.features || "").split(",").map((x) => x.trim()).filter((x) => x && x !== "messages");
            if (feats.length) await supabaseRequest(`/rest/v1/blocks?id=eq.${cur.id}`, { method: "PATCH", body: JSON.stringify({ features: feats.join(",") }) });
            else await supabaseRequest(`/rest/v1/blocks?id=eq.${cur.id}`, { method: "DELETE" });
          }
          toast(t("prof.unblocked"));
        } else {
          if (cur) {
            const feats = [...new Set([...String(cur.features || "").split(",").map((x) => x.trim()).filter(Boolean), "messages"])];
            await supabaseRequest(`/rest/v1/blocks?id=eq.${cur.id}`, { method: "PATCH", body: JSON.stringify({ features: feats.join(",") }) });
          } else {
            await supabaseRequest("/rest/v1/blocks", {
              method: "POST",
              body: JSON.stringify({ blocker_id: myId, blocked_id: pid, blocker_username: me.username, blocked_username: blk.dataset.user, kind: "partial", features: "messages" }),
            });
          }
          toast(t("prof.msgsBlockedOk"));
        }
        viewMessages(main);
      }
    };
  }

  async function messagingBlocked(personId) {
    const me = state.me?.member?.member_id;
    if (!me || !personId) return true;
    const a = await supabaseRequest(
      `/rest/v1/blocks?blocker_id=eq.${restValue(me)}&blocked_id=eq.${restValue(personId)}&select=kind,features`
    );
    const b = await supabaseRequest(
      `/rest/v1/blocks?blocker_id=eq.${restValue(personId)}&blocked_id=eq.${restValue(me)}&select=kind,features`
    );
    return hasMsgBlock(a.data?.[0]) || hasMsgBlock(b.data?.[0]);
  }

  async function openChat(person, onClose) {
    const me = state.me.member;
    const blocked = await messagingBlocked(person.member_id);
    const overlay = document.createElement("div");
    overlay.className = "chat-overlay";
    overlay.innerHTML = `
      <section class="glass chat-box">
        <div class="chat-head">
          <span class="chat-face">${avatarImg(person.member_id, person.username)}</span>
          <h2>@${escapeHtml(person.username)}</h2>
          <button class="btn btn-sm btn-ghost" id="chat-x" type="button">${t("common.close")}</button>
        </div>
        <div class="chat-log" id="chat-log"></div>
        ${blocked
          ? `<p class="muted" style="margin:8px 0 0">${t("prof.msgBlocked")}</p>`
          : `<div class="form-row">
              <input id="chat-text" placeholder="${t("prof.writeMsg")}" />
              <button class="btn btn-sm btn-primary" id="chat-send" type="button">${t("common.send")}</button>
            </div>`}
      </section>`;
    document.body.appendChild(overlay);
    hydrateAvatars(overlay);
    let timer = null;
    const close = () => { clearInterval(timer); overlay.remove(); if (onClose) onClose(); };
    overlay.querySelector("#chat-x").onclick = close;

    const load = async () => {
      const [a, b] = await Promise.all([
        supabaseRequest(`/rest/v1/messages?sender_id=eq.${restValue(me.member_id)}&receiver_id=eq.${restValue(person.member_id)}&select=*&order=created_at.asc`),
        supabaseRequest(`/rest/v1/messages?sender_id=eq.${restValue(person.member_id)}&receiver_id=eq.${restValue(me.member_id)}&select=*&order=created_at.asc`),
      ]);
      const mineRows = (Array.isArray(a.data) ? a.data : []).filter((m) => !m.sender_deleted);
      const theirRows = (Array.isArray(b.data) ? b.data : []).filter((m) => !m.receiver_deleted);
      const failed = getFailed().filter((f) => f.from_id === me.member_id && f.to_id === person.member_id).map((f) => ({ ...f, created_at: f.at, sender_id: me.member_id, _failed: true }));
      const rows = [...mineRows, ...theirRows, ...failed].sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)));
      const log = overlay.querySelector("#chat-log");
      log.innerHTML = rows.map((m) => {
        const mine = m.sender_id === me.member_id;
        const st = mine ? msgStatus(m) : "";
        return `<div class="bubble ${mine ? `mine ${st}` : ""}">${escapeHtml(m.body)}
          <div class="muted">${fmtWhen(m.created_at)}${st ? ` · ${statusLabel(st)}` : ""}${m._failed ? ` <button class="btn btn-sm btn-danger" data-retry="${escapeHtml(m.id)}" type="button">${t("prof.retry")}</button>` : ""}</div>
        </div>`;
      }).join("") || `<p class="muted">${t("prof.startConv")}</p>`;
      log.scrollTop = log.scrollHeight;
      if (theirRows.some((m) => !m.read)) {
        supabaseRequest(`/rest/v1/messages?receiver_id=eq.${restValue(me.member_id)}&sender_id=eq.${restValue(person.member_id)}&read=eq.false`, { method: "PATCH", body: JSON.stringify({ read: true }) });
      }
    };

    const send = async (text, retryId) => {
      if (!(await window.CineAura.guardFeature("messages"))) return false;
      if (await messagingBlocked(person.member_id)) { toast(t("prof.msgBlocked")); return false; }
      let r;
      try {
        r = await supabaseRequest("/rest/v1/messages", {
          method: "POST",
          body: JSON.stringify({ sender_id: me.member_id, receiver_id: person.member_id, sender_username: me.username, receiver_username: person.username, body: text }),
        });
      } catch { r = { ok: false }; }
      if (!r.ok) {
        if (!retryId) setFailed([...getFailed(), { id: `f${Date.now()}`, from_id: me.member_id, to_id: person.member_id, to_username: person.username, body: text, at: new Date().toISOString() }]);
        toast(t("prof.sendFailed"));
        return false;
      }
      if (retryId) setFailed(getFailed().filter((f) => f.id !== retryId));
      await notify(person.member_id, {
        kind: "message",
        title: t("prof.newMsg"),
        body: `@${me.username}: ${text.slice(0, 80)}`,
        href: profileHref(me.username),
        from_id: me.member_id,
        from_username: me.username,
      });
      return true;
    };

    const sendBtn = overlay.querySelector("#chat-send");
    if (sendBtn) {
      const go = async () => {
        const input = overlay.querySelector("#chat-text");
        const text = input.value.trim();
        if (!text) return;
        sendBtn.disabled = true;
        const ok = await send(text);
        sendBtn.disabled = false;
        if (ok) input.value = "";
        load();
      };
      sendBtn.onclick = go;
      overlay.querySelector("#chat-text").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    }
    overlay.querySelector("#chat-log").addEventListener("click", async (e) => {
      const r = e.target.closest("[data-retry]");
      if (!r) return;
      const f = getFailed().find((x) => String(x.id) === r.dataset.retry);
      if (!f) return;
      r.disabled = true;
      await send(f.body, f.id);
      load();
    });
    timer = setInterval(() => { if (!document.body.contains(overlay)) clearInterval(timer); else load(); }, 6000);
    load();
  }

  async function viewSearch(main) {
    const searchTab = state.searchTab || "content";
    main.innerHTML = `
      <p class="eyebrow">${t("prof.people")}</p>
      <h1>${t("nav.search")}</h1>
      <div class="tabs follow-tabs" role="tablist">
        <button type="button" role="tab" class="follow-tab${searchTab === "content" ? " active" : ""}" data-stab="content">${t("prof.searchContent")}</button>
        <button type="button" role="tab" class="follow-tab${searchTab === "profiles" ? " active" : ""}" data-stab="profiles">${t("prof.searchProfiles")}</button>
      </div>
      <div id="stab-content" ${searchTab !== "content" ? "hidden" : ""}></div>
      <div id="stab-profiles" ${searchTab !== "profiles" ? "hidden" : ""}></div>`;
    main.querySelectorAll("[data-stab]").forEach((b) => {
      b.onclick = () => { state.searchTab = b.dataset.stab; viewSearch(main); };
    });
    if (searchTab === "content") await drawContentSearch(main);
    else drawProfilesSearch(main);
    hydrateAvatars(main);
  }

  async function drawContentSearch(main) {
    const box = main.querySelector("#stab-content");
    box.innerHTML = `
      <div class="stack">
        <div class="form-row">
          <input id="cs-q" placeholder="${t("prof.contentSearchPh")}" />
          <button class="btn btn-sm btn-primary" id="cs-go" type="button">${t("nav.search")}</button>
        </div>
        <div class="filter-bar">
          <div class="filter-group">
            <span class="muted">${t("common.type")}</span>
            <label class="lang-chip"><input type="radio" name="cs-type" value="all" checked /> ${t("prof.allTypes")}</label>
            <label class="lang-chip"><input type="radio" name="cs-type" value="playlist" /> ${t("dash.nav.playlists")}</label>
            <label class="lang-chip"><input type="radio" name="cs-type" value="recommendation" /> ${t("prof.recs")}</label>
            <label class="lang-chip"><input type="radio" name="cs-type" value="reclist" /> ${t("prof.recList")}</label>
            <label class="lang-chip"><input type="radio" name="cs-type" value="review" /> ${t("rev.reviews")}</label>
          </div>
          <div class="filter-group">
            <span class="muted">${t("prof.filterDate")}</span>
            <label class="lang-chip"><input type="radio" name="cs-date" value="all" checked /> ${t("prof.anytime")}</label>
            <label class="lang-chip"><input type="radio" name="cs-date" value="day" /> ${t("prof.today")}</label>
            <label class="lang-chip"><input type="radio" name="cs-date" value="week" /> ${t("prof.thisWeek")}</label>
            <label class="lang-chip"><input type="radio" name="cs-date" value="month" /> ${t("prof.thisMonth")}</label>
          </div>
          <div class="form-row">
            <input id="cs-country" placeholder="${t("prof.filterCountry")}" />
            <input id="cs-lang" placeholder="${t("prof.filterLang")}" />
          </div>
        </div>
      </div>
      <div id="cs-results" style="margin-top:16px"></div>`;

    const doSearch = async () => {
      const kw = $("#cs-q").value.trim();
      if (!kw) return toast(t("prof.enterUser"));
      const typeFilter = document.querySelector('input[name="cs-type"]:checked')?.value || "all";
      const dateFilter = document.querySelector('input[name="cs-date"]:checked')?.value || "all";
      const countryFilter = $("#cs-country").value.trim().toLowerCase();
      const langFilter = $("#cs-lang").value.trim().toLowerCase();
      const results = $("#cs-results");
      results.innerHTML = `<p class="muted">${t("common.loading")}</p>`;

      // Search posts by keyword
      const likeVal = `*${kw}*`;
      let allPosts = [];
      try {
        const [byTitle, byBody] = await Promise.all([
          supabaseRequest(`/rest/v1/posts?title=ilike.${restValue(likeVal)}&select=*&order=created_at.desc&limit=60`),
          supabaseRequest(`/rest/v1/posts?body=ilike.${restValue(likeVal)}&select=*&order=created_at.desc&limit=60`),
        ]);
        const map = new Map();
        (byTitle.data || []).forEach((p) => map.set(p.post_id, p));
        (byBody.data || []).forEach((p) => map.set(p.post_id, p));
        allPosts = [...map.values()];
      } catch {
        allPosts = [];
      }

      // Filter by type
      if (typeFilter !== "all") {
        if (typeFilter === "recommendation") {
          allPosts = allPosts.filter((p) => p.kind === "recommendation" || p.kind === "reclist");
        } else {
          allPosts = allPosts.filter((p) => p.kind === typeFilter);
        }
      }

      // Filter by date
      if (dateFilter !== "all") {
        const now = Date.now();
        const spans = { day: 86400000, week: 7 * 86400000, month: 30 * 86400000 };
        const ms = spans[dateFilter] || 0;
        allPosts = allPosts.filter((p) => {
          const ts = new Date(p.created_at).getTime();
          return ts && now - ts < ms;
        });
      }

      // Filter by country / language in post fields
      if (countryFilter) {
        allPosts = allPosts.filter((p) => {
          const pc = String(p.countries || "").toLowerCase();
          return !pc || pc.includes(countryFilter) || pc.includes("all");
        });
      }
      if (langFilter) {
        allPosts = allPosts.filter((p) => {
          const pl = String(p.languages || "").toLowerCase();
          return !pl || pl.includes(langFilter) || pl.includes("all");
        });
      }

      if (!allPosts.length) {
        results.innerHTML = `<p class="empty">${t("prof.noContentResults")}</p>`;
        return;
      }

      // Check visibility for each post
      const me = state.me?.member;
      const myId = me?.member_id;
      const ownerIds = [...new Set(allPosts.map((p) => p.owner_id).filter(Boolean))];
      const ownerProfiles = ownerIds.length
        ? (await supabaseRequest(`/rest/v1/profiles?member_id=in.(${ownerIds.join(",")})&select=member_id,username,avatar_url`)).data || []
        : [];
      const ownerProfileMap = {};
      ownerProfiles.forEach((op) => { ownerProfileMap[op.member_id] = op; });

      // Load access lists for private posts
      const postIds = allPosts.map((p) => p.post_id).join(",");
      const accessAll = await supabaseRequest(`/rest/v1/post_access?post_id=in.(${postIds})&select=post_id,username`);
      const access = {};
      (accessAll.data || []).forEach((a) => {
        access[a.post_id] = access[a.post_id] || [];
        access[a.post_id].push(a.username);
      });

      // Build watched set for exclusive posts
      let watchedSet = new Set();
      if (myId) {
        const [vw, hs] = await Promise.all([
          supabaseRequest(`/rest/v1/views?viewer_id=eq.${restValue(myId)}&select=tmdb_id`),
          supabaseRequest(`/rest/v1/hestory?visitor_id=eq.${restValue(myId)}&select=tmdb_id`),
        ]);
        (vw.data || []).forEach((r) => watchedSet.add(Number(r.tmdb_id)));
        (hs.data || []).forEach((r) => watchedSet.add(Number(r.tmdb_id)));
      }

      const visible = allPosts.filter((p) => canSeePost(p, access[p.post_id] || [], watchedSet));

      // Also search in post_items for title matches
      const itemsRes = await supabaseRequest(`/rest/v1/post_items?title=ilike.${restValue(likeVal)}&select=post_id`);
      const extraPostIds = [...new Set((itemsRes.data || []).map((it) => it.post_id).filter((id) => !allPosts.some((p) => p.post_id === id)))];
      if (extraPostIds.length) {
        const extraPosts = await supabaseRequest(`/rest/v1/posts?post_id=in.(${extraPostIds.join(",")})&select=*`);
        const extraVisible = (extraPosts.data || []).filter((p) => {
          if (typeFilter !== "all") {
            if (typeFilter === "recommendation" && p.kind !== "recommendation" && p.kind !== "reclist") return false;
            else if (typeFilter !== "recommendation" && p.kind !== typeFilter) return false;
          }
          return canSeePost(p, access[p.post_id] || [], watchedSet);
        });
        visible.push(...extraVisible);
      }

      if (!visible.length) {
        results.innerHTML = `<p class="empty">${t("prof.noContentResults")}</p>`;
        return;
      }

      // Load post items and votes for display
      const vIds = visible.map((p) => p.post_id).join(",");
      const [itemsFull, votes, comments] = await Promise.all([
        supabaseRequest(`/rest/v1/post_items?post_id=in.(${vIds})&select=*`),
        supabaseRequest(`/rest/v1/post_votes?post_id=in.(${vIds})&select=*`),
        supabaseRequest(`/rest/v1/post_comments?post_id=in.(${vIds})&select=*&order=created_at.asc`),
      ]);
      const itemMap = {};
      (itemsFull.data || []).forEach((it) => {
        itemMap[it.post_id] = itemMap[it.post_id] || [];
        itemMap[it.post_id].push(it);
      });
      const voteMap = {};
      (votes.data || []).forEach((v) => {
        voteMap[v.post_id] = voteMap[v.post_id] || [];
        voteMap[v.post_id].push(v);
      });
      const cmtMap = {};
      (comments.data || []).forEach((c) => {
        cmtMap[c.post_id] = cmtMap[c.post_id] || [];
        cmtMap[c.post_id].push(c);
      });

      // Ranking: first by recommendation points (recommend = +1, don't = -1),
      // then by minutes watched through the post's watch links (?post=POST_ID).
      const pointsMap = {};
      Object.keys(voteMap).forEach((pid) => {
        const vs = voteMap[pid] || [];
        pointsMap[pid] =
          vs.filter((v) => v.vote === "up").length - vs.filter((v) => v.vote === "down").length;
      });
      const minMap = {};
      const viewsRes = await supabaseRequest(
        `/rest/v1/views?post_id=in.(${vIds})&select=post_id,minutes`
      );
      if (viewsRes.ok && Array.isArray(viewsRes.data)) {
        viewsRes.data.forEach((v) => {
          minMap[v.post_id] = (minMap[v.post_id] || 0) + Number(v.minutes || 0);
        });
      }
      visible.sort((a, b) => {
        const pa = pointsMap[a.post_id] || 0;
        const pb = pointsMap[b.post_id] || 0;
        if (pb !== pa) return pb - pa;
        const ma = minMap[a.post_id] || 0;
        const mb = minMap[b.post_id] || 0;
        if (mb !== ma) return mb - ma;
        return String(b.created_at || "").localeCompare(String(a.created_at || ""));
      });

      await primeAvatars(visible.map((p) => p.owner_id), visible.map((p) => p.owner_username));
      await enrichItemMap(visible, itemMap);
      visible.forEach((p) => state.postCache.set(p.post_id, p));

      results.innerHTML = visible.map((p) => {
        const owner = ownerProfileMap[p.owner_id] || {};
        const items = itemMap[p.post_id] || [];
        const pvotes = voteMap[p.post_id] || [];
        const pcmts = cmtMap[p.post_id] || [];
        const stats = { points: pointsMap[p.post_id] || 0, minutes: minMap[p.post_id] || 0 };
        return renderSearchPostCard(p, items, pvotes, pcmts, owner, stats);
      }).join("");
      // Re-run the search right after a vote/comment so the ranking updates immediately.
      results.onclick = (e) => onPostClick(e, doSearch);
      hydrateAvatars(results);
    };

    $("#cs-go").onclick = doSearch;
    $("#cs-q").addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
  }

  function renderSearchPostCard(p, items, votes, comments, owner, stats) {
    const up = votes.filter((v) => v.vote === "up").length;
    const down = votes.filter((v) => v.vote === "down").length;
    const mine = myVoteIn(votes);
    const points = stats?.points ?? up - down;
    const minutes = stats?.minutes ?? 0;
    return `<article class="post-card kind-${escapeHtml(p.kind)}" data-post="${escapeHtml(p.post_id)}" data-owner="${escapeHtml(p.owner_id || "")}">
      <div class="person-row" style="border:0;padding:0;margin-bottom:8px">
        ${avatarImg(p.owner_id, p.owner_username)}
        <div>
          <a href="${profileHref(p.owner_username)}"><strong>@${escapeHtml(p.owner_username)}</strong></a>
          <div class="muted">${String(p.created_at || "").slice(0, 16).replace("T", " ")}</div>
        </div>
        <span class="chip">${kindLabel(p.kind)}</span>
        <span class="chip cs-points" title="${t("prof.pointsHelp")}">${t("prof.recPoints", { n: points })}</span>
        ${minutes ? `<span class="chip cs-minutes">${t("prof.postMin", { n: minutes })}</span>` : ""}
      </div>
      <h3>${escapeHtml(p.title)}</h3>
      ${postContentHtml(p, items)}
      <div class="prof-actions">
        <button class="btn btn-sm ${mine === "up" ? "btn-vote-on" : "btn-ghost"}" data-vote="up" data-pid="${escapeHtml(p.post_id)}" type="button">${t("prof.recommendBtn", { n: up })}</button>
        <button class="btn btn-sm ${mine === "down" ? "btn-vote-on" : "btn-ghost"}" data-vote="down" data-pid="${escapeHtml(p.post_id)}" type="button">${t("prof.dont", { n: down })}</button>
      </div>
      <div class="stack" style="margin-top:10px">
        ${(comments || []).map((c) => `<p><a href="${profileHref(c.username)}"><strong>@${escapeHtml(c.username)}</strong></a> ${escapeHtml(c.comment)}</p>`).join("")}
        ${state.me ? `<div class="form-row"><input data-cmt="${escapeHtml(p.post_id)}" placeholder="${t("prof.writeCmt")}" /><button class="btn btn-sm btn-primary" data-send-cmt="${escapeHtml(p.post_id)}" type="button">${t("prof.comment")}</button></div>` : ""}
      </div>
      <div class="post-share">${shareRowHtml(postHref(p), postShareText(p), { compact: true, track: p.post_id })}</div>
    </article>`;
  }

  function drawProfilesSearch(main) {
    const box = main.querySelector("#stab-profiles");
    box.innerHTML = `
      <div class="stack">
        <input id="q-user" placeholder="${t("reg.username")}" />
        <div class="form-row">
          <select id="q-gender"><option value="">${t("prof.anyGender")}</option><option value="male">Male</option><option value="female">Female</option></select>
          <input id="q-country" placeholder="${t("common.country")}" />
          <input id="q-age" type="number" placeholder="${t("prof.maxAge")}" />
        </div>
        <button class="btn btn-sm btn-primary" id="q-go" type="button">${t("nav.search")}</button>
      </div>
      <div id="q-out" style="margin-top:16px"></div>`;
    const doSearch = async () => {
      const q = box.querySelector("#q-user").value.trim();
      if (!q) return toast(t("prof.enterUser"));
      const res = await supabaseRequest(
        `/rest/v1/profiles?username=ilike.*${restValue(q)}*&select=*&limit=40`
      );
      let rows = res.data || [];
      const names = rows.map((r) => r.username);
      const mems = names.length
        ? await supabaseRequest(
            `/rest/v1/members?username=in.(${names.join(",")})&select=username,member_id,gender,birth_date,country`
          )
        : { data: [] };
      const mmap = {};
      (mems.data || []).forEach((m) => {
        mmap[m.username] = m;
      });
      const gender = box.querySelector("#q-gender").value;
      const country = box.querySelector("#q-country").value.trim().toLowerCase();
      const maxAge = Number(box.querySelector("#q-age").value) || 0;
      rows = rows.filter((r) => {
        const m = mmap[r.username] || {};
        if (gender && m.gender !== gender) return false;
        if (country && String(m.country || "").toLowerCase() !== country) return false;
        if (maxAge) {
          const a = ageOf(m.birth_date);
          if (a == null || a > maxAge) return false;
        }
        return true;
      });
      await primeAvatars(rows.map((r) => r.member_id || (mmap[r.username] || {}).member_id), rows.map((r) => r.username));
      box.querySelector("#q-out").innerHTML = rows.length
        ? rows
            .map((r) => {
              const m = mmap[r.username] || {};
              const age = ageOf(m.birth_date);
              return `<div class="person-row">
                <img src="${escapeHtml(avatarOf(r, r.username))}" alt="" data-avatar-for="${escapeHtml(r.member_id || m.member_id || "")}" data-avatar-name="${escapeHtml(r.username || "")}" />
                <div>
                  <strong>@${escapeHtml(r.username)}</strong>
                  <div class="muted">${Number(r.followers||0)} followers · ${Number(r.following||0)} following · ${escapeHtml(m.gender ? tr(m.gender) : "—")} · ${age ?? "—"} · ${escapeHtml(m.country || "—")}</div>
                </div>
                <a class="btn btn-sm btn-primary" href="${profileHref(r.username)}">${t("common.visit")}</a>
              </div>`;
            })
            .join("")
        : `<p class="empty">${t("prof.noMatch")}</p>`;
    };
    box.querySelector("#q-go").onclick = doSearch;
    box.querySelector("#q-user").addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
  }

  async function viewFollowing(main) {
    const me = state.me.member.member_id;
    const sent = await supabaseRequest(`/rest/v1/follows?follower_id=eq.${restValue(me)}&status=eq.pending&select=*`);
    const recv = await supabaseRequest(`/rest/v1/follows?following_id=eq.${restValue(me)}&status=eq.pending&select=*`);
    const acceptedByMe = await supabaseRequest(`/rest/v1/follows?following_id=eq.${restValue(me)}&status=eq.accepted&select=*`);
    const acceptedByOthers = await supabaseRequest(`/rest/v1/follows?follower_id=eq.${restValue(me)}&status=eq.accepted&select=*`);
    const tabs = [
      { key: "sent", title: t("prof.sentReq"), rows: sent.data || [], actions: (r) => personActions(r.following_username, r.following_id, `<button class="btn btn-sm btn-ghost" data-cancel="${r.id}" type="button">${t("prof.cancel")}</button>`) },
      { key: "recv", title: t("prof.recvReq"), rows: recv.data || [], actions: (r) => personActions(r.follower_username, r.follower_id, `<button class="btn btn-sm btn-primary" data-acc="${r.id}" data-fid="${escapeHtml(r.follower_id)}" type="button">${t("prof.accept")}</button><button class="btn btn-sm btn-ghost" data-rej="${r.id}" type="button">${t("prof.decline")}</button>`) },
      { key: "accMe", title: t("prof.accByYou"), rows: acceptedByMe.data || [], actions: (r) => personActions(r.follower_username, r.follower_id, `<span class="muted">${String(r.accepted_at||"").slice(0,16).replace("T"," ")}</span>`) },
      { key: "accOthers", title: t("prof.accByOthers"), rows: acceptedByOthers.data || [], actions: (r) => personActions(r.following_username, r.following_id, `<span class="muted">${String(r.accepted_at||"").slice(0,16).replace("T"," ")}</span>`) },
    ];
    if (!tabs.some((x) => x.key === state.followTab)) state.followTab = "sent";
    const pairs = tabs
      .flatMap((x) => x.rows)
      .flatMap((r) => [
        { id: r.follower_id, u: r.follower_username },
        { id: r.following_id, u: r.following_username },
      ])
      .filter((x) => x.id || x.u);
    await primeAvatars(pairs.map((x) => x.id), pairs.map((x) => x.u));
    main.innerHTML = `<p class="eyebrow">${t("prof.network")}</p><h1>${t("prof.following")}</h1>
      <div class="tabs follow-tabs" role="tablist">
        ${tabs.map((x) => `<button type="button" role="tab" class="follow-tab${x.key === state.followTab ? " active" : ""}" data-ftab="${x.key}" aria-selected="${x.key === state.followTab}">${x.title}<span class="follow-count">${x.rows.length}</span></button>`).join("")}
      </div>
      ${tabs.map((x) => `<div class="follow-pane" data-fpane="${x.key}" role="tabpanel"${x.key === state.followTab ? "" : " hidden"}>${x.rows.length ? x.rows.map(x.actions).join("") : `<p class="empty">${t("prof.none")}</p>`}</div>`).join("")}`;
    main.onclick = async (e) => {
      const ftab = e.target.closest("[data-ftab]");
      if (ftab) {
        state.followTab = ftab.dataset.ftab;
        main.querySelectorAll("[data-ftab]").forEach((b) => {
          const on = b.dataset.ftab === state.followTab;
          b.classList.toggle("active", on);
          b.setAttribute("aria-selected", String(on));
        });
        main.querySelectorAll("[data-fpane]").forEach((pane) => { pane.hidden = pane.dataset.fpane !== state.followTab; });
        return;
      }
      const cancel = e.target.closest("[data-cancel]");
      const acc = e.target.closest("[data-acc]");
      const rej = e.target.closest("[data-rej]");
      if (cancel) {
        await supabaseRequest(`/rest/v1/follows?id=eq.${cancel.dataset.cancel}`, { method: "DELETE" });
        toast(t("prof.cancelled"));
        viewFollowing(main);
      }
      if (acc) {
        await supabaseRequest(`/rest/v1/follows?id=eq.${acc.dataset.acc}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "accepted", accepted_at: new Date().toISOString() }),
        });
        await recount(me);
        if (acc.dataset.fid) await recount(acc.dataset.fid);
        toast(t("prof.accepted"));
        viewFollowing(main);
      }
      if (rej) {
        await supabaseRequest(`/rest/v1/follows?id=eq.${rej.dataset.rej}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "rejected" }),
        });
        toast(t("prof.declined"));
        viewFollowing(main);
      }
    };
  }

  function personActions(username, id, extra) {
    return `<div class="person-row">
      ${avatarImg(id, username)}
      <div><strong>@${escapeHtml(username)}</strong><div class="muted">${escapeHtml(id || "")}</div></div>
      <div class="prof-actions">
        <a class="btn btn-sm btn-primary" href="${profileHref(username)}">${t("common.visit")}</a>
        ${extra}
      </div>
    </div>`;
  }

  // ---------- Your content (the member's videos, js/content-studio.js) ----------
  function viewContent(main) {
    if (!window.CineAuraStudio) {
      main.innerHTML = `<p class="empty">${escapeHtml(t("vid.setup"))}</p>`;
      return;
    }
    window.CineAuraStudio.render(main, { member: state.me.member });
  }

  async function viewBlocked(main) {
    const res = await supabaseRequest(
      `/rest/v1/blocks?blocker_id=eq.${restValue(state.me.member.member_id)}&select=*&order=created_at.desc`
    );
    const rows = res.data || [];
    await primeAvatars(rows.map((b) => b.blocked_id), rows.map((b) => b.blocked_username));
    main.innerHTML = `<p class="eyebrow">${t("prof.safety")}</p><h1>${t("prof.blocked")}</h1>
      ${rows.length ? rows.map((b) => `
        <div class="person-row">
          ${avatarImg(b.blocked_id, b.blocked_username)}
          <div>
            <strong>@${escapeHtml(b.blocked_username)}</strong>
            <div class="muted">${b.kind === "full" ? t("prof.fullBlock") : `${t("prof.partialBlock")} · ${escapeHtml(b.features || "")}`}</div>
          </div>
          <button class="btn btn-sm btn-ghost" data-un="${escapeHtml(b.blocked_id)}" type="button">${t("prof.unblock")}</button>
        </div>`).join("") : `<p class="empty">${t("prof.noBlocked")}</p>`}`;
    main.onclick = async (e) => {
      const b = e.target.closest("[data-un]");
      if (!b) return;
      await unblock(b.dataset.un);
      toast(t("prof.unblocked"));
      viewBlocked(main);
    };
  }

  async function viewSettings(main) {
    // The form always edits the signed-in member's own profile — never the
    // profile whose page is open — so Settings on someone else's page cannot
    // leak their details into the fields or overwrite them on save.
    if (state.me && !state.me.profile) state.me.profile = {};
    const mine = state.me.profile;
    const p = state.isOwner ? state.host || {} : mine;
    const hostName = state.hostMember?.username || "";
    main.innerHTML = `
      <p class="eyebrow">${t("dash.settings.eyebrow")}</p>
      <h1>${t("prof.settings")}</h1>
      ${state.isOwner ? "" : `<p class="muted settings-note">${t("prof.settingsNote", { name: hostName })}</p>`}
      <div class="stack">
        ${window.CineAura.avatarFieldHtml({ id: "st-avatar", value: p.avatar_url || "", name: state.me.member.username, memberId: state.me.member.member_id })}
        <input id="st-name" value="${escapeHtml(p.display_name || "")}" placeholder="${t("common.displayName")}" />
        <textarea id="st-bio" placeholder="${t("common.bio")}">${escapeHtml(p.bio || "")}</textarea>
        <select id="st-follow">
          <option value="instant">${t("prof.inst")}</option>
          <option value="approve">${t("prof.approve")}</option>
          <option value="closed">${t("prof.closedPol")}</option>
        </select>
        <p class="muted">${t("prof.visible")}</p>
        <label class="lang-chip"><input type="checkbox" id="st-country" ${p.show_country !== false ? "checked" : ""} /> ${t("common.country")}</label>
        <label class="lang-chip"><input type="checkbox" id="st-gender" ${p.show_gender !== false ? "checked" : ""} /> ${t("reg.gender")}</label>
        <label class="lang-chip"><input type="checkbox" id="st-lang" ${p.show_language !== false ? "checked" : ""} /> ${t("common.language")}</label>
        <textarea id="st-sites" placeholder="${t("prof.websites")}">${escapeHtml(p.websites || "")}</textarea>
        <button class="btn btn-lg btn-primary" id="st-save" type="button">${t("common.save")}</button>
      </div>`;
    $("#st-follow").value = p.follow_policy || "instant";
    // An uploaded photo replaces the old file at once, so the profile gets its link at once too.
    window.CineAura.wireAvatarField(main, {
      memberId: state.me.member.member_id,
      name: state.me.member.username,
      save: async (url) => {
        const res = await supabaseRequest(
          `/rest/v1/profiles?member_id=eq.${restValue(state.me.member.member_id)}`,
          { method: "PATCH", body: JSON.stringify({ avatar_url: url }) }
        );
        if (!res.ok) return false;
        mine.avatar_url = url;
        if (state.isOwner && state.host) state.host.avatar_url = url;
        window.CineAura.refreshAvatar(state.me.member.member_id, url);
        return true;
      },
    });
    $("#st-save").onclick = async () => {
      const body = {
        avatar_url: $("#st-avatar").value.trim(),
        display_name: $("#st-name").value.trim(),
        bio: $("#st-bio").value,
        follow_policy: $("#st-follow").value,
        show_country: $("#st-country").checked,
        show_gender: $("#st-gender").checked,
        show_language: $("#st-lang").checked,
        websites: $("#st-sites").value.trim(),
      };
      const saved = await supabaseRequest(
        `/rest/v1/profiles?member_id=eq.${restValue(state.me.member.member_id)}`,
        { method: "PATCH", body: JSON.stringify(body) }
      );
      if (!saved.ok) return toast(t("prof.saveFail"));
      // Reflect the edit in the in-memory copy of the profile it belongs to.
      Object.assign(state.isOwner ? state.host : mine, body);
      // Keep the header avatar (and every other avatar of this member) in sync.
      window.CineAura.refreshAvatar(state.me.member.member_id, body.avatar_url);
      toast(t("prof.saved"));
    };
  }

  // A shared link opened one post: wait for the activity wall to draw it, then
  // scroll to it and mark it. A post the viewer may not see (private, or
  // exclusive with conditions that do not match) never reaches the wall.
  async function focusSharedPost(postId) {
    state.section = "home";
    state.homeTab = "activity";
    const find = () =>
      [...document.querySelectorAll("#home-body .post-card")].find((c) => c.dataset.post === postId) || null;
    for (let i = 0; i < 80 && !find(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const card = find();
    if (!card) {
      toast(t("prof.postHidden"));
      return;
    }
    card.classList.add("post-focus");
    card.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  async function boot() {
    setupChrome();
    const postId = sharedPostId();
    let username = parseHostName();
    state.session = getSession();
    state.me = await loadMe();
    if (state.me && window.CineAura.normalizeAccountStatus(state.me.member.status) === "banned") {
      $("#prof-root").innerHTML = `<section class="glass dash-gate"><h1>${t("dash.bannedTitle")}</h1><p>${t("dash.bannedText")}</p><button class="btn btn-lg btn-danger" id="gate-logout" type="button">${t("nav.logout")}</button></section>`;
      $("#gate-logout").onclick = () => { window.CineAura.logout(); location.href = "./"; };
      return;
    }
    // A shared post link names the post, not the member: the post row itself
    // says whose profile has to open.
    if (postId && !explicitUsername()) {
      const row = await sbRequest(
        `/rest/v1/posts?post_id=eq.${restValue(postId)}&select=owner_username`
      );
      const owner = row.ok && Array.isArray(row.data) ? String(row.data[0]?.owner_username || "") : "";
      if (!owner) {
        $("#prof-root").innerHTML = `<section class="glass dash-gate"><h1>${t("prof.notFound")}</h1><p>${t("prof.postGone")}</p></section>`;
        return;
      }
      username = owner;
    }
    if (!username) {
      $("#prof-root").innerHTML = `<section class="glass dash-gate"><h1>${t("nav.profile")}</h1><p>${t("prof.signOpen")}</p><a class="btn btn-primary" href="./login.html">${t("common.signin")}</a></section>`;
      return;
    }
    const host = await loadByUsername(username);
    if (!host.member && !host.profile) {
      $("#prof-root").innerHTML = `<section class="glass dash-gate"><h1>${t("prof.notFound")}</h1><p>${t("prof.noProfile", { name: escapeHtml(username) })}</p></section>`;
      return;
    }
    state.host = host.profile || { username, followers: 0, following: 0 };
    state.hostMember = host.member || { username, member_id: host.profile?.member_id };
    state.isOwner = Boolean(state.me && state.hostMember.member_id === state.me.member.member_id);
    const ownSeed = () => ({
      member_id: state.me.member.member_id,
      username: state.me.member.username,
      display_name: state.me.member.full_name || "",
      bio: "",
      avatar_url: "",
      followers: 0,
      following: 0,
      follow_policy: "instant",
      show_country: true,
      show_gender: true,
      show_language: true,
      websites: "",
      language: "en",
    });
    // A signed-in member always needs a profiles row: the sidebar avatar, the
    // Settings form and the post-visibility rules all read it — also when the
    // page being visited belongs to somebody else.
    if (state.me && !state.me.profile) {
      const row = ownSeed();
      const created = await supabaseRequest("/rest/v1/profiles", { method: "POST", body: JSON.stringify(row) });
      if (created.ok) state.me.profile = row;
    }
    if (state.isOwner && !host.profile) state.host = state.me.profile || ownSeed();
    await loadRelations();
    await loadHostStatus();
    // Profile.html#content (and #content/manage, #content/stats) opens "Your content"
    if (state.me && /^#content(\/|$)/.test(location.hash)) state.section = "content";
    // (round 31) Profile.html#create/review/CT… (Content.html > Write a review / Recommend in a post)
    const cw = createFromHash();
    if (state.me && cw) {
      state.section = "create";
      state.createWant = cw;
    }
    // Profile.html?@name#videos, #playlists, #playlist/CPL… open the Content tab
    const pcWant = pcFromHash();
    if (pcWant && !postId) {
      state.homeTab = "content";
      Object.assign(pcState(), pcWant);
    }
    // Profile.html?@name#market (#market/recs | lists | reviews) opens the Market tab
    const mkWant = mkFromHash();
    if (mkWant && !postId) {
      state.homeTab = "market";
      mkState().tab = mkWant.tab;
    }
    renderShell();
    // A "?post=" link lands on the post itself, once the wall has drawn it.
    if (postId) focusSharedPost(postId);
    window.addEventListener("hashchange", onHashChange);
  }

  // #create/<recommendation | reclist | review>/<CT…> -> { kind, video }
  function createFromHash() {
    const m = /^#create\/(recommendation|reclist|review)(?:\/(CT[0-9A-Za-z]{1,20}))?$/.exec(location.hash || "");
    return m ? { kind: m[1], video: m[2] || "" } : null;
  }

  // Links and back / forward inside the page: the views of the Content tab
  // (#videos, #playlists, #playlist/CPL…) and "Your content" (#content…).
  function onHashChange() {
    if (!state.hostMember) return;
    const cw = createFromHash();
    if (state.me && cw) {
      state.createWant = cw;
      state.section = "create";
      renderShell();
      return;
    }
    const mkWant = mkFromHash();
    if (mkWant) {
      const mk = mkState();
      const changed = mk.tab !== mkWant.tab;
      mk.tab = mkWant.tab;
      if (state.section === "home" && state.homeTab === "market" && $("#pm-list")) {
        if (changed) mkShowTab();
        return;
      }
      state.section = "home";
      state.homeTab = "market";
      renderShell();
      return;
    }
    const want = pcFromHash();
    if (want) {
      Object.assign(pcState(), want);
      if (state.section === "home" && state.homeTab === "content" && $("#pc-pane")) {
        pcShow();
        return;
      }
      state.section = "home";
      state.homeTab = "content";
      renderShell();
      return;
    }
    if (state.me && /^#content(\/|$)/.test(location.hash) && state.section !== "content") {
      state.section = "content";
      renderShell();
    }
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
