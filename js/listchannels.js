/* Listchannels.html — the channels of one IPTV package (?package=<name>).
 *
 * Every channel card opens the channel player (js/channel-player.js). Its
 * "Report channel" button writes public.channel_reports, which the staff read
 * in Panel > Reports > Channels.
 *
 * Who may play: free packages play for every signed-in member, a premium
 * package for the member it is assigned to (the same rule as Dashboard > IPTV),
 * and the staff always. ?package=<name>&channel=<id> opens a channel at once,
 * and the browser's Back button closes the player.
 */
(() => {
  const C = window.CineAura;
  const { setupChrome, supabaseRequest, restValue, escapeHtml, getSession, t, toast } = C;
  const player = () => window.CineAuraChannels;

  const PAGE = 1000; // Supabase returns at most 1000 rows per request
  const MAX_ROWS = 20000; // the panel imports at most 20 000 channels
  const PANEL_KEY = "cineaura_panel";

  const params = new URLSearchParams(location.search);
  const pack = (params.get("package") || "").trim();
  const state = {
    rows: [],
    access: "ok", // ok | signin | locked
    query: "",
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
  };

  const norm = (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  const groupName = (row) => {
    const g = String(row.group_name || "").trim();
    return !g || g === "General" ? t("chan.general") : g;
  };

  function staffSession() {
    try {
      const panel = JSON.parse(sessionStorage.getItem(PANEL_KEY) || localStorage.getItem(PANEL_KEY) || "null");
      return Boolean(panel && panel.token);
    } catch {
      return false;
    }
  }

  async function loadChannels() {
    const rows = [];
    for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
      const res = await supabaseRequest(
        `/rest/v1/listchannels?package_name=eq.${restValue(pack)}&select=*&order=group_name.asc,id.asc&limit=${PAGE}&offset=${offset}`
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
    const me = getSession()?.member_id || "";
    if (staffSession()) return "ok";
    if (!me) return "signin";
    const res = await supabaseRequest(`/rest/v1/iptv?name=eq.${restValue(pack)}&select=id,type,owner_id`);
    const accounts = res.ok && Array.isArray(res.data) ? res.data : [];
    if (!accounts.length) return "ok"; // not registered in Panel > IPTV: nothing to check against
    const mine = accounts.some((a) => String(a.type || "").toLowerCase() === "free" || (a.owner_id && a.owner_id === me));
    return mine ? "ok" : "locked";
  }

  // ---------- markup ----------
  function noticeHtml() {
    if (state.access === "signin") {
      return `
        <div class="chl-note" id="chl-note">
          <div><strong>${escapeHtml(t("chan.signinTitle"))}</strong><p>${escapeHtml(t("chan.signinText"))}</p></div>
          <a class="btn btn-sm btn-primary" href="./login.html?next=dashboard.html%23iptv">${escapeHtml(t("common.signin"))}</a>
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

  function cardHtml(i) {
    const ch = state.rows[i];
    const locked = state.access !== "ok";
    const href = `?package=${encodeURIComponent(pack)}&channel=${encodeURIComponent(ch.id)}`;
    return `
      <a class="ch-card${locked ? " locked" : ""}${i === state.playing ? " is-playing" : ""}" href="${href}" data-ch="${i}" data-name="${escapeHtml(norm(ch.channel_name))}" title="${escapeHtml(ch.channel_name)}" aria-label="${escapeHtml(t("chan.play", { name: ch.channel_name }))}">
        ${player().logoHtml(ch, "ch-logo")}
        <span class="ch-info"><strong>${escapeHtml(ch.channel_name)}</strong><small>${escapeHtml(player().typeLabel(ch))}</small></span>
        <span class="ch-play" aria-hidden="true">${locked ? ICON.lock : ICON.play}</span>
      </a>`;
  }

  function render() {
    const root = document.getElementById("root");
    if (!root) return;
    if (!pack) {
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
          <h1>${escapeHtml(pack)}</h1>
          <p class="muted chl-loading"><span class="chl-spin" aria-hidden="true"></span>${escapeHtml(t("common.loading"))}</p>
        </section>`;
      return;
    }
    const groups = new Map();
    state.rows.forEach((row, i) => {
      const g = groupName(row);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(i);
    });
    const body = state.failed
      ? `<p class="empty">${escapeHtml(t("chan.loadFail"))}</p>`
      : [...groups]
          .map(
            ([g, list]) => `
          <section class="chl-group" data-group>
            <h2>${escapeHtml(g)} <span class="follow-count" data-count>${list.length}</span></h2>
            <div class="chl-grid">${list.map(cardHtml).join("")}</div>
          </section>`
          )
          .join("") || `<p class="empty">${escapeHtml(t("chan.empty"))}</p>`;
    root.innerHTML = `
      <section class="glass dash-main chl-page">
        <div class="chl-head">
          <div class="chl-title">
            <p class="eyebrow">${escapeHtml(t("dash.liveTv"))}</p>
            <h1>${escapeHtml(pack)}</h1>
            ${state.rows.length ? `<p class="muted">${escapeHtml(t("chan.count", { n: state.rows.length, g: groups.size }))}</p>` : ""}
          </div>
          ${
            state.rows.length > 1
              ? `<label class="chl-search">${ICON.search}<input type="search" id="chl-q" value="${escapeHtml(state.query)}" placeholder="${escapeHtml(t("chan.search"))}" aria-label="${escapeHtml(t("chan.search"))}" autocomplete="off" enterkeyhint="search" /></label>`
              : ""
          }
        </div>
        ${noticeHtml()}
        <div class="chl-groups" id="chl-groups">${body}</div>
        <p class="empty" id="chl-none" hidden></p>
      </section>`;
    const input = document.getElementById("chl-q");
    if (input) {
      let timer = 0;
      input.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          state.query = input.value;
          applyFilter();
        }, 120);
      });
    }
    applyFilter();
  }

  function applyFilter() {
    const q = norm(state.query);
    let shown = 0;
    document.querySelectorAll("#chl-groups [data-group]").forEach((section) => {
      let count = 0;
      section.querySelectorAll(".ch-card").forEach((card) => {
        const match = !q || card.dataset.name.includes(q);
        card.hidden = !match;
        if (match) count += 1;
      });
      section.hidden = count === 0;
      const badge = section.querySelector("[data-count]");
      if (badge) badge.textContent = String(count);
      shown += count;
    });
    const none = document.getElementById("chl-none");
    if (none) {
      none.hidden = !(q && !shown);
      none.textContent = t("chan.noMatch", { q: state.query.trim() });
    }
  }

  // ---------- player ----------
  const visibleCards = () => [...document.querySelectorAll("#chl-groups .ch-card:not([hidden])")];

  function markPlaying(row) {
    state.playing = row ? state.rows.indexOf(row) : -1;
    document.querySelectorAll("#chl-groups .ch-card.is-playing").forEach((el) => el.classList.remove("is-playing"));
    if (state.playing >= 0) document.querySelector(`#chl-groups .ch-card[data-ch="${state.playing}"]`)?.classList.add("is-playing");
  }

  const pageUrl = (row) =>
    `${location.pathname}?package=${encodeURIComponent(pack)}${row ? `&channel=${encodeURIComponent(row.id)}` : ""}`;

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
    player().open(list, index, {
      report: true,
      onChange(i) {
        markPlaying(list[i]);
        syncUrl(list[i], push && first);
        first = false;
      },
      onClose() {
        markPlaying(null);
        leaveUrl();
      },
    });
  }

  function openCard(card) {
    if (state.access === "signin") {
      toast(t("chan.signinPlay"));
      flashNotice();
      return;
    }
    if (state.access === "locked") {
      toast(t("chan.lockedTitle"));
      flashNotice();
      return;
    }
    const cards = visibleCards();
    const list = cards.map((el) => state.rows[Number(el.dataset.ch)]);
    openPlayer(list, Math.max(0, cards.indexOf(card)), true);
  }

  function openFromAddress() {
    const wanted = new URLSearchParams(location.search).get("channel");
    if (!wanted || state.access !== "ok") return;
    const card = visibleCards().find((el) => String(state.rows[Number(el.dataset.ch)]?.id) === wanted);
    if (!card) return;
    const cards = visibleCards();
    openPlayer(cards.map((el) => state.rows[Number(el.dataset.ch)]), cards.indexOf(card), false);
  }

  // ---------- boot ----------
  document.addEventListener("DOMContentLoaded", async () => {
    setupChrome();
    const root = document.getElementById("root");
    render();
    if (!pack) return;
    root.addEventListener("click", (e) => {
      const card = e.target.closest(".ch-card");
      if (!card) return;
      // Ctrl/Cmd/middle click keeps the link: the channel opens in a new tab
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      openCard(card);
    });
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
    document.addEventListener("cineaura:prefs", () => {
      if (state.loaded) render();
    });
    try {
      const [rows, access] = await Promise.all([loadChannels(), loadAccess().catch(() => "ok")]);
      state.rows = rows;
      state.access = access;
    } catch {
      state.failed = true;
    }
    state.loaded = true;
    render();
    openFromAddress();
  });
})();
