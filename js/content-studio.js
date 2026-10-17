/* CineAura — Profile > Your content ("محتواك").

   Three tabs, all about the signed-in member's own videos (sql/content.sql):
     Create      link, title, description, tags (an existing one or a new one), language,
                 age rating, visibility (public / exclusive with its audience / private
                 with its people), playlist and publish time. "Request publish" turns
                 into "Published", or shows the countdown of a scheduled video with
                 "Publish now".
     Manage      every video: thumbnail, title, date added, recommendations, impressions,
                 views, minutes watched, playlist, and Take action (link, duplicate,
                 add to playlist, delete).
     Statistics  the numbers of a period: now (last 60 minutes), today, yesterday, this
                 week, this month, this year.

   window.CineAuraStudio.render(main, { member: { member_id, username } })
*/
(() => {
  "use strict";
  const C = window.CineAura;
  const V = window.CineAuraVideos;
  const { t, escapeHtml, toast } = C;
  const esc = escapeHtml;

  const TABS = ["create", "manage", "stats"];
  const WHEN = ["now", "hour", "day", "week", "later"];
  const WHEN_MS = { hour: 3600e3, day: 86400e3, week: 7 * 86400e3 };
  const PERIODS = ["now", "today", "yesterday", "week", "month", "year"];
  const MAX_TAGS = 12;

  const ICONS = {
    create: '<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><path d="M12 8v8M8 12h8"/>',
    manage: '<path d="M4 6h11M4 11h11M4 16h7"/><path d="M15.5 14.5v6l5-3z"/>',
    stats: '<path d="M3.5 20.5h17"/><path d="M7 17v-5M12 17V6M17 17v-8"/>',
    public: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.6 5.4 3.6 8.5s-1.1 5.9-3.6 8.5c-2.5-2.6-3.6-5.4-3.6-8.5s1.1-5.9 3.6-8.5z"/>',
    exclusive: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
    private: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>',
    dup: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v9A1.5 1.5 0 0 0 5 15.5h3.5"/>',
    pl: '<path d="M4 6h11M4 11h11M4 16h7"/><path d="M17 13v7M13.5 16.5h7"/>',
    del: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
    up: '<path d="M7 11v9H4v-9zM7 11l4-7c1.7 0 2.6 1.2 2.2 2.8L12.6 10H19a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 17.8 20H7"/>',
    down: '<path d="M7 13V4H4v9zM7 13l4 7c1.7 0 2.6-1.2 2.2-2.8L12.6 14H19a2 2 0 0 0 2-2.3l-1.2-6A2 2 0 0 0 17.8 4H7"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  };
  const icon = (k, size = 16) =>
    `<svg class="vs-ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[k] || ""}</svg>`;

  const state = {
    tab: "create",
    main: null,
    member: null,
    draft: null,
    published: null, // the result of the last "Request publish" in Create
    period: "today",
    timers: [],
    playlists: null,
  };

  function clearTimers() {
    state.timers.forEach((id) => clearInterval(id));
    state.timers = [];
  }

  const me = () => state.member?.member_id || "";

  function blankDraft() {
    return {
      url: "",
      thumb: "",
      title: "",
      description: "",
      tags: [],
      language: C.UI_LANG_NAME?.[C.getLang()] || "English",
      age: 3,
      visibility: "public",
      followers: false,
      premium: false,
      countries: [],
      people: "",
      playlist: "",
      playlistName: "",
      when: "now",
      later: "",
    };
  }

  function setupHtml() {
    return `<p class="empty">${esc(t("vid.setup"))}</p>`;
  }

  // ---------------------------------------------------------------- shell
  function render(main, ctx = {}) {
    state.main = main;
    state.member = ctx.member || null;
    const m = /^#content\/(manage|stats)$/.exec(location.hash || "");
    if (m) state.tab = m[1];
    else if (location.hash === "#content") state.tab = state.tab || "create";
    clearTimers();
    main.innerHTML = `
      <p class="eyebrow">${esc(t("vid.studio"))}</p>
      <h1>${esc(t("prof.content"))}</h1>
      <p class="muted">${esc(t("vid.studioLead"))}</p>
      <div class="follow-tabs vs-tabs" role="tablist" aria-label="${esc(t("prof.content"))}">
        ${TABS.map(
          (k) => `<button type="button" role="tab" class="follow-tab" id="vs-tab-${k}" data-vtab="${k}" aria-controls="vs-pane" aria-selected="false">${icon(k)}<span>${esc(t(`vid.tab.${k}`))}</span></button>`
        ).join("")}
      </div>
      <div id="vs-pane" class="vs-pane" role="tabpanel"></div>`;
    main.querySelector(".vs-tabs").onclick = (e) => {
      const b = e.target.closest("[data-vtab]");
      if (b) show(b.dataset.vtab);
    };
    show(state.tab);
  }

  function show(tab) {
    clearTimers();
    closeMenu();
    state.tab = TABS.includes(tab) ? tab : "create";
    state.main.querySelectorAll("[data-vtab]").forEach((b) => {
      const on = b.dataset.vtab === state.tab;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
    });
    const hash = state.tab === "create" ? "#content" : `#content/${state.tab}`;
    if (location.hash !== hash) history.replaceState(history.state, "", `${location.pathname}${location.search}${hash}`);
    const pane = state.main.querySelector("#vs-pane");
    pane.setAttribute("aria-labelledby", `vs-tab-${state.tab}`);
    if (state.tab === "create") drawCreate(pane);
    else if (state.tab === "manage") drawManage(pane);
    else drawStats(pane);
  }

  async function loadPlaylists(force = false) {
    if (state.playlists && !force) return state.playlists;
    const res = await V.call("content_playlists_mine", { p_member: me(), p_content: "" });
    state.playlists = res.ok && Array.isArray(res.data) ? res.data : [];
    return state.playlists;
  }

  // ---------------------------------------------------------------- Create
  function whenHint(d) {
    if (d.when === "now") return t("vid.whenHint.now");
    if (d.when === "later") {
      const at = Date.parse(d.later || "");
      return Number.isFinite(at) ? t("vid.whenHint.at", { date: V.fullDate(new Date(at).toISOString()) }) : t("vid.whenHint.pick");
    }
    return t("vid.whenHint.at", { date: V.fullDate(new Date(Date.now() + WHEN_MS[d.when]).toISOString()) });
  }

  function localInputValue(date) {
    const pad = (x) => String(x).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  async function drawCreate(pane) {
    const d = state.draft || (state.draft = blankDraft());
    pane.innerHTML = `<p class="muted">${esc(t("common.loading"))}</p>`;
    const pls = await loadPlaylists();
    if (state.tab !== "create") return;
    const minLater = localInputValue(new Date(Date.now() + 5 * 60e3));
    pane.innerHTML = `
      <form class="vs-create" id="vc-form" novalidate>
        <div class="vs-create-grid">
          <fieldset class="vs-fields" id="vc-fs">
            <label class="field-label" for="vc-url">${esc(t("vid.f.url"))}</label>
            <input id="vc-url" type="url" inputmode="url" maxlength="2000" autocomplete="off" dir="ltr" placeholder="https://www.youtube.com/watch?v=…" value="${esc(d.url)}" />
            <p class="vs-hint" id="vc-url-hint" aria-live="polite">${esc(t("vid.f.urlHint"))}</p>
            <div id="vc-thumb-wrap" hidden>
              <label class="field-label" for="vc-thumb">${esc(t("vid.f.thumb"))} <small class="muted">${esc(t("dash.dev.optional"))}</small></label>
              <input id="vc-thumb" type="url" inputmode="url" maxlength="1000" dir="ltr" placeholder="https://…/picture.jpg" value="${esc(d.thumb)}" />
              <p class="vs-hint">${esc(t("vid.f.thumbHint"))}</p>
            </div>

            <label class="field-label" for="vc-title">${esc(t("vid.f.title"))}</label>
            <input id="vc-title" maxlength="150" value="${esc(d.title)}" placeholder="${esc(t("vid.f.titlePh"))}" />
            <label class="field-label" for="vc-desc">${esc(t("vid.f.desc"))}</label>
            <textarea id="vc-desc" rows="4" maxlength="5000" placeholder="${esc(t("vid.f.descPh"))}">${esc(d.description)}</textarea>

            <label class="field-label" for="vc-tag">${esc(t("vid.f.tags"))}</label>
            <div class="vs-tagbox">
              <div class="vs-tags" id="vc-tags">
                <span class="vs-chips" id="vc-chips"></span>
                <input id="vc-tag" autocomplete="off" maxlength="30" placeholder="${esc(t("vid.f.tagPh"))}" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="vc-tag-list" />
              </div>
              <div class="glass vs-suggest" id="vc-tag-list" role="listbox" hidden></div>
            </div>
            <p class="vs-hint">${esc(t("vid.f.tagsHint", { n: MAX_TAGS }))}</p>

            <div class="vs-row2">
              <div class="vs-col">
                <label class="field-label" for="vc-lang">${esc(t("vid.f.lang"))}</label>
                <select id="vc-lang">${V.LANGUAGES.map((l) => `<option value="${esc(l)}" ${l === d.language ? "selected" : ""}>${esc(V.langLabel(l))}</option>`).join("")}</select>
              </div>
              <div class="vs-col">
                <label class="field-label" for="vc-pl">${esc(t("vid.f.playlist"))}</label>
                <select id="vc-pl">
                  <option value="">${esc(t("vid.f.noPl"))}</option>
                  ${pls.map((p) => `<option value="${esc(p.id)}" ${p.id === d.playlist ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
                  <option value="__new" ${d.playlist === "__new" ? "selected" : ""}>${esc(t("vid.f.newPl"))}</option>
                </select>
                <input id="vc-plname" maxlength="80" placeholder="${esc(t("vid.newPlPh"))}" value="${esc(d.playlistName)}" aria-label="${esc(t("vid.newPl"))}" hidden />
              </div>
            </div>

            <div class="vs-group">
              <span class="field-label" id="vc-age-l">${esc(t("vid.f.age"))}</span>
              <div class="vs-seg" role="radiogroup" aria-labelledby="vc-age-l">
                ${V.AGES.map((a) => `<label class="vs-seg-opt"><input type="radio" name="vc-age" value="${a}" ${a === Number(d.age) ? "checked" : ""} /><span>${a}+</span></label>`).join("")}
              </div>
              <p class="vs-hint" id="vc-age-hint"></p>
            </div>

            <div class="vs-group">
              <span class="field-label" id="vc-vis-l">${esc(t("pm.visibility"))}</span>
              <div class="vs-vis" role="radiogroup" aria-labelledby="vc-vis-l">
                ${V.VISIBILITIES.map(
                  (v) => `<label class="vs-vis-opt"><input type="radio" name="vc-vis" value="${v}" ${v === d.visibility ? "checked" : ""} />
                    <span><b>${icon(v)}${esc(V.visLabel(v))}</b><small>${esc(t(`vid.visHint.${v}`))}</small></span></label>`
                ).join("")}
              </div>
              <div class="vs-audience" id="vc-excl" hidden>
                <p class="vs-sub">${esc(t("vid.f.exclWho"))}</p>
                <div class="vs-checks">
                  <label class="lang-chip"><input type="checkbox" id="vc-fol" ${d.followers ? "checked" : ""} /> ${esc(t("vid.f.exclFollowers"))}</label>
                  <label class="lang-chip"><input type="checkbox" id="vc-prem" ${d.premium ? "checked" : ""} /> ${esc(t("vid.f.exclPremium"))}</label>
                </div>
                <label class="field-label" for="vc-cty">${esc(t("vid.f.exclCountries"))}</label>
                <div class="vs-cty">
                  <select id="vc-cty"><option value="">${esc(t("vid.f.exclAddCountry"))}</option>${C.countryChoices().map(([cc, n]) => `<option value="${cc}">${esc(n)}</option>`).join("")}</select>
                  <span class="vs-chips" id="vc-cty-chips"></span>
                </div>
                <p class="vs-hint">${esc(t("vid.f.exclHint"))}</p>
              </div>
              <div class="vs-audience" id="vc-priv" hidden>
                <label class="field-label" for="vc-people">${esc(t("vid.f.people"))}</label>
                <input id="vc-people" maxlength="2000" placeholder="${esc(t("dash.peoplePh"))}" value="${esc(d.people)}" />
                <p class="vs-hint">${esc(t("vid.f.peopleHint"))}</p>
              </div>
            </div>

            <div class="vs-group">
              <span class="field-label" id="vc-when-l">${esc(t("vid.f.when"))}</span>
              <div class="vs-seg vs-seg--wrap" role="radiogroup" aria-labelledby="vc-when-l">
                ${WHEN.map((w) => `<label class="vs-seg-opt"><input type="radio" name="vc-when" value="${w}" ${w === d.when ? "checked" : ""} /><span>${esc(t(`vid.when.${w}`))}</span></label>`).join("")}
              </div>
              <div class="vs-later" id="vc-later-wrap" hidden>
                <label class="field-label" for="vc-later">${esc(t("vid.f.laterAt"))}</label>
                <input id="vc-later" type="datetime-local" min="${minLater}" value="${esc(d.later)}" />
              </div>
              <p class="vs-hint" id="vc-when-hint"></p>
            </div>
          </fieldset>
          <aside class="vs-preview" aria-label="${esc(t("rich.preview"))}">
            <span class="eyebrow">${esc(t("rich.preview"))}</span>
            <div id="vc-preview"></div>
          </aside>
        </div>
        <div class="form-alert" id="vc-alert" role="alert"></div>
        <div class="vs-submit" id="vc-submit"></div>
      </form>`;
    wireCreate(pane);
  }

  function readDraft(pane) {
    const d = state.draft;
    const val = (sel) => pane.querySelector(sel)?.value ?? "";
    d.url = val("#vc-url").trim();
    d.thumb = val("#vc-thumb").trim();
    d.title = val("#vc-title");
    d.description = val("#vc-desc");
    d.language = val("#vc-lang");
    d.playlist = val("#vc-pl");
    d.playlistName = val("#vc-plname");
    d.age = Number(pane.querySelector('input[name="vc-age"]:checked')?.value || 3);
    d.visibility = pane.querySelector('input[name="vc-vis"]:checked')?.value || "public";
    d.followers = Boolean(pane.querySelector("#vc-fol")?.checked);
    d.premium = Boolean(pane.querySelector("#vc-prem")?.checked);
    d.people = val("#vc-people");
    d.when = pane.querySelector('input[name="vc-when"]:checked')?.value || "now";
    d.later = val("#vc-later");
    return d;
  }

  // YouTube, Dailymotion, Google Drive and Vimeo give every video a picture; the
  // other links may carry one typed in the (then visible) Thumbnail field.
  function ownThumbAllowed(v) {
    return Boolean(v) && !V.autoThumb(v) && v.provider !== "vimeo";
  }

  function normTag(raw) {
    return String(raw || "").replace(/^#+/, "").replace(/[,\n]+/g, " ").trim().toLowerCase().slice(0, 30);
  }

  function wireCreate(pane) {
    const d = state.draft;
    const $ = (sel) => pane.querySelector(sel);
    const info = () => V.parseVideo(d.url);

    // --- link: what it is, and the optional picture when the provider has none
    const syncUrl = () => {
      readDraft(pane);
      const hint = $("#vc-url-hint");
      const v = info();
      hint.classList.remove("is-ok", "is-bad");
      if (!d.url) {
        hint.textContent = t("vid.f.urlHint");
      } else if (!v) {
        hint.textContent = t("vid.f.urlBad");
        hint.classList.add("is-bad");
      } else {
        hint.textContent = t("vid.f.urlOk", { provider: V.provLabel(v.provider) });
        hint.classList.add("is-ok");
      }
      $("#vc-thumb-wrap").hidden = !ownThumbAllowed(v);
      preview();
    };

    // --- tags
    const chips = $("#vc-chips");
    const tagInput = $("#vc-tag");
    const list = $("#vc-tag-list");
    let tagSeq = 0;
    let tagTimer = 0;
    let active = -1;
    const drawChips = () => {
      chips.innerHTML = d.tags
        .map((x, i) => `<span class="vs-chip"><bdi>#${esc(x)}</bdi><button type="button" data-untag="${i}" aria-label="${esc(t("rich.remove"))} ${esc(x)}">×</button></span>`)
        .join("");
      tagInput.placeholder = d.tags.length >= MAX_TAGS ? "" : t("vid.f.tagPh");
      tagInput.disabled = d.tags.length >= MAX_TAGS;
      preview();
    };
    const addTag = (raw) => {
      const x = normTag(raw);
      if (!x) return;
      if (d.tags.includes(x)) return toast(t("vid.f.tagHave"));
      if (d.tags.length >= MAX_TAGS) return toast(t("vid.f.tagMax", { n: MAX_TAGS }));
      d.tags.push(x);
      tagInput.value = "";
      closeList();
      drawChips();
      tagInput.focus();
    };
    const closeList = () => {
      list.hidden = true;
      list.innerHTML = "";
      active = -1;
      tagInput.setAttribute("aria-expanded", "false");
    };
    const openList = async () => {
      const q = normTag(tagInput.value);
      const seq = ++tagSeq;
      const res = await V.call("content_tags", { p_q: q, p_member: me(), p_limit: 8 });
      if (seq !== tagSeq || document.activeElement !== tagInput) return;
      const used = (res.ok && Array.isArray(res.data) ? res.data : []).filter((r) => !d.tags.includes(r.tag));
      const items = used.map((r) => ({ tag: r.tag, label: `#${r.tag}`, sub: t("vid.f.tagUsed", { n: V.fmtNum(r.count) }) }));
      if (q && !used.some((r) => r.tag === q) && !d.tags.includes(q)) items.push({ tag: q, label: t("vid.f.tagNew", { tag: q }), sub: "", fresh: true });
      if (!items.length) return closeList();
      list.innerHTML = items
        .map(
          (it, i) => `<button type="button" role="option" class="vs-opt${it.fresh ? " is-new" : ""}" id="vc-opt-${i}" data-tag="${esc(it.tag)}" aria-selected="false">
            <span>${esc(it.label)}</span>${it.sub ? `<small>${esc(it.sub)}</small>` : ""}</button>`
        )
        .join("");
      list.hidden = false;
      active = -1;
      tagInput.setAttribute("aria-expanded", "true");
    };
    const moveActive = (step) => {
      const opts = [...list.querySelectorAll("[data-tag]")];
      if (!opts.length) return;
      active = (active + step + opts.length) % opts.length;
      opts.forEach((o, i) => o.setAttribute("aria-selected", String(i === active)));
      tagInput.setAttribute("aria-activedescendant", opts[active].id);
      opts[active].scrollIntoView({ block: "nearest" });
    };
    tagInput.addEventListener("input", () => {
      if (/[,\n]/.test(tagInput.value)) {
        tagInput.value.split(/[,\n]+/).forEach((x) => x.trim() && addTag(x));
        return;
      }
      clearTimeout(tagTimer);
      tagTimer = setTimeout(openList, 180);
    });
    tagInput.addEventListener("focus", () => {
      clearTimeout(tagTimer);
      tagTimer = setTimeout(openList, 60);
    });
    tagInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (list.hidden) openList();
        else moveActive(e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const opt = active >= 0 ? list.querySelectorAll("[data-tag]")[active] : null;
        addTag(opt ? opt.dataset.tag : tagInput.value);
      } else if (e.key === "Escape") {
        closeList();
      } else if (e.key === "Backspace" && !tagInput.value && d.tags.length) {
        d.tags.pop();
        drawChips();
      }
    });
    tagInput.addEventListener("blur", () => setTimeout(() => {
      if (!pane.contains(document.activeElement) || !list.contains(document.activeElement)) closeList();
    }, 150));
    list.addEventListener("mousedown", (e) => e.preventDefault());
    list.addEventListener("click", (e) => {
      const opt = e.target.closest("[data-tag]");
      if (opt) addTag(opt.dataset.tag);
    });
    chips.addEventListener("click", (e) => {
      const b = e.target.closest("[data-untag]");
      if (!b) return;
      d.tags.splice(Number(b.dataset.untag), 1);
      drawChips();
    });
    $("#vc-tags").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) tagInput.focus();
    });

    // --- exclusive countries
    const ctyChips = $("#vc-cty-chips");
    const drawCountries = () => {
      ctyChips.innerHTML = d.countries
        .map((cc) => `<span class="vs-chip">${esc(V.regionLabel(cc))}<button type="button" data-uncty="${cc}" aria-label="${esc(t("rich.remove"))} ${esc(V.regionLabel(cc))}">×</button></span>`)
        .join("");
    };
    $("#vc-cty").addEventListener("change", (e) => {
      const cc = e.target.value;
      if (cc && !d.countries.includes(cc)) d.countries.push(cc);
      e.target.value = "";
      drawCountries();
    });
    ctyChips.addEventListener("click", (e) => {
      const b = e.target.closest("[data-uncty]");
      if (!b) return;
      d.countries = d.countries.filter((x) => x !== b.dataset.uncty);
      drawCountries();
    });

    // --- the parts that show / hide
    const sync = () => {
      readDraft(pane);
      $("#vc-excl").hidden = d.visibility !== "exclusive";
      $("#vc-priv").hidden = d.visibility !== "private";
      $("#vc-plname").hidden = d.playlist !== "__new";
      $("#vc-later-wrap").hidden = d.when !== "later";
      $("#vc-when-hint").textContent = whenHint(d);
      $("#vc-age-hint").textContent = t(`vid.ageHint.${d.age}`);
      preview();
    };
    pane.querySelector("#vc-fs").addEventListener("change", sync);
    pane.querySelector("#vc-fs").addEventListener("input", (e) => {
      if (e.target.id === "vc-url") syncUrl();
      else if (e.target.id !== "vc-tag") sync();
    });
    pane.querySelector('input[name="vc-when"][value="later"]').addEventListener("change", () => {
      const input = $("#vc-later");
      if (!input.value) input.value = localInputValue(new Date(Date.now() + 2 * 3600e3));
      sync();
      input.focus();
    });

    // --- submit
    pane.querySelector("#vc-form").addEventListener("submit", (e) => {
      e.preventDefault();
      publish(pane);
    });

    drawChips();
    drawCountries();
    syncUrl();
    sync();
    drawSubmit(pane);
  }

  function preview() {
    const pane = state.main?.querySelector("#vs-pane");
    const box = pane?.querySelector("#vc-preview");
    if (!box) return;
    const d = state.draft;
    const v = V.parseVideo(d.url);
    const own = ownThumbAllowed(v) && /^https:\/\//i.test(d.thumb) ? d.thumb : "";
    const thumb = own || V.autoThumb(v) || state.vimeoThumb?.[d.url] || "";
    if (v?.provider === "vimeo" && !(state.vimeoThumb || {})[d.url]) {
      state.vimeoThumb = state.vimeoThumb || {};
      state.vimeoThumb[d.url] = "";
      V.fetchThumb(v).then((url) => {
        state.vimeoThumb[d.url] = url;
        if (url) preview();
      });
    }
    const item = {
      id: "preview",
      title: d.title.trim() || t("rich.untitled"),
      thumb,
      age: d.age,
      tags: d.tags,
      visibility: d.visibility,
    };
    const when = d.when === "now" ? t("vid.when.now") : whenHint(d);
    box.innerHTML = `
      <div class="vcard vcard--preview">
        ${V.thumbHtml(item)}
        <span class="vcard-body">
          <b class="vcard-title">${esc(item.title)}</b>
          <span class="vcard-meta"><bdi>@${esc(state.member?.username || "")}</bdi> · ${esc(V.langLabel(d.language))} · ${esc(V.visLabel(d.visibility))}</span>
          ${d.description.trim() ? `<span class="vcard-desc">${esc(d.description.trim())}</span>` : ""}
          ${d.tags.length ? `<span class="vcard-tags">${d.tags.map((x) => `<bdi>#${esc(x)}</bdi>`).join("")}</span>` : ""}
        </span>
      </div>
      <p class="vs-prev-when">${icon("clock", 14)} ${esc(when)}</p>
      ${v ? `<p class="vs-prev-prov">${esc(V.provLabel(v.provider))} · <bdi dir="ltr">${esc(v.host)}</bdi></p>` : ""}`;
  }

  // The button and what replaces it: Published, or the countdown of a scheduled video.
  function drawSubmit(pane) {
    const box = pane.querySelector("#vc-submit");
    if (!box) return;
    const p = state.published;
    clearTimers();
    pane.querySelector("#vc-fs").disabled = Boolean(p);
    if (!p) {
      box.innerHTML = `<button class="btn btn-lg btn-primary" id="vc-go" type="submit">${esc(t("vid.requestPublish"))}</button>`;
      return;
    }
    const at = Date.parse(p.publish_at || "");
    const later = Number.isFinite(at) && at > Date.now() + 1000;
    if (!later) {
      box.innerHTML = `
        <button class="btn btn-lg vs-done" type="button" disabled aria-live="polite">${icon("check", 18)} ${esc(t("vid.published"))}</button>
        <a class="btn btn-lg btn-ghost" href="${V.contentHref(p.id)}">${esc(t("vid.watchIt"))}</a>
        <button class="btn btn-lg btn-ghost" type="button" id="vc-again">${esc(t("vid.createAnother"))}</button>`;
    } else {
      box.innerHTML = `
        <div class="vs-scheduled" role="status">
          <p>${icon("clock", 18)} <span>${esc(t("vid.willPublishIn"))}</span> <b class="vs-cd" id="vc-cd">${esc(V.countdown(at - Date.now()))}</b></p>
          <small class="muted">${esc(V.fullDate(p.publish_at))}</small>
        </div>
        <button class="btn btn-lg btn-primary" type="button" id="vc-now">${esc(t("vid.publishNow"))}</button>
        <button class="btn btn-lg btn-ghost" type="button" id="vc-again">${esc(t("vid.createAnother"))}</button>`;
      const tick = () => {
        const left = at - Date.now();
        const el = pane.querySelector("#vc-cd");
        if (!el) return clearTimers();
        if (left <= 0) {
          p.publish_at = new Date().toISOString();
          drawSubmit(pane);
          return;
        }
        el.textContent = V.countdown(left);
      };
      state.timers.push(setInterval(tick, 1000));
      pane.querySelector("#vc-now").onclick = async (e) => {
        e.currentTarget.disabled = true;
        const res = await V.call("content_publish_now", { p_member: me(), p_id: p.id });
        if (!res.ok || res.data?.ok === false) {
          e.currentTarget.disabled = false;
          return toast(t("vid.actFail"));
        }
        p.publish_at = res.data.publish_at || new Date().toISOString();
        toast(t("vid.publishedToast"));
        drawSubmit(pane);
      };
    }
    pane.querySelector("#vc-again").onclick = () => {
      state.published = null;
      state.draft = blankDraft();
      drawCreate(pane);
    };
  }

  function alertMsg(pane, text) {
    const el = pane.querySelector("#vc-alert");
    if (!el) return;
    el.className = text ? "form-alert show error" : "form-alert";
    el.textContent = text || "";
    if (text) el.scrollIntoView({ block: "nearest", behavior: "instant" });
  }

  const REASONS = {
    member: "vid.err.member",
    blocked: "vid.err.blocked",
    limit: "vid.err.limit",
    url: "vid.f.urlBad",
    title: "vid.err.title",
    description: "vid.err.description",
    age: "vid.err.generic",
    visibility: "vid.err.generic",
    people: "vid.err.people",
    publish_at: "vid.err.when",
    playlist: "vid.err.playlist",
    busy: "vid.err.generic",
  };

  async function publish(pane) {
    const d = readDraft(pane);
    alertMsg(pane, "");
    const v = V.parseVideo(d.url);
    if (!v) {
      pane.querySelector("#vc-url").focus();
      return alertMsg(pane, t("vid.f.urlBad"));
    }
    if (!d.title.trim()) {
      pane.querySelector("#vc-title").focus();
      return alertMsg(pane, t("vid.err.title"));
    }
    const people = d.people.split(/[,;\s]+/).map((x) => x.trim().replace(/^@+/, "")).filter(Boolean);
    if (d.visibility === "private" && !people.length) {
      pane.querySelector("#vc-people").focus();
      return alertMsg(pane, t("vid.err.people"));
    }
    if (d.playlist === "__new" && !d.playlistName.trim()) {
      pane.querySelector("#vc-plname").focus();
      return alertMsg(pane, t("vid.err.playlistName"));
    }
    let publishAt = null;
    if (d.when === "later") {
      const at = Date.parse(d.later || "");
      if (!Number.isFinite(at) || at <= Date.now() + 30e3) {
        pane.querySelector("#vc-later").focus();
        return alertMsg(pane, t("vid.err.when"));
      }
      publishAt = new Date(at).toISOString();
    } else if (WHEN_MS[d.when]) {
      publishAt = new Date(Date.now() + WHEN_MS[d.when]).toISOString();
    }
    if (!(await C.guardFeature("posts"))) return;
    const btn = pane.querySelector("#vc-go");
    btn.disabled = true;
    btn.textContent = t("vid.publishing");
    let thumb = ownThumbAllowed(v) && /^https:\/\//i.test(d.thumb) ? d.thumb : "";
    if (!thumb) thumb = (await V.fetchThumb(v)) || "";
    const body = {
      url: v.url,
      provider: v.provider,
      thumb,
      title: d.title.trim(),
      description: d.description.trim(),
      tags: d.tags,
      language: d.language,
      age: d.age,
      visibility: d.visibility,
      followers: d.followers,
      premium: d.premium,
      countries: d.countries.join(","),
      people,
      playlist: d.playlist && d.playlist !== "__new" ? d.playlist : "",
      playlist_name: d.playlist === "__new" ? d.playlistName.trim() : "",
      publish_at: publishAt,
    };
    const res = await V.call("content_create", { p_member: me(), d: body });
    if (!res.ok || res.data?.ok === false) {
      btn.disabled = false;
      btn.textContent = t("vid.requestPublish");
      if (res.setup) return alertMsg(pane, t("vid.setup"));
      return alertMsg(pane, t(REASONS[res.data?.reason] || "vid.err.generic"));
    }
    state.published = { id: res.data.id, publish_at: res.data.publish_at };
    if (body.playlist_name) state.playlists = null;
    toast(t(res.data.scheduled ? "vid.scheduledToast" : "vid.publishedToast"));
    drawSubmit(pane);
  }

  // A copy of a video, ready in Create: everything but the result of the last publish.
  function draftFrom(row) {
    const d = blankDraft();
    Object.assign(d, {
      url: row.url || "",
      thumb: row.thumb && !V.autoThumb(V.parseVideo(row.url)) ? row.thumb : "",
      title: `${row.title || ""} ${t("vid.copySuffix")}`.slice(0, 150),
      description: row.description || "",
      tags: Array.isArray(row.tags) ? row.tags.slice(0, MAX_TAGS) : [],
      language: row.language || d.language,
      age: Number(row.age) || 3,
      visibility: row.visibility || "public",
      followers: Boolean(row.followers),
      premium: Boolean(row.premium),
      countries: String(row.countries || "").split(",").map((x) => x.trim()).filter(Boolean),
      people: (row.people || []).join(", "),
      playlist: row.playlists?.[0]?.id || "",
    });
    return d;
  }

  // ---------------------------------------------------------------- Manage
  function statusHtml(r) {
    if (r.scheduled) {
      return `<span class="vs-status is-scheduled">${icon("clock", 13)}<span>${esc(t("vid.scheduledIn"))}</span> <b data-cd="${esc(r.publish_at)}">${esc(V.countdown(Date.parse(r.publish_at) - Date.now()))}</b></span>`;
    }
    return `<span class="vs-status is-${esc(r.visibility)}">${icon(r.visibility, 13)}<span>${esc(V.visLabel(r.visibility))}</span></span>`;
  }

  function num(r, key) {
    return r.scheduled ? "—" : esc(V.fmtNum(r[key]));
  }

  function manageRow(r) {
    const playlists = (r.playlists || []).map((p) => esc(p.name)).join(", ");
    return `<tr data-id="${esc(r.id)}">
      <td class="vs-c-video">
        <div class="vs-mini">
          <a class="vs-mini-pic" href="${V.contentHref(r.id)}" tabindex="-1" aria-hidden="true">${V.thumbHtml({ ...r, locked: null }, { badges: true })}</a>
          <span class="vs-mini-txt">
            <a href="${V.contentHref(r.id)}"><b>${esc(r.title)}</b></a>
            ${statusHtml(r)}
            ${r.scheduled ? `<button class="btn btn-sm btn-primary vs-now" type="button" data-act="now">${esc(t("vid.publishNow"))}</button>` : ""}
          </span>
        </div>
      </td>
      <td data-label="${esc(t("vid.col.added"))}"><time datetime="${esc(r.created_at)}" title="${esc(V.fullDate(r.created_at))}">${esc(C.formatDate(r.created_at))}</time></td>
      <td data-label="${esc(t("vid.col.likes"))}" class="vs-num">${num(r, "likes")}</td>
      <td data-label="${esc(t("vid.col.dislikes"))}" class="vs-num">${num(r, "dislikes")}</td>
      <td data-label="${esc(t("vid.col.impressions"))}" class="vs-num">${num(r, "impressions")}</td>
      <td data-label="${esc(t("vid.col.views"))}" class="vs-num">${num(r, "views")}</td>
      <td data-label="${esc(t("vid.col.minutes"))}" class="vs-num">${num(r, "minutes")}</td>
      <td data-label="${esc(t("vid.col.playlist"))}" class="vs-c-pl">${playlists || "—"}</td>
      <td class="vs-c-act">
        <button class="btn btn-sm btn-ghost vs-act-btn" type="button" data-menu aria-haspopup="menu" aria-expanded="false">${esc(t("vid.takeAction"))} <span aria-hidden="true">▾</span></button>
      </td>
    </tr>`;
  }

  async function drawManage(pane) {
    clearTimers();
    pane.innerHTML = `<p class="muted">${esc(t("common.loading"))}</p>`;
    const res = await V.call("content_mine", { p_member: me() });
    if (state.tab !== "manage") return;
    if (!res.ok) {
      pane.innerHTML = res.setup ? setupHtml() : `<p class="empty">${esc(t("vid.loadFail"))}</p>`;
      return;
    }
    const rows = Array.isArray(res.data) ? res.data : [];
    if (!rows.length) {
      pane.innerHTML = `<div class="vs-empty"><p class="empty">${esc(t("vid.noneYet"))}</p>
        <button class="btn btn-sm btn-primary" type="button" data-go-create>${esc(t("vid.createFirst"))}</button></div>`;
      pane.querySelector("[data-go-create]").onclick = () => show("create");
      return;
    }
    pane.innerHTML = `
      <p class="muted vs-count">${esc(t("vid.mgCount", { n: V.fmtNum(rows.length) }))}</p>
      <div class="vs-table-wrap">
        <table class="table vs-table vs-table--manage">
          <thead><tr>
            <th scope="col">${esc(t("vid.col.video"))}</th>
            <th scope="col">${esc(t("vid.col.added"))}</th>
            <th scope="col" class="vs-num" title="${esc(t("vid.col.likes"))}">${icon("up", 15)}<span class="sr-only">${esc(t("vid.col.likes"))}</span></th>
            <th scope="col" class="vs-num" title="${esc(t("vid.col.dislikes"))}">${icon("down", 15)}<span class="sr-only">${esc(t("vid.col.dislikes"))}</span></th>
            <th scope="col" class="vs-num">${esc(t("vid.col.impressions"))}</th>
            <th scope="col" class="vs-num">${esc(t("vid.col.views"))}</th>
            <th scope="col" class="vs-num">${esc(t("vid.col.minutes"))}</th>
            <th scope="col">${esc(t("vid.col.playlist"))}</th>
            <th scope="col"><span class="sr-only">${esc(t("vid.col.action"))}</span></th>
          </tr></thead>
          <tbody>${rows.map(manageRow).join("")}</tbody>
        </table>
      </div>`;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    // scheduled videos count down in the list too
    if (rows.some((r) => r.scheduled)) {
      state.timers.push(
        setInterval(() => {
          let due = false;
          pane.querySelectorAll("[data-cd]").forEach((el) => {
            const left = Date.parse(el.dataset.cd) - Date.now();
            if (left <= 0) due = true;
            el.textContent = V.countdown(left);
          });
          if (due) drawManage(pane);
        }, 1000)
      );
    }
    pane.onclick = async (e) => {
      const toggle = e.target.closest("[data-menu]");
      if (toggle) {
        const wasOpen = menuState?.toggle === toggle;
        closeMenu();
        if (!wasOpen) openMenu(toggle, byId[toggle.closest("tr")?.dataset.id], pane);
        return;
      }
      const act = e.target.closest("[data-act]");
      if (!act) return;
      const row = byId[act.closest("tr")?.dataset.id];
      if (row) await runAction(act.dataset.act, row, pane);
    };
  }

  // "Take action": a menu laid over the page (never cut off by the table, which scrolls
  // sideways on narrow screens), under the button or above it near the bottom.
  let menuState = null;
  function closeMenu() {
    if (!menuState) return;
    const { menu, toggle } = menuState;
    menuState = null;
    menu.remove();
    toggle.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onOutside, true);
    document.removeEventListener("keydown", onMenuKey, true);
    window.removeEventListener("scroll", closeMenu, true);
    window.removeEventListener("resize", closeMenu);
  }
  function onOutside(e) {
    if (!menuState) return;
    if (menuState.menu.contains(e.target) || menuState.toggle.contains(e.target)) return;
    closeMenu();
  }
  function onMenuKey(e) {
    if (!menuState) return;
    const items = [...menuState.menu.querySelectorAll("button")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "Escape") {
      e.preventDefault();
      const toggle = menuState.toggle;
      closeMenu();
      toggle.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    } else if (e.key === "Tab") {
      closeMenu();
    }
  }
  function openMenu(toggle, row, pane) {
    if (!row) return;
    const menu = document.createElement("div");
    menu.className = "glass vs-menu";
    menu.setAttribute("role", "menu");
    menu.dataset.menuFor = row.id;
    menu.innerHTML = `
      <button type="button" role="menuitem" data-act="link">${icon("link")}<span>${esc(t("vid.act.link"))}</span></button>
      <button type="button" role="menuitem" data-act="dup">${icon("dup")}<span>${esc(t("vid.act.dup"))}</span></button>
      <button type="button" role="menuitem" data-act="pl">${icon("pl")}<span>${esc(t("vid.act.pl"))}</span></button>
      <button type="button" role="menuitem" data-act="del" class="is-danger">${icon("del")}<span>${esc(t("vid.act.del"))}</span></button>`;
    document.body.appendChild(menu);
    const r = toggle.getBoundingClientRect();
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    const rtl = document.documentElement.dir === "rtl";
    let left = rtl ? r.left : r.right - w;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 8 && r.top - h - 4 > 8) top = r.top - h - 4;
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menuState = { menu, toggle };
    toggle.setAttribute("aria-expanded", "true");
    menu.addEventListener("click", async (e) => {
      const act = e.target.closest("[data-act]");
      if (!act) return;
      closeMenu();
      await runAction(act.dataset.act, row, pane);
    });
    document.addEventListener("click", onOutside, true);
    document.addEventListener("keydown", onMenuKey, true);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("resize", closeMenu);
    menu.querySelector("button")?.focus();
  }

  async function runAction(kind, row, pane) {
    if (kind === "link") {
      const url = C.absoluteUrl(V.contentHref(row.id));
      const dlg = V.openDialog(
        `<h2>${esc(t("vid.act.link"))}</h2>
         <p class="muted">${esc(row.title)}</p>
         <div class="vs-linkbox"><input readonly value="${esc(url)}" aria-label="${esc(t("vid.act.link"))}" dir="ltr" />
           <button class="btn btn-sm btn-primary" type="button" data-copy autofocus>${esc(t("share.copy"))}</button></div>
         ${row.visibility === "private" ? `<p class="vs-hint">${esc(t("vid.linkPrivate"))}</p>` : ""}
         ${row.scheduled ? `<p class="vs-hint">${esc(t("vid.linkScheduled"))}</p>` : ""}
         <div class="vdlg-actions">
           <a class="btn btn-sm btn-ghost" href="${V.contentHref(row.id)}">${esc(t("vid.watchIt"))}</a>
           <button class="btn btn-sm btn-ghost" type="button" data-close>${esc(t("common.close"))}</button>
         </div>`,
        { label: t("vid.act.link") }
      );
      const input = dlg.el.querySelector("input");
      input.addEventListener("focus", () => input.select());
      dlg.el.querySelector("[data-copy]").onclick = async () => {
        const ok = await C.copyText(url);
        toast(t(ok ? "vid.linkCopied" : "vid.actFail"));
      };
      return;
    }
    if (kind === "dup") {
      state.published = null;
      state.draft = draftFrom(row);
      toast(t("vid.dupReady"));
      show("create");
      return;
    }
    if (kind === "pl") {
      let changed = false;
      await V.playlistDialog(row.id, { onChange: () => { changed = true; state.playlists = null; } });
      const ov = document.querySelector(".vdlg-overlay");
      if (ov) {
        const obs = new MutationObserver(() => {
          if (!document.body.contains(ov)) {
            obs.disconnect();
            if (changed && state.tab === "manage") drawManage(pane);
          }
        });
        obs.observe(document.body, { childList: true });
      }
      return;
    }
    if (kind === "del") {
      const yes = await V.confirmDialog({
        title: t("vid.delTitle"),
        text: t("vid.delText", { title: row.title }),
        yes: t("vid.act.del"),
        danger: true,
      });
      if (!yes) return;
      const res = await V.call("content_delete", { p_member: me(), p_id: row.id });
      if (!res.ok || res.data?.ok === false) return toast(t("vid.actFail"));
      toast(t("vid.deleted"));
      drawManage(pane);
      return;
    }
    if (kind === "now") {
      const res = await V.call("content_publish_now", { p_member: me(), p_id: row.id });
      if (!res.ok || res.data?.ok === false) return toast(t("vid.actFail"));
      toast(t("vid.publishedToast"));
      drawManage(pane);
    }
  }

  // ---------------------------------------------------------------- Statistics
  function periodRange(p, now = new Date()) {
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    switch (p) {
      case "now":
        return { from: new Date(now.getTime() - 3600e3), to: null };
      case "yesterday": {
        const y = new Date(midnight);
        y.setDate(y.getDate() - 1);
        return { from: y, to: midnight };
      }
      case "week": {
        const w = new Date(midnight);
        w.setDate(w.getDate() - ((w.getDay() + 6) % 7)); // weeks start on Monday
        return { from: w, to: null };
      }
      case "month":
        return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: null };
      case "year":
        return { from: new Date(now.getFullYear(), 0, 1), to: null };
      default:
        return { from: midnight, to: null };
    }
  }

  function rangeText(p, r) {
    if (p === "now") return t("vid.range.now");
    const f = (d) => {
      try {
        return new Intl.DateTimeFormat(C.getLocale(), { dateStyle: "medium", numberingSystem: "latn" }).format(d);
      } catch {
        return d.toDateString();
      }
    };
    return r.to ? t("vid.range.day", { date: f(r.from) }) : t("vid.range.since", { date: f(r.from) });
  }

  const ctr = (clicks, imp) => (Number(imp) > 0 ? `${((Number(clicks) / Number(imp)) * 100).toFixed(1)}%` : "—");

  async function drawStats(pane) {
    clearTimers();
    const p = PERIODS.includes(state.period) ? state.period : "today";
    const r = periodRange(p);
    pane.innerHTML = `
      <div class="vs-periods" role="group" aria-label="${esc(t("vid.period"))}">
        ${PERIODS.map((k) => `<button type="button" class="vs-period${k === p ? " active" : ""}" data-period="${k}" aria-pressed="${k === p}">${esc(t(`vid.per.${k}`))}</button>`).join("")}
      </div>
      <p class="muted vs-range">${esc(rangeText(p, r))}</p>
      <div id="vs-stats-body"><p class="muted">${esc(t("common.loading"))}</p></div>`;
    pane.querySelector(".vs-periods").onclick = (e) => {
      const b = e.target.closest("[data-period]");
      if (!b) return;
      state.period = b.dataset.period;
      clearTimers();
      drawStats(pane);
    };
    const res = await V.call("content_stats", {
      p_member: me(),
      p_from: r.from ? r.from.toISOString() : null,
      p_to: r.to ? r.to.toISOString() : null,
    });
    if (state.tab !== "stats" || state.period !== p) return;
    const body = pane.querySelector("#vs-stats-body");
    if (!res.ok) {
      body.innerHTML = res.setup ? setupHtml() : `<p class="empty">${esc(t("vid.loadFail"))}</p>`;
      return;
    }
    const rows = Array.isArray(res.data) ? res.data : [];
    if (!rows.length) {
      body.innerHTML = `<p class="empty">${esc(t("vid.noneYet"))}</p>`;
      return;
    }
    const keys = ["likes", "dislikes", "views", "impressions", "clicks", "shares", "comments", "playlists", "minutes"];
    const sum = Object.fromEntries(keys.map((k) => [k, rows.reduce((a, x) => a + Number(x[k] || 0), 0)]));
    const tile = (k, value, label) => `<div class="stat vs-tile" data-tile="${k}"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
    body.innerHTML = `
      <div class="stat-row vs-tiles">
        ${tile("views", V.fmtNum(sum.views), t("vid.col.views"))}
        ${tile("impressions", V.fmtNum(sum.impressions), t("vid.col.impressions"))}
        ${tile("ctr", ctr(sum.clicks, sum.impressions), t("vid.col.ctr"))}
        ${tile("minutes", V.fmtNum(sum.minutes), t("vid.col.minutes"))}
        ${tile("likes", V.fmtNum(sum.likes), t("vid.col.likes"))}
        ${tile("dislikes", V.fmtNum(sum.dislikes), t("vid.col.dislikes"))}
        ${tile("shares", V.fmtNum(sum.shares), t("vid.col.shares"))}
        ${tile("comments", V.fmtNum(sum.comments), t("vid.col.comments"))}
      </div>
      <div class="vs-table-wrap">
        <table class="table vs-table vs-table--stats">
          <thead><tr>
            <th scope="col">${esc(t("vid.col.video"))}</th>
            <th scope="col" class="vs-num">${esc(t("vid.col.likes"))}</th>
            <th scope="col" class="vs-num">${esc(t("vid.col.dislikes"))}</th>
            <th scope="col" class="vs-num">${esc(t("vid.col.views"))}</th>
            <th scope="col" class="vs-num">${esc(t("vid.col.impressions"))}</th>
            <th scope="col" class="vs-num">${esc(t("vid.col.clicks"))}</th>
            <th scope="col" class="vs-num">${esc(t("vid.col.shares"))}</th>
            <th scope="col" class="vs-num">${esc(t("vid.col.comments"))}</th>
            <th scope="col" class="vs-num">${esc(t("vid.col.inPlaylists"))}</th>
          </tr></thead>
          <tbody>${rows
            .map(
              (x) => `<tr data-id="${esc(x.id)}">
                <td class="vs-c-video"><div class="vs-mini"><a class="vs-mini-pic" href="${V.contentHref(x.id)}" tabindex="-1" aria-hidden="true">${V.thumbHtml({ ...x, locked: null }, { badges: false })}</a><span class="vs-mini-txt"><a href="${V.contentHref(x.id)}"><b>${esc(x.title)}</b></a></span></div></td>
                <td class="vs-num" data-label="${esc(t("vid.col.likes"))}">${esc(V.fmtNum(x.likes))}</td>
                <td class="vs-num" data-label="${esc(t("vid.col.dislikes"))}">${esc(V.fmtNum(x.dislikes))}</td>
                <td class="vs-num" data-label="${esc(t("vid.col.views"))}">${esc(V.fmtNum(x.views))}</td>
                <td class="vs-num" data-label="${esc(t("vid.col.impressions"))}">${esc(V.fmtNum(x.impressions))}</td>
                <td class="vs-num" data-label="${esc(t("vid.col.clicks"))}">${esc(V.fmtNum(x.clicks))} <small class="muted">${esc(ctr(x.clicks, x.impressions))}</small></td>
                <td class="vs-num" data-label="${esc(t("vid.col.shares"))}">${esc(V.fmtNum(x.shares))}</td>
                <td class="vs-num" data-label="${esc(t("vid.col.comments"))}">${esc(V.fmtNum(x.comments))}</td>
                <td class="vs-num" data-label="${esc(t("vid.col.inPlaylists"))}">${esc(V.fmtNum(x.playlists))}</td>
              </tr>`
            )
            .join("")}</tbody>
          <tfoot><tr>
            <th scope="row">${esc(t("vid.total"))}</th>
            ${["likes", "dislikes", "views", "impressions", "clicks", "shares", "comments", "playlists"]
              .map((k) => `<td class="vs-num" data-label="${esc(t(`vid.col.${k === "playlists" ? "inPlaylists" : k}`))}">${esc(V.fmtNum(sum[k]))}</td>`)
              .join("")}
          </tr></tfoot>
        </table>
      </div>`;
    // "Now" keeps itself fresh
    if (p === "now") state.timers.push(setInterval(() => state.tab === "stats" && drawStats(pane), 60e3));
  }

  window.CineAuraStudio = { render, periodRange };
})();
