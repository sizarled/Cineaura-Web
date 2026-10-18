/* CineAura — Search.html: one search for the whole site (sql/search.sql: site_search), in tabs.

   Videos     the members' videos, their playlists, the recommendations and reviews of a video
   Movies     the films of TMDB (trending without words), the members' recommendations, reviews
              and playlists of movies
   Series     the same for series
   Channels   CineAura's free channels (the free list IPTV-Free.m3u, read here, and the free
              packages of Panel > IPTV), CineAura's lists (the free and the premium list, the
              packages), the channels of the members' public and exclusive lists (an exclusive
              one with its lock: it opens for the members who meet the publisher's criteria and,
              when it has some, type one of its passwords) and the members' lists (a private one
              with "Request to join", unless the publisher keeps it out of the search)
   Profiles   members, their posts, their recommendations
   Market     products, categories, purchase recommendations, reviews, purchase lists
   Prizes     prizes, challenges, lotteries, prize groups

   Each tab: All (the first results of every kind) or one kind; "Added" (today, yesterday, this
   week, this month, this year, all time) and the sort: ranking points (the default), newest,
   oldest, A→Z, Z→A. Every result shows its ranking points and what they count (sql/search.sql):
   videos, playlists, channels and IPTV lists + 60 a watched minute, − 60 a valid report, + 30 a
   recommendation or re-recommendation, − 30 a "don't recommend", + 1 a comment, + 1 a share of the
   link; movies and series their TMDB rating.

   The address keeps every choice: ?q=&tab=&type=&when=&sort= (+ lang, region, age, tag, owner on
   Videos, lang on Movies / Series, kind on Channels). Old addresses still work (?tab=tmdb,
   ?tab=channels&type=movie, ?sort=views…).
*/
(() => {
  "use strict";
  const C = window.CineAura;
  const V = window.CineAuraVideos;
  const L = () => window.CineAuraIptvLists;
  const M = () => window.CineAuraMarket;
  const { t, escapeHtml: esc } = C;

  const TABS = ["videos", "movies", "series", "channels", "profiles", "market", "prizes"];
  const TYPES = {
    videos: ["video", "playlist", "rec", "review"],
    movies: ["movie", "rec", "review", "playlist"],
    series: ["series", "rec", "review", "playlist"],
    channels: ["free", "site", "member", "list"],
    profiles: ["profile", "post", "rec"],
    market: ["product", "category", "rec", "review", "list"],
    prizes: ["prize", "challenge", "lottery", "group"],
  };
  // the kinds read in this page, not by site_search
  const LOCAL = { movie: true, series: true };
  const WHEN = ["", "today", "yesterday", "week", "month", "year"];
  const SORTS = ["rank", "new", "old", "az", "za"];
  const KINDS = ["live", "movie", "series"];
  const PAGE = 24;
  const SECTION = 8;
  // how a result is drawn: a grid of cards, a list of rows, the posters of TMDB
  const LAYOUT = {
    video: "grid", playlist: "grid", rec: "list", review: "list", post: "list", movie: "posters", series: "posters",
    free: "rows", site: "grid", member: "rows", list: "grid", profile: "grid",
    product: "grid", category: "grid", prize: "grid", challenge: "grid", lottery: "grid", group: "grid",
  };
  const MARKET_LIST = { rec: true, review: true, list: true };

  // ---------------------------------------------------------------- icons
  const svg = (body, size = 18, sw = 2) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
  const ICON = {
    videos: svg('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 9.5v5l4.5-2.5z"/>'),
    movies: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>'),
    series: svg('<rect x="2.5" y="6" width="19" height="13" rx="2.5"/><path d="M8 2.5l4 3.5 4-3.5"/>'),
    channels: svg('<path d="M4.9 19.1a10 10 0 0 1 0-14.2M19.1 4.9a10 10 0 0 1 0 14.2M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4"/><circle cx="12" cy="12" r="1.8"/>'),
    profiles: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.5a6.5 6.5 0 0 1 3 5.5"/>'),
    market: svg('<path d="M5 8h14l-1.2 11.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>'),
    prizes: svg('<path d="M20 12v9H4v-9"/><path d="M2 7h20v5H2z"/><path d="M12 21V7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>'),
    bolt: svg('<path d="M13 2.5L4.5 13.5h6l-1 8 8.5-11h-6z"/>', 14, 2.2),
    star: svg('<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>', 14),
    lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', 14),
    play: svg('<path d="M8 5.5v13l11-6.5z"/>', 14),
    up: svg('<path d="M7 11l5-5 5 5M12 6v12"/>', 14),
    down: svg('<path d="M7 13l5 5 5-5M12 18V6"/>', 14),
    chat: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>', 14),
    list: svg('<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>', 16),
    users: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/>', 14),
    gift: svg('<path d="M20 12v9H4v-9M2 7h20v5H2zM12 21V7"/>', 14),
    tv: svg('<rect x="2.5" y="6" width="19" height="13" rx="2.5"/><path d="M8 2.5l4 3.5 4-3.5"/>', 22, 1.8),
    info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>', 15),
    join: svg('<path d="M15 19a6 6 0 0 0-12 0"/><circle cx="9" cy="8" r="3.5"/><path d="M19 8v6M16 11h6"/>', 15),
  };

  // ---------------------------------------------------------------- state and address
  const params = new URLSearchParams(location.search);
  const pick = (v, list, fallback) => (list.includes(v) ? v : fallback);
  const tabParam = params.get("tab") === "tmdb" ? "movies" : params.get("tab");
  const tab0 = pick(tabParam, TABS, "videos");
  const oldSort = { date: "new", az: "az", za: "za" }[params.get("sort")];
  const state = {
    q: (params.get("q") || "").trim(),
    tab: tab0,
    type: pick(params.get("type"), TYPES[tab0], ""),
    when: pick(params.get("when") || "", WHEN, ""),
    sort: pick(params.get("sort"), SORTS, oldSort || "rank"),
    lang: params.get("lang") || "",
    region: (params.get("region") || "").toUpperCase(),
    age: [3, 6, 13, 16, 18].includes(Number(params.get("age"))) ? String(Number(params.get("age"))) : "",
    tag: (params.get("tag") || "").replace(/^#+/, "").trim().toLowerCase(),
    owner: (params.get("owner") || "").replace(/^@+/, "").trim(),
    // the type of channel (Channels); ?type=movie of the old Channels tab too
    kind: pick(params.get("kind") || (tab0 === "channels" ? params.get("type") : ""), KINDS, ""),
    seq: 0,
    counts: {}, // type -> how many results (the last All, or the kind on show)
    items: [], // the kind on show
    total: 0,
    sections: [], // All
    tmdb: { list: [], page: 0, pages: 1, total: 0 },
    local: null, // a kind paged in this page: { all: [...] }
    m3u: {}, // free | premium -> Promise of the rows of CineAura's list
    ranks: new Map(), // channel key -> { minutes, reports }
    rankWait: new Map(), // channel key -> the channel_ranks call that is bringing it
    asked: new Set(), // private lists the member asked to join on this page
  };
  const $ = (sel) => document.querySelector(sel);
  const fmt = (n) => (V ? V.fmtNum(Number(n) || 0) : String(Number(n) || 0));
  const fmtCount = (n) => (V ? V.fmtCount(Number(n) || 0) : String(Number(n) || 0));
  const me = () => String(C.getSession()?.member_id || "");
  const tz = () => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch {
      return "";
    }
  };

  function syncUrl() {
    const q = new URLSearchParams();
    if (state.q) q.set("q", state.q);
    if (state.tab !== "videos") q.set("tab", state.tab);
    if (state.type) q.set("type", state.type);
    if (state.when) q.set("when", state.when);
    if (state.sort !== "rank") q.set("sort", state.sort);
    if (state.tab === "videos") {
      if (state.lang) q.set("lang", state.lang);
      if (state.region) q.set("region", state.region);
      if (state.age) q.set("age", state.age);
      if (state.tag) q.set("tag", state.tag);
      if (state.owner) q.set("owner", state.owner);
    }
    if ((state.tab === "movies" || state.tab === "series") && state.lang) q.set("lang", state.lang);
    if (state.tab === "channels" && state.kind) q.set("kind", state.kind);
    const s = q.toString();
    history.replaceState(history.state, "", `${location.pathname}${s ? `?${s}` : ""}`);
  }

  // ---------------------------------------------------------------- labels
  const tabLabel = (k) => t(`srch.tab.${k}`);
  function typeLabel(type, tab = state.tab) {
    const own = `srch.t.${tab}.${type}`;
    const s = t(own);
    return s !== own ? s : t(`srch.t.${type}`);
  }
  const whenLabel = (w) => t(`srch.when.${w || "all"}`);

  // ---------------------------------------------------------------- the period of "Added" (TMDB)
  function period(w) {
    const d = new Date();
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    if (w === "today") return [day, null];
    if (w === "yesterday") return [new Date(day.getTime() - 86400000), day];
    if (w === "week") return [new Date(day.getTime() - (((day.getDay() + 6) % 7) * 86400000)), null];
    if (w === "month") return [new Date(d.getFullYear(), d.getMonth(), 1), null];
    if (w === "year") return [new Date(d.getFullYear(), 0, 1), null];
    return [null, null];
  }
  const ymd = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  function inPeriod(iso, w) {
    const [a, b] = period(w);
    if (!a) return true;
    const at = Date.parse(`${String(iso || "").slice(0, 10)}T00:00:00`);
    if (!Number.isFinite(at)) return false;
    return at >= a.getTime() && (!b || at < b.getTime());
  }

  // ---------------------------------------------------------------- ranking points
  // weight of each number a result counts
  const WEIGHT = {
    minutes: 60, reports: -60, recs: 30, rerecs: 30, unrecs: -30, reunrecs: -30, comments: 1, shares: 1,
    followers: 30, sold: 60, pros: 30, cons: -30, reviews: 1, again: 30, products: 1, verified: 60, written: 1,
    participants: 30, visits: 1, prizes: 1,
  };
  const RANK_ORDER = ["minutes", "sold", "participants", "followers", "recs", "rerecs", "again", "pros", "verified", "unrecs",
    "reunrecs", "cons", "comments", "reviews", "written", "shares", "visits", "products", "prizes", "reports"];

  function rankHtml(x) {
    const r = x?.rank;
    if (!r) return "";
    if (r.tmdb != null) {
      const votes = Number(r.votes) || 0;
      return `<span class="sr-rank is-tmdb" title="${esc(t("srch.rk.tmdb", { r: Number(r.tmdb).toFixed(1), n: fmt(votes) }))}">${ICON.star}<b>${esc(Number(r.tmdb).toFixed(1))}</b><span>${esc(t("srch.rk.votes", { n: fmtCount(votes) }))}</span></span>`;
    }
    const pts = Number(r.points) || 0;
    const parts = RANK_ORDER.filter((k) => Number(r[k]) > 0 && WEIGHT[k]).map((k) => {
      const n = Number(r[k]);
      const v = WEIGHT[k] * n;
      return `<li><span>${esc(t(`srch.rk.${k}`, { n: fmt(n), w: String(Math.abs(WEIGHT[k])) }))}</span><b dir="ltr">${v > 0 ? "+" : "−"}${esc(fmt(Math.abs(v)))}</b></li>`;
    });
    return `
      <details class="sr-rank${pts < 0 ? " is-neg" : ""}">
        <summary title="${esc(t("srch.rankWhat"))}">${ICON.bolt}<b dir="ltr">${esc(fmt(pts))}</b><span>${esc(t("srch.pts"))}</span></summary>
        <div class="sr-rank-pop" role="note">
          <p class="sr-rank-h">${esc(t("srch.rankTitle"))}</p>
          ${parts.length ? `<ul>${parts.join("")}</ul>` : `<p class="muted">${esc(t("srch.rankNone"))}</p>`}
          <p class="sr-rank-sum"><span>${esc(t("srch.rankTotal"))}</span><b dir="ltr">${esc(fmt(pts))}</b></p>
        </div>
      </details>`;
  }

  // ---------------------------------------------------------------- small pieces of cards
  const avatar = (id, name, url) => C.avatarImg(id || "", name || "", url || "");
  const userLink = (name) => (name ? `<a class="sr-user" href="${esc(C.profileHref(name))}"><bdi>@${esc(name)}</bdi></a>` : "");
  const when = (iso) => (iso && V ? `<time datetime="${esc(iso)}">${esc(V.timeAgo(iso))}</time>` : "");
  const lockReason = (why, x) => {
    if (!why) return "";
    if (why === "private") return t("srch.lock.private");
    const k = `srch.lock.${why}`;
    const s = t(k, { name: `@${x?.owner || x?.list?.owner || ""}` });
    return s !== k ? s : t("srch.lock.other");
  };
  const lockHtml = (why, x) => (why ? `<span class="sr-lock" title="${esc(lockReason(why, x))}">${ICON.lock}<span>${esc(lockReason(why, x))}</span></span>` : "");

  // A post: a recommendation, a list of recommendations, a review, a playlist, an account
  function postHtml(x) {
    const items = Array.isArray(x.items) ? x.items : [];
    const strip = items.slice(0, 4).map((it) => {
      const video = it.media_type === "video";
      const href = video ? V.contentHref(it.content_id || "") : it.media_type === "person" ? `./Cast.html?person=${it.tmdb_id}` : C.watchHref(it.media_type, it.tmdb_id, null, null, x.id);
      const src = video ? it.poster_path : it.poster_path ? C.imgUrl(it.poster_path, "w185") : "";
      return `<a class="sr-pitem${video ? " is-video" : ""}" href="${esc(href)}" title="${esc(it.title || "")}">
          <span class="sr-pimg">${src ? `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : `<span>${esc(String(it.title || "?").slice(0, 2))}</span>`}${video ? `<i class="sr-pvid">${ICON.play}</i>` : ""}</span>
          <span class="sr-pname" dir="auto">${esc(it.title || "")}</span>
        </a>`;
    }).join("");
    const more = Number(x.item_count) > 4 ? `<span class="sr-pmore">+${esc(fmt(Number(x.item_count) - 4))}</span>` : "";
    const kind = t(`srch.pk.${x.kind}`);
    const pros = String(x.pros || "").split(/\n+/).map((s) => s.trim()).filter(Boolean).slice(0, 3);
    const cons = String(x.cons || "").split(/\n+/).map((s) => s.trim()).filter(Boolean).slice(0, 3);
    return `
      <article class="glass sr-post kind-${esc(x.kind)}" data-post="${esc(x.id)}">
        <header class="sr-post-head">
          <span class="sr-ava">${avatar(x.owner_id, x.owner, x.owner_avatar)}</span>
          <span class="sr-post-who">${userLink(x.owner)} ${when(x.created_at)}</span>
          <span class="sr-chip">${esc(kind)}</span>
          ${x.visibility && x.visibility !== "public" ? `<span class="sr-chip is-${esc(x.visibility)}">${esc(t(`pm.vis.${x.visibility}`))}</span>` : ""}
        </header>
        <a class="sr-post-title" href="${esc(C.postHref(x.id))}" dir="auto">${esc(x.title || "")}</a>
        ${x.body ? `<p class="sr-post-body" dir="auto">${esc(x.body)}</p>` : ""}
        ${strip ? `<div class="sr-pstrip">${strip}${more}</div>` : ""}
        ${x.playlist_id ? `<a class="btn btn-sm btn-ghost" href="./Playlist.html?ID=${encodeURIComponent(x.playlist_id)}">${ICON.list}<span>${esc(t("prof.openPl"))}</span></a>` : ""}
        ${pros.length || cons.length ? `<div class="sr-pc"><ul class="pro">${pros.map((p) => `<li dir="auto">${esc(p)}</li>`).join("")}</ul><ul class="con">${cons.map((p) => `<li dir="auto">${esc(p)}</li>`).join("")}</ul></div>` : ""}
        <footer class="sr-post-foot">
          <span class="sr-num${x.my_vote === "up" ? " is-on" : ""}" title="${esc(t("srch.recommend"))}">${ICON.up}${esc(fmt(x.up))}</span>
          <span class="sr-num${x.my_vote === "down" ? " is-on" : ""}" title="${esc(t("srch.dontRecommend"))}">${ICON.down}${esc(fmt(x.down))}</span>
          <span class="sr-num" title="${esc(t("srch.comments"))}">${ICON.chat}${esc(fmt(x.comments))}</span>
          <a class="sr-open" href="${esc(C.postHref(x.id))}">${esc(t("srch.openPost"))}</a>
          ${rankHtml(x)}
        </footer>
      </article>`;
  }

  // a playlist of videos (Profile.html?@owner#playlist/CPL…)
  function vplaylistHtml(x) {
    const href = `${C.profileHref(x.owner)}#playlist/${encodeURIComponent(x.id)}`;
    return `
      <article class="sr-card sr-vpl" data-pl="${esc(x.id)}">
        <a class="sr-vpl-cover" href="${esc(href)}" style="--sr-h:${V.hueFor(x.id)}">
          ${x.thumb ? `<img src="${esc(x.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ""}
          <span class="sr-vpl-n">${ICON.list}<b>${esc(fmt(x.count))}</b></span>
        </a>
        <div class="sr-card-body">
          <a class="sr-card-title" href="${esc(href)}" dir="auto">${esc(x.name || "")}</a>
          <p class="sr-card-meta">${userLink(x.owner)} · ${esc(t(Number(x.count) === 1 ? "srch.videoOne" : "srch.videosN", { n: fmt(x.count) }))}</p>
          <div class="sr-card-foot">${when(x.created_at)}${rankHtml(x)}</div>
        </div>
      </article>`;
  }

  // a playlist of movies or series (Playlist.html?ID=)
  function mplaylistHtml(x) {
    const href = `./Playlist.html?ID=${encodeURIComponent(x.id)}`;
    const posters = (Array.isArray(x.posters) ? x.posters : []).slice(0, 4);
    return `
      <article class="sr-card sr-mpl" data-pl="${esc(x.id)}">
        <a class="sr-mosaic n${posters.length}" href="${esc(href)}">${posters.map((p) => `<img src="${esc(C.imgUrl(p, "w185"))}" alt="" loading="lazy" />`).join("") || `<span class="sr-mosaic-ph">${ICON.movies}</span>`}</a>
        <div class="sr-card-body">
          <a class="sr-card-title" href="${esc(href)}" dir="auto">${esc(x.name || "")}</a>
          <p class="sr-card-meta">${userLink(x.owner)} · ${esc(t(Number(x.count) === 1 ? "srch.titleOne" : "srch.titlesN", { n: fmt(x.count) }))}${x.visibility && x.visibility !== "public" ? ` · ${esc(t(`common.${x.visibility}`))}` : ""}</p>
          ${x.description ? `<p class="sr-card-desc" dir="auto">${esc(x.description)}</p>` : ""}
          <div class="sr-card-foot">${when(x.created_at)}${rankHtml(x)}</div>
        </div>
      </article>`;
  }

  // a TMDB film or series: its poster, with its rating as the ranking
  function tmdbHtml(x) {
    return `<div class="sr-poster">${C.posterCard(x, x.media_type === "tv" ? "tv" : "movie")}${rankHtml(x)}</div>`;
  }

  // a channel: CineAura's (free / premium list, a package) or of a member's list
  function channelHtml(x, href, sub, why) {
    const logo = /^https?:\/\//i.test(x.logo || "")
      ? `<img src="${esc(x.logo)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()" />`
      : "";
    const kind = KINDS.includes(x.kind) ? x.kind : "live";
    const initials = String(x.name || "TV").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "TV";
    return `
      <div class="sr-ch-row${why ? " is-locked" : ""}">
        <a class="ipl-ch sr-ch" href="${esc(href)}">
          <span class="ipl-ch-logo" style="--ipl-h:${L() ? L().hueOf(x.list?.id || x.package || x.id) : 204}"><span>${esc(initials)}</span>${logo}</span>
          <span class="ipl-ch-text">
            <b dir="auto">${esc(x.name || "")}</b>
            <small><span class="ipl-kind is-${kind}">${esc(t(`chan.type.${kind}`))}</span>${x.group ? ` · <bdi>${esc(x.group)}</bdi>` : ""}</small>
            <small class="ipl-ch-list">${sub}</small>
          </span>
          <span class="ipl-ch-play" aria-hidden="true">${why ? ICON.lock : ICON.play}</span>
        </a>
        ${why ? `<p class="sr-ch-lock">${lockHtml(why, x.list || {})}</p>` : ""}
        ${rankHtml(x)}
      </div>`;
  }
  const freeHref = (x) => `./Listchannels.html?free=1&channel=${encodeURIComponent(x.id)}&name=${encodeURIComponent(x.name || "")}`;
  function freeChannelHtml(x) {
    const sub = `<span class="sr-official">${esc(t("srch.cineaura"))}</span> · <bdi>${esc(x.m3u ? t("home.iptv.free") : x.package || "")}</bdi>`;
    return channelHtml(x, freeHref(x), sub, "");
  }
  function memberChannelHtml(x) {
    const l = x.list || {};
    const href = L() ? L().channelHref(x) : `./Listchannels.html?list=${encodeURIComponent(l.id || "")}`;
    const badge = l.visibility === "exclusive" && L() ? L().badgeHtml(l) : "";
    const sub = `${badge}<bdi dir="auto">${esc(l.name || "")}</bdi> · <bdi>@${esc(l.owner || "")}</bdi>`;
    return channelHtml(x, href, sub, x.locked || "");
  }

  // CineAura's lists: the free list, the premium list (read here), the packages of Panel > IPTV
  function siteListHtml(x) {
    const href = x.href || `./Listchannels.html?package=${encodeURIComponent(x.name || "")}`;
    const hits = Array.isArray(x.hits) ? x.hits : [];
    const kinds = [["live", x.live], ["movie", x.movies], ["series", x.series]].filter(([, n]) => Number(n) > 0);
    return `
      <article class="ipl-card sr-site${x.premium ? " is-premium" : ""}" data-site="${esc(x.id)}">
        <a class="ipl-card-main" href="${esc(href)}">
          <span class="ipl-cover" style="--ipl-h:${x.premium ? 44 : 162}" aria-hidden="true">${ICON.tv}<b>${esc(fmtCount(x.channels))}</b><small>${esc(t("common.channels"))}</small></span>
          <span class="ipl-card-text">
            <span class="ipl-badges"><span class="ipl-badge is-official">${esc(t("srch.cineaura"))}</span><span class="ipl-badge ${x.premium ? "is-exclusive" : "is-public"}">${esc(t(x.premium ? "srch.premiumBadge" : "srch.freeBadge"))}</span></span>
            <h3 dir="auto">${esc(x.title || x.name || "")}</h3>
            <span class="ipl-desc">${esc(t(x.premium ? "srch.siteNotePremium" : "srch.siteNoteFree"))}</span>
          </span>
        </a>
        ${kinds.length ? `<p class="ipl-kinds">${kinds.map(([k, n]) => `<span class="ipl-kind is-${k}">${esc(t(`chan.f.${k}`))} <b>${esc(fmt(n))}</b></span>`).join("")}</p>` : ""}
        ${hits.length ? `<div class="sr-site-hits"><p>${esc(t(hits.length === 1 ? "srch.hitOne" : "srch.hitsN", { n: fmt(x.hitCount || hits.length) }))}</p>${hits.slice(0, 6).map((h) => `<a class="sr-hit" href="${esc(`${href}&channel=${encodeURIComponent(h.id)}&name=${encodeURIComponent(h.name)}`)}" dir="auto">${esc(h.name)}</a>`).join("")}</div>` : ""}
        <footer class="ipl-actions"><a class="btn btn-sm btn-primary" href="${esc(href)}">${ICON.play}<span>${esc(t("ipl.open"))}</span></a>${rankHtml(x)}</footer>
      </article>`;
  }

  // a member's IPTV list: its lock, and "Request to join" for a private one
  function memberListHtml(x) {
    return L() ? L().cardHtml(x, { rank: rankHtml(x) }) : "";
  }

  function profileHtml(x) {
    const name = x.display_name || x.username;
    const href = C.profileHref(x.username);
    const facts = [
      t(Number(x.followers) === 1 ? "srch.followerOne" : "srch.followersN", { n: fmt(x.followers) }),
      t(Number(x.videos) === 1 ? "srch.videoOne" : "srch.videosN", { n: fmt(x.videos) }),
      t(Number(x.posts) === 1 ? "srch.postOne" : "srch.postsN", { n: fmt(x.posts) }),
    ];
    const lv = Number(x.level);
    return `
      <article class="sr-card sr-prof" data-member="${esc(x.id)}">
        <a class="sr-prof-top" href="${esc(href)}">
          <span class="sr-prof-ava">${avatar(x.id, x.username, x.avatar)}</span>
          <span class="sr-prof-name"><b dir="auto">${esc(name)}</b><bdi>@${esc(x.username)}</bdi></span>
        </a>
        <p class="sr-prof-tags">
          <span class="sr-chip is-level">${esc(lv >= 10 ? "LV Max" : `LV${Number.isFinite(lv) ? lv : 0}`)}</span>
          ${x.country ? `<span class="sr-chip">${esc(C.countryName(x.country) || x.country)}</span>` : ""}
          ${x.me ? `<span class="sr-chip is-me">${esc(t("srch.you"))}</span>` : x.follow === "accepted" ? `<span class="sr-chip is-follow">${esc(t("srch.following"))}</span>` : x.follow === "pending" ? `<span class="sr-chip">${esc(t("srch.followPending"))}</span>` : ""}
        </p>
        ${x.bio ? `<p class="sr-card-desc" dir="auto">${esc(x.bio)}</p>` : ""}
        <p class="sr-card-meta">${facts.map(esc).join(" · ")}</p>
        <div class="sr-card-foot">${esc(t("srch.joined", { when: V ? V.timeAgo(x.created_at) : "" }))}${rankHtml(x)}</div>
      </article>`;
  }

  // a prize; a challenge or a lottery shows that mode
  function prizeHtml(x) {
    const g = x.group || {};
    const href = `./Prize.html?${g.id ? `GroupPrize=${encodeURIComponent(g.id)}&` : ""}Prize=${encodeURIComponent(x.id)}`;
    const modes = Array.isArray(x.modes) ? x.modes : [];
    const focus = x.focus ? modes.find((m) => m.mode === x.focus) : null;
    const chips = modes.map((m) => `<span class="sr-mode is-${esc(m.mode)}${focus && focus.mode === m.mode ? " is-focus" : ""}">${esc(t(`srch.mode.${m.mode}`))} · <b dir="ltr">${esc(fmt(m.cost))} PT</b></span>`).join("");
    let detail = "";
    if (focus && focus.mode === "challenge") {
      detail = t("srch.challengeLine", { n: fmt(focus.participants), q: focus.quantity ? fmt(focus.quantity) : "∞", c: fmt(focus.conditions) });
    } else if (focus && focus.mode === "lottery") {
      detail = focus.draw_at ? t("srch.lotteryLine", { n: fmt(focus.participants), d: fmt(focus.draw_at), w: fmt(focus.winners || 1) }) : t("srch.lotteryLineOpen", { n: fmt(focus.participants), w: fmt(focus.winners || 1) });
    }
    const pct = focus && focus.mode === "lottery" && Number(focus.draw_at) > 0 ? Math.min(100, Math.round((Number(focus.participants) / Number(focus.draw_at)) * 100)) : null;
    const img = x.image ? `<img src="${esc(x.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : `<span class="sr-prize-ph">${ICON.prizes}</span>`;
    return `
      <article class="sr-card sr-prize is-${esc(x.status || "open")}" data-prize="${esc(x.id)}">
        <a class="sr-prize-media" href="${esc(href)}">${img}<span class="sr-prize-st">${esc(t(`srch.pst.${x.status || "open"}`))}</span></a>
        <div class="sr-card-body">
          <a class="sr-card-title" href="${esc(href)}" dir="auto">${esc(x.title || "")}</a>
          ${g.name ? `<p class="sr-card-meta"><a href="./Prize.html?GroupPrize=${encodeURIComponent(g.id)}">${esc(g.name)}</a></p>` : ""}
          ${chips ? `<p class="sr-modes">${chips}</p>` : ""}
          ${detail ? `<p class="sr-prize-line">${esc(detail)}</p>` : ""}
          ${pct != null ? `<div class="sr-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>` : ""}
          <div class="sr-card-foot">${x.ends_at ? `<span>${esc(t("srch.endsOn", { date: String(x.ends_at).slice(0, 10) }))}</span>` : when(x.created_at)}${rankHtml(x)}</div>
        </div>
      </article>`;
  }

  function prizeGroupHtml(x) {
    const href = `./Prize.html?GroupPrize=${encodeURIComponent(x.id)}`;
    return `
      <article class="sr-card sr-pgroup" data-group="${esc(x.id)}">
        <a class="sr-prize-media" href="${esc(href)}">${x.thumb ? `<img src="${esc(x.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : `<span class="sr-prize-ph">${ICON.gift}</span>`}</a>
        <div class="sr-card-body">
          <a class="sr-card-title" href="${esc(href)}" dir="auto">${esc(x.name || "")}</a>
          <p class="sr-card-meta">${esc(t(Number(x.prizes) === 1 ? "srch.prizeOne" : "srch.prizesN", { n: fmt(x.prizes) }))} · ${esc(t("srch.openN", { n: fmt(x.open) }))}</p>
          <div class="sr-card-foot">${when(x.created_at)}${rankHtml(x)}</div>
        </div>
      </article>`;
  }

  function marketHtml(type, x) {
    const MK = M();
    if (!MK) return "";
    if (type === "product") return `<div class="sr-mk">${MK.cardHtml(x)}${rankHtml(x)}</div>`;
    if (type === "category") return `<div class="sr-mk">${MK.categoryCardHtml(x)}${rankHtml(x)}</div>`;
    return `<div class="sr-mk-item">${MK.itemHtml(x)}<div class="sr-mk-rank">${rankHtml(x)}</div></div>`;
  }

  function cardHtml(type, x) {
    if (!x) return "";
    const tab = state.tab;
    if (tab === "videos" && type === "video") {
      return `<div class="sr-cell">${V.cardHtml(x, { vis: true })}<div class="sr-cell-foot">${rankHtml(x)}</div></div>`;
    }
    if (tab === "videos" && type === "playlist") return vplaylistHtml(x);
    if (type === "rec" && tab !== "market") return postHtml(x);
    if ((type === "review" && tab !== "market") || type === "post") return postHtml(x);
    if (type === "playlist") return mplaylistHtml(x);
    if (type === "movie" || type === "series") return tmdbHtml(x);
    if (type === "free") return freeChannelHtml(x);
    if (type === "site") return siteListHtml(x);
    if (type === "member") return memberChannelHtml(x);
    if (type === "list" && tab === "channels") return memberListHtml(x);
    if (type === "profile") return profileHtml(x);
    if (tab === "market") return marketHtml(type, x);
    if (type === "group") return prizeGroupHtml(x);
    if (type === "prize" || type === "challenge" || type === "lottery") return prizeHtml(x);
    return "";
  }

  function wrapHtml(type, items) {
    const layout = LAYOUT[type] || "grid";
    const cls = state.tab === "market" && MARKET_LIST[type] ? "sr-mlist" : layout === "list" ? "sr-list" : layout === "rows" ? "ipl-chs sr-rows" : layout === "posters" ? "vs-posters" : state.tab === "videos" && type === "video" ? "vgrid" : state.tab === "channels" ? "ipl-grid sr-grid" : state.tab === "market" ? "mkt-grid sr-grid" : "sr-grid";
    return `<div class="${cls}" data-sr-list="${esc(type)}">${items.map((x) => cardHtml(type, x)).join("")}</div>`;
  }

  // ---------------------------------------------------------------- controls
  function drawTabs() {
    $("#vs-kind").innerHTML = TABS.map((k) => {
      const on = state.tab === k;
      return `<button type="button" role="tab" class="follow-tab sr-tab${on ? " active" : ""}" data-kind="${k}" aria-selected="${on}">${ICON[k]}<span>${esc(tabLabel(k))}</span></button>`;
    }).join("");
    const ph = t(`srch.ph.${state.tab}`);
    $("#vs-q").placeholder = ph;
    $("#vs-q").setAttribute("aria-label", ph);
  }

  function drawTypes() {
    const box = $("#vs-types");
    if (!box) return;
    const all = state.type === "";
    const chip = (k, label, n) => {
      const on = state.type === k;
      const count = n != null ? `<span class="follow-count">${esc(fmtCount(n))}</span>` : "";
      return `<button type="button" class="sr-type${on ? " active" : ""}" data-type="${esc(k)}" aria-pressed="${on}">${esc(label)}${count}</button>`;
    };
    const total = TYPES[state.tab].reduce((a, k) => a + (Number(state.counts[k]) || 0), 0);
    box.innerHTML = chip("", t("srch.all"), all && Object.keys(state.counts).length ? total : null) + TYPES[state.tab].map((k) => chip(k, typeLabel(k), state.counts[k] != null ? state.counts[k] : null)).join("");
  }

  function drawFilters() {
    const sel = (id, label, opts, value) => `
      <label class="vs-filter" for="${id}">
        <span>${esc(label)}</span>
        <select id="${id}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
      </label>`;
    const localKind = LOCAL[state.type] || (state.type === "" && (state.tab === "movies" || state.tab === "series"));
    const sortOpts = SORTS.map((k) => [k, t(`srch.sort.${k}`)]);
    const whenOpts = WHEN.map((k) => [k, whenLabel(k)]);
    const parts = [sel("vs-when", t("srch.added"), whenOpts, state.when), sel("vs-sort", t("vid.sortBy"), sortOpts, state.sort)];
    if (state.tab === "videos") {
      parts.push(sel("vs-lang", t("vid.f.lang"), [["", t("vid.all")], ...V.LANGUAGES.map((l) => [l, V.langLabel(l)])], state.lang));
      parts.push(sel("vs-region", t("vid.region"), [["", t("vid.all")], ...C.countryChoices()], state.region));
      parts.push(sel("vs-age", t("vid.f.age"), [["", t("vid.all")], ...V.AGES.map((a) => [a, V.ageLabel(a)])], state.age));
    }
    if (state.tab === "movies" || state.tab === "series") {
      parts.push(sel("vs-lang", t("srch.origLang"), [["", t("vid.all")], ...V.LANGUAGES.map((l) => [l, V.langLabel(l)])], state.lang));
    }
    if (state.tab === "channels") {
      parts.push(sel("vs-ckind", t("chan.f.type"), [["", t("chan.f.all")], ["live", t("chan.f.live")], ["movie", t("chan.f.movie")], ["series", t("chan.f.series")]], state.kind));
    }
    const chips = state.tab === "videos" ? [
      state.tag ? `<span class="vs-chip"><bdi>#${esc(state.tag)}</bdi><button type="button" data-clear="tag" aria-label="${esc(t("vid.clear"))}">×</button></span>` : "",
      state.owner ? `<span class="vs-chip"><bdi>@${esc(state.owner)}</bdi><button type="button" data-clear="owner" aria-label="${esc(t("vid.clear"))}">×</button></span>` : "",
    ].join("") : "";
    const dirty = state.when || state.sort !== "rank" || state.lang || state.region || state.age || state.tag || state.owner || state.kind;
    $("#vs-filters").innerHTML = `
      ${parts.join("")}
      ${chips ? `<div class="vs-active">${chips}</div>` : ""}
      ${dirty ? `<button class="btn btn-sm btn-ghost vs-reset" type="button" data-reset>${esc(t("vid.resetFilters"))}</button>` : ""}
      <details class="sr-how">
        <summary>${ICON.info}<span>${esc(t("srch.howTitle"))}</span></summary>
        <div class="sr-how-body">${howHtml(localKind)}</div>
      </details>`;
  }

  // "How results are ranked": the criteria of the tab
  function howHtml() {
    const lines = [];
    if (state.tab === "movies" || state.tab === "series") lines.push(t("srch.how.tmdb"));
    if (["videos", "movies", "series", "channels", "profiles"].includes(state.tab)) {
      lines.push(t("srch.how.formula"));
      lines.push(`<ul class="sr-how-list">${["minutes", "reports", "recs", "unrecs", "comments", "shares"].map((k) => `<li>${esc(t(`srch.how.${k}`))}</li>`).join("")}</ul>`);
    }
    if (state.tab === "profiles") lines.push(t("srch.how.profiles"));
    if (state.tab === "market") lines.push(t("srch.how.market"));
    if (state.tab === "prizes") lines.push(t("srch.how.prizes"));
    lines.push(t("srch.how.added"));
    return lines.map((l) => (l.startsWith("<ul") ? l : `<p>${esc(l)}</p>`)).join("");
  }

  function wireControls() {
    $("#vs-q").value = state.q;
    $("#vs-form").addEventListener("submit", (e) => {
      e.preventDefault();
      state.q = $("#vs-q").value.trim();
      run();
    });
    $("#vs-kind").addEventListener("click", (e) => {
      const b = e.target.closest("[data-kind]");
      if (!b || b.dataset.kind === state.tab) return;
      state.tab = b.dataset.kind;
      state.type = "";
      state.counts = {};
      if (state.tab !== "videos") Object.assign(state, { region: "", age: "", tag: "", owner: "" });
      if (!["videos", "movies", "series"].includes(state.tab)) state.lang = "";
      if (state.tab !== "channels") state.kind = "";
      run();
    });
    $("#vs-types").addEventListener("click", (e) => {
      const b = e.target.closest("[data-type]");
      if (!b || b.dataset.type === state.type) return;
      state.type = b.dataset.type;
      run({ keepCounts: true });
    });
    $("#vs-filters").addEventListener("change", (e) => {
      const id = e.target.id;
      if (id === "vs-when") state.when = e.target.value;
      if (id === "vs-sort") state.sort = e.target.value;
      if (id === "vs-lang") state.lang = e.target.value;
      if (id === "vs-region") state.region = e.target.value;
      if (id === "vs-age") state.age = e.target.value;
      if (id === "vs-ckind") state.kind = e.target.value;
      if (!id) return;
      run();
    });
    $("#vs-filters").addEventListener("click", (e) => {
      const clear = e.target.closest("[data-clear]");
      if (clear) {
        state[clear.dataset.clear] = "";
        run();
        return;
      }
      if (e.target.closest("[data-reset]")) {
        Object.assign(state, { when: "", sort: "rank", lang: "", region: "", age: "", tag: "", owner: "", kind: "" });
        run();
      }
    });
    $("#vs-results").addEventListener("click", (e) => {
      if (e.target.closest("[data-reset]")) {
        state.when = "";
        run();
        return;
      }
      if (e.target.closest("[data-more]")) {
        loadType(true);
        return;
      }
      const all = e.target.closest("[data-see]");
      if (all) {
        state.type = all.dataset.see;
        run({ keepCounts: true });
        window.scrollTo({ top: $("#vs-types").getBoundingClientRect().top + window.scrollY - 90, behavior: "smooth" });
      }
    });
    // only one ranking detail open at a time
    document.addEventListener("toggle", (e) => {
      const d = e.target;
      if (!(d instanceof HTMLDetailsElement) || !d.classList.contains("sr-rank") || !d.open) return;
      document.querySelectorAll("details.sr-rank[open]").forEach((x) => { if (x !== d) x.open = false; });
    }, true);
    document.addEventListener("click", (e) => {
      if (e.target.closest("details.sr-rank")) return;
      document.querySelectorAll("details.sr-rank[open]").forEach((x) => { x.open = false; });
    });
    L()?.wireJoin?.(document.getElementById("vs-results"), () => {});
  }

  // ---------------------------------------------------------------- the server
  async function server(type, limit, offset) {
    const opts = { tz: tz() };
    if (state.tab === "videos") Object.assign(opts, { lang: state.lang, region: state.region, age: state.age, tag: state.tag, owner: state.owner });
    if (state.tab === "channels" && state.kind) opts.kind = state.kind;
    return V.call("site_search", {
      p_member: me(),
      p_tab: state.tab,
      p_type: type,
      p_q: state.q,
      p_when: state.when,
      p_sort: state.sort,
      p_limit: limit,
      p_offset: offset,
      p_opts: opts,
    });
  }

  // ---------------------------------------------------------------- TMDB
  function weighted(x) {
    const v = Number(x.vote_count) || 0;
    const r = Number(x.vote_average) || 0;
    const m = 200; // votes before a rating counts fully
    return (v / (v + m)) * r + (m / (v + m)) * 6.2;
  }
  function tmdbPath(media, page) {
    const [a, b] = period(state.when);
    if (state.q) return `/search/${media}?query=${encodeURIComponent(state.q)}&page=${page}&include_adult=false`;
    if (!state.when) return `/trending/${media}/week?page=${page}`;
    if (state.when === "today") return `/trending/${media}/day?page=${page}`;
    const field = media === "tv" ? "first_air_date" : "primary_release_date";
    const end = b ? new Date(b.getTime() - 86400000) : new Date();
    return `/discover/${media}?sort_by=popularity.desc&include_adult=false&${field}.gte=${ymd(a)}&${field}.lte=${ymd(end)}&page=${page}`;
  }
  function tmdbKeep(x) {
    if (state.q && state.when && !inPeriod(x.release_date || x.first_air_date, state.when)) return false;
    if (!state.lang) return true;
    const iso = V.LANG_ISO[state.lang];
    if (state.lang === "Other") return !Object.values(V.LANG_ISO).includes(x.original_language);
    return x.original_language === iso;
  }
  function tmdbSorted(list) {
    const title = (x) => String(x.title || x.name || "").toLocaleLowerCase(C.getLocale());
    const date = (x) => Date.parse(x.release_date || x.first_air_date || "") || 0;
    const copy = list.slice();
    if (state.sort === "new") copy.sort((a, b) => date(b) - date(a));
    else if (state.sort === "old") copy.sort((a, b) => date(a) - date(b));
    else if (state.sort === "az") copy.sort((a, b) => title(a).localeCompare(title(b), C.getLocale()));
    else if (state.sort === "za") copy.sort((a, b) => title(b).localeCompare(title(a), C.getLocale()));
    else copy.sort((a, b) => weighted(b) - weighted(a) || (b.popularity || 0) - (a.popularity || 0));
    return copy;
  }
  async function tmdbLoad(more) {
    const media = state.tab === "series" ? "tv" : "movie";
    const T = state.tmdb;
    if (!more) Object.assign(T, { list: [], page: 0, pages: 1, total: 0 });
    const page = T.page + 1;
    const data = await C.tmdb(tmdbPath(media, page));
    T.page = page;
    T.pages = Math.min(Number(data?.total_pages || 1), 500);
    T.total = Number(data?.total_results || 0);
    const seen = new Set(T.list.map((x) => x.id));
    (Array.isArray(data?.results) ? data.results : []).forEach((x) => {
      if (seen.has(x.id)) return;
      x.media_type = media;
      x.rank = { tmdb: Number(x.vote_average) || 0, votes: Number(x.vote_count) || 0 };
      T.list.push(x);
    });
    return tmdbSorted(T.list.filter(tmdbKeep));
  }

  // ---------------------------------------------------------------- CineAura's lists (read here)
  function m3uRows(key) {
    const def = C.IPTV_LISTS?.[key];
    if (!def || !L()) return Promise.resolve([]);
    if (!state.m3u[key]) {
      state.m3u[key] = C.fetchPlaylistText(def.url)
        .then((text) => (/#EXTINF/i.test(text) ? L().parse(text) : []))
        .catch(() => []);
    }
    return state.m3u[key];
  }
  const ckey = (name) => String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
  function matches(row) {
    const words = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = `${row.channel_name} ${row.group_name || ""}`.toLowerCase();
    return words.every((w) => hay.includes(w)) && (!state.kind || row.channel_type === state.kind);
  }
  // one per channel name and type, in the order of the playlist
  function uniq(rows) {
    const seen = new Set();
    return rows.filter((r) => {
      const k = `${ckey(r.channel_name)}|${r.channel_type}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  // the numbers of channels by name, asked once each: a second section that needs them (All shows the free
  // channels and CineAura's lists at once) waits for the same answer instead of reading zeros
  async function loadRanks(names) {
    const keys = [...new Set(names.map(ckey))].filter(Boolean);
    const want = keys.filter((k) => !state.ranks.has(k) && !state.rankWait.has(k)).slice(0, 3000);
    if (want.length) {
      const job = V.call("channel_ranks", { p_names: want })
        .then((res) => {
          want.forEach((k) => state.ranks.set(k, { minutes: 0, reports: 0 }));
          if (res.ok && res.data && typeof res.data === "object") {
            Object.entries(res.data).forEach(([k, v]) => state.ranks.set(k, { minutes: Number(v.minutes) || 0, reports: Number(v.reports) || 0 }));
          }
        })
        .catch(() => want.forEach((k) => state.ranks.set(k, { minutes: 0, reports: 0 })))
        .finally(() => want.forEach((k) => state.rankWait.delete(k)));
      want.forEach((k) => state.rankWait.set(k, job));
    }
    await Promise.all([...new Set(keys.map((k) => state.rankWait.get(k)).filter(Boolean))]);
  }
  const chRank = (name) => {
    const r = state.ranks.get(ckey(name)) || { minutes: 0, reports: 0 };
    return { points: 60 * r.minutes - 60 * r.reports, minutes: r.minutes, reports: r.reports };
  };
  function sortLocal(list, titleOf, atOf) {
    const copy = list.slice();
    const title = (x) => String(titleOf(x) || "").toLocaleLowerCase(C.getLocale());
    if (state.sort === "az") copy.sort((a, b) => title(a).localeCompare(title(b), C.getLocale()));
    else if (state.sort === "za") copy.sort((a, b) => title(b).localeCompare(title(a), C.getLocale()));
    else if (state.sort === "new") copy.sort((a, b) => (Date.parse(atOf(b) || 0) || 0) - (Date.parse(atOf(a) || 0) || 0));
    else if (state.sort === "old") copy.sort((a, b) => (Date.parse(atOf(a) || 0) || 0) - (Date.parse(atOf(b) || 0) || 0));
    else copy.sort((a, b) => (Number(b.rank?.points) || 0) - (Number(a.rank?.points) || 0));
    return copy;
  }

  // Free channels: the free list of CineAura (else the free packages, from the server), one per name
  async function freeChannels() {
    const got = [];
    let off = 0;
    for (let i = 0; i < 10; i += 1) {
      const res = await server("free", 60, off);
      if (!res.ok || res.data?.ok === false) break;
      const items = res.data?.items || [];
      got.push(...items);
      off += items.length;
      if (items.length < 60) break;
    }
    // the list everybody watches on Listchannels.html?free=1 (no date: it shows for "all time" only)
    const rows = state.when ? [] : uniq(await m3uRows("free"));
    const hits = rows.filter(matches);
    const known = new Set(got.map((x) => `${ckey(x.name)}|${x.kind}`));
    const fromList = hits.filter((r) => !known.has(`${ckey(r.channel_name)}|${r.channel_type}`)).slice(0, 2000);
    await loadRanks(fromList.map((r) => r.channel_name));
    const extra = fromList.map((r) => ({
      id: r.id, name: r.channel_name, group: r.group_name, logo: r.logo_url, kind: r.channel_type, m3u: true, rank: chRank(r.channel_name),
    }));
    return sortLocal(got.concat(extra), (x) => x.name, (x) => x.at);
  }

  // CineAura's lists: the free and the premium list, then the packages (server)
  async function siteLists() {
    const res = await server("site", 60, 0);
    const packs = res.ok && res.data?.ok !== false ? res.data.items || [] : [];
    if (state.when) return packs; // the two lists of the home page have no date
    const out = [];
    for (const [key, premium] of [["free", false], ["premium", true]]) {
      const rows = await m3uRows(key);
      if (!rows.length) continue;
      const hits = state.q ? uniq(rows.filter(matches)) : [];
      if (state.q && !hits.length && !t(premium ? "home.iptv.premium" : "home.iptv.free").toLowerCase().includes(state.q.toLowerCase())) continue;
      const n = { live: 0, movie: 0, series: 0 };
      rows.forEach((r) => { n[r.channel_type] = (n[r.channel_type] || 0) + 1; });
      await loadRanks(rows.slice(0, 3000).map((r) => r.channel_name));
      const mins = uniq(rows).reduce((a, r) => a + (state.ranks.get(ckey(r.channel_name))?.minutes || 0), 0);
      const reps = uniq(rows).reduce((a, r) => a + (state.ranks.get(ckey(r.channel_name))?.reports || 0), 0);
      out.push({
        id: key, type: "site", premium, title: t(premium ? "home.iptv.premium" : "home.iptv.free"),
        href: premium ? "./Listchannels.html?premium=1" : "./Listchannels.html?free=1",
        channels: rows.length, live: n.live, movies: n.movie, series: n.series,
        hits: hits.slice(0, 6).map((r) => ({ id: r.id, name: r.channel_name })), hitCount: hits.length,
        rank: { points: 60 * mins - 60 * reps, minutes: mins, reports: reps },
      });
    }
    return out.concat(packs);
  }

  // ---------------------------------------------------------------- loading
  function headHtml(title, count) {
    return `<div class="vs-results-head"><h2>${esc(title)}</h2>${count != null ? `<span class="muted">${esc(t("srch.countN", { n: fmt(count) }))}</span>` : ""}</div>`;
  }
  const resultsTitle = () => (state.q ? t("vid.resultsFor", { q: state.q }) : t("srch.latest"));

  function noneHtml(textKey = "srch.noneText") {
    return `<div class="vs-none glass"><h2>${esc(t("vid.noResults"))}</h2><p class="muted">${esc(t(textKey))}</p>${state.when ? `<button class="btn btn-sm btn-ghost" type="button" data-reset>${esc(t("srch.anyTime"))}</button>` : ""}</div>`;
  }

  async function loadAll() {
    const seq = ++state.seq;
    const box = $("#vs-results");
    box.innerHTML = `<p class="muted">${esc(t("common.loading"))}</p>`;
    const types = TYPES[state.tab];
    const serverTypes = types.filter((k) => !LOCAL[k]);
    const [res, local, free, site] = await Promise.all([
      server("", SECTION, 0),
      types.some((k) => LOCAL[k]) ? tmdbLoad(false).catch(() => null) : Promise.resolve(null),
      state.tab === "channels" ? freeChannels().catch(() => []) : Promise.resolve(null),
      state.tab === "channels" ? siteLists().catch(() => []) : Promise.resolve(null),
    ]);
    if (seq !== state.seq) return;
    if (!res.ok || res.data?.ok === false) {
      box.innerHTML = `<p class="empty">${esc(t(res.setup ? "srch.setup" : "vid.loadFail"))}</p>`;
      return;
    }
    const byType = new Map((res.data.sections || []).map((s) => [s.type, s]));
    const sections = [];
    types.forEach((k) => {
      let items = [];
      let total = 0;
      if (LOCAL[k]) {
        items = (local || []).slice(0, SECTION * 2);
        total = local ? Math.max(state.tmdb.total, (local || []).length) : 0;
      } else if (k === "free" && free) {
        items = free.slice(0, SECTION);
        total = free.length;
      } else if (k === "site" && site) {
        items = site.slice(0, SECTION);
        total = site.length;
      } else if (serverTypes.includes(k)) {
        const s = byType.get(k) || { items: [], total: 0 };
        items = s.items || [];
        total = Number(s.total) || 0;
      }
      state.counts[k] = total;
      sections.push({ type: k, items, total });
    });
    state.sections = sections;
    drawTypes();
    const filled = sections.filter((s) => s.items.length);
    if (!filled.length) {
      box.innerHTML = noneHtml();
      return;
    }
    box.innerHTML = `
      ${headHtml(resultsTitle(), null)}
      ${filled.map((s) => `
        <section class="sr-section" data-section="${esc(s.type)}">
          <header class="sr-section-head">
            <h3>${esc(typeLabel(s.type))} <span class="follow-count">${esc(fmtCount(s.total))}</span></h3>
            ${s.total > s.items.length || LOCAL[s.type] ? `<button class="btn btn-sm btn-ghost" type="button" data-see="${esc(s.type)}">${esc(t("srch.seeAll"))}</button>` : ""}
          </header>
          ${wrapHtml(s.type, s.items)}
        </section>`).join("")}`;
    afterDraw(box);
  }

  async function loadType(more = false) {
    const seq = ++state.seq;
    const box = $("#vs-results");
    const k = state.type;
    if (!more) {
      state.items = [];
      state.total = 0;
      state.local = null;
      box.innerHTML = `<p class="muted">${esc(t("common.loading"))}</p>`;
    } else {
      box.querySelector("[data-more]")?.setAttribute("disabled", "");
    }
    let hasMore = false;
    if (LOCAL[k]) {
      let list;
      try {
        list = await tmdbLoad(more);
      } catch {
        if (seq === state.seq) box.innerHTML = `<p class="empty">${esc(t("vid.tmdbFail"))}</p>`;
        return;
      }
      if (seq !== state.seq) return;
      state.items = list;
      state.total = Math.max(state.tmdb.total, list.length);
      hasMore = state.tmdb.page < state.tmdb.pages;
    } else if (k === "free" || k === "site") {
      if (!state.local) {
        const all = await (k === "free" ? freeChannels() : siteLists()).catch(() => []);
        if (seq !== state.seq) return;
        state.local = { all };
      }
      state.items = state.local.all.slice(0, (more ? state.items.length : 0) + PAGE);
      state.total = state.local.all.length;
      hasMore = state.items.length < state.total;
    } else {
      const res = await server(k, PAGE, more ? state.items.length : 0);
      if (seq !== state.seq) return;
      if (!res.ok || res.data?.ok === false) {
        box.innerHTML = `<p class="empty">${esc(t(res.setup ? "srch.setup" : "vid.loadFail"))}</p>`;
        return;
      }
      const items = Array.isArray(res.data.items) ? res.data.items : [];
      state.items = more ? state.items.concat(items) : items;
      state.total = Number(res.data.total || 0);
      hasMore = state.items.length < state.total;
    }
    state.counts[k] = state.total;
    drawTypes();
    if (!state.items.length) {
      box.innerHTML = noneHtml(k === "free" && state.when ? "srch.noneFreeWhen" : "srch.noneText");
      return;
    }
    box.innerHTML = `
      ${headHtml(`${typeLabel(k)} — ${resultsTitle()}`, LOCAL[k] ? null : state.total)}
      ${LOCAL[k] ? `<p class="muted sr-tmdb-note">${esc(t(state.q ? "srch.tmdbSearch" : state.when ? "srch.tmdbWhen" : "srch.tmdbTrending"))}</p>` : ""}
      ${wrapHtml(k, state.items)}
      ${hasMore ? `<div class="vs-more"><button class="btn btn-lg btn-ghost" type="button" data-more>${esc(t("vid.loadMore"))}</button></div>` : ""}`;
    afterDraw(box);
  }

  function afterDraw(box) {
    V.observeCards(box);
    const MK = M();
    if (MK && state.tab === "market") {
      const all = () => (state.type ? state.items : state.sections.flatMap((s) => s.items));
      MK.wireItems(box, { items: all, changed: () => run({ keepCounts: true }) });
    }
  }

  function run({ keepCounts = false } = {}) {
    if (!keepCounts) state.counts = {};
    syncUrl();
    drawTabs();
    drawTypes();
    drawFilters();
    if (state.type) loadType(false);
    else loadAll();
  }

  function boot() {
    C.setupChrome();
    wireControls();
    run();
    // the language pack arrived after the first drawing (a first visit in that language)
    document.addEventListener("cineaura:lang", () => run({ keepCounts: true }));
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
