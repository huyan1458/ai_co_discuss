/**
 * Viewer.js (MIT) for images: the file preview shows a project image inline (MediaViewer.vue), and a message's image
 * attachment opens full screen with the same tools.
 */
import Viewer from "viewerjs";
import { h, render } from "vue";
import PreviewLoading from "./PreviewLoading.vue";
import "viewerjs/dist/viewer.css";
import { t } from './i18n.js';

/**
 * The viewer only looks at an image and saves it (user 2026-11-18, #4516, #4520): zoom in, zoom out, back to fit,
 * rotate left, rotate right, save. `source` returns the current `{ url, name }`; nothing is saved before the image has
 * an address.
 */
export function image_toolbar(source) {
  return { zoomIn: 1, zoomOut: 1, reset: 1, rotateLeft: 1, rotateRight: 1, save: { show: 1, click() {
    const { url, name, save } = source();
    if (save) return save();
    if (!url) return;
    const link = document.createElement("a");
    link.href = url;
    link.download = name || "";
    link.click();
  } } };
}
// Two fingers only pinch to zoom: Viewer.js would also turn the image by any small twist of the fingers (rotateOnGesture,
// rotateOnTouch), which tilts it at odd angles; the toolbar still rotates by 90 degrees.
// An image that fits the view stays centered: dragging only pans an image larger than the view, and zooming back
// down to a fitting size centers it again. Viewer.js passes the image element, which holds the viewer as `viewer`.
export const IMAGE_ZOOM = { zoomRatio: 0.2, minZoomRatio: 0.05, maxZoomRatio: 40, rotateOnGesture: false, rotateOnTouch: false,
  ready() {
    const save = this.viewer.toolbar.querySelector(".viewer-save");
    save?.setAttribute("aria-label", t('保存图片'));
    save?.setAttribute("title", t('保存图片'));
    one_gesture_at_a_time(this.viewer);
  },
  move(event) { const center = centered(this.viewer); if (center && (event.detail.x !== center.x || event.detail.y !== center.y)) event.preventDefault(); },
  zoomed() { const center = centered(this.viewer); if (center) this.viewer.moveTo(center.x, center.y); } };

// How far the two fingers must spread or close before a pinch counts, so resting them on the image changes nothing.
const PINCH_START_PX = 8;

/**
 * On a touch screen one gesture does one thing (user 2026-11-18, #4467): one finger drags, two fingers only zoom. Viewer.js
 * zooms around the fingers' current midpoint, so fingers drifting while they pinch also drag the image; here the point
 * between the fingers is fixed when the pinch starts. From the second finger until every finger has lifted the gesture
 * stays a pinch: a finger left on the glass does not drag. One finger, the mouse and the wheel stay with Viewer.js.
 */
function one_gesture_at_a_time(viewer) {
  const fingers = new Map();
  let pinch = null, origin = null;
  const claim = (event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  const spread = () => { const [first, second] = [...fingers.values()]; return Math.hypot(first.x - second.x, first.y - second.y); };

  /** Take the gesture from Viewer.js, undoing what the first finger had dragged before the second one landed. */
  function start_pinch() {
    viewer.pointers = {};
    viewer.action = false;
    viewer.moveTo(origin.x, origin.y);
    const [first, second] = [...fingers.values()], box = viewer.viewer.getBoundingClientRect();
    pinch = { spread: spread(), ratio: viewer.imageData.ratio, zooming: false, over: false,
      pivot: { x: (first.x + second.x) / 2 - box.left, y: (first.y + second.y) / 2 - box.top } };
  }
  function moved(event) {
    if (event.pointerType !== "touch" || !fingers.has(event.pointerId)) return;
    fingers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!pinch) return;
    claim(event);
    if (pinch.over) return;
    const now = spread();
    if (pinch.zooming) viewer.zoomTo(pinch.ratio * now / pinch.spread, false, pinch.pivot);
    else if (Math.abs(now - pinch.spread) >= PINCH_START_PX) Object.assign(pinch, { zooming: true, spread: now });
  }
  function lifted(event) {
    if (event.pointerType !== "touch") return;
    if (pinch) { claim(event); pinch.over = true; }
    fingers.delete(event.pointerId);
    if (fingers.size) return;
    pinch = null;
    document.removeEventListener("pointermove", moved, true);
    document.removeEventListener("pointerup", lifted, true);
    document.removeEventListener("pointercancel", lifted, true);
  }
  viewer.canvas.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch" || !viewer.viewed) return;
    if (pinch) { claim(event); return; }
    fingers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (fingers.size === 1) {
      origin = { x: viewer.imageData.x, y: viewer.imageData.y };
      document.addEventListener("pointermove", moved, { capture: true, passive: false });
      document.addEventListener("pointerup", lifted, true);
      document.addEventListener("pointercancel", lifted, true);
      return;
    }
    claim(event);
    start_pinch();
  }, true);
  // Safari also reports a pinch as gesture events, which Viewer.js would zoom by a second time.
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    viewer.viewer.addEventListener(type, (event) => { if (fingers.size) claim(event); }, { capture: true, passive: false });
  }
}

