(() => {
  try {
    const langs = ["en", "ar", "fr", "de", "es", "nl", "it"];
    const html = document.documentElement;
    let theme = localStorage.getItem("cineaura_theme");
    if (theme !== "day" && theme !== "night") theme = "night";
    // A language is stored only when the visitor picks one (header menu / settings).
    // Until then the page follows the browser's language list, first supported match.
    let lang = localStorage.getItem("cineaura_lang");
    // Country → language, used for the IP-based default (the country comes from the cached
    // lookup that common.js makes; a language picked by the visitor always wins).
    const byCountry = {};
    const put = (l, list) => list.split(" ").forEach((c) => (byCountry[c] = l));
    put("ar", "MA DZ TN LY EG SA AE QA KW BH OM JO LB SY IQ YE SD PS MR DJ SO KM");
    put("fr", "FR BE LU MC SN CI CM CD CG GA MG ML BF NE TG BJ GN HT");
    put("de", "DE AT CH LI");
    put("es", "ES MX AR CO CL PE VE EC GT CU BO DO HN PY SV NI CR PA UY PR GQ");
    put("nl", "NL SR");
    put("it", "IT SM VA");
    put("en", "US GB IE AU NZ CA ZA IN SG PH NG KE GH");
    window.CineAuraCountryLang = byCountry;
    if (!langs.includes(lang)) {
      try {
        const geo = JSON.parse(localStorage.getItem("cineaura_geo") || "null");
        const cc = geo && geo.cc;
        if (cc && langs.includes(byCountry[cc])) lang = byCountry[cc];
      } catch {
        /* no cached lookup yet */
      }
    }
    if (!langs.includes(lang)) {
      lang = "en";
      const list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || "en"];
      for (const raw of list) {
        const code = String(raw || "").toLowerCase().split("-")[0];
        if (langs.includes(code)) {
          lang = code;
          break;
        }
      }
    }
    if (!localStorage.getItem("cineaura_theme")) localStorage.setItem("cineaura_theme", theme);
    html.dataset.theme = theme;
    html.lang = lang;
    html.dir = lang === "ar" ? "rtl" : "ltr";
    // Load the language pack (lang/<language>.js) before the page scripts run.
    const files = { ar: "arabic", fr: "french", de: "german", es: "spanish", nl: "dutch", it: "italian" };
    if (files[lang] && document.readyState === "loading") {
      document.write('<script src="lang/' + files[lang] + '.js"><\/script>');
    }
  } catch {
    /* keep markup defaults */
  }
})();
