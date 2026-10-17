/* CineAura — IPTV.html: the IPTV lists published by members (sql/iptv_lists.sql).
 *
 * A search box (name, description, publisher), then the lists the visitor may see:
 * public ones for everybody; for a signed-in member also the exclusive lists whose
 * criteria they meet (followers, country, language) and the private lists they were
 * given. Tabs All / Public / Exclusive / Private / Mine (members), sort newest, most
 * viewed, most channels, A→Z, Z→A (most relevant while searching). The address keeps
 * every choice: ?q=&sort=&show=. "Publish a list" opens the dialog of
 * js/iptv-lists.js (IPTV.html#publish opens it at once); the member manages their
 * lists in Dashboard > IPTV > Your lists.
 */
(() => {
  "use strict";
  const C = window.CineAura;
  const L = window.CineAuraIptvLists;
  const { t, escapeHtml: esc } = C;

  const PAGE = 24;
  const SORTS = ["date", "views", "channels", "az", "za"];
  const FILTERS = ["", "public", "exclusive", "private", "mine"];
  const params = new URLSearchParams(location.search);
  const state = {
    q: (params.get("q") || "").trim().slice(0, 120),
    sort: SORTS.concat("relevance").includes(params.get("sort")) ? params.get("sort") : "",
    filter: FILTERS.includes(params.get("show") || "") ? params.get("show") || "" : "",
    items: [],
    total: 0,
    seq: 0,
    fresh: "", // the list just published: shown first, outlined
  };
  const $ = (sel) => document.querySelector(sel);
  const signedIn = () => Boolean(L.memberId());
  const effectiveSort = () => state.sort || (state.q ? "relevance" : "date");

  const PLUS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

  function syncUrl() {
    const q = new URLSearchParams();
    if (state.q) q.set("q", state.q);
    if (state.sort) q.set("sort", state.sort);
    if (state.filter) q.set("show", state.filter);
    const s = q.toString();
    history.replaceState(history.state, "", `${location.pathname}${s ? `?${s}` : ""}${location.hash === "#publish" ? "" : location.hash}`);
  }

  // ---------------------------------------------------------------- controls
  function drawActions() {
    $("#ipl-acts").innerHTML = signedIn()
      ? `<button class="btn btn-sm btn-primary" type="button" data-publish>${PLUS}<span>${esc(t("ipl.publish"))}</span></button>
         <a class="btn btn-sm btn-ghost" href="${L.MANAGE_HREF}">${esc(t("ipl.yourLists"))}</a>`
      : `<a class="btn btn-sm btn-primary" href="./login.html?next=${encodeURIComponent("IPTV.html#publish")}">${PLUS}<span>${esc(t("ipl.signinPublish"))}</span></a>`;
  }

  function drawTools() {
    const tabs = signedIn()
      ? `<div class="follow-tabs" role="tablist" aria-label="${esc(t("ipl.showLabel"))}">${FILTERS.map((f) => {
          const on = state.filter === f;
          const count = on && state.total ? ` <span class="follow-count">${esc(L.fmt(state.total))}</span>` : "";
          return `<button type="button" role="tab" class="follow-tab${on ? " active" : ""}" data-show="${f}" aria-selected="${on}">${esc(t(`ipl.show.${f || "all"}`))}${count}</button>`;
        }).join("")}</div>`
      : "<span></span>";
    const sorts = (state.q ? ["relevance"] : []).concat(SORTS);
    $("#ipl-tools").innerHTML = `
      ${tabs}
      <label class="vs-filter" for="ipl-sort">
        <span>${esc(t("vid.sortBy"))}</span>
        <select id="ipl-sort">${sorts.map((s) => `<option value="${s}" ${s === effectiveSort() ? "selected" : ""}>${esc(t(`ipl.sort.${s}`))}</option>`).join("")}</select>
      </label>`;
  }

  // ---------------------------------------------------------------- the lists
  function heading() {
    if (state.q) return t("vid.resultsFor", { q: state.q });
    if (state.filter === "mine") return t("ipl.head.mine");
    if (state.filter) return t(`ipl.head.${state.filter}`);
    return t("ipl.head.all");
  }

  function emptyHtml() {
    const publish = signedIn()
      ? `<button class="btn btn-sm btn-primary" type="button" data-publish>${PLUS}<span>${esc(t("ipl.publish"))}</span></button>`
      : `<a class="btn btn-sm btn-primary" href="./login.html?next=${encodeURIComponent("IPTV.html#publish")}">${esc(t("ipl.signinPublish"))}</a>`;
    if (state.q) {
      return `<div class="vs-none glass"><h2>${esc(t("vid.noResults"))}</h2><p class="muted">${esc(t("ipl.noResultsText"))}</p></div>`;
    }
    if (state.filter === "mine") {
      return `<div class="vs-none glass"><h2>${esc(t("ipl.noMine"))}</h2><p class="muted">${esc(t("ipl.noMineText"))}</p>${publish}</div>`;
    }
    if (state.filter) {
      return `<div class="vs-none glass"><h2>${esc(t("vid.noResults"))}</h2><p class="muted">${esc(t(`ipl.none.${state.filter}`))}</p></div>`;
    }
    return `<div class="vs-none glass"><h2>${esc(t("ipl.none"))}</h2><p class="muted">${esc(t("ipl.noneText"))}</p>${publish}</div>`;
  }

  function draw() {
    const box = $("#ipl-results");
    if (!state.items.length) {
      box.innerHTML = emptyHtml();
      return;
    }
    box.innerHTML = `
      <div class="vs-results-head"><h2>${esc(heading())}</h2><span class="muted">${esc(t(state.total === 1 ? "ipl.countOne" : "ipl.countN", { n: L.fmt(state.total) }))}</span></div>
      <div class="ipl-grid">${state.items.map((l) => L.cardHtml(l)).join("")}</div>
      ${state.items.length < state.total ? `<div class="vs-more"><button class="btn btn-lg btn-ghost" type="button" data-more>${esc(t("vid.loadMore"))}</button></div>` : ""}`;
    C.hydrateAvatars?.(box);
    if (state.fresh) {
      const card = box.querySelector(`[data-ipl-id="${CSS.escape(state.fresh)}"]`);
      if (card) {
        card.classList.add("is-fresh");
        card.scrollIntoView({ block: "nearest" });
      }
      state.fresh = "";
    }
  }

  async function load(more = false) {
    const seq = ++state.seq;
    const box = $("#ipl-results");
    if (!more) {
      state.items = [];
      box.innerHTML = `<p class="muted">${esc(t("common.loading"))}</p>`;
    } else {
      box.querySelector("[data-more]")?.setAttribute("disabled", "");
    }
    const res = await L.call("iptv_lists_search", {
      p_member: L.memberId(),
      p_q: state.q,
      p_sort: effectiveSort(),
      p_filter: state.filter,
      p_limit: PAGE,
      p_offset: more ? state.items.length : 0,
    });
    if (seq !== state.seq) return;
    if (!res.ok) {
      box.innerHTML = `<div class="vs-none glass"><h2>${esc(t(res.setup ? "ipl.setupTitle" : "ipl.loadFail"))}</h2><p class="muted">${esc(t(res.setup ? "ipl.setupText" : "ipl.loadFailText"))}</p></div>`;
      return;
    }
    const items = Array.isArray(res.data?.items) ? res.data.items : [];
    state.total = Number(res.data?.total || 0);
    state.items = more ? state.items.concat(items) : items;
    drawTools();
    draw();
  }

  function run() {
    syncUrl();
    drawTools();
    load(false);
  }

  function publish() {
    L.openForm({
      onSaved(id) {
        Object.assign(state, { q: "", sort: "", filter: "", fresh: id });
        $("#ipl-q").value = "";
        run();
      },
    });
  }

  function wire() {
    $("#ipl-q").value = state.q;
    $("#ipl-form").addEventListener("submit", (e) => {
      e.preventDefault();
      state.q = $("#ipl-q").value.trim().slice(0, 120);
      if (state.sort === "relevance" && !state.q) state.sort = "";
      run();
    });
    $("#ipl-tools").addEventListener("click", (e) => {
      const b = e.target.closest("[data-show]");
      if (!b || b.dataset.show === state.filter) return;
      state.filter = b.dataset.show;
      run();
    });
    $("#ipl-tools").addEventListener("change", (e) => {
      if (e.target.id !== "ipl-sort") return;
      state.sort = e.target.value === (state.q ? "relevance" : "date") ? "" : e.target.value;
      run();
    });
    document.addEventListener("click", (e) => {
      if (e.target.closest("[data-publish]")) publish();
      if (e.target.closest("[data-more]")) load(true);
    });
    // the language changes: labels and dates follow
    document.addEventListener("cineaura:prefs", () => {
      drawActions();
      drawTools();
      draw();
    });
  }

  function boot() {
    // IPTV.html#publish (the sign-in page brings the member back here): the dialog opens
    const wantsPublish = location.hash === "#publish";
    C.setupChrome();
    drawActions();
    wire();
    run();
    if (wantsPublish && signedIn()) publish();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
