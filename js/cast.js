(() => {
  const {
    $,
    tmdb,
    photo,
    formatDate,
    escapeHtml,
    posterCard,
    setupChrome,
    toast,
    t,
    getSession,
    supabaseRequest,
    restValue,
  } = window.CineAura;

  const personId = new URLSearchParams(location.search).get("person");
  const state = { person: null, follow: null, block: null, sqlMissing: false };

  function uniqueById(items) {
    const seen = new Set();
    return items.filter((item) => {
      if (!item?.id || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }

  function sortCredits(items) {
    return uniqueById(items).sort((a, b) => {
      const da = a.release_date || a.first_air_date || "";
      const db = b.release_date || b.first_air_date || "";
      return db.localeCompare(da);
    });
  }

  function rail(title, kicker, items, type) {
    if (!items.length) {
      return `<section class="rail-section"><div class="glass empty-note"><h2>${title}</h2><p>${t("dash.noYet", { what: type === "tv" ? t("common.series") : t("common.movies") })}</p></div></section>`;
    }
    return `
      <section class="rail-section">
        <div class="section-head">
          <div>
            <div class="kicker"><span class="eyebrow">${kicker}</span></div>
            <h2>${title}</h2>
          </div>
        </div>
        <div class="rail-track">
          ${items.map((item) => posterCard(item, type)).join("")}
        </div>
      </section>
    `;
  }

  const newPostId = () => `P${Math.floor(100000000 + Math.random() * 900000000)}`;

  /* ---------- Follow / block / recommend this person ---------- */
  async function loadPersonState() {
    state.follow = null;
    state.block = null;
    state.sqlMissing = false;
    const session = getSession();
    if (!session?.member_id || !personId) return;
    const [fol, blk] = await Promise.all([
      supabaseRequest(
        `/rest/v1/person_follows?member_id=eq.${restValue(session.member_id)}&person_id=eq.${Number(personId)}&select=*`
      ),
      supabaseRequest(
        `/rest/v1/person_blocks?member_id=eq.${restValue(session.member_id)}&person_id=eq.${Number(personId)}&select=*`
      ),
    ]);
    if (fol.data?.code === "PGRST205" || blk.data?.code === "PGRST205") {
      state.sqlMissing = true;
      return;
    }
    state.follow = fol.ok && Array.isArray(fol.data) ? fol.data[0] || null : null;
    state.block = blk.ok && Array.isArray(blk.data) ? blk.data[0] || null : null;
  }

  function renderPersonActions() {
    const box = $("#person-actions");
    if (!box) return;
    const session = getSession();
    const name = state.person?.name || "";
    if (!session?.member_id) {
      box.innerHTML = `
        <p class="muted">${t("cast.signInActs", { name: escapeHtml(name) })}</p>
        <a class="btn btn-sm btn-primary" href="./login.html">${t("common.signin")}</a>`;
      return;
    }
    if (state.sqlMissing) {
      box.innerHTML = `<p class="muted">${t("prof.personSql")}</p>`;
      return;
    }
    const following = Boolean(state.follow);
    const blocked = Boolean(state.block);
    box.innerHTML = `
      <div class="person-actions-row">
        <button class="btn btn-sm ${following ? "btn-ghost" : "btn-primary"}" type="button" id="pa-follow"${blocked ? " disabled" : ""}>
          ${following ? t("cast.unfollow") : t("cast.follow")}
        </button>
        <button class="btn btn-sm ${blocked ? "btn-ghost" : "btn-danger"}" type="button" id="pa-block">
          ${blocked ? t("cast.unblock") : t("cast.block")}
        </button>
        <button class="btn btn-sm btn-ghost" type="button" id="pa-rec">${t("cast.recommend")}</button>
      </div>
      <p class="muted">${
        blocked
          ? t("cast.blockedNote")
          : following
            ? t("cast.followingNote")
            : t("cast.followNote")
      }</p>`;
    $("#pa-follow").onclick = onFollowPerson;
    $("#pa-block").onclick = onBlockPerson;
    $("#pa-rec").onclick = openRecommendModal;
  }

  async function onFollowPerson() {
    const session = getSession();
    const name = state.person?.name || "";
    if (state.follow) {
      const res = await supabaseRequest(
        `/rest/v1/person_follows?member_id=eq.${restValue(session.member_id)}&person_id=eq.${Number(personId)}`,
        { method: "DELETE" }
      );
      if (!res.ok) return toast(t("cast.actFail"));
      state.follow = null;
      toast(t("cast.unfollowed", { name }));
      renderPersonActions();
      return;
    }
    if (state.block) return toast(t("cast.unblockFirst"));
    const saved = await supabaseRequest("/rest/v1/person_follows", {
      method: "POST",
      body: JSON.stringify({
        member_id: session.member_id,
        person_id: Number(personId),
        person_name: name,
      }),
    });
    if (!saved.ok) return toast(t("cast.actFail"));
    state.follow = saved.data?.[0] || { member_id: session.member_id, person_id: Number(personId), person_name: name };
    toast(t("cast.followed", { name }));
    renderPersonActions();
  }

  async function onBlockPerson() {
    const session = getSession();
    const name = state.person?.name || "";
    if (state.block) {
      const res = await supabaseRequest(
        `/rest/v1/person_blocks?member_id=eq.${restValue(session.member_id)}&person_id=eq.${Number(personId)}`,
        { method: "DELETE" }
      );
      if (!res.ok) return toast(t("cast.actFail"));
      state.block = null;
      toast(t("cast.unblocked", { name }));
      renderPersonActions();
      return;
    }
    const saved = await supabaseRequest("/rest/v1/person_blocks", {
      method: "POST",
      body: JSON.stringify({
        member_id: session.member_id,
        person_id: Number(personId),
        person_name: name,
      }),
    });
    if (!saved.ok) return toast(t("cast.actFail"));
    state.block = saved.data?.[0] || { member_id: session.member_id, person_id: Number(personId), person_name: name };
    // A blocked person can no longer be followed: no updates at all.
    if (state.follow) {
      await supabaseRequest(
        `/rest/v1/person_follows?member_id=eq.${restValue(session.member_id)}&person_id=eq.${Number(personId)}`,
        { method: "DELETE" }
      );
      state.follow = null;
    }
    toast(t("cast.blockedOk", { name }));
    renderPersonActions();
  }

  // Publish a recommendation post about this person on the member profile.
  async function recommendPerson(title, body) {
    const session = getSession();
    if (!(await window.CineAura.guardFeature("posts"))) return false;
    const info = await window.CineAuraRich.details("person", Number(personId));
    const postId = newPostId();
    const saved = await supabaseRequest("/rest/v1/posts", {
      method: "POST",
      body: JSON.stringify({
        post_id: postId,
        owner_id: session.member_id,
        owner_username: session.username,
        kind: "recommendation",
        title,
        body,
        visibility: "public",
      }),
    });
    if (!saved.ok) {
      toast(t("cast.recFail"));
      return false;
    }
    const row = { ...window.CineAuraRich.toItemRow(info), post_id: postId };
    let items = await supabaseRequest("/rest/v1/post_items", { method: "POST", body: JSON.stringify(row) });
    if (!items.ok) {
      items = await supabaseRequest("/rest/v1/post_items", {
        method: "POST",
        body: JSON.stringify(window.CineAuraRich.baseItemRow(row)),
      });
    }
    await supabaseRequest("/rest/v1/updates", {
      method: "POST",
      body: JSON.stringify({
        actor_id: session.member_id,
        actor_username: session.username,
        kind: "post",
        post_id: postId,
      }),
    });
    await window.CineAura.notifyFollowers({
      ownerId: session.member_id,
      username: session.username,
      title: t("prof.newPost"),
      body: t("prof.updLinePost", {
        actor: `@${session.username}`,
        noun: t("prof.updNounRec"),
        post: `«${title}»`,
      }),
      href: window.CineAura.personHref(Number(personId)),
      visibility: "public",
    });
    if (!items.ok) toast(t("cast.recNoItem"));
    return true;
  }

  function openRecommendModal() {
    const name = state.person?.name || "";
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "cast-rec-overlay";
    overlay.innerHTML = `
      <section class="glass modal-card">
        <span class="eyebrow">${t("cast.recommend")}</span>
        <h2>${escapeHtml(name)}</h2>
        <div class="stack">
          <input id="cr-title" value="${escapeHtml(name)}" placeholder="${t("prof.postTitle")}" />
          <textarea id="cr-body" rows="5" placeholder="${t("cast.recTextPh")}"></textarea>
          <div class="person-actions-row">
            <button class="btn btn-sm btn-primary" type="button" id="cr-go">${t("prof.publish")}</button>
            <button class="btn btn-sm btn-ghost" type="button" id="cr-x">${t("common.cancel")}</button>
          </div>
        </div>
      </section>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });
    $("#cr-x").onclick = () => overlay.remove();
    $("#cr-go").onclick = async () => {
      const title = $("#cr-title").value.trim();
      const body = $("#cr-body").value.trim();
      if (!title || !body) return toast(t("watch.rec.needText"));
      const btn = $("#cr-go");
      btn.disabled = true;
      const ok = await recommendPerson(title, body);
      btn.disabled = false;
      if (!ok) return;
      overlay.remove();
      toast(t("cast.recOk", { name }));
    };
  }

  async function init() {
    setupChrome();
    const root = $("#cast-root");
    if (!personId) {
      root.innerHTML = `<div class="glass page-error"><h2>Cast member not found</h2><a class="btn btn-lg btn-primary" href="./">Back home</a></div>`;
      return;
    }

    try {
      const [person, credits] = await Promise.all([
        tmdb(`/person/${personId}`),
        tmdb(`/person/${personId}/combined_credits`),
      ]);
      state.person = person;

      document.title = `${person.name || "Cast"} — CineAura`;
      const movies = sortCredits(
        (credits.cast || []).concat(credits.crew || []).filter((x) => x.media_type === "movie")
      );
      const series = sortCredits(
        (credits.cast || []).concat(credits.crew || []).filter((x) => x.media_type === "tv")
      );

      const facts = [
        person.known_for_department && `Known for ${person.known_for_department}`,
        person.birthday && `Born ${formatDate(person.birthday)}`,
        person.place_of_birth,
        person.deathday && `Died ${formatDate(person.deathday)}`,
      ].filter(Boolean);

      root.innerHTML = `
        <section class="person-hero">
          <div class="person-photo">
            <img src="${photo(person.profile_path, person.name, "h632")}" alt="${escapeHtml(person.name)}" />
          </div>
          <div>
            <span class="media-badge">Cast & crew</span>
            <h1 style="font-family:var(--serif);font-size:clamp(40px,6vw,68px);line-height:.95;margin:10px 0 8px;font-weight:600">${escapeHtml(person.name || "Unknown")}</h1>
            <!-- Follow / Block / Recommend sit right under the name, not below the biography. -->
            <div class="person-actions glass" id="person-actions"></div>
            <div class="facts">
              ${facts.map((f) => `<span class="chip">${escapeHtml(f)}</span>`).join("")}
            </div>
            <p class="bio">${escapeHtml(person.biography || "No biography is available for this person yet.")}</p>
          </div>
        </section>
        <div class="ad-spot" data-ad="inline"></div>
        ${rail(t("common.movies"), t("common.filmography"), movies, "movie")}
        ${rail(t("common.series"), t("common.television"), series, "tv")}
      `;

      await loadPersonState();
      renderPersonActions();
    } catch (error) {
      console.error(error);
      toast(t("cast.fail"));
      root.innerHTML = `<div class="glass page-error"><h2>Person unavailable</h2><a class="btn btn-lg btn-primary" href="./">Back home</a></div>`;
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
