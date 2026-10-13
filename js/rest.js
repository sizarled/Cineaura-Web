(() => {
  const {
    $,
    setupChrome,
    setSession,
    toast,
    sha256,
    supabaseRequest,
    tmdb,
    imgUrl,
    escapeHtml,
    downloadAccountTxt,
    restValue,
    t,
  } = window.CineAura;

  const TABLES = ["members", "Members"];
  let recovered = null;

  function cleanCode(value) {
    return String(value || "").replace(/[\s\-]/g, "").replace(/[^A-Za-z0-9]/g, "").slice(0, 16);
  }

  function showAlert(id, type, html) {
    const el = $(id);
    el.className = `form-alert show ${type}`;
    el.innerHTML = html;
  }

  async function findByRecovery(code) {
    const compact = cleanCode(code);
    const variants = [...new Set([compact, compact.toUpperCase(), compact.toLowerCase()])];
    let tableMissing = false;

    for (const table of TABLES) {
      for (const variant of variants) {
        const queries = [
          `/rest/v1/${table}?recovery_code=eq.${restValue(variant)}&select=member_id,full_name,username,email,status,country,birth_date,recovery_code,created_at`,
          `/rest/v1/${table}?recovery_code=ilike.${restValue(variant)}&select=member_id,full_name,username,email,status,country,birth_date,recovery_code,created_at`,
        ];
        for (const path of queries) {
          const res = await supabaseRequest(path);
          if (res.status === 404 && res.data?.code === "PGRST205") {
            tableMissing = true;
            break;
          }
          if (res.ok && Array.isArray(res.data) && res.data.length) {
            return { row: res.data[0], table, tableMissing: false };
          }
        }
      }
    }
    return { row: null, table: "members", tableMissing };
  }

  async function savePassword(table, code, hashed) {
    const rpc = await supabaseRequest("/rest/v1/rpc/reset_password_with_recovery", {
      method: "POST",
      body: JSON.stringify({ p_recovery_code: code, p_password: hashed }),
    });
    if (rpc.ok && rpc.data && rpc.data.ok) return rpc.data;

    const patch = await supabaseRequest(
      `/rest/v1/${table}?recovery_code=eq.${restValue(cleanCode(code))}`,
      {
        method: "PATCH",
        body: JSON.stringify({ password: hashed }),
      }
    );
    if (patch.ok) return { ok: true };
    if (patch.data?.code === "PGRST205") return { ok: false, reason: "setup" };
    return { ok: false, reason: "error" };
  }

  async function onCode(event) {
    event.preventDefault();
    const code = cleanCode($("#recovery-input").value);
    if (code.length !== 16) {
      showAlert("#code-alert", "error", t("rest.need16"));
      return;
    }
    const btn = $("#code-btn");
    btn.disabled = true;
    btn.textContent = t("rest.checking");
    try {
      const found = await findByRecovery(code);
      if (found.tableMissing) {
        showAlert("#code-alert", "warn", t("rest.table"));
        return;
      }
      if (!found.row) {
        showAlert("#code-alert", "error", t("rest.badCode"));
        return;
      }
      recovered = { ...found.row, table: found.table, recovery_code: found.row.recovery_code || code };
      $("#code-form").hidden = true;
      $("#password-form").hidden = false;
      toast(t("rest.codeOk"));
    } catch (error) {
      console.error(error);
      showAlert("#code-alert", "error", t("rest.verifyFail"));
    } finally {
      btn.disabled = false;
      btn.textContent = t("rest.continue");
    }
  }

  async function onPassword(event) {
    event.preventDefault();
    const password = $("#new-password").value;
    const confirm = $("#confirm-password").value;
    if (password.length < 8) {
      showAlert("#password-alert", "error", t("rest.pass8"));
      return;
    }
    if (password !== confirm) {
      showAlert("#password-alert", "error", t("rest.mismatch"));
      return;
    }
    const btn = $("#save-btn");
    btn.disabled = true;
    btn.textContent = t("rest.saving");
    try {
      const hashed = await sha256(password);
      const result = await savePassword(recovered.table, recovered.recovery_code, hashed);
      if (!result.ok) {
        showAlert("#password-alert", "error", result.reason === "setup"
          ? t("rest.table")
          : t("rest.saveFail"));
        return;
      }
      setSession(recovered, true);
      $("#password-form").hidden = true;
      $("#success-card").hidden = false;
      $("#success-meta").innerHTML = `
        <div>${t("common.memberId")} <strong>${escapeHtml(recovered.member_id)}</strong></div>
        <div>${t("reg.username")} <strong>${escapeHtml(recovered.username)}</strong></div>
        <div>${t("common.email")} <strong>${escapeHtml(recovered.email)}</strong></div>
      `;
      toast(t("rest.ok"));
    } catch (error) {
      console.error(error);
      showAlert("#password-alert", "error", t("rest.saveFail"));
    } finally {
      btn.disabled = false;
      btn.textContent = t("rest.savePass");
    }
  }

  async function setVisual() {
    try {
      const data = await tmdb("/trending/movie/week");
      const hit = (data.results || []).find((x) => x.backdrop_path);
      if (!hit) return;
      $("#auth-visual").style.backgroundImage =
        `linear-gradient(180deg, rgba(7,15,24,.18), rgba(7,15,24,.78)), url('${imgUrl(hit.backdrop_path, "w1280")}')`;
    } catch {
      /* keep fallback */
    }
  }

  function init() {
    setupChrome();
    const codeForm = $("#code-form");
    const passwordForm = $("#password-form");
    const recoveryInput = $("#recovery-input");
    if (!codeForm || !recoveryInput) return;
    recoveryInput.addEventListener("input", (e) => {
      e.target.value = cleanCode(e.target.value);
    });
    $("#toggle-password")?.addEventListener("click", () => {
      const input = $("#new-password");
      if (input) input.type = input.type === "password" ? "text" : "password";
    });
    codeForm.addEventListener("submit", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onCode(event);
    });
    passwordForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onPassword(event);
    });
    $("#download-txt").addEventListener("click", () => {
      if (recovered) downloadAccountTxt(recovered);
    });
    setVisual();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
