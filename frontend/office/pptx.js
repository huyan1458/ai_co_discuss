/**
 * PowerPoint (.pptx) preview, loaded only when one is opened: @silurus/ooxml (MIT) parses the deck in WebAssembly and
 * draws every slide on a canvas in one scrolling view.
 */
import { PptxScrollViewer } from "@silurus/ooxml/pptx";

/** Show the deck at `source` (a URL or an ArrayBuffer) in `container`; returns the viewer, to `destroy()` later. */
export async function mount_pptx(container, source) {
  const viewer = new PptxScrollViewer(container);
  await viewer.load(source);
  return viewer;
}
