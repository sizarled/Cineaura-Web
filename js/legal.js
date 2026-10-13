/* CineAura — information pages: support.html, privacy.html, terms.html, about.html.

   The four pages share one document layout (.lg-wrap / .lg-layout / .lg-card) styled by
   css/legal.css. This file adds the small behaviour they share:

   - the header, the settings menu, the bell and the auth buttons (CineAura.setupChrome);
   - a table of contents built from the section titles, so nothing is written twice and
     every entry follows the current language;
   - the "last updated" date, formatted with the locale of the chosen language;
   - the contact form of support.html, which writes to the same panel_messages table the
     home page form uses (the chosen topic is prefixed to the body, because the table has
     no subject column);
   - "back to top" links.

   Everything degrades quietly: a page without a form, without a TOC or without a date
   simply skips that part. */
(() => {
  "use strict";

  const C = window.CineAura;
  if (!C) return;
  const { $, $$, t, toast, setupChrome, formatDate, getSession, supabaseRequest, translateDom } = C;

  const UPDATED = "2026-10-11"; // keep in sync with the <time> element of each page
  const SENT_KEY = "home.msg.sent";
  const FAIL_KEY = "sup.formFail";

  /* ── Table of contents ─────────────────────────────────────────────
     Built from the h2 of every .lg-card section, using the i18n key of the
     heading so the list is rebuilt in the new language on a switch. */
  function sections() {
    return $$(".lg-body section[id]").filter((sec) => $("h2[data-i18n]", sec));
  }

  function buildToc() {
    const list = $("#lg-toc-list");
    if (!list) return;
    list.innerHTML = sections()
      .map((sec) => {
        const h2 = $("h2[data-i18n]", sec);
        const label = t(h2.getAttribute("data-i18n"));
        return `<li><a href="#${sec.id}">${C.escapeHtml(label)}</a></li>`;
      })
      .join("");
    spy();
  }

  /* Highlight the entry of the section currently in view. */
  function spy() {
    const links = $$("#lg-toc a");
    if (!links.length) return;
    const offset = 140;
    let current = links[0].getAttribute("href");
    sections().forEach((sec) => {
      if (sec.getBoundingClientRect().top - offset <= 0) current = `#${sec.id}`;
    });
    links.forEach((a) => a.classList.toggle("on", a.getAttribute("href") === current));
  }

  /* ── Last updated ─────────────────────────────────────────────── */
  function renderUpdated() {
    const el = $("#legal-updated");
    if (!el) return;
    const value = el.getAttribute("datetime") || UPDATED;
    el.textContent = formatDate(value);
  }

  /* ── Back to top ──────────────────────────────────────────────── */
  function bindTop() {
    $$("[data-lg-top]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });
  }

  /* ── Contact form (support.html) ──────────────────────────────── */
  function prefillForm(form) {
    const session = getSession();
    if (!session) return;
    const name = form.elements.namedItem?.("name");
    const email = form.elements.namedItem?.("email");
    if (name && !name.value && session.full_name) name.value = session.full_name;
    if (email && !email.value && session.email) email.value = session.email;
  }

  function bindContactForm() {
    const form = $("#support-form");
    if (!form || form.dataset.bound) return;
    form.dataset.bound = "1";
    prefillForm(form);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const button = $("button[type=submit]", form);
      const fd = new FormData(form);
      const session = getSession();
      const topicKey = String(fd.get("topic") || "").trim();
      const topic = topicKey ? t(topicKey) : "";
      const message = String(fd.get("message") || "").trim();
      const body = topic ? `[${topic}] ${message}` : message;

      if (button) {
        button.disabled = true;
        button.dataset.label = button.textContent;
        button.textContent = t("act.saving");
      }

      let ok = false;
      try {
        const res = await supabaseRequest("/rest/v1/panel_messages", {
          method: "POST",
          body: JSON.stringify({
            source: session?.member_id ? "member" : "contact",
            sender_id: session?.member_id || "",
            sender_name: String(fd.get("name") || session?.username || ""),
            sender_email: String(fd.get("email") || session?.email || ""),
            body,
          }),
        });
        ok = !!res?.ok;
      } catch {
        ok = false;
      }

      if (button) {
        button.disabled = false;
        button.textContent = button.dataset.label || t("home.form.send");
      }

      if (ok) {
        form.reset();
        prefillForm(form);
        toast(t(SENT_KEY));
      } else {
        toast(t(FAIL_KEY));
      }
    });
  }

  /* ── FAQ: open the entry named in the URL (#faq-3) ─────────────── */
  function openFaqFromHash() {
    const id = (location.hash || "").replace("#", "");
    if (!id) return;
    const item = document.getElementById(id);
    if (item && item.tagName === "DETAILS") item.open = true;
  }

  function refresh() {
    buildToc();
    renderUpdated();
    translateDom(document);
  }

  function init() {
    setupChrome();
    renderUpdated();
    buildToc();
    bindTop();
    bindContactForm();
    openFaqFromHash();

    let ticking = false;
    window.addEventListener(
      "scroll",
      () => {
        if (ticking) return;
        ticking = true;
        window.requestAnimationFrame(() => {
          spy();
          ticking = false;
        });
      },
      { passive: true }
    );

    // A language switch rebuilds the TOC labels and the formatted date. Both events
    // are dispatched after the new dictionary is in place, so this can run at once.
    document.addEventListener("cineaura:lang", refresh);
    document.addEventListener("cineaura:prefs", renderUpdated);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
