/**
 * Interface language runtime, built as the classic script web/i18n.js so web/app.js, the workspace and the admin
 * panel share one copy. Chinese source text is the key: `t("刷新")` returns the English entry when the page language
 * is English, and the Chinese text itself when the entry is missing, so an untranslated string never breaks the page.
 * Dictionaries live in frontend/locales/<language>/*.json, one file per area so several people can translate at once.
 */
const STORAGE_KEY = "codiscuss.locale";
const SOURCE_LOCALE = "zh-CN";
const SUPPORTED_LOCALES = [
  { code: "zh-CN", label: "中文" },
  { code: "en", label: "English" },
];

const english_files = import.meta.glob("./locales/en/*.json", { eager: true, import: "default" });
const DICTIONARIES = { en: Object.assign({}, ...Object.values(english_files)) };

/** The saved choice, else Chinese for Chinese browsers and English for everyone else. */
function detect_locale() {
  let saved = "";
  try { saved = localStorage.getItem(STORAGE_KEY) || ""; } catch { /* storage blocked: fall back to the browser */ }
  if (SUPPORTED_LOCALES.some((item) => item.code === saved)) return saved;
  const preferred = (navigator.languages && navigator.languages[0]) || navigator.language || "";
  return /^zh\b/i.test(preferred) ? SOURCE_LOCALE : "en";
}

export const locale = detect_locale();
const dictionary = DICTIONARIES[locale] || {};

/**
 * Translate one interface string.
 *
 * @param {string} source Chinese source text, also the dictionary key; `{name}` marks a parameter.
 * @param {Object} [params] Values for the `{name}` placeholders.
 * @returns {string} The text in the page language.
 */
export function t(source, params) {
  const text = dictionary[source] || source;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

/** Save the choice and reload, so every part of the page renders in the new language at once. */
export function set_locale(code) {
  if (!SUPPORTED_LOCALES.some((item) => item.code === code) || code === locale) return;
  try { localStorage.setItem(STORAGE_KEY, code); } catch { /* storage blocked: the choice lasts this page only */ }
  location.reload();
}

export const locales = SUPPORTED_LOCALES;

if (typeof document !== "undefined") document.documentElement.lang = locale;

// The address fragment as the page loaded, before web/app.js rewrites the address when it opens a room: an invitation
// handed over as #join=… is read from here by the workspace (external-members.js take_join_fragment). Only a join
// fragment is kept, and the workspace deletes it once read.
if (typeof location !== "undefined" && /(?:^#|&)join=/.test(location.hash || "")) globalThis.codiscuss_initial_hash = location.hash;
