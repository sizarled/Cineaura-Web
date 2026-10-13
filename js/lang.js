/* CineAura language packs.
 *
 * Every language is a JavaScript file, lang/<language>.js, that registers a map:
 *
 *     (window.CineAuraPacks = window.CineAuraPacks || {}).ar = { "Free": "مجاني", ... };
 *
 * English is the default language and the key of every entry, so the same map
 * translates the page markup and any text that comes from Supabase (statuses,
 * membership types, roles, report reasons, IPTV types, …).
 *
 *   window.CineAuraLang.text("Free")      → "مجاني"   (current language)
 *   window.CineAuraLang.text("active")    → "مفعّل"   (case-insensitive)
 *   window.CineAuraLang.load("fr")        → switch the dictionary
 *
 * js/i18n.js keeps the list of interface keys (key → English) and js/lang.js
 * fills CineAuraI18n[language] from the language file, so every existing
 * CineAura.t("nav.search") call keeps working.
 */
(() => {
  const DIR = "lang";
  const FILES = {
    en: "english",
    ar: "arabic",
    fr: "french",
    de: "german",
    es: "spanish",
    nl: "dutch",
    it: "italian",
  };
  const LANGS = window.CineAuraLangs || Object.keys(FILES);
  const ENTITIES = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
  };

  const state = {
    code: "en",
    map: {},
    index: {},
    packs: {},   // language -> parsed map (kept for the whole session)
    pending: {}, // language -> in-flight promise
    want: "en",  // language the page asked for last
  };

  function store(action, key, value) {
    try {
      return action === "get" ? localStorage.getItem(key) : localStorage.setItem(key, value);
    } catch {
      return null;
    }
  }

  function currentLang() {
    const stored = store("get", "cineaura_lang");
    const html = document.documentElement?.lang;
    const match = [html, stored, "en"].find((code) => code && LANGS.includes(code));
    return match || "en";
  }

  function decodeEntities(value) {
    return String(value).replace(/&[a-z#0-9]+;/gi, (m) => (m in ENTITIES ? ENTITIES[m] : m));
  }

  function buildIndex(map) {
    const index = {};
    Object.keys(map).forEach((key) => {
      index[key.trim().toLowerCase()] = map[key];
    });
    return index;
  }

  /* Translate one text: exact match, then entity-decoded, then trimmed / case-insensitive. */
  function lookup(map, index, value) {
    const raw = value == null ? "" : String(value);
    if (!raw) return raw;
    if (map[raw]) return map[raw];
    const decoded = decodeEntities(raw);
    if (map[decoded]) return map[decoded];
    const hit = index[decoded.trim().toLowerCase()];
    return hit || raw;
  }

  function text(value) {
    return lookup(state.map, state.index, value);
  }

  /* Re-run the markup translation and let the page re-render dynamic content. */
  function retranslate() {
    if (typeof window.CineAura?.translateDom === "function") window.CineAura.translateDom(document);
    else {
      document.querySelectorAll("[data-i18n]").forEach((el) => {
        const key = el.getAttribute("data-i18n");
        const value = window.CineAuraI18n?.[state.code]?.[key];
        if (!value) return;
        const attr = el.getAttribute("data-i18n-attr");
        if (attr) el.setAttribute(attr, value);
        else el.textContent = value;
      });
      document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
        const value = window.CineAuraI18n?.[state.code]?.[el.getAttribute("data-i18n-placeholder")];
        if (value) el.placeholder = value;
      });
      document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
        const value = window.CineAuraI18n?.[state.code]?.[el.getAttribute("data-i18n-aria")];
        if (value) el.setAttribute("aria-label", value);
      });
    }
    document.dispatchEvent(new CustomEvent("cineaura:lang", { detail: { language: state.code } }));
    document.dispatchEvent(new CustomEvent("cineaura:prefs", { detail: { language: state.code } }));
  }

  function apply(code, map) {
    state.packs[code] = map;
    // key → English index (js/i18n.js) filled with the translations of this language
    const keys = window.CineAuraKeys || {};
    const index = buildIndex(map);
    const pack = (window.CineAuraI18n = window.CineAuraI18n || {});
    const table = {};
    Object.keys(keys).forEach((key) => {
      table[key] = lookup(map, index, keys[key]);
    });
    pack[code] = table;
    if (code !== state.want) return;
    state.code = code;
    state.map = map;
    state.index = index;
    if (document.body) retranslate();
  }

  function readPack(lang) {
    const pack = window.CineAuraPacks && window.CineAuraPacks[lang];
    return pack && typeof pack === "object" ? pack : null;
  }

  /* Inject lang/<language>.js; the file registers itself in window.CineAuraPacks. */
  function inject(lang) {
    const file = FILES[lang] || lang;
    return new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = `${DIR}/${file}.js?v=${Date.now()}`;
      el.async = true;
      el.onload = () => (readPack(lang) ? resolve(readPack(lang)) : reject(new Error("empty pack")));
      el.onerror = () => reject(new Error(`${DIR}/${file}.js not found`));
      (document.head || document.documentElement).appendChild(el);
    });
  }

  function load(code) {
    const lang = LANGS.includes(code) ? code : "en";
    state.want = lang;
    if (state.packs[lang]) {
      apply(lang, state.packs[lang]);
      return Promise.resolve(state.packs[lang]);
    }
    const ready = lang === "en" ? {} : readPack(lang); // already loaded by prefs.js or an earlier switch
    if (ready) {
      apply(lang, ready);
      return Promise.resolve(ready);
    }
    if (state.pending[lang]) return state.pending[lang];
    state.pending[lang] = inject(lang)
      .then((map) => {
        apply(lang, map);
        return map;
      })
      .catch((err) => {
        console.warn(`[CineAura] language pack "${lang}" could not be loaded — keeping English.`, err);
        return {};
      })
      .finally(() => {
        delete state.pending[lang];
      });
    return state.pending[lang];
  }

  window.CineAuraLang = {
    dir: DIR,
    files: FILES,
    langs: LANGS,
    load,
    text,
    get code() {
      return state.code;
    },
    get map() {
      return state.map;
    },
  };
  // Short helper for text coming from Supabase or from any English string.
  window.CineAuraText = (value) => text(value);

  let booted = false;
  function boot() {
    state.code = currentLang();
    load(state.code);
    if (booted) return;
    booted = true;
    document.addEventListener("cineaura:prefs", (e) => {
      const lang = e?.detail?.language;
      if (lang && lang !== state.code) load(lang);
    });
  }

  if (document.readyState === "loading") {
    boot(); // the pack is already loaded by prefs.js, so the markup translates at once
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
