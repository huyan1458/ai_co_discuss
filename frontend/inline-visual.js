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
const COLLAPSED_PREFIX = "ai-codiscuss-visual-collapsed:";
/** Read or write a reader's collapsed preference for a visual in a message. */
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

/** Remember measured geometry for later mounts of the same visual. */
export function remember_visual_height(file, height) {
  inline_visual_heights.set(file.id, height);
}

const visual_visibility_callbacks = new WeakMap();
let visibility_observer;

/** Observe previews with one observer, including clipping by the transcript's scrollport. */
export function observe_inline_visual(element, callback) {
  visibility_observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) visual_visibility_callbacks.get(entry.target)?.(entry.isIntersecting && entry.intersectionRect.height > 0);
  });
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

// The room's base look plus a small opt-in kit (`cd-*` classes, documented in the participant skill), so every visual
// shares the site's restrained controls in both themes instead of each one drawing its own. Selectors sit in :where()
// so a page's own rules still win.
const VISUAL_DEFAULTS = `<style>
  html, body { background: transparent !important; margin: 0 !important; }
  :where(body) { display: flow-root; line-height: 1.6; }
  :root, body { color-scheme: var(--codiscuss-color-scheme, normal) !important; }
  body { color: var(--codiscuss-text, CanvasText) !important; font-family: var(--codiscuss-font-family, system-ui) !important; font-size: var(--codiscuss-font-size, 14px) !important; -webkit-font-smoothing: antialiased; }
  :root { --cd-tint: color-mix(in srgb, var(--codiscuss-text, CanvasText) 6%, transparent); --cd-tint-strong: color-mix(in srgb, var(--codiscuss-text, CanvasText) 11%, transparent);
    --cd-rule: color-mix(in srgb, var(--codiscuss-border, GrayText) 70%, transparent); }
  :where(*, *::before, *::after) { box-sizing: border-box; }
  :where(button, select, input, textarea) { font: inherit; color: inherit; }
  /* Controls sit one step below the text size, as the room's own buttons do, and never under a 32px touch height. */
  :where(button, select, textarea, input:not([type="range"], [type="checkbox"], [type="radio"], [type="color"])) {
    min-height: 32px; border: 1px solid var(--codiscuss-border, GrayText); border-radius: var(--codiscuss-radius, 6px);
    background-color: transparent; padding: .3em .8em; font-size: .875em; line-height: 1.4; transition: border-color .12s, background-color .12s;
  }
  :where(button) { display: inline-flex; align-items: center; justify-content: center; gap: .4em; background-color: var(--cd-tint); font-weight: 500; white-space: nowrap; }
  :where(button:hover:not(:disabled)) { background-color: var(--cd-tint-strong); }
  :where(button:active:not(:disabled)) { background-color: var(--cd-tint); }
  :where(select, textarea, input):hover:not(:disabled) { border-color: var(--codiscuss-text-hint, GrayText); }
  :where(textarea, input)::placeholder { color: var(--codiscuss-text-hint, GrayText); opacity: 1; }
  :where(textarea) { display: block; padding: .5em .8em; line-height: 1.5; resize: vertical; }
  :where(select) { -webkit-appearance: none; appearance: none; padding-right: 2.1em; background-repeat: no-repeat; background-size: 5px 5px;
    background-position: right calc(.8em + 5px) top 54%, right .8em top 54%;
    background-image: linear-gradient(45deg, transparent 50%, var(--codiscuss-text-muted, GrayText) 50%), linear-gradient(135deg, var(--codiscuss-text-muted, GrayText) 50%, transparent 50%); }
  :where(input[type="checkbox"], input[type="radio"]) { width: .9em; height: .9em; margin: 0; vertical-align: -.08em; accent-color: var(--codiscuss-accent, Highlight); }
  :where(button, select, input, textarea):focus-visible { outline: 2px solid color-mix(in srgb, var(--codiscuss-accent, Highlight) 70%, transparent); outline-offset: 1px; }
  :where(button, select, input[type="range"], input[type="checkbox"], input[type="radio"]) { cursor: pointer; }
  :where(button, select, input, textarea):disabled { cursor: not-allowed; opacity: .5; }
  /* --cd-fill is the slider's value as a percentage, kept current by the frame's startup script. */
  :where(input[type="range"]) { -webkit-appearance: none; appearance: none; width: 100%; height: 24px; margin: 0; background: transparent; }
  :where(input[type="range"])::-webkit-slider-runnable-track { height: 4px; border-radius: 2px;
    background: linear-gradient(to right, var(--codiscuss-accent, Highlight) var(--cd-fill, 0%), var(--cd-tint-strong) var(--cd-fill, 0%)); }
  :where(input[type="range"])::-moz-range-track { height: 4px; border-radius: 2px; background: var(--cd-tint-strong); }
  :where(input[type="range"])::-moz-range-progress { height: 4px; border-radius: 2px; background: var(--codiscuss-accent, Highlight); }
  :where(input[type="range"])::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; margin-top: -5px; border: 0; border-radius: 50%;
    background: var(--codiscuss-accent, Highlight); box-shadow: 0 0 0 0 color-mix(in srgb, var(--codiscuss-accent, Highlight) 24%, transparent); transition: box-shadow .12s; }
  :where(input[type="range"])::-moz-range-thumb { width: 14px; height: 14px; border: 0; border-radius: 50%; background: var(--codiscuss-accent, Highlight); }
  :where(input[type="range"]):focus-visible { outline: none; }
  :where(input[type="range"]):is(:hover, :active, :focus-visible)::-webkit-slider-thumb { box-shadow: 0 0 0 5px color-mix(in srgb, var(--codiscuss-accent, Highlight) 24%, transparent); }
  :where(input[type="range"]):is(:hover, :active, :focus-visible)::-moz-range-thumb { box-shadow: 0 0 0 5px color-mix(in srgb, var(--codiscuss-accent, Highlight) 24%, transparent); }
  :where(table) { width: 100%; border-collapse: collapse; font-size: .9em; font-variant-numeric: tabular-nums; }
  :where(th, td) { padding: .45em .6em; text-align: left; border-bottom: 1px solid var(--cd-rule); }
  :where(th) { font-size: .9em; font-weight: 500; color: var(--codiscuss-text-hint, GrayText); }
  :where(tr:last-child > td) { border-bottom: 0; }
  :where(svg) { max-width: 100%; }
  :where(.cd-wrap) { max-width: 640px; margin: 0 auto; }
  :where(.cd-muted) { color: var(--codiscuss-text-muted, GrayText); }
  :where(.cd-hint) { color: var(--codiscuss-text-hint, GrayText); font-size: .8em; }
  :where(.cd-accent) { color: var(--codiscuss-accent, Highlight); }
  :where(.cd-card) { padding: .8em 1em; border-radius: calc(var(--codiscuss-radius, 6px) + 2px); background: var(--cd-tint); }
  :where(.cd-stack) { display: grid; gap: .8em; }
  :where(.cd-row) { display: flex; flex-wrap: wrap; align-items: center; gap: .5em 1em; }
  :where(.cd-between) { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .5em 1em; }
  :where(.cd-grid) { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: .8em 1.4em; }
  :where(.cd-stats) { display: flex; flex-wrap: wrap; gap: .7em 2em; }
  :where(.cd-stat) { display: grid; gap: .15em; }
  :where(.cd-stat) > :where(b, strong) { font-size: 1.5em; font-weight: 600; line-height: 1.15; letter-spacing: -.01em; font-variant-numeric: tabular-nums; }
  :where(.cd-stat) > :where(span, small) { font-size: .78em; color: var(--codiscuss-text-hint, GrayText); }
  :where(.cd-field) { display: grid; grid-template-columns: minmax(3em, auto) minmax(0, 1fr) minmax(3.5em, auto); align-items: center; gap: .9em; font-size: .9em; }
  :where(.cd-field) > :where(span) { color: var(--codiscuss-text-muted, GrayText); }
  :where(.cd-field) > :where(output) { text-align: right; font-variant-numeric: tabular-nums; font-weight: 500; }
  :where(.cd-primary) { border-color: color-mix(in srgb, var(--codiscuss-accent, Highlight) 40%, transparent) !important;
    background-color: color-mix(in srgb, var(--codiscuss-accent, Highlight) 14%, transparent) !important; color: var(--codiscuss-accent, Highlight); }
  :where(.cd-primary:hover:not(:disabled)) { background-color: color-mix(in srgb, var(--codiscuss-accent, Highlight) 24%, transparent) !important; }
  :where(.cd-tabs) { display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 2px; border-radius: calc(var(--codiscuss-radius, 6px) + 2px); background: var(--cd-tint); }
  :where(.cd-tabs) > :where(button) { min-height: 28px; border-color: transparent; background-color: transparent; color: var(--codiscuss-text-muted, GrayText); font-weight: 400; }
  :where(.cd-tabs) > :where(button:hover:not(:disabled)) { color: var(--codiscuss-text, CanvasText); }
  :where(.cd-tabs) > :where(button[aria-pressed="true"], button[aria-selected="true"]) { background-color: var(--cd-tint-strong); color: var(--codiscuss-text, CanvasText); font-weight: 500; }
  /* --cd-unit is viewBox units per CSS pixel (within limits), kept current by the startup script: text and strokes hold
     their size on screen while the drawing scales with the column, so a chart stays readable on a phone. */
  :where(.cd-chart) { display: block; width: 100%; height: auto; overflow: visible; }
  :where(.cd-chart text) { fill: var(--codiscuss-text, CanvasText); font-size: calc(12px * var(--cd-unit, 1)); }
  :where(.cd-axis, .cd-gridline, .cd-line, .cd-line-muted, .cd-box, .cd-box-accent) { vector-effect: non-scaling-stroke; }
  :where(.cd-axis) { stroke: var(--codiscuss-border, GrayText); stroke-width: 1; fill: none; }
  :where(.cd-gridline) { stroke: var(--cd-rule); stroke-width: 1; stroke-dasharray: 2 4; fill: none; }
  :where(.cd-tick) { fill: var(--codiscuss-text-hint, GrayText); font-size: calc(11px * var(--cd-unit, 1)); font-variant-numeric: tabular-nums; }
  :where(.cd-line) { stroke: var(--codiscuss-accent, Highlight); stroke-width: 2; fill: none; stroke-linecap: round; stroke-linejoin: round; }
  :where(.cd-line-muted) { stroke: var(--codiscuss-text-hint, GrayText); stroke-width: 1.25; fill: none; stroke-dasharray: 4 4; }
  :where(.cd-fill) { fill: var(--codiscuss-accent, Highlight); }
  :where(.cd-fill-soft) { fill: color-mix(in srgb, var(--codiscuss-accent, Highlight) 14%, transparent); }
  :where(.cd-fill-muted) { fill: color-mix(in srgb, var(--codiscuss-text-hint, GrayText) 45%, transparent); }
  :where(.cd-box) { fill: var(--cd-tint); stroke: var(--codiscuss-border, GrayText); stroke-width: 1; }
  :where(.cd-box-accent) { fill: color-mix(in srgb, var(--codiscuss-accent, Highlight) 14%, transparent); stroke: color-mix(in srgb, var(--codiscuss-accent, Highlight) 70%, transparent); stroke-width: 1; }
  :where(.cd-label) { fill: var(--codiscuss-text, CanvasText); font-size: calc(13px * var(--cd-unit, 1)); }
  @media (max-width: 480px) {
    :where(.cd-field) { grid-template-columns: minmax(0, 1fr) auto; gap: .1em .8em; }
    :where(.cd-field) > :where(input, select) { grid-column: 1 / -1; grid-row: 2; }
    :where(.cd-stats) { gap: .6em 1.4em; }
    :where(.cd-stat) > :where(b, strong) { font-size: 1.3em; }
  }
</style>`;
const VISUAL_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob: data:; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; media-src data: blob:; base-uri 'none'; form-action 'none'">`;

