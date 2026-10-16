/* Listchannels.html — the channels, movies and series of one IPTV package
 * (?package=<name>), or of every free package together (?free=1: the
 * "Explore" button of the free channels on the home page).
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
 * button closes the player.
 *
 * When the package has a programme guide (EPG), every live channel card that
 * comes near the screen shows what is on now, with how far it has got.
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
  // ?free=1: the channels of every package marked free in Panel > IPTV
  const freeMode = !pack && params.has("free") && params.get("free") !== "0";
  const pick = (value, list, fallback) => (list.includes(value) ? value : fallback);

  const state = {
    rows: [],
    packs: [], // free mode: the free packages, in the order of Panel > IPTV
    byKey: new Map(), // check key -> row indexes (one stream can sit in several groups)
    access: "ok", // ok | signin | locked
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

  async function loadAccess() {
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

  const rowPack = (row) => (freeMode ? String(row?.package_name || "") : pack);
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
  function noticeHtml() {
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

  const pageTitle = () => (freeMode ? t("home.iptv.free") : pack);

  function render() {
    const root = document.getElementById("root");
    if (!root) return;
    if (!pack && !freeMode) {
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
    const total = state.rows.length;
    const groups = new Set(state.rows.map((r) => r._group)).size;
    let body = `<p class="empty">${escapeHtml(t(freeMode ? "chan.freeNone" : "chan.empty"))}</p>`;
    if (state.failed) body = `<p class="empty">${escapeHtml(t("chan.loadFail"))}</p>`;
    else if (total) body = bodyHtml();
    root.innerHTML = `
      <section class="glass dash-main chl-page">
        <div class="chl-head">
          <div class="chl-title">
            <p class="eyebrow">${escapeHtml(t("dash.liveTv"))}</p>
            <h1>${escapeHtml(pageTitle())}</h1>
            ${total ? `<p class="muted">${escapeHtml(t("chan.count", { n: total, g: groups }))}</p>` : ""}
          </div>
          ${
            total > 1
              ? `<label class="chl-search">${ICON.search}<input type="search" id="chl-q" value="${escapeHtml(state.query)}" placeholder="${escapeHtml(t("chan.search"))}" aria-label="${escapeHtml(t("chan.search"))}" autocomplete="off" enterkeyhint="search" /></label>`
              : ""
          }
        </div>
        ${noticeHtml()}
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
      const names = freeMode ? state.packs : [pack];
      const urls = await Promise.all(names.map((name) => player().epgSource(name).catch(() => "")));
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
    return freeMode ? "free=1" : `package=${encodeURIComponent(pack)}`;
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

  // the sign-in page brings the member back to this list, filters included
  const signinUrl = () => `./login.html?next=${encodeURIComponent(`Listchannels.html?${pageQuery(null)}`)}`;

  function syncFilterUrl() {
    if (!state.loaded || player().isOpen()) return;
    try {
      history.replaceState(history.state, "", pageUrl(null));
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
    player().open(list, index, {
      report: true,
      countViews: true, // home page > Most watched channels
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
    if (!canPlay()) return;
    const i = Number(card.dataset.ch);
    const at = state.view.indexOf(i);
    const list = at >= 0 ? state.view : [i];
    openPlayer(list.map((j) => state.rows[j]), Math.max(0, at), true);
  }

  function openFromAddress() {
    const wanted = (params.get("channel") || "").trim();
    if (!wanted || state.access !== "ok") return;
    let list = state.view;
    let at = list.findIndex((i) => String(state.rows[i].id) === wanted);
    if (at < 0) {
      // hidden by the filters of the link: open it with the whole package
      list = state.rows.map((r) => r._i);
      at = list.findIndex((i) => String(state.rows[i].id) === wanted);
    }
    if (at >= 0) openPlayer(list.map((i) => state.rows[i]), at, false);
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
    if (!pack && !freeMode) return;
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
      if (freeMode) state.packs = await loadFreePacks();
      const [rows, access] = await Promise.all([loadChannels(), loadAccess().catch(() => "ok")]);
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
  });
})();
