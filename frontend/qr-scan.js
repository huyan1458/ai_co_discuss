/** Reading QR codes in the page: from the camera (device pairing, joining a room) or from an image or screenshot. */
import { ref } from "vue";
import jsQR from "jsqr";

// A QR code in a screenshot can be under two pixels per module: a second pass reads it at twice the size.
const IMAGE_SCALES = [1, 2];
const MAX_IMAGE_PIXELS = 16_000_000;

/**
 * Read the QR code in an image file.
 *
 * @param {Blob} file The picked or pasted image.
 * @returns {Promise<string>} The code's text; empty when the image cannot be read or shows no code.
 */
export async function read_qr_image(file) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return "";
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  try {
    for (const scale of IMAGE_SCALES) {
      const width = bitmap.width * scale, height = bitmap.height * scale;
      if (width * height > MAX_IMAGE_PIXELS) break;
      Object.assign(canvas, { width, height });
      context.imageSmoothingEnabled = false;
      context.drawImage(bitmap, 0, 0, width, height);
      const found = jsQR(context.getImageData(0, 0, width, height).data, width, height, { inversionAttempts: "attemptBoth" });
      if (found?.data) return found.data;
    }
    return "";
  } finally { bitmap.close(); }
}

/**
 * Scan with the camera until a code is accepted. Bind the returned `video` ref to a `<video>` shown while `scanning`.
 *
 * @param {object} options
 * @param {(text: string) => boolean} options.accept Takes a code's text; true ends the scan.
 * @param {() => void} options.denied Called when the camera cannot be opened.
 * @returns {{scanning: object, camera_ready: object, video: object, scan: Function, stop_scan: Function}} The scan's state and controls.
 */
export function use_qr_camera({ accept, denied }) {
  const scanning = ref(false), camera_ready = ref(false), video = ref(null);
  let scan_version = 0, stream = null;

  function stop_scan() {
    scan_version++;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    scanning.value = false;
    camera_ready.value = false;
  }

  function read_frames() {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const frame = () => {
      if (!scanning.value || !video.value) return;
      const { videoWidth: width, videoHeight: height } = video.value;
      if (width && height) {
        Object.assign(canvas, { width, height });
        context.drawImage(video.value, 0, 0, width, height);
        const found = jsQR(context.getImageData(0, 0, width, height).data, width, height, { inversionAttempts: "dontInvert" });
        if (found && accept(found.data)) return stop_scan();
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  async function scan() {
    if (scanning.value) return;
    const version = ++scan_version;
    scanning.value = true;
    try {
      const opened = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      if (version !== scan_version) { opened.getTracks().forEach((track) => track.stop()); return; }
      stream = opened;
    } catch {
      if (version !== scan_version) return;
      stop_scan();
      denied();
      return;
    }
    await new Promise(requestAnimationFrame);
    if (version !== scan_version || !video.value) return;
    video.value.srcObject = stream;
    await video.value.play().catch(() => {});
    if (version !== scan_version) return;
    camera_ready.value = true;
    read_frames();
  }

  return { scanning, camera_ready, video, scan, stop_scan };
}
