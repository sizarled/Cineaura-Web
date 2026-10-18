/* CineAura — the IPTV lists that members publish (sql/iptv_lists.sql).
 *
 * Shared by IPTV.html (search box, the lists, "Publish a list"), Dashboard > IPTV >
 * Your lists, Search.html > Channels and Listchannels.html?list=IPL… (the channels of a
 * list with the channel player).
 *
 *   L.openForm({ list, onSaved })  the publish / edit dialog: name, description, the
 *                                  playlist (a link, or an .m3u file uploaded to Storage:
 *                                  bucket IPTV, folder Playlist), the programme guide and
 *                                  who sees the list (public / exclusive / private)
 *   L.refresh(list)                reads the playlist again and saves its channels
 *   L.cardHtml(list, opts)         a list as a card (a lock when the visitor may not open it yet;
 *                                  a private list: Request to join)
 *   L.channelHtml(item)            a channel found by Search.html > Channels
 *   L.wireJoin(root, onSent)       the Request to join buttons inside root (a note, then Send)
 *
 * Saving reads the playlist in the browser first (a link that refuses the browser goes
 * through /api/m3u of server.py), so a list without channels is never published. The
 * names, groups, logos and types of its channels (never their links) are then saved for
 * the channel search, with the id each channel has on Listchannels.html.
 */
