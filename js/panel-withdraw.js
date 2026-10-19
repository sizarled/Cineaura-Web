/* CineAura — Panel > Withdrawals (sql/withdrawals.sql), loaded after js/panel-admin.js:
 *
 *   Requests   the members' requests, the waiting ones oldest first (filters: waiting, approved,
 *              sent, rejected, cancelled, all; a search by request, member, name or reference).
 *              Each card: the member, the amount to send, the payment details in full (each one
 *              copied with a click), whether the name of the payment is the name of the account,
 *              where the member stands today (level, membership, age of the account).
 *              Approve (the transfer is on its way), Mark as sent (the reference of the transfer:
 *              the MTCN of Western Union, the bank reference — the member reads it), Reject (a
 *              reason the member reads; the points come back unless the team keeps them).
 *   Settings   withdrawals open or closed, the value of a point (points for 1 unit of the currency),
 *              the currency, the least and the most points of a request, bank transfers and the
 *              money transfer agencies (by name) with their fees, a note for the members.
 *
 * The Super Admin, or staff with the Withdrawals section (Panel > Staff).
 */
(() => {
  "use strict";
  const C = window.CineAura;
  const PA = window.CineAuraPanelAdmin;
  if (!C || !PA || !PA.kit) return;
  const K = PA.kit;
  const { t, escapeHtml: esc, toast } = C;
  const STATUSES = ["pending", "processing", "paid", "rejected", "cancelled"];
  const stText = (s) => t(`wd.st.${STATUSES.includes(s) ? s : "pending"}`);
  const money = (n, cur) => `\u2066${C.moneyText(n, cur)}\u2069`;
  const planName = (p) => (C.tr ? C.tr(p) : p);
  const country = (cc) => (cc ? `${C.countryName?.(cc) || cc} (${cc})` : "");
  const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "MAD", "DZD", "TND", "EGP", "SAR", "AED", "QAR", "KWD", "TRY"];
  const COPY_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M5.5 15.5h-1a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>';
  const ERR = {
    action: "panel.actFail", state: "pw.err.state", reference: "pw.err.reference", reason: "pa.errReason", not_found: "pa.errGone",
    rate: "pw.err.rate", currency: "pw.err.currency", min: "pw.err.min", max: "pw.err.max", fee: "pw.err.fee",
    agencies: "pw.err.agencies", methods: "pw.err.methods", note: "pw.err.note",
  };

  // ---------------------------------------------------------------- the numbers above the list
  function stripHtml(s) {
    if (!s) return "";
    const cell = (label, value, extra = "") => `<div class="pa-cell${extra}"><span>${esc(label)}</span><strong dir="ltr">${value}</strong></div>`;
    return `
      <div class="pa-strip pw-strip">
        ${cell(t("pw.ov.pending"), K.num(s.pending), Number(s.pending) ? " warn" : "")}
        ${cell(t("pw.ov.processing"), K.num(s.processing))}
        ${cell(t("pw.held"), K.pt(s.held))}
        ${cell(t("pw.toSend"), money(s.to_send, s.currency))}
        ${cell(t("pw.ov.paid30"), money(s.paid_30d_net, s.currency))}
        ${cell(t("pw.paidAll"), `${money(s.paid_net, s.currency)} <small>· ${K.num(s.paid)}</small>`)}
      </div>`;
  }

  // ---------------------------------------------------------------- one request
  function detailsHtml(w) {
    const d = w.details || {};
    const rows = w.method === "bank"
      ? [["pw.d.holder", d.holder], ["pw.d.bank", d.bank], [d.iban ? "pw.d.iban" : "pw.d.account", String(d.account || "").replace(/(.{4})(?=.)/g, "$1 "), true],
         ["pw.d.swift", d.swift, true], ["pw.d.country", country(d.country)]]
      : [["pw.d.agency", d.agency || w.agency], ["pw.d.name", d.name], ["pw.d.country", country(d.country)], ["pw.d.city", d.city], ["pw.d.phone", d.phone, true]];
    return `<dl class="pw-details">${rows.filter((r) => r[1]).map(([k, v, ltr]) => `
      <div><dt>${esc(t(k))}</dt>
        <dd><span${ltr ? ' dir="ltr"' : ' dir="auto"'}>${esc(v)}</span>
          <button class="pw-copy" type="button" data-pa-act="copy" data-copy="${esc(ltr ? String(v).replace(/\s+/g, "") : v)}" aria-label="${esc(t("wd.copy"))}" title="${esc(t("wd.copy"))}">${COPY_ICON}</button></dd></div>`).join("")}</dl>`;
  }

  function linesHtml(w) {
    const out = [];
    const c = w.checks || {};
    if (c.level != null) {
      out.push(`<p class="pw-line muted">${esc(t("pw.atRequest", { level: c.level >= 10 ? "LV Max" : `LV${c.level}`, plan: planName(c.plan || "Free"), days: K.num(c.age_days), pts: K.num(c.available) }))}</p>`);
    }
    if (w.decided_by && (w.status === "processing" || w.status === "paid")) {
      out.push(`<p class="pw-line">${esc(t("pw.approvedBy", { by: w.decided_by, date: K.when(w.decided_at) }))}</p>`);
    }
    if (w.status === "paid") {
      out.push(`<p class="pw-line pw-ok">${esc(t("pw.sentBy", { by: w.paid_by || "—", date: K.when(w.paid_at) }))} <code dir="ltr">${esc(w.reference)}</code></p>`);
      if (w.note) out.push(`<p class="pw-line"><q>${esc(w.note)}</q></p>`);
    }
    if (w.status === "rejected") {
      out.push(`<p class="mkr-why pa-why">${esc(t("pw.rejectedBy", { by: w.decided_by || "—", date: K.when(w.decided_at) }))} <q>${esc(w.reason)}</q> · ${esc(t(w.refunded ? "pw.back" : "pw.kept"))}</p>`);
    }
    if (w.status === "cancelled") out.push(`<p class="pw-line muted">${esc(t("pw.cancelledOn", { date: K.when(w.cancelled_at) }))}</p>`);
    return out.join("");
  }

  function cardHtml(w, i) {
    const m = w.member || {};
    const now = w.now || {};
    const open = w.status === "pending" || w.status === "processing";
    return `
      <article class="crp-card pa-card pw-card st-${esc(w.status)}" data-pa-i="${i}" data-pw-id="${esc(w.id)}">
        <div class="crp-top">
          <span class="pa-thumb pw-avatar"><img src="${esc(m.avatar || C.initialsAvatar(m.username || "CA"))}" alt="" data-avatar-for="${esc(m.id || "")}" data-avatar-name="${esc(m.username || "")}" loading="lazy" /></span>
          <div class="crp-title">
            <h3>${K.who({ id: m.id, username: m.username })} ${m.full_name ? `<small class="muted" dir="auto">${esc(m.full_name)}</small>` : ""}</h3>
            <p><span dir="ltr">${esc(w.id)}</span> · ${esc(K.when(w.created_at))} · <span dir="ltr">${esc(m.id || "")}</span>${m.country ? ` · ${esc(m.country)}` : ""}</p>
          </div>
          <div class="pw-amount"><strong>${money(w.net, w.currency)}</strong><small>${K.pt(w.points)}</small></div>
        </div>
        <div class="crp-tags">
          ${K.tag(stText(w.status), `pw-st st-${esc(w.status)}`)}
          ${K.tag(w.method === "bank" ? t("wd.m.bank") : w.agency || t("wd.m.agency"))}
          ${now.plan ? K.tag(planName(now.plan)) : ""}
          ${now.level_name ? K.tag(now.level_name) : ""}
          ${now.age_days != null ? K.tag(t("pw.ageDays", { n: K.num(now.age_days) })) : ""}
          ${w.name_match ? K.tag(t("pw.nameOk"), "st-resolved") : K.tag(t("pw.nameDiff", { name: m.full_name || "—" }), "st-open")}
          ${open && now.ok === false ? K.tag(t(now.account && now.account !== "ok" ? "pw.accountOff" : "pw.notEligible"), "mkr-susp") : ""}
        </div>
        ${detailsHtml(w)}
        <p class="pw-money">${t("pw.moneyLine", { pts: K.pt(w.points), rate: K.num(w.rate), amount: money(w.amount, w.currency), fee: money(w.fee, w.currency), net: `<b>${money(w.net, w.currency)}</b>` })}</p>
        ${linesHtml(w)}
        ${open ? `
          <div class="crp-actions">
            ${w.status === "pending" ? `<button class="btn btn-sm btn-ghost" type="button" data-pa-act="approve">${esc(t("pw.approve"))}</button>` : ""}
            <button class="btn btn-sm btn-primary" type="button" data-pa-act="pay">${esc(t("pw.pay"))}</button>
            <button class="btn btn-sm btn-danger" type="button" data-pa-act="reject">${esc(t("pw.reject"))}</button>
          </div>` : ""}
        <div data-pa-slot></div>
      </article>`;
  }

  const payForm = (w) => `
    <form class="pa-inline pw-form" data-pa-form="pay">
      <label><span>${esc(t("pw.refLabel"))}</span>
        <input name="reference" type="text" maxlength="80" required dir="ltr" autocomplete="off" placeholder="${esc(t(w.method === "bank" ? "pw.refPhBank" : "pw.refPhAgency"))}" /></label>
      <label><span>${esc(t("pw.noteLabel"))}</span>
        <textarea name="note" rows="2" maxlength="300" dir="auto" placeholder="${esc(t("pw.notePh"))}"></textarea></label>
      <p class="muted">${t("pw.payEffect", { money: money(w.net, w.currency) })}</p>
      <div class="acc-actions">
        <button class="btn btn-sm btn-primary" type="submit">${esc(t("pw.payNow"))}</button>
        <button class="btn btn-sm btn-ghost" type="button" data-pa-cancel>${esc(t("common.cancel"))}</button>
      </div>
    </form>`;

  const rejectForm = (w) => `
    <form class="mkr-suspend pa-reason pw-form" data-pa-form="reject">
      <label><span>${esc(t("pw.rejectLabel"))}</span>
        <textarea name="reason" rows="2" maxlength="300" required dir="auto" placeholder="${esc(t("pa.reasonPh"))}"></textarea></label>
      <label class="pa-check"><input type="checkbox" name="refund" checked /> ${esc(t("pw.refund", { pts: K.num(w.points) }))}</label>
      <p class="muted">${esc(t("pw.rejectEffect"))}</p>
      <div class="acc-actions">
        <button class="btn btn-sm btn-danger" type="submit">${esc(t("pw.rejectNow"))}</button>
        <button class="btn btn-sm btn-ghost" type="button" data-pa-cancel>${esc(t("common.cancel"))}</button>
      </div>
    </form>`;

  // a refusal: said in a toast; a request another member of the team changed meanwhile: the list again
  const failed = (r, redraw) => {
    K.failToast(r, ERR);
    if (["state", "not_found"].includes(r?.data?.reason)) redraw();
  };

  const listCfg = () => ({
    key: "pw-requests",
    filters: [["pending", t("pw.f.pending")], ["processing", t("pw.f.processing")], ["paid", t("pw.f.paid")],
      ["rejected", t("pw.f.rejected")], ["cancelled", t("pw.f.cancelled")], ["all", t("pa.f.all")]],
    placeholder: t("pw.searchPh"),
    lead: t("pw.listLead"),
    empty: t("pw.none"),
    before: (st, d) => stripHtml(d?.stats),
    fetch: (st, off) => K.rpc("withdraw_admin_list", { p_filter: st.filter, p_q: st.q, p_limit: K.PAGE, p_offset: off }),
    card: cardHtml,
    act: async (a, w, cardEl, btn, redraw) => {
      if (a === "copy") {
        try {
          await navigator.clipboard.writeText(btn.dataset.copy || "");
          toast(t("wd.copied"));
        } catch {
          toast(btn.dataset.copy || "");
        }
        return;
      }
      if (a === "approve") {
        if (!window.confirm(t("pw.approveAsk", { money: C.moneyText(w.net, w.currency), user: w.member?.username || w.member_id || "" }))) return;
        btn.disabled = true;
        const r = await K.rpc("withdraw_admin_action", { p_id: w.id, p_action: "approve", p_reason: "", p_reference: "", p_refund: true });
        btn.disabled = false;
        if (!K.data(r)) return failed(r, redraw);
        toast(t("pw.approved"));
        redraw();
        return;
      }
      if (a === "pay") K.openSlot(cardEl, payForm(w));
      if (a === "reject") K.openSlot(cardEl, rejectForm(w));
    },
    submit: async (a, form, w, cardEl, redraw) => {
      if (a === "pay") {
        const ref = String(form.reference.value || "").trim();
        if (ref.length < 3) {
          toast(t("pw.err.reference"));
          form.reference.focus();
          return;
        }
        if (!window.confirm(t("pw.payAsk", { money: C.moneyText(w.net, w.currency), ref }))) return;
        const r = await K.busy(form, () => K.rpc("withdraw_admin_action", { p_id: w.id, p_action: "pay", p_reason: String(form.note.value || "").trim(), p_reference: ref, p_refund: true }));
        if (!K.data(r)) return failed(r, redraw);
        toast(t("pw.paidDone"));
        redraw();
        return;
      }
      if (a === "reject") {
        const reason = K.reasonOf(form);
        if (!reason) return;
        const back = Boolean(form.refund.checked);
        if (!window.confirm(t(back ? "pw.rejectAsk" : "pw.rejectKeepAsk"))) return;
        const r = await K.busy(form, () => K.rpc("withdraw_admin_action", { p_id: w.id, p_action: "reject", p_reason: reason, p_reference: "", p_refund: back }));
        if (!K.data(r)) return failed(r, redraw);
        toast(t(back ? "pw.rejectedDone" : "pw.rejectedKept"));
        redraw();
      }
    },
  });

  // ---------------------------------------------------------------- settings
  async function drawSettings(pane) {
    pane.innerHTML = `<p class="muted">${t("pa.loading")}</p>`;
    const r = await K.rpc("withdraw_admin_settings", {});
    if (!pane.isConnected) return;
    const d = K.data(r);
    if (!d) {
      pane.innerHTML = `<div class="form-alert show warn">${t(K.errKey(r))}</div>`;
      return;
    }
    const s = d.settings || {};
    const curs = CURRENCIES.includes(s.currency) ? CURRENCIES : [s.currency, ...CURRENCIES];
    pane.innerHTML = `
      <section class="pa-box pw-set-box">
        <form class="pa-form-grid pw-settings" id="pw-set" novalidate>
          <label class="wide pa-check pw-on"><input type="checkbox" name="enabled" ${s.enabled ? "checked" : ""} />
            <span><b>${esc(t("pw.s.enabled"))}</b><small class="muted">${esc(t("pw.s.enabledHint"))}</small></span></label>
          <label><span>${esc(t("pw.s.rate"))}</span>
            <input name="rate" type="number" min="1" max="1000000" step="1" value="${Number(s.rate) || 100}" required dir="ltr" />
            <small class="muted">${esc(t("pw.s.rateHint"))}</small></label>
          <label><span>${esc(t("pw.s.currency"))}</span>
            <select name="currency">${curs.map((c) => `<option value="${esc(c)}"${c === s.currency ? " selected" : ""}>${esc(c)}</option>`).join("")}</select></label>
          <label><span>${esc(t("pw.s.min"))}</span>
            <input name="min_points" type="number" min="1" max="100000000" step="1" value="${Number(s.min_points) || 1}" required dir="ltr" /></label>
          <label><span>${esc(t("pw.s.max"))}</span>
            <input name="max_points" type="number" min="0" max="1000000000" step="1" value="${Number(s.max_points) || 0}" dir="ltr" />
            <small class="muted">${esc(t("pw.s.maxHint"))}</small></label>
          <fieldset class="wide pw-method-set">
            <legend>${esc(t("wd.m.bank"))}</legend>
            <label class="pa-check"><input type="checkbox" name="bank" ${s.bank ? "checked" : ""} /> ${esc(t("pw.s.bankOn"))}</label>
            <label><span>${esc(t("pw.s.fee"))}</span>
              <input name="bank_fee" type="number" min="0" max="100000" step="0.01" value="${Number(s.bank_fee) || 0}" dir="ltr" /></label>
          </fieldset>
          <fieldset class="wide pw-method-set">
            <legend>${esc(t("wd.m.agency"))}</legend>
            <label class="pw-agencies"><span>${esc(t("pw.s.agencies"))}</span>
              <input name="agencies" type="text" maxlength="460" value="${esc((s.agencies || []).join(", "))}" dir="auto" placeholder="Western Union, MoneyGram, Ria" />
              <small class="muted">${esc(t("pw.s.agenciesHint"))}</small></label>
            <label><span>${esc(t("pw.s.fee"))}</span>
              <input name="agency_fee" type="number" min="0" max="100000" step="0.01" value="${Number(s.agency_fee) || 0}" dir="ltr" /></label>
          </fieldset>
          <label class="wide"><span>${esc(t("pw.s.note"))}</span>
            <textarea name="note" rows="2" maxlength="500" dir="auto" placeholder="${esc(t("pw.s.notePh"))}">${esc(s.note || "")}</textarea></label>
          <div class="wide pa-form-foot">
            <p class="muted" id="pw-preview" aria-live="polite"></p>
            <button class="btn btn-sm btn-primary" type="submit">${esc(t("common.save"))}</button>
          </div>
          ${s.updated_by ? `<p class="wide muted pw-updated">${esc(t("pw.s.updated", { by: s.updated_by, date: K.when(s.updated_at) }))}</p>` : ""}
        </form>
      </section>
      <p class="muted pw-rules">${esc(t("pw.s.rules"))}</p>`;
    const form = pane.querySelector("#pw-set");
    const preview = () => {
      const rate = Math.max(1, Math.floor(Number(form.rate.value) || 0));
      const min = Math.max(1, Math.floor(Number(form.min_points.value) || 0));
      pane.querySelector("#pw-preview").innerHTML = t("pw.s.preview", {
        rate: K.pt(rate), one: money(1, form.currency.value), min: K.pt(min), cash: money(min / rate, form.currency.value),
      });
    };
    form.addEventListener("input", preview);
    form.addEventListener("change", preview);
    preview();
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = {
        enabled: form.enabled.checked,
        rate: String(form.rate.value || "").trim(),
        currency: form.currency.value,
        min_points: String(form.min_points.value || "").trim(),
        max_points: String(form.max_points.value || "").trim(),
        bank: form.bank.checked,
        bank_fee: String(form.bank_fee.value || "0").trim() || "0",
        agencies: String(form.agencies.value || "").split(",").map((x) => x.trim()).filter(Boolean),
        agency_fee: String(form.agency_fee.value || "0").trim() || "0",
        note: String(form.note.value || "").trim(),
      };
      const r = await K.busy(form, () => K.rpc("withdraw_admin_settings_save", { d: body }));
      if (!K.data(r)) return K.failToast(r, ERR);
      try {
        sessionStorage.removeItem("cineaura_point_value");
      } catch {
        /* nothing kept */
      }
      toast(t("pa.saved"));
      drawSettings(pane);
    });
  }

  // ---------------------------------------------------------------- the section
  async function viewWithdrawals(main) {
    const ctx = K.ctx();
    const st = ctx.state;
    // opened from the Overview with a filter: the requests
    if (st.paPreset) st.paWdTab = "requests";
    const tab = ["requests", "settings"].includes(st.paWdTab) ? st.paWdTab : "requests";
    main.innerHTML = `
      ${K.head(t("panel.nav.withdrawals"), t("pw.title"), t("pw.lead"))}
      ${K.tabsHtml("pw-tab", [["requests", t("pw.tab.requests")], ["settings", t("pw.tab.settings")]], tab)}
      <div class="follow-pane pa-pane" id="pa-pane"></div>`;
    main.querySelectorAll("[data-pw-tab]").forEach((b) => {
      b.onclick = () => {
        if (b.dataset.pwTab === tab) return;
        st.paWdTab = b.dataset.pwTab;
        viewWithdrawals(main);
      };
    });
    const pane = main.querySelector("#pa-pane");
    if (tab === "settings") await drawSettings(pane);
    else await K.drawList(pane, listCfg());
  }

  PA.add("withdrawals", viewWithdrawals);
})();
