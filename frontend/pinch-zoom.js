/**
 * Two-finger zoom inside one scrolling preview, for content with no size control of its own now that touch screens no
 * longer zoom the whole page (user 2026-11-18, #4528). While the fingers move the shown picture is only scaled; when
 * they lift, the content is laid out and drawn at the new size, with the point between the fingers kept in place.
 */

/** The midpoint and spread of two touches. */
function finger_pair([first, second]) {
  return { x: (first.clientX + second.clientX) / 2, y: (first.clientY + second.clientY) / 2,
    spread: Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY) || 1 };
}

/**
 * Let two fingers on `element` zoom what it shows.
 * @param {HTMLElement} element Receives the touches.
 * @param {object} options
 * @param {() => HTMLElement | null} options.scroller The element that scrolls the content; null while there is nothing to zoom.
 * @param {() => number} options.get_zoom The current zoom, 1 being the fitted size.
 * @param {(zoom: number) => void | Promise<void>} options.set_zoom Lays the content out at this zoom.
 * @param {number} options.max_zoom The largest zoom.
 * @returns {() => void} Removes the gesture.
 */
export function attach_pinch_zoom(element, { scroller, get_zoom, set_zoom, max_zoom }) {
  let pinch = null, applying = false;
  const fingers = (event) => [...event.touches].filter((touch) => element.contains(touch.target));

  function start(event) {
    const touches = fingers(event), target = touches.length === 2 && !pinch && !applying ? scroller() : null;
    if (!target) return;
    event.preventDefault();
    const box = target.getBoundingClientRect(), { x, y, spread } = finger_pair(touches);
    pinch = { target, spread, from: get_zoom(), to: get_zoom(), left: x - box.left, top: y - box.top };
    target.style.transformOrigin = `${pinch.left}px ${pinch.top}px`;
  }

  function move(event) {
    if (!pinch) return;
    event.stopPropagation();
    if (event.cancelable) event.preventDefault();
    const touches = fingers(event);
    if (touches.length < 2) return;
    pinch.to = Math.min(max_zoom, Math.max(1, pinch.from * finger_pair(touches).spread / pinch.spread));
    pinch.target.style.transform = `scale(${pinch.to / pinch.from})`;
  }

  async function end(event) {
    if (!pinch || fingers(event).length >= 2) return;
    event.stopPropagation();
    const { target, from, to, left, top } = pinch;
    const point = { x: (target.scrollLeft + left) / from, y: (target.scrollTop + top) / from };
    pinch = null;
    applying = true;
    try {
      if (to !== from) await set_zoom(to);
    } finally {
      applying = false;
      target.style.transform = target.style.transformOrigin = "";
      target.scrollLeft = point.x * get_zoom() - left;
      target.scrollTop = point.y * get_zoom() - top;
    }
  }

  const listeners = [["touchstart", start], ["touchmove", move], ["touchend", end], ["touchcancel", end]];
  for (const [type, listener] of listeners) element.addEventListener(type, listener, { capture: true, passive: false });
  return () => { for (const [type, listener] of listeners) element.removeEventListener(type, listener, { capture: true }); };
}
