/**
 * Interface language for the Vue bundles. The dictionaries ship once in web/i18n.js (built from i18n-runtime.js),
 * which every page loads before its own scripts; this module only forwards to it.
 */
const runtime = globalThis.codiscuss_i18n;

/** Page language code, `zh-CN` or `en`. */
export const locale = runtime?.locale || "zh-CN";

/** Supported languages as `{ code, label }`, for the language picker. */
export const locales = runtime?.locales || [{ code: "zh-CN", label: "中文" }];

/**
 * Translate one interface string; see i18n-runtime.js.
 *
 * @param {string} source Chinese source text, also the dictionary key; `{name}` marks a parameter.
 * @param {Object} [params] Values for the `{name}` placeholders.
 * @returns {string} The text in the page language.
 */
export function t(source, params) {
  if (runtime) return runtime.t(source, params);
  if (!params) return source;
  return source.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

/** Switch the page language (reloads the page). */
export function set_locale(code) {
  runtime?.set_locale(code);
}

/** Vue plugin: makes `t()` callable in every template. */
export const i18n_plugin = { install(app) { app.config.globalProperties.t = t; } };
