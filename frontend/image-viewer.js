/**
 * Viewer.js (MIT) for images: the file preview shows a project image inline (MediaViewer.vue), and a message's image
 * attachment opens full screen with the same tools.
 */
import Viewer from "viewerjs";
import { h, render } from "vue";
import PreviewLoading from "./PreviewLoading.vue";
import "viewerjs/dist/viewer.css";

// Zoom, original size, fit, rotate and flip; no gallery navigation for a single image.
export const IMAGE_TOOLBAR = { zoomIn: 1, zoomOut: 1, oneToOne: 1, reset: 1, rotateLeft: 1, rotateRight: 1, flipHorizontal: 1, flipVertical: 1 };
// Two fingers only pinch to zoom: Viewer.js would also turn the image by any small twist of the fingers (rotateOnGesture,
// rotateOnTouch), which tilts it at odd angles; the toolbar still rotates by 90 degrees.
export const IMAGE_ZOOM = { zoomRatio: 0.2, minZoomRatio: 0.05, maxZoomRatio: 40, rotateOnGesture: false, rotateOnTouch: false };

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
  const viewer = new Viewer(image, { navbar: false, title: [1, () => file_name], toolbar: IMAGE_TOOLBAR, transition: false,
    toggleOnDblclick: true, ...IMAGE_ZOOM,
    shown() { viewer.viewer.append(cover); },
    viewed() { if (loaded_url && viewer.image?.src === loaded_url) render(null, cover); },
    hidden() { closed = true; render(null, cover); viewer.destroy(); } });
  function failed(error) {
    if (closed) return;
    render(h("div", { style: "align-self:center;text-align:center;color:var(--ui-text)" }, [
      h("p", error.message || "图片读取失败"),
      h("button", { type: "button", style: "pointer-events:auto;text-decoration:underline", onClick: load }, "重新读取图片"),
    ]), cover);
  }
  async function load() {
    render(h(PreviewLoading, { label: "正在载入图片…" }), cover);
    try {
      const address = await load_url();
      if (closed) return;
      image.src = address;
      loaded_url = image.src;
      viewer.update();
      viewer.view(0);
      viewer.image?.addEventListener("error", () => failed(new Error("图片读取失败")), { once: true });
    } catch (error) { failed(error); }
  }
  viewer.show();
  load();
}

export { Viewer };
