// A pane counts as read to the end within this distance, and stays at the end after a width change.
const BOTTOM_THRESHOLD = 40;
// Boxes that do not scroll with the content (sticky headers, overlays) cannot mark the reading position.
const DETACHED_POSITIONS = new Set(["sticky", "fixed", "absolute"]);

/** Whether `item` is laid out in the normal block flow, where siblings stack top to bottom. */
function in_flow(item) {
  if (!item.getClientRects().length) return false;
  const style = getComputedStyle(item);
  return !DETACHED_POSITIONS.has(style.position) && style.display !== "inline";
}

/** The first in-flow child of `parent` that reaches below `top`, or null. */
function child_at(parent, top) {
  const items = parent.children;
  // A transcript holds hundreds of cards; in-flow children stack in order, so a binary search skips those above the line.
  let low = 0, high = items.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    let probe = middle;
    while (probe < high && !in_flow(items[probe])) probe++;
    if (probe < high && items[probe].getBoundingClientRect().bottom <= top) low = probe + 1;
    else high = middle;
  }
  for (let index = low; index < items.length; index++) {
    const item = items[index];
    if (in_flow(item) && item.getBoundingClientRect().bottom > top) return item;
  }
  return null;
}

/** The innermost block that crosses or starts right below the reading line, so long cards anchor on a paragraph. */
function find_anchor(element, top) {
  let found = null;
  for (let parent = element, child = child_at(parent, top); child; parent = child, child = child_at(parent, top)) {
    found = child;
    if (child.getBoundingClientRect().top >= top) break;
  }
  return found;
}

/** Where the reading line falls inside `node`, as a share of its height. */
function share_of(node, top) {
  const rect = node.getBoundingClientRect();
  return (top - rect.top) / (rect.height || 1);
}

/**
 * Keeps a scroll pane on the same content when its size changes (device rotation, window resize, a side panel
 * opening). Rewrapped text changes every block's height, so the old scrollTop would land somewhere else; this records
 * the block at the reading line and how far into it the reader is, and scrolls it back to the line after the resize.
 * A pane read to the end stays at the end: tablets keep a fixed 1440px layout width (web/index.html), so rotating one
 * only changes the height, and a shorter pane would otherwise hide the newest content below the fold.
 *
 * @param {HTMLElement} element The scroll container.
 * @param {object} [options]
 * @param {() => number} [options.reading_top] Viewport y where readable content starts (below an overlaid top bar).
 * @param {() => boolean} [options.stick_bottom] Overrides the pane's own "read to the end" detection.
 * @param {() => void} [options.after_restore] Runs after the position is restored.
 * @returns {{ stale: () => boolean, disconnect: () => void }} `stale` is true between a resize and its restore,
 *   while the pane's scrollTop belongs to the old layout.
 */
export function keep_reading_position(element, options = {}) {
  const reading_top = options.reading_top || (() => element.getBoundingClientRect().top);
  let size = "";
  let anchor = null;
  const measure = () => `${element.clientWidth}x${element.clientHeight}`;
  const stale = () => Boolean(size) && measure() !== size;

  function record() {
    if (!element.clientHeight || stale()) return;
    const top = reading_top();
    const node = find_anchor(element, top);
    const keyed = node?.closest("[id]");
    const overflow = element.scrollHeight - element.clientHeight;
    anchor = {
      // Content that fits has no end to keep; treating it as read to the end would scroll new results to the bottom.
      bottom: overflow > 0 && overflow - element.scrollTop < BOTTOM_THRESHOLD,
      node, share: node ? share_of(node, top) : 0,
      // Re-rendering can replace the node; the nearest element with an id (a message card) is found again by id.
      key: keyed && keyed !== element && element.contains(keyed) ? { id: keyed.id, share: share_of(keyed, top) } : null,
    };
  }

  function restore() {
    if (options.stick_bottom ? options.stick_bottom() : anchor?.bottom) element.scrollTop = element.scrollHeight;
    else if (anchor) {
      const keyed = anchor.key && element.querySelector(`[id="${CSS.escape(anchor.key.id)}"]`);
      const [node, share] = anchor.node?.isConnected ? [anchor.node, anchor.share] : keyed ? [keyed, anchor.key.share] : [];
      if (node) {
        const rect = node.getBoundingClientRect();
        element.scrollTop += rect.top + share * rect.height - reading_top();
      }
    }
    options.after_restore?.();
  }

  const observer = new ResizeObserver(() => {
    // A hidden pane (display: none) reports 0; keep the last layout so showing it again restores the place.
    if (!element.clientWidth || !element.clientHeight || measure() === size) return;
    const measured = size;
    size = measure();
    if (measured) restore();
    record();
  });
  // Finding the anchor measures several boxes; once per frame is enough and keeps the scroll itself from stalling.
  let frame = 0;
  const schedule_record = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; record(); }); };
  element.addEventListener("scroll", schedule_record, { passive: true });
  observer.observe(element);
  return {
    stale,
    disconnect() {
      observer.disconnect();
      cancelAnimationFrame(frame);
      element.removeEventListener("scroll", schedule_record);
    },
  };
}

const positions = new WeakMap();

/** `v-keep-reading` on a scroll pane: keep its reading position across resizes. */
export const keep_reading = {
  mounted(element) { positions.set(element, keep_reading_position(element)); },
  unmounted(element) { positions.get(element)?.disconnect(); positions.delete(element); },
};