/** Runs inside the sandbox. Reports body height independently of the frame's current height. */
function start_visual_frame(measure, submit) {
  const root = document.documentElement;
  // The room page blocks pinch and double-tap zoom on touch screens, but gestures inside this opaque-origin frame never
  // reach it and zoomed the whole page (user 2026-11-27, #14151). The frame blocks them the same way.
  if (globalThis.matchMedia?.("(pointer: coarse)").matches || globalThis.navigator?.maxTouchPoints > 1) {
    root.style.touchAction = "pan-x pan-y";
    for (const type of ["gesturestart", "gesturechange"]) document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
    document.addEventListener("touchmove", (event) => { if (event.touches.length > 1) event.preventDefault(); }, { passive: false });
  }
  // A panel hands the reader's choice to the room page, which shows it above the composer for the reader to send.
  if (submit) Object.defineProperty(window, "codiscuss", { value: Object.freeze({
    submit(text, fields) {
      parent.postMessage({ codiscuss_visual_result: { format: 1, text: String(text ?? ""), fields: fields ?? null } }, "*");
      return true;
    },
  }) });
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
  // The unified kit's two values CSS cannot compute: a slider's filled share, and a chart's viewBox units per pixel.
  let kit_scheduled = false;
  function refresh_kit() {
    if (kit_scheduled) return;
    kit_scheduled = true;
    requestAnimationFrame(() => {
      kit_scheduled = false;
      for (const input of document.querySelectorAll('input[type="range"]')) {
        const min = Number(input.min || 0), max = Number(input.max || 100);
        const share = max > min ? (Number(input.value) - min) / (max - min) : 0;
        input.style.setProperty("--cd-fill", (Math.min(1, Math.max(0, share)) * 100).toFixed(2) + "%");
      }
      for (const chart of document.querySelectorAll("svg.cd-chart")) {
        const shown = chart.getBoundingClientRect().width, drawn = chart.viewBox.baseVal?.width;
        if (shown && drawn) chart.style.setProperty("--cd-unit", Math.min(1.25, Math.max(.7, drawn / shown)).toFixed(3));
      }
    });
  }
  // A page sets a slider's value from its own handlers, which run on these events.
  for (const type of ["input", "change", "click", "keyup"]) addEventListener(type, refresh_kit, true);
  addEventListener("resize", refresh_kit);
  addEventListener("DOMContentLoaded", () => {
    new MutationObserver(refresh_kit).observe(document.body, { childList: true, subtree: true });
    new ResizeObserver(refresh_kit).observe(document.body);
    refresh_kit();
  }, { once: true });
  if (measure) {
    // Shown in a message the frame takes the content's full height, so the page never scrolls inside it.
    root.style.overflow = "hidden";
    for (const type of ["pointerenter", "pointerleave"]) {
      root.addEventListener(type, () => parent.postMessage({ codiscuss_visual_hover: type === "pointerenter" }, "*"));
    }
    addEventListener("DOMContentLoaded", () => {
      new ResizeObserver(request_height).observe(document.body);
      request_height();
    }, { once: true });
    addEventListener("resize", request_height);
  }
}

