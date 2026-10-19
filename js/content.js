/* CineAura — Content.html: member videos (sql/content.sql).

   Content.html (no video): the search box (it opens Search.html) and under it the
   50 videos with the most watched minutes, the most recommendations or the most
   shares (?top=minutes | likes | shares), plus the sponsored offers (js/offers.js).

   Content.html?idcontent=CT…: one video. Under the player: the title, the numbers,
   the publisher, recommend / don't recommend, share, add to a playlist, the
   description, the sponsored offers (on a narrow screen) and the comments. On the
   side: the sponsored offers (on a wide screen), then suggestions — the same tags,
   language and publisher first, else the same country (content_suggest). A search
   box on top opens Search.html.

   A video rated 13+ (13+, 16+, 18+) asks for a watch code before it plays, for
   everybody: content_get leaves its link out and content_unlock gives it for a code
   whose age tier reaches the rating. "Remember the code" keeps the code in this
   browser and links this device to it (Dashboard > Codes > Linked devices), so it is
   not asked again here — on this page, the watch page and the premium channels.
   Three wrong codes lock code entry for 24 hours (shared with the watch page).

   Every minute that plays counts (js/watch-clock.js: the tab is visible, the
   window has focus, the browser is online and the video is playing) and earns
   points for the viewer and the publisher; so do a share, a comment and a
   positive recommendation (sql/content.sql explains the rates).
*/
(() => {
  "use strict";
  const C = window.CineAura;
  const V = window.CineAuraVideos;
  const { t, escapeHtml: esc, toast } = C;

  const params = new URLSearchParams(location.search);
  const state = {
    id: String(params.get("idcontent") || params.get("id") || "").trim(),
    data: null,
    info: null,
    playing: false,
    clock: null,
    minutes: 0,
    comments: [],
    replyTo: null,
    hls: null,
    ytListening: false,
    unlocked: false, // a 13+ video opened with a watch code
    codeIssue: "", // why the remembered code didn't open it (shown in the code box)
    lockTimer: 0,
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const ICON = {
    up: '<path d="M7 11v9H4v-9zM7 11l4-7c1.7 0 2.6 1.2 2.2 2.8L12.6 10H19a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 17.8 20H7"/>',
    down: '<path d="M7 13V4H4v9zM7 13l4 7c1.7 0 2.6-1.2 2.2-2.8L12.6 14H19a2 2 0 0 0 2-2.3l-1.2-6A2 2 0 0 0 17.8 4H7"/>',
    share: '<path d="M15 5l5 5-5 5"/><path d="M20 10h-9a6 6 0 0 0-6 6v3"/>',
    pl: '<path d="M4 6h11M4 11h11M4 16h7"/><path d="M17 13v7M13.5 16.5h7"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    ext: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
    flag: '<path d="M5 21V4"/><path d="M5 4.5h11.5l-2.2 4 2.2 4H5"/>',
    star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  };
  const icon = (k, size = 18) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON[k]}</svg>`;

  // ---------------------------------------------------------------- page states
  function showError(reason) {
    const known = ["not_found", "private", "scheduled", "gone", "setup", "load"];
    const key = known.includes(reason) ? reason : "not_found";
    document.title = `${t(`vid.err.page.${key}`)} — CineAura`;
    $("#vw-main").innerHTML = `
      <div class="glass vw-error">
        <span class="vw-error-ico">${icon(key === "private" ? "lock" : key === "scheduled" ? "clock" : "ext", 28)}</span>
        <h1>${esc(t(`vid.err.page.${key}`))}</h1>
        <p class="muted">${esc(t(`vid.err.pageText.${key}`))}</p>
        <div class="vw-error-actions">
          <a class="btn btn-lg btn-primary" href="./Search.html">${esc(t("vid.browse"))}</a>
          ${key === "private" && !V.memberId() ? `<a class="btn btn-lg btn-ghost" href="./login.html?next=${encodeURIComponent(location.pathname.replace(/^\//, "") + location.search)}">${esc(t("common.signin"))}</a>` : ""}
        </div>
      </div>`;
    $("#vw-side").hidden = true;
  }

  // ---------------------------------------------------------------- player
  const AGE_CONFIRM_KEY = "cineaura_age_ok";
  function ageConfirmed(age) {
    try {
      return Number(sessionStorage.getItem(AGE_CONFIRM_KEY) || 0) >= age;
    } catch {
      return false;
    }
  }

  function posterHtml(c) {
    return `<div class="vw-poster">
        ${c.thumb ? `<img src="${esc(c.thumb)}" alt="" data-vthumb />` : ""}
        <span class="vw-poster-ph" style="--vh:${Math.abs([...String(c.id)].reduce((a, ch) => a + ch.charCodeAt(0), 0)) % 360}" aria-hidden="true"></span>
      </div>`;
  }

  function lockedHtml(c, why) {
    const next = encodeURIComponent(location.pathname.replace(/^\//, "") + location.search);
    const owner = state.data.owner || {};
    const actions = {
      signin: `<a class="btn btn-lg btn-primary" href="./login.html?next=${next}">${esc(t("common.signin"))}</a><a class="btn btn-lg btn-ghost" href="./register.html">${esc(t("nav.signup"))}</a>`,
      followers: `<a class="btn btn-lg btn-primary" href="${C.profileHref(owner.username)}">${esc(t("vid.lockAct.followers", { name: owner.username || "" }))}</a>`,
      premium: `<a class="btn btn-lg btn-primary" href="./activate.html">${esc(t("set.upgrade"))}</a>`,
      country: "",
      age: "",
    };
    return `${posterHtml(c)}
      <div class="vw-gate" role="alert">
        <span class="vw-gate-ico">${why === "age" ? `<b>${esc(V.ageLabel(c.age))}</b>` : icon("lock", 26)}</span>
        <h2>${esc(t(`vid.lockTitle.${why}`, { n: c.age }))}</h2>
        <p>${esc(t(`vid.lockText.${why}`, { n: c.age, name: owner.username || "", countries: countriesText(c.excl_countries) }))}</p>
        <div class="vw-gate-actions">${actions[why] || ""}</div>
      </div>`;
  }

  function countriesText(list) {
    const names = String(list || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((cc) => V.regionLabel(cc));
    try {
      return new Intl.ListFormat(C.getLocale(), { style: "long", type: "disjunction" }).format(names);
    } catch {
      return names.join(", ");
    }
  }

  function playerIdleHtml(c) {
    const age = Number(c.age) || 3;
    // the watch code replaced it (content.code); kept for a database without content_unlock
    if (c.code === undefined && !V.memberId() && age >= 16 && !ageConfirmed(age)) {
      return `${posterHtml(c)}
        <div class="vw-gate" role="dialog" aria-labelledby="vw-age-h">
          <span class="vw-gate-ico"><b>${esc(V.ageLabel(age))}</b></span>
          <h2 id="vw-age-h">${esc(t("vid.ageTitle", { n: age }))}</h2>
          <p>${esc(t("vid.ageText", { n: age }))}</p>
          <div class="vw-gate-actions">
            <button class="btn btn-lg btn-primary" type="button" data-age-ok>${esc(t("vid.ageYes", { n: age }))}</button>
            <a class="btn btn-lg btn-ghost" href="./Search.html">${esc(t("vid.ageNo"))}</a>
          </div>
        </div>`;
    }
    return `${posterHtml(c)}
      <button class="vw-play" type="button" data-play aria-label="${esc(t("vid.play"))}">
        <span class="vw-play-orb"><svg width="30" height="30" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 2.2L13.2 8L4 13.8V2.2Z"/></svg></span>
        <span class="vw-play-txt">${esc(t("vid.play"))}</span>
      </button>`;
  }

  // ---------------------------------------------------------------- watch code (13+)
  const gated = () => state.data?.access === "ok" && state.data.content.code === true && !state.data.content.url;

  function codeGateHtml(c) {
    const age = Number(c.age) || 13;
    const create = V.memberId() ? "./dashboard.html#codes" : `./login.html?next=${encodeURIComponent("dashboard.html#codes")}`;
    return `${posterHtml(c)}
      <div class="vw-gate vw-codegate" role="group" aria-labelledby="vw-code-h">
        <span class="vw-gate-ico"><b>${esc(V.ageLabel(age))}</b></span>
        <h2 id="vw-code-h">${esc(t("vid.code.title"))}</h2>
        <p>${esc(t("vid.code.text", { n: age }))}</p>
        <p class="vw-code-need">${esc(t("vid.code.need", { n: age, need: t(C.tierForAge(age).label) }))}</p>
        <form class="vw-code-form" id="vw-code-form" novalidate>
          <p class="gate-msg vw-code-msg${state.codeIssue ? " error" : ""}" id="vw-code-msg" role="alert">${esc(state.codeIssue)}</p>
          <input class="pin-input" id="vw-code" name="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" placeholder="••••••" dir="ltr" aria-label="${esc(t("vid.code.label"))}" aria-describedby="vw-code-msg" />
          <label class="gate-remember" for="vw-code-remember">
            <input type="checkbox" id="vw-code-remember" />
            <span><b>${esc(t("watch.remember"))}</b><small>${esc(t("watch.rememberHint"))}</small></span>
          </label>
          <div class="vw-gate-actions">
            <button class="btn btn-lg btn-primary" id="vw-code-go" type="submit">${esc(t("watch.gateEnter"))}</button>
            <a class="btn btn-lg btn-ghost" href="${create}">${esc(t("watch.gateCreate"))}</a>
          </div>
        </form>
      </div>`;
  }

  function setCodeMsg(text, kind = "error") {
    const msg = $("#vw-code-msg");
    if (!msg) return;
    msg.textContent = text || "";
    msg.className = `gate-msg vw-code-msg${text ? ` ${kind}` : ""}`;
  }

  const lockClock = (ms) => {
    const sec = Math.max(0, Math.ceil(ms / 1000));
    return [Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), sec % 60].map((n) => String(n).padStart(2, "0")).join(":");
  };

  // Three wrong codes in a row: code entry is locked for 24 hours (common.js, shared
  // with the watch page). True while it is locked.
  function paintLock() {
    const input = $("#vw-code");
    const btn = $("#vw-code-go");
    if (!input || !btn) {
      clearInterval(state.lockTimer);
      state.lockTimer = 0;
      return false;
    }
    const left = C.codeLockLeft();
    if (left <= 0) {
      input.disabled = false;
      btn.disabled = false;
      if (state.lockTimer) {
        clearInterval(state.lockTimer);
        state.lockTimer = 0;
        setCodeMsg(t("watch.lockoutOver"), "ok");
      }
      return false;
    }
    input.disabled = true;
    btn.disabled = true;
    setCodeMsg(t("watch.lockout", { time: lockClock(left) }), "error");
    if (!state.lockTimer) state.lockTimer = setInterval(paintLock, 1000);
    return true;
  }

  // content_unlock: the code against this video and this device.
  // -> { ok: true, url, linked, freed } | { ok: false, reason, message }
  async function unlock(code, { silent = false, link = false } = {}) {
    const clean = String(code || "").replace(/\D/g, "");
    if (!/^\d{6}$/.test(clean)) return { ok: false, reason: "invalid", message: t("code.invalid") };
    const age = Number(state.data.content.age) || 13;
    const args = {
      p_id: state.id,
      p_member: V.memberId(),
      p_code: clean,
      p_mac: C.deviceMac(),
      p_name: C.deviceName(),
      p_ip: "",
      p_silent: Boolean(silent),
      p_link: Boolean(link),
    };
    const res = await V.call("content_unlock", args);
    if (!res.ok) return { ok: false, reason: res.setup ? "setup" : "error", message: t(res.setup ? "code.setup" : "code.error") };
    const d = res.data && typeof res.data === "object" ? res.data : {};
    if (d.ok && d.url) {
      // the gateway passed no address on: the browser looks it up (as on the watch page)
      if (d.kept && !d.ip) {
        C.publicIp()
          .then((ip) => {
            if (ip) C.rpc("code_use", { p_code: clean, p_mac: args.p_mac, p_name: args.p_name, p_ip: ip, p_age: age, p_silent: true }).catch(() => {});
          })
          .catch(() => {});
      }
      return { ok: true, url: d.url, linked: Boolean(d.linked), freed: Array.isArray(d.freed) ? d.freed : [] };
    }
    // the video itself went away or is out of reach (not_found is about the code)
    if (d.reason === "access" || d.reason === "no_video") return { ok: false, reason: "access", message: t("vid.actFail") };
    return C.codeFailure(d.reason || "error", d, { silent, requiredAge: age }, clean);
  }

  // The code remembered in this browser opens the video without being typed — while
  // it is still linked to this device. One that was unlinked, used elsewhere, deleted
  // or ended is forgotten (and the box says why); one that is only too young for this
  // video stays for the next one.
  async function tryStoredCode() {
    const stored = C.getStoredCode();
    if (!stored) return;
    const r = await unlock(stored, { silent: true, link: true });
    if (r.ok) {
      state.data.content.url = r.url;
      state.unlocked = true;
      return;
    }
    if (["not_found", "expired", "disabled", "banned", "other_device", "unlinked", "invalid"].includes(r.reason)) C.clearStoredCode();
    if (r.reason !== "error") state.codeIssue = r.message;
  }

  function wireCodeGate() {
    const form = $("#vw-code-form");
    if (!form) return;
    const input = $("#vw-code");
    input.addEventListener("input", () => {
      const digits = input.value.replace(/\D/g, "").slice(0, 6);
      if (digits !== input.value) input.value = digits;
    });
    form.addEventListener("submit", submitCode);
    paintLock();
  }

  async function submitCode(e) {
    e.preventDefault();
    if (paintLock()) {
      toast(t("watch.lockoutToast"));
      return;
    }
    const input = $("#vw-code");
    const btn = $("#vw-code-go");
    const code = input.value.replace(/\D/g, "");
    const remember = Boolean($("#vw-code-remember")?.checked);
    btn.disabled = true;
    const r = await unlock(code, { silent: false, link: remember });
    btn.disabled = false;
    if (!r.ok) {
      // a valid code that is too young, or linked to another device, is not a wrong guess
      const counts = !["setup", "error", "invalid", "age", "other_device", "device", "access"].includes(r.reason);
      if (counts) {
        const lock = C.recordFailedCode();
        if (lock.until > Date.now()) {
          paintLock();
          toast(t("watch.lockoutToast"));
          return;
        }
        setCodeMsg(`${r.message} ${t("watch.triesLeft", { n: Math.max(0, C.CODE_FAIL_MAX - lock.fails) })}`);
      } else {
        setCodeMsg(r.message);
      }
      input.focus();
      input.select();
      return;
    }
    C.clearCodeLock();
    // remembered: not asked again in this browser, for every video, title or channel that needs a code
    if (remember) C.setStoredCode(code);
    state.codeIssue = "";
    const accepted = remember ? t("watch.codeSaved") : t("watch.codeOk");
    toast(r.linked && !r.freed.length ? `${accepted} ${t("watch.devAdded")}` : accepted);
    applyUnlock(r.url);
    startPlayback();
  }

  function applyUnlock(url) {
    state.data.content.url = url;
    state.unlocked = true;
    state.info = V.parseVideo(url);
    const box = $("#vw-player");
    if (box) {
      box.classList.remove("is-gated");
      box.innerHTML = playerIdleHtml(state.data.content);
    }
    const under = $(".vw-under");
    if (under) under.innerHTML = underHtml();
  }

  function setPlaying(on) {
    state.playing = Boolean(on);
    $("#vw-player")?.classList.toggle("is-playing", state.playing);
  }

  function loadHls() {
    if (window.Hls) return Promise.resolve(window.Hls);
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "js/vendor/hls.min.js";
      s.onload = () => (window.Hls ? resolve(window.Hls) : reject(new Error("hls")));
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // YouTube reports its state through postMessage once it was told somebody listens
  // (what its iframe API does): 1 = playing, 2 = paused, 0 = ended, 3 = buffering.
  function listenYouTube(frame) {
    const ping = () => {
      try {
        frame.contentWindow.postMessage(JSON.stringify({ event: "listening", id: 1, channel: "widget" }), "*");
      } catch {
        /* not ready yet */
      }
    };
    frame.addEventListener("load", () => {
      ping();
      setTimeout(ping, 800);
      setTimeout(ping, 2500);
    });
    if (state.ytListening) return;
    state.ytListening = true;
    window.addEventListener("message", (e) => {
      let host = "";
      try {
        host = new URL(e.origin).hostname;
      } catch {
        return;
      }
      if (!/(^|\.)youtube(-nocookie)?\.com$/.test(host)) return;
      let data = e.data;
      try {
        if (typeof data === "string") data = JSON.parse(data);
      } catch {
        return;
      }
      if (data?.event === "onError") return showYtError(Number(data.info));
      const st = data?.event === "onStateChange" ? data.info : data?.info?.playerState;
      if (typeof st !== "number") return;
      setPlaying(st === 1);
    });
  }

  // YouTube could not play the video here: what it said, under the player (never over it), and
  // the video on YouTube itself. 153 = the site did not reach YouTube in the Referer (a privacy
  // extension or setting of the browser); 101/150 = the owner keeps it off other sites.
  function showYtError(code) {
    const under = $(".vw-under");
    const info = state.info;
    if (!under || !info || info.provider !== "youtube") return;
    setPlaying(false);
    const key = code === 153 ? "vid.yt153" : code === 101 || code === 150 ? "vid.ytNoEmbed" : code === 100 ? "vid.ytGone" : "vid.ytError";
    const href = `https://www.youtube.com/watch?v=${encodeURIComponent(info.id)}${info.start ? `&t=${info.start}s` : ""}`;
    under.querySelector(".vw-yt-error")?.remove();
    under.insertAdjacentHTML("afterbegin", `<p class="vw-yt-error" role="alert"><span>${esc(t(key, { code: Number.isFinite(code) ? code : "?" }))}</span>
      <a class="vw-open" href="${esc(href)}" target="_blank" rel="noopener">${icon("ext", 14)}<span>${esc(t("vid.ytOpen"))}</span></a></p>`);
  }

  async function startPlayback() {
    const box = $("#vw-player");
    const c = state.data.content;
    const info = state.info;
    if (!box || !info || gated()) return;
    box.classList.add("is-started");
    if (info.provider === "file" || info.provider === "hls") {
      box.innerHTML = `<video class="vw-video" controls playsinline preload="metadata" ${c.thumb ? `poster="${esc(c.thumb)}"` : ""}></video>`;
      const video = box.querySelector("video");
      video.addEventListener("playing", () => setPlaying(true));
      ["pause", "ended", "waiting", "error", "emptied"].forEach((ev) => video.addEventListener(ev, () => setPlaying(false)));
      if (info.provider === "hls" && !video.canPlayType("application/vnd.apple.mpegurl")) {
        try {
          const Hls = await loadHls();
          if (Hls.isSupported()) {
            state.hls = new Hls({ enableWorker: true });
            state.hls.loadSource(info.url);
            state.hls.attachMedia(video);
          } else {
            video.src = info.url;
          }
        } catch {
          video.src = info.url;
        }
      } else {
        video.src = info.url;
      }
      video.play().catch(() => {});
    } else {
      $(".vw-under .vw-yt-error")?.remove();
      const src = V.embedSrc(info, { autoplay: true });
      box.innerHTML = `<iframe class="vw-frame" src="${esc(src)}" title="${esc(c.title)}" allow="autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write; web-share" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
      const frame = box.querySelector("iframe");
      if (info.provider === "youtube") listenYouTube(frame);
      // until (or unless) the player says otherwise, a shown player counts as playing
      setPlaying(true);
    }
    startClock();
  }

  function startClock() {
    if (state.clock || !window.CineAuraWatchClock) return;
    state.clock = window.CineAuraWatchClock.createWatchClock({
      isActive: () =>
        state.playing && document.visibilityState === "visible" && document.hasFocus() && navigator.onLine !== false,
      onMinute: creditMinute,
    });
    state.clock.start();
  }

  async function creditMinute() {
    // Watch without ads (Site Settings) counts no minutes, here as on the watch page.
    try {
      if (await C.adFreeActive()) return;
    } catch {
      /* counting goes on */
    }
    const res = await V.call("content_minute", { p_id: state.id, p_viewer: V.viewerId(), p_country: await V.geoCountry() });
    if (!res.ok || !res.data?.ok) return;
    state.minutes += 1;
    const chip = $("#vw-minutes");
    if (chip) {
      chip.hidden = false;
      chip.querySelector("span").textContent = t("vid.minutesCounted", { n: state.minutes });
    }
    const me = res.data.viewer;
    if (me && Number(me.level_after) > Number(me.level)) {
      toast(t("points.levelUp", { level: C.levelName(me.level_after), n: C.levelMultiplier(me.level_after) }));
    }
  }

  // ---------------------------------------------------------------- the page
  function linkify(text) {
    return esc(text).replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer nofollow">${u}</a>`);
  }

  function chip(text, cls = "") {
    return `<span class="vw-chip ${cls}">${esc(text)}</span>`;
  }

  // Under the player: the minutes counted, "Open on …" for a link that is not a known player.
  function underHtml() {
    const openable = state.data.access === "ok" && state.info && !["youtube", "vimeo", "dailymotion"].includes(state.info.provider);
    return `<span class="vw-minutes" id="vw-minutes"${state.minutes ? "" : " hidden"}>${icon("clock", 14)}<span>${state.minutes ? esc(t("vid.minutesCounted", { n: state.minutes })) : ""}</span></span>
        ${openable ? `<a class="vw-open" href="${esc(state.info.url)}" target="_blank" rel="noopener noreferrer">${icon("ext", 14)}<span>${esc(t("vid.openOn", { host: state.info.host }))}</span></a>` : ""}`;
  }

  function render() {
    const { content: c, owner, access, mine } = state.data;
    document.title = `${c.title} — CineAura`;
    state.info = c.url ? V.parseVideo(c.url) : null;
    const needCode = gated();
    const href = V.contentHref(c.id);
    const chips = [
      Number(c.age) > 3 ? chip(V.ageLabel(c.age), "is-age") : "",
      c.visibility !== "public" ? chip(V.visLabel(c.visibility), `is-${c.visibility}`) : "",
      c.language ? chip(V.langLabel(c.language)) : "",
      c.country ? chip(V.regionLabel(c.country)) : "",
    ].join("");
    $("#vw-main").innerHTML = `
      <div class="vw-player${needCode ? " is-gated" : ""}" id="vw-player">${access !== "ok" ? lockedHtml(c, access) : needCode ? codeGateHtml(c) : playerIdleHtml(c)}</div>
      <div class="vw-under">${underHtml()}</div>
      <h1 class="vw-title">${esc(c.title)}</h1>
      ${c.suspended ? `<div class="vw-suspended" role="status">${icon("lock", 16)}<p><b>${esc(t("vid.suspendedOwner"))}</b> ${esc(t("vid.suspendedWhy", { reason: c.suspended.reason || "" }))}</p></div>` : ""}
      <div class="vw-meta">
        <span>${esc(t("vid.viewsN", { n: V.fmtNum(c.views) }))}</span>
        <span aria-hidden="true">·</span>
        <time datetime="${esc(c.publish_at)}" title="${esc(V.fullDate(c.publish_at))}">${esc(V.timeAgo(c.publish_at))}</time>
        ${chips}
      </div>
      <div class="vw-bar">
        <a class="vw-owner" href="${C.profileHref(owner.username)}#videos">
          <img src="${esc(owner.avatar_url || C.initialsAvatar(owner.display_name || owner.username || "CA"))}" alt="" data-avatar-for="${esc(owner.id || "")}" data-avatar-name="${esc(owner.username || "")}" />
          <span class="vw-owner-txt">
            <b>${esc(owner.display_name || `@${owner.username}`)}</b>
            <small><bdi>@${esc(owner.username)}</bdi> · ${esc(t("vid.followersN", { n: V.fmtNum(owner.followers) }))}</small>
          </span>
        </a>
        <div class="vw-actions">
          <div class="vw-votes" role="group" aria-label="${esc(t("vid.recsLabel"))}">
            <button class="vw-vote" type="button" data-vote="1" aria-pressed="false" title="${esc(t("vid.recommend"))}">${icon("up")}<span data-likes>${esc(V.fmtCount(c.likes))}</span><span class="sr-only">${esc(t("vid.recommend"))}</span></button>
            <button class="vw-vote" type="button" data-vote="-1" aria-pressed="false" title="${esc(t("vid.notRecommend"))}">${icon("down")}<span data-dislikes>${esc(V.fmtCount(c.dislikes))}</span><span class="sr-only">${esc(t("vid.notRecommend"))}</span></button>
          </div>
          <button class="btn btn-sm btn-ghost vw-btn" type="button" id="vw-share-btn" aria-expanded="false" aria-controls="vw-share">${icon("share", 16)}<span>${esc(t("share.title"))}</span></button>
          <button class="btn btn-sm btn-ghost vw-btn" type="button" id="vw-pl-btn">${icon("pl", 16)}<span>${esc(t("vid.addToPl"))}</span></button>
          ${mine ? `<a class="btn btn-sm btn-ghost vw-btn" href="./Profile.html#content/manage">${icon("edit", 16)}<span>${esc(t("vid.manage"))}</span></a>` : ""}
          ${access === "ok" ? `
          <a class="btn btn-sm btn-ghost vw-btn" id="vw-rec-btn" href="./Profile.html#create/recommendation/${encodeURIComponent(c.id)}">${icon("star", 16)}<span>${esc(t("vid.recPost"))}</span></a>
          <a class="btn btn-sm btn-ghost vw-btn" id="vw-rev-btn" href="./Profile.html#create/review/${encodeURIComponent(c.id)}">${icon("edit", 16)}<span>${esc(t("vid.reviewPost"))}</span></a>` : ""}
          ${mine ? "" : `<button class="btn btn-sm btn-ghost vw-btn vw-report" type="button" id="vw-report-btn">${icon("flag", 16)}<span>${esc(t("rep.btn"))}</span></button>`}
        </div>
      </div>
      <div class="glass vw-share" id="vw-share" hidden>${C.shareRowHtml(href, c.title, { label: t("vid.shareLabel") })}</div>
      <section class="glass vw-desc">
        <div class="vw-desc-text${String(c.description || "").length > 420 ? " is-long" : ""}" id="vw-desc-text">${c.description ? linkify(c.description) : `<span class="muted">${esc(t("vid.noDesc"))}</span>`}</div>
        ${String(c.description || "").length > 420 ? `<button class="vw-more" type="button" id="vw-more" aria-expanded="false">${esc(t("vid.showMore"))}</button>` : ""}
        ${Array.isArray(c.tags) && c.tags.length ? `<div class="vw-tags">${c.tags.map((x) => `<a href="${V.searchHref({ tag: x })}"><bdi>#${esc(x)}</bdi></a>`).join("")}</div>` : ""}
        <p class="vw-desc-foot muted">${esc(t("vid.publishedOn", { date: V.fullDate(c.publish_at) }))} · <a href="${V.searchHref({ owner: owner.username })}">${esc(t("vid.moreFrom", { name: owner.username }))}</a></p>
      </section>
      <div class="vw-offers vw-offers--inline" id="vw-offers-m" hidden></div>
      <section class="vw-comments" id="comments" aria-labelledby="vw-com-h">
        <h2 id="vw-com-h">${esc(t("vid.comments"))} <span class="vw-count" id="vw-com-count">${access === "ok" ? esc(V.fmtNum(c.comments)) : ""}</span></h2>
        <div id="vw-com-body">${access === "ok" ? `<p class="muted">${esc(t("common.loading"))}</p>` : `<p class="muted">${esc(t("vid.commentsLocked"))}</p>`}</div>
      </section>`;
    C.hydrateAvatars($("#vw-main"));
    paintVote();
    wire();
    if (needCode) wireCodeGate();
    if (access === "ok") {
      V.track([c.id], "view");
      loadComments();
    }
  }

  function paintVote() {
    const v = Number(state.data.my_vote || 0);
    document.querySelectorAll("[data-vote]").forEach((b) => {
      const on = Number(b.dataset.vote) === v;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", String(on));
    });
  }

  function wire() {
    const main = $("#vw-main");
    main.addEventListener("click", async (e) => {
      if (e.target.closest("[data-play]")) {
        if (gated()) return $("#vw-code")?.focus();
        startPlayback();
        return;
      }
      if (e.target.closest("[data-age-ok]")) {
        try {
          sessionStorage.setItem(AGE_CONFIRM_KEY, String(Number(state.data.content.age) || 18));
        } catch {
          /* asked again next time */
        }
        $("#vw-player").innerHTML = playerIdleHtml(state.data.content);
        $("#vw-player [data-play]")?.focus();
        return;
      }
      const voteBtn = e.target.closest("[data-vote]");
      if (voteBtn) {
        vote(Number(voteBtn.dataset.vote), voteBtn);
        return;
      }
      if (e.target.closest("#vw-share-btn")) {
        const box = $("#vw-share");
        box.hidden = !box.hidden;
        $("#vw-share-btn").setAttribute("aria-expanded", String(!box.hidden));
        return;
      }
      if (e.target.closest("#vw-pl-btn")) {
        if (state.data.access !== "ok") return toast(t("vid.lockedAction"));
        V.playlistDialog(state.id);
        return;
      }
      if (e.target.closest("#vw-report-btn")) {
        C.reportDialog({ kind: "video", id: state.id, title: state.data.content?.title || "" });
        return;
      }
      if (e.target.closest("#vw-more")) {
        const txt = $("#vw-desc-text");
        const open = txt.classList.toggle("is-open");
        e.target.closest("#vw-more").setAttribute("aria-expanded", String(open));
        e.target.closest("#vw-more").textContent = t(open ? "vid.showLess" : "vid.showMore");
        return;
      }
      // a share: one of the networks, or the copy button (common.js copies the link)
      const share = e.target.closest("#vw-share .share-btn");
      if (share && state.data.access === "ok") {
        const net = share.matches("[data-share-copy]")
          ? "copy"
          : ([...share.classList].find((x) => x.startsWith("share-") && x !== "share-btn") || "share-other").slice(6);
        shareCounted(net);
      }
    });
  }

  async function shareCounted(network) {
    const res = await V.call("content_track", {
      p_ids: [state.id],
      p_kind: "share",
      p_viewer: V.viewerId(),
      p_network: network,
      p_country: await V.geoCountry(),
    });
    const gain = res.ok ? res.data?.points?.viewer?.gain : null;
    if (gain) toast(t("vid.gain", { n: Number(gain).toFixed(2) }));
  }

  async function vote(v, btn) {
    const me = V.memberId();
    if (!me) return toast(t("vid.signToVote"));
    if (state.data.access !== "ok") return toast(t("vid.lockedAction"));
    if (!(await C.guardFeature("posts"))) return;
    const next = Number(state.data.my_vote || 0) === v ? 0 : v;
    btn.disabled = true;
    const res = await V.call("content_vote", { p_member: me, p_id: state.id, p_vote: next, p_country: await V.geoCountry() });
    btn.disabled = false;
    if (!res.ok || res.data?.ok === false) return toast(t(res.data?.reason === "blocked" ? "vid.err.blocked" : "vid.actFail"));
    state.data.my_vote = next;
    state.data.content.likes = res.data.likes;
    state.data.content.dislikes = res.data.dislikes;
    $("[data-likes]").textContent = V.fmtCount(res.data.likes);
    $("[data-dislikes]").textContent = V.fmtCount(res.data.dislikes);
    paintVote();
    const gain = res.data.points?.viewer?.gain;
    if (gain) toast(t("vid.gain", { n: Number(gain).toFixed(2) }));
  }

  // ---------------------------------------------------------------- comments
  async function loadComments() {
    const res = await V.call("content_comments_list", { p_id: state.id, p_member: V.memberId(), p_limit: 300 });
    state.comments = res.ok && Array.isArray(res.data) ? res.data : [];
    drawComments();
    if (location.hash === "#comments") $("#comments")?.scrollIntoView({ block: "start" });
  }

  function commentHtml(k, replies = []) {
    const me = V.memberId();
    return `<li class="vw-com" data-cid="${k.id}">
      <a class="vw-com-av" href="${C.profileHref(k.username)}" tabindex="-1" aria-hidden="true"><img src="${esc(k.avatar_url || C.initialsAvatar(k.username || "CA"))}" alt="" data-avatar-for="${esc(k.member_id || "")}" data-avatar-name="${esc(k.username || "")}" /></a>
      <div class="vw-com-main">
        <div class="vw-com-head">
          <a href="${C.profileHref(k.username)}"><b><bdi>@${esc(k.username)}</bdi></b></a>
          ${k.is_owner ? `<span class="vw-chip is-owner">${esc(t("vid.publisher"))}</span>` : ""}
          <time datetime="${esc(k.created_at)}" title="${esc(V.fullDate(k.created_at))}">${esc(V.timeAgo(k.created_at))}</time>
        </div>
        <p class="vw-com-body">${linkify(k.body)}</p>
        <div class="vw-com-acts">
          ${me && !k.parent_id ? `<button type="button" data-reply="${k.id}">${esc(t("vid.reply"))}</button>` : ""}
          ${k.can_delete ? `<button type="button" data-del-com="${k.id}">${esc(t("vid.delete"))}</button>` : ""}
        </div>
        ${state.replyTo === k.id ? formHtml(k.id) : ""}
        ${replies.length ? `<ul class="vw-com-replies">${replies.map((r) => commentHtml(r)).join("")}</ul>` : ""}
      </div>
    </li>`;
  }

  function formHtml(parent = null) {
    const session = C.getSession();
    return `<form class="vw-com-form" data-parent="${parent || ""}">
      ${C.avatarImg(session.member_id, session.username)}
      <div class="vw-com-field">
        <textarea name="body" rows="${parent ? 2 : 3}" maxlength="2000" placeholder="${esc(t(parent ? "vid.replyPh" : "vid.commentPh"))}" aria-label="${esc(t(parent ? "vid.replyPh" : "vid.commentPh"))}" required></textarea>
        <div class="vw-com-form-acts">
          ${parent ? `<button class="btn btn-sm btn-ghost" type="button" data-cancel-reply>${esc(t("common.cancel"))}</button>` : ""}
          <button class="btn btn-sm btn-primary" type="submit">${esc(t(parent ? "vid.reply" : "vid.comment"))}</button>
        </div>
      </div>
    </form>`;
  }

  function drawComments() {
    const body = $("#vw-com-body");
    if (!body) return;
    const me = V.memberId();
    const top = state.comments.filter((k) => !k.parent_id).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const repliesOf = (id) => state.comments.filter((k) => k.parent_id === id);
    $("#vw-com-count").textContent = V.fmtNum(state.comments.length);
    body.innerHTML = `
      ${me ? formHtml(null) : `<p class="vw-com-signin"><a class="btn btn-sm btn-primary" href="./login.html?next=${encodeURIComponent(location.pathname.replace(/^\//, "") + location.search + "#comments")}">${esc(t("common.signin"))}</a> <span class="muted">${esc(t("vid.signToComment"))}</span></p>`}
      ${top.length ? `<ul class="vw-com-list">${top.map((k) => commentHtml(k, repliesOf(k.id))).join("")}</ul>` : `<p class="muted vw-com-none">${esc(t("vid.noComments"))}</p>`}`;
    C.hydrateAvatars(body);
    body.onsubmit = async (e) => {
      const form = e.target.closest(".vw-com-form");
      if (!form) return;
      e.preventDefault();
      const text = form.elements.body.value.trim();
      if (!text) return form.elements.body.focus();
      if (!(await C.guardFeature("comments"))) return;
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      const res = await V.call("content_comment_add", {
        p_member: me,
        p_id: state.id,
        p_body: text,
        p_parent: form.dataset.parent ? Number(form.dataset.parent) : null,
        p_country: await V.geoCountry(),
      });
      btn.disabled = false;
      if (!res.ok || res.data?.ok === false) {
        const reason = res.data?.reason;
        return toast(t(reason === "slow" ? "vid.err.slow" : reason === "blocked" ? "vid.err.blocked" : reason === "length" ? "vid.err.length" : "vid.actFail"));
      }
      state.replyTo = null;
      const gain = res.data.points?.viewer?.gain;
      toast(gain ? `${t("vid.commented")} ${t("vid.gain", { n: Number(gain).toFixed(2) })}` : t("vid.commented"));
      loadComments();
    };
    body.onclick = async (e) => {
      const reply = e.target.closest("[data-reply]");
      if (reply) {
        state.replyTo = Number(reply.dataset.reply);
        drawComments();
        body.querySelector(`.vw-com[data-cid="${state.replyTo}"] textarea`)?.focus();
        return;
      }
      if (e.target.closest("[data-cancel-reply]")) {
        state.replyTo = null;
        drawComments();
        return;
      }
      const del = e.target.closest("[data-del-com]");
      if (del) {
        const yes = await V.confirmDialog({ title: t("vid.delComTitle"), text: t("vid.delComText"), yes: t("vid.delete"), danger: true });
        if (!yes) return;
        const res = await V.call("content_comment_delete", { p_member: me, p_comment: Number(del.dataset.delCom) });
        if (!res.ok || res.data?.ok === false) return toast(t("vid.actFail"));
        toast(t("vid.comDeleted"));
        loadComments();
      }
    };
  }

  // ---------------------------------------------------------------- suggestions
  async function loadSuggestions() {
    const box = $("#vw-sugg");
    box.innerHTML = `<p class="muted">${esc(t("common.loading"))}</p>`;
    const res = await V.call("content_suggest", { p_id: state.id, p_member: V.memberId(), p_limit: 12 });
    const items = res.ok && Array.isArray(res.data) ? res.data : [];
    box.innerHTML = items.length
      ? items.map((x) => V.cardHtml(x, { compact: true })).join("")
      : `<p class="muted">${esc(t("vid.noSuggestions"))}</p><a class="btn btn-sm btn-ghost" href="./Search.html">${esc(t("vid.browse"))}</a>`;
    V.observeCards(box);
  }

  // ---------------------------------------------------------------- Content.html alone: the 50 most …
  // minutes = watched minutes, likes = recommendations (content_search "recs"), shares
  const TOPS = [
    { key: "minutes", sort: "minutes", icon: "clock" },
    { key: "likes", sort: "recs", icon: "up" },
    { key: "shares", sort: "shares", icon: "share" },
  ];
  const TOP_LIMIT = 50;
  const OFFERS_AFTER = 12; // the offers row comes after this many videos
  const hub = { key: "minutes", cache: {}, seq: 0 };

  function statHtml(key, item) {
    if (key === "likes") return `${icon("up", 14)}<span>${esc(t("vid.hub.statLikes", { n: V.fmtCount(item.likes) }))}</span>`;
    if (key === "shares") return `${icon("share", 14)}<span>${esc(t("vid.hub.statShares", { n: V.fmtCount(item.shares) }))}</span>`;
    return `${icon("clock", 14)}<span>${esc(t("vid.hub.statMinutes", { n: V.fmtCount(item.minutes) }))}</span>`;
  }

  function renderHub() {
    const fromUrl = String(params.get("top") || "").toLowerCase();
    hub.key = TOPS.some((x) => x.key === fromUrl) ? fromUrl : "minutes";
    document.title = `${t("vid.hub.title")} — CineAura`;
    const root = $("#vw-root");
    root.classList.add("is-hub");
    const form = $("#vw-search");
    const layout = root.querySelector(".vw-layout");
    const hero = document.createElement("section");
    hero.className = "glass vh-hero";
    hero.innerHTML = `
      <span class="eyebrow">${esc(t("nav.videos"))}</span>
      <h1>${esc(t("vid.hub.title"))}</h1>
      <p class="muted">${esc(t("vid.hub.lead"))}</p>`;
    if (form) hero.appendChild(form);
    const top = document.createElement("section");
    top.className = "vh-top";
    top.setAttribute("aria-labelledby", "vh-top-h");
    top.innerHTML = `
      <div class="vh-top-head">
        <h2 id="vh-top-h">${esc(t("vid.hub.topTitle", { n: TOP_LIMIT }))}</h2>
        <div class="follow-tabs vh-tabs" role="tablist" aria-label="${esc(t("vid.hub.tabsLabel"))}">
          ${TOPS.map((x) => `<button type="button" role="tab" class="follow-tab" id="vh-tab-${x.key}" data-top="${x.key}" aria-controls="vh-grid">${icon(x.icon, 15)}<span>${esc(t(`vid.hub.tab.${x.key}`))}</span></button>`).join("")}
        </div>
      </div>
      <p class="muted vh-note" id="vh-note"></p>
      <ol class="vgrid vh-grid" id="vh-grid" role="tabpanel" aria-live="polite"></ol>`;
    layout?.replaceWith(hero, top);
    const tabs = top.querySelector(".vh-tabs");
    tabs.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-top]");
      if (btn && btn.dataset.top !== hub.key) selectTop(btn.dataset.top, true);
    });
    // arrows move between the tabs (the tab pattern)
    tabs.addEventListener("keydown", (e) => {
      const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
      if (!keys.includes(e.key)) return;
      e.preventDefault();
      const list = TOPS.map((x) => x.key);
      const rtl = document.documentElement.dir === "rtl";
      let i = list.indexOf(hub.key);
      if (e.key === "Home") i = 0;
      else if (e.key === "End") i = list.length - 1;
      else i = (i + ((e.key === "ArrowRight") !== rtl ? 1 : -1) + list.length) % list.length;
      selectTop(list[i], true);
      tabs.querySelector(`[data-top="${list[i]}"]`)?.focus();
    });
    selectTop(hub.key, false);
  }

  async function selectTop(key, push) {
    hub.key = key;
    document.querySelectorAll(".vh-tabs [data-top]").forEach((b) => {
      const on = b.dataset.top === key;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    const grid = $("#vh-grid");
    grid.setAttribute("aria-labelledby", `vh-tab-${key}`);
    $("#vh-note").textContent = t(`vid.hub.note.${key}`);
    if (push) {
      const q = new URLSearchParams(location.search);
      if (key === "minutes") q.delete("top");
      else q.set("top", key);
      const qs = q.toString();
      history.replaceState(history.state, "", `${location.pathname}${qs ? `?${qs}` : ""}`);
    }
    const seq = (hub.seq += 1);
    if (!hub.cache[key]) {
      grid.setAttribute("aria-busy", "true");
      grid.innerHTML = `<li class="vh-wait"><div class="loader" style="display:grid"><div class="spinner"></div></div></li>`;
      const sort = TOPS.find((x) => x.key === key).sort;
      const res = await V.call("content_search", { p_member: V.memberId(), p_sort: sort, p_limit: TOP_LIMIT });
      if (seq !== hub.seq) return;
      grid.removeAttribute("aria-busy");
      if (!res.ok) {
        grid.innerHTML = `<li class="glass vs-none"><p>${esc(t(res.setup ? "vid.err.pageText.setup" : "vid.err.pageText.load"))}</p></li>`;
        return;
      }
      hub.cache[key] = Array.isArray(res.data?.items) ? res.data.items : [];
    }
    drawTop(key);
  }

  function drawTop(key) {
    const grid = $("#vh-grid");
    const items = hub.cache[key] || [];
    if (!items.length) {
      grid.innerHTML = `<li class="glass vs-none vh-none">
          <p><b>${esc(t("vid.hub.none"))}</b></p>
          <p class="muted">${esc(t("vid.hub.noneText"))}</p>
          <a class="btn btn-lg btn-primary" href="./Profile.html#content">${esc(t("vid.hub.create"))}</a>
        </li>`;
      return;
    }
    const cards = items.map((x, i) => `<li class="vh-item">${V.cardHtml(x, { rank: i + 1, stat: statHtml(key, x) })}</li>`);
    const at = Math.min(OFFERS_AFTER, cards.length);
    cards.splice(at, 0, `<li class="vh-offers" id="vh-offers" hidden></li>`);
    grid.innerHTML = cards.join("");
    V.observeCards(grid);
    window.CineAuraOffers?.mount($("#vh-offers"), { limit: 5, layout: "row" });
  }

  async function boot() {
    C.setupChrome();
    if (!state.id) return renderHub();
    const res = await V.call("content_get", { p_id: state.id, p_member: V.memberId() });
    if (!res.ok) return showError(res.setup ? "setup" : "load");
    if (!res.data?.ok) return showError(res.data?.reason);
    state.data = res.data;
    // 13+: the code remembered in this browser opens it without being typed
    if (gated()) await tryStoredCode();
    render();
    loadSuggestions();
    // the side column on a wide screen; under the description on a narrow one (css/videos.css)
    window.CineAuraOffers?.mount($("#vw-offers"), { limit: 5, layout: "side" });
    window.CineAuraOffers?.mount($("#vw-offers-m"), { limit: 5, layout: "side" });
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
