(() => {
  const API_KEY = "dec98ec9b59a5938a5ee3ae4eda1e090";
  const API = "https://api.themoviedb.org/3";
  const IMG = "https://image.tmdb.org/t/p";
  const SESSION_KEY = "cineaura_session";
  const CODE_KEY = "cineaura_access_code";
  const REFERRAL_KEY = "cineaura_share_referral";
  const REFERRAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const LANG_KEY = "cineaura_lang";
  const THEME_KEY = "cineaura_theme";
  const LANGS = window.CineAuraLangs || ["en", "ar", "fr", "de", "es", "nl", "it"];
  const TMDB_LANG = { en: "en-US", ar: "ar-SA", fr: "fr-FR", de: "de-DE", es: "es-ES", nl: "nl-NL", it: "it-IT" };
  const LOCALE = { en: "en-US", ar: "ar", fr: "fr-FR", de: "de-DE", es: "es-ES", nl: "nl-NL", it: "it-IT" };
  const SUPABASE_URL = "https://mxdsgnlmfpaekgmswjou.supabase.co";
  const SUPABASE_KEY = "sb_publishable_FZmzR3yk_CR5j9jH191AVQ_NQivMZ-Q";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function toast(message) {
    const el = $("#toast");
    if (!el) return;
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 2800);
  }

  function getSession() {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY) || "null");
    } catch {
      return null;
    }
  }

  function validReferralMemberId(value) {
    return /^ID[0-9]{1,20}$/.test(String(value || ""));
  }

  function validReferralPostId(value) {
    return /^[A-Za-z0-9._-]{1,80}$/.test(String(value || ""));
  }

  function captureShareReferral() {
    try {
      const url = new URL(location.href);
      const referrerId = url.searchParams.get("ca_ref");
      const postId = url.searchParams.get("ca_post");
      if (referrerId === null && postId === null) return;

      if (validReferralMemberId(referrerId) && validReferralPostId(postId) && !getSession()?.member_id) {
        localStorage.setItem(
          REFERRAL_KEY,
          JSON.stringify({ referrer_member_id: referrerId, referred_post_id: postId, captured_at: Date.now() })
        );
      }

      // Keep the attribution in local storage, not in the address bar. The
      // post's own query (for example ?post=P123) remains untouched.
      url.searchParams.delete("ca_ref");
      url.searchParams.delete("ca_post");
      history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
    } catch {
      /* referral tracking is optional; never block the page */
    }
  }

  function getReferralAttribution() {
    try {
      const value = JSON.parse(localStorage.getItem(REFERRAL_KEY) || "null");
      const age = Date.now() - Number(value?.captured_at || 0);
      if (
        !value ||
        !validReferralMemberId(value.referrer_member_id) ||
        !validReferralPostId(value.referred_post_id) ||
        !Number.isFinite(age) ||
        age < 0 ||
        age > REFERRAL_TTL_MS ||
        getSession()?.member_id
      ) {
        if (value) localStorage.removeItem(REFERRAL_KEY);
        return null;
      }
      return {
        referred_by_member_id: value.referrer_member_id,
        referred_post_id: value.referred_post_id,
      };
    } catch {
      return null;
    }
  }

  function clearReferralAttribution() {
    try {
      localStorage.removeItem(REFERRAL_KEY);
    } catch {
      /* storage may be disabled */
    }
  }

  captureShareReferral();

  function isLoggedIn() {
    return Boolean(getSession());
  }

  function setSession(member, stay = true) {
    const payload = JSON.stringify({
      member_id: member.member_id,
      username: member.username,
      email: member.email,
      full_name: member.full_name,
      status: member.status || "active",
      stay: Boolean(stay),
    });
    localStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_KEY);
    if (stay) localStorage.setItem(SESSION_KEY, payload);
    else sessionStorage.setItem(SESSION_KEY, payload);
    renderAuth();
  }

  function renderAuth() {
    const logged = isLoggedIn();
    document.body.classList.toggle("is-logged-in", logged);
    document.body.classList.toggle("is-guest", !logged);
    if (typeof wireSessionNav === "function") wireSessionNav();
  }

  function browserLang() {
    const list = navigator.languages || [navigator.language || "en"];
    for (const raw of list) {
      const code = String(raw || "").toLowerCase().split("-")[0];
      if (LANGS.includes(code)) return code;
    }
    return "en";
  }

  let activeLang = null;
  let activeTheme = null;
  // Ignore an older profile-preference request if a newer setting was applied
  // while that request was still in flight (for example, during dashboard boot).
  let prefsRevision = 0;

  function getLang() {
    if (LANGS.includes(activeLang)) return activeLang;
    const stored = localStorage.getItem(LANG_KEY);
    if (LANGS.includes(stored)) return stored;
    return browserLang();
  }

  function getTheme() {
    if (activeTheme === "day" || activeTheme === "night") return activeTheme;
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "day" ? "day" : "night";
  }

  function getLocale() {
    return LOCALE[getLang()] || "en-US";
  }

  function t(key, vars) {
    const pack = window.CineAuraI18n || {};
    const lang = getLang();
    // 1) dotted interface key, 2) English text looked up in lang/<language>.js
    let s = pack[lang]?.[key] || langText(key) || pack.en?.[key] || key;
    if (vars && typeof s === "string") {
      Object.keys(vars).forEach((k) => {
        s = s.replaceAll(`{${k}}`, String(vars[k]));
      });
    }
    return s;
  }

  // Text that is not an interface key — a Supabase value ("Silver", "banned",
  // "premium", …) or any English string — translated through the language file.
  function langText(value) {
    const api = window.CineAuraLang;
    if (!api || typeof api.text !== "function") return "";
    const out = api.text(value);
    return out === value ? "" : out;
  }

  // Public helper: tr("Free") → "مجاني" in Arabic, "Gratis" in German, …
  function tr(value) {
    const api = window.CineAuraLang;
    return api && typeof api.text === "function" ? api.text(value) : String(value ?? "");
  }

  function ensureArabicFont() {
    if (getLang() !== "ar") return;
    if (document.getElementById("font-ar")) return;
    const link = document.createElement("link");
    link.id = "font-ar";
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&display=swap";
    document.head.appendChild(link);
  }

  function translateDom(root = document) {
    root.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (!key) return;
      const attr = el.getAttribute("data-i18n-attr");
      if (attr) el.setAttribute(attr, t(key));
      else el.textContent = t(key);
    });
    root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      el.placeholder = t(el.getAttribute("data-i18n-placeholder"));
    });
    root.querySelectorAll("[data-i18n-aria]").forEach((el) => {
      el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria")));
    });
    const titleEl = root.querySelector?.("[data-i18n-title]") || document.querySelector("[data-i18n-title]");
    if (titleEl) document.title = t(titleEl.getAttribute("data-i18n-title"));
  }

  function applyPrefs({ language, theme, persist = true } = {}) {
    let changed = false;
    if (language && LANGS.includes(language)) {
      activeLang = language;
      if (persist) localStorage.setItem(LANG_KEY, language);
      changed = true;
    }
    if (theme === "day" || theme === "night") {
      activeTheme = theme;
      if (persist) localStorage.setItem(THEME_KEY, theme);
      changed = true;
    }
    if (changed) prefsRevision++;
    const lang = getLang();
    const mode = getTheme();
    const html = document.documentElement;
    html.dataset.theme = mode;
    html.lang = lang;
    html.dir = lang === "ar" ? "rtl" : "ltr";
    document.body?.classList.toggle("is-rtl", lang === "ar");
    document.body?.classList.toggle("theme-day", mode === "day");
    ensureArabicFont();
    // lang/<language>.js drives every translation; it reloads on a language switch.
    window.CineAuraLang?.load?.(lang);
    translateDom(document);
    wireSessionNav();
    document.dispatchEvent(new CustomEvent("cineaura:prefs", { detail: { language: lang, theme: mode } }));
  }

  let accountLangApplied = false; // the member's saved language beats the IP-based one
  async function hydratePrefsFromProfile() {
    const s = getSession();
    if (!s?.member_id) return;
    const revisionAtStart = prefsRevision;
    try {
      const res = await supabaseRequest(
        `/rest/v1/profiles?member_id=eq.${restValue(s.member_id)}&select=language,theme`
      );
      // Don't let a delayed profile response undo a more recent selection made
      // on this page. Also guard against the account changing while it loads.
      if (revisionAtStart !== prefsRevision || getSession()?.member_id !== s.member_id) return;
      const p = res.data?.[0];
      if (!res.ok || !p) return;
      const language = LANGS.includes(p.language) ? p.language : null;
      const theme = p.theme === "day" || p.theme === "night" ? p.theme : null;
      // A language picked on this device wins; "en" is the default of a fresh profile,
      // so it is not treated as a choice and the browser language keeps applying.
      const manual = LANGS.includes(localStorage.getItem(LANG_KEY));
      const accountLang = language && !manual && language !== "en" ? language : null;
      if (theme) applyPrefs({ theme, persist: true });
      if (accountLang) {
        accountLangApplied = true;
        applyPrefs({ language: accountLang, persist: false });
      }
    } catch {
      /* keep local prefs */
    }
  }

  // ---------- Presence (online = signed in + recent heartbeat) ----------
  function touchPresence(offline) {
    const sess = getSession();
    if (!sess?.member_id) return Promise.resolve();
    return supabaseRequest(`/rest/v1/profiles?member_id=eq.${restValue(sess.member_id)}`, {
      method: "PATCH",
      keepalive: true,
      body: JSON.stringify({ last_seen: offline ? null : new Date().toISOString() }),
    }).catch(() => {});
  }

  function startPresence() {
    if (startPresence._on) return;
    startPresence._on = true;
    touchPresence(false);
    setInterval(() => { if (!document.hidden) touchPresence(false); }, 60000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) touchPresence(false); });
  }

  // ---------- Signed-out gate (pages marked with data-auth-gate) ----------
  // Profile and Dashboard need a session. Once a member signs out — or when a
  // signed-out visitor opens one of those pages — the page goes read-only:
  // every control is dimmed and pointer-blocked, a notice offers the sign-in
  // link, and a capture-phase guard swallows clicks, submits and Enter presses
  // that would otherwise reach a handler.
  function authGateEnabled() {
    return Boolean(document.body) && document.body.dataset.authGate !== undefined;
  }

  function gateAllows(target) {
    if (!target || typeof target.closest !== "function") return true;
    // Header + menu, the notice itself, and any page that draws its own gate.
    if (target.closest("#site-header, #mobile-menu, #auth-gate-note, .dash-gate, .auth-allow, #toast")) return true;
    // Plain links keep working: reading profiles and posts needs no account.
    // Buttons, inputs, forms and selects stay locked (see .auth-locked in CSS).
    const link = target.closest("a[href]");
    if (link) {
      const href = String(link.getAttribute("href") || "").trim();
      if (href && !href.startsWith("#") && !/^javascript:/i.test(href)) return true;
    }
    return false;
  }

  let gateWired = false;
  let gateNoticeAt = 0;

  function gateNotice() {
    const now = Date.now();
    if (now - gateNoticeAt < 800) return;
    gateNoticeAt = now;
    toast(t("auth.gate.blocked"));
    const note = document.getElementById("auth-gate-note");
    if (!note) return;
    note.classList.remove("flash");
    void note.offsetWidth; // restart the highlight
    note.classList.add("flash");
    note.scrollIntoView?.({ block: "center", behavior: "smooth" });
    setTimeout(() => note.classList.remove("flash"), 1400);
  }

  function wireAuthGate() {
    if (gateWired) return;
    gateWired = true;
    // Capture phase, so nothing inside the page ever sees the event. Every
    // mouse action, keystroke (typing, Enter, Space, arrows on a <select>) and
    // form control change is dropped while the page is locked.
    const block = (e) => {
      if (!document.body.classList.contains("auth-locked")) return;
      // A session that appeared since the lock (another tab, restored page)
      // wins: unlock and let this interaction through untouched.
      if (getSession()?.member_id) {
        hideAuthGate();
        return;
      }
      if (gateAllows(e.target)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
      gateNotice();
    };
    for (const type of ["click", "submit", "keydown", "keypress", "keyup", "input", "change", "paste", "drop"]) {
      document.addEventListener(type, block, true);
    }
  }

  // data-auth-gate="note"   → lock the page and show the sign-in notice
  // data-auth-gate="silent" → lock the page; the page draws its own gate card
  function showAuthGate() {
    if (!authGateEnabled()) return false;
    wireAuthGate();
    document.body.classList.add("auth-locked");
    if (document.body.dataset.authGate === "silent") return true;
    if (document.getElementById("auth-gate-note")) return true;
    const main = document.querySelector("main");
    if (!main) return true;
    const note = document.createElement("section");
    note.className = "glass auth-gate-note";
    note.id = "auth-gate-note";
    note.innerHTML = `
      <div class="auth-gate-copy">
        <h2>${t("auth.gate.title")}</h2>
        <p>${t("auth.gate.text")}</p>
        <p class="muted">${t("auth.gate.readOnly")}</p>
      </div>
      <a class="btn btn-sm btn-primary auth-allow" href="./login.html">${t("common.signin")}</a>`;
    // Sits outside <main>: the page scripts redraw main's content at will.
    main.insertAdjacentElement("beforebegin", note);
    return true;
  }

  // Locks when there is no session, unlocks when there is one. Cheap enough to
  // run on every focus/pageshow/visibilitychange, which is what closes the
  // "signed out, then pressed Back" hole (bfcache restores a stale DOM without
  // re-running the page scripts).
  function syncAuthGate() {
    if (!authGateEnabled()) return false;
    if (getSession()?.member_id) return hideAuthGate();
    return showAuthGate();
  }

  // Another tab signing out locks this one too, then reloads into the guest view.
  function watchSessionLock() {
    if (watchSessionLock._on) return;
    watchSessionLock._on = true;
    window.addEventListener("storage", (e) => {
      if (e.key !== SESSION_KEY || !authGateEnabled()) return;
      // Signed in elsewhere: the controls come back without a reload.
      if (getSession()?.member_id) {
        hideAuthGate();
        return;
      }
      showAuthGate();
      setTimeout(() => location.reload(), 350);
    });
    // Back/forward (bfcache), tab switch, window focus: re-check the session.
    window.addEventListener("pageshow", () => syncAuthGate());
    window.addEventListener("focus", () => syncAuthGate());
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) syncAuthGate();
    });
  }

  // Called by the page-level write guards when a session-less write shows up.
  let writeBlockedAt = 0;
  function sessionWriteBlocked() {
    showAuthGate();
    const now = Date.now();
    if (now - writeBlockedAt < 1200) return;
    writeBlockedAt = now;
    toast(t("auth.gate.blocked"));
  }

  function hideAuthGate() {
    document.body.classList.remove("auth-locked");
    document.getElementById("auth-gate-note")?.remove();
  }

  function logout() {
    touchPresence(true);
    localStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_KEY);
    renderAuth();
    // Pages that need a session (Profile / Dashboard) go inert before the reload,
    // so nothing on them can be clicked, typed or submitted after signing out.
    showAuthGate();
    toast(t("home.signedOut"));
    setTimeout(() => location.reload(), 400);
  }

  function normalizeRecoveryCode(value) {
    return String(value || "").replace(/[\s\-]/g, "").replace(/[^A-Za-z0-9]/g, "").slice(0, 16);
  }

  function restValue(value) {
    return encodeURIComponent(String(value || "").trim());
  }

  function downloadAccountTxt(info) {
    const created = info.created_at
      ? String(info.created_at).slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const body = [
      "CineAura account details",
      "========================",
      `Member ID: ${info.member_id || ""}`,
      `Full name: ${info.full_name || ""}`,
      `Username: ${info.username || ""}`,
      `Email: ${info.email || ""}`,
      `Country: ${info.country || ""}`,
      `Gender: ${info.gender || ""}`,
      `Membership: ${info.membership_type || "Free"}`,
      `Membership duration: ${info.membership_duration || "1 month"}`,
      `Watch minutes: ${Number(info.watch_minutes || 0)}`,
      `Date of birth: ${info.birth_date || ""}`,
      `Account created: ${created}`,
      `Recovery code: ${info.recovery_code || ""}`,
      "",
      "Keep this recovery code private.",
      "Enter it on the Rest page to request a new password.",
    ].join("\r\n");
    const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `CineAura-${info.member_id || "account"}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function imgUrl(path, size = "w780") {
    if (!path) return "";
    return `${IMG}/${size}${path}`;
  }

  function formatRuntime(minutes) {
    if (!minutes && minutes !== 0) return "—";
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h ? `${h}h ${m}m` : `${m}m`;
  }

  function formatDate(value) {
    if (!value) return "TBA";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleDateString(getLocale(), {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  function ratingText(value) {
    return Number(value || 0).toFixed(1);
  }

  function ratingPercent(value) {
    return Math.round(Number(value || 0) * 10);
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function watchHref(type, id, season, episode, postId) {
    const post = postId ? `&post=${encodeURIComponent(postId)}` : "";
    if (type === "tv") {
      const s = season ? `&season=${season}` : "";
      const e = episode ? `&episode=${episode}` : "";
      return `./watch.html?tv=${id}${s}${e}${post}`;
    }
    return `./watch.html?movie=${id}${post}`;
  }

  function personHref(id) {
    return `./Cast.html?person=${id}`;
  }

  // TMDB filmography of a person, cached in sessionStorage so the profile
  // updates feed and the Cast page share one request per person.
  async function personCredits(id) {
    const key = `cineaura_person_credits_v1:${id}`;
    try {
      const cached = sessionStorage.getItem(key);
      if (cached) return JSON.parse(cached);
    } catch {
      /* ignore */
    }
    const out = { profile_path: "", works: [] };
    try {
      const data = await tmdb(`/person/${id}/combined_credits`);
      const rows = [...(data.cast || []), ...(data.crew || [])].filter(
        (c) => (c.media_type === "movie" || c.media_type === "tv") && c.id
      );
      out.profile_path = rows.find((c) => c.profile_path)?.profile_path || "";
      out.works = [...new Set(rows.map((c) => `${c.media_type}:${c.id}`))];
    } catch {
      /* offline: no filmography */
    }
    try {
      sessionStorage.setItem(key, JSON.stringify(out));
    } catch {
      /* ignore quota */
    }
    return out;
  }

  function initialsAvatar(name) {
    const initials = String(name || "NA")
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" rx="18" fill="#0d253f"/><text x="50%" y="54%" text-anchor="middle" fill="#90cea1" font-family="Outfit,sans-serif" font-size="24" font-weight="700">${initials}</text></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  function photo(path, name, size = "w185") {
    return imgUrl(path, size) || initialsAvatar(name);
  }

  // ---------- Avatars (shared cache so every page shows the real picture) ----------
  const avatarById = new Map();
  const avatarByName = new Map();

  function cacheAvatarRow(row) {
    if (!row) return;
    if (row.member_id) avatarById.set(String(row.member_id), row.avatar_url || "");
    if (row.username) avatarByName.set(String(row.username).replace(/^@/, "").toLowerCase(), row.avatar_url || "");
  }

  async function profilesByIds(ids, columns = ["member_id", "avatar_url"]) {
    const list = [...new Set((ids || []).map((x) => (x == null ? "" : String(x))).filter(Boolean))];
    if (!list.length) return [];
    const cols = (Array.isArray(columns) ? columns : String(columns).split(",")).map((c) => c.trim()).filter(Boolean);
    const filter = `member_id=in.(${list.map(restValue).join(",")})`;
    const pick = cols.slice();
    while (pick.length) {
      const res = await supabaseRequest(`/rest/v1/profiles?${filter}&select=${pick.join(",")}`);
      if (res.ok) return Array.isArray(res.data) ? res.data : [];
      pick.pop();
    }
    return [];
  }

  async function profilesByUsernames(names, columns = ["member_id", "username", "avatar_url"]) {
    const list = [...new Set((names || []).map((x) => String(x || "").replace(/^@/, "").trim()).filter(Boolean))];
    if (!list.length) return [];
    const cols = (Array.isArray(columns) ? columns : String(columns).split(",")).map((c) => c.trim()).filter(Boolean);
    const pick = cols.slice();
    while (pick.length) {
      const filter = `username=in.(${list.map(restValue).join(",")})`;
      let res = await supabaseRequest(`/rest/v1/profiles?${filter}&select=${pick.join(",")}`);
      if (!res.ok) {
        const or = list.map((n) => `username.ilike.${restValue(n)}`).join(",");
        res = await supabaseRequest(`/rest/v1/profiles?or=(${or})&select=${pick.join(",")}`);
      }
      if (res.ok) return Array.isArray(res.data) ? res.data : [];
      pick.pop();
    }
    return [];
  }

  async function primeAvatars(ids = [], usernames = []) {
    const wantIds = [...new Set((ids || []).filter(Boolean).map(String))].filter((id) => !avatarById.has(id));
    const wantNames = [...new Set((usernames || []).filter(Boolean).map((u) => String(u).replace(/^@/, "").toLowerCase()))].filter(
      (n) => !avatarByName.has(n)
    );
    if (!wantIds.length && !wantNames.length) return;
    try {
      const [byIds, byNames] = await Promise.all([
        wantIds.length ? profilesByIds(wantIds) : [],
        wantNames.length ? profilesByUsernames(wantNames) : [],
      ]);
      [...byIds, ...byNames].forEach(cacheAvatarRow);
    } catch {
      /* offline: keep initials */
    }
    wantIds.forEach((id) => { if (!avatarById.has(id)) avatarById.set(id, ""); });
    wantNames.forEach((n) => { if (!avatarByName.has(n)) avatarByName.set(n, ""); });
  }

  function avatarUrlFor(memberId, username) {
    const id = memberId ? String(memberId) : "";
    const name = username ? String(username).replace(/^@/, "").toLowerCase() : "";
    return (id && avatarById.get(id)) || (name && avatarByName.get(name)) || "";
  }

  function avatarSrc(memberId, username, fallback = "") {
    return avatarUrlFor(memberId, username) || initialsAvatar(fallback || username || memberId || "CA");
  }

  function avatarImg(memberId, username, fallback = "") {
    const src = avatarSrc(memberId, username, fallback);
    return `<img src="${escapeHtml(src)}" alt="" data-avatar-for="${escapeHtml(memberId || "")}" data-avatar-name="${escapeHtml(String(username || "").replace(/^@/, ""))}" />`;
  }

  // Re-paint every avatar of one member (used after a settings change).
  function refreshAvatar(memberId, url) {
    const id = memberId ? String(memberId) : "";
    if (id) avatarById.set(id, url || "");
    $$("[data-avatar-for]").forEach((n) => {
      if (!id || n.dataset.avatarFor !== id) return;
      if (url) {
        n.src = url;
        n.onerror = () => {
          n.onerror = null;
          n.src = initialsAvatar(n.dataset.avatarName || "CA");
        };
      } else {
        n.src = initialsAvatar(n.dataset.avatarName || "CA");
      }
    });
  }

  // Replaces initials with the stored avatar as soon as the profiles arrive.
  async function hydrateAvatars(root = document) {
    const nodes = [...root.querySelectorAll("[data-avatar-for], [data-avatar-name]")].filter(
      (n) => n.dataset.avatarFor || n.dataset.avatarName
    );
    if (!nodes.length) return;
    await primeAvatars(nodes.map((n) => n.dataset.avatarFor), nodes.map((n) => n.dataset.avatarName));
    nodes.forEach((n) => {
      const url = avatarUrlFor(n.dataset.avatarFor, n.dataset.avatarName);
      if (!url) return;
      n.src = url;
      // Broken avatar link -> keep the initials instead of a broken image.
      n.onerror = () => {
        n.onerror = null;
        n.src = initialsAvatar(n.dataset.avatarName || "CA");
      };
    });
  }

  // ---------- Profile picture: an uploaded photo or an image link ----------
  // Uploads go to Supabase Storage, bucket IPTV, folder Avatar, named after the
  // member id (Avatar/ID123.jpg) and sent with x-upsert: a new photo replaces the
  // old one under the same name. sql/avatar_storage.sql holds the Storage policies
  // that let the public key write exactly that file and nothing else.
  const AVATAR_BUCKET = "IPTV";
  const AVATAR_FOLDER = "Avatar";
  const AVATAR_PX = 512; // the stored photo is a square of at most 512 x 512
  const AVATAR_MAX_BYTES = 10 * 1024 * 1024; // the file picked, before it is made smaller
  const AVATAR_ERRORS = {
    member: "avatar.errMember",
    type: "avatar.errType",
    big: "avatar.errBig",
    decode: "avatar.errDecode",
    setup: "avatar.errSetup",
    network: "avatar.errNetwork",
    failed: "avatar.errFailed",
  };
  const UPLOAD_ICON =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>';

  function avatarObjectPath(memberId) {
    return `${AVATAR_FOLDER}/${memberId}.jpg`;
  }

  // The file keeps its name from one upload to the next, so ?v= changes with each
  // upload: browsers and the Storage CDN fetch the new photo instead of the old one.
  function avatarPublicUrl(memberId, version = Date.now()) {
    return `${SUPABASE_URL}/storage/v1/object/public/${AVATAR_BUCKET}/${avatarObjectPath(memberId)}?v=${version}`;
  }

  function loadImageFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve({ img, url });
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("decode"));
      };
      img.src = url;
    });
  }

  // Centre square of the photo (turned the way the camera held it), at most
  // AVATAR_PX wide, as a JPEG. A transparent background becomes white.
  async function squareAvatar(file, px = AVATAR_PX) {
    const { img, url } = await loadImageFile(file);
    try {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (!w || !h) throw new Error("decode");
      const side = Math.min(w, h);
      const out = Math.max(1, Math.min(px, side));
      const canvas = document.createElement("canvas");
      canvas.width = out;
      canvas.height = out;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, out, out);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, out, out);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
      if (!blob) throw new Error("decode");
      return blob;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // -> { ok: true, url } | { ok: false, reason: member | type | big | decode | setup | network | failed }
  async function uploadAvatar(memberId, file) {
    const id = String(memberId || "");
    // only the member signed in on this browser (not one signed out, or switched, in another tab)
    if (!/^ID[0-9]{1,20}$/.test(id) || String(getSession()?.member_id || "") !== id) return { ok: false, reason: "member" };
    if (!file) return { ok: false, reason: "type" };
    // some phones give no type for their photos: those are tried, and refused if they don't decode
    if (file.type && !/^image\//i.test(file.type)) return { ok: false, reason: "type" };
    if (file.size > AVATAR_MAX_BYTES) return { ok: false, reason: "big" };
    let blob;
    try {
      blob = await squareAvatar(file);
    } catch {
      return { ok: false, reason: "decode" };
    }
    let res;
    try {
      res = await fetch(`${SUPABASE_URL}/storage/v1/object/${AVATAR_BUCKET}/${avatarObjectPath(id)}`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "image/jpeg",
          "x-upsert": "true",
          // browsers keep a picture for a day; every upload has a new ?v= link anyway
          // (without this header a REST upload is stored as no-cache)
          "cache-control": "max-age=86400",
        },
        body: blob,
      });
    } catch {
      return { ok: false, reason: "network" };
    }
    if (res.ok) return { ok: true, url: avatarPublicUrl(id), bytes: blob.size };
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
    // no policy yet (row-level security), no bucket, or a bucket that refuses JPEG files
    else if ([401, 403, 404, 415].includes(status) || /row-level security|bucket not found|mime/i.test(message)) reason = "setup";
    if (reason === "setup") {
      console.warn(`[CineAura] Avatar upload refused (${status} ${message}). Run sql/avatar_storage.sql in the Supabase SQL editor; bucket ${AVATAR_BUCKET} must exist and accept image/jpeg.`);
    }
    return { ok: false, reason, status, message };
  }

  // The profile picture field: preview, "Upload a photo" (when the member is known)
  // and the image link input, which keeps the id the page saves from.
  function avatarFieldHtml({ id, value = "", name = "", memberId = "" } = {}) {
    const v = String(value || "");
    const canUpload = /^ID[0-9]{1,20}$/.test(String(memberId || ""));
    return `
      <div class="avf" data-avf>
        <img class="avf-img" data-avf-img src="${escapeHtml(v || initialsAvatar(name || "CA"))}" alt="" width="84" height="84" />
        <div class="avf-body">
          <label class="avf-label" for="${escapeHtml(id)}">${escapeHtml(t("avatar.label"))}</label>
          ${canUpload ? `
          <div class="avf-row">
            <button class="btn btn-sm btn-primary avf-pick" type="button" data-avf-pick>${UPLOAD_ICON}<span>${escapeHtml(t("avatar.upload"))}</span></button>
            <input type="file" accept="image/*" hidden data-avf-file />
            <span class="avf-or">${escapeHtml(t("avatar.or"))}</span>
          </div>` : ""}
          <input id="${escapeHtml(id)}" class="avf-url" type="text" inputmode="url" autocomplete="off" spellcheck="false" dir="ltr" value="${escapeHtml(v)}" placeholder="${escapeHtml(t("avatar.urlPh"))}" />
          <p class="avf-hint">${escapeHtml(t(canUpload ? "avatar.hint" : "avatar.hintLink"))}</p>
          <p class="avf-status" data-avf-status role="status" aria-live="polite"></p>
        </div>
      </div>`;
  }

  // save(url) -> true | false: stores a new upload on the profile at once (the old
  // file is already replaced). Without it the page saves the link with its form.
  // uploaded(url) hears about every upload that went through.
  function wireAvatarField(root, { memberId = "", name = "", save = null, uploaded = null } = {}) {
    const box = root?.querySelector?.("[data-avf]");
    if (!box) return null;
    const img = box.querySelector("[data-avf-img]");
    const input = box.querySelector(".avf-url");
    const pick = box.querySelector("[data-avf-pick]");
    const file = box.querySelector("[data-avf-file]");
    const status = box.querySelector("[data-avf-status]");
    const fallback = initialsAvatar(name || "CA");
    const say = (text, kind = "") => {
      status.textContent = text || "";
      status.className = `avf-status${kind ? ` ${kind}` : ""}`;
    };
    const show = (url) => {
      img.onerror = null;
      if (!url) {
        img.src = fallback;
        return;
      }
      img.onerror = () => {
        img.onerror = null;
        img.src = fallback;
        // only about the link in the field now, not one typed before
        if (input.value.trim() === url) say(t("avatar.badLink"), "bad");
      };
      img.src = url;
    };
    show(input.value.trim());
    let timer = 0;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        say("");
        show(input.value.trim());
      }, 350);
    });
    if (pick && file) {
      pick.addEventListener("click", () => file.click());
      file.addEventListener("change", async () => {
        const chosen = file.files?.[0];
        file.value = ""; // picking the same file again fires change again
        if (!chosen || pick.disabled) return;
        pick.disabled = true;
        box.classList.add("busy");
        say(t("avatar.uploading"));
        try {
          const res = await uploadAvatar(memberId, chosen);
          if (!res.ok) {
            say(t(AVATAR_ERRORS[res.reason] || "avatar.errFailed"), "bad");
            if (res.reason === "member" && !getSession()?.member_id) sessionWriteBlocked();
            return;
          }
          clearTimeout(timer);
          input.value = res.url;
          show(res.url);
          if (typeof uploaded === "function") uploaded(res.url);
          if (typeof save === "function") {
            let saved = false;
            try {
              saved = await save(res.url);
            } catch {
              saved = false;
            }
            say(t(saved ? "avatar.saved" : "avatar.errSave"), saved ? "ok" : "bad");
          } else {
            say(t("avatar.uploadedNext"), "ok");
          }
        } finally {
          pick.disabled = false;
          box.classList.remove("busy");
        }
      });
    }
    return { show, say };
  }

  // Staff (Super Admin / Admin / Moderator) rows, safe when sql/panel.sql is not installed yet.
  async function fetchStaff(columns = "id,role,member_id,username") {
    const pick = String(columns).split(",").map((c) => c.trim()).filter(Boolean);
    const res = await supabaseRequest(`/rest/v1/staff?select=${pick.join(",")}&order=created_at.asc`);
    return res.ok && Array.isArray(res.data) ? res.data : [];
  }

  async function tmdb(path) {
    const join = path.includes("?") ? "&" : "?";
    const url = `${API}${path}${join}api_key=${API_KEY}&language=${TMDB_LANG[getLang()] || "en-US"}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`TMDB ${res.status}`);
    return res.json();
  }

  function normalizeStatus(value) {
    const raw = String(value || "").trim().toLowerCase();
    const map = {
      active: "active",
      activated: "active",
      enabled: "active",
      "مفعل": "active",
      disabled: "disabled",
      disabled_by_owner: "disabled",
      inactive: "disabled",
      "معطل": "disabled",
      banned: "banned",
      blocked: "banned",
      "محظور": "banned",
      expired: "expired",
      "منتهي": "expired",
    };
    return map[raw] || map[String(value || "").trim()] || raw || "unknown";
  }

  /* ---------- Age tiers for watch codes ----------
     A code carries the oldest rating it may serve; a title carries the age its
     certificate demands. A code only unlocks a title when that age sits inside
     the code's ceiling, so a child's code cannot open content rated above it. */
  const AGE_TIERS = [
    { id: "u13", max: 12, label: "code.ageU13" },
    { id: "u16", max: 15, label: "code.ageU16" },
    { id: "u18", max: 17, label: "code.ageU18" },
    { id: "adult", max: 99, label: "code.ageAdult" },
  ];
  const AGE_UNKNOWN = 13;   // an unclassified title is treated as PG-13 level
  const AGE_GATE_MIN = 13;  // a title rated 13+ (13+, 16+, 18+) always needs a code, whatever its score
  const AGE_NO_PREVIEW = 16; // from this age a title plays no preview at all
  const CODE_SCORE_OVER = 50; // a title scored above 50% on TMDB needs a code

  // Certificate -> youngest viewer it allows, across the boards TMDB reports.
  const CERT_AGES = {
    G: 0, "TV-Y": 0, "TV-Y7": 7, "TV-Y7-FV": 7, "TV-G": 0, U: 0, AL: 0, L: 0,
    TP: 0, "TOUT PUBLIC": 0, P: 0, "0": 0, "0+": 0, ER: 0,
    "6": 6, "6+": 6, "7": 7, "7+": 7, "9": 9, "9+": 9, "10": 10, "10+": 10,
    PG: 7, "TV-PG": 7, "11": 11, "12": 12, "12+": 12, "12A": 12, "M/12": 12,
    "PG-13": 13, "PG13": 13, "TV-14": 14, "14": 14, "14+": 14, "14A": 14, T: 13, "13": 13, "13+": 13,
    "15": 15, "15+": 15, M: 15, "MA15+": 15, "UA": 12, "U/A": 12,
    "16": 16, "16+": 16, "16A": 16, "R-16": 16, "17": 17, R: 17, "TV-R": 17,
    "18": 18, "18+": 18, "18A": 18, "TV-MA": 18, "NC-17": 18, "X": 18, "XXX": 18,
    "R18": 18, "R18+": 18, "R-18": 18, "A": 18, "S": 18, "FSK18": 18, "FSK-18": 18,
  };

  function certAge(certification) {
    const raw = String(certification || "").trim().toUpperCase().replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ");
    if (!raw || raw === "NR" || raw === "NOT RATED" || raw === "N/A" || raw === "-") return null;
    if (CERT_AGES[raw] !== undefined) return CERT_AGES[raw];
    const compact = raw.replace(/[\s\/]/g, "");
    if (CERT_AGES[compact] !== undefined) return CERT_AGES[compact];
    // "FSK 16", "16 anos", "-12", "12A": fall back to the number in the label
    const hit = /(\d{1,2})/.exec(compact);
    if (hit) return Math.min(18, Number(hit[1]));
    return null;
  }

  function titleCerts(detail, mediaType) {
    const out = [];
    if (mediaType === "tv") {
      (detail?.content_ratings?.results || []).forEach((group) => {
        const cert = String(group.rating || "").trim();
        if (cert) out.push({ region: String(group.iso_3166_1 || "").toUpperCase(), cert });
      });
      return out;
    }
    (detail?.release_dates?.results || []).forEach((group) => {
      (group.release_dates || []).forEach((entry) => {
        const cert = String(entry.certification || "").trim();
        if (cert) out.push({ region: String(group.iso_3166_1 || "").toUpperCase(), cert });
      });
    });
    return out;
  }

  // The age a title demands: the visitor's own country first, then the US,
  // then every country TMDB lists. Inside a pool the strictest reading wins.
  function titleAge(detail, options = {}) {
    const mediaType = options.mediaType === "tv" ? "tv" : "movie";
    const region = String(options.country || currentCountry() || "US").toUpperCase();
    const certs = titleCerts(detail, mediaType);
    if (detail?.adult === true) {
      return { age: 18, cert: "18+", region, known: true, source: "adult" };
    }
    const inRegion = (cc) => certs.filter((c) => c.region === cc);
    const mine = inRegion(region);
    const us = inRegion("US");
    const pool = mine.length ? mine : us.length ? us : certs;
    let chosen = null;
    pool.forEach((entry) => {
      const age = certAge(entry.cert);
      if (age === null) return;
      if (!chosen || age > chosen.age) chosen = { age, cert: entry.cert };
    });
    if (!chosen) return { age: AGE_UNKNOWN, cert: "", region, known: false, source: "none" };
    return {
      age: chosen.age,
      cert: chosen.cert,
      region,
      known: true,
      source: mine.length ? region : us.length ? "US" : "other",
    };
  }

  // Codes saved before this feature carry no tier: they stay unrestricted.
  function ageTier(id) {
    return AGE_TIERS.find((tier) => tier.id === String(id || "").trim()) || AGE_TIERS[AGE_TIERS.length - 1];
  }

  function codeAgeTier(row) {
    return ageTier(row && row.age_rating);
  }

  // The lowest tier that is allowed to open a title of this age.
  function tierForAge(age) {
    return AGE_TIERS.find((tier) => tier.max >= Number(age || 0)) || AGE_TIERS[AGE_TIERS.length - 1];
  }

  function ageGate(tierId, age) {
    const tier = ageTier(tierId);
    const need = tierForAge(age);
    return { allowed: tier.max >= Number(age || 0), tier, need };
  }

  /* When the watch page asks for a code:
     - the title's TMDB score, the % shown on the page, is above 50 (51% and up), or
     - the title is rated 13+ (13+, 16+ or 18+), whatever its score.
     A title with no age rating at all follows its score only; when it asks, it is
     still treated as 13+ for the code tiers (AGE_UNKNOWN). "Remember the code"
     opens every one of them without asking again, as long as the code's own age
     limit reaches the title. */
  function titleNeedsCode(detail, ageInfo) {
    if (ratingPercent(detail?.vote_average) > CODE_SCORE_OVER) return true;
    return Boolean(ageInfo?.known && Number(ageInfo.age || 0) >= AGE_GATE_MIN);
  }

  const CODE_MESSAGES = {
    active: "Code accepted. Enjoy the title.",
    disabled: "This code has been disabled by its owner.",
    banned: "This code has been banned by the platform.",
    expired: "This code has expired.",
    not_found: "This code does not exist. You can create one when you register.",
    invalid: "Enter a valid 6-digit access code.",
    setup: "Access codes are being configured. Please try again shortly.",
    error: "Could not verify the code. Please try again.",
    unknown: "This code cannot be used right now.",
  };

  /* ---------- One device per code ----------
     Every browser gets a MAC-style address of its own, created once and kept
     in it (a web page can never read the real MAC address of a machine). The
     database links a code to the device that uses it and refuses the code on
     any other device until its owner unlinks it in Dashboard > Codes
     (sql/code_devices.sql). The address is "locally administered" (02, 06, 0A,
     0E… as first byte), the range set aside for addresses that are not burnt
     into a network card, so it can never be mistaken for a real one. */
  const DEVICE_KEY = "cineaura_device_mac";
  const MAC_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;

  function deviceMac() {
    let mac = "";
    try {
      mac = String(localStorage.getItem(DEVICE_KEY) || "");
    } catch {
      /* storage unavailable */
    }
    if (MAC_RE.test(mac)) return mac;
    if (deviceMac.memo) return deviceMac.memo;
    const bytes = new Uint8Array(6);
    if (window.crypto?.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (let i = 0; i < 6; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    bytes[0] = (bytes[0] & 0xfc) | 0x02; // locally administered, unicast
    mac = [...bytes].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":");
    deviceMac.memo = mac; // the same address for this page even if storage refuses it
    try {
      localStorage.setItem(DEVICE_KEY, mac);
    } catch {
      /* storage unavailable */
    }
    return mac;
  }

  // "Chrome · Windows": helps the owner recognise a linked device in the dashboard
  function deviceName() {
    const ua = String(navigator.userAgent || "");
    let os = "";
    if (/SmartTV|SMART-TV|Tizen|Web0S|webOS|BRAVIA|AFT[A-Z]|Android TV|GoogleTV|CrKey/i.test(ua)) os = "TV";
    else if (/Windows/i.test(ua)) os = "Windows";
    else if (/Android/i.test(ua)) os = "Android";
    else if (/iPhone|iPod/i.test(ua)) os = "iPhone";
    else if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) os = "iPad";
    else if (/Mac OS X|Macintosh/i.test(ua)) os = "macOS";
    else if (/CrOS/i.test(ua)) os = "ChromeOS";
    else if (/Linux/i.test(ua)) os = "Linux";
    let browser = "";
    if (/Edg(e|A|iOS)?\//.test(ua)) browser = "Edge";
    else if (/OPR\/|Opera/.test(ua)) browser = "Opera";
    else if (/SamsungBrowser/.test(ua)) browser = "Samsung Internet";
    else if (/Firefox\/|FxiOS/.test(ua)) browser = "Firefox";
    else if (/Chrome\/|CriOS/.test(ua)) browser = "Chrome";
    else if (/Safari\//.test(ua)) browser = "Safari";
    return [browser, os].filter(Boolean).join(" · ") || "Browser";
  }

  /* ---------- Linked devices (Dashboard > Codes > Linked devices) ----------
     Every device linked to a code has a type. The watch page adds a device as
     "web" (for now the site is the only app); its owner can add one by hand
     with any type, and change it. */
  const DEVICE_ICON_PATHS = {
    web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/>',
    computer: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 18.5h2"/>',
    tv: '<rect x="2.5" y="6.5" width="19" height="12" rx="2"/><path d="M8 2.5l4 4 4-4M8 21.5h8"/>',
    tablet: '<rect x="4.5" y="2.5" width="15" height="19" rx="2.2"/><path d="M11 18.5h2"/>',
  };
  const DEVICE_TYPES = [
    { id: "web", label: "dash.dev.type.web" },
    { id: "computer", label: "dash.dev.type.computer" },
    { id: "phone", label: "dash.dev.type.phone" },
    { id: "tv", label: "dash.dev.type.tv" },
    { id: "tablet", label: "dash.dev.type.tablet" },
  ];

  function deviceType(id) {
    return DEVICE_TYPES.find((type) => type.id === String(id || "").trim().toLowerCase()) || null;
  }

  function deviceTypeIcon(id, size = 18) {
    const type = deviceType(id) || DEVICE_TYPES[0];
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${DEVICE_ICON_PATHS[type.id]}</svg>`;
  }

  /* A MAC address typed by hand, as the database keeps it (sql/code_devices.sql
     _code_mac): "0a-1b-2c-3d-4e-5f", "0A1B2C3D4E5F" or "0a1b.2c3d.4e5f" ->
     "0A:1B:2C:3D:4E:5F". "" for anything else, and for the addresses no device
     has (all zeros, broadcast, multicast). */
  function normalizeMac(input) {
    const raw = String(input || "").trim().toUpperCase();
    let hex = "";
    if (/^[0-9A-F]{2}([:-][0-9A-F]{2}){5}$/.test(raw)) hex = raw.replace(/[:-]/g, "");
    else if (/^[0-9A-F]{12}$/.test(raw)) hex = raw;
    else if (/^[0-9A-F]{4}\.[0-9A-F]{4}\.[0-9A-F]{4}$/.test(raw)) hex = raw.replace(/\./g, "");
    if (!hex || hex === "000000000000" || hex === "FFFFFFFFFFFF") return "";
    if (parseInt(hex[1], 16) % 2 === 1) return ""; // multicast
    return hex.match(/../g).join(":");
  }

  // The public IP, asked once per page and never stored. The database prefers
  // the address the API gateway saw; this is only its fallback.
  let ipPromise = null;
  function publicIp() {
    if (ipPromise) return ipPromise;
    const readers = [
      ["https://api.ipify.org?format=json", (x) => JSON.parse(x).ip],
      ["https://api64.ipify.org?format=json", (x) => JSON.parse(x).ip],
      ["https://ipv4.icanhazip.com/", (x) => x.trim()],
      ["https://ipwho.is/", (x) => JSON.parse(x).ip],
    ];
    ipPromise = (async () => {
      for (const [url, read] of readers) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 4000);
        try {
          const r = await fetch(url, { cache: "no-store", signal: ctl.signal });
          if (!r.ok) continue;
          const ip = String(read(await r.text()) || "").trim();
          if (ip && /^[0-9a-fA-F.:]+$/.test(ip)) return ip;
        } catch {
          /* try the next service */
        } finally {
          clearTimeout(timer);
        }
      }
      ipPromise = null; // try again next time
      return "";
    })();
    return ipPromise;
  }

  // A MAC (or the end of one) inside a sentence: kept left to right in Arabic
  const ltr = (text) => `\u2066${text}\u2069`;
  const maskedMac = (tail) => ltr(`••:••:••:••:${String(tail || "••:••")}`);

  function codeFailure(reason, data, options, code) {
    const silent = Boolean(options.silent);
    const vars = { code: ltr(code) };
    if (reason === "age") {
      const required = Number(options.requiredAge || 0);
      const gate = ageGate(data?.age_rating, required);
      const ageVars = { have: t(gate.tier.label), need: t(gate.need.label), cert: String(options.cert || ""), age: required };
      return {
        ok: false,
        reason: "age",
        message: ageVars.cert ? t("code.ageBlockedCert", ageVars) : t("code.ageBlocked", ageVars),
        tier: gate.tier.id,
        need: gate.need.id,
        row: data,
      };
    }
    let message;
    if (reason === "other_device") {
      message = silent ? t("code.savedOther", vars) : t("code.otherDevice", { mac: maskedMac(data?.device_tail) });
    } else if (reason === "unlinked") {
      message = t("code.savedUnlinked", vars);
    } else if (reason === "not_found") {
      message = silent ? t("code.savedGone", vars) : t("code.not_found");
    } else if (reason === "device") {
      message = t("code.error");
    } else {
      message = t(`code.${reason}`) !== `code.${reason}` ? t(`code.${reason}`) : t("code.unknown");
    }
    return { ok: false, reason: reason || "unknown", message, row: data };
  }

  /* Checks a watch code for this device.
       options.requiredAge / options.cert  the title's age rating
       options.silent                      the code remembered on this device (not
                                           typed): it only works while it is still
                                           linked to this device
       options.link                        "Remember the code": only then is the code
                                           linked to this device (Linked devices; the
                                           code this device used before is set free)
     Without sql/code_devices.sql the code is read directly, as before. */
  async function verifyCode(code, options = {}) {
    const clean = String(code || "").replace(/\D/g, "");
    if (!/^\d{6}$/.test(clean)) {
      return { ok: false, reason: "invalid", message: t("code.invalid") };
    }
    const args = {
      p_code: clean,
      p_mac: deviceMac(),
      p_name: deviceName(),
      p_ip: "",
      p_age: Math.max(0, Math.round(Number(options.requiredAge || 0))),
      p_silent: Boolean(options.silent),
    };
    if (options.link !== undefined) args.p_link = Boolean(options.link);
    let res;
    try {
      res = await rpc("code_use", args);
      // a database still on the earlier code_devices.sql has no p_link: ask that version
      if ((res.status === 404 || res.data?.code === "PGRST202") && "p_link" in args) {
        delete args.p_link;
        res = await rpc("code_use", args);
      }
    } catch {
      return { ok: false, reason: "error", message: t("code.error") };
    }
    if (res.status === 404 || res.data?.code === "PGRST202") return verifyCodeDirect(clean, options);
    const data = res.ok && res.data && typeof res.data === "object" ? res.data : null;
    if (!data) return { ok: false, reason: "error", message: t("code.error") };
    if (!data.ok) return codeFailure(data.reason, data, options, clean);
    // the gateway did not pass the address on: the browser looks it up itself
    if (!data.ip) {
      publicIp().then((ip) => {
        if (ip) rpc("code_use", { ...args, p_ip: ip, p_silent: true }).catch(() => {});
      });
    }
    return { ok: true, reason: "active", message: t("code.active"), row: data, linked: Boolean(data.linked), kept: data.kept !== false };
  }

  /* Wrong codes typed on this device: 3 in a row lock code entry for 24 hours
     (watch page, premium channels). localStorage: { fails, until }. */
  const CODE_LOCK_KEY = "cineaura_code_lockout";
  const CODE_FAIL_MAX = 3;
  const CODE_LOCK_MS = 24 * 60 * 60 * 1000;

  function readCodeLock() {
    try {
      const raw = JSON.parse(localStorage.getItem(CODE_LOCK_KEY) || "null");
      if (!raw || typeof raw !== "object") return { fails: 0, until: 0 };
      const until = Number(raw.until) || 0;
      if (until && until <= Date.now()) return { fails: 0, until: 0 };
      return { fails: Math.max(0, Number(raw.fails) || 0), until };
    } catch {
      return { fails: 0, until: 0 };
    }
  }

  function recordFailedCode() {
    const lock = readCodeLock();
    if (lock.until > Date.now()) return lock;
    lock.fails += 1;
    if (lock.fails >= CODE_FAIL_MAX) {
      lock.fails = CODE_FAIL_MAX;
      lock.until = Date.now() + CODE_LOCK_MS;
    }
    try {
      localStorage.setItem(CODE_LOCK_KEY, JSON.stringify(lock));
    } catch {
      /* storage blocked */
    }
    return lock;
  }

  function clearCodeLock() {
    try {
      localStorage.setItem(CODE_LOCK_KEY, JSON.stringify({ fails: 0, until: 0 }));
    } catch {
      /* storage blocked */
    }
  }

  const codeLockLeft = () => Math.max(0, readCodeLock().until - Date.now());

  /* ---------- Channel lists of the home page: two playlists in Supabase Storage ----------
     Free channels (Listchannels.html?free=1): IPTV-Free.m3u, played as they are.
     Premium channels (Listchannels.html?premium=1): IPTV-Premuim.m3u. Its links
     carry the words Username and Password (http://line.ottcst.net:80/Username/Password/1784957),
     replaced with the username and password of a premium IPTV account: typed on
     the page, or found with a watch code (sql/iptv_premium.sql). */
  const IPTV_LISTS = {
    free: { key: "free", name: "IPTV-Free", url: "https://mxdsgnlmfpaekgmswjou.supabase.co/storage/v1/object/public/IPTV/IPTV-Free.m3u" },
    premium: { key: "premium", name: "IPTV-Premium", url: "https://mxdsgnlmfpaekgmswjou.supabase.co/storage/v1/object/public/IPTV/IPTV-Premuim.m3u" },
  };

  const SLOT_USER = /^username$/i;
  const SLOT_PASS = /^password$/i;

  // Does this link wait for an account (Username / Password in its path or query)?
  function hasCredentialSlots(url) {
    try {
      const u = new URL(String(url || ""));
      return u.pathname.split("/").some((seg) => SLOT_USER.test(seg) || SLOT_PASS.test(seg)) ||
        [...u.searchParams.values()].some((v) => SLOT_USER.test(v) || SLOT_PASS.test(v));
    } catch {
      return /\/(username|password)(\/|$)/i.test(String(url || ""));
    }
  }

  // http://host:80/Username/Password/1784957 -> the account's own username and password
  // (path segments, and ?username=Username&password=Password on get.php links)
  function fillCredentials(url, user, pass) {
    const raw = String(url || "");
    if (!raw || !user) return raw;
    try {
      const u = new URL(raw);
      u.pathname = u.pathname
        .split("/")
        .map((seg) => (SLOT_USER.test(seg) ? encodeURIComponent(user) : SLOT_PASS.test(seg) ? encodeURIComponent(pass) : seg))
        .join("/");
      [...u.searchParams.entries()].forEach(([k, v]) => {
        if (SLOT_USER.test(v)) u.searchParams.set(k, user);
        else if (SLOT_PASS.test(v)) u.searchParams.set(k, pass);
      });
      return u.href;
    } catch {
      return raw.replace(/\/username\//gi, `/${encodeURIComponent(user)}/`).replace(/\/password\//gi, `/${encodeURIComponent(pass)}/`);
    }
  }

  // The account typed on the premium list: kept for this visit, and on this device with "Remember".
  const IPTV_LOGIN_KEY = "cineaura_iptv_login";

  function storedIptvLogin() {
    try {
      const raw = JSON.parse(localStorage.getItem(IPTV_LOGIN_KEY) || sessionStorage.getItem(IPTV_LOGIN_KEY) || "null");
      return raw && raw.user && raw.pass ? { user: String(raw.user), pass: String(raw.pass), remembered: Boolean(localStorage.getItem(IPTV_LOGIN_KEY)) } : null;
    } catch {
      return null;
    }
  }

  function storeIptvLogin(user, pass, remember) {
    try {
      const raw = JSON.stringify({ user, pass });
      sessionStorage.setItem(IPTV_LOGIN_KEY, raw);
      if (remember) localStorage.setItem(IPTV_LOGIN_KEY, raw);
      else localStorage.removeItem(IPTV_LOGIN_KEY);
    } catch {
      /* storage blocked: it works for this page */
    }
  }

  function forgetIptvLogin() {
    try {
      localStorage.removeItem(IPTV_LOGIN_KEY);
      sessionStorage.removeItem(IPTV_LOGIN_KEY);
    } catch {
      /* storage blocked */
    }
  }

  async function premiumCall(name, args) {
    let res;
    try {
      res = await rpc(name, args);
    } catch {
      return { ok: false, reason: "error" };
    }
    if (res.status === 404 || res.data?.code === "PGRST202") return { ok: false, reason: "setup" };
    return res.ok && res.data && typeof res.data === "object" ? res.data : { ok: false, reason: "error" };
  }

  // username + password of a premium IPTV account -> { ok, user, pass } | { ok: false, reason }
  const premiumLogin = (user, pass) =>
    premiumCall("iptv_premium_login", { p_user: String(user || "").trim(), p_pass: String(pass || "") });

  // a watch code (or, with none, the code linked to this device) -> the owner's premium account
  const premiumUnlock = ({ code = "", remember = false, silent = false } = {}) =>
    premiumCall("iptv_premium_unlock", {
      p_code: String(code || "").replace(/\D/g, ""),
      p_mac: deviceMac(),
      p_name: deviceName(),
      p_ip: "",
      p_silent: Boolean(silent),
      p_type: "web",
      p_remember: Boolean(remember),
    });

  // The message of a refused code on the premium list (the watch page's texts, plus its own).
  function premiumCodeMessage(data, code, silent = false) {
    const reason = data?.reason || "error";
    if (reason === "no_premium") return t("iptvp.noPremium");
    if (reason === "owner_banned") return t("iptvp.ownerBanned");
    if (reason === "setup") return t("iptvp.setup");
    return codeFailure(reason, data, { silent }, code).message;
  }

  // The code read straight from the table (a database without code_devices.sql).
  async function verifyCodeDirect(clean, options = {}) {
    const url = `${SUPABASE_URL}/rest/v1/codes?code=eq.${encodeURIComponent(clean)}&select=*`;
    let res;
    try {
      res = await fetch(url, {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Accept: "application/json",
        },
      });
    } catch {
      return { ok: false, reason: "error", message: t("code.error") };
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (err.code === "PGRST205") {
        return { ok: false, reason: "setup", message: t("code.setup") };
      }
      return { ok: false, reason: "error", message: t("code.error") };
    }

    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) {
      return codeFailure("not_found", null, options, clean);
    }

    const row = rows[0];
    let status = normalizeStatus(row.status);
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      status = "expired";
    }

    if (status === "active") {
      // The code works, but does it reach this title's age rating?
      const required = Number(options.requiredAge || 0);
      if (required > 0 && !ageGate(row.age_rating, required).allowed) {
        return codeFailure("age", row, options, clean);
      }
      return { ok: true, reason: "active", message: t("code.active"), row };
    }

    return codeFailure(status, row, options, clean);
  }

  function getStoredCode() {
    return localStorage.getItem(CODE_KEY) || "";
  }

  function setStoredCode(code) {
    localStorage.setItem(CODE_KEY, code);
  }

  function clearStoredCode() {
    localStorage.removeItem(CODE_KEY);
  }

  function profileHref(username) {
    const name = String(username || "").replace(/^@/, "").trim();
    return name ? `./Profile.html?@${encodeURIComponent(name)}` : "./Profile.html";
  }

  // A single post has its own link too: ./Profile.html?post=P123456789
  function postHref(postId) {
    const id = String(postId || "").trim();
    return id ? `./Profile.html?post=${encodeURIComponent(id)}` : "./Profile.html";
  }

  /* ---------- Sharing a CineAura link ----------
     Facebook · Pinterest · Telegram · WhatsApp · Reddit, plus copy.
     Every network needs an absolute URL, so a page-relative href ("./Profile.html?post=P1")
     is resolved against the current page first. */
  function absoluteUrl(href) {
    const raw = String(href || "");
    try {
      return new URL(raw, location.href).href;
    } catch {
      return `${location.origin}/${raw.replace(/^\/+/, "")}`;
    }
  }

  const SHARE_ICONS = {
    facebook: `<path d="M13.5 21v-7h2.4l.4-3h-2.8V9.1c0-.9.3-1.5 1.6-1.5h1.3V4.9c-.3 0-1.2-.1-2.2-.1-2.2 0-3.7 1.3-3.7 3.8V11H8v3h2.5v7z"/>`,
    pinterest: `<path d="M12 2a10 10 0 0 0-3.6 19.3c-.1-.8-.2-2 0-2.9l1.2-4.9s-.3-.6-.3-1.5c0-1.4.8-2.4 1.8-2.4.9 0 1.3.6 1.3 1.4 0 .9-.6 2.2-.9 3.4-.2 1 .5 1.8 1.5 1.8 1.8 0 3.2-1.9 3.2-4.6 0-2.4-1.7-4.1-4.2-4.1-2.9 0-4.5 2.1-4.5 4.3 0 .9.3 1.8.8 2.3l.1.4-.3 1.1c0 .2-.2.3-.4.2-1.3-.6-2.1-2.5-2.1-4 0-3.3 2.4-6.3 6.9-6.3 3.6 0 6.4 2.6 6.4 6 0 3.6-2.3 6.5-5.4 6.5-1.1 0-2.1-.6-2.4-1.2l-.7 2.5c-.2.9-.9 2-1.4 2.7A10 10 0 1 0 12 2z"/>`,
    telegram: `<path d="M21.9 4.3 18.8 19c-.2 1-.8 1.2-1.7.8l-4.6-3.4-2.2 2.1c-.3.3-.5.5-1 .5l.3-4.6L18 6.9c.4-.3-.1-.5-.6-.2L7.2 13.1l-4.5-1.4c-1-.3-1-1 .2-1.4l17.6-6.8c.8-.3 1.5.2 1.4.4z"/>`,
    whatsapp: `<path d="M12 2a10 10 0 0 0-8.6 15L2 22l5.2-1.4A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3.1.8.8-3-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.6-6.1c-.3-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.1-.2 0-.4.1-.5l.4-.5c.1-.2.1-.3 0-.5l-.7-1.7c-.2-.4-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3A2.9 2.9 0 0 0 6.8 10a5 5 0 0 0 1 2.6 11 11 0 0 0 4.3 3.8c1.6.6 2.2.7 3 .6a2.6 2.6 0 0 0 1.7-1.2 2.1 2.1 0 0 0 .2-1.2c-.1-.1-.3-.2-.6-.3z"/>`,
    reddit: `<path d="M22 12a2.1 2.1 0 0 0-3.6-1.5 10.6 10.6 0 0 0-5.8-1.8l1-4.6 3.2.7a1.5 1.5 0 1 0 .1-1l-3.7-.8a.5.5 0 0 0-.6.4l-1.1 5.3a10.6 10.6 0 0 0-5.9 1.8A2.1 2.1 0 1 0 4 14.2a4 4 0 0 0 0 .9c0 3.2 3.8 5.8 8.5 5.8s8.5-2.6 8.5-5.8a4 4 0 0 0 0-.9A2.1 2.1 0 0 0 22 12zM7.5 13.4a1.5 1.5 0 1 1 1.5 1.5 1.5 1.5 0 0 1-1.5-1.5zm8.9 4.4a6.4 6.4 0 0 1-4.4 1.4 6.4 6.4 0 0 1-4.4-1.4.5.5 0 0 1 .7-.7 5.5 5.5 0 0 0 3.7 1.1 5.5 5.5 0 0 0 3.7-1.1.5.5 0 0 1 .7.7zm-.5-2.9a1.5 1.5 0 1 1 1.5-1.5 1.5 1.5 0 0 1-1.5 1.5z"/>`,
    copy: `<path d="M9 9h9v11H9z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15 9V4H6v11h3" fill="none" stroke="currentColor" stroke-width="1.8"/>`,
  };

  function shareIcon(id) {
    return `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">${SHARE_ICONS[id] || ""}</svg>`;
  }

  const SHARE_NETWORKS = [
    { id: "facebook", labelKey: "share.facebook", href: (url) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}` },
    { id: "pinterest", labelKey: "share.pinterest", href: (url, text) => `https://www.pinterest.com/pin/create/button/?url=${encodeURIComponent(url)}&description=${encodeURIComponent(text)}` },
    { id: "telegram", labelKey: "share.telegram", href: (url, text) => `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}` },
    { id: "whatsapp", labelKey: "share.whatsapp", href: (url, text) => `https://api.whatsapp.com/send?text=${encodeURIComponent(`${text} ${url}`.trim())}` },
    { id: "reddit", labelKey: "share.reddit", href: (url, text) => `https://www.reddit.com/submit?url=${encodeURIComponent(url)}&title=${encodeURIComponent(text)}` },
  ];

  // One entry per network: the absolute CineAura link and where it is shared to.
  function shareTargets(href, text) {
    const url = absoluteUrl(href);
    const caption = String(text || "").trim() || url;
    return SHARE_NETWORKS.map((n) => ({
      id: n.id,
      label: t(n.labelKey),
      target: url,
      url: n.href(url, caption),
    }));
  }

  function referralShareUrl(href, postId, referrerId) {
    const url = new URL(absoluteUrl(href));
    if (validReferralMemberId(referrerId) && validReferralPostId(postId)) {
      url.searchParams.set("ca_ref", referrerId);
      url.searchParams.set("ca_post", postId);
    }
    return url.href;
  }

  // Markup for one share row. Tracked post links carry referral attribution;
  // a share is only credited after a new visitor completes registration.
  function shareRowHtml(href, text, opts = {}) {
    const session = getSession();
    const url = opts.track && session?.member_id
      ? referralShareUrl(href, opts.track, session.member_id)
      : absoluteUrl(href);
    const label = opts.label === false ? "" : escapeHtml(opts.label || t("share.title"));
    return `<div class="share-row${opts.compact ? " share-row--compact" : ""}">
      ${label ? `<span class="share-label">${label}</span>` : ""}
      <div class="share-btns">
        ${shareTargets(url, text)
          .map(
            (n) =>
              `<a class="share-btn share-${n.id}" href="${escapeHtml(n.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(n.label)}" aria-label="${escapeHtml(n.label)}">${shareIcon(n.id)}</a>`
          )
          .join("")}
        <button class="share-btn share-copy" type="button" data-share-copy="${escapeHtml(url)}" title="${escapeHtml(t("share.copy"))}" aria-label="${escapeHtml(t("share.copy"))}">${shareIcon("copy")}</button>
      </div>
    </div>`;
  }

  // Copy also works where the async clipboard API is unavailable (http, older
  // browsers), so the button never silently does nothing.
  async function copyText(value) {
    const text = String(value || "");
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* fall through to the textarea path */
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  // One delegated listener serves every share row on every page.
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest?.("[data-share-copy]");
    if (!btn) return;
    const ok = await copyText(btn.dataset.shareCopy);
    toast(ok ? t("share.copied") : t("share.copyFail"));
  });

  /* ---------- Post analytics: impressions · link clicks · referrals ----------
     Impressions and post clicks are client-side events. A share conversion is
     written by the registration trigger only after a new member signs up via a
     shared post link; clicking Share or Copy never increments it. */
  const ANALYTICS_KINDS = ["impression", "click"];
  const impressionSeen = new Set();
  let impressionQueue = [];
  let impressionTimer = null;
  let impressionObserver = null;

  function eventRow(postId, kind, extra = {}) {
    const session = getSession();
    return {
      post_id: String(postId || ""),
      owner_id: String(extra.ownerId || ""),
      kind,
      network: String(extra.network || ""),
      member_id: String(session?.member_id || ""),
      username: String(session?.username || ""),
    };
  }

  // One insert per event.
  function trackPostEvent(postId, kind, extra = {}) {
    if (!postId || !ANALYTICS_KINDS.includes(kind)) return Promise.resolve(false);
    return supabaseRequest("/rest/v1/post_events", {
      method: "POST",
      body: JSON.stringify(eventRow(postId, kind, extra)),
    })
      .then((r) => Boolean(r.ok))
      .catch(() => false);
  }

  // Impressions go out as one batch: a wall of cards is a single insert.
  function flushImpressions() {
    impressionTimer = null;
    if (!impressionQueue.length) return Promise.resolve(false);
    const rows = impressionQueue;
    impressionQueue = [];
    return supabaseRequest("/rest/v1/post_events", {
      method: "POST",
      body: JSON.stringify(rows),
    })
      .then((r) => Boolean(r.ok))
      .catch(() => false);
  }

  function queueImpression(card) {
    const postId = card?.dataset?.post;
    if (!postId || impressionSeen.has(postId)) return;
    impressionSeen.add(postId);
    impressionQueue.push(eventRow(postId, "impression", { ownerId: card.dataset.owner || "" }));
    clearTimeout(impressionTimer);
    impressionTimer = setTimeout(flushImpressions, 400);
  }

  // One impression per post card the viewer actually sees, counted once per page
  // (a reload is a new impression). Without an IntersectionObserver every drawn
  // card counts.
  function trackImpressions(container, posts) {
    const root = container || document;
    const wanted = new Set((posts || []).map((p) => String(p?.post_id || "")).filter(Boolean));
    const cards = [...root.querySelectorAll(".post-card[data-post]")].filter(
      (c) => !wanted.size || wanted.has(c.dataset.post)
    );
    if (!cards.length) return;
    if (typeof IntersectionObserver !== "function") {
      cards.forEach(queueImpression);
      return;
    }
    impressionObserver =
      impressionObserver ||
      new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            impressionObserver.unobserve(entry.target);
            queueImpression(entry.target);
          });
        },
        { rootMargin: "120px" }
      );
    cards.forEach((c) => impressionObserver.observe(c));
  }

  // Link clicks on a post card are tracked here. Sharing itself is not a
  // completion: referral progress is recorded after a visitor registers.
  document.addEventListener("click", (e) => {
    const card = e.target.closest?.(".post-card[data-post]");
    if (!card) return;
    const link = e.target.closest("a[href]");
    if (!link || link.closest(".post-share")) return;
    // Only the links the post itself carries: a title it recommends, or the
    // playlist it points to.
    const href = link.getAttribute("href") || "";
    if (!/watch\.html|Playlist\.html/i.test(href)) return;
    trackPostEvent(card.dataset.post, "click", { ownerId: card.dataset.owner || "" });
  });

  function wireSessionNav() {
    const session = getSession();
    if (!session?.username) return;
    const href = profileHref(session.username);
    const fallback = session?.full_name || session?.username || "CA";
    const inject = (root, asButton) => {
      if (!root) return;
      let link = root.querySelector("[data-nav-profile]");
      if (!link) {
        link = document.createElement("a");
        link.dataset.navProfile = "1";
        if (asButton) {
          // Header: the member's picture is the profile button.
          link.className = "nav-avatar";
          link.innerHTML = avatarImg(session?.member_id, session?.username, fallback);
        }
        const dash = root.querySelector('a[href="./dashboard.html"], a[href="./dashboard.html"]');
        if (dash) dash.insertAdjacentElement("beforebegin", link);
        else root.insertBefore(link, root.firstChild);
      }
      link.href = href;
      if (asButton) {
        link.setAttribute("aria-label", t("nav.profile"));
        link.setAttribute("title", t("nav.profile"));
        const img = link.querySelector("img");
        if (img) {
          img.dataset.avatarFor = session?.member_id || "";
          img.dataset.avatarName = String(session?.username || "").replace(/^@/, "");
          img.alt = t("nav.profile");
          img.src = avatarSrc(session?.member_id, session?.username, fallback);
        }
        // Swap the initials for the stored picture once profiles arrive.
        hydrateAvatars(link);
      } else {
        link.textContent = t("nav.profile");
      }
    };
    $$("#auth-user, .auth-user").forEach((el) => inject(el, true));
    $$(".mobile-auth-user").forEach((el) => inject(el, false));
  }

  /* ---------- Notifications: shared by the header bell and notifications.html ---------- */
  const NOTES_PAGE = "./notifications.html";

  // The title follows the reader's language. The sender's page stored it in the
  // sender's language, so the kinds the site creates use their own interface
  // text; anything else shows the stored title (translated when it is English).
  const NOTE_TITLES = {
    follow: "prof.reqTitle",
    recommend: "prof.recAcc",
    vote_up: "prof.notifVote",
    vote_down: "prof.notifVote",
    post: "prof.newPost",
    message: "prof.newMsg",
    iptv: "notif.iptv",
    iptv_renew: "notif.iptvRenew",
    // the review of a prize claim (sql/prize_claims.sql)
    prize_claim_review: "notif.claimReview",
    prize_claim_accepted: "notif.claimAccepted",
    prize_claim_rejected: "notif.claimRejected",
    prize_claim_unblocked: "notif.claimUnblocked",
    // a watched minute took the member to a new level (sql/point_levels.sql); the body is "LV2 · ×2"
    points_level: "notif.levelUp",
    // a points code was used (sql/point_codes.sql); the body is "+500"
    points_code: "notif.pointsCode",
    // videos (sql/content.sql): a followed member published one; somebody commented on yours
    content: "notif.newVideo",
    content_comment: "notif.videoComment",
  };

  function noteTitle(n) {
    const kind = String(n?.kind || "");
    if (NOTE_TITLES[kind]) return t(NOTE_TITLES[kind]);
    return tr(n?.title || kind);
  }

  // Anyone can insert a notification, so its link is checked: only web links,
  // never javascript: or data: URLs.
  function noteHref(n) {
    const raw = String(n?.href || "").trim();
    if (raw) {
      try {
        const url = new URL(raw, location.href);
        if (url.protocol === "http:" || url.protocol === "https:") return raw;
      } catch {
        /* not a link */
      }
    }
    return "./Profile.html";
  }

  function dateFormat(options) {
    try {
      return new Intl.DateTimeFormat(getLocale(), { ...options, numberingSystem: "latn" });
    } catch {
      return new Intl.DateTimeFormat(undefined, options);
    }
  }

  // When a notification arrived, in the reader's language and local time:
  // "now", "5 minutes ago", "3 hours ago" today; the weekday and time during the
  // last 7 days; the date and time this year; the date before that.
  function noteWhen(value, now = new Date()) {
    const d = new Date(value);
    if (!value || Number.isNaN(d.getTime())) return "";
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diff = now.getTime() - d.getTime();
    if (d >= today || diff < 60000) {
      const mins = Math.max(0, Math.floor(diff / 60000));
      try {
        const rtf = new Intl.RelativeTimeFormat(`${getLocale()}-u-nu-latn`, { numeric: "auto" });
        if (mins < 1) return rtf.format(0, "second");
        return mins < 60 ? rtf.format(-mins, "minute") : rtf.format(-Math.floor(mins / 60), "hour");
      } catch {
        return dateFormat({ hour: "numeric", minute: "2-digit" }).format(d);
      }
    }
    const weekAgo = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
    if (d >= weekAgo) return dateFormat({ weekday: "long", hour: "numeric", minute: "2-digit" }).format(d);
    if (d.getFullYear() === now.getFullYear()) {
      return dateFormat({ day: "numeric", month: "long", hour: "numeric", minute: "2-digit" }).format(d);
    }
    return dateFormat({ day: "numeric", month: "long", year: "numeric" }).format(d);
  }

  // Notification text as HTML, isolated from the page direction: an English
  // line keeps its order in an Arabic page ("@ali: hello?" never turns into
  // "?ali: hello@"), and every @username stays in one piece.
  function noteTextHtml(text) {
    const html = escapeHtml(text).replace(/@[A-Za-z0-9_](?:[A-Za-z0-9._]*[A-Za-z0-9_])?/g, (m) => `<bdi>${m}</bdi>`);
    return `<bdi>${html}</bdi>`;
  }

  // The full local date and time, for a tooltip.
  function noteFullDate(value) {
    const d = new Date(value);
    if (!value || Number.isNaN(d.getTime())) return "";
    try {
      return dateFormat({ dateStyle: "full", timeStyle: "short" }).format(d);
    } catch {
      return d.toLocaleString();
    }
  }

  // Marks notifications of the signed-in member as read: one request per 100
  // notifications instead of one per row. The bell hears about it too.
  async function markNotesRead(ids) {
    const me = getSession()?.member_id;
    const list = [...new Set((ids || []).map((id) => String(id ?? "")).filter((id) => /^\d+$/.test(id)))];
    if (!me || !list.length) return true;
    document.dispatchEvent(new CustomEvent("cineaura:notes-read", { detail: { ids: list } }));
    let ok = true;
    for (let i = 0; i < list.length; i += 100) {
      try {
        const res = await supabaseRequest(
          `/rest/v1/notifications?member_id=eq.${restValue(me)}&id=in.(${list.slice(i, i + 100).join(",")})`,
          { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ read: true }) }
        );
        ok = ok && res.ok;
      } catch {
        ok = false;
      }
    }
    return ok;
  }

  /* ---------- Header Bell Notifications ---------- */
  function initHeaderBell() {
    const bellBtn = $("#header-bell-btn");
    const bellDot = $("#header-bell-dot");
    const bellPanel = $("#header-bell-panel");
    if (!bellBtn || !bellPanel) return;

    let notes = [];
    const syncDot = () => {
      if (bellDot) bellDot.hidden = !notes.some((n) => !n.read);
    };

    function paint() {
      const rows = notes.length
        ? notes
            .map((n) => {
              const when = noteWhen(n.created_at);
              const time = when
                ? `<time datetime="${escapeHtml(n.created_at)}" title="${escapeHtml(noteFullDate(n.created_at))}">${escapeHtml(when)}</time>`
                : "";
              return `
          <a class="hnote-row" href="${escapeHtml(noteHref(n))}" data-note="${escapeHtml(n.id)}">
            <div class="hnote-dot ${n.read ? "read" : ""}"></div>
            <div>
              <strong>${noteTextHtml(noteTitle(n) || t("prof.notif"))}</strong>
              <div class="hnote-sub">${n.body ? noteTextHtml(n.body) : ""}${n.body && time ? " · " : ""}${time}</div>
            </div>
          </a>`;
            })
            .join("")
        : `<p class="hnote-empty">${escapeHtml(t("prof.noNotes"))}</p>`;
      bellPanel.innerHTML = `
        <div class="hnote-head"><strong>${escapeHtml(t("prof.notif"))}</strong></div>
        <div class="hnote-list">${rows}</div>
        <div class="hnote-foot"><a class="hnote-all" href="${NOTES_PAGE}">${escapeHtml(t("notes.viewAll"))}</a></div>`;
    }

    bellBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !bellPanel.hidden;
      bellPanel.hidden = open;
      if (open) return;
      paint();
      // opening the bell marks what it shows as read
      const unread = notes.filter((n) => !n.read);
      unread.forEach((n) => {
        n.read = true;
      });
      syncDot();
      markNotesRead(unread.map((n) => n.id));
    });

    document.addEventListener("click", (e) => {
      if (!bellPanel.hidden && !e.target.closest(".header-bell-wrap")) {
        bellPanel.hidden = true;
      }
    });

    // notifications.html marked some as read
    document.addEventListener("cineaura:notes-read", (e) => {
      const ids = new Set((e.detail?.ids || []).map(String));
      notes.forEach((n) => {
        if (ids.has(String(n.id))) n.read = true;
      });
      syncDot();
    });

    async function poll() {
      const sess = getSession();
      if (!sess?.member_id) return;
      try {
        const res = await supabaseRequest(
          `/rest/v1/notifications?member_id=eq.${restValue(sess.member_id)}&select=*&order=created_at.desc&limit=30`
        );
        if (!res.ok || !Array.isArray(res.data)) return;
        notes = res.data;
        syncDot();
        // notifications.html follows the bell to show new notifications
        document.dispatchEvent(new CustomEvent("cineaura:notes", { detail: { notes } }));
      } catch { /* offline */ }
    }

    poll();
    setInterval(poll, 30000);
  }

  /* ---------- Section badges for profile page ---------- */
  function pollSectionBadges() {
    async function check() {
      const sess = getSession();
      if (!sess?.member_id) return;
      try {
        const [msgRes, followRes] = await Promise.all([
          supabaseRequest(`/rest/v1/messages?receiver_id=eq.${restValue(sess.member_id)}&read=eq.false&select=id`),
          supabaseRequest(`/rest/v1/follows?following_id=eq.${restValue(sess.member_id)}&status=eq.pending&select=id`),
        ]);
        const unreadMsgs = msgRes.ok && Array.isArray(msgRes.data) ? msgRes.data.length : 0;
        const pendingFollows = followRes.ok && Array.isArray(followRes.data) ? followRes.data.length : 0;
        // update profile sidebar buttons
        document.querySelectorAll('[data-sec="messages"]').forEach((btn) => {
          let badge = btn.querySelector(".sec-badge");
          if (unreadMsgs > 0) {
            if (!badge) { badge = document.createElement("span"); badge.className = "sec-badge"; btn.appendChild(badge); }
            badge.textContent = unreadMsgs;
          } else if (badge) {
            badge.remove();
          }
        });
        document.querySelectorAll('[data-sec="following"]').forEach((btn) => {
          let badge = btn.querySelector(".sec-badge");
          if (pendingFollows > 0) {
            if (!badge) { badge = document.createElement("span"); badge.className = "sec-badge"; btn.appendChild(badge); }
            badge.textContent = pendingFollows;
          } else if (badge) {
            badge.remove();
          }
        });
      } catch { /* offline */ }
    }
    check();
    setInterval(check, 20000);
    // re-check when profile sections change
    document.addEventListener("click", (e) => {
      if (e.target.closest("[data-sec]")) setTimeout(check, 500);
    });
  }

  // Ads: guests never see them. Free members always do. Premium members (an active Silver /
  // Gold / Diamond plan) see them too, unless they switch on "Watch without ads" in
  // Site Settings — and while that option is on, their watch minutes are not counted.
  // A paid plan that has expired counts as Free. The plan is cached per member for the page.
  // Set to false to give premium members ad-free viewing by default again (then the
  // option only decides whether minutes are counted).
  const PREMIUM_ADS_BY_DEFAULT = true;
  const membershipCache = {};
  // A members row on a paid plan that hasn't ended.
  function planIsPremium(row) {
    if (!row) return false;
    const paid = ["Silver", "Gold", "Diamond"].includes(row.membership_type);
    const active = !row.membership_expires_at || new Date(row.membership_expires_at).getTime() > Date.now();
    return paid && active;
  }
  function membership() {
    const session = getSession();
    if (!session?.member_id) return Promise.resolve({ guest: true, premium: false });
    const id = session.member_id;
    if (!membershipCache[id]) {
      membershipCache[id] = supabaseRequest(
        `/rest/v1/members?member_id=eq.${restValue(id)}&select=membership_type,membership_expires_at`
      )
        .then((res) => {
          const row = res.ok ? res.data?.[0] : null;
          if (!row) return { guest: false, premium: false, unknown: true };
          return { guest: false, premium: planIsPremium(row), type: row.membership_type };
        })
        .catch(() => ({ guest: false, premium: false, unknown: true }));
    }
    return membershipCache[id];
  }

  const adFreeKey = (id) => `cineaura_adfree_${id}`;
  function adFreeFlag() {
    const id = getSession()?.member_id;
    if (!id) return false;
    try {
      return localStorage.getItem(adFreeKey(id)) === "1";
    } catch {
      return false;
    }
  }
  function setAdFreeFlag(on) {
    const id = getSession()?.member_id;
    if (!id) return;
    try {
      localStorage.setItem(adFreeKey(id), on ? "1" : "0");
    } catch {
      /* private mode: the choice lasts for this page only */
    }
    document.dispatchEvent(new CustomEvent("cineaura:adfree", { detail: { on } }));
  }
  // True only for an active premium member who switched "Watch without ads" on.
  async function adFreeActive() {
    if (!adFreeFlag()) return false;
    const m = await membership();
    return Boolean(m.premium);
  }
  async function adsEligible() {
    const m = await membership();
    if (m.guest || m.unknown) return false; // cannot check the plan → no ads
    if (!m.premium) return true;
    return PREMIUM_ADS_BY_DEFAULT && !adFreeFlag();
  }

  // ---------- Site Settings (header button → dialog) ----------
  // Language, country (both detected from the visitor's IP until they choose), appearance
  // (dark / light) and, for premium members, "Watch without ads".
  const LANG_NAMES = { en: "English", ar: "العربية", fr: "Français", de: "Deutsch", es: "Español", nl: "Nederlands", it: "Italiano" };
  const COUNTRY_KEY = "cineaura_country"; // stored only when the visitor picks a country
  const GEO_KEY = "cineaura_geo"; // cached IP lookup: { cc, ts } — the IP itself is never stored
  const GEO_TTL = 24 * 60 * 60 * 1000;
  const COUNTRY_CODES =
    "AD AE AF AG AI AL AM AO AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW".split(" ");

  function readGeo() {
    try {
      const g = JSON.parse(localStorage.getItem(GEO_KEY) || "null");
      return g && /^[A-Z]{2}$/.test(g.cc) ? g : null;
    } catch {
      return null;
    }
  }

  async function fetchGeoCountry() {
    const readers = [
      ["https://ipwho.is/", (j) => (j.success === false ? "" : j.country_code)],
      ["https://api.country.is/", (j) => j.country],
      ["https://ipapi.co/json/", (j) => j.country_code],
    ];
    for (const [url, read] of readers) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 4500);
      try {
        const r = await fetch(url, { cache: "no-store", signal: ctl.signal });
        if (!r.ok) continue;
        const cc = String(read(await r.json()) || "").toUpperCase();
        if (/^[A-Z]{2}$/.test(cc)) return cc;
      } catch {
        /* try the next service */
      } finally {
        clearTimeout(timer);
      }
    }
    return "";
  }

  let geoPromise = null;
  function detectGeo(force = false) {
    const cached = readGeo();
    if (!force && cached && Date.now() - cached.ts < GEO_TTL) return Promise.resolve(cached.cc);
    if (geoPromise) return geoPromise;
    geoPromise = fetchGeoCountry()
      .then((cc) => {
        if (cc) {
          try {
            localStorage.setItem(GEO_KEY, JSON.stringify({ cc, ts: Date.now() }));
          } catch {
            /* storage unavailable */
          }
        }
        return cc || cached?.cc || "";
      })
      .finally(() => {
        geoPromise = null;
      });
    return geoPromise;
  }

  const manualLang = () => LANGS.includes(localStorage.getItem(LANG_KEY));
  const manualCountry = () => {
    const c = localStorage.getItem(COUNTRY_KEY);
    return /^[A-Z]{2}$/.test(c || "") ? c : "";
  };
  const currentCountry = () => manualCountry() || readGeo()?.cc || "";
  const geoLang = (cc) => {
    const l = window.CineAuraCountryLang?.[cc];
    return LANGS.includes(l) ? l : "";
  };

  // First visit: follow the IP. A language or country picked by the visitor always wins.
  async function geoBoot() {
    const cc = await detectGeo(false);
    if (!cc) return;
    if (!manualLang()) {
      const lang = geoLang(cc);
      if (lang && lang !== getLang() && !accountLangApplied) applyPrefs({ language: lang, persist: false });
    }
    document.dispatchEvent(new CustomEvent("cineaura:geo", { detail: { country: currentCountry() } }));
  }

  // The country of the content (watch providers, prices…): "" follows the IP.
  // Guests pick it in Site Settings, members in Dashboard > Settings.
  function setSiteCountry(cc) {
    try {
      if (/^[A-Z]{2}$/.test(cc || "")) localStorage.setItem(COUNTRY_KEY, cc);
      else localStorage.removeItem(COUNTRY_KEY);
    } catch {
      /* storage unavailable */
    }
    document.dispatchEvent(new CustomEvent("cineaura:geo", { detail: { country: currentCountry() } }));
  }

  function countryChoices() {
    return COUNTRY_CODES.map((cc) => [cc, countryName(cc)])
      .filter(([, n]) => n)
      .sort((a, b) => a[1].localeCompare(b[1], getLocale()));
  }

  function countryName(cc) {
    try {
      const n = new Intl.DisplayNames([getLocale()], { type: "region" }).of(cc);
      return n && n !== cc ? n : "";
    } catch {
      return "";
    }
  }

  let settingsApi = null;
  function buildSettings() {
    const overlay = document.createElement("div");
    overlay.className = "sset-overlay";
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="sset-card" role="dialog" aria-modal="true" aria-labelledby="sset-title" tabindex="-1">
        <div class="sset-head">
          <h2 id="sset-title" data-i18n="set.title">Site Settings</h2>
          <button class="sset-x" type="button" data-i18n-aria="set.close" aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>
        <div class="sset-body">
          <div class="sset-row">
            <label for="sset-lang" data-i18n="set.language">Site language</label>
            <select id="sset-lang">${LANGS.map((c) => `<option value="${c}" lang="${c}">${LANG_NAMES[c] || c}</option>`).join("")}</select>
          </div>
          <div class="sset-row">
            <label for="sset-country" data-i18n="set.country">Country</label>
            <select id="sset-country"></select>
            <p class="sset-hint" id="sset-geo-hint" aria-live="polite"></p>
            <button class="sset-link" id="sset-redetect" type="button" data-i18n="set.detect">Detect automatically from my IP</button>
          </div>
          <div class="sset-row">
            <span class="sset-lbl" id="sset-theme-lbl" data-i18n="set.theme">Appearance</span>
            <div class="sset-seg" role="radiogroup" aria-labelledby="sset-theme-lbl">
              <button type="button" role="radio" data-theme-pick="night" data-i18n="set.dark">Dark</button>
              <button type="button" role="radio" data-theme-pick="day" data-i18n="set.light">Light</button>
            </div>
          </div>
          <div class="sset-row sset-adfree">
            <div class="sset-switch-line">
              <div class="sset-switch-text">
                <span class="sset-lbl" id="sset-adfree-lbl" data-i18n="set.adfree">Watch without ads</span>
                <p class="sset-hint" data-i18n="set.adfreeP">When on, no ads are shown and your watch minutes are not counted.</p>
                <p class="sset-hint sset-state" id="sset-adfree-state"></p>
              </div>
              <label class="sset-switch">
                <input type="checkbox" id="sset-adfree" role="switch" aria-labelledby="sset-adfree-lbl" disabled />
                <span class="sset-track" aria-hidden="true"></span>
              </label>
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const card = overlay.querySelector(".sset-card");
    const langSel = overlay.querySelector("#sset-lang");
    const countrySel = overlay.querySelector("#sset-country");
    const geoHint = overlay.querySelector("#sset-geo-hint");
    const adBox = overlay.querySelector("#sset-adfree");
    const adState = overlay.querySelector("#sset-adfree-state");
    let lastFocus = null;
    let detecting = false;

    function fillCountries() {
      const cur = currentCountry();
      const rows = countryChoices();
      countrySel.innerHTML =
        `<option value="">${escapeHtml(t("set.countryNone"))}</option>` +
        rows.map(([cc, n]) => `<option value="${cc}">${escapeHtml(n)}</option>`).join("");
      countrySel.value = cur;
    }

    function syncGeoHint() {
      if (detecting) geoHint.textContent = t("set.detecting");
      else if (manualCountry()) geoHint.textContent = t("set.countryManual");
      else if (readGeo()) geoHint.textContent = t("set.countryAuto");
      else geoHint.textContent = t("set.countryFail");
    }

    async function syncAdFree() {
      adBox.disabled = true;
      adBox.checked = false;
      adState.textContent = "";
      const session = getSession();
      if (!session?.member_id) {
        adState.innerHTML = `<a href="./login.html">${escapeHtml(t("set.adfreeGuest"))}</a>`;
        return;
      }
      const m = await membership();
      if (getSession()?.member_id !== session.member_id) return;
      if (m.premium) {
        adBox.disabled = false;
        adBox.checked = adFreeFlag();
        adState.textContent = "";
      } else {
        adState.innerHTML = `${escapeHtml(t("set.adfreeLocked"))} <a href="./#plans">${escapeHtml(t("set.seePlans"))}</a>`;
      }
    }

    function syncAll() {
      langSel.value = getLang();
      fillCountries();
      syncGeoHint();
      overlay.querySelectorAll("[data-theme-pick]").forEach((b) => {
        b.setAttribute("aria-checked", String(b.dataset.themePick === getTheme()));
      });
      translateDom(overlay);
      syncAdFree();
    }

    function patchProfile(body) {
      const s = getSession();
      if (!s?.member_id) return;
      // keep the account in step with the choice; a failed write is not fatal
      supabaseRequest(`/rest/v1/profiles?member_id=eq.${restValue(s.member_id)}`, {
        method: "PATCH",
        keepalive: true,
        body: JSON.stringify(body),
      }).catch(() => null);
    }

    function open() {
      lastFocus = document.activeElement;
      syncAll();
      overlay.hidden = false;
      document.documentElement.classList.add("sset-lock");
      document.querySelector(".settings-btn")?.setAttribute("aria-expanded", "true");
      card.focus();
      // refresh the IP result in the background (cached for a day)
      if (!readGeo()) {
        detecting = true;
        syncGeoHint();
        detectGeo(false).then(() => {
          detecting = false;
          if (!overlay.hidden) {
            fillCountries();
            syncGeoHint();
          }
        });
      }
    }

    function close() {
      if (overlay.hidden) return;
      overlay.hidden = true;
      document.documentElement.classList.remove("sset-lock");
      document.querySelector(".settings-btn")?.setAttribute("aria-expanded", "false");
      if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
    }

    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector(".sset-x").addEventListener("click", close);
    document.addEventListener("keydown", (e) => {
      if (overlay.hidden) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "Tab") {
        const f = [...card.querySelectorAll("button, select, input, a[href]")].filter((el) => !el.disabled && el.offsetParent !== null);
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === card)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });

    langSel.addEventListener("change", () => {
      applyPrefs({ language: langSel.value, persist: true });
      patchProfile({ language: langSel.value });
    });

    countrySel.addEventListener("change", () => {
      try {
        if (countrySel.value) localStorage.setItem(COUNTRY_KEY, countrySel.value);
        else localStorage.removeItem(COUNTRY_KEY);
      } catch {
        /* storage unavailable */
      }
      syncGeoHint();
      document.dispatchEvent(new CustomEvent("cineaura:geo", { detail: { country: currentCountry() } }));
    });

    overlay.querySelector("#sset-redetect").addEventListener("click", async () => {
      if (detecting) return;
      detecting = true;
      syncGeoHint();
      try {
        localStorage.removeItem(COUNTRY_KEY);
        localStorage.removeItem(LANG_KEY);
      } catch {
        /* storage unavailable */
      }
      const cc = await detectGeo(true);
      detecting = false;
      const lang = geoLang(cc) || browserLang();
      applyPrefs({ language: lang, persist: false });
      if (!cc) toast(t("set.countryFail"));
      document.dispatchEvent(new CustomEvent("cineaura:geo", { detail: { country: currentCountry() } }));
    });

    overlay.querySelectorAll("[data-theme-pick]").forEach((b) =>
      b.addEventListener("click", () => {
        applyPrefs({ theme: b.dataset.themePick, persist: true });
        patchProfile({ theme: b.dataset.themePick });
      })
    );

    adBox.addEventListener("change", async () => {
      const on = adBox.checked;
      // the plan is checked again here: the switch only works for an active premium member
      if (on && !(await membership()).premium) {
        adBox.checked = false;
        return;
      }
      setAdFreeFlag(on);
      if (on) window.CineAuraAds?.hide?.();
      toast(t(on ? "set.adfreeOn" : "set.adfreeOff"));
    });

    // keep the dialog in step with language / theme / geo changes made elsewhere
    document.addEventListener("cineaura:prefs", () => {
      if (!overlay.hidden) syncAll();
      else translateDom(overlay);
    });
    document.addEventListener("cineaura:geo", () => {
      if (!overlay.hidden) {
        fillCountries();
        syncGeoHint();
      }
    });

    return { open, close, overlay };
  }

  function openSettings() {
    if (!settingsApi) settingsApi = buildSettings();
    settingsApi.open();
  }

  function initSettingsMenu() {
    const inner = document.querySelector(".header-inner");
    if (!inner || inner.querySelector(".settings-btn")) return;
    inner.querySelector(".lang-switch")?.remove();
    const btn = document.createElement("button");
    btn.className = "settings-btn";
    btn.type = "button";
    btn.setAttribute("aria-haspopup", "dialog");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("data-i18n-aria", "set.title");
    btn.setAttribute("aria-label", "Site Settings");
    btn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      <span class="settings-label" data-i18n="set.title">Site Settings</span>`;
    inner.insertBefore(btn, inner.querySelector(".hamburger") || null);
    btn.addEventListener("click", openSettings);

    // The burger menu gets the same entry for phones and tablets.
    const menu = document.getElementById("mobile-menu");
    if (menu && !menu.querySelector("[data-open-settings]")) {
      const item = document.createElement("button");
      item.type = "button";
      item.setAttribute("data-open-settings", "");
      item.setAttribute("data-i18n", "set.title");
      item.textContent = "Site Settings";
      item.addEventListener("click", () => {
        menu.classList.remove("open");
        openSettings();
      });
      menu.appendChild(item);
    }
    translateDom(inner);
    if (menu) translateDom(menu);

    // Show the name next to the icon only while the header has room for it.
    let fitTimer = 0;
    const fit = () => {
      btn.classList.remove("compact");
      if (inner.scrollWidth > inner.clientWidth + 1) btn.classList.add("compact");
    };
    const refit = () => {
      clearTimeout(fitTimer);
      fitTimer = setTimeout(fit, 60);
    };
    window.addEventListener("resize", refit);
    document.addEventListener("cineaura:prefs", refit);
    document.fonts?.ready?.then(refit);
    refit();
  }

  // The member videos (Search.html, Content.html) get a place in the header menu of every
  // page, after Series, and in the phone menu.
  // "Videos" in every header: Content.html, the search box and the 50 videos with the
  // most watched minutes, recommendations or shares.
  function addVideosNav() {
    const here = /\/(search|content)(\.html)?$/i.test(location.pathname);
    const make = () => {
      const a = document.createElement("a");
      a.href = "./Content.html";
      a.dataset.i18n = "nav.videos";
      a.dataset.videosNav = "1";
      a.textContent = t("nav.videos");
      if (here) a.setAttribute("aria-current", "page");
      return a;
    };
    const nav = document.querySelector("#site-header nav.nav");
    if (nav && !nav.querySelector("[data-videos-nav]")) {
      const series = [...nav.querySelectorAll("a")].find((x) => /#series$/.test(x.getAttribute("href") || ""));
      if (series) series.after(make());
      else nav.appendChild(make());
    }
    const menu = document.querySelector("#mobile-menu");
    if (menu && !menu.querySelector("[data-videos-nav]")) {
      const series = [...menu.querySelectorAll(":scope > a")].find((x) => /#series$/.test(x.getAttribute("href") || ""));
      const auth = menu.querySelector(":scope > div");
      if (series) series.after(make());
      else if (auth) auth.before(make());
      else menu.appendChild(make());
    }
  }

  /* Links the staff set in Panel > Settings (sql/point_codes.sql, site_links):
       patreon_points  Dashboard > Points > Buy points
       patreon_plans   the premium codes of the activation page
     Read once per page; until the table exists (or while a link is empty) the
     Patreon home page is used. */
  const PATREON_DEFAULT = "https://www.patreon.com/";
  let siteLinksReq = null;
  async function siteLink(key, fallback = PATREON_DEFAULT) {
    siteLinksReq =
      siteLinksReq ||
      supabaseRequest("/rest/v1/site_links?select=key,url")
        .then((res) => (res.ok && Array.isArray(res.data) ? res.data : []))
        .catch(() => []);
    const rows = await siteLinksReq;
    const url = String(rows.find((r) => r.key === key)?.url || "").trim();
    return /^https:\/\/[^\s<>"'`]+$/i.test(url) ? url : fallback;
  }

  /* ---------- Activation deadline (sql/account_deadline.sql) ----------
     An account that is not activated within 30 days of signing up, or not
     re-activated within 30 days after its membership ends, is fully banned.
     account_check() applies a ban whose day has passed and says what is left to
     do: need = "activate" | "renew" (with due_at, the day of the ban) or nothing.
     The answer is kept for 10 minutes in this tab. Without the SQL: null. */
  const ACCT_KEY = "cineaura_acct_check";
  const ACCT_HIDE_KEY = "cineaura_acct_hide";
  async function accountCheck({ fresh = false } = {}) {
    const s = getSession();
    if (!s?.member_id) return null;
    if (!fresh) {
      try {
        const hit = JSON.parse(sessionStorage.getItem(ACCT_KEY) || "null");
        if (hit && hit.id === s.member_id && Date.now() - hit.at < 10 * 60 * 1000) return hit.data;
      } catch {
        /* checked again */
      }
    }
    let res;
    try {
      res = await rpc("account_check", { p_member: s.member_id });
    } catch {
      return null;
    }
    if (!res.ok || !res.data || res.data.ok === false) return null;
    try {
      sessionStorage.setItem(ACCT_KEY, JSON.stringify({ id: s.member_id, at: Date.now(), data: res.data }));
    } catch {
      /* asked again on the next page */
    }
    return res.data;
  }

  // "3 days left" / "less than a day left", in the reader's language
  function accountLeftText(dueAt) {
    const ms = Date.parse(dueAt || "") - Date.now();
    if (!Number.isFinite(ms)) return "";
    if (ms < 86400000) return t("acct.leftHours");
    const days = Math.ceil(ms / 86400000);
    let time;
    try {
      time = new Intl.NumberFormat(getLocale(), { style: "unit", unit: "day", unitDisplay: "long", numberingSystem: "latn" }).format(days);
    } catch {
      time = `${days} days`;
    }
    return t("acct.left", { time });
  }

  function accountDateText(value) {
    const d = new Date(value || "");
    if (Number.isNaN(d.getTime())) return "";
    return dateFormat({ day: "numeric", month: "long", year: "numeric" }).format(d);
  }

  // The sentence for a countdown: "gate" = the dashboard / activation page wording,
  // "bar" = the banner of the other pages. "" when nothing is due.
  function accountDeadlineText(info, kind = "bar") {
    if (!info?.need || !info.due_at) return "";
    const vars = {
      date: escapeHtml(accountDateText(info.due_at)),
      left: escapeHtml(accountLeftText(info.due_at)),
      end: escapeHtml(accountDateText(info.expires_at)),
    };
    return t(`acct.${kind}.${info.need === "activate" ? "activate" : "renew"}`, vars);
  }

  // Why the rule banned an account (login page, dashboard, activation page); "" otherwise.
  function accountBanText(reason) {
    return reason === "not_activated" || reason === "not_renewed" ? t(`acct.banned.${reason}`) : "";
  }

  // The banner: at the bottom of every page of a signed-in member whose countdown runs
  // (the activation page shows it in its own card). "Hide" keeps it away for this tab.
  async function showAccountDeadline() {
    if (/\/activate(\.html)?$/i.test(location.pathname)) return;
    const info = await accountCheck();
    document.getElementById("acct-due")?.remove();
    if (!info) return;
    let text = "";
    let action = "";
    let kind = "warn";
    if (info.status === "banned" && accountBanText(info.ban_reason)) {
      text = escapeHtml(accountBanText(info.ban_reason));
      action = `<button class="btn btn-sm btn-danger" type="button" data-acct-logout>${escapeHtml(t("nav.logout"))}</button>`;
      kind = "banned";
    } else if (info.need && info.due_at) {
      try {
        if (sessionStorage.getItem(ACCT_HIDE_KEY) === String(info.due_at)) return;
      } catch {
        /* shown */
      }
      text = accountDeadlineText(info, "bar");
      action = `<a class="btn btn-sm btn-primary" href="./activate.html">${escapeHtml(t(info.need === "activate" ? "acct.btn.activate" : "acct.btn.renew"))}</a>`;
    }
    // a page that already shows the date in its own card (dashboard gate) needs no banner
    if (!text || document.querySelector(".acct-gate-due")) return;
    const bar = document.createElement("div");
    bar.id = "acct-due";
    bar.className = `acct-due is-${kind}`;
    bar.setAttribute("role", kind === "banned" ? "alert" : "status");
    bar.innerHTML = `
      <span class="acct-due-ico" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.5v.01"/></svg></span>
      <p class="acct-due-txt">${text}</p>
      <span class="acct-due-acts">${action}${kind === "banned" ? "" : `<button class="acct-due-x" type="button" data-acct-hide aria-label="${escapeHtml(t("acct.hide"))}" title="${escapeHtml(t("acct.hide"))}">×</button>`}</span>`;
    bar.addEventListener("click", (e) => {
      if (e.target.closest("[data-acct-logout]")) logout();
      if (e.target.closest("[data-acct-hide]")) {
        try {
          sessionStorage.setItem(ACCT_HIDE_KEY, String(info.due_at));
        } catch {
          /* hidden for this page */
        }
        bar.remove();
      }
    });
    document.body.appendChild(bar);
  }

  function setupChrome() {
    applyPrefs({ persist: false });
    initSettingsMenu();
    geoBoot();
    startPresence();
    renderAuth();
    // No session on a page that needs one: lock it before any handler is bound.
    syncAuthGate();
    watchSessionLock();
    wireSessionNav();
    initHeaderBell();
    pollSectionBadges();
    hydratePrefsFromProfile();
    addVideosNav();
    showAccountDeadline().catch(() => {});
    const header = $("#site-header");
    if (header) {
      const onScroll = () => header.classList.toggle("scrolled", window.scrollY > 8);
      onScroll();
      window.addEventListener("scroll", onScroll, { passive: true });
    }

    const hamburger = $("#hamburger");
    const menu = $("#mobile-menu");
    hamburger?.addEventListener("click", () => {
      const open = !menu.classList.contains("open");
      menu.classList.toggle("open", open);
      document.body.classList.toggle("menu-open", open);
    });
    menu?.addEventListener("click", (e) => {
      if (e.target.closest("a")) {
        menu.classList.remove("open");
        document.body.classList.remove("menu-open");
      }
      if (e.target.closest("[data-logout]")) logout();
    });
    $("#logout-btn")?.addEventListener("click", logout);
  }

  function posterCard(item, type) {
    const media = type || item.media_type || (item.title ? "movie" : "tv");
    const title = item.title || item.name || "Untitled";
    const date = formatDate(item.release_date || item.first_air_date);
    const poster = imgUrl(item.poster_path, "w342") || initialsAvatar(title);
    return `
      <a class="poster-card" href="${watchHref(media, item.id)}" title="${escapeHtml(title)}">
        <div class="poster-media">
          <span class="rating-badge">★ ${ratingText(item.vote_average)}</span>
          <img src="${poster}" alt="${escapeHtml(title)}" loading="lazy" />
          <div class="poster-play">
            <span class="play-orb">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5L13 8L4 13.5V2.5Z"/></svg>
            </span>
          </div>
        </div>
        <div class="poster-info">
          <h3>${escapeHtml(title)}</h3>
          <div class="poster-sub">
            <span>${escapeHtml(date)}</span>
            <span>${ratingText(item.vote_average)}/10</span>
          </div>
        </div>
      </a>
    `;
  }

  async function sha256(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text || "")));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function supabaseRequest(path, options = {}) {
    const res = await fetch(`${SUPABASE_URL}${path}`, {
      ...options,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...(options.headers || {}),
      },
    });
    let data = null;
    const raw = await res.text();
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = raw;
    }
    // Headers carry the total row count when a request asks for count=exact.
    return { ok: res.ok, status: res.status, data, headers: res.headers };
  }

  // Tell the author's accepted followers that a new post is out. One bulk insert
  // keeps it cheap; failures stay silent (the post itself is already saved).
  async function notifyFollowers(payload = {}) {
    const ownerId = payload.ownerId || payload.owner_id;
    if (!ownerId) return false;
    // Nobody gets told about a post that is meant to stay private.
    if (payload.visibility === "private") return false;
    try {
      const fol = await supabaseRequest(
        `/rest/v1/follows?following_id=eq.${restValue(ownerId)}&status=eq.accepted&select=follower_id`
      );
      const ids = [...new Set((fol.data || []).map((f) => f.follower_id).filter((id) => id && id !== ownerId))];
      if (!ids.length) return false;
      const rows = ids.slice(0, 500).map((id) => ({
        member_id: id,
        kind: "post",
        title: payload.title || t("prof.newPost"),
        body: payload.body || "",
        href: payload.href || profileHref(payload.username || ""),
        from_id: ownerId,
        from_username: payload.username || "",
      }));
      const res = await supabaseRequest("/rest/v1/notifications", {
        method: "POST",
        body: JSON.stringify(rows),
      });
      return Boolean(res.ok);
    } catch {
      return false;
    }
  }

  function normalizeAccountStatus(value) {
    const raw = String(value || "").trim().toLowerCase();
    const map = {
      active: "active",
      activated: "active",
      enabled: "active",
      "مفعل": "active",
      disabled: "disabled",
      inactive: "disabled",
      "معطل": "disabled",
      banned: "banned",
      blocked: "banned",
      "محظور": "banned",
    };
    return map[raw] || map[String(value || "").trim()] || raw;
  }

  // ---------- IPTV helpers (shared by dashboard + panel) ----------
  function iptvKind(a) {
    return a.kind || (a.xstream_user ? "xtream" : "m3u");
  }

  function iptvServer(a) {
    return String(a.xstream_server || "").trim().replace(/\/(player_api|get|xmltv|panel_api)\.php.*$/i, "").replace(/\/+$/, "");
  }

  function iptvM3uUrl(a) {
    if (iptvKind(a) === "m3u") return a.m3u_url || "";
    const server = iptvServer(a);
    if (!server || !a.xstream_user) return "";
    return `${server}/get.php?username=${encodeURIComponent(a.xstream_user)}&password=${encodeURIComponent(a.xstream_password || "")}&type=m3u_plus&output=ts`;
  }

  // Programme guide (XMLTV) of an account: the one saved with it (Panel > IPTV,
  // or the url-tvg of an imported playlist); an Xtream account without one uses
  // the provider's own xmltv.php.
  function firstHttpUrl(value) {
    return String(value || "").split(/[\s,]+/).map((u) => u.trim()).find((u) => /^https?:\/\/\S+$/i.test(u)) || "";
  }

  function iptvEpgUrl(a) {
    const own = firstHttpUrl(a?.epg_url);
    if (own) return own;
    if (!a || iptvKind(a) !== "xtream") return "";
    const server = iptvServer(a);
    if (!server || !a.xstream_user) return "";
    return `${server}/xmltv.php?username=${encodeURIComponent(a.xstream_user)}&password=${encodeURIComponent(a.xstream_password || "")}`;
  }

  // The guide announced by a playlist itself: #EXTM3U url-tvg="…" (or x-tvg-url / tvg-url).
  function m3uHeaderEpg(text) {
    const head = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/, 8).find((l) => /^#EXTM3U/i.test(l.trim()));
    if (!head) return "";
    const attrs = {};
    head.replace(/([\w-]+)=("([^"]*)"|'([^']*)'|(\S+))/g, (_, k, _v, a, b, c) => {
      attrs[k.toLowerCase()] = a ?? b ?? c ?? "";
      return "";
    });
    return firstHttpUrl(attrs["url-tvg"] || attrs["x-tvg-url"] || attrs["tvg-url"] || "");
  }

  // ---- premium accounts: who owns one, and until when ----
  const iptvIsFree = (a) => String(a?.type || "").trim().toLowerCase() === "free";
  const ownerKey = (v) => String(v || "").trim().replace(/^@/, "").toLowerCase();

  // owner_id holds the member id (Panel > IPTV always writes it). A row typed by
  // hand may hold the username, in another case, or with an @: all of them count.
  function iptvOwnedBy(a, member) {
    const key = ownerKey(a?.owner_id);
    if (!key || !member) return false;
    return key === ownerKey(member.member_id) || (Boolean(member.username) && key === ownerKey(member.username));
  }

  // PostgREST filter for "free packages + the premium ones of this member". It
  // may return a little more than it should (ilike treats _ as a wildcard), so
  // the rows are checked again with iptvOwnedBy.
  function iptvVisibleFilter(member) {
    const parts = ["type.ilike.free"];
    const id = String(member?.member_id || "").trim();
    const user = String(member?.username || "").trim().replace(/^@/, "");
    if (id) parts.push(`owner_id.ilike.${restValue(id)}`);
    if (/^[A-Za-z0-9._]{2,40}$/.test(user)) parts.push(`owner_id.ilike.${restValue(user)}`, `owner_id.ilike.${restValue("@" + user)}`);
    return `or=(${parts.join(",")})`;
  }

  function iptvVisibleTo(a, member) {
    return iptvIsFree(a) || iptvOwnedBy(a, member);
  }

  // "1 month", "3 months", "1 year", "7 days", "2 weeks" — and the same in the
  // other site languages ("3 أشهر", "شهرين", "6 mois", "1 Jahr", …). Returns the
  // end date, or null for "unlimited" and for anything it cannot read.
  const DURATION_UNITS = [
    ["day", /^(d|days?|jours?|j|tage?n?|tag|d[ií]as?|dag(en)?|giorn[oi]|يوم|ايام|أيام|يوما|يومًا)$/i],
    ["week", /^(w|wks?|weeks?|semaines?|wochen?|semanas?|weken|settiman[ae]|اسبوع|أسبوع|اسابيع|أسابيع|اسبوعا|أسبوعًا)$/i],
    ["month", /^(mo|mos|months?|mois|monate?n?|mes(es)?|maand(en)?|mes[ei]|شهر|اشهر|أشهر|شهور|شهرا|شهرًا)$/i],
    ["year", /^(y|yrs?|years?|ans?|ann[ée]es?|jahre?n?|años?|anos?|jaar|jaren|ann[oi]|سنة|سنه|سنوات|سنين|عام|اعوام|أعوام|عاما|عامًا)$/i],
  ];
  const DUAL = [
    ["day", /^(يومين|يومان)$/],
    ["week", /^(اسبوعين|أسبوعين|اسبوعان|أسبوعان)$/],
    ["month", /^(شهرين|شهران)$/],
    ["year", /^(سنتين|سنتان|عامين|عامان)$/],
  ];
  const UNLIMITED = /^(unlimited|lifetime|forever|∞|غير\s*محدود[ةه]?|مدى\s*الحياة|illimit[ée]e?|unbegrenzt|ilimitad[oa]|onbeperkt|illimitat[oa]|sin\s*l[ií]mite|senza\s*limiti)$/i;

  // -> { n, unit } | { unlimited: true } | null (unreadable)
  function parseDuration(duration) {
    const text = String(duration || "")
      .trim()
      .toLowerCase()
      .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x660))
      .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x6f0));
    if (!text) return null;
    if (UNLIMITED.test(text)) return { unlimited: true };
    let n = 1;
    let unitWord = text;
    const m = /^(\d{1,4})\s*([^\d\s].*)?$/.exec(text);
    if (m) {
      if (!m[2]) return null; // a bare number: days? months? shown as typed
      n = Number(m[1]);
      unitWord = m[2].trim();
    } else {
      const dual = DUAL.find(([, re]) => re.test(text));
      if (dual) {
        n = 2;
        unitWord = dual[0];
      }
    }
    unitWord = unitWord.replace(/^(a|an|one|un|une|ein|eine|uno|una|een|واحد|واحدة)\s+/, "").replace(/\s+(واحد|واحدة)$/, "");
    const unit = ["day", "week", "month", "year"].includes(unitWord) ? unitWord : DURATION_UNITS.find(([, re]) => re.test(unitWord))?.[0];
    return unit && n ? { n, unit } : null;
  }

  function iptvExpiry(from, duration) {
    const start = new Date(from);
    const d = parseDuration(duration);
    if (Number.isNaN(start.getTime()) || !d || d.unlimited) return null;
    const end = new Date(start.getTime());
    if (d.unit === "day" || d.unit === "week") {
      end.setDate(end.getDate() + d.n * (d.unit === "week" ? 7 : 1));
      return end;
    }
    // 31 January + 1 month = 28 (or 29) February, not 3 March
    const day = end.getDate();
    end.setDate(1);
    end.setMonth(end.getMonth() + d.n * (d.unit === "year" ? 12 : 1));
    end.setDate(Math.min(day, new Date(end.getFullYear(), end.getMonth() + 1, 0).getDate()));
    return end;
  }

  // "3 months" in the language of the page ("3 أشهر", "3 mois", …); text it
  // cannot read is shown as it was typed.
  function durationLabel(duration) {
    const d = parseDuration(duration);
    if (!d) return String(duration || "").trim() || t("common.unlimited");
    if (d.unlimited) return t("common.unlimited");
    try {
      return new Intl.NumberFormat(getLocale(), { style: "unit", unit: d.unit, unitDisplay: "long", numberingSystem: "latn" }).format(d.n);
    } catch {
      return `${d.n} ${d.unit}${d.n === 1 ? "" : "s"}`;
    }
  }

  // { start, exp, left, share, open }: exp null = no end date known; open = none
  // by design ("unlimited", or no duration at all). expires_at wins; older rows
  // count their duration from when they were given (or created).
  function iptvTiming(a, now = Date.now()) {
    const start = Date.parse(a?.assigned_at || a?.created_at || "");
    let exp = Date.parse(a?.expires_at || "");
    if (!Number.isFinite(exp) && Number.isFinite(start)) exp = iptvExpiry(start, a?.duration)?.getTime() ?? NaN;
    if (!Number.isFinite(exp)) {
      const d = parseDuration(a?.duration);
      const open = !String(a?.duration || "").trim() || Boolean(d?.unlimited) || Boolean(d && !Number.isFinite(start));
      return { start: Number.isFinite(start) ? start : null, exp: null, left: Infinity, share: 1, open };
    }
    const total = Number.isFinite(start) && exp > start ? exp - start : 0;
    const left = exp - now;
    return { start: Number.isFinite(start) ? start : null, exp, left, share: left <= 0 ? 0 : total ? Math.min(1, left / total) : 1, open: false };
  }

  function fileSlug(name) {
    return String(name || "iptv").trim().replace(/[^\w\u0600-\u06FF.-]+/g, "_").replace(/^_+|_+$/g, "") || "iptv";
  }

  function saveTextFile(filename, text, mime) {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function fetchPlaylistText(url) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.text();
    } catch { /* blocked by CORS: use the server proxy */ }
    const r2 = await fetch(`/api/m3u?url=${encodeURIComponent(url)}`);
    if (!r2.ok) throw new Error("fetch failed");
    return r2.text();
  }

  // M3U playlist -> public.listchannels rows (Panel > IPTV import, channel player).
  // "Animation;Kids;Religious" puts the channel once inside each of those groups.
  // stream_url is the URL line under #EXTINF: the link the channel player opens;
  // epg_id is its tvg-id, the key of the channel in the programme guide.
  function parseM3U(text) {
    const out = [];
    let cur = null;
    String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/).forEach((raw) => {
      const line = raw.trim();
      if (!line) return;
      if (/^#EXTINF/i.test(line)) {
        const attrs = {};
        const stripped = line.replace(/([\w-]+)="([^"]*)"/g, (_, k, v) => { attrs[k.toLowerCase()] = v; return ""; });
        const name = stripped.slice(stripped.indexOf(",") + 1).trim() || attrs["tvg-name"] || "";
        cur = { name, group: (attrs["group-title"] || "").trim() || "General", logo: attrs["tvg-logo"] || "", epg: (attrs["tvg-id"] || "").trim() };
      } else if (/^#EXTGRP:/i.test(line) && cur) {
        cur.group = line.slice(8).trim() || cur.group;
      } else if (!line.startsWith("#")) {
        if (cur && cur.name) {
          const u = line.toLowerCase();
          const type = u.includes("/movie/") ? "movie" : u.includes("/series/") ? "series" : "live";
          const stream = /^[a-z][a-z0-9+.-]*:\/\//i.test(line) ? line.slice(0, 2000) : "";
          const groups = [...new Set(cur.group.split(";").map((g) => g.trim()).filter(Boolean))];
          (groups.length ? groups : ["General"]).forEach((g) => {
            out.push({
              channel_name: cur.name.slice(0, 200),
              group_name: g.slice(0, 120),
              logo_url: /^https?:\/\//i.test(cur.logo) ? cur.logo : "",
              channel_type: type,
              stream_url: stream,
              epg_id: cur.epg.slice(0, 200),
            });
          });
        }
        cur = null;
      }
    });
    return out;
  }

  // The guide of the account goes into the playlist header, where IPTV apps
  // (TiviMate, IPTV Smarters, VLC, …) look for it.
  function withEpgHeader(text, epg) {
    if (!epg || m3uHeaderEpg(text)) return text;
    const body = String(text).replace(/^\uFEFF/, "");
    const tag = `url-tvg="${epg.replace(/"/g, "%22")}" x-tvg-url="${epg.replace(/"/g, "%22")}"`;
    if (/^#EXTM3U/i.test(body)) return body.replace(/^#EXTM3U[^\r\n]*/i, (line) => `${line.trimEnd()} ${tag}`);
    return `#EXTM3U ${tag}\n${body}`;
  }

  async function iptvDownloadM3u(a) {
    const url = iptvM3uUrl(a);
    if (!url) return toast(t("dash.iptvDlFail"));
    try {
      const text = withEpgHeader(await fetchPlaylistText(url), iptvEpgUrl(a));
      if (!/#EXTM3U|#EXTINF/i.test(text)) throw new Error("not an m3u");
      saveTextFile(`${fileSlug(a.name)}.m3u`, text, "audio/x-mpegurl");
      toast(t("dash.iptvDlOk"));
    } catch {
      toast(t("dash.iptvDlFail"));
    }
  }

  function iptvDownloadXtream(a) {
    const server = iptvServer(a);
    const q = `username=${encodeURIComponent(a.xstream_user || "")}&password=${encodeURIComponent(a.xstream_password || "")}`;
    const body = [
      "CineAura IPTV - Xtream Codes",
      "============================",
      `Name: ${a.name || ""}`,
      `Server: ${server}`,
      `Username: ${a.xstream_user || ""}`,
      `Password: ${a.xstream_password || ""}`,
      `M3U: ${iptvM3uUrl(a)}`,
      `EPG: ${iptvEpgUrl(a) || `${server}/xmltv.php?${q}`}`,
      `Duration: ${a.duration || "unlimited"}`,
      "",
    ].join("\r\n");
    saveTextFile(`${fileSlug(a.name)}-xtream.txt`, body, "text/plain");
    toast(t("dash.iptvDlOk"));
  }

  function iptvDetailRows(a) {
    const row = (label, val, secret) => {
      if (!val) return "";
      const v = escapeHtml(val);
      return `<div class="ipx-row">
        <span class="ipx-label">${label}</span>
        <div class="ipx-line">
          <code class="ipx-val" dir="ltr" title="${secret ? "" : v}" data-full="${v}" ${secret ? 'data-secret="1"' : ""}>${secret ? "••••••••" : v}</code>
          ${secret ? `<button class="ipx-btn" type="button" data-ipx-eye>${t("dash.iptvShow")}</button>` : ""}
          <button class="ipx-btn" type="button" data-ipx-copy="${v}">${t("dash.iptvCopy")}</button>
        </div>
      </div>`;
    };
    const epg = row(t("iptv.epg"), iptvEpgUrl(a));
    if (iptvKind(a) === "m3u") return row("M3U", a.m3u_url) + epg;
    return row(t("panel.iptv.server"), iptvServer(a)) + row(t("panel.iptv.user"), a.xstream_user) + row(t("panel.iptv.pass"), a.xstream_password, true) + row("M3U", iptvM3uUrl(a)) + epg;
  }

  function iptvActionsHtml(a) {
    const id = escapeHtml(String(a.id));
    return `${iptvM3uUrl(a) ? `<button class="btn btn-sm btn-ghost" type="button" data-ipx-dl-m3u="${id}">${t("dash.iptvDlM3u")}</button>` : ""}${iptvKind(a) === "xtream" ? `<button class="btn btn-sm btn-ghost" type="button" data-ipx-dl-xt="${id}">${t("dash.iptvDlXt")}</button>` : ""}`;
  }

  function bindIptvActions(root, getAccount) {
    if (!root) return;
    root.addEventListener("click", async (e) => {
      const copy = e.target.closest("[data-ipx-copy]");
      if (copy) {
        try { await navigator.clipboard.writeText(copy.dataset.ipxCopy); toast(t("dash.iptvCopied")); } catch { /* ignore */ }
        return;
      }
      const eye = e.target.closest("[data-ipx-eye]");
      if (eye) {
        const code = eye.closest(".ipx-line")?.querySelector(".ipx-val");
        if (!code) return;
        const hidden = code.dataset.secret === "1";
        code.textContent = hidden ? code.dataset.full : "••••••••";
        code.dataset.secret = hidden ? "0" : "1";
        eye.textContent = hidden ? t("dash.iptvHide") : t("dash.iptvShow");
        return;
      }
      const m3u = e.target.closest("[data-ipx-dl-m3u]");
      const xt = e.target.closest("[data-ipx-dl-xt]");
      if (m3u || xt) {
        const acc = getAccount(String((m3u || xt).dataset.ipxDlM3u ?? (m3u || xt).dataset.ipxDlXt));
        if (!acc) return;
        if (m3u) { m3u.disabled = true; await iptvDownloadM3u(acc); m3u.disabled = false; }
        else iptvDownloadXtream(acc);
      }
    });
  }

  // Partial-ban guard: call before any restricted activity. Returns false (and shows the error) if blocked.
  async function guardFeature(feature) {
    const sess = getSession();
    if (!sess?.member_id) return true;
    try {
      const [san, mem] = await Promise.all([
        supabaseRequest(`/rest/v1/sanctions?member_id=eq.${restValue(sess.member_id)}&select=features,temp_until`),
        supabaseRequest(`/rest/v1/members?member_id=eq.${restValue(sess.member_id)}&select=status`),
      ]);
      const row = san.ok && Array.isArray(san.data) ? san.data[0] : null;
      const feats = String(row?.features || "").split(",").map((x) => x.trim());
      const temp = Boolean(row?.temp_until) && Date.parse(row.temp_until) > Date.now();
      const banned = normalizeAccountStatus(mem.data?.[0]?.status) === "banned";
      if (feats.includes(feature) || temp || banned) {
        toast(t("panel.featBlockedMsg", { feature: t(`panel.feat.${feature}`) }));
        return false;
      }
    } catch { /* offline: let the request itself fail */ }
    return true;
  }

  // ---------- Collapsible side menu (dashboard, panel, profile) ----------
  const SIDE_KEY = "cineaura_side_hidden";

  function sideHidden() {
    try {
      return localStorage.getItem(SIDE_KEY) === "1";
    } catch {
      return false;
    }
  }

  // Adds a "Hide menu / Show menu" button above the sidebar layout and applies the
  // remembered state. Call it again after every re-render of the layout.
  /* Icons of the side menus (dashboard, profile, panel): 24x24 line drawings in the
     colour of the text. navIcon(name) -> <svg>, "" for a name without one. */
  const NAV_ICONS = {
    overview: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
    playlists: '<path d="M4 6h11M4 11h11M4 16h7"/><path d="M15.5 14.5v6l5-3z"/>',
    links: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>',
    reports: '<path d="M5.5 21V4"/><path d="M5.5 4.5h11l-2 4 2 4h-11"/>',
    codes: '<circle cx="8" cy="15.5" r="4"/><path d="M10.9 12.6L20 3.5M16.5 7l2.5 2.5M14 9.5l2 2"/>',
    iptv: '<rect x="3" y="6.5" width="18" height="12.5" rx="2"/><path d="M8.5 3l3.5 3.5L15.5 3M9 22h6"/>',
    views: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    analytics: '<path d="M3.5 20.5h17"/><path d="M7 17v-5M12 17V6M17 17v-8"/>',
    prizes: '<rect x="3.5" y="8" width="17" height="4.5" rx="1"/><path d="M5 12.5V20.5h14v-8M12 8v12.5"/><path d="M12 8C10.5 4.5 6.5 4 6.5 6.3S9.5 8 12 8zM12 8c1.5-3.5 5.5-4 5.5-1.7S14.5 8 12 8z"/>',
    history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 3.5v5h5"/><path d="M12 7.5V12l3 2"/>',
    settings: '<path d="M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h11M19 17.5h1"/><circle cx="15" cy="6.5" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17.5" r="2"/>',
    panel: '<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
    home: '<path d="M3.5 11L12 4l8.5 7"/><path d="M5.5 9.5v11h4.5v-6h4v6h4.5v-11"/>',
    create: '<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><path d="M12 8v8M8 12h8"/>',
    posts: '<path d="M6.5 3.5h8l4 4v13h-12z"/><path d="M14 3.5V8h4.5M9.5 12.5h6M9.5 16.5h4"/>',
    points: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
    messages: '<path d="M20.5 12a8 8 0 0 1-11.7 7.1L3.5 20.5l1.4-4.9A8 8 0 1 1 20.5 12z"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.3-4.3"/>',
    following: '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 5a3.5 3.5 0 0 1 0 7M18 14.3a6.5 6.5 0 0 1 3.5 5.7"/>',
    blocked: '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>',
    accounts: '<circle cx="12" cy="8.5" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
    apps: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
    staff: '<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z"/><circle cx="12" cy="10.5" r="2.3"/><path d="M8.3 16.2a4.2 4.2 0 0 1 7.4 0"/>',
  };
  NAV_ICONS.content = '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10.5 9.3v5.4l4.5-2.7z"/>';
  NAV_ICONS.notifications = '<path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>';

  function navIcon(name) {
    const body = NAV_ICONS[name];
    return body
      ? `<svg class="nav-ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`
      : "";
  }

  function mountSideToggle(layout) {
    if (!layout || !layout.querySelector("aside")) return;
    layout.querySelector(":scope > .side-toggle-bar")?.remove();
    const bar = document.createElement("div");
    bar.className = "side-toggle-bar";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-sm btn-ghost side-toggle";
    btn.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg><span></span>';
    const label = btn.querySelector("span");
    const apply = (hidden) => {
      layout.classList.toggle("side-collapsed", hidden);
      btn.setAttribute("aria-expanded", String(!hidden));
      label.textContent = t(hidden ? "side.show" : "side.hide");
    };
    btn.addEventListener("click", () => {
      const hidden = !layout.classList.contains("side-collapsed");
      try {
        localStorage.setItem(SIDE_KEY, hidden ? "1" : "0");
      } catch {
        /* storage blocked: the toggle still works for this view */
      }
      apply(hidden);
    });
    bar.appendChild(btn);
    layout.prepend(bar);
    apply(sideHidden());
  }

  /* ════════════════════════════════════════════════════════════════════
     Points

     A member earns points from these sources, each at its own rate:

       watch minutes — yours or through your link —  see "Watch rates and levels" below
       5 new members registered through your shared links = 1 point
       500 watch links published (banned links excluded) = 1 point
       10 public or exclusive playlists                = 1 point
       50 public or exclusive recommendations          = 1 point
       100 comments                                    = 1 point
       your videos (sql/content.sql): each counted minute, share, comment and
         positive recommendation — yours on other members' videos, or other
         members' on yours — is worth one watched minute (country tier x level)
       points codes (sql/point_codes.sql): the points of every package serial used

     Fractions are dropped (12 referred registrations are worth 2 points, not 2.4). What a
     member can spend is what they earned minus what they already spent
     (profiles.points_spent), so the bonus points of a source cannot be spent
     twice and the watch minutes themselves are never destroyed.

     Watch rates and levels (sql/point_levels.sql holds the same tables):
     one watched minute is worth  level multiplier ÷ minutes of the viewer's country tier.
       Tier 1  US CA GB                       1 point / 1 minute
       Tier 2  DE FR NL BE AT CH IE LU SE NO DK FI IS IT ES PT GR MT CY   1 point / 5 minutes
       Tier 3  SA AE QA KW BH OM PL CZ HU RO BG HR SI SK EE LV LT SG ID MY  1 point / 10 minutes
       Tier 4  every other country            1 point / 50 minutes
       LV0 0+ ×1 · LV1 10+ ×1 · LV2 100+ ×2 · LV3 1K+ ×3 … LV9 1B+ ×9 · LV Max 10B+ ×10
     The level counts every point earned (spending never lowers it). The server credits
     each minute into profiles.watch_points (watch_minute()); before that file existed a
     minute was worth 1 point, which is what the minutes give when the column is missing.
     ════════════════════════════════════════════════════════════════════ */
  const POINT_RATES = [
    { key: "minutes", per: 1, src: "points.src.minutes", rate: "points.rate.minutes" },
    // stored by the server: profiles.content_points (sql/content.sql), counted in content_units
    { key: "videos", per: 1, src: "points.src.videos", rate: "points.rate.videos" },
    { key: "shares", per: 5, src: "points.src.shares", rate: "points.rate.shares" },
    { key: "links", per: 500, src: "points.src.links", rate: "points.rate.links" },
    { key: "downloads", per: 1000, src: "points.src.downloads", rate: "points.rate.downloads" },
    { key: "playlists", per: 10, src: "points.src.playlists", rate: "points.rate.playlists" },
    { key: "recommendations", per: 50, src: "points.src.recs", rate: "points.rate.recs" },
    { key: "comments", per: 100, src: "points.src.comments", rate: "points.rate.comments" },
    // stored by the server: profiles.code_points (sql/point_codes.sql), counted in code_count
    { key: "codes", per: 1, src: "points.src.codes", rate: "points.rate.codes" },
  ];
  // Columns of profiles that hold points the server credits (absent until their SQL file ran).
  const STORED_POINT_COLUMNS = ["watch_points", "content_points", "content_units", "code_points", "code_count"];

  const WATCH_TIERS = [
    { tier: 1, minutes: 1, countries: ["US", "CA", "GB"] },
    {
      tier: 2,
      minutes: 5,
      countries: ["DE", "FR", "NL", "BE", "AT", "CH", "IE", "LU", "SE", "NO", "DK", "FI", "IS", "IT", "ES", "PT", "GR", "MT", "CY"],
    },
    {
      tier: 3,
      minutes: 10,
      countries: ["SA", "AE", "QA", "KW", "BH", "OM", "PL", "CZ", "HU", "RO", "BG", "HR", "SI", "SK", "EE", "LV", "LT", "SG", "ID", "MY"],
    },
    { tier: 4, minutes: 50, countries: [] }, // every other country
  ];
  // Points earned to reach each level: index = level, LV0 … LV Max (10).
  const POINT_LEVELS = [0, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10];
  const LEVEL_MAX = POINT_LEVELS.length - 1;

  function watchTier(cc) {
    const code = String(cc || "").trim().toUpperCase();
    return WATCH_TIERS.find((x) => x.countries.includes(code)) || WATCH_TIERS[WATCH_TIERS.length - 1];
  }
  function pointLevel(earned) {
    const n = Math.max(0, Number(earned) || 0);
    let lv = 0;
    for (let i = 1; i <= LEVEL_MAX; i += 1) if (n >= POINT_LEVELS[i]) lv = i;
    return lv;
  }
  const levelMultiplier = (lv) => Math.max(1, Math.min(LEVEL_MAX, Number(lv) || 0));
  const levelName = (lv) => (Number(lv) >= LEVEL_MAX ? "LV Max" : `LV${Math.max(0, Math.floor(Number(lv) || 0))}`);
  // 10 → "10", 1000 → "1K", 10^10 → "10B": the notation of the levels table, the same in every language.
  function compactPoints(n) {
    const v = Number(n) || 0;
    for (const [div, unit] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]]) {
      if (v >= div && v % div === 0) return `${v / div}${unit}`;
    }
    return String(v);
  }
  // Where `earned` points put a member: level, multiplier, the next level and the way to it.
  function levelInfo(earned) {
    const have = Math.max(0, Math.floor(Number(earned) || 0));
    const level = pointLevel(have);
    const from = POINT_LEVELS[level];
    const to = level < LEVEL_MAX ? POINT_LEVELS[level + 1] : null;
    return {
      level,
      name: levelName(level),
      multiplier: levelMultiplier(level),
      earned: have,
      from,
      next: to == null ? null : { level: level + 1, name: levelName(level + 1), at: to, multiplier: levelMultiplier(level + 1) },
      progress: to == null ? 1 : Math.min(1, Math.max(0, (have - from) / (to - from))),
    };
  }

  // Total number of rows of a query, read from the content-range header so the
  // rows themselves never travel over the wire.
  async function countRows(path) {
    const res = await supabaseRequest(`${path}${path.includes("?") ? "&" : "?"}limit=1`, {
      headers: { Prefer: "count=exact", Range: "0-0" },
    });
    if (!res.ok) return 0;
    const n = Number(String(res.headers?.get?.("content-range") || "").split("/")[1]);
    if (Number.isFinite(n)) return n;
    return Array.isArray(res.data) ? res.data.length : 0;
  }

  // How many of each source the member has. `minutes` comes from the profile
  // row that is already loaded: private_minutes is what the member watched,
  // public_minutes what was watched through a link they published.
  // Watch links published by the member: movielink + tvlink rows, banned ones excluded.
  // Download clicks: every 1000 clicks on the member's download links is one point,
  // read from the clicks counter the watch page moves (countLinkClick).
  async function pointParts(memberId, profile = {}) {
    const id = restValue(memberId);
    const minutes = Number(profile.private_minutes || 0) + Number(profile.public_minutes || 0);
    // profiles.watch_points (sql/point_levels.sql): null on a database without the column
    const stored = (v) => (v == null || v === "" ? null : Number(v));
    const watchPoints = stored(profile.watch_points);
    const videoPoints = stored(profile.content_points);
    const codePoints = stored(profile.code_points);
    const [shares, playlists, recommendations, comments, movieLinks, tvLinks, movieDl, tvDl] =
      await Promise.all([
        countRows(`/rest/v1/post_events?kind=eq.share&network=eq.referral&member_id=eq.${id}&select=id`),
        countRows(`/rest/v1/playlists?owner_id=eq.${id}&visibility=in.(public,exclusive)&select=playlist_id`),
        countRows(
          `/rest/v1/posts?owner_id=eq.${id}&kind=in.(recommendation,reclist)&visibility=in.(public,exclusive)&select=post_id`
        ),
        countRows(`/rest/v1/comments?member_id=eq.${id}&select=id`),
        countRows(`/rest/v1/movielink?member_id=eq.${id}&banned=eq.false&select=id`),
        countRows(`/rest/v1/tvlink?member_id=eq.${id}&banned=eq.false&select=id`),
        sumColumn(`/rest/v1/movielink?member_id=eq.${id}&link_kind=eq.download`, "clicks"),
        sumColumn(`/rest/v1/tvlink?member_id=eq.${id}&link_kind=eq.download`, "clicks"),
      ]);
    return {
      minutes,
      watchPoints: Number.isFinite(watchPoints) ? watchPoints : null,
      videos: Number(profile.content_units || 0),
      videoPoints: Number.isFinite(videoPoints) ? videoPoints : null,
      codes: Number(profile.code_count || 0),
      codePoints: Number.isFinite(codePoints) ? codePoints : null,
      shares,
      playlists,
      recommendations,
      comments,
      links: movieLinks + tvLinks,
      downloads: movieDl + tvDl,
    };
  }

  // One row per source: what the member has, the rate, and the points it gives.
  // Watch minutes give the stored watch points (whole points) once sql/point_levels.sql
  // is in place, 1 point a minute before.
  function pointBreakdown(parts) {
    const storedOf = { minutes: parts?.watchPoints, videos: parts?.videoPoints, codes: parts?.codePoints };
    return POINT_RATES.map((r) => {
      const count = Number(parts?.[r.key] || 0);
      let points;
      if (r.key in storedOf) {
        const v = storedOf[r.key];
        // watch minutes give 1 point a minute until sql/point_levels.sql stores them
        points = v != null ? Math.floor(Number(v) + 1e-9) : r.key === "minutes" ? Math.floor(count / r.per) : 0;
      } else {
        points = Math.floor(count / r.per);
      }
      return { key: r.key, per: r.per, src: r.src, rate: r.rate, count, points };
    });
  }

  const pointsEarned = (parts) => pointBreakdown(parts).reduce((sum, r) => sum + r.points, 0);

  // The rate line of the watch row: the viewer's country (the IP country, never the one
  // picked in Site Settings — the server decides from the same IP) and the member's level.
  function watchRateText(level, cc) {
    const lv = level || levelInfo(0);
    const code = String(cc || "").toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) return t("points.rate.watchAny", { n: lv.multiplier, level: lv.name });
    const tier = watchTier(code);
    return t("points.rate.watch", {
      country: countryName(code) || code,
      tier: tier.tier,
      min: tier.minutes,
      n: lv.multiplier,
      level: lv.name,
    });
  }

  async function memberPoints(memberId, profile = {}) {
    let prof = profile || {};
    // Callers that loaded only some columns: read the stored points (absent on a database
    // that never ran their SQL file — the minutes count then, as before, and the rest is 0).
    if (memberId && STORED_POINT_COLUMNS.some((c) => !(c in prof))) {
      const res = await supabaseRequest(`/rest/v1/profiles?member_id=eq.${restValue(memberId)}&select=*`).catch(() => null);
      const row = res?.ok && Array.isArray(res.data) ? res.data[0] : null;
      if (row) {
        const add = {};
        STORED_POINT_COLUMNS.forEach((c) => {
          if (c in row) add[c] = row[c];
        });
        prof = { ...prof, ...add };
      }
    }
    const parts = await pointParts(memberId, prof);
    const breakdown = pointBreakdown(parts);
    const earned = breakdown.reduce((sum, r) => sum + r.points, 0);
    const spent = Math.max(0, Number(prof.points_spent || 0));
    const levels = parts.watchPoints != null;
    const level = levelInfo(earned);
    const country = levels ? readGeo()?.cc || "" : "";
    if (levels) {
      const watch = breakdown.find((r) => r.key === "minutes");
      if (watch) {
        watch.rateText = watchRateText(level, country);
        watch.exact = Number(parts.watchPoints);
      }
    }
    // videos: hundredths kept, like the watch minutes
    const vids = breakdown.find((r) => r.key === "videos");
    if (vids && parts.videoPoints != null) vids.exact = Number(parts.videoPoints);
    return {
      parts,
      breakdown,
      earned,
      spent,
      available: Math.max(0, earned - spent),
      levels,
      level,
      country,
      tier: country ? watchTier(country) : null,
    };
  }

  // Where the spent points went: one row per spend (sql/points.sql, point_spends), newest first.
  // Points spent before that table existed are returned as `earlier`, so the rows always add
  // up to `total`, which is profiles.points_spent.
  async function memberSpends(memberId, spent = 0) {
    const id = restValue(memberId);
    const total = Math.max(0, Number(spent || 0));
    const res = await supabaseRequest(
      `/rest/v1/point_spends?member_id=eq.${id}&select=prize_title,mode,amount,created_at&order=created_at.desc&limit=500`
    );
    const rows = res.ok && Array.isArray(res.data) ? res.data : [];
    const logged = rows.reduce((sum, r) => sum + Math.max(0, Number(r.amount || 0)), 0);
    return { rows, total, earlier: Math.max(0, total - logged) };
  }

  // Call a Postgres function (sql/prize_secure.sql). Returns { ok, status, data }.
  // Failures raised by the function (for example an expired staff session) come back
  // as ok:false with the message in data.message.
  async function rpc(name, args = {}) {
    return supabaseRequest(`/rest/v1/rpc/${name}`, { method: "POST", body: JSON.stringify(args) });
  }

  // One source row of a points list (the watch row carries its own rate line and the
  // exact watch points, hundredths included).
  function pointRowHtml(r) {
    const exact =
      r.exact != null && Number.isFinite(r.exact)
        ? `<small class="pt-exact">${escapeHtml(t("points.watchExact", { n: r.exact.toFixed(2) }))}</small>`
        : "";
    return `
        <li class="pt-row${r.key === "minutes" ? " pt-row-watch" : ""}">
          <span class="pt-src">
            <b>${escapeHtml(t(r.src))}</b>
            <small>${escapeHtml(r.rateText || t(r.rate))}</small>${exact}
          </span>
          <span class="pt-count">${r.count}</span>
          <span class="pt-pts">+${r.points}</span>
        </li>`;
  }

  // The level of a member: badge, multiplier, the way to the next level, and the
  // tables of levels and country rates. Empty until sql/point_levels.sql is in place.
  function levelHtml(mp) {
    if (!mp?.levels || !mp.level) return "";
    const lv = mp.level;
    const pct = Math.round(lv.progress * 100);
    const nextText = lv.next
      ? t("points.levelNext", { have: lv.earned, need: compactPoints(lv.next.at), level: lv.next.name })
      : t("points.levelTop");
    const levelRows = POINT_LEVELS.map((at, i) => {
      const you = i === lv.level;
      return `<tr${you ? ' class="is-you" aria-current="true"' : ""}>
            <td><bdi dir="ltr">${escapeHtml(levelName(i))}</bdi>${you ? ` <span class="pt-you">${escapeHtml(t("points.you"))}</span>` : ""}</td>
            <td><bdi dir="ltr">${compactPoints(at)}+</bdi>${i === 0 ? ` <small>${escapeHtml(t("points.newAccount"))}</small>` : ""}</td>
            <td><bdi dir="ltr">×${levelMultiplier(i)}</bdi></td>
          </tr>`;
    }).join("");
    const myTier = mp.tier?.tier || 0;
    const tierRows = WATCH_TIERS.map((x) => {
      const you = x.tier === myTier;
      const where = x.countries.length
        ? `<bdi dir="ltr">${x.countries.join(", ")}</bdi>`
        : escapeHtml(t("points.tierOther"));
      return `<tr${you ? ' class="is-you" aria-current="true"' : ""}>
            <td>${escapeHtml(t("points.tierN", { n: x.tier }))}${you ? ` <span class="pt-you">${escapeHtml(t("points.you"))}</span>` : ""}</td>
            <td class="pt-countries">${where}</td>
            <td class="pt-rate">${escapeHtml(t("points.perMin", { n: x.minutes }))}</td>
          </tr>`;
    }).join("");
    return `
        <div class="pt-level" data-level="${lv.level}">
          <span class="pt-lv-badge"><bdi dir="ltr">${escapeHtml(lv.name)}</bdi></span>
          <div class="pt-lv-main">
            <div class="pt-lv-top">
              <b>${escapeHtml(t("points.levelMult", { n: lv.multiplier }))}</b>
              <span class="pt-lv-next">${escapeHtml(nextText)}</span>
            </div>
            <div class="pt-lv-bar" role="progressbar" aria-label="${escapeHtml(nextText)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>
          </div>
        </div>
        <details class="pt-rules">
          <summary>${escapeHtml(t("points.levelsTitle"))}</summary>
          <div class="pt-rules-grid">
            <table class="pt-table">
              <caption>${escapeHtml(t("points.levelsCap"))}</caption>
              <thead><tr><th scope="col">${escapeHtml(t("points.colLevel"))}</th><th scope="col">${escapeHtml(t("points.colPoints"))}</th><th scope="col">${escapeHtml(t("points.colMult"))}</th></tr></thead>
              <tbody>${levelRows}</tbody>
            </table>
            <table class="pt-table">
              <caption>${escapeHtml(t("points.tiersCap"))}</caption>
              <thead><tr><th scope="col">${escapeHtml(t("points.colTier"))}</th><th scope="col">${escapeHtml(t("points.colCountries"))}</th><th scope="col">${escapeHtml(t("points.colRate"))}</th></tr></thead>
              <tbody>${tierRows}</tbody>
            </table>
          </div>
          <p class="pt-rules-note">${escapeHtml(t("points.levelsNote"))}</p>
        </details>`;
  }

  // The "how you earn points" panel shared by the prize dialog and dashboard.
  function pointsHtml(mp) {
    if (!mp) return "";
    const rows = mp.breakdown.map(pointRowHtml).join("");
    return `
      <div class="pt-box">
        <div class="pt-head">
          <span>${escapeHtml(t("points.title"))}</span>
          <b class="pt-total">${mp.available}</b>
        </div>
        ${levelHtml(mp)}
        <ul class="pt-list">${rows}</ul>
        <div class="pt-foot">
          <span>${escapeHtml(t("points.earned"))} <b>${mp.earned}</b></span>
          <span>${escapeHtml(t("points.spent"))} <b>${mp.spent}</b></span>
          <span>${escapeHtml(t("points.available"))} <b>${mp.available}</b></span>
        </div>
      </div>`;
  }

  /* ── Member watch links ──────────────────────────────────────────────
     One vocabulary for every form that publishes a watch link — the dashboard
     and the "+" popup on the watch page — so a quality or a language means the
     same thing wherever it is picked. The stored value is always the English
     text (the database keeps one value per row); language names are *shown*
     through the language pack. */
  const LINK_QUALITIES = ["SD", "HD", "FHD", "2K", "4K", "8K"];
  /* Link kinds. A member link is either something to watch in the player or
     something to download: both live in the same table (movielink / tvlink)
     and are told apart by link_kind, so one form publishes both. */
  const LINK_KINDS = ["watch", "download"];
  const linkKindOf = (row) =>
    String(row?.link_kind || "").trim().toLowerCase() === "download" ? "download" : "watch";
  const LINK_LANGUAGES = [
    "Arabic", "English", "French", "Spanish", "German", "Italian", "Portuguese",
    "Turkish", "Russian", "Japanese", "Korean", "Chinese", "Hindi", "Dutch",
    "Polish", "Indonesian", "Thai", "Vietnamese", "Persian", "Urdu",
  ];

  function validWatchUrl(value) {
    try {
      const u = new URL(String(value || "").trim());
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }

  function linkOptions(values, translate) {
    return values
      .map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(translate ? tr(value) : value)}</option>`)
      .join("");
  }

  const linkQualityOptions = () => linkOptions(LINK_QUALITIES, false);
  const linkLanguageOptions = () => linkOptions(LINK_LANGUAGES, true);

  /* Subtitle picker: one language, several, or all of them. `id` namespaces the
     inputs, so a page can hold more than one picker at a time. */
  function langPickerHtml(id) {
    return `
      <label class="lang-chip all"><input type="checkbox" id="${id}-all" /> ${escapeHtml(t("dash.allLangs"))}</label>
      ${LINK_LANGUAGES
        .map((lang) => `<label class="lang-chip"><input type="checkbox" name="${id}" value="${escapeHtml(lang)}" /> ${escapeHtml(tr(lang))}</label>`)
        .join("")}`;
  }

  /* Quality picker: one quality or several (SD, HD, FHD…), as checkboxes. */
  function qualityPickerHtml(id) {
    return LINK_QUALITIES
      .map((q) => `<label class="lang-chip"><input type="checkbox" name="${id}" value="${escapeHtml(q)}" /> ${escapeHtml(q)}</label>`)
      .join("");
  }

  // The ticked qualities, lowest first, joined the way the column stores them.
  function selectedQualities(id) {
    const picked = $$(`input[name="${id}"]:checked`).map((el) => el.value);
    return LINK_QUALITIES.filter((q) => picked.includes(q)).join(", ");
  }

  // "all", or the chosen language names joined the way the column stores them.
  function selectedLangs(id) {
    if ($(`#${id}-all`)?.checked) return "all";
    return $$(`input[name="${id}"]:checked`).map((el) => el.value).join(", ");
  }

  function bindLangPicker(id) {
    const all = $(`#${id}-all`);
    if (!all) return;
    const boxes = () => $$(`input[name="${id}"]`);
    all.onchange = () => {
      boxes().forEach((el) => {
        el.checked = all.checked;
        el.disabled = all.checked;
      });
    };
    boxes().forEach((el) => {
      el.onchange = () => {
        if (!el.checked) all.checked = false;
        else if (boxes().every((x) => x.checked)) {
          all.checked = true;
          boxes().forEach((x) => {
            x.checked = true;
            x.disabled = true;
          });
        }
      };
    });
  }

  /* One save path for both link forms (dashboard + the "+" popup on the watch
     page). A database that has not run the new sql/links.sql yet has no has_ads
     column, so retry without it instead of throwing away what was typed. */
  async function saveWatchLink(table, row) {
    const optional = ["has_ads", "url_hidden"];
    let body = { ...row };
    let saved = await supabaseRequest(`/rest/v1/${table}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    // Drop, one by one, an optional column the database answers it lacks.
    for (let i = 0; i < optional.length && !saved.ok; i++) {
      const raw = JSON.stringify(saved.data || {});
      const missing = optional.find((col) => col in body && new RegExp(col, "i").test(raw));
      if (!missing) break;
      body = { ...body };
      delete body[missing];
      saved = await supabaseRequest(`/rest/v1/${table}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    }
    return saved;
  }

  /* A member may publish one source as a watch link (opens in the player), as a
     download link (opens on its own site in a new tab) or as both: each kind is
     its own row, so the source shows up in the watch rail and in the download
     rail of the watch page. Both forms — the dashboard and the "+" popup —
     publish through here, so the three choices mean the same everywhere.
     A kind that already exists for this URL is skipped instead of failing the
     whole save; `error` carries the last database answer so the caller can tell
     "already published" from "could not save". */
  const LINK_KIND_CHOICES = ["watch", "download", "both"];

  const linkKindsFor = (choice) =>
    String(choice || "").trim().toLowerCase() === "both"
      ? ["watch", "download"]
      : [linkKindOf({ link_kind: choice })];

  async function publishWatchLink(table, row, kinds = ["watch"]) {
    const wanted = [...new Set((kinds || []).flatMap((kind) => linkKindsFor(kind)))];
    const existing = await supabaseRequest(
      `/rest/v1/${table}?tmdb_id=eq.${Number(row.tmdb_id)}&watch_url=eq.${restValue(row.watch_url)}&select=id,link_kind`
    );
    const have = new Set(existing.ok && Array.isArray(existing.data) ? existing.data.map(linkKindOf) : []);
    const added = [];
    let error = null;
    for (const kind of wanted) {
      if (have.has(kind)) continue;
      const saved = await saveWatchLink(table, { ...row, link_kind: kind });
      if (saved.ok) added.push(kind);
      else error = saved;
    }
    return {
      ok: added.length > 0,
      added,
      skipped: wanted.filter((kind) => have.has(kind)),
      error,
    };
  }

  /* ── Who hosts a watch link, and what it looks like ──────────────────────
     A member link is only a URL, so the platform name, its icon and the video
     thumbnail are read from that URL: the name from the domain (with a map for
     the hosts members actually use), the icon from the host itself, and the
     thumbnail from the page's og:image through the same-origin /api/thumb proxy
     (server.py). Static hosts without that proxy simply keep the icon. */
  const HOST_NAMES = {
    "youtube.com": "YouTube", "youtu.be": "YouTube", "m.youtube.com": "YouTube",
    "vimeo.com": "Vimeo", "player.vimeo.com": "Vimeo",
    "dailymotion.com": "Dailymotion", "dai.ly": "Dailymotion",
    "twitch.tv": "Twitch", "facebook.com": "Facebook", "fb.watch": "Facebook",
    "instagram.com": "Instagram", "tiktok.com": "TikTok",
    "x.com": "X", "twitter.com": "X", "t.me": "Telegram", "telegram.me": "Telegram",
    "drive.google.com": "Google Drive", "dropbox.com": "Dropbox",
    "mega.nz": "Mega", "mega.co.nz": "Mega", "archive.org": "Internet Archive",
    "ok.ru": "OK.ru", "vk.com": "VK Video", "vkvideo.ru": "VK Video", "myvi.ru": "MyVi",
    "rutube.ru": "Rutube", "1fichier.com": "1Fichier", "uptobox.com": "Uptobox",
    "uqload.com": "Uqload", "pstream.net": "Pstream",
    "vidsrc.to": "VidSrc", "vidsrc.xyz": "VidSrc", "vidsrc.me": "VidSrc",
    "vidsrc.cc": "VidSrc", "vidsrc.pm": "VidSrc", "vidsrc.in": "VidSrc",
    "vidsrc.net": "VidSrc", "vidlink.pro": "VidLink", "vidfast.co": "VidFast",
    "vidplay.site": "VidPlay", "vidhide.com": "VidHide", "playerwish.com": "PlayerWish",
    "autoembed.cc": "AutoEmbed", "autoembed.lol": "AutoEmbed", "2embed.cc": "2Embed",
    "embedsu.xyz": "EmbedSU", "smashystream.com": "SmashyStream",
    "streamtape.com": "StreamTape", "streamtape.net": "StreamTape", "streamta.pe": "StreamTape",
    "mixdrop.ag": "MixDrop", "mixdrop.co": "MixDrop", "mixdrop.ps": "MixDrop", "mixdrop.bz": "MixDrop",
    "filemoon.sx": "Filemoon", "filemoon.to": "Filemoon", "filemoon.in": "Filemoon",
    "doodstream.com": "DoodStream", "doodstream.co": "DoodStream", "dood.yt": "DoodStream",
    "ds2video.com": "DoodStream", "vidoza.net": "Vidoza", "upstream.to": "UpStream",
    "streamsb.net": "StreamSB", "streamhub.ink": "StreamHub", "voe.sx": "VOE",
    "netflix.com": "Netflix", "primevideo.com": "Prime Video", "disneyplus.com": "Disney+",
    "hulu.com": "Hulu", "max.com": "Max", "peacocktv.com": "Peacock",
    "paramountplus.com": "Paramount+", "appletv.apple.com": "Apple TV+",
    "crunchyroll.com": "Crunchyroll", "shahid.mbc.net": "Shahid", "osn.com": "OSN",
    "watch.it": "WATCH IT", "starzplay.com": "STARZPLAY", "anghami.com": "Anghami",
    "jawwy.tv": "Jawwy", "stctv.com": "STC TV",
  };

  function urlHost(value) {
    try {
      return new URL(String(value || "").trim()).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return "";
    }
  }

  // "vidsrc.to" → "VidSrc", "example-video.com" → "Example-video": the known
  // platforms keep their real name, everything else reads as a platform anyway.
  function linkHostName(value) {
    const host = urlHost(value);
    if (!host) return "";
    if (HOST_NAMES[host]) return HOST_NAMES[host];
    const parts = host.split(".");
    const base = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    if (HOST_NAMES[`${base}.com`]) return HOST_NAMES[`${base}.com`];
    return base ? base.charAt(0).toUpperCase() + base.slice(1) : host;
  }

  function hostIconUrl(value, size = 128) {
    const host = urlHost(value);
    return host ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=${size}` : "";
  }

  const thumbCache = new Map();
  // { image, name } read from the page itself; both empty when the host does not
  // publish them or the site runs without the proxy.
  async function linkThumb(value) {
    const url = String(value || "").trim();
    if (!url) return { image: "", name: "" };
    if (thumbCache.has(url)) return thumbCache.get(url);
    const pending = (async () => {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 8000);
        const res = await fetch(`/api/thumb?url=${encodeURIComponent(url)}`, { signal: ctl.signal });
        clearTimeout(timer);
        if (!res.ok) return { image: "", name: "" };
        const data = await res.json();
        const image = /^https?:\/\//i.test(String(data?.image || "")) ? String(data.image) : "";
        return { image, name: String(data?.name || "").slice(0, 60) };
      } catch {
        return { image: "", name: "" };
      }
    })();
    thumbCache.set(url, pending);
    return pending;
  }

  /* TMDB's API stops at "which platform carries this title". The prices and the
     presentation types (4K / HD / SD) live on TMDB's watch page, so the server
     reads them for us at /api/providers. A static host without that endpoint
     answers 404 once and the panel carries on with what the API returned. */
  const providerOfferCache = new Map();
  let providerOffersDown = false;

  async function fetchProviderOffers(mediaType, mediaId, region) {
    if (!mediaId || providerOffersDown) return null;
    const key = `${mediaType}:${mediaId}:${String(region || "").toUpperCase()}`;
    if (providerOfferCache.has(key)) return providerOfferCache.get(key);
    const url =
      `/api/providers?media=${encodeURIComponent(mediaType === "tv" ? "tv" : "movie")}` +
      `&id=${encodeURIComponent(mediaId)}&region=${encodeURIComponent(region || "")}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.status === 404) {
        providerOffersDown = true;
        return null;
      }
      if (!res.ok) return null;
      const data = await res.json();
      const payload = data && Array.isArray(data.providers) ? data : null;
      if (payload) providerOfferCache.set(key, payload);
      return payload;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /* Qualities sort from the sharpest down. Legacy values saved before the list
     became SD…8K keep a rank so old rows do not drop to the bottom. */
  const QUALITY_RANK = {
    "8K": 12, "4K": 11, "2K": 10, "FHD": 9, "Full HD": 9, "HD": 8, "SD": 7,
    "1440p": 10, "1080p": 9, "720p": 8, "BluRay": 9, "WEB-DL": 8, "WEBRip": 7,
    "HDRip": 6, "TS": 3, "HDCAM": 2, "CAM": 1,
  };
  /* A link may carry several qualities ("SD, HD, FHD"): it is stored as one
     comma-separated text in the same `quality` column, so older single values keep
     working. Rank = the sharpest quality the link offers. */
  const splitQualities = (value) =>
    String(value == null ? "" : value)
      .split(/[,;|·]+/)
      .map((q) => q.trim())
      .filter(Boolean);
  const qualityRank = (value) =>
    splitQualities(value).reduce((best, q) => {
      const rank = QUALITY_RANK[q] || QUALITY_RANK[QUALITY_BADGE_LOOKUP(q)] || 0;
      return Math.max(best, rank);
    }, 0);

  /* Every stored quality reads as a short badge beside the platform name:
     HD, FHD, 2K, 4K, 8K. Values saved before the list was shortened (Full HD,
     1080p, BluRay…) land on the same badge, and anything unknown is shown as
     written instead of being dropped. */
  const QUALITY_BADGE = {
    "sd": "SD", "480p": "SD", "576p": "SD",
    "hd": "HD", "720p": "HD",
    "fhd": "FHD", "full hd": "FHD", "fullhd": "FHD", "1080p": "FHD", "bluray": "FHD",
    "2k": "2K", "1440p": "2K", "web-dl": "2K", "webdl": "2K",
    "4k": "4K", "2160p": "4K", "uhd": "4K",
    "8k": "8K", "4320p": "8K",
  };

  function qualityBadge(value) {
    const raw = String(value == null ? "" : value).trim();
    if (!raw) return "";
    return QUALITY_BADGE[raw.toLowerCase()] || raw.toUpperCase();
  }

  const QUALITY_BADGE_LOOKUP = (q) => qualityBadge(q);

  /* Every quality of a link as short badges, from the lowest to the sharpest:
     "HD, SD, FHD" → ["SD", "HD", "FHD"]. */
  function qualityList(value) {
    const seen = new Set();
    splitQualities(value).forEach((q) => {
      const badge = qualityBadge(q);
      if (badge) seen.add(badge);
    });
    return [...seen].sort((a, b) => (QUALITY_RANK[a] || 0) - (QUALITY_RANK[b] || 0) || a.localeCompare(b));
  }

  const qualityLabel = (value) => qualityList(value).join(" · ");

  /* The interface language as a link stores it ("ar" → "Arabic"). LANG_NAMES
     above holds the native names for the settings list, so this map is separate:
     it has to match the values written into original_language / subtitles. */
  const UI_LANG_NAME = {
    en: "English", ar: "Arabic", fr: "French", de: "German",
    es: "Spanish", nl: "Dutch", it: "Italian",
  };

  /* Does this link speak the visitor's language, as audio or as subtitles?
     "all" subtitles count as a match for everybody. */
  function linkLangMatch(row, langName) {
    if (!langName) return false;
    const want = String(langName).toLowerCase();
    if (String(row?.original_language || "").toLowerCase() === want) return true;
    const subs = String(row?.subtitle_languages || "").toLowerCase();
    if (!row?.has_subtitles || !subs) return false;
    if (subs === "all") return true;
    return subs.split(",").map((s) => s.trim()).includes(want);
  }

  function sortLinksForViewer(rows, langName) {
    return rows.slice().sort((a, b) => {
      const lang = Number(linkLangMatch(b, langName)) - Number(linkLangMatch(a, langName));
      if (lang) return lang;
      const quality = qualityRank(b.quality) - qualityRank(a.quality);
      if (quality) return quality;
      return String(b.added_at || "").localeCompare(String(a.added_at || ""));
    });
  }

  /* ── Clicks on a member link ────────────────────────────────────────────
     The counter lives on the link row itself (movielink / tvlink .clicks), so the
     watch page sorts "most viewed first" and the points rule (1000 clicks on a
     download link = 1 point) both read one number instead of a whole log.
     Every click is additionally written to public.link_clicks with the viewer,
     which is what stops a refresh loop from doing the counting: one viewer counts
     once per link per day. On a database that has not run the new sql/links.sql
     yet the whole call is a no-op and the old count stays. */
  const LINK_CLICK_WINDOW_MS = 24 * 60 * 60 * 1000;
  const GUEST_ID_KEY = "cineaura_guest_id";

  /* One id per browser: without a session the counter still knows a refresh from
     a new viewer, which is what keeps the dedupe above honest. */
  function stableGuestId() {
    try {
      const stored = localStorage.getItem(GUEST_ID_KEY);
      if (stored) return stored;
      const id = `GUEST${Date.now()}${Math.floor(Math.random() * 1000)}`;
      localStorage.setItem(GUEST_ID_KEY, id);
      return id;
    } catch {
      return `GUEST${Date.now()}`;
    }
  }

  async function countLinkClick(table, row, { viewerId = "", mediaType = "" } = {}) {
    const id = Number(row?.id);
    const current = Number(row?.clicks || 0);
    if (!id || !table) return current;
    const viewer = String(viewerId || "");
    const kind = linkKindOf(row);
    if (viewer) {
      const since = new Date(Date.now() - LINK_CLICK_WINDOW_MS).toISOString();
      const seen = await supabaseRequest(
        `/rest/v1/link_clicks?link_table=eq.${restValue(table)}&link_id=eq.${id}` +
          `&viewer_id=eq.${restValue(viewer)}&clicked_at=gt.${encodeURIComponent(since)}&select=id&limit=1`
      );
      if (seen.ok && seen.data?.[0]) return current;
    }
    // Read the counter again before writing: two viewers clicking at the same
    // moment should both be counted.
    const read = await supabaseRequest(`/rest/v1/${table}?id=eq.${id}&select=clicks`);
    const fresh = read.ok ? Number(read.data?.[0]?.clicks) : NaN;
    const next = (Number.isFinite(fresh) ? fresh : current) + 1;
    // The log is best effort: without the table the counter still moves.
    supabaseRequest("/rest/v1/link_clicks", {
      method: "POST",
      body: JSON.stringify({
        link_table: table,
        link_id: id,
        link_kind: kind,
        tmdb_id: Number(row.tmdb_id) || 0,
        media_type: mediaType || String(row.media_type || ""),
        season: row.season == null ? null : Number(row.season),
        episode: row.episode == null ? null : Number(row.episode),
        owner_id: String(row.member_id || ""),
        owner_username: String(row.username || ""),
        viewer_id: viewer,
        watch_url: String(row.watch_url || "").slice(0, 600),
      }),
    }).catch(() => {});
    const saved = await supabaseRequest(`/rest/v1/${table}?id=eq.${id}`, {
      method: "PATCH",
      body: JSON.stringify({ clicks: next }),
    });
    if (!saved.ok) return current;
    row.clicks = next;
    return next;
  }

  /* Sum of one numeric column over the rows of a query (used for the download
     clicks behind the points rule). Pages of 1000 rows keep large accounts exact
     without ever counting them in the browser. */
  async function sumColumn(path, column, { pages = 5, pageSize = 1000 } = {}) {
    let total = 0;
    for (let page = 0; page < pages; page++) {
      const res = await supabaseRequest(
        `${path}${path.includes("?") ? "&" : "?"}select=${column}&limit=${pageSize}&offset=${page * pageSize}`
      );
      if (!res.ok || !Array.isArray(res.data)) return total;
      res.data.forEach((row) => {
        total += Number(row?.[column]) || 0;
      });
      if (res.data.length < pageSize) break;
    }
    return total;
  }


  // ---------- apps: the "Get the app" cards of the home page and Panel > Apps ----------
  // One entry per platform. The download link and version of each come from the
  // app_downloads table (sql/apps.sql), written from Panel > Apps: a platform with
  // a link is available, one without shows "Coming soon". The logos come from
  // Simple Icons (CC0); Windows and Android TV are drawn here.
  const OS_LOGOS = {
    windows: '<svg viewBox="0 0 24 24" width="30" height="30" focusable="false" aria-hidden="true"><path fill="#2f9bf1" d="M2.5 2.5h9v9h-9zM12.5 2.5h9v9h-9zM2.5 12.5h9v9h-9zM12.5 12.5h9v9h-9z"/></svg>',
    linux: '<svg viewBox="0 0 24 24" width="30" height="30" focusable="false" aria-hidden="true"><path fill="currentColor" d="M12.504 0c-.155 0-.315.008-.48.021-4.226.333-3.105 4.807-3.17 6.298-.076 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.832-.41 1.684-.287 2.489a.424.424 0 00-.11.135c-.26.268-.45.6-.663.839-.199.199-.485.267-.797.4-.313.136-.658.269-.864.68-.09.189-.136.394-.132.602 0 .199.027.4.055.536.058.399.116.728.04.97-.249.68-.28 1.145-.106 1.484.174.334.535.47.94.601.81.2 1.91.135 2.774.6.926.466 1.866.67 2.616.47.526-.116.97-.464 1.208-.946.587-.003 1.23-.269 2.26-.334.699-.058 1.574.267 2.577.2.025.134.063.198.114.333l.003.003c.391.778 1.113 1.132 1.884 1.071.771-.06 1.592-.536 2.257-1.306.631-.765 1.683-1.084 2.378-1.503.348-.199.629-.469.649-.853.023-.4-.2-.811-.714-1.376v-.097l-.003-.003c-.17-.2-.25-.535-.338-.926-.085-.401-.182-.786-.492-1.046h-.003c-.059-.054-.123-.067-.188-.135a.357.357 0 00-.19-.064c.431-1.278.264-2.55-.173-3.694-.533-1.41-1.465-2.638-2.175-3.483-.796-1.005-1.576-1.957-1.56-3.368.026-2.152.236-6.133-3.544-6.139zm.529 3.405h.013c.213 0 .396.062.584.198.19.135.33.332.438.533.105.259.158.459.166.724 0-.02.006-.04.006-.06v.105a.086.086 0 01-.004-.021l-.004-.024a1.807 1.807 0 01-.15.706.953.953 0 01-.213.335.71.71 0 00-.088-.042c-.104-.045-.198-.064-.284-.133a1.312 1.312 0 00-.22-.066c.05-.06.146-.133.183-.198.053-.128.082-.264.088-.402v-.02a1.21 1.21 0 00-.061-.4c-.045-.134-.101-.2-.183-.333-.084-.066-.167-.132-.267-.132h-.016c-.093 0-.176.03-.262.132a.8.8 0 00-.205.334 1.18 1.18 0 00-.09.4v.019c.002.089.008.179.02.267-.193-.067-.438-.135-.607-.202a1.635 1.635 0 01-.018-.2v-.02a1.772 1.772 0 01.15-.768c.082-.22.232-.406.43-.533a.985.985 0 01.594-.2zm-2.962.059h.036c.142 0 .27.048.399.135.146.129.264.288.344.465.09.199.14.4.153.667v.004c.007.134.006.2-.002.266v.08c-.03.007-.056.018-.083.024-.152.055-.274.135-.393.2.012-.09.013-.18.003-.267v-.015c-.012-.133-.04-.2-.082-.333a.613.613 0 00-.166-.267.248.248 0 00-.183-.064h-.021c-.071.006-.13.04-.186.132a.552.552 0 00-.12.27.944.944 0 00-.023.33v.015c.012.135.037.2.08.334.046.134.098.2.166.268.01.009.02.018.034.024-.07.057-.117.07-.176.136a.304.304 0 01-.131.068 2.62 2.62 0 01-.275-.402 1.772 1.772 0 01-.155-.667 1.759 1.759 0 01.08-.668 1.43 1.43 0 01.283-.535c.128-.133.26-.2.418-.2zm1.37 1.706c.332 0 .733.065 1.216.399.293.2.523.269 1.052.468h.003c.255.136.405.266.478.399v-.131a.571.571 0 01.016.47c-.123.31-.516.643-1.063.842v.002c-.268.135-.501.333-.775.465-.276.135-.588.292-1.012.267a1.139 1.139 0 01-.448-.067 3.566 3.566 0 01-.322-.198c-.195-.135-.363-.332-.612-.465v-.005h-.005c-.4-.246-.616-.512-.686-.71-.07-.268-.005-.47.193-.6.224-.135.38-.271.483-.336.104-.074.143-.102.176-.131h.002v-.003c.169-.202.436-.47.839-.601.139-.036.294-.065.466-.065zm2.8 2.142c.358 1.417 1.196 3.475 1.735 4.473.286.534.855 1.659 1.102 3.024.156-.005.33.018.513.064.646-1.671-.546-3.467-1.089-3.966-.22-.2-.232-.335-.123-.335.59.534 1.365 1.572 1.646 2.757.13.535.16 1.104.021 1.67.067.028.135.06.205.067 1.032.534 1.413.938 1.23 1.537v-.043c-.06-.003-.12 0-.18 0h-.016c.151-.467-.182-.825-1.065-1.224-.915-.4-1.646-.336-1.77.465-.008.043-.013.066-.018.135-.068.023-.139.053-.209.064-.43.268-.662.669-.793 1.187-.13.533-.17 1.156-.205 1.869v.003c-.02.334-.17.838-.319 1.35-1.5 1.072-3.58 1.538-5.348.334a2.645 2.645 0 00-.402-.533 1.45 1.45 0 00-.275-.333c.182 0 .338-.03.465-.067a.615.615 0 00.314-.334c.108-.267 0-.697-.345-1.163-.345-.467-.931-.995-1.788-1.521-.63-.4-.986-.87-1.15-1.396-.165-.534-.143-1.085-.015-1.645.245-1.07.873-2.11 1.274-2.763.107-.065.037.135-.408.974-.396.751-1.14 2.497-.122 3.854a8.123 8.123 0 01.647-2.876c.564-1.278 1.743-3.504 1.836-5.268.048.036.217.135.289.202.218.133.38.333.59.465.21.201.477.335.876.335.039.003.075.006.11.006.412 0 .73-.134.997-.268.29-.134.52-.334.74-.4h.005c.467-.135.835-.402 1.044-.7zm2.185 8.958c.037.6.343 1.245.882 1.377.588.134 1.434-.333 1.791-.765l.211-.01c.315-.007.577.01.847.268l.003.003c.208.199.305.53.391.876.085.4.154.78.409 1.066.486.527.645.906.636 1.14l.003-.007v.018l-.003-.012c-.015.262-.185.396-.498.595-.63.401-1.746.712-2.457 1.57-.618.737-1.37 1.14-2.036 1.191-.664.053-1.237-.2-1.574-.898l-.005-.003c-.21-.4-.12-1.025.056-1.69.176-.668.428-1.344.463-1.897.037-.714.076-1.335.195-1.814.12-.465.308-.797.641-.984l.045-.022zm-10.814.049h.01c.053 0 .105.005.157.014.376.055.706.333 1.023.752l.91 1.664.003.003c.243.533.754 1.064 1.189 1.637.434.598.77 1.131.729 1.57v.006c-.057.744-.48 1.148-1.125 1.294-.645.135-1.52.002-2.395-.464-.968-.536-2.118-.469-2.857-.602-.369-.066-.61-.2-.723-.4-.11-.2-.113-.602.123-1.23v-.004l.002-.003c.117-.334.03-.752-.027-1.118-.055-.401-.083-.71.043-.94.16-.334.396-.4.69-.533.294-.135.64-.202.915-.47h.002v-.002c.256-.268.445-.601.668-.838.19-.201.38-.336.663-.336zm7.159-9.074c-.435.201-.945.535-1.488.535-.542 0-.97-.267-1.28-.466-.154-.134-.28-.268-.373-.335-.164-.134-.144-.333-.074-.333.109.016.129.134.199.2.096.066.215.2.36.333.292.2.68.467 1.167.467.485 0 1.053-.267 1.398-.466.195-.135.445-.334.648-.467.156-.136.149-.267.279-.267.128.016.034.134-.147.332a8.097 8.097 0 01-.69.468zm-1.082-1.583V5.64c-.006-.02.013-.042.029-.05.074-.043.18-.027.26.004.063 0 .16.067.15.135-.006.049-.085.066-.135.066-.055 0-.092-.043-.141-.068-.052-.018-.146-.008-.163-.065zm-.551 0c-.02.058-.113.049-.166.066-.047.025-.086.068-.14.068-.05 0-.13-.02-.136-.068-.01-.066.088-.133.15-.133.08-.031.184-.047.259-.005.019.009.036.03.03.05v.02h.003z"/></svg>',
    apple: '<svg viewBox="0 0 24 24" width="30" height="30" focusable="false" aria-hidden="true"><path fill="currentColor" d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg>',
    android: '<svg viewBox="0 0 24 24" width="30" height="30" focusable="false" aria-hidden="true"><path fill="#3ddc84" d="M18.4395 5.5586c-.675 1.1664-1.352 2.3318-2.0274 3.498-.0366-.0155-.0742-.0286-.1113-.043-1.8249-.6957-3.484-.8-4.42-.787-1.8551.0185-3.3544.4643-4.2597.8203-.084-.1494-1.7526-3.021-2.0215-3.4864a1.1451 1.1451 0 0 0-.1406-.1914c-.3312-.364-.9054-.4859-1.379-.203-.475.282-.7136.9361-.3886 1.5019 1.9466 3.3696-.0966-.2158 1.9473 3.3593.0172.031-.4946.2642-1.3926 1.0177C2.8987 12.176.452 14.772 0 18.9902h24c-.119-1.1108-.3686-2.099-.7461-3.0683-.7438-1.9118-1.8435-3.2928-2.7402-4.1836a12.1048 12.1048 0 0 0-2.1309-1.6875c.6594-1.122 1.312-2.2559 1.9649-3.3848.2077-.3615.1886-.7956-.0079-1.1191a1.1001 1.1001 0 0 0-.8515-.5332c-.5225-.0536-.9392.3128-1.0488.5449zm-.0391 8.461c.3944.5926.324 1.3306-.1563 1.6503-.4799.3197-1.188.0985-1.582-.4941-.3944-.5927-.324-1.3307.1563-1.6504.4727-.315 1.1812-.1086 1.582.4941zM7.207 13.5273c.4803.3197.5506 1.0577.1563 1.6504-.394.5926-1.1038.8138-1.584.4941-.48-.3197-.5503-1.0577-.1563-1.6504.4008-.6021 1.1087-.8106 1.584-.4941z"/></svg>',
    androidtv: '<svg viewBox="0 0 24 24" width="30" height="30" focusable="false" aria-hidden="true"><rect x="1.75" y="2.75" width="20.5" height="14.5" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 21h8M12 17.25V21" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path fill="#3ddc84" transform="translate(5.2 3.15) scale(.5667)" d="M18.4395 5.5586c-.675 1.1664-1.352 2.3318-2.0274 3.498-.0366-.0155-.0742-.0286-.1113-.043-1.8249-.6957-3.484-.8-4.42-.787-1.8551.0185-3.3544.4643-4.2597.8203-.084-.1494-1.7526-3.021-2.0215-3.4864a1.1451 1.1451 0 0 0-.1406-.1914c-.3312-.364-.9054-.4859-1.379-.203-.475.282-.7136.9361-.3886 1.5019 1.9466 3.3696-.0966-.2158 1.9473 3.3593.0172.031-.4946.2642-1.3926 1.0177C2.8987 12.176.452 14.772 0 18.9902h24c-.119-1.1108-.3686-2.099-.7461-3.0683-.7438-1.9118-1.8435-3.2928-2.7402-4.1836a12.1048 12.1048 0 0 0-2.1309-1.6875c.6594-1.122 1.312-2.2559 1.9649-3.3848.2077-.3615.1886-.7956-.0079-1.1191a1.1001 1.1001 0 0 0-.8515-.5332c-.5225-.0536-.9392.3128-1.0488.5449zm-.0391 8.461c.3944.5926.324 1.3306-.1563 1.6503-.4799.3197-1.188.0985-1.582-.4941-.3944-.5927-.324-1.3307.1563-1.6504.4727-.315 1.1812-.1086 1.582.4941zM7.207 13.5273c.4803.3197.5506 1.0577.1563 1.6504-.394.5926-1.1038.8138-1.584.4941-.48-.3197-.5503-1.0577-.1563-1.6504.4008-.6021 1.1087-.8106 1.584-.4941z"/></svg>',
  };
  const APP_PLATFORMS = [
    { key: "windows", os: "Windows", app: "CineAura PC", logo: OS_LOGOS.windows },
    { key: "linux", os: "Linux", app: "CineAura PC", logo: OS_LOGOS.linux },
    { key: "macos", os: "macOS", app: "CineAura PC", logo: OS_LOGOS.apple },
    { key: "android", os: "Android", app: "CineAura Mobile", logo: OS_LOGOS.android },
    { key: "ios", os: "iPhone", app: "CineAura Mobile", logo: OS_LOGOS.apple },
    { key: "androidtv", os: "Android TV", app: "CineAura TV", logo: OS_LOGOS.androidtv },
  ];

  // A download link is a web address (http/https) or a file on this site
  // (/downloads/…). Anything else (javascript:, data:, //host) counts as none.
  function appDownloadUrl(value) {
    const url = String(value || "").trim();
    if (!url || url.length > 1000 || /[\s<>"'`]/.test(url)) return "";
    if (/^https?:\/\/[^/?#\s]+/i.test(url)) return url;
    if (/^\/[^/\\]/.test(url)) return url;
    return "";
  }

  // "1.0", "v1.0" and "1.0v" all read 1.0
  const appVersion = (value) => String(value || "").trim().replace(/^v\s*/i, "").replace(/\s*v$/i, "").slice(0, 20);

  window.CineAura = {
    API_KEY,
    API,
    IMG,
    SESSION_KEY,
    CODE_KEY,
    SUPABASE_URL,
    SUPABASE_KEY,
    TMDB_KEY: API_KEY,
    CODE_MESSAGES,
    LANGS,
    t,
    tr,
    langText,
    getLang,
    getTheme,
    getLocale,
    applyPrefs,
    translateDom,
    mountSideToggle,
    hydratePrefsFromProfile,
    adsEligible,
    adFreeActive,
    membership,
    openSettings,
    $,
    $$,
    toast,
    isLoggedIn,
    getSession,
    setSession,
    getReferralAttribution,
    clearReferralAttribution,
    renderAuth,
    logout,
    downloadAccountTxt,
    guardFeature,
    LINK_QUALITIES,
    LINK_LANGUAGES,
    LINK_KINDS,
    linkKindOf,
    validWatchUrl,
    linkQualityOptions,
    linkLanguageOptions,
    langPickerHtml,
    selectedLangs,
    bindLangPicker,
    saveWatchLink,
    publishWatchLink,
    LINK_KIND_CHOICES,
    linkKindsFor,
    urlHost,
    linkHostName,
    hostIconUrl,
    linkThumb,
    qualityRank,
    qualityBadge,
    qualityList,
    qualityLabel,
    qualityPickerHtml,
    selectedQualities,
    UI_LANG_NAME,
    linkLangMatch,
    sortLinksForViewer,
    countLinkClick,
    stableGuestId,
    sumColumn,
    detectGeo,
    manualCountry,
    currentCountry,
    countryName,
    countryChoices,
    setSiteCountry,
    membership,
    adFreeFlag,
    setAdFreeFlag,
    fetchProviderOffers,
    iptvKind,
    iptvM3uUrl,
    iptvEpgUrl,
    m3uHeaderEpg,
    iptvIsFree,
    iptvOwnedBy,
    iptvVisibleFilter,
    iptvVisibleTo,
    iptvExpiry,
    iptvTiming,
    APP_PLATFORMS,
    appDownloadUrl,
    appVersion,
    parseDuration,
    durationLabel,
    fetchPlaylistText,
    parseM3U,
    iptvDetailRows,
    iptvActionsHtml,
    bindIptvActions,
    normalizeRecoveryCode,
    restValue,
    imgUrl,
    formatRuntime,
    formatDate,
    ratingText,
    ratingPercent,
    escapeHtml,
    watchHref,
    personHref,
    personCredits,
    initialsAvatar,
    avatarUrlFor,
    avatarSrc,
    avatarImg,
    primeAvatars,
    hydrateAvatars,
    refreshAvatar,
    uploadAvatar,
    avatarPublicUrl,
    avatarFieldHtml,
    wireAvatarField,
    planIsPremium,
    profilesByIds,
    profilesByUsernames,
    fetchStaff,
    photo,
    tmdb,
    verifyCode,
    codeFailure,
    accountCheck,
    accountDeadlineText,
    accountBanText,
    accountDateText,
    readCodeLock,
    recordFailedCode,
    clearCodeLock,
    codeLockLeft,
    CODE_FAIL_MAX,
    IPTV_LISTS,
    hasCredentialSlots,
    fillCredentials,
    storedIptvLogin,
    storeIptvLogin,
    forgetIptvLogin,
    premiumLogin,
    premiumUnlock,
    premiumCodeMessage,
    navIcon,
    deviceMac,
    deviceName,
    publicIp,
    DEVICE_TYPES,
    deviceType,
    deviceTypeIcon,
    normalizeMac,
    AGE_TIERS,
    AGE_UNKNOWN,
    AGE_GATE_MIN,
    AGE_NO_PREVIEW,
    CODE_SCORE_OVER,
    certAge,
    titleCerts,
    titleAge,
    ageTier,
    codeAgeTier,
    tierForAge,
    ageGate,
    titleNeedsCode,
    getStoredCode,
    setStoredCode,
    clearStoredCode,
    setupChrome,
    profileHref,
    postHref,
    absoluteUrl,
    shareTargets,
    shareRowHtml,
    copyText,
    trackPostEvent,
    trackImpressions,
    wireSessionNav,
    posterCard,
    sha256,
    supabaseRequest,
    POINT_RATES,
    STORED_POINT_COLUMNS,
    siteLink,
    PATREON_DEFAULT,
    countRows,
    pointParts,
    pointBreakdown,
    pointsEarned,
    WATCH_TIERS,
    POINT_LEVELS,
    watchTier,
    pointLevel,
    levelMultiplier,
    levelName,
    levelInfo,
    compactPoints,
    levelHtml,
    pointRowHtml,
    memberPoints,
    memberSpends,
    rpc,
    pointsHtml,
    normalizeAccountStatus,
    notifyFollowers,
    NOTES_PAGE,
    noteTitle,
    noteHref,
    noteWhen,
    noteFullDate,
    noteTextHtml,
    markNotesRead,
    showAuthGate,
    hideAuthGate,
    syncAuthGate,
    sessionWriteBlocked,
    authGateEnabled,
  };
})();
