(() => {
  const {
    $,
    $$,
    setupChrome,
    getSession,
    toast,
    supabaseRequest,
    restValue,
    escapeHtml,
    normalizeAccountStatus,
    t,
  } = window.CineAura;

  const LOCKER_ID = "13897974-6da6-11f1-a2d7-8a5fb7be40ea";
  const PATREON_URL = "https://www.patreon.com/";
  const PLANS = {
    Free: { months: 1, duration: "1 month", price: "$0" },
    Silver: { months: 3, duration: "3 months", price: "$5" },
    Gold: { months: 6, duration: "6 months", price: "$10" },
    Diamond: { months: 12, duration: "12 months", price: "$20" },
  };

  const state = {
    member: null,
    mode: null,
    plan: null,
    bio: "",
    avatar: "",
    ip: "",
  };

  const dots = (n, on) =>
    `<div class="step-dots">${Array.from({ length: n }, (_, i) => `<span class="${i < on ? "on" : ""}"></span>`).join("")}</div>`;

  function monthsFromDuration(text, fallbackPlan) {
    const raw = String(text || "").toLowerCase().trim();
    const num = parseInt(raw, 10);
    if (Number.isFinite(num) && num > 0) {
      if (raw.includes("year")) return num * 12;
      if (raw.includes("week")) return Math.max(1, Math.round((num * 7) / 30));
      if (raw.includes("day")) return Math.max(1, Math.ceil(num / 30));
      return num;
    }
    return PLANS[fallbackPlan]?.months || 1;
  }

  function durationLabel(months) {
    return months === 1 ? "1 month" : `${months} months`;
  }

  function expiresFrom(months) {
    const d = new Date();
    d.setMonth(d.getMonth() + months);
    return d;
  }

  function dateLabel(value) {
    if (!value) return "—";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
    return d.toISOString().slice(0, 10);
  }

  function tableMissing(res) {
    return res?.data?.code === "PGRST205" || /could not find the table/i.test(JSON.stringify(res?.data || {}));
  }

  async function loadMember(id) {
    const res = await supabaseRequest(`/rest/v1/members?member_id=eq.${restValue(id)}&select=*`);
    return res.ok && res.data?.[0] ? res.data[0] : null;
  }

  async function detectIp() {
    try {
      const r = await fetch("https://api.ipify.org?format=json");
      const j = await r.json();
      state.ip = j.ip || "";
    } catch {
      state.ip = "";
    }
  }

  async function alreadyActivated(type) {
    const res = await supabaseRequest(
      `/rest/v1/activation?member_id=eq.${restValue(state.member.member_id)}&membership_type=eq.${restValue(type)}&used=eq.true&select=id`
    );
    if (!res.ok || tableMissing(res)) return false;
    return Array.isArray(res.data) && res.data.length > 0;
  }

  async function saveProfile() {
    const patch = {
      bio: state.bio,
      avatar_url: state.avatar,
      membership_type: state.plan,
    };
    const existing = await supabaseRequest(
      `/rest/v1/profiles?member_id=eq.${restValue(state.member.member_id)}&select=member_id`
    );
    if (existing.data?.[0]) {
      await supabaseRequest(`/rest/v1/profiles?member_id=eq.${restValue(state.member.member_id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      return;
    }
    await supabaseRequest("/rest/v1/profiles", {
      method: "POST",
      body: JSON.stringify({
        member_id: state.member.member_id,
        username: state.member.username,
        country: state.member.country || "",
        ...patch,
      }),
    });
  }

  async function applyMembership({ months, duration }) {
    const start = new Date();
    const end = expiresFrom(months);
    const body = {
      status: "active",
      membership_type: state.plan,
      membership_duration: duration || durationLabel(months),
      membership_expires_at: end.toISOString(),
    };
    const mem = await supabaseRequest(
      `/rest/v1/members?member_id=eq.${restValue(state.member.member_id)}`,
      { method: "PATCH", body: JSON.stringify(body) }
    );
    if (!mem.ok) return { ok: false, message: t("act.memberFail") };
    Object.assign(state.member, body);
    return { ok: true, start, end };
  }

  async function consumeCode(code) {
    const clean = String(code || "").replace(/\s+/g, "").trim();
    if (!clean) return { ok: false, message: t("act.enter") };
    const res = await supabaseRequest(
      `/rest/v1/activation?activation_code=eq.${restValue(clean)}&select=*`
    );
    if (tableMissing(res)) {
      return { ok: false, message: t("act.missing") };
    }
    const row = res.ok && res.data?.[0];
    if (!row) return { ok: false, message: t("act.invalid") };
    if (row.used) return { ok: false, message: t("act.used") };
    if (row.member_id && row.member_id !== state.member.member_id) {
      return { ok: false, message: t("act.other") };
    }
    if (row.membership_type && row.membership_type !== state.plan) {
      return { ok: false, message: `This code is for ${row.membership_type}, not ${state.plan}.` };
    }
    const months = monthsFromDuration(row.duration, state.plan);
    const duration = row.duration || durationLabel(months);
    const start = new Date();
    const end = expiresFrom(months);
    const patch = await supabaseRequest(
      `/rest/v1/activation?activation_code=eq.${restValue(clean)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          member_id: state.member.member_id,
          membership_type: state.plan,
          duration,
          started_at: start.toISOString(),
          expires_at: end.toISOString(),
          ip: state.ip,
          country: state.member.country || "",
          used: true,
          used_at: start.toISOString(),
          kind: state.mode,
        }),
      }
    );
    if (!patch.ok) return { ok: false, message: t("act.consumeFail") };
    return applyMembership({ months, duration });
  }

  async function activateFreeFirst() {
    const plan = PLANS.Free;
    const start = new Date();
    const end = expiresFrom(plan.months);
    await supabaseRequest("/rest/v1/activation", {
      method: "POST",
      body: JSON.stringify({
        activation_code: `FREE${state.member.member_id.replace(/\D/g, "")}${Date.now()}`.slice(0, 24),
        member_id: state.member.member_id,
        membership_type: "Free",
        duration: plan.duration,
        started_at: start.toISOString(),
        expires_at: end.toISOString(),
        ip: state.ip,
        country: state.member.country || "",
        used: true,
        used_at: start.toISOString(),
        kind: "activate",
      }),
    });
    return applyMembership({ months: plan.months, duration: plan.duration });
  }

  function openGetCode() {
    if (state.plan !== "Free") {
      window.open(PATREON_URL, "_blank", "noopener");
      return;
    }
    if (typeof window.showLocker === "function") {
      window.showLocker(LOCKER_ID);
      return;
    }
    toast(t("act.locker"));
  }

  function render(html) {
    $("#activate-root").innerHTML = html;
  }

  function stepChoice() {
    const current = state.member.membership_type || "Free";
    const status = normalizeAccountStatus(state.member.status);
    render(`
      <section class="glass wizard">
        ${dots(4, 1)}
        <span class="eyebrow">${t("act.eyebrow")}</span>
        <h1>${t("act.how")}</h1>
        <p class="muted">${t("act.howLead")}</p>
        <div class="success-meta">
          <div>${t("reg.username")} <strong>@${escapeHtml(state.member.username)}</strong></div>
          <div>${t("act.currentPlan")} <strong>${escapeHtml(current)}</strong></div>
          <div>${t("act.status")} <strong>${escapeHtml(status || t("dash.disabledTitle"))}</strong></div>
        </div>
        <div class="choice-grid">
          <button class="choice" id="pick-activate" type="button">
            <strong>${t("act.activate")}</strong>
            <p class="muted">${t("act.activateLead")}</p>
          </button>
          <button class="choice" id="pick-reactivate" type="button">
            <strong>${t("act.reactivate")}</strong>
            <p class="muted">${t("act.reactivateLead")}</p>
          </button>
        </div>
      </section>`);
    $("#pick-activate").onclick = () => {
      state.mode = "activate";
      stepPlan();
    };
    $("#pick-reactivate").onclick = () => {
      state.mode = "reactivate";
      stepReactivateSummary();
    };
  }

  function stepPlan() {
    render(`
      <section class="glass wizard">
        ${dots(4, 2)}
        <span class="eyebrow">${t("common.membership")}</span>
        <h1>${t("act.choosePlan")}</h1>
        <p class="muted">${t("act.chooseLead")}</p>
        <div class="plan-pick">
          ${Object.entries(PLANS).map(([name, p]) => `
            <button class="plan-card" data-plan="${name}" type="button">
              <strong>${name}</strong>
              <p class="muted">${p.price} · ${p.duration}</p>
              <small>${name === "Free" ? t("act.noCodeFirst") : t("act.patreonCode")}</small>
            </button>`).join("")}
        </div>
        <button class="btn btn-sm btn-ghost" id="back" type="button">${t("act.back")}</button>
      </section>`);
    $("#back").onclick = stepChoice;
    $$(".plan-card").forEach((btn) => {
      btn.onclick = async () => {
        const plan = btn.dataset.plan;
        btn.disabled = true;
        if (await alreadyActivated(plan)) {
          btn.disabled = false;
          toast(t("act.already"));
          return;
        }
        state.plan = plan;
        stepProfile();
      };
    });
  }

  function stepProfile() {
    render(`
      <section class="glass wizard">
        ${dots(4, 3)}
        <span class="eyebrow">${t("act.profile")}</span>
        <h1>${t("act.createProf")}</h1>
        <p class="muted">${t("act.profLead")}</p>
        <div class="stack">
          <label class="muted">${t("reg.username")}<input value="${escapeHtml(state.member.username)}" disabled /></label>
          <label class="muted">${t("act.bio")}<textarea id="bio" placeholder="${t("act.bioPh")}">${escapeHtml(state.bio)}</textarea></label>
          <label class="muted">${t("act.avatarUrl")}<input id="avatar" value="${escapeHtml(state.avatar)}" placeholder="https://..." /></label>
          <button class="btn btn-lg btn-primary" id="next" type="button">${t("rest.continue")}</button>
          <button class="btn btn-sm btn-ghost" id="back" type="button">${t("act.back")}</button>
        </div>
      </section>`);
    $("#back").onclick = stepPlan;
    $("#next").onclick = async () => {
      state.bio = $("#bio").value.trim();
      state.avatar = $("#avatar").value.trim();
      const btn = $("#next");
      btn.disabled = true;
      btn.textContent = t("act.saving");
      try {
        await saveProfile();
      } catch {
        /* profile table is optional until dashboard SQL is run */
      }
      stepActivate();
    };
  }

  function stepReactivateSummary() {
    const m = state.member;
    const current = m.membership_type && PLANS[m.membership_type] ? m.membership_type : "Free";
    state.plan = current;
    render(`
      <section class="glass wizard">
        ${dots(3, 1)}
        <span class="eyebrow">${t("act.reactivate")}</span>
        <h1>${t("act.renew")}</h1>
        <p class="muted">${t("act.renewLead")}</p>
        <div class="success-meta">
          <div>${t("reg.username")} <strong>@${escapeHtml(m.username)}</strong></div>
          <div>${t("common.membership")} <strong>${escapeHtml(m.membership_type || "Free")}</strong></div>
          <div>${t("act.prevDur")} <strong>${escapeHtml(m.membership_duration || "1 month")}</strong></div>
          <div>${t("act.expired")} <strong>${escapeHtml(dateLabel(m.membership_expires_at))}</strong></div>
        </div>
        <div class="plan-pick">
          ${Object.entries(PLANS).map(([name, p]) => `
            <button class="plan-card ${name === current ? "on" : ""}" data-plan="${name}" type="button">
              <strong>${name}</strong>
              <p class="muted">${p.price} · ${p.duration}</p>
            </button>`).join("")}
        </div>
        <div class="stack">
          <button class="btn btn-lg btn-primary" id="go" type="button">${t("act.reactivate")}</button>
          <button class="btn btn-sm btn-ghost" id="back" type="button">${t("act.back")}</button>
        </div>
      </section>`);
    $$(".plan-card").forEach((btn) => {
      btn.onclick = () => {
        $$(".plan-card").forEach((b) => b.classList.remove("on"));
        btn.classList.add("on");
        state.plan = btn.dataset.plan;
      };
    });
    $("#back").onclick = stepChoice;
    $("#go").onclick = () => stepCode(true);
  }

  function stepActivate() {
    if (state.plan === "Free") return stepFreeProgress();
    stepCode(false);
  }

  function stepFreeProgress() {
    render(`
      <section class="glass wizard">
        ${dots(4, 4)}
        <span class="eyebrow">Free</span>
        <h1>${t("act.activating")}</h1>
        <p class="muted" id="prog-msg">${t("act.waitFree")}</p>
        <div class="progress-track"><div class="progress-fill" id="bar"></div></div>
      </section>`);
    let w = 0;
    const bar = $("#bar");
    const timer = setInterval(async () => {
      w += 4;
      bar.style.width = `${Math.min(w, 100)}%`;
      if (w < 100) return;
      clearInterval(timer);
      const result = await activateFreeFirst();
      if (!result.ok) {
        $("#prog-msg").textContent = result.message || t("act.fail");
        return;
      }
      stepSuccess(result);
    }, 80);
  }

  function stepCode(isReactivate) {
    const premium = state.plan !== "Free";
    render(`
      <section class="glass wizard">
        ${dots(isReactivate ? 3 : 4, isReactivate ? 3 : 4)}
        <span class="eyebrow">${escapeHtml(state.plan)}</span>
        <h1>${t("act.enter")}</h1>
        <p class="muted">${t("act.codesOnce")}</p>
        <div class="form-alert" id="code-alert"></div>
        <div class="stack">
          <label class="muted">${t("act.actCode")}<input id="act-code" placeholder="${t("act.paste")}" autocomplete="off" /></label>
          <button class="btn btn-lg btn-primary" id="use-code" type="button">${t("act.activateAcc")}</button>
          <button class="btn btn-lg btn-ghost" id="get-code" type="button">${premium ? t("act.patreon") : t("act.get")}</button>
          <button class="btn btn-sm btn-ghost" id="back" type="button">${t("act.back")}</button>
        </div>
      </section>`);
    $("#back").onclick = isReactivate ? stepReactivateSummary : stepProfile;
    $("#get-code").onclick = openGetCode;
    $("#use-code").onclick = async () => {
      const btn = $("#use-code");
      btn.disabled = true;
      const result = await consumeCode($("#act-code").value);
      const alert = $("#code-alert");
      if (!result.ok) {
        btn.disabled = false;
        alert.className = "form-alert show error";
        alert.textContent = result.message;
        return;
      }
      stepSuccess(result);
    };
  }

  function stepSuccess(result) {
    const end = result.end ? result.end.toISOString().slice(0, 10) : "";
    render(`
      <section class="glass wizard">
        <div class="check-mark" aria-hidden="true">✓</div>
        <span class="eyebrow">${t("act.done")}</span>
        <h1>${t("act.okTitle")}</h1>
        <p class="muted">${t("act.okLead", { plan: escapeHtml(state.plan), end: escapeHtml(end) })}</p>
        <div class="success-meta">
          <div>${t("act.plan")} <strong>${escapeHtml(state.plan)}</strong></div>
          <div>${t("common.duration")} <strong>${escapeHtml(state.member.membership_duration || PLANS[state.plan].duration)}</strong></div>
          <div>${t("act.until")} <strong>${escapeHtml(end)}</strong></div>
        </div>
        <div class="success-actions">
          <a class="btn btn-lg btn-primary" href="./dashboard.html">${t("auth.goDash")}</a>
        </div>
      </section>`);
    toast(t("act.ok"));
  }

  async function boot() {
    setupChrome();
    const session = getSession();
    if (!session?.member_id) {
      render(`<section class="glass wizard"><span class="eyebrow">${t("act.eyebrow")}</span><h1>${t("act.signFirst")}</h1><p class="muted">${t("act.needAcc")}</p><div class="success-actions"><a class="btn btn-lg btn-primary" href="./login.html">${t("nav.signin")}</a></div></section>`);
      return;
    }
    state.member = await loadMember(session.member_id);
    if (!state.member) {
      render(`<section class="glass wizard"><span class="eyebrow">${t("act.eyebrow")}</span><h1>${t("act.notFound")}</h1><div class="success-actions"><a class="btn btn-lg btn-primary" href="./login.html">${t("nav.signin")}</a></div></section>`);
      return;
    }
    if (normalizeAccountStatus(state.member.status) === "banned") {
      render(`<section class="glass wizard"><span class="eyebrow">${t("act.eyebrow")}</span><h1>${t("act.banned")}</h1><p class="muted">${t("act.noAct")}</p></section>`);
      return;
    }
    const prof = await supabaseRequest(`/rest/v1/profiles?member_id=eq.${restValue(state.member.member_id)}&select=bio,avatar_url`);
    if (prof.data?.[0]) {
      state.bio = prof.data[0].bio || "";
      state.avatar = prof.data[0].avatar_url || "";
    }
    await detectIp();
    stepChoice();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
