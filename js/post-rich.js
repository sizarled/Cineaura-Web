// CineAura rich post items: TMDB details (info / cast / trailer) for
// recommendations, recommendation lists and reviews.
(() => {
  const C = () => window.CineAura;
  const DISPLAY_KEYS = ["info", "cast", "trailer"];
  const CACHE_PREFIX = "cineaura_tmdb_rich_v1:";
  const mem = new Map();

  function lang() {
    try {
      return C().getLang?.() || document.documentElement.lang || "en";
    } catch {
      return "en";
    }
  }

  function esc(v) {
    return C().escapeHtml(v);
  }

  // "info,cast,trailer" -> Set. Missing column (old posts) => everything on.
  function parseDisplay(value) {
    if (value === undefined || value === null) return new Set(DISPLAY_KEYS);
    return new Set(
      String(value)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => DISPLAY_KEYS.includes(s))
    );
  }

  function displayString(set) {
    return DISPLAY_KEYS.filter((k) => set.has(k)).join(",");
  }

  function parseList(value) {
    if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean);
    const raw = String(value || "").trim();
    if (!raw) return [];
    if (raw.startsWith("[")) {
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr.map((s) => String(s).trim()).filter(Boolean);
      } catch {
        /* fall through */
      }
    }
    return raw.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  }

  function pickTrailer(videos) {
    const list = (videos?.results || []).filter((v) => v.site === "YouTube" && v.key);
    const score = (v) =>
      (v.type === "Trailer" ? 4 : v.type === "Teaser" ? 2 : 0) + (v.official ? 1 : 0);
    list.sort((a, b) => score(b) - score(a));
    return list[0]?.key || "";
  }

  function normalize(type, info) {
    if (type === "person") {
      return {
        tmdb_id: info.id,
        media_type: "person",
        title: info.name || "",
        poster_path: info.profile_path || "",
        backdrop_path: "",
        rating: 0,
        year: info.birthday ? String(info.birthday).slice(0, 4) : "",
        genres: info.known_for_department || "",
        overview: info.biography || "",
        cast: [],
        trailer_key: "",
      };
    }
    const date = info.release_date || info.first_air_date || "";
    const credits = info.aggregate_credits || info.credits || {};
    const cast = (credits.cast || []).slice(0, 8).map((c) => ({
      id: c.id,
      name: c.name || "",
      character: c.character || c.roles?.[0]?.character || "",
      profile_path: c.profile_path || "",
    }));
    return {
      tmdb_id: info.id,
      media_type: type,
      title: info.title || info.name || "",
      poster_path: info.poster_path || "",
      backdrop_path: info.backdrop_path || "",
      rating: Number(info.vote_average || 0),
      year: date ? String(date).slice(0, 4) : "",
      genres: (info.genres || []).map((g) => g.name).join(", "),
      overview: info.overview || "",
      cast,
      trailer_key: pickTrailer(info.videos),
    };
  }

  async function details(type, id) {
    const media = type === "tv" ? "tv" : type === "person" ? "person" : "movie";
    const key = `${CACHE_PREFIX}${lang()}:${media}:${id}`;
    if (mem.has(key)) return mem.get(key);
    try {
      const cached = sessionStorage.getItem(key);
      if (cached) {
        const parsed = JSON.parse(cached);
        mem.set(key, parsed);
        return parsed;
      }
    } catch {
      /* ignore */
    }
    const job = (async () => {
      const l = lang();
      const append = media === "person" ? "" : "?append_to_response=credits,videos&include_video_language=" + encodeURIComponent(`${l},en,null`);
      let info = await C().tmdb(`/${media}/${id}${append}`);
      let out = normalize(media, info);
      // Localized overview can be empty: fall back to English text.
      if (media !== "person" && !out.overview && l !== "en") {
        try {
          const en = await fetch(
            `https://api.themoviedb.org/3/${media}/${id}?api_key=${C().TMDB_KEY || ""}&language=en-US`
          );
          if (en.ok) {
            const j = await en.json();
            out.overview = j.overview || "";
          }
        } catch {
          /* ignore */
        }
      }
      try {
        sessionStorage.setItem(key, JSON.stringify(out));
      } catch {
        /* ignore quota */
      }
      return out;
    })();
    mem.set(key, job);
    try {
      const res = await job;
      mem.set(key, res);
      return res;
    } catch (err) {
      mem.delete(key);
      throw err;
    }
  }

  function snapshotFromRow(it) {
    let cast = [];
    if (it.cast_json) {
      try {
        cast = Array.isArray(it.cast_json) ? it.cast_json : JSON.parse(it.cast_json);
      } catch {
        cast = [];
      }
    }
    return {
      tmdb_id: Number(it.tmdb_id),
      media_type: it.media_type || "movie",
      title: it.title || "",
      poster_path: it.poster_path || "",
      backdrop_path: it.backdrop_path || "",
      rating: Number(it.rating || 0),
      year: it.year || "",
      genres: it.genres || "",
      overview: it.overview || "",
      cast: Array.isArray(cast) ? cast : [],
      trailer_key: it.trailer_key || "",
    };
  }

  // Live TMDB details in the viewer's language, stored snapshot as fallback.
  async function enrich(items) {
    return Promise.all(
      (items || []).map(async (it) => {
        const snap = snapshotFromRow(it);
        try {
          const live = await details(snap.media_type, snap.tmdb_id);
          return { ...snap, ...live, title: live.title || snap.title, poster_path: live.poster_path || snap.poster_path };
        } catch {
          return snap;
        }
      })
    );
  }

  // Row for public.post_items (extended columns are optional, see sql/post_reviews.sql).
  function toItemRow(d) {
    return {
      tmdb_id: d.tmdb_id,
      media_type: d.media_type,
      title: d.title || "",
      poster_path: d.poster_path || "",
      rating: Number(d.rating || 0),
      year: d.year || "",
      genres: d.genres || "",
      overview: d.overview || "",
      cast_json: JSON.stringify((d.cast || []).slice(0, 8)),
      trailer_key: d.trailer_key || "",
      backdrop_path: d.backdrop_path || "",
    };
  }

  function baseItemRow(row) {
    const { tmdb_id, media_type, title, poster_path, rating, post_id } = row;
    return { tmdb_id, media_type, title, poster_path, rating, ...(post_id ? { post_id } : {}) };
  }

  function itemHref(it, postId) {
    const { personHref, watchHref } = C();
    return it.media_type === "person"
      ? personHref(it.tmdb_id)
      : watchHref(it.media_type, it.tmdb_id, null, null, postId);
  }

  function trailerHtml(key, title) {
    if (!key) return "";
    return `<button class="rich-trailer" type="button" data-trailer="${esc(key)}" aria-label="${esc(C().t("rich.playTrailer"))}">
      <img src="https://i.ytimg.com/vi/${esc(key)}/hqdefault.jpg" alt="${esc(title)}" loading="lazy" />
      <span class="rich-play" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor"/></svg></span>
      <span class="rich-trailer-label">${esc(C().t("rich.trailer"))}</span>
    </button>`;
  }

  function castHtml(cast) {
    const { imgUrl, initialsAvatar, personHref, t } = C();
    if (!cast?.length) return "";
    return `<div class="rich-cast">
      <span class="rich-label">${esc(t("rich.cast"))}</span>
      <div class="rich-cast-row">
        ${cast
          .slice(0, 6)
          .map(
            (c) => `<a class="rich-actor" href="${personHref(c.id)}" title="${esc(c.name)}">
              <img src="${esc(c.profile_path ? imgUrl(c.profile_path, "w185") : initialsAvatar(c.name))}" alt="" loading="lazy" />
              <strong>${esc(c.name)}</strong>
              ${c.character ? `<span>${esc(c.character)}</span>` : ""}
            </a>`
          )
          .join("")}
      </div>
    </div>`;
  }

  // One rich TMDB block. display = Set of "info" | "cast" | "trailer".
  function itemHtml(it, display, postId, opts = {}) {
    const { imgUrl, initialsAvatar, t } = C();
    const show = display || new Set(DISPLAY_KEYS);
    const href = itemHref(it, postId);
    const poster = it.poster_path ? imgUrl(it.poster_path, "w342") : initialsAvatar(it.title);
    const score = Number(it.rating || 0) ? Number(it.rating).toFixed(1) : "";
    const typeLabel = it.media_type === "tv" ? t("rich.tv") : it.media_type === "person" ? t("rich.person") : t("rich.movie");
    const facts = [
      it.year ? `<span class="chip">${esc(it.year)}</span>` : "",
      `<span class="chip">${esc(typeLabel)}</span>`,
      score ? `<span class="chip rich-score">★ ${score}</span>` : "",
    ].join("");
    const info = show.has("info")
      ? `${it.genres ? `<p class="rich-genres"><span class="rich-label">${esc(t("rich.genre"))}</span> ${esc(it.genres)}</p>` : ""}
         ${it.overview ? `<p class="rich-overview"><span class="rich-label">${esc(t("rich.story"))}</span> ${esc(it.overview)}</p>` : ""}`
      : "";
    const cast = show.has("cast") && it.media_type !== "person" ? castHtml(it.cast) : "";
    const trailer = show.has("trailer") && it.media_type !== "person" ? trailerHtml(it.trailer_key, it.title) : "";
    const removable = opts.removable
      ? `<button class="rich-remove" type="button" data-rich-remove="${esc(`${it.media_type}:${it.tmdb_id}`)}" aria-label="${esc(t("rich.remove"))}">✕</button>`
      : "";
    return `<div class="rich-item${opts.compact ? " compact" : ""}">
      ${removable}
      <a class="rich-poster" href="${href}">
        ${score ? `<span class="score">★ ${score}</span>` : ""}
        <img src="${esc(poster)}" alt="" loading="lazy" />
      </a>
      <div class="rich-body">
        <h4><a href="${href}">${esc(it.title)}</a></h4>
        <div class="meta-row">${facts}</div>
        ${info}
        ${cast}
        ${trailer}
      </div>
    </div>`;
  }

  function reviewListsHtml(pros, cons) {
    const { t } = C();
    const p = parseList(pros);
    const c = parseList(cons);
    if (!p.length && !c.length) return "";
    return `<div class="review-lists">
      <div class="review-col pros">
        <h5>${esc(t("rev.pros"))}</h5>
        ${p.length ? `<ul>${p.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p class="muted">—</p>`}
      </div>
      <div class="review-col cons">
        <h5>${esc(t("rev.cons"))}</h5>
        ${c.length ? `<ul>${c.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p class="muted">—</p>`}
      </div>
    </div>`;
  }

  // Click-to-play trailers (YouTube iframe is only created on demand).
  document.addEventListener("click", (e) => {
    const btn = e.target.closest?.("[data-trailer]");
    if (!btn) return;
    e.preventDefault();
    const key = btn.dataset.trailer;
    const wrap = document.createElement("div");
    wrap.className = "rich-trailer playing";
    wrap.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(key)}?autoplay=1&rel=0" title="Trailer" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
    btn.replaceWith(wrap);
  });

  window.CineAuraRich = {
    DISPLAY_KEYS,
    parseDisplay,
    displayString,
    parseList,
    details,
    enrich,
    toItemRow,
    baseItemRow,
    itemHtml,
    reviewListsHtml,
  };
})();
