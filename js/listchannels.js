/* Listchannels.html — the channels, movies and series of one IPTV package
 * (?package=<name>), or one of the two lists of the home page:
 *   ?free=1     the free channels: the playlist IPTV-Free.m3u (Supabase Storage),
 *               or, when it can't be read, every free package of Panel > IPTV
 *   ?premium=1  the premium channels: the playlist IPTV-Premuim.m3u, whose links
 *               carry the words Username and Password. They play once replaced
 *               with a premium IPTV account: its username and password typed on
 *               the page, or, behind the button "Use an access code", a watch
 *               code alone (the premium account of the code's owner). A device
 *               linked to a code (Dashboard > Codes > Linked devices) is not
 *               asked again, nor is an account kept with "Remember on this
 *               device". A code is linked to the device only with "Remember the
 *               code" (sql/code_devices.sql, sql/iptv_premium.sql).
 *
 * Filters, kept in the address so a reload or a shared link keeps them:
 *   type    all | live | movie | series     tabs with counts
 *   group   "" (All) or a group name         side list; a menu on phones
 *   status  all | ok | bad                   working / not working
 *   sort    list | az | za                   default order, A to Z, Z to A
 * plus the search box. Every card opens the channel player
 * (js/channel-player.js), whose Previous / Next follow the filtered list.
 *
 * "Check channels" tests every item of the current view through
 * /api/stream-check (server.py), one link at a time per IPTV server: blue dot =
 * the stream answered with video, red = it did not, grey = not checked yet.
 * Results stay in this browser for 12 hours, and playing a channel colours its
 * dot as well. The check pauses while the player is open, because many IPTV
 * accounts allow a single connection at a time.
 *
 * Who may play: free packages play for every signed-in member, a premium
 * package for the member it is assigned to (the same rule as Dashboard > IPTV:
 * owner_id holds the member id, or the username on a row typed by hand), and
 * the staff always. Guests see the list with a sign-in notice that brings them
 * back here. &channel=<id> opens a channel at once, and the browser's Back
 * button closes the player. A guest who opens such a link, or tries a card,
 * comes back from the sign-in page with that channel playing.
 *
 * The cards of Most watched channels on the home page (js/home-channels.js)
 * come with the id of public.listchannels: a free channel opens on ?free=1, a
 * premium one on ?premium=1, where the playlist's channel of the same name is
 * looked up (else the same stream number on the same server, else the name
 * without a country prefix or quality tags such as "AR:" and "HD"). On a locked
 * premium list the gate shows that channel, and it plays the moment the list
 * is unlocked; so does a card tapped while the list is locked.
 *
 * When the package has a programme guide (EPG), every live channel card that
 * comes near the screen shows what is on now, with how far it has got.
 *
 * ?list=IPL…: an IPTV list published by a member (IPTV.html, sql/iptv_lists.sql,
 * js/iptv-lists.js). iptv_list_open says whether the visitor may see it (public:
 * everybody, visitors included; exclusive: members who meet its criteria; private:
 * the members it was given to) and where its playlist is; the page reads the playlist
 * and plays it like the lists above. &channel=<id>&name=<channel> (a result of
 * Search.html > Channels) opens that channel, found by its name when the playlist has
 * changed since. When the publisher opens their own list and its channels changed, the
 * channels kept for the search are saved again.
 */
