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
    const { url, name } = source();
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

/** Open immediately, resolve the image address in the background, and release the viewer when closed. */
export function open_image_viewer({ url, file_name = "" }, load_url = () => Promise.resolve(url)) {
  const image = document.createElement("img");
  const source = document.createElement("div"), cover = document.createElement("div");
  source.append(image);
  image.src = EMPTY_IMAGE;
  image.alt = file_name;
  let closed = false, loaded_url = "";
  cover.style.cssText = "position:absolute;inset:40px 0 70px;display:flex;justify-content:center;pointer-events:none;z-index:1";
  const viewer = new Viewer(image, { navbar: false, title: [1, () => file_name], toolbar: image_toolbar(() => ({ url: loaded_url, name: file_name })), transition: false,
    toggleOnDblclick: true, ...IMAGE_ZOOM,
    shown() { viewer.viewer.append(cover); },
    viewed() { if (loaded_url && viewer.image?.src === loaded_url) render(null, cover); },
    hidden() { closed = true; render(null, cover); viewer.destroy(); } });
  function failed(error) {
    if (closed) return;
    render(h("div", { style: "align-self:center;text-align:center;color:var(--ui-text)" }, [
      h("p", error.message || t('图片读取失败')),
      h("button", { type: "button", style: "pointer-events:auto;text-decoration:underline", onClick: load }, t('重新读取图片')),
    ]), cover);
  }
  async function load() {
    render(h(PreviewLoading, { label: t('正在载入图片…') }), cover);
    try {
      const address = await load_url();
      if (closed) return;
      image.src = address;
      loaded_url = image.src;
      viewer.update();
      viewer.view(0);
      viewer.image?.addEventListener("error", () => failed(new Error(t('图片读取失败'))), { once: true });
    } catch (error) { failed(error); }
  }
  viewer.show();
  load();
}

export { Viewer };
