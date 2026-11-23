/**
 * Registers the Video.js 10 (Apache-2.0) video and audio players once, when the workspace loads: the file preview
 * (MediaViewer.vue) and message attachments (web/app.js `attachment_markup`) both use them.
 *
 * The players fall back to the default locale without an i18n provider. Register the Chinese pack only for a Chinese
 * interface; otherwise keep the built-in English. The provider would bundle all of its 50-odd lazily loaded packs into this
 * single-file build (see `videojs_single_locale` in vite.config.mjs). This must run at module load, not in a
 * component's setup, or players shown before any preview opens would stay in English.
 */
import { DEFAULT_LOCALE, registerI18n } from "@videojs/core/i18n";
import zh_cn from "@videojs/html/i18n/locales/zh-CN";
import { locale } from "./i18n.js";
import "@videojs/html/video/player";
import "@videojs/html/video/skin";
import "@videojs/html/audio/player";
import "@videojs/html/audio/skin";

// The audio skin draws its loading spinner on a translucent layer over the play button, so the pause icon shows through
// the spinner. The skin lives in a shadow root that page styles cannot reach, so the rule joins the skin's own stylesheet.
const AUDIO_BUFFERING_RULE = ".audio-play-button:has(.audio-play-button-buffering-indicator[data-visible]) .media-button-icon { opacity: 0; }";
// A video in a message shows its controls only while the pointer is over it or focus is inside, even when paused, so a
// paused attachment does not cover the picture. Touch screens have no hover and keep the skin's own behaviour; the file
// preview keeps its controls too.
const ATTACHMENT_VIDEO_CONTROLS_RULE = "@media (hover: hover) { :host(.attachment-player:not(:hover):not(:focus-within)) :is(.video-controls-primary, .video-controls-secondary, .video-controls-backdrop) { opacity: 0; pointer-events: none; } }";

if (locale === "zh-CN") registerI18n(DEFAULT_LOCALE, zh_cn);
const audio_skin_styles = customElements.get("audio-skin")?.styles;
audio_skin_styles?.insertRule?.(AUDIO_BUFFERING_RULE, audio_skin_styles.cssRules.length);
const video_skin_styles = customElements.get("video-skin")?.styles;
video_skin_styles?.insertRule?.(ATTACHMENT_VIDEO_CONTROLS_RULE, video_skin_styles.cssRules.length);
