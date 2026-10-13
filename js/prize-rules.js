/* Shared prize rules: used by the staff panel and by the public prize page.
   Pure helpers + the few Supabase reads they need. Exposes window.PrizeRules. */
(() => {
  const C = window.CineAura;
  const { supabaseRequest, restValue } = C;

  const TIERS = ["Free", "Silver", "Gold", "Diamond"];
  const MODES = ["gift", "challenge", "lottery"];
  // Same list the sign-up form uses, so country names always match members.country.
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
  // Defaults used until sql/prize_admin.sql is run (period: month | concurrent).
  const DEFAULT_LIMITS = {
    Free: { gift: [10, "month"], challenge: [5, "concurrent"], lottery: [1, "month"] },
    Silver: { gift: [50, "month"], challenge: [10, "concurrent"], lottery: [5, "month"] },
    Gold: { gift: [100, "month"], challenge: [50, "concurrent"], lottery: [10, "month"] },
    Diamond: { gift: [500, "month"], challenge: [100, "concurrent"], lottery: [50, "month"] },
  };

  const list = (v) =>
    Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : String(v || "").split(/[,;\n\r]+/).map((x) => x.trim()).filter(Boolean);
  const lc = (v) => String(v || "").trim().toLowerCase();
  const tierIndex = (tier) => Math.max(0, TIERS.indexOf(TIERS.find((x) => lc(x) === lc(tier)) || "Free"));
  const cfgOf = (mode) => {
    const c = mode?.config;
    if (c && typeof c === "object") return c;
    try { return JSON.parse(c || "{}") || {}; } catch { return {}; }
  };
  const dayMs = (v) => (v ? new Date(`${String(v).slice(0, 10)}T00:00:00`).getTime() : null);
  const ageOf = (birth) => {
    const b = birth ? new Date(birth) : null;
    if (!b || Number.isNaN(b.getTime())) return null;
    const n = new Date();
    let a = n.getFullYear() - b.getFullYear();
    if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a -= 1;
    return a;
  };
  const accountDays = (member) => {
    const d = member?.created_at ? Date.parse(member.created_at) : NaN;
    return Number.isNaN(d) ? 0 : Math.floor((Date.now() - d) / 86400000);
  };

  // ---- audience --------------------------------------------------------------
  // audience = { type: public|exclusive|private, countries[], genders[], min_age, max_age,
  //              min_account_days, max_account_days, membership (minimum tier), member_ids[] }
  // member = row of public.members. Returns [] when allowed, otherwise the failed rules.
  function audienceFails(audience, member) {
    const a = audience || {};
    const fails = [];
    const type = lc(a.type || "public");
    if (type === "private") {
      const ids = list(a.member_ids).map(lc);
      if (!ids.includes(lc(member?.member_id))) fails.push("private");
      return fails;
    }
    const countries = list(a.countries).map(lc);
    if (countries.length && !countries.includes(lc(member?.country))) fails.push("country");
    const genders = list(a.genders).map(lc);
    if (genders.length && !genders.includes(lc(member?.gender))) fails.push("gender");
    const age = ageOf(member?.birth_date);
    if (a.min_age && (age === null || age < Number(a.min_age))) fails.push("min_age");
    if (a.max_age && (age === null || age > Number(a.max_age))) fails.push("max_age");
    const days = accountDays(member);
    if (a.min_account_days && days < Number(a.min_account_days)) fails.push("min_account");
    if (a.max_account_days && days > Number(a.max_account_days)) fails.push("max_account");
    if (a.membership && tierIndex(member?.membership_type) < tierIndex(a.membership)) fails.push("membership");
    return fails;
  }

  // ---- windows ------------------------------------------------------------------
  // Window of a mode for one country: the country row wins over the mode / prize dates.
  function windowFor(prize, mode, countryRows, country) {
    const row = (countryRows || []).find((r) => lc(r.country) === lc(country));
    const startsAt = row?.starts_at || mode?.starts_at || prize?.starts_at || null;
    const unlimited = row ? !row.ends_at : Boolean(mode?.unlimited_time) || !(mode?.ends_at || prize?.ends_at);
    const endsAt = row ? row.ends_at || null : mode?.ends_at || prize?.ends_at || null;
    return { startsAt, endsAt: unlimited ? null : endsAt };
  }

  // ---- limits -----------------------------------------------------------------------
  async function loadLimits() {
    const res = await supabaseRequest("/rest/v1/prize_limits?select=*");
    const out = JSON.parse(JSON.stringify(DEFAULT_LIMITS));
    const ok = res.ok && Array.isArray(res.data);
    if (ok) res.data.forEach((r) => { if (out[r.tier]) out[r.tier][r.mode] = [Number(r.limit_count), r.period]; });
    return { limits: out, ok };
  }

  // How many places of each mode the member already uses.
  //   entries = rows of prize_mode_entries of that member, prizes = id -> prize row
  function usage(entries, prizes) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const out = { gift: { month: 0, concurrent: 0 }, challenge: { month: 0, concurrent: 0 }, lottery: { month: 0, concurrent: 0 } };
    (entries || []).forEach((e) => {
      const m = out[lc(e.mode)];
      if (!m) return;
      const st = lc(e.status);
      if (st === "withdrawn" || st === "excluded") return;
      if (Date.parse(e.created_at || 0) >= monthStart) m.month += 1;
      const prize = prizes?.[e.prize_id];
      if (st === "competitor" && lc(prize?.status || "active") !== "ended") m.concurrent += 1;
    });
    return out;
  }

  function limitCheck(limits, tier, mode, used) {
    const [cap, period] = limits?.[TIERS[tierIndex(tier)]]?.[mode] || [0, "month"];
    const have = used?.[mode]?.[period] || 0;
    return { cap, period, have, ok: have < cap };
  }

  // ---- requirement progress ---------------------------------------------------------
  // What each member did since THEIR OWN join date. `sinceBy` is { memberId: ISO date }
  // (or a single ISO string for everybody). One query per source for all members.
  async function activityCounts(memberIds, sinceBy) {
    const ids = [...new Set((memberIds || []).map(String).filter(Boolean))];
    const out = {};
    ids.forEach((id) => (out[id] = { link_shares: 0, playlists: 0, recommendations: 0, comments: 0, follows: 0, watch_minutes: 0, movies: 0, series: 0, seen: new Set() }));
    if (!ids.length) return out;
    const sinceOf = (id) => {
      const v = typeof sinceBy === "string" ? sinceBy : sinceBy?.[id];
      const ms = v ? Date.parse(v) : 0;
      return Number.isNaN(ms) ? 0 : ms;
    };
    const times = ids.map(sinceOf).filter(Boolean);
    const min = times.length === ids.length ? new Date(Math.min(...times)).toISOString() : "";
    const inList = `in.(${ids.map((x) => restValue(x)).join(",")})`;
    const from = (col) => (min ? `&${col}=gte.${encodeURIComponent(min)}` : "");
    const rows = async (path) => {
      const res = await supabaseRequest(`${path}&limit=10000`);
      return res.ok && Array.isArray(res.data) ? res.data : [];
    };
    const after = (r, idKey, tsKey) => {
      const o = out[r[idKey]];
      if (!o) return null;
      const ts = Date.parse(r[tsKey] || 0) || 0;
      return ts >= sinceOf(r[idKey]) ? o : null;
    };
    const [shares, lists, posts, comm, follows, views, seen] = await Promise.all([
      rows(`/rest/v1/post_events?kind=eq.share&network=eq.referral&member_id=${inList}${from("created_at")}&select=member_id,created_at`),
      rows(`/rest/v1/playlists?owner_id=${inList}&visibility=in.(public,exclusive)${from("created_at")}&select=owner_id,created_at`),
      rows(`/rest/v1/posts?owner_id=${inList}&kind=in.(recommendation,reclist)&visibility=in.(public,exclusive)${from("created_at")}&select=owner_id,created_at`),
      rows(`/rest/v1/comments?member_id=${inList}${from("created_at")}&select=member_id,created_at`),
      rows(`/rest/v1/person_follows?member_id=${inList}${from("created_at")}&select=member_id,created_at`),
      rows(`/rest/v1/views?viewer_id=${inList}${from("started_at")}&select=viewer_id,minutes,started_at`),
      rows(`/rest/v1/hestory?visitor_id=${inList}${from("visited_at")}&select=visitor_id,tmdb_id,media_type,visited_at`),
    ]);
    shares.forEach((r) => { const o = after(r, "member_id", "created_at"); if (o) o.link_shares += 1; });
    lists.forEach((r) => { const o = after(r, "owner_id", "created_at"); if (o) o.playlists += 1; });
    posts.forEach((r) => { const o = after(r, "owner_id", "created_at"); if (o) o.recommendations += 1; });
    comm.forEach((r) => { const o = after(r, "member_id", "created_at"); if (o) o.comments += 1; });
    follows.forEach((r) => { const o = after(r, "member_id", "created_at"); if (o) o.follows += 1; });
    views.forEach((r) => { const o = after(r, "viewer_id", "started_at"); if (o) o.watch_minutes += Number(r.minutes || 0); });
    seen.forEach((r) => {
      const o = after(r, "visitor_id", "visited_at");
      if (o) o.seen.add(`${r.media_type}:${r.tmdb_id}`);
    });
    Object.values(out).forEach((o) => {
      o.seen.forEach((k) => { if (k.startsWith("tv:")) o.series += 1; else o.movies += 1; });
    });
    return out;
  }

  // Progress of one condition row given the counts of a member.
  function conditionProgress(cond, counts, stored = 0) {
    const kind = String(cond.kind || "watch");
    const req = Math.max(1, Number(cond.required || 1));
    let prog = Number(stored || 0);
    if (kind === "watch") prog = Math.max(prog, counts?.seen?.has(`${cond.media_type || "movie"}:${cond.tmdb_id}`) ? 1 : 0);
    else if (counts && kind in counts && typeof counts[kind] === "number") prog = Math.max(prog, counts[kind]);
    return { req, prog: Math.min(req, prog), done: prog >= req };
  }

  window.PrizeRules = {
    TIERS, MODES, COUNTRIES, DEFAULT_LIMITS,
    list, lc, tierIndex, cfgOf, dayMs, ageOf, accountDays,
    audienceFails, windowFor, loadLimits, usage, limitCheck, activityCounts, conditionProgress,
  };
})();
