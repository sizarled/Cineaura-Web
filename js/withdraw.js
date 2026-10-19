/* CineAura — Dashboard > Withdraw: points exchanged for real money (sql/withdrawals.sql).
 *
 *   Who may: an account of level LV3 or higher (1,000 points earned) that is old enough for its
 *   membership — Free 12 months, Silver 6, Gold 3, Diamond 1, counted from signing up (a paid
 *   membership that has ended waits like a Free one).
 *   How: a bank transfer, or a money transfer agency such as Western Union. The details can be
 *   remembered: they are shown again masked (GB82 •••• 5432) and used without typing them. The
 *   account password confirms each request. One request at a time; its points are held until the
 *   team sends the money, and come back when it is cancelled (while pending) or rejected.
 *
 * dashboard.js calls CineAuraWithdraw.view(main, { member, current() }); the section is
 * dashboard.html#withdraw (where the bells of the withdrawals lead).
 */
(() => {
  "use strict";
  const C = window.CineAura;
  if (!C) return;
  const { t, escapeHtml: esc } = C;

  // ---------------------------------------------------------------- words and numbers
  const locale = () => `${C.getLocale?.() || "en"}-u-nu-latn`;
  const num = (n) => {
    try {
      return new Intl.NumberFormat(locale()).format(Number(n) || 0);
    } catch {
      return String(Number(n) || 0);
    }
  };
  // amounts stay in one piece inside an Arabic sentence (bidi isolates)
  const pt = (n) => `\u2066${num(n)} PT\u2069`;
  const money = (n, cur) => `\u2066${C.moneyText(n, cur)}\u2069`;
  const day = (iso) => (iso ? C.formatDate(iso) : "");
  const planName = (p) => (C.tr ? C.tr(p) : p);
  const PLANS = ["Free", "Silver", "Gold", "Diamond"];
  const STATUSES = ["pending", "processing", "paid", "rejected", "cancelled"];
  const stText = (s) => t(`wd.st.${STATUSES.includes(s) ? s : "pending"}`);
  const svg = (body, size = 20, sw = 1.9) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
  const ICON = {
    ok: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12.3l2.7 2.7L16.2 9.5"/>', 22),
    no: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.4v.1"/>', 22),
    bank: svg('<path d="M3.5 9.5L12 4.5l8.5 5"/><path d="M5 10v7.5M9.5 10v7.5M14.5 10v7.5M19 10v7.5M3.5 20h17"/>', 22),
    agency: svg('<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0"/><path d="M15.5 10.5h5M18 8l2.5 2.5L18 13"/>', 22),
    copy: svg('<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M5.5 15.5h-1a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>', 15, 2),
    lock: svg('<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>', 22),
  };

  // why a request was refused (withdraw_request), and the field it is about
  const ERR = {
    member: "wd.err.member", disabled: "wd.err.disabled", banned: "wd.err.disabled", blocked: "wd.err.blocked",
    locked: "wd.err.locked", password: "wd.err.password", closed: "wd.err.closed", level: "wd.err.level", age: "wd.err.age",
    open: "wd.err.open", method: "wd.err.method", saved: "wd.err.saved", holder: "wd.err.holder", bank: "wd.err.bank",
    account: "wd.err.account", iban: "wd.err.iban", swift: "wd.err.swift", country: "wd.err.country", agency: "wd.err.agency",
    name: "wd.err.name", city: "wd.err.city", phone: "wd.err.phone", min: "wd.err.min", max: "wd.err.max",
    net: "wd.err.net", balance: "wd.err.balance",
  };
  const FIELD = {
    holder: "holder", bank: "bank", account: "account", iban: "account", swift: "swift", country: "country",
    agency: "agency", name: "name", city: "city", phone: "phone", min: "points", max: "points", net: "points",
    balance: "points", password: "password", locked: "password",
  };

  // ---------------------------------------------------------------- the checks of the form (as the server)
  const line = (v) => String(v || "").replace(/\s+/g, " ").trim();
  const nameOk = (v) => v.length >= 2 && v.length <= 80 && v.replace(/[\s\d!-/:-@[-`{-~]/g, "").length >= 2;
  // an IBAN: true / false by its check digits; null when the number is not an IBAN (an account number, a RIB…)
  function ibanOk(raw) {
    const s = String(raw || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return null;
    let r = 0;
    for (const ch of s.slice(4) + s.slice(0, 4)) {
      const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
      for (const dgt of v) r = (r * 10 + Number(dgt)) % 97;
    }
    return r === 1;
  }
  function detailsError(method, d) {
    if (method === "bank") {
      if (!nameOk(d.holder)) return "holder";
      if (d.bank.length < 2 || d.bank.length > 80) return "bank";
      const acct = d.account.replace(/[^A-Za-z0-9]/g, "");
      if (!/^[A-Za-z0-9 .-]+$/.test(d.account) || acct.length < 6 || acct.length > 34) return "account";
      if (ibanOk(acct) === false) return "iban";
      const sw = d.swift.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      if (sw && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(sw)) return "swift";
      if (!/^[A-Z]{2}$/.test(d.country)) return "country";
      return "";
    }
    if (!d.agency) return "agency";
    if (!nameOk(d.name)) return "name";
    if (!/^[A-Z]{2}$/.test(d.country)) return "country";
    if (d.city.length < 2 || d.city.length > 80) return "city";
    const digits = d.phone.replace(/\D/g, "");
    if (!/^\+?[0-9 ().-]{6,24}$/.test(d.phone) || digits.length < 6 || digits.length > 15) return "phone";
    return "";
  }

  // ---------------------------------------------------------------- pieces
  const countryOptions = (sel) =>
    `<option value="">${esc(t("wd.f.pickCountry"))}</option>${C.countryChoices()
      .map(([code, name]) => `<option value="${code}"${code === sel ? " selected" : ""}>${esc(name)}</option>`)
      .join("")}`;

  // "Bank transfer · Chase · GB82 •••• 5432" / "Western Union · Bob Stone · Austin"
  function methodLine(w) {
    const d = w.details || {};
    if (w.method === "bank") {
      return [t("wd.m.bank"), d.bank, d.account ? `\u2066${d.account}\u2069` : ""].filter(Boolean).map((x, i) => (i === 2 ? x : esc(x))).join(" · ");
    }
    return [w.agency || d.agency || t("wd.m.agency"), d.name, d.city].filter(Boolean).map((x) => esc(x)).join(" · ");
  }

  function statsHtml(d) {
    const s = d.settings || {};
    const c = d.check || {};
    const rate = Number(s.rate) || 100;
    const cur = s.currency || "USD";
    return `
      <div class="stat-row wd-stats">
        <div class="stat ov-accent"><b data-wd-avail>${pt(c.available)}</b><span>${esc(t("wd.available"))}</span><small>≈ ${money(Number(c.available || 0) / rate, cur)}</small></div>
        <div class="stat"><b>${money(1, cur)}</b><span>${esc(t("wd.rateIs", { n: num(rate) }))}</span><small>${esc(t("wd.rateNote"))}</small></div>
        <div class="stat"><b>${pt(s.min_points)}</b><span>${esc(t("wd.minimum"))}</span><small>≈ ${money(Number(s.min_points || 0) / rate, cur)}${Number(s.max_points) > 0 ? ` · ${t("wd.maxIs", { pts: pt(s.max_points) })}` : ""}</small></div>
        ${Number(d.totals?.paid) > 0 ? `<div class="stat"><b>${pt(d.totals.paid_points)}</b><span>${esc(t("wd.withdrawn"))}</span><small>${esc(t("wd.paidN", { n: num(d.totals.paid) }))}</small></div>` : ""}
      </div>`;
  }

  function condsHtml(d) {
    const c = d.check || {};
    const plans = d.plans || { Free: 12, Silver: 6, Gold: 3, Diamond: 1 };
    const need = Number(c.need_earned) || 1000;
    const earned = Number(c.earned) || 0;
    const lvPct = Math.max(0, Math.min(100, Math.round((Math.min(earned, need) / need) * 100)));
    const start = Date.parse(c.created_at || "") || Date.now();
    const due = Date.parse(c.eligible_at || "") || Date.now();
    const agePct = c.age_ok ? 100 : Math.max(0, Math.min(100, Math.round(((Date.now() - start) / Math.max(1, due - start)) * 100)));
    const rules = PLANS.map((p) => {
      const you = p === c.plan;
      return `<li class="wd-rule${you ? " is-you" : ""}"${you ? ' aria-current="true"' : ""}><span>${esc(t(`wd.rule.${p}`))}</span>${you ? `<b class="pt-you">${esc(t("points.you"))}</b>` : ""}</li>`;
    }).join("");
    const upgrade = !c.age_ok && c.plan !== "Diamond"
      ? `<p class="wd-hint"><a href="./activate.html">${esc(t("wd.upgradeHint"))}</a></p>` : "";
    const ended = c.plan_ended
      ? `<p class="wd-hint wd-warn">${esc(t("wd.planEnded", { plan: planName(c.plan_type) }))} <a href="./activate.html">${esc(t("wd.renew"))}</a></p>` : "";
    const lvMissing = Math.max(0, need - earned);
    return `
      <section class="wd-conds" aria-labelledby="wd-conds-h">
        <div class="wd-sec-head">
          <h2 id="wd-conds-h">${esc(t("wd.conds"))}</h2>
          <span class="wd-badge ${c.ok ? "ok" : "no"}">${esc(t(c.ok ? "wd.condsOk" : "wd.condsBoth"))}</span>
        </div>
        <div class="wd-cond-grid">
          <article class="wd-cond ${c.level_ok ? "ok" : "no"}" data-wd-cond="level">
            <span class="wd-cond-ico">${c.level_ok ? ICON.ok : ICON.no}</span>
            <div class="wd-cond-main">
              <h3>${esc(t("wd.condLevel"))}</h3>
              <p>${t("wd.yourLevel", { level: `<b><bdi dir="ltr">${esc(c.level_name || "LV0")}</bdi></b>`, have: pt(earned), need: pt(need) })}</p>
              <div class="pt-lv-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${lvPct}" aria-label="${esc(t("wd.condLevel"))}"><span style="width:${lvPct}%"></span></div>
              ${c.level_ok ? `<p class="wd-cond-note ok">${esc(t("wd.levelOk"))}</p>`
                : `<p class="wd-cond-note">${t("wd.levelMore", { pts: pt(lvMissing) })} <a href="#points" data-section="points">${esc(t("wd.howEarn"))}</a></p>`}
            </div>
          </article>
          <article class="wd-cond ${c.age_ok ? "ok" : "no"}" data-wd-cond="age">
            <span class="wd-cond-ico">${c.age_ok ? ICON.ok : ICON.no}</span>
            <div class="wd-cond-main">
              <h3>${esc(t("wd.condAge"))}</h3>
              <p>${t("wd.yourPlan", { plan: `<b>${esc(planName(c.plan))}</b>`, need: `<b>${esc(t(`wd.need.${PLANS.includes(c.plan) ? c.plan : "Free"}`))}</b>` })}</p>
              <div class="pt-lv-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${agePct}" aria-label="${esc(t("wd.condAge"))}"><span style="width:${agePct}%"></span></div>
              <p class="wd-cond-note${c.age_ok ? " ok" : ""}">${t(c.age_ok ? "wd.ageOk" : "wd.ageWait", { opened: `<bdi>${esc(day(c.created_at))}</bdi>`, date: `<b><bdi>${esc(day(c.eligible_at))}</bdi></b>` })}</p>
              <ul class="wd-rules" aria-label="${esc(t("wd.rulesLabel"))}">${rules}</ul>
              ${ended}${upgrade}
            </div>
          </article>
        </div>
      </section>`;
  }

  function stepsHtml(w) {
    const steps = [["sent", true], ["processing", w.status === "processing" || w.status === "paid"], ["paid", w.status === "paid"]];
    return `<ol class="wd-steps">${steps.map(([k, on]) => `<li class="${on ? "on" : ""}"><span></span>${esc(t(`wd.step.${k}`))}</li>`).join("")}</ol>`;
  }

  function openHtml(w) {
    return `
      <section class="wd-open st-${esc(w.status)}" aria-labelledby="wd-open-h" data-wd-open="${esc(w.id)}">
        <div class="wd-sec-head">
          <h2 id="wd-open-h">${esc(t("wd.openTitle"))}</h2>
          <span class="wd-st st-${esc(w.status)}">${esc(stText(w.status))}</span>
        </div>
        <div class="wd-open-main">
          <p class="wd-open-amount"><b>${money(w.net, w.currency)}</b><small>${pt(w.points)}${Number(w.fee) > 0 ? ` · ${t("wd.feeIs", { money: money(w.fee, w.currency) })}` : ""}</small></p>
          <p class="wd-open-meta"><span dir="ltr">${esc(w.id)}</span> · ${esc(day(w.created_at))}<br />${methodLine(w)}</p>
        </div>
        ${stepsHtml(w)}
        <p class="muted wd-open-note">${esc(t(w.status === "pending" ? "wd.heldNote" : "wd.processingNote"))}</p>
        ${w.status === "pending" ? `<div class="wd-open-acts"><button class="btn btn-sm btn-danger" type="button" data-wd-cancel="${esc(w.id)}">${esc(t("wd.cancel"))}</button></div>` : ""}
      </section>`;
  }

  function savedHtml(method, s) {
    if (!s) return "";
    const what = method === "bank"
      ? [s.bank, `\u2066${s.account}\u2069`, s.holder].filter(Boolean)
      : [s.agency, s.name, s.city, `\u2066${s.phone}\u2069`].filter(Boolean);
    return `
      <div class="wd-saved" data-wd-saved="${method}">
        <label class="wd-use"><input type="radio" name="${method}_use" value="saved" checked />
          <span><b>${esc(t("wd.useSaved"))}</b><small>${what.map((x) => (x.startsWith("\u2066") ? x : esc(x))).join(" · ")}</small></span></label>
        <label class="wd-use"><input type="radio" name="${method}_use" value="new" />
          <span><b>${esc(t("wd.useNew"))}</b></span></label>
        <button class="btn btn-sm btn-ghost wd-forget" type="button" data-wd-forget="${method}">${esc(t("wd.forget"))}</button>
      </div>`;
  }

  function field(name, label, attrs = "", hint = "") {
    return `
      <label class="wd-field" data-wd-f="${name}"><span>${esc(label)}</span>
        <input name="${name}" ${attrs} />
        ${hint ? `<small class="muted">${esc(hint)}</small>` : ""}</label>`;
  }

  function formHtml(d, member) {
    const s = d.settings || {};
    const c = d.check || {};
    const rate = Number(s.rate) || 100;
    const avail = Number(c.available) || 0;
    const most = Number(s.max_points) > 0 ? Math.min(avail, Number(s.max_points)) : avail;
    const enough = most >= Number(s.min_points);
    const methods = [s.bank ? "bank" : "", (s.agencies || []).length ? "agency" : ""].filter(Boolean);
    // the method with remembered details first (the bank when both have some), else the first one open
    const first = methods.includes("bank") && d.saved?.bank ? "bank" : methods.includes("agency") && d.saved?.agency ? "agency" : methods[0];
    const cc = String(member?.country || "").toUpperCase();
    const fullName = member?.full_name || "";
    if (!enough) {
      return `
        <section class="wd-form-box wd-locked" aria-labelledby="wd-form-h">
          <h2 id="wd-form-h">${esc(t("wd.formTitle"))}</h2>
          <p>${t("wd.notEnough", { pts: pt(s.min_points), have: pt(avail) })}</p>
          <p><a class="btn btn-sm btn-primary" href="#points" data-section="points">${esc(t("wd.howEarn"))}</a></p>
        </section>`;
    }
    return `
      <section class="wd-form-box" aria-labelledby="wd-form-h">
        <h2 id="wd-form-h">${esc(t("wd.formTitle"))}</h2>
        <form class="wd-form" id="wd-form" novalidate>
          <div class="wd-amount">
            <label class="wd-field" data-wd-f="points"><span>${esc(t("wd.f.points"))}</span>
              <span class="wd-amount-row">
                <input name="points" type="number" inputmode="numeric" dir="ltr" min="${Number(s.min_points)}" max="${most}" step="1" value="${most}" required />
                <b class="wd-unit">PT</b>
                <button class="btn btn-sm btn-ghost" type="button" data-wd-all>${esc(t("wd.all"))}</button>
              </span>
              <small class="muted">${t("wd.between", { min: pt(s.min_points), max: pt(most) })}</small></label>
            <p class="wd-sum" id="wd-sum" aria-live="polite"></p>
          </div>
          <fieldset class="wd-methods">
            <legend>${esc(t("wd.f.method"))}</legend>
            ${methods.includes("bank") ? `
            <label class="wd-method"><input type="radio" name="method" value="bank"${first === "bank" ? " checked" : ""} />
              <span class="wd-method-ico">${ICON.bank}</span>
              <span><b>${esc(t("wd.m.bank"))}</b><small>${esc(t("wd.m.bankSub"))}</small>${Number(s.bank_fee) > 0 ? `<small>${t("wd.feeIs", { money: money(s.bank_fee, s.currency) })}</small>` : ""}</span></label>` : ""}
            ${methods.includes("agency") ? `
            <label class="wd-method"><input type="radio" name="method" value="agency"${first === "agency" ? " checked" : ""} />
              <span class="wd-method-ico">${ICON.agency}</span>
              <span><b>${esc(t("wd.m.agency"))}</b><small>${esc(t("wd.m.agencySub", { list: (s.agencies || []).join(", ") }))}</small>${Number(s.agency_fee) > 0 ? `<small>${t("wd.feeIs", { money: money(s.agency_fee, s.currency) })}</small>` : ""}</span></label>` : ""}
          </fieldset>
          <div class="wd-pane" data-wd-pane="bank"${first === "bank" ? "" : " hidden"}>
            ${savedHtml("bank", d.saved?.bank)}
            <div class="wd-fields" data-wd-new="bank"${d.saved?.bank ? " hidden" : ""}>
              ${field("holder", t("wd.f.holder"), `maxlength="80" dir="auto" autocomplete="name" value="${esc(fullName)}"`, t("wd.f.holderHint"))}
              ${field("bank", t("wd.f.bank"), 'maxlength="80" dir="auto"')}
              ${field("account", t("wd.f.account"), 'maxlength="44" dir="ltr" autocomplete="off" spellcheck="false" autocapitalize="characters" placeholder="MA64 0115 1900 0001 2050 0053 4921"', t("wd.f.accountHint"))}
              ${field("swift", t("wd.f.swift"), 'maxlength="14" dir="ltr" autocomplete="off" spellcheck="false" autocapitalize="characters" placeholder="BCMAMAMC"', t("wd.f.swiftHint"))}
              <label class="wd-field" data-wd-f="country"><span>${esc(t("wd.f.bankCountry"))}</span>
                <select name="country">${countryOptions(cc)}</select></label>
            </div>
          </div>
          <div class="wd-pane" data-wd-pane="agency"${first === "agency" ? "" : " hidden"}>
            ${savedHtml("agency", d.saved?.agency)}
            <div class="wd-fields" data-wd-new="agency"${d.saved?.agency ? " hidden" : ""}>
              <label class="wd-field" data-wd-f="agency"><span>${esc(t("wd.f.agency"))}</span>
                <select name="agency">${(s.agencies || []).map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join("")}</select></label>
              ${field("name", t("wd.f.name"), `maxlength="80" dir="auto" autocomplete="name" value="${esc(fullName)}"`, t("wd.f.nameHint"))}
              <label class="wd-field" data-wd-f="country"><span>${esc(t("wd.f.country"))}</span>
                <select name="country">${countryOptions(cc)}</select></label>
              ${field("city", t("wd.f.city"), 'maxlength="80" dir="auto" autocomplete="address-level2"')}
              ${field("phone", t("wd.f.phone"), 'type="tel" maxlength="24" dir="ltr" autocomplete="tel" placeholder="+212 600 000 000"')}
            </div>
          </div>
          <label class="wd-check" data-wd-remember><input type="checkbox" name="save" checked /> <span>${esc(t("wd.remember"))}</span></label>
          <label class="wd-field" data-wd-f="password"><span>${esc(t("wd.f.password"))}</span>
            <input name="password" type="password" autocomplete="current-password" maxlength="128" required />
            <small class="muted">${esc(t("wd.f.passwordHint"))}</small></label>
          <div class="form-alert" id="wd-alert" role="alert"></div>
          <button class="btn btn-lg btn-primary wd-submit" type="submit">${esc(t("wd.send"))}</button>
          <p class="muted wd-foot">${esc(t("wd.foot"))}${s.note ? `<br /><b>${esc(s.note)}</b>` : ""}</p>
        </form>
      </section>`;
  }

  function historyHtml(list) {
    if (!list.length) return `<p class="muted">${esc(t("wd.none"))}</p>`;
    return `<ul class="wd-list">${list.map((w) => `
      <li class="wd-item st-${esc(w.status)}">
        <div class="wd-item-top">
          <span class="wd-item-amount"><b>${money(w.net, w.currency)}</b><small>${pt(w.points)} · <span dir="ltr">${esc(w.id)}</span> · ${esc(day(w.created_at))}</small></span>
          <span class="wd-st st-${esc(w.status)}">${esc(stText(w.status))}</span>
        </div>
        <p class="wd-item-line">${methodLine(w)}</p>
        ${w.status === "paid" ? `
          <p class="wd-item-line wd-ref">${esc(t("wd.reference"))} <code dir="ltr">${esc(w.reference)}</code>
            <button class="btn btn-sm btn-ghost wd-copy" type="button" data-wd-copy="${esc(w.reference)}" aria-label="${esc(t("wd.copy"))}">${ICON.copy}<span>${esc(t("wd.copy"))}</span></button>
            <small>${esc(t("wd.sentOn", { date: day(w.paid_at) }))}</small></p>
          ${w.note ? `<p class="wd-item-line"><q>${esc(w.note)}</q></p>` : ""}` : ""}
        ${w.status === "rejected" ? `
          <p class="wd-item-line wd-why">${esc(t("wd.reason"))} <q>${esc(w.reason)}</q></p>
          <p class="wd-item-line ${w.refunded ? "wd-back" : "wd-kept"}">${esc(t(w.refunded ? "wd.backYes" : "wd.backNo", { pts: num(w.points) }))}</p>` : ""}
        ${w.status === "cancelled" ? `<p class="wd-item-line wd-back">${esc(t("wd.backCancel", { pts: num(w.points) }))}</p>` : ""}
      </li>`).join("")}</ul>`;
  }

  // ---------------------------------------------------------------- the section
  async function view(main, ctx) {
    main.innerHTML = `
      <p class="eyebrow">${t("dash.nav.withdraw")}</p>
      <h1>${t("wd.title")}</h1>
      <p class="muted">${t("wd.lead")}</p>
      <div id="wd-body" class="wd-body"><p class="muted">${t("wd.loading")}</p></div>`;
    await draw(main, ctx);
  }

  async function draw(main, ctx) {
    const box = main.querySelector("#wd-body");
    if (!box) return;
    const r = await C.rpc("withdraw_me", { p_member: ctx.member.member_id }).catch(() => null);
    if (!ctx.current() || !box.isConnected) return;
    if (!r || !r.ok || !r.data || r.data.ok === false) {
      const missing = Boolean(r) && (r.status === 404 || ["PGRST202", "42883"].includes(r.data?.code));
      if (missing) console.warn("CineAura: withdraw_me() is missing — run sql/withdrawals.sql in the Supabase SQL editor.");
      box.innerHTML = `<div class="form-alert show warn">${esc(t(missing ? "wd.setup" : "wd.loadFail"))}</div>`;
      return;
    }
    const d = r.data;
    const c = d.check || {};
    const s = d.settings || {};
    const account = c.account && c.account !== "ok"
      ? `<div class="form-alert show error wd-account">${esc(t(c.account === "blocked" ? "wd.err.blocked" : "wd.err.disabled"))}</div>` : "";
    let action;
    if (d.open) action = openHtml(d.open);
    else if (!s.enabled) action = `<section class="wd-form-box wd-locked"><h2>${esc(t("wd.formTitle"))}</h2><p>${esc(t("wd.err.closed"))}</p></section>`;
    else if (!c.ok) {
      action = `
        <section class="wd-form-box wd-locked" aria-labelledby="wd-form-h">
          <span class="wd-lock-ico">${ICON.lock}</span>
          <div><h2 id="wd-form-h">${esc(t("wd.formTitle"))}</h2><p>${esc(t("wd.lockedText"))}</p></div>
        </section>`;
    } else action = formHtml(d, ctx.member);
    box.innerHTML = `
      ${account}
      ${statsHtml(d)}
      ${condsHtml(d)}
      ${action}
      <section class="wd-history" aria-labelledby="wd-hist-h">
        <h2 id="wd-hist-h">${esc(t("wd.history"))}</h2>
        ${historyHtml(Array.isArray(d.history) ? d.history : [])}
      </section>`;
    wire(main, ctx, d);
  }

  function wire(main, ctx, d) {
    const box = main.querySelector("#wd-body");
    const s = d.settings || {};
    const rate = Number(s.rate) || 100;
    box.onclick = async (e) => {
      const cancel = e.target.closest("[data-wd-cancel]");
      if (cancel) {
        if (!window.confirm(t("wd.cancelAsk"))) return;
        cancel.disabled = true;
        const r = await C.rpc("withdraw_cancel", { p_member: ctx.member.member_id, p_id: cancel.dataset.wdCancel }).catch(() => null);
        if (!r?.ok || !r.data?.ok) {
          cancel.disabled = false;
          C.toast(t(r?.data?.reason === "state" ? "wd.err.cancelLate" : "wd.err.network"));
          await draw(main, ctx);
          return;
        }
        C.toast(t("wd.cancelled", { pts: num(r.data.points) }));
        await draw(main, ctx);
        return;
      }
      const forget = e.target.closest("[data-wd-forget]");
      if (forget) {
        if (!window.confirm(t("wd.forgetAsk"))) return;
        forget.disabled = true;
        const r = await C.rpc("withdraw_forget", { p_member: ctx.member.member_id, p_method: forget.dataset.wdForget }).catch(() => null);
        C.toast(t(r?.ok ? "wd.forgotten" : "wd.err.network"));
        await draw(main, ctx);
        return;
      }
      const copy = e.target.closest("[data-wd-copy]");
      if (copy) {
        try {
          await navigator.clipboard.writeText(copy.dataset.wdCopy);
          C.toast(t("wd.copied"));
        } catch {
          C.toast(copy.dataset.wdCopy);
        }
      }
    };
    const form = box.querySelector("#wd-form");
    if (!form) return;
    const alertBox = form.querySelector("#wd-alert");
    const sum = form.querySelector("#wd-sum");
    const method = () => form.querySelector('input[name="method"]:checked')?.value || "bank";
    const pane = () => form.querySelector(`[data-wd-pane="${method()}"]`);
    const usesSaved = () => {
      const r = pane()?.querySelector(`input[name="${method()}_use"]:checked`);
      return Boolean(r) && r.value === "saved";
    };
    const clearError = () => {
      alertBox.className = "form-alert";
      alertBox.textContent = "";
      form.querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
    };
    const showError = (text, fieldName) => {
      alertBox.className = "form-alert show error";
      alertBox.textContent = text;
      const where = fieldName === "points" || fieldName === "password" ? form : pane();
      const input = fieldName ? where?.querySelector(`[name="${fieldName}"]`) : null;
      if (input && !input.closest("[hidden]")) {
        input.setAttribute("aria-invalid", "true");
        input.focus();
      } else {
        alertBox.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    };
    const update = () => {
      const pts = Math.floor(Number(form.points.value) || 0);
      const fee = Number(method() === "bank" ? s.bank_fee : s.agency_fee) || 0;
      const amount = Math.round((pts / rate) * 100) / 100;
      const net = Math.max(0, Math.round((amount - fee) * 100) / 100);
      sum.innerHTML = pts > 0
        ? `${t("wd.youGet", { money: `<b>${money(net, s.currency)}</b>` })}${fee > 0 ? ` <small>${t("wd.sumFee", { amount: money(amount, s.currency), fee: money(fee, s.currency) })}</small>` : ""}`
        : "";
      // the remembered details stay as they are: nothing to remember
      form.querySelector("[data-wd-remember]").hidden = usesSaved();
    };
    form.addEventListener("input", (e) => {
      clearError();
      if (e.target.name === "points") update();
    });
    form.addEventListener("change", (e) => {
      if (e.target.name === "method") {
        form.querySelectorAll("[data-wd-pane]").forEach((p) => { p.hidden = p.dataset.wdPane !== method(); });
      }
      if (/_use$/.test(e.target.name || "")) {
        const m = e.target.name.replace(/_use$/, "");
        const fields = form.querySelector(`[data-wd-new="${m}"]`);
        if (fields) fields.hidden = e.target.value === "saved";
      }
      clearError();
      update();
    });
    form.querySelector("[data-wd-all]")?.addEventListener("click", () => {
      form.points.value = form.points.max;
      clearError();
      update();
    });
    update();
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      clearError();
      const pts = Number(form.points.value);
      const max = Number(form.points.max);
      if (!Number.isInteger(pts) || pts < Number(s.min_points)) return showError(t("wd.err.min", { pts: pt(s.min_points) }), "points");
      if (pts > max) {
        const capped = Number(s.max_points) > 0 && max >= Number(s.max_points);
        return showError(t(capped ? "wd.err.max" : "wd.err.balance", { pts: pt(max) }), "points");
      }
      const m = method();
      let details;
      if (usesSaved()) details = { saved: true };
      else {
        const p = pane();
        const val = (n) => line(p.querySelector(`[name="${n}"]`)?.value);
        details = m === "bank"
          ? { holder: val("holder"), bank: val("bank"), account: val("account").toUpperCase(), swift: val("swift").toUpperCase(), country: val("country") }
          : { agency: val("agency"), name: val("name"), country: val("country"), city: val("city"), phone: val("phone") };
        const bad = detailsError(m, details);
        if (bad) return showError(t(ERR[bad]), FIELD[bad]);
      }
      const pass = form.password.value;
      if (!pass) return showError(t("wd.err.passwordEmpty"), "password");
      const btn = form.querySelector(".wd-submit");
      btn.disabled = true;
      btn.textContent = t("wd.sending");
      const hash = await C.sha256(pass);
      const r = await C.rpc("withdraw_request", {
        p_member: ctx.member.member_id, p_password: hash, p_points: pts, p_method: m, p_details: details,
        p_save: Boolean(form.save?.checked),
      }).catch(() => null);
      btn.disabled = false;
      btn.textContent = t("wd.send");
      if (!r || !r.ok) {
        const missing = Boolean(r) && (r.status === 404 || ["PGRST202", "42883"].includes(r.data?.code));
        return showError(t(missing ? "wd.setup" : "wd.err.network"));
      }
      const x = r.data || {};
      if (!x.ok) {
        if (x.reason === "password") form.password.value = "";
        const text = t(ERR[x.reason] || "wd.err.network", {
          n: num(x.reason === "locked" ? x.minutes : x.left), date: day(x.eligible_at), pts: pt(x.min ?? x.max ?? x.have ?? 0),
          fee: money(x.fee || 0, s.currency),
        });
        // a refusal that changes the page (the conditions, a request sent meanwhile): drawn again
        if (["level", "age", "open", "closed", "disabled", "banned", "blocked", "saved"].includes(x.reason)) {
          C.toast(text);
          await draw(main, ctx);
          return;
        }
        return showError(text, FIELD[x.reason]);
      }
      C.toast(t("wd.sent", { money: C.moneyText(x.net, x.currency) }));
      await draw(main, ctx);
      main.querySelector("[data-wd-open]")?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  }

  window.CineAuraWithdraw = { view, ibanOk };
})();
