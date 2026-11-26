/**
 * Spring motion for the analytics page, after the feel skill: every motion is a mass on a damped spring, never a
 * duration or easing curve. How long a motion lasts follows from the model.
 *
 * SMOOTH is the vocabulary word "smooth": mass 1, 1.8 Hz, ζ 1 (critically damped). 1.8 Hz is slow enough to read as
 * a page settling rather than snapping; ζ 1 means no overshoot, so numbers never count past their value and bars
 * never grow past their height; it settles in about 0.52 s.
 */
import { onBeforeUnmount, ref } from "vue";

export const SMOOTH = { mass: 1, stiffness: 127.9, damping: 22.62 };

const STEP = 1 / 240;
const REST = 0.0005;
const bodies = new Set();
let frame = 0;
let last = 0;

/** Visitors who asked for less motion (system setting or the site's own effects switch) get the final state at once. */
export function motion_reduced() {
  if (typeof window === "undefined") return true;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    || document.documentElement.dataset.effects === "reduced";
}

function tick(now) {
  const elapsed = Math.min(0.064, last ? (now - last) / 1000 : STEP);
  last = now;
  for (const body of bodies) {
    for (let time = 0; time < elapsed; time += STEP) {
      const force = -body.params.stiffness * (body.x - body.target) - body.params.damping * body.v;
      body.v += (force / body.params.mass) * STEP;
      body.x += body.v * STEP;
    }
    const scale = Math.max(1, Math.abs(body.target));
    if (Math.abs(body.x - body.target) < REST * scale && Math.abs(body.v) < REST * scale * 10) {
      body.x = body.target;
      body.v = 0;
      bodies.delete(body);
    }
    body.value.value = body.x;
  }
  frame = bodies.size ? requestAnimationFrame(tick) : 0;
  if (!frame) last = 0;
}

/**
 * A spring-driven reactive number. `to(target)` changes the target and the body carries its velocity there;
 * `jump(x)` places it at rest. Returns `{ value, to, jump }`; the body leaves the shared loop when it settles.
 */
export function use_spring(initial = 0, params = SMOOTH) {
  const body = { x: initial, v: 0, target: initial, params, value: ref(initial) };
  function jump(x) {
    bodies.delete(body);
    body.x = body.target = x;
    body.v = 0;
    body.value.value = x;
  }
  function to(target) {
    if (motion_reduced()) return jump(target);
    body.target = target;
    bodies.add(body);
    if (!frame) frame = requestAnimationFrame(tick);
  }
  onBeforeUnmount(() => bodies.delete(body));
  return { value: body.value, to, jump };
}

/**
 * Share of a growth wave for item `index` of `count`, read off one 0→1 body: early items start growing first and all
 * finish together at progress 1. Purely a function of position, so it is as interruptible as the body itself.
 */
export function wave(progress, index, count, spread = 0.55) {
  const offset = count > 1 ? (index / (count - 1)) * spread : 0;
  return Math.min(1, Math.max(0, (progress - offset) / (1 - spread)));
}

/**
 * Entrance of the page's blocks from one body that falls from `distance(index)` to 0: block `index` starts further
 * down, so it reaches the visible band later. Opacity is derived from the remaining distance, so nothing is timed.
 */
export function entrance(offset, index, band = 16, gap = 14) {
  const y = Math.max(0, offset * (band + gap * index));
  return { transform: y ? `translateY(${y.toFixed(2)}px)` : "", opacity: Math.max(0, Math.min(1, 1 - (y - 2) / band)) };
}
