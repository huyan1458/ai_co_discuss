/**
 * Viewer.js (MIT) for images: the file preview shows a project image inline (MediaViewer.vue), and a message's image
 * attachment opens full screen with the same tools.
 */
import Viewer from "viewerjs";
import "viewerjs/dist/viewer.css";

// Zoom, original size, fit, rotate and flip; no gallery navigation for a single image.
export const IMAGE_TOOLBAR = { zoomIn: 1, zoomOut: 1, oneToOne: 1, reset: 1, rotateLeft: 1, rotateRight: 1, flipHorizontal: 1, flipVertical: 1 };
export const IMAGE_ZOOM = { zoomRatio: 0.2, minZoomRatio: 0.05, maxZoomRatio: 40 };

/** Open one image (`{ url, file_name }`) full screen; the viewer is torn down once it closes. */
export function open_image_viewer({ url, file_name = "" }) {
  const image = document.createElement("img");
  image.src = url;
  image.alt = file_name;
  const viewer = new Viewer(image, { navbar: false, title: [1, () => file_name], toolbar: IMAGE_TOOLBAR, transition: false,
    toggleOnDblclick: true, ...IMAGE_ZOOM, hidden() { viewer.destroy(); } });
  viewer.show();
}

export { Viewer };
