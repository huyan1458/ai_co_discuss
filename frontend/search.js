import { reactive, ref } from "vue";

// Text search over rooms, in the two shapes VSCode has: the find bar inside a room (Ctrl+F) and the search page over every
// room (Ctrl+Shift+F). The site answers both (`/api/rooms/{room}/search`, `/api/search`); this module keeps what both share.

/** Highlight names registered with the CSS Custom Highlight API; channel.css styles them. */
const HIGHLIGHT_ALL = "codiscuss-find";
const HIGHLIGHT_CURRENT = "codiscuss-find-current";
// Characters a whole-word match may not touch, for every script (`\b` in JavaScript only knows ASCII letters).
const WORD_EDGE = "[\\p{L}\\p{N}_]";

/** The search page over every room: open or not, and what it was asked last. */
const page_open = ref(false);
const page_request = reactive({ query: "", options: { case: false, word: false, regex: false }, serial: 0 });
/** A result chosen on the search page, for the room's find bar to take over once that room is on screen. */
export const find_handoff = ref(null);

/** Shared state for the search page, matching the analytics and workflow pages. */
export function use_search_page() {
  return {
    page_open,
    request: page_request,
    open(query = "", options = null) {
      page_request.query = query;
      if (options) Object.assign(page_request.options, options);
      page_request.serial += 1;
      page_open.value = true;
    },
    close() { page_open.value = false; },
  };
}

/** The query string both search endpoints take. */
export function search_params(query, options, extra = {}) {
  const params = new URLSearchParams({ q: query, case: options.case ? "1" : "0", word: options.word ? "1" : "0", regex: options.regex ? "1" : "0" });
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  return params.toString();
}

/**
 * The same search as a JavaScript pattern, used only to mark matches on screen; the site's answer decides what matches.
 * Returns null when the text is empty or the pattern is one JavaScript cannot read (Python syntax it lacks).
 */
export function search_pattern(query, options) {
  if (!query) return null;
  const body = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = options.word ? `(?<!${WORD_EDGE})(?:${body})(?!${WORD_EDGE})` : body;
  try { return new RegExp(word, `gu${options.case ? "" : "i"}`); }
  catch { return null; }
}

/** Split a snippet into plain and matched pieces from the site's `[start, end]` ranges. */
export function snippet_parts(snippet, ranges) {
  const text = String(snippet || "");
  const parts = [];
  let at = 0;
  for (const [start, end] of [...(ranges || [])].sort((a, b) => a[0] - b[0])) {
    if (start < at || end <= start) continue;
    if (start > at) parts.push({ text: text.slice(at, start), hit: false });
    parts.push({ text: text.slice(start, end), hit: true });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts;
}

/** Whether this browser can mark text without changing the page (CSS Custom Highlight API). */
const can_highlight = typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";

/**
 * Mark every match inside the transcript's message rows, the current row's ones in the stronger colour. The marks are
 * ranges over the existing text, so the transcript's own rendering is untouched.
 */
export function paint_matches(root, pattern, current_row) {
  if (!can_highlight) return;
  const all = [], current = [];
  if (root && pattern) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => node.nodeValue.trim() && node.parentElement?.closest("[data-transcript-row]") && !node.parentElement.closest("button, [aria-hidden='true']")
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const in_current = current_row != null && node.parentElement.closest("[data-transcript-row]")?.dataset.transcriptRow === String(current_row);
      pattern.lastIndex = 0;
      for (const match of node.nodeValue.matchAll(pattern)) {
        if (!match[0]) continue;
        const range = new Range();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        (in_current ? current : all).push(range);
      }
    }
  }
  CSS.highlights.set(HIGHLIGHT_ALL, new Highlight(...all));
  CSS.highlights.set(HIGHLIGHT_CURRENT, new Highlight(...current));
}

/** Remove the marks when the find bar is cleared or leaves the page. */
export function clear_matches() {
  if (!can_highlight) return;
  CSS.highlights.delete(HIGHLIGHT_ALL);
  CSS.highlights.delete(HIGHLIGHT_CURRENT);
}
