import { HTML_SANDBOX, html_document } from "./file-preview.js";

export const INLINE_VISUAL_SANDBOX = "allow-scripts";
// On the share site a page's frames inherit its policy, under which no script of an attachment runs. There an HTML
// attachment goes into /frame instead: the share site's own page, served sandboxed to an opaque origin with scripts
// allowed, which writes the document it is sent. The local site and a downloaded share page keep srcdoc.
export const RELAY_FRAME = typeof window !== "undefined" && window.CODISCUSS_SHARE && /^https?:$/.test(location.protocol) ? "/frame" : "";
const relayed = new WeakMap();

/**
 * Call on a frame's load. A relay frame first loads empty: it is sent `html` and loads again with it. Returns true once
 * the frame shows the document itself.
 */
export function relay_frame_loaded(frame, html) {
  if (!RELAY_FRAME || !frame || relayed.get(frame) === html) return true;
  relayed.set(frame, html);
  frame.contentWindow?.postMessage({ codiscuss_frame: html }, "*");
  return false;
}
const inline_visual_heights = new Map();
const DEFAULT_VISUAL_HEIGHT = 220;
// Load a visual this far before it scrolls into view, so it is already drawn when it appears.
const VISUAL_PRELOAD_MARGIN = "800px 0px";
const COLLAPSED_PREFIX = "ai-codiscuss-visual-collapsed:";
const visual_bodies = new WeakMap();

/** Whether a file is eligible for the HTML preview in a message. */
export function is_inline_html(file) { return /\.html$/i.test(file.file_name); }

/** Move each visible HTML reference into the answer once, leaving other attachments in their usual list. */
export function inline_visual_body(html, attachments) {
  const cached = visual_bodies.get(attachments);
  if (cached?.source === html) return cached;
  const available = new Map(attachments.filter(is_inline_html).map((file) => [file.id, file]));
  const files = [];
  const markup = html.replace(/<(pre|code|a)\b[^>]*>[\s\S]*?<\/\1>|<button type="button" class="attachment-placeholder" data-inline-visual data-preview-attachment="([^"]+)"[^>]*>[^<]*<\/button>/g,
    (original, ignored, id) => {
      const file = available.get(id);
      if (!file) return original;
      files.push(file);
      available.delete(id);
      return `<span class="channel-visual-slot" data-visual-slot="${id}"></span>`;
    });
  const ids = new Set(files.map((file) => file.id));
  const result = { source: html, markup, files, remaining: attachments.filter((file) => !ids.has(file.id)) };
  visual_bodies.set(attachments, result);
  return result;
}

/** Read or write a reader's collapsed preference for this room and attachment. */
export function inline_visual_collapsed(file, collapsed) {
  const key = COLLAPSED_PREFIX + file.room_id + ":" + file.id;
  try {
    if (collapsed === true) localStorage.setItem(key, "1");
    if (collapsed === false) localStorage.removeItem(key);
    return localStorage.getItem(key) === "1";
  } catch { return false; }
}

/** Accept geometry only from the current sandbox window, with a finite positive CSS-pixel height. */
export function inline_visual_height(event, frame_window) {
  if (!frame_window || event.source !== frame_window) return null;
  const height = event.data?.codiscuss_visual_height;
  return Number.isFinite(height) && height > 0 ? Math.ceil(height) : null;
}

/** Recover the last content height before a preview approaches the viewport. */
export function remembered_visual_height(file) {
  return inline_visual_heights.get(file.id) ?? DEFAULT_VISUAL_HEIGHT;
}

/** Remember measured geometry for later mounts of the same attachment. */
export function remember_visual_height(file, height) {
  inline_visual_heights.set(file.id, height);
}

const visual_visibility_callbacks = new WeakMap();
let visibility_observer;

/** Observe previews with one observer, including clipping by the transcript's scrollport. */
export function observe_inline_visual(element, callback) {
  visibility_observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) visual_visibility_callbacks.get(entry.target)?.(entry.isIntersecting && entry.intersectionRect.height > 0);
  }, { rootMargin: VISUAL_PRELOAD_MARGIN });
  visual_visibility_callbacks.set(element, callback);
  visibility_observer.observe(element);
  return () => {
    visibility_observer.unobserve(element);
    visual_visibility_callbacks.delete(element);
  };
}

/** Read theme values from the rendered room and the answer that contains the visual. */
export function inline_visual_theme(element) {
  const owner = element.ownerDocument;
  const card = element.closest(".channel-message");
  const text = card?.querySelector(".channel-message-text") || owner.querySelector(".channel-answer .channel-message-text") || element;
  const style = owner.defaultView.getComputedStyle(text);
  return {
    "--codiscuss-color-scheme": style.colorScheme === "light" ? "light" : "dark",
    "--codiscuss-text": style.color,
    "--codiscuss-text-muted": style.getPropertyValue("--ui-text-muted").trim(),
    "--codiscuss-text-hint": style.getPropertyValue("--ui-text-dimmed").trim(),
    "--codiscuss-border": style.getPropertyValue("--ui-border").trim(),
    "--codiscuss-accent": style.getPropertyValue("--ui-primary").trim(),
    "--codiscuss-card": style.getPropertyValue("--ui-bg-elevated").trim(),
    "--codiscuss-font-family": style.fontFamily,
    "--codiscuss-font-size": style.fontSize,
    "--codiscuss-radius": style.getPropertyValue("--ui-radius").trim(),
  };
}

