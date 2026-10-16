/* Home page > IPTV Channels: "Most watched channels".
 *
 * A row of channel cards that scrolls sideways, like Featured Movies and
 * Featured Series. The order comes from public.channel_top()
 * (sql/channel_views.sql): the live channels members watched most over the last
 * 30 days. A member counts once per channel and day, after 15 seconds of
 * picture (js/channel-player.js, on the channel lists and here). While few
 * channels have been watched, the first channels of the free and premium
 * packages fill the row, in turn.
 *
 * Every card says what it is:
 *   Free     "Watch Now". A signed-in member watches it at once, right here:
 *            the channel player opens over the page, and Previous / Next go
 *            through the channels of the row this member can play. A guest is
 *            asked to sign in, and comes back to the channel playing.
 *   Premium  "Premium membership required". It plays at once for a member who
 *            has one of its premium packages (given in Panel > IPTV) and for
 *            the staff; anyone else is told that it needs a premium membership,
 *            with the plans (and Sign In for a guest).
 *
 * The last answer is kept in this browser (cineaura_topch), so a repeat visit
 * paints the row at once. A database that has not run sql/channel_views.sql
 * yet still gets a row: the first channels of the packages, without ranking.
 */
(() => {
  const C = window.CineAura;
  if (!C) return;
  const { t, escapeHtml: esc, getSession, supabaseRequest } = C;

  const SAVED_KEY = "cineaura_topch";
  const SAVED_TTL = 7 * 86400000; // an older answer is not painted while the new one loads
  const MAX = 20; // cards in the row
  const PANEL_KEY = "cineaura_panel";
  const PLAYER_CSS = "css/channels.css";
  const PLAYER_JS = "js/channel-player.js";
  const ROWS_TTL = 60000; // channel rows fetched when a card is pointed at stay good this long

  const svg = (body, size = 14, fill = false) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" ${fill ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"'} aria-hidden="true">${body}</svg>`;
  const ICON = {
    play: svg('<path d="M8 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 8 5.5z"/>', 14, true),
    lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
    crown: svg('<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5L3 8z"/>', 12, true),
    eye: svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', 13),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>', 18),
  };

  const state = {
    items: null, // [{ key, id, name, group, logo, package, free, packs, views }] once known
    source: "", // saved | live | packages | none
    mine: null, // Set of the packages this member may open, once known
    playing: "", // key of the channel in the player
    rows: null, // { at, ids, promise } channel rows for the player
    pushed: false, // a history entry stands for the open player
    leaving: false,
  };

  const box = () => document.getElementById("iptv-top");
  const track = () => document.getElementById("iptv-top-track");
  const norm = (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");

  function staff() {
    try {
      const panel = JSON.parse(sessionStorage.getItem(PANEL_KEY) || localStorage.getItem(PANEL_KEY) || "null");
      return Boolean(panel && panel.token);
    } catch {
      return false;
    }
  }

  // ---------- the data ----------
  function clean(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = Number(raw.id);
    const name = String(raw.name || "").trim();
    const pack = String(raw.package || "");
    if (!Number.isFinite(id) || !name || !pack) return null;
    const packs = (Array.isArray(raw.packs) ? raw.packs : [])
      .filter((p) => Array.isArray(p) && Number.isFinite(Number(p[0])) && p[1])
      .map((p) => [Number(p[0]), String(p[1])]);
    return {
      key: String(raw.key || norm(name)),
      id,
      name,
      group: String(raw.group || ""),
      logo: String(raw.logo || ""),
      package: pack,
      free: raw.free === true,
      packs,
      views: Math.max(0, Number(raw.views) || 0),
    };
  }

  // { items, mine } kept from the last visit; mine only for the same member
  function readSaved() {
    try {
      const saved = JSON.parse(localStorage.getItem(SAVED_KEY) || "null");
      if (!saved || !Array.isArray(saved.items) || Date.now() - Number(saved.at || 0) > SAVED_TTL) return null;
      const me = getSession()?.member_id;
      const mine = me && saved.member === me && Array.isArray(saved.mine) ? new Set(saved.mine.map(String)) : null;
      return { items: saved.items.map(clean).filter(Boolean), mine };
    } catch {
      return null;
    }
  }

  function save(items, source) {
    const me = getSession()?.member_id;
    try {
      localStorage.setItem(
        SAVED_KEY,
        JSON.stringify({ v: 1, at: Date.now(), source, items, member: me && state.mine ? me : "", mine: me && state.mine ? [...state.mine] : [] })
      );
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
          return clean({ key, id: r.id, name: r.channel_name, group: r.group_name, logo: r.logo_url, package: r.package_name, free: isFree, packs: isFree ? [] : [[r.id, r.package_name]], views: 0 });
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

  // the packages this member may open: the free ones and their own premium ones
  // (null when the database could not be asked: what is known stays)
  async function loadMine() {
    const session = getSession();
    if (!session?.member_id) return new Set();
    try {
      const res = await supabaseRequest(`/rest/v1/iptv?${C.iptvVisibleFilter(session)}&select=name,type,owner_id`);
      if (!res.ok || !Array.isArray(res.data)) return null;
      return new Set(res.data.filter((a) => C.iptvVisibleTo(a, session)).map((a) => String(a.name || "")));
    } catch {
      return null;
    }
  }

  // The row of public.listchannels this viewer plays for a card, or null.
  function target(item) {
    if (!item) return null;
    if (staff()) return { id: item.id, pack: item.package };
    if (!getSession()?.member_id) return null;
    const mine = (pack) => Boolean(state.mine && state.mine.has(pack));
    if (item.free || mine(item.package)) return { id: item.id, pack: item.package };
    const hit = item.packs.find((p) => mine(p[1]));
    return hit ? { id: hit[0], pack: hit[1] } : null;
  }

  // The channel list opens the same channel (a new tab, or without scripts).
  function hrefOf(item, tg) {
    const id = tg ? tg.id : item.id;
    const pack = tg ? tg.pack : item.package;
    return item.free ? `./Listchannels.html?free=1&channel=${id}` : `./Listchannels.html?package=${encodeURIComponent(pack)}&channel=${id}`;
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

  function cardHtml(item, i) {
    const tg = target(item);
    const locked = !item.free && !tg;
    const cta = t(locked ? "home.iptv.top.locked" : "home.hero.watch");
    const views = !item.views ? "" : item.views === 1 ? t("home.iptv.top.view1") : t("watch.plays", { n: compact(item.views) });
    const label = [item.name, typeText(item), cta, views].filter(Boolean).join(" · ");
    const cls = `tch-card ${item.free ? "is-free" : "is-prem"}${locked ? " is-locked" : ""}${state.playing === item.key ? " is-playing" : ""}`;
    return `
      <a class="${cls}" href="${esc(hrefOf(item, tg))}" data-tch="${i}" aria-label="${esc(label)}">
        <span class="tch-media">
          <span class="tch-live"><i></i>${esc(t("chan.live"))}</span>
          <span class="tch-badge">${item.free ? "" : ICON.crown}${esc(typeText(item))}</span>
          ${logoHtml(item)}
          <span class="tch-play"><span class="play-orb">${locked ? ICON.lock : ICON.play}</span></span>
        </span>
        <span class="tch-info">
          <strong class="tch-name" dir="auto">${esc(item.name)}</strong>
          <span class="tch-sub"><span dir="auto">${esc(groupText(item.group))}</span>${item.views ? `<span class="tch-views" title="${esc(views)}">${ICON.eye}${esc(compact(item.views))}</span>` : ""}</span>
          <span class="tch-cta"><span>${locked ? ICON.lock : ICON.play}${esc(cta)}</span></span>
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

  // true when the row was painted again
  function setItems(items, source) {
    const same = state.items && JSON.stringify(state.items) === JSON.stringify(items);
    state.items = items;
    state.source = source;
    state.rows = null;
    if (same) {
      const root = box();
      if (root) root.dataset.source = source;
      return false;
    }
    paint();
    return true;
  }

  function markPlaying(key) {
    state.playing = key || "";
    track()?.querySelectorAll(".tch-card.is-playing").forEach((el) => el.classList.remove("is-playing"));
    if (!state.playing || !state.items) return;
    const i = state.items.findIndex((it) => it.key === state.playing);
    track()?.querySelector(`.tch-card[data-tch="${i}"]`)?.classList.add("is-playing");
  }

  // ---------- the player ----------
  let playerLoad = null;
  function loadPlayer() {
    if (window.CineAuraChannels) return Promise.resolve();
    if (!playerLoad) {
      const css = new Promise((resolve) => {
        if (document.querySelector(`link[href="${PLAYER_CSS}"]`)) return resolve();
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = PLAYER_CSS;
        link.onload = resolve;
        link.onerror = resolve; // the player still works without its styles
        document.head.appendChild(link);
        return undefined;
      });
      const js = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = PLAYER_JS;
        s.onload = resolve;
        s.onerror = reject;
        document.body.appendChild(s);
      });
      playerLoad = Promise.all([css, js]).catch((err) => {
        playerLoad = null;
        throw err;
      });
    }
    return playerLoad;
  }

  // every channel of the row this viewer can play, in the order of the row
  function playable() {
    return (state.items || []).map((item) => ({ item, tg: target(item) })).filter((x) => x.tg);
  }

  function loadRows() {
    const ids = playable().map((x) => x.tg.id);
    const key = ids.join(",");
    if (state.rows && state.rows.ids === key && Date.now() - state.rows.at < ROWS_TTL) return state.rows.promise;
    const promise = ids.length
      ? supabaseRequest(`/rest/v1/listchannels?id=in.(${ids.join(",")})&select=*`).then((res) => {
          if (!res.ok || !Array.isArray(res.data)) throw new Error("channels could not be loaded");
          return res.data;
        })
      : Promise.resolve([]);
    state.rows = { at: Date.now(), ids: key, promise };
    promise.catch(() => {
      if (state.rows && state.rows.promise === promise) state.rows = null;
    });
    return promise;
  }

  // A card about to be clicked: load the player and the channels meanwhile.
  function warm(card) {
    if (!card || card.classList.contains("is-skel")) return;
    const item = state.items?.[Number(card.dataset.tch)];
    if (!target(item)) return;
    loadPlayer()
      .then(() => window.CineAuraChannels?.warm())
      .catch(() => {});
    loadRows().catch(() => {});
  }

  async function play(card, item) {
    if (card.classList.contains("is-busy")) return;
    card.classList.add("is-busy");
    try {
      const [rows] = await Promise.all([loadRows(), loadPlayer()]);
      const byId = new Map(rows.map((r) => [String(r.id), r]));
      const list = [];
      let at = -1;
      playable().forEach((x) => {
        const row = byId.get(String(x.tg.id));
        if (!row) return;
        if (x.item === item) at = list.length;
        list.push({ row, key: x.item.key });
      });
      if (at < 0) {
        C.toast(t("home.iptv.top.gone"));
        refresh();
        return;
      }
      openPlayer(list, at);
    } catch {
      C.toast(t("home.iptv.top.fail"));
    } finally {
      card.classList.remove("is-busy");
    }
  }

  function openPlayer(list, at) {
    window.CineAuraChannels.open(
      list.map((x) => x.row),
      at,
      {
        report: true,
        countViews: true,
        onChange(i) {
          markPlaying(list[i]?.key);
        },
        onClose() {
          markPlaying("");
          leaveHistory();
        },
      }
    );
    // the Back button (or gesture) closes the player instead of leaving the page
    try {
      history.pushState({ tch: 1 }, "", location.href);
      state.pushed = true;
    } catch {
      state.pushed = false;
    }
  }

  function leaveHistory() {
    if (!state.pushed) return;
    state.pushed = false;
    state.leaving = true;
    try {
      history.back();
    } catch {
      state.leaving = false;
    }
  }

  window.addEventListener("popstate", () => {
    if (state.leaving) {
      state.leaving = false;
      return;
    }
    if (state.pushed && window.CineAuraChannels?.isOpen()) {
      state.pushed = false;
      window.CineAuraChannels.close();
    }
  });

  // ---------- who may not play: sign in, or the plans ----------
  let gateEl = null;
  let gateFrom = null;

  function closeGate() {
    if (!gateEl) return;
    gateEl.remove();
    gateEl = null;
    document.removeEventListener("keydown", onGateKey, true);
    if (gateFrom && document.contains(gateFrom)) gateFrom.focus({ preventScroll: true });
    gateFrom = null;
  }

  function onGateKey(e) {
    if (!gateEl) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeGate();
      return;
    }
    if (e.key !== "Tab") return;
    const items = [...gateEl.querySelectorAll("a[href], button")];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !gateEl.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function gate(card, item) {
    closeGate();
    const guest = !getSession()?.member_id;
    const signin = (next) => `./login.html?next=${encodeURIComponent(next)}`;
    let actions;
    if (item.free) {
      // after signing in, the channel list opens with this channel playing
      actions = `
        <a class="btn btn-sm btn-primary" href="${esc(signin(`Listchannels.html?free=1&channel=${item.id}`))}">${esc(t("nav.signin"))}</a>
        <a class="btn btn-sm btn-ghost" href="./register.html">${esc(t("nav.signup"))}</a>`;
    } else if (guest) {
      actions = `
        <a class="btn btn-sm btn-primary" href="${esc(signin("dashboard.html#iptv"))}">${esc(t("nav.signin"))}</a>
        <a class="btn btn-sm btn-ghost" href="#plans" data-gate-close>${esc(t("set.seePlans"))}</a>`;
    } else {
      actions = `
        <a class="btn btn-sm btn-primary" href="#plans" data-gate-close>${esc(t("set.seePlans"))}</a>
        <a class="btn btn-sm btn-ghost" href="./dashboard.html#iptv">${esc(t("dash.iptvPacks"))}</a>`;
    }
    const wrap = document.createElement("div");
    wrap.className = "tch-gate-back";
    wrap.innerHTML = `
      <section class="tch-gate ${item.free ? "is-free" : "is-prem"}" role="dialog" aria-modal="true" aria-labelledby="tch-gate-h" aria-describedby="tch-gate-p" tabindex="-1">
        <button class="tch-gate-x" type="button" data-gate-close aria-label="${esc(t("common.close"))}">${ICON.close}</button>
        <div class="tch-gate-head">
          ${logoHtml(item)}
          <div>
            <h3 id="tch-gate-h" dir="auto">${esc(item.name)}</h3>
            <span class="tch-badge">${item.free ? "" : ICON.crown}${esc(typeText(item))}</span>
          </div>
        </div>
        <p id="tch-gate-p">${esc(t(item.free ? "home.iptv.top.freeGate" : "home.iptv.top.premGate"))}</p>
        <div class="tch-gate-actions">${actions}</div>
      </section>`;
    wrap.addEventListener("click", (e) => {
      const close = e.target.closest("[data-gate-close]");
      if (e.target !== wrap && !close) return;
      if (close && close.matches('a[href^="#"]')) gateFrom = null; // "See plans" moves on to the plans
      closeGate();
    });
    document.body.appendChild(wrap);
    gateEl = wrap;
    gateFrom = card;
    document.addEventListener("keydown", onGateKey, true);
    wrap.querySelector(".tch-gate").focus({ preventScroll: true });
  }

  // ---------- events ----------
  function onClick(e) {
    const card = e.target.closest(".tch-card[data-tch]");
    if (!card) return;
    // Ctrl/Cmd/Shift/middle click keeps the link: the channel list in a new tab
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    const item = state.items?.[Number(card.dataset.tch)];
    if (!item) return;
    if (target(item)) play(card, item);
    else gate(card, item);
  }

  async function refresh() {
    // a member: which premium packages are theirs (those cards play at once)
    const member = Boolean(getSession()?.member_id) && !staff();
    const [got, mine] = await Promise.all([fetchItems(), member ? loadMine() : null]);
    const mineChanged = mine && JSON.stringify([...mine].sort()) !== JSON.stringify(state.mine ? [...state.mine].sort() : null);
    if (mine) state.mine = mine;
    let painted = false;
    if (got) {
      save(got.items, got.source);
      painted = setItems(got.items, got.source);
    } else if (!state.items) {
      painted = setItems([], "none"); // no answer and nothing kept: the row stays hidden
    }
    if (mineChanged && !painted && state.items?.length) paint();
  }

  function setup() {
    const row = track();
    if (!row) return;
    const saved = readSaved();
    if (saved) {
      state.mine = saved.mine;
      setItems(saved.items, "saved");
    } else {
      paint();
    }
    row.addEventListener("click", onClick);
    const onIntent = (e) => warm(e.target.closest && e.target.closest(".tch-card"));
    ["pointerover", "focusin", "touchstart"].forEach((type) => row.addEventListener(type, onIntent, { passive: true }));
    document.addEventListener("cineaura:prefs", () => {
      if (state.items) paint();
    });
    refresh();
  }

  document.addEventListener("DOMContentLoaded", setup);
})();
