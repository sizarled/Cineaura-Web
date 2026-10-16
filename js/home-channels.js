/* Home page > IPTV Channels: "Most watched channels".
 *
 * A row of channel cards that scrolls sideways, like Featured Movies and
 * Featured Series. The order comes from public.channel_top()
 * (sql/channel_views.sql): the live channels members watched most over the last
 * 30 days. A member counts once per channel and day, after 15 seconds of
 * picture in the channel player of Listchannels.html (js/channel-player.js).
 * While few channels have been watched, the first channels of the free and
 * premium packages fill the row, in turn.
 *
 * Every card says what it is, and opens that channel on Listchannels.html:
 *   Free     "Watch Now": the free channels, this one playing at once
 *            (?free=1&channel=<id>). A guest sees the list with Sign In, and
 *            comes back to the channel playing.
 *   Premium  "Premium membership required": the premium channels
 *            (?premium=1&channel=<id>). The list asks for the username and
 *            password of a premium IPTV account, or ("Use an access code") a
 *            watch code, shows the channel waiting meanwhile, and plays it the
 *            moment the list is unlocked; at once on a device that is not asked
 *            (an account kept there, a remembered code, a linked device).
 * <id> is the channel's id in public.listchannels: the list finds the channel
 * of its playlist with that name (js/listchannels.js).
 *
 * The last answer is kept in this browser (cineaura_topch), so a repeat visit
 * paints the row at once. A database that has not run sql/channel_views.sql
 * yet still gets a row: the first channels of the packages, without ranking.
 */