/** The image's centered position while it fits inside the view (rotation counted), or null when it is larger. */
function centered(viewer) {
  const { imageData, viewerData, initialImageData: initial } = viewer || {};
  if (!imageData || !viewerData || !initial) return null;
  const turned = Math.abs(imageData.rotate || 0) % 180 === 90;
  const [width, height] = turned ? [imageData.height, imageData.width] : [imageData.width, imageData.height];
  if (width > viewerData.width + 1 || height > viewerData.height + 1) return null;
  // Around the spot Viewer.js first placed the image, which leaves room for its own controls.
  return { x: initial.left + (initial.width - imageData.width) / 2, y: initial.top + (initial.height - imageData.height) / 2 };
}

// A local placeholder lets Viewer build its full-screen controls before a relayed image has an address.
const EMPTY_IMAGE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/%3E";
// The step buttons fade out after this long without pointer, wheel or key activity (user 2026-11-26, #13469).
const STEP_IDLE_MS = 2500;
// A one-finger swipe steps when it travels this far sideways, and mostly sideways.
const SWIPE_MIN_PX = 50;
const SWIPE_SIDEWAYS_RATIO = 1.5;

/**
 * Open immediately, resolve the image address in the background, and release the viewer when closed. `files` are the
 * images that can be stepped through, `index` the one shown first; side buttons and the left / right arrow keys step
 * between them (user 2026-11-26, #12354), and on a touch screen a sideways swipe does too while the image fits the view;
 * the side buttons fade out when left idle and come back on any activity (user 2026-11-26, #13469). `load_url(file)`
 * resolves one file's address; `load_thumbnail(file)` its smaller copy's, or "" when it has none: that copy shows first
 * and the original takes its place once read.
 */
