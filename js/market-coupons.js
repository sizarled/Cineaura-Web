/* CineAura — Market.html, the coupons (sql/market.sql, section 17). Loaded after
 * js/market-forms.js; adds to window.CineAuraMarket:
 *
 *   M.couponHtml(c, { as })       a coupon as a ticket: as = buyer (Purchase coupons: copy, download,
 *                                 delete) | seller (Sales coupons: pause, use again, delete, the numbers)
 *   M.couponStrip(box, storeId)   the coupons of a store a visitor may use (store page, product page):
 *                                 "Get" puts one in the member's coupons
 *   M.openCouponForm({ onSaved }) a new coupon of the member's store: a code (typed or drawn), uses,
 *                                 what it takes off (products / shipping / both), the percentage and
 *                                 who may use it (public, or exclusive: countries, orders received from
 *                                 the store, positive and negative reviews — each at least / at most)
 *   M.couponPng(c)                the coupon as a picture (Download)
 *   M.couponWhy(why)              why a coupon cannot be used, as a sentence
 *   M.couponOff(c, sub, ship)     what a coupon takes off: { products, shipping, total }
 */
(() => {
  "use strict";
  const C = window.CineAura;
  const M = window.CineAuraMarket;
  if (!C || !M) return;
  const { t, escapeHtml: esc } = C;
  const { ICON } = M;
  const svg = (body, size = 16, sw = 2) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
  ICON.ticket = svg('<path d="M3.5 8.5V6.5a1 1 0 0 1 1-1h15a1 1 0 0 1 1 1v2a2.5 2.5 0 0 0 0 5v2a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-2a2.5 2.5 0 0 0 0-5z"/><path d="M14.5 6v1.6M14.5 11.2v1.6M14.5 16.4V18"/>', 16, 1.9);
  ICON.pause = svg('<path d="M9 5.5v13M15 5.5v13"/>', 15, 2.2);
  ICON.play = svg('<path d="M8 5.5v13l10-6.5z"/>', 15, 2);
  ICON.dice = svg('<rect x="4" y="4" width="16" height="16" rx="3.5"/><circle cx="9" cy="9" r="1.1"/><circle cx="15" cy="15" r="1.1"/><circle cx="15" cy="9" r="1.1"/><circle cx="9" cy="15" r="1.1"/>', 15, 1.9);

  const ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  M.couponCode = () => {
    const bytes = new Uint8Array(8);
    window.crypto.getRandomValues(bytes);
    return [...bytes].map((b) => ABC[b % ABC.length]).join("");
  };

  // ---------------------------------------------------------------- words
  const WHY = ["not_found", "own", "paused", "expired", "used", "used_up", "country", "purchases", "positive", "negative", "nothing"];
  M.couponWhy = (why) => t(WHY.includes(why) ? `mkt.cp.why.${why}` : "mkt.cp.why.not_found");
  M.couponScope = (scope) => t(`mkt.cp.scope.${["product", "shipping", "both"].includes(scope) ? scope : "product"}`);
  const pctText = (c) => `\u2066−${Number(c.pct) || 0}%\u2069`;
  M.couponOff = (c, sub, ship) => {
    const pct = Number(c?.pct) || 0;
    const products = c && (c.scope === "product" || c.scope === "both") ? Math.floor((Math.max(0, sub) * pct) / 100) : 0;
    const shipping = c && (c.scope === "shipping" || c.scope === "both") ? Math.floor((Math.max(0, ship) * pct) / 100) : 0;
    return { products, shipping, total: products + shipping };
  };
  // "at least 2 orders received", "at most 0 negative reviews" …
  const rangeText = (key, lo, hi) => {
    if (lo != null && hi != null) return t(`mkt.cp.c.${key}Between`, { a: M.fmt(lo), b: M.fmt(hi) });
    if (lo != null) return t(`mkt.cp.c.${key}Min`, { n: M.fmt(lo) });
    return t(`mkt.cp.c.${key}Max`, { n: M.fmt(hi) });
  };
  M.couponAudience = (c) => {
    if (c.audience !== "exclusive") return t("mkt.cp.aud.public");
    const k = c.criteria || {};
    const bits = [];
    if (k.countries?.length) bits.push(k.countries.map((cc) => M.country(cc)).join(", "));
    if (k.min_purchases != null || k.max_purchases != null) bits.push(rangeText("purchases", k.min_purchases, k.max_purchases));
    if (k.min_positive != null || k.max_positive != null) bits.push(rangeText("positive", k.min_positive, k.max_positive));
    if (k.min_negative != null || k.max_negative != null) bits.push(rangeText("negative", k.min_negative, k.max_negative));
    return bits.length ? `${t("mkt.cp.aud.exclusive")}: ${bits.join(" · ")}` : t("mkt.cp.aud.exclusive");
  };
  const stateBadge = (c, held) => {
    const st = c.state || "active";
    if (held?.used_at) return `<span class="cpn-badge b-used">${ICON.check}${esc(t("mkt.cp.st.usedByYou"))}</span>`;
    if (st === "active") return "";
    return `<span class="cpn-badge b-${esc(st)}">${esc(t(`mkt.cp.st.${st}`))}</span>`;
  };

  // ---------------------------------------------------------------- the ticket
  M.couponHtml = (c, { as = "buyer" } = {}) => {
    const s = c.store || {};
    const left = Number(c.left ?? Math.max(0, Number(c.max_uses) - Number(c.uses)));
    const meta = [
      c.expires_at ? t("mkt.cp.until", { date: M.date(c.expires_at) }) : t("mkt.cp.noEnd"),
      as === "seller" ? t("mkt.cp.usesOf", { n: M.fmt(c.uses), max: M.fmt(c.max_uses) }) : t(left === 1 ? "mkt.cp.leftOne" : "mkt.cp.leftN", { n: M.fmt(left) }),
    ];
    let acts = "";
    let extra = "";
    if (as === "seller") {
      extra = `
        <p class="cpn-aud">${c.audience === "exclusive" ? ICON.lock : ICON.globe}<span>${esc(M.couponAudience(c))}</span></p>
        <p class="cpn-stats">${esc(t("mkt.cp.holders", { n: M.fmt(c.holders) }))} · ${esc(t("mkt.cp.given", { pts: M.pt(c.discount_total) }))}</p>`;
      acts = `
        <button class="btn btn-sm btn-ghost" type="button" data-cpn-copy>${ICON.copy}<span>${esc(t("common.copy"))}</span></button>
        ${c.state === "paused" ? `<button class="btn btn-sm btn-ghost" type="button" data-cpn-status="active">${ICON.play}<span>${esc(t("mkt.cp.resume"))}</span></button>`
          : c.state === "active" ? `<button class="btn btn-sm btn-ghost" type="button" data-cpn-status="paused">${ICON.pause}<span>${esc(t("mkt.cp.pause"))}</span></button>` : ""}
        <button class="btn btn-sm btn-ghost mkt-danger" type="button" data-cpn-status="deleted">${ICON.trash}<span>${esc(t("mkt.cp.delete"))}</span></button>`;
    } else {
      const used = Boolean(c.used_at);
      extra = used && c.order
        ? `<p class="cpn-stats">${ICON.check}<span>${esc(t("mkt.cp.usedOn", { date: M.date(c.used_at), pts: M.pt(c.order.discount) }))}</span>
             <a href="./Market.html#purchases/${c.order.status === "requested" ? "requests" : c.order.status === "shipped" ? "shipped" : c.order.status === "delivered" ? "received" : "purchased"}" data-nav dir="auto">${esc(c.order.title || "")}</a></p>`
        : `<p class="cpn-stats">${esc(t(c.how === "given" ? "mkt.cp.howGiven" : c.how === "typed" ? "mkt.cp.howTyped" : "mkt.cp.howGot", { date: M.date(c.got_at) }))}</p>`;
      acts = `
        <button class="btn btn-sm btn-ghost" type="button" data-cpn-copy>${ICON.copy}<span>${esc(t("common.copy"))}</span></button>
        <button class="btn btn-sm btn-ghost" type="button" data-cpn-png>${ICON.download}<span>${esc(t("mkt.cp.download"))}</span></button>
        ${used ? "" : `<button class="btn btn-sm btn-ghost mkt-danger" type="button" data-cpn-remove>${ICON.trash}<span>${esc(t("mkt.cp.remove"))}</span></button>`}`;
    }
    return `
      <article class="cpn st-${esc(c.state || "active")}${c.used_at ? " is-used" : ""}" data-cpn="${esc(c.id)}">
        <div class="cpn-stub">
          <b class="cpn-pct" dir="ltr">${pctText(c)}</b>
          <span class="cpn-scope">${esc(M.couponScope(c.scope))}</span>
        </div>
        <div class="cpn-main">
          <div class="cpn-top">
            <a class="cpn-store" href="${esc(M.storeHref(s.id || ""))}" data-nav>
              <img src="${esc(s.logo_url || C.initialsAvatar(s.name || "CA"))}" alt="" loading="lazy" />
              <span dir="auto">${esc(s.name || "")}</span>${M.tierHtml ? M.tierHtml(s.tier) : ""}
            </a>
            ${stateBadge(c, as === "buyer" ? c : null)}
            ${as === "seller" && c.audience === "exclusive" ? `<span class="cpn-badge b-excl">${esc(t("mkt.cp.aud.exclusive"))}</span>` : ""}
          </div>
          <div class="cpn-code-row"><code class="cpn-code" dir="ltr">${esc(c.code || "")}</code></div>
          <p class="cpn-meta">${esc(meta.join(" · "))}</p>
          ${extra}
          <div class="cpn-acts">${acts}</div>
        </div>
      </article>`;
  };

  M.copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* nothing more to try */
      }
      ta.remove();
    }
    C.toast(t("mkt.cp.copied", { code: text }));
  };

  // ---------------------------------------------------------------- the picture
  // A ticket drawn on a canvas: the store, the percentage, what it takes off, the code, the end date.
  M.couponPng = async (c) => {
    const W = 1200;
    const H = 560;
    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;
    const g = cv.getContext("2d");
    const rtl = document.documentElement.dir === "rtl";
    const font = getComputedStyle(document.body).fontFamily || "sans-serif";
    // the ticket and its notches
    const grad = g.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, "#0d253f");
    grad.addColorStop(1, "#01406b");
    g.fillStyle = grad;
    g.beginPath();
    g.roundRect ? g.roundRect(20, 20, W - 40, H - 40, 36) : g.rect(20, 20, W - 40, H - 40);
    g.fill();
    const stub = rtl ? W - 400 : 400;
    g.fillStyle = "#01b4e4";
    g.beginPath();
    if (rtl) g.roundRect ? g.roundRect(stub, 20, 380, H - 40, [0, 36, 36, 0]) : g.rect(stub, 20, 380, H - 40);
    else g.roundRect ? g.roundRect(20, 20, 380, H - 40, [36, 0, 0, 36]) : g.rect(20, 20, 380, H - 40);
    g.fill();
    g.globalCompositeOperation = "destination-out";
    for (const y of [20, H - 20]) {
      g.beginPath();
      g.arc(stub, y, 28, 0, Math.PI * 2);
      g.fill();
    }
    g.globalCompositeOperation = "source-over";
    g.strokeStyle = "rgba(255,255,255,0.55)";
    g.setLineDash([14, 12]);
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(stub, 60);
    g.lineTo(stub, H - 60);
    g.stroke();
    g.setLineDash([]);
    // the stub: -20%, what it takes off
    const sx = rtl ? stub + 190 : 210;
    g.fillStyle = "#ffffff";
    g.textAlign = "center";
    g.direction = "ltr";
    g.font = `800 120px ${font}`;
    g.fillText(`-${Number(c.pct) || 0}%`, sx, 260);
    g.direction = rtl ? "rtl" : "ltr";
    g.font = `600 34px ${font}`;
    const scope = M.couponScope(c.scope);
    g.fillText(scope.length > 22 ? `${scope.slice(0, 21)}…` : scope, sx, 330);
    // the main part: the store, the code, the end
    const mx = rtl ? 60 + (W - 460) / 2 : 400 + (W - 440) / 2;
    g.font = `700 44px ${font}`;
    const name = String(c.store?.name || "");
    g.fillText(name.length > 26 ? `${name.slice(0, 25)}…` : name, mx, 140);
    g.fillStyle = "rgba(255,255,255,0.12)";
    g.beginPath();
    const bw = 560;
    g.roundRect ? g.roundRect(mx - bw / 2, 190, bw, 130, 22) : g.rect(mx - bw / 2, 190, bw, 130);
    g.fill();
    g.fillStyle = "#90cea1";
    g.direction = "ltr";
    g.font = `800 80px ui-monospace, SFMono-Regular, Menlo, monospace`;
    g.fillText(String(c.code || ""), mx, 285);
    g.direction = rtl ? "rtl" : "ltr";
    g.fillStyle = "rgba(255,255,255,0.85)";
    g.font = `500 30px ${font}`;
    g.fillText(c.expires_at ? t("mkt.cp.until", { date: M.date(c.expires_at) }) : t("mkt.cp.noEnd"), mx, 390);
    g.fillStyle = "rgba(255,255,255,0.6)";
    g.font = `600 26px ${font}`;
    g.fillText("CineAura · Market", mx, 470);
    const blob = await new Promise((resolve) => cv.toBlob(resolve, "image/png"));
    if (!blob) return C.toast(t("mkt.err.failed"));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `coupon-${String(c.code || "cineaura").toLowerCase()}.png`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 800);
  };

  // ---------------------------------------------------------------- a store's coupons (store / product page)
  M.couponStrip = async (box, storeId, { own = false } = {}) => {
    if (!box || !storeId) return;
    const r = await M.call("market_coupons_store", { p_member: M.memberId(), p_store: storeId });
    if (!box.isConnected) return;
    const items = r.ok && Array.isArray(r.data?.items) ? r.data.items.filter((c) => !c.used) : [];
    if (!items.length) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    box.hidden = false;
    const signed = Boolean(M.memberId());
    box.innerHTML = `
      <p class="cpn-strip-head">${ICON.ticket}<b>${esc(t(own ? "mkt.cp.stripOwn" : "mkt.cp.strip"))}</b></p>
      <div class="cpn-chips">${items.map((c) => `
        <div class="cpn-chip${c.audience === "exclusive" ? " excl" : ""}" data-cpn="${esc(c.id)}">
          <b dir="ltr">${pctText(c)}</b>
          <span class="cpn-chip-txt"><span>${esc(M.couponScope(c.scope))}</span>
            <small>${esc(c.audience === "exclusive" ? t("mkt.cp.forYou") : c.expires_at ? t("mkt.cp.until", { date: M.date(c.expires_at) }) : t("mkt.cp.aud.public"))}</small></span>
          ${own ? `<code dir="ltr">${esc(c.code)}</code>`
            : !signed ? `<a class="btn btn-sm btn-ghost" href="${esc(M.signinHref())}">${esc(t("mkt.cp.get"))}</a>`
            : c.held ? `<span class="cpn-held">${ICON.check}${esc(t("mkt.cp.held"))}</span>`
            : `<button class="btn btn-sm btn-primary" type="button" data-cpn-get>${esc(t("mkt.cp.get"))}</button>`}
        </div>`).join("")}</div>`;
    box.querySelectorAll("[data-cpn-get]").forEach((b) =>
      b.addEventListener("click", async () => {
        const id = b.closest("[data-cpn]").dataset.cpn;
        b.disabled = true;
        const res = await M.call("market_coupon_get", { p_member: M.memberId(), p_id: id });
        if (!res.ok || !res.data?.ok) {
          b.disabled = false;
          return C.toast(res.ok && res.data?.reason ? M.couponWhy(res.data.reason) : M.failText(res));
        }
        b.outerHTML = `<span class="cpn-held">${ICON.check}${esc(t("mkt.cp.held"))}</span>`;
        C.toast(t("mkt.cp.gotToast", { code: res.data.coupon?.code || "" }));
        document.dispatchEvent(new CustomEvent("cineaura:coupons"));
      })
    );
  };

  // ---------------------------------------------------------------- a new coupon (the seller)
  const ERR = {
    store: "mkt.cp.err.store", many: "mkt.cp.err.many", code: "mkt.cp.err.code", taken: "mkt.cp.err.taken", uses: "mkt.cp.err.uses",
    scope: "mkt.cp.err.scope", pct: "mkt.cp.err.pct", audience: "mkt.cp.err.audience", criteria: "mkt.cp.err.criteria",
    range: "mkt.cp.err.range", expires: "mkt.cp.err.expires", blocked: "mkt.err.blocked", member: "mkt.err.member",
  };
  M.openCouponForm = ({ onSaved = null } = {}) => {
    const countries = [];
    const crit = (key) => `
      <div class="cpn-crit">
        <span class="cpn-crit-lbl">${esc(t(`mkt.cp.f.${key}`))}</span>
        <select name="${key}_op" aria-label="${esc(t(`mkt.cp.f.${key}`))}">
          <option value="min">${esc(t("mkt.cp.f.atLeast"))}</option>
          <option value="max">${esc(t("mkt.cp.f.atMost"))}</option>
        </select>
        <input name="${key}_n" type="number" min="0" max="100000" step="1" inputmode="numeric" placeholder="—" aria-label="${esc(t(`mkt.cp.f.${key}`))}" />
      </div>`;
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const wrap = M.modal(`
      ${M.modalHead(t("mkt.cp.f.title"))}
      <form class="mkt-form cpn-form" data-cpn-form novalidate>
        <p class="muted mkt-f-hint">${esc(t("mkt.cp.f.lead"))}</p>
        <label class="mkt-field"><span>${esc(t("mkt.cp.f.code"))}</span>
          <span class="cpn-code-field">
            <input name="code" dir="ltr" maxlength="24" autocomplete="off" spellcheck="false" autocapitalize="characters" placeholder="${esc(t("mkt.cp.f.codePh"))}" />
            <button class="btn btn-sm btn-ghost" type="button" data-cpn-draw>${ICON.dice}<span>${esc(t("mkt.cp.f.draw"))}</span></button>
          </span>
          <small class="muted">${esc(t("mkt.cp.f.codeHint"))}</small></label>
        <div class="mkt-form-2">
          <label class="mkt-field"><span>${esc(t("mkt.cp.f.pct"))} *</span>
            <span class="cpn-pct-field"><input name="pct" type="number" min="1" max="100" step="1" value="10" inputmode="numeric" required /><b>%</b></span></label>
          <label class="mkt-field"><span>${esc(t("mkt.cp.f.uses"))} *</span>
            <input name="max_uses" type="number" min="1" max="100000" step="1" value="1" inputmode="numeric" required />
            <small class="muted">${esc(t("mkt.cp.f.usesHint"))}</small></label>
        </div>
        <fieldset class="mkt-field cpn-scope-pick"><legend>${esc(t("mkt.cp.f.scope"))}</legend>
          ${["product", "shipping", "both"].map((k) => `<label><input type="radio" name="scope" value="${k}"${k === "product" ? " checked" : ""} /><span>${esc(t(`mkt.cp.scope.${k}`))}</span></label>`).join("")}
        </fieldset>
        <fieldset class="mkt-field cpn-aud-pick"><legend>${esc(t("mkt.cp.f.audience"))}</legend>
          <label><input type="radio" name="audience" value="public" checked /><span><b>${esc(t("mkt.cp.aud.public"))}</b><small>${esc(t("mkt.cp.f.publicHint"))}</small></span></label>
          <label><input type="radio" name="audience" value="exclusive" /><span><b>${esc(t("mkt.cp.aud.exclusive"))}</b><small>${esc(t("mkt.cp.f.exclusiveHint"))}</small></span></label>
        </fieldset>
        <div class="cpn-excl" data-cpn-excl hidden>
          <div class="cpn-crit">
            <span class="cpn-crit-lbl">${esc(t("mkt.cp.f.countries"))}</span>
            <select data-cpn-cty><option value="">${esc(t("mkt.cp.f.addCountry"))}</option>${C.countryChoices().map(([cc, n]) => `<option value="${cc}">${esc(n)}</option>`).join("")}</select>
            <span class="cpn-cchips" data-cpn-cchips></span>
          </div>
          ${crit("purchases")}
          ${crit("positive")}
          ${crit("negative")}
          <p class="muted mkt-f-hint">${esc(t("mkt.cp.f.critHint"))}</p>
        </div>
        <label class="mkt-field"><span>${esc(t("mkt.cp.f.expires"))}</span>
          <input name="expires" type="date" min="${tomorrow}" />
          <small class="muted">${esc(t("mkt.cp.f.expiresHint"))}</small></label>
        <p class="cpn-preview" data-cpn-preview></p>
        <p class="mkt-form-err" data-err role="alert"></p>
        <div class="mkt-form-acts">
          <button class="btn btn-ghost" type="button" data-close>${esc(t("common.cancel"))}</button>
          <button class="btn btn-primary" type="submit" data-cpn-save>${ICON.ticket}<span>${esc(t("mkt.cp.f.save"))}</span></button>
        </div>
      </form>`, { label: t("mkt.cp.f.title") });
    const form = wrap.querySelector("[data-cpn-form]");
    const err = form.querySelector("[data-err]");
    const aud = () => form.querySelector('input[name="audience"]:checked')?.value || "public";
    const scope = () => form.querySelector('input[name="scope"]:checked')?.value || "product";
    const chips = () => {
      form.querySelector("[data-cpn-cchips]").innerHTML = countries
        .map((cc) => `<span class="mkt-chip-x">${esc(M.country(cc))}<button type="button" data-cpn-uncty="${esc(cc)}" aria-label="${esc(t("rich.remove"))} ${esc(M.country(cc))}">${ICON.close}</button></span>`)
        .join("");
    };
    const preview = () => {
      form.querySelector("[data-cpn-excl]").hidden = aud() !== "exclusive";
      const pct = Math.max(0, Math.min(100, Math.floor(Number(form.pct.value) || 0)));
      const uses = Math.max(1, Math.floor(Number(form.max_uses.value) || 1));
      form.querySelector("[data-cpn-preview]").innerHTML = `${ICON.ticket}<span>${esc(t("mkt.cp.f.preview", {
        pct: `−${pct}%`, scope: M.couponScope(scope()), uses: t(uses === 1 ? "mkt.cp.usesOne" : "mkt.cp.usesN", { n: M.fmt(uses) }),
        who: t(aud() === "exclusive" ? "mkt.cp.aud.exclusive" : "mkt.cp.aud.public"),
      }))}</span>`;
    };
    form.addEventListener("input", preview);
    form.addEventListener("change", (e) => {
      if (e.target.matches("[data-cpn-cty]")) {
        const cc = e.target.value;
        if (cc && !countries.includes(cc)) countries.push(cc);
        e.target.value = "";
        chips();
      }
      preview();
    });
    form.addEventListener("click", (e) => {
      if (e.target.closest("[data-cpn-draw]")) {
        form.code.value = M.couponCode();
        return;
      }
      const un = e.target.closest("[data-cpn-uncty]");
      if (un) {
        countries.splice(countries.indexOf(un.dataset.cpnUncty), 1);
        chips();
      }
    });
    preview();
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      const d = {
        code: form.code.value.trim(), pct: form.pct.value, max_uses: form.max_uses.value, scope: scope(), audience: aud(),
        expires: form.expires.value || "",
      };
      if (d.audience === "exclusive") {
        d.countries = countries.slice();
        for (const k of ["purchases", "positive", "negative"]) {
          const n = String(form[`${k}_n`].value || "").trim();
          if (n !== "") d[`${form[`${k}_op`].value}_${k}`] = n;
        }
      }
      const btn = form.querySelector("[data-cpn-save]");
      btn.disabled = true;
      const r = await M.call("market_coupon_save", { p_member: M.memberId(), d });
      btn.disabled = false;
      if (!r.ok || !r.data?.ok) {
        err.textContent = r.ok && r.data?.reason ? t(ERR[r.data.reason] || "mkt.err.failed") : M.failText(r);
        return;
      }
      wrap.close();
      C.toast(r.data.given ? t("mkt.cp.savedGiven", { code: r.data.coupon.code, n: M.fmt(r.data.given) }) : t("mkt.cp.saved", { code: r.data.coupon.code }));
      onSaved?.(r.data);
    });
    return wrap;
  };
})();