(() => {
  "use strict";
  const C = window.CineAura;
  const { t, escapeHtml: esc } = C;

  const BUCKET = "IPTV";
  const FOLDER = "Playlist";
  const MAX_FILE = 30 * 1024 * 1024; // an uploaded playlist, at most
  const CHUNK = 2000; // channels sent per request
  const MAX_INDEX = 20000; // channels kept for the search (sql/iptv_lists.sql)
  const VIS = ["public", "exclusive", "private"];
  const LANG_CODES = ["en", "ar", "fr", "de", "es", "nl", "it"];
  const HUES = [204, 162, 262, 18, 332, 44, 186, 288];

  const ICON = {
    tv: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="6" width="19" height="13" rx="2.5"/><path d="M8 2.5l4 3.5 4-3.5"/></svg>',
    globe: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
    star: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>',
    lock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    play: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 8 5.5z"/></svg>',
    link: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>',
    upload: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>',
    close: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    join: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 19a6 6 0 0 0-12 0"/><circle cx="9" cy="8" r="3.5"/><path d="M19 8v6M16 11h6"/></svg>',
    check: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    key: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/></svg>',
    bell: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
  };
  const VIS_ICON = { public: ICON.globe, exclusive: ICON.star, private: ICON.lock };

  const memberId = () => String(C.getSession()?.member_id || "");

  // ---------------------------------------------------------------- calls
  function setupMissing(res) {
    const code = res?.data?.code;
    return res?.status === 404 || code === "PGRST202" || code === "PGRST205" || code === "42883";
  }

  // -> { ok: true, data } | { ok: false, setup | network | status, data }
  async function call(name, args = {}) {
    let res;
    try {
      res = await C.rpc(name, args);
    } catch {
      return { ok: false, network: true };
    }
    if (!res.ok) {
      if (setupMissing(res)) {
        console.warn(`CineAura: ${name}() is missing — run sql/iptv_lists.sql in the Supabase SQL editor.`);
        return { ok: false, setup: true };
      }
      return { ok: false, status: res.status, data: res.data };
    }
    return { ok: true, data: res.data };
  }

  // ---------------------------------------------------------------- addresses
  const publicUrl = (path) =>
    `${C.SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${String(path || "").split("/").map(encodeURIComponent).join("/")}`;
  const sourceUrl = (l) => (l?.source === "upload" ? (l.path ? publicUrl(l.path) : "") : String(l?.url || ""));
  const listHref = (id) => `./Listchannels.html?list=${encodeURIComponent(id)}`;
  const channelHref = (item) =>
    `${listHref(item.list?.id || "")}${item.key ? `&channel=${encodeURIComponent(item.key)}` : ""}&name=${encodeURIComponent(item.name || "")}`;
  const MANAGE_HREF = "./dashboard.html#iptv-lists";

  // ---------------------------------------------------------------- numbers, dates, names
  function numFormat(opts) {
    try {
      return new Intl.NumberFormat(`${C.getLocale()}-u-nu-latn`, opts);
    } catch {
      return new Intl.NumberFormat("en-US", opts);
    }
  }
  const fmt = (n) => numFormat().format(Number(n) || 0);
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
      return new Intl.RelativeTimeFormat(`${C.getLocale()}-u-nu-latn`, { numeric: "auto" }).format(Math.round(diff / div), unit);
    } catch {
      return new Date(at).toLocaleDateString();
    }
  }

  const langName = (code) => (C.LANG_NAMES && C.LANG_NAMES[code]) || code;
  const countryName = (cc) => (cc ? C.countryName(cc) || cc : "");
  const codes = (csv) => String(csv || "").split(",").map((x) => x.trim()).filter(Boolean);
  const visLabel = (v) => t(`ipl.vis.${VIS.includes(v) ? v : "public"}`);

  function hueOf(id) {
    let h = 0;
    for (const ch of String(id || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return HUES[h % HUES.length];
  }

  function initials(name) {
    const words = String(name || "").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
    return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || "TV").slice(0, 2)).toUpperCase();
  }

  // the name of a level and of a plan: "LV3", "LV Max"; "Gold"
  const levelName = (n) => (Number(n) >= 10 ? "LV Max" : `LV${Math.max(0, Number(n) || 0)}`);
  const planName = (p) => t(`ipl.plan.${["Silver", "Gold", "Diamond"].includes(p) ? p : "Free"}`);

  // "Followers of @bob · Morocco, France · العربية · LV3 or higher · Gold or higher · Password"
  function criteriaParts(l) {
    const out = [];
    if (l.followers) out.push(t("ipl.crit.followersOf", { name: `@${l.owner || ""}` }));
    const ctys = codes(l.countries).map(countryName);
    if (ctys.length) out.push(ctys.join(", "));
    const langs = codes(l.languages).map(langName);
    if (langs.length) out.push(langs.join(", "));
    if (Number(l.level) > 0) out.push(t("ipl.crit.level", { level: levelName(l.level) }));
    if (l.plan) out.push(t("ipl.crit.plan", { plan: planName(l.plan) }));
    if (l.password) out.push(t("ipl.crit.password"));
    return out;
  }

  // why a list stays shut for this visitor (a lock on its card)
  function lockText(l) {
    const why = l.locked;
    if (!why) return "";
    if (why === "private") return t(l.request === "pending" ? "ipl.lock.pending" : "ipl.lock.private");
    if (why === "signin") return t("ipl.lock.signin");
    if (why === "followers") return t("ipl.no.followers", { name: `@${l.owner || ""}` });
    if (why === "country") return t("ipl.no.country", { list: codes(l.countries).map(countryName).join(", ") });
    if (why === "language") return t("ipl.no.language", { list: codes(l.languages).map(langName).join(", ") });
    if (why === "level") return t("ipl.lock.level", { level: levelName(l.level) });
    if (why === "plan") return t("ipl.lock.plan", { plan: planName(l.plan) });
    if (why === "password") return t("ipl.lock.password");
    return t("ipl.no.found");
  }

  // the Request to join button of a private list (or where its request stands)
  function joinHtml(l) {
    if (l.locked !== "private") return "";
    if (l.request === "pending" || joinSent.has(l.id)) return `<span class="ipl-join-sent">${ICON.check}<span>${esc(t("ipl.join.sent"))}</span></span>`;
    return `<button class="btn btn-sm btn-primary ipl-join" type="button" data-ipl-join="${esc(l.id)}">${ICON.join}<span>${esc(t("ipl.join.btn"))}</span></button>`;
  }
  const joinSent = new Set();

  const badgeHtml = (l) =>
    `<span class="ipl-badge is-${esc(l.visibility || "public")}">${VIS_ICON[l.visibility] || ICON.globe}<span>${esc(visLabel(l.visibility))}</span></span>`;

  // the line under the name: who may see an exclusive list, how many share a private one
  function audienceHtml(l) {
    if (l.visibility === "exclusive") {
      const parts = criteriaParts(l);
      return parts.length ? `<p class="ipl-aud">${parts.map((p) => `<bdi>${esc(p)}</bdi>`).join(" · ")}</p>` : "";
    }
    if (l.visibility === "private" && Array.isArray(l.people)) {
      const names = l.people.map((p) => `@${p.username || p.id}`);
      return `<p class="ipl-aud">${esc(t("ipl.sharedWith", { n: fmt(names.length) }))} <bdi>${esc(names.slice(0, 6).join(", "))}${names.length > 6 ? "…" : ""}</bdi></p>`;
    }
    return "";
  }

  function kindsHtml(l) {
    const kinds = [
      ["live", l.live],
      ["movie", l.movies ?? l.movie],
      ["series", l.series],
    ].filter(([, n]) => Number(n) > 0);
    if (!kinds.length) return "";
    return `<p class="ipl-kinds">${kinds
      .map(([k, n]) => `<span class="ipl-kind is-${k}">${esc(t(`chan.f.${k}`))} <b>${esc(fmt(n))}</b></span>`)
      .join("")}</p>`;
  }

  // ---------------------------------------------------------------- a list as a card
  // opts: { manage: true (Dashboard: Edit / Refresh / Copy / Delete), owner: false, rank: html (Search.html) }
  // l.locked: why the visitor may not open it yet (a lock; a private one: Request to join)
  function cardHtml(l, opts = {}) {
    const ready = l.ready !== false && Number(l.channels) > 0;
    const lock = lockText(l);
    const owner = opts.owner === false ? "" : `
          <a class="ipl-owner" href="${esc(C.profileHref(l.owner))}">
            <span class="ipl-owner-ava">${C.avatarImg(l.owner_id || "", l.owner || "", l.owner_avatar || "")}</span>
            <bdi>@${esc(l.owner || "")}</bdi>
          </a>`;
    const facts = [
      l.groups ? (Number(l.groups) === 1 ? t("ipl.groupOne") : t("ipl.groupsN", { n: fmt(l.groups) })) : "",
      Number(l.views) === 1 ? t("ipl.viewOne") : t("ipl.viewsN", { n: fmtCount(l.views) }),
      l.updated_at ? t("ipl.updated", { when: timeAgo(l.updated_at) }) : "",
    ].filter(Boolean);
    const manage = opts.manage
      ? `
          <button class="btn btn-sm btn-ghost" type="button" data-ipl-edit="${esc(l.id)}">${esc(t("ipl.edit"))}</button>
          <button class="btn btn-sm btn-ghost" type="button" data-ipl-refresh="${esc(l.id)}">${esc(t("ipl.refresh"))}</button>
          <button class="btn btn-sm btn-ghost" type="button" data-ipl-copy="${esc(l.id)}">${esc(t("ipl.copyLink"))}</button>
          <button class="btn btn-sm btn-danger" type="button" data-ipl-delete="${esc(l.id)}">${esc(t("common.delete"))}</button>`
      : l.mine
        ? `<a class="btn btn-sm btn-ghost" href="${MANAGE_HREF}">${esc(t("ipl.manage"))}</a>`
        : "";
    const extra = opts.manage ? [
      Number(l.requests) > 0 ? `<span class="ipl-badge is-req">${ICON.bell}<span>${esc(t(Number(l.requests) === 1 ? "ipl.reqOne" : "ipl.reqN", { n: fmt(l.requests) }))}</span></span>` : "",
      Number(l.passwords) > 0 ? `<span class="ipl-badge is-pw">${ICON.key}<span>${esc(t(Number(l.passwords) === 1 ? "ipl.pwOne" : "ipl.pwN", { n: fmt(l.passwords) }))}</span></span>` : "",
      l.hidden ? `<span class="ipl-badge is-hidden">${esc(t("ipl.hiddenBadge"))}</span>` : "",
    ].join("") : "";
    const private_ = l.locked === "private";
    return `
      <article class="ipl-card${ready ? "" : " is-waiting"}${lock ? " is-locked" : ""}" data-ipl-id="${esc(l.id)}">
        <a class="ipl-card-main" href="${esc(listHref(l.id))}">
          <span class="ipl-cover" style="--ipl-h:${hueOf(l.id)}" aria-hidden="true">
            ${ICON.tv}
            <b>${esc(fmtCount(l.channels))}</b>
            <small>${esc(t("common.channels"))}</small>
          </span>
          <span class="ipl-card-text">
            <span class="ipl-badges">${badgeHtml(l)}${l.password && !private_ ? `<span class="ipl-badge is-pw">${ICON.key}<span>${esc(t("ipl.crit.password"))}</span></span>` : ""}${l.epg ? `<span class="ipl-badge is-epg">${esc(t("iptv.epg"))}</span>` : ""}${l.mine && !opts.manage ? `<span class="ipl-badge is-mine">${esc(t("ipl.yours"))}</span>` : ""}${extra}</span>
            <h3 dir="auto">${esc(l.name)}</h3>
            ${l.description && !private_ ? `<span class="ipl-desc" dir="auto">${esc(l.description)}</span>` : ""}
          </span>
        </a>
        ${lock ? `<p class="ipl-lock" role="note">${ICON.lock}<span>${esc(lock)}</span></p>` : ""}
        ${private_ ? "" : audienceHtml(l)}
        ${private_ ? "" : kindsHtml(l)}
        ${ready ? "" : `<p class="ipl-warn" role="note">${esc(t("ipl.notReady"))}</p>`}
        ${l.suspended ? `<p class="ipl-warn ipl-susp" role="note"><b>${esc(t("ipl.suspended"))}</b> ${esc(t("vid.suspendedWhy", { reason: l.suspended.reason || "" }))}</p>` : ""}
        <div class="ipl-meta">${owner}<span class="ipl-facts">${facts.map((f) => `<span>${esc(f)}</span>`).join("")}</span></div>
        <footer class="ipl-actions">
          ${private_ ? joinHtml(l) : `<a class="btn btn-sm ${lock ? "btn-ghost" : "btn-primary"}" href="${esc(listHref(l.id))}">${lock ? ICON.lock : ICON.play}<span>${esc(t(lock ? "ipl.openLocked" : "ipl.open"))}</span></a>`}
          ${manage}
          ${opts.rank || ""}
        </footer>
        <div class="ipl-join-slot" data-ipl-join-slot></div>
      </article>`;
  }

  // ---------------------------------------------------------------- Request to join (a private list)
  // -> { ok: true } | { ok: false, reason }
  async function requestJoin(id, note = "") {
    const res = await call("iptv_list_request", { p_member: memberId(), p_id: id, p_note: note });
    if (!res.ok) return { ok: false, reason: res.setup ? "setup" : "network" };
    if (res.data?.ok) joinSent.add(id);
    return res.data || { ok: false, reason: "failed" };
  }
  const joinError = (r) => t({ member: "ipl.join.signin", pending: "ipl.join.pending", already: "ipl.join.already", wait: "ipl.join.wait",
    blocked: "ipl.join.blocked", limit: "ipl.join.limit", not_private: "ipl.join.notPrivate", not_found: "ipl.no.found",
    note: "ipl.join.note", setup: "ipl.err.setup", network: "ipl.err.network" }[r?.reason] || "ipl.err.failed");

  // The buttons Request to join inside root: a note (optional), then Send. onSent(id) once sent.
  function wireJoin(root, onSent) {
    if (!root || root.dataset.iplJoinWired) return;
    root.dataset.iplJoinWired = "1";
    root.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-ipl-join]");
      const card = e.target.closest("[data-ipl-id]");
      if (btn) {
        if (!memberId()) {
          location.href = `./login.html?next=${encodeURIComponent(`${location.pathname.replace(/^\//, "")}${location.search}${location.hash}`)}`;
          return;
        }
        const slot = card?.querySelector("[data-ipl-join-slot]");
        if (!slot) return;
        slot.innerHTML = `
          <form class="ipl-join-form" data-ipl-join-form="${esc(btn.dataset.iplJoin)}">
            <label class="field-label" for="ipl-jn-${esc(btn.dataset.iplJoin)}">${esc(t("ipl.join.noteLabel"))}</label>
            <textarea id="ipl-jn-${esc(btn.dataset.iplJoin)}" rows="2" maxlength="300" placeholder="${esc(t("ipl.join.notePh"))}"></textarea>
            <div class="ipl-join-acts">
              <button class="btn btn-sm btn-primary" type="submit">${esc(t("ipl.join.send"))}</button>
              <button class="btn btn-sm btn-ghost" type="button" data-ipl-join-cancel>${esc(t("common.cancel"))}</button>
            </div>
            <p class="ipl-join-msg" role="status"></p>
          </form>`;
        btn.hidden = true;
        slot.querySelector("textarea").focus();
        return;
      }
      if (e.target.closest("[data-ipl-join-cancel]") && card) {
        card.querySelector("[data-ipl-join-slot]").innerHTML = "";
        const b = card.querySelector("[data-ipl-join]");
        if (b) b.hidden = false;
      }
    });
    root.addEventListener("submit", async (e) => {
      const form = e.target.closest("[data-ipl-join-form]");
      if (!form) return;
      e.preventDefault();
      const id = form.dataset.iplJoinForm;
      const send = form.querySelector('button[type="submit"]');
      send.disabled = true;
      const r = await requestJoin(id, form.querySelector("textarea").value.trim());
      send.disabled = false;
      if (!r.ok) {
        form.querySelector(".ipl-join-msg").textContent = joinError(r);
        return;
      }
      const card = form.closest("[data-ipl-id]");
      const acts = card?.querySelector(".ipl-actions");
      card?.querySelector("[data-ipl-join]")?.remove();
      if (acts) acts.insertAdjacentHTML("afterbegin", `<span class="ipl-join-sent">${ICON.check}<span>${esc(t("ipl.join.sent"))}</span></span>`);
      form.remove();
      C.toast(t("ipl.join.done"));
      onSent?.(id);
    });
  }

  // ---------------------------------------------------------------- a channel found by the search
  function channelHtml(item) {
    const l = item.list || {};
    const logo = /^https?:\/\//i.test(item.logo || "")
      ? `<img src="${esc(item.logo)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()" />`
      : "";
    const kind = ["live", "movie", "series"].includes(item.kind) ? item.kind : "live";
    return `
      <a class="ipl-ch" href="${esc(channelHref(item))}">
        <span class="ipl-ch-logo" style="--ipl-h:${hueOf(l.id)}"><span>${esc(initials(item.name))}</span>${logo}</span>
        <span class="ipl-ch-text">
          <b dir="auto">${esc(item.name)}</b>
          <small><span class="ipl-kind is-${kind}">${esc(t(`chan.type.${kind}`))}</span>${item.group ? ` · <bdi>${esc(item.group)}</bdi>` : ""}</small>
          <small class="ipl-ch-list">${l.visibility === "exclusive" ? badgeHtml(l) : ""}<bdi dir="auto">${esc(l.name || "")}</bdi> · <bdi>@${esc(l.owner || "")}</bdi></small>
        </span>
        <span class="ipl-ch-play" aria-hidden="true">${ICON.play}</span>
      </a>`;
  }

  // ---------------------------------------------------------------- reading a playlist
  // rows shaped like public.listchannels, each with its id on Listchannels.html
  function parse(text) {
    return C.parseM3U(text).map((r) => ({ ...r, id: C.m3uRowId(r) }));
  }

  function summary(rows) {
    const groups = new Set();
    const n = { channels: rows.length, groups: 0, live: 0, movie: 0, series: 0 };
    rows.forEach((r) => {
      groups.add(String(r.group_name || "").trim().toLowerCase() || "general");
      if (r.channel_type === "movie") n.movie += 1;
      else if (r.channel_type === "series") n.series += 1;
      else n.live += 1;
    });
    n.groups = groups.size;
    return n;
  }

  const signature = (rows) => C.cyrb53(rows.map((r) => r.id).join("|"));

  // -> { rows, epg } ; throws Error("read" | "empty")
  async function readPlaylist({ url = "", file = null } = {}) {
    let text = "";
    try {
      text = file ? await file.text() : await C.fetchPlaylistText(url);
    } catch {
      throw new Error("read");
    }
    if (!/#EXTINF/i.test(text)) throw new Error("empty");
    const rows = parse(text);
    if (!rows.length) throw new Error("empty");
    return { rows, epg: C.m3uHeaderEpg(text) };
  }

  // the channels for the search, in parts; onProgress(done, total)
  async function saveChannels(id, rows, { epg = "", onProgress } = {}) {
    const max = Math.min(rows.length, MAX_INDEX);
    const counts = summary(rows);
    const fp = signature(rows);
    let start = 0;
    do {
      const end = Math.min(max, start + CHUNK);
      const done = end >= max;
      const part = rows.slice(start, end).map((r) => ({ n: r.channel_name, g: r.group_name, l: r.logo_url, k: r.channel_type, c: r.id }));
      const res = await call("iptv_list_index", {
        p_member: memberId(),
        p_id: id,
        p_rows: part,
        p_start: start,
        p_done: done,
        p_counts: done ? counts : null,
        p_epg: done ? epg || "" : "",
        p_sig: done ? fp : "",
      });
      if (!res.ok) return res;
      if (res.data?.ok === false) return { ok: false, reason: res.data.reason || "failed" };
      onProgress?.(end, max);
      start = end;
    } while (start < max);
    return { ok: true, counts };
  }

  // read the playlist of a list again and save its channels (Dashboard: "Refresh channels",
  // the publisher's own visit of Listchannels.html when they changed)
  async function refresh(l, opts = {}) {
    let got;
    try {
      got = opts.rows ? { rows: opts.rows, epg: opts.epg || "" } : await readPlaylist({ url: sourceUrl(l) });
    } catch (err) {
      return { ok: false, reason: err.message === "empty" ? "empty" : "read" };
    }
    return saveChannels(l.id, got.rows, { epg: got.epg, onProgress: opts.onProgress });
  }

  // ---------------------------------------------------------------- uploading a file
  function token(n = 20) {
    const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const buf = new Uint32Array(n);
    crypto.getRandomValues(buf);
    return [...buf].map((x) => abc[x % abc.length]).join("");
  }

  // IPTV/Playlist/<member id>-<20 letters>.m3u, a new name for every upload
  // -> { ok: true, path } | { ok: false, reason: member | big | setup | network | failed }
  async function upload(file) {
    const id = memberId();
    if (!/^ID[0-9]{1,20}$/.test(id)) return { ok: false, reason: "member" };
    if (!file || file.size > MAX_FILE) return { ok: false, reason: "big" };
    const path = `${FOLDER}/${id}-${token()}.${/\.m3u8$/i.test(file.name || "") ? "m3u8" : "m3u"}`;
    let res;
    try {
      res = await fetch(`${C.SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
        method: "POST",
        headers: {
          apikey: C.SUPABASE_KEY,
          Authorization: `Bearer ${C.SUPABASE_KEY}`,
          "Content-Type": "audio/x-mpegurl",
          // the name changes with every upload, so the file never needs to be fetched again
          "cache-control": "max-age=86400",
        },
        body: file,
      });
    } catch {
      return { ok: false, reason: "network" };
    }
    if (res.ok) return { ok: true, path };
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* not JSON */
    }
    const message = String(body?.message || body?.error || "");
    const status = Number(body?.statusCode) || res.status;
    let reason = "failed";
    if (status === 413 || /maximum allowed size|too large/i.test(message)) reason = "big";
    else if ([401, 403, 404, 415].includes(status) || /row-level security|bucket not found|mime/i.test(message)) reason = "setup";
    if (reason === "setup") {
      console.warn(`[CineAura] Playlist upload refused (${status} ${message}). Run sql/iptv_lists.sql in the Supabase SQL editor; bucket ${BUCKET} must exist and accept audio/x-mpegurl.`);
    }
    return { ok: false, reason, status, message };
  }

  // ---------------------------------------------------------------- messages
  const ERR = {
    member: "ipl.err.member",
    blocked: "ipl.err.blocked",
    limit: "ipl.err.limit",
    name: "ipl.err.name",
    description: "ipl.err.description",
    url: "ipl.err.url",
    path: "ipl.err.file",
    file: "ipl.err.file",
    nofile: "ipl.err.nofile",
    big: "ipl.err.big",
    type: "ipl.err.type",
    criteria: "ipl.err.criteria",
    people: "ipl.err.people",
    password: "ipl.err.password",
    suspended: "ipl.err.suspended",
    not_found: "ipl.err.notFound",
    read: "ipl.err.read",
    readFile: "ipl.err.readFile",
    empty: "ipl.err.empty",
    setup: "ipl.err.setup",
    uploadSetup: "ipl.err.uploadSetup",
    network: "ipl.err.network",
    failed: "ipl.err.failed",
  };
  function errText(res, fallback = "failed") {
    if (res?.setup) return t(ERR.setup);
    if (res?.network) return t(ERR.network);
    const reason = res?.reason || res?.data?.reason || fallback;
    if (reason === "people" && Array.isArray(res?.bad || res?.data?.bad) && (res.bad || res.data.bad).length) {
      return t("ipl.err.peopleBad", { names: (res.bad || res.data.bad).map((x) => `@${x}`).join(", ") });
    }
    return t(ERR[reason] || ERR.failed);
  }

  // why Listchannels.html?list= does not open a list for this visitor
  function refusalText(r) {
    const reason = r?.reason || "not_found";
    if (reason === "followers") return t("ipl.no.followers", { name: `@${r.owner || ""}` });
    if (reason === "country") return t("ipl.no.country", { list: codes(r.countries).map(countryName).join(", ") });
    if (reason === "language") return t("ipl.no.language", { list: codes(r.languages).map(langName).join(", ") });
    if (reason === "level") return t("ipl.no.level", { level: levelName(r.level), mine: levelName(r.my_level) });
    if (reason === "plan") return t("ipl.no.plan", { plan: planName(r.plan), mine: planName(r.my_plan) });
    if (reason === "password") return t("ipl.no.password");
    if (reason === "signin") return t("ipl.no.signin");
    if (reason === "private") {
      if (r.request === "pending") return t("ipl.no.privatePending", { name: `@${r.owner || ""}` });
      if (r.request === "rejected") return t("ipl.no.privateRejected", { name: `@${r.owner || ""}` });
      return t(r.member === false ? "ipl.no.privateSignin" : "ipl.no.privateAsk", { name: `@${r.owner || ""}` });
    }
    return t("ipl.no.found");
  }

  // ---------------------------------------------------------------- the publish / edit dialog
  let openDialog = null;

  function closeDialog() {
    if (!openDialog) return;
    const { wrap, opener, onKey } = openDialog;
    openDialog = null;
    document.removeEventListener("keydown", onKey, true);
    wrap.remove();
    document.documentElement.classList.remove("ipl-lock");
    if (opener && document.contains(opener)) opener.focus();
  }

  function draftOf(l) {
    return {
      id: l?.id || "",
      name: l?.name || "",
      description: l?.description || "",
      source: l?.source === "upload" ? "upload" : "link",
      url: l?.url || "",
      path: l?.path || "",
      file: null,
      epg: l?.epg_url || "",
      visibility: VIS.includes(l?.visibility) ? l.visibility : "public",
      followers: Boolean(l?.followers),
      countries: codes(l?.countries),
      languages: codes(l?.languages),
      people: Array.isArray(l?.people) ? l.people.map((p) => p.username || p.id).join(", ") : "",
      level: Math.max(0, Math.min(10, Number(l?.level) || 0)),
      plan: ["Silver", "Gold", "Diamond"].includes(l?.plan) ? l.plan : "",
      passwords: "", // new passwords, one a line; empty while editing: the list keeps its own
      pwCount: Number(l?.passwords) || 0,
      pwClear: false,
      hidden: Boolean(l?.hidden),
      ready: l ? l.ready !== false : false,
    };
  }

  function formHtml(d, editing) {
    const field = (id, label, input, hint = "") => `
          <div class="ipl-field">
            <label class="field-label" for="${id}">${esc(label)}</label>
            ${input}
            ${hint ? `<p class="ipl-hint" id="${id}-hint">${esc(hint)}</p>` : ""}
          </div>`;
    const visOpt = (v) => `
            <label class="ipl-vis-opt">
              <input type="radio" name="ipl-vis" value="${v}" ${d.visibility === v ? "checked" : ""} />
              <span><b>${VIS_ICON[v]}${esc(visLabel(v))}</b><small>${esc(t(`ipl.visHint.${v}`))}</small></span>
            </label>`;
    const fileNow = d.path ? `<p class="ipl-hint ipl-file-now">${esc(t("ipl.f.fileNow"))} <bdi dir="ltr">${esc(d.path.split("/").pop())}</bdi></p>` : "";
    return `
      <header class="ipl-dialog-head">
        <div>
          <p class="eyebrow">${esc(t("ipl.eyebrow"))}</p>
          <h2 id="ipl-f-title">${esc(t(editing ? "ipl.f.editTitle" : "ipl.f.title"))}</h2>
        </div>
        <button class="ipl-x" type="button" data-ipl-close aria-label="${esc(t("common.close"))}">${ICON.close}</button>
      </header>
      <div class="ipl-dialog-body" id="ipl-f-body">
        ${field("ipl-name", t("ipl.f.name"), `<input id="ipl-name" maxlength="80" required autocomplete="off" value="${esc(d.name)}" placeholder="${esc(t("ipl.f.namePh"))}" />`)}
        ${field("ipl-desc", t("ipl.f.desc"), `<textarea id="ipl-desc" maxlength="1000" rows="2" placeholder="${esc(t("ipl.f.descPh"))}">${esc(d.description)}</textarea>`)}
        <div class="ipl-field">
          <span class="field-label" id="ipl-src-l">${esc(t("ipl.f.source"))}</span>
          <div class="ipl-seg" role="radiogroup" aria-labelledby="ipl-src-l">
            <label class="ipl-seg-opt"><input type="radio" name="ipl-src" value="link" ${d.source === "link" ? "checked" : ""} /><span>${ICON.link}${esc(t("ipl.f.byLink"))}</span></label>
            <label class="ipl-seg-opt"><input type="radio" name="ipl-src" value="upload" ${d.source === "upload" ? "checked" : ""} /><span>${ICON.upload}${esc(t("ipl.f.byFile"))}</span></label>
          </div>
          <div class="ipl-src-box" data-src="link" ${d.source === "link" ? "" : "hidden"}>
            <input id="ipl-url" type="url" inputmode="url" dir="ltr" maxlength="2000" autocomplete="off" spellcheck="false" value="${esc(d.url)}" placeholder="https://…/playlist.m3u" aria-label="${esc(t("ipl.f.url"))}" />
            <p class="ipl-hint">${esc(t("ipl.f.urlHint"))}</p>
          </div>
          <div class="ipl-src-box" data-src="upload" ${d.source === "upload" ? "" : "hidden"}>
            <label class="ipl-file">
              <input id="ipl-file" type="file" accept=".m3u,.m3u8,audio/x-mpegurl,audio/mpegurl,application/vnd.apple.mpegurl,application/x-mpegurl" />
              <span class="btn btn-sm btn-ghost">${ICON.upload}<span>${esc(t("ipl.f.pick"))}</span></span>
              <span class="ipl-file-name" id="ipl-file-name">${esc(t("ipl.f.noFile"))}</span>
            </label>
            ${fileNow}
            <p class="ipl-hint">${esc(t("ipl.f.fileHint"))}</p>
          </div>
        </div>
        ${field("ipl-epg", t("ipl.f.epg"), `<input id="ipl-epg" type="url" inputmode="url" dir="ltr" maxlength="2000" autocomplete="off" spellcheck="false" value="${esc(d.epg)}" placeholder="https://…/guide.xml" />`, t("ipl.f.epgHint"))}
        <div class="ipl-field">
          <span class="field-label" id="ipl-vis-l">${esc(t("ipl.f.who"))}</span>
          <div class="ipl-vis" role="radiogroup" aria-labelledby="ipl-vis-l">${VIS.map(visOpt).join("")}</div>
          <div class="ipl-aud-box" id="ipl-excl" ${d.visibility === "exclusive" ? "" : "hidden"}>
            <p class="ipl-sub">${esc(t("ipl.f.exclWho"))}</p>
            <label class="ipl-check"><input type="checkbox" id="ipl-fol" ${d.followers ? "checked" : ""} /> <span>${esc(t("vid.f.exclFollowers"))}</span></label>
            <label class="field-label" for="ipl-cty">${esc(t("vid.f.exclCountries"))}</label>
            <div class="ipl-cty">
              <select id="ipl-cty"><option value="">${esc(t("vid.f.exclAddCountry"))}</option>${C.countryChoices().map(([cc, n]) => `<option value="${cc}">${esc(n)}</option>`).join("")}</select>
              <span class="ipl-chips" id="ipl-cty-chips"></span>
            </div>
            <span class="field-label" id="ipl-lang-l">${esc(t("ipl.f.languages"))}</span>
            <div class="ipl-langs" role="group" aria-labelledby="ipl-lang-l">
              ${LANG_CODES.map((c) => `<label class="ipl-check ipl-lang"><input type="checkbox" name="ipl-lang" value="${c}" ${d.languages.includes(c) ? "checked" : ""} /> <span lang="${c}">${esc(langName(c))}</span></label>`).join("")}
            </div>
            <div class="ipl-row2">
              <div class="ipl-field">
                <label class="field-label" for="ipl-level">${esc(t("ipl.f.level"))}</label>
                <select id="ipl-level">${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `<option value="${n}" ${d.level === n ? "selected" : ""}>${esc(n ? t("ipl.crit.level", { level: levelName(n) }) : t("ipl.f.anyLevel"))}</option>`).join("")}</select>
              </div>
              <div class="ipl-field">
                <label class="field-label" for="ipl-plan">${esc(t("ipl.f.plan"))}</label>
                <select id="ipl-plan">${["", "Silver", "Gold", "Diamond"].map((p) => `<option value="${p}" ${d.plan === p ? "selected" : ""}>${esc(p ? t("ipl.crit.plan", { plan: planName(p) }) : t("ipl.f.anyPlan"))}</option>`).join("")}</select>
              </div>
            </div>
            <label class="field-label" for="ipl-pw">${esc(t("ipl.f.passwords"))}</label>
            <textarea id="ipl-pw" rows="2" maxlength="700" dir="ltr" spellcheck="false" autocomplete="off" placeholder="${esc(t("ipl.f.passwordsPh"))}">${esc(d.passwords)}</textarea>
            ${d.pwCount ? `<p class="ipl-hint ipl-pw-now">${esc(t(d.pwCount === 1 ? "ipl.f.pwKeptOne" : "ipl.f.pwKeptN", { n: fmt(d.pwCount) }))}
              <label class="ipl-check ipl-pw-clear"><input type="checkbox" id="ipl-pw-clear" /> <span>${esc(t("ipl.f.pwClear"))}</span></label></p>` : ""}
            <p class="ipl-hint">${esc(t("ipl.f.passwordsHint"))}</p>
            <p class="ipl-hint">${esc(t("ipl.f.exclHint"))}</p>
          </div>
          <div class="ipl-aud-box" id="ipl-priv" ${d.visibility === "private" ? "" : "hidden"}>
            <label class="field-label" for="ipl-people">${esc(t("ipl.f.people"))}</label>
            <textarea id="ipl-people" rows="2" maxlength="4000" dir="ltr" spellcheck="false" placeholder="${esc(t("ipl.f.peoplePh"))}">${esc(d.people)}</textarea>
            <p class="ipl-hint">${esc(t("ipl.f.peopleHint"))}</p>
            <label class="ipl-check"><input type="checkbox" id="ipl-hidden" ${d.hidden ? "checked" : ""} /> <span>${esc(t("ipl.f.hidden"))}</span></label>
            <p class="ipl-hint">${esc(t("ipl.f.hiddenHint"))}</p>
          </div>
        </div>
      </div>
      <div class="ipl-progress" id="ipl-progress" hidden>
        <p id="ipl-step" role="status" aria-live="polite"></p>
        <div class="ipl-bar"><i id="ipl-bar"></i></div>
      </div>
      <p class="ipl-msg" id="ipl-msg" role="alert"></p>
      <footer class="ipl-dialog-foot">
        <button class="btn btn-sm btn-ghost" type="button" data-ipl-close>${esc(t("common.cancel"))}</button>
        <button class="btn btn-sm btn-primary" type="submit" id="ipl-submit">${esc(t(editing ? "common.save" : "ipl.f.publish"))}</button>
      </footer>`;
  }

  // opts: { list (the member's own list, to edit it), onSaved(id, { created }) }
  function openForm(opts = {}) {
    if (!memberId()) {
      location.href = `./login.html?next=${encodeURIComponent(`${location.pathname.replace(/^\//, "")}${location.search}${location.hash}`)}`;
      return;
    }
    closeDialog();
    const editing = Boolean(opts.list?.id);
    const before = draftOf(opts.list);
    const d = draftOf(opts.list);
    const wrap = document.createElement("div");
    wrap.className = "ipl-modal";
    wrap.innerHTML = `<form class="ipl-dialog" role="dialog" aria-modal="true" aria-labelledby="ipl-f-title" novalidate>${formHtml(d, editing)}</form>`;
    document.body.appendChild(wrap);
    document.documentElement.classList.add("ipl-lock");
    const form = wrap.querySelector("form");
    const $ = (sel) => form.querySelector(sel);
    let busy = false;

    const onKey = (e) => {
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        closeDialog();
      } else if (e.key === "Tab") {
        // keep the keyboard inside the dialog
        const items = [...form.querySelectorAll("input, select, textarea, button, a[href]")].filter((el) => !el.disabled && el.offsetParent !== null);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    openDialog = { wrap, opener: document.activeElement, onKey };

    const msg = (text, ok = false) => {
      const el = $("#ipl-msg");
      el.textContent = text || "";
      el.classList.toggle("ok", Boolean(ok && text));
    };
    const step = (text, done = null, total = null) => {
      $("#ipl-progress").hidden = !text;
      $("#ipl-step").textContent = text || "";
      $("#ipl-bar").style.width = total ? `${Math.round((done / total) * 100)}%` : text ? "8%" : "0";
    };
    const setBusy = (on) => {
      busy = on;
      form.classList.toggle("is-busy", on);
      form.querySelectorAll("input, select, textarea, button").forEach((el) => {
        if (el.matches("[data-ipl-close].ipl-x")) return;
        el.disabled = on;
      });
    };

    // --- countries
    const drawCountries = () => {
      $("#ipl-cty-chips").innerHTML = d.countries
        .map((cc) => `<span class="ipl-chip">${esc(countryName(cc))}<button type="button" data-uncty="${esc(cc)}" aria-label="${esc(t("rich.remove"))} ${esc(countryName(cc))}">×</button></span>`)
        .join("");
    };
    drawCountries();
    $("#ipl-cty").addEventListener("change", (e) => {
      const cc = e.target.value;
      if (cc && !d.countries.includes(cc)) d.countries.push(cc);
      e.target.value = "";
      drawCountries();
    });
    $("#ipl-cty-chips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-uncty]");
      if (!b) return;
      d.countries = d.countries.filter((x) => x !== b.dataset.uncty);
      drawCountries();
    });

    // --- the parts that show / hide
    const read = () => {
      d.name = $("#ipl-name").value.trim();
      d.description = $("#ipl-desc").value.trim();
      d.source = form.querySelector('input[name="ipl-src"]:checked')?.value === "upload" ? "upload" : "link";
      d.url = $("#ipl-url").value.trim();
      d.file = $("#ipl-file").files?.[0] || null;
      d.epg = $("#ipl-epg").value.trim();
      d.visibility = form.querySelector('input[name="ipl-vis"]:checked')?.value || "public";
      d.followers = $("#ipl-fol").checked;
      d.languages = [...form.querySelectorAll('input[name="ipl-lang"]:checked')].map((x) => x.value);
      d.people = $("#ipl-people").value;
      d.level = Number($("#ipl-level").value) || 0;
      d.plan = $("#ipl-plan").value;
      d.passwords = $("#ipl-pw").value;
      d.pwClear = Boolean($("#ipl-pw-clear")?.checked);
      d.hidden = $("#ipl-hidden").checked;
    };
    const sync = () => {
      read();
      form.querySelectorAll(".ipl-src-box").forEach((box) => {
        box.hidden = box.dataset.src !== d.source;
      });
      $("#ipl-excl").hidden = d.visibility !== "exclusive";
      $("#ipl-priv").hidden = d.visibility !== "private";
      $("#ipl-file-name").textContent = d.file ? `${d.file.name} · ${fmt(Math.ceil(d.file.size / 1024))} KB` : t("ipl.f.noFile");
    };
    form.addEventListener("change", sync);
    form.addEventListener("input", (e) => {
      if (e.target.matches("#ipl-name, #ipl-url, #ipl-people")) msg("");
    });
    form.addEventListener("click", (e) => {
      if (e.target.closest("[data-ipl-close]") && !busy) closeDialog();
    });
    // a click outside the dialog closes it while nothing is typed
    wrap.addEventListener("mousedown", (e) => {
      if (e.target !== wrap || busy) return;
      read();
      const untouched = d.name === before.name && d.url === before.url && !d.file && d.description === before.description;
      if (untouched) closeDialog();
    });

    const fail = (text, focus) => {
      msg(text);
      step("");
      setBusy(false);
      if (focus) $(focus)?.focus();
      return null;
    };

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (busy) return;
      read();
      msg("");
      // --- checks before anything is sent
      if (!d.name) return fail(t(ERR.name), "#ipl-name");
      if (d.source === "link" && !/^https?:\/\/[^\s/?#]+[^\s<>"`]*$/i.test(d.url)) return fail(t(ERR.url), "#ipl-url");
      if (d.source === "upload") {
        if (!d.file && !d.path) return fail(t(ERR.nofile), "#ipl-file");
        if (d.file && d.file.size > MAX_FILE) return fail(t(ERR.big), "#ipl-file");
        if (d.file && d.file.name && !/\.(m3u8?|txt)$/i.test(d.file.name)) return fail(t(ERR.type), "#ipl-file");
      }
      if (d.epg && !/^https?:\/\/[^\s/?#]+/i.test(d.epg)) return fail(t("ipl.err.epg"), "#ipl-epg");
      const pws = [...new Set(d.passwords.split(/\n+/).map((x) => x.trim()).filter(Boolean))];
      if (pws.length > 10 || pws.some((x) => x.length < 4 || x.length > 64)) return fail(t(ERR.password), "#ipl-pw");
      const keepPw = editing && !pws.length && !d.pwClear;
      const anyPw = pws.length > 0 || (keepPw && d.pwCount > 0);
      if (d.visibility === "exclusive" && !d.followers && !d.countries.length && !d.languages.length && !d.level && !d.plan && !anyPw) return fail(t(ERR.criteria), "#ipl-fol");
      const people = d.people.split(/[,;\s]+/).map((x) => x.trim().replace(/^@+/, "")).filter(Boolean);
      if (d.visibility === "private" && !people.length) return fail(t(ERR.people), "#ipl-people");

      setBusy(true);
      // --- 1. the playlist is read (again only when it changed, or never gave channels)
      const sourceChanged =
        !editing || d.source !== before.source || (d.source === "link" ? d.url !== before.url : Boolean(d.file)) || !before.ready;
      let got = null;
      if (sourceChanged) {
        step(t("ipl.step.read"));
        try {
          got = await readPlaylist(d.source === "upload" ? (d.file ? { file: d.file } : { url: publicUrl(d.path) }) : { url: d.url });
        } catch (err) {
          const why = err.message === "empty" ? "empty" : d.source === "upload" && d.file ? "readFile" : "read";
          return fail(t(ERR[why]), d.source === "link" ? "#ipl-url" : "#ipl-file");
        }
        const n = summary(got.rows);
        step(t("ipl.step.found", { n: fmt(n.channels), g: fmt(n.groups) }), 1, 4);
        if (!d.epg && got.epg) {
          d.epg = got.epg;
          $("#ipl-epg").value = got.epg;
        }
      }
      // --- 2. a picked file goes to Storage (IPTV/Playlist)
      let path = d.path;
      if (d.source === "upload" && d.file) {
        step(t("ipl.step.upload"), 1, 4);
        const up = await upload(d.file);
        if (!up.ok) return fail(t(up.reason === "setup" ? ERR.uploadSetup : ERR[up.reason] || ERR.failed));
        path = up.path;
      }
      // --- 3. the list
      step(t("ipl.step.save"), 2, 4);
      const res = await call("iptv_list_save", {
        p_member: memberId(),
        d: {
          id: d.id || undefined,
          name: d.name,
          description: d.description,
          source: d.source,
          url: d.source === "link" ? d.url : "",
          path: d.source === "upload" ? path : "",
          epg: d.epg,
          visibility: d.visibility,
          followers: d.followers,
          countries: d.countries,
          languages: d.languages,
          level: d.level,
          plan: d.plan,
          // left out while editing with nothing typed: the list keeps its passwords
          ...(keepPw ? {} : { passwords: pws }),
          people,
          hidden: d.hidden,
        },
      });
      if (!res.ok || res.data?.ok === false) {
        const r = res.ok ? res.data : res;
        const focus = { name: "#ipl-name", url: "#ipl-url", people: "#ipl-people", criteria: "#ipl-fol", password: "#ipl-pw", file: "#ipl-file", path: "#ipl-file" }[r?.reason];
        return fail(errText(r), focus);
      }
      const id = res.data.id;
      d.id = id;
      // --- 4. its channels, for the search
      if (got) {
        const total = Math.min(got.rows.length, MAX_INDEX);
        step(t("ipl.step.channels", { done: fmt(0), total: fmt(total) }), 3, 4);
        const saved = await saveChannels(id, got.rows, {
          epg: got.epg,
          onProgress: (done, max) => step(t("ipl.step.channels", { done: fmt(done), total: fmt(max) }), 3 + done / Math.max(1, max), 4),
        });
        if (!saved.ok) {
          setBusy(false);
          step("");
          C.toast(t("ipl.savedNoChannels"));
          closeDialog();
          opts.onSaved?.(id, { created: Boolean(res.data.created), channels: false });
          return null;
        }
      }
      step(t("ipl.step.done"), 4, 4);
      setBusy(false);
      C.toast(t(editing ? "ipl.saved" : "ipl.published"));
      closeDialog();
      opts.onSaved?.(id, { created: Boolean(res.data.created), channels: true });
      return null;
    });

    $("#ipl-name").focus();
    return wrap;
  }

  window.CineAuraIptvLists = {
    VIS,
    LANG_CODES,
    MAX_FILE,
    MAX_INDEX,
    MANAGE_HREF,
    ICON,
    call,
    memberId,
    publicUrl,
    sourceUrl,
    listHref,
    channelHref,
    fmt,
    fmtCount,
    timeAgo,
    langName,
    countryName,
    visLabel,
    hueOf,
    criteriaParts,
    badgeHtml,
    cardHtml,
    channelHtml,
    parse,
    summary,
    signature,
    readPlaylist,
    saveChannels,
    refresh,
    upload,
    errText,
    refusalText,
    lockText,
    levelName,
    planName,
    requestJoin,
    joinError,
    wireJoin,
    openForm,
    closeForm: closeDialog,
  };
})();
