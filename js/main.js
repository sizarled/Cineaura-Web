(() => {
  const API_KEY = "dec98ec9b59a5938a5ee3ae4eda1e090";
  const API = "https://api.themoviedb.org/3";
  const IMG = "https://image.tmdb.org/t/p";
  const SESSION_KEY = "cineaura_session";
  const HERO_MS = 7000;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function toast(message) {
    const el = $("#toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 2800);
  }

  function isLoggedIn() {
    try {
      return Boolean(JSON.parse(localStorage.getItem(SESSION_KEY) || "null"));
    } catch {
      return false;
    }
  }

  function renderAuth() {
    const logged = isLoggedIn();
    document.body.classList.toggle("is-logged-in", logged);
    document.body.classList.toggle("is-guest", !logged);
  }

  function logout() {
    localStorage.removeItem(SESSION_KEY);
    renderAuth();
    toast((window.CineAura?.t && window.CineAura.t("home.signedOut")) || "You have been signed out.");
  }

  function imgUrl(path, size = "w780") {
    if (!path) return "";
    return `${IMG}/${size}${path}`;
  }

  function formatRuntime(minutes) {
    if (!minutes) return "—";
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h ? `${h}h ${m}m` : `${m}m`;
  }

  function formatDate(value) {
    if (!value) return "TBA";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    const loc = window.CineAura?.getLocale?.() || "en-US";
    return d.toLocaleDateString(loc, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  function ratingText(value) {
    return Number(value || 0).toFixed(1);
  }

  function watchHref(type, id) {
    return `./watch.html?${type}=${id}`;
  }

  function truncate(text, max = 240) {
    if (!text) return "No synopsis available yet.";
    return text.length > max ? `${text.slice(0, max).trim()}…` : text;
  }

  async function tmdb(path) {
    const tmdbFn = window.CineAura?.tmdb;
    if (tmdbFn) return tmdbFn(path);
    const loc = window.CineAura?.getLang ? ({ en:"en-US", ar:"ar-SA", fr:"fr-FR", de:"de-DE", es:"es-ES", nl:"nl-NL", it:"it-IT" }[window.CineAura.getLang()] || "en-US") : "en-US";
    const url = `${API}${path}${path.includes("?") ? "&" : "?"}api_key=${API_KEY}&language=${loc}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`TMDB ${res.status}`);
    return res.json();
  }

  async function fetchHeroItems() {
    const [movies, shows] = await Promise.all([
      tmdb("/trending/movie/week"),
      tmdb("/trending/tv/week"),
    ]);

    const moviePick = (movies.results || []).filter((x) => x.backdrop_path).slice(0, 5);
    const tvPick = (shows.results || []).filter((x) => x.backdrop_path).slice(0, 5);

    const mixed = [];
    for (let i = 0; i < 5; i += 1) {
      if (moviePick[i]) mixed.push({ ...moviePick[i], media_type: "movie" });
      if (tvPick[i]) mixed.push({ ...tvPick[i], media_type: "tv" });
    }

    const detailed = await Promise.all(
      mixed.map(async (item) => {
        const type = item.media_type === "tv" ? "tv" : "movie";
        try {
          const info = await tmdb(`/${type}/${item.id}`);
          return { ...item, ...info, media_type: type };
        } catch {
          return { ...item, media_type: type };
        }
      })
    );

    return detailed;
  }

  function heroMeta(item) {
    const type = item.media_type === "tv" ? "tv" : "movie";
    const runtime =
      type === "movie"
        ? formatRuntime(item.runtime)
        : item.episode_run_time?.[0]
          ? `${formatRuntime(item.episode_run_time[0])} / ep`
          : item.number_of_seasons
            ? `${item.number_of_seasons} season${item.number_of_seasons > 1 ? "s" : ""}`
            : "Series";
    const genres = (item.genres || [])
      .slice(0, 3)
      .map((g) => g.name)
      .join(" · ") || "Drama";
    return { runtime, genres, type };
  }

  function renderHero(items) {
    const root = $("#hero-slides");
    const thumbs = $("#hero-thumbs");
    root.innerHTML = items
      .map((item, index) => {
        const title = item.title || item.name || "Untitled";
        const { runtime, genres, type } = heroMeta(item);
        const backdrop = imgUrl(item.backdrop_path, "original") || imgUrl(item.poster_path, "w780");
        const poster = imgUrl(item.poster_path, "w342");
        return `
          <article class="hero-slide ${index === 0 ? "active" : ""}" data-index="${index}">
            <div class="hero-bg" style="background-image:url('${backdrop}')"></div>
            <div class="hero-overlay"></div>
            <div class="hero-content">
              <div class="hero-copy">
                <span class="media-badge">${type === "tv" ? (window.CineAura?.t("home.hero.tv") || "TV Series") : (window.CineAura?.t("home.hero.movie") || "Movie")}</span>
                <h1>${escapeHtml(title)}</h1>
                <div class="hero-meta">
                  <span class="score">★ ${ratingText(item.vote_average)}</span>
                  <span>${runtime}</span>
                  <span class="genres">${escapeHtml(genres)}</span>
                  <span>${formatDate(item.release_date || item.first_air_date)}</span>
                </div>
                <p class="hero-overview">${escapeHtml(truncate(item.overview, 240))}</p>
                <div class="hero-actions">
                  <a class="btn btn-lg btn-primary" href="${watchHref(type, item.id)}">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5L13 8L4 13.5V2.5Z"/></svg>
                    ${window.CineAura?.t("home.hero.watch") || "Watch Now"}
                  </a>
                  <a class="btn btn-lg btn-ghost" href="#search">${window.CineAura?.t("home.hero.search") || "Search catalog"}</a>
                </div>
              </div>
              ${poster ? `<div class="hero-poster"><img src="${poster}" alt="${escapeHtml(title)}" /></div>` : ""}
            </div>
          </article>
        `;
      })
      .join("");

    thumbs.innerHTML = items
      .map((item, index) => {
        const thumb = imgUrl(item.backdrop_path, "w300") || imgUrl(item.poster_path, "w185");
        const title = item.title || item.name || "Slide";
        return `<button type="button" data-go="${index}" class="${index === 0 ? "active" : ""}" aria-label="${escapeHtml(title)}"><img src="${thumb}" alt="" /></button>`;
      })
      .join("");
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function startHero(items) {
    if (!items.length) return;
    let index = 0;
    let timer;

    const slides = () => $$(".hero-slide");
    const thumbs = () => $$("#hero-thumbs button");

    const show = (next) => {
      index = (next + items.length) % items.length;
      slides().forEach((el, i) => el.classList.toggle("active", i === index));
      thumbs().forEach((el, i) => el.classList.toggle("active", i === index));
    };

    const play = () => {
      clearInterval(timer);
      timer = setInterval(() => show(index + 1), HERO_MS);
    };

    $("#hero-prev").addEventListener("click", () => {
      show(index - 1);
      play();
    });
    $("#hero-next").addEventListener("click", () => {
      show(index + 1);
      play();
    });
    $("#hero-thumbs").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-go]");
      if (!btn) return;
      show(Number(btn.dataset.go));
      play();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") {
        show(index - 1);
        play();
      }
      if (e.key === "ArrowRight") {
        show(index + 1);
        play();
      }
    });

    let startX = 0;
    $("#hero").addEventListener(
      "touchstart",
      (e) => {
        startX = e.changedTouches[0].screenX;
      },
      { passive: true }
    );
    $("#hero").addEventListener(
      "touchend",
      (e) => {
        const dx = e.changedTouches[0].screenX - startX;
        if (Math.abs(dx) < 40) return;
        show(index + (dx < 0 ? 1 : -1));
        play();
      },
      { passive: true }
    );

    play();
  }

  function posterCard(item, type) {
    const title = item.title || item.name || "Untitled";
    const date = formatDate(item.release_date || item.first_air_date);
    const poster = imgUrl(item.poster_path, "w342");
    return `
      <a class="poster-card" href="${watchHref(type, item.id)}" title="${escapeHtml(title)}">
        <div class="poster-media">
          <span class="rating-badge">★ ${ratingText(item.vote_average)}</span>
          <img src="${poster}" alt="${escapeHtml(title)}" loading="lazy" />
          <div class="poster-play">
            <span class="play-orb">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5L13 8L4 13.5V2.5Z"/></svg>
            </span>
          </div>
        </div>
        <div class="poster-info">
          <h3>${escapeHtml(title)}</h3>
          <div class="poster-sub">
            <span>${escapeHtml(date)}</span>
            <span>${ratingText(item.vote_average)}/10</span>
          </div>
        </div>
      </a>
    `;
  }

  function fillMarquee(el, items, type) {
    const cards = items.map((item) => posterCard(item, type)).join("");
    el.innerHTML = cards;
  }

  // A TMDB link can carry a slug after the id: /person/500-tom-cruise,
  // /movie/550-fight-club — only the digits are kept.
  function extractTmdb(raw) {
    if (!raw) return null;
    let value = String(raw);
    try {
      const url = new URL(value, location.href);
      value = url.searchParams.get("q") || url.searchParams.get("url") || url.searchParams.get("u") || value;
    } catch {
      /* keep original */
    }
    const match = decodeURIComponent(value).match(/themoviedb\.org\/(movie|tv|person)\/(\d+)/i);
    if (!match) return null;
    return { type: match[1].toLowerCase(), id: match[2] };
  }

  // Where a TMDB hit leads: people open their Cast page, titles the watch page.
  function tmdbTarget(hit) {
    if (!hit) return "";
    return hit.type === "person" ? `./Cast.html?person=${hit.id}` : watchHref(hit.type, hit.id);
  }

  function isYouTube(raw) {
    return /youtube\.com|youtu\.be|youtube-nocookie\.com/i.test(String(raw || ""));
  }

  // Google hands back its own wrappers; a TMDB link inside one is turned into
  // the matching CineAura page (watch page for titles, Cast page for people).
  function resolveSearchHref(anchor) {
    if (!anchor) return { block: false, target: "" };
    const candidates = [
      anchor.getAttribute("data-ctorig"),
      anchor.getAttribute("data-cturl"),
      anchor.href,
      anchor.getAttribute("href"),
      anchor.textContent,
    ];
    for (const candidate of candidates) {
      if (isYouTube(candidate)) return { block: true, target: "" };
      const hit = extractTmdb(candidate);
      if (hit) return { block: false, target: tmdbTarget(hit) };
    }
    return { block: false, target: "" };
  }

  function interceptSearchNavigation(event) {
    const anchor = event.target.closest?.("a");
    if (!anchor) return;
    const insideResults =
      anchor.closest(".gsc-results") ||
      anchor.closest(".gsc-results-wrapper-overlay") ||
      anchor.closest(".gcse-search") ||
      anchor.closest(".gsc-completion-container");
    if (!insideResults && !/themoviedb\.org|google\.com\/url/i.test(anchor.href || "")) {
      return;
    }

    const resolved = resolveSearchHref(anchor);
    if (resolved.block) {
      event.preventDefault();
      event.stopPropagation();
      toast((window.CineAura?.t && window.CineAura.t("home.search.ytOff")) || "YouTube results are disabled on CineAura.");
      return;
    }
    if (resolved.target) {
      event.preventDefault();
      event.stopPropagation();
      location.href = resolved.target;
    }
  }

  function installSearchIntercept() {
    ["click", "auxclick", "mousedown"].forEach((name) => {
      document.addEventListener(name, interceptSearchNavigation, true);
    });

    const originalOpen = window.open;
    window.open = function patchedOpen(url, ...rest) {
      if (isYouTube(url)) {
        toast((window.CineAura?.t && window.CineAura.t("home.search.ytOff")) || "YouTube results are disabled on CineAura.");
        return null;
      }
      const hit = extractTmdb(url);
      if (hit) {
        location.href = tmdbTarget(hit);
        return null;
      }
      return originalOpen.call(window, url, ...rest);
    };

    const observer = new MutationObserver(() => {
      $$(".gsc-results a, .gs-title, a.gs-title, .gs-visibleUrl").forEach((node) => {
        const anchor = node.tagName === "A" ? node : node.closest("a");
        const resolved = resolveSearchHref(anchor);
        if (resolved.target && anchor) {
          anchor.setAttribute("href", resolved.target);
          anchor.setAttribute("target", "_self");
        }
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function setupChrome() {
    const header = $("#site-header");
    const onScroll = () => header.classList.toggle("scrolled", window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    const hamburger = $("#hamburger");
    const menu = $("#mobile-menu");
    hamburger.addEventListener("click", () => {
      const open = !menu.classList.contains("open");
      menu.classList.toggle("open", open);
      document.body.classList.toggle("menu-open", open);
    });
    menu.addEventListener("click", (e) => {
      if (e.target.closest("a")) {
        menu.classList.remove("open");
        document.body.classList.remove("menu-open");
      }
      if (e.target.closest("[data-logout]")) logout();
    });

    $("#logout-btn")?.addEventListener("click", logout);

    $("#contact-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const fd = new FormData(form);
      const session = (() => {
        try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { return null; }
      })();
      if (window.CineAura?.supabaseRequest) {
        await window.CineAura.supabaseRequest("/rest/v1/panel_messages", {
          method: "POST",
          body: JSON.stringify({
            source: session?.member_id ? "member" : "contact",
            sender_id: session?.member_id || "",
            sender_name: fd.get("name") || session?.username || "",
            sender_email: fd.get("email") || "",
            body: fd.get("message") || "",
          }),
        });
      }
      form.reset();
      toast((window.CineAura?.t && window.CineAura.t("home.msg.sent")) || "Message sent. Our support team will reply soon.");
    });
  }

  async function init() {
    if (window.CineAura?.setupChrome) {
      window.CineAura.setupChrome();
    } else {
      setupChrome();
    }
    const form = $("#contact-form");
    if (form && !form.dataset.bound) {
      form.dataset.bound = "1";
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const session = (() => {
          try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { return null; }
        })();
        if (window.CineAura?.supabaseRequest) {
          await window.CineAura.supabaseRequest("/rest/v1/panel_messages", {
            method: "POST",
            body: JSON.stringify({
              source: session?.member_id ? "member" : "contact",
              sender_id: session?.member_id || "",
              sender_name: fd.get("name") || session?.username || "",
              sender_email: fd.get("email") || "",
              body: fd.get("message") || "",
            }),
          });
        }
        form.reset();
        toast((window.CineAura?.t && window.CineAura.t("home.msg.sent")) || "Message sent. Our support team will reply soon.");
      });
    }
    renderAuth();
    window.CineAura?.translateDom?.(document);
    installSearchIntercept();

    try {
      const [heroItems, movies, shows] = await Promise.all([
        fetchHeroItems(),
        tmdb("/trending/movie/week"),
        tmdb("/trending/tv/week"),
      ]);

      renderHero(heroItems);
      startHero(heroItems);
      fillMarquee($("#movies-track"), (movies.results || []).slice(0, 20), "movie");
      fillMarquee($("#series-track"), (shows.results || []).slice(0, 20), "tv");
    } catch (error) {
      console.error(error);
      toast((window.CineAura?.t && window.CineAura.t("home.tmdb.fail")) || "Could not load TMDB titles. Please refresh.");
    } finally {
      $("#hero-loader")?.remove();
    }
  }

  // IPTV "Explore" of the premium channels: signed-in members go to the IPTV tab
  // of the dashboard, everyone else is sent to the sign-in page and brought back
  // there afterwards. (The free channels card links straight to
  // Listchannels.html?free=1, which guests may browse before signing in.)
  document.addEventListener("click", (e) => {
    const link = e.target.closest("[data-iptv-explore]");
    if (!link) return;
    e.preventDefault();
    location.href = isLoggedIn() ? "./dashboard.html#iptv" : "./login.html?next=" + encodeURIComponent("dashboard.html#iptv");
  });

  /* "Get the app": one card per platform (CineAura.APP_PLATFORMS in common.js).
     The download links and versions are managed in Panel > Apps (table
     app_downloads, sql/apps.sql). A platform with a link shows "Available", its
     version and a Download button; one without a link shows "Coming soon". The
     last answer is kept in this browser, so a repeat visit shows the cards at once. */
  const APPS_KEY = "cineaura_apps";
  const DL_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="M7 10.5l5 5 5-5"/><path d="M5 20h14"/></svg>';
  let appRows = null; // Map(platform -> row) once known

  function readAppsCache() {
    try {
      const saved = JSON.parse(localStorage.getItem(APPS_KEY) || "null");
      return saved && Array.isArray(saved.rows) ? saved.rows : null;
    } catch {
      return null;
    }
  }

  function appCardHtml(p) {
    const C = window.CineAura;
    const esc = C.escapeHtml;
    const row = appRows ? appRows.get(p.key) : null;
    const url = row ? C.appDownloadUrl(row.url) : "";
    const state = !appRows ? "loading" : url ? "available" : "soon";
    let get = "";
    if (state === "available") {
      const version = C.appVersion(row.version);
      // a file on this site downloads in place; another site opens in a new tab
      const external = !url.startsWith("/") && new URL(url).origin !== location.origin;
      const target = external ? ' target="_blank" rel="noopener noreferrer"' : " download";
      get = `
        <span class="app-os-ok"><i aria-hidden="true"></i>${esc(C.t("home.apps.available"))}</span>
        ${version ? `<span class="app-os-ver" dir="auto">${esc(C.t("home.apps.version", { v: version }))}</span>` : ""}
        <a class="btn btn-sm btn-primary app-os-dl" href="${esc(url)}"${target} aria-label="${esc(C.t("home.apps.downloadFor", { app: p.app, os: p.os }))}">${DL_ICON}<span>${esc(C.t("home.apps.download"))}</span></a>`;
    } else if (state === "loading") {
      get = '<span class="app-os-wait" aria-hidden="true"></span>';
    }
    return `
      <article class="app-os" data-app="${p.key}" data-state="${state}">
        <div class="app-os-top">
          <span class="app-os-logo">${p.logo}</span>
          ${state === "soon" ? `<span class="app-os-soon">${esc(C.t("home.app.soon"))}</span>` : ""}
        </div>
        <h3 class="app-os-name" dir="ltr">${esc(p.os)}</h3>
        <p class="app-os-app" dir="ltr">${esc(p.app)}</p>
        ${get}
      </article>`;
  }

  function renderApps() {
    const box = document.getElementById("app-platforms");
    const C = window.CineAura;
    if (!box || !C?.APP_PLATFORMS) return;
    box.innerHTML = C.APP_PLATFORMS.map(appCardHtml).join("");
    if (appRows) box.removeAttribute("aria-busy");
  }

  // source: "saved" (this browser's last answer), "live" (the database) or "none"
  function setApps(rows, source) {
    appRows = new Map((rows || []).map((r) => [String(r.platform || ""), r]));
    renderApps();
    const box = document.getElementById("app-platforms");
    if (box) box.dataset.source = source;
  }

  async function setupApps() {
    const C = window.CineAura;
    if (!document.getElementById("app-platforms") || !C?.APP_PLATFORMS) return;
    const cached = readAppsCache();
    if (cached) setApps(cached, "saved");
    else renderApps();
    document.addEventListener("cineaura:prefs", renderApps);
    let rows = null;
    try {
      const res = await C.supabaseRequest("/rest/v1/app_downloads?select=platform,url,version");
      if (res.ok && Array.isArray(res.data)) rows = res.data;
      else if (res.status === 404) rows = []; // no such table (sql/apps.sql not run): nothing to download
    } catch {
      /* offline: keep what is shown */
    }
    if (rows) {
      try {
        localStorage.setItem(APPS_KEY, JSON.stringify({ at: Date.now(), rows }));
      } catch {
        /* storage full or blocked */
      }
      setApps(rows, "live");
    } else if (!appRows) {
      setApps([], "none"); // no answer and nothing saved: "Coming soon"
    }
  }

  document.addEventListener("DOMContentLoaded", setupApps);
  document.addEventListener("DOMContentLoaded", init);
})();
