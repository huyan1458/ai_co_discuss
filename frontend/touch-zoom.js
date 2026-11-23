/**
 * Pinch to zoom and drag sideways to pan a time axis on a touch screen (2026-11-23 user's request, #8067: the page itself
 * never zooms on touch screens, see web/index.html, so two fingers are free for the chart). Used by the execution
 * timeline and its real-time view; the mouse keeps their own wheel and drag handling.
 *
 * Input: `share_at(client_x)` gives a point's share of the visible axis (0 left, 1 right) and `width()` the axis width in
 * pixels; `on_zoom(anchor, factor)` zooms by `factor` (below 1 zooms in) around `anchor`; `on_pan(share)` moves the view
 * by that share of its width; `can_pan()` says whether there is anywhere to pan to.
 * Output: pointer handlers `down`, `move` and `up` for the strip (they ignore anything but touch), and `moved()`, true
 * from a pan or pinch until just after the fingers lift, so the tap that ends one opens nothing.
 * The strip and everything in it should have `touch-action: pan-y` (it is not inherited, and the element a finger lands
 * on decides): an upward or downward finger still scrolls the page, and the browser leaves pinches and sideways drags to us.
 */

// A finger must move this far sideways before it pans, so a tap still taps.
const SLIDE_START_PX = 6;

export function touch_zoom({ share_at, width, on_zoom, on_pan, can_pan }) {
  const fingers = new Map();
  let pinch = null;
  let slide = null;
  let moved = false;
  const spread = () => {
    const [a, b] = [...fingers.values()];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), middle: (a.x + b.x) / 2 };
  };
  function down(event) {
    if (event.pointerType !== "touch") return;
    fingers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (fingers.size === 2) {
      pinch = spread();
      slide = null;
      for (const id of fingers.keys()) event.currentTarget.setPointerCapture?.(id);
    } else if (fingers.size === 1) {
      slide = { start: event.clientX, last: event.clientX };
    }
  }
  function move(event) {
    const finger = fingers.get(event.pointerId);
    if (!finger) return;
    finger.x = event.clientX;
    finger.y = event.clientY;
    if (pinch && fingers.size >= 2) {
      const now = spread();
      if (now.distance > 0 && pinch.distance > 0) on_zoom(share_at(now.middle), pinch.distance / now.distance);
      if (now.middle !== pinch.middle) on_pan(-(now.middle - pinch.middle) / width());
      pinch = now;
      moved = true;
      event.preventDefault();
      return;
    }
    if (!slide || !can_pan()) return;
    if (!moved && Math.abs(event.clientX - slide.start) < SLIDE_START_PX) return;
    moved = true;
    on_pan(-(event.clientX - slide.last) / width());
    slide.last = event.clientX;
  }
  function up(event) {
    if (!fingers.delete(event.pointerId)) return;
    if (fingers.size < 2) pinch = null;
    if (fingers.size === 1) {
      const [rest] = fingers.values();
      slide = { start: rest.x, last: rest.x };
    }
    if (!fingers.size) {
      slide = null;
      // The click that follows the lift belongs to the gesture.
      if (moved) setTimeout(() => { moved = false; });
    }
  }
  return { down, move, up, moved: () => moved };
}