/** Wrap a self-contained visual with the room's defaults and its isolated height bridge. */
export function inline_visual_document(source, automatic, { extra = "", measure = true, submit = false } = {}) {
  const startup = `<script>(${start_visual_frame.toString()})(${measure}, ${Boolean(submit)});</script>`;
  return html_document(source, (automatic ? VISUAL_CSP : "") + VISUAL_DEFAULTS + startup + extra);
}

// A panel's result is a short reply the reader still reviews, not a document.
export const VISUAL_RESULT_LIMIT = 2000;
const VISUAL_FIELDS_LIMIT = 4000;

/**
 * Read a panel's result posted by the given frame: `{ text, fields }`, `{ error: "too_long" }` when the text is over the
 * limit, or null when the message is not a result of that frame or has no text.
 */
export function visual_result(event, frame_window) {
  if (!frame_window || event.source !== frame_window) return null;
  const result = event.data?.codiscuss_visual_result;
  if (!result || result.format !== 1 || typeof result.text !== "string") return null;
  const text = result.text.replace(/\r\n?/g, "\n").trim();
  if (!text) return null;
  if (text.length > VISUAL_RESULT_LIMIT) return { error: "too_long" };
  let fields = null;
  try {
    const serialized = result.fields && typeof result.fields === "object" ? JSON.stringify(result.fields) : "";
    if (serialized && serialized.length <= VISUAL_FIELDS_LIMIT) fields = JSON.parse(serialized);
  } catch { /* Fields are optional; the text alone is the reply. */ }
  return { text, fields };
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
export function visual_tab_document(title, source, theme, restricted = false) {
  const attribute = (value) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const preview = theme ? inline_visual_document(source, restricted, { measure: false }) : html_document(source);
  const sandbox = restricted ? INLINE_VISUAL_SANDBOX : HTML_SANDBOX;
  const shell = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${attribute(title)}</title>`
    + `<style>html,body{margin:0;height:100%}iframe{display:block;width:100%;height:100%;border:0}</style>`
    + `<iframe sandbox="${sandbox}" referrerpolicy="no-referrer" srcdoc="${attribute(preview)}"></iframe>`;
  if (!theme) return shell;
  const initial = JSON.stringify(theme).replace(/</g, "\\u003c");
  return shell + `<script>(${start_visual_tab.toString()})(${initial},${inline_visual_theme.toString()},${observe_visual_theme.toString()},${send_visual_theme.toString()});</script>`;
}

/**
 * Open a trusted wrapper whose only content runs in its own opaque-origin iframe. `target` is a tab opened at the click
 * while the file was still being read (a tab opened after waiting is blocked as a pop-up); it is sent to the wrapper.
 */
export function open_html_preview_tab(title, source, theme, restricted = false, target = null) {
  const url = URL.createObjectURL(new Blob([visual_tab_document(title, source, theme, restricted)], { type: "text/html" }));
  if (target && !target.closed) target.location.replace(url);
  else window.open(url, "_blank");
}
