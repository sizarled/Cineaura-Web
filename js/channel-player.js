/* CineAura channel player — plays one IPTV channel inside a dialog.
 *
 * Used by Listchannels.html (members) and by Panel > Reports > Channels ("Test").
 *
 *   CineAuraChannels.open(channels, index, options)
 *     channels  rows of public.listchannels ({ id, package_name, channel_name,
 *               group_name, logo_url, channel_type, stream_url })
 *     options   { report: true,        show the "Report channel" button
 *                 accounts: [...],     iptv rows of the package (stream lookup)
 *                 onChange(index),     the dialog moved to another channel
 *                 onResult(row, ok),   a channel started (true) or failed (false)
 *                 onClose() }
 *   CineAuraChannels.close()
 *   CineAuraChannels.resolveStream(row, accounts)  -> Promise<stream link | "">
 *     the channel's own link, else the one found in the package playlist
 *
 * Engines, loaded on demand from js/vendor/ the first time a channel opens:
 *   hls.js     HLS (.m3u8); native HLS where Media Source is missing (iPhone)
 *   mpegts.js  MPEG-TS (.ts and Xtream "/user/pass/123") and FLV
 *   <video>    plain files (mp4, webm, …)
 * A stream is tried directly first. When that cannot work — an http stream on
 * the https site, or a server that sends no CORS headers — it goes through
 * /api/stream (server.py). Xtream live channels are tried as HLS as well.
 *
 * "Report channel" writes public.channel_reports (sql/channels.sql), which the
 * staff read in Panel > Reports > Channels. What the player saw (which routes
 * failed and why) travels with the report as error_detail.
 */
