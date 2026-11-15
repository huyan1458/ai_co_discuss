/** Interface language for human-facing CLI commands; no model prompts or protocol values are translated here. */
import english from './i18n_en.mjs';

const SYSTEM_LOCALE = Intl.DateTimeFormat().resolvedOptions().locale;

/**
 * Resolve the CLI language: a supported CODISCUSS_LANG override, then the system locale.
 * @param {object} environment Environment variables to inspect.
 * @param {string} system_locale System locale used when no supported override is set.
 * @returns {'zh-CN'|'en'} The interface language.
 */
export function resolve_locale(environment = process.env, system_locale = SYSTEM_LOCALE) {
  if (['zh-CN', 'en'].includes(environment.CODISCUSS_LANG)) return environment.CODISCUSS_LANG;
  return /^zh/i.test(system_locale) ? 'zh-CN' : 'en';
}

/**
 * Translate a Chinese source literal, substituting named parameters in either language.
 * @param {string} source Chinese source text, also the dictionary key.
 * @param {object} [params] Values for {name} placeholders.
 * @returns {string} The translated text, falling back to the source when a key is missing.
 */
export function t(source, params) {
  const text = (resolve_locale() === 'en' && english[source]) || source;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match);
}
