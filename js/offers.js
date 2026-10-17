/* CineAura — sponsored offers on Content.html (the offers feed of the ad network).

   The feed (FEED) answers with a list of offers:
     [{ id, name, anchor, conversion, url, network_icon, payout, ... }, ...]   (10 at most)
   Each one is shown as a card: its icon, its text (anchor), what it asks for
   (conversion) and a button; the link opens in a new tab.

   The feed is JSONP (a script that calls back with the list), so it is read inside a
   sandboxed frame: the network's script runs there, cut off from this page and its
   storage (the member session stays out of its reach), and hands the list over with
   postMessage. Every field is checked before it is shown: text only, http(s) links.
   A feed that is blocked, empty or too slow (9 s) simply shows nothing.

   Who sees them: visitors and members, except a premium member who switched on
   "Watch without ads" (Site Settings / Dashboard > Settings), as for the other ads.
   ENABLED = false switches them off; SHOW_TO_GUESTS = false keeps them for members.

   window.CineAuraOffers.mount(box, { limit, layout: "side" | "row", heading })
*/
(() => {
  "use strict";

  const ENABLED = true;
  const SHOW_TO_GUESTS = true;
  const FEED = "https://d3r33tlb373kwk.cloudfront.net/public/offers/feed.php?user_id=213564&api_key=f66502e8a3e2f4674d4dfd1291d34a22&s1=&s2=";
  const MAX = 10; // the feed gives 10 at most
  const TIMEOUT = 9000;

  const C = window.CineAura;
  if (!C) return;
  const { t, escapeHtml: esc } = C;

  // ---------------------------------------------------------------- reading the feed
  const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  // The feed may send "&amp;" inside its texts and links: turned back into characters.
  function decode(value) {
    return String(value ?? "").replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
  }

  function text(value, max) {
    return decode(value).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  }

  function link(value) {
    const raw = decode(value).trim();
    if (!raw) return "";
    try {
      const u = new URL(raw);
      return u.protocol === "https:" || u.protocol === "http:" ? u.href : "";
    } catch {
      return "";
    }
  }

  function clean(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const o of list) {
      if (!o || typeof o !== "object") continue;
      const url = link(o.url);
      const anchor = text(o.anchor || o.name, 160);
      if (!url || !anchor) continue;
      const id = text(o.id, 32) || url;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        url,
        anchor,
        name: text(o.name, 90),
        conversion: text(o.conversion, 180),
        icon: link(o.network_icon),
      });
      if (out.length >= MAX) break;
    }
    return out;
  }

  let request = null;
  // One read per page, shared by every box.
  function load() {
    if (request) return request;
    request = new Promise((resolve) => {
      const nonce = `cx${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("aria-hidden", "true");
      frame.setAttribute("title", "offers");
      frame.tabIndex = -1;
      frame.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden;inset-inline-start:-9999px";
      let timer = 0;
      const done = (list) => {
        window.removeEventListener("message", onMessage);
        clearTimeout(timer);
        frame.remove();
        resolve(list);
      };
      function onMessage(e) {
        if (e.source !== frame.contentWindow) return;
        const d = e.data;
        if (!d || typeof d !== "object" || d.cx !== nonce) return;
        let list = [];
        try {
          list = JSON.parse(String(d.list || "[]"));
        } catch {
          list = [];
        }
        done(clean(list));
      }
      window.addEventListener("message", onMessage);
      timer = setTimeout(() => done([]), TIMEOUT);
      const src = `${FEED}&callback=cxOffers`.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      const n = JSON.stringify(nonce);
      // inside the frame: the callback hands the list over as text, whatever happens
      frame.srcdoc = `<!doctype html><meta charset="utf-8"><script>
function send(list){try{parent.postMessage({cx:${n},list:JSON.stringify(Array.isArray(list)?list:[])},"*")}catch(e){parent.postMessage({cx:${n},list:"[]"},"*")}}
window.cxOffers=function(list){send(list)};
<\/script><script src="${src}" onerror="send([])"><\/script>`;
      document.body.appendChild(frame);
    });
    return request;
  }

  // ---------------------------------------------------------------- who sees them
  async function eligible() {
    if (!ENABLED) return false;
    if (!SHOW_TO_GUESTS && !C.getSession()?.member_id) return false;
    try {
      return !(await C.adFreeActive());
    } catch {
      return true;
    }
  }

  // ---------------------------------------------------------------- the boxes
  const GIFT = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="8" width="17" height="4.5" rx="1"/><path d="M5 12.5V20.5h14v-8M12 8v12.5"/><path d="M12 8C10.5 4.5 6.5 4 6.5 6.3S9.5 8 12 8zM12 8c1.5-3.5 5.5-4 5.5-1.7S14.5 8 12 8z"/></svg>';
  let seq = 0;
  const boxes = new Set();

  function cardHtml(o) {
    const title = o.conversion || o.name;
    return `<li>
      <a class="cx-offer" href="${esc(o.url)}" target="_blank" rel="sponsored noopener noreferrer nofollow"${title ? ` title="${esc(title)}"` : ""} data-offer="${esc(o.id)}">
        <span class="cx-offer-ico" aria-hidden="true">${GIFT}${o.icon ? `<img src="${esc(o.icon)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ""}</span>
        <span class="cx-offer-txt">
          <b dir="auto">${esc(o.anchor)}</b>
          ${o.conversion ? `<small dir="auto">${esc(o.conversion)}</small>` : ""}
        </span>
        <span class="cx-offer-go">${esc(t("offers.go"))}<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg></span>
      </a>
    </li>`;
  }

  async function mount(box, opts = {}) {
    if (!box) return 0;
    box.hidden = true;
    box.replaceChildren();
    if (!(await eligible())) return 0;
    const list = (await load()).slice(0, Math.max(1, Math.min(MAX, opts.limit || 5)));
    if (!list.length || !box.isConnected) return 0;
    const id = `cxo-h-${(seq += 1)}`;
    box.innerHTML = `
      <section class="cx-offers cx-offers--${opts.layout === "row" ? "row" : "side"}" aria-labelledby="${id}">
        <div class="cx-offers-head">
          <h2 id="${id}">${esc(opts.heading || t("offers.title"))}</h2>
          <span class="cx-offers-ad" title="${esc(t("offers.adHint"))}">${esc(t("offers.ad"))}</span>
        </div>
        <ul class="cx-offers-list">${list.map(cardHtml).join("")}</ul>
      </section>`;
    // a picture that does not load leaves the gift icon
    box.querySelectorAll(".cx-offer-ico img").forEach((img) => {
      img.addEventListener("error", () => img.remove(), { once: true });
    });
    box.hidden = false;
    boxes.add(box);
    return list.length;
  }

  // "Watch without ads" switched on: the offers go at once
  document.addEventListener("cineaura:adfree", (e) => {
    if (!e.detail?.on) return;
    boxes.forEach((box) => {
      box.hidden = true;
      box.replaceChildren();
    });
    boxes.clear();
  });

  window.CineAuraOffers = { mount, load, clean, decode, FEED };
})();
