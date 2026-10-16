(() => {
  const {
    $,
    $$,
    tmdb,
    imgUrl,
    photo,
    formatRuntime,
    formatDate,
    ratingText,
    ratingPercent,
    escapeHtml,
    tr,
    watchHref,
    personHref,
    posterCard,
    shareRowHtml,
    setupChrome,
    isLoggedIn,
    verifyCode,
    getStoredCode,
    setStoredCode,
    clearStoredCode,
    deviceMac,
    toast,
    getSession,
    supabaseRequest,
    restValue,
    t,
    translateDom,
    getLang,
    validWatchUrl,
    linkQualityOptions,
    linkLanguageOptions,
    langPickerHtml,
    selectedLangs,
    bindLangPicker,
    publishWatchLink,
    getLocale,
    linkHostName,
    hostIconUrl,
    urlHost,
    linkThumb,
    linkKindOf,
    countLinkClick,
    stableGuestId,
    avatarImg,
    hydrateAvatars,
    qualityRank,
    qualityBadge,
    qualityList,
    qualityPickerHtml,
    selectedQualities,
    countRows,
    UI_LANG_NAME,
    linkLangMatch,
    detectGeo,
    manualCountry,
    currentCountry,
    countryName,
    fetchProviderOffers,
    titleAge,
    tierForAge,
    titleNeedsCode,
    AGE_NO_PREVIEW,
  } = window.CineAura;

  const PREVIEW_MS = 5 * 60 * 1000;
  const CODE_FAIL_MAX = 3;
  const CODE_LOCK_MS = 24 * 60 * 60 * 1000;
  const CODE_LOCK_KEY = "cineaura_code_lockout";
  const params = new URLSearchParams(location.search);
  const movieId = params.get("movie");
  const tvId = params.get("tv");
  const mediaType = tvId ? "tv" : "movie";
  const mediaId = tvId || movieId;
  // Post attribution: links shared inside a post look like
  // /watch.html?movie=123&post=P456 — the watched minutes go to the post owner.
  const postId = params.get("post") || "";

  const state = {
    detail: null,
    season: Number(params.get("season") || 1) || 1,
    episode: Number(params.get("episode") || 1) || 1,
    seasons: [],
    episodes: [],
    unlocked: false,
    needsCode: false,
    ageInfo: null,
    gated: false,
    timer: null,
    lockTimer: null,
    endsAt: 0,
    // The free preview of a title that needs a code: 5 minutes per title (per
    // episode), paused while nothing plays — choosing another link does not
    // start it again.
    previewLeft: PREVIEW_MS,
    storedIssue: "",
    watchMinutes: 0,
    viewId: null,
    viewMinutes: 0,
    watchClock: null,
    linkOwnerId: "",
    linkWatchUrl: "",
    guestId: "",
    postId: postId || "",
    postOwnerId: "",
    blocksAgainstMe: [],
    sanctions: null,
    recDone: "",
    watchTab: "comments",
    ctx: null,
    /* TMDB watch providers, the region they are shown for, and the member links
       the filters and the sorting work on. */
    providers: null,
    providerRegion: "",
    providerOffers: null,
    offersRegion: "",
    providerQuality: "best_price",
    linkRows: [],
    linkOrder: [],
    selectedLink: null,
    // The watch link the big play button starts (null = the main link) and the
    // one playing now. Choosing a link only arms it: the play button and the
    // runtime come back, and the minutes count from the press on play.
    playLink: null,
    playingLink: null,
    mainRow: null,
    linkFilters: { quality: "", platform: "" },
  };

  async function loadPostOwner() {
    state.postOwnerId = "";
    if (!state.postId) return;
    try {
      const res = await supabaseRequest(
        `/rest/v1/posts?post_id=eq.${restValue(state.postId)}&select=owner_id`
      );
      const row = res.ok && Array.isArray(res.data) ? res.data[0] : null;
      state.postOwnerId = row?.owner_id ? String(row.owner_id) : "";
    } catch {
      state.postOwnerId = "";
    }
  }

  async function loadMySanctions() {
    const session = getSession();
    if (!session?.member_id) return;
    const res = await supabaseRequest(
      `/rest/v1/sanctions?member_id=eq.${restValue(session.member_id)}&select=features`
    );
    state.sanctions = res.data?.[0] || null;
  }

  function featureBlocked(name) {
    return String(state.sanctions?.features || "")
      .split(",")
      .map((s) => s.trim())
      .includes(name);
  }

  function subtitleLang() {
    const lang = typeof getLang === "function" ? getLang() : "en";
    const map = { en: "en", ar: "ar", fr: "fr", de: "de", es: "es", nl: "nl", it: "it" };
    return map[lang] || "en";
  }

  function embedUrl() {
    const sub = subtitleLang();
    if (mediaType === "tv") {
      return `https://vidsrc.sh/embed/tv/${mediaId}/${state.season}/${state.episode}?ds_lang=${sub}`;
    }
    return `https://vidsrc.sh/embed/movie/${mediaId}?ds_lang=${sub}`;
  }

  function certification(detail) {
    if (mediaType === "movie") {
      const groups = detail.release_dates?.results || [];
      const us = groups.find((g) => g.iso_3166_1 === "US") || groups[0];
      const hit = us?.release_dates?.find((d) => d.certification)?.certification;
      return hit || "NR";
    }
    const groups = detail.content_ratings?.results || [];
    const us = groups.find((g) => g.iso_3166_1 === "US") || groups[0];
    return us?.rating || "NR";
  }

  /* ---------- Age limits ----------
     The title's certificate decides which codes may open it. A code saved for
     children simply refuses an adult title, so a parent can hand out one code
     per child without worrying about what it reaches. */
  function ageVerifyOptions() {
    return { requiredAge: state.ageInfo?.age || 0, cert: state.ageInfo?.cert || "" };
  }

  // A title rated for older viewers plays no preview: without a code that reaches
  // its rating it stays locked, so a child cannot watch the first minutes either.
  function ageLocked() {
    return Boolean(state.needsCode && !state.unlocked && (state.ageInfo?.age || 0) >= AGE_NO_PREVIEW);
  }

  function certChipText(detail) {
    const cert = escapeHtml(certification(detail));
    const info = state.ageInfo;
    if (!info || !info.known) return cert;
    return `${cert} · ${info.age}+`;
  }

  function ageNoticeText() {
    const info = state.ageInfo;
    if (!info) return "";
    const vars = { age: info.age, cert: info.cert, need: t(tierForAge(info.age).label) };
    return info.known ? t("watch.ageNotice", vars) : t("watch.ageUnknown", vars);
  }

  function renderAgeNotice() {
    const el = $("#gate-age");
    if (!el) return;
    const text = state.needsCode ? ageNoticeText() : "";
    el.hidden = !text;
    el.textContent = text;
  }

  function currentRuntime() {
    if (mediaType === "movie") return state.detail?.runtime;
    const ep = state.episodes.find((e) => e.episode_number === state.episode);
    return ep?.runtime || state.detail?.episode_run_time?.[0] || null;
  }

  function idleBackdrop() {
    if (mediaType === "tv") {
      const ep = state.episodes.find((e) => e.episode_number === state.episode);
      if (ep?.still_path) return imgUrl(ep.still_path, "w1280");
    }
    return (
      imgUrl(state.detail?.backdrop_path, "original") ||
      imgUrl(state.detail?.poster_path, "w780")
    );
  }

  function setIdleArt() {
    const idle = $("#player-idle");
    const bg = idleBackdrop();
    idle.style.backgroundImage = bg ? `url('${bg}')` : "none";
    $("#play-runtime").textContent = formatRuntime(currentRuntime());
    renderPlaySource();
  }

  // Above the play button: the link it is going to start, once one was chosen.
  function playSourceName(row) {
    if (row.isMain) return SITE_NAME;
    const index = state.linkOrder.indexOf(row);
    const named = index >= 0 ? $(`.src-card[data-index="${index}"] .src-name`)?.textContent : "";
    const url = String(row.watch_url || "");
    return named || linkHostName(url) || urlHost(url) || t("watch.source");
  }

  function renderPlaySource() {
    const el = $("#play-source");
    const btn = $("#play-btn");
    const row = state.playLink;
    if (!el) return;
    if (!row) {
      el.hidden = true;
      el.innerHTML = "";
      btn?.setAttribute("aria-label", t("watch.play"));
      return;
    }
    const name = playSourceName(row);
    const logo = row.isMain
      ? `<img src="${SITE_LOGO}" alt="" />`
      : `<img src="${escapeHtml(hostIconUrl(String(row.watch_url || "")))}" alt="" referrerpolicy="no-referrer" />`;
    el.innerHTML = `${logo}<span>${escapeHtml(name)}</span>${qualityList(row.quality)
      .slice(0, 3)
      .map((q) => `<em>${escapeHtml(q)}</em>`)
      .join("")}`;
    el.hidden = false;
    btn?.setAttribute("aria-label", t("watch.playFrom", { name }));
  }

  // Pauses the preview: the time left is kept for the next press on play.
  function stopTimer() {
    if (state.timer && state.endsAt) state.previewLeft = Math.max(0, state.endsAt - Date.now());
    clearInterval(state.timer);
    state.timer = null;
    state.endsAt = 0;
    $("#countdown-dock").classList.remove("show");
  }

  function stopMinuteTicker() {
    state.watchClock?.stop();
    stopNetWatch();
  }

  function minutesLabel(n) {
    return t("watch.min", { n: Math.max(0, Number(n) || 0) });
  }

  function updateMinutesChip() {
    const chip = $("#watch-min-chip");
    if (chip) chip.textContent = minutesLabel(state.watchMinutes);
  }

  async function loadWatchMinutes() {
    const res = await supabaseRequest(
      `/rest/v1/views?tmdb_id=eq.${Number(mediaId)}&media_type=eq.${mediaType}&select=minutes`
    );
    const rows = res.ok && Array.isArray(res.data) ? res.data : [];
    state.watchMinutes = rows.reduce((sum, row) => sum + Number(row.minutes || 0), 0);
    updateMinutesChip();
  }

  async function addProfileMinute(memberId, field) {
    if (!memberId) return;
    const prof = await supabaseRequest(
      `/rest/v1/profiles?member_id=eq.${restValue(memberId)}&select=private_minutes,public_minutes`
    );
    const row = prof.data?.[0];
    if (!row) return;
    await supabaseRequest(`/rest/v1/profiles?member_id=eq.${restValue(memberId)}`, {
      method: "PATCH",
      body: JSON.stringify({ [field]: Number(row[field] || 0) + 1 }),
    });
  }

  async function ensureViewRow(linkOwnerId, watchUrl) {
    const owner = String(linkOwnerId || "");
    const url = String(watchUrl || "");
    if (state.viewId && state.linkOwnerId === owner && state.linkWatchUrl === url) return;
    const session = getSession && getSession();
    if (!state.guestId) state.guestId = stableGuestId();
    const viewer = session?.member_id || state.guestId;
    const playlistId = params.get("Playlist") || params.get("playlist") || "";
    const payload = {
      viewer_id: viewer,
      tmdb_id: Number(mediaId),
      media_type: mediaType,
      playlist_id: playlistId,
      minutes: 0,
      link_owner_id: owner,
      watch_url: url,
      post_id: state.postId || "",
    };
    if (mediaType === "tv") {
      payload.season = state.season;
      payload.episode = state.episode;
    }
    let saved = await supabaseRequest("/rest/v1/views", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (!saved.ok) {
      const fallback = {
        viewer_id: viewer,
        tmdb_id: Number(mediaId),
        media_type: mediaType,
        playlist_id: playlistId,
        minutes: 0,
        link_owner_id: owner,
      };
      saved = await supabaseRequest("/rest/v1/views", {
        method: "POST",
        body: JSON.stringify(fallback),
      });
      // Older databases without watch_url/post_id: retry without watch_url but keep post_id.
      if (!saved.ok && state.postId) {
        saved = await supabaseRequest("/rest/v1/views", {
          method: "POST",
          body: JSON.stringify({ ...fallback, post_id: state.postId }),
        });
      }
    }
    state.viewId = saved?.data?.[0]?.id || null;
    state.viewMinutes = 0;
    state.linkOwnerId = owner;
    state.linkWatchUrl = url;
  }

  // A minute is counted only when ads can do their job:
  //  - a premium member who switched on "Watch without ads" (Site Settings) earns no minutes;
  //  - a viewer who sees ads (Free, or Premium with the option off) earns minutes only while
  //    the ads are visible — an ad blocker stops the count for everyone;
  //  - guests are not affected.
  async function adsAllowCounting() {
    try {
      if (await CineAura.adFreeActive()) return false;
      if (!(await CineAura.adsEligible())) return true;
      return window.CineAuraAds?.status === "ok";
    } catch {
      return true;
    }
  }

  // Real connectivity, not just the browser's flag: navigator.onLine stays true on a network
  // with no internet. While the probe fails (or the browser says offline) no time is counted;
  // counting continues from the same point when the connection is back.
  const net = { down: false, timer: 0 };
  async function probeNet() {
    if (navigator.onLine === false) {
      net.down = true;
      return;
    }
    const ctl = new AbortController();
    const timeout = setTimeout(() => ctl.abort(), 6000);
    try {
      // no-cors: any answer (even 401) proves the internet works; only a network failure throws
      await fetch(`${CineAura.SUPABASE_URL}/rest/v1/`, { mode: "no-cors", cache: "no-store", signal: ctl.signal });
      net.down = false;
    } catch {
      net.down = true;
    } finally {
      clearTimeout(timeout);
    }
  }
  function startNetWatch() {
    if (net.timer) return;
    net.timer = setInterval(probeNet, 8000);
    probeNet();
  }
  function stopNetWatch() {
    clearInterval(net.timer);
    net.timer = 0;
    net.down = false;
  }
  window.addEventListener("offline", () => {
    net.down = true;
  });
  window.addEventListener("online", () => {
    if (net.timer) probeNet();
  });

  // A minute is only counted while the viewer is really watching: the tab is visible,
  // the window has focus, the browser is online and the player is playing.
  // hasFocus() stays true while the focus is inside the player iframe, so clicking
  // play inside the video does not pause the clock. Leaving for another tab or window
  // pauses it, and it resumes when the viewer comes back.
  function isWatchingNow() {
    if (document.hidden) return false;
    if (typeof document.hasFocus === "function" && !document.hasFocus()) return false;
    if (navigator.onLine === false || net.down) return false;
    return Boolean($("#player")?.classList.contains("is-playing")) && !state.gated;
  }

  // Watch points (sql/point_levels.sql): the server credits every counted minute at the
  // rate of the viewer's country times the level of whoever earns — the viewer, and the
  // member whose link is playing. The IP country found here goes along only for a server
  // without Cloudflare's country header; the country picked in Site Settings never does.
  async function creditWatchPoints() {
    const session = getSession && getSession();
    const viewer = session?.member_id || state.guestId;
    if (!state.viewId || !viewer) return;
    let cc = "";
    try {
      cc = (await CineAura.detectGeo()) || "";
    } catch {
      cc = "";
    }
    const res = await CineAura.rpc("watch_minute", { p_view: state.viewId, p_viewer: viewer, p_country: cc }).catch(() => null);
    const me = res?.ok ? res.data?.viewer : null;
    if (me && Number(me.level_after) > Number(me.level)) {
      toast(t("points.levelUp", { level: CineAura.levelName(me.level_after), n: CineAura.levelMultiplier(me.level_after) }));
    }
  }

  async function countWatchedMinute() {
    if (!(await adsAllowCounting())) return;
    state.watchMinutes += 1;
    state.viewMinutes += 1;
    updateMinutesChip();
    if (state.viewId) {
      await supabaseRequest(`/rest/v1/views?id=eq.${state.viewId}`, {
        method: "PATCH",
        body: JSON.stringify({ minutes: state.viewMinutes }),
      });
      creditWatchPoints();
    }
    const session = getSession && getSession();
    if (session?.member_id) {
      const playlistId = params.get("Playlist") || params.get("playlist") || "";
      let field = "private_minutes";
      if (playlistId) {
        const pl = await supabaseRequest(
          `/rest/v1/playlists?playlist_id=eq.${restValue(playlistId)}&select=visibility`
        );
        if (String(pl.data?.[0]?.visibility || "").toLowerCase() === "public") field = "public_minutes";
      }
      await addProfileMinute(session.member_id, field);
    }
    if (state.linkOwnerId && state.linkOwnerId !== session?.member_id) {
      await addProfileMinute(state.linkOwnerId, "public_minutes");
    }
  }

  function getWatchClock() {
    if (!state.watchClock) {
      state.watchClock = window.CineAuraWatchClock.createWatchClock({
        isActive: isWatchingNow,
        onMinute: countWatchedMinute,
      });
    }
    return state.watchClock;
  }

  function startMinuteTicker() {
    startNetWatch();
    getWatchClock().start();
  }

  function stopEmbed() {
    stopMinuteTicker();
    $("#player-frame").removeAttribute("src");
    $("#player-frame").src = "about:blank";
  }

  function showIdle() {
    $("#player").classList.remove("is-playing");
    $("#player-idle").style.display = "grid";
  }

  function hideIdle() {
    $("#player").classList.add("is-playing");
    $("#player-idle").style.display = "none";
  }

  function readCodeLock() {
    try {
      const raw = JSON.parse(localStorage.getItem(CODE_LOCK_KEY) || "null");
      if (!raw || typeof raw !== "object") return { fails: 0, until: 0 };
      const until = Number(raw.until) || 0;
      if (until && until <= Date.now()) {
        const fresh = { fails: 0, until: 0 };
        localStorage.setItem(CODE_LOCK_KEY, JSON.stringify(fresh));
        return fresh;
      }
      return { fails: Math.max(0, Number(raw.fails) || 0), until };
    } catch {
      return { fails: 0, until: 0 };
    }
  }

  function writeCodeLock(data) {
    localStorage.setItem(CODE_LOCK_KEY, JSON.stringify(data));
  }

  function clearCodeLock() {
    writeCodeLock({ fails: 0, until: 0 });
  }

  function codeLockRemaining() {
    return Math.max(0, readCodeLock().until - Date.now());
  }

  function isCodeLocked() {
    return codeLockRemaining() > 0;
  }

  function formatLockClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function lockMessage() {
    return t("watch.lockout", { time: formatLockClock(codeLockRemaining()) });
  }

  function setCodeFormEnabled(on) {
    const input = $("#code-input");
    const btn = $("#unlock-btn");
    if (input) {
      input.disabled = !on;
      if (!on) input.value = "";
    }
    if (btn) btn.disabled = !on;
    $("#player-gate .gate-card")?.classList.toggle("is-locked", !on);
  }

  function stopLockTicker() {
    clearInterval(state.lockTimer);
    state.lockTimer = null;
  }

  function applyLockUI() {
    if (!isCodeLocked()) {
      stopLockTicker();
      setCodeFormEnabled(true);
      return false;
    }
    setCodeFormEnabled(false);
    const msg = $("#gate-msg");
    if (msg) {
      msg.textContent = lockMessage();
      msg.className = "gate-msg error";
    }
    if (!state.lockTimer) {
      state.lockTimer = setInterval(() => {
        if (!isCodeLocked()) {
          stopLockTicker();
          setCodeFormEnabled(true);
          if (msg) {
            msg.textContent = t("watch.lockoutOver");
            msg.className = "gate-msg ok";
          }
          toast(t("watch.lockoutOver"));
          return;
        }
        if (msg) {
          msg.textContent = lockMessage();
          msg.className = "gate-msg error";
        }
      }, 1000);
    }
    return true;
  }

  function recordFailedCode() {
    const lock = readCodeLock();
    if (lock.until > Date.now()) return lock;
    lock.fails += 1;
    if (lock.fails >= CODE_FAIL_MAX) {
      lock.fails = CODE_FAIL_MAX;
      lock.until = Date.now() + CODE_LOCK_MS;
    }
    writeCodeLock(lock);
    return lock;
  }

  function showGate(message, kind = "error") {
    state.gated = true;
    stopTimer();
    stopEmbed();
    state.playingLink = null;
    showIdle();
    $("#player-gate").classList.add("show");
    $("#create-code").href = isLoggedIn() ? "./dashboard.html#codes" : "./login.html";
    // A code works on one device: say which one this is
    const device = $("#gate-device");
    if (device) device.textContent = t("watch.deviceLine", { mac: `\u2066${deviceMac()}\u2069` });
    renderAgeNotice();
    if (applyLockUI()) return;
    const msg = $("#gate-msg");
    msg.textContent = message || "";
    msg.className = `gate-msg ${kind}`;
  }

  function hideGate() {
    state.gated = false;
    $("#player-gate").classList.remove("show");
    $("#gate-msg").textContent = "";
  }

  function formatClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = String(Math.floor(total / 60)).padStart(2, "0");
    const s = String(total % 60).padStart(2, "0");
    return `${m}:${s}`;
  }

  function lockPlayer() {
    showGate(state.storedIssue || t("watch.enterCode"));
  }

  // Starts (or goes on with) the preview of a title that needs a code.
  function startCountdown() {
    if (state.previewLeft <= 0) {
      lockPlayer();
      return;
    }
    clearInterval(state.timer);
    state.endsAt = Date.now() + state.previewLeft;
    const dock = $("#countdown-dock");
    const label = $("#countdown-time");
    dock.classList.add("show");
    label.textContent = formatClock(state.previewLeft);
    state.timer = setInterval(() => {
      const left = state.endsAt - Date.now();
      state.previewLeft = Math.max(0, left);
      label.textContent = formatClock(left);
      if (left <= 0) lockPlayer();
    }, 250);
  }

  function playEmbed() {
    hideGate();
    hideIdle();
    // (the link list may still be loading: the main link is known by its flag)
    state.playingLink = state.mainRow || { isMain: true };
    $("#player-frame").src = embedUrl();
    if (state.needsCode && !state.unlocked) startCountdown();
    else stopTimer();
    // Opened from a post (&post=...): credit the watched minutes to the post owner.
    const owner = state.postId ? state.postOwnerId || "" : "";
    const url = state.postId ? embedUrl() : "";
    ensureViewRow(owner, url).then(() => startMinuteTicker());
    activateMainLink();
  }

  // A member's watch link in the player. Its view is counted here, on play.
  function playMemberLink(row) {
    const url = String(row?.watch_url || "");
    if (!url) return;
    if (ageLocked()) {
      lockPlayer();
      return;
    }
    if (state.gated) {
      $("#code-input")?.focus();
      toast(t("watch.enterFirst"));
      return;
    }
    hideGate();
    hideIdle();
    state.playingLink = row;
    $("#player-frame").src = url;
    if (state.needsCode && !state.unlocked) startCountdown();
    else stopTimer();
    ensureViewRow(row.member_id || "", url).then(() => startMinuteTicker());
    countClick(row);
  }

  // The big play button: starts the link that was chosen (the main one when
  // none was).
  function playArmed() {
    const row = state.playLink;
    if (row && !row.isMain && linkKindOf(row) === "watch") playMemberLink(row);
    else playEmbed();
  }

  /* Choosing a watch link stops what plays and brings the play button back, with
     the runtime under it: nothing loads and no minute counts before the press on
     play. The link that is already playing goes on. */
  function armLink(row) {
    const current = state.playingLink;
    const playing = Boolean(current) && !state.gated && $("#player")?.classList.contains("is-playing");
    if (playing && (current === row || (current.isMain && row.isMain))) {
      $("#player")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    state.playLink = row;
    stopTimer(); // the preview pauses: its time left waits for the press on play
    stopEmbed();
    state.playingLink = null;
    showIdle();
    setIdleArt();
    $("#player")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function linkHost(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "source";
    }
  }

  async function renderPlaylistBar() {
    const el = $("#title-playlist");
    if (!el) return;
    const session = getSession();
    if (!session?.member_id) {
      el.innerHTML = `
        <span class="eyebrow">${t("dash.nav.playlists")}</span>
        <p class="muted">${t("watch.signPl", { kind: mediaType === "tv" ? t("common.series") : t("common.movie") })}</p>
        <a class="btn btn-sm btn-primary" href="./login.html">Sign in</a>`;
      return;
    }
    const res = await supabaseRequest(
      `/rest/v1/playlists?owner_id=eq.${restValue(session.member_id)}&media_type=eq.${mediaType}&select=playlist_id,name,kind&order=created_at.asc`
    );
    const lists = res.ok && Array.isArray(res.data) ? res.data : [];
    if (!lists.length) {
      el.innerHTML = `
        <span class="eyebrow">${t("dash.nav.playlists")}</span>
        <p class="muted">${t("watch.noPl", { kind: mediaType === "tv" ? t("common.series") : t("common.movie") })}</p>
        <a class="btn btn-sm btn-primary" href="./dashboard.html">${t("watch.openDash")}</a>`;
      return;
    }
    el.innerHTML = `
      <span class="eyebrow">${t("dash.nav.playlists")}</span>
      <p class="muted">${t("watch.addList")}</p>
      <div class="playlist-add">
        <select id="pl-pick" aria-label="${t("watch.yourPl")}">
          ${lists.map((pl) => `<option value="${escapeHtml(pl.playlist_id)}">${escapeHtml(pl.name)}</option>`).join("")}
        </select>
        <button class="btn btn-sm btn-primary" id="pl-add" type="button">${t("watch.addTo")}</button>
      </div>`;
    $("#pl-add").onclick = async () => {
      const playlistId = $("#pl-pick").value;
      if (!playlistId) return;
      if (!(await window.CineAura.guardFeature("posts"))) return;
      const exists = await supabaseRequest(
        `/rest/v1/playlist_items?playlist_id=eq.${restValue(playlistId)}&tmdb_id=eq.${Number(mediaId)}&select=id`
      );
      if (exists.ok && exists.data?.[0]) {
        toast(t("watch.alreadyIn"));
        return;
      }
      const d = state.detail || {};
      const saved = await supabaseRequest("/rest/v1/playlist_items", {
        method: "POST",
        body: JSON.stringify({
          playlist_id: playlistId,
          tmdb_id: Number(mediaId),
          media_type: mediaType,
          title: d.title || d.name || "",
          poster_path: d.poster_path || "",
          visibility: "private",
        }),
      });
      if (!saved.ok) {
        toast(t("watch.addFail"));
        return;
      }
      toast(t("watch.added"));
    };
  }

  /* ---------- Tabs under the player: Comments · Recommend · Reviews · Playlists ---------- */
  const WATCH_TABS = ["comments", "recommend", "reviews", "playlists"];

  function tabLabel(tab) {
    if (tab === "recommend") return t("watch.rec.title", { kind: kindLabel() });
    if (tab === "reviews") return t("rev.reviews");
    if (tab === "playlists") return t("dash.nav.playlists");
    return t("watch.comments");
  }

  function splitList(value) {
    return String(value || "")
      .split(/[,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  function ageYears(birth) {
    if (!birth) return null;
    const d = new Date(birth);
    if (Number.isNaN(d.getTime())) return null;
    return Math.max(0, Math.floor((Date.now() - d.getTime()) / (365.25 * 86400000)));
  }

  function tmdbIdsInText(value) {
    return String(value || "")
      .split(/[\n,;]+/)
      .map((raw) => {
        const s = raw.trim();
        const m = s.match(/themoviedb\.org\/(movie|tv|person)\/(\d+)/i);
        if (m) return Number(m[2]);
        return /^\d+$/.test(s) ? Number(s) : null;
      })
      .filter((n) => n != null);
  }

  // Everything the Reviews / Playlists tabs need about me: my member row, my
  // language, who I follow and what I have watched. Fetched once per page.
  async function viewerContext() {
    if (state.ctx) return state.ctx;
    const session = getSession();
    const ctx = {
      session,
      me: null,
      language: "",
      myUsername: String(session?.username || "").toLowerCase(),
      following: new Set(),
      watched: new Set(),
    };
    if (session?.member_id) {
      const [mem, prof, fol, hist, vw] = await Promise.all([
        supabaseRequest(
          `/rest/v1/members?member_id=eq.${restValue(session.member_id)}&select=username,gender,birth_date,country`
        ),
        supabaseRequest(
          `/rest/v1/profiles?member_id=eq.${restValue(session.member_id)}&select=language`
        ),
        supabaseRequest(
          `/rest/v1/follows?follower_id=eq.${restValue(session.member_id)}&status=eq.accepted&select=following_id`
        ),
        supabaseRequest(
          `/rest/v1/hestory?visitor_id=eq.${restValue(session.member_id)}&select=tmdb_id`
        ),
        supabaseRequest(
          `/rest/v1/views?viewer_id=eq.${restValue(session.member_id)}&select=tmdb_id`
        ),
      ]);
      ctx.me = mem.ok && Array.isArray(mem.data) ? mem.data[0] || null : null;
      ctx.language = String(prof.data?.[0]?.language || "").toLowerCase();
      (fol.data || []).forEach((r) => ctx.following.add(String(r.following_id)));
      [...(hist.data || []), ...(vw.data || [])].forEach((r) => ctx.watched.add(Number(r.tmdb_id)));
    }
    state.ctx = ctx;
    return ctx;
  }

  function isMine(row, ctx) {
    if (!ctx.session?.member_id) return false;
    if (row.owner_id && row.owner_id === ctx.session.member_id) return true;
    return Boolean(ctx.myUsername) && String(row.owner_username || "").toLowerCase() === ctx.myUsername;
  }

  // Only public posts, plus exclusive ones whose conditions apply to me. Private
  // posts never show up here — not even to somebody on their access list.
  function postVisibleToMe(post, ctx) {
    if (isMine(post, ctx)) return true;
    const vis = String(post.visibility || "public").toLowerCase();
    if (vis === "public") return true;
    if (vis !== "exclusive") return false;
    if (!ctx.session?.member_id || !ctx.me) return false;
    if (post.require_followers && !ctx.following.has(String(post.owner_id))) return false;
    const age = ageYears(ctx.me.birth_date);
    if (post.min_age && age != null && age < Number(post.min_age)) return false;
    if (post.max_age && age != null && age > Number(post.max_age)) return false;
    const langs = splitList(post.languages);
    if (langs.length && !langs.includes("all") && ctx.language && !langs.includes(ctx.language)) return false;
    const countries = splitList(post.countries);
    if (countries.length && !countries.includes(String(ctx.me.country || "").toLowerCase())) return false;
    const needed = [...tmdbIdsInText(post.watched_tmdb), ...tmdbIdsInText(post.titles)];
    if (needed.length && !needed.every((id) => ctx.watched.has(Number(id)))) return false;
    return true;
  }

  // Same rule for playlists: public, or exclusive with conditions that match.
  // Private lists stay out of this tab (my own lists are the exception).
  function playlistVisibleToMe(pl, ctx, accessNames) {
    if (isMine(pl, ctx)) return true;
    const vis = String(pl.visibility || "private").toLowerCase();
    if (vis === "public") return true;
    if (vis === "private") return false;
    if (vis !== "exclusive") return false;
    if (!ctx.session?.member_id) return false;
    if (pl.require_member && !ctx.session.member_id) return false;
    if (pl.require_followers && !ctx.following.has(String(pl.owner_id))) return false;
    const countries = splitList(pl.countries);
    if (countries.length && !countries.includes(String(ctx.me?.country || "").toLowerCase())) return false;
    if (pl.gender && pl.gender !== "any" && String(ctx.me?.gender || "") !== pl.gender) return false;
    if (pl.max_age) {
      const age = ageYears(ctx.me?.birth_date);
      if (age == null || age > Number(pl.max_age)) return false;
    }
    return Boolean(ctx.session?.member_id);
  }

  function visibilityChip(value) {
    const vis = String(value || "public").toLowerCase();
    const label = vis === "private" ? t("common.private") : vis === "exclusive" ? t("common.exclusive") : t("common.public");
    return `<span class="chip vis-chip vis-${escapeHtml(vis)}">${escapeHtml(label)}</span>`;
  }

  async function renderWatchTab(tab) {
    if (tab === "recommend") return renderRecommend(true);
    if (tab === "reviews") return renderReviews();
    if (tab === "playlists") return renderTitlePlaylists();
    return renderComments();
  }

  // The tab bar itself; the active panel is the only one that draws its content.
  async function renderSocialTabs() {
    const shell = $("#watch-social");
    const bar = $("#watch-tabs");
    if (!shell || !bar) return;
    shell.hidden = false;
    if (!WATCH_TABS.includes(state.watchTab)) state.watchTab = "comments";
    bar.innerHTML = WATCH_TABS.map((tab) => {
      const active = state.watchTab === tab;
      return `<button class="btn btn-sm ${active ? "btn-primary" : "btn-ghost"}" data-wtab="${tab}" type="button" role="tab" aria-selected="${active ? "true" : "false"}">${escapeHtml(tabLabel(tab))}</button>`;
    }).join("");
    WATCH_TABS.forEach((tab) => {
      const panel = $(`#panel-${tab}`);
      if (panel) panel.hidden = tab !== state.watchTab;
    });
    bar.onclick = (e) => {
      const btn = e.target.closest("[data-wtab]");
      if (!btn || btn.dataset.wtab === state.watchTab) return;
      state.watchTab = btn.dataset.wtab;
      renderSocialTabs();
    };
    await renderWatchTab(state.watchTab);
  }

  /* ---------- Reviews that mention this title ---------- */
  async function renderReviews() {
    const el = $("#watch-reviews");
    if (!el) return;
    const kind = kindLabel();
    el.innerHTML = `<p class="muted">${t("common.loading")}</p>`;
    const ctx = await viewerContext();
    const itemsRes = await supabaseRequest(
      `/rest/v1/post_items?tmdb_id=eq.${Number(mediaId)}&media_type=eq.${mediaType}&select=post_id`
    );
    const ids = [...new Set((itemsRes.data || []).map((r) => r.post_id).filter(Boolean))];
    const empty = `<p class="muted">${t("watch.noReviews", { kind })}</p>`;
    if (!ids.length) {
      el.innerHTML = empty;
      return;
    }
    const postsRes = await supabaseRequest(
      `/rest/v1/posts?post_id=in.(${ids.join(",")})&kind=eq.review&select=*&order=created_at.desc&limit=40`
    );
    const posts = (postsRes.data || []).filter(
      (p) => postVisibleToMe(p, ctx) && !ownerBlocks("updates", p.owner_id, p.owner_username)
    );
    if (!posts.length) {
      el.innerHTML = empty;
      return;
    }
    const idList = posts.map((p) => p.post_id).join(",");
    const votesRes = await supabaseRequest(
      `/rest/v1/post_votes?post_id=in.(${idList})&select=post_id,vote`
    );
    const votes = {};
    (votesRes.data || []).forEach((v) => {
      votes[v.post_id] = votes[v.post_id] || { up: 0, down: 0 };
      votes[v.post_id][v.vote] = (votes[v.post_id][v.vote] || 0) + 1;
    });
    el.innerHTML = `
      <p class="muted">${t("watch.reviewsLead", { kind })}</p>
      <div class="review-wall">${posts
        .map((p) => {
          const c = votes[p.post_id] || { up: 0, down: 0 };
          const dest = p.playlist_id
            ? `./Playlist.html?ID=${encodeURIComponent(p.playlist_id)}`
            : memberProfileHref(p.owner_username);
          return `<article class="review-wall-card" data-post="${escapeHtml(p.post_id)}">
            <div class="review-wall-head">
              <strong><a href="${memberProfileHref(p.owner_username)}">@${escapeHtml(p.owner_username || "member")}</a></strong>
              <span class="muted">${escapeHtml(commentDate(p.created_at))}</span>
              ${visibilityChip(p.visibility)}
            </div>
            <h3>${escapeHtml(p.title || "")}</h3>
            <p class="review-wall-body">${escapeHtml(p.body || "")}</p>
            ${Rich() ? Rich().reviewListsHtml(p.pros, p.cons) : ""}
            <div class="review-wall-foot">
              <span class="chip">${t("prof.recommendBtn", { n: c.up })}</span>
              <span class="chip">${t("prof.dont", { n: c.down })}</span>
              <a class="btn btn-sm btn-ghost" href="${dest}">${t("watch.openOnProfile")}</a>
            </div>
          </article>`;
        })
        .join("")}</div>`;
  }

  /* ---------- Playlists (by other members) that include this title ---------- */
  async function renderTitlePlaylists() {
    const el = $("#watch-playlists");
    if (!el) return;
    const kind = kindLabel();
    el.innerHTML = `<p class="muted">${t("common.loading")}</p>`;
    const ctx = await viewerContext();
    const itemsRes = await supabaseRequest(
      `/rest/v1/playlist_items?tmdb_id=eq.${Number(mediaId)}&media_type=eq.${mediaType}&select=playlist_id`
    );
    const ids = [...new Set((itemsRes.data || []).map((r) => r.playlist_id).filter(Boolean))];
    const empty = `<p class="muted">${t("watch.noPlaylists", { kind })}</p>`;
    if (!ids.length) {
      el.innerHTML = empty;
      return;
    }
    const [plsRes, accRes] = await Promise.all([
      supabaseRequest(
        `/rest/v1/playlists?playlist_id=in.(${ids.join(",")})&select=*&order=created_at.desc&limit=40`
      ),
      supabaseRequest(`/rest/v1/playlist_access?playlist_id=in.(${ids.join(",")})&select=playlist_id,username`),
    ]);
    const access = {};
    (accRes.data || []).forEach((a) => {
      (access[a.playlist_id] = access[a.playlist_id] || []).push(a.username);
    });
    // Only lists built by other members: my own playlists live in the dashboard.
    const rows = (plsRes.data || []).filter(
      (pl) =>
        !isMine(pl, ctx) &&
        playlistVisibleToMe(pl, ctx, access[pl.playlist_id] || []) &&
        !ownerBlocks("playlists", pl.owner_id, pl.owner_username)
    );
    if (!rows.length) {
      el.innerHTML = empty;
      return;
    }
    const counts = {};
    const cntRes = await supabaseRequest(
      `/rest/v1/playlist_items?playlist_id=in.(${rows.map((r) => r.playlist_id).join(",")})&select=playlist_id`
    );
    (cntRes.data || []).forEach((r) => {
      counts[r.playlist_id] = (counts[r.playlist_id] || 0) + 1;
    });
    el.innerHTML = `
      <p class="muted">${t("watch.playlistsLead", { kind })}</p>
      <div class="watch-playlist-list">${rows
        .map(
          (pl) => `<article class="watch-playlist-row">
            <div>
              <strong><a href="./Playlist.html?ID=${encodeURIComponent(pl.playlist_id)}">${escapeHtml(pl.name || pl.playlist_id)}</a></strong>
              <div class="muted">${escapeHtml(t("watch.by", { name: pl.owner_username || "member" }))} · ${escapeHtml(
                Number(counts[pl.playlist_id] || 0) === 1
                  ? t("watch.itemsCountOne")
                  : t("watch.itemsCount", { n: Number(counts[pl.playlist_id] || 0) })
              )}</div>
              ${pl.description ? `<p class="muted">${escapeHtml(pl.description)}</p>` : ""}
            </div>
            <div class="watch-playlist-side">
              ${visibilityChip(pl.visibility)}
              <a class="btn btn-sm btn-ghost" href="./Playlist.html?ID=${encodeURIComponent(pl.playlist_id)}">${t("watch.openPlaylist")}</a>
            </div>
          </article>`
        )
        .join("")}</div>`;
  }

  /* ---------- Recommend this title on your profile ---------- */
  const Rich = () => window.CineAuraRich;

  function kindLabel() {
    return mediaType === "tv" ? t("common.series") : t("common.movie");
  }

  function newPostId() {
    return `P${Math.floor(100000000 + Math.random() * 900000000)}`;
  }

  async function loadMyRecLists() {
    const session = getSession();
    if (!session?.member_id) return [];
    const res = await supabaseRequest(
      `/rest/v1/posts?owner_id=eq.${restValue(session.member_id)}&kind=eq.reclist&select=post_id,title&order=created_at.desc`
    );
    return res.ok && Array.isArray(res.data) ? res.data : [];
  }

  // TMDB snapshot row for public.post_items (rich columns when the schema has them).
  async function addItemRow(postId) {
    const info = await Rich().details(mediaType, mediaId);
    const row = { ...Rich().toItemRow(info), post_id: postId };
    const full = await supabaseRequest("/rest/v1/post_items", { method: "POST", body: JSON.stringify(row) });
    if (full.ok) return true;
    const base = await supabaseRequest("/rest/v1/post_items", {
      method: "POST",
      body: JSON.stringify(Rich().baseItemRow(row)),
    });
    return base.ok;
  }

  // Publishes a recommendation / recommendation-list post on the member profile.
  async function publishRecPost(kind, title, body) {
    const session = getSession();
    if (!(await window.CineAura.guardFeature("posts"))) return { ok: false, blocked: true };
    const postId = newPostId();
    const saved = await supabaseRequest("/rest/v1/posts", {
      method: "POST",
      body: JSON.stringify({
        post_id: postId,
        owner_id: session.member_id,
        owner_username: session.username,
        kind,
        title,
        body,
        visibility: "public",
      }),
    });
    if (!saved.ok) {
      toast(t("watch.rec.fail"));
      return { ok: false };
    }
    const added = await addItemRow(postId);
    await supabaseRequest("/rest/v1/updates", {
      method: "POST",
      body: JSON.stringify({
        actor_id: session.member_id,
        actor_username: session.username,
        kind: "post",
        post_id: postId,
      }),
    });
    await window.CineAura.notifyFollowers({
      ownerId: session.member_id,
      username: session.username,
      title: t("prof.newPost"),
      body: t("prof.updLinePost", {
        actor: `@${session.username}`,
        noun: kind === "reclist" ? t("prof.updNounRecList") : t("prof.updNounRec"),
        post: `«${title}»`,
      }),
      href: window.CineAura.profileHref(session.username),
      visibility: "public",
    });
    return { ok: true, postId, added };
  }

  /* --- Popup layer: the three options are buttons, their fields are inside --- */
  const REC_TITLES = {
    post: "watch.rec.tabPost",
    list: "watch.rec.tabList",
    existing: "watch.rec.tabExisting",
  };

  const REC_ACTIONS = (go) => `
      <div class="rec-modal-actions">
        <button class="btn btn-sm btn-primary" type="button" id="rec-go">${go}</button>
        <button class="btn btn-sm btn-ghost" type="button" id="rec-cancel">${t("common.cancel")}</button>
      </div>`;

  function closeRecModal() {
    document.removeEventListener("keydown", onRecModalKey);
    $("#rec-modal")?.remove();
  }

  function onRecModalKey(e) {
    if (e.key === "Escape") closeRecModal();
  }

  /* --- What other members recommend about this title --- */
  // Public recommendations, plus exclusive ones whose conditions apply to me,
  // that carry this title — recommended on its own or held in a recommendation
  // list. Private posts stay out, exactly like the Reviews tab.
  async function titleRecommendations() {
    try {
      const ctx = await viewerContext();
      const hitRes = await supabaseRequest(
        `/rest/v1/post_items?tmdb_id=eq.${Number(mediaId)}&media_type=eq.${mediaType}&select=post_id`
      );
      const hits = Array.isArray(hitRes.data) ? hitRes.data : [];
      const ids = [...new Set(hits.map((r) => r.post_id).filter(Boolean))];
      if (!ids.length) return [];
      const postsRes = await supabaseRequest(
        `/rest/v1/posts?post_id=in.(${ids.join(",")})&kind=in.(recommendation,reclist)&select=*&order=created_at.desc&limit=60`
      );
      const posts = (Array.isArray(postsRes.data) ? postsRes.data : []).filter(
        (p) => postVisibleToMe(p, ctx) && !ownerBlocks("updates", p.owner_id, p.owner_username)
      );
      if (!posts.length) return [];
      const list = posts.map((p) => p.post_id).join(",");
      const [itemsRes, votesRes] = await Promise.all([
        supabaseRequest(
          `/rest/v1/post_items?post_id=in.(${list})&select=post_id,tmdb_id,media_type,title,poster_path&order=id.asc`
        ),
        supabaseRequest(`/rest/v1/post_votes?post_id=in.(${list})&select=post_id,vote`),
      ]);
      const items = {};
      (Array.isArray(itemsRes.data) ? itemsRes.data : []).forEach((r) => {
        (items[r.post_id] = items[r.post_id] || []).push(r);
      });
      const ups = {};
      (Array.isArray(votesRes.data) ? votesRes.data : []).forEach((v) => {
        if (v.vote !== "up") return;
        ups[v.post_id] = (ups[v.post_id] || 0) + 1;
      });
      return posts.map((p) => ({
        post: p,
        items: items[p.post_id] || [],
        up: ups[p.post_id] || 0,
      }));
    } catch {
      return [];
    }
  }

  // Poster strip: the other titles a recommendation (list) holds, so the card
  // shows what this title was recommended next to.
  function recOthersHtml(items) {
    const others = (items || []).filter((it) => Number(it.tmdb_id) !== Number(mediaId));
    if (!others.length) return "";
    const shown = others.slice(0, 8);
    const rest = others.length - shown.length;
    return `<div class="rec-others">
      <span class="rec-others-label">${t("watch.rec.moreTitles")}</span>
      <div class="rec-others-row">${shown
        .map((it) => {
          const src = photo(it.poster_path, it.title || "");
          // A post can also hold a person; that one opens the Cast page.
          const href =
            it.media_type === "person"
              ? personHref(it.tmdb_id)
              : watchHref(it.media_type === "tv" ? "tv" : "movie", it.tmdb_id, null, null, "");
          return `<a class="rec-thumb" href="${href}" title="${escapeHtml(it.title || "")}"><img src="${escapeHtml(src)}" alt="" loading="lazy" /></a>`;
        })
        .join("")}${rest > 0 ? `<span class="rec-others-more">+${rest}</span>` : ""}</div>
    </div>`;
  }

  function recCardHtml(entry) {
    const p = entry.post;
    const items = entry.items || [];
    const isList = p.kind === "reclist";
    const dest = memberProfileHref(p.owner_username);
    const count = items.length;
    return `<article class="review-wall-card rec-card" data-post="${escapeHtml(p.post_id)}">
      <div class="review-wall-head">
        <strong><a href="${dest}">@${escapeHtml(p.owner_username || "member")}</a></strong>
        <span class="muted">${escapeHtml(commentDate(p.created_at))}</span>
        <span class="chip">${escapeHtml(isList ? t("prof.recList") : t("prof.recs"))}</span>
        ${visibilityChip(p.visibility)}
      </div>
      <h3>${escapeHtml(p.title || "")}</h3>
      <p class="review-wall-body">${escapeHtml(p.body || "")}</p>
      ${recOthersHtml(items)}
      <div class="review-wall-foot">
        <span class="chip">${t("prof.recommendBtn", { n: entry.up })}</span>
        ${count ? `<span class="chip">${escapeHtml(count === 1 ? t("watch.itemsCountOne") : t("watch.itemsCount", { n: count }))}</span>` : ""}
        <a class="btn btn-sm btn-ghost" href="${dest}">${t("watch.openOnProfile")}</a>
      </div>
    </article>`;
  }

  // The wall itself: every recommendation of this title the viewer may read.
  async function recWallHtml() {
    const kind = kindLabel();
    const head = `<h3 class="rec-wall-title">${t("watch.rec.wallTitle")}</h3>
      <p class="muted">${t("watch.rec.wallLead", { kind })}</p>`;
    const entries = await titleRecommendations();
    if (!entries.length) {
      return `<div class="rec-wall">${head}<p class="muted">${t("watch.rec.none", { kind })}</p></div>`;
    }
    return `<div class="rec-wall">${head}<div class="review-wall">${entries.map(recCardHtml).join("")}</div></div>`;
  }

  // The tab: publish a recommendation of my own, and read the ones members
  // already made about this title.
  // embedded = true when the panel lives inside a tab (the tab already names it,
  // so the repeated eyebrow + heading are dropped).
  async function renderRecommend(embedded = false) {
    const el = $("#watch-recommend");
    if (!el || !state.detail) return;
    el.hidden = false;
    const d = state.detail;
    const title = d.title || d.name || "";
    const kind = kindLabel();
    const session = getSession();
    const head = embedded
      ? ""
      : `<span class="eyebrow">${t("watch.rec.eyebrow")}</span>
        <h2>${t("watch.rec.title", { kind })}</h2>`;
    let publish;
    if (!session?.member_id) {
      publish = `<p class="muted">${t("watch.rec.signIn", { kind })}</p>
        <a class="btn btn-sm btn-primary" href="./login.html">${t("common.signin")}</a>`;
    } else if (!window.CineAuraRich) {
      publish = `<p class="muted">${t("watch.rec.fail")}</p>`;
    } else {
      const myProfile = window.CineAura.profileHref(session.username);
      const done = state.recDone
        ? `<p class="rec-done">✓ ${escapeHtml(state.recDone)} <a href="${escapeHtml(myProfile)}">${t("watch.rec.viewProfile")}</a></p>`
        : "";
      publish = `<p class="muted">${t("watch.rec.lead", { title: escapeHtml(title), kind })}</p>
        <div class="rec-buttons">
          <button class="btn btn-sm btn-ghost" type="button" data-rec-open="post">${t("watch.rec.tabPost")}</button>
          <button class="btn btn-sm btn-ghost" type="button" data-rec-open="list">${t("watch.rec.tabList")}</button>
          <button class="btn btn-sm btn-ghost" type="button" data-rec-open="existing">${t("watch.rec.tabExisting")}</button>
        </div>
        ${done}
        <p class="muted rec-hint">${t("watch.rec.pick")}</p>`;
    }
    // The buttons need no network, the wall does: draw them first, then fill the
    // slot under them when the recommendations arrive.
    el.innerHTML = `${head}<div class="rec-publish">${publish}</div><div class="rec-wall-slot"><p class="muted">${t("common.loading")}</p></div>`;
    el.querySelectorAll("[data-rec-open]").forEach((b) => {
      b.onclick = () => openRecModal(b.dataset.recOpen);
    });
    const token = (state.recToken = (state.recToken || 0) + 1);
    const wall = await recWallHtml();
    // A newer render (tab switch, new episode) may have taken over meanwhile.
    if (state.recToken !== token) return;
    const slot = el.querySelector(".rec-wall-slot");
    if (slot) slot.innerHTML = wall;
  }

  // Popup shell shared by the three options; each one draws its fields into
  // #rec-body, so the watch page itself keeps nothing but the buttons.
  function recModal(head, sub) {
    closeRecModal();
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "rec-modal";
    overlay.innerHTML = `
      <section class="glass modal-card rec-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(head)}">
        <header class="rec-modal-head">
          <div>
            <span class="eyebrow">${t("watch.rec.eyebrow")}</span>
            <h2>${escapeHtml(head)}</h2>
          </div>
          <button class="rec-modal-x" type="button" id="rec-x" aria-label="${t("common.close")}">&times;</button>
        </header>
        <p class="rec-modal-sub">${sub}</p>
        <div class="stack rec-form" id="rec-body">
          <p class="muted">${t("common.loading")}</p>
        </div>
      </section>`;
    document.body.appendChild(overlay);
    // Delegated: the form (and its Cancel button) is drawn right after the shell.
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay || e.target.closest("#rec-x") || e.target.closest("#rec-cancel")) closeRecModal();
    });
    document.addEventListener("keydown", onRecModalKey);
  }

  function openRecModal(kind) {
    const d = state.detail || {};
    const title = d.title || d.name || "";
    const head = t(REC_TITLES[kind] || REC_TITLES.post);
    const sub = `<span class="chip">${escapeHtml(kindLabel())}</span> <strong>${escapeHtml(title)}</strong>`;
    recModal(head, sub);
    if (kind === "list") drawRecListForm();
    else if (kind === "existing") drawRecExistingForm();
    else drawRecPostForm(title);
  }

  /* --- Publish a recommendation on my profile --- */
  function drawRecPostForm(title) {
    const body = $("#rec-body");
    body.innerHTML = `
      <label class="field-label" for="rec-title">${t("prof.postTitle")}</label>
      <input id="rec-title" value="${escapeHtml(title)}" />
      <label class="field-label" for="rec-text">${t("rich.textLabel")}</label>
      <textarea id="rec-text" rows="4" placeholder="${t("watch.rec.textPh")}"></textarea>
      ${REC_ACTIONS(t("watch.rec.publish"))}`;
    // The title is already filled in, so the cursor goes where typing is needed.
    $("#rec-text").focus();
    $("#rec-go").onclick = async (e) => {
      const head = $("#rec-title").value.trim();
      const text = $("#rec-text").value.trim();
      if (!head || !text) return toast(t("watch.rec.needText"));
      const btn = e.currentTarget;
      btn.disabled = true;
      const res = await publishRecPost("recommendation", head, text);
      btn.disabled = false;
      if (!res.ok) return;
      state.recDone = res.added ? t("watch.rec.published") : t("watch.rec.publishedNoItem");
      closeRecModal();
      renderWatchTab("recommend");
    };
  }

  /* --- New recommendation list, filled with this title --- */
  function drawRecListForm() {
    const body = $("#rec-body");
    body.innerHTML = `
      <label class="field-label" for="rec-list-name">${t("watch.rec.listName")}</label>
      <input id="rec-list-name" placeholder="${t("watch.rec.listNamePh")}" />
      <label class="field-label" for="rec-list-text">${t("watch.rec.listText")}</label>
      <textarea id="rec-list-text" rows="3" placeholder="${t("watch.rec.listTextPh")}"></textarea>
      <label class="field-label" for="rec-list-type">${t("watch.rec.listType")}</label>
      <select id="rec-list-type">
        <option value="movie"${mediaType === "movie" ? " selected" : ""}>${t("common.movie")}</option>
        <option value="tv"${mediaType === "tv" ? " selected" : ""}>${t("common.series")}</option>
      </select>
      <p class="muted">${t("watch.rec.typeHint", { kind: kindLabel() })}</p>
      ${REC_ACTIONS(t("watch.rec.createList", { kind: kindLabel() }))}`;
    $("#rec-list-name").focus();
    $("#rec-go").onclick = async (e) => {
      const name = $("#rec-list-name").value.trim();
      const text = $("#rec-list-text").value.trim();
      const type = $("#rec-list-type").value;
      if (!name || !text) return toast(t("watch.rec.needName"));
      if (type !== mediaType) {
        return toast(
          t("watch.rec.typeMismatch", {
            want: type === "tv" ? t("common.series") : t("common.movie"),
            have: kindLabel(),
          })
        );
      }
      const btn = e.currentTarget;
      btn.disabled = true;
      const res = await publishRecPost("reclist", name, text);
      btn.disabled = false;
      if (!res.ok) return;
      toast(t("watch.rec.listCreated"));
      state.recDone = t("watch.rec.listCreatedNamed", { list: name });
      closeRecModal();
      renderWatchTab("recommend");
    };
  }

  /* --- Add this title to a list that already exists --- */
  async function drawRecExistingForm() {
    const lists = await loadMyRecLists();
    const body = $("#rec-body");
    // The lists arrive after a request: skip the redraw if the popup was closed.
    if (!body) return;
    if (!lists.length) {
      body.innerHTML = `
        <p class="muted">${t("watch.rec.noLists")}</p>
        ${REC_ACTIONS(t("watch.rec.tabList"))}`;
      $("#rec-go").onclick = () => drawRecListForm();
      return;
    }
    body.innerHTML = `
      <label class="field-label" for="rec-pick">${t("watch.rec.pickList")}</label>
      <select id="rec-pick">
        ${lists
          .map((p) => `<option value="${escapeHtml(p.post_id)}">${escapeHtml(p.title || p.post_id)}</option>`)
          .join("")}
      </select>
      <p class="muted">${t("watch.addList")}</p>
      ${REC_ACTIONS(t("watch.addTo"))}`;
    $("#rec-go").onclick = async (e) => {
      const picked = $("#rec-pick").value;
      if (!picked) return;
      if (!(await window.CineAura.guardFeature("posts"))) return;
      const dup = await supabaseRequest(
        `/rest/v1/post_items?post_id=eq.${restValue(picked)}&tmdb_id=eq.${Number(mediaId)}&select=id`
      );
      if (dup.ok && dup.data?.[0]) return toast(t("watch.rec.already"));
      const btn = e.currentTarget;
      btn.disabled = true;
      const ok = await addItemRow(picked);
      btn.disabled = false;
      if (!ok) return toast(t("watch.rec.fail"));
      const name = lists.find((p) => p.post_id === picked)?.title || "";
      state.recDone = t("watch.rec.addedTo", { list: name });
      toast(t("watch.rec.added"));
      closeRecModal();
      renderWatchTab("recommend");
    };
  }

  const REPORT_SUBJECTS = [
    { id: "misleading", labelKey: "watch.rpt.misleading", hintKey: "watch.hint.misleading" },
    { id: "broken", labelKey: "watch.rpt.broken", hintKey: "watch.hint.broken" },
    { id: "malicious", labelKey: "watch.rpt.malicious", hintKey: "watch.hint.malicious" },
    { id: "stolen", labelKey: "watch.rpt.stolen", hintKey: "watch.hint.stolen" },
    { id: "bad", labelKey: "watch.rpt.bad", hintKey: "watch.hint.bad" },
    { id: "indirect", labelKey: "watch.rpt.indirect", hintKey: "watch.hint.indirect" },
  ];

  function closeReportModal() {
    $("#report-overlay")?.remove();
  }

  async function banLinkIfNeeded(watchUrl) {
    const count = await supabaseRequest(
      `/rest/v1/reportlinks?tmdb_id=eq.${Number(mediaId)}&watch_url=eq.${restValue(watchUrl)}&verdict=eq.valid&select=id`
    );
    const n = count.ok && Array.isArray(count.data) ? count.data.length : 0;
    if (n < 10) return n;
    const table = mediaType === "tv" ? "tvlink" : "movielink";
    await supabaseRequest(
      `/rest/v1/${table}?tmdb_id=eq.${Number(mediaId)}&watch_url=eq.${restValue(watchUrl)}`,
      { method: "PATCH", body: JSON.stringify({ banned: true }) }
    );
    return n;
  }

  async function submitLinkReport(row, subject) {
    const session = getSession();
    if (!session?.member_id) {
      toast(t("watch.signReport"));
      return false;
    }
    if (featureBlocked("reports")) {
      toast(t("panel.featBlockedMsg", { feature: t("panel.feat.reports") }));
      return false;
    }
    if (row.member_id === session.member_id) {
      toast(t("watch.ownReport"));
      return false;
    }
    const dup = await supabaseRequest(
      `/rest/v1/reportlinks?reporter_id=eq.${restValue(session.member_id)}&tmdb_id=eq.${Number(mediaId)}&watch_url=eq.${restValue(row.watch_url)}&select=id`
    );
    if (dup.ok && dup.data?.[0]) {
      toast(t("watch.alreadyRpt"));
      return false;
    }
    const now = new Date().toISOString();
    const saved = await supabaseRequest("/rest/v1/reportlinks", {
      method: "POST",
      body: JSON.stringify({
        reported_at: now,
        subject,
        watch_url: row.watch_url,
        media_type: mediaType,
        tmdb_id: Number(mediaId),
        owner_id: row.member_id,
        verdict: "valid",
        verdict_at: now,
        reporter_id: session.member_id,
        link_id: row.id || null,
      }),
    });
    if (!saved.ok) {
      toast(t("watch.rptFail"));
      return false;
    }
    const n = await banLinkIfNeeded(row.watch_url);
    toast(n >= 10 ? t("watch.rptHidden") : t("watch.rptOk"));
    return true;
  }

  function openReportModal(row) {
    closeReportModal();
    const session = getSession();
    if (!session?.member_id) {
      toast(t("watch.signReport"));
      return;
    }
    if (row.member_id === session.member_id) {
      toast(t("watch.ownReport"));
      return;
    }
    const overlay = document.createElement("div");
    overlay.className = "report-overlay";
    overlay.id = "report-overlay";
    overlay.innerHTML = `
      <section class="glass report-card">
        <span class="eyebrow">${t("watch.report")}</span>
        <h2>${t("watch.why")}</h2>
        <p class="muted">${escapeHtml(linkHost(row.watch_url))} · @${escapeHtml(row.username || "member")}</p>
        <select id="report-subject">
          ${REPORT_SUBJECTS.map((s) => `<option value="${s.id}">${escapeHtml(t(s.labelKey))} — ${escapeHtml(t(s.hintKey))}</option>`).join("")}
        </select>
        <div class="link-actions">
          <button class="btn btn-sm btn-primary" id="report-send" type="button">${t("watch.submitRpt")}</button>
          <button class="btn btn-sm btn-ghost" id="report-cancel" type="button">${t("common.cancel")}</button>
        </div>
      </section>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeReportModal();
    });
    $("#report-cancel").onclick = closeReportModal;
    $("#report-send").onclick = async () => {
      const ok = await submitLinkReport(row, $("#report-subject").value);
      if (ok) {
        closeReportModal();
        renderSources();
      }
    };
  }

  /* --- Publishing a watch link from the watch page ---
     The "+" beside the link list opens this popup. Title, season and episode come
     from the page, so a member only describes the source: the URL, the quality,
     the original language, the subtitles (and in which languages) and whether the
     source plays ads. The row lands in movielink / tvlink — the same tables the
     dashboard form writes to, with the same values (see common.js). */
  function addLinkContext() {
    const d = state.detail || {};
    const title = d.title || d.name || `TMDB ${mediaId}`;
    const ep =
      mediaType === "tv"
        ? ` · S${String(state.season).padStart(2, "0")}E${String(state.episode).padStart(2, "0")}`
        : "";
    const who = getSession()?.username ? ` · @${getSession().username}` : "";
    return `${escapeHtml(title)}${ep}${escapeHtml(who)}`;
  }

  function closeAddLinkModal() {
    document.removeEventListener("keydown", onAddLinkKey);
    $("#addlink-overlay")?.remove();
  }

  function onAddLinkKey(e) {
    if (e.key === "Escape") closeAddLinkModal();
  }

  function openAddLinkModal() {
    const session = getSession();
    if (!session?.member_id) {
      toast(t("watch.al.sign"));
      return;
    }
    if (featureBlocked("links")) {
      toast(t("panel.featBlockedMsg", { feature: t("panel.feat.links") }));
      return;
    }
    closeAddLinkModal();
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "addlink-overlay";
    overlay.innerHTML = `
      <section class="glass modal-card addlink-card" role="dialog" aria-modal="true" aria-labelledby="addlink-title">
        <header class="addlink-head">
          <div>
            <span class="eyebrow">${t("watch.links")}</span>
            <h2 id="addlink-title">${t("watch.al.title")}</h2>
          </div>
          <button class="rec-modal-x" type="button" id="addlink-x" aria-label="${escapeHtml(t("common.close"))}">&times;</button>
        </header>
        <p class="addlink-sub">${addLinkContext()}</p>
        <p class="addlink-lead">${t("watch.al.lead")}</p>
        <div class="addlink-form">
          <!-- One form publishes both kinds: a source to watch in the player, or
               a file to download. The kind is what puts the row in its rail. -->
          <div class="addlink-kinds" role="radiogroup" aria-label="${escapeHtml(t("watch.al.kind"))}">
            <label class="kind-pick">
              <input type="radio" name="al-kind" value="watch" checked />
              <span>${t("watch.al.kindWatch")}</span>
            </label>
            <label class="kind-pick">
              <input type="radio" name="al-kind" value="download" />
              <span>${t("watch.al.kindDownload")}</span>
            </label>
            <label class="kind-pick">
              <input type="radio" name="al-kind" value="both" />
              <span>${t("watch.al.kindBoth")}</span>
            </label>
          </div>
          <p class="addlink-note" id="al-kind-note" hidden>${t("watch.al.dlNote")}</p>
          <label class="addlink-field">
            <span id="al-url-label">${t("watch.al.url")}</span>
            <input id="al-url" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://example.com/watch/12345" />
          </label>
          <div class="addlink-field">
            <span>${t("watch.al.quality")}</span>
            <p class="muted addlink-hint">${t("watch.qualityHint")}</p>
            <div class="lang-picker" id="al-q-box">${qualityPickerHtml("al-q")}</div>
          </div>
          <div class="addlink-row">
            <label class="addlink-field">
              <span>${t("common.origLang")}</span>
              <select id="al-lang">
                <option value="">${t("common.origLang")}</option>
                ${linkLanguageOptions()}
              </select>
            </label>
            <label class="addlink-field">
              <span>${t("watch.urlField")}</span>
              <select id="al-urlvis">
                <option value="show">${t("watch.urlShow")}</option>
                <option value="hide">${t("watch.urlHide")}</option>
              </select>
            </label>
          </div>
          <div class="addlink-row">
            <label class="addlink-field">
              <span>${t("common.subs")}</span>
              <select id="al-subs">
                <option value="no">${t("common.notAvailable")}</option>
                <option value="yes">${t("common.available")}</option>
              </select>
            </label>
            <label class="addlink-field">
              <span>${t("common.ads")}</span>
              <select id="al-ads">
                <option value="no">${t("common.adsNo")}</option>
                <option value="yes">${t("common.adsYes")}</option>
              </select>
            </label>
          </div>
          <div class="addlink-subs" id="al-sub-box" hidden>
            <p class="muted">${t("dash.subsHint")}</p>
            <div class="lang-picker">${langPickerHtml("al-sub")}</div>
          </div>
          <div class="link-actions">
            <button class="btn btn-primary" id="al-save" type="button">${t("watch.al.save")}</button>
            <button class="btn btn-ghost" id="al-cancel" type="button">${t("common.cancel")}</button>
          </div>
        </div>
      </section>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeAddLinkModal();
    });
    document.addEventListener("keydown", onAddLinkKey);
    $("#addlink-x").onclick = closeAddLinkModal;
    $("#al-cancel").onclick = closeAddLinkModal;
    $("#al-subs").onchange = (e) => {
      $("#al-sub-box").hidden = e.target.value !== "yes";
    };
    $$('input[name="al-kind"]').forEach((el) => {
      el.onchange = () => {
        if (!el.checked) return;
        const download = el.value !== "watch";
        const both = el.value === "both";
        $("#al-kind-note").hidden = !download;
        const label = $("#al-url-label");
        if (label) {
          label.textContent = both ? t("watch.al.urlBoth") : download ? t("watch.al.urlDl") : t("watch.al.url");
        }
      };
    });
    bindLangPicker("al-sub");
    $("#al-save").onclick = submitNewLink;
    $("#al-url").focus();
  }

  async function submitNewLink() {
    const session = getSession();
    if (!session?.member_id) {
      toast(t("watch.al.sign"));
      closeAddLinkModal();
      return;
    }
    const watchUrl = $("#al-url").value.trim();
    const quality = selectedQualities("al-q");
    const urlHidden = $("#al-urlvis")?.value === "hide";
    const originalLanguage = $("#al-lang").value;
    const hasSubtitles = $("#al-subs").value === "yes";
    const hasAds = $("#al-ads").value === "yes";
    const kind = $('input[name="al-kind"]:checked')?.value || "watch";
    if (!validWatchUrl(watchUrl)) return toast(t("dash.needUrl"));
    if (!quality) return toast(t("dash.needQuality"));
    if (!originalLanguage) return toast(t("dash.needLang"));
    let subtitleLanguages = "";
    if (hasSubtitles) {
      subtitleLanguages = selectedLangs("al-sub");
      if (!subtitleLanguages) return toast(t("dash.needSubs"));
    }

    const d = state.detail || {};
    const table = mediaType === "tv" ? "tvlink" : "movielink";
    const row = {
      tmdb_id: Number(mediaId),
      member_id: session.member_id,
      username: session.username || "",
      watch_url: watchUrl,
      title: d.title || d.name || "",
      quality,
      original_language: originalLanguage,
      has_subtitles: hasSubtitles,
      subtitle_languages: subtitleLanguages,
      has_ads: hasAds,
      url_hidden: urlHidden,
      link_kind: kind,
    };
    if (mediaType === "tv") {
      row.season = Number(state.season);
      row.episode = Number(state.episode);
    }

    const button = $("#al-save");
    button.disabled = true;
    // One row per chosen kind: watch (opens in the player), download (opens on
    // its own site) or both at once. A kind this URL already has is skipped.
    const result = await publishWatchLink(table, row, [kind]);
    button.disabled = false;
    if (!result.ok) {
      if (!result.error) return toast(t("dash.dupUrl"));
      const raw = JSON.stringify(result.error.data || {});
      if (/duplicate|23505/i.test(raw)) return toast(t("dash.dupUrl"));
      // The link_kind / clicks columns come from the newest sql/links.sql.
      if (/link_kind/i.test(raw)) return toast(t("watch.missingKind"));
      return toast(t("dash.linkFail"));
    }
    closeAddLinkModal();
    if (result.added.length > 1) toast(t("dash.linkSavedBoth"));
    else if (result.skipped.length) toast(t("dash.linkSavedDupKind"));
    else toast(t("dash.linkSaved"));
    renderSources();
  }

  /* --- Where to watch: the platforms TMDB lists for this title -------------
     TMDB answers per country, so the region select follows the country the
     visitor picked in Site Settings or the one their IP resolved to. Quality is
     not part of TMDB's answer: when a member published a link for the same
     platform, that link's quality is shown next to the logo instead. */
  const PROVIDER_KINDS = [
    ["flatrate", "watch.prov.sub"],
    ["free", "watch.prov.free"],
    ["ads", "watch.prov.ads"],
    ["rent", "watch.prov.rent"],
    ["buy", "watch.prov.buy"],
  ];

  // The offers TMDB's watch page reports, keyed the way the API keys platforms.
  const OFFER_KIND_KEY = {
    flatrate: "watch.prov.sub",
    free: "watch.prov.free",
    ads: "watch.prov.ads",
    rent: "watch.prov.rent",
    buy: "watch.prov.buy",
    cinema: "watch.provCinema",
  };
  const QUALITY_ORDER = ["4K", "HD", "SD"];

  function regionLabel(cc) {
    return countryName(cc) || String(cc || "");
  }

  // Countries TMDB actually lists a platform for, the visitor's own first.
  function providerRegions() {
    const results = state.providers || {};
    const mine = currentCountry() || "";
    const found = Object.keys(results).filter((cc) =>
      PROVIDER_KINDS.some(([kind]) => Array.isArray(results[cc]?.[kind]) && results[cc][kind].length)
    );
    return found.sort((a, b) => {
      if (a === mine) return -1;
      if (b === mine) return 1;
      return regionLabel(a).localeCompare(regionLabel(b), getLocale());
    });
  }

  function pickProviderRegion(cc) {
    const regions = providerRegions();
    if (!regions.length) return "";
    if (cc && regions.includes(cc)) return cc;
    if (regions.includes("US")) return "US";
    return regions[0];
  }

  // The prices/qualities belong to one region: never mix them into another.
  function offersPayload(region) {
    return state.offersRegion === region ? state.providerOffers : null;
  }

  function offerIndex(region) {
    const payload = offersPayload(region);
    const byId = new Map();
    const byName = new Map();
    (payload?.providers || []).forEach((card) => {
      if (card.provider_id !== null && card.provider_id !== undefined) byId.set(String(card.provider_id), card);
      if (card.name) byName.set(String(card.name).toLowerCase(), card);
    });
    return { payload, byId, byName };
  }

  function cardFor(index, row) {
    return (
      index.byId.get(String(row.provider_id)) ||
      index.byName.get(String(row.provider_name || "").toLowerCase()) ||
      null
    );
  }

  // Which offers a tab lets through. TMDB's own default is the best price.
  function visibleOffers(card) {
    const list = card?.offers || [];
    const mode = state.providerQuality;
    if (!mode || mode === "best_price") {
      const best = list.filter((o) => o.best_price);
      return best.length ? best : list;
    }
    return list.filter((o) => String(o.quality || "").toLowerCase() === mode);
  }

  function langLabel(code) {
    const key = String(code || "").toLowerCase();
    return UI_LANG_NAME[key] || key;
  }

  // Best quality a member published per platform name ("youtube.com" → YouTube).
  function platformQuality() {
    const best = new Map();
    (state.linkRows || []).forEach((row) => {
      const name = linkHostName(row.watch_url).toLowerCase();
      if (!name) return;
      const rank = qualityRank(row.quality);
      if (rank && rank > (best.get(name)?.rank || 0)) best.set(name, { rank, label: qualityList(row.quality).slice(-1)[0] || row.quality });
    });
    return best;
  }

  function offerRowHtml(offer) {
    const kindKey = OFFER_KIND_KEY[offer.kind] || "";
    const langs = [];
    if (offer.audio) langs.push(t("watch.provAudio", { lang: langLabel(offer.audio) }));
    if (offer.subtitles) langs.push(t("watch.provSubs", { lang: langLabel(offer.subtitles) }));
    return `
              <span class="offer-row${offer.best_price ? " is-best" : ""}">
                ${kindKey ? `<span class="chip">${escapeHtml(t(kindKey))}</span>` : ""}
                ${offer.quality ? `<span class="chip chip-quality">${escapeHtml(offer.quality)}</span>` : ""}
                ${offer.price_text ? `<span class="chip chip-price">${escapeHtml(offer.price_text)}</span>` : ""}
                ${langs.map((label) => `<span class="chip chip-soft">${escapeHtml(label)}</span>`).join("")}
                ${
                  offer.url
                    ? `<a class="offer-link" href="${escapeHtml(offer.url)}" target="_blank" rel="noopener">${escapeHtml(t("watch.provOpenPlatform"))}</a>`
                    : ""
                }
              </span>`;
  }

  function providerRows(region) {
    const entry = state.providers?.[region] || {};
    const link = String(entry.link || "");
    const index = offerIndex(region);
    const byId = new Map();
    PROVIDER_KINDS.forEach(([kind, key]) => {
      const list = Array.isArray(entry[kind]) ? entry[kind] : [];
      list.forEach((p) => {
        const id = p?.provider_id ?? p?.provider_name ?? "";
        const hit =
          byId.get(id) ||
          { provider_id: p?.provider_id ?? null, provider_name: p.provider_name, logo_path: p.logo_path || "", kinds: [], priority: Number(p.display_priority ?? 999) };
        if (!hit.kinds.includes(key)) hit.kinds.push(key);
        if (!hit.logo_path && p.logo_path) hit.logo_path = p.logo_path;
        hit.priority = Math.min(hit.priority, Number(p.display_priority ?? 999));
        byId.set(id, hit);
      });
    });
    const quality = platformQuality();
    const rows = [...byId.values()]
      .sort((a, b) => a.priority - b.priority || String(a.provider_name).localeCompare(String(b.provider_name)))
      .map((row) => {
        const card = cardFor(index, row);
        return { ...row, card, offers: visibleOffers(card), allQualities: card?.qualities || [] };
      })
      // A quality tab keeps only the platforms that really offer it. On the best
      // price tab a platform TMDB's page does not detail stays, without a price.
      .filter((row) =>
        !index.payload || (state.providerQuality === "best_price" ? !row.card || row.offers.length : row.offers.length)
      );
    if (!rows.length) {
      return `<p class="muted">${
        index.payload && state.providerQuality !== "best_price"
          ? t("watch.provNoQualityTab", { quality: escapeHtml(String(state.providerQuality).toUpperCase()) })
          : t("watch.noProvidersRegion")
      }</p>`;
    }
    return rows
      .map((p) => {
        const name = String(p.provider_name || "");
        const logo = p.card?.logo || (p.logo_path ? imgUrl(p.logo_path, "original") : "");
        const offers = p.offers;
        const known = quality.get(name.toLowerCase());
        const qualities = p.allQualities.length
          ? QUALITY_ORDER.filter((q) => p.allQualities.includes(q))
          : offers.length
            ? QUALITY_ORDER.filter((q) => offers.some((o) => o.quality === q))
            : [];
        const cheapest = offers
          .filter((o) => o.price_text && (o.price || 0) > 0)
          .sort((a, b) => (a.price || 0) - (b.price || 0))[0];
        const qualityText = qualities.length
          ? qualities.join(" · ")
          : known
            ? known.label
            : t("watch.provNoQuality");
        const platformUrl = offers.find((o) => o.url)?.url || "";
        return `
          <article class="provider-row${p.card ? " has-offers" : ""}" data-quality="${escapeHtml(
            (p.allQualities.length ? p.allQualities : qualities).join(" ").toLowerCase()
          )}">
            ${
              logo
                ? `<img class="provider-logo" src="${escapeHtml(logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-name="${escapeHtml(name)}" />`
                : `<span class="provider-logo provider-logo-mono" aria-hidden="true">${escapeHtml(name.slice(0, 1).toUpperCase())}</span>`
            }
            <div class="provider-body">
              <strong>${escapeHtml(name)}</strong>
              <div class="muted">${escapeHtml(t("watch.provSource"))} · ${escapeHtml(regionLabel(region))}</div>
              ${offers.length ? `<div class="provider-offers">${offers.map(offerRowHtml).join("")}</div>` : ""}
            </div>
            <div class="link-tags">
              ${p.kinds.map((key) => `<span class="chip">${escapeHtml(t(key))}</span>`).join("")}
              <span class="chip ${qualities.length || known ? "" : "chip-soft"}" title="${escapeHtml(t("common.quality"))}">${escapeHtml(qualityText)}</span>
              ${
                cheapest
                  ? `<span class="chip chip-price" title="${escapeHtml(t("watch.provFrom", { price: cheapest.price_text }))}">${escapeHtml(
                      t("watch.provFrom", { price: cheapest.price_text })
                    )}</span>`
                  : offers.length
                    ? `<span class="chip chip-soft">${escapeHtml(t("watch.provNoPrice"))}</span>`
                    : ""
              }
            </div>
            <div class="link-actions">
              ${
                platformUrl
                  ? `<a class="btn btn-sm btn-primary" href="${escapeHtml(platformUrl)}" target="_blank" rel="noopener">${escapeHtml(t("watch.provOpenPlatform"))}</a>`
                  : ""
              }
              ${
                link
                  ? `<a class="btn btn-sm btn-ghost" href="${escapeHtml(link)}" target="_blank" rel="noopener">${escapeHtml(t("watch.openTmdb"))}</a>`
                  : ""
              }
            </div>
          </article>`;
      })
      .join("");
  }

  // The same tabs TMDB offers: best price first, then every quality it found.
  function providerTabs(region) {
    const payload = offersPayload(region);
    if (!payload) return "";
    const filters = (payload.filters || []).filter((f) => f && f.id);
    const tabs = filters.length
      ? filters.map((f) => ({ id: f.id, label: f.id === "best_price" ? t("watch.provTabBest") : f.label || String(f.id).toUpperCase() }))
      : [
          { id: "best_price", label: t("watch.provTabBest") },
          ...(payload.qualities || []).map((q) => ({ id: String(q).toLowerCase(), label: q })),
        ];
    if (!tabs.some((tab) => tab.id === "best_price")) tabs.unshift({ id: "best_price", label: t("watch.provTabBest") });
    if (tabs.length < 2) return "";
    return `
        <div class="prov-tabs" role="tablist" aria-label="${escapeHtml(t("common.quality"))}">
          ${tabs
            .map(
              (tab) =>
                `<button type="button" role="tab" class="prov-tab${
                  state.providerQuality === tab.id ? " is-on" : ""
                }" data-quality="${escapeHtml(tab.id)}" aria-selected="${state.providerQuality === tab.id}">${escapeHtml(tab.label)}</button>`
            )
            .join("")}
        </div>`;
  }

  function providersHead(region, regions) {
    const mine = currentCountry() || "";
    const payload = offersPayload(region);
    const names = new Set();
    PROVIDER_KINDS.forEach(([kind]) =>
      (state.providers?.[region]?.[kind] || []).forEach((p) => names.add(p.provider_name))
    );
    // A visitor whose country has no listing is told which region is shown.
    const note =
      mine && regions.length && !regions.includes(mine)
        ? ` ${t("watch.provNotInRegion", { region: escapeHtml(regionLabel(mine)) })}`
        : "";
    const lead = regions.length
      ? t("watch.provCount", { n: names.size, region: escapeHtml(regionLabel(region)) }) + note
      : t("watch.provLead", { region: escapeHtml(regionLabel(mine) || "TMDB") });
    const priced = payload
      ? `<p class="muted">${t("watch.provPrices", {
          n: payload.offer_count || (payload.providers || []).length,
          region: escapeHtml(regionLabel(payload.region || region)),
        })}${
          payload.currency ? ` · ${escapeHtml(payload.currency)}` : ""
        }${
          payload.justwatch
            ? ` <a href="${escapeHtml(payload.justwatch)}" target="_blank" rel="noopener">${escapeHtml(t("watch.provDataBy"))}</a>`
            : ""
        }</p>`
      : "";
    return `
      <div class="links-head">
        <div>
          <span class="eyebrow">${t("watch.provEyebrow")}</span>
          <h2>${t("watch.providers")}</h2>
          <p class="muted">${lead}</p>
          ${priced}
        </div>
        <div class="prov-controls">
          ${providerTabs(region)}
          ${
            regions.length > 1
              ? `<label class="link-filter prov-region"><span>${t("watch.provRegion")}</span>
                 <select id="prov-region">
                   ${regions
                     .map(
                       (cc) =>
                         `<option value="${cc}" ${cc === region ? "selected" : ""}>${escapeHtml(regionLabel(cc))} · ${cc}</option>`
                     )
                     .join("")}
                 </select>
               </label>`
              : `<span class="chip chip-soft prov-region-only">${escapeHtml(t("watch.provSource"))}</span>`
          }
        </div>
      </div>`;
  }

  function renderProviders() {
    const el = $("#watch-providers");
    if (!el) return;
    el.hidden = false;
    const regions = providerRegions();
    if (!regions.length) {
      el.innerHTML = `<div class="links-head"><div>
          <span class="eyebrow">${t("watch.provEyebrow")}</span>
          <h2>${t("watch.providers")}</h2>
          <p class="muted">${t("watch.noProviders")}</p>
        </div></div>`;
      return;
    }
    const region = regions.includes(state.providerRegion) ? state.providerRegion : regions[0];
    state.providerRegion = region;
    el.innerHTML = providersHead(region, regions) + `<div class="provider-list" id="provider-list">${providerRows(region)}</div>`;
    const sel = $("#prov-region");
    if (sel) {
      sel.onchange = (e) => {
        state.providerRegion = e.target.value;
        state.providerQuality = "best_price";
        renderProviders();
        loadProviderOffers(state.providerRegion);
      };
    }
    $$(".prov-tab", el).forEach((tab) => {
      tab.onclick = () => {
        state.providerQuality = tab.dataset.quality || "best_price";
        renderProviders();
      };
    });
    // A logo TMDB no longer serves falls back to the platform's initial.
    $$(".provider-logo", el).forEach((img) => {
      if (img.tagName !== "IMG") return;
      img.onerror = () => {
        const mono = document.createElement("span");
        mono.className = "provider-logo provider-logo-mono";
        mono.setAttribute("aria-hidden", "true");
        mono.textContent = String(img.dataset.name || "?").slice(0, 1).toUpperCase();
        img.replaceWith(mono);
      };
    });
  }

  // Prices and qualities come from the server, which reads TMDB's watch page for
  // exactly this region. Without that endpoint the panel keeps the API rows.
  async function loadProviderOffers(region) {
    if (!region || state.offersRegion === region) return;
    const payload = await fetchProviderOffers(mediaType, mediaId, region);
    state.offersRegion = region;
    state.providerOffers = payload;
    if (payload) renderProviders();
  }

  async function loadProviders() {
    const el = $("#watch-providers");
    if (!el) return;
    el.hidden = false;
    if (state.providers === null) {
      el.innerHTML = `<div class="links-head"><div>
          <span class="eyebrow">${t("watch.provEyebrow")}</span>
          <h2>${t("watch.providers")}</h2>
          <p class="muted">${t("common.loading")}</p>
        </div></div>`;
      try {
        const kind = mediaType === "tv" ? "tv" : "movie";
        const data = await tmdb(`/${kind}/${mediaId}/watch/providers`);
        state.providers = data && typeof data.results === "object" && data.results ? data.results : {};
      } catch {
        state.providers = {};
      }
      // The region follows the visitor's IP unless they picked one in settings.
      const detected = manualCountry() || (await detectGeo()) || currentCountry();
      state.providerRegion = pickProviderRegion(detected);
    }
    renderProviders();
    loadProviderOffers(state.providerRegion);
  }

  /* --- The member links: watch links and download links in one panel --------
     Both kinds are the same rows (movielink / tvlink, told apart by link_kind),
     so both are shown the same way: the platform logo with its name and the
     quality as a short badge (SD HD FHD 2K 4K 8K) beside it, what the source
     offers under it (quality, original language, subtitles, ads) and who
     published it. A watch link opens in the player above; a download link opens
     on its own site. Each rail scrolls sideways, is filtered by quality and
     platform, and always runs from the most viewed link down. */
  const SOURCE_KINDS = [
    { kind: "watch", title: "watch.watchLinks", empty: "watch.noLinks", lead: "" },
    { kind: "download", title: "watch.downloadLinks", empty: "watch.noDownloads", lead: "watch.dlLead" },
  ];

  const sourceTable = () => (mediaType === "tv" ? "tvlink" : "movielink");

  function epLabel() {
    return mediaType === "tv"
      ? t("watch.forEp", { s: state.season, e: state.episode })
      : "";
  }

  // Ordered for whoever is watching: most viewed first, then the sharpest
  // quality, then the newest. Filters narrow the list without changing the order.
  function orderSourceRows(rows) {
    return rows.slice().sort((a, b) => {
      const clicks = Number(b.clicks || 0) - Number(a.clicks || 0);
      if (clicks) return clicks;
      const quality = qualityRank(b.quality) - qualityRank(a.quality);
      if (quality) return quality;
      return String(b.added_at || "").localeCompare(String(a.added_at || ""));
    });
  }

  function rowsOfKind(kind) {
    return (state.linkRows || []).filter((row) => linkKindOf(row) === kind);
  }

  function filterSourceRows(rows) {
    let list = rows;
    if (state.linkFilters.quality) {
      list = list.filter((row) => qualityList(row.quality).includes(state.linkFilters.quality));
    }
    if (state.linkFilters.platform) {
      list = list.filter((row) => urlHost(row.watch_url) === state.linkFilters.platform);
    }
    return orderSourceRows(list);
  }

  function fmtNum(n) {
    const v = Number(n) || 0;
    try {
      return v.toLocaleString(getLocale());
    } catch {
      return String(v);
    }
  }

  // Clicks of every link of one kind for this title (or this episode): the
  // number a single link is divided by.
  function kindTotal(kind) {
    const own = rowsOfKind(kind).reduce((sum, row) => sum + (Number(row.clicks) || 0), 0);
    return own + (kind === "watch" ? Number(state.mainRow?.clicks) || 0 : 0);
  }

  // "12 / 340" — this link's views (watch) or downloads (download) over the
  // total of all links of the same kind, with a thin share bar under it.
  function statInner(row) {
    const kind = linkKindOf(row);
    const n = Number(row.clicks) || 0;
    const total = Math.max(kindTotal(kind), n);
    const pct = total ? Math.min(100, (n / total) * 100) : 0;
    const label = kind === "download" ? t("watch.downloads") : t("watch.views");
    return `
      <span class="src-stat-top">
        <span class="src-stat-label">${escapeHtml(label)}</span>
        <span class="src-stat-num" dir="ltr"><b>${fmtNum(n)}</b> / ${fmtNum(total)}</span>
      </span>
      <span class="src-bar" aria-hidden="true"><i style="width:${pct.toFixed(1)}%"></i></span>`;
  }

  // The subtitles a source carries, as a short value under its facts.
  function subsValue(row) {
    if (!row.has_subtitles) return t("common.no");
    const list = String(row.subtitle_languages || "").trim();
    if (!list) return t("common.yes");
    if (list.toLowerCase() === "all") return t("dash.allLangs");
    return list
      .split(",")
      .map((lang) => tr(lang.trim().replace(/^all$/i, "")) || lang.trim())
      .filter(Boolean)
      .join(", ");
  }

  // Both filters read the links that are actually on the page, so the lists only
  // ever offer a quality or a platform that can be found. The bar is mounted
  // after the rows load, and remounted whenever the rows change.
  function sourceFilterBar() {
    const all = state.linkRows || [];
    const qualities = new Map();
    [...all, ...(state.mainRow ? [state.mainRow] : [])].forEach((row) => {
      qualityList(row.quality).forEach((badge) => {
        qualities.set(badge, qualityRank(badge));
      });
    });
    const platforms = new Map();
    all.forEach((row) => {
      const host = urlHost(row.watch_url);
      if (host && !platforms.has(host)) platforms.set(host, linkHostName(row.watch_url) || host);
    });
    const qualityOpts = [...qualities.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([badge]) => `<option value="${escapeHtml(badge)}">${escapeHtml(badge)}</option>`)
      .join("");
    const platformOpts = [...platforms.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(
        ([host, name]) =>
          `<option value="${escapeHtml(host)}">${escapeHtml(name)}</option>`
      )
      .join("");
    return `
      <div class="link-filters">
        <label class="link-filter"><span>${t("common.quality")}</span>
          <select id="link-filter-quality">
            <option value="">${t("watch.filterAllQualities")}</option>
            ${qualityOpts}
          </select>
        </label>
        <label class="link-filter"><span>${t("watch.filterPlatform")}</span>
          <select id="link-filter-platform">
            <option value="">${t("watch.filterAllPlatforms")}</option>
            ${platformOpts}
          </select>
        </label>
        <span class="muted link-sort-note">${t("watch.sortNote")}</span>
      </div>`;
  }

  function mountSourceFilters() {
    const bar = $("#link-filter-bar");
    if (!bar) return;
    bar.innerHTML = sourceFilterBar();
    const qualitySel = $("#link-filter-quality");
    const platformSel = $("#link-filter-platform");
    if (qualitySel) {
      qualitySel.value = state.linkFilters.quality;
      if (qualitySel.value !== state.linkFilters.quality) state.linkFilters.quality = "";
      qualitySel.onchange = (e) => {
        state.linkFilters.quality = e.target.value;
        drawSourceRails();
      };
    }
    if (platformSel) {
      platformSel.value = state.linkFilters.platform;
      if (platformSel.value !== state.linkFilters.platform) state.linkFilters.platform = "";
      platformSel.onchange = (e) => {
        state.linkFilters.platform = e.target.value;
        drawSourceRails();
      };
    }
  }

  // The same URL published as a watch link and as a download link: each rail
  // says the source is available the other way too.
  function urlKinds() {
    const map = new Map();
    (state.linkRows || []).forEach((row) => {
      const url = String(row.watch_url || "");
      if (!url) return;
      if (!map.has(url)) map.set(url, new Set());
      map.get(url).add(linkKindOf(row));
    });
    return map;
  }

  /* --- The link that opens by itself ----------------------------------------
     The default player (the big play button) is shown as the first watch link:
     the site's own logo and name, the qualities it carries, its address always
     hidden, and the site itself as the publisher. Edit MAIN_LINK to change what
     it says about itself. */
  const SITE_NAME = "CineAura";
  const SITE_LOGO =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%230d253f'/%3E%3Cpolygon points='26,18 48,32 26,46' fill='%2390cea1'/%3E%3C/svg%3E";
  const MAIN_LINK = { quality: "SD, HD, FHD", hasAds: false, subtitles: "all" };

  function titleLanguageName() {
    const code = state.detail?.original_language;
    if (!code) return "";
    try {
      return new Intl.DisplayNames(["en"], { type: "language" }).of(code) || "";
    } catch {
      return "";
    }
  }

  function buildMainRow() {
    return {
      isMain: true,
      id: null,
      link_kind: "watch",
      watch_url: "",
      url_hidden: true,
      quality: MAIN_LINK.quality,
      original_language: titleLanguageName(),
      has_subtitles: Boolean(MAIN_LINK.subtitles),
      subtitle_languages: MAIN_LINK.subtitles,
      has_ads: MAIN_LINK.hasAds,
      member_id: "",
      username: SITE_NAME,
      clicks: 0,
    };
  }

  function mainQuery() {
    let q = `link_table=eq.main&tmdb_id=eq.${Number(mediaId)}&media_type=eq.${mediaType}`;
    if (mediaType === "tv") q += `&season=eq.${Number(state.season)}&episode=eq.${Number(state.episode)}`;
    return q;
  }

  // The main link has no row of its own: its views are the log lines written
  // with link_table = "main" for this title (or this episode).
  async function loadMainClicks(row) {
    try {
      row.clicks = await countRows(`/rest/v1/link_clicks?${mainQuery()}&select=id`);
    } catch {
      row.clicks = 0;
    }
    refreshLinkCounts();
  }

  async function countMainClick(row) {
    if (!state.guestId) state.guestId = stableGuestId();
    const viewer = getSession()?.member_id || state.guestId;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const seen = await supabaseRequest(
      `/rest/v1/link_clicks?${mainQuery()}&viewer_id=eq.${restValue(viewer)}&clicked_at=gt.${encodeURIComponent(since)}&select=id&limit=1`
    );
    if (seen.ok && seen.data?.[0]) return row.clicks;
    const saved = await supabaseRequest("/rest/v1/link_clicks", {
      method: "POST",
      body: JSON.stringify({
        link_table: "main",
        link_id: Number(mediaId) || 0,
        link_kind: "watch",
        tmdb_id: Number(mediaId) || 0,
        media_type: mediaType,
        season: mediaType === "tv" ? Number(state.season) : null,
        episode: mediaType === "tv" ? Number(state.episode) : null,
        owner_id: "site",
        owner_username: SITE_NAME,
        viewer_id: viewer,
        watch_url: "",
      }),
    });
    if (saved.ok) row.clicks = Number(row.clicks || 0) + 1;
    return row.clicks;
  }

  // Quality badges of a link: SD HD FHD …, one chip each.
  function qualityChipsHtml(value) {
    const list = qualityList(value);
    return (list.length ? list : ["—"]).map((q) => `<span class="src-quality">${escapeHtml(q)}</span>`).join("");
  }

  // The address shown to everybody, hidden by the publisher's choice. The
  // publisher still sees their own link (marked as hidden from the others).
  function urlIsHiddenFrom(row) {
    if (row.isMain) return true;
    if (!row.url_hidden) return false;
    const me = getSession()?.member_id;
    return !(me && row.member_id === me);
  }

  // What may sit in the page's markup for a link: its own address, or only the
  // site's origin when the publisher hid it.
  function safeMetaUrl(row) {
    const url = String(row.watch_url || "");
    if (!row.url_hidden) return url;
    try {
      return new URL(url).origin;
    } catch {
      return "";
    }
  }

  function sourceCardHtml(row, index) {
    const url = String(row.watch_url || "");
    const kind = linkKindOf(row);
    const main = Boolean(row.isMain);
    const host = main ? "" : urlHost(url);
    const platform = main ? SITE_NAME : linkHostName(url) || host || t("watch.source");
    const on = row === state.selectedLink;
    const logo = main
      ? `<img class="src-logo is-site" src="${SITE_LOGO}" alt="" />`
      : `<img class="src-logo" src="${escapeHtml(hostIconUrl(url))}" alt="" loading="lazy"
              referrerpolicy="no-referrer" data-meta-url="${encodeURIComponent(safeMetaUrl(row))}"
              data-host="${escapeHtml(host)}" />`;
    return `
      <article class="src-card${kind === "download" ? " is-download" : ""}${main ? " is-main" : ""}${row.banned ? " is-banned" : ""}${on ? " is-on" : ""}"
               data-index="${index}" data-kind="${kind}" role="listitem">
        <button class="src-open" type="button" data-open="${index}" aria-pressed="${on}"
                title="${escapeHtml(kind === "download" ? t("watch.pickDownload") : t("watch.play"))}">
          ${main ? `<span class="src-tag">${t("watch.mainLink")}</span>` : ""}
          <span class="src-row">
            ${logo}
            <span class="src-head">
              <strong class="src-name">${escapeHtml(platform)}</strong>
              <span class="src-qualities">${qualityChipsHtml(row.quality)}</span>
            </span>
          </span>
          <span class="src-stat" data-stat="${index}">${statInner(row)}</span>
        </button>
      </article>`;
  }

  /* --- The selected link: everything about it, directly under the iframe ----
     Platform logo, quality and link on top; quality, original language,
     subtitles, ads and the views (or downloads) share under it; and at the
     bottom the publisher (avatar + @username → profile) with the report button.
     The address is left out when the publisher hid it; the main link has no
     address and the site itself as its publisher. */
  function detailHtml(row) {
    const url = String(row.watch_url || "");
    const kind = linkKindOf(row);
    const main = Boolean(row.isMain);
    const host = urlHost(url);
    const platform = main
      ? SITE_NAME
      : $(`.src-card.is-on .src-name`)?.textContent || linkHostName(url) || host || t("watch.source");
    const original = row.original_language ? tr(row.original_language) : "—";
    const isDl = kind === "download";
    const hiddenFromMe = urlIsHiddenFrom(row);
    const shown = url.replace(/^https?:\/\//i, "");
    const short = shown.length > 70 ? `${shown.slice(0, 67)}…` : shown;
    const logo = main
      ? `<img class="ld-logo is-site" src="${SITE_LOGO}" alt="" />`
      : `<img class="ld-logo" src="${escapeHtml(hostIconUrl(url))}" alt="" referrerpolicy="no-referrer" />`;
    let urlLine = "";
    if (!main && !hiddenFromMe) {
      urlLine = `<a class="ld-url" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"
             ${isDl ? "data-dl" : ""} title="${escapeHtml(t("watch.openNew"))}" dir="ltr">${escapeHtml(short)}</a>
          ${row.url_hidden ? `<span class="ld-hidden-note">${t("watch.urlHiddenOwner")}</span>` : ""}`;
    } else {
      urlLine = `<span class="ld-hidden-note">${t("watch.urlHiddenNote")}</span>`;
    }
    const publisher = main
      ? `<a class="src-user" href="./">
          <span class="src-avatar"><img src="${SITE_LOGO}" alt="" /></span>
          <span class="src-username">${escapeHtml(SITE_NAME)}</span>
        </a>
        <span class="src-kind">${t("watch.siteBadge")}</span>`
      : `<a class="src-user" href="${memberProfileHref(row.username)}">
          <span class="src-avatar">${avatarImg(row.member_id, row.username, row.username)}</span>
          <span class="src-username">@${escapeHtml(row.username || "member")}</span>
        </a>
        <button class="btn btn-sm btn-ghost src-report" type="button" data-report-sel>${t("watch.report")}</button>`;
    return `
      <header class="ld-head">
        ${logo}
        <div class="ld-title">
          <div class="ld-name-row">
            <strong class="ld-name">${escapeHtml(platform)}</strong>
            ${qualityChipsHtml(row.quality)}
            <span class="src-kind">${escapeHtml(main ? t("watch.mainLink") : isDl ? t("watch.chipDownload") : t("watch.chipWatch"))}</span>
          </div>
          ${urlLine}
        </div>
        ${
          isDl
            ? `<a class="btn btn-sm btn-primary ld-dl" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" data-dl>${t("watch.downloadNow")}</a>`
            : ""
        }
      </header>
      <dl class="ld-facts">
        <div><dt>${t("common.quality")}</dt><dd class="ld-qualities">${qualityChipsHtml(row.quality)}</dd></div>
        <div><dt>${t("common.origLang")}</dt><dd>${escapeHtml(original)}</dd></div>
        <div><dt>${t("common.subs")}</dt><dd>${escapeHtml(subsValue(row))}</dd></div>
        <div><dt>${t("common.ads")}</dt><dd>${escapeHtml(row.has_ads ? t("common.adsOn") : t("common.adsOff"))}</dd></div>
        <div class="ld-stat-cell">
          <dt>${escapeHtml(isDl ? t("watch.det.downloads") : t("watch.det.viewers"))}</dt>
          <dd><span class="src-stat" data-stat-detail>${statInner(row)}</span></dd>
        </div>
      </dl>
      <footer class="ld-who">${publisher}</footer>`;
  }

  function renderLinkDetail(row) {
    const el = $("#link-detail");
    if (!el) return;
    el.hidden = false;
    el.dataset.url = row.isMain ? "" : safeMetaUrl(row);
    el.innerHTML = detailHtml(row);
    hydrateAvatars(el);
  }

  function clearLinkDetail() {
    state.selectedLink = null;
    const el = $("#link-detail");
    if (el) {
      el.hidden = true;
      el.innerHTML = "";
      el.dataset.url = "";
    }
    $$(".src-card.is-on").forEach((node) => node.classList.remove("is-on"));
  }

  // Counters of every card and of the open panel, after a click moved a number.
  function refreshLinkCounts() {
    $$(".src-card").forEach((card) => {
      const row = state.linkOrder[Number(card.dataset.index)];
      const stat = card.querySelector(".src-stat");
      if (row && stat) stat.innerHTML = statInner(row);
    });
    const sel = state.selectedLink;
    const detail = $("#link-detail [data-stat-detail]");
    if (sel && detail) detail.innerHTML = statInner(sel);
  }

  // The big play button and the main card both land here: the default player
  // opens, the main link becomes the selected one and its view is counted.
  function activateMainLink() {
    const row = state.mainRow;
    if (!row) return;
    state.selectedLink = row;
    markActiveCard(row);
    renderLinkDetail(row);
    countClick(row);
  }

  function selectLink(row) {
    state.selectedLink = row;
    markActiveCard(row);
    renderLinkDetail(row);
    if (!row.isMain && linkKindOf(row) === "download") {
      $("#link-detail")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }
    armLink(row);
  }

  function renderRail(def, rows, indexOf) {
    const rail = $(`#src-rail-${def.kind}`);
    if (!rail) return;
    const count = $(`#src-count-${def.kind}`);
    if (count) count.textContent = t("watch.linksCount", { n: rows.length });
    if (!rows.length) {
      rail.innerHTML = `<p class="muted src-empty">${
        rowsOfKind(def.kind).length ? t("watch.noMatch") : t(def.empty, { ep: epLabel() })
      }</p>`;
      return;
    }
    rail.innerHTML = rows.map((row) => sourceCardHtml(row, indexOf.get(row))).join("");
    hydrateSourceMeta(rail);
    hydrateAvatars(rail);
  }

  function drawSourceRails() {
    // One flat, ordered index: a card's number is its place in the panel, so the
    // click and report handlers can look the row up again.
    const ordered = [];
    const groups = {};
    SOURCE_KINDS.forEach((def) => {
      groups[def.kind] = filterSourceRows(rowsOfKind(def.kind));
    });
    // The link that opens by itself always comes first; the filters only keep
    // it out when it does not offer the quality that was picked.
    const main = state.mainRow;
    if (main && (!state.linkFilters.quality || qualityList(main.quality).includes(state.linkFilters.quality))) {
      groups.watch.unshift(main);
    }
    const indexOf = new Map();
    SOURCE_KINDS.forEach((def) => {
      groups[def.kind].forEach((row) => {
        indexOf.set(row, ordered.length);
        ordered.push(row);
      });
    });
    state.linkOrder = ordered;
    SOURCE_KINDS.forEach((def) => renderRail(def, groups[def.kind], indexOf));
  }

  /* The platform's own name is read from the page behind the link when the site
     runs the /api/thumb proxy (server.py); the logo always comes from the host
     itself. A source whose page does not answer simply keeps its domain name. */
  function hydrateSourceMeta(root) {
    $$(".src-logo[data-meta-url]", root).forEach((img) => {
      const url = decodeURIComponent(img.dataset.metaUrl || "");
      if (!url) return;
      const host = img.dataset.host || "";
      linkThumb(url).then((meta) => {
        if (!meta.name || !document.contains(img)) return;
        const name = img.closest(".src-card")?.querySelector(".src-name");
        if (name) name.textContent = meta.name;
        const panel = $("#link-detail");
        if (panel && panel.dataset.url === url) {
          const pn = panel.querySelector(".ld-name");
          if (pn) pn.textContent = meta.name;
        }
        const opt = host
          ? $(`#link-filter-platform option[value="${CSS.escape ? CSS.escape(host) : host}"]`)
          : null;
        if (opt && !opt.dataset.named) {
          opt.dataset.named = "1";
          opt.textContent = meta.name;
        }
      });
    });
  }

  function scrollRail(button) {
    const rail = $(`#src-rail-${button.dataset.rail}`);
    if (!rail) return;
    const step = Math.max(200, Math.round(rail.clientWidth * 0.8));
    rail.scrollBy({ left: Number(button.dataset.railScroll) * step, behavior: "smooth" });
  }

  // A click on a download link: the new tab is opened by the link itself and the
  // click is counted here — every 1000 clicks pays the publisher one point.
  function countDownloadClick(row) {
    markActiveCard(row);
    countClick(row);
  }

  function markActiveCard(row) {
    const index = state.linkOrder.indexOf(row);
    const card = index >= 0 ? $(`.src-card[data-index="${index}"]`) : null;
    $$(".src-card").forEach((node) => node.classList.toggle("is-on", Boolean(card) && node === card));
  }

  // Every click moves the counter on the link row (and leaves a line in the
  // click log), then the card shows the new number.
  function countClick(row) {
    if (row.isMain) return countMainClick(row).then((next) => {
      refreshLinkCounts();
      return next;
    });
    if (!state.guestId) state.guestId = stableGuestId();
    const viewerId = getSession()?.member_id || state.guestId;
    return countLinkClick(sourceTable(), row, { viewerId, mediaType }).then((next) => {
      refreshLinkCounts();
      return next;
    });
  }

  async function loadSocialGates() {
    state.blocksAgainstMe = [];
    const session = getSession();
    if (!session?.member_id) return;
    const res = await supabaseRequest(
      `/rest/v1/blocks?blocked_id=eq.${restValue(session.member_id)}&select=blocker_id,blocker_username,kind,features`
    );
    state.blocksAgainstMe = res.ok && Array.isArray(res.data) ? res.data : [];
  }

  function ownerBlocks(feature, ownerId, ownerUsername) {
    const rows = state.blocksAgainstMe || [];
    const hit = rows.find(
      (x) =>
        (ownerId && x.blocker_id === ownerId) ||
        (ownerUsername && x.blocker_username === ownerUsername)
    );
    if (!hit) return false;
    if (hit.kind === "full") return true;
    if (feature === "replies") return false;
    return String(hit.features || "")
      .split(",")
      .map((s) => s.trim())
      .includes(feature);
  }

  function memberProfileHref(username) {
    const name = String(username || "").replace(/^@/, "").trim();
    return name ? `./Profile.html?@${encodeURIComponent(name)}` : "./Profile.html";
  }

  async function renderSources() {
    const el = $("#watch-links");
    if (!el) return;
    el.hidden = false;
    clearLinkDetail();
    state.mainRow = buildMainRow();
    loadMainClicks(state.mainRow);
    const session = getSession();
    el.innerHTML = `
      <div class="links-head">
        <div>
          <span class="eyebrow">${t("watch.links")}</span>
          <h2>${t("watch.sources")}</h2>
          <p class="muted">${t("watch.sourcesLead", { ep: epLabel() })}</p>
        </div>
        <button class="btn btn-sm btn-primary add-link-btn" id="add-link-btn" type="button"
                title="${escapeHtml(t("watch.al.title"))}" aria-label="${escapeHtml(t("watch.al.title"))}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
          <span>${t("watch.addLink")}</span>
        </button>
      </div>
      <div id="link-filter-bar"></div>
      <div class="src-rails">
        ${SOURCE_KINDS.map(
          (def) => `
        <section class="src-block" data-block="${def.kind}">
          <header class="src-block-head">
            <div class="src-block-title">
              <h3>${t(def.title)}</h3>
              ${def.lead ? `<p class="muted">${t(def.lead)}</p>` : ""}
            </div>
            <span class="muted src-count" id="src-count-${def.kind}"></span>
            <div class="src-nav">
              <button class="src-nav-btn" type="button" data-rail-scroll="-1" data-rail="${def.kind}"
                      aria-label="${escapeHtml(t("watch.scrollPrev"))}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
              </button>
              <button class="src-nav-btn" type="button" data-rail-scroll="1" data-rail="${def.kind}"
                      aria-label="${escapeHtml(t("watch.scrollNext"))}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
              </button>
            </div>
          </header>
          <div class="src-rail" id="src-rail-${def.kind}" role="list">
            <p class="muted src-empty">${t("common.loading")}</p>
          </div>
        </section>`
        ).join("")}
      </div>`;
    $("#add-link-btn").onclick = openAddLinkModal;
    el.onclick = (e) => {
      const report = e.target.closest("[data-report]");
      if (report) {
        const row = state.linkOrder[Number(report.dataset.report)];
        if (row) openReportModal(row);
        return;
      }
      const scroll = e.target.closest("[data-rail-scroll]");
      if (scroll) {
        scrollRail(scroll);
        return;
      }
      const open = e.target.closest("[data-open]");
      if (!open) return;
      const row = state.linkOrder[Number(open.dataset.open)];
      if (row) selectLink(row);
    };

    // The details panel sits under the iframe, outside this section: its report
    // button and its download links are wired here.
    const detail = $("#link-detail");
    if (detail) {
      detail.onclick = (e) => {
        const sel = state.selectedLink;
        if (!sel) return;
        if (e.target.closest("[data-report-sel]")) {
          openReportModal(sel);
          return;
        }
        if (e.target.closest("[data-dl]")) countDownloadClick(sel);
      };
    }

    const res =
      mediaType === "movie"
        ? await supabaseRequest(
            `/rest/v1/movielink?tmdb_id=eq.${Number(mediaId)}&select=*&order=added_at.desc`
          )
        : await supabaseRequest(
            `/rest/v1/tvlink?tmdb_id=eq.${Number(mediaId)}&season=eq.${Number(state.season)}&episode=eq.${Number(state.episode)}&select=*&order=added_at.desc`
          );
    if (res?.data?.code === "PGRST205") {
      state.linkRows = [];
      state.linkOrder = [];
      SOURCE_KINDS.forEach((def) => {
        const rail = $(`#src-rail-${def.kind}`);
        if (rail) rail.innerHTML = `<p class="muted src-empty">${t("watch.missingLinks")}</p>`;
      });
      return;
    }
    let rows = res.ok && Array.isArray(res.data) ? res.data : [];
    rows = rows.filter((row) => {
      const until = row.ban_until ? Date.parse(row.ban_until) : 0;
      const blocked = row.banned || until > Date.now();
      return !blocked || row.member_id === session?.member_id;
    });
    rows = rows.filter((row) => {
      if (!row.member_id || row.member_id === session?.member_id) return true;
      return !ownerBlocks("links", row.member_id, row.username);
    });
    state.linkRows = rows;
    mountSourceFilters();
    drawSourceRails();
  }

  function commentDate(value) {
    const raw = String(value || "");
    return raw.slice(0, 16).replace("T", " ") || "—";
  }

  function publicCommentId(row) {
    if (row?.comment_id) return row.comment_id;
    const n = row?.id;
    if (!n) return "";
    return `${row.comment_type === "reply" ? "R" : "C"}${n}`;
  }

  async function nextCommentCode(kind) {
    const prefix = kind === "reply" ? "R" : "C";
    for (let i = 0; i < 10; i++) {
      const code = `${prefix}${Math.floor(100000000 + Math.random() * 900000000)}`;
      const check = await supabaseRequest(
        `/rest/v1/comments?comment_id=eq.${restValue(code)}&select=id`
      );
      if (!check.data?.[0]) return code;
    }
    return `${prefix}${Date.now()}`;
  }

  async function postComment({ text, commentType, parentCommentId }) {
    const session = getSession();
    if (!session?.member_id) {
      toast(t("watch.signCmtToast"));
      return false;
    }
    if (featureBlocked("comments")) {
      toast(t("panel.featBlockedMsg", { feature: t("panel.feat.comments") }));
      return false;
    }
    const body = String(text || "").trim();
    if (!body) {
      toast(t("watch.writeFirst"));
      return false;
    }
    if (commentType === "reply" && parentCommentId) {
      const parent = await supabaseRequest(
        `/rest/v1/comments?comment_id=eq.${restValue(parentCommentId)}&select=member_id,username`
      );
      const row = parent.data?.[0];
      if (row && ownerBlocks("replies", row.member_id, row.username)) {
        toast(t("watch.noReply"));
        return false;
      }
    }
    const commentId = await nextCommentCode(commentType);
    const payload = {
      idtmdb: Number(mediaId),
      type: mediaType,
      username: session.username || session.full_name || "member",
      member_id: session.member_id,
      comment: body,
      comment_type: commentType,
      comment_id: commentId,
      parent_comment_id: parentCommentId || null,
    };
    let saved = await supabaseRequest("/rest/v1/comments", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (!saved.ok) {
      const { comment_id, parent_comment_id, ...fallback } = payload;
      saved = await supabaseRequest("/rest/v1/comments", {
        method: "POST",
        body: JSON.stringify({ ...fallback, parent_id: parentCommentId || null }),
      });
    }
    if (!saved.ok) {
      toast(t("watch.postFail"));
      return false;
    }
    toast(commentType === "reply" ? t("watch.replyPosted", { id: commentId }) : t("watch.cmtPosted", { id: commentId }));
    await renderComments();
    return true;
  }

  async function renderComments() {
    const el = $("#watch-comments");
    if (!el) return;
    el.hidden = false;
    const session = getSession();
    el.innerHTML = `
      <span class="eyebrow">${t("watch.comments")}</span>
      <h2>${t("watch.comments")}</h2>
      <p class="muted">${t("watch.cmtLead", { kind: mediaType === "tv" ? t("common.series") : t("common.movie") })}</p>
      ${
        session?.member_id
          ? `<div class="comment-form">
              <textarea id="comment-text" placeholder="${t("watch.shareTake")}" maxlength="2000"></textarea>
              <button class="btn btn-sm btn-primary" id="comment-post" type="button">${t("watch.comment")}</button>
            </div>`
          : `<p class="muted">${t("watch.signCmt")} <a href="./login.html">${t("common.signin")}</a></p>`
      }
      <div class="comment-list" id="comment-list"><p class="muted">${t("common.loading")}</p></div>`;
    if ($("#comment-post")) {
      $("#comment-post").onclick = async () => {
        const ok = await postComment({
          text: $("#comment-text")?.value,
          commentType: "comment",
          parentCommentId: null,
        });
        if (ok && $("#comment-text")) $("#comment-text").value = "";
      };
    }
    const res = await supabaseRequest(
      `/rest/v1/comments?idtmdb=eq.${Number(mediaId)}&type=eq.${mediaType}&select=*&order=created_at.asc`
    );
    const list = $("#comment-list");
    if (res?.data?.code === "PGRST205") {
      list.innerHTML = `<p class="muted">${t("watch.missingCmt")}</p>`;
      return;
    }
    const rows = res.ok && Array.isArray(res.data) ? res.data : [];
    const roots = rows.filter(
      (r) => r.comment_type !== "reply" && !r.parent_comment_id && !r.parent_id
    );
    const repliesOf = (id) =>
      rows.filter((r) => {
        const parent = String(r.parent_comment_id || r.parent_id || "");
        return parent && parent === String(id);
      });
    if (!roots.length && !rows.length) {
      list.innerHTML = `<p class="muted">${t("watch.noCmt")}</p>`;
      return;
    }
    const card = (row, isReply) => {
      const cid = publicCommentId(row);
      return `
      <article class="comment-card ${isReply ? "reply" : ""}" data-comment-id="${escapeHtml(cid)}">
        <div class="comment-meta">
          <strong><a href="${memberProfileHref(row.username)}">@${escapeHtml(row.username || "member")}</a></strong>
          <span class="muted">${escapeHtml(cid)} · ${escapeHtml(commentDate(row.created_at))}${isReply ? ` · Reply to ${escapeHtml(row.parent_comment_id || "")}` : ""}</span>
        </div>
        <p class="comment-body">${escapeHtml(row.comment || "")}</p>
        ${ownerBlocks("replies", row.member_id, row.username) ? "" : `<button class="btn btn-sm btn-ghost" data-reply="${escapeHtml(cid)}" type="button">${t("watch.reply")}</button>`}
        <div class="reply-slot" data-slot="${escapeHtml(cid)}"></div>
      </article>
      ${repliesOf(cid).map((rep) => card(rep, true)).join("")}`;
    };
    list.innerHTML = roots.map((row) => card(row, false)).join("") || `<p class="muted">${t("watch.noCmt")}</p>`;
    list.onclick = async (e) => {
      const send = e.target.closest("[data-send-reply]");
      if (send) {
        const wrap = send.closest(".reply-form");
        const text = wrap?.querySelector("textarea")?.value;
        await postComment({
          text,
          commentType: "reply",
          parentCommentId: send.dataset.sendReply,
        });
        return;
      }
      const btn = e.target.closest("[data-reply]");
      if (!btn) return;
      const id = btn.dataset.reply;
      const slot = list.querySelector(`[data-slot="${CSS.escape ? CSS.escape(id) : id}"]`) ||
        list.querySelector(`[data-slot="${id}"]`);
      if (!slot) return;
      if (!session?.member_id) {
        toast(t("watch.signReply"));
        return;
      }
      const open = slot.querySelector(".reply-form");
      if (open) {
        slot.innerHTML = "";
        return;
      }
      slot.innerHTML = `
        <div class="reply-form">
          <textarea placeholder="${t("watch.replyTo", { id })}" maxlength="2000"></textarea>
          <button class="btn btn-sm btn-primary" data-send-reply="${escapeHtml(id)}" type="button">${t("watch.postReply")}</button>
        </div>`;
    };
  }

  async function renderWatchExtras() {
    await loadSocialGates();
    loadProviders();
    await renderPlaylistBar();
    await renderSources();
    renderShareRow();
    await renderSocialTabs();
  }

  async function onPlay() {
    if (state.gated) {
      $("#code-input").focus();
      return;
    }
    if (ageLocked()) {
      lockPlayer();
      return;
    }
    playArmed();
  }

  async function submitCode() {
    if (applyLockUI()) {
      toast(t("watch.lockoutToast"));
      return;
    }
    const code = $("#code-input").value.replace(/\D/g, "");
    const result = await verifyCode(code, ageVerifyOptions());
    const msg = $("#gate-msg");
    if (!result.ok) {
      // A valid code that is too young for this title, or that is linked to
      // another device, is not a failed guess.
      const counts = !["setup", "error", "invalid", "age", "other_device", "device"].includes(result.reason);
      if (counts) {
        const lock = recordFailedCode();
        if (lock.until > Date.now()) {
          applyLockUI();
          toast(t("watch.lockoutToast"));
          return;
        }
        const left = Math.max(0, CODE_FAIL_MAX - lock.fails);
        msg.textContent = `${result.message} ${t("watch.triesLeft", { n: left })}`;
        msg.className = "gate-msg error";
        return;
      }
      msg.textContent = result.message;
      msg.className = "gate-msg error";
      return;
    }
    clearCodeLock();
    stopLockTicker();
    setCodeFormEnabled(true);
    // "Remember the code": kept on this device and not asked again, for every
    // title that needs a code (above 50%, or rated 13+). Without it the code
    // opens this title only: the next one that needs a code asks again.
    const remember = Boolean($("#code-remember")?.checked);
    if (remember) setStoredCode(code);
    state.storedIssue = "";
    state.unlocked = true;
    state.needsCode = false;
    msg.textContent = result.message;
    msg.className = "gate-msg ok";
    $("#code-input").value = "";
    // a device that had no code yet has just joined its owner's Linked devices
    // (one that left another code for this one was already there)
    const accepted = remember ? t("watch.codeSaved") : t("watch.codeOk");
    const added = result.linked && !(result.row?.freed || []).length;
    toast(added ? `${accepted} ${t("watch.devAdded")}` : accepted);
    hideGate(); // before playing: a member link refuses to start behind the gate
    playArmed();
  }

  /* The code remembered on this device ("Remember the code") is checked without
     being typed. It only works while it is still linked to this device: once it
     was unlinked in the dashboard, used on another device, deleted or ended, it
     is forgotten and asked again, with the reason. A code that is only too young
     for this title stays for the next one; a network failure changes nothing. */
  async function restoreCode() {
    const stored = getStoredCode();
    if (!stored) return;
    const result = await verifyCode(stored, { ...ageVerifyOptions(), silent: true });
    if (result.ok) {
      state.unlocked = true;
      state.needsCode = false;
      return;
    }
    if (["not_found", "expired", "disabled", "banned", "other_device", "unlinked", "invalid"].includes(result.reason)) {
      clearStoredCode();
    }
    state.storedIssue = result.message;
  }

  function peopleSection(id, title, people, roleKey) {
    const el = $(id);
    if (!people.length) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.innerHTML = `
      <div class="kicker"><span class="eyebrow">${title}</span></div>
      <div class="people-grid">
        ${people
          .map((p) => `
            <a class="person-card" href="${personHref(p.id)}">
              <img src="${photo(p.profile_path, p.name)}" alt="${escapeHtml(p.name)}" loading="lazy" />
              <div>
                <h3>${escapeHtml(p.name)}</h3>
                <p>${escapeHtml(p[roleKey] || "")}</p>
              </div>
            </a>
          `)
          .join("")}
      </div>
    `;
  }

  function railSection(id, kicker, title, items, type) {
    const el = $(id);
    const list = (items || []).filter((x) => x.poster_path);
    if (!list.length) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.innerHTML = `
      <div class="section-head">
        <div>
          <div class="kicker"><span class="eyebrow">${kicker}</span></div>
          <h2>${title}</h2>
        </div>
      </div>
      <div class="rail-track">
        ${list.map((item) => posterCard(item, type || item.media_type || mediaType)).join("")}
      </div>
    `;
  }

  function renderInfo() {
    const d = state.detail;
    const title = d.title || d.name || "Untitled";
    document.title = `${title} — CineAura`;
    const genres = (d.genres || []).map((g) => g.name).join(" · ") || "—";
    const date = formatDate(d.release_date || d.first_air_date);
    const score = ratingPercent(d.vote_average);
    $("#title-info").hidden = false;
    $("#title-info").innerHTML = `
      <div class="title-poster">
        <img src="${imgUrl(d.poster_path, "w500") || photo(null, title)}" alt="${escapeHtml(title)}" />
      </div>
      <div>
        <div class="title-kicker">
          <span class="media-badge">${mediaType === "tv" ? "TV Series" : "Movie"}</span>
          ${mediaType === "tv" ? `<span class="chip">S${state.season} · E${state.episode}</span>` : ""}
        </div>
        <h1>${escapeHtml(title)}</h1>
        <div class="meta-row">
          <span class="chip score">★ ${ratingText(d.vote_average)} · ${score}%</span>
          <span class="chip">${escapeHtml(date)}</span>
          <span class="chip chip-age" dir="ltr" title="${escapeHtml(ageNoticeText())}">${certChipText(d)}</span>
          <span class="chip">${formatRuntime(currentRuntime())}</span>
          <span class="chip" id="watch-min-chip">${minutesLabel(state.watchMinutes)}</span>
          <span class="chip">${escapeHtml(genres)}</span>
        </div>
        <p class="overview">${escapeHtml(d.overview || t("watch.noSynopsis"))}</p>
        <div class="title-playlist" id="title-playlist"></div>
      </div>
    `;

    const crew = d.credits?.crew || [];
    const directors = crew.filter((c) => c.job === "Director" || c.job === "Series Director");
    const creators = (d.created_by || []).map((c) => ({ ...c, job: "Creator" }));
    const leadCrew = (directors.length ? directors : creators).slice(0, 8);
    peopleSection("#directors-section", directors.length ? "Director" : "Created by", leadCrew, "job");

    const cast = (d.credits?.cast || []).slice(0, 16);
    peopleSection("#cast-section", "Cast", cast, "character");

    railSection("#similar-section", "More like this", "Similar titles", d.similar?.results || [], mediaType);
    railSection("#related-section", "Because you opened this", "Related titles", d.recommendations?.results || [], mediaType);
    renderAgeNotice();
  }

  async function renderCollection() {
    const collection = state.detail?.belongs_to_collection;
    if (!collection?.id) return;
    try {
      const data = await tmdb(`/collection/${collection.id}`);
      const parts = (data.parts || []).sort((a, b) =>
        String(a.release_date || "").localeCompare(String(b.release_date || ""))
      );
      const index = parts.findIndex((p) => p.id === Number(mediaId));
      const labeled = parts.map((p, i) => {
        const card = posterCard(p, "movie");
        if (i === index) return card.replace('class="poster-card"', 'class="poster-card current-part"');
        return card;
      });
      const prev = index > 0 ? parts[index - 1] : null;
      const next = index >= 0 && index < parts.length - 1 ? parts[index + 1] : null;
      const el = $("#collection-section");
      el.hidden = false;
      el.innerHTML = `
        <div class="section-head">
          <div>
            <div class="kicker"><span class="eyebrow">Saga</span></div>
            <h2>${escapeHtml(data.name || t("watch.collection"))}</h2>
          </div>
          <p>${prev ? `Previous: ${escapeHtml(prev.title)}` : "This is the first part."}${next ? ` · Next: ${escapeHtml(next.title)}` : ""}</p>
        </div>
        <div class="rail-track">${labeled.join("")}</div>
      `;
    } catch {
      /* optional */
    }
  }

  // The link of this page: everything a visitor needs to land on the same
  // title, episode and playlist. Used for the address bar and for sharing.
  function canonicalUrl() {
    const url = new URL(location.href);
    url.search = "";
    if (mediaType === "tv") {
      url.searchParams.set("tv", mediaId);
      url.searchParams.set("season", String(state.season));
      url.searchParams.set("episode", String(state.episode));
    } else {
      url.searchParams.set("movie", mediaId);
    }
    // Keep post/playlist attribution across season & episode changes.
    if (state.postId) url.searchParams.set("post", state.postId);
    const pl = params.get("Playlist") || params.get("playlist");
    if (pl) url.searchParams.set("Playlist", pl);
    return url;
  }

  function syncUrl() {
    history.replaceState({}, "", canonicalUrl());
  }

  // Share row under the player. The shared link keeps its parameters, e.g.
  // /watch.html?tv=34587&season=1&episode=1&Playlist=IDP104059407
  function renderShareRow() {
    const el = $("#watch-share");
    if (!el) return;
    const d = state.detail || {};
    const title = d.title || d.name || "";
    const text =
      mediaType === "tv"
        ? `${title} — S${state.season} · E${state.episode} · CineAura`
        : `${title} · CineAura`;
    el.innerHTML = shareRowHtml(`${location.pathname}${canonicalUrl().search}`, text);
  }

  async function loadSeason(seasonNumber, preferredEpisode) {
    // Another episode: what played stops, the play button starts its main link
    // and its preview time starts again.
    stopTimer();
    stopEmbed();
    state.playLink = null;
    state.playingLink = null;
    state.previewLeft = PREVIEW_MS;
    const data = await tmdb(`/tv/${mediaId}/season/${seasonNumber}`);
    state.season = seasonNumber;
    state.episodes = data.episodes || [];
    const exists = state.episodes.some((e) => e.episode_number === preferredEpisode);
    if (exists) {
      state.episode = preferredEpisode;
    } else if (preferredEpisode >= 9999) {
      state.episode = state.episodes[state.episodes.length - 1]?.episode_number || 1;
    } else {
      state.episode = state.episodes[0]?.episode_number || 1;
    }
    const seasonSelect = $("#season-select");
    const episodeSelect = $("#episode-select");
    seasonSelect.innerHTML = state.seasons
      .map(
        (s) =>
          `<option value="${s.season_number}" ${s.season_number === state.season ? "selected" : ""}>${escapeHtml(s.name || `Season ${s.season_number}`)}</option>`
      )
      .join("");
    episodeSelect.innerHTML = state.episodes
      .map(
        (e) =>
          `<option value="${e.episode_number}" ${e.episode_number === state.episode ? "selected" : ""}>E${e.episode_number} · ${escapeHtml(e.name || "Episode")}</option>`
      )
      .join("");
    syncUrl();
    setIdleArt();
    await loadWatchMinutes();
    renderInfo();
    await renderWatchExtras();
    stopTimer();
    stopEmbed();
    hideGate();
    showIdle();
  }

  function stepEpisode(delta) {
    const list = state.episodes;
    const idx = list.findIndex((e) => e.episode_number === state.episode);
    const nextIdx = idx + delta;
    if (nextIdx >= 0 && nextIdx < list.length) {
      loadSeason(state.season, list[nextIdx].episode_number);
      return;
    }
    const sIdx = state.seasons.findIndex((s) => s.season_number === state.season);
    const nextSeason = state.seasons[sIdx + delta];
    if (!nextSeason) {
      toast(delta > 0 ? t("watch.lastEp") : t("watch.firstEp"));
      return;
    }
    loadSeason(nextSeason.season_number, delta > 0 ? 1 : 9999);
  }

  function bind() {
    setupChrome();
    $("#play-btn").addEventListener("click", onPlay);
    $("#countdown-enter").addEventListener("click", lockPlayer);
    $("#unlock-btn").addEventListener("click", submitCode);
    $("#code-input").addEventListener("input", (e) => {
      e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6);
    });
    $("#code-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitCode();
    });
    $("#prev-ep").addEventListener("click", () => stepEpisode(-1));
    $("#next-ep").addEventListener("click", () => stepEpisode(1));
    $("#season-select").addEventListener("change", (e) => {
      loadSeason(Number(e.target.value), 1);
    });
    $("#episode-select").addEventListener("change", (e) => {
      loadSeason(state.season, Number(e.target.value));
    });
    // Site Settings (or the first IP lookup) may change the region.
    document.addEventListener("cineaura:geo", () => {
      state.providerRegion = pickProviderRegion(currentCountry());
      if (state.providers !== null) {
        renderProviders();
        loadProviderOffers(state.providerRegion);
      }
    });
  }

  async function init() {
    bind();
    if (!mediaId) {
      $("#page-loader")?.remove();
      $("#watch-root").innerHTML = `<div class="glass page-error"><h2>${t("watch.nothing")}</h2><p>${t("watch.openCat")}</p><a class="btn btn-lg btn-primary" href="./">${t("watch.backHome")}</a></div>`;
      return;
    }

    try {
      const path =
        mediaType === "movie"
          ? `/movie/${mediaId}?append_to_response=credits,similar,recommendations,release_dates`
          : `/tv/${mediaId}?append_to_response=credits,similar,recommendations,content_ratings`;
      state.detail = await tmdb(path);
      state.ageInfo = titleAge(state.detail, { mediaType });
      // A code is asked for a title scored above 50% on TMDB, and always for a
      // title rated 13+ (13+, 16+, 18+) whatever its score, so a child's
      // restricted code cannot open it (titleNeedsCode in common.js).
      state.needsCode = titleNeedsCode(state.detail, state.ageInfo);
      // the remembered code is only checked (and its device link) where a code is needed
      if (state.needsCode) await restoreCode();
      await loadMySanctions();
      await loadPostOwner();
      if (state.unlocked) state.needsCode = false;

      if (mediaType === "tv") {
        state.seasons = (state.detail.seasons || []).filter((s) => s.season_number > 0);
        if (!state.seasons.length) state.seasons = [{ season_number: 1, name: "Season 1" }];
        const hasSeason = state.seasons.some((s) => s.season_number === state.season);
        if (!hasSeason) state.season = state.seasons[0].season_number;
        $("#episode-bar").classList.add("show");
        await loadSeason(state.season, state.episode);
      } else {
        setIdleArt();
        await loadWatchMinutes();
        renderInfo();
        await renderWatchExtras();
      }

      renderCollection();
      const session = getSession && getSession();
      if (session?.member_id && supabaseRequest) {
        supabaseRequest("/rest/v1/hestory", {
          method: "POST",
          body: JSON.stringify({
            tmdb_id: Number(mediaId),
            media_type: mediaType,
            visitor_id: session.member_id,
            title: state.detail.title || state.detail.name || "",
            poster_path: state.detail.poster_path || "",
          }),
        }).catch(() => {});
      }
      if (state.storedIssue && state.needsCode) {
        /* verified on play / gate */
      }
    } catch (error) {
      console.error(error);
      toast(t("watch.loadFail"));
      $("#watch-root").insertAdjacentHTML(
        "afterbegin",
        `<div class="glass page-error"><h2>${t("watch.unavail")}</h2><p>${t("watch.tmdbFail")}</p><a class="btn btn-lg btn-primary" href="./">${t("watch.backHome")}</a></div>`
      );
    } finally {
      $("#page-loader")?.remove();
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
