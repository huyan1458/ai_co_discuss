/**
 * `[图片 #n]` / `[文件 #n]` in a composer behave as one token, as a pasted screenshot's placeholder does in Claude Code's
 * prompt: an edit that touches any part of one removes all of it, the caret never stops inside, and the composer's
 * mirror paints it as a tag. The text stays plain text, so sending, drafts and the classic page are unchanged.
 */

/** `[start, end]` of every draft placeholder present in the text, in order. */
export function token_ranges(text, drafts) {
  const ranges = [];
  for (const { placeholder } of drafts) {
    if (!placeholder) continue;
    for (let at = text.indexOf(placeholder); at >= 0; at = text.indexOf(placeholder, at + 1)) ranges.push([at, at + placeholder.length]);
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

/** Widen `[start, end]` to every token it touches; a deletion that removes a token takes one following space with it. */
function widen(text, ranges, start, end, deleting) {
  for (const [from, to] of ranges) {
    if (from < end && start < to) {
      start = Math.min(start, from);
      end = Math.max(end, to);
    }
  }
  if (deleting && ranges.some(([from, to]) => from >= start && to === end) && text[end] === " ") end += 1;
  return [start, end];
}

/**
 * Before an edit lands (`beforeinput`): when it would cut into a token, apply it to the whole token instead. Backspace
 * right after a token, Delete right before it, a selection over part of it, typing or pasting over it all remove it.
 */
export function guard_token_edit(event, drafts) {
  const area = event.target;
  if (!(area instanceof HTMLTextAreaElement) || event.isComposing) return;
  const ranges = token_ranges(area.value, drafts);
  if (!ranges.length) return;
  let start = area.selectionStart, end = area.selectionEnd;
  // A collapsed delete (a character, a word, to the line start) first reaches the character beside the caret; when
  // that character is a token's, the token alone goes, which is what the key means next to a tag.
  if (start === end) {
    if (event.inputType.startsWith("delete") && event.inputType.endsWith("Backward")) start = Math.max(0, start - 1);
    else if (event.inputType.startsWith("delete") && event.inputType.endsWith("Forward")) end += 1;
    else if (!event.inputType.startsWith("insert")) return;
  }
  const deleting = event.inputType.startsWith("delete");
  const [from, to] = widen(area.value, ranges, start, end, deleting);
  if (from === start && to === end) return;
  event.preventDefault();
  const inserted = deleting ? "" : ["insertLineBreak", "insertParagraph"].includes(event.inputType) ? "\n"
    : event.data ?? event.dataTransfer?.getData("text/plain") ?? "";
  area.setRangeText(inserted, from, to, "end");
  area.dispatchEvent(new Event("input", { bubbles: true }));
}

/** ← and → step over a whole token instead of into it; with Shift the selection grows by the whole token. */
export function step_over_token(event, drafts) {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
  const area = event.target;
  if (!(area instanceof HTMLTextAreaElement)) return;
  const left = event.key === "ArrowLeft";
  const caret = left ? area.selectionStart : area.selectionEnd;
  const token = token_ranges(area.value, drafts).find(([from, to]) => (left ? to === caret : from === caret));
  if (!token) return;
  event.preventDefault();
  const target = left ? token[0] : token[1];
  if (event.shiftKey) area.setSelectionRange(left ? target : area.selectionStart, left ? area.selectionEnd : target, left ? "backward" : "forward");
  else area.setSelectionRange(target, target);
}

/** A caret put inside a token (a click, Home/End across lines) moves to its nearer edge. */
export function snap_caret(event, drafts) {
  const area = event.target;
  if (!(area instanceof HTMLTextAreaElement) || area.selectionStart !== area.selectionEnd) return;
  const caret = area.selectionStart;
  const token = token_ranges(area.value, drafts).find(([from, to]) => from < caret && caret < to);
  if (!token) return;
  const edge = caret - token[0] < token[1] - caret ? token[0] : token[1];
  area.setSelectionRange(edge, edge);
}

/** Painted copy of the text with tokens as tags (and any extra `[start, end, class]` spans), or "" when there is nothing to paint. */
export function token_mirror(text, drafts, extra = []) {
  const spans = [...token_ranges(text, drafts).map(([from, to]) => [from, to, "channel-mention channel-attachment-token"]), ...extra]
    .sort((a, b) => a[0] - b[0]).filter((span, index, all) => index === 0 || span[0] >= all[index - 1][1]);
  if (!spans.length) return "";
  const escape = (value) => value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
  let html = "", cursor = 0;
  for (const [from, to, name] of spans) {
    html += `${escape(text.slice(cursor, from))}<span class="${name}">${escape(text.slice(from, to))}</span>`;
    cursor = to;
  }
  // The trailing space keeps a final empty line, which the textarea also shows.
  return `${html}${escape(text.slice(cursor))} `;
}
