/* Staff panel — Prizes section with three tabs: add a prize, manage prizes
   (edit / end / delete / participants) and statistics.
   Loaded before panel.js; panel.js calls window.PanelPrizes.render(main, api). */
(() => {
  const C = window.CineAura;
  const R = window.PrizeRules;
  const { $, $$, supabaseRequest, restValue, toast, escapeHtml: esc, t, tr, avatarImg, hydrateAvatars, formatDate } = C;

  const S = {
    tab: "add",
    view: null, // { prizeId, mode, q } while looking at the participants of one prize
    api: null,
    main: null,
    sqlOk: true,
    prizes: [], groups: [], links: [], modes: [], conds: [], dates: [], codes: [], counts: {}, limits: null,
    entries: [], // entries of the prize being managed (loaded on demand)
  };

  const MODE_NAME = { gift: "Gift", challenge: "Challenge", lottery: "Lottery" };
  const modeLabel = (k) => tr(MODE_NAME[k] || k);
  const num = (v) => (v === "" || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
  const dateVal = (v) => (v ? String(v).slice(0, 10) : "");
  const today = () => new Date().toISOString().slice(0, 10);
  const ok = (res) => Boolean(res && res.ok);
  const rows = (res) => (ok(res) && Array.isArray(res.data) ? res.data : []);
  const post = (path, body, headers) => supabaseRequest(path, { method: "POST", body: JSON.stringify(body), headers });
  const patch = (path, body) => supabaseRequest(path, { method: "PATCH", body: JSON.stringify(body) });
  const del = (path) => supabaseRequest(path, { method: "DELETE" });
  const inIds = (arr) => `in.(${arr.map((x) => restValue(x)).join(",")})`;

  // ------------------------------------------------------------------ data
  const token = () => S.api?.staff?.token || "";
  // Staff RPC (sql/prize_secure.sql). Returns the function's JSON, or { ok:false, error } on failure.
  async function admin(fn, args = {}) {
    const res = await C.rpc(fn, { p_token: token(), ...args });
    if (res.ok && res.data && typeof res.data === "object") return res.data;
    const msg = String(res.data?.message || "");
    if (msg.includes("staff_auth")) return { ok: false, error: "staff_auth" };
    if (msg.includes("staff_forbidden")) return { ok: false, error: "staff_forbidden" };
    return { ok: false, error: "sql" };
  }

  async function load() {
    const [pr, gr, lk, md, cd, dt, lim, codes, over] = await Promise.all([
      supabaseRequest("/rest/v1/prizes?select=*&order=id.desc"),
      supabaseRequest("/rest/v1/prize_groups?select=*&order=sort_order.asc,id.asc"),
      supabaseRequest("/rest/v1/prize_group_links?select=*"),
      supabaseRequest("/rest/v1/prize_modes?select=*&order=sort_order.asc,id.asc"),
      supabaseRequest("/rest/v1/prize_mode_conditions?select=*&order=sort_order.asc,id.asc"),
      supabaseRequest("/rest/v1/prize_country_dates?select=*"),
      R.loadLimits(),
      admin("prize_admin_codes"),
      admin("prize_admin_overview"),
    ]);
    S.prizes = rows(pr);
    S.groups = rows(gr);
    S.links = rows(lk);
    S.modes = rows(md);
    S.conds = rows(cd);
    S.dates = rows(dt);
    S.limits = lim.limits;
    S.codes = Array.isArray(codes) ? codes : [];
    S.counts = {};
    (Array.isArray(over) ? over : []).forEach((r) => (S.counts[r.prize_id] = r));
    S.sqlOk = Array.isArray(codes) && Array.isArray(over) && ok(lk) && ok(dt);
    S.authError = !S.sqlOk && (codes?.error === "staff_auth" || over?.error === "staff_auth");
  }

  const modeOf = (pid, k) => S.modes.find((m) => m.prize_id === pid && R.lc(m.mode) === k);
  const prizeModes = (pid) => R.MODES.filter((k) => modeOf(pid, k));
  const prizeById = (id) => S.prizes.find((p) => String(p.id) === String(id));
  const isEnded = (p) => R.lc(p.status) === "ended";
  const groupName = (id) => S.groups.find((g) => g.id === id)?.name || "";
  const isBanned = (e) => Boolean(e.banned_until) && Date.parse(e.banned_until) > Date.now();

  function prizeState(p) {
    if (isEnded(p)) return "ended";
    const s = R.dayMs(p.starts_at);
    if (s !== null && s > Date.now()) return "upcoming";
    const e = !p.unlimited_time && p.ends_at ? R.dayMs(p.ends_at) + 86400000 : null;
    if (e !== null && e <= Date.now()) return "expired";
    return "active";
  }

  function modal(html) {
    $$(".modal-back").forEach((el) => el.remove());
    const wrap = document.createElement("div");
    wrap.className = "modal-back";
    wrap.innerHTML = `<section class="glass modal-card pza-modal">${html}</section>`;
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap || e.target.closest("[data-close]")) wrap.remove();
    });
    document.body.appendChild(wrap);
    return wrap;
  }

  // ------------------------------------------------------------------ form pieces
  const chipsHtml = (name, selected = []) => {
    const sel = R.list(selected).map(R.lc);
    return `<div class="pza-chipbox" data-chips="${name}">${R.COUNTRIES.map(
      (c) => `<label class="pza-chip"><input type="checkbox" value="${esc(c)}" ${sel.includes(R.lc(c)) ? "checked" : ""} /><span>${esc(tr(c))}</span></label>`
    ).join("")}</div>`;
  };
  const readChips = (root, name) => [...root.querySelectorAll(`[data-chips="${name}"] input:checked`)].map((i) => i.value);

  const tierSelect = (cls, value, anyLabel) =>
    `<select data-a="${cls}">${[["", anyLabel], ...R.TIERS.slice(1).map((x) => [x, tr(x)])]
      .map(([v, l]) => `<option value="${v}" ${v === (value || "") ? "selected" : ""}>${esc(l)}</option>`)
      .join("")}</select>`;

  // kind: "gift" (public/exclusive/private) | "challenge" | "lottery"
  function audienceHtml(kind, a = {}) {
    const typed = kind === "gift";
    const type = R.lc(a.type || "public");
    const exclusive = `
      <div class="stack pza-aud-ex" ${typed && type !== "exclusive" ? "hidden" : ""}>
        ${typed ? `<div class="pza-lbl">${t("pza.genders")}</div>
        <div class="chip-row">
          ${["male", "female"].map((g) => `<label class="lang-chip"><input type="checkbox" data-a-gender value="${g}" ${R.list(a.genders).map(R.lc).includes(g) ? "checked" : ""} /> ${esc(tr(g === "male" ? "Male" : "Female"))}</label>`).join("")}
        </div>` : ""}
        <div class="pza-lbl">${t(kind === "challenge" ? "pza.countriesOpt" : kind === "lottery" ? "pza.countriesReq" : "pza.countries")}</div>
        ${chipsHtml("countries", a.countries)}
        <div class="form-row">
          ${typed ? `<input data-a="min_age" type="number" min="0" placeholder="${t("pza.minAge")}" value="${a.min_age ?? ""}" />` : ""}
          <input data-a="max_age" type="number" min="0" placeholder="${t("pza.maxAge")}${kind === "lottery" ? " *" : ""}" value="${a.max_age ?? ""}" />
        </div>
        <div class="form-row">
          ${typed || kind === "lottery" ? `<input data-a="min_account_days" type="number" min="0" placeholder="${t("pza.minAccountDays")}${kind === "lottery" ? " *" : ""}" value="${a.min_account_days ?? ""}" />` : ""}
          ${kind === "challenge" ? `<input data-a="max_account_days" type="number" min="0" placeholder="${t("pza.maxAccountDays")}" value="${a.max_account_days ?? ""}" />` : ""}
          ${kind !== "gift" ? tierSelect("membership", a.membership, t(kind === "lottery" ? "pza.anyTier" : "pza.anyTierOpt")) : ""}
        </div>
      </div>`;
    return `
      <div class="pza-aud" data-aud="${kind}">
        ${typed ? `<select data-a="type">
          <option value="public" ${type === "public" ? "selected" : ""}>${t("pza.audPublic")}</option>
          <option value="exclusive" ${type === "exclusive" ? "selected" : ""}>${t("pza.audExclusive")}</option>
          <option value="private" ${type === "private" ? "selected" : ""}>${t("pza.audPrivate")}</option>
        </select>` : ""}
        ${exclusive}
        ${typed ? `<div class="stack pza-aud-pv" ${type !== "private" ? "hidden" : ""}>
          <textarea data-a="member_ids" placeholder="${t("pza.memberIds")}">${esc(R.list(a.member_ids).join(", "))}</textarea>
        </div>` : ""}
      </div>`;
  }

  function readAudience(root, kind) {
    const box = root.querySelector(`[data-aud="${kind}"]`);
    const g = (k) => box.querySelector(`[data-a="${k}"]`);
    const a = { type: kind === "gift" ? g("type").value : "exclusive" };
    if (a.type === "private") a.member_ids = R.list(g("member_ids").value);
    if (a.type === "exclusive") {
      a.countries = readChips(box, "countries");
      if (kind === "gift") a.genders = [...box.querySelectorAll("[data-a-gender]:checked")].map((i) => i.value);
      ["min_age", "max_age", "min_account_days", "max_account_days"].forEach((k) => { if (g(k)) a[k] = num(g(k).value); });
      if (g("membership")) a.membership = g("membership").value || "";
    }
    return a;
  }

  const dateRowHtml = (r = {}) => `
    <div class="form-row pza-row" data-date-row>
      <select data-d="country">
        <option value="">${t("pza.chooseCountry")}</option>
        ${R.COUNTRIES.map((c) => `<option value="${esc(c)}" ${R.lc(r.country) === R.lc(c) ? "selected" : ""}>${esc(tr(c))}</option>`).join("")}
      </select>
      <input data-d="start" type="date" value="${dateVal(r.starts_at)}" title="${t("pza.startDate")}" />
      <input data-d="end" type="date" value="${dateVal(r.ends_at)}" title="${t("pza.endDateOpt")}" />
      <button class="btn btn-sm btn-danger" data-d-del type="button">×</button>
    </div>`;

  const codeRowHtml = (c = {}) => `
    <div class="pza-code" data-code-row data-id="${c.id || ""}">
      <div class="form-row">
        <input data-k="code" placeholder="${t("pza.code")}" value="${esc(c.code || "")}" />
        <button class="btn btn-sm btn-ghost" data-code-gen type="button">${t("pza.generate")}</button>
        <input data-k="percent" type="number" min="10" max="80" placeholder="${t("pza.percent")}" value="${c.percent ?? ""}" />
      </div>
      <div class="form-row">
        <input data-k="expires" type="date" title="${t("pza.codeExpires")}" value="${dateVal(c.expires_at)}" />
        <input data-k="max_uses" type="number" min="1" placeholder="${t("pza.codeMaxUses")}" value="${c.max_uses ?? ""}" />
      </div>
      ${audienceHtml("gift", {
        type: c.audience, countries: c.countries, genders: c.genders, min_age: c.min_age, max_age: c.max_age,
        min_account_days: c.min_account_days, member_ids: c.member_ids,
      })}
      <button class="btn btn-sm btn-danger" data-code-del type="button">${t("common.delete")}</button>
    </div>`;

  const reqField = (key, label, v, required) =>
    `<label class="pza-field"><span>${t(label)}${required ? " *" : ""}</span><input data-c="${key}" type="number" min="0" value="${v ?? ""}" /></label>`;

  // prefill = { prize, modes:{gift,challenge,lottery}, conds:[], dates:[], codes:[] } or null
  function formHtml(pre) {
    const p = pre?.prize || {};
    const m = pre?.modes || {};
    const cfg = (k) => R.cfgOf(m[k]);
    const condVal = (k, kind) => {
      const row = (pre?.conds || []).find((c) => c.mode_id === m[k]?.id && c.kind === kind);
      return row ? row.required : "";
    };
    const tmdbVal = (k, type) =>
      (pre?.conds || []).filter((c) => c.mode_id === m[k]?.id && c.kind === "watch" && c.media_type === type).map((c) => c.tmdb_id).join(", ");
    const on = (k) => (pre ? Boolean(m[k]) : k === "gift");
    const cats = pre ? R.list(p.categories || groupName(p.group_id)) : [];
    const lot = cfg("lottery");
    const lotReq = (kind) => (m.lottery ? condVal("lottery", kind) || 0 : "");
    return `
      <div class="stack pza-form" data-form>
        <input data-f="title" placeholder="${t("pza.title")} *" value="${esc(p.title || "")}" />
        <textarea data-f="description" placeholder="${t("pza.description")} *">${esc(p.description || "")}</textarea>
        <textarea data-f="images" placeholder="${t("pza.images")}">${esc(String(p.images || "").trim())}</textarea>
        <input data-f="video" placeholder="${t("pza.video")}" value="${esc(p.video_url || "")}" />
        <input data-f="categories" list="pza-cats" placeholder="${t("pza.categories")} *" value="${esc(cats.join(", "))}" />
        <datalist id="pza-cats">${S.groups.map((g) => `<option value="${esc(g.name)}"></option>`).join("")}</datalist>

        <div class="pza-lbl">${t("pza.dates")}</div>
        <div class="form-row">
          <label class="pza-field"><span>${t("pza.startDate")} *</span><input data-f="start" type="date" value="${dateVal(p.starts_at)}" /></label>
          <label class="pza-field"><span>${t("pza.endDateOpt")}</span><input data-f="end" type="date" value="${p.unlimited_time ? "" : dateVal(p.ends_at)}" /></label>
        </div>
        <p class="muted">${t("pza.datesHint")}</p>
        <div data-dates>${(pre?.dates || []).map(dateRowHtml).join("")}</div>
        <button class="btn btn-sm btn-ghost" data-d-add type="button">+ ${t("pza.addCountryDate")}</button>

        <div class="pza-lbl">${t("pza.modesPick")} *</div>
        <div class="chip-row">
          ${R.MODES.map((k) => `<label class="lang-chip"><input type="checkbox" data-mode-on="${k}" ${on(k) ? "checked" : ""} /> ${esc(modeLabel(k))}</label>`).join("")}
        </div>

        <fieldset class="pza-mode" data-mode="gift" ${on("gift") ? "" : "hidden"}>
          <legend>${esc(modeLabel("gift"))}</legend>
          <div class="form-row">
            <label class="pza-field"><span>${t("pza.maxWinners")} *</span><input data-m="quantity" type="number" min="1" value="${m.gift?.quantity ?? ""}" /></label>
            <label class="pza-field"><span>${t("pza.pointsRequired")} *</span><input data-m="points_cost" type="number" min="1" value="${m.gift?.points_cost ?? ""}" /></label>
          </div>
          <div class="pza-lbl">${t("pza.audience")}</div>
          ${audienceHtml("gift", cfg("gift").audience)}
          <div class="pza-lbl">${t("pza.discountCodes")}</div>
          <p class="muted">${t("pza.codesHint")}</p>
          <div data-codes>${(pre?.codes || []).map(codeRowHtml).join("")}</div>
          <button class="btn btn-sm btn-ghost" data-code-add type="button">+ ${t("pza.addCode")}</button>
        </fieldset>

        <fieldset class="pza-mode" data-mode="challenge" ${on("challenge") ? "" : "hidden"}>
          <legend>${esc(modeLabel("challenge"))}</legend>
          <div class="form-row">
            <label class="pza-field"><span>${t("pza.maxWinners")} *</span><input data-m="quantity" type="number" min="1" value="${m.challenge?.quantity ?? ""}" /></label>
            <label class="pza-field"><span>${t("pza.durationDays")} *</span><input data-m="days" type="number" min="1" value="${cfg("challenge").days ?? ""}" /></label>
            <label class="pza-field"><span>${t("pza.joinPoints")} *</span><input data-m="points_cost" type="number" min="0" value="${m.challenge?.points_cost ?? ""}" /></label>
          </div>
          <div class="pza-lbl">${t("pza.requirementsOpt")}</div>
          <div class="pza-grid">
            ${reqField("link_shares", "pza.reqLinkShares", condVal("challenge", "link_shares"))}
            ${reqField("watch_minutes", "pza.reqMinutes", condVal("challenge", "watch_minutes"))}
            ${reqField("playlists", "pza.reqPlaylists", condVal("challenge", "playlists"))}
            ${reqField("recommendations", "pza.reqRecs", condVal("challenge", "recommendations"))}
            ${reqField("comments", "pza.reqComments", condVal("challenge", "comments"))}
            ${reqField("movies", "pza.reqMovies", condVal("challenge", "movies"))}
            ${reqField("series", "pza.reqSeries", condVal("challenge", "series"))}
            ${reqField("follows", "pza.reqFollows", condVal("challenge", "follows"))}
          </div>
          <input data-m="movies" placeholder="${t("pza.movieIds")}" value="${esc(tmdbVal("challenge", "movie"))}" />
          <input data-m="series" placeholder="${t("pza.seriesIds")}" value="${esc(tmdbVal("challenge", "tv"))}" />
          <div class="pza-lbl">${t("pza.audience")}</div>
          ${audienceHtml("challenge", cfg("challenge").audience)}
        </fieldset>

        <fieldset class="pza-mode" data-mode="lottery" ${on("lottery") ? "" : "hidden"}>
          <legend>${esc(modeLabel("lottery"))}</legend>
          <div class="form-row">
            <label class="pza-field"><span>${t("pza.joinPoints")} *</span><input data-m="points_cost" type="number" min="0" value="${m.lottery?.points_cost ?? ""}" /></label>
            <label class="pza-field"><span>${t("pza.minSubscribers")} *</span><input data-m="draw_at" type="number" min="1" value="${m.lottery?.draw_at ?? ""}" /></label>
            <label class="pza-field"><span>${t("pza.winnersCount")} *</span><input data-m="winners_needed" type="number" min="1" value="${m.lottery?.winners_needed ?? ""}" /></label>
          </div>
          <div class="form-row">
            <label class="pza-field"><span>${t("pza.opensAt")} *</span><input data-m="opens_at" type="date" value="${dateVal(m.lottery?.starts_at)}" /></label>
            <label class="pza-field"><span>${t("pza.drawDateOpt")}</span><input data-m="draw_on" type="date" value="${dateVal(lot.draw_on)}" /></label>
          </div>
          <div class="pza-lbl">${t("pza.requirementsReq")}</div>
          <div class="pza-grid">
            ${reqField("link_shares", "pza.reqLinkShares", lotReq("link_shares"), true)}
            ${reqField("watch_minutes", "pza.reqMinutes", lotReq("watch_minutes"), true)}
            ${reqField("playlists", "pza.reqPlaylists", lotReq("playlists"), true)}
            ${reqField("recommendations", "pza.reqRecs", lotReq("recommendations"), true)}
            ${reqField("comments", "pza.reqComments", lotReq("comments"), true)}
            ${reqField("movies", "pza.reqMovies", lotReq("movies"), true)}
            ${reqField("series", "pza.reqSeries", lotReq("series"), true)}
            ${reqField("follows", "pza.reqFollows", lotReq("follows"), true)}
          </div>
          <div class="pza-lbl">${t("pza.audience")}</div>
          ${audienceHtml("lottery", lot.audience)}
        </fieldset>
      </div>`;
  }

  // Random code that exists neither in the database nor in the form being edited.
  async function fillRandomCode(root, row, btn) {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no look-alike characters
    const taken = new Set(S.codes.map((c) => String(c.code).toUpperCase()));
    root.querySelectorAll('[data-k="code"]').forEach((i) => i.value && taken.add(i.value.trim().toUpperCase()));
    btn.disabled = true;
    try {
      for (let tries = 0; tries < 20; tries++) {
        const bytes = crypto.getRandomValues(new Uint8Array(8));
        const code = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
        if (taken.has(code)) continue;
        // Fresh check in case another staff member created codes since this page loaded.
        const fresh = await admin("prize_admin_codes");
        if (Array.isArray(fresh)) {
          fresh.forEach((c) => taken.add(String(c.code).toUpperCase()));
          if (taken.has(code)) continue;
        }
        row.querySelector('[data-k="code"]').value = code;
        return;
      }
      toast(t("pza.genFail"));
    } finally {
      btn.disabled = false;
    }
  }

  function wireForm(root) {
    root.addEventListener("change", (e) => {
      const on = e.target.closest("[data-mode-on]");
      if (on) root.querySelector(`[data-mode="${on.dataset.modeOn}"]`).hidden = !on.checked;
      const type = e.target.closest('[data-a="type"]');
      if (type) {
        const box = type.closest("[data-aud]");
        box.querySelector(".pza-aud-ex").hidden = type.value !== "exclusive";
        box.querySelector(".pza-aud-pv").hidden = type.value !== "private";
      }
    });
    root.addEventListener("click", (e) => {
      if (e.target.closest("[data-d-add]")) root.querySelector("[data-dates]").insertAdjacentHTML("beforeend", dateRowHtml());
      else if (e.target.closest("[data-d-del]")) e.target.closest("[data-date-row]").remove();
      else if (e.target.closest("[data-code-add]")) root.querySelector("[data-codes]").insertAdjacentHTML("beforeend", codeRowHtml());
      else if (e.target.closest("[data-code-del]")) e.target.closest("[data-code-row]").remove();
      else if (e.target.closest("[data-code-gen]")) fillRandomCode(root, e.target.closest("[data-code-row]"), e.target.closest("[data-code-gen]"));
    });
  }

  // ------------------------------------------------------------------ read + validate
  const fail = (key, vars) => ({ error: t(key, vars) });

  function readForm(root) {
    const f = (k) => root.querySelector(`[data-f="${k}"]`).value.trim();
    const title = f("title");
    const description = f("description");
    if (!title || !description) return fail("pza.errTitle");
    const categories = [...new Set(R.list(f("categories")))];
    if (!categories.length) return fail("pza.errCategory");
    const start = f("start");
    if (!start) return fail("pza.errStart");
    const end = f("end") || null;
    if (end && end < start) return fail("pza.errEndBefore");

    const dates = [];
    for (const row of root.querySelectorAll("[data-date-row]")) {
      const country = row.querySelector('[data-d="country"]').value;
      const s = row.querySelector('[data-d="start"]').value;
      const e = row.querySelector('[data-d="end"]').value || null;
      if (!country && !s && !e) continue;
      if (!country || !s) return fail("pza.errCountryDate");
      if (e && e < s) return fail("pza.errEndBefore");
      if (dates.some((d) => R.lc(d.country) === R.lc(country))) return fail("pza.errCountryDup");
      dates.push({ country, starts_at: s, ends_at: e });
    }

    const enabled = R.MODES.filter((k) => root.querySelector(`[data-mode-on="${k}"]`).checked);
    if (!enabled.length) return fail("pza.errMode");

    const modes = {};
    const conds = [];
    const codes = [];
    const box = (k) => root.querySelector(`[data-mode="${k}"]`);
    const mv = (k, key) => num(box(k).querySelector(`[data-m="${key}"]`)?.value);
    const cv = (k, key) => num(box(k).querySelector(`[data-c="${key}"]`)?.value);
    const need = (v, min = 0) => v !== null && v >= min;

    if (enabled.includes("gift")) {
      const quantity = mv("gift", "quantity");
      const points = mv("gift", "points_cost");
      if (!need(quantity, 1) || !need(points, 1)) return fail("pza.errGift");
      const audience = readAudience(box("gift"), "gift");
      if (audience.type === "private" && !audience.member_ids.length) return fail("pza.errPrivate");
      modes.gift = { quantity, points_cost: points, audience };
      for (const row of box("gift").querySelectorAll("[data-code-row]")) {
        const k = (key) => row.querySelector(`[data-k="${key}"]`).value.trim();
        const code = k("code");
        if (!code && !k("percent")) continue;
        const percent = num(k("percent"));
        if (!code || !/^[A-Za-z0-9_-]{3,32}$/.test(code)) return fail("pza.errCode");
        if (percent === null || percent < 10 || percent > 80 || !Number.isInteger(percent)) return fail("pza.errPercent");
        if (codes.some((c) => c.code.toUpperCase() === code.toUpperCase())) return fail("pza.errCodeDup");
        const a = readAudience(row, "gift");
        if (a.type === "private" && !a.member_ids.length) return fail("pza.errPrivate");
        codes.push({
          id: row.dataset.id ? Number(row.dataset.id) : null,
          code, percent,
          expires_at: k("expires") ? `${k("expires")}T23:59:59` : null,
          max_uses: num(k("max_uses")),
          audience: a.type,
          countries: (a.countries || []).join(","),
          genders: (a.genders || []).join(","),
          min_age: a.min_age ?? null,
          max_age: a.max_age ?? null,
          min_account_days: a.min_account_days ?? null,
          member_ids: (a.member_ids || []).join(","),
        });
      }
    }

    if (enabled.includes("challenge")) {
      const quantity = mv("challenge", "quantity");
      const days = mv("challenge", "days");
      const points = mv("challenge", "points_cost");
      if (!need(quantity, 1) || !need(days, 1) || !need(points, 0)) return fail("pza.errChallenge");
      const audience = readAudience(box("challenge"), "challenge");
      modes.challenge = { quantity, days, points_cost: points, audience };
      ["link_shares", "watch_minutes", "playlists", "recommendations", "comments", "movies", "series", "follows"].forEach((kind) => {
        const v = cv("challenge", kind);
        if (v) conds.push({ mode: "challenge", kind, required: v });
      });
      for (const [key, type] of [["movies", "movie"], ["series", "tv"]]) {
        for (const raw of R.list(box("challenge").querySelector(`[data-m="${key}"]`).value)) {
          const id = Number(raw);
          if (!Number.isInteger(id) || id <= 0) return fail("pza.errTmdb", { v: raw });
          conds.push({ mode: "challenge", kind: "watch", media_type: type, tmdb_id: id, required: 1 });
        }
      }
    }

    if (enabled.includes("lottery")) {
      const points = mv("lottery", "points_cost");
      const drawAt = mv("lottery", "draw_at");
      const winners = mv("lottery", "winners_needed");
      const opens = box("lottery").querySelector('[data-m="opens_at"]').value;
      if (!need(points, 0) || !need(drawAt, 1) || !need(winners, 1) || !opens) return fail("pza.errLottery");
      const reqs = ["link_shares", "watch_minutes", "playlists", "recommendations", "comments", "movies", "series", "follows"];
      for (const kind of reqs) {
        const v = cv("lottery", kind);
        if (v === null || v < 0) return fail("pza.errLotteryReq");
        if (v > 0) conds.push({ mode: "lottery", kind, required: v });
      }
      const audience = readAudience(box("lottery"), "lottery");
      if (!audience.countries.length || audience.min_account_days === null || audience.max_age === null) return fail("pza.errLotteryAud");
      modes.lottery = {
        points_cost: points, draw_at: drawAt, winners_needed: winners, opens_at: opens,
        draw_on: box("lottery").querySelector('[data-m="draw_on"]').value || null, audience,
      };
    }

    return {
      data: {
        title, description, categories, start, end, dates, modes, conds, codes,
        images: f("images").split(/[\r\n]+/).map((x) => x.trim()).filter(Boolean),
        video: f("video"),
      },
    };
  }

  // ------------------------------------------------------------------ write
  // The server validates again (and does everything in one transaction); this maps its answer to a message.
  const SERVER_ERR = {
    title: "pza.errTitle", category: "pza.errCategory", start: "pza.errStart", end_before_start: "pza.errEndBefore",
    mode: "pza.errMode", gift: "pza.errGift", challenge: "pza.errChallenge", lottery: "pza.errLottery",
    code: "pza.errCode", percent: "pza.errPercent", duplicate: "pza.errCodeDup", country_date: "pza.errCountryDate",
    staff_auth: "pza.errAuth", staff_forbidden: "pza.errForbidden", not_ended: "pza.deleteNeedsEnd",
  };
  function serverError(err) {
    const e = String(err || "");
    if (e.startsWith("mode_has_entries:")) return t("pza.errModeHasEntries", { mode: modeLabel(e.split(":")[1]) });
    return t(SERVER_ERR[e] || "pza.errSql");
  }

  async function savePrize(id, d) {
    const res = await admin("prize_admin_save", { p_id: id, d });
    return res.ok ? { id: res.id } : { error: serverError(res.error) };
  }
  const createPrize = (d) => savePrize(null, d);
  const updatePrize = (id, d) => savePrize(id, d);

  // ------------------------------------------------------------------ shell
  function shell(body) {
    const tabs = [["add", "pza.tabAdd"], ["manage", "pza.tabManage"], ["stats", "pza.tabStats"]];
    S.main.onclick = null;
    S.main.innerHTML = `
      <p class="eyebrow">${t("panel.nav.prizes")}</p>
      <h1>${t("panel.prizesTitle")}</h1>
      ${S.sqlOk ? "" : `<p class="empty">${t(S.authError ? "pza.errAuth" : "pza.needSql")}</p>`}
      <div class="pza-tabs" role="tablist">
        ${tabs.map(([k, label]) => `<button type="button" role="tab" data-tab="${k}" class="${S.tab === k ? "active" : ""}">${t(label)}</button>`).join("")}
      </div>
      <div id="pza-body">${body}</div>`;
    $$(".pza-tabs [data-tab]", S.main).forEach((b) => {
      b.onclick = () => { S.tab = b.dataset.tab; S.view = null; draw(); };
    });
    hydrateAvatars(S.main);
  }

  function draw() {
    if (S.tab === "add") return drawAdd();
    if (S.tab === "manage") return S.view ? drawParticipants() : drawManage();
    return drawStats();
  }

  // ------------------------------------------------------------------ tab 1: add
  function drawAdd() {
    shell(`${formHtml(null)}<button class="btn btn-lg btn-primary" id="pza-save" type="button">${t("panel.addPrize")}</button>`);
    const root = $("[data-form]", S.main);
    wireForm(root);
    $("#pza-save").onclick = async (e) => {
      const r = readForm(root);
      if (r.error) return toast(r.error);
      e.target.disabled = true;
      const res = await createPrize(r.data);
      e.target.disabled = false;
      if (res.error) return toast(res.error);
      toast(t("panel.prizeAdded"));
      await load();
      S.tab = "manage";
      draw();
    };
  }

  // ------------------------------------------------------------------ tab 2: manage
  const badge = (cls, text) => `<span class="pza-badge ${cls}">${esc(text)}</span>`;

  function drawManage() {
    const cards = S.prizes.map((p) => {
      const st = prizeState(p);
      const cnt = S.counts[p.id] || { entries: 0, winners: 0 };
      return `
        <div class="mini-card pza-prize" data-open="${p.id}">
          <div class="pza-prize-head">
            <h3>${esc(p.title)}</h3>
            ${badge(`st-${st}`, t(`pza.state.${st}`))}
          </div>
          <p class="muted">${esc(R.list(p.categories || groupName(p.group_id)).join(" · "))}</p>
          <p class="pza-meta">
            ${prizeModes(p.id).map((k) => badge("mode", modeLabel(k))).join(" ")}
            <span>${t("pza.participants", { n: cnt.entries })}</span> · <span>${t("pza.winnersN", { n: cnt.winners })}</span>
            · <span>${dateVal(p.starts_at)}${p.ends_at && !p.unlimited_time ? ` → ${dateVal(p.ends_at)}` : ""}</span>
          </p>
          <div class="pza-actions">
            <button class="btn btn-sm btn-primary" data-open="${p.id}" type="button">${t("pza.manageMembers")}</button>
            <button class="btn btn-sm btn-ghost" data-edit="${p.id}" type="button">${t("pza.edit")}</button>
            ${isEnded(p) ? "" : `<button class="btn btn-sm btn-ghost" data-end="${p.id}" type="button">${t("pza.end")}</button>`}
            <button class="btn btn-sm btn-danger" data-del="${p.id}" type="button" ${isEnded(p) ? "" : "disabled"} title="${isEnded(p) ? "" : esc(t("pza.deleteNeedsEnd"))}">${t("common.delete")}</button>
            <a class="btn btn-sm btn-ghost" href="./Prize.html?GroupPrize=${p.group_id ?? 0}&Prize=${p.id}" target="_blank" rel="noopener">${t("panel.pz.openPage")}</a>
          </div>
        </div>`;
    }).join("");

    const limitsGrid = `
      <details class="pza-details"><summary>${t("pza.limitsTitle")}</summary>
        <p class="muted">${t("pza.limitsHint")}</p>
        <div class="pza-limits">
          <span></span>${R.MODES.map((k) => `<b>${esc(modeLabel(k))}</b>`).join("")}
          ${R.TIERS.map((tier) => `<b>${esc(tr(tier))}</b>${R.MODES.map((k) => {
            const [cap, period] = S.limits[tier][k];
            return `<label><input type="number" min="0" data-lim="${tier}|${k}" value="${cap}" /><small>${t(`pza.period.${period}`)}</small></label>`;
          }).join("")}`).join("")}
        </div>
        <button class="btn btn-sm btn-primary" id="pza-lim-save" type="button">${t("common.save")}</button>
      </details>`;

    const groupsBox = `
      <details class="pza-details"><summary>${t("panel.pz.groupsTitle")} (${S.groups.length})</summary>
        <div class="form-row">
          <input id="pza-g-name" placeholder="${t("panel.pz.groupName")}" />
          <input id="pza-g-thumb" placeholder="${t("panel.pz.groupThumb")}" />
          <button class="btn btn-sm btn-primary" id="pza-g-add" type="button">${t("panel.pz.addGroup")}</button>
        </div>
        ${S.groups.map((g) => `
          <div class="form-row pza-grow">
            <span style="flex:1">${esc(g.name)} <span class="muted">· ID ${g.id}${g.visible === false ? ` · ${t("panel.pz.hidden")}` : ""}</span></span>
            <button class="btn btn-sm btn-ghost" data-g-toggle="${g.id}" data-vis="${g.visible === false ? 0 : 1}" type="button">${g.visible === false ? t("panel.pz.show") : t("panel.pz.hide")}</button>
            <button class="btn btn-sm btn-danger" data-g-del="${g.id}" type="button">${t("common.delete")}</button>
          </div>`).join("")}
      </details>`;

    shell(`${cards || `<p class="empty">${t("dash.noPrizes")}</p>`}${limitsGrid}${groupsBox}`);

    S.main.onclick = async (e) => {
      const b = (sel) => e.target.closest(sel);
      if (b("[data-tab]")) return;
      const edit = b("[data-edit]");
      if (edit) return openEdit(Number(edit.dataset.edit));
      const end = b("[data-end]");
      if (end) {
        if (!confirm(t("pza.confirmEnd"))) return;
        const r = await admin("prize_admin_end", { p_id: Number(end.dataset.end) });
        if (!r.ok) return toast(serverError(r.error));
        toast(t("pza.ended"));
        await load();
        return draw();
      }
      const rm = b("[data-del]");
      if (rm) {
        const p = prizeById(rm.dataset.del);
        if (!p || !isEnded(p)) return toast(t("pza.deleteNeedsEnd"));
        if (!confirm(t("pza.confirmDelete"))) return;
        const r = await admin("prize_admin_delete", { p_id: p.id });
        if (!r.ok) return toast(serverError(r.error));
        toast(t("common.remove"));
        await load();
        return draw();
      }
      const open = b("[data-open]");
      if (open && !b("a")) {
        S.view = { prizeId: Number(open.dataset.open), mode: "all", q: "" };
        return draw();
      }
      if (b("#pza-lim-save")) {
        const payload = [...S.main.querySelectorAll("[data-lim]")].map((i) => {
          const [tier, mode] = i.dataset.lim.split("|");
          return { tier, mode, limit_count: Math.max(0, Number(i.value) || 0) };
        });
        const r = await admin("prize_admin_limits", { p_rows: payload });
        if (!r.ok) return toast(serverError(r.error));
        toast(t("pza.limitsSaved"));
        return load();
      }
      if (b("#pza-g-add")) {
        const name = $("#pza-g-name").value.trim();
        if (!name) return toast(t("panel.pz.needGroupName"));
        const r = await admin("prize_admin_group", { p_op: "add", p_id: null, p_name: name, p_thumb: $("#pza-g-thumb").value.trim(), p_visible: true });
        if (!r.ok) return toast(serverError(r.error));
        toast(t("panel.pz.groupAdded"));
        await load();
        return draw();
      }
      const tog = b("[data-g-toggle]");
      if (tog) {
        const r = await admin("prize_admin_group", { p_op: "visible", p_id: Number(tog.dataset.gToggle), p_name: null, p_thumb: null, p_visible: tog.dataset.vis === "0" });
        if (!r.ok) return toast(serverError(r.error));
        await load();
        return draw();
      }
      const dg = b("[data-g-del]");
      if (dg) {
        if (!confirm(t("panel.pz.confirmDelGroup"))) return;
        const r = await admin("prize_admin_group", { p_op: "delete", p_id: Number(dg.dataset.gDel), p_name: null, p_thumb: null, p_visible: null });
        if (!r.ok) return toast(serverError(r.error));
        await load();
        draw();
      }
    };
  }

  function openEdit(id) {
    const p = prizeById(id);
    if (!p) return;
    const modes = {};
    prizeModes(id).forEach((k) => (modes[k] = modeOf(id, k)));
    const pre = {
      prize: p,
      modes,
      conds: S.conds.filter((c) => Object.values(modes).some((m) => m.id === c.mode_id)),
      dates: S.dates.filter((d) => d.prize_id === id),
      codes: S.codes.filter((c) => c.prize_id === id),
    };
    const wrap = modal(`
      <div class="form-row"><h2 style="flex:1">${t("pza.edit")} · ${esc(p.title)}</h2>
        <button class="btn btn-sm btn-ghost" data-close type="button">${t("common.close")}</button></div>
      ${formHtml(pre)}
      <button class="btn btn-lg btn-primary" id="pza-update" type="button">${t("common.save")}</button>`);
    const root = $("[data-form]", wrap);
    wireForm(root);
    $("#pza-update", wrap).onclick = async (e) => {
      const r = readForm(root);
      if (r.error) return toast(r.error);
      e.target.disabled = true;
      const res = await updatePrize(id, r.data);
      e.target.disabled = false;
      if (res.error) return toast(res.error);
      wrap.remove();
      toast(t("pza.saved"));
      await load();
      draw();
    };
  }

  // ------------------------------------------------------------------ participants
  const statusOf = (e) => (isBanned(e) ? "banned" : R.lc(e.status || "competitor"));

  async function drawParticipants() {
    const p = prizeById(S.view.prizeId);
    if (!p) { S.view = null; return draw(); }
    shell(`<p class="muted">${t("common.loading")}</p>`);
    S.entries = rows(await supabaseRequest(`/rest/v1/prize_mode_entries?prize_id=eq.${p.id}&select=*&order=id.asc&limit=3000`));
    const all = S.entries;
    const ids = [...new Set(all.map((e) => e.member_id))];
    const [mem, prof] = await Promise.all([
      ids.length ? supabaseRequest(`/rest/v1/members?member_id=${inIds(ids)}&select=member_id,username,full_name,country,gender,membership_type,created_at,status`) : { ok: true, data: [] },
      ids.length ? supabaseRequest(`/rest/v1/profiles?member_id=${inIds(ids)}&select=member_id,username`) : { ok: true, data: [] },
    ]);
    const people = {};
    rows(prof).forEach((r) => (people[r.member_id] = { ...r }));
    rows(mem).forEach((r) => (people[r.member_id] = { ...(people[r.member_id] || {}), ...r }));
    // Progress of the required actions, counted from each member's own join date.
    const sinceBy = {};
    all.forEach((e) => (sinceBy[e.member_id] = e.created_at));
    const counts = await R.activityCounts(ids, sinceBy);
    const progressOf = (e) => {
      const cs = S.conds.filter((c) => c.mode_id === e.mode_id);
      if (!cs.length) return null;
      const done = cs.filter((c) => R.conditionProgress(c, counts[e.member_id]).done).length;
      return Math.round((done / cs.length) * 100);
    };
    const f = S.view;
    const list = all.filter((e) => (f.mode === "all" || R.lc(e.mode) === f.mode)).filter((e) => {
      if (!f.q) return true;
      const q = R.lc(f.q);
      const pe = people[e.member_id] || {};
      return R.lc(e.member_id).includes(q) || R.lc(pe.username).includes(q);
    });

    const body = `
      <div class="form-row">
        <button class="btn btn-sm btn-ghost" id="pza-back" type="button">← ${t("pza.back")}</button>
        <h2 style="flex:1;margin:0">${esc(p.title)}</h2>
      </div>
      <div class="pza-filters">
        <div class="chip-row">
          ${["all", ...prizeModes(p.id)].map((k) => `<button type="button" class="lang-chip ${f.mode === k ? "on" : ""}" data-pm="${k}">${k === "all" ? t("common.all") : esc(modeLabel(k))}</button>`).join("")}
        </div>
        <input id="pza-q" placeholder="${t("pza.searchMember")}" value="${esc(f.q)}" />
      </div>
      ${list.map((e) => {
        const pe = people[e.member_id] || {};
        const st = statusOf(e);
        const pr = progressOf(e);
        return `
        <div class="pza-member" data-entry="${e.id}">
          <div class="pza-member-main" data-info="${e.id}">
            ${avatarImg(e.member_id, pe.username, pe.username || e.member_id)}
            <div><strong>${esc(pe.username || e.member_id)}</strong>
              <div class="muted">${esc(e.member_id)} · ${esc(modeLabel(R.lc(e.mode)))} · ${esc(t("pza.paid", { n: e.points_paid || 0 }))}</div></div>
            ${badge(`es-${st}`, t(`pza.status.${st}`))}
          </div>
          ${pr === null ? "" : `<div class="pza-bar" title="${pr}%"><i style="width:${pr}%"></i><span>${pr}%</span></div>`}
          ${isBanned(e) ? `<p class="muted">${t("pza.bannedUntil", { d: formatDate(e.banned_until) })}</p>` : ""}
          <div class="pza-actions">
            ${st === "winner" ? "" : `<button class="btn btn-sm btn-primary" data-act="winner" data-id="${e.id}" type="button">${t("pza.setWinner")}</button>`}
            ${st === "excluded" ? "" : `<button class="btn btn-sm btn-ghost" data-act="excluded" data-id="${e.id}" type="button">${t("pza.exclude")}</button>`}
            ${isBanned(e) ? `<button class="btn btn-sm btn-ghost" data-act="unban" data-id="${e.id}" type="button">${t("pza.unban")}</button>` : `<button class="btn btn-sm btn-danger" data-act="ban" data-id="${e.id}" type="button">${t("pza.ban")}</button>`}
            ${["excluded", "winner"].includes(st) ? `<button class="btn btn-sm btn-ghost" data-act="competitor" data-id="${e.id}" type="button">${t("pza.reinstate")}</button>` : ""}
          </div>
        </div>`;
      }).join("") || `<p class="empty">${t("pza.noParticipants")}</p>`}`;
    $("#pza-body", S.main).innerHTML = body;
    hydrateAvatars(S.main);

    if (S._refocus) {
      const q = $("#pza-q");
      q.focus();
      q.setSelectionRange(q.value.length, q.value.length);
      S._refocus = false;
    }
    $("#pza-back").onclick = () => { S.view = null; draw(); };
    $("#pza-q").oninput = (ev) => { S.view.q = ev.target.value; S._refocus = true; clearTimeout(S._qt); S._qt = setTimeout(drawParticipants, 250); };
    S.main.onclick = async (ev) => {
      const pm = ev.target.closest("[data-pm]");
      if (pm) { S.view.mode = pm.dataset.pm; return drawParticipants(); }
      const info = ev.target.closest("[data-info]");
      if (info) return memberInfo(all.find((x) => String(x.id) === info.dataset.info), people, counts);
      const act = ev.target.closest("[data-act]");
      if (act) {
        const entry = all.find((x) => String(x.id) === act.dataset.id);
        await applyAction(entry, act.dataset.act);
        await load();
        drawParticipants();
      }
    };
  }

  async function applyAction(entry, act) {
    let days = null;
    if (act === "ban") {
      days = Math.floor(Number(prompt(t("pza.banDays"), "7")));
      if (!Number.isFinite(days) || days <= 0) return;
    }
    const by = S.api.staff?.member_id || S.api.staff?.username || S.api.staff?.role || "";
    const r = await admin("prize_admin_entry", { p_entry: entry.id, p_action: act, p_days: days, p_by: by });
    if (!r.ok) return toast(serverError(r.error));
    toast(t("panel.verdictApplied"));
  }

  async function memberInfo(entry, people, counts) {
    const pe = people[entry.member_id] || {};
    const all = rows(await supabaseRequest(`/rest/v1/prize_mode_entries?member_id=eq.${restValue(entry.member_id)}&select=*&order=id.desc&limit=500`));
    const title = (e) => prizeById(e.prize_id)?.title || `#${e.prize_id}`;
    const group = (st) => all.filter((e) => R.lc(e.status) === st);
    const joined = all.filter((e) => !["winner", "withdrawn"].includes(R.lc(e.status)));
    const cs = S.conds.filter((c) => c.mode_id === entry.mode_id);
    const c = counts[entry.member_id];
    const li = (arr) => arr.map((e) => `<li>${esc(title(e))} <span class="muted">· ${esc(modeLabel(R.lc(e.mode)))}</span></li>`).join("") || `<li class="muted">${t("common.none")}</li>`;
    modal(`
      <div class="form-row"><h2 style="flex:1">${esc(pe.username || entry.member_id)}</h2>
        <button class="btn btn-sm btn-ghost" data-close type="button">${t("common.close")}</button></div>
      <p class="muted">${esc(entry.member_id)} · ${esc(pe.country || "—")} · ${esc(tr(pe.membership_type || "Free"))} · ${t("pza.accountAge", { n: R.accountDays(pe) })}</p>
      <h3>${t("pza.progress")}</h3>
      <ul class="pza-list">${cs.map((x) => {
        const r = R.conditionProgress(x, c);
        const label = x.kind === "watch" ? `${tr(x.media_type === "tv" ? "Series" : "Movie")} ${x.tmdb_id}` : t(`pza.kind.${x.kind}`);
        return `<li class="${r.done ? "ok" : ""}">${r.done ? "✓" : "•"} ${esc(label)} <b>${r.prog}/${r.req}</b></li>`;
      }).join("") || `<li class="muted">${t("common.none")}</li>`}</ul>
      <h3>${t("pza.joinedList")}</h3><ul class="pza-list">${li(joined)}</ul>
      <h3>${t("pza.wonList")}</h3><ul class="pza-list">${li(group("winner"))}</ul>
      <h3>${t("pza.withdrawnList")}</h3><ul class="pza-list">${li(group("withdrawn"))}</ul>`);
  }

  // ------------------------------------------------------------------ tab 3: stats
  const STAT = { mode: "all", prize: "all", from: "", to: "", preset: "all" };

  function applyPreset(p) {
    STAT.preset = p;
    const d = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    if (p === "today") { STAT.from = today(); STAT.to = today(); }
    else if (p === "7") { STAT.from = d(6); STAT.to = today(); }
    else if (p === "30") { STAT.from = d(29); STAT.to = today(); }
    else if (p === "all") { STAT.from = ""; STAT.to = ""; }
  }

  // Totals are computed by the database (prize_admin_stats), not by downloading every row.
  async function drawStats() {
    const res = await admin("prize_admin_stats", {
      p_from: STAT.from || null, p_to: STAT.to || null,
      p_prize: STAT.prize === "all" ? null : Number(STAT.prize), p_mode: STAT.mode === "all" ? null : STAT.mode,
    });
    if (res.ok === false) { shell(`<p class="empty">${esc(serverError(res.error))}</p>`); return; }
    const vw = { length: res.visits };
    const uniq = res.visitors;
    const joined = { length: res.joined };
    const withdrawn = { length: res.withdrawn };
    const winners = { length: res.winners };
    const perPrize = (res.per_prize || []).map((r) => ({ p: { title: r.title }, visits: r.visits, uniq: r.visitors, joined: r.joined, withdrawn: r.withdrawn, winners: r.winners }));
    const days = {};
    (res.per_day || []).forEach((r) => (days[String(r.d).slice(0, 10)] = { visits: Number(r.visits), joined: Number(r.joined) }));
    const keys = Object.keys(days).sort().slice(-31);
    const max = Math.max(1, ...keys.map((k) => Math.max(days[k].visits, days[k].joined)));
    const kpi = (n, label) => `<div class="pza-kpi"><b>${n}</b><span>${t(label)}</span></div>`;

    shell(`
      <div class="pza-filters">
        <select id="st-prize"><option value="all">${t("pza.allPrizes")}</option>
          ${S.prizes.map((p) => `<option value="${p.id}" ${STAT.prize === String(p.id) ? "selected" : ""}>${esc(p.title)}</option>`).join("")}</select>
        <select id="st-mode"><option value="all">${t("pza.allModes")}</option>
          ${R.MODES.map((k) => `<option value="${k}" ${STAT.mode === k ? "selected" : ""}>${esc(modeLabel(k))}</option>`).join("")}</select>
        <div class="chip-row">
          ${[["today", "pza.today"], ["7", "pza.last7"], ["30", "pza.last30"], ["all", "pza.allTime"]].map(([k, l]) => `<button type="button" class="lang-chip ${STAT.preset === k ? "on" : ""}" data-preset="${k}">${t(l)}</button>`).join("")}
        </div>
        <div class="form-row">
          <input id="st-from" type="date" value="${STAT.from}" title="${t("prize.filterFrom")}" />
          <input id="st-to" type="date" value="${STAT.to}" title="${t("prize.filterTo")}" />
        </div>
      </div>
      <div class="pza-kpis">
        ${kpi(vw.length, "pza.kVisits")}${kpi(uniq, "pza.kVisitors")}${kpi(joined.length, "pza.kJoined")}${kpi(withdrawn.length, "pza.kWithdrawn")}${kpi(winners.length, "pza.kWinners")}
      </div>
      ${STAT.mode !== "all" ? `<p class="muted">${t("pza.visitsNote")}</p>` : ""}
      <h3>${t("pza.perDay")}</h3>
      <div class="pza-chart">${keys.map((k) => `
        <div class="pza-col" title="${k}: ${days[k].visits} / ${days[k].joined}">
          <i class="v" style="height:${(days[k].visits / max) * 100}%"></i><i class="j" style="height:${(days[k].joined / max) * 100}%"></i>
          <small>${k.slice(5)}</small></div>`).join("") || `<p class="empty">${t("common.none")}</p>`}</div>
      <p class="pza-legend"><i class="v"></i>${t("pza.kVisits")} <i class="j"></i>${t("pza.kJoined")}</p>
      <h3>${t("pza.perPrize")}</h3>
      <div style="overflow-x:auto"><table class="table">
        <thead><tr><th>${t("pza.title")}</th><th>${t("pza.kVisits")}</th><th>${t("pza.kVisitors")}</th><th>${t("pza.kJoined")}</th><th>${t("pza.kWithdrawn")}</th><th>${t("pza.kWinners")}</th></tr></thead>
        <tbody>${perPrize.map((r) => `<tr><td>${esc(r.p.title)}</td><td>${r.visits}</td><td>${r.uniq}</td><td>${r.joined}</td><td>${r.withdrawn}</td><td>${r.winners}</td></tr>`).join("") || `<tr><td colspan="6">${t("common.none")}</td></tr>`}</tbody>
      </table></div>`);

    $("#st-prize").onchange = (e) => { STAT.prize = e.target.value; drawStats(); };
    $("#st-mode").onchange = (e) => { STAT.mode = e.target.value; drawStats(); };
    $("#st-from").onchange = (e) => { STAT.from = e.target.value; STAT.preset = ""; drawStats(); };
    $("#st-to").onchange = (e) => { STAT.to = e.target.value; STAT.preset = ""; drawStats(); };
    $$("[data-preset]", S.main).forEach((b) => (b.onclick = () => { applyPreset(b.dataset.preset); drawStats(); }));
  }

  // ------------------------------------------------------------------ entry point
  async function render(main, api) {
    S.main = main;
    S.api = api || {};
    main.innerHTML = `<p class="muted">${t("common.loading")}</p>`;
    await load();
    draw();
  }

  window.PanelPrizes = { render };
})();
