(() => {
  const {
    $,
    setupChrome,
    isLoggedIn,
    setSession,
    toast,
    t,
    hydratePrefsFromProfile,
    sha256,
    supabaseRequest,
    normalizeAccountStatus,
    tmdb,
    imgUrl,
    restValue,
    getSession,
    initialsAvatar,
    primeAvatars,
    avatarUrlFor,
    profileHref,
    escapeHtml,
  } = window.CineAura;

  const TABLES = ["members", "Members"];

  function showAlert(type, html) {
    const el = $("#form-alert");
    el.className = `form-alert show ${type}`;
    el.innerHTML = html;
  }

  // ?next=dashboard.html%23iptv — only a dashboard section, the notifications
  // page (with its period) or a channel list (Listchannels.html?free=1,
  // ?package=…) of this site is accepted as a target.
  function nextTarget() {
    const next = new URLSearchParams(location.search).get("next") || "";
    const ok = /^(dashboard\.html(#[a-z]+)?|notifications\.html(\?period=[a-z]+)?|[Ll]istchannels\.html\?[\w%.~*+=&-]*)$/.test(next);
    return ok ? "./" + next : "";
  }

  // The member's avatar and username above the welcome: a link to their profile.
  async function paintUser(member) {
    const link = $("#success-user");
    const username = String(member?.username || "").replace(/^@/, "");
    if (!link || !username) return;
    const img = $("#success-avatar");
    img.src = initialsAvatar(member.full_name || username);
    img.alt = `@${username}`;
    $("#success-handle").textContent = `@${username}`;
    $("#success-name").textContent = member.full_name || username;
    link.href = profileHref(username);
    link.setAttribute("aria-label", `${t("auth.viewProfile")}: @${username}`);
    link.hidden = false;
    let name = "";
    try {
      const res = await supabaseRequest(`/rest/v1/profiles?member_id=eq.${restValue(member.member_id || "")}&select=display_name,avatar_url`);
      const row = res.ok && Array.isArray(res.data) ? res.data[0] : null;
      name = String(row?.display_name || "").trim();
      if (row?.avatar_url) img.src = row.avatar_url;
      else {
        await primeAvatars([member.member_id], [username]);
        const url = avatarUrlFor(member.member_id, username);
        if (url) img.src = url;
      }
    } catch {
      /* the initials stay */
    }
    img.onerror = () => {
      img.onerror = null;
      img.src = initialsAvatar(member.full_name || username);
    };
    if (name) $("#success-name").textContent = name;
  }

  function showSuccess(member) {
    const target = nextTarget();
    if (target) {
      location.replace(target);
      return;
    }
    $("#login-form").hidden = true;
    $("#success-card").hidden = false;
    $("#success-lead").textContent = t("auth.signedAs", { name: member.full_name || member.username || t("auth.yourAccount") });
    paintUser(member);
    $("#success-card").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function findMember(login) {
    const value = String(login || "").trim();
    const email = value.toLowerCase();
    let tableMissing = false;
    for (const table of TABLES) {
      const path = `/rest/v1/${table}?or=(username.ilike.${restValue(value)},email.eq.${restValue(email)})&select=member_id,full_name,username,email,status,password,country,birth_date,recovery_code,created_at`;
      const res = await supabaseRequest(path);
      if (res.status === 404 && res.data?.code === "PGRST205") {
        tableMissing = true;
        continue;
      }
      if (res.ok && Array.isArray(res.data)) {
        return { row: res.data[0] || null, tableMissing: false };
      }
    }
    return { row: null, tableMissing };
  }

  async function loginViaRpc(login, hashed) {
    const res = await supabaseRequest("/rest/v1/rpc/login_member", {
      method: "POST",
      body: JSON.stringify({ p_login: login, p_password: hashed }),
    });
    if (res.ok && res.data && typeof res.data === "object") return res.data;
    return null;
  }

  async function onSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    const login = String(data.login || "").trim();
    const password = String(data.password || "");
    const stay = Boolean(data.stay);

    if (!login || !password) {
      showAlert("error", t("auth.needFields"));
      return;
    }

    const btn = $("#submit-btn");
    btn.disabled = true;
    btn.textContent = t("auth.signing");

    try {
      const hashed = await sha256(password);
      const rpc = await loginViaRpc(login, hashed);
      let result = rpc;

      if (!result) {
        const found = await findMember(login);
        if (found.tableMissing) {
          showAlert("warn", "The Members table is not ready yet. Run sql/members.sql in Supabase, then try again.");
          return;
        }
        if (!found.row) {
          showAlert("error", 'This account is not registered. <a class="btn btn-sm btn-primary" href="./register.html" style="margin-left:8px">Sign up</a>');
          return;
        }
        const status = normalizeAccountStatus(found.row.status);
        if (status === "banned") {
          showAlert("error", "This account has been banned and cannot sign in.");
          return;
        }
        if (found.row.password !== hashed && found.row.password !== password) {
          showAlert("error", 'The password is incorrect. <a class="btn btn-sm btn-primary" href="./Rest.html" style="margin-left:8px">Recovery</a>');
          return;
        }
        result = { ok: true, reason: "ok", member: found.row };
      }

      // the precise refusals first: every refusal has ok: false
      if (result.reason === "bad_password") {
        showAlert("error", `${t("login.badPass")} <a class="btn btn-sm btn-primary" href="./Rest.html" style="margin-left:8px">${t("auth.recovery")}</a>`);
        return;
      }
      if (result.reason === "banned") {
        // banned for not being activated / re-activated within 30 days (sql/account_deadline.sql)
        const why = window.CineAura.accountBanText?.(result.ban_reason);
        showAlert("error", why ? escapeHtml(why) : t("login.banned"));
        return;
      }
      if (result.reason === "setup") {
        showAlert("warn", t("login.setup"));
        return;
      }
      if (result.ok === false || result.reason === "not_found") {
        showAlert("error", `${t("login.notReg")} <a class="btn btn-sm btn-primary" href="./register.html" style="margin-left:8px">${t("nav.signup")}</a>`);
        return;
      }

      const member = result.member || result;
      setSession(member, stay);
      await hydratePrefsFromProfile();
      toast(t("auth.signedOk"));
      showSuccess(member);
    } catch (error) {
      console.error(error);
      showAlert("error", t("login.fail"));
    } finally {
      btn.disabled = false;
      btn.textContent = t("auth.signin");
    }
  }

  async function setVisual() {
    try {
      const data = await tmdb("/trending/tv/week");
      const hit = (data.results || []).find((x) => x.backdrop_path);
      if (!hit) return;
      $("#auth-visual").style.backgroundImage =
        `linear-gradient(180deg, rgba(7,15,24,.18), rgba(7,15,24,.78)), url('${imgUrl(hit.backdrop_path, "w1280")}')`;
    } catch {
      /* keep fallback */
    }
  }

  function init() {
    setupChrome();
    $("#toggle-password").addEventListener("click", () => {
      const input = document.querySelector('input[name="password"]');
      input.type = input.type === "password" ? "text" : "password";
    });
    $("#login-form").addEventListener("submit", onSubmit);
    if (isLoggedIn()) showSuccess(getSession() || {});
    setVisual();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