(() => {
  const C = window.CineAura;
  if (!C) return;
  const { t, escapeHtml, toast, getSession, supabaseRequest, restValue } = C;

  const VENDOR = {
    hls: ["js/vendor/hls.min.js", "Hls"],
    mpegts: ["js/vendor/mpegts.min.js", "mpegts"],
  };
  const ATTEMPT_MS = 15000;
  const REASONS = ["not_working", "buffering", "wrong", "audio", "other"];

  const ICON = {
    close: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    prev: '<svg class="chp-flip" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
    next: '<svg class="chp-flip" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
    flag: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 22V4"/><path d="M4 4h12l-2 4 2 4H4"/></svg>',
    check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>',
    warn: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l10 18H2L12 3z"/><path d="M12 10v4"/><circle cx="12" cy="17.5" r="0.6" fill="currentColor"/></svg>',
    muted: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M22 9l-6 6M16 9l6 6"/></svg>',
  };

  // ---------- helpers ----------
  const norm = (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  const reportKey = (ch) => `${norm(ch.package_name)}\n${norm(ch.channel_name)}`;

  function initials(name) {
    const words = String(name || "TV").replace(/[^\p{L}\p{N} ]+/gu, " ").trim().split(/\s+/).filter(Boolean);
    return ((words[0]?.[0] || "T") + (words[1]?.[0] || words[0]?.[1] || "V")).toUpperCase();
  }

  // Logo with a lettered fallback when the image is missing or broken.
  function logoHtml(ch, cls) {
    const letters = `<span class="${cls}-letters">${escapeHtml(initials(ch.channel_name))}</span>`;
    const url = String(ch.logo_url || "");
    if (!/^https?:\/\//i.test(url)) return `<span class="${cls}">${letters}</span>`;
    return `<span class="${cls}"><img src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()" />${letters}</span>`;
  }

  function typeLabel(ch) {
    const type = String(ch.channel_type || "live").toLowerCase();
    return t(`chan.type.${["movie", "series"].includes(type) ? type : "live"}`);
  }

  // ---------- libraries ----------
  const loading = {};
  function loadLib(name) {
    const [src, global] = VENDOR[name];
    if (window[global]) return Promise.resolve(window[global]);
    if (!loading[name]) {
      loading[name] = new Promise((resolve, reject) => {
        const el = document.createElement("script");
        el.src = src;
        el.async = true;
        el.onload = () => (window[global] ? resolve(window[global]) : reject(new Error(`${global} missing`)));
        el.onerror = () => {
          delete loading[name];
          el.remove();
          reject(new Error(`${src} could not load`));
        };
        document.head.appendChild(el);
      });
    }
    return loading[name];
  }

  // ---------- routes to a stream ----------
  let relayCheck = null;
  function relayAvailable() {
    if (!relayCheck) {
      relayCheck = fetch("/api/stream?probe=1", { cache: "no-store" })
        .then((r) => r.status === 204)
        .catch(() => false);
    }
    return relayCheck;
  }
  const relayUrl = (url) => `/api/stream?url=${encodeURIComponent(url)}`;

  function urlPath(url) {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return String(url || "").toLowerCase();
    }
  }

  function streamKind(url) {
    const path = urlPath(url);
    const lower = String(url).toLowerCase();
    if (/\.m3u8?$/.test(path) || /[?&](output|type|format)=(m3u8|hls)\b/.test(lower)) return "hls";
    if (/\.(mp4|m4v|webm|ogv|ogg|mov|mkv|mp3|aac|m4a)$/.test(path)) return "file";
    if (/\.flv$/.test(path)) return "flv";
    if (/\.ts$/.test(path) || /[?&](output|type|format)=(ts|mpegts)\b/.test(lower)) return "ts";
    return "unknown";
  }

  // Xtream Codes serves every live channel as MPEG-TS and as HLS:
  //   http://host:port/user/pass/123  or  http://host:port/live/user/pass/123.ts
  //   -> http://host:port/live/user/pass/123.m3u8
  function xtreamHls(url) {
    try {
      const u = new URL(url);
      const parts = u.pathname.split("/").filter(Boolean);
      const rest = parts[0] === "live" ? parts.slice(1) : parts;
      if (rest.length !== 3) return "";
      const m = /^(\d+)(\.ts)?$/i.exec(rest[2]);
      if (!m) return "";
      u.pathname = `/live/${rest[0]}/${rest[1]}/${m[1]}.m3u8`;
      return u.href;
    } catch {
      return "";
    }
  }

  async function buildPlan(url) {
    const kind = streamKind(url);
    const tries = [];
    const add = (engine, src) => {
      if (src && !tries.some((x) => x.engine === engine && x.src === src)) tries.push({ engine, src });
    };
    if (kind === "hls") add("hls", url);
    else if (kind === "file") add("native", url);
    else if (kind === "flv") add("flv", url);
    else {
      add("hls", xtreamHls(url));
      add("ts", url);
      if (kind === "unknown") add("hls", url); // some servers serve HLS without the extension
    }
    const relay = await relayAvailable();
    const plan = [];
    tries.forEach((x) => {
      // an https page may not load http media: only the relay can reach it
      const mixed = location.protocol === "https:" && /^http:/i.test(x.src);
      if (!mixed) plan.push({ ...x, via: "direct" });
      if (relay) plan.push({ ...x, via: "relay" });
    });
    return plan;
  }

  // ---------- engines: each resolves to { destroy() } ----------
  async function mpegtsEngine(type, video, src, fail) {
    const mpegts = await loadLib("mpegts");
    if (!mpegts.isSupported()) throw new Error("Media Source is not available");
    if (mpegts.LoggingControl && !mpegts.LoggingControl.cineauraQuiet) {
      // keep warnings and errors, drop the per-packet chatter
      mpegts.LoggingControl.enableVerbose = false;
      mpegts.LoggingControl.enableDebug = false;
      mpegts.LoggingControl.enableInfo = false;
      mpegts.LoggingControl.cineauraQuiet = true;
    }
    const player = mpegts.createPlayer(
      { type, isLive: true, url: src },
      { enableWorker: false, lazyLoad: false, liveBufferLatencyChasing: true, autoCleanupSourceBuffer: true }
    );
    player.on(mpegts.Events.ERROR, (kind, detail, info) => {
      fail(`${kind} ${detail}${info && info.code ? ` ${info.code}` : ""}`);
    });
    player.attachMediaElement(video);
    player.load();
    return {
      destroy() {
        try {
          player.pause();
          player.unload();
          player.detachMediaElement();
          player.destroy();
        } catch {
          /* already gone */
        }
      },
    };
  }

  const ENGINES = {
    async hls(video, src, fail) {
      const Hls = await loadLib("hls").catch(() => null);
      if (Hls && Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: 30,
          manifestLoadingMaxRetry: 1,
          levelLoadingMaxRetry: 2,
          fragLoadingMaxRetry: 3,
        });
        let recovered = false;
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data || !data.fatal) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
            recovered = true;
            hls.recoverMediaError();
            return;
          }
          const code = data.response && data.response.code ? ` ${data.response.code}` : "";
          fail(`${data.details || data.type}${code}`);
        });
        hls.loadSource(src);
        hls.attachMedia(video);
        return { destroy: () => hls.destroy() };
      }
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = src;
        return { destroy() {} };
      }
      throw new Error("HLS is not supported by this browser");
    },
    ts: (video, src, fail) => mpegtsEngine("mpegts", video, src, fail),
    flv: (video, src, fail) => mpegtsEngine("flv", video, src, fail),
    async native(video, src) {
      video.src = src;
      return { destroy() {} };
    },
  };

  // ---------- stream links of channels imported before sql/channels.sql ----------
  const streamMaps = new Map(); // package name -> Promise<Map(channel name -> url)>

  async function loadStreamMap(pack, accounts) {
    let rows = accounts;
    if (!Array.isArray(rows)) {
      const me = getSession()?.member_id || "";
      const who = me ? `&or=(type.eq.free,owner_id.eq.${restValue(me)})` : "&type=eq.free";
      const res = await supabaseRequest(`/rest/v1/iptv?name=eq.${restValue(pack)}${who}&select=*`);
      rows = res.ok && Array.isArray(res.data) ? res.data : [];
    }
    const me = getSession()?.member_id || "";
    const rank = (a) => (a.owner_id && a.owner_id === me ? 0 : String(a.type || "").toLowerCase() === "free" ? 1 : 2);
    const map = new Map();
    for (const account of [...rows].sort((a, b) => rank(a) - rank(b))) {
      const url = C.iptvM3uUrl(account);
      if (!url) continue;
      try {
        C.parseM3U(await C.fetchPlaylistText(url)).forEach((r) => {
          const key = norm(r.channel_name);
          if (r.stream_url && !map.has(key)) map.set(key, r.stream_url);
        });
      } catch {
        /* try the next account of the package */
      }
      if (map.size) break;
    }
    return map;
  }

  async function lookupStream(ch, accounts) {
    const pack = String(ch.package_name || "");
    if (!pack) return "";
    if (!streamMaps.has(pack)) streamMaps.set(pack, loadStreamMap(pack, accounts).catch(() => new Map()));
    const map = await streamMaps.get(pack);
    if (!map.size) streamMaps.delete(pack); // allow "Try again" to look once more
    return map.get(norm(ch.channel_name)) || "";
  }

  async function resolveStream(ch, accounts) {
    const own = String(ch.stream_url || "").trim();
    if (own) return own;
    const found = await lookupStream(ch, accounts).catch(() => "");
    if (found) ch.stream_url = found;
    return found;
  }

  // ---------- dialog state ----------
  const S = {
    root: null,
    video: null,
    list: [],
    index: 0,
    opts: {},
    run: 0,
    engine: null,
    cancel: null,
    lateFail: null,
    autoRetry: 0,
    autoMuted: false,
    skipVolume: false,
    state: "idle", // idle | loading | playing | error
    error: "",
    url: "",
    reported: new Set(),
    checked: new Set(),
    lastFocus: null,
    report: null,
  };

  const current = () => S.list[S.index] || null;

  // tell the page how a channel did (Listchannels.html colours its status dot)
  function result(ch, ok) {
    if (!ch || typeof S.opts.onResult !== "function") return;
    try {
      S.opts.onResult(ch, ok);
    } catch {
      /* a problem of the page, not of the player */
    }
  }

  function teardown() {
    if (S.cancel) S.cancel();
    S.cancel = null;
    S.lateFail = null;
    if (S.engine) {
      try {
        S.engine.destroy();
      } catch {
        /* already gone */
      }
      S.engine = null;
    }
    const video = S.video;
    if (video) {
      try {
        video.pause();
      } catch {
        /* not started */
      }
      video.removeAttribute("src");
      try {
        video.load();
      } catch {
        /* nothing loaded */
      }
    }
  }

  function autoplay(video) {
    const started = video.play();
    if (!started || typeof started.catch !== "function") return;
    started.catch((err) => {
      // Opened from a shared link: the browser only allows muted autoplay.
      if (err && err.name === "NotAllowedError" && !video.muted) {
        S.autoMuted = true;
        S.skipVolume = true; // the volumechange of this very mute is not the viewer's
        video.muted = true;
        unmuteButton(true);
        video.play().catch(() => {});
      }
    });
  }

  function attempt(step, run) {
    const video = S.video;
    return new Promise((resolve) => {
      let done = false;
      let timer = 0;
      const src = step.via === "relay" ? relayUrl(step.src) : step.src;
      const tag = `${step.engine}/${step.via}`;
      const onData = () => finish(true);
      const onError = () => finish(false, `media error ${video.error ? video.error.code : ""}`.trim());
      function finish(ok, detail) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        video.removeEventListener("loadeddata", onData);
        video.removeEventListener("playing", onData);
        video.removeEventListener("error", onError);
        S.cancel = null;
        if (!ok && S.engine) {
          try {
            S.engine.destroy();
          } catch {
            /* already gone */
          }
          S.engine = null;
          video.removeAttribute("src");
          try {
            video.load();
          } catch {
            /* nothing loaded */
          }
        }
        resolve({ ok, detail: ok ? "" : `${tag}: ${detail}` });
      }
      // after a good start, a failure of the engine is a "late" failure
      const fail = (detail) => (done ? S.lateFail && S.lateFail(`${tag}: ${detail}`) : finish(false, detail));
      video.addEventListener("loadeddata", onData);
      video.addEventListener("playing", onData);
      video.addEventListener("error", onError);
      S.cancel = () => finish(false, "cancelled");
      timer = setTimeout(() => finish(false, "timeout"), ATTEMPT_MS);
      ENGINES[step.engine](video, src, fail)
        .then((engine) => {
          if (done || run !== S.run) {
            try {
              engine.destroy();
            } catch {
              /* already gone */
            }
            return;
          }
          S.engine = engine;
          autoplay(video);
        })
        .catch((err) => finish(false, (err && err.message) || String(err)));
    });
  }

  async function play(index, auto = false) {
    const run = ++S.run;
    teardown();
    if (!auto) S.autoRetry = 0;
    S.index = (index + S.list.length) % S.list.length;
    S.error = "";
    S.url = "";
    const ch = current();
    if (!ch) return;
    paintChannel(ch);
    if (typeof S.opts.onChange === "function") S.opts.onChange(S.index);
    veil("loading", t("chan.connecting"));
    let url = String(ch.stream_url || "").trim();
    if (!url) {
      veil("loading", t("chan.lookup"));
      url = await resolveStream(ch, S.opts.accounts);
      if (run !== S.run) return;
    }
    S.url = url;
    if (!url) {
      S.error = "no stream link saved for this channel";
      veil("error", "nostream");
      result(ch, false);
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      S.error = `unsupported protocol ${url.split(":")[0]}`;
      veil("error", "format");
      result(ch, false);
      return;
    }
    veil("loading", t("chan.connecting"));
    const plan = await buildPlan(url);
    if (run !== S.run) return;
    const errors = [];
    for (let i = 0; i < plan.length; i += 1) {
      if (i > 0) veil("loading", t("chan.retrying"));
      const res = await attempt(plan[i], run);
      if (run !== S.run) return;
      if (res.ok) {
        S.lateFail = (detail) => {
          if (run !== S.run) return;
          if (S.autoRetry < 1) {
            S.autoRetry += 1;
            play(S.index, true);
            return;
          }
          S.error = detail.slice(0, 900);
          teardown();
          veil("error", "failed");
          result(ch, false);
        };
        veil(null);
        result(ch, true);
        return;
      }
      errors.push(res.detail);
    }
    S.error = (errors.join(" | ") || "no route: http stream on an https page and no /api/stream relay").slice(0, 900);
    veil("error", "failed");
    result(ch, false);
  }

  // ---------- UI ----------
  function veil(kind, detail) {
    const box = S.root && S.root.querySelector(".chp-veil");
    if (!box) return;
    S.state = kind === null ? "playing" : kind;
    S.root.querySelector(".chp-live")?.classList.toggle("off", kind !== null);
    S.root.querySelector(".chp-stage")?.classList.toggle("has-msg", kind === "error");
    if (kind === null) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    box.hidden = false;
    if (kind === "loading") {
      box.className = "chp-veil";
      box.innerHTML = `<span class="chp-spin" aria-hidden="true"></span><p role="status">${escapeHtml(detail)}</p>`;
      return;
    }
    const titles = { failed: ["chan.failTitle", "chan.failText"], nostream: ["chan.noStreamTitle", "chan.noStreamText"], format: ["chan.formatTitle", "chan.formatText"] };
    const [title, text] = titles[detail] || titles.failed;
    const canReport = S.opts.report !== false;
    box.className = "chp-veil chp-veil-error";
    box.innerHTML = `
      <span class="chp-warn">${ICON.warn}</span>
      <h3>${escapeHtml(t(title))}</h3>
      <p>${escapeHtml(t(text, { proto: (S.url.split(":")[0] || "").toUpperCase() }))}</p>
      <div class="chp-veil-actions">
        ${detail === "nostream" ? "" : `<button class="btn btn-sm btn-ghost" type="button" data-chp-retry>${escapeHtml(t("chan.retry"))}</button>`}
        ${canReport ? `<button class="btn btn-sm btn-danger" type="button" data-chp-report>${ICON.flag}<span>${escapeHtml(t("chan.report"))}</span></button>` : ""}
        ${S.url ? `<button class="btn btn-sm btn-ghost" type="button" data-chp-copy>${escapeHtml(t("chan.copyLink"))}</button>` : ""}
      </div>
      ${S.opts.report === false && S.error ? `<code class="chp-detail" dir="ltr">${escapeHtml(S.error)}</code>` : ""}`;
    paintReport();
  }

  function unmuteButton(show) {
    const btn = S.root && S.root.querySelector(".chp-unmute");
    if (btn) btn.hidden = !show;
  }

  function paintChannel(ch) {
    const root = S.root;
    if (!root) return;
    const live = String(ch.channel_type || "live").toLowerCase() === "live";
    root.querySelector(".chp-head-logo").innerHTML = logoHtml(ch, "chp-logo");
    root.querySelector(".chp-title").textContent = ch.channel_name || "";
    root.querySelector(".chp-sub").textContent = [ch.group_name, ch.package_name].filter(Boolean).join(" · ");
    const badge = root.querySelector(".chp-live");
    badge.innerHTML = live ? `<i></i>${escapeHtml(t("chan.live"))}` : escapeHtml(typeLabel(ch));
    badge.classList.toggle("vod", !live);
    const many = S.list.length > 1;
    root.querySelector(".chp-nav").hidden = !many;
    root.querySelector(".chp-pos").textContent = many ? t("chan.pos", { i: S.index + 1, n: S.list.length }) : "";
    unmuteButton(false);
    // undo only the mute the player applied for the autoplay rules, never the viewer's own
    if (S.video && S.autoMuted) S.video.muted = false;
    S.autoMuted = false;
    S.skipVolume = false;
    paintReport();
    checkReported(ch);
  }

  function paintReport() {
    const ch = current();
    if (!S.root || !ch) return;
    const done = S.reported.has(reportKey(ch));
    S.root.querySelectorAll("[data-chp-report]").forEach((btn) => {
      btn.disabled = done;
      btn.classList.toggle("is-done", done);
      btn.innerHTML = done
        ? `${ICON.check}<span>${escapeHtml(t("chan.reported"))}</span>`
        : `${ICON.flag}<span>${escapeHtml(t("chan.report"))}</span>`;
    });
  }

  // Has this member already got an open report on the channel?
  async function checkReported(ch) {
    const me = getSession()?.member_id;
    const key = reportKey(ch);
    if (!me || S.opts.report === false || S.checked.has(key)) return;
    S.checked.add(key);
    try {
      const res = await supabaseRequest(
        `/rest/v1/channel_reports?reporter_id=eq.${restValue(me)}&package_name=eq.${restValue(ch.package_name || "")}&channel_name=eq.${restValue(ch.channel_name || "")}&status=eq.open&select=id&limit=1`
      );
      if (res.ok && Array.isArray(res.data) && res.data.length) {
        S.reported.add(key);
        paintReport();
      }
    } catch {
      /* offline: the button stays available */
    }
  }

  function build() {
    const wrap = document.createElement("div");
    wrap.className = "chp-back";
    wrap.innerHTML = `
      <section class="chp-card" role="dialog" aria-modal="true" aria-labelledby="chp-title" tabindex="-1">
        <header class="chp-head">
          <span class="chp-head-logo"></span>
          <div class="chp-titles">
            <h2 class="chp-title" id="chp-title"></h2>
            <p class="chp-sub"></p>
          </div>
          <span class="chp-live off"></span>
          <button class="chp-x" type="button" data-chp-close aria-label="${escapeHtml(t("common.close"))}">${ICON.close}</button>
        </header>
        <div class="chp-stage">
          <video class="chp-video" playsinline controls autoplay preload="auto"></video>
          <div class="chp-veil" hidden></div>
          <button class="chp-unmute" type="button" data-chp-unmute hidden>${ICON.muted}<span>${escapeHtml(t("chan.unmute"))}</span></button>
        </div>
        <footer class="chp-foot">
          <div class="chp-nav">
            <button class="btn btn-sm btn-ghost" type="button" data-chp-prev aria-label="${escapeHtml(t("chan.prev"))}">${ICON.prev}<span>${escapeHtml(t("chan.prev"))}</span></button>
            <span class="chp-pos"></span>
            <button class="btn btn-sm btn-ghost" type="button" data-chp-next aria-label="${escapeHtml(t("chan.next"))}"><span>${escapeHtml(t("chan.next"))}</span>${ICON.next}</button>
          </div>
          ${S.opts.report === false ? "" : `<button class="btn btn-sm btn-ghost chp-report" type="button" data-chp-report>${ICON.flag}<span>${escapeHtml(t("chan.report"))}</span></button>`}
        </footer>
      </section>`;
    wrap.addEventListener("click", onClick);
    wrap.addEventListener("mousedown", (e) => {
      if (e.target === wrap) wrap.dataset.downOutside = "1";
    });
    wrap.addEventListener("mouseup", (e) => {
      if (e.target === wrap && wrap.dataset.downOutside === "1") close();
      delete wrap.dataset.downOutside;
    });
    const video = wrap.querySelector("video");
    video.addEventListener("volumechange", () => {
      if (S.skipVolume) {
        S.skipVolume = false;
        return;
      }
      S.autoMuted = false; // the viewer took over the sound
      if (!video.muted) unmuteButton(false);
    });
    // a <video> error after a good start (the native engines report nothing else)
    video.addEventListener("error", () => {
      if (S.state === "playing" && S.lateFail && video.getAttribute("src")) S.lateFail(`media error ${video.error ? video.error.code : ""}`.trim());
    });
    return wrap;
  }

  async function onClick(e) {
    const hit = (sel) => e.target.closest(sel);
    if (hit("[data-chp-close]")) return close();
    if (hit("[data-chp-prev]")) return play(S.index - 1);
    if (hit("[data-chp-next]")) return play(S.index + 1);
    if (hit("[data-chp-retry]")) return play(S.index);
    if (hit("[data-chp-unmute]")) {
      S.autoMuted = false;
      S.video.muted = false;
      unmuteButton(false);
      return;
    }
    if (hit("[data-chp-copy]")) {
      const ok = await C.copyText(S.url);
      toast(t(ok ? "chan.linkCopied" : "chan.rpt.fail"));
      return;
    }
    const rep = hit("[data-chp-report]");
    if (rep && !rep.disabled) openReport(current());
  }

  function focusables(root) {
    return [...root.querySelectorAll('button:not([disabled]):not([hidden]), [href], input:not([disabled]), textarea, select, video[controls], [tabindex]:not([tabindex="-1"])')].filter(
      (el) => el.offsetParent !== null || el === document.activeElement
    );
  }

  function onKey(e) {
    if (!S.root) return;
    const top = S.report || S.root;
    if (e.key === "Escape") {
      e.preventDefault();
      if (S.report) closeReport();
      else close();
      return;
    }
    if (e.key === "Tab") {
      const items = focusables(top);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!top.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  function open(list, index = 0, opts = {}) {
    const rows = (Array.isArray(list) ? list : [list]).filter(Boolean);
    if (!rows.length) return;
    if (S.root) close(true);
    S.list = rows;
    S.opts = opts || {};
    S.lastFocus = document.activeElement;
    S.root = build();
    S.video = S.root.querySelector("video");
    document.body.appendChild(S.root);
    document.documentElement.classList.add("chp-open");
    document.addEventListener("keydown", onKey, true);
    S.root.querySelector("[data-chp-close]").focus({ preventScroll: true });
    play(Math.max(0, Math.min(rows.length - 1, Number(index) || 0)));
  }

  function close(silent = false) {
    if (!S.root) return;
    S.run += 1;
    teardown();
    closeReport();
    S.root.remove();
    S.root = null;
    S.video = null;
    S.state = "idle";
    document.documentElement.classList.remove("chp-open");
    document.removeEventListener("keydown", onKey, true);
    if (S.lastFocus && typeof S.lastFocus.focus === "function" && document.contains(S.lastFocus)) {
      S.lastFocus.focus({ preventScroll: true });
    }
    const done = S.opts.onClose;
    S.opts = {};
    if (!silent && typeof done === "function") done();
  }

  // ---------- report dialog ----------
  function closeReport() {
    if (!S.report) return;
    S.report.remove();
    S.report = null;
    S.root?.querySelector("[data-chp-report]:not([disabled])")?.focus({ preventScroll: true });
  }

  function openReport(ch) {
    if (!ch || !S.root) return;
    if (!getSession()?.member_id) {
      toast(t("chan.rpt.signin"));
      return;
    }
    closeReport();
    const failed = S.state === "error";
    const wrap = document.createElement("div");
    wrap.className = "chr-back";
    wrap.innerHTML = `
      <form class="chr-card" role="dialog" aria-modal="true" aria-labelledby="chr-title" novalidate>
        <h2 id="chr-title">${escapeHtml(t("chan.rpt.title"))}</h2>
        <p class="muted">${escapeHtml(t("chan.rpt.lead"))}</p>
        <div class="chr-ch">
          ${logoHtml(ch, "chr-logo")}
          <div><strong>${escapeHtml(ch.channel_name || "")}</strong><small>${escapeHtml([ch.group_name, ch.package_name].filter(Boolean).join(" · "))}</small></div>
        </div>
        <fieldset class="chr-reasons">
          <legend>${escapeHtml(t("chan.rpt.reason"))}</legend>
          ${REASONS.map(
            (r) => `<label class="chr-reason"><input type="radio" name="chr-reason" value="${r}"${failed && r === "not_working" ? " checked" : ""} /><span>${escapeHtml(t(`chan.rpt.${r}`))}</span></label>`
          ).join("")}
        </fieldset>
        <label class="chr-label" for="chr-note">${escapeHtml(t("chan.rpt.note"))}</label>
        <textarea id="chr-note" maxlength="500" rows="3" placeholder="${escapeHtml(t("chan.rpt.notePh"))}"></textarea>
        ${S.error ? `<p class="chr-hint">${escapeHtml(t("chan.rpt.attached"))}</p>` : ""}
        <div class="chr-actions">
          <button class="btn btn-sm btn-ghost" type="button" data-chr-cancel>${escapeHtml(t("common.cancel"))}</button>
          <button class="btn btn-sm btn-primary" type="submit">${escapeHtml(t("chan.rpt.send"))}</button>
        </div>
      </form>`;
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap || e.target.closest("[data-chr-cancel]")) closeReport();
    });
    const form = wrap.querySelector("form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const reason = form.querySelector('input[name="chr-reason"]:checked')?.value;
      if (!reason) {
        toast(t("chan.rpt.pick"));
        form.querySelector('input[name="chr-reason"]')?.focus();
        return;
      }
      const send = form.querySelector('button[type="submit"]');
      send.disabled = true;
      const ok = await sendReport(ch, reason, form.querySelector("#chr-note").value);
      send.disabled = false;
      if (ok) closeReport();
    });
    S.report = wrap;
    document.body.appendChild(wrap);
    (form.querySelector("input:checked") || form.querySelector("input"))?.focus({ preventScroll: true });
  }

  async function sendReport(ch, reason, note) {
    const session = getSession();
    if (!session?.member_id) {
      toast(t("chan.rpt.signin"));
      return false;
    }
    if (!(await C.guardFeature("reports"))) return false;
    const key = reportKey(ch);
    const pack = String(ch.package_name || "");
    const name = String(ch.channel_name || "");
    try {
      const open = await supabaseRequest(
        `/rest/v1/channel_reports?reporter_id=eq.${restValue(session.member_id)}&package_name=eq.${restValue(pack)}&channel_name=eq.${restValue(name)}&status=eq.open&select=id&limit=1`
      );
      if (open.ok && Array.isArray(open.data) && open.data.length) {
        S.reported.add(key);
        paintReport();
        toast(t("chan.rpt.dup"));
        return true;
      }
      const row = {
        channel_id: Number(ch.id) || null,
        package_name: pack.slice(0, 200),
        channel_name: name.slice(0, 200),
        group_name: String(ch.group_name || "").slice(0, 120),
        logo_url: String(ch.logo_url || "").slice(0, 1000),
        stream_url: String(ch.stream_url || S.url || "").slice(0, 2000),
        reason: REASONS.includes(reason) ? reason : "not_working",
        note: String(note || "").trim().slice(0, 500),
        error_detail: [S.error, S.state === "playing" ? "player: was playing" : ""].filter(Boolean).join(" · ").slice(0, 1000),
        reporter_id: session.member_id,
        reporter_name: String(session.username || "").slice(0, 80),
      };
      const saved = await supabaseRequest("/rest/v1/channel_reports", { method: "POST", body: JSON.stringify(row) });
      if (!saved.ok) {
        const raw = JSON.stringify(saved.data || {});
        if (/23505|duplicate/i.test(raw)) {
          S.reported.add(key);
          paintReport();
          toast(t("chan.rpt.dup"));
          return true;
        }
        toast(t(/PGRST205|PGRST204|42P01|schema cache|does not exist/i.test(raw) ? "chan.rpt.setup" : "chan.rpt.fail"));
        return false;
      }
      S.reported.add(key);
      paintReport();
      toast(t("chan.rpt.ok"));
      return true;
    } catch {
      toast(t("chan.rpt.fail"));
      return false;
    }
  }

  window.CineAuraChannels = {
    open,
    close,
    isOpen: () => Boolean(S.root),
    resolveStream,
    logoHtml,
    typeLabel,
    streamKind,
    xtreamHls,
    REASONS,
  };
})();
