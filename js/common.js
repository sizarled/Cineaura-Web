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
  const AGE_GATE_MIN = 16;  // from this age a title always needs a code
  const AGE_NO_PREVIEW = 16; // from this age a title plays no preview at all

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

  async function verifyCode(code, options = {}) {
    const clean = String(code || "").replace(/\D/g, "");
    if (!/^\d{6}$/.test(clean)) {
      return { ok: false, reason: "invalid", message: t("code.invalid") };
    }

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
      return { ok: false, reason: "not_found", message: t("code.not_found") };
    }

    const row = rows[0];
    let status = normalizeStatus(row.status);
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      status = "expired";
    }

    if (status === "active") {
      // The code works, but does it reach this title's age rating?
      const required = Number(options.requiredAge || 0);
      if (required > 0) {
        const gate = ageGate(row.age_rating, required);
        if (!gate.allowed) {
          const vars = {
            have: t(gate.tier.label),
            need: t(gate.need.label),
            cert: String(options.cert || ""),
            age: required,
          };
          return {
            ok: false,
            reason: "age",
            message: vars.cert ? t("code.ageBlockedCert", vars) : t("code.ageBlocked", vars),
            tier: gate.tier.id,
            need: gate.need.id,
            row,
          };
        }
      }
      return { ok: true, reason: "active", message: t("code.active"), row };
    }

    return {
      ok: false,
      reason: status,
      message: t(`code.${status}`) !== `code.${status}` ? t(`code.${status}`) : t("code.unknown"),
      row,
    };
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

  /* ---------- Header Bell Notifications ---------- */
  function initHeaderBell() {
    const bellBtn = $("#header-bell-btn");
    const bellDot = $("#header-bell-dot");
    const bellPanel = $("#header-bell-panel");
    if (!bellBtn || !bellPanel) return;

    let notes = [];

    bellBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !bellPanel.hidden;
      bellPanel.hidden = open;
      if (open) return;
      // render notes
      if (notes.length) {
        bellPanel.innerHTML = notes.map((n) => {
          const href = n.href || "./Profile.html";
          return `
          <a class="hnote-row" href="${escapeHtml(href)}" data-note="${escapeHtml(n.id)}">
            <div class="hnote-dot ${n.read ? 'read' : ''}"></div>
            <div>
              <strong>${escapeHtml(tr(n.title || n.kind))}</strong>
              <div style="color:var(--muted);font-size:12px;margin-top:2px">${escapeHtml(n.body || "")} · ${String(n.created_at || "").slice(0, 16).replace("T", " ")}</div>
            </div>
          </a>`;
        }).join("");
      } else {
        bellPanel.innerHTML = `<p style="color:var(--muted);text-align:center;padding:16px 0">${t("prof.noNotes")}</p>`;
      }
      // mark all as read
      notes.filter((n) => !n.read).forEach((n) => {
        supabaseRequest(`/rest/v1/notifications?id=eq.${n.id}`, {
          method: "PATCH",
          body: JSON.stringify({ read: true }),
        });
        n.read = true;
      });
      if (bellDot) bellDot.hidden = true;
    });

    document.addEventListener("click", (e) => {
      if (!bellPanel.hidden && !e.target.closest(".header-bell-wrap")) {
        bellPanel.hidden = true;
      }
    });

    async function poll() {
      const sess = getSession();
      if (!sess?.member_id) return;
      try {
        const res = await supabaseRequest(
          `/rest/v1/notifications?member_id=eq.${restValue(sess.member_id)}&select=*&order=created_at.desc&limit=30`
        );
        notes = res.ok && Array.isArray(res.data) ? res.data : [];
        const unread = notes.some((n) => !n.read);
        if (bellDot) bellDot.hidden = !unread;
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
          const paid = ["Silver", "Gold", "Diamond"].includes(row.membership_type);
          const active = !row.membership_expires_at || new Date(row.membership_expires_at).getTime() > Date.now();
          return { guest: false, premium: paid && active, type: row.membership_type };
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
      const rows = COUNTRY_CODES.map((cc) => [cc, countryName(cc)])
        .filter(([, n]) => n)
        .sort((a, b) => a[1].localeCompare(b[1], getLocale()));
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
  // stream_url is the URL line under #EXTINF: the link the channel player opens.
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
        cur = { name, group: (attrs["group-title"] || "").trim() || "General", logo: attrs["tvg-logo"] || "" };
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
            });
          });
        }
        cur = null;
      }
    });
    return out;
  }

  async function iptvDownloadM3u(a) {
    const url = iptvM3uUrl(a);
    if (!url) return toast(t("dash.iptvDlFail"));
    try {
      const text = await fetchPlaylistText(url);
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
      `EPG: ${server}/xmltv.php?${q}`,
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
    if (iptvKind(a) === "m3u") return row("M3U", a.m3u_url);
    return row(t("panel.iptv.server"), iptvServer(a)) + row(t("panel.iptv.user"), a.xstream_user) + row(t("panel.iptv.pass"), a.xstream_password, true) + row("M3U", iptvM3uUrl(a));
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

     A member earns points from six sources, each at its own rate:

       1 watch minute — yours or through your link —   = 1 point
       5 new members registered through your shared links = 1 point
       500 watch links published (banned links excluded) = 1 point
       10 public or exclusive playlists                = 1 point
       50 public or exclusive recommendations          = 1 point
       100 comments                                    = 1 point

     Fractions are dropped (12 referred registrations are worth 2 points, not 2.4). What a
     member can spend is what they earned minus what they already spent
     (profiles.points_spent), so the bonus points of a source cannot be spent
     twice and the watch minutes themselves are never destroyed.
     ════════════════════════════════════════════════════════════════════ */
  const POINT_RATES = [
    { key: "minutes", per: 1, src: "points.src.minutes", rate: "points.rate.minutes" },
    { key: "shares", per: 5, src: "points.src.shares", rate: "points.rate.shares" },
    { key: "links", per: 500, src: "points.src.links", rate: "points.rate.links" },
    { key: "downloads", per: 1000, src: "points.src.downloads", rate: "points.rate.downloads" },
    { key: "playlists", per: 10, src: "points.src.playlists", rate: "points.rate.playlists" },
    { key: "recommendations", per: 50, src: "points.src.recs", rate: "points.rate.recs" },
    { key: "comments", per: 100, src: "points.src.comments", rate: "points.rate.comments" },
  ];

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
      shares,
      playlists,
      recommendations,
      comments,
      links: movieLinks + tvLinks,
      downloads: movieDl + tvDl,
    };
  }

  // One row per source: what the member has, the rate, and the points it gives.
  function pointBreakdown(parts) {
    return POINT_RATES.map((r) => {
      const count = Number(parts?.[r.key] || 0);
      return { key: r.key, per: r.per, src: r.src, rate: r.rate, count, points: Math.floor(count / r.per) };
    });
  }

  const pointsEarned = (parts) => pointBreakdown(parts).reduce((sum, r) => sum + r.points, 0);

  async function memberPoints(memberId, profile = {}) {
    const parts = await pointParts(memberId, profile);
    const breakdown = pointBreakdown(parts);
    const earned = breakdown.reduce((sum, r) => sum + r.points, 0);
    const spent = Math.max(0, Number(profile.points_spent || 0));
    return { parts, breakdown, earned, spent, available: Math.max(0, earned - spent) };
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

  // The "how you earn points" panel shared by the prize dialog and dashboard.
  function pointsHtml(mp) {
    if (!mp) return "";
    const rows = mp.breakdown
      .map(
        (r) => `
        <li class="pt-row">
          <span class="pt-src">
            <b>${escapeHtml(t(r.src))}</b>
            <small>${escapeHtml(t(r.rate))}</small>
          </span>
          <span class="pt-count">${r.count}</span>
          <span class="pt-pts">+${r.points}</span>
        </li>`
      )
      .join("");
    return `
      <div class="pt-box">
        <div class="pt-head">
          <span>${escapeHtml(t("points.title"))}</span>
          <b class="pt-total">${mp.available}</b>
        </div>
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
    fetchProviderOffers,
    iptvKind,
    iptvM3uUrl,
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
    profilesByIds,
    profilesByUsernames,
    fetchStaff,
    photo,
    tmdb,
    verifyCode,
    AGE_TIERS,
    AGE_UNKNOWN,
    AGE_GATE_MIN,
    AGE_NO_PREVIEW,
    certAge,
    titleCerts,
    titleAge,
    ageTier,
    codeAgeTier,
    tierForAge,
    ageGate,
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
    countRows,
    pointParts,
    pointBreakdown,
    pointsEarned,
    memberPoints,
    memberSpends,
    rpc,
    pointsHtml,
    normalizeAccountStatus,
    notifyFollowers,
    showAuthGate,
    hideAuthGate,
    syncAuthGate,
    sessionWriteBlocked,
    authGateEnabled,
  };
})();
