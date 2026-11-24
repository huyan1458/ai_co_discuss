// `v-float-box` on a comment box: drag its edge or any blank part to move it (floating boxes), and drag the grip in its
// bottom-right corner to resize it. Both last only while the box is open. The move is a CSS `translate`, so a floating box
// keeps following its passage (the `left` / `top` its owner sets) with the user's offset on top.
// `v-float-box="'resize'"` (inline boxes in the notes list) adds only the resize grip. Docked boxes (phones) and
// `v-float-box="false"` are left alone.
const MIN_WIDTH = 280;
const MIN_HEIGHT = 70;
const INLINE_MAX_HEIGHT = 560;
const INLINE_VIEWPORT_RESERVE = 160;
const EDGE = 8;

const clamp = (value, low, high) => Math.max(low, Math.min(value, high));

/** The area the box may occupy: the window for a fixed box, otherwise the element it is positioned in. */
function bounds(element) {
  if (getComputedStyle(element).position !== "fixed" && element.offsetParent) return element.offsetParent.getBoundingClientRect();
  return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
}

/** Max width and height for a resize drag: inline boxes grow inside an upward-opening popover, floating boxes within `bounds`. */
function resize_limits(element, rect, resize_only) {
  if (resize_only) {
    const list_rect = element.closest(".excerpt-list")?.getBoundingClientRect();
    const right_chrome = list_rect ? Math.max(0, list_rect.right - rect.right) : 0;
    return {
      width: Math.max(MIN_WIDTH, window.innerWidth - EDGE - rect.left - right_chrome),
      height: Math.max(MIN_HEIGHT, Math.min(INLINE_MAX_HEIGHT, window.innerHeight - INLINE_VIEWPORT_RESERVE)),
    };
  }
  const area = bounds(element);
  return {
    width: Math.max(MIN_WIDTH, area.right - EDGE - rect.left),
    height: Math.max(MIN_HEIGHT, area.bottom - EDGE - rect.top),
  };
}

/** Follow one pointer from its press to its release, calling `move` for each movement. */
function track(event, move, record) {
  const target = event.currentTarget;
  event.preventDefault();
  target.setPointerCapture(event.pointerId);
  record?.("start");
  const stop = (ended) => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", stop);
    target.removeEventListener("pointercancel", stop);
    record?.(ended.type === "pointercancel" ? "cancel" : "end");
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", stop);
  target.addEventListener("pointercancel", stop);
}

/** Capture only the geometry of an annotation move or resize while diagnostics are open. */
function debug_gesture(element, action, pointer) {
  if (!document.getElementById("scrolldebug")) return null;
  return (phase) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    document.dispatchEvent(new CustomEvent("discuss:browser-debug", { detail: { event: "annotation-gesture", data: {
      phase, action, pointer, x, y, width, height, source: element.classList.contains("file-comment") ? "file" : "message",
      entry: element.classList.contains("is-inline") ? "list" : element.classList.contains("excerpt-edit") ? "mark" : "selection",
    } } }));
  };
}

export const float_box = {
  mounted(element, binding) {
    if (binding.value === false || element.classList.contains("is-docked")) return;
    const resize_only = binding.value === "resize" || element.classList.contains("is-inline");
    if (!resize_only) {
      const offset = { x: 0, y: 0 };
      const on_control = (event) => Boolean(event.target.closest("textarea, button"));
      // Pressing a blank part must not take the focus from the text box or drop the held selection.
      element.addEventListener("mousedown", (event) => { if (!on_control(event)) event.preventDefault(); });
      element.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || on_control(event)) return;
        const rect = element.getBoundingClientRect(), area = bounds(element);
        const base = { left: rect.left - offset.x, top: rect.top - offset.y };
        const start = { x: event.clientX - offset.x, y: event.clientY - offset.y };
        track(event, (moved) => {
          offset.x = clamp(moved.clientX - start.x, area.left + EDGE - base.left, area.right - EDGE - rect.width - base.left);
          offset.y = clamp(moved.clientY - start.y, area.top + EDGE - base.top, area.bottom - EDGE - rect.height - base.top);
          element.style.translate = `${offset.x}px ${offset.y}px`;
        }, debug_gesture(element, "move", event.pointerType));
      });
    }
    const grip = document.createElement("span");
    grip.className = "float-box-resize";
    grip.setAttribute("aria-hidden", "true");
    grip.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      const rect = element.getBoundingClientRect();
      const limits = resize_limits(element, rect, resize_only);
      const min_width = Math.min(MIN_WIDTH, rect.width);
      const start = { x: event.clientX, y: event.clientY };
      track(event, (moved) => {
        element.style.width = `${clamp(rect.width + moved.clientX - start.x, min_width, limits.width)}px`;
        element.style.height = `${clamp(rect.height + moved.clientY - start.y, MIN_HEIGHT, limits.height)}px`;
        element.dataset.sized = "";
      }, debug_gesture(element, "resize", event.pointerType));
    });
    element.append(grip);
  },
};
