import { createApp } from "vue";
import ui from "@nuxt/ui/vue-plugin";
import App from "./App.vue";
import "./theme.css";
import "./channel.css";

/** Mount the channel workspace once over the shared discussion controller. */
function mount_workspace() {
  createApp(App).use(ui).mount("#modern-root");
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

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount_workspace);
else mount_workspace();