export function open_image_viewer(files, index, load_url, load_thumbnail = () => Promise.resolve("")) {
  const image = document.createElement("img");
  const source = document.createElement("div"), cover = document.createElement("div");
  source.append(image);
  image.src = EMPTY_IMAGE;
  // `shown_url` is the address on screen (a smaller copy for a moment), `loaded_url` the original, the one saved.
  let closed = false, loaded_url = "", shown_url = "", current = index, reading = 0;
  const file_name = () => files[current].file_name || "";
  const title = () => files.length > 1 ? t('{name} · {index}/{total}', { name: file_name(), index: current + 1, total: files.length }) : file_name();
  cover.style.cssText = "position:absolute;inset:40px 0 70px;display:flex;justify-content:center;pointer-events:none;z-index:1";
  const steps = files.length > 1 ? [-1, 1].map((step) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `viewer-step viewer-step-${step < 0 ? "prev" : "next"}`;
    button.setAttribute("aria-label", step < 0 ? t('上一张') : t('下一张'));
    button.title = button.getAttribute("aria-label");
    button.addEventListener("click", () => go(step));
    return button;
  }) : [];
  let idle_timer = 0, swipe = null;
  const touches = new Set();
  /** Show the step buttons again and fade them out after a while without activity; a mouse resting on one keeps them. */
  function wake_steps() {
    if (!steps.length || closed) return;
    viewer.viewer?.classList.remove("viewer-steps-idle");
    clearTimeout(idle_timer);
    idle_timer = setTimeout(() => {
      if (closed) return;
      if (matchMedia("(hover: hover)").matches && steps.some((button) => button.matches(":hover"))) { wake_steps(); return; }
      viewer.viewer?.classList.add("viewer-steps-idle");
    }, STEP_IDLE_MS);
  }
  // On the window in the capture phase: the pinch handling claims touch events further down and stops them there.
  const on_pointer = (event) => {
    if (closed || !viewer.viewer) return;
    if (event.type === "pointermove" || event.type === "pointerdown") {
      if (!viewer.viewer.contains(event.target)) return;
      wake_steps();
      if (event.type === "pointermove" || event.pointerType !== "touch") return;
      touches.add(event.pointerId);
      // Only a lone finger on an image that fits the view swipes: a larger image is being dragged, two fingers pinch.
      swipe = touches.size === 1 && steps.length && centered(viewer) ? { x: event.clientX, y: event.clientY } : null;
      return;
    }
    if (!touches.delete(event.pointerId)) return;
    if (event.type === "pointerup" && swipe && !touches.size) {
      const dx = event.clientX - swipe.x, dy = event.clientY - swipe.y;
      if (Math.abs(dx) >= SWIPE_MIN_PX && Math.abs(dx) > SWIPE_SIDEWAYS_RATIO * Math.abs(dy)) go(dx < 0 ? 1 : -1);
    }
    if (!touches.size) swipe = null;
  };
  const pointer_events = ["pointerdown", "pointermove", "pointerup", "pointercancel"];
  const on_key = (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    // Viewer.js would also take the arrow keys; here they only step between the images.
    event.preventDefault();
    event.stopImmediatePropagation();
    go(event.key === "ArrowLeft" ? -1 : 1);
  };
  const viewer = new Viewer(image, { navbar: false, title: [1, title], toolbar: image_toolbar(() => ({ url: loaded_url, name: file_name() })), transition: false,
    toggleOnDblclick: true, ...IMAGE_ZOOM,
    shown() {
      viewer.viewer.append(cover, ...steps);
      for (const type of pointer_events) window.addEventListener(type, on_pointer, true);
      viewer.viewer.addEventListener("wheel", wake_steps, { passive: true });
      wake_steps();
    },
    viewed() { if (shown_url && viewer.image?.src === shown_url) render(null, cover); },
    hidden() {
      closed = true;
      clearTimeout(idle_timer);
      for (const type of pointer_events) window.removeEventListener(type, on_pointer, true);
      document.removeEventListener("keydown", on_key, true);
      render(null, cover);
      viewer.destroy();
    } });
  /** Show the image `step` places away; the first and last image have no further step. */
  function go(step) {
    const next = current + step;
    if (closed || next < 0 || next >= files.length) return;
    current = next;
    show_steps();
    wake_steps();
    load();
  }
  function show_steps() {
    if (steps.length) { steps[0].hidden = current === 0; steps[1].hidden = current === files.length - 1; }
  }
  function failed(error) {
    if (closed) return;
    render(h("div", { style: "align-self:center;text-align:center;color:var(--ui-text)" }, [
      h("p", error.message || t('图片读取失败')),
      h("button", { type: "button", style: "pointer-events:auto;text-decoration:underline", onClick: load }, t('重新读取图片')),
    ]), cover);
  }
  /** Put one address on screen, fitted to the view. */
  function show(address) {
    image.src = address;
    image.alt = file_name();
    shown_url = image.src;
    viewer.update();
    viewer.view(0);
  }
  async function load() {
    const read = ++reading, file = files[current];
    loaded_url = "";
    render(h(PreviewLoading, { label: t('正在载入图片…') }), cover);
    let showing_thumbnail = false;
    const show_thumbnail = url => {
      if (url && !closed && read === reading && !loaded_url) {
        show(url);
        showing_thumbnail = true;
      }
    };
    try {
      const original = load_url(file);
      const preview = load_thumbnail(file);
      if (typeof preview === "string") show_thumbnail(preview);
      else Promise.resolve(preview).then(show_thumbnail).catch(() => {});
      const address = await original;
      if (closed || read !== reading) return;
      // The original takes the smaller copy's place where it is, keeping any zoom or turn made meanwhile.
      if (showing_thumbnail && viewer.image) {
        image.src = viewer.image.src = address;
        shown_url = viewer.image.src;
      } else show(address);
      loaded_url = image.src;
      for (const neighbor of [files[current - 1], files[current + 1]]) {
        if (neighbor?.thumbnail_url) Promise.resolve(load_thumbnail({ ...neighbor, prefetch: true })).then(url => {
          if (url && !url.startsWith("blob:")) new Image().src = url;
        }).catch(() => {});
      }
      viewer.image?.addEventListener("error", () => failed(new Error(t('图片读取失败'))), { once: true });
    } catch (error) { if (read === reading) failed(error); }
  }
  image.alt = file_name();
  show_steps();
  document.addEventListener("keydown", on_key, true);
  viewer.show();
  load();
}

export { Viewer };
