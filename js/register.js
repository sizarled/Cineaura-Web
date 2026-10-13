(() => {
  const {
    $,
    setupChrome,
    isLoggedIn,
    toast,
    sha256,
    supabaseRequest,
    normalizeAccountStatus,
    tmdb,
    imgUrl,
    escapeHtml,
    restValue,
    getReferralAttribution,
    clearReferralAttribution,
    t,
  } = window.CineAura;

  const TABLES = ["members", "Members"];
  const USERNAME_RE = /^[A-Za-z0-9._]{3,24}$/;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const COUNTRIES = [
    "Morocco", "Algeria", "Tunisia", "Egypt", "Saudi Arabia", "United Arab Emirates",
    "Qatar", "Kuwait", "Bahrain", "Oman", "Jordan", "Lebanon", "Palestine", "Iraq",
    "France", "Spain", "Portugal", "Italy", "Germany", "United Kingdom", "Belgium",
    "Netherlands", "Switzerland", "Sweden", "Norway", "Denmark", "Turkey",
    "United States", "Canada", "Mexico", "Brazil", "Argentina", "Chile",
    "India", "Pakistan", "Indonesia", "Malaysia", "Singapore", "Japan", "South Korea",
    "China", "Australia", "New Zealand", "South Africa", "Nigeria", "Kenya",
    "Senegal", "Ivory Coast", "Ghana", "Other",
  ];

  const MESSAGES = {
    banned: () => t("reg.bannedMsg"),
    disabled: () => `${t("reg.disabledMsg")} <a href="./dashboard.html">${t("nav.dashboard")}</a>.`,
    exists: () => `${t("reg.existsMsg")} <a href="./login.html">${t("nav.signin")}</a> · <a href="./Rest.html">${t("auth.recovery")}</a>.`,
    created: (id) => t("reg.welcome", { id: `<strong>${id}</strong>` }),
    setup: () => t("reg.setupMsg"),
    invalid_username: () => t("reg.badUser"),
    invalid_email: () => t("reg.badEmail"),
    invalid_password: () => t("reg.badPass"),
    invalid_age: () => t("reg.badAge"),
    error: () => t("reg.error"),
  };

  function showAlert(type, html) {
    const el = $("#form-alert");
    el.className = `form-alert show ${type}`;
    el.innerHTML = html;
  }

  function ageYears(iso) {
    const birth = new Date(iso);
    const now = new Date();
    let age = now.getFullYear() - birth.getFullYear();
    const m = now.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age -= 1;
    return age;
  }

  function generateMemberId() {
    const n = String(Math.floor(100000000 + Math.random() * 900000000));
    return `ID${n}`;
  }

  function generateRecoveryCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => chars[b % chars.length]).join("");
  }

  function formatRecovery(code) {
    const raw = String(code || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 16);
    return raw.replace(/(.{4})/g, "$1-").replace(/-$/, "");
  }

  function downloadAccountTxt(info) {
    const created = new Date().toISOString().slice(0, 10);
    const body = [
      "CineAura account details",
      "========================",
      `Member ID: ${info.member_id}`,
      `Full name: ${info.full_name}`,
      `Username: ${info.username}`,
      `Email: ${info.email}`,
      `Country: ${info.country}`,
      `Date of birth: ${info.birth_date}`,
      `Account created: ${created}`,
      `Recovery code: ${info.recovery_code}`,
      "",
      "Keep this recovery code private.",
      "Enter it on the Rest page to request a new password.",
    ].join("\r\n");
    const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `CineAura-${info.member_id}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function showSuccess(info) {
    const form = $("#register-form");
    const card = $("#success-card");
    form.hidden = true;
    card.hidden = false;
    $("#success-meta").innerHTML = `
      <div>Member ID <strong>${escapeHtml(info.member_id)}</strong></div>
      <div>Full name <strong>${escapeHtml(info.full_name)}</strong></div>
      <div>Username <strong>${escapeHtml(info.username)}</strong></div>
      <div>Email <strong>${escapeHtml(info.email)}</strong></div>
      <div>Country <strong>${escapeHtml(info.country)}</strong></div>
      <div>Gender <strong>${escapeHtml(info.gender === "female" ? "Female" : info.gender === "male" ? "Male" : info.gender || "")}</strong></div>
      <div>Membership <strong>${escapeHtml(info.membership_type || "Free")}</strong></div>
      <div>Duration <strong>${escapeHtml(info.membership_duration || "1 month")}</strong></div>
      <div>Watch time <strong>${Number(info.watch_minutes || 0)} min</strong></div>
    `;
    const compact = String(info.recovery_code || "").replace(/[\s\-]/g, "");
    $("#recovery-display").textContent = compact;
    card.dataset.recovery = compact;
    info.recovery_code = compact;
    window.__cineauraAccount = info;
    card.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function reasonFromRows(rows) {
    const statuses = (rows || []).map((row) => normalizeAccountStatus(row.status));
    if (statuses.includes("banned")) return "banned";
    if (statuses.includes("disabled")) return "disabled";
    if (rows?.length) return "exists";
    return null;
  }

  async function findMatches(username, email) {
    let tableMissing = false;
    for (const table of TABLES) {
      const path = `/rest/v1/${table}?or=(username.ilike.${restValue(username)},email.eq.${restValue(email)})&select=member_id,username,email,status`;
      const res = await supabaseRequest(path);
      if (res.status === 404 && res.data?.code === "PGRST205") {
        tableMissing = true;
        continue;
      }
      if (res.ok && Array.isArray(res.data)) {
        return { rows: res.data, table, tableMissing: false };
      }
    }
    return { rows: [], table: "members", tableMissing };
  }

  async function registerViaRpc(payload) {
    const args = {
      p_full_name: payload.full_name,
      p_username: payload.username,
      p_email: payload.email,
      p_password: payload.password,
      p_country: payload.country,
      p_birth_date: payload.birth_date,
      p_recovery_code: payload.recovery_code,
      p_gender: payload.gender,
    };
    if (payload.referred_by_member_id && payload.referred_post_id) {
      args.p_referred_by_member_id = payload.referred_by_member_id;
      args.p_referred_post_id = payload.referred_post_id;
    }
    const res = await supabaseRequest("/rest/v1/rpc/register_member", {
      method: "POST",
      body: JSON.stringify(args),
    });
    if (res.ok && res.data && typeof res.data === "object") return res.data;
    if (res.status === 404) return null;
    if (res.data?.code === "PGRST202" || res.data?.code === "PGRST205") return null;
    return { ok: false, reason: "error", detail: res.data };
  }

  async function registerViaRest(payload) {
    const found = await findMatches(payload.username, payload.email);
    if (found.tableMissing && !found.rows.length) {
      return { ok: false, reason: "setup" };
    }
    const blocked = reasonFromRows(found.rows);
    if (blocked) return { ok: false, reason: blocked };

    const referralColumns = payload.referred_by_member_id && payload.referred_post_id
      ? { referred_by_member_id: payload.referred_by_member_id, referred_post_id: payload.referred_post_id }
      : {};
    let memberId = generateMemberId();
    for (let i = 0; i < 6; i += 1) {
      const insert = await supabaseRequest(`/rest/v1/${found.table}`, {
        method: "POST",
        body: JSON.stringify({
          member_id: memberId,
          full_name: payload.full_name,
          username: payload.username,
          status: "disabled",
          email: payload.email,
          password: payload.password,
          country: payload.country,
          birth_date: payload.birth_date,
          recovery_code: payload.recovery_code,
          gender: payload.gender,
          membership_type: payload.membership_type || "Free",
          membership_duration: payload.membership_duration || "1 month",
          membership_expires_at: payload.membership_expires_at,
          watch_minutes: 0,
          ...referralColumns,
        }),
      });
      if (insert.ok) {
        const row = Array.isArray(insert.data) ? insert.data[0] : insert.data;
        return {
          ok: true,
          reason: "created",
          member_id: row?.member_id || memberId,
          recovery_code: row?.recovery_code || payload.recovery_code,
        };
      }
      if (insert.status === 409) {
        const again = await findMatches(payload.username, payload.email);
        const reason = reasonFromRows(again.rows) || "exists";
        if (reason !== "exists") return { ok: false, reason };
        memberId = generateMemberId();
        continue;
      }
      if (insert.data?.code === "PGRST205") return { ok: false, reason: "setup" };
      const msg = JSON.stringify(insert.data || {});
      if (
        /gender/i.test(msg) || /recovery_code/i.test(msg) || /membership/i.test(msg) ||
        /watch_minutes/i.test(msg) || /referred_by_member_id|referred_post_id/i.test(msg)
      ) {
        const canStoreReferral = !/referred_by_member_id|referred_post_id/i.test(msg);
        const retry = await supabaseRequest(`/rest/v1/${found.table}`, {
          method: "POST",
          body: JSON.stringify({
            member_id: memberId,
            full_name: payload.full_name,
            username: payload.username,
            status: "disabled",
            email: payload.email,
            password: payload.password,
            country: payload.country,
            birth_date: payload.birth_date,
            ...(canStoreReferral ? referralColumns : {}),
          }),
        });
        if (retry.ok) {
          return { ok: true, reason: "created", member_id: memberId, recovery_code: payload.recovery_code };
        }
      }
      return { ok: false, reason: "error" };
    }
    return { ok: false, reason: "exists" };
  }

  async function createAccount(payload) {
    const rpc = await registerViaRpc(payload);
    if (rpc && rpc.reason && rpc.reason !== "error") return rpc;
    return registerViaRest(payload);
  }

  async function onSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    const fullName = String(data.full_name || "").trim();
    const username = String(data.username || "").trim();
    const email = String(data.email || "").trim().toLowerCase();
    const password = String(data.password || "");
    const country = String(data.country || "").trim();
    const birthDate = String(data.birth_date || "");
    const gender = String(data.gender || "").trim().toLowerCase();

    if (fullName.length < 2) return showAlert("error", t("reg.needName"));
    if (!USERNAME_RE.test(username)) return showAlert("error", MESSAGES.invalid_username());
    if (!EMAIL_RE.test(email)) return showAlert("error", MESSAGES.invalid_email());
    if (password.length < 8) return showAlert("error", MESSAGES.invalid_password());
    if (!birthDate || ageYears(birthDate) < 13) return showAlert("error", MESSAGES.invalid_age());
    if (!country) return showAlert("error", t("reg.needCountry"));
    if (gender !== "male" && gender !== "female") return showAlert("error", t("reg.needGender"));

    const btn = $("#submit-btn");
    btn.disabled = true;
    btn.textContent = t("reg.creating");

    try {
      const hashed = await sha256(password);
      const recoveryCode = generateRecoveryCode();
      const expires = new Date();
      expires.setMonth(expires.getMonth() + 1);
      const membership = {
        membership_type: "Free",
        membership_duration: "1 month",
        membership_expires_at: expires.toISOString(),
        watch_minutes: 0,
      };
      const referral = getReferralAttribution() || {};
      const result = await createAccount({
        full_name: fullName,
        username,
        email,
        password: hashed,
        country,
        birth_date: birthDate,
        recovery_code: recoveryCode,
        gender,
        ...membership,
        ...referral,
      });

      if (result.ok) {
        clearReferralAttribution();
        showSuccess({
          member_id: result.member_id,
          full_name: fullName,
          username,
          email,
          country,
          birth_date: birthDate,
          gender,
          recovery_code: result.recovery_code || recoveryCode,
          ...membership,
        });
        toast(t("reg.createdToast"));
        return;
      }

      if (result.reason === "disabled") showAlert("warn", MESSAGES.disabled());
      else if (result.reason === "exists") showAlert("error", MESSAGES.exists());
      else if (result.reason === "banned") showAlert("error", MESSAGES.banned());
      else if (result.reason === "setup") showAlert("warn", MESSAGES.setup());
      else showAlert("error", (MESSAGES[result.reason] || MESSAGES.error)());
    } catch (error) {
      console.error(error);
      showAlert("error", MESSAGES.error());
    } finally {
      btn.disabled = false;
      btn.textContent = t("reg.create");
    }
  }

  async function setVisual() {
    try {
      const data = await tmdb("/trending/movie/week");
      const hit = (data.results || []).find((x) => x.backdrop_path);
      if (!hit) return;
      $("#auth-visual").style.backgroundImage =
        `linear-gradient(180deg, rgba(7,15,24,.18), rgba(7,15,24,.78)), url('${imgUrl(hit.backdrop_path, "w1280")}')`;
    } catch {
      /* keep CSS fallback */
    }
  }

  function init() {
    setupChrome();
    const select = $("#country");
    select.innerHTML = `<option value="" disabled selected>Select country</option>` +
      COUNTRIES.map((c) => `<option value="${c}">${c}</option>`).join("");

    const birth = document.querySelector('input[name="birth_date"]');
    const max = new Date();
    max.setFullYear(max.getFullYear() - 13);
    birth.max = max.toISOString().slice(0, 10);
    birth.min = "1920-01-01";

    $("#toggle-password").addEventListener("click", () => {
      const input = document.querySelector('input[name="password"]');
      input.type = input.type === "password" ? "text" : "password";
    });

    $("#register-form").addEventListener("submit", onSubmit);
    $("#download-txt").addEventListener("click", () => {
      if (window.__cineauraAccount) downloadAccountTxt(window.__cineauraAccount);
    });
    $("#copy-recovery").addEventListener("click", async () => {
      const code = String($("#success-card").dataset.recovery || "").replace(/[\s\-]/g, "");
      try {
        await navigator.clipboard.writeText(code);
        toast(t("reg.copied"));
      } catch {
        toast(t("reg.copyFail"));
      }
    });
    if (isLoggedIn()) {
      showAlert("ok", `${t("reg.alreadyIn")} <a href="./dashboard.html">${t("nav.dashboard")}</a> · <a href="./">${t("nav.movies")}</a>.`);
    }
    setVisual();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
