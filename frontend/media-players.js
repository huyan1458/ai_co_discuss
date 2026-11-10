/**
 * Registers the Video.js 10 (Apache-2.0) video and audio players once, when the workspace loads: the file preview
 * (MediaViewer.vue) and message attachments (web/app.js `attachment_markup`) both use them.
 *
 * The players fall back to the default locale without an i18n provider, so giving the default locale the Chinese pack
 * shows Chinese everywhere; the provider would instead bundle all of its 50-odd lazily loaded packs into this
 * single-file build (see `videojs_single_locale` in vite.config.mjs). This must run at module load, not in a
 * component's setup, or players shown before any preview opens would stay in English.
 */
import { DEFAULT_LOCALE, registerI18n } from "@videojs/core/i18n";
import zh_cn from "@videojs/html/i18n/locales/zh-CN";
import "@videojs/html/video/player";
import "@videojs/html/video/skin";
import "@videojs/html/audio/player";
import "@videojs/html/audio/skin";

registerI18n(DEFAULT_LOCALE, zh_cn);
