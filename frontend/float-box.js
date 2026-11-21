// `v-float-box` on a floating box (the comment box beside a selection): drag its edge or any blank part to move it, and
// drag the grip in its bottom-right corner to resize it. Both last only while the box is open. The move is a CSS
// `translate`, so the box keeps following its passage (the `left` / `top` its owner sets) with the user's offset on top.
// Docked boxes (phones) and `v-float-box="false"` are left alone.
const MIN_WIDTH = 280;
const MIN_HEIGHT = 70;
const EDGE = 8;

const clamp = (value, low, high) => Math.max(low, Math.min(value, high));

/** The area the box may occupy: the window for a fixed box, otherwise the element it is positioned in. */
function bounds(element) {
  if (getComputedStyle(element).position !== "fixed" && element.offsetParent) return element.offsetParent.getBoundingClientRect();
  return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
}

/** Follow one pointer from its press to its release, calling `move` for each movement. */
function track(event, move) {
  const target = event.currentTarget;
  event.preventDefault();
  target.setPointerCapture(event.pointerId);
  const stop = () => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", stop);
    target.removeEventListener("pointercancel", stop);
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", stop);
  target.addEventListener("pointercancel", stop);
}

export const float_box = {
  mounted(element, binding) {
    if (binding.value === false || element.classList.contains("is-docked")) return;
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
      });
    });
    const grip = document.createElement("span");
    grip.className = "float-box-resize";
    grip.setAttribute("aria-hidden", "true");
    grip.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      const rect = element.getBoundingClientRect(), area = bounds(element);
      const start = { x: event.clientX, y: event.clientY };
      track(event, (moved) => {
        element.style.width = `${clamp(rect.width + moved.clientX - start.x, MIN_WIDTH, area.right - EDGE - rect.left)}px`;
        element.style.height = `${clamp(rect.height + moved.clientY - start.y, MIN_HEIGHT, area.bottom - EDGE - rect.top)}px`;
        element.dataset.sized = "";
      });
    });
    element.append(grip);
  },
};
