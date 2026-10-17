/* CineAura — member videos, shared by Profile > Your content (js/content-studio.js),
   Content.html (js/content.js) and Search.html (js/search.js).

   Everything goes through the content_* functions of sql/content.sql: the tables
   themselves are closed to the public key.

   window.CineAuraVideos:
     parseVideo(url)        what a link is (YouTube, Vimeo, Dailymotion, Facebook, Google
                            Drive, TikTok, an .mp4/.webm file, an .m3u8 stream, any page)
     embedSrc(info)         the player address of an iframe link
     autoThumb(info)        the picture a provider gives every video (sync), fetchThumb (async)
     cardHtml(item, opts)   a video card (search, suggestions)
     observeCards(root)     counts the cards that are seen (impressions) and clicked
     call(name, args)       rpc with { ok, data } | { setup: true } when the SQL is missing
*/
(() => {
  "use strict";
  const C = window.CineAura;
  const { t, tr, escapeHtml, getSession, getLocale, stableGuestId, countryName } = C;

  const AGES = [3, 6, 13, 16, 18];
  const VISIBILITIES = ["public", "exclusive", "private"];
  const LANGUAGES = [...C.LINK_LANGUAGES, "Other"];
  // Search.html: the language filter also narrows TMDB results (original_language).
  const LANG_ISO = {
    Arabic: "ar", English: "en", French: "fr", Spanish: "es", German: "de", Italian: "it", Portuguese: "pt",
    Turkish: "tr", Russian: "ru", Japanese: "ja", Korean: "ko", Chinese: "zh", Hindi: "hi", Dutch: "nl",
    Polish: "pl", Indonesian: "id", Thai: "th", Vietnamese: "vi", Persian: "fa", Urdu: "ur",
  };
  const PROVIDERS = ["youtube", "vimeo", "dailymotion", "facebook", "drive", "tiktok", "file", "hls", "link"];

  // ---------------------------------------------------------------- links
  function parseStart(v) {
    const raw = String(v || "").trim();
    if (!raw) return 0;
    if (/^\d+$/.test(raw)) return Number(raw);
    const m = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    return m ? Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0) : 0;
  }

  function parseVideo(raw) {
    const text = String(raw || "").trim();
    let u;
    try {
      u = new URL(text);
    } catch {
      return null;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (/[\s<>"`]/.test(text)) return null;
    const host = u.hostname.toLowerCase().replace(/^(www|m)\./, "");
    const path = u.pathname;
    const base = { url: text, host };
    let m;
    if (/(^|\.)youtube\.com$/.test(host) || /(^|\.)youtube-nocookie\.com$/.test(host) || host === "youtu.be") {
      let id = "";
      if (host === "youtu.be") id = path.split("/")[1] || "";
      else if ((m = path.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/))) id = m[1];
      else id = u.searchParams.get("v") || "";
      if (/^[\w-]{11}$/.test(id)) {
        return { ...base, provider: "youtube", id, start: parseStart(u.searchParams.get("t") || u.searchParams.get("start")) };
      }
    }
    if (/(^|\.)vimeo\.com$/.test(host)) {
      m = path.match(/\/(?:video\/)?(\d{6,12})(?:\/([0-9a-f]{6,20}))?(?:\/|$)/);
      if (m) return { ...base, provider: "vimeo", id: m[1], hash: m[2] || u.searchParams.get("h") || "" };
    }
    if (/(^|\.)dailymotion\.com$/.test(host)) {
      m = path.match(/\/(?:embed\/)?video\/([a-zA-Z0-9]+)/);
      if (m) return { ...base, provider: "dailymotion", id: m[1] };
    }
    if (host === "dai.ly") {
      const id = path.slice(1).split("/")[0];
      if (/^[a-zA-Z0-9]+$/.test(id)) return { ...base, provider: "dailymotion", id };
    }
    if (/(^|\.)facebook\.com$/.test(host) || host === "fb.watch") {
      return { ...base, provider: "facebook" };
    }
    if (host === "drive.google.com") {
      m = path.match(/\/file\/d\/([\w-]{10,})/);
      const id = m ? m[1] : u.searchParams.get("id") || "";
      if (/^[\w-]{10,}$/.test(id)) return { ...base, provider: "drive", id };
    }
    if (/(^|\.)tiktok\.com$/.test(host)) {
      m = path.match(/\/video\/(\d{8,25})/);
      if (m) return { ...base, provider: "tiktok", id: m[1] };
    }
    if (/\.m3u8$/i.test(path)) return { ...base, provider: "hls" };
    if (/\.(mp4|webm|ogg|ogv|mov|m4v)$/i.test(path)) return { ...base, provider: "file" };
    return { ...base, provider: "link" };
  }

  // The address of the player for the providers that play in an iframe; null for
  // files and streams, which play in a <video> element.
  function embedSrc(info, { autoplay = true } = {}) {
    if (!info) return null;
    const ap = autoplay ? 1 : 0;
    switch (info.provider) {
      case "youtube":
        return `https://www.youtube-nocookie.com/embed/${info.id}?autoplay=${ap}&rel=0&playsinline=1&modestbranding=1&enablejsapi=1&origin=${encodeURIComponent(location.origin)}${info.start ? `&start=${info.start}` : ""}`;
      case "vimeo":
        return `https://player.vimeo.com/video/${info.id}?autoplay=${ap}${info.hash ? `&h=${info.hash}` : ""}`;
      case "dailymotion":
        return `https://www.dailymotion.com/embed/video/${info.id}?autoplay=${ap}`;
      case "facebook":
        return `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(info.url)}&show_text=false&autoplay=${autoplay ? "true" : "false"}`;
      case "drive":
        return `https://drive.google.com/file/d/${info.id}/preview`;
      case "tiktok":
        return `https://www.tiktok.com/embed/v2/${info.id}`;
      case "link":
        return info.url;
      default:
        return null;
    }
  }

  // The picture every video of a provider has, without asking anything.
  function autoThumb(info) {
    if (!info) return "";
    if (info.provider === "youtube") return `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`;
    if (info.provider === "dailymotion") return `https://www.dailymotion.com/thumbnail/video/${info.id}`;
    if (info.provider === "drive") return `https://drive.google.com/thumbnail?id=${info.id}&sz=w640`;
    return "";
  }

  // Vimeo tells its picture through oEmbed; the others are known at once.
  async function fetchThumb(info) {
    const quick = autoThumb(info);
    if (quick || !info || info.provider !== "vimeo") return quick;
    try {
      const res = await fetch(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(info.url)}`);
      if (!res.ok) return "";
      const j = await res.json();
      return /^https:\/\//.test(j.thumbnail_url || "") ? j.thumbnail_url : "";
    } catch {
      return "";
    }
  }

  // ---------------------------------------------------------------- labels
  const provLabel = (p) => t(`vid.prov.${PROVIDERS.includes(p) ? p : "link"}`);
  const visLabel = (v) => t(`pm.vis.${VISIBILITIES.includes(v) ? v : "public"}`);
  const ageLabel = (a) => `${Number(a) || 3}+`;
  const langLabel = (l) => (!l ? "—" : l === "Other" ? t("vid.langOther") : tr(l));
  const regionLabel = (cc) => (cc ? countryName(cc) || cc : "—");
  const lockLabel = (why) => t(`vid.lock.${why}`);

  function numFormat(opts) {
    try {
      return new Intl.NumberFormat(getLocale(), { numberingSystem: "latn", ...opts });
    } catch {
      return new Intl.NumberFormat("en-US", opts);
    }
  }
  const fmtNum = (n) => numFormat().format(Number(n) || 0);
  const fmtCount = (n) => numFormat({ notation: "compact", maximumFractionDigits: 1 }).format(Number(n) || 0);

  function timeAgo(iso) {
    const at = Date.parse(iso || "");
    if (!Number.isFinite(at)) return "";
    const diff = (at - Date.now()) / 1000;
    const abs = Math.abs(diff);
    const steps = [
      [60, "second", 1],
      [3600, "minute", 60],
      [86400, "hour", 3600],
      [604800, "day", 86400],
      [2629800, "week", 604800],
      [31557600, "month", 2629800],
      [Infinity, "year", 31557600],
    ];
    const [, unit, div] = steps.find(([lim]) => abs < lim);
    try {
      return new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto" }).format(Math.round(diff / div), unit);
    } catch {
      return new Date(at).toLocaleDateString();
    }
  }

  function fullDate(iso) {
    const at = Date.parse(iso || "");
    if (!Number.isFinite(at)) return "—";
    try {
      return new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium", timeStyle: "short", numberingSystem: "latn" }).format(new Date(at));
    } catch {
      return new Date(at).toLocaleString();
    }
  }

  // 1d 02:03:04 (days only when there are some)
  function countdown(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (x) => String(x).padStart(2, "0");
    return `${d ? `${t("vid.daysShort", { n: d })} ` : ""}${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  // ---------------------------------------------------------------- viewer
  const memberId = () => getSession()?.member_id || "";
  const viewerId = () => memberId() || stableGuestId();
  async function geoCountry() {
    try {
      return (await C.detectGeo()) || "";
    } catch {
      return "";
    }
  }

  const contentHref = (id) => `./Content.html?idcontent=${encodeURIComponent(id || "")}`;
  function searchHref(params = {}) {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && String(v) !== "") q.set(k, String(v));
    });
    const s = q.toString();
    return `./Search.html${s ? `?${s}` : ""}`;
  }

  // ---------------------------------------------------------------- server
  function setupMissing(res) {
    const code = res?.data?.code;
    return res?.status === 404 || code === "PGRST202" || code === "PGRST205" || code === "42883";
  }

  async function call(name, args = {}) {
    let res;
    try {
      res = await C.rpc(name, args);
    } catch {
      return { ok: false, network: true };
    }
    if (!res.ok) {
      if (setupMissing(res)) {
        console.warn(`CineAura: ${name}() is missing — run sql/content.sql (and sql/point_codes.sql) in the Supabase SQL editor.`);
        return { ok: false, setup: true };
      }
      return { ok: false, status: res.status, data: res.data };
    }
    return { ok: true, data: res.data };
  }

  // A request that survives the page being left (a click on a card opens another page).
  function beacon(name, args) {
    try {
      fetch(`${C.SUPABASE_URL}/rest/v1/rpc/${name}`, {
        method: "POST",
        keepalive: true,
        headers: {
          apikey: C.SUPABASE_KEY,
          Authorization: `Bearer ${C.SUPABASE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(args),
      }).catch(() => {});
    } catch {
      /* counting must never break the page */
    }
  }

  function track(ids, kind, extra = {}) {
    const list = [...new Set((ids || []).filter(Boolean))].slice(0, 60);
    if (!list.length) return;
    beacon("content_track", { p_ids: list, p_kind: kind, p_viewer: viewerId(), p_network: extra.network || "", p_country: extra.country || "" });
  }

  // ---------------------------------------------------------------- cards
  const HUES = [205, 160, 260, 20, 330, 45, 190];
  function hueFor(s) {
    let h = 0;
    for (const ch of String(s || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return HUES[h % HUES.length];
  }

  function thumbHtml(item, { badges = true } = {}) {
    const title = String(item?.title || "");
    const initial = escapeHtml((title.trim()[0] || "▶").toUpperCase());
    const age = Number(item?.age || item?.age_rating || 3);
    // a video the viewer cannot watch yet (exclusive): a lock, and why on hover
    const lock = item?.locked ? `<span class="vbadge vbadge-lock" title="${escapeHtml(lockLabel(item.locked))}">${LOCK_ICON}<span>${escapeHtml(visLabel("exclusive"))}</span></span>` : "";
    return `<span class="vthumb" style="--vh:${hueFor(item?.id || title)}">
      <span class="vthumb-ph" aria-hidden="true">${initial}</span>
      ${item?.thumb ? `<img src="${escapeHtml(item.thumb)}" alt="" loading="lazy" data-vthumb />` : ""}
      ${badges ? `<span class="vbadges">${age > 3 ? `<span class="vbadge vbadge-age">${ageLabel(age)}</span>` : ""}${lock}</span>` : ""}
      <span class="vthumb-play" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5L13 8L4 13.5V2.5Z"/></svg></span>
    </span>`;
  }

  const LOCK_ICON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';

  function cardHtml(item, { compact = false } = {}) {
    if (!item?.id) return "";
    const meta = [
      `<bdi>@${escapeHtml(item.owner || "")}</bdi>`,
      escapeHtml(t("vid.viewsN", { n: fmtCount(item.views) })),
      escapeHtml(timeAgo(item.publish_at || item.created_at)),
    ].join(" · ");
    const tags = !compact && Array.isArray(item.tags) && item.tags.length
      ? `<span class="vcard-tags">${item.tags.slice(0, 4).map((x) => `<bdi>#${escapeHtml(x)}</bdi>`).join("")}</span>`
      : "";
    return `<a class="vcard${compact ? " vcard--compact" : ""}" href="${contentHref(item.id)}" data-vid="${escapeHtml(item.id)}" data-owner="${escapeHtml(item.owner_id || "")}">
      ${thumbHtml(item)}
      <span class="vcard-body">
        <b class="vcard-title">${escapeHtml(item.title || "")}</b>
        <span class="vcard-meta">${meta}</span>
        ${!compact && item.description ? `<span class="vcard-desc">${escapeHtml(item.description)}</span>` : ""}
        ${tags}
      </span>
    </a>`;
  }

  // A picture that does not load leaves the coloured placeholder under it.
  document.addEventListener(
    "error",
    (e) => {
      const img = e.target;
      if (img && img.matches && img.matches("img[data-vthumb]")) img.remove();
    },
    true
  );

  // ---------------------------------------------------------------- impressions and clicks
  const seen = new Set();
  let queue = [];
  let flushTimer = 0;
  let observer = null;

  function flushImpressions() {
    flushTimer = 0;
    const ids = queue;
    queue = [];
    if (ids.length) track(ids, "impression");
  }

  function queueImpression(id) {
    if (!id || seen.has(id)) return;
    seen.add(id);
    queue.push(id);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushImpressions, 600);
  }

  function observeCards(root = document) {
    const cards = [...root.querySelectorAll(".vcard[data-vid]")];
    if (!cards.length) return;
    if (typeof IntersectionObserver !== "function") {
      cards.forEach((c) => queueImpression(c.dataset.vid));
      return;
    }
    observer =
      observer ||
      new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            observer.unobserve(entry.target);
            queueImpression(entry.target.dataset.vid);
          });
        },
        { threshold: 0.5 }
      );
    cards.forEach((c) => observer.observe(c));
  }

  document.addEventListener(
    "click",
    (e) => {
      const card = e.target.closest?.(".vcard[data-vid]");
      if (card) track([card.dataset.vid], "click");
    },
    true
  );
  window.addEventListener("pagehide", flushImpressions);

  // ---------------------------------------------------------------- dialogs
  // A dialog in the style of the site; closes on Escape, on the backdrop and on [data-close].
  function openDialog(html, { label = "", wide = false, onClose } = {}) {
    const ov = document.createElement("div");
    ov.className = "modal-overlay vdlg-overlay";
    ov.innerHTML = `<section class="glass modal-card vdlg${wide ? " vdlg--wide" : ""}" role="dialog" aria-modal="true" aria-label="${escapeHtml(label)}" tabindex="-1">${html}</section>`;
    const prev = document.activeElement;
    const close = () => {
      document.removeEventListener("keydown", onKey);
      ov.remove();
      try {
        prev?.focus?.();
      } catch {
        /* the element may be gone */
      }
      onClose?.();
    };
    const onKey = (e) => {
      if (e.key === "Escape") close();
    };
    ov.addEventListener("click", (e) => {
      if (e.target === ov || e.target.closest("[data-close]")) close();
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(ov);
    const card = ov.querySelector(".vdlg");
    (card.querySelector("[autofocus]") || card).focus();
    return { el: card, close };
  }

  function confirmDialog({ title, text, yes, danger = false }) {
    return new Promise((resolve) => {
      let answered = false;
      const dlg = openDialog(
        `<h2>${escapeHtml(title)}</h2>
         <p class="muted">${escapeHtml(text)}</p>
         <div class="vdlg-actions">
           <button class="btn btn-sm btn-ghost" type="button" data-close>${escapeHtml(t("common.cancel"))}</button>
           <button class="btn btn-sm ${danger ? "btn-danger" : "btn-primary"}" type="button" data-yes autofocus>${escapeHtml(yes)}</button>
         </div>`,
        { label: title, onClose: () => { if (!answered) resolve(false); } }
      );
      dlg.el.querySelector("[data-yes]").onclick = () => {
        answered = true;
        dlg.close();
        resolve(true);
      };
    });
  }

  // "Add to playlist": the member's playlists with a tick when the video is in one,
  // and a field for a new playlist. Calls onChange after every change.
  async function playlistDialog(contentId, { onChange } = {}) {
    const me = memberId();
    if (!me) {
      C.toast(t("vid.signToSave"));
      return;
    }
    const dlg = openDialog(
      `<h2>${escapeHtml(t("vid.addToPl"))}</h2>
       <div class="vpl-list" data-pl-list><p class="muted">${escapeHtml(t("common.loading"))}</p></div>
       <form class="vpl-new" data-pl-new>
         <input name="name" maxlength="80" placeholder="${escapeHtml(t("vid.newPlPh"))}" aria-label="${escapeHtml(t("vid.newPl"))}" />
         <button class="btn btn-sm btn-primary" type="submit">${escapeHtml(t("vid.create"))}</button>
       </form>
       <div class="vdlg-actions"><button class="btn btn-sm btn-ghost" type="button" data-close>${escapeHtml(t("common.close"))}</button></div>`,
      { label: t("vid.addToPl") }
    );
    const list = dlg.el.querySelector("[data-pl-list]");
    const draw = async () => {
      const res = await call("content_playlists_mine", { p_member: me, p_content: contentId });
      if (!res.ok) {
        list.innerHTML = `<p class="empty">${escapeHtml(t(res.setup ? "vid.setup" : "vid.loadFail"))}</p>`;
        return;
      }
      const rows = res.data || [];
      list.innerHTML = rows.length
        ? rows
            .map(
              (p) => `<label class="vpl-row"><input type="checkbox" data-pl="${escapeHtml(p.id)}" ${p.has ? "checked" : ""} />
                <span><b>${escapeHtml(p.name)}</b><small>${escapeHtml(t("vid.plCount", { n: fmtNum(p.count) }))}</small></span></label>`
            )
            .join("")
        : `<p class="muted">${escapeHtml(t("vid.noPl"))}</p>`;
    };
    list.addEventListener("change", async (e) => {
      const box = e.target.closest("[data-pl]");
      if (!box) return;
      box.disabled = true;
      const res = box.checked
        ? await call("content_playlist_add", { p_member: me, p_content: contentId, p_playlist: box.dataset.pl, p_name: "" })
        : await call("content_playlist_remove", { p_member: me, p_content: contentId, p_playlist: box.dataset.pl });
      box.disabled = false;
      if (!res.ok || res.data?.ok === false) {
        box.checked = !box.checked;
        C.toast(t("vid.actFail"));
        return;
      }
      C.toast(t(box.checked ? "vid.plAdded" : "vid.plRemoved"));
      onChange?.();
      draw();
    });
    dlg.el.querySelector("[data-pl-new]").addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = e.currentTarget.elements.name;
      const name = input.value.trim();
      if (!name) return input.focus();
      const res = await call("content_playlist_add", { p_member: me, p_content: contentId, p_playlist: "", p_name: name });
      if (!res.ok || res.data?.ok === false) return C.toast(t("vid.actFail"));
      input.value = "";
      C.toast(t("vid.plAdded"));
      onChange?.();
      draw();
    });
    draw();
  }

  window.CineAuraVideos = {
    AGES,
    VISIBILITIES,
    LANGUAGES,
    LANG_ISO,
    PROVIDERS,
    parseVideo,
    embedSrc,
    autoThumb,
    fetchThumb,
    provLabel,
    visLabel,
    ageLabel,
    langLabel,
    regionLabel,
    lockLabel,
    fmtNum,
    fmtCount,
    timeAgo,
    fullDate,
    countdown,
    memberId,
    viewerId,
    geoCountry,
    contentHref,
    searchHref,
    call,
    beacon,
    track,
    thumbHtml,
    cardHtml,
    observeCards,
    openDialog,
    confirmDialog,
    playlistDialog,
    LOCK_ICON,
  };
})();
