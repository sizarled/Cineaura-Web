/* CineAura — Adsterra ads.
 *
 * Which unit goes where (from adsterra_ads.txt):
 *   Popunder ........ watch page only
 *   Native banner ... watch, cast, playlist
 *   Banners ......... watch, cast, playlist, profile
 *
 * Banners are picked by screen size:
 *   width >= 820 .... 728x90  (top)        width 560-819 .. 468x60  (top)
 *   width <  560 .... 320x50  (top)        every width .... 300x250 (in-page spots)
 *   width >= 1660 ... 160x600 side rails (160x300 when the window is short)
 *
 * Placement: banner at the top of the page, side rails, and in-page "spots" that the
 * pages mark with <div class="ad-spot" data-ad="inline|banner|rect"></div> — under the
 * player on the watch page, after the hero on Cast, under the title on Playlist and
 * inside the Updates feed on Profile. Nothing is placed at the bottom of the page.
 *
 * Ads are shown to Free members only (CineAura.adsEligible in common.js): guests and
 * active Silver / Gold / Diamond members never see them. If the plan cannot be checked,
 * no ads are shown.
 *
 * Ad-blocker check: window.CineAuraAds.status is "pending", "ok" or "blocked". The watch
 * page only counts watch minutes for a Free member while the status is "ok" (see
 * adsAllowCounting in watch.js). It turns "blocked" when an ad script fails to load, or when
 * an ad slot or the bait element is hidden or removed from the page.
 *
 * Set ENABLED to false to switch every ad off.
 */
