import { createApp } from "vue";
import ui from "@nuxt/ui/vue-plugin";
import App from "./App.vue";
import { keep_reading } from "./scroll-anchor.js";
import "./theme.css";
import "./channel.css";

/** Mount the channel workspace once over the shared discussion controller. */
function mount_workspace() {
  createApp(App).use(ui).directive("keep-reading", keep_reading).mount("#modern-root");
}

const KEYBOARD_SETTLE_MS = 120;

/**
 * The workspace is one 100dvh screen that scrolls only inside its panes. iOS Safari scrolls the whole page to keep a
 * focused input above the keyboard and, when the input loses focus (the composer locks while sending), keeps that offset
 * after the keyboard closes, leaving the layout shifted up until the next tap. Put the page back once nothing is typing.
 */
function restore_page_scroll() {
  setTimeout(() => {
    const active = document.activeElement;
    if (active?.matches?.("input, textarea, select, [contenteditable='true']")) return;
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
  }, KEYBOARD_SETTLE_MS);
}
document.addEventListener("focusout", restore_page_scroll);
window.visualViewport?.addEventListener("resize", restore_page_scroll);

const KEYBOARD_MIN_HEIGHT_PX = 120;

/**
 * The iOS keyboard (and its floating form toolbar) overlays a 100dvh layout instead of shrinking it, so the composer at
 * the bottom ends up behind the toolbar. While the keyboard is open, size the workspace to the visible area and pin it to
 * the top so the composer sits directly above the keyboard; clear the override once the keyboard closes.
 */
function fit_workspace_to_keyboard() {
  const viewport = window.visualViewport;
  const root = document.documentElement.style;
  if (viewport.scale > 1.01 || window.innerHeight - viewport.height < KEYBOARD_MIN_HEIGHT_PX) {
    root.removeProperty("--keyboard-viewport-height");
    return;
  }
  root.setProperty("--keyboard-viewport-height", `${Math.round(viewport.height)}px`);
  if (window.scrollY) window.scrollTo(0, 0);
}
window.visualViewport?.addEventListener("resize", fit_workspace_to_keyboard);

/**
 * With the workspace fitted to the keyboard there is nothing to scroll the page to, yet iOS still scrolls it while typing
 * (the candidate bar changes the keyboard's height, and it keeps the caret in view), shifting the whole layout up and
 * back. Put it back at once whenever that happens.
 */
function keep_page_pinned() {
  if (!document.documentElement.style.getPropertyValue("--keyboard-viewport-height")) return;
  if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
}
window.addEventListener("scroll", keep_page_pinned, { passive: true });
window.visualViewport?.addEventListener("scroll", keep_page_pinned);

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount_workspace);
else mount_workspace();
