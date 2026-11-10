/**
 * Word (.docx) preview, loaded only when one is opened: docx-preview (Apache-2.0) lays the document out as pages of
 * HTML. The caller passes a container inside a sandboxed frame without scripts, so nothing in the file can run.
 */
import { renderAsync } from "docx-preview";

/** Render `data` (ArrayBuffer) into `body`, with its styles in `styles`; comments and tracked changes stay hidden. */
export async function render_docx(data, body, styles) {
  await renderAsync(data, body, styles, { inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: true,
    renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true, renderComments: false,
    renderChanges: false, useBase64URL: true, experimental: false });
}
