/* notifications.html — every notification of the signed-in member, newest first.
 *
 * The list is divided into Today, This week, This month and This year, then one
 * section per older year. The tabs above it show one period at a time with the
 * number of notifications in each; the period is kept in the address
 * (?period=today | week | month | year | older), so a reload or a shared link
 * keeps it.
 *
 * The periods never overlap, so the tab numbers add up to "All": This week is
 * the days of this week before today, This month the days of this month before
 * this week, This year the rest of the year before this month. Each section
 * heading shows the dates it covers. The week starts on the first day of the
 * week of the member's country (Monday when the country is unknown), and every
 * date is local time.
 *
 * The header bell's "View all" opens this page. Like the bell, the page marks
 * the notifications it shows as read; they keep their "new" look until the page
 * is opened again. New notifications slide in at the top as soon as the bell
 * finds them (it checks every 30 seconds).
 */
(() => {
  const C = window.CineAura;
  const { setupChrome, supabaseRequest, restValue, escapeHtml, getSession, t, toast } = C;

  const PAGE = 40; // notifications per request
  const PERIODS = ["today", "week", "month", "year", "older"];
  const TABS = ["all", ...PERIODS];
  const LABEL = {
    all: "notes.all",
    today: "notes.today",
    week: "notes.week",
    month: "notes.month",
    year: "notes.year",
    older: "notes.older",
  };
  const SESSION_KEY = C.SESSION_KEY || "cineaura_session";

  const svg = (body) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const BELL = '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>';
  const ICON = {
    message: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
    follow: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>'),
    up: svg('<path d="M12 19V5M5 12l7-7 7 7"/>'),
    down: svg('<path d="M12 5v14M19 12l-7 7-7-7"/>'),
    post: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>'),
    recommend: svg('<path d="M12 3l2.7 5.5 6.1.9-4.4 4.3 1 6.1L12 16.9l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>'),
    prize: svg('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 6h3v1a3 3 0 0 1-3 3M7 6H4v1a3 3 0 0 0 3 3"/>'),
    iptv: svg('<rect x="2.5" y="6" width="19" height="13" rx="2.5"/><path d="M8 2.5l4 3.5 4-3.5"/>'),
    info: svg(BELL),
  };

  const params = new URLSearchParams(location.search);
  const state = {
    me: "",
    period: TABS.includes(params.get("period")) ? params.get("period") : "all",
    bounds: null,
    rows: [], // notifications of the period, newest first
    byId: new Map(),
    fetched: 0, // rows received page by page: the offset of the next page
    done: false, // every notification of the period is here
    loading: false,
    failed: false, // the first page could not be loaded
    stall: false, // a later page failed: no more loading on scroll until a click
    counts: null, // { all, today, week, month, year, older } or null while unknown
    fresh: new Set(), // ids that were unread when this visit showed them
    gen: 0, // grows on every reload: answers to older requests are dropped
    countGen: 0,
    bellSig: null,
  };

  // ---------- periods ----------
  // First day of the week, 1 = Monday … 7 = Sunday, from the member's country.
  function weekStart() {
    const cc = String(C.currentCountry?.() || "").toUpperCase();
    if (/^[A-Z]{2}$/.test(cc)) {
      try {
        const loc = new Intl.Locale(`und-${cc}`);
        const info = typeof loc.getWeekInfo === "function" ? loc.getWeekInfo() : loc.weekInfo;
        const day = Number(info?.firstDay);
        if (day >= 1 && day <= 7) return day;
      } catch {
        /* no week data in this browser */
      }
    }
    return 1;
  }

  // Where each period starts (local midnight, in ms). The boundaries only ever
  // move back in time: a week that began last month leaves This month empty.
  function computeBounds(now = new Date()) {
    const y = now.getFullYear();
    const m = now.getMonth();
    const d = now.getDate();
    const today = new Date(y, m, d).getTime();
    const back = (new Date(y, m, d).getDay() - (weekStart() % 7) + 7) % 7;
    const week = Math.min(new Date(y, m, d - back).getTime(), today);
    const month = Math.min(new Date(y, m, 1).getTime(), week);
    const year = Math.min(new Date(y, 0, 1).getTime(), month);
    return { today, week, month, year };
  }

  const sameBounds = (a, b) =>
    Boolean(a && b) && a.today === b.today && a.week === b.week && a.month === b.month && a.year === b.year;

  // [from, to) of a period in ms; null = open end
  function rangeOf(period, b = state.bounds) {
    if (period === "today") return [b.today, null];
    if (period === "week") return [b.week, b.today];
    if (period === "month") return [b.month, b.week];
    if (period === "year") return [b.year, b.month];
    if (period === "older") return [null, b.year];
    return [null, null];
  }

  const isEmpty = ([from, to]) => from != null && to != null && from >= to;

  function rangeQuery([from, to]) {
    let q = "";
    if (from != null) q += `&created_at=gte.${encodeURIComponent(new Date(from).toISOString())}`;
    if (to != null) q += `&created_at=lt.${encodeURIComponent(new Date(to).toISOString())}`;
    return q;
  }

  const stamp = (n) => Date.parse(n?.created_at) || 0;

  function periodOf(ms, b = state.bounds) {
    if (ms >= b.today) return "today";
    if (ms >= b.week) return "week";
    if (ms >= b.month) return "month";
    if (ms >= b.year) return "year";
    return "older";
  }

  // older notifications get one section per year: "y2025", "y2024", …
  const YEAR_KEY = /^y(\d{4,})$/;
  function sectionOf(n) {
    const ms = stamp(n);
    const period = periodOf(ms);
    return period === "older" ? `y${new Date(ms).getFullYear()}` : period;
  }

  function dateFormat(options) {
    try {
      return new Intl.DateTimeFormat(C.getLocale(), { ...options, numberingSystem: "latn" });
    } catch {
      return new Intl.DateTimeFormat(undefined, options);
    }
  }

  // The days a section covers: "Wednesday, October 15", "October 13 – 14", …
  function rangeText(period) {
    const [from, to] = rangeOf(period);
    try {
      if (period === "today") return dateFormat({ weekday: "long", day: "numeric", month: "long" }).format(new Date(from));
      if (from == null || to == null || from >= to) return "";
      const start = new Date(from);
      const end = new Date(to - 1);
      const fmt = dateFormat({
        day: "numeric",
        month: "long",
        ...(start.getFullYear() !== end.getFullYear() ? { year: "numeric" } : {}),
      });
      return typeof fmt.formatRange === "function" ? fmt.formatRange(start, end) : `${fmt.format(start)} – ${fmt.format(end)}`;
    } catch {
      return "";
    }
  }

  // ---------- data ----------
  const basePath = () => `/rest/v1/notifications?member_id=eq.${restValue(state.me)}`;
  const listPath = (offset) =>
    `${basePath()}${rangeQuery(rangeOf(state.period))}&select=*&order=created_at.desc,id.desc&limit=${PAGE}&offset=${offset}`;
  const byNewest = (a, b) => stamp(b) - stamp(a) || Number(b.id) - Number(a.id);

  // Adds rows (or refreshes the ones already here) and keeps the list newest first.
  function merge(rows) {
    rows.forEach((row) => {
      if (row?.id == null) return;
      const id = String(row.id);
      if (!row.read) state.fresh.add(id);
      const known = state.byId.get(id);
      if (known) {
        Object.assign(known, row);
        return;
      }
      state.byId.set(id, row);
      state.rows.push(row);
    });
    state.rows.sort(byNewest);
  }

  const visibleRows = () =>
    state.period === "all" ? state.rows : state.rows.filter((n) => periodOf(stamp(n)) === state.period);

  async function loadMore() {
    if (!state.me || state.loading || state.done) return;
    if (isEmpty(rangeOf(state.period))) {
      state.done = true;
      paintList();
      return;
    }
    const gen = state.gen;
    state.loading = true;
    paintMore();
    let res = null;
    try {
      res = await supabaseRequest(listPath(state.fetched));
    } catch {
      res = null;
    }
    if (gen !== state.gen) return;
    state.loading = false;
    if (!res || !res.ok || !Array.isArray(res.data)) {
      if (state.rows.length) {
        state.stall = true;
        toast(t("notes.loadFail"));
      } else {
        state.failed = true;
      }
      paintList();
      return;
    }
    state.stall = false;
    state.fetched += res.data.length;
    if (res.data.length < PAGE) state.done = true;
    merge(res.data);
    paintList();
    markShown();
  }

  // The bell found something new: fetch the first page again and merge it.
  // The paging offset is left alone on purpose: rows that slid in on top can
  // only make the next page repeat a few rows (merged away), never skip any.
  async function refreshTop() {
    if (!state.me || state.failed || isEmpty(rangeOf(state.period))) return;
    const gen = state.gen;
    let res = null;
    try {
      res = await supabaseRequest(listPath(0));
    } catch {
      return;
    }
    if (gen !== state.gen || !res?.ok || !Array.isArray(res.data)) return;
    merge(res.data);
    paintList();
    markShown();
  }

  // The number of notifications of one query, from the content-range header.
  async function countOf(path) {
    try {
      const res = await supabaseRequest(`${path}&select=id&limit=1`, {
        headers: { Prefer: "count=exact", Range: "0-0" },
      });
      if (!res.ok) return null;
      const total = String(res.headers?.get?.("content-range") || "").split("/")[1];
      const n = Number(total);
      return total && total !== "*" && Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  async function loadCounts() {
    if (!state.me) return;
    const gen = ++state.countGen;
    const bounds = state.bounds;
    const out = await Promise.all(
      PERIODS.map((p) => {
        const range = rangeOf(p, bounds);
        return isEmpty(range) ? 0 : countOf(`${basePath()}${rangeQuery(range)}`);
      })
    );
    if (gen !== state.countGen || bounds !== state.bounds) return;
    if (out.some((n) => n == null)) {
      if (!state.counts) paintTabs(); // keep the tabs, without numbers
      return;
    }
    const counts = { all: 0 };
    PERIODS.forEach((p, i) => {
      counts[p] = out[i];
      counts.all += out[i];
    });
    const first = !state.counts;
    state.counts = counts;
    paintTabs();
    if (first) revealActiveTab();
    paintSummary();
    paintMore();
  }

  // Shown means seen: mark them read, as the bell does when it opens.
  function markShown() {
    const ids = visibleRows()
      .filter((n) => !n.read)
      .map((n) => {
        n.read = true;
        return n.id;
      });
    paintSummary();
    if (ids.length) C.markNotesRead(ids);
  }

  // ---------- markup ----------
  function kindOf(n) {
    const kind = String(n.kind || "").toLowerCase();
    if (kind === "vote_up") return "up";
    if (kind === "vote_down") return "down";
    if (kind.startsWith("prize")) return "prize";
    if (kind.startsWith("iptv")) return "iptv"; // a premium IPTV account given or renewed
    return ICON[kind] ? kind : "info";
  }

  function rowHtml(n) {
    const id = String(n.id);
    const kind = kindOf(n);
    const fresh = state.fresh.has(id);
    const name = String(n.from_username || "").replace(/^@/, "").trim();
    const media =
      n.from_id || name
        ? `<span class="nts-ava">${C.avatarImg(n.from_id || "", name, name || "CA")}<span class="nts-kind k-${kind}">${ICON[kind]}</span></span>`
        : `<span class="nts-ava nts-ava-ico k-${kind}">${ICON[kind]}</span>`;
    const when = C.noteWhen(n.created_at);
    return `
      <li>
        <a class="nts-row${fresh ? " is-new" : ""}" href="${escapeHtml(C.noteHref(n))}" data-note="${escapeHtml(id)}">
          ${media}
          <span class="nts-text">
            <strong class="nts-title">${C.noteTextHtml(C.noteTitle(n) || t("notes.title"))}</strong>
            ${n.body ? `<span class="nts-msg">${C.noteTextHtml(n.body)}</span>` : ""}
            ${when ? `<time class="nts-time" datetime="${escapeHtml(n.created_at)}" title="${escapeHtml(C.noteFullDate(n.created_at))}">${escapeHtml(when)}</time>` : ""}
          </span>
          ${fresh ? `<span class="nts-dot" role="img" aria-label="${escapeHtml(t("notes.unread"))}"></span>` : ""}
        </a>
      </li>`;
  }

  function sectionHtml(group) {
    const year = YEAR_KEY.exec(group.key)?.[1];
    const label = year || t(LABEL[group.key]);
    const sub = year ? "" : rangeText(group.key);
    return `
      <section class="nts-sec" data-sec="${group.key}">
        <h2 class="nts-sec-head"><span>${escapeHtml(label)}</span>${sub ? `<small>${escapeHtml(sub)}</small>` : ""}</h2>
        <ol class="nts-rows">${group.rows.map(rowHtml).join("")}</ol>
      </section>`;
  }

  function noteBox(icon, title, text, action) {
    return `
      <div class="nts-empty">
        ${svg(icon)}
        <strong>${escapeHtml(title)}</strong>
        ${text ? `<p>${escapeHtml(text)}</p>` : ""}
        ${action || ""}
      </div>`;
  }

  function emptyHtml() {
    if (state.period === "all") return noteBox(BELL, t("notes.empty"), t("notes.emptyHint"));
    return noteBox(
      BELL,
      t("notes.emptyPeriod"),
      "",
      `<button class="btn btn-sm btn-ghost" type="button" data-period="all">${escapeHtml(t("notes.viewAll"))}</button>`
    );
  }

  function failHtml() {
    return noteBox(
      '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16.5h.01"/>',
      t("notes.loadFail"),
      "",
      `<button class="btn btn-sm btn-primary" type="button" data-retry>${escapeHtml(t("notes.retry"))}</button>`
    );
  }

  function gateHtml() {
    const next = state.period === "all" ? "notifications.html" : `notifications.html?period=${state.period}`;
    return `
      <section class="glass dash-gate nts-gate">
        <span class="eyebrow">${escapeHtml(t("notes.title"))}</span>
        <h1>${escapeHtml(t("notes.signinTitle"))}</h1>
        <p>${escapeHtml(t("notes.signinText"))}</p>
        <div class="success-actions">
          <a class="btn btn-sm btn-primary" href="./login.html?next=${encodeURIComponent(next)}">${escapeHtml(t("common.signin"))}</a>
          <a class="btn btn-sm btn-ghost" href="./register.html">${escapeHtml(t("nav.signup"))}</a>
        </div>
      </section>`;
  }

  // ---------- painting ----------
  // Re-painting a box must not throw the keyboard focus out of it.
  function keepFocus(box, attr, paint) {
    const el = document.activeElement;
    const value = el && el !== box && box.contains(el) ? el.getAttribute(attr) : null;
    paint();
    if (value != null) box.querySelector(`[${attr}="${CSS.escape(value)}"]`)?.focus({ preventScroll: true });
  }

  function paintTabs() {
    const box = document.getElementById("nts-tabs");
    if (!box) return;
    const c = state.counts;
    keepFocus(box, "data-period", () => {
      box.innerHTML = TABS.filter((p) => p !== "older" || state.period === "older" || (c && c.older > 0))
        .map((p) => {
          const active = state.period === p;
          const n = c ? c[p] : null;
          return `<button type="button" class="follow-tab${active ? " active" : ""}" data-period="${p}" aria-pressed="${active}"${n === 0 && !active ? " disabled" : ""}>${escapeHtml(t(LABEL[p]))}${n == null ? "" : `<span class="follow-count">${n}</span>`}</button>`;
        })
        .join("");
    });
  }

  // On a narrow screen the tabs scroll sideways: bring the active one into view
  // by scrolling the tab bar only, never the page.
  function revealActiveTab() {
    const box = document.getElementById("nts-tabs");
    const tab = box?.querySelector(".follow-tab.active");
    if (!tab || box.scrollWidth <= box.clientWidth) return;
    const outer = box.getBoundingClientRect();
    const inner = tab.getBoundingClientRect();
    if (inner.left < outer.left) box.scrollLeft -= outer.left - inner.left + 16;
    else if (inner.right > outer.right) box.scrollLeft += inner.right - outer.right + 16;
  }

  function paintSummary() {
    const el = document.getElementById("nts-sum");
    if (!el) return;
    const parts = [];
    if (state.counts) parts.push(t("notes.total", { n: state.counts.all }));
    if (state.fresh.size) parts.push(t("notes.newCount", { n: state.fresh.size }));
    el.textContent = parts.join(" · ");
    el.hidden = !parts.length;
  }

  function paintList() {
    const list = document.getElementById("nts-list");
    if (!list) return;
    const rows = visibleRows();
    if (!rows.length) {
      if (state.failed) list.innerHTML = failHtml();
      else if (!state.done) {
        list.innerHTML = `<p class="muted nts-loading"><span class="nts-spin" aria-hidden="true"></span>${escapeHtml(t("common.loading"))}</p>`;
      } else list.innerHTML = emptyHtml();
      paintMore();
      return;
    }
    const groups = [];
    rows.forEach((n) => {
      const key = sectionOf(n);
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.rows.push(n);
      else groups.push({ key, rows: [n] });
    });
    keepFocus(list, "data-note", () => {
      list.innerHTML = groups.map(sectionHtml).join("");
    });
    C.hydrateAvatars(list);
    paintMore();
  }

  let observer = null;
  function paintMore() {
    const btn = document.getElementById("nts-more");
    if (!btn) return;
    const shown = visibleRows().length;
    btn.hidden = state.done || state.failed || !shown;
    if (btn.hidden) return;
    btn.disabled = state.loading;
    const total = state.counts ? state.counts[state.period] : null;
    const left = total == null ? 0 : Math.max(0, total - shown);
    btn.textContent = state.loading ? t("common.loading") : left ? t("notes.moreN", { n: left }) : t("notes.more");
    // the next page loads by itself when the button comes near
    if (!("IntersectionObserver" in window)) return;
    if (!observer) {
      observer = new IntersectionObserver(
        (entries) => {
          if (!state.stall && entries.some((e) => e.isIntersecting)) loadMore();
        },
        { rootMargin: "600px 0px" }
      );
    }
    observer.disconnect();
    observer.observe(btn);
  }

  function render() {
    const root = document.getElementById("notes-root");
    if (!root) return;
    if (!state.me) {
      root.innerHTML = gateHtml();
      return;
    }
    root.innerHTML = `
      <section class="glass dash-main nts-page">
        <div class="nts-head">
          <h1>${escapeHtml(t("notes.title"))}</h1>
          <p class="muted" id="nts-sum" hidden></p>
        </div>
        <div class="follow-tabs nts-tabs" id="nts-tabs" role="group" aria-label="${escapeHtml(t("notes.periods"))}"></div>
        <div class="nts-list" id="nts-list"></div>
        <div class="nts-more"><button class="btn btn-sm btn-ghost" id="nts-more" type="button" hidden></button></div>
      </section>`;
    paintTabs();
    revealActiveTab();
    paintSummary();
    paintList();
  }

  // ---------- actions ----------
  function resetList() {
    state.gen++;
    state.rows = [];
    state.byId = new Map();
    state.fetched = 0;
    state.done = false;
    state.loading = false;
    state.failed = false;
    state.stall = false;
  }

  function reload() {
    resetList();
    state.bounds = computeBounds();
    render();
    loadMore();
    loadCounts();
  }

  function setPeriod(period) {
    if (!TABS.includes(period) || period === state.period) return;
    state.period = period;
    const url = new URL(location.href);
    if (period === "all") url.searchParams.delete("period");
    else url.searchParams.set("period", period);
    history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
    resetList();
    paintTabs();
    revealActiveTab();
    paintList();
    loadMore();
  }

  function bind() {
    const root = document.getElementById("notes-root");
    root.addEventListener("click", (e) => {
      const tab = e.target.closest("button[data-period]");
      if (tab) return setPeriod(tab.dataset.period);
      if (e.target.closest("#nts-more")) {
        state.stall = false;
        return loadMore();
      }
      if (e.target.closest("[data-retry]")) return reload();
      return undefined;
    });

    // the bell checks every 30 s: when its newest notifications change, so does the page
    document.addEventListener("cineaura:notes", (e) => {
      const notes = Array.isArray(e.detail?.notes) ? e.detail.notes : [];
      const sig = notes.map((n) => `${n.id}@${n.created_at}`).join(",");
      if (state.bellSig === null || !state.me) {
        state.bellSig = sig;
        return;
      }
      if (sig === state.bellSig) return;
      state.bellSig = sig;
      refreshTop();
      loadCounts();
    });

    // A language or country change re-labels the page (the week may start on another day).
    document.addEventListener("cineaura:prefs", () => {
      if (!state.me) return render();
      if (!sameBounds(computeBounds(), state.bounds)) return reload();
      return render();
    });

    // "5 minutes ago" moves on; at midnight the periods move too
    setInterval(() => {
      if (!state.me) return;
      if (!sameBounds(computeBounds(), state.bounds)) {
        reload();
        return;
      }
      document.querySelectorAll("#nts-list time[datetime]").forEach((el) => {
        const text = C.noteWhen(el.getAttribute("datetime"));
        if (text && el.textContent !== text) el.textContent = text;
      });
    }, 60000);

    // signed in from another tab
    window.addEventListener("storage", (e) => {
      if (e.key === SESSION_KEY && !state.me && getSession()?.member_id) start();
    });

    // Back from a notification's page: the browser may show this page as it was left.
    window.addEventListener("pageshow", (e) => {
      if (!e.persisted) return;
      const me = getSession()?.member_id || "";
      if (me !== state.me) {
        location.reload();
        return;
      }
      if (me) {
        refreshTop();
        loadCounts();
      }
    });
  }

  function start() {
    state.me = getSession()?.member_id || "";
    if (!state.me) {
      render();
      return;
    }
    reload();
  }

  document.addEventListener("DOMContentLoaded", () => {
    setupChrome();
    start();
    bind(); // before the bell's first answer arrives
  });
})();
