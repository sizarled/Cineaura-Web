/* CineAura — Search.html: member videos (sql/content.sql) and TMDB movies & series.

   Videos: public and exclusive ones (an exclusive video the visitor cannot watch
   carries a lock), and the private ones whose publisher listed the member. Sort by
   relevance, views, recommendations, date, A→Z or Z→A; filter by language, region
   (the publisher's country) and age rating; ?tag= and ?owner= narrow to a tag or a
   publisher. The address keeps every choice: ?q=&sort=&lang=&region=&age=&tag=&owner=&tab=.

   Movies & series: TMDB search (trending without a query), with the same sort and
   the language filter (original language).

   Channels (?tab=channels): the channels of the IPTV lists that members publish
   (sql/iptv_lists.sql, iptv_channel_search): the public lists, and the exclusive lists
   whose criteria the member meets (followers, country, language) — never a private
   list. Filter by type (channels / movies / series, ?type=), sort by relevance, A→Z,
   Z→A or the most viewed lists (?csort=). A result opens the channel in its list.
*/
(() => {
  "use strict";
  const C = window.CineAura;
  const V = window.CineAuraVideos;
  const { t, escapeHtml: esc } = C;

  const SORTS = ["relevance", "views", "recs", "date", "az", "za"];
  const PAGE = 24;
  const params = new URLSearchParams(location.search);
  const state = {
    q: (params.get("q") || "").trim(),
    sort: SORTS.includes(params.get("sort")) ? params.get("sort") : "",
    lang: params.get("lang") || "",
    region: (params.get("region") || "").toUpperCase(),
    age: [3, 6, 13, 16, 18].includes(Number(params.get("age"))) ? Number(params.get("age")) : "",
    tag: (params.get("tag") || "").replace(/^#+/, "").trim().toLowerCase(),
    owner: (params.get("owner") || "").replace(/^@+/, "").trim(),
    tab: ["tmdb", "channels"].includes(params.get("tab")) ? params.get("tab") : "videos",
    ctype: ["live", "movie", "series"].includes(params.get("type")) ? params.get("type") : "",
    csort: ["az", "za", "lists"].includes(params.get("csort")) ? params.get("csort") : "",
    channels: [],
    chTotal: 0,
    items: [],
    total: 0,
    tmdb: [],
    tmdbPage: 0,
    tmdbPages: 1,
    seq: 0,
  };
  const $ = (sel) => document.querySelector(sel);

  function effectiveSort() {
    return state.sort || (state.q ? "relevance" : "date");
  }

  function syncUrl() {
    const q = new URLSearchParams();
    if (state.q) q.set("q", state.q);
    if (state.sort) q.set("sort", state.sort);
    if (state.lang) q.set("lang", state.lang);
    if (state.region) q.set("region", state.region);
    if (state.age) q.set("age", String(state.age));
    if (state.tag) q.set("tag", state.tag);
    if (state.owner) q.set("owner", state.owner);
    if (state.tab !== "videos") q.set("tab", state.tab);
    if (state.tab === "channels" && state.ctype) q.set("type", state.ctype);
    if (state.tab === "channels" && state.csort) q.set("csort", state.csort);
    const s = q.toString();
    history.replaceState(history.state, "", `${location.pathname}${s ? `?${s}` : ""}`);
  }

  // ---------------------------------------------------------------- controls
  function drawKind() {
    // the box says what it searches
    const ph = t(state.tab === "channels" ? "vid.searchPhChannels" : "vid.searchPh");
    $("#vs-q").placeholder = ph;
    $("#vs-q").setAttribute("aria-label", ph);
    $("#vs-kind").innerHTML = ["videos", "tmdb", "channels"]
      .map((k) => {
        const on = state.tab === k;
        const n = k === "videos" ? state.total : k === "channels" && on ? state.chTotal : 0;
        const count = n ? ` <span class="follow-count">${esc(V.fmtCount(n))}</span>` : "";
        return `<button type="button" role="tab" class="follow-tab${on ? " active" : ""}" data-kind="${k}" aria-selected="${on}">${esc(t(`vid.kind.${k}`))}${count}</button>`;
      })
      .join("");
  }

  function drawFilters() {
    if (state.tab === "channels") return drawChannelFilters();
    const sel = (id, label, opts, value) => `
      <label class="vs-filter" for="${id}">
        <span>${esc(label)}</span>
        <select id="${id}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
      </label>`;
    const sortOpts = SORTS.map((k) => [k, t(state.tab === "tmdb" ? `vid.sortTmdb.${k}` : `vid.sort.${k}`)]);
    const langOpts = [["", t("vid.all")], ...V.LANGUAGES.map((l) => [l, V.langLabel(l)])];
    const regionOpts = [["", t("vid.all")], ...C.countryChoices()];
    const ageOpts = [["", t("vid.all")], ...V.AGES.map((a) => [a, V.ageLabel(a)])];
    const chips = [
      state.tag ? `<span class="vs-chip"><bdi>#${esc(state.tag)}</bdi><button type="button" data-clear="tag" aria-label="${esc(t("vid.clear"))}">×</button></span>` : "",
      state.owner ? `<span class="vs-chip"><bdi>@${esc(state.owner)}</bdi><button type="button" data-clear="owner" aria-label="${esc(t("vid.clear"))}">×</button></span>` : "",
    ].join("");
    $("#vs-filters").innerHTML = `
      ${sel("vs-sort", t("vid.sortBy"), sortOpts, effectiveSort())}
      ${sel("vs-lang", t("vid.f.lang"), langOpts, state.lang)}
      ${state.tab === "videos" ? sel("vs-region", t("vid.region"), regionOpts, state.region) : ""}
      ${state.tab === "videos" ? sel("vs-age", t("vid.f.age"), ageOpts, state.age) : ""}
      ${chips && state.tab === "videos" ? `<div class="vs-active">${chips}</div>` : ""}
      ${state.tab === "tmdb" ? `<p class="vs-note muted">${esc(t("vid.tmdbNote"))}</p>` : ""}
      ${state.lang || state.region || state.age || state.sort || state.tag || state.owner ? `<button class="btn btn-sm btn-ghost vs-reset" type="button" data-reset>${esc(t("vid.resetFilters"))}</button>` : ""}`;
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
      run();
    });
    $("#vs-filters").addEventListener("change", (e) => {
      const id = e.target.id;
      if (id === "vs-sort") state.sort = e.target.value === (state.q ? "relevance" : "date") ? "" : e.target.value;
      if (id === "vs-lang") state.lang = e.target.value;
      if (id === "vs-region") state.region = e.target.value;
      if (id === "vs-age") state.age = e.target.value ? Number(e.target.value) : "";
      if (id === "vs-csort") state.csort = e.target.value === "relevance" ? "" : e.target.value;
      if (id === "vs-ctype") state.ctype = e.target.value;
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
        if (state.tab === "channels") Object.assign(state, { ctype: "", csort: "" });
        else Object.assign(state, { sort: "", lang: "", region: "", age: "", tag: "", owner: "" });
        run();
      }
    });
    $("#vs-results").addEventListener("click", (e) => {
      if (e.target.closest("[data-more]")) {
        if (state.tab === "videos") loadVideos(true);
        else if (state.tab === "channels") loadChannels(true);
        else loadTmdb(true);
      }
    });
  }

  // ---------------------------------------------------------------- videos
  function heading() {
    if (state.q) return t("vid.resultsFor", { q: state.q });
    if (state.tag) return t("vid.taggedWith", { tag: state.tag });
    if (state.owner) return t("vid.videosOf", { name: state.owner });
    return t("vid.latest");
  }

  async function loadVideos(more = false) {
    const seq = ++state.seq;
    const box = $("#vs-results");
    if (!more) {
      state.items = [];
      box.innerHTML = `<p class="muted">${esc(t("common.loading"))}</p>`;
    } else {
      box.querySelector("[data-more]")?.setAttribute("disabled", "");
    }
    const res = await V.call("content_search", {
      p_member: V.memberId(),
      p_q: state.q,
      p_sort: effectiveSort(),
      p_lang: state.lang,
      p_country: state.region,
      p_age: state.age === "" ? null : state.age,
      p_owner: state.owner,
      p_tag: state.tag,
      p_limit: PAGE,
      p_offset: more ? state.items.length : 0,
    });
    if (seq !== state.seq) return;
    if (!res.ok) {
      box.innerHTML = `<p class="empty">${esc(t(res.setup ? "vid.setup" : "vid.loadFail"))}</p>`;
      return;
    }
    const items = Array.isArray(res.data?.items) ? res.data.items : [];
    state.total = Number(res.data?.total || 0);
    state.items = more ? state.items.concat(items) : items;
    drawKind();
    if (!state.items.length) {
      box.innerHTML = `<div class="vs-none glass">
        <h2>${esc(t("vid.noResults"))}</h2>
        <p class="muted">${esc(t("vid.noResultsText"))}</p>
        ${state.q ? `<button class="btn btn-sm btn-ghost" type="button" data-kind-switch>${esc(t("vid.tryTmdb", { q: state.q }))}</button>` : ""}
      </div>`;
      box.querySelector("[data-kind-switch]")?.addEventListener("click", () => {
        state.tab = "tmdb";
        run();
      });
      return;
    }
    box.innerHTML = `
      <div class="vs-results-head"><h2>${esc(heading())}</h2><span class="muted">${esc(t("vid.countN", { n: V.fmtNum(state.total) }))}</span></div>
      <div class="vgrid">${state.items.map((x) => V.cardHtml(x)).join("")}</div>
      ${state.items.length < state.total ? `<div class="vs-more"><button class="btn btn-lg btn-ghost" type="button" data-more>${esc(t("vid.loadMore"))}</button></div>` : ""}`;
    V.observeCards(box);
  }

  // ---------------------------------------------------------------- TMDB
  function tmdbSorted(list) {
    const key = effectiveSort();
    const title = (x) => String(x.title || x.name || "").toLocaleLowerCase(C.getLocale());
    const date = (x) => Date.parse(x.release_date || x.first_air_date || "") || 0;
    const copy = list.slice();
    if (key === "views") copy.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    else if (key === "recs") copy.sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0) || (b.vote_count || 0) - (a.vote_count || 0));
    else if (key === "date") copy.sort((a, b) => date(b) - date(a));
    else if (key === "az") copy.sort((a, b) => title(a).localeCompare(title(b), C.getLocale()));
    else if (key === "za") copy.sort((a, b) => title(b).localeCompare(title(a), C.getLocale()));
    return copy;
  }

  function tmdbFiltered(list) {
    const iso = V.LANG_ISO[state.lang];
    return list.filter((x) => {
      if (x.media_type && !["movie", "tv"].includes(x.media_type)) return false;
      if (!state.lang) return true;
      if (state.lang === "Other") return !Object.values(V.LANG_ISO).includes(x.original_language);
      return x.original_language === iso;
    });
  }

  async function loadTmdb(more = false) {
    const seq = ++state.seq;
    const box = $("#vs-results");
    if (!more) {
      state.tmdb = [];
      state.tmdbPage = 0;
      box.innerHTML = `<p class="muted">${esc(t("common.loading"))}</p>`;
    }
    const page = state.tmdbPage + 1;
    let data;
    try {
      data = state.q
        ? await C.tmdb(`/search/multi?query=${encodeURIComponent(state.q)}&page=${page}&include_adult=false`)
        : await C.tmdb(`/trending/all/week?page=${page}`);
    } catch {
      if (seq === state.seq) box.innerHTML = `<p class="empty">${esc(t("vid.tmdbFail"))}</p>`;
      return;
    }
    if (seq !== state.seq) return;
    state.tmdbPage = page;
    state.tmdbPages = Number(data?.total_pages || 1);
    state.tmdb = state.tmdb.concat(Array.isArray(data?.results) ? data.results : []);
    const shown = tmdbSorted(tmdbFiltered(state.tmdb));
    drawKind();
    if (!shown.length && state.tmdbPage >= state.tmdbPages) {
      box.innerHTML = `<div class="vs-none glass"><h2>${esc(t("vid.noResults"))}</h2><p class="muted">${esc(t("vid.noResultsText"))}</p></div>`;
      return;
    }
    box.innerHTML = `
      <div class="vs-results-head"><h2>${esc(state.q ? t("vid.resultsFor", { q: state.q }) : t("vid.trending"))}</h2><span class="muted">TMDB</span></div>
      <div class="vs-posters">${shown.map((x) => C.posterCard(x, x.media_type === "tv" ? "tv" : "movie")).join("")}</div>
      ${state.tmdbPage < state.tmdbPages ? `<div class="vs-more"><button class="btn btn-lg btn-ghost" type="button" data-more>${esc(t("vid.loadMore"))}</button></div>` : ""}`;
  }

  // ---------------------------------------------------------------- channels of the members' IPTV lists
  function drawChannelFilters() {
    const sel = (id, label, opts, value) => `
      <label class="vs-filter" for="${id}">
        <span>${esc(label)}</span>
        <select id="${id}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
      </label>`;
    $("#vs-filters").innerHTML = `
      ${sel("vs-csort", t("vid.sortBy"), ["relevance", "az", "za", "lists"].map((k) => [k, t(`vid.csort.${k}`)]), state.csort || "relevance")}
      ${sel("vs-ctype", t("chan.f.type"), [["", t("chan.f.all")], ["live", t("chan.f.live")], ["movie", t("chan.f.movie")], ["series", t("chan.f.series")]], state.ctype)}
      <p class="vs-note muted">${esc(t("vid.channelsNote"))} <a href="./IPTV.html">${esc(t("vid.channelsLists"))}</a></p>
      ${state.ctype || state.csort ? `<button class="btn btn-sm btn-ghost vs-reset" type="button" data-reset>${esc(t("vid.resetFilters"))}</button>` : ""}`;
  }

  async function loadChannels(more = false) {
    const L = window.CineAuraIptvLists;
    const seq = ++state.seq;
    const box = $("#vs-results");
    if (!more) state.channels = [];
    if (state.q.length < 2) {
      state.chTotal = 0;
      drawKind();
      box.innerHTML = `<div class="ipl-tip glass">
        <h2>${esc(t("vid.channelsTipTitle"))}</h2>
        <p>${esc(t("vid.channelsTip"))}</p>
        <a class="btn btn-sm btn-ghost" href="./IPTV.html">${esc(t("vid.channelsLists"))}</a>
      </div>`;
      return;
    }
    if (!more) box.innerHTML = `<p class="muted">${esc(t("common.loading"))}</p>`;
    else box.querySelector("[data-more]")?.setAttribute("disabled", "");
    const res = L
      ? await L.call("iptv_channel_search", {
          p_member: V.memberId(),
          p_q: state.q,
          p_kind: state.ctype,
          p_sort: state.csort || "relevance",
          p_limit: 30,
          p_offset: more ? state.channels.length : 0,
        })
      : { ok: false, setup: true };
    if (seq !== state.seq) return;
    if (!res.ok) {
      box.innerHTML = `<p class="empty">${esc(t(res.setup ? "ipl.setupText" : "vid.loadFail"))}</p>`;
      return;
    }
    const items = Array.isArray(res.data?.items) ? res.data.items : [];
    state.chTotal = Number(res.data?.total || 0);
    state.channels = more ? state.channels.concat(items) : items;
    drawKind();
    if (!state.channels.length) {
      box.innerHTML = `<div class="vs-none glass">
        <h2>${esc(t("vid.noResults"))}</h2>
        <p class="muted">${esc(t("vid.channelsNone"))}</p>
        <a class="btn btn-sm btn-ghost" href="./IPTV.html">${esc(t("vid.channelsLists"))}</a>
      </div>`;
      return;
    }
    box.innerHTML = `
      <div class="vs-results-head"><h2>${esc(t("vid.resultsFor", { q: state.q }))}</h2><span class="muted">${esc(t(state.chTotal === 1 ? "vid.channelsOne" : "vid.channelsN", { n: V.fmtNum(state.chTotal) }))}</span></div>
      <div class="ipl-chs">${state.channels.map((x) => L.channelHtml(x)).join("")}</div>
      ${state.channels.length < state.chTotal ? `<div class="vs-more"><button class="btn btn-lg btn-ghost" type="button" data-more>${esc(t("vid.loadMore"))}</button></div>` : ""}`;
  }

  function run() {
    syncUrl();
    drawKind();
    drawFilters();
    if (state.tab === "tmdb") loadTmdb(false);
    else if (state.tab === "channels") loadChannels(false);
    else loadVideos(false);
  }

  function boot() {
    C.setupChrome();
    wireControls();
    run();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