(() => {
  const C = window.CineAura;
  if (!C) return;
  const { t, escapeHtml: esc, supabaseRequest } = C;

  const SAVED_KEY = "cineaura_topch";
  const SAVED_TTL = 7 * 86400000; // an older answer is not painted while the new one loads
  const MAX = 20; // cards in the row

  const svg = (body, size = 14, fill = false) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" ${fill ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"'} aria-hidden="true">${body}</svg>`;
  const ICON = {
    play: svg('<path d="M8 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 8 5.5z"/>', 14, true),
    lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
    crown: svg('<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5L3 8z"/>', 12, true),
    eye: svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', 13),
  };

  const state = {
    items: null, // [{ key, id, name, group, logo, package, free, views }] once known
    source: "", // saved | live | packages | none
  };

  const box = () => document.getElementById("iptv-top");
  const track = () => document.getElementById("iptv-top-track");
  const norm = (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");

  // ---------- the data ----------
  function clean(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = Number(raw.id);
    const name = String(raw.name || "").trim();
    const pack = String(raw.package || "");
    if (!Number.isFinite(id) || !name || !pack) return null;
    return {
      key: String(raw.key || norm(name)),
      id,
      name,
      group: String(raw.group || ""),
      logo: String(raw.logo || ""),
      package: pack,
      free: raw.free === true,
      views: Math.max(0, Number(raw.views) || 0),
    };
  }

  // the cards kept from the last visit (the same for everyone), or null
  function readSaved() {
    try {
      const saved = JSON.parse(localStorage.getItem(SAVED_KEY) || "null");
      if (!saved || !Array.isArray(saved.items) || Date.now() - Number(saved.at || 0) > SAVED_TTL) return null;
      return saved.items.map(clean).filter(Boolean);
    } catch {
      return null;
    }
  }

  function save(items, source) {
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify({ v: 2, at: Date.now(), source, items }));
    } catch {
      /* storage full or blocked */
    }
  }

  // PostgREST in.(): every name in double quotes, \ and " escaped
  const inList = (names) => encodeURIComponent(`(${names.map((n) => `"${n.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")})`);

  // Without sql/channel_views.sql: the first live channels of the free and the
  // premium packages, one card per channel, those with a logo first, in turn.
  async function fromPackages() {
    const res = await supabaseRequest("/rest/v1/iptv?select=name,type");
    if (!res.ok || !Array.isArray(res.data)) return null;
    const all = new Set();
    const free = new Set();
    res.data.forEach((a) => {
      const name = String(a.name || "");
      if (!name) return;
      all.add(name);
      if (C.iptvIsFree(a)) free.add(name);
    });
    const premium = [...all].filter((name) => !free.has(name));
    const load = async (names) => {
      if (!names.length) return [];
      const r = await supabaseRequest(
        `/rest/v1/listchannels?package_name=in.${inList(names)}&channel_type=eq.live&select=id,package_name,channel_name,group_name,logo_url&order=id.asc&limit=150`
      );
      return r.ok && Array.isArray(r.data) ? r.data : [];
    };
    const [freeRows, premRows] = await Promise.all([load([...free]), load(premium)]);
    const seen = new Set();
    const pick = (rows, isFree) =>
      rows
        .map((r, i) => ({ r, i }))
        .sort((a, b) => (b.r.logo_url ? 1 : 0) - (a.r.logo_url ? 1 : 0) || a.i - b.i)
        .map(({ r }) => {
          const key = norm(r.channel_name);
          if (!key || seen.has(key)) return null;
          seen.add(key);
          return clean({ key, id: r.id, name: r.channel_name, group: r.group_name, logo: r.logo_url, package: r.package_name, free: isFree, views: 0 });
        })
        .filter(Boolean);
    const a = pick(freeRows, true);
    const b = pick(premRows, false);
    const items = [];
    for (let i = 0; items.length < MAX && (i < a.length || i < b.length); i += 1) {
      if (a[i]) items.push(a[i]);
      if (b[i] && items.length < MAX) items.push(b[i]);
    }
    return items;
  }

  // { items, source } or null when nothing could be asked (offline, a passing error)
  async function fetchItems() {
    try {
      const res = await C.rpc("channel_top", { p_limit: MAX });
      if (res.ok && Array.isArray(res.data)) return { items: res.data.map(clean).filter(Boolean), source: "live" };
      if (res.status !== 404) return null;
    } catch {
      return null;
    }
    try {
      const items = await fromPackages(); // sql/channel_views.sql not run yet
      return items ? { items, source: "packages" } : null;
    } catch {
      return null;
    }
  }

  // Where a card leads: the channel on the list of its kind. A free channel
  // plays at once (a guest is asked to sign in there and comes back to it); a
  // premium one once the premium list is unlocked with an IPTV account or a
  // watch code (guests too), at once where the list is not asked.
  function hrefOf(item) {
    return `./Listchannels.html?${item.free ? "free" : "premium"}=1&channel=${encodeURIComponent(item.id)}`;
  }

  // ---------- painting ----------
  function initials(name) {
    const words = String(name || "TV").replace(/[^\p{L}\p{N} ]+/gu, " ").trim().split(/\s+/).filter(Boolean);
    return ((words[0]?.[0] || "T") + (words[1]?.[0] || words[0]?.[1] || "V")).toUpperCase();
  }

  function logoHtml(item) {
    const url = String(item.logo || "");
    const img = /^https?:\/\//i.test(url)
      ? `<img src="${esc(url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()" />`
      : "";
    return `<span class="tch-logo">${img}<span class="tch-letters" aria-hidden="true">${esc(initials(item.name))}</span></span>`;
  }

  let numbers = null;
  let numbersLocale = "";
  function compact(n) {
    const locale = (C.getLocale && C.getLocale()) || "en";
    if (!numbers || numbersLocale !== locale) {
      numbersLocale = locale;
      try {
        numbers = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1, numberingSystem: "latn" });
      } catch {
        numbers = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
      }
    }
    return numbers.format(n);
  }

  const typeText = (item) => t(item.free ? "panel.iptv.free" : "dash.iptv.premium");
  const groupText = (group) => (!group || group === "General" ? t("chan.general") : group);

  function cardHtml(item) {
    const icon = item.free ? ICON.play : ICON.lock;
    const cta = t(item.free ? "home.hero.watch" : "home.iptv.top.locked");
    const views = !item.views ? "" : item.views === 1 ? t("home.iptv.top.view1") : t("watch.plays", { n: compact(item.views) });
    const label = [item.name, typeText(item), cta, views].filter(Boolean).join(" · ");
    return `
      <a class="tch-card ${item.free ? "is-free" : "is-prem"}" href="${esc(hrefOf(item))}" aria-label="${esc(label)}">
        <span class="tch-media">
          <span class="tch-live"><i></i>${esc(t("chan.live"))}</span>
          <span class="tch-badge">${item.free ? "" : ICON.crown}${esc(typeText(item))}</span>
          ${logoHtml(item)}
          <span class="tch-play"><span class="play-orb">${icon}</span></span>
        </span>
        <span class="tch-info">
          <strong class="tch-name" dir="auto">${esc(item.name)}</strong>
          <span class="tch-sub"><span dir="auto">${esc(groupText(item.group))}</span>${item.views ? `<span class="tch-views" title="${esc(views)}">${ICON.eye}${esc(compact(item.views))}</span>` : ""}</span>
          <span class="tch-cta"><span>${icon}${esc(cta)}</span></span>
        </span>
      </a>`;
  }

  const skeleton = () =>
    Array.from({ length: 8 }, () => '<span class="tch-card is-skel" aria-hidden="true"><span class="tch-media"></span><span class="tch-info"><i></i><i></i><i></i></span></span>').join("");

  function paint() {
    const root = box();
    const row = track();
    if (!root || !row) return;
    if (!state.items) {
      root.dataset.state = "loading";
      row.innerHTML = skeleton();
      return;
    }
    root.dataset.state = state.items.length ? "ready" : "empty";
    root.dataset.source = state.source;
    row.innerHTML = state.items.map(cardHtml).join("");
    row.removeAttribute("aria-busy");
  }

  // the row is painted again only when the cards changed
  function setItems(items, source) {
    const same = state.items && JSON.stringify(state.items) === JSON.stringify(items);
    state.items = items;
    state.source = source;
    if (!same) paint();
    else if (box()) box().dataset.source = source;
  }

  async function refresh() {
    const got = await fetchItems();
    if (got) {
      save(got.items, got.source);
      setItems(got.items, got.source);
    } else if (!state.items) {
      setItems([], "none"); // no answer and nothing kept: the row stays hidden
    }
  }

  function setup() {
    if (!track()) return;
    const saved = readSaved();
    if (saved) setItems(saved, "saved");
    else paint();
    document.addEventListener("cineaura:prefs", () => {
      if (state.items) paint();
    });
    refresh();
  }

  document.addEventListener("DOMContentLoaded", setup);
})();
