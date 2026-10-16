/* CineAura channel player — plays IPTV channels, films and episodes in a dialog.
 *
 * Used by Listchannels.html (members) and by Panel > Reports > Channels ("Test").
 *
 *   CineAuraChannels.open(channels, index, options)
 *     channels  rows of public.listchannels ({ id, package_name, channel_name,
 *               group_name, logo_url, channel_type, stream_url })
 *     options   { report: true,        show the "Report channel" button
 *                 countViews: true,    count what members watch (see below)
 *                 accounts: [...],     iptv rows of the package (stream lookup)
 *                 onChange(index),     the dialog moved to another channel
 *                 onResult(row, ok),   a channel started (true) or failed (false)
 *                 onClose() }
 *   CineAuraChannels.close()
 *   CineAuraChannels.resolveStream(row, accounts)  -> Promise<stream link | "">
 *   CineAuraChannels.warm()                        load the engines before the first click
 *   CineAuraChannels.hintRoute(link, verdict)      a channel check found the way that works
 *
 * Engines, loaded on demand from js/vendor/:
 *   hls.js     HLS (.m3u8), segments appended while they download; native HLS
 *              where Media Source is missing (older iPhones)
 *   mpegts.js  MPEG-TS (.ts and Xtream "/user/pass/123") and FLV
 *   <video>    plain files (mp4, webm, …)
 * A stream is tried directly first. When that cannot work — an http stream on
 * the https site, or a server that sends no CORS headers — it goes through
 * /api/stream (server.py), which also fetches the next segments of a live
 * channel ahead of the player. The way that worked is remembered per link
 * (localStorage "cineaura_chroute"), so the channel starts on it next time.
 *
 * Smooth playback: playback starts once a little is buffered; after a stall it
 * waits for a few seconds of picture (more after repeated stalls) instead of
 * stuttering frame by frame; small holes between segments are skipped; a
 * channel that breaks off reconnects by itself. The download speed is measured
 * every second and shown on the picture (Stream info has the details).
 *
 * "Report channel" writes public.channel_reports (sql/channels.sql), which the
 * staff read in Panel > Reports > Channels. What the player saw (which routes
 * failed and why) travels with the report as error_detail.
 *
 * Most watched channels (home page): with countViews, a signed-in member who
 * has had 15 seconds of moving picture on a live channel counts as one viewer
 * of it (channel_view_add, sql/channel_views.sql: once per member, channel and
 * day). Zapping past a channel does not count, and the staff's tests in the
 * panel never do.
 *
 * Programme guide (EPG): when the IPTV account of the package has a guide
 * (CineAura.iptvEpgUrl), a live channel shows what is on now and next under its
 * name, and the guide button (G) lists the next hours. server.py reads the
 * XMLTV guide (/api/epg); a channel is found by its tvg-id (epg_id) or its name.
 * CineAuraChannels.epgSource / epgLookup also give the channel cards their
 * "now" line.
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
  const ROUTE_KEY = "cineaura_chroute";
  const ROUTE_TTL = 14 * 24 * 3600 * 1000;
  const ROUTE_MAX = 3000;
  const VOLUME_KEY = "cineaura_chvolume";
  const RAIL_SPAN = 30; // channels on each side of the current one in the strip
  const VIEW_AFTER = 15000; // ms of moving picture before a live channel counts as watched

  // smooth playback (seconds)
  const START_AHEAD = 1.2; // buffered before a channel starts to play
  const REBUFFER_MIN = 3; // buffered before playing on after a stall…
  const REBUFFER_STEP = 2; // …plus this for every other stall of the last 90 s
  const REBUFFER_MAX = 12;
  const STALL_WINDOW = 90000; // ms
  const RECONNECT_DELAYS = [600, 2000, 4500, 9000]; // ms, then the channel counts as failed
  const TICK = 250; // ms

  const svg = (body, size = 22, extra = "") =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${body}</svg>`;
  const ICON = {
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>', 20, ' stroke-width="2.2"'),
    prev: svg('<path d="M15 6l-6 6 6 6"/>', 18, ' class="chp-flip" stroke-width="2.4"'),
    next: svg('<path d="M9 6l6 6-6 6"/>', 18, ' class="chp-flip" stroke-width="2.4"'),
    play: '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.6v12.8a1 1 0 0 0 1.5.86l10.6-6.4a1 1 0 0 0 0-1.72L9.5 4.74A1 1 0 0 0 8 5.6z"/></svg>',
    pause: '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>',
    skipPrev: '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5h2v14H7zM20 6.3v11.4a.8.8 0 0 1-1.24.67L10.4 12.67a.8.8 0 0 1 0-1.34l8.36-5.7A.8.8 0 0 1 20 6.3z"/></svg>',
    skipNext: '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M15 5h2v14h-2zM4 6.3v11.4a.8.8 0 0 0 1.24.67l8.36-5.7a.8.8 0 0 0 0-1.34L5.24 5.63A.8.8 0 0 0 4 6.3z"/></svg>',
    vol: svg('<path d="M11 5L6 9H3v6h3l5 4V5z" fill="currentColor" stroke="none"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.4 5.6a9 9 0 0 1 0 12.8"/>'),
    volLow: svg('<path d="M11 5L6 9H3v6h3l5 4V5z" fill="currentColor" stroke="none"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>'),
    volOff: svg('<path d="M11 5L6 9H3v6h3l5 4V5z" fill="currentColor" stroke="none"/><path d="M22 9l-6 6M16 9l6 6"/>'),
    fs: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
    fsExit: svg('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'),
    pip: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor" stroke="none"/>'),
    stats: svg('<path d="M3 12h4l3-8 4 16 3-8h4"/>'),
    guide: svg('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9h18M7.5 13h9M7.5 16.5h5.5"/>'),
    gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/>', 20),
    down: svg('<path d="M12 4v13M6 12l6 6 6-6"/>', 14, ' stroke-width="2.6"'),
    flag: svg('<path d="M4 22V4"/><path d="M4 4h12l-2 4 2 4H4"/>', 16),
    check: svg('<path d="M5 12l5 5 9-10"/>', 16, ' stroke-width="2.4"'),
    warn: svg('<path d="M12 3l10 18H2L12 3z"/><path d="M12 10v4"/><circle cx="12" cy="17.5" r="0.6" fill="currentColor"/>', 40, ' stroke-width="1.8"'),
    muted: svg('<path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M22 9l-6 6M16 9l6 6"/>', 16),
  };

  // ---------- helpers ----------
  const esc = escapeHtml;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const now = () => performance.now();
  const norm = (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  const reportKey = (ch) => `${norm(ch.package_name)}\n${norm(ch.channel_name)}`;
  const store = {
    get(key) {
      try {
        return JSON.parse(localStorage.getItem(key) || "null");
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* private mode or full: nothing to keep */
      }
    },
  };

  function initials(name) {
    const words = String(name || "TV").replace(/[^\p{L}\p{N} ]+/gu, " ").trim().split(/\s+/).filter(Boolean);
    return ((words[0]?.[0] || "T") + (words[1]?.[0] || words[0]?.[1] || "V")).toUpperCase();
  }

  // Logo with a lettered fallback when the image is missing or broken.
  function logoHtml(ch, cls) {
    const letters = `<span class="${cls}-letters">${esc(initials(ch.channel_name))}</span>`;
    const url = String(ch.logo_url || "");
    if (!/^https?:\/\//i.test(url)) return `<span class="${cls}">${letters}</span>`;
    return `<span class="${cls}"><img src="${esc(url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()" />${letters}</span>`;
  }

  const rowType = (ch) => {
    const type = String(ch.channel_type || "live").toLowerCase();
    return ["movie", "series"].includes(type) ? type : "live";
  };
  const typeLabel = (ch) => t(`chan.type.${rowType(ch)}`);

  const formats = new Map();
  function nf(digits) {
    const key = `${C.getLocale ? C.getLocale() : ""}|${digits}`;
    if (!formats.has(key)) {
      formats.set(key, new Intl.NumberFormat(C.getLocale ? C.getLocale() : undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits, numberingSystem: "latn" }));
    }
    return formats.get(key);
  }

  // bits per second -> { value, unit } (kbps below 1 Mbps)
  function bits(bps) {
    if (!(bps > 0)) return { value: "0", unit: t("chan.unit.kbps") };
    if (bps < 1e6) return { value: nf(0).format(bps / 1e3), unit: t("chan.unit.kbps") };
    const mb = bps / 1e6;
    return { value: nf(mb < 10 ? 1 : 0).format(mb), unit: t("chan.unit.mbps") };
  }
  const bitsText = (bps) => {
    const b = bits(bps);
    return `${b.value} ${b.unit}`;
  };
  const bytesRate = (bps) => {
    const B = bps / 8;
    return B < 1e6 ? `${nf(0).format(B / 1e3)} ${t("chan.unit.kBps")}` : `${nf(B < 1e7 ? 2 : 1).format(B / 1e6)} ${t("chan.unit.MBps")}`;
  };
  const sizeText = (bytes) =>
    bytes < 1e9 ? `${nf(bytes < 1e7 ? 1 : 0).format(bytes / 1e6)} ${t("chan.unit.mb")}` : `${nf(2).format(bytes / 1e9)} ${t("chan.unit.gb")}`;
  const secsText = (s) => t("chan.unit.sec", { n: nf(s < 10 ? 1 : 0).format(Math.max(0, s)) });
  function clock(sec) {
    if (!Number.isFinite(sec) || sec < 0) return "0:00";
    const s = Math.floor(sec % 60);
    const m = Math.floor(sec / 60) % 60;
    const h = Math.floor(sec / 3600);
    const two = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
  }
  const isRtl = () => document.documentElement.dir === "rtl" || getComputedStyle(document.documentElement).direction === "rtl";
  const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const phone = () => window.matchMedia?.("(max-width: 640px)").matches;

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
  // absolute: mpegts.js fetches from a worker, where a relative address does not resolve
  const relayUrl = (url) => new URL(`/api/stream?url=${encodeURIComponent(url)}`, location.href).href;

  // Before the first click: the engine script and the relay question are ready.
  let warmed = false;
  function warm() {
    if (warmed) return;
    warmed = true;
    relayAvailable();
    loadLib("hls").catch(() => {
      warmed = false;
    });
  }

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

  // The way a link last played (or what a channel check found), so it starts there.
  let routes = null;
  function routeBook() {
    if (!routes) {
      const raw = store.get(ROUTE_KEY);
      routes = raw && raw.v === 1 && raw.items && typeof raw.items === "object" ? raw : { v: 1, items: {} };
    }
    return routes;
  }

  function routeOf(url) {
    const r = routeBook().items[url];
    if (!Array.isArray(r) || Date.now() - r[3] > ROUTE_TTL) return null;
    return { engine: r[0], via: r[1] || "", src: r[2] === "x" ? xtreamHls(url) : url };
  }

  function rememberRoute(url, step, fromCheck = false) {
    if (!url || !step || !step.engine) return;
    const book = routeBook();
    const old = book.items[url];
    if (fromCheck && Array.isArray(old) && !old[4]) return; // a real play outranks a check
    book.items[url] = [step.engine, step.via || "", step.src && step.src !== url ? "x" : "u", Date.now(), fromCheck ? 1 : 0];
    const keys = Object.keys(book.items);
    if (keys.length > ROUTE_MAX) {
      keys.sort((a, b) => book.items[a][3] - book.items[b][3]);
      keys.slice(0, keys.length - ROUTE_MAX).forEach((k) => delete book.items[k]);
    }
    store.set(ROUTE_KEY, book);
  }

  // A channel check (Listchannels.html) answered { ok, kind: "hls" | "media", via: "url" | "alt" }.
  function hintRoute(url, verdict) {
    if (!url || !verdict || !verdict.ok) return;
    const alt = verdict.via === "alt";
    const src = alt ? xtreamHls(url) : url;
    if (!src) return;
    let engine = "hls";
    if (!alt && verdict.kind !== "hls") {
      const kind = streamKind(url);
      engine = kind === "file" ? "native" : kind === "flv" ? "flv" : "ts";
    }
    rememberRoute(url, { engine, via: "", src }, true);
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
    const known = routeOf(url);
    if (known) {
      const rank = (x) => (x.engine === known.engine && x.src === known.src ? (!known.via || x.via === known.via ? 0 : 1) : 2);
      plan.sort((a, b) => rank(a) - rank(b));
    }
    return plan;
  }

  // ---------- download meter ----------
  // hls.js reports the bytes of every request as they arrive (LoadStats); the
  // meter adds them up and how long data was flowing, so a second of waiting
  // for the next segment does not count as a slow connection.
  class Meter {
    constructor() {
      this.open = new Set();
      this.seen = new Map();
      this.ended = [];
      this.bytes = 0;
      this.mark = 0;
      this.t = now();
    }

    watch(stats) {
      if (!stats || this.open.has(stats)) return;
      this.open.add(stats);
      this.seen.set(stats, 0);
    }

    count(stats) {
      const loaded = Number(stats.loaded) || 0;
      const before = this.seen.get(stats) || 0;
      if (loaded > before) {
        this.bytes += loaded - before;
        this.seen.set(stats, loaded);
      }
    }

    settle(stats) {
      if (!this.open.has(stats)) return;
      this.count(stats);
      this.open.delete(stats);
      this.seen.delete(stats);
      this.ended.push({ first: stats.loading?.first || 0, end: stats.loading?.end || now() });
    }

    // { bytes, ms } since the previous sample
    sample() {
      const to = now();
      const from = this.t;
      this.t = to;
      let ms = 0;
      const span = (first, end) => {
        if (!first) return;
        const a = Math.max(from, first);
        const b = Math.min(to, end || to);
        if (b > a) ms += b - a;
      };
      this.open.forEach((s) => {
        this.count(s);
        span(s.loading?.first || 0, 0);
      });
      this.ended.forEach((x) => span(x.first, x.end));
      this.ended = [];
      const bytes = this.bytes - this.mark;
      this.mark = this.bytes;
      return { bytes, ms: Math.min(ms, to - from) };
    }
  }

  function meteredLoader(Base, meter) {
    return class MeteredLoader extends Base {
      load(context, config, callbacks) {
        const stats = this.stats;
        meter.watch(stats);
        const settle = () => meter.settle(stats);
        const wrap = { ...callbacks };
        wrap.onSuccess = (...a) => {
          settle();
          callbacks.onSuccess(...a);
        };
        wrap.onError = (...a) => {
          settle();
          callbacks.onError(...a);
        };
        wrap.onTimeout = (...a) => {
          settle();
          callbacks.onTimeout(...a);
        };
        if (callbacks.onAbort) {
          wrap.onAbort = (...a) => {
            settle();
            callbacks.onAbort(...a);
          };
        }
        return super.load(context, config, wrap);
      }

      abort() {
        meter.settle(this.stats);
        return super.abort();
      }

      destroy() {
        meter.settle(this.stats);
        return super.destroy();
      }
    };
  }

  const average = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);
  const noProgressive = new Set(); // links whose segments must arrive whole (a media error in streaming mode)

  // ---------- engines: each resolves to an engine object ----------
  //   { kind, live, meter?, destroy(), info(), levels(), level(), playing(), setLevel(i), goLive() }
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
      {
        enableWorker: true,
        enableStashBuffer: true,
        lazyLoad: false,
        // Chasing the newest frame kept barely a second of picture in hand and
        // jumped ahead again and again: the stutter of live channels. The
        // player keeps its margin instead (see the smooth playback below).
        liveBufferLatencyChasing: false,
        liveSync: false,
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 60,
        autoCleanupMinBackwardDuration: 30,
        fixAudioTimestampGap: true,
        reuseRedirectedURL: true,
      }
    );
    let speed = 0;
    let bytes = 0;
    let last = now();
    let dropped = 0;
    let decoded = 0;
    const rates = [];
    player.on(mpegts.Events.STATISTICS_INFO, (info) => {
      const t1 = now();
      const kbs = Number(info && info.speed) || 0; // KiB per second
      speed = kbs * 1024 * 8;
      bytes += (kbs * 1024 * (t1 - last)) / 1000;
      last = t1;
      dropped = Number(info.droppedFrames) || 0;
      decoded = Number(info.decodedFrames) || 0;
      rates.push(speed);
      if (rates.length > 18) rates.shift();
    });
    player.on(mpegts.Events.ERROR, (kind, detail, info) => {
      fail(`${kind} ${detail}${info && info.code ? ` ${info.code}` : ""}`);
    });
    // a live channel never ends: its connection closed, so connect again
    player.on(mpegts.Events.LOADING_COMPLETE, () => fail("the stream ended"));
    player.attachMediaElement(video);
    player.load();
    return {
      kind: type === "flv" ? "flv" : "ts",
      live: true,
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
      // a live MPEG-TS stream arrives at its own pace: what comes in per second is its bitrate
      info: () => ({ speed, bitrate: rates.length > 4 ? average(rates.slice(-12)) : 0, bytes, dropped, decoded }),
      levels: () => [],
      level: () => -1,
      playing: () => -1,
      setLevel() {},
      goLive() {
        const b = video.buffered;
        if (b.length) video.currentTime = Math.max(video.currentTime, b.end(b.length - 1) - 3);
      },
    };
  }

  const ENGINES = {
    async hls(video, src, fail, ctx) {
      const Hls = await loadLib("hls").catch(() => null);
      if (Hls && Hls.isSupported()) {
        const meter = new Meter();
        const policy = (ttfb, total, timeouts, errors) => ({
          default: {
            maxTimeToFirstByteMs: ttfb,
            maxLoadTimeMs: total,
            timeoutRetry: { maxNumRetry: timeouts, retryDelayMs: 0, maxRetryDelayMs: 0 },
            errorRetry: { maxNumRetry: errors, retryDelayMs: 800, maxRetryDelayMs: 6000 },
          },
        });
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          // append each segment while it downloads instead of after its last byte
          progressive: !noProgressive.has(src),
          startFragPrefetch: true,
          capLevelToPlayerSize: true, // a phone does not download 1080p for a 400 px picture
          startPosition: ctx.resume > 0 ? ctx.resume : -1,
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          backBufferLength: 30,
          // IPTV segments often leave tiny holes between them: step over, do not stop
          maxBufferHole: 0.5,
          nudgeMaxRetry: 6,
          stretchShortVideoTrack: true,
          liveSyncDurationCount: 3,
          liveMaxLatencyDurationCount: Infinity,
          manifestLoadPolicy: policy(12000, 20000, 1, 1),
          playlistLoadPolicy: policy(10000, 15000, 3, 4),
          fragLoadPolicy: policy(10000, 40000, 4, 6),
        });
        hls.config.loader = meteredLoader(hls.config.loader, meter);
        let recovered = false;
        let live = null;
        let segment = 0;
        let manual = -1;
        const rates = [];
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data || !data.fatal) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
            recovered = true;
            hls.recoverMediaError();
            return;
          }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && hls.config.progressive) noProgressive.add(src);
          const code = data.response && data.response.code ? ` ${data.response.code}` : "";
          fail(`${data.details || data.type}${code}`);
        });
        hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
          const frag = data && data.frag;
          if (!frag || !(frag.duration > 0.5) || !frag.stats || !(frag.stats.loaded > 0)) return;
          rates.push((frag.stats.loaded * 8) / frag.duration);
          if (rates.length > 6) rates.shift();
        });
        const onDetails = (_event, data) => {
          if (!data || !data.details) return;
          live = Boolean(data.details.live);
          segment = Number(data.details.targetduration) || segment;
          ctx.changed();
        };
        hls.on(Hls.Events.LEVEL_LOADED, onDetails);
        hls.on(Hls.Events.MANIFEST_PARSED, () => ctx.changed());
        hls.on(Hls.Events.LEVEL_SWITCHED, () => ctx.changed());
        hls.loadSource(src);
        hls.attachMedia(video);
        return {
          kind: "hls",
          meter,
          get live() {
            return live;
          },
          destroy: () => hls.destroy(),
          info() {
            const level = hls.levels && hls.levels[hls.currentLevel];
            const latency = Number(hls.latency);
            return {
              bitrate: average(rates) || (level && level.bitrate) || 0,
              latency: Number.isFinite(latency) ? latency : 0,
              target: Number(hls.targetLatency) || 0,
              segment,
              bytes: meter.bytes,
            };
          },
          levels: () => (hls.levels || []).map((l, i) => ({ i, height: l.height || 0, bitrate: l.bitrate || 0 })),
          level: () => manual,
          playing: () => hls.currentLevel,
          setLevel(i) {
            manual = i;
            hls.nextLevel = i;
            ctx.changed();
          },
          goLive() {
            const p = hls.liveSyncPosition;
            if (Number.isFinite(p)) video.currentTime = p;
          },
        };
      }
      if (video.canPlayType("application/vnd.apple.mpegurl")) return ENGINES.native(video, src, fail, ctx);
      throw new Error("HLS is not supported by this browser");
    },
    ts: (video, src, fail) => mpegtsEngine("mpegts", video, src, fail),
    flv: (video, src, fail) => mpegtsEngine("flv", video, src, fail),
    async native(video, src, _fail, ctx) {
      video.src = src;
      if (ctx.resume > 0) {
        video.addEventListener(
          "loadedmetadata",
          () => {
            if (Number.isFinite(video.duration) && ctx.resume < video.duration) video.currentTime = ctx.resume;
          },
          { once: true }
        );
      }
      // what the browser decoded per second (the stream bitrate), where it tells
      let lastBytes = -1;
      let lastAt = 0;
      let rate = 0;
      return {
        kind: "native",
        get live() {
          return Number.isFinite(video.duration) ? false : video.duration === Infinity ? true : null;
        },
        destroy() {},
        info() {
          const decoded = (video.webkitVideoDecodedByteCount || 0) + (video.webkitAudioDecodedByteCount || 0);
          if (decoded > 0) {
            const t1 = now();
            if (lastBytes >= 0 && t1 > lastAt && decoded >= lastBytes) rate = ((decoded - lastBytes) * 8 * 1000) / (t1 - lastAt);
            lastBytes = decoded;
            lastAt = t1;
          }
          return { speed: rate, bitrate: rate, bytes: decoded };
        },
        levels: () => [],
        level: () => -1,
        playing: () => -1,
        setLevel() {},
        goLive() {
          const s = video.seekable;
          if (s && s.length) video.currentTime = s.end(s.length - 1) - 1;
        },
      };
    },
  };

  // ---------- the IPTV accounts of a package that this viewer may use ----------
  const accountCache = new Map(); // package name -> Promise<rows>

  function packageAccounts(pack) {
    if (!accountCache.has(pack)) {
      const session = getSession();
      const staff = staffViewer(); // Panel > Reports > Test: every account of the package
      const who = staff ? "" : session?.member_id ? `&${C.iptvVisibleFilter(session)}` : "&type=ilike.free";
      const load = supabaseRequest(`/rest/v1/iptv?name=eq.${restValue(pack)}${who}&select=*`)
        .then((res) => (res.ok && Array.isArray(res.data) ? res.data.filter((a) => staff || C.iptvVisibleTo(a, session)) : []))
        .catch(() => []);
      accountCache.set(pack, load);
      load.then((rows) => {
        if (!rows.length) accountCache.delete(pack); // look again next time
      });
    }
    return accountCache.get(pack);
  }

  function staffViewer() {
    try {
      const panel = JSON.parse(sessionStorage.getItem("cineaura_panel") || localStorage.getItem("cineaura_panel") || "null");
      return Boolean(panel && panel.token);
    } catch {
      return false;
    }
  }

  // ---------- stream links of channels imported before sql/channels.sql ----------
  const streamMaps = new Map(); // package name -> Promise<Map(channel name -> url)>

  async function loadStreamMap(pack, accounts) {
    const rows = Array.isArray(accounts) ? accounts : await packageAccounts(pack);
    const session = getSession();
    const rank = (a) => (C.iptvOwnedBy(a, session) ? 0 : C.iptvIsFree(a) ? 1 : 2);
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

  // ---------- programme guide (EPG) ----------
  // The guide of a package belongs to its IPTV account (CineAura.iptvEpgUrl: the
  // link saved in Panel > IPTV, the url-tvg of the playlist, or the xmltv.php of
  // an Xtream server). server.py reads the guide (/api/epg) and answers for a few
  // channels at a time: by tvg-id (listchannels.epg_id), or else by name.
  const EPG_HOURS = 12; // how far ahead the guide panel looks
  const EPG_TTL = 5 * 60000;
  const epgSources = new Map(); // package -> Promise<guide url | "">
  const epgAnswers = new Map(); // guide + hours + channel -> { at, data }

  function epgSource(pack, accounts) {
    if (!pack) return Promise.resolve("");
    if (!epgSources.has(pack)) {
      const rows = Array.isArray(accounts) && accounts.length ? Promise.resolve(accounts) : packageAccounts(pack);
      const load = rows
        .then((list) => {
          const session = getSession();
          const rank = (a) => (C.iptvOwnedBy(a, session) ? 0 : C.iptvIsFree(a) ? 1 : 2);
          return [...list].sort((a, b) => rank(a) - rank(b)).map((a) => C.iptvEpgUrl(a)).find(Boolean) || "";
        })
        .catch(() => "");
      epgSources.set(pack, load);
      load.then((url) => {
        if (!url) setTimeout(() => epgSources.delete(pack), 60000); // a guide may be added meanwhile
      });
    }
    return epgSources.get(pack);
  }

  const epgKey = (ch) => `${String(ch.epg_id || "").trim()}\n${String(ch.channel_name || "").trim()}`;

  // -> Map(channel key -> { id, name, programmes: [[start, stop, title, desc], …] } | null),
  //    or "loading" while the server is still reading the guide
  async function epgLookup(url, channels, hours = EPG_HOURS) {
    const out = new Map();
    const want = [];
    const at = Date.now();
    for (const ch of channels) {
      const key = epgKey(ch);
      const hit = epgAnswers.get(`${url}\n${hours}\n${key}`);
      const ended = hit?.data?.programmes?.[0] && hit.data.programmes[0][1] * 1000 <= at;
      if (hit && at - hit.at < EPG_TTL && !ended) out.set(key, hit.data);
      else if (!want.includes(key)) want.push(key);
    }
    for (let i = 0; i < want.length; i += 60) {
      const part = want.slice(i, i + 60);
      const q = new URLSearchParams({ url, hours: String(hours), lang: C.getLang ? C.getLang() : "" });
      part.forEach((k) => q.append("c", k));
      const res = await fetch(`/api/epg?${q}`, { cache: "no-store" });
      if (res.status === 202) return "loading";
      if (!res.ok) throw new Error(`epg ${res.status}`);
      const body = await res.json();
      part.forEach((k, j) => {
        const data = (body.channels && body.channels[j]) || null;
        epgAnswers.set(`${url}\n${hours}\n${k}`, { at: Date.now(), data });
        out.set(k, data);
      });
    }
    if (epgAnswers.size > 4000) [...epgAnswers.keys()].slice(0, 1500).forEach((k) => epgAnswers.delete(k));
    return out;
  }

  // what is on now and next, from the programmes of one channel
  function epgNow(data, at = Date.now()) {
    const list = (data?.programmes || []).filter((p) => p[1] * 1000 > at);
    const cur = list[0] && list[0][0] * 1000 <= at ? list[0] : null;
    return { cur, next: cur ? list[1] || null : list[0] || null, list };
  }

  function clockText(sec, withDay = false) {
    const d = new Date(sec * 1000);
    const opts = { hour: "2-digit", minute: "2-digit", numberingSystem: "latn" };
    const day = withDay && d.toDateString() !== new Date().toDateString();
    try {
      return new Intl.DateTimeFormat(C.getLocale ? C.getLocale() : undefined, day ? { ...opts, weekday: "short" } : opts).format(d);
    } catch {
      return d.toTimeString().slice(0, 5);
    }
  }

  const epgShare = (p, at = Date.now()) => clamp((at / 1000 - p[0]) / Math.max(1, p[1] - p[0]), 0, 1);

  // ---------- dialog state ----------
  const S = {
    epg: null, // { ch, url, data, loading, failed } of the channel on screen
    epgRun: 0,
    guideOpen: false,
    root: null,
    card: null,
    stage: null,
    video: null,
    list: [],
    index: 0,
    opts: {},
    run: 0,
    engine: null,
    step: null,
    cancel: null,
    lateFail: null,
    autoMuted: false,
    skipVolume: false,
    state: "idle", // idle | loading | playing | error
    error: "",
    url: "",
    reported: new Set(),
    checked: new Set(),
    lastFocus: null,
    report: null,
    // smooth playback
    phase: "idle", // idle | start | play | rebuffer
    phaseAt: 0,
    target: 0,
    peak: 0,
    grewAt: 0,
    stalls: [],
    lastTime: -1,
    lastMove: 0,
    nudges: 0,
    autoPause: false,
    userPaused: false,
    recon: 0,
    reconTimer: 0,
    okSince: 0,
    watchMs: 0, // moving picture on the current channel (countViews)
    watchAt: 0,
    // what the viewer sees
    speed: 0,
    speedIdle: true,
    peakSpeed: 0,
    speeds: [],
    hist: [],
    frames: null,
    fps: 0,
    ticker: 0,
    ticks: 0,
    hideTimer: 0,
    osdTimer: 0,
    statsOpen: false,
    seeking: false,
    first: true,
  };

  const current = () => S.list[S.index] || null;
  const $ = (sel) => (S.root ? S.root.querySelector(sel) : null);

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
    clearTimeout(S.reconTimer);
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
    S.step = null;
    S.phase = "idle";
    S.autoPause = false;
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

  function attempt(step, run, resume) {
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
      const ctx = {
        resume,
        changed: () => {
          if (run === S.run) paintControls();
        },
      };
      ENGINES[step.engine](video, src, fail, ctx)
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
          S.step = step;
          S.phase = "start";
          S.phaseAt = now();
          if (engine.kind === "native") startPlaying(); // Safari loads nothing before play()
        })
        .catch((err) => finish(false, (err && err.message) || String(err)));
    });
  }

  async function play(index, { auto = false, resume = 0 } = {}) {
    const run = ++S.run;
    teardown();
    if (!auto) {
      S.recon = 0;
      S.watchMs = 0; // a reconnect goes on counting the same channel
    }
    const moved = !S.first && (index + S.list.length) % S.list.length !== S.index;
    S.index = (index + S.list.length) % S.list.length;
    S.error = "";
    S.url = "";
    S.stalls = [];
    S.speed = 0;
    S.speedIdle = true;
    S.peakSpeed = 0;
    S.speeds = [];
    S.hist = [];
    S.frames = null;
    S.fps = 0;
    S.userPaused = false;
    const statsBox = $(".chp-stats");
    if (statsBox) statsBox.querySelector("dl")?.replaceChildren();
    const ch = current();
    if (!ch) return;
    paintChannel(ch, moved);
    S.first = false;
    if (typeof S.opts.onChange === "function") S.opts.onChange(S.index);
    veil("loading", t(auto ? "chan.reconnecting" : "chan.connecting"));
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
    const plan = await buildPlan(url);
    if (run !== S.run) return;
    const errors = [];
    for (let i = 0; i < plan.length; i += 1) {
      if (i > 0) veil("loading", t("chan.retrying"));
      const res = await attempt(plan[i], run, resume);
      if (run !== S.run) return;
      if (res.ok) {
        rememberRoute(url, plan[i]);
        S.okSince = now();
        S.lateFail = (detail) => {
          if (run !== S.run) return;
          if (S.recon < RECONNECT_DELAYS.length) {
            // a live channel that breaks off: connect again, quietly at first
            const wait = RECONNECT_DELAYS[S.recon];
            S.recon += 1;
            const at = S.video && isVod() ? S.video.currentTime : 0;
            teardown();
            veil("loading", t("chan.reconnectN", { i: S.recon, n: RECONNECT_DELAYS.length }));
            S.reconTimer = setTimeout(() => {
              if (run === S.run) play(S.index, { auto: true, resume: at });
            }, wait);
            return;
          }
          S.error = detail.slice(0, 900);
          teardown();
          veil("error", "failed");
          result(ch, false);
        };
        veil(null);
        paintControls();
        result(ch, true);
        return;
      }
      errors.push(res.detail);
    }
    S.error = (errors.join(" | ") || "no route: http stream on an https page and no /api/stream relay").slice(0, 900);
    veil("error", "failed");
    result(ch, false);
  }

  // ---------- smooth playback ----------
  // Seconds of picture ahead of the playhead; small holes between segments
  // count as buffered (they are stepped over).
  function bufferAhead() {
    const v = S.video;
    if (!v) return 0;
    const b = v.buffered;
    const at = v.currentTime;
    for (let i = 0; i < b.length; i += 1) {
      if (b.start(i) <= at + 0.25 && b.end(i) > at) {
        let end = b.end(i);
        for (let j = i + 1; j < b.length && b.start(j) - end <= 0.5; j += 1) end = b.end(j);
        return end - at;
      }
    }
    return 0;
  }

  function nextBuffered(at) {
    const b = S.video.buffered;
    for (let i = 0; i < b.length; i += 1) if (b.start(i) > at + 0.01) return b.start(i);
    return null;
  }

  const engineLive = () => {
    const e = S.engine;
    if (e && e.live !== null && e.live !== undefined) return Boolean(e.live);
    const ch = current();
    return !ch || rowType(ch) === "live";
  };
  const isVod = () => !engineLive();

  function startPlaying() {
    S.phase = "play";
    S.lastMove = now();
    S.lastTime = -1;
    S.autoPause = false;
    paintBuffering();
    if (!S.userPaused) autoplay(S.video);
  }

  function pauseForBuffer(at) {
    S.stalls = S.stalls.filter((x) => at - x < STALL_WINDOW);
    S.stalls.push(at);
    S.target = Math.min(REBUFFER_MAX, REBUFFER_MIN + REBUFFER_STEP * (S.stalls.length - 1));
    const v = S.video;
    if (isVod() && Number.isFinite(v.duration)) S.target = Math.min(S.target, Math.max(0.5, v.duration - v.currentTime - 0.5));
    S.phase = "rebuffer";
    S.phaseAt = at;
    S.peak = bufferAhead();
    S.grewAt = at;
    S.autoPause = true;
    v.pause();
    paintBuffering();
  }

  function smooth(at) {
    const v = S.video;
    if (!v || !S.engine || S.state !== "playing") return;
    if (S.phase === "start") {
      const ahead = bufferAhead();
      const waited = at - S.phaseAt;
      if (ahead >= START_AHEAD || (v.readyState >= 4 && ahead >= 0.3) || (waited > 2500 && v.readyState >= 3) || waited > 6000) startPlaying();
      else if (waited > 600) paintBuffering(ahead / START_AHEAD);
      return;
    }
    if (S.phase === "rebuffer") {
      const ahead = bufferAhead();
      if (ahead > S.peak + 0.05) {
        S.peak = ahead;
        S.grewAt = at;
      }
      paintBuffering(ahead / S.target);
      const still = at - S.grewAt;
      if (ahead >= S.target || (still > 3000 && ahead >= 1) || (at - S.phaseAt > 20000 && ahead >= 0.5)) startPlaying();
      else if (still > 15000 && S.lateFail) S.lateFail("no data for 15 s");
      return;
    }
    if (S.phase !== "play" || v.paused || v.seeking || v.ended || S.seeking) {
      S.lastMove = at;
      return;
    }
    if (v.currentTime !== S.lastTime) {
      S.lastTime = v.currentTime;
      S.lastMove = at;
      if (at - S.okSince > 60000) S.recon = 0; // a minute of good picture: reconnects start over
      return;
    }
    const still = at - S.lastMove;
    if (still < 500) return;
    const ahead = bufferAhead();
    if (ahead < 0.35) {
      const gap = nextBuffered(v.currentTime);
      if (gap !== null && gap - v.currentTime < 2.5) {
        v.currentTime = gap + 0.04; // a hole between two segments: step over it
        S.lastMove = at;
        return;
      }
      pauseForBuffer(at);
    } else if (still > 3000) {
      // picture in hand but the playhead does not move: nudge it
      S.nudges += 1;
      S.lastMove = at;
      if (S.nudges > 4 && S.lateFail) S.lateFail("playback frozen");
      else v.currentTime += 0.1;
    }
  }

  function userPlay() {
    if (!S.video || !S.engine) return;
    S.userPaused = false;
    if (S.phase === "rebuffer" || S.phase === "start") startPlaying();
    else autoplay(S.video);
  }

  function userPause() {
    if (!S.video) return;
    S.userPaused = true;
    if (S.phase === "rebuffer" || S.phase === "start") {
      S.phase = "play";
      paintBuffering();
    }
    S.autoPause = false;
    S.video.pause();
  }

  function togglePlay() {
    if (!S.video || S.state !== "playing") return;
    const playingNow = !S.video.paused || S.autoPause || S.phase === "start";
    if (playingNow && !S.userPaused) userPause();
    else userPlay();
    flash(S.userPaused ? ICON.pause : ICON.play);
  }

  // ---------- the per-second numbers ----------
  function measure() {
    const e = S.engine;
    const v = S.video;
    if (!e || !v) return;
    let speed = 0;
    let idle = true;
    if (e.meter) {
      // a fast line brings a whole segment in a few milliseconds: count at least 20 ms
      const { bytes, ms } = e.meter.sample();
      if (bytes > 0) {
        speed = (bytes * 8 * 1000) / Math.max(ms, 20);
        idle = false;
      }
    } else {
      speed = e.info().speed || 0;
      idle = !(speed > 0);
    }
    if (!idle) {
      S.speed = S.speed > 0 ? S.speed * 0.4 + speed * 0.6 : speed;
      S.speeds.push(speed);
      if (S.speeds.length > 30) S.speeds.shift();
      S.peakSpeed = Math.max(S.peakSpeed, speed);
    }
    S.speedIdle = idle;
    S.hist.push(S.speed);
    if (S.hist.length > 60) S.hist.shift();
    const q = typeof v.getVideoPlaybackQuality === "function" ? v.getVideoPlaybackQuality() : null;
    const at = now();
    if (q) {
      if (S.frames && at > S.frames.at) {
        const fps = Math.max(0, ((q.totalVideoFrames - S.frames.total) * 1000) / (at - S.frames.at));
        S.fps = S.fps > 0 ? S.fps * 0.7 + fps * 0.3 : fps;
      }
      S.frames = { at, total: q.totalVideoFrames, dropped: q.droppedVideoFrames };
    }
  }

  function health() {
    if (S.phase === "rebuffer") return "poor";
    const ahead = bufferAhead();
    const info = S.engine ? S.engine.info() : {};
    if (S.engine && S.engine.kind === "hls" && info.bitrate > 0 && S.speed > 0) {
      if (S.speed < info.bitrate * 1.1 && ahead < 8) return "poor";
      if (S.speed < info.bitrate * 1.5 && ahead < 8) return "fair";
    }
    if (ahead < 1.5) return "fair";
    return "good";
  }

  // ---------- most watched channels ----------
  const viewed = new Set(); // member + channel already counted while this page is open
  let viewsOff = false; // the database has no channel_view_add (sql/channel_views.sql not run)

  function watchTime(at) {
    const v = S.video;
    const moving = S.opts.countViews && S.state === "playing" && S.phase === "play" && v && !v.paused && !v.seeking && !v.ended;
    if (moving) {
      S.watchMs += Math.min(1000, at - (S.watchAt || at));
      if (S.watchMs >= VIEW_AFTER) countView(current());
    }
    S.watchAt = at;
  }

  function countView(ch) {
    const me = getSession()?.member_id;
    if (!ch || !me || viewsOff || rowType(ch) !== "live") return;
    const key = `${me}\n${norm(ch.channel_name)}`;
    if (viewed.has(key)) return;
    viewed.add(key);
    C.rpc("channel_view_add", { p_member: String(me), p_package: String(ch.package_name || ""), p_channel: String(ch.channel_name || "") })
      .then((res) => {
        if (res.status === 404) viewsOff = true;
      })
      .catch(() => setTimeout(() => viewed.delete(key), 30000)); // offline: try again in a while
  }

  function tick() {
    if (!S.root) return;
    const at = now();
    smooth(at);
    watchTime(at);
    S.ticks += 1;
    if (S.ticks % 4 === 0 && S.state === "playing") {
      measure();
      paintStats();
      paintLive();
    }
    if (S.ticks % 2 === 0) glow();
    if (isVod()) paintTime();
    if (S.ticks % 120 === 0 && S.epg && S.epg.data) {
      const { cur, list } = epgNow(S.epg.data);
      if ((!cur || list.length < 3) && Date.now() - (S.epg.at || 0) > 60000) loadGuide(S.epg.ch, true);
      paintEpg();
    }
  }

  // ---------- UI ----------
  function veil(kind, detail) {
    const box = $(".chp-veil");
    if (!box) return;
    S.state = kind === null ? "playing" : kind;
    S.stage.dataset.state = S.state;
    $(".chp-live")?.classList.toggle("off", kind !== null);
    S.stage.classList.toggle("has-msg", kind === "error");
    $(".chp-speed").hidden = kind !== null;
    if (kind === null) {
      box.hidden = true;
      box.innerHTML = "";
      paintStats();
      return;
    }
    if (kind === "error") S.statsOpen = false;
    paintStatsPanel();
    box.hidden = false;
    if (kind === "loading") {
      box.className = "chp-veil";
      box.innerHTML = `<span class="chp-ring" aria-hidden="true"><i></i></span><p role="status">${esc(detail)}</p>`;
      return;
    }
    const titles = { failed: ["chan.failTitle", "chan.failText"], nostream: ["chan.noStreamTitle", "chan.noStreamText"], format: ["chan.formatTitle", "chan.formatText"] };
    const [title, text] = titles[detail] || titles.failed;
    const canReport = S.opts.report !== false;
    box.className = "chp-veil chp-veil-error";
    box.innerHTML = `
      <span class="chp-warn">${ICON.warn}</span>
      <h3>${esc(t(title))}</h3>
      <p>${esc(t(text, { proto: (S.url.split(":")[0] || "").toUpperCase() }))}</p>
      <div class="chp-veil-actions">
        ${detail === "nostream" ? "" : `<button class="btn btn-sm btn-ghost" type="button" data-chp-retry>${esc(t("chan.retry"))}</button>`}
        ${canReport ? `<button class="btn btn-sm btn-danger" type="button" data-chp-report>${ICON.flag}<span>${esc(t("chan.report"))}</span></button>` : ""}
        ${S.list.length > 1 ? `<button class="btn btn-sm btn-ghost" type="button" data-chp-next>${esc(t("chan.nextChannel"))}</button>` : ""}
        ${S.url ? `<button class="btn btn-sm btn-ghost" type="button" data-chp-copy>${esc(t("chan.copyLink"))}</button>` : ""}
      </div>
      ${S.opts.report === false && S.error ? `<code class="chp-detail" dir="ltr">${esc(S.error)}</code>` : ""}`;
    paintReport();
  }

  // the ring over the picture while it fills its buffer
  function paintBuffering(progress) {
    const box = $(".chp-buffer");
    if (!box) return;
    const on = progress !== undefined && S.state === "playing" && (S.phase === "rebuffer" || S.phase === "start");
    box.hidden = !on;
    if (!on) return;
    const pct = Math.round(clamp(progress, 0, 1) * 100);
    box.style.setProperty("--p", String(pct));
    const speed = S.speed > 0 ? bitsText(S.speed) : "";
    box.querySelector("b").textContent = `${pct}%`;
    box.querySelector(".chp-btext").textContent = speed ? `${t("chan.buffering")} · ${speed}` : t("chan.buffering");
  }

  function flash(icon) {
    const el = $(".chp-flash");
    if (!el || reducedMotion()) return;
    el.innerHTML = icon;
    el.classList.remove("on");
    void el.offsetWidth;
    el.classList.add("on");
  }

  function unmuteButton(show) {
    const btn = $(".chp-unmute");
    if (btn) btn.hidden = !show;
    paintVolume();
  }

  function paintChannel(ch, zapped) {
    if (!S.root) return;
    const live = rowType(ch) === "live";
    $(".chp-head-logo").innerHTML = logoHtml(ch, "chp-logo");
    $(".chp-title").textContent = ch.channel_name || "";
    $(".chp-sub").textContent = [ch.group_name, ch.package_name].filter(Boolean).join(" · ");
    const badge = $(".chp-live");
    badge.innerHTML = live ? `<i></i>${esc(t("chan.live"))}` : esc(typeLabel(ch));
    badge.classList.toggle("vod", !live);
    const many = S.list.length > 1;
    S.root.querySelectorAll(".chp-many").forEach((el) => {
      el.hidden = !many;
    });
    $(".chp-pos").textContent = many ? t("chan.pos", { i: S.index + 1, n: S.list.length }) : "";
    S.card.classList.toggle("is-single", !many);
    unmuteButton(false);
    // undo only the mute the player applied for the autoplay rules, never the viewer's own
    if (S.video && S.autoMuted) S.video.muted = false;
    S.autoMuted = false;
    S.skipVolume = false;
    paintRail();
    paintReport();
    paintControls();
    checkReported(ch);
    mediaSession(ch);
    if (zapped) osd(ch);
    if (!S.epg || S.epg.ch !== ch) loadGuide(ch);
  }

  // The channels around the current one: a strip under the picture (a list on phones).
  function paintRail() {
    const rail = $(".chp-rail");
    if (!rail) return;
    const n = S.list.length;
    $(".chp-railbox").hidden = n < 2;
    if (n < 2) {
      rail.innerHTML = "";
      return;
    }
    const span = phone() ? RAIL_SPAN + 10 : RAIL_SPAN;
    const from = Math.max(0, S.index - span);
    const to = Math.min(n, S.index + span + 1);
    let html = "";
    for (let i = from; i < to; i += 1) {
      const ch = S.list[i];
      const cur = i === S.index;
      html += `<button class="chp-tile${cur ? " is-current" : ""}" type="button" role="listitem" data-chp-go="${i}" tabindex="${cur ? 0 : -1}"${cur ? ' aria-current="true"' : ""} title="${esc(ch.channel_name || "")}">
        ${logoHtml(ch, "chp-tlogo")}
        <span class="chp-tname"><b>${esc(ch.channel_name || "")}</b><small>${esc(ch.group_name || typeLabel(ch))}</small></span>
        ${cur ? '<i class="chp-eq" aria-hidden="true"><b></b><b></b><b></b></i>' : `<span class="chp-tnum">${i + 1}</span>`}
      </button>`;
    }
    rail.innerHTML = html;
    requestAnimationFrame(() => revealTile(false));
  }

  function revealTile(smoothly) {
    const rail = $(".chp-rail");
    const cur = rail && rail.querySelector(".is-current");
    if (!cur) return;
    const a = rail.getBoundingClientRect();
    const b = cur.getBoundingClientRect();
    const vertical = rail.scrollHeight > rail.clientHeight + 4 && a.height > a.width * 0.6;
    const behavior = smoothly && !reducedMotion() ? "smooth" : "auto";
    if (vertical) rail.scrollBy({ top: b.top + b.height / 2 - (a.top + a.height / 2), behavior });
    else rail.scrollBy({ left: b.left + b.width / 2 - (a.left + a.width / 2), behavior });
  }

  // a short banner with the new channel (also in full screen, where the header is hidden)
  function osd(ch) {
    const box = $(".chp-osd");
    if (!box) return;
    box.innerHTML = `${logoHtml(ch, "chp-ologo")}<span><b>${esc(ch.channel_name || "")}</b><small>${esc(S.list.length > 1 ? t("chan.pos", { i: S.index + 1, n: S.list.length }) : ch.group_name || "")}</small></span>`;
    box.classList.add("on");
    clearTimeout(S.osdTimer);
    S.osdTimer = setTimeout(() => box.classList.remove("on"), 2600);
  }

  function paintReport() {
    const ch = current();
    if (!S.root || !ch) return;
    const done = S.reported.has(reportKey(ch));
    S.root.querySelectorAll("[data-chp-report]").forEach((btn) => {
      btn.disabled = done;
      btn.classList.toggle("is-done", done);
      btn.innerHTML = done ? `${ICON.check}<span>${esc(t("chan.reported"))}</span>` : `${ICON.flag}<span>${esc(t("chan.report"))}</span>`;
    });
  }

  // ---------- the programme guide of the current channel ----------
  async function loadGuide(ch, keep = false) {
    const run = ++S.epgRun;
    if (!keep) {
      S.epg = null;
      paintEpg();
    }
    if (!ch || rowType(ch) !== "live") return;
    const url = await epgSource(String(ch.package_name || ""), S.opts.accounts);
    if (run !== S.epgRun || !S.root || !url) return;
    if (!keep) {
      S.epg = { ch, url, data: null, loading: true, failed: false };
      paintEpg();
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
      let ans = null;
      try {
        ans = await epgLookup(url, [ch]);
      } catch {
        ans = null;
      }
      if (run !== S.epgRun || !S.root) return;
      if (ans === "loading") {
        // the server is still reading the guide (a big one takes a few seconds)
        await new Promise((r) => setTimeout(r, 3000));
        if (run !== S.epgRun || !S.root) return;
        continue;
      }
      if (keep && !ans) return; // a refresh that failed: keep what is shown
      S.epg = { ch, url, data: ans ? ans.get(epgKey(ch)) || null : null, loading: false, failed: !ans, at: Date.now() };
      paintEpg();
      return;
    }
    if (!keep) {
      S.epg = { ch, url, data: null, loading: false, failed: true };
      paintEpg();
    }
  }

  function paintEpg() {
    if (!S.root) return;
    const line = $(".chp-epg");
    const btn = $("[data-chp-guide]");
    const e = S.epg;
    btn.hidden = !e;
    setLabel(btn, t("chan.epg.title"), "G");
    btn.setAttribute("aria-expanded", String(Boolean(e) && S.guideOpen));
    const { cur, next } = epgNow(e && e.data);
    // times in <bdi>, never dir=ltr: in Arabic a range reads from the right (start on the right)
    const nextHtml = next ? `<span class="chp-epg-next"><span class="chp-epg-tag">${esc(t("chan.epg.next"))}</span> <bdi>${esc(clockText(next[0], true))}</bdi> <bdi>${esc(next[2] || "")}</bdi></span>` : "";
    if (cur) {
      line.innerHTML = `
        <span class="chp-epg-now"><span class="chp-epg-tag on">${esc(t("chan.epg.now"))}</span> <bdi class="chp-epg-title">${esc(cur[2] || "")}</bdi> <span class="chp-epg-time"><bdi>${esc(clockText(cur[0]))}</bdi>–<bdi>${esc(clockText(cur[1]))}</bdi></span></span>
        <i class="chp-epg-bar" aria-hidden="true"><b style="width:${Math.round(epgShare(cur) * 100)}%"></b></i>${nextHtml}`;
      line.title = `${cur[2] || ""}${cur[3] ? `\n${cur[3]}` : ""}`;
    } else line.innerHTML = nextHtml;
    line.hidden = !line.innerHTML;
    paintGuidePanel();
  }

  // On a phone held upright the guide takes the place of the channel list under
  // the picture (the picture is too small to hold it); elsewhere it opens on the picture.
  function guideHost() {
    const foot = $(".chp-foot");
    return phone() && foot && getComputedStyle(foot).display !== "none" ? foot : S.stage;
  }

  function paintGuidePanel() {
    const box = $(".chp-guide");
    if (!box) return;
    const e = S.epg;
    const show = Boolean(e) && S.guideOpen;
    box.hidden = !show;
    S.card.classList.toggle("guide-open", show);
    if (!show) {
      box.innerHTML = "";
      return;
    }
    const host = guideHost();
    if (box.parentElement !== host) host.prepend(box);
    const at = Date.now();
    const { list } = epgNow(e.data, at);
    let body;
    if (e.loading) body = `<p class="chp-gmsg"><span class="chp-ring" aria-hidden="true"><i></i></span>${esc(t("chan.epg.loading"))}</p>`;
    else if (e.failed) body = `<p class="chp-gmsg">${esc(t("chan.epg.fail"))}</p>`;
    else if (!list.length) body = `<p class="chp-gmsg">${esc(t("chan.epg.none"))}</p>`;
    else {
      body = `<ol class="chp-glist">${list
        .map((p) => {
          const on = p[0] * 1000 <= at;
          return `
          <li class="${on ? "is-now" : ""}">
            <span class="chp-gtime"><bdi>${esc(clockText(p[0], true))}</bdi></span>
            <div class="chp-gtext">
              <strong>${on ? `<span class="chp-epg-tag on">${esc(t("chan.epg.now"))}</span> ` : ""}<bdi>${esc(p[2] || "—")}</bdi></strong>
              ${on ? `<i class="chp-epg-bar" aria-hidden="true"><b style="width:${Math.round(epgShare(p, at) * 100)}%"></b></i>` : ""}
              ${p[3] ? `<p>${esc(p[3])}</p>` : ""}
            </div>
          </li>`;
        })
        .join("")}</ol>`;
    }
    const top = box.scrollTop;
    box.innerHTML = `
      <div class="chp-shead"><strong>${esc(t("chan.epg.title"))}</strong><button class="chp-icon chp-sclose" type="button" data-chp-guide aria-label="${esc(t("common.close"))}">${ICON.close}</button></div>
      <p class="chp-gch"><bdi>${esc(e.ch.channel_name || "")}</bdi></p>
      ${body}
      ${list.length ? `<p class="chp-shint">${esc(t("chan.epg.tz"))}</p>` : ""}`;
    box.scrollTop = top;
  }

  function toggleGuide(force) {
    S.guideOpen = typeof force === "boolean" ? force : !S.guideOpen;
    if (S.guideOpen && S.statsOpen) {
      S.statsOpen = false; // one panel at a time: they share the picture
      paintStatsPanel();
    }
    paintEpg();
  }

  function setLabel(btn, label, key) {
    if (!btn) return;
    btn.setAttribute("aria-label", label);
    btn.title = key ? `${label} (${key})` : label;
  }

  function paintVolume() {
    const v = S.video;
    if (!v || !S.root) return;
    const btn = $("[data-chp-mute]");
    const silent = v.muted || v.volume === 0;
    btn.innerHTML = silent ? ICON.volOff : v.volume < 0.5 ? ICON.volLow : ICON.vol;
    setLabel(btn, t(silent ? "chan.ctl.unmute" : "chan.ctl.mute"), "M");
    const range = $(".chp-volume");
    const level = silent ? 0 : v.volume;
    range.value = String(level);
    range.style.setProperty("--v", `${Math.round(level * 100)}%`);
  }

  function paintControls() {
    if (!S.root || !S.video) return;
    const v = S.video;
    const paused = (v.paused && !S.autoPause && S.phase !== "start") || S.userPaused;
    const playBtn = $("[data-chp-play]");
    playBtn.innerHTML = paused ? ICON.play : ICON.pause;
    setLabel(playBtn, t(paused ? "chan.ctl.play" : "chan.ctl.pause"), "K");
    setLabel($(".chp-controls [data-chp-prev]"), t("chan.ctl.prevCh"));
    setLabel($(".chp-controls [data-chp-next]"), t("chan.ctl.nextCh"));
    paintVolume();
    const vod = isVod() && S.state === "playing";
    $(".chp-seek").hidden = !vod;
    $(".chp-time").hidden = !vod;
    $("[data-chp-golive]").hidden = vod || S.state !== "playing";
    S.stage.classList.toggle("is-vod", vod);
    // quality menu: only when the stream offers several
    const levels = S.engine ? S.engine.levels().filter((l) => l.height || l.bitrate) : [];
    const q = $("[data-chp-quality]");
    q.hidden = levels.length < 2;
    if (!q.hidden) {
      const playing = S.engine.playing();
      const lv = S.engine.levels()[playing];
      const manual = S.engine.level();
      q.querySelector(".chp-qbadge").textContent = lv && lv.height >= 720 ? "HD" : "";
      setLabel(q, `${t("chan.ctl.quality")}: ${manual < 0 ? t("chan.ctl.auto") : levelName(lv)}`);
    }
    const pip = $("[data-chp-pip]");
    pip.hidden = !(document.pictureInPictureEnabled && !v.disablePictureInPicture && typeof v.requestPictureInPicture === "function") || S.state !== "playing";
    setLabel(pip, t("chan.ctl.pip"), "P");
    const full = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
    const fs = $("[data-chp-fs]");
    fs.innerHTML = full ? ICON.fsExit : ICON.fs;
    setLabel(fs, t(full ? "chan.ctl.exitFullscreen" : "chan.ctl.fullscreen"), "F");
    S.root.querySelectorAll("[data-chp-stats]:not(.chp-sclose)").forEach((b) => b.setAttribute("aria-expanded", String(S.statsOpen)));
    setLabel($(".chp-controls [data-chp-stats]"), t("chan.ctl.stats"), "I");
    paintLive();
    if (vod) paintTime();
  }

  const levelName = (lv) => (!lv ? "" : lv.height ? `${lv.height}p` : bitsText(lv.bitrate));

  function paintLive() {
    const btn = $("[data-chp-golive]");
    if (!btn || btn.hidden || !S.engine) return;
    const info = S.engine.info();
    let behind = false;
    if (S.engine.kind === "hls") behind = info.latency > 0 && info.latency - info.target > Math.max(6, 1.5 * (info.segment || 4));
    else if (S.engine.kind === "native") {
      const s = S.video.seekable;
      behind = s && s.length ? s.end(s.length - 1) - S.video.currentTime > 20 : false;
    } else behind = bufferAhead() > 20;
    btn.classList.toggle("is-behind", behind);
    setLabel(btn, behind ? t("chan.ctl.goLive") : t("chan.live"));
  }

  function paintTime() {
    const v = S.video;
    const bar = $(".chp-seekbar");
    if (!v || !bar || $(".chp-seek").hidden) return;
    const d = Number.isFinite(v.duration) ? v.duration : 0;
    if (!S.seeking && d > 0) bar.value = String(Math.round((v.currentTime / d) * 1000));
    let buf = 0;
    const b = v.buffered;
    for (let i = 0; i < b.length; i += 1) if (b.start(i) <= v.currentTime + 0.5) buf = Math.max(buf, b.end(i));
    bar.style.setProperty("--pos", `${d ? ((S.seeking ? (Number(bar.value) / 1000) * d : v.currentTime) / d) * 100 : 0}%`);
    bar.style.setProperty("--buf", `${d ? (buf / d) * 100 : 0}%`);
    $(".chp-time").textContent = `${clock(S.seeking ? (Number(bar.value) / 1000) * d : v.currentTime)} / ${clock(d)}`;
  }

  // the speed on the picture, and Stream info when it is open
  function paintStats() {
    const pill = $(".chp-speed");
    if (!pill) return;
    const show = S.state === "playing" && S.engine;
    pill.hidden = !show;
    if (!show) return;
    const info = S.engine.info();
    const known = S.speed > 0 || info.speed > 0;
    const b = bits(S.speed || info.speed || 0);
    pill.querySelector(".chp-sv").textContent = known ? b.value : "—";
    pill.querySelector(".chp-su").textContent = b.unit;
    pill.dataset.health = health();
    pill.classList.toggle("is-idle", S.speedIdle);
    const label = `${t("chan.nfo.speed")}: ${known ? `${b.value} ${b.unit}` : "—"}`;
    pill.setAttribute("aria-label", `${label} — ${t("chan.ctl.stats")}`);
    pill.title = `${label} (I)`;
    spark(pill.querySelector(".chp-spark"), S.hist.slice(-30));
    if (S.statsOpen) paintStatsPanel();
  }

  function paintStatsPanel() {
    const box = $(".chp-stats");
    if (!box) return;
    const show = S.statsOpen && Boolean(S.engine) && S.state === "playing";
    box.hidden = !show;
    S.root.querySelectorAll("[data-chp-stats]:not(.chp-sclose)").forEach((b) => b.setAttribute("aria-expanded", String(S.statsOpen)));
    if (!show) return;
    if (!box.firstElementChild) {
      box.innerHTML = `
        <div class="chp-shead"><strong>${esc(t("chan.nfo.title"))}</strong><button class="chp-icon chp-sclose" type="button" data-chp-stats aria-label="${esc(t("common.close"))}">${ICON.close}</button></div>
        <dl></dl>
        <canvas class="chp-graph" width="240" height="56" aria-hidden="true"></canvas>
        <p class="chp-shint">${esc(t("chan.nfo.hint"))}</p>`;
    }
    const e = S.engine;
    const v = S.video;
    const info = e.info();
    const speed = S.speed || info.speed || 0;
    const rows = [];
    const row = (k, val, cls = "") => rows.push(`<div class="chp-srow ${cls}"><dt>${esc(k)}</dt><dd>${val}</dd></div>`);
    row(t("chan.nfo.speed"), speed > 0 ? `<b>${esc(bitsText(speed))}</b> <small>${esc(bytesRate(speed))}</small>` : "—", `h-${health()}`);
    if (e.meter && S.speeds.length > 2) row(t("chan.nfo.avg"), esc(bitsText(average(S.speeds))));
    if (info.bitrate > 0) row(t("chan.nfo.bitrate"), esc(bitsText(info.bitrate)));
    row(t("chan.nfo.buffer"), esc(secsText(bufferAhead())));
    if (v.videoWidth) row(t("chan.nfo.res"), `<bdi dir="ltr">${esc(`${v.videoWidth} × ${v.videoHeight}${S.fps > 1 ? ` · ${nf(0).format(S.fps)} fps` : ""}`)}</bdi>`);
    if (S.frames && S.frames.total > 0) row(t("chan.nfo.frames"), esc(t("chan.nfo.framesVal", { d: nf(0).format(S.frames.dropped), n: nf(0).format(S.frames.total) })));
    if (engineLive() && e.kind === "hls" && info.latency > 0) row(t("chan.nfo.delay"), esc(t("chan.nfo.delayVal", { s: secsText(info.latency) })));
    if (info.bytes > 0) row(t("chan.nfo.data"), esc(sizeText(info.bytes)));
    const engineName = { hls: "HLS", ts: "MPEG-TS", flv: "FLV", native: "HTML5" }[e.kind] || e.kind;
    row(t("chan.nfo.player"), `${esc(engineName)} · ${esc(t(S.step && S.step.via === "relay" ? "chan.nfo.relay" : "chan.nfo.direct"))}`);
    box.querySelector("dl").innerHTML = rows.join("");
    spark(box.querySelector(".chp-graph"), S.hist, info.bitrate);
  }

  // a small line graph of the speed (and the stream bitrate as a dashed line)
  function spark(canvas, values, mark = 0) {
    if (!canvas || !canvas.getContext) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const list = values.filter((x) => Number.isFinite(x));
    if (list.length < 2) return;
    const top = Math.max(...list, mark) * 1.15 || 1;
    const x = (i) => (i / (list.length - 1)) * (w - 2) + 1;
    const y = (val) => h - 2 - (val / top) * (h - 4);
    const color = getComputedStyle(canvas).color || "#5aa9ff";
    const fill = g.createLinearGradient(0, 0, 0, h);
    fill.addColorStop(0, "rgba(90, 169, 255, 0.42)");
    fill.addColorStop(1, "rgba(90, 169, 255, 0)");
    g.beginPath();
    list.forEach((val, i) => (i ? g.lineTo(x(i), y(val)) : g.moveTo(x(i), y(val))));
    g.lineTo(x(list.length - 1), h);
    g.lineTo(x(0), h);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
    g.beginPath();
    list.forEach((val, i) => (i ? g.lineTo(x(i), y(val)) : g.moveTo(x(i), y(val))));
    g.strokeStyle = color;
    g.lineWidth = 1.6;
    g.lineJoin = "round";
    g.stroke();
    if (mark > 0) {
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(0, y(mark));
      g.lineTo(w, y(mark));
      g.strokeStyle = "rgba(251, 191, 36, 0.8)";
      g.lineWidth = 1;
      g.stroke();
      g.setLineDash([]);
    }
  }

  // Ambient light: the colours of the picture glow softly around the player.
  function glow() {
    const canvas = $(".chp-glow");
    const v = S.video;
    if (!canvas || !v) return;
    const on = S.state === "playing" && v.readyState >= 2 && !document.hidden && !reducedMotion();
    S.card.classList.toggle("has-glow", on);
    if (!on || (v.paused && canvas.dataset.drawn)) return;
    try {
      canvas.getContext("2d").drawImage(v, 0, 0, canvas.width, canvas.height);
      canvas.dataset.drawn = "1";
    } catch {
      S.card.classList.remove("has-glow");
    }
  }

  function mediaSession(ch) {
    const ms = navigator.mediaSession;
    if (!ms || typeof window.MediaMetadata !== "function") return;
    try {
      ms.metadata = new window.MediaMetadata({
        title: ch.channel_name || "",
        artist: [ch.group_name, ch.package_name].filter(Boolean).join(" · "),
        album: "CineAura",
        artwork: /^https:\/\//i.test(ch.logo_url || "") ? [{ src: ch.logo_url, sizes: "256x256" }] : [],
      });
      const many = S.list.length > 1;
      ms.setActionHandler("play", () => userPlay());
      ms.setActionHandler("pause", () => userPause());
      ms.setActionHandler("previoustrack", many ? () => play(S.index - 1) : null);
      ms.setActionHandler("nexttrack", many ? () => play(S.index + 1) : null);
    } catch {
      /* not supported here */
    }
  }

  function clearMediaSession() {
    const ms = navigator.mediaSession;
    if (!ms) return;
    try {
      ms.metadata = null;
      ["play", "pause", "previoustrack", "nexttrack"].forEach((a) => ms.setActionHandler(a, null));
    } catch {
      /* not supported here */
    }
  }

  // ---------- controls ----------
  function showControls() {
    if (!S.stage) return;
    S.stage.classList.remove("is-idle");
    clearTimeout(S.hideTimer);
    S.hideTimer = setTimeout(() => {
      if (!S.stage) return;
      const controls = S.stage.querySelector(".chp-controls");
      let keyboard = false;
      try {
        keyboard = controls.contains(document.activeElement) && document.activeElement.matches(":focus-visible");
      } catch {
        keyboard = false;
      }
      const busy = controls.matches(":hover") || keyboard || !S.stage.querySelector(".chp-menu").hidden;
      if (busy) return showControls();
      if (S.state !== "playing" || (S.video.paused && !S.autoPause)) return;
      S.stage.classList.add("is-idle");
    }, 2800);
  }

  async function toggleFullscreen() {
    const stage = S.stage;
    const v = S.video;
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      } else if (stage.requestFullscreen) {
        await stage.requestFullscreen({ navigationUI: "hide" });
      } else if (stage.webkitRequestFullscreen) {
        stage.webkitRequestFullscreen();
      } else if (v.webkitEnterFullscreen) {
        v.webkitEnterFullscreen(); // iPhone: only the video itself goes full screen
      }
    } catch {
      /* refused (not from a click) */
    }
  }

  async function togglePip() {
    const v = S.video;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch {
      /* not allowed here */
    }
  }

  function setVolume(level) {
    const v = S.video;
    v.volume = clamp(level, 0, 1);
    v.muted = v.volume === 0;
  }

  function toggleMute() {
    const v = S.video;
    S.autoMuted = false;
    if (v.muted || v.volume === 0) {
      v.muted = false;
      if (v.volume === 0) v.volume = 0.6;
      unmuteButton(false);
    } else v.muted = true;
  }

  function openQuality() {
    const menu = $(".chp-menu");
    const btn = $("[data-chp-quality]");
    if (!menu || !S.engine) return;
    if (!menu.hidden) {
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      return;
    }
    const manual = S.engine.level();
    const playing = S.engine.levels()[S.engine.playing()];
    const levels = S.engine.levels().slice().sort((a, b) => (b.height || b.bitrate) - (a.height || a.bitrate));
    const item = (i, label) => `<button type="button" role="menuitemradio" aria-checked="${manual === i}" data-chp-level="${i}">${esc(label)}</button>`;
    menu.innerHTML = item(-1, playing ? `${t("chan.ctl.auto")} (${levelName(playing)})` : t("chan.ctl.auto")) + levels.map((l) => item(l.i, levelName(l))).join("");
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    menu.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
  }

  function closeMenus() {
    const menu = $(".chp-menu");
    if (menu && !menu.hidden) {
      menu.hidden = true;
      $("[data-chp-quality]")?.setAttribute("aria-expanded", "false");
      return true;
    }
    return false;
  }

  function toggleStats(force) {
    S.statsOpen = typeof force === "boolean" ? force : !S.statsOpen;
    if (S.statsOpen && S.guideOpen) {
      S.guideOpen = false;
      paintEpg();
    }
    paintStatsPanel();
  }

  function build() {
    const wrap = document.createElement("div");
    wrap.className = "chp-back";
    const label = (key) => esc(t(key));
    wrap.innerHTML = `
      <section class="chp-card" role="dialog" aria-modal="true" aria-labelledby="chp-title" tabindex="-1">
        <canvas class="chp-glow" width="16" height="9" aria-hidden="true"></canvas>
        <header class="chp-head">
          <span class="chp-head-logo"></span>
          <div class="chp-titles">
            <h2 class="chp-title" id="chp-title"></h2>
            <p class="chp-sub"></p>
            <p class="chp-epg" hidden></p>
          </div>
          <span class="chp-live off"></span>
          <button class="chp-x" type="button" data-chp-close aria-label="${label("common.close")}" title="${label("common.close")} (Esc)">${ICON.close}</button>
        </header>
        <div class="chp-stage" data-state="loading">
          <video class="chp-video" playsinline webkit-playsinline preload="auto"></video>
          <div class="chp-shade" aria-hidden="true"></div>
          <div class="chp-top" dir="ltr">
            <button class="chp-speed" type="button" data-chp-stats aria-expanded="false" hidden>
              <i class="chp-dot" aria-hidden="true"></i>${ICON.down}<b class="chp-sv">—</b><small class="chp-su"></small>
              <canvas class="chp-spark" width="56" height="18" aria-hidden="true"></canvas>
            </button>
            <button class="chp-icon chp-stage-x" type="button" data-chp-close aria-label="${label("common.close")}">${ICON.close}</button>
          </div>
          <div class="chp-stats" dir="${isRtl() ? "rtl" : "ltr"}" role="group" aria-label="${label("chan.nfo.title")}" hidden></div>
          <div class="chp-guide" dir="${isRtl() ? "rtl" : "ltr"}" role="region" aria-label="${label("chan.epg.title")}" hidden></div>
          <div class="chp-osd" aria-hidden="true"></div>
          <div class="chp-flash" aria-hidden="true"></div>
          <div class="chp-buffer" role="status" hidden><span class="chp-ring" aria-hidden="true"><i></i></span><b></b><span class="chp-btext"></span></div>
          <div class="chp-veil" hidden></div>
          <button class="chp-unmute" type="button" data-chp-unmute hidden>${ICON.muted}<span>${label("chan.unmute")}</span></button>
          <div class="chp-controls" dir="ltr">
            <div class="chp-seek" hidden><input class="chp-seekbar" type="range" min="0" max="1000" step="1" value="0" aria-label="${label("chan.ctl.seek")}" /></div>
            <div class="chp-bar">
              <div class="chp-group">
                <button class="chp-icon chp-playbtn" type="button" data-chp-play>${ICON.pause}</button>
                <button class="chp-icon chp-many" type="button" data-chp-prev>${ICON.skipPrev}</button>
                <button class="chp-icon chp-many" type="button" data-chp-next>${ICON.skipNext}</button>
                <div class="chp-vol">
                  <button class="chp-icon" type="button" data-chp-mute>${ICON.vol}</button>
                  <input class="chp-volume" type="range" min="0" max="1" step="0.05" value="1" aria-label="${label("chan.ctl.volume")}" />
                </div>
                <button class="chp-golive" type="button" data-chp-golive hidden><i></i><span>${label("chan.live")}</span></button>
                <span class="chp-time" hidden></span>
              </div>
              <div class="chp-group">
                <button class="chp-icon" type="button" data-chp-guide aria-expanded="false" hidden>${ICON.guide}</button>
                <button class="chp-icon" type="button" data-chp-stats aria-expanded="false">${ICON.stats}</button>
                <div class="chp-qwrap">
                  <button class="chp-icon" type="button" data-chp-quality aria-haspopup="menu" aria-expanded="false" hidden>${ICON.gear}<b class="chp-qbadge"></b></button>
                  <div class="chp-menu" role="menu" hidden></div>
                </div>
                <button class="chp-icon" type="button" data-chp-pip hidden>${ICON.pip}</button>
                <button class="chp-icon" type="button" data-chp-fs>${ICON.fs}</button>
              </div>
            </div>
          </div>
        </div>
        <footer class="chp-foot">
          <div class="chp-railbox" hidden>
            <button class="chp-rail-arrow" type="button" data-chp-prev aria-label="${label("chan.prev")}" title="${label("chan.prev")}">${ICON.prev}</button>
            <div class="chp-rail" role="list" aria-label="${label("chan.rail")}"></div>
            <button class="chp-rail-arrow" type="button" data-chp-next aria-label="${label("chan.next")}" title="${label("chan.next")}">${ICON.next}</button>
          </div>
          <div class="chp-footrow">
            <span class="chp-pos"></span>
            ${S.opts.report === false ? "" : `<button class="btn btn-sm btn-ghost chp-report" type="button" data-chp-report>${ICON.flag}<span>${label("chan.report")}</span></button>`}
          </div>
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
    const stage = wrap.querySelector(".chp-stage");
    const pref = store.get(VOLUME_KEY);
    if (pref && typeof pref === "object") {
      video.volume = clamp(Number(pref.v) || 0, 0, 1);
      video.muted = Boolean(pref.m);
    }
    video.addEventListener("volumechange", () => {
      paintVolume();
      if (S.skipVolume) {
        S.skipVolume = false;
        return;
      }
      S.autoMuted = false; // the viewer took over the sound
      if (!video.muted) unmuteButton(false);
      store.set(VOLUME_KEY, { v: Math.round(video.volume * 100) / 100, m: video.muted });
    });
    video.addEventListener("play", () => {
      if (!S.autoPause) S.userPaused = false;
      paintControls();
    });
    video.addEventListener("pause", () => {
      if (!S.autoPause && S.phase === "play" && S.state === "playing" && !video.ended) S.userPaused = true;
      paintControls();
      showControls();
    });
    video.addEventListener("playing", () => {
      S.lastMove = now();
      paintControls();
    });
    video.addEventListener("loadedmetadata", () => paintControls());
    video.addEventListener("durationchange", () => paintControls());
    // a <video> error after a good start (the native engines report nothing else)
    video.addEventListener("error", () => {
      if (S.state === "playing" && S.lateFail && video.getAttribute("src")) S.lateFail(`media error ${video.error ? video.error.code : ""}`.trim());
    });
    video.addEventListener("enterpictureinpicture", paintControls);
    video.addEventListener("leavepictureinpicture", paintControls);

    // pointer: show the controls; a click plays/pauses (mouse) or shows the controls (touch)
    stage.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "touch") showControls();
    });
    stage.addEventListener("pointerup", (e) => {
      const onPicture = e.target === video || e.target.classList.contains("chp-shade");
      if (!onPicture) return;
      if (closeMenus()) return;
      if (e.pointerType === "touch") {
        if (S.stage.classList.contains("is-idle")) showControls();
        else if (S.state === "playing" && !video.paused) S.stage.classList.add("is-idle");
        return;
      }
      if (e.button === 0) {
        togglePlay();
        showControls();
      }
    });
    stage.addEventListener("dblclick", (e) => {
      if (e.target === video || e.target.classList.contains("chp-shade")) {
        togglePlay(); // undo the play/pause of the double click's first click
        toggleFullscreen();
      }
    });
    stage.addEventListener("focusin", showControls);

    const vol = wrap.querySelector(".chp-volume");
    vol.addEventListener("input", () => {
      S.autoMuted = false;
      setVolume(Number(vol.value));
      if (Number(vol.value) > 0) unmuteButton(false);
    });
    const seek = wrap.querySelector(".chp-seekbar");
    seek.addEventListener("pointerdown", () => {
      S.seeking = true;
    });
    seek.addEventListener("input", () => {
      S.seeking = true;
      paintTime();
    });
    seek.addEventListener("change", () => {
      const d = video.duration;
      if (Number.isFinite(d) && d > 0) video.currentTime = (Number(seek.value) / 1000) * d;
      S.seeking = false;
    });
    wrap.querySelector(".chp-rail").addEventListener("keydown", (e) => {
      const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
      if (!(e.key in keys)) return;
      const tiles = [...e.currentTarget.querySelectorAll(".chp-tile")];
      const at = tiles.indexOf(document.activeElement);
      if (at < 0) return;
      e.preventDefault();
      e.stopPropagation();
      const flip = isRtl() && (e.key === "ArrowLeft" || e.key === "ArrowRight") ? -1 : 1;
      const next = tiles[clamp(at + keys[e.key] * flip, 0, tiles.length - 1)];
      tiles.forEach((tile) => tile.setAttribute("tabindex", tile === next ? "0" : "-1"));
      next.focus();
      next.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return wrap;
  }

  async function onClick(e) {
    const hit = (sel) => e.target.closest(sel);
    if (!hit(".chp-qwrap")) closeMenus();
    if (hit("[data-chp-close]")) return close();
    if (hit("[data-chp-prev]")) return play(S.index - 1);
    if (hit("[data-chp-next]")) return play(S.index + 1);
    const tile = hit("[data-chp-go]");
    if (tile) {
      const i = Number(tile.dataset.chpGo);
      if (i !== S.index) play(i);
      return undefined;
    }
    if (hit("[data-chp-retry]")) return play(S.index);
    if (hit("[data-chp-play]")) return togglePlay();
    if (hit("[data-chp-mute]")) return toggleMute();
    if (hit("[data-chp-fs]")) return toggleFullscreen();
    if (hit("[data-chp-pip]")) return togglePip();
    if (hit("[data-chp-stats]")) return toggleStats();
    if (hit("[data-chp-guide]")) return toggleGuide();
    if (hit("[data-chp-golive]")) {
      S.engine?.goLive();
      return paintLive();
    }
    if (hit("[data-chp-quality]")) return openQuality();
    const level = hit("[data-chp-level]");
    if (level) {
      S.engine?.setLevel(Number(level.dataset.chpLevel));
      closeMenus();
      return undefined;
    }
    if (hit("[data-chp-unmute]")) {
      S.autoMuted = false;
      S.video.muted = false;
      unmuteButton(false);
      return undefined;
    }
    if (hit("[data-chp-copy]")) {
      const ok = await C.copyText(S.url);
      toast(t(ok ? "chan.linkCopied" : "chan.rpt.fail"));
      return undefined;
    }
    const rep = hit("[data-chp-report]");
    if (rep && !rep.disabled) openReport(current());
    return undefined;
  }

  function focusables(root) {
    return [...root.querySelectorAll('button:not([disabled]):not([hidden]), [href], input:not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])')].filter(
      (el) => el.offsetParent !== null || el === document.activeElement
    );
  }

  // keyboard shortcuts of the player (YouTube's letters; arrows change the channel)
  function shortcut(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const el = document.activeElement;
    const typing = el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !["range", "radio", "checkbox"].includes(el.type)) || el.isContentEditable);
    if (typing) return false;
    const onRange = el && el.tagName === "INPUT" && el.type === "range";
    const onButton = el && el.tagName === "BUTTON";
    const key = e.key;
    const lower = key.length === 1 ? key.toLowerCase() : key;
    const zap = (step) => {
      if (S.list.length > 1) play(S.index + step);
    };
    const flip = isRtl() ? -1 : 1;
    switch (lower) {
      case " ":
        if (onButton) return false;
        togglePlay();
        return true;
      case "k":
        togglePlay();
        return true;
      case "m":
        toggleMute();
        return true;
      case "f":
        toggleFullscreen();
        return true;
      case "i":
        toggleStats();
        return true;
      case "g":
        if (S.epg) toggleGuide();
        return true;
      case "p":
        if (!$("[data-chp-pip]").hidden) togglePip();
        return true;
      case "PageUp":
      case "ChannelUp":
      case "MediaTrackPrevious":
        zap(-1);
        return true;
      case "PageDown":
      case "ChannelDown":
      case "MediaTrackNext":
        zap(1);
        return true;
      case "ArrowUp":
      case "ArrowDown":
        if (onRange || el?.closest?.(".chp-rail, .chp-menu")) return false;
        S.autoMuted = false;
        setVolume((S.video.muted ? 0 : S.video.volume) + (lower === "ArrowUp" ? 0.1 : -0.1));
        if (S.video.volume > 0) unmuteButton(false);
        return true;
      case "ArrowLeft":
      case "ArrowRight": {
        if (onRange || el?.closest?.(".chp-rail, .chp-menu")) return false;
        const dir = lower === "ArrowRight" ? 1 : -1;
        if (isVod() && Number.isFinite(S.video.duration)) S.video.currentTime = clamp(S.video.currentTime + dir * 10, 0, S.video.duration - 0.5);
        else zap(dir * flip);
        return true;
      }
      default:
        return false;
    }
  }

  function onKey(e) {
    if (!S.root) return;
    const top = S.report || S.root;
    if (e.key === "Escape") {
      e.preventDefault();
      if (S.report) closeReport();
      else if (closeMenus()) $("[data-chp-quality]")?.focus();
      else if (S.statsOpen) toggleStats(false);
      else if (S.guideOpen) toggleGuide(false);
      else if (document.fullscreenElement || document.webkitFullscreenElement) return; // the browser leaves full screen
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
      return;
    }
    if (S.report) return;
    if (shortcut(e)) {
      e.preventDefault();
      showControls();
    }
  }

  function onFullscreen() {
    if (!S.root) return;
    paintControls();
    S.card.classList.toggle("is-full", Boolean(document.fullscreenElement || document.webkitFullscreenElement));
    requestAnimationFrame(() => revealTile(false));
  }

  function onVisibility() {
    if (S.root && !document.hidden) glow();
  }

  function onResize() {
    if (S.root && S.guideOpen) paintGuidePanel();
  }

  function open(list, index = 0, opts = {}) {
    const rows = (Array.isArray(list) ? list : [list]).filter(Boolean);
    if (!rows.length) return;
    if (S.root) close(true);
    S.list = rows;
    S.opts = opts || {};
    S.first = true;
    S.statsOpen = false;
    S.guideOpen = false;
    S.epg = null;
    S.lastFocus = document.activeElement;
    S.root = build();
    S.card = S.root.querySelector(".chp-card");
    S.stage = S.root.querySelector(".chp-stage");
    S.video = S.root.querySelector("video");
    document.body.appendChild(S.root);
    document.documentElement.classList.add("chp-open");
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("fullscreenchange", onFullscreen);
    document.addEventListener("webkitfullscreenchange", onFullscreen);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("resize", onResize);
    S.card.focus({ preventScroll: true });
    S.ticks = 0;
    S.ticker = setInterval(tick, TICK);
    showControls();
    play(Math.max(0, Math.min(rows.length - 1, Number(index) || 0)));
  }

  function close(silent = false) {
    if (!S.root) return;
    S.run += 1;
    S.epgRun += 1;
    S.epg = null;
    if (document.fullscreenElement && S.root.contains(document.fullscreenElement) && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    teardown();
    closeReport();
    clearInterval(S.ticker);
    clearTimeout(S.hideTimer);
    clearTimeout(S.osdTimer);
    clearMediaSession();
    S.root.remove();
    S.root = S.card = S.stage = S.video = null;
    S.state = "idle";
    document.documentElement.classList.remove("chp-open");
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("fullscreenchange", onFullscreen);
    document.removeEventListener("webkitfullscreenchange", onFullscreen);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("resize", onResize);
    if (S.lastFocus && typeof S.lastFocus.focus === "function" && document.contains(S.lastFocus)) {
      S.lastFocus.focus({ preventScroll: true });
    }
    const done = S.opts.onClose;
    S.opts = {};
    if (!silent && typeof done === "function") done();
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
        <h2 id="chr-title">${esc(t("chan.rpt.title"))}</h2>
        <p class="muted">${esc(t("chan.rpt.lead"))}</p>
        <div class="chr-ch">
          ${logoHtml(ch, "chr-logo")}
          <div><strong>${esc(ch.channel_name || "")}</strong><small>${esc([ch.group_name, ch.package_name].filter(Boolean).join(" · "))}</small></div>
        </div>
        <fieldset class="chr-reasons">
          <legend>${esc(t("chan.rpt.reason"))}</legend>
          ${REASONS.map(
            (r) => `<label class="chr-reason"><input type="radio" name="chr-reason" value="${r}"${failed && r === "not_working" ? " checked" : ""} /><span>${esc(t(`chan.rpt.${r}`))}</span></label>`
          ).join("")}
        </fieldset>
        <label class="chr-label" for="chr-note">${esc(t("chan.rpt.note"))}</label>
        <textarea id="chr-note" maxlength="500" rows="3" placeholder="${esc(t("chan.rpt.notePh"))}"></textarea>
        ${S.error ? `<p class="chr-hint">${esc(t("chan.rpt.attached"))}</p>` : ""}
        <div class="chr-actions">
          <button class="btn btn-sm btn-ghost" type="button" data-chr-cancel>${esc(t("common.cancel"))}</button>
          <button class="btn btn-sm btn-primary" type="submit">${esc(t("chan.rpt.send"))}</button>
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
      const stalls = S.stalls.length ? `player: ${S.stalls.length} stall(s) in 90 s` : "";
      const row = {
        channel_id: Number(ch.id) || null,
        package_name: pack.slice(0, 200),
        channel_name: name.slice(0, 200),
        group_name: String(ch.group_name || "").slice(0, 120),
        logo_url: String(ch.logo_url || "").slice(0, 1000),
        stream_url: String(ch.stream_url || S.url || "").slice(0, 2000),
        reason: REASONS.includes(reason) ? reason : "not_working",
        note: String(note || "").trim().slice(0, 500),
        error_detail: [
          S.error,
          S.state === "playing" ? `player: was playing (${S.step ? `${S.step.engine}/${S.step.via}` : "?"})` : "",
          stalls,
          S.state === "playing" && S.speed > 0 ? `speed ${Math.round(S.speed / 1000)} kbps` : "",
        ]
          .filter(Boolean)
          .join(" · ")
          .slice(0, 1000),
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
    warm,
    hintRoute,
    REASONS,
    epgSource,
    epgLookup,
    epgKey,
    epgNow,
    clockText,
  };
})();
