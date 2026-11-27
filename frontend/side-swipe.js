/**
 * A sideways swipe anywhere on a touch screen, as in reading apps (user 2026-11-27, #13918), not only from the screen's
 * edge: the file list steps back and forward with it, the file preview goes back to the file's folder.
 *
 * `side_swipe({ start, move, end })` returns touch handlers for one element. `start(event)` says whether a touch may
 * become a swipe; `move(dx)` follows the finger once the touch is plainly sideways; `end(dx, passed)` reports where it
 * was let go and whether it went far or fast enough to count. A touch that starts mostly up or down stays a scroll.
 */

// The touch has to move this far before its direction is decided, so a tap's drift stays a tap.
const SWIPE_LOCK = 10;
// Sideways means this many times more across than down.
const SWIPE_SLOPE = 1.5;
// Safari's own back and forward gestures start this close to the screen's edges; those are left to it.
const SWIPE_EDGE = 24;
// A swipe counts past this share of the screen width, or when it moves this fast (px/ms) past a short distance.
const SWIPE_SHARE = 0.3;
const SWIPE_SPEED = 0.5;
const SWIPE_MIN = 40;

/** Whether a touch on `target` belongs to something inside `stop` that scrolls or plays sideways itself. */
export function moves_sideways(target, stop) {
  for (let element = target; element && element !== stop; element = element.parentElement) {
    if (element.matches?.("input, textarea, select, video, audio, canvas, iframe, [contenteditable='true']")) return true;
    const overflow = getComputedStyle(element).overflowX;
    if ((overflow === "auto" || overflow === "scroll") && element.scrollWidth > element.clientWidth + 1) return true;
  }
  return false;
}

/** Touch handlers that turn a sideways swipe into `move` and `end` calls (see the file comment). */
export function side_swipe({ start, move, end }) {
  let swipe = null;
  return {
    touchstart(event) {
      swipe = null;
      if (event.touches.length !== 1 || !window.matchMedia("(pointer: coarse)").matches) return;
      const touch = event.touches[0];
      if (touch.clientX < SWIPE_EDGE || touch.clientX > window.innerWidth - SWIPE_EDGE) return;
      const selection = document.getSelection();
      if ((selection && !selection.isCollapsed) || !start(event)) return;
      swipe = { x: touch.clientX, y: touch.clientY, time: event.timeStamp, dx: 0, speed: 0, sideways: null };
    },
    touchmove(event) {
      if (!swipe || event.touches.length !== 1) { swipe = null; return; }
      const touch = event.touches[0], dx = touch.clientX - swipe.x, dy = touch.clientY - swipe.y;
      if (swipe.sideways === null) {
        if (Math.abs(dx) + Math.abs(dy) < SWIPE_LOCK) return;
        swipe.sideways = Math.abs(dx) > Math.abs(dy) * SWIPE_SLOPE;
        if (!swipe.sideways) { swipe = null; return; }
      }
      if (event.cancelable) event.preventDefault();
      swipe.speed = (dx - swipe.dx) / Math.max(1, event.timeStamp - swipe.time);
      swipe.time = event.timeStamp;
      swipe.dx = dx;
      move(dx);
    },
    touchend() {
      const done = swipe;
      swipe = null;
      if (!done?.sideways) return;
      const far = Math.abs(done.dx) > window.innerWidth * SWIPE_SHARE;
      const fast = Math.abs(done.speed) > SWIPE_SPEED && Math.abs(done.dx) > SWIPE_MIN && Math.sign(done.speed) === Math.sign(done.dx);
      end(done.dx, far || fast);
    },
  };
}