(() => {
  "use strict";

  const ENABLED = true;
  // Banners run inside a sandboxed iframe, so an ad script cannot read the
  // member session stored in localStorage. Turn off only if a creative needs cookies.
  const SANDBOX_BANNERS = true;

  const UNITS = {
    popunder: "https://pl31696138.profitableratecpmnetwork.com/04/0e/c5/040ec503f7ba207e96e2acce3de1a24d.js",
    native: {
      src: "https://pl31696139.profitableratecpmnetwork.com/3b4f09316f543547dd3d931a280f3be2/invoke.js",
      container: "container-3b4f09316f543547dd3d931a280f3be2",
    },
    banner: {
      "728x90": { key: "2ef833a04430f21e06d8afd71c451412", w: 728, h: 90 },
      "468x60": { key: "075e8ba5dfa98a2b1c3425f1c3760e76", w: 468, h: 60 },
      "320x50": { key: "9b4cf6fa892950982f060f268701ab48", w: 320, h: 50 },
      "300x250": { key: "9c8179da9a5756c636f69bdd8f06c511", w: 300, h: 250 },
      "160x600": { key: "33c11957db50e65cac2d6cf23dec431f", w: 160, h: 600 },
      "160x300": { key: "70df9cd037e6bac372022dfd6ee4372b", w: 160, h: 300 },
    },
  };

  const PAGES = {
    "watch.html": { popunder: true, native: true, minutes: true }, // minutes: the notice is about watch time
    "cast.html": { native: true },
    "playlist.html": { native: true },
    "profile.html": {},
  };

  const RAIL_MIN_WIDTH = 1660; // 1280px content + a 160px rail and 16px gap on each side

  const page = PAGES[(location.pathname.split("/").pop() || "").toLowerCase()];
  if (!ENABLED || !page) return;

  const C = () => window.CineAura || {};

  // ---------- Ad-blocker detection ----------
  const frames = new Set();
  const failed = new Set(); // units whose script was refused (sticky until the page is reloaded)
  const watched = []; // [{ box, rail }] ad boxes that must stay visible
  let loadedUnits = 0;
  let bait = null;
  let notice = null;
  const startedAt = Date.now();
  const SETTLE_MS = 8000; // no news from the ad servers after this long counts as "fine"
  const ads = (window.CineAuraAds = { status: "pending" });
  let adsOff = false; // a premium member switched "Watch without ads" on (Site Settings)

  // Takes every ad off the page at once. Called from the Site Settings dialog.
  ads.hide = () => {
    adsOff = true;
    notice?.remove();
    notice = null;
    bait?.remove();
    frames.clear();
    watched.length = 0;
    document.querySelectorAll(".ad-slot, .ad-rail, .ad-unit, .cx-notice").forEach((el) => el.remove());
    document.querySelectorAll(".ad-spot").forEach((el) => el.replaceChildren());
    ads.status = "ok";
  };

  function fail(unit) {
    failed.add(unit);
    evaluate();
  }

  window.addEventListener("message", (e) => {
    if (typeof e.data !== "string" || !e.data.startsWith("cx-ad:")) return;
    const frame = [...frames].find((f) => f.contentWindow === e.source);
    if (!frame) return;
    if (e.data === "cx-ad:loaded") loadedUnits += 1;
    else if (e.data === "cx-ad:error") failed.add(frame.dataset.unit || "banner");
    evaluate();
  });

  function placeBait() {
    // Ad blockers hide elements with these well-known class names.
    bait = document.createElement("div");
    bait.className = "adsbox ad-banner textads banner-ads ad-placement pub_300x250";
    bait.style.cssText = "position:absolute;left:-9999px;top:-9999px;width:10px;height:10px;pointer-events:none";
    bait.innerHTML = "&nbsp;";
    document.body.appendChild(bait);
  }

  function hidden(el) {
    if (!el || !el.isConnected) return true;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return true;
    const r = el.getBoundingClientRect();
    return r.width === 0 || r.height === 0;
  }

  function evaluate() {
    if (adsOff) return;
    let blocked = failed.size > 0 || Boolean(bait && hidden(bait));
    if (!blocked) {
      blocked = watched.some(({ box, rail }) => {
        if (rail && !rail.isConnected) return true;
        if (rail && !rail.classList.contains("is-on")) return false; // rail not shown at this width
        const frame = box.querySelector("iframe");
        return !frame || hidden(box) || hidden(frame);
      });
    }
    ads.status = blocked ? "blocked" : loadedUnits > 0 || Date.now() - startedAt > SETTLE_MS ? "ok" : "pending";
    showNotice(blocked);
  }

  function showNotice(on) {
    if (!page.minutes) return; // only the watch page counts minutes
    if (!on) {
      notice?.remove();
      notice = null;
      return;
    }
    if (notice?.isConnected) return;
    const main = document.querySelector("main.page-main") || document.querySelector("main");
    if (!main) return;
    notice = document.createElement("div");
    notice.className = "cx-notice";
    notice.setAttribute("role", "status");
    notice.setAttribute("data-i18n", "ads.blocked");
    notice.textContent = "An ad blocker was detected. Watch time is not counted while ads are hidden — please turn it off for this site.";
    main.before(notice);
    C().translateDom?.(notice);
  }

  function injectStyle() {
    const style = document.createElement("style");
    style.textContent = `
      .ad-slot { width: min(1220px, calc(100% - 28px)); margin: 16px auto 0; display: flex; flex-direction: column; align-items: center; gap: 6px; }
      .ad-label { font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted, #9bb0c2); opacity: 0.7; }
      .ad-box { max-width: 100%; overflow: hidden; display: flex; justify-content: center; }
      .ad-box iframe { display: block; border: 0; max-width: 100%; background: transparent; }
      /* <div class="ad-spot" data-ad="..."> placeholders placed by the pages */
      .ad-spot { width: 100%; max-width: 1220px; margin: 18px auto; padding: 0 14px; box-sizing: border-box; display: flex; flex-wrap: wrap; justify-content: center; align-items: flex-start; gap: 18px; }
      .ad-spot:empty { margin: 0; padding: 0; }
      .ad-unit { display: flex; flex-direction: column; align-items: center; gap: 6px; max-width: 100%; }
      .ad-unit.ad-native-unit { flex: 1 1 320px; max-width: 560px; align-items: stretch; }
      .ad-box.ad-native { display: block; width: 100%; overflow: visible; }
      .cx-notice { width: min(1220px, calc(100% - 28px)); margin: 16px auto 0; padding: 12px 16px; border-radius: 12px; border: 1px solid rgba(255, 139, 139, 0.45); background: rgba(255, 80, 80, 0.1); color: var(--text, #f4fbff); font-size: 13.5px; line-height: 1.5; text-align: center; }
      .ad-rail { position: fixed; top: 110px; z-index: 5; width: 160px; display: none; flex-direction: column; align-items: center; gap: 4px; }
      .ad-rail-left { left: calc(50% - 640px - 176px); }
      .ad-rail-right { right: calc(50% - 640px - 176px); }
      @media (min-width: ${RAIL_MIN_WIDTH}px) { .ad-rail.is-on { display: flex; } }
    `;
    document.head.appendChild(style);
  }

  function label() {
    const el = document.createElement("span");
    el.className = "ad-label";
    el.setAttribute("data-i18n", "ads.label");
    el.textContent = "Advertisement";
    return el;
  }

  function bannerFrame(def) {
    const frame = document.createElement("iframe");
    frame.width = def.w;
    frame.height = def.h;
    frame.title = "Advertisement";
    frame.scrolling = "no";
    frame.setAttribute("frameborder", "0");
    frame.setAttribute("referrerpolicy", "no-referrer-when-downgrade");
    if (SANDBOX_BANNERS) {
      frame.setAttribute(
        "sandbox",
        "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
      );
    }
    // Each banner lives in its own document, so the global atOptions of one unit
    // can never be overwritten by the next one.
    frame.srcdoc =
      '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent;overflow:hidden}</style></head><body>' +
      `<script>atOptions={'key':'${def.key}','format':'iframe','height':${def.h},'width':${def.w},'params':{}};<\/script>` +
      `<script src="https://www.highrevenueformat.com/${def.key}/invoke.js" onload="parent.postMessage('cx-ad:loaded','*')" onerror="parent.postMessage('cx-ad:error','*')"><\/script></body></html>`;
    frames.add(frame);
    return frame;
  }

  function fill(box, name) {
    if (adsOff) return;
    const def = UNITS.banner[name];
    box.dataset.size = name;
    box.style.minHeight = `${def.h}px`;
    const frame = bannerFrame(def);
    frame.dataset.unit = name;
    box.replaceChildren(frame);
  }

  function topSize() {
    const w = window.innerWidth;
    return w >= 820 ? "728x90" : w >= 560 ? "468x60" : "320x50";
  }

  function railSize() {
    if (window.innerWidth < RAIL_MIN_WIDTH) return null;
    return window.innerHeight >= 740 ? "160x600" : "160x300";
  }

  function loadNative(box) {
    box.classList.add("ad-native");
    const holder = document.createElement("div");
    holder.id = UNITS.native.container;
    const script = document.createElement("script");
    script.async = true;
    script.setAttribute("data-cfasync", "false");
    script.onerror = () => fail("native");
    script.src = UNITS.native.src;
    box.append(holder, script);
  }

  function loadPopunder() {
    if (adsOff) return;
    const script = document.createElement("script");
    script.onerror = () => fail("popunder");
    script.src = UNITS.popunder;
    document.body.appendChild(script);
  }

  // ---------- Spots: <div class="ad-spot" data-ad="inline | banner | rect"> ----------
  //   inline  300x250, plus the native banner where the page allows it (first one only)
  //   banner  the width-based banner (728x90 / 468x60 / 320x50)
  //   rect    300x250 only
  // Pages (and their JavaScript) just drop the empty placeholder where the ad should
  // sit; it is filled when it comes near the screen, and again after any re-render.
  let nativeUsed = false;

  function unit(extra) {
    const wrap = document.createElement("figure");
    wrap.className = `ad-unit ${extra || ""}`.trim();
    wrap.style.margin = "0";
    const box = document.createElement("div");
    box.className = "ad-box";
    wrap.append(label(), box);
    return { wrap, box };
  }

  function fillSpot(spot) {
    if (adsOff) return;
    if (spot.dataset.filled) return;
    spot.dataset.filled = "1";
    const kind = spot.dataset.ad || "inline";
    if (kind === "banner") {
      const u = unit();
      fill(u.box, topSize());
      spot.dataset.responsive = "1";
      spot.appendChild(u.wrap);
    } else {
      const u = unit();
      fill(u.box, "300x250");
      spot.appendChild(u.wrap);
      if (kind === "inline" && page.native && !nativeUsed) {
        nativeUsed = true;
        const n = unit("ad-native-unit");
        loadNative(n.box);
        spot.appendChild(n.wrap);
      }
    }
    C().translateDom?.(spot);
  }

  function watchSpots() {
    const io =
      "IntersectionObserver" in window
        ? new IntersectionObserver(
            (entries) => {
              entries.forEach((e) => {
                if (!e.isIntersecting) return;
                io.unobserve(e.target);
                fillSpot(e.target);
              });
            },
            { rootMargin: "300px 0px" }
          )
        : null;
    const scan = () => {
      if (adsOff) return;
      document.querySelectorAll(".ad-spot:not([data-filled]):not([data-queued])").forEach((spot) => {
        spot.dataset.queued = "1";
        if (io) io.observe(spot);
        else fillSpot(spot);
      });
    };
    let frame = 0;
    new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(scan);
    }).observe(document.body, { childList: true, subtree: true });
    scan();
  }

  function build() {
    const main = document.querySelector("main.page-main") || document.querySelector("main");
    if (!main) return;
    injectStyle();

    // Top of the page: the banner whose size follows the screen width.
    const top = document.createElement("aside");
    top.className = "ad-slot ad-top";
    top.setAttribute("aria-label", "Advertisement");
    const topBox = document.createElement("div");
    topBox.className = "ad-box";
    top.append(label(), topBox);
    main.before(top);
    fill(topBox, topSize());
    watched.push({ box: topBox, rail: null });
    placeBait();

    // Side rails on wide screens.
    const rails = ["left", "right"].map((side) => {
      const rail = document.createElement("aside");
      rail.className = `ad-rail ad-rail-${side}`;
      rail.setAttribute("aria-label", "Advertisement");
      const box = document.createElement("div");
      box.className = "ad-box";
      rail.append(label(), box);
      document.body.appendChild(rail);
      watched.push({ box, rail });
      return { rail, box };
    });
    const syncRails = () => {
      const size = railSize();
      rails.forEach(({ rail, box }) => {
        rail.classList.toggle("is-on", Boolean(size));
        if (size && box.dataset.size !== size) fill(box, size);
      });
    };
    syncRails();

    // In-page placements (under the player, in the updates feed, ...).
    watchSpots();
    C().translateDom?.(document);

    // Rotating a phone or resizing a window can change which size fits.
    let timer = 0;
    window.addEventListener("resize", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const size = topSize();
        if (topBox.dataset.size !== size) fill(topBox, size);
        document.querySelectorAll(".ad-spot[data-responsive] .ad-box").forEach((box) => {
          if (box.dataset.size !== size) fill(box, size);
        });
        syncRails();
        evaluate();
      }, 250);
    });

    if (page.popunder) loadPopunder();
  }

  async function start() {
    if (!(await C().adsEligible?.())) return;
    try {
      build();
    } catch (err) {
      // A bug in this file must never cost a member their watch time.
      console.warn("[CineAura] ads could not start", err);
      ads.status = "ok";
      return;
    }
    setTimeout(evaluate, 1500);
    setInterval(evaluate, 4000);
  }

  // Start as soon as the page is parsed; no need to wait for every poster to load.
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
