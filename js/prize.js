/* CineAura prizes
   - prize.html            : the catalog. Search and filters (date / availability / points /
                             country / age) first, then most popular / recent / categories
   - prize.html?GroupPrize=ID                 : the prizes of one category
   - prize.html?GroupPrize=ID&Prize=ID        : one prize (carousel, video, terms, subscribe, countdown)
   - index.html (#home-top-prizes)            : the 20 most popular prizes (most subscribers)
   - index.html (#home-prizes)                : "Available prizes" strip on the home page
     Prize cards with the required points open a dialog with one tab per subscription mode
     (gift / challenge / lottery): conditions, subscribe, participants, winners and competitors.
   Data: prize_groups, prizes, prize_entries (see sql/prize_center.sql) and
   prize_modes, prize_mode_entries, winners (see sql/prize_modes.sql). Without the mode tables
   every prize falls back to a single gift mode built from its own row. */
(() => {
  const C = window.CineAura;
  if (!C) return;
  const R = window.PrizeRules;
  const { $, t, tr, escapeHtml, supabaseRequest, getSession, restValue, toast, formatDate, initialsAvatar, profilesByIds, avatarImg } = C;

  const PAGE = "./Prize.html";
  const state = {
    groups: [],
    prizes: [],
    counts: {},
    mine: new Set(),
    winners: [],
    entryRows: [],
    schemaOk: true,
    entriesOk: true,
    ctx: null, // signed-in member data used for the conditions check
  };
  let timer = null;

  // ---------- small helpers ----------
  const safeUrl = (u) => (/^https?:\/\//i.test(String(u || "").trim()) ? String(u).trim() : "");
  const lines = (text) => String(text || "").split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
  const csv = (text) => String(text || "").toLowerCase().split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
  const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

  const prizeHref = (p) => `${PAGE}?GroupPrize=${p.group_id ?? 0}&Prize=${p.id}`;
  const groupHref = (g) => `${PAGE}?GroupPrize=${g.id}`;

  const startMs = (p) => (p.starts_at ? Date.parse(p.starts_at) || 0 : 0);
  // The end date is inclusive: a prize ending on the 10th stays open for the whole day.
  const endMs = (p) => (p.unlimited_time || !p.ends_at ? null : (Date.parse(p.ends_at) || 0) + 86400000);
  const statusOf = (p, now = Date.now()) => {
    if (String(p.status || "").toLowerCase() === "ended") return "ended"; // ended by the staff
    if (startMs(p) > now) return "upcoming";
    const end = endMs(p);
    if (end !== null && end <= now) return "ended";
    return "open";
  };

  const gallery = (p) => {
    const g = state.groups.find((x) => x.id === p.group_id);
    const list = [p.prize_image, ...lines(p.images)].map(safeUrl).filter(Boolean);
    const uniq = [...new Set(list)];
    if (!uniq.length && g?.thumb && safeUrl(g.thumb)) uniq.push(safeUrl(g.thumb));
    return uniq;
  };
  const coverOf = (p) => gallery(p)[0] || initialsAvatar(p.title);

  const sess = () => getSession();
  const countOf = (p) => state.counts[p.id] || 0;
  const addedAt = (p) => Date.parse(p.created_at || "") || 0;

  // ?GroupPrize=ID&Prize=ID (names are matched case-insensitively)
  function urlParams() {
    const sp = new URLSearchParams(location.search);
    const get = (name) => {
      for (const [k, v] of sp) if (k.toLowerCase() === name) return v;
      return "";
    };
    return { group: get("groupprize"), prize: get("prize"), mode: get("mode").toLowerCase() };
  }

  // ---------- data ----------
  async function fetchAllIds(path) {
    // PostgREST returns at most 1000 rows per request, so page through it.
    const rows = [];
    for (let from = 0; from < 20000; from += 1000) {
      const res = await supabaseRequest(`${path}&limit=1000&offset=${from}`);
      if (!res.ok || !Array.isArray(res.data)) return from === 0 ? null : rows;
      rows.push(...res.data);
      if (res.data.length < 1000) break;
    }
    return rows;
  }

  async function loadCatalog() {
    const [g, p, e] = await Promise.all([
      supabaseRequest("/rest/v1/prize_groups?select=*&order=sort_order.asc,id.asc"),
      supabaseRequest("/rest/v1/prizes?select=*&order=id.desc"),
      fetchAllIds("/rest/v1/prize_entries?select=prize_id,member_id&order=id.asc"),
    ]);
    state.schemaOk = g.ok && Array.isArray(g.data) && p.ok && Array.isArray(p.data);
    state.groups = g.ok && Array.isArray(g.data) ? g.data : [];
    state.prizes = p.ok && Array.isArray(p.data) ? p.data : [];
    state.entriesOk = Array.isArray(e);
    state.entryRows = Array.isArray(e) ? e : [];
    state.counts = {};
    (e || []).forEach((r) => {
      state.counts[r.prize_id] = (state.counts[r.prize_id] || 0) + 1;
    });
    state.mine = new Set();
    state.winners = [];
    const id = sess()?.member_id;
    if (id) {
      const [mine, wins] = await Promise.all([
        state.entriesOk
          ? supabaseRequest(`/rest/v1/prize_entries?member_id=eq.${restValue(id)}&select=prize_id`)
          : Promise.resolve({ ok: false, data: null }),
        supabaseRequest(`/rest/v1/winners?member_id=eq.${restValue(id)}&select=*`),
      ]);
      if (mine.ok && Array.isArray(mine.data)) state.mine = new Set(mine.data.map((r) => r.prize_id));
      if (wins.ok && Array.isArray(wins.data)) state.winners = wins.data;
    }
  }

  async function loadMemberContext() {
    state.ctx = null;
    const id = sess()?.member_id;
    if (!id) return;
    const [m, pr, h] = await Promise.all([
      supabaseRequest(`/rest/v1/members?member_id=eq.${restValue(id)}&select=*`),
      supabaseRequest(`/rest/v1/profiles?member_id=eq.${restValue(id)}&select=*`),
      supabaseRequest(`/rest/v1/hestory?visitor_id=eq.${restValue(id)}&select=tmdb_id,media_type`),
    ]);
    const member = m.ok && Array.isArray(m.data) ? m.data[0] : null;
    if (!member) return;
    const profile = pr.ok && Array.isArray(pr.data) ? pr.data[0] || {} : {};
    const birth = member.birth_date ? new Date(member.birth_date) : null;
    let age = null;
    if (birth && !Number.isNaN(birth.getTime())) {
      const now = new Date();
      age = now.getFullYear() - birth.getFullYear();
      if (now.getMonth() < birth.getMonth() || (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate())) age -= 1;
    }
    state.ctx = {
      member,
      active: C.normalizeAccountStatus(member.status) === "active",
      age,
      country: String(profile.country || member.country || "").toLowerCase(),
      minutes: Number(profile.private_minutes || 0) + Number(profile.public_minutes || 0),
      privMin: Number(profile.private_minutes || 0),
      pubMin: Number(profile.public_minutes || 0),
      seen: new Set(((h.ok && h.data) || []).map((r) => `${r.media_type}:${r.tmdb_id}`)),
      username: String(member.username || "").toLowerCase(),
      memberId: String(member.member_id || "").toLowerCase(),
    };
    // Points are earned from five sources — watch minutes, successful link
    // referrals, playlists, recommendations and comments — each at its own rate.
    const mp = await C.memberPoints(id, profile);
    state.ctx.points = mp.available;
    state.ctx.pointsEarned = mp.earned;
    state.ctx.pointsSpent = mp.spent;
    state.ctx.pointsView = mp;
  }

  // ---------- visibility & conditions ----------
  const isPrivate = (p) => String(p.visibility || "public").toLowerCase() === "private";
  const isExclusive = (p) => String(p.visibility || "public").toLowerCase() === "exclusive";

  function allowedPrivate(p) {
    const s = sess();
    if (!s) return false;
    const names = csv(p.allowed_usernames);
    return names.includes(String(s.username || "").toLowerCase()) || names.includes(String(s.member_id || "").toLowerCase());
  }

  function groupVisible(p) {
    if (p.group_id === null || p.group_id === undefined) return true;
    const g = state.groups.find((x) => x.id === p.group_id);
    return g ? g.visible !== false : true;
  }

  const canSee = (p) => groupVisible(p) && (!isPrivate(p) || allowedPrivate(p));

  // Returns one row per condition: ok = true / false, or null while the visitor is signed out.
  function conditionRows(p) {
    const c = state.ctx;
    const rows = [];
    const mark = (ok) => (c ? ok : null);
    const need = Number(p.minutes_required || 0);
    if (need > 0) rows.push({ ok: mark(c ? c.minutes >= need : false), text: t("prize.cond.minutes", { n: need, have: c ? c.minutes : 0 }) });
    if (isPrivate(p)) rows.push({ ok: mark(allowedPrivate(p)), text: t("prize.cond.private") });
    if (isExclusive(p)) {
      const countries = csv(p.countries);
      if (countries.length) rows.push({ ok: mark(c ? countries.includes(c.country) : false), text: t("prize.cond.country", { list: countries.map((x) => x.toUpperCase()).join(", ") }) });
      const lo = num(p.min_age);
      const hi = num(p.max_age);
      if (lo || hi) {
        const range = lo && hi ? `${lo}–${hi}` : lo ? `${lo}+` : `≤ ${hi}`;
        const ok = c ? c.age !== null && (!lo || c.age >= lo) && (!hi || c.age <= hi) : false;
        rows.push({ ok: mark(ok), text: t("prize.cond.age", { range }) });
      }
      if (p.watched_tmdb && p.watched_type) {
        const kind = p.watched_type === "tv" ? t("common.series") : t("common.movie");
        rows.push({ ok: mark(c ? c.seen.has(`${p.watched_type}:${p.watched_tmdb}`) : false), text: t("prize.cond.watched", { type: kind, id: p.watched_tmdb }) });
      }
    }
    return rows;
  }

  const eligible = (p) => Boolean(state.ctx?.active) && conditionRows(p).every((r) => r.ok !== false);

  // ---------- video & carousel ----------
  function videoHtml(raw) {
    let url = String(raw || "").trim();
    const iframeSrc = url.match(/<iframe[^>]+src=["']([^"']+)["']/i);
    if (iframeSrc) url = iframeSrc[1];
    url = safeUrl(url.startsWith("//") ? `https:${url}` : url);
    if (!url) return "";
    let u;
    try {
      u = new URL(url);
    } catch {
      return "";
    }
    const host = u.hostname.replace(/^www\./, "");
    let embed = "";
    if (host === "youtu.be") embed = `https://www.youtube-nocookie.com/embed/${u.pathname.slice(1)}`;
    else if (/(^|\.)youtube(-nocookie)?\.com$/.test(host)) {
      const m = u.pathname.match(/^\/(embed|shorts|live)\/([\w-]+)/);
      const id = m ? m[2] : u.searchParams.get("v");
      if (id) embed = `https://www.youtube-nocookie.com/embed/${id}`;
    } else if (host === "vimeo.com") {
      const m = u.pathname.match(/(\d+)/);
      if (m) embed = `https://player.vimeo.com/video/${m[1]}`;
    } else if (host.endsWith("dailymotion.com")) {
      const m = u.pathname.match(/video\/([\w]+)/);
      if (m) embed = `https://www.dailymotion.com/embed/video/${m[1]}`;
    }
    if (!embed && /\.(mp4|webm|ogv|ogg)$/i.test(u.pathname)) {
      return `<div class="pz-video"><video controls preload="metadata" src="${escapeHtml(url)}"></video></div>`;
    }
    const src = embed || url;
    return `<div class="pz-video"><iframe src="${escapeHtml(src)}" title="${escapeHtml(t("prize.video"))}" loading="lazy" allowfullscreen allow="accelerometer; autoplay; encrypted-media; fullscreen; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"></iframe></div>`;
  }

  function carouselHtml(images, title) {
    if (!images.length) return "";
    const multi = images.length > 1;
    return `
      <div class="pz-carousel" data-carousel role="region" aria-label="${escapeHtml(t("prize.photos"))}">
        <div class="pz-track" tabindex="0">
          ${images.map((src, i) => `<figure class="pz-slide"><img src="${escapeHtml(src)}" alt="${escapeHtml(title)} ${i + 1}" ${i ? 'loading="lazy"' : ""} /></figure>`).join("")}
        </div>
        ${multi ? `
        <button type="button" class="pz-arrow pz-prev" data-dir="-1" aria-label="${escapeHtml(t("prize.prevImg"))}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>
        <button type="button" class="pz-arrow pz-next" data-dir="1" aria-label="${escapeHtml(t("prize.nextImg"))}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg></button>
        <div class="pz-dots">${images.map((_, i) => `<button type="button" data-dot="${i}" aria-label="${i + 1}" class="${i ? "" : "on"}"></button>`).join("")}</div>` : ""}
      </div>`;
  }

  function bindCarousel(root) {
    const box = root.querySelector("[data-carousel]");
    if (!box) return;
    const track = box.querySelector(".pz-track");
    const dots = [...box.querySelectorAll("[data-dot]")];
    const rtl = () => (document.documentElement.dir === "rtl" ? -1 : 1);
    const index = () => Math.round(Math.abs(track.scrollLeft) / Math.max(1, track.clientWidth));
    const go = (i) => {
      const max = track.children.length - 1;
      const n = Math.max(0, Math.min(max, i));
      track.scrollTo({ left: rtl() * n * track.clientWidth, behavior: "smooth" });
    };
    box.querySelectorAll("[data-dir]").forEach((b) => {
      b.addEventListener("click", () => go(index() + Number(b.dataset.dir)));
    });
    dots.forEach((d) => d.addEventListener("click", () => go(Number(d.dataset.dot))));
    track.addEventListener("scroll", () => {
      const i = index();
      dots.forEach((d, k) => d.classList.toggle("on", k === i));
    }, { passive: true });
    track.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") go(index() + rtl());
      if (e.key === "ArrowLeft") go(index() - rtl());
    });
  }

  // ---------- countdown ----------
  const pad = (n) => String(n).padStart(2, "0");

  function countdownHtml(target, label) {
    return `
      <div class="pz-count" data-countdown="${target}">
        <span class="pz-count-label">${escapeHtml(label)}</span>
        <div class="pz-count-grid">
          <div><b data-u="d">00</b><span>${t("prize.days")}</span></div>
          <div><b data-u="h">00</b><span>${t("prize.hours")}</span></div>
          <div><b data-u="m">00</b><span>${t("prize.minutes")}</span></div>
          <div><b data-u="s">00</b><span>${t("prize.seconds")}</span></div>
        </div>
      </div>`;
  }

  function startCountdown(root, onDone) {
    clearInterval(timer);
    const el = root.querySelector("[data-countdown]");
    if (!el) return;
    const target = Number(el.dataset.countdown);
    const tick = () => {
      const left = Math.max(0, target - Date.now());
      const d = Math.floor(left / 86400000);
      const h = Math.floor((left % 86400000) / 3600000);
      const m = Math.floor((left % 3600000) / 60000);
      const s = Math.floor((left % 60000) / 1000);
      const set = (u, v) => {
        const n = el.querySelector(`[data-u="${u}"]`);
        if (n) n.textContent = pad(v);
      };
      set("d", d);
      set("h", h);
      set("m", m);
      set("s", s);
      if (left <= 0) {
        clearInterval(timer);
        onDone?.();
      }
    };
    tick();
    timer = setInterval(tick, 1000);
  }

  // ---------- cards ----------
  function cardHtml(p, opts = {}) {
    const st = statusOf(p);
    const end = endMs(p);
    const g = state.groups.find((x) => x.id === p.group_id);
    const n = countOf(p);
    const badge = st === "ended" ? `<span class="pz-badge ended">${t("prize.ended")}</span>` : st === "upcoming" ? `<span class="pz-badge soon">${t("prize.soon")}</span>` : "";
    return `
      <a class="pz-card glass" href="${prizeHref(p)}">
        <span class="pz-card-img"><img src="${escapeHtml(coverOf(p))}" alt="" loading="lazy" />${badge}</span>
        <span class="pz-card-body">
          ${g && !opts.hideGroup ? `<small class="pz-card-group">${escapeHtml(g.name)}</small>` : ""}
          <strong>${escapeHtml(p.title)}</strong>
          <span class="pz-card-meta">
            <span>${t("prize.subscribers", { n })}</span>
            <span>${end === null ? t("prize.noEnd") : `${t("prize.ends")} ${escapeHtml(formatDate(p.ends_at))}`}</span>
          </span>
        </span>
      </a>`;
  }

  const gridHtml = (list, opts) => `<div class="pz-grid">${list.map((p) => cardHtml(p, opts)).join("")}</div>`;

  const openList = () => state.prizes.filter((p) => canSee(p) && statusOf(p) === "open");
  const popularOrder = (a, b) => countOf(b) - countOf(a) || addedAt(b) - addedAt(a) || b.id - a.id;
  const recentOrder = (a, b) => addedAt(b) - addedAt(a) || b.id - a.id;

  // ---------- pages ----------
  function section(title, body, extra = "") {
    return `<section class="pz-section"><div class="pz-head"><h2>${escapeHtml(title)}</h2>${extra}</div>${body}</section>`;
  }

  // The search box of the catalog. It used to sit on the home page; the markup, ids and
  // wiring (bindCenter / drawCenter) are the same, so the styles and the dialog work unchanged.
  function catalogHtml() {
    const ph = (k) => escapeHtml(t(k));
    return `
      <section class="pz-catalog">
        <p class="muted pz-catalog-lead">${ph("prize.homeLead")}</p>
        <div class="pz-center glass" id="pz-center">
          <div class="pz-toolbar" id="pz-toolbar">
            <label class="pz-field pz-field-search">
              <span class="pz-field-label">${ph("nav.search")}</span>
              <input id="pz-q" type="search" autocomplete="off" placeholder="${ph("prize.searchPh")}" />
            </label>
            <label class="pz-field">
              <span class="pz-field-label">${ph("prize.filterStatus")}</span>
              <select id="pz-f-status">
                <option value="all">${ph("prize.filterAll")}</option>
                <option value="open">${ph("prize.filterOpen")}</option>
                <option value="upcoming">${ph("prize.soon")}</option>
                <option value="ended">${ph("prize.ended")}</option>
              </select>
            </label>
            <label class="pz-field">
              <span class="pz-field-label">${ph("prize.filterFrom")}</span>
              <input id="pz-f-from" type="date" />
            </label>
            <label class="pz-field">
              <span class="pz-field-label">${ph("prize.filterTo")}</span>
              <input id="pz-f-to" type="date" />
            </label>
            <label class="pz-field">
              <span class="pz-field-label">${ph("prize.filterMinPoints")}</span>
              <input id="pz-f-min" type="number" min="0" inputmode="numeric" placeholder="${ph("prize.filterMinPoints")}" />
            </label>
            <label class="pz-field">
              <span class="pz-field-label">${ph("prize.filterMaxPoints")}</span>
              <input id="pz-f-max" type="number" min="0" inputmode="numeric" placeholder="${ph("prize.filterMaxPoints")}" />
            </label>
            <label class="pz-field" id="pz-f-country-wrap" hidden>
              <span class="pz-field-label">${ph("prize.filterCountry")}</span>
              <select id="pz-f-country">
                <option value="">${ph("prize.filterAllCountries")}</option>
              </select>
            </label>
            <label class="pz-field">
              <span class="pz-field-label">${ph("prize.filterAge")}</span>
              <input id="pz-f-age" type="number" min="1" max="120" inputmode="numeric" placeholder="${ph("prize.filterAge")}" />
            </label>
            <div class="pz-field pz-field-reset">
              <button class="btn btn-sm btn-ghost" id="pz-f-reset" type="button">${ph("prize.filterReset")}</button>
            </div>
          </div>
          <div class="pz-toolbar-meta">
            <span id="pz-count"></span>
            <span class="pz-legend">
              <span class="pz-legend-item"><i class="pz-chip gift"></i><span>${ph("prize.mode.gift")}</span></span>
              <span class="pz-legend-item"><i class="pz-chip challenge"></i><span>${ph("prize.mode.challenge")}</span></span>
              <span class="pz-legend-item"><i class="pz-chip lottery"></i><span>${ph("prize.mode.lottery")}</span></span>
            </span>
          </div>
          <div id="pz-results"><div class="loader" style="display:grid"><div class="spinner"></div></div></div>
        </div>
      </section>`;
  }

  function overviewHtml() {
    const open = openList();
    const popular = open.filter((p) => countOf(p) > 0).sort(popularOrder).slice(0, 8);
    const recent = [...open].sort(recentOrder).slice(0, 8);
    const groups = state.groups
      .filter((g) => g.visible !== false)
      .map((g) => ({ g, n: state.prizes.filter((p) => p.group_id === g.id && canSee(p) && statusOf(p) !== "ended").length }));
    const groupCards = groups.length
      ? `<div class="pz-groups">${groups.map(({ g, n }) => `
          <a class="pz-group glass" href="${groupHref(g)}">
            <img src="${escapeHtml(safeUrl(g.thumb) || initialsAvatar(g.name))}" alt="" loading="lazy" />
            <span><strong>${escapeHtml(g.name)}</strong><small>${t("prize.nPrizes", { n })}</small></span>
          </a>`).join("")}</div>`
      : `<p class="empty">${t("prize.noGroups")}</p>`;
    return `
      ${catalogHtml()}
      ${popular.length ? section(t("prize.popular"), gridHtml(popular)) : ""}
      ${section(t("prize.recent"), recent.length ? gridHtml(recent) : `<p class="empty">${t("prize.noPrizes")}</p>`)}
      ${section(t("prize.categories"), groupCards)}`;
  }

  function groupHtml(id) {
    const g = state.groups.find((x) => String(x.id) === String(id));
    if (!g || g.visible === false) return `<p class="empty">${t("prize.groupNotFound")}</p><a class="btn btn-sm btn-ghost" href="${PAGE}">${t("prize.back")}</a>`;
    const rank = { open: 0, upcoming: 1, ended: 2 };
    const list = state.prizes
      .filter((p) => p.group_id === g.id && canSee(p))
      .sort((a, b) => rank[statusOf(a)] - rank[statusOf(b)] || recentOrder(a, b));
    return `
      <a class="pz-back" href="${PAGE}">‹ ${t("prize.back")}</a>
      <div class="pz-group-hero glass">
        <img src="${escapeHtml(safeUrl(g.thumb) || initialsAvatar(g.name))}" alt="" />
        <div><span class="eyebrow">${t("prize.category")}</span><h1>${escapeHtml(g.name)}</h1><p class="muted">${t("prize.nPrizes", { n: list.length })}</p></div>
      </div>
      ${list.length ? gridHtml(list, { hideGroup: true }) : `<p class="empty">${t("prize.noPrizes")}</p>`}`;
  }

  function lockReason(p) {
    if (!sess()?.member_id || !state.ctx) return t("prize.signinNeeded");
    const st = statusOf(p);
    if (st === "ended") return t("prize.closed");
    if (st === "upcoming") return t("prize.notStarted");
    return t("prize.notEligible");
  }

  function actionHtml(p) {
    const st = statusOf(p);
    const cost = Math.max(0, Number(p.minutes_required || 0));
    const points = Number(state.ctx?.points || 0);
    const winner = state.winners.find((w) => String(w.prize_title || "") === String(p.title || ""));
    const claimed = Boolean(winner);
    const claimRequested = Boolean(winner?.claim_requested_at);
    const soldOut = p.quantity != null && Number(p.winners_count || 0) >= Number(p.quantity);
    const can = st === "open" && !claimed && !soldOut && eligible(p) && points >= cost;
    let btn;
    if (claimed) {
      btn = `<button class="btn btn-lg btn-primary pz-sub is-done" type="button" disabled>✓ ${escapeHtml(claimRequested ? t("prize.claimRequested") : t("prize.status.winner"))}</button>`;
    } else if (can) {
      btn = `<button class="btn btn-lg btn-primary pz-sub" type="button" data-claim-simple>${escapeHtml(t("prize.claim"))} · ${escapeHtml(t("prize.points", { n: cost }))}</button>`;
    } else {
      btn = `<button class="btn btn-lg btn-primary pz-sub is-locked" type="button" aria-disabled="true" data-locked>${escapeHtml(t("prize.claim"))}</button>`;
    }
    let reason = "";
    if (claimed && claimRequested) reason = t("prize.claimRequestSent");
    else if (!claimed && !can) {
      if (soldOut) reason = t("prize.soldOut");
      else if (st === "open" && eligible(p) && points < cost) reason = t("prize.needPoints", { need: cost, have: points });
      else reason = lockReason(p);
    }
    const end = endMs(p);
    let timerBlock = "";
    if (st === "upcoming") timerBlock = countdownHtml(startMs(p), t("prize.startsIn"));
    else if (st === "open" && end !== null) timerBlock = countdownHtml(end, t("prize.endsIn"));
    else if (st === "ended") timerBlock = `<p class="pz-ended">${t("prize.closed")}</p>`;
    const need = num(p.subscribers_needed);
    const n = countOf(p);
    const pct = need ? Math.min(100, Math.round((n / need) * 100)) : 0;
    const progress = need
      ? `<div class="pz-progress"><div class="pz-progress-top"><span>${t("prize.subsProgress", { n, need })}</span><b>${pct}%</b></div><div class="pz-bar"><i style="width:${pct}%"></i></div></div>`
      : `<div class="pz-progress"><div class="pz-progress-top"><span>${t("prize.subscribers", { n })}</span></div></div>`;
    return `<div class="pz-action">${btn}${reason ? `<p class="pz-lock-reason">${escapeHtml(reason)}</p>` : ""}${timerBlock}${progress}</div>`;
  }

  function detailHtml(p) {
    const g = state.groups.find((x) => x.id === p.group_id);
    const rows = conditionRows(p);
    const terms = lines(p.terms);
    const condList = rows.length
      ? rows.map((r) => `<li class="${r.ok === true ? "ok" : r.ok === false ? "no" : ""}"><i aria-hidden="true">${r.ok === true ? "✓" : r.ok === false ? "✕" : "•"}</i><span>${escapeHtml(r.text)}</span></li>`).join("")
      : "";
    const termList = terms.map((x) => `<li><i aria-hidden="true">•</i><span>${escapeHtml(x)}</span></li>`).join("");
    const end = endMs(p);
    return `
      ${g ? `<a class="pz-back" href="${groupHref(g)}">‹ ${escapeHtml(g.name)}</a>` : `<a class="pz-back" href="${PAGE}">‹ ${t("prize.back")}</a>`}
      <article class="pz-detail glass">
        <h1>${escapeHtml(p.title)}</h1>
        ${carouselHtml(gallery(p), p.title)}
        ${videoHtml(p.video_url)}
        <div class="pz-dates">
          <div><span>${t("prize.added")}</span><b>${p.created_at ? escapeHtml(formatDate(p.created_at)) : "—"}</b></div>
          <div><span>${t("prize.ends")}</span><b>${end === null ? t("prize.noEnd") : escapeHtml(formatDate(p.ends_at))}</b></div>
        </div>
        <h2>${t("prize.description")}</h2>
        <p class="pz-desc">${escapeHtml(p.description || "").replace(/\n/g, "<br>")}</p>
        <h2>${t("prize.terms")}</h2>
        <ul class="pz-terms">${condList}${termList}${!condList && !termList ? `<li><i aria-hidden="true">•</i><span>${t("prize.cond.none")}</span></li>` : ""}</ul>
        <div id="pz-action">${actionHtml(p)}</div>
      </article>`;
  }

  function hasConfiguredModes(p) {
    return Boolean(center.modesOk && center.modes.some((m) => String(m.prize_id) === String(p.id)));
  }

  function detailModesHtml(p) {
    const g = state.groups.find((x) => String(x.id) === String(p.group_id));
    const modes = modesOf(p);
    const selected = modes.find((m) => modeKey(m) === center.tab) || modes[0];
    const end = endMs(p);
    const terms = lines(p.terms);
    const tabs = modes.map((m) => {
      const active = modeKey(m) === modeKey(selected);
      return `<button type="button" role="tab" class="pz-tab ${active ? "on" : ""}" data-tab="${escapeHtml(modeKey(m))}" aria-selected="${active}">
        ${MODE_ICON[modeKey(m)] || ""}<span>${escapeHtml(t(`prize.mode.${modeKey(m)}`))}</span>
        <small>${escapeHtml(t("prize.points", { n: Number(m.points_cost || 0) }))}</small>
      </button>`;
    }).join("");
    const termsHtml = terms.length
      ? `<h2>${t("prize.terms")}</h2><ul class="pz-terms">${terms.map((line) => `<li><i aria-hidden="true">•</i><span>${escapeHtml(line)}</span></li>`).join("")}</ul>`
      : "";
    return `
      ${g ? `<a class="pz-back" href="${groupHref(g)}">‹ ${escapeHtml(g.name)}</a>` : `<a class="pz-back" href="${PAGE}">‹ ${t("prize.back")}</a>`}
      <article class="pz-detail glass">
        <h1>${escapeHtml(p.title)}</h1>
        ${carouselHtml(gallery(p), p.title)}
        ${videoHtml(p.video_url)}
        <div class="pz-dates">
          <div><span>${t("prize.added")}</span><b>${p.created_at ? escapeHtml(formatDate(p.created_at)) : "—"}</b></div>
          <div><span>${t("prize.ends")}</span><b>${end === null ? t("prize.noEnd") : escapeHtml(formatDate(p.ends_at))}</b></div>
        </div>
        <h2>${t("prize.description")}</h2>
        <p class="pz-desc">${escapeHtml(p.description || "").replace(/\n/g, "<br>")}</p>
        ${termsHtml}
        ${state.ctx ? C.pointsHtml(state.ctx.pointsView) : `<p class="pz-pts-hint"><a href="./login.html">${escapeHtml(t("prize.signinNeeded"))}</a></p>`}
        <section class="pz-detail-modes" id="pz-detail-modes">
          <h2>${t("prize.modes")}</h2>
          <div class="pz-tabs" role="tablist">${tabs}</div>
          <div class="pz-tab-panel">${modePanelHtml(p, selected)}</div>
        </section>
      </article>`;
  }

  // ---------- full page ----------
  async function renderPage() {
    const root = $("#prize-root");
    if (!root) return;
    clearInterval(timer);
    const { group, prize, mode: requestedMode } = urlParams();
    let inner;
    let current = null;
    if (!state.schemaOk) inner = `<p class="empty">${t("prize.needSql")}</p>`;
    else if (prize) {
      const p = state.prizes.find((x) => String(x.id) === String(prize));
      if (!p || !canSee(p)) inner = `<p class="empty">${t("prize.notFound")}</p><a class="btn btn-sm btn-ghost" href="${PAGE}">${t("prize.back")}</a>`;
      else {
        current = p;
        if (hasConfiguredModes(p)) {
          const prizeModes = modesOf(p);
          if (prizeModes.some((m) => modeKey(m) === requestedMode)) center.tab = requestedMode;
          else if (!prizeModes.some((m) => modeKey(m) === center.tab)) center.tab = modeKey(prizeModes[0]);
          await loadActivity(p);
          const selected = prizeModes.find((m) => modeKey(m) === center.tab) || prizeModes[0];
          await loadPeople(entriesOf(p, selected).map((entry) => entry.member_id));
          inner = detailModesHtml(p);
        } else inner = detailHtml(p);
      }
    } else if (group) inner = groupHtml(group);
    else inner = overviewHtml();
    const head = !prize && !group
      ? `<header class="pz-page-head"><span class="eyebrow">${t("prize.eyebrow")}</span><h1>${t("prize.h1")}</h1><p class="muted">${t("prize.lead")}</p></header>`
      : "";
    root.innerHTML = `<div class="pz-wrap">${head}${inner}</div>`;
    if (state.schemaOk && !prize && !group) mountCenter();
    if (!current) return;
    bindCarousel(root);
    if (hasConfiguredModes(current)) wireDetailModes(root, current);
    else {
      wireAction(root, current);
      startCountdown(root, () => refreshDetail(current));
    }
  }

  function simpleLockReason(p) {
    const st = statusOf(p);
    if (st === "ended") return t("prize.closed");
    if (st === "upcoming") return t("prize.notStarted");
    if (p.quantity != null && Number(p.winners_count || 0) >= Number(p.quantity)) return t("prize.soldOut");
    const cost = Math.max(0, Number(p.minutes_required || 0));
    if (state.ctx?.active && eligible(p) && Number(state.ctx.points || 0) < cost) {
      return t("prize.needPoints", { need: cost, have: Number(state.ctx.points || 0) });
    }
    return lockReason(p);
  }

  function wireAction(root, p) {
    const box = root.querySelector("#pz-action");
    if (!box) return;
    box.onclick = async (e) => {
      if (e.target.closest("[data-locked]")) return toast(simpleLockReason(p));
      const btn = e.target.closest("[data-claim-simple]");
      if (!btn) return;
      const s = sess();
      if (!s?.member_id || !state.ctx) return toast(t("prize.signinNeeded"));
      if (statusOf(p) !== "open" || !eligible(p)) return toast(simpleLockReason(p));
      const cost = Math.max(0, Number(p.minutes_required || 0));
      if (Number(state.ctx.points || 0) < cost) return toast(simpleLockReason(p));
      if (!confirm(t("prize.confirmClaim", { n: cost, title: p.title }))) return;
      btn.disabled = true;
      btn.textContent = t("prize.claiming");
      const result = await C.rpc("prize_claim_simple", { p_member: s.member_id, p_prize: p.id });
      if (result.ok && result.data?.ok) {
        state.ctx.pointsSpent = Number(state.ctx.pointsSpent || 0) + Number(result.data.cost ?? cost);
        state.ctx.points = Math.max(0, Number(state.ctx.pointsEarned || 0) - state.ctx.pointsSpent);
        if (state.ctx.pointsView) {
          state.ctx.pointsView.spent = state.ctx.pointsSpent;
          state.ctx.pointsView.available = state.ctx.points;
        }
        state.winners.push({ prize_title: p.title, member_id: s.member_id, minutes_paid: result.data.cost ?? cost, claim_requested_at: new Date().toISOString() });
        toast(t("prize.claimRequestOk"));
      } else if (result.data?.error === "already") {
        await reloadSimpleWinners();
        toast(t("prize.status.winner"));
      } else if (result.data?.error === "points") {
        toast(t("prize.needPoints", { need: result.data.need ?? cost, have: state.ctx.points }));
      } else if (["incomplete", "audience", "inactive"].includes(result.data?.error)) {
        toast(t("prize.notEligible"));
      } else {
        toast(t("prize.subFail"));
      }
      await refreshDetail(p);
    };
  }

  async function reloadSimpleWinners() {
    const id = sess()?.member_id;
    if (!id) return;
    const result = await supabaseRequest(`/rest/v1/winners?member_id=eq.${restValue(id)}&select=*`);
    if (result.ok && Array.isArray(result.data)) state.winners = result.data;
  }

  function setModeInUrl(mode) {
    try {
      const url = new URL(location.href);
      url.searchParams.set("mode", mode);
      history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
    } catch {}
  }

  function wireDetailModes(root, p) {
    const box = root.querySelector("#pz-detail-modes");
    if (!box) return;
    box.onclick = async (e) => {
      const tab = e.target.closest("[data-tab]");
      if (tab) {
        center.tab = tab.dataset.tab;
        setModeInUrl(center.tab);
        return renderPage();
      }
      const expanded = e.target.closest("[data-expand]");
      if (expanded) {
        center.expanded = center.expanded === expanded.dataset.expand ? "" : expanded.dataset.expand;
        return renderPage();
      }
      const lock = e.target.closest("[data-locked-mode]");
      if (lock) {
        const mode = modesOf(p).find((row) => modeKey(row) === lock.dataset.lockedMode);
        return toast((mode ? modeStatus(p, mode).reason : "") || t("prize.closed"));
      }
      const sub = e.target.closest("[data-sub-mode]");
      if (sub) return subscribeMode(p, modesOf(p).find((row) => modeKey(row) === sub.dataset.subMode));
      const claim = e.target.closest("[data-claim-challenge]");
      if (claim) return claimChallenge(p, modesOf(p).find((row) => String(row.id) === String(claim.dataset.claimChallenge)));
      const request = e.target.closest("[data-request-claim]");
      if (request) return requestPrizeClaim(p, modesOf(p).find((row) => String(row.id) === String(request.dataset.requestClaim)));
      const coupon = e.target.closest("[data-coupon-apply]");
      if (coupon) return applyCoupon(p, modesOf(p).find((row) => modeKey(row) === coupon.dataset.couponApply), coupon.parentElement.querySelector("[data-coupon-input]")?.value);
      const withdrawButton = e.target.closest("[data-withdraw]");
      if (withdrawButton) return withdraw(p, modesOf(p).find((row) => modeKey(row) === withdrawButton.dataset.withdraw));
    };
  }

  async function refreshPrizeViews(p) {
    const params = urlParams();
    if ($("#prize-root") && String(params.prize) === String(p.id)) await renderPage();
    if (center.open && String(center.open.id) === String(p.id) && $("#pz-modal")) await renderModal();
  }

  async function refreshDetail(p) {
    const root = $("#prize-root");
    if (!root || !$("#pz-action")) return;
    $("#pz-action").innerHTML = actionHtml(p);
    wireAction(root, p);
    startCountdown(root, () => refreshDetail(p));
  }

  async function bootPage() {
    C.setupChrome();
    const root = $("#prize-root");
    root.innerHTML = `<div class="pz-wrap"><div class="loader" style="display:grid"><div class="spinner"></div></div></div>`;
    // Subscriber counts are public; the conditions and points need the signed-in member.
    await Promise.all([loadCatalog(), loadModeData()]);
    if (sess()?.member_id) await loadMemberContext();
    bindDialogKeys();
    await renderPage();
    document.addEventListener("cineaura:prefs", () => renderPage());
  }

  // ════════════════════════════════════════════════════════════════════════
  // Prize center on the home page (#pz-center): search + filters, cards with
  // the required points, and a dialog with one tab per subscription mode.
  //   gift      — pay points, get the prize; open for a fixed start/end window
  //   challenge — cheaper, but the required actions decide the winner; limited
  //               by quantity, open for a longer window
  //   lottery   — cheapest, biggest prizes; no end date, limited by the number
  //               of winners, drawn once enough members joined
  // Points are the watch minutes of the member (profiles.private_minutes +
  // profiles.public_minutes), the same value the dashboard already spends.
  // ════════════════════════════════════════════════════════════════════════
  const MODE_ORDER = ["gift", "challenge", "lottery"];
  const MODE_ICON = {
    gift: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/></svg>`,
    challenge: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4.5 13H11l-1 9 8.5-11H12z"/></svg>`,
    lottery: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8l4-5h10l4 5-9 13z"/><path d="M3 8h18M12 21 7 8l2.5-5M12 21l5-13-2.5-5"/></svg>`,
  };

  const center = {
    modes: [],
    conds: [],
    entries: [],
    prog: [],
    modesOk: false,
    condsOk: false,
    mEntriesOk: false,
    progOk: false,
    people: new Map(), // member_id -> profile row (username, avatar)
    f: { q: "", status: "all", from: "", to: "", min: "", max: "", country: "", age: "" },
    dates: [], // per-country windows (prize_country_dates)
    limits: null, // participation limits per tier
    act: {}, // mode_id -> what the signed-in member did since joining
    coupon: {}, // mode_id -> applied discount { id, code, percent }
    activityLoaded: new Set(), // entries whose live activity counts were loaded
    open: null, // prize row with the dialog open
    tab: "", // active mode key in the dialog
    expanded: "", // competitor row expanded in the dialog
  };

  const groupName = (id) => state.groups.find((x) => x.id === id)?.name || "";
  const dayMs = (v) => {
    const d = Date.parse(v);
    return Number.isNaN(d) ? null : d;
  };

  // Without the prize_modes table the prize row itself becomes one gift mode,
  // so the whole center keeps working before sql/prize_modes.sql is run.
  function fallbackMode(p) {
    return {
      id: 0,
      prize_id: p.id,
      mode: "gift",
      points_cost: Number(p.minutes_required || 0),
      starts_at: p.starts_at || null,
      ends_at: p.ends_at || null,
      unlimited_time: Boolean(p.unlimited_time),
      quantity: num(p.quantity),
      winners_needed: num(p.winners_needed),
      draw_at: num(p.subscribers_needed),
      terms: p.terms || "",
    };
  }

  function modesOf(p) {
    if (!p) return [];
    if (center.modesOk) {
      const rows = center.modes.filter((m) => m.prize_id === p.id);
      const ordered = MODE_ORDER.map((k) => rows.find((m) => String(m.mode || "").toLowerCase() === k)).filter(Boolean);
      if (ordered.length) return ordered;
    }
    return [fallbackMode(p)];
  }

  const modeKey = (m) => String(m.mode || "gift").toLowerCase();
  const pointsOf = (p) => Math.min(...modesOf(p).map((m) => Number(m.points_cost || 0)));

  // ---------- data ----------
  async function loadModeData() {
    const [m, c, e, g] = await Promise.all([
      supabaseRequest("/rest/v1/prize_modes?select=*&order=sort_order.asc,id.asc"),
      supabaseRequest("/rest/v1/prize_mode_conditions?select=*&order=sort_order.asc,id.asc"),
      supabaseRequest("/rest/v1/prize_mode_entries?select=*&order=id.asc"),
      supabaseRequest("/rest/v1/prize_mode_progress?select=*"),
    ]);
    center.modesOk = m.ok && Array.isArray(m.data);
    center.modes = center.modesOk ? m.data : [];
    center.condsOk = c.ok && Array.isArray(c.data);
    center.conds = center.condsOk ? c.data : [];
    center.mEntriesOk = e.ok && Array.isArray(e.data);
    center.entries = center.mEntriesOk ? e.data : [];
    center.progOk = g.ok && Array.isArray(g.data);
    center.prog = center.progOk ? g.data : [];
    // Optional extras from sql/prize_admin.sql: country windows and tier limits.
    const [d, lim] = await Promise.all([supabaseRequest("/rest/v1/prize_country_dates?select=*"), R.loadLimits()]);
    center.dates = d.ok && Array.isArray(d.data) ? d.data : [];
    center.limits = lim.ok ? lim.limits : null;
  }

  // Subscribers of one mode. Before the mode tables exist, the plain
  // prize_entries rows are shown as the participants of the gift mode.
  function entriesOf(p, m) {
    if (center.mEntriesOk) {
      return center.entries.filter((e) => e.prize_id === p.id && String(e.mode || "").toLowerCase() === modeKey(m));
    }
    if (modeKey(m) !== "gift") return [];
    return state.entryRows
      .filter((r) => r.prize_id === p.id)
      .map((r, i) => ({
        id: `legacy-${r.id ?? `${p.id}-${i}`}`,
        prize_id: p.id,
        member_id: r.member_id,
        mode: "gift",
        // Without the mode tables a gift subscription pays the prize at once.
        status: isMine(r) ? "winner" : "competitor",
        points_paid: 0,
        lottery_wins: 0,
        lottery_plays: 0,
        created_at: r.created_at || null,
      }));
  }

  const isMine = (e) => {
    const id = sess()?.member_id;
    return Boolean(id && e && String(e.member_id || "").toLowerCase() === String(id).toLowerCase());
  };
  const myEntry = (p, m) => entriesOf(p, m).find(isMine) || null;
  const statusLabel = (e) => {
    const s = String(e?.status || "competitor").toLowerCase();
    return ["winner", "excluded", "withdrawn"].includes(s) ? t(`prize.status.${s}`) : t("prize.status.competitor");
  };
  const personName = (id) => center.people.get(String(id))?.username || String(id || "—");

  async function loadPeople(ids) {
    const list = [...new Set((ids || []).map((x) => String(x || "")).filter(Boolean))].filter((id) => !center.people.has(id));
    if (!list.length) return;
    const rows = await profilesByIds(list, ["member_id", "username", "avatar_url"]);
    (rows || []).forEach((r) => center.people.set(String(r.member_id), r));
  }

  // ---------- conditions ----------
  const liveProgress = (c, req) => {
    if (!state.ctx) return 0;
    const kind = String(c.kind || "watch");
    if (kind === "watch") return state.ctx.seen.has(`${c.media_type || "movie"}:${c.tmdb_id}`) ? 1 : 0;
    if (kind === "points") return Math.min(req, state.ctx.minutes);
    const act = center.act[c.mode_id];
    if (act && typeof act[kind] === "number") return Math.min(req, act[kind]); // counted since joining
    return 0; // share / invite are recorded in prize_mode_progress
  };

  const storedProgress = (p, m, c, entry) => {
    if (!center.progOk || !entry?.id) return 0;
    const row = center.prog.find((r) => String(r.entry_id) === String(entry.id) && String(r.condition_id) === String(c.id));
    return row ? Number(row.progress || 0) : 0;
  };

  const condText = (c, req) => {
    const type = c.media_type === "tv" ? t("common.series") : t("common.movie");
    const kind = String(c.kind || "watch");
    if (kind === "share") return t("prize.cond.share", { type, id: c.tmdb_id });
    if (kind === "invite") return t("prize.cond.invites", { n: req });
    if (kind === "points") return t("prize.cond.minutes", { n: req, have: state.ctx ? state.ctx.minutes : 0 });
    if (R.TIERS && ["link_shares", "watch_minutes", "playlists", "recommendations", "comments", "movies", "series", "follows"].includes(kind)) {
      return t(`pzm.cond.${kind}`, { n: req });
    }
    return t("prize.cond.watched", { type, id: c.tmdb_id });
  };

  // One row per required action of a mode, with the progress of `entry`.
  function actionRows(p, m, entry) {
    if (!center.condsOk) return [];
    return center.conds
      .filter((c) => c.mode_id === m.id)
      .map((c) => {
        const req = Math.max(1, Number(c.required || 1));
        let prog = storedProgress(p, m, c, entry);
        if (entry && isMine(entry)) prog = Math.max(prog, liveProgress(c, req));
        prog = Math.min(req, Math.max(0, prog));
        return { c, req, prog, done: prog >= req, text: condText(c, req) };
      });
  }

  function progressOf(p, m, entry) {
    const rows = actionRows(p, m, entry);
    const done = rows.filter((r) => r.done);
    const rest = rows.filter((r) => !r.done);
    return { rows, done, rest, current: rest[0] || null, overall: rows.length ? Math.round((done.length / rows.length) * 100) : 100 };
  }

  // The prize-wide conditions plus the actions this mode adds.
  function modeConditions(p, m, entry) {
    const base = conditionRows(p).map((r) => ({ req: 1, prog: r.ok === true ? 1 : 0, done: r.ok === true, ok: r.ok, text: r.text }));
    const acts = actionRows(p, m, entry).map((r) => ({ req: r.req, prog: r.prog, done: r.done, ok: state.ctx ? r.done : null, text: r.text }));
    return [...base, ...acts];
  }

  const condListHtml = (rows) =>
    rows.length
      ? rows
          .map(
            (r) =>
              `<li class="${r.ok === true || r.done === true ? "ok" : r.ok === false ? "no" : ""}"><i aria-hidden="true">${r.done === true || r.ok === true ? "✓" : r.ok === false ? "✕" : "•"}</i><span>${escapeHtml(r.text)}</span>${
                r.req > 1 ? `<b class="pz-cond-n">${r.prog}/${r.req}</b>` : ""
              }</li>`
          )
          .join("")
      : "";

  // ---------- availability of one mode ----------
  // Window of a mode for the signed-in member's country (country rows win).
  const windowOf = (p, m) =>
    R.windowFor(p, m, center.dates.filter((d) => d.prize_id === p.id), state.ctx?.country || "");

  function audienceReason(m) {
    const a = R.cfgOf(m).audience;
    if (!a || !state.ctx) return "";
    const fails = R.audienceFails(a, state.ctx.member);
    return fails.length ? t(fails.includes("private") ? "pzm.aud.private" : "pzm.aud.fail") : "";
  }

  function quotaReason(m) {
    if (!center.limits || !state.ctx || !center.mEntriesOk) return "";
    const prizes = {};
    state.prizes.forEach((x) => (prizes[x.id] = x));
    const mine = center.entries.filter(isMine);
    const r = R.limitCheck(center.limits, state.ctx.member.membership_type, modeKey(m), R.usage(mine, prizes));
    if (r.ok) return "";
    return t(r.period === "concurrent" ? "pzm.quota.concurrent" : "pzm.quota.month", { n: r.cap, mode: t(`prize.mode.${modeKey(m)}`) });
  }

  function modeStatus(p, m) {
    const now = Date.now();
    if (String(p.status || "").toLowerCase() === "ended") return { can: false, reason: t("prize.closed") };
    const win = windowOf(p, m);
    const start = win.startsAt ? dayMs(win.startsAt) : null;
    if (start !== null && start > now) return { can: false, reason: t("prize.notStarted") };
    if (modeKey(m) !== "lottery") {
      const end = win.endsAt ? (dayMs(win.endsAt) || 0) + 86400000 : null;
      if (end !== null && end <= now) return { can: false, reason: t("prize.closed") };
    }
    const won = entriesOf(p, m).filter((e) => String(e.status || "").toLowerCase() === "winner").length;
    const cap = modeKey(m) === "lottery" ? num(m.winners_needed) : num(m.quantity);
    if (cap !== null && won >= cap) return { can: false, reason: t("prize.soldOut") };
    if (!sess()?.member_id || !state.ctx) return { can: false, reason: t("prize.signinNeeded") };
    if (!state.ctx.active) return { can: false, reason: t("prize.notEligible") };
    if (!conditionRows(p).every((r) => r.ok !== false)) return { can: false, reason: t("prize.notEligible") };
    const aud = audienceReason(m);
    if (aud) return { can: false, reason: aud };
    const quota = quotaReason(m);
    if (quota) return { can: false, reason: quota };
    const cost = costOf(m);
    if (cost > (state.ctx.points ?? state.ctx.minutes)) {
      return { can: false, reason: t("prize.needPoints", { need: cost, have: state.ctx.points ?? state.ctx.minutes }) };
    }
    if (!center.mEntriesOk && modeKey(m) !== "gift") return { can: false, reason: t("prize.needModesSql") };
    return { can: true, reason: "" };
  }

  // Points to pay after the coupon of this mode (if any).
  function costOf(m) {
    const base = Number(m.points_cost || 0);
    const c = center.coupon[m.id];
    return c ? Math.max(0, Math.ceil((base * (100 - c.percent)) / 100)) : base;
  }

  function constraintHtml(p, m) {
    const k = modeKey(m);
    const bits = [];
    if (m.starts_at) bits.push(t("prize.fromDate", { date: formatDate(m.starts_at) }));
    if (k !== "lottery") {
      bits.push(m.unlimited_time || !m.ends_at ? t("prize.noEnd") : t("prize.ends") + " " + formatDate(m.ends_at));
    }
    if (k === "challenge" && num(m.quantity) !== null) bits.push(t("prize.limitedQty", { n: m.quantity }));
    if (k === "lottery") {
      if (num(m.draw_at) !== null) {
        const n = entriesOf(p, m).length;
        bits.push(n >= Number(m.draw_at) ? t("prize.drawHeld", { n: num(m.winners_needed) ?? 1 }) : t("prize.drawAt", { n: m.draw_at }));
      }
      if (num(m.winners_needed) !== null) bits.push(t("prize.limitedQty", { n: m.winners_needed }));
    }
    return bits.length ? `<div class="pz-constraints">${bits.map((b) => `<span>${escapeHtml(b)}</span>`).join("")}</div>` : "";
  }

  // ---------- cards & filtering ----------
  function centerCardHtml(p) {
    const st = statusOf(p);
    const end = endMs(p);
    const g = state.groups.find((x) => x.id === p.group_id);
    const badge =
      st === "ended"
        ? `<span class="pz-badge ended">${t("prize.ended")}</span>`
        : st === "upcoming"
        ? `<span class="pz-badge soon">${t("prize.soon")}</span>`
        : "";
    const chips = modesOf(p)
      .map((m) => `<i class="pz-chip ${modeKey(m)}">${MODE_ICON[modeKey(m)] || ""}<span>${escapeHtml(t(`prize.mode.${modeKey(m)}`))}</span></i>`)
      .join("");
    return `
      <button type="button" class="pz-card glass pz-card-btn" data-open-prize="${p.id}">
        <span class="pz-card-img"><img src="${escapeHtml(coverOf(p))}" alt="" loading="lazy" />${badge}</span>
        <span class="pz-card-body">
          ${g ? `<small class="pz-card-group">${escapeHtml(g.name)}</small>` : ""}
          <strong>${escapeHtml(p.title)}</strong>
          <span class="pz-chips">${chips}</span>
          <span class="pz-card-points"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5h5M9.5 14.5h5"/></svg><b>${escapeHtml(t("prize.pointsFrom", { n: pointsOf(p) }))}</b></span>
          <span class="pz-card-meta">
            <span>${escapeHtml(t("prize.subscribers", { n: countOf(p) }))}</span>
            <span>${end === null ? escapeHtml(t("prize.noEnd")) : `${escapeHtml(t("prize.ends"))} ${escapeHtml(formatDate(p.ends_at))}`}</span>
          </span>
        </span>
      </button>`;
  }

  function passesFilters(p) {
    const f = center.f;
    if (f.q) {
      const hay = `${p.title} ${p.description || ""} ${groupName(p.group_id)} ${p.terms || ""}`.toLowerCase();
      if (!hay.includes(f.q.toLowerCase().trim())) return false;
    }
    if (f.status !== "all" && statusOf(p) !== f.status) return false;
    // The date filters read the end date; a prize without one never expires and
    // therefore always passes both sides.
    const end = endMs(p);
    if (f.from && end !== null) {
      const from = dayMs(f.from);
      if (from !== null && end < from) return false;
    }
    if (f.to && end !== null) {
      const to = dayMs(f.to);
      if (to !== null && end > to + 86400000) return false;
    }
    const pts = pointsOf(p);
    if (f.min !== "" && pts < Number(f.min)) return false;
    if (f.max !== "" && pts > Number(f.max)) return false;
    if (f.country) {
      const cs = csv(p.countries);
      if (cs.length && !cs.includes(f.country)) return false;
    }
    if (f.age !== "") {
      const a = Number(f.age);
      const lo = num(p.min_age);
      const hi = num(p.max_age);
      if (lo !== null && a < lo) return false;
      if (hi !== null && a > hi) return false;
    }
    return true;
  }

  const filteredPrizes = () => state.prizes.filter((p) => canSee(p) && passesFilters(p)).sort(recentOrder);

  function drawCenter() {
    const box = $("#pz-results");
    if (!box) return;
    const list = filteredPrizes();
    const cnt = $("#pz-count");
    if (cnt) cnt.textContent = t("prize.found", { n: list.length });
    box.innerHTML = list.length ? `<div class="pz-grid">${list.map(centerCardHtml).join("")}</div>` : `<p class="empty">${t("prize.noPrizes")}</p>`;
  }

  // The country select is filled with the countries the published prizes use.
  function fillCountrySelect() {
    const sel = $("#pz-f-country");
    const wrap = $("#pz-f-country-wrap");
    if (!sel) return;
    const set = new Set();
    state.prizes.filter(canSee).forEach((p) => csv(p.countries).forEach((c) => set.add(c)));
    const list = [...set].sort();
    if (!list.length) {
      if (wrap) wrap.hidden = true;
      return;
    }
    if (wrap) wrap.hidden = false;
    const keep = sel.value;
    sel.innerHTML = `<option value="">${escapeHtml(t("prize.filterAllCountries"))}</option>${list
      .map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c.toUpperCase())}</option>`)
      .join("")}`;
    sel.value = list.includes(keep) ? keep : "";
  }

  // ---------- dialog ----------
  function personRowHtml(e, note = "", extra = "") {
    const nm = personName(e.member_id);
    return `
      <li class="pz-person">
        ${avatarImg(e.member_id, nm, nm)}
        <span class="pz-person-main">
          <span class="pz-person-name">${escapeHtml(nm)}${isMine(e) ? `<i class="pz-you">${escapeHtml(t("prof.you"))}</i>` : ""}</span>
          ${note ? `<span class="pz-person-note">${escapeHtml(note)}</span>` : ""}
        </span>
        ${extra}
      </li>`;
  }

  function competitorRowHtml(p, m, e, i) {
    const pr = progressOf(p, m, e);
    const open = center.expanded === String(e.id);
    const pct = pr.rows.length ? (pr.current ? Math.round((pr.current.prog / pr.current.req) * 100) : 100) : 100;
    const detail = !open
      ? ""
      : `
      <div class="pz-comp-detail">
        <div class="pz-comp-block">
          <h4>${escapeHtml(t("prize.doneConditions"))} <small>${pr.done.length}</small></h4>
          <ul class="pz-terms">${condListHtml(pr.done.map((r) => ({ ...r, ok: true }))) || `<li><i aria-hidden="true">•</i><span>${escapeHtml(t("prize.cond.none"))}</span></li>`}</ul>
        </div>
        ${pr.current ? `
        <div class="pz-comp-block">
          <h4>${escapeHtml(t("prize.currentCondition"))}</h4>
          <p class="pz-comp-now">${escapeHtml(pr.current.text)}</p>
          <div class="pz-progress"><div class="pz-progress-top"><span>${pr.current.prog} / ${pr.current.req}</span><b>${pct}%</b></div><div class="pz-bar"><i style="width:${pct}%"></i></div></div>
        </div>` : ""}
        <div class="pz-comp-block">
          <h4>${escapeHtml(t("prize.remainingConditions"))} <small>${pr.rest.length}</small></h4>
          <ul class="pz-terms">${condListHtml(pr.rest.map((r) => ({ ...r, ok: null }))) || `<li><i aria-hidden="true">•</i><span>${escapeHtml(t("prize.cond.none"))}</span></li>`}</ul>
        </div>
      </div>`;
    return `
      <li class="pz-comp ${open ? "open" : ""}">
        <button type="button" class="pz-comp-head" data-expand="${escapeHtml(String(e.id))}">
          <b class="pz-rank">${i}</b>
          ${avatarImg(e.member_id, personName(e.member_id), personName(e.member_id))}
          <span class="pz-person-main">
            <span class="pz-person-name">${escapeHtml(personName(e.member_id))}${isMine(e) ? `<i class="pz-you">${escapeHtml(t("prof.you"))}</i>` : ""}</span>
            <span class="pz-person-note">${escapeHtml(t("prize.overallProgress"))} · ${pr.overall}%</span>
          </span>
          <span class="pz-status s-${escapeHtml(String(e.status || "competitor").toLowerCase())}">${escapeHtml(statusLabel(e))}</span>
        </button>
        ${detail}
      </li>`;
  }

  function peopleHtml(p, m) {
    const list = entriesOf(p, m);
    const k = modeKey(m);
    if (k === "challenge") {
      const ranked = list
        .map((e) => ({ e, o: progressOf(p, m, e).overall, at: Date.parse(e.created_at || "") || 0 }))
        .sort((a, b) => b.o - a.o || a.at - b.at);
      return `
        <h3 class="pz-people-h">${escapeHtml(t("prize.competitors"))} <small>${list.length}</small></h3>
        ${ranked.length ? `<ul class="pz-comps">${ranked.map(({ e }, i) => competitorRowHtml(p, m, e, i + 1)).join("")}</ul>` : `<p class="empty">${t("prize.noCompetitors")}</p>`}`;
    }
    if (k === "lottery") {
      return `
        <h3 class="pz-people-h">${escapeHtml(t("prize.subscribersLbl"))} <small>${list.length}</small></h3>
        ${list.length ? `<ul class="pz-people">${list.map((e) => personRowHtml(e, t("prize.lotteryRecord", { won: Number(e.lottery_wins || 0), total: Number(e.lottery_plays || 0) }))).join("")}</ul>` : `<p class="empty">${t("prize.noParticipants")}</p>`}`;
    }
    const winners = list.filter((e) => String(e.status || "").toLowerCase() === "winner");
    const winChip = (e) =>
      String(e.status || "").toLowerCase() === "winner"
        ? `<span class="pz-status s-winner">${escapeHtml(t("prize.status.winner"))}</span>`
        : "";
    return `
      <h3 class="pz-people-h">${escapeHtml(t("prize.participants"))} <small>${list.length}</small></h3>
      ${list.length ? `<ul class="pz-people">${list.map((e) => personRowHtml(e, "", winChip(e))).join("")}</ul>` : `<p class="empty">${t("prize.noParticipants")}</p>`}
      <h3 class="pz-people-h">${escapeHtml(t("prize.winners"))} <small>${winners.length}</small></h3>
      ${winners.length ? `<ul class="pz-people">${winners.map((e) => personRowHtml(e)).join("")}</ul>` : `<p class="empty">${t("prize.noWinners")}</p>`}`;
  }

  function challengeClaimState(p, m, entry) {
    const progress = progressOf(p, m, entry);
    const days = Number(R.cfgOf(m).days || 0);
    const joinedAt = Date.parse(entry?.created_at || "") || 0;
    const expired = Boolean(days && joinedAt && Date.now() > joinedAt + days * 86400000);
    const cap = num(m.quantity);
    const won = entriesOf(p, m).filter((e) => String(e.status || "").toLowerCase() === "winner").length;
    const full = cap !== null && won >= cap;
    const ended = String(p.status || "").toLowerCase() === "ended";
    const ready = Boolean(progress.rows.length && !progress.rest.length && !expired && !full && !ended);
    const reason = ended ? t("prize.closed") : expired ? t("pzm.timeUp") : full ? t("prize.soldOut") : "";
    return { ...progress, ready, expired, full, reason };
  }

  function actionHtml2(p, m) {
    const mine = myEntry(p, m);
    const st = modeStatus(p, m);
    const cost = costOf(m);
    const key = modeKey(m);
    const challenge = mine && key === "challenge" ? challengeClaimState(p, m, mine) : null;
    let btn;
    let note = "";
    if (mine) {
      const status = String(mine.status || "competitor").toLowerCase();
      if (status === "winner") {
        const message = key === "challenge" ? t("pzm.challengeWon") : key === "lottery" ? t("prize.drawWon") : t("prize.giftWon");
        if (mine.claim_requested_at) {
          btn = `<button class="btn btn-lg btn-primary pz-sub is-done" type="button" disabled>✓ ${escapeHtml(t("prize.claimRequested"))}</button>`;
          note = `<p class="pz-lock-reason pz-success-note">${escapeHtml(t("prize.claimRequestSent"))}</p>`;
        } else {
          btn = `<button class="btn btn-lg btn-primary pz-sub" type="button" data-request-claim="${escapeHtml(String(mine.id))}">${escapeHtml(t("prize.claim"))}</button>`;
          note = `<p class="pz-lock-reason pz-success-note">${escapeHtml(message)}</p>`;
        }
      } else if (status === "competitor" && challenge?.ready) {
        btn = `<button class="btn btn-lg btn-primary pz-sub" type="button" data-claim-challenge="${escapeHtml(String(mine.id))}">${escapeHtml(t("pzm.confirmWin"))}</button>`;
        note = `<p class="pz-lock-reason pz-success-note">${escapeHtml(t("pzm.challengeReady"))}</p>`;
      } else if (status === "competitor") {
        btn = `<button class="btn btn-lg btn-primary pz-sub" type="button" data-withdraw="${escapeHtml(key)}">${escapeHtml(t("pzm.withdraw"))}</button>`;
        if (challenge?.reason) note = `<p class="pz-lock-reason">${escapeHtml(challenge.reason)}</p>`;
      } else {
        const label = t(`prize.status.${status}`);
        btn = `<button class="btn btn-lg btn-primary pz-sub ${status === "excluded" ? "is-locked" : "is-done"}" type="button" disabled>✓ ${escapeHtml(label)}</button>`;
      }
    } else if (st.can) {
      const label = key === "gift" ? t("prize.claim") : key === "lottery" ? t("prize.enterLottery") : t("prize.subscribe");
      btn = `<button class="btn btn-lg btn-primary pz-sub" type="button" data-sub-mode="${escapeHtml(key)}">${escapeHtml(label)} · ${escapeHtml(t("prize.points", { n: cost }))}</button>`;
    } else {
      const label = key === "gift" ? t("prize.claim") : key === "lottery" ? t("prize.enterLottery") : t("prize.subscribe");
      btn = `<button class="btn btn-lg btn-primary pz-sub is-locked" type="button" data-locked-mode="${escapeHtml(key)}" aria-disabled="true">${escapeHtml(label)}</button>`;
    }
    return `<div class="pz-action">${btn}${note}${!mine && !st.can && st.reason ? `<p class="pz-lock-reason">${escapeHtml(st.reason)}</p>` : ""}</div>`;
  }

  function couponHtml(p, m) {
    if (modeKey(m) !== "gift" || myEntry(p, m) || !sess()?.member_id) return "";
    const c = center.coupon[m.id];
    if (c) return `<p class="pz-lock-reason">${escapeHtml(t("pzm.couponApplied", { code: c.code, n: c.percent }))}</p>`;
    return `<div class="pz-coupon"><input data-coupon-input placeholder="${escapeHtml(t("pzm.couponPh"))}" autocomplete="off" />
      <button type="button" class="btn btn-sm btn-ghost" data-coupon-apply="${escapeHtml(modeKey(m))}">${escapeHtml(t("pzm.couponApply"))}</button></div>`;
  }

  function deadlineHtml(p, m) {
    const mine = myEntry(p, m);
    const days = Number(R.cfgOf(m).days || 0);
    if (modeKey(m) !== "challenge" || !days) return "";
    if (!mine) return `<p class="pz-lock-reason">${escapeHtml(t("pzm.days", { n: days }))}</p>`;
    const left = Math.ceil((Date.parse(mine.created_at || 0) + days * 86400000 - Date.now()) / 86400000);
    return `<p class="pz-lock-reason">${escapeHtml(left > 0 ? t("pzm.daysLeft", { n: left }) : t("pzm.timeUp"))}</p>`;
  }

  function modePanelHtml(p, m) {
    const mine = myEntry(p, m);
    const cost = costOf(m);
    const terms = lines(m.terms);
    const have = state.ctx ? (state.ctx.points ?? state.ctx.minutes) : 0;
    return `
      <div class="pz-mode-cost">
        <span>${escapeHtml(t("prize.requiredPoints"))}</span>
        <b>${escapeHtml(t("prize.points", { n: cost }))}</b>
        ${state.ctx ? `<small>${escapeHtml(t("prize.needPoints", { need: cost, have }))}</small>` : ""}
      </div>
      <p class="pz-mode-desc">${escapeHtml(t(`prize.mode.${modeKey(m)}.desc`))}</p>
      ${constraintHtml(p, m)}
      <h3 class="pz-people-h">${escapeHtml(t("prize.conditions"))}</h3>
      <ul class="pz-terms">${condListHtml(modeConditions(p, m, mine)) || `<li><i aria-hidden="true">•</i><span>${escapeHtml(t("prize.cond.none"))}</span></li>`}</ul>
      ${terms.length ? `<ul class="pz-terms pz-terms-extra">${terms.map((x) => `<li><i aria-hidden="true">•</i><span>${escapeHtml(x)}</span></li>`).join("")}</ul>` : ""}
      ${deadlineHtml(p, m)}
      ${couponHtml(p, m)}
      ${actionHtml2(p, m)}
      ${peopleHtml(p, m)}`;
  }

  function modalHtml(p) {
    const g = state.groups.find((x) => x.id === p.group_id);
    const modes = modesOf(p);
    const m = modes.find((x) => modeKey(x) === center.tab) || modes[0];
    const end = endMs(p);
    const tabs = modes
      .map(
        (x) =>
          `<button type="button" role="tab" class="pz-tab ${modeKey(x) === modeKey(m) ? "on" : ""}" data-tab="${escapeHtml(modeKey(x))}" aria-selected="${modeKey(x) === modeKey(m)}">${MODE_ICON[modeKey(x)] || ""}<span>${escapeHtml(t(`prize.mode.${modeKey(x)}`))}</span><small>${escapeHtml(t("prize.points", { n: Number(x.points_cost || 0) }))}</small></button>`
      )
      .join("");
    return `
      <section class="glass pz-modal-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(p.title)}">
        <div class="pz-modal-head">
          <div>
            ${g ? `<small class="pz-card-group">${escapeHtml(g.name)}</small>` : ""}
            <h2>${escapeHtml(p.title)}</h2>
          </div>
          <button type="button" class="pz-modal-x" data-close aria-label="${escapeHtml(t("common.close"))}">✕</button>
        </div>
        <div class="pz-modal-img"><img src="${escapeHtml(coverOf(p))}" alt="" /></div>
        <p class="pz-modal-desc">${escapeHtml(p.description || "").replace(/\n/g, "<br>")}</p>
        <div class="pz-dates">
          <div><span>${escapeHtml(t("prize.added"))}</span><b>${p.created_at ? escapeHtml(formatDate(p.created_at)) : "—"}</b></div>
          <div><span>${escapeHtml(t("prize.ends"))}</span><b>${end === null ? escapeHtml(t("prize.noEnd")) : escapeHtml(formatDate(p.ends_at))}</b></div>
        </div>
        ${state.ctx ? C.pointsHtml(state.ctx.pointsView) : `<p class="pz-pts-hint"><a href="./login.html">${escapeHtml(t("prize.signinNeeded"))}</a></p>`}
        <div class="pz-tabs" role="tablist">${tabs}</div>
        <div class="pz-tab-panel">${modePanelHtml(p, m)}</div>
      </section>`;
  }

  function closeModal() {
    const ov = $("#pz-modal");
    if (ov) ov.remove();
    center.open = null;
    center.expanded = "";
    document.body.classList.remove("pz-modal-open");
  }

  async function renderModal() {
    const p = center.open;
    if (!p) return;
    const modes = modesOf(p);
    if (!modes.some((m) => modeKey(m) === center.tab)) center.tab = modeKey(modes[0]);
    const m = modes.find((x) => modeKey(x) === center.tab) || modes[0];
    // Names and avatars of everybody listed in the open mode.
    await loadPeople(entriesOf(p, m).map((e) => e.member_id));
    const ov = $("#pz-modal");
    if (!ov) return;
    ov.innerHTML = modalHtml(p);
    C.hydrateAvatars?.(ov);
  }

  async function openPrize(id) {
    const p = state.prizes.find((x) => String(x.id) === String(id));
    if (!p) return;
    if (!state.ctx && sess()?.member_id) await loadMemberContext();
    center.open = p;
    logVisit(p);
    await loadActivity(p);
    center.tab = modeKey(modesOf(p)[0]);
    center.expanded = "";
    // Never stack two dialogs: reuse the overlay that is already open.
    let ov = $("#pz-modal");
    if (!ov) {
      ov = document.createElement("div");
      ov.className = "pz-modal-overlay";
      ov.id = "pz-modal";
      ov.innerHTML = `<div class="loader" style="display:grid"><div class="spinner"></div></div>`;
      document.body.appendChild(ov);
      document.body.classList.add("pz-modal-open");
      ov.addEventListener("click", (e) => {
        if (e.target === ov) closeModal();
      });
      ov.addEventListener("click", async (e) => {
        const cur = center.open;
        if (!cur) return;
        if (e.target.closest("[data-close]")) return closeModal();
        const tab = e.target.closest("[data-tab]");
        if (tab) {
          center.tab = tab.dataset.tab;
          center.expanded = "";
          return renderModal();
        }
        const exp = e.target.closest("[data-expand]");
        if (exp) {
          center.expanded = center.expanded === exp.dataset.expand ? "" : exp.dataset.expand;
          return renderModal();
        }
        const lock = e.target.closest("[data-locked-mode]");
        if (lock) {
          const m = modesOf(cur).find((x) => modeKey(x) === lock.dataset.lockedMode);
          return toast((m ? modeStatus(cur, m).reason : "") || t("prize.closed"));
        }
        const sub = e.target.closest("[data-sub-mode]");
        if (sub) return subscribeMode(cur, modesOf(cur).find((x) => modeKey(x) === sub.dataset.subMode));
        const claim = e.target.closest("[data-claim-challenge]");
        if (claim) return claimChallenge(cur, modesOf(cur).find((x) => String(x.id) === String(claim.dataset.claimChallenge)));
        const request = e.target.closest("[data-request-claim]");
        if (request) return requestPrizeClaim(cur, modesOf(cur).find((x) => String(x.id) === String(request.dataset.requestClaim)));
        const cp = e.target.closest("[data-coupon-apply]");
        if (cp) return applyCoupon(cur, modesOf(cur).find((x) => modeKey(x) === cp.dataset.couponApply), cp.parentElement.querySelector("[data-coupon-input]")?.value);
        const wd = e.target.closest("[data-withdraw]");
        if (wd) return withdraw(cur, modesOf(cur).find((x) => modeKey(x) === wd.dataset.withdraw));
      });
    }
    await renderModal();
  }

  // ---------- visits, activity, coupons, withdrawing ----------
  function logVisit(p) {
    const key = `pz_seen_${p.id}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {}
    C.rpc("prize_log_visit", { p_prize: p.id, p_visitor: sess()?.member_id || "", p_country: state.ctx?.country || "" }).catch(() => {});
  }

  // What the member did since joining, per mode: feeds the "required actions" bars.
  async function loadActivity(p, force = false) {
    const me = sess()?.member_id;
    if (!me || !center.mEntriesOk) return;
    for (const m of modesOf(p)) {
      const e = myEntry(p, m);
      if (!e || !m.id || String(e.id).startsWith("legacy")) continue;
      const key = String(e.id);
      if (!force && center.activityLoaded.has(key)) continue;
      const a = (await R.activityCounts([me], e.created_at))[me];
      if (a) center.act[m.id] = a;
      center.activityLoaded.add(key);
    }
  }

  // The browser only offers the claim once progress looks complete; the server
  // re-counts every condition and awards the prize in one locked transaction.
  async function claimChallenge(p, m) {
    const s = sess();
    if (!s?.member_id || !m || modeKey(m) !== "challenge") return toast(t("prize.signinNeeded"));
    const entry = myEntry(p, m);
    if (!entry || !entry.id || String(entry.status || "").toLowerCase() !== "competitor") return;
    const ready = challengeClaimState(p, m, entry);
    if (!ready.ready) return toast(ready.reason || t("pzm.challengeIncomplete"));
    const button = [...document.querySelectorAll("[data-claim-challenge]")].find((el) => el.dataset.claimChallenge === String(entry.id));
    if (button) {
      button.disabled = true;
      button.textContent = t("prize.claiming");
    }
    const result = await C.rpc("prize_claim_challenge", { p_member: s.member_id, p_entry: entry.id });
    const data = result.ok ? result.data : null;
    if (!data) {
      toast(t("prize.needSecure"));
      await refreshPrizeViews(p);
      return;
    }
    if (!data.ok) {
      const message = data.error === "closed" ? t("prize.closed")
        : data.error === "sold_out" ? t("prize.soldOut")
          : data.error === "time_up" ? t("pzm.timeUp")
            : data.error === "incomplete" || data.error === "no_conditions" ? t("pzm.challengeIncomplete")
              : t("prize.subFail");
      toast(message);
      await reloadEntries();
      await refreshPrizeViews(p);
      return;
    }
    await reloadEntries();
    toast(t("pzm.challengeWon"));
    refreshLists();
    await refreshPrizeViews(p);
  }

  async function requestPrizeClaim(p, m) {
    const s = sess();
    const entry = m ? myEntry(p, m) : null;
    if (!s?.member_id) return toast(t("prize.signinNeeded"));
    if (!entry || String(entry.status || "").toLowerCase() !== "winner") return toast(t("prize.notWinner"));
    if (entry.claim_requested_at) return toast(t("prize.claimRequestAlready"));
    const button = [...document.querySelectorAll("[data-request-claim]")]
      .find((el) => el.dataset.requestClaim === String(entry.id));
    if (button) {
      button.disabled = true;
      button.textContent = t("prize.claiming");
    }
    const result = await C.rpc("prize_request_claim", { p_member: s.member_id, p_entry: entry.id });
    const data = result.ok ? result.data : null;
    if (!data?.ok) {
      toast(data?.error === "not_winner" ? t("prize.notWinner") : t("prize.claimRequestFail"));
      await reloadEntries();
      await refreshPrizeViews(p);
      return;
    }
    await reloadEntries();
    toast(data.already ? t("prize.claimRequestAlready") : t("prize.claimRequestOk"));
    refreshLists();
    await refreshPrizeViews(p);
  }

  // The server counts wrong codes and blocks code entry for 24 hours after three in a row.
  async function applyCoupon(p, m, raw) {
    const s = sess();
    if (!s?.member_id || !state.ctx) return toast(t("prize.signinNeeded"));
    const code = String(raw || "").trim();
    if (!code) return;
    const res = await C.rpc("prize_coupon_check", { p_member: s.member_id, p_prize: p.id, p_code: code });
    const d = res.ok ? res.data : null;
    if (!d) return toast(t("prize.subFail"));
    if (!d.ok) {
      if (d.error === "blocked") return toast(t("pzm.couponBlocked", { h: d.hours || 24 }));
      return toast(t("pzm.couponWrong", { n: d.left ?? 0 }));
    }
    center.coupon[m.id] = { id: d.id, code: d.code, percent: Number(d.percent) };
    toast(t("pzm.couponApplied", { code: d.code, n: d.percent }));
    await refreshPrizeViews(p);
  }

  async function withdraw(p, m) {
    const s = sess();
    const mine = myEntry(p, m);
    if (!s?.member_id || !mine || !mine.id || String(mine.id).startsWith("legacy")) return;
    if (!confirm(t("pzm.confirmWithdraw"))) return;
    const r = await C.rpc("prize_withdraw", { p_member: s.member_id, p_entry: mine.id });
    if (!r.ok || !r.data?.ok) return toast(t("prize.subFail"));
    await reloadEntries();
    toast(t("pzm.withdrawn"));
    refreshLists();
    await refreshPrizeViews(p);
  }

  // ---------- subscribing ----------
  // ---------- joining ----------
  // The server (prize_join) does every check and the payment in one locked transaction.
  // After it answers, the in-memory balance is refreshed so the dialog updates without a reload.
  function applySpent(cost) {
    if (!state.ctx) return;
    state.ctx.pointsSpent = Math.max(0, Number(state.ctx.pointsSpent || 0) + Math.max(0, Number(cost) || 0));
    state.ctx.points = Math.max(0, Number(state.ctx.pointsEarned || 0) - state.ctx.pointsSpent);
    if (state.ctx.pointsView) {
      state.ctx.pointsView.spent = state.ctx.pointsSpent;
      state.ctx.pointsView.available = state.ctx.points;
    }
  }

  async function reloadEntries() {
    const [e, g] = await Promise.all([
      supabaseRequest("/rest/v1/prize_mode_entries?select=*&order=id.asc"),
      supabaseRequest("/rest/v1/prize_mode_progress?select=*"),
    ]);
    if (e.ok && Array.isArray(e.data)) {
      center.mEntriesOk = true;
      center.entries = e.data;
    }
    if (g.ok && Array.isArray(g.data)) {
      center.progOk = true;
      center.prog = g.data;
    }
  }

  function joinError(d, m) {
    switch (d?.error) {
      case "closed": return t("prize.closed");
      case "not_started": return t("prize.notStarted");
      case "sold_out": return t("prize.soldOut");
      case "audience": return t("pzm.aud.fail");
      case "inactive":
      case "incomplete": return t("prize.notEligible");
      case "points": return t("prize.needPoints", { need: d.need ?? costOf(m), have: state.ctx?.points ?? 0 });
      case "coupon": return t("pzm.couponInvalid");
      case "quota":
        return t(d.period === "concurrent" ? "pzm.quota.concurrent" : "pzm.quota.month", { n: d.cap, mode: t(`prize.mode.${modeKey(m)}`) });
      default: return t("prize.subFail");
    }
  }

  async function subscribeMode(p, m) {
    if (!m) return;
    const s = sess();
    if (!s?.member_id) return toast(t("prize.signinNeeded"));
    if (!state.ctx) await loadMemberContext();
    if (myEntry(p, m)) return; // already in for this mode — never charge twice
    await reloadEntries();
    const st = modeStatus(p, m);
    if (!st.can) return toast(st.reason);
    const cost = costOf(m);
    const coupon = center.coupon[m.id] || null;
    const k = modeKey(m);
    const confirmed = k === "gift"
      ? confirm(t("prize.confirmClaim", { n: cost, title: p.title }))
      : confirm(t("prize.confirmSub", { n: cost }));
    if (!confirmed) return;
    const res = await C.rpc("prize_join", { p_member: s.member_id, p_prize: p.id, p_mode: k, p_code: coupon?.code || null });
    const d = res.ok ? res.data : null;
    if (!d) return toast(t("prize.needSecure"));
    if (!d.ok) {
      if (d.error === "already") await reloadEntries();
      else toast(joinError(d, m));
      await refreshPrizeViews(p);
      return;
    }
    applySpent(d.cost);
    delete center.coupon[m.id];
    if (!state.mine.has(p.id)) {
      state.counts[p.id] = countOf(p) + 1;
      state.entryRows.push({ prize_id: p.id, member_id: s.member_id });
      state.mine.add(p.id);
    }
    await reloadEntries();
    await loadActivity(p);
    if (k === "lottery" && d.drawn) toast(t("prize.drawWon"));
    else toast(k === "gift" ? t("prize.giftWon") : t("prize.subOk"));
    refreshLists();
    await refreshPrizeViews(p);
  }

  // ---------- wiring ----------
  function bindCenter() {
    const root = $("#pz-center");
    if (!root || root.dataset.pzBound === "1") return;
    root.dataset.pzBound = "1";
    fillCountrySelect();
    const read = () => {
      center.f = {
        q: $("#pz-q")?.value || "",
        status: $("#pz-f-status")?.value || "all",
        from: $("#pz-f-from")?.value || "",
        to: $("#pz-f-to")?.value || "",
        min: $("#pz-f-min")?.value === "" ? "" : String($("#pz-f-min").value),
        max: $("#pz-f-max")?.value === "" ? "" : String($("#pz-f-max").value),
        country: $("#pz-f-country")?.value || "",
        age: $("#pz-f-age")?.value === "" ? "" : String($("#pz-f-age").value),
      };
      drawCenter();
    };
    let deb = null;
    const onInput = () => {
      clearTimeout(deb);
      deb = setTimeout(read, 180);
    };
    ["#pz-q", "#pz-f-min", "#pz-f-max", "#pz-f-age"].forEach((sel) => $(sel)?.addEventListener("input", onInput));
    ["#pz-f-status", "#pz-f-from", "#pz-f-to", "#pz-f-country"].forEach((sel) => $(sel)?.addEventListener("change", read));
    $("#pz-f-reset")?.addEventListener("click", () => {
      ["#pz-q", "#pz-f-from", "#pz-f-to", "#pz-f-min", "#pz-f-max", "#pz-f-age"].forEach((sel) => {
        const el = $(sel);
        if (el) el.value = "";
      });
      const st = $("#pz-f-status");
      if (st) st.value = "all";
      const ct = $("#pz-f-country");
      if (ct) ct.value = "";
      read();
    });
    $("#pz-results")?.addEventListener("click", (e) => {
      const card = e.target.closest("[data-open-prize]");
      if (card) openPrize(card.dataset.openPrize);
    });
    read();
  }

  let dialogKeysBound = false;
  function bindDialogKeys() {
    if (dialogKeysBound) return;
    dialogKeysBound = true;
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && $("#pz-modal")) closeModal();
    });
  }

  // Wires the search box once renderPage() has drawn it, and puts back the filters the visitor
  // had set when a language change redrew the page.
  function mountCenter() {
    if (!$("#pz-center")) return;
    fillCountrySelect();
    const f = center.f;
    const put = (sel, v) => {
      const el = $(sel);
      if (el) el.value = v;
    };
    put("#pz-q", f.q);
    put("#pz-f-status", f.status);
    put("#pz-f-from", f.from);
    put("#pz-f-to", f.to);
    put("#pz-f-min", f.min);
    put("#pz-f-max", f.max);
    put("#pz-f-age", f.age);
    put("#pz-f-country", f.country);
    bindCenter();
  }

  // ---------- home page: the 20 most popular prizes and the "available prizes" strip ----------
  // "Most popular" means the most subscribers. Only prizes the visitor can see and that have at
  // least one subscriber are ranked; an ended prize keeps its place and shows its badge.
  const TOP_LIMIT = 20;
  const topPrizes = () => state.prizes.filter((p) => canSee(p) && countOf(p) > 0).sort(popularOrder).slice(0, TOP_LIMIT);

  function drawTop() {
    const host = $("#home-top-prizes");
    if (!host) return;
    const list = topPrizes();
    host.innerHTML = list.length ? `<div class="pz-grid">${list.map(centerCardHtml).join("")}</div>` : `<p class="empty">${t("prize.noPrizes")}</p>`;
  }

  function drawHome() {
    const host = $("#home-prizes");
    if (host) {
      const list = openList().sort((a, b) => countOf(b) - countOf(a) || recentOrder(a, b)).slice(0, 6);
      host.innerHTML = list.length ? gridHtml(list) : `<p class="empty">${t("prize.noPrizes")}</p>`;
    }
    drawTop();
  }

  // After a subscription the lists must show the new count. The catalog page redraws itself
  // (overview cards and search results); the home page redraws its two lists.
  function refreshLists() {
    if ($("#prize-root")) renderPage();
    else drawHome();
  }

  async function bootHome() {
    const host = $("#home-prizes");
    const topHost = $("#home-top-prizes");
    if (!host && !topHost) return;
    await Promise.all([loadCatalog(), loadModeData()]);
    if (sess()?.member_id) await loadMemberContext();
    if (!state.schemaOk) {
      const strip = $("#prizes-strip");
      if (strip) strip.hidden = true;
      if (topHost) topHost.innerHTML = `<p class="empty">${t("prize.needSql")}</p>`;
      return;
    }
    // The cards of the top list open the same dialog as the catalog.
    topHost?.addEventListener("click", (e) => {
      const card = e.target.closest("[data-open-prize]");
      if (card) openPrize(card.dataset.openPrize);
    });
    bindDialogKeys();
    drawHome();
    document.addEventListener("cineaura:prefs", drawHome);
  }

  document.addEventListener("DOMContentLoaded", () => {
    if ($("#prize-root")) bootPage();
    else bootHome();
  });
})();