(() => {
  const C = window.CineAura;
  const { setupChrome, supabaseRequest, restValue, escapeHtml, getSession, t, toast } = C;
  const player = () => window.CineAuraChannels;

  const PAGE = 1000; // Supabase returns at most 1000 rows per request
  const MAX_ROWS = 20000; // the panel imports at most 20 000 channels
  const PANEL_KEY = "cineaura_panel";
  const CHUNK = 240; // cards added to the page at a time
  const TYPES = ["live", "movie", "series"];
  const SORTS = ["list", "az", "za"];
  const STATUSES = ["all", "ok", "bad"];
  const GROUP_SEARCH_FROM = 12; // the group list gets a search box from this many groups

  // check results in localStorage: { v: 1, items: { key: [1 working | 0 not, checked at] } }
  const CHECK_KEY = "cineaura_chancheck";
  const CHECK_TTL = 12 * 60 * 60 * 1000;
  const CHECK_MAX = 20000;
  const CHECK_SERVERS = 3; // IPTV servers checked side by side, each one link at a time
  const CHECK_GAP = 250; // ms between two links of the same server
  const CHECK_CONFIRM = 150; // ask before checking more links than this
  const RESUME_DELAY = 1500; // after the player closes, give the IPTV server time to free the slot

  const params = new URLSearchParams(location.search);
  const pack = (params.get("package") || "").trim();
  // ?free=1: the free channels (IPTV-Free.m3u, else every free package of Panel > IPTV)
  const freeMode = !pack && params.has("free") && params.get("free") !== "0";
  // ?premium=1: the premium channels (IPTV-Premuim.m3u, unlocked with an account or a code)
  const premiumMode = !pack && !freeMode && params.has("premium") && params.get("premium") !== "0";
  // ?list=IPL…: an IPTV list published by a member (sql/iptv_lists.sql)
  const memberList = !pack && !freeMode && !premiumMode && params.has("list");
  const listId = memberList ? (params.get("list") || "").trim().toUpperCase().slice(0, 20) : "";
  const listPage = freeMode || premiumMode || memberList;
  const LISTS = () => window.CineAuraIptvLists;
  const pick = (value, list, fallback) => (list.includes(value) ? value : fallback);

  const state = {
    rows: [],
    packs: [], // free mode: the free packages, in the order of Panel > IPTV
    byKey: new Map(), // check key -> row indexes (one stream can sit in several groups)
    access: "ok", // ok | signin | locked | unlock (premium list waiting for an account)
    wanted: "", // id of the channel to play after signing in (a guest), or once the premium list is unlocked
    m3u: null, // the playlist of a home page list: { key, name, url, epg }
    list: null, // ?list=: the member's list (iptv_list_open)
    refused: null, // ?list=: why the visitor may not see it { reason, owner, … }
    unlock: null, // premium list: { user, pass, via: login | code | device, code, remembered }
    unlockWay: "login", // the premium gate: login (username + password) | code ("Use an access code")
    unlockBusy: false,
    unlockMsg: "",
    unlockOk: false, // the message is good news ("Checking…")
    autoDone: false, // the silent unlock (kept account, remembered code, linked device) has had its go
    arrivalFocus: false,
    query: "",
    groupQuery: "",
    type: pick(params.get("type"), TYPES, "all"),
    group: (params.get("group") || "").trim(),
    status: pick(params.get("status"), STATUSES, "all"),
    sort: pick(params.get("sort"), SORTS, "list"),
    view: [], // row indexes in display order
    shown: 0, // cards of the view already on the page
    sectioned: false, // one section per group (All groups, default order)
    counts: null,
    playing: -1,
    pushed: false,
    leaving: false,
    failed: false,
    loaded: false,
  };

  const ICON = {
    play: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 8 5.5z"/></svg>',
    lock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    search: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
    pulse: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>',
    stop: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    key: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.5" cy="15.5" r="4"/><path d="M10.4 12.6L20 3"/><path d="M16.5 6.5l2.5 2.5"/><path d="M14 9l2 2"/></svg>',
    user: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  };
  const TYPE_LABEL = { all: "chan.f.all", live: "chan.f.live", movie: "chan.f.movie", series: "chan.f.series" };

  const norm = (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  const groupKey = (row) => String(row.group_name || "").trim() || "General";
  const groupLabel = (key) => (key === "General" ? t("chan.general") : key);
  const lang = () => document.documentElement.lang || "en";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // live / movie / series: the type saved at import, else the Xtream path of the link
  function rowType(row) {
    const type = String(row.channel_type || "").toLowerCase();
    if (type === "movie" || type === "series") return type;
    const url = String(row.stream_url || "").toLowerCase();
    if (url.includes("/movie/")) return "movie";
    if (url.includes("/series/")) return "series";
    return "live";
  }

  let collator = null;
  let collatorLang = "";
  function compareNames(a, b) {
    if (!collator || collatorLang !== lang()) {
      collatorLang = lang();
      try {
        collator = new Intl.Collator(collatorLang, { sensitivity: "base", numeric: true, ignorePunctuation: true });
      } catch {
        collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
      }
    }
    return collator.compare(String(a.channel_name || ""), String(b.channel_name || ""));
  }

  function staffSession() {
    try {
      const panel = JSON.parse(sessionStorage.getItem(PANEL_KEY) || localStorage.getItem(PANEL_KEY) || "null");
      return Boolean(panel && panel.token);
    } catch {
      return false;
    }
  }

  // the packages of the page: one, or in free mode every free package
  function packageFilter() {
    if (!freeMode) return `package_name=eq.${restValue(pack)}`;
    const quoted = state.packs.map((name) => `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
    return `package_name=in.(${encodeURIComponent(quoted.join(","))})`;
  }

  async function loadFreePacks() {
    const res = await supabaseRequest("/rest/v1/iptv?type=ilike.free&select=name&order=id.asc");
    if (!res.ok || !Array.isArray(res.data)) throw new Error("free packages could not be loaded");
    const names = [];
    res.data.forEach((a) => {
      const name = String(a.name || "").trim();
      if (name && !names.includes(name)) names.push(name);
    });
    return names;
  }

  async function loadChannels() {
    const rows = [];
    if (freeMode && !state.packs.length) return rows;
    for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
      const res = await supabaseRequest(
        `/rest/v1/listchannels?${packageFilter()}&select=*&order=group_name.asc,id.asc&limit=${PAGE}&offset=${offset}`
      );
      if (!res.ok || !Array.isArray(res.data)) {
        if (!rows.length) throw new Error("channels could not be loaded");
        break;
      }
      rows.push(...res.data);
      if (res.data.length < PAGE) break;
    }
    return rows;
  }

  // The playlist of a home page list (CineAura.IPTV_LISTS): rows shaped like
  // public.listchannels, with a stable id per stream (for &channel= links).
  async function loadPlaylist(list) {
    const text = await C.fetchPlaylistText(list.url);
    if (!/#EXTINF/i.test(text)) throw new Error("not a playlist");
    const rows = C.parseM3U(text).map((r) => ({
      ...r,
      package_name: list.name,
      id: C.m3uRowId(r), // the same id as the channel search of the members' lists
    }));
    return { rows, epg: C.m3uHeaderEpg(text), text };
  }

  // ?list=: may the visitor see it, and where is its playlist (sql/iptv_lists.sql)
  async function loadMemberList() {
    const L = LISTS();
    const res = L
      ? await L.call("iptv_list_open", { p_id: listId, p_member: String(getSession()?.member_id || "") })
      : { ok: false };
    if (!res.ok) throw new Error(res.setup ? "setup" : "open");
    if (!res.data?.ok) {
      state.refused = res.data || { reason: "not_found" };
      return null;
    }
    const l = res.data.list;
    state.list = l;
    const url = L.sourceUrl(l);
    if (!url) throw new Error("no playlist");
    const got = await loadPlaylist({ key: "list", name: l.name, url });
    return { ...got, url, epg: l.epg_url || got.epg };
  }

  // the publisher's own visit: the channels kept for the search follow the playlist
  function followPlaylist(rows, epg) {
    const L = LISTS();
    const l = state.list;
    if (!L || !l?.mine || !rows.length) return;
    if (l.sig && L.signature(rows) === l.sig) return;
    L.refresh(l, { rows, epg }).then((r) => {
      if (r?.ok) l.sig = L.signature(rows);
    }).catch(() => {});
  }

  // The IPTV "account" of a list, for the player's programme guide: the guide of
  // the playlist header, or (premium, once unlocked) the provider's xmltv.php.
  function listAccount() {
    if (!state.m3u) return null;
    const base = { name: state.m3u.name, type: state.m3u.key, epg_url: state.m3u.epg || "" };
    if (state.m3u.key !== "premium") return { ...base, kind: "m3u", m3u_url: state.m3u.url };
    if (!state.unlock) return { ...base, kind: "m3u", m3u_url: "" };
    let server = "";
    try {
      const first = state.rows.find((r) => r._tpl);
      if (first) server = new URL(first._tpl).origin;
    } catch {
      server = "";
    }
    return { ...base, kind: "xtream", xstream_server: server, xstream_user: state.unlock.user, xstream_password: state.unlock.pass };
  }

  async function loadAccess() {
    if (memberList) return "ok"; // iptv_list_open already said this visitor may see the list
    if (premiumMode) return "unlock"; // an account or a code, for guests, members and staff alike
    const session = getSession();
    if (staffSession()) return "ok";
    if (!session?.member_id) return "signin";
    if (freeMode) return "ok"; // free packages play for every signed-in member
    const res = await supabaseRequest(`/rest/v1/iptv?name=eq.${restValue(pack)}&select=id,type,owner_id`);
    const accounts = res.ok && Array.isArray(res.data) ? res.data : [];
    if (!accounts.length) return "ok"; // not registered in Panel > IPTV: nothing to check against
    // free, or a premium account given to this member (by member id or username)
    return accounts.some((a) => C.iptvVisibleTo(a, session)) ? "ok" : "locked";
  }

  // ---------- check results (this browser) ----------
  // cyrb53: a short, stable 53-bit key per package + stream
  function hash(str) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i += 1) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  const rowPack = (row) => (listPage ? String(row?.package_name || "") : pack);
  // the same key on the free list and on the package's own page
  const checkKey = (row) => hash(`${rowPack(row)}\n${String(row.stream_url || "").trim() || `name:${norm(row.channel_name)}`}`);

  function readSaved() {
    const items = new Map();
    try {
      const saved = JSON.parse(localStorage.getItem(CHECK_KEY) || "null");
      const limit = Date.now() - CHECK_TTL;
      if (saved && saved.v === 1 && saved.items && typeof saved.items === "object") {
        Object.entries(saved.items).forEach(([key, v]) => {
          if (Array.isArray(v) && Number(v[1]) > limit) items.set(key, [v[0] ? 1 : 0, Number(v[1])]);
        });
      }
    } catch {
      /* unreadable: start empty */
    }
    return items;
  }

  let store = null;
  const results = () => store || (store = readSaved());

  let saveTimer = 0;
  function saveResults(now = false) {
    clearTimeout(saveTimer);
    const write = () => {
      try {
        // keep what another tab saved meanwhile; the newest result of a link wins
        const merged = readSaved();
        results().forEach((v, key) => {
          const other = merged.get(key);
          if (!other || other[1] < v[1]) merged.set(key, v);
        });
        let items = [...merged];
        if (items.length > CHECK_MAX) items = items.sort((a, b) => b[1][1] - a[1][1]).slice(0, CHECK_MAX);
        localStorage.setItem(CHECK_KEY, JSON.stringify({ v: 1, items: Object.fromEntries(items) }));
      } catch {
        /* storage full or blocked: the dots last for this visit */
      }
    };
    if (now) write();
    else saveTimer = setTimeout(write, 800);
  }

  function statusOf(row) {
    const v = results().get(row._ck);
    if (!v || Date.now() - v[1] >= CHECK_TTL) return { state: "none", at: 0 };
    return { state: v[0] ? "ok" : "bad", at: v[1] };
  }

  function setStatus(row, ok) {
    results().set(row._ck, [ok ? 1 : 0, Date.now()]);
    saveResults();
    paintDot(row._i);
  }

  function ago(at) {
    const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
    try {
      const rtf = new Intl.RelativeTimeFormat(`${lang()}-u-nu-latn`, { numeric: "auto" });
      if (secs < 60) return rtf.format(0, "second");
      const mins = Math.round(secs / 60);
      return mins < 60 ? rtf.format(-mins, "minute") : rtf.format(-Math.round(mins / 60), "hour");
    } catch {
      return "";
    }
  }

  function statusText(st, running) {
    if (running) return t("chan.dot.run");
    if (st.state === "none") return t("chan.dot.none");
    return t(st.state === "ok" ? "chan.dot.ok" : "chan.dot.bad", { when: ago(st.at) });
  }

  const cardLabel = (row, st, running) => `${t("chan.play", { name: row.channel_name })} — ${statusText(st, running)}`;

  // ---------- the view: type, search, group and status, then the order ----------
  function countStatus() {
    const q = norm(state.query);
    const n = { all: 0, ok: 0, bad: 0 };
    state.rows.forEach((r) => {
      if (state.type !== "all" && r._type !== state.type) return;
      if (state.group && r._group !== state.group) return;
      if (q && !r._name.includes(q)) return;
      n.all += 1;
      const st = statusOf(r).state;
      if (st !== "none") n[st] += 1;
    });
    return n;
  }

  function computeView() {
    const rows = state.rows;
    const q = norm(state.query);
    const types = { all: rows.length, live: 0, movie: 0, series: 0 };
    rows.forEach((r) => {
      types[r._type] += 1;
    });
    if (state.type !== "all" && !types[state.type]) state.type = "all"; // e.g. an old link
    const ofType = state.type === "all" ? rows : rows.filter((r) => r._type === state.type);
    const groups = new Map(); // group -> items after search and status (all groups of the type)
    ofType.forEach((r) => {
      if (!groups.has(r._group)) groups.set(r._group, 0);
    });
    if (state.group && !groups.has(state.group)) state.group = "";
    let view = [];
    let allShown = 0;
    ofType.forEach((r) => {
      if (q && !r._name.includes(q)) return;
      if (state.status !== "all" && statusOf(r).state !== state.status) return;
      groups.set(r._group, groups.get(r._group) + 1);
      allShown += 1;
      if (!state.group || r._group === state.group) view.push(r._i);
    });
    state.sectioned = !state.group && state.sort === "list";
    if (state.sectioned) {
      const byGroup = new Map();
      view.forEach((i) => {
        const g = rows[i]._group;
        if (!byGroup.has(g)) byGroup.set(g, []);
        byGroup.get(g).push(i);
      });
      view = [...byGroup.values()].flat();
    } else if (state.sort !== "list") {
      const dir = state.sort === "za" ? -1 : 1;
      view.sort((a, b) => dir * compareNames(rows[a], rows[b]) || a - b);
    }
    const inView = new Map();
    view.forEach((i) => inView.set(rows[i]._group, (inView.get(rows[i]._group) || 0) + 1));
    state.view = view;
    state.counts = { types, groups, allShown, inView, status: countStatus() };
  }

  // ---------- markup ----------
  // The channel waiting for the unlock (&channel= of a Most watched card on the
  // home page, or a card tapped while the list is locked): it plays as soon as
  // the list opens.
  function wantedHtml() {
    const row = state.wanted ? state.rows.find((r) => String(r.id) === state.wanted) : null;
    if (!row) return "";
    return `
            <div class="chl-wanted" id="ul-wanted">
              ${player().logoHtml(row, "ch-logo")}
              <div class="chl-wanted-text"><strong dir="auto">${escapeHtml(row.channel_name)}</strong><small>${escapeHtml(t("iptvp.wantedHint"))}</small></div>
            </div>`;
  }

  // The premium gate: the username and password of a premium IPTV account, or,
  // behind the button "Use an access code", a watch code alone. Both forms stay
  // on the page (one hidden), so switching keeps what was typed.
  function unlockHtml() {
    const busy = state.unlockBusy ? " disabled" : "";
    const signedIn = Boolean(getSession()?.member_id);
    const way = (name, form, other, icon, label) => `
            <div class="chl-way-box" data-way="${name}"${state.unlockWay === name ? "" : " hidden"}>
              ${form}
              <div class="chl-or" aria-hidden="true"><span>${escapeHtml(t("iptvp.or"))}</span></div>
              <button class="btn btn-sm btn-ghost chl-switch" type="button" data-unlock-way="${other}"${busy}>${icon}<span>${escapeHtml(t(label))}</span></button>
            </div>`;
    const login = `
              <form class="chl-way" id="ul-login" novalidate>
                <h3>${escapeHtml(t("iptvp.byAccount"))}</h3>
                <label><span>${escapeHtml(t("iptvp.user"))}</span><input id="ul-user" name="username" autocomplete="username" dir="ltr" spellcheck="false" autocapitalize="off" required${busy} /></label>
                <label><span>${escapeHtml(t("iptvp.pass"))}</span><input id="ul-pass" name="password" type="password" autocomplete="current-password" dir="ltr" required${busy} /></label>
                <label class="check-row"><input type="checkbox" id="ul-keep"${busy} /><span>${escapeHtml(t("iptvp.keep"))}</span></label>
                <button class="btn btn-sm btn-primary" type="submit"${busy}>${escapeHtml(t("iptvp.unlock"))}</button>
              </form>`;
    const code = `
              <form class="chl-way" id="ul-code-form" novalidate>
                <h3>${escapeHtml(t("iptvp.byCode"))}</h3>
                <label><span>${escapeHtml(t("iptvp.code"))}</span><input id="ul-code" name="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" dir="ltr" placeholder="000000" required${busy} /></label>
                <label class="check-row"><input type="checkbox" id="ul-remember"${busy} /><span>${escapeHtml(t("watch.remember"))}</span></label>
                <p class="muted chl-way-hint">${escapeHtml(t("iptvp.rememberHint"))}</p>
                <button class="btn btn-sm btn-primary" type="submit"${busy}>${escapeHtml(t("iptvp.unlock"))}</button>
                <p class="muted chl-unlock-device">${escapeHtml(t("watch.deviceLine", { mac: `\u2066${C.deviceMac()}\u2069` }))}</p>
              </form>`;
    const msgClass = state.unlockMsg ? (state.unlockOk ? " ok" : " error") : "";
    return `
        <div class="chl-note chl-unlock" id="chl-note">
          <div class="chl-unlock-head">
            <span class="chl-unlock-ico" aria-hidden="true">${ICON.lock}</span>
            <div>
              <strong>${escapeHtml(t("iptvp.title"))}</strong>
              <p>${escapeHtml(t("iptvp.lead"))}${signedIn ? ` <a href="./dashboard.html#iptv">${escapeHtml(t("iptvp.whereAccount"))}</a>` : ""}</p>
            </div>
          </div>
          <div class="chl-unlock-body">${wantedHtml()}${way("login", login, "code", ICON.key, "iptvp.useCode")}${way("code", code, "login", ICON.user, "iptvp.useAccount")}
            <p class="gate-msg${msgClass}" id="ul-msg" role="status" aria-live="polite">${escapeHtml(state.unlockMsg)}</p>
          </div>
        </div>`;
  }

  function unlockedHtml() {
    const u = state.unlock;
    if (!u) return "";
    let how = t("iptvp.viaAccount", { user: `\u2066${u.user}\u2069` });
    if (u.via === "code") how = t("iptvp.viaCode", { code: `\u2066••${String(u.code || "").slice(-2)}\u2069` });
    if (u.via === "device") how = t("iptvp.viaDevice");
    return `
        <div class="chl-note ok chl-unlocked" id="chl-note">
          <div><strong>${escapeHtml(t("iptvp.unlocked"))}</strong><p>${escapeHtml(how)}</p></div>
          <button class="btn btn-sm btn-ghost" type="button" data-relock>${escapeHtml(t("iptvp.change"))}</button>
        </div>`;
  }

  function noticeHtml() {
    if (state.access === "unlock") return unlockHtml();
    if (premiumMode && state.unlock) return unlockedHtml();
    if (state.access === "signin") {
      return `
        <div class="chl-note" id="chl-note">
          <div><strong>${escapeHtml(t("chan.signinTitle"))}</strong><p>${escapeHtml(t("chan.signinBack"))}</p></div>
          <a class="btn btn-sm btn-primary" href="${escapeHtml(signinUrl())}" data-signin>${escapeHtml(t("common.signin"))}</a>
        </div>`;
    }
    if (state.access === "locked") {
      return `
        <div class="chl-note warn" id="chl-note">
          <div><strong>${escapeHtml(t("chan.lockedTitle"))}</strong><p>${escapeHtml(t("chan.lockedText"))}</p></div>
          <a class="btn btn-sm btn-primary" href="./#plans">${escapeHtml(t("set.seePlans"))}</a>
        </div>`;
    }
    return "";
  }

  function bodyHtml() {
    return `
      <div class="follow-tabs chl-types" id="chl-types" role="group" aria-label="${escapeHtml(t("chan.f.type"))}"></div>
      <div class="chl-body">
        <aside class="chl-side">
          <label class="chl-gpick">
            <span>${escapeHtml(t("chan.group"))}</span>
            <select id="chl-gsel"></select>
          </label>
          <div class="chl-gpanel">
            <h2 class="chl-side-title">${escapeHtml(t("chan.groups"))}</h2>
            <label class="chl-search chl-gsearch" id="chl-gsearch" hidden>${ICON.search}<input type="search" id="chl-gq" value="${escapeHtml(state.groupQuery)}" placeholder="${escapeHtml(t("chan.groupSearch"))}" aria-label="${escapeHtml(t("chan.groupSearch"))}" autocomplete="off" /></label>
            <div class="chl-glist" id="chl-glist" role="group" aria-label="${escapeHtml(t("chan.groups"))}"></div>
            <p class="muted chl-gnone" id="chl-gnone" hidden>${escapeHtml(t("chan.groupNone"))}</p>
          </div>
        </aside>
        <div class="chl-main" id="chl-main">
          <div class="chl-tools">
            <div class="chl-status" id="chl-status" role="group" aria-label="${escapeHtml(t("chan.st.label"))}"></div>
            <div class="chl-tools-end">
              <label class="chl-sort">
                <span>${escapeHtml(t("chan.sort"))}</span>
                <select id="chl-sort">${SORTS.map((s) => `<option value="${s}"${state.sort === s ? " selected" : ""}>${escapeHtml(t(`chan.sort.${s}`))}</option>`).join("")}</select>
              </label>
              <button class="btn btn-sm btn-primary chl-check" id="chl-check" type="button"></button>
            </div>
          </div>
          <div class="chl-progress" id="chl-progress" hidden></div>
          <div class="chl-groups" id="chl-groups"></div>
          <div class="empty chl-none" id="chl-none" hidden></div>
          <div class="chl-more"><button class="btn btn-sm btn-ghost" id="chl-more" type="button" hidden></button></div>
        </div>
      </div>`;
  }

  const pageTitle = () =>
    memberList ? state.list?.name || t("ipl.listTitle") : freeMode ? t("home.iptv.free") : premiumMode ? t("home.iptv.premium") : pack;

  // ?list=: the publisher, who may see the list, the way back to IPTV.html
  function listMetaHtml() {
    const l = state.list;
    if (!l) return "";
    const L = LISTS();
    const crit = l.visibility === "exclusive" ? L.criteriaParts(l) : [];
    return `
            <p class="ipl-head-meta">
              ${L.badgeHtml(l)}
              <span>${escapeHtml(t("ipl.by"))} <a href="${escapeHtml(C.profileHref(l.owner))}"><bdi>@${escapeHtml(l.owner || "")}</bdi></a></span>
              ${crit.length ? `<span>${crit.map((x) => `<bdi>${escapeHtml(x)}</bdi>`).join(" · ")}</span>` : ""}
              <a class="ipl-back" href="./IPTV.html">${escapeHtml(t("ipl.allLists"))}</a>
              ${l.mine ? `<a class="ipl-back" href="${escapeHtml(L.MANAGE_HREF)}">${escapeHtml(t("ipl.manage"))}</a>` : ""}
            </p>
            ${l.description ? `<p class="ipl-head-desc" dir="auto">${escapeHtml(l.description)}</p>` : ""}`;
  }

  // ?list=: the visitor may not see this list (or it is gone)
  function refusedHtml() {
    const r = state.refused || {};
    const L = LISTS();
    const acts = [];
    if (r.reason === "signin") acts.push(`<a class="btn btn-sm btn-primary" href="${escapeHtml(signinUrl())}" data-signin>${escapeHtml(t("common.signin"))}</a>`);
    if (r.reason === "followers" && r.owner) acts.push(`<a class="btn btn-sm btn-primary" href="${escapeHtml(C.profileHref(r.owner))}">${escapeHtml(t("ipl.seeProfile", { name: `@${r.owner}` }))}</a>`);
    acts.push(`<a class="btn btn-sm btn-ghost" href="./IPTV.html">${escapeHtml(t("ipl.allLists"))}</a>`);
    return `
      <section class="glass dash-main chl-page ipl-gate">
        <span class="ipl-gate-ico" aria-hidden="true">${ICON.lock}</span>
        <p class="eyebrow">${escapeHtml(t("ipl.listTitle"))}</p>
        <h1>${escapeHtml(t(r.reason === "not_found" || !r.reason ? "ipl.no.foundTitle" : "ipl.no.title"))}</h1>
        <p class="muted">${escapeHtml(L ? L.refusalText(r) : t("chan.loadFail"))}</p>
        <div class="ipl-gate-acts">${acts.join("")}</div>
      </section>`;
  }

  function render() {
    const root = document.getElementById("root");
    if (!root) return;
    if (!pack && !listPage) {
      root.innerHTML = `
        <section class="glass dash-main chl-page chl-gate">
          <p class="eyebrow">${escapeHtml(t("dash.liveTv"))}</p>
          <h1>${escapeHtml(t("common.channels"))}</h1>
          <p class="muted">${escapeHtml(t("chan.noPackage"))}</p>
          <a class="btn btn-sm btn-primary" href="./dashboard.html#iptv">${escapeHtml(t("dash.iptvPacks"))}</a>
        </section>`;
      return;
    }
    if (!state.loaded) {
      root.innerHTML = `
        <section class="glass dash-main chl-page">
          <p class="eyebrow">${escapeHtml(t("dash.liveTv"))}</p>
          <h1>${escapeHtml(pageTitle())}</h1>
          <p class="muted chl-loading"><span class="chl-spin" aria-hidden="true"></span>${escapeHtml(t("common.loading"))}</p>
        </section>`;
      return;
    }
    if (memberList && state.refused) {
      root.innerHTML = refusedHtml();
      return;
    }
    const total = state.rows.length;
    const groups = new Set(state.rows.map((r) => r._group)).size;
    let body = `<p class="empty">${escapeHtml(t(freeMode ? "chan.freeNone" : premiumMode ? "iptvp.none" : "chan.empty"))}</p>`;
    if (state.failed) body = `<p class="empty">${escapeHtml(t(premiumMode ? "iptvp.loadFail" : "chan.loadFail"))}</p>`;
    else if (total) body = bodyHtml();
    root.innerHTML = `
      <section class="glass dash-main chl-page">
        <div class="chl-head">
          <div class="chl-title">
            <p class="eyebrow">${escapeHtml(t(memberList ? "ipl.listTitle" : "dash.liveTv"))}</p>
            <h1>${escapeHtml(pageTitle())}</h1>
            ${memberList ? listMetaHtml() : ""}
            ${total ? `<p class="muted">${escapeHtml(t("chan.count", { n: total, g: groups }))}</p>` : ""}
          </div>
          ${
            total > 1
              ? `<label class="chl-search">${ICON.search}<input type="search" id="chl-q" value="${escapeHtml(state.query)}" placeholder="${escapeHtml(t("chan.search"))}" aria-label="${escapeHtml(t("chan.search"))}" autocomplete="off" enterkeyhint="search" /></label>`
              : ""
          }
        </div>
        ${total || !premiumMode ? noticeHtml() : ""}
        ${body}
      </section>`;
    if (!state.failed && total) refresh();
  }

  // Re-painting a box of buttons must not throw the keyboard focus out of it.
  function keepFocus(box, paint) {
    const el = document.activeElement;
    let sel = "";
    if (el && el !== box && box.contains(el)) {
      sel = ["data-type", "data-group", "data-status"]
        .filter((a) => el.hasAttribute(a))
        .map((a) => `[${a}="${CSS.escape(el.getAttribute(a))}"]`)
        .join("");
    }
    paint();
    if (sel) box.querySelector(sel)?.focus({ preventScroll: true });
  }

  function paintTypes() {
    const box = document.getElementById("chl-types");
    if (!box) return;
    const n = state.counts.types;
    keepFocus(box, () => {
      box.innerHTML = ["all", ...TYPES]
        .map((type) => {
          const active = state.type === type;
          return `<button type="button" class="follow-tab${active ? " active" : ""}" data-type="${type}" aria-pressed="${active}"${!n[type] && !active ? " disabled" : ""}>${escapeHtml(t(TYPE_LABEL[type]))}<span class="follow-count">${n[type]}</span></button>`;
        })
        .join("");
    });
  }

  function groupButton(key, label, n) {
    const active = state.group === key;
    return `<button type="button" class="chl-g${active ? " active" : ""}" data-group="${escapeHtml(key)}" aria-pressed="${active}" title="${escapeHtml(label)}"><span>${escapeHtml(label)}</span><span class="follow-count">${n}</span></button>`;
  }

  function paintGroups() {
    const list = document.getElementById("chl-glist");
    const select = document.getElementById("chl-gsel");
    if (!list || !select) return;
    const { groups, allShown } = state.counts;
    const items = [...groups].filter(([key, n]) => n > 0 || key === state.group);
    keepFocus(list, () => {
      list.innerHTML = [groupButton("", t("chan.f.all"), allShown), ...items.map(([key, n]) => groupButton(key, groupLabel(key), n))].join("");
    });
    select.innerHTML = [
      `<option value="">${escapeHtml(`${t("chan.f.all")} (${allShown})`)}</option>`,
      ...items.map(([key, n]) => `<option value="${escapeHtml(key)}">${escapeHtml(`${groupLabel(key)} (${n})`)}</option>`),
    ].join("");
    select.value = state.group;
    const search = document.getElementById("chl-gsearch");
    if (search) {
      search.hidden = items.length < GROUP_SEARCH_FROM;
      if (search.hidden && state.groupQuery) {
        state.groupQuery = "";
        search.querySelector("input").value = "";
      }
    }
    filterGroupList();
    revealActiveGroup(list);
  }

  // Scroll the side list (never the page) so the chosen group is in sight.
  function revealActiveGroup(list) {
    const active = list.querySelector(".chl-g.active");
    if (!active || list.scrollHeight <= list.clientHeight) return;
    const y = active.offsetTop; // .chl-glist is the offset parent (position: relative)
    if (y < list.scrollTop) list.scrollTop = y;
    else if (y + active.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = y + active.offsetHeight - list.clientHeight;
  }

  function filterGroupList() {
    const q = norm(state.groupQuery);
    let shown = 0;
    document.querySelectorAll("#chl-glist .chl-g").forEach((btn) => {
      const key = btn.dataset.group;
      const match = !q || !key || key === state.group || norm(groupLabel(key)).includes(q);
      btn.hidden = !match;
      if (match && key) shown += 1;
    });
    const none = document.getElementById("chl-gnone");
    if (none) none.hidden = !(q && !shown);
  }

  function paintStatus() {
    const box = document.getElementById("chl-status");
    if (!box) return;
    const n = state.counts.status;
    keepFocus(box, () => {
      box.innerHTML = STATUSES.map((s) => {
        const active = state.status === s;
        const dot = s === "all" ? "" : `<i class="ch-dot-key" data-st="${s}" aria-hidden="true"></i>`;
        return `<button type="button" class="chl-chip${active ? " active" : ""}" data-status="${s}" aria-pressed="${active}">${dot}<span>${escapeHtml(t(`chan.st.${s}`))}</span><b>${n[s]}</b></button>`;
      }).join("");
    });
  }

  function cardHtml(i) {
    const ch = state.rows[i];
    const locked = state.access !== "ok";
    const st = statusOf(ch);
    const running = checker.current.has(ch._ck);
    const href = `?${baseQuery()}&channel=${encodeURIComponent(ch.id)}`;
    const sub = [];
    if (!state.sectioned && !state.group) sub.push(groupLabel(ch._group));
    if (state.type === "all" || !sub.length) sub.push(player().typeLabel(ch));
    if (state.packs.length > 1 && ch.package_name) sub.push(ch.package_name); // free list of several packages
    return `
      <a class="ch-card${locked ? " locked" : ""}${i === state.playing ? " is-playing" : ""}" href="${href}" data-ch="${i}"${isLive(ch) ? ' data-live="1"' : ""} data-name="${escapeHtml(ch._name)}" title="${escapeHtml(ch.channel_name)}" aria-label="${escapeHtml(cardLabel(ch, st, running))}">
        <span class="ch-thumb">${player().logoHtml(ch, "ch-logo")}<span class="ch-dot" data-st="${running ? "run" : st.state}" title="${escapeHtml(statusText(st, running))}"></span></span>
        <span class="ch-info"><strong>${escapeHtml(ch.channel_name)}</strong><small>${escapeHtml(sub.join(" · "))}</small>${nowHtml(ch)}</span>
        <span class="ch-play" aria-hidden="true">${locked ? ICON.lock : ICON.play}</span>
      </a>`;
  }

  // ---------- what is on now: the programme guide (EPG) of the package ----------
  // Live channel cards that come near the screen ask the guide what is on now,
  // 60 channels at a time (js/channel-player.js reads it through /api/epg).
  // The free list can mix packages: every package asks its own guide.
  const onNow = { urls: null, none: false, pending: new Set(), timer: 0, tries: 0, watch: null, tick: 0 };
  const isLive = (ch) => !["movie", "series"].includes(String(ch.channel_type || "live").toLowerCase());

  function nowHtml(ch) {
    const cur = ch._epg ? player().epgNow(ch._epg).cur : null;
    if (!cur) return "";
    const share = Math.max(0, Math.min(1, (Date.now() / 1000 - cur[0]) / Math.max(1, cur[1] - cur[0])));
    const when = `${player().clockText(cur[0])}–${player().clockText(cur[1])}`;
    return `<span class="ch-now" title="${escapeHtml(`${t("chan.epg.now")}: ${cur[2]} (${when})`)}"><i style="--p:${Math.round(share * 100)}%"></i><bdi>${escapeHtml(cur[2] || "")}</bdi></span>`;
  }

  function paintNow(i) {
    const row = state.rows[i];
    if (!row) return;
    (state.byKey.get(row._ck) || [i]).forEach((j) => {
      const info = document.querySelector(`#chl-groups .ch-card[data-ch="${j}"] .ch-info`);
      if (!info) return;
      const r = state.rows[j];
      if (r !== row) r._epg = row._epg;
      info.querySelector(".ch-now")?.remove();
      const html = nowHtml(r);
      if (html) info.insertAdjacentHTML("beforeend", html);
    });
  }

  function watchNow() {
    if (onNow.none || state.access !== "ok" || !("IntersectionObserver" in window) || !player()?.epgLookup) return;
    if (!onNow.watch) {
      onNow.watch = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          if (!en.isIntersecting) return;
          onNow.watch.unobserve(en.target);
          const i = Number(en.target.dataset.ch);
          if (Number.isInteger(i) && !state.rows[i]?._epgAt) onNow.pending.add(i);
        });
        askNow();
      }, { rootMargin: "300px 0px" });
      // every minute: move on to the next programme where one has ended
      onNow.tick = setInterval(() => {
        document.querySelectorAll("#chl-groups .ch-card[data-now]").forEach((card) => {
          const i = Number(card.dataset.ch);
          const row = state.rows[i];
          if (!row || !row._epgAt) return;
          const { cur } = player().epgNow(row._epg);
          const shown = card.querySelector(".ch-now bdi")?.textContent || "";
          if ((cur && cur[2] !== shown) || (!cur && shown)) paintNow(i);
          if (row._epg && (!cur || player().epgNow(row._epg).list.length < 2) && Date.now() - row._epgAt > 60000) {
            row._epgAt = 0;
            onNow.pending.add(i);
          }
        });
        askNow();
      }, 60000);
    }
    document.querySelectorAll('#chl-groups .ch-card[data-live="1"]:not([data-now])').forEach((card) => {
      card.dataset.now = "1";
      onNow.watch.observe(card);
    });
  }

  function askNow(delay = 250) {
    if (onNow.timer || !onNow.pending.size) return;
    onNow.timer = setTimeout(fetchNow, delay);
  }

  // package -> guide address ("" = no guide), looked up once per page
  async function guideUrls() {
    if (!onNow.urls) {
      const names = listPage ? state.packs : [pack];
      const account = listAccount();
      const urls = await Promise.all(
        names.map((name) => player().epgSource(name, account && account.name === name ? [account] : undefined).catch(() => ""))
      );
      onNow.urls = new Map(names.map((name, k) => [name, urls[k] || ""]));
    }
    return onNow.urls;
  }

  async function fetchNow() {
    onNow.timer = 0;
    const urls = await guideUrls();
    const guideOf = (i) => urls.get(rowPack(state.rows[i])) || "";
    if (![...urls.values()].some(Boolean)) {
      onNow.none = true;
      onNow.pending.clear();
      onNow.watch?.disconnect();
      return;
    }
    onNow.pending.forEach((i) => {
      if (!guideOf(i)) onNow.pending.delete(i); // a package without a guide
    });
    if (!onNow.pending.size) return;
    // one guide per request: the guide of the first channel waiting
    const url = guideOf(onNow.pending.values().next().value);
    const ids = [...onNow.pending].filter((i) => guideOf(i) === url).slice(0, 60);
    ids.forEach((i) => onNow.pending.delete(i));
    const rows = ids.map((i) => state.rows[i]).filter(Boolean);
    let answer = null;
    try {
      answer = await player().epgLookup(url, rows, 0);
    } catch {
      answer = null;
    }
    if (answer === "loading") {
      // the server is still reading the guide: ask again in a moment
      ids.forEach((i) => onNow.pending.add(i));
      onNow.tries += 1;
      if (onNow.tries < 40) askNow(3000);
      return;
    }
    onNow.tries = 0;
    if (answer) {
      ids.forEach((i) => {
        const row = state.rows[i];
        if (!row) return;
        row._epg = answer.get(player().epgKey(row)) || null;
        row._epgAt = Date.now();
        paintNow(i);
      });
    }
    askNow();
  }

  function paintDot(i) {
    const row = state.rows[i];
    if (!row) return;
    (state.byKey.get(row._ck) || [i]).forEach((j) => {
      const card = document.querySelector(`#chl-groups .ch-card[data-ch="${j}"]`);
      if (!card) return;
      const r = state.rows[j];
      const st = statusOf(r);
      const running = checker.current.has(r._ck);
      const dot = card.querySelector(".ch-dot");
      if (dot) {
        dot.dataset.st = running ? "run" : st.state;
        dot.title = statusText(st, running);
      }
      card.setAttribute("aria-label", cardLabel(r, st, running));
    });
  }

  // ---------- the list, added in chunks while the page scrolls ----------
  let section = null; // { group, grid } of the last section on the page
  let moreWatch = null;

  function addSection(box, group) {
    const el = document.createElement("section");
    el.className = "chl-group";
    let label = state.group ? groupLabel(state.group) : t("chan.allGroups");
    let count = state.view.length;
    if (state.sectioned) {
      label = groupLabel(group);
      count = state.counts.inView.get(group) || 0;
    }
    el.innerHTML = `<h2>${escapeHtml(label)} <span class="follow-count" data-count>${count}</span></h2><div class="chl-grid"></div>`;
    box.appendChild(el);
    return el.querySelector(".chl-grid");
  }

  function renderList() {
    const box = document.getElementById("chl-groups");
    if (!box) return;
    box.innerHTML = "";
    state.shown = 0;
    section = null;
    renderMore();
    paintEmpty();
  }

  function renderMore() {
    const box = document.getElementById("chl-groups");
    if (!box) return;
    const { rows, view } = state;
    const end = Math.min(view.length, state.shown + CHUNK);
    let i = state.shown;
    while (i < end) {
      const group = state.sectioned ? rows[view[i]]._group : "";
      if (!section || section.group !== group) section = { group, grid: addSection(box, group) };
      let html = "";
      while (i < end && (!state.sectioned || rows[view[i]]._group === group)) {
        html += cardHtml(view[i]);
        i += 1;
      }
      section.grid.insertAdjacentHTML("beforeend", html);
    }
    state.shown = end;
    paintMore();
    watchNow();
  }

  function paintMore() {
    const btn = document.getElementById("chl-more");
    if (!btn) return;
    const left = state.view.length - state.shown;
    btn.hidden = left <= 0;
    btn.textContent = t("chan.more", { n: left });
    if (!("IntersectionObserver" in window)) return;
    if (!moreWatch) {
      moreWatch = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting) && state.shown < state.view.length) renderMore();
      }, { rootMargin: "900px 0px" });
    }
    moreWatch.disconnect();
    if (left > 0) moreWatch.observe(btn); // observing again re-checks: the next chunk follows while it is near
  }

  function paintEmpty() {
    const none = document.getElementById("chl-none");
    if (!none) return;
    if (state.view.length) {
      none.hidden = true;
      none.innerHTML = "";
      return;
    }
    const q = state.query.trim();
    let msg = t("chan.none");
    if (q) msg = t("chan.noMatch", { q });
    else if (state.status === "ok") msg = t("chan.noneOk");
    else if (state.status === "bad") msg = t("chan.noneBad");
    const filtered = q || state.type !== "all" || state.group || state.status !== "all";
    none.innerHTML = `<p>${escapeHtml(msg)}</p>${filtered ? `<button type="button" class="btn btn-sm btn-ghost" data-clear>${escapeHtml(t("chan.clear"))}</button>` : ""}`;
    none.hidden = false;
  }

  function refresh(scroll = false) {
    if (!document.getElementById("chl-groups")) return;
    computeView();
    paintTypes();
    paintGroups();
    paintStatus();
    renderList();
    paintCheck();
    syncFilterUrl();
    if (scroll) scrollToList();
  }

  function scrollToList() {
    const main = document.getElementById("chl-main");
    if (!main) return;
    const header = document.getElementById("site-header")?.offsetHeight || 0;
    const top = main.getBoundingClientRect().top;
    if (top < header) window.scrollBy({ top: top - header - 12 });
  }

  function setFilter(change) {
    let changed = false;
    Object.entries(change).forEach(([key, value]) => {
      if (state[key] !== value) {
        state[key] = value;
        changed = true;
      }
    });
    if (changed) refresh(true);
  }

  function clearFilters() {
    Object.assign(state, { query: "", groupQuery: "", type: "all", group: "", status: "all" });
    ["chl-q", "chl-gq"].forEach((id) => {
      const input = document.getElementById(id);
      if (input) input.value = "";
    });
    refresh(true);
  }

  // ---------- "Check channels" ----------
  const checker = {
    running: false,
    stopping: false,
    paused: false,
    run: 0,
    total: 0,
    done: 0,
    ok: 0,
    bad: 0,
    current: new Set(), // check keys of the streams being checked right now
    aborts: new Set(),
    waiters: [],
    resumeTimer: 0,
  };

  let probe = null;
  function checkAvailable() {
    if (!probe) {
      probe = fetch("/api/stream-check?probe=1", { cache: "no-store" })
        .then((r) => r.status === 204)
        .catch(() => false)
        .then((ok) => {
          if (!ok) probe = null; // ask again next time
          return ok;
        });
    }
    return probe;
  }

  function paintCheck() {
    const btn = document.getElementById("chl-check");
    if (btn) {
      btn.classList.toggle("is-running", checker.running);
      btn.setAttribute("aria-pressed", String(checker.running));
      btn.title = t("chan.chk.legend");
      btn.innerHTML = checker.running
        ? `${ICON.stop}<span>${escapeHtml(t("chan.chk.stop"))}</span>`
        : `${ICON.pulse}<span>${escapeHtml(t("chan.chk.start"))}</span>`;
    }
    const bar = document.getElementById("chl-progress");
    if (!bar) return;
    bar.hidden = !checker.running;
    if (!checker.running) return;
    const pct = checker.total ? Math.round((checker.done / checker.total) * 100) : 0;
    const text = checker.paused ? t("chan.chk.paused") : t("chan.chk.progress", { i: Math.min(checker.done + 1, checker.total), n: checker.total });
    bar.innerHTML = `
      <div class="chl-progress-row">
        <span class="chl-spin" aria-hidden="true"></span>
        <span class="chl-progress-text">${escapeHtml(text)}</span>
        <span class="chl-progress-n" aria-label="${escapeHtml(`${t("chan.st.ok")}: ${checker.ok} · ${t("chan.st.bad")}: ${checker.bad}`)}"><i class="ch-dot-key" data-st="ok"></i>${checker.ok}<i class="ch-dot-key" data-st="bad"></i>${checker.bad}</span>
      </div>
      <div class="chl-progress-bar" aria-hidden="true"><i style="width:${pct}%"></i></div>`;
  }

  function canPlay() {
    if (state.access === "ok") return true;
    if (state.access === "unlock") {
      toast(t("iptvp.lockedToast"));
      flashNotice();
      setTimeout(focusUnlock, 350);
      return false;
    }
    toast(t(state.access === "signin" ? "chan.signinPlay" : "chan.lockedTitle"));
    flashNotice();
    return false;
  }

  const hostOf = (row) => {
    try {
      return new URL(String(row.stream_url || "")).host || "?";
    } catch {
      return "?";
    }
  };

  function waitResume() {
    if (!checker.paused || checker.stopping) return Promise.resolve();
    return new Promise((resolve) => checker.waiters.push(resolve));
  }

  function wakeAll() {
    checker.waiters.splice(0).forEach((resolve) => resolve());
  }

  // The player and a check must not share one IPTV connection.
  function pauseCheck(on) {
    clearTimeout(checker.resumeTimer);
    if (!checker.running) {
      checker.paused = false;
      return;
    }
    if (on) {
      checker.paused = true;
      checker.aborts.forEach((ctrl) => ctrl.abort());
    } else {
      checker.resumeTimer = setTimeout(() => {
        checker.paused = false;
        wakeAll();
        paintCheck();
      }, RESUME_DELAY);
    }
    paintCheck();
  }

  function stopCheck() {
    if (!checker.running) return;
    checker.stopping = true;
    clearTimeout(checker.resumeTimer);
    checker.paused = false;
    wakeAll();
    checker.aborts.forEach((ctrl) => ctrl.abort());
    paintCheck();
  }

  // true = working, false = not working, null = no verdict (keep the dot), "again" = paused mid-way.
  // `weight`: the cards of this check that show the same stream (one link, several groups).
  async function checkOne(i, weight = 1) {
    const row = state.rows[i];
    checker.current.add(row._ck);
    paintDot(i);
    const ctrl = new AbortController();
    checker.aborts.add(ctrl);
    const late = setTimeout(() => ctrl.abort(), 25000); // the server gives up after ~12 s itself
    let verdict = null;
    try {
      const url = await player().resolveStream(row);
      if (!url || !/^https?:\/\//i.test(url)) {
        verdict = false; // no link, or a protocol no browser can open (rtmp, udp, …)
      } else {
        const alt = player().xtreamHls(url);
        const res = await fetch(`/api/stream-check?url=${encodeURIComponent(url)}${alt && alt !== url ? `&alt=${encodeURIComponent(alt)}` : ""}`, {
          cache: "no-store",
          signal: ctrl.signal,
        });
        if (res.ok) {
          const data = await res.json();
          verdict = Boolean(data && data.ok);
          if (verdict) player().hintRoute(url, data); // the player starts on the way that answered
        }
      }
    } catch {
      verdict = null;
    }
    clearTimeout(late);
    checker.aborts.delete(ctrl);
    checker.current.delete(row._ck);
    if (ctrl.signal.aborted && checker.paused && !checker.stopping) {
      paintDot(i);
      return "again";
    }
    if (verdict === null) paintDot(i);
    else setStatus(row, verdict);
    if (!checker.stopping) {
      checker.done += weight;
      if (verdict === true) checker.ok += weight;
      if (verdict === false) checker.bad += weight;
    }
    state.counts.status = countStatus();
    paintStatus();
    paintCheck();
    return verdict;
  }

  async function startCheck() {
    if (checker.running) {
      stopCheck();
      return;
    }
    if (!canPlay()) return;
    const items = state.view.slice();
    if (!items.length) {
      toast(t("chan.chk.nothing"));
      return;
    }
    if (items.length > CHECK_CONFIRM && !window.confirm(t("chan.chk.many", { n: items.length }))) return;
    if (!(await checkAvailable())) {
      toast(t("chan.chk.unavailable"));
      return;
    }
    const run = ++checker.run;
    Object.assign(checker, { running: true, stopping: false, paused: player().isOpen(), total: items.length, done: 0, ok: 0, bad: 0 });
    checker.current.clear();
    paintCheck();
    // one check per stream: a channel listed in several groups is one link
    const perKey = new Map();
    items.forEach((i) => {
      const key = state.rows[i]._ck;
      if (perKey.has(key)) perKey.get(key).push(i);
      else perKey.set(key, [i]);
    });
    const links = [...perKey.values()].map((cards) => cards[0]);
    // channels imported without their link: find the links first (one playlist
    // download for the package), so that each one joins the lane of its server
    const unresolved = links.filter((i) => !String(state.rows[i].stream_url || "").trim());
    if (unresolved.length) await Promise.all(unresolved.map((i) => player().resolveStream(state.rows[i]).catch(() => "")));
    // one lane per IPTV server: its links go one at a time, a few servers side by side
    const lanes = new Map();
    links.forEach((i) => {
      const host = hostOf(state.rows[i]);
      if (!lanes.has(host)) lanes.set(host, []);
      lanes.get(host).push(i);
    });
    const queue = [...lanes.values()];
    const worker = async () => {
      for (let lane = queue.shift(); lane && !checker.stopping; lane = queue.shift()) {
        for (let k = 0; k < lane.length && !checker.stopping; k += 1) {
          await waitResume();
          if (checker.stopping) break;
          if ((await checkOne(lane[k], perKey.get(state.rows[lane[k]]._ck).length)) === "again") {
            k -= 1; // the player opened mid-check: the same link once the player closes
            continue;
          }
          if (k < lane.length - 1) await sleep(CHECK_GAP);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CHECK_SERVERS, queue.length) }, worker));
    if (run !== checker.run) return;
    const stopped = checker.stopping;
    Object.assign(checker, { running: false, stopping: false, paused: false });
    checker.current.clear();
    saveResults(true);
    toast(stopped ? t("chan.chk.stopped") : t("chan.chk.done", { ok: checker.ok, bad: checker.bad }));
    if (state.status !== "all") {
      refresh(); // the Working / Not working filter now has new answers
    } else {
      state.counts.status = countStatus();
      paintStatus();
      paintCheck();
    }
  }

  // ---------- player ----------
  function markPlaying(row) {
    state.playing = row && Number.isInteger(row._i) ? row._i : -1;
    document.querySelectorAll("#chl-groups .ch-card.is-playing").forEach((el) => el.classList.remove("is-playing"));
    if (state.playing >= 0) document.querySelector(`#chl-groups .ch-card[data-ch="${state.playing}"]`)?.classList.add("is-playing");
  }

  // ?package=<name>, or ?free=1 for the free list
  function baseQuery() {
    if (memberList) return `list=${encodeURIComponent(listId)}`;
    if (freeMode) return "free=1";
    if (premiumMode) return "premium=1";
    return `package=${encodeURIComponent(pack)}`;
  }

  function pageQuery(row) {
    const p = new URLSearchParams(baseQuery());
    if (state.type !== "all") p.set("type", state.type);
    if (state.group) p.set("group", state.group);
    if (state.status !== "all") p.set("status", state.status);
    if (state.sort !== "list") p.set("sort", state.sort);
    if (row) p.set("channel", String(row.id));
    return String(p);
  }

  const pageUrl = (row) => `${location.pathname}?${pageQuery(row)}`;

  // the sign-in page brings the member back to this list, filters included, and
  // to the channel they wanted playing
  const signinUrl = () => `./login.html?next=${encodeURIComponent(`Listchannels.html?${pageQuery(state.wanted ? { id: state.wanted } : null)}`)}`;

  // A channel asked for while it can't play yet: it is the one that plays after
  // signing in (a guest), or the moment the premium list is unlocked.
  function want(row) {
    if (!row) return;
    if (state.access === "unlock") {
      state.wanted = String(row.id);
      paintWanted();
      syncFilterUrl();
      return;
    }
    if (state.access !== "signin") return;
    state.wanted = String(row.id);
    const link = document.querySelector("#chl-note [data-signin]");
    if (link) link.href = signinUrl();
  }

  function syncFilterUrl() {
    if (!state.loaded || player().isOpen()) return;
    try {
      // a channel waiting for the premium list to be unlocked stays in the address
      history.replaceState(history.state, "", pageUrl(state.access === "unlock" && state.wanted ? { id: state.wanted } : null));
    } catch {
      /* sandboxed frame: the address simply stays */
    }
  }

  function syncUrl(row, push) {
    try {
      if (push && !state.pushed) {
        history.pushState({ chp: 1 }, "", pageUrl(row));
        state.pushed = true;
      } else {
        history.replaceState(state.pushed ? { chp: 1 } : null, "", pageUrl(row));
      }
    } catch {
      /* sandboxed frame: the address simply stays */
    }
  }

  function leaveUrl() {
    try {
      if (state.pushed) {
        state.pushed = false;
        state.leaving = true;
        history.back();
      } else {
        history.replaceState(null, "", pageUrl(null));
      }
    } catch {
      /* sandboxed frame */
    }
  }

  function flashNotice() {
    const note = document.getElementById("chl-note");
    if (!note) return;
    note.scrollIntoView({ behavior: "smooth", block: "center" });
    note.classList.remove("flash");
    void note.offsetWidth;
    note.classList.add("flash");
  }

  function openPlayer(list, index, push) {
    let first = true;
    pauseCheck(true);
    const account = listAccount();
    player().open(list, index, {
      report: true,
      countViews: !memberList, // home page > Most watched channels (CineAura's own lists)
      ...(account ? { accounts: [account] } : {}),
      onResult(row, ok) {
        if (!row || !row._ck) return;
        setStatus(row, ok);
        if (state.counts) {
          state.counts.status = countStatus();
          paintStatus();
        }
      },
      onChange(i) {
        markPlaying(list[i]);
        syncUrl(list[i], push && first);
        first = false;
      },
      onClose() {
        markPlaying(null);
        leaveUrl();
        pauseCheck(false);
      },
    });
  }

  function openCard(card) {
    const i = Number(card.dataset.ch);
    if (!canPlay()) {
      want(state.rows[i]); // a guest: after signing in; a locked premium list: once unlocked
      return;
    }
    const at = state.view.indexOf(i);
    const list = at >= 0 ? state.view : [i];
    openPlayer(list.map((j) => state.rows[j]), Math.max(0, at), true);
  }

  // "http://line.ottcst.net:80/user/pass/1784957" -> "line.ottcst.net live 1784957":
  // the server and the stream number, whatever account the link carries
  function streamKey(url) {
    try {
      const u = new URL(String(url || ""));
      const last = (u.pathname.split("/").filter(Boolean).pop() || "").replace(/\.[a-z0-9]+$/i, "");
      if (!/^\d+$/.test(last)) return "";
      const kind = /\/movie\//i.test(u.pathname) ? "movie" : /\/series\//i.test(u.pathname) ? "series" : "live";
      return `${u.hostname.toLowerCase()} ${kind} ${last}`;
    } catch {
      return "";
    }
  }

  // "AR: beIN Sports 1 HD" -> "bein sports 1": a name without its country
  // prefix, its quality tags, what stands in brackets, and punctuation
  function looseName(name) {
    return norm(name)
      .replace(/^\|?[a-z]{2,3}\s*[|:]\s*/, "")
      .replace(/[([][^)\]]*[)\]]/g, " ")
      .replace(/(^|[^a-z0-9])(?:fhd|uhd|hd|sd|4k|8k|hevc|h\.?26[45]|\d{3,4}p)(?=$|[^a-z0-9])/g, "$1 ")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  }

  // A channel of the database (public.listchannels) on this list: the same
  // name, else the same stream on the same server, else a loosely equal name.
  function sameChannel(row) {
    const name = norm(row.channel_name);
    const key = streamKey(row.stream_url);
    const loose = looseName(row.channel_name);
    return (
      state.rows.find((r) => r._name === name) ||
      (key && state.rows.find((r) => streamKey(r._tpl || r.stream_url) === key)) ||
      (loose && state.rows.find((r) => looseName(r.channel_name) === loose)) ||
      null
    );
  }

  // A card of Most watched channels on the home page (&channel=<id of
  // public.listchannels>) on a list read from its playlist. The free list plays
  // the channel of the database itself when the playlist lacks it; the premium
  // list says so (that link carries another account's login).
  async function openDatabaseChannel(id) {
    if (!/^\d+$/.test(id)) return;
    const res = await supabaseRequest(`/rest/v1/listchannels?id=eq.${restValue(id)}&select=*`).catch(() => null);
    const row = res?.ok && Array.isArray(res.data) ? res.data[0] : null;
    if (!row) return;
    const same = sameChannel(row);
    if (!same && premiumMode) {
      toast(t("iptvp.notInList", { name: row.channel_name }));
      return;
    }
    if (state.access === "unlock") {
      // the gate shows the channel; it plays the moment the list is unlocked
      want(same);
      focusArrival();
      return;
    }
    if (state.access !== "ok") {
      want(same || row);
      canPlay();
      return;
    }
    if (player().isOpen()) return; // something is playing already (a quick tap)
    if (same) {
      const list = state.view.includes(same._i) ? state.view : state.rows.map((r) => r._i);
      openPlayer(list.map((i) => state.rows[i]), list.indexOf(same._i), false);
      return;
    }
    openPlayer([row], 0, false);
  }

  function openFromAddress() {
    let wanted = (params.get("channel") || "").trim();
    const byName = (params.get("name") || "").trim().slice(0, 200);
    if (memberList && (wanted || byName) && !state.rows.some((r) => String(r.id) === wanted)) {
      // a result of Search.html > Channels from before the playlist changed: the same name
      const same = byName ? sameChannel({ channel_name: byName, stream_url: "" }) : null;
      if (!same) {
        if (state.rows.length) toast(t("ipl.channelGone", { name: byName || wanted }));
        return;
      }
      wanted = String(same.id);
    }
    if (!wanted) return;
    if (state.m3u && !memberList && !state.rows.some((r) => String(r.id) === wanted)) {
      openDatabaseChannel(wanted); // a card of Most watched channels on the home page
      return;
    }
    if (state.access === "unlock") {
      // premium: the gate shows the channel, which plays once the list is unlocked
      want(state.rows.find((r) => String(r.id) === wanted));
      focusArrival();
      return;
    }
    if (state.access !== "ok") {
      // a guest (or a member without this package): say why it does not play
      const row = state.rows.find((r) => String(r.id) === wanted);
      if (row) {
        want(row);
        canPlay();
      }
      return;
    }
    let list = state.view;
    let at = list.findIndex((i) => String(state.rows[i].id) === wanted);
    if (at < 0) {
      // hidden by the filters of the link: open it with the whole package
      list = state.rows.map((r) => r._i);
      at = list.findIndex((i) => String(state.rows[i].id) === wanted);
    }
    if (at >= 0) openPlayer(list.map((i) => state.rows[i]), at, false);
  }

  // ---------- premium list: unlock with an account or a watch code ----------
  function unlocked(acc) {
    state.unlock = acc;
    state.unlockMsg = "";
    state.unlockOk = false;
    state.rows.forEach((r) => {
      if (r._tpl) r.stream_url = C.fillCredentials(r._tpl, acc.user, acc.pass);
    });
    state.access = "ok";
    onNow.urls = null;
    onNow.none = false;
    render();
    warmPlayer(document.getElementById("root"));
    if (state.wanted) {
      // the channel picked on the home page, or tapped while the list was locked
      const wanted = state.wanted;
      state.wanted = "";
      const row = state.rows.find((r) => String(r.id) === wanted);
      if (row && !player().isOpen()) {
        const list = state.view.includes(row._i) ? state.view : state.rows.map((r) => r._i);
        openPlayer(list.map((i) => state.rows[i]), list.indexOf(row._i), false);
      }
    }
  }

  // The message under the unlock forms, and the forms on hold while a check runs
  // (no repaint: what was typed stays).
  function setUnlockMsg(text, ok = false) {
    state.unlockMsg = text || "";
    state.unlockOk = Boolean(ok && state.unlockMsg);
    const el = document.getElementById("ul-msg");
    if (!el) return;
    el.textContent = state.unlockMsg;
    el.className = `gate-msg${state.unlockMsg ? (ok ? " ok" : " error") : ""}`;
  }

  function setUnlockBusy(on) {
    state.unlockBusy = on;
    document.querySelectorAll("#chl-note .chl-way-box input, #chl-note .chl-way-box button").forEach((el) => {
      el.disabled = on;
    });
  }

  // the first field of the way on show: the username, or the code
  function focusUnlock() {
    document.getElementById(state.unlockWay === "code" ? "ul-code" : "ul-user")?.focus({ preventScroll: true });
  }

  // "Use an access code" / "Use a username and password": the other form shows,
  // the first one keeps what was typed. A lock-out still applies to both.
  function switchWay(way, focus = true) {
    if (state.unlockBusy) return;
    state.unlockWay = way === "code" ? "code" : "login";
    document.querySelectorAll("#chl-note .chl-way-box").forEach((box) => {
      box.hidden = box.dataset.way !== state.unlockWay;
    });
    setUnlockMsg(lockMessage());
    if (focus) focusUnlock();
  }

  // The gate's line about the channel waiting for the unlock, painted alone (the
  // forms keep what was typed).
  function paintWanted() {
    const body = document.querySelector("#chl-note .chl-unlock-body");
    if (!body) return;
    body.querySelector("#ul-wanted")?.remove();
    const html = wantedHtml();
    if (html) body.insertAdjacentHTML("afterbegin", html);
  }

  // Arriving for a channel on a locked list: once the silent unlock has failed,
  // the first field waits for the account. Not on touch screens, where it would
  // throw the keyboard over the page, nor once the visitor is busy elsewhere.
  function focusArrival() {
    if (!state.autoDone || state.access !== "unlock" || !state.wanted || state.arrivalFocus) return;
    state.arrivalFocus = true;
    if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) return;
    focusUnlock();
  }

  // A remembered code (or this device's code) that no longer opens the list:
  // its message sits with the code form, unless an account is being typed.
  function showCodeWay() {
    const typing = ["ul-user", "ul-pass"].some((id) => document.getElementById(id)?.value);
    if (!typing && state.unlockWay !== "code") switchWay("code", false);
  }

  // Without typing: an account kept on this device, the code remembered here, or
  // the code this device is linked to (Linked devices).
  async function autoUnlock() {
    try {
      const saved = C.storedIptvLogin();
      if (saved) {
        const r = await C.premiumLogin(saved.user, saved.pass);
        if (r.ok) return unlocked({ user: r.user, pass: r.pass, via: "login", remembered: saved.remembered });
        if (r.reason === "bad_login" || r.reason === "expired") {
          C.forgetIptvLogin();
          setUnlockMsg(t(r.reason === "expired" ? "iptvp.expired" : "iptvp.savedGone"));
        }
      }
      const stored = C.getStoredCode();
      const r = await C.premiumUnlock({ code: stored || "", silent: true, remember: Boolean(stored) });
      if (r.ok) return unlocked({ user: r.user, pass: r.pass, via: r.by_device ? "device" : "code", code: r.code, remembered: true });
      if (stored) {
        // the same rule as the watch page: a remembered code that no longer works here is forgotten
        if (["not_found", "expired", "disabled", "banned", "other_device", "unlinked", "invalid"].includes(r.reason)) C.clearStoredCode();
        showCodeWay();
        setUnlockMsg(C.premiumCodeMessage(r, stored, true));
      } else if (r.by_device && r.reason !== "no_device") {
        showCodeWay();
        setUnlockMsg(C.premiumCodeMessage(r, "", true));
      }
      return null;
    } finally {
      state.autoDone = true;
      focusArrival();
    }
  }

  function lockMessage() {
    const left = C.codeLockLeft();
    if (!left) return "";
    const mins = Math.ceil(left / 60000); // whole minutes first: never "23h 60m"
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return t("iptvp.lockedOut", { time: h ? `${h}h ${m}m` : `${m}m` });
  }

  function failed(message) {
    const lock = C.recordFailedCode();
    const left = Math.max(0, C.CODE_FAIL_MAX - lock.fails);
    setUnlockMsg(lock.until > Date.now() ? lockMessage() : `${message} ${t("watch.triesLeft", { n: left })}`);
  }

  async function submitUnlock(kind) {
    if (state.unlockBusy) return;
    const out = lockMessage();
    if (out) {
      setUnlockMsg(out);
      return;
    }
    const user = (document.getElementById("ul-user")?.value || "").trim();
    const pass = document.getElementById("ul-pass")?.value || "";
    const code = (document.getElementById("ul-code")?.value || "").replace(/\D/g, "");
    const keep = Boolean(document.getElementById("ul-keep")?.checked);
    const remember = Boolean(document.getElementById("ul-remember")?.checked);
    if (kind === "login" && (!user || !pass)) {
      setUnlockMsg(t("iptvp.needAccount"));
      document.getElementById(user ? "ul-pass" : "ul-user")?.focus();
      return;
    }
    if (kind === "code" && !/^\d{6}$/.test(code)) {
      setUnlockMsg(t("code.invalid"));
      document.getElementById("ul-code")?.focus();
      return;
    }
    setUnlockMsg(t("iptvp.checking"), true);
    setUnlockBusy(true);
    let r;
    try {
      r = kind === "login" ? await C.premiumLogin(user, pass) : await C.premiumUnlock({ code, remember });
    } finally {
      setUnlockBusy(false);
    }
    if (r.ok) {
      C.clearCodeLock();
      if (kind === "login") {
        C.storeIptvLogin(r.user, r.pass, keep);
        unlocked({ user: r.user, pass: r.pass, via: "login", remembered: keep });
        toast(t(keep ? "iptvp.okKept" : "iptvp.ok"));
      } else {
        if (remember) C.setStoredCode(code);
        unlocked({ user: r.user, pass: r.pass, via: "code", code, remembered: remember });
        // a device that had no code yet has just joined its owner's Linked devices
        const added = r.linked && !(r.freed || []).length;
        toast(remember ? `${t("iptvp.okCode")}${added ? ` ${t("watch.devAdded")}` : ""}` : t("iptvp.ok"));
      }
      return;
    }
    if (kind === "login") {
      if (r.reason === "bad_login") failed(t("iptvp.badLogin"));
      else setUnlockMsg(t(r.reason === "expired" ? "iptvp.expired" : r.reason === "setup" ? "iptvp.setup" : "iptvp.error"));
    } else {
      // like the watch page: a code that exists but cannot serve here is not a wrong guess
      const counts = !["setup", "error", "invalid", "other_device", "device", "no_premium", "owner_banned"].includes(r.reason);
      if (counts) failed(C.premiumCodeMessage(r, code));
      else setUnlockMsg(C.premiumCodeMessage(r, code));
    }
    if (!C.codeLockLeft()) document.getElementById(kind === "login" ? "ul-pass" : "ul-code")?.focus();
  }

  // "Use another account": the list locks again; an account kept here is
  // forgotten. The gate opens on the way that was used.
  function relock() {
    if (state.unlock?.via === "login") C.forgetIptvLogin();
    state.unlockWay = !state.unlock || state.unlock.via === "login" ? "login" : "code";
    state.unlock = null;
    state.access = "unlock";
    state.rows.forEach((r) => {
      if (r._tpl) r.stream_url = r._tpl;
    });
    if (player().isOpen()) player().close();
    render();
    focusUnlock();
  }

  // ---------- boot ----------
  function prepare(rows) {
    state.byKey = new Map();
    rows.forEach((row, i) => {
      row._i = i;
      row._type = rowType(row);
      row._group = groupKey(row);
      row._name = norm(row.channel_name);
      row._ck = checkKey(row);
      const same = state.byKey.get(row._ck);
      if (same) same.push(i);
      else state.byKey.set(row._ck, [i]);
    });
  }

  // The player's engine loads the moment a card is pointed at (or soon after
  // the list appears), so a click starts the channel without that wait.
  function warmPlayer(root) {
    const warm = () => {
      ["pointerover", "touchstart", "focusin"].forEach((type) => root.removeEventListener(type, onIntent, true));
      player().warm();
    };
    const onIntent = (e) => {
      if (e.target.closest && e.target.closest(".ch-card")) warm();
    };
    ["pointerover", "touchstart", "focusin"].forEach((type) => root.addEventListener(type, onIntent, { capture: true, passive: true }));
    if (!navigator.connection?.saveData) {
      if ("requestIdleCallback" in window) requestIdleCallback(warm, { timeout: 4000 });
      else setTimeout(warm, 2500);
    }
  }

  function bind(root) {
    root.addEventListener("click", (e) => {
      const signin = e.target.closest("[data-signin]");
      if (signin) {
        signin.href = signinUrl();
        return;
      }
      if (e.target.closest("[data-relock]")) {
        relock();
        return;
      }
      const way = e.target.closest("[data-unlock-way]");
      if (way) {
        switchWay(way.dataset.unlockWay);
        return;
      }
      const card = e.target.closest(".ch-card");
      if (card) {
        // Ctrl/Cmd/middle click keeps the link: the channel opens in a new tab
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        openCard(card);
        return;
      }
      const type = e.target.closest("button[data-type]");
      if (type) return setFilter({ type: type.dataset.type, group: "" });
      const group = e.target.closest("button[data-group]");
      if (group) return setFilter({ group: group.dataset.group });
      const status = e.target.closest("button[data-status]");
      if (status) return setFilter({ status: status.dataset.status });
      if (e.target.closest("#chl-check")) return startCheck();
      if (e.target.closest("#chl-more")) return renderMore();
      if (e.target.closest("[data-clear]")) return clearFilters();
      return undefined;
    });
    // the premium gate's two forms (painted again with the page)
    root.addEventListener("submit", (e) => {
      const kind = { "ul-login": "login", "ul-code-form": "code" }[e.target.id];
      if (!kind) return;
      e.preventDefault();
      submitUnlock(kind);
    });
    // capture phase: also catches input/change events that do not bubble (set from scripts)
    root.addEventListener(
      "change",
      (e) => {
        if (e.target.id === "chl-sort") setFilter({ sort: pick(e.target.value, SORTS, "list") });
        else if (e.target.id === "chl-gsel") setFilter({ group: e.target.value });
      },
      true
    );
    let timer = 0;
    root.addEventListener(
      "input",
      (e) => {
        if (e.target.id === "chl-q") {
          clearTimeout(timer);
          timer = setTimeout(() => {
            state.query = e.target.value;
            refresh();
          }, 150);
        } else if (e.target.id === "chl-gq") {
          state.groupQuery = e.target.value;
          filterGroupList();
        }
      },
      true
    );
  }

  document.addEventListener("DOMContentLoaded", async () => {
    setupChrome();
    const root = document.getElementById("root");
    render();
    if (!pack && !listPage) return;
    bind(root);
    window.addEventListener("popstate", () => {
      if (state.leaving) {
        state.leaving = false;
        return;
      }
      if (player().isOpen()) {
        state.pushed = false;
        player().close();
      }
    });
    window.addEventListener("pagehide", () => saveResults(true));
    document.addEventListener("cineaura:prefs", () => {
      if (state.loaded) render();
    });
    try {
      let rows = null;
      if (memberList) {
        const got = await loadMemberList();
        rows = got ? got.rows : [];
        if (got) {
          state.m3u = { key: "list", name: state.list.name, url: got.url, epg: got.epg };
          state.packs = [state.list.name];
          followPlaylist(got.rows, got.epg);
        }
      } else if (listPage) {
        const list = premiumMode ? C.IPTV_LISTS.premium : C.IPTV_LISTS.free;
        try {
          const got = await loadPlaylist(list);
          if (got.rows.length || premiumMode) {
            state.m3u = { ...list, epg: got.epg };
            state.packs = [list.name];
            rows = got.rows;
            // premium links wait for an account: Username / Password are filled in on unlock
            if (premiumMode) rows.forEach((r) => {
              if (C.hasCredentialSlots(r.stream_url)) r._tpl = r.stream_url;
            });
          }
        } catch (err) {
          if (premiumMode) throw err;
        }
      }
      if (!rows) {
        // a package page, or the free list when its playlist can't be read: Panel > IPTV
        if (freeMode) state.packs = await loadFreePacks();
        rows = await loadChannels();
      }
      const access = await loadAccess().catch(() => "ok");
      prepare(rows);
      state.rows = rows;
      state.access = access;
    } catch {
      state.failed = true;
    }
    state.loaded = true;
    render();
    if (state.access === "ok" && state.rows.length) warmPlayer(root);
    openFromAddress();
    if (state.access === "unlock" && state.rows.length) autoUnlock();
  });
})();
