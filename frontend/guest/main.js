import { createApp } from "vue";
import ui from "@nuxt/ui/vue-plugin";
import GuestApp from "./GuestApp.vue";
import { i18n_plugin } from "../i18n.js";
import "./guest.css";

// The page follows the site's saved theme (web/app.js THEME_STORAGE_KEY), else the system; dark by default as the site.
const THEME_KEY = "ai-codiscuss-theme";
let theme = "";
try { theme = localStorage.getItem(THEME_KEY) || ""; } catch { /* Storage may be blocked; the system decides. */ }
const light = theme ? theme === "light" : matchMedia("(prefers-color-scheme: light)").matches;
document.documentElement.classList.toggle("dark", !light);
document.documentElement.dataset.theme = light ? "channel-light" : "channel";

// Rendered Markdown code blocks copy their own text, as on the main page (web/app.js).
document.addEventListener("click", (event) => {
  const button = event.target.closest?.("[data-copy-code]");
  if (button) navigator.clipboard?.writeText(button.parentElement.querySelector("pre")?.textContent || "").catch(() => {});
});

/** Mount the external user's page. */
createApp(GuestApp).use(ui).use(i18n_plugin).mount("#guest-root");
