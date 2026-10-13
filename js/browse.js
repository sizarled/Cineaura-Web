/* CineAura browse pages: movies.html and series.html (the kind comes from <body data-kind>).

   - Browsing without a search uses TMDB's discover endpoint, so TMDB sorts, filters and pages
     the titles (20 per page).
   - A search by title reads the first 10 pages of TMDB's title search (200 titles at most).
   - A search by the exact name of an actor or director lists the titles that person worked on.
     Those lists are filtered, sorted and paged here.
   - Page, search, filters and sort live in the URL, so a link or a reload shows the same view. */
(() => {
  const C = window.CineAura;
  if (!C) return;
  const { $, t, tmdb, posterCard, personHref, escapeHtml, imgUrl, initialsAvatar, setupChrome, getLang, getLocale } = C;

  const KIND = document.body?.dataset?.kind === "tv" ? "tv" : "movie";
  const PER_PAGE = 20;
  const SEARCH_PAGES = 10;
  const MAX_PAGES = 500; // TMDB stops paging at 500
  const VOTES_MIN = 100; // rating sorts and rating filters skip titles with fewer votes
  const YEAR_FIRST = 1900;
  const RATINGS = [5, 6, 7, 8, 9];
  const YEAR_PARAM = KIND === "tv" ? "first_air_date_year" : "primary_release_year";
  // Sort key -> TMDB sort_by (used when browsing; search results are sorted here).
  const SORTS = {
    pop_desc: "popularity.desc",
    pop_asc: "popularity.asc",
    rating_desc: "vote_average.desc",
    rating_asc: "vote_average.asc",
    az: KIND === "tv" ? "original_name.asc" : "original_title.asc",
    za: KIND === "tv" ? "original_name.desc" : "original_title.desc",
    old: KIND === "tv" ? "first_air_date.asc" : "primary_release_date.asc",
    new: KIND === "tv" ? "first_air_date.desc" : "primary_release_date.desc",
  };

  const num = (v) => Number(v) || 0;
  const titleOf = (x) => String(x.title || x.name || x.original_title || x.original_name || "");
  const dateOf = (x) => {
    const d = Date.parse(x.release_date || x.first_air_date || "");
    return Number.isNaN(d) ? null : d;
  };
  const yearOf = (x) => Number(String(x.release_date || x.first_air_date || "").slice(0, 4)) || null;
  const norm = (s) =>
    String(s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  const usesVotes = () => Boolean(state.rating) || state.sort.startsWith("rating");

  // ---------- state: kept in the URL ----------
  function readUrl() {
    const sp = new URLSearchParams(location.search);
    const whole = (v, min, max) => {
      const n = Number.parseInt(v, 10);
      return Number.isFinite(n) && n >= min && n <= max ? n : 0;
    };
    const rating = whole(sp.get("rating"), 5, 9);
    const year = whole(sp.get("year"), YEAR_FIRST, new Date().getFullYear());
    const sort = sp.get("sort");
    return {
      q: (sp.get("q") || "").trim(),
      genre: /^\d+$/.test(sp.get("genre") || "") ? sp.get("genre") : "",
      rating: rating ? String(rating) : "",
      year: year ? String(year) : "",
      sort: Object.hasOwn(SORTS, sort) ? sort : "pop_desc",
      page: whole(sp.get("page"), 1, MAX_PAGES) || 1,
    };
  }
  const state = readUrl();

  function syncUrl() {
    const p = new URLSearchParams();
    if (state.q) p.set("q", state.q);
    if (state.genre) p.set("genre", state.genre);
    if (state.rating) p.set("rating", state.rating);
    if (state.year) p.set("year", state.year);
    if (state.sort !== "pop_desc") p.set("sort", state.sort);
    if (state.page > 1) p.set("page", String(state.page));
    const qs = p.toString();
    history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}`);
  }

  // ---------- TMDB requests (cached per language and per request) ----------
  const cache = new Map();
  function remember(key, load) {
    const k = `${getLang()}|${key}`;
    if (!cache.has(k)) {
      const p = Promise.resolve().then(load);
      cache.set(k, p);
      p.catch(() => cache.delete(k));
    }
    return cache.get(k);
  }

  function discoverPath(page) {
    const p = new URLSearchParams({ include_adult: "false", sort_by: SORTS[state.sort], page: String(page) });
    if (KIND === "movie") p.set("include_video", "false");
    if (state.genre) p.set("with_genres", state.genre);
    if (state.year) p.set(YEAR_PARAM, state.year);
    if (state.rating) p.set("vote_average.gte", state.rating);
    if (usesVotes()) p.set("vote_count.gte", String(VOTES_MIN));
    return `/discover/${KIND}?${p}`;
  }

  const titlePath = (q, page) => `/search/${KIND}?${new URLSearchParams({ query: q, include_adult: "false", page: String(page) })}`;

  async function titleEntry(q, first) {
    const pages = Math.min(num(first.total_pages), SEARCH_PAGES);
    const rest = await Promise.all(
      Array.from({ length: Math.max(0, pages - 1) }, (_, i) => tmdb(titlePath(q, i + 2)))
    );
    const seen = new Map();
    [first, ...rest].forEach((r) => (r.results || []).forEach((x) => x.id && !seen.has(x.id) && seen.set(x.id, x)));
    return { items: [...seen.values()], person: null };
  }

  async function personEntry(person) {
    const data = await remember(`credits:${KIND}:${person.id}`, () => tmdb(`/person/${person.id}/combined_credits`));
    const seen = new Map();
    [...(data.cast || []), ...(data.crew || [])].forEach((c) => {
      if (c.media_type === KIND && c.id && !seen.has(c.id)) seen.set(c.id, c);
    });
    return {
      items: [...seen.values()],
      person: { id: person.id, name: person.name, profile_path: person.profile_path || "" },
    };
  }

  // A name that matches a person exactly shows that person's titles; otherwise the title search
  // is used; a partial name is the last resort.
  async function findEntry(q) {
    const [people, first] = await Promise.all([
      tmdb(`/search/person?${new URLSearchParams({ query: q, include_adult: "false" })}`),
      tmdb(titlePath(q, 1)),
    ]);
    const list = people.results || [];
    const exact = list.find((p) => norm(p.name) === norm(q));
    if (exact) return personEntry(exact);
    if (num(first.total_results) > 0) return titleEntry(q, first);
    const partial = list.find((p) => norm(p.name).includes(norm(q)));
    return partial ? personEntry(partial) : { items: [], person: null };
  }

  // ---------- filtering and sorting of lists that are complete in the browser ----------
  function passes(x) {
    if (state.genre && !(x.genre_ids || []).includes(Number(state.genre))) return false;
    if (state.rating && num(x.vote_average) < Number(state.rating)) return false;
    if (usesVotes() && num(x.vote_count) < VOTES_MIN) return false;
    if (state.year && yearOf(x) !== Number(state.year)) return false;
    return true;
  }

  function compareFor(sort) {
    const coll = new Intl.Collator(getLocale(), { numeric: true, sensitivity: "base" });
    const byPop = (a, b) => num(b.popularity) - num(a.popularity) || num(a.id) - num(b.id);
    const byDate = (a, b) => {
      const da = dateOf(a);
      const db = dateOf(b);
      if (da === null && db === null) return 0;
      if (da === null) return 1; // undated titles go last whichever way the list is sorted
      if (db === null) return -1;
      return da - db;
    };
    switch (sort) {
      case "pop_asc":
        return (a, b) => num(a.popularity) - num(b.popularity) || num(a.id) - num(b.id);
      case "rating_desc":
        return (a, b) => num(b.vote_average) - num(a.vote_average) || num(b.vote_count) - num(a.vote_count) || byPop(a, b);
      case "rating_asc":
        return (a, b) => num(a.vote_average) - num(b.vote_average) || num(a.vote_count) - num(b.vote_count) || byPop(a, b);
      case "az":
        return (a, b) => coll.compare(titleOf(a), titleOf(b)) || byPop(a, b);
      case "za":
        return (a, b) => coll.compare(titleOf(b), titleOf(a)) || byPop(a, b);
      case "old":
        return (a, b) => byDate(a, b) || byPop(a, b);
      case "new":
        return (a, b) => byDate(b, a) || byPop(a, b);
      default:
        return byPop;
    }
  }

  // ---------- views: what one page shows ----------
  async function browseView() {
    const path = discoverPath(state.page);
    const data = await remember(`discover:${path}`, () => tmdb(path));
    const pages = Math.min(num(data.total_pages), MAX_PAGES);
    if (pages && state.page > pages) {
      state.page = pages;
      return browseView();
    }
    return {
      pageItems: data.results || [],
      total: num(data.total_results),
      pages: Math.max(1, pages),
      page: state.page,
      person: null,
    };
  }

  async function searchView(q) {
    const entry = await remember(`search:${KIND}:${norm(q)}`, () => findEntry(q));
    const list = entry.items.filter(passes).sort(compareFor(state.sort));
    const pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
    state.page = Math.min(state.page, pages);
    const start = (state.page - 1) * PER_PAGE;
    return {
      pageItems: list.slice(start, start + PER_PAGE),
      total: list.length,
      pages,
      page: state.page,
      person: entry.person,
    };
  }

  // ---------- drawing ----------
  function drawPerson(person) {
    const box = $("#br-person");
    if (!person) {
      box.innerHTML = "";
      return;
    }
    const photo = imgUrl(person.profile_path, "w185") || initialsAvatar(person.name);
    box.innerHTML = `
      <div class="br-person glass">
        <img src="${escapeHtml(photo)}" alt="" />
        <strong>${escapeHtml(t("browse.personBanner", { name: person.name }))}</strong>
        <a class="btn btn-sm btn-primary" href="${escapeHtml(personHref(person.id))}">${escapeHtml(t("browse.moreInfo"))}</a>
      </div>`;
  }

  // Page numbers around the current page, always with the first and the last page.
  function pageWindow(page, pages) {
    const keep = new Set([1, pages]);
    for (let n = page - 2; n <= page + 2; n += 1) if (n >= 1 && n <= pages) keep.add(n);
    const sorted = [...keep].sort((a, b) => a - b);
    const out = [];
    sorted.forEach((n, i) => {
      if (i > 0 && n - sorted[i - 1] > 1) out.push("…");
      out.push(n);
    });
    return out;
  }

  function drawPager({ page, pages }) {
    const nav = $("#br-pager");
    if (pages <= 1) {
      nav.innerHTML = "";
      return;
    }
    const prev = `<button type="button" class="btn btn-sm btn-ghost" data-page="${page - 1}"${page <= 1 ? " disabled" : ""}>${escapeHtml(t("browse.prev"))}</button>`;
    const next = `<button type="button" class="btn btn-sm btn-ghost" data-page="${page + 1}"${page >= pages ? " disabled" : ""}>${escapeHtml(t("browse.next"))}</button>`;
    const nums = pageWindow(page, pages)
      .map((n) =>
        n === "…"
          ? `<span class="br-gap" aria-hidden="true">…</span>`
          : `<button type="button" class="br-num${n === page ? " on" : ""}" data-page="${n}" aria-label="${escapeHtml(t("browse.pageNo", { n: String(n) }))}"${n === page ? ' aria-current="page"' : ""}>${n}</button>`
      )
      .join("");
    nav.innerHTML = `${prev}<div class="br-nums">${nums}</div>${next}`;
  }

  function draw(view) {
    lastView = view;
    $("#br-results").innerHTML = view.pageItems.length
      ? view.pageItems.map((x) => posterCard(x, KIND)).join("")
      : `<p class="empty">${escapeHtml(t("browse.none"))}</p>`;
    $("#br-count").textContent = view.total ? t("browse.found", { n: String(view.total) }) : "";
    drawPerson(view.person);
    drawPager(view);
  }

  function drawError() {
    lastView = null;
    $("#br-results").innerHTML = `<p class="empty">${escapeHtml(t("browse.error"))}</p>`;
    $("#br-count").textContent = "";
    $("#br-person").innerHTML = "";
    $("#br-pager").innerHTML = "";
  }

  // ---------- loading (a newer request wins over an older one) ----------
  let reqId = 0;
  let loading = false;
  let lastView = null; // what the page shows; drawn again when the labels change
  async function load() {
    const mine = ++reqId;
    loading = true;
    $("#br-results").innerHTML = `<div class="loader br-loader" style="display:grid"><div class="spinner"></div></div>`;
    try {
      const view = state.q ? await searchView(state.q) : await browseView();
      if (mine !== reqId) return;
      loading = false;
      syncUrl();
      draw(view);
    } catch (error) {
      if (mine !== reqId) return;
      loading = false;
      console.warn(error);
      drawError();
    }
  }

  // ---------- controls ----------
  let genres = [];
  async function loadGenres() {
    try {
      const data = await remember("genres", () => tmdb(`/genre/${KIND}/list`));
      genres = data.genres || [];
    } catch (error) {
      console.warn(error);
      genres = [];
    }
  }

  function setValues() {
    $("#br-q").value = state.q;
    $("#br-genre").value = state.genre;
    $("#br-rating").value = state.rating;
    $("#br-year").value = state.year;
    $("#br-sort").value = state.sort;
  }

  // Option labels depend on the language, so the lists are built again on a language change.
  function fillOptions() {
    $("#br-genre").innerHTML =
      `<option value="">${escapeHtml(t("browse.allGenres"))}</option>` +
      genres.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join("");
    $("#br-rating").innerHTML =
      `<option value="">${escapeHtml(t("browse.anyRating"))}</option>` +
      RATINGS.map((n) => `<option value="${n}">${escapeHtml(t("browse.ratingFrom", { n: String(n) }))}</option>`).join("");
    let years = `<option value="">${escapeHtml(t("browse.allYears"))}</option>`;
    for (let y = new Date().getFullYear(); y >= YEAR_FIRST; y -= 1) years += `<option value="${y}">${y}</option>`;
    $("#br-year").innerHTML = years;
    setValues();
  }

  // A change starts again from the first page.
  function change(patch) {
    Object.assign(state, patch, { page: 1 });
    syncUrl();
    load();
  }

  function bindControls() {
    let timer = null;
    const q = $("#br-q");
    q.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => change({ q: q.value.trim() }), 350);
    });
    q.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      clearTimeout(timer);
      change({ q: q.value.trim() });
    });
    [
      ["#br-genre", "genre"],
      ["#br-rating", "rating"],
      ["#br-year", "year"],
      ["#br-sort", "sort"],
    ].forEach(([sel, key]) => {
      $(sel).addEventListener("change", () => change({ [key]: $(sel).value }));
    });
    $("#br-reset").addEventListener("click", () => {
      clearTimeout(timer);
      Object.assign(state, { q: "", genre: "", rating: "", year: "", sort: "pop_desc" });
      setValues();
      change({});
    });
    $("#br-pager").addEventListener("click", (e) => {
      const button = e.target.closest("[data-page]");
      if (!button || button.disabled) return;
      state.page = Number(button.dataset.page);
      syncUrl();
      load().then(() => $("#br-results").scrollIntoView({ behavior: "smooth", block: "start" }));
    });
  }

  // ---------- start ----------
  // The site announces a language change before its language pack is applied, and again after.
  // The labels are rebuilt on every announcement; the titles are fetched again only when the
  // language really changed (theme changes do not reload anything).
  let shownLang = getLang();
  document.addEventListener("cineaura:prefs", async () => {
    if (getLang() !== shownLang) {
      shownLang = getLang();
      await loadGenres();
      await load();
    }
    fillOptions();
    if (lastView && !loading) draw(lastView);
  });

  async function boot() {
    setupChrome();
    bindControls();
    await loadGenres();
    fillOptions();
    await load();
  }
  boot();
})();