/** Watch the room settings that change the visuals' theme and text size. */
export function observe_visual_theme(refresh, root = document.documentElement) {
  const observer = new MutationObserver(refresh);
  observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "data-card-text"] });
  return () => observer.disconnect();
}

/** Send the room theme to an opaque-origin preview without reloading it. */
export function send_visual_theme(frame_window, theme) {
  frame_window?.postMessage({ codiscuss_visual_theme: theme }, "*");
}

const VISUAL_DEFAULTS = `<style>
  html, body { background: transparent !important; margin: 0 !important; }
  :root, body { color-scheme: var(--codiscuss-color-scheme, normal) !important; }
  body { color: var(--codiscuss-text, CanvasText) !important; font-family: var(--codiscuss-font-family, system-ui) !important; font-size: var(--codiscuss-font-size, 14px) !important; }
  :where(button, select, input) { font: inherit; color: inherit; box-sizing: border-box; }
  :where(button, select, input:not([type="range"], [type="checkbox"], [type="radio"], [type="color"])) {
    border: 1px solid var(--codiscuss-border, GrayText); border-radius: var(--codiscuss-radius, 6px);
    background: var(--codiscuss-card, Canvas); padding: .3em .6em;
  }
  :where(input[type="range"], input[type="checkbox"], input[type="radio"]) { accent-color: var(--codiscuss-accent, Highlight); }
  :where(button, select, input):focus-visible { outline: 2px solid var(--codiscuss-accent, Highlight); outline-offset: 2px; }
  :where(button, select, input[type="range"]) { cursor: pointer; }
  :where(button, select, input):disabled { cursor: not-allowed; opacity: .6; }
</style>`;
const VISUAL_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob: data:; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; media-src data: blob:; base-uri 'none'; form-action 'none'">`;

/** Runs inside the sandbox. Reports body height independently of the frame's current height. */
function start_visual_frame(measure) {
  const root = document.documentElement;
  let scheduled = false;
  let last_height = 0;
  function request_height() {
    if (!measure || scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (!document.body) return;
      const height = Math.max(1, Math.ceil(document.body.getBoundingClientRect().height), document.body.scrollHeight);
      if (height === last_height) return;
      last_height = height;
      parent.postMessage({ codiscuss_visual_height: height }, "*");
    });
  }
  addEventListener("message", (event) => {
    if (event.source !== parent || !event.data?.codiscuss_visual_theme) return;
    for (const [key, value] of Object.entries(event.data.codiscuss_visual_theme)) {
      if (key.startsWith("--codiscuss-") && typeof value === "string") root.style.setProperty(key, value);
    }
    request_height();
  });
  if (measure) {
    addEventListener("DOMContentLoaded", () => {
      new ResizeObserver(request_height).observe(document.body);
      request_height();
    }, { once: true });
    addEventListener("resize", request_height);
  }
}

/** Wrap a self-contained visual with the room's defaults and its isolated height bridge. */
export function inline_visual_document(source, automatic, { extra = "", measure = true } = {}) {
  const startup = `<script>(${start_visual_frame.toString()})(${measure});</script>`;
  return html_document(source, (automatic ? VISUAL_CSP : "") + VISUAL_DEFAULTS + startup + extra);
}

/** Run in the trusted new-tab wrapper. The attachment stays in its own sandbox. */
export function start_visual_tab(initial, read_theme, observe_theme, send_theme, view = window) {
  const { document } = view;
  const frame = document.querySelector("iframe");
  const root = document.documentElement;
  let theme = initial;
  let source;
  try { source = view.opener?.document.documentElement; } catch { /* Keep the last theme if the opener is unavailable. */ }

  function refresh() {
    if (source?.isConnected && source.ownerDocument.defaultView) theme = read_theme(source);
    root.style.colorScheme = theme["--codiscuss-color-scheme"];
    root.style.backgroundColor = theme["--codiscuss-card"];
    send_theme(frame.contentWindow, theme);
  }

  frame.addEventListener("load", refresh);
  if (source) view.addEventListener("pagehide", observe_theme(refresh, source), { once: true });
  refresh();
}

/** Build a new-tab wrapper for a file, with live room theming for HTML attachments. */
export function visual_tab_document(title, source, theme) {
  const attribute = (value) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const preview = theme ? inline_visual_document(source, false, { measure: false }) : html_document(source);
  const shell = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${attribute(title)}</title>`
    + `<style>html,body{margin:0;height:100%}iframe{display:block;width:100%;height:100%;border:0}</style>`
    + `<iframe sandbox="${HTML_SANDBOX}" referrerpolicy="no-referrer" srcdoc="${attribute(preview)}"></iframe>`;
  if (!theme) return shell;
  const initial = JSON.stringify(theme).replace(/</g, "\\u003c");
  return shell + `<script>(${start_visual_tab.toString()})(${initial},${inline_visual_theme.toString()},${observe_visual_theme.toString()},${send_visual_theme.toString()});</script>`;
}
