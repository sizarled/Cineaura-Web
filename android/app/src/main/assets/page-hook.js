/*
 * CineAura Android app — script injected into the top page after each load.
 *
 * 1. Ad-free state: keeps window.__cineauraAdState in step with the member's plan and
 *    the "Watch without ads" switch of the site ("on" / "off" / "unknown"). The native
 *    side reads it to decide whether the built-in ad blocker and the pop-up blocker run.
 * 2. Downloads: the site saves files (IPTV playlist, account file) through blob: links.
 *    WebView cannot save those itself, so the file is handed to the native side.
 *    The token is replaced by the app at injection time; ad frames cannot read it.
 */
(function () {
  "use strict";
  if (window.__cineauraAppHook) {
    return;
  }
  window.__cineauraAppHook = true;
  var TOKEN = "__APP_TOKEN__";
  window.__cineauraAdState = "unknown";

  var busy = false;
  function check() {
    var site = window.CineAura;
    if (busy || !site || typeof site.adFreeActive !== "function") {
      return;
    }
    busy = true;
    Promise.resolve()
      .then(function () {
        return site.adFreeActive();
      })
      .then(function (on) {
        window.__cineauraAdState = on === true ? "on" : "off";
      })
      .catch(function () {
        window.__cineauraAdState = "off";
      })
      .then(function () {
        busy = false;
      });
  }

  document.addEventListener("cineaura:adfree", check);
  check();
  setInterval(check, 4000);

  document.addEventListener(
    "click",
    function (e) {
      var target = e.target;
      var link = target && target.closest ? target.closest("a[download]") : null;
      if (!link || !window.CineAuraNative) {
        return;
      }
      var href = link.getAttribute("href") || "";
      if (href.indexOf("blob:") !== 0) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      var name = link.getAttribute("download") || "download.txt";
      fetch(href)
        .then(function (r) {
          return r.blob();
        })
        .then(function (blob) {
          var reader = new FileReader();
          reader.onload = function () {
            var s = String(reader.result || "");
            window.CineAuraNative.saveFile(
              TOKEN,
              name,
              blob.type || "application/octet-stream",
              s.slice(s.indexOf(",") + 1)
            );
          };
          reader.readAsDataURL(blob);
        })
        .catch(function () {});
    },
    true
  );
})();
