(() => {
  const {
    $,
    $$,
    setupChrome,
    getSession,
    toast,
    supabaseRequest,
    restValue,
    initialsAvatar,
    avatarUrlFor,
    primeAvatars,
    hydrateAvatars,
    escapeHtml,
    sha256,
    t,
    tr,
    formatDate,
    linkKindOf,
  } = window.CineAura;

  const PANEL_KEY = "cineaura_panel";
  const ALL_SECTIONS = ["accounts", "links", "iptv", "apps", "reports", "prizes", "messages", "staff", "settings"];
  const FEATURES = ["links", "messages", "comments", "posts", "reports"];
  const requestedSection = new URLSearchParams(location.search).get("section");

  const state = {
    staff: null,
    settings: { show_admin: true, show_moderator: true, show_member: false },
    staffRows: [],
    section: ALL_SECTIONS.includes(requestedSection) ? requestedSection : "accounts",
    members: [],
    extraMembers: [], // looked up one by one (Panel > IPTV): not among the newest 400
    profiles: {},
    sanctions: {},
  };

  const roleFromLogin = (value) => {
    const n = String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (n === "super admin" || n === "superadmin") return "super";
    if (n === "admin") return "admin";
    if (n === "moderator") return "moderator";
    return "";
  };

  const roleLabel = (role) => t(`panel.role.${role}`) || role;

  function getPanel() {
    try {
      return JSON.parse(sessionStorage.getItem(PANEL_KEY) || localStorage.getItem(PANEL_KEY) || "null");
    } catch {
      return null;
    }
  }

  function setPanel(row, persist, token) {
    const payload = {
      token: token || row.token || "",
      id: row.id,
      role: row.role,
      member_id: row.member_id || "",
      username: row.username || "",
      sections: row.sections || "",
    };
    const raw = JSON.stringify(payload);
    sessionStorage.setItem(PANEL_KEY, raw);
    if (persist) localStorage.setItem(PANEL_KEY, raw);
    else localStorage.removeItem(PANEL_KEY);
    state.staff = payload;
  }

  function clearPanel() {
    sessionStorage.removeItem(PANEL_KEY);
    localStorage.removeItem(PANEL_KEY);
    state.staff = null;
  }

  function sectionsOf(row) {
    if ((row?.role || state.staff?.role) === "super") return ALL_SECTIONS.slice();
    const raw = String(row?.sections || state.staff?.sections || "");
    const list = raw.split(",").map((s) => s.trim()).filter((s) => ALL_SECTIONS.includes(s));
    return list.length ? list : ["accounts"];
  }

  function canSee(section) {
    if (section === "staff") return state.staff?.role === "super";
    return sectionsOf(state.staff).includes(section);
  }

  function staffRoleOf(memberId) {
    const hit = state.staffRows.find((s) => s.member_id && s.member_id === memberId);
    return hit?.role || "";
  }

  function canActOn(memberId) {
    if (!memberId) return false;
    if (memberId === state.staff?.member_id) return false;
    const target = staffRoleOf(memberId);
    if (target === "super") return false;
    if (state.staff?.role === "moderator" && (target === "admin" || target === "super")) return false;
    if (state.staff?.role === "admin" && target === "super") return false;
    return true;
  }

  function avatarFor(memberId, username) {
    const p = state.profiles[memberId];
    return p?.avatar_url || avatarUrlFor(memberId, username) || initialsAvatar(username || "CA");
  }

  function avatarTag(memberId, username, fallback) {
    return `<img src="${escapeHtml(avatarFor(memberId, username) || avatarUrlFor(memberId, username) || initialsAvatar(fallback || username || "CA"))}" alt="" data-avatar-for="${escapeHtml(memberId || "")}" data-avatar-name="${escapeHtml(String(username || "").replace(/^@/, ""))}" />`;
  }

  // ---- staff medal: shown instead of the initials when a staff member has no picture ----
  //   Super Admin = gold, Admin = silver, Moderator = bronze
  const MEDAL_COLORS = {
    super: ["#ffe08a", "#d99a1c", "#8a5a00"],
    admin: ["#f4f7fa", "#9ba8b6", "#5d6b7a"],
    moderator: ["#f2b786", "#b4692d", "#6e3b14"],
  };
  const medalCache = {};
  function medalAvatar(role) {
    const key = MEDAL_COLORS[role] ? role : "moderator";
    if (medalCache[key]) return medalCache[key];
    const [c1, c2, edge] = MEDAL_COLORS[key];
    const star = Array.from({ length: 10 }, (_, i) => {
      const r = i % 2 ? 3.6 : 8.4;
      const a = (-90 + i * 36) * (Math.PI / 180);
      return `${(40 + r * Math.cos(a)).toFixed(2)},${(50 + r * Math.sin(a)).toFixed(2)}`;
    }).join(" ");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><defs><linearGradient id="m" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect width="80" height="80" rx="18" fill="#0d253f"/><path d="M25 7h12l9 26H34z" fill="#d64550"/><path d="M55 7H43l-9 26h12z" fill="#b8323d"/><circle cx="40" cy="50" r="20" fill="url(#m)" stroke="${edge}" stroke-width="2"/><circle cx="40" cy="50" r="14.5" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="1.5"/><polygon points="${star}" fill="${edge}" fill-opacity=".85"/></svg>`;
    medalCache[key] = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    return medalCache[key];
  }

  const realAvatar = (memberId, username) => state.profiles[memberId]?.avatar_url || avatarUrlFor(memberId, username) || "";

  function medalTag(role, memberId, username) {
    const real = realAvatar(memberId, username);
    return `<img src="${escapeHtml(real || medalAvatar(role))}" alt="${escapeHtml(roleLabel(role))}" title="${escapeHtml(roleLabel(role))}" data-medal="${escapeHtml(role || "")}" data-medal-for="${escapeHtml(memberId || "")}" data-medal-name="${escapeHtml(String(username || "").replace(/^@/, ""))}" onerror="this.onerror=null;this.src='${medalAvatar(role)}'" />`;
  }

  // Swap in the real picture once the profiles are known; the medal stays when there is none.
  async function hydrateMedals(root) {
    const nodes = [...(root || document).querySelectorAll("img[data-medal]")];
    if (!nodes.length) return;
    await primeAvatars(nodes.map((n) => n.dataset.medalFor), nodes.map((n) => n.dataset.medalName));
    nodes.forEach((n) => {
      const url = realAvatar(n.dataset.medalFor, n.dataset.medalName);
      if (url) n.src = url;
    });
  }

  function overlay(html) {
    $$(".modal-back").forEach((el) => el.remove());
    const wrap = document.createElement("div");
    wrap.className = "modal-back";
    wrap.innerHTML = `<section class="glass modal-card">${html}</section>`;
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap) wrap.remove();
    });
    document.body.appendChild(wrap);
    wrap.querySelector("[data-close]")?.addEventListener("click", () => wrap.remove());
    return wrap;
  }

  async function loadStaffRows() {
    const res = await supabaseRequest("/rest/v1/staff?select=id,role,member_id,username,sections,created_at&order=created_at.asc");
    state.staffRows = res.ok && Array.isArray(res.data) ? res.data : [];
  }

  async function loadSettings() {
    const res = await supabaseRequest("/rest/v1/panel_settings?id=eq.1&select=*");
    if (res.ok && res.data?.[0]) state.settings = res.data[0];
  }

  async function loadDirectory() {
    let [mem, prof, san] = await Promise.all([
      supabaseRequest("/rest/v1/members?select=member_id,full_name,username,status,email,country,gender,birth_date,membership_type,membership_duration,membership_expires_at,watch_minutes,created_at,recovery_code,banned_at&order=created_at.desc&limit=400"),
      supabaseRequest("/rest/v1/profiles?select=member_id,username,avatar_url,bio,followers,following,language,region,country,private_minutes,public_minutes"),
      supabaseRequest("/rest/v1/sanctions?select=*"),
    ]);
    if (!mem.ok) mem = await supabaseRequest("/rest/v1/members?select=member_id,full_name,username,status,email,country,gender,birth_date,membership_type,membership_duration,membership_expires_at,watch_minutes,created_at,recovery_code&order=created_at.desc&limit=400");
    if (!prof.ok) prof = await supabaseRequest("/rest/v1/profiles?select=member_id,username,avatar_url,bio,followers,following");
    state.members = mem.ok && Array.isArray(mem.data) ? mem.data : [];
    state.profiles = {};
    (prof.ok && Array.isArray(prof.data) ? prof.data : []).forEach((p) => {
      state.profiles[p.member_id] = p;
    });
    state.sanctions = {};
    (san.ok && Array.isArray(san.data) ? san.data : []).forEach((s) => {
      state.sanctions[s.member_id] = s;
    });
  }

  function renderLogin(mode) {
    const setup = mode === "setup";
    $("#panel-root").innerHTML = `
      <section class="glass panel-login">
        <span class="eyebrow">${t("panel.eyebrow")}</span>
        <h1>${setup ? t("panel.setupTitle") : t("panel.loginTitle")}</h1>
        <p class="lead">${setup ? t("panel.setupLead") : t("panel.loginLead")}</p>
        <div class="form-alert" id="panel-alert"></div>
        <div class="stack">
          ${setup ? "" : `<input id="p-user" autocomplete="username" placeholder="${t("panel.userPh")}" />`}
          <input id="p-pass" type="password" autocomplete="current-password" placeholder="${t("panel.passPh")}" />
          ${setup ? `<input id="p-pass2" type="password" placeholder="${t("panel.pass2")}" />` : ""}
          <label class="lang-chip"><input type="checkbox" id="p-stay" checked /> ${t("auth.stay")}</label>
          <button class="btn btn-lg btn-primary" id="p-go" type="button">${setup ? t("panel.createSuper") : t("panel.enter")}</button>
        </div>
      </section>`;
    const alert = (type, html) => {
      const el = $("#panel-alert");
      el.className = `form-alert show ${type}`;
      el.innerHTML = html;
    };
    $("#p-go").onclick = async () => {
      const pass = $("#p-pass").value;
      if (pass.length < 8) return alert("error", t("panel.pass8"));
      const btn = $("#p-go");
      btn.disabled = true;
      try {
        const hash = await sha256(pass);
        if (setup) {
          if (pass !== $("#p-pass2").value) return alert("error", t("panel.mismatch"));
          const session = getSession();
          const ins = await window.CineAura.rpc("staff_setup_super", {
            p_member: session?.member_id || "",
            p_username: session?.username || "Super Admin",
            p_hash: hash,
            p_sections: ALL_SECTIONS.join(","),
          });
          if (!ins.ok || !ins.data?.ok) return alert("error", t("panel.setupFail"));
          setPanel(ins.data.staff, $("#p-stay").checked, ins.data.token);
          toast(t("panel.welcomeSuper"));
          await enterPanel();
          return;
        }
        const role = roleFromLogin($("#p-user").value);
        if (!role) return alert("error", t("panel.badUser"));
        const res = await window.CineAura.rpc("staff_login", { p_role: role, p_hash: hash });
        if (res.ok && res.data?.error === "locked") return alert("error", t("panel.locked"));
        if (!res.ok || !res.data?.ok) return alert("error", t(res.ok ? "panel.badPass" : "panel.needSecure"));
        const row = res.data.staff;
        setPanel(row, $("#p-stay").checked, res.data.token);
        toast(t("panel.welcome", { role: roleLabel(row.role) }));
        await enterPanel();
      } catch (err) {
        console.error(err);
        alert("error", t("panel.loginFail"));
      } finally {
        btn.disabled = false;
      }
    };
    $("#p-pass")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") $("#p-go").click();
    });
  }

  function renderShell() {
    const allowed = ALL_SECTIONS.filter((s) => canSee(s));
    if (!allowed.includes(state.section)) state.section = allowed[0] || "accounts";
    const me = state.staff;
    $("#panel-root").innerHTML = `
      <div class="dash-layout">
        <aside class="glass dash-side">
          <div class="side-user">
            ${medalTag(me.role, me.member_id, me.username)}
            <strong>${escapeHtml(me.username || roleLabel(me.role))}</strong>
            <span class="panel-role">${escapeHtml(roleLabel(me.role))}</span>
            <span>${escapeHtml(me.member_id || "—")}</span>
          </div>
          <nav class="side-nav">
            ${allowed.map((s) => `<button type="button" data-section="${s}" class="${state.section === s ? "active" : ""}">${t("panel.nav." + s)}</button>`).join("")}
          </nav>
          <button class="btn btn-sm btn-ghost" id="panel-out" type="button" style="margin-top:16px;width:100%">${t("panel.leave")}</button>
        </aside>
        <section class="glass dash-main" id="panel-main"></section>
      </div>`;
    $("#panel-root").onclick = (e) => {
      const sec = e.target.closest("[data-section]");
      if (!sec) return;
      state.section = sec.dataset.section;
      renderShell();
    };
    window.CineAura.mountSideToggle($("#panel-root .dash-layout"));
    $("#panel-out").onclick = () => {
      if (state.staff?.token) window.CineAura.rpc("staff_logout", { p_token: state.staff.token });
      clearPanel();
      toast(t("panel.left"));
      boot();
    };
    hydrateAvatars($("#panel-root"));
    hydrateMedals($("#panel-root"));
    if (allowed.includes("reports")) refreshChannelReportCount();
    renderSection();
  }

  async function renderSection() {
    const main = $("#panel-main");
    const map = {
      accounts: viewAccounts,
      links: viewLinks,
      iptv: viewIptv,
      apps: viewApps,
      reports: viewReports,
      prizes: viewPrizes,
      messages: viewMessages,
      staff: viewStaff,
      settings: viewSettings,
    };
    await (map[state.section] || viewAccounts)(main);
    hydrateAvatars(main);
    hydrateMedals(main);
  }

  const accStatus = (m) => window.CineAura.normalizeAccountStatus(m.status);
  const isTempBan = (san) => Boolean(san?.temp_until) && Date.parse(san.temp_until) > Date.now();
  const partialFeatures = (m) => String(state.sanctions[m.member_id]?.features || "").split(",").map((x) => x.trim()).filter(Boolean);
  const hasPartial = (m) => partialFeatures(m).length > 0 || isTempBan(state.sanctions[m.member_id]);
  const ACC_TABS = {
    all: () => true,
    active: (m) => accStatus(m) === "active",
    inactive: (m) => !["active", "banned"].includes(accStatus(m)),
    full: (m) => accStatus(m) === "banned",
    partial: (m) => hasPartial(m),
  };

  async function patchMemberStatus(id, status) {
    const body = status === "banned" ? { status, banned_at: new Date().toISOString() } : status === "active" ? { status, banned_at: null } : { status };
    let r = await supabaseRequest(`/rest/v1/members?member_id=eq.${restValue(id)}`, { method: "PATCH", body: JSON.stringify(body) });
    if (!r.ok) r = await supabaseRequest(`/rest/v1/members?member_id=eq.${restValue(id)}`, { method: "PATCH", body: JSON.stringify({ status }) });
    return r.ok;
  }

  // which: "full" | "partial" | "all"
  async function liftBan(id, which) {
    const m = state.members.find((x) => x.member_id === id);
    if (which !== "partial" && m && accStatus(m) === "banned") {
      if (!(await patchMemberStatus(id, "active"))) return false;
    }
    if (which !== "full" && state.sanctions[id]) {
      const r = await supabaseRequest(`/rest/v1/sanctions?member_id=eq.${restValue(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ features: "", temp_until: null, updated_by: state.staff.member_id || state.staff.role }),
      });
      if (!r.ok) return false;
    }
    return true;
  }

  async function viewAccounts(main) {
    if (!state.purged) {
      state.purged = true;
      await supabaseRequest("/rest/v1/rpc/purge_banned_members", { method: "POST", body: "{}" }).catch(() => {});
    }
    await loadDirectory();
    await loadStaffRows();
    const tab = ACC_TABS[main.dataset.tab] ? main.dataset.tab : "all";
    const q = (main.dataset.q || "").toLowerCase();
    const rows = state.members.filter((m) => ACC_TABS[tab](m) && (!q || `${m.username} ${m.full_name} ${m.member_id} ${m.email}`.toLowerCase().includes(q)));
    const count = (k) => state.members.filter(ACC_TABS[k]).length;
    const tabs = [["all", "panel.tab.all"], ["active", "panel.tab.active"], ["inactive", "panel.tab.inactive"], ["full", "panel.tab.full"], ["partial", "panel.tab.partial"]];
    main.innerHTML = `
      <p class="eyebrow">${t("panel.nav.accounts")}</p>
      <h1>${t("panel.accountsTitle")}</h1>
      <p class="muted">${t("panel.accountsLead")}</p>
      <div class="tabs follow-tabs" role="tablist">
        ${tabs.map(([k, label]) => `<button type="button" role="tab" class="follow-tab${tab === k ? " active" : ""}" data-atab="${k}">${t(label)}<span class="follow-count">${count(k)}</span></button>`).join("")}
      </div>
      <div class="toolbar">
        <input id="acc-q" placeholder="${t("panel.searchMember")}" value="${escapeHtml(main.dataset.q || "")}" />
      </div>
      <div id="acc-list">
        ${rows.map((m) => {
          const role = staffRoleOf(m.member_id);
          const san = state.sanctions[m.member_id];
          const temp = isTempBan(san);
          const full = accStatus(m) === "banned";
          const part = hasPartial(m);
          const feats = partialFeatures(m).map((f) => t("panel.feat." + f)).join(", ");
          const del = full && m.banned_at ? new Date(Date.parse(m.banned_at) + 90 * 86400000).toISOString().slice(0, 10) : "";
          return `
          <div class="acc-row">
            ${avatarTag(m.member_id, m.username, m.username)}
            <div>
              <strong>@${escapeHtml(m.username)}</strong>
              <div class="muted">${escapeHtml(m.member_id)} · ${escapeHtml(tr(m.status || "active"))}${role ? " · " + roleLabel(role) : ""}${temp ? " · " + t("panel.tempBan") : ""}${feats ? " · " + escapeHtml(feats) : ""}${del ? " · " + t("panel.autoDelete", { date: del }) : ""}</div>
            </div>
            <div class="acc-actions">
              <button class="btn btn-sm btn-ghost" data-info="${escapeHtml(m.member_id)}" type="button">${t("panel.fullInfo")}</button>
              <button class="btn btn-sm btn-ghost" data-hist="${escapeHtml(m.member_id)}" type="button">${t("panel.history")}</button>
              ${(full || part) && canActOn(m.member_id) ? `<button class="btn btn-sm btn-primary" data-unban="${escapeHtml(m.member_id)}" type="button">${t("panel.unban")}</button>` : ""}
              ${canActOn(m.member_id) ? `<button class="btn btn-sm btn-primary" data-act="${escapeHtml(m.member_id)}" type="button">${t("panel.action")}</button>` : ""}
            </div>
          </div>`;
        }).join("") || `<p class="empty">${t("panel.noMembers")}</p>`}
      </div>`;
    $("#acc-q").onkeydown = (e) => {
      if (e.key === "Enter") {
        main.dataset.q = $("#acc-q").value.trim();
        viewAccounts(main);
      }
    };
    main.onclick = async (e) => {
      const tb = e.target.closest("[data-atab]");
      const info = e.target.closest("[data-info]");
      const hist = e.target.closest("[data-hist]");
      const act = e.target.closest("[data-act]");
      const unban = e.target.closest("[data-unban]");
      if (tb) { main.dataset.tab = tb.dataset.atab; viewAccounts(main); return; }
      if (info) openInfo(info.dataset.info);
      if (hist) openHistory(hist.dataset.hist);
      if (act) openAction(act.dataset.act);
      if (unban) {
        const id = unban.dataset.unban;
        const m = state.members.find((x) => x.member_id === id);
        if (!canActOn(id) || !confirm(t("panel.confirmUnban", { user: m?.username || id }))) return;
        if (await liftBan(id, "all")) { toast(t("panel.unbanned")); viewAccounts(main); }
        else toast(t("panel.actFail"));
      }
    };
  }

  function openInfo(id) {
    const m = state.members.find((x) => x.member_id === id);
    if (!m) return;
    const p = state.profiles[id] || {};
    overlay(`
      <span class="eyebrow">${t("panel.fullInfo")}</span>
      <h2>@${escapeHtml(m.username)}</h2>
      <div class="success-meta">
        <div>${t("common.memberId")} <strong>${escapeHtml(m.member_id)}</strong></div>
        <div>${t("common.displayName")} <strong>${escapeHtml(m.full_name || "—")}</strong></div>
        <div>${t("common.email")} <strong>${escapeHtml(m.email || "—")}</strong></div>
        <div>${t("common.status")} <strong>${escapeHtml(tr(m.status || "—"))}</strong></div>
        <div>${t("common.membership")} <strong>${escapeHtml(tr(m.membership_type || "Free"))}</strong></div>
        <div>${t("common.duration")} <strong>${escapeHtml(m.membership_duration || "—")}</strong></div>
        <div>${t("common.country")} <strong>${escapeHtml(m.country || p.country || "—")}</strong></div>
        <div>${t("reg.gender")} <strong>${escapeHtml(m.gender || "—")}</strong></div>
        <div>${t("reg.dob")} <strong>${escapeHtml(m.birth_date || "—")}</strong></div>
        <div>${t("common.minutes")} <strong>${Number(m.watch_minutes || 0)}</strong></div>
        <div>${t("dash.followers")} <strong>${Number(p.followers || 0)}</strong></div>
        <div>${t("common.bio")} <strong>${escapeHtml(p.bio || "—")}</strong></div>
        <div>${t("common.recoveryCode")} <strong>${escapeHtml(m.recovery_code || "—")}</strong></div>
      </div>
      <button class="btn btn-sm btn-ghost" data-close type="button">${t("common.close")}</button>`);
  }

  async function openHistory(id) {
    const m = state.members.find((x) => x.member_id === id);
    const hist = await supabaseRequest(`/rest/v1/hestory?visitor_id=eq.${restValue(id)}&select=*&order=visited_at.desc&limit=80`);
    const views = await supabaseRequest(`/rest/v1/views?viewer_id=eq.${restValue(id)}&select=*&order=started_at.desc&limit=80`);
    const h = hist.ok && Array.isArray(hist.data) ? hist.data : [];
    const v = views.ok && Array.isArray(views.data) ? views.data : [];
    const line = (r) => `<div class="muted">${escapeHtml(r.title || r.media_type || "")} · TMDB ${r.tmdb_id} · ${escapeHtml(String(r.visited_at || r.started_at || "").slice(0, 16))} ${r.minutes ? "· " + r.minutes + " min" : ""}</div>`;
    overlay(`
      <span class="eyebrow">${t("panel.history")}</span>
      <h2>@${escapeHtml(m?.username || id)}</h2>
      <h3>${t("common.movies")} / ${t("common.series")}</h3>
      ${h.length ? h.map(line).join("") : `<p class="empty">${t("dash.noYet", { what: t("dash.history") })}</p>`}
      <h3 style="margin-top:16px">${t("dash.nav.views")}</h3>
      ${v.length ? v.map(line).join("") : `<p class="empty">${t("dash.noViews")}</p>`}
      <button class="btn btn-sm btn-ghost" data-close type="button" style="margin-top:12px">${t("common.close")}</button>`);
  }

  function openAction(id) {
    if (!canActOn(id)) return toast(t("panel.noAct"));
    const m = state.members.find((x) => x.member_id === id);
    const san = state.sanctions[id] || { features: "", temp_until: "" };
    const feats = String(san.features || "").split(",").map((s) => s.trim()).filter(Boolean);
    const isFull = m ? accStatus(m) === "banned" : false;
    const isPart = m ? hasPartial(m) : false;
    overlay(`
      <span class="eyebrow">${t("panel.action")}</span>
      <h2>@${escapeHtml(m?.username || id)}</h2>
      <p class="muted">${t("panel.actionLead")}</p>
      <div class="stack">
        <button class="btn btn-lg btn-danger" id="a-full" type="button">${t("panel.fullBan")}</button>
        <p class="muted">${t("panel.fullBanHint")}</p>
        <hr />
        <label>${t("panel.tempDays")}<input id="a-days" type="number" min="1" placeholder="1" /></label>
        <button class="btn btn-sm btn-primary" id="a-temp" type="button">${t("panel.tempBan")}</button>
        <p class="muted">${t("panel.partialHint")}</p>
        <div class="chip-row">
          ${FEATURES.map((f) => `<label class="lang-chip"><input type="checkbox" name="a-f" value="${f}" ${feats.includes(f) ? "checked" : ""} /> ${t("panel.feat." + f)}</label>`).join("")}
        </div>
        <button class="btn btn-sm btn-primary" id="a-feat" type="button">${t("panel.savePartial")}</button>
        ${isFull ? `<button class="btn btn-sm btn-primary" id="a-unban-full" type="button">${t("panel.unbanFull")}</button>` : ""}
        ${isPart ? `<button class="btn btn-sm btn-primary" id="a-unban-part" type="button">${t("panel.unbanPartial")}</button>` : ""}
        <div class="form-row">
          <button class="btn btn-sm btn-primary" id="a-on" type="button">${t("panel.activate")}</button>
          <button class="btn btn-sm btn-ghost" id="a-off" type="button">${t("panel.deactivate")}</button>
        </div>
        <button class="btn btn-sm btn-ghost" data-close type="button">${t("common.close")}</button>
      </div>`);
    const patchStatus = async (status) => {
      if (!(await patchMemberStatus(id, status))) return toast(t("panel.actFail"));
      toast(t("panel.saved"));
      $$(".modal-back").forEach((el) => el.remove());
      viewAccounts($("#panel-main"));
    };
    $("#a-full").onclick = async () => {
      if (!confirm(t("panel.confirmFull", { user: m?.username || id }))) return;
      if (!(await patchMemberStatus(id, "banned"))) return toast(t("panel.actFail"));
      await supabaseRequest(`/rest/v1/movielink?member_id=eq.${restValue(id)}`, { method: "DELETE" });
      await supabaseRequest(`/rest/v1/tvlink?member_id=eq.${restValue(id)}`, { method: "DELETE" });
      toast(t("panel.bannedLinksGone"));
      $$(".modal-back").forEach((el) => el.remove());
      viewAccounts($("#panel-main"));
    };
    $("#a-temp").onclick = async () => {
      const days = Math.max(1, Number($("#a-days").value) || 1);
      const until = new Date(Date.now() + days * 86400000).toISOString();
      await supabaseRequest("/rest/v1/sanctions", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify({
          member_id: id,
          temp_until: until,
          features: san.features || "",
          updated_by: state.staff.member_id || state.staff.role,
        }),
      });
      await supabaseRequest(`/rest/v1/sanctions?member_id=eq.${restValue(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ temp_until: until, updated_by: state.staff.member_id || state.staff.role }),
      });
      toast(t("panel.tempSet", { n: days }));
      $$(".modal-back").forEach((el) => el.remove());
      viewAccounts($("#panel-main"));
    };
    $("#a-feat").onclick = async () => {
      const selected = $$('input[name="a-f"]:checked').map((el) => el.value).join(",");
      await supabaseRequest(`/rest/v1/sanctions?member_id=eq.${restValue(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ features: selected, updated_by: state.staff.member_id || state.staff.role }),
      });
      const exists = await supabaseRequest(`/rest/v1/sanctions?member_id=eq.${restValue(id)}&select=member_id`);
      if (!exists.data?.[0]) {
        await supabaseRequest("/rest/v1/sanctions", {
          method: "POST",
          body: JSON.stringify({
            member_id: id,
            features: selected,
            updated_by: state.staff.member_id || state.staff.role,
          }),
        });
      }
      toast(t("panel.saved"));
      $$(".modal-back").forEach((el) => el.remove());
      viewAccounts($("#panel-main"));
    };
    const lift = (which) => async () => {
      if (!(await liftBan(id, which))) return toast(t("panel.actFail"));
      toast(t("panel.unbanned"));
      $$(".modal-back").forEach((el) => el.remove());
      viewAccounts($("#panel-main"));
    };
    $("#a-unban-full")?.addEventListener("click", lift("full"));
    $("#a-unban-part")?.addEventListener("click", lift("partial"));
    $("#a-on").onclick = () => patchStatus("active");
    $("#a-off").onclick = () => patchStatus("disabled");
  }

  async function viewLinks(main) {
    main.innerHTML = `
      <p class="eyebrow">${t("panel.nav.links")}</p>
      <h1>${t("panel.linksTitle")}</h1>
      <p class="muted">${t("panel.linksLead")}</p>
      <div class="form-row">
        <select id="lk-type">
          <option value="movie">${t("common.movie")}</option>
          <option value="tv">${t("common.series")}</option>
        </select>
        <input id="lk-tmdb" placeholder="${t("panel.tmdbId")}" />
      </div>
      <button class="btn btn-sm btn-primary" id="lk-load" type="button">${t("panel.loadLinks")}</button>
      <div id="lk-out" style="margin-top:16px"></div>`;
    $("#lk-load").onclick = () => loadTitleLinks();
  }

  async function loadTitleLinks() {
    const type = $("#lk-type").value;
    const id = Number($("#lk-tmdb").value);
    const out = $("#lk-out");
    if (!id) return toast(t("panel.needTmdb"));
    const table = type === "tv" ? "tvlink" : "movielink";
    const res = await supabaseRequest(`/rest/v1/${table}?tmdb_id=eq.${id}&select=*&order=added_at.desc`);
    const rows = res.ok && Array.isArray(res.data) ? res.data : [];
    out.innerHTML = rows.map((r) => {
      const until = r.ban_until ? Date.parse(r.ban_until) : 0;
      const temp = until > Date.now();
      const label = r.banned ? t("panel.fullBanned") : temp ? t("panel.tempUntil", { date: String(r.ban_until).slice(0, 16) }) : t("common.open");
      return `
        <div class="link-admin">
          <strong>${escapeHtml(r.title || "TMDB " + r.tmdb_id)}</strong>
          <div class="muted">${escapeHtml(r.watch_url)}</div>
          <div class="muted">@${escapeHtml(r.username || r.member_id)} · ${linkKindOf(r) === "download" ? t("watch.chipDownload") + " · " : ""}${escapeHtml(r.quality || "—")} · ${r.has_ads ? t("common.adsOn") : t("common.adsOff")} · ${Number(r.clicks || 0)} ${t("common.clicks")} · ${label}${type === "tv" ? ` · S${r.season}E${r.episode}` : ""}</div>
          <div class="acc-actions">
            <input data-days="${r.id}" type="number" min="1" placeholder="${t("panel.tempDays")}" style="width:110px" />
            <button class="btn btn-sm btn-ghost" data-temp="${r.id}" type="button">${t("panel.tempBan")}</button>
            <button class="btn btn-sm btn-ghost" data-full="${r.id}" type="button">${t("panel.fullBan")}</button>
            <button class="btn btn-sm btn-danger" data-del="${r.id}" type="button">${t("common.remove")}</button>
          </div>
        </div>`;
    }).join("") || `<p class="empty">${t("common.none")}</p>`;
    out.onclick = async (e) => {
      const tableName = $("#lk-type").value === "tv" ? "tvlink" : "movielink";
      const temp = e.target.closest("[data-temp]");
      const full = e.target.closest("[data-full]");
      const del = e.target.closest("[data-del]");
      if (temp) {
        const days = Math.max(1, Number(out.querySelector(`[data-days="${temp.dataset.temp}"]`)?.value) || 1);
        const until = new Date(Date.now() + days * 86400000).toISOString();
        await supabaseRequest(`/rest/v1/${tableName}?id=eq.${temp.dataset.temp}`, {
          method: "PATCH",
          body: JSON.stringify({ banned: false, ban_until: until }),
        });
        toast(t("panel.tempSet", { n: days }));
        loadTitleLinks();
      }
      if (full) {
        await supabaseRequest(`/rest/v1/${tableName}?id=eq.${full.dataset.full}`, {
          method: "PATCH",
          body: JSON.stringify({ banned: true, ban_until: null }),
        });
        toast(t("panel.linkBanned"));
        loadTitleLinks();
      }
      if (del) {
        await supabaseRequest(`/rest/v1/${tableName}?id=eq.${del.dataset.del}`, { method: "DELETE" });
        toast(t("dash.linkRemoved"));
        loadTitleLinks();
      }
    };
  }

  // ---------- Reports: watch links (reportlinks) + channels (channel_reports) ----------
  async function viewReports(main) {
    const tab = state.reportTab === "channels" ? "channels" : "links";
    main.innerHTML = `
      <p class="eyebrow">${t("panel.nav.reports")}</p>
      <h1>${t("panel.reportsTitle")}</h1>
      <div class="tabs follow-tabs" role="tablist">
        <button type="button" role="tab" class="follow-tab${tab === "links" ? " active" : ""}" aria-selected="${tab === "links"}" data-rtab="links">${t("panel.chr.tabLinks")}</button>
        <button type="button" role="tab" class="follow-tab${tab === "channels" ? " active" : ""}" aria-selected="${tab === "channels"}" data-rtab="channels">${t("panel.chr.tabChannels")}<span class="follow-count" id="chr-open-count" hidden></span></button>
      </div>
      <div class="follow-pane" id="rp-pane"></div>`;
    main.onclick = (e) => {
      const btn = e.target.closest("[data-rtab]");
      if (!btn || btn.dataset.rtab === tab) return;
      state.reportTab = btn.dataset.rtab;
      viewReports(main);
    };
    const pane = main.querySelector("#rp-pane");
    if (tab === "channels") await viewChannelReports(pane);
    else await viewLinkReports(pane);
    refreshChannelReportCount();
  }

  async function viewLinkReports(pane) {
    const res = await supabaseRequest("/rest/v1/reportlinks?select=*&order=reported_at.desc&limit=300");
    const rows = res.ok && Array.isArray(res.data) ? res.data : [];
    const subjects = {
      misleading: t("dash.rpt.misleading"),
      broken: t("dash.rpt.broken"),
      malicious: t("dash.rpt.malicious"),
      stolen: t("dash.rpt.stolen"),
      bad: t("dash.rpt.bad"),
      indirect: t("dash.rpt.indirect"),
    };
    pane.innerHTML = `
      <p class="muted">${t("panel.reportsLead")}</p>
      ${rows.map((r) => `
        <div class="mini-card" style="margin-bottom:10px">
          <span class="eyebrow">${escapeHtml(r.media_type)} · TMDB ${r.tmdb_id}</span>
          <h3>${escapeHtml(subjects[r.subject] || r.subject)}</h3>
          <p class="muted">${escapeHtml(r.watch_url)}</p>
          <p class="muted">${t("panel.reporter")}: ${escapeHtml(r.reporter_id)} · ${t("panel.owner")}: ${escapeHtml(r.owner_id)}</p>
          <p class="muted">${escapeHtml(String(r.reported_at || "").slice(0, 16))} · ${t("panel.verdict")}: <strong>${escapeHtml(r.verdict)}</strong></p>
          <div class="acc-actions">
            <button class="btn btn-sm btn-primary" data-verdict="valid" data-url="${escapeHtml(r.watch_url)}" data-sub="${escapeHtml(r.subject)}" type="button">${t("panel.valid")}</button>
            <button class="btn btn-sm btn-ghost" data-verdict="ended" data-url="${escapeHtml(r.watch_url)}" data-sub="${escapeHtml(r.subject)}" type="button">${t("panel.ended")}</button>
          </div>
        </div>`).join("") || `<p class="empty">${t("dash.noReportsIn")}</p>`}`;
    pane.onclick = async (e) => {
      const btn = e.target.closest("[data-verdict]");
      if (!btn) return;
      const verdict = btn.dataset.verdict;
      const url = btn.dataset.url;
      const subject = btn.dataset.sub;
      const patch = await supabaseRequest(
        `/rest/v1/reportlinks?watch_url=eq.${restValue(url)}&subject=eq.${restValue(subject)}`,
        { method: "PATCH", body: JSON.stringify({ verdict, verdict_at: new Date().toISOString() }) }
      );
      if (!patch.ok) return toast(t("panel.actFail"));
      toast(t("panel.verdictApplied"));
      viewLinkReports(pane);
    };
  }

  // Open channel reports: the badge in the side menu and the count on the tab.
  async function refreshChannelReportCount() {
    const n = await window.CineAura.countRows("/rest/v1/channel_reports?status=eq.open&select=id").catch(() => 0);
    const nav = $('#panel-root .side-nav [data-section="reports"]');
    if (nav) {
      nav.querySelector(".crp-badge")?.remove();
      if (n) nav.insertAdjacentHTML("beforeend", `<span class="crp-badge">${n > 99 ? "99+" : n}</span>`);
    }
    const tabCount = $("#chr-open-count");
    if (tabCount) {
      tabCount.textContent = String(n);
      tabCount.hidden = !n;
    }
  }

  const chrKey = (r) => `${String(r.package_name || "").trim().toLowerCase()}\n${String(r.channel_name || "").trim().toLowerCase()}`;

  // Reports on the same channel (package + name) form one card; an action on
  // the card applies to every report inside it.
  async function viewChannelReports(pane) {
    const filter = ["open", "closed", "all"].includes(state.chrFilter) ? state.chrFilter : "open";
    const where = filter === "open" ? "&status=eq.open" : filter === "closed" ? "&status=neq.open" : "";
    const res = await supabaseRequest(`/rest/v1/channel_reports?select=*${where}&order=reported_at.desc&limit=600`);
    const chip = (k) => `<button type="button" class="crp-filter${filter === k ? " active" : ""}" data-chr-filter="${k}">${t(`panel.chr.${k}`)}</button>`;
    const head = `
      <p class="muted">${t("panel.chr.lead")}</p>
      <div class="crp-bar"><div class="crp-filters">${chip("open")}${chip("closed")}${chip("all")}</div></div>`;
    if (!res.ok) {
      const raw = JSON.stringify(res.data || {});
      const setup = /PGRST205|42P01|schema cache|does not exist/i.test(raw);
      pane.innerHTML = `${head}<div class="form-alert show warn">${t(setup ? "panel.chr.setup" : "panel.actFail")}</div>`;
      pane.onclick = (e) => onChannelReportClick(e, pane, []);
      return;
    }
    const groups = [];
    const byKey = new Map();
    (Array.isArray(res.data) ? res.data : []).forEach((r) => {
      const key = chrKey(r);
      let g = byKey.get(key);
      if (!g) {
        g = { key, package_name: r.package_name, channel_name: r.channel_name, group_name: r.group_name, logo_url: r.logo_url, stream_url: r.stream_url, channel_id: r.channel_id, items: [] };
        byKey.set(key, g);
        groups.push(g);
      }
      g.items.push(r);
      if (!g.logo_url && r.logo_url) g.logo_url = r.logo_url;
      if (!g.stream_url && r.stream_url) g.stream_url = r.stream_url;
    });
    const P = window.CineAuraChannels;
    const reasonText = (r) => t(`chan.rpt.${r}`);
    const statusOf = (g) => (g.items.some((x) => x.status === "open") ? "open" : g.items.every((x) => x.status === "dismissed") ? "dismissed" : "resolved");
    const card = (g, i) => {
      const status = statusOf(g);
      const counts = {};
      g.items.forEach((x) => { counts[x.reason] = (counts[x.reason] || 0) + 1; });
      const reasons = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      return `
        <article class="crp-card ${status}" data-crp="${i}">
          <div class="crp-top">
            ${P ? P.logoHtml(g, "crp-logo") : ""}
            <div class="crp-title">
              <h3>${escapeHtml(g.channel_name)}</h3>
              <p>${t("panel.chr.package")}: <strong>${escapeHtml(g.package_name)}</strong>${g.group_name ? ` · ${escapeHtml(g.group_name)}` : ""}</p>
              <p>${t("panel.chr.last", { date: escapeHtml(fmtWhen(g.items[0].reported_at)) })}</p>
            </div>
            <span class="crp-count">${t("panel.chr.reports", { n: g.items.length })}</span>
          </div>
          <div class="crp-tags">
            <span class="crp-tag st-${status}">${t(`panel.chr.st.${status}`)}</span>
            ${reasons.map(([r, n]) => `<span class="crp-tag">${escapeHtml(reasonText(r))} × ${n}</span>`).join("")}
          </div>
          <div class="crp-url" title="${escapeHtml(g.stream_url || "")}">${escapeHtml(g.stream_url || t("panel.chr.noUrl"))}</div>
          <details class="crp-details">
            <summary>${t("panel.chr.reporters")} (${g.items.length})</summary>
            <ul class="crp-items">${g.items.map((x) => `
              <li class="crp-item">
                <strong>${escapeHtml(x.reporter_name ? `@${x.reporter_name}` : x.reporter_id)}</strong>
                <span class="muted">${x.reporter_name ? ` · ${escapeHtml(x.reporter_id)}` : ""} · ${escapeHtml(reasonText(x.reason))} · ${escapeHtml(fmtWhen(x.reported_at))} · ${t(`panel.chr.st.${x.status}`)}</span>
                ${x.note ? `<p>${escapeHtml(x.note)}</p>` : ""}
                ${x.error_detail ? `<code>${t("panel.chr.error")}: ${escapeHtml(x.error_detail)}</code>` : ""}
                ${x.handled_by && x.status !== "open" ? `<p class="muted">${escapeHtml(x.handled_by)} · ${escapeHtml(fmtWhen(x.handled_at))}</p>` : ""}
              </li>`).join("")}
            </ul>
          </details>
          <div class="crp-actions">
            ${P ? `<button class="btn btn-sm btn-ghost" type="button" data-crp-test>${t("panel.chr.test")}</button>` : ""}
            ${status === "open" ? `
              <button class="btn btn-sm btn-primary" type="button" data-crp-set="resolved">${t("panel.chr.fixed")}</button>
              <button class="btn btn-sm btn-ghost" type="button" data-crp-set="dismissed">${t("panel.chr.dismiss")}</button>
              <button class="btn btn-sm btn-danger" type="button" data-crp-remove>${t("panel.chr.remove")}</button>` : `
              <button class="btn btn-sm btn-ghost" type="button" data-crp-set="open">${t("panel.chr.reopen")}</button>`}
            <button class="btn btn-sm btn-danger" type="button" data-crp-delete>${t("panel.chr.delete")}</button>
          </div>
        </article>`;
    };
    pane.innerHTML = `${head}<div class="crp-list">${groups.map(card).join("") || `<p class="empty">${t("panel.chr.none")}</p>`}</div>`;
    pane.onclick = (e) => onChannelReportClick(e, pane, groups);
  }

  async function onChannelReportClick(e, pane, groups) {
    const f = e.target.closest("[data-chr-filter]");
    if (f) {
      state.chrFilter = f.dataset.chrFilter;
      viewChannelReports(pane);
      return;
    }
    const btn = e.target.closest("[data-crp-test], [data-crp-set], [data-crp-remove], [data-crp-delete]");
    const g = btn && groups[Number(btn.closest("[data-crp]")?.dataset.crp)];
    if (!g) return;
    const ids = (list) => list.map((x) => Number(x.id)).filter(Boolean).join(",");
    const stamp = () => ({ handled_by: state.staff?.username || roleLabel(state.staff?.role) || "", handled_at: new Date().toISOString() });
    const done = (msg) => {
      toast(msg);
      viewChannelReports(pane).then(refreshChannelReportCount);
    };
    if (btn.hasAttribute("data-crp-test")) {
      btn.disabled = true;
      const [row, acc] = await Promise.all([
        supabaseRequest(`/rest/v1/listchannels?package_name=eq.${restValue(g.package_name)}&channel_name=eq.${restValue(g.channel_name)}&select=*&limit=1`),
        supabaseRequest(`/rest/v1/iptv?name=eq.${restValue(g.package_name)}&select=*`),
      ]).catch(() => [{}, {}]);
      btn.disabled = false;
      const live = row?.ok && Array.isArray(row.data) ? row.data[0] : null;
      const channel = live || { id: g.channel_id, package_name: g.package_name, channel_name: g.channel_name, group_name: g.group_name, logo_url: g.logo_url, channel_type: "live", stream_url: g.stream_url };
      if (!channel.stream_url && g.stream_url) channel.stream_url = g.stream_url;
      window.CineAuraChannels.open([channel], 0, { report: false, accounts: acc?.ok && Array.isArray(acc.data) ? acc.data : undefined });
      return;
    }
    if (btn.hasAttribute("data-crp-set")) {
      const status = btn.dataset.crpSet;
      const items = status === "open" ? g.items.filter((x) => x.status !== "open") : g.items.filter((x) => x.status === "open");
      if (!items.length) return;
      const body = status === "open" ? { status, handled_by: "", handled_at: null } : { status, ...stamp() };
      const r = await supabaseRequest(`/rest/v1/channel_reports?id=in.(${ids(items)})`, { method: "PATCH", body: JSON.stringify(body) });
      if (!r.ok) return toast(t("panel.actFail"));
      done(t("panel.chr.updated"));
      return;
    }
    if (btn.hasAttribute("data-crp-remove")) {
      if (!confirm(t("panel.chr.removeAsk", { name: g.channel_name, pkg: g.package_name }))) return;
      const del = await supabaseRequest(
        `/rest/v1/listchannels?package_name=eq.${restValue(g.package_name)}&channel_name=eq.${restValue(g.channel_name)}`,
        { method: "DELETE" }
      );
      if (!del.ok) return toast(t("panel.actFail"));
      const open = g.items.filter((x) => x.status === "open");
      if (open.length) {
        await supabaseRequest(`/rest/v1/channel_reports?id=in.(${ids(open)})`, { method: "PATCH", body: JSON.stringify({ status: "resolved", ...stamp() }) });
      }
      done(t("panel.chr.removed"));
      return;
    }
    if (btn.hasAttribute("data-crp-delete")) {
      if (!confirm(t("panel.chr.deleteAsk"))) return;
      const r = await supabaseRequest(`/rest/v1/channel_reports?id=in.(${ids(g.items)})`, { method: "DELETE" });
      if (!r.ok) return toast(t("panel.actFail"));
      done(t("panel.chr.deleted"));
    }
  }

  // Prizes: three tabs (add / manage / statistics) live in js/panel-prizes.js.
  async function viewPrizes(main) {
    await window.PanelPrizes.render(main, { staff: state.staff });
  }

  // ---------- Messages: admin team chat + member requests ----------
  const STAFF_MSGS = "/rest/v1/staff_messages";
  const REQ_QUERY = "/rest/v1/panel_messages?select=*&order=created_at.desc&limit=300";

  const msgIso = (v) => (v ? String(v) : "");
  const fmtWhen = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
  };
  const byNewest = (a, b) => msgIso(b.last).localeCompare(msgIso(a.last));
  const statusLabel = (st) => (st === "seen" ? t("prof.stSeen") : st === "unseen" ? t("prof.stSent") : "");

  const myStaffId = () => String(state.staff?.id || "");
  const myStaffName = () => state.staff?.username || roleLabel(state.staff?.role) || "";

  async function loadStaffChatRows() {
    const id = state.staff?.id;
    if (!id) return { ok: false, rows: [] };
    const res = await supabaseRequest(
      `${STAFF_MSGS}?or=(sender_staff_id.eq.${id},receiver_staff_id.eq.${id})&select=*&order=created_at.desc&limit=400`
    );
    if (res.ok) return { ok: true, rows: Array.isArray(res.data) ? res.data : [] };
    /* older installs: sender_id/receiver_id column names */
    const alt = await supabaseRequest(
      `${STAFF_MSGS}?or=(sender_id.eq.${id},receiver_id.eq.${id})&select=*&order=created_at.desc&limit=400`
    );
    return { ok: alt.ok, rows: alt.ok && Array.isArray(alt.data) ? alt.data : [] };
  }

  function staffChatKey(m, id) {
    const sender = String(m.sender_staff_id ?? m.sender_id ?? "");
    const receiver = String(m.receiver_staff_id ?? m.receiver_id ?? "");
    return sender === id ? receiver : sender;
  }

  function staffChatMeta(m, id, mine) {
    return mine
      ? { role: m.receiver_role || "", username: m.receiver_username || "", member_id: m.receiver_member_id || "" }
      : { role: m.sender_role || "", username: m.sender_username || "", member_id: m.sender_member_id || "" };
  }

  function buildStaffConversations(rows) {
    const id = myStaffId();
    const convs = new Map();
    const ensure = (staffId, meta = {}) => {
      const key = String(staffId);
      if (!convs.has(key)) {
        const known = state.staffRows.find((s) => String(s.id) === key) || {};
        convs.set(key, {
          key,
          staff_id: key,
          username: known.username || meta.username || key,
          role: known.role || meta.role || "",
          member_id: known.member_id || meta.member_id || "",
          rows: [],
          unread: 0,
          last: "",
          avatar: "",
        });
      }
      const conv = convs.get(key);
      if (!conv.role && meta.role) conv.role = meta.role;
      if (!conv.member_id && meta.member_id) conv.member_id = meta.member_id;
      return conv;
    };
    state.staffRows.forEach((s) => { if (String(s.id) !== id) ensure(s.id, s); });
    rows.forEach((m) => {
      const mine = String(m.sender_staff_id ?? m.sender_id ?? "") === id;
      if (mine && m.sender_deleted) return;
      if (!mine && m.receiver_deleted) return;
      const conv = ensure(staffChatKey(m, id), staffChatMeta(m, id, mine));
      conv.rows.push({ ...m, _mine: mine });
      if (!mine && !m.read) conv.unread += 1;
      const at = msgIso(m.created_at);
      if (at > conv.last) conv.last = at;
    });
    convs.forEach((c) => { c.avatar = avatarUrlFor(c.member_id, c.username); });
    return [...convs.values()];
  }

  async function loadRequestData() {
    const memberId = state.staff?.member_id || "";
    const [req, direct, replies] = await Promise.all([
      supabaseRequest(REQ_QUERY),
      memberId
        ? supabaseRequest(`/rest/v1/messages?receiver_id=eq.${restValue(memberId)}&select=*&order=created_at.desc&limit=300`)
        : Promise.resolve({ ok: true, data: [] }),
      supabaseRequest("/rest/v1/panel_replies?select=*&order=created_at.asc&limit=500"),
    ]);
    const rows = req.ok && Array.isArray(req.data) ? req.data : [];
    const dmRows = direct.ok && Array.isArray(direct.data) ? direct.data : [];
    const rep = replies.ok && Array.isArray(replies.data) ? replies.data : [];
    const staffMemberIds = new Set(state.staffRows.map((s) => String(s.member_id || "")).filter(Boolean));
    const replyMap = new Map();
    rep.forEach((r) => {
      const k = String(r.message_id);
      if (!replyMap.has(k)) replyMap.set(k, []);
      replyMap.get(k).push(r);
    });
    const convs = new Map();
    const ensure = (key, seed) => {
      if (!convs.has(key)) {
        convs.set(key, {
          key,
          member: seed.member || "",
          name: seed.name || "",
          email: seed.email || "",
          source: seed.source || "member",
          pm: [],
          replies: [],
          dm: [],
          last: "",
          unread: 0,
          avatar: "",
        });
      }
      const c = convs.get(key);
      if (!c.name && seed.name) c.name = seed.name;
      if (!c.email && seed.email) c.email = seed.email;
      return c;
    };
    rows.forEach((m) => {
      const key = m.sender_id ? `m:${m.sender_id}` : `c:${String(m.sender_email || m.sender_name || m.id).toLowerCase()}`;
      const conv = ensure(key, { member: m.sender_id || "", name: m.sender_name || "", email: m.sender_email || "", source: m.source });
      conv.pm.push(m);
      const at = msgIso(m.created_at);
      if (at > conv.last) conv.last = at;
    });
    convs.forEach((c) => {
      c.pm.forEach((m) => (replyMap.get(String(m.id)) || []).forEach((r) => c.replies.push(r)));
      c.replies.forEach((r) => {
        const at = msgIso(r.created_at);
        if (at > c.last) c.last = at;
      });
    });
    dmRows.forEach((m) => {
      if (!m.sender_id || staffMemberIds.has(String(m.sender_id))) return;
      const conv = ensure(`m:${m.sender_id}`, { member: m.sender_id, name: m.sender_username || "" });
      conv.dm.push(m);
      const at = msgIso(m.created_at);
      if (at > conv.last) conv.last = at;
    });
    const list = [...convs.values()];
    const oldestFirst = (a, b) => msgIso(a.created_at).localeCompare(msgIso(b.created_at));
    list.forEach((c) => {
      c.pm.sort(oldestFirst);
      c.replies.sort(oldestFirst);
      c.dm.sort(oldestFirst);
      c.unread = c.pm.filter((m) => !m.read).length + c.dm.filter((m) => !m.read).length;
    });
    await primeAvatars(list.map((c) => c.member), list.map((c) => c.name));
    list.forEach((c) => {
      c.avatar = avatarUrlFor(c.member, c.name);
      const label = c.name || c.email || c.member || t("panel.visitor");
      c.label = c.member && !label.startsWith("@") ? `@${label}` : label;
    });
    return { list, unread: list.reduce((n, c) => n + c.unread, 0) };
  }

  async function viewMessages(main) {
    const ui = (state.msgUi = state.msgUi || { tab: "staff", reqFilter: "all", q: "" });
    if (!["staff", "requests"].includes(ui.tab)) ui.tab = "staff";
    await loadStaffRows();
    const [chat, req] = await Promise.all([loadStaffChatRows(), loadRequestData()]);
    const staffConvs = chat.ok ? buildStaffConversations(chat.rows) : [];
    const staffUnread = staffConvs.reduce((n, c) => n + c.unread, 0);
    const tab = (k, label, count) =>
      `<button type="button" role="tab" class="follow-tab${ui.tab === k ? " active" : ""}" data-msgtab="${k}">${label}${count ? `<span class="follow-count">${count}</span>` : ""}</button>`;
    main.innerHTML = `
      <p class="eyebrow">${t("panel.nav.messages")}</p>
      <h1>${t("panel.messagesTitle")}</h1>
      <p class="muted">${ui.tab === "staff" ? t("panel.staffChatLead") : t("panel.requestsLead")}</p>
      <div class="tabs follow-tabs" role="tablist">
        ${tab("staff", t("panel.tab.staffMsgs"), staffUnread)}
        ${tab("requests", t("panel.tab.requests"), req.unread)}
      </div>
      <div id="pm-pane"></div>`;
    main.querySelectorAll("[data-msgtab]").forEach((b) => {
      b.onclick = () => { ui.tab = b.dataset.msgtab; viewMessages(main); };
    });
    const pane = $("#pm-pane");
    if (ui.tab === "staff") renderStaffChats(pane, chat, staffConvs, main);
    else renderRequests(pane, req, main);
  }

  function renderStaffChats(pane, chat, convs, main) {
    if (!chat.ok) {
      pane.innerHTML = `<p class="empty">${t("panel.staffChatNone")}</p>
        <p class="muted">${t("panel.staffChatHint")}</p>`;
      return;
    }
    convs.sort(byNewest);
    pane.innerHTML = convs.length
      ? convs.map((c) => {
          const last = c.rows[0];
          const mine = Boolean(last) && last._mine;
          const st = mine ? (last.read ? "seen" : "unseen") : "";
          const snippet = last ? `${mine ? `${t("prof.you")}: ` : ""}${escapeHtml(last.body)}` : t("panel.staffChatStart");
          return `<div class="mp-row${c.unread ? " mp-unread" : ""}">
            <div class="mp-avatar off">
              ${medalTag(c.role, c.member_id, c.username)}
            </div>
            <div class="mp-main">
              <div class="mp-top"><strong>${escapeHtml(c.username)}</strong><span class="chip staff-chip">${escapeHtml(roleLabel(c.role))}</span></div>
              <div class="mp-last ${st || (c.unread ? "unread" : "recv")}"><span class="mp-text">${snippet}</span>${st ? `<span class="mp-st">${statusLabel(st)}</span>` : ""}</div>
            </div>
            <div class="mp-date">${last ? fmtWhen(last.created_at) : ""}</div>
            <div class="mp-actions">
              <button class="btn btn-sm btn-primary" data-pm-staff="${escapeHtml(c.staff_id)}" type="button">${t("common.open")}</button>
            </div>
          </div>`;
        }).join("")
      : `<p class="empty">${t("panel.staffChatNone")}</p>`;
    pane.onclick = (e) => {
      const open = e.target.closest("[data-pm-staff]");
      if (!open) return;
      const conv = convs.find((c) => String(c.staff_id) === open.dataset.pmStaff);
      if (conv) openStaffChat(conv, () => viewMessages(main));
    };
    hydrateAvatars(pane);
    hydrateMedals(pane);
  }

  function renderRequests(pane, req, main) {
    const ui = state.msgUi;
    pane.innerHTML = `
      <div class="mp-controls pm-controls">
        <input id="pm-q" type="search" value="${escapeHtml(ui.q || "")}" placeholder="${t("panel.searchRequests")}" />
        <div class="chip-row">
          <button class="btn btn-sm btn-primary" data-pmf="all" type="button">${t("panel.tab.all")}</button>
          <button class="btn btn-sm btn-ghost" data-pmf="unread" type="button">${t("panel.unreadOnly")}</button>
        </div>
        <p class="muted pm-legend">${t("panel.msgLegend")}</p>
      </div>
      <div id="pm-list"></div>`;
    const syncFilter = () => {
      pane.querySelectorAll("[data-pmf]").forEach((b) => {
        const on = b.dataset.pmf === ui.reqFilter;
        b.classList.toggle("btn-primary", on);
        b.classList.toggle("btn-ghost", !on);
      });
    };
    const drawList = () => {
      const q = String(ui.q || "").trim().toLowerCase().replace(/^@/, "");
      let list = req.list.slice();
      if (ui.reqFilter === "unread") list = list.filter((c) => c.unread);
      if (q) {
        list = list.filter((c) =>
          `${c.name} ${c.label} ${c.member} ${c.email} ${c.pm.map((m) => m.body).join(" ")}`.toLowerCase().includes(q)
        );
      }
      list.sort(byNewest);
      const box = $("#pm-list");
      if (!box) return;
      box.innerHTML = list.length
        ? list.map((c) => {
            const last = latestRequestEntry(c);
            const mine = Boolean(last) && last._mine;
            const st = mine ? (last.read ? "seen" : "unseen") : "";
            return `<div class="mp-row${c.unread ? " mp-unread" : ""}">
              <div class="mp-avatar off">
                <img src="${escapeHtml(c.avatar || initialsAvatar(c.label))}" alt="" data-avatar-for="${escapeHtml(c.member)}" data-avatar-name="${escapeHtml(c.name)}" />
              </div>
              <div class="mp-main">
                <div class="mp-top">
                  <strong>${escapeHtml(c.label)}</strong>
                  <span class="chip">${escapeHtml(t(`panel.src.${c.source}`))}</span>
                  ${c.unread ? `<span class="mp-state on">${t("panel.unreadN", { n: c.unread })}</span>` : ""}
                </div>
                <div class="mp-last ${st || (c.unread ? "unread" : "recv")}">
                  <span class="mp-text">${last ? `${mine ? `${t("prof.you")}: ` : ""}${escapeHtml(String(last.body || "").slice(0, 90))}` : t("prof.noMsgYet")}</span>
                  ${st ? `<span class="mp-st">${statusLabel(st)}</span>` : ""}
                </div>
              </div>
              <div class="mp-date">${fmtWhen(c.last)}</div>
              <div class="mp-actions">
                <button class="btn btn-sm btn-primary" data-pm-req="${escapeHtml(c.key)}" type="button">${t("panel.openRequest")}</button>
              </div>
            </div>`;
          }).join("")
        : `<p class="empty">${t("prof.noMsg")}</p>`;
      hydrateAvatars(box);
    };
    $("#pm-q").oninput = (e) => { ui.q = e.target.value; drawList(); };
    syncFilter();
    pane.querySelectorAll("[data-pmf]").forEach((b) => {
      b.onclick = () => { ui.reqFilter = b.dataset.pmf; syncFilter(); drawList(); };
    });
    $("#pm-list").onclick = (e) => {
      const open = e.target.closest("[data-pm-req]");
      if (!open) return;
      const conv = req.list.find((c) => c.key === open.dataset.pmReq);
      if (conv) openRequestChat(conv, () => viewMessages(main));
    };
    drawList();
  }

  function latestRequestEntry(conv) {
    const myId = state.staff?.member_id || "";
    const entries = [
      ...conv.pm.map((m) => ({ ...m, _mine: false })),
      ...conv.replies.map((r) => ({ ...r, _mine: true, mineStaff: true })),
      ...conv.dm.map((m) => ({ ...m, _mine: m.sender_id === myId })),
    ];
    entries.sort((a, b) => msgIso(b.created_at).localeCompare(msgIso(a.created_at)));
    return entries[0] || null;
  }

  function chatOverlay(html) {
    $$(".chat-overlay").forEach((el) => el.remove());
    const overlay = document.createElement("div");
    overlay.className = "chat-overlay";
    overlay.innerHTML = `<section class="glass chat-box">${html}</section>`;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    overlay.querySelector("[data-chat-close]")?.addEventListener("click", () => overlay.remove());
    return overlay;
  }

  function chatFace(memberId, username, fallback) {
    return `<span class="chat-face"><img src="${escapeHtml(avatarUrlFor(memberId, username) || initialsAvatar(fallback || username || "CA"))}" alt="" data-avatar-for="${escapeHtml(memberId || "")}" data-avatar-name="${escapeHtml(username || "")}" /></span>`;
  }

  async function openStaffChat(conv, onClose) {
    const id = myStaffId();
    const overlay = chatOverlay(`
      <div class="chat-head">
        ${chatFace(conv.member_id, conv.username, conv.username)}
        <div><h2>${escapeHtml(conv.username)}</h2><span class="chip staff-chip">${escapeHtml(roleLabel(conv.role))}</span></div>
        <button class="btn btn-sm btn-ghost" type="button" data-chat-close>${t("common.close")}</button>
      </div>
      <div class="chat-log" id="pm-log"></div>
      <div class="form-row">
        <input id="pm-text" placeholder="${t("prof.writeMsg")}" />
        <button class="btn btn-sm btn-primary" id="pm-send" type="button">${t("common.send")}</button>
      </div>`);
    let timer = null;
    const close = () => { clearInterval(timer); overlay.remove(); if (onClose) onClose(); };
    overlay.querySelector("[data-chat-close]").onclick = close;
    const load = async () => {
      const res = await supabaseRequest(
        `${STAFF_MSGS}?or=(and(sender_staff_id.eq.${id},receiver_staff_id.eq.${conv.staff_id}),and(sender_staff_id.eq.${conv.staff_id},receiver_staff_id.eq.${id}))&select=*&order=created_at.asc`
      );
      const rows = res.ok && Array.isArray(res.data) ? res.data : [];
      const log = overlay.querySelector("#pm-log");
      if (!rows.length) {
        log.innerHTML = `<p class="muted">${t("prof.startConv")}</p>`;
        return;
      }
      log.innerHTML = rows.map((m) => {
        const mine = String(m.sender_staff_id ?? m.sender_id ?? "") === id;
        const st = mine ? (m.read ? "seen" : "unseen") : "";
        return `<div class="bubble ${mine ? `mine ${st}` : ""}">${escapeHtml(m.body)}
          <div class="muted">${fmtWhen(m.created_at)}${st ? ` · ${statusLabel(st)}` : ""}</div>
        </div>`;
      }).join("");
      log.scrollTop = log.scrollHeight;
      if (rows.some((m) => String(m.sender_staff_id ?? m.sender_id ?? "") !== id && !m.read)) {
        await supabaseRequest(
          `${STAFF_MSGS}?sender_staff_id=eq.${conv.staff_id}&receiver_staff_id=eq.${id}&read=eq.false`,
          { method: "PATCH", body: JSON.stringify({ read: true }) }
        );
      }
    };
    const send = async () => {
      const input = overlay.querySelector("#pm-text");
      const body = input.value.trim();
      if (!body) return;
      const btn = overlay.querySelector("#pm-send");
      btn.disabled = true;
      const row = {
        sender_staff_id: Number(id),
        sender_member_id: state.staff?.member_id || "",
        sender_username: myStaffName(),
        sender_role: state.staff?.role || "",
        receiver_staff_id: Number(conv.staff_id),
        receiver_member_id: conv.member_id || "",
        receiver_username: conv.username || "",
        receiver_role: conv.role || "",
        body,
      };
      const res = await supabaseRequest(STAFF_MSGS, { method: "POST", body: JSON.stringify(row) });
      btn.disabled = false;
      if (!res.ok) return toast(t("panel.staffChatHint"));
      input.value = "";
      load();
    };
    overlay.querySelector("#pm-send").onclick = send;
    overlay.querySelector("#pm-text").addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
    timer = setInterval(() => { if (!document.body.contains(overlay)) clearInterval(timer); else load(); }, 7000);
    hydrateAvatars(overlay);
    load();
  }

  async function openRequestChat(conv, onClose) {
    const myId = state.staff?.member_id || "";
    const overlay = chatOverlay(`
      <div class="chat-head">
        ${chatFace(conv.member, conv.name, conv.label)}
        <div><h2>${escapeHtml(conv.label)}</h2><span class="muted">${escapeHtml(conv.member || conv.email || t("panel.visitor"))}</span></div>
        <button class="btn btn-sm btn-ghost" type="button" data-chat-close>${t("common.close")}</button>
      </div>
      <div class="chat-log" id="pm-log"></div>
      <div class="form-row">
        <input id="pm-text" placeholder="${t("prof.writeMsg")}" />
        <button class="btn btn-sm btn-primary" id="pm-send" type="button">${t("common.send")}</button>
      </div>`);
    let timer = null;
    const close = () => { clearInterval(timer); overlay.remove(); if (onClose) onClose(); };
    overlay.querySelector("[data-chat-close]").onclick = close;
    const draw = (entries) => {
      const log = overlay.querySelector("#pm-log");
      log.innerHTML = entries.length
        ? entries.map((m) => {
            const st = m.mine && !m.mineStaff ? (m.read ? "seen" : "unseen") : "";
            return `<div class="bubble ${m.mine ? `mine ${st}` : ""}">${escapeHtml(m.body)}
              <div class="muted">${fmtWhen(m.at)}${st ? ` · ${statusLabel(st)}` : ""}${m.label ? ` · ${escapeHtml(m.label)}` : ""}${m.mineStaff ? ` · ${t("panel.reply")}` : ""}</div>
            </div>`;
          }).join("")
        : `<p class="muted">${t("prof.startConv")}</p>`;
      log.scrollTop = log.scrollHeight;
    };
    const refresh = async () => {
      const ids = conv.pm.map((m) => m.id);
      const [req, incoming, outgoing, replies] = await Promise.all([
        ids.length ? supabaseRequest(`/rest/v1/panel_messages?id=in.(${ids.join(",")})&select=*&order=created_at.asc`) : Promise.resolve({ ok: true, data: [] }),
        conv.member && myId
          ? supabaseRequest(`/rest/v1/messages?sender_id=eq.${restValue(conv.member)}&receiver_id=eq.${restValue(myId)}&select=*&order=created_at.asc`)
          : Promise.resolve({ ok: true, data: [] }),
        conv.member && myId
          ? supabaseRequest(`/rest/v1/messages?sender_id=eq.${restValue(myId)}&receiver_id=eq.${restValue(conv.member)}&select=*&order=created_at.asc`)
          : Promise.resolve({ ok: true, data: [] }),
        ids.length ? supabaseRequest(`/rest/v1/panel_replies?message_id=in.(${ids.join(",")})&select=*&order=created_at.asc`) : Promise.resolve({ ok: true, data: [] }),
      ]);
      const rows = req.ok && Array.isArray(req.data) ? req.data : conv.pm;
      const dmIn = incoming.ok && Array.isArray(incoming.data) ? incoming.data : [];
      const dmOut = outgoing.ok && Array.isArray(outgoing.data) ? outgoing.data : [];
      const rep = replies.ok && Array.isArray(replies.data) ? replies.data : conv.replies;
      const entries = [
        ...rows.map((m) => ({ at: m.created_at, body: m.body, mine: false, label: m.source === "contact" ? t("panel.src.contact") : "" })),
        ...dmIn.map((m) => ({ at: m.created_at, body: m.body, mine: false, read: m.read })),
        ...rep.map((r) => ({ at: r.created_at, body: r.body, mine: true, mineStaff: true, role: r.staff_role })),
        ...dmOut.map((m) => ({ at: m.created_at, body: m.body, mine: true, read: m.read })),
      ];
      entries.sort((a, b) => msgIso(a.at).localeCompare(msgIso(b.at)));
      draw(entries);
      const unreadPm = rows.filter((m) => !m.read).map((m) => m.id);
      if (unreadPm.length) {
        await supabaseRequest(`/rest/v1/panel_messages?id=in.(${unreadPm.join(",")})`, { method: "PATCH", body: JSON.stringify({ read: true }) });
      }
      if (myId && dmIn.some((m) => !m.read)) {
        await supabaseRequest(`/rest/v1/messages?receiver_id=eq.${restValue(myId)}&sender_id=eq.${restValue(conv.member)}&read=eq.false`, {
          method: "PATCH",
          body: JSON.stringify({ read: true }),
        });
      }
    };
    const send = async () => {
      const input = overlay.querySelector("#pm-text");
      const body = input.value.trim();
      if (!body) return;
      const btn = overlay.querySelector("#pm-send");
      btn.disabled = true;
      let ok = false;
      if (conv.member && myId) {
        const res = await supabaseRequest("/rest/v1/messages", {
          method: "POST",
          body: JSON.stringify({
            sender_id: myId,
            receiver_id: conv.member,
            sender_username: myStaffName(),
            receiver_username: conv.name || conv.label,
            body,
          }),
        });
        ok = res.ok;
        if (ok) {
          await supabaseRequest("/rest/v1/notifications", {
            method: "POST",
            body: JSON.stringify({
              member_id: conv.member,
              kind: "message",
              title: t("prof.newMsg"),
              body: `${myStaffName()}: ${body.slice(0, 80)}`,
              href: "./Profile.html?@" + encodeURIComponent(myStaffName()),
              from_id: myId,
              from_username: myStaffName(),
            }),
          }).catch(() => {});
        }
      }
      if (conv.pm.length) {
        const target = conv.pm[conv.pm.length - 1];
        const res = await supabaseRequest("/rest/v1/panel_replies", {
          method: "POST",
          body: JSON.stringify({
            message_id: target.id,
            staff_role: state.staff?.role || "",
            staff_member_id: myId,
            body,
          }),
        });
        ok = ok || res.ok;
      }
      btn.disabled = false;
      if (!ok) return toast(t("panel.actFail"));
      input.value = "";
      toast(t("panel.replied"));
      refresh();
    };
    overlay.querySelector("#pm-send").onclick = send;
    overlay.querySelector("#pm-text").addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
    timer = setInterval(() => { if (!document.body.contains(overlay)) clearInterval(timer); else refresh(); }, 8000);
    hydrateAvatars(overlay);
    refresh();
  }

  // ---------- M3U import -> public.listchannels ----------
  // The parser lives in js/common.js (CineAura.parseM3U): the channel player uses it too.
  async function readM3uText({ url, file }) {
    if (file) {
      if (file.size > 30 * 1024 * 1024) throw new Error("too large");
      return file.text();
    }
    if (!/^https?:\/\//i.test(url || "")) throw new Error("bad url");
    try {
      const r = await fetch(url);
      if (r.ok) return await r.text();
    } catch { /* blocked by CORS: use the server proxy */ }
    const r2 = await fetch(`/api/m3u?url=${encodeURIComponent(url)}`);
    if (!r2.ok) throw new Error("fetch failed");
    return r2.text();
  }

  // Columns added by sql/iptv.sql and sql/channels.sql. A database that has not
  // run them yet keeps working: the write goes again without the column, and the
  // panel says which file to run.
  const OPTIONAL_COLS = { iptv: ["epg_url", "assigned_at", "expires_at"], listchannels: ["stream_url", "epg_id"] };
  const missingCols = new Set();

  function missingColumn(res) {
    const raw = JSON.stringify(res?.data || {});
    if (!/PGRST204|42703|schema cache|does not exist/i.test(raw)) return "";
    const m = /'([a-z_]+)' column/i.exec(raw) || /column "?(?:[a-z_]+\.)?([a-z_]+)"? (?:of relation \S+ )?does not exist/i.exec(raw);
    return m ? m[1] : "";
  }

  async function writeTolerant(path, method, body, optional) {
    const many = Array.isArray(body);
    const payload = many ? body.map((r) => ({ ...r })) : { ...body };
    const strip = (col) => (many ? payload.forEach((r) => delete r[col]) : delete payload[col]);
    optional.filter((c) => missingCols.has(c)).forEach(strip);
    for (let i = 0; i <= optional.length; i += 1) {
      const res = await supabaseRequest(path, { method, body: JSON.stringify(payload) });
      if (res.ok) return res;
      const col = missingColumn(res);
      if (!col || !optional.includes(col) || missingCols.has(col)) return res;
      missingCols.add(col);
      strip(col);
    }
    return { ok: false, data: null };
  }

  // A playlist names its programme guide in its first line (#EXTM3U url-tvg="…"):
  // keep it with the account when the account has none yet.
  async function saveHeaderEpg(account, text) {
    const epg = window.CineAura.m3uHeaderEpg(text);
    if (!epg || !account?.id || String(account.epg_url || "").trim() || missingCols.has("epg_url")) return "";
    const r = await writeTolerant(`/rest/v1/iptv?id=eq.${encodeURIComponent(account.id)}`, "PATCH", { epg_url: epg }, OPTIONAL_COLS.iptv);
    if (!r.ok || missingCols.has("epg_url")) return "";
    account.epg_url = epg;
    return epg;
  }

  async function importChannels(pkg, source, replace, account = null) {
    let text;
    try { text = await readM3uText(source); } catch { toast(t("panel.iptv.impFail")); return 0; }
    const rows = window.CineAura.parseM3U(text).slice(0, 20000).map((r) => ({ package_name: pkg, ...r }));
    if (!rows.length) { toast(t("panel.iptv.impEmpty")); return 0; }
    if (replace) await supabaseRequest(`/rest/v1/listchannels?package_name=eq.${encodeURIComponent(pkg)}`, { method: "DELETE" });
    for (let i = 0; i < rows.length; i += 500) {
      // without sql/channels.sql the channels come in without their links / guide ids
      const r = await writeTolerant("/rest/v1/listchannels", "POST", rows.slice(i, i + 500), OPTIONAL_COLS.listchannels);
      if (!r.ok) { toast(t("panel.actFail")); return i; }
    }
    const epg = await saveHeaderEpg(account, text).catch(() => "");
    const key = missingCols.has("stream_url") ? "panel.iptv.noStreamCol" : missingCols.has("epg_id") ? "panel.iptv.noEpgCol" : epg ? "panel.iptv.importedEpg" : "panel.iptv.imported";
    toast(t(key, { n: rows.length }));
    return rows.length;
  }

  // ---------- IPTV: who gets a premium account ----------
  // The member directory holds the newest 400 members, loaded when the panel
  // opened. Anyone else (an older member, or one who signed up since) is looked
  // up in the database by member ID or username.
  const ID_RE = /^id\d{1,20}$/i;
  const memberKey = (v) => String(v || "").trim().replace(/^@/, "").toLowerCase();

  function knownMember(value) {
    const q = memberKey(value);
    if (!q) return null;
    const same = (m) => memberKey(m.member_id) === q || memberKey(m.username) === q;
    return state.members.find(same) || state.extraMembers.find(same) || null;
  }

  function rememberMembers(list) {
    list.forEach((m) => {
      if (m?.member_id && !knownMember(m.member_id)) state.extraMembers.push(m);
    });
  }

  async function resolveMember(value) {
    const raw = String(value || "").trim().replace(/^@/, "");
    if (!raw) return null;
    const local = knownMember(raw);
    if (local) return local;
    const q = raw.toLowerCase();
    const filters = [];
    if (ID_RE.test(raw)) filters.push(`member_id=eq.${encodeURIComponent(`ID${raw.slice(2)}`)}`);
    // ilike ignores case; it also treats "_" as a wildcard, so the name is checked exactly below
    if (/^[A-Za-z0-9._]{2,40}$/.test(raw)) filters.push(`username=ilike.${encodeURIComponent(raw)}`);
    for (const filter of filters) {
      const res = await supabaseRequest(`/rest/v1/members?${filter}&select=member_id,full_name,username,status&limit=5`);
      const hit = (res.ok && Array.isArray(res.data) ? res.data : []).find((m) => memberKey(m.member_id) === q || memberKey(m.username) === q);
      if (hit) {
        rememberMembers([hit]);
        return hit;
      }
    }
    return null;
  }

  // owners of premium accounts who are not in the directory: fetch their names once
  // (owner_id is a member id; a row typed by hand may hold a username instead)
  async function loadOwners(rows) {
    const owners = [...new Set(rows.map((r) => String(r.owner_id || "").trim().replace(/^@/, "")).filter((v) => v && !knownMember(v)))];
    const ids = owners.filter((v) => ID_RE.test(v));
    const names = owners.filter((v) => !ID_RE.test(v) && /^[A-Za-z0-9._]{2,40}$/.test(v));
    const select = "select=member_id,full_name,username,status";
    for (let i = 0; i < ids.length; i += 80) {
      const part = ids.slice(i, i + 80).map((v) => encodeURIComponent(`"${v}"`)).join(",");
      const res = await supabaseRequest(`/rest/v1/members?member_id=in.(${part})&${select}`);
      if (res.ok && Array.isArray(res.data)) rememberMembers(res.data);
    }
    // usernames in any case (ilike); knownMember compares them exactly afterwards
    for (let i = 0; i < names.length; i += 30) {
      const part = names.slice(i, i + 30).map((v) => `username.ilike.${encodeURIComponent(`"${v}"`)}`).join(",");
      const res = await supabaseRequest(`/rest/v1/members?or=(${part})&${select}&limit=90`);
      if (res.ok && Array.isArray(res.data)) rememberMembers(res.data);
    }
  }

  // The member hears of it in their notifications (bell + Notifications page),
  // which open Dashboard > IPTV. The title is shown in the member's language
  // (CineAura.noteTitle); the stored one is for anything else that reads the row.
  async function notifyIptvOwner(member, account, renewed = false) {
    if (!member?.member_id) return false;
    const res = await supabaseRequest("/rest/v1/notifications", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        member_id: member.member_id,
        kind: renewed ? "iptv_renew" : "iptv",
        title: renewed ? "Your premium IPTV account was renewed" : "You received a premium IPTV account",
        body: String(account?.name || "").slice(0, 200),
        href: "./dashboard.html#iptv",
        from_id: "",
        from_username: "",
      }),
    }).catch(() => ({ ok: false }));
    return Boolean(res.ok);
  }

  const memberLabel = (m) => (m.username ? `@${m.username} · ${m.member_id}` : m.member_id);
  const DURATIONS = ["1 month", "3 months", "6 months", "12 months", "unlimited"];

  // given now, valid for the account's duration ("1 month", "unlimited", …)
  function assignment(duration) {
    const now = new Date();
    return { assigned_at: now.toISOString(), expires_at: window.CineAura.iptvExpiry(now, duration)?.toISOString() || null };
  }

  function validityText(r) {
    const CA = window.CineAura;
    if (CA.iptvIsFree(r) || !String(r.owner_id || "").trim()) return "";
    const tm = CA.iptvTiming(r);
    const parts = [];
    if (tm.start) parts.push(t("panel.iptv.givenOn", { date: fmtWhen(tm.start) }));
    if (tm.exp) parts.push(t(tm.left > 0 ? "panel.iptv.until" : "panel.iptv.endedOn", { date: fmtWhen(tm.exp) }));
    return parts.join(" · ");
  }

  function bindMemberHint(input, out) {
    let run = 0;
    input.addEventListener("input", () => {
      const mine = ++run;
      const value = input.value.trim();
      clearTimeout(out._t);
      out.textContent = "";
      out.classList.remove("bad");
      if (!value) return;
      out._t = setTimeout(async () => {
        const m = await resolveMember(value).catch(() => null);
        if (mine !== run) return;
        const tick = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
        out.innerHTML = m ? `${tick}<bdi>${escapeHtml(`${m.full_name ? `${m.full_name} · ` : ""}${memberLabel(m)}`)}</bdi>` : escapeHtml(t("panel.iptv.noMember", { q: value }));
        out.classList.toggle("bad", !m);
      }, 350);
    });
  }

  function editEpg(main, row) {
    const CA = window.CineAura;
    const m3u = CA.iptvKind(row) === "m3u";
    const ov = overlay(`
      <h2>${t("panel.iptv.epgTitle")}</h2>
      <p class="muted">${escapeHtml(row.name)}</p>
      <div class="stack">
        <input id="ep-url" type="url" dir="ltr" inputmode="url" value="${escapeHtml(row.epg_url || "")}" placeholder="https://…/epg.xml.gz" />
        <p class="muted ipx-hint">${t(m3u ? "panel.iptv.epgHintM" : "panel.iptv.epgHintX")}</p>
        <div class="toolbar">
          <button class="btn btn-sm btn-primary" id="ep-save" type="button">${t("common.save")}</button>
          ${m3u ? `<button class="btn btn-sm btn-ghost" id="ep-find" type="button">${t("panel.iptv.epgFind")}</button>` : ""}
          <button class="btn btn-sm btn-ghost" data-close type="button">${t("common.close")}</button>
        </div>
      </div>`);
    const input = ov.querySelector("#ep-url");
    input.focus();
    ov.querySelector("#ep-find")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const epg = CA.m3uHeaderEpg(await readM3uText({ url: row.m3u_url }));
        if (epg) input.value = epg;
        toast(t(epg ? "panel.iptv.epgFound" : "panel.iptv.epgNone"));
      } catch {
        toast(t("panel.iptv.impFail"));
      }
      btn.disabled = false;
    });
    ov.querySelector("#ep-save").onclick = async () => {
      const value = input.value.trim();
      if (value && !/^https?:\/\/\S+$/i.test(value)) return toast(t("panel.iptv.needEpg"));
      const res = await writeTolerant(`/rest/v1/iptv?id=eq.${encodeURIComponent(row.id)}`, "PATCH", { epg_url: value }, OPTIONAL_COLS.iptv);
      if (!res.ok) return toast(t("panel.actFail"));
      if (missingCols.has("epg_url")) return toast(t("panel.iptv.noIptvCols"));
      ov.remove();
      toast(t(value ? "panel.iptv.epgSaved" : "panel.iptv.epgCleared"));
      viewIptv(main);
    };
  }

  async function viewIptv(main) {
    if (!state.members.length) await loadDirectory();
    const res = await supabaseRequest("/rest/v1/iptv?select=*&order=id.desc");
    const rows = res.ok && Array.isArray(res.data) ? res.data : [];
    await loadOwners(rows).catch(() => null);
    const CA = window.CineAura;
    const isFree = (r) => CA.iptvIsFree(r);
    const kindOf = (r) => r.kind || (r.xstream_user ? "xtream" : "m3u");
    const filter = state.iptvFilter || "all";
    const shown = rows.filter((r) => filter === "all" || (filter === "free") === isFree(r));
    const who = (id) => {
      const m = knownMember(id);
      return m ? memberLabel(m) : id || "—";
    };
    const tab = (k, label) => `<button type="button" class="follow-tab${filter === k ? " active" : ""}" data-ipf="${k}">${label}</button>`;
    const colsHint = missingCols.has("epg_url") || missingCols.has("assigned_at") || missingCols.has("expires_at") ? `<p class="muted ipx-hint">${t("panel.iptv.noIptvCols")}</p>` : "";
    main.innerHTML = `
      <p class="eyebrow">${t("panel.nav.iptv")}</p>
      <h1>${t("panel.iptv.title")}</h1>
      <p class="muted">${t("panel.iptv.lead")}</p>
      <div class="mini-card stack" style="margin:16px 0">
        <div class="form-row">
          <input id="ip-name" placeholder="${t("panel.iptv.name")}" />
          <select id="ip-kind"><option value="xtream">Xtream Codes</option><option value="m3u">M3U Playlist</option></select>
        </div>
        <div id="ip-xt" class="stack">
          <input id="ip-server" dir="ltr" placeholder="http://host:port" />
          <div class="form-row"><input id="ip-user" dir="ltr" autocomplete="off" placeholder="${t("panel.iptv.user")}" /><input id="ip-pass" dir="ltr" autocomplete="off" placeholder="${t("panel.iptv.pass")}" /></div>
        </div>
        <div id="ip-m3" class="stack" style="display:none"><input id="ip-url" dir="ltr" placeholder="https://.../playlist.m3u" /></div>
        <div class="stack ip-epg">
          <label class="ipx-flabel" for="ip-epg">${t("iptv.epgLong")}</label>
          <input id="ip-epg" type="url" dir="ltr" inputmode="url" placeholder="https://…/epg.xml.gz" />
          <p class="muted ipx-hint" id="ip-epg-hint">${t("panel.iptv.epgHintX")}</p>
        </div>
        <div class="form-row">
          <select id="ip-access"><option value="free">${t("panel.iptv.free")}</option><option value="premium">${t("panel.iptv.paid")}</option></select>
          <input id="ip-dur" list="ip-durs" dir="auto" placeholder="${t("panel.iptv.duration")}" />
          <datalist id="ip-durs">${DURATIONS.map((d) => `<option value="${d}">${escapeHtml(CA.durationLabel(d))}</option>`).join("")}</datalist>
        </div>
        <div id="ip-own" class="stack" style="display:none">
          <input id="ip-member" list="ip-members" dir="auto" autocomplete="off" placeholder="${t("panel.iptv.memberPh")}" />
          <p class="muted ipx-hint ipx-who" id="ip-member-who" aria-live="polite"></p>
          <datalist id="ip-members">${state.members.map((m) => `<option value="${escapeHtml(m.member_id)}">@${escapeHtml(m.username || "")}</option>`).join("")}</datalist>
        </div>
        <div class="stack" style="border-top:1px solid var(--line);padding-top:12px">
          <strong>${t("panel.iptv.importTitle")}</strong>
          <select id="ip-imp">
            <option value="none">${t("panel.iptv.impNone")}</option>
            <option value="link">${t("panel.iptv.impLink")}</option>
            <option value="file">${t("panel.iptv.impFile")}</option>
          </select>
          <input id="ip-imp-url" dir="ltr" placeholder="${t("panel.iptv.impUrlPh")}" style="display:none" />
          <input id="ip-imp-file" type="file" accept=".m3u,.m3u8,.txt,audio/x-mpegurl,application/vnd.apple.mpegurl" style="display:none" />
        </div>
        <button class="btn btn-sm btn-primary" id="ip-add" type="button">${t("panel.iptv.add")}</button>
      </div>
      <div class="tabs follow-tabs">${tab("all", t("panel.iptv.all"))}${tab("free", t("panel.iptv.free"))}${tab("paid", t("panel.iptv.paid"))}</div>
      ${colsHint}
      <div class="ipx-grid" id="ip-list">${shown.map((r) => {
        const free = isFree(r);
        const valid = validityText(r);
        return `
        <article class="ipx-card">
          <header class="ipx-head">
            <h3>${escapeHtml(r.name)}</h3>
            <div class="ipx-badges">
              <span class="ipx-badge ${free ? "free" : "paid"}">${free ? t("panel.iptv.free") : t("panel.iptv.paid")}</span>
              <span class="ipx-badge">${CA.iptvKind(r) === "m3u" ? "M3U" : "Xtream"}</span>
              <span class="ipx-badge">${t("common.duration")}: ${escapeHtml(CA.durationLabel(r.duration))}</span>
              ${CA.iptvEpgUrl(r) ? `<span class="ipx-badge epg">${t("iptv.epg")}</span>` : ""}
              ${free ? "" : `<span class="ipx-badge">${t("panel.iptv.member")}: ${escapeHtml(who(r.owner_id))}</span>`}
            </div>
            ${valid ? `<p class="ipx-valid">${escapeHtml(valid)}</p>` : ""}
          </header>
          <div class="ipx-rows">${CA.iptvDetailRows(r)}</div>
          <footer class="ipx-actions">
            ${CA.iptvActionsHtml(r)}
            <button class="btn btn-sm btn-ghost" data-imp="${r.id}" type="button">${t("panel.iptv.importBtn")}</button>
            <button class="btn btn-sm btn-ghost" data-epg="${r.id}" type="button">${t("panel.iptv.epgBtn")}</button>
            <button class="btn btn-sm btn-danger" data-del="${r.id}" type="button">${t("common.remove")}</button>
          </footer>
          ${free ? "" : `<div class="ipx-assign"><input data-asg-in="${r.id}" list="ip-members" dir="auto" autocomplete="off" placeholder="${t("panel.iptv.memberPh")}" /><button class="btn btn-sm btn-primary" data-asg="${r.id}" type="button">${t("panel.iptv.assign")}</button></div>`}
        </article>`;
      }).join("") || `<p class="empty">${t("common.none")}</p>`}</div>`;
    window.CineAura.bindIptvActions($("#ip-list"), (id) => rows.find((x) => String(x.id) === id));
    const sync = () => {
      const m3 = $("#ip-kind").value === "m3u";
      $("#ip-xt").style.display = m3 ? "none" : "";
      $("#ip-m3").style.display = m3 ? "" : "none";
      $("#ip-epg-hint").textContent = t(m3 ? "panel.iptv.epgHintM" : "panel.iptv.epgHintX");
      $("#ip-own").style.display = $("#ip-access").value === "premium" ? "" : "none";
    };
    $("#ip-kind").onchange = sync;
    $("#ip-access").onchange = sync;
    $("#ip-imp").onchange = () => {
      const v = $("#ip-imp").value;
      $("#ip-imp-url").style.display = v === "link" ? "" : "none";
      $("#ip-imp-file").style.display = v === "file" ? "" : "none";
    };
    bindMemberHint($("#ip-member"), $("#ip-member-who"));
    $("#ip-add").onclick = async () => {
      const name = $("#ip-name").value.trim();
      const kind = $("#ip-kind").value;
      const access = $("#ip-access").value;
      const body = { name, kind, type: access, owner_id: null, m3u_url: "", xstream_server: "", xstream_user: "", xstream_password: "", duration: $("#ip-dur").value.trim() || "unlimited", created_by: state.staff?.username || "" };
      if (!name) return toast(t("panel.iptv.needName"));
      if (kind === "m3u") {
        body.m3u_url = $("#ip-url").value.trim();
        if (!/^https?:\/\//i.test(body.m3u_url)) return toast(t("panel.iptv.needM3u"));
      } else {
        body.xstream_server = $("#ip-server").value.trim();
        body.xstream_user = $("#ip-user").value.trim();
        body.xstream_password = $("#ip-pass").value.trim();
        if (!/^https?:\/\//i.test(body.xstream_server) || !body.xstream_user || !body.xstream_password) return toast(t("panel.iptv.needXtream"));
      }
      body.epg_url = $("#ip-epg").value.trim();
      if (body.epg_url && !/^https?:\/\/\S+$/i.test(body.epg_url)) return toast(t("panel.iptv.needEpg"));
      const add = $("#ip-add");
      add.disabled = true;
      try {
        let owner = null;
        if (access === "premium") {
          const typed = $("#ip-member").value.trim();
          if (!typed) return toast(t("panel.iptv.needMember"));
          owner = await resolveMember(typed);
          if (!owner) return toast(t("panel.iptv.noMember", { q: typed }));
          Object.assign(body, { owner_id: owner.member_id }, assignment(body.duration));
        }
        const ins = await writeTolerant("/rest/v1/iptv", "POST", body, OPTIONAL_COLS.iptv);
        if (!ins.ok) return toast(t("panel.actFail"));
        const saved = (Array.isArray(ins.data) ? ins.data[0] : ins.data) || null;
        const notified = owner ? await notifyIptvOwner(owner, body) : false;
        toast(owner ? t(notified ? "panel.iptv.addedFor" : "panel.iptv.addedNoNote", { who: memberLabel(owner) }) : t("panel.iptv.added"));
        const mode = $("#ip-imp").value;
        if (mode !== "none") {
          let source = null;
          if (mode === "file") source = { file: $("#ip-imp-file").files?.[0] };
          else source = { url: $("#ip-imp-url").value.trim() || (kind === "m3u" ? body.m3u_url : "") };
          if (source.file || source.url) await importChannels(name, source, true, saved);
          else toast(t("panel.iptv.impFail"));
        }
        viewIptv(main);
      } finally {
        add.disabled = false;
      }
    };
    main.onclick = async (e) => {
      const f = e.target.closest("[data-ipf]");
      const asg = e.target.closest("[data-asg]");
      const del = e.target.closest("[data-del]");
      if (f) { state.iptvFilter = f.dataset.ipf; viewIptv(main); return; }
      const epgBtn = e.target.closest("[data-epg]");
      if (epgBtn) {
        const row = rows.find((x) => String(x.id) === epgBtn.dataset.epg);
        if (row) editEpg(main, row);
        return;
      }
      const imp = e.target.closest("[data-imp]");
      if (imp) {
        const row = rows.find((x) => String(x.id) === imp.dataset.imp);
        if (!row) return;
        const ov = overlay(`
          <h2>${t("panel.iptv.importTitle")}</h2>
          <p class="muted">${escapeHtml(row.name)}</p>
          <div class="stack">
            <input id="im-url" dir="ltr" value="${escapeHtml(kindOf(row) === "m3u" ? row.m3u_url || "" : "")}" placeholder="${t("panel.iptv.impUrlPh")}" />
            <input id="im-file" type="file" accept=".m3u,.m3u8,.txt,audio/x-mpegurl,application/vnd.apple.mpegurl" />
            <label class="lang-chip"><input type="checkbox" id="im-rep" checked /> ${t("panel.iptv.replace")}</label>
            <div class="toolbar">
              <button class="btn btn-sm btn-primary" id="im-go" type="button">${t("panel.iptv.importBtn")}</button>
              <button class="btn btn-sm btn-ghost" data-close type="button">${t("common.close")}</button>
            </div>
          </div>`);
        ov.querySelector("#im-go").onclick = async () => {
          const file = ov.querySelector("#im-file").files?.[0];
          const url = ov.querySelector("#im-url").value.trim();
          if (!file && !url) return toast(t("panel.iptv.impFail"));
          const go = ov.querySelector("#im-go");
          go.disabled = true;
          const hadEpg = Boolean(String(row.epg_url || "").trim());
          const n = await importChannels(row.name, file ? { file } : { url }, ov.querySelector("#im-rep").checked, row);
          go.disabled = false;
          if (n) {
            ov.remove();
            if (!hadEpg && row.epg_url) viewIptv(main); // the playlist named its guide: show it on the card
          }
        };
        return;
      }
      if (asg) {
        const row = rows.find((x) => String(x.id) === asg.dataset.asg);
        const typed = String(main.querySelector(`[data-asg-in="${asg.dataset.asg}"]`)?.value || "").trim();
        if (!row) return;
        if (!typed) return toast(t("panel.iptv.needMember"));
        asg.disabled = true;
        try {
          const m = await resolveMember(typed);
          if (!m) return toast(t("panel.iptv.noMember", { q: typed }));
          // giving it to its owner again starts a new period: a renewal
          const renewed = CA.iptvOwnedBy(row, m);
          const r = await writeTolerant(`/rest/v1/iptv?id=eq.${encodeURIComponent(row.id)}`, "PATCH", { owner_id: m.member_id, ...assignment(row.duration) }, OPTIONAL_COLS.iptv);
          if (!r.ok) return toast(t("panel.actFail"));
          const notified = await notifyIptvOwner(m, row, renewed);
          const key = renewed ? (notified ? "panel.iptv.renewedFor" : "panel.iptv.renewedNoNote") : notified ? "panel.iptv.assignedFor" : "panel.iptv.assignedNoNote";
          toast(t(key, { who: memberLabel(m) }));
          viewIptv(main);
        } finally {
          asg.disabled = false;
        }
        return;
      }
      if (del) {
        await supabaseRequest(`/rest/v1/iptv?id=eq.${del.dataset.del}`, { method: "DELETE" });
        toast(t("panel.iptv.deleted"));
        viewIptv(main);
      }
    };
  }

  async function viewStaff(main) {
    if (state.staff.role !== "super") return;
    await loadStaffRows();
    const others = state.staffRows.filter((s) => s.role !== "super");
    await primeAvatars(others.map((s) => s.member_id), others.map((s) => s.username));
    main.innerHTML = `
      <p class="eyebrow">${t("panel.nav.staff")}</p>
      <h1>${t("panel.staffTitle")}</h1>
      <p class="muted">${t("panel.staffLead")}</p>
      <div class="stack">
        <input id="st-id" placeholder="${t("panel.memberIdPh")}" />
        <select id="st-role">
          <option value="admin">${t("panel.role.admin")}</option>
          <option value="moderator">${t("panel.role.moderator")}</option>
        </select>
        <input id="st-pass" type="password" placeholder="${t("panel.staffPass")}" />
        <p class="muted">${t("panel.sectionsHint")}</p>
        <div class="chip-row" id="st-secs">
          ${ALL_SECTIONS.filter((s) => s !== "staff").map((s) => `<label class="lang-chip"><input type="checkbox" name="st-s" value="${s}" checked /> ${t("panel.nav." + s)}</label>`).join("")}
        </div>
        <button class="btn btn-lg btn-primary" id="st-add" type="button">${t("panel.addStaff")}</button>
      </div>
      <h2 style="margin:22px 0 10px">${t("panel.staffList")}</h2>
      ${others.map((s) => `
        <div class="mini-card" style="margin-bottom:10px">
          <div class="staff-line">
            ${medalTag(s.role, s.member_id, s.username)}
            <h3>${escapeHtml(s.username || s.member_id)} · ${roleLabel(s.role)}</h3>
          </div>
          <p class="muted">${escapeHtml(s.member_id)} · ${escapeHtml(s.sections || "")}</p>
          <div class="chip-row" data-edit-sec="${s.id}">
            ${ALL_SECTIONS.filter((x) => x !== "staff").map((x) => `<label class="lang-chip"><input type="checkbox" data-sid="${s.id}" value="${x}" ${String(s.sections || "").split(",").includes(x) ? "checked" : ""} /> ${t("panel.nav." + x)}</label>`).join("")}
          </div>
          <div class="acc-actions" style="margin-top:8px">
            <button class="btn btn-sm btn-primary" data-save-sec="${s.id}" type="button">${t("common.save")}</button>
            <button class="btn btn-sm btn-danger" data-del-st="${s.id}" type="button">${t("common.remove")}</button>
          </div>
        </div>`).join("") || `<p class="empty">${t("panel.noStaff")}</p>`}`;
    $("#st-add").onclick = async () => {
      const memberId = $("#st-id").value.trim();
      const role = $("#st-role").value;
      const pass = $("#st-pass").value;
      if (!memberId || pass.length < 8) return toast(t("panel.needStaff"));
      const mem = await supabaseRequest(`/rest/v1/members?member_id=eq.${restValue(memberId)}&select=member_id,username`);
      const row = mem.data?.[0];
      if (!row) return toast(t("panel.memberMissing"));
      if (staffRoleOf(memberId) === "super") return toast(t("panel.noAct"));
      const sections = $$('input[name="st-s"]:checked').map((el) => el.value).join(",");
      const ins = await window.CineAura.rpc("staff_add", {
        p_token: state.staff.token, p_member: row.member_id, p_role: role, p_hash: await sha256(pass), p_sections: sections,
      });
      if (!ins.ok || !ins.data?.ok) return toast(t("panel.actFail"));
      toast(t("panel.staffAdded"));
      viewStaff(main);
    };
    main.onclick = async (e) => {
      const save = e.target.closest("[data-save-sec]");
      const del = e.target.closest("[data-del-st]");
      if (save) {
        const sections = $$(`input[data-sid="${save.dataset.saveSec}"]:checked`).map((el) => el.value).join(",");
        await window.CineAura.rpc("staff_set_sections", { p_token: state.staff.token, p_id: Number(save.dataset.saveSec), p_sections: sections });
        toast(t("panel.saved"));
        viewStaff(main);
      }
      if (del) {
        await window.CineAura.rpc("staff_remove", { p_token: state.staff.token, p_id: Number(del.dataset.delSt) });
        toast(t("panel.staffRemoved"));
        viewStaff(main);
      }
    };
  }

  // ---------- Apps: the download cards of the home page ("Get the app") ----------
  // One row per platform in app_downloads (sql/apps.sql). Saving goes through the
  // staff RPC staff_app_save, which checks the panel session and the Apps section:
  // the table cannot be written with the public key.
  const APP_GROUPS = ["CineAura PC", "CineAura Mobile", "CineAura TV"];
  const APP_PLACEHOLDER = {
    windows: "https://…/CineAura-PC-1.0.exe",
    linux: "https://…/CineAura-PC-1.0.AppImage",
    macos: "https://…/CineAura-PC-1.0.dmg",
    android: "https://…/CineAura-Mobile-1.0.apk",
    ios: "https://apps.apple.com/…",
    androidtv: "https://…/CineAura-TV-1.0.apk",
  };

  function appRowHtml(p, row, locked) {
    const C = window.CineAura;
    const url = String(row?.url || "");
    const live = C.appDownloadUrl(url);
    const version = row ? String(row.version ?? "") : "1.0";
    const changed = row?.updated_by && row?.updated_at ? t("panel.apps.changed", { who: row.updated_by, date: formatDate(row.updated_at) }) : "";
    const off = locked ? " disabled" : "";
    return `
      <form class="mini-card apx-row" data-app="${p.key}" novalidate>
        <div class="apx-head">
          <span class="app-os-logo apx-logo" aria-hidden="true">${p.logo}</span>
          <div class="apx-name"><strong dir="ltr">${escapeHtml(p.os)}</strong><small dir="ltr">${escapeHtml(p.app)}</small></div>
          <span class="apx-state${live ? " on" : ""}">${escapeHtml(live ? t("home.apps.available") : t("home.app.soon"))}</span>
        </div>
        <div class="apx-fields">
          <label class="apx-field">
            <span>${t("panel.apps.link")}</span>
            <input name="url" type="url" dir="ltr" inputmode="url" autocomplete="off" spellcheck="false" maxlength="1000" value="${escapeHtml(url)}" placeholder="${escapeHtml(APP_PLACEHOLDER[p.key] || "https://…")}"${off} />
          </label>
          <label class="apx-field apx-ver">
            <span>${t("panel.apps.version")}</span>
            <input name="version" dir="ltr" autocomplete="off" spellcheck="false" maxlength="20" value="${escapeHtml(version)}" placeholder="1.0"${off} />
          </label>
        </div>
        <div class="apx-actions">
          <button class="btn btn-sm btn-primary" type="submit"${off}>${t("common.save")}</button>
          ${live ? `<a class="btn btn-sm btn-ghost" href="${escapeHtml(live)}" target="_blank" rel="noopener noreferrer">${t("common.open")}</a>` : ""}
          ${url && !locked ? `<button class="btn btn-sm btn-ghost" type="button" data-app-clear>${t("panel.apps.remove")}</button>` : ""}
          ${changed ? `<small class="muted apx-changed">${escapeHtml(changed)}</small>` : ""}
        </div>
      </form>`;
  }

  function bindAppRow(form) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      saveApp(form, false);
    });
    form.querySelector("[data-app-clear]")?.addEventListener("click", () => saveApp(form, true));
  }

  async function saveApp(form, clear) {
    const C = window.CineAura;
    const p = C.APP_PLATFORMS.find((x) => x.key === form.dataset.app);
    if (!p) return;
    const url = clear ? "" : form.elements.url.value.trim();
    const version = form.elements.version.value.trim();
    if (url && !C.appDownloadUrl(url)) {
      toast(t("panel.apps.badUrl"));
      form.elements.url.focus();
      return;
    }
    const buttons = [...form.querySelectorAll("button")];
    buttons.forEach((b) => {
      b.disabled = true;
    });
    let error = "";
    let row = null;
    try {
      const res = await C.rpc("staff_app_save", { p_token: state.staff?.token || "", p_platform: p.key, p_url: url, p_version: version });
      const msg = String(res.data?.message || "");
      if (res.ok && res.data?.ok) row = res.data.row;
      else if (res.ok) error = res.data?.error || "fail";
      else if (msg.includes("staff_auth")) error = "auth";
      else if (msg.includes("staff_forbidden")) error = "forbidden";
      else if (res.status === 404) error = "sql"; // sql/apps.sql not run yet
      else error = "fail";
    } catch {
      error = "fail";
    }
    if (!row) {
      buttons.forEach((b) => {
        b.disabled = false;
      });
      const key = {
        bad_url: "panel.apps.badUrl",
        bad_version: "panel.apps.badVersion",
        auth: "pza.errAuth",
        forbidden: "panel.apps.forbidden",
        sql: "panel.apps.noTable",
      }[error];
      toast(t(key || "panel.actFail"));
      return;
    }
    toast(t(row.url ? "panel.apps.saved" : "panel.apps.cleared", { os: p.os }));
    const fresh = document.createElement("div");
    fresh.innerHTML = appRowHtml(p, row, false);
    const next = fresh.firstElementChild;
    form.replaceWith(next);
    bindAppRow(next);
    next.querySelector('button[type="submit"]')?.focus({ preventScroll: true });
  }

  async function viewApps(main) {
    const C = window.CineAura;
    const res = await supabaseRequest("/rest/v1/app_downloads?select=*");
    const missing = !res.ok || !Array.isArray(res.data); // sql/apps.sql not run yet
    const rows = new Map((missing ? [] : res.data).map((r) => [r.platform, r]));
    main.innerHTML = `
      <p class="eyebrow">${t("panel.nav.apps")}</p>
      <h1>${t("panel.apps.title")}</h1>
      <p class="muted">${t("panel.apps.lead")}</p>
      ${missing ? `<div class="form-alert show warn apx-alert">${t("panel.apps.noTable")}</div>` : ""}
      <div class="apx-groups">
        ${APP_GROUPS.map(
          (app) => `
          <section class="apx-group">
            <h2 dir="ltr">${escapeHtml(app)}</h2>
            ${C.APP_PLATFORMS.filter((p) => p.app === app)
              .map((p) => appRowHtml(p, rows.get(p.key), missing))
              .join("")}
          </section>`
        ).join("")}
      </div>`;
    main.querySelectorAll("form.apx-row").forEach(bindAppRow);
  }

  async function viewSettings(main) {
    await loadSettings();
    const s = state.settings;
    main.innerHTML = `
      <p class="eyebrow">${t("panel.nav.settings")}</p>
      <h1>${t("panel.settingsTitle")}</h1>
      <div class="stack">
        <p class="muted">${t("panel.changePass")}</p>
        <input id="np1" type="password" placeholder="${t("common.newPassword")}" />
        <input id="np2" type="password" placeholder="${t("rest.confirm")}" />
        <button class="btn btn-sm btn-primary" id="np-save" type="button">${t("panel.savePass")}</button>
        <hr />
        <p class="muted">${t("panel.showHint")}</p>
        <label class="lang-chip"><input type="checkbox" id="sh-admin" ${s.show_admin ? "checked" : ""} /> ${t("panel.showAdmin")}</label>
        <label class="lang-chip"><input type="checkbox" id="sh-mod" ${s.show_moderator ? "checked" : ""} /> ${t("panel.showMod")}</label>
        <label class="lang-chip"><input type="checkbox" id="sh-mem" ${s.show_member ? "checked" : ""} /> ${t("panel.showMember")}</label>
        <p class="muted">${t("panel.superAlways")}</p>
        ${state.staff.role === "super" ? `<button class="btn btn-sm btn-primary" id="sh-save" type="button">${t("common.save")}</button>` : ""}
      </div>`;
    $("#np-save").onclick = async () => {
      const a = $("#np1").value;
      const b = $("#np2").value;
      if (a.length < 8) return toast(t("panel.pass8"));
      if (a !== b) return toast(t("panel.mismatch"));
      const res = await window.CineAura.rpc("staff_set_password", { p_token: state.staff.token, p_hash: await sha256(a) });
      if (!res.ok || !res.data?.ok) return toast(t("panel.actFail"));
      toast(t("panel.passChanged"));
      $("#np1").value = "";
      $("#np2").value = "";
    };
    $("#sh-save")?.addEventListener("click", async () => {
      const body = {
        show_admin: $("#sh-admin").checked,
        show_moderator: $("#sh-mod").checked,
        show_member: $("#sh-mem").checked,
      };
      let res = await supabaseRequest("/rest/v1/panel_settings?id=eq.1", { method: "PATCH", body: JSON.stringify(body) });
      if (!res.ok || (Array.isArray(res.data) && !res.data.length)) {
        res = await supabaseRequest("/rest/v1/panel_settings", {
          method: "POST",
          body: JSON.stringify({ id: 1, ...body }),
        });
      }
      if (!res.ok) return toast(t("panel.actFail"));
      state.settings = { id: 1, ...body };
      toast(t("panel.saved"));
    });
  }

  async function enterPanel() {
    await loadStaffRows();
    await loadSettings();
    const live = state.staffRows.find((s) => s.id === state.staff.id) || state.staff;
    state.staff = { ...state.staff, ...live };
    await primeAvatars(
      state.staffRows.map((s) => s.member_id),
      state.staffRows.map((s) => s.username)
    );
    renderShell();
  }

  async function boot() {
    setupChrome();
    const existing = getPanel();
    const superRes = await supabaseRequest("/rest/v1/staff?role=eq.super&select=id,role,member_id,username,sections");
    const hasSuper = superRes.ok && Array.isArray(superRes.data) && superRes.data.length;
    if (!hasSuper) {
      renderLogin("setup");
      return;
    }
    if (existing?.id && existing?.role) {
      const check = existing.token ? await window.CineAura.rpc("staff_session", { p_token: existing.token }) : null;
      const row = check?.ok ? check.data : null;
      if (row) {
        state.staff = {
          token: existing.token,
          id: row.id,
          role: row.role,
          member_id: row.member_id || "",
          username: row.username || "",
          sections: row.sections || "",
        };
        await enterPanel();
        return;
      }
      clearPanel();
    }
    renderLogin("login");
  }

  document.addEventListener("cineaura:prefs", () => {
    if (state.staff && document.querySelector("#panel-root .dash-layout")) renderShell();
  });

  document.addEventListener("DOMContentLoaded", boot);
})();
